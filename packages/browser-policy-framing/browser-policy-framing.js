/**
 * @description By adding this package, you get a default policy where only web pages on the same origin as your app can frame your app.
 * @fileoverview Provides methods to control which origins can frame this app.
 * @namespace BrowserPolicy
 * @example
 * // Disallow any framing of the app.
 * BrowserPolicy.framing.disallow();
 * @example
 * // Restrict framing to a specific origin.
 * BrowserPolicy.framing.restrictToOrigin('http://example.com');
 * @example
 * // Allow the app to be framed by any origin.
 * BrowserPolicy.framing.allowAll();
 */

const defaultXFrameOptions = 'SAMEORIGIN';
let xFrameOptions = defaultXFrameOptions;

const { BrowserPolicy } = require('meteor/browser-policy-common');

/**
 * Provides methods to control which origins can frame this app.
 * @namespace BrowserPolicy.framing
 */
BrowserPolicy.framing = {
  /**
   * Constructs the `X-Frame-Options` header value.
   * Exported for tests and browser-policy-common.
   * @returns {string|null} The current `X-Frame-Options` value.
   * @private
   */
  _constructXFrameOptions() {
    return xFrameOptions;
  },

  /**
   * Resets the `X-Frame-Options` to the default value.
   * @private
   */
  _reset() {
    xFrameOptions = defaultXFrameOptions;
  },

  /**
   * Disallows any framing of the app.
   *
   * Sets the `X-Frame-Options` header to `'DENY'`.
   */
  disallow() {
    xFrameOptions = 'DENY';
  },

  /**
   * Restricts framing to a specific origin.
   *
   * **Note:** `ALLOW-FROM` is not supported in Chrome or Safari.
   *
   * @param {string} origin - The origin that is allowed to frame the app.
   * @throws {Error} If multiple origins are specified.
   */
  restrictToOrigin(origin) {
    // Prevent specifying multiple ALLOW-FROM origins.
    if (xFrameOptions && xFrameOptions.startsWith('ALLOW-FROM')) {
      throw new Error(
        'You can only specify one origin that is allowed to frame this app.'
      );
    }
    xFrameOptions = `ALLOW-FROM ${origin}`;
  },

  /**
   * Allows the app to be framed by any origin.
   *
   * Sets the `X-Frame-Options` header to `null`.
   */
  allowAll() {
    xFrameOptions = null;
  },
};

exports.BrowserPolicy = BrowserPolicy;