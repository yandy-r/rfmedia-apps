/**
 * Completion command action for rfapps CLI
 *
 * Generates shell completion scripts for bash, zsh, and fish.
 * Profiles and groups are loaded dynamically from the config file.
 */

import {
  logInfo,
  logSuccess,
  logDebug,
  logWarn,
  formatError,
  outputFormattedError,
} from "@rfmedia/common";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.js";
import { ConfigValidationError, InvalidArgumentError, ConfigNotFoundError } from "../lib/errors.js";
import { HARDEN_RULE_IDS } from "../lib/hardening.js";
// Imported by direct module path, never through the tags barrel or the lib barrel:
// the barrels additionally pull in the inference engine and the whole `lib` surface,
// which this action does not need. `tag-index.js` transitively imports the config
// module and `node:fs/promises`, so this module's spec must mock BOTH of those
// completely enough to satisfy those imports — see the mock factories at the top of
// `completion.spec.ts`.
import { TAG_INFERENCE_RULE_IDS } from "../lib/tags/tag-inference-rules.js";
import { assertTagList, assertTagMapping } from "../lib/tags/tag-index.js";
import { compareTags, normalizeTag, tagAncestors } from "../lib/tags/tag-path.js";
import type { RfappsConfig, TagPath } from "../types/index.js";

type SupportedShell = "bash" | "zsh" | "fish";

interface CompletionOptions {
  shell?: string;
  install?: boolean;
  force?: boolean;
}

/**
 * Space-separated harden rule ids, interpolated into the `--rule` value
 * completion of every shell. Derived from the rule registry so a new rule is
 * completable without editing three templates.
 */
const hardenRuleIds = HARDEN_RULE_IDS.join(" ");

/**
 * Space-separated tag inference rule ids, interpolated into the `--rule` value
 * completion of `rfapps tag suggest` in every shell. Derived from the catalog so a
 * new rule is completable without editing three templates.
 */
const tagRuleIds = TAG_INFERENCE_RULE_IDS.join(" ");

/**
 * How `tags.mapping` is attributed in a completion-time diagnostic.
 *
 * The winning config layer path is deliberately not named: `executeCompletion` may call only
 * `loadConfig()`, so the source is described instead and the operator is pointed at
 * `rfapps tag list`, which does name the file.
 */
const TAG_COMPLETION_SOURCE = "the merged rfapps configuration";

/**
 * Origin passed to `normalizeTag` while deriving completion values.
 *
 * Config flavour, matching `buildTagIndex`, so an authored tag is judged legal here by
 * exactly the rule the selector will apply.
 */
const TAG_COMPLETION_ORIGIN = {
  kind: "config",
  source: TAG_COMPLETION_SOURCE,
  field: "tags.mapping",
} as const;

/**
 * Space-separated tag values for the `--tag` completion of every shell.
 *
 * Derived from the **values** of `config.tags.mapping`, never its keys: the mapping
 * is service-keyed, so `Object.keys` would offer service names as tag completions.
 * The values are then ancestor-closed — a service declared `media/streaming` also
 * makes `media` selectable — sorted hierarchically, and deduped, so the completion
 * offers exactly the set `--tag` can match.
 *
 * **Never throws.** `executeCompletion` runs from shell startup (`eval "$(rfapps completion
 * zsh)"`), where an unhandled error breaks every new shell, so a malformed taxonomy degrades
 * the completion instead of the shell. The warning goes to stderr via `logWarn`, so it can
 * never corrupt the script on stdout.
 *
 * Legality is decided by `assertTagMapping` and `assertTagList` from `lib/tags/tag-index.ts` —
 * the **same** two guards `buildTagIndex` applies — rather than by a private mirror of them
 * here. A second copy is precisely how the container check came to exist on the selector
 * surface and not on this one: `Object.entries(42)` is `[]`, so a `mapping: 42` used to yield
 * an empty taxonomy in total silence here while `rfapps tag list` hard-errored on the very
 * same file. Both guards throw `ConfigValidationError`, whose `reason` is renderable, so this
 * caller consumes them inside the `try` it already had and degrades instead of throwing.
 *
 * The degrade is deliberately **all-or-nothing**: `buildTagIndex` rejects the whole
 * `tags.mapping` when any entry is malformed, so with one bad entry *no* tag is usable and
 * emitting the entries that happen to parse would advertise values `rfapps tag list` and
 * `rfapps stop --tag …` hard-error on. Completion offers tags only when the entire taxonomy
 * would build — the two surfaces never contradict each other about what is legal.
 *
 * @param config - The loaded configuration
 * @returns Space-separated canonical tag paths, or `""` when nothing is tagged or the
 *   taxonomy is malformed
 */
function deriveTagValues(config: RfappsConfig): string {
  const closure = new Set<TagPath>();

  try {
    // Container first: an absent/null `tags.mapping` normalizes to `{}` (a project that has
    // not adopted tags), and any other non-mapping shape is rejected before anything reads
    // keys off it.
    const mapping = assertTagMapping(config.tags?.mapping, TAG_COMPLETION_SOURCE);

    for (const [service, authoredTags] of Object.entries(mapping)) {
      for (const authored of assertTagList(authoredTags, service, TAG_COMPLETION_SOURCE)) {
        for (const ancestor of tagAncestors(normalizeTag(authored, TAG_COMPLETION_ORIGIN))) {
          closure.add(ancestor);
        }
      }
    }
  } catch (error) {
    const reason = describeTagFailure(error);
    logWarn(
      `Omitting --tag completion values: 'tags.mapping' is malformed (${reason}). ` +
        `Run 'rfapps tag list' for the full error and the config file it comes from.`,
    );
    return "";
  }

  return [...closure].sort(compareTags).join(" ");
}

/**
 * Renders a tag guard failure as one clause for the completion warning.
 *
 * `ConfigValidationError.message` is prefixed with "Invalid configuration: ", which reads as
 * noise once it is nested inside a sentence that already says the mapping is malformed, so the
 * bare `reason` is used for that class and `message` for anything else.
 */
function describeTagFailure(error: unknown): string {
  if (error instanceof ConfigValidationError) {
    return error.reason;
  }

  return error instanceof Error ? error.message : String(error);
}

/**
 * Generate Bash completion script
 */
