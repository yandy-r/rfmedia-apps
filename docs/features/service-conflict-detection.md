# Service Conflict Detection

## Overview

`rfapps deploy --validate-first` adds an opt-in, read-only preflight before deployment. It resolves
the effective Docker Compose model, inspects Docker-owned resources under the active Docker
authority, and checks for:

- Fixed published-port conflicts
- Objective volume-definition or mount-target contradictions
- Overlapping explicit Docker network subnets

The preflight runs before confirmation, image pulls, container changes, readiness checks, database
initialization, or deployment-history writes. It never edits Compose configuration or
automatically changes, stops, removes, disconnects, creates, or reserves a Docker resource.

Without `--validate-first`, deploy behavior and output are unchanged.

## Invocation

Add `--validate-first` to `rfapps deploy`:

```bash
# Validate one service, then prompt before deployment if validation passes
rfapps deploy -s web --validate-first

# Validate a group and skip only the post-pass deploy confirmation
rfapps deploy -g core-stack --validate-first --yes

# Perform fresh validation and preview the resolved deployment without mutation
rfapps deploy -p core --validate-first --dry-run

# Emit one machine-readable result
rfapps deploy -s web --validate-first --yes --output json
rfapps deploy -s web --validate-first --yes --output yaml
```

The option belongs to `deploy` only. It does not add conflict validation to `plan`, `apply`,
`rebuild`, or MCP tools.

## Effective Validation Scope

Validation uses the services Docker Compose may start, not only the names typed at the command
line:

1. `--service`, `--services`, or `--group` selects the initial services.
2. Enabled sidecar mappings expand that selection. `--no-sidecars` disables this step.
3. Transitive `depends_on` dependencies are included.
4. Providers referenced through `network_mode: service:<service>` are included.
5. The already-resolved Compose profiles determine which model is inspected.

An untargeted deploy resolves every concrete service in the active-profile Compose model instead
of reporting an `all` placeholder. Service and profile names in the result are sorted.

Missing dependency references or dependency cycles make the result `inconclusive`; rfapps does not
validate a partial scope.

## Conflict Rules

### Published Ports

The port check evaluates desired host-published ports against other desired claims and actual
bindings on running Docker containers.

- `expose` entries and container-only target ports are not fixed host claims.
- Address family, bind address, protocol, and published interval are preserved.
- Protocols are independent. For example, TCP and UDP may use the same numeric port.
- Within one address family, a wildcard bind conflicts with a specific-address bind on the same
  protocol and port.
- Different specific host addresses may use the same protocol and numeric port.
- A fixed published interval claims its corresponding host ports.
- A published range for a single target is a choice pool. It blocks only when no compatible member
  remains.
- A daemon-assigned published port is reported as a limitation, not treated as a reservation.
- A running container is excluded as the service being reconciled only when its authoritative
  Docker Compose project and service labels match the selected project and service.

The check does not inspect non-Docker listeners or application sockets in
`network_mode: host`.

### Volumes and Mounts

Volume checks block only objective Docker-level contradictions:

- Two desired volume keys resolve to the same runtime volume name but specify different normalized
  drivers or driver options.
- A non-external desired named volume disagrees with the existing Docker volume's driver or
  options.
- A required external named volume does not exist.
- One service maps different source identities or mount types to the same container target.

The following are allowed by themselves:

- Multiple services sharing a named volume
- Multiple services sharing a bind source
- Mixed read-only and read-write consumers of the same source
- Different target paths in different containers
- Parent and child bind paths
- An existing external volume whose driver differs from a Compose-side declaration

The preflight does not infer application-level compatibility, locking, schema, data-layout, or
permission semantics for shared storage. Absolute bind sources are used only as ephemeral
comparison inputs and are not included in normal human or structured output.

### Networks

Network checks compare explicit top-level `ipam.config[].subnet` values:

- IPv4 is compared with IPv4 and IPv6 with IPv6.
- Desired subnets are compared with other desired subnets.
- Desired subnets are compared with existing Docker network subnets.
- Adjacent, non-overlapping CIDRs pass.
- The existing Docker network with the same effective name that Compose intends to reuse is
  excluded.
