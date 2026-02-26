/**
 * Simple LRU cache with optional TTL.
 */
export declare class LRUCache<K, V> {
    private map;
    private maxSize;
    private ttlMs;
    constructor(maxSize?: number, ttlMs?: number);
    get(key: K): V | undefined;
    set(key: K, value: V): void;
    has(key: K): boolean;
    clear(): void;
    get size(): number;
}
//# sourceMappingURL=cache.d.ts.map