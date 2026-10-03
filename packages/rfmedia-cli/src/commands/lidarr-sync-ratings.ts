/**
 * Lazy `rfmedia lidarr sync-ratings` command (#221).
 *
 * A flat leaf on the `lidarr` parent that turns Plex ratings and play counts
 * into Lidarr monitoring and quality-profile changes. It owns the CLI surface,
 * the output boundary, and the exit code; every decision belongs to the shipped
 * policy engine and every human byte to `./lidarr-sync-ratings-presenter.js`.
 *
 * Five contracts here are load-bearing, not stylistic:
 *
 * 1. NO `argParser` VALIDATES. `--decision` uses the non-throwing accumulator
 *    {@link parseSyncRatingsDecisions}, and `--mode` is checked by hand rather
 *    than through Commander's `.choices()`. A Commander `argParser` that throws
 *    is routed through `Command.error()` into `process.exit(1)` BEFORE
 *    `.action()` runs, bypassing the failure envelope and the redaction.
 * 2. THE SAFETY LADDER IS ONE VALUE-TAKING `--mode`, never sibling booleans.
 *    `--apply` already means a *plan file* elsewhere in this CLI
 *    (`copy --apply <plan>`), and the bash template classifies it as a
 *    file-completing value option in an unguarded, command-agnostic arm; a
 *    boolean `--apply` here would put two incompatible types behind one flag
 *    name and break the cross-shell completion contract.
 * 3. EVERY CHECK RUNS BEFORE THE LAZY ACTION IMPORT, so malformed input never
 *    constructs an adapter, a client, or the tracking database — and a
 *    machine-format apply without `--yes` is refused before any Plex drain.
 * 4. NOTHING IS IMPORTED FROM `./lidarr.js` (the ESM cycle these leaf modules
 *    exist to avoid); every parent helper arrives through
 *    {@link LidarrSyncRatingsCommandDeps}.
 * 5. THE OUTPUT BOUNDARY. Machine output goes to stdout through the lazily
 *    imported `formatOutput`; every human byte goes to `console.error` through
 *    the presenter. Root `--output` / `--json` are declared on the ROOT program
 *    and reconciled by `cli.ts`'s `preAction` hook.
 */

import { Command, Option } from "commander";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import {
  InvalidNumericArgumentError,
  LookupNotFoundError,
  MissingRequiredArgumentError,
} from "../lib/errors.js";
import { getLoadedPolicyConfig } from "../lib/loaded-config.js";
import { POLICY_MAX_PROPOSALS_PER_RULE } from "../types/lidarr-policy.js";
import {
  SYNC_RATINGS_DECISIONS,
  SYNC_RATINGS_MAX_PLAYS,
  SYNC_RATINGS_MAX_STARS,
  SYNC_RATINGS_MIN_STARS,
  SYNC_RATINGS_MODES,
  isSyncRatingsDecision,
  isSyncRatingsMode,
} from "../types/lidarr-sync-ratings.js";
import {
  assertInteractiveApplyApproval,
  confirmMutationApply,
  renderMutationPlan,
} from "./lidarr-mutation-presenter.js";
import {
  LIDARR_POLICY_EVALUATE_CSV_COLUMNS,
  projectPolicyEvaluationCsv,
} from "./lidarr-policy-presenter.js";
import {
  mutationPresentationOptions,
  renderSyncRatings,
  renderSyncRatingsExplain,
  syncRatingsDecisionKeys,
} from "./lidarr-sync-ratings-presenter.js";
import type {
  LidarrSyncRatingsActionOptions,
  LidarrSyncRatingsActionResult,
  LidarrSyncRatingsDependencies,
} from "../actions/lidarr/index.js";
import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";
import type {
  LidarrSyncRatingsMode,
  LidarrSyncRatingsOutcome,
  LidarrSyncRatingsReport,
  SyncRatingsDecision,
} from "../types/lidarr-sync-ratings.js";

const COMMAND_ID = "lidarr-sync-ratings";
const SUBCOMMAND = "sync-ratings";

