# Service Conflict Detection: CLI UX Research

## Executive Summary

`rfapps deploy --validate-first` should feel like a preflight gate, not a second deployment
wizard. After the existing target selection resolves services, groups, profiles, and sidecars,
rfapps should take a fresh, read-only snapshot, summarize what it checked, and do one of three
things:

- **pass**: show a short success summary and continue to the existing deploy confirmation or
  dry-run result;
- **blocked**: show every definite conflict, its owners, the evidence, and ranked manual
  resolutions, then exit before any pull or mutation;
- **inconclusive**: explain which required evidence could not be collected and how to retry, then
  fail closed.

The issue's “interactive conflict resolution” is safest when interpreted as guided resolution:
human-readable mode may number and explain choices, but it must not edit Compose, select a new
port on the user's behalf, stop a container, disconnect a network, or delete a volume. A future
command could make an explicitly reviewed change, but `deploy --validate-first` should only
detect, explain, and abort.

Machine formats must never prompt. They should emit one versioned result on stdout, use stable
codes and deterministic ordering, and communicate the same pass/block/inconclusive decision as
text mode. `--yes` only skips the normal deploy confirmation after a passing preflight; it never
waives validation. `--dry-run --validate-first` performs the same read-only checks and returns the
same blocking status while preserving the dry-run guarantee.

**Confidence**: High. The recommendation follows the repository's current service selection,
machine-output suppression, structured formatting, dry-run, and exit-code conventions, and agrees
with current Docker Compose, Terraform, pip, and accessibility guidance.

## User Workflows

### Targeted interactive deploy that passes

```text
$ rfapps deploy -s plex --validate-first

[INFO] Validating 1 service against the current Docker context...
[SUCCESS] Pre-deploy validation passed
  Checked: 1 service, 1 published port, 2 mounts, 1 network
  Docker-owned conflicts: none
  Coverage: Docker containers and networks on context "default"

Deploy plex (will pull images first)? [y/N]
```

Workflow:

1. Resolve the same effective scope the deploy will use.
2. Show one progress line or spinner in a TTY.
3. On success, print a compact count and coverage statement.
4. Continue to the existing confirmation prompt.
5. If the operator declines, preserve the current cancellation behavior and make no changes.

The coverage line matters because Docker inspection cannot prove that no non-Docker host process
owns a port, especially for remote contexts. “No conflicts found” must not be phrased as “this
deploy is guaranteed to succeed.”

