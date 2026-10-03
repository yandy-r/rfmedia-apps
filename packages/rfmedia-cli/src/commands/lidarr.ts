/**
 * Lidarr command definition for rfmedia CLI.
 *
 * Wires the `rfmedia lidarr` namespace into the CLI with read-only baseline
 * commands plus the reviewed plan/apply mutation boundary.
 *
 * - `lidarr status` - library overview (counts, disk usage, version)
 * - `lidarr list`   - filtered artist listing with client-side paging
 * - `lidarr wanted` - server-paginated wanted/missing albums
 * - `lidarr health` - system health checks
 *
 * Each leaf parses and validates flags, lazily imports its action, then applies
 * the machine/human output parity gate: machine formats (`--json` / `--output
 * json|yaml|csv`) are rendered to stdout via `formatOutput`; human tables are
 * rendered to stderr. Actions are framework-agnostic and never render.
 *
 * Resilience surface (issue #195): `status` and `list` accept `--allow-stale`
 * (explicit consent to serve cached data when Lidarr is unreachable). The
 * stale-serve warning is emitted by the resilience decorator — never here;
 * the command-layer stale surface is the additive `cacheStatus` field passed
 * through results and JSON envelopes. `health` appends a compact resilience
 * block to stderr in text mode (quiet when healthy). Catch blocks render the
 * failure-message contract: the failure line, a circuit-open retry-at line
 * when the error carries a cooldown, and an `--allow-stale` recovery hint on
 * stale-eligible failures.
 */

import { Command, Option, InvalidArgumentError } from "commander";
import { Table } from "console-table-printer";
import pc from "picocolors";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import { logError } from "../lib/logger.js";
import { truncate } from "../lib/format.js";
import { formatBytes } from "../lib/disk.js";
import { LidarrPlanValidationError, MissingRequiredArgumentError } from "../lib/errors.js";
import {
  createLidarrAlbumsCommand,
  createLidarrPlanAlbumMonitoringCommand,
} from "./lidarr-albums.js";
import {
  createLidarrPlanAlbumDeleteCommand,
  createLidarrPlanAlbumEditCommand,
} from "./lidarr-album-mutations.js";
import { createLidarrSearchCommands } from "./lidarr-search.js";
import { createLidarrDiscoverCommand } from "./lidarr-discover.js";
import { createLidarrAuditCommand } from "./lidarr-audit.js";
import { createLidarrReconcileCommand } from "./lidarr-reconcile.js";
import { createLidarrPolicyCommand } from "./lidarr-policy.js";
import { createLidarrSyncRatingsCommand } from "./lidarr-sync-ratings.js";
import { createLidarrImportValidationCommand } from "./lidarr-import-validation.js";
import { createLidarrPlanTrackFilterCommand } from "./lidarr-track-filter.js";
import { createLidarrPresetsCommand } from "./lidarr-presets.js";
import { confirm, isInteractive } from "../lib/prompt.js";
import {
  readLidarrExecutionMetadata,
  type LidarrExecutionMetadata,
  type LidarrExecutionFailureType,
  type LidarrExecutionSuccessMetadata,
} from "../lib/lidarr/scheduler.js";
import { redactErrorMessage } from "../lib/redact-error-message.js";
import type { LidarrTier } from "../lib/lidarr/tiers.js";
import type { GlobalOptions } from "../types/options.js";
import type {
  LidarrStatusActionResult,
  LidarrListActionResult,
  LidarrWantedActionResult,
  LidarrHealthActionResult,
  LidarrArtistDeletePlanActionOptions,
} from "../actions/lidarr/index.js";
import { LIDARR_PLAN_DEFAULT_MAX_BATCH, LIDARR_PLAN_MAX_BATCH } from "../types/lidarr-plan.js";
import type { LidarrStoredMutationPlan } from "../lib/lidarr/plan-engine.js";
import type { LidarrErrorCode } from "../lib/lidarr/index.js";
import type { LidarrHealthType } from "../types/lidarr.js";
import {
  assertInteractiveApplyApproval,
  confirmMutationApply,
  projectMutationApplyCsv,
  projectMutationPlanCsv,
  renderMutationApply,
  renderMutationPlan,
  requiresAlbumDeleteAuthorization,
  requiresArtistDeleteAuthorization,
  requiresFileDeleteAuthorization,
  requiresTagReplacementAuthorization,
} from "./lidarr-mutation-presenter.js";

/**
 * Parses and validates a positive-integer CLI argument.
 *
 * @param value - Raw string value from the CLI.
 * @returns The parsed integer, guaranteed `> 0`.
 * @throws {InvalidArgumentError} When the value is not a positive integer.
 */
function parsePositiveInt(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Value must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive integer");
  }
  return parsed;
}

/**
 * Parses and validates a non-negative-integer CLI argument.
 *
 * Used for offsets, where `0` is a valid value meaning "skip nothing".
 *
 * @param value - Raw string value from the CLI.
 * @returns The parsed integer, guaranteed `>= 0`.
 * @throws {InvalidArgumentError} When the value is not a non-negative integer.
 */
function parseNonNegativeInt(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Value must be a non-negative integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Value must be a non-negative integer");
  }
  return parsed;
}

/**
 * Accumulates repeatable numeric tag-id options into a single array.
 *
 * @param value - Raw string value for one `--tag` occurrence.
 * @param previous - Tag ids collected from earlier occurrences.
 * @returns The accumulated tag-id array.
 * @throws {InvalidArgumentError} When a value is not a positive integer.
 */
function collectTagId(value: string, previous: number[] = []): number[] {
  previous.push(parsePositiveInt(value));
  return previous;
}

/**
 * Parses a comma-separated exact-ID list of unique positive integers.
 *
 * @param label - The ID kind used in error messages (e.g. `"Artist"`).
 * @param value - Raw comma-separated CLI value.
 * @returns The parsed IDs in argument order.
 * @throws {InvalidArgumentError} On empty parts, non-positive ints, or dupes.
 */
function parseIdList(label: string, value: string): number[] {
  const values = value.split(",").map((part) => part.trim());
  if (values.some((part) => part.length === 0)) {
    throw new InvalidArgumentError(`${label} IDs must be comma-separated positive integers`);
  }
  const ids = values.map(parsePositiveInt);
  if (new Set(ids).size !== ids.length) {
    throw new InvalidArgumentError(`${label} IDs must be unique`);
  }
  return ids;
}

/** Parses a comma-separated exact artist-id list. */
function parseArtistIds(value: string): number[] {
  return parseIdList("Artist", value);
}

const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;

/** Parses one exact profile/tag reference and rejects terminal-unsafe text. */
function parseResourceReference(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || value.length > 2_048 || TERMINAL_CONTROL_PATTERN.test(value)) {
    throw new InvalidArgumentError(
      "Reference must be non-empty, at most 2048 characters, and terminal-safe",
    );
  }
  return trimmed;
}

