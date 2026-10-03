# Feature Spec: rfapps Reconciliation Command

## Executive Summary

Issue #151 adds a top-level `rfapps reconcile` command that compares resolved Docker Compose
intent with live Docker state, explains every difference, proposes deterministic service actions,
and stops without mutation by default. `--auto-apply` promotes that same report into a bounded,
same-process convergence cycle: it freezes scope, acquires the existing lifecycle lock, revalidates
the reviewed authority and actions, remediates eligible services, and re-observes the final state.
It reuses shipped drift detection and managed-update safety primitives instead of creating another
deployment engine. Docker's host-level authority, stale observations, secret-bearing data, and
accidental scope widening are release gates.

## External Dependencies

### APIs and Services

#### Docker Compose CLI

- **Documentation**: [Docker Compose CLI](https://docs.docker.com/reference/cli/docker/compose/),
  [`compose config`](https://docs.docker.com/reference/cli/docker/compose/config/),
  [`compose ps`](https://docs.docker.com/reference/cli/docker/compose/ps/), and
  [`compose up`](https://docs.docker.com/reference/cli/docker/compose/up/)
- **Authentication**: Existing local socket, Docker context, SSH, or mutual-TLS authority
- **Key operations**:
  - `config --format json`: resolve the effective desired model
  - `ps --all --format json`: enumerate running and stopped project containers as JSON Lines
  - `docker inspect`: obtain actual configuration and runtime evidence for exact container IDs
  - targeted `up -d [--force-recreate] --pull never --no-deps SERVICE`: apply reviewed actions
- **Constraints**: Pin Compose file, project name, profiles, environment source, and Docker
  authority across every phase. Never add `--remove-orphans`, builds, pulls, or unreviewed services.

#### Docker Engine Authority

- **Documentation**: [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/) and
  [protecting daemon access](https://docs.docker.com/engine/security/protect-access/)
- **Authentication**: Delegated to Docker CLI configuration; rfapps never copies credentials
- **Key evidence**: Active context, endpoint, effective `DOCKER_HOST`, and daemon ID contribute to a
  non-secret authority fingerprint
- **Security boundary**: Docker access can amount to host-root authority; report output never emits
  endpoints, credentials, resolved environment values, or raw inspection documents

#### Reconciliation Design References

- [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/): observe,
  act toward desired state, and re-observe
- [Argo CD automated sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/): separate
  automatic remediation from pruning
- [Argo CD sync windows](https://argo-cd.readthedocs.io/en/stable/user-guide/sync_windows/): model
  future allow/block policy without suppressing observation
- [Flux reconciliation](https://fluxcd.io/flux/components/kustomize/kustomizations/): bounded health,
  suspension, dependency, and status concepts

### Libraries and SDKs

| Library or tool             | Version                   | Purpose                                   | Decision                                                                |
| --------------------------- | ------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| Docker CLI / Compose plugin | Host-provided             | Resolve, observe, and apply Compose state | Reuse existing typed subprocess boundary                                |
| Commander                   | Existing v14              | Command and option parsing                | Reuse                                                                   |
| Node `crypto`               | Node 22+                  | Canonical SHA-256 fingerprints            | Reuse built-in                                                          |
| Vitest                      | Existing v4               | Unit and integration tests                | Reuse                                                                   |
| `yaml`                      | Upgrade lock to `>=2.8.3` | Existing config/YAML support              | Patch current deep-nesting advisory; do not parse Compose independently |
| New runtime dependency      | None                      | —                                         | Do not add Docker SDK, controller, retry, or scheduler packages         |

### External Documentation

- [Compose trust model](https://docs.docker.com/compose/trust-model/): Compose files are trusted
  infrastructure policy, not inert data
- [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/): prefer service secrets
  over environment variables where practical

## Business Requirements

### User Stories

**Primary User: self-hosting operator**

- As an operator, I want every selected service compared with declared Compose state so that I can
  see exactly what is converged, drifted, blocked, or unobservable.
- As a cautious operator, I want bare `rfapps reconcile` to be read-only so that inspection cannot
  restart, recreate, remove, pull, build, or persist anything.
- As an operator, I want proposed actions and consequences shown before confirmation so that
  `--auto-apply` is an informed decision.
- As an operator, I want post-action observation to prove convergence so that Compose exit zero is
  not mistaken for a healthy final state.

**Secondary User: automation consumer**

- As an automation consumer, I want a versioned, deterministic, complete result so that scripts do
  not parse human logs or depend on discovery order.
- As an automation consumer, I want output format and `--yes` never to imply mutation authority.
- As a scheduler user, I want observation to work outside maintenance windows while future policy
  can block actions with an explainable reason.

### Business Rules

1. **Compose is authoritative**: Reconciliation is one-way. Runtime-only changes are replaced when
   applied; preserving them remains `rfapps drift import`.
2. **Observer first**: Without `--auto-apply`, the command performs no Docker mutation, prompt,
   lifecycle lock, filesystem artifact write, SQLite access, history write, or generation write.
3. **Explicit authorization**: `--auto-apply` is the sole command-specific mutation gate. `--yes`
   only skips confirmation, and global `--dry-run` always suppresses mutation.
4. **Frozen complete scope**: Service/group/profile/sidecar resolution produces one explicit sorted
   scope. Every selected service appears exactly once in the result.
5. **Deterministic intent**: Each service receives one comparison and one action from
   `none | create | start | recreate | blocked`, with every causal drift category attached.
6. **No speculative actions**: Missing or ambiguous evidence, scaled multiplicity unsupported by
   the observer, policy errors, and stale review evidence block mutation.
7. **No scope widening**: V1 never removes orphans, prunes, pulls images, builds, imports runtime
   state, edits Compose, renews volumes, or mutates implicit dependencies.
8. **Registry freshness is separate**: Same-tag remote digest changes belong to `rfapps update`,
   not reconciliation.
9. **Fail-closed apply**: Auto-apply locks the canonical project/daemon, re-observes global and
   per-service identity, rechecks policy, and refuses changed intent without a force bypass.
10. **Proven convergence**: A service is converged only after bounded post-action observation finds
    no relevant drift and the desired runtime condition is ready.
11. **Level-triggered recovery**: There is no action-log replay or automatic data rollback. A later
    run observes current state and acts only on remaining drift.
12. **Maintenance compatibility**: V1 exposes a typed eligibility decision with an allow-all
    implementation. Issue #169 owns schedules, time zones, and window configuration.

### Edge Cases

| Scenario                           | Expected Behavior                                           | Notes                                      |
| ---------------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| All services in sync               | Successful no-op; no prompt or lock                         | Same semantics in report and auto-apply    |
| Missing container                  | Propose `create`; targeted Compose up                       | No implicit dependencies                   |
| Stopped matching container         | Propose `start`                                             | Preserve distinct operator reason          |
| Configuration/image/runtime drift  | Propose `recreate` when safely correctable                  | Runtime states may be blocked by policy    |
| Multiple categories on one service | One action with all reasons                                 | Never recreate per category                |
| Scaled/ambiguous instances         | Report and block remediation in v1                          | Never collapse multiple instances silently |
| Drift disappears before action     | `became_in_sync`; skip mutation                             | Re-observe, do not replay                  |
| Review evidence changes            | Block with `RECONCILE_REVIEW_STALE`                         | No force bypass                            |
| Compose succeeds but drift remains | `not_converged`; non-success aggregate                      | Retain final drift evidence                |
| One action fails                   | Stop unsafe subsequent work; preserve completed results     | Aggregate partial or failed                |
| Maintenance policy denies          | Full report; zero denied actions                            | `--yes` never bypasses policy              |
| Secret environment drift           | Emit name/change kind only                                  | No current/desired values or value hashes  |
| SIGINT/SIGTERM                     | Stop scheduling, stabilize/report active unit, release lock | Next run starts fresh                      |

### Success Criteria

- [ ] Bare and dry-run reconciliation prove zero mutation and zero persistence.
- [ ] `reconcile.v1` accounts for every resolved service with stable ordering and reason codes.
- [ ] Equivalent normalized observations yield identical semantic diffs, actions, summaries, and
      fingerprints apart from documented volatile metadata.
- [ ] Machine output contains exactly one document on stdout and never grants mutation authority.
- [ ] Auto-apply refuses stale Compose, project, environment-source, Docker-authority, scope,
      container-identity, policy, or action evidence.
- [ ] Targeted actions never include `--remove-orphans`, pulls, builds, volumes, implicit
      dependencies, or unreviewed services.
- [ ] Post-action observation distinguishes converged, blocked, failed, and residual-drift results.
- [ ] Secret values and raw Docker/Compose payloads never appear in any output format or error.
- [ ] Legacy CLI and MCP reconciliation routes delegate to the single safe coordinator.
- [ ] Bash, Zsh, and Fish completions contain the command, every option, and dynamic value helpers.
- [ ] Focused, full rfapps, Docker-backed-when-available, typecheck, build, formatting, markdown,
      whitespace, Graphify, documentation, and ROADMAP gates pass.

## Technical Specifications

### Architecture Overview

```text
commands/reconcile.ts
  -> actions/reconcile.ts       config + scope + approval + output + exit
     -> lib/reconcile.ts        deterministic plan + policy + lock + verify
        -> lib/drift.ts         one desired-vs-actual comparison definition
        -> lib/identity.ts      canonical project + Docker/env authority
        -> lifecycle-lock.ts    shared exclusion with managed update
        -> lib/docker.ts        targeted create/start/recreate, no widening
```

Report mode stops after deterministic planning. Auto-apply displays the same report, confirms in a
human TTY unless `--yes`, locks, revalidates, evaluates policy, acts service-by-service in reviewed
dependency order, and re-observes the complete scope. Libraries return data and never print, prompt,
or set process-global exit state.

### Data Models

#### Reconciliation result

```typescript
export const RECONCILE_SCHEMA_VERSION = "reconcile.v1" as const;

type ReconcileMode = "report" | "auto-apply";
type ReconcileComparison = "in_sync" | "drifted" | "observation_failed";
type ReconcileActionKind = "none" | "create" | "start" | "recreate" | "blocked";
type ReconcileOutcome =
  | "in_sync"
  | "report_only"
  | "became_in_sync"
  | "converged"
  | "blocked"
  | "observation_failed"
  | "action_failed"
  | "not_converged";

interface ReconcileServiceResult {
  service: string;
  comparison: ReconcileComparison;
  drift: ServiceDrift;
  action: {
    kind: ReconcileActionKind;
    categories: DriftCategory[];
    eligibility: "not_requested" | "allowed" | "blocked";
    reasonCode?: string;
  };
  outcome: ReconcileOutcome;
  finalDrift?: ServiceDrift;
}

interface ReconcileResult {
  schemaVersion: typeof RECONCILE_SCHEMA_VERSION;
  operation: "reconcile";
  mode: ReconcileMode;
  dryRun: boolean;
  status: "reported" | "planned" | "converged" | "partial" | "failed" | "cancelled";
  scope: { composePath: string; project: string; profiles: string[]; services: string[] };
  actionFingerprint: string;
  automation: { status: "not_requested" | "allowed" | "blocked"; reasonCode?: string; nextEligibleAt?: string };
  services: ReconcileServiceResult[];
  summary: {
    selected: number;
    inSync: number;
    drifted: number;
    actionable: number;
    blocked: number;
    converged: number;
    failed: number;
  };
  success: boolean;
  exitCode: 0 | 1 | 2 | 3;
}
```

The action fingerprint binds canonical Compose/project identity, Docker and environment-source
fingerprints, profiles, explicit scope, resolved service fingerprints, exact observed container
identities, normalized drift, policy decision, and proposed actions. It excludes timestamps,
durations, display text, and secret values. Secret-bearing raw evidence remains process-local.

#### Deterministic ordering

- Services/profiles: code-point lexical order after uniqueness validation
- Categories: `image`, `environment`, `ports`, `volumes`, `networks`, `runtime-status`
- Environment: variable name and change kind; values always omitted
- Ports: container, protocol, host; volumes: target, source, readonly; networks: lexical
- Actions: dependency phase, then service name; terminal service results return to service order

### CLI Design

```text
rfapps reconcile
  -s, --service <name>
  --services <names>
  -g, --group <name>
  --no-sidecars
  --auto-apply
  --show-unchanged
  --health-timeout <seconds>
  -f, --compose <path>
  -e, --env-file <path>
  -p, --profile <name>

Global: --dry-run --json --output --verbose --yes --use-dotenvx --use-op
```

- Report mode returns exit `0` for a trustworthy report, including reported drift.
- Auto-apply returns `0` only when the requested scope converges, `3` for mixed/blocked/residual
  results, `1` for operational failure, and `2` for invalid/unsafe usage.
- Machine auto-apply requires `--yes`; machine formats never prompt or stream Compose output.
- JSON/YAML are normative nested formats. Table/CSV may expose a documented service-summary
  projection only if existing formatter behavior can do so without inventing conflicting fields.
- `rfapps drift reconcile` remains a compatibility syntax that delegates with auto-apply intent.
- Existing `rfapps.drift.reconcile` MCP naming remains, but its adapter/schema use the same result
  and authorization path; no second mutation tool is added.

### System Integration

#### Files to Create

- `packages/rfapps-cli/src/commands/reconcile.ts` and focused command tests
- `packages/rfapps-cli/src/actions/reconcile.ts` and focused action tests
- `packages/rfapps-cli/src/lib/reconcile.ts` and coordinator tests
- `packages/rfapps-cli/src/types/reconcile.ts`
- `packages/rfapps-cli/src/reconcile.integration.spec.ts`
- `docs/features/rfapps-reconcile-command.md`

#### Files to Modify

- `src/cli.ts`, `src/lib/index.ts`, `src/types/index.ts`: registration and exports
- `src/actions/update.ts`: consume extracted shared Compose/Docker identity helpers
- `src/lib/docker.ts`: safe targeted reconciliation primitives and all-container observation
- `src/lib/drift.ts`: observation gaps for stopped/ambiguous instances without changing drift schema
- `src/actions/drift.ts`: compatibility delegation; preserve detect/show/import
- `src/actions/completion.ts`: complete Bash/Zsh/Fish command and option metadata
- MCP schemas/adapters/tools/server and their tests: typed compatibility result, one coordinator
- Package/root docs, drift/plan/output/MCP/completion/architecture docs, `ROADMAP.md`
- `package-lock.json`: resolve `yaml` to a patched version supported by the declared range

#### Configuration

- Reuse current health timeout/interval/retry settings for bounded verification.
- Add only a data-oriented automation-policy interface; do not add maintenance-window config.
- Add no database schema, saved plan, daemon, internal scheduler, retry queue, or new MCP authority.

## UX Considerations

### User Workflows

#### Report-only

1. Resolve and display the effective mode and scope.
2. Observe desired and actual state and build deterministic comparisons/actions.
3. Show word-first states (`IN SYNC`, `DRIFTED`, `BLOCKED`) with actual-to-desired direction.
4. Emit `No changes were made` plus the exact `--auto-apply` follow-up.

#### Auto-apply

1. Render the same reviewed report.
2. Confirm the exact target/action list in human mode unless `--yes`.
3. Lock and revalidate; apply only current eligible actions.
4. Show durable stage transitions on stderr and bounded verification progress.
5. Emit a complete terminal report with every original and final outcome.

#### Error Recovery

1. Preserve all trustworthy per-service evidence in partial runs.
2. Name the failing phase and stable reason code without raw sensitive stderr.
3. Provide a copyable report-only rerun for the original scope.
4. Never instruct users to replay stale actions or imply data rollback.

### UI Patterns

| Surface        | Pattern                                       | Notes                                             |
| -------------- | --------------------------------------------- | ------------------------------------------------- |
| Heading        | Mode plus resolved scope                      | Copied logs retain safety context                 |
| Service row    | Word-first status, service, action, reason    | Color/symbols are secondary only                  |
| Confirmation   | Default-no, exact count and targets           | Warn that Compose wins and containers may restart |
| Progress       | Resolve, observe, plan, apply N/M, verify N/M | No high-frequency polling lines                   |
| Machine output | One final document on stdout                  | Progress/debug stays sanitized on stderr          |

### Accessibility Requirements

- Never rely on red/green or symbols alone; use stable words and alignment.
- Disable ANSI, cursor movement, and animation when stderr is not a TTY.
- Use `actual -> desired`, not ambiguous old/new labels.
- Preserve readable static output after progress cleanup and stable ordering for screen readers/logs.

### Performance UX

- Batch bounded observation where safe, but keep mutation sequential within dependency phases.
- Show service counts and elapsed/timeout evidence for long waits.
- Do not foreground-wait for maintenance windows or retry mutations indefinitely.
- Capture rather than stream subprocess output in machine modes.

## Recommendations

### Implementation Approach

**Recommended Strategy**: Build one versioned report model over existing drift evidence, then add a
same-process, lock/revalidate/apply/verify coordinator. Extract only security-sensitive shared
identity primitives; keep reconciliation ordering, policy, aggregation, and rendering feature-local.

**Phasing:**

1. **Phase 1 - Contract and Observation**: `reconcile.v1`, deterministic planner, stopped/ambiguous
   observation, masking, and pure tests.
2. **Phase 2 - Controlled Apply**: shared identity, lifecycle lock, policy seam, targeted Docker
   actions, convergence verification, cleanup, and failure aggregation.
3. **Phase 3 - Command and Compatibility**: CLI/action, legacy and MCP delegation, all shell
   completions, output/exit behavior.
4. **Phase 4 - Validation and Release**: integration/Docker tests, security regression, docs,
   ROADMAP, Graphify, and full release gates.

### Technology Decisions

| Decision                        | Recommendation                               | Rationale                                                      |
| ------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| Comparison                      | Reuse `detectDrift()`                        | One drift definition and masking boundary                      |
| Apply durability                | Same process only                            | Avoid untrusted saved-plan/staleness scope                     |
| Mutation                        | Per-service targeted Compose; sequential     | Limits blast radius and enables revalidation/verification      |
| Pull/dependency/orphan behavior | `--pull never`, no implicit deps, no orphans | Keep reviewed scope and update authority separate              |
| Concurrency                     | Shared managed-update lifecycle lock         | Prevent cross-workflow races                                   |
| Persistence                     | None in v1                                   | Current state is re-derived; no rollback/audit contract exists |
| Maintenance                     | Injected allow/block policy seam             | #169 owns scheduling semantics                                 |
| Dependencies                    | No new runtime library                       | Existing CLI, crypto, formatters, and Vitest suffice           |

### Quick Wins

- Route legacy mutation away from `startServices()` and its unconditional orphan removal.
- Land types, ordering constants, and exact Docker-argv tests before output rendering.
- Parameterize Bash/Zsh/Fish completion parity tests.
- Upgrade the existing YAML lock entry to the patched release during dependency validation.

### Future Enhancements

- Issue #169 maintenance windows and external scheduling
- Opt-in `--fail-on-drift` for CI
- Secure persisted reconcile plans only after an explicit use case
- Scaled-instance remediation, explicit orphan-prune preview, historical audit, or daemon mode as
  separate scoped features

## Risk Assessment

### Technical Risks

| Risk                                    | Likelihood | Impact   | Mitigation                                                               |
| --------------------------------------- | ---------- | -------- | ------------------------------------------------------------------------ |
| Wrong/stale authority or reviewed state | Medium     | Critical | Shared lock, identity fingerprints, per-service fail-closed revalidation |
| Read-only path reaches mutation         | Low        | Critical | Explicit gate and negative lock/Docker/filesystem/database tests         |
| Scope widening/orphan removal           | Medium     | High     | Frozen scope, dedicated argv helper, no deps/orphans/pulls               |
| Secret leakage                          | Medium     | High     | Values process-local, allowlisted results, structural redaction          |
| Compose success without convergence     | Medium     | High     | Post-action drift/readiness polling and residual evidence                |
| Ambiguous scaled/stopped observation    | Medium     | High     | Observe all instances or block; never collapse silently                  |
| Partial outage/data side effects        | Medium     | High     | Sequential actions, stop on stabilization failure, no rollback claims    |
| Remote daemon pressure                  | Low        | Medium   | Bounded output/time/retries and no blind mutation replay                 |

### Integration Challenges

- Moving canonical identity helpers out of `actions/update.ts` must preserve managed-update
  behavior and tests exactly.
- The legacy CLI/MCP route must not retain an independent safety or machine-output contract.
- Drift observation changes must remain backward compatible for detect/show/import consumers.
- All completion and documentation mirrors must stay synchronized with actual Commander options.

### Security Considerations

#### Critical — Hard Stops

| Finding                              | Risk                                  | Required Mitigation                                                     |
| ------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------- |
| Report mode mutates                  | Unexpected host-level Docker action   | Type/default gating plus negative tests                                 |
| Apply uses stale/untrusted authority | Wrong project/daemon/service mutation | Canonical identity, shared lock, complete revalidation, no force bypass |

#### Warnings — Must Address

| Finding                              | Risk                                  | Mitigation                                        | Alternatives                              |
| ------------------------------------ | ------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| Compose/Docker data contains secrets | Durable credential leakage            | Omit all env values; allowlist and redact outputs | None acceptable for persisted output      |
| Broad Compose up widens scope        | Orphan/dependency deletion or restart | Dedicated target-only helper                      | Separate future destructive authorization |
| Maintenance policy races             | Mutation outside allowed window       | Reevaluate under lock and before action           | Block on policy error                     |
| YAML dependency advisory             | Local deep-nesting denial of service  | Upgrade lock to patched version and validate      | Defer only with documented input trust    |

#### Advisories — Best Practices

- Validate all operands, paths, result sizes, and JSON Lines; keep shell disabled.
- Separate deterministic decision data from volatile timestamps/durations.
- Preserve manual stale-lock recovery and document the data-rollback boundary.

## Task Breakdown Preview

### Phase 1: Contracts and Observation

**Focus**: Establish deterministic, secret-safe evidence and complete scope accounting.
**Tasks**:

- Add result/action contracts, canonicalization, fingerprints, summaries, and tests.
- Strengthen stopped/missing/ambiguous-instance observation while preserving drift compatibility.
- Extract shared Compose/Docker/environment identity primitives.

**Parallelization**: Contracts and shared identity can proceed in parallel; observation consumes the
contract before final integration.

### Phase 2: Controlled Apply

**Focus**: Add the sole safe mutation path.
**Dependencies**: Phase 1 contracts, observation, and identity.
**Tasks**:

- Implement policy, lifecycle lock, revalidation, interruption, cleanup, and aggregation.
- Implement exact target-only Docker actions and bounded convergence verification.

### Phase 3: CLI, Compatibility, and Completion

**Focus**: Expose one behavior across every public surface.
**Dependencies**: Phase 2 coordinator.
**Tasks**:

- Add top-level command/action, human/machine output, confirmation, and exits.
- Delegate legacy CLI/MCP reconciliation.
- Update Bash, Zsh, and Fish templates plus parity tests.

### Phase 4: Validation and Documentation

**Focus**: Prove the complete workflow and close the issue hierarchy.
**Tasks**:

- Add integration and Docker-backed tests, adversarial security/output checks, and full gates.
- Update feature/architecture/quick-reference/MCP/completion docs, READMEs, and `ROADMAP.md`.
- Refresh Graphify, validate child issue acceptance criteria, and prepare PR evidence.

## Decisions Needed

The design workflow resolves the implementation-blocking choices as follows:

1. **Legacy route**
   - Options: retain old behavior, remove it, or delegate
   - Decision: preserve syntax/tool naming but delegate to the new coordinator
2. **Mutation granularity**
   - Options: bulk Compose, parallel custom executor, or per-service sequential
   - Decision: per-service sequential within dependency phases, with revalidation and verification
3. **Scaled services**
   - Options: collapse, fully remediate, or block ambiguous multiplicity
   - Decision: report all observable evidence and block scaled remediation in v1
4. **Runtime-only unhealthy states**
   - Options: always recreate or policy-classify
   - Decision: permit clearly correctable missing/stopped/config drift; block unsafe/ambiguous states
5. **Machine formats**
   - Options: full nested contract everywhere or normative JSON/YAML with summary projections
   - Decision: JSON/YAML normative; table/CSV only if explicitly documented as summaries
6. **Policy-blocked auto-apply**
   - Options: success, failure, or partial
   - Decision: exit `3` with structured blocked evidence; future scheduler modes may version changes

## Research References

For detailed findings, see:

- [research-external.md](./research-external.md): Docker/Compose and controller references
- [research-business.md](./research-business.md): requirements, rules, workflows, and domain states
- [research-technical.md](./research-technical.md): architecture, contracts, and repository changes
- [research-ux.md](./research-ux.md): CLI workflows, errors, accessibility, and output behavior
- [research-security.md](./research-security.md): severity-classified authority and data risks
- [research-practices.md](./research-practices.md): reuse, KISS, boundaries, and testability
- [research-recommendations.md](./research-recommendations.md): final phasing and decisions
