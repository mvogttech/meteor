Package.describe({
  summary: "Restrict which websites can frame your app",
  version: '1.1.4',
});

Package.onUse(function (api) {
  api.use("modules");
  api.use(["browser-policy-common"], "server");
  api.imply(["browser-policy-common"], "server");
  api.mainModule("browser-policy-framing.js", "server");
});

Package.onTest(api => {
  api.use(['tinytest', 'browser-policy-framing', 'browser-policy-common'], ['server']);

  api.addFiles('browser-policy-framing_tests.js', ['server']);
});
