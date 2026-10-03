/**
 * Lazy `rfmedia lidarr policy evaluate|plan` command group (#209, #311).
 *
 * `policy` keeps the unchanged read-only evaluator beside the review-first plan
 * composer. Both leaves validate before loading the shared actions barrel.
 *
 * Three contracts are load-bearing here, not stylistic:
 *
 * 1. NO `argParser` VALIDATES. `--rule` uses a non-throwing accumulator modeled
 *    on `parseAuditCheckIds` (`./lidarr-audit.js`), and every other option is
 *    checked inside `.action()`'s `try` block. A Commander `argParser` that
 *    throws `InvalidArgumentError` is routed through `Command.error()` into
 *    `process.exit(1)` BEFORE `.action()` runs, which bypasses the failure
 *    envelope, the credential redaction, and every test.
 * 2. NOTHING IS IMPORTED FROM `./lidarr.js` (that is the ESM cycle these leaf
 *    modules exist to avoid); every parent helper arrives through
 *    {@link LidarrPolicyCommandDeps}. The actions barrel is loaded lazily, so a
 *    validation failure never constructs an adapter, a client, a scheduler, or
 *    the tracking database.
 * 3. THE OUTPUT BOUNDARY. Machine output goes to stdout through the lazily
 *    imported `formatOutput`; every human byte goes to `console.error` through
 *    `./lidarr-policy-presenter.js`, which owns all rendering (and therefore
 *    keeps this file inside the ~500-line command budget). Root `--output` /
 *    `--json` are declared on the ROOT program and reconciled by `cli.ts`'s
 *    `preAction` hook — redeclaring them here would shadow them.
 */

import { Command, Option } from "commander";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import type {
  LidarrPolicyEvaluateActionOptions,
  LidarrPolicyEvaluateActionResult,
  LidarrPolicyEvaluateDependencies,
  LidarrPolicyPlanActionOptions,
  LidarrPolicyPlanActionResult,
  LidarrPolicyPlanDependencies,
} from "../actions/lidarr/index.js";
import {
  InvalidNumericArgumentError,
  LookupNotFoundError,
  MissingRequiredArgumentError,
} from "../lib/errors.js";
import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";
import { redactErrorMessage } from "../lib/redact-error-message.js";
import { getGlobalSignal } from "../lib/signal-handler.js";
import {
  POLICY_FAIL_ON_LEVELS,
  POLICY_MAX_PROPOSALS_PER_RULE,
  POLICY_RULE_IDS,
  isPolicyRuleId,
  shouldFailPolicyEvaluation,
} from "../types/lidarr-policy.js";
import type { PolicyEvaluationReport, PolicyFailOn, PolicyRuleId } from "../types/lidarr-policy.js";
import { POLICY_PLAN_MODES, isPolicyPlanMode } from "../types/lidarr-policy-plan.js";
import type {
  LidarrPolicyPlanReport,
  PolicyPlanMode,
  PolicyPlanOutcome,
} from "../types/lidarr-policy-plan.js";
import { renderMutationPlan } from "./lidarr-mutation-presenter.js";
import {
  LIDARR_POLICY_EVALUATE_CSV_COLUMNS,
  LIDARR_POLICY_PLAN_CSV_COLUMNS,
  policyDecisionKeys,
  projectPolicyEvaluationCsv,
  projectPolicyPlanCsv,
  renderPolicyEvaluation,
  renderPolicyExplain,
  renderPolicyPlan,
} from "./lidarr-policy-presenter.js";

const EVALUATE_COMMAND_ID = "lidarr-policy-evaluate";
const EVALUATE_SUBCOMMAND = "policy-evaluate";
const PLAN_COMMAND_ID = "lidarr-policy-plan";
const PLAN_SUBCOMMAND = "policy-plan";

/** Lowest accepted `--max-proposals` value; the ceiling is the engine's cap. */
const MIN_MAX_PROPOSALS = 1;

/**
 * The slice of the actions barrel this leaf consumes.
 *
 * Declared as a narrowing of `typeof import("../actions/lidarr/index.js")` so
 * the production loader below type-checks against the real module while the
 * test/embedding seam can supply a single function.
 */
export interface LidarrPolicyActions {
  readonly executeLidarrPolicyEvaluate: (
    options: LidarrPolicyEvaluateActionOptions,
    dependencies?: LidarrPolicyEvaluateDependencies,
  ) => Promise<LidarrPolicyEvaluateActionResult>;
  readonly executeLidarrPolicyPlan: (
    options: LidarrPolicyPlanActionOptions,
    dependencies?: LidarrPolicyPlanDependencies,
  ) => Promise<LidarrPolicyPlanActionResult>;
}

/** Parent-private helpers injected without importing the Lidarr parent. */
export interface LidarrPolicyCommandDeps {
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
  /**
   * Comma-separated unique positive-int ID parser (`label` names the kind).
   *
   * Unused by the evaluate leaf, which declares no id-list option, but part of
   * the injected parent-helper set so `lidarr.ts` registers every leaf the same
   * way and a future `policy plan --ids` needs no dependency change.
   */
  readonly parseIdList: (label: string, value: string) => number[];
  /** Test seam; production uses the repository-owned process signal. */
  readonly resolveSignal?: () => AbortSignal;
  /** Test/embedding seam; production keeps the action module lazy. */
  readonly loadActions?: () => Promise<LidarrPolicyActions>;
}

/** Stable JSON/YAML success envelope; the report is the whole result. */
export interface LidarrPolicyEvaluateMachineOutput {
  readonly command: typeof EVALUATE_COMMAND_ID;
  readonly result: PolicyEvaluationReport;
}

/** Stable JSON/YAML policy-plan envelope; the versioned report is the whole result. */
export interface LidarrPolicyPlanMachineOutput {
  readonly command: typeof PLAN_COMMAND_ID;
  readonly result: LidarrPolicyPlanReport;
}

/**
 * Accumulates `--rule` values without ever throwing.
 *
 * Both `--rule a,b` and `--rule a --rule b` are accepted, and repetitions
 * combine instead of overwriting. Validation deliberately does NOT happen here:
 * a Commander `argParser` that throws is routed into `Command.error()` and
 * terminates the process, bypassing the action handler's failure contract.
 * Unknown ids — and a value that contributes no id at all, such as `--rule ""`
 * from an unset CI variable — are rejected inside `.action()` instead.
 *
 * @param value - One raw `--rule` occurrence, possibly comma-separated.
 * @param previous - Values accumulated from earlier occurrences.
 * @returns Every non-empty, trimmed id collected so far, in argument order.
 */
export function parsePolicyRuleIds(value: string, previous?: readonly string[]): string[] {
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return [...(previous ?? []), ...parsed];
}

/**
 * Narrows the accumulated `--rule` tokens to registered rule ids.
 *
 * @param raw - Accumulated `--rule` values, or `undefined` for "every rule".
 * @returns The narrowed selection, or `undefined` when none was requested.
 * @throws {MissingRequiredArgumentError} When `--rule` was given but
 *   contributed no id at all (`--rule ""`, `--rule ,`, `--rule " "`). The engine
 *   takes an empty selection literally, so without this guard the run would
 *   report every rule `not-selected`, finish `clean`, and pass any `--fail-on`
 *   gate having evaluated nothing.
 * @throws {LookupNotFoundError} On the first unregistered id; the available
 *   values feed the formatter's "did you mean" hint.
 */
function resolveSelectedRules(
  raw: readonly string[] | undefined,
  command = "lidarr policy evaluate",
): readonly PolicyRuleId[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw.length === 0) {
    throw new MissingRequiredArgumentError("--rule requires at least one policy rule id", command);
  }
  const selected: PolicyRuleId[] = [];
  for (const id of raw) {
    if (!isPolicyRuleId(id)) {
      throw new LookupNotFoundError("policy rule", id, [...POLICY_RULE_IDS]);
    }
    selected.push(id);
  }
  return selected;
}

/**
 * Validates the single global per-rule proposal cap (§16.2).
 *
 * There is no `--max-proposals rule=N` form: one integer caps every selected
 * rule, and it is forwarded verbatim to the action.
 *
 * @param raw - The raw option value, or `undefined` when unset.
 * @returns The parsed cap, or `undefined` when unset.
 * @throws {InvalidNumericArgumentError} When the value is not an integer inside
 *   `[1, POLICY_MAX_PROPOSALS_PER_RULE]`.
 */
function resolveMaxProposals(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_MAX_PROPOSALS ||
    parsed > POLICY_MAX_PROPOSALS_PER_RULE
  ) {
    throw new InvalidNumericArgumentError(
      "--max-proposals",
      raw,
      `must be an integer between ${MIN_MAX_PROPOSALS} and ${POLICY_MAX_PROPOSALS_PER_RULE}`,
      MIN_MAX_PROPOSALS,
      POLICY_MAX_PROPOSALS_PER_RULE,
    );
  }
  return parsed;
}

/**
 * Validates `--fail-on` here rather than through Commander's `.choices()`.
 *
 * `.choices()` installs an `argParser` that throws `InvalidArgumentError`, which
 * exits the process before `.action()` runs; an operator on `--output json`
 * would then get Commander's prose on stderr instead of the failure envelope.
 *
 * `degraded` is deliberately NOT a level: a degraded report already trips any
 * non-`none` level through `shouldFailPolicyEvaluation`.
 *
 * @param raw - The raw option value; Commander supplies the `"none"` default.
 * @returns The validated gate level.
 * @throws {LookupNotFoundError} When the value names no level.
 */
function resolveFailOn(raw: unknown): PolicyFailOn {
  if (raw === undefined) {
    return "none";
  }
  const value = String(raw);
  const level = POLICY_FAIL_ON_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new LookupNotFoundError("policy fail-on level", value, [...POLICY_FAIL_ON_LEVELS]);
  }
  return level;
}

/**
 * Rejects an `--explain` key that no decision in the report owns.
 *
 * Checked for every format, so `--output json --explain <typo>` fails loudly
 * instead of silently emitting the unrelated full envelope.
 *
 * @param report - The completed evaluation report.
 * @param key - The requested decision key.
 * @throws {LookupNotFoundError} When no proposal or skip carries the key.
 */
function assertKnownDecisionKey(report: PolicyEvaluationReport, key: string): void {
  const keys = policyDecisionKeys(report);
  if (!keys.includes(key)) {
    throw new LookupNotFoundError("policy decision key", key, [...keys]);
  }
}

/**
 * Emits the machine envelope on stdout.
 *
 * @param format - A machine output format.
 * @param report - The completed evaluation report.
 */
async function emitMachine(format: OutputFormat, report: PolicyEvaluationReport): Promise<void> {
  const { formatOutput } = await import("../lib/formatters/index.js");
  if (format === "csv") {
    await formatOutput(format, projectPolicyEvaluationCsv(report), {
      columns: [...LIDARR_POLICY_EVALUATE_CSV_COLUMNS],
    });
    return;
  }
  const output: LidarrPolicyEvaluateMachineOutput = {
    command: EVALUATE_COMMAND_ID,
    result: report,
  };
  await formatOutput(format, output);
}

/** Builds the evaluate leaf; every option long is pinned by the option-surface test. */
function createEvaluateCommand(deps: LidarrPolicyCommandDeps): Command {
  const loadActions =
    deps.loadActions ?? ((): Promise<LidarrPolicyActions> => import("../actions/lidarr/index.js"));
  return new Command("evaluate")
    .description("Evaluate consumption policy rules and report proposals")
    .addHelpText(
      "after",
      "\nRead-only: this command writes nothing to Plex, to Lidarr, or to the plan directory.",
    )
    .addOption(
      new Option(
        "--plex-library <name>",
        "Plex music library (overrides policy.plexLibrary)",
      ).helpGroup("Selection:"),
    )
    .addOption(
      new Option(
        "--rule <ids>",
        `Run only these rules (repeatable, comma-separated). Values: ${POLICY_RULE_IDS.join(", ")}`,
      )
        .argParser(parsePolicyRuleIds)
        .helpGroup("Selection:"),
    )
    .addOption(
      new Option(
        "--max-proposals <n>",
        `Per-rule proposal cap override (${MIN_MAX_PROPOSALS}-${POLICY_MAX_PROPOSALS_PER_RULE})`,
      ).helpGroup("Selection:"),
    )
    .addOption(
      new Option("--explain <key>", "Print one decision's full causal chain").helpGroup("Output:"),
    )
    .addOption(
      new Option(
        "--fail-on <level>",
        `Exit 1 when proposals exist: ${POLICY_FAIL_ON_LEVELS.join("|")}`,
      )
        .default("none")
        .helpGroup("Output:"),
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
        const rules = resolveSelectedRules(cmdOptions["rule"] as readonly string[] | undefined);
        const maxProposals = resolveMaxProposals(cmdOptions["maxProposals"] as string | undefined);
        const failOn = resolveFailOn(cmdOptions["failOn"]);
        const explain = cmdOptions["explain"] as string | undefined;

        const actionOptions: LidarrPolicyEvaluateActionOptions = {
          plexLibrary: cmdOptions["plexLibrary"] as string | undefined,
          rules,
          maxProposals,
          plexUrl: cmdOptions["plexUrl"] as string | undefined,
          plexToken: cmdOptions["plexToken"] as string | undefined,
          lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
          lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
        };
        const { executeLidarrPolicyEvaluate } = await loadActions();
        const { report, execution } = await executeLidarrPolicyEvaluate(actionOptions);

        if (explain !== undefined) {
          assertKnownDecisionKey(report, explain);
        }

        if (isMachineFormat(format)) {
          await emitMachine(format, report);
        } else if (explain !== undefined) {
          renderPolicyExplain(report, explain);
        } else {
          renderPolicyEvaluation(report, { verbose: cmdOptions["verbose"] === true });
          deps.renderExecutionSummary(execution);
        }

        // The gate is applied only AFTER rendering, so an operator always sees
        // the evidence behind a failing run. Only exit codes 0 and 1 exist, and
        // `process.exit()` is never called.
        if (shouldFailPolicyEvaluation(report, failOn)) {
          process.exitCode = 1;
        }
      } catch (error) {
        await deps.reportLidarrFailure(EVALUATE_SUBCOMMAND, error, {
          staleHint: false,
          format,
          sensitiveValues: [cmdOptions["lidarrApiKey"], cmdOptions["plexToken"]],
        });
      }
    });
}

/** Validates `--mode` without installing a throwing Commander parser. */
function resolvePolicyPlanMode(raw: unknown): PolicyPlanMode {
  const value = String(raw ?? "recommend");
  if (!isPolicyPlanMode(value)) {
    throw new LookupNotFoundError("policy-plan mode", value, [...POLICY_PLAN_MODES]);
  }
  return value;
}

/** Rejects an `--explain` key absent from the completed evaluation report. */
function assertKnownPolicyPlanDecisionKey(report: PolicyEvaluationReport, key: string): void {
  const keys = policyDecisionKeys(report);
  if (!keys.includes(key)) {
    throw new LookupNotFoundError("policy-plan decision key", key, [...keys]);
  }
}

/** Emits exactly one prose-free policy-plan result on stdout. */
async function emitPolicyPlanMachine(
  format: OutputFormat,
  report: LidarrPolicyPlanReport,
): Promise<void> {
  const { formatOutput } = await import("../lib/formatters/index.js");
  if (format === "csv") {
    await formatOutput(format, projectPolicyPlanCsv(report), {
      columns: [...LIDARR_POLICY_PLAN_CSV_COLUMNS],
    });
    return;
  }
  const output: LidarrPolicyPlanMachineOutput = { command: PLAN_COMMAND_ID, result: report };
  await formatOutput(format, output);
}

/** Whether a typed result represents an incomplete explicit sealing attempt. */
function shouldFailPolicyPlan(report: LidarrPolicyPlanReport): boolean {
  return (
    report.status === "partial" ||
    report.status === "failed" ||
    (report.mode === "plan" && report.status === "refused")
  );
}

/** Recursively redacts credentials without flattening the versioned result. */
function redactPolicyPlanValue(value: unknown, sensitiveValues: readonly unknown[]): unknown {
  if (typeof value === "string") {
    return redactErrorMessage(value, sensitiveValues);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactPolicyPlanValue(entry, sensitiveValues));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactPolicyPlanValue(entry, sensitiveValues),
      ]),
    );
  }
  return value;
}

/** Redacts supplied credentials from every string in a typed machine/human result. */
function redactPolicyPlanReport(
  report: LidarrPolicyPlanReport,
  sensitiveValues: readonly unknown[],
): LidarrPolicyPlanReport {
  return redactPolicyPlanValue(report, sensitiveValues) as LidarrPolicyPlanReport;
}

/** Builds the review-first policy-plan leaf. */
function createPlanCommand(deps: LidarrPolicyCommandDeps): Command {
  const loadActions =
    deps.loadActions ?? ((): Promise<LidarrPolicyActions> => import("../actions/lidarr/index.js"));
  const resolveSignal = deps.resolveSignal ?? getGlobalSignal;
  return new Command("plan")
    .description("Review policy proposals and optionally seal strict Lidarr plans")
    .addHelpText(
      "after",
      "\nReview-first: recommend writes no artifact; plan seals only after global preflight and never applies.",
    )
    .addOption(
      new Option(
        "--plex-library <name>",
        "Plex music library (overrides policy.plexLibrary)",
      ).helpGroup("Selection:"),
    )
    .addOption(
      new Option(
        "--rule <ids>",
        `Run only these rules (repeatable, comma-separated). Values: ${POLICY_RULE_IDS.join(", ")}`,
      )
        .argParser(parsePolicyRuleIds)
        .helpGroup("Selection:"),
    )
    .addOption(
      new Option(
        "--max-proposals <n>",
        `Per-rule proposal cap override (${MIN_MAX_PROPOSALS}-${POLICY_MAX_PROPOSALS_PER_RULE})`,
      ).helpGroup("Selection:"),
    )
    .addOption(
      new Option("--mode <mode>", `Safety rung: ${POLICY_PLAN_MODES.join("|")}`)
        .default("recommend")
        .helpGroup("Safety:"),
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
        const rules = resolveSelectedRules(
          cmdOptions["rule"] as readonly string[] | undefined,
          "lidarr policy plan",
        );
        const maxProposals = resolveMaxProposals(cmdOptions["maxProposals"] as string | undefined);
        const mode = resolvePolicyPlanMode(cmdOptions["mode"]);
        const explain = cmdOptions["explain"] as string | undefined;
        const verbose = cmdOptions["verbose"] === true;
        const machine = isMachineFormat(format);
        const sensitiveValues = [cmdOptions["lidarrApiKey"], cmdOptions["plexToken"]];

        const actionOptions: LidarrPolicyPlanActionOptions = {
          mode,
          rules,
          maxProposals,
          plexLibrary: cmdOptions["plexLibrary"] as string | undefined,
          ...(explain === undefined
            ? {}
            : {
                validateEvaluation: (report: PolicyEvaluationReport): void => {
                  assertKnownPolicyPlanDecisionKey(report, explain);
                },
              }),
          onPlanSealed: machine
            ? undefined
            : (outcome: PolicyPlanOutcome): void => {
                const safeOutcome = redactPolicyPlanValue(
                  outcome,
                  sensitiveValues,
                ) as PolicyPlanOutcome;
                renderMutationPlan(safeOutcome.generated, verbose);
              },
          plexUrl: cmdOptions["plexUrl"] as string | undefined,
          plexToken: cmdOptions["plexToken"] as string | undefined,
          lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
          lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
          signal: resolveSignal(),
        };
        const { executeLidarrPolicyPlan } = await loadActions();
        const result = await executeLidarrPolicyPlan(actionOptions);
        const report = redactPolicyPlanReport(result.report, sensitiveValues);

        if (machine) {
          await emitPolicyPlanMachine(format, report);
        } else {
          renderPolicyPlan(report, { verbose });
          if (explain !== undefined) {
            renderPolicyExplain(report.evaluation, explain);
          }
          deps.renderExecutionSummary(result.execution);
        }

        if (shouldFailPolicyPlan(report)) {
          process.exitCode = 1;
        }
      } catch (error) {
        await deps.reportLidarrFailure(PLAN_SUBCOMMAND, error, {
          staleHint: false,
          format,
          sensitiveValues: [cmdOptions["lidarrApiKey"], cmdOptions["plexToken"]],
        });
      }
    });
}

/**
 * Builds the read-only `lidarr policy` subtree for registration by `lidarr.ts`.
 *
 * @param deps - Parent-private helpers, injected to avoid the `./lidarr.js` ESM
 *   cycle.
 * @returns The `policy` parent carrying its `evaluate` and `plan` leaves.
 */
export function createLidarrPolicyCommand(deps: LidarrPolicyCommandDeps): Command {
  const policy = new Command("policy").description(
    "Evaluate Plex consumption signals and review or seal Lidarr plans (never applies)",
  );
  policy.addCommand(createEvaluateCommand(deps));
  policy.addCommand(createPlanCommand(deps));
  return policy;
}
