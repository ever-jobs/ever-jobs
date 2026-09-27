import { PassThrough } from 'stream';

/** `Content-Type` of the NDJSON search stream (Spec 1721). */
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';

/**
 * Interval between progress/heartbeat lines while the fan-out runs
 * (Spec 1721 FR-2: "at most every ~10 s"). Also keeps idle-timeout proxies
 * from cutting a minutes-long catalogue-wide search.
 */
export const NDJSON_HEARTBEAT_MS = 10_000;

/**
 * Line-at-a-time NDJSON writer over a `PassThrough` (Spec 1721).
 *
 * - Every record is serialised on its own; the whole payload never exists as
 *   one string.
 * - {@link write} honours back-pressure: when the stream's buffer is full it
 *   waits for `drain` before resolving.
 * - Once the consumer is gone ({@link abort}, or the stream closes) every
 *   further write resolves `false` immediately, and a writer blocked on
 *   `drain` is released — a disconnected client can never park the producer
 *   forever.
 */
export class NdjsonWriter {
  readonly stream: PassThrough;
  private closed = false;
  private readonly waiters = new Set<() => void>();

  constructor(options: { highWaterMark?: number } = {}) {
    this.stream = new PassThrough(
      options.highWaterMark !== undefined ? { highWaterMark: options.highWaterMark } : {},
    );
    this.stream.once('close', () => this.markClosed());
    // A destroyed stream emits 'error' when written to; the producer already
    // treats `closed` as the stop signal, so swallow it rather than crash.
    this.stream.on('error', () => this.markClosed());
  }

  /** `true` once the consumer is gone or {@link end} was called. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Serialise `record` as one line and write it. Resolves `false` if closed. */
  write(record: unknown): Promise<boolean> {
    return this.writeLine(JSON.stringify(record));
  }

  /**
   * Write one `{"type":"job","data":…}` line. `data` is `JSON.stringify(job)`
   * verbatim — the exact bytes `res.json()` would emit for that job inside the
   * JSON response, including any field another feature adds.
   */
  writeJob(job: unknown): Promise<boolean> {
    return this.writeLine(`{"type":"job","data":${JSON.stringify(job)}}`);
  }

  /**
   * Fire-and-forget write for small control lines (heartbeats). Ignores
   * back-pressure: a ~80-byte line every 10 s cannot build a meaningful
   * buffer, and a heartbeat must never block.
   */
  writeNow(record: unknown): void {
    if (this.closed) return;
    this.stream.write(`${JSON.stringify(record)}\n`);
  }

  /** Finish the stream normally. Idempotent. */
  end(): void {
    if (this.closed) return;
    this.markClosed();
    this.stream.end();
  }

  /** The consumer went away: stop accepting writes and release waiters. */
  abort(): void {
    if (this.closed && this.stream.destroyed) return;
    this.markClosed();
    if (!this.stream.destroyed) this.stream.destroy();
  }

  private async writeLine(line: string): Promise<boolean> {
    if (this.closed) return false;
    if (this.stream.write(`${line}\n`)) return true;
    await new Promise<void>((resolve) => {
      const release = (): void => {
        this.stream.off('drain', release);
        this.waiters.delete(release);
        resolve();
      };
      this.waiters.add(release);
      this.stream.once('drain', release);
    });
    return !this.closed;
  }

  private markClosed(): void {
    if (this.closed) {
      this.releaseWaiters();
      return;
    }
    this.closed = true;
    this.releaseWaiters();
  }

  private releaseWaiters(): void {
    for (const release of [...this.waiters]) release();
  }
}
