# ddp-core

Core abstractions for Meteor DDP transports.

## Exports
- `DDPTransportProtocol`: Abstract base class for transports
- `DDPConnectionError`, `DDPProtocolError`: Focused error types
- `getSerializer`, `registerSerializer`: Pluggable serializers (default JSON)

## Implementing a transport
```js
import { DDPTransportProtocol } from 'meteor/meteor:ddp-core';

export class WebSocketTransport extends DDPTransportProtocol {
  constructor(ws, settings, context) {
    super({ protocolName: 'websocket', path: '/websocket', ...settings }, context);
    this.ws = ws;
    ws.on('open', () => this._markOpen());
    ws.on('message', (data) => this._handleIncoming(data));
    ws.on('close', (code, reason) => this.close(code, reason));
    ws.on('error', (err) => this.emit('error', err));
  }
  async _writeRaw(data) {
    await new Promise((resolve, reject) => {
      this.ws.send(data, (err) => (err ? reject(err) : resolve()));
    });
  }
  async _closeRaw(code, reason) {
    this.ws.close(code, reason);
  }
}
```

## Settings design
- `serialization`: `json` (default) or register `msgpack`/`cbor`
- `compression`: `{ enabled, threshold, options }` (transport applies)
- `batching`: `{ enabled, flushIntervalMs, maxBatchBytes }`
- `backpressure`: `{ highWaterMark, lowWaterMark }`
- `rateLimit`: `{ messagesPerSecond, burst }`
- `security`: `{ originWhitelist, allowedProtocols, allowedVersions, validateMessage }`
- `observability`: `{ logger, metrics }`
  - metrics supports `increment`, `gauge`, and `observe` for histograms.
  - Built-in metric keys produced by ddp-core:
    - Frames: `ddp_frames_in_total`, `ddp_frames_out_total`, `ddp_frames_in_bytes`, `ddp_frames_out_bytes`
    - Serialization: `ddp_serialize_total`, `ddp_serialize_ms`, `ddp_encoded_bytes`, `ddp_deserialize_total`, `ddp_deserialize_ms`, `ddp_decoded_bytes`
- `cluster`: `{ redis, nodeId }`
