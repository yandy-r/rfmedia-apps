# Service Conflict Detection Implementation Plan

Add `rfapps deploy --validate-first` as one fail-closed gate that resolves the concrete Compose
scope, gathers bounded Docker-owned evidence, and evaluates deterministic port, volume, and
network conflicts before any mutation or persistence. Freeze the versioned result contract first,
then build the pure evaluator, effective-scope closure, and strict Docker adapter as independent
streams before converging in `executeDeploy()`. Finish with a small set of mutation-boundary
integration tests, exact Bash/Zsh/Fish parity, operator documentation, roadmap archival, formal
review, CI, squash merge, and worktree cleanup.

## Critically Relevant Files and Documentation

- `docs/plans/service-conflict-detection/feature-spec.md`: Approved behavior and scope.
- `docs/plans/service-conflict-detection/shared.md`: Required architectural context and patterns.
- `packages/rfapps-cli/CLAUDE.md`: Package-specific implementation rules.
- `packages/rfapps-cli/src/cli.ts`: Deploy option registration and state-lock entrypoint.
- `packages/rfapps-cli/src/actions/deploy.ts`: Single pre-mutation orchestration seam.
- `packages/rfapps-cli/src/lib/docker.ts`: Compose and Docker execution/evidence boundary.
- `packages/rfapps-cli/src/lib/dependency-graph.ts`: Dependency extraction and execution phases.
- `packages/rfapps-cli/src/lib/security-audit.ts`: Pure deterministic evaluator precedent.
- `packages/rfapps-cli/src/lib/identity.ts`: Compose and Docker authority identity helpers.
- `packages/rfapps-cli/src/lib/env-tools.ts`: Effective environment capture.
- `packages/rfapps-cli/src/lib/formatters/index.ts`: One-document machine formatter.
- `packages/rfapps-cli/src/actions/completion.ts`: Bash, Zsh, and Fish templates.
- `packages/rfapps-cli/src/testing/cli-harness.ts`: Real-process integration harness.
- `packages/rfapps-cli/README.md`: Package-level command contract.
- `ROADMAP.md`: Active issue #64 roadmap entries.
- `.github/pull_request_template.md`: Required pull-request body.

## Implementation Plan

### Phase 1: Contract and Dependency Foundation

#### Task 1.1: Add the CIDR dependency and review the lockfile Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/service-conflict-detection/feature-spec.md`
- `packages/rfapps-cli/package.json`
- `package-lock.json`

**Instructions**

Files to Modify

- `packages/rfapps-cli/package.json`
- `package-lock.json`

Add `ipaddr.js` as the only new production dependency in the rfapps workspace. Generate the
lockfile through npm, verify the package has no runtime dependency fan-out, and inspect both
production-only and full audit results without force-upgrading unrelated vulnerable packages.
Record any pre-existing advisory separately from the feature delta.

#### Task 1.2: Define versioned validation and deploy contracts Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/service-conflict-detection/feature-spec.md`
- `packages/rfapps-cli/src/types/audit.ts`
- `packages/rfapps-cli/src/types/options.ts`
- `packages/rfapps-cli/src/types/results.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/types/validation.ts`

Files to Modify

- `packages/rfapps-cli/src/types/options.ts`
- `packages/rfapps-cli/src/types/results.ts`

Define `conflict-validation.v1`, `passed | blocked | inconclusive`, typed check/failure,
port/volume/network party, finding, summary, limitation, and inert resolution contracts. Add the
required normalized `DeployOptions.validateFirst` boolean and optional
`DeployResult.validation`, preserving the result shape when the flag is absent. Keep the types
dependency-free, strict, deterministic, and free of timestamps or raw Docker payloads.

### Phase 2: Independent Core Workstreams

#### Task 2.1: Implement the pure conflict evaluator and critical rule tests Depends on [1.1, 1.2]

**READ THESE BEFORE TASK**

