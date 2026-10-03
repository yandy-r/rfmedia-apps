# Feature Spec: Lidarr Policy Plan

## Executive Summary

Issue #311 adds `rfmedia lidarr policy plan`, closing the manual-transcription gap between the
read-only policy evaluator and the existing Lidarr plan producers. The command runs the shipped
evaluator once, projects every selected proposal through a pure typed bridge, and defaults to a
zero-write `recommend` result; only explicit `--mode plan` may seal artifacts. Supported profile and
monitoring cohorts reuse the existing fresh-state v3 producers, while discovery, conflicting, or
unprojectable proposals remain explicit refusals and block all sealing. Apply stays a separate,
checksum-pinned authorization step, and the strict v3 artifact schema remains unchanged.

## External Dependencies

### APIs and Services

No new API or service is required. The existing producers own the only required Lidarr reads:

| Endpoint                     | Existing owner                                           | Purpose                                             |
| ---------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| `GET /api/v1/artist`         | `executeLidarrPlan` and `executeLidarrArtistProfilePlan` | Re-read exact artists and seal fresh current state. |
| `GET /api/v1/qualityprofile` | `executeLidarrArtistProfilePlan`                         | Resolve the numeric quality-profile target.         |

The new action must not call Lidarr endpoints directly and must not call a mutation endpoint. The
current [Lidarr API reference](https://lidarr.audio/docs/api/) confirms that the existing generated
client already covers these reads.

### Libraries and SDKs

No new library is needed. Reuse Commander 14, the private generated Lidarr client and handwritten
facade, and the Node.js crypto/filesystem primitives already encapsulated by the v3 plan engine.
Do not refresh code generation or add a second serializer, checksum implementation, SDK, shell
executor, or schema library.

### External Documentation

- [Lidarr API](https://lidarr.audio/docs/api/): current upstream endpoint reference.
- [Commander commands](https://github.com/tj/commander.js/tree/v14.0.3#commands): nested command
  construction used by the existing `policy` parent.
- [Node.js crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html): runtime primitive already
  owned by the plan engine.

## Business Requirements

### User Stories

- As a cautious operator, I want a fresh review of projectable proposals without creating a file.
- As an operator ready to proceed, I want one explicit mode to seal supported proposals without
  applying them.
- As a reviewer, I want every proposal correlated to a cohort or refusal and every artifact
  correlated to its proposal keys, plan ID, and checksum.
- As automation, I want one stable machine result that distinguishes reviewed, no-change, refused,
  sealed, partial, and failed outcomes.
- As a maintainer, I want future producer additions to require an exhaustive projector rather than
  silently disappearing from output.

### Business Rules

1. `--mode` accepts `recommend|plan` and defaults to `recommend`.
2. Recommend mode calls no plan producer and writes no artifact.
3. Plan mode completes a global projection preflight before the first producer call. Any expected
   refusal or malformed proposal blocks every artifact write.
4. Every unique selected proposal key appears exactly once in a projectable cohort or refusal.
5. `artist-profile-assignment` binds by the positive numeric `after["qualityProfileId"]`; display
   names never authorize the target.
6. `artist-monitoring` requires a positive Lidarr artist ID and boolean `after["monitored"]`.
7. `discovery` is an inert, unsupported-plan refusal and is never converted to `artist-add`.
8. Same-artist cross-producer or contradictory intents are refused conservatively in v1.
9. Producers run sequentially in `POLICY_PRODUCER_IDS` order and re-read live Lidarr state.
10. Plan mode never applies. Suggested apply commands pin both returned plan ID and checksum.
11. `policy evaluate` remains behaviorally unchanged and write-free.

### Edge Cases

| Scenario                        | Expected Behavior                                       | Notes                                                  |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| No proposals                    | Successful `no-changes`; zero artifacts in either mode. | Never create an empty plan.                            |
| Discovery proposal              | Visible `unsupported-producer` refusal.                 | Blocks every write in plan mode.                       |
| Malformed producer/target       | Projection error before producer dispatch.              | Programmer-contract failure, not an operator refusal.  |
| Conflicting same-artist intents | Refuse every affected proposal.                         | No cohort receives that artist.                        |
| Live artist/profile disappeared | Existing producer fails closed.                         | Evaluation state is not used as fallback.              |
| Second producer fails           | Typed `partial` result retains the first artifact.      | Never delete the successful artifact as rollback.      |
| Aggregate evaluation degraded   | Inspect selected rule outcomes.                         | Unselected degradation does not block a narrowed plan. |

### Success Criteria

- [ ] `rfmedia lidarr policy plan` defaults to a complete zero-write review.
- [ ] `--mode plan` seals supported proposals through the two existing producers.
- [ ] Unprojectable selected proposals are explicit and cause zero writes in plan mode.
- [ ] The result accounts for every proposal and preserves the full evaluation report.
- [ ] Plan artifacts remain unchanged strict v3 files and apply remains separate and pinned.
- [ ] Bash, Zsh, Fish, Commander, docs, and ROADMAP remain in parity.
- [ ] Critical projection, refusal, orchestration, and completion tests pass without duplicating
      existing plan-engine or apply coverage.

## Technical Specifications

### Architecture Overview

```text
lidarr policy plan command
  -> executeLidarrPolicyPlan
     -> executeLidarrPolicyEvaluate (one fresh evidence pass)
     -> projectPolicyPlan (pure, total, fail-closed)
        -> recommend: return review only
        -> plan: global refusal/invariant gate
           -> executeLidarrArtistProfilePlan
           -> executeLidarrPlan
              -> existing v3 builder + private atomic writer

separate operator step
  -> lidarr apply <path> --expected-plan-id ... --expected-plan-checksum ...
```

The wrapper acquires no scheduler slot because every composed action already owns its `local-only`
lane. It never parses or executes `handoff.argv`, never imports generated client modules, and never
constructs a mutation request body.

### Data Models

Add a focused zero-value-import `types/lidarr-policy-plan.ts` contract:

```ts
export const POLICY_PLAN_MODES = ["recommend", "plan"] as const;
export type PolicyPlanMode = (typeof POLICY_PLAN_MODES)[number];

export type PolicyPlanCohort =
  | {
      readonly producer: "artist-profile-assignment";
      readonly qualityProfileId: number;
      readonly artistIds: readonly number[];
      readonly changes: readonly PolicyPlanChange[];
    }
  | {
      readonly producer: "artist-monitoring";
      readonly monitored: boolean;
      readonly artistIds: readonly number[];
      readonly changes: readonly PolicyPlanChange[];
    };
```

The versioned report includes mode, status, the verbatim `PolicyEvaluationReport`, deterministic
cohorts, refusals, counts, and ordered artifact outcomes. Each outcome retains decision keys plus
the producer-returned path and plan object. Policy provenance stays outside the exact-key v3 plan.

### API Design

This is a CLI-only additive API:

```bash
rfmedia lidarr policy plan [--rule <ids>] [--max-proposals <n>] \
  [--mode recommend|plan] [--explain <key>] [--verbose] \
  [--plex-library <name>] [--plex-url <url>] [--plex-token <token>] \
  [--lidarr-url <url>] [--lidarr-api-key <key>]
```

Do not add `--yes`, `--apply`, `--dry-run`, `--plan-file`, threshold overrides, or proposal-key
selection in v1. Root machine-output options remain inherited rather than redeclared.

### System Integration

#### Files to Create

- `packages/rfmedia-cli/src/types/lidarr-policy-plan.ts`: mode/result/cohort/refusal contracts.
- `packages/rfmedia-cli/src/lib/bridge/policy-plan.ts`: pure total projection and invariant error.
- `packages/rfmedia-cli/src/lib/bridge/policy-plan.test.ts`: critical projection/refusal tests.
- `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts`: evaluate/recommend/seal orchestration.
- `packages/rfmedia-cli/src/actions/lidarr/policy-plan.test.ts`: zero-write and producer routing tests.

#### Files to Modify

- `packages/rfmedia-cli/src/types/index.ts` and `src/actions/lidarr/index.ts`: public barrel exports.
- `packages/rfmedia-cli/src/commands/lidarr-policy.ts`: add and validate the plan leaf.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`: review/refusal/artifact rendering.
- `packages/rfmedia-cli/src/commands/lidarr-policy.test.ts`: critical command contract.
- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts`: child/options/mode routing.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: tri-shell parity.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`,
  `packages/rfmedia-cli/README.md`, and `ROADMAP.md`: operator workflow and delivery state.

No configuration, database, OpenAPI, generated client, v3 plan, apply, claim, history, or operation
definition changes are permitted.

## UX Considerations

### User Workflows

1. `policy plan` validates input, evaluates once, projects every proposal, and labels the run
   `REVIEW ONLY` by default.
2. Human output shows selection, coverage, cohorts, refusals/remedies, and total accounting before
   stating that no artifact was written.
3. When the full selection is sealable, output gives the exact `--mode plan` next step.
4. Plan mode displays each sealed path, plan ID, checksum, and independent pinned apply command.
5. Refused plan mode renders evidence before returning nonzero. Unexpected later failure returns a
   complete partial result with earlier artifact metadata.

### UI Patterns

Use labeled sections and simple tables; color may reinforce but never carry state. Human output
stays on stderr. JSON/YAML/CSV emit exactly one prose-free versioned document on stdout. Reuse the
existing 20-row human cap and `--verbose` behavior without capping machine accounting.

### Accessibility Requirements

- Spell out `REVIEW ONLY`, `SEALED`, `REFUSED`, and `PARTIAL`.
- Never truncate proposal keys, paths, IDs, checksums, refusal codes, or remedy flags.
- Keep completions static and side-effect free; expose identical child, option, and mode values in
  Bash, Zsh, and Fish.
- Group help under Selection, Safety, Output, and Connection and state clearly that the leaf never
  applies.

## Recommendations

### Implementation Approach

1. Define the closed result contracts and implement the pure projector with total-accounting and
   global-preflight invariants.
2. Add the thin action, dependency injection, deterministic sequential sealing, and typed partial
   outcome.
3. Register/present the command and update completion templates in one compatibility change.
4. Update docs and ROADMAP, then run focused tests followed by full package, architecture, codegen,
   typecheck, build, formatting, and markdown gates.

### Technology Decisions

| Decision           | Recommendation                         | Rationale                                                                   |
| ------------------ | -------------------------------------- | --------------------------------------------------------------------------- |
| Safety syntax      | `recommend\|plan`, default `recommend` | Matches `sync-ratings` without adding an apply rung.                        |
| Projection         | Pure exhaustive bridge                 | Makes omissions and future producer drift fail closed.                      |
| Artifact authority | Existing producers only                | Preserves fresh-state reads and the v3 safety contract.                     |
| Refusal gate       | Global in plan mode                    | Prevents a valid-looking artifact for an incomplete selection.              |
| Paths              | Existing producer defaults             | Avoids an ambiguous one-path/many-artifact option.                          |
| Tests              | Critical seams only                    | Existing suites already own checksums, storage, apply, and client behavior. |

### Future Enhancements

Defer proposal-key selectors, output-directory controls, discovery execution, producer plugins,
apply/auto-apply, aggregate artifacts, plan provenance fields, same-artist compatibility rules,
recency/override work, and any generic sync-ratings refactor.

## Risk Assessment

### Technical Risks

| Risk                            | Likelihood | Impact   | Mitigation                                                     |
| ------------------------------- | ---------- | -------- | -------------------------------------------------------------- |
| Silently incomplete artifact    | Medium     | Critical | Total proposal accounting and global preflight.                |
| Evidence used as authority      | Low        | Critical | Route only IDs/desired targets into fresh-state producers.     |
| Partial second-producer failure | Low        | High     | Sequential order and typed preservation of completed outcomes. |
| Live-state drift                | Medium     | High     | Existing producers re-read Lidarr and apply later revalidates. |
| Shell/Commander drift           | Medium     | Medium   | Shared constants and exact Bash/Zsh/Fish parity tests.         |
| Credential/metadata leakage     | Low        | High     | Shared redaction and one machine envelope.                     |

### Security Considerations

#### Critical — Hard Stops

| Finding                               | Risk                                 | Required Mitigation                                                                        |
| ------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Policy evidence becomes authorization | Unreviewed mutation authority        | No apply path, argv execution, direct mutation, or evaluation-state artifact construction. |
| A proposal is omitted                 | Artifact authorizes the wrong subset | Complete preflight and exact cohort/refusal accounting before the first write.             |

#### Warnings — Must Address

| Finding                          | Risk                    | Mitigation                                                       | Alternatives                    |
| -------------------------------- | ----------------------- | ---------------------------------------------------------------- | ------------------------------- |
| State changes after evaluation   | Stale `before` evidence | Reuse live-state producers and numeric profile IDs.              | None in scope.                  |
| Independent artifact writes      | Partial durable output  | Preserve and disclose completed outcomes; never rollback-delete. | Aggregate transaction deferred. |
| Report contains secrets/metadata | Disclosure              | Redact raw credentials and preserve stdout/stderr separation.    | Operator retention policy.      |

#### Advisories — Best Practices

- Add no dependency and no wrapper scheduler slot.
- Keep results frozen and producer/refusal routing exhaustive.
- Retain machine reports beside artifacts when policy provenance is operationally important.

## Task Breakdown Preview

### Phase 1: Contracts and Projection

**Focus**: Define result unions and prove total, deterministic, fail-closed projection.

- Add focused types and projector.
- Add critical supported/refusal/conflict/invariant tests.

**Parallelization**: Type/projector work may proceed alongside completion/doc impact analysis.

### Phase 2: Action and Command

**Focus**: Compose evaluate with review/seal behavior and expose the CLI contract.

- Add orchestration and partial-result handling.
- Add command validation, rendering, and focused tests.

**Dependencies**: Phase 1 contracts and projector.

### Phase 3: Parity and Verification

**Focus**: Complete shell/docs/ROADMAP parity and repository gates.

- Update Bash, Zsh, Fish, and their parity tests.
- Update feature docs, README, and ROADMAP.
- Run focused and full validation, review/fix, and PR lifecycle gates.

## Decisions Needed

No product decision remains open for implementation. The design fixes the v1 syntax, refusal gate,
selection scope, output-path behavior, artifact order, partial-failure semantics, and deferred work.

## Research References

- [research-external.md](./research-external.md): API and dependency analysis.
- [research-business.md](./research-business.md): requirements and business rules.
- [research-technical.md](./research-technical.md): architecture and exact producer contracts.
- [research-ux.md](./research-ux.md): operator workflow and output behavior.
- [research-security.md](./research-security.md): severity-ranked security constraints.
- [research-practices.md](./research-practices.md): reuse, KISS, and test scope.
- [research-recommendations.md](./research-recommendations.md): final decisions and phasing.
