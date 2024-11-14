import { isPlainObject } from './isPlainObject';

/**
 * An environment variable to track the current argument checker.
 */
const currentArgumentChecker = new Meteor.EnvironmentVariable();

/**
 * Alias for Object.prototype.hasOwnProperty.
 * @type {Function}
 */
const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Formats the result into a Match.Error.
 *
 * @param {Object} result - The result object containing message and path.
 * @returns {Match.Error} The formatted Match.Error.
 */
const format = result => new MatchBase.Error(result.message, result.path);

/**
 * Asynchronously formats the result into a Match.Error.
 *
 * @param {Object} result - The result object containing message and path.
 * @returns {Promise<Match.Error>} A promise that resolves to the formatted Match.Error.
 * @async
 */
const formatAsync = result => new Promise((resolve, reject) => {
    resolve(new MatchBase.Error(result.message, result.path));
});


/**
 * @summary Check that a value matches a [pattern](#matchpatterns).
 * If the value does not match the pattern, throw a `Match.Error`.
 * By default, it will throw immediately at the first error encountered. Pass in { throwAllErrors: true } to throw all errors.
 *
 * Particularly useful to assert that arguments to a function have the right
 * types and structure.
 * @locus Anywhere
 * @param {*} value The value to check
 * @param {*} pattern The pattern to match `value` against
 * @param {Object} [options={}] Additional options for check
 * @param {Boolean} [options.throwAllErrors=false] If true, throw all errors
 */
export function check(value, pattern, options = { throwAllErrors: false }) {
  // Record that check got called, if somebody cared.
  const argChecker = currentArgumentChecker.getOrNullIfOutsideFiber();
  if (argChecker) {
    argChecker.checking(value);
  }

  const result = testSubtree(value, pattern, options.throwAllErrors);

  if (result) {
    if (options.throwAllErrors) {
      const errors = Array.isArray(result) ? result.map(format) : [format(result)];
      throw errors;
    } else {
      throw format(result);
    }
  }
}


/**
 * @summary Asynchronously check that a value matches a pattern.
 * If the value does not match the pattern, throw a `Match.Error`.
 * By default, it will throw immediately at the first error encountered. Pass in { throwAllErrors: true } to throw all errors.
 *
 * Particularly useful to assert that arguments to a function have the right
 * types and structure.
 * @locus Anywhere
 * @async
 * @param {*} value The value to check
 * @param {*} pattern The pattern to match `value` against
 * @param {Object} [options={}] Additional options for check
 * @param {Boolean} [options.throwAllErrors=false] If true, throw all errors
 * @returns {Promise<void>} A promise that resolves if the value matches the pattern, or rejects with a Match.Error.
 */
export async function checkAsync(value, pattern, options = { throwAllErrors: false }) {
  // Record that check got called, if somebody cared.
  const argChecker = currentArgumentChecker.getOrNullIfOutsideFiber();
  if (argChecker) {
    argChecker.checking(value);
  }

  const result = await testSubtreeAsync(value, pattern, options.throwAllErrors);

  if (result) {
    if (options.throwAllErrors) {
      let errors;
      if(Array.isArray(result)) {
            errors = await Promise.all(result.map(formatAsync));
        } else {
            errors = await formatAsync(result);
        }
      throw errors;
    } else {
      throw await formatAsync(result);
    }
  }
}

/**
 * @namespace MatchBase
 * @summary The namespace for all Match types and methods shared by Match and MatchAsync.
 */
