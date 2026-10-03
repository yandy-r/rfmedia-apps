# Security Research: `rfapps reconcile`

## Executive Summary

`rfapps reconcile` crosses a high-authority boundary: even though it is a local CLI, the selected
Docker daemon can usually create privileged containers, mount host paths, and control workloads on
the daemon host. Docker explicitly warns that daemon credentials should be protected like a root
password. The safe design is therefore an observer by default and a narrowly scoped lifecycle
operation only when `--auto-apply` is present.

The existing managed-update implementation contains the best security pattern to reuse:
canonical Compose project identity, a non-secret Docker-authority fingerprint, a private
project/context lifecycle lock, strict and size-bounded artifacts, immediate pre-mutation
revalidation, immutable scope, bounded subprocess output, and final verification. The older
`drift reconcile` and generic `plan`/`apply` paths are not safe templates for this feature: the
former mutates immediately through `startServices()`, which includes `--remove-orphans`, while the
latter accepts loosely validated, ordinarily permissioned plan JSON and permits compose-hash
bypass with `--force`.

The principal requirements are to keep report mode strictly read-only, bind auto-apply to the
reviewed Compose project and Docker authority, re-observe under the lifecycle lock immediately
before every mutation, never persist resolved secret values, and use a dedicated Compose argv that
cannot pull images or remove out-of-scope resources. Maintenance-window compatibility should be a
fail-closed policy decision evaluated after locking and revalidation but immediately before the
first mutation; reporting must remain available outside the window.

## Findings by Severity

### CRITICAL

No critical finding is inherent in the proposed feature if the controls below are implemented.
An implementation that lets report mode mutate, or that applies an untrusted/stale artifact without
authority and state revalidation, should be treated as release-blocking.

### WARNING

| ID      | Finding                                                                                        | Impact and likelihood                                                                                                                                                                                                                                                                       | Required mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-W01 | Docker access is host-level authority, and Compose files are executable infrastructure policy. | A compromised Compose file or incorrectly selected remote context can run arbitrary images, mount host paths, grant capabilities, or otherwise control the daemon host. Likelihood is credible in CI, remote-context, and shared-repository use.                                            | Resolve one canonical Compose file/project and one Docker-authority fingerprint; display a non-secret authority identifier; require `--auto-apply`; never infer mutation authority from `--yes`, output format, or non-interactive stdin; document that the operator must trust the Compose source. Prefer SSH or verified TLS for remote daemons and support rootless Docker where practical.                                                                                                          |
| SEC-W02 | A report can become stale between observation and mutation (TOCTOU).                           | Compose content, interpolation inputs, project name, selected context/daemon, containers, or service configuration can change after the first report, causing a different action than the one reviewed. Concurrent lifecycle commands make this likely enough to design for.                | Acquire the existing project + Docker-context + Compose-project lifecycle lock before auto-apply. Under the lock, re-resolve canonical Compose identity, Compose hash, resolved-config fingerprints, environment-source fingerprint, authority fingerprint, exact scope, container identity, and proposed action. Revalidate each service immediately before its action; stop the cycle on the first unexplained mismatch. Do not provide a force/stale-plan bypass.                                    |
| SEC-W03 | Reusing `startServices()` would silently widen impact through `--remove-orphans`.              | Reconciliation of one service could delete project containers absent from the current model; Compose may also start dependencies, and its normal pull policy could fetch mutable tags. This violates the issue's desired-vs-actual scope and can cause availability or supply-chain impact. | Add a dedicated targeted reconciliation Docker helper. Use explicit argv, an explicit project name, canonical `-f` paths, selected profiles, `up -d`, only the frozen service operands, and a deliberate `--pull never` policy. Omit `--remove-orphans`. Decide and report dependency behavior explicitly (`--no-deps` only if readiness/dependency semantics remain correct). Orphan deletion must be a separate future action and authorization.                                                      |
| SEC-W04 | Resolved Compose and container inspection data contain secrets.                                | `docker compose config` expands variables, and `docker inspect` exposes container environment values. Secret-name heuristics alone miss credentials with benign names, while debug/error output and machine artifacts are durable leakage paths.                                            | Keep raw desired/actual values process-local. Public diffs must never contain environment values: emit name, presence/change type, and `redacted: true`; do not persist hashes of low-entropy secrets. Build persisted reports from an explicit allowlist, then apply generic credential/URL redaction to bounded error text. Never log full Compose JSON, inspect JSON, environment-provider argv, or subprocess stderr without redaction. Encourage Compose secrets instead of environment variables. |
| SEC-W05 | `--auto-apply` can turn an automation mistake into an outage.                                  | A broad or empty selector, ambiguous observation, partial daemon response, unhealthy dependency, or future scheduler bug could recreate many services. A machine-output flag or `--yes` accidentally authorizing mutation would be especially dangerous.                                    | Make `--auto-apply` the sole command-specific mutation gate and keep `--dry-run` dominant. Freeze and report explicit scope before apply; reject empty/ambiguous selections and observation failures; cap selected services; execute dependency-safe and sequentially by default; stop after a service cannot be stabilized; verify after every action and re-observe the final scope. Distinguish blocked, failed, partial, and converged outcomes.                                                    |
| SEC-W06 | Generic plan storage is not an adequate auto-apply artifact boundary.                          | `savePlan()`/`loadPlan()` use ordinary reads/writes without strict schema, size, ownership, symlink, or permission checks; `validatePlan(..., { force: true })` can downgrade compose drift. A modified plan can redirect Compose paths or widen services.                                  | Do not feed reconciliation artifacts to generic `rfapps apply`. Define versioned intents such as `reconcile-report.v1` and, only if saved apply is required, `reconcile-plan.v1`. Reuse the managed-artifact boundary: exact-key runtime validation, 1 MiB or lower size cap, bounded arrays/strings, no traversal or symlinks, owner-only directories/files, atomic exclusive writes, explicit overwrite, canonical paths, and mandatory live revalidation.                                            |
| SEC-W07 | A maintenance-window check can race or fail open.                                              | A report generated inside a window may apply outside it, and a policy lookup error may otherwise be interpreted as permission. This becomes more likely when future schedulers are added.                                                                                                   | Model eligibility as typed data (`eligible`, `outside_window`, `policy_error`, `not_configured`). Evaluate it for reporting, then evaluate again under the lifecycle lock immediately before the first mutation and, for long runs, before each service. `policy_error` and window expiry block new actions. Never block read-only observation. Record policy identifier/version and decision reason, not credentials or full policy input.                                                             |

