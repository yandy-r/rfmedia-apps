# Recommendations: Policy Decision Overrides

## Executive Summary

Issue #313 should ship as a configuration-backed, suppression-only safety control for existing
policy proposals. An operator records `action: suppress`, a stable proposal key, a versioned
evidence fingerprint, and a required reason in `.rfmedia.yaml`. An exact match removes that
proposal from the actionable collection without changing rule truth, proposal contents, or
mutation authority.

Use one pure post-cap classification pass in the policy engine. Active and stale disputes are both
withheld before `policy plan` and `sync-ratings` consume `report.proposals`; unrelated proposals
may continue. Invalid configuration must be fatal for override-sensitive commands, and the
fingerprint must bind canonical Plex/Lidarr origins plus the selected Plex library so instance-local
IDs cannot suppress a decision in another environment.

## Key Decisions and Conflict Resolutions

| Topic              | V1 decision                                                                                | Rationale                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Meaning            | An override record has only `action: suppress`                                             | Force/allow/custom desired state could bypass identity and mutation gates                       |
| Target             | Accept only existing three-segment proposal keys; reject skip keys                         | Skips are already inert and have no safe desired state or handoff                               |
| Identity           | Keep the shipped non-rotating decision key                                                 | Operators can rediscover the subject after evidence changes                                     |
| Review pin         | SHA-256 over an explicit, versioned semantic tuple                                         | A stable key alone cannot prove reviewed evidence is current                                    |
| Scope binding      | Include canonical `plexOrigin`, `lidarrOrigin`, and resolved `plexLibrary`                 | Instance-local IDs make false cross-environment matches more dangerous than reduced portability |
| Stale match        | Withhold centrally and report `stale`; never silently reactivate                           | Evidence drift beneath a dispute requires review before mutation                                |
| Stale blast radius | Quarantine only the matched proposal; unrelated proposals may proceed                      | One central filter is safe and avoids consumer-specific refusal algorithms                      |
| Missing decision   | `stale: decision-absent` if the selected rule completed; `not-evaluated` if it did not run | Keeps a small state model while distinguishing obsolete from inconclusive evidence              |
| Caps               | Classify after existing caps and never refill                                              | Refill would change ranking and expose a previously non-selected candidate                      |
| Loading            | Highest-precedence existing config must parse and validate completely                      | Warn-and-fallback can silently erase a veto                                                     |
| Versioning         | Bump policy evaluation schema/engine only                                                  | Proposal/count meaning changes; sealed plan and outer plan/sync contracts do not                |
| Old artifacts      | Overrides govern new evaluations and same-run projection only                              | Existing producer artifacts carry no policy decision key for retroactive revocation             |

Security wins the origin/library conflict: overrides are local operational policy, so environment
portability is secondary to preventing an incorrect match. Practices wins the status-taxonomy
conflict: public states are `suppressed`, `stale`, and `not-evaluated`; “unmatched” is represented
as `staleReason: decision-absent` rather than a fourth lifecycle state.

## Recommended Contract

```yaml
policy:
  overrides:
    "stale-monitoring-cleanup:artist:233":
      action: suppress
      evidenceFingerprint: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      reason: "Compilation listening is not represented by the artist-name play join"
```

Validation must:

- require a plain/null-prototype map, own enumerable keys, and a bounded entry count;
- reject prototype-like keys, inherited fields, arrays, class instances, and unsafe coercion;
- accept registered proposal rule prefixes and canonical artist/Plex proposal-key shapes only;
- require exactly `action`, `evidenceFingerprint`, and `reason`;
- accept only `action: suppress` and `^sha256:[0-9a-f]{64}$`;
- require a trimmed, non-empty, bounded reason without control or bidi characters;
- report exact bracketed dynamic-key paths via `describeType()`-style errors; and
- build runtime lookup with `Map`, not an operator-keyed `{}`.

Use a conservative v1 ceiling of 500 entries and 500 Unicode scalar values per reason, plus
documented UTF-8 byte limits. These bounds can be revised with operational evidence.

```ts
type PolicyOverrideStatus = "suppressed" | "stale" | "not-evaluated";
type PolicyOverrideStaleReason = "evidence-changed" | "outcome-changed" | "decision-absent";
```

Each result carries key, action, status, nullable stale reason, operator reason, expected/current
fingerprints, and nullable current proposal/skip. Exact proposal/hash is `suppressed`; changed
proposal is `stale: evidence-changed`; proposal-to-skip is `stale: outcome-changed`; completed-rule
absence is `stale: decision-absent`; unrun rules are `not-evaluated`.

`report.proposals` and per-rule `proposedCount` contain only actionable proposals after
classification. Add summary counts for suppressed, stale, and not-evaluated overrides. Keep
evaluator skips distinct from operator judgments.

