# Recommendations — Lidarr Policy Plan

## Executive Summary

Implement issue #311 as a thin orchestration layer: run the existing policy evaluator once, project
every selected proposal through a pure typed bridge, and optionally call the two shipped Lidarr plan
producers. The public contract should be `--mode recommend|plan`, defaulting to `recommend`.
Recommend mode is read-only and may report refusals successfully; plan mode first validates the
entire selected scope and writes nothing unless every selected proposal is projectable.

Preserve the existing trust boundaries. `policy evaluate` remains write-free, `policy plan` may only
seal unchanged `rfmedia.lidarr-plan.v3` artifacts, and `lidarr apply` remains a separate explicit
command. Do not execute `handoff.argv`, introduce a plan schema or operation kind, add an output-path
override, or duplicate producer logic.

## Implementation Recommendations

### Recommended Approach

1. Add `policy plan` beside `policy evaluate` in the existing nested command. Reuse evaluation's
   library, rule, proposal-cap, connection, output, explanation, and verbosity conventions. Validate
   `--mode` and existing selection values before the lazy action import. Do not add `--yes`,
   `--dry-run`, `--apply`, or `--plan-file`.
2. Run `executeLidarrPolicyEvaluate` exactly once and retain its frozen report verbatim in a
   versioned policy-plan result. Do not add plan imports or writes to the evaluate action.
3. Add a pure projector over `report.proposals`. Cross-check each proposal key, rule descriptor,
   handoff producer, authoritative subject identity, and producer-specific target. Route typed data,
   never the inert argv:
   - `artist-profile-assignment`: positive Lidarr artist ID plus positive numeric
     `after["qualityProfileId"]`; bind the producer using the numeric ID as a string.
   - `artist-monitoring`: positive Lidarr artist ID plus boolean `after["monitored"]`.
   - `discovery`: explicit `unsupported-producer` refusal; never convert it to artist-add.
4. Group by producer and desired scalar, deduplicate and sort artist IDs, retain every contributing
   decision key, and reject incompatible intents for one artist. Set `maxBatch` to exact cohort size
   while preserving existing hard caps. Assert total accounting: every unique selected proposal key
   appears exactly once in a cohort or refusal.
5. Recommend mode stops after projection and calls no producer. Plan mode performs a global preflight
   over the complete selected scope; any refusal or invariant failure, including discovery, creates
   zero artifacts and exits nonzero. A clean no-proposal/converged scope succeeds with zero artifacts.
6. Seal sequentially in `POLICY_PRODUCER_IDS` order: `artist-profile-assignment`, then
   `artist-monitoring`. Existing producers must re-read fresh Lidarr state and own v3 construction,
   checksum calculation, safe paths, private atomic writes, and overwrite refusal.
7. Return a frozen typed union with status such as `reviewed`, `no-changes`, `refused`, `sealed`,
   `partial`, or `failed`; include the evaluation, total counts, cohorts, refusals, and ordered
   outcomes. Each outcome correlates decision keys with path, operation, plan ID, checksum, and
   producer counts. Keep policy provenance outside the strict v3 artifacts.
8. If a later producer unexpectedly fails, retain and disclose every earlier sealed artifact in a
   typed `partial` result, render one complete machine document, and exit nonzero. Never delete an
   earlier artifact as rollback. Suggested next steps are separate apply commands pinned with both
   `--expected-plan-id` and `--expected-plan-checksum`, without implied `--yes`.

## Decision Resolutions

| Decision                        | Resolution                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Safety syntax                   | `--mode recommend` or `--mode plan`; omission means `recommend`; there is no apply rung.                                                                                 |
| Plan refusal semantics          | Global fail-closed preflight. Any unprojectable selected proposal blocks all writes.                                                                                     |
| Recommend refusal semantics     | Report expected refusals as successful structured review data. Malformed internal contracts remain failures.                                                             |
| Evaluation degradation          | Do not gate on aggregate status alone. Inspect selected rule outcomes; a skipped/unsafe selected rule blocks plan mode, while unrelated unselected degradation does not. |
| Same artist in multiple cohorts | Conservatively refuse all of that artist's proposals in v1 unless an explicit compatibility rule exists.                                                                 |
| Ordering                        | Producer declaration order, then desired scalar, then ascending artist ID.                                                                                               |
| Output path                     | Use producer-owned private default paths only; no override in v1.                                                                                                        |
| Multiple artifacts              | They are independent sealed evidence, not a transaction; partial runtime completion is explicit.                                                                         |
| Selection                       | Reuse `--rule` and `--max-proposals`. Defer a proposal-key selector until there is demonstrated need; all emitted proposals in the selected rules are selected.          |
| Machine output                  | One stable JSON/YAML/CSV result with complete counts and evidence; human diagnostics remain on stderr.                                                                   |

