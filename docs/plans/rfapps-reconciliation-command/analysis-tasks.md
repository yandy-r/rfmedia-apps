# Task Structure Analysis: rfapps Reconciliation Command

## Executive Summary

Implement issue #151 as four dependency-ordered phases: establish a complete deterministic
contract and observer, add the narrowly scoped apply coordinator, expose that coordinator through
all public surfaces, then close the workflow with integration coverage and documentation. The
critical path is contract -> observation -> coordinator -> action/CLI -> compatibility surfaces ->
integration proof. Shared identity extraction, targeted Docker primitives, and most completion
work can proceed beside the contract work, while legacy CLI and MCP delegation must wait until the
new action has a stable result contract. Keep production/test pairs together, keep documentation
out of foundational code tasks, and avoid a broad task that simultaneously changes observation,
mutation, presentation, and compatibility behavior.

## Recommended Phase Structure

### Phase 1: Contract, identity, and complete observation

These tasks create the data and evidence boundaries required by every later mutation decision.

#### Task 1.1: Define the versioned reconciliation contract and pure planner

- **Files**: `packages/rfapps-cli/src/types/reconcile.ts`,
  `packages/rfapps-cli/src/lib/reconcile.ts`, and
  `packages/rfapps-cli/src/lib/reconcile.spec.ts`
- **Work**: Add `reconcile.v1` result/service/action/outcome/policy types, canonical category and
  service ordering, pure observation-to-action mapping, complete summary/status/exit derivation,
  deterministic action fingerprints, and an injected allow-all policy seam.
- **Boundary**: This task implements planning only. Locking, Docker mutation, prompting, rendering,
  and process exit state remain outside it.
- **Validation**: Prove stable output across input order, one result per selected service, complete
  reason aggregation, secret-free fingerprints/results, ambiguity blocking, and documented exit
  mapping.

#### Task 1.2: Extract shared project and Docker authority identity

- **Files**: `packages/rfapps-cli/src/lib/identity.ts`,
  `packages/rfapps-cli/src/lib/identity.spec.ts`, and
  `packages/rfapps-cli/src/actions/update.ts`
- **Work**: Move canonical Compose project resolution and Docker-authority fingerprinting from the
  update action into a neutral library, combine them with the existing environment-source and
  resolved-service fingerprints, and make managed update consume the shared implementation.
- **Boundary**: Preserve compatibility exports from `actions/update.ts` if current tests/importers
  require them. Do not add Docker-context switching or expose canonical paths/endpoints.
- **Validation**: Run identity tests plus `actions/update.spec.ts` and the managed-update tests to
  prove the extraction does not change shipped update behavior.

#### Task 1.3: Add complete, multiplicity-preserving Docker observation

- **Files**: `packages/rfapps-cli/src/lib/docker.ts` and
  `packages/rfapps-cli/src/lib/docker.spec.ts`
- **Work**: Add a bounded `compose ps --all --format json` API that retains every container ID,
  name, service, state, and health entry. Reject malformed or incomplete output and keep the
  running-only map unchanged for existing callers.
- **Boundary**: Return evidence; do not choose reconciliation actions here. Preserve multiple
  instances rather than collapsing them.
- **Validation**: Cover JSON and JSON-Lines variants, stopped containers, missing services, scaled
  services, duplicate identities, malformed/oversized output, profiles/project/env-tool argv, and
  sanitized typed failures.

#### Task 1.4: Adapt drift comparison to complete observations

- **Files**: `packages/rfapps-cli/src/lib/drift.ts`,
  `packages/rfapps-cli/src/lib/drift.spec.ts`, and
  `packages/rfapps-cli/src/types/drift.ts`
- **Work**: Retain the existing field-level comparator and masking boundary while exposing enough
  typed evidence to distinguish missing, one stopped, and ambiguous multiple instances. Ensure a
  selected service is never silently omitted when observation fails.
- **Boundary**: Keep `DriftResult` and drift detect/show/import behavior backward compatible. The
  reconciliation planner, not drift, selects `create`, `start`, `recreate`, or `blocked`.
- **Validation**: Add focused missing/stopped/scaled/inspect-failure tests and rerun existing drift
  action tests to catch schema or exit regressions.

