# UX Research — Lidarr Cascade Analysis and Budget Estimation

## Executive Summary

Issue #219 should add a compact, checksum-backed **Cascade analysis** block to every Lidarr mutation
plan presentation. It should answer, in order:

1. What changes now?
2. What downstream work is caused immediately?
3. What future exposure changes conditionally?
4. How do known quantities compare with configured budgets?
5. What can the operator do next?

The UX must distinguish `0` from `unknown`, and immediate work from conditional future exposure.
Current plan kinds do not enqueue an explicit search; artist-add also seals
`searchForMissingAlbums: false`. Their immediate indexer-query and acquisition demand should
therefore read `0 (exact)`, while future RSS, upgrade, or release-policy exposure may be numeric,
qualitative, or unknown.

Budget results are advisory. An exceeded budget should be prominent and actionable, but must not
look like an apply authorization, silently shrink scope, or imply that batching reduces total
demand. Existing risk, destructive authorization, checksum, and apply gates remain separate.

## Current UX Baseline

The existing Lidarr presentation establishes useful conventions:

- Human output is written to stderr; JSON, YAML, and CSV are written to clean stdout.
- Plans lead with identity, checksum, artifact path, target, selection, review counts, and risk.
- Operation-specific totals follow, then cascade facts and a capped entry table.
- Destructive operations use explicit text such as `DESTRUCTIVE` and list required authorization
  flags; color only reinforces the wording.
- Default tables show at most 20 rows, with `--verbose` offered where supported.
- `apply --dry-run` is a live validation pass and writes no history or mutations.
- Machine failures use one structured error envelope with message, code, lane, attempts, and retry
  metadata.
- The audit command already demonstrates stable severity words, finding codes, affected counts, and
  a deduplicated `Suggested follow-up` block.

There are also inconsistencies worth avoiding:

- Preview-only plan leaves use several different path placeholders, and some identify preview state
  only indirectly.
- Album monitoring has a separate renderer from the shared mutation presenter.
- Existing `risk.cascade` strings are useful prose but are not sufficient machine data for numeric
  estimates, budgets, warnings, or recommendations.
- The original research mockups use tree glyphs, emoji, approximate timing, live-health claims, and
  "remaining budget" language that are not justified by the current plan contract.

## User Workflows

### Primary workflow: preview, seal, revalidate, apply

1. **Preview scope:** show the complete analysis using the sealed-plan calculation, state
   `Mode: PREVIEW ONLY — no artifact written`, and omit the artifact path.
2. **Adjust scope or policy:** use exact IDs, tighter filters, or a smaller `--max-batch`, then
   re-preview. Smaller plans reduce peak load and improve reviewability; they do not reduce total
   demand unless scope or policy changes.
3. **Seal the plan:** show plan ID, checksum, and real path. Analysis, warnings, budget snapshot,
   assumptions, and recommendations become checksum material.
4. **Revalidate:** run `rfmedia lidarr apply <plan> --dry-run`; show
   `Mode: APPLY CHECK — no mutation or history write`. Label the sealed data `Plan-time analysis`
   and keep live-state validation separate.
5. **Apply:** preserve confirmation and destructive authorization. Show the plan-time analysis
   before an interactive prompt; advisory warnings add no implicit override flag.

### Alternative workflows

#### Automation and CI

- Use global `--output json|yaml|csv`; never prompt in machine output and preserve `--yes` for real
  apply. Advisory warnings do not change exit status; validation errors remain non-zero after one
  complete machine document.

#### No configured budget

- Still show estimates. Render `Budget: UNCONFIGURED`, never `unlimited`, `0`, or `100% remaining`.

#### Unknown quantity

- Render `Quantity: UNKNOWN` plus the missing evidence. Do not calculate a ratio or verdict; keep
  planning available unless the plan/configuration contract is invalid or contradictory.

#### Legacy plan

- Render `Cascade analysis: NOT RECORDED (legacy plan)`. Keep it applicable, but do not synthesize
  plan-time estimates during apply.

