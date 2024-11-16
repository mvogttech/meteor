// Helper function to get the current X-Frame-Options value
const getXFrameOptions = () => BrowserPolicy.framing._constructXFrameOptions();

// Test suite for BrowserPolicy.framing
Tinytest.add('BrowserPolicy.framing - default policy', function (test) {
  // Reset to default before testing
  BrowserPolicy.framing._reset();

  const xFrameOptions = getXFrameOptions();
  test.equal(xFrameOptions, 'SAMEORIGIN', 'Default X-Frame-Options should be SAMEORIGIN');
});

Tinytest.add('BrowserPolicy.framing - disallow framing', function (test) {
  // Reset to default before testing
  BrowserPolicy.framing._reset();

  BrowserPolicy.framing.disallow();
  const xFrameOptions = getXFrameOptions();
  test.equal(xFrameOptions, 'DENY', 'X-Frame-Options should be DENY after disallow()');
});

Tinytest.add('BrowserPolicy.framing - restrict to origin', function (test) {
  // Reset to default before testing
  BrowserPolicy.framing._reset();

  const origin = 'https://example.com';
  BrowserPolicy.framing.restrictToOrigin(origin);
  const xFrameOptions = getXFrameOptions();
  test.equal(
    xFrameOptions,
    `ALLOW-FROM ${origin}`,
    `X-Frame-Options should be ALLOW-FROM ${origin} after restrictToOrigin()`
  );
});

Tinytest.add('BrowserPolicy.framing - restrict to multiple origins throws error', function (test) {
  // Reset to default before testing
  BrowserPolicy.framing._reset();

  const origin1 = 'https://example.com';
  const origin2 = 'https://another.com';

  BrowserPolicy.framing.restrictToOrigin(origin1);

  test.throws(
    () => {
      BrowserPolicy.framing.restrictToOrigin(origin2);
    },
    /You can only specify one origin that is allowed to frame this app\./,
    'Calling restrictToOrigin() multiple times should throw an error'
  );
});

Tinytest.add('BrowserPolicy.framing - allow all framing', function (test) {
  // Reset to default before testing
  BrowserPolicy.framing._reset();

  BrowserPolicy.framing.allowAll();
  const xFrameOptions = getXFrameOptions();
  test.isNull(xFrameOptions, 'X-Frame-Options should be null after allowAll()');
});

Tinytest.add('BrowserPolicy.framing - reset policy', function (test) {
  // Change the policy
  BrowserPolicy.framing.disallow();

  // Reset to default
  BrowserPolicy.framing._reset();
  const xFrameOptions = getXFrameOptions();
  test.equal(xFrameOptions, 'SAMEORIGIN', 'X-Frame-Options should be reset to SAMEORIGIN after _reset()');
});

Tinytest.add('BrowserPolicy.framing - disallow after restrictToOrigin', function (test) {
  // Reset to default before testing
  BrowserPolicy.framing._reset();

  const origin = 'https://example.com';
  BrowserPolicy.framing.restrictToOrigin(origin);

  // Now disallow framing
  BrowserPolicy.framing.disallow();
  const xFrameOptions = getXFrameOptions();
  test.equal(xFrameOptions, 'DENY', 'X-Frame-Options should be DENY after disallow() even if restrictToOrigin() was called before');
});

Tinytest.add('BrowserPolicy.framing - allowAll after disallow', function (test) {
  // Reset to default before testing
  BrowserPolicy.framing._reset();

  BrowserPolicy.framing.disallow();

  // Now allow all framing
  BrowserPolicy.framing.allowAll();
  const xFrameOptions = getXFrameOptions();
  test.isNull(xFrameOptions, 'X-Frame-Options should be null after allowAll() even if disallow() was called before');
});

Tinytest.add('BrowserPolicy.framing - invalid origin handling', function (test) {
  // Reset to default before testing
  BrowserPolicy.framing._reset();

  const invalidOrigin = ''; // Empty string as invalid origin

  // Since there is no validation in restrictToOrigin, this will set ALLOW-FROM with an empty origin
  BrowserPolicy.framing.restrictToOrigin(invalidOrigin);
  const xFrameOptions = getXFrameOptions();
  test.equal(
    xFrameOptions,
    'ALLOW-FROM ',
    'X-Frame-Options should be ALLOW-FROM with empty origin when restrictToOrigin() is called with an empty string'
  );
});

Tinytest.add('BrowserPolicy.framing - consecutive allowAll and restrictToOrigin', function (test) {
  // Reset to default before testing
  BrowserPolicy.framing._reset();

  // First allow all framing
  BrowserPolicy.framing.allowAll();
  test.isNull(getXFrameOptions(), 'X-Frame-Options should be null after allowAll()');

  // Then restrict to a specific origin
  const origin = 'https://example.com';
  BrowserPolicy.framing.restrictToOrigin(origin);
  const xFrameOptions = getXFrameOptions();
  test.equal(
    xFrameOptions,
    `ALLOW-FROM ${origin}`,
    `X-Frame-Options should be ALLOW-FROM ${origin} after restrictToOrigin()`
  );
});