- `docs/plans/service-conflict-detection/feature-spec.md`
- `packages/rfapps-cli/src/types/validation.ts`
- `packages/rfapps-cli/src/lib/security-audit.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/lib/conflict-validation.ts`
- `packages/rfapps-cli/src/lib/conflict-validation.spec.ts`

Implement a side-effect-free evaluator and human projection. Preserve port protocol, address
family, wildcard/specific binding, fixed intervals, dynamic allocation, and choice-range
semantics. Block volumes only for contradictory effective definitions, missing required external
identity, or different sources/types mapped to one service target; ordinary shared storage and
mixed access modes pass. Compare explicit IPv4/IPv6 network subnets through a narrow `ipaddr.js`
wrapper. Use authoritative Compose ownership for self-exclusion, stable sanitized IDs and
ordering, manual-only resolutions, and explicit limitations.

Keep tests table-driven and risk-owned: cover conflict and non-conflict boundaries, deterministic
permutations, malformed CIDR/inconclusive aggregation, sanitization, and immutability without
duplicating CLI behavior.

#### Task 2.2: Add fail-closed effective service closure Depends on [1.2]

**READ THESE BEFORE TASK**

- `docs/plans/service-conflict-detection/feature-spec.md`
- `packages/rfapps-cli/src/lib/dependency-graph.ts`
- `packages/rfapps-cli/src/lib/dependency-graph.spec.ts`
- `packages/rfapps-cli/src/lib/interactive-selection.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/lib/dependency-graph.ts`
- `packages/rfapps-cli/src/lib/dependency-graph.spec.ts`

Add a pure safety-oriented closure helper over an already-resolved Compose service model. Expand
targeted selection through transitive `depends_on` and `network_mode: service:` relationships;
turn untargeted empty scope into sorted concrete services. Treat missing references and cycles as
explicit failures. Keep the legacy phase planner's current fail-open execution fallback unchanged.
Test only transitive closure, network-mode providers, all-scope expansion, sorting, missing
references, and cycles.

#### Task 2.3: Add strict bounded Compose and Docker evidence adapters Depends on [1.2]

**READ THESE BEFORE TASK**

- `docs/plans/service-conflict-detection/feature-spec.md`
- `packages/rfapps-cli/src/lib/docker.ts`
- `packages/rfapps-cli/src/lib/docker.spec.ts`
- `packages/rfapps-cli/src/lib/identity.ts`
- `packages/rfapps-cli/src/lib/env-tools.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/lib/docker.ts`
- `packages/rfapps-cli/src/lib/docker.spec.ts`

Widen the canonical Compose model to cover long-form ports, mounts, dependencies, effective
volumes, and network IPAM. Add dedicated strict readers that list validated resource identities,
inspect containers/networks/volumes in bounded batches, parse external JSON as `unknown`, reject
duplicates/partial/malformed/oversized evidence, and immediately project only needed fields.
Container evidence must use actual published bindings, mounts, and Compose labels.

Preserve argument-array execution, active context/SSH/TLS behavior, environment tools, pinned
environment, working directory, profiles, env file, timeouts, and existing permissive helpers for
their current callers. Tests own exact read-only argv, projections, batching/bounds, failures, and
environment propagation.

### Phase 3: Export and Deploy Convergence

#### Task 3.1: Export the settled feature seams Depends on [2.1, 2.2, 2.3]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/types/index.ts`
- `packages/rfapps-cli/src/lib/index.ts`
- `packages/rfapps-cli/src/types/validation.ts`
- `packages/rfapps-cli/src/lib/conflict-validation.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/types/index.ts`
- `packages/rfapps-cli/src/lib/index.ts`

Export the stable public validation constants/types and the cohesive evaluator, scope, and strict
evidence seams. Keep detector internals private and do not add the feature to MCP, plan, apply, or
rebuild. Run typecheck to catch ESM/type-only export mistakes before action integration.

