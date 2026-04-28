import { WebApp } from 'meteor/webapp';
import { RoutePolicy } from 'meteor/routepolicy';
import { Random } from 'meteor/random';
import { DDPTransportProtocol } from 'meteor/ddp-core';
import { WebSocketServer } from 'ws';
import { WebSocketTransportProtocol } from './WebSocketTransportProtocol.js';
export { WebSocketTransportProtocol } from './WebSocketTransportProtocol.js';

const ROOT_PREFIX = __meteor_runtime_config__.ROOT_URL_PATH_PREFIX || '';
const WS_PATH = `${ROOT_PREFIX}/websocket`;

/**
 * DDPWebSocketServer
 * - Creates a WebSocket server mounted at /websocket
 * - Emits transports and allows registering connection callbacks.
 */
class Server {
  constructor(settings = {}) {
    this.settings = settings;
    this.registrationCallbacks = [];

    // Ensure route policy allows websocket path
    RoutePolicy.declare(WS_PATH + '/', 'network');

    // Build compression settings from env if present (JSON): falsy disables, object enables with options
    const parsedCompression = (() => {
      try {
        const raw = process.env.SERVER_WEBSOCKET_COMPRESSION;
        if (!raw) return null;
        const val = JSON.parse(raw);
        if (!val) return null; // explicitly disable
        return typeof val === 'object' ? val : {};
      } catch {
        return {};
      }
    })();

    const perMessageDeflate = settings.compression?.enabled
      ? (settings.compression.options || {})
      : (parsedCompression ? parsedCompression : false);

    // Create ws server and hook upgrade
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate,
      handleProtocols: (protocols, request) => {
        const allowed = this.settings.security?.allowedProtocols;
        if (!allowed || allowed.length === 0) {
          return protocols[0] || false;
        }
        const match = protocols.find(p => allowed.includes(p));
        return match || false;
      },
      maxPayload: this.settings.maxPayloadBytes || 1_000_000,
    });

    WebApp.httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== WS_PATH) return;

      // Origin enforcement (if defined)
      const origins = this.settings.security?.originWhitelist;
      const origin = req.headers.origin || req.headers.Origin;
      if (origins && origins.length) {
        if (!origin || !origins.includes(origin)) {
          try { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch {}
          socket.destroy();
          return;
        }
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (socket, request) => {
      // Heartbeat/idle monitoring
      let isAlive = true;
      socket.on('pong', () => { isAlive = true; });
      const interval = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return;
        if (!isAlive) {
          try { socket.terminate(); } catch {}
          return;
        }
        isAlive = false;
        try { socket.ping(); } catch {}
      }, this.settings.heartbeatIntervalMs || 25000);
      if (typeof interval.unref === 'function') interval.unref();

      const transport = new WebSocketTransportProtocol(socket, request, this.settings);
      this.registrationCallbacks.forEach((cb) => {
        try { cb(transport, request); } catch (e) { /* swallow */ }
      });
      socket.on('close', () => clearInterval(interval));
    });
  }

  /** Register a callback for new connections */
  register(callback) {
    this.registrationCallbacks.push(callback);
  }
}

export const DDPWebSocketServer = new Server({
  protocolName: 'websocket',
  path: WS_PATH,
  // Default settings can be tuned or overridden by app code using exported server
  heartbeatIntervalMs: 25000,
  idleTimeoutMs: 60000,
  maxPayloadBytes: 1_000_000,
  serialization: { format: 'json' },
  compression: { enabled: !!process.env.SERVER_WEBSOCKET_COMPRESSION, options: (() => {
    try { return JSON.parse(process.env.SERVER_WEBSOCKET_COMPRESSION || 'false') || {}; } catch { return {}; }
  })() },
  batching: { enabled: true, flushIntervalMs: 5, maxBatchBytes: 64 * 1024 },
  backpressure: { highWaterMark: 64 * 1024, lowWaterMark: 32 * 1024 },
  security: { allowedProtocols: ['ddp'], allowedVersions: ['1'] },
});
