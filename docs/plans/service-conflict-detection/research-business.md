# Service Conflict Detection: Business and Domain Research

## Executive Summary

Issue [#64](https://github.com/yandy-r/rfmedia-apps/issues/64) should add an opt-in,
read-only preflight to `rfapps deploy`: after rfapps resolves the actual deployment scope but before
pulling or starting anything, `--validate-first` compares the resolved Compose resource claims with
each other and with observable Docker runtime state. A conclusive blocking conflict stops the
deploy and explains what owns the resource, why the claims collide, and what the operator can
change manually.

The product contract must distinguish two evidence sources:

- **Desired-state conflicts** are contradictions among services and networks that this invocation
  would create or start.
- **Runtime conflicts** are collisions between that desired scope and resources already owned by a
  different running container or Docker network on the active Docker context.

That distinction prevents misleading advice. A target service's current container is normally the
resource being reconciled, not an external conflict; an unrelated container is external runtime
state. Likewise, two services sharing a named volume is supported Compose behavior, not proof of an
incompatibility. Arbitrary non-Docker processes and host routes are not visible through the current
Docker helpers, particularly for remote Docker contexts, and must not be reported as checked unless
a reliable host-side capability is added.

The safe first release should detect and report; it should not edit Compose, stop containers,
delete networks, or remap resources. Interactive mode may present ranked manual resolutions, but
`--yes`, JSON, piped input, and other non-interactive modes must never select or execute one.

## User Stories

### Self-hosting operator

- As an operator, I want a deploy to fail before image pulls or container changes when its fixed
  host port is already owned by another service.
- As an operator, I want to know whether a conflict is in my Compose intent or comes from existing
  Docker state so that I fix the correct owner.
- As an operator deploying one service or group, I want validation limited to what Compose will
  actually start, including sidecars and dependencies, so unrelated dormant configuration does not
  block me.
- As an operator, I want valid shared storage to remain valid and only evidence-backed volume
  incompatibilities to block deployment.
- As an operator, I want conflicting network names and CIDR ranges identified before Docker creates
  or attaches networks.
- As an operator, I want actionable, non-destructive suggestions such as which Compose field to
  change or which external owner to inspect.

### Automation consumer

- As CI or automation, I want a stable, versioned result with deterministic ordering and exit
  behavior so I can gate deployment without parsing prose.
- As automation, I want unavailable validation evidence to be `inconclusive`, never silently
  treated as a pass.
- As automation, I want `--dry-run --validate-first` to perform the same read-only validation as a
  real deploy while guaranteeing no pull, start, stop, state-history, or resolution mutation.
- As automation, I want `--yes` to skip confirmation only; it must not waive conflicts.

### Maintainer

- As a maintainer, I want one conflict model shared by text and structured output so presentation
  cannot change business outcomes.
- As a maintainer, I want pure normalization and comparison rules separated from Docker inventory
  collection so edge cases can be tested without a daemon.

## Business Rules

### Invocation and sequencing

1. Without `--validate-first`, deploy behavior remains unchanged.
2. With `--validate-first`, existing config validation and service resolution run first. Conflict
   validation then runs after group expansion, deduplication, sidecar expansion, profile resolution,
   and dependency-closure resolution, but before dry-run returns, confirmation, pull, start,
   readiness checks, or deployment-history writes.
3. Validation is read-only. It must not edit Compose or environment files, reserve ports, stop
   containers, disconnect or delete networks, or change volumes.
4. A blocking conflict or inconclusive required check stops the entire deploy before mutation.
   `--allow-partial` applies to outcomes after deployment begins and does not turn a failed
   preflight into a partial deploy.
5. A preflight is point-in-time evidence, not a reservation. Output should acknowledge that
   external state can change between inspection and `docker compose up`.

### Scope

1. **Requested scope** is the user's explicit service, services, group, profile, interactive
   selection, or default deployment selection.
2. **Effective scope** is every service Compose may start for that request: requested services,
   rfapps-expanded sidecars, and transitive `depends_on` or `network_mode: service:` dependencies.
3. A no-target deploy must expand `"all"` into the concrete services enabled by the resolved
   profiles. Validation must not use the string `"all"` as a resource owner.
4. Desired-state comparison includes conflicts where at least one participant is in effective
   scope. A contradiction solely between dormant, out-of-scope services does not block a targeted
   deploy.
5. Runtime comparison checks every effective claim against all relevant resources on the active
   Docker context, including resources outside the current Compose project.
6. The running instance of the same Compose project/service is classified as the current owner
   being reconciled and is not an external conflict. Identity should use Compose project/service
   labels or an equally authoritative mapping, not substring matching of container names.
7. A stopped container does not own a host port, but persistent Docker networks remain relevant to
   CIDR allocation. Persistent volumes remain relevant only under a defined incompatibility rule.

### Conflict classification

Each finding has a resource type (`port`, `volume`, or `network`), evidence source
(`desired` or `runtime`), severity (`error` or `warning`), normalized resource identity,
participants, evidence, and ordered manual resolutions.

- An `error` is a definite collision that would make the requested deploy unsafe or predictably
  fail.
- A `warning` is an evidence-backed risk that is not necessarily invalid.
- Unsupported or unavailable inspection is a check status, not an empty finding list.
- Only `error` findings block. An unavailable required desired/runtime check makes the aggregate
  status `inconclusive` and also blocks because the user explicitly requested validation.

### Port rules

1. Only host-published ports claim host resources. `expose` and image-exposed container ports do
   not conflict across ordinary bridge networks.
2. A port identity includes address family, host bind address, published port or range, and
   protocol. TCP and UDP claims are distinct.
3. Two fixed claims conflict when their protocols and published ports match and their bind
   addresses intersect. A wildcard bind intersects specific addresses in the same family.
4. Port ranges must be normalized as ranges. Two flexible ranges that overlap are not automatically
   a definite collision because Docker may allocate different free ports; exhaustion or
   insufficient capacity may be a warning.
5. An omitted published port is dynamically allocated and is not a definite desired-state
   conflict.
6. `network_mode: host` bypasses normal port publishing. Listening ports cannot be inferred from
   `expose`; validation must report this limitation rather than invent claims.
7. Existing Docker-published bindings can be inspected. A non-Docker process listening on the
   Docker host cannot be claimed as checked by the current integration, especially when the active
   Docker context is remote.

### Volume rules

1. Reusing a named volume or bind source across services is valid Docker behavior and is not, by
   itself, a conflict.
2. Different container target paths are not proof of incompatibility. Neither are mixed read-only
   and read-write mounts: mount access is per container and Docker supports both.
3. Parent/child bind paths, shared media directories, sockets, and database/data paths may be
   intentional. Heuristics may produce warnings with exact evidence, but must not block.
4. A cross-service volume conflict can be blocking only when an explicit, testable incompatibility
   predicate exists, such as a future user-declared exclusive-owner policy or a Docker-rejected
   mount definition. Image names or service names are not sufficient to infer data compatibility.
5. The original phrase “incompatible services” is therefore an unresolved product rule. The first
   implementation must not turn all shared writable storage into false positives.

### Network rules

1. CIDR comparison is performed separately for IPv4 and IPv6 using normalized address ranges.
2. Distinct, to-be-created networks with explicitly overlapping IPAM subnets are definite desired
   conflicts when both are required by effective scope.
3. A proposed explicit subnet overlapping an existing, different Docker network is a runtime
   conflict. A matching existing network that is the intended same Compose/external network is not.
4. `ip_range` must be interpreted within its parent subnet and not double-counted as a separate
   conflicting network.
5. A network with no explicit subnet uses Docker allocation; absence of a desired CIDR is unknown,
   not overlap.
6. Compose `external: true` networks are runtime-owned and should be checked for identity and
   availability, but rfapps must not act as if it will create them.
7. Host LAN, VPN, and routing-table overlaps are outside Docker network inventory. They require a
   separately designed host-side probe before they can be advertised as validated.

### Interaction and resolution

1. Human TTY output shows the conflict, owners, evidence source, and ordered manual resolutions.
2. Suggestions may identify a Compose field to change, a free-port search to perform, or a Docker
   owner to inspect/stop. They are guidance, not actions.
3. The preflight must not automatically choose “change port” because the CLI cannot safely infer
   the correct public contract, nor “stop service” because that is a separate destructive action.
4. `--yes` skips the normal deploy confirmation only. It neither suppresses validation nor accepts
   a conflict.
5. JSON/YAML/CSV and non-TTY execution never prompt. Resolution data is emitted structurally and
   the blocked deploy exits deterministically.

### Structured output and exit behavior

1. The validation result should use a stable schema version and contain scope, per-check status,
   summary, sorted conflicts, and warnings. Conflict IDs and ordering derive from normalized facts,
   not discovery order.
2. Suggested resolutions have stable kinds and parameters; automation must not parse display
   sentences.
3. With structured output, deploy emits one document. A successful preflight is embedded with the
   eventual deploy result; a blocked or inconclusive preflight emits the validation result without
   an empty or misleading deploy-success object.
4. `pass` followed by a successful deploy exits `0`. A blocking conflict or inconclusive required
   check exits `1` as an operational failure. Invalid flag/scope/config input remains exit `2`.
5. `--dry-run --validate-first` returns `0` only when the proposed deploy passes; a blocked or
   inconclusive preview returns `1` while performing no mutation.

## Workflows

### Passing preflight

1. Load configuration and resolve the Compose file, environment, targets, sidecars, profiles, and
   dependency closure.
2. Obtain the fully resolved Compose model and observable Docker runtime inventory.
3. Normalize desired and runtime port, volume, and network claims.
4. Compare claims, sort results, and produce `pass`.
5. In dry-run mode, append the deploy preview and stop without mutation.
6. Otherwise, continue through the existing confirmation and deploy paths.

### Desired-state conflict

1. Two effective services claim the same fixed host port, or two required new networks overlap.
2. rfapps records a `desired` error naming both participants and their Compose evidence.
3. It reports non-destructive edits the operator may make.
4. The command exits `1` before pull, prompt, Docker mutation, or state-history write.

### Runtime conflict

1. An effective claim collides with a different running container or existing Docker network.
2. rfapps records a `runtime` error with authoritative owner identity.
3. The operator is told how to inspect the owner and which desired field could be changed.
4. rfapps does not stop, remove, or disconnect the owner; the user fixes state and reruns.

### Inconclusive validation

1. Resolved Compose parsing, Docker inventory, or a required normalization check fails.
2. Completed checks and any findings are preserved; the failed check is marked `failed` or
   `unsupported` with a reason.
3. The aggregate result is `inconclusive`, not `pass`.
4. The deploy is blocked with retry/configuration guidance and exit `1`.

### Interactive presentation

1. A TTY receives a concise conflict summary followed by evidence and ranked options.
2. Options explain manual remediation or abort; they do not mutate resources.
3. After remediation, the operator reruns the command so all evidence is freshly collected.

## Domain Model

- **Validation run**: One read-only preflight bound to a resolved Compose invocation and Docker
  context snapshot.
- **Requested scope**: What the user selected.
- **Effective scope**: Concrete services and networks the deploy may create/start after all
  expansion.
- **Resource claim**: A normalized desired or runtime assertion over a host port, storage source,
  or network address range.
- **Participant**: A Compose service, running container, Compose network, Docker network, or
  explicitly unknown host owner.
- **Conflict**: Two incompatible claims with source, severity, evidence, and stable identity.
- **Check result**: `passed`, `failed`, or `unsupported` status for one inventory/comparison lane.
- **Resolution**: Typed, advisory operator guidance; never implicit authorization to mutate.
- **Aggregate status**: `pass`, `blocked`, or `inconclusive`.

The important transition is:

```text
requested
  -> scope-resolved
  -> desired/runtime-inspected
     -> pass ---------> dry-run preview or existing deploy workflow
     -> blocked ------> report + exit 1, no mutation
     -> inconclusive -> report + exit 1, no mutation
```

## Existing Codebase Integration

- `packages/rfapps-cli/src/cli.ts` owns the `deploy` command surface and exit-code help. It is the
  entry point for `--validate-first`.
- `packages/rfapps-cli/src/actions/deploy.ts` currently performs config consistency validation
  before target resolution, then resolves targets/sidecars/profiles before dry-run, confirmation,
  pull, and start. The conflict gate belongs after resolution and before the dry-run branch.
- `packages/rfapps-cli/src/lib/interactive-selection.ts` defines requested-service, group,
  sidecar, and profile expansion. It does not currently compute transitive Compose dependencies,
  which matter because `docker compose up SERVICE` may start them.
- `packages/rfapps-cli/src/lib/validation.ts` already exists despite the issue's historical note
  calling it new. It parses only service names and validates rfapps mappings; its cache does not
  retain ports, volumes, or top-level networks. Conflict results should not be squeezed into its
  existing `ValidationWarning` contract.
- `packages/rfapps-cli/src/lib/docker.ts` already provides resolved
  `docker compose config --format json`, container listing/inspection, and project service maps.
  Its `ComposeConfig` type currently omits service volumes and top-level network/IPAM definitions,
  while `ContainerInspect` exposes port binds and basic network membership but no Docker-network
  IPAM inventory.
- `packages/rfapps-cli/src/lib/drift.ts` and `plan-generator.ts` contain short/long port and volume
  parsers, but their models discard host bind addresses and some range semantics. They are useful
  precedents, not sufficient conflict normalizers.
- `packages/rfapps-cli/src/types/options.ts` owns `DeployOptions`; a validation flag and stable
  conflict result types should be represented there or in the issue's proposed
  `types/validation.ts`.
- `packages/rfapps-cli/src/lib/formatters/index.ts` and `@rfmedia/common` define one stdout
  document for JSON/YAML/CSV and classify machine formats. Conflict progress/prose must not leak
  into machine stdout.
- `packages/rfapps-cli/src/lib/exit-codes.ts` defines `0`, `1`, `2`, and opt-in partial `3`.
  Preflight conflicts fit operational error `1`; they are not partial deployment outcomes.
- `packages/rfapps-cli/src/actions/deploy.spec.ts` and `cli.deploy.integration.spec.ts` are the
  primary seams for proving placement before pull/start, dry-run purity, output parity, and exit
  behavior across sequential and parallel deploys.

One existing gotcha should be addressed or explicitly preserved: unlike newer doctor/audit paths,
deploy only applies a CLI profile override when `isValidProfile()` succeeds and otherwise silently
falls back. Conflict scope must not validate one profile while deployment uses another.

## Success Criteria

1. `deploy --validate-first` performs all checks after effective scope resolution and before every
   Docker or state mutation in sequential and parallel paths.
2. Tests distinguish desired conflicts, external runtime conflicts, current target ownership,
   warnings, and inconclusive checks.
3. Port tests cover TCP/UDP, wildcard/specific binds, IPv4/IPv6, fixed ports, dynamic ports, ranges,
   target self-reconciliation, and unrelated runtime owners.
4. Network tests cover desired CIDR overlap, live Docker-network overlap, same intended network,
   external networks, auto-assigned networks, `ip_range`, and both address families.
5. Volume tests prove that ordinary named-volume reuse, shared binds, and mixed `ro`/`rw` access do
   not become false blocking conflicts.
6. Target tests cover a service, comma-separated services, group, profile/default all, interactive
   selection, sidecar expansion, and transitive dependencies.
7. A blocked or inconclusive preflight performs no pull, start, stop, network/volume mutation,
   readiness check, or deployment-history write and exits `1`.
8. `--dry-run` performs the same validation and remains mutation-free. `--yes` never waives a
   conflict. Machine and non-TTY modes never prompt.
9. JSON has a versioned schema, one stdout document, stable conflict IDs/order, typed resolutions,
   explicit check status, and the same facts as text output.
10. Existing deploy behavior, output, and exit codes remain unchanged when the flag is absent.

## Open Questions

1. What exact cross-service predicate makes a volume “incompatible”? Compose intentionally permits
   shared volumes, and the issue provides no ownership policy.
2. Is arbitrary non-Docker host-process port detection required? If so, how will it run against the
   actual Docker host for SSH/remote contexts without platform-specific commands or elevated access?
3. Should host routing-table/LAN/VPN overlap be part of network validation, or is Docker-network
   IPAM inventory the first-release boundary?
4. Should warnings ever block, or should only definite errors and inconclusive required checks do
   so? A threshold flag is not in the issue.
5. Does “interactive conflict resolution” require future opt-in mutations? Editing Compose and
   stopping external services require separate authorization, rollback, and ownership designs.
6. What stable schema name should be adopted, and should successful validation wrap the existing
   `DeployResult` or add a backward-compatible optional `validation` field?
7. Should validation retry inventory once immediately before `compose up` to narrow the
   time-of-check/time-of-use window?

## Relevant Documentation

- [Issue #64](https://github.com/yandy-r/rfmedia-apps/issues/64)
- [Docker Compose service ports and volumes](https://docs.docker.com/reference/compose-file/services/)
- [Docker Compose networks and IPAM](https://docs.docker.com/reference/compose-file/networks/)
- [Docker Compose networking and external networks](https://docs.docker.com/compose/how-tos/networking/)
- [JSON output](../../features/json-output.md)
- [Dry-run mode](../../features/dry-run-mode.md)
- [Error handling and exit codes](../../features/error-handling.md)
