# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project Overview

rfapps-cli is a TypeScript CLI tool for Docker Compose orchestration that replaces the legacy
`manage.sh` bash script. It provides service lifecycle management (deploy, rebuild, stop, delete,
prune), Terraform-inspired plan/apply workflow, SQLite-based deployment history, rollback
capabilities, verified managed image updates, native cold filesystem backup, and automatic
Tailscale sidecar linking.

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
│   ├── commands/           # Dedicated command definitions
│   │   ├── backup.ts       # Native backup creation and nested offline verify command
│   │   ├── harden.ts       # Compose security hardening command definition
│   │   ├── init.ts         # Init command definition
│   │   ├── state.ts        # State database inspect/export/rebuild command group
│   │   └── update.ts       # Managed image-update command definition
│   ├── actions/            # Command implementations (business logic)
│   │   ├── apply.ts        # Apply saved deployment plan
│   │   ├── backup.ts       # Resolve, authorize, and run cold backup creation
│   │   ├── backup-verify.ts # Format lock-free offline verification
│   │   ├── build.ts        # Build containers (pull + build)
│   │   ├── completion.ts   # Shell completion script generation
│   │   ├── delete.ts       # Delete services (stop + remove + optional cleanup)
│   │   ├── deploy.ts       # Deploy services (pull + start + health check)
│   │   ├── drift.ts        # Drift detection and reconciliation
│   │   ├── harden.ts       # Propose, emit, or apply compose hardening
│   │   ├── history.ts      # Query deployment history
│   │   ├── init.ts         # Generate config from compose.yml
│   │   ├── plan.ts         # Generate deployment plan
│   │   ├── prune.ts        # Prune with smart image removal
│   │   ├── pull.ts         # Pull Docker images
│   │   ├── rebuild.ts      # Rebuild (stop + pull + build + start)
│   │   ├── rollback.ts     # Rollback to previous deployment
│   │   ├── state-export.ts # Export a consistent copy of the state database
│   │   ├── state-rebuild-report.ts # Text renderer for the rebuild report
│   │   ├── state-rebuild.ts # Reconstruct the state database from Docker runtime
│   │   ├── status.ts       # Show service status
│   │   ├── stop.ts         # Stop services
│   │   ├── update.ts       # Preview/apply managed image updates
│   │   └── validate.ts     # Validate config against compose.yml
│   ├── lib/                # Shared utilities
│   │   ├── backup-coordinator.ts # Locked stop/archive/recovery lifecycle
│   │   ├── backup-docker.ts # Pinned helper probing and binary archive streaming
│   │   ├── backup-planner.ts # Canonical source, consumer, and writer planning
│   │   ├── backup-schema.ts # Strict manifest runtime validation
│   │   ├── backup-storage.ts # Private no-clobber bundle publication
│   │   ├── backup-verify.ts # Offline size/SHA-256 verification
│   │   ├── config.ts       # Layered YAML config loading (project/home/XDG/local)
│   │   ├── db.ts           # SQLite database initialization
│   │   ├── docker.ts       # Docker Compose command execution
│   │   ├── drift.ts        # Drift detection logic
│   │   ├── env-tools.ts    # dotenvx/1Password secrets integration
│   │   ├── error-formatters.ts     # Error formatter registration
│   │   ├── errors.ts       # Custom error classes
│   │   ├── fuzzy-match.ts  # Levenshtein fuzzy matching for suggestions
│   │   ├── generations.ts  # Immutable generation snapshots (Nix-style)
│   │   ├── index.ts        # Re-exports all lib modules
│   │   ├── interactive-check.ts    # TTY/JSON mode detection
│   │   ├── interactive-loader.ts   # Dynamic Ink loader
│   │   ├── interactive-selection.ts # Service resolution with interactive fallback
│   │   ├── managed-update.ts # Locked sequential image-update coordinator
│   │   ├── migrations.ts   # Database schema migrations
│   │   ├── plan-generator.ts # Generate deployment plans (diff current vs desired)
│   │   ├── plan-storage.ts # Save/load plans to JSON files
│   │   ├── runtime-baseline.ts # Shared container->state-row observation engine
│   │   ├── schema.sql      # SQLite schema for deployments and generations tables
│   │   ├── service-status.ts # Container status parsing
│   │   ├── services.ts     # Sidecar linking, group expansion, profile detection
│   │   ├── state-queries.ts # Deployment history queries
│   │   ├── state-rebuild-files.ts # Backup/swap/path primitives (re-exported by state-rebuild.ts)
│   │   ├── state-rebuild.ts # SQLite probe/carry-over primitives
│   │   ├── state-storage.ts # Record deployments to SQLite
│   │   └── validation.ts   # Config validation against compose.yml
│   └── types/              # TypeScript type definitions
│       ├── backup.ts       # Manifest, create result, and verify result contracts
│       ├── config.ts       # RfappsConfig, SidecarConfig, ProfileConfig
│       ├── drift.ts        # DriftResult, ServiceDrift
│       ├── index.ts        # Re-exports all types
│       ├── interactive.ts  # ServiceDisplayInfo, InteractiveSelectionResult
│       ├── options.ts      # GlobalOptions, DeployOptions, etc.
│       ├── plan.ts         # DeploymentPlan, ServiceChange, ChangeType
│       ├── results.ts      # StatusResult, DeployResult, etc.
│       ├── state-rebuild.ts # StateRebuildResult, StateDatabaseProbe, CarryOverCounts
│       ├── state.ts        # StateEntry, HistoryOptions, RollbackOptions
│       └── update.ts       # ManagedUpdatePlan and ManagedUpdateResult contracts
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

