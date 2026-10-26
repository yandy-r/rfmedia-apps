# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project Overview

rfapps-cli is a TypeScript CLI tool for Docker Compose orchestration that replaces the legacy
`manage.sh` bash script. It provides service lifecycle management (deploy, rebuild, stop, delete,
prune), Terraform-inspired plan/apply workflow, SQLite-based deployment history, rollback
capabilities, and automatic Tailscale sidecar linking.

## Tech Stack

- **Language**: TypeScript with ES2022 target
- **Module System**: ESM with NodeNext resolution (`.js` extensions required in imports)
- **Runtime**: Node.js >= 22.23.4
- **CLI Framework**: Commander.js v14
- **Key Dependencies**:
  - `better-sqlite3` - SQLite database for deployment state persistence
  - `listr2` - Progress display and task management
  - `ink` + `@inkjs/ui` - React-based interactive terminal UI for service selection
  - `yaml` - YAML configuration parsing
  - `picocolors` - Terminal colors
  - `@rfmedia/common` - Shared utilities (logging, progress, prompts)

## Project Structure

```
rfapps-cli/
├── src/
│   ├── cli.ts              # Main entry point, registers all commands
│   ├── commands/           # Command definitions (currently only init has dedicated file)
│   │   └── init.ts         # Init command definition
│   ├── actions/            # Command implementations (business logic)
│   │   ├── apply.ts        # Apply saved deployment plan
│   │   ├── build.ts        # Build containers (pull + build)
│   │   ├── completion.ts   # Shell completion script generation
│   │   ├── delete.ts       # Delete services (stop + remove + optional cleanup)
│   │   ├── deploy.ts       # Deploy services (pull + start + health check)
│   │   ├── drift.ts        # Drift detection and reconciliation
│   │   ├── history.ts      # Query deployment history
│   │   ├── init.ts         # Generate config from compose.yml
│   │   ├── plan.ts         # Generate deployment plan
│   │   ├── prune.ts        # Prune with smart image removal
│   │   ├── pull.ts         # Pull Docker images
│   │   ├── rebuild.ts      # Rebuild (stop + pull + build + start)
│   │   ├── rollback.ts     # Rollback to previous deployment
│   │   ├── status.ts       # Show service status
│   │   ├── stop.ts         # Stop services
│   │   └── validate.ts     # Validate config against compose.yml
│   ├── lib/                # Shared utilities
│   │   ├── config.ts       # Layered YAML config loading (project/home/XDG/local)
│   │   ├── db.ts           # SQLite database initialization
│   │   ├── docker.ts       # Docker Compose command execution
│   │   ├── drift.ts        # Drift detection logic
│   │   ├── env-tools.ts    # dotenvx/1Password secrets integration
│   │   ├── index.ts        # Re-exports all lib modules
│   │   ├── interactive-check.ts    # TTY/JSON mode detection
│   │   ├── interactive-loader.ts   # Dynamic Ink loader
│   │   ├── interactive-selection.ts # Service resolution with interactive fallback
│   │   ├── migrations.ts   # Database schema migrations
│   │   ├── plan-generator.ts # Generate deployment plans (diff current vs desired)
│   │   ├── plan-storage.ts # Save/load plans to JSON files
│   │   ├── schema.sql      # SQLite schema for deployments table
│   │   ├── service-status.ts # Container status parsing
│   │   ├── services.ts     # Sidecar linking, group expansion, profile detection
│   │   ├── state-queries.ts # Deployment history queries
│   │   ├── state-storage.ts # Record deployments to SQLite
│   │   └── validation.ts   # Config validation against compose.yml
│   └── types/              # TypeScript type definitions
│       ├── config.ts       # RfappsConfig, SidecarConfig, ProfileConfig
│       ├── drift.ts        # DriftResult, ServiceDrift
│       ├── index.ts        # Re-exports all types
│       ├── interactive.ts  # ServiceDisplayInfo, InteractiveSelectionResult
│       ├── options.ts      # GlobalOptions, DeployOptions, etc.
│       ├── plan.ts         # DeploymentPlan, ServiceChange, ChangeType
│       ├── results.ts      # StatusResult, DeployResult, etc.
│       └── state.ts        # StateEntry, HistoryOptions, RollbackOptions
├── dist/                   # Compiled output
└── README.md               # User documentation
```

## Development Commands

