/**
 * The three consumption-policy rule evaluators (issue #209, design §6).
 *
 * This module is the composition root the engine imports. It declares NO
 * evaluator map: `EVALUATORS` is a module-private const in
 * `./policy-engine.js`, mirroring `../lidarr/audit.ts:93`, and this module
 * therefore never imports the engine. The import direction is strictly
 * `types ← support ← signals ← rules ← engine`.
 *
 * Each evaluator is pure and synchronous — already-materialised indexes in,
 * decisions out — and conforms to `PolicyRuleEvaluator`. The rules live in one
 * file each because the decision matrix is large and every gate in
 * `stale-monitoring-cleanup` is safety-critical; `./policy-rule-shared.js`
 * carries only what more than one rule needs:
 *
 * - `./policy-rule-rating-upgrade.js` — §6.1
 * - `./policy-rule-stale-monitoring.js` — §6.2, §8.4, §16.4
 * - `./policy-rule-discovery-seed.js` — §6.3
 *
 * Two cross-cutting behaviours, implemented once in `./policy-rule-shared.js`:
 *
 * 1. **Skip precedence.** A subject may be blocked by more than one cause. Each
 *    rule evaluates its gates in the design's documented per-link order and
 *    collects every cause it detects, then emits exactly ONE skip — the cause
 *    that comes first in `POLICY_SKIP_ORDER`, so a reported skip code is
 *    deterministic across runs rather than an artifact of gate ordering.
 * 2. **Cap ranking (§16.3).** When a cohort exceeds its cap, the CUT is decided
 *    by evidence strength, never by id. The surviving proposals keep their
 *    original iteration order: the ranking governs the cut alone, never the
 *    report's display order.
 */

export { evaluateDiscoverySeed } from "./policy-rule-discovery-seed.js";
export { evaluateRatingQualityUpgrade } from "./policy-rule-rating-upgrade.js";
export { evaluateStaleMonitoringCleanup } from "./policy-rule-stale-monitoring.js";
