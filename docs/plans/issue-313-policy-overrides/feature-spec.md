# Feature Spec: Policy Decision Overrides

## Executive Summary

Issue #313 adds a durable, reviewable veto for one existing Lidarr consumption-policy proposal
without changing rule semantics or granting mutation authority. Operators copy a proposal's stable
decision key and scope-bound evidence fingerprint into `.rfmedia.yaml` with `action: suppress` and
a required rationale. A pure post-cap engine pass withholds exact matches and quarantines stale
matches before `policy plan` or `sync-ratings` can consume them, while unrelated proposals remain
eligible. The policy evaluation report moves to v2, override-sensitive commands load configuration
strictly, and the sealed-plan/apply/database/client/completion contracts remain unchanged.

## External Dependencies

### APIs and Services

No new external API, service, authentication flow, or network request is required. Plex and Lidarr
remain evidence sources only through the existing policy gatherers. Override matching performs no
provider I/O and owns no client, adapter, writer, scheduler, or database handle.

### Libraries and SDKs

| Capability         | Existing dependency                | Decision                                           |
| ------------------ | ---------------------------------- | -------------------------------------------------- |
| YAML input         | `js-yaml` 4.3.0 with `CORE_SCHEMA` | Reuse the existing config loader.                  |
| SHA-256            | Node.js 22 `node:crypto`           | Use `createHash`; add no package.                  |
| Canonical evidence | None                               | Hash an explicit domain tuple; add no JCS library. |

### External Documentation

