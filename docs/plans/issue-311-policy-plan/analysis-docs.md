# Documentation Analysis: issue-311-policy-plan

## Executive Summary

Issue #311 changes the operator journey, not the policy or plan contracts: `policy evaluate` remains
write-free, while the new `policy plan` leaf defaults to `--mode recommend` and seals unchanged v3
artifacts only under explicit `--mode plan`. Documentation must replace claims that manual ID
transcription is the only bridge, explain total proposal accounting and the global refusal gate, and
keep apply as a separate checksum-pinned step. The primary edits are the consumption-policy feature
guide, package README, active ROADMAP, and shell-completion guide; the plan/apply and ratings-sync
guides are required reference material but need only narrow cross-links or comparisons.

Do not rewrite the historical issue #209 design to pretend it specified #311. Its “three steps” text
is correct history and should remain as design provenance. Current user-facing docs and comments that
say the plan leaf is still future, however, must be updated with the shipped command contract.

## Must-Read Documents

| Source                                                                                 | Why implementation must read it                                                                                                      | Required documentation action                                                                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/issue-311-policy-plan/feature-spec.md`                                     | Approved v1 contract: `recommend\|plan`, global refusal gate, no apply, unchanged artifacts, result states, exact CLI options        | Treat as the source of truth for all new prose and examples                                                               |
| `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`                      | Full policy semantics, evidence limitations, proposal/handoff schemas, exit behavior, troubleshooting                                | Main edit: add `policy plan` use/options/output/refusal sections while preserving all `policy evaluate` guarantees        |
| `packages/rfmedia-cli/README.md` (`### Lidarr Consumption Policy`)                     | User-facing command synopsis and current manual handoff                                                                              | Add both policy leaves, invocation matrix, examples, option differences, and links                                        |
| `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` (`Review, Check, and Apply`) | Canonical v3 artifact, checksum, apply dry-run, authorization, drift, history, and resume semantics                                  | Cross-link; do not duplicate or alter the apply lifecycle                                                                 |
| `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`                            | Closest operator precedent for recommend/plan, ordered multi-artifact output, numeric profile binding, refusals, and partial sealing | Clarify that ratings sync retains its specialized apply rung; policy plan has no apply mode                               |
| `packages/rfmedia-cli/docs/features/shell-completion.doc.md`                           | Published Bash/Zsh/Fish parity contract and static-value tables                                                                      | Add the nested `policy plan` leaf, its options, and `--mode` values `recommend`, `plan`                                   |
| `ROADMAP.md`                                                                           | Live backlog/current-focus authority                                                                                                 | Mark #311 shipped with issue/PR reference, remove it from open follow-ups, update exit criteria/count/date from live data |
| `docs/roadmap-archive.md`                                                              | Shipped #209/#221 narrative                                                                                                          | Add #311 as a new shipped bullet or append a dated correction; do not erase the historical #209 boundary                  |

## Architecture Docs

- `packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md`, especially §§2.1, 7.2, 13,
  and 15: establishes why evaluation cannot write, why `handoff.argv` is inert, why policy provenance
  cannot enter the exact-key artifact, and that `policy plan` was deliberately deferred. Read for
  boundaries; leave historical language intact.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts`: authoritative definitions for
  `PolicyProposal`, `PolicyHandoff`, `POLICY_PRODUCER_IDS`, report shape, and evaluation option
  constants. New policy-plan docs must use shared mode/option constants once implemented rather than
  hand-maintained value lists.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts`: documents that handoff argv is data,
  forbids structural apply tokens, and makes discovery seeds non-mutation-bound. This is the source
  for “never execute argv” and `unsupported-producer` explanations.
- `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts`: source for pure projection, fresh-state
  producer routing, stable producer order, cohort-sized `maxBatch`, and non-atomic second-producer
  failure. Reuse concepts without promising policy plan an apply rung.
- `packages/rfmedia-cli/src/actions/lidarr/plan.ts` and `plan-artist-profiles.ts`: source for fresh
  Lidarr reads and existing default artifact paths. Docs must not claim evaluation `before` evidence
  is sealed directly.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, `src/lib/plan.ts`, and
  `src/types/lidarr-plan.ts`: authority for strict v3 checksums, private/atomic mode-`0600` files,
  no-overwrite behavior, and batch bounds.
