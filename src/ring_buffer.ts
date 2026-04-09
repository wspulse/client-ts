/**
 * Fixed-capacity circular buffer with O(1) push and O(1) shift.
 *
 * Used internally as the outbound send buffer. Not exported from the
 * package — consumers interact with `sendBufferSize` via options.
 *
 * @internal
 */
export class RingBuffer<T> {
  private readonly data: (T | undefined)[];
  private head = 0;
  private size = 0;
  private readonly cap: number;

  constructor(capacity: number) {
    this.cap = capacity;
    this.data = new Array<T | undefined>(capacity);
  }

  /** Number of elements currently in the buffer. */
  get length(): number {
    return this.size;
  }

  /**
   * Append an item to the back of the buffer.
   *
   * @returns `true` if the item was added, `false` if the buffer is full.
   */
  push(item: T): boolean {
    if (this.size >= this.cap) return false;
    const index = (this.head + this.size) % this.cap;
    this.data[index] = item;
    this.size++;
    return true;
  }

  /**
   * Remove and return the front item.
   *
   * @returns The oldest item, or `undefined` if the buffer is empty.
   */
  shift(): T | undefined {
    if (this.size === 0) return undefined;
    const item = this.data[this.head];
    this.data[this.head] = undefined; // release reference for GC
    this.head = (this.head + 1) % this.cap;
    this.size--;
    return item;
  }

  /** Reset the buffer to empty. Does not reallocate the underlying array. */
  clear(): void {
    // Release references for GC
    for (let i = 0; i < this.size; i++) {
      this.data[(this.head + i) % this.cap] = undefined;
    }
    this.head = 0;
    this.size = 0;
  }
}