Retain the current machine status union for minimal compatibility, but never render a stale-only
run as simply `CLEAN`. Show `REVIEW REQUIRED`, and make evaluate's existing
`--fail-on proposals` fail after rendering when stale records exist. Active suppressions alone do
not fail the gate.

## Fingerprint Contract

Fingerprint proposals only, after caps and once report scope is known. Hash a domain-separated
explicit tuple containing:

1. fingerprint schema literal;
2. canonical credential-free Plex origin, Lidarr origin, and resolved Plex library;
3. key, rule id, and proposal code;
4. subject kind, Plex id, Lidarr id/null, and artist MBID;
5. identity category and reason;
6. sorted `before` and `after` scalar entries;
7. ordered check tuples: signal, comparator, bound, observed, satisfied, config path;
8. observations sorted by signal with value, availability, provenance/join grade, and sample size;
9. handoff producer.

Exclude timestamps, subject display name, summaries/details, report order, reason, and handoff argv.
Use code-unit ordering, preserve meaningful array order, require finite valid JSON values, encode
UTF-8, and return `sha256:<64 lowercase hex>`. Canonicalization failure must block the run.

Proposal factories lack report scope. The post-cap module should therefore create frozen
report-grade proposal copies bearing `evidenceFingerprint`; do not pass origins through every rule
or weaken the scope binding. Skips need no fingerprint because v1 cannot target them.

## Implementation Recommendations

1. Create `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts` containing the explicit tuple,
   SHA-256 formatting, indexed matching, classification, filtering, and frozen results. Avoid a
   generic disposition framework or shared canonical-JSON abstraction.
2. Run it once in `runLidarrPolicyEvaluation()` after cap/refusal attribution and before final
   counts/status/freezing. Remove active and stale matches from final `report.proposals`; do not
   mutate decisions or refill caps.
3. Extend `loadConfig()` with fail-on-invalid behavior selected by the CLI pre-action hook for
   `lidarr policy evaluate`, `lidarr policy plan`, and `lidarr sync-ratings`. The first existing
   config file is authoritative; any parse/template/validation failure exits before gather,
   producer, prompt, seal, or apply. Keep unrelated commands permissive in v1.
4. Bump the policy evaluation contract to v2. Add explicit override rows to JSON/YAML/CSV and an
   always-visible human section. Extend `--explain` to suppressed/stale keys, print full fingerprints,
   and show manual replace-or-remove recovery. Never auto-edit or auto-refresh config.
5. Leave `projectPolicyPlan()` and `buildRatingSyncPlan()` free of matching logic. They consume the
   central actionable array. Reports must name withheld decisions, and fully withheld runs call no
   producer, prompt, writer, or apply dependency.

Prefer `active suppression`, `withheld from producer cohort`, and `stale — review required`; avoid
`override applied`, which conflicts with Lidarr apply terminology.

## Relevant Files

- `packages/rfmedia-cli/src/types/config.ts`: closed suppression config types.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts`: report-grade fingerprints, override results,
  v2 schema, and counts; retain zero value imports.
- `packages/rfmedia-cli/src/lib/config.ts` and `packages/rfmedia-cli/src/cli.ts`: dynamic validation
  and command-scoped strict loading.
- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`: pure fingerprint/classification module.
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`: central classification and recount.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`: human, explain, and CSV output.
- `packages/rfmedia-cli/src/lib/bridge/policy-plan.ts` and `rating-sync.ts`: unchanged projectors;
  add boundary regression coverage only.