Unlike rfmedia-cli, rfapps-cli defines most commands inline in `src/cli.ts`; commands with larger
option contracts, including `backup`, `init`, and `update`, use dedicated modules in
`src/commands/`. Each command delegates to an action handler in `src/actions/` for implementation:

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

### Managed Update Architecture

Managed update is separate from ordinary deployment `apply`. Its plan uses
`schemaVersion: "update-plan.v1"` and `intent: "managed-update"`; generic `rfapps apply` rejects that
intent and directs operators back to `rfapps update --from-plan <path> --apply`.

```text
commands/update.ts
  -> actions/update.ts
  config + frozen scope + preview + approval + DB/signal lifetime + output
  -> lib/managed-update.ts
  lock -> revalidate -> snapshot -> pull reviewed digest -> targeted recreate
  -> verify -> record
  \-> exact local-image-ID restore -> verify restore -> record
  -> plan generator/storage, Docker, health, state, and generations
```

The command only registers and validates options. The action owns interaction, secure artifact
persistence, formatting, exit mapping, and cleanup. The coordinator returns typed data, never
prompts or prints, and never sets `process.exitCode`.

Mutation is CLI-only, sequential, image-only, and protected by a project/Docker-context lock across
revalidation through terminal verification or restore. Before each service changes, the coordinator
revalidates reviewed identities and records the exact current daemon-local image ID. It pulls the
reviewed repository digest, recreates only the target with `--pull never` and no orphan cleanup, then
verifies image identity, target readiness, and dependencies. A post-mutation failure restores that
exact local image ID when enabled; it does not restore Compose configuration, volumes, databases,
application data, or migrations.

`ManagedUpdateDependencies` exposes plan, Docker, health, state, lock, signal, filesystem, and clock
boundaries for focused tests and future compatible implementations. These seams do not authorize an
MCP mutation endpoint, background scheduler, parallel service mutation, or data rollback.

### Native Backup Architecture

Native backup is a cold filesystem workflow with an offline verifier:

```text
commands/backup.ts
  -> actions/backup.ts
  config + explicit scope + preview + approval + output
  -> lib/backup-planner.ts
  canonical Compose sources + full-project consumers/writers + probe-backed plan
  -> lib/backup-coordinator.ts
  reserve -> pinned helper -> lifecycle lock -> exact revalidation -> stop/re-observe -> archive
  -> exact-container recovery -> manifest-last publication

commands/backup.ts verify
  -> actions/backup-verify.ts
  -> lib/backup-verify.ts + backup-schema.ts + backup-storage.ts
  no config, Docker, lock, stop, or extraction
```

The public contracts live in `types/backup.ts`: `rfapps-backup.v1` for manifests,
`rfapps-backup-result.v1` for creation, and `rfapps-backup-verify-result.v1` for verification.
Creation holds the root mutation lock and project/Docker-authority lifecycle lock across
revalidation, writer stop, archive, and recovery. Dry-run and verification hold neither.

Security invariants:

- source discovery uses canonical resolved Compose evidence; remote bind existence/type is probed
  through the Docker authority rather than client-local filesystem calls;
- the source-controlled digest-pinned helper is resolved to an immutable daemon-local image ID and
  runs with no network, read-only root/source mounts, dropped capabilities, and
  `no-new-privileges`;
- archive bytes use the binary streaming spawn boundary in `backup-docker.ts`, never bounded UTF-8
  `execDocker()` and never `sh -c`;
- bundle paths are private, no-follow, no-clobber, and manifest-last; SHA-256 proves byte integrity,
  not authenticity, encryption, or signing;
- exact captured container IDs are recovered in a `finally` boundary after any stop attempt.

Automated restore, database-native consistency, scheduling, retention, upload, encryption, and
signing are deliberately outside v1. See `docs/features/rfapps-backup.md` for the operator contract.

### Image Vulnerability Scanning Architecture

Scanning is an opt-in read-only pre-flight bolted onto `plan` and `deploy`; there is no `rfapps scan`
command:

```text
cli.ts (plan --scan | deploy --scan)
  -> actions/plan.ts | actions/deploy.ts
  resolveScanSettings (CLI ?? scan: config ?? hard default)
  -> lib/docker.ts getComposeConfig            resolved image refs, build: exclusion for free
  -> lib/security-scan.ts resolveScanTargets   build-only / no-image / duplicate-image / target-cap
  -> lib/security-scan.ts runSecurityScan      bounded worker pool -> trivy|grype -> normalize
  -> evaluateScanGate -> ScanReport.gate.blocking
  -> lib/exit-codes.ts setScanExitCode
```

Invariants:

- the report attaches to the action's **output envelope** (`{ planPath, plan, scan }` and
  `DeployResult.scan`), never to `DeploymentPlan`. `savePlan` JSON-stringifies the whole plan, so an
  embedded CVE verdict would decay and `rfapps apply <path>` days later would re-assert it as
  authoritative;
- scan targets come from `getComposeConfig`, never from the generated plan;
- the gate is fail-closed: `scanner-unavailable`, `timeout`, `output-limit`, `scanner-error`, and
  `invalid-report` all resolve to `inconclusive`, which blocks whenever `--scan-fail-on` is not
  `none`. The hard default is `none` (advisory) — asking to scan is not asking to gate;
- `gate.blocking` is computed once by `evaluateScanGate`; no caller re-derives it;
- deploy evaluates the gate before `pullImages` and `startServices`, so a blocked deploy mutates
  nothing and pushes a `failed[]` entry rather than throwing;
- `scan`, `scanner`, and `scanFailOn` are deliberately absent from `planInputSchema` and
  `deployInputSchema` and are not forwarded by `invokeDeploy` (`src/mcp/adapters.ts:276-303`) or
  `invokePlan` (`:402-428`). **The invariant is "never create the key", not "never populate it":**
  `schemaObject` is `additionalProperties: false` and its strict-key check iterates
  `Object.keys(input)`, so `{ scan: undefined }` throws `Unexpected properties at $: scan` at MCP
  runtime while typechecking clean, and the MCP path hands the raw object to `outputSchema.parse`
  without a JSON round trip. Assign `result.scan` only inside `if (options.scan)`, and keep plan's
  conditional spread;