const MatchBase = {
  /**
   * Matches an optional value, i.e., value or undefined.
   * @param {*} pattern - The pattern to match.
   * @returns {Optional} The Optional pattern.
   */
  Optional: function(pattern) {
    return new Optional(pattern);
  },

  /**
   * Matches a nullable value, i.e., value, null, or undefined.
   * @param {*} pattern - The pattern to match.
   * @returns {Maybe} The Maybe pattern.
   */
  Maybe: function(pattern) {
    return new Maybe(pattern);
  },

  /**
   * Matches any one of the provided patterns.
   * @param {...*} patterns - The patterns to match.
   * @returns {OneOf} The OneOf pattern.
   */
  OneOf: function(...patterns) {
    return new OneOf(patterns);
  },

  /**
   * Matches any value.
   */
  Any: ['__any__'],

  /**
   * Matches a value that satisfies the given condition.
   * @param {Function} condition - The condition function.
   * @returns {Where} The Where pattern.
   */
  Where: function(condition) {
    return new Where(condition);
  },

  /**
   * Matches an object that includes the given pattern.
   * @param {Object} pattern - The pattern to match.
   * @returns {ObjectIncluding} The ObjectIncluding pattern.
   */
  ObjectIncluding: function(pattern) {
    return new ObjectIncluding(pattern);
  },

  /**
   * Matches an object whose values match the given pattern.
   * @param {*} pattern - The pattern to match.
   * @returns {ObjectWithValues} The ObjectWithValues pattern.
   */
  ObjectWithValues: function(pattern) {
    return new ObjectWithValues(pattern);
  },

  /**
   * Matches any signed 32-bit integer.
   */
  Integer: ['__integer__'],

  /**
   * Custom error type for match errors.
   */
  Error: class MatchError extends Error {
    /**
     * Creates a MatchError.
     *
     * @param {string} message - The error message.
     * @param {string} [path=''] - The path in the object where the error occurred.
     */
    constructor(message, path = '') {
      super(path ? `Match error: ${message} in field ${path}` : `Match error: ${message}`);
      this.name = 'Match.Error';
      this.path = path;
      this.sanitizedError = new Meteor.Error(400, 'Match failed');
    }
  },
    // Runs `f.apply(context, args)`. If check() is not called on every element of
    // `args` (either directly or in the first level of an array), throws an error
    // (using `description` in the message).
  _failIfArgumentsAreNotAllChecked(f, context, args, description) {
    const argChecker = new ArgumentChecker(args, description);
    const result = currentArgumentChecker.withValue(
      argChecker,
      () => f.apply(context, args)
    );

    // If f didn't itself throw, make sure it checked all of its arguments.
    argChecker.throwUnlessAllArgumentsHaveBeenChecked();
    return result;
  }
}

/**
 * @namespace Match
 * @summary The namespace for all Synchronous Match types and methods.
 */
export const Match = {
    ...MatchBase,
  /**
   * Tests to see if value matches pattern. Unlike check, it merely returns true
   * or false (unless an error other than Match.Error was thrown). It does not
   * interact with _failIfArgumentsAreNotAllChecked.
   *
   * @summary Returns true if the value matches the pattern.
   * @locus Anywhere
   * @param {*} value The value to check
   * @param {*} pattern The pattern to match `value` against
   * @returns {boolean} True if the value matches the pattern, false otherwise.
   */
  test(value, pattern) {
    return !testSubtree(value, pattern);
  }
};

/**
 * @namespace MatchAsync
 * @summary The namespace for all Match types and methods.
 */
export const MatchAsync = {
    ...MatchBase,
  /**
   * Asynchronously tests to see if value matches pattern.
   * Unlike check, it merely returns a promise that resolves to true
   * or false (unless an error other than Match.Error was thrown).
   *
   * @summary Returns a promise that resolves to true if the value matches the pattern.
   * @locus Anywhere
   * @async
   * @param {*} value The value to check
   * @param {*} pattern The pattern to match `value` against
   * @returns {Promise<boolean>} Promise that resolves to true if the value matches the pattern, false otherwise.
   */
  async test(value, pattern) {
    return !(await testSubtreeAsync(value, pattern));
  }
};

class Optional {
  /**
   * Creates an Optional pattern.
   * @param {*} pattern - The pattern to match.
   */
  constructor(pattern) {
    this.pattern = pattern;
  }
}

class Maybe {
  /**
   * Creates a Maybe pattern.
   * @param {*} pattern - The pattern to match.
   */
  constructor(pattern) {
    this.pattern = pattern;
  }
}

class OneOf {
  /**
   * Creates a OneOf pattern.
   * @param {Array} choices - The choices of patterns to match.
   */
  constructor(choices) {
    if (!choices || choices.length === 0) {
      throw new Error('Must provide at least one choice to Match.OneOf');
    }
    this.choices = choices;
  }
}

class Where {
  /**
   * Creates a Where pattern.
   * @param {Function} condition - The condition function.
   */
  constructor(condition) {
    this.condition = condition;
  }
}

class ObjectIncluding {
  /**
   * Creates an ObjectIncluding pattern.
   * @param {Object} pattern - The pattern to include.
   */
  constructor(pattern) {
    this.pattern = pattern;
  }
}

