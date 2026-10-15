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
