/*
 * DDP Transport Protocol (Abstract Base)
 *
 * This file defines the abstract base class that concrete transports (e.g.,
 * WebSocket, HTTP/2, SSE) should extend. It provides:
 *  - A normalized lifecycle and event surface (open, message, error, close)
 *  - Unified send/close APIs with serializer hooks
 *  - Backpressure-friendly async writes via an abstract _writeRaw()
 *  - Settings schema with sane defaults and validation
 *  - Client address resolution honoring HTTP_FORWARDED_COUNT
 *
 * This module is written in modern JS with JSDoc types for TS-friendly usage.
 */

import EventEmitter from 'node:events';
import { performance } from 'node:perf_hooks';

// Avoid importing Meteor directly to keep this module transport/runtime agnostic.
// Consumers may map errors as they need. We provide focused error classes.
import { DDPConnectionError, DDPProtocolError } from './errors.js';
import { getSerializer } from './serializers.js';

const httpForwardedCount = Number.parseInt(process.env.HTTP_FORWARDED_COUNT || '0', 10) || 0;

/**
 * @typedef {Object} DDPTransportSecuritySettings
 * @property {string[]=} originWhitelist Allowed request origins
 * @property {string[]=} allowedProtocols Subprotocols allowed (e.g., ['ddp'])
 * @property {string[]=} allowedVersions DDP versions supported (e.g., ['1'])
 * @property {(msg:any, raw:any)=>void|never=} validateMessage Custom validation
 */

/**
 * @typedef {Object} DDPTransportBatchSettings
 * @property {boolean=} enabled Enable outbound batching
 * @property {number=} flushIntervalMs Time-based flush (ms)
 * @property {number=} maxBatchBytes Max bytes per batch
 */

/**
 * @typedef {Object} DDPTransportBackpressureSettings
 * @property {number=} highWaterMark Bytes buffered before applying backpressure
 * @property {number=} lowWaterMark Resume threshold
 */

/**
 * @typedef {Object} DDPTransportRateLimitSettings
 * @property {number=} messagesPerSecond Token bucket rate
 * @property {number=} burst Max burst capacity
 */

/**
 * @typedef {Object} DDPTransportCompressionSettings
 * @property {boolean=} enabled Enable per-message compression (transport-specific)
 * @property {number=} threshold Minimum payload size to compress (bytes)
 * @property {Record<string,any>=} options Transport-specific compression options
 */

/**
 * @typedef {Object} DDPTransportSerializationSettings
 * @property {'json'|'msgpack'|'cbor'|string=} format Serialization format key
 * @property {{serialize:(v:any)=>Uint8Array|string, deserialize:(v:Uint8Array|string)=>any}=} custom Custom serializer
 */

/**
 * @typedef {Object} DDPTransportObservabilitySettings
 * @property {{info:Function, warn:Function, error:Function, debug?:Function}=} logger Logger interface (pino/winston compatible subset)
 * @property {{increment:(name:string,labels?:object)=>void, gauge:(name:string,value:number,labels?:object)=>void}=} metrics Minimal metrics hooks
 */

/**
 * @typedef {Object} DDPTransportClusterSettings
 * @property {{url?:string, host?:string, port?:number, password?:string}=} redis Optional Redis config for pub/sub
 * @property {string=} nodeId Unique node identifier
 */

/**
 * @typedef {Object} DDPTransportSettings
 * @property {string=} protocolName Human-readable transport name (e.g., 'websocket')
 * @property {string=} path Mount path (e.g., '/websocket')
 * @property {number=} heartbeatIntervalMs Interval for ping/pong or heartbeats
 * @property {number=} idleTimeoutMs Disconnect idle connections
 * @property {number=} maxPayloadBytes Maximum accepted message size
 * @property {DDPTransportSerializationSettings=} serialization Serialization config
 * @property {DDPTransportCompressionSettings=} compression Compression config
 * @property {DDPTransportBatchSettings=} batching Batching settings
 * @property {DDPTransportBackpressureSettings=} backpressure Backpressure thresholds
 * @property {DDPTransportRateLimitSettings=} rateLimit Rate limiting
 * @property {DDPTransportSecuritySettings=} security Security-related validation
 * @property {DDPTransportObservabilitySettings=} observability Logging/metrics
 * @property {DDPTransportClusterSettings=} cluster Optional clustering
 */

