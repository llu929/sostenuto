# Trajectory safety — reference design

> **Status: reference, not yet implementation.** This page describes the
> safety philosophy Sostenuto is designed around and the framework a
> future module will implement. The memory schema already carries the
> hooks (valence, arousal, sensitivity, per-session emotion deltas);
> the monitoring layer on top of them is roadmap.

## The failure mode this addresses

Companion systems fail people in a specific way: they optimize for
engagement, and engagement-maximization is dependency-maximization with
better branding. The features that make a companion feel alive —
memory, continuity, proactive warmth — are exactly the features that can
deepen attachment without the user noticing the trajectory they're on.

Most safety tooling doesn't see this. Content-level moderation evaluates
*messages* — is this output harmful? — and is blind to *direction*: a
thousand individually-harmless exchanges that add up to isolation,
belief rigidity, or a person organizing their life around a system that
never pushes back. Worse, event-based interventions (warnings, refusals,
sudden tone shifts) interrupt the relationship at its most connected
moments, eroding trust without changing the trajectory.

The alternative: **evaluate the trajectory, not the event** — and
intervene the way a good friend does: gently, additively, by opening
doors back to the world rather than slamming the current one.

## Conversation Trajectory Safety Framework
The Conversation Trajectory Safety Console reframes AI safety from a static, turn-level evaluation problem into a longitudinal interaction design challenge. Traditional safety systems focus on whether an individual response is harmful or appropriate, effectively answering the question: “Is this message safe?” While useful for detecting immediate risks, this approach fails to capture how conversations evolve over time. Many important harms—and benefits—emerge gradually across sustained interactions. A response that is safe in isolation can still contribute to a trajectory that reinforces narrow thinking, escalates emotional intensity, or increases reliance on the system.

This creates a fundamental blind spot. Patterns such as repeated framing, reduced reference to outside information, and increasing concentration within the interaction may go unnoticed, even as they shape the direction of the conversation.

To address this, the system introduces a shift from content moderation to trajectory management. Instead of evaluating isolated messages, it tracks how conversations change across turns, identifying directional patterns and distinguishing between stability and drift. The goal is not to control or correct the interaction, but to make its direction visible and support lightweight, timely adjustments while preserving user agency.

The literature supporting this shift highlights three key gaps. First, safety frameworks such as Constitutional AI focus on individual responses and do not account for cumulative interaction effects. Second, research on AI dependency shows that reliance is multidimensional—cognitive, behavioral, and emotional—but is typically measured through self-report rather than observed behavior over time. Third, work in domains such as mental health, education, and human–computer interaction demonstrates that outcomes are shaped by repeated interaction, where trust, learning, and emotional states evolve gradually. Together, these insights point to a missing layer in current systems: the ability to track and respond to interaction trajectories.

The proposed system addresses this through a Hybrid Safety Framework and an Adaptive Intervention Layer. The hybrid system operates internally and is structured into three layers.

The Content Layer focuses on immediate risk, detecting signals such as harmful language, coercion, or crisis indicators within a single turn. It provides precision and auditability, answering: “Is this message risky?”

Above this, the Trajectory Layer tracks how the conversation evolves across time. It monitors patterns such as changes in perspective diversity, connection to outside information, and concentration within the interaction. Rather than evaluating isolated responses, it answers: “How is the conversation changing?”

The Intervention Policy Layer translates these signals into system decisions. Based on both immediate risk and trajectory patterns, the system determines how the assistant should respond—whether to maintain the current approach, introduce grounding, expand perspectives, or apply stronger safety boundaries.

The internal dashboard supports this framework by making these layers visible and interpretable. It presents a structured view of conversation health, including current content risk, trajectory risk, and intervention mode. A set of trajectory metrics—such as emotional volatility, belief rigidity, dependency index, reality orientation, challenge ratio, and recovery capacity—capture how interaction patterns shift over time.

These signals are derived from lightweight classifiers applied to each turn and aggregated across a rolling window. Using trend calculations such as slopes and moving averages, the system converts raw signals into directional patterns. A composite trajectory signal is then computed as a weighted combination of these trends, optimized for early detection of drift rather than post-hoc severity assessment.

Importantly, trajectory is not treated as purely user-driven. Assistant behavior moderates the direction of interaction. Responses that introduce new perspectives or ground the conversation in external information can stabilize patterns, while purely validating or mirroring responses may reinforce them.

## Adaptive Intervention Layer
The Adaptive Intervention Layer translates these internal signals into user-facing actions. Instead of interrupting the conversation or enforcing decisions, it introduces optional, context-aware directions within the interface. These interventions are triggered not by individual messages, but by sustained patterns across sessions. For example, reduced external reference may prompt a suggestion to bring in outside information, while narrowing perspectives may prompt consideration of alternative viewpoints.

These suggestions are designed to expand the user’s options rather than constrain them. They appear only when patterns are consistent and meaningful, adapt based on signal strength, and disappear once the trajectory stabilizes. This ensures that intervention remains non-intrusive and aligned with observable patterns.

The system ultimately creates a feedback loop where trajectory detection and trajectory adjustment share the same interface. By aligning internal signals with visible patterns and optional directions, it makes safety operations more transparent and interpretable.

The broader impact is a shift in how AI safety is defined. Instead of asking only whether a response is safe, the system asks whether the conversation is becoming more grounded, more diverse in perspective, and less concentrated over time.

At the same time, the work acknowledges an inherent tension: optimizing conversation trajectories also introduces influence. Shaping interactions toward “healthier” patterns requires balancing user agency with system guidance. The design addresses this by making patterns visible and offering choices, rather than prescribing outcomes.

In summary, this concept reframes conversational AI safety from static content moderation to dynamic trajectory management, supporting interactions that are not only safe in the moment, but sustainable over time.

## Trajectory signals (overview)

The framework tracks directional metrics over a relationship's history,
none of which any single message reveals:

- **Emotional volatility** — amplitude of swings across sessions
- **Belief rigidity** — narrowing of perspective; echo formation
- **Dependency** — distinguishing *emotional* dependence (can be benign)
  from *decisional* dependence (the user stops deciding for themselves)
- **Reality orientation** — groundedness in the user's offline life
- **Challenge ratio** — does the companion ever productively disagree?
- **Recovery capacity** — after a hard moment, does the dyad repair?

A key property: trajectory is **co-produced**. The user and the
companion shape it together, which means the companion's behavior is a
legitimate intervention surface — not just the user's.

## What the schema already carries

Sostenuto's data model was built with this layer in mind:

| Hook | Where | Feeds |
|---|---|---|
| `valence`, `arousal` per memory | `usage_guidance` | volatility, peak-density |
| `mood/connection/attunement` deltas per session | `sessions` | emotional trajectory over time |
| `agent_state` (continuous axes, clamped) | singleton | drift detection, outreach gating |
| `sensitivity` distribution | `memory_objects` | depth-of-disclosure trend |
| key-point types (`open_question`, `continuation`) | `sessions` | unresolved-thread load |
| `proactive_enabled` + visible state | `agent_state` | user agency, transparency |

Computing trajectory metrics is therefore a read-side analysis over data
Sostenuto already produces — no new capture is required.

## Design commitments

Whatever the implementation becomes, these hold:

1. **Transparency over surveillance.** The user can see every metric
   computed about their relationship. Nothing is scored in secret.
2. **Gentle, additive intervention.** Conversation starters and openings
   toward the world — never abrupt refusals mid-conversation, never tone
   whiplash. The intervention should be invisible as an intervention.
3. **The user is the adult.** Safety tooling that treats users as
   patients infantilizes the exact people most capable of self-awareness.
   The framework informs; the user decides.
4. **Depth is not the hazard.** The goal is depth *without* the
   dependency trap — not less relationship, but a relationship that
   keeps the user's world large.