- `ip_range` is subordinate to its subnet and is not treated as another network claim.

Auto-assigned subnets, host LAN or VPN routes, and unknown third-party IPAM semantics are not
treated as validated coverage.

## Status and Exit Contract

The nested validation result uses `schemaVersion: "conflict-validation.v1"` and one of three
statuses:

| Status         | Meaning                                                           | Deploy behavior                          |
| -------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| `passed`       | Required evidence was complete and no blocking conflict was found | Continue to dry-run or the normal deploy |
| `blocked`      | At least one definite conflict was found                          | Exit `1` before mutation                 |
| `inconclusive` | Required evidence was unavailable, unsafe, malformed, or changed  | Exit `1` before mutation; never pass     |

An `inconclusive` result can retain definite conflicts found by independent checks. Always treat
the aggregate status as authoritative.

The command-level exit codes are:

| Exit | Condition                                                                  |
| ---- | -------------------------------------------------------------------------- |
| `0`  | Validation passed and the remaining dry-run or deploy completed            |
| `1`  | Validation was `blocked` or `inconclusive`, or a later operational failure |
| `2`  | Invalid invocation, invalid profile, or `--output csv --validate-first`    |
| `3`  | A post-start mixed result with `--allow-partial`                           |

`--allow-partial` never changes a preflight failure to partial success because no deployment work
has succeeded. `--yes` skips only the normal confirmation after a pass; it never waives
validation or executes a suggested resolution.

## Dry-Run Behavior

`--dry-run --validate-first` performs the same fresh Compose resolution and Docker inspection as a
real deploy. A blocked or inconclusive dry-run exits `1`. A passing dry-run prints or emits the
resolved preview and exits without pulling images, starting containers, checking readiness,
initializing the state database, or writing deployment history.

This differs from a deploy dry-run without `--validate-first`, which retains its existing behavior
and does not collect conflict evidence.

## Human Output and Manual Resolutions

Text and table modes report the decision, scope, finding counts, owners, stable finding IDs,
manual resolutions, and limitations. A resolution is guidance only. Even with `--yes`, rfapps does
not:

- Change a published port
- Stop or reconfigure a container
- Create or change a volume
- Remove or reconfigure a network

Review ownership carefully, make the intended change separately, and rerun the full command to
collect fresh evidence.

## JSON and YAML Output

JSON and YAML modes emit exactly one document on stdout. Progress, prompts, and ANSI formatting
are suppressed. For a normal deploy result, validation is nested at the top-level `validation`
field:

```text
DeployResult
├── services
├── failed
├── healthy
├── unhealthy
├── started
└── validation
    ├── schemaVersion
    ├── status
    ├── scope
    ├── checks
    ├── summary
    ├── conflicts
    ├── warnings
    ├── limitations
    └── error (inconclusive only)
```

A passing structured dry-run uses the existing dry-run envelope and places the same versioned
result at its top-level `validation` field.

Version one rejects CSV because findings contain nested resources, multiple owners, and multiple
manual resolutions. The rejection is a usage error with exit `2` and occurs before Docker
evidence is collected:

```bash
rfapps deploy -s web --validate-first --output csv
```

Use JSON or YAML instead.

### Complete Blocked JSON Example

The following deterministic example shows a desired wildcard TCP port colliding with a running
Docker container:

