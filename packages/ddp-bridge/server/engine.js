import { Random } from 'meteor/random';
import { EJSON } from 'meteor/ejson';
import { DDPProtocolError } from 'meteor/ddp-core';
import { DDPCommon } from 'meteor/ddp-common';

/**
 * Minimal DDP engine consuming DDPTransportProtocol connections.
 * Handles: connect, ping/pong, and simple method call dispatch.
 */
export class DDPEngine {
  constructor({ methods = {}, versions = ['1'], serverId = Random.id(6), logger = console } = {}) {
    this.methods = methods; // name -> async fn(params, context)
    this.versions = versions;
    this.serverId = serverId;
    this.logger = logger;
    this.publications = new Map(); // name -> handler
    this._sessionCount = 0;
  }

  /**
   * Attach a transport (DDPTransportProtocol) and handle its lifecycle.
   */
  attach(transport) {
    const session = {
      id: Random.id(17),
      serverId: this.serverId,
      transport,
      version: null,
      userId: null,
      createdAt: new Date(),
      _closeCallbacks: [],
      _subs: new Map(), // subId -> subscription state
      _rate: { tokens: 0, last: Date.now() },
    };

    // Build connection handle consistent with Meteor API
    const req = transport?.context?.req;
    const clientAddress = typeof transport._clientAddress === 'function' ? transport._clientAddress(req) : undefined;
    const connectionHandle = {
      id: session.id,
      close: () => transport.close(),
      onClose: (fn) => {
        const cb = Meteor.bindEnvironment ? Meteor.bindEnvironment(fn, 'connection onClose callback') : fn;
        if (session._closed) {
          // already closed
          Promise.resolve().then(cb);
        } else {
          session._closeCallbacks.push(cb);
        }
      },
      clientAddress,
      httpHeaders: req?.headers,
    };
    session.connection = connectionHandle;

    // Metrics: connections
    try { transport.settings?.observability?.metrics?.increment?.('ddp_connections'); } catch (_) {}
    this._sessionCount += 1;
    try { transport.settings?.observability?.metrics?.gauge?.('ddp_sessions', this._sessionCount); } catch (_) {}

    // DDP-level heartbeat using ddp-common
    const heartbeatInterval = transport.settings?.heartbeatIntervalMs ?? 25000;
    const heartbeatTimeout = Math.max(heartbeatInterval * 2, 60000);
    const heartbeat = new DDPCommon.Heartbeat({
      heartbeatInterval,
      heartbeatTimeout,
      onTimeout: () => transport.close(),
      sendPing: () => transport.sendMessage({ msg: 'ping' }).catch(() => {}),
    });
    heartbeat.start();

    transport.on('message', (msg) => {
      try { heartbeat.messageReceived(); } catch (_) {}
      this._onMessage(session, msg);
    });
    transport.on('close', () => this._onClose(session));
    transport.on('error', (err) => this._onError(session, err));
  }

  /**
   * Register/merge methods into the engine (compatible with Meteor.methods contract).
   * @param {Record<string, Function>} methodMap
   */
  registerMethods(methodMap = {}) {
    Object.keys(methodMap).forEach((name) => {
      const fn = methodMap[name];
      if (typeof fn !== 'function') {
        this.logger?.warn?.('Ignoring non-function method', { name });
        return;
      }
      this.methods[name] = fn;
    });
  }

  async _onMessage(session, msg) {
    try {
      // Metrics: inbound message
      try { session.transport.settings?.observability?.metrics?.increment?.('ddp_messages_total'); } catch (_) {}

      // Basic per-session rate limiting
      if (this._rateLimited(session)) {
        await session.transport.sendError('RATE_LIMITED', 'Too many messages');
        return session.transport.close();
      }

      if (!msg || typeof msg !== 'object') throw new DDPProtocolError('BAD_MSG', 'Message must be an object');
      const type = msg.msg;
      switch (type) {
        case 'connect':
          return this._connect(session, msg);
        case 'ping':
          return this._ping(session, msg);
        case 'method':
          return this._method(session, msg);
        case 'sub':
          return this._sub(session, msg);
        case 'unsub':
          return this._unsub(session, msg);
        default:
          return session.transport.sendError('BAD_MSG', 'Unknown msg', { type });
      }
    } catch (err) {
      this.logger.error('DDP error', err);
      try {
        await session.transport.sendError('SERVER_ERROR', 'Internal error');
        try { session.transport.settings?.observability?.metrics?.increment?.('ddp_errors_total'); } catch (_) {}
      } catch (_) {}
    }
  }