/** Accumulates a repeatable exact profile/tag reference. */
function collectResourceReference(value: string, previous: string[] = []): string[] {
  return [...previous, parseResourceReference(value)];
}

/** Rejects plan path text that could alter an approval prompt or terminal diagnostic. */
function assertSafePlanFileArgument(value: string): string {
  if (value.length === 0 || value.length > 4_096 || TERMINAL_CONTROL_PATTERN.test(value)) {
    throw new LidarrPlanValidationError(
      "plan file path must be non-empty, bounded, and free of terminal control characters",
    );
  }
  return value;
}

/** Parses the artifact blast-radius bound. */
function parseMaxBatch(value: string): number {
  const parsed = parsePositiveInt(value);
  if (parsed > LIDARR_PLAN_MAX_BATCH) {
    throw new InvalidArgumentError(`Value must be at most ${LIDARR_PLAN_MAX_BATCH}`);
  }
  return parsed;
}

/**
 * Reads the resolved global output format from the root command.
 *
 * @returns The active {@link OutputFormat}, or `"text"` when unset.
 */
function resolveFormat(): OutputFormat {
  const globalOpts = lidarrCommand.parent?.opts() as GlobalOptions | undefined;
  return globalOpts?.output ?? "text";
}

/** Returns whether the active Lidarr leaf requested the complete human preview. */
function resolveVerbose(cmdOptions: Record<string, unknown>): boolean {
  return cmdOptions["verbose"] === true;
}

/**
 * Error codes thrown by the resilience layer when a circuit rejects a call.
 * Combined with a present `retryAfterSeconds`, they identify a circuit-open
 * rejection (the remaining cooldown) rather than an ordinary failure.
 */
const CIRCUIT_OPEN_CODES: ReadonlySet<string> = new Set<LidarrErrorCode>([
  "lidarr-unreachable",
  "metadata-provider-unavailable",
]);

/**
 * Error codes eligible for the stale-cache fallback (design §8) — the only
 * failures where the `--allow-stale` recovery hint is actionable.
 */
const STALE_HINT_CODES: ReadonlySet<string> = new Set<LidarrErrorCode>([
  "lidarr-unreachable",
  "timeout",
  "metadata-provider-unavailable",
]);

/** Failure metadata carried by `LidarrError` instances (structurally read). */
interface LidarrFailureMetadata {
  /** Taxonomy code, when the thrown error carries one. */
  readonly code?: string;
  /** Remaining cooldown / Retry-After in seconds, when carried. */
  readonly retryAfterSeconds?: number;
  /** HTTP status code, when carried. */
  readonly statusCode?: number;
  /** Whether the underlying error is eligible for a retry. */
  readonly retryable?: boolean;
}

/**
 * Structurally reads Lidarr failure metadata off an unknown thrown value.
 *
 * The command layer never imports error classes at runtime (actions are
 * lazily loaded), so the taxonomy fields are duck-typed here.
 *
 * @param error - The caught value.
 * @returns The `code`/`retryAfterSeconds` fields when present and well-typed.
 */
function readLidarrFailureMetadata(error: unknown): LidarrFailureMetadata {
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const candidate = error as {
    code?: unknown;
    retryAfterSeconds?: unknown;
    statusCode?: unknown;
    retryable?: unknown;
  };
  return {
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    retryAfterSeconds:
      typeof candidate.retryAfterSeconds === "number" &&
      Number.isFinite(candidate.retryAfterSeconds)
        ? candidate.retryAfterSeconds
        : undefined,
    statusCode:
      typeof candidate.statusCode === "number" && Number.isFinite(candidate.statusCode)
        ? candidate.statusCode
        : undefined,
    retryable: typeof candidate.retryable === "boolean" ? candidate.retryable : undefined,
  };
}

/** Machine-readable failure envelope shared by every Lidarr subcommand. */
interface LidarrFailureOutput {
  command: `lidarr-${string}`;
  error: {
    message: string;
    code?: string;
    lane: LidarrTier | "unknown";
    outcome: "failed";
    attempts: number;
    failureType: LidarrExecutionFailureType | "unknown";
    statusCode?: number;
    retryable?: boolean;
    retryAfterSeconds?: number;
  };
}

/**
 * Formats a wall-clock `HH:MM:SS` timestamp in local time.
 *
 * @param date - The instant to format.
 * @returns The zero-padded `HH:MM:SS` string.
 */
function formatClockTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Renders the failure-message contract (design §6) to stderr and sets the
 * failing exit code — never `process.exit()`.
 *
 * Lines emitted: the failure line; a `Circuit open` retry-at line when the
 * error is a circuit-open rejection (scope-mapped code plus a carried
 * cooldown); and the `--allow-stale` recovery hint on stale-eligible codes.
 * The hint deliberately omits the fetched-age parenthetical: thrown errors
 * carry no cache metadata and commands never open the database.
 *
 * @param subcommand - Leaf name used in the failure line (e.g. `"list"`).
 * @param error - The caught value from the action layer.
 * @param options - Rendering switches.
 * @param options.staleHint - Whether the `--allow-stale` hint may render
 *   (true only on `status`/`list` when the flag was not already passed).
 */
async function reportLidarrFailure(
  subcommand: string,
  error: unknown,
  options: {
    readonly staleHint: boolean;
    readonly format: OutputFormat;
    readonly sensitiveValues?: readonly unknown[];
  },
): Promise<void> {
  const message = redactErrorMessage(error, options.sensitiveValues);
  const { code, retryAfterSeconds, statusCode, retryable } = readLidarrFailureMetadata(error);
  const execution = readLidarrExecutionMetadata(error);

  if (isMachineFormat(options.format)) {
    const { formatOutput } = await import("../lib/formatters/index.js");
    const output: LidarrFailureOutput = {
      command: `lidarr-${subcommand}`,
      error: {
        message,
        code,
        lane: execution?.lane ?? "unknown",
        outcome: "failed",
        attempts: execution?.attempts ?? 1,
        failureType: execution?.failureType ?? "unknown",
        statusCode,
        retryable,
        retryAfterSeconds,
      },
    };
    await formatOutput(options.format, output);
  } else {
    logError(`Lidarr ${subcommand} failed: ${message}`);
    if (execution !== undefined) {
      logError(
        `Execution: ${execution.lane} lane · ${execution.attempts} ${execution.attempts === 1 ? "attempt" : "attempts"} · ${execution.failureType}.`,
      );
    }
    if (code !== undefined && CIRCUIT_OPEN_CODES.has(code) && retryAfterSeconds !== undefined) {
      const retryAt = new Date(Date.now() + retryAfterSeconds * 1000);
      logError(
        `Circuit open — automatic retries resume at ${formatClockTime(retryAt)} (${retryAfterSeconds}s).`,
      );
    }
    if (options.staleHint && code !== undefined && STALE_HINT_CODES.has(code)) {
      logError(
        "Hint: rerun with --allow-stale to use cached data, or run `rfmedia lidarr health`.",
      );
    }
  }
  process.exitCode = 1;
}