#### No-change preview

- Retain selection accounting, show newly caused work as zero, and state that no artifact was
  written. No change is an ordinary outcome, not a warning.

## Information Hierarchy

Human output should use this order:

1. **Title and mode** — operation plus `PREVIEW ONLY`, `SEALED PLAN`, `APPLY CHECK`, or `APPLY
RESULT`.
2. **Identity** — plan ID, checksum, artifact path when real, and Lidarr target.
3. **Scope** — selection, requested/changed/no-op counts, and max batch.
4. **Operation risk** — current risk level, destructive state, and exact file impact where relevant.
5. **Cascade analysis** — immediate effects first, then conditional future exposure.
6. **Budget comparison** — quantity, allowance, ratio/state, certainty, and horizon.
7. **Warnings** — highest severity first, adjacent to the analysis rather than below entry rows.
8. **Recommended next steps** — capped, deduplicated, and tied to warning codes.
9. **Entry sample** — current operation-specific table and truncation notice.
10. **Authorization/next command** — existing safety flags or apply-check command.

Plan ID and checksum remain visible, but cascade facts should appear before the potentially long
entry table because they influence whether the operator should continue reviewing or revise scope.

## Recommended Human Presentation

```text
Lidarr Artist Monitoring Plan
  Mode: PREVIEW ONLY — no artifact written

  Target: https://lidarr.example.test
  Selection: IDs: 12, 34, 56
  Review: 3 changes, 0 no-ops, cap 25
  Risk: medium (non-destructive)

  Cascade analysis
    Immediate apply
      Explicit searches: 0 (exact; this operation does not enqueue search)
      Indexer queries: 0 (exact)
      Acquisition candidates: 0 (exact)
    Conditional future exposure
      Newly monitored artists: 3 (exact)
      Newly monitored albums: UNKNOWN (album evidence not captured)
      Existing queue items: unchanged

  Budget
    Indexer queries: WITHIN — 0 of 500 per plan
    Acquisition candidates: WITHIN — 0 of 25 per plan

  [WARNING conditional-future-exposure]
    Monitoring can make future releases eligible through RSS or a later explicit search.

  Suggested follow-up
    - Use apply --dry-run after sealing to revalidate live Lidarr state.
    - Narrow exact IDs or filters if the conditional scope is broader than intended.
```

For a known comparison:

```text
  [WARNING budget-exceeded]
    Nominal indexer queries: 640 of 500 per plan (128%, estimated).
    This is configured policy, not live Prowlarr remaining quota.

  Suggested follow-up
    - Reduce the selected scope, or create smaller independently reviewed plans.
    - Delay an explicitly search-triggering operation until provider capacity is available.
```

Do not show progress bars for budget ratios: they consume width, are awkward in logs and screen
readers, and can suggest precision that an estimate does not have.

## Warning and Error States

| State                         | Human treatment                                      | Apply effect |
| ----------------------------- | ---------------------------------------------------- | ------------ |
| `within`                      | Plain budget row; no warning                         | None         |
| `elevated`                    | `[WARNING budget-elevated]` with quantity/allowance  | None         |
| `exceeded`                    | `[WARNING budget-exceeded]` before entry table       | None         |
| `unknown`                     | `[WARNING quantity-unknown]` with missing basis      | None         |
| `unconfigured`                | `[INFO budget-unconfigured]`; never say unlimited    | None         |
| `conditional-future-exposure` | Warning only when future exposure increases          | None         |
| `not-recorded`                | Legacy-plan notice, not a fabricated estimate        | None         |
| Invalid configuration         | Fail with exact property path and accepted bounds    | Block        |
| Invalid analysis arithmetic   | Fail before artifact write; name inconsistent fields | Block        |
| Unavailable advisory provider | Mark observation unavailable; keep local analysis    | None         |

Every error should state: what failed, whether an artifact was written or mutation occurred, and the
safe correction. Do not recommend a force flag that does not exist. Preserve existing error
envelopes and exit-code behavior rather than creating a budget-specific failure channel.