```json
{
  "services": [],
  "failed": [
    {
      "name": "validation",
      "code": "SERVICE_CONFLICT",
      "error": "Pre-deploy validation found blocking conflicts"
    }
  ],
  "healthy": [],
  "unhealthy": [],
  "started": 0,
  "validation": {
    "schemaVersion": "conflict-validation.v1",
    "scope": {
      "project": "demo",
      "services": ["web"],
      "profiles": ["core"]
    },
    "checks": [
      {
        "id": "compose",
        "status": "passed",
        "required": true,
        "resources": 1
      },
      {
        "id": "scope",
        "status": "passed",
        "required": true,
        "resources": 1
      },
      {
        "id": "authority",
        "status": "passed",
        "required": true,
        "resources": 2
      },
      {
        "id": "containers",
        "status": "passed",
        "required": true,
        "resources": 1
      },
      {
        "id": "volumes",
        "status": "passed",
        "required": true,
        "resources": 0
      },
      {
        "id": "networks",
        "status": "passed",
        "required": true,
        "resources": 0
      },
      {
        "id": "normalization",
        "status": "passed",
        "required": true,
        "resources": 2
      }
    ],
    "summary": {
      "total": 1,
      "errors": 1,
      "warnings": 0,
      "ports": 1,
      "volumes": 0,
      "networks": 0
    },
    "conflicts": [
      {
        "id": "port-port-binding-conflict-e36347e7",
        "code": "PORT_BINDING_CONFLICT",
        "kind": "port",
        "severity": "error",
        "origin": "runtime",
        "message": "Published TCP ipv4 host port 8080 has conflicting owners.",
        "resource": {
          "kind": "port",
          "family": "ipv4",
          "hostIp": "0.0.0.0",
          "protocol": "tcp",
          "published": {
            "start": 8080,
            "end": 8080
          }
        },
        "parties": [
          {
            "kind": "port",
            "origin": "desired",
            "ownerType": "service",
            "name": "web",
            "project": "demo",
            "service": "web",
            "claim": {
              "kind": "port",
              "origin": "desired",
              "project": "demo",
              "service": "web",
              "family": "ipv4",
              "hostIp": "0.0.0.0",
              "protocol": "tcp",
              "allocation": {
                "mode": "fixed",
                "published": {
                  "start": 8080,
                  "end": 8080
                }
              }
            }
          },
          {
            "kind": "port",
            "origin": "runtime",
            "ownerType": "container",
            "name": "existing-web",
            "containerId": "a1b2c3d4",
            "claim": {
              "kind": "port",
              "origin": "runtime",
              "containerId": "a1b2c3d4",
              "containerName": "existing-web",
              "family": "ipv4",
              "hostIp": "0.0.0.0",
              "protocol": "tcp",
              "published": {
                "start": 8080,
                "end": 8080
              }
            }
          }
        ],
        "resolutions": [
          {
            "id": "resolution-change-compose-port-f77bfb33",
            "action": "change-compose-port",
            "service": "web",
            "message": "Manually choose a non-conflicting published port for service web."
          },
          {
            "id": "resolution-inspect-runtime-owner-760e672e",
            "action": "inspect-runtime-owner",
            "resourceType": "container",
            "name": "existing-web",
            "message": "Inspect runtime container existing-web and confirm that it should retain the binding."
          },
          {
            "id": "resolution-stop-or-reconfigure-container-760e672e",
            "action": "stop-or-reconfigure-container",
            "container": "existing-web",
            "message": "Manually stop or reconfigure container existing-web if it should release the binding."
          }
        ]
      }
    ],
    "warnings": [],
    "limitations": [
      {
        "code": "APPLICATION_VOLUME_COMPATIBILITY_NOT_CHECKED",
        "kind": "volume",
        "message": "Application-level compatibility for shared storage is not inferred."
      },
      {
        "code": "HOST_NETWORK_PORTS_NOT_CHECKED",
        "kind": "port",
        "message": "Application listeners using host networking are outside this validation."
      },
      {
        "code": "HOST_NETWORK_ROUTES_NOT_CHECKED",
        "kind": "network",
        "message": "Host LAN, VPN, and routing tables are outside this validation."
      },
      {
        "code": "NON_DOCKER_PORT_OWNERS_NOT_CHECKED",
        "kind": "port",
        "message": "Non-Docker host listeners are outside this validation."
      },
      {
        "code": "POINT_IN_TIME_SNAPSHOT",
        "message": "Validation is point-in-time evidence, not a reservation; Docker remains the final allocator."
      }
    ],
    "status": "blocked"
  }
}
```

### Complete Inconclusive YAML Example