Phase 1 parallelization: Tasks 1.1, 1.2, and 1.3 can start together. Task 1.4 depends on Task 1.3's
observation shape and should then integrate with Task 1.1's planner before Phase 2.

### Phase 2: Safe target-only mutation and coordination

These tasks add mutation only after the Phase 1 evidence model is stable.

#### Task 2.1: Add exact one-service Docker reconciliation actions

- **Files**: `packages/rfapps-cli/src/lib/docker.ts` and
  `packages/rfapps-cli/src/lib/docker.spec.ts`
- **Work**: Add a dedicated primitive for one reviewed service using `up -d --pull never --no-deps`,
  adding `--force-recreate` only for `recreate`. Thread canonical Compose path, project, profiles,
  and environment provider through the argv boundary.
- **Boundary**: Do not call or modify `startServices()` for reconciliation. Never add
  `--remove-orphans`, pull, build, volume renewal, implicit dependencies, or multiple targets.
- **Validation**: Assert exact argv for `create`, `start`, and `recreate`, hostile service-name
  rejection, no shell execution, bounded capture, and absence of every forbidden flag.

#### Task 2.2: Implement the fail-closed reconciliation coordinator

- **Files**: `packages/rfapps-cli/src/lib/reconcile.ts` and
  `packages/rfapps-cli/src/lib/reconcile.spec.ts`
- **Work**: Extend the injected coordinator with report-only termination, lifecycle-lock ownership,
  global and per-service revalidation, strict dependency-phase ordering, policy rechecks,
  sequential targeted action, bounded readiness plus fresh drift verification, interruption, and
  terminal aggregation for every original service.
- **Boundary**: The library returns data only. It must not print, prompt, set `process.exitCode`,
  write state/history/generations, persist a plan, or add rollback. Acquire the shared lifecycle
  lock only for approved auto-apply with actionable work, and release it in `finally`.
- **Validation**: Prove no lock/mutation/persistence in report and dry-run modes; no-op auto-apply
  avoids the lock; stale project/daemon/env/scope/config/container/policy/action evidence blocks;
  drift that disappears becomes `became_in_sync`; action and verification failures stop unsafe
  scheduling but preserve full results; signals release the lock.

#### Task 2.3: Export the coordinator and shared primitives

- **Files**: `packages/rfapps-cli/src/lib/index.ts` and
  `packages/rfapps-cli/src/types/index.ts`
- **Work**: Export only the public reconciliation entry point, schema constant/types, complete
  observation/action primitives, and shared identity helpers required by actions and tests.
- **Boundary**: Do not expose raw secret-bearing observation internals as an operator result API.
- **Validation**: Typecheck public imports and ensure no circular dependency from libraries back to
  actions, commands, formatters, or Commander.

Tasks 2.1 and the first half of 2.2 can proceed in parallel after Phase 1. Task 2.2 integrates 2.1,
identity, the lifecycle lock, dependency graph, readiness polling, and drift re-observation. Task
2.3 follows the final coordinator API.

### Phase 3: Command, compatibility, output, and completion surfaces

This phase exposes one implementation without creating an alternate authorization path.

#### Task 3.1: Add the top-level action and its operator contract

- **Files**: `packages/rfapps-cli/src/actions/reconcile.ts` and
  `packages/rfapps-cli/src/actions/reconcile.spec.ts`
- **Work**: Resolve configuration and selectors into an explicit unique sorted service scope,
  expand the empty/all sentinel before review, build production dependencies, render the report,
  confirm exact targets only for human auto-apply, invoke the coordinator, and set the documented
  exit code.
- **Boundary**: `--auto-apply` is the sole mutation gate; `--yes` only suppresses confirmation;
  global dry-run always suppresses mutation. JSON/YAML emit exactly one complete result on stdout;
  table/CSV use an explicit summary projection if retained.
- **Validation**: Cover report, dry-run, no-op, declined confirmation, machine auto-apply without
  `--yes`, selection/group/profile/sidecar expansion, `--show-unchanged`, health override,
  structured output cleanliness, redaction, cancellation, and exit codes `0/1/2/3`.

#### Task 3.2: Register the top-level CLI command

