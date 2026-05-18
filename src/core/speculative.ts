/**
 * Speculative-dispatch helpers extracted so they can be unit-tested without
 * pulling in the host OpenClaw SDK peer dependency.
 */

/**
 * Speculative-dispatch prefix matcher. We normalize both sides (lowercase,
 * collapse whitespace, strip trailing punctuation) so STT formatting jitter
 * — periods/commas the model adds or drops as it finalizes — doesn't cause
 * a false rejection. The bet: if every word of `prefix` appears at the
 * start of `full`, the speculative LLM answer is good enough.
 */
export function prefixMatches(prefix: string, full: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[.,!?;:]+/g, " ").replace(/\s+/g, " ").trim();
  const p = norm(prefix);
  const f = norm(full);
  if (!p) return false;
  if (p === f) return true;
  return f.startsWith(p + " ");
}
