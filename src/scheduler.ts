import { AuthUnavailable, HttpError, WorkerError, errorCode, log } from './errors.js';
import { sleep } from './http.js';
import { interval, type Mode, type State, type SchedulerRepository, type Settings } from './admin/repository.js';

export interface ScheduledConsumer { cycle(): Promise<void>; close(): Promise<void> }
export class DynamicScheduler {
  private running = false;
  private terminating = false;
  private active = false;
  private mutations = 0;
  private rearm = false;
  private wake = new AbortController();
  private consumer: ScheduledConsumer | undefined;
  private actual: State = 'STOPPED';
  private failure: string | null = null;
  private saved: Settings | undefined;
  private next: number | null = null;
  private finished: number | null = null;
  private retryNotBefore = 0;
  private failures = 0;
  private requests: Promise<unknown> = Promise.resolve();
  constructor(readonly repository: SchedulerRepository, private readonly createConsumer: () => Promise<ScheduledConsumer>,
    private readonly maxFailures = 5, private readonly keepAliveOnError = false,
    private readonly clock: { now: () => number; wait: (ms: number, signal: AbortSignal) => Promise<unknown> } = { now: Date.now, wait: (ms, signal) => sleep(ms, signal) },
    private readonly report = log) {}

  status() {
    return { state: this.actual, cycle_in_progress: this.active, next_run_at: this.next === null ? null : new Date(this.next).toISOString(),
      error: this.failure, enabled: this.saved?.enabled ?? false, interval_ms: this.saved?.interval_ms ?? null,
      desired_state: this.saved?.desired_state ?? 'STOPPED', updated_at: this.saved?.updated_at ?? null, updated_by: this.saved?.updated_by ?? null };
  }
  private notify() { this.wake.abort(); this.wake = new AbortController(); }
  private async wait(ms = 1000) {
    const signal = this.wake.signal;
    try { await this.clock.wait(Math.max(1, Math.min(ms, 1000)), signal); }
    catch (error) { if (!signal.aborted) throw error; }
  }
  private async state(state: State, error?: string) {
    if (this.actual === state && this.failure === (error ?? null)) return;
    // Only called with STOPPED after consumer.close() has completed.
    await this.repository.state(state, error);
    this.actual = state; this.failure = error ?? null;
    if (state === 'PAUSED') this.report('scheduler_paused');
    if (state === 'RUNNING') this.report('scheduler_resumed');
  }
  request(actor: string, patch: { interval_ms?: number; mode?: Mode }) {
    if (this.terminating) return Promise.reject(new WorkerError('SCHEDULER_SHUTTING_DOWN'));
    if (patch.interval_ms !== undefined) interval(patch.interval_ms);
    // Close admission synchronously, before the persistence await.
    this.mutations++;
    const request = this.requests.then(async () => {
      await this.repository.change(actor, patch);
      this.saved = await this.repository.settings();
      if (patch.mode === 'RUNNING') this.rearm = true;
      if (patch.mode === 'STOPPED') await this.state('STOPPING');
      if (patch.mode === 'PAUSED' && this.active) await this.state('PAUSING');
      if (patch.mode !== undefined && patch.mode !== 'RUNNING') this.next = null;
    });
    this.requests = request.catch(() => {});
    return request.finally(() => { this.mutations--; this.notify(); });
  }
  shutdown() { this.terminating = true; this.notify(); }
  private async release() { if (this.consumer) { await this.consumer.close(); this.consumer = undefined; } }
  async run() {
    if (this.running) throw new WorkerError('SCHEDULER_ALREADY_ACTIVE');
    this.running = true;
    let lastInterval: number | undefined;
    try {
      this.saved = await this.repository.settings();
      if (this.saved.runtime_state === 'ERROR') { this.actual = 'ERROR'; this.failure = this.saved.last_error; }
      if (this.actual === 'ERROR' && !this.keepAliveOnError) throw new WorkerError(this.failure ?? 'RECOVERY_REQUIRED');
      this.report('scheduler_started', { interval_ms: this.saved.interval_ms, enabled: this.saved.enabled });
      while (!this.terminating) {
        try {
          if (this.mutations) { await this.wait(); continue; }
          this.saved = await this.repository.settings();
          if (this.mutations || this.terminating) continue;
          const { desired_state: mode, interval_ms: ms } = this.saved;
          if (lastInterval !== undefined && lastInterval !== ms) this.report('scheduler_interval_changed', { interval_ms: ms });
          lastInterval = ms;
          if (this.actual === 'ERROR' && !this.rearm) { await this.wait(); continue; }
          if (this.rearm) {
            this.rearm = false; this.failures = 0;
            if (this.actual === 'ERROR') { await this.release(); await this.state('STOPPED'); }
          }
          if (mode === 'STOPPED') { await this.release(); await this.state('STOPPED'); this.next = null; await this.wait(); continue; }
          if (mode === 'PAUSED') { await this.state('PAUSED'); this.next = null; await this.wait(); continue; }
          if (!this.consumer) {
            this.consumer = await this.createConsumer(); // validates source lock, pending reads and configuration
            continue; // re-read settings after async preflight, before any consuming request
          }
          await this.state('RUNNING');
          if (this.mutations || this.terminating) continue;
          const due = Math.max(this.finished === null ? this.clock.now() : this.finished + ms, this.retryNotBefore);
          if (this.next !== due) {
            this.next = due;
            this.report('scheduler_next_run', { next_run_at: new Date(due).toISOString(), interval_ms: ms });
          }
          if (due > this.clock.now()) { await this.wait(due - this.clock.now()); continue; }
          // No await between admission and starting the only consumer cycle.
          this.active = true; this.next = null;
          try {
            await this.consumer.cycle(); this.failures = 0; this.retryNotBefore = 0;
          } catch (error) {
            if (!(error instanceof WorkerError) || !error.retryable || ++this.failures >= this.maxFailures) throw error;
            const retryAfter = error instanceof HttpError ? error.retryAfterMs : error instanceof AuthUnavailable && error.original instanceof HttpError ? error.original.retryAfterMs : 0;
            const delay = Math.max(ms, Math.min(60000, 1000 * 2 ** this.failures), retryAfter);
            this.retryNotBefore = this.clock.now() + delay;
            this.report('poll_retry', { error: errorCode(error), retry_ms: delay });
          } finally { this.active = false; this.finished = this.clock.now(); }
        } catch (error) {
          this.next = null; this.actual = 'ERROR'; this.failure = errorCode(error);
          await this.release().catch(() => {});
          await this.repository.state('ERROR', this.failure).catch(() => {});
          this.report('scheduler_error', { error: this.failure });
          if (!this.keepAliveOnError) throw error;
          await this.wait();
        }
      }
      await this.requests;
      await this.repository.change('system:shutdown', { mode: 'STOPPED' });
      await this.state('STOPPING'); await this.release(); await this.state('STOPPED');
    } finally { try { await this.release(); } finally { this.running = false; } }
  }
}