/** Renders successful execution-lane metadata in human output. */
function renderExecutionSummary(execution: LidarrExecutionSuccessMetadata): void {
  console.error(
    pc.dim(
      `  Execution: ${execution.lane} lane · ${execution.attempts} ${execution.attempts === 1 ? "attempt" : "attempts"}`,
    ),
  );
  console.error("");
}

function isSuccessfulExecution(
  execution: LidarrExecutionMetadata | undefined,
): execution is LidarrExecutionSuccessMetadata {
  return execution?.outcome === "succeeded";
}

/** Command identifiers emitted by successful Lidarr machine output. */
type LidarrSuccessCommand =
  | "lidarr-status"
  | "lidarr-list"
  | "lidarr-wanted"
  | "lidarr-health"
  | "lidarr-albums";

/** Successful action result shapes accepted by the shared CSV projection. */
type LidarrSuccessActionResult =
  | LidarrStatusActionResult
  | LidarrListActionResult
  | LidarrWantedActionResult
  | LidarrHealthActionResult;

/**
 * Projects a successful Lidarr result into one flat, CSV-safe record.
 *
 * The shared CSV serializer supports only two levels of object nesting, so
 * the normal `{ command, result: { execution: ... } }` envelope exceeds its
 * limit. Dot-notation column names preserve the envelope paths without nested
 * objects, while compound domain values are encoded as JSON cells.
 */
function projectLidarrCsvSuccess(
  command: LidarrSuccessCommand,
  result: LidarrSuccessActionResult,
): Record<string, unknown> {
  const output: Record<string, unknown> = { command };

  for (const [key, value] of Object.entries(result)) {
    if (key === "execution") {
      continue;
    }
    output[`result.${key}`] =
      typeof value === "object" && value !== null ? JSON.stringify(value) : value;
  }

  output["result.execution.lane"] = result.execution.lane;
  output["result.execution.outcome"] = result.execution.outcome;
  output["result.execution.attempts"] = result.execution.attempts;

  return output;
}

/**
 * Lidarr command - parent for the read-only baseline subcommands.
 */
export const lidarrCommand = new Command("lidarr").description(
  "Lidarr music-management operations",
);

const { searchCommand: lidarrSearchCommand, lookupCommand: lidarrLookupCommand } =
  createLidarrSearchCommands({
    resolveFormat,
    reportLidarrFailure,
    renderExecutionSummary,
  });
const lidarrDiscoverCommand = createLidarrDiscoverCommand({
  resolveFormat,
  parseResourceReference,
  parsePlanFile: assertSafePlanFileArgument,
  reportLidarrFailure,
  renderExecutionSummary,
});
const lidarrPresetsCommand = createLidarrPresetsCommand({
  resolveFormat,
  reportLidarrFailure,
  confirm,
  isInteractive,
});

// ── status ──────────────────────────────────────────────────────────────────

/** JSON envelope for `lidarr status`. */
interface LidarrStatusJsonOutput {
  command: "lidarr-status";
  result: LidarrStatusActionResult;
}

/**
 * Renders the `lidarr status` overview as a labeled summary table on stderr.
 *
 * @param result - The aggregated library overview.
 */
function renderStatus(result: LidarrStatusActionResult): void {
  console.error("");
  console.error(pc.bold("Lidarr Library Overview"));
  console.error("");

  const table = new Table({
    columns: [
      { name: "field", title: "Field", alignment: "left" },
      { name: "value", title: "Value", alignment: "left" },
    ],
  });

  table.addRow({ field: "Version", value: result.version });
  table.addRow({ field: "Instance", value: result.instanceName ?? "-" });
  table.addRow({ field: "Artists", value: result.artistCount.toString() });
  table.addRow({
    field: "Monitored",
    value: `${result.monitoredCount} (${result.unmonitoredCount} unmonitored)`,
  });
  table.addRow({ field: "On Disk", value: formatBytes(result.totalSizeOnDisk) });
  table.addRow({ field: "Tracks", value: `${result.trackFileCount}/${result.trackCount}` });

  console.error(table.render());
  console.error("");
}

const lidarrStatusCommand = new Command("status")
  .description("Show a Lidarr library overview (counts, disk usage, version)")
  .addOption(new Option("--allow-stale", "Serve stale cached data when Lidarr is unreachable"))
  .option("--lidarr-url <url>", "Lidarr base URL (overrides config)")
  .option("--lidarr-api-key <key>", "Lidarr API key (overrides config)")
  .action(async (cmdOptions: Record<string, unknown>) => {
    const format = resolveFormat();
    try {
      const { executeLidarrStatus } = await import("../actions/lidarr/index.js");
      const result = await executeLidarrStatus({
        allowStale: cmdOptions["allowStale"] as boolean | undefined,
        lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
        lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
      });

      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: LidarrStatusJsonOutput = { command: "lidarr-status", result };
        await formatOutput(
          format,
          format === "csv" ? projectLidarrCsvSuccess("lidarr-status", result) : jsonOutput,
        );
      } else {
        renderStatus(result);
        renderExecutionSummary(result.execution);
      }
    } catch (error) {
      await reportLidarrFailure("status", error, {
        staleHint: cmdOptions["allowStale"] !== true,
        format,
      });
    }
  });

// ── list ────────────────────────────────────────────────────────────────────

/** JSON envelope for `lidarr list`. */
interface LidarrListJsonOutput {
  command: "lidarr-list";
  result: LidarrListActionResult;
}

/**
 * Renders the `lidarr list` rows as a table on stderr with a paging footer.
 *
 * @param result - The paged, filtered artist rows plus the pre-slice total.
 */
function renderList(result: LidarrListActionResult): void {
  console.error("");
  console.error(pc.bold("Lidarr Artists"));
  console.error("");

  if (result.artists.length === 0) {
    console.error(pc.yellow("  No artists match the criteria"));
    console.error("");
    return;
  }

  const table = new Table({
    columns: [
      { name: "id", title: "ID", alignment: "right" },
      { name: "artist", title: "Artist", alignment: "left" },
      { name: "monitored", title: "Monitored", alignment: "center" },
      { name: "albums", title: "Albums", alignment: "right" },
      { name: "onDisk", title: "On Disk", alignment: "right" },
      { name: "mbid", title: "MBID", alignment: "left" },
    ],
  });

  for (const artist of result.artists) {
    table.addRow({
      id: artist.id,
      artist: truncate(artist.artistName, 40),
      monitored: artist.monitored ? "Yes" : "No",
      albums: artist.albumCount.toString(),
      onDisk: formatBytes(artist.sizeOnDisk),
      mbid: artist.foreignArtistId,
    });
  }

  console.error(table.render());
  console.error(pc.dim(`  Showing ${result.artists.length} of ${result.total}`));
  console.error("");
}