- `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts` and `sync-ratings.ts`: retain mutation
  ladders and prove zero calls for fully withheld inputs.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`, README, and the existing example
  policy block: document review, recovery, privacy, and old-artifact limits.

## Critical Tests

1. Golden fingerprint: order/timestamp/display/prose changes are stable; origin, library, IDs/MBID,
   identity, code, thresholds, observations, before/after, or producer changes rotate it.
2. Active suppression removes exactly one proposal, preserves evidence/reason, recounts totals,
   leaves unrelated proposals, and does not refill the cap.
3. Evidence drift yields `stale`, withholds only the match, shows both hashes, and trips evaluate's
   fail gate after output.
4. Proposal-to-skip preserves the skip and reports outcome-changed; completed-rule absence reports
   decision-absent; disabled/deselected/blocked rules report not-evaluated; nothing is synthesized.
5. Invalid highest-priority YAML, duplicate keys, or invalid override aborts evaluate/plan/sync
   before fallback or any gather/producer/prompt/apply call.
6. Malformed keys/actions/hashes/reasons, unknown/inherited/prototype fields, hostile coercion,
   oversize values, controls/bidi, and skip keys yield bounded exact-path errors without pollution.
7. Active/stale decisions never enter plan/sync cohorts; fully withheld inputs make zero mutation
   calls; unrelated proposals still project.
8. V2 human/JSON/YAML/CSV/explain output carries full review state, consistent counts, guarded CSV
   reasons, and visible stale/not-evaluated records.
9. Credential sentinels never enter fingerprints/reports; new modules import no clients, writers,
   adapters, or apply actions; reports remain frozen and policy types keep zero value imports.
10. Relevant package/architecture suites pass; Bash/Zsh/Fish parity passes with no template diff;
    outer plan/sync and sealed plan schemas remain unchanged.

## Risk Assessment

| Severity | Risk                                                   | Mitigation                                                             |
| -------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Critical | Force-like action bypasses safety gates                | Closed suppression-only action                                         |
| Critical | Presenter/fail-open matching leaves dispute actionable | One engine-owned filter for active and stale matches                   |
| Critical | Invalid config silently erases overrides               | Strict highest-precedence loading on all sensitive paths               |
| High     | IDs collide across instances/libraries                 | Bind canonical origins/library plus IDs and MBID                       |
| High     | Serialization drift changes matching                   | Explicit tuple, deterministic ordering, golden vectors, schema version |
| High     | Config map/reason attacks output or prototypes         | Own-key validation, `Map`, bounds, terminal checks, CSV guard          |
| Medium   | Machine consumers misread new counts                   | Policy evaluation v2 and explicit rows/counts                          |
| Medium   | Stale quarantine reduces availability                  | Withhold only matched decision; visible manual recovery                |
| Medium   | Old artifact remains usable                            | Document boundary; future snapshot-bound revocation if needed          |
| Low      | Local hashing costs time                               | Small bounded tuple, no new provider pass                              |

## Alternatives

| Alternative                     | Decision                                                          |
| ------------------------------- | ----------------------------------------------------------------- |
| SQLite/JSON store               | Reject: adds writers, migrations, precedence, and hidden state    |
| Content-addressed decision key  | Reject: rotating identity breaks rediscovery                      |
| Fingerprint without scope       | Reject: unsafe with instance-local IDs                            |
| Scope fields beside hash        | Defer: larger config contract; scope-bound hash is sufficient     |
| Generic JCS dependency          | Reject: bounded explicit tuple avoids supply-chain/semantic drift |
| Fingerprint/override skips      | Reject: skips are already non-actionable                          |
| Let stale reactivate            | Reject: unsafe silent behavior                                    |
| Globally block all plan cohorts | Reject: unnecessary blast radius and extra consumer logic         |
| Separate `unmatched` status     | Reject: use `stale: decision-absent`                              |
| Make all config loading strict  | Defer: unrelated compatibility change                             |

## Phased Implementation

1. **Contracts/input (medium):** config/report types, v2 constants, validator, strict loader, and
   fail-before-work tests.
2. **Pure core (medium):** scope-bound fingerprint vectors and table-driven classification.
3. **Engine/consumers (medium):** central filter/recount plus plan/sync exclusion tests.
4. **Presentation/docs (medium):** human/machine/explain output and manual workflow documentation.
5. **Audit (small):** focused/full relevant tests, architecture gates, completion parity, and scope
   review confirming no artifact/database/client/dependency changes.

## Deferred Improvements

- Snapshot-bind a future artifact version if retroactive revocation becomes required.
- Add list/add/remove commands only if manual YAML proves inadequate; never auto-accept stale data.
- Add field-level stale diffs only if prior structured evidence can be retained safely.
- Add remedy codes or privacy controls for automation/shared reports.
- Consider a stable Plex library identifier when available without new provider work.
- Design any second action as a separate threat-modeled issue.

## Non-Goals

- Forced proposals, skip conversion, custom desired states/producers, or changed rule semantics.
- New signals/entities, cap refill, config editor, automatic refresh, or background lifecycle.
- Database/store, signature system, external API, SDK, or dependency.
- Plan v3/apply/history/claims/scheduler/client/adapter/cache changes.
- Retroactive cancellation of old artifacts, new CLI options, or completion-template edits.

## Completion Criteria

Issue #313 is complete when strict config accepts only proposal suppression records; fingerprints
are deterministic, credential-free, and scope/evidence-bound; exact matches suppress while drift
is visibly stale and fail-closed; counts and every output format agree; plan/sync cannot project a
withheld decision; unrelated proposals remain eligible; fully withheld runs perform no mutation or
artifact work; critical and architecture tests pass; completion parity is unchanged; and docs state
manual recovery plus the old-artifact limitation.

## Relevant Research

- `docs/plans/issue-313-policy-overrides/research-{external,business,technical,ux,security,practices}.md`
- `packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md`
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`
- [GitHub issue #313](https://github.com/yandy-r/rfmedia-apps/issues/313)
