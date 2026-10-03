# Integration Analysis: managed-update-lifecycle

## Executive Summary

`rfapps update` is a CLI-only orchestration feature. It should compose the existing Docker,
plan, health, state, and generation libraries through a new sequential coordinator rather than call
the existing action handlers or introduce another deployment engine. The invariant across every
integration is that the reviewed image identity, Docker context, Compose scope, and pre-update local
image identity remain unchanged until the target is verified or exactly restored.

The current seams need strengthening before reuse. `lib/plan-generator.ts` records registry updates
without making them apply candidates; `actions/apply.ts` therefore treats an update-only plan as a
no-op. `actions/rollback.ts` displays a historical image but recreates from the current Compose
definition. `lib/health.ts` evaluates dependencies and reports a leaf target ready without inspecting
the target. Managed plans also cannot reuse the current full `DeploymentPlan` serialization because
it includes resolved environment values.

## API Endpoints

There are no application HTTP endpoints in v1. The public contract is the `rfapps update` CLI command
registered from `packages/rfapps-cli/src/commands/update.ts` into `src/cli.ts`; registry HTTP is reached
indirectly through the Docker/Compose credential boundary.

CLI inputs are service/group targeting, `--apply`, `--from-plan`, `--out`, restore policy,
`--health-timeout`, Compose/env/profile overrides, and existing global `--yes`, `--dry-run`, output,
and secret-tool flags. Bare invocation is preview-only. Saved-plan apply rejects targeting overrides,
and non-interactive mutation requires `--apply --yes`. Machine output is one versioned `update.v1`
result on stdout; progress stays on stderr. No-op returns 0, usage/invalid-plan errors return 2, and
update, verification, or restore failures return 1, including a successfully restored failed update.

Internal contracts belong in `src/lib/managed-update.ts` and `src/types/update.ts`:

- `generateManagedUpdatePlan(input, dependencies): Promise<ManagedUpdatePlan>`
- `runManagedUpdate(plan, options, dependencies): Promise<ManagedUpdateResult>`
- `verifyServiceReadiness(input): Promise<ServiceVerificationSummary>`
- `recreateServiceWithImage(input): Promise<DockerExecResult>`
- `restoreServiceToImage(input): Promise<RestoreResult>`

`ManagedUpdatePlan` is discriminated by `schemaVersion: "update-plan.v1"` and
`intent: "managed-update"`; `ManagedUpdateResult` is discriminated by `schemaVersion: "update.v1"`.
Existing plans with no intent remain ordinary deployment plans. `actions/apply.ts` must reject managed
plans and direct users to `rfapps update --from-plan <path> --apply`; `--force` must never bypass
Compose, context, current-image, platform, or proposed-digest identity checks.

## Database

The SQLite database is resolved by `src/lib/db.ts` (normally
`~/.config/rfapps/state.db`, with the legacy `~/.rfapps/state.db` fallback). Current schema version 2
contains `metadata`, `deployments`, and append-only `generations` in `src/lib/schema.sql`. Version 3 in
`src/lib/migrations.ts` should add nullable identity columns without historical backfill:

| Table         | Columns to add                       | Purpose                                                      |
| ------------- | ------------------------------------ | ------------------------------------------------------------ |
| `deployments` | `image_id TEXT`, `image_digest TEXT` | Attempt evidence and observed immutable identity             |
| `generations` | `image_id TEXT`, `image_digest TEXT` | Exact same-daemon restore anchor and portable audit identity |

`DeploymentAction` and `GenerationAction` in `src/types/state.ts` gain `update`; the v3 migration adds
the four columns transactionally, updates `metadata.schema_version`, and extends
`SCHEMA_VERSION_CLI_MAP`. Every row mapper and column list in `lib/state-storage.ts`,
`lib/state-queries.ts`, and `lib/generations.ts` must carry both fields. Legacy rows remain readable
but are ineligible for automatic restore when `image_id` is absent.

Before the first pull, create a durable pre-update generation containing the configured tag, local
image ID, matching repository digest, and sanitized config snapshot. Successful update and verified
restore records create new generations through the existing deployment-plus-generation transaction;
failed attempts create deployment history only. Use the managed plan ID to link update and restore
rows. No `update_runs` table is needed. Volumes, application databases, and application migrations are
never rolled back or represented as restored.

## External Services

### Docker Compose CLI

Use `execDockerCompose()` in `src/lib/docker.ts` for every phase so Docker contexts, SSH/TLS,
credential helpers, profiles, proxies, and env-tool wrapping remain consistent. Required operations
are:

- `compose config --format json` for canonical services, image/build intent, platform, profiles, and
  dependencies.
- Capability-probed `compose config --resolve-image-digests` (or an equally typed Docker fallback) to
  freeze the selected registry digest.
