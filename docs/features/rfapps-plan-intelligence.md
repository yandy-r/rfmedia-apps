# rfapps Plan Intelligence

`rfapps plan --explain` annotates a deployment plan with why each service changed and what declares a
dependency on it. It is an opt-in, read-only pass: it issues no additional Docker commands, mutates
nothing, and leaves the plan payload byte-identical when the flag is absent.

Without `--explain`, `rfapps plan` collapses five orthogonal diffs (image, environment, ports,
volumes, networks) plus a five-valued registry status into a single change type and then discards
every signal that produced it. `--explain` keeps those signals and reports them as typed, ranked
reasons alongside a declared-dependency impact summary.

## Usage

```bash
# Annotate a plan with likely cause and dependency impact
rfapps plan --explain

# Concise annotations for one service
rfapps plan -s plex --explain

# Full reason blocks and the complete impact sub-block
rfapps plan -s plex --explain --verbose

# Also surface services whose declaration did not change but whose image did upstream
rfapps plan --explain --check-updates

# Machine payload: `plan.intelligence` is carried by json and yaml
rfapps plan --explain --output json
```

`--explain` selects the **data**; the global `-v, --verbose` selects the **depth**. `--explain` pairs
naturally with `--check-updates` but does not imply it: registry checking stays strictly opt-in
because it costs a `docker image inspect` plus a `docker manifest inspect` per unique image.

`--explain` mutates nothing. It does not take the state lock, does not write to the state database,
and does not change any `changeType` verdict. Its only additional I/O is one directory read, up to
ten plan reads, and one compose-file hash, paid only when the flag is present.

## Reason Codes

Each annotation is one reason record carrying a stable `code`, a `kind`, a `confidence`, a `decisive`
flag, a canned `summary`, and bounded, secret-free `evidence`.

`kind` classifies what a reason explains:

- `trigger` — explains the service's change type.
- `provenance` — explains where the change originated (requires a comparable prior plan).
- `advisory` — notable, but never drives the change type.

| Code                       | Kind         | Emitted when                                                                                            | Confidence  |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- | ----------- |
| `container-not-running`    | `trigger`    | The change type is `create` and runtime state was observed                                              | `confirmed` |
| `image-reference-changed`  | `trigger`    | The declared image reference differs from the running container's                                       | `confirmed` |
| `environment-changed`      | `trigger`    | At least one environment variable was added, removed, or modified                                       | `confirmed` |
| `ports-changed`            | `trigger`    | Published port mappings differ                                                                          | `confirmed` |
| `volumes-changed`          | `trigger`    | Volume mounts differ                                                                                    | `confirmed` |
| `networks-changed`         | `trigger`    | Network membership differs                                                                              | `confirmed` |
| `compose-file-edited`      | `provenance` | The resolved fingerprint moved since the baseline plan and the compose file's text also changed         | `inferred`  |
| `resolved-config-changed`  | `provenance` | The resolved fingerprint moved since the baseline plan while the compose file's text is byte-identical  | `inferred`  |
| `unchanged-since-baseline` | `provenance` | The service is changing and its resolved fingerprint equals the baseline plan's                         | `confirmed` |
| `registry-image-drifted`   | `advisory`   | `--check-updates` ran, the image reference did not change, and the registry reports an available update | `confirmed` |

`decisive: true` marks a dimension that alone forced the change type under the plan generator's
change-type cascade. It is always `false` for provenance and advisory reasons. Reasons are ranked
triggers first, decisive before non-decisive, then in cascade order, and capped at eight per service.

**Create suppression.** When the change type is `create` there is no running container to compare
against, so every diff is trivially "changed". Only `container-not-running` is emitted in that case,
with the wording "no running container found (a stopped container is not inspected)".

**Provenance suppression.** All three provenance codes require the plan to be changing the service.
A service whose change type is `unchanged` never carries `unchanged-since-baseline`,
`compose-file-edited`, or `resolved-config-changed`: provenance explains where a change came from,
and "this change was already pending" is meaningless for a service with no change. It also keeps a
no-op plan a no-op instead of annotating every service that matches the baseline.

**Multi-cause is first class.** A `recreate` emits `image-reference-changed` as decisive plus every
concurrently changed declaration dimension as non-decisive, so a simultaneous environment or volume
change is no longer hidden behind the image diff. An `update` emits every changed dimension as
decisive.

**Evidence never carries values.** `environment-changed` lists variable names and the change kind
(`PLEX_CLAIM (modified)`), never the current or desired value, secret or not. Evidence entries are
capped at six per reason; image references, hash prefixes, service names, and ISO timestamps are the
only other admitted facts. Every one of them is already present verbatim elsewhere in the same plan
file, so the annotation surface is secret-neutral.

