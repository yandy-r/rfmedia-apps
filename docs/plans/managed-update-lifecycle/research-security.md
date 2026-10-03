# Managed Update Lifecycle: Security Research

## Executive Summary

Issue #148 gives `rfapps` authority to query registries, pull images, recreate privileged workloads,
assess health, and automatically restore them. That makes the update runner a host-control and
software-supply-chain boundary, not merely a convenience wrapper around `docker compose`.

The feature can be implemented safely by reusing the existing argument-array Docker executor,
generation database, plan hash, and explicit confirmation model, but it must not directly reuse all
current semantics. Two release-blocking issues require design changes:

1. A mutable image tag is not an exact restore point. The pre-update running container's immutable
   image ID and repository digest must be captured before pulling, retained locally, and used through
   a narrowly scoped Compose override with `--pull never` during restoration.
2. Existing plans contain resolved environment values. `savePlan()` serializes the whole plan to a
   default `.rfapps/plans/*.json` file without an explicit restrictive mode, while secret detection
   currently affects presentation rather than serialization. A managed-update plan must never persist
   resolved secret values.

The apply boundary should be fail-closed: re-hash the Compose file, re-inspect the running container,
re-query the registry, and require all identities to match the preview immediately before mutation.
Unknown registry state is not "up to date." Apply one service at a time, verify the target service
itself as well as dependencies, and stop immediately if restoration fails. Docker explicitly warns
that daemon control should be limited to trusted users because it can grant host-level power
([Docker Engine security](https://docs.docker.com/engine/security/)); this command should therefore
not become a remotely callable or multi-user automation surface without a separate authorization
layer.

## Findings by Severity

### CRITICAL

| ID     | Finding                                       | Evidence and impact                                                                                                                                                                                                                                                                                                                                                                                                                     | Required mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-01 | Mutable-tag restoration is not restoration    | Generations store `image_tag`; rollback invokes Compose against the current file and pulls/recreates that service. Once `latest` or another tag moves, it can resolve to the failed or compromised image. Automatic recovery could therefore repeat the incident while reporting a rollback attempt.                                                                                                                                    | Before any pull, inspect the running container and persist both `ContainerInspect.Image` (immutable local image ID) and an applicable repo digest. Restore with a temporary override that pins the exact image ID, invoke Compose with `--pull never --force-recreate`, verify the restored container resolves to that ID, and retain the old image until the lifecycle is terminal. Never fall back from a missing immutable identity to a tag during automatic restore. |
| SEC-02 | Persisted plans can disclose resolved secrets | `generatePlan()` compares resolved current and desired environment values and stores them in `EnvChange`; `savePlan()` serializes the full object. Key-name heuristics mark secrets for display but do not remove values from the serialized plan, and the plan file is written without an explicit `0600` mode. This can expose service credentials through filesystem reads, backups, support bundles, or accidental version control. | Define a persistence DTO that excludes environment values entirely or stores only keyed hashes/change markers. Never rely on key-name heuristics as the confidentiality boundary. Create `.rfapps` and plan directories as `0700`, create files atomically as `0600`, reject symlinks, and document `.rfapps/` as ignored local state. Add tests that scan serialized plans/reports/errors for fixture secrets.                                                           |

### WARNING

| ID     | Finding                                                                                         | Evidence and impact                                                                                                                                                                                                                                                                                                                                                  | Required mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-03 | Detect-to-apply time-of-check/time-of-use race                                                  | `plan --check-updates` records local and remote digests, but a registry tag or running container can change before apply. Pulling a later digest than the one previewed defeats operator approval and may ingest an unreviewed image.                                                                                                                                | Immediately before each service apply, require the Compose hash, selected service image reference, running image ID/local digest, and freshly fetched remote digest to equal the plan. Treat any mismatch as a stale plan requiring regeneration; `--force` must not bypass identity checks.                                                                                                                                                                              |
| SEC-04 | Registry failures are currently indistinguishable from no update in summary behavior            | `checkImageUpdate()` returns `hasUpdate: false` when the local image is missing, remote lookup fails, or parsing fails. Managed updates could silently skip private-registry authentication failures or unsupported manifest shapes.                                                                                                                                 | Use an explicit result union such as `update-available`, `up-to-date`, `local-missing`, and `unknown`. Include sanitized error categories in reports, exclude unknown results from apply, and return a distinct incomplete-detection outcome when selected services cannot be assessed.                                                                                                                                                                                   |
| SEC-05 | Digest comparison must be platform-aware                                                        | Current local lookup selects the first `RepoDigests` entry, while remote lookup parses one descriptor/config digest from `docker manifest inspect --verbose`. Multi-platform indexes and platform manifests can have different digests, producing false updates or pinning the wrong artifact.                                                                       | Canonicalize registry/repository plus platform (`os/architecture/variant`). Compare like-for-like manifest identities, preserve the exact digest used by the running host, and add multi-architecture/index fixtures. Digest pinning provides immutable identity as described by Docker's [image digest guidance](https://docs.docker.com/dhi/core-concepts/digests/).                                                                                                    |
| SEC-06 | Current readiness helper does not verify the updated target                                     | `waitForDependencyReadiness()` evaluates dependencies; a target with no dependencies can be reported ready without inspecting its own state or health. Automatic restore decisions based on this signal would accept crash-looping or unhealthy updates.                                                                                                             | Add a target readiness gate: confirm the service maps to a newly created container, its image ID equals the expected new identity, state is running, Docker health is healthy when configured, and it remains stable for a bounded observation window. Then evaluate dependencies. Compose's documented readiness contract relies on configured health checks and `service_healthy` conditions ([startup order](https://docs.docker.com/compose/how-tos/startup-order/)). |
| SEC-07 | Broad Compose cleanup can exceed the selected update scope                                      | `startServices()` always adds `--remove-orphans`. Invoking it during a single-service update or restore can remove unrelated containers considered orphaned under the chosen Compose/profile context.                                                                                                                                                                | Add a lifecycle-specific recreate helper that targets exactly one validated service and omits orphan cleanup. Resolve profiles and sidecars during preview, display them, and bind the approved target set into the plan.                                                                                                                                                                                                                                                 |
| SEC-08 | Saved plans are untrusted input                                                                 | `loadPlan()` casts arbitrary JSON to `DeploymentPlan`; current validation checks only a few required fields and the Compose hash. Crafted paths, service names, profiles, image identities, or oversized content could redirect privileged Docker actions or cause resource exhaustion. Argument arrays limit shell injection but do not make hostile operands safe. | Enforce a versioned runtime schema, file-size limit, strict keys/types, bounded strings/counts, canonical paths, and exact membership in the freshly rendered Compose model. Do not accept command-like image overrides, additional Compose files, or services not present in the approved plan.                                                                                                                                                                          |
| SEC-09 | Restore scope cannot undo data/schema migrations                                                | Generations explicitly restore images only; volumes, databases, and the current Compose configuration are not reverted. A new container may perform irreversible migrations before failing health checks, leaving the old image unable to start.                                                                                                                     | State the image-only boundary in preview and results. Allow per-service pre-update hooks/backups and post-update validation, identify migration-sensitive services, and support `--no-restore` where automated image rollback is unsafe. Never label image recreation as full rollback.                                                                                                                                                                                   |
| SEC-10 | Concurrent lifecycle runs can corrupt the safety boundary                                       | The SQLite transaction protects individual writes, but no lifecycle lock covers plan validation, snapshot, pull, recreate, verify, and restore. Two runs can overwrite mutable tags, consume the wrong pre-image, or interleave generation state.                                                                                                                    | Acquire an exclusive project/Compose-context lock before revalidation and hold it through terminal verification/restoration. Include owner PID/start time, reject live locks, recover stale locks cautiously, and serialize updates by default.                                                                                                                                                                                                                           |
| SEC-11 | State permissions are not consistently enforced                                                 | Database creation attempts `0700`/`0600`, but existing/custom paths are not repaired and chmod failure is non-fatal. New managed state will contain operational topology, image identities, failure details, and possibly user-supplied paths.                                                                                                                       | Validate parent ownership and mode on every open, reject symlinks and unsafe world/group-writable paths, fail closed for lifecycle state when secure creation is impossible, and apply equivalent controls to lock, report, plan, and temporary override files.                                                                                                                                                                                                           |
| SEC-12 | Automatic pulling trusts registry authentication and transport policy configured outside rfapps | Docker resolves registry credentials from its client configuration. An absent credential helper can leave credentials base64-encoded in `config.json`; private pulls can also fail or use an unintended account/context.                                                                                                                                             | Reuse Docker's configured credential helpers and never accept passwords in CLI arguments, plan files, or logs. Preflight the Docker context and registry identity and report only registry host/auth category. Docker recommends an external credential store and `--password-stdin` for noninteractive login ([docker login](https://docs.docker.com/reference/cli/docker/login/)).                                                                                      |

### ADVISORY

| ID     | Finding                                                             | Evidence and impact                                                                                                                                                                                                                 | Required mitigation                                                                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-13 | Digests prove identity, not publisher trust or vulnerability status | A digest makes an artifact immutable but does not establish who published it or whether it contains known vulnerabilities.                                                                                                          | Keep digest identity mandatory, and provide optional policy hooks for signature/attestation verification and vulnerability scanning. Record policy result and verifier version without storing credentials or full sensitive attestations.                                                                        |
| SEC-14 | Debug/error output can leak sensitive paths or tool output          | Docker/env wrappers log complete argument arrays, including dotenvx/1Password env-file paths. Captured registry/Compose stderr may contain private hosts, usernames, or tool diagnostics and may flow into reports/database errors. | Centralize structured redaction before logging or persistence; classify fields, redact credential-like substrings and sensitive paths, cap stderr length, and avoid streaming raw subprocess output in managed-update JSON/report modes.                                                                          |
| SEC-15 | Remote Docker contexts expand the trust boundary                    | Existing retry logic explicitly supports Docker over SSH. The local plan/state may describe a remote daemon whose host identity, image cache, and credentials differ from expectations.                                             | Persist and revalidate a non-secret Docker context/daemon identity in the plan, require protected SSH or TLS, and reject context changes between preview and apply. Docker documents SSH/TLS protection for daemon access ([protect the daemon socket](https://docs.docker.com/engine/security/protect-access/)). |
| SEC-16 | Temporary restore overrides can become sensitive or stale artifacts | A generated Compose override may reveal host paths, registry names, or operational state and could be reused accidentally if left behind.                                                                                           | Write the smallest possible override in a private temporary directory, include only service/image data, open atomically with `0600`, pass the explicit path as one argument, and remove it in `finally`. Do not include environment, mounts, labels, or secrets.                                                  |

## Authentication/Authorization

- `rfapps update --apply` should require the same trusted local Docker authority as direct Docker CLI
  use. Do not add elevation, `sudo`, registry-login, or credential-capture behavior.
- Default to preview-only. Mutation requires an explicit `--apply` plus interactive confirmation;
  noninteractive execution requires `--yes`. Machine output alone must not imply authorization.
- Bind approval to the plan ID, Compose hash, Docker context identity, exact services, local image IDs,
  and remote digests. If any bound field changes, require a new preview and approval.
- Never place registry tokens in arguments or environment snapshots. Let Docker resolve credentials
  through `credsStore`/`credHelpers`; Docker notes that credentials otherwise may be stored only
  base64-encoded in `config.json` ([Docker CLI configuration](https://docs.docker.com/reference/cli/docker/)).
- A future MCP/HTTP wrapper must add its own authenticated, service-scoped authorization policy.
  Access to an rfapps process with Docker socket access is effectively host administration.

## Data Protection

- Persist only operational metadata: plan/generation IDs, service, timestamps, sanitized status,
  Compose hash, Docker context fingerprint, immutable image ID, canonical repo digest, and health
  outcome. Do not persist resolved environment values, registry auth headers, Docker config content,
  or raw inspect JSON.
- Replace heuristic masking with allowlisted serialization. Heuristics remain useful as defense in
  depth for display, but variable names such as `LICENSE`, `URL`, or vendor-specific names can still
  contain secrets.
- Use private directories, `0600` files, atomic write-then-rename, `O_NOFOLLOW`-equivalent checks,
  bounded retention, and explicit cleanup for plans, reports, locks, and override files.
- Sanitize subprocess stderr before storing it. Store stable error codes separately from human text.
- Generation history is append-only audit state. If pruning is added, preserve referential integrity
  and never delete the only retained pre-update image until its lifecycle is terminal.

## Dependency Security

- Pin restoration to the exact local image ID and record a canonical repository digest for audit.
  Tags are display metadata only.
- Detection must understand multi-platform image indexes and selected host platform; never compare
  unrelated index/config/manifest digests.
- Do not auto-pull when digest lookup is unknown, authentication fails, or the registry response is
  malformed. A failed security check is not evidence of freshness.
- Add optional admission policy for signatures, provenance attestations, approved registries, and
  vulnerability thresholds. These checks should run after detection and again before apply if their
  evidence is time-sensitive.
- Avoid introducing a registry SDK unless its authentication, redirect, TLS, manifest-index, and
  credential-helper behavior can be maintained safely. Reusing the Docker CLI keeps one credential
  boundary, but returned data still needs strict parsing.

## Input Validation/command injection

The current executor uses `spawn(command, args)` without a shell, which materially limits shell
metacharacter injection. Preserve this invariant: never construct a shell command string, use
`shell: true`, or route image/service/path input through `sh -c`.

Still validate operands because Docker and Compose interpret option-like values and files:

- Resolve service names only from a freshly rendered Compose config and use `--` before positional
  service/image operands wherever the Docker subcommand supports it.
- Canonicalize Compose, plan, env, database, and override paths; reject NULs, symlinks where unsafe,
  device files, FIFOs, traversal outside the approved project/state roots, and untrusted ownership.
- Parse image references with a real OCI/Docker reference grammar; reject whitespace/control
  characters and require an approved registry when policy is enabled.
- Validate digests as an allowed algorithm plus exact encoded length, and compare normalized values.
- Apply strict runtime schemas and size/count limits to plans, registry JSON, inspect JSON, and
  reports. Never trust TypeScript casts at an external boundary.
- Keep temporary override content structured and minimal; do not concatenate YAML fragments from
  image or service input.

## Infrastructure Security

- Prefer a rootless daemon where operationally compatible; Docker states rootless mode mitigates
  daemon/runtime vulnerabilities by running them without root privileges
  ([rootless mode](https://docs.docker.com/engine/security/rootless/)). Regardless of mode, allow
  only trusted users to invoke the lifecycle.
- For remote contexts, require SSH or mutually authenticated TLS and bind the approved daemon/context
  to the plan. Never use an unauthenticated TCP Docker endpoint.
- Run services sequentially for the first release. This bounds blast radius and gives each service a
  clear snapshot/restore transaction.
- Verify disk space before retaining old and new images. Do not prune images during the lifecycle;
  cleanup is a separate, explicit operation after successful verification.
- Avoid `--remove-orphans`, volume deletion, image pruning, and broad profile operations in update or
  restore paths.
- Health checks should be application-specific where possible. Container-running and open-port
  signals are fallbacks, not proof that data migrations or end-to-end behavior succeeded.

## Secure Coding Guidelines

1. Model the lifecycle as an explicit state machine with terminal `verified`, `restored`, and
   `restore_failed` outcomes. Restore only after mutation begins; stop the run on restore failure.
2. Revalidate all approved identities immediately before each mutation. No force flag may bypass
   image, context, or Compose identity checks.
3. Snapshot before pull. Confirm the old image exists locally and is inspectable before proceeding.
4. Separate display models from persistence models. Secret-bearing runtime configuration must never
   enter a serializable plan/report type.
5. Keep the Docker boundary argument-array only and narrowly scope every command to one validated
   service. Add unit tests asserting exact argv, including `--pull never` on restore.
6. Use runtime schema validation and discriminated results for all subprocess/JSON boundaries.
7. Test adversarial inputs: option-like services, malicious plan JSON, symlinked files, moving tags,
   multi-arch manifests, missing credentials, concurrent runs, unhealthy targets, and restore failure.
8. Test confidentiality with canary secrets across text/JSON/YAML/table output, debug logs, plans,
   SQLite rows, thrown errors, and temporary files.
9. Record enough audit data to explain each decision without recording secrets: expected/observed
   identities, sanitized phase/error code, generation, plan, and timestamps.
10. Fail closed when state cannot be written securely. A restore point that was not durably recorded
    is not a valid precondition for mutation.

## Trade-offs

- **Exact restore versus portability:** local image IDs guarantee restoration on the same daemon but
  are not portable. Store both image ID and repo digest; use the local ID for automatic same-daemon
  restore and require an explicit, authenticated digest pull for cross-daemon recovery.
- **Secret-free plans versus rich diffs:** removing environment values reduces diagnostic detail.
  Preserve variable names plus `added/modified/removed` and optional keyed hashes rather than values.
- **Fail-closed registry checks versus availability:** private or temporarily unavailable registries
  will block managed apply. That is appropriate for a safety workflow; users can still use ordinary
  deploy commands explicitly.
- **Sequential updates versus speed:** sequential operation is slower but sharply reduces blast
  radius and makes restoration semantics deterministic. Parallelism should wait for defined
  transaction-group behavior.
- **Automatic restore versus application migrations:** image restore improves container-level
  recovery but can worsen migration failures. Per-service policy and backup hooks are safer than a
  universal promise of rollback.
- **Signature/scanning policy versus scope:** digest identity is required for v1; signature and
  vulnerability policy can be optional hooks, but the data model should reserve policy outcomes so
  these controls do not require another persistence redesign.

## Open Questions

1. Is automatic restore enabled by default for every service, or only for services explicitly marked
   rollback-safe in `rfapps.config.yaml`?
2. What exact Docker context/daemon properties should bind a plan without leaking remote connection
   details?
3. Which digest should be canonical for multi-platform images: index digest, selected platform
   manifest digest, or both?
4. How long must a target remain healthy, and can services define post-update application probes?
5. Should an unknown update result fail the entire command or only exclude that service while
   returning a partial/incomplete status?
6. How are sidecars handled: part of the same approved transaction, independently snapshotted, or
   excluded from automatic update?
7. Which services are migration-sensitive, and what backup/preflight contract is required before
   enabling restore for them?
8. What retention policy guarantees the pre-update image remains available without unbounded disk
   growth?
9. Should managed-update plans be applyable from arbitrary paths, or only from the private rfapps
   state directory created by the current user?
10. Is publisher signature/provenance verification a first-release gate for internet-facing core
    services, or a follow-up policy hook?
