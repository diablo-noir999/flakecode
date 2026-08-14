/**
 * In-memory session cache for the current session.
 *
 * Bounded Map with LRU eviction at 100 entries.
 * Provides fast substring search over session-scoped data.
 */

export interface CacheEntry {
  id: string;
  type: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

const MAX_ENTRIES = 100;

export class SessionCache {
  private entries = new Map<string, CacheEntry>();

  add(entry: CacheEntry): void {
    // Delete if exists to refresh position
    if (this.entries.has(entry.id)) {
      this.entries.delete(entry.id);
    }
    // Evict oldest if at capacity
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(entry.id, { ...entry, timestamp: entry.timestamp || Date.now() });
  }

  get(id: string): CacheEntry | undefined {
    return this.entries.get(id);
  }

  search(query: string): CacheEntry[] {
    const lower = query.toLowerCase();
    const results: CacheEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.content.toLowerCase().includes(lower)) {
        results.push(entry);
      }
    }
    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  getRecent(limit = 10): CacheEntry[] {
    return Array.from(this.entries.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