/**
 * @typedef {import('./serializers.js').Serializer} Serializer
 */

/**
 * Abstract base transport.
 * Subclasses must implement _writeRaw, _closeRaw, and may override _setup.
 */
export class DDPTransportProtocol extends EventEmitter {
    /**
     * @param {DDPTransportSettings} [settings] settings
     * @param {object} [context] optional constructor context (e.g., request info)
     */
    constructor(settings = {}, context = {}) {
        super();

        /** @type {DDPTransportSettings} */
        this.settings = Object.freeze(normalizeSettings(settings));
        /** @type {Serializer} */
            this.serializer = instrumentSerializer(
                resolveSerializer(this.settings.serialization),
                this.settings.serialization?.format || 'json',
                this.settings.observability
            );

        /** @type {'connecting'|'open'|'closing'|'closed'} */
        this.readyState = 'connecting';
        /** @type {string} */
        this.id = context.id || generateId();
        /** @type {Date} */
        this.createdAt = new Date();
        /** @type {object} */
        this.context = context;

        // Internal batching buffer
        this._batch = [];
        this._batchBytes = 0;
        this._batchTimer = null;

        // Allow subclass to perform transport-specific setup
        this._setup();
    }

    /** @protected */
    _setup() {}

    /**
     * Returns a human-friendly protocol name.
     * @returns {string}
     */
    get protocolName() {
        return this.settings.protocolName || 'unknown';
    }

    /**
     * Send an already-encoded frame (string or Uint8Array) over the wire.
     * Subclasses must implement _writeRaw.
     * @param {string|Uint8Array} data
     * @returns {Promise<void>}
     */
    async send(data) {
        if (this.readyState !== 'open') {
            throw new DDPConnectionError('TRANSPORT_NOT_OPEN', `Transport not open: ${this.id}`);
        }
            // Metrics: count frames out and size
            try {
                const bytes = toBytes(data).length;
                const m = this.settings.observability?.metrics;
                m?.increment?.('ddp_frames_out_total');
                m?.observe?.('ddp_frames_out_bytes', bytes);
            } catch (_) {}
        await this._writeRaw(data);
    }

    /**
     * Serialize and send a DDP message object.
     * Applies batching if enabled.
     * @param {any} message
     * @returns {Promise<void>}
     */
    async sendMessage(message) {
        const encoded = encodeMessage(this.serializer, message);
        if (this.settings.batching?.enabled) {
            this._enqueueBatch(encoded);
            return;
        }
        return this.send(encoded);
    }

    /**
     * Send a structured error to the peer.
     * @param {string} code error code
     * @param {string} message message
     * @param {object} [details] optional details
     */
    async sendError(code, message, details) {
        const payload = { msg: 'error', code, message, details }; // keep DDP-friendly
        return this.sendMessage(payload);
    }

    /**
     * Close the transport.
     * @param {number} [code]
     * @param {string} [reason]
     */
    async close(code, reason) {
        if (this.readyState === 'closed' || this.readyState === 'closing') return;
        this.readyState = 'closing';
        try {
            await this._closeRaw(code, reason);
        } finally {
            this.readyState = 'closed';
            this._clearBatchTimer();
            this.emit('close', { code, reason });
        }
    }

    /**
     * Mark transport as open; subclasses should call when ready.
     */
    _markOpen() {
        if (this.readyState !== 'connecting') return;
        this.readyState = 'open';
        this.emit('open');
    }

