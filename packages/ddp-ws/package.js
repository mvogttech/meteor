Package.describe({
  name: 'ddp-ws',
  version: '0.1.0',
  summary: 'High-performance WebSocket transport for Meteor DDP',
  documentation: 'README.md',
});

Npm.depends({
  ws: '8.18.0'
});

Package.onUse(function (api) {
  api.versionsFrom('3.0');
  api.use(['ecmascript', 'webapp', 'routepolicy', 'random']);
  api.use('ddp-core');
  api.mainModule('server/index.js', 'server');
  api.export('DDPWebSocketServer', 'server');
});

Package.onTest(function (api) {
  api.use(['ecmascript', 'tinytest', 'random'], 'server');
  api.use('ddp-ws');
  api.mainModule('tests/server_tests.js', 'server');
});
