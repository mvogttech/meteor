import { Tinytest } from "meteor/tinytest";
import { Mongo } from "meteor/mongo";
import { Random } from "meteor/random";
import { EJSON } from "meteor/ejson";
import { Tracker } from "meteor/tracker";

// Helper: open IndexedDB and read all entries from a store
function idbReadAll(storeName) {
  return new Promise(function (resolve) {
    var request = indexedDB.open('MeteorPersistCache');
    request.onerror = function () { resolve([]); };
    request.onsuccess = function (event) {
      var db = event.target.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve([]);
        return;
      }
      try {
        var txn = db.transaction([storeName], 'readonly');
        var store = txn.objectStore(storeName);
        var results = [];
        var cursorReq = store.openCursor();
        cursorReq.onerror = function () { resolve(results); };
        cursorReq.onsuccess = function (e) {
          var cursor = e.target.result;
          if (cursor) {
            results.push({ key: cursor.key, value: cursor.value });
            cursor.continue();
          } else {
            db.close();
            resolve(results);
          }
        };
      } catch (e) {
        db.close();
        resolve([]);
      }
    };
  });
}

// Helper: read metadata entry
function idbReadMeta(collectionName) {
  return new Promise(function (resolve) {
    var request = indexedDB.open('MeteorPersistCache');
    request.onerror = function () { resolve(null); };
    request.onsuccess = function (event) {
      var db = event.target.result;
      if (!db.objectStoreNames.contains('_metadata')) {
        db.close();
        resolve(null);
        return;
      }
      try {
        var txn = db.transaction(['_metadata'], 'readonly');
        var store = txn.objectStore('_metadata');
        var getReq = store.get(collectionName);
        getReq.onerror = function () { db.close(); resolve(null); };
        getReq.onsuccess = function (e) {
          db.close();
          resolve(e.target.result || null);
        };
      } catch (e) {
        db.close();
        resolve(null);
      }
    };
  });
}

// Helper: write a doc directly into IDB for a collection
function idbPutDoc(collectionName, doc) {
  return new Promise(function (resolve, reject) {
    var request = indexedDB.open('MeteorPersistCache');
    request.onerror = function () { reject(new Error('IDB open failed')); };
    request.onsuccess = function (event) {
      var db = event.target.result;
      if (!db.objectStoreNames.contains(collectionName)) {
        db.close();
        reject(new Error('Store ' + collectionName + ' not found'));
        return;
      }
      try {
        var txn = db.transaction(
          [collectionName, '_metadata'],
          'readwrite'
        );
        var store = txn.objectStore(collectionName);
        // For string _ids, the key is the string itself
        store.put(EJSON.toJSONValue(doc), doc._id);

        var metaStore = txn.objectStore('_metadata');
        metaStore.put(
          { collection: collectionName, lastUpdated: Date.now() },
          collectionName
        );

        txn.oncomplete = function () { db.close(); resolve(); };
        txn.onerror = function () { db.close(); reject(new Error('txn error')); };
      } catch (e) {
        db.close();
        reject(e);
      }
    };
  });
}

// Helper: write stale metadata
function idbPutStaleMeta(collectionName, ageMs) {
  return new Promise(function (resolve, reject) {
    var request = indexedDB.open('MeteorPersistCache');
    request.onerror = function () { reject(new Error('IDB open failed')); };
    request.onsuccess = function (event) {
      var db = event.target.result;
      if (!db.objectStoreNames.contains('_metadata')) {
        db.close();
        reject(new Error('_metadata store not found'));
        return;
      }
      try {
        var txn = db.transaction(['_metadata'], 'readwrite');
        var store = txn.objectStore('_metadata');
        store.put(
          { collection: collectionName, lastUpdated: Date.now() - ageMs },
          collectionName
        );
        txn.oncomplete = function () { db.close(); resolve(); };
        txn.onerror = function () { db.close(); reject(new Error('txn error')); };
      } catch (e) {
        db.close();
        reject(e);
      }
    };
  });
}

// Helper: clear a store
function idbClearStore(storeName) {
  return new Promise(function (resolve) {
    var request = indexedDB.open('MeteorPersistCache');
    request.onerror = function () { resolve(); };
    request.onsuccess = function (event) {
      var db = event.target.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve();
        return;
      }
      try {
        var txn = db.transaction([storeName], 'readwrite');
        txn.objectStore(storeName).clear();
        txn.oncomplete = function () { db.close(); resolve(); };
        txn.onerror = function () { db.close(); resolve(); };
      } catch (e) {
        db.close();
        resolve();
      }
    };
  });
}

// Helper: wait for IDB flush (write-behind uses 100ms debounce)
function waitForFlush() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 250);
  });
}

// --- Tests ---

Tinytest.addAsync(
  'persist - collection with persist:true gets cacheReady methods',
  async function (test) {
    var name = 'persist_test_' + Random.id();
    var coll = new Mongo.Collection(name, {
      connection: null,
      persist: true,
    });

    test.isTrue(typeof coll.cacheReady === 'function');
    test.isTrue(typeof coll.cacheReadyPromise === 'function');
    test.isTrue(typeof coll.clearCache === 'function');

    await coll.cacheReadyPromise();
    test.isTrue(coll.cacheReady());
  }
);

