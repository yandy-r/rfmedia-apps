# Shell Completion

This document describes how to set up and use shell completion for the rfapps CLI, providing tab completion for commands, options, service names, and service groups.

## Overview

The rfapps CLI includes built-in shell completion support for three popular shells:

- **Bash** - The most widely used shell on Linux systems
- **Zsh** - Default shell on macOS and popular on Linux
- **Fish** - Modern shell with advanced auto-completion features

Shell completion enables:

- Tab completion for all commands (status, pull, build, deploy, etc.)
- Completion for command-specific options
- Completion for service groups and Docker Compose profiles
- File path completion for `--compose`, `--env-file`, and secrets options

## Installation

### Quick Install (Recommended)

The easiest way to install completions is using the built-in install command:

```bash
# Bash
rfapps completion bash --install

# Zsh
rfapps completion zsh --install

# Fish
rfapps completion fish --install
```

Each command installs the generated script for the selected shell in its standard rfapps completion
location. If the shell argument is omitted, rfapps attempts to detect the current shell from `SHELL`.

### Manual Installation

#### Bash

1. Create the completion directory if it does not exist:

   ```bash
   mkdir -p ~/.bash_completion.d
   ```

2. Generate the completion script:

   ```bash
   rfapps completion bash > ~/.bash_completion.d/rfapps
   ```

3. Add to your `~/.bashrc`:

   ```bash
   # rfapps completion
   if [ -f ~/.bash_completion.d/rfapps ]; then
       source ~/.bash_completion.d/rfapps
   fi
   ```

4. Reload your shell:

   ```bash
   source ~/.bashrc
   ```

#### Zsh

1. Create the completion directory if it does not exist:

   ```bash
   mkdir -p ~/.zfunc
   ```

2. Generate the completion script:

   ```bash
   rfapps completion zsh > ~/.zfunc/_rfapps
   ```

3. Add to your `~/.zshrc` (before `compinit`):

   ```bash
   # Add custom completions directory
   fpath=(~/.zfunc $fpath)

   # Initialize completion system
   autoload -Uz compinit && compinit
   ```

4. Reload your shell:

   ```bash
   source ~/.zshrc
   ```

#### Fish

1. Create the completion directory and generate the completion script:

   ```bash
   mkdir -p ~/.config/fish/completions
   rfapps completion fish > ~/.config/fish/completions/rfapps.fish
   ```

2. Fish automatically loads completions from this directory - no additional configuration needed.

## Available Completions

### Commands

Tab completion works for all rfapps commands:

```bash
rfapps <TAB>
# Includes: status health pull build deploy stop rebuild delete prune plan update reconcile import
#           backup apply history rollback drift lint audit harden doctor force-unlock completion
#           init validate mcp state tag
```

### Global Options

Global options available to all commands:

| Option              | Description                                  |
| ------------------- | -------------------------------------------- |
| `--dry-run`         | Preview actions without executing            |
| `--debug`           | Enable debug output                          |
| `--json`            | Output in JSON format                        |
| `--output <format>` | Output format (json, yaml, csv, table, text) |
| `-v, --verbose`     | Show detailed output                         |
| `-y, --yes`         | Skip confirmation prompts                    |
| `--use-dotenvx`     | Use dotenvx for secrets injection            |
| `--use-op`          | Use 1Password CLI for secrets                |
| `--help`            | Show help                                    |
| `--version`         | Show version                                 |

### Command-Specific Options

Each command has its own set of options that are available through completion:

```bash
# Deploy command options
rfapps deploy --<TAB>
# Shows: --service --services --group --tag --no-sidecars --skip-pull
#        --force-recreate --validate-first --allow-partial --parallel
#        --workers --staged --batch-size --on-failure
#        --wait-for-ready --no-wait-for-ready --health-timeout
#        --scan --scanner --scan-fail-on --compose --env-file --profile

# Plan command options
rfapps plan --<TAB>
# Shows: --service --services --group --tag --no-sidecars --apply --out
#        --show-unchanged --check-updates --explain --scan --scanner --scan-fail-on
#        --compose --env-file --profile

# Managed update command options
rfapps update --<TAB>
# Shows: --service --services --group --tag --no-sidecars --apply --from-plan --out
#        --no-restore-on-failure --health-timeout --compose --env-file --profile

# Reconcile command options
rfapps reconcile --<TAB>
# Shows: --service --services --group --tag --no-sidecars --auto-apply
#        --show-unchanged --health-timeout --compose --env-file --profile

# Health command options
rfapps health --<TAB>
# Shows: --service --services --group --tag --no-sidecars
#        --wait-for-ready --no-wait-for-ready --health-timeout
#        --compose --env-file --profile

# Status command options
rfapps status --<TAB>
# Shows: --service --services --tag --all --health --stats --logs --compose --env-file

# Delete command options
rfapps delete --<TAB>
# Shows: --service --services --group --tag --no-sidecars --volumes --images
#        --compose --env-file

# Doctor command options
rfapps doctor --<TAB>
# Shows: --service --services --group --tag --no-sidecars --check-updates
#        --fail-on --compose --env-file --profile

# Audit command options
rfapps audit --<TAB>
# Shows: --service --services --group --tag --no-sidecars --json
#        --fail-on --compose --env-file --profile

# Harden command options
rfapps harden --<TAB>
# Shows: --service --services --group --tag --no-sidecars --apply --out
#        --include-review --rule --list-rules --no-backup --allow-reformat
#        --compose --env-file --profile --json

# Drift read command options
rfapps drift detect --<TAB>
# Shows: --service --services --group --tag --no-sidecars --show-unchanged
#        --report-only --compose --env-file --profile

rfapps drift show --<TAB>
# Shows: --service --report-only --compose --env-file --profile

# State rebuild command options
rfapps state rebuild --<TAB>
# Shows: --mode --rewrite --confirm-project --running-only --backup-dir
#        --show-unchanged --compose --env-file --profile

# Native backup creation options
rfapps backup --<TAB>
# Shows: verify --service --services --group --tag --all --no-sidecars --destination
#        --compose --env-file --profile

# Nested offline verifier
rfapps backup v<TAB>
# Completes to: rfapps backup verify

# Tag inspection subcommands
rfapps tag <TAB>
# Shows: list show suggest

rfapps tag suggest --<TAB>
# Shows: --service --services --group --rule --list-rules --include-tagged --out
#        --compose --env-file --profile --json
```

### Native Backup Completion Behavior

Bash, Zsh, and Fish expose the same `backup` parent command, nested `verify` command, and creation
options. Selection flags retain the usual service/group/profile suggestions. Completion inserts
command text and paths only; it does not authorize creation, answer the confirmation prompt, pull
the pinned helper, inspect Docker, or verify a bundle.

| Context                             | Bash, Zsh, and Fish behavior                  |
| ----------------------------------- | --------------------------------------------- |
| `rfapps backup --service <TAB>`     | Suggest resolved Compose services             |
| `rfapps backup --group <TAB>`       | Suggest configured service groups             |
| `rfapps backup --profile <TAB>`     | Suggest configured Compose profiles           |
| `rfapps backup --destination <TAB>` | Complete filesystem paths for the destination |
| `rfapps backup verify <TAB>`        | Complete filesystem paths for `manifest.json` |
| `rfapps backup --use-dotenvx <TAB>` | Complete environment-file paths               |
| `rfapps backup --use-op <TAB>`      | Complete environment-file paths               |

Completion does not enforce runtime authorization. Creation still requires an existing
`--destination`; non-interactive, `--yes`, JSON, and YAML creation require an explicit target or
`--all`; machine-format creation additionally requires `--yes`.

### Deploy Completion Parity

Bash, Zsh, and Fish are audited against Commander's registered deploy options. The exact
command-specific completion surface is:

```text
--service --services --group --no-sidecars --skip-pull --force-recreate
--validate-first --allow-partial --parallel --workers --staged --batch-size
--on-failure --wait-for-ready --no-wait-for-ready --health-timeout --compose
--env-file --profile --scan --scanner --scan-fail-on
```

The parity test extracts this set independently from every generated shell template and compares
it with the live Commander help surface. The audit also verifies that deploy-only
`--force-recreate`, `--validate-first`, `--allow-partial`, `--staged`, `--batch-size`, and
`--on-failure` are absent from Bash, Zsh, and Fish rebuild completions; rebuild retains its own
registered options. Global options remain available to both commands in addition to these
command-specific options.

### Reconciliation Completion Behavior

Bash, Zsh, and Fish expose the same `rfapps reconcile` option surface as Commander. They also keep
the legacy `rfapps drift reconcile` compatibility spelling. Completion only inserts command text;
it never observes Docker, authorizes auto-apply, answers confirmation, or runs an action.

| Options                            | Bash, Zsh, and Fish completion behavior                                          |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `-s, --service`                    | Suggest configured services plus services discovered from the local Compose file |
| `--services`                       | Suggest the same services while preserving an existing comma-separated prefix    |
| `-g, --group`                      | Suggest groups from the loaded rfapps configuration                              |
| `-p, --profile`                    | Suggest configured Docker Compose profiles                                       |
| `-f, --compose`, `-e, --env-file`  | Complete filesystem paths                                                        |
| `--health-timeout`                 | Suggest `30`, `60`, `120`, and `300` seconds                                     |
| `--auto-apply`, `--show-unchanged` | Complete flag names; neither takes a value                                       |
| `--no-sidecars`                    | Complete the flag name                                                           |
| Global `--output`                  | Complete `json`, `yaml`, `csv`, `table`, or `text`                               |

The generated templates are tested against the registered command options, so all three shells
must gain new reconciliation options together. `--auto-apply` remains the only reconciliation
mutation gate; completing it does not imply global `--yes`, and a generated command without
explicit authorization remains report-only. See
[rfapps Reconcile Command](rfapps-reconcile-command.md) for the operator contract.

### Managed Update Completion Behavior

Bash, Zsh, and Fish generate the same `rfapps update` option surface. The shells provide values
according to the option type:

| Options                                                       | Completion behavior                                                                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `-s, --service`, `--services`                                 | Suggest configured services plus services discovered from the local Compose file; `--services` preserves comma-separated prefixes |
| `-g, --group`                                                 | Suggest groups from the loaded rfapps configuration                                                                               |
| `-p, --profile`                                               | Suggest configured Docker Compose profiles                                                                                        |
| `--from-plan`, `-o, --out`, `-f, --compose`, `-e, --env-file` | Complete filesystem paths                                                                                                         |
| `--health-timeout`                                            | Suggest common values: `30`, `60`, `120`, and `300` seconds                                                                       |
| Global `--output`                                             | Complete the supported enum: `json`, `yaml`, `csv`, `table`, or `text`                                                            |
| `--apply`, `--no-sidecars`, `--no-restore-on-failure`         | Complete the flag name; these options take no value                                                                               |