const lidarrListCommand = new Command("list")
  .description("List Lidarr artists with optional filters")
  .addOption(
    new Option("--tag <id>", "Filter by tag id (repeatable; matches all provided)").argParser(
      collectTagId,
    ),
  )
  .addOption(new Option("--monitored", "Show only monitored artists").conflicts("unmonitored"))
  .addOption(new Option("--unmonitored", "Show only unmonitored artists").conflicts("monitored"))
  .addOption(
    new Option("--quality-profile <id>", "Filter by quality-profile id").argParser(
      parsePositiveInt,
    ),
  )
  .addOption(
    new Option("--limit <n>", "Maximum artists to return").argParser(parsePositiveInt).default(50),
  )
  .addOption(new Option("--offset <n>", "Number of artists to skip").argParser(parseNonNegativeInt))
  .addOption(new Option("--allow-stale", "Serve stale cached data when Lidarr is unreachable"))
  .option("--lidarr-url <url>", "Lidarr base URL (overrides config)")
  .option("--lidarr-api-key <key>", "Lidarr API key (overrides config)")
  .action(async (cmdOptions: Record<string, unknown>) => {
    const format = resolveFormat();
    try {
      const { executeLidarrList } = await import("../actions/lidarr/index.js");
      const result = await executeLidarrList({
        tag: cmdOptions["tag"] as number[] | undefined,
        monitored: cmdOptions["monitored"] as boolean | undefined,
        unmonitored: cmdOptions["unmonitored"] as boolean | undefined,
        qualityProfile: cmdOptions["qualityProfile"] as number | undefined,
        limit: cmdOptions["limit"] as number | undefined,
        offset: cmdOptions["offset"] as number | undefined,
        allowStale: cmdOptions["allowStale"] as boolean | undefined,
        lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
        lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
      });

      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: LidarrListJsonOutput = { command: "lidarr-list", result };
        await formatOutput(
          format,
          format === "csv" ? projectLidarrCsvSuccess("lidarr-list", result) : jsonOutput,
        );
      } else {
        renderList(result);
        renderExecutionSummary(result.execution);
      }
    } catch (error) {
      await reportLidarrFailure("list", error, {
        staleHint: cmdOptions["allowStale"] !== true,
        format,
      });
    }
  });

// ── wanted ──────────────────────────────────────────────────────────────────

/** JSON envelope for `lidarr wanted`. */
interface LidarrWantedJsonOutput {
  command: "lidarr-wanted";
  result: LidarrWantedActionResult;
}

/**
 * Renders the `lidarr wanted` rows as a table on stderr with a paging footer.
 *
 * @param result - The projected wanted/missing rows for the fetched page.
 */
function renderWanted(result: LidarrWantedActionResult): void {
  console.error("");
  console.error(pc.bold("Lidarr Wanted / Missing"));
  console.error("");

  if (result.records.length === 0) {
    console.error(pc.yellow("  No wanted albums on this page"));
    console.error("");
    return;
  }

  const table = new Table({
    columns: [
      { name: "album", title: "Album", alignment: "left" },
      { name: "artist", title: "Artist", alignment: "left" },
      { name: "release", title: "Release", alignment: "left" },
      { name: "monitored", title: "Monitored", alignment: "center" },
    ],
  });

  for (const record of result.records) {
    table.addRow({
      album: truncate(record.title, 40),
      artist: truncate(record.artistName, 30),
      release: record.releaseDate ?? "-",
      monitored: record.monitored ? "Yes" : "No",
    });
  }

  console.error(table.render());
  console.error(pc.dim(`  Page ${result.page} — ${result.totalRecords} wanted`));
  console.error("");
}

const lidarrWantedCommand = new Command("wanted")
  .description("List Lidarr wanted/missing albums (server-paginated)")
  .addOption(
    new Option("--page <n>", "Page number to fetch").argParser(parsePositiveInt).default(1),
  )
  .addOption(
    new Option("--page-size <n>", "Records per page").argParser(parsePositiveInt).default(50),
  )
  .addOption(
    new Option("--sort-key <key>", "Sort key")
      .choices(["releaseDate", "title", "artist"])
      .default("releaseDate"),
  )
  .addOption(
    new Option("--sort-dir <dir>", "Sort direction")
      .choices(["ascending", "descending"])
      .default("descending"),
  )
  .option("--lidarr-url <url>", "Lidarr base URL (overrides config)")
  .option("--lidarr-api-key <key>", "Lidarr API key (overrides config)")
  .action(async (cmdOptions: Record<string, unknown>) => {
    const format = resolveFormat();
    try {
      const { executeLidarrWanted } = await import("../actions/lidarr/index.js");
      const result = await executeLidarrWanted({
        page: cmdOptions["page"] as number | undefined,
        pageSize: cmdOptions["pageSize"] as number | undefined,
        sortKey: cmdOptions["sortKey"] as string | undefined,
        sortDir: cmdOptions["sortDir"] as "ascending" | "descending" | undefined,
        lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
        lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
      });

      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: LidarrWantedJsonOutput = { command: "lidarr-wanted", result };
        await formatOutput(
          format,
          format === "csv" ? projectLidarrCsvSuccess("lidarr-wanted", result) : jsonOutput,
        );
      } else {
        renderWanted(result);
        renderExecutionSummary(result.execution);
      }
    } catch (error) {
      await reportLidarrFailure("wanted", error, { staleHint: false, format });
    }
  });

// ── health ──────────────────────────────────────────────────────────────────

/** JSON envelope for `lidarr health`. */
interface LidarrHealthJsonOutput {
  command: "lidarr-health";
  result: LidarrHealthActionResult;
}

/**
 * Renders the `lidarr health` checks as a table on stderr.
 *
 * @param result - The (optionally filtered) health checks and error flag.
 */
function renderHealth(result: LidarrHealthActionResult): void {
  console.error("");
  console.error(pc.bold("Lidarr Health"));
  console.error("");

  if (result.checks.length === 0) {
    console.error(pc.green("  No health issues reported."));
    console.error("");
    return;
  }

  const table = new Table({
    columns: [
      { name: "type", title: "Type", alignment: "left" },
      { name: "source", title: "Source", alignment: "left" },
      { name: "message", title: "Message", alignment: "left" },
    ],
  });

  for (const check of result.checks) {
    table.addRow({
      type: check.type,
      source: check.source,
      message: truncate(check.message, 60),
    });
  }

  console.error(table.render());
  console.error("");
}

/**
 * Appends the compact resilience block (design §6) to stderr in text mode.
 *
 * Quiet when healthy: nothing is rendered when every circuit is `closed` and
 * no deferred intents are pending or failed. On any degradation the block
 * lists each circuit state and the deferred-intent counts, e.g.
 * `Circuit [lidarr]: open · Circuit [metadata]: closed · Deferred intents: 2 pending`.
 *
 * @param result - The health action result carrying the optional snapshot.
 */
function renderHealthResilienceBlock(result: LidarrHealthActionResult): void {
  const resilience = result.resilience;
  if (resilience === undefined) {
    return;
  }

  const circuitsClosed = resilience.circuits.every((circuit) => circuit.state.state === "closed");
  const { pending, failed } = resilience.deferredIntents;
  if (circuitsClosed && pending === 0 && failed === 0) {
    return;
  }

  const parts = resilience.circuits.map(
    (circuit) => `Circuit [${circuit.scope}]: ${circuit.state.state}`,
  );
  const failedSuffix = failed > 0 ? `, ${failed} failed` : "";
  parts.push(`Deferred intents: ${pending} pending${failedSuffix}`);

  console.error(pc.yellow(parts.join(" · ")));
  console.error("");
}

const lidarrHealthCommand = new Command("health")
  .description("Show Lidarr system health checks")
  .addOption(
    new Option("--type <type...>", "Filter by severity (repeatable)").choices([
      "ok",
      "notice",
      "warning",
      "error",
    ]),
  )
  .option("--lidarr-url <url>", "Lidarr base URL (overrides config)")
  .option("--lidarr-api-key <key>", "Lidarr API key (overrides config)")
  .action(async (cmdOptions: Record<string, unknown>) => {
    const format = resolveFormat();
    try {
      const { executeLidarrHealth } = await import("../actions/lidarr/index.js");
      const result = await executeLidarrHealth({
        type: cmdOptions["type"] as readonly LidarrHealthType[] | undefined,
        lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
        lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
      });

      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: LidarrHealthJsonOutput = { command: "lidarr-health", result };
        await formatOutput(
          format,
          format === "csv" ? projectLidarrCsvSuccess("lidarr-health", result) : jsonOutput,
        );
      } else {
        renderHealth(result);
        renderHealthResilienceBlock(result);
        renderExecutionSummary(result.execution);
      }
    } catch (error) {
      await reportLidarrFailure("health", error, { staleHint: false, format });
    }
  });

// ── mutation plan/apply ────────────────────────────────────────────────────

const lidarrPlanCommand = new Command("plan").description(
  "Create a sealed, read-only Lidarr mutation plan",
);

function addArtistSelectionOptions(command: Command): Command {
  const otherSelectionOptions = [
    "all",
    "selectMonitored",
    "selectUnmonitored",
    "selectQualityProfile",
    "selectMetadataProfile",
    "selectTag",
  ];
  return command
    .addOption(
      new Option("--ids <ids>", "Select comma-separated exact Lidarr artist IDs")
        .argParser(parseArtistIds)
        .conflicts(otherSelectionOptions)
        .helpGroup("Selection:"),
    )
    .addOption(
      new Option("--all", "Select the complete Lidarr artist library")
        .conflicts(["ids", ...otherSelectionOptions.slice(1)])
        .helpGroup("Selection:"),
    )
    .addOption(
      new Option("--select-monitored", "Select monitored artists")
        .conflicts(["ids", "all", "selectUnmonitored"])
        .helpGroup("Selection:"),
    )
    .addOption(
      new Option("--select-unmonitored", "Select unmonitored artists")
        .conflicts(["ids", "all", "selectMonitored"])
        .helpGroup("Selection:"),
    )
    .addOption(
      new Option("--select-quality-profile <reference>", "Select by exact quality profile")
        .argParser(parseResourceReference)
        .conflicts(["ids", "all"])
        .helpGroup("Selection:"),
    )
    .addOption(
      new Option("--select-metadata-profile <reference>", "Select by exact metadata profile")
        .argParser(parseResourceReference)
        .conflicts(["ids", "all"])
        .helpGroup("Selection:"),
    )
    .addOption(
      new Option("--select-tag <reference>", "Select by tag (repeatable; all-of)")
        .argParser(collectResourceReference)
        .conflicts(["ids", "all"])
        .helpGroup("Selection:"),
    );
}

function addPlanSafetyConnectionOutputOptions(command: Command): Command {
  return command
    .addOption(
      new Option("--max-batch <n>", "Maximum targets allowed in the artifact")
        .argParser(parseMaxBatch)
        .default(LIDARR_PLAN_DEFAULT_MAX_BATCH)
        .helpGroup("Safety:"),
    )
    .addOption(new Option("--plan-file <path>", "Write the sealed plan here").helpGroup("Safety:"))
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
    .addOption(
      new Option("-v, --verbose", "Show every artist in human output").helpGroup("Output:"),
    );
}

function hasArtistSelectionOptions(options: Record<string, unknown>): boolean {
  return (
    options["ids"] !== undefined ||
    options["all"] === true ||
    options["selectMonitored"] === true ||
    options["selectUnmonitored"] === true ||
    options["selectQualityProfile"] !== undefined ||
    options["selectMetadataProfile"] !== undefined ||
    options["selectTag"] !== undefined
  );
}

const lidarrPlanArtistMonitoringCommand = new Command("artist-monitoring")
  .description("Plan exact-ID artist monitoring changes")
  .addOption(
    new Option("--ids <ids>", "Comma-separated Lidarr artist IDs")
      .argParser(parseArtistIds)
      .makeOptionMandatory(),
  )
  .addOption(new Option("--monitored", "Set artists to monitored").conflicts("unmonitored"))
  .addOption(new Option("--unmonitored", "Set artists to unmonitored").conflicts("monitored"))
  .addOption(
    new Option("--max-batch <n>", "Maximum targets allowed in the artifact")
      .argParser(parseMaxBatch)
      .default(LIDARR_PLAN_DEFAULT_MAX_BATCH),
  )
  .addOption(new Option("--plan-file <path>", "Write the plan to this path").helpGroup("Safety:"))
  .addOption(
    new Option("--lidarr-url <url>", "Lidarr base URL (overrides config)").helpGroup("Connection:"),
  )
  .addOption(
    new Option("--lidarr-api-key <key>", "Lidarr API key (overrides config)").helpGroup(
      "Connection:",
    ),
  )
  .addOption(new Option("-v, --verbose", "Show every artist in human output").helpGroup("Output:"))
  .action(async (cmdOptions: Record<string, unknown>) => {
    const format = resolveFormat();
    try {
      if (cmdOptions["monitored"] !== true && cmdOptions["unmonitored"] !== true) {
        throw new MissingRequiredArgumentError("Pass --monitored or --unmonitored");
      }
      const { executeLidarrPlan } = await import("../actions/lidarr/index.js");
      const result = await executeLidarrPlan({
        artistIds: cmdOptions["ids"] as number[],
        monitored: cmdOptions["monitored"] === true,
        maxBatch: cmdOptions["maxBatch"] as number,
        output: cmdOptions["planFile"] as string | undefined,
        lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
        lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
      });
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(
          format,
          format === "csv" ? projectMutationPlanCsv(result) : { command: "lidarr-plan", result },
        );
      } else {
        renderMutationPlan(result, resolveVerbose(cmdOptions));
      }
    } catch (error) {
      await reportLidarrFailure("plan", error, {
        staleHint: false,
        format,
        sensitiveValues: [cmdOptions["lidarrApiKey"]],
      });
    }
  });