class ObjectWithValues {
  /**
   * Creates an ObjectWithValues pattern.
   * @param {*} pattern - The pattern for the values.
   */
  constructor(pattern) {
    this.pattern = pattern;
  }
}

/**
 * Converts a value to a string suitable for an error message.
 *
 * @param {*} value - The value to convert.
 * @param {Object} [options={}] - Options.
 * @param {boolean} [options.onlyShowType=false] - Whether to only show the type.
 * @returns {string} The string representation.
 */
const stringForErrorMessage = (value, options = {}) => {
  if (value === null) {
    return 'null';
  }

  if (options.onlyShowType) {
    return typeof value;
  }

  if (typeof value !== 'object') {
    return EJSON.stringify(value);
  }

  try {
    JSON.stringify(value);
  } catch (stringifyError) {
    if (stringifyError.name === 'TypeError') {
      return typeof value;
    }
  }

  return EJSON.stringify(value);
};

const typeofChecks = [
  [String, 'string'],
  [Number, 'number'],
  [Boolean, 'boolean'],
  [Function, 'function'],
  [undefined, 'undefined'],
];

/**
 * Tests if a value matches a pattern.
 *
 * @param {*} value - The value to test.
 * @param {*} pattern - The pattern to match against.
 * @param {boolean} [collectErrors=false] - Whether to collect all errors.
 * @param {Array} [errors=[]] - Accumulated errors when collecting errors.
 * @param {string} [path=''] - The current path in the object being matched.
 * @returns {boolean|Object|Array} Returns `false` if the value matches the pattern.
 *          Otherwise, returns an error object with `message` and `path` fields,
 *          or an array of such error objects when collecting errors.
 */