Tinytest.addAsync(
  'persist - collection without persist has cacheReady return true',
  async function (test) {
    var name = 'persist_nopersist_' + Random.id();
    var coll = new Mongo.Collection(name, { connection: null });

    test.isTrue(coll.cacheReady());
    var result = await coll.cacheReadyPromise();
    test.isTrue(result);
  }
);

Tinytest.addAsync(
  'persist - inserts are persisted to IndexedDB',
  async function (test) {
    var name = 'persist_insert_' + Random.id();
    var coll = new Mongo.Collection(name, {
      connection: null,
      persist: true,
    });

    await coll.cacheReadyPromise();

    coll.insert({ _id: 'doc1', title: 'Hello' });
    coll.insert({ _id: 'doc2', title: 'World' });

    await waitForFlush();

    var entries = await idbReadAll(name);
    test.equal(entries.length, 2);

    var doc1 = entries.find(function (e) { return e.key === 'doc1'; });
    test.isTrue(doc1);
    var parsed = EJSON.fromJSONValue(doc1.value);
    test.equal(parsed.title, 'Hello');
  }
);

Tinytest.addAsync(
  'persist - updates are persisted to IndexedDB',
  async function (test) {
    var name = 'persist_update_' + Random.id();
    var coll = new Mongo.Collection(name, {
      connection: null,
      persist: true,
    });

    await coll.cacheReadyPromise();

    coll.insert({ _id: 'doc1', title: 'Original' });
    await waitForFlush();

    coll.update('doc1', { $set: { title: 'Updated' } });
    await waitForFlush();

    var entries = await idbReadAll(name);
    var doc1 = entries.find(function (e) { return e.key === 'doc1'; });
    test.isTrue(doc1);
    var parsed = EJSON.fromJSONValue(doc1.value);
    test.equal(parsed.title, 'Updated');
  }
);

Tinytest.addAsync(
  'persist - removes are persisted to IndexedDB',
  async function (test) {
    var name = 'persist_remove_' + Random.id();
    var coll = new Mongo.Collection(name, {
      connection: null,
      persist: true,
    });

    await coll.cacheReadyPromise();

    coll.insert({ _id: 'doc1', title: 'ToRemove' });
    await waitForFlush();

    var entriesBefore = await idbReadAll(name);
    test.equal(entriesBefore.length, 1);

    coll.remove('doc1');
    await waitForFlush();

    var entriesAfter = await idbReadAll(name);
    test.equal(entriesAfter.length, 0);
  }
);

Tinytest.addAsync(
  'persist - metadata timestamp is updated on write',
  async function (test) {
    var name = 'persist_meta_' + Random.id();
    var coll = new Mongo.Collection(name, {
      connection: null,
      persist: true,
    });

    await coll.cacheReadyPromise();

    var before = Date.now();
    coll.insert({ _id: 'doc1', title: 'Test' });
    await waitForFlush();

    var meta = await idbReadMeta(name);
    test.isTrue(meta);
    test.isTrue(meta.lastUpdated >= before);
    test.isTrue(meta.lastUpdated <= Date.now());
  }
);

Tinytest.addAsync(
  'persist - clearCache empties IDB store and metadata',
  async function (test) {
    var name = 'persist_clear_' + Random.id();
    var coll = new Mongo.Collection(name, {
      connection: null,
      persist: true,
    });

    await coll.cacheReadyPromise();

    coll.insert({ _id: 'doc1', title: 'Test' });
    await waitForFlush();

    var entriesBefore = await idbReadAll(name);
    test.equal(entriesBefore.length, 1);

    await coll.clearCache();

    var entriesAfter = await idbReadAll(name);
    test.equal(entriesAfter.length, 0);

    var meta = await idbReadMeta(name);
    test.equal(meta, null);
  }
);

Tinytest.addAsync(
  'persist - cacheReady is reactive',
  async function (test) {
    var name = 'persist_reactive_' + Random.id();
    var readyValues = [];

    var coll = new Mongo.Collection(name, {
      connection: null,
      persist: true,
    });

    // Track reactive changes
    var comp = Tracker.autorun(function () {
      readyValues.push(coll.cacheReady());
    });

    await coll.cacheReadyPromise();

    // Let Tracker flush
    Tracker.flush();

    // Should have captured at least the transition to true
    test.isTrue(readyValues[readyValues.length - 1]);

    comp.stop();
  }
);

Tinytest.addAsync(
  'persist - anonymous collections are not persisted',
  async function (test) {
    var coll = new Mongo.Collection(null, { persist: true });

    // Should still have cacheReady (from prototype method) but
    // _persistEnabled should be falsy
    test.isTrue(coll.cacheReady());
    test.isFalse(!!coll._persistEnabled);
  }
);

Tinytest.addAsync(
  'persist - EJSON types are preserved through IDB round-trip',
  async function (test) {
    var name = 'persist_ejson_' + Random.id();
    var coll = new Mongo.Collection(name, {
      connection: null,
      persist: true,
    });

    await coll.cacheReadyPromise();

    var testDate = new Date('2025-01-15T12:00:00Z');
    coll.insert({ _id: 'doc1', createdAt: testDate, count: 42 });
    await waitForFlush();

    var entries = await idbReadAll(name);
    var doc1 = entries.find(function (e) { return e.key === 'doc1'; });
    test.isTrue(doc1);

    var parsed = EJSON.fromJSONValue(doc1.value);
    test.instanceOf(parsed.createdAt, Date);
    test.equal(parsed.createdAt.getTime(), testDate.getTime());
    test.equal(parsed.count, 42);
  }
);