### ADVISORY

| ID      | Finding                                                                                                         | Impact and likelihood                                                                                                                                                                                                                                          | Required mitigation                                                                                                                                                                                                                                                                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-A01 | Shell injection is currently avoided, but argv option injection remains possible if operands are not validated. | `spawn(command, args)` defaults to no shell, so metacharacters are not interpreted. However, service/profile/project strings beginning with `-`, control characters, or unexpected path forms can still change Docker CLI parsing or corrupt logs.             | Continue using `spawn()` with argument arrays and never enable `shell`. Validate service/profile/project operands with the existing safe Compose-operand rules, reject control characters and NUL, canonicalize Compose paths, and insert `--` where the Docker subcommand supports it. Do not assemble or execute command strings.                                          |
| SEC-A02 | Machine output can be schema-stable yet nondeterministic.                                                       | Unsorted service/category/action arrays, locale-dependent ordering, timestamps, durations, ANSI output, or raw daemon messages make policy engines and signed artifacts unreliable. CSV also risks formula interpretation when opened in spreadsheet software. | Define JSON as the normative schema, version it, sort all keyed collections with a fixed code-point comparator, use enums and exact keys, and separate volatile execution metadata from the deterministic decision payload. Disable colors/progress on machine stdout and keep logs on stderr. If CSV is supported, flatten explicitly and neutralize formula-leading cells. |
| SEC-A03 | Lock ownership is process-based and stale locks intentionally require manual recovery.                          | PID reuse or a crash can deny future lifecycle operations, but automatic takeover could permit concurrent mutations. This is primarily an availability concern.                                                                                                | Preserve fail-closed stale-lock behavior and inode-safe release. Improve operator diagnostics and provide a separately documented/manual unlock procedure that verifies daemon/project identity; do not add automatic expiry or deletion to reconciliation.                                                                                                                  |
| SEC-A04 | Reconciliation cannot guarantee data rollback.                                                                  | Recreating containers preserves named/bind-mounted data in normal Compose behavior, but schema migrations, application side effects, anonymous volume behavior, or health-check gaps may still make rollback unsafe.                                           | State the rollback boundary explicitly. Do not claim transactional convergence. Preserve volumes by default, never renew anonymous volumes, verify service and dependency readiness, and stop the cycle after stabilization failure. Direct operators to application-specific backup/restore for data recovery.                                                              |