- [Node.js 22 crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html): built-in SHA-256 API.
- [YAML 1.2.2](https://yaml.org/spec/1.2.2/): mapping and scalar semantics.
- [RFC 8785](https://datatracker.ietf.org/doc/html/rfc8785): determinism reference only; no new
  canonicalization dependency is added.

## Business Requirements

### User Stories

- As an operator, I can dispute one proposal without weakening a threshold for every artist.
- As a reviewer, I can see the exact evidence and environment against which the dispute was made.
- As automation, I can distinguish actionable proposals, evaluator skips, active suppressions,
  stale overrides, and records whose rules did not run.
- As a plan/sync operator, I can trust that active or stale disputed proposals never reach a
  producer or apply lane unless I explicitly refresh or remove the record.

### Business Rules

1. `.rfmedia.yaml` is the sole v1 durable state; no local store or config writer is added.
2. `policy.overrides` is keyed by an existing three-segment proposal key. Four-segment skip keys
   are invalid because skips are already inert and have no safe desired state or handoff.
3. `action: suppress` is the only v1 action. Force, allow, alternate desired values, and
   skip-to-proposal conversion are prohibited.
4. Each entry requires a full `sha256:<64 lowercase hex>` evidence fingerprint and a non-empty,
   terminal-safe rationale.
5. Exact key plus exact fingerprint becomes `suppressed`; the proposal is withheld.
6. Same key with changed evidence becomes `stale: evidence-changed`; it is also withheld pending
   review rather than silently reactivated.
7. A matching subject that now produces a skip becomes `stale: outcome-changed`; the real skip
   remains visible and no proposal is synthesized.
8. A selected, completed rule that no longer emits the subject becomes
   `stale: decision-absent`; a rule that was disabled, deselected, or blocked is `not-evaluated`.
9. Classification runs after existing proposal caps and never refills a cap from previously
   excluded candidates.
10. Invalid highest-precedence configuration is fatal for `lidarr policy evaluate`,
    `lidarr policy plan`, and `lidarr sync-ratings`; these commands never warn-and-fallback to an
    empty or lower-priority config.
11. Overrides govern new evaluations and same-run projection only. They do not revoke already
    sealed plan artifacts.

### Edge Cases

| Scenario                                                                       | Expected behavior                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Input/report ordering or display prose changes                                 | Key and fingerprint remain stable.                                  |
| Rating, plays, threshold, identity, current/desired state, or producer changes | Key stays stable; fingerprint rotates and the dispute is stale.     |
| Canonical Plex/Lidarr origin or Plex library changes                           | Fingerprint rotates to prevent cross-environment suppression.       |
| Provider id is reused for a different artist                                   | Identifier/MBID evidence rotates the fingerprint.                   |
| One of several proposals is stale                                              | Only that proposal is quarantined; unrelated proposals may proceed. |
| Every proposal is suppressed/stale                                             | No producer, plan writer, prompt, or apply dependency is called.    |
| Rule is narrowed out with `--rule`/`--decision`                                | Its override is `not-evaluated`, not falsely stale.                 |
| Malformed YAML or override entry                                               | Sensitive command exits before evidence gathering or mutation work. |

### Success Criteria

- [ ] Valid config suppresses exactly one matching proposal and preserves its evidence/rationale.
- [ ] Human, JSON, YAML, CSV, and `--explain` distinguish suppression and staleness.
- [ ] Stable-key and evidence-rotation behavior is deterministic and tested.
- [ ] Active and stale disputes never enter policy-plan or sync-ratings cohorts.
- [ ] Override-sensitive commands fail closed on invalid authoritative config.
- [ ] Evaluate remains read-only and no new mutation/store path exists.
- [ ] Bash, Zsh, and Fish parity remains green with no template changes.

## Technical Specifications

### Architecture Overview

```text
.rfmedia.yaml policy.overrides
          |
          v
strict config load -> existing gather/rules/caps -> policy-overrides.ts
                                               |-> actionable proposals
                                               |-> suppression/stale results
                                                        |
             +----------------------+-------------------+------------------+
             v                      v                                      v
       policy presenter       policy-plan projector                rating-sync projector
                                      |                                      |
                              existing seal boundary                 existing mode ladder
                                      +-------------------+------------------+
                                                          v
                                               separate guarded Lidarr apply
```

Matching belongs in one pure bridge module and runs once in `runLidarrPolicyEvaluation()` after
rule evaluation/caps and before final counts/freezing. Presenters and downstream consumers never
reimplement the filter.

### Data Models

```ts
export interface PolicyOverrideConfigOptions {
  readonly action: "suppress";
  readonly evidenceFingerprint: `sha256:${string}`;
  readonly reason: string;
}

export type PolicyOverrideStatus = "suppressed" | "stale" | "not-evaluated";
export type PolicyOverrideStaleReason = "evidence-changed" | "outcome-changed" | "decision-absent";

export interface PolicyEvaluatedProposal extends PolicyProposal {
  readonly evidenceFingerprint: PolicyDecisionEvidenceFingerprint;
}

export interface PolicyOverrideResult {
  readonly key: PolicyDecisionKey;
  readonly action: "suppress";
  readonly status: PolicyOverrideStatus;
  readonly staleReason: PolicyOverrideStaleReason | null;
  readonly reason: string;
  readonly expectedEvidenceFingerprint: PolicyDecisionEvidenceFingerprint;
  readonly currentEvidenceFingerprint: PolicyDecisionEvidenceFingerprint | null;
  readonly decision: PolicyEvaluatedProposal | PolicySkip | null;
}
```

`PolicyConfigOptions` adds a read-only override record. `PolicyEvaluationReport.proposals` becomes
the frozen report-grade proposal subtype, adds `overrides`, and its summary adds `suppressed`,
`staleOverrides`, and `notEvaluatedOverrides`. Per-rule `proposedCount` and report `proposed` count
only actionable proposals. Bump `POLICY_EVALUATION_SCHEMA` and `POLICY_ENGINE_VERSION` to v2; do
not change the outer policy-plan/sync schemas or sealed Lidarr plan v3.

### Fingerprint Contract

Hash a domain-separated explicit tuple after report scope is known:

1. fingerprint schema literal;
2. canonical credential-free Plex origin, Lidarr origin, and resolved Plex library;
3. key, rule id, and proposal code;
4. subject kind, Plex id, Lidarr id/null, and artist MBID;
5. identity category and reason;
6. sorted `before` and `after` scalar entries;
7. threshold checks in evaluation order;
8. observations sorted by signal with value/gap, join grade, and sample size;
9. handoff producer.

Exclude timestamps, display names, summaries/details, operator reason, report order, credentials,
and `handoff.argv`. Preserve meaningful array order, reject non-finite/non-JSON evidence, encode
UTF-8, and return lowercase `sha256:` hex. A canonicalization failure aborts evaluation.

### Configuration Validation

```yaml
policy:
  overrides:
    "stale-monitoring-cleanup:artist:233":
      action: suppress
      evidenceFingerprint: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      reason: "Compilation listening is not represented by the artist-name play join"
```

Require own enumerable keys on a plain/null-prototype map; reject arrays, inherited/prototype-like
keys, unsafe coercion, unknown fields, controls/bidi, malformed rule/subject keys, and more than
500 entries. Require exact entry keys and a reason that is already trimmed, non-empty, no more than
512 UTF-8 bytes, and free of C0/C1 controls plus bidi controls `U+061C`, `U+200E-U+200F`,
`U+202A-U+202E`, and `U+2066-U+2069`. Runtime lookup uses `Map`.
Dynamic-key errors cite bracketed paths such as
`policy.overrides["stale-monitoring-cleanup:artist:233"].evidenceFingerprint`.

Extend `loadConfig()` with fail-on-invalid behavior and select it from the CLI pre-action hook only
for the three override-sensitive command paths. Parsing, template, validation, and read failures
on the first existing config abort rather than continuing the search.

### API Design

No CLI option is added. The workflow uses the existing commands:

```bash
rfmedia lidarr policy evaluate --explain <proposal-key>
# edit .rfmedia.yaml
rfmedia lidarr policy evaluate --explain <proposal-key>
rfmedia lidarr policy plan --mode plan
rfmedia lidarr sync-ratings --mode apply
```

`--explain` prints the full copy-grade fingerprint, disposition, expected/current hashes, reason,
and replace-or-remove recovery. Human tables may shorten fingerprints only as recognition aids.
JSON/YAML carry full v2 objects; CSV adds fixed override rows and uses the existing formula guard.
Stale records are always visible and trip the existing `--fail-on proposals` gate after rendering.

### System Integration

#### Files to Create

- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`: tuple fingerprinting, matching,
  filtering, classification, and frozen results.
- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.test.ts`: deterministic hash/classifier
  contracts.

#### Files to Modify

- `packages/rfmedia-cli/src/types/config.ts`: override input types.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts`: v2 proposal/result/report/count contracts.
- `packages/rfmedia-cli/src/lib/config.ts`: dynamic-map validation and strict load mode.
- `packages/rfmedia-cli/src/cli.ts`: strict-mode selection for policy/sync paths.
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`: central post-cap classification/recount.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`: human, explain, and CSV output.
- Focused existing config/engine/command/plan/rating-sync tests for integration boundaries.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`,
  `packages/rfmedia-cli/README.md`, and `ROADMAP.md`: workflow, safety, recovery, and delivery state.

No rule, provider, client, generated-code, database, scheduler, plan-artifact, apply, history, claim,
or shell-completion source changes are permitted.

## UX Considerations

### User Workflows

1. Evaluate and locate the proposal key.
2. Run `--explain` and review identity, observations, thresholds, before/after, producer, and the
   full evidence fingerprint.
3. Add a quoted config entry with a real rationale.
4. Re-run and verify `ACTIVE SUPPRESSION`, `STALE — REVIEW REQUIRED`, or `NOT EVALUATED` in text,
   not color alone.
5. For stale state, re-review and replace the fingerprint or remove the record. Nothing refreshes
   config automatically.

### Error Recovery

Invalid config must name the file and exact property path, state that no override-sensitive work
ran, and tell the operator to repair or remove the entry. Stale output shows both hashes and the
current decision/skip evidence. Use “active suppression” and “withheld from producer cohort”; avoid
“override applied,” which conflicts with Lidarr apply terminology.

### Accessibility and Output Safety

- Never rely on color for status or truncate a copy-grade fingerprint.
- Keep human output on stderr and one prose-free machine document on stdout.
- Render rationale through existing terminal-safe and CSV-formula-safe paths.
- Do not include tokens, credential-bearing URLs, or unnecessary PII in hashes/reports.

## Recommendations

### Implementation Approach

1. Add closed config/report contracts and strict loading.
2. Implement the pure fingerprint/classifier with golden vectors and table-driven states.
3. Integrate once in the engine and prove plan/sync consumers receive only actionable proposals.
4. Add presenter output, docs, ROADMAP, and a no-change tri-shell completion audit.

### Technology Decisions

| Decision             | Recommendation                        | Rationale                                          |
| -------------------- | ------------------------------------- | -------------------------------------------------- |
| State                | `.rfmedia.yaml` mapping               | Reviewable; no writer/migration/precedence system. |
| Action               | `suppress` only                       | Cannot bypass evaluator safety gates.              |
| Identity             | Stable key plus rotating hash         | Rediscovery and staleness are separate concerns.   |
| Scope                | Bind origins and library              | Provider ids are instance-local.                   |
| Stale                | Quarantine matched proposal centrally | Fail closed without global blast radius.           |
| Hashing              | Explicit tuple plus `node:crypto`     | Deterministic, inspectable, dependency-free.       |
| Consumer integration | Filter `report.proposals` once        | Prevents presenter/plan/sync disagreement.         |

### Future Enhancements

Defer management commands, additional actions, skip disputes, field-level evidence diffs, automatic
refresh, stable provider library ids, store/database state, and retroactive artifact revocation.

## Risk Assessment

### Technical Risks

| Risk                                    | Likelihood        | Impact   | Mitigation                                        |
| --------------------------------------- | ----------------- | -------- | ------------------------------------------------- |
| Invalid config silently erases veto     | Existing behavior | Critical | Strict sensitive-command loading.                 |
| Force-like override bypasses safety     | Low               | Critical | Closed suppression-only action.                   |
| Presenter-only filtering mutates anyway | Medium            | Critical | Engine-owned filter before consumers.             |
| Cross-instance id collision             | Low               | High     | Scope-bound fingerprint plus ids/MBID.            |
| Serialization drift                     | Medium            | High     | Explicit tuple, schema literal, golden vectors.   |
| Stale quarantine reduces availability   | Medium            | Medium   | Withhold only matched proposal; visible recovery. |
| Machine consumer contract drift         | Medium            | Medium   | Evaluation v2 and explicit counts/rows.           |

### Security Considerations

#### Critical — Hard Stops

- Do not add force/allow/custom desired state or skip conversion.
- Active and stale matches must be absent from final actionable proposals.
- Invalid authoritative config must abort every override-sensitive path before work.

#### Warnings — Must Address

- Validate operator-controlled mapping keys/reasons without coercion or prototype pollution.
- Bind fingerprint scope, reject non-canonical evidence, and exclude credentials/prose.
- Keep stale visible and prevent it from becoming a clean-looking mutation path.

#### Advisories — Best Practices

- Keep the new module pure, frozen, bounded, and dependency-free.
- Document that old sealed artifacts are unaffected and should be independently reviewed.

## Task Breakdown Preview

### Phase 1: Contracts and Input Safety

- Add config/report v2 contracts and exact validation.
- Add strict config loading for the three sensitive command paths.

**Parallelization**: Type/validator work can run alongside pure fingerprint fixture design when file
ownership is disjoint.

### Phase 2: Pure Classification and Engine Integration

- Implement scope-bound fingerprinting and override reconciliation.
- Integrate post-cap filtering, recounting, status/fail-gate behavior, and immutability.

**Dependencies**: Phase 1 report/config contracts.

### Phase 3: Presentation, Consumer Boundaries, and Docs

- Add human/CSV/explain output and focused plan/sync boundary tests.
- Update feature docs, package README, ROADMAP, and completion audit evidence.

**Parallelization**: Presentation and documentation work can proceed in parallel after report shape
stabilizes.

## Decisions Needed

No blocking product decision remains. V1 is proposal-only and suppression-only; stale proposals are
centrally quarantined; fingerprint scope is environment-bound; strict loading is command-scoped;
and no CLI/completion/store/artifact changes are allowed.

## Research References

- [research-external.md](./research-external.md): dependencies and deterministic hashing sources.
- [research-business.md](./research-business.md): user rules and plan/sync workflows.
- [research-technical.md](./research-technical.md): architecture and exact contracts.
- [research-ux.md](./research-ux.md): operator workflow and output/error behavior.
- [research-security.md](./research-security.md): hard stops and threat model.
- [research-practices.md](./research-practices.md): KISS, reuse, and critical-test scope.
- [research-recommendations.md](./research-recommendations.md): resolved cross-research decisions.
