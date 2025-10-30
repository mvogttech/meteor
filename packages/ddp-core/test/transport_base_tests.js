import { Tinytest } from 'meteor/tinytest';
import { DDPTransportProtocol } from '../index.js';

class MockTransport extends DDPTransportProtocol {
  constructor(settings = {}, context = {}) {
    super({ protocolName: 'mock', path: '/mock', ...settings }, context);
    this._written = [];
    this._closed = false;
    this._markOpen();
  }
  async _writeRaw(data) {
    this._written.push(data);
  }
  async _closeRaw() {
    this._closed = true;
  }
}

Tinytest.add('ddp-core - sendMessage serializes and sends', async function (test) {
  const t = new MockTransport();
  await t.sendMessage({ a: 1 });
  test.isTrue(t._written.length === 1);
  const frame = t._written[0];
  test.isTrue(typeof frame === 'string');
  test.isTrue(frame.includes('"a":1'));
});

Tinytest.add('ddp-core - batching enqueues and flushes', async function (test) {
  const t = new MockTransport({ batching: { enabled: true, flushIntervalMs: 1, maxBatchBytes: 1024 } });
  await t.sendMessage({ x: 1 });
  await t.sendMessage({ y: 2 });
  await new Promise(r => setTimeout(r, 5));
  test.equal(t._written.length, 2);
});

Tinytest.add('ddp-core - _clientAddress resolves from X-Forwarded-For', function (test) {
  const t = new MockTransport();
  const req = { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, socket: { remoteAddress: '3.3.3.3' } };
  const ip = t._clientAddress(req);
  test.isTrue(!!ip);
});
