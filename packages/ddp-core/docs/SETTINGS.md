# DDP Transport Settings Guide

This guide explains the core settings supported by `DDPTransportProtocol` and how to specialize them per transport (WebSocket, HTTP/2, SSE).

## Core Settings

- `protocolName` (string): Human-readable name. Example: `websocket`, `http2`, `sse`.
- `path` (string): Mount path for the endpoint. Example: `/websocket`.
- `heartbeatIntervalMs` (number): Interval for ping/pong or heartbeat frames.
- `idleTimeoutMs` (number): Disconnect clients after inactivity.
- `maxPayloadBytes` (number): Maximum accepted inbound payload size.

### Serialization
- `serialization.format` ("json" | "msgpack" | "cbor" | string): Name of the serializer. Defaults to `json`.
- `serialization.custom` ({ serialize, deserialize }): Provide custom serializer implementation.

### Compression
- `compression.enabled` (boolean): Enable/disable per-message compression.
- `compression.threshold` (number): Only compress payloads larger than this value (bytes).
- `compression.options` (object): Transport-specific options (e.g., zlib params).

### Batching
- `batching.enabled` (boolean): Buffer outbound messages.
- `batching.flushIntervalMs` (number): Milliseconds between batch flushes.
- `batching.maxBatchBytes` (number): Flush when this size is reached.

### Backpressure
- `backpressure.highWaterMark` (number): Apply backpressure above this buffered amount.
- `backpressure.lowWaterMark` (number): Resume sending below this.

### Rate Limiting
- `rateLimit.messagesPerSecond` (number): Token bucket rate. 0 disables.
- `rateLimit.burst` (number): Burst capacity.

### Security
- `security.originWhitelist` (string[]): Allowed origins (exact match or patterns).
- `security.allowedProtocols` (string[]): Subprotocols allowed (e.g., ["ddp"]).
- `security.allowedVersions` (string[]): DDP versions supported (e.g., ["1"]).
- `security.validateMessage(msg, raw)` (function): Throws to reject invalid messages.

### Observability
- `observability.logger` (object): `{ info, warn, error, debug? }`.
- `observability.metrics` (object): `{ increment(name, labels?), gauge(name, value, labels?), observe(name, value, labels?) }`.
- `observability.sampleRate` (number): Optional 0..1 sampling for debug logs.

### Cluster
- `cluster.redis` (object): `{ url, host, port, password }` for pub/sub.
- `cluster.nodeId` (string): Unique node identifier.

## Transport-specific Notes

### WebSocket
- Use `protocolName: 'websocket'`, `path: '/websocket'`.
- Compression maps to permessage-deflate settings.
- Heartbeats via ping/pong (`heartbeatIntervalMs`).
- Apply `allowedProtocols` to enforce DDP subprotocol.

### HTTP/2 (Server Push / Streams)
- Use `protocolName: 'http2'`, `path: '/ddp'`.
- Compression typically handled at stream level; respect `compression.threshold`.
- Backpressure aligns with stream `writableHighWaterMark`.
- Heartbeats via periodic server events or pings.

### Server-Sent Events (SSE)
- Use `protocolName: 'sse'`, `path: '/events'`.
- Messages are text; ensure `serialization.format: 'json'` or a text-friendly serializer.
- Compression via HTTP response (gzip/brotli) based on client `Accept-Encoding`.
- Keep-alives via comment frames (`:keep-alive\n\n`).

## Example Configuration (WebSocket)

```js
const wsSettings = {
  protocolName: 'websocket',
  path: '/websocket',
  heartbeatIntervalMs: 25000,
  idleTimeoutMs: 60000,
  maxPayloadBytes: 1_000_000,
  serialization: { format: 'json' },
  compression: { enabled: true, threshold: 1024, options: { level: 1 } },
  batching: { enabled: true, flushIntervalMs: 5, maxBatchBytes: 64 * 1024 },
  backpressure: { highWaterMark: 64 * 1024, lowWaterMark: 32 * 1024 },
  security: { originWhitelist: ['https://app.example.com'], allowedProtocols: ['ddp'], allowedVersions: ['1'] },
  observability: { logger, metrics },
  cluster: { redis: { url: process.env.REDIS_URL }, nodeId: process.env.HOSTNAME }
};
```

## Validation Tips
- Reject oversized payloads using `maxPayloadBytes` (handled by base class).
- Enforce origin checks for browser clients (WebSocket and SSE).
- Provide a `validateMessage` to enforce DDP schema before routing.