**`registry-image-drifted` discriminates on the five-valued registry status.** It is emitted only for
`update-available`; `unsupported` (build-only services), `unknown`, and `local-missing` never render
as drift. The wording is "the locally cached image for this reference is behind the registry",
because the check compares the local daemon image cache against the remote manifest — not the running
container.

Services carrying `registry-image-drifted` are annotated even though their change type is
`unchanged`. An entry exists whenever a service has at least one reason, not only when it is
changing.

## Confidence: `confirmed` versus `inferred`

| Confidence  | Meaning                                                    |
| ----------- | ---------------------------------------------------------- |
| `confirmed` | Two observed values were compared directly.                |
| `inferred`  | Partial evidence that cannot exclude an alternative cause. |

An `inferred` reason always names its alternatives in its own summary, and the concise renderer
appends an explicit `[inferred]` suffix to the `why:` line. The tool never states a cause it cannot
support.

Both "the configuration moved" provenance reasons are `inferred`:

- `compose-file-edited` — the compose file's text genuinely changed, but attributing this particular
  service's fingerprint move to that edit cannot exclude a simultaneous environment change.
- `resolved-config-changed` — the compose file's text is identical yet the post-interpolation model
  moved. Likely an environment or `--env-file` change, but a different secrets tool
  (`--use-dotenvx` versus `--use-op` versus none), a Docker Compose CLI upgrade that renormalizes
  `docker compose config` output, or a different active profile set produce the same signal.

`unchanged-since-baseline` is `confirmed` — both fingerprints were compared directly — and answers a
real question: this change was already pending when you last planned; you did not just cause it.

## Change Origin and the Baseline Plan

Provenance requires a baseline: the newest saved plan under `.rfapps/plans/` that is scope-compatible
with the current run. A candidate qualifies only when all four hold:

1. It is an ordinary deployment plan, not a managed-update plan.
2. Its `composePath` equals the current run's compose path.
3. Its sorted profile set equals the current run's sorted profile set.
4. It carries a non-empty compose hash.

Scope gating is not optional. Saved plans are ordered by modification time with no filtering, and a
plan file is written on every `rfapps plan`, so an unfiltered "newest" would compare one compose
file's bytes against another file's hash and label every service `compose-file-edited`.

Only two facts cross the baseline boundary: the plan's identity (id, timestamp, compose hash) and
each service's resolved configuration fingerprint. No environment entry is ever lifted out of a prior
plan, because saved plans persist resolved values unmasked.

Baseline loading is best effort. A missing, unreadable, or empty plan directory, or a truncated plan
file, never fails `rfapps plan`; it degrades to an unavailable baseline.

## Dependency Impact

Impact is derived from Compose declarations only — no state database, no additional Docker calls.
Edges are `depends_on` (both YAML forms) and implicit `network_mode: service:<name>`.

| Field                   | Meaning                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `effect`                | `none` (nothing applied), `create` (no container exists; one is created), `replace` (the running container is stopped and replaced) |
| `critical`              | The service maps to the `core` profile                                                                                              |
| `dependentCount`        | Size of the transitive set of services that declare `depends_on` this one, excluding itself                                         |
| `dependents`            | Sorted sample of that set, capped at ten names                                                                                      |
| `dependentsTruncated`   | True when names beyond the cap were omitted                                                                                         |
| `runningDependentCount` | How many services in that set currently have a running container                                                                    |
| `changingDependencies`  | Direct dependencies that this same plan also replaces, sorted and capped at six                                                     |

`update` is reported as `replace`, not "in place": Compose replaces the container for any
configuration change.

The wording is deliberately weaker than the mechanism might suggest. Compose `depends_on` governs
start ordering, not runtime coupling — these services are not restarted by `rfapps apply`, which
deploys only the plan's own change set. Output therefore reads
"N services declare depends_on this service" and never claims a consequence it cannot observe.

The `impact:` line is **omitted entirely** when a service has zero dependents rather than printing a
reassuring `0 dependents`. In this deployment only 11 of 44 services have any dependent at all, and
the real coupling frequently runs through shared bind mounts, Traefik routing, and the shared `apps`
network — none of which this metric can see.

Two signals are deliberately excluded:

- **Shared network membership.** Every network-declaring service joins the single `apps` network, so
  grouping by it would mark every service as impacting every other.
- **Shared bind mounts.** Real but sparse, and correct detection needs subpath containment over
  interpolated absolute paths. Deferred.

## Degradation Ladder

Annotation degrades in defined steps and never asserts a cause for state that was not observed.