lidarrPlanCommand.addCommand(lidarrPlanArtistMonitoringCommand);
// ORDER-SENSITIVE: album-monitoring registers after artist-monitoring (the
// hierarchy contract test pins the exact child order).
lidarrPlanCommand.addCommand(
  createLidarrPlanAlbumMonitoringCommand({
    resolveFormat,
    reportLidarrFailure,
    parseIdList,
    parseMaxBatch,
    assertSafePlanFileArgument,
  }),
);

const lidarrPlanArtistProfilesCommand = addPlanSafetyConnectionOutputOptions(
  addArtistSelectionOptions(
    new Command("artist-profiles")
      .description("Plan quality and metadata profile assignments")
      .addOption(
        new Option("--quality-profile <reference>", "Assign an existing quality profile")
          .argParser(parseResourceReference)
          .helpGroup("Desired changes:"),
      )
      .addOption(
        new Option("--metadata-profile <reference>", "Assign an existing metadata profile")
          .argParser(parseResourceReference)
          .helpGroup("Desired changes:"),
      ),
  ),
).action(async (cmdOptions: Record<string, unknown>) => {
  const format = resolveFormat();
  try {
    if (!hasArtistSelectionOptions(cmdOptions)) {
      throw new MissingRequiredArgumentError(
        "Choose exactly one selection mode: --ids, filters, or --all",
      );
    }
    if (cmdOptions["qualityProfile"] === undefined && cmdOptions["metadataProfile"] === undefined) {
      throw new MissingRequiredArgumentError("Pass --quality-profile and/or --metadata-profile");
    }
    const { executeLidarrArtistProfilePlan } = await import("../actions/lidarr/index.js");
    const result = await executeLidarrArtistProfilePlan({
      artistIds: cmdOptions["ids"] as number[] | undefined,
      all: cmdOptions["all"] as boolean | undefined,
      selectMonitored: cmdOptions["selectMonitored"] as boolean | undefined,
      selectUnmonitored: cmdOptions["selectUnmonitored"] as boolean | undefined,
      selectQualityProfile: cmdOptions["selectQualityProfile"] as string | undefined,
      selectMetadataProfile: cmdOptions["selectMetadataProfile"] as string | undefined,
      selectTags: cmdOptions["selectTag"] as string[] | undefined,
      qualityProfile: cmdOptions["qualityProfile"] as string | undefined,
      metadataProfile: cmdOptions["metadataProfile"] as string | undefined,
      maxBatch: cmdOptions["maxBatch"] as number | undefined,
      output: cmdOptions["planFile"] as string | undefined,
      lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
      lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
    });
    if (isMachineFormat(format)) {
      const { formatOutput } = await import("../lib/formatters/index.js");
      await formatOutput(
        format,
        format === "csv" ? projectMutationPlanCsv(result) : { command: "lidarr-plan", result },
      );
    } else {
      renderMutationPlan(result, resolveVerbose(cmdOptions));
    }
  } catch (error) {
    await reportLidarrFailure("plan-artist-profiles", error, {
      staleHint: false,
      format,
      sensitiveValues: [cmdOptions["lidarrApiKey"]],
    });
  }
});

const lidarrPlanArtistTagsCommand = addPlanSafetyConnectionOutputOptions(
  addArtistSelectionOptions(
    new Command("artist-tags")
      .description("Plan additive or replacement tag assignments")
      .addOption(
        new Option("--add-tag <reference>", "Add an existing tag (repeatable)")
          .argParser(collectResourceReference)
          .conflicts(["removeTag", "setTag", "clearTags"])
          .helpGroup("Desired changes:"),
      )
      .addOption(
        new Option("--remove-tag <reference>", "Remove an existing tag (repeatable)")
          .argParser(collectResourceReference)
          .conflicts(["addTag", "setTag", "clearTags"])
          .helpGroup("Desired changes:"),
      )
      .addOption(
        new Option("--set-tag <reference>", "Replace with this tag set (repeatable)")
          .argParser(collectResourceReference)
          .conflicts(["addTag", "removeTag", "clearTags"])
          .helpGroup("Desired changes:"),
      )
      .addOption(
        new Option("--clear-tags", "Replace the complete tag set with no tags")
          .conflicts(["addTag", "removeTag", "setTag"])
          .helpGroup("Desired changes:"),
      ),
  ),
).action(async (cmdOptions: Record<string, unknown>) => {
  const format = resolveFormat();
  try {
    if (!hasArtistSelectionOptions(cmdOptions)) {
      throw new MissingRequiredArgumentError(
        "Choose exactly one selection mode: --ids, filters, or --all",
      );
    }
    const { executeLidarrArtistTagPlan } = await import("../actions/lidarr/index.js");
    const result = await executeLidarrArtistTagPlan({
      artistIds: cmdOptions["ids"] as number[] | undefined,
      all: cmdOptions["all"] as boolean | undefined,
      selectMonitored: cmdOptions["selectMonitored"] as boolean | undefined,
      selectUnmonitored: cmdOptions["selectUnmonitored"] as boolean | undefined,
      selectQualityProfile: cmdOptions["selectQualityProfile"] as string | undefined,
      selectMetadataProfile: cmdOptions["selectMetadataProfile"] as string | undefined,
      selectTags: cmdOptions["selectTag"] as string[] | undefined,
      addTags: cmdOptions["addTag"] as string[] | undefined,
      removeTags: cmdOptions["removeTag"] as string[] | undefined,
      setTags: cmdOptions["setTag"] as string[] | undefined,
      clearTags: cmdOptions["clearTags"] as boolean | undefined,
      maxBatch: cmdOptions["maxBatch"] as number | undefined,
      output: cmdOptions["planFile"] as string | undefined,
      lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
      lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
    });
    if (isMachineFormat(format)) {
      const { formatOutput } = await import("../lib/formatters/index.js");
      await formatOutput(
        format,
        format === "csv" ? projectMutationPlanCsv(result) : { command: "lidarr-plan", result },
      );
    } else {
      renderMutationPlan(result, resolveVerbose(cmdOptions));
    }
  } catch (error) {
    await reportLidarrFailure("plan-artist-tags", error, {
      staleHint: false,
      format,
      sensitiveValues: [cmdOptions["lidarrApiKey"]],
    });
  }
});