## Authentication and Authorization

- Authentication is delegated to the Docker CLI environment: local socket permissions, Docker
  context credentials, SSH, or mutual TLS. `rfapps` must not copy or persist Docker credentials.
- Docker access is the authorization boundary. Docker's documentation notes that possession of
  daemon client keys can grant root access to the daemon host; a successful socket connection is
  therefore not a low-privilege capability. See [Protect the Docker daemon socket](https://docs.docker.com/engine/security/protect-access/)
  and [Docker Engine security](https://docs.docker.com/engine/security/).
- Bind a cycle to the effective context endpoint, `DOCKER_HOST` override, and daemon ID using the
  existing non-secret authority fingerprint. Bind it separately to the canonical project path and
  resolved Compose project name.
- `--auto-apply` authorizes only the reported and revalidated service actions. It does not authorize
  pruning, image pulling, builds, Compose-file edits, volume changes, importing runtime state, or
  mutation through MCP/read-only integrations.
- Machine formats must never bypass an authorization decision. `--yes` may suppress a human
  confirmation only after `--auto-apply`; it must not imply auto-apply.
- For future maintenance windows, policy eligibility is an additional authorization condition, not
  a replacement for `--auto-apply` or lifecycle locking.

## Data Protection

- Treat resolved Compose models, container inspection payloads, environment-provider output, and
  Docker stderr as sensitive even when only a subset is rendered.
- Replace all environment values with an invariant redacted representation in text, JSON, YAML,
  tables, CSV, saved reports, debug logs, and errors. Key-name detection may improve presentation
  but must not decide whether a value is protected.
- Allowlist artifact fields. Safe examples are schema/intent, non-secret fingerprints, canonical
  service names, categories, action enums, reason codes, aggregate counts, and redacted bounded
  messages. Avoid Docker endpoints, environment-file contents, raw labels, raw mount sources when
  not necessary, and full container inspection data.
- Use the managed artifact storage controls: `0700` directory, `0600` file, no symlink components,
  exclusive temporary creation, `fsync`, atomic rename, explicit overwrite, and bounded size.
- Compose warns that environment variables can be printed in logs and recommends per-service
  Compose secrets where possible. See [Manage secrets securely in Docker Compose](https://docs.docker.com/compose/how-tos/use-secrets/).
- Do not retain raw observation snapshots after the process exits. If later audit retention is
  required, store the redacted terminal result rather than the Docker or Compose source payload.

## Dependency Security

| Dependency or boundary        | Current evidence                                                                                                                                                                       | Risk                                                                                                                                                       | Recommendation                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Engine / Compose CLI   | External operator-supplied executable and daemon                                                                                                                                       | Very high authority; behavior varies by Compose version and context configuration.                                                                         | Probe required flags before apply, bind the daemon fingerprint, set time/output limits, use a minimum supported Compose version, and document SSH/TLS/rootless recommendations. Do not add a second Engine SDK path.                                 |
| Node.js `child_process.spawn` | Package requires Node `>=22`; current Docker wrapper passes an argv array and leaves `shell` at its default `false`.                                                                   | Low injection risk if operands stay validated; inherited `PATH` and environment still select executables/authority.                                        | Keep shell disabled and argv structured. Node documents `shell: false` as the default and warns against unsanitized input when a shell is enabled: [Node child process](https://nodejs.org/download/release/latest-jod/docs/api/child_process.html). |
| `yaml`                        | Direct rfapps dependency; lockfile currently resolves `2.8.2`. The 2026-07-18 production audit reports GHSA-48c2-rrv3-qjmp for versions below `2.8.3` (deep nesting stack exhaustion). | Moderate local denial of service when parsing attacker-controlled YAML; the reconciliation command increases the value of reliable Compose/config parsing. | Update the lockfile to `yaml >=2.8.3`, run the focused config/drift/reconcile tests, and add bounded-input/deep-nesting regression coverage where the application directly parses YAML.                                                              |
| Commander / `@rfmedia/common` | Existing command and output stack; no new dependency is needed. `@rfmedia/common` is declared with workspace wildcard `*`.                                                             | Option-default mistakes can change authorization; wildcard publication resolution is less reproducible outside a locked workspace.                         | Test the full Commander option matrix (`--auto-apply`, `--yes`, `--dry-run`, machine output). Keep workspace lockfile integrity and prefer a deliberate version range if the package is ever consumed outside the monorepo.                          |
| `better-sqlite3`              | Existing state dependency; reconciliation reporting need not write state.                                                                                                              | Unnecessary writes expand failure and lock surfaces; native dependency carries supply-chain/build risk.                                                    | Do not open or mutate the state database in report-only mode. In apply mode, write only finalized lifecycle records using existing prepared-statement boundaries.                                                                                    |

No new runtime library is justified for issue #151. The existing CLI boundary preserves Docker's
context, SSH/TLS, API negotiation, and Compose model semantics while avoiding an additional supply
chain and authentication implementation.

## Input Validation

- Validate `--service`, `--services`, group expansion, sidecars, profiles, and project names against
  the resolved Compose model, then freeze a unique sorted scope. Reject duplicates after
  normalization, empty comma elements, unknown names, option-like operands, control characters,
  and an excessive service count.
- Resolve the Compose file once to an absolute canonical regular file with no symlink components.
  Re-resolve it under the lock and reject identity/hash changes. Included/extended Compose content
  is part of the trust chain; Docker's [Compose trust model](https://docs.docker.com/compose/trust-model/)
  notes that Compose files can read host files and request host-level privileges.
- Treat Docker/Compose stdout as untrusted input. Enforce byte caps, timeouts, strict JSON parsing,
  exact expected structures, bounded item counts/strings, safe numeric ranges, and complete service
  accounting. Partial parsing is an observation failure, never an actionable result.
- Saved machine artifacts are untrusted on load. Validate version, intent, exact keys, enums,
  aggregate invariants, unique ordered services, canonical paths, fingerprints, and maximum size
  before using any field.
- Never interpolate user values into a shell command. The existing `spawn()` argv pattern should be
  mandatory for new Docker calls.

## Infrastructure Security

- Report mode may run `docker compose config`, `ps`, and `inspect`, but read access to the daemon is
  still sensitive. In CI, use a dedicated runner/daemon with the least authority practical and do
  not expose an unauthenticated TCP socket.
- Docker Compose treats the Compose project as trusted code, not inert data. Auto-apply should be
  limited to reviewed repositories and protected branches in automation. Docker recommends gating
  automated Compose updates through normal code review.
- Use SSH or mutually authenticated TLS for remote contexts. Do not emit endpoints, certificate
  paths, key paths, or raw context inspection data; store only the authority fingerprint.
- Keep mutations project-scoped and service-scoped. Explicitly set the Compose project name to
  prevent directory/environment precedence from redirecting ownership.
- The official `docker compose up` reference states that `--remove-orphans` deletes containers for
  services absent from the Compose model and `--force-recreate` recreates even unchanged
  containers. Neither behavior should be implicit in reconciliation; see
  [docker compose up](https://docs.docker.com/reference/cli/docker/compose/up/).
- Bound retries against remote SSH daemons. Retry observation operations when safe, but do not
  blindly replay a mutation after an ambiguous transport failure; re-observe the target first.

## Secure Coding Guidelines

1. Separate pure calculation from authority-bearing execution. The reconciler returns typed data;
   the action layer owns prompts, output, exit codes, artifact persistence, and cleanup.
2. Make report-only the type/default path. Mutation code should be unreachable unless an explicit
   `autoApply === true` decision survives dry-run and maintenance-policy checks.
3. Reuse `resolveComposeProjectIdentity()`, `dockerAuthorityFingerprint()`,
   `acquireLifecycleLock()`, bounded Docker execution, managed redaction, and private artifact
   storage rather than cloning weaker legacy behavior.
4. Use a dedicated reconciliation mutation primitive. Never call a helper that implicitly removes
   orphans, pulls images, builds, widens scope, or streams secret-bearing subprocess output.
5. Revalidate global identity once under lock and service identity immediately before each action.
   A mismatch is a typed blocked result, not a warning that can be forced through.
6. Make output construction allowlist-only and exhaustive. Every selected service must have one
   observation, proposed action, execution outcome, and final verification outcome.
7. Sort with a fixed comparator at the model boundary, not only in renderers. Tests should shuffle
   Docker/Compose input ordering and assert identical decision payloads.
8. Redact before logging or persistence. Error formatters must accept reason codes plus bounded
   sanitized evidence, not raw subprocess objects.
9. Handle SIGINT/SIGTERM like managed update: finish or stabilize the in-flight service, stop
   scheduling new mutations, release the owned lock safely, and emit an interrupted terminal
   result when possible.
10. Add adversarial tests for stale Compose/context/env/scope/container identities, malicious
    artifact fields and symlinks, secret names that evade heuristics, option-like operands,
    oversized/nested input, orphan preservation, machine stdout purity, maintenance-window expiry,
    and ambiguous Docker transport failures.

## Trade-off Recommendations

| Decision               | Recommended default                                                          | Security trade-off                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Report versus mutation | Report-only unless `--auto-apply` is explicit                                | Adds one flag for operators but makes routine observation safe and automation intent auditable.                                                                                    |
| Apply model            | Recalculate in-process under lock; no saved apply in v1                      | Gives up delayed/offline plan application while avoiding a large untrusted-artifact and staleness surface. A saved plan can be added later using managed-artifact controls.        |
| Mutation breadth       | One frozen, dependency-aware service at a time; no pruning                   | Slower than a single broad Compose call but limits blast radius and permits per-service revalidation and stabilization.                                                            |
| Image policy           | `--pull never`; image freshness belongs to `rfapps update`                   | A declared mutable tag may not fetch its newest registry content, but reconciliation stays faithful to desired-vs-actual runtime state and avoids unreviewed supply-chain changes. |
| Dependencies           | Start dependencies only when required and reported; never unrelated services | Requires explicit dependency modeling but avoids surprise scope widening.                                                                                                          |
| Secret diffs           | Report only key/change metadata, never values or value hashes                | Reduces troubleshooting detail but prevents durable credential disclosure and low-entropy hash guessing.                                                                           |
| Machine determinism    | Stable decision payload plus separate volatile execution metadata            | Consumers may need to ignore the metadata envelope for hashing, but policy evaluation and signatures remain reliable.                                                              |
| Maintenance windows    | Fail closed for mutation, always allow reporting                             | Policy outages can delay remediation, which is safer than unauthorized restarts.                                                                                                   |
| Stale locks            | Manual verified recovery                                                     | Can delay operations after crashes but prevents unsafe concurrent lifecycle takeover.                                                                                              |

## Open Questions

1. Is `--auto-apply` intended only for same-process observe-and-apply in v1, or must a saved report
   later become executable? The latter requires a distinct strict plan intent, expiry policy, and
   mandatory live revalidation; a report itself must never be executable.
2. Should targeted remediation allow Compose to start dependencies, or should the command use
   `--no-deps` and separately block when dependencies are not ready? The answer must be visible in
   the action model and frozen scope.
3. What maximum service count and maximum cycle duration are acceptable for one auto-apply run?
   These bounds affect daemon load, maintenance-window expiry, and interruption behavior.
4. Which runtime-status differences are safely auto-correctable? A missing or stopped container is
   clearer than an unhealthy container whose application data may require manual intervention.
5. Should canonical host bind-mount source paths appear in reports? They help diagnosis but disclose
   filesystem layout; a path-redaction or opt-in policy may be preferable for durable artifacts.
6. What is the eventual maintenance-window source and precedence model (repository config, global
   config, scheduler input), and how will clock source/time zone/policy version be authenticated and
   recorded without persisting sensitive policy data?
7. Does reconciliation need a post-apply recovery action beyond stopping the cycle? Container
   recreation can have application/data side effects, so image/container rollback alone may create
   false confidence.