- if a future change surfaces these flags over MCP, `scanReportSchema` must be mirrored into
  `planResultSchema` (`src/mcp/schema.ts:522`) and `deployResultSchema` (`:297`) in the same commit.
  For the same reason `ScanConfig` must never gain an `enabled`/`always` key without that mirror —
  config alone would then turn scanning on for every `rfapps.plan` / `rfapps.deploy` MCP call.

Digest pinning of scan targets, SBOM/SARIF export, an on-disk finding cache, and `docker scout` /
`snyk` backends are deliberately outside v1. See
`docs/features/rfapps-vulnerability-scanning.md` for the operator contract.

### Compose Hardening Architecture

`rfapps harden` is the remediation counterpart to `lint` and `audit`, with a propose-first mutation
envelope modelled on `drift import`:

```text
commands/harden.ts (validateHardenOptions, also called from cli.ts preAction)
  -> actions/harden.ts
  config + scope + mode derivation + confirmation + backup + output
  -> lib/docker.ts getComposeConfig         resolved services -> detection input
  -> lib/hardening.ts evaluateHardening     HARDEN_RULES -> proposals, suppressions
  -> lib/hardening.ts filterWritableProposals / applyHardenPatches / buildHardenOverride
  -> lib/exit-codes.ts setHardenExitCode
```

Invariants:

- detection reads the **resolved** compose config; writes go through `parseDocument(source)` on the
  **raw** compose file, so anchors, aliases, and `x-` extension fields survive;
- **no patch may target a YAML alias.** `applyHardenPatches` refuses with
  `HardenRefusal{ code: "alias-target" }` and names `--out` instead; editing a key like
  `logging: *logging-default` would silently reconfigure every service sharing the anchor;
- **no patch may use a nested path.** `HardenPatch.key` is a single top-level key under
  `services.<name>`; a nested encoding is refused as `nested-path` and a rule that genuinely needs
  one must be `advisory` instead;
- sequence-valued patches use `merge-unique`, never `set`, so `--apply` twice is a no-op and an
  existing `security_opt`/`cap_drop` entry is never dropped — a hardening tool that weakens security
  is the bug class this prevents. Override fragments emit the full union because a Compose override
  replaces sequences rather than appending to them;
- `HARDEN_RULES` is a separate catalog. `LINT_RULES` is not extended, shipped `rfapps lint` output is
  unchanged, and `harden-*` ids never collide with `LintRuleId` or `AuditRuleId`. Consequently
  `harden` cannot reuse `lint.ignore` and has its own `harden:` config section;
- serialization is fixed at `{ lineWidth: 0, flowCollectionPadding: false }` in
  `serializeComposeDocument`, the only serializer. `detectReformat` runs in every mode and `--apply`
  refuses unacknowledged churn rather than silently reflowing untargeted lines;
- refusals are reported and non-fatal: detection stands, only the automated write is withheld, and an
  alternative is always named. A partial apply exits `3`;
- `harden` is not MCP-surfaced (neither are `lint`, `audit`, or `doctor`), and `harden --apply` takes
  the global state lock because it writes the same `compose.yml` as `drift import`.

Synthesised healthcheck probes, memory ceilings, and CPU ceilings; automated removal of
`privileged: true`; a unified-diff patch format; and user-defined rules are deliberately outside v1.
See `docs/features/rfapps-harden-command.md` for the operator contract.

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
  exact hazard recorded above for `ScanConfig`;
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

