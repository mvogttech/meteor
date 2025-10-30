import { DDPTransportProtocol } from '../index.js';

export class WebSocketTransport extends DDPTransportProtocol {
  /**
   * @param {import('ws').WebSocket} ws
   * @param {import('../abstract/DDPTransportProtocol.js').DDPTransportSettings} settings
   * @param {object} context
   */
  constructor(ws, settings = {}, context = {}) {
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
    try {
      this.ws.close(code, reason);
    } catch (_) {}
  }
}
