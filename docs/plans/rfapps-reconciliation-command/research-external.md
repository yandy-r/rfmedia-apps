# External API Research: `rfapps reconcile`

## Executive Summary

Issue #151 can be implemented without a new network API or runtime dependency. The strongest fit is to keep Docker Compose as the desired-state resolver and mutator, use the Docker CLI/Engine inspection data as the actual-state source, and build a small deterministic reconciliation model inside `rfapps`.

The existing code already provides most of the required primitives:

- `getComposeConfig()` resolves the effective Compose model with `docker compose config --format json`.
- `generatePlan()` and `detectDrift()` compare resolved service configuration with container inspection data.
- `startServices()` applies Compose state with `docker compose up`.
- managed update code already demonstrates authority fingerprints, resolved-config fingerprints, lifecycle locks, pre-mutation revalidation, versioned machine-readable results, and health verification.

The new command should not merely wrap the existing `drift reconcile` subcommand. That subcommand mutates immediately, uses `--force-recreate`, emits no complete post-apply result, and calls a helper that always includes `--remove-orphans`. A top-level reconciliation workflow should instead have three explicit phases: observe and calculate a stable report, authorize actions (`--auto-apply` plus any maintenance-window gate), then apply and re-observe. Default execution must stop after the first phase.

The external controller patterns support this separation. Kubernetes describes controllers as loops that observe current state, act toward desired state, and report the resulting state. Argo CD separates automatic sync, self-heal, and pruning, with deletion disabled by default as a safety measure. Flux separates reconciliation interval, failure retry interval, suspension, pruning, health checks, and status history. For this one-shot CLI, those translate to report-first behavior, an explicit mutation gate, explicit deletion policy, stable per-service outcomes, revalidation immediately before mutation, and a future maintenance-window decision that blocks actions without blocking observation.

## Primary APIs

