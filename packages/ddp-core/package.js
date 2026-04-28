Package.describe({
  name: 'ddp-core',
  version: '0.1.0',
  summary: 'Core abstractions for DDP transports and protocol utilities',
  documentation: 'README.md'
});

Package.onUse(function (api) {
  api.versionsFrom('3.0');
  api.use(['ecmascript']);
  api.mainModule('index.js', 'server');
});

Package.onTest(function (api) {
  api.use(['ecmascript', 'tinytest'], 'server');
  api.mainModule('test/transport_base_tests.js', 'server');
});