/** Lowest accepted `--max-proposals` value; the ceiling is the engine's cap. */
const MIN_MAX_PROPOSALS = 1;

/** Accepts `4` and `4.5`; rejects a sign, an exponent, and empty input. */
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

/** Accepts unsigned integers only, so `-1` fails as a bound, not as a parse. */
const INTEGER_PATTERN = /^\d+$/;

/**
 * The slice of the actions barrel this leaf consumes.
 *
 * Declared as a narrowing of `typeof import("../actions/lidarr/index.js")` so
 * the production loader below type-checks against the real module while the
 * test/embedding seam can supply a single function.
 */
export interface LidarrSyncRatingsActions {
  readonly executeLidarrSyncRatings: (
    options: LidarrSyncRatingsActionOptions,
    dependencies?: LidarrSyncRatingsDependencies,
  ) => Promise<LidarrSyncRatingsActionResult>;
}

/** Parent-private helpers injected without importing the Lidarr parent. */
export interface LidarrSyncRatingsCommandDeps {
  /** Reads the resolved global output format off the root command. */
  readonly resolveFormat: () => OutputFormat;
  /** Shared failure-contract renderer (sets `process.exitCode = 1`). */
  readonly reportLidarrFailure: (
    subcommand: string,
    error: unknown,
    options: {
      readonly staleHint: boolean;
      readonly format: OutputFormat;
      readonly sensitiveValues?: readonly unknown[];
    },
  ) => Promise<void>;
  /** Renders successful execution-lane metadata beneath the human report. */
  readonly renderExecutionSummary: (execution: LidarrExecutionSuccessMetadata) => void;
  /** Test/embedding seam; production keeps the actions barrel lazy. */
  readonly loadActions?: () => Promise<LidarrSyncRatingsActions>;
}

/** Stable JSON/YAML success envelope; the report is the whole result. */
export interface LidarrSyncRatingsMachineOutput {
  readonly command: typeof COMMAND_ID;
  readonly result: LidarrSyncRatingsReport;
}

/**
 * Accumulates `--decision` values without ever throwing.
 *
 * Both `--decision a,b` and `--decision a --decision b` are accepted, and
 * repetitions combine instead of overwriting. Unknown kinds — and a value that
 * contributes no kind at all, such as `--decision ""` from an unset CI
 * variable — are rejected inside `.action()`, never here.
 *
 * @param value - One raw `--decision` occurrence, possibly comma-separated.
 * @param previous - Values accumulated from earlier occurrences.
 * @returns Every non-empty, trimmed kind collected so far, in argument order.
 */
export function parseSyncRatingsDecisions(value: string, previous?: readonly string[]): string[] {
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return [...(previous ?? []), ...parsed];
}

/**
 * Narrows the accumulated `--decision` tokens to sealable decisions.
 *
 * @param raw - Accumulated `--decision` values, or `undefined` for "both".
 * @returns The narrowed selection, or `undefined` when none was requested.
 * @throws {MissingRequiredArgumentError} When `--decision` was given but
 *   contributed no kind at all (`--decision ""`, `--decision ,`). An empty
 *   selection would otherwise reach the evaluate action, which expands it to
 *   EVERY registered rule — `discovery-seed` included.
 * @throws {LookupNotFoundError} On the first unknown kind; the available values
 *   feed the formatter's "did you mean" hint.
 */
function resolveSyncRatingsDecisions(
  raw: readonly string[] | undefined,
): readonly SyncRatingsDecision[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw.length === 0) {
    throw new MissingRequiredArgumentError(
      "--decision requires at least one decision kind",
      "lidarr sync-ratings",
    );
  }
  const selected: SyncRatingsDecision[] = [];
  for (const value of raw) {
    if (!isSyncRatingsDecision(value)) {
      throw new LookupNotFoundError("sync-ratings decision", value, [...SYNC_RATINGS_DECISIONS]);
    }
    selected.push(value);
  }
  return selected;
}