#### Task 3.2: Register and enforce the single deploy preflight Depends on [3.1]

**READ THESE BEFORE TASK**

- `docs/plans/service-conflict-detection/feature-spec.md`
- `packages/rfapps-cli/src/cli.ts`
- `packages/rfapps-cli/src/actions/deploy.ts`
- `packages/rfapps-cli/src/actions/deploy.spec.ts`
- `packages/rfapps-cli/src/lib/exit-codes.ts`
- `packages/rfapps-cli/src/lib/formatters/index.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/cli.ts`
- `packages/rfapps-cli/src/actions/deploy.ts`
- `packages/rfapps-cli/src/actions/deploy.spec.ts`

Register deploy-only `--validate-first`, normalize it, and reject invalid explicit profiles or
`--output csv --validate-first` through the established usage-error path. In `executeDeploy()`,
create the result envelope and run one validation gate after static config/selection/canonical
scope resolution but before dry-run return, confirmation, pull, parallel/sequential split,
readiness, database initialization, or state writes.

Attach `passed` evidence to later results. For `blocked` or `inconclusive`, emit the complete
sanitized result once, set operational exit `1`, and return with zero mutation. `--yes` never
waives the gate and `--allow-partial` remains post-mutation only. Bind validation and deployment
to the same Compose inputs/effective Docker authority and recheck their fingerprints immediately
before the first real write. Preserve every no-flag path.

Action tests own gate ordering, one result per status, dry-run/machine behavior, `--yes`,
`--allow-partial`, input/authority drift, shared parallel/sequential placement, and no database or
Docker mutation on non-pass. Do not duplicate the evaluator matrix here.

### Phase 4: Critical Integration, Completion, and Documentation

#### Task 4.1: Add typed fake-Docker preflight fixtures Depends on [2.3]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/testing/mock-docker.ts`
- `packages/rfapps-cli/src/testing/deploy-scenarios.ts`
- `packages/rfapps-cli/src/lib/docker.spec.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/testing/mock-docker.ts`
- `packages/rfapps-cli/src/testing/deploy-scenarios.ts`

Add reusable typed builders for resolved Compose resources and container/network/volume inspect
responses. Add precise first-match rules for pass, blocked, and inconclusive preflights without
changing legacy no-flag deploy scenarios. Match production projection shapes and expose enough
invocation evidence for read-before-write assertions.

#### Task 4.2: Prove critical real-CLI mutation boundaries Depends on [3.2, 4.1]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/cli.deploy.integration.spec.ts`
- `packages/rfapps-cli/src/testing/cli-harness.ts`
- `packages/rfapps-cli/src/testing/deploy-scenarios.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/cli.deploy.integration.spec.ts`

Add only decisive subprocess scenarios: passing validate-first dry-run emits one deterministic
document without mutation; a runtime port conflict blocks before pull/up/readiness/state DB; bad
required evidence is inconclusive with the same boundary; one passing real deploy hands off to
the existing flow; and the legacy no-flag late-port-failure case remains unchanged. Inspect actual
fake-Docker invocations and isolated state paths rather than relying only on returned status.

