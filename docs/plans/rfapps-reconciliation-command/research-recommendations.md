# rfapps Reconciliation Command: Recommendations

## Executive Summary

Implement `rfapps reconcile` as a one-shot, report-first controller over the existing drift detector
and Docker Compose boundary. The default command observes the resolved Compose desired state and live
Docker state, emits a deterministic `reconcile.v1` result, proposes one action for every selected
service, and performs no mutation or persistence. Only `--auto-apply` authorizes remediation;
`--yes`, machine output, and non-interactive execution never imply that authority, while `--dry-run`
always suppresses mutation.

Compose remains authoritative. Apply runs in the same process as the reviewed report, under the
existing project/Docker-authority lifecycle lock. It revalidates identity, scope, policy, desired
state, actual state, and action intent before each service action, then re-observes until convergence
or a bounded timeout. V1 never deletes orphans, pulls or updates images, edits Compose, changes
volumes, imports runtime state, persists plans/history, or claims data rollback.

Reuse the repository's command/action/library/Docker/type boundaries and existing dependencies. The
release is complete only when the top-level command, legacy compatibility routes, tests, all Bash,
Zsh, and Fish completions, user documentation, and `ROADMAP.md` are updated together.

## Implementation Recommendations

### Approach

1. Add a top-level `rfapps reconcile` command with existing service/group/profile/sidecar selectors,
   `--auto-apply`, `--show-unchanged`, and `--health-timeout`.
2. Keep `lib/drift.ts::detectDrift()` authoritative for desired-versus-actual comparison and secret
   masking. Fix detector gaps there so drift and reconcile cannot disagree.
3. Freeze an explicit, unique, sorted scope and account for every selected service as `in_sync`,
   `drifted`, or `observation_failed`.
4. Derive exactly one operator-facing action per service: `none`, `create`, `start`, `recreate`, or
   `blocked`. Attach all causal drift categories to that single action.
5. Emit the full report before any confirmation. Report mode exits successfully when it produces a
   trustworthy report, even when drift exists.
6. For `--auto-apply`, prompt once in human mode unless `--yes`; require `--yes` for non-interactive
   machine-mode mutation. A no-op never prompts or locks.
7. Acquire the shared lifecycle lock, recompute the reviewed fingerprint, and fail closed on changes
   to Compose identity/hash, Docker authority, environment source, profiles, scope, container
   identity, drift, action, or maintenance eligibility.
8. Remediate eligible services individually in deterministic dependency batches, sequentially
   within each batch by default. Before each action, re-observe that service and policy; after it,
   verify convergence before continuing. Stop scheduling new work after stabilization failure.
9. Use a dedicated Docker helper with explicit canonical project/profile/service arguments,
   `--pull never`, no `--remove-orphans`, and no implicit dependency widening. Use ordinary targeted
   Compose up for create/start and force recreation only for a reviewed `recreate` action.
10. Re-observe the entire frozen scope for the terminal report. Preserve mixed per-service outcomes
    and return exit `3` for blocked, failed, or not-converged auto-apply results.

### Technology

- Preserve the layers: `commands/reconcile.ts` for argv declaration; `actions/reconcile.ts` for
  config, selection, prompt, output, and exit behavior; `lib/reconcile.ts` for pure planning and
  apply coordination; `lib/docker.ts` for execution; `types/reconcile.ts` for the public contract.
- Reuse Compose's resolved model through the existing Docker CLI subprocess path. Do not add a
  Compose parser, Docker SDK, controller framework, retry library, scheduler, or runtime dependency.
- Extract/reuse canonical Compose identity, Docker-authority and environment-source fingerprints,
  lifecycle locking, safe operand validation, bounded subprocess handling, and managed redaction.
- Define JSON/YAML as the normative nested contract. Machine modes emit exactly one document on
  stdout; progress and sanitized diagnostics go to stderr.
- Make `reconcile.v1` deterministic: lexical service/profile ordering; fixed category ordering;
  field-specific ordering for environment names, ports, mounts, and networks; stable reason codes;
  recursive canonicalization; and a SHA-256 action fingerprint excluding timestamps, durations,
  messages, and secret values.
- Include mode, resolved scope, authority-safe fingerprints, initial comparison, proposed action,
  eligibility, attempt/final outcome, final comparison, and complete summary counts. Environment
  diffs expose names and change kinds only, never values or low-entropy hashes.
- Add an injected, data-only maintenance-policy seam. V1 reports `not_requested` or `allowed`;
  issue #169 may later return a typed block and next eligible time without changing diff semantics.

### Phasing

1. **Contract and observation:** add `reconcile.v1`, deterministic canonicalization/fingerprinting,
   complete service accounting, detector coverage for missing/stopped/ambiguous instances, and
   report-only rendering.