- **Files**: `packages/rfapps-cli/src/commands/reconcile.ts`,
  `packages/rfapps-cli/src/commands/reconcile.spec.ts`, and
  `packages/rfapps-cli/src/cli.ts`
- **Work**: Define the documented selectors and `--auto-apply`, `--show-unchanged`,
  `--health-timeout`, Compose/env/profile options, lazy-load the action, and register
  `rfapps reconcile` with the root program.
- **Boundary**: Inherit existing global output, dry-run, confirmation, debug, and secret-provider
  options rather than redeclaring or interpreting them as mutation authorization.
- **Validation**: Test help text, option forwarding/defaults, invalid timeout/input handling, lazy
  action loading, and root command registration.

#### Task 3.3: Delegate the legacy CLI route

- **Files**: `packages/rfapps-cli/src/actions/drift.ts`,
  `packages/rfapps-cli/src/actions/drift.spec.ts`, and
  `packages/rfapps-cli/src/commands/drift.ts`
- **Work**: Preserve `rfapps drift reconcile` syntax but translate it into the new action with
  explicit auto-apply intent. Leave detect, show, and import unchanged.
- **Boundary**: Remove the reconciliation path's independent `startServices(...forceRecreate)`
  behavior and its broad orphan-removal semantics. The compatibility route must inherit the new
  prompt/machine authorization, result, safety, and exit rules.
- **Validation**: Assert delegation and option mapping, prove the legacy path cannot invoke
  `startServices()`, and rerun all drift action/command tests.

#### Task 3.4: Delegate the existing MCP mutation tool

- **Files**: `packages/rfapps-cli/src/mcp/schema.ts`,
  `packages/rfapps-cli/src/mcp/adapters.ts`, and
  `packages/rfapps-cli/src/mcp/tools-mutate.ts`
- **Work**: Retain the `rfapps.drift.reconcile` name, require explicit `yes: true` for machine
  auto-apply, publish the complete `reconcile.v1` input/output contract, invoke the shared action,
  and remove the generic success fallback.
- **Test companion files**: `packages/rfapps-cli/src/mcp/schema.spec.ts`,
  `packages/rfapps-cli/src/mcp/adapters.spec.ts`, `packages/rfapps-cli/src/mcp/tools.spec.ts`, and
  `packages/rfapps-cli/src/mcp/server.spec.ts`
- **Boundary**: Do not add a second MCP reconcile tool or allow transport/tool classification to
  count as mutation consent.
- **Validation**: Verify tool listing, schema validation, explicit authorization, structuredContent
  equality, full result preservation, dry-run behavior, redaction, and failure serialization.

#### Task 3.5: Update every shell completion template

- **Files**: `packages/rfapps-cli/src/actions/completion.ts` and
  `packages/rfapps-cli/src/actions/completion.spec.ts`
- **Work**: Add `reconcile` and every command option to Bash, Zsh, and Fish, including dynamic
  service/group/profile value helpers and the correct non-value flags.
- **Boundary**: Treat all three generated templates as first-class output; do not patch only the
  root command list.
- **Validation**: Parameterize parity assertions across shells and compare completion options with
  Commander help so future drift is visible.

#### Task 3.6: Integrate result formatting and exit/error guidance

- **Files**: `packages/rfapps-cli/src/lib/formatters/index.ts`,
  `packages/rfapps-cli/src/lib/exit-codes.ts`, and
  `packages/rfapps-cli/src/lib/error-formatters.ts`
- **Test companion files**: Existing focused formatter, exit-code, and error-formatter specs.
- **Work**: Register the nested machine result and optional flat human summary projection, map
  typed reconciliation failures and status outcomes, and add actionable stale/policy/observation
  guidance only where existing error categories are insufficient.
- **Boundary**: Do not flatten or truncate normative JSON/YAML, leak raw Compose/Docker evidence,
  or let formatter selection change authorization or semantic status.
- **Validation**: Assert exactly one machine document, clean stdout, stable ordering, exhaustive
  status mapping, no ANSI in non-TTY output, and secret-safe typed errors.

Tasks 3.1 and 3.5 can start once the coordinator contract is frozen. Tasks 3.2, 3.3, and 3.4 depend
on Task 3.1. Task 3.6 should be integrated with Task 3.1 before compatibility surfaces finalize
their tests.

