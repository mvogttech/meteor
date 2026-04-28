# ddp-bridge

A modern DDP engine and bridge that runs over `ddp-core` transports (e.g., `ddp-ws`).
This package replaces the legacy DDP server and its dependency on SockJS.

## Usage

```js
import { DDPBridge } from 'meteor/ddp-bridge';

DDPBridge.setMethods({
  hello: async ([name]) => `Hello ${name}`,
});
```

Under the hood, this registers with `ddp-ws` and attaches all WebSocket connections to the engine.

## Features
- DDP connect and ping/pong
- Method calls with results and updated notifications
- Pluggable into any `DDPTransportProtocol` (WebSocket, HTTP/2, SSE)

## Migration
- Remove legacy SockJS-based packages from your app.
- Add `ddp-ws` and `ddp-bridge` to provide the DDP transport and engine.
- Keep your `/websocket` endpoint unchanged; path prefix respected.
