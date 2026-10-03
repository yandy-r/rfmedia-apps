import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { generateBashCompletion } from "./bash.js";
import { generateFishCompletion } from "./fish.js";
import { generateZshCompletion } from "./zsh.js";
import { LIDARR_ALBUM_TYPE_SELECTORS } from "../lidarr/album-types.js";
import { LIDARR_AUDIT_CHECK_IDS, LIDARR_AUDIT_FAIL_ON_LEVELS } from "../../types/lidarr-audit.js";
import {
  LIDARR_POLICY_EVALUATE_OPTION_LONGS,
  POLICY_FAIL_ON_LEVELS,
  POLICY_RULE_IDS,
} from "../../types/lidarr-policy.js";
import {
  LIDARR_POLICY_PLAN_OPTION_LONGS,
  POLICY_PLAN_MODES,
} from "../../types/lidarr-policy-plan.js";
import {
  LIDARR_SYNC_RATINGS_OPTION_LONGS,
  SYNC_RATINGS_DECISIONS,
  SYNC_RATINGS_MODES,
} from "../../types/lidarr-sync-ratings.js";

const adapterConstructionSpies = vi.hoisted(() => ({
  create: vi.fn(),
  createOptional: vi.fn(),
  require: vi.fn(),
}));
const lidarrCompletionSideEffectSpies = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  resolveClient: vi.fn(),
  resolveScheduler: vi.fn(),
  readConfig: vi.fn(),
}));

vi.mock("../adapters/index.js", () => ({
  createMediaServerAdapter: adapterConstructionSpies.create,
  createOptionalMediaServerAdapter: adapterConstructionSpies.createOptional,
  requireMediaServerAdapter: adapterConstructionSpies.require,
}));
vi.mock("../lidarr/index.js", () => ({
  resolveRequiredLidarrExecutionContext: lidarrCompletionSideEffectSpies.resolveContext,
  resolveRequiredLidarrClient: lidarrCompletionSideEffectSpies.resolveClient,
  resolveLidarrScheduler: lidarrCompletionSideEffectSpies.resolveScheduler,
}));
vi.mock("../loaded-config.js", () => ({
  getLoadedLidarrConfig: lidarrCompletionSideEffectSpies.readConfig,
}));

const plexCommandTree = {
  plex: ["query", "copy", "playlist", "collection", "sync", "auth"],
  query: ["run", "list"],
  copy: ["query-results", "query"],
  playlist: ["export", "sync", "list", "create", "add"],
  collection: ["create", "add", "list", "show", "delete"],
  sync: ["push", "pull", "both"],
  auth: ["login", "status", "refresh", "logout"],
} as const;

const lidarrCommandTree = {
  lidarr: [
    "status",
    "list",
    "albums",
    "wanted",
    "health",
    "audit",
    "reconcile",
    "policy",
    "sync-ratings",
    "validate-import",
    "discover",
    "search",
    "lookup",
    "presets",
    "plan",
    "apply",
  ],
  lookup: ["artist", "album"],
  presets: ["list", "show", "diff", "apply"],
  policy: ["evaluate", "plan"],
} as const;
const lidarrPolicyDescription =
  "Evaluate Plex consumption signals and review or seal Lidarr plans (never applies)";

const lidarrPresetRefs = ["builtin:balanced", "builtin:lossless", "builtin:space-saver"] as const;

const lidarrPresetOptions = {
  list: [],
  show: [],
  diff: ["--lidarr-url", "--lidarr-api-key", "-v", "--verbose"],
  apply: ["--dry-run", "--yes", "--lidarr-url", "--lidarr-api-key", "-v", "--verbose"],
} as const;
const lidarrPresetConnectionOptions = ["lidarr-url", "lidarr-api-key"] as const;

const lidarrAlbumsOptions = [
  "--artist-ids",
  "--album-ids",
  "--all",
  "--types",
  "--monitored",
  "--unmonitored",
  "--has-files",
  "--no-files",
  "--limit",
  "--offset",
  "--lidarr-url",
  "--lidarr-api-key",
] as const;

const lidarrSearchOptions = [
  "--limit",
  "--offset",
  "--allow-stale",
  "--lidarr-url",
  "--lidarr-api-key",
] as const;

const lidarrDiscoverOptions = [
  "--artist",
  "--limit",
  "--no-autocorrect",
  "--min-similarity",
  "--max-per-seed",
  "--deep",
  "--no-cascade",
  "--diversity-boost",
  "--popularity-dampening",
  "--max-add",
  "--add",
  "--root-folder",
  "--quality-profile",
  "--metadata-profile",
  "--monitored",
  "--unmonitor-types",
  "--plan-file",
  "--lidarr-url",
  "--lidarr-api-key",
] as const;

const lidarrDiscoverValueOptions = [
  "--artist",
  "--limit",
  "--min-similarity",
  "--max-per-seed",
  "--diversity-boost",
  "--popularity-dampening",
  "--max-add",
  "--add",
  "--root-folder",
  "--quality-profile",
  "--metadata-profile",
  "--unmonitor-types",
  "--lidarr-url",
  "--lidarr-api-key",
] as const;

const lidarrDiscoverNoValueOptions = [
  "--no-autocorrect",
  "--deep",
  "--no-cascade",
  "--monitored",
] as const;

const lidarrAuditOptions = [
  "--check",
  "--deep",
  "--artist-ids",
  "--fail-on",
  "--plex-url",
  "--plex-token",
  "-v",
  "--verbose",
  "--lidarr-url",
  "--lidarr-api-key",
] as const;

const lidarrReconcileOptions = [
  ["--plex-library", true],
  ["--plex-library-id", true],
  ["--offline", false],
  ["--duplicates", false],
  ["--plex-url", true],
  ["--plex-token", true],
  ["--lidarr-url", true],
  ["--lidarr-api-key", true],
  ["-v", false],
  ["--verbose", false],
] as const;

// Long members are asserted to equal LIDARR_POLICY_EVALUATE_OPTION_LONGS, in order,
// so the completion surface and the leaf's declared Commander options stay bound
// through one artifact. Root --output/--json are never redeclared by the leaf.
const lidarrPolicyEvaluateOptions = [
  ["--plex-library", true],
  ["--rule", true],
  ["--max-proposals", true],
  ["--explain", true],
  ["--fail-on", true],
  ["-v", false],
  ["--verbose", false],
  ["--plex-url", true],
  ["--plex-token", true],
  ["--lidarr-url", true],
  ["--lidarr-api-key", true],
] as const;

const lidarrPolicyPlanOptions = [
  ["--plex-library", true],
  ["--rule", true],
  ["--max-proposals", true],
  ["--mode", true],
  ["--explain", true],
  ["-v", false],
  ["--verbose", false],
  ["--plex-url", true],
  ["--plex-token", true],
  ["--lidarr-url", true],
  ["--lidarr-api-key", true],
] as const;

// Same binding as the policy leaf above: the long members are asserted to equal
// LIDARR_SYNC_RATINGS_OPTION_LONGS in order. --mode is value-taking in every
// shell, which is why the leaf spells its safety rungs as one value option
// instead of a boolean --apply (Bash already treats --apply as file-valued).
const lidarrSyncRatingsOptions = [
  ["--plex-library", true],
  ["--decision", true],
  ["--min-stars", true],
  ["--max-plays", true],
  ["--quality-profile", true],
  ["--max-proposals", true],
  ["--mode", true],
  ["--yes", false],
  ["--explain", true],
  ["-v", false],
  ["--verbose", false],
  ["--plex-url", true],
  ["--plex-token", true],
  ["--lidarr-url", true],
  ["--lidarr-api-key", true],
] as const;

const lidarrValidateImportOptions = [
  "--artist-id",
  "--filter-existing-files",
  "--replace-existing-files",
  "--fail-on",
  "--lidarr-url",
  "--lidarr-api-key",
] as const;

const globalOptions = [
  "--debug",
  "--json",
  "--output",
  "--use-dotenvx",
  "--use-op",
  "--help",
  "--version",
] as const;

const reconcileSubcommands = ["scan", "apply"] as const;
const reconcileScanOptions = [
  "--library",
  "--tracking-database",
  "--operation-id",
  "--workers",
  "--no-progress",
] as const;
const reconcileApplyAdditions = [
  "--file-wins",
  "--db-wins",
  "--server-wins",
  "--popm-email",
  "--execute",
  "--allow-partial",
  "--yes",
] as const;
const pluginSubcommands = ["list", "ls", "info", "dir"] as const;

const lidarrPlanOptions = {
  "artist-monitoring": [
    "--ids",
    "--monitored",
    "--unmonitored",
    "--max-batch",
    "--plan-file",
    "--lidarr-url",
    "--lidarr-api-key",
    "-v",
    "--verbose",
  ],
  "album-monitoring": [
    "--types",
    "--artist-ids",
    "--album-ids",
    "--monitored",
    "--unmonitored",
    "--dry-run",
    "--max-batch",
    "--plan-file",
    "--lidarr-url",
    "--lidarr-api-key",
  ],
  "artist-profiles": [
    "--ids",
    "--all",
    "--select-monitored",
    "--select-unmonitored",
    "--select-quality-profile",
    "--select-metadata-profile",
    "--select-tag",
    "--quality-profile",
    "--metadata-profile",
    "--max-batch",
    "--plan-file",
    "--lidarr-url",
    "--lidarr-api-key",
    "-v",
    "--verbose",
  ],
  "artist-tags": [
    "--ids",
    "--all",
    "--select-monitored",
    "--select-unmonitored",
    "--select-quality-profile",
    "--select-metadata-profile",
    "--select-tag",
    "--add-tag",
    "--remove-tag",
    "--set-tag",
    "--clear-tags",
    "--max-batch",
    "--plan-file",
    "--lidarr-url",
    "--lidarr-api-key",
    "-v",
    "--verbose",
  ],
  "album-edit": [
    "--album-ids",
    "--types",
    "--artist-ids",
    "--any-release-ok",
    "--no-any-release-ok",
    "--dry-run",
    "--max-batch",
    "--plan-file",
    "--lidarr-url",
    "--lidarr-api-key",
  ],
  "album-delete": [
    "--album-ids",
    "--artist-ids",
    "--types",
    "--include-monitored",
    "--delete-files",
    "--add-import-list-exclusion",
    "--dry-run",
    "--max-batch",
    "--plan-file",
    "--lidarr-url",
    "--lidarr-api-key",
  ],
  "artist-delete": [
    "--ids",
    "--all",
    "--select-monitored",
    "--select-unmonitored",
    "--select-quality-profile",
    "--select-metadata-profile",
    "--select-tag",
    "--delete-files",
    "--dry-run",
    "--max-batch",
    "--plan-file",
    "--lidarr-url",
    "--lidarr-api-key",
    "-v",
    "--verbose",
  ],
  "track-filter": [
    "--album-id",
    "--keep-track-ids",
    "--min-stars",
    "--max-batch",
    "--out",
    "--lidarr-url",
    "--lidarr-api-key",
  ],
} as const;

const lidarrApplyOptions = [
  "--yes",
  "--allow-tag-replacement",
  "--allow-artist-delete",
  "--allow-album-delete",
  "--allow-file-delete",
  "--plex-scan",
  "--expected-plan-id",
  "--expected-plan-checksum",
  "--resume",
  "--dry-run",
  "--lidarr-url",
  "--lidarr-api-key",
  "-v",
  "--verbose",
] as const;

const lidarrArtistDeleteCondition = "__fish_rfmedia_lidarr_plan_artist_delete_active";
const lidarrArtistDeleteValueOptions = [
  "ids",
  "select-quality-profile",
  "select-metadata-profile",
  "select-tag",
  "max-batch",
  "plan-file",
  "lidarr-url",
  "lidarr-api-key",
] as const;

function extractBashCandidates(script: string, variable: string): string[] {
  const match = script.match(new RegExp(`local ${variable}="([^"]*)"`, "u"));
  expect(match, `missing Bash ${variable}`).not.toBeNull();
  return match?.[1]?.split(/\s+/u).filter(Boolean) ?? [];
}

function extractZshDescribedCandidates(script: string, variable: string): string[] {
  const match = script.match(new RegExp(`${variable}=\\(\\n([\\s\\S]*?)\\n\\s+\\)`, "u"));
  expect(match, `missing Zsh ${variable}`).not.toBeNull();
  return [...(match?.[1]?.matchAll(/^\s*'([^:']+):/gmu) ?? [])].map((candidate) => candidate[1]!);
}

function extractZshCaseOptions(script: string, command: string, requiredText?: string): string[] {
  const block = extractZshCaseBlock(script, command, requiredText);
  const options = new Set([...block.matchAll(/--[a-z][a-z-]*/gu)].map((match) => match[0]));
  for (const option of globalOptions) options.delete(option);
  if (block.includes("{-v,--verbose}")) options.add("-v");
  return [...options];
}

function extractZshOptionValues(
  script: string,
  command: string,
  option: string,
  requiredText?: string,
): string[] {
  const block = extractZshCaseBlock(script, command, requiredText);
  const match = block.match(new RegExp(`'\\*?${option}\\[[^\\]]*\\]:[a-z-]+:\\(([^)]*)\\)'`, "u"));
  expect(match, `missing Zsh ${option} values for ${command}`).not.toBeNull();
  return match?.[1]?.split(" ").filter(Boolean) ?? [];
}

function extractZshCaseBlock(script: string, command: string, requiredText?: string): string {
  const marker = `${command})`;
  const lidarrStart = Math.max(0, script.indexOf("        lidarr)"));
  let start = script.indexOf(marker, lidarrStart);

  while (start >= 0) {
    const terminator = /\n[ \t]+;;/gu;
    terminator.lastIndex = start;
    const end = terminator.exec(script)?.index ?? -1;
    expect(end, `missing Zsh ${command} case terminator`).toBeGreaterThan(start);
    const block = script.slice(start, end);
    if (requiredText === undefined || block.includes(requiredText)) return block;
    start = script.indexOf(marker, start + marker.length);
  }

  expect(
    start,
    `missing Zsh ${command} case containing ${requiredText ?? "command"}`,
  ).toBeGreaterThanOrEqual(0);
  return "";
}

function extractZshTopLevelReconcileSection(script: string): string {
  const start = script.indexOf("\n\t\treconcile)");
  const lidarrStart = script.indexOf("        lidarr)");
  expect(start, "missing top-level Zsh reconcile case").toBeGreaterThanOrEqual(0);
  expect(lidarrStart, "missing Zsh Lidarr case boundary").toBeGreaterThanOrEqual(0);
  expect(lidarrStart).toBeGreaterThan(start);
  return script.slice(start, lidarrStart);
}

function extractFishOptions(script: string, condition: string | undefined): string[] {
  if (condition === undefined) return [];
  const options = new Set<string>();
  for (const line of script.split("\n").filter((entry) => entry.includes(`-n "${condition}"`))) {
    const longOption = line.match(/ -l ([a-z][a-z-]*)/u)?.[1];
    const shortOption = line.match(/ -s ([a-z])/u)?.[1];
    if (longOption !== undefined) options.add(`--${longOption}`);
    if (shortOption !== undefined) options.add(`-${shortOption}`);
  }
  return [...options];
}

function extractFishOptionLine(script: string, condition: string, option: string): string {
  const line = script
    .split("\n")
    .find(
      (entry) =>
        entry.includes(`-n "${condition}"`) && new RegExp(` -l ${option}(?: |$)`, "u").test(entry),
    );
  expect(line, `missing Fish --${option} for ${condition}`).toBeDefined();
  return line ?? "";
}

function extractFishOptionValues(script: string, condition: string, option: string): string[] {
  const line = extractFishOptionLine(script, condition, option);
  const match = line.match(/ -xa "([^"]*)"/u);
  expect(match, `missing Fish --${option} value list for ${condition}`).not.toBeNull();
  return match?.[1]?.split(" ").filter(Boolean) ?? [];
}

function expectZshGlobalOptions(block: string): void {
  for (const option of globalOptions) {
    expect(block).toContain(`${option}[`);
  }
}

function expectFishOptionsRequireArguments(
  script: string,
  condition: string,
  options: readonly string[],
): void {
  for (const option of options) {
    const line = extractFishOptionLine(script, condition, option);
    expect(line).toMatch(/(?:^| )-r(?: |$)/u);
  }
}

function expectFishGlobalOptions(script: string): void {
  for (const option of globalOptions) {
    const pattern = new RegExp(`^complete -c rfmedia [^\\n]*-l ${option.slice(2)}(?: |$)`, "mu");
    expect(script).toMatch(pattern);
  }
}

function sorted(options: readonly string[]): string[] {
  return [...options].sort();
}

function extractZshCandidates(script: string, variable: string): string[] {
  const plexBlock = script.slice(script.indexOf("        plex)"));
  const match = plexBlock.match(new RegExp(`${variable}=\\(\\n([\\s\\S]*?)\\n\\s+\\)`, "u"));
  expect(match, `missing Zsh ${variable}`).not.toBeNull();
  return [...(match?.[1]?.matchAll(/^\s*'([^:']+):/gmu) ?? [])].map((candidate) => candidate[1]!);
}

function extractFishCandidates(script: string, command: string): string[] {
  const condition = `__fish_rfmedia_plex${command === "plex" ? "" : `_${command}`}_needs_subcommand`;
  return extractFishConditionCandidates(script, condition);
}

function extractFishConditionCandidates(script: string, condition: string): string[] {
  return script
    .split("\n")
    .filter((line) => line.includes(`-n "${condition}"`))
    .map((line) => line.match(/ -a "([^"]+)"/u)?.[1])
    .filter((candidate): candidate is string => candidate !== undefined);
}

function extractZshPresetSection(script: string): string {
  const start = script.indexOf("local -a lidarr_preset_operations");
  const end = script.indexOf("local -a lidarr_plan_operations", start);
  expect(start, "missing Zsh preset namespace").toBeGreaterThanOrEqual(0);
  expect(end, "missing Zsh preset namespace terminator").toBeGreaterThan(start);
  return script.slice(start, end);
}

function extractZshPresetRefs(block: string): string[] {
  const match = block.match(/'1:preset pack:\(([^)]*)\)'/u);
  expect(match, "missing Zsh preset pack candidates").not.toBeNull();
  return (
    match?.[1]
      ?.split(" ")
      .filter(Boolean)
      .map((candidate) => candidate.replaceAll("\\:", ":")) ?? []
  );
}

function extractFishArgumentCandidates(script: string, condition: string): string[] {
  const line = script
    .split("\n")
    .find((entry) => entry.includes(`-n "${condition}"`) && entry.includes(' -xa "'));
  expect(line, `missing Fish argument candidates for ${condition}`).toBeDefined();
  return (
    line
      ?.match(/ -xa "([^"]+)"/u)?.[1]
      ?.split(" ")
      .filter(Boolean) ?? []
  );
}

describe("shell completion templates", () => {
  it("locks the plugin command tree across Bash, Zsh, and Fish", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    const shellContracts = [
      {
        topLevelCommands: extractBashCandidates(bashScript, "commands"),
        subcommands: extractBashCandidates(bashScript, "plugin_subcommands"),
      },
      {
        topLevelCommands: extractZshDescribedCandidates(zshScript, "commands"),
        subcommands: extractZshDescribedCandidates(zshScript, "plugin_subcmds"),
      },
      {
        topLevelCommands: extractFishConditionCandidates(fishScript, "__fish_use_subcommand"),
        subcommands: extractFishConditionCandidates(
          fishScript,
          "__fish_rfmedia_plugin_needs_subcommand",
        ),
      },
    ];

    for (const contract of shellContracts) {
      expect(contract.topLevelCommands).toContain("plugin");
      expect(contract.subcommands).toEqual(pluginSubcommands);
    }

    expect(bashScript).toContain("list|ls|info|dir|show");
    expect(zshScript).toContain("list|ls|dir)");
  });

  it("locks the complete Plex command tree across Bash, Zsh, and Fish", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    for (const [command, candidates] of Object.entries(plexCommandTree)) {
      const bashVariable = command === "plex" ? "plex_subcommands" : `plex_${command}_subcommands`;
      const zshVariable = command === "plex" ? "plex_subcmds" : `${command}_subcmds`;

      expect(extractBashCandidates(bashScript, bashVariable)).toEqual(candidates);
      expect(extractZshCandidates(zshScript, zshVariable)).toEqual(candidates);
      expect(extractFishCandidates(fishScript, command)).toEqual(candidates);
    }
  });

  it("locks the top-level reconcile parent and leaf contracts across all shells", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();
    const zshReconcileBlock = extractZshTopLevelReconcileSection(zshScript);
    const expectedApplyOptions = [...reconcileScanOptions, ...reconcileApplyAdditions];
    const scanOptionSet = new Set<string>(reconcileScanOptions);
    const longOptions = (options: readonly string[]): string[] =>
      options.filter((option) => option.startsWith("--"));

    const shellContracts = [
      {
        subcommands: extractBashCandidates(bashScript, "reconcile_subcommands"),
        scanOptions: longOptions(extractBashCandidates(bashScript, "reconcile_scan_opts")),
        applyOptions: longOptions(extractBashCandidates(bashScript, "reconcile_apply_opts")),
      },
      {
        subcommands: extractZshDescribedCandidates(zshReconcileBlock, "reconcile_subcmds"),
        scanOptions: longOptions(extractZshCaseOptions(zshReconcileBlock, "scan")),
        applyOptions: longOptions(extractZshCaseOptions(zshReconcileBlock, "apply")),
      },
      {
        subcommands: extractFishConditionCandidates(
          fishScript,
          "__fish_rfmedia_reconcile_needs_subcommand",
        ),
        scanOptions: longOptions(
          extractFishOptions(fishScript, "__fish_rfmedia_reconcile_scan_active"),
        ),
        applyOptions: longOptions(
          extractFishOptions(fishScript, "__fish_rfmedia_reconcile_apply_active"),
        ),
      },
    ];

    for (const contract of shellContracts) {
      expect(contract.subcommands).toEqual(reconcileSubcommands);
      expect(contract.scanOptions).toEqual(reconcileScanOptions);
      expect(sorted(contract.applyOptions)).toEqual(sorted(expectedApplyOptions));
      expect(sorted(contract.applyOptions.filter((option) => !scanOptionSet.has(option)))).toEqual(
        sorted(reconcileApplyAdditions),
      );

      for (const applyOnlyOption of reconcileApplyAdditions) {
        expect(contract.scanOptions).not.toContain(applyOnlyOption);
      }
    }
  });

  it.each([
    {
      name: "completes the tracking database as a file",
      words: 'rfmedia reconcile scan /music --tracking-database ""',
      cword: 5,
      expected: ["FILE"],
    },
    {
      name: "offers bounded worker choices",
      words: 'rfmedia reconcile scan /music --workers ""',
      cword: 5,
      expected: ["1", "2", "4", "8"],
    },
    {
      name: "does not complete a library as a directory",
      words: 'rfmedia reconcile scan /music --library ""',
      cword: 5,
      expected: [],
    },
    {
      name: "does not complete an operation ID as a directory",
      words: 'rfmedia reconcile scan /music --operation-id ""',
      cword: 5,
      expected: [],
    },
    {
      name: "does not complete a POPM email as a directory",
      words: 'rfmedia reconcile apply /music --db-wins --popm-email ""',
      cword: 6,
      expected: [],
    },
    {
      name: "keeps routing after a library value matches another command",
      words: "rfmedia reconcile scan /music --library plex --w",
      cword: 6,
      expected: ["--workers"],
    },
    {
      name: "keeps routing after a global option value matches another command",
      words: "rfmedia reconcile scan /music --use-op plex --w",
      cword: 6,
      expected: ["--workers"],
    },
  ])("routes Bash reconcile values: $name", ({ words, cword, expected }) => {
    const bashScript = generateBashCompletion();
    const result = spawnSync("bash", ["--noprofile", "--norc"], {
      encoding: "utf8",
      input: `${bashScript}
_init_completion() {
  words=("\${COMP_WORDS[@]}")
  cword=\$COMP_CWORD
  cur="\${words[cword]}"
  prev="\${words[cword - 1]}"
}
_filedir() {
  if [[ "\$1" == "-d" ]]; then
    COMPREPLY=("DIRECTORY")
  else
    COMPREPLY=("FILE")
  fi
}
COMP_WORDS=(${words})
COMP_CWORD=${String(cword)}
_rf_media_completions
printf '%s\\n' "\${COMPREPLY[@]}"
`,
    });

    expect(result.status, result.stderr).toBe(0);
    const output = result.stdout.trim();
    expect(output === "" ? [] : output.split("\n")).toEqual(expected);
  });

  it("generates static Plex completions without adapter construction or network access", () => {
    const fetchSpy = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      expect(generateBashCompletion()).toContain('local plex_subcommands="');
      expect(generateZshCompletion()).toContain("'plex:Plex Media Server operations'");
      expect(generateFishCompletion()).toContain("__fish_rfmedia_plex_needs_subcommand");

      expect(adapterConstructionSpies.create).not.toHaveBeenCalled();
      expect(adapterConstructionSpies.createOptional).not.toHaveBeenCalled();
      expect(adapterConstructionSpies.require).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("includes mcp in bash command completions", () => {
    const script = generateBashCompletion();
    expect(script).toContain("completion mcp");
    expect(script).toContain("|completion|mcp)");
  });

  it("includes mcp in zsh command completions", () => {
    const script = generateZshCompletion();
    expect(script).toContain("'mcp:Run the rfmedia MCP server over stdio'");
    expect(script).toContain("mcp)\n          _arguments");
  });

  it("includes mcp in fish command completions", () => {
    const script = generateFishCompletion();
    expect(script).toContain(
      'complete -c rfmedia -n "__fish_use_subcommand" -a "mcp" -d "Run the rfmedia MCP server over stdio"',
    );
  });

  it("includes lidarr plan/apply in bash command completions", () => {
    const script = generateBashCompletion();
    expect(script).toContain("init lidarr link-videos");
    expect(script).toContain("|init|lidarr|link-videos|");
    expect(extractBashCandidates(script, "lidarr_subcommands")).toEqual(lidarrCommandTree.lidarr);
    // The lidarr dispatch arm routes each subcommand to its option set.
    expect(script).toContain("$lidarr_list_opts $lidarr_shared_opts $global_opts");
    expect(script).toContain("$lidarr_albums_opts $lidarr_shared_opts $global_opts");
    expect(extractBashCandidates(script, "lidarr_plan_operations")).toEqual([
      "artist-monitoring",
      "album-monitoring",
      "artist-profiles",
      "artist-tags",
      "album-edit",
      "album-delete",
      "artist-delete",
      "track-filter",
    ]);
    expect(script).toContain(
      "artist-monitoring|album-monitoring|artist-profiles|artist-tags|album-edit|album-delete|artist-delete|track-filter)",
    );
  });

  it("includes lidarr plan/apply in zsh command completions", () => {
    const script = generateZshCompletion();
    expect(script).toContain("'lidarr:Lidarr music-management operations'");
    expect(script).toContain("lidarr)\n          local -a lidarr_subcmds");
    expect(script).toContain("'status:Show Lidarr library overview'");
    expect(script).toContain("'list:List artists with tag/profile/monitor filters'");
    expect(script).toContain("'wanted:View wanted/missing albums'");
    expect(script).toContain("'health:Show Lidarr system health checks'");
    expect(script).toContain("'search:Search Lidarr for artists and albums'");
    expect(script).toContain("'lookup:Look up Lidarr artists or albums'");
    expect(script).toContain("'plan:Create a sealed Lidarr mutation plan'");
    expect(script).toContain("'apply:Apply a reviewed Lidarr mutation plan'");
    expect(extractZshDescribedCandidates(script, "lidarr_subcmds")).toEqual(
      lidarrCommandTree.lidarr,
    );
    expect(extractZshDescribedCandidates(script, "lidarr_plan_operations")).toEqual([
      "artist-monitoring",
      "album-monitoring",
      "artist-profiles",
      "artist-tags",
      "album-edit",
      "album-delete",
      "artist-delete",
      "track-filter",
    ]);
    expect(script).toContain(
      "'artist-delete:Plan irreversible artist deletion with exact file-impact evidence'",
    );
  });

  it("includes lidarr plan/apply in fish command completions", () => {
    const script = generateFishCompletion();
    expect(script).toContain(
      'complete -c rfmedia -n "__fish_use_subcommand" -a "lidarr" -d "Lidarr music-management operations"',
    );
    const subcommands = script
      .split("\n")
      .filter((line) => line.includes('-n "__fish_rfmedia_lidarr_needs_subcommand"'))
      .map((line) => line.match(/ -a "([^"]+)"/u)?.[1])
      .filter((candidate): candidate is string => candidate !== undefined);
    expect(subcommands).toEqual(lidarrCommandTree.lidarr);
    const operations = script
      .split("\n")
      .filter((line) => line.includes('-n "__fish_rfmedia_lidarr_plan_needs_operation"'))
      .map((line) => line.match(/ -a "([^"]+)"/u)?.[1])
      .filter((candidate): candidate is string => candidate !== undefined);
    expect(operations).toEqual([
      "artist-monitoring",
      "album-monitoring",
      "artist-profiles",
      "artist-tags",
      "album-edit",
      "album-delete",
      "artist-delete",
      "track-filter",
    ]);
    expect(script).toContain('and test "$cmd[4]" = "artist-delete"');
    expect(script).toContain(
      'complete -c rfmedia -n "__fish_rfmedia_lidarr_plan_needs_operation" -a "artist-delete" -d "Plan irreversible artist deletion with exact file-impact evidence"',
    );
  });

  it("locks the Lidarr preset hierarchy and exact leaf options across all shells", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();
    const zshPresetSection = extractZshPresetSection(zshScript);

    expect(extractBashCandidates(bashScript, "lidarr_preset_operations")).toEqual(
      lidarrCommandTree.presets,
    );
    expect(extractZshDescribedCandidates(zshScript, "lidarr_preset_operations")).toEqual(
      lidarrCommandTree.presets,
    );
    expect(
      extractFishConditionCandidates(fishScript, "__fish_rfmedia_lidarr_presets_needs_operation"),
    ).toEqual(lidarrCommandTree.presets);

    const bashOptions = {
      list: [],
      show: [],
      diff: extractBashCandidates(bashScript, "lidarr_preset_diff_opts"),
      apply: extractBashCandidates(bashScript, "lidarr_preset_apply_opts"),
    };
    const fishConditions = {
      diff: "__fish_rfmedia_lidarr_presets_diff_active",
      apply: "__fish_rfmedia_lidarr_presets_apply_active",
    } as const;

    for (const [leaf, expectedOptions] of Object.entries(lidarrPresetOptions)) {
      const bashLeafOptions = bashOptions[leaf as keyof typeof bashOptions];
      const zshLeafOptions = extractZshCaseOptions(zshPresetSection, leaf);
      const fishCondition = fishConditions[leaf as keyof typeof fishConditions];
      const fishLeafOptions = extractFishOptions(fishScript, fishCondition);
      expect(sorted(bashLeafOptions)).toEqual(sorted(expectedOptions));
      expect(sorted(zshLeafOptions)).toEqual(sorted(expectedOptions));
      expect(sorted(fishLeafOptions)).toEqual(sorted(expectedOptions));
    }

    expect(fishScript).not.toContain("__fish_rfmedia_lidarr_presets_list_active");
    expect(fishScript).not.toContain("__fish_rfmedia_lidarr_presets_show_active");
    expect(bashScript).toContain(
      'elif [[ "$subsubcmd" == "list" ]]; then\n\t\t\t\tif [[ "$cur" == -* ]]; then\n\t\t\t\t\tCOMPREPLY=($(compgen -W "$global_opts" -- "$cur"))',
    );
    expect(bashScript).toContain(
      'elif [[ "$subsubcmd" == "show" ]]; then\n\t\t\t\tif [[ "$cur" == -* ]]; then\n\t\t\t\t\tCOMPREPLY=($(compgen -W "$global_opts" -- "$cur"))',
    );
  });

  it("completes only built-in preset references and marks every preset value option", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();
    const zshPresetSection = extractZshPresetSection(zshScript);

    expect(extractBashCandidates(bashScript, "lidarr_preset_refs")).toEqual(lidarrPresetRefs);
    expect(bashScript.match(/\$lidarr_preset_refs/gu)).toHaveLength(3);

    for (const leaf of ["show", "diff", "apply"]) {
      const block = extractZshCaseBlock(zshPresetSection, leaf);
      expect(extractZshPresetRefs(block)).toEqual(lidarrPresetRefs);
    }

    expect(
      extractFishArgumentCandidates(fishScript, "__fish_rfmedia_lidarr_presets_needs_pack_ref"),
    ).toEqual(lidarrPresetRefs);
    const fishPackPredicate = fishScript.slice(
      fishScript.indexOf("function __fish_rfmedia_lidarr_presets_needs_pack_ref"),
      fishScript.indexOf("function __fish_rfmedia_lidarr_plan_needs_operation"),
    );
    expect(fishPackPredicate).toContain('contains -- "$cmd[4]" show diff apply');
    expect(fishPackPredicate).not.toContain(" list");

    expect(bashScript).toContain("--lidarr-url|--lidarr-api-key|--offset|--ids");
    for (const leaf of ["diff", "apply"]) {
      const block = extractZshCaseBlock(zshPresetSection, leaf);
      expect(block).toContain("'--lidarr-url[Lidarr server URL]:url:'");
      expect(block).toContain("'--lidarr-api-key[Lidarr API key]:key:'");
      const fishCondition = `__fish_rfmedia_lidarr_presets_${leaf}_active`;
      expectFishOptionsRequireArguments(fishScript, fishCondition, lidarrPresetConnectionOptions);
    }
  });

  it("generates static Lidarr preset completions without config, client, or network access", () => {
    const fetchSpy = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const scripts = [generateBashCompletion(), generateZshCompletion(), generateFishCompletion()];
      const generated = scripts.join("\n");
      expect(generated).toContain("lidarr_preset_operations");
      expect(generated).toContain("__fish_rfmedia_lidarr_presets_needs_operation");
      expect(generated).not.toContain("rfmedia lidarr presets");
      expect(lidarrCompletionSideEffectSpies.resolveContext).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveClient).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveScheduler).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.readConfig).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("locks Lidarr search and lookup hierarchy and exact leaf options across all shells", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    expect(extractBashCandidates(bashScript, "lidarr_lookup_operations")).toEqual(
      lidarrCommandTree.lookup,
    );
    expect(extractZshDescribedCandidates(zshScript, "lidarr_lookup_operations")).toEqual(
      lidarrCommandTree.lookup,
    );
    expect(
      extractFishConditionCandidates(fishScript, "__fish_rfmedia_lidarr_lookup_needs_operation"),
    ).toEqual(lidarrCommandTree.lookup);

    const bashOptions = [
      ...extractBashCandidates(bashScript, "lidarr_search_opts"),
      ...extractBashCandidates(bashScript, "lidarr_shared_opts"),
    ];
    expect(sorted(bashOptions)).toEqual(sorted(lidarrSearchOptions));
    expect(sorted(extractZshCaseOptions(zshScript, "search"))).toEqual(sorted(lidarrSearchOptions));
    expect(sorted(extractZshCaseOptions(zshScript, "artist|album"))).toEqual(
      sorted(lidarrSearchOptions),
    );

    for (const condition of [
      "__fish_rfmedia_lidarr_search_active",
      "__fish_rfmedia_lidarr_lookup_artist_active",
      "__fish_rfmedia_lidarr_lookup_album_active",
    ]) {
      const fishOptions = sorted(extractFishOptions(fishScript, condition));
      expect(fishOptions).toEqual(sorted(lidarrSearchOptions));
    }
  });

  it("marks search values and terms shell-appropriately while preserving global options", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    expect(bashScript).toContain(
      '--limit)\n      COMPREPLY=($(compgen -W "10 20 50 100 200" -- "$cur"))',
    );
    expect(bashScript).toContain("--lidarr-url|--lidarr-api-key|--offset|--ids");
    expect(
      bashScript.match(/\$lidarr_search_opts \$lidarr_shared_opts \$global_opts/gu),
    ).toHaveLength(2);

    for (const command of ["search", "artist|album"]) {
      const block = extractZshCaseBlock(zshScript, command);
      expect(block).toContain("--limit[Maximum results to return]:limit:(10 20 50 100 200)");
      expect(block).toContain("--offset[Number of ranked results to skip]:offset:");
      expect(block).toContain("--lidarr-url[Lidarr server URL]:url:");
      expect(block).toContain("--lidarr-api-key[Lidarr API key]:key:");
      expect(block).toContain("'1:search term:'");
      expectZshGlobalOptions(block);
    }

    expect(fishScript).toContain("complete -c rfmedia -f");
    for (const condition of [
      "__fish_rfmedia_lidarr_search_active",
      "__fish_rfmedia_lidarr_lookup_artist_active",
      "__fish_rfmedia_lidarr_lookup_album_active",
    ]) {
      const argumentOptions = ["limit", "offset", "lidarr-url", "lidarr-api-key"];
      expectFishOptionsRequireArguments(fishScript, condition, argumentOptions);
      const limitLine = extractFishOptionLine(fishScript, condition, "limit");
      expect(limitLine).toContain('-xa "10 20 50 100 200"');
    }
    expectFishGlobalOptions(fishScript);
  });

  it("generates static Lidarr search completions without client, config, or network access", () => {
    const fetchSpy = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const scripts = [generateBashCompletion(), generateZshCompletion(), generateFishCompletion()];
      const generated = scripts.join("\n");
      expect(generated).not.toContain("rfmedia lidarr search");
      expect(generated).not.toContain("rfmedia lidarr lookup");
      expect(lidarrCompletionSideEffectSpies.resolveContext).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveClient).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveScheduler).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.readConfig).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("locks the static Lidarr discover hierarchy, ordered options, and value handling across all shells", () => {
    const fetchSpy = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const bashScript = generateBashCompletion();
      const zshScript = generateZshCompletion();
      const fishScript = generateFishCompletion();
      const zshDiscoverBlock = extractZshCaseBlock(zshScript, "discover");
      const fishCondition = "__fish_rfmedia_lidarr_discover_active";
      const bashValueSection = bashScript.slice(
        bashScript.indexOf('case "$prev" in'),
        bashScript.indexOf("# Complete command or options based on position"),
      );

      expect(extractBashCandidates(bashScript, "lidarr_subcommands")).toEqual(
        lidarrCommandTree.lidarr,
      );
      expect(extractZshDescribedCandidates(zshScript, "lidarr_subcmds")).toEqual(
        lidarrCommandTree.lidarr,
      );
      expect(
        extractFishConditionCandidates(fishScript, "__fish_rfmedia_lidarr_needs_subcommand"),
      ).toEqual(lidarrCommandTree.lidarr);

      expect(extractBashCandidates(bashScript, "lidarr_discover_opts")).toEqual(
        lidarrDiscoverOptions,
      );
      expect(extractZshCaseOptions(zshScript, "discover")).toEqual(lidarrDiscoverOptions);
      expect(extractFishOptions(fishScript, fishCondition)).toEqual(lidarrDiscoverOptions);

      for (const option of lidarrDiscoverValueOptions) {
        expect(bashValueSection).toMatch(new RegExp(`(?:^[ \\t]*|\\|)${option}(?:\\||\\))`, "mu"));
        expect(zshDiscoverBlock).toMatch(new RegExp(`'${option}\\[[^\\]]*\\]:`, "u"));
        expect(extractFishOptionLine(fishScript, fishCondition, option.slice(2))).toMatch(
          /(?:^| )-r(?: |$)/u,
        );
      }

      for (const option of lidarrDiscoverNoValueOptions) {
        expect(bashValueSection).not.toMatch(
          new RegExp(`(?:^[ \\t]*|\\|)${option}(?:\\||\\))`, "mu"),
        );
        expect(zshDiscoverBlock).not.toMatch(new RegExp(`'${option}\\[[^\\]]*\\]:`, "u"));
        expect(extractFishOptionLine(fishScript, fishCondition, option.slice(2))).not.toMatch(
          /(?:^| )-(?:r|F)(?: |$)/u,
        );
      }

      expect(extractBashCandidates(bashScript, "lidarr_album_types")).toEqual(
        LIDARR_ALBUM_TYPE_SELECTORS,
      );
      expect(bashValueSection).toContain(
        '--types|--unmonitor-types)\n      COMPREPLY=($(compgen -W "$lidarr_album_types" -- "$cur"))',
      );
      expect(extractZshOptionValues(zshScript, "discover", "--unmonitor-types")).toEqual(
        LIDARR_ALBUM_TYPE_SELECTORS,
      );
      expect(extractFishOptionLine(fishScript, fishCondition, "unmonitor-types")).toContain(
        `-r -xa "${LIDARR_ALBUM_TYPE_SELECTORS.join(" ")}"`,
      );

      expect(zshDiscoverBlock).toContain(
        "'--metadata-profile[Optional existing Lidarr metadata profile override for the add plan]:reference:'",
      );
      expect(extractFishOptionLine(fishScript, fishCondition, "metadata-profile")).toContain(
        '-d "Optional existing Lidarr metadata profile override for the add plan" -r',
      );
      expect(zshDiscoverBlock).toContain("'--monitored[Add artists as monitored]'");
      expect(extractFishOptionLine(fishScript, fishCondition, "monitored")).toContain(
        '-d "Add artists as monitored"',
      );

      expect(bashValueSection).toMatch(/--plan-file(?:\||\))[\s\S]*?_filedir/u);
      expect(zshDiscoverBlock).toContain(
        "'--plan-file[Write the sealed add plan to this path]:file:_files'",
      );
      const fishPlanFileLine = extractFishOptionLine(fishScript, fishCondition, "plan-file");
      expect(fishPlanFileLine).toMatch(/(?:^| )-r(?: |$)/u);
      expect(fishPlanFileLine).toMatch(/(?:^| )-F(?: |$)/u);

      for (const forbidden of [
        "--yes",
        "--dry-run",
        "--allow-stale",
        "--source",
        "--provider",
        "--lastfm-api-key",
      ]) {
        expect(extractBashCandidates(bashScript, "lidarr_discover_opts")).not.toContain(forbidden);
        expect(extractZshCaseOptions(zshScript, "discover")).not.toContain(forbidden);
        expect(extractFishOptions(fishScript, fishCondition)).not.toContain(forbidden);
      }

      expect([bashScript, zshScript, fishScript].join("\n")).not.toContain(
        "rfmedia lidarr discover",
      );
      expect(lidarrCompletionSideEffectSpies.resolveContext).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveClient).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveScheduler).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.readConfig).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("locks exact Lidarr albums leaf options across all shells", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    // Bash scopes connection flags via $lidarr_shared_opts, like the sibling leaves.
    const bashOptions = [
      ...extractBashCandidates(bashScript, "lidarr_albums_opts"),
      ...extractBashCandidates(bashScript, "lidarr_shared_opts"),
    ];
    expect(sorted(bashOptions)).toEqual(sorted(lidarrAlbumsOptions));
    expect(bashScript).toContain("$lidarr_albums_opts $lidarr_shared_opts $global_opts");
    expect(sorted(extractZshCaseOptions(zshScript, "albums"))).toEqual(sorted(lidarrAlbumsOptions));
    expect(sorted(extractFishOptions(fishScript, "__fish_rfmedia_lidarr_albums_active"))).toEqual(
      sorted(lidarrAlbumsOptions),
    );

    // The read leaf deliberately excludes --allow-stale (no album cache) and -v.
    for (const options of [
      extractBashCandidates(bashScript, "lidarr_albums_opts"),
      extractZshCaseOptions(zshScript, "albums"),
      extractFishOptions(fishScript, "__fish_rfmedia_lidarr_albums_active"),
    ]) {
      expect(options).not.toContain("--allow-stale");
      expect(options).not.toContain("-v");
    }
  });

  it("locks exact Lidarr audit leaf options across all shells", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    // Bash scopes connection flags via $lidarr_shared_opts, like the sibling leaves.
    const bashOptions = [
      ...extractBashCandidates(bashScript, "lidarr_audit_opts"),
      ...extractBashCandidates(bashScript, "lidarr_shared_opts"),
    ];
    expect(sorted(bashOptions)).toEqual(sorted(lidarrAuditOptions));
    expect(bashScript).toContain("$lidarr_audit_opts $lidarr_shared_opts $global_opts");
    expect(sorted(extractZshCaseOptions(zshScript, "audit"))).toEqual(sorted(lidarrAuditOptions));
    expect(sorted(extractFishOptions(fishScript, "__fish_rfmedia_lidarr_audit_active"))).toEqual(
      sorted(lidarrAuditOptions),
    );

    // The audit leaf deliberately excludes --allow-stale (a cached audit is
    // misleading) while keeping -v for full finding-subject output.
    for (const options of [
      extractBashCandidates(bashScript, "lidarr_audit_opts"),
      extractZshCaseOptions(zshScript, "audit"),
      extractFishOptions(fishScript, "__fish_rfmedia_lidarr_audit_active"),
    ]) {
      expect(options).not.toContain("--allow-stale");
      expect(options).toContain("-v");
    }
  });

  it("locks the static Lidarr reconcile command, options, and value handling across all shells", () => {
    const fetchSpy = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const bashScript = generateBashCompletion();
      const zshScript = generateZshCompletion();
      const fishScript = generateFishCompletion();
      const bashValueSection = bashScript.slice(
        bashScript.indexOf('case "$prev" in'),
        bashScript.indexOf("# Complete command or options based on position"),
      );
      const zshReconcileBlock = extractZshCaseBlock(zshScript, "reconcile");
      const fishCondition = "__fish_rfmedia_lidarr_reconcile_active";
      const expectedOptions = lidarrReconcileOptions.map(([option]) => option);
      const expectedValueOptions = lidarrReconcileOptions
        .filter(([, takesValue]) => takesValue)
        .map(([option]) => option);
      const shellContracts = [
        {
          commands: extractBashCandidates(bashScript, "lidarr_subcommands"),
          options: extractBashCandidates(bashScript, "lidarr_reconcile_opts"),
          valueOptions: expectedOptions.filter((option) =>
            new RegExp(`(?:^[ \\t]*|\\|)${option}(?:\\||\\))`, "mu").test(bashValueSection),
          ),
        },
        {
          commands: extractZshDescribedCandidates(zshScript, "lidarr_subcmds"),
          options: extractZshCaseOptions(zshScript, "reconcile"),
          valueOptions: expectedOptions.filter((option) =>
            new RegExp(`'${option}\\[[^\\]]*\\]:`, "u").test(zshReconcileBlock),
          ),
        },
        {
          commands: extractFishConditionCandidates(
            fishScript,
            "__fish_rfmedia_lidarr_needs_subcommand",
          ),
          options: extractFishOptions(fishScript, fishCondition),
          valueOptions: expectedOptions.filter((option) => {
            const longOption = option.startsWith("--") ? option.slice(2) : "verbose";
            return /(?:^| )-r(?: |$)/u.test(
              extractFishOptionLine(fishScript, fishCondition, longOption),
            );
          }),
        },
      ];

      for (const contract of shellContracts) {
        expect(contract.commands).toEqual(lidarrCommandTree.lidarr);
        expect(sorted(contract.options)).toEqual(sorted(expectedOptions));
        expect(sorted(contract.valueOptions)).toEqual(sorted(expectedValueOptions));
      }

      expect([bashScript, zshScript, fishScript].join("\n")).not.toContain(
        "rfmedia lidarr reconcile",
      );
      expect(adapterConstructionSpies.create).not.toHaveBeenCalled();
      expect(adapterConstructionSpies.createOptional).not.toHaveBeenCalled();
      expect(adapterConstructionSpies.require).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveContext).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveClient).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveScheduler).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.readConfig).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes Lidarr reconcile to its Bash option branch", () => {
    const bashScript = generateBashCompletion();
    const result = spawnSync("bash", ["--noprofile", "--norc"], {
      encoding: "utf8",
      input: `${bashScript}
_init_completion() {
  words=("\${COMP_WORDS[@]}")
  cword=\$COMP_CWORD
  cur="\${words[cword]}"
  prev="\${words[cword - 1]}"
}
COMP_WORDS=(rfmedia lidarr reconcile --p)
COMP_CWORD=3
_rf_media_completions
printf '%s\\n' "\${COMPREPLY[@]}"
`,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "--plex-library",
      "--plex-library-id",
      "--plex-url",
      "--plex-token",
    ]);
  });

  it("routes Fish reconcile options when root global options precede the command path", () => {
    const fishScript = generateFishCompletion();
    const start = fishScript.indexOf("function __fish_rfmedia_lidarr_reconcile_active");
    const end = fishScript.indexOf("function __fish_rfmedia_lidarr_validate_import_active", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const predicate = fishScript.slice(start, end);

    expect(predicate).toContain("for token in $cmd[2..-1]");
    expect(predicate).toContain("case --output --use-dotenvx --use-op");
    expect(predicate).toContain("set skip_next 1");
    expect(predicate).toContain("case '--output=*' '--use-dotenvx=*' '--use-op=*'");
    expect(predicate).toMatch(/case [^\n]*--debug --json --help --version/u);
    expect(predicate).toContain('test "$command_path[1]" = "lidarr"');
    expect(predicate).toContain('test "$command_path[2]" = "reconcile"');
    expect(predicate).not.toContain('test "$cmd[2]" = "lidarr"');
  });

  it("locks the static Lidarr policy command, options, and value handling across all shells", () => {
    const fetchSpy = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const bashScript = generateBashCompletion();
      const zshScript = generateZshCompletion();
      const fishScript = generateFishCompletion();
      const bashValueSection = bashScript.slice(
        bashScript.indexOf('case "$prev" in'),
        bashScript.indexOf("# Complete command or options based on position"),
      );
      const zshPolicyBlock = extractZshCaseBlock(zshScript, "policy");
      const commandTrees = [
        {
          commands: extractBashCandidates(bashScript, "lidarr_subcommands"),
          operations: extractBashCandidates(bashScript, "lidarr_policy_operations"),
        },
        {
          commands: extractZshDescribedCandidates(zshScript, "lidarr_subcmds"),
          operations: [
            ...(zshPolicyBlock.match(/'1:operation:\(([^)]*)\)'/u)?.[1]?.split(" ") ?? []),
          ],
        },
        {
          commands: extractFishConditionCandidates(
            fishScript,
            "__fish_rfmedia_lidarr_needs_subcommand",
          ),
          operations: extractFishConditionCandidates(
            fishScript,
            "__fish_rfmedia_lidarr_policy_needs_operation",
          ),
        },
      ];

      for (const contract of commandTrees) {
        expect(contract.commands).toEqual(lidarrCommandTree.lidarr);
        expect(contract.operations).toEqual(lidarrCommandTree.policy);
      }
      expect(zshScript).toContain(`'policy:${lidarrPolicyDescription}'`);
      expect(fishScript).toContain(`-a "policy" -d "${lidarrPolicyDescription}"`);

      const policyLeaves = [
        {
          operation: "evaluate",
          options: lidarrPolicyEvaluateOptions,
          longOptions: LIDARR_POLICY_EVALUATE_OPTION_LONGS,
          bashVariable: "lidarr_policy_evaluate_opts",
          zshCommand: "policy",
          zshRequiredText: undefined,
          fishCondition: "__fish_rfmedia_lidarr_policy_evaluate_active",
        },
        {
          operation: "plan",
          options: lidarrPolicyPlanOptions,
          longOptions: LIDARR_POLICY_PLAN_OPTION_LONGS,
          bashVariable: "lidarr_policy_plan_opts",
          zshCommand: "plan",
          zshRequiredText: "--mode[Safety rung for this run]",
          fishCondition: "__fish_rfmedia_lidarr_policy_plan_active",
        },
      ] as const;

      for (const leaf of policyLeaves) {
        const expectedOptions = leaf.options.map(([option]) => option);
        const expectedValueOptions = leaf.options
          .filter(([, takesValue]) => takesValue)
          .map(([option]) => option);
        const zshLeafBlock = extractZshCaseBlock(zshScript, leaf.zshCommand, leaf.zshRequiredText);
        const shellContracts = [
          {
            options: extractBashCandidates(bashScript, leaf.bashVariable),
            valueOptions: expectedOptions.filter((option) =>
              new RegExp(`(?:^[ \\t]*|\\|)${option}(?:\\||\\))`, "mu").test(bashValueSection),
            ),
          },
          {
            options: extractZshCaseOptions(zshScript, leaf.zshCommand, leaf.zshRequiredText),
            valueOptions: expectedOptions.filter((option) =>
              new RegExp(`'\\*?${option}\\[[^\\]]*\\]:`, "u").test(zshLeafBlock),
            ),
          },
          {
            options: extractFishOptions(fishScript, leaf.fishCondition),
            valueOptions: expectedOptions.filter((option) => {
              const longOption = option.startsWith("--") ? option.slice(2) : "verbose";
              return /(?:^| )-r(?: |$)/u.test(
                extractFishOptionLine(fishScript, leaf.fishCondition, longOption),
              );
            }),
          },
        ];

        // Each static shell surface stays bound to the leaf's Commander option order.
        expect(expectedOptions.filter((option) => option.startsWith("--"))).toEqual([
          ...leaf.longOptions,
        ]);
        expect(expectedOptions).not.toContain("--output");
        expect(expectedOptions).not.toContain("--json");
        for (const contract of shellContracts) {
          expect(sorted(contract.options), `${leaf.operation} options`).toEqual(
            sorted(expectedOptions),
          );
          expect(sorted(contract.valueOptions), `${leaf.operation} value options`).toEqual(
            sorted(expectedValueOptions),
          );
        }
        expectZshGlobalOptions(zshLeafBlock);
      }

      expect([bashScript, zshScript, fishScript].join("\n")).not.toContain("rfmedia lidarr policy");
      expect(adapterConstructionSpies.create).not.toHaveBeenCalled();
      expect(adapterConstructionSpies.createOptional).not.toHaveBeenCalled();
      expect(adapterConstructionSpies.require).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveContext).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveClient).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveScheduler).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.readConfig).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("binds Lidarr policy completion value lists to the rule and mode registries", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();
    const ruleIds = [...POLICY_RULE_IDS];
    const failLevels = [...POLICY_FAIL_ON_LEVELS];
    const planModes = [...POLICY_PLAN_MODES];

    const shellValueContracts = [
      {
        ruleValues: [extractBashCandidates(bashScript, "lidarr_policy_rules")],
        modeValues: extractBashCandidates(bashScript, "lidarr_policy_plan_modes"),
      },
      {
        ruleValues: [
          extractZshOptionValues(zshScript, "policy", "--rule"),
          extractZshOptionValues(zshScript, "plan", "--rule", "--mode[Safety rung for this run]"),
        ],
        modeValues: extractZshOptionValues(
          zshScript,
          "plan",
          "--mode",
          "--mode[Safety rung for this run]",
        ),
      },
      {
        ruleValues: [
          extractFishOptionValues(
            fishScript,
            "__fish_rfmedia_lidarr_policy_evaluate_active",
            "rule",
          ),
          extractFishOptionValues(fishScript, "__fish_rfmedia_lidarr_policy_plan_active", "rule"),
        ],
        modeValues: extractFishOptionValues(
          fishScript,
          "__fish_rfmedia_lidarr_policy_plan_active",
          "mode",
        ),
      },
    ];

    for (const contract of shellValueContracts) {
      for (const values of contract.ruleValues) {
        expect(values).toEqual(ruleIds);
      }
      expect(contract.modeValues).toEqual(planModes);
    }

    expect(extractBashCandidates(bashScript, "lidarr_policy_fail_levels")).toEqual(failLevels);
    expect(bashScript).toContain('COMPREPLY=($(compgen -W "$lidarr_policy_rules" -- "$cur"))');
    expect(bashScript).toContain(
      'COMPREPLY=($(compgen -W "$lidarr_policy_fail_levels" -- "$cur"))',
    );

    expect(extractZshOptionValues(zshScript, "policy", "--fail-on")).toEqual(failLevels);
    // --rule accumulates in the command layer, so Zsh advertises it repeatable.
    expect(extractZshCaseBlock(zshScript, "policy")).toContain("'*--rule[");
    expect(extractZshCaseBlock(zshScript, "plan", "--mode[Safety rung for this run]")).toContain(
      "'*--rule[",
    );

    expect(
      extractFishOptionLine(fishScript, "__fish_rfmedia_lidarr_policy_evaluate_active", "fail-on"),
    ).toContain(`-xa "${failLevels.join(" ")}"`);
    // "degraded" is not a --fail-on level; no shell may advertise it.
    expect([bashScript, zshScript, fishScript].join("\n")).not.toContain("degraded");
  });

  it("routes Lidarr policy leaves to their Bash option branches", () => {
    const bashScript = generateBashCompletion();
    const harness = `${bashScript}
_init_completion() {
  words=("\${COMP_WORDS[@]}")
  cword=\$COMP_CWORD
  cur="\${words[cword]}"
  prev="\${words[cword - 1]}"
}
`;
    const run = (words: readonly string[]): string[] => {
      const result = spawnSync("bash", ["--noprofile", "--norc"], {
        encoding: "utf8",
        input: `${harness}
COMP_WORDS=(${words.join(" ")})
COMP_CWORD=${words.length - 1}
_rf_media_completions
printf '%s\\n' "\${COMPREPLY[@]}"
`,
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim().split("\n").filter(Boolean);
    };

    // Without the `policy` subsubcmd loop $subsubcmd is never set and the
    // evaluate arm below is unreachable, so this is the assertion that pins it.
    expect(run(["rfmedia", "lidarr", "policy", '""'])).toEqual(["evaluate", "plan"]);
    expect(run(["rfmedia", "lidarr", "policy", "evaluate", "--p"])).toEqual([
      "--plex-library",
      "--plex-url",
      "--plex-token",
    ]);
    expect(run(["rfmedia", "lidarr", "policy", "evaluate", "--fail-on", '""'])).toEqual([
      "none",
      "proposals",
    ]);
    // The root option value deliberately equals the nested leaf. Skipping that
    // value keeps routing on the real `policy plan` path and its mode registry.
    expect(
      run(["rfmedia", "--output", "plan", "lidarr", "policy", "plan", "--mode", '""']),
    ).toEqual([...POLICY_PLAN_MODES]);
    expect(run(["rfmedia", "lidarr", "policy", "plan", "--rule", '""'])).toEqual([
      ...POLICY_RULE_IDS,
    ]);
  });

  it("locks the static Lidarr sync-ratings command, options, and value handling across all shells", () => {
    const fetchSpy = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const bashScript = generateBashCompletion();
      const zshScript = generateZshCompletion();
      const fishScript = generateFishCompletion();
      const bashValueSection = bashScript.slice(
        bashScript.indexOf('case "$prev" in'),
        bashScript.indexOf("# Complete command or options based on position"),
      );
      const zshSyncRatingsBlock = extractZshCaseBlock(zshScript, "sync-ratings");
      const fishCondition = "__fish_rfmedia_lidarr_sync_ratings_active";
      const expectedOptions = lidarrSyncRatingsOptions.map(([option]) => option);
      const expectedValueOptions = lidarrSyncRatingsOptions
        .filter(([, takesValue]) => takesValue)
        .map(([option]) => option);

      // The completion surface is the contract the leaf's Commander options must match.
      expect(expectedOptions.filter((option) => option.startsWith("--"))).toEqual([
        ...LIDARR_SYNC_RATINGS_OPTION_LONGS,
      ]);
      expect(expectedOptions).not.toContain("--output");
      expect(expectedOptions).not.toContain("--json");

      const shellContracts = [
        {
          commands: extractBashCandidates(bashScript, "lidarr_subcommands"),
          decisions: extractBashCandidates(bashScript, "lidarr_sync_ratings_decisions"),
          modes: extractBashCandidates(bashScript, "lidarr_sync_ratings_modes"),
          options: extractBashCandidates(bashScript, "lidarr_sync_ratings_opts"),
          valueOptions: expectedOptions.filter((option) =>
            new RegExp(`(?:^[ \\t]*|\\|)${option}(?:\\||\\))`, "mu").test(bashValueSection),
          ),
        },
        {
          commands: extractZshDescribedCandidates(zshScript, "lidarr_subcmds"),
          decisions: extractZshOptionValues(zshScript, "sync-ratings", "--decision"),
          modes: extractZshOptionValues(zshScript, "sync-ratings", "--mode"),
          options: extractZshCaseOptions(zshScript, "sync-ratings"),
          valueOptions: expectedOptions.filter((option) =>
            new RegExp(`'\\*?${option}\\[[^\\]]*\\]:`, "u").test(zshSyncRatingsBlock),
          ),
        },
        {
          commands: extractFishConditionCandidates(
            fishScript,
            "__fish_rfmedia_lidarr_needs_subcommand",
          ),
          decisions: extractFishOptionValues(fishScript, fishCondition, "decision"),
          modes: extractFishOptionValues(fishScript, fishCondition, "mode"),
          options: extractFishOptions(fishScript, fishCondition),
          valueOptions: expectedOptions.filter((option) => {
            const longOption = option.startsWith("--") ? option.slice(2) : "verbose";
            return /(?:^| )-r(?: |$)/u.test(
              extractFishOptionLine(fishScript, fishCondition, longOption),
            );
          }),
        },
      ];

      for (const contract of shellContracts) {
        expect(contract.commands).toEqual(lidarrCommandTree.lidarr);
        expect(contract.decisions).toEqual([...SYNC_RATINGS_DECISIONS]);
        expect(contract.modes).toEqual([...SYNC_RATINGS_MODES]);
        expect(sorted(contract.options)).toEqual(sorted(expectedOptions));
        expect(sorted(contract.valueOptions)).toEqual(sorted(expectedValueOptions));
      }

      expectZshGlobalOptions(zshSyncRatingsBlock);
      expect([bashScript, zshScript, fishScript].join("\n")).not.toContain(
        "rfmedia lidarr sync-ratings",
      );
      expect(adapterConstructionSpies.create).not.toHaveBeenCalled();
      expect(adapterConstructionSpies.createOptional).not.toHaveBeenCalled();
      expect(adapterConstructionSpies.require).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveContext).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveClient).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.resolveScheduler).not.toHaveBeenCalled();
      expect(lidarrCompletionSideEffectSpies.readConfig).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes Lidarr sync-ratings to its Bash option branch", () => {
    const bashScript = generateBashCompletion();
    const harness = `${bashScript}
_init_completion() {
  words=("\${COMP_WORDS[@]}")
  cword=\$COMP_CWORD
  cur="\${words[cword]}"
  prev="\${words[cword - 1]}"
}
`;
    const run = (words: readonly string[]): string[] => {
      const result = spawnSync("bash", ["--noprofile", "--norc"], {
        encoding: "utf8",
        input: `${harness}
COMP_WORDS=(${words.join(" ")})
COMP_CWORD=${words.length - 1}
_rf_media_completions
printf '%s\\n' "\${COMPREPLY[@]}"
`,
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim().split("\n").filter(Boolean);
    };

    // "sync" is claimed by the plex family in the shared word-scan arm, so
    // without the guarded "sync-ratings)" arm $subcmd stays empty and this
    // returns the whole lidarr subcommand list instead.
    expect(run(["rfmedia", "lidarr", "sync-ratings", "--m"])).toEqual([
      "--min-stars",
      "--max-plays",
      "--max-proposals",
      "--mode",
    ]);
    // Proves the guarded elif fires ahead of the shared $watch_modes branch.
    expect(run(["rfmedia", "lidarr", "sync-ratings", "--mode", '""'])).toEqual([
      "recommend",
      "plan",
      "apply",
    ]);
  });

  it("locks Lidarr import-validation options, statuses, and folder completion", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();
    const bashOptions = [
      ...extractBashCandidates(bashScript, "lidarr_validate_import_opts"),
      ...extractBashCandidates(bashScript, "lidarr_shared_opts"),
    ];

    expect(sorted(bashOptions)).toEqual(sorted(lidarrValidateImportOptions));
    expect(sorted(extractZshCaseOptions(zshScript, "validate-import"))).toEqual(
      sorted(lidarrValidateImportOptions),
    );
    expect(
      sorted(extractFishOptions(fishScript, "__fish_rfmedia_lidarr_validate_import_active")),
    ).toEqual(sorted(lidarrValidateImportOptions));
    expect(extractBashCandidates(bashScript, "lidarr_import_validation_statuses")).toEqual([
      "ready",
      "unmatched",
      "ambiguous",
      "rejected",
    ]);
    expect(extractZshOptionValues(zshScript, "validate-import", "--fail-on")).toEqual([
      "ready",
      "unmatched",
      "ambiguous",
      "rejected",
    ]);
    expect(
      extractFishOptionLine(fishScript, "__fish_rfmedia_lidarr_validate_import_active", "fail-on"),
    ).toContain('-xa "ready unmatched ambiguous rejected"');
    expect(bashScript).toContain("_filedir -d");
    expect(extractZshCaseBlock(zshScript, "validate-import")).toContain(
      "'1:album folder:_files -/'",
    );
    expect(fishScript).toContain(
      'complete -c rfmedia -n "__fish_rfmedia_lidarr_validate_import_active" -a "(__fish_complete_directories)"',
    );
  });

  it("binds Lidarr audit completion value lists to the check registry", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();
    const checkIds = [...LIDARR_AUDIT_CHECK_IDS];
    const failLevels = [...LIDARR_AUDIT_FAIL_ON_LEVELS];

    expect(extractBashCandidates(bashScript, "lidarr_audit_checks")).toEqual(checkIds);
    expect(extractBashCandidates(bashScript, "lidarr_audit_fail_levels")).toEqual(failLevels);
    expect(bashScript).toContain('COMPREPLY=($(compgen -W "$lidarr_audit_checks" -- "$cur"))');
    expect(bashScript).toContain('COMPREPLY=($(compgen -W "$lidarr_audit_fail_levels" -- "$cur"))');

    expect(extractZshOptionValues(zshScript, "audit", "--check")).toEqual(checkIds);
    expect(extractZshOptionValues(zshScript, "audit", "--fail-on")).toEqual(failLevels);
    // --check accumulates in the command layer, so Zsh advertises it repeatable.
    expect(extractZshCaseBlock(zshScript, "audit")).toContain("'*--check[");

    expect(
      extractFishOptionLine(fishScript, "__fish_rfmedia_lidarr_audit_active", "check"),
    ).toContain(`-xa "${checkIds.join(" ")}"`);
    expect(
      extractFishOptionLine(fishScript, "__fish_rfmedia_lidarr_audit_active", "fail-on"),
    ).toContain(`-xa "${failLevels.join(" ")}"`);
  });

  it("locks Lidarr plan operations and exact leaf options across all shells", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    expect(extractBashCandidates(bashScript, "lidarr_plan_operations")).toEqual(
      Object.keys(lidarrPlanOptions),
    );
    expect(extractZshDescribedCandidates(zshScript, "lidarr_plan_operations")).toEqual(
      Object.keys(lidarrPlanOptions),
    );

    for (const [operation, expectedOptions] of Object.entries(lidarrPlanOptions)) {
      const variable = `lidarr_plan_${operation.replaceAll("-", "_")}_opts`;
      const fishCondition = `__fish_rfmedia_lidarr_plan_${operation.replaceAll("-", "_")}_active`;
      expect(sorted(extractBashCandidates(bashScript, variable))).toEqual(sorted(expectedOptions));
      expect(sorted(extractZshCaseOptions(zshScript, operation))).toEqual(sorted(expectedOptions));
      expect(sorted(extractFishOptions(fishScript, fishCondition))).toEqual(
        sorted(expectedOptions),
      );
    }
  });

  it("locks exact Lidarr apply options across all shells", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    expect(sorted(extractBashCandidates(bashScript, "lidarr_apply_opts"))).toEqual(
      sorted(lidarrApplyOptions),
    );
    expect(sorted(extractZshCaseOptions(zshScript, "apply", "'1:plan file:_files'"))).toEqual(
      sorted(lidarrApplyOptions),
    );
    expect(sorted(extractFishOptions(fishScript, "__fish_rfmedia_lidarr_apply_active"))).toEqual(
      sorted(lidarrApplyOptions),
    );
  });

  it("keeps repeatable Lidarr tag references repeatable in Zsh", () => {
    const script = generateZshCompletion();
    for (const option of ["select-tag", "add-tag", "remove-tag", "set-tag"]) {
      expect(script).toContain(`'*--${option}`);
    }
  });

  it("scopes Lidarr plan options per operation with no cross-operation bleed", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    const albumOnlyFlags = ["--types", "--artist-ids", "--album-ids", "--dry-run"];
    const sharedPlanFlags = ["--monitored", "--unmonitored", "--max-batch", "--plan-file"];
    const perLeafConnectionFlags = ["--lidarr-url", "--lidarr-api-key"];

    // Bash: per-operation option sets routed by the plan dispatch arm.
    // Exact-set locking: dropping any album or artist flag fails the spec.
    const bashArtistOpts = extractBashCandidates(bashScript, "lidarr_plan_artist_monitoring_opts");
    const bashAlbumOpts = extractBashCandidates(bashScript, "lidarr_plan_album_monitoring_opts");
    expect(bashAlbumOpts).toEqual([
      "--types",
      "--artist-ids",
      "--album-ids",
      "--monitored",
      "--unmonitored",
      "--dry-run",
      "--max-batch",
      "--plan-file",
      "--lidarr-url",
      "--lidarr-api-key",
    ]);
    expect(bashArtistOpts).toEqual([
      "--ids",
      "--monitored",
      "--unmonitored",
      "--max-batch",
      "--plan-file",
      "--lidarr-url",
      "--lidarr-api-key",
      "-v",
      "--verbose",
    ]);
    for (const flag of albumOnlyFlags) {
      expect(bashArtistOpts).not.toContain(flag);
    }
    // Bash scopes --lidarr-url/--lidarr-api-key via $lidarr_shared_opts, locked
    // structurally by the per-leaf dispatch-string assertions below.
    expect(extractBashCandidates(bashScript, "lidarr_album_types")).toEqual(
      LIDARR_ALBUM_TYPE_SELECTORS,
    );
    expect(bashScript).toContain(
      '--types|--unmonitor-types)\n      COMPREPLY=($(compgen -W "$lidarr_album_types" -- "$cur"))',
    );
    expect(bashScript).toContain("$lidarr_plan_album_monitoring_opts $global_opts");
    expect(bashScript).toContain("$lidarr_plan_artist_monitoring_opts $global_opts");

    // Bash: album-edit and album-delete carry disjoint destructive/edit flags.
    const bashAlbumEditOpts = extractBashCandidates(bashScript, "lidarr_plan_album_edit_opts");
    const bashAlbumDeleteOpts = extractBashCandidates(bashScript, "lidarr_plan_album_delete_opts");
    expect(bashAlbumEditOpts).toEqual([
      "--album-ids",
      "--types",
      "--artist-ids",
      "--any-release-ok",
      "--no-any-release-ok",
      "--dry-run",
      "--max-batch",
      "--plan-file",
      "--lidarr-url",
      "--lidarr-api-key",
    ]);
    expect(bashAlbumDeleteOpts).toEqual([
      "--album-ids",
      "--artist-ids",
      "--types",
      "--include-monitored",
      "--delete-files",
      "--add-import-list-exclusion",
      "--dry-run",
      "--max-batch",
      "--plan-file",
      "--lidarr-url",
      "--lidarr-api-key",
    ]);
    // Cross-bleed guard: edit-only and delete-only flags never leak between leaves.
    for (const flag of ["--any-release-ok", "--no-any-release-ok"]) {
      expect(bashAlbumDeleteOpts).not.toContain(flag);
    }
    for (const flag of ["--include-monitored", "--delete-files", "--add-import-list-exclusion"]) {
      expect(bashAlbumEditOpts).not.toContain(flag);
    }
    expect(bashScript).toContain("$lidarr_plan_album_edit_opts $global_opts");
    expect(bashScript).toContain("$lidarr_plan_album_delete_opts $global_opts");

    // Zsh: each operation has a dedicated state-machine case.
    const zshAlbumBranch = extractZshCaseOptions(zshScript, "album-monitoring");
    const zshArtistBranch = extractZshCaseOptions(zshScript, "artist-monitoring");
    for (const flag of albumOnlyFlags) {
      expect(zshAlbumBranch).toContain(flag.replace(/^--/u, "--"));
    }
    // Both leaves carry the shared plan flags and per-leaf connection overrides.
    for (const flag of [...sharedPlanFlags, ...perLeafConnectionFlags]) {
      expect(zshAlbumBranch).toContain(flag);
      expect(zshArtistBranch).toContain(flag);
    }
    expect(zshScript).toContain(
      `'--types[Album type selectors]:types:(${LIDARR_ALBUM_TYPE_SELECTORS.join(" ")})'`,
    );
    expect(zshArtistBranch).toContain("--ids");
    expect(zshArtistBranch).not.toContain("--types");
    expect(zshArtistBranch).not.toContain("--album-ids");

    // Fish: per-operation predicates keep flag lines scoped.
    const fishLinesFor = (predicate: string): string =>
      fishScript
        .split("\n")
        .filter((line) => line.includes(`-n "${predicate}"`))
        .join("\n");
    const fishAlbumLines = fishLinesFor("__fish_rfmedia_lidarr_plan_album_monitoring_active");
    const fishArtistLines = fishLinesFor("__fish_rfmedia_lidarr_plan_artist_monitoring_active");
    for (const flag of albumOnlyFlags) {
      const fishFlag = flag.replace(/^--/u, "-l ");
      expect(fishAlbumLines).toContain(fishFlag);
      expect(fishArtistLines).not.toContain(fishFlag);
    }
    // Both leaves carry the shared plan flags and per-leaf connection overrides.
    for (const flag of [...sharedPlanFlags, ...perLeafConnectionFlags]) {
      const fishFlag = flag.replace(/^--/u, "-l ");
      expect(fishAlbumLines).toContain(fishFlag);
      expect(fishArtistLines).toContain(fishFlag);
    }
    expect(fishAlbumLines).toContain(
      `-l types -d "Album type selectors" -r -xa "${LIDARR_ALBUM_TYPE_SELECTORS.join(" ")}"`,
    );
    expect(fishArtistLines).toContain('-l ids -d "Comma-separated Lidarr artist IDs"');
  });

  it("completes Lidarr plan values and plan artifact paths across all shells", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    expect(bashScript).toContain('local lidarr_max_batches="10 25 50 100 250 500 1000"');
    expect(bashScript).toContain(
      '--max-batch)\n      COMPREPLY=($(compgen -W "$lidarr_max_batches" -- "$cur"))',
    );
    expect(bashScript).toContain(
      "--file|--completed-file|--path|--protect|--plan-file|--out|--tracking-database|--history-path|--paths|--from-folder|--plan-output|--apply)",
    );
    expect(bashScript).toContain(
      'elif [[ "$subcmd" == "apply" ]]; then\n          if [[ "$cur" == -* ]]; then',
    );
    expect(bashScript).toContain(
      'COMPREPLY=($(compgen -W "$lidarr_apply_opts $global_opts" -- "$cur"))\n          else\n            _filedir',
    );

    expect(zshScript).toContain(
      "'--max-batch[Maximum targets allowed]:count:(10 25 50 100 250 500 1000)'",
    );
    expect(zshScript).toContain("'--plan-file[Plan artifact output path]:file:_files'");
    expect(zshScript).toContain("'1:plan file:_files'");

    expect(fishScript).toContain(
      '-l max-batch -d "Maximum targets allowed" -r -xa "10 25 50 100 250 500 1000"',
    );
    expect(fishScript).toContain('-l plan-file -d "Plan artifact output path" -r -F');
    expect(fishScript).toContain('complete -c rfmedia -n "__fish_rfmedia_lidarr_apply_active" -F');
  });

  it("marks every value-taking Lidarr Fish option as requiring an argument", () => {
    const script = generateFishCompletion();
    const valueOptionsByCondition = {
      __fish_rfmedia_lidarr_status_active: ["lidarr-url", "lidarr-api-key"],
      __fish_rfmedia_lidarr_list_active: [
        "tag",
        "quality-profile",
        "limit",
        "offset",
        "lidarr-url",
        "lidarr-api-key",
      ],
      __fish_rfmedia_lidarr_wanted_active: [
        "page",
        "page-size",
        "sort-key",
        "sort-dir",
        "lidarr-url",
        "lidarr-api-key",
      ],
      __fish_rfmedia_lidarr_health_active: ["type", "lidarr-url", "lidarr-api-key"],
      // --deep and --verbose are booleans, so neither carries -r.
      __fish_rfmedia_lidarr_audit_active: [
        "check",
        "artist-ids",
        "fail-on",
        "plex-url",
        "plex-token",
        "lidarr-url",
        "lidarr-api-key",
      ],
      __fish_rfmedia_lidarr_albums_active: [
        "artist-ids",
        "album-ids",
        "types",
        "limit",
        "offset",
        "lidarr-url",
        "lidarr-api-key",
      ],
      // --verbose is the only boolean on the policy leaf, so it carries no -r.
      __fish_rfmedia_lidarr_policy_evaluate_active: [
        "plex-library",
        "rule",
        "max-proposals",
        "explain",
        "fail-on",
        "plex-url",
        "plex-token",
        "lidarr-url",
        "lidarr-api-key",
      ],
      __fish_rfmedia_lidarr_policy_plan_active: [
        "plex-library",
        "rule",
        "max-proposals",
        "mode",
        "explain",
        "plex-url",
        "plex-token",
        "lidarr-url",
        "lidarr-api-key",
      ],
      // --yes and --verbose are the only booleans on the sync-ratings leaf; the
      // safety rung travels as a --mode value, so it carries -r like the rest.
      __fish_rfmedia_lidarr_sync_ratings_active: [
        "plex-library",
        "decision",
        "min-stars",
        "max-plays",
        "quality-profile",
        "max-proposals",
        "mode",
        "explain",
        "plex-url",
        "plex-token",
        "lidarr-url",
        "lidarr-api-key",
      ],
      __fish_rfmedia_lidarr_plan_album_edit_active: [
        "album-ids",
        "types",
        "artist-ids",
        "max-batch",
        "plan-file",
        "lidarr-url",
        "lidarr-api-key",
      ],
      __fish_rfmedia_lidarr_plan_album_delete_active: [
        "album-ids",
        "artist-ids",
        "types",
        "max-batch",
        "plan-file",
        "lidarr-url",
        "lidarr-api-key",
      ],
      __fish_rfmedia_lidarr_plan_artist_monitoring_active: [
        "ids",
        "max-batch",
        "plan-file",
        "lidarr-url",
        "lidarr-api-key",
      ],
      __fish_rfmedia_lidarr_plan_album_monitoring_active: [
        "types",
        "artist-ids",
        "album-ids",
        "max-batch",
        "plan-file",
        "lidarr-url",
        "lidarr-api-key",
      ],
      __fish_rfmedia_lidarr_plan_artist_profiles_active: [
        "ids",
        "select-quality-profile",
        "select-metadata-profile",
        "select-tag",
        "quality-profile",
        "metadata-profile",
        "max-batch",
        "plan-file",
        "lidarr-url",
        "lidarr-api-key",
      ],
      __fish_rfmedia_lidarr_plan_artist_tags_active: [
        "ids",
        "select-quality-profile",
        "select-metadata-profile",
        "select-tag",
        "add-tag",
        "remove-tag",
        "set-tag",
        "max-batch",
        "plan-file",
        "lidarr-url",
        "lidarr-api-key",
      ],
      [lidarrArtistDeleteCondition]: lidarrArtistDeleteValueOptions,
      __fish_rfmedia_lidarr_apply_active: [
        "expected-plan-id",
        "expected-plan-checksum",
        "lidarr-url",
        "lidarr-api-key",
      ],
    } as const;

    for (const [condition, options] of Object.entries(valueOptionsByCondition)) {
      for (const option of options) {
        expect(extractFishOptionLine(script, condition, option)).toMatch(/(?:^| )-r(?: |$)/u);
      }
    }

    expect(extractFishOptionLine(script, "__fish_rfmedia_lidarr_list_active", "limit")).toContain(
      '-xa "10 20 50 100 200"',
    );
    expect(
      extractFishOptionLine(
        script,
        "__fish_rfmedia_lidarr_plan_artist_monitoring_active",
        "plan-file",
      ),
    ).toContain("-F");
  });

  it("keeps Lidarr scheduler policy config-only across all shells", () => {
    const scripts = [generateBashCompletion(), generateZshCompletion(), generateFishCompletion()];
    for (const script of scripts) {
      expect(script).not.toContain("--lane-concurrency");
      expect(script).not.toContain("--operation-budget");
      expect(script).not.toContain("--retry-backoff-cap");
    }
  });

  it("includes dynamic filter completion for plex flags in bash", () => {
    const script = generateBashCompletion();
    expect(script).toContain("--filter|-F)");
  });

  it("includes dynamic filter completion for plex flags in zsh", () => {
    const script = generateZshCompletion();
    expect(script).toContain(
      "(-F --filter)'{-F,--filter}'[Apply named filter from plexFilters config]:filter:__rfmedia_complete_plex_filter_names",
    );
    expect(script).toContain(
      "(-F --filter)'{-F,--filter}'[Use named filter from config]:filter:__rfmedia_complete_plex_filter_names",
    );
    expect(script).toContain(
      "(-F --filter)'{-F,--filter}'[Use a named filter from config]:filter:__rfmedia_complete_plex_filter_names",
    );
  });

  it("includes dynamic filter completion for plex flags in fish", () => {
    const script = generateFishCompletion();
    expect(script).toContain(
      '-s F -l filter -d "Apply named filter from plexFilters config" -xa "(__fish_rfmedia_get_plex_filter_names)"',
    );
    expect(script).toContain(
      '-s F -l filter -d "Use named filter from config" -xa "(__fish_rfmedia_get_plex_filter_names)"',
    );
    expect(script).toContain(
      '-s F -l filter -d "Use a named filter from config" -xa "(__fish_rfmedia_get_plex_filter_names)"',
    );
  });

  it("includes typed plex collection options in bash, zsh, and fish", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    expect(bashScript).toContain("--library --type --mode --add-track --add-album --add-artist");
    expect(bashScript).toContain("--mode --add-track --add-album --add-artist");

    expect(zshScript).toContain(
      "(--type --mode --add-track --add-album --add-artist)--type[Collection item type]:type:(track album artist)",
    );
    expect(zshScript).toContain(
      "(--type --mode --add-track --add-album --add-artist)--mode[Item mode to add]:mode:(track album artist)",
    );
    expect(zshScript).toContain("--mode[Item mode to add]:mode:(track album artist)");
    expect(zshScript).toContain("--add-track[Alias for --mode track]");
    expect(zshScript).toContain("--add-album[Alias for --mode album]");
    expect(zshScript).toContain("--add-artist[Alias for --mode artist]");

    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_collection_create_active" -l type -d "Collection item type" -xa "track album artist"',
    );
    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_collection_create_active" -l mode -d "Item mode to add" -xa "track album artist"',
    );
    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_collection_create_active" -l add-track -d "Alias for --mode track"',
    );
    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_collection_create_active" -l add-album -d "Alias for --mode album"',
    );
    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_collection_create_active" -l add-artist -d "Alias for --mode artist"',
    );
    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_collection_add_active" -l mode -d "Item mode to add" -xa "track album artist"',
    );
    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_collection_add_active" -l add-track -d "Alias for --mode track"',
    );
    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_collection_add_active" -l add-album -d "Alias for --mode album"',
    );
    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_collection_add_active" -l add-artist -d "Alias for --mode artist"',
    );
  });

  it("includes typed plex auth options in bash, zsh, and fish", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    expect(extractBashCandidates(bashScript, "plex_auth_login_opts")).toEqual([
      "--plex-url",
      "--device-name",
      "--timeout",
      "-y",
      "--yes",
    ]);
    expect(extractBashCandidates(bashScript, "plex_auth_status_opts")).toEqual(["--plex-url"]);
    expect(extractBashCandidates(bashScript, "plex_auth_refresh_opts")).toEqual([
      "--plex-url",
      "--timeout",
      "--force",
    ]);
    expect(extractBashCandidates(bashScript, "plex_auth_logout_opts")).toEqual([
      "--plex-url",
      "-y",
      "--yes",
    ]);

    expect(zshScript).toContain("'--plex-url[Plex server URL (overrides config)]:url:'");
    expect(zshScript).toContain("'--device-name[Device label shown in your Plex account]:name:'");
    expect(zshScript).toContain(
      "'--timeout[Authorization timeout in seconds]:seconds:(60 120 300 900)'",
    );
    expect(zshScript).toContain(
      "'--force[Rotate now even if the credential is fresh (does not bypass Plex rate limits)]'",
    );
    expect(zshScript).toContain("'(-y --yes)'{-y,--yes}'[Skip confirmation prompt]'");

    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_auth_login_active" -l device-name -d "Device label shown in your Plex account" -r',
    );
    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_auth_login_active" -l timeout -d "Authorization timeout in seconds" -xa "60 120 300 900"',
    );
    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_auth_login_active" -s y -l yes -d "Skip confirmation prompt"',
    );
    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_auth_status_active" -l plex-url -d "Plex server URL (overrides config)"',
    );
    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_auth_refresh_active" -l force -d "Rotate now even if the credential is fresh (does not bypass Plex rate limits)"',
    );
    expect(fishScript).toContain(
      '-n "__fish_rfmedia_plex_auth_logout_active" -s y -l yes -d "Skip confirmation prompt"',
    );
  });

  it("fish Plex -F/--filter completions source from plex filter list command", () => {
    const script = generateFishCompletion();
    expect(script).toContain("__fish_rfmedia_get_plex_filter_names");
    expect(script).toContain("rfmedia filter list --plex --names");
  });

  it("zsh Plex -F/--filter completions source from plex filter list command", () => {
    const script = generateZshCompletion();
    expect(script).toContain("__rfmedia_get_plex_filter_names");
    expect(script).toContain("__rfmedia_complete_plex_filter_names");
    expect(script).toContain("rfmedia filter list --plex --names");
    expect(script).toContain('print -r -l -- "${plex_filter_names[@]}"');
  });

  it("uses helper parsing at top-level and positional parsing in nested zsh contexts", () => {
    const script = generateZshCompletion();
    expect(script).toContain("__rfmedia_find_command()");
    expect(script).toContain("local cmd=$(__rfmedia_find_command)");
    expect(script).toContain("plex_args)");
    expect(script).toContain("copy_args)");
    expect(script).toContain("queue_args)");
    expect(script).toMatch(/if\s+\[\[\s+\$line\[2]\s*==\s*"copy"\s*\]\];?\s*then/);
  });

  it("includes dynamic smart filter completion for copy/delete/playlist flags in zsh", () => {
    const script = generateZshCompletion();
    expect(script).toContain(
      "--filter[Select smart filter by name]:filter:__rfmedia_complete_filter_names",
    );
    expect(script).toContain(
      "--filter[Match copies created with named smart filter]:filter:__rfmedia_complete_filter_names",
    );
    expect(script).toContain(
      "(-f --filter)'{-f,--filter}'[Named filter from config]:filter:__rfmedia_complete_filter_names",
    );
    expect(script).toContain('print -r -l -- "${filter_names[@]}"');
  });

  it("bash and fish smart filter completions source from filter list command", () => {
    const bashScript = generateBashCompletion();
    const fishScript = generateFishCompletion();
    expect(bashScript).toContain("rfmedia filter list --names");
    expect(fishScript).toContain("__fish_rfmedia_get_filter_names");
    expect(fishScript).toContain("rfmedia filter list --names");
  });

  it("keeps quick, deep, and tracking-database verify flags in parity", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();
    const bashVerifyOptions = bashScript.match(/local verify_opts="([\s\S]*?)"/u)?.[1];
    const zshVerifyBlock = zshScript.match(/        verify\)([\s\S]*?)        completion\)/u)?.[1];
    const fishVerifyLines = fishScript
      .split("\n")
      .filter((line) => line.includes("__fish_seen_subcommand_from verify"))
      .join("\n");

    expect(bashVerifyOptions).toBeDefined();
    expect(zshVerifyBlock).toBeDefined();
    for (const flag of ["quick", "deep", "tracking-database"]) {
      expect(bashVerifyOptions).toContain(`--${flag}`);
      expect(zshVerifyBlock).toContain(`--${flag}`);
      expect(fishVerifyLines).toContain(`-l ${flag}`);
    }
  });

  it("keeps plan, plan-output, apply, yes, and force-stale copy flags in parity", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();
    const bashCopyOptions = bashScript.match(/local copy_opts="([\s\S]*?)"/u)?.[1];
    const zshCopyBlock = zshScript.match(/        copy\)([\s\S]*?)        clean\)/u)?.[1];
    const fishCopyLines = fishScript
      .split("\n")
      .filter((line) => line.includes("__fish_seen_subcommand_from copy"))
      .join("\n");

    expect(bashCopyOptions).toBeDefined();
    expect(zshCopyBlock).toBeDefined();
    for (const flag of ["plan", "plan-output", "apply", "yes", "force-stale"]) {
      expect(bashCopyOptions).toContain(`--${flag}`);
      expect(zshCopyBlock).toContain(`--${flag}`);
      expect(fishCopyLines).toContain(`-l ${flag}`);
    }
    // Bash routes the value-taking plan flags to file completion (_filedir).
    expect(bashScript).toContain("--from-folder|--plan-output|--apply)");
  });

  it("keeps the allow-stale lidarr status/list flag in parity across shells", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    // Bash: dedicated status option set plus the list option set carry the flag.
    expect(extractBashCandidates(bashScript, "lidarr_status_opts")).toContain("--allow-stale");
    expect(extractBashCandidates(bashScript, "lidarr_list_opts")).toContain("--allow-stale");
    expect(extractBashCandidates(bashScript, "lidarr_wanted_opts")).not.toContain("--allow-stale");
    expect(extractBashCandidates(bashScript, "lidarr_health_opts")).not.toContain("--allow-stale");
    // The bash status dispatch arm routes to the dedicated status option set.
    expect(bashScript).toContain("$lidarr_status_opts $lidarr_shared_opts $global_opts");

    const zshLidarrBlock = zshScript.match(/ {8}lidarr\)([\s\S]*?) {8}playlist\)/u)?.[1];
    expect(zshLidarrBlock).toBeDefined();
    const zshStatusBlock = zshLidarrBlock?.match(/status\)([\s\S]*?)list\)/u)?.[1];
    const zshListBlock = zshLidarrBlock?.match(/list\)([\s\S]*?)wanted\)/u)?.[1];
    const zshWantedBlock = zshLidarrBlock?.match(/wanted\)([\s\S]*?)health\)/u)?.[1];
    const zshHealthBlock = extractZshCaseBlock(zshScript, "health");
    expect(zshStatusBlock).toContain("--allow-stale");
    expect(zshListBlock).toContain("--allow-stale");
    expect(zshWantedBlock).not.toContain("--allow-stale");
    expect(zshHealthBlock).not.toContain("--allow-stale");

    const fishLinesFor = (condition: string): string =>
      fishScript
        .split("\n")
        .filter((line) => line.includes(`-n "${condition}"`))
        .join("\n");
    expect(fishLinesFor("__fish_rfmedia_lidarr_status_active")).toContain("-l allow-stale");
    expect(fishLinesFor("__fish_rfmedia_lidarr_list_active")).toContain("-l allow-stale");
    expect(fishLinesFor("__fish_rfmedia_lidarr_wanted_active")).not.toContain("-l allow-stale");
    expect(fishLinesFor("__fish_rfmedia_lidarr_health_active")).not.toContain("-l allow-stale");
  });

  it("documents stable verify evidence and cost semantics across shells", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();
    const quickDescription =
      "Metadata-only verification; reads no file contents or tracking database";
    const deepDescription = "Stored SHA-256 plus applicable source/destination byte comparison";
    const databaseDescription =
      "Existing SQLite tracking database for default/deep fingerprint evidence";

    expect(bashScript).toContain(
      "--quick is metadata-only with no database/content reads; --deep adds applicable byte comparison.",
    );
    expect(bashScript).toContain(
      "--tracking-database supplies existing stored SHA-256 evidence for default/deep verification.",
    );
    for (const script of [zshScript, fishScript]) {
      expect(script).toContain(quickDescription);
      expect(script).toContain(deepDescription);
      expect(script).toContain(databaseDescription);
    }
  });

  it("keeps database path completion and tier-conflict hints shell-appropriate", () => {
    const bashScript = generateBashCompletion();
    const zshScript = generateZshCompletion();
    const fishScript = generateFishCompletion();

    expect(bashScript).toContain(
      "--file|--completed-file|--path|--protect|--plan-file|--out|--tracking-database|--history-path|--paths|--from-folder|--plan-output|--apply)",
    );
    expect(bashScript).toContain('available_verify_opts="${available_verify_opts/--deep/}"');
    expect(bashScript).toContain('available_verify_opts="${available_verify_opts/--quick/}"');

    expect(zshScript).toContain("(--deep)--quick[");
    expect(zshScript).toContain("(--quick)--deep[");
    expect(zshScript).toContain(
      "--tracking-database[Existing SQLite tracking database for default/deep fingerprint evidence]:file:_files",
    );

    expect(fishScript).toContain(
      '-n "__fish_seen_subcommand_from verify; and not __fish_seen_argument -l deep" -l quick',
    );
    expect(fishScript).toContain(
      '-n "__fish_seen_subcommand_from verify; and not __fish_seen_argument -l quick" -l deep',
    );
    expect(fishScript).toContain(
      '-l tracking-database -d "Existing SQLite tracking database for default/deep fingerprint evidence" -r -F',
    );
  });
});
