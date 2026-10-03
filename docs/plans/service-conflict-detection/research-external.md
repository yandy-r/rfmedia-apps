# External Research: Service Conflict Detection

## Executive Summary

The most reliable implementation is a two-snapshot validator:

1. Ask Docker Compose for the fully resolved application model with
   `docker compose ... config --format json`.
2. Ask the Docker daemon for current container, mount, and network state with
   `docker container ls`, `docker inspect --type=container`, and
   `docker network inspect`.
3. Normalize both snapshots into small internal records, compare them without
   mutation, sort every finding deterministically, and only then allow `deploy`
   to continue.

This design should reuse the repository's existing Docker CLI wrapper. It preserves Docker
contexts, SSH transport, environment-tool wrapping, retries, timeouts, and test seams. Directly
reading `/var/run/docker.sock`, invoking `lsof`/`ss`/`netstat`, or reparsing Compose YAML would
make behavior less portable and less faithful to what Compose will deploy.

**Confidence**: High. Docker documents that `compose config` merges files, resolves variables,
and expands short notation into the canonical model. Docker inspection commands return daemon
state as JSON.

The feature can deterministically detect:

- fixed published-port collisions among selected services;
- collisions between selected services and published ports owned by other running Docker
  containers;
- explicit Compose IPAM subnet overlap among selected networks and existing Docker networks;
- shared mount sources and configuration mismatches, provided these are reported with carefully
  defined severity.

It cannot guarantee that deployment will succeed. Validation and deployment are separate
operations, so another process can claim a port or create a network after validation. It also
cannot portably identify every non-Docker process listening on a host, especially when the Docker
context is remote or Docker Desktop forwards traffic through a VM.

**Confidence**: High. The daemon remains the final authority and the validation-to-deploy window
is inherently subject to a time-of-check/time-of-use race.

A volume shared by multiple containers is not inherently a Docker conflict. Docker explicitly
supports multiple containers using a volume, and the Compose specification demonstrates a
database and backup service sharing one named volume. Multiple readers, or a reader and a writer,
may be intentional. Therefore, "incompatible volume conflict" needs a product-level definition.
The safe default is:

- hard error for contradictory definitions of the same runtime volume identity;
- warning for shared writable mount sources outside the selected replacement set;
- no finding for different container target paths alone;
- optional stricter policy only when the user explicitly marks a volume or bind source as
  exclusive.

**Confidence**: High for Docker semantics; Medium for the recommended product policy because
issue #64 does not define "incompatible."

No new dependency is required for Compose parsing, Docker inspection, process execution, or
sorting. A small, focused IP-address dependency is reasonable for correct IPv4 and IPv6 CIDR
math. `ipaddr.js` is the strongest candidate if adding one dependency is acceptable; otherwise,
the project must own and thoroughly test its own IPv4/IPv6-to-integer and prefix-mask logic.

**Confidence**: High.

## Primary APIs and Documentation

### Canonical Compose model

Command:

```bash
docker compose \
  -f compose.yml \
  --profile media \
  --env-file .env \
  config --format json
```

Docker's [`docker compose config` reference](https://docs.docker.com/reference/cli/docker/compose/config/)
states that the command renders the model that will be applied to the Engine. It merges files,
resolves variables, resolves paths, and expands short notation into canonical form. The command
also supports `--format json`, profiles, and the normal Compose project-selection inputs.

This must be the source of desired state. Parsing the YAML separately would have to duplicate:

- multi-file merge behavior;
- interpolation and environment precedence;
- `include`, `extends`, fragments, and YAML anchors;
- profile selection;
- relative-path resolution;
- short-to-long syntax conversion;
- project and resource-name resolution.

**Confidence**: High.

The current repository already exposes `getComposeConfig()` and invokes
`config --format json`. Its TypeScript shape currently models `ports` as `string[]`, but normalized
Compose output uses objects. Any conflict implementation must update or introduce a more accurate
internal type instead of parsing original short-form strings.

Local verification on 2026-07-24 with Docker Compose 5.3.1 produced:

```json
{
  "services": {
    "app": {
      "ports": [
        {
          "mode": "ingress",
          "host_ip": "127.0.0.1",
          "target": 80,
          "published": "8080",
          "protocol": "tcp"
        }
      ],
      "volumes": [
        {
          "type": "bind",
          "source": "/absolute/project/path/data",
          "target": "/data",
          "read_only": true,
          "bind": {}
        }
      ]
    }
  }
}
```

