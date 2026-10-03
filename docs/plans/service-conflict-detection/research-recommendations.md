# Service Conflict Detection: Implementation Recommendations

## Executive Summary

Implement issue [#64](https://github.com/yandy-r/rfmedia-apps/issues/64) as an opt-in,
read-only, fail-closed preflight gate inside `rfapps deploy`. When `--validate-first` is present,
rfapps should resolve the exact Compose model and effective deployment scope, take one bounded
snapshot of the active Docker authority, normalize desired and runtime resource claims, and return
one deterministic result before confirmation, image pull, container start, readiness checks, or
state writes.

Version one should detect only conflicts supported by objective evidence:

- fixed published-port collisions between effective services or with other running Docker
  containers;
- contradictory named-volume definitions and duplicate mount targets within one service; and
- overlapping explicit Docker network IPAM subnets.

Shared storage, non-Docker host listeners, host-network application sockets, host LAN/VPN routes,
and daemon-assigned ports/subnets must not be presented as conclusively validated. Ordinary shared
volumes are valid Docker behavior, so volume-sharing heuristics may be warnings but must not block
without an explicit exclusivity policy.

The preflight has three outcomes: `passed`, `blocked`, and `inconclusive`. Both `blocked` and
`inconclusive` exit `1` without mutation. `--yes` does not waive validation,
`--allow-partial` does not apply before deployment begins, and `--dry-run --validate-first`
performs the same fresh checks while remaining mutation-free. Interactive “resolution” in version
one means ranked, inert manual guidance; it must never edit Compose, stop a container, or remove a
network or volume.

## Implementation Recommendations

### 1. Freeze the product contract before writing detectors

Adopt one vocabulary across text, structured output, tests, and documentation:

| Concept          | Recommended contract                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| Aggregate status | `passed`, `blocked`, `inconclusive`                                                                |
| Finding severity | `error`, `warning`                                                                                 |
| Evidence origin  | `desired`, `runtime`                                                                               |
| Resource kind    | `port`, `volume`, `network`                                                                        |
| Blocking policy  | Definite `error` findings and incomplete required checks block                                     |
| Exit status      | `0` pass, `1` blocked/inconclusive, `2` usage/config arguments, `3` only post-start partial deploy |
| Remediation      | Typed advisory data; never executable authorization                                                |

Use `conflict-validation.v1` as the initial schema version. Include stable codes, per-check status,
scope, counts, findings, limitations, and ordered resolutions. Omit timestamps and durations from
the contractual validation block so identical inputs can produce identical JSON.

Recommended top-level validation fields:

- `schemaVersion`;
- `status`;
- `scope` with sorted effective services, profiles, display-safe Compose path, and project name;
- `checks` for Compose, containers, volumes, and networks, each with explicit completion status;
- `summary`;
- sorted `conflicts`, `warnings`, and `limitations`;
- a sanitized, stable `error` object for an inconclusive run.

Keep `validation` optional on `DeployResult` and include it only when the flag was supplied. A
blocked structured response should still be an unambiguous deploy result with `started: 0`, a
stable validation failure entry, and the validation object; it must not resemble an empty success.
The dry-run payload should similarly include `dryRun: true` and the same validation object.

### 2. Resolve one authoritative desired model and effective scope

Continue running `validateConfigAgainstCompose()` first for existing rfapps mapping errors. Do not
merge runtime conflict detection into `lib/validation.ts`: that module parses and caches raw YAML
for reference validation and has a different contract.

After `resolveServicesWithInteractive()` returns:

1. Resolve Compose through `docker compose config --format json` using the final Compose path,
   environment file, profiles, working directory, environment tool, and Docker context.
2. Validate the returned external JSON into a narrow internal model immediately; do not retain or
   log unrelated environment, secret, or label fields.
3. Expand the effective service scope to include transitive `depends_on` and
   `network_mode: service:` dependencies. Existing interactive resolution expands groups and
   sidecars but does not compute this closure.
4. When the current empty service array means “all,” replace it with the concrete active-profile
   service names before conflict comparison and output.
5. Include only networks and volumes referenced by the effective services, except when daemon-wide
   runtime inventory is needed as the opposing owner.

The gate belongs immediately after this scope resolution and before the current dry-run branch.
Placing it above the parallel/sequential split guarantees identical safety behavior in both paths.

Fix or explicitly reject invalid `--profile` values rather than silently omitting the override.
The validator and deploy must never operate with different effective profiles.

### 3. Use a narrow snapshot-normalize-compare architecture

Use three boundaries rather than a generic rules framework:

1. **Evidence adapter**: extend `lib/docker.ts` with typed, bounded, read-only readers for the
   resolved Compose model, running containers, Docker networks, and named volumes.
2. **Pure evaluator**: create a dedicated `lib/service-conflicts.ts` or
   `lib/conflict-validation.ts` containing normalization, comparison, stable IDs, ordering, and
   resolution construction. It performs no I/O, logging, prompting, persistence, or process-exit
   changes.
3. **Deploy orchestration and presentation**: `actions/deploy.ts` invokes the adapter/evaluator,
   renders the typed result, maps the exit code, and returns before all mutation on failure.

Inject evidence functions into the orchestration seam so unit tests do not require Docker. Render
human and machine output from the same result; do not implement separate detection paths.

### 4. Harden Docker evidence collection

Reuse the existing `execDocker()` and `execDockerCompose()` argument-array transport. It already
preserves environment-tool wrapping, SSH retry behavior, timeouts, capture limits, and test seams.
Do not add `dockerode`, direct socket access, shell command strings, or local host scanners.

Add dedicated readers rather than reusing permissive helpers that return `undefined` or `[]` on
parse failure. The conflict path must distinguish an empty inventory from failed, truncated,
malformed, or unsupported evidence.

For each reader:

- list validated Docker IDs, then inspect them in fixed-size batches;
- request/project only required fields;
- cap bytes, item counts, field lengths, port intervals, IPAM entries, and driver options;
- reject leading-option operands, NULs, controls, unsafe Unicode, duplicates, and invalid types;
- sort after collection rather than relying on daemon iteration order;
- return a typed unavailable reason instead of a partial pass;
- sanitize terminal text, including ANSI/OSC and bidi/control sequences;
- never expose raw stderr, resolved environment values, absolute credential paths, or full inspect
  objects, even under `--debug`.

Reuse the hardened patterns around `SAFE_COMPOSE_OPERAND`,
`getComposeContainerObservations()`, `resolveComposeProjectIdentity()`,
`dockerAuthorityFingerprint()`, `captureEffectiveEnvironment()`, and
`redactManagedMessage()` rather than cloning older permissive behavior.

For a real deploy, capture a resolved-model fingerprint and Docker-authority fingerprint during
preflight and verify both immediately before the first mutation. The existing global state lock
serializes cooperating rfapps mutations, but it does not prevent direct Docker clients or remote
actors from racing. Keep the result explicitly described as point-in-time evidence and let Docker
remain the final allocation authority.

### 5. Apply conservative, explicit conflict rules

#### Ports

- Inspect only host-published ports; ignore `expose`.
- Preserve protocol, address family, host bind address, published port/range, and allocation mode.
- TCP and UDP do not conflict with one another.
- Within one address family, wildcard binds intersect every specific address; distinct specific
  addresses may reuse a numeric port.
- Skip target-only or explicitly daemon-assigned published ports as definite claims and emit a
  limitation where useful.
- Treat a fixed one-to-one range as fixed reservations without unbounded expansion.
- Treat a single-target published range as a choice pool: block only when no compatible member
  remains, not when one member is occupied.
- Exclude only running containers authoritatively identified by Compose project/service labels as
  the effective service being reconciled. Do not use name substrings.
- Do not infer application listeners for `network_mode: host`.
- Do not claim coverage of non-Docker host processes, especially for remote contexts or Docker
  Desktop.

Candidate free ports may be suggested deterministically from the captured snapshot, but they must
be labeled point-in-time suggestions rather than reservations.

#### Volumes

Block only objective incompatibilities in version one:

- two desired top-level volume keys resolve to the same effective Docker volume name but specify
  different normalized drivers or driver options;
- a non-external desired named volume conflicts with an existing Docker volume's driver/options;
- one service maps different sources or mount types to the same container target.

Normalize omitted named-volume drivers to `local` and omitted options to an empty sorted map.
For `external: true`, verify identity/existence without pretending Compose owns its driver
configuration.

Do not block merely because services share a named volume or bind source, use different container
targets, mix read-only/read-write access, or mount parent/child paths. Shared-writer or parent/child
heuristics should be deferred or emitted only as clearly non-blocking warnings. Avoid printing
absolute bind sources in normal output; use a bounded display label or one-way identifier if an
identity is necessary.

#### Networks

- Compare explicit top-level `ipam.config[].subnet` values only.
- Compare IPv4 with IPv4 and IPv6 with IPv6 using canonical integer intervals.
- Detect desired-versus-desired and desired-versus-existing-Docker-network overlap.
- Deduplicate each effective network and exclude the existing network with the same effective
  runtime identity that Compose intends to reuse.
- Treat `ip_range` as subordinate to its parent subnet, not as a second network claim.
- Verify external-network identity/existence without treating it as a new Compose-owned pool.
- Do not invent claims for auto-assigned networks or advertise host LAN/VPN route coverage.
- Treat invalid explicit CIDRs and incomplete required network evidence as inconclusive.

Third-party network/IPAM driver behavior should be reported as unsupported or advisory unless its
semantics are known. Built-in Docker subnet overlap rules must not be generalized to every plugin.

### 6. Keep interaction advisory and output deterministic

Text output should lead with the decision, then show every finding in stable order:

1. canonical resource;
2. requested and conflicting owners;
3. exact incompatibility;
4. ranked manual resolutions, with desired-side changes first; and
5. an explicit statement that nothing was pulled or changed.

Never offer “continue anyway.” `--yes` skips only the normal post-pass confirmation. Machine,
non-TTY, and piped execution never prompts. Preserve textual `PASS`, `ERROR`, `WARNING`, and
resource-kind labels so meaning does not depend on color.

Sort services, profiles, checks, conflicts, parties, resolutions, and limitations. Construct
conflict IDs from normalized resource keys and sorted party identities, not discovery order.
Structured resolutions should use stable action enums and parameters; automation must not parse
display prose.

Support JSON and YAML nested results directly. For version one, either define and test a flattened
one-row-per-finding CSV schema or reject `--output csv --validate-first` with a usage error. The
lower-risk recommendation is to reject that combination until a stable flattening contract is
approved. Table mode can use the human renderer.

### 7. Test behavior, not only detector examples

Required test layers:

- **Pure unit tests**: table-driven port/address/protocol/range cases; volume identity and
  non-conflict cases; IPv4/IPv6 containment, equality, adjacency, and malformed CIDRs; stable
  sorting/IDs; safe suggestion bounds; control characters and oversized inputs.
- **Docker adapter tests**: exact argument arrays, projected fields, batching, environment/context
  propagation, timeouts, malformed/partial JSON, capture overflow, duplicate IDs, and caps.
- **Deploy action tests**: pass, block, inconclusive, dry-run, `--yes`, `--allow-partial`, machine
  formats, sequential/parallel selection, all/group/profile/sidecar/dependency scope, and
  self-reconciliation.
- **Real CLI harness tests**: prove exit `1` and the absence of pull, `up`, readiness, database
  creation, or state recording for a blocker. Extend `testing/mock-docker.ts` builders rather than
  embedding large untyped JSON fixtures.
- **Completion tests**: derive deploy options from Commander and require exact Bash, Zsh, and Fish
  parity.

The CLI entry point executes at module load, so use the existing subprocess harness for full CLI
behavior instead of importing `cli.ts` into unit tests.

### Relevant Code and Documentation

- `packages/rfapps-cli/src/cli.ts`: deploy option registration, output mode, exit help, and global
  state-lock acquisition.
- `packages/rfapps-cli/src/actions/deploy.ts`: target resolution and the single gate before dry-run,
  confirmation, parallel/sequential mutation, readiness, and state persistence.
- `packages/rfapps-cli/src/lib/docker.ts`: Docker/Compose transport, resolved model, existing
  permissive inspection helpers, and hardened observation precedents.
- `packages/rfapps-cli/src/lib/interactive-selection.ts`: requested target, group, sidecar, and
  profile expansion; currently lacks dependency closure.
- `packages/rfapps-cli/src/lib/dependency-graph.ts`: `depends_on` and
  `network_mode: service:` extraction patterns.
- `packages/rfapps-cli/src/lib/identity.ts`: canonical Compose identity and Docker authority
  fingerprints.
- `packages/rfapps-cli/src/lib/env-tools.ts`: effective-environment capture.
- `packages/rfapps-cli/src/lib/validation.ts`: existing static mapping validator; preserve its
  responsibility.
- `packages/rfapps-cli/src/lib/security-audit.ts` and `src/types/audit.ts`: pure, typed, sorted
  finding/result precedent.
- `packages/rfapps-cli/src/types/options.ts` and `src/types/results.ts`: public deploy contracts.
- `packages/rfapps-cli/src/actions/completion.ts`: Bash/Zsh/Fish templates with existing deploy
  parity drift.
- `packages/rfapps-cli/src/testing/cli-harness.ts`,
  `packages/rfapps-cli/src/testing/mock-docker.ts`, and
  `packages/rfapps-cli/src/cli.deploy.integration.spec.ts`: subprocess integration seams.
- [Docker Compose config](https://docs.docker.com/reference/cli/docker/compose/config/),
  [service ports](https://docs.docker.com/reference/compose-file/services/#ports),
  [volumes](https://docs.docker.com/reference/compose-file/volumes/), and
  [networks/IPAM](https://docs.docker.com/reference/compose-file/networks/#ipam): canonical desired
  model and resource semantics.
- [Docker inspect](https://docs.docker.com/reference/cli/docker/inspect/),
  [network inspect](https://docs.docker.com/reference/cli/docker/network/inspect/), and
  [volume inspect](https://docs.docker.com/reference/cli/docker/volume/inspect/): runtime evidence.

## Technology Choices

| Concern          | Choice                                                                   | Rationale                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose parsing  | Existing `docker compose config --format json`                           | Reflects merge, interpolation, profiles, extensions, paths, and short-form expansion; raw YAML cannot reproduce this reliably.                                                                                                           |
| Docker transport | Existing `execDocker`/`execDockerCompose` with dedicated bounded readers | Preserves contexts, SSH, environment tools, retries, argument-array safety, and testability.                                                                                                                                             |
| Conflict engine  | Pure TypeScript functions over discriminated unions                      | Keeps policy deterministic, unit-testable, and independent of Docker or terminal behavior.                                                                                                                                               |
| Runtime API      | Docker CLI, not `dockerode` or direct Engine socket                      | Avoids a second transport, context/TLS/SSH negotiation, dependency, and mock surface.                                                                                                                                                    |
| Port math        | Local interval and address-family normalization                          | Small, policy-specific domain; avoid expanding large ranges.                                                                                                                                                                             |
| CIDR math        | Prefer reviewed `ipaddr.js` for full IPv4/IPv6 v1                        | Compressed IPv6, mapped forms, prefix validation, and canonicalization are security-sensitive and easy to implement incorrectly. Wrap it behind a tiny internal interface and verify the lockfile, license, integrity, and audit result. |
| Volume policy    | Local objective rules over canonical Compose/runtime fields              | No library can infer application-level compatibility; shared use is legal by default.                                                                                                                                                    |
| Result format    | Versioned nested validation object inside existing deploy output         | Preserves the current envelope while giving automation stable facts and one stdout document.                                                                                                                                             |
| Persistence      | None                                                                     | A preflight is ephemeral and must not appear as a deployment attempt or persist sensitive topology.                                                                                                                                      |

If adding `ipaddr.js` is rejected, do not silently implement partial IPv6 behavior. Either own a
fully tested `BigInt` IPv4/IPv6 interval parser or make unsupported IPv6 evidence explicitly
inconclusive. The current lockfile advisory findings for `ws` and `picomatch` should be tracked and
refreshed independently; they do not justify adding a Docker SDK or delaying this feature.

## Phasing and Quick Wins

### Phase 0: Contract decisions

- Approve statuses, error/finding codes, schema version, sorting, exit behavior, limitations, and
  volume blocking policy.
- Decide IPv6 implementation, CSV behavior, resource caps, and third-party driver policy.
- Capture representative resolved Compose and Docker payload fixtures.

This phase prevents expensive churn across detectors, formatters, and integration snapshots.

### Phase 1: Pure contracts and evaluator

- Add validation types and schema constant.
- Implement validated desired/runtime projections, port/volume/network normalization, pure
  detection, stable IDs/order, and typed suggestions.
- Add exhaustive unit tests, including cases that must _not_ conflict.

This work does not need a daemon and can proceed in parallel with Phase 2 once contracts are fixed.

### Phase 2: Hardened evidence adapters

- Extend the Compose types to reflect canonical long-form ports, mounts, top-level volumes, and
  network IPAM.
- Add bounded container/network/volume readers and authoritative project/service identity.
- Add context/input fingerprints and adapter failure codes.
- Add adapter unit tests for limits, malformed data, and environment propagation.

### Phase 3: Deploy gate and presentation

- Register `--validate-first` and parse it into `DeployOptions`.
- Compute effective dependency closure.
- Invoke preflight before dry-run/confirmation and above the execution-path split.
- Render deterministic text and structured output, attach pass evidence to the eventual result,
  and return with exit `1` on blocked/inconclusive.
- Verify the authority/input fingerprint before the first mutation.

### Phase 4: End-to-end parity and documentation

- Extend the CLI harness and mock Docker for representative desired/runtime conflicts.
- Prove zero mutation/state writes for every failure mode.
- Update Bash, Zsh, and Fish completion templates and enforce exact Commander parity. Include the
  already-missing deploy `--allow-partial` while splitting combined deploy/rebuild option blocks.
- Document coverage boundaries, point-in-time behavior, exit codes, schema, and manual remediation.
- Run typecheck, focused and full rfapps tests, coverage, build, completion parity, integration
  tests, and dependency audits.

### Quick wins

- Add explicit invalid-profile rejection, avoiding validator/deploy scope divergence.
- Introduce a stable schema constant and deterministic comparator before any I/O.
- Extend typed test fixture builders early; this lowers the cost of every later integration case.
- Add exact completion parity assertions so future deploy flags cannot drift by shell.
- Document that shared volume use is legal and non-Docker listeners are outside v1 coverage.

Do not merge a flag that performs no validation as a standalone quick win; preserve an atomic
user-visible contract.

## Improvement Ideas and Future Enhancements

- Add a read-only `rfapps validate conflicts` command that reuses the pure engine without implying
  deploy consent.
- Reuse the validator from `plan`, `apply`, `rebuild`, or read-only MCP tools after the deploy
  contract stabilizes.
- Add a non-mutating interactive “show details” or “re-check” loop. Reloading edited Compose input
  should restart authorization rather than continue an old deploy.
- Add explicit user-declared volume ownership/exclusivity policy, with allowlists for known shared
  media paths, before introducing stricter application-level checks.
- Add an explicitly labeled local-only host-listener provider only if local Docker contexts can be
  proven reliably. Never use a client-local probe for remote Docker.
- Add optional host route/LAN/VPN overlap diagnostics through a separate provider with clear
  authority and platform support.
- Generalize robust Compose port/mount normalizers for plan and drift only after feature-local
  behavior is proven compatible.
- Add aggregate-only, opt-in telemetry for stage durations and safe reason codes before setting a
  latency objective.
- Design any future remediation as a separate plan/apply workflow with resource ownership checks,
  fresh validation, explicit confirmation, narrow actions, and rollback evidence.
- Consider requiring `--yes` for all real machine-format deploys as a separate compatibility
  change; do not smuggle that global policy change into issue #64.

## Risk Assessment

| Risk                                                          | Likelihood          | Impact | Mitigation                                                                                                                        | Residual risk                                                   |
| ------------------------------------------------------------- | ------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| False volume blockers stop valid media-stack deploys          | High without policy | High   | Block only driver/options, external identity, or same-service duplicate-target contradictions; warnings otherwise                 | Application-level concurrent-write hazards remain undetected    |
| Validator excludes a dependency Docker will start             | Medium              | High   | Compute and display transitive Compose dependency closure from the resolved model                                                 | Compose/Engine behavior may evolve                              |
| Current target is misclassified as an external port owner     | Medium              | High   | Match effective Compose project and service labels; test scaled replicas and explicit container names                             | Malformed/missing third-party labels can remain ambiguous       |
| Docker or Compose authority changes after validation          | Medium              | High   | State lock, pinned inputs where practical, resolved-model and daemon-authority fingerprints before mutation                       | Direct external clients can still race                          |
| Secrets/topology leak through resolved config or inspect      | Medium              | High   | Narrow projections, ephemeral data, allowlisted result fields, sanitized bounded errors, no raw debug payloads                    | Resource names may still be sensitive operational metadata      |
| Malformed or oversized daemon output causes denial of service | Medium              | High   | Command-specific byte/count limits, ID batching, interval math, strict external-data validation, deterministic unavailable result | A child ignoring termination exposes a shared runner limitation |
| Incomplete inspection is interpreted as a pass                | Medium              | High   | Typed check statuses and fail-closed aggregate `inconclusive`                                                                     | Opt-in validation may reduce availability during daemon outages |
| Home-grown IPv6 CIDR math is subtly wrong                     | Medium              | High   | Use a reviewed focused parser or exhaustive property/fuzz tests                                                                   | Dependency or maintenance risk remains                          |
| Non-Docker listener or host route is missed                   | High                | Medium | State explicit Docker-only limitations; do not use misleading “all clear” language                                                | Docker may still fail at final allocation                       |
| Determinism breaks across daemon order or messages            | Medium              | Medium | Canonical normalized keys, sorted copies, stable enums/IDs, no clock fields                                                       | Additive schema evolution still requires consumer discipline    |
| Remote-context validation is slow                             | Medium              | Medium | One fresh snapshot, concurrent independent reads, batching, visible human progress, stage timeouts                                | No justified latency SLO exists yet                             |
| Completion/docs drift from Commander                          | Existing issue      | Medium | Exact Bash/Zsh/Fish parity derived from the registered command                                                                    | Generated templates remain maintenance-sensitive                |
| New dependency inherits a supply-chain issue                  | Low to medium       | Medium | Minimize dependencies, pin/review integrity and license, run runtime/full audits                                                  | Future advisories remain possible                               |
| Suggestions are mistaken for authorization                    | Medium              | High   | Inert typed suggestions, cautious wording, no generated-command execution, no continue-anyway path                                | Operators may still manually choose a disruptive action         |

## Alternative Approaches

| Approach                                                         | Pros                                                                                 | Cons                                                                                                                   | Effort                         | Recommendation                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------- |
| Resolved Compose + bounded Docker snapshot + pure evaluator      | Faithful desired state, remote-context support, deterministic tests, clear authority | More typed adapter work; unavoidable point-in-time race                                                                | Medium-high                    | **Recommended**                                    |
| Parse raw Compose YAML and compare statically                    | Few Docker calls; superficially simple                                               | Incorrect for interpolation, profiles, extensions, names, includes, and canonical short syntax; no runtime owners      | Medium once edge cases surface | Reject                                             |
| Depend on normal `docker compose up` failure                     | No new detector                                                                      | Detects too late, may pull/mutate first, poor structured explanations, misses desired aggregate reporting              | Low                            | Reject                                             |
| Add `dockerode` or direct Engine API access                      | Rich typed API and fewer CLI parse steps                                             | Duplicates context/SSH/TLS/env behavior, adds dependency and mock surface, risks authority divergence                  | High                           | Reject for v1                                      |
| Probe host sockets with Node, `ss`, `lsof`, or platform commands | Can find some non-Docker listeners locally                                           | Wrong for remote contexts/Desktop VMs, platform-specific, privilege-sensitive, temporarily claims sockets, still races | High                           | Defer to explicit local-only provider              |
| Build a pip-style solver/backtracker                             | Could rank multiple candidate configurations                                         | There is no universally correct port/volume/network rewrite; large complexity and authorization risk                   | Very high                      | Reject                                             |
| Automatically edit Compose or stop/remove owners                 | Fast apparent recovery                                                               | Destructive, changes public contracts, may affect unrelated workloads, requires rollback and new authorization         | Very high                      | Reject                                             |
| Add only a standalone validation command                         | Clean read-only surface and reusable engine                                          | Does not satisfy the issue's pre-deploy gate; can drift from deploy scope                                              | Medium                         | Future complement, not replacement                 |
| IPv4-only local CIDR parser                                      | Small and dependency-free                                                            | IPv6 becomes incomplete; silent omission would make validation unsafe                                                  | Low-medium                     | Accept only with explicit inconclusive IPv6 policy |
| Reviewed `ipaddr.js` wrapper                                     | Strong IPv4/IPv6 correctness with no transitive runtime dependencies                 | Adds supply-chain and lockfile obligations                                                                             | Low-medium                     | Preferred if IPv6 is required in v1                |

## Task Breakdown Preview

| Task                                                  | Primary files                                                                   | Depends on                 | Parallelism                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------- |
| 1. Approve contract and limits                        | Planning artifact, validation types draft                                       | None                       | Blocking foundation                                |
| 2. Add versioned validation types                     | `types/validation.ts`, `types/index.ts`, `types/options.ts`, `types/results.ts` | Task 1                     | Can start with fixture design                      |
| 3. Implement pure resource normalization/detection    | New conflict library and unit spec                                              | Task 2                     | Parallel with Task 4                               |
| 4. Implement bounded Docker/Compose snapshot adapters | `lib/docker.ts`, `lib/docker.spec.ts`                                           | Task 2                     | Parallel with Task 3                               |
| 5. Implement effective dependency closure             | Selection/dependency helper and specs                                           | Task 2                     | Parallel with Tasks 3 and 4                        |
| 6. Implement text/structured renderers                | Conflict library/formatter specs                                                | Tasks 2 and 3 result shape | Parallel with late Task 4                          |
| 7. Wire deploy gate and exit behavior                 | `cli.ts`, `actions/deploy.ts`, action specs                                     | Tasks 3-6                  | Sequential integration point                       |
| 8. Add CLI integration scenarios                      | Harness, mock Docker, deploy scenarios/spec                                     | Tasks 4 and 7              | Parallel by conflict kind once harness shape lands |
| 9. Restore completion parity                          | Completion action/spec                                                          | Task 7 flag shape          | Parallel with Task 8                               |
| 10. Update README and feature documentation           | rfapps README/docs                                                              | Tasks 1 and 7 behavior     | Parallel with Tasks 8-9                            |
| 11. Verification and security closeout                | Typecheck, build, tests, coverage, audits, deterministic snapshots              | Tasks 7-10                 | Final gate                                         |

Suggested ownership boundaries for parallel implementation:

- one worker owns public contracts and the pure evaluator;
- one owns Docker evidence adapters and their tests;
- one owns scope closure and deploy orchestration after the contracts settle;
- one owns integration fixtures, completions, and documentation after the CLI surface settles.

Avoid simultaneous edits to `actions/deploy.ts`, `lib/docker.ts`, or `actions/completion.ts`.

## Key Decisions Needed

1. **Volume incompatibility**: approve objective driver/options and duplicate-target blockers only,
   or define an explicit exclusivity policy. Do not infer incompatibility from service names.
2. **IPv6**: require full v1 support and approve a reviewed `ipaddr.js` dependency, or make IPv6
   explicitly inconclusive. Silent omission is not acceptable.
3. **Published ranges**: approve interval/choice-pool semantics and hard bounds.
4. **Aggregate schema**: settle `passed`/`blocked`/`inconclusive`, per-check statuses, warning
   behavior, stable codes, and whether the blocked result uses the existing deploy envelope.
5. **CSV**: approve a flattened schema or reject the new flag with CSV in v1.
6. **Effective scope**: confirm selected services plus sidecars and transitive Compose dependencies,
   with concrete active-profile services replacing the `"all"` sentinel.
7. **Runtime authority**: approve daemon-wide running-container and persistent-network inspection,
   same-project/service self-exclusion, and pre-mutation authority/input fingerprint recheck.
8. **Third-party drivers**: choose unsupported/inconclusive versus advisory behavior for unknown
   network, IPAM, and volume drivers.
9. **Resource limits**: set deterministic byte, object, batch, field, IPAM, and range caps.
10. **Interactive acceptance**: confirm that numbered manual guidance satisfies “interactive
    conflict resolution” for v1; all mutation remains separate.

## Open Questions

1. Should a successful real deploy include the full empty validation evidence or only its summary?
   The recommended machine contract includes the full requested result.
2. Should candidate ports/subnets be emitted in v1, or only the exact Compose field to review?
3. Should non-blocking shared-writer or parent/child bind warnings be omitted initially to reduce
   false alarms and host-path exposure?
4. How should scaled replicas of the same selected Compose service be represented and excluded
   from self-conflict checks?
5. Does an external named volume/network that is missing make validation `blocked` or
   `inconclusive`? A stable distinction should reflect whether evidence proves invalid intent or
   inspection could not complete.
6. Should table mode use the text renderer, or is a stable tabular finding schema required?
7. Should a future `rfapps validate conflicts` command be prioritized immediately after deploy, or
   wait until field experience stabilizes the schema?
8. Should the shared Docker runner gain terminate-then-kill escalation in this issue, or be tracked
   as a focused hardening follow-up while feature-specific commands remain tightly bounded?
9. Who owns remediation and CI enforcement for the currently observed `ws` and `picomatch`
   advisories?
10. What evidence and UX threshold would justify expanding beyond Docker-owned ports and explicit
    Docker IPAM in a future release?