```bash
# Run in development (no build needed)
npm run dev -- <command> [options]
npm run dev -- status --all
npm run dev -- deploy -s traefik --dry-run

# Type checking only
npm run typecheck

# Build to dist/
npm run build

# Run tests
npm test              # Watch mode
npm run test:run      # Single run
npm run test:coverage # With coverage

# Clean build artifacts
npm run clean
```

## Architecture Patterns

### Command/Action Separation

Unlike rfmedia-cli, rfapps-cli defines most commands inline in `src/cli.ts` rather than separate
command files. Each command delegates to an action handler in `src/actions/` for implementation:

```typescript
// In cli.ts - command definition
program
  .command("deploy")
  .description("Deploy Docker services (pull + start)")
  .option("-s, --service <name>", "Target a specific service")
  // ...more options
  .action(async (options) => {
    const { executeDeploy } = await import("./actions/deploy.js");
    await executeDeploy(options, program.opts());
  });
```

Actions receive two parameter objects:

- `rawOptions` - Command-specific options from CLI
- `globalOptions` - Global options (dryRun, debug, json, yes, useDotenvx, useOp)

### Layered Configuration System

Configuration is loaded from multiple sources with priority (highest first):

1. `.rfapps.yaml` in current directory (project-specific overrides)
2. `~/.config/rfapps/config.yaml` (XDG config)
3. `~/.rfapps.yaml` (home directory)
4. `rfapps.config.yaml` in project root (required base config)
5. Environment variables (`RFAPPS_*`)

```typescript
// src/lib/config.ts
export async function loadConfig(cwd?: string): Promise<RfappsConfig> {
  // Loads and merges all config sources
  // Required fields: sidecars.mapping, groups, profiles.mapping, profiles.validProfiles
}

export function applyCliOverrides(
  config: RfappsConfig,
  overrides: { composePath?: string; envFile?: string; profile?: string; noSidecars?: boolean },
): RfappsConfig {
  // Apply CLI options over file config
}
```

### Plan/Apply Workflow Architecture

Terraform-inspired workflow for previewing and applying changes:

```typescript
// src/lib/plan-generator.ts
export async function generatePlan(
  options: PlanOptions,
  envTool?: EnvToolExecConfig,
): Promise<DeploymentPlan | undefined> {
  // 1. Get desired state from compose.yml
  // 2. Get current state from running containers
  // 3. Compare and generate ServiceChange[] with diffs
  // 4. Optionally check registry for image updates
}

// src/lib/plan-storage.ts
export function savePlan(plan: DeploymentPlan, composePath: string): string {
  // Save to .rfapps/plans/plan-{timestamp}.json with compose hash
}

export function loadPlan(planPath: string): { plan: DeploymentPlan; validation: PlanValidation } {
  // Load and validate against current compose.yml hash
}
```

Change types in plans: `create | update | recreate | delete | unchanged`

### State Persistence with SQLite

Deployment history is stored in SQLite for rollback capabilities:

```typescript
// src/lib/db.ts
export async function initializeDatabase(dbPath?: string): Promise<DbConnection> {
  // XDG-aware path resolution (~/.config/rfapps/state.db)
  // Creates tables and runs migrations
}

// src/lib/state-storage.ts
export function recordDeployments(db: DbConnection, entries: StateEntryInput[]): void {
  // Batch insert deployment records
}

// src/lib/state-queries.ts
export function queryHistory(db: DbConnection, options: HistoryOptions): StateEntry[] {
  // Filter by service, action, date range
}

export function findRollbackTarget(
  db: DbConnection,
  service: string,
  options: { steps?: number; toDeployment?: number },
): StateEntry | undefined {
  // Find previous successful deployment
}
```

### Sidecar Linking Mechanism

Automatic expansion of services with their Tailscale sidecars:

```typescript
// src/lib/services.ts
export function expandServicesWithSidecars(services: string[], config: RfappsConfig): string[] {
  // Bidirectional: plex -> [plex, plex-ts]
  // Also: plex-ts -> [plex-ts, plex]
}

export function getSidecarForService(service: string, config: RfappsConfig): string | undefined {
  // Lookup sidecar from config.sidecars.mapping
}

export function autoDetectProfiles(services: string[], config: RfappsConfig): Profile[] {
  // Auto-detect required profiles for targeted services
}
```

When sidecars are expanded, `--force-recreate` is auto-enabled to prevent stale network state.

### Interactive Service Selection Pattern

Multi-select UI appears when no service targeting flags are provided:

