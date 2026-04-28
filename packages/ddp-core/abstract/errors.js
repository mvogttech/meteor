/**
 * Focused error classes for DDP transports.
 */

export class DDPConnectionError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'DDPConnectionError';
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, DDPConnectionError);
  }
}

export class DDPProtocolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'DDPProtocolError';
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, DDPProtocolError);
  }
}