function testSubtree(value, pattern, collectErrors = false, errors = [], path = '') {
  // Match anything!
  if (pattern === Match.Any) {
    return false;
  }

  // Basic atomic types.
  for (const [type, typeName] of typeofChecks) {
    if (pattern === type) {
      if (typeof value === typeName) {
        return false;
      }
      return { message: `Expected ${typeName}, got ${stringForErrorMessage(value, { onlyShowType: true })}`, path: '' };
    }
  }

  if (pattern === null) {
    if (value === null) {
      return false;
    }
    return { message: `Expected null, got ${stringForErrorMessage(value)}`, path: '' };
  }

  // Match literal strings, numbers, and booleans
  if (typeof pattern === 'string' || typeof pattern === 'number' || typeof pattern === 'boolean') {
    if (value === pattern) {
      return false;
    }
    return { message: `Expected ${pattern}, got ${stringForErrorMessage(value)}`, path: '' };
  }

  // Match Integer
  if (pattern === Match.Integer) {
    if (typeof value === 'number' && (value | 0) === value) {
      return false;
    }
    return { message: `Expected Integer, got ${stringForErrorMessage(value)}`, path: '' };
  }

  // 'Object' is shorthand for Match.ObjectIncluding({})
  if (pattern === Object) {
    pattern = Match.ObjectIncluding({});
  }

  // Match arrays
  if (Array.isArray(pattern)) {
    if (pattern.length !== 1) {
      return { message: `Bad pattern: arrays must have one type element ${stringForErrorMessage(pattern)}`, path: '' };
    }

    if (!Array.isArray(value) && !isArguments(value)) {
      return { message: `Expected array, got ${stringForErrorMessage(value)}`, path: '' };
    }

    for (let i = 0; i < value.length; i++) {
      const arrPath = `${path}[${i}]`;
      const result = testSubtree(value[i], pattern[0], collectErrors, errors, arrPath);
      if (result) {
        result.path = _prependPath(collectErrors ? arrPath : i, result.path);
        if (!collectErrors) return result;
        if (typeof value[i] !== 'object' || result.message) errors.push(result);
      }
    }

    if (!collectErrors) return false;
    return errors.length === 0 ? false : errors;
  }

  // Match.Where
  if (pattern instanceof Where) {
    try {
      const result = pattern.condition(value);
      if (result) {
        return false;
      }
      return { message: 'Failed Match.Where validation', path: '' };
    } catch (err) {
      if (!(err instanceof Match.Error)) {
        throw err;
      }
      return { message: err.message, path: err.path };
    }
  }

  if (pattern instanceof Maybe) {
    pattern = Match.OneOf(undefined, null, pattern.pattern);
  } else if (pattern instanceof Optional) {
    pattern = Match.OneOf(undefined, pattern.pattern);
  }

  if (pattern instanceof OneOf) {
    if (pattern.choices.some(choice => !testSubtree(value, choice))) {
      return false;
    }
    return { message: 'Failed Match.OneOf, Match.Maybe or Match.Optional validation', path: '' };
  }

  // Functions as constructors
  if (typeof pattern === 'function') {
    if (value instanceof pattern) {
      return false;
    }
    return { message: `Expected ${pattern.name || 'particular constructor'}`, path: '' };
  }

  let unknownKeysAllowed = false;
  let unknownKeyPattern;

  if (pattern instanceof ObjectIncluding) {
    unknownKeysAllowed = true;
    pattern = pattern.pattern;
  }

  if (pattern instanceof ObjectWithValues) {
    unknownKeysAllowed = true;
    unknownKeyPattern = [pattern.pattern];
    pattern = {};
  }

  if (typeof pattern !== 'object') {
    return { message: 'Bad pattern: unknown pattern type', path: '' };
  }

  if (typeof value !== 'object' || value === null) {
    return { message: `Expected object, got ${stringForErrorMessage(value, { onlyShowType: true })}`, path: '' };
  }

  if (!isPlainObject(value)) {
    return { message: 'Expected plain object', path: '' };
  }

  const requiredPatterns = Object.create(null);
  const optionalPatterns = Object.create(null);

  for (const key of Object.keys(pattern)) {
    const subPattern = pattern[key];
    if (subPattern instanceof Optional || subPattern instanceof Maybe) {
      optionalPatterns[key] = subPattern.pattern;
    } else {
      requiredPatterns[key] = subPattern;
    }
  }

  for (const key in value) {
    const subValue = value[key];
    const objPath = path ? `${path}.${key}` : key;
    if (hasOwn.call(requiredPatterns, key)) {
      const result = testSubtree(subValue, requiredPatterns[key], collectErrors, errors, objPath);
      if (result) {
        result.path = _prependPath(collectErrors ? objPath : key, result.path);
        if (!collectErrors) return result;
        if (typeof subValue !== 'object' || result.message) errors.push(result);
      }
      delete requiredPatterns[key];
    } else if (hasOwn.call(optionalPatterns, key)) {
      const result = testSubtree(subValue, optionalPatterns[key], collectErrors, errors, objPath);
      if (result) {
        result.path = _prependPath(collectErrors ? objPath : key, result.path);
        if (!collectErrors) return result;
        if (typeof subValue !== 'object' || result.message) errors.push(result);
      }
    } else {
      if (!unknownKeysAllowed) {
        const result = { message: 'Unknown key', path: key };
        if (!collectErrors) return result;
        errors.push(result);
      }
      if (unknownKeyPattern) {
        const result = testSubtree(subValue, unknownKeyPattern[0], collectErrors, errors, objPath);
        if (result) {
          result.path = _prependPath(collectErrors ? objPath : key, result.path);
          if (!collectErrors) return result;
          if (typeof subValue !== 'object' || result.message) errors.push(result);
        }
      }
    }
  }

  const missingKeys = Object.keys(requiredPatterns);
  if (missingKeys.length) {
    const createMissingError = key => ({ message: `Missing key '${key}'`, path: collectErrors ? path : '' });
    if (!collectErrors) {
      return createMissingError(missingKeys[0]);
    }
    for (const key of missingKeys) {
      errors.push(createMissingError(key));
    }
  }

  if (!collectErrors) return false;
  return errors.length === 0 ? false : errors;
}

/**
 * Asynchronously tests if a value matches a pattern.
 *
 * @param {*} value - The value to test.
 * @param {*} pattern - The pattern to match against.
 * @param {boolean} [collectErrors=false] - Whether to collect all errors.
 * @param {Array} [errors=[]] - Accumulated errors when collecting errors.
 * @param {string} [path=''] - The current path in the object being matched.
 * @returns {Promise<boolean|Object|Array>} Returns `false` if the value matches the pattern.
 *          Otherwise, returns an error object with `message` and `path` fields,
 *          or an array of such error objects when collecting errors.
 */