- `compose pull SERVICE` for fetch-only behavior.
- `compose -f <base> -f <private-override> up -d --force-recreate --pull never SERVICE` for exact
  apply and restore.
- `compose ps --all --format json SERVICE` for target state and health evidence.

The override contains only an allowlisted Compose service name and immutable image reference. It is
created privately and removed in `finally`. Do not reuse `startServices()` unchanged because it
always adds `--remove-orphans`; transactional update/restore must remain targeted and must never
perform orphan cleanup. Probe optional Compose digest-resolution and wait flags once and return a
specific unsupported result when absent.

### Docker Engine inspection

Extend `ContainerInspect` and typed helpers in `src/lib/docker.ts` to capture container ID,
`ContainerInspect.Image` (local image ID), configured image, running/restarting state, exit code,
Docker health, platform, and a repository-matched `RepoDigests` entry. Compare local image IDs only to
local image IDs and manifest/index digests only within the same repository/platform namespace. The
current first-entry `RepoDigests` selection and fallback to a manifest config digest are unsafe.

### OCI registries

Keep resolution behind Docker/Compose instead of adding a registry SDK. This preserves Docker's
challenge flow and private credential-helper behavior. Classify authentication, authorization,
not-found, rate-limit, timeout, unsupported media type, platform mismatch, and parsing failures as
stable `unknown`/unsupported outcomes, never `up_to_date`. Cache and deduplicate detection by canonical
image plus platform. Re-resolve immediately before mutation and reject a moved tag rather than silently
deploying a new digest.

### Configuration and secret providers

Continue loading layered configuration through `src/lib/config.ts` and applying CLI overrides for
`composePath`, `envFile`, profile, and sidecar policy. Every Docker call must receive the same
`EnvToolExecConfig` from `--use-dotenvx` or `--use-op` through `lib/env-tools.ts`. Plans, reports, lock
files, and overrides must never contain resolved environment values, credential-helper output, Docker
connection secrets, or unbounded subprocess stderr.

## Integration Points

- **Command/action boundary:** Add `src/commands/update.ts`, `src/actions/update.ts`,
  `src/lib/managed-update.ts`, and `src/types/update.ts`; register/export them through `src/cli.ts`,
  `src/lib/index.ts`, and `src/types/index.ts`. The action owns config/scope resolution, confirmation,
  rendering, database lifetime, and exit codes; the coordinator returns data and does not print or set
  `process.exitCode`.
- **Scope and locking:** Reuse `lib/services.ts` for service/group/profile and sidecar expansion, but
  account for every expanded service independently. Bind an exclusive lock to project plus Docker
  context for the entire revalidation/mutation/verification/restore interval. V1 mutation is
  sequential; continue after a verified restore and stop after restore failure.
- **Plans:** Extend `types/plan.ts` and `lib/plan-generator.ts` with discriminated update status,
  canonical digest/platform fields, and managed intent while retaining optional `updateAvailable` for
  saved-plan/MCP compatibility. In `lib/plan-storage.ts`, use a strict runtime schema and an allowlisted
  managed DTO, size limits, symlink rejection, atomic writes, `0700` directories, and `0600` files.
  Ordinary deployment plan behavior remains unchanged.
- **Generations and rollback:** Extend `lib/state-storage.ts`, `lib/state-queries.ts`, and
  `lib/generations.ts` with immutable identity. Extract the pinned multi-file Compose override into a
  shared library helper and let `actions/rollback.ts` use it when a generation has `imageId`; preserve
  explicit best-effort behavior for legacy tag-only manual rollbacks. Automatic restore never falls
  back to a mutable tag.
- **Health:** Add target-aware contracts in `types/health.ts` and polling in `lib/health.ts`. A target
  must run the expected local image ID, be running with exit code 0, and be Docker-healthy when a
  healthcheck exists; otherwise require a bounded stable-running window labeled `running-only`.
  Existing direct-dependency readiness remains additional evidence, not the target success gate.
- **CLI compatibility:** Update `actions/completion.ts` for Bash/Zsh/Fish and document preview,
  approval, image-only recovery, and machine results in `packages/rfapps-cli/README.md`. Keep ordinary
  `plan`, `apply`, `history`, `generations`, and manual `rollback` behavior backward compatible.
- **MCP compatibility:** Do not expose managed update mutation as a new MCP tool in v1; Docker daemon
  authority needs a separate remote authorization policy. Existing `rfapps.plan` remains an ordinary
  plan and `rfapps.apply` rejects managed intent. Update `src/mcp/schema.ts` only where shared types can
  surface through existing tools: accept optional plan intent/update-status fields, add `update` plus
  `imageId`/`imageDigest` to history schemas, and keep legacy fields optional. No changes are required
  to `tools-read.ts`, `tools-mutate.ts`, or `adapters.ts` unless a later release deliberately adds an
  authorized `rfapps.update` tool.