lidarrPlanCommand.addCommand(lidarrPlanArtistProfilesCommand);
lidarrPlanCommand.addCommand(lidarrPlanArtistTagsCommand);
// ORDER-SENSITIVE: the two album operations register last — album-edit before
// album-delete so the destructive lane is the final child (the hierarchy
// contract test pins the exact child order).
lidarrPlanCommand.addCommand(
  createLidarrPlanAlbumEditCommand({
    resolveFormat,
    reportLidarrFailure,
    parseIdList,
    parseMaxBatch,
    assertSafePlanFileArgument,
  }),
);
lidarrPlanCommand.addCommand(
  createLidarrPlanAlbumDeleteCommand({
    resolveFormat,
    reportLidarrFailure,
    parseIdList,
    parseMaxBatch,
    assertSafePlanFileArgument,
  }),
);

const lidarrPlanArtistDeleteCommand = addPlanSafetyConnectionOutputOptions(
  addArtistSelectionOptions(
    new Command("artist-delete")
      .description("Plan irreversible artist deletion with exact file-impact evidence")
      .addOption(
        new Option("--delete-files", "Ask Lidarr to delete managed files")
          .default(false)
          .helpGroup("Desired changes:"),
      )
      .addOption(
        new Option("--dry-run", "Preview the complete plan without writing an artifact").helpGroup(
          "Safety:",
        ),
      ),
  ),
).action(async (cmdOptions: Record<string, unknown>) => {
  const format = resolveFormat();
  try {
    if (!hasArtistSelectionOptions(cmdOptions)) {
      throw new MissingRequiredArgumentError(
        "Choose exactly one selection mode: --ids, filters, or --all",
      );
    }
    const { executeLidarrArtistDeletePlan } = await import("../actions/lidarr/index.js");
    const selectionOptions = {
      artistIds: cmdOptions["ids"] as number[] | undefined,
      all: cmdOptions["all"] as boolean | undefined,
      selectMonitored: cmdOptions["selectMonitored"] as boolean | undefined,
      selectUnmonitored: cmdOptions["selectUnmonitored"] as boolean | undefined,
      selectQualityProfile: cmdOptions["selectQualityProfile"] as string | undefined,
      selectMetadataProfile: cmdOptions["selectMetadataProfile"] as string | undefined,
      selectTags: cmdOptions["selectTag"] as string[] | undefined,
    } satisfies Pick<
      LidarrArtistDeletePlanActionOptions,
      | "artistIds"
      | "all"
      | "selectMonitored"
      | "selectUnmonitored"
      | "selectQualityProfile"
      | "selectMetadataProfile"
      | "selectTags"
    >;
    const result = await executeLidarrArtistDeletePlan({
      ...selectionOptions,
      deleteFiles: cmdOptions["deleteFiles"] as boolean | undefined,
      dryRun: cmdOptions["dryRun"] as boolean | undefined,
      maxBatch: cmdOptions["maxBatch"] as number | undefined,
      output: cmdOptions["planFile"] as string | undefined,
      lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
      lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
    });
    if (isMachineFormat(format)) {
      const { formatOutput } = await import("../lib/formatters/index.js");
      await formatOutput(
        format,
        format === "csv" ? projectMutationPlanCsv(result) : { command: "lidarr-plan", result },
      );
    } else {
      renderMutationPlan(result, resolveVerbose(cmdOptions));
    }
  } catch (error) {
    await reportLidarrFailure("plan-artist-delete", error, {
      staleHint: false,
      format,
      sensitiveValues: [cmdOptions["lidarrApiKey"]],
    });
  }
});

lidarrPlanCommand.addCommand(lidarrPlanArtistDeleteCommand);
lidarrPlanCommand.addCommand(
  createLidarrPlanTrackFilterCommand({
    resolveFormat,
    reportLidarrFailure,
    parseIdList,
    parseMaxBatch,
    assertSafePlanFileArgument,
  }),
);

