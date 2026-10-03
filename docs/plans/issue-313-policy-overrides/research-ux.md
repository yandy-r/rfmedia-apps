# UX Research: Policy Decision Suppression and Override Surface

Research date: 2026-08-06.

## Executive Summary

Issue [#313](https://github.com/yandy-r/rfmedia-apps/issues/313) should feel like a review workflow,
not a second policy language. The safest v1 journey is:

1. Find a proposal key in `policy evaluate`, `policy plan`, or `sync-ratings`.
2. Run `--explain <key>` and copy the full evidence fingerprint from the same causal explanation.
3. Add one quoted, reason-bearing entry to `policy.overrides` in `.rfmedia.yaml`.
4. Re-run the original command and see the human state classified explicitly as
   `ACTIVE SUPPRESSION`, `STALE — REVIEW REQUIRED`, or `NOT EVALUATED`.
5. For an evidence-changed stale record with a current proposal fingerprint, re-review and replace
   the fingerprint or remove the record. Outcome-changed, decision-absent, and not-evaluated records
   must not suggest a refresh. No command refreshes a record automatically.

Use “override” for the durable config record and `action: suppress` for its only v1 effect. Do not
offer `force`, alternate desired state, skip-to-proposal conversion, or an editor command. Exact
key/fingerprint matches are active suppressions. A stale match should quarantine the current
proposal pending explicit review rather than silently reactivate a previously disputed mutation.
This is especially important for `sync-ratings --mode apply --yes`.

Every screen must answer four operator questions without relying on color:

- What decision did I dispute?
- Is the suppression active against the evidence I reviewed?
- If it is not active, what changed or why was no decision observed?
- Can this run seal or apply anything for that decision?

Suppression matching is local, synchronous, and read-only. It must not call Plex or Lidarr, write a
plan, edit `.rfmedia.yaml`, or imply that “suppression applied” means “Lidarr changed.” Prefer the
phrase **active suppression** over **applied override** in human output.

**Confidence**: High. The workflow extends the shipped stable-key, `--explain`, evidence-first
presenter, embedded-evaluation, and review/seal/apply contracts. The fail-closed treatment of stale
records is a safety recommendation rather than wording fixed by issue #313.

## User Workflows

### Primary flow: dispute one proposal

#### 1. Locate the decision

The normal proposal table should keep the existing stable key and add a short evidence token, for
example the first 12 hexadecimal characters after `sha256:`. The token is a recognition aid only;
it must never be the value users copy into config.

```text
Proposals (2)
Key                                        Evidence      Artist             Before          After
stale-monitoring-cleanup:artist:233        8f319f2a4c11  Generic Chillhop  monitored       unmonitored
```

End the section with a concrete instruction:

```text
Explain and copy the full review pin:
  rfmedia lidarr policy evaluate --explain stale-monitoring-cleanup:artist:233
```

Do not add a new CLI selector merely to print fingerprints. `--explain` already works across the
three relevant command surfaces and is the natural place to expose copy-grade evidence.

**Confidence**: High. Current proposal rows already expose the key and `--explain` already owns the
full causal chain; adding a compact recognition column preserves scanability.

#### 2. Review and obtain a copy-grade fingerprint

For a proposal, `--explain <key>` should append an `Override` block after the existing identity,
observations, threshold checks, and before/after proposal:

```text
Override
  State       not configured
  Evidence    sha256:8f319f2a4c11a62bd73de0c932722b584da43ba2fd90c6e3868e1c6ef14335c1
  Config key  policy.overrides["stale-monitoring-cleanup:artist:233"]
  Effect      Adding an exact suppression withholds this proposal; it does not change Lidarr.

Add under policy.overrides:
  "stale-monitoring-cleanup:artist:233":
    action: suppress
    evidenceFingerprint: "sha256:8f319f2a4c11a62bd73de0c932722b584da43ba2fd90c6e3868e1c6ef14335c1"
    reason: "Replace with why this decision is disputed"
```

The full fingerprint must be untruncated, selectable plain text. The YAML snippet should be only the
mapping entry, not a rewritten full config file, so operators merge it into their existing
`policy.overrides` map without overwriting unrelated settings. Quote the key because it contains
colons. Do not pre-fill a plausible rationale: the operator's reason is part of the review record.

For an ordinary rule skip, show the fingerprint and causal explanation but state that v1 accepts
proposal keys only: the skip is already non-actionable, and suppressing it must not manufacture a
proposal.

**Confidence**: High for the full-value and no-auto-edit requirements; Medium for emitting a YAML
snippet directly in `--explain`, which is an ergonomic recommendation not required by the issue.

#### 3. Edit reviewable YAML

Recommended config shape:

```yaml
policy:
  overrides:
    "stale-monitoring-cleanup:artist:233":
      action: suppress
      evidenceFingerprint: "sha256:8f319f2a4c11a62bd73de0c932722b584da43ba2fd90c6e3868e1c6ef14335c1"
      reason: "Compilation listening is not represented by the artist-name play join"
```

The mapping should be stable-keyed, explicit, and diff-friendly. Preserve operator comments and
ordering by leaving editing to the operator; evaluation only reads the file. YAML 1.2.2 defines a
mapping as an unordered association with unique keys, so semantics must not depend on entry order
and duplicate keys must be rejected rather than resolved by “last one wins.”

The documentation should recommend a specific, reviewable reason that explains the evidence gap,
not a generic “ignore.” Reasons should appear in every disposition view because they answer why an
otherwise valid policy result is being withheld.

**Confidence**: High. `.rfmedia.yaml` is already the shared policy surface and avoids a hidden local
store or a new write workflow. The mapping rule is confirmed by the October 2021
[YAML 1.2.2 specification](https://yaml.org/spec/1.2.2/).

#### 4. Verify the result

The next run must show an `Overrides` section even when there are zero actionable proposals.
Disposition labels and effects should be:

| Human state               | Machine state and cause                                                                  | Actionability and recovery                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACTIVE SUPPRESSION`      | `suppressed`; proposal key and evidence fingerprint match                                | Withheld from cohorts; no action needed unless the reason is obsolete                                                                           |
| `STALE — REVIEW REQUIRED` | `stale: evidence-changed`; the same proposal now has a different fingerprint             | Withheld pending review; inspect the current proposal and replace its current fingerprint only after review, or remove the record               |
| `STALE — REVIEW REQUIRED` | `stale: outcome-changed`; the subject now produces a real skip/refusal                   | Keep the real skip visible; update only if a proposal later returns, or remove an obsolete record                                               |
| `STALE — REVIEW REQUIRED` | `stale: decision-absent`; a selected, completed rule emitted no decision for the subject | Verify identity, convergence, delete/re-add, and instance scope; there is no current fingerprint to copy, so remove the record only if obsolete |
| `NOT EVALUATED`           | `not-evaluated`; the rule was deselected, disabled, or blocked before subject evaluation | Unknown for this run; rerun with the rule enabled and selected before changing the record, and do not refresh its fingerprint                   |

A decision absent after a selected rule completed is stale with `staleReason: decision-absent`,
not a separate fourth lifecycle state. This distinguishes an obsolete or converged decision from a
rule that did not run, while keeping the public state model small.

Show `STALE — REVIEW REQUIRED` and `NOT EVALUATED` rows without `--verbose`; they are review state,
not high-volume evaluator skips. It is acceptable to cap `ACTIVE SUPPRESSION` detail rows at the
normal 20-row limit if the header retains the complete count and tells the user to pass `--verbose`.

**Confidence**: High for the settled human labels, machine states, and always-visible non-active
states.

### Evidence-changed stale recovery flow

`--explain <key>` must continue to find a configured override after its decision moves out of the
actionable proposal array. Key lookup therefore needs to include override results and their retained
current decision when present, with duplicate keys collapsed deterministically.

For `stale: evidence-changed` with a current proposal and fingerprint, render the causal chain first,
then:

```text
Override
  State       STALE — REVIEW REQUIRED; current proposal withheld
  Reason      Compilation listening is not represented by the artist-name play join
  Expected    sha256:8f319f2a4c11a62bd73de0c932722b584da43ba2fd90c6e3868e1c6ef14335c1
  Current     sha256:78a9210db60ea9f16f8a14261bf54b0fa2da7f99a0c11ac8e40194da9c61f002
  Changed     plays: 0 -> 3; sample rows: 42 -> 47
  Config key  policy.overrides["stale-monitoring-cleanup:artist:233"]

Next
  Review the current proposal evidence. Then either replace evidenceFingerprint with Current,
  or remove this override to make the proposal actionable again.
```

Fingerprint replacement applies only to an evidence-changed record that carries a current proposal
fingerprint. An outcome-changed record retains the real skip and should be updated only if a proposal
later returns. A decision-absent record has no current decision fingerprint to approve. Neither state
should suggest copying or refreshing a hash.

`Changed` is valuable only if it can be derived from retained structured evidence. Do not invent a
semantic diff by comparing prose. If the implementation stores only fingerprints, state “material
decision evidence changed” and rely on the current causal chain; expected/current full hashes are
still mandatory.

There must be no `--accept-stale`, `--refresh-overrides`, automatic hash update, or prompt that edits
config. Replacing the pin is a review decision suitable for a visible YAML diff.

**Confidence**: High for explicit expected/current values and manual recovery; Medium for a field
level `Changed` line because the proposed result may not retain the prior decision material.

### Decision-absent and not-evaluated recovery

A `STALE — REVIEW REQUIRED` row with `staleReason: decision-absent` should guide the operator through
safe hypotheses in this order:

1. Confirm the same Plex/Lidarr instance and config file were loaded.
2. Confirm the rule was selected and completed successfully.
3. Check whether the subject converged, was deleted/re-added under a new provider id, or lost its
   authoritative identity join.
4. Remove the record only after deciding that the old dispute is obsolete; never remap by name.

This recovery path has no current proposal fingerprint, so it must not suggest hash replacement or
refresh.

A not-evaluated row should instead name the rule-level cause and give the exact remedy already used
by policy output, such as `--rule <id>` or `policy.rules.<id>.enabled`. It should not suggest
updating the fingerprint because there is no current evidence to approve.

**Confidence**: High. Stable keys are instance-local provider identities, and the current policy
engine already distinguishes deselected/disabled/degraded rule outcomes.

### `policy plan` journey

Both review and seal output must retain the embedded `Overrides` section and complete accounting:

- Active suppressions never enter producer cohorts.
- Stale selected-scope records are labeled `STALE — REVIEW REQUIRED` and block all artifact writes
  in plan mode before the first producer call.
- Decision-absent stale and not-evaluated records remain visible but do not masquerade as
  projectable decisions.
- A withheld-only run should say `No actionable proposals` and name the suppression/stale counts;
  plain `NO CHANGES` would conceal why the cohort is empty.
- `--explain <suppressed-or-stale-key>` still appends the full decision/disposition after the
  complete plan report.

This preserves the existing global preflight promise: a selected intent that cannot be completely
and safely accounted for writes zero artifacts. The sealed v3 artifact remains unchanged and
contains no policy/override provenance; the policy-plan machine report is the review record.

**Confidence**: High for active suppression exclusion and complete reporting; Medium for making
stale state a global plan-mode refusal, which is the recommended conservative policy.

### `sync-ratings` journey

The specialized command should project the same embedded evaluation rather than reclassifying
overrides:

- Active suppressions are absent from `quality-profile` and `monitoring` cohorts in every mode.
- A stale record for a selected decision visibly refuses that decision before sealing or applying.
- An independent selected decision may continue under the command's existing per-decision refusal
  model, but the final summary must say which decision was withheld.
- CLI threshold overrides participate in current evidence, so one-off `--min-stars`, `--max-plays`,
  or profile changes can make a suppression stale.
- Confirmation, checksum pins, claims, history, and apply verification remain mandatory for every
  unsuppressed cohort.

Avoid “override applied” in this presenter because `mode: apply` already means a Lidarr mutation.
Use `ACTIVE SUPPRESSION`, `STALE — REVIEW REQUIRED`, and `decision withheld`.

**Confidence**: High for shared evaluation and terminology; Medium for allowing a healthy sibling
decision to continue, which follows current sync-ratings isolation but needs a final business-rule
decision.

### Machine and automation flow

JSON and YAML should emit one prose-free document on stdout with full, untruncated values. The
versioned evaluation result needs:

- a full `evidenceFingerprint` on every proposal/skip decision;
- an `overrides` array containing key, action, status, reason, expected fingerprint, current
  fingerprint or `null`, retained current decision or `null`, and stable detail/remedy fields;
- summary counts for actionable proposals, ordinary skips, active suppressions, stale records, and
  not-evaluated records;
- deterministic ordering by configured decision key, not YAML source order.

CSV should add a distinct `override` row type and fixed columns. Do not encode operator suppression
as an evaluator `skip`: consumers must be able to distinguish policy truth from operator judgment.

Machine `--explain` should preserve the current rule: validate the key in every format, then emit
the complete envelope rather than a filtered document. The expanded known-key set must include
suppressed/stale decisions so a valid historical key does not fail as “unknown.”

Recommended automation predicates are explicit fields, not prose or exit-code inference:

```text
overrides[status == "suppressed"]                         active, evidence-pinned veto
overrides[status == "stale" && staleReason == "evidence-changed"]  review current proposal hash
overrides[status == "stale" && staleReason == "outcome-changed"]   real skip retained; no refresh
overrides[status == "stale" && staleReason == "decision-absent"]   no current decision; no refresh
overrides[status == "not-evaluated"]                      insufficient evidence; no refresh
```

`--fail-on proposals` should fail for actionable proposals and stale selected-scope records, after
rendering. Active suppressions alone should not fail. This prevents a CI run from reading green
while a disputed decision has drifted and requires review.

**Confidence**: High for the structured output and stream boundaries; Medium for stale exit-gate
semantics because issue #313 requires visibility but does not define CI behavior.

## UI/UX Best Practices

### Information hierarchy

Human output should follow the operator's decision sequence:

1. Header and evaluation status.
2. Actionable proposal/rule summary.
3. `Overrides` summary and non-active rows.
4. Producer cohorts/refusals for plan or sync surfaces.
5. Coverage and threshold provenance.
6. Exact next steps and write-scope disclosure.

An active-suppression row should include `Key`, `State`, `Artist`, short `Expected/Current`, and
`Reason`. A stale row additionally needs an explicit effect: `WITHHELD — REVIEW REQUIRED`. Never
truncate keys, full fingerprints in `--explain`, config paths, or remedies. It is acceptable to
shorten fingerprints in tables when the complete value is one command away and clearly labeled.

Do not call a run with stale records simply `CLEAN` or `NO CHANGES`; the absence of actionable
proposals is true, but incomplete. Prefer `NO ACTIONABLE PROPOSALS` plus an override row labeled
`STALE — REVIEW REQUIRED`, while retaining a versioned machine status/count contract.

**Confidence**: High for hierarchy and explicit effects; Medium for headline vocabulary.

### Accessibility and narrow terminals

- Use literal human labels `ACTIVE SUPPRESSION`, `STALE — REVIEW REQUIRED`, and `NOT EVALUATED`;
  color may reinforce but never define status.
- Keep one logical record together using a short table row plus indented `reason`, `effect`, and
  `next` notes. This survives narrow terminals better than a 9-column table.
- Under `NO_COLOR`, redirected stderr, and screen readers, retain the same headings, record order,
  and textual status.
- Avoid emoji and glyph-only warnings. Existing simple headings and labeled lines are the right
  pattern.
- Put the exact invalid config field and recovery suggestion in text, not only a caret/color.

W3C WCAG is written for web content rather than terminal applications, but its stable principles
transfer directly: status cannot rely on color alone, and automatically detected input errors
should identify the item and describe the error in text. The relevant official pages were updated
in 2025-2026: [Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color) and
[Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification).

**Confidence**: High for text-first status and errors; Medium for applying web accessibility
guidance by analogy to a CLI.

### Language rules

Use these terms consistently:

| Prefer                                   | Avoid                                     | Why                                                                 |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| `ACTIVE SUPPRESSION`                     | `override applied`                        | Uses the settled human label and avoids confusion with Lidarr apply |
| `withheld from producer cohort`          | `ignored`                                 | States the observable effect                                        |
| `STALE — REVIEW REQUIRED`                | `invalid`                                 | Config is valid, but its reviewed decision no longer matches        |
| `decision absent` as stale-reason detail | `orphan` as a separate human state        | Keeps completed-rule absence within the settled stale lifecycle     |
| `NOT EVALUATED`                          | `missing`                                 | Distinguishes an unrun rule from a selected rule's absent decision  |
| `remove to reactivate`                   | `disable suppression` without a file path | Gives a concrete, reviewable recovery                               |

The reason is operator-authored terminal text. Keep it to one trimmed line with a documented length
bound; reject control and bidirectional formatting characters. Render it through the existing
terminal-safe text path, preserve its semantic content in machine output, and never interpolate it
into shell commands. Documentation should also tell operators not to put credentials or private
personal data in reasons because they are emitted in reports and may be committed with config.

**Confidence**: High.

## Error Handling

| State / error                        | Human message requirements                                                                | Recovery                                                                                   | Writes / exit recommendation                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Invalid override mapping or field    | Name exact config file and `policy.overrides["<key>"].<field>`; show expected shape/value | Fix or remove the entry, then rerun                                                        | Zero provider/plan writes; exit 1                        |
| Duplicate YAML decision key          | Name the duplicated key; never use last-one-wins                                          | Keep one reviewed entry                                                                    | Zero evaluation/producer work; exit 1                    |
| Unsupported action or skip key       | State “v1 accepts `action: suppress` for three-segment proposal keys only”                | Use an emitted proposal key; do not target a refusal                                       | Exit 1                                                   |
| Unknown `--explain` key              | List current actionable, skip, suppressed, and stale candidate keys                       | Copy a key from the current report                                                         | Existing typed failure envelope; exit 1                  |
| Active suppression                   | `ACTIVE SUPPRESSION`; reason; exact-match statement; decision withheld                    | No recovery required; remove config to reactivate                                          | Evaluation only; no plan/apply for that decision; exit 0 |
| Stale evidence                       | `STALE — REVIEW REQUIRED`; `evidence-changed`; expected/current hash; withholding effect  | Re-review the current proposal, then replace its current fingerprint or remove the record  | Withhold; selected plan/apply lane refuses; nonzero      |
| Proposal changed to ordinary skip    | Keep real skip visible plus `STALE — REVIEW REQUIRED`; `outcome-changed`                  | Review the skip; update only if a proposal later returns; do not suggest hash refresh      | Nothing synthesized or mutated                           |
| Decision absent after completed rule | `STALE — REVIEW REQUIRED`; `decision-absent`; no current decision                         | Check identity, convergence, delete/re-add, and instance; remove only if obsolete          | No mutation; do not suggest hash refresh                 |
| Rule not evaluated                   | `NOT EVALUATED`; exact deselection/disable/degraded cause                                 | Enable/select/fix provider evidence and rerun                                              | No mutation; do not suggest hash refresh                 |
| Cancellation/provider failure        | Preserve standard redacted error envelope and any completed evaluation evidence           | Fix connectivity/credentials or rerun; never infer a disposition from an incomplete report | Existing exit 1 behavior                                 |

### Critical config-loader recovery issue

The current `loadConfig()` contract logs a `ConfigError` and continues to lower-priority files or
an empty config. That behavior is unsafe for a veto: a malformed suppression could disappear and
make the proposal actionable. Policy commands that support `policy.overrides` must fail closed on
an invalid override-bearing config before evaluation, producer calls, or apply. A warning followed
by a normal proposal report is not sufficient.

The error should preserve the exact file and bracketed dynamic-key path and suggest one safe action:
fix the field or remove the entry. Do not print the whole config or secrets. If changing the global
loader is too broad, introduce a strict load result specifically at the policy consumer boundary;
do not document silent fallback as normal recovery for overrides.

**Confidence**: High. The existing loader behavior is explicit in
`packages/rfmedia-cli/src/lib/config.ts`, and silent veto loss is a direct safety failure.

## Performance UX

Override reconciliation should add no progress bar or new loading phase. It is a bounded local map
lookup plus fingerprint calculation after the existing expensive Plex/Lidarr evidence gather. Do
not imply that `--rule`, override count, or active suppressions reduce the full-library track drain;
the current `plex.cache.enabled` guidance remains the repeat-run performance lever.

Repeated evidence-changed recovery requires a new evaluation because the current fingerprint must
describe current proposal evidence. Outcome-changed and decision-absent stale records have no
refresh path. Do not cache or trust the previous report as authorization. Cancellation should retain
current behavior and produce no partial suppression classification from an incomplete run.

For large maps, summarize first and cap only active-suppression detail rows. Stale records, including
decision-absent records, and not-evaluated records are exceptional review work and must remain
visible without `--verbose`.

There is no optimistic update, offline editor, or background refresh in v1. The YAML edit is local;
the next explicit invocation is the verification step.

**Confidence**: High.

## Competitive and Existing-Pattern Analysis

### Shipped `policy evaluate --explain`

Best pattern to retain: a stable key, identity evidence, observations, ordered threshold checks,
exact config paths, and an inert follow-up are shown together. The gap is a copy-grade fingerprint
and disposition block. Extending this view is more coherent than introducing a separate “override
inspect” command.

**Confidence**: High. This is the current presenter contract in
`packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts` and the current operator guide.

### Shipped `policy plan`

Best pattern to retain: complete evidence renders before exit status, global preflight precedes any
artifact write, and policy provenance stays in the wrapper rather than strict v3 artifacts. A stale
selected-scope override naturally belongs in preflight, not in the plan writer.

**Confidence**: High.

### Shipped `sync-ratings`

Best pattern to retain: one embedded policy evaluation drives recommend, plan, and apply, while
machine output remains one clean document. Central classification ensures the presenter and apply
lane cannot disagree. Its existing term `apply` makes “override applied” particularly hazardous
wording.

**Confidence**: High.

### Repository `rfapps harden` suppression reporting

Useful precedent: harden distinguishes proposals, refusals, and suppressed counts in deterministic
human/machine output. Pattern not to copy: suppressed items appear only as a count in the human
summary. Policy overrides are durable operator decisions with staleness, so they need an explicit
section and per-record recovery.

**Confidence**: High. The current guide explicitly states there is no separate harden suppression
section.

### Reviewable mappings in YAML

The mapping form is the right external convention: unique stable keys provide natural lookup and
review diffs, while ordering remains non-semantic. Hash YAML's semantic decision projection, never
raw YAML text, comments, indentation, or map order.

**Confidence**: High, based on YAML 1.2.2 and the existing `.rfmedia.yaml` policy surface.

## Recommendations

### Must have

1. Reuse proposal keys and expose a full fingerprint in `--explain`; show only a labeled short token
   in dense tables.
2. Use reviewable `.rfmedia.yaml` entries with one suppression action, required fingerprint, and
   required reason. Evaluation never edits them.
3. Use `ACTIVE SUPPRESSION`, `STALE — REVIEW REQUIRED`, and `NOT EVALUATED` in human output; retain
   machine statuses `suppressed`, `stale`, and `not-evaluated`, with `evidence-changed`,
   `outcome-changed`, and `decision-absent` stale reasons. Keep non-active rows visible without
   `--verbose`.
4. Preserve explainability after classification: `--explain` lookup must include retained
   suppressed/stale decisions.
5. Withhold active and stale selected-scope proposals from producer/apply paths. Stale is review-
   required quarantine, not a silently inactive veto.
6. Fail closed on malformed override config. Do not inherit the loader's warn-and-fallback behavior
   for a safety control.
7. Keep plan/sync reports explicit about why a cohort is empty and reiterate that suppression alone
   performed no Lidarr mutation.
8. Add full structured override results and counts to JSON/YAML and a distinct CSV row type; never
   overload evaluator skips.

### Should have

1. Emit a copy-ready mapping entry from human `--explain`, with an obviously replaceable rationale.
2. Show short expected/current fingerprints and operator reason in human overview rows; show full
   values in explanation and machine output.
3. Make stale state non-green under `--fail-on proposals`, after rendering all evidence.
4. Give bracketed config paths for dynamic decision keys so the colons are not mistaken for dotted
   path separators.
5. Keep Bash, Zsh, and Fish completion templates unchanged and run parity tests: this workflow adds
   config, not command options.

### Nice to have

1. If prior structured evidence is retained safely, show a compact field-level stale diff.
2. Add a machine-stable remedy code beside human remedy text for automation.
3. Add an aggregate “config hygiene” footer when `stale: decision-absent` records exist for several
   runs. Do not track run history solely to implement this in v1.

## Open Questions

1. Should stale state globally block all `policy plan --mode plan` cohorts or only the affected
   producer? Recommendation: global block, matching the current plan preflight contract.
2. Should a stale selected sync-ratings decision block a healthy sibling decision? Recommendation:
   refuse only the affected decision, matching current sync-ratings isolation, but make partial
   selection unmistakable.
3. Should a zero-actionable, active-suppression-only evaluation retain machine status `clean`, or
   add a distinct status? Recommendation: retain an explicit summary count either way; human output
   must say `NO ACTIONABLE PROPOSALS — N ACTIVE SUPPRESSIONS`.
4. Can the result retain enough previous evidence to produce a trustworthy field-level stale diff?
   If not, omit the diff rather than comparing prose.
5. Are override records portable across Plex/Lidarr origin changes? The UX should name the loaded
   config and origins until the fingerprint contract settles this.

## Uncertainties and Gaps

- Issue #313 requires stale visibility but does not define whether stale suppressions remain
  blocking. This research recommends fail-closed withholding because silent reactivation is the
  more dangerous operator surprise.
- The current loader's warning-and-fallback behavior conflicts with safe veto semantics. The exact
  mechanism for strict policy config loading is an implementation decision, but silent fallback is
  not acceptable UX.
- Existing result types do not retain prior decision material, so a field-level stale diff may not
  be possible without expanding stored config. Expected/current fingerprints plus current evidence
  are sufficient for v1.
- WCAG guidance is applied by analogy; there is no terminal-specific accessibility standard used
  here.

## Sources

- [Issue #313](https://github.com/yandy-r/rfmedia-apps/issues/313) — live issue scope and acceptance
  criteria, accessed 2026-08-06.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md` — current stable-key,
  `--explain`, output, and no-mutation contracts, repository snapshot accessed 2026-08-06.
- `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md` — current embedded-evaluation,
  machine-output, and recommend/plan/apply contracts, repository snapshot accessed 2026-08-06.
- `docs/plans/issue-311-policy-plan/research-ux.md` and
  `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts` — current review/seal and presenter
  patterns, repository snapshot accessed 2026-08-06.
- `packages/rfmedia-cli/src/lib/config.ts` — config warning/fallback behavior, repository snapshot
  accessed 2026-08-06.
- [YAML 1.2.2 specification](https://yaml.org/spec/1.2.2/) — unique, unordered mapping semantics,
  October 2021.
- [W3C WCAG 2.2: Understanding Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color)
  — text/state must not depend on color alone, updated 2025.
- [W3C WCAG 2.2: Understanding Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification)
  — identify invalid input and describe it in text, updated 2026.

No freshness warning is needed: the external sources are stable language/accessibility standards,
and all evolving CLI findings were verified against the current worktree on 2026-08-06.
