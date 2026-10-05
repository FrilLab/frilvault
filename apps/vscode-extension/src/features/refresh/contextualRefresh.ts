import { refreshContextId } from './diagnostics';
import type { RefreshTraceSink } from './diagnostics';

/** Coalesces requests and retains every real invalidation until a read catches up. */
export class ContextualRefresh<T> {
  private generation = 0;
  private nextRequestId = 0;
  private active:
    | {
        contextKey: string;
        requestId: number;
        contextGeneration: number;
        invalidationGeneration: number;
        invalidated: boolean;
        running: boolean;
        promise: Promise<void>;
      }
    | undefined;
  private disposed = false;

  public constructor(
    private readonly component = 'refresh',
    private readonly trace?: RefreshTraceSink,
  ) {}

  public run(
    contextKey: string,
    load: () => Promise<T>,
    onValue: (value: T) => unknown,
    onError: (error: unknown) => void,
    invalidateIfRunning = false,
    trigger = 'request',
  ): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    if (this.active?.contextKey === contextKey && this.active.running) {
      const request = this.active;
      if (invalidateIfRunning) {
        request.invalidated = true;
        request.invalidationGeneration += 1;
        this.writeTrace(request, 'invalidated', trigger);
      } else {
        this.writeTrace(request, 'coalesced', trigger);
      }
      return request.promise;
    }

    const request = {
      contextKey,
      requestId: ++this.nextRequestId,
      contextGeneration: ++this.generation,
      invalidationGeneration: 0,
      invalidated: false,
      running: true,
      promise: Promise.resolve(),
    };
    this.active = request;
    this.writeTrace(request, 'queued', trigger);
    request.promise = Promise.resolve()
      .then(() => this.loadUntilCurrent(request, load, onValue, onError, trigger))
      .finally(() => {
        if (this.active === request) {
          this.active = undefined;
        }
      });

    return request.promise;
  }

  public clear(): void {
    this.generation += 1;
    if (this.active) {
      this.writeTrace(this.active, 'cancelled', 'context-cleared', 'stale-context');
    }
    this.active = undefined;
  }

  public dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private async loadUntilCurrent(
    request: NonNullable<ContextualRefresh<T>['active']>,
    load: () => Promise<T>,
    onValue: (value: T) => unknown,
    onError: (error: unknown) => void,
    trigger: string,
  ): Promise<void> {
    let attempt = 0;

    while (this.isCurrent(request)) {
      request.invalidated = false;
      attempt += 1;
      const startedAt = Date.now();
      this.writeTrace(request, 'read-start', trigger, undefined, attempt);

      try {
        const value = await load();
        if (!this.isCurrent(request)) {
          this.writeTrace(request, 'read-discarded', trigger, 'stale-context', attempt, Date.now() - startedAt);
          request.running = false;
          return;
        }
        if (request.invalidated) {
          this.writeTrace(request, 'read-discarded', trigger, 'invalidated', attempt, Date.now() - startedAt);
          continue;
        }

        const changed = onValue(value);
        this.writeTrace(
          request,
          'read-complete',
          trigger,
          typeof changed === 'boolean' ? changed ? 'changed' : 'unchanged' : 'accepted',
          attempt,
          Date.now() - startedAt,
        );
      } catch (error) {
        if (!this.isCurrent(request)) {
          this.writeTrace(request, 'read-discarded', trigger, 'stale-context', attempt, Date.now() - startedAt);
          request.running = false;
          return;
        }
        if (request.invalidated) {
          this.writeTrace(request, 'read-discarded', trigger, 'invalidated', attempt, Date.now() - startedAt);
          continue;
        }

        onError(error);
        this.writeTrace(request, 'read-complete', trigger, 'error', attempt, Date.now() - startedAt);
      }

      if (request.invalidated) {
        this.writeTrace(request, 'read-discarded', trigger, 'invalidated-during-publish', attempt);
        continue;
      }

      this.writeTrace(request, 'settled', trigger, 'current', attempt);
      request.running = false;
      return;
    }

    request.running = false;
  }

  private isCurrent(request: NonNullable<ContextualRefresh<T>['active']>): boolean {
    return !this.disposed && this.active === request;
  }

  private writeTrace(
    request: NonNullable<ContextualRefresh<T>['active']>,
    event: string,
    trigger: string,
    outcome?: string,
    attempt?: number,
    durationMs?: number,
  ): void {
    this.trace?.({
      component: this.component,
      event,
      requestId: request.requestId,
      contextId: refreshContextId(request.contextKey),
      contextGeneration: request.contextGeneration,
      invalidationGeneration: request.invalidationGeneration,
      attempt,
      trigger,
      outcome,
      durationMs,
    });
  }
}
