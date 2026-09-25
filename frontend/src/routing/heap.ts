/** Binary min-heap of (priority, id) on typed arrays; grows as needed.
 * Lazy deletion: callers skip ids they already settled. */
export class MinHeap {
  private keys: Float64Array;
  private ids: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.ids = new Int32Array(capacity);
  }

  push(key: number, id: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const v = new Int32Array(this.size * 2);
      v.set(this.ids);
      this.ids = v;
    }
    let i = this.size++;
    const keys = this.keys;
    const ids = this.ids;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      ids[i] = ids[p];
      i = p;
    }
    keys[i] = key;
    ids[i] = id;
  }

  /** Remove the minimum; returns its id (-1 when empty). */
  pop(): number {
    if (this.size === 0) return -1;
    const keys = this.keys;
    const ids = this.ids;
    const top = ids[0];
    const n = --this.size;
    if (n > 0) {
      const k = keys[n];
      const v = ids[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= k) break;
        keys[i] = keys[c];
        ids[i] = ids[c];
        i = c;
      }
      keys[i] = k;
      ids[i] = v;
    }
    return top;
  }

  peekKey(): number {
    return this.size ? this.keys[0] : Infinity;
  }

  clear(): void {
    this.size = 0;
  }
}
