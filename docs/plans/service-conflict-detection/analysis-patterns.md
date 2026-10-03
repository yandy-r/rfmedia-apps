# Pattern & Code Analysis: service-conflict-detection

## Executive Summary

The feature fits the repository's established command/action/library/type layering: Commander
registers `--validate-first`, `executeDeploy()` owns orchestration, a dedicated library module
evaluates typed evidence without side effects, and the existing formatter/exit-code paths present
one result. The closest implementation precedent is the security-audit engine, while the safest
Docker evidence precedent is the hardened Compose observation and identity code—not the older
permissive Compose/inspect helpers.

The preflight must be one shared gate after service/profile/sidecar resolution and a newly computed
transitive Compose dependency closure, but before the current dry-run branch, confirmation, and
parallel/sequential split. The existing dependency-graph orchestrator cannot be reused unchanged:
it filters dependencies to the caller's target set, omits some effective Compose inputs, and falls
back to independent services when Compose resolution fails. Conflict validation instead requires
one already-resolved canonical model and fail-closed scope/evidence handling.

Implementation should preserve strict TypeScript/ESM conventions, model expected
`passed`/`blocked`/`inconclusive` outcomes as data rather than exceptions, validate untrusted Docker
JSON at its boundary, sort all public arrays explicitly, and prove through subprocess integration
tests that blocked or incomplete validation performs no pull, start, readiness, database, or state
operation.

## Implementation Patterns

### Inline command registration with lazy action loading

Most rfapps commands, including deploy, are registered directly in
`packages/rfapps-cli/src/cli.ts`. Add the boolean option beside deploy's other local options and
keep the existing lazy import of `actions/deploy.js`. This preserves startup behavior and avoids a
new command module for one flag.

The raw Commander shape belongs in `RawDeployOptions` in
`packages/rfapps-cli/src/actions/deploy.ts`; the normalized boolean belongs in `DeployOptions` in
`packages/rfapps-cli/src/types/options.ts`. Default it to `false` so the existing action path and
output remain unchanged when the flag is absent.

Reject `--output csv --validate-first` and invalid profiles through
`InvalidArgumentError`, allowing the global error formatter to retain usage exit `2`. Do not
silently drop an invalid profile as deploy currently does when `isValidProfile()` is false.

### One action-level gate above every execution path

The current deploy sequence is:

```text
normalize options
  -> load/apply config
  -> static config-reference validation
  -> resolve requested services/groups/interactive selection/sidecars/profiles
  -> dry-run branch
  -> confirmation
  -> initialize DeployResult
  -> parallel or sequential pull/start/readiness/state paths
```

Insert conflict validation after resolution and effective dependency closure but before the
dry-run branch in `packages/rfapps-cli/src/actions/deploy.ts`. This placement gives dry-run the same
fresh read-only evidence and prevents parallel and sequential behavior from diverging.

Build the preflight result before rendering. On `blocked` or `inconclusive`, attach it to a
zero-start deploy result, add a stable `FailedOperation` such as
`{ name: "validation", code: "SERVICE_CONFLICT", error: ... }`, emit it once in structured mode,
set operational exit `1`, and return. Do not throw after rendering, because the global handler
could emit a second error or contaminate machine output.

On `passed`, retain the validation object and attach it to the eventual real or dry-run result.
`--allow-partial` remains relevant only to `resolveDeployExitCode()` after some deployment success;
the preflight directly uses `ExitCode.OperationalError`.

### Pure evaluator with a narrow public seam

Follow `packages/rfapps-cli/src/lib/security-audit.ts`:

- accept typed, already validated records;
- use small resource-specific helpers rather than classes or a rule registry;
- return a complete typed result;
- centralize stable comparison and summary construction;
- format human text from the same result;
- perform no Docker calls, logging, prompting, persistence, or exit mutation.

Create `packages/rfapps-cli/src/lib/conflict-validation.ts` for:

- canonical desired/runtime projections;
- port interval and bind-address comparison;
- named-volume definition and duplicate-target comparison;
- a narrow `ipaddr.js` CIDR wrapper and interval overlap;
- deterministic conflict IDs, stable sorting, limitations, and inert resolutions;
- human text projection.

Keep public contracts in `packages/rfapps-cli/src/types/validation.ts` and export them through
`types/index.ts`. Export only the cohesive evaluator/orchestrator seam through `lib/index.ts`;
detector internals should remain private until another real consumer exists.

### Dedicated fail-closed Docker evidence adapters

Build on the transport in `packages/rfapps-cli/src/lib/docker.ts`, but add dedicated conflict
snapshot functions. Reuse `execDocker()`/`execDockerCompose()` so contexts, SSH retries, timeouts,
capture limits, environment-tool wrapping, and argument arrays remain consistent.

Use the hardening pattern in `getComposeContainerObservations()`:

- validate paths, profile/project names, Docker IDs, field lengths, and array sizes;
- list IDs first and inspect in bounded batches;
- distinguish empty evidence from failed or malformed evidence;
- reject duplicates, partial/truncated JSON, unsafe controls, and excessive output;
- project only fields needed by the evaluator;
- return stable typed errors with sanitized messages;
- sort before returning.

Do not route the feature through the older `inspectContainers()` or current
`getComposeConfig()` failure behavior without hardening. Those helpers return
`undefined` on errors and may log raw Docker/Compose diagnostics; an empty or missing value is not
a passing preflight.

Capture one resolved Compose model for scope and desired claims. The same final Compose path,
profiles, environment file, working directory, and environment-tool configuration must be threaded
into resolution and later Docker operations. Use `resolveComposeProjectIdentity()`,
`captureEffectiveEnvironment()`, and the Docker authority fingerprint helpers as patterns for
stable authority. A real deploy is already under the global state lock, while global dry-run is
lock-free; neither condition removes the unavoidable race with independent Docker clients.

### Deterministic result and presentation

Use a schema constant declared `as const`, discriminated unions for resource/party/resolution
variants, stable enum-like string unions for codes, and a fixed rank map for status/kind ordering.
This matches `types/audit.ts`, `types/reconcile.ts`, and `lib/exit-codes.ts`.

All arrays exposed in `conflict-validation.v1` must be sorted copies:

- effective services and profiles;
- evidence checks;
- conflicts and warnings;
- parties;
- resolutions;
- limitations.

Derive IDs from normalized facts and sorted owners; do not include discovery order, timestamps, or
durations. Human and table output should be a projection of the typed result. JSON/YAML must flow
through `formatOutput()` in `packages/rfapps-cli/src/lib/formatters/index.ts`, which is the
repository's single machine-output dispatcher. Human conflict details should be line-oriented and
must not rely on color alone.

### Objective detector rules

Port normalization must preserve address family, bind address, protocol, fixed interval, and
allocation mode. Compare fixed desired claims with other effective desired claims and actual
running-container bindings. Wildcards intersect specific addresses only within the same family;
TCP and UDP are independent. A single-target published range is a choice pool, not ownership of
every member. Never use `expose` or infer listeners for `network_mode: host`.

Volume evaluation must compare effective runtime names and normalized driver/options. Ordinary
shared named volumes, bind sources, mixed access modes, and parent/child paths are not blockers.
The only v1 blockers are contradictory volume definitions, a conflicting existing non-external
volume definition, and different sources/types mapped to the same target within one service.

Network evaluation must compare explicit `ipam.config[].subnet` intervals of the same family.
`ip_range` is subordinate to its parent subnet. Auto-assigned networks create a limitation, not a
fabricated claim. Exclude the existing network whose effective name is the same resource Compose
will reuse.

### Layered testing instead of duplicated exhaustive suites

Use:

1. table-driven pure tests in `lib/conflict-validation.spec.ts` for the rule matrix, negative
   cases, boundary values, stable sorting, IDs, and sanitization;