function generateBashCompletion(config: RfappsConfig): string {
  const profiles = config.profiles.validProfiles.join(" ");
  const groups = Object.keys(config.groups).join(" ");
  const services = Object.keys(config.profiles.mapping).join(" ");
  const tagValues = deriveTagValues(config);

  return `# rfapps shell completion
# Generated by rfapps completion bash
# Add to ~/.bashrc or source directly

_rfapps_completions() {
  local cur prev words cword
  _init_completion || return

  local commands="status health pull build deploy stop rebuild delete prune plan update reconcile import backup apply history rollback drift lint audit harden doctor force-unlock completion init validate mcp state tag"
  local global_opts="--dry-run --debug --json --output --verbose --yes --use-dotenvx --use-op --help --version"

  # Status command options
  local status_opts="--service --services --tag --all --health --stats --logs --compose --env-file"

  # Pull command options
  local pull_opts="--service --services --group --tag --no-sidecars --compose --env-file --profile"

  # Build command options
  local build_opts="--service --services --group --tag --no-sidecars --skip-pull --compose --env-file --profile"

  # Deploy command options
  local deploy_opts="--service --services --group --tag --no-sidecars --skip-pull --force-recreate --validate-first --scan --scanner --scan-fail-on --allow-partial --parallel --workers --staged --batch-size --on-failure --wait-for-ready --no-wait-for-ready --health-timeout --compose --env-file --profile"

  # Stop command options
  local stop_opts="--service --services --group --tag --no-sidecars --compose --env-file"

  # Rebuild command options
  local rebuild_opts="--service --services --group --tag --no-sidecars --skip-pull --parallel --workers --wait-for-ready --no-wait-for-ready --health-timeout --compose --env-file --profile"

  # Health command options
  local health_opts="--service --services --group --tag --no-sidecars --wait-for-ready --no-wait-for-ready --health-timeout --compose --env-file --profile"

  # Delete command options
  local delete_opts="--service --services --group --tag --no-sidecars --volumes --images --compose --env-file"

  # Prune command options
  local prune_opts="--service --services --group --tag --no-sidecars --images --volumes --compose --env-file"

  # Plan command options
  local plan_opts="--service --services --group --tag --no-sidecars --apply --out --show-unchanged --check-updates --explain --scan --scanner --scan-fail-on --compose --env-file --profile"

  # Update command options
  local update_opts="--service --services --group --tag --no-sidecars --apply --from-plan --out --no-restore-on-failure --health-timeout --compose --env-file --profile"

  # Reconcile command options
  local reconcile_opts="--service --services --group --tag --no-sidecars --auto-apply --show-unchanged --health-timeout --compose --env-file --profile"

  # Import command options
  local import_opts="--service --services --group --tag --no-sidecars --adopt --show-tracked --compose --env-file --profile"

  # Backup creation options
  local backup_opts="--service --services --group --tag --all --no-sidecars --destination --compose --env-file --profile"

  # Apply command options
  local apply_opts="--force"

  # Init command options
  local init_opts="--global --json --force"

  # Completion command options
  local completion_opts="--shell --install --force"

  # Validate command options
  local validate_opts="--compose --env-file"

  # History command options
  local history_opts="--service --limit --since --action --generations"

  # Rollback command options
  local rollback_opts="--service --steps --to-deployment --to-generation --to-time --force"

  # Drift command options
  local drift_detect_opts="--service --services --group --tag --no-sidecars --show-unchanged --report-only --compose --env-file --profile"
  local drift_show_opts="--service --report-only --compose --env-file --profile"
  local drift_reconcile_opts="--service --services --group --tag --no-sidecars --compose --env-file --profile"
  local drift_import_opts="--service --services --group --tag --no-sidecars --backup --compose --env-file --profile"

  # State command options
  local state_export_opts="--out"
  local state_rebuild_opts="--mode --rewrite --confirm-project --running-only --backup-dir --show-unchanged --compose --env-file --profile"

  # Lint command options
  local lint_opts="--service --services --group --tag --no-sidecars --compose --env-file --profile --json --sarif --runtime --list-rules --fail-on"

  # Audit command options
  local audit_opts="--service --services --group --tag --no-sidecars --compose --env-file --profile --json --fail-on"

  # Harden command options
  local harden_opts="--service --services --group --tag --no-sidecars --apply --out --include-review --rule --list-rules --no-backup --allow-reformat --compose --env-file --profile --json"

  # Doctor command options
  local doctor_opts="--service --services --group --tag --no-sidecars --check-updates --fail-on --compose --env-file --profile"

  # Tag command options (read-only inspection group)
  local tag_list_opts="--tree --compose --env-file --profile --json"
  local tag_show_opts="--service --services --compose --env-file --profile --json"
  local tag_suggest_opts="--service --services --group --rule --list-rules --include-tagged --out --compose --env-file --profile --json"

  # Profile choices (loaded from config)
  local profiles="${profiles}"

  # Service groups (loaded from config)
  local groups="${groups}"

  # Service names (loaded from config at generation time)
  local services="${services}"

  # Effective tag paths, ancestor-closed (loaded from config at generation time)
  local tags="${tagValues}"

  # Tag inference rule ids for tag suggest --rule
  local tag_rules="${tagRuleIds}"

  # Completion shell choices
  local shells="bash zsh fish"

  # Classify backup verify only when it is the first unconsumed positional.
  __rfapps_find_backup_subcommand() {
    local backup_index="\$1"
    local expect_value=false
    local word
    local j
    for ((j=backup_index + 1; j < cword; j++)); do
      word="\${words[j]}"
      if [[ "\$expect_value" == "true" ]]; then
        expect_value=false
        continue
      fi
      case "\$word" in
        -s|--service|--services|-g|--group|--tag|--destination|-f|--compose|-e|--env-file|-p|--profile|--output|--use-dotenvx|--use-op)
          expect_value=true
          ;;
        --service=*|--services=*|--group=*|--tag=*|--destination=*|--compose=*|--env-file=*|--profile=*|--output=*|--use-dotenvx=*|--use-op=*|-s?*|-g?*|-f?*|-e?*|-p?*)
          ;;
        --)
          if [[ \$((j + 1)) -lt \$cword ]] && [[ "\${words[j+1]}" == "verify" ]]; then
            echo "verify"
          fi
          return
          ;;
        -*)
          ;;
        *)
          if [[ "\$word" == "verify" ]]; then
            echo "verify"
          fi
          return
          ;;
      esac
    done
  }

  # Determine the command being used
  local cmd=""
  local subcmd=""
  for ((i=1; i < cword; i++)); do
    case "\${words[i]}" in
      status|health|pull|build|deploy|stop|rebuild|delete|prune|plan|update|reconcile|import|backup|apply|history|rollback|drift|lint|audit|harden|doctor|force-unlock|completion|init|validate|mcp|state|tag)
        cmd="\${words[i]}"
        # Check for drift subcommands
        if [[ "\$cmd" == "drift" ]] && [[ \$((i + 1)) -lt \$cword ]]; then
          case "\${words[i+1]}" in
            detect|show|reconcile|import)
              subcmd="\${words[i+1]}"
              ;;
          esac
        elif [[ "\$cmd" == "state" ]] && [[ \$((i + 1)) -lt \$cword ]]; then
          case "\${words[i+1]}" in
            export|rebuild)
              subcmd="\${words[i+1]}"
              ;;
          esac
        elif [[ "\$cmd" == "tag" ]] && [[ \$((i + 1)) -lt \$cword ]]; then
          case "\${words[i+1]}" in
            list|show|suggest)
              subcmd="\${words[i+1]}"
              ;;
          esac
        elif [[ "\$cmd" == "backup" ]]; then
          subcmd=\$(__rfapps_find_backup_subcommand "\$i")
        fi
        break
        ;;
    esac
  done

  # Helper: build all_services (static + dynamic) and set COMPREPLY for service completion
  # For --services (comma-separated list), completes only the segment after the last comma.
  # --no-interpolate lists names without resolving variables: plain 'config --services'
  # fails (exit 1, no names) when vars are unset or dotenvx-encrypted, killing the only
  # fallback that covers services added after the script was generated.
  __rfapps_service_completion() {
    local static_services="\$services"
    local dynamic_services=""
    if command -v docker &>/dev/null && [[ -f "compose.yml" || -f "docker-compose.yml" ]]; then
      dynamic_services=\$(timeout 0.5s docker compose config --no-interpolate --services 2>/dev/null || true)
    fi
    local all_services="\$static_services \$dynamic_services"
    all_services=\$(echo "\$all_services" | tr ' ' '\\n' | sort -u | tr '\\n' ' ')
    local segment="\$cur"
    local prefix=""
    if [[ "\$prev" == "--services" ]] && [[ "\$cur" == *,* ]]; then
      prefix="\${cur%,*}"
      segment="\${cur##*,}"
    fi
    COMPREPLY=(\$(compgen -W "\$all_services" -- "\$segment"))
    if [[ -n "\$prefix" ]]; then
      COMPREPLY=("\${COMPREPLY[@]/#/\$prefix,}")
    fi
  }

  # Helper: set COMPREPLY for --tag, which is comma-separated like --services.
  # Only the segment after the last comma is completed; the earlier segments are
  # re-attached as a prefix so the whole token stays intact.
  __rfapps_tag_completion() {
    local segment="\$cur"
    local prefix=""
    if [[ "\$cur" == *,* ]]; then
      prefix="\${cur%,*}"
      segment="\${cur##*,}"
    fi
    COMPREPLY=(\$(compgen -W "\$tags" -- "\$segment"))
    if [[ -n "\$prefix" ]]; then
      COMPREPLY=("\${COMPREPLY[@]/#/\$prefix,}")
    fi
  }

  # Complete based on context
  case "\$prev" in
    --profile|-p)
      COMPREPLY=(\$(compgen -W "\$profiles" -- "\$cur"))
      return
      ;;
    --group|-g)
      COMPREPLY=(\$(compgen -W "\$groups" -- "\$cur"))
      return
      ;;
    --shell)
      # -s is only --shell for rfapps completion; for other commands -s is --service
      COMPREPLY=(\$(compgen -W "\$shells" -- "\$cur"))
      return
      ;;
    -s)
      if [[ "\$cmd" == "completion" ]]; then
        COMPREPLY=(\$(compgen -W "\$shells" -- "\$cur"))
      else
        __rfapps_service_completion
      fi
      return
      ;;
    --output)
      COMPREPLY=(\$(compgen -W "json yaml csv table text" -- "\$cur"))
      return
      ;;
    --mode)
      COMPREPLY=(\$(compgen -W "salvage runtime-only" -- "\$cur"))
      return
      ;;
    --destination)
      _filedir -d
      return
      ;;
    --compose|-f|--env-file|-e|--use-dotenvx|--use-op|--from-plan|--out|-o|--backup-dir)
      _filedir
      return
      ;;
    --service|--services)
      __rfapps_service_completion
      return
      ;;
    --tag)
      __rfapps_tag_completion
      return
      ;;
    --health-timeout)
      COMPREPLY=(\$(compgen -W "30 60 120 300" -- "\$cur"))
      return
      ;;
    --action)
      COMPREPLY=(\$(compgen -W "deploy rebuild delete rollback apply prune import" -- "\$cur"))
      return
      ;;
    --limit)
      COMPREPLY=(\$(compgen -W "5 10 20 50 100" -- "\$cur"))
      return
      ;;
    --steps)
      COMPREPLY=(\$(compgen -W "1 2 3 5 10" -- "\$cur"))
      return
      ;;
    --batch-size)
      COMPREPLY=(\$(compgen -W "1 2 3 5 10" -- "\$cur"))
      return
      ;;
    --on-failure)
      COMPREPLY=(\$(compgen -W "halt continue" -- "\$cur"))
      return
      ;;
    --to-deployment|--to-generation|--to-time)
      return
      ;;
    --fail-on)
      if [[ "\$cmd" == "doctor" || "\$cmd" == "audit" ]]; then
        COMPREPLY=(\$(compgen -W "none info warn error critical" -- "\$cur"))
      else
        COMPREPLY=(\$(compgen -W "none info warn error" -- "\$cur"))
      fi
      return
      ;;
    --scanner)
      COMPREPLY=(\$(compgen -W "trivy grype" -- "\$cur"))
      return
      ;;
    --scan-fail-on)
      COMPREPLY=(\$(compgen -W "none unknown negligible low medium high critical" -- "\$cur"))
      return
      ;;
    --rule)
      # --rule names harden rules everywhere except tag suggest, where it names
      # tag inference rules.
      if [[ "\$cmd" == "tag" ]]; then
        COMPREPLY=(\$(compgen -W "\$tag_rules" -- "\$cur"))
      else
        COMPREPLY=(\$(compgen -W "${hardenRuleIds}" -- "\$cur"))
      fi
      return
      ;;
  esac

  # Complete plan file path for apply command
  if [[ "\$cmd" == "apply" ]] && [[ "\$cur" != -* ]]; then
    _filedir
    return
  fi

  # Complete the offline verifier's manifest operand.
  if [[ "\$cmd" == "backup" ]] && [[ "\$subcmd" == "verify" ]] && [[ "\$cur" != -* ]]; then
    _filedir
    return
  fi

  # Complete command or options based on position
  if [[ -z "\$cmd" ]]; then
    if [[ "\$cur" == -* ]]; then
      COMPREPLY=(\$(compgen -W "\$global_opts" -- "\$cur"))
    else
      COMPREPLY=(\$(compgen -W "\$commands" -- "\$cur"))
    fi
  else
    case "\$cmd" in
      status)
        COMPREPLY=(\$(compgen -W "\$status_opts \$global_opts" -- "\$cur"))
        ;;
      health)
        COMPREPLY=(\$(compgen -W "\$health_opts \$global_opts" -- "\$cur"))
        ;;
      pull)
        COMPREPLY=(\$(compgen -W "\$pull_opts \$global_opts" -- "\$cur"))
        ;;
      build)
        COMPREPLY=(\$(compgen -W "\$build_opts \$global_opts" -- "\$cur"))
        ;;
      deploy)
        COMPREPLY=(\$(compgen -W "\$deploy_opts \$global_opts" -- "\$cur"))
        ;;
      stop)
        COMPREPLY=(\$(compgen -W "\$stop_opts \$global_opts" -- "\$cur"))
        ;;
      rebuild)
        COMPREPLY=(\$(compgen -W "\$rebuild_opts \$global_opts" -- "\$cur"))
        ;;
      delete)
        COMPREPLY=(\$(compgen -W "\$delete_opts \$global_opts" -- "\$cur"))
        ;;
      prune)
        COMPREPLY=(\$(compgen -W "\$prune_opts \$global_opts" -- "\$cur"))
        ;;
      plan)
        COMPREPLY=(\$(compgen -W "\$plan_opts \$global_opts" -- "\$cur"))
        ;;
      update)
        COMPREPLY=(\$(compgen -W "\$update_opts \$global_opts" -- "\$cur"))
        ;;
      reconcile)
        COMPREPLY=(\$(compgen -W "\$reconcile_opts \$global_opts" -- "\$cur"))
        ;;
      import)
        COMPREPLY=(\$(compgen -W "\$import_opts \$global_opts" -- "\$cur"))
        ;;
      backup)
        if [[ "\$subcmd" == "verify" ]]; then
          COMPREPLY=(\$(compgen -W "\$global_opts" -- "\$cur"))
        elif [[ "\$cur" == -* ]]; then
          COMPREPLY=(\$(compgen -W "\$backup_opts \$global_opts" -- "\$cur"))
        else
          COMPREPLY=(\$(compgen -W "verify" -- "\$cur"))
        fi
        ;;
      apply)
        if [[ "\$cur" == -* ]]; then
          COMPREPLY=(\$(compgen -W "\$apply_opts \$global_opts" -- "\$cur"))
        else
          _filedir
        fi
        ;;
      completion)
        if [[ "\$cur" == -* ]]; then
          COMPREPLY=(\$(compgen -W "\$completion_opts \$global_opts" -- "\$cur"))
        else
          COMPREPLY=(\$(compgen -W "\$shells" -- "\$cur"))
        fi
        ;;
      init)
        COMPREPLY=(\$(compgen -W "\$init_opts \$global_opts" -- "\$cur"))
        ;;
      validate)
        COMPREPLY=(\$(compgen -W "\$validate_opts \$global_opts" -- "\$cur"))
        ;;
      mcp)
        COMPREPLY=(\$(compgen -W "\$global_opts" -- "\$cur"))
        ;;
      history)
        COMPREPLY=(\$(compgen -W "\$history_opts \$global_opts" -- "\$cur"))
        ;;
      rollback)
        COMPREPLY=(\$(compgen -W "\$rollback_opts \$global_opts" -- "\$cur"))
        ;;
      lint)
        COMPREPLY=(\$(compgen -W "\$lint_opts \$global_opts" -- "\$cur"))
        ;;
      audit)
        COMPREPLY=(\$(compgen -W "\$audit_opts \$global_opts" -- "\$cur"))
        ;;
      harden)
        COMPREPLY=(\$(compgen -W "\$harden_opts \$global_opts" -- "\$cur"))
        ;;
      doctor)
        COMPREPLY=(\$(compgen -W "\$doctor_opts \$global_opts" -- "\$cur"))
        ;;
      force-unlock)
        COMPREPLY=(\$(compgen -W "\$global_opts" -- "\$cur"))
        ;;
      drift)
        if [[ -z "\$subcmd" ]]; then
          # No subcommand yet, suggest subcommands or global opts
          if [[ "\$cur" == -* ]]; then
            COMPREPLY=(\$(compgen -W "\$global_opts" -- "\$cur"))
          else
            COMPREPLY=(\$(compgen -W "detect show reconcile import" -- "\$cur"))
          fi
        else
          # Within a drift subcommand
          case "\$subcmd" in
            detect)
              COMPREPLY=(\$(compgen -W "\$drift_detect_opts \$global_opts" -- "\$cur"))
              ;;
            show)
              COMPREPLY=(\$(compgen -W "\$drift_show_opts \$global_opts" -- "\$cur"))
              ;;
            reconcile)
              COMPREPLY=(\$(compgen -W "\$drift_reconcile_opts \$global_opts" -- "\$cur"))
              ;;
            import)
              COMPREPLY=(\$(compgen -W "\$drift_import_opts \$global_opts" -- "\$cur"))
              ;;
          esac
        fi
        ;;
      state)
        if [[ -z "\$subcmd" ]]; then
          # No subcommand yet, suggest subcommands or global opts
          if [[ "\$cur" == -* ]]; then
            COMPREPLY=(\$(compgen -W "\$global_opts" -- "\$cur"))
          else
            COMPREPLY=(\$(compgen -W "export rebuild" -- "\$cur"))
          fi
        else
          # Within a state subcommand
          case "\$subcmd" in
            export)
              COMPREPLY=(\$(compgen -W "\$state_export_opts \$global_opts" -- "\$cur"))
              ;;
            rebuild)
              COMPREPLY=(\$(compgen -W "\$state_rebuild_opts \$global_opts" -- "\$cur"))
              ;;
          esac
        fi
        ;;
      tag)
        if [[ -z "\$subcmd" ]]; then
          # No subcommand yet, suggest subcommands or global opts
          if [[ "\$cur" == -* ]]; then
            COMPREPLY=(\$(compgen -W "\$global_opts" -- "\$cur"))
          else
            COMPREPLY=(\$(compgen -W "list show suggest" -- "\$cur"))
          fi
        else
          # Within a tag subcommand
          case "\$subcmd" in
            list)
              COMPREPLY=(\$(compgen -W "\$tag_list_opts \$global_opts" -- "\$cur"))
              ;;
            show)
              COMPREPLY=(\$(compgen -W "\$tag_show_opts \$global_opts" -- "\$cur"))
              ;;
            suggest)
              COMPREPLY=(\$(compgen -W "\$tag_suggest_opts \$global_opts" -- "\$cur"))
              ;;
          esac
        fi
        ;;
    esac
  fi
}

complete -F _rfapps_completions rfapps
`;
}

