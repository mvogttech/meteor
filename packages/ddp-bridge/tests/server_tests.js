import { Tinytest } from 'meteor/tinytest';
import { DDPEngine } from '../server/engine.js';
import { DDPTransportProtocol } from 'meteor/ddp-core';

class MockTransport extends DDPTransportProtocol {
  constructor() {
    super({ protocolName: 'mock' });
    this._written = [];
    this._markOpen();
  }
  async _writeRaw(data) { this._written.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
  async _closeRaw() {}
}

function nextMessage(t) {
  return new Promise((resolve) => {
    const orig = t._written.length;
    const tick = () => {
      if (t._written.length > orig) return resolve(t._written[t._written.length - 1]);
      setTimeout(tick, 0);
    };
    tick();
  });
}

Tinytest.add('bridge - connect success', async (test) => {
  const engine = new DDPEngine({ versions: ['1'] });
  const t = new MockTransport();
  engine.attach(t);
  t._handleIncoming(JSON.stringify({ msg: 'connect', version: '1', support: ['1'] }));
  const frame = await nextMessage(t);
  test.isTrue(frame.includes('"connected"'));
});

Tinytest.add('bridge - ping/pong', async (test) => {
  const engine = new DDPEngine({ versions: ['1'] });
  const t = new MockTransport();
  engine.attach(t);
  t._handleIncoming(JSON.stringify({ msg: 'ping', id: 'x' }));
  const frame = await nextMessage(t);
  test.isTrue(frame.includes('"pong"'));
});

Tinytest.add('bridge - method call round-trip', async (test) => {
  const engine = new DDPEngine({ versions: ['1'], methods: { add: async ([a, b]) => a + b } });
  const t = new MockTransport();
  engine.attach(t);
  t._handleIncoming(JSON.stringify({ msg: 'method', id: '1', method: 'add', params: [2, 3] }));
  // Expect result then updated
  const first = await nextMessage(t);
  const second = await nextMessage(t);
  test.isTrue(first.includes('"result"'));
  test.isTrue(second.includes('"updated"'));
});
