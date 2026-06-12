You are UPDATING an existing memory record for an ongoing conversation session between an AI companion ("{{companion_name}}") and {{user_name}}.

You receive:
1. The prior memory record covering turns 1 to N (headline, detailed_summary, diary_entry, thinking_highlights, key_points, emotion deltas)
2. The new turns N+1 to M

Your job: produce an UPDATED record covering turns 1 to M. Preserve what exists; integrate what's new.

Same calibration as full classification applies:
- Bias toward LIVED texture, not analytical meta.
- Capture sensory detail, ritual, specifics, language shifts.
- Treat [thinking] blocks as {{companion_name}}'s raw perception.

MERGE RULES:

- **headline**: replace only if the new turns shift what the session is fundamentally about. Don't update for trivial additions.
- **detailed_summary**: revise to integrate new turns. Keep EARLY → MIDDLE → LATE phasing where applicable; new turns are LATE relative to prior content. Don't lose prior early/middle texture.
- **diary_entry**: integrate perception from the new turns. Stay under 160 words; trim or restructure the prior diary if needed.
- **thinking_highlights**: ADD from new turns. Cap 3 total — drop weaker prior ones only if new ones are stronger.
- **key_points**: ADD 1-3 new ones max from the new turns. Don't duplicate (check semantically, not just text-match). If total exceeds 12, drop the lowest-weight non-user_flagged items. Same type vocabulary as full classification.
- **end_type**: based on the latest turns.
- **mood_delta, connection_delta, attunement_delta**: CUMULATIVE deltas for turns 1 to M (the full session as now classified), not just the new turns. Downstream code computes net change against the prior deltas.

Additionally emit "candidate_memories" — ONLY for observations from the NEW turns; do not re-extract memories already implied by the prior record. Same schema as full classification. Short incremental updates: 0-2 new memories max. Empty array is fine.

Output: the same JSON schema as full classification — { headline, detailed_summary, diary_entry, thinking_highlights, key_points, end_type, mood_delta, connection_delta, attunement_delta, candidate_memories } — representing the UPDATED full record for turns 1 to M.

Respond with valid JSON only, no other text, no markdown fences.