/**
 * Generate Zsh completion script
 */
function generateZshCompletion(config: RfappsConfig): string {
  const profiles = config.profiles.validProfiles.join(" ");
  const groups = Object.keys(config.groups).join(" ");
  const services = Object.keys(config.profiles.mapping).join(" ");
  const tagValues = deriveTagValues(config);
  // zsh's `_values` requires a description **plus at least one value spec**, so an
  // empty taxonomy cannot be interpolated into a fixed `_values` call: every
  // `--tag <TAB>` would abort with `_values:compvalues: not enough arguments`. That
  // is the shipped default — `rfapps.config.yaml` ships its `tags:` block commented
  // out — and bash/fish degrade silently on the same config, so a fixed call would
  // be a zsh-only parity break on day one. An empty action is a valid `_arguments`
  // spec meaning "this option takes a value with no completion".
  const zshTagAction = tagValues.length > 0 ? `_values -s , tag ${tagValues}` : "";
  return `#compdef rfapps
# rfapps shell completion
# Generated by rfapps completion zsh
# Install to ~/.zfunc/_rfapps and add: fpath=(~/.zfunc $fpath); autoload -Uz compinit && compinit

_rfapps() {
  local curcontext="$curcontext" state line ret=1
  typeset -A opt_args

  local -a commands
  commands=(
    'status:Show status of Docker services'
    'health:Check service dependency readiness'
    'pull:Pull Docker images'
    'build:Build Docker containers'
    'deploy:Deploy Docker services'
    'stop:Stop Docker services'
    'rebuild:Rebuild Docker services'
    'delete:Delete Docker services'
    'prune:Prune Docker resources'
    'plan:Generate deployment plan showing what will change'
    'update:Preview and apply verified Docker image updates'
    'reconcile:Report and optionally reconcile Docker Compose drift'
    'import:Adopt externally-created running services into rfapps state tracking'
    'backup:Create and verify cold filesystem backup bundles'
    'apply:Apply a saved deployment plan'
    'history:Show deployment history for services'
    'rollback:Rollback a service to a previous deployment'
    'drift:Detect and manage configuration drift'
    'lint:Check compose configuration for production-readiness issues'
    'audit:Run read-only Docker Compose security posture audit'
    'harden:Propose or apply compose security hardening'
    'doctor:Run read-only unified diagnostics'
    'force-unlock:Remove the global state lock after operator confirmation'
    'completion:Generate shell completion scripts'
    'init:Generate configuration file from compose.yml'
    'validate:Validate configuration against compose.yml'
    'mcp:Run the rfapps MCP server over stdio'
    'state:Inspect, export, and reconstruct the rfapps state database'
    'tag:Inspect the hierarchical service tag taxonomy'
  )

  # Global options available to all commands
  local -a global_opts
  global_opts=(
    '--dry-run[Preview actions without executing]'
    '--debug[Enable debug output]'
    '--json[Output in JSON format]'
    '--output[Output format]:format:(json yaml csv table text)'
    '(-v --verbose)'{-v,--verbose}'[Show detailed output]'
    '(-y --yes)'{-y,--yes}'[Skip confirmation prompts]'
    '--use-dotenvx[Use dotenvx for secrets]:file:_files'
    '--use-op[Use 1Password CLI for secrets]:file:_files'
    '--help[Show help]'
    '--version[Show version]'
  )

  # Helper function to find the command from words array
  __rfapps_find_command() {
    local word
    for word in "\${words[@]}"; do
      case \$word in
        status|health|pull|build|deploy|stop|rebuild|delete|prune|plan|update|reconcile|import|backup|apply|history|rollback|drift|lint|audit|harden|doctor|force-unlock|completion|init|validate|mcp|state|tag)
          echo \$word
          return
          ;;
      esac
    done
  }

  # Helper function to get service names (hybrid: static + dynamic)
  __rfapps_get_services() {
    local static_services="${services}"
    local dynamic_services=""

    # Try to get live services from compose (with timeout).
    # --no-interpolate: plain config --services fails on unset/encrypted vars.
    if command -v docker &> /dev/null && [[ -f "compose.yml" || -f "docker-compose.yml" ]]; then
      dynamic_services=\$(timeout 0.5s docker compose config --no-interpolate --services 2>/dev/null || true)
    fi

    # Combine and deduplicate
    local all_services="\$static_services \$dynamic_services"
    echo "\$all_services" | tr ' ' '\\n' | sort -u | tr '\\n' ' '
  }

  # Comma-separated service list completion for --services
  __rfapps_services_values() {
    _values -S ',' 'service' \$(__rfapps_get_services)
  }

  # Only handle command selection here - options are handled by each command's _arguments
  _arguments -C \\
    '1: :->command' \\
    '*:: :->args' && ret=0

  case $state in
    command)
      _describe -t commands 'rfapps commands' commands
      ;;
    args)
      # Use helper function to find command reliably
      local cmd=\$(__rfapps_find_command)
      case \$cmd in
        status)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '(-a --all)'{-a,--all}'[Show all services]' \\
            '--health[Show health status]' \\
            '--stats[Show resource statistics]' \\
            '--logs[Show recent logs]' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files'
          ;;
        health)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--wait-for-ready[Wait for dependencies to become ready]' \\
            '--no-wait-for-ready[Return immediate dependency readiness snapshot]' \\
            '--health-timeout[Health check timeout]:seconds:(30 60 120 300)' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
        pull)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
        build)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--skip-pull[Skip pulling images before building]' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
        deploy)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--skip-pull[Skip pulling images before deploying]' \\
            '--force-recreate[Force recreate containers even if unchanged]' \\
            '--validate-first[Validate Docker resource conflicts before deploying]' \\
            '--scan[Scan resolved images for known vulnerabilities]' \\
            '--scanner[Scanner backend]:scanner:(trivy grype)' \\
            '--scan-fail-on[Block at or above severity]:severity:(none unknown negligible low medium high critical)' \\
            '--allow-partial[Exit 3 instead of 1 when a grouped or multi-service deploy partially succeeds]' \\
            '--parallel[Execute operations in parallel using dependency phases]' \\
            '--workers[Maximum concurrent workers for parallel execution]:count:' \\
            '--staged[Roll out in dependency-ordered batches]' \\
            '--batch-size[Services per staged batch]:count:(1 2 3 5 10)' \\
            '--on-failure[Staged batch failure policy]:policy:(halt continue)' \\
            '--wait-for-ready[Wait for dependencies to become ready]' \\
            '--no-wait-for-ready[Return immediate dependency readiness snapshot]' \\
            '--health-timeout[Health check timeout]:seconds:(30 60 120 300)' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
        rebuild)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--skip-pull[Skip pulling images before rebuilding]' \\
            '--parallel[Execute operations in parallel using dependency phases]' \\
            '--workers[Maximum concurrent workers for parallel execution]:count:' \\
            '--wait-for-ready[Wait for dependencies to become ready]' \\
            '--no-wait-for-ready[Return immediate dependency readiness snapshot]' \\
            '--health-timeout[Health check timeout]:seconds:(30 60 120 300)' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
        stop)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files'
          ;;
        delete)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--volumes[Also remove volumes]' \\
            '--images[Also remove images]' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files'
          ;;
        prune)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--images[Also prune images]' \\
            '--volumes[Also prune volumes]' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files'
          ;;
        plan)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--apply[Immediately apply the plan after generation]' \\
            '(-o --out)'{-o,--out}'[Custom plan output path]:file:_files' \\
            '--show-unchanged[Show unchanged services in output]' \\
            '--check-updates[Check registry for newer image versions]' \\
            '--explain[Annotate changes with likely cause and dependency impact]' \\
            '--scan[Scan resolved images for known vulnerabilities]' \\
            '--scanner[Scanner backend]:scanner:(trivy grype)' \\
            '--scan-fail-on[Block at or above severity]:severity:(none unknown negligible low medium high critical)' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
        update)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--apply[Apply the reviewed image update plan after confirmation]' \\
            '--from-plan[Load a saved managed update plan]:file:_files' \\
            '(-o --out)'{-o,--out}'[Write the preview plan or final update report]:file:_files' \\
            '--no-restore-on-failure[Continue without automatic exact-image restore if verification fails]' \\
            '--health-timeout[Target verification timeout]:seconds:(30 60 120 300)' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
        reconcile)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--auto-apply[Apply the reviewed reconciliation actions]' \\
            '--show-unchanged[Show unchanged services in output]' \\
            '--health-timeout[Target verification timeout]:seconds:(30 60 120 300)' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
        import)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--adopt[Record baseline snapshots for discovered services]' \\
            '--show-tracked[Include already-tracked and not-running services in the report]' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
        backup)
          local -a backup_commands
          backup_commands=(
            'verify:Verify a backup manifest and every declared archive offline'
          )
          __rfapps_find_backup_cmd() {
            local expect_value=0
            local seen_backup=0
            local word
            local index
            for ((index=1; index < CURRENT; index++)); do
              word="\${words[index]}"
              if (( ! seen_backup )); then
                if [[ "\$word" == "backup" ]]; then
                  seen_backup=1
                fi
                continue
              fi
              if (( expect_value )); then
                expect_value=0
                continue
              fi
              case "\$word" in
                -s|--service|--services|-g|--group|--tag|--destination|-f|--compose|-e|--env-file|-p|--profile|--output|--use-dotenvx|--use-op)
                  expect_value=1
                  ;;
                --service=*|--services=*|--group=*|--tag=*|--destination=*|--compose=*|--env-file=*|--profile=*|--output=*|--use-dotenvx=*|--use-op=*|-s?*|-g?*|-f?*|-e?*|-p?*)
                  ;;
                --)
                  if (( index + 1 < CURRENT )) && [[ "\${words[index+1]}" == "verify" ]]; then
                    echo "verify"
                  fi
                  return
                  ;;
                -*)
                  ;;
                *)
                  if [[ "\$word" == "verify" ]]; then
                    echo "verify"
                  fi
                  return
                  ;;
              esac
            done
          }
          local backup_cmd=\$(__rfapps_find_backup_cmd)
          if [[ "\$backup_cmd" == "verify" ]]; then
            _arguments \\
              \${global_opts[@]} \\
              '1:manifest file:_files'
          else
            _arguments -C \\
              \${global_opts[@]} \\
              '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
              '--services[Target multiple services]: :__rfapps_services_values' \\
              '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
              '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
              '--all[Target every Compose service explicitly]' \\
              '--no-sidecars[Disable automatic sidecar linking]' \\
              '--destination[Existing backup destination directory]:directory:_files -/' \\
              '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
              '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
              '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})' \\
              '1: :->backup_command'
            if [[ "\$state" == "backup_command" ]]; then
              _describe -t backup_commands 'backup commands' backup_commands
            fi
          fi
          ;;
        apply)
          _arguments \\
            \${global_opts[@]} \\
            '--force[Apply even if plan is stale]' \\
            '1:plan-file:_files -g "*.json"'
          ;;
        history)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Filter by service name]:service:(\$(__rfapps_get_services))' \\
            '--limit[Number of entries to show]:limit:(5 10 20 50 100)' \\
            '--since[Show entries after this date]:date:' \\
            '--action[Filter by action type]:action:(deploy rebuild delete rollback apply prune import)' \\
            '--generations[Show immutable generation snapshots instead of raw history]'
          ;;
        rollback)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Service to rollback]:service:(\$(__rfapps_get_services))' \\
            '--steps[Number of deployments to rollback]:steps:(1 2 3 5 10)' \\
            '--to-deployment[Rollback to specific deployment ID]:id:' \\
            '--to-generation[Restore to a specific generation number]:generation:' \\
            '--to-time[Restore to the generation active at this time]:timestamp:' \\
            '--force[Skip validation warnings]'
          ;;
        completion)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --shell)'{-s,--shell}'[Target shell]:shell:(bash zsh fish)' \\
            '--install[Install completion script]' \\
            '--force[Skip confirmation prompts]' \\
            '1:shell:(bash zsh fish)'
          ;;
        force-unlock)
          _arguments \\
            \${global_opts[@]}
          ;;
        init)
          _arguments \\
            \${global_opts[@]} \\
            '(-g --global)'{-g,--global}'[Write to global config (~/.rfapps.yaml)]' \\
            '--json[Generate JSON config instead of YAML]' \\
            '(-f --force)'{-f,--force}'[Overwrite existing config file]'
          ;;
        validate)
          _arguments \\
            \${global_opts[@]} \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files'
          ;;
        mcp)
          _arguments \\
            \${global_opts[@]}
          ;;
        lint)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--json[Output findings in JSON format]' \\
            '--sarif[Output findings in SARIF 2.1.0 format]' \\
            '--runtime[Include runtime drift findings from running containers]' \\
            '--list-rules[List available lint rules and exit]' \\
            '--fail-on[Exit when findings meet or exceed severity]:severity:(none info warn error)' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
        audit)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--json[Output findings in JSON format]' \\
            '--fail-on[Exit when findings meet or exceed severity]:severity:(none info warn error critical)' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
        harden)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--apply[Edit compose.yml in place after confirmation]' \\
            '(-o --out)'{-o,--out}'[Write a compose override fragment]:file:_files' \\
            '--include-review[Include review-confidence rules in written output]' \\
            '--rule[Restrict to specific rules]:rules:_values -s , rule ${hardenRuleIds}' \\
            '--list-rules[List available hardening rules and exit]' \\
            '--no-backup[Skip the compose.yml.bak copy taken before apply]' \\
            '--allow-reformat[Accept incidental YAML reformatting of untouched lines]' \\
            '--json[Output the harden result in JSON format]' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
        doctor)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--check-updates[Check registries for newer image versions]' \\
            '--fail-on[Exit when findings meet or exceed severity]:severity:(none info warn error critical)' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
        drift)
          local -a drift_commands
          drift_commands=(
            'detect:Show drifted services'
            'show:Show detailed drift for a service'
            'reconcile:Apply the safe shared reconciliation workflow'
            'import:Update compose.yml to match running containers'
          )
          # Helper to find drift subcommand
          __rfapps_find_drift_cmd() {
            local word
            for word in "\${words[@]}"; do
              case \$word in
                detect|show|reconcile|import) echo \$word; return ;;
              esac
            done
          }
          _arguments -C \\
            \${global_opts[@]} \\
            '1: :->drift_command' \\
            '*:: :->drift_args'
          case $state in
            drift_command)
              _describe -t drift_commands 'drift commands' drift_commands
              ;;
            drift_args)
              local drift_cmd=\$(__rfapps_find_drift_cmd)
              case \$drift_cmd in
                detect)
                  _arguments \\
                    \${global_opts[@]} \\
                    '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
                    '--services[Target multiple services]: :__rfapps_services_values' \\
                    '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
                    '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
                    '--no-sidecars[Disable automatic sidecar linking]' \\
                    '--show-unchanged[Show unchanged services]' \\
                    '--report-only[Always exit successfully when drift is found]' \\
                    '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
                    '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
                    '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
                  ;;
                show)
                  _arguments \\
                    \${global_opts[@]} \\
                    '(-s --service)'{-s,--service}'[Service to inspect]:service:(\$(__rfapps_get_services))' \\
                    '--report-only[Always exit successfully when drift is found]' \\
                    '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
                    '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
                    '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
                  ;;
                reconcile)
                  _arguments \\
                    \${global_opts[@]} \\
                    '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
                    '--services[Target multiple services]: :__rfapps_services_values' \\
                    '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
                    '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
                    '--no-sidecars[Disable automatic sidecar linking]' \\
                    '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
                    '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
                    '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
                  ;;
                import)
                  _arguments \\
                    \${global_opts[@]} \\
                    '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
                    '--services[Target multiple services]: :__rfapps_services_values' \\
                    '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
                    '--tag[Narrow targets by tag pattern]:tag:${zshTagAction}' \\
                    '--no-sidecars[Disable automatic sidecar linking]' \\
                    '--backup[Create a .bak backup of compose.yml]' \\
                    '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
                    '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
                    '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
                  ;;
              esac
              ;;
          esac
          ;;
        state)
          local -a state_commands
          state_commands=(
            'export:Write a consistent backup copy of the rfapps state database'
            'rebuild:Reconstruct the state database from Docker runtime and compose declarations'
          )
          # Helper to find state subcommand
          __rfapps_find_state_cmd() {
            local word
            for word in "\${words[@]}"; do
              case \$word in
                export|rebuild) echo \$word; return ;;
              esac
            done
          }
          _arguments -C \\
            \${global_opts[@]} \\
            '1: :->state_command' \\
            '*:: :->state_args'
          case $state in
            state_command)
              _describe -t state_commands 'state commands' state_commands
              ;;
            state_args)
              local state_cmd=\$(__rfapps_find_state_cmd)
              case \$state_cmd in
                export)
                  _arguments \\
                    \${global_opts[@]} \\
                    '(-o --out)'{-o,--out}'[Backup destination file]:file:_files'
                  ;;
                rebuild)
                  _arguments \\
                    \${global_opts[@]} \\
                    '--mode[Reconstruction mode]:mode:(salvage runtime-only)' \\
                    '--rewrite[Replace the state database with the reconstruction]' \\
                    '--confirm-project[Compose project name required by runtime-only]:project:' \\
                    '--running-only[Only reconstruct services whose container is running]' \\
                    '--backup-dir[Directory for the mandatory pre-rewrite backup]:directory:_files -/' \\
                    '--show-unchanged[Include carried, absent, and orphaned services]' \\
                    '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
                    '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
                    '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
                  ;;
              esac
              ;;
          esac
          ;;
        tag)
          local -a tag_commands
          tag_commands=(
            'list:List every effective tag and the services carrying it'
            'show:Show the declared and effective tags of specific services'
            'suggest:Infer a starter tag taxonomy from compose and configuration'
          )
          # Helper to find tag subcommand
          __rfapps_find_tag_cmd() {
            local word
            for word in "\${words[@]}"; do
              case \$word in
                list|show|suggest) echo \$word; return ;;
              esac
            done
          }
          _arguments -C \\
            \${global_opts[@]} \\
            '1: :->tag_command' \\
            '*:: :->tag_args'
          case $state in
            tag_command)
              _describe -t tag_commands 'tag commands' tag_commands
              ;;
            tag_args)
              local tag_cmd=\$(__rfapps_find_tag_cmd)
              case \$tag_cmd in
                list)
                  _arguments \\
                    \${global_opts[@]} \\
                    '--tree[Render the taxonomy as an indented tree]' \\
                    '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
                    '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
                    '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})' \\
                    '--json[Output in JSON format]'
                  ;;
                show)
                  _arguments \\
                    \${global_opts[@]} \\
                    '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
                    '--services[Target multiple services]: :__rfapps_services_values' \\
                    '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
                    '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
                    '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})' \\
                    '--json[Output in JSON format]'
                  ;;
                suggest)
                  _arguments \\
                    \${global_opts[@]} \\
                    '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
                    '--services[Target multiple services]: :__rfapps_services_values' \\
                    '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
                    '--rule[Restrict to specific inference rules]:rules:_values -s , rule ${tagRuleIds}' \\
                    '--list-rules[List available inference rules and exit]' \\
                    '--include-tagged[Include services whose tags are already present]' \\
                    '(-o --out)'{-o,--out}'[Write the YAML fragment to this path]:file:_files' \\
                    '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
                    '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
                    '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})' \\
                    '--json[Output in JSON format]'
                  ;;
              esac
              ;;
          esac
          ;;
      esac
      ;;
  esac
}

_rfapps "$@"
`;
}