// src/lib/generations.ts (Nix-style immutable generation snapshots)
// recordDeployment/recordDeployments automatically append a generation for
// every successful deploy-like action (deploy, rebuild, apply, rollback, update, import).
export function getGenerations(db: DbConnection, options: GenerationsOptions): GenerationEntry[];
export function findGenerationByNumber(db, service, generation): GenerationEntry | undefined;
export function findGenerationAtTime(db, service, isoTime): GenerationEntry | undefined;
```

Restore UX: `rfapps history --generations` lists snapshots; `rfapps rollback --to-generation N` and
`--to-time TIMESTAMP` restore them (image only — volumes and databases are never rolled back).

### State Database Invariant

The state database is **derived and re-derivable**: its contents can be reconstructed from Docker
runtime and compose declarations, so recovery is always preferable to trusting a damaged file. Never
open a suspect database through `initializeDatabase()` — it opens read-write, `exec()`s `schema.sql`,
and runs migrations, so a corrupt file throws `SQLITE_NOTADB` before any recovery code can run.
Diagnose and back up through a read-only handle
(`new Database(path, { readonly: true, fileMustExist: true })`), and repair by constructing a complete
replacement at a sibling temp path via `initializeDatabase(tempPath)` and `rename()`-ing it into
place, so every failure before the swap is indistinguishable from "nothing happened". See
`src/lib/state-rebuild.ts` and `docs/features/rfapps-state-rebuild.md`.

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

### ManagedUpdatePlan

```typescript
interface ManagedUpdatePlan {
  schemaVersion: "update-plan.v1";
  intent: "managed-update";
  dockerContextFingerprint: string;
  targetServices: string[];
  applyPolicy: "sequential";
  restorePolicy: "restore-on-failure" | "no-restore-on-failure";
  services: ManagedUpdatePlanService[]; // Reviewed IDs, digests, platform, and status
}
```

### StateEntry

```typescript
interface StateEntry {
  id: number;
  timestamp: string; // ISO 8601
  service: string;
  action: "deploy" | "rebuild" | "delete" | "rollback" | "apply" | "prune" | "update" | "import";
  imageTag?: string;
  imageId?: string; // Immutable daemon-local identity
  imageDigest?: string; // Canonical repository digest
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

- **Throw errors early** using custom error classes from `src/lib/errors.ts`
- Library-level validation errors (service/group/config not found) **throw** and propagate to
  `handleCliError()`
- Action-level Docker failures use **local formatting** (`formatError` + `outputFormattedError`) to
  preserve cleanup and multi-service loops
- Collect Docker errors in `failed` arrays for structured (JSON/YAML/CSV) output
- See [Error Handling System](#error-handling-system) below for full details

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

| File                             | Tests              | Coverage Area                        |
| -------------------------------- | ------------------ | ------------------------------------ |
| `interactive-check.spec.ts`      | TTY detection      | shouldShowInteractiveSelection logic |
| `interactive-selection.spec.ts`  | Service resolution | Flag handling, sidecar expansion     |
| `cli.backup.integration.spec.ts` | Spawned CLI backup | Locks, helper probes, output, verify |
| `drift.spec.ts`                  | Drift detection    | Container vs compose comparison      |

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

## Error Handling System

rfapps-cli uses a structured error handling system built on the `@rfmedia/common` error formatting
pipeline (`registerErrorFormatter` -> `formatError` -> `handleCliError`). Errors are represented as
custom error classes with context-rich fields and formatted through registered formatters that
produce user-friendly messages with actionable suggestions.

### Error Classes

All custom error classes are defined in `src/lib/errors.ts`. They follow the `SecretsInjectionError`
pattern from `@rfmedia/common`: extend `Error`, call `super(message)`, set `this.name` as a string
literal, and store context as `readonly` fields. Error classes are dependency-free -- they do NOT
import from actions, lib, or external packages.

| Class                      | Properties                                             | Thrown From                                            |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| `ServiceNotFoundError`     | `serviceName`, `availableServices`, `suggestion?`      | `interactive-selection.ts`, `validation.ts`            |
| `GroupNotFoundError`       | `groupName`, `availableGroups`, `suggestion?`          | `interactive-selection.ts`                             |
| `ProfileNotFoundError`     | `profileName`, `validProfiles`, `suggestion?`          | `cli.ts` preAction hook                                |
| `ConfigNotFoundError`      | `searchedPaths`                                        | `config.ts`, `cli.ts` preAction hook                   |
| `ConfigValidationError`    | `field`, `configSource`, `reason`                      | `config.ts`, `validation.ts`, `init.ts`                |
| `DockerCommandError`       | `operation`, `stderr`, `exitCode`, `services`, `isSSH` | Action files (local formatting)                        |
| `ImagePullError`           | `services`, `stderr`                                   | Action files (local formatting)                        |
| `ServiceStartError`        | `services`, `stderr`                                   | Action files (local formatting)                        |
| `DeploymentNotFoundError`  | `deploymentId`, `service`                              | `rollback.ts`                                          |
| `InsufficientHistoryError` | `service`, `requestedSteps`, `availableSteps`          | `rollback.ts`                                          |
| `PlanValidationError`      | `planPath`, `reason`                                   | `apply.ts`                                             |
| `InvalidArgumentError`     | `argument`, `value`, `reason`, `validValues?`          | `cli.ts` preAction hook, `history.ts`, `completion.ts` |

Lookup errors (`ServiceNotFoundError`, `GroupNotFoundError`, `ProfileNotFoundError`) carry an
optional `suggestion` field populated by fuzzy matching at the throw site.

### Error Formatters

`src/lib/error-formatters.ts` exports `registerRfappsErrorFormatters()`, which registers one
formatter per error class with the `@rfmedia/common` formatter registry. Each formatter defines:

- `canHandle(error)` -- `instanceof` type guard
- `formatMessage(error)` -- Human-readable error message
- `getSuggestions(error)` -- Array of actionable suggestions (always ends with
  `"Run with --debug for more details"`)
- `exitCode` -- Process exit code (always `1`)

Formatters are registered in order from most specific to most generic. Registration happens once at
CLI startup in `src/cli.ts`, called at module level after `initLogger()` but before the Commander
program setup:

```typescript
// src/cli.ts - top of file
import { handleCliError } from "@rfmedia/common";
import { registerRfappsErrorFormatters } from "./lib/error-formatters.js";

initLogger({ debugMode: false });
registerRfappsErrorFormatters();
// ... Commander program setup follows
```

For lookup errors, formatters check `error.suggestion` first (set at the throw site). If not set,
they call `findClosestMatch()` as a fallback to generate "Did you mean '...'?" suggestions.

### Error Propagation Strategy

rfapps-cli uses a **hybrid approach** to error propagation:

**Library errors throw (propagate to `handleCliError()`)**:

Validation and lookup errors in library code (`config.ts`, `validation.ts`,
`interactive-selection.ts`) and the CLI preAction hook throw custom error classes. These propagate
through Commander.js to the `main()` catch block where `handleCliError()` formats and outputs them:

```typescript
// In lib/interactive-selection.ts
const suggestion = findClosestMatch(groupName, availableGroups);
throw new GroupNotFoundError(groupName, availableGroups, suggestion);

// In cli.ts main() catch block
try {
  await program.parseAsync(process.argv);
} catch (error) {
  handleCliError(error);
}
```

**Action Docker errors use local formatting**:

Actions that execute Docker operations (deploy, rebuild, rollback, etc.) process multiple services
in loops. If one service fails, the loop must continue processing others. These actions use local
formatting instead of throwing:

```typescript
// In actions/deploy.ts
import { formatError, outputFormattedError } from "@rfmedia/common";

const error = new ImagePullError(services, stderr);
const formatted = formatError(error);
outputFormattedError(formatted);
process.exitCode = 1;
result.failed.push({ name: serviceName, error: error.message });
// continue processing other services...
```

Key rules:

- `formatError()` always returns a `FormattedError` (never null) -- no null-check needed
- Docker errors must NOT throw in actions -- throwing would skip remaining services in the loop
- Machine-format output (JSON/YAML/CSV) must embed failures in `result.failed[]`, not just log to
  stderr

### Fuzzy Match Utility

`src/lib/fuzzy-match.ts` provides case-insensitive Levenshtein distance matching for "did you mean?"
suggestions on service names, group names, and profile names. It uses the `fastest-levenshtein`
package.

Exported functions:

| Function             | Signature                                                 | Purpose                                         |
| -------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| `computeSimilarity`  | `(a: string, b: string) => number`                        | Returns 0-1 similarity score (case-insensitive) |
| `findClosestMatch`   | `(query, candidates, minScore?) => string \| undefined`   | Single best match above threshold (default 0.4) |
| `findClosestMatches` | `(query, candidates, maxResults?, minScore?) => string[]` | Up to N matches sorted by score descending      |

Usage at throw sites:

```typescript
import { findClosestMatch } from "./fuzzy-match.js";

const suggestion = findClosestMatch(serviceName, availableServices);
throw new ServiceNotFoundError(serviceName, availableServices, suggestion);
```

The default `minScore` of 0.4 works well for short service names (e.g., "plx" -> "plex" scores
~0.75).

### Testing Error Handling

**Testing thrown errors** (library code and validation):

```typescript
import { ServiceNotFoundError } from "../lib/errors.js";

it("should throw ServiceNotFoundError for unknown service", async () => {
  await expect(action()).rejects.toThrow(ServiceNotFoundError);
});

it("should include suggestion in thrown error", async () => {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceNotFoundError);
    const serviceError = error as ServiceNotFoundError;
    expect(serviceError.suggestion).toBe("plex");
    expect(serviceError.availableServices).toContain("plex");
  }
});
```

**Testing locally formatted errors** (action Docker failures):

```typescript
import { formatError, outputFormattedError } from "@rfmedia/common";

vi.mock("@rfmedia/common", () => ({
  formatError: vi.fn().mockReturnValue({ message: "error", suggestions: [], exitCode: 1 }),
  outputFormattedError: vi.fn(),
}));

it("should format Docker error locally without throwing", async () => {
  const result = await executeDeploy(options, globalOptions);
  expect(formatError).toHaveBeenCalled();
  expect(outputFormattedError).toHaveBeenCalled();
  expect(result.failed).toHaveLength(1);
  expect(process.exitCode).toBe(1);
});
```

**Testing error formatters**:

The `errorFormatters[]` registry is a module-level singleton in `@rfmedia/common`. Use `beforeAll()`
for `registerRfappsErrorFormatters()` registration (not `beforeEach()`) to avoid accumulating
duplicate formatters. Mock `process.exit` when testing `handleCliError()` to prevent test runner
termination.

### Adding New Error Types

To add a new error class and formatter:

1. **Define the error class** in `src/lib/errors.ts`:

```typescript
export class MyNewError extends Error {
  readonly contextField: string;

  constructor(contextField: string) {
    super(`Descriptive message: ${contextField}`);
    this.name = "MyNewError";
    this.contextField = contextField;
  }
}
```

2. **Register a formatter** in `src/lib/error-formatters.ts` inside
   `registerRfappsErrorFormatters()`:

```typescript
registerErrorFormatter({
  canHandle: (error): error is MyNewError => error instanceof MyNewError,
  formatMessage: (error) => `Descriptive message: ${error.contextField}`,
  getSuggestions: (error) => ["Actionable suggestion based on context", "Run with --debug for more details"],
  exitCode: 1,
});
```

3. **The error class is auto-exported** via `export * from "./errors.js"` in `src/lib/index.ts` --
   no barrel export changes needed.

4. **Throw the error** in the appropriate location:
   - For validation/lookup errors in library code: `throw new MyNewError(context)` -- it propagates
     to `handleCliError()`.
   - For Docker operation failures in actions: use local formatting with `formatError()` +
     `outputFormattedError()`.

5. **Write tests** in `src/lib/errors.spec.ts` (construction, name, instanceof, readonly fields) and
   `src/lib/error-formatters.spec.ts` (formatter output and suggestions).

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
