Package.describe({
  name: 'ddp-bridge',
  version: '0.1.0',
  summary: 'DDP engine that runs over ddp-core transports (ws/http2/sse)',
  documentation: 'README.md',
});

Package.onUse(function (api) {
  api.versionsFrom('3.0');
  api.use(['ecmascript', 'random', 'check', 'ejson']);
  api.use(['ddp-core'], 'server');
  // Optional transports (auto-wire if present)
  api.use('ddp-ws', 'server', { weak: true });
  api.mainModule('server/index.js', 'server');
  api.export('DDPBridge', 'server');
});

Package.onTest(function (api) {
  api.use(['ecmascript', 'tinytest', 'random'], 'server');
  api.use('ddp-bridge');
  api.mainModule('tests/server_tests.js', 'server');
});