/**
 * Generate Fish completion script
 */
function generateFishCompletion(config: RfappsConfig): string {
  const profiles = config.profiles.validProfiles.join(" ");
  const groups = Object.keys(config.groups).join(" ");
  const services = Object.keys(config.profiles.mapping).join(" ");
  const tagValues = deriveTagValues(config);
  return `# rfapps shell completion
# Generated by rfapps completion fish
# Install to ~/.config/fish/completions/rfapps.fish

# Disable file completions by default
complete -c rfapps -f

# Helper function to get service names (hybrid: static + dynamic)
function __rfapps_get_services
  # Static services from config (generated at completion script time)
  set -l static_services ${services}

  # Try to get live services from compose (with timeout)
  # Fish does not support &>; redirect stdout and stderr explicitly
  set -l dynamic_services ""
  if command -v docker > /dev/null 2> /dev/null; and test -f "compose.yml" -o -f "docker-compose.yml"
    set dynamic_services (timeout 0.5s docker compose config --no-interpolate --services 2>/dev/null; or true)
  end

  # Combine and deduplicate
  echo \$static_services \$dynamic_services | tr ' ' '\\n' | sort -u | tr '\\n' ' '
end

# Comma-separated service list: complete only the segment after the last comma
function __rfapps_complete_services_list
  set -l token (commandline -t 2>/dev/null)
  set -l parts (string split ',' -- \$token)
  set -l segment \$parts[-1]
  set -l prefix ""
  if test (count \$parts) -gt 1
    set prefix (string join ',' \$parts[1..-2])
  end
  set -l all (__rfapps_get_services)
  set -l services (string split ' ' \$all)
  for s in \$services
    if test -z "\$segment"; or string match -q "\$segment*" "\$s"
      if test -n "\$prefix"
        echo \$prefix","\$s
      else
        echo \$s
      end
    end
  end
end

# Comma-separated tag list: complete only the segment after the last comma
function __rfapps_complete_tags
  set -l all_tags ${tagValues}
  set -l token (commandline -t 2>/dev/null)
  set -l parts (string split ',' -- \$token)
  set -l segment \$parts[-1]
  set -l prefix ""
  if test (count \$parts) -gt 1
    set prefix (string join ',' \$parts[1..-2])
  end
  for t in \$all_tags
    if test -z "\$segment"; or string match -q "\$segment*" "\$t"
      if test -n "\$prefix"
        echo \$prefix","\$t
      else
        echo \$t
      end
    end
  end
end

# Recognize verify only as backup's first unconsumed positional token.
function __rfapps_seen_backup_verify
  set -l seen_backup 0
  set -l expect_value 0
  set -l options_ended 0
  for word in (commandline -opc)
    if test \$seen_backup -eq 0
      if test "\$word" = "backup"
        set seen_backup 1
      end
      continue
    end
    if test \$expect_value -eq 1
      set expect_value 0
      continue
    end
    if test \$options_ended -eq 1
      test "\$word" = "verify"
      return
    end
    switch "\$word"
      case -s --service --services -g --group --tag --destination -f --compose -e --env-file -p --profile --output --use-dotenvx --use-op
        set expect_value 1
      case '--service=*' '--services=*' '--group=*' '--tag=*' '--destination=*' '--compose=*' '--env-file=*' '--profile=*' '--output=*' '--use-dotenvx=*' '--use-op=*' '-s?*' '-g?*' '-f?*' '-e?*' '-p?*'
        continue
      case '--'
        set options_ended 1
      case '-*'
        continue
      case verify
        return 0
      case '*'
        return 1
    end
  end
  return 1
end

# Commands
complete -c rfapps -n "__fish_use_subcommand" -a "status" -d "Show status of Docker services"
complete -c rfapps -n "__fish_use_subcommand" -a "health" -d "Check service dependency readiness"
complete -c rfapps -n "__fish_use_subcommand" -a "pull" -d "Pull Docker images"
complete -c rfapps -n "__fish_use_subcommand" -a "build" -d "Build Docker containers"
complete -c rfapps -n "__fish_use_subcommand" -a "deploy" -d "Deploy Docker services"
complete -c rfapps -n "__fish_use_subcommand" -a "stop" -d "Stop Docker services"
complete -c rfapps -n "__fish_use_subcommand" -a "rebuild" -d "Rebuild Docker services"
complete -c rfapps -n "__fish_use_subcommand" -a "delete" -d "Delete Docker services"
complete -c rfapps -n "__fish_use_subcommand" -a "prune" -d "Prune Docker resources"
complete -c rfapps -n "__fish_use_subcommand" -a "plan" -d "Generate deployment plan showing what will change"
complete -c rfapps -n "__fish_use_subcommand" -a "update" -d "Preview and apply verified Docker image updates"
complete -c rfapps -n "__fish_use_subcommand" -a "reconcile" -d "Report and optionally reconcile Docker Compose drift"
complete -c rfapps -n "__fish_use_subcommand" -a "import" -d "Adopt externally-created running services into rfapps state tracking"
complete -c rfapps -n "__fish_use_subcommand" -a "backup" -d "Create and verify cold filesystem backup bundles"
complete -c rfapps -n "__fish_use_subcommand" -a "apply" -d "Apply a saved deployment plan"
complete -c rfapps -n "__fish_use_subcommand" -a "history" -d "Show deployment history for services"
complete -c rfapps -n "__fish_use_subcommand" -a "rollback" -d "Rollback a service to a previous deployment"
complete -c rfapps -n "__fish_use_subcommand" -a "drift" -d "Detect and manage configuration drift"
complete -c rfapps -n "__fish_use_subcommand" -a "lint" -d "Check compose configuration for production-readiness issues"
complete -c rfapps -n "__fish_use_subcommand" -a "audit" -d "Run read-only Docker Compose security posture audit"
complete -c rfapps -n "__fish_use_subcommand" -a "harden" -d "Propose or apply compose security hardening"
complete -c rfapps -n "__fish_use_subcommand" -a "doctor" -d "Run read-only unified diagnostics"
complete -c rfapps -n "__fish_use_subcommand" -a "force-unlock" -d "Remove the global state lock after operator confirmation"
complete -c rfapps -n "__fish_use_subcommand" -a "completion" -d "Generate shell completion scripts"
complete -c rfapps -n "__fish_use_subcommand" -a "init" -d "Generate configuration file from compose.yml"
complete -c rfapps -n "__fish_use_subcommand" -a "validate" -d "Validate configuration against compose.yml"
complete -c rfapps -n "__fish_use_subcommand" -a "mcp" -d "Run the rfapps MCP server over stdio"
complete -c rfapps -n "__fish_use_subcommand" -a "state" -d "Inspect, export, and reconstruct the rfapps state database"
complete -c rfapps -n "__fish_use_subcommand" -a "tag" -d "Inspect the hierarchical service tag taxonomy"

# Global options
complete -c rfapps -l dry-run -d "Preview actions without executing"
complete -c rfapps -l debug -d "Enable debug output"
complete -c rfapps -l json -d "Output in JSON format"
complete -c rfapps -l output -d "Output format" -xa "json yaml csv table text"
complete -c rfapps -s v -l verbose -d "Show detailed output"
complete -c rfapps -s y -l yes -d "Skip confirmation prompts"
complete -c rfapps -l use-dotenvx -d "Use dotenvx for secrets" -r
complete -c rfapps -l use-op -d "Use 1Password CLI for secrets" -r
complete -c rfapps -s h -l help -d "Show help"
complete -c rfapps -s V -l version -d "Show version"

# Status command options
complete -c rfapps -n "__fish_seen_subcommand_from status" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from status" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from status" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from status" -s a -l all -d "Show all services"
complete -c rfapps -n "__fish_seen_subcommand_from status" -l health -d "Show health status"
complete -c rfapps -n "__fish_seen_subcommand_from status" -l stats -d "Show resource statistics"
complete -c rfapps -n "__fish_seen_subcommand_from status" -l logs -d "Show recent logs"
complete -c rfapps -n "__fish_seen_subcommand_from status" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from status" -s e -l env-file -d "Environment file" -r

# Pull command options
complete -c rfapps -n "__fish_seen_subcommand_from pull" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from pull" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from pull" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from pull" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from pull" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from pull" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from pull" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from pull" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Build command options
complete -c rfapps -n "__fish_seen_subcommand_from build" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from build" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from build" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from build" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from build" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from build" -l skip-pull -d "Skip pulling images before building"
complete -c rfapps -n "__fish_seen_subcommand_from build" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from build" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from build" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Deploy command options
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l skip-pull -d "Skip pulling images before deploying"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l force-recreate -d "Force recreate containers even if unchanged"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l validate-first -d "Validate Docker resource conflicts before deploying"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l scan -d "Scan resolved images for known vulnerabilities"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l scanner -d "Scanner backend" -xa "trivy grype"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l scan-fail-on -d "Block at or above severity" -xa "none unknown negligible low medium high critical"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l allow-partial -d "Exit 3 instead of 1 when a grouped or multi-service deploy partially succeeds"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l parallel -d "Execute operations in parallel using dependency phases"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l workers -d "Maximum concurrent workers for parallel execution" -x
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l wait-for-ready -d "Wait for dependencies to become ready"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l no-wait-for-ready -d "Return immediate dependency readiness snapshot"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l health-timeout -d "Health check timeout" -xa "30 60 120 300"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l staged -d "Roll out in dependency-ordered batches"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l batch-size -d "Services per staged batch" -xa "1 2 3 5 10"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l on-failure -d "Staged batch failure policy" -xa "halt continue"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Rebuild command options
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -l skip-pull -d "Skip pulling images before rebuilding"
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -l parallel -d "Execute operations in parallel using dependency phases"
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -l workers -d "Maximum concurrent workers for parallel execution" -x
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -l wait-for-ready -d "Wait for dependencies to become ready"
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -l no-wait-for-ready -d "Return immediate dependency readiness snapshot"
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -l health-timeout -d "Health check timeout" -xa "30 60 120 300"
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from rebuild; and not __fish_seen_subcommand_from state" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Health command options
complete -c rfapps -n "__fish_seen_subcommand_from health" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from health" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from health" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from health" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from health" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from health" -l wait-for-ready -d "Wait for dependencies to become ready"
complete -c rfapps -n "__fish_seen_subcommand_from health" -l no-wait-for-ready -d "Return immediate dependency readiness snapshot"
complete -c rfapps -n "__fish_seen_subcommand_from health" -l health-timeout -d "Health check timeout" -xa "30 60 120 300"
complete -c rfapps -n "__fish_seen_subcommand_from health" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from health" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from health" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Stop command options
complete -c rfapps -n "__fish_seen_subcommand_from stop" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from stop" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from stop" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from stop" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from stop" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from stop" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from stop" -s e -l env-file -d "Environment file" -r

# Delete command options
complete -c rfapps -n "__fish_seen_subcommand_from delete" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from delete" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from delete" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from delete" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from delete" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from delete" -l volumes -d "Also remove volumes"
complete -c rfapps -n "__fish_seen_subcommand_from delete" -l images -d "Also remove images"
complete -c rfapps -n "__fish_seen_subcommand_from delete" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from delete" -s e -l env-file -d "Environment file" -r

# Prune command options
complete -c rfapps -n "__fish_seen_subcommand_from prune" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from prune" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from prune" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from prune" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from prune" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from prune" -l images -d "Also prune images"
complete -c rfapps -n "__fish_seen_subcommand_from prune" -l volumes -d "Also prune volumes"
complete -c rfapps -n "__fish_seen_subcommand_from prune" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from prune" -s e -l env-file -d "Environment file" -r

# Plan command options
complete -c rfapps -n "__fish_seen_subcommand_from plan" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from plan" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from plan" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from plan" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from plan" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from plan" -l apply -d "Immediately apply the plan after generation"
complete -c rfapps -n "__fish_seen_subcommand_from plan" -s o -l out -d "Custom plan output path" -r
complete -c rfapps -n "__fish_seen_subcommand_from plan" -l show-unchanged -d "Show unchanged services in output"
complete -c rfapps -n "__fish_seen_subcommand_from plan" -l check-updates -d "Check registry for newer image versions"
complete -c rfapps -n "__fish_seen_subcommand_from plan" -l explain -d "Annotate changes with likely cause and dependency impact"
complete -c rfapps -n "__fish_seen_subcommand_from plan" -l scan -d "Scan resolved images for known vulnerabilities"
complete -c rfapps -n "__fish_seen_subcommand_from plan" -l scanner -d "Scanner backend" -xa "trivy grype"
complete -c rfapps -n "__fish_seen_subcommand_from plan" -l scan-fail-on -d "Block at or above severity" -xa "none unknown negligible low medium high critical"
complete -c rfapps -n "__fish_seen_subcommand_from plan" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from plan" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from plan" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Update command options
complete -c rfapps -n "__fish_seen_subcommand_from update" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from update" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from update" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from update" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from update" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from update" -l apply -d "Apply the reviewed image update plan after confirmation"
complete -c rfapps -n "__fish_seen_subcommand_from update" -l from-plan -d "Load a saved managed update plan" -r
complete -c rfapps -n "__fish_seen_subcommand_from update" -s o -l out -d "Write the preview plan or final update report" -r
complete -c rfapps -n "__fish_seen_subcommand_from update" -l no-restore-on-failure -d "Continue without automatic exact-image restore if verification fails"
complete -c rfapps -n "__fish_seen_subcommand_from update" -l health-timeout -d "Target verification timeout" -xa "30 60 120 300"
complete -c rfapps -n "__fish_seen_subcommand_from update" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from update" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from update" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Reconcile command options
complete -c rfapps -n "__fish_seen_subcommand_from reconcile; and not __fish_seen_subcommand_from drift" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from reconcile; and not __fish_seen_subcommand_from drift" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from reconcile; and not __fish_seen_subcommand_from drift" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from reconcile; and not __fish_seen_subcommand_from drift" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from reconcile; and not __fish_seen_subcommand_from drift" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from reconcile; and not __fish_seen_subcommand_from drift" -l auto-apply -d "Apply the reviewed reconciliation actions"
complete -c rfapps -n "__fish_seen_subcommand_from reconcile; and not __fish_seen_subcommand_from drift" -l show-unchanged -d "Show unchanged services in output"
complete -c rfapps -n "__fish_seen_subcommand_from reconcile; and not __fish_seen_subcommand_from drift" -l health-timeout -d "Target verification timeout" -xa "30 60 120 300"
complete -c rfapps -n "__fish_seen_subcommand_from reconcile; and not __fish_seen_subcommand_from drift" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from reconcile; and not __fish_seen_subcommand_from drift" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from reconcile; and not __fish_seen_subcommand_from drift" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Import command options (top-level; guarded against the drift import subcommand)
complete -c rfapps -n "__fish_seen_subcommand_from import; and not __fish_seen_subcommand_from drift" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from import; and not __fish_seen_subcommand_from drift" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from import; and not __fish_seen_subcommand_from drift" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from import; and not __fish_seen_subcommand_from drift" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from import; and not __fish_seen_subcommand_from drift" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from import; and not __fish_seen_subcommand_from drift" -l adopt -d "Record baseline snapshots for discovered services"
complete -c rfapps -n "__fish_seen_subcommand_from import; and not __fish_seen_subcommand_from drift" -l show-tracked -d "Include already-tracked and not-running services in the report"
complete -c rfapps -n "__fish_seen_subcommand_from import; and not __fish_seen_subcommand_from drift" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from import; and not __fish_seen_subcommand_from drift" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from import; and not __fish_seen_subcommand_from drift" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Backup creation options and offline verify subcommand
complete -c rfapps -n "__fish_seen_subcommand_from backup; and not __rfapps_seen_backup_verify" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from backup; and not __rfapps_seen_backup_verify" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from backup; and not __rfapps_seen_backup_verify" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from backup; and not __rfapps_seen_backup_verify" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from backup; and not __rfapps_seen_backup_verify" -l all -d "Target every Compose service explicitly"
complete -c rfapps -n "__fish_seen_subcommand_from backup; and not __rfapps_seen_backup_verify" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from backup; and not __rfapps_seen_backup_verify" -l destination -d "Existing backup destination directory" -xa "(__fish_complete_directories)"
complete -c rfapps -n "__fish_seen_subcommand_from backup; and not __rfapps_seen_backup_verify" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from backup; and not __rfapps_seen_backup_verify" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from backup; and not __rfapps_seen_backup_verify" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"
complete -c rfapps -n "__fish_seen_subcommand_from backup; and not __rfapps_seen_backup_verify" -a "verify" -d "Verify a backup manifest and every declared archive offline"
complete -c rfapps -n "__fish_seen_subcommand_from backup; and __rfapps_seen_backup_verify" -a "(__fish_complete_suffix .json)" -d "Manifest file"

# Apply command options
complete -c rfapps -n "__fish_seen_subcommand_from apply" -l force -d "Apply even if plan is stale"
complete -c rfapps -n "__fish_seen_subcommand_from apply" -a "(__fish_complete_suffix .json)" -d "Plan file"

# History command options
complete -c rfapps -n "__fish_seen_subcommand_from history" -s s -l service -d "Filter by service name" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from history" -l limit -d "Number of entries to show" -xa "5 10 20 50 100"
complete -c rfapps -n "__fish_seen_subcommand_from history" -l since -d "Show entries after this date"
complete -c rfapps -n "__fish_seen_subcommand_from history" -l action -d "Filter by action type" -xa "deploy rebuild delete rollback apply prune import"
complete -c rfapps -n "__fish_seen_subcommand_from history" -l generations -d "Show immutable generation snapshots instead of raw history"

# Rollback command options
complete -c rfapps -n "__fish_seen_subcommand_from rollback" -s s -l service -d "Service to rollback" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from rollback" -l steps -d "Number of deployments to rollback" -xa "1 2 3 5 10"
complete -c rfapps -n "__fish_seen_subcommand_from rollback" -l to-deployment -d "Rollback to specific deployment ID"
complete -c rfapps -n "__fish_seen_subcommand_from rollback" -l to-generation -d "Restore to a specific generation number"
complete -c rfapps -n "__fish_seen_subcommand_from rollback" -l to-time -d "Restore to the generation active at this time"
complete -c rfapps -n "__fish_seen_subcommand_from rollback" -l force -d "Skip validation warnings"

# Init command options
complete -c rfapps -n "__fish_seen_subcommand_from init" -s g -l global -d "Write to global config (~/.rfapps.yaml)"
complete -c rfapps -n "__fish_seen_subcommand_from init" -l json -d "Generate JSON config instead of YAML"
complete -c rfapps -n "__fish_seen_subcommand_from init" -s f -l force -d "Overwrite existing config file"

# Validate command options
complete -c rfapps -n "__fish_seen_subcommand_from validate" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from validate" -s e -l env-file -d "Environment file" -r

# Lint command options
complete -c rfapps -n "__fish_seen_subcommand_from lint" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from lint" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from lint" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from lint" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from lint" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from lint" -l json -d "Output findings in JSON format"
complete -c rfapps -n "__fish_seen_subcommand_from lint" -l sarif -d "Output findings in SARIF 2.1.0 format"
complete -c rfapps -n "__fish_seen_subcommand_from lint" -l runtime -d "Include runtime drift findings from running containers"
complete -c rfapps -n "__fish_seen_subcommand_from lint" -l list-rules -d "List available lint rules and exit"
complete -c rfapps -n "__fish_seen_subcommand_from lint" -l fail-on -d "Exit when findings meet or exceed severity" -xa "none info warn error"
complete -c rfapps -n "__fish_seen_subcommand_from lint" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from lint" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from lint" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Audit command options
complete -c rfapps -n "__fish_seen_subcommand_from audit" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from audit" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from audit" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from audit" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from audit" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from audit" -l json -d "Output findings in JSON format"
complete -c rfapps -n "__fish_seen_subcommand_from audit" -l fail-on -d "Exit when findings meet or exceed severity" -xa "none info warn error critical"
complete -c rfapps -n "__fish_seen_subcommand_from audit" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from audit" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from audit" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Harden command options
complete -c rfapps -n "__fish_seen_subcommand_from harden" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l apply -d "Edit compose.yml in place after confirmation"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -s o -l out -d "Write a compose override fragment" -r
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l include-review -d "Include review-confidence rules in written output"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l rule -d "Restrict to specific rules" -xa "${hardenRuleIds}"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l list-rules -d "List available hardening rules and exit"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l no-backup -d "Skip the compose.yml.bak copy taken before apply"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l allow-reformat -d "Accept incidental YAML reformatting of untouched lines"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l json -d "Output the harden result in JSON format"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from harden" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from harden" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Doctor command options
complete -c rfapps -n "__fish_seen_subcommand_from doctor" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from doctor" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from doctor" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from doctor" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from doctor" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from doctor" -l check-updates -d "Check registries for newer image versions"
complete -c rfapps -n "__fish_seen_subcommand_from doctor" -l fail-on -d "Exit when findings meet or exceed severity" -xa "none info warn error critical"
complete -c rfapps -n "__fish_seen_subcommand_from doctor" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from doctor" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from doctor" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Completion command options
complete -c rfapps -n "__fish_seen_subcommand_from completion" -s s -l shell -d "Target shell" -xa "bash zsh fish"
complete -c rfapps -n "__fish_seen_subcommand_from completion" -l install -d "Install completion script"
complete -c rfapps -n "__fish_seen_subcommand_from completion" -l force -d "Skip confirmation prompts"
complete -c rfapps -n "__fish_seen_subcommand_from completion" -a "bash zsh fish" -d "Shell"

# Drift command - subcommands
complete -c rfapps -n "__fish_seen_subcommand_from drift; and not __fish_seen_subcommand_from detect show reconcile import" -a "detect" -d "Show drifted services"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and not __fish_seen_subcommand_from detect show reconcile import" -a "show" -d "Show detailed drift for a service"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and not __fish_seen_subcommand_from detect show reconcile import" -a "reconcile" -d "Apply the safe shared reconciliation workflow"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and not __fish_seen_subcommand_from detect show reconcile import" -a "import" -d "Update compose.yml to match containers"

# Drift detect options
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from detect" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from detect" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from detect" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from detect" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from detect" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from detect" -l show-unchanged -d "Show unchanged services"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from detect" -l report-only -d "Always exit successfully when drift is found"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from detect" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from detect" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from detect" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Drift show options
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from show; and not __fish_seen_subcommand_from tag" -s s -l service -d "Service to inspect" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from show; and not __fish_seen_subcommand_from tag" -l report-only -d "Always exit successfully when drift is found"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from show; and not __fish_seen_subcommand_from tag" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from show; and not __fish_seen_subcommand_from tag" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from show; and not __fish_seen_subcommand_from tag" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Drift reconcile options
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from reconcile" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from reconcile" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from reconcile" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from reconcile" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from reconcile" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from reconcile" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from reconcile" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from reconcile" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Drift import options
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from import" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from import" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from import" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from import" -l tag -d "Narrow targets by hierarchical tag pattern" -xa "(__rfapps_complete_tags)"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from import" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from import" -l backup -d "Create a .bak backup of compose.yml"
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from import" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from import" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from import" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# State command - subcommands
complete -c rfapps -n "__fish_seen_subcommand_from state; and not __fish_seen_subcommand_from export rebuild" -a "export" -d "Write a consistent backup copy of the state database"
complete -c rfapps -n "__fish_seen_subcommand_from state; and not __fish_seen_subcommand_from export rebuild" -a "rebuild" -d "Reconstruct the state database from Docker runtime"

# State export options
complete -c rfapps -n "__fish_seen_subcommand_from state; and __fish_seen_subcommand_from export" -s o -l out -d "Backup destination file" -r

# State rebuild options
complete -c rfapps -n "__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild" -l mode -d "Reconstruction mode" -xa "salvage runtime-only"
complete -c rfapps -n "__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild" -l rewrite -d "Replace the state database with the reconstruction"
complete -c rfapps -n "__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild" -l confirm-project -d "Compose project name required by runtime-only" -x
complete -c rfapps -n "__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild" -l running-only -d "Only reconstruct services whose container is running"
complete -c rfapps -n "__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild" -l backup-dir -d "Directory for the mandatory pre-rewrite backup" -r
complete -c rfapps -n "__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild" -l show-unchanged -d "Include carried, absent, and orphaned services"
complete -c rfapps -n "__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"

# Tag command - subcommands
complete -c rfapps -n "__fish_seen_subcommand_from tag; and not __fish_seen_subcommand_from list show suggest" -a "list" -d "List every effective tag and the services carrying it"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and not __fish_seen_subcommand_from list show suggest" -a "show" -d "Show the declared and effective tags of specific services"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and not __fish_seen_subcommand_from list show suggest" -a "suggest" -d "Infer a starter tag taxonomy from compose and configuration"

# Tag list options
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from list" -l tree -d "Render the taxonomy as an indented tree"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from list" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from list" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from list" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from list" -l json -d "Output in JSON format"

# Tag show options (show is also a drift subcommand, so both sides are guarded)
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from show; and not __fish_seen_subcommand_from drift" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from show; and not __fish_seen_subcommand_from drift" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from show; and not __fish_seen_subcommand_from drift" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from show; and not __fish_seen_subcommand_from drift" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from show; and not __fish_seen_subcommand_from drift" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from show; and not __fish_seen_subcommand_from drift" -l json -d "Output in JSON format"

# Tag suggest options
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from suggest" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from suggest" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from suggest" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from suggest" -l rule -d "Restrict to specific inference rules" -xa "${tagRuleIds}"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from suggest" -l list-rules -d "List available inference rules and exit"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from suggest" -l include-tagged -d "Include services whose tags are already present"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from suggest" -s o -l out -d "Write the YAML fragment to this path" -r
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from suggest" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from suggest" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from suggest" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"
complete -c rfapps -n "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from suggest" -l json -d "Output in JSON format"
`;
}