```typescript
// src/lib/interactive-selection.ts
export async function resolveServicesWithInteractive(
  rawOptions: ResolveOptions,
  config: RfappsConfig,
  composePath: string,
  projectDir: string,
  options?: { envTool?: EnvToolExecConfig },
): Promise<ResolveResult | null> {
  // 1. If -s, --services, or -g provided: expand and return
  // 2. If interactive environment: show Ink-based multi-select
  // 3. If non-interactive (non-TTY, JSON, --yes): return empty (all services)
}

// src/lib/interactive-check.ts
export function shouldShowInteractiveSelection(options: {
  service?: string;
  services?: string[];
  group?: string;
  yes?: boolean;
}): boolean {
  // Returns true only if: TTY && !JSON mode && no targeting flags && !--yes
}
```

The interactive UI is built with Ink (React for CLI) and supports:

- Status indicators (running/stopped/unhealthy)
- Type-ahead filtering
- Multi-select with spacebar
- Enter to confirm, Escape to cancel

### Tag Selector Architecture

`--tag` is a **narrowing axis** bolted onto the existing service-targeting pipeline; `rfapps tag` is its
read-only inspection surface. Nothing in the subsystem writes: it never writes `compose.yml`, never writes
the state database, never writes configuration, and never takes the global state lock.

```text
lib/command-options.ts addServiceTargetOptions   one --tag declaration, reused across 21 command paths
  -> lib/tags/tag-path.ts     normalizeTag / tagAncestors     grammar + ancestor closure
  -> lib/tags/tag-pattern.ts  parseTagTerm / serviceMatches   matcher: *, **, leading ! negation
  -> lib/tags/tag-index.ts    buildTagIndex / getTagIndex     config tags.mapping x compose universe
  -> lib/selector.ts          hasExplicitSelector / applyTagAxis   the one selector predicate
  -> lib/interactive-selection.ts resolveServicesWithInteractive   RESULT = BASE ∩ TAGS
  -> lib/errors.ts TagSelectorEmptyError -> ExitCode.UsageError

commands/tag.ts (list | show | suggest)          read-only; there is no set/add/remove in v1
  -> actions/tag.ts           list / show renderers
  -> actions/tag-suggest.ts   -> lib/tags/tag-inference.ts inferTags / renderTagFragment
                              -> lib/tags/tag-inference-rules.ts TAG_INFERENCE_RULES
lib/validation.ts validateTagReferences / validateTagLayerOwnership   warnings, never errors
```

Invariants:

- **P1 — backward compatibility is structural, not behavioural.** The tag axis is computed inside
  `if (rawOptions.tag !== undefined && rawOptions.tag.length > 0)`; `getTagIndex` and `parseComposeFile` must
  **never be reachable when `--tag` is absent**, and a spy test in `interactive-selection.spec.ts` (with its
  twin in `status.spec.ts`) proves it. This is a correction to design §7.4, which passed those calls as
  argument expressions and so evaluated them unconditionally: without the guard, one malformed
  `tags.mapping` entry would break `rfapps deploy -s plex` on all 20 resolver-backed paths, and every
  invocation would newly pay a YAML parse of every config layer. With `--tag` absent, `applyTagAxis` returns
  `{ kind: "absent" }` and the result is byte-for-byte today's — not "equivalent", unreachable;
- **P2 — the `services: []` sentinel is never reachable through the tag path.** A tag axis that narrows to
  nothing **throws `TagSelectorEmptyError`** (exit 2); it never returns `[]`. `[]` is an overloaded sentinel
  meaning "no explicit target — let Compose operate on the whole project" (callers do
  `services.length > 0 ? services : undefined`), so a glob that matched nothing and fell through would
  **silently target all 45 services** — including under `rfapps delete`. This is the single most important
  rule in the subsystem;
- **P3 — validation order.** `validateServiceNames` runs on `NAMES ∪ GROUPS` **before** the tag
  intersection. Reversed, `ServiceNotFoundError` becomes unreachable whenever `--tag` is present (the
  matched set is a subset of the compose universe, so a misspelling is filtered out first) and
  `deploy -s plexx --tag "media/**"` would report a misleading "tag matched nothing" instead of
  "did you mean plex?";
- **P4 — mapping staleness is diagnosed, not swallowed.** `buildTagIndex` records `unresolvedServices`
  (present in `tags.mapping`, absent from `compose.yml`). When those were a selector's only matches,
  `TagSelectorEmptyError` names them; `validateTagReferences` surfaces the same set as `ValidationWarning`s —
  **warning severity, never error**, so a stale entry can never fail an unrelated command;
