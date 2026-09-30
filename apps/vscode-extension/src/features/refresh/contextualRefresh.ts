/** Coalesces refreshes by context and discards responses from older contexts. */
export class ContextualRefresh<T> {
  private generation = 0;
  private active:
    | {
        contextKey: string;
        generation: number;
        invalidated: boolean;
        promise: Promise<void>;
      }
    | undefined;
  private disposed = false;

  public run(
    contextKey: string,
    load: () => Promise<T>,
    onValue: (value: T) => void,
    onError: (error: unknown) => void,
    invalidateIfRunning = false,
  ): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    if (this.active?.contextKey === contextKey) {
      if (invalidateIfRunning) {
        this.active.invalidated = true;
      }
      return this.active.promise;
    }

    const request = {
      contextKey,
      generation: ++this.generation,
      invalidated: false,
      promise: Promise.resolve(),
    };
    this.active = request;
    request.promise = Promise.resolve()
      .then(() => this.loadUntilCurrent(request, load, onValue, onError))
      .finally(() => {
        if (this.active === request) {
          this.active = undefined;
        }
      });

    return request.promise;
  }

  public clear(): void {
    this.generation += 1;
    this.active = undefined;
  }

  public dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private async loadUntilCurrent(
    request: NonNullable<ContextualRefresh<T>['active']>,
    load: () => Promise<T>,
    onValue: (value: T) => void,
    onError: (error: unknown) => void,
  ): Promise<void> {
    while (this.isCurrent(request)) {
      request.invalidated = false;

      try {
        const value = await load();
        if (!this.isCurrent(request)) {
          return;
        }
        if (request.invalidated) {
          continue;
        }
        onValue(value);
        if (request.invalidated) {
          continue;
        }
      } catch (error) {
        if (!this.isCurrent(request)) {
          return;
        }
        if (request.invalidated) {
          continue;
        }
        onError(error);
        if (request.invalidated) {
          continue;
        }
      }

      return;
    }
  }

  private isCurrent(request: NonNullable<ContextualRefresh<T>['active']>): boolean {
    return !this.disposed && this.active === request && request.generation === this.generation;
  }
}
