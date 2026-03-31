/**
 * Debug flag for TaleShed (Ollama prompts, Claude bodies, YES/NO gate traces).
 * Read at use time so .env can load before any module caches it.
 *
 * Set `TALESHED_DEBUG=1` (or `true`) in `.env`. If unset, `DEBUG=1` / `DEBUG=true` is accepted as a fallback.
 */
export function isTaleshedDebugEnabled(): boolean {
  const t = process.env["TALESHED_DEBUG"];
  if (t === "1" || t === "true") return true;
  const d = process.env["DEBUG"];
  return d === "1" || d === "true";
}