### Phase 4: End-to-end proof, dependency hygiene, and release documentation

#### Task 4.1: Add reconciliation integration and Docker-backed tests

- **Files**: `packages/rfapps-cli/src/reconcile.integration.spec.ts` and
  `packages/rfapps-cli/src/reconcile.compose.integration.spec.ts`
- **Work**: Exercise report-only, dry-run, auto-apply, legacy delegation, target-only Compose argv,
  shared lock exclusion, stale evidence, partial failure, post-action residual drift, machine
  output, and zero database/history/generation writes. Gate Docker-backed cases when Docker/Compose
  is unavailable using the repository's existing integration-test convention.
- **Boundary**: Prefer small fixture projects and injected failures; do not require the repository's
  production stack or live secrets.
- **Validation**: Run focused integration tests, the full rfapps unit suite, typecheck, build, and
  coverage thresholds.

#### Task 4.2: Patch the existing YAML dependency

- **Files**: `package.json` only if the declared range requires tightening, and
  `package-lock.json`
- **Work**: Resolve `yaml` to a patched release at or above `2.8.3` without adding a new runtime
  dependency or unrelated package churn.
- **Validation**: Inspect the lockfile diff, run `npm audit`/repository dependency checks, reinstall
  reproducibly, and rerun typecheck/tests/build.

#### Task 4.3: Publish operator and architecture documentation

- **Files**: `docs/features/rfapps-reconcile-command.md`,
  `packages/rfapps-cli/README.md`, and `docs/features/rfapps-drift-command.md`
- **Work**: Document the report-first workflow, exact options and exits, `reconcile.v1`, safety and
  no-rollback boundaries, legacy delegation, deterministic examples, and the separate purpose of
  drift import.
- **Files**: `docs/features/json-output.md`, `docs/features/rfapps-mcp-server.md`, and
  `docs/features/shell-completion.md`
- **Work**: Document machine output, MCP authorization/result compatibility, and Bash/Zsh/Fish
  parity.
- **Files**: `docs/architecture/data-flow.md`, `docs/features/plan-apply-workflow.md`, and
  `docs/features/quick-reference.md`
- **Work**: Explain where same-process reconciliation sits relative to persisted plan/apply and
  managed update. Update `docs/architecture/overview.md` only if its component inventory requires
  it.
- **Validation**: Check every command/schema/exit example against implementation, run Markdown
  lint, and verify links.

#### Task 4.4: Update indexes, roadmap, and generated project graph

- **Files**: `docs/README.md`, `README.md` only if its command inventory requires it, and
  `ROADMAP.md`
- **Work**: Link the feature guide, mark #151 and created child issues complete in the appropriate
  roadmap rows, retain #169 as the maintenance-policy follow-up, and record the closing PR when
  known.
- **Generated artifact**: Run `graphify update .` after source/document changes and include only
  the expected `graphify-out/` updates.
- **Validation**: Run Markdown lint, link/reference checks, `git diff --check`, Graphify validation,
  and reconcile roadmap status against GitHub immediately before merge.

Task 4.1 can run alongside documentation once Phase 3 is stable. Task 4.2 is independent but should
land before the full validation pass. Task 4.4 is last because issue and PR numbers, completion
state, and graph content depend on the finished implementation.

## Task Granularity Recommendations

- Keep each foundational implementation task to one production file plus its focused spec wherever
  possible. The exception is contract plus pure planner, whose types and behavior must evolve
  together to prevent an unusable intermediate schema.
- Separate Docker observation from Docker mutation even though both live in `lib/docker.ts`; this
  yields reviewable commits and permits observer work to land before any host-level mutation path.
- Treat shared identity extraction as its own task because regressions affect the already-shipped
  managed-update workflow, not only reconciliation.
- Keep the coordinator's pure planner and stateful executor in one module but implement them in
  two steps. Tests should make the pure decision surface independently callable.
- Keep command registration separate from action behavior. Commander parsing tests should not need
  Docker or lifecycle mocks, while action tests should inject the coordinator.
- Keep legacy CLI and MCP delegation in separate tasks. They share behavior, but MCP has a distinct
  JSON-RPC schema and explicit machine-authorization boundary.
