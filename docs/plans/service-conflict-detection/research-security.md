# Service Conflict Detection: Security Research

## Executive Summary

Issue [#64](https://github.com/yandy-r/rfmedia-apps/issues/64) is security-positive if
`rfapps deploy --validate-first` is implemented as a bounded, read-only, fail-closed gate. It
should inspect the resolved Compose model and the same Docker daemon that will receive the deploy,
return deterministic findings, and stop before image pulls, container changes, or state writes
when evidence is conflicting, incomplete, malformed, or oversized.

No critical vulnerability is inherent in the feature as proposed. The principal risks are:

- validation and deployment observing different Docker authorities or different Compose inputs;
- secrets leaking from fully resolved Compose output or broad `docker inspect` output;
- hostile or oversized Docker/Compose output exhausting memory, confusing parsers, or injecting
  terminal control sequences;
- treating remediation suggestions as authorization to stop containers, remove resources, or edit
  Compose;
- assuming the local host represents a remote Docker context;
- weakening availability or safety through an incorrect fail-open policy; and
- adding an unnecessary parsing dependency while the current lockfile already contains known
  vulnerable versions.

The current code provides strong seams to reuse:

- `spawn(command, args)` is used without a shell in
  `packages/rfapps-cli/src/lib/docker.ts`, which prevents ordinary shell metacharacter injection.
  Node documents `spawn()`'s `shell` default as `false`
  ([Node child process documentation](https://nodejs.org/api/child_process.html), accessed
  2026-07-24; continuously updated).
- non-streaming Docker commands have timeout and captured-output limits;
- `DockerCommandError`, exit-code helpers, and the formatter pipeline provide typed error handling;
- `resolveComposeProjectIdentity()`, `dockerAuthorityFingerprint()`,
  `captureEffectiveEnvironment()`, and the reconciliation code already demonstrate canonical
  paths, pinned environments, daemon identity checks, and fail-closed parsing;
- `getComposeContainerObservations()` validates item counts, field sizes, control characters,
  duplicate identities, and deterministic ordering; and
- `redactManagedMessage()` provides a useful redaction baseline, although it is currently scoped
  to managed-update persistence rather than all Docker diagnostics.

The conflict validator should follow those hardened seams rather than the older permissive
`getComposeConfig()`/`inspectContainers()` behavior. Docker states that `compose config` renders
the actual Engine model after merges, interpolation, path resolution, and short-form expansion
([Docker Compose config reference](https://docs.docker.com/reference/cli/docker/compose/config/),
accessed 2026-07-24; continuously updated). That makes it the correct desired-state source, but
also means its raw output is sensitive and must remain ephemeral.

## Findings by Severity

### CRITICAL

No critical findings were identified. The feature need not accept network traffic, parse
untrusted user protocols, or gain privileges beyond the Docker access already required by
`rfapps`. A critical issue would arise only if implementation added automatic destructive
remediation, exposed Docker access to a less-trusted caller, or executed generated suggestions.

### WARNING

#### SEC-01: Validation-to-deploy authority and state race

Validation can pass against one daemon/context or Compose resolution and mutation can occur
against another. `DOCKER_CONTEXT` overrides the selected default context, while Compose also
inherits Docker CLI variables such as `DOCKER_HOST` and `DOCKER_CONTEXT`
([Docker CLI reference](https://docs.docker.com/reference/cli/docker/), and
[Compose predefined variables](https://docs.docker.com/compose/how-tos/environment-variables/envvars/),
accessed 2026-07-24). Environment tools can also produce different values on separate invocations.
The CLI state lock prevents another `rfapps` mutator, but it cannot stop direct Docker clients or
remote actors.

**Mitigation**:

- capture the effective environment once under the existing deploy state lock;
- canonicalize the Compose and env-file paths and compute a Compose content/resolved-model
  fingerprint;
- compute `dockerAuthorityFingerprintFromEnvironment()` before inspection and again immediately
  before the first mutation;
- execute validation and subsequent Docker calls with the pinned environment and `replaceEnv:
true`;
- abort with a stable `VALIDATION_AUTHORITY_CHANGED` or `VALIDATION_INPUT_CHANGED` code if any
  identity changes;
- keep the daemon's `compose up` allocation checks as final authority and describe the preflight
  as point-in-time evidence, not a guarantee.

**Confidence**: High. The repository already tests environment/context substitution during
reconciliation, and Docker documents the relevant context/environment precedence.

#### SEC-02: Resolved Compose and Docker inspection can leak secrets

`docker compose config --format json` can contain interpolated service environment values and
inline config material. A broad container inspection includes `Config.Env`, host bind paths,
labels, and other operational metadata. The current `getComposeConfig()` logs the first 200
characters of raw output on parse failure, and several existing Docker paths log raw stderr in
debug mode. Conflict results or deployment history must not inherit that behavior.

**Mitigation**:

- keep raw Compose JSON and inspection responses process-local and never persist them;
- project only required fields from parsed Compose data immediately;
- use static Docker `--format` templates or narrowly typed JSON projections so container
  environment values and mount contents are never requested;
- never log raw stdout, raw stderr, the captured environment, or the resolved model;
- return allowlisted, sanitized error codes and messages instead of daemon-provided text;
- apply redaction and a strict length cap before any Docker-derived text crosses a log, structured
  output, exception, or database boundary;
- omit absolute bind paths and canonical host paths from normal findings. Prefer resource names,
  container target paths, or a one-way identifier where ownership evidence is necessary.

**Confidence**: High. The sensitive fields are present in the repository's current
`ContainerInspect` type, and Compose interpolation is explicitly documented.

#### SEC-03: Hostile, malformed, or oversized command output

The Docker daemon, Compose plugin, env wrapper, or a `docker` binary selected through a hostile
`PATH` can produce arbitrary bytes. The generic runner limits captured stdout to 4 MiB and stderr
to 1 MiB, but a conflict snapshot may run several commands, and the older
`getComposeConfig()`/`inspectContainers()` parsers accept broad unchecked object shapes. The
runner sends `SIGTERM` on timeout/overflow but has no forced-kill escalation if a child ignores the
signal.

**Mitigation**:

- set lower command-specific byte limits and hard caps for containers, networks, volumes,
  published-port ranges, IPAM entries, object depth, keys, and UTF-8 field length;
- inspect validated IDs in fixed-size batches rather than names or one unbounded batch;
- reject truncation, duplicate identities, non-object JSON, unexpected scalar types, unsafe
  control characters, and excessive counts with stable unavailable codes;
- represent ranges as intervals where possible instead of expanding attacker-sized ranges;
- sanitize all human text to remove C0/C1 controls, ANSI CSI/OSC sequences, newlines, and bidi
  controls before terminal output;
- add terminate-then-kill escalation and a final bounded completion deadline to the shared runner;
- resolve or constrain executable paths in privileged automation, or at minimum pin and reuse the
  captured `PATH` so validation and mutation cannot select different clients.

**Confidence**: High for bounded-output and parser risks; Medium for malicious executable
selection because control of the invoking environment is normally already a strong local
capability.

#### SEC-04: Docker access is a privilege boundary, including remote contexts

The validator requires Docker inventory access. Docker warns that control of daemon credentials
can amount to root access on the daemon host and that TCP access must be protected with TLS;
SSH contexts are also supported
([Protect the Docker daemon socket](https://docs.docker.com/engine/security/protect-access/) and
[Docker Engine security](https://docs.docker.com/engine/security/), accessed 2026-07-24;
continuously updated). Read-only CLI intent does not create a read-only Docker credential:
authorization remains whatever the socket, SSH account, TLS certificate, or daemon plugin grants.

**Mitigation**:

- do not add `sudo`, socket permission changes, credential discovery, or privilege escalation;
- use the active Docker context and its existing SSH/TLS authentication without copying
  credentials into results;
- document that unauthenticated `tcp://...:2375` is unsupported/insecure and recommend SSH or
  mutually authenticated TLS;
- honor daemon authorization-plugin denials and fail closed when required inventory cannot be
  read;
- query only Docker state. Never use local `lsof`, `ss`, `/proc`, or filesystem checks as evidence
  for a remote context;
- make clear that detected ports and paths belong to the daemon host, which may be a VM or remote
  server, not the machine running `rfapps`.

**Confidence**: High. Docker's security guidance is explicit, and the repository intentionally
supports SSH retries and Docker authority fingerprints.

#### SEC-05: Automatic remediation would exceed deploy authorization

The issue requests interactive resolution suggestions. A suggestion such as "Stop jellyfin" is
not authorization to execute `docker stop`, remove a network/volume, edit Compose, or choose a new
port. Automatically changing a shared remote daemon could interrupt unrelated tenants, destroy
data, or redirect traffic.

**Mitigation**:

- v1 suggestions must be inert structured data and human prose only;
- never execute a generated command, even with `--yes`;
- `--yes` may skip the existing deployment confirmation but must not bypass a blocking conflict;
- do not provide a "continue anyway" path for `--validate-first`;
- if remediation is added later, design it as a separate explicitly invoked plan/apply operation
  with ownership-label verification, a narrow allowlist, a second confirmation, context/input
  revalidation, and rollback evidence;
- never recommend deleting a named volume as a generic fix.

**Confidence**: High. The requested resources can belong to unrelated applications, and current
deploy authorization does not include editing configuration or deleting third-party resources.

#### SEC-06: Unsafe operands, option injection, path substitution, and parser complexity

Array-based `spawn` blocks shell expansion, but it does not stop an operand beginning with `-`
from being interpreted as a Docker option. Compose paths and env files can also be swapped through
symlinks between review and use. Separately, the current raw-YAML service validator reads the
whole file and sets `maxAliasCount: -1`, disabling the YAML library's alias expansion bound.

**Mitigation**:

- reuse the `SAFE_COMPOSE_OPERAND` policy for project, service, container, profile, network, and
  volume identifiers passed back to Docker; prefer validated hexadecimal Docker IDs for inspect
  calls;
- use `--` where the specific Docker command supports it, but do not assume universal support;
- reject NULs, leading-option operands, control characters, overlong values, and invalid Unicode;
- reuse `resolveComposeProjectIdentity()` and canonical, symlink-free regular-file checks for
  Compose and env files, then revalidate identity before mutation;
- cap Compose file bytes before the existing raw-YAML validation and restore a finite
  `maxAliasCount`, or replace that service-name pass with the already resolved Compose model;
- validate CIDR prefix bounds, port/protocol/address-family types, volume driver/options shapes,
  and every external JSON field before comparison;
- use `Map` or null-prototype records for untrusted resource keys and never merge raw parsed
  objects into result objects.

**Confidence**: High for the explicit unbounded YAML configuration and current path/operand
differences; Medium for exploitability because Compose files and local CLI options are usually
operator-controlled.

#### SEC-07: Current lockfile contains vulnerable runtime and development packages

On 2026-07-24, `npm ls --package-lock-only --omit=dev --workspace packages/rfapps-cli` resolves
`ink@5.2.1 -> ws@8.19.0`. GitHub reports a high-severity memory exhaustion issue affecting
`ws < 8.21.0`, fixed in 8.21.0
([GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p), published
2026-05-22, updated 2026-07-13), plus a moderate memory-disclosure issue affecting
`ws < 8.20.1`
([GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx), published
2026-05-12, updated 2026-05-18). The CLI does not intentionally expose a WebSocket server, so
practical reachability appears low, but the vulnerable runtime artifact is shipped.

The development tree also resolves `picomatch@4.0.3` through Vitest, and the current audit reports
known ReDoS/method-injection advisories fixed in 4.0.4 or later. This affects test/build tooling
rather than the installed rfapps runtime.

**Mitigation**:

- refresh the lockfile so Ink's compatible `^8.18.0` range selects `ws >= 8.21.0`, then run the
  full CLI tests;
- update `picomatch` transitively through supported Vitest/Vite releases or a reviewed lockfile
  refresh;
- run `npm audit --omit=dev` and a full audit in CI, while reviewing reachability instead of
  blindly applying breaking `npm audit fix --force`;
- keep `package-lock.json` integrity data and use `npm ci` in CI/release builds.

**Confidence**: High for affected versions and available fixes; Medium for runtime exploitability
inside this non-server CLI.

### ADVISORY

#### SEC-08: Fail-closed validation can reduce deploy availability

A fail-closed gate is correct when explicitly requested, but remote outages, authorization
restrictions, unsupported third-party network drivers, oversized fleets, and transient SSH errors
can block an otherwise valid deploy. Conversely, fail-open behavior would make
`--validate-first` misleading.

**Mitigation**:

- distinguish `passed`, `conflicts`, and `unavailable`;
- make conflicts and unavailable evidence exit `1` before mutation;
- use stable reason codes, bounded retries only for recognized transient transport failures, and
  no automatic fallback to an unvalidated deploy;
- let the operator rerun without `--validate-first` as a new, explicit decision rather than offer
  an in-command bypass;
- treat ambiguous shared-volume semantics and driver-specific behavior as non-blocking advisories
  unless an objective incompatibility is proven.

**Confidence**: High. This follows the stated flag semantics and the repository's existing
operational exit-code category.

#### SEC-09: A preflight cannot detect every host-level conflict

Docker inspection cannot reliably detect non-Docker listeners, host-network application sockets,
future daemon-assigned ports/subnets, or platform-specific IPv4/IPv6 dual-stack behavior. Local
host probes would be wrong for remote contexts and Docker Desktop VMs.

**Mitigation**:

- detect only explicit published Docker ports and explicit IPAM subnets;
- state limitations in human and machine documentation;
- do not classify unknown state as "no conflict";
- rely on Docker's final allocation checks during `compose up`.

**Confidence**: High. These resources are absent from the portable Compose/Engine evidence
available to the client.

#### SEC-10: New CIDR dependencies are optional but require review

Node's standard library can validate IP addresses, but it does not provide complete IPv4/IPv6 CIDR
range comparison. A custom parser avoids a package but creates correctness and algorithmic-risk
ownership. `ipaddr.js@2.4.0`, checked from the npm registry on 2026-07-24, is MIT licensed, has no
runtime dependencies, and is about 64 KiB unpacked; it is a narrower candidate than packages that
pull in further IP libraries.

**Mitigation**:

- prefer a small, well-tested local interval implementation only if the team is prepared to own
  IPv6 compression, mapped-address, prefix, and overflow tests;
- otherwise pin a reviewed `ipaddr.js` version through the lockfile, verify provenance/integrity,
  audit it, and wrap it behind a tiny internal interface;
- reject zone identifiers and non-CIDR forms unless explicitly supported.

**Confidence**: Medium. Registry metadata and dependency count are current, but long-term package
maintenance and future advisories cannot be guaranteed.

## Auth/Authz

The feature should add no authentication layer. Authorization is inherited from the invoking OS
user and active Docker context:

1. Local Unix socket permissions, a rootless user socket, an SSH account, or TLS client
   credentials decide whether Docker reads are allowed.
2. `rfapps` must not attempt to elevate access when inspection is denied.
3. The same effective Docker authority must be used for validation and mutation. Reuse the
   one-way authority fingerprint; never expose the raw endpoint, daemon ID, certificate path, or
   credential material.
4. Read success does not authorize remediation. Suggestions remain non-executable.
5. If a daemon authorization plugin permits deployment but denies list/inspect operations,
   `--validate-first` is unavailable and must fail closed.

Rootless Docker is preferable where compatible because the daemon and containers run without root
privileges
([Docker rootless mode](https://docs.docker.com/engine/security/rootless/), accessed 2026-07-24;
continuously updated), but the validator must not infer safety or resource semantics from rootless
mode.

## Data Protection

The data classification for this feature is:

- **Secret**: interpolated environment values, env-file contents, inline config/secret content,
  TLS keys, Docker credential paths and values.
- **Sensitive operational metadata**: absolute host bind paths, remote endpoints, daemon IDs,
  container/network/volume inventories, project names, labels, and topology.
- **Safe output after validation and sanitization**: conflict kind, protocol, numeric port,
  normalized CIDR, bounded resource display name, objective incompatibility, and inert resolution
  action.

Raw snapshots should live only in local variables for the duration of the command and should not
enter SQLite deployment history. A failed preflight is not a deployment attempt. Structured output
should contain only allowlisted fields; error details should be stable codes and curated messages.
Debug mode must not weaken these rules.

If the result schema retains `scope.composePath`, emit the user-supplied relative/display path or a
project-relative path rather than a canonical absolute host path. Do not emit source bind paths
unless necessary to distinguish a conflict; a one-way hash plus a redacted display label is safer
for machine output.

## Dependency Security

The conflict feature itself needs no new process, YAML, Docker, formatting, or storage dependency.
Reuse the current Docker CLI wrapper and resolved Compose JSON. The most security-conservative
dependency decision is:

1. implement resource normalization and comparison as pure TypeScript;
2. use Node primitives for integers, sorting, hashing, and basic IP-family validation;
3. add only a narrowly scoped CIDR package if correctness testing shows the local IPv6 parser is
   too risky;
4. commit and review the lockfile delta, registry integrity hash, license, maintainers,
   transitive dependencies, unpacked contents, and audit result;
5. never install a network-scanning, Docker SDK, YAML, or shell-execution package for this
   feature.

The existing `ws` and `picomatch` findings in SEC-07 should be tracked independently of the
feature's dependency choice. They do not justify delaying secure conflict detection, but a lockfile
refresh should be part of the same verification window if feasible.

⚠️ **Freshness Note**: Dependency and advisory observations are from 2026-07-24. Re-run the audit
and registry checks immediately before implementation or release.

## Input Validation

All Compose and Docker data is untrusted at the parser boundary, even when it came from a local
daemon. Validate before normalization:

- **Paths**: non-empty, no NUL, absolute/canonical internally, symlink-free regular files, bounded
  size, stable identity between read and mutation.
- **Operands**: repository-safe name grammar, non-leading-dash, bounded UTF-8, no controls; prefer
  validated Docker IDs for inspection.
- **Ports**: integer `1..65535` for fixed published ports; protocol allowlist or bounded opaque
  value; strict address-family handling; cap or interval-normalize ranges.
- **CIDRs**: one slash, valid address, prefix `0..32` or `0..128`, same-family comparisons,
  canonical integer interval, no zone IDs, no floating-point arithmetic.
- **Volumes**: allowlisted types; bounded source/target/name; deterministic driver-option map;
  objective comparisons only. Shared writable data is not automatically incompatible.
- **JSON**: exact root and item types, bounded arrays/maps/depth/strings, duplicate rejection,
  unknown-field tolerance without copying unknown fields.
- **Output**: sort by code-point order, use stable IDs from normalized safe fields, serialize with
  `JSON.stringify`, and sanitize separately for terminal text.

Compose and daemon observation failures must never become an empty array that is interpreted as
"no conflicts." The older `getComposeServices()` and `inspectContainers()` use `[]`/`undefined`
on errors; the conflict path needs typed fail-closed results.

## Infrastructure Security

- Run validation against the active Docker context only. Do not silently fall back from a remote
  daemon to local Docker.
- Secure remote daemon access with SSH or mutually authenticated TLS. Docker notes that holders of
  client keys can control the daemon and recommends guarding them like root credentials.
- Do not scan the local host for remote-port evidence.
- Bound SSH retries and total command time. A retry must rerun the same read-only command under the
  same pinned authority.
- The existing state lock serializes cooperating rfapps commands; it is not a distributed Docker
  lock. Surface that limitation.
- Third-party network/IPAM/volume drivers may have semantics the validator cannot prove. Emit an
  advisory or unavailable result rather than applying built-in-driver assumptions.
- Docker documents that Engine rejects overlapping subnetworks and can allocate a non-overlapping
  subnet when one is not specified
  ([Docker network create reference](https://docs.docker.com/reference/cli/docker/network/create/),
  accessed 2026-07-24; continuously updated). Validate explicit subnets only.

## Secure Coding Guidelines

1. Keep a pure conflict engine separated from I/O adapters. Pure functions accept already
   validated records and cannot execute Docker or remediation.
2. Keep `shell: false`; pass static commands and separate argument arrays. Never concatenate or
   evaluate a suggested command.
3. Reuse hardened identity, canonical-path, observation, output-limit, and redaction helpers.
   Move shared protections to general names rather than duplicating weaker variants.
4. Introduce typed validation errors with stable codes. Do not place raw daemon stderr in the
   public error or `DeployResult`.
5. Make `--validate-first`, `--yes`, `--allow-partial`, dry-run, and machine formats explicit in
   tests. Both conflict and unavailable outcomes must prove zero calls to pull, start, readiness,
   database initialization, or deployment recording.
6. Fuzz or property-test CIDR parsing, port-range parsing, JSON normalization, sorting, control
   characters, duplicate keys/IDs, huge counts, and boundary values.
7. Test context/env drift by changing `PATH`, `DOCKER_HOST`, `DOCKER_CONTEXT`, daemon ID, Compose
   bytes, and env-tool output between snapshot and the mutation boundary.
8. Test remote failures, partial batches, timeouts, capture overflow, malformed JSON/JSON Lines,
   ignored `SIGTERM`, and ANSI/OSC payloads.
9. Treat conflict-result schema version, exit code, field order where promised, and stable IDs as
   compatibility/security contracts for automation.
10. Never persist raw validation inputs. If telemetry is later added, record only aggregate counts
    and safe error codes with explicit opt-in.

## Trade-offs

| Decision                                     | Security benefit                                                             | Cost / limitation                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Validate before image pull                   | A blocked preflight causes no Docker mutation, including image-cache changes | Pull time is not used to narrow the TOCTOU window                               |
| Fail closed on unavailable evidence          | `--validate-first` has honest semantics                                      | Remote outages or denied inventory block deployment                             |
| Pin environment and re-fingerprint authority | Prevents context/env substitution                                            | Requires threading a pinned execution environment through existing deploy calls |
| Narrow formatted inspect output              | Minimizes secret collection and parser surface                               | More command/type maintenance across Docker versions                            |
| Strict resource/count bounds                 | Prevents memory/CPU exhaustion                                               | Very large legitimate daemons receive a deterministic unavailable result        |
| No automatic remediation                     | Preserves authorization and avoids destructive mistakes                      | Users must make and review fixes separately                                     |
| Objective volume conflicts only              | Avoids blocking legitimate shared media/data volumes                         | Application-level unsafe concurrent writes remain undetectable                  |
| Small CIDR dependency                        | Reduces custom IPv6 correctness risk                                         | Adds supply-chain and update obligations                                        |
| Local CIDR implementation                    | No new package or transitive code                                            | More security-critical parsing code to test and maintain                        |

## Open Questions

1. Must validation and deployment use a fully pinned effective environment, or is a
   before/after Docker authority fingerprint considered sufficient for v1? Pinning is stronger.
2. What hard limits should apply to Compose bytes, command output, containers, networks, volumes,
   IPAM entries, driver options, and port ranges? These values become part of deterministic
   machine behavior.
3. Should `scope.composePath` be removed from structured output, made project-relative, or replaced
   with a non-secret fingerprint?
4. Is a shared writable bind/named volume ever blocking without an explicit repository policy such
   as `exclusive: true`? Security research recommends no.
5. Are third-party network/IPAM/volume drivers unsupported, advisory-only, or a fail-closed
   unavailable condition?
6. Should a successful validation be re-run after image pull to reduce the race? Doing so improves
   freshness but means the first validation did not prevent all Docker mutation.
7. Is a separate future remediation plan/apply workflow desired? It must not be implied by the v1
   interactive suggestions.
8. Should the hardened `getComposeContainerObservations()` pattern replace the older permissive
   `getComposeConfig()` and `inspectContainers()` paths globally, or should this feature add
   dedicated safe readers first?
9. Will CI enforce both runtime and full dependency audits, and who owns remediation of the
   current `ws` and `picomatch` advisories?