## Accessibility and Non-Color Output

- Use explicit words and stable codes: `[INFO ...]`, `[WARNING ...]`, `[ERROR ...]`,
  `DESTRUCTIVE`, `UNKNOWN`, and `UNCONFIGURED`.
- Color may reinforce severity but must never be the only distinction. This follows W3C guidance
  that color not be the sole means of conveying information:
  <https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html>.
- Ensure meaningful output survives `NO_COLOR`, redirected stderr, monochrome terminals, copied
  logs, and screen readers.
- Prefer simple headings, indentation, and hyphen bullets over emoji, colored icons, tree glyphs, or
  animated meters.
- Keep numeric units in labels (`queries per plan`, `candidates`, `bytes`) and do not encode meaning
  in column position alone.
- Avoid very wide aggregate tables. The cascade block is better as labeled lines; retain tables for
  repeated plan entries.
- Keep diagnostics on stderr and structured results on stdout, consistent with the repository and
  conventional CLI behavior. GNU guidance also recommends non-interactive diagnostic forms when
  input is not a terminal: <https://www.gnu.org/prep/standards/html_node/Errors.html>.

## Machine Output Contract

JSON and YAML should expose the complete typed analysis without prose parsing:

- schema/version;
- analysis status (`recorded` or `not-recorded`);
- immediate and conditional metric arrays/objects;
- quantity or explicit unknown, certainty, horizon, unit, and basis;
- configured budget snapshot, comparison state, and derived ratio when valid;
- stable warnings with code, severity, metric, quantity, allowance, and message;
- stable recommendations with code, action, and optional safe command;
- assumptions and provenance that contain no credentials.

CSV should remain a stable flat aggregate projection. Add explicit columns for analysis status,
immediate search/query/acquisition quantities, conditional monitored/eligible counts, each budget
state and allowance, highest warning severity/code, and JSON-encoded warnings/recommendations.
Never require consumers to parse `risk.cascade` or human sentences.

Preview output must say `status=previewed` and omit `planPath`; sealed output says `status=planned`
and includes it. Apply output should include the sealed analysis as plan-time data, including for
`--dry-run`, and should label legacy absence explicitly.

## Performance UX

Keep the default review fast and bounded: calculate analysis from already reviewed plan evidence,
render aggregate cascade and budget facts before entry details, cap repeated rows, and make live
Prowlarr observation optional rather than a prerequisite for deterministic planning.

## Recommendations

1. Put one shared cascade renderer/projector behind every plan family, including album monitoring,
   artist-add, album mutation, and track-file filtering.
2. Make preview/sealed/apply-check mode explicit and consistent across all producers.
3. Keep analysis separate from the existing `risk` object in presentation, while showing both
   adjacent in the review.
4. Use deterministic warning and recommendation registries so human, JSON, YAML, and CSV remain in
   parity.
5. Cap recommendations (three is sufficient), deduplicate them, and order by the highest warning
   they address.
6. Describe budgets as configured policy unless authoritative live usage is separately observed and
   timestamped.
7. Test the critical presentation contracts: zero versus unknown, preview path omission, exceeded
   warning placement, legacy `not-recorded`, non-color labels, and machine/human parity.

## Open Questions

1. Are v1 budgets per reviewed plan only, or is a time-window budget also required?
2. Should future exposure have its own allowance, separate from immediate query/acquisition budgets?
3. Is optional Prowlarr observation in scope now, and if so, how is stale or partial observation
   labeled without implying authoritative remaining quota?
4. Should all plan leaves gain a consistent `--dry-run`, or should preview-by-default leaves retain
   their current command shape while normalizing only result status?
5. Should the shared presenter display a budget block when every budget is unconfigured, or one
   concise `Budgets: UNCONFIGURED` line?
6. Does `budget-unconfigured` warrant `info` or `warning` severity in machine output?
7. Which CSV aggregate fields are mandatory for v1, given that nested warnings and recommendations
   also need JSON cells?
