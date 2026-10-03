# Feature Spec: Service Conflict Detection

## Executive Summary

Issue [#64](https://github.com/yandy-r/rfmedia-apps/issues/64) adds an opt-in,
read-only preflight to `rfapps deploy`. With `--validate-first`, rfapps resolves the exact
Compose model and effective deployment scope, snapshots relevant resources from the active
Docker authority, and reports fixed published-port conflicts, objective volume-definition
conflicts, and overlapping explicit network subnets before confirmation, image pulls, container
changes, readiness checks, or state writes.

The preflight has three deterministic outcomes: `passed`, `blocked`, and `inconclusive`.
`blocked` and `inconclusive` both exit `1` without mutation; `--yes` never waives validation,
`--allow-partial` remains limited to post-start outcomes, and `--dry-run --validate-first`
performs the same fresh read-only checks. Human output provides ranked manual suggestions, while
machine formats receive one versioned result with stable codes, IDs, and ordering. Version one
does not edit Compose, stop containers, remove resources, scan non-Docker host listeners, or
infer application-level incompatibility from ordinary shared storage.

## External Dependencies

### APIs and Services

#### Docker Compose CLI

- **Documentation**:
  [Docker Compose config](https://docs.docker.com/reference/cli/docker/compose/config/)
- **Authentication**: inherited from the active Docker context and its socket, SSH, or TLS
  configuration.
- **Read operation**: `docker compose ... config --format json`.
- **Purpose**: produce the canonical model after interpolation, profile filtering, file merging,
  path resolution, and short-syntax expansion.
- **Constraints**: output can contain sensitive resolved values and must remain ephemeral,
  bounded, narrowly projected, and absent from logs.

#### Docker Engine through the Docker CLI

- **Documentation**:
  [container inspect](https://docs.docker.com/reference/cli/docker/inspect/),
  [network inspect](https://docs.docker.com/reference/cli/docker/network/inspect/), and
  [volume inspect](https://docs.docker.com/reference/cli/docker/volume/inspect/).
- **Authentication**: inherited from the same active Docker authority used by deployment.
- **Read operations**: list validated resource IDs, then inspect containers, networks, and named
  volumes in bounded batches.
- **Purpose**: observe current Docker-owned port bindings, Compose ownership labels, mount
  identities, network IPAM subnets, and volume driver/options.
- **Constraints**: Docker access is a privilege boundary. Failed, partial, malformed, or oversized
  evidence makes the preflight `inconclusive`; it never becomes an empty successful snapshot.

### Libraries and SDKs

| Library     | Version  | Purpose                                      | Installation                      |
| ----------- | -------- | -------------------------------------------- | --------------------------------- |
| `ipaddr.js` | `^2.4.0` | Parse and normalize IPv4/IPv6 CIDR intervals | `npm install ipaddr.js -w rfapps` |

The dependency has no runtime dependencies and includes TypeScript declarations. It must be
wrapped behind a narrow internal CIDR interface, committed through the lockfile, and checked with
the repository's dependency-audit gates. No Docker SDK, YAML parser, host-network scanner, or
shell-execution dependency is added.

### External Documentation

- [Compose service ports](https://docs.docker.com/reference/compose-file/services/#ports):
  canonical published-port behavior.
- [Compose service volumes](https://docs.docker.com/reference/compose-file/services/#volumes):
  canonical mount behavior.
- [Compose top-level volumes](https://docs.docker.com/reference/compose-file/volumes/):
  named-volume definitions and sharing.
- [Compose networks and IPAM](https://docs.docker.com/reference/compose-file/networks/#ipam):
  explicit subnet definitions.
- [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/):
  wildcard, address-family, and protocol behavior.
- [Docker daemon security](https://docs.docker.com/engine/security/protect-access/):
  socket, SSH, and TLS authority considerations.

## Business Requirements

### User Stories

**Primary User: self-hosting operator**

- As an operator, I want a deploy to stop before mutation when a selected service's fixed host
  port is already claimed.
- As an operator, I want desired and runtime owners named separately so I can repair the correct
  resource.
- As an operator, I want targeted validation to match the services Compose may actually start,
  including sidecars and transitive dependencies.
- As an operator, I want valid shared media/storage patterns to remain valid and only objective
  volume contradictions to block deployment.
- As an operator, I want overlapping explicit Docker network subnets detected before Docker tries
  to allocate them.
- As an operator, I want safe manual suggestions without rfapps changing configuration or
  unrelated workloads.

**Secondary User: automation consumer**

- As automation, I want one stable, versioned, deterministic result so I can gate deployment
  without parsing prose.
- As automation, I want missing evidence represented as `inconclusive`, not as a pass.
- As automation, I want `--dry-run --validate-first` to use the same checks while guaranteeing no
  deployment or state mutation.

### Business Rules

1. **Opt-in compatibility**: without `--validate-first`, existing deploy behavior and output are
   unchanged.
2. **Gate placement**: preflight runs after configuration validation and effective target/profile
   resolution, but before dry-run returns, deploy confirmation, pulls, starts, readiness checks,
   database initialization, or deployment-history writes.
3. **Effective scope**: concrete selected services include group expansion, sidecars, transitive
   `depends_on`, and `network_mode: service:` dependencies. An untargeted deploy resolves the
   concrete active-profile services rather than reporting the sentinel `all`.
4. **Read-only authority**: allowed operations are Compose resolution and Docker list/inspect
   calls. Validation never edits files or starts, stops, removes, disconnects, creates, or reserves
   resources.
5. **Fail closed**: definite errors produce `blocked`; unavailable required evidence produces
   `inconclusive`. Both exit `1` before mutation.
6. **Self-reconciliation**: a running container is excluded only when authoritative Compose
   project/service labels identify it as the targeted service being reconciled.
7. **Warnings**: limitations and suspicious-but-permitted sharing do not block. Only definite
   conflicts and inconclusive required checks block.
8. **Guidance-only resolution**: suggestions are inert structured data and prose. `--yes` skips
   only the normal post-pass confirmation and never executes a suggestion or bypasses a conflict.
9. **Point-in-time evidence**: output states that Docker remains the final allocator and external
   state can change after inspection.
10. **One machine document**: structured modes emit exactly one deploy result containing optional
    validation evidence. They never prompt or print ANSI/progress data to stdout.

### Conflict Rules

#### Ports

- Evaluate host-published ports only; ignore `expose`.
- Preserve protocol, address family, bind address, published interval, and allocation mode.
- TCP and UDP are independent.
- Within one family, wildcard binds overlap every specific address; different specific addresses
  may reuse the same numeric port.
- Fixed desired claims are compared with other desired claims and running Docker container
  bindings.
- Target-only or daemon-assigned published ports are not definite claims.
- A single-target published range is a choice pool and blocks only when no compatible member
  remains.
- `network_mode: host` application listeners and non-Docker host listeners are explicitly outside
  portable v1 coverage.

#### Volumes

- Ordinary shared named volumes, shared bind sources, mixed read-only/read-write consumers,
  different target paths across different containers, and parent/child bind paths are not
  blocking by themselves.
- Block when two desired volume keys resolve to one runtime volume name but declare different
  normalized drivers or driver options.
- Block when a non-external desired named volume conflicts with an existing Docker volume's
  driver/options.
- Block when one service maps different sources or mount types onto the same container target.
- External volumes are checked for identity/existence, but Compose-owned driver policy is not
  imposed on them.
- Absolute bind sources are not exposed in normal structured or human output.

#### Networks

- Compare explicit top-level `ipam.config[].subnet` CIDRs only.
- Compare IPv4 with IPv4 and IPv6 with IPv6 as canonical integer intervals.
- Detect desired-versus-desired and desired-versus-existing-Docker-network overlap.
- Exclude the existing runtime network with the same effective name that Compose intends to reuse.
- Treat `ip_range` as subordinate to its subnet, not as a second network claim.
- Auto-assigned subnets, host LAN/VPN routes, and unknown third-party IPAM semantics are not
  invented as successful coverage.

### Edge Cases

| Scenario                                | Expected Behavior     | Notes                                    |
| --------------------------------------- | --------------------- | ---------------------------------------- |
| Same port, TCP versus UDP               | Pass                  | Protocols are independent                |
| IPv4 wildcard versus specific IPv4 bind | Block                 | Claims intersect                         |
| Distinct specific host IPs, same port   | Pass                  | Claims do not intersect                  |
| Target-only port                        | Pass with limitation  | Daemon chooses the binding               |
| Selected service's current container    | Exclude               | Requires matching project/service labels |
| Ordinary shared media bind              | Pass                  | Sharing is not an incompatibility        |
| Conflicting volume driver/options       | Block                 | Objective Docker identity conflict       |
| Adjacent network CIDRs                  | Pass                  | Intervals do not overlap                 |
| Matching intended existing network      | Exclude               | Same effective runtime identity          |
| Invalid explicit CIDR                   | Inconclusive          | Do not continue with partial math        |
| Docker inspection denied or truncated   | Inconclusive          | No empty-snapshot fallback               |
| `--dry-run --validate-first` conflict   | Exit `1`, no mutation | Same evidence as real deploy             |
| `--yes --validate-first` conflict       | Exit `1`, no prompt   | `--yes` is not a safety override         |
| `--allow-partial` preflight failure     | Exit `1`              | Partial success requires deployment work |

### Success Criteria

- [ ] Port, volume, and network conflicts use the objective rules above and stable ordering.
- [ ] Effective scope matches what Compose may start for service, services, group, sidecar,
      dependency, profile, interactive, and untargeted deploys.
- [ ] Blocked/inconclusive preflight proves no pull, up, readiness, resource mutation, database
      initialization, or state write occurs.
- [ ] Text and structured output are derived from one versioned result.
- [ ] `--dry-run`, `--yes`, machine formats, sequential deploy, and parallel deploy preserve the
      same safety outcome.
- [ ] Bash, Zsh, and Fish completions exactly expose deploy's registered options, including
      `--validate-first` and the currently omitted `--allow-partial`.
- [ ] Focused unit/action/integration tests cover critical safety rules without duplicating
      exhaustive tests at every layer.
- [ ] Existing deploy behavior remains unchanged when the flag is absent.

## Technical Specifications

### Architecture Overview

```text
Commander deploy --validate-first
              |
              v
load/apply config -> static config validation -> resolve targets/profiles/sidecars
              |
              v
resolve canonical Compose JSON -> compute effective dependency closure
              |
              +--------------------------+
              |                          |
              v                          v
project desired claims        bounded Docker runtime snapshot
              |                          |
              +------------+-------------+
                           |
                           v
                 pure conflict evaluator
                           |
                +----------+-----------+
                |                      |
          passed result       blocked/inconclusive result
                |                      |
                v                      v
 existing dry-run/confirm/     render one result, exit 1,
 pull/start/state workflow     perform no mutation
```

The implementation uses three boundaries:

1. `lib/docker.ts` collects and validates bounded external evidence.
2. `lib/conflict-validation.ts` owns pure normalization, comparison, stable IDs/order, safe
   resolutions, and text projection.
3. `actions/deploy.ts` orchestrates the gate and maps its result into existing output and exit
   behavior.

### Data Models

#### Conflict validation result

| Field           | Type                                | Constraints          | Description                                      |
| --------------- | ----------------------------------- | -------------------- | ------------------------------------------------ |
| `schemaVersion` | `"conflict-validation.v1"`          | constant             | Machine contract version                         |
| `status`        | `passed \| blocked \| inconclusive` | required             | Aggregate outcome                                |
| `scope`         | object                              | sorted, display-safe | Project, services, profiles                      |
| `checks`        | array                               | stable order         | Compose/container/volume/network evidence status |
| `summary`       | object                              | non-negative counts  | Totals by kind/severity                          |
| `conflicts`     | `ServiceConflict[]`                 | stable IDs/order     | Blocking findings                                |
| `warnings`      | `ServiceConflict[]`                 | stable IDs/order     | Non-blocking findings                            |
| `limitations`   | array                               | stable codes/order   | Explicit coverage boundaries                     |
| `error`         | object                              | inconclusive only    | Sanitized stable code/message                    |

#### Service conflict

| Field         | Type                        | Constraints               | Description                  |
| ------------- | --------------------------- | ------------------------- | ---------------------------- |
| `id`          | string                      | normalized, deterministic | Resource plus sorted parties |
| `code`        | stable enum                 | required                  | Machine branching code       |
| `kind`        | `port \| volume \| network` | required                  | Resource class               |
| `origin`      | `desired \| runtime`        | required                  | Evidence source              |
| `message`     | string                      | bounded, sanitized        | Human explanation            |
| `resource`    | discriminated union         | validated                 | Canonical conflicting fact   |
| `parties`     | `ConflictParty[]`           | sorted                    | Desired/runtime owners       |
| `resolutions` | `ConflictResolution[]`      | sorted, inert             | Manual guidance              |

#### Runtime snapshot

| Field                  | Type   | Constraints                  | Description                 |
| ---------------------- | ------ | ---------------------------- | --------------------------- |
| `containers`           | array  | running, bounded, unique IDs | Port/mount/label projection |
| `networks`             | array  | bounded, unique IDs          | Name/driver/IPAM projection |
| `volumes`              | array  | bounded, unique names        | Driver/options projection   |
| `authorityFingerprint` | string | one-way                      | Active Docker authority     |
| `composeFingerprint`   | string | one-way                      | Resolved desired input      |

There is no database schema, migration, cache, or persisted validation record.

### CLI Design

#### `rfapps deploy --validate-first`

**Purpose**: run a read-only resource-conflict preflight for the effective deploy scope.

**Input**: all existing deploy options plus the boolean `--validate-first`.

**Passing response**:

- text: compact checked counts and coverage limitations, then the existing deploy flow;
- structured: existing deploy envelope with optional `validation` evidence.

**Blocked response**:

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
    "status": "blocked",
    "scope": {
      "services": ["plex"],
      "profiles": ["media"],
      "project": "rfmedia-apps"
    },
    "checks": [],
    "summary": {
      "total": 1,
      "ports": 1,
      "volumes": 0,
      "networks": 0
    },
    "conflicts": [],
    "warnings": [],
    "limitations": []
  }
}
```

The example elides full check/conflict records. Production output contains the complete sorted
facts.

**Errors**:

| Exit | Condition                                          | Result                              |
| ---- | -------------------------------------------------- | ----------------------------------- |
| `1`  | Definite conflict                                  | `status: blocked`, no mutation      |
| `1`  | Required evidence unavailable                      | `status: inconclusive`, no mutation |
| `2`  | Invalid CLI/profile or unsupported CSV combination | Existing usage-error pipeline       |
| `3`  | Post-start partial deploy with `--allow-partial`   | Existing deploy behavior only       |

Nested JSON and YAML output are supported. Version one rejects `--output csv --validate-first`
with a usage error because no stable flattened multi-owner/multi-resolution schema is defined.
Table/text output uses the human projection.

### System Integration

#### Files to Create

- `packages/rfapps-cli/src/types/validation.ts`: public schema constants and discriminated types.
- `packages/rfapps-cli/src/lib/conflict-validation.ts`: validated projections, CIDR wrapper, pure
  conflict evaluation, sorting, suggestions, and human projection.
- `packages/rfapps-cli/src/lib/conflict-validation.spec.ts`: critical pure-rule tests.
- `docs/features/service-conflict-detection.md`: user contract, coverage, examples, limitations,
  and recovery.

#### Files to Modify

- `packages/rfapps-cli/package.json` and `package-lock.json`: reviewed CIDR dependency.
- `packages/rfapps-cli/src/lib/docker.ts` and `docker.spec.ts`: accurate canonical Compose types
  and bounded container/network/volume readers.
- `packages/rfapps-cli/src/lib/index.ts`: export the new feature seam.
- `packages/rfapps-cli/src/types/options.ts`, `results.ts`, and `index.ts`: option/result exports.
- `packages/rfapps-cli/src/cli.ts`: register the flag and retain exit-help compatibility.
- `packages/rfapps-cli/src/actions/deploy.ts` and `deploy.spec.ts`: run the shared preflight gate.
- `packages/rfapps-cli/src/testing/mock-docker.ts`,
  `packages/rfapps-cli/src/testing/deploy-scenarios.ts`, and
  `packages/rfapps-cli/src/cli.deploy.integration.spec.ts`: critical subprocess scenarios.
- `packages/rfapps-cli/src/actions/completion.ts` and `completion.spec.ts`: exact Bash/Zsh/Fish
  parity and separation of deploy-only/rebuild-only flags.
- `packages/rfapps-cli/README.md`: flag and output documentation.
- `ROADMAP.md` and `docs/roadmap-archive.md`: shipped state and archived completion entry.

#### Configuration

No new rfapps configuration key is required. The flag is intentionally explicit and per
invocation.

## UX Considerations

### User Workflows

#### Primary Workflow: Passing Preflight

1. **Resolve scope**
   - User: selects a service, services, group, profile, or the default scope.
   - System: resolves sidecars and Compose dependencies.
2. **Inspect**
   - User: supplies `--validate-first`.
   - System: performs bounded read-only Compose/Docker inspection with machine-mode progress
     suppression.
3. **Pass**
   - System: prints a compact status and coverage statement.
   - User: receives the existing deploy confirmation unless `--yes` or machine behavior already
     suppresses it.
4. **Continue**
   - System: uses the existing dry-run or deployment workflow.

#### Error Recovery Workflow

1. **Conflict or missing evidence**: evaluator returns `blocked` or `inconclusive`.
2. **User sees**: aggregate decision, exact resource, owners, cause, ranked inert resolutions,
   limitations, and an explicit no-mutation statement.
3. **Recovery**: user changes configuration or external state separately, then reruns the full
   command for fresh evidence.

### CLI Patterns

| Component      | Pattern                           | Notes                                             |
| -------------- | --------------------------------- | ------------------------------------------------- |
| Status line    | Decision first                    | `passed`, `blocked`, or `inconclusive`            |
| Finding        | Resource, owners, cause, recovery | Same typed facts as machine output                |
| Resolution     | Numbered manual guidance          | Never an executable selection                     |
| Machine output | One versioned document            | No prompt, progress, or ANSI on stdout            |
| Color          | Redundant textual labels          | Meaning never relies on color alone               |
| Coverage       | Explicit limitations              | Docker-owned resources and point-in-time evidence |

### Accessibility Requirements

- Status and resource kind are always expressed in text, not only color or glyphs.
- Machine and non-TTY output contain no ANSI cursor or styling sequences.
- Existing color behavior is tested with `NO_COLOR`; no new global color flag is required by this
  issue.
- Core facts use plain, line-oriented output suitable for redirected logs and assistive tools.

### Performance UX

- Human mode emits one validation phase line and one final stable status; no per-resource chatter
  appears without debug mode.
- Independent inventory reads may run concurrently after desired-state resolution.
- Runtime evidence is fresh per invocation and never cached.
- Stage timeouts and resource-cap failures name the failed stage and produce `inconclusive`.
- No unsupported latency promise is made; optional safe timings remain debug-only.

## Recommendations

### Implementation Approach

**Recommended Strategy**: implement the versioned contracts and pure evaluator first, then add
bounded Docker evidence adapters, wire a single deploy gate above the dry-run and
parallel/sequential split, and finish with critical integration, completion, documentation, and
roadmap parity.

**Phasing:**

1. **Phase 1 - Contracts and pure engine**: types, canonical resource normalization, objective
   rules, stable IDs/order, safe resolutions, and critical unit tests.
2. **Phase 2 - Evidence and scope**: accurate Compose projection, effective dependency closure,
   bounded Docker readers, authority/input fingerprints, and adapter tests.
3. **Phase 3 - CLI integration**: flag, action gate, text/machine output, dry-run/exit behavior,
   and critical subprocess scenarios.
4. **Phase 4 - Parity and closeout**: Bash/Zsh/Fish completion parity, README/feature docs,
   `ROADMAP.md`, archive entry, coverage/build/audit gates.

### Technology Decisions

| Decision      | Recommendation                         | Rationale                                                 |
| ------------- | -------------------------------------- | --------------------------------------------------------- |
| Desired state | Canonical Compose JSON                 | Matches what Docker will apply                            |
| Runtime state | Existing Docker CLI transport          | Preserves contexts, SSH, retries, env tools, and tests    |
| Architecture  | Pure evaluator plus read-only adapters | Keeps policy deterministic and testable                   |
| IPv4/IPv6     | Narrow `ipaddr.js` wrapper             | Avoids fragile custom IPv6 parsing                        |
| Volumes       | Objective contradictions only          | Shared storage is valid and common                        |
| Interaction   | Manual suggestions only                | Preserves authorization and rollback boundaries           |
| Persistence   | None                                   | Preflight is ephemeral and may contain sensitive topology |
| CSV           | Reject with usage error in v1          | Avoids unstable nested-data flattening                    |

### Quick Wins

- Restore exact completion parity for the already-missing deploy `--allow-partial` while adding
  `--validate-first`.
- Reject invalid profiles explicitly so validation and deployment cannot silently use different
  scopes.
- Reuse authoritative project/service labels to prevent self-conflict false positives.

### Future Enhancements

- Add a read-only `rfapps validate conflicts` command after the schema has field experience.
- Add explicit volume exclusivity policies before introducing application-level storage blockers.
- Add non-mutating detail/re-check interaction without extending deploy authorization.
- Reuse the engine from plan/apply/rebuild/MCP only after the deploy contract stabilizes.
- Design any automatic remediation as a separate plan/apply feature with fresh validation,
  ownership checks, explicit confirmation, and rollback evidence.

## Risk Assessment

### Technical Risks

| Risk                                     | Likelihood          | Impact | Mitigation                                            |
| ---------------------------------------- | ------------------- | ------ | ----------------------------------------------------- |
| False volume blockers                    | High without policy | High   | Objective contradictions only                         |
| Missed transitive service claims         | Medium              | High   | Compute effective Compose dependency closure          |
| Self-container misclassified             | Medium              | High   | Project/service label identity                        |
| Authority/input changes after validation | Medium              | High   | State lock plus pre-mutation fingerprints             |
| Secret/topology leakage                  | Medium              | High   | Narrow projections, ephemeral data, sanitized outputs |
| Oversized/malformed Docker evidence      | Medium              | High   | Bounds, batches, typed validation, fail closed        |
| Incorrect IPv6 CIDR math                 | Medium              | High   | Reviewed focused parser plus boundary tests           |
| Non-Docker listener missed               | High                | Medium | Explicit limitation; Docker remains final authority   |
| Nondeterministic output                  | Medium              | Medium | Canonical keys, sorted copies, no clock fields        |

### Integration Challenges

- `ComposeServiceConfig` currently models lossy port data and omits mounts/top-level networks.
- Existing permissive Docker readers use `undefined`/empty fallbacks unsuitable for fail-closed
  validation.
- The current selection layer lacks transitive Compose dependency closure.
- Shell completion templates already drift from the Commander deploy surface.
- The existing deploy action has parallel and sequential branches; the gate must sit above both.

### Security Considerations

#### Critical — Hard Stops

| Finding         | Risk                                   | Required Mitigation                           |
| --------------- | -------------------------------------- | --------------------------------------------- |
| None identified | No inherent new critical vulnerability | Preserve the read-only, non-executable design |

#### Warnings — Must Address

| Finding                        | Risk                                      | Mitigation                                             | Alternatives                       |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------------ | ---------------------------------- |
| Authority/input TOCTOU         | Validate one target, mutate another       | Pin/re-fingerprint inputs and Docker authority         | Abort on mismatch                  |
| Resolved model/inspect leakage | Expose secrets or host topology           | Narrow projections and sanitized output                | No raw debug payloads              |
| Malformed/oversized evidence   | Resource exhaustion or terminal injection | Hard bounds, typed parsing, control sanitization       | Return `inconclusive`              |
| Docker privilege boundary      | Remote/local daemon compromise impact     | Reuse existing credentials; never elevate or copy them | Fail closed on denial              |
| Automatic remediation          | Disrupt or destroy unrelated resources    | Inert suggestions only                                 | Separate future plan/apply feature |
| Unsafe operands/paths          | Option or input substitution              | Validated IDs/names and canonical stable files         | Abort before inspection            |

#### Advisories — Best Practices

- Refresh and audit the lockfile before release; current transitive `ws` and development
  `picomatch` advisories are independent maintenance work and do not change this feature's
  architecture.
- Document that preflight is point-in-time and covers Docker-owned resources, not all host
  listeners or routes.
- Keep third-party driver semantics advisory or inconclusive rather than assuming built-in Docker
  behavior.

## Task Breakdown Preview

### Phase 1: Contracts and Pure Validation

**Focus**: establish the public schema and objective conflict rules.

**Tasks**:

- Add validation option/result types and schema version.
- Implement port, volume, and CIDR normalization and comparison.
- Add stable IDs, ordering, limitations, safe resolutions, and human projection.
- Add critical positive and negative unit tests.

**Parallelization**: type contracts and test fixture design can proceed together; detector work
depends on the finalized contracts.

### Phase 2: Evidence and Scope

**Focus**: obtain trustworthy desired/runtime claims.

**Dependencies**: Phase 1 contracts.

**Tasks**:

- Widen canonical Compose types and project only required fields.
- Compute effective service dependency closure.
- Add bounded container/network/volume readers and identity handling.
- Add authority/input fingerprint checks and adapter tests.

**Parallelization**: dependency-closure work and Docker adapter work are independent once shared
types settle.

### Phase 3: Deploy Integration

**Focus**: enforce one pre-mutation gate across every mode.

**Dependencies**: Phases 1 and 2.

**Tasks**:

- Register `--validate-first`.
- Wire the gate before dry-run, confirmation, and both execution branches.
- Add text/structured output and exit mapping.
- Add critical action and subprocess integration tests.

### Phase 4: Parity and Verification

**Focus**: complete all user-facing and repository contracts.

**Dependencies**: Phase 3 behavior.

**Tasks**:

- Update and parity-test Bash, Zsh, and Fish completions.
- Update rfapps README, feature documentation, roadmap, and archive.
- Run focused tests, full rfapps tests, typecheck, coverage, build, formatting, Markdown lint,
  dependency audits, and graph update.

## Decisions Needed

The design workflow resolves the issue's ambiguous points as follows:

1. **Volume incompatibility**
   - Decision: block only objective driver/options, missing external identity, and duplicate-target
     contradictions.
   - Impact: valid shared media/storage patterns continue to work.
2. **IPv6**
   - Decision: support IPv4 and IPv6 in v1 through a reviewed, narrow `ipaddr.js` wrapper.
   - Impact: one production dependency and lockfile review; no silent family omission.
3. **Interactive resolution**
   - Decision: numbered, typed manual guidance only.
   - Impact: no new destructive authority or rollback workflow.
4. **Effective scope**
   - Decision: selected services plus sidecars and transitive Compose dependencies; untargeted
     scope becomes concrete active-profile services.
   - Impact: validation matches what Compose may start.
5. **Machine schema**
   - Decision: `conflict-validation.v1` nested in the existing deploy result, with
     `passed`/`blocked`/`inconclusive`, stable arrays/codes, and no timestamps.
   - Impact: one deterministic stdout document and backward compatibility when the flag is absent.
6. **CSV**
   - Decision: reject `--output csv --validate-first` in v1.
   - Impact: avoids publishing an unreviewed flattening contract.
7. **Coverage**
   - Decision: Docker-owned port bindings, objective named-volume definitions, and explicit Docker
     network IPAM only.
   - Impact: non-Docker listeners, host routes, and application-level storage semantics are
     explicit limitations.
8. **Child issues**
   - Decision: no child issues are required. The implementation is cohesive around one deploy gate
     and can be completed in one PR without independently shippable subfeatures.

## Research References

- [research-external.md](./research-external.md): Docker/Compose/Node APIs, canonical payload
  behavior, CIDR dependency analysis, and portability limits.
- [research-business.md](./research-business.md): user stories, conflict taxonomy, business rules,
  scope, workflows, and acceptance criteria.
- [research-technical.md](./research-technical.md): architecture, types, CLI contract, files,
  constraints, and test seams.
- [research-ux.md](./research-ux.md): human/machine workflows, deterministic output, recovery,
  accessibility, and competitive analogues.
- [research-security.md](./research-security.md): severity-rated risks, authority, secret handling,
  hostile output, and dependency posture.
- [research-practices.md](./research-practices.md): reuse, KISS boundaries, completion parity,
  testability, and build-versus-depend.
- [research-recommendations.md](./research-recommendations.md): synthesized phasing,
  alternatives, risks, and decisions.
