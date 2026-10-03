/**
 * Filter action for rfmedia CLI.
 *
 * Provides functionality to list, display, and interactively create
 * smart filter definitions for the configuration file.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";

import { getLoadedConfig, clearConfigCache } from "../lib/loaded-config.js";
import { logDebug, logInfo, logWarn, logSuccess, logError } from "../lib/logger.js";
import { pathExists } from "../lib/filesystem.js";
import { getConfigSearchPaths } from "../lib/config.js";
import { confirm, selectOption, inputText, inputNumber, isInteractive } from "../lib/prompt.js";
import type {
  SmartFilter,
  SmartFilterRule,
  FilterMatch,
  FilterField,
  FilterOperator,
  FilterRule,
  FilterGroup,
} from "../types/filters.js";
import { isFilterRule, isFilterGroup } from "../types/filters.js";
import type { MediaFilterNode } from "../types/media-filters.js";
import { isMediaFilterRule, isMediaFilterGroup } from "../types/media-filters.js";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Options for the filter list action.
 */
export interface FilterListOptions {
  /** Preview mode (no-op for filter list, kept for consistency) */
  dryRun: boolean;
  /** List Plex filters from config.plexFilters instead of config.filters */
  plex?: boolean;
  /** Output only filter names, one per line (for shell completion) */
  namesOnly?: boolean;
}

/**
 * Options for the filter show action.
 */
export interface FilterShowOptions {
  /** Name of the filter to show */
  name: string;
  /** Preview mode (no-op for filter show, kept for consistency) */
  dryRun: boolean;
}

/**
 * Summary information about a single filter.
 */
export interface FilterSummary {
  /** Filter name */
  name: string;
  /** Root-level match type (all/any) */
  match: FilterMatch;
  /** Total number of rules (including nested) */
  ruleCount: number;
}

/**
 * Result from the filter list action.
 */
export interface FilterListResult {
  /** Array of filter summaries */
  filters: FilterSummary[];
  /** Total number of filters */
  total: number;
}

/**
 * Result from the filter show action.
 */
export interface FilterShowResult {
  /** Filter name */
  name: string;
  /** Full filter definition */
  filter: SmartFilter;
  /** Human-readable rule tree */
  ruleTree: string;
}

/**
 * Options for the filter create action.
 */
export interface FilterCreateOptions {
  /** Filter name (optional, will prompt if not provided) */
  name?: string;
  /** Path to config file to write to (optional, uses default search paths) */
  configPath?: string;
  /** Preview mode - don't actually write to file */
  dryRun: boolean;
}

/**
 * Result from the filter create action.
 */
export interface FilterCreateResult {
  /** Filter name */
  name: string;
  /** Created filter definition */
  filter: SmartFilter;
  /** Path to config file written to */
  configPath: string;
  /** Whether the file was created (vs updated) */
  created: boolean;
}

// ============================================================================
// ENTRY FUNCTIONS
// ============================================================================

/**
 * Executes the filter list action.
 *
 * Lists all defined smart filters with their match type and rule counts.
 * Use options.plex to list from config.plexFilters instead of config.filters.
 *
 * @param options - Filter list options from CLI
 * @returns Filter list result with summaries
 */
export async function executeFilterList(options: FilterListOptions): Promise<FilterListResult> {
  if (options.plex) {
    return executeFilterListPlex(options);
  }

  const config = getLoadedConfig();
  const filters = config.filters ?? {};

  const filterNames = Object.keys(filters);
  logDebug(`Found ${filterNames.length} filter(s) in configuration`);

  const summaries: FilterSummary[] = filterNames.map((name) => {
    const filter = filters[name];
    if (!filter) {
      throw new Error(`Filter "${name}" is undefined`);
    }
    const ruleCount = countRules(filter);
    return {
      name,
      match: filter.match,
      ruleCount,
    };
  });

  return {
    filters: summaries,
    total: summaries.length,
  };
}

/**
 * Lists Plex filter names from config.plexFilters (same result shape as executeFilterList).
 * Used by shell completions for Plex -F/--filter flags.
 *
 * @param _options - Filter list options from CLI
 * @returns Filter list result with summaries
 */