#### Task 4.3: Restore exact deploy completion parity Depends on [3.2]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/cli.ts`
- `packages/rfapps-cli/src/actions/completion.ts`
- `packages/rfapps-cli/src/actions/completion.spec.ts`
- `docs/features/shell-completion.md`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/actions/completion.ts`
- `packages/rfapps-cli/src/actions/completion.spec.ts`
- `docs/features/shell-completion.md`

Add `--validate-first` to Bash, Zsh, and Fish. Audit the full deploy surface, restore the currently
missing `--allow-partial`, and split deploy/rebuild blocks so deploy-only `--force-recreate` does
not leak to rebuild. Extract each shell's deploy option set and compare exact equality with
Commander, following the existing parity precedent. Update the completion guide with the exact
deploy surface and audit result.

#### Task 4.4: Document the operator and package contract Depends on [4.2, 4.3]

**READ THESE BEFORE TASK**

- `docs/plans/service-conflict-detection/feature-spec.md`
- `packages/rfapps-cli/README.md`
- `docs/features/dry-run-mode.md`
- `docs/features/output-formats.md`
- `docs/features/error-handling.md`

**Instructions**

Files to Create

- `docs/features/service-conflict-detection.md`

Files to Modify

- `packages/rfapps-cli/README.md`

Document invocation, effective scope, objective port/volume/network rules, the three statuses,
exit codes, JSON/YAML nesting, CSV rejection, manual-only suggestions, `--yes`,
`--allow-partial`, dry-run behavior, remote authority, privacy, troubleshooting, and point-in-time
limitations. Do not claim coverage of non-Docker listeners, host routes, host-network application
sockets, dynamic reservations, or application-level volume compatibility. Use complete
deterministic examples without secrets or absolute bind paths.

#### Task 4.5: Correct affected dry-run and output contracts Depends on [4.2]

**READ THESE BEFORE TASK**

- `docs/features/dry-run-mode.md`
- `docs/features/output-formats.md`
- `docs/features/error-handling.md`
- `docs/plans/service-conflict-detection/feature-spec.md`

**Instructions**

Files to Modify

- `docs/features/dry-run-mode.md`
- `docs/features/output-formats.md`
- `docs/features/error-handling.md`

Correct public statements that become false when `--validate-first` is present. Dry-run remains
non-mutating but performs scoped read-only Compose/Engine inspection with the flag. JSON/YAML can
carry one nested validation result while CSV with the flag is a usage error. Distinguish an
invalid invocation from valid `blocked`/`inconclusive` preflight outcomes that exit `1` and emit
one structured document in machine mode. Keep all no-flag documentation unchanged.

#### Task 4.6: Index the feature and update architecture boundaries Depends on [4.4, 4.5]

**READ THESE BEFORE TASK**

- `docs/README.md`
- `docs/architecture/data-flow.md`
- `docs/architecture/overview.md`
- `docs/features/service-conflict-detection.md`

**Instructions**

Files to Modify

- `docs/README.md`
- `docs/architecture/data-flow.md`
- `docs/architecture/overview.md`

Index the canonical feature guide. Update rfapps deploy flow to show canonical scope, bounded
read-only evidence, the pure evaluator, pass/non-pass branches, and the pre-mutation/no-persistence
boundary above sequential and parallel execution. Add the evaluator/adapter layering and
`ipaddr.js` dependency to the architecture overview without describing a new service, HTTP API,
MCP surface, saved plan, or resource reservation.

### Phase 5: Roadmap, Verification, Review, and Delivery

#### Task 5.1: Run exact local gates and formal review Depends on [4.3, 4.4, 4.5, 4.6]

**READ THESE BEFORE TASK**

- `docs/plans/service-conflict-detection/feature-spec.md`
- `packages/rfapps-cli/package.json`
- `package.json`
- `.gitignore`

**Instructions**

Files to Create

- None; this is a verification and review task.

Run these exact gates and require exit `0` for format, focused/full tests, coverage, typecheck,
build, Markdown lint, and diff checks:

- `npm run format:check`
- `npx vitest run packages/rfapps-cli/src/lib/conflict-validation.spec.ts packages/rfapps-cli/src/lib/dependency-graph.spec.ts packages/rfapps-cli/src/lib/docker.spec.ts packages/rfapps-cli/src/actions/deploy.spec.ts packages/rfapps-cli/src/actions/completion.spec.ts packages/rfapps-cli/src/cli.deploy.integration.spec.ts`
- `npm run typecheck -w packages/rfapps-cli`
- `npm run test:rfapps`
- `npm run test:coverage:rfapps`
- `npm run build:rfapps`
- `npm run lint:md`
- `git diff --check`

Run `npm audit --omit=dev` and `npm audit`, capture their JSON baselines and final results, and
require that the new dependency introduces no advisory or worsens severity/count. A nonzero exit
caused solely by a documented pre-existing advisory is acceptable; do not force-upgrade unrelated
packages.

Because `graphify-out/` is ignored and absent in the issue worktree, seed that machine-local
directory from the primary checkout's existing `graphify-out/` before running `graphify update .`
inside the issue worktree. Inspect the update but do not stage ignored Graphify files. If the
primary checkout no longer has a graph, stop and run a full `graphify extract . --no-cluster`
bootstrap before `graphify update .`; never treat a missing graph as a successful refresh.

Dispatch the mandatory independent code review after each code batch and a formal whole-diff
review here, focusing on mutation ordering, fail-closed parsing, secret leakage, determinism,
scope correctness, completion parity, and no-flag compatibility.

This task never edits implementation files directly. Convert every actionable review finding into
a new serialized file-scoped fix task that names the exact owned path, applies the smallest safe
change, and reruns the owning focused test. After all fixes, rerun the exact full gate list above.

#### Task 5.2: Publish the initial pull request Depends on [5.1]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/service-conflict-detection/feature-spec.md`