This example shows the complete result when running-container evidence cannot be collected:

```yaml
services: []
failed:
  - name: validation
    code: VALIDATION_INCONCLUSIVE
    error: Pre-deploy validation could not collect complete evidence
healthy: []
unhealthy: []
started: 0
validation:
  schemaVersion: conflict-validation.v1
  status: inconclusive
  scope:
    project: demo
    services:
      - web
    profiles:
      - core
  checks:
    - id: compose
      status: passed
      required: true
      resources: 1
    - id: scope
      status: passed
      required: true
      resources: 1
    - id: authority
      status: passed
      required: true
      resources: 2
    - id: containers
      status: failed
      required: true
      resources: 0
      failure:
        code: CONTAINER_SNAPSHOT_UNAVAILABLE
        check: containers
        message: Docker container evidence was unavailable
    - id: volumes
      status: passed
      required: true
      resources: 0
    - id: networks
      status: passed
      required: true
      resources: 0
    - id: normalization
      status: passed
      required: true
      resources: 1
  summary:
    total: 0
    errors: 0
    warnings: 0
    ports: 0
    volumes: 0
    networks: 0
  conflicts: []
  warnings: []
  limitations:
    - code: APPLICATION_VOLUME_COMPATIBILITY_NOT_CHECKED
      kind: volume
      message: Application-level compatibility for shared storage is not inferred.
    - code: HOST_NETWORK_PORTS_NOT_CHECKED
      kind: port
      message: Application listeners using host networking are outside this validation.
    - code: HOST_NETWORK_ROUTES_NOT_CHECKED
      kind: network
      message: Host LAN, VPN, and routing tables are outside this validation.
    - code: NON_DOCKER_PORT_OWNERS_NOT_CHECKED
      kind: port
      message: Non-Docker host listeners are outside this validation.
    - code: POINT_IN_TIME_SNAPSHOT
      message: Validation is point-in-time evidence, not a reservation; Docker remains the final allocator.
  error:
    code: CONTAINER_SNAPSHOT_UNAVAILABLE
    check: containers
    message: Docker container evidence was unavailable
```

Consumer code should branch first on the process exit code and `validation.status`, then use stable
`code` values. Messages are for people and may evolve.

## Docker Authority and Remote Contexts

Validation uses the effective environment and active Docker authority that deployment would use,
including the active Docker context, `DOCKER_HOST`, and existing socket, SSH, or TLS
configuration. A remote context therefore inspects the remote daemon, not the local host.

rfapps derives a one-way fingerprint from the effective context, endpoint, host override, and
daemon identity. After a pass, it rechecks the Docker authority and effective Compose inputs
immediately before the first deployment write. If either changed, validation becomes
`inconclusive` with `VALIDATION_AUTHORITY_CHANGED` or `VALIDATION_INPUT_CHANGED`; there is no force
bypass.

The preflight does not copy credentials, elevate Docker access, or print raw authority endpoints.
Docker access remains a privilege boundary, so use the same least-privilege context and credential
handling required for ordinary deployment.

Compose resolution, authority identification, and all three runtime evidence lanes share one
five-minute absolute deadline and disable command retries. No new evidence command starts after
that deadline. Exhaustion is reported as `EVIDENCE_LIMIT_EXCEEDED`, and deployment does not begin.
If one runtime lane is unavailable, independent lanes and desired-only checks may still retain
definite findings, but unavailable runtime evidence is never treated as proof that a resource is
absent.

## Privacy and Persistence

Canonical Compose output may contain resolved environment values. rfapps keeps that model
ephemeral and projects only the resource facts needed for validation:

- Raw Compose and Docker inspect payloads are not included in the result.
- Environment values and credentials are not included.
- Absolute bind source paths are excluded from findings and normal output.
- Authority and Compose identities are represented by one-way fingerprints internally.
- Validation has no cache, database schema, saved plan, or persisted validation record.

Structured output can still disclose operational topology such as service, container, volume, and
network names. Protect redirected output and CI artifacts accordingly. `--debug` does not authorize
raw secret-bearing payloads.

