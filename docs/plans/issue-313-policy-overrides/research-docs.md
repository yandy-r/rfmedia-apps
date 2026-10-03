# Documentation Research: Issue 313 Policy Overrides

## Overview

The user-facing contract is split between the package README, the Lidarr consumption-policy feature
guide, the ratings-sync feature guide, and the root roadmap. The implementation should document one
configuration-backed `suppress` action, evidence-bound fingerprints, the active/stale lifecycle,
strict startup behavior for the three affected commands, and the guarantee that overrides never
grant mutation authority. No new CLI option is added, so command option tables and Bash/Zsh/Fish
completion templates remain unchanged.

## Must-Read Documents

- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`: Primary contract for decision
  keys, evaluation reports, policy planning, explain output, safety boundaries, and configuration.
- `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`: Recommend/plan/apply ladder that must
  explain how disputed decisions are withheld before plan production or apply.
- `packages/rfmedia-cli/README.md`: Discoverable command and configuration reference; its Lidarr
  consumption-policy section needs the concise override workflow and config shape.
- `ROADMAP.md`: Delivery ledger; issue #313 must move from planned work to the shipped policy
  surface with the final pull-request reference.
- `docs/plans/issue-313-policy-overrides/feature-spec.md`: Binding behavior, schema, fingerprint,
  lifecycle, safety, and test decisions for implementation and final docs.
- `.github/pull_request_template.md`: Required PR body structure and exact verification evidence.

## Required User-Facing Changes

### Consumption Policy Guide

Add a dedicated decision-override section near the decision-key and explain/report material. It
must show the exact `.rfmedia.yaml` mapping keyed by a three-segment proposal key:

```yaml
policy:
  overrides:
    "stale-monitoring-cleanup:artist:233":
      action: suppress
      evidenceFingerprint: "sha256:<64 lowercase hex characters>"
      reason: "Reviewed with the library owner; leave monitoring unchanged."
```

Document the operator loop: evaluate, copy the full fingerprint from machine or explain output,
add the reasoned suppression, evaluate again, and review every stale result before updating or
removing the entry. Make clear that a four-segment skip key is not valid override input.

Explain the states without implying new evaluator truth:

- `suppressed`: key and current evidence fingerprint match; the proposal is visible as suppressed
  but absent from the actionable proposal collection.
- `stale / evidence-changed`: the proposal still exists but its evidence changed; it is quarantined
  for review.
- `stale / outcome-changed`: the same subject now produces a skip; the real skip remains visible.
- `stale / decision-absent`: the selected, completed rule no longer produces the subject decision.
- `not-evaluated`: the applicable rule was unselected, disabled, or blocked, so the override was
  not assessed.

State that proposal caps run before override classification and suppressed positions are not
refilled. The report's proposed count remains actionable-only, while override summary counts make
withheld and stale decisions explicit. `--fail-on proposals` must be described as failing for stale
override review work but not for active suppression alone.

The safety section must retain the existing read/evaluate/project/apply separation: evaluate never
writes a plan or mutates Lidarr; policy plan can produce sealed artifacts only from actionable
proposals; an override cannot force a proposal, alter a desired value, convert a skip, or revoke an
already sealed artifact.

### Ratings Sync Guide

Add a short subsection explaining that ratings sync embeds the same policy v2 evaluation and
projects only its remaining actionable proposals. Active and stale matching proposals therefore
cannot reach plan producers, confirmation, or apply in the current run. A configured override does
not authorize apply and does not rewrite an artifact sealed by an earlier run.

Link back to the consumption-policy guide for the complete config, fingerprint, status, and dispute
workflow rather than duplicating the full contract.

### Package README

Extend the existing Lidarr Consumption Policy section with a compact example and the operator
workflow. Add `policy.overrides.<decision-key>.action`, `.evidenceFingerprint`, and `.reason` to the
configuration reference. Mention that affected commands treat the highest-precedence existing
config as authoritative and abort on read, template, parse, or validation errors instead of silently
falling through:

- `rfmedia lidarr policy evaluate`
- `rfmedia lidarr policy plan`
- `rfmedia lidarr sync-ratings`

Keep the README concise and point to the feature guide for the complete state table and fingerprint
scope. Do not add flags to command tables because override state is config-backed.

### Roadmap

Update the policy-engine or Lidarr policy area only after checking current live issue totals and the
final PR number. Mark issue #313 as shipped, preserve neighboring roadmap wording, and avoid stale
aggregate counts. The final entry should describe durable evidence-bound suppressions, stale review
visibility, and no expansion of mutation authority.

## Contract and Terminology

Use **override** for the durable configuration record and **suppressed** for an exact active match.
Use **stale** only for a previously reviewed record whose current evidence or outcome no longer
matches. Use **not evaluated** for a record whose rule could not be assessed; do not call it active
or stale. Prefer **actionable proposals** for `report.proposals`, because suppressed/stale decisions
remain reviewable report evidence even though downstream consumers cannot act on them.

The full `sha256:` fingerprint is required in config, JSON, YAML, CSV, and explain output. A shortened
token may be used only as human display decoration. Reasons are operator-supplied display text and
must never be represented as fingerprint material, plan arguments, or authorization.

## Examples and Output Guidance

Examples should begin with a read-only evaluation and show machine output when precise copy/paste is
important. Human output must show an Overrides section even when every current proposal was withheld
and the downstream result is otherwise `NO CHANGES`. Explain examples should use the original
three-segment proposal key; configured suppressed and stale keys remain valid explain targets after
their proposals leave `report.proposals`.

JSON/YAML examples should name the policy evaluation schema v2 while leaving the policy-plan v1,
ratings-sync v1, and sealed plan v3 contracts unchanged. CSV documentation should mention explicit
override rows and spreadsheet-safe reason cells without reproducing the entire column registry.

## Documentation Patterns

**Feature guide as source of truth**: Put complete semantics and safety boundaries in
[`packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`](../../../packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md),
then keep README and ratings-sync text short and linked.

**Exact command evidence**: Follow adjacent verification and workflow examples using copyable
commands, explicit modes, and precise statements about whether a plan or mutation can occur.

**Safety beside workflow**: Place the no-mutation/no-force guarantees beside the configuration and
operator steps, not only in a remote security section.

**Stable terms across surfaces**: Match report field/status names in prose so human, JSON/YAML, CSV,
and explain documentation describe one authoritative state model.

## Validation

- Run Prettier and markdownlint on every modified Markdown file.
- Run `git diff --check` for whitespace integrity.
- Verify all relative links resolve from their containing documents.
- Audit README option tables and all three shell completion templates for no change.
- Record exact test, typecheck, architecture, formatting, and completion-parity commands in the PR
  template.
- Recheck live GitHub issue/PR state before finalizing ROADMAP wording and totals.

## Gotchas

- Do not describe a suppression as deleting evidence; it is retained as an explicit report result.
- Do not suggest that stale records become actionable; they remain quarantined for review.
- Do not imply that an override changes rule thresholds, desired targets, skips, or artifact seals.
- Do not promise that a newly added override revokes an old sealed artifact.
- Do not add a completion entry or CLI flag for a config-only feature.
- Do not present the current generic config fallback rule as universal after strict sensitive-command
  loading is introduced; qualify the three affected paths exactly.