| API or command surface            | Relevant official documentation                                                                                                                                                                                                                                                                                                                                                                                                                                     | Authentication and authority                                                                                                                                                                                                                                                                                 | Endpoints or commands used                                                                                                                                                                                                                                                                                                                           | Rate limits                                                                                    | Pricing                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Docker Compose canonical model    | [docker compose config](https://docs.docker.com/reference/cli/docker/compose/config/), [Compose CLI global options](https://docs.docker.com/reference/cli/docker/compose/)                                                                                                                                                                                                                                                                                          | Uses the active Docker CLI environment and the same environment provider as `rfapps`; interpolation inputs may come from the shell, `.env`, `--env-file`, or the secrets wrapper. Project identity follows Compose precedence, including `-p`, `COMPOSE_PROJECT_NAME`, top-level `name`, and directory name. | `docker compose -f <file> [--env-file <file>] [--profile <profile>...] [--project-name <name>] config --format json`; optional `config --hash` can provide Compose's service hash but does not replace the repository's secret-free resolved-model fingerprint.                                                                                      | N/A; local CLI operation. Bound subprocess time and output size in `rfapps`.                   | N/A; Docker Engine/Compose installation is operator supplied. |
| Docker Compose project status     | [docker compose ps](https://docs.docker.com/reference/cli/docker/compose/ps/)                                                                                                                                                                                                                                                                                                                                                                                       | Same Docker context, host override, project name, profiles, Compose file, and injected environment used for desired-state resolution and mutation.                                                                                                                                                           | `docker compose ... ps --all --format json`. Official output is JSON Lines, one object per container, with fields including `ID`, `Name`, `Project`, `Service`, `State`, `Health`, `ExitCode`, and `Publishers`.                                                                                                                                     | N/A; local daemon operation.                                                                   | N/A.                                                          |
| Docker container inspection       | [docker inspect](https://docs.docker.com/reference/cli/docker/inspect/), [docker container inspect](https://docs.docker.com/reference/cli/docker/container/inspect/), [Docker Engine API](https://docs.docker.com/reference/api/engine/version/v1.52/)                                                                                                                                                                                                              | Local Unix socket by default; remote engines may be selected through a Docker context, `DOCKER_HOST`, SSH, or mutual TLS. Docker warns that daemon credentials effectively grant root-level control of the host, so reconciliation output must never expose endpoints, credentials, or resolved secrets.     | CLI: `docker inspect <container-id>...`. Engine equivalents: `GET /containers/json?all=true&filters=...` and `GET /containers/{id}/json`. The list endpoint accepts JSON-encoded label, status, health, and name filters.                                                                                                                            | N/A for the daemon API; constrain batching, timeout, and concurrency to avoid daemon pressure. | N/A.                                                          |
| Docker Compose mutation           | [docker compose up](https://docs.docker.com/reference/cli/docker/compose/up/), [docker compose create](https://docs.docker.com/reference/cli/docker/compose/create/)                                                                                                                                                                                                                                                                                                | Same authority and project identity as observation. Authorization is operating-system/socket, SSH, or TLS access to the selected daemon.                                                                                                                                                                     | `docker compose ... up -d [--pull never] [--wait] [--wait-timeout N] <service...>`. Compose already recreates a service when its configuration or image changed. `--force-recreate` recreates even when Compose sees no change; `--remove-orphans` deletes project containers absent from the model and must be a separate, visible policy decision. | N/A; local daemon operation.                                                                   | N/A.                                                          |
| Compose ownership labels          | [Compose services: canonical labels](https://docs.docker.com/reference/compose-file/services/), [Docker object labels](https://docs.docker.com/engine/manage-resources/labels/)                                                                                                                                                                                                                                                                                     | Labels are returned by the selected daemon. The `com.docker.compose.*` namespace is reserved by Compose.                                                                                                                                                                                                     | Compose sets `com.docker.compose.project` on its resources and `com.docker.compose.service` on service containers. The Engine container-list endpoint can filter by these labels.                                                                                                                                                                    | N/A.                                                                                           | N/A.                                                          |
| Docker contexts and remote access | [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/), [Protect the Docker daemon socket](https://docs.docker.com/engine/security/protect-access/)                                                                                                                                                                                                                                                                                           | `DOCKER_CONTEXT` overrides the context selected by `docker context use`; `--context` overrides both. `DOCKER_HOST` can select another endpoint. Remote access should use SSH or TLS verification.                                                                                                            | Existing `rfapps` managed-update code uses `docker context show`, `docker context inspect ... .Endpoints.docker.Host`, `docker info ... .ID`, and the effective `DOCKER_HOST` to derive a non-secret authority fingerprint.                                                                                                                          | N/A.                                                                                           | N/A.                                                          |
| Controller behavior references    | [Kubernetes controller pattern](https://kubernetes.io/docs/concepts/architecture/controller/), [Argo CD automated sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/), [Argo CD sync windows](https://argo-cd.readthedocs.io/en/stable/user-guide/sync_windows/), [Flux Kustomization reconciliation](https://fluxcd.io/flux/components/kustomize/kustomizations/), [Flux Kustomization API](https://fluxcd.io/flux/components/kustomize/api/v1/) | N/A; these are design references, not runtime dependencies.                                                                                                                                                                                                                                                  | N/A.                                                                                                                                                                                                                                                                                                                                                 | N/A.                                                                                           | N/A; open-source documentation.                               |

The Docker Engine API is versioned. Docker recommends API version negotiation or explicitly choosing a supported version. Continuing to use the installed Docker CLI preserves its negotiation and Docker-context behavior and avoids implementing socket, SSH, TLS, and API-version handling inside `rfapps`.

## Libraries and SDKs

### Recommended: no new dependency

Keep the existing `execDockerCompose()` and `execDocker()` boundary. It already preserves secrets-tool execution, timeouts, captured versus streamed output, Docker contexts, and CLI error normalization. It also avoids duplicating Compose's interpolation, merge, profile, path-resolution, and project-name rules.

### Compose parser

Docker Compose itself uses [`compose-go`](https://github.com/compose-spec/compose-go), the reference Go library for loading Compose files. It is not directly usable from this TypeScript package. Reimplementing its behavior with the existing `yaml` dependency would be error-prone because `docker compose config` resolves merges, interpolation, short syntax, environment files, profiles, and paths into the actual model sent to the Engine. Continue consuming `config --format json` instead.

### Docker Engine SDK

Docker's [Engine SDK documentation](https://docs.docker.com/reference/api/engine/sdk/) provides maintained SDKs for Go and Python. It lists Node libraries, including `dockerode`, under community-supported libraries that Docker does not test. Introducing a Node Engine client would add a second authority/configuration path and still would not provide Compose model resolution. It is not justified for issue #151.

### Existing project libraries

- Use Commander for the `reconcile` command and `--auto-apply` option.
- Use the existing `formatOutput()` path for JSON, YAML, CSV, table, and text, but define JSON/YAML as the normative nested schema. CSV cannot faithfully represent nested diffs/actions without a separate flattened contract.
- Reuse the recursive canonical JSON/fingerprint approach in `plan-generator.ts`, the strict versioned result pattern in `types/update.ts`, and the lifecycle lock in `lifecycle-lock.ts`.
- Reuse health/readiness verification from the managed-update workflow where possible; Compose `up --wait` is also an official option, but minimum Compose-version policy must be explicit if it becomes required.

## Integration Patterns

### Observe, decide, act, verify

Implement one deterministic calculation used by both modes:

1. Resolve the effective Compose project identity and canonical desired model.
2. Snapshot every in-scope project container, including stopped containers.
3. Normalize desired and actual values into an internal, secret-free comparison model.
4. Produce ordered diffs and proposed actions.
5. Return immediately unless `--auto-apply` is set.
6. Acquire the lifecycle lock, re-resolve authority/project/config/scope, and reject stale assumptions.
7. Evaluate the maintenance-window gate immediately before the first mutation.
8. Apply dependency-safe actions.
9. Re-observe and emit terminal per-service results, including residual drift or verification failure.

This is the one-shot CLI equivalent of the [Kubernetes controller pattern](https://kubernetes.io/docs/concepts/architecture/controller/): observe current state, act toward desired state, and report the resulting state. It must converge: rerunning after a successful apply should yield no actions.

### Stable action model

Use explicit, bounded action kinds rather than deriving behavior in the renderer. A practical first schema is:

```typescript
type ReconcileActionKind = "create" | "start" | "recreate" | "remove_orphan" | "none";

interface ReconcileAction {
  service: string;
  kind: ReconcileActionKind;
  reasons: ReconcileCategory[];
  destructive: boolean;
  eligible: boolean;
  blockedBy?: "maintenance_window" | "unsupported_state" | "stale_observation";
}
```

The proposed action must be calculated before authorization, so default report-only output and `--auto-apply` output describe the same intent. The apply result should retain both the proposed action and terminal outcome (`not_requested`, `blocked`, `applied`, `failed`, or `converged`).

### Deterministic machine output

Define a versioned schema such as `reconcile.v1`. For identical desired and actual snapshots, its semantic diff/action payload must be identical:

- Sort services lexicographically by Compose service name.
- Sort instances by service, Compose container number/name, then container ID.
- Use a fixed category order and action precedence rather than discovery order.
- Canonicalize object keys recursively before hashing or serializing comparison values.
- Sort set-like ports, mounts, networks, labels, and environment-variable names.
- Omit `undefined` fields and never emit resolved secret values.
- Use a content-derived `observationFingerprint` for correlation. Do not use a random UUID as the identity of the diff.
- Keep volatile run metadata such as timestamps and duration outside the deterministic `diff` and `actions` fields, or omit it from report-only output if byte-for-byte reproducibility is required.

Example normative JSON shape:

```json
{
  "schemaVersion": "reconcile.v1",
  "mode": "report",
  "status": "drifted",
  "observationFingerprint": "sha256:...",
  "scope": {
    "project": "rfmedia-apps",
    "profiles": ["all"],
    "services": ["plex", "sonarr"]
  },
  "maintenanceWindow": {
    "evaluated": false,
    "decision": "not_applicable"
  },
  "services": [
    {
      "service": "plex",
      "state": "drifted",
      "categories": ["environment"],
      "action": {
        "kind": "recreate",
        "destructive": false,
        "eligible": true
      },
      "outcome": "not_requested"
    }
  ],
  "summary": {
    "selected": 2,
    "drifted": 1,
    "actionable": 1,
    "blocked": 0,
    "unchanged": 1
  }
}
```

### Report-first and deletion safety

Argo CD's [automated sync policy](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/) separates automatic sync, self-heal, and pruning, and leaves automated deletion disabled by default. Follow that precedent:

- `rfapps reconcile` observes and reports only.
- `rfapps reconcile --auto-apply` authorizes non-deletion remediation.
- Orphan removal should require a separate explicit policy/flag or config setting, even when `--auto-apply` is present.
- An empty desired scope must fail closed rather than delete all project resources.

This requires avoiding the current unconditional `--remove-orphans` in `startServices()` or making it an explicit option for this call path.

### Maintenance-window compatibility

Issue #169 should be an authorization layer, not part of diff calculation. Argo CD [sync windows](https://argo-cd.readthedocs.io/en/stable/user-guide/sync_windows/) provide useful semantics: allow and deny windows, deny precedence, no matching window means allowed, and a visible decision/reason. For `rfapps`:

- Always allow report generation outside a window.
- Evaluate the window only when `--auto-apply` requests mutation.
- Evaluate once immediately before mutation using an injected clock and explicit timezone.
- Include the decision, matching window identifier, evaluated time, timezone, and next eligible time in structured output.
- Treat a denied window as a normal blocked outcome, not as “no drift.”
- Allow future configuration to distinguish automated operations from explicitly confirmed manual operations without changing the reconciliation schema.

Flux's [suspend behavior](https://fluxcd.io/flux/components/kustomize/kustomizations/#suspend) similarly pauses drift correction while preserving the desired-state object; this supports separating `eligible` from `requested` and `applied` in each action.

### Retry and status accounting

Flux separates the normal reconciliation interval from the failure retry interval and records observed generation, last applied revision, last attempted revision, conditions, inventory, and history. A one-shot `rfapps` command does not need a scheduler, but it should retain the useful boundaries:

- Complete per-service accounting, including unchanged, unsupported, blocked, failed, and applied services.
- A stable reason code and sanitized message for every blocked/failed service.
- Revalidation evidence when the desired model, project, context, environment source, or container identity changes between report and apply.
- Post-apply observation rather than assuming a successful `docker compose up` means convergence.
- No unbounded automatic retry loop in the CLI; return a terminal result and let a future scheduler choose retry/backoff policy.

## Constraints and Gotchas

### `docker compose ps --format json` is JSON Lines

The official command emits one JSON object per line, not one JSON array. Parse each non-empty line independently, validate bounded fields, and sort the resulting rows. Do not call `JSON.parse()` once on the entire output.

### Actual state must include stopped containers

`docker compose ps` shows only running containers by default. The existing `getRunningServiceContainerMap()` also filters to `--status running` and collapses entries into `Map<service, container>`. Reconciliation needs `--all` to distinguish:

- no container: `create`;
- stopped/exited container with acceptable configuration: `start`;
- running or stopped container with configuration drift: `recreate`;
- restarting, paused, dead, or removing states: explicit report/eligibility rules.

### Scaled services cannot be represented by a single map entry

Compose can have multiple containers for one service. The existing map overwrites earlier instances. Either define issue #151 as single-instance only and emit `unsupported_state` for multiplicity, or model `Map<service, ContainerSnapshot[]>` and compare desired scale to actual instances. Silent collapsing is unsafe.

### Project identity must be pinned

Compose project name changes which containers are observed and mutated. Resolve it once using Compose's own precedence, include it in the authority fingerprint/scope, pass it explicitly with `--project-name` to every project-scoped command, and revalidate before apply. Run all probes through the same dotenvx/1Password environment path so `DOCKER_HOST`, `DOCKER_CONTEXT`, interpolation values, and Compose project variables cannot diverge between phases.

### Resolved configuration contains secrets

`docker compose config --format json` resolves environment values, including injected secrets. Use it only in memory. Emit environment names and masked change metadata, never current/desired secret values. Hashing must be one-way and artifacts should follow the managed-update storage limits and restrictive permissions if persisted.

### Desired and actual models are not structurally identical

Docker adds defaults and runtime values, Compose normalizes short syntax, network names may be project-prefixed, and container environments include image/default variables. Compare semantic fields with field-specific normalization. The existing plan/drift code deliberately compares only environment keys declared in desired state and treats ports/mounts/networks as order-insensitive; preserve and test those rules instead of raw-object diffing.

### Compose hash and repository fingerprint have different roles

`docker compose config --hash` exposes a Compose service hash, but the repository already has a recursively canonicalized SHA-256 fingerprint of the resolved service model. Compose's hash is useful as supporting evidence; the `rfapps` fingerprint is preferable for a stable internal contract because its exact canonicalization and redaction boundary are controlled and testable in this codebase.

### Natural reconciliation versus force recreation

Official `docker compose up` behavior recreates services when configuration or image changed. `--force-recreate` recreates even if Compose does not detect change. Use explicit action reasoning:

- `create`/`start`: ordinary targeted `up -d`;
- configuration/image drift: targeted `up -d`, optionally force only when the normalized `rfapps` diff is not represented in Compose's own convergence decision;
- runtime unhealthy/restarting: do not assume recreation is always safe; report a separate runtime reason and define policy.

This avoids turning every detected runtime discrepancy into unnecessary container replacement.

### Orphan deletion is broader than a targeted service apply

The current `startServices()` always adds `--remove-orphans`. Compose defines this as removing containers for services not present in the Compose file. It can therefore mutate objects not listed in the targeted reconciliation actions. `--auto-apply` must not use that behavior implicitly. Orphans must be discovered, sorted, reported, and explicitly authorized as destructive actions.

### Concurrent lifecycle operations create time-of-check/time-of-use risk

A plan can become stale after observation. Reuse the managed-update lifecycle lock and revalidate compose hash, resolved service fingerprint, effective project, Docker authority, environment source, service scope, and current container identities after locking. If anything changed, emit `stale_observation` and require a new run rather than applying an obsolete action list.

### Health is not equivalent to process state

Compose `up --wait` waits for services to be running or healthy, but a service without a Docker healthcheck can only prove “running.” Preserve the managed-update distinction between `healthcheck` and `running-only` assurance. Include timeout and dependency-readiness evidence in results.

### Engine access is privileged

Docker documents that possession of client credentials can grant root-level control of the daemon host. Never log Docker TLS keys, registry credentials, `DOCKER_AUTH_CONFIG`, resolved environment values, or raw daemon errors that may contain them. Keep the report schema bounded and sanitized.

### Exit behavior must be deliberate

Default report-only is not the same as operational success with no drift. Define and test exit semantics for `converged`, `drifted/report-only`, `blocked`, `partial`, invalid input, and Docker failure. Machine consumers should be able to use the schema status without parsing logs; human logs belong on stderr and the structured document on stdout.

## Code Examples

### Canonical observation commands

Every command must use the same resolved Compose path, project name, profiles, environment source, and Docker authority:

```bash
# Desired state: one canonical JSON document.
docker compose \
  -f /srv/rfmedia-apps/compose.yml \
  --project-name rfmedia-apps \
  --profile all \
  config --format json

# Actual project state: JSON Lines and all lifecycle states.
docker compose \
  -f /srv/rfmedia-apps/compose.yml \
  --project-name rfmedia-apps \
  --profile all \
  ps --all --format json

# Low-level actual configuration for the exact observed IDs.
docker inspect <container-id-1> <container-id-2>
```

### Safe report/apply skeleton

```typescript
export async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const identity = await resolveComposeProjectIdentity(input.composePath, {
    envTool: input.envTool,
  });

  const observation = await observeReconcileState({
    ...input,
    composePath: identity.composePath,
    projectName: identity.projectName,
  });
  const report = buildDeterministicReport(observation);

  if (!input.autoApply || report.summary.actionable === 0) {
    return finalize(report, { applied: false });
  }

  const lock = await acquireLifecycleLock({
    projectPath: identity.projectDir,
    composeProjectName: identity.projectName,
    dockerContext: observation.dockerAuthorityFingerprint,
  });

  try {
    const fresh = await observeReconcileState({
      ...input,
      composePath: identity.composePath,
      projectName: identity.projectName,
    });
    assertSameObservation(report, fresh);

    const window = evaluateMaintenanceWindow(input.clock.now(), input.schedule);
    if (!window.allowed) {
      return finalizeBlocked(report, window);
    }

    const outcomes = await applyActionsInDependencyOrder(report.actions, input);
    const verified = await observeReconcileState({
      ...input,
      composePath: identity.composePath,
      projectName: identity.projectName,
    });
    return finalizeApplied(report, outcomes, verified);
  } finally {
    await lock.release();
  }
}
```

### Parse Compose JSON Lines deterministically

```typescript
interface ComposePsRow {
  ID: string;
  Name: string;
  Project: string;
  Service: string;
  State: string;
  Health: string;
  ExitCode: number;
}

function parseComposePsJsonLines(stdout: string): ComposePsRow[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ComposePsRow)
    .sort(
      (left, right) =>
        left.Service.localeCompare(right.Service) ||
        left.Name.localeCompare(right.Name) ||
        left.ID.localeCompare(right.ID),
    );
}
```

### Maintenance-window result compatibility

```json
{
  "maintenanceWindow": {
    "evaluated": true,
    "decision": "denied",
    "reasonCode": "MAINTENANCE_WINDOW_CLOSED",
    "windowId": "weekly-sunday",
    "timezone": "Etc/UTC",
    "evaluatedAt": "2026-07-18T00:00:00.000Z",
    "nextEligibleAt": "2026-07-19T02:00:00.000Z"
  },
  "status": "blocked",
  "applied": false
}
```

## Open Questions

1. Should `rfapps drift reconcile` become an alias for `rfapps reconcile --auto-apply`, be deprecated, or retain its current force-recreate semantics? Two overlapping reconciliation contracts will confuse operators and completion/documentation maintenance.
2. Does `--auto-apply` authorize orphan deletion, or should deletion require a separate `--prune`/config policy? Argo CD precedent strongly favors a separate opt-in.
3. What exact issue #169 configuration schema is expected: allow windows, deny windows, timezone, cron plus duration, service/group selectors, manual override, and next-eligible calculation? The result schema should reserve these fields now without implementing the scheduler.
4. What exit code should report-only drift use? A nonzero drift code is useful for automation but may conflict with “default report-only” expectations. A dedicated documented code is clearer than overloading operational failure.
5. Are scaled services in first-release scope? If yes, desired replica count and per-instance outcomes must be modeled; the existing one-container-per-service map is insufficient.
6. Are unhealthy/restarting containers automatically recreatable, or should runtime-only discrepancies remain blocked/report-only unless a separate repair policy is enabled?
7. Should image registry freshness be excluded unless explicitly requested? Desired-vs-actual reconciliation should normally compare the configured image reference/identity and must not silently turn mutable tags into update checks or pulls.
8. Must reconciliation reports be persistable and later applicable, or is `--auto-apply` strictly same-process? Persisted apply requires the managed-update level of strict schema validation, private file permissions, bounded artifacts, and full stale-plan revalidation.
9. Is post-apply assurance `docker compose up --wait`, the repository's existing dependency/readiness verifier, or both? This determines the minimum supported Compose version and result evidence.
10. Should maintenance-window denial override global `--yes`, and will there be an emergency override flag? The safest contract is that `--yes` skips confirmation only and never bypasses policy.