## Point-in-Time Limitations

Validation is a fresh observation, not a lock or reservation. Docker remains the final allocator,
and another actor can change resources after inspection.

Version one does not claim coverage for:

- Non-Docker host listeners
- Application listeners using host networking
- Host LAN, VPN, or routing-table conflicts
- Daemon-assigned port reservations
- Auto-assigned Docker network subnets
- Application-level volume compatibility, permissions, locking, schemas, or data layouts
- Unknown third-party volume or network driver semantics

These limitations are included as stable entries in every applicable validation result. A pass
means no conflict was found within the stated Docker-owned coverage; it is not a guarantee that
deployment cannot fail.

### Staged Rollouts Widen the Window

`--staged` does not change what validation inspects, but it does change how long the observation
has to stay true. Validation runs once, before any batch starts, and `revalidateDeployBinding`
re-checks the resolved binding exactly once immediately before the first batch — not per batch. The
rollout then proceeds through every batch, each holding a per-batch health gate.

The practical effect is that the `POINT_IN_TIME_SNAPSHOT` limitation is stretched from a single
pull-and-start pass to `batches × per-batch gate`, where `batches` is
`ceil(<resolved services> / --batch-size)` and the per-batch gate is
`min(--health-timeout, healthCheck.retries × healthCheck.interval)` seconds — 60 seconds with the
shipped defaults. Nothing caps that product: it grows linearly with the number of services. The
14-service `infra-stack` at `--batch-size 1` holds the snapshot for up to 14 batches × 60 s = 14
minutes; the same group at `--batch-size 7` bounds it at 2 batches × 60 s = 2 minutes. A port,
volume, or subnet that was free when the snapshot was taken can be claimed by another actor while
batch 1 is still soaking, and later batches will not see a fresh validation result — they will see
an ordinary Docker error at start time.

Do not read the separate 10-minute **state-lock staleness threshold** as a bound on this window.
`rfapps deploy --staged` warns when `batches × per-batch gate` exceeds that threshold, because
another operator's `force-unlock` could then mistake a live rollout for an abandoned lock. That
warning is about lock ownership, and a rollout is free to run well past it; the validation snapshot
is stale from the moment validation finishes, regardless of either number.

`--staged --validate-first` therefore still gives a single pre-mutation gate with the same coverage
and the same fail-closed behavior. It does not become a continuous guarantee. Keep `--batch-size`
as large as your blast-radius tolerance allows when the environment has other active operators.

## Troubleshooting

### Validation Is Blocked

Inspect `validation.conflicts[]` and distinguish desired owners from runtime owners in
`parties[]`. Review the ranked `resolutions[]`, make the intended change manually, and rerun the
original command. Do not assume a similarly named container is safe to stop.

### Validation Is Inconclusive

Use `validation.error.code`, `validation.error.check`, and failed entries in
`validation.checks[]` to locate the stage:

- For Compose or scope failures, validate the selected Compose file, environment file, profiles,
  and dependency references.
- For authority or snapshot failures, verify the intended Docker context is active and that
  `docker info` succeeds with the same environment.
- For malformed or unsupported resource shapes, inspect the relevant Compose definition without
  publishing resolved configuration or credentials.
- For input or authority changes, stabilize the Compose inputs and Docker context, then rerun.

Do not retry by removing `--validate-first` unless you intentionally accept losing this safety
gate.

### CSV Is Rejected

Choose `--output json` or `--output yaml`. CSV has no versioned representation for nested owners
and manual resolutions.

### A Passed Deploy Still Fails

Check the emitted limitations and normal Docker error. Common out-of-scope causes include a
non-Docker listener, a host-network application socket, external route changes, permissions,
application-level storage behavior, image failures, and state changes after the snapshot.

## Related Documentation

- [Dry-Run Mode](dry-run-mode.md)
- [Output Formats](output-formats.md)
- [Error Handling](error-handling.md)
- [Shell Completion](shell-completion.md)
- [rfapps CLI README](../../packages/rfapps-cli/README.md)
