# Error Handling

## Table of Contents

- [Overview](#overview)
- [User-Facing Error Messages](#user-facing-error-messages)
- [Error Categories](#error-categories)
- ["Did You Mean?" Suggestions](#did-you-mean-suggestions)
- [Machine-Readable Error Output](#machine-readable-error-output)
- [Exit Codes](#exit-codes)
- [Debug Mode](#debug-mode)
- [Error Propagation](#error-propagation)
- [Troubleshooting Common Errors](#troubleshooting-common-errors)
- [Related Documentation](#related-documentation)

## Overview

The `rfapps` CLI uses structured error handling to provide clear, actionable error messages when something goes wrong. Instead of cryptic stack traces or generic failure messages, every error includes:

- A human-readable description of what went wrong
- One or more suggestions for how to fix it
- Fuzzy-matched "Did you mean?" suggestions for typos in service, group, and profile names

Errors are written to stderr and never interfere with structured data output on stdout. For a valid
command that produces a machine-readable result, operational failures are represented in the
result object's `failed` array for programmatic consumption. Invalid invocations terminate before
a result is constructed and leave stdout empty.

## Exit Codes

`rfapps` uses stable exit codes for shell scripts and CI/CD pipelines.

| Code | Meaning           | Description                                                          |
| ---- | ----------------- | -------------------------------------------------------------------- |
| `0`  | Success           | Command completed successfully                                       |
| `1`  | Operational error | Runtime failure or blocked/inconclusive deploy conflict validation   |
| `2`  | Usage error       | Invalid command, option, option combination, service, group, or path |
| `3`  | Partial success   | Mixed deploy result with `--allow-partial`                           |

Grouped and multi-service deploys fail closed by default. For example,
`rfapps deploy -g media-stack --yes` exits `1` if any service fails. Use
`rfapps deploy -g media-stack --allow-partial --yes` when automation should
distinguish mixed outcomes from total operational failure; that command exits
`3` only when at least one targeted service succeeds and at least one fails.

### Managed Update Exit Semantics

`rfapps update` uses the following fail-closed exit behavior:

| Code | Managed update condition                                                                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Preview completed with conclusive detection, update succeeded, approval was declined, or no updates were available                                                                             |
| `1`  | Detection was unknown, scope was blocked, identity drift was found, update or verification failed, exact restore failed, the run was interrupted, or a failed update was successfully restored |
| `2`  | Invalid option combination, invalid target or timeout, unsafe `--out` path, or malformed/incompatible managed plan                                                                             |

A verified restore remains exit `1`. Recovery proves that the service returned to the exact captured
daemon-local image and passed verification; it does not make the requested update successful. The
final `update.v1` result distinguishes this case with `status: "recovered_failure"`,
`success: false`, and a per-service `outcome: "restored"`.

A successful no-op is exit `0` with `status: "no_updates"`. It performs no pull, recreation, restore,
or generation write.

### Native Backup Exit Semantics

Creation and offline verification use only exit codes `0`, `1`, and `2`:

| Code | Backup creation                                                | Backup verification                               |
| ---- | -------------------------------------------------------------- | ------------------------------------------------- |
| `0`  | Dry-run completed, or bundle published and writers recovered   | Every declared artifact verified                  |
| `1`  | Docker, filesystem, archive, cleanup, or recovery failure      | Missing, unexpected, size, or checksum failure    |
| `2`  | Invalid/unsafe usage, unsupported input, or cancelled approval | Invalid, unsafe, or unsupported manifest or usage |

Creation does not use partial-success exit `3`: `manifest.json` is published only after every
planned archive is synchronized and exact-container recovery succeeds. Verification can aggregate
several artifact failures into one result but still exits `1`.

### Vulnerability Scan Exit Semantics

`rfapps plan --scan` and `rfapps deploy --scan` gate on `--scan-fail-on`, which uses the CVE
severity scale and is unrelated to `--fail-on` on `audit`, `doctor`, and `lint`.

| Code | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| `0`  | Gate passed, or the default `--scan-fail-on none` kept the scan advisory                      |
| `1`  | Gate blocked or was inconclusive, or compose configuration could not be resolved              |
| `2`  | Unknown `--scanner`, unknown `--scan-fail-on`, blank suppression `reason`, unparsable `until` |

The default `--scan-fail-on none` is advisory: every failure mode is still reported and the command
exits `0`. With any other threshold the gate is fail-closed — `scanner-unavailable`, `timeout`,
`output-limit`, `scanner-error`, and `invalid-report` all resolve to `inconclusive` and exit `1`,
exactly like a threshold breach. A scan that "passes" because no scanner is installed is not
offered.

On `plan`, exit `1` also means `--apply` was suppressed; the plan file is still written as evidence,
and `rfapps apply <path>` remains the explicit override. On `deploy`, exit `1` means nothing was
pulled and no container was modified; the result carries a `failed[]` entry named `scan` with code
`VULNERABILITY_THRESHOLD` or `SCAN_INCONCLUSIVE`, and `--allow-partial` does not change it.

`deploy --dry-run --scan` exits `0` even when the gate would block, printing a `would block` line.

See [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md).

### Harden Exit Semantics

| Code | Meaning                                                                                 |
| ---- | --------------------------------------------------------------------------------------- |
| `0`  | Proposals reported, override written, apply completed, or apply cancelled at the prompt |
| `1`  | Compose resolution failed, or the backup/write failed                                   |
| `2`  | Usage error                                                                             |
| `3`  | `--apply` wrote some patches and refused others                                         |

Cancelling the `--apply` confirmation prompt exits `0`, matching `drift import`: declining a
proposed mutation is a decision, not a failure.

The usage errors are `--apply` with `--out`; `--allow-reformat` or `--no-backup` without `--apply`;
`--apply` with a machine format and without `--yes`; `--out` on an existing file; `--apply` that
needs `--allow-reformat`; and an unknown rule id, service target, or profile.

Harden is deliberately not a findings gate and has no `--fail-on`. Refusing to make an unsafe edit
is correct behaviour, and reporting that as a failure would train operators to ignore the exit code.
Use `rfapps lint --fail-on` when a CI threshold on this subject matter is wanted.

See [rfapps Harden Command](rfapps-harden-command.md).

### Tag Selector Exit Semantics

Every tag surface is read-only, so tags add no new exit codes and no `--fail-on`. They add one
failure mode instead: a `--tag` pattern that selects nothing is an **error**, never a silent
selection of everything.

| Code | Tag condition                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | `tag list` / `tag show` / `tag suggest` completed, including an empty taxonomy and zero proposals                                             |
| `1`  | The compose file could not be read                                                                                                            |
| `2`  | Malformed pattern, `--tag` matched no services, malformed `tags.mapping`, a rejected flag combination, `--output csv`, or an existing `--out` |

The usage errors are: a malformed pattern (`net*`, `a//b`, depth greater than 8, or a trailing
`/*`); a `--tag` that matched no services on a selector command; a `tags.mapping` value that is not
a valid tag path; `--tag` with `backup --all`; `--tag` with `update --from-plan`; `--output csv` on
`tag list` or `tag show`; and `tag suggest --out` naming a path that already exists.

The empty-match rule is the load-bearing one. An empty rfapps service list is an overloaded sentinel
meaning "no explicit target, let Compose operate on the whole project", so a glob that matched
nothing and fell through would target every service — including under `rfapps delete`. It throws
instead, and the exit code is `2` on every command that accepts `--tag`, including `status`.

See [rfapps Tag Selector](rfapps-tag-selector.md).

## User-Facing Error Messages

Every error displayed by `rfapps` follows a consistent format: an error message line followed by a list of actionable suggestions.

### Unknown Service Name

When you specify a service name that does not exist in the compose configuration, the CLI identifies close matches and suggests corrections.

```
$ rfapps deploy -s plx --yes

Error: Service 'plx' not found

Suggestions:
  * Did you mean 'plex'?
  * Run rfapps status --all to see available services
  * Run with --debug for more details
```

### Unknown Group Name

Group names are validated against the groups defined in `.rfapps.yaml`. A typo triggers a suggestion with all available groups listed.

```
$ rfapps deploy -g media-stck --yes

Error: Unknown service group: 'media-stck'

Suggestions:
  * Did you mean 'media-stack'?
  * Available groups: core-stack, media-stack, arr-stack, downloads-stack
  * Check .rfapps.yaml groups configuration
  * Run with --debug for more details
```

### Unknown Profile Name

Profile names are validated before any command executes. Invalid profiles produce a suggestion listing all valid options.

```
$ rfapps status --profile mdia

Error: Unknown profile: 'mdia'

Suggestions:
  * Did you mean 'media'?
  * Valid profiles: all, core, infrastructure, downloads, arr-stack, media, photos
  * Run with --debug for more details
```

### Invalid CLI Arguments

Arguments with invalid values produce targeted error messages showing what was wrong and what values are accepted.

```
$ rfapps history --action invalid-action

Error: Invalid value 'invalid-action' for action: Unknown action type

Suggestions:
  * Valid values: deploy, rebuild, delete, rollback, apply, prune
  * Run with --debug for more details
```

```
$ rfapps status --output xml

Error: Invalid value 'xml' for --output: Unsupported output format

Suggestions:
  * Valid values: json, yaml, csv, table, text
  * Run with --debug for more details
```

### Tag Selector Matched Nothing

A `--tag` pattern that narrows the selection to zero services is an error, never a silent selection
of everything. The message names the patterns that produced the empty set, the other selector flags
that were in play, and a segment-aware suggestion.

```
$ rfapps deploy -g arr-stack --tag "media/automaton" --yes

Error: Tag selector matched no services: media/automaton

  The selector also included: --group
  --tag narrows the selection; it does not widen it.

Suggestions:
  * Did you mean 'media/automation'?
  * Run 'rfapps tag list' to see all 14 known tags
  * Drop --group to search all tagged services
  * Run with --debug for more details
```

When `tags.mapping` assigns tags to services that are absent from `compose.yml`, that staleness is
the specific diagnosis and replaces the generic explanation, because the taxonomy — not the pattern
— is what needs fixing:

```
$ rfapps rebuild --tag "media/streaming" --yes

Error: Tag selector matched no services: media/streaming

  'tags.mapping' assigns this tag to services that are absent from compose.yml:
    plex-old, jellyfin-legacy

Suggestions:
  * Remove the stale entries from tags.mapping in rfapps.config.yaml
  * Run 'rfapps validate' to see every stale tag reference
  * Run with --debug for more details
```

A malformed pattern fails earlier, before any service resolution, and the message names the
replacement rather than guessing at intent:

```
$ rfapps status --tag "infrastructure/*"

Error: Invalid value 'infrastructure/*' for --tag: trailing '/*' is not supported

Suggestions:
  * Use 'infrastructure' to select the whole subtree
  * Use 'infrastructure/**' for the same thing, written explicitly
  * Run with --debug for more details
```

### Configuration File Not Found

When the required `.rfapps.yaml` configuration file cannot be located, the error shows which paths were searched.

```
$ rfapps status --all

Error: Configuration file not found

Suggestions:
  * Searched paths: .rfapps.yaml, rfapps.config.yaml
  * Run rfapps init to create a configuration file
  * Run with --debug for more details
```

### Configuration Validation Failure

Invalid configuration fields produce messages identifying the specific field and file.

```
$ rfapps deploy -s traefik --yes

Error: Invalid configuration: composePath must be a non-empty string

Suggestions:
  * Check the 'composePath' field in .rfapps.yaml
  * Check .rfapps.yaml syntax
  * Run with --debug for more details
```

### Docker Image Pull Failure

When pulling Docker images fails, the error identifies the affected services and suggests network checks.

```
$ rfapps deploy -s plex --yes

Error: Failed to pull images for plex

Suggestions:
  * Check network connectivity
  * Verify image names in compose.yml
  * Run with --debug for more details
```

### Docker Service Start Failure

If services fail to start after pulling images, the error points to service logs for diagnosis.

```
$ rfapps deploy -s sonarr --yes

Error: Failed to start services: sonarr

Suggestions:
  * Check service logs with docker logs
  * Run rfapps status for service health
  * Run with --debug for more details
```

### Docker Command Failure (SSH)

When operating against a remote Docker host via SSH, connection failures include SSH-specific troubleshooting steps.

```
$ rfapps deploy -s traefik --yes

Error: Docker up failed for traefik

Suggestions:
  * Check SSH connection to the Docker host
  * Verify Docker context configuration
  * Check Docker daemon status
  * Run with --debug for more details
```

### Deployment Not Found

Rollback operations reference deployment IDs from the history database. An invalid ID produces a targeted message.

```
$ rfapps rollback -s plex --to-deployment 999

Error: Deployment '999' not found for service 'plex'

Suggestions:
  * Run rfapps history to see available deployments
  * Run with --debug for more details
```

### Insufficient Rollback History

When requesting more rollback steps than are available in the deployment history, the error shows exactly how many steps exist.

```
$ rfapps rollback -s plex --steps 5

Error: Insufficient rollback history for 'plex'

Suggestions:
  * Requested 5 step(s), but only 2 available
  * Run rfapps history to see available deployments
  * Run with --debug for more details
```

### Plan Validation Failure

Saved deployment plans are validated before apply. Stale or corrupt plans produce clear messages.

```
$ rfapps apply --plan-file /path/to/stale-plan.json --yes

Error: Plan validation failed: Compose file has changed since plan was generated

Suggestions:
  * Plan file: /path/to/stale-plan.json
  * Run rfapps plan to regenerate the plan
  * Run with --debug for more details
```

## Error Categories

All error types are organized into four categories based on their origin and purpose.

### Lookup Errors

Errors triggered when a referenced name (service, group, profile) cannot be found. These errors support fuzzy-match suggestions.

| Error Type        | Trigger                         | Key Information                              |
| ----------------- | ------------------------------- | -------------------------------------------- |
| Service not found | Invalid `-s` / `--service` name | Service name, available services, suggestion |
| Group not found   | Invalid `-g` / `--group` name   | Group name, available groups, suggestion     |
| Profile not found | Invalid `--profile` name        | Profile name, valid profiles, suggestion     |

### Configuration Errors

Errors related to loading and validating configuration files.

| Error Type        | Trigger                                   | Key Information                   |
| ----------------- | ----------------------------------------- | --------------------------------- |
| Config not found  | No `.rfapps.yaml` in any searched path    | List of searched paths            |
| Config validation | Invalid field value in configuration file | Field name, config source, reason |

### Docker Errors

Errors from Docker Compose operations. These are handled locally within action loops to allow multi-service operations to continue when one service fails.

| Error Type             | Trigger                          | Key Information                           |
| ---------------------- | -------------------------------- | ----------------------------------------- |
| Docker command failure | Any Docker Compose command fails | Operation, stderr, exit code, SSH context |
| Image pull failure     | `docker compose pull` fails      | Affected services, stderr                 |
| Service start failure  | `docker compose up` fails        | Affected services, stderr                 |

### Validation Errors

Errors from input validation and state checks.

| Error Type              | Trigger                                       | Key Information                                                               |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| Invalid argument        | CLI argument has wrong type or value          | Argument name, value, reason, valid list                                      |
| Plan validation failure | Saved plan is stale or corrupt                | Plan file path, reason                                                        |
| Deployment not found    | Rollback references nonexistent deployment ID | Deployment ID, service name                                                   |
| Insufficient history    | Rollback requests more steps than available   | Service, requested steps, available                                           |
| Empty tag selector      | `--tag` narrowed the target set to nothing    | Patterns, other selector flags, known tags, suggestion, stale mapping entries |

### Native Backup Errors

Backup planning uses stable fail-closed codes for storage that cannot be archived safely:

- `ANONYMOUS_VOLUME`, `UNSUPPORTED_MOUNT_TYPE`, `BIND_SOURCE_MISSING`,
  `BIND_SOURCE_NOT_DIRECTORY`, and `NAMED_VOLUME_MISSING`;
- `NESTED_SELECTED_BIND`, `AMBIGUOUS_BIND_PATH`, `DESTINATION_INSIDE_SOURCE`, and
  `SOURCE_PROBE_FAILED`.

The terminal result also identifies the stage of operational failures, including `reserve`,
`prepare-helper`, `lock`, `revalidate`, `observe`, `stop`, `archive`, `recover`, `publish`,
`verify`, and `cleanup`. Creation preserves the primary failure and every exact-container recovery
failure. If recovery fails after a stop attempt, the private manifest-less staging bundle is
retained and reported as `stagingDisposition: "retained-incomplete"`; it is not a valid bundle.

Verification reports each declared or unexpected artifact as `verified`, `missing`, `unsafe`,
`not-regular`, `size-mismatch`, `checksum-mismatch`, or `unexpected`. It checks all safe entries and
returns their failures in deterministic order rather than stopping at the first checksum mismatch.

### Vulnerability Scan Errors

A scan target that was attempted but produced no findings reports one of five stable failure codes:
`scanner-unavailable`, `timeout`, `output-limit`, `scanner-error`, and `invalid-report`. Under any
threshold other than `none`, every one of them resolves the gate to `inconclusive` rather than to a
pass.

`rfapps harden` reports patches it declined to write with one of four refusal codes: `alias-target`,
`service-missing`, `unexpected-node`, and `nested-path`. Each refusal carries an `alternative`
describing what to do instead, and refusals alone never change the exit code.

## "Did You Mean?" Suggestions

When you mistype a service name, group name, or profile name, the CLI uses fuzzy matching to suggest the closest valid option. The matching is case-insensitive and uses Levenshtein distance to find the best candidate.

### How It Works

The fuzzy matcher compares the input string against all valid candidates and returns the closest match if its similarity score exceeds a minimum threshold of 0.4 (on a scale of 0 to 1, where 1 is an exact match).

### Where Suggestions Appear

Fuzzy matching is active for four types of names:

| Input Type    | Flag              | Candidates Source                  |
| ------------- | ----------------- | ---------------------------------- |
| Service names | `-s`, `--service` | Services defined in `compose.yml`  |
| Group names   | `-g`, `--group`   | Groups defined in `.rfapps.yaml`   |
| Profile names | `--profile`       | Valid profiles from `.rfapps.yaml` |
| Tag paths     | `--tag`           | Effective tags from `tags.mapping` |

Tag matching is **segment-aware**: the flat matcher scores `networking` against
`infrastructure/core/networking` at roughly `0.34`, below the `0.4` threshold, so a slash-delimited
path is compared segment by segment as well as whole-string, and the better score wins.

### Examples

Small typos reliably produce correct suggestions:

```
$ rfapps deploy -s trafik --yes
# "Did you mean 'traefik'?"

$ rfapps deploy -s sonnar --yes
# "Did you mean 'sonarr'?"

$ rfapps deploy -g meda-stack --yes
# "Did you mean 'media-stack'?"

$ rfapps status --profile infastructure
# "Did you mean 'infrastructure'?"
```

When no candidate is close enough (below the 0.4 similarity threshold), the suggestion is omitted, and only the list of available options is shown:

```
$ rfapps deploy -s zzzzz --yes

Error: Service 'zzzzz' not found

Suggestions:
  * Run rfapps status --all to see available services
  * Run with --debug for more details
```

For group names, the full list of available groups is always included regardless of whether a fuzzy match is found.

## Machine-Readable Error Output

When using machine-readable output formats (`--output json`, `--output yaml`, `--output csv`), errors from Docker operations are embedded in the `failed` array of the command result. This allows scripts and automation tools to programmatically detect and handle failures.

### JSON Error Output

```bash
rfapps deploy -g media-stack --output json --yes
```

```json
{
  "started": 3,
  "pulled": 3,
  "services": ["sonarr", "radarr", "bazarr"],
  "failed": [
    {
      "name": "pull",
      "error": "Failed to pull images for lidarr"
    }
  ],
  "unhealthy": []
}
```

### YAML Error Output

```bash
rfapps deploy -s plex --output yaml --yes
```

```yaml
started: 0
pulled: 0
services:
  - plex
failed:
  - name: start
    error: "Failed to start services: plex"
unhealthy: []
```

### Scripting with Error Detection

Use `jq` or `yq` to check for failures in automation scripts:

```bash
#!/bin/bash
result=$(rfapps deploy -g media-stack --output json --yes)

failed=$(echo "$result" | jq '.failed | length')
if [ "$failed" -gt 0 ]; then
    echo "Deployment had failures:"
    echo "$result" | jq -r '.failed[] | "  - \(.name): \(.error)"'
    exit 1
fi
```

### Invocation Errors in Machine Mode

Lookup and input-validation errors (such as unknown service names, missing configuration, or an
unsupported option combination) still output human-readable error messages to stderr even in
machine-readable modes. These errors terminate the command before any structured output is
produced. Check the exit code to detect these failures:

```bash
rfapps deploy -s invalid-service --output json --yes
# Exit code: 2
# stderr: Error: Service 'invalid-service' not found
# stdout: (empty)
```

For example, `rfapps deploy --validate-first --output csv` is an invalid invocation. It exits `2`
before configuration loading or conflict inspection and emits no CSV document.

### Deploy Conflict Validation in Machine Mode

A `blocked` or `inconclusive` `rfapps deploy --validate-first` result is not an invalid invocation.
It is a valid operational result that exits `1` before any pull, start, readiness check, or state
write. JSON and YAML emit exactly one deploy document on stdout with the complete
`conflict-validation.v1` result nested under `validation`; the deploy result's `failed` array
contains a corresponding stable validation failure code.

Use `validation.status` to distinguish a definite `blocked` conflict from an `inconclusive`
required-evidence failure. `--yes`, `--allow-partial`, and `--dry-run` do not waive either outcome.
With `--dry-run`, the Compose and Docker inspection remains read-only and the same exit/result
contract applies.

### Managed Update Errors in Machine Mode

For a valid managed-update preview or lifecycle run, JSON and YAML modes emit exactly one complete
`update.v1` document on stdout. Progress and warnings stay on stderr. Do not parse progress text;
inspect `status`, `exitCode`, `services[].outcome`, `services[].stage`, and
`services[].error.code` instead.

```bash
rfapps update -s plex --apply --yes --output json \
  > update-result.json 2> update-progress.log
exit_code=$?
```

An unknown registry result, verification failure, verified restore, restore failure, or mixed
partial outcome produces an `update.v1` document and exit `1`. Usage failures detected before a valid
result can be constructed exit `2`; diagnostics are written to stderr. Machine-format mutation never
prompts and is rejected unless `--yes` accompanies `--apply`.

### Native Backup Errors in Machine Mode

A valid JSON or YAML creation emits exactly one `rfapps-backup-result.v1` document, including for
dry-run preflight and real operational failures. Inspect `status`, `exitCode`, `primaryFailure`,
`errors`, `recoveryFailures`, and `stagingDisposition`; do not parse plan or progress text from
stderr.

Machine creation is rejected before config loading, locking, Docker, or bundle creation unless it
has both an explicit service/group target or `--all` and `--yes`. Invalid selection combinations and
CSV output also fail before a terminal backup result can be constructed, so stdout is empty and the
usage diagnostic is on stderr.

`rfapps backup verify` emits exactly one `rfapps-backup-verify-result.v1` document for a valid JSON
or YAML invocation, including malformed, unsafe, unsupported, and integrity-failed bundles. It does
not load config or contact Docker. Inspect `artifacts`, `errors`, and the mismatch/missing/unsafe
summary counts. CSV verification is an invocation error and emits no result document.

## Debug Mode

Adding `--debug` to any command reveals extended error information, including the error type, all context properties, and the full stack trace. This is useful for diagnosing unexpected failures or reporting issues.

### Standard Output (without --debug)

```
Error: Service 'plx' not found

Suggestions:
  * Did you mean 'plex'?
  * Run rfapps status --all to see available services
  * Run with --debug for more details
```

### Debug Output (with --debug)

```
Error: Service 'plx' not found

Suggestions:
  * Did you mean 'plex'?
  * Run rfapps status --all to see available services
  * Run with --debug for more details

--- Debug Information ---
Error type: ServiceNotFoundError
Properties:
  serviceName: "plx"
  availableServices: ["plex","sonarr","radarr","traefik"]
  suggestion: "plex"

Stack trace:
    at resolveServicesWithInteractive (file:///path/to/interactive-selection.js:120:15)
    at executeDeploy (file:///path/to/deploy.js:95:30)
    ...
```

Debug mode shows:

- **Error type**: The internal error class name (useful for bug reports)
- **Properties**: All context fields stored on the error (service names, paths, exit codes, etc.)
- **Stack trace**: The full call stack showing where the error originated

Debug output is written to stderr and does not interfere with stdout data in machine-readable modes.

## Error Propagation

The `rfapps` CLI uses two error handling strategies depending on the situation.

### Immediate Termination

Errors that make it impossible to continue terminate the command immediately with a formatted error
message. Invalid commands, options, names, paths, and managed plans exit `2`; operational failures
such as missing runtime dependencies or inaccessible Docker state exit `1`. These errors are detected
early, before lifecycle mutation begins.

Examples of immediately terminating errors:

- Unknown service, group, or profile name
- Missing or invalid configuration file
- Invalid CLI argument values
- Missing secrets provider tool

### Graceful Continuation

Errors during Docker operations -- such as a failed image pull or service start -- are handled individually per service. When deploying multiple services, a failure in one service does not prevent the remaining services from being processed. Failed services are collected in the result's `failed` array and reported at the end.

This means a command like `rfapps deploy -g media-stack --yes` will:

1. Attempt to pull and start all services in the group
2. Continue processing remaining services if one fails
3. Report all failures in the final output
4. Exit with code 1 if any service failed

Managed update uses a stricter sequential recovery boundary. It continues to the next service only
after a failed update has been restored and verified. It stops after a restore failure, but still
returns complete accounting for the requested scope in the final `update.v1` result.

## Troubleshooting Common Errors

| Error Message                         | Likely Cause                         | Resolution                                             |
| ------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| Service '...' not found               | Typo in service name                 | Check spelling; use the suggested correction           |
| Unknown service group: '...'          | Typo or undefined group name         | Check `.rfapps.yaml` groups section                    |
| Unknown profile: '...'                | Invalid profile name                 | Use `rfapps status --all` to see valid profiles        |
| Configuration file not found          | Missing `.rfapps.yaml`               | Run `rfapps init` to generate one                      |
| Invalid configuration: ...            | Malformed `.rfapps.yaml`             | Check the field mentioned in the error message         |
| Failed to pull images for ...         | Network issue or bad image name      | Verify network access and image names in `compose.yml` |
| Failed to start services: ...         | Container crash or port conflict     | Check `docker logs <service>` for details              |
| Docker ... failed for ... (SSH)       | SSH connection to remote host failed | Verify SSH config and Docker context                   |
| Deployment '...' not found            | Invalid deployment ID for rollback   | Run `rfapps history` to list valid IDs                 |
| Insufficient rollback history         | Not enough past deployments          | Deploy more times or reduce `--steps` value            |
| Plan validation failed: ...           | Compose file changed after plan      | Regenerate the plan with `rfapps plan`                 |
| Invalid value '...' for ...           | Wrong argument type or value         | Check the valid values listed in the suggestion        |
| Missing required environment variable | Secret not set in environment        | Use `--use-dotenvx` or `--use-op`, or set the variable |

For persistent issues, run the command with `--debug` to see extended error details and include the output in bug reports.

## Related Documentation

- [Quick Reference](quick-reference.md) - One-page command reference card
- [Output Formats](output-formats.md) - Machine-readable output for scripting
- [Secrets Management](secrets-management.md) - Environment variable and secrets injection
- [rfapps Configuration](rfapps-configuration.md) - Configuration file reference
- [Deployment Rollback](deployment-rollback.md) - Rollback workflow and history
- [Shell Completion](shell-completion.md) - Tab completion to prevent typos
- [rfapps Native Backup](rfapps-backup.md) - Backup failure, recovery, and verification contracts
- [rfapps Tag Selector](rfapps-tag-selector.md) - `--tag` exit semantics and empty-selector diagnosis
- [JSON Output](json-output.md) - `update.v1` machine result and stream separation