## Scope and Phasing

Phase 1 establishes contracts and the pure bridge: add mode/result/refusal/cohort types and exhaustive
projection with deterministic ordering and total-accounting assertions. Prefer a focused zero-value-
import policy-plan type module if the existing policy type file would become unwieldy.

Phase 2 adds the thin action and command/presenter integration. Reuse dependency injection and the
existing producer actions; do not acquire a wrapper scheduler slot because composed actions already
use the `local-only` lane. Preserve raw Plex/Lidarr overrides for credential redaction.

Phase 3 completes compatibility: update Bash, Zsh, and Fish templates together; update the
consumption-policy feature guide, CLI README/quick reference where it lists policy verbs, plan/apply
cross-links, `ROADMAP.md`, and stale archive wording that still requires manual transcription. Run
typecheck, focused tests, existing evaluate/producer tests, architecture checks, completion parity,
and markdown validation.

## Risk Assessment

- **Critical — incomplete authorization:** silently filtered proposals can produce a valid-looking
  artifact for the wrong subset.
- **Critical — boundary collapse:** executing argv, adding apply, or copying evaluation `before`
  state into artifacts turns evidence into mutation authority.
- **High — partial filesystem outcome:** producer two can fail after producer one seals despite a
  complete logical preflight.
- **High — state drift:** Lidarr state can change between evaluation and sealing.
- **Medium — interface drift:** Commander and three handwritten completion templates can disagree.
- **Medium — disclosure:** reports and errors contain operational metadata and credential-bearing
  inputs.

### Risk Mitigations

- Enforce complete preflight and total proposal accounting before the first producer call.
- Use exhaustive discriminated routing and runtime narrowing; fail hard on malformed or unknown
  producer contracts.
- Reuse fresh-state producers and the secure v3 writer unchanged; bind profiles by numeric ID.
- Capture each outcome immediately, model partial failure explicitly, and never simulate rollback.
- Keep one redacted result envelope across formats and pass both Plex and Lidarr secrets to existing
  sanitization.
- Lock command, option, value, and routing parity across all three shells.

## Critical Test Matrix

| Seam            | Minimum contract coverage                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure projection | Both supported producers; discovery refusal; malformed identity/target/descriptor hard failure; cross-intent refusal; stable sorting/deduplication; exact total accounting.                   |
| Action          | Recommend calls no producer; plan globally blocks on any refusal; clean plan calls producers sequentially with exact target and cohort-sized cap; later failure preserves the first artifact. |
| Command/output  | Default and explicit mode; invalid input before lazy load; no-proposal success; redacted credentials; one parseable machine document; checksum-pinned apply hint.                             |
| Regression      | `policy evaluate` remains write-free; existing producer, v3 writer, apply, architecture, and scheduler contracts stay green.                                                                  |
| Completion/docs | Bash/Zsh/Fish child, option, value, and Bash-routing parity; docs and ROADMAP describe recommend -> plan -> separate apply accurately.                                                        |

Avoid duplicating checksum, storage-hardening, apply, or broad fake-service end-to-end coverage already
owned by existing suites.

## Deferred Enhancements

- Proposal-key inclusion/exclusion selectors and rule-specific threshold overrides.
- Output directory/prefix overrides, aggregate multi-plan artifacts, or transactional sealing.
- Discovery execution, artist-add projection, producer plugins, or new operation kinds.
- Apply/auto-apply, confirmation shortcuts, policy provenance inside v3 plans, or checksum signing.
- Same-artist cross-producer compatibility rules, shared live-state caching, and broader cancellation.
- Overrides/disputes, recency signals, new persistence, and refactoring `sync-ratings` into a generic
  framework before proven duplication exists.