- **P5 — ordering is preserved.** No `--tag` ⟹ today's insertion order; with `--tag` ⟹ `BASE`'s order, or
  compose declaration order when the base is the whole universe. Output stays stable and diffable;
- **P6 — a tag-derived selection is indistinguishable downstream.** The narrowed list lands in `services`
  **before** `preSidecarCount` is taken, so sidecar expansion, deploy's auto `--force-recreate`, and
  `autoDetectProfiles` all behave exactly as they do for `-s`/`-g`;
- **never create the MCP `tag` key.** The MCP adapters build raw CLI option objects literally and **must
  never create a `tag` key — not even set to `undefined`.** The rule is "never create the key", not "never
  populate it": `schemaObject` is `additionalProperties: false` and its strict-key check iterates
  `Object.keys(input)`, so `{ tag: undefined }` throws `Unexpected properties at $: tag` at MCP runtime while
  typechecking clean. Additionally there is **no config-level default tag filter** — `--tag` is always
  explicit CLI input, so an MCP `rfapps.plan` / `rfapps.deploy` call can never be silently narrowed, the
  exact hazard already recorded for `ScanConfig` in `CLAUDE.md`;
- **no state lock, and read-only in v1.** `rfapps tag list/show/suggest` take no lock because they mutate
  nothing; `tag suggest --out` writes a _new_ fragment with `flag: "wx"` and refuses an existing path, and
  never edits a config file. `tag set/add/remove` does not exist — the config writer is deferred to #328;
- **the Commander `--tag` collector never throws.** It only accumulates
  (`(value, previous) => [...(previous ?? []), value]`); pattern validation happens later, in the action.
  Throwing inside an `argParser` calls `process.exit(1)` before `.action()` runs, which would bypass the
  error formatters and print a bare Commander message instead of the fuzzy tag suggestion;
- **trailing `/*` is rejected at parse time.** Under ancestor closure `X/*` would mean "the X subtree,
  _excluding_ services whose only X-tag is the depth-1 `X`" — a strict subset of `X` with a non-obvious
  exclusion rule. Issue #63's literal `--tag "infrastructure/*"` therefore errors with a corrective
  suggestion to write `--tag infrastructure`. Interior `*` (`*/core/**`, `media/*/tv`) stays supported;
- **`tags:` layering replaces, it does not merge.** A `tags:` block in a higher-precedence config layer
  wholly shadows the base taxonomy; `validateTagLayerOwnership` warns when more than one layer declares it.

Tag mutation, compose-label or state-DB storage, MCP surfacing, tag-aware interactive selection, and
partial-segment wildcards (`net*`, `?`) are deliberately outside v1. See
`docs/features/rfapps-tag-selector.md` for the operator contract.

## Key Type Definitions

### GlobalOptions

```typescript
interface GlobalOptions {
  dryRun: boolean; // Preview actions without executing
  debug: boolean; // Enable debug output
  json: boolean; // Output in JSON format
  verbose: boolean; // Show detailed output
  yes: boolean; // Skip confirmation prompts
  useDotenvx?: string; // Path to env file for dotenvx secrets
  useOp?: string; // Path to env file for 1Password CLI secrets
}
```

### RfappsConfig

```typescript
interface RfappsConfig {
  composePath: string; // Path to compose.yml
  envFile: string; // Path to environment file
  sidecars: {
    mapping: Record<string, string>; // service -> sidecar mapping
    enabled: boolean; // Auto-link sidecars
  };
  groups: Record<string, string[]>; // Group name -> service list
  profiles: {
    mapping: Record<string, Profile>; // service -> profile mapping
    defaultProfile: Profile; // Default profile (usually 'all')
    validProfiles: Profile[]; // Valid profile names
  };
  healthCheck: { timeout: number; interval: number; retries: number };
  envTool: { tool: EnvTool; dotenvxPath?: string; opOptions?: object };
  docker: { context?: string; sshRetry?: { maxRetries: number; delayMs: number } };
  interactive: { pageSize: number };
  state: { dbPath?: string; enabled?: boolean };
}
```

### ServiceChange (Plan)

```typescript
interface ServiceChange {
  service: string;
  changeType: "create" | "update" | "recreate" | "delete" | "unchanged";
  image: ImageDiff; // current vs desired with updateAvailable
  environment: EnvChange[]; // Added/removed/modified vars (secrets masked)
  ports: ConfigDiff<PortMapping[]>;
  volumes: ConfigDiff<VolumeMapping[]>;
  networks: ConfigDiff<string[]>;
}
```

