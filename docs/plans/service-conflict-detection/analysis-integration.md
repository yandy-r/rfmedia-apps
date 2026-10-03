# Integration Analysis: service-conflict-detection

## Executive Summary

`service-conflict-detection` integrates as an opt-in, read-only gate inside the existing
`rfapps deploy` command. The public entrypoint is
`rfapps deploy --validate-first`; there are no HTTP endpoints, REST routes, webhooks, or inbound
network listeners. The gate belongs after rfapps configuration validation and effective
service/profile resolution, but before dry-run returns, confirmation, image pulls, container
starts, readiness checks, database initialization, or deployment-history writes.

The integration has four layers:

1. `packages/rfapps-cli/src/cli.ts` registers the option and delegates to the existing deploy
   action.
2. `packages/rfapps-cli/src/actions/deploy.ts` resolves configuration and scope, invokes one
   shared preflight above the dry-run and parallel/sequential branches, maps its result to exit
   behavior, and continues the existing deploy only on `passed`.
3. `packages/rfapps-cli/src/lib/docker.ts` supplies bounded, typed, read-only adapters for
   canonical Compose and Docker Engine evidence under the same authority used by mutation.
4. A new `packages/rfapps-cli/src/lib/conflict-validation.ts` projects that evidence into pure,
   deterministic port, volume, and network comparisons.

Validation is ephemeral. It requires no database table, schema migration, cache, deployment row,
or generation snapshot. A `blocked` or `inconclusive` result exits `1` before any database
connection is opened. A passing result may be embedded in the existing structured deploy response,
after which successful or failed deployment work retains its current persistence behavior.

Docker authentication and authorization remain external to rfapps: Unix socket permissions,
rootless socket ownership, SSH, TLS certificates, Docker contexts, and any daemon authorization
plugin determine access. The validation reads and the later deploy must be bound to the same
canonical Compose inputs, pinned environment, and Docker authority fingerprint.

## API Endpoints

### HTTP and network APIs

There are no HTTP API endpoints for this feature. The rfapps package is a local TypeScript CLI and
does not expose Express, Fastify, REST, GraphQL, or webhook routes. The feature also does not call
the Docker Engine HTTP API directly; it uses the installed Docker CLI so existing context, SSH,
TLS, environment-tool, retry, timeout, and testing behavior remains centralized.

### CLI command surface

The only new v1 public input is:

```text
rfapps deploy --validate-first [existing deploy options]
```

Integration changes:

| Seam                                            | Current behavior                                                                                               | Required integration                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/rfapps-cli/src/cli.ts`                | Commander registers deploy options and dynamically imports `executeDeploy()`                                   | Register boolean `--validate-first`; retain current exit-code help                                     |
| `packages/rfapps-cli/src/actions/deploy.ts`     | `RawDeployOptions` is mapped to `DeployOptions`; config and services are resolved before dry-run and execution | Carry `validateFirst`; call preflight after effective scope resolution and before dry-run/confirmation |
| `packages/rfapps-cli/src/types/options.ts`      | `DeployOptions` describes current deploy flags                                                                 | Add `validateFirst: boolean`                                                                           |
| `packages/rfapps-cli/src/types/results.ts`      | `DeployResult` contains services, failures, health, and count                                                  | Add optional versioned `validation` evidence                                                           |
| `packages/rfapps-cli/src/types/validation.ts`   | Does not exist                                                                                                 | Define `conflict-validation.v1`, aggregate/check/finding/resolution contracts                          |
| `packages/rfapps-cli/src/actions/completion.ts` | Generates Bash, Zsh, and Fish completion templates                                                             | Add the deploy-only flag and restore exact deploy parity, including existing `--allow-partial`         |

The aggregate preflight statuses are `passed`, `blocked`, and `inconclusive`:

- `passed`: continue to the existing dry-run or deployment behavior.
- `blocked`: emit the complete validation result, set operational exit code `1`, and return.
- `inconclusive`: emit completed checks plus the sanitized failure, set exit `1`, and return.
- invalid option/profile or `--output csv --validate-first`: use the existing usage-error path and
  exit `2`.

`--yes` skips only the existing post-pass deploy confirmation. It does not bypass validation or
execute a resolution. `--allow-partial` remains a post-mutation deploy policy and cannot turn a
preflight result into exit `3`.

### Structured result contract

Machine modes continue to emit one deploy document through the existing formatter seam. The
optional nested validation result is versioned and sorted; it is not an HTTP response:

```typescript
interface DeployResult {
  services: string[];
  failed: FailedOperation[];
  healthy: string[];
  unhealthy: string[];
  started: number;
  validation?: ConflictValidationResult;
}
```

JSON and YAML retain nested validation evidence. Text/table use a human projection derived from
the same typed result. CSV is rejected in v1 because multi-owner findings and ranked resolutions
do not have a stable lossless flat representation. Machine modes must not prompt and must keep
stdout to exactly one document.

### MCP boundary

The repository has an `rfapps` MCP server over stdio, not HTTP:

- `packages/rfapps-cli/src/mcp/tools-mutate.ts` registers `rfapps.deploy`;
- `packages/rfapps-cli/src/mcp/adapters.ts` delegates the tool to `executeDeploy()`; and
- `packages/rfapps-cli/src/mcp/schema.ts` owns its input/output schema.

The feature specification intentionally does not add `validateFirst` to the MCP deploy schema in
v1. The pure validation engine may be reused by MCP, plan/apply, or rebuild after the CLI contract
has field experience. Until then, MCP behavior and schemas remain unchanged; the CLI-only flag
must not leak into MCP accidentally through untyped option forwarding.

## Database

### Existing persistence boundary

Rfapps stores deployment and generation history in SQLite through:

- `packages/rfapps-cli/src/lib/db.ts`, which initializes the XDG/legacy state database and runs
  migrations;
- `packages/rfapps-cli/src/lib/state-storage.ts`, which inserts deployment records and successful
  deploy-like generation snapshots; and
- the existing `initializeDatabase()`, `recordDeployments()`, and `closeDatabase()` call sites in
  `packages/rfapps-cli/src/actions/deploy.ts`.

Those deploy call sites occur after pull/start/readiness work in the parallel and sequential
branches, or in branch-level failure handling after deployment work has begun.

### Required feature behavior

No database changes are needed:

- no schema or migration;
- no validation-runs table;
- no cache of Docker inventory;
- no deployment record for `blocked` or `inconclusive`;
- no generation snapshot;
- no persistence of resolved Compose JSON, Docker inspect payloads, bind paths, daemon endpoint,
  or authority fingerprint.

The deploy action must construct the base `DeployResult`, attach validation evidence when the flag
is present, render it, set exit `1`, and return before the first `initializeDatabase()` call on a
blocking or inconclusive result. Action and subprocess tests should mock/spy on database
initialization and prove it remains uncalled.

When validation passes and real deployment proceeds, current database behavior remains unchanged.
The validation result is output evidence, not a new field in existing deployment rows. This avoids
storing point-in-time topology and potentially sensitive resolved input.

The CLI state lock in `packages/rfapps-cli/src/lib/state-lock.ts` is filesystem coordination, not a
database transaction. Non-dry-run deploy already acquires it in `packages/rfapps-cli/src/cli.ts`;
that serializes cooperating rfapps commands across validation and mutation. Global `--dry-run`
remains lock-free and read-only. Neither mode can lock out direct Docker clients, so the authority
and input fingerprints must still be rechecked before mutation.

## External Services

### Docker Compose CLI

Desired state comes from:

```text
docker compose [project/env/profile options] config --format json
```

`packages/rfapps-cli/src/lib/docker.ts` already exposes `execDockerCompose()` and
`getComposeConfig()`. The conflict feature should add or harden a dedicated canonical-model reader
rather than reuse the permissive fallback behavior unchanged. It must:

- receive the final Compose path, env file, profiles, project directory, and pinned execution
  environment;
- apply the same environment-tool behavior as deployment;
- capture bounded non-streaming output;
- strictly validate and narrowly project only service ports/mounts/network modes, top-level
  networks/IPAM, top-level volumes, effective names, and dependency fields;
- keep raw resolved output ephemeral and out of logs.

### Docker Engine through Docker CLI

Runtime evidence is collected with read-only Docker CLI operations:

1. list running container IDs, then inspect validated IDs in bounded batches for actual port
   bindings, mounts, and Compose ownership labels;
2. list network IDs, then inspect them for effective names, ownership labels, drivers, scope, and
   explicit IPAM subnets;
3. list/inspect relevant named volumes for name, driver, scope, and driver options.

No `pull`, `up`, `start`, `stop`, `rm`, `network create/rm/disconnect`, `volume rm`, or file edit is
allowed inside the preflight. Suggestions are inert data and prose. Docker remains the final
allocator because external state can change after the snapshot.

The new readers belong beside existing Docker execution seams in
`packages/rfapps-cli/src/lib/docker.ts` and should follow the hardened
`getComposeContainerObservations()` pattern: validated operands, hard byte/item/field limits,
typed failures, duplicate rejection, safe sorting, and no empty-success fallback.

### Authentication and authority

No new credentials or login flow are introduced. The Docker CLI inherits:

- local/rootless Unix socket permissions;
- the selected Docker context;
- `DOCKER_CONTEXT`/`DOCKER_HOST` precedence;
- SSH agent/account access;
- TLS client certificate/configuration; and
- daemon authorization-plugin policy.

`packages/rfapps-cli/src/lib/identity.ts` already provides
`resolveComposeProjectIdentity()`, `dockerAuthorityFingerprint()`, and
`dockerAuthorityFingerprintFromEnvironment()`. `packages/rfapps-cli/src/lib/env-tools.ts` provides
`captureEffectiveEnvironment()`. The integration should reuse them to:

1. canonicalize the Compose project identity;
2. capture the effective environment once under the deploy lock;
3. resolve desired state and inspect runtime under that pinned environment;
4. bind evidence to a one-way Compose fingerprint and Docker authority fingerprint; and
5. recheck both immediately before the first pull/start, aborting if either changed.

Raw Docker endpoints, daemon IDs, environment contents, secret-tool files, and credentials must
not appear in results.

### Secret environment tools

Existing dotenvx and 1Password wrappers remain the only secret-injection integration. The
preflight receives the same `EnvToolExecConfig` produced by `getEnvToolExecConfig()` and must not
invoke a different environment source than deploy. Because canonical Compose output can contain
interpolated secret values, only the required resource projection may leave the adapter.

### CIDR library

The feature spec selects `ipaddr.js` behind a narrow internal adapter for IPv4/IPv6 parsing and
interval normalization. Required package integration is limited to:

- `packages/rfapps-cli/package.json`;
- root `package-lock.json`; and
- the internal CIDR wrapper used only by the pure conflict engine.

No Docker SDK, HTTP client, YAML parser, host network scanner, or shell-execution dependency is
required.

## Integration Points

### 1. Commander entry and state lock

`packages/rfapps-cli/src/cli.ts` is the root entrypoint. Its pre-action hook initializes logging,
validates global secret-tool inputs, and acquires a state lock for non-dry-run deploy. Add the flag
to the existing deploy command; do not create a second command or bypass the hook.

### 2. Configuration precedence

`packages/rfapps-cli/src/lib/config.ts` loads configuration and applies CLI/environment
overrides. The preflight must use the resulting `finalConfig.composePath`, `envFile`, profile
configuration, groups, and sidecar settings exactly as deploy does. No new persistent rfapps
configuration key is required; `--validate-first` is per invocation.

Invalid explicit profiles must fail instead of being silently omitted from overrides, otherwise
validation and deployment can resolve different scopes.

### 3. Existing static config validation

`packages/rfapps-cli/src/lib/validation.ts` currently validates rfapps group, sidecar, and profile
references against Compose service names. Keep that check first. Resource conflicts must not be
added to its raw-YAML cache; canonical Compose JSON is the resource source of truth.

### 4. Effective scope resolution

`packages/rfapps-cli/src/lib/interactive-selection.ts` resolves explicit services, comma-separated
services, groups, interactive selection, sidecars, and profiles. After that step, the feature must
compute the transitive Compose closure for `depends_on` and `network_mode: service:`. An untargeted
deploy must expand the current `"all"` sentinel into concrete services enabled by the resolved
profiles.

The returned sorted concrete scope is used consistently for:

- desired-versus-desired comparison;
- runtime self-owner exclusion;
- structured scope output; and
- later deployment.

### 5. Canonical desired-state projection

The Docker adapter resolves the effective Compose project/model once with final profiles, env
inputs, project directory, and pinned authority. It projects normalized ports, volumes, networks,
and dependencies without exposing unrelated environment/config content.

### 6. Runtime snapshot

Container, network, and volume reads may run concurrently after desired-state and scope
resolution. Each reader returns a typed check result rather than `undefined` or an empty array on
failure. A required failed, partial, malformed, timed-out, or oversized read makes the aggregate
result `inconclusive`.

Self-reconciliation exclusion uses `com.docker.compose.project` plus
`com.docker.compose.service` labels, not container-name substring matching. Existing runtime
networks/volumes are excluded only when effective identity proves they are the intended same
resource.

### 7. Pure evaluator

`packages/rfapps-cli/src/lib/conflict-validation.ts` owns:

- validated desired/runtime projections;
- fixed published-port and range comparison;
- objective volume driver/options and duplicate-target checks;
- explicit IPv4/IPv6 subnet interval comparison;
- stable conflict/check/limitation IDs and code-point ordering;
- inert typed resolutions; and
- text/table projection from the same result.

It must not import database modules, execute Docker, read files, prompt, mutate results, or depend
on discovery order.

### 8. Single deploy gate

Insert the preflight in `executeDeploy()` after configuration and effective scope resolution but
before the current dry-run block. That one location governs:

- dry-run and real deploy;
- text and machine output;
- `--yes` and interactive confirmation;
- parallel and sequential execution;
- image pulls and starts;
- readiness checks; and
- database persistence.

Do not duplicate the gate inside the parallel and sequential branches. On `blocked` or
`inconclusive`, add a validation failure to `DeployResult.failed`, attach the full validation
result, render once for machine modes, set exit `1`, and return. On `passed`, retain the result for
later structured output and continue unchanged.

### 9. Output and error integration

Reuse:

- `packages/rfapps-cli/src/lib/formatters/index.ts` for machine envelopes;
- `packages/rfapps-cli/src/lib/exit-codes.ts` for operational/usage/partial categories; and
- the common logger/error pipeline for stderr diagnostics.

Add stable validation error codes rather than exposing raw Compose/Docker stderr. Human and
machine output must be derived from one model, sorted deterministically, control-character safe,
and free of absolute bind sources or resolved secrets.

### 10. Exports and compatibility

Export the new public validation types through `packages/rfapps-cli/src/types/index.ts` and the
feature entrypoint through `packages/rfapps-cli/src/lib/index.ts`. Make
`DeployResult.validation` optional so invocations without the flag preserve their current schema
and behavior.

Do not add the feature to MCP, plan, apply, or rebuild in v1. Their future integration should call
the same library seam rather than duplicate Docker inspection or conflict policy.

### 11. Integration verification

The integration test matrix belongs in:

- `packages/rfapps-cli/src/actions/deploy.spec.ts` for action ordering, results, exits, and zero
  persistence/mutation on failure;
- `packages/rfapps-cli/src/lib/docker.spec.ts` for exact read-only command construction, pinned
  auth/context options, batching, bounds, and malformed output;
- `packages/rfapps-cli/src/lib/conflict-validation.spec.ts` for pure rules and deterministic
  results;
- `packages/rfapps-cli/src/cli.deploy.integration.spec.ts` with
  `packages/rfapps-cli/src/testing/mock-docker.ts` and
  `packages/rfapps-cli/src/testing/deploy-scenarios.ts` for subprocess behavior and proof that no
  pull/up/database work follows a failed preflight; and
- `packages/rfapps-cli/src/actions/completion.spec.ts` for exact Bash/Zsh/Fish deploy-option
  parity.

Critical integration scenarios:

1. passed preflight continues through dry-run, sequential, and parallel paths;
2. blocked and inconclusive results exit `1` before confirmation or mutation;
3. `--dry-run`, `--yes`, and `--allow-partial` preserve the feature contract;
4. JSON/YAML emit one nested result, text/table share the same facts, and CSV returns usage exit
   `2`;
5. daemon/context/env/Compose drift aborts before mutation;
6. denied, partial, malformed, duplicated, oversized, or timed-out Docker evidence is
   inconclusive rather than an empty pass;
7. the target's own labeled container is excluded while another project is not; and
8. blocked/inconclusive tests assert no database initialization, state write, pull, start,
   readiness check, or resolution execution.
