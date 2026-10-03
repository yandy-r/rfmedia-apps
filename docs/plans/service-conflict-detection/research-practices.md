# Engineering Practices: Service Conflict Detection

## Executive Summary

Implement `deploy --validate-first` as one opt-in, read-only gate after final service/profile
resolution and before the existing dry-run return, confirmation, image pull, parallel execution, or
state writes. The codebase already has the right architectural precedent: a thin action gathers
resolved Compose and Docker evidence, a pure evaluator returns typed and deterministically sorted
findings, and text/machine renderers consume the same result.

Keep the first version deliberately small. Do not build a pip-style solver, automatic remediation,
or a generic validation framework. Reuse the Docker argument-array runner, resolved Compose model,
typed error pipeline, output dispatcher, and subprocess test harness; add only a narrow conflict
contract, runtime snapshot seam, pure evaluator, deploy wiring, and completion/test parity.

## Existing Reusable Code

| Existing code                                                                                                                      | Reuse                                                                                                                                                                                        | Constraint or gap                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/lib/docker.ts#getComposeConfig`                                                                           | Obtain the interpolation/profile-aware desired model using `docker compose config --format json`. Pass `profiles`, `finalConfig.envFile`, and `envTool`.                                     | `ComposeServiceConfig` currently omits volumes, service networks, long port syntax, and top-level network IPAM; extend the type rather than parse raw YAML again. The function returns `undefined` on execution or JSON failure, so the caller must fail closed. |
| `packages/rfapps-cli/src/lib/docker.ts#execDocker` and `execDockerCompose`                                                         | Execute daemon reads with argument arrays, SSH retry, timeouts, bounded capture, and env-tool wrapping.                                                                                      | There is no typed all-container/all-network conflict snapshot helper yet. Never introduce shell strings or `dockerode` beside this established boundary.                                                                                                         |
| `packages/rfapps-cli/src/lib/docker.ts#listContainers` and `inspectContainers`                                                     | Discover daemon-wide containers, then inspect exact IDs/names for port and mount evidence.                                                                                                   | `ContainerInspect` lacks `Mounts`, labels, and sufficiently typed network details. `HostConfig.Binds` alone misses named-volume mounts. Runtime evidence failure must not mean “no conflicts.”                                                                   |
| `packages/rfapps-cli/src/lib/docker.ts#getRunningServiceContainerMap`                                                              | Identify current project service/container ownership where applicable.                                                                                                                       | It only returns running containers and is project-scoped. Excluding containers that this deployment will replace requires explicit, label/project-aware policy.                                                                                                  |
| `packages/rfapps-cli/src/lib/security-audit.ts` and `types/audit.ts`                                                               | Copy the pure engine pattern: typed findings, bounded evidence/remediation, explicit summary, stable sort, and separate text formatting.                                                     | Conflict severity is simpler: blockers versus optional warnings. Do not copy the audit rule catalog or `--fail-on` machinery.                                                                                                                                    |
| `packages/rfapps-cli/src/lib/drift.ts#parseComposePorts` and `packages/rfapps-cli/src/lib/plan-generator.ts#parseComposePorts`     | Evidence that port normalization is already repeated twice; conflict detection is the rule-of-three trigger for a narrow shared resource normalizer.                                         | Both parsers lose host IP, ranges, and one-part/IPv6 short syntax. They are not safe as-is for collision decisions.                                                                                                                                              |
| `packages/rfapps-cli/src/lib/drift.ts#parseComposeVolumes` and `packages/rfapps-cli/src/lib/plan-generator.ts#parseComposeVolumes` | Reuse the common source/target/read-only vocabulary and consolidate syntax parsing when adding the third consumer.                                                                           | Splitting on `:` is lossy for platform-specific paths and does not classify bind versus named volume. Resolved Compose long syntax should be the primary input.                                                                                                  |
| `packages/rfapps-cli/src/lib/validation.ts`                                                                                        | Preserve its current config-to-raw-Compose reference validation as the first deploy validation stage.                                                                                        | It is a cached raw-YAML service-name/config validator, not a runtime conflict engine. Adding daemon inspection here would mix responsibilities and make its cache unsafe.                                                                                        |
| `packages/rfapps-cli/src/actions/deploy.ts#executeDeploy`                                                                          | Insert one gate after `resolveServicesWithInteractive()` and force-recreate calculation, before the dry-run branch and every mutation.                                                       | The action already has parallel and sequential paths. The gate must be above their split so behavior cannot diverge.                                                                                                                                             |
| `packages/rfapps-cli/src/lib/errors.ts` and `lib/error-formatters.ts`                                                              | Add one typed operational error for incomplete/invalid snapshot collection if existing `DockerCommandError` cannot carry enough context. Use registered formatters for operational failures. | Detected conflicts are expected domain results, not exceptional control flow; do not throw one error per finding.                                                                                                                                                |
| `packages/rfapps-cli/src/lib/formatters/index.ts#formatOutput`                                                                     | Emit the same typed result through JSON/YAML/CSV/table paths. Keep human diagnostics on stderr.                                                                                              | Avoid a second JSON serializer or text-only result contract. Omit timestamps from the conflict block if byte-for-byte deterministic output is required.                                                                                                          |
| `packages/rfapps-cli/src/actions/completion.ts` and `completion.spec.ts`                                                           | Update Bash, Zsh, and Fish together and assert Commander parity.                                                                                                                             | Existing deploy completion is already stale: `--allow-partial` is absent, while Zsh/Fish combine deploy with rebuild and advertise deploy-only `--force-recreate` to rebuild. Split deploy/rebuild sections before adding `--validate-first`.                    |
| `packages/rfapps-cli/src/testing/cli-harness.ts`, `mock-docker.ts`, and `deploy-scenarios.ts`                                      | Run the real CLI with isolated config/home and a fake `docker`; assert exact invocation order and absence of mutation.                                                                       | `composeConfigJson()` is image-only and `dockerInspectJson()` is minimal. Extend builders with typed optional ports, mounts, labels, and network-inspect payloads instead of embedding large JSON strings per test.                                              |
| `packages/rfapps-cli/src/cli.deploy.integration.spec.ts`                                                                           | Extend D4’s current late port-conflict coverage into preflight behavior.                                                                                                                     | Current D4 proves the conflict is discovered only by failing `up`; the new assertion must prove no pull, `up`, readiness, or state DB write occurs.                                                                                                              |