const lidarrApplyCommand = new Command("apply")
  .description("Validate and apply a reviewed Lidarr mutation plan")
  .argument("<plan-file>", "Path to a Lidarr mutation plan")
  .addOption(
    new Option("--yes", "Approve mutation without an interactive prompt").helpGroup("Safety:"),
  )
  .addOption(
    new Option("--allow-tag-replacement", "Authorize destructive tag set/clear plans").helpGroup(
      "Safety:",
    ),
  )
  .addOption(
    new Option("--allow-artist-delete", "Authorize irreversible artist deletion").helpGroup(
      "Safety:",
    ),
  )
  .addOption(
    new Option("--allow-album-delete", "Authorize destructive album-delete plans").helpGroup(
      "Safety:",
    ),
  )
  .addOption(
    new Option("--allow-file-delete", "Authorize deletion of Lidarr-managed files").helpGroup(
      "Safety:",
    ),
  )
  .addOption(
    new Option(
      "--plex-scan",
      "Request one best-effort media-server scan after eligible deletion",
    ).helpGroup("Follow-up:"),
  )
  .addOption(
    new Option("--expected-plan-id <id>", "Require this reviewed plan ID").helpGroup("Safety:"),
  )
  .addOption(
    new Option("--expected-plan-checksum <checksum>", "Require this reviewed checksum").helpGroup(
      "Safety:",
    ),
  )
  .addOption(
    new Option("--resume", "Resume incomplete work and skip durable successes").helpGroup(
      "Safety:",
    ),
  )
  .addOption(
    new Option("--dry-run", "Validate live state without mutation or history writes").helpGroup(
      "Safety:",
    ),
  )
  .addOption(
    new Option("--lidarr-url <url>", "Lidarr base URL (overrides config)").helpGroup("Connection:"),
  )
  .addOption(
    new Option("--lidarr-api-key <key>", "Lidarr API key (overrides config)").helpGroup(
      "Connection:",
    ),
  )
  .addOption(new Option("-v, --verbose", "Show every artist in human output").helpGroup("Output:"))
  .action(async (planFile: string, cmdOptions: Record<string, unknown>) => {
    const format = resolveFormat();
    try {
      assertSafePlanFileArgument(planFile);
      const dryRun = cmdOptions["dryRun"] === true;
      const allowTagReplacement = cmdOptions["allowTagReplacement"] === true;
      const allowArtistDelete = cmdOptions["allowArtistDelete"] === true;
      const allowAlbumDelete = cmdOptions["allowAlbumDelete"] === true;
      const allowFileDelete = cmdOptions["allowFileDelete"] === true;
      const plexScan = cmdOptions["plexScan"] === true;
      let expectedPlanId = cmdOptions["expectedPlanId"] as string | undefined;
      let expectedPlanChecksum = cmdOptions["expectedPlanChecksum"] as string | undefined;
      let reviewedPlan: LidarrStoredMutationPlan | undefined;
      if (!dryRun) {
        const { readLidarrPlanArtifact } = await import("../lib/lidarr/plan-engine.js");
        reviewedPlan = await readLidarrPlanArtifact(planFile);
        if (requiresTagReplacementAuthorization(reviewedPlan) && !allowTagReplacement) {
          throw new MissingRequiredArgumentError(
            "--allow-tag-replacement is required for tag set/clear plans",
          );
        }
        if (requiresArtistDeleteAuthorization(reviewedPlan) && !allowArtistDelete) {
          throw new MissingRequiredArgumentError(
            "--allow-artist-delete is required for artist-delete plans",
          );
        }
        if (requiresAlbumDeleteAuthorization(reviewedPlan) && !allowAlbumDelete) {
          throw new MissingRequiredArgumentError(
            "--allow-album-delete is required for album-delete plans",
          );
        }
        if (requiresFileDeleteAuthorization(reviewedPlan) && !allowFileDelete) {
          throw new MissingRequiredArgumentError(
            "--allow-file-delete is required when the sealed plan deletes files",
          );
        }
        expectedPlanId ??= reviewedPlan.id;
        expectedPlanChecksum ??= reviewedPlan.payloadChecksum;
      }
      let approved = dryRun || cmdOptions["yes"] === true;
      if (!approved) {
        assertInteractiveApplyApproval(isMachineFormat(format));
        const { executeLidarrApply } = await import("../actions/lidarr/index.js");
        const review = await executeLidarrApply({
          planPath: planFile,
          dryRun: true,
          approved: true,
          resume: cmdOptions["resume"] as boolean | undefined,
          expectedPlanId,
          expectedPlanChecksum,
          lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
          lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
          allowTagReplacement,
          allowArtistDelete,
          allowAlbumDelete,
          allowFileDelete,
          plexScan,
        });
        expectedPlanId = review.planId;
        expectedPlanChecksum = review.planChecksum;
        approved = await confirmMutationApply(planFile, review, reviewedPlan, {
          verbose: resolveVerbose(cmdOptions),
          allowTagReplacement,
          allowArtistDelete:
            reviewedPlan === undefined
              ? allowArtistDelete
              : requiresArtistDeleteAuthorization(reviewedPlan),
          allowAlbumDelete:
            reviewedPlan === undefined
              ? allowAlbumDelete
              : requiresAlbumDeleteAuthorization(reviewedPlan),
          allowFileDelete:
            reviewedPlan === undefined
              ? allowFileDelete
              : requiresFileDeleteAuthorization(reviewedPlan),
          plexScan,
        });
        if (!approved) {
          return;
        }
      }
      const { executeLidarrApply } = await import("../actions/lidarr/index.js");
      const result = await executeLidarrApply({
        planPath: planFile,
        dryRun,
        approved,
        resume: cmdOptions["resume"] as boolean | undefined,
        expectedPlanId,
        expectedPlanChecksum,
        lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
        lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
        allowTagReplacement,
        allowArtistDelete,
        allowAlbumDelete,
        allowFileDelete,
        plexScan,
      });
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(
          format,
          format === "csv" ? projectMutationApplyCsv(result) : { command: "lidarr-apply", result },
        );
      } else {
        renderMutationApply(result, {
          verbose: resolveVerbose(cmdOptions),
          allowTagReplacement,
          allowArtistDelete:
            reviewedPlan === undefined
              ? allowArtistDelete
              : requiresArtistDeleteAuthorization(reviewedPlan),
          allowAlbumDelete:
            reviewedPlan === undefined
              ? allowAlbumDelete
              : requiresAlbumDeleteAuthorization(reviewedPlan),
          allowFileDelete:
            reviewedPlan === undefined
              ? allowFileDelete
              : requiresFileDeleteAuthorization(reviewedPlan),
          plexScan,
        });
        if (isSuccessfulExecution(result.execution)) {
          renderExecutionSummary(result.execution);
        }
      }
      if (result.status === "failed" || result.status === "partial") process.exitCode = 1;
    } catch (error) {
      await reportLidarrFailure("apply", error, {
        staleHint: false,
        format,
        sensitiveValues: [cmdOptions["lidarrApiKey"]],
      });
    }
  });

// Register leaf subcommands in the documented order.
lidarrCommand.addCommand(lidarrStatusCommand);
lidarrCommand.addCommand(lidarrListCommand);
lidarrCommand.addCommand(
  createLidarrAlbumsCommand({
    resolveFormat,
    reportLidarrFailure,
    renderExecutionSummary,
    parseIdList,
    parseMaxBatch,
    parsePositiveInt,
    parseNonNegativeInt,
    assertSafePlanFileArgument,
  }),
);
lidarrCommand.addCommand(lidarrWantedCommand);
lidarrCommand.addCommand(lidarrHealthCommand);
lidarrCommand.addCommand(
  createLidarrAuditCommand({
    resolveFormat,
    reportLidarrFailure,
    renderExecutionSummary,
    parseIdList,
  }),
);
lidarrCommand.addCommand(
  createLidarrReconcileCommand({
    resolveFormat,
    reportLidarrFailure,
    renderExecutionSummary,
  }),
);
lidarrCommand.addCommand(
  createLidarrPolicyCommand({
    resolveFormat,
    reportLidarrFailure,
    renderExecutionSummary,
    parseIdList,
  }),
);
lidarrCommand.addCommand(
  createLidarrSyncRatingsCommand({ resolveFormat, reportLidarrFailure, renderExecutionSummary }),
);
lidarrCommand.addCommand(
  createLidarrImportValidationCommand({
    resolveFormat,
    parsePositiveInt,
    reportLidarrFailure,
    renderExecutionSummary,
  }),
);
lidarrCommand.addCommand(lidarrDiscoverCommand);
lidarrCommand.addCommand(lidarrSearchCommand);
lidarrCommand.addCommand(lidarrLookupCommand);
lidarrCommand.addCommand(lidarrPresetsCommand);
lidarrCommand.addCommand(lidarrPlanCommand);
lidarrCommand.addCommand(lidarrApplyCommand);
