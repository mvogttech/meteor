import { DDPTransportProtocol } from 'meteor/ddp-core';

/**
 * Concrete WebSocket transport using 'ws' library sockets.
 */
export class WebSocketTransportProtocol extends DDPTransportProtocol {
  /**
   * @param {import('ws').WebSocket} socket
   * @param {import('http').IncomingMessage} request
   * @param {import('meteor/ddp-core').DDPTransportSettings} [settings]
   */
  constructor(socket, request, settings = {}) {
    super({ protocolName: 'websocket', path: '/websocket', ...settings }, { req: request });
    this.socket = socket;

    // Bind events
    socket.on('message', (data) => this._handleIncoming(data));
    socket.on('close', (code, reason) => this.close(code, reason));
    socket.on('error', (err) => this.emit('error', err));

    // ws does not emit 'open' on server side; mark open immediately
    this._markOpen();
  }

  async _writeRaw(data) {
    if (this.socket.readyState !== this.socket.OPEN) {
      const err = new Error('Socket not open');
      err.code = 'SOCKET_NOT_OPEN';
      throw err;
    }
    await new Promise((resolve, reject) => {
      this.socket.send(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  async _closeRaw(code, reason) {
    try {
      this.socket.close(code, reason);
    } catch (_) {}
  }
}