    /**
     * Handle inbound raw data from the underlying transport.
     * Subclasses should call this when a frame arrives.
     * @param {string|Uint8Array} frame
     */
    _handleIncoming(frame) {
        try {
                // Metrics: frames in and size
                try {
                    const m = this.settings.observability?.metrics;
                    const bytes = toBytes(frame).length;
                    m?.increment?.('ddp_frames_in_total');
                    m?.observe?.('ddp_frames_in_bytes', bytes);
                } catch (_) {}
            const msg = decodeMessage(this.serializer, frame, this.settings.maxPayloadBytes);
            if (this.settings.security?.validateMessage) {
                this.settings.security.validateMessage(msg, frame);
            }
            this.emit('message', msg);
        } catch (err) {
            this.emit('error', err);
            // Optionally send protocol error
            this.sendError('BAD_MSG', 'Invalid message format');
        }
    }

    /**
     * Resolve the originating client IP address using X-Forwarded-For and
     * HTTP_FORWARDED_COUNT to strip trusted proxies.
     * @param {import('http').IncomingMessage & {socket?: {remoteAddress?: string}}} req
     * @returns {string|undefined}
     */
    _clientAddress(req) {
        if (!req) return undefined;

        const xff = (req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'])) || '';
        const xri = (req.headers && (req.headers['x-real-ip'] || req.headers['X-Real-IP'])) || '';
        const chain = String(xff)
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

        if (chain.length > 0) {
            const idx = Math.max(0, chain.length - 1 - httpForwardedCount);
            return chain[idx];
        }
        if (xri) return String(xri);
        return req.socket && req.socket.remoteAddress || undefined;
    }

    /** @protected */
    _enqueueBatch(encoded) {
        const asBytes = toBytes(encoded);
        const maxBytes = this.settings.batching?.maxBatchBytes ?? 0;
        if (maxBytes && (this._batchBytes + asBytes.length) > maxBytes) {
            // flush first to respect limit
            this._flushBatch().catch(err => this.emit('error', err));
        }
        this._batch.push(encoded);
        this._batchBytes += asBytes.length;
        if (!this._batchTimer) {
            const interval = this.settings.batching?.flushIntervalMs ?? 5;
            this._batchTimer = setTimeout(() => {
                this._flushBatch().catch(err => this.emit('error', err));
            }, interval);
            // Node timers keep process alive by default; detach if possible
            if (typeof this._batchTimer.unref === 'function') this._batchTimer.unref();
        }
    }

    /** @protected */
    async _flushBatch() {
        this._clearBatchTimer();
        if (this._batch.length === 0) return;
        // For text formats we can send as an array with separators; for binary,
        // we concatenate. Keep it simple: send each in order to avoid framing mismatch.
        const frames = this._batch;
        this._batch = [];
        this._batchBytes = 0;
        for (const frame of frames) {
            // eslint-disable-next-line no-await-in-loop
            await this.send(frame);
        }
    }

    /** @protected */
    _clearBatchTimer() {
        if (this._batchTimer) {
            clearTimeout(this._batchTimer);
            this._batchTimer = null;
        }
    }

    // ABSTRACT METHODS: subclasses MUST implement
    /** @protected @abstract */
    async _writeRaw(_data) { // eslint-disable-line no-unused-vars
        throw new DDPProtocolError('NOT_IMPLEMENTED', '_writeRaw must be implemented by transport');
    }
    /** @protected @abstract */
    async _closeRaw(_code, _reason) { // eslint-disable-line no-unused-vars
        throw new DDPProtocolError('NOT_IMPLEMENTED', '_closeRaw must be implemented by transport');
    }
}

// --------- helpers ---------

/**
 * @param {DDPTransportSerializationSettings|undefined} s
 * @returns {Serializer}
 */
function resolveSerializer(s) {
    if (s?.custom) return s.custom;
    return getSerializer(s?.format || 'json');
}

/**
 * @param {DDPTransportSettings} settings
 * @returns {DDPTransportSettings}
 */
function normalizeSettings(settings) {
    const defaults = {
        protocolName: 'unknown',
        path: '/',
        heartbeatIntervalMs: 25000,
        idleTimeoutMs: 60000,
        maxPayloadBytes: 1_000_000, // 1MB
        serialization: { format: 'json' },
        compression: { enabled: false, threshold: 1024, options: {} },
        batching: { enabled: false, flushIntervalMs: 5, maxBatchBytes: 64 * 1024 },
        backpressure: { highWaterMark: 64 * 1024, lowWaterMark: 32 * 1024 },
        rateLimit: { messagesPerSecond: 0, burst: 0 },
        security: { originWhitelist: [], allowedProtocols: ['ddp'], allowedVersions: ['1'] },
        observability: {},
        cluster: {},
    };
    const merged = { ...defaults, ...settings };
    // Normalize nested objects (shallow merge)
    merged.serialization = { ...defaults.serialization, ...settings.serialization };
    merged.compression = { ...defaults.compression, ...settings.compression };
    merged.batching = { ...defaults.batching, ...settings.batching };
    merged.backpressure = { ...defaults.backpressure, ...settings.backpressure };
    merged.rateLimit = { ...defaults.rateLimit, ...settings.rateLimit };
    merged.security = { ...defaults.security, ...settings.security };
    merged.observability = { ...defaults.observability, ...settings.observability };
    merged.cluster = { ...defaults.cluster, ...settings.cluster };
    return merged;
}

/**
 * @param {Serializer} serializer
 * @param {any} msg
 * @returns {string|Uint8Array}
 */
function encodeMessage(serializer, msg) {
    try {
        return serializer.serialize(msg);
    } catch (e) {
        throw new DDPProtocolError('SERIALIZE_FAILED', 'Failed to serialize message');
    }
}

/**
 * @param {Serializer} serializer
 * @param {string|Uint8Array} frame
 * @param {number} maxBytes
 */
function decodeMessage(serializer, frame, maxBytes) {
    const bytes = toBytes(frame);
    if (bytes.length > maxBytes) {
        throw new DDPProtocolError('PAYLOAD_TOO_LARGE', `Payload ${bytes.length} > ${maxBytes}`);
    }
    try {
        return serializer.deserialize(frame);
    } catch (e) {
        throw new DDPProtocolError('DESERIALIZE_FAILED', 'Failed to deserialize message');
    }
}

/**
 * @param {string|Uint8Array} v
 * @returns {Uint8Array}
 */
function toBytes(v) {
    if (typeof v === 'string') {
        return new TextEncoder().encode(v);
    }
    return v;
}

function generateId() {
    // Prefer crypto.randomUUID if available
    try {
        // eslint-disable-next-line no-undef
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            // @ts-ignore
            return crypto.randomUUID();
        }
    } catch (_) {}
    return `conn_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

// --------- instrumentation ---------

function instrumentSerializer(base, format, observability) {
    const logger = observability?.logger;
    const metrics = observability?.metrics;
    const sampleRate = Number(observability?.sampleRate || 0);
    let sampleCounter = 0;
    const shouldSample = () => {
        if (!sampleRate || sampleRate <= 0) return false;
        // Simple linear sampler
        sampleCounter = (sampleCounter + 1) % Math.max(1, Math.round(1 / sampleRate));
        return sampleCounter === 0;
    };

    return {
        serialize(v) {
            const t0 = performance.now();
            const out = base.serialize(v);
            const dt = performance.now() - t0;
            try {
                const size = toBytes(out).length;
                metrics?.increment?.('ddp_serialize_total', { format });
                metrics?.observe?.('ddp_serialize_ms', dt, { format });
                metrics?.observe?.('ddp_encoded_bytes', size, { format });
                if (logger && shouldSample()) {
                    logger.debug?.('serialize', { format, ms: dt.toFixed(3), bytes: size });
                }
            } catch (_) {}
            return out;
        },
        deserialize(v) {
            const size = toBytes(typeof v === 'string' ? new TextEncoder().encode(v) : v).length;
            const t0 = performance.now();
            const out = base.deserialize(v);
            const dt = performance.now() - t0;
            try {
                metrics?.increment?.('ddp_deserialize_total', { format });
                metrics?.observe?.('ddp_deserialize_ms', dt, { format });
                metrics?.observe?.('ddp_decoded_bytes', size, { format });
                if (logger && shouldSample()) {
                    logger.debug?.('deserialize', { format, ms: dt.toFixed(3), bytes: size });
                }
            } catch (_) {}
            return out;
        }
    };
}