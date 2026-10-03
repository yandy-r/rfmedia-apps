/**
 * Dependency-injected Commander subtree for Lidarr quality preset packs.
 *
 * The parent injects shared output, failure, and prompt helpers so this module
 * stays cycle-free. Action and formatter modules remain lazy.
 */

import { Command, InvalidArgumentError, Option } from "commander";
import { Table } from "console-table-printer";
import pc from "picocolors";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import { MissingRequiredArgumentError } from "../lib/errors.js";
import { truncateDisplay } from "../lib/format.js";
import type {
  LidarrPresetApplyResult,
  LidarrPresetDiffResult,
  LidarrPresetListResult,
  LidarrPresetPack,
  LidarrPresetResourceDiff,
  LidarrPresetShowResult,
} from "../types/lidarr-presets.js";

const MAX_HUMAN_RESOURCES = 20;
const MAX_HUMAN_FIELD_CHANGES = 40;
const MAX_VERBOSE_RESOURCES = 200;
const MAX_VERBOSE_FIELD_CHANGES = 500;
const MAX_VERBOSE_OUTCOMES = 200;
const PACK_REF_PATTERN = /^(?:(?:builtin|config):)?[a-z0-9][a-z0-9-]*$/u;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;

type PresetCommandName =
  | "lidarr-presets-list"
  | "lidarr-presets-show"
  | "lidarr-presets-diff"
  | "lidarr-presets-apply";

interface LidarrPresetActions {
  readonly executeLidarrPresetList: () => Promise<LidarrPresetListResult>;
  readonly executeLidarrPresetShow: (options: {
    readonly packRef: string;
  }) => Promise<LidarrPresetShowResult>;
  readonly executeLidarrPresetDiff: (options: {
    readonly packRef: string;
    readonly lidarrUrl?: string;
    readonly lidarrApiKey?: string;
  }) => Promise<LidarrPresetDiffResult>;
  readonly executeLidarrPresetApply: (options: {
    readonly packRef: string;
    readonly lidarrUrl?: string;
    readonly lidarrApiKey?: string;
    readonly dryRun?: boolean;
    readonly confirm: (review: LidarrPresetDiffResult) => Promise<boolean>;
  }) => Promise<LidarrPresetApplyResult>;
}

/** Parent-private helpers injected without importing the Lidarr parent module. */
export interface LidarrPresetsCommandDeps {
  readonly resolveFormat: () => OutputFormat;
  readonly reportLidarrFailure: (
    subcommand: string,
    error: unknown,
    options: {
      readonly staleHint: boolean;
      readonly format: OutputFormat;
      readonly sensitiveValues?: readonly unknown[];
    },
  ) => Promise<void>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly isInteractive: () => boolean;
  readonly loadActions?: () => Promise<LidarrPresetActions>;
}

/** Stable union schema used by every preset CSV command. */
export const LIDARR_PRESET_CSV_COLUMNS = [
  "schemaVersion",
  "command",
  "rowType",
  "pack.ref",
  "pack.source",
  "pack.id",
  "pack.version",
  "pack.digest",
  "pack.description",
  "pack.provenance",
  "targetOrigin",
  "hasChanges",
  "status",
  "dryRun",
  "summary.total",
  "summary.create",
  "summary.update",
  "summary.unchanged",
  "summary.retained",
  "summary.succeeded",
  "summary.satisfied",
  "summary.failed",
  "summary.uncertain",
  "summary.notAttempted",
  "resource.key",
  "resource.kind",
  "resource.name",
  "resource.action",
  "resource.liveId",
  "resource.dependencies",
  "resource.impact",
  "field.path",
  "field.before",
  "field.after",
  "detail.kind",
  "detail.value",
  "policy.kind",
  "policy.name",
  "policy.definition",
  "namingExample.kind",
  "namingExample.value",
  "outcome.status",
  "outcome.attempted",
  "outcome.dispatchState",
  "outcome.verificationState",
  "outcome.error.code",
  "outcome.error.phase",
  "outcome.error.resourcePath",
  "outcome.error.retryable",
  "outcome.error.nextAction",
] as const;