## Modularity Design

Use three boundaries, not a class hierarchy:

1. **Evidence collection**: extend `docker.ts` with one typed
   `getConflictRuntimeSnapshot(options)` function (or equivalently two small typed container/network
   readers) that uses existing `execDocker`/`inspectContainers`. It performs Docker I/O and parsing
   only.
2. **Pure conflict evaluation**: add `lib/service-conflicts.ts`. It normalizes desired/runtime
   claims, compares them, creates safe suggestions, builds a summary, and returns findings in stable
   order. It performs no logging, prompting, process exit, Docker calls, or filesystem writes.
3. **Deploy orchestration/rendering**: `executeDeploy()` gathers the resolved Compose model and
   runtime snapshot, invokes the pure evaluator, renders its result, sets the operational exit code,
   and returns before mutation when blockers exist.

Keep contracts in `types/validation.ts`, matching the issue’s proposed location. Extend the existing
Docker Compose/inspect types only for actual Docker payload fields; do not duplicate a second
Compose model inside the conflict module.

The gate belongs after service resolution because groups, sidecars, profiles, and “all services”
change the desired claim set. It belongs before the current dry-run branch so
`--dry-run --validate-first` performs the same read-only validation, and before confirmation so the
operator is never asked to approve a deploy already known to be blocked.

## Shared vs Feature-Specific

Shared:

- Docker command execution, capture bounds, SSH retry, Compose/env/profile argument construction,
  container inspection, and machine-output dispatch.
- Low-level normalization of resolved published ports and resolved volume mounts, because plan and
  drift already implement the same syntax twice.
- Generic primitives with precise meaning, such as a canonical host endpoint
  `{ hostIp, published, protocol }` and a canonical mount `{ type, source, target, readOnly }`.

Feature-specific:

- What constitutes a port, volume, or network conflict.
- Which current-project containers are excluded because they are the replacement target.
- Suggestion text and conflict ordering.
- The opt-in deploy gate and its result/exit behavior.

Do not move conflict findings into the existing `ValidationWarning`; its warning/error model is for
static rfapps-config references and lacks owners, resources, evidence, and suggestions.

## KISS Assessment