async function testSubtreeAsync(value, pattern, collectErrors = false, errors = [], path = '') {
  // Match anything!
  if (pattern === Match.Any) {
    return false;
  }

  // Basic atomic types.
  for (const [type, typeName] of typeofChecks) {
    if (pattern === type) {
      if (typeof value === typeName) {
        return false;
      }
      return { message: `Expected ${typeName}, got ${stringForErrorMessage(value, { onlyShowType: true })}`, path };
    }
  }

  if (pattern === null) {
    if (value === null) {
      return false;
    }
    return { message: `Expected null, got ${stringForErrorMessage(value)}`, path };
  }

  // Match literal strings, numbers, and booleans
  if (typeof pattern === 'string' || typeof pattern === 'number' || typeof pattern === 'boolean') {
    if (value === pattern) {
      return false;
    }
    return { message: `Expected ${pattern}, got ${stringForErrorMessage(value)}`, path };
  }

  // Match Integer
  if (pattern === Match.Integer) {
    if (typeof value === 'number' && (value | 0) === value) {
      return false;
    }
    return { message: `Expected Integer, got ${stringForErrorMessage(value)}`, path };
  }

  // 'Object' is shorthand for Match.ObjectIncluding({})
  if (pattern === Object) {
    pattern = Match.ObjectIncluding({});
  }

  // Match arrays
  if (Array.isArray(pattern)) {
    if (pattern.length !== 1) {
      return { message: `Bad pattern: arrays must have one type element ${stringForErrorMessage(pattern)}`, path };
    }

    if (!Array.isArray(value) && !isArguments(value)) {
      return { message: `Expected array, got ${stringForErrorMessage(value)}`, path };
    }

    for (let i = 0, len = value.length; i < len; i++) {
      const elementPath = _prependPath(path, i);
      const result = await testSubtree(value[i], pattern[0], collectErrors, errors, elementPath);
      if (result) {
        if (!collectErrors) return result;
        errors.push(result);
      }
    }

    if (!collectErrors) return false;
    return errors.length === 0 ? false : errors;
  }

  // Match.Where
  if (pattern instanceof Where) {
    try {
      const result = await pattern.condition(value);
      if (result) {
        return false;
      }
      return { message: 'Failed Match.Where validation', path };
    } catch (err) {
      if (!(err instanceof Match.Error)) {
        throw err;
      }
      return { message: err.message, path: _prependPath(path, err.path) };
    }
  }

  if (pattern instanceof Maybe) {
    pattern = Match.OneOf(undefined, null, pattern.pattern);
  } else if (pattern instanceof Optional) {
    pattern = Match.OneOf(undefined, pattern.pattern);
  }

  if (pattern instanceof OneOf) {
    for (const choice of pattern.choices) {
      const result = await testSubtree(value, choice);
      if (!result) {
        return false;
      }
    }
    return { message: 'Failed Match.OneOf, Match.Maybe or Match.Optional validation', path };
  }

  // Functions as constructors
  if (typeof pattern === 'function') {
    if (value instanceof pattern) {
      return false;
    }
    return { message: `Expected ${pattern.name || 'particular constructor'}`, path };
  }

  let unknownKeysAllowed = false;
  let unknownKeyPattern;

  if (pattern instanceof ObjectIncluding) {
    unknownKeysAllowed = true;
    pattern = pattern.pattern;
  }

  if (pattern instanceof ObjectWithValues) {
    unknownKeysAllowed = true;
    unknownKeyPattern = [pattern.pattern];
    pattern = {};
  }

  if (typeof pattern !== 'object') {
    return { message: 'Bad pattern: unknown pattern type', path };
  }

  if (typeof value !== 'object' || value === null) {
    return { message: `Expected object, got ${stringForErrorMessage(value, { onlyShowType: true })}`, path };
  }

  if (!isPlainObject(value)) {
    return { message: 'Expected plain object', path };
  }

  const requiredPatterns = Object.create(null);
  const optionalPatterns = Object.create(null);

  const patternKeys = Object.keys(pattern);
  for (const key of patternKeys) {
    const subPattern = pattern[key];
    if (subPattern instanceof Optional || subPattern instanceof Maybe) {
      optionalPatterns[key] = subPattern.pattern;
    } else {
      requiredPatterns[key] = subPattern;
    }
  }

  const valueKeys = Object.keys(value);
  for (const key of valueKeys) {
    const subValue = value[key];
    const keyPath = _prependPath(path, key);
    if (hasOwn.call(requiredPatterns, key)) {
      const result = await testSubtree(subValue, requiredPatterns[key], collectErrors, errors, keyPath);
      if (result) {
        if (!collectErrors) return result;
        errors.push(result);
      }
      delete requiredPatterns[key];
    } else if (hasOwn.call(optionalPatterns, key)) {
      const result = await testSubtree(subValue, optionalPatterns[key], collectErrors, errors, keyPath);
      if (result) {
        if (!collectErrors) return result;
        errors.push(result);
      }
    } else {
      if (!unknownKeysAllowed) {
        const result = { message: 'Unknown key', path: keyPath };
        if (!collectErrors) return result;
        errors.push(result);
      }
      if (unknownKeyPattern) {
        const result = await testSubtree(subValue, unknownKeyPattern[0], collectErrors, errors, keyPath);
        if (result) {
          if (!collectErrors) return result;
          errors.push(result);
        }
      }
    }
  }

  const missingKeys = Object.keys(requiredPatterns);
  if (missingKeys.length) {
    const createMissingError = key => ({ message: `Missing key '${key}'`, path: _prependPath(path, key) });
    if (!collectErrors) {
      return createMissingError(missingKeys[0]);
    }
    for (const key of missingKeys) {
      errors.push(createMissingError(key));
    }
  }

  if (!collectErrors) return false;
  return errors.length === 0 ? false : errors;
}