function loadDefaultActions(): Promise<LidarrPresetActions> {
  return import("../actions/lidarr/profile-presets.js");
}

/** Parses a local preset reference before any lazy action initialization. */
export function parseLidarrPresetReference(value: string): string {
  if (
    value.length === 0 ||
    value.length > 256 ||
    TERMINAL_CONTROL_PATTERN.test(value) ||
    !PACK_REF_PATTERN.test(value)
  ) {
    throw new InvalidArgumentError(
      "Preset reference must be [builtin:|config:] followed by a lowercase kebab-case ID",
    );
  }
  return value;
}

function packFields(pack: LidarrPresetPack): Record<string, unknown> {
  return {
    "pack.ref": pack.ref,
    "pack.source": pack.source,
    "pack.id": pack.id,
    "pack.version": pack.version,
    "pack.digest": pack.digest,
    "pack.description": pack.description,
    "pack.provenance": pack.provenance,
  };
}

function identityFields(pack: LidarrPresetDiffResult["pack"]): Record<string, unknown> {
  return {
    "pack.ref": pack.ref,
    "pack.source": pack.source,
    "pack.id": pack.id,
    "pack.version": pack.version,
    "pack.digest": pack.digest,
  };
}

function detailRows(
  schemaVersion: string,
  command: PresetCommandName,
  pack: LidarrPresetPack,
): readonly Record<string, unknown>[] {
  const common = { schemaVersion, command, ...packFields(pack) };
  return [
    ...pack.capabilities.map((value) => ({
      ...common,
      rowType: "capability",
      "detail.kind": "capability",
      "detail.value": value,
    })),
    ...pack.assumptions.map((value) => ({
      ...common,
      rowType: "assumption",
      "detail.kind": "assumption",
      "detail.value": value,
    })),
    ...pack.consequences.map((value) => ({
      ...common,
      rowType: "consequence",
      "detail.kind": "consequence",
      "detail.value": value,
    })),
    ...pack.customFormats.map((format) => ({
      ...common,
      rowType: "custom-format-policy",
      "policy.kind": "custom-format",
      "policy.name": format.name,
      "policy.definition": JSON.stringify(format),
    })),
    ...pack.qualityProfiles.map((profile) => ({
      ...common,
      rowType: "quality-profile-policy",
      "policy.kind": "quality-profile",
      "policy.name": profile.name,
      "policy.definition": JSON.stringify(profile),
    })),
    {
      ...common,
      rowType: "naming",
      "detail.kind": "renameTracks",
      "detail.value": pack.naming.renameTracks,
    },
    {
      ...common,
      rowType: "naming",
      "detail.kind": "replaceIllegalCharacters",
      "detail.value": pack.naming.replaceIllegalCharacters,
    },
    {
      ...common,
      rowType: "naming",
      "detail.kind": "colonReplacementFormat",
      "detail.value": pack.naming.colonReplacementFormat,
    },
    {
      ...common,
      rowType: "naming",
      "detail.kind": "standardTrackFormat",
      "detail.value": pack.naming.standardTrackFormat,
    },
    {
      ...common,
      rowType: "naming",
      "detail.kind": "multiDiscTrackFormat",
      "detail.value": pack.naming.multiDiscTrackFormat,
    },
    {
      ...common,
      rowType: "naming",
      "detail.kind": "artistFolderFormat",
      "detail.value": pack.naming.artistFolderFormat,
    },
  ];
}

function resourceRows(
  common: Readonly<Record<string, unknown>>,
  resources: readonly LidarrPresetResourceDiff[],
): readonly Record<string, unknown>[] {
  return resources.flatMap((resource) => {
    const resourceRow = {
      ...common,
      rowType: "resource",
      "resource.key": resource.key,
      "resource.kind": resource.resource,
      "resource.name": resource.name,
      "resource.action": resource.action,
      "resource.liveId": "liveId" in resource ? resource.liveId : undefined,
      "resource.dependencies": JSON.stringify(resource.dependencies),
      "resource.impact": JSON.stringify(resource.impact),
    };
    return [
      resourceRow,
      ...resource.fieldChanges.map((field) => ({
        ...common,
        rowType: "field",
        "resource.key": resource.key,
        "resource.kind": resource.resource,
        "resource.name": resource.name,
        "resource.action": resource.action,
        "field.path": field.path,
        "field.before": JSON.stringify(field.before),
        "field.after": JSON.stringify(field.after),
      })),
    ];
  });
}

function projectDiffCsv(
  command: PresetCommandName,
  result: LidarrPresetDiffResult,
): readonly Record<string, unknown>[] {
  const common = {
    schemaVersion: result.schemaVersion,
    command,
    ...identityFields(result.pack),
    targetOrigin: result.targetOrigin,
    hasChanges: result.hasChanges,
  };
  const summary = {
    ...common,
    rowType: "summary",
    "summary.total": result.summary.total,
    "summary.create": result.summary.create,
    "summary.update": result.summary.update,
    "summary.unchanged": result.summary.unchanged,
    "summary.retained": result.summary.retained,
  };
  const details = [
    ...result.assumptions.map((value) => ["assumption", value] as const),
    ...result.observations.map((value) => ["observation", value] as const),
    ...result.consequences.map((value) => ["consequence", value] as const),
    ...result.warnings.map((value) => ["warning", value] as const),
  ].map(([kind, value]) => ({
    ...common,
    rowType: kind,
    "detail.kind": kind,
    "detail.value": value,
  }));
  const namingExamples = Object.entries(result.namingExamples).map(([kind, value]) => ({
    ...common,
    rowType: "naming-example",
    "namingExample.kind": kind,
    "namingExample.value": value,
  }));
  return [summary, ...details, ...resourceRows(common, result.resources), ...namingExamples];
}

/** Projects any successful preset result into fixed-column CSV rows. */
export function projectLidarrPresetCsv(
  command: PresetCommandName,
  result:
    | LidarrPresetListResult
    | LidarrPresetShowResult
    | LidarrPresetDiffResult
    | LidarrPresetApplyResult,
): readonly Record<string, unknown>[] {
  if ("packs" in result) {
    return result.packs.flatMap((pack) => [
      {
        schemaVersion: result.schemaVersion,
        command,
        rowType: "pack",
        ...packFields(pack),
      },
      ...detailRows(result.schemaVersion, command, pack),
    ]);
  }
  if ("pack" in result && !("targetOrigin" in result)) {
    return [
      {
        schemaVersion: result.schemaVersion,
        command,
        rowType: "pack",
        ...packFields(result.pack),
      },
      ...detailRows(result.schemaVersion, command, result.pack),
    ];
  }
  if (!("review" in result)) {
    return projectDiffCsv(command, result);
  }
  const common = {
    schemaVersion: result.schemaVersion,
    command,
    ...identityFields(result.review.pack),
    targetOrigin: result.review.targetOrigin,
    hasChanges: result.review.hasChanges,
    status: result.status,
    dryRun: result.dryRun,
  };
  const reviewDetails = [
    ...result.review.assumptions.map((value) => ["assumption", value] as const),
    ...result.review.observations.map((value) => ["observation", value] as const),
    ...result.review.consequences.map((value) => ["consequence", value] as const),
    ...result.review.warnings.map((value) => ["warning", value] as const),
  ].map(([kind, value]) => ({
    ...common,
    rowType: kind,
    "detail.kind": kind,
    "detail.value": value,
  }));
  const namingExamples = Object.entries(result.review.namingExamples).map(([kind, value]) => ({
    ...common,
    rowType: "naming-example",
    "namingExample.kind": kind,
    "namingExample.value": value,
  }));
  const runError =
    result.error === undefined
      ? []
      : [
          {
            ...common,
            rowType: "error",
            "outcome.error.code": result.error.code,
            "outcome.error.phase": result.error.phase,
            "outcome.error.resourcePath": result.error.resourcePath,
            "outcome.error.retryable": result.error.retryable,
            "outcome.error.nextAction": result.error.nextAction,
          },
        ];
  return [
    {
      ...common,
      rowType: "summary",
      "summary.total": result.summary.total,
      "summary.succeeded": result.summary.succeeded,
      "summary.satisfied": result.summary.satisfied,
      "summary.failed": result.summary.failed,
      "summary.uncertain": result.summary.uncertain,
      "summary.notAttempted": result.summary.notAttempted,
    },
    ...reviewDetails,
    ...resourceRows(common, result.review.resources),
    ...namingExamples,
    ...runError,
    ...result.outcomes.map((outcome) => ({
      ...common,
      rowType: "outcome",
      "resource.key": outcome.key,
      "resource.kind": outcome.resource,
      "resource.name": outcome.name,
      "outcome.status": outcome.outcome,
      "outcome.attempted": outcome.attempted,
      "outcome.dispatchState": outcome.dispatchState,
      "outcome.verificationState": outcome.verificationState,
      ...("error" in outcome
        ? {
            "outcome.error.code": outcome.error.code,
            "outcome.error.phase": outcome.error.phase,
            "outcome.error.resourcePath": outcome.error.resourcePath,
            "outcome.error.retryable": outcome.error.retryable,
            "outcome.error.nextAction": outcome.error.nextAction,
          }
        : {}),
    })),
  ];
}