/**
 * Validates the safety-ladder rung here rather than through `.choices()`.
 *
 * `.choices()` installs an `argParser` that throws, exiting the process before
 * `.action()` runs; an operator on `--output json` would then get Commander's
 * prose on stderr instead of the failure envelope.
 *
 * @param raw - The raw option value; Commander supplies the `"recommend"` default.
 * @returns The validated rung.
 * @throws {LookupNotFoundError} When the value names no rung.
 */
function resolveMode(raw: unknown): LidarrSyncRatingsMode {
  const value = String(raw ?? "recommend");
  if (!isSyncRatingsMode(value)) {
    throw new LookupNotFoundError("sync-ratings mode", value, [...SYNC_RATINGS_MODES]);
  }
  return value;
}

/** One inclusive threshold bound and the lexical form it accepts. */
interface NumericBound {
  readonly min: number;
  readonly max: number;
  /** `--min-stars` is the only fractional knob; the rest are counts. */
  readonly fractional: boolean;
}

const STAR_BOUND: NumericBound = {
  min: SYNC_RATINGS_MIN_STARS,
  max: SYNC_RATINGS_MAX_STARS,
  fractional: true,
};
const PLAYS_BOUND: NumericBound = { min: 0, max: SYNC_RATINGS_MAX_PLAYS, fractional: false };
const PROPOSALS_BOUND: NumericBound = {
  min: MIN_MAX_PROPOSALS,
  max: POLICY_MAX_PROPOSALS_PER_RULE,
  fractional: false,
};

/**
 * Validates one inclusive numeric threshold.
 *
 * The lexical patterns are unsigned, so `--max-plays -1` fails as an
 * out-of-form value rather than parsing to a negative that a later comparison
 * would have to catch.
 *
 * @param flag - The flag being validated, used verbatim in the message.
 * @param raw - The raw option value, or `undefined` when unset.
 * @param bound - The accepted range and lexical form.
 * @returns The parsed threshold, or `undefined` when unset.
 * @throws {InvalidNumericArgumentError} When the value is out of form or
 *   outside `[bound.min, bound.max]`.
 */
function resolveNumericBound(
  flag: string,
  raw: string | undefined,
  bound: NumericBound,
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  const pattern = bound.fractional ? DECIMAL_PATTERN : INTEGER_PATTERN;
  const parsed = pattern.test(trimmed) ? Number.parseFloat(trimmed) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < bound.min || parsed > bound.max) {
    throw new InvalidNumericArgumentError(
      flag,
      raw,
      `must be ${bound.fractional ? "a number" : "an integer"} between ${bound.min} and ${bound.max}`,
      bound.min,
      bound.max,
    );
  }
  return parsed;
}

/**
 * Refuses a quality-profile run that names no target profile.
 *
 * This command force-enables an unconfigured rule, which is what makes the
 * engine's "no target profile" path reachable: the rule would dispatch, skip on
 * `signal-unavailable`, and turn a pure operator omission into a `degraded`
 * report whose detail never names the flag that fixes it.
 *
 * An explicitly disabled rating rule is exempt: the decision is refused with
 * `decision-disabled` rather than evaluated, so demanding a target it will
 * never use would let one rule's kill switch block its healthy sibling.
 *
 * @param decisions - The narrowed selection, or `undefined` for both decisions.
 * @param qualityProfile - The validated `--quality-profile` value, if any.
 * @throws {MissingRequiredArgumentError} When the quality-profile decision is
 *   selected on a rule that is not disabled, and neither the flag nor
 *   `policy.rules.rating-quality-upgrade.targetQualityProfile` names a target.
 */
function requireQualityProfileTarget(
  decisions: readonly SyncRatingsDecision[] | undefined,
  qualityProfile: string | undefined,
): void {
  const selected: readonly SyncRatingsDecision[] = decisions ?? SYNC_RATINGS_DECISIONS;
  if (!selected.includes("quality-profile") || qualityProfile !== undefined) {
    return;
  }
  // A pure synchronous read of already-validated config; no I/O, no adapter.
  const rule = getLoadedPolicyConfig()?.rules?.["rating-quality-upgrade"];
  if (rule?.enabled === false || rule?.targetQualityProfile !== undefined) {
    return;
  }
  throw new MissingRequiredArgumentError(
    "--quality-profile is required when the quality-profile decision is selected and policy.rules.rating-quality-upgrade.targetQualityProfile is unset",
    "lidarr sync-ratings",
  );
}

/**
 * Validates `--quality-profile`, refusing a blank reference.
 *
 * A blank value is not equivalent to omitting the flag: the engine resolves the
 * target with `??`, which falls through only on `undefined`, so an empty string
 * would shadow a configured `targetQualityProfile`, resolve to nothing, and
 * degrade the run instead of using the configured profile.
 *
 * @param raw - The raw option value, or `undefined` when unset.
 * @returns The trimmed reference, or `undefined` when unset.
 * @throws {MissingRequiredArgumentError} When the flag is present but blank.
 */
function resolveQualityProfile(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new MissingRequiredArgumentError(
      "--quality-profile needs a profile name or numeric id; omit the flag to use policy.rules.rating-quality-upgrade.targetQualityProfile",
      "lidarr sync-ratings",
    );
  }
  return trimmed;
}

/**
 * Rejects an `--explain` key that no decision in the report owns.
 *
 * Checked for every format, so `--output json --explain <typo>` fails loudly
 * instead of silently emitting the unrelated full envelope.
 *
 * @param report - The completed sync-ratings report.
 * @param key - The requested decision key.
 * @throws {LookupNotFoundError} When no proposal or skip carries the key.
 */
function assertKnownDecisionKey(report: LidarrSyncRatingsReport, key: string): void {
  const keys = syncRatingsDecisionKeys(report);
  if (!keys.includes(key)) {
    throw new LookupNotFoundError("sync-ratings decision key", key, [...keys]);
  }
}

/**
 * Emits the machine envelope on stdout.
 *
 * `--output csv` projects the embedded evaluation through the shipped policy
 * projection rather than inventing a second flat schema for the same decisions.
 *
 * @param format - A machine output format.
 * @param report - The completed sync-ratings report.
 */
async function emitMachine(format: OutputFormat, report: LidarrSyncRatingsReport): Promise<void> {
  const { formatOutput } = await import("../lib/formatters/index.js");
  if (format === "csv") {
    await formatOutput(format, projectPolicyEvaluationCsv(report.evaluation), {
      columns: [...LIDARR_POLICY_EVALUATE_CSV_COLUMNS],
    });
    return;
  }
  const output: LidarrSyncRatingsMachineOutput = { command: COMMAND_ID, result: report };
  await formatOutput(format, output);
}

/** Everything the per-artifact approval seam needs from the parsed options. */
interface ApplyApprovalContext {
  readonly yes: boolean;
  readonly verbose: boolean;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
}

/**
 * Builds the action's collaborator set with a real interactive approval seam.
 *
 * Only `"apply"` runs need it: in every other rung the action's own default
 * dependencies never consult `confirm`, and its default REFUSES, so an embedder
 * that forgets to inject an approval path gets zero mutations. The dry run is
 * `approved: false` deliberately — a dry run acquires no claim and writes no
 * history, and the real apply is gated separately.
 *
 * @param context - Approval mode, verbosity, and Lidarr connection overrides.
 * @returns The dependency set to hand to `executeLidarrSyncRatings`.
 */
async function buildApplyDependencies(
  context: ApplyApprovalContext,
): Promise<LidarrSyncRatingsDependencies> {
  const actions = await import("../actions/lidarr/index.js");
  const { buildRatingSyncPlan, resolveSyncRatingsThresholds } =
    await import("../lib/bridge/rating-sync.js");
  const confirm = async (outcome: LidarrSyncRatingsOutcome): Promise<boolean> => {
    if (context.yes) {
      return true;
    }
    const { plan, planPath } = outcome.generated;
    const review = await actions.executeLidarrApply({
      planPath,
      dryRun: true,
      approved: false,
      expectedPlanId: plan.id,
      expectedPlanChecksum: plan.payloadChecksum,
      lidarrUrl: context.lidarrUrl,
      lidarrApiKey: context.lidarrApiKey,
    });
    return confirmMutationApply(
      planPath,
      review,
      plan,
      mutationPresentationOptions(context.verbose),
    );
  };
  return Object.freeze({
    executeEvaluate: actions.executeLidarrPolicyEvaluate,
    buildPlan: buildRatingSyncPlan,
    resolveThresholds: resolveSyncRatingsThresholds,
    executeArtistProfilePlan: actions.executeLidarrArtistProfilePlan,
    executeMonitoringPlan: actions.executeLidarrPlan,
    executeApply: actions.executeLidarrApply,
    loadedPolicyConfig: getLoadedPolicyConfig,
    confirm,
  });
}

/**
 * Whether any applied artifact left Lidarr in a state the operator must inspect.
 *
 * @param report - The completed sync-ratings report.
 * @returns True when an apply reported `failed` or `partial`.
 */
function hasIncompleteApply(report: LidarrSyncRatingsReport): boolean {
  return report.outcomes.some(
    (outcome) => outcome.apply?.status === "failed" || outcome.apply?.status === "partial",
  );
}

/**
 * Builds the rating-sync leaf for registration by `lidarr.ts`.
 *
 * @param deps - Parent-private helpers, injected to avoid the `./lidarr.js` ESM
 *   cycle.
 * @returns The `sync-ratings` leaf; every option long is pinned by the
 *   option-surface test and by the three shell-completion templates.
 */
export function createLidarrSyncRatingsCommand(deps: LidarrSyncRatingsCommandDeps): Command {
  const loadActions =
    deps.loadActions ??
    ((): Promise<LidarrSyncRatingsActions> => import("../actions/lidarr/index.js"));
  return new Command(SUBCOMMAND)
    .description("Turn Plex ratings and plays into Lidarr monitoring and quality changes")
    .addHelpText(
      "after",
      "\nRatings are never written back to Plex. Without --mode plan nothing is sealed, and without --mode apply nothing is mutated.",
    )
    .addOption(
      new Option(
        "--plex-library <name>",
        "Plex music library (overrides policy.plexLibrary)",
      ).helpGroup("Selection:"),
    )
    .addOption(
      new Option(
        "--decision <kinds>",
        `Consider only these decisions (repeatable, comma-separated). Values: ${SYNC_RATINGS_DECISIONS.join(", ")}`,
      )
        .argParser(parseSyncRatingsDecisions)
        .helpGroup("Selection:"),
    )
    .addOption(
      new Option(
        "--min-stars <n>",
        `Plex star floor for a quality upgrade (${SYNC_RATINGS_MIN_STARS}-${SYNC_RATINGS_MAX_STARS}, decimals allowed)`,
      ).helpGroup("Thresholds:"),
    )
    .addOption(
      new Option(
        "--max-plays <n>",
        `Inclusive play ceiling at or below which a monitored artist is unmonitored (0-${SYNC_RATINGS_MAX_PLAYS})`,
      ).helpGroup("Thresholds:"),
    )
    .addOption(
      new Option(
        "--quality-profile <ref>",
        "Target Lidarr quality profile, by name or numeric id (numeric ids resolve first)",
      ).helpGroup("Thresholds:"),
    )
    .addOption(
      new Option(
        "--max-proposals <n>",
        `Per-rule proposal cap, not a run total (${MIN_MAX_PROPOSALS}-${POLICY_MAX_PROPOSALS_PER_RULE}); replaces each rule's own cap (rating 25, stale 25, seed 10)`,
      ).helpGroup("Thresholds:"),
    )
    .addOption(
      new Option("--mode <mode>", `Safety rung: ${SYNC_RATINGS_MODES.join("|")}`)
        .default("recommend")
        .helpGroup("Safety:"),
    )
    .addOption(
      new Option("--yes", "Approve each apply without an interactive prompt").helpGroup("Safety:"),
    )
    .addOption(
      new Option("--explain <key>", "Print one decision's full causal chain").helpGroup("Output:"),
    )
    .addOption(
      new Option("-v, --verbose", "Show every row instead of the first 20").helpGroup("Output:"),
    )
    .addOption(
      new Option("--plex-url <url>", "Plex base URL (overrides config)").helpGroup("Connection:"),
    )
    .addOption(
      new Option("--plex-token <token>", "Plex token (overrides config)").helpGroup("Connection:"),
    )
    .addOption(
      new Option("--lidarr-url <url>", "Lidarr base URL (overrides config)").helpGroup(
        "Connection:",
      ),
    )
    .addOption(
      new Option("--lidarr-api-key <key>", "Lidarr API key (overrides config)").helpGroup(
        "Connection:",
      ),
    )
    .action(async (cmdOptions: Record<string, unknown>) => {
      const format = deps.resolveFormat();
      try {
        // Everything below runs BEFORE the lazy action import, so malformed
        // input never constructs an adapter, a client, or the tracking DB.
        const decisions = resolveSyncRatingsDecisions(
          cmdOptions["decision"] as readonly string[] | undefined,
        );
        const mode = resolveMode(cmdOptions["mode"]);
        const minStars = resolveNumericBound(
          "--min-stars",
          cmdOptions["minStars"] as string | undefined,
          STAR_BOUND,
        );
        const maxPlays = resolveNumericBound(
          "--max-plays",
          cmdOptions["maxPlays"] as string | undefined,
          PLAYS_BOUND,
        );
        const maxProposals = resolveNumericBound(
          "--max-proposals",
          cmdOptions["maxProposals"] as string | undefined,
          PROPOSALS_BOUND,
        );
        const qualityProfile = resolveQualityProfile(
          cmdOptions["qualityProfile"] as string | undefined,
        );
        requireQualityProfileTarget(decisions, qualityProfile);

        const yes = cmdOptions["yes"] === true;
        if (mode === "apply" && !yes) {
          assertInteractiveApplyApproval(isMachineFormat(format));
        }

        const machine = isMachineFormat(format);
        const verbose = cmdOptions["verbose"] === true;
        const explain = cmdOptions["explain"] as string | undefined;
        const lidarrUrl = cmdOptions["lidarrUrl"] as string | undefined;
        const lidarrApiKey = cmdOptions["lidarrApiKey"] as string | undefined;

        const actionOptions: LidarrSyncRatingsActionOptions = {
          mode,
          plexLibrary: cmdOptions["plexLibrary"] as string | undefined,
          decisions,
          minStars,
          maxPlays,
          qualityProfile,
          maxProposals,
          // The artifact path must reach the operator before the next producer
          // can fail the run, so it is rendered at seal time, not at the end.
          onPlanSealed: machine
            ? undefined
            : (outcome: LidarrSyncRatingsOutcome): void => {
                renderMutationPlan(outcome.generated, verbose);
              },
          plexUrl: cmdOptions["plexUrl"] as string | undefined,
          plexToken: cmdOptions["plexToken"] as string | undefined,
          lidarrUrl,
          lidarrApiKey,
        };
        const dependencies =
          mode === "apply"
            ? await buildApplyDependencies({ yes, verbose, lidarrUrl, lidarrApiKey })
            : undefined;
        const { executeLidarrSyncRatings } = await loadActions();
        const { report, execution } = await executeLidarrSyncRatings(actionOptions, dependencies);

        if (explain !== undefined) {
          assertKnownDecisionKey(report, explain);
        }

        if (machine) {
          await emitMachine(format, report);
        } else if (explain !== undefined) {
          renderSyncRatingsExplain(report, explain);
        } else {
          renderSyncRatings(report, { verbose });
          deps.renderExecutionSummary(execution);
        }

        // The gate is applied only AFTER rendering, so an operator always sees
        // the evidence behind a failing run. Only exit codes 0 and 1 exist, and
        // `process.exit()` is never called.
        if (hasIncompleteApply(report)) {
          process.exitCode = 1;
        }
      } catch (error) {
        await deps.reportLidarrFailure(SUBCOMMAND, error, {
          staleHint: false,
          format,
          sensitiveValues: [cmdOptions["lidarrApiKey"], cmdOptions["plexToken"]],
        });
      }
    });
}
