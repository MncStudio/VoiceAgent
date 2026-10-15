export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiter?: () => void;
  private ended = false;
  private error?: Error;
  push(value: T) {
    if (!this.ended) {
      this.items.push(value);
      this.waiter?.();
    }
  }
  end(error?: Error) {
    this.ended = true;
    this.error = error;
    this.waiter?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = undefined;
    }
  }
}
/** 先进先出的计数信号量，用于限制并发合成的句子数且保证按句顺序获得名额。 */
export class Semaphore {
  private waiters: (() => void)[] = [];
  constructor(private free: number) {}
  async acquire() {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
}