2. **Controlled apply:** add shared identity extraction, lock/revalidation, policy seam, dedicated
   per-service Compose actions, convergence polling, signal-safe cleanup, and exit aggregation.
3. **Compatibility and surfaces:** delegate `rfapps drift reconcile` and the existing MCP adapter to
   the one coordinator; register the top-level command; complete Bash/Zsh/Fish completions.
4. **Validation and release readiness:** add unit, integration, optional Docker-backed, security,
   output-purity, and completion tests; update CLI docs, examples, migration guidance, and
   `ROADMAP.md`.

### Quick Wins

- Route the legacy reconcile path away from `startServices()` so it cannot inherit
  `--remove-orphans`.
- Add the `reconcile.v1` types and fixed sorting constants before UI work.
- Reuse managed-update identity, lock, redaction, injected clock/sleep, and test harness patterns.
- Add exact Docker-argv tests early: explicit target, `--pull never`, no orphan removal, no build,
  and no target widening.
- Parameterize completion tests across Bash, Zsh, and Fish so flag parity cannot drift.

## Improvement Ideas (Deferred)

- Maintenance-window configuration, timezone semantics, and external scheduling from issue #169.
- Opt-in `--fail-on-drift` for CI without changing default report exit behavior.
- Saved, reviewable reconcile artifacts only if a later use case justifies strict private storage,
  schema validation, authority binding, and mandatory live revalidation.
- Scaled-service remediation after the observer can model every instance safely; until then, report
  ambiguous multiplicity as unsupported rather than collapsing containers.
- Explicit orphan pruning behind a separate destructive authorization and preview, never implied by
  `--auto-apply`.
- Parallel execution after dependency, daemon-pressure, output, and failure-isolation evidence shows
  it is safer than the sequential default.
- A documented flat CSV/table summary projection if demand warrants a second wire contract; keep
  JSON/YAML normative in v1.
- Historical reconciliation/audit retention, daemon mode, watchers, rollback, and automatic retry
  scheduling as separate features with their own authority and recovery models.

## Risk Assessment

| Risk                                         | Likelihood | Impact   | V1 mitigation                                                                                        |
| -------------------------------------------- | ---------- | -------- | ---------------------------------------------------------------------------------------------------- |
| Report mode unexpectedly mutates             | Low        | Critical | Type/default report path; negative tests for lock, Docker, files, and database access                |
| Stale report or wrong Docker authority       | Medium     | Critical | Shared lifecycle lock; authority/config/scope fingerprint; per-service revalidation; no force bypass |
| Scope widening or orphan deletion            | Medium     | High     | Frozen scope; dedicated targeted helper; no dependencies/orphans; exact argv tests                   |
| Secret leakage in diffs/errors               | Medium     | High     | Values remain process-local; allowlisted result fields; bounded redaction in every format            |
| Broad auto-apply causes outage               | Medium     | High     | Explicit gate, reviewed count/targets, per-service actions, sequential verification, stop on failure |
| Compose succeeds but service remains drifted | Medium     | High     | Bounded post-action drift polling; `not_converged`; partial-success exit                             |
| Scaled/stopped containers are misclassified  | Medium     | High     | Extend observer safely or block ambiguous states; never silently overwrite instances in a map        |
| Maintenance policy races                     | Low now    | High     | Typed eligibility; reevaluate under lock and before every service; errors fail closed                |
| Remote daemon or subprocess pressure         | Low        | Medium   | Bounded output/timeouts/retries; sequential apply; no blind mutation replay                          |
| Data cannot be rolled back                   | Medium     | High     | Preserve volumes; no persistence claims; explicit boundary and application backup guidance           |

### Integration Notes

Delegate legacy CLI and MCP reconciliation to the new coordinator without changing drift
detect/show/import. Share the exact lock namespace with managed update so both mutation workflows
contend. Preserve current selector, secrets-provider, formatting, and exit-code conventions. Test
that unrelated services, sidecars outside frozen scope, dependencies, and orphans remain untouched.

### Performance Notes

Batch read-only observation where safe, cap and validate Docker output, and sort only normalized
bounded data. Keep mutation sequential per dependency batch in v1; deterministic final ordering is
independent of execution order. Use injected clock/sleep and bounded convergence polling, with no
foreground wait for a future maintenance window and no unbounded automatic retry.

### Security Notes

Treat Docker access and Compose files as host-level authority. Use argv arrays with shell disabled,
canonical regular-file paths, validated operands, explicit project identity, and fail-closed parsing.
Never emit Docker endpoints, credentials, raw Compose/inspect JSON, raw stderr, environment values,
lock tokens, or secrets-provider output. `--auto-apply` grants only the reviewed service actions.

## Alternative Approaches

