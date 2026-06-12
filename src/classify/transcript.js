/**
 * transcript.js — turn formatting for the classifier.
 *
 * Input is surface-agnostic: an array of turns
 *   { role: 'user'|'assistant', content: string, thinking?: string, timestamp?: string }
 * Surface adapters (a chat app, a CLI hook, an importer) produce turns
 * however they like; this module only renders them.
 *
 * Two details matter and are deliberate:
 *
 * 1. [thinking] blocks. When the model's reasoning is available, it is
 *    included per assistant turn. Reasoning often contains perception that
 *    never survived into the rendered reply — the classifier mines it for
 *    diary entries and thinking-highlights.
 *
 * 2. Phase markers. Long transcripts get explicit EARLY/MIDDLE/LATE
 *    markers. Without them, classifier LLMs reliably collapse a session's
 *    arc into its final emotional peak and lose the middle — which is
 *    usually where the texture lives.
 */

const PHASE_MIN_MESSAGES = 9;

export function formatTurn(t) {
  const lines = [`${t.role}: ${t.content}`];
  if (t.role === "assistant" && t.thinking && t.thinking.trim()) {
    lines.push(`[thinking]\n${t.thinking}\n[/thinking]`);
  }
  return lines.join("\n\n");
}

/**
 * Render a full transcript, phase-segmented when long enough.
 */
export function buildTranscript(turns) {
  if (!turns || turns.length === 0) return "";
  if (turns.length >= PHASE_MIN_MESSAGES) {
    const third = Math.floor(turns.length / 3);
    const early = turns.slice(0, third);
    const middle = turns.slice(third, turns.length - third);
    const late = turns.slice(turns.length - third);
    return [
      "=== EARLY PHASE ===",
      early.map(formatTurn).join("\n\n"),
      "=== MIDDLE PHASE ===",
      middle.map(formatTurn).join("\n\n"),
      "=== LATE PHASE ===",
      late.map(formatTurn).join("\n\n"),
    ].join("\n\n");
  }
  return turns.map(formatTurn).join("\n\n");
}

/** Render only turns after a watermark (incremental classification). */
export function buildNewTurnsTranscript(turns, fromIndex) {
  return (turns || []).slice(fromIndex).map(formatTurn).join("\n\n");
}