The minimum useful implementation is a deterministic detector, not a resolver. It should report all
blockers in one pass and stop. Suggestions such as “change the published port” or “stop container
X” are strings/data for the operator; they must not execute Docker commands or rewrite Compose.

Avoid these overengineering traps:

- pip-style backtracking, candidate search, automatic port selection, or multi-step resolution;
- a pluggable rule registry, visitor framework, dependency-injection container, or abstract base
  conflict class;
- caching daemon state, persisting validation results, or adding a database migration;
- parsing raw Compose YAML a second time;
- scanning host sockets outside Docker in v1;
- treating every shared volume as incompatible;
- parallelizing a handful of bounded read calls before correctness and deterministic failure
  behavior are established;
- wiring the feature into plan/apply/rebuild/MCP before the deploy contract stabilizes.

The issue’s original “3-5 files” estimate predates the current CLI surface. Correct completion parity,
typed contracts, and unit/integration coverage legitimately touch more files, but production logic
should still remain concentrated in one evaluator, one Docker seam, and one deploy gate.

## Abstraction vs Repetition

Port and volume parsing already exists independently in `drift.ts` and `plan-generator.ts`; this
feature would be the third implementation. Apply the rule of three now, but extract only
resource-shaped functions (for example `normalizeComposePorts()` and
`normalizeComposeMounts()`), not a generic parsing toolkit.

Do not simply export either existing parser. Their current output is sufficient for display/diffing
but not conflict safety: host IP and wildcard binding semantics are discarded, ranges are ignored,
and short-syntax colon splitting is incomplete. Define a canonical superset once, unit-test it, and
adapt plan/drift to their existing `PortMapping`/`VolumeMapping` shapes if that migration is
behavior-preserving. If migration would materially expand this issue, keep the new robust
normalizer feature-local and record the duplication explicitly rather than forcing an unsafe
“shared” abstraction.

Network CIDR comparison has no repeated in-repo implementation. Keep it private to the conflict
module until a second real consumer appears.

## Interface Design

Recommended public feature contract:

```ts
export interface ConflictValidationInput {
  desired: ConflictDesiredState;
  runtime: ConflictRuntimeSnapshot;
  targetServices: readonly string[];
}

export type ServiceConflictKind = "port" | "volume" | "network";

export interface ServiceConflict {
  kind: ServiceConflictKind;
  resource: string;
  owners: readonly ConflictOwner[];
  message: string;
  suggestions: readonly string[];
}

export interface ConflictValidationResult {
  valid: boolean;
  summary: { total: number; port: number; volume: number; network: number };
  conflicts: readonly ServiceConflict[];
}

export function validateServiceConflicts(input: ConflictValidationInput): ConflictValidationResult;

export function formatServiceConflictText(result: ConflictValidationResult): readonly string[];
```

Use discriminated owner data (`desired-service` versus `runtime-container`) rather than embedding
formatted owner strings. Canonicalize and sort before returning: kind order (`port`, `volume`,
`network`), then resource key, then owner kind/name. Sort copies, never caller-owned arrays.

`ConflictValidationResult` should contain no clock-derived field. If deploy machine output needs the
evidence, add optional `validation?: ConflictValidationResult` to `DeployResult` and include it only
when `--validate-first` was requested. Conflicts set exit code `1`; malformed Compose or incomplete
daemon evidence is also operational error `1`; Commander misuse remains `2`.

Keep safe suggestions declarative and bounded. Do not include secrets, complete inspect objects, raw
environment data, or executable command callbacks.

## Extension Points

- The pure evaluator can later be called by plan, rebuild, apply, or MCP without moving Docker or
  prompt logic into it.
- New conflict kinds can extend the discriminated union and stable kind-rank map when a concrete
  requirement exists.
- Runtime collection can later add a host-listener provider, but Docker-only evidence should remain
  the explicit v1 authority.
- Interactive resolution can later consume structured suggestions, but any `stop` or Compose rewrite
  must be a separate, explicit mutation flow with confirmation and tests.

Do not expose individual detector internals as public APIs yet. The stable seam should be one input,
one result, and one formatter.

## Testability Patterns and Anti-Patterns

Recommended test seams:

- Table-driven pure unit tests for each normalizer and conflict kind: TCP versus UDP, wildcard
  versus specific host addresses, IPv4/IPv6 policy, duplicate desired claims, runtime ownership,
  named versus bind mounts, read-only/read-write policy, exact/subset CIDRs, adjacent CIDRs, and
  stable multi-conflict ordering.
- Action tests in `actions/deploy.spec.ts` proving the gate occurs after final service resolution and
  before dry-run/confirmation/pull, and that both sequential and parallel paths share it.
- Docker unit tests asserting exact argument arrays, capture bounds, malformed/partial JSON failure,
  env-tool propagation, and no `shell` spawn option.
- Real-CLI integration tests using the existing harness. On a blocker assert exit `1`, deterministic
  stderr/JSON, and absence of pull, `up`, readiness calls, state DB creation, and deployment rows.
- Completion tests that derive deploy long options from Commander and compare all three generated
  shells, rather than checking only token presence.

Anti-patterns to avoid:

- Mocking all of `lib/index.js` for pure detector tests;
- asserting only a human sentence while leaving the structured result untested;
- returning `[]` on inspect/parse failure;
- relying on object insertion order or daemon response order;
- fixtures that omit the Docker fields the production parser actually consumes;
- making live Docker integration tests the primary correctness suite.

The existing subprocess harness is especially valuable because `cli.ts` executes at module load and
is unsafe to import directly as a testable Commander factory. Reuse the harness rather than
refactoring the entire CLI for this feature.

## Build vs Depend

| Concern                    | Decision                                                                    | Rationale                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker API access          | Build on existing `execDocker`; no new dependency                           | The repository already standardizes retries, capture limits, env wrappers, and shell-safe argument arrays. `dockerode` would create a second daemon transport and mock surface. |
| Compose port normalization | Implement locally                                                           | Resolved Compose has a small documented shape; collision logic needs project-specific wildcard/protocol/range semantics. A general port-parsing package adds little value.      |
| CIDR validation/overlap    | Prefer `ipaddr.js` if IPv6 is in v1                                         | IPv6 parsing, normalization, mapped addresses, and containment are easy to get subtly wrong. Node’s `net.isIP()` validates an address but does not provide CIDR range algebra.  |
| IPv4-only CIDR overlap     | A small local parser is acceptable only with an explicit v1 IPv4 limitation | Convert network/prefix to a bounded integer interval and test `/0`, `/32`, adjacency, containment, malformed prefixes, and canonicalization. Do not silently ignore IPv6.       |
| Volume parsing             | Implement locally from resolved long syntax                                 | Conflict meaning is policy-specific; no dependency can decide whether shared read-only/read-write ownership is “incompatible.”                                                  |

Do not add an IP dependency until the IPv6 requirement is decided. The safe choices are full tested
IPv4+IPv6 support with a mature parser, or an explicit IPv4-only contract that reports unsupported
IPv6 evidence as validation failure/warning according to product policy.

## Open Questions

1. Does v1 require IPv6 CIDR overlap detection, or is IPv4-only behavior explicit and acceptable?
2. What exactly makes a shared volume incompatible? Shared named volumes and bind mounts are common;
   is the blocker differing read-only mode, differing targets, multiple writers, or an explicit
   allow/deny policy?
3. Should desired claims be limited to selected services plus expanded sidecars/dependencies, or all
   services activated by the selected profiles?
4. Which current-project containers are excluded because deploy will replace them, and how are
   scaled replicas handled? Container-name substring matching is not sufficient.
5. Are runtime conflicts checked against all Docker containers and networks, including stopped
   containers that still own mounts/networks, or running containers only?
6. For host IPs, should `0.0.0.0`/`::` conflict with every address of the same family while distinct
   specific host addresses may share a port?
7. Are published port ranges supported in v1, and must every port in a range be free?
8. Should auto-assigned published ports (`published` omitted or `0`) be skipped because Docker chooses
   them, or reported as unverifiable?
9. Is a conflict result included in machine output only on failure, or on every requested successful
   validation as an empty result?
10. Must JSON be byte-for-byte deterministic across runs? If yes, keep timestamps outside the
    validation block or omit them.
11. Does “interactive conflict resolution” mean display numbered suggestions only, or may it stop
    containers/edit Compose? The latter is a separate destructive feature and should not be inferred
    from `--validate-first`.
12. Is Docker-only port evidence the intended v1 boundary, explicitly excluding non-container host
    listeners?
