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
  /** Ms of below-threshold audio before SPEECH state ends. Default 250. */
  speechOffsetMs?: number;
  /** Drop utterances shorter than this. STT models hallucinate badly on
   *  sub-speech clips; 600 ms ≈ a single short word minimum. Default 600. */
  minUtteranceMs?: number;
  /** Max utterance length — force-end after this. Default 30s. */
  maxUtteranceMs?: number;
  /** Ms of pre-roll audio to prepend (captures the word that triggered onset). Default 200. */
  preRollMs?: number;
  /** Required peak RMS within the utterance to actually emit. STT models
   *  (whisper, parakeet) confabulate plausible English on near-silent audio;
   *  real speech peaks at ~0.1–0.3 RMS while room tone hovers near `threshold`.
   *  Setting this well above `threshold` filters utterances that triggered on
   *  a transient (a click, breath, HVAC) but were otherwise silence. Default 0.08. */
  minPeakRms?: number;
};

// Only emit the high-volume RMS dump when the env value is exactly "vad".
const VAD_TRACE = process.env["VOICE_CHAT_DEBUG"] === "vad";

const DEFAULTS: Required<VadOptions> = {
  sampleRate: 16000,
  // Lowered from 0.03 to admit quieter speech (laptop mics across rooms,
  // soft-spoken users). We rely on parakeet's per-token confidence
  // (minConfidence=0.85 default in the STT provider) as the hallucination
  // backstop — the model knows when it's guessing on ambient noise.
  threshold: 0.015,
  speechOnsetMs: 150,
  // 250ms is the LiveKit/Pipecat default for natural turn-taking; below
  // that you start cutting users off mid-pause. Above 400 the perceived
  // latency dominates the conversation feel.
  speechOffsetMs: 250,
  // Allow shorter utterances ("yeah", "no", "stop") through. Sub-400ms
  // is too short for sustained speech — that's the floor.
  minUtteranceMs: 400,
  maxUtteranceMs: 30_000,
  preRollMs: 200,
  // Lowered from 0.08 to match the lower entry threshold. The confidence
  // filter downstream catches the hallucinations this previously stopped.
  minPeakRms: 0.04,
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
  private peakRms = 0;         // max RMS observed during current SPEECH
  // When TTS is actively playing through speakers near the mic, raise the
  // VAD bar so the speaker bleed doesn't trigger phantom turns. The user
  // can still barge in by speaking louder than iris's playback level.
  // 3x multiplier was tuned against laptop-speaker bleed; closed-back
  // headphones make this a no-op since there's no loop.
  private sensitivityScale = 1;
  private static readonly DUCK_SCALE = 3;

  constructor(onUtterance: (pcm: Buffer) => void, options: VadOptions) {
    this.opts = { ...DEFAULTS, ...options };
    this.bytesPerMs = (this.opts.sampleRate * 2) / 1000;  // 16-bit mono
    this.onUtterance = onUtterance;
  }

  /**
   * Raise the effective threshold while local TTS playback is active so
   * the speaker→mic loop doesn't trigger a phantom utterance. User can
   * still barge in by speaking louder than the playback level.
   */
  setSpeakerActive(active: boolean): void {
    this.sensitivityScale = active ? Vad.DUCK_SCALE : 1;
  }

  push(pcm: Buffer): void {
    const rms = computeRms(pcm);
    const threshold = this.opts.threshold * this.sensitivityScale;
    const isSpeech = rms >= threshold;
    const bytes = pcm.byteLength;
    if (VAD_TRACE) {
      process.stderr.write(
        `[vad] rms=${rms.toFixed(3)} state=${this.state} aboveStreak=${this.aboveStreak} belowStreak=${this.belowStreak}\n`,
      );
    }

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
    if (rms > this.peakRms) this.peakRms = rms;

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
      const minPeak = this.opts.minPeakRms * this.sensitivityScale;
      // Two gates: minimum duration AND peak energy. The peak gate prevents
      // STT from being fed near-silent audio (room tone clearing `threshold`
      // for the onset window then mostly quiet), which causes confabulation.
      // During speaker-active mode, the peak gate is also raised so iris's
      // own playback bleeding through the mic doesn't qualify.
      if (utteranceMs >= this.opts.minUtteranceMs && this.peakRms >= minPeak) {
        this.onUtterance(Buffer.concat(this.chunks));
      }
    }
    this.reset();
  }

  private reset(): void {
    this.state = "idle";
    this.aboveStreak = 0;
    this.belowStreak = 0;
    this.utteranceBytes = 0;
    this.chunks = [];
    this.preRoll = [];
    this.peakRms = 0;
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