| Condition                                        | Behavior                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--explain` not passed                           | No `intelligence` key at all. The plan payload is byte-identical to a plan without this feature.                                    |
| `docker compose ps` failed                       | Runtime state was not observed. All `container-not-running` reasons are suppressed and one banner line replaces per-service claims. |
| `--check-updates` not passed                     | Registry drift was not evaluated. No `registry-image-drifted` reason is emitted and one banner line says so.                        |
| No scope-compatible baseline plan                | No provenance reason is emitted for any service, and change origin reports as unavailable.                                          |
| Baseline lacks a fingerprint for a given service | No provenance reason for that service. It is new since the baseline, or the baseline predates fingerprints.                         |
| A service ends with zero reasons                 | The service is omitted from the annotation map entirely. Presence is meaningful.                                                    |

The degraded states print one line each, never per-service noise:

```text
Change origin: unavailable (no prior plan for this compose file and profile set)
Registry drift not checked (add --check-updates)
Runtime state unavailable (docker compose ps or inspect failed); cause annotations suppressed
```

The registry banner matters for floating tags. A tag such as `:latest` keeps the image reference
identical even when the upstream digest moved, so without `--check-updates` no registry claim of any
kind is made. The tool never says "up to date".

## Output

### Default (concise)

At most two lines are added before each service's existing diff block:

```text
~ recreate sabnzbd
  why: resolved config unchanged since plan 8f3a2c11 — this change was already pending when you last planned; image differs
  impact: replaces the running container; 4 services declare depends_on this service (3 running)
  image: - lscr.io/linuxserver/sabnzbd:4.3.2 → + lscr.io/linuxserver/sabnzbd:4.4.0

! update authentik-server
  why: resolved config changed since plan 8f3a2c11 with the compose file unchanged — likely an environment or secrets-tool input; a Compose CLI upgrade produces the same signal; environment differs [inferred]
  impact: replaces the running container; 2 services declare depends_on this service (2 running)

+ create plex
  why: no running container found (a stopped container is not inspected) (forces create)
  image: + lscr.io/linuxserver/plex:1.41.9
```

The `why:` line leads with the provenance reason when one exists, otherwise with the top-ranked
trigger. A decisive trigger lead carries `(forces replacement)` or `(forces create)` — the clause
names the effect on the container, because the change type is already on the header line directly
above. A second clause, separated by a semicolon, abbreviates the remaining trigger dimensions: after
a provenance lead it names the decisive ones (`image differs`), and after a trigger lead the
concurrent non-decisive ones (`environment also differs`). The `[inferred]` suffix appears only when
the lead reason is inferred. `plex` shows create suppression: exactly one reason, and no `impact:`
line because nothing declares `depends_on plex`.

The same two services with no baseline available lead with their triggers instead:

```text
~ recreate sabnzbd
  why: image reference changed (forces replacement); environment also differs
  impact: replaces the running container; 4 services declare depends_on this service (3 running)

! update authentik-server
  why: environment changed (forces replacement)
  impact: replaces the running container; 2 services declare depends_on this service (2 running)
```

The plan tail gains a downstream rollup inside the summary list, then — with `--check-updates` — a
registry-drift section naming services whose image reference did not change, then the change-origin
line. That section is the only place a drifted `unchanged` service becomes visible, since default
text output iterates only the create/recreate/update/delete buckets:

```text
Summary:
  + 1 to create
  ~ 1 to recreate
  ! 1 to update
  = 41 unchanged
  ^ 2 updates available
  → 6 downstream services declare depends_on a changing service

Registry drift (image reference unchanged, upstream image moved):
  radarr    docker.io/linuxserver/radarr:5.26.2  sha256:9c1f2e4a8b3d → sha256:31a0be77cc12
  tautulli  docker.io/tautulli/tautulli:v2.15.2  sha256:0d71ac4419e2 → sha256:c8e5f0a71b64

Change origin: compose file unchanged since plan 8f3a2c11 (2026-07-28T09:14:02Z)
```

### Verbose

`--explain --verbose` expands each reason into a tagged block with its evidence, and expands
`impact:` into a sub-block:

```text
~ recreate sabnzbd
  why:
    - image reference changed  [trigger/confirmed/forces replacement]
        current=lscr.io/linuxserver/sabnzbd:4.3.2
        desired=lscr.io/linuxserver/sabnzbd:4.4.0
    - environment changed  [trigger/confirmed]
        TZ (modified)
        SABNZBD_HOST_WHITELIST (added)
    - resolved config unchanged since plan 8f3a2c11 — this change was already pending when you last planned  [provenance/confirmed]
        baseline plan 8f3a2c11 (2026-07-28T09:14:02Z)
        fingerprint 7d2f11ab903e unchanged
  impact:
    effect: replaces the running container
    core service: no
    dependents: 4 declared (3 running) — lidarr, prowlarr, radarr, sonarr
    changing dependencies: (none)
  image: - lscr.io/linuxserver/sabnzbd:4.3.2 → + lscr.io/linuxserver/sabnzbd:4.4.0