- Keep completions paired with their tests; all three templates are one atomic public surface.
- Split documentation into coherent groups of roughly three files, but allow a single docs owner
  to validate terminology across the full set after the grouped edits.
- Do not combine dependency remediation or generated Graphify output with core logic tasks. Those
  diffs obscure behavior review and are straightforward to validate independently.

## Dependency Analysis

```text
1.1 contract/planner -----------+----------------------+
                                |                      |
1.3 complete observation -> 1.4 drift adapter         |
                                |                      v
1.2 shared identity ------------+--> 2.2 coordinator -> 2.3 exports
2.1 target-only mutation -----------^                    |
                                                         v
                                     3.1 action -> 3.2 command
                                           |      -> 3.3 legacy CLI
                                           |      -> 3.4 MCP
                                     3.6 format/exit ---^
                                     3.5 completions
                                           |
                                           v
                               4.1 integration -> 4.3 docs -> 4.4 roadmap/graph
                               4.2 YAML patch ---------> full release gates
```

The contract, identity, and observation tasks are the highest-value parallel batch. The mutation
primitive can begin after identity/argv conventions are understood, but the coordinator cannot be
declared complete until it consumes the final observer and planner. Public compatibility surfaces
must not implement against a provisional action return shape. Integration tests and docs should
consume the finished public API rather than becoming a second source of semantics.

The main regression edges are:

- Changing shared identity can break managed update, so its existing unit/integration suites are a
  mandatory dependency gate for Phase 2.
- Changing drift observation can break detect/show/import and plan generation, so those focused
  tests must accompany Phase 1 rather than wait for full-suite validation.
- Adding a safe Docker helper does not make existing `startServices()` safe; every reconcile route
  must be verified to call only the dedicated target primitive.
- MCP and legacy CLI routes can accidentally preserve old authorization or fallback results; their
  delegation tests must assert the exact shared coordinator/action call.
- Documentation and ROADMAP state depend on the final issue hierarchy and PR number and therefore
  cannot be finalized early.

## File-to-Task Mapping

| File or area                                                                          | Owning task   | Coordination note                                          |
| ------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------- |
| `src/types/reconcile.ts`                                                              | 1.1           | Source of truth for every public surface                   |
| `src/lib/reconcile.ts`                                                                | 1.1, then 2.2 | Pure planning first; stateful coordination second          |
| `src/lib/identity.ts`                                                                 | 1.2           | New neutral owner for project/Docker identity              |
| `src/actions/update.ts`                                                               | 1.2           | Compatibility consumer; preserve behavior/exports          |
| `src/lib/docker.ts`                                                                   | 1.3, then 2.1 | Complete observation and mutation are separate commits     |
| `src/lib/drift.ts`, `src/types/drift.ts`                                              | 1.4           | One comparison model; backward-compatible schema           |
| `src/lib/lifecycle-lock.ts`                                                           | 2.2           | Reuse unchanged unless a narrowly proven API gap exists    |
| `src/lib/dependency-graph.ts`                                                         | 2.2           | Reuse strict graph construction; no permissive fallback    |
| `src/lib/health.ts`                                                                   | 2.2           | Reuse bounded readiness and combine with fresh drift proof |
| `src/lib/index.ts`, `src/types/index.ts`                                              | 2.3           | Public exports after APIs settle                           |
| `src/actions/reconcile.ts`                                                            | 3.1           | Sole CLI-facing orchestration/render/confirmation boundary |
| `src/commands/reconcile.ts`, `src/cli.ts`                                             | 3.2           | Root spelling and option registration                      |
| `src/actions/drift.ts`, `src/commands/drift.ts`                                       | 3.3           | Compatibility delegation only                              |
| `src/mcp/schema.ts`, `src/mcp/adapters.ts`, `src/mcp/tools-mutate.ts`                 | 3.4           | Retain tool name; replace implementation/result            |
| `src/actions/completion.ts`                                                           | 3.5           | Bash, Zsh, and Fish must remain identical in capability    |
| `src/lib/formatters/index.ts`, `src/lib/exit-codes.ts`, `src/lib/error-formatters.ts` | 3.6           | Presentation and terminal status, not decision logic       |
| `src/reconcile*.integration.spec.ts`                                                  | 4.1           | Cross-layer and optional Docker-backed proof               |
| `package.json`, `package-lock.json`                                                   | 4.2           | Patched YAML only; no unrelated upgrades                   |
| Reconcile/drift/package docs                                                          | 4.3           | Primary operator contract                                  |
| JSON/MCP/completion docs                                                              | 4.3           | Automation and generated-surface contract                  |
| Architecture/plan/quick-reference docs                                                | 4.3           | Workflow boundaries and concise examples                   |
| `docs/README.md`, `README.md`, `ROADMAP.md`, `graphify-out/`                          | 4.4           | Final indexes, issue state, and generated graph            |

