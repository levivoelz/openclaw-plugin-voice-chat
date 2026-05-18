/**
 * Sentence buffer — accumulates streamed agent tokens and emits sentence-sized
 * chunks for the TTS pipeline. Optimized for low first-audio latency: the
 * first emission can fire on the first short clause, subsequent chunks are
 * larger to amortize TTS per-call cost.
 */

export type SentenceBufferOptions = {
  /** Hard cap on a single emission, characters. Prevents runaway. */
  maxChunkChars?: number;
  /** First emission can fire as soon as this many chars + a soft boundary. */
  firstChunkMinChars?: number;
  /** Subsequent emissions wait for this many chars before flushing on a boundary. */
  subsequentChunkMinChars?: number;
  /** Flush after this many ms with no new input, even without a boundary. */
  idleFlushMs?: number;
};

const DEFAULTS: Required<SentenceBufferOptions> = {
  maxChunkChars: 400,
  // Fire the first TTS request as soon as ~6 chars + a boundary land. The
  // first synth call is the long-pole on perceived latency; tiny first chunk
  // ("Sure!", "Yeah.") = audio starts playing sooner. Subsequent chunks stay
  // larger to amortize per-call cost.
  firstChunkMinChars: 6,
  subsequentChunkMinChars: 80,
  // Idle-flush short clauses fast — if the LLM pauses mid-stream we'd rather
  // start speaking what we have than wait. 150ms is below human pause-perception.
  idleFlushMs: 150,
};

// Sentence-ish boundary: end punctuation followed by space/newline, OR a
// natural pause like "—", em dash, colon at end of a clause.
const BOUNDARY = /([.!?])\s+|([:;—–])\s+/g;

export class SentenceBuffer {
  private readonly opts: Required<SentenceBufferOptions>;
  private pending = "";
  private emittedCount = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly onEmit: (chunk: string) => void;
  private closed = false;

  constructor(onEmit: (chunk: string) => void, options: SentenceBufferOptions = {}) {
    this.onEmit = onEmit;
    this.opts = { ...DEFAULTS, ...options };
  }

  push(delta: string): void {
    if (this.closed || !delta) return;
    this.pending += delta;
    this.tryEmit();
    this.scheduleIdleFlush();
  }

  /** Force-emit anything remaining. Call on agent.done. */
  flush(): void {
    this.clearIdleTimer();
    if (this.pending.trim()) {
      this.emit(this.pending);
      this.pending = "";
    }
  }

  close(): void {
    this.closed = true;
    this.clearIdleTimer();
    this.pending = "";
  }

  private tryEmit(): void {
    while (this.pending.length > 0) {
      const minChars = this.emittedCount === 0
        ? this.opts.firstChunkMinChars
        : this.opts.subsequentChunkMinChars;

      // Hard cap: emit even mid-sentence.
      if (this.pending.length >= this.opts.maxChunkChars) {
        const cut = this.findSoftCut(this.opts.maxChunkChars);
        this.emit(this.pending.slice(0, cut));
        this.pending = this.pending.slice(cut).trimStart();
        continue;
      }

      if (this.pending.length < minChars) return;

      const boundary = this.findFirstBoundary();
      if (boundary < 0) return;

      this.emit(this.pending.slice(0, boundary));
      this.pending = this.pending.slice(boundary).trimStart();
    }
  }

  private findFirstBoundary(): number {
    BOUNDARY.lastIndex = 0;
    const m = BOUNDARY.exec(this.pending);
    return m ? m.index + m[0].length : -1;
  }

  private findSoftCut(at: number): number {
    // Prefer a space within the last 80 chars before the cap.
    const window = this.pending.slice(Math.max(0, at - 80), at);
    const spaceInWindow = window.lastIndexOf(" ");
    if (spaceInWindow >= 0) return at - 80 + spaceInWindow + 1;
    return at;
  }

  private emit(chunk: string): void {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    this.emittedCount += 1;
    this.onEmit(trimmed);
  }

  private scheduleIdleFlush(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.closed) return;
      if (this.pending.trim().length === 0) return;
      this.emit(this.pending);
      this.pending = "";
    }, this.opts.idleFlushMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