```

The `[kind/confidence]` tag gains a third field only for a decisive trigger, and that field names the
effect (`forces replacement`, `forces create`) rather than the change type.

Truncation is always explicit:

```text
dependents: 14 declared (9 running) — app-01, app-02, app-03, app-04, app-05, app-06, app-07, app-08, app-09, app-10 (+4 more)
```

## Machine Output

Annotations are attached at the plan level as one additive optional key, `plan.intelligence`. Nothing
in the existing payload is renamed, removed, or retyped, and no field is added to a service change
entry — so saved state rows and deployment history are unaffected.

The payload carries a nested `schemaVersion` of `plan-intelligence.v1`, the resolved `provenance`,
the `registryChecked` and `runtimeStateObserved` booleans, a `services` map keyed by service name,
and a plan-wide `summary`.

- `--output json` and `--output yaml` carry `plan.intelligence` in full, as does the `rfapps.plan` MCP
  tool result.
- `--output table` strips it: a deeply nested object has no useful tabular rendering.
- `--output csv` strips it as well. This does not fix `rfapps plan --output csv`, which already fails
  on nested plan data; it only guarantees the new payload does not deepen that path.
- Old plans read by a new binary simply have no `intelligence` key, and `rfapps apply` reads a fixed
  narrow slice of a plan that this feature does not touch.

## Limitations

- **Multi-file compose is not covered.** The compose hash covers only the top-level compose path the
  plan targets — not `include:` files, not additional `-f` overrides, not the env file. A change
  confined to one of those surfaces as `resolved-config-changed` rather than `compose-file-edited`.
- **`resolved-config-changed` has more than one possible cause.** Switching secrets tooling
  (`--use-dotenvx` versus `--use-op` versus none) or upgrading the Docker Compose CLI, which
  renormalizes `docker compose config` output, moves the resolved model with byte-identical compose
  text. This is exactly why the reason ships as `inferred` and names its alternatives.
- **Profile scoping.** The resolved model reflects the active profiles only. This is inert today
  (`compose.yml` declares no service-level `profiles:` keys), but if profiles are adopted, dependents
  outside the active set become invisible to both the dependency graph and the fingerprint
  comparison.
- **Plans written with `--out <path>` are invisible to the baseline scan.** The scan reads
  `.rfapps/plans/` only, so an operator who habitually redirects plans with `--out` always sees
  `Change origin: unavailable`.
- **`depends_on` conditions are flattened.** The condition value is dropped when dependencies are
  extracted, so `service_healthy` (a hard readiness gate) and `service_started` (a soft ordering
  hint) are weighted identically.
- **Sidecar mapping is not applied.** Impact is computed with an empty sidecar mapping, matching this
  deployment (`sidecars.enabled: false`). With sidecar linking enabled, impact would omit
  sidecar-propagated edges that `rfapps deploy` honors.
- **Stopped containers are reported as `create`.** `docker compose ps --status running` cannot
  distinguish `exited`, `paused`, or `restarting` from nonexistent, so a crash-looping container
  yields a `create` change type. This is mitigated by wording only: "no running container found (a
  stopped container is not inspected)".

Two further caveats are worth knowing:

- **The baseline is the last planned state, not the last applied state.** `unchanged-since-baseline`
  names this explicitly, and change origin always prints the baseline plan id and timestamp so the
  comparison is visible. `git diff compose.yml` remains the better answer to "did I edit compose";
  this feature's incremental value is the interpolation-only case, which git cannot see.
- **Annotation inherits the accuracy of the underlying diffs.** Compose and Docker path-normalization
  artifacts already produce occasional spurious volume and port diffs. Today they yield a quiet
  `update`; with `--explain` they yield a printed sentence.

## Related Documentation

- [Plan/Apply Workflow](plan-apply-workflow.md) - Full plan and apply command reference
- [Quick Reference](quick-reference.md) - One-page command reference card
- [rfapps Drift Command](rfapps-drift-command.md) - Read-only drift detection between compose and runtime
- [rfapps Reconcile Command](rfapps-reconcile-command.md) - Report-first desired-state convergence
- [Shell Completion](shell-completion.md) - Tab completion for the plan option surface
- [JSON Output Mode](json-output.md) - Machine-readable output for scripting
- [rfapps MCP Server](rfapps-mcp-server.md) - Tool catalog and response envelopes
