/**
 * templates.js — load prompt templates with {{variable}} substitution.
 *
 * The classification prompts are FILES YOU EDIT, not strings in our code.
 * Sostenuto's prompts define structure (output schema, calibration rules);
 * your edits define voice (who the companion is, what matters in your
 * relationship). See templates/README in the repo root.
 */

import { readFileSync } from "fs";

/**
 * Load a template file and substitute {{vars}}.
 * Unknown {{placeholders}} are left intact (so docs can show them).
 */
export function loadTemplate(path, vars = {}) {
  let text = readFileSync(path, "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${key}}}`, String(value ?? ""));
  }
  return text;
}
