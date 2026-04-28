/**
 * Minimal pluggable serializers. Default: JSON.
 * Each serializer exposes serialize(any)=>string|Uint8Array and
 * deserialize(string|Uint8Array)=>any.
 */

/**
 * @typedef {{serialize:(v:any)=>string|Uint8Array, deserialize:(v:string|Uint8Array)=>any}} Serializer
 */

const textDecoder = new TextDecoder();

/** @type {Record<string, Serializer>} */
const registry = {
  json: {
    serialize: (v) => JSON.stringify(v),
    deserialize: (v) => {
      if (typeof v !== 'string') v = textDecoder.decode(v);
      return JSON.parse(v);
    },
  },
};

export function registerSerializer(key, serializer) {
  registry[key] = serializer;
}

/**
 * @param {string} key
 * @returns {Serializer}
 */
export function getSerializer(key) {
  const s = registry[key];
  if (!s) {
    throw new Error(`Unknown serializer: ${key}`);
  }
  return s;
}
