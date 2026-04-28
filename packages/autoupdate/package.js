Package.describe({
  summary: 'Update the client when new client code is available',
  version: '2.0.1',
});

Package.onUse(function(api) {
  api.use(['webapp', 'check', 'inter-process-messaging'], 'server');

  api.use(['tracker', 'retry'], 'client');

  api.use('reload', 'client', { weak: true });

  // Use the new DDP engine on the server so publications register with ddp-bridge
  api.use(['ecmascript'], ['client', 'server']);
  api.use('ddp', 'client');
  api.use('ddp-bridge', 'server');

  api.mainModule('autoupdate_server.js', 'server');
  api.mainModule('autoupdate_client.js', 'client');
  api.mainModule('autoupdate_cordova.js', 'web.cordova');

  api.export('Autoupdate');
});