**Instructions**

Files to Create

- None; this is a Git/GitHub publication task.

Confirm the diff is issue-scoped, commit through repository validation without bypassing hooks,
push `feat/64-service-conflict-detection` to the GitHub PR remote, and open a pull request using
the repository template. Preserve all required sections, include exact gate outcomes, and use
`Closes #64`. Record the real PR number for the next task.

#### Task 5.3: Update roadmap and shipped archive with the real PR Depends on [5.2]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `docs/roadmap-archive.md`

**Instructions**

Files to Modify

- `ROADMAP.md`
- `docs/roadmap-archive.md`

Remove or mark both live #64 roadmap entries consistently and add one shipped archive entry using
the actual date and PR link from Task 5.2. Do not use placeholder metadata. Format and lint these
files, commit the roadmap update, and push it to the open PR.

#### Task 5.4: Reverify, monitor, squash-merge, and clean up Depends on [5.3]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/service-conflict-detection/feature-spec.md`
- `ROADMAP.md`

**Instructions**

Files to Create

- None; this is a verification and delivery task.

Rerun the exact Task 5.1 gates on the final head, then monitor required checks on the active head
SHA and inspect every top-level comment, review, and unresolved inline thread. Convert each
actionable code-review or CI finding into a serialized file-scoped fix task with its owning test;
do not mutate arbitrary files inside this lifecycle task. Push verified fixes and continue until
required CI and review state are green.

Squash-merge the PR, verify the remote default branch contains the merge and issue #64 is closed,
then remove only `feat/64-service-conflict-detection` and its issue worktree. Preserve unrelated
worktrees and user changes, prune safely, and fast-forward the primary checkout to the confirmed
remote default branch.

## Advice

- Keep resolved Compose and Docker inspect payloads ephemeral; project allowlisted fields before
  errors, logs, or results can observe them.
- The existing `computeExecutionPhases()` and permissive Docker helpers are not safety evidence;
  add separate fail-closed seams and preserve their legacy callers.
- Treat a published target range as a choice pool, not ownership of every port, and represent all
  ranges as intervals to avoid unbounded expansion.
- Ordinary shared binds/named volumes and mixed `ro`/`rw` modes are valid; volume blocking must
  stay limited to objective contradictions.
- A passing preflight is point-in-time evidence, not a reservation. Docker remains the final
  allocator, especially with remote contexts and independent clients.
- Serialize edits to `package-lock.json`, barrel files, `docker.ts`, `deploy.ts`, and completion
  templates; those are convergence hotspots.
- Keep test ownership by risk layer so the requested critical suite remains decisive and fast.
- Completion work is a full Bash/Zsh/Fish audit, not a single-token addition; report the final
  parity result explicitly.