/**
 * Class for checking that all arguments are matched.
 */
class ArgumentChecker {
  /**
   * Creates an ArgumentChecker.
   *
   * @param {Array} args - The arguments to check.
   * @param {string} description - Description of the arguments.
   */
  constructor(args, description) {
    // Make a shallow copy of the arguments.
    this.args = [...args].reverse();
    this.description = description;
  }

  /**
   * Marks a value as being checked.
   *
   * @param {*} value - The value that was checked.
   */
  checking(value) {
    if (this._checkingOneValue(value)) {
      return;
    }

    // Allow check(arguments, [String]) or check(arguments.slice(1), [String])
    // or check([foo, bar], [String]) to count... but only if value wasn't
    // itself an argument.
    if (Array.isArray(value) || isArguments(value)) {
      for (const v of value) {
        this._checkingOneValue(v);
      }
    }
  }

  /**
   * Checks if a single value has been checked.
   *
   * @param {*} value - The value to check.
   * @returns {boolean} True if the value has been checked, false otherwise.
   * @private
   */
  _checkingOneValue(value) {
    for (let i = 0; i < this.args.length; i++) {
      if (value === this.args[i] || (Number.isNaN(value) && Number.isNaN(this.args[i]))) {
        this.args.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Throws an error if not all arguments have been checked.
   */
  throwUnlessAllArgumentsHaveBeenChecked() {
    if (this.args.length > 0) {
      throw new Error(`Did not check() all arguments during ${this.description}`);
    }
  }
}

// Keywords that are not allowed as identifiers
const _jsKeywords = new Set([
  'do', 'if', 'in', 'for', 'let', 'new', 'try', 'var', 'case',
  'else', 'enum', 'eval', 'false', 'null', 'this', 'true', 'void', 'with',
  'break', 'catch', 'class', 'const', 'super', 'throw', 'while', 'yield',
  'delete', 'export', 'import', 'public', 'return', 'static', 'switch',
  'typeof', 'default', 'extends', 'finally', 'package', 'private', 'continue',
  'debugger', 'function', 'arguments', 'interface', 'protected', 'implements',
  'instanceof'
]);

// Precompile regex patterns
const numberRegex = /^[0-9]+$/;
const identifierRegex = /^[a-z_$][0-9a-z_$.[\]]*$/i;

const _prependPath = (key, base) => {
  if (typeof key === 'number' || numberRegex.test(key)) {
    key = `[${key}]`;
  } else if (!identifierRegex.test(key) || _jsKeywords.has(key)) {
    key = JSON.stringify([key]);
  }

  if (base && base[0] !== '[') {
    return `${key}.${base}`;
  }

  return key + base;
};

const isArguments = value => Object.prototype.toString.call(value) === '[object Arguments]';