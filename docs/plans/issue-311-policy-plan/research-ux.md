# UX Research: Lidarr Policy Plan

Research date: 2026-07-31.

## Executive Summary

Issue #311 should remove risky manual ID/desired-state transcription while preserving the existing
review and apply boundaries. Recommended grammar:

```bash
# Default: fresh evaluation and projection preview; no artifact
rfmedia lidarr policy plan

# Explicitly seal selected, projectable cohorts; never apply
rfmedia lidarr policy plan --mode plan
```

Use `--mode recommend|plan`, matching `lidarr sync-ratings`, and omit an `apply` rung. Label the modes
`REVIEW ONLY` and `SEALED PLAN`; selecting a machine format never raises the safety rung.

The default runs the shipped evaluator, projects every proposal, shows cohorts/refusals, and stops
before producer calls. Explicit plan mode globally preflights the selection, then seals through
existing producers. It needs no prompt or `--yes`; mutation remains a separate `lidarr apply`.

Every proposal becomes a projectable change, unselected row, or refusal. Inert `discovery`
proposals never call Last.fm or become artist-add plans. An invalid producer, unsafe conflict, or
selected discovery proposal blocks all writes. A later producer failure yields a partial result
that preserves earlier artifact metadata.

**Confidence**: High. These recommendations extend shipped `policy evaluate`, `sync-ratings`, plan
presenters, output contracts, and Bash/Zsh/Fish completion parity tests.

## User Workflows

### Review and select

1. Validate mode, rules, exact proposal selection, cap, and connection values before loading actions.
2. Evaluate once and retain the complete policy report unchanged as evidence.
3. Project proposals in memory without parsing the human `handoff.argv` string.
4. Render evaluation state, signal coverage, selection accounting, exact before/after changes,
   producer cohorts, refusals, and distinct affected artists.
5. Stop with `No plan artifact was written and nothing was changed`, plus an exact `--mode plan`
   next step only when the full selection is sealable.

Selection needs two levels:

- `--rule <ids>` retains `policy evaluate` semantics and controls evaluated rules.
- `--proposal <keys>` is a repeatable, comma-separated positive selector over proposal keys from
  the fresh evaluation. Omission selects all proposals from selected rules. Unknown, duplicate,
  skip, or no-longer-present keys fail before producer calls.

Do not reuse `--ids`: subjects span Plex-only and Lidarr-backed identities and producers. Print
proposal keys in full and keep `--explain <key>` via the existing presenter.

### Seal and recover

Explicit plan mode must finish a global preflight before its first write. A selected unprojectable
proposal or unsafe/degraded selected evaluation produces a zero-write refusal with a precise remedy,
such as narrowing `--rule` or passing exact `--proposal` keys.

Seal sequentially in `POLICY_PRODUCER_IDS` order and display each artifact immediately. Finish with
one checksum-pinned apply command per artifact; never imply a transaction. No-proposal/converged is
successful with no empty artifact. Runtime failure after artifact one is `partial` and nonzero.

### Output and errors

Human output stays on stderr. JSON, YAML, and CSV emit exactly one prose-free result on stdout.
Evidence is rendered before assigning a nonzero exit code.

Human order: title/mode/origins; selection; coverage; cohorts; refusals with remedies; artifacts;
next steps/write scope. Use `reviewed`, `sealed`, `no-changes`, `refused`, `partial`, and `failed`.

JSON/YAML should share one versioned result containing mode, status, verbatim evaluation,
selection, cohorts, refusals, footprint, and ordered artifact outcomes. Artifact correlation—its
represented proposal keys—belongs in this result, not the exact-key v3 artifact. CSV should use
fixed `summary`, `rule`, `cohort`, `proposal`, `refusal`, and `artifact` rows, always including a
summary row; nested evidence can use explicit `*Json` columns like the existing policy projector.

Expected refusals are data. Invalid input uses the existing redacted failure envelope. Explicit
plan mode exits nonzero when selected intent cannot be completely sealed, the evidence is unsafe,
or an operational failure occurs. Review mode may succeed with visible refusals because it promised
only inspection.

**Confidence**: High for the workflow and stream boundaries; Medium for the exact `--proposal`
spelling and status-code vocabulary.

## Performance UX

Make cost visible: `--rule` does not avoid the Plex track drain because every rule requires or
enriches it; `plex.cache.enabled` is the repeat-run lever. Reuse execution/cancellation behavior.

Default human output should cap repeated rows at 20 and offer `--verbose`; this is presentation-only,
never a proposal or artifact cap. Summary counts and machine output must account for all bounded
rows. Projection is pure and cheap; default mode must not call producers merely to simulate a dry
run, because producers perform fresh reads and write artifacts. Explicit plan mode should reuse one
evaluation, preflight all cohorts in memory, then let each producer perform its authoritative fresh
Lidarr read.

**Confidence**: High.

## Accessibility and CLI Ergonomics

- Express state in words (`REVIEW ONLY`, `SEALED`, `REFUSED`, `PARTIAL`); color may reinforce but
  never carry meaning. Preserve clarity under `NO_COLOR`, redirected output, and screen readers.
- Prefer headings, labeled lines, and simple tables over emoji, progress bars, or glyph-only state.
- Never truncate proposal keys, paths, plan IDs, checksums, refusal codes, or remedy flags.
- Quote generated shell commands safely and emit one independent apply command per artifact.
- Group help under `Selection`, `Safety`, `Output`, and `Connection`. Describe the leaf as
  `Preview policy proposals and optionally seal Lidarr plan artifacts` and state that it never
  applies. Revise the `policy` parent description because one child can now write artifacts; keep
  the stronger write-free statement on `policy evaluate`.
- Bash, Zsh, and Fish must expose `plan`, complete `--mode` from `recommend plan`, bind `--rule` to
  `POLICY_RULE_IDS`, and mark repeatable/value-taking options consistently. Never dynamically
  complete proposal keys: completion must remain static, offline, and side-effect free.
- Extend exact Commander option-surface and tri-shell command/option/value/routing tests. Root
  `--output` and `--json` remain inherited, not redeclared.

**Confidence**: High.

## Recommendations

1. Adopt `--mode recommend|plan`, defaulting to artifact-free review; do not add `apply` or `--yes`.
2. Reuse `--rule`, `--max-proposals`, `--explain`, `--verbose`, library, and connection options.
3. Add one exact positive selector, recommended as `--proposal <keys>`; avoid `--ids` and defer an
   exclusion selector until usage proves it necessary.
4. Globally preflight selected proposals. Treat discovery as an explicit inert refusal and block
   sealing rather than silently dropping it.
5. Present every artifact immediately and return a typed partial result if later sealing fails.
6. Keep policy evidence and proposal-to-artifact correlation in the result; reuse unmodified v3
   artifacts and existing producers.
7. Omit `--dry-run`, `--plan-file`, `--decision`, and `--fail-on`: recommend is the dry rung; one
   path cannot name multiple artifacts; decision has different sync-ratings semantics; evaluate
   retains the dedicated CI gate.

## Open Questions

1. Should any degraded selected rule block sealing of healthy sibling cohorts? Recommendation: yes
   in v1; require a narrower rerun.
2. Should the exact selector be named `--proposal` or `--proposal-key`?
3. Can one artist safely appear in both producer artifacts, or should every overlap inherit
   sync-ratings' cross-decision refusal?
4. Should an explicitly selected discovery proposal always make plan mode exit 1? Recommendation:
   yes, because selected intent was not sealed.
5. Should `disabled` be `no-changes` while `signal-unavailable`/`rule-error` is `refused`?
6. Should producer-two failure return a normal typed `partial` result or extend the failure envelope
   with artifacts? Recommendation: typed result for consistent JSON/YAML/CSV recovery.
7. If output location is later requested, should it be a directory or prefix? A single
   `--plan-file` is unsuitable for multiple artifacts; v1 should use producer defaults.