  async _connect(session, { version, support, session: resumeSessionId }) {
    const supported = Array.isArray(support) ? support : [];
    const chosen = (version && this.versions.includes(version))
      ? version
      : supported.find((v) => this.versions.includes(v));
    if (!chosen) {
      return session.transport.sendMessage({ msg: 'failed', versions: this.versions });
    }
    session.version = chosen;
    await session.transport.sendMessage({ msg: 'connected', session: session.id });
  }

  async _ping(session, { id }) {
    await session.transport.sendMessage({ msg: 'pong', id });
  }

  async _method(session, { id, method, params }) {
    if (typeof id !== 'string') {
      return session.transport.sendError('BAD_MSG', 'Method call missing id');
    }
    if (typeof method !== 'string') {
      return session.transport.sendMessage({ msg: 'result', id, error: { error: 400, reason: 'Invalid method', message: 'Invalid method' } });
    }
    if (!this.methods[method]) {
      return session.transport.sendMessage({ msg: 'result', id, error: { error: 404, reason: 'Method not found', message: 'Method not found' } });
    }
    try {
      // Build MethodInvocation context
      const invocation = new DDPCommon.MethodInvocation({
        name: method,
        isSimulation: false,
        unblock: () => {},
        isFromCallAsync: false,
        userId: session.userId,
        setUserId: async (uid) => { session.userId = uid; },
        connection: session.connection,
        randomSeed: undefined,
        fence: undefined,
      });

      // Methods receive (params, context) historically; also support this-binding
      const fn = this.methods[method];
      const context = { session };
      const result = await fn.call(invocation, params, context);
      await session.transport.sendMessage({ msg: 'result', id, result });
      await session.transport.sendMessage({ msg: 'updated', methods: [id] });
    } catch (e) {
      await session.transport.sendMessage({ msg: 'result', id, error: { error: 500, reason: e?.message || 'Error', message: e?.message || 'Error' } });
    }
  }

  async _sub(session, { id, name, params }) {
    if (typeof id !== 'string' || typeof name !== 'string') {
      return session.transport.sendMessage({ msg: 'nosub', id, error: { error: 400, reason: 'Invalid subscription', message: 'Invalid subscription' } });
    }
    const handler = this.publications.get(name);
    if (!handler) {
      return session.transport.sendMessage({ msg: 'nosub', id, error: { error: 404, reason: 'Subscription not found', message: 'Subscription not found' } });
    }

    // Create subscription state
    const sub = {
      id,
      name,
      params,
      session,
      stopped: false,
      stopCbs: [],
      handles: [], // observer handles or other resources with stop()
    };
    session._subs.set(id, sub);

    // Build publish context compatible with Meteor
    const pubContext = {
      userId: session.userId,
      connection: session.connection,
      added: async (collection, _id, fields) => {
        if (sub.stopped) return;
        await session.transport.sendMessage({ msg: 'added', collection, id: _id, fields });
      },
      changed: async (collection, _id, fields) => {
        if (sub.stopped) return;
        await session.transport.sendMessage({ msg: 'changed', collection, id: _id, fields });
      },
      removed: async (collection, _id) => {
        if (sub.stopped) return;
        await session.transport.sendMessage({ msg: 'removed', collection, id: _id });
      },
      ready: async () => {
        if (sub.stopped) return;
        await session.transport.sendMessage({ msg: 'ready', subs: [id] });
      },
      onStop: (cb) => { if (typeof cb === 'function') sub.stopCbs.push(cb); },
      error: async (err) => {
        await session.transport.sendMessage({ msg: 'nosub', id, error: normalizeError(err) });
      },
      stop: () => this._stopSub(sub),
    };

    try {
      // Call publish handler with params as separate args like Meteor
      // and with this-bound context
      const result = await handler.apply(pubContext, params || []);
      // If handler returned cursor(s), observe changes
      await this._attachCursors(sub, result);
      // Mark ready by default if handler didn't explicitly ready()
      // Schedule on next tick to allow initial added to flush
      Promise.resolve().then(() => pubContext.ready());
    } catch (e) {
      await session.transport.sendMessage({ msg: 'nosub', id, error: normalizeError(e) });
      this._stopSub(sub);
    }
  }

