/**
 * Simple LRU cache with optional TTL.
 */
export class LRUCache {
    map = new Map();
    maxSize;
    ttlMs;
    constructor(maxSize = 100, ttlMs = 0) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
    }
    get(key) {
        const entry = this.map.get(key);
        if (!entry)
            return undefined;
        if (this.ttlMs > 0 && Date.now() > entry.expires) {
            this.map.delete(key);
            return undefined;
        }
        // Move to end (most recently used)
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }
    set(key, value) {
        this.map.delete(key);
        if (this.map.size >= this.maxSize) {
            // Delete oldest (first entry)
            const firstKey = this.map.keys().next().value;
            if (firstKey !== undefined)
                this.map.delete(firstKey);
        }
        this.map.set(key, {
            value,
            expires: this.ttlMs > 0 ? Date.now() + this.ttlMs : Infinity,
        });
    }
    has(key) {
        return this.get(key) !== undefined;
    }
    clear() {
        this.map.clear();
    }
    get size() {
        return this.map.size;
    }
}
//# sourceMappingURL=cache.js.map