### StateEntry

```typescript
interface StateEntry {
  id: number;
  timestamp: string; // ISO 8601
  service: string;
  action: "deploy" | "rebuild" | "delete" | "rollback" | "apply" | "prune";
  imageTag?: string;
  configSnapshot?: string; // JSON of service config
  status: "success" | "failed" | "rolled_back";
  planId?: string; // Reference to applied plan
  errorMessage?: string;
}
```

## GitHub Contribution Templates

When creating GitHub issues or pull requests, all coding agents must follow repository templates
exactly.

### Issue Templates (Required)

- Always use GitHub issue forms from `.github/ISSUE_TEMPLATE/`; do not open blank issues.
- Choose the correct form:
  - Enhancement: `.github/ISSUE_TEMPLATE/enhancement.yml`
  - Bug: `.github/ISSUE_TEMPLATE/bug.yml`
  - Question: `.github/ISSUE_TEMPLATE/question.yml`
  - Documentation: `.github/ISSUE_TEMPLATE/docs.yml`
  - Chore: `.github/ISSUE_TEMPLATE/chore.yml`
  - Security hardening (public-safe only): `.github/ISSUE_TEMPLATE/security.yml`
- For exploitable vulnerabilities or sensitive security details, do not use public issues; use
  private reporting from `.github/ISSUE_TEMPLATE/config.yml` (`Private Security Report` link).

### Pull Request Template (Required)

- Always use `.github/pull_request_template.md` as the PR body baseline.
- Preserve required sections:
  - `## Summary`
  - `## Changes`
  - `## Testing`
  - `## Related Issues` (use `Closes #<issue-number>` when applicable)
  - `## Breaking Changes`
  - `## Risk and Rollback`
  - `## Checklist`
- Include exact verification commands and pass/fail outcomes in `## Testing`.

### Agent Markdown Mirrors

- For offline drafting, automation, or agent-generated artifacts, use markdown mirrors in
  `docs/templates/github/`.
- Mirror files are drafting aids only; GitHub issue forms and PR template remain the source of truth
  for final submissions.

## Code Quality Standards

### Type Safety Requirements

- **NEVER use `any` type** - look up proper types from libraries or define interfaces
- Use proper generics for utility functions
- Discriminated unions for mode-specific types where applicable

### Error Handling

- **Throw errors early**, don't use fallbacks during development
- Use `logError()` for user-facing errors, `logDebug()` for internal details
- Set `process.exitCode = 1` for failures (don't call `process.exit()` directly)
- Collect errors in `failed` arrays for JSON output

### Import Conventions

ESM requires explicit `.js` extensions:

```typescript
// Correct
import { loadConfig } from "./lib/config.js";
import type { RfappsConfig } from "../types/config.js";

// Incorrect
import { loadConfig } from "./lib/config";
```

### Logging Conventions

All log output goes to stderr to keep stdout clean for JSON output:

```typescript
import { logInfo, logSuccess, logWarn, logError, logDebug, outputJson } from "@rfmedia/common";

// Use for different scenarios
logInfo("Starting deployment...");       // Blue informational
logSuccess("Deployment complete");        // Green success
logWarn("Service not in config");         // Yellow warning
logError("Deploy failed: timeout");       // Red error
logDebug("Compose path: /path/to/file"); // Only when debug mode

// JSON output (only when --json flag)
if (options.json) {
  outputJson({ services: [...], failed: [...] });
}
```

## Testing Patterns

Tests use Vitest and are co-located with source files in `src/lib/`:

```bash
npm test                    # Watch mode
npm run test:run            # Single run
npm run test:coverage       # Coverage report
```

### Key Test Files

| File                            | Tests              | Coverage Area                        |
| ------------------------------- | ------------------ | ------------------------------------ |
| `interactive-check.spec.ts`     | TTY detection      | shouldShowInteractiveSelection logic |
| `interactive-selection.spec.ts` | Service resolution | Flag handling, sidecar expansion     |
| `drift.spec.ts`                 | Drift detection    | Container vs compose comparison      |

### Mock Setup Pattern

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock modules
vi.mock("@rfmedia/common", () => ({
  isJsonMode: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

describe("Feature", () => {
  beforeEach(() => {
    vi.clearAllMocks(); // NOT resetAllMocks - preserves implementations
  });

  afterEach(() => {
    // Clean up any global state
  });

  it("should handle the case", () => {
    vi.mocked(common.isJsonMode).mockReturnValue(false);
    // ... test
  });
});
```

### Testing Process Properties

For TTY-related tests, use `Object.defineProperty`:

```typescript
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: originalIsTTY,
    writable: true,
    configurable: true,
  });
});

it("should detect TTY environment", () => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    writable: true,
    configurable: true,
  });
  expect(isInteractiveEnvironment()).toBe(true);
});
```

## Common Tasks

### Adding a New Command

1. Add command definition in `src/cli.ts`:

```typescript
program
  .command("newcmd")
  .description("Description of new command")
  .option("-s, --service <name>", "Target a specific service")
  // ... add options
  .action(async (options) => {
    const { executeNewCmd } = await import("./actions/newcmd.js");
    await executeNewCmd(options, program.opts());
  });
```

2. Create action implementation in `src/actions/newcmd.ts`:

```typescript
import { logInfo, logSuccess, logError, outputJson, confirm } from "@rfmedia/common";
import type { GlobalOptions } from "../types/index.js";
import { loadConfig, applyCliOverrides, resolveServicesWithInteractive } from "../lib/index.js";

interface RawNewCmdOptions {
  service?: string;
  services?: string;
  group?: string;
  sidecars?: boolean;
  // ... command-specific options
}

export async function executeNewCmd(
  rawOptions: RawNewCmdOptions,
  globalOptions: { dryRun?: boolean; debug?: boolean; json?: boolean; yes?: boolean /* ... */ },
): Promise<void> {
  // 1. Load and merge config
  const config = await loadConfig();
  const finalConfig = applyCliOverrides(config, {
    /* overrides */
  });

  // 2. Resolve services with interactive selection
  const resolved = await resolveServicesWithInteractive(/* ... */);
  if (resolved === null) return; // User cancelled

  // 3. Handle dry-run mode
  if (globalOptions.dryRun) {
    logInfo(`[DRY RUN] Would execute newcmd on ${resolved.services.join(", ")}`);
    return;
  }

  // 4. Confirmation if not --yes
  if (!globalOptions.yes && !globalOptions.json) {
    const confirmed = await confirm("Proceed?");
    if (!confirmed) return;
  }

  // 5. Execute the command
  // ...

  // 6. Output JSON if requested
  if (globalOptions.json) {
    outputJson({
      /* result */
    });
  }
}
```

3. Add types to `src/types/options.ts` (if needed) and `src/types/results.ts`
4. Export from `src/types/index.ts`
5. Update README.md with usage documentation

### Adding New Configuration Options

1. Add type to `src/types/config.ts`:

```typescript
export interface RfappsConfig {
  // ... existing fields
  newSection: {
    option1: string;
    option2?: number;
  };
}
```

2. Add partial type for merging:

```typescript
export type PartialRfappsConfig = Partial<{
  // ... existing fields
  newSection: Partial<{ option1: string; option2: number }>;
}>;
```

3. Update `mergeConfig()` in `src/lib/config.ts`:

```typescript
function mergeConfig(base: RfappsConfig, override: PartialRfappsConfig): RfappsConfig {
  return {
    // ... existing merges
    newSection: {
      option1: override.newSection?.option1 ?? base.newSection.option1,
      option2: override.newSection?.option2 ?? base.newSection.option2,
    },
  };
}
```

4. Update `partialToFull()` with defaults:

```typescript
return {
  // ... existing defaults
  newSection: {
    option1: partial.newSection?.option1 ?? "default-value",
    option2: partial.newSection?.option2 ?? 10,
  },
};
```

5. Add environment variable support in `loadConfigFromEnv()` if applicable

### Adding a New Service Group

Edit `rfapps.config.yaml` in project root:

```yaml
groups:
  # ... existing groups
  new-stack:
    - service1
    - service2
    - service3
```

### Modifying the Database Schema

1. Update `src/lib/schema.sql` with new schema
2. Add migration in `src/lib/migrations.ts`:

```typescript
const MIGRATIONS: Migration[] = [
  // ... existing migrations
  {
    version: 2,
    description: "Add new_column to deployments",
    up: (db: DbConnection) => {
      db.exec(`ALTER TABLE deployments ADD COLUMN new_column TEXT`);
    },
  },
];
```

3. Update `StateEntry` type in `src/types/state.ts`
4. Update `StateEntryRow` for raw database row mapping