Completion only inserts command text. It does not run image detection, authorize mutation, answer a
confirmation prompt, or execute an update. A bare `rfapps update` remains preview-only; mutation
still requires running the command with `--apply` and approving it, or explicitly supplying global
`--yes`. See the [rfapps update command reference](../../packages/rfapps-cli/README.md#update) for
the preview, approval, verification, and image-only recovery contract.

### Harden Completion Behavior

Bash, Zsh, and Fish generate the same `rfapps harden` option surface as Commander:

```text
--service --services --group --no-sidecars --apply --out --include-review
--rule --list-rules --no-backup --allow-reformat --compose --env-file --profile
--json
```

| Options                                                                                                     | Completion behavior                                                              |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `-s, --service`, `--services`                                                                               | Suggest configured services plus services discovered from the local Compose file |
| `-g, --group`                                                                                               | Suggest groups from the loaded rfapps configuration                              |
| `-p, --profile`                                                                                             | Suggest configured Docker Compose profiles                                       |
| `-o, --out`, `-f, --compose`, `-e, --env-file`                                                              | Complete filesystem paths                                                        |
| `--rule`                                                                                                    | Suggest the `harden-*` rule ids                                                  |
| `--apply`, `--include-review`, `--list-rules`, `--no-backup`, `--no-sidecars`, `--allow-reformat`, `--json` | Complete the flag name; these take no value                                      |

The negated spellings are what Commander registers, so the templates carry `--no-backup` and
`--no-sidecars`, not `--backup` or `--sidecars`. Completion only inserts command text: it never
resolves Compose, evaluates a rule, answers the `--apply` confirmation, or writes `compose.yml`. A
bare `rfapps harden` remains propose-only. See
[rfapps Harden Command](rfapps-harden-command.md) for the write contract.

### Service Groups

Service groups are completed when using the `--group` or `-g` option:

```bash
rfapps deploy --group <TAB>
# Shows: infra-stack vpn-stack media-stack arr-stack download-stack auth-stack photo-stack
```

| Group            | Description                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `infra-stack`    | Traefik + infrastructure tools (homarr, uptime-kuma, stirling-pdf, speedtest-tracker)          |
| `vpn-stack`      | VPN-enabled services (slskd)                                                                   |
| `media-stack`    | Media services (plex, kometa, tautulli, plexseerr, jellyseerr, sonarr, radarr, lidarr, bazarr) |
| `arr-stack`      | Automation services (sonarr, radarr, lidarr, bazarr, prowlarr)                                 |
| `download-stack` | Download clients (sabnzbd, nzbget, slskd, autobrr, unpackerr)                                  |
| `auth-stack`     | All Authentik services                                                                         |
| `photo-stack`    | All Immich services                                                                            |

### Docker Compose Profiles

Profiles are completed when using the `--profile` or `-p` option:

```bash
rfapps deploy --profile <TAB>
# Shows: core infrastructure downloads arr-stack media photos all
```

| Profile          | Description                           |
| ---------------- | ------------------------------------- |
| `core`           | Essential infrastructure (7 services) |
| `infrastructure` | Management tools (4 services)         |
| `downloads`      | Download clients (9 services)         |
| `arr-stack`      | Automation services (7 services)      |
| `media`          | Media servers (4 services)            |
| `photos`         | Photo management (4 services)         |
| `all`            | Complete deployment (35 services)     |

### File Path Completion

File paths are completed for options that require files:

```bash
rfapps deploy --compose <TAB>
# Completes file paths (compose.yml, etc.)

rfapps deploy --env-file <TAB>
# Completes file paths (.env, .env.local, etc.)

rfapps deploy --use-dotenvx <TAB>
# Completes file paths for environment files

rfapps update --from-plan <TAB>
# Completes saved managed-plan paths

rfapps update --out <TAB>
# Completes preview-plan or final-report output paths

rfapps backup --destination <TAB>
# Completes destination directory paths

rfapps backup verify <TAB>
# Completes manifest paths
```

### Health Timeout Values

The `--health-timeout` option suggests common timeout values:

```bash
rfapps deploy --health-timeout <TAB>
rfapps update --health-timeout <TAB>
rfapps reconcile --health-timeout <TAB>
# Shows: 30 60 120 300
```

### Staged Rollout Values

The staged deploy options complete their own value sets:

```bash
rfapps deploy --staged --batch-size <TAB>
# Shows: 1 2 3 5 10

rfapps deploy --staged --on-failure <TAB>
# Shows: halt continue
```

`--batch-size` accepts any positive integer; the suggestions are common choices, not the full set.
`--on-failure` is a closed choice list — Commander rejects anything else before the command runs.

### Diagnostic Severity Values

The `--fail-on` option for `audit` and `doctor` completes supported thresholds:

```bash
rfapps audit --fail-on <TAB>
rfapps doctor --fail-on <TAB>
# Shows: none info warn error critical
```

### Scanner and Severity Values

The vulnerability scanning options complete their own closed value sets:

```bash
rfapps plan --scan --scanner <TAB>
rfapps deploy --scan --scanner <TAB>
# Shows: trivy grype

rfapps deploy --scan --scan-fail-on <TAB>
# Shows: none unknown negligible low medium high critical
```

`--scan-fail-on` uses the CVE severity scale, which is deliberately different from `--fail-on`'s
compose severity scale on `audit`, `doctor`, and `lint`.

### Harden Rule Ids

`--rule` completes the `harden-*` rule catalog:

```bash
rfapps harden --rule <TAB>
# Shows: harden-no-new-privileges harden-restart-policy harden-log-rotation
#        harden-cap-drop-all harden-read-only-rootfs harden-run-as-non-root
#        harden-healthcheck harden-memory-limit harden-cpu-limit
```

`--rule` accepts a comma-separated list. Zsh completes each entry of the list; Bash and Fish complete
the first id only.

### Tag Completion Behavior

Bash, Zsh, and Fish expose the same read-only `tag` parent command and its `list`, `show`, and
`suggest` subcommands, plus the `--tag` narrowing flag on every command path that declares it.

| Context                             | Bash, Zsh, and Fish behavior                                     |
| ----------------------------------- | ---------------------------------------------------------------- |
| `rfapps tag <TAB>`                  | Suggest `list`, `show`, `suggest`                                |
| `rfapps <cmd> --tag <TAB>`          | Suggest known effective tag paths                                |
| `rfapps <cmd> --tag media/**,<TAB>` | Complete the segment after the last comma, preserving the prefix |
| `rfapps tag show --service <TAB>`   | Suggest resolved Compose services                                |
| `rfapps tag suggest --group <TAB>`  | Suggest configured service groups                                |
| `rfapps tag suggest --rule <TAB>`   | Suggest the `tag-infer-*` inference rule ids                     |
| `rfapps tag suggest --out <TAB>`    | Complete filesystem paths                                        |

Unlike `harden --rule`, **all three shells complete each comma segment of `--tag`**: Bash and Fish
split on the last comma and re-attach the prefix, and Zsh uses `_values -s ,`. That matters because
`--tag "media/**,photos/**"` is the normal way to express OR within one flag.

`show` is a token `drift` already owns, so Fish guards both directions: `rfapps tag show` completions
are suppressed once `drift` is on the line, and `rfapps drift show` completions are suppressed once
`tag` is. Without the reciprocal guard, `__fish_seen_subcommand_from show` would fire for both.

Completion inserts text only. Generating the script reads the merged rfapps configuration and
nothing else — no Docker calls, no state database, no compose resolution — so `--tag` completion
works on a host where Docker is unavailable.

### Tag Values

`--tag` completes the **ancestor-closed** set of effective tag paths, sorted and de-duplicated:

```bash
rfapps deploy --tag <TAB>
# Shows: hardware hardware/gpu infrastructure infrastructure/core
#        infrastructure/core/networking media media/streaming
```

The values are derived from the _values_ of `tags.mapping` (the tag paths), never from its keys (the
service names), and every ancestor of a declared path is offered as well — so a fleet tagged only at
depth three still completes `media` and `media/automation`.

`tag suggest --rule` completes the inference catalog, which is a different closed set:

```bash
rfapps tag suggest --rule <TAB>
# Shows: tag-infer-profile tag-infer-group tag-infer-arr tag-infer-database
#        tag-infer-cache tag-infer-ingress tag-infer-tailnet
```

`--rule` on every other command still completes the `harden-*` catalog; the two never mix.

Tag values are baked into the script at generation time, exactly like service names, groups, and
profiles. After editing the `tags:` section, regenerate the completion script — see
[Updating Completions](#updating-completions).

## Usage Examples

### Basic Command Completion

```bash
# Complete command name
rfapps dep<TAB>
# Completes to: rfapps deploy

# Complete option
rfapps deploy --ser<TAB>
# Shows: --service --services
```

### Service Group Operations

```bash
# Deploy entire media stack
rfapps deploy --group med<TAB>
# Completes to: rfapps deploy --group media-stack

# Rebuild authentication services
rfapps rebuild -g auth<TAB>
# Completes to: rfapps rebuild -g auth-stack
```

### Combined Options

```bash
# Deploy with multiple options
rfapps deploy --group media-stack --skip-<TAB>
# Completes to: rfapps deploy --group media-stack --skip-pull
```

## Troubleshooting

### Completions Not Working

1. **Verify installation**:

   ```bash
   # Bash
   ls -la ~/.bash_completion.d/rfapps

   # Zsh
   ls -la ~/.zfunc/_rfapps

   # Fish
   ls -la ~/.config/fish/completions/rfapps.fish
   ```

2. **Check shell configuration**:

   ```bash
   # Bash - ensure completion is sourced
   grep -r "bash_completion" ~/.bashrc

   # Zsh - ensure fpath is set
   echo $fpath
   ```

3. **Regenerate completions**:

   ```bash
   rfapps completion bash --install
   ```

### Zsh Completion Cache

Zsh caches completion functions. If completions are outdated:

```bash
# Remove completion cache
rm -f ~/.zcompdump*

# Rebuild cache
compinit
```

### Bash Completion Package

On some systems, bash-completion package must be installed:

```bash
# Debian/Ubuntu
sudo apt install bash-completion

# RHEL/CentOS
sudo dnf install bash-completion

# macOS (with Homebrew)
brew install bash-completion@2
```

### Fish Not Loading Completions

If Fish completions are not loading:

```bash
# Check Fish completion path
echo $fish_complete_path

# Verify file exists
ls ~/.config/fish/completions/rfapps.fish

# Force reload
fish_update_completions
```

## Updating Completions

When rfapps is updated with new commands or options, regenerate the completion scripts:

```bash
# Regenerate and replace the installed script
rfapps completion bash --install
rfapps completion zsh --install
rfapps completion fish --install
```

The install command creates the destination directory when needed and replaces the generated
completion file. Regenerate after upgrading rfapps whenever commands or options change. In
particular, older scripts must be regenerated to gain `backup`, nested `backup verify`, `update`,
`reconcile`, and `tag`, their complete option surfaces, and service, group, profile, tag, path, and
timeout suggestions.

Tag values are a second reason to regenerate: they are read from the merged configuration when the
script is written, so editing `tags.mapping` changes what `--tag <TAB>` offers only after the next
`rfapps completion <shell> --install`.

## Related Documentation

- [Quick Reference](quick-reference.md) - One-page command reference card
- [rfapps Update Command](../../packages/rfapps-cli/README.md#update) - Preview and managed image update workflow
- [rfapps Reconcile Command](rfapps-reconcile-command.md) - Report-first desired-versus-actual
  convergence
- [rfapps Native Backup](rfapps-backup.md) - Backup selection, safety, and verification contract
- [rfapps CLI Reference](../reference/rfapps-cli-reference.md) - Complete command documentation
- [Getting Started Guide](../guides/getting-started.md) - Initial setup walkthrough
- [Dry-Run Mode](dry-run-mode.md) - Preview actions without executing
- [JSON Output Mode](json-output.md) - Machine-readable output for scripting
- [Output Formats](output-formats.md) - Alternative output format support (JSON, YAML, CSV)
- [rfapps Audit Command](rfapps-audit-command.md) - Compose security posture audit
- [rfapps Harden Command](rfapps-harden-command.md) - Compose hardening proposals and `--apply`
- [rfapps Tag Selector](rfapps-tag-selector.md) - `--tag` pattern grammar and the `tag` command group
- [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md) - `--scan` on `plan` and `deploy`
- [rfapps Doctor Command](rfapps-doctor-command.md) - Unified read-only diagnostics
- [rfapps Drift Command](rfapps-drift-command.md) - Configuration and runtime drift detection
- [Secrets Management](secrets-management.md) - Environment variable encryption