export async function executeFilterListPlex(
  _options: FilterListOptions,
): Promise<FilterListResult> {
  const config = getLoadedConfig();
  const plexFilters = config.plexFilters ?? {};

  const filterNames = Object.keys(plexFilters);
  logDebug(`Found ${filterNames.length} Plex filter(s) in configuration`);

  const summaries: FilterSummary[] = filterNames.map((name) => {
    const filter = plexFilters[name];
    if (!filter) {
      throw new Error(`Plex filter "${name}" is undefined`);
    }
    const ruleCount = countMediaFilterRules(filter.rules);
    return {
      name,
      match: filter.match as FilterMatch,
      ruleCount,
    };
  });

  return {
    filters: summaries,
    total: summaries.length,
  };
}

/**
 * Executes the filter show action.
 *
 * Displays detailed information about a specific filter, including
 * the full rule tree with AND/OR indicators.
 *
 * @param options - Filter show options from CLI
 * @returns Filter show result with full definition
 * @throws Error if filter not found
 */
export async function executeFilterShow(options: FilterShowOptions): Promise<FilterShowResult> {
  const config = getLoadedConfig();
  const filters = config.filters ?? {};

  const filter = filters[options.name];
  if (!filter) {
    const filterNames = Object.keys(filters);
    if (filterNames.length === 0) {
      throw new Error(
        `Filter "${options.name}" not found. No filters defined in config. ` +
          "Add filters to your .rfmedia.json or filters.yml file.",
      );
    }
    throw new Error(
      `Filter "${options.name}" not found. Available filters: ${filterNames.join(", ")}`,
    );
  }

  logDebug(`Loading filter: ${options.name}`);

  const ruleTree = formatRuleTree(filter);

  return {
    name: options.name,
    filter,
    ruleTree,
  };
}

/**
 * Executes the filter create action.
 *
 * Interactively builds a smart filter through a step-by-step wizard
 * and saves it to the configuration file.
 *
 * @param options - Filter create options from CLI
 * @returns Filter create result with the created filter
 * @throws Error if not running in an interactive terminal
 */
export async function executeFilterCreate(
  options: FilterCreateOptions,
): Promise<FilterCreateResult> {
  // Check for interactive terminal
  if (!isInteractive()) {
    throw new Error(
      "Interactive filter builder requires a TTY terminal. " +
        "Cannot create filters in non-interactive mode (piped input, CI, etc.)",
    );
  }

  logInfo("");
  logInfo("╔════════════════════════════════════════╗");
  logInfo("║   Smart Filter Builder (Interactive)   ║");
  logInfo("╚════════════════════════════════════════╝");
  logInfo("");

  // Step 1: Get filter name
  let filterName = options.name;
  if (!filterName) {
    filterName = await inputText("Enter filter name:", { required: true });
  }

  // Check if filter already exists
  const existingConfig = getLoadedConfig();
  if (existingConfig.filters?.[filterName]) {
    const overwrite = await confirm(`Filter "${filterName}" already exists. Overwrite?`);
    if (!overwrite) {
      throw new Error("Filter creation cancelled - filter already exists");
    }
  }

  logInfo("");
  logInfo(`Creating filter: ${filterName}`);
  logInfo("");

  // Step 2: Build the filter rules
  const filter = await buildFilterInteractive();

  // Step 3: Preview the filter
  logInfo("");
  logInfo("═══ Filter Preview ═══");
  logInfo("");
  logInfo(formatRuleTree(filter));
  logInfo("");

  // Step 4: Confirm and save
  const shouldSave = await confirm("Save this filter?");
  if (!shouldSave) {
    throw new Error("Filter creation cancelled by user");
  }

  if (options.dryRun) {
    logInfo("");
    logSuccess(`[DRY-RUN] Would save filter "${filterName}" to config file`);
    return {
      name: filterName,
      filter,
      configPath: options.configPath ?? getDefaultYamlConfigPath(),
      created: true,
    };
  }

  // Step 5: Write to config file
  const { configPath, created } = await saveFilterToConfig(filterName, filter, options.configPath);

  logInfo("");
  logSuccess(`Filter "${filterName}" saved to: ${configPath}`);

  return {
    name: filterName,
    filter,
    configPath,
    created,
  };
}

// ============================================================================
// INTERACTIVE BUILDER HELPERS
// ============================================================================

/**
 * Returns the default path for YAML config file.
 */
function getDefaultYamlConfigPath(): string {
  return join(homedir(), ".rfmedia.yaml");
}

/**
 * Available filter fields with descriptions.
 */
