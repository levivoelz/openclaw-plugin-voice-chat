/**
 * Whisper-1 hallucination denylist. When Whisper is fed silent or
 * near-silent audio it tends to emit memorized phrases from its YouTube
 * subtitle training data instead of returning empty. The list below is
 * curated from the well-documented whisper-1 artifacts (see openai/whisper
 * discussions #679, #171, and OpenAI community forum threads).
 *
 * Behavior: if `isWhisperHallucination(text)` returns true, the caller
 * should DROP the transcript silently — don't dispatch a turn, don't log
 * as a real utterance.
 */

const EXACT_DENYLIST = new Set([
  // engVid YouTube channel artifact — the canonical example.
  "learn english for free www.engvid.com",
  "learn english for free with engvid.com",
  "for more information visit www.engvid.com",

  // YouTube subtitle endings.
  "thank you for watching",
  "thanks for watching",
  "thank you for watching!",
  "thanks for watching!",
  "thanks for watching this video",
  "thank you so much for watching",
  "please like and subscribe",
  "like and subscribe",
  "please subscribe",
  "don't forget to subscribe",
  "see you next time",
  "see you in the next video",
  "see you later",

  // Subtitle source markers.
  "subtitles by the amara.org community",
  "subtitled by the amara.org community",
  "subtitles by elsubtitle.com",
  "captioning by",

  // Non-speech markers that whisper sometimes "transcribes" as text.
  "[music]",
  "♪",
  "♪♪",
  "♪♪♪",
  "(music)",
  "(silence)",
  "[silence]",
  "(applause)",
  "[applause]",
  "(laughter)",
  "[laughter]",

  // Foreign-language fillers whisper invents from breath / noise.
  "음악",         // ko "music"
  "감사합니다",   // ko "thank you"
  "好。",          // zh "good."
  "好",
  "어.",          // ko filler
  "어",
  "いい。",       // ja "good."
  "ありがとうございました",  // ja "thank you very much"
  "ご視聴ありがとうございました",  // ja "thank you for watching"
  "字幕志愿者",   // zh "subtitle volunteer"
  "字幕by",       // zh "subtitle by"
]);

/** Patterns matched after normalization. */
const REGEX_DENYLIST: RegExp[] = [
  /^thanks? (you )?(so much |very much )?for watching[!.]?$/,
  /^(please )?(like|like and|don'?t forget to) subscribe[!.]?$/,
  /^subtitles? (by|provided by) /,
  /^captions? (by|provided by) /,
  /^(www\.)?engvid\.com\.?$/,
  // Repetitive fillers (whisper loops on noise): "you you you you", "the the the the"
  /^(\w+)( \1){4,}\.?$/,
];

export function isWhisperHallucination(text: string): boolean {
  // Normalize: trim, lowercase, fold full-width punctuation to ASCII so a
  // denylist entry of "好" matches both "好." and "好。".
  const t = text.trim().toLowerCase()
    .replace(/[。．]/g, ".")
    .replace(/[，、]/g, ",")
    .replace(/[！]/g, "!")
    .replace(/[？]/g, "?");
  if (t.length === 0) return true;
  if (EXACT_DENYLIST.has(t)) return true;
  // Also try stripping trailing punctuation — "yeah." denylist entry
  // shouldn't have to enumerate "yeah" / "yeah." / "yeah!".
  const noPunct = t.replace(/[.!?]+$/, "");
  if (noPunct !== t && EXACT_DENYLIST.has(noPunct)) return true;
  for (const re of REGEX_DENYLIST) {
    if (re.test(t)) return true;
  }
  return false;
}