**Confidence**: High. Docker documents that published ports are host bindings and that Compose's
resolved model is the data that will be applied to the Engine
([port publishing](https://docs.docker.com/engine/network/port-publishing/);
[Compose config](https://docs.docker.com/reference/cli/docker/compose/config/), living
documentation accessed 2026-07-24).

### Interactive deploy with a blocking conflict

```text
$ rfapps deploy -s plex --validate-first

[ERROR] Pre-deploy validation blocked deployment: 1 conflict

1. PORT 0.0.0.0:32400/tcp
   Requested by: plex
   Conflicts with: container legacy-plex (project legacy-media)
   Why: both claims include every IPv4 interface on host port 32400/tcp

   Manual resolutions:
   1) Change plex's published port in Compose (suggested available port: 32401).
   2) Inspect and reconfigure or stop legacy-plex, then run this command again.

No images were pulled and no containers, networks, or volumes were changed.
```

Human output should present findings in stable order, but numbering is for reference rather than
authorization. Version one should not ask “apply option 1?” or offer “continue anyway.” Editing a
port can change reachability, and stopping the other owner is destructive relative to that
service. Both require context and explicit action outside this preflight.

If an interactive affordance is considered necessary for issue acceptance, limit it to
non-mutating help such as “show inspection command” or “show Compose field.” The terminal outcome
remains blocked and exit `1`.

**Confidence**: High. pip's current conflict UX first names both incompatible claims and then
offers ways to change user constraints; it does not hide the cause behind a generic failure
([pip dependency resolution](https://pip.pypa.io/en/stable/topics/dependency-resolution/),
v26.1.2 documentation accessed 2026-07-24).

### Multiple conflicts

Show the aggregate first, then every finding:

```text
[ERROR] Pre-deploy validation blocked deployment: 3 conflicts
  Ports: 1
  Volumes: 1
  Networks: 1
```

Each finding should answer, in this order:

1. **What resource conflicts?** Use a canonical resource key such as
   `0.0.0.0:32400/tcp`, `/srv/media`, or `172.28.0.0/16`.
2. **Who claims it?** Name desired services and observed Docker owners separately.
3. **Why is that incompatible?** State the exact overlap or definition mismatch.
4. **What can I do safely?** Give bounded, manual suggestions with the desired side first.
5. **What was not changed?** End the report with the no-mutation guarantee.

Do not collapse repeated owners into prose such as “and others.” An operator must be able to
identify every party before editing configuration.

**Confidence**: High. Complete cause reporting is necessary for recovery and can be generated from
the same typed result required for deterministic JSON.

### Inconclusive validation

```text
[ERROR] Pre-deploy validation could not verify runtime networks
  Docker context: homelab
  Failed stage: network inspection
  Reason: permission denied while inspecting network state

Deployment was not started because --validate-first requires complete evidence.
Next:
  1) Verify access with: docker --context homelab network ls
  2) Retry the same rfapps command.
```

An unavailable daemon, malformed Compose model, invalid explicit CIDR, timeout, or incomplete
inspection is not “zero conflicts.” The state is `inconclusive`, blocks the deploy, and names the
failed stage. Raw commands, paths, tokens, environment values, and stack traces stay behind
`--debug`.

**Confidence**: High. `docker compose config --quiet` explicitly treats inability to validate as a
failure rather than usable configuration
([Docker Compose config reference](https://docs.docker.com/reference/cli/docker/compose/config/),
living documentation accessed 2026-07-24).

### Machine-readable CI gate

Recommended invocation:

```bash
rfapps deploy --services plex,tautulli --validate-first --dry-run --json
```

Recommended result shape:

```json
{
  "dryRun": true,
  "services": ["plex", "tautulli"],
  "validation": {
    "schemaVersion": "conflict-validation.v1",
    "status": "blocked",
    "scope": {
      "services": ["plex", "tautulli"],
      "profiles": ["media"],
      "project": "rfmedia-apps"
    },
    "summary": {
      "total": 1,
      "ports": 1,
      "volumes": 0,
      "networks": 0
    },
    "conflicts": [
      {
        "id": "port:tcp:ipv4-any:32400:legacy-plex:plex",
        "kind": "port",
        "code": "PORT_BINDING_CONFLICT",
        "resource": "0.0.0.0:32400/tcp",
        "message": "Host port 32400/tcp is requested by plex and owned by legacy-plex.",
        "resolutions": [
          {
            "action": "change-compose-port",
            "service": "plex",
            "suggestedValue": "32401"
          },
          {
            "action": "inspect-external-owner",
            "owner": "legacy-plex"
          }
        ]
      }
    ],
    "limitations": [
      {
        "code": "NON_DOCKER_PORT_OWNERS_NOT_CHECKED",
        "message": "Only Docker-owned port bindings were inspected."
      }
    ]
  }
}
```

Machine behavior:

- emit exactly one JSON document to stdout;
- emit no spinner, prompt, ANSI sequence, progress log, or human conflict report;
- sort services, profiles, conflicts, parties, resolutions, and limitations;
- use stable codes for branching and keep prose in `message`;
- omit timestamps and durations from the deterministic result, or place them in an explicitly
  non-contractual metadata object;
- exit `0` only for a completed passing dry run;
- exit `1` for `blocked` or `inconclusive`;
- exit `2` for invalid arguments or unusable input configuration;
- never reinterpret conflict exit `1` as partial success exit `3`.

For a real machine-format deploy, the safest contract is to require explicit `--yes`; machine
output already suppresses prompts, and absence of a prompt should not silently become approval.
Because current `deploy` does not enforce this consistently, changing it globally is a
compatibility decision. At minimum, document that `--validate-first --json` without `--dry-run`
continues after a pass under existing deploy semantics, and never let the new flag imply consent.

**Confidence**: High for versioning, non-interaction, and deterministic output. Medium for requiring
`--yes` because it is the safer UX but changes current deploy behavior. Terraform's `-json`
explicitly implies non-interactive input and its machine UI declares compatibility rules for schema
versions
([Terraform plan](https://developer.hashicorp.com/terraform/cli/commands/plan);
[machine-readable UI](https://developer.hashicorp.com/terraform/internals/machine-readable-ui),
living documentation accessed 2026-07-24).

### Dry run

`--dry-run --validate-first` should use a fresh runtime snapshot but perform no deployment
mutation.

- **Pass**: include the validation result, then render the normal “would deploy” preview.
- **Blocked**: say “dry-run deployment blocked,” include the conflicts, and do not imply that the
  services would otherwise be deployable.
- **Inconclusive**: report the missing evidence and exit `1`.
- **Structured output**: include both `dryRun: true` and the validation object in the single deploy
  result.

Docker Compose itself exposes a dry-run mode that shows intended execution without changing stack
state, which supports preserving a strict preview boundary
([Docker Compose CLI](https://docs.docker.com/reference/cli/docker/compose/), living documentation
accessed 2026-07-24).

**Confidence**: High.

## CLI UX Best Practices

### Preserve the existing command model

- Keep `--validate-first` opt-in and default it to `false`.
- Run it after target/profile/sidecar resolution so the displayed scope matches the deploy.
- Run it before the existing dry-run branch, confirmation, pull, start, readiness, and state
  recording.
- Keep the existing exit categories: `0` success, `1` operational failure, `2` usage error, and
  `3` opt-in partial deploy.
- Reuse the existing text-versus-machine routing rather than writing directly from the detector.
- Include `validation` in the eventual deploy result after a pass so JSON consumers receive one
  document, not a preflight document followed by a deploy document.

**Confidence**: High. These are observed repository conventions in `src/cli.ts`,
`src/actions/deploy.ts`, `src/lib/exit-codes.ts`, and the shared output formatter as inspected on
2026-07-24.

### Lead with decision, then evidence

The first stable line must answer “will deploy proceed?”:

- `[SUCCESS] Pre-deploy validation passed`
- `[ERROR] Pre-deploy validation blocked deployment: N conflicts`
- `[ERROR] Pre-deploy validation was inconclusive`

Do not start with implementation detail such as “network inspect failed” or a raw Engine message.
After the decision, provide scope, evidence, cause, recovery, and the no-mutation statement.

Use consistent terms everywhere:

| User-facing term | Meaning                                            |
| ---------------- | -------------------------------------------------- |
| `passed`         | All required checks completed and found no blocker |
| `blocked`        | At least one evidence-backed conflict exists       |
| `inconclusive`   | A required check could not complete reliably       |
| `warning`        | A known limitation or non-blocking condition       |
| `suggestion`     | Advisory manual action, never an automatic change  |

Avoid `valid: true/false` as the sole state because `false` cannot distinguish a discovered
conflict from unavailable evidence.

**Confidence**: High.

### Make remediation specific but non-authoritative

Suggestions should:

- name the exact Compose service and field to review;
- identify the external Docker owner by stable ID/name where available;
- distinguish “change,” “inspect,” “reconfigure,” and “stop”;
- label candidate ports/subnets as suggestions derived from a point-in-time snapshot;
- place changes to the requested service before changes to an existing owner;
- never emit a shell command that embeds secrets or unresolved user-controlled text;
- never say a shared volume is incompatible without stating the contradictory definition or
  declared exclusivity rule.

The suggestion “stop jellyfin” is too forceful by itself. Prefer “Inspect jellyfin; if it is no
longer needed, stop or reconfigure it, then re-run validation.” The operator owns that decision.

Docker explicitly supports named volumes shared by multiple services, so shared use alone is not
an error
([Compose volumes](https://docs.docker.com/reference/compose-file/volumes/), living documentation
accessed 2026-07-24).

**Confidence**: High for cautious wording; Medium for volume conflict policy because issue #64
does not define “incompatible.”

### Interactive versus non-interactive behavior

| Environment          | Service selection                                        | Conflict presentation    | Resolution action      | Prompt                                  |
| -------------------- | -------------------------------------------------------- | ------------------------ | ---------------------- | --------------------------------------- |
| TTY, no target flags | Existing multi-select                                    | Full text report         | Manual guidance only   | Existing deploy confirm only after pass |
| TTY, explicit target | No selector                                              | Full text report         | Manual guidance only   | Existing deploy confirm only after pass |
| `--yes`              | No selector; current all-service semantics if untargeted | Full text report         | Manual guidance only   | Never                                   |
| JSON/YAML/CSV        | No selector; current all-service semantics if untargeted | One structured result    | Typed suggestions only | Never                                   |
| Piped/non-TTY text   | No selector; current all-service semantics if untargeted | Plain deterministic text | Manual guidance only   | Never                                   |

No mode may offer “continue despite conflict.” `--yes` skips confirmation, not safety checks.
Machine and non-TTY modes must never wait for stdin.

**Confidence**: High. Terraform documents `-input=false` for automation and makes `-json` imply it
([Terraform plan](https://developer.hashicorp.com/terraform/cli/commands/plan), living
documentation accessed 2026-07-24).

### Accessibility and no-color behavior

- Keep textual prefixes (`PASS`, `ERROR`, `WARNING`, `PORT`, `VOLUME`, `NETWORK`) even when color
  is enabled.
- Never rely on red versus green alone; state the status and conflict kind in words.
- Use ASCII-safe punctuation in core facts. Unicode checkmarks/arrows may be decorative, but their
  removal must not erase meaning.
- Honor non-TTY/plain output and the `NO_COLOR` environment convention. Verify the shared color
  layer rather than assuming the transitive color library always handles every environment.
- Consider a global `--no-color` alias only if the repository wants an explicit per-invocation
  override; it is useful but not required to deliver this issue.
- Keep machine formats free of all ANSI styling.
- Avoid cursor-rewriting spinners in CI, redirected stderr, or screen-reader-oriented workflows;
  use one line per state transition.

W3C's color guidance says that color must not be the only means of conveying information, and the
informal `NO_COLOR` convention specifies that a non-empty environment variable disables ANSI
color by default
([W3C Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color), updated
2025-09-16; [NO_COLOR](https://no-color.org/), updated 2026-07-21).

**Confidence**: High for text redundancy and machine-mode plain output. Medium for adding a new
flag because environment support may be sufficient and a global flag is outside the smallest
feature scope.

### Deterministic structured output

Treat JSON as a public interface:

- `schemaVersion` is mandatory;
- unknown additive fields must be safe for consumers to ignore;
- breaking field or semantic changes increment the major schema version;
- arrays are explicitly sorted because JSON object order is not a consumer contract;
- conflict IDs derive from normalized resource identity and sorted parties;
- the result contains stable enums/codes in addition to messages;
- the same snapshot and scope produce byte-for-byte equivalent JSON;
- human text is rendered from the typed result, not separately detected.

Terraform's machine-readable UI distinguishes a versioned structured interface from changeable
human text and describes forward-compatible handling of new fields
([Terraform machine-readable UI](https://developer.hashicorp.com/terraform/internals/machine-readable-ui),
living documentation accessed 2026-07-24).

**Confidence**: High.

## Error Handling

| Situation                                               | Human output                                                         | Structured status/code                         |                             Exit | Recovery                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------: | ------------------------------------------------------------------ |
| Preflight passes                                        | Short checked-count and coverage summary                             | `passed`                                       | 0 if dry-run, otherwise continue | Continue to deploy confirmation/execution                          |
| Definite port conflict                                  | Canonical bind, desired owner, runtime/desired owner, overlap reason | `blocked` / `PORT_BINDING_CONFLICT`            |                                1 | Change desired port or inspect/reconfigure other owner; retry      |
| Definite volume incompatibility                         | Runtime volume identity and exact contradictory property             | `blocked` / `VOLUME_DEFINITION_CONFLICT`       |                                1 | Align definitions or change desired volume; retry                  |
| Shared writable volume without proof of incompatibility | Clearly labeled warning, not an alarmist error                       | `passed` plus `SHARED_WRITABLE_VOLUME` warning |                       0/continue | Review ownership; no forced action                                 |
| Network CIDRs overlap                                   | Both CIDRs, networks, Docker context, overlap statement              | `blocked` / `NETWORK_SUBNET_OVERLAP`           |                                1 | Change desired IPAM subnet or inspect/reconfigure existing network |
| Compose cannot resolve                                  | Failed stage and sanitized reason                                    | `inconclusive` / `COMPOSE_CONFIG_UNAVAILABLE`  |                                1 | Run Compose config validation and fix input                        |
| Docker snapshot unavailable or partial                  | Failed stage, context, sanitized reason                              | `inconclusive` / `DOCKER_SNAPSHOT_UNAVAILABLE` |                                1 | Restore daemon/context access and retry                            |
| Invalid explicit CIDR                                   | Network name and invalid value, without continuing with partial math | `inconclusive` / `INVALID_CIDR`                |                                1 | Correct the Compose IPAM value                                     |
| Invalid CLI value or impossible flag combination        | Existing formatted usage error                                       | No validation result required                  |                                2 | Correct invocation                                                 |
| User cancels target selector or deploy confirmation     | `Cancelled`                                                          | No mutation                                    |        Preserve current behavior | Re-run when ready                                                  |
| Race after validation passes                            | Normal deploy error; note preflight is point-in-time                 | Deploy failure                                 |                                1 | Inspect current owner and retry validation                         |
| Ctrl+C during preflight                                 | `Operation interrupted`; no partial report presented as complete     | `interrupted` if a result is emitted           |                              130 | Re-run                                                             |
| Post-pass partial deploy with `--allow-partial`         | Existing per-service failure output                                  | Deploy partial result                          |                                3 | Repair failed services; validation itself is not partial           |

For blocking and inconclusive results, print the validation payload before setting the exit code
and returning. Do not throw a generic error after producing structured output, because the global
handler could add a second human error document or contaminate machine workflows.

In human mode, raw Engine diagnostics belong after the actionable summary only under `--debug`.
In machine mode, expected conflict outcomes belong in stdout data, not as ANSI-formatted stderr
errors.

**Confidence**: High. The exit mapping preserves the repository's existing public categories and
keeps a pre-mutation failure distinct from post-mutation partial success.

## Performance UX

Validation adds latency before a deploy that already may pull images, so its progress should be
visible but quiet:

- print one phase message immediately in human mode:
  `Validating N services against Docker context "name"...`;
- use a TTY spinner only when supported, and replace it with a final stable line;
- show no per-container or per-network chatter unless `--debug` is enabled;
- suppress all progress in JSON/YAML/CSV;
- collect independent Docker inventory concurrently, but sort the finished result before
  rendering;
- inspect runtime state once per invocation and reuse it for all conflict classes;
- never cache a runtime pass across invocations because ownership can change;
- on timeout, name the stage and elapsed limit, not a generic “validation failed”;
- on a remote context, include the context name so latency and recovery are understandable;
- if a resource cap is reached, return `inconclusive` rather than silently truncating results.

Docker Compose supports separate `tty`, `plain`, `json`, and `quiet` progress modes, which is a
useful analogue for adapting progress without changing outcomes
([Docker Compose CLI](https://docs.docker.com/reference/cli/docker/compose/), living documentation
accessed 2026-07-24).

No numerical latency target is justified by the issue or current telemetry. Capture stage
durations under `--debug` first; then establish a service-level objective from real local and
remote-context measurements. User-facing output should promise read-only coverage, not a specific
speed.

**Confidence**: High for adaptive progress and fresh snapshots. Medium for performance thresholds
because no production latency data was found.

## Competitive Analysis

| Tool/pattern   | Relevant behavior                                                                                                                             | Adopt for rfapps                                                                                                | Do not copy                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Docker Compose | `compose config` resolves and validates the canonical model; global dry-run previews changes; ANSI and progress modes can be plain/JSON/quiet | Resolve before validation, preserve a strict dry-run boundary, adapt progress to output mode                    | Compose's normal runtime errors alone are too late for this feature                                                              |
| Terraform      | Separates plan from apply; `-json` is non-interactive; machine UI is versioned; detailed exit status distinguishes outcomes                   | Treat preflight as reviewable evidence, version JSON, never prompt in machine mode, make exit behavior explicit | Do not reuse Terraform exit `2` for “conflicts found”; rfapps already reserves `2` for usage errors                              |
| pip resolver   | Explains the exact claims that make resolution impossible and follows with possible user changes                                              | Show both owners, the precise incompatibility, and ranked manual recovery steps                                 | Do not backtrack through or automatically rewrite Compose choices; these resource conflicts have no universally correct solution |
| W3C/NO_COLOR   | Meaning must not rely only on color; users can request plain ANSI-free output                                                                 | Preserve text labels and plain/machine output                                                                   | Do not use red/green or glyphs as the only status signal                                                                         |

Docker sources are living documentation accessed 2026-07-24. Terraform sources are living
documentation accessed 2026-07-24. pip documentation was version 26.1.2 when accessed on
2026-07-24. W3C's cited page was updated 2025-09-16; NO_COLOR was updated 2026-07-21.

No primary source suggests that any of these tools safely chooses between changing a desired
binding and stopping an existing workload. Their transferable pattern is explain-first,
non-interactive automation with explicit contracts—not automatic destructive repair.

**Confidence**: High.

## Recommendations by Priority

### P0: Required for a safe, coherent first release

1. Model `passed`, `blocked`, and `inconclusive` explicitly; fail closed for incomplete required
   evidence.
2. Place preflight after effective target resolution and before dry-run rendering, confirmation,
   image pull, start, readiness, or state writes.
3. Render one typed result in every format; include a versioned validation object in the eventual
   deploy JSON.
4. Make human findings answer resource, owners, cause, and manual recovery, followed by an explicit
   no-mutation statement.
5. Never offer “continue anyway,” never auto-select a candidate port/subnet, and never edit, stop,
   disconnect, remove, or delete anything.
6. Make `--yes` skip only the normal post-pass deploy confirmation; it cannot waive a conflict or
   unavailable check.
7. Make `--dry-run --validate-first` perform the same fresh read-only validation and preserve
   blocking exit behavior.
8. Emit exactly one deterministic JSON document, stable codes/IDs, sorted arrays, and no prompt or
   ANSI output in machine formats.
9. Use exit `1` for blocked/inconclusive, `2` for usage, and reserve `3` for an allowed partial
   deploy that started only after validation passed.
10. State validation coverage and limitations, especially the absence of portable non-Docker
    listener detection and the point-in-time race.

**Confidence**: High.

### P1: Strong usability and operability improvements

1. Add a compact pass summary with checked counts and Docker context.
2. Include non-color status/kind labels and verify `NO_COLOR` behavior end to end.
3. Add stage-specific timeout and permission recovery messages with sanitized `--debug` detail.
4. Add deterministic, typed manual resolution actions so text and automation can present their own
   guidance.
5. Require explicit `--yes` for a real machine-format deploy, or document the compatibility reason
   for preserving current implicit non-interactive continuation.
6. Define CSV behavior deliberately: flatten one row per finding with repeated summary fields, or
   reject CSV for this nested result with exit `2`; do not serialize nested objects into unstable
   prose.

**Confidence**: High except the `--yes` compatibility decision, which is Medium.

### P2: Defer until the read-only contract is proven

1. Add a non-mutating interactive “show details/inspection command” menu.
2. Add a read-only re-check action after the operator changes external state in another terminal.
3. Generalize the validator to `plan`, `apply`, `rebuild`, or MCP read tools.
4. Consider a separate explicitly reviewed remediation command with its own authorization and
   rollback design; do not grow it inside `deploy --validate-first`.

**Confidence**: Medium. These may help operators, but they expand interaction, testing, and safety
surface beyond the core issue.

## Open Questions

1. What exact rule makes a shared volume “incompatible”? Shared named volumes are valid Compose
   behavior, so multiple writers cannot become a blocker without stronger evidence or an explicit
   exclusivity policy.
2. Should machine-format mutation require `--yes`? This is safer and consistent with automation
   tools, but current `deploy` suppresses prompts for machine formats without requiring it.
3. Is `--output csv` required for conflict results? If so, what is the stable flattened schema for
   a passing result, multiple owners, and multiple resolutions?
4. Should an inconclusive result have the same exit `1` as a definite conflict, relying on
   `validation.status` and `error.code` for machine distinction? This best preserves existing
   rfapps exit categories.
5. Is a non-mutating re-check loop required for the phrase “interactive conflict resolution,” or
   are numbered manual suggestions and a blocked exit sufficient for version one?
6. Should normal text output show all findings by default or cap the visible list and point to
   `--json`? Any cap must still preserve complete machine output and explicitly state that text was
   abbreviated.
7. Are candidate ports/subnets worth suggesting in version one, given the point-in-time race, or
   should guidance initially name only the Compose field to change?
8. Should `--validate-first` validate only the resolved deploy closure or every active-profile
   service? UX strongly favors the actual deploy closure, with scope shown in the result.
9. Should warnings ever block? Recommended default: only definite conflicts and incomplete
   required checks block; warnings describe limitations or suspicious-but-permitted sharing.
10. Does the shared color implementation already honor `NO_COLOR` in every supported environment,
    including redirected stderr, or is a small explicit test/change required?

## Source Freshness and Research Gaps

Research was performed on 2026-07-24. Docker and HashiCorp pages are living documentation and do
not expose stable page update dates; their behavior should be rechecked when the implementation is
version-pinned. pip was reviewed at documentation version 26.1.2. W3C's Use of Color page was
updated 2025-09-16, and NO_COLOR reports an update date of 2026-07-21.

No conflicting primary guidance was found on machine non-interaction, structured output, or
color-independent status. The largest unresolved product gaps are volume incompatibility,
machine-mode `--yes`, CSV representation, and how much “interactive resolution” issue #64 requires.

**Confidence**: High for the source-backed patterns; Medium for decisions that depend on product
scope rather than external facts.
