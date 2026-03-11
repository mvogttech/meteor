// IndexedDB persistence layer for minimongo collections.
// Client-only. Provides batched write-behind persistence and
// BroadcastChannel-based multi-tab coordination.

const DB_NAME = 'MeteorPersistCache';
const METADATA_STORE = '_metadata';
const DEFAULT_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const FLUSH_DELAY = 100; // ms

let dbPromise = null;
const tabId = Random.id();

// --- IndexedDB browser detection ---

function getIDB() {
  if (typeof indexedDB !== 'undefined') return indexedDB;
  if (typeof webkitIndexedDB !== 'undefined') return webkitIndexedDB;
  if (typeof mozIndexedDB !== 'undefined') return mozIndexedDB;
  if (typeof OIndexedDB !== 'undefined') return OIndexedDB;
  if (typeof msIndexedDB !== 'undefined') return msIndexedDB;
}

// --- Collection registry in localStorage ---

function getRegisteredCollections() {
  try {
    const raw = Meteor._localStorage.getItem('meteor-persist-collections');
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function setRegisteredCollections(names) {
  try {
    Meteor._localStorage.setItem(
      'meteor-persist-collections',
      JSON.stringify(names)
    );
  } catch (e) {
    // localStorage may be unavailable
  }
}

function getStoredVersion() {
  try {
    const v = Meteor._localStorage.getItem('meteor-persist-version');
    return v ? parseInt(v, 10) : 1;
  } catch (e) {
    return 1;
  }
}

function setStoredVersion(v) {
  try {
    Meteor._localStorage.setItem('meteor-persist-version', String(v));
  } catch (e) {
    // localStorage may be unavailable
  }
}

// --- IDB open / upgrade ---

function makeOnError(reject, source) {
  return function (event) {
    reject(new Error(
      'IndexedDB failure in ' + source + ' ' +
      JSON.stringify(event.target)
    ));
    return true; // prevents InvalidStateError in Firefox private browsing
  };
}

function openDB(version, requiredStores) {
  return new Promise(function (resolve, reject) {
    const idb = getIDB();
    if (!idb) {
      resolve(null);
      return;
    }

    const request = idb.open(DB_NAME, version);

    request.onupgradeneeded = function (event) {
      const db = event.target.result;

      requiredStores.forEach(function (name) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name);
        }
      });

      if (!db.objectStoreNames.contains(METADATA_STORE)) {
        db.createObjectStore(METADATA_STORE);
      }
    };

    request.onerror = makeOnError(reject, 'indexedDB.open');
    request.onsuccess = function (event) {
      resolve(event.target.result);
    };
  });
}

// Ensures the given collection name is registered for IndexedDB persistence.
// On first load for a new collection, the object store won't exist yet —
// we register the name and bump the stored version so the store is created
// on the next page load. This avoids close/reopen races when multiple
// persisted collections are created simultaneously at app startup.
// First load has no cached data to hydrate anyway, so this is safe.
function ensureObjectStore(name) {
  const collections = getRegisteredCollections();
  if (!collections.includes(name)) {
    collections.push(name);
    setRegisteredCollections(collections);
    setStoredVersion(getStoredVersion() + 1);
  }

  return withDB(function (db) {
    return db;
  });
}

function withDB(callback) {
  if (!dbPromise) {
    const collections = getRegisteredCollections();
    const version = getStoredVersion();
    dbPromise = openDB(version, collections).catch(function () {
      return null;
    });
  }

  return dbPromise.then(callback, function () {
    return callback(null);
  });
}

// --- Read operations ---

function readAll(db, storeName) {
  return new Promise(function (resolve, reject) {
    if (!db || !db.objectStoreNames.contains(storeName)) {
      resolve([]);
      return;
    }

    try {
      const txn = db.transaction([storeName], 'readonly');
      const store = txn.objectStore(storeName);
      const results = [];

      const request = store.openCursor();

      request.onerror = makeOnError(reject, 'readAll.openCursor');
      request.onsuccess = function (event) {
        const cursor = event.target.result;
        if (cursor) {
          results.push({ key: cursor.key, value: cursor.value });
          cursor.continue();
        } else {
          resolve(results);
        }
      };
    } catch (e) {
      resolve([]);
    }
  });
}

function readMetadata(db, collectionName) {
  return new Promise(function (resolve, reject) {
    if (!db || !db.objectStoreNames.contains(METADATA_STORE)) {
      resolve(null);
      return;
    }

    try {
      const txn = db.transaction([METADATA_STORE], 'readonly');
      const store = txn.objectStore(METADATA_STORE);
      const request = store.get(collectionName);

      request.onerror = function () { resolve(null); };
      request.onsuccess = function (event) {
        resolve(event.target.result || null);
      };
    } catch (e) {
      resolve(null);
    }
  });
}

// --- Batched write-behind ---

const pendingWrites = new Map(); // collectionName -> Map<stringId, {type, doc}>
let flushTimer = null;

