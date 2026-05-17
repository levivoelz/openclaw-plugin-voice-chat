/**
 * Local voice-activity detector. Takes a continuous PCM16 mono stream and
 * emits complete utterance buffers on silence boundaries. Pure JS, no native
 * deps — RMS amplitude + state machine.
 *
 * Tunable but the defaults are calibrated for normal speech in a quiet-ish
 * room: ~3% RMS threshold, 150 ms of speech to enter SPEECH state, 800 ms of
 * silence to exit.
 */

export type VadOptions = {
  sampleRate: number;
  /** RMS threshold (0–1) for speech vs silence. Default 0.03. */
  threshold?: number;
  /** Ms of above-threshold audio before SPEECH state begins. Default 150. */
  speechOnsetMs?: number;
  /** Ms of below-threshold audio before SPEECH state ends. Default 800. */
  speechOffsetMs?: number;
  /** Drop utterances shorter than this (likely a cough/clack). Default 200. */
  minUtteranceMs?: number;
  /** Max utterance length — force-end after this. Default 30s. */
  maxUtteranceMs?: number;
  /** Ms of pre-roll audio to prepend (captures the word that triggered onset). Default 200. */
  preRollMs?: number;
};

const DEFAULTS: Required<VadOptions> = {
  sampleRate: 24000,
  threshold: 0.03,
  speechOnsetMs: 150,
  speechOffsetMs: 800,
  minUtteranceMs: 200,
  maxUtteranceMs: 30_000,
  preRollMs: 200,
};

type State = "idle" | "speech";

export class Vad {
  private readonly opts: Required<VadOptions>;
  private readonly bytesPerMs: number;
  private readonly onUtterance: (pcm: Buffer) => void;

  private state: State = "idle";
  private aboveStreak = 0;     // consecutive bytes above threshold
  private belowStreak = 0;     // consecutive bytes below threshold
  private utteranceBytes = 0;  // bytes collected in current SPEECH
  private chunks: Buffer[] = [];
  private preRoll: Buffer[] = [];

  constructor(onUtterance: (pcm: Buffer) => void, options: VadOptions) {
    this.opts = { ...DEFAULTS, ...options };
    this.bytesPerMs = (this.opts.sampleRate * 2) / 1000;  // 16-bit mono
    this.onUtterance = onUtterance;
  }

  push(pcm: Buffer): void {
    const rms = computeRms(pcm);
    const isSpeech = rms >= this.opts.threshold;
    const bytes = pcm.byteLength;

    if (this.state === "idle") {
      // Keep a rolling pre-roll buffer so the first detected word isn't clipped.
      this.preRoll.push(pcm);
      this.trimPreRoll();

      if (isSpeech) {
        this.aboveStreak += bytes;
        if (this.aboveStreak >= this.bytesPerMs * this.opts.speechOnsetMs) {
          // Transition into SPEECH; flush preroll into the utterance buffer.
          this.state = "speech";
          this.chunks = [...this.preRoll];
          this.utteranceBytes = this.chunks.reduce((n, c) => n + c.byteLength, 0);
          this.preRoll = [];
          this.belowStreak = 0;
        }
      } else {
        this.aboveStreak = 0;
      }
      return;
    }

    // SPEECH state — append audio and track silence streak.
    this.chunks.push(pcm);
    this.utteranceBytes += bytes;

    if (isSpeech) {
      this.belowStreak = 0;
    } else {
      this.belowStreak += bytes;
    }

    const silenceMs = this.belowStreak / this.bytesPerMs;
    const utteranceMs = this.utteranceBytes / this.bytesPerMs;

    if (silenceMs >= this.opts.speechOffsetMs || utteranceMs >= this.opts.maxUtteranceMs) {
      this.flush();
    }
  }

  /** Force-emit whatever's buffered, then reset. */
  flush(): void {
    if (this.state === "speech" && this.chunks.length > 0) {
      const utteranceMs = this.utteranceBytes / this.bytesPerMs;
      if (utteranceMs >= this.opts.minUtteranceMs) {
        this.onUtterance(Buffer.concat(this.chunks));
      }
    }
    this.state = "idle";
    this.aboveStreak = 0;
    this.belowStreak = 0;
    this.utteranceBytes = 0;
    this.chunks = [];
    this.preRoll = [];
  }

  private trimPreRoll(): void {
    const maxBytes = this.bytesPerMs * this.opts.preRollMs;
    let total = this.preRoll.reduce((n, c) => n + c.byteLength, 0);
    while (total > maxBytes && this.preRoll.length > 0) {
      const head = this.preRoll[0]!;
      if (total - head.byteLength >= maxBytes) {
        this.preRoll.shift();
        total -= head.byteLength;
      } else {
        // Keep the partial slice so we never undershoot the pre-roll window.
        const keep = head.byteLength - (total - maxBytes);
        this.preRoll[0] = head.subarray(head.byteLength - keep);
        total = maxBytes;
      }
    }
  }
}

function computeRms(pcm: Buffer): number {
  if (pcm.byteLength < 2) return 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i + 1 < pcm.byteLength; i += 2) {
    const sample = pcm.readInt16LE(i);
    sumSq += sample * sample;
    n++;
  }
  if (n === 0) return 0;
  return Math.sqrt(sumSq / n) / 32768;
}