/**
 * Detect current shell
 */
function detectShell(): SupportedShell | undefined {
  const shell = process.env["SHELL"] ?? "";
  if (shell.includes("bash")) return "bash";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("fish")) return "fish";
  return undefined;
}

/**
 * Get installation path for shell
 */
function getInstallPath(shell: SupportedShell): string {
  const home = homedir();
  switch (shell) {
    case "bash":
      return join(home, ".bash_completion.d", "rfapps");
    case "zsh":
      return join(home, ".zfunc", "_rfapps");
    case "fish":
      return join(home, ".config", "fish", "completions", "rfapps.fish");
  }
}

/**
 * Execute the completion command
 */
export async function executeCompletion(
  shell: string | undefined,
  options: CompletionOptions,
): Promise<void> {
  // Determine target shell
  const targetShell = (shell ?? options.shell ?? detectShell()) as SupportedShell | undefined;

  const supportedShells = ["bash", "zsh", "fish"];

  if (targetShell === undefined) {
    throw new InvalidArgumentError(
      "shell",
      "unknown",
      "Could not detect shell. Please specify with --shell or as an argument",
      supportedShells,
    );
  }

  if (!supportedShells.includes(targetShell)) {
    throw new InvalidArgumentError("shell", targetShell, "Unsupported shell", supportedShells);
  }

  // Load configuration to get profiles and groups
  let config: RfappsConfig;
  try {
    config = await loadConfig();
    logDebug(
      `Loaded config with ${config.profiles.validProfiles.length} profiles and ${Object.keys(config.groups).length} groups`,
    );
  } catch (error) {
    // Re-throw typed errors (e.g., ConfigNotFoundError) to propagate to handleCliError
    if (error instanceof ConfigNotFoundError) {
      throw error;
    }
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const formatted = formatError(errorObj);
    outputFormattedError(formatted);
    process.exitCode = 1;
    return;
  }

  // Generate completion script with config
  let script: string;
  switch (targetShell) {
    case "bash":
      script = generateBashCompletion(config);
      break;
    case "zsh":
      script = generateZshCompletion(config);
      break;
    case "fish":
      script = generateFishCompletion(config);
      break;
  }

  // Install if requested
  if (options.install) {
    const installPath = getInstallPath(targetShell);
    const installDir = join(installPath, "..");

    try {
      await mkdir(installDir, { recursive: true });
      await writeFile(installPath, script, "utf-8");
      logSuccess(`Installed ${targetShell} completion to ${installPath}`);

      // Show activation instructions
      switch (targetShell) {
        case "bash":
          logInfo("Add to ~/.bashrc: source ~/.bash_completion.d/rfapps");
          break;
        case "zsh":
          logInfo("Add to ~/.zshrc: fpath=(~/.zfunc $fpath); autoload -Uz compinit && compinit");
          break;
        case "fish":
          logInfo("Completions will be automatically loaded by fish");
          break;
      }
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const formatted = formatError(errorObj);
      outputFormattedError(formatted);
      process.exitCode = 1;
      return;
    }
  } else {
    // Output to stdout
    console.log(script);
  }
}