2. `lib/docker.spec.ts` for exact argv, batching, bounds, malformed evidence, and environment
   propagation;
3. `actions/deploy.spec.ts` for gate placement, output, modes, and exit behavior with injected
   evidence;
4. `cli.deploy.integration.spec.ts` with the fake Docker subprocess for a small number of critical
   mutation-boundary scenarios;
5. `actions/completion.spec.ts` for exact Commander parity in Bash, Zsh, and Fish.

The CLI executes at module load, so full command tests should continue using
`packages/rfapps-cli/src/testing/cli-harness.ts` rather than importing `cli.ts` as a Commander
factory.

## Existing Code Structure

| Path                                                                              | Existing responsibility                                                                                                               | Feature use or required change                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/cli.ts`                                                  | Global option normalization, state-lock acquisition, inline deploy registration, lazy action import, exit help                        | Add deploy-only `--validate-first`; keep lazy loading and existing exit categories                                              |
| `packages/rfapps-cli/src/actions/deploy.ts`                                       | Config resolution, static validation, target selection, dry-run, confirmation, parallel/sequential deploy, readiness, state recording | Add normalized flag, explicit profile rejection, one preflight gate, validation result attachment, and early no-mutation return |
| `packages/rfapps-cli/src/types/options.ts`                                        | Shared/global/command option interfaces                                                                                               | Add required normalized `validateFirst: boolean` to `DeployOptions`                                                             |
| `packages/rfapps-cli/src/types/results.ts`                                        | Existing operation envelopes and `FailedOperation`                                                                                    | Add optional validation evidence to `DeployResult`; preserve existing fields                                                    |
| `packages/rfapps-cli/src/types/index.ts`                                          | Type/constant barrel                                                                                                                  | Export validation schema constant and public unions/interfaces                                                                  |
| `packages/rfapps-cli/src/lib/index.ts`                                            | Action-facing library barrel                                                                                                          | Export the cohesive conflict validation/snapshot seam and necessary types                                                       |
| `packages/rfapps-cli/src/lib/validation.ts`                                       | Cached raw-YAML service/reference validation                                                                                          | Keep unchanged in purpose and run first; do not add daemon conflict logic                                                       |
| `packages/rfapps-cli/src/lib/interactive-selection.ts`                            | Explicit/group/interactive target resolution, deduplication, sidecar expansion, profile detection                                     | Supply the requested base scope; it does not compute transitive Compose dependencies                                            |
| `packages/rfapps-cli/src/lib/dependency-graph.ts`                                 | Phase graph for a supplied service set                                                                                                | Reuse dependency extraction ideas only; add a separate closure helper over the already-resolved model                           |
| `packages/rfapps-cli/src/lib/docker.ts`                                           | Docker transport, Compose config, container operations, identity observations                                                         | Widen canonical Compose types and add bounded projected container/network/volume readers                                        |
| `packages/rfapps-cli/src/lib/identity.ts`                                         | Canonical Compose project identity and one-way Docker authority fingerprint                                                           | Reuse for authoritative self-exclusion and pre-mutation authority checks                                                        |
| `packages/rfapps-cli/src/lib/env-tools.ts`                                        | Secrets-tool execution and bounded effective-environment capture                                                                      | Ensure desired/runtime inspection and mutation use consistent effective inputs                                                  |
| `packages/rfapps-cli/src/lib/security-audit.ts`                                   | Pure sorted finding engine plus text projection                                                                                       | Primary structural precedent for the evaluator                                                                                  |
| `packages/rfapps-cli/src/lib/exit-codes.ts`                                       | Stable `0/1/2/3` categories and deploy partial-success logic                                                                          | Use direct operational error for preflight failure; do not classify it as partial                                               |
| `packages/rfapps-cli/src/lib/formatters/index.ts`                                 | JSON/YAML/CSV/table dispatch and output capture                                                                                       | Emit the one structured deploy document; reject CSV before reaching nested serialization                                        |
| `packages/rfapps-cli/src/actions/completion.ts`                                   | Static Bash/Zsh/Fish templates                                                                                                        | Add both deploy-only flags and split combined deploy/rebuild branches                                                           |
| `packages/rfapps-cli/src/actions/completion.spec.ts`                              | Completion surface and reconcile-only exact parity precedent                                                                          | Add a deploy Commander builder/parser and exact parity assertions for all three shells                                          |
| `packages/rfapps-cli/src/testing/mock-docker.ts`                                  | Typed scenario rules, argv log, canned Docker payload builders                                                                        | Add typed canonical Compose and projected container/network/volume builders                                                     |
| `packages/rfapps-cli/src/testing/deploy-scenarios.ts`                             | Shared deploy/readiness fake-Docker rules                                                                                             | Add narrowly matched preflight rules without making all legacy deploy scenarios validate                                        |
| `packages/rfapps-cli/src/cli.deploy.integration.spec.ts`                          | Real CLI process, invocation ordering, state-lock/database assertions                                                                 | Add validate-first pass/block/inconclusive scenarios and preserve existing no-flag D4 behavior                                  |
| `packages/rfapps-cli/package.json` and root `package-lock.json`                   | Workspace dependency declarations and lockfile                                                                                        | Add reviewed `ipaddr.js` dependency and verify audit/integrity                                                                  |
| `packages/rfapps-cli/README.md` and `docs/features/service-conflict-detection.md` | User-facing CLI and feature contracts                                                                                                 | Document flag, schema, objective rules, exits, limitations, and manual recovery                                                 |

No database migration, state table, configuration key, cache, MCP mutation, or persisted preflight
artifact is part of this feature.

## Code Conventions

- Use ESM/NodeNext imports with `.js` extensions for local modules, even from TypeScript source.
- Use `import type` and `export type` for type-only dependencies because
  `verbatimModuleSyntax` and `isolatedModules` are enabled.
- Production code is strict TypeScript: no `any`; parse external JSON as `unknown`, narrow it, and
  project only allowlisted fields.
- Account for `noUncheckedIndexedAccess`; guard indexed values and regex captures explicitly.
- Prefer interfaces for public record contracts and discriminated unions for variant resources,
  owners, errors, and resolutions.
- Use `readonly` for evaluator inputs/results where practical, `as const` for schema constants,
  and `satisfies` for complete rank/code maps.
- Keep command modules thin, actions responsible for orchestration/output, libraries responsible
  for reusable logic/I/O, and types dependency-free.
- Use argument arrays with the existing Docker runner; never build shell command strings or
  execute generated remediation text.
- Throw early for invalid invocation or programmer errors. Return expected conflict outcomes as
  typed data. Convert unavailable external evidence into a sanitized `inconclusive` result.
- Sort copies rather than mutating caller-owned arrays. Prefer explicit code-point comparators over
  locale-dependent ordering for machine contracts.
- Keep raw Compose output, Docker inspect objects, effective environments, absolute bind paths,
  and credential metadata ephemeral and out of logs/results.
- Send structured output through `formatOutput()`. Avoid progress, prompts, ANSI, or a second
  document in machine mode.
- Use `setExitCode()`/`ExitCode` helpers rather than scattered numeric assignments. Preserve
  `setDeployExitCode()` for post-deploy result classification.
- Use Vitest colocated `*.spec.ts` files. Hoist dependency mocks when needed, restore
  `process.exitCode` and spies after each test, and extend typed fixture builders rather than
  repeating raw JSON.
- Preserve Markdown spacing and repository documentation conventions; update completion templates
  for every supported shell whenever the CLI surface changes.

## Integration Points

### Deploy lifecycle

`packages/rfapps-cli/src/actions/deploy.ts` is the only v1 orchestration point. The required order
is:

```text
load/apply config
  -> reject invalid profile
  -> existing static config validation
  -> requested/group/interactive selection
  -> sidecar/profile resolution
  -> canonical Compose resolution
  -> concrete all-scope + dependency closure
  -> bounded Docker snapshot
  -> pure evaluation
     -> blocked/inconclusive: emit once, exit 1, return
     -> passed: existing dry-run or confirmation/deploy workflow