It also showed these normalization details:

- `"9090-9091:8080-8081"` becomes two fixed port objects;
- `"3000-3005"` becomes six target-only objects with no `published` value;
- `"8000-9000:80"` remains one object whose `published` value is a range;
- relative bind sources become absolute paths;
- named volume definitions gain their runtime-scoped `name`;
- `networks.<key>.ipam.config` remains an array and can contain IPv4 and IPv6 subnets.

**Confidence**: High for the tested Compose version. Treat the JSON as an external input and
validate it defensively because additional fields can appear in later Compose versions.

The current Compose model is specified by the
[`compose-spec` repository](https://github.com/compose-spec/compose-spec/blob/master/spec.md).
Docker's continuously updated references for the relevant sections are:

- [`services.ports`](https://docs.docker.com/reference/compose-file/services/#ports)
- [`services.volumes`](https://docs.docker.com/reference/compose-file/services/#volumes)
- [top-level networks and IPAM](https://docs.docker.com/reference/compose-file/networks/#ipam)
- [top-level volumes](https://docs.docker.com/reference/compose-file/volumes/)
- [Compose profiles](https://docs.docker.com/reference/compose-file/profiles/)

All were accessed 2026-07-24; Docker documentation pages are continuously updated and do not
provide a stable page publication date.

### Runtime container state

Use:

```bash
docker container ls --quiet
docker inspect --type=container CONTAINER_ID...
```

[`docker container ls`](https://docs.docker.com/reference/cli/docker/container/ls/) returns
running containers by default. `--format json` emits one JSON object per line, but its `Ports`
field is a human-oriented summary string. Use the list command only to obtain IDs and then batch
inspect those IDs.

[`docker inspect`](https://docs.docker.com/reference/cli/docker/inspect/) returns a JSON array and
documents `.NetworkSettings.Ports` as the source for actual host bindings. Relevant container
fields are:

```typescript
interface RuntimeContainer {
  Id: string;
  Name: string;
  State?: { Running?: boolean; Paused?: boolean };
  Config?: {
    Labels?: Record<string, string>;
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  Mounts?: Array<{
    Type?: string;
    Name?: string;
    Source?: string;
    Destination?: string;
    Driver?: string;
    Mode?: string;
    RW?: boolean;
    Propagation?: string;
  }>;
}
```

Use Compose labels such as `com.docker.compose.project` and
`com.docker.compose.service` to avoid reporting the selected service's existing container as a
conflict with its replacement. Labels are more reliable than container-name conventions.

**Confidence**: High.

Inspect actual `NetworkSettings.Ports`, not only `HostConfig.PortBindings`:

- actual bindings contain the host address and host port selected by the daemon;
- target-only Compose ports may receive an automatically allocated host port;
- stopped containers should not be treated as current port owners;
- TCP and UDP bindings on the same numeric port are distinct.

**Confidence**: High.

### Runtime network state

Use:

```bash
docker network ls --quiet
docker network inspect NETWORK_ID...
```

[`docker network inspect`](https://docs.docker.com/reference/cli/docker/network/inspect/) returns
JSON by default. Compare desired explicit subnets against each runtime network's
`IPAM.Config[].Subnet`. Preserve network ID, name, driver, scope, and Compose labels for useful
ownership and resolution messages.

[`docker network create`](https://docs.docker.com/reference/cli/docker/network/create/) explicitly
states that subnetworks must not overlap and that Engine network creation fails when they do. The
same page explains that Docker selects a non-overlapping subnet when no subnet is specified.

Therefore:

- compare only explicit desired `subnet` entries;
- compare `subnet`, not merely `ip_range`;
- compare IPv4 with IPv4 and IPv6 with IPv6;
- include inactive Docker networks because they still own their IPAM pools;
- ignore an existing runtime network when it is the same resource Compose intends to reuse;
- do not fabricate a subnet for a desired network whose canonical IPAM config is empty.

**Confidence**: High for built-in Docker address pools. Medium for third-party network/IPAM
drivers, whose semantics are driver-specific.

### Runtime volume state

Container `Mounts` from `docker inspect` identifies active mount consumers. For named-volume
definition checks, use:

```bash
docker volume inspect VOLUME_NAME...
```

Docker's [volume documentation](https://docs.docker.com/engine/storage/volumes/) says volumes are
managed by Docker, can be shared among containers, and persist separately from containers. The
[`docker volume create` reference](https://docs.docker.com/reference/cli/docker/volume/create/)
documents that multiple containers can use the same volume and that attempting to create an
existing name with another driver fails.

For bind mounts, Docker's
[`Bind mounts` documentation](https://docs.docker.com/engine/storage/bind-mounts/) says the source
is a path on the daemon host, bind mounts are writable by default, and a remote daemon cannot bind
a client-local path. This has two consequences:

1. The canonical Compose `source` string is the portable comparison key. Calling local
   `realpath()` can inspect the wrong machine under a remote Docker context.
2. Shared-writer detection is a safety warning, not proof that Docker will reject the deployment.

**Confidence**: High.

### Direct Engine API

The [Docker Engine API](https://docs.docker.com/reference/api/engine/) exposes the same container
and network state over a versioned HTTP API. Docker documents API version negotiation and notes
that the CLI itself uses this API.

Direct API access is not recommended for this feature because this repository already centralizes
Docker CLI execution. A direct client would need to reimplement context resolution, SSH/TLS
transport, API negotiation, environment behavior, retries, and test doubles.

**Confidence**: High.

### Node process and socket APIs

The official [`node:child_process` documentation](https://nodejs.org/api/child_process.html)
states that `spawn()` and `execFile()` invoke a program with an argument array, while `exec()`
invokes a shell. Continue using argument arrays and the existing `spawn` wrapper. This avoids
shell parsing and preserves paths and user-supplied values safely.

Node's [`node:net` documentation](https://nodejs.org/api/net.html) documents `EADDRINUSE` when a
TCP server attempts to listen on an address already in use. A corresponding UDP probe is possible
with `node:dgram`. These probes should not be part of the deterministic default:

- they test the CLI machine, not necessarily the Docker daemon host;
- Docker Desktop and remote contexts introduce forwarding/VM boundaries;
- a successful bind only proves availability during the probe;
- probing briefly claims the port and introduces its own race;
- binding semantics for wildcard IPv4/IPv6 addresses are platform- and configuration-dependent.

An explicitly labeled `bestEffortHostProbe` mode could be added later for a confirmed local
context, but its findings should be warnings with a clear portability qualifier.

**Confidence**: High.

## Libraries and SDKs

### Recommended baseline: existing dependencies only

No new Docker or Compose SDK is needed. Reuse:

- the existing `spawn`-based Docker wrapper;
- native `JSON.parse`;
- native `Map`, `Set`, array sorting, and integer range comparison;
- existing output formatting, machine-format detection, and error handling.

This is the smallest integration and retains established behavior for SSH contexts and secrets
wrappers.

**Confidence**: High.

### CIDR option: `ipaddr.js`

[`ipaddr.js`](https://github.com/whitequark/ipaddr.js) provides IPv4/IPv6 parsing, CIDR parsing,
normalization, and range matching. The
[`npm registry entry`](https://www.npmjs.com/package/ipaddr.js) reported version 2.4.0, built-in
TypeScript declarations, and zero dependencies when accessed 2026-07-24.

Pros:

- handles compressed IPv6 and IPv4-mapped forms;
- avoids home-grown parser edge cases;
- small, focused, and dependency-free internally;
- supports both CommonJS and browser/Node use.

Cons:

- adds a production dependency and supply-chain surface;
- interval endpoints or network-address normalization still need a thin project wrapper;
- tests remain necessary for mixed-family, prefix-length, and malformed input behavior.

Recommendation: add `ipaddr.js` if the feature must fully support IPv6 in its first release.
Otherwise, explicitly scope version one to IPv4 and record IPv6 subnets as unsupported warnings.
Do not silently treat IPv6 as non-conflicting.

**Confidence**: Medium-High. The package capabilities and current metadata are directly
documented, but adopting a dependency is a repository policy decision.

### Not recommended

- `dockerode`: unnecessary abstraction over a transport the project already owns through the
  Docker CLI.
- YAML-level Compose libraries: cannot reproduce the full Compose resolution pipeline.
- `lsof`, `ss`, `netstat`, PowerShell networking cmdlets: OS-specific and unreliable for remote
  Docker contexts.
- regex-only IP parsing: unsafe for IPv6 and prefix validation.

**Confidence**: High.

## Integration Patterns

### Pattern 1: Snapshot, normalize, compare

```text
resolve CLI/config/service scope
              |
              v
compose config --format json
              |
              +----> desired ports, mounts, network subnets
              |
              v
docker container ls + batched container inspect
docker network ls   + batched network inspect
              |
              +----> runtime ports, mounts, network subnets
              |
              v
pure comparison functions
              |
              v
stable sort -> one result object -> text or JSON renderer
```

Run Compose resolution first. If it fails, report the Compose error and do not attempt conflict
resolution against an invalid or incomplete model.

Fetch container and network runtime snapshots concurrently after desired state is known. Chunk
large inspect calls to avoid command-line-length limits. Treat failure to inspect required
runtime state as validation failure under `--validate-first`, not as "no conflicts."

**Confidence**: High.

### Pattern 2: Normalize port reservations

```typescript
interface PortReservation {
  ownerKind: "desired-service" | "runtime-container";
  ownerId: string;
  project?: string;
  service?: string;
  hostIp?: string;
  start: number;
  end: number;
  protocol: string;
  allocation: "fixed" | "range-choice" | "daemon-assigned";
}
```

Rules:

1. Omit target-only desired ports from fixed-conflict checks; the daemon allocates their host
   port.
2. Expand or interval-normalize fixed published ranges.
3. Preserve single-target `published: "8000-9000"` as an allocation choice. It conflicts only if
   no compatible port remains in the range, not merely because one member is occupied.
4. Compare only equal protocols.
5. For the same address family, wildcard host addresses conflict with specific addresses.
6. Treat an omitted desired `host_ip` conservatively, but explain that Docker's default bind
   address can be changed by bridge driver configuration.
7. Exclude runtime containers that Compose will replace as part of the same selected project and
   service set.

Docker's [port publishing documentation](https://docs.docker.com/engine/network/port-publishing/)
states that an unspecified address publishes on all host addresses by default, shows that TCP and
UDP can coexist on the same number, and documents both IPv4 and IPv6 behavior. It also documents
that the default bind address can be changed.

**Confidence**: High for fixed IPv4/IPv6 bindings; Medium for a desired omitted host address when
daemon bridge defaults are customized.

Example:

```json
{
  "type": "port",
  "severity": "error",
  "resource": "0.0.0.0:32400/tcp",
  "owners": [
    { "kind": "desired-service", "id": "plex" },
    { "kind": "runtime-container", "id": "legacy-plex" }
  ],
  "resolutions": [
    { "action": "changePublishedPort", "service": "plex", "suggested": 32401 },
    { "action": "stopContainer", "container": "legacy-plex" }
  ]
}
```

The next-port suggestion must be derived from the sorted snapshot and labeled a suggestion, not a
reservation.

### Pattern 3: Normalize mount identities and report policy

```typescript
interface MountUse {
  ownerKind: "desired-service" | "runtime-container";
  ownerId: string;
  type: "volume" | "bind" | "tmpfs" | "npipe" | "image" | "cluster";
  source?: string;
  target: string;
  readOnly: boolean;
  runtimeVolumeName?: string;
}
```

Use top-level canonical `volumes.<logical>.name` for named-volume identity, not just the logical
Compose key. Use the canonical bind `source` string for bind identity.

Suggested severity:

| Condition                                                       | Severity        | Rationale                                       |
| --------------------------------------------------------------- | --------------- | ----------------------------------------------- |
| Same runtime volume name, contradictory desired driver/options  | Error           | Engine cannot satisfy both definitions          |
| Desired volume conflicts with an existing runtime volume driver | Error           | Recreation with another driver fails            |
| Same source has multiple writers across unrelated owners        | Warning         | Docker allows it; application safety is unknown |
| One reader and one writer share a source                        | Info or warning | Common backup/sidecar pattern                   |
| Multiple readers share a source                                 | No finding      | Compatible by default                           |
| Different services use the same container target path           | No finding      | Container mount namespaces are separate         |
| Parent/child bind paths overlap                                 | Warning only    | May be intentional and host semantics vary      |

**Confidence**: High for platform-level conditions; Medium for warning severity because it is
product policy.

### Pattern 4: CIDR interval overlap

Normalize each subnet into:

```typescript
interface SubnetReservation {
  ownerKind: "desired-network" | "runtime-network";
  ownerId: string;
  family: 4 | 6;
  first: bigint;
  last: bigint;
  cidr: string;
}
```

Two subnets overlap when they have the same family and:

```typescript
a.first <= b.last && b.first <= a.last;
```

Compare:

- desired versus desired;
- desired versus all runtime Docker networks;
- never IPv4 versus IPv6.

Deduplicate by runtime network identity before comparing. If canonical desired network `name`
matches the existing network Compose will reuse, do not report it as colliding with itself.
External networks have no desired IPAM definition and should be inspected for existence rather
than treated as new pools.

**Confidence**: High.

### Pattern 5: Deterministic JSON and non-interactive behavior

Build one typed result before rendering:

```typescript
interface ConflictValidationResult {
  schemaVersion: "conflict-validation.v1";
  valid: boolean;
  checkedAt: string;
  scope: {
    composeProject?: string;
    services: string[];
    profiles: string[];
  };
  conflicts: Conflict[];
  warnings: Conflict[];
}
```

Determinism requirements:

- sort selected services and profiles;
- sort findings by severity, type, normalized resource, then owner IDs;
- sort owners and resolution choices;
- never include daemon iteration order;
- use stable machine identifiers in JSON and reserve prose for `message`;
- emit exactly one JSON document to stdout in JSON mode;
- send diagnostics to stderr without contaminating stdout;
- never prompt in JSON, CI, non-TTY, or `--yes` mode;
- a blocking conflict exits non-zero before pull/build/start;
- interactive resolution must not silently mutate Compose files.

`checkedAt` is intentionally variable. Tests that require byte-for-byte determinism should inject
a clock or omit volatile fields from their snapshot assertion.

**Confidence**: High.

### Pattern 6: Validation placement

The validation belongs after configuration, profile, group, and sidecar resolution, but before:

- confirmation;
- image pull;
- container creation;
- parallel phase execution;
- deployment-state recording.

This ensures it validates the actual selected deployment scope and performs no deployment
mutation before a blocker is known. If `--dry-run --validate-first` is supported, it may perform
the same read-only snapshots and emit conflicts while still performing no pull/start operation.

**Confidence**: High.

## Constraints and Gotchas

### Compose and model constraints

- Canonical JSON uses long-form objects even when input uses short syntax.
- Profiles change which services and resources are present; validate the resolved active model.
- A Compose port with no `published` field is not a fixed host reservation.
- A published range attached to one target port is a choice pool, not ownership of every member.
- `network_mode: host` cannot be combined with `ports`. The process's eventual listen ports are
  not inferable from the Compose model, so emit an unsupported/best-effort warning rather than
  claiming there is no conflict.
- `expose` is a container-network declaration, not a host-port publication, and must not be used
  for host conflict detection.
- Compose can assign a runtime resource `name` different from the logical key. Compare runtime
  names.

**Confidence**: High.

### Port ownership portability

- Docker inspect sees Docker-owned bindings, not every non-Docker process.
- `lsof`/`ss`/`netstat` identify local OS listeners only and require different commands,
  privileges, and parsers across Linux, macOS, Windows, and WSL.
- Docker Desktop runs the daemon in a VM and forwards ports to the native host.
- A remote Docker context makes local socket probing irrelevant.
- IPv6 wildcard binding can interact with IPv4-mapped behavior and daemon/userland-proxy
  configuration.
- Rootless Docker and custom bridge options change implementation details.

Resolution: make Docker-owned conflict detection authoritative within the feature's declared
scope, label host-process coverage as unavailable, and let the eventual Engine error remain the
fallback for races or non-Docker owners.

**Confidence**: High.

### Volume semantics

- Shared storage is frequently intentional.
- Read-only on one consumer does not prevent another consumer from mutating the data.
- Bind sources refer to the daemon host, so local filesystem inode/symlink checks are invalid for
  remote contexts.
- Bind paths are platform-specific; case sensitivity and Windows path syntax cannot be inferred
  with POSIX-only logic.
- Named-volume driver options are driver-specific.
- Anonymous volumes have no stable desired source identity and should not participate in
  source-sharing checks.
- `tmpfs`, image mounts, named pipes, and cluster mounts need type-specific behavior; do not
  collapse them into bind/volume rules.

**Confidence**: High.

### Network semantics

- Compare master `subnet` intervals, not only allocation `ip_range`.
- Networks without explicit subnets are selected by Docker from non-overlapping default pools.
- An overlap with the host's LAN or VPN route can cause routing trouble even if it is not another
  Docker network. Portable host-route discovery is outside this first implementation.
- Third-party IPAM plugins and multi-host scopes may impose extra rules.
- Network creation can race after the snapshot.

**Confidence**: High for Docker-network comparisons; Medium for plugin and host-route behavior.

### Error handling

Failure to parse Compose JSON, list containers, inspect containers, list networks, or inspect
networks is not a clean result. Return an explicit validation-operational error. Do not turn
missing permissions, an unavailable daemon, truncated output, or malformed JSON into an empty
snapshot.

The existing Docker wrapper caps captured output. Whole-host container and network inspection can
exceed default limits on large installations, so use chunked inspect calls and enforce a clear
aggregate limit/error.

**Confidence**: High.

## Concise End-to-End Example

Input intent:

```yaml
services:
  plex:
    image: plexinc/pms-docker
    ports:
      - "32400:32400"
    volumes:
      - media:/media
    networks:
      media:

networks:
  media:
    ipam:
      config:
        - subnet: 172.28.0.0/16

volumes:
  media:
```

Runtime snapshot:

```json
{
  "containers": [
    {
      "name": "legacy-plex",
      "ports": [{ "hostIp": "0.0.0.0", "hostPort": 32400, "protocol": "tcp" }]
    }
  ],
  "networks": [{ "name": "legacy_media", "subnets": ["172.28.128.0/17"] }]
}
```

Deterministic result:

```json
{
  "schemaVersion": "conflict-validation.v1",
  "valid": false,
  "conflicts": [
    {
      "type": "network",
      "severity": "error",
      "resource": "172.28.0.0/16",
      "conflictsWith": "172.28.128.0/17",
      "owners": ["media", "legacy_media"]
    },
    {
      "type": "port",
      "severity": "error",
      "resource": "0.0.0.0:32400/tcp",
      "owners": ["plex", "legacy-plex"]
    }
  ],
  "warnings": []
}
```

Text rendering can add guided resolutions, while JSON retains stable action identifiers:

```text
Port 32400/tcp is requested by plex and owned by legacy-plex.
Options:
1. Change plex's published port (suggested: 32401).
2. Stop legacy-plex, then retry.
```

## Open Questions

1. What exactly makes two volume consumers "incompatible": multiple writers, different
   applications, conflicting drivers, or an explicit exclusivity policy?
2. Are warnings allowed to proceed automatically, and which severities block deployment?
3. Should runtime checks include all running Docker containers or only Compose-managed
   containers?
4. When a selected service already exists, should its container always be excluded, or only when
   Compose confirms it belongs to the same project and will be recreated?
5. Is full IPv6 support required in version one? If yes, is adding `ipaddr.js` acceptable?
6. Should a single-target published range pass when at least one port remains available?
7. Should non-Docker host listeners be explicitly out of scope, or exposed as a local-only,
   best-effort warning mode?
8. Does `--validate-first` validate only the selected services and their resources, or the entire
   active Compose project?
9. What stable exit code distinguishes "conflicts found" from Docker/inspection operational
   failure?
10. May interactive resolution run `docker stop`, or should it only print suggestions? Stopping a
    container is a material mutation and should require separate explicit authorization.
11. Should validation be reusable by `plan`, `apply`, `rebuild`, and MCP tools after the deploy
    contract stabilizes?
12. Must the JSON schema exclude timestamps for byte-for-byte deterministic output?

## Source Freshness and Confidence

All Docker, Compose Specification, Node.js, GitHub repository, and npm registry sources above
were accessed on 2026-07-24. Docker and Node API pages are living documentation without a stable
page publication date. The local canonical-model examples were verified on Docker Compose 5.3.1
and Docker Engine 29.6.2/API 1.55.

No conflicting primary-source claims were found. The principal uncertainty is not Docker
behavior, but the product meaning of "incompatible volume conflicts" and the desired scope for
non-Docker host listeners.