- `packages/rfmedia-cli/src/commands/lidarr-policy.ts`: source for nested command help, inherited root
  output options, lazy loading, stdout/stderr separation, and local validation. Update its top comment
  from “single leaf today/future plan” to the two-leaf reality; remove the speculative
  `policy plan --ids` comment because v1 deliberately has no ID selector.
- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`: retain the read-only JSDoc. Its four
  “#221 sync-ratings is the sole consumer” comments remain accurate if policy plan forwards no
  rule-specific overrides or force-enable set; change them only if implementation actually adds a
  consumer.

## Reading List

Read in this order to avoid conflating evaluation, planning, and apply:

1. `feature-spec.md` for fixed #311 decisions and non-goals.
2. `lidarr-consumption-policy.md` sections “Use,” “Output Schemas,” and “Safety and Follow-Up
   Boundaries” for the existing public contract.
3. `lidarr-policy.ts` plus `policy-rule-support.ts` for proposal and inert-handoff truth.
4. `lidarr-ratings-sync.md` sections “Use,” “Safety Gates,” “Output Schemas,” and “Partial failure is
   ordered, not atomic” for reusable presentation language.
5. `lidarr-plan-apply.md` section “Review, Check, and Apply” for the independent apply boundary and
   expected ID/checksum pins.
6. `shell-completion.doc.md` plus `src/lib/shell-completions/{bash,zsh,fish}.ts` and
   `templates.spec.ts` for static tri-shell routing and value parity.
7. `packages/rfmedia-cli/README.md`, `docs/README.md`, `ROADMAP.md`, and
   `docs/roadmap-archive.md` for discoverability and lifecycle closeout.

## Documentation Gaps

The following current wording becomes stale and should be replaced exactly where found:

- `lidarr-consumption-policy.md:48`: link text “three separate commands you type yourself” and its
  anchor. Replace with a link to the review/seal/apply workflow.
- `lidarr-consumption-policy.md:809-838`: heading “Reaching a mutation takes three human-initiated
  commands,” “There is no path from an evaluation to a change,” the manually copied ID example, and
  “nothing changes here.” Replace with two explicit paths: `policy evaluate` remains inert; `policy
plan` reviews by default, `--mode plan` seals, and separate `lidarr apply` authorizes mutation.
  Retain the statement that every `handoff.argv` is inert and never executed.
- `packages/rfmedia-cli/README.md:5361`: “single leaf `evaluate`” and “future sealed-plan verb.” Update
  to `evaluate` and `plan`, emphasizing that only plan mode can write an artifact.
- `packages/rfmedia-cli/README.md:5431-5434`: “takes three separate commands you type yourself.”
  Replace manual transcription with `policy plan` recommend/plan examples and a separately pinned
  apply command.
- `docs/roadmap-archive.md:183-184`: “still takes three separate operator-typed commands.” Preserve as
  #209-at-ship historical text or explicitly time-bound it, then add a #311 bullet describing the
  closed gap; do not silently rewrite #209 history.
- `ROADMAP.md:57` and `:177`: open `lidarr policy plan` follow-up rows. Move #311 to shipped history,
  revise “policy → mutation is one fewer manual hop,” and refresh the Layer 3 path without implying
  auto-apply.
- `src/commands/lidarr-policy.ts:4-5`: “single leaf today”/“future policy plan”; update after the leaf
  exists. At `:96-101`, delete the future `--ids` rationale, which conflicts with the fixed v1 CLI.

New material still missing:

- A policy-plan subsection/table covering exact syntax, default zero-write behavior, global refusal
  gate, supported producer mapping, discovery refusal, no-change behavior, partial artifact outcome,
  machine result schema, exits, and checksum-pinned next step.
- A clear comparison table: `policy evaluate` writes no artifact; `policy plan` defaults to recommend;
  `policy plan --mode plan` seals 0-2 artifacts; none mutates; `lidarr apply` remains separate.
- Shell docs must show `rfmedia lidarr policy evaluate` and `rfmedia lidarr policy plan`, list
  `--mode` values only for plan, and state that all three shells expose identical children/options/
  values without reading config, credentials, Plex, or Lidarr.
- `docs/README.md` currently indexes Lidarr plan/apply but not consumption policy or ratings sync.
  Add at least a Lidarr Consumption Policy entry that mentions evaluate plus review/seal planning;
  add ratings sync if maintaining complete feature-index parity.
- Do not add new external API, configuration, database, plan-schema, generated-client, or MCP docs;
  #311 changes none of those surfaces.
