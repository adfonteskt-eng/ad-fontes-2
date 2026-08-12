// A small, dependency-free bounded cache shared by every in-memory cache in
// this project (gatherPassage() results in lib/gather.js, lexicon/word-
// study lookups in lib/interlinear.js). Two properties matter for all of
// them: entries shouldn't live forever (even data backed by a static local
// file benefits from a bound so a long-running process can't accumulate
// unlimited unique keys; data backed by a live external call additionally
// needs to self-heal from a transiently-bad response rather than cache it
// permanently), and the cache shouldn't grow without bound regardless of
// how many distinct keys get queried over the process's lifetime.
//
// Map preserves insertion order, so deleting and re-inserting a key on
// every write keeps recently-used entries at the end of iteration order —
// plain oldest-first eviction then gives correct least-recently-used
// behavior once the cache is over its size cap, not just oldest-created.
export class TTLCache {
  constructor({ ttlMs, maxEntries }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.store = new Map(); // key -> { value, expiresAt }
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // A read counts as "used," same as a write — without this, eviction
    // would really be least-recently-*inserted* (FIFO), not least-recently-
    // *used*, since a frequently-read-but-never-rewritten entry would still
    // look "old" by insertion order alone. Reinsert to bump it to the most-
    // recently-used position, preserving its original expiresAt — a read
    // shouldn't extend how long an entry lives, only how likely it is to
    // survive eviction under the size cap.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value) {
    this.store.delete(key); // bump to "most recently used" position
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    this.prune();
  }

  delete(key) {
    this.store.delete(key);
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
    }
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}