  async _unsub(session, { id }) {
    const sub = session._subs.get(id);
    if (!sub) {
      // Acknowledge anyway per robustness
      return session.transport.sendMessage({ msg: 'nosub', id });
    }
    this._stopSub(sub);
    await session.transport.sendMessage({ msg: 'nosub', id });
  }

  _stopSub(sub) {
    if (sub.stopped) return;
    sub.stopped = true;
    try { sub.handles.forEach((h) => { try { h.stop?.(); } catch (_) {} }); } catch (_) {}
    sub.handles = [];
    const cbs = sub.stopCbs || [];
    sub.stopCbs = [];
    cbs.forEach((cb) => { try { cb(); } catch (_) {} });
    sub.session._subs.delete(sub.id);
  }

  async _attachCursors(sub, result) {
    const attach = async (cursor) => {
      if (!cursor || typeof cursor.observeChanges !== 'function') return;
      const collection = resolveCollectionName(cursor);
      if (!collection) {
        try { this.logger?.warn?.('Unable to resolve collection name for cursor; skipping attach'); } catch (_) {}
        return;
      }
      const handle = cursor.observeChanges({
        added: (id, fields) => sub.session.transport.sendMessage({ msg: 'added', collection, id, fields }),
        changed: (id, fields) => sub.session.transport.sendMessage({ msg: 'changed', collection, id, fields }),
        removed: (id) => sub.session.transport.sendMessage({ msg: 'removed', collection, id }),
      });
      if (handle && typeof handle.stop === 'function') sub.handles.push(handle);
    };
    if (Array.isArray(result)) {
      for (const c of result) { await attach(c); }
    } else {
      await attach(result);
    }
  }

  _onClose(session) {
    session._closed = true;
    // Stop all active subscriptions
    try { Array.from(session._subs.values()).forEach((s) => this._stopSub(s)); } catch (_) {}
    const cbs = session._closeCallbacks || [];
    session._closeCallbacks = [];
    cbs.forEach((cb) => { try { cb(); } catch (_) {} });

    // Metrics: connections decrement
    this._sessionCount = Math.max(0, this._sessionCount - 1);
    try { session.transport.settings?.observability?.metrics?.gauge?.('ddp_sessions', this._sessionCount); } catch (_) {}
  }

  _onError(session, err) {
    this.logger.error('DDP transport error', { session: session.id, err });
  }

  _rateLimited(session) {
    const rl = session.transport.settings?.rateLimit;
    const rate = Number(rl?.messagesPerSecond || 0);
    const burst = Number(rl?.burst || 0);
    if (!rate && !burst) return false;
    // Token bucket refill
    const now = Date.now();
    const elapsed = (now - session._rate.last) / 1000;
    session._rate.last = now;
    const capacity = Math.max(burst, rate);
    session._rate.tokens = Math.min(capacity, session._rate.tokens + elapsed * rate);
    if (session._rate.tokens < 1) {
      return true;
    }
    session._rate.tokens -= 1;
    return false;
  }
}

function normalizeError(e) {
  if (!e) return { error: 500, reason: 'Error', message: 'Error' };
  if (typeof e === 'string') return { error: 500, reason: e, message: e };
  const reason = e.reason || e.message || 'Error';
  const code = e.error || 500;
  return { error: code, reason, message: reason };
}

function resolveCollectionName(cursor) {
  try {
    if (!cursor) return undefined;
    // Official/minimongo helpers if present
    if (typeof cursor._getCollectionName === 'function') {
      const n = cursor._getCollectionName();
      if (typeof n === 'string' && n) return n;
    }
    // Common properties in Meteor
    if (typeof cursor._collectionName === 'string' && cursor._collectionName) return cursor._collectionName;
    if (cursor._cursorDescription && typeof cursor._cursorDescription.collectionName === 'string') return cursor._cursorDescription.collectionName;
    // Attached collection objects
    if (cursor._collection && typeof cursor._collection._name === 'string') return cursor._collection._name;
    if (cursor.collection) {
      if (typeof cursor.collection._name === 'string') return cursor.collection._name; // Meteor Mongo.Collection
      if (typeof cursor.collection.name === 'string') return cursor.collection.name;   // Node driver
    }
    // Fallback names seen in some Meteor internals
    if (typeof cursor._name === 'string' && cursor._name) return cursor._name;
    return undefined;
  } catch (_) {
    return undefined;
  }
}