```

This gate must precede `computeExecutionPhases()`, `pullImages()`, `executeParallelPhases()`,
`startServices()`, readiness calls, `initializeDatabase()`, and `recordDeployments()`.

### Service scope

`resolveServicesWithInteractive()` returns an empty service array to mean all services in
non-interactive untargeted mode. The validation schema cannot expose `["all"]`; derive concrete
active-profile names from the same resolved Compose model. Starting from the requested/sidecar
set, walk both `depends_on` and `network_mode: service:<name>` transitively, deduplicate, and sort.

Do not call `computeExecutionPhases()` to discover the closure. Its
`buildServiceDependencyGraph()` filters dependencies against the existing target set, and
`computeExecutionPhases()` treats Compose resolution failure as an independent phase instead of an
error. It also calls `getComposeConfig()` with only the environment tool, not the complete final
profile/env-file options.

### Docker and Compose authority

Canonical Compose resolution and runtime snapshot must use the same cwd, environment file,
profiles, environment tool, and active Docker authority. Use Compose project/service labels—not
container-name substrings—to exclude a selected service's current container.

For a real deploy, the CLI pre-action acquires a state lock because deploy is in
`ALWAYS_MUTATING_COMMANDS`; `--dry-run` intentionally skips that lock. Fingerprint/revalidation
reduces input/context substitution but cannot reserve ports or networks against unrelated Docker
clients. Output and docs must retain the point-in-time limitation.

### Error and output pipeline

Use `InvalidArgumentError` for CSV/profile misuse, the typed validation result for expected
blocked/inconclusive outcomes, and stable sanitized adapter error codes for evidence failure.
Avoid passing raw inspection stderr through `DockerCommandError` for public validation output.

Machine success and failure both go through the existing deploy envelope and `formatOutput()`.
Human output should be rendered from the same result to stderr/log channels consistent with other
diagnostic actions. `--yes` suppresses only the post-pass confirmation; machine/non-TTY modes
never prompt.

### Completion and documentation parity

Bash has a dedicated `deploy_opts` string, but Zsh and Fish currently combine deploy and rebuild.
Split those combined branches so `--validate-first`, `--allow-partial`, and `--force-recreate`
remain deploy-only. The current completion tests assert exact Commander parity only for reconcile;
copy that pattern for deploy rather than testing token presence alone.

Update package README, the dedicated feature doc, roadmap/archive state, and exact verification
commands. Adding `ipaddr.js` requires workspace manifest and root lockfile changes plus runtime and
full dependency audit review.

### Critical verification

Focused correctness should cover:

- port protocol/family/wildcard/specific/range-choice/dynamic/self-owner cases;
- valid shared mounts and objective volume contradictions;
- IPv4/IPv6 equality, containment, adjacency, malformed prefixes, and mixed-family separation;
- service, services, group, sidecar, dependency, profile, interactive, and untargeted scope;
- `passed`, `blocked`, and `inconclusive` in text, JSON, YAML, dry-run, `--yes`, and
  `--allow-partial`;
- exact absence of pull/up/readiness/DB/state operations after any non-pass;
- identical safety before parallel and sequential execution;
- deterministic ordering and IDs under permuted fixture/daemon order;
- flag-absent compatibility and exact Bash/Zsh/Fish completion parity.

## Gotchas and Warnings

- `getComposeConfig()` currently types `ports` as `string[]`; canonical Compose JSON commonly
  returns long-form objects. It also omits service mounts, service networks, top-level volumes,
  and top-level network IPAM. Widen and validate the canonical projection before using it.
- Current `getComposeConfig()` logs raw stderr and the first 200 characters of unparsed stdout.
  Resolved Compose can contain interpolated secrets; the conflict path must not reuse that logging
  behavior.
- `ContainerInspect` includes broad `Config.Env` but lacks the precise labels, `Mounts`, and actual
  `NetworkSettings.Ports` needed here. Actual runtime bindings must come from
  `NetworkSettings.Ports`, not only configured `HostConfig.PortBindings`.
- `inspectContainers()` accepts arbitrary names, performs one unbounded inspect call, casts parsed
  JSON, and returns `undefined` on failure. Add a separate bounded reader instead of weakening
  fail-closed semantics.
- `validateConfigAgainstCompose()` is a cached raw-YAML reference checker and uses
  `maxAliasCount: -1`. It is not the canonical resource model and should not absorb daemon
  inspection or conflict-result caching.
- `computeExecutionPhases()` fails open when Compose config is unavailable. Conflict validation
  must instead become `inconclusive`.
- The all-services sentinel appears today in dry-run output as `["all"]`. The v1 validation
  contract requires concrete sorted services, so scope expansion is mandatory.
- The current deploy profile override silently falls back when invalid. If left unchanged,
  validation could describe a different scope from user intent; reject it before applying
  overrides.
- Same numeric port does not imply conflict: protocol and address family matter, wildcard binds
  intersect specifics, and host dual-stack behavior must not be guessed across families.
- A published range for one target is a pool of candidate bindings. Expanding large ranges can
  exhaust memory; retain interval form and cap inputs.
- Stopped containers do not own published ports, but persistent Docker networks and named volumes
  remain relevant. Use resource-specific inventory rules rather than one global running/stopped
  policy.
- Shared volumes and bind paths are common in this repository. Do not classify multiple writers,
  mixed `ro`/`rw`, distinct container targets, or parent/child binds as blocking incompatibility.
- Compare named volumes by effective runtime `name`, not only the logical Compose key. External
  resources have different ownership semantics and must not receive Compose-owned driver policy.
- Compare network `subnet`, not `ip_range`; exclude only the exact intended existing runtime
  network. Unknown third-party IPAM/volume drivers cannot safely inherit built-in-driver rules.
- Non-Docker host listeners, host-network application sockets, host LAN/VPN routes, and
  daemon-assigned ports/subnets are explicit limitations. A local `ss`/`lsof`/socket probe would
  inspect the wrong host for remote contexts and Docker Desktop.
- The real deploy state lock does not eliminate time-of-check/time-of-use races with independent
  Docker clients. Never describe a passing preflight as a reservation or guarantee.
- Machine mode currently suppresses confirmation without globally requiring `--yes`; issue #64
  must not silently introduce a broader consent-policy change. It must still ensure the new flag
  never implies consent or bypasses conflicts.
- `formatOutput()` supports CSV generically, but nested multi-owner/multi-resolution evidence has
  no approved flattening contract. Reject CSV with usage exit `2` before output.
- Zsh and Fish completion templates combine deploy and rebuild, incorrectly advertising
  `--force-recreate` for rebuild, while every shell omits deploy's `--allow-partial`. Fix and
  exact-test the whole deploy surface when adding the new flag.
- Existing integration scenario D4 verifies a late Docker `up` port failure without
  `--validate-first`. Preserve that compatibility case; add separate preflight scenarios rather
  than changing all deploy fixtures.
- The fake Docker uses first-match scenario rules. New `compose config` and `inspect` calls need
  precise matchers or match counts so they do not consume readiness/database rules accidentally.
- `cli.ts` executes at module load, so importing it for Commander parity can trigger the program.
  Use a small deploy command builder if practical or a subprocess/help parser; avoid a broad CLI
  refactor solely for this feature.
- The spec requires no persistence. A blocked preflight must not initialize SQLite, create a state
  DB, write deployment history, or appear as a failed deployment record.
