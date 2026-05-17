/**
 * In-process provider registry. The plugin populates this on register() with
 * its built-in providers; the Control UI settings page reads it to populate
 * the dropdowns. Other plugins that register against the SDK's
 * RealtimeTranscriptionProviderPlugin / SpeechProviderPlugin appear in the
 * gateway-level registry — those are surfaced separately via the gateway API.
 */

import type { SttProviderDescriptor } from "./stt/types.js";
import type { TtsProviderDescriptor } from "./tts/types.js";

export class ProviderRegistry {
  private readonly stt = new Map<string, SttProviderDescriptor>();
  private readonly tts = new Map<string, TtsProviderDescriptor>();

  registerStt(p: SttProviderDescriptor): void {
    if (this.stt.has(p.id)) {
      throw new Error(`STT provider already registered: ${p.id}`);
    }
    this.stt.set(p.id, p);
  }

  registerTts(p: TtsProviderDescriptor): void {
    if (this.tts.has(p.id)) {
      throw new Error(`TTS provider already registered: ${p.id}`);
    }
    this.tts.set(p.id, p);
  }

  getStt(id: string): SttProviderDescriptor | undefined {
    return this.stt.get(id);
  }

  getTts(id: string): TtsProviderDescriptor | undefined {
    return this.tts.get(id);
  }

  listStt(): SttProviderDescriptor[] {
    return [...this.stt.values()];
  }

  listTts(): TtsProviderDescriptor[] {
    return [...this.tts.values()];
  }
}
