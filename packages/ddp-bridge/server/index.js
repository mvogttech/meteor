import { DDPEngine } from './engine.js';

/**
 * DDPBridge wires transports from ddp-ws into the DDP engine.
 * This replaces legacy ddp-server + sockjs transport.
 */
class Bridge {
  constructor({ engine } = {}) {
    this.engine = engine || new DDPEngine();
    // Auto-wire ddp-ws if available, but do not require it.
    try {
      if (typeof Package !== 'undefined' && Package['ddp-ws']) {
        // dynamic import via global Package map to avoid hard dependency
        const { DDPWebSocketServer } = Package['ddp-ws'];
        if (DDPWebSocketServer && typeof DDPWebSocketServer.register === 'function') {
          DDPWebSocketServer.register((transport) => this.engine.attach(transport));
        }
      }
    } catch (_) {}

    // Compatibility: if ddp-server loaded first and publications were already registered
    // under Meteor.server.publish_handlers, mirror them into this engine so existing
    // core publications (e.g., autoupdate) are available immediately.
    try {
      if (typeof Meteor !== 'undefined' && Meteor.server && Meteor.server.publish_handlers) {
        Object.keys(Meteor.server.publish_handlers).forEach((name) => {
          const handler = Meteor.server.publish_handlers[name];
          if (handler && !this.engine.publications.has(name)) {
            this.engine.publications.set(name, handler);
          }
        });
      }
    } catch (_) {}
  }

  /** Provide methods for the DDP engine. methods: { name: async (params, ctx) => any } */
  setMethods(methods) {
    this.engine.methods = methods || {};
  }

  /** Meteor.methods compatibility */
  methods(methodMap) {
    this.engine.registerMethods(methodMap);
  }

  /** Meteor.publish compatibility */
  publish(name, handler) {
    if (typeof name === 'object' && name) {
      Object.keys(name).forEach((n) => this.publish(n, name[n]));
      return;
    }
    this.engine.publications.set(name, handler);
  }

  /**
   * Register a transport server that accepts connections and yields DDPTransportProtocol instances.
   * The server must provide a `register((transport)=>void)` hook.
   */
  registerServer(server) {
    if (server && typeof server.register === 'function') {
      server.register((transport) => this.engine.attach(transport));
    }
  }

  /**
   * Manually attach a transport (DDPTransportProtocol) if you manage your own accept loop.
   */
  attachTransport(transport) {
    this.engine.attach(transport);
  }
}

export const DDPBridge = new Bridge({});
export { DDPEngine } from './engine.js';

// Legacy convenience: expose Meteor.methods to be a drop-in replacement
if (typeof Meteor !== 'undefined') {
  Meteor.methods = DDPBridge.methods.bind(DDPBridge);
  Meteor.publish = DDPBridge.publish.bind(DDPBridge);
}