Every production file above should have its existing or new focused spec included in the same
task. If one implementor owns a shared file across sequential tasks (`lib/reconcile.ts` or
`lib/docker.ts`), preserve that ownership across the phase to minimize merge conflicts.

## Optimization Opportunities

- Run Tasks 1.1, 1.2, and 1.3 concurrently, then let one integration owner perform Task 1.4 against
  the settled observation type. This maximizes parallelism without having several agents edit the
  same module.
- Assign `lib/reconcile.ts` to one owner for Tasks 1.1 and 2.2 and `lib/docker.ts` to one owner for
  Tasks 1.3 and 2.1. Sequential same-file ownership avoids mechanical merge repair.
- Use injected dependency harnesses modeled on managed-update tests for the coordinator and action;
  this exercises phase ordering and negative side effects without slow module-global mocks.
- Add table-driven action-selection and exact-argv matrices early. They provide high coverage of
  the two most security-sensitive pure surfaces with little fixture cost.
- Reuse existing canonical JSON/fingerprint helpers, lifecycle lock, dependency graph, readiness
  polling, formatter capture, and scope expansion. Extract only the identity helpers that truly
  need a neutral owner.
- Run focused tests after each task, then one Phase 1 regression set (drift, plan-generator,
  managed-update), one Phase 3 public-surface set (action, command, MCP, completion, formatters), and
  one final full suite. This catches local errors without repeatedly paying full-suite cost.
- Generate Graphify only once after final source/docs changes. Earlier updates create avoidable
  generated-file conflicts.
- Prepare child issues from these phase/task boundaries, but keep the closing PR as one integrated
  change because the old legacy path is unsafe until all phases land together.

## Implementation Strategy Recommendations

1. Freeze `reconcile.v1` and reason codes before writing CLI or MCP schemas. Treat deterministic
   ordering and complete service accounting as contract tests, not renderer behavior.
2. Build a pure planner over typed complete observations. The stateful coordinator should consume
   that planner before and during revalidation rather than duplicate action selection.
3. Preserve raw Compose/inspect/environment evidence only inside the process. Cross every output
   boundary through allowlisted result construction, and test that secret values and authority
   components cannot serialize.
4. Add observation before mutation. A stopped or scaled service must be represented correctly
   before any logic decides whether it is safe to create, start, recreate, or block.
5. Use the existing lifecycle lock namespace and canonical identity implementation for mutual
   exclusion with managed update. Revalidate under the lock and immediately before each action;
   there is no force/stale bypass.
6. Execute one explicit service at a time, sequentially within strict dependency phases, and
   verify both readiness and fresh drift. Compose exit zero alone is not convergence.
7. Implement the top-level action as the single public orchestration boundary. Legacy CLI and MCP
   routes should translate inputs and delegate, with tests proving the old broad mutation path and
   fallback result are unreachable.
8. Prove negative guarantees explicitly: no prompt/lock/mutation/persistence in report mode; no
   mutation under dry-run; no machine mutation without explicit authorization; no orphan removal,
   pull, build, volumes, implicit dependencies, or scope widening.
9. Update all three completion templates and all normative docs in the same release. Keep issue
   #169 limited to the injected policy seam and follow-up references.
10. Finish with focused tests, full rfapps tests/coverage, typecheck, build, lint/format, dependency
    audit, Markdown/link checks, `git diff --check`, Docker-backed tests when available, and
    `graphify update .`. Only then update final ROADMAP/issue/PR status.
