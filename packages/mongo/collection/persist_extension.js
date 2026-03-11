// CollectionExtensions integration for IndexedDB persistence.
// Client-only. Hooks into Mongo.Collection construction to add
// opt-in persistence via the { persist: true } option.

import {
  DEFAULT_MAX_AGE,
  ensureObjectStore,
  readAll,
  readMetadata,
  enqueuePersist,
  persistedCollections,
  broadcastChange,
  getBroadcastChannel,
  withDB,
  METADATA_STORE,
} from './persist_idb.js';

// --- Hydration ---

async function hydrateCollection(collection, name, maxAge) {
  try {
    const db = await ensureObjectStore(name);
    if (!db) {
      collection._cacheReady.set(true);
      return;
    }

    // Check staleness
    const meta = await readMetadata(db, name);
    if (meta && (Date.now() - meta.lastUpdated) > maxAge) {
      // Cache is stale — clear it
      try {
        const txn = db.transaction([name], 'readwrite');
        txn.objectStore(name).clear();
      } catch (e) {
        // Non-fatal
      }
      collection._cacheReady.set(true);
      return;
    }

    // Read cached documents
    const entries = await readAll(db, name);
    if (entries.length > 0) {
      const lc = collection._collection;
      collection._applyingHydration = true;

      lc.pauseObservers();
      try {
        for (const entry of entries) {
          const doc = EJSON.fromJSONValue(entry.value);
          if (!lc._docs.has(doc._id)) {
            lc.insert(doc);
          }
        }
      } finally {
        lc.resumeObserversClient();
        collection._applyingHydration = false;
      }
    }

    collection._cacheReady.set(true);
  } catch (e) {
    if (Meteor.isDevelopment) {
      console.warn('Meteor persist: hydration failed for ' + name, e);
    }
    collection._cacheReady.set(true);
  }
}

// --- Write observer ---

function setupWriteObserver(collection, name) {
  const lc = collection._collection;

  lc.find({}).observeChanges({
    _suppress_initial: true,

    added(id, fields) {
      if (collection._applyingBroadcast) return;

      const doc = { _id: id, ...fields };
      enqueuePersist(name, 'added', id, doc);
      broadcastChange(name, 'added', id, null, doc);
    },

    changed(id, fields) {
      if (collection._applyingBroadcast) return;

      // Persist the full document, not just changed fields
      const fullDoc = lc._docs.get(id);
      if (fullDoc) {
        enqueuePersist(name, 'changed', id, fullDoc);
      }
      broadcastChange(name, 'changed', id, fields, null);
    },

    removed(id) {
      if (collection._applyingBroadcast) return;

      enqueuePersist(name, 'removed', id, null);
      broadcastChange(name, 'removed', id, null, null);
    },
  });
}

// --- Extension registration ---

CollectionExtensions.addExtension(function persistExtension(name, options) {
  if (!Meteor.isClient) return;
  if (!options.persist) return;
  if (!name) return;

  const collection = this;
  const persistOptions =
    typeof options.persist === 'object' ? options.persist : {};
  const maxAge =
    persistOptions.maxAge != null ? persistOptions.maxAge : DEFAULT_MAX_AGE;

  // Initialize persistence state
  collection._persistEnabled = true;
  collection._applyingBroadcast = false;
  collection._applyingHydration = false;
  collection._cacheReady = new ReactiveVar(false);

  // Register for BroadcastChannel routing
  persistedCollections.set(name, collection);

  // Initialize BroadcastChannel (lazy, creates on first call)
  getBroadcastChannel();

  // Start async hydration, then set up write observer
  collection._persistHydratePromise = hydrateCollection(
    collection,
    name,
    maxAge
  ).then(function () {
    setupWriteObserver(collection, name);
  });
});

// --- Prototype methods ---

CollectionExtensions.addPrototypeMethod('cacheReady', function () {
  if (!this._persistEnabled) return true;
  return this._cacheReady.get();
});

CollectionExtensions.addPrototypeMethod('cacheReadyPromise', function () {
  if (!this._persistEnabled) return Promise.resolve(true);
  return this._persistHydratePromise;
});

CollectionExtensions.addPrototypeMethod('clearCache', function () {
  if (!this._persistEnabled) return Promise.resolve();
  const name = this._name;
  return new Promise(function (resolve) {
    withDB(function (db) {
      if (!db) {
        resolve();
        return;
      }

      const storeNames = [];
      if (db.objectStoreNames.contains(name)) storeNames.push(name);
      if (db.objectStoreNames.contains(METADATA_STORE))
        storeNames.push(METADATA_STORE);

      if (storeNames.length === 0) {
        resolve();
        return;
      }

      try {
        const txn = db.transaction(storeNames, 'readwrite');
        if (db.objectStoreNames.contains(name)) {
          txn.objectStore(name).clear();
        }
        if (db.objectStoreNames.contains(METADATA_STORE)) {
          txn.objectStore(METADATA_STORE).delete(name);
        }
        txn.oncomplete = function () { resolve(); };
        txn.onerror = function () { resolve(); };
      } catch (e) {
        resolve();
      }
    });
  });
});