const FILTER_FIELDS: Array<{ label: string; value: FilterField; key: string }> = [
  { label: "Rating (star rating 1-5)", value: "rating", key: "r" },
  { label: "Genre (text match)", value: "genre", key: "g" },
  { label: "Artist (text match)", value: "artist", key: "a" },
  { label: "Year (numeric)", value: "year", key: "y" },
  { label: "BPM (numeric)", value: "bpm", key: "b" },
  { label: "Date Added (time-based)", value: "date_added", key: "d" },
];

/**
 * Available operators by field type.
 */
const NUMERIC_OPERATORS: Array<{ label: string; value: FilterOperator; key: string }> = [
  { label: ">= (greater than or equal)", value: ">=", key: "1" },
  { label: "<= (less than or equal)", value: "<=", key: "2" },
  { label: "== (equal)", value: "==", key: "3" },
];

const TEXT_OPERATORS: Array<{ label: string; value: FilterOperator; key: string }> = [
  { label: "contains (substring match)", value: "contains", key: "c" },
  { label: "== (exact match)", value: "==", key: "e" },
];

const DATE_OPERATORS: Array<{ label: string; value: FilterOperator; key: string }> = [
  { label: 'within (e.g., "30d" for last 30 days)', value: "within", key: "w" },
];

/**
 * Gets the appropriate operators for a field type.
 */
function getOperatorsForField(
  field: FilterField,
): Array<{ label: string; value: FilterOperator; key: string }> {
  switch (field) {
    case "rating":
    case "year":
    case "bpm":
      return NUMERIC_OPERATORS;
    case "genre":
    case "artist":
      return TEXT_OPERATORS;
    case "date_added":
      return DATE_OPERATORS;
    default:
      return NUMERIC_OPERATORS;
  }
}

/**
 * Builds a complete filter interactively.
 */
async function buildFilterInteractive(): Promise<SmartFilter> {
  // Select root match type
  const match = await selectOption<FilterMatch>("Select match type for root level:", [
    { label: "ALL rules must match (AND logic)", value: "all", key: "a" },
    { label: "ANY rule must match (OR logic)", value: "any", key: "o" },
  ]);

  logInfo("");
  logInfo("Add rules to your filter. You can add:");
  logInfo("  [r] Rule - a single condition (e.g., rating >= 4)");
  logInfo("  [g] Group - nested rules with AND/OR logic");
  logInfo("  [d] Done - finish adding rules");
  logInfo("");

  // Build rules array
  const rules: SmartFilterRule[] = [];
  let addingRules = true;

  while (addingRules) {
    const action = await selectOption<"rule" | "group" | "done">("Add:", [
      { label: "Rule (single condition)", value: "rule", key: "r" },
      { label: "Group (nested AND/OR)", value: "group", key: "g" },
      { label: "Done (finish adding rules)", value: "done", key: "d" },
    ]);

    switch (action) {
      case "rule": {
        const rule = await buildRuleInteractive();
        rules.push(rule);
        logInfo(`  ✓ Added: ${formatRuleForDisplay(rule)}`);
        logInfo("");
        break;
      }
      case "group": {
        const group = await buildGroupInteractive(1);
        rules.push(group);
        logInfo(`  ✓ Added group with ${countGroupRules(group)} rule(s)`);
        logInfo("");
        break;
      }
      case "done":
        if (rules.length === 0) {
          logWarn("Filter must have at least one rule. Please add a rule.");
        } else {
          addingRules = false;
        }
        break;
    }
  }

  return { match, rules };
}

/**
 * Builds a single filter rule interactively.
 */
async function buildRuleInteractive(): Promise<FilterRule> {
  // Select field
  const field = await selectOption<FilterField>("Select field:", FILTER_FIELDS);

  // Select operator (based on field type)
  const operators = getOperatorsForField(field);
  const operator = await selectOption<FilterOperator>("Select operator:", operators);

  // Get value (based on field type)
  let value: string | number;

  switch (field) {
    case "rating":
      value = await inputNumber("Enter rating value (1.0-5.0):", { min: 1, max: 5 });
      break;
    case "year":
      value = await inputNumber("Enter year:", { min: 1900, max: 2100, integer: true });
      break;
    case "bpm":
      value = await inputNumber("Enter BPM:", { min: 1, max: 300, integer: true });
      break;
    case "genre":
      value = await inputText('Enter genre (e.g., "Rock", "Alternative"):', { required: true });
      break;
    case "artist":
      value = await inputText("Enter artist name:", { required: true });
      break;
    case "date_added":
      value = await inputText('Enter time period (e.g., "30d" for 30 days):', {
        required: true,
        defaultValue: "30d",
      });
      break;
    default:
      value = await inputText("Enter value:", { required: true });
  }

  return {
    type: "rule",
    field,
    operator,
    value,
  };
}