| Approach                                          | Advantages                                                            | Drawbacks                                                                            | Recommendation          |
| ------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------- |
| Report-first same-process controller              | Small, reviewable, level-triggered, reuses repository safety patterns | Apply cannot be detached from its report                                             | **Choose for v1**       |
| Wrap existing `drift reconcile`/`startServices()` | Minimal code                                                          | Immediate mutation, orphan deletion, no lock/revalidation/final proof                | Reject                  |
| Save plan, then apply later                       | Durable review handoff                                                | Staleness, artifact security, replay, permissions, and migrations                    | Defer until required    |
| Direct Docker Engine SDK/controller               | Rich low-level control                                                | New auth/context/API path; still needs Compose resolution; more supply-chain surface | Reject                  |
| Single bulk Compose apply                         | Simple and dependency-aware                                           | Weak per-service revalidation, scope/effect ambiguity, poorer failure isolation      | Reject for v1 apply     |
| Continuous daemon/scheduler                       | Automatic convergence                                                 | Expands policy, recovery, observability, and maintenance-window scope                | Separate future feature |

## Task Breakdown Preview

### Batch 1: Foundation

- **Child issue: Public contract and deterministic planner** — `reconcile.v1`, types, canonical
  ordering, action taxonomy, fingerprints, summaries, exit mapping, and pure tests.
- **Child issue: Observation completeness** — reuse/fix drift detection for missing, stopped,
  unhealthy, ambiguous, and scaled services; preserve masking and full-scope accounting.
- **Child issue: Shared identity primitives** — extract canonical Compose/project, Docker authority,
  environment source, safe operand, and redaction helpers with compatibility tests.

### Batch 2: User-Facing Report (depends on Batch 1 contract/observer)

- **Child issue: Command and action layer** — selectors, modes, confirmation rules, output purity,
  report rendering, no-op/cancellation, and usage validation.
- **Child issue: Documentation baseline** — CLI reference, report/apply examples, exit semantics,
  safety boundaries, legacy route guidance, and initial `ROADMAP.md` update.

### Batch 3: Controlled Apply (depends on all Batch 1 work)

- **Child issue: Lifecycle coordinator** — policy seam, shared lock, global and per-service
  revalidation, signals, terminal accounting, and cleanup.
- **Child issue: Docker remediation boundary** — create/start/recreate helpers, dependency batches,
  `--pull never`, no orphans/deps, bounded verification, and exact argv/Docker-backed tests.

### Batch 4: Compatibility and Completion (depends on Batches 2-3)

- **Child issue: Legacy CLI and MCP adapters** — one implementation and authorization model.
- **Child issue: Bash/Zsh/Fish completions** — command, every option, dynamic service/group/profile,
  file and timeout values, plus parity tests.
- **Child issue: Integration and release docs** — full command/action/coordinator flows, machine
  schema, partial failures, secrets, regression suite, final docs, and final `ROADMAP.md` status.

## Key Decisions Needed

| Decision                    | Explicit choice                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------ |
| Default behavior            | Report-only; drift is data and a trustworthy report exits `0`                        |
| Mutation authority          | `--auto-apply` only; `--yes` suppresses confirmation; `--dry-run` wins               |
| Wire contract               | Deterministic, versioned `reconcile.v1`; JSON/YAML normative                         |
| Desired-state authority     | Resolved Compose wins; runtime changes are never imported                            |
| Apply durability            | Same-process only; no saved plan, SQLite history, or generation records              |
| Concurrency/staleness       | Shared lifecycle lock plus global and per-service fail-closed revalidation           |
| Action model                | One of `none/create/start/recreate/blocked` per service with all reasons attached    |
| Apply granularity           | Per-service, dependency-batched, sequential by default, verify before continuing     |
| Dependency behavior         | Do not mutate implicit dependencies; include required dependencies in reviewed scope |
| Destructive/update behavior | No orphan deletion, pruning, image pull/update/build, volume change, or rollback     |
| Maintenance policy          | Observation always allowed; reevaluate typed policy before every mutation            |
| Compatibility               | Legacy CLI and MCP routes delegate to the new coordinator                            |
| Completion surface          | Bash, Zsh, Fish, docs, examples, tests, and `ROADMAP.md` are release requirements    |

## Open Questions

1. What explicit maximum service count should auto-apply accept before requiring narrower scope?
2. Which unhealthy runtime states are safely correctable by `start` or `recreate`, and which must be
   `blocked` pending operator diagnosis?
3. Should v1 reject scaled services outright or support reporting all instances while blocking only
   remediation?
4. Should table/CSV be rejected for reconcile or expose a documented service-summary projection?
5. Should a fully policy-blocked auto-apply return partial success `3` in all environments, or may a
   future scheduler opt into a successful `blocked` result while preserving structured status?
6. Which existing health timeout, interval, and retry setting wins when their bounds conflict?