async function outputMachine(
  format: OutputFormat,
  command: PresetCommandName,
  result:
    | LidarrPresetListResult
    | LidarrPresetShowResult
    | LidarrPresetDiffResult
    | LidarrPresetApplyResult,
): Promise<void> {
  const { formatOutput } = await import("../lib/formatters/index.js");
  await formatOutput(
    format,
    format === "csv" ? projectLidarrPresetCsv(command, result) : result,
    format === "csv" ? { columns: [...LIDARR_PRESET_CSV_COLUMNS] } : undefined,
  );
}

function renderPack(pack: LidarrPresetPack): void {
  console.error("");
  console.error(pc.bold(`${pack.ref}@${pack.version}`));
  console.error(`  ${pack.description}`);
  console.error(`  Digest: ${pack.digest}`);
  console.error(`  Provenance: ${pack.provenance}`);
  console.error("");
  console.error("  Assumptions:");
  pack.assumptions.forEach((value) => console.error(`    - ${value}`));
  console.error("  Consequences and non-effects:");
  pack.consequences.forEach((value) => console.error(`    - ${value}`));
  console.error("    - Applying this pack never deletes resources or renames existing files.");
  console.error("");
  console.error("  Managed custom formats:");
  pack.customFormats.forEach((format) => console.error(`    - ${format.name}`));
  console.error("  Managed quality profiles:");
  pack.qualityProfiles.forEach((profile) => console.error(`    - ${profile.name}`));
  console.error("  Naming policy:");
  console.error(`    Standard: ${pack.naming.standardTrackFormat}`);
  console.error(`    Multi-disc: ${pack.naming.multiDiscTrackFormat}`);
  console.error(`    Artist folder: ${pack.naming.artistFolderFormat}`);
  console.error("");
}

function renderList(result: LidarrPresetListResult): void {
  console.error("");
  console.error(pc.bold("Lidarr Quality Presets"));
  console.error("");
  const table = new Table({
    columns: [
      { name: "ref", title: "Reference", alignment: "left" },
      { name: "version", title: "Version", alignment: "right" },
      { name: "description", title: "Policy", alignment: "left" },
    ],
  });
  result.packs.forEach((pack) =>
    table.addRow({
      ref: pack.ref,
      version: pack.version,
      description: truncateDisplay(pack.description, 72),
    }),
  );
  console.error(table.render());
  console.error("  Offline catalog; no Lidarr connection was used.");
  console.error("");
}

