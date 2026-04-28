# ddp-ws

High-performance WebSocket transport for Meteor DDP built on `ws`, using `ddp-core` abstractions.

## Usage

This package mounts a WebSocket server at `/websocket` and provides a simple registration API:

```js
import { DDPWebSocketServer } from 'meteor/ddp-ws';

DDPWebSocketServer.register((transport, request) => {
  // `transport` is an instance of WebSocketTransportProtocol (extends DDPTransportProtocol)
  transport.on('message', (msg) => {
    // route into DDP server logic
  });

  // send a welcome message
  transport.sendMessage({ msg: 'connected' });
});
```

## Settings
- Inherits settings shape from `ddp-core` (serialization, compression, batching, backpressure, security, etc.).
- Compression can be toggled via `SERVER_WEBSOCKET_COMPRESSION` env (JSON) similar to legacy `sockjs` config.

## Notes
- This is a drop-in replacement for the transport layer; you will need to wire it to your DDP server/session manager.
- Path respects `__meteor_runtime_config__.ROOT_URL_PATH_PREFIX` if set.

## Measuring serializer performance
Provide a metrics object to `observability` with an `observe` method and compare JSON vs MessagePack:

```js
const metrics = {
  // naive collectors for demo purposes
  counters: new Map(), hist: new Map(),
  increment(name) { this.counters.set(name, (this.counters.get(name) || 0) + 1); },
  observe(name, value, labels) { const arr = this.hist.get(name) || []; arr.push(value); this.hist.set(name, arr); }
};

DDPWebSocketServer.settings = {
  ...DDPWebSocketServer.settings,
  serialization: { format: 'json' }, // switch to 'msgpack' when registered
  observability: { metrics, sampleRate: 0.01 }
};

// After some traffic, inspect metrics.hist.get('ddp_serialize_ms') / 'ddp_deserialize_ms' and
// 'ddp_encoded_bytes' / 'ddp_decoded_bytes' to compare throughput and payload sizes.
```