/**
 * Builds a nested filter group interactively.
 */
async function buildGroupInteractive(depth: number): Promise<FilterGroup> {
  if (depth > 5) {
    logWarn("Maximum nesting depth reached (5 levels). Creating rule instead.");
    const rule = await buildRuleInteractive();
    // Return a group containing just the rule
    return {
      type: "group",
      match: "all",
      rules: [rule],
    };
  }

  logInfo(`  [Nested Group - Level ${depth}]`);

  // Select match type for this group
  const match = await selectOption<FilterMatch>("Select match type for this group:", [
    { label: "ALL rules must match (AND)", value: "all", key: "a" },
    { label: "ANY rule must match (OR)", value: "any", key: "o" },
  ]);

  // Build rules for this group
  const rules: SmartFilterRule[] = [];
  let addingRules = true;

  while (addingRules) {
    const action = await selectOption<"rule" | "group" | "done">("Add to group:", [
      { label: "Rule (single condition)", value: "rule", key: "r" },
      { label: "Nested Group", value: "group", key: "g" },
      { label: "Done with this group", value: "done", key: "d" },
    ]);

    switch (action) {
      case "rule": {
        const rule = await buildRuleInteractive();
        rules.push(rule);
        logInfo(`    ✓ Added: ${formatRuleForDisplay(rule)}`);
        break;
      }
      case "group": {
        const group = await buildGroupInteractive(depth + 1);
        rules.push(group);
        logInfo(`    ✓ Added nested group`);
        break;
      }
      case "done":
        if (rules.length === 0) {
          logWarn("Group must have at least one rule. Please add a rule.");
        } else {
          addingRules = false;
        }
        break;
    }
  }

  return {
    type: "group",
    match,
    rules,
  };
}

/**
 * Formats a rule for display in the interactive builder.
 */
function formatRuleForDisplay(rule: FilterRule): string {
  const valueStr = typeof rule.value === "string" ? `"${rule.value}"` : String(rule.value);
  return `${rule.field} ${rule.operator} ${valueStr}`;
}

/**
 * Counts rules in a group (including nested).
 */
function countGroupRules(group: FilterGroup): number {
  let count = 0;
  for (const rule of group.rules) {
    if (isFilterRule(rule)) {
      count++;
    } else if (isFilterGroup(rule)) {
      count += countGroupRules(rule);
    }
  }
  return count;
}

/**
 * Saves a filter to the config file.
 *
 * Attempts to update an existing YAML config file, or creates a new one.
 * Falls back to JSON if YAML write fails.
 */
async function saveFilterToConfig(
  filterName: string,
  filter: SmartFilter,
  customPath?: string,
): Promise<{ configPath: string; created: boolean }> {
  // Determine config path
  let configPath = customPath;
  let existingConfig: Record<string, unknown> = {};
  let isNewFile = true;

  if (!configPath) {
    // Look for existing config file
    const searchPaths = getConfigSearchPaths();
    for (const searchPath of searchPaths) {
      if (await pathExists(searchPath)) {
        configPath = searchPath;
        isNewFile = false;
        break;
      }
    }

    // If no existing config, use default YAML path
    if (!configPath) {
      configPath = getDefaultYamlConfigPath();
    }
  } else {
    isNewFile = !(await pathExists(configPath));
  }

  // Load existing config if it exists
  if (!isNewFile) {
    try {
      const content = await readFile(configPath, "utf-8");
      const ext = extname(configPath).toLowerCase();

      if (ext === ".yaml" || ext === ".yml") {
        existingConfig =
          (yaml.load(content, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>) ?? {};
      } else {
        existingConfig = JSON.parse(content) as Record<string, unknown>;
      }
    } catch (err) {
      logWarn(`Could not parse existing config: ${(err as Error).message}`);
      existingConfig = {};
    }
  }

  // Add/update the filter
  const filters = (existingConfig["filters"] as Record<string, unknown>) ?? {};
  filters[filterName] = convertFilterToConfigFormat(filter);
  existingConfig["filters"] = filters;

  // Ensure parent directory exists
  await mkdir(dirname(configPath), { recursive: true });

  // Write config file
  const ext = extname(configPath).toLowerCase();
  let output: string;

  if (ext === ".yaml" || ext === ".yml") {
    output = yaml.dump(existingConfig, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      quotingType: '"',
    });
  } else {
    output = JSON.stringify(existingConfig, null, 2) + "\n";
  }

  await writeFile(configPath, output, "utf-8");
  clearConfigCache();

  return { configPath, created: isNewFile };
}

/**
 * Converts a SmartFilter to the config file format.
 * Removes the 'type' discriminator from rules since config format uses
 * presence of 'field' vs 'rules' to distinguish rule types.
 */
function convertFilterToConfigFormat(filter: SmartFilter): Record<string, unknown> {
  return {
    match: filter.match,
    rules: filter.rules.map(convertRuleToConfigFormat),
  };
}

/**
 * Converts a SmartFilterRule to config format.
 */
function convertRuleToConfigFormat(rule: SmartFilterRule): Record<string, unknown> {
  if (isFilterRule(rule)) {
    return {
      type: "rule",
      field: rule.field,
      operator: rule.operator,
      value: rule.value,
    };
  } else {
    return {
      type: "group",
      match: rule.match,
      rules: rule.rules.map(convertRuleToConfigFormat),
    };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Counts total rules in a filter (including nested groups).
 *
 * @param filter - Smart filter to count rules for
 * @returns Total rule count
 */
function countRules(filter: SmartFilter): number {
  let count = 0;

  function countRecursive(rules: SmartFilterRule[]): void {
    for (const rule of rules) {
      if (isFilterRule(rule)) {
        count++;
      } else if (isFilterGroup(rule)) {
        countRecursive(rule.rules);
      }
    }
  }

  countRecursive(filter.rules);
  return count;
}

/**
 * Counts leaf rules in a media filter rules array (including nested groups).
 */
function countMediaFilterRules(rules: MediaFilterNode[]): number {
  let count = 0;
  for (const rule of rules) {
    if (isMediaFilterRule(rule)) {
      count++;
    } else if (isMediaFilterGroup(rule)) {
      count += countMediaFilterRules(rule.rules);
    }
  }
  return count;
}

/**
 * Formats a filter's rule tree as a human-readable string.
 *
 * @param filter - Smart filter to format
 * @returns Formatted rule tree string
 */
function formatRuleTree(filter: SmartFilter): string {
  const lines: string[] = [];
  const matchLabel = filter.match === "all" ? "AND" : "OR";
  lines.push(
    `Match: ${matchLabel} (all rules must ${filter.match === "all" ? "pass" : "have at least one pass"})`,
  );
  lines.push("");
  lines.push("Rules:");

  formatRulesRecursive(filter.rules, lines, "  ", filter.match);

  return lines.join("\n");
}

/**
 * Recursively formats rules with proper indentation.
 *
 * @param rules - Array of rules to format
 * @param lines - Output lines array
 * @param indent - Current indentation string
 * @param parentMatch - Parent group's match type for context
 */
function formatRulesRecursive(
  rules: SmartFilterRule[],
  lines: string[],
  indent: string,
  parentMatch: FilterMatch,
): void {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule) continue;

    const isLast = i === rules.length - 1;
    const connector = isLast ? "└─" : "├─";
    const childIndent = indent + (isLast ? "  " : "│ ");

    if (isFilterRule(rule)) {
      const operatorLabel = getOperatorLabel(rule.operator);
      lines.push(`${indent}${connector} ${rule.field} ${operatorLabel} ${formatValue(rule.value)}`);
    } else if (isFilterGroup(rule)) {
      const groupLabel = rule.match === "all" ? "AND" : "OR";
      lines.push(`${indent}${connector} [${groupLabel} Group]`);
      formatRulesRecursive(rule.rules, lines, childIndent, rule.match);
    }
  }
}

/**
 * Gets a human-readable label for a filter operator.
 *
 * @param operator - Filter operator
 * @returns Human-readable operator label
 */
function getOperatorLabel(operator: string): string {
  switch (operator) {
    case ">=":
      return ">=";
    case "<=":
      return "<=";
    case "==":
      return "==";
    case "contains":
      return "contains";
    case "within":
      return "within";
    default:
      return operator;
  }
}

/**
 * Formats a filter value for display.
 *
 * @param value - Filter value (string or number)
 * @returns Formatted value string
 */
function formatValue(value: string | number): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }
  return String(value);
}