function impactText(resource: LidarrPresetResourceDiff): string {
  switch (resource.impact.kind) {
    case "custom-format":
      return `${resource.impact.referencingQualityProfiles.length} profile(s)`;
    case "quality-profile":
      return `${resource.impact.assignedArtistCount} artist(s)`;
    case "naming":
      return "future imports only";
  }
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderDiff(result: LidarrPresetDiffResult, verbose: boolean): void {
  console.error("");
  console.error(pc.bold(`Lidarr Preset Review: ${result.pack.ref}@${result.pack.version}`));
  console.error(`  Target: ${result.targetOrigin}`);
  console.error(`  Digest: ${result.pack.digest}`);
  console.error(
    `  Summary: ${result.summary.create} create, ${result.summary.update} update, ${result.summary.unchanged} unchanged, ${result.summary.retained} retained`,
  );
  console.error("");
  console.error("  Assumptions:");
  result.assumptions.forEach((value) => console.error(`    - ${value}`));
  console.error("  Observations:");
  result.observations.forEach((value) => console.error(`    - ${value}`));
  console.error("  Consequences and non-effects:");
  result.consequences.forEach((value) => console.error(`    - ${value}`));
  console.error(
    "    - No resources are deleted, artists are not reassigned, and existing files are not renamed.",
  );
  result.warnings.forEach((value) => console.error(pc.yellow(`  Warning: ${value}`)));
  console.error("");

  const resourceLimit = verbose ? MAX_VERBOSE_RESOURCES : MAX_HUMAN_RESOURCES;
  const visibleResources = result.resources.slice(0, resourceLimit);
  const table = new Table({
    columns: [
      { name: "action", title: "Action", alignment: "left" },
      { name: "kind", title: "Resource", alignment: "left" },
      { name: "name", title: "Name", alignment: "left" },
      { name: "impact", title: "Impact", alignment: "left" },
    ],
  });
  visibleResources.forEach((resource) =>
    table.addRow({
      action: resource.action.toUpperCase(),
      kind: resource.resource,
      name: truncateDisplay(resource.name, 44),
      impact: impactText(resource),
    }),
  );
  console.error(table.render());
  if (visibleResources.length < result.resources.length) {
    console.error(
      pc.dim(
        `  Showing ${visibleResources.length} of ${result.resources.length} resources${
          verbose ? " (bounded verbose limit)." : "; use --verbose for a larger bounded review."
        }`,
      ),
    );
  }

  const fieldChanges = result.resources.flatMap((resource) =>
    resource.fieldChanges.map((field) => ({ resource, field })),
  );
  const fieldChangeLimit = verbose ? MAX_VERBOSE_FIELD_CHANGES : MAX_HUMAN_FIELD_CHANGES;
  const visibleChanges = fieldChanges.slice(0, fieldChangeLimit);
  visibleChanges.forEach(({ resource, field }) =>
    console.error(
      `  ${resource.key}.${field.path}: ${JSON.stringify(field.before)} -> ${JSON.stringify(field.after)}`,
    ),
  );
  if (visibleChanges.length < fieldChanges.length) {
    console.error(
      pc.dim(`  ${fieldChanges.length - visibleChanges.length} field change(s) omitted.`),
    );
  }
  console.error("");
  const desiredNaming = result.resources.find(({ resource }) => resource === "naming")?.after;
  if (isUnknownRecord(desiredNaming)) {
    console.error("  Desired naming templates (raw):");
    for (const [label, field] of [
      ["Standard", "standardTrackFormat"],
      ["Multi-disc", "multiDiscTrackFormat"],
      ["Artist folder", "artistFolderFormat"],
    ] as const) {
      const value = desiredNaming[field];
      if (typeof value === "string") console.error(`    ${label}: ${value}`);
    }
  }
  console.error("  Naming examples (advisory, sanitized):");
  Object.entries(result.namingExamples).forEach(([kind, value]) =>
    console.error(`    ${kind}: ${value}`),
  );
  console.error("  No changes were made.");
  console.error("");
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function recoveryCommand(result: LidarrPresetApplyResult): string {
  return `rfmedia lidarr presets apply ${quotePosixShellArgument(result.review.pack.ref)} --yes --lidarr-url ${quotePosixShellArgument(result.review.targetOrigin)}`;
}

function renderApplyResult(
  result: LidarrPresetApplyResult,
  reviewRendered: boolean,
  verbose: boolean,
): void {
  if (!reviewRendered) renderDiff(result.review, verbose);
  console.error(pc.bold(`Lidarr Preset Apply: ${result.status}`));
  console.error(
    `  Outcomes: ${result.summary.succeeded} succeeded, ${result.summary.satisfied} satisfied, ${result.summary.failed} failed, ${result.summary.uncertain} uncertain, ${result.summary.notAttempted} not attempted`,
  );
  const outcomeLimit = verbose ? MAX_VERBOSE_OUTCOMES : MAX_HUMAN_RESOURCES;
  const visibleOutcomes = result.outcomes.slice(0, outcomeLimit);
  visibleOutcomes.forEach((outcome) =>
    console.error(
      `  ${outcome.key}: ${outcome.outcome} (dispatch=${outcome.dispatchState}, verification=${outcome.verificationState})${
        "error" in outcome
          ? `; ${outcome.error.code}/${outcome.error.phase}; retryable=${String(outcome.error.retryable)}; next=${outcome.error.nextAction}`
          : ""
      }`,
    ),
  );
  if (visibleOutcomes.length < result.outcomes.length) {
    console.error(
      pc.dim(
        `  Showing ${visibleOutcomes.length} of ${result.outcomes.length} outcomes${
          verbose ? " (bounded verbose limit)." : "; use --verbose for a larger bounded review."
        }`,
      ),
    );
  }
  if (result.error !== undefined) {
    console.error(
      `  Apply error: ${result.error.code}/${result.error.phase}; resource=${result.error.resourcePath}; retryable=${String(result.error.retryable)}; next=${result.error.nextAction}`,
    );
  }
  if (result.status === "declined") {
    console.error(pc.yellow("  Preset apply cancelled; no changes were made."));
  }
  if (result.status === "failed" || result.status === "partial" || result.summary.uncertain > 0) {
    console.error(pc.yellow(`  Safe next step: ${recoveryCommand(result)}`));
    console.error(
      "  Supply credentials through secure configuration or an explicit secret source.",
    );
  }
  console.error("");
}

function addConnectionOptions(command: Command): Command {
  return command
    .addOption(
      new Option("--lidarr-url <url>", "Lidarr base URL (overrides config)").helpGroup(
        "Connection:",
      ),
    )
    .addOption(
      new Option("--lidarr-api-key <key>", "Lidarr API key (overrides config)").helpGroup(
        "Connection:",
      ),
    );
}

function actionOptions(packRef: string, options: Record<string, unknown>) {
  return {
    packRef,
    lidarrUrl: options["lidarrUrl"] as string | undefined,
    lidarrApiKey: options["lidarrApiKey"] as string | undefined,
  };
}

async function reportFailure(
  deps: LidarrPresetsCommandDeps,
  subcommand: string,
  error: unknown,
  format: OutputFormat,
  options: Record<string, unknown>,
): Promise<void> {
  await deps.reportLidarrFailure(subcommand, error, {
    staleHint: false,
    format,
    sensitiveValues: [options["lidarrApiKey"]],
  });
}

/** Creates the lazy `lidarr presets list|show|diff|apply` command subtree. */
export function createLidarrPresetsCommand(deps: LidarrPresetsCommandDeps): Command {
  const loadActions = deps.loadActions ?? loadDefaultActions;
  const presets = new Command("presets").description(
    "Discover, review, and apply Lidarr quality preset packs",
  );

  presets.addCommand(
    new Command("list")
      .description("List built-in and configured preset packs offline")
      .action(async () => {
        const format = deps.resolveFormat();
        try {
          const result = await (await loadActions()).executeLidarrPresetList();
          if (isMachineFormat(format)) await outputMachine(format, "lidarr-presets-list", result);
          else renderList(result);
        } catch (error) {
          await reportFailure(deps, "presets-list", error, format, {});
        }
      }),
  );

  presets.addCommand(
    new Command("show")
      .description("Show one complete preset pack offline")
      .argument("<pack-ref>", "Preset reference", parseLidarrPresetReference)
      .action(async (packRef: string) => {
        const format = deps.resolveFormat();
        try {
          const result = await (await loadActions()).executeLidarrPresetShow({ packRef });
          if (isMachineFormat(format)) await outputMachine(format, "lidarr-presets-show", result);
          else renderPack(result.pack);
        } catch (error) {
          await reportFailure(deps, "presets-show", error, format, {});
        }
      }),
  );

  presets.addCommand(
    addConnectionOptions(
      new Command("diff")
        .description("Compare one preset with fresh Lidarr state")
        .argument("<pack-ref>", "Preset reference", parseLidarrPresetReference)
        .addOption(
          new Option("-v, --verbose", "Show every resource and field change").helpGroup("Output:"),
        ),
    ).action(async (packRef: string, options: Record<string, unknown>) => {
      const format = deps.resolveFormat();
      try {
        if (!isMachineFormat(format)) console.error(pc.dim("Reading fresh Lidarr preset state..."));
        const result = await (
          await loadActions()
        ).executeLidarrPresetDiff(actionOptions(packRef, options));
        if (isMachineFormat(format)) await outputMachine(format, "lidarr-presets-diff", result);
        else renderDiff(result, options["verbose"] === true);
      } catch (error) {
        await reportFailure(deps, "presets-diff", error, format, options);
      }
    }),
  );

  presets.addCommand(
    addConnectionOptions(
      new Command("apply")
        .description("Apply one preset after complete fresh review")
        .argument("<pack-ref>", "Preset reference", parseLidarrPresetReference)
        .addOption(
          new Option("--dry-run", "Perform full live review without mutation").helpGroup("Safety:"),
        )
        .addOption(
          new Option("--yes", "Approve mutation without an interactive prompt").helpGroup(
            "Safety:",
          ),
        )
        .addOption(
          new Option("-v, --verbose", "Show every resource and field change").helpGroup("Output:"),
        ),
    ).action(async (packRef: string, options: Record<string, unknown>) => {
      const format = deps.resolveFormat();
      const machine = isMachineFormat(format);
      const dryRun = options["dryRun"] === true;
      const yes = options["yes"] === true;
      let reviewRendered = false;
      try {
        if (!machine) console.error(pc.dim("Preparing complete Lidarr preset review..."));
        const result = await (
          await loadActions()
        ).executeLidarrPresetApply({
          ...actionOptions(packRef, options),
          dryRun,
          confirm: async (review) => {
            if (!machine) {
              renderDiff(review, options["verbose"] === true);
              reviewRendered = true;
            }
            if (yes) return true;
            if (machine || !deps.isInteractive()) {
              throw new MissingRequiredArgumentError(
                "--yes is required for non-interactive or machine-output preset apply",
              );
            }
            return deps.confirm(`Apply Lidarr preset ${review.pack.ref}@${review.pack.version}?`);
          },
        });
        if (machine) await outputMachine(format, "lidarr-presets-apply", result);
        else renderApplyResult(result, reviewRendered, options["verbose"] === true);
        if (
          result.status === "failed" ||
          result.status === "partial" ||
          result.summary.uncertain > 0
        ) {
          process.exitCode = 1;
        }
      } catch (error) {
        await reportFailure(deps, "presets-apply", error, format, options);
      }
    }),
  );

  return presets;
}