function scheduleFlush() {
  if (!flushTimer) {
    flushTimer = setTimeout(flushPending, FLUSH_DELAY);
  }
}

function enqueuePersist(collectionName, type, id, doc) {
  if (!pendingWrites.has(collectionName)) {
    pendingWrites.set(collectionName, new Map());
  }
  const collMap = pendingWrites.get(collectionName);
  const stringId = MongoID.idStringify(id);

  if (type === 'removed') {
    collMap.set(stringId, { type: 'removed' });
  } else {
    collMap.set(stringId, { type: 'put', doc: EJSON.clone(doc) });
  }
  scheduleFlush();
}

function flushPending() {
  flushTimer = null;
  const work = new Map(pendingWrites);
  pendingWrites.clear();

  withDB(function (db) {
    if (!db) return;

    for (const [collectionName, ops] of work) {
      if (!db.objectStoreNames.contains(collectionName)) continue;

      try {
        const txn = db.transaction(
          [collectionName, METADATA_STORE],
          'readwrite'
        );
        const store = txn.objectStore(collectionName);

        for (const [stringId, op] of ops) {
          if (op.type === 'removed') {
            store.delete(stringId);
          } else {
            store.put(EJSON.toJSONValue(op.doc), stringId);
          }
        }

        // Update metadata timestamp
        const metaStore = txn.objectStore(METADATA_STORE);
        metaStore.put(
          { collection: collectionName, lastUpdated: Date.now() },
          collectionName
        );
      } catch (e) {
        // Graceful degradation — IDB write failure is non-fatal
      }
    }
  });
}

// --- BroadcastChannel ---

let broadcastChannel = null;

// Registry of active persisted collections: name -> Mongo.Collection instance
const persistedCollections = new Map();

function getBroadcastChannel() {
  if (broadcastChannel) return broadcastChannel;
  if (typeof BroadcastChannel === 'undefined') return null;

  try {
    broadcastChannel = new BroadcastChannel('meteor-persist');
    broadcastChannel.onmessage = handleBroadcastMessage;
    return broadcastChannel;
  } catch (e) {
    return null;
  }
}

function broadcastChange(collectionName, type, id, fields, doc) {
  const channel = getBroadcastChannel();
  if (!channel) return;

  const msg = {
    tabId,
    collection: collectionName,
    type,
    id: MongoID.idStringify(id),
  };

  if (type === 'added' && doc) {
    msg.doc = EJSON.toJSONValue(doc);
  }
  if (type === 'changed' && fields) {
    msg.fields = EJSON.toJSONValue(fields);
  }

  try {
    channel.postMessage(msg);
  } catch (e) {
    // postMessage can fail with DataCloneError for non-cloneable data
  }
}

function handleBroadcastMessage(event) {
  const msg = event.data;
  if (!msg || msg.tabId === tabId) return;

  const collection = persistedCollections.get(msg.collection);
  if (!collection) return;

  const lc = collection._collection; // LocalCollection
  collection._applyingBroadcast = true;

  try {
    if (msg.type === 'added' && msg.doc) {
      const doc = EJSON.fromJSONValue(msg.doc);
      const mongoId = doc._id;
      if (lc._docs.has(mongoId)) {
        // Already exists — update instead
        const fields = Object.assign({}, doc);
        delete fields._id;
        const modifier = {};
        for (const key in fields) {
          if (!modifier.$set) modifier.$set = {};
          modifier.$set[key] = fields[key];
        }
        if (Object.keys(modifier).length > 0) {
          lc.update(mongoId, modifier);
        }
      } else {
        lc.insert(doc);
      }
    } else if (msg.type === 'changed' && msg.fields) {
      const id = MongoID.idParse(msg.id);
      const fields = EJSON.fromJSONValue(msg.fields);
      const modifier = {};
      for (const key in fields) {
        const value = fields[key];
        if (typeof value === 'undefined') {
          if (!modifier.$unset) modifier.$unset = {};
          modifier.$unset[key] = 1;
        } else {
          if (!modifier.$set) modifier.$set = {};
          modifier.$set[key] = value;
        }
      }
      if (Object.keys(modifier).length > 0 && lc._docs.has(id)) {
        lc.update(id, modifier);
      }
    } else if (msg.type === 'removed') {
      const id = MongoID.idParse(msg.id);
      if (lc._docs.has(id)) {
        lc.remove(id);
      }
    }
  } catch (e) {
    // Non-fatal: log and continue
    if (Meteor.isDevelopment) {
      console.warn('Meteor persist: failed to apply broadcast message', e);
    }
  } finally {
    collection._applyingBroadcast = false;
  }
}

// --- Exports ---

export {
  DB_NAME,
  METADATA_STORE,
  DEFAULT_MAX_AGE,
  FLUSH_DELAY,
  tabId,
  getIDB,
  ensureObjectStore,
  withDB,
  readAll,
  readMetadata,
  enqueuePersist,
  flushPending,
  persistedCollections,
  broadcastChange,
  getBroadcastChannel,
};
