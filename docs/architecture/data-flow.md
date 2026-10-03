# Data Flow Patterns

This document describes the data flow patterns within the rfmedia-apps CLI tools, including command
execution flows and Docker orchestration patterns.

## CLI Execution Flow

Both CLI tools follow a consistent execution flow from user input to operation completion.

### General CLI Flow

```mermaid
sequenceDiagram
    participant User
    participant CLI as cli.ts
    participant Command as commands/*.ts
    participant Action as actions/*.ts
    participant Lib as lib/*.ts
    participant External as External System

    User->>CLI: rfapps/rfmedia <command> [options]
    CLI->>CLI: Parse global options
    CLI->>CLI: preAction hook (debug/JSON mode)

    CLI->>Command: Route to command handler
    Command->>Command: Parse command options
    Command->>Command: Validate arguments

    Command->>Action: Call action function
    Action->>Action: Build typed options
    Action->>Action: Load configuration

    Action->>Lib: Execute operations
    Lib->>External: Perform action
    External-->>Lib: Result
    Lib-->>Action: Operation result

    Action->>Action: Aggregate results

    alt JSON Mode
        Action->>User: outputJson(result)
    else Normal Mode
        Action->>User: logSuccess/logError
    end
```

### rfapps Deploy Flow

Detailed flow for the `rfapps deploy` command:

```mermaid
sequenceDiagram
    participant User
    participant Deploy as deploy.ts
    participant Config as config.ts
    participant Selection as services.ts
    participant Coordinator as deploy-validation.ts
    participant Graph as dependency-graph.ts
    participant Docker as docker.ts facade
    participant Evidence as docker-conflict-evidence.ts
    participant Evaluator as conflict-validation.ts
    participant Resources as port / volume / network evaluators
    participant Engine as Docker Engine
    participant State as deployment history

    User->>Deploy: rfapps deploy with optional validation

    Deploy->>Config: loadConfig()
    Deploy->>Config: applyCliOverrides()
    Deploy->>Config: validateConfigAgainstCompose()
    Config-->>Deploy: Valid final config

    Deploy->>Selection: Resolve requested services, groups, sidecars, and profiles
    Selection-->>Deploy: Selected services and profiles

    opt validate-first enabled
        Deploy->>Coordinator: runDeployValidation(inputs and selected services)
        Coordinator->>Docker: Resolve canonical Compose evidence
        Docker->>Evidence: Read and project canonical Compose config
        Evidence->>Engine: docker compose config --format json
        Engine-->>Evidence: Complete resolved Compose JSON
        Evidence-->>Docker: Secret-free projection + complete-input fingerprint
        Docker-->>Coordinator: Canonical Compose evidence

        Coordinator->>Graph: Resolve transitive depends_on and network_mode closure
        Graph-->>Coordinator: Canonical concrete service scope
        Coordinator->>Coordinator: Project desired claims and create canonical binding

        par Independently settled authority and runtime evidence lanes
            Coordinator->>Coordinator: Fingerprint effective Docker authority
        and
            Coordinator->>Docker: Inspect running containers
            Docker->>Evidence: Read bounded container evidence
            Evidence->>Engine: List IDs and inspect bounded batches
            Engine-->>Evidence: Container evidence
            Evidence-->>Docker: Allowlisted container projections
            Docker-->>Coordinator: Container projections
        and
            Coordinator->>Docker: Inspect Docker networks
            Docker->>Evidence: Read bounded network evidence
            Evidence->>Engine: List IDs and inspect bounded batches
            Engine-->>Evidence: Network evidence
            Evidence-->>Docker: Allowlisted network projections
            Docker-->>Coordinator: Network projections
        and
            Coordinator->>Docker: Inspect named volumes
            Docker->>Evidence: Read bounded volume evidence
            Evidence->>Engine: List names and inspect bounded batches
            Engine-->>Evidence: Volume evidence
            Evidence-->>Docker: Allowlisted volume projections
            Docker-->>Coordinator: Volume projections
        end

        Coordinator->>Evaluator: Evaluate desired and available runtime projections
        Evaluator->>Resources: Evaluate port, volume, and network claims
        Resources-->>Evaluator: Resource findings and normalization issues
        Evaluator-->>Coordinator: Deterministic aggregate evaluation
        Coordinator->>Coordinator: Settle lane failures and evaluation
        Coordinator-->>Deploy: Result, canonical binding, effective scope

        alt blocked or inconclusive
            Deploy-->>User: Render one versioned result and exit 1
            Note over Deploy,State: No pull, start, readiness, database initialization, or persistence
        else passed
            Note over Deploy,Coordinator: Retain point-in-time binding and result for this process
        end
    end

    alt Dry run
        opt Parallel plan from passed validation
            Deploy->>Coordinator: validationDependencyGraph(outcome)
            Coordinator->>Graph: Build phases from validated Compose model
            Graph-->>Coordinator: Dependency graph
            Coordinator-->>Deploy: Dependency graph
        end
        Deploy-->>User: Render resolved preview and exit without mutation or persistence
    else Deploy
        Deploy->>User: Confirm when required

        opt Validation passed
            opt Parallel execution
                Deploy->>Coordinator: validationDependencyGraph(outcome)
                Coordinator->>Graph: Build phases from validated Compose model
                Graph-->>Coordinator: Dependency graph
                Coordinator-->>Deploy: Dependency graph
            end
            Deploy->>Coordinator: revalidateDeployBinding(binding)
            Coordinator->>Docker: Re-read canonical Compose evidence
            Docker->>Evidence: Recompute complete-input fingerprint
            Evidence->>Engine: Read-only Compose check
            Engine-->>Evidence: Complete resolved Compose JSON
            Evidence-->>Docker: Current projection + fingerprint
            Docker-->>Coordinator: Current canonical evidence
            Coordinator->>Coordinator: Recheck file, complete-input, and authority fingerprints
            alt Inputs or authority changed
                Coordinator-->>Deploy: Revalidation failure
                Deploy-->>User: Render inconclusive result and exit 1
                Note over Deploy,State: Pre-mutation boundary with no validation persistence
            else Binding unchanged
                Coordinator-->>Deploy: Binding unchanged
                Note over Deploy: Cross the single mutation boundary
            end
        end

        alt Parallel execution
            Deploy->>Docker: Pull and start by dependency phase
            Docker->>Engine: docker compose pull / up
        else Sequential execution
            opt Image pull enabled
                Deploy->>Docker: pullImages()
                Docker->>Engine: docker compose pull
            end
            Deploy->>Docker: startServices()
            Docker->>Engine: docker compose up -d
        end

        Deploy->>Docker: Verify startup and dependency readiness
        Docker->>Engine: docker compose ps / inspect
        Docker-->>Deploy: Deployment outcome
        Deploy->>State: Record deployment outcome
        Deploy-->>User: logSuccess / structured result
    end

    Note over Deploy,Resources: Validation is point-in-time evidence and Docker remains final allocator
```

The deploy action owns CLI interaction, result rendering, confirmation, and dry-run, pass/non-pass,
parallel, and mutation branches. The deploy-validation coordinator owns canonical binding and
complete-input fingerprint retention, effective-scope and desired-state projection, independently
settled evidence lanes, aggregate evaluation, dependency-graph coordination from the validated
Compose model, and immediate pre-mutation revalidation.

The `docker.ts` facade delegates conflict evidence to `docker-conflict-evidence.ts`.
`conflict-validation.ts` delegates resource policy to `conflict-port-evaluator.ts`,
`conflict-volume-evaluator.ts`, and `conflict-network-evaluator.ts`; those evaluators depend on the
budget and sanitization utilities in `conflict-evaluator-shared.ts`. The canonical Compose model,
Docker snapshot, and binding remain ephemeral. Only a `passed` result can reach the existing
confirmation and execution paths, and the binding is checked again immediately before the first
write.

### rfapps Managed Update Flow

`rfapps update` is a CLI-only, preview-first image lifecycle. Bare invocation stops after detection
and persists a secret-free managed plan. Mutation requires `--apply` and approval; generic
`rfapps apply` does not accept managed-update plans.

```mermaid
sequenceDiagram
    participant User
    participant Command as commands/update.ts
    participant Action as actions/update.ts
    participant Plan as plan-generator/storage
    participant Coordinator as managed-update.ts
    participant Docker as docker.ts
    participant Verify as health.ts
    participant State as state/generations

    User->>Command: rfapps update [scope]
    Command->>Action: executeUpdate(options)
    Action->>Plan: Detect current and proposed image identities
    Plan-->>Action: update-plan.v1
    Action->>User: Preview and save secret-free plan

    alt Preview, dry run, cancellation, or no updates
    Action-->>User: No container mutation
    else Approved --apply
    Action->>Coordinator: runManagedUpdate(reviewed plan)
    Coordinator->>Coordinator: Acquire project/context lock
    Coordinator->>Plan: Revalidate Compose, context, scope, current ID, and digest

    loop Actionable services, sequentially
    Coordinator->>State: Snapshot exact pre-update local image ID
    Coordinator->>Docker: Pull reviewed repository digest
    Coordinator->>Docker: Targeted recreate with --pull never
    Note over Docker: No --remove-orphans
    Coordinator->>Verify: Verify expected image, target readiness, and dependencies

    alt Update verified
    Coordinator->>State: Record update and verified generation
    else Recreate or verification failed after mutation
    Coordinator->>Docker: Recreate from exact prior local image ID
    Coordinator->>Verify: Verify restored image and readiness
    Coordinator->>State: Record failed update and verified restore, or restore failure
    end
    end

    Coordinator->>Coordinator: Release lock and temporary override
    Coordinator-->>Action: update.v1 result
    Action->>User: Persist report and render one final result
    end
```

Update and restore use the current Compose configuration and affect images only. The flow does not
restore volumes, databases, application data, or migrations, and it does not schedule work or update
services in parallel.

### rfapps Reconciliation Flow

`rfapps reconcile` is a same-process, report-first controller. It observes resolved Compose intent
and complete Docker runtime evidence, then deterministically plans one
`none|create|start|recreate|blocked` action for every selected service. Report mode and global
`--dry-run` stop after this planning boundary: they do not prompt, lock, mutate Docker, save a plan,
or write deployment history or generations.

```mermaid
sequenceDiagram
    participant User
    participant Command as commands/reconcile.ts
    participant Action as actions/reconcile.ts
    participant Observe as drift.ts / docker.ts
    participant Coordinator as reconcile.ts
    participant Lock as lifecycle-lock.ts
    participant Verify as health.ts

    User->>Command: rfapps reconcile [scope]
    Command->>Action: executeReconcile(options)
    Action->>Observe: Resolve scope and capture Compose/Docker evidence
    Observe-->>Action: Canonical authority, observations, and drift
    Action->>Coordinator: Build deterministic reconcile.v1 plan
    Coordinator-->>Action: Complete reviewed result + action fingerprint

    alt Report, dry run, or no actionable work
    Action-->>User: Render result; no mutation or persistence
    else Approved --auto-apply
    Action->>User: Show report and request confirmation unless --yes
    Action->>Coordinator: Run reviewed lifecycle
    Coordinator->>Lock: Acquire shared project/Docker lock
    Coordinator->>Observe: Revalidate scope, authority, policy, drift, and actions

    loop Reviewed services in dependency phases and stable order
    Coordinator->>Observe: Re-observe service and recheck policy
    alt Service became in sync
    Coordinator->>Coordinator: Record became_in_sync
    else Evidence still matches review
    Coordinator->>Observe: Targeted Compose up for exact service
    Note over Observe: --pull never --no-deps; recreate alone adds --force-recreate
    Coordinator->>Verify: Check readiness
    Coordinator->>Observe: Capture fresh zero-drift evidence
    Coordinator->>Coordinator: Record converged or not_converged
    end
    end

    Coordinator->>Lock: Release in finally
    Coordinator-->>Action: Terminal reconcile.v1 result
    Action-->>User: Render one final result
    end
```

Reconciliation shares its lock with managed image update, but the lifecycles have different
authority and durability. Reconciliation corrects current containers toward the existing Compose
declaration without pulling registry images, persisting intent, or attempting rollback. Managed
update instead persists reviewed image identities, pulls the reviewed digest, records verified
generations, and can restore the exact prior local image. Ordinary `plan`/`apply` persists a
deployment plan that can be applied by a later process; reconciliation cannot be resumed from a
saved artifact and a later run simply observes current state again.

Version 1 injects an allow-all action policy after explicit `--auto-apply` authorization. It does
not implement maintenance schedules or windows; issue #169 can replace that policy decision while
leaving observation available.

### rfmedia Copy Flow

Detailed flow for the `rfmedia copy` command in album mode:

```mermaid
sequenceDiagram
    participant User
    participant Copy as copy.ts
    participant CopyAlbum as copy-album.ts
    participant Config as config.ts
    participant DB as db.ts
    participant FS as filesystem.ts
    participant History as history.ts
    participant Disk as Filesystem

    User->>Copy: rfmedia copy /source /dest --range=001-005

    Copy->>Copy: Parse options
    Copy->>Copy: Detect mode (album vs filter)

    Copy->>Config: getLoadedConfig()
    Config-->>Copy: ConfigFile

    Copy->>CopyAlbum: executeAlbumCopyWithFileInput()

    CopyAlbum->>DB: initializeDatabase()
    DB-->>CopyAlbum: DbConnection

    CopyAlbum->>History: createHistorySession("copy")
    History-->>CopyAlbum: HistoryRecorder

    loop For each source
        CopyAlbum->>CopyAlbum: Resolve effective range

        CopyAlbum->>Disk: Scan source directory
        Disk-->>CopyAlbum: Audio files list

        loop For each suffix (001-005)
            CopyAlbum->>FS: copyOrLink(src, dest)
            FS->>Disk: fs.copyFile / fs.link
            Disk-->>FS: Success
            FS-->>CopyAlbum: Copy result

            CopyAlbum->>History: recordCopy(src, dest)
        end
    end

    CopyAlbum->>History: close()
    CopyAlbum->>DB: close()

    CopyAlbum-->>Copy: CopyResult
    Copy->>User: logSuccess/outputJson
```

### rfmedia Interactive Selection Flow

Interactive selection is used in workflows that require user choice (tracks or deletions):

```mermaid
sequenceDiagram
    participant User
    participant Command as commands/*.ts
    participant Action as actions/*.ts
    participant UI as lib/interactive/*.tsx
    participant Ink as Ink/@inkjs/ui

    User->>Command: rfmedia <command> --interactive
    Command->>Action: execute*Interactive()
    Action->>UI: render Selector component
    UI->>Ink: MultiSelect render + input handlers
    Ink-->>User: Terminal UI prompt

    alt Selection Confirmed
        User->>Ink: Select items + Enter
        Ink-->>UI: onSubmit(values)
        UI-->>Action: selected items
        Action-->>User: proceed with operation
    else Cancelled
        User->>Ink: Escape
        Ink-->>UI: onCancel()
        UI-->>Action: cancellation signal
        Action-->>User: logInfo + exit
    end
```

## Docker Orchestration Flow

### Docker Command Execution

The `lib/docker.ts` module handles all Docker interactions:

```mermaid
flowchart TB
    subgraph DockerModule["docker.ts"]
        EXEC_DOCKER["execDocker()"]
        EXEC_COMPOSE["execDockerCompose()"]
        EXEC_CMD["execCommand()"]
    end

    subgraph EnvTools["env-tools.ts"]
        BUILD_ENV["buildEnvCommand()"]
    end

    subgraph Options["Execution Options"]
        ENV_TOOL["envTool: dotenvx | op | none"]
        TIMEOUT["timeout: 300000ms"]
        RETRY["maxRetries: 3"]
        STREAM["streamOutput: boolean"]
    end

    subgraph DockerEngine["Docker Engine"]
        DOCKER["docker"]
        COMPOSE["docker compose"]
    end

    EXEC_COMPOSE --> EXEC_DOCKER
    EXEC_DOCKER --> EXEC_CMD

    EXEC_CMD --> BUILD_ENV
    BUILD_ENV --> ENV_TOOL

    EXEC_CMD --> DOCKER
    EXEC_COMPOSE --> COMPOSE

    subgraph RetryLogic["SSH Retry Logic"]
        CHECK_SSH["isSSHError()"]
        SLEEP["sleep(retryDelay)"]
    end

    EXEC_CMD --> CHECK_SSH
    CHECK_SSH -->|Yes| SLEEP
    SLEEP --> EXEC_CMD
```

### Service Sidecar Expansion (optional CLI feature)

When `sidecars.enabled: true` and mappings are defined, `expandServicesWithSidecars()` includes
paired sidecars. **This repo disables sidecars** (`sidecars.enabled: false`, empty mapping), so
targeting `plex` returns `[plex]` only.

```mermaid
flowchart LR
    subgraph Input["User Input"]
        SERVICE["-s plex"]
    end

    subgraph Expansion["expandServicesWithSidecars()"]
        CHECK["sidecars.enabled?"]
        LOOKUP["Lookup mapping"]
        PASS["Return unchanged"]
    end

    subgraph Output["Expanded Services"]
        RESULT["[plex]"]
    end

    SERVICE --> CHECK
    CHECK -->|disabled| PASS
    PASS --> RESULT
```

Tailnet ingress uses Docktail labels on `plex`, `jellyfin`, and `immich-server` — not sidecar
`network_mode` sharing.

## Configuration Loading Flow

### rfapps Configuration

```mermaid
flowchart TB
    subgraph Sources["Configuration Sources"]
        DEFAULT["Default Config<br/>(built-in)"]
        GLOBAL["~/.rfapps.yaml<br/>(global)"]
        LOCAL["./rfapps.yaml<br/>(local)"]
        CLI_OPTS["CLI Options<br/>(--compose, --env-file)"]
    end

    subgraph LoadConfig["loadConfig()"]
        LOAD_DEFAULT["Load defaults"]
        LOAD_GLOBAL["Load global config"]
        LOAD_LOCAL["Load local config"]
        MERGE["Deep merge configs"]
    end

    subgraph ApplyOverrides["applyCliOverrides()"]
        OVERRIDE_PATH["composePath"]
        OVERRIDE_ENV["envFile"]
        OVERRIDE_PROFILE["profile"]
    end

    subgraph FinalConfig["Final RfappsConfig"]
        COMPOSE_PATH["composePath"]
        SIDECARS["sidecars.mapping"]
        GROUPS["groups"]
        PROFILES["profiles"]
    end

    DEFAULT --> LOAD_DEFAULT
    GLOBAL --> LOAD_GLOBAL
    LOCAL --> LOAD_LOCAL

    LOAD_DEFAULT --> MERGE
    LOAD_GLOBAL --> MERGE
    LOAD_LOCAL --> MERGE

    MERGE --> ApplyOverrides
    CLI_OPTS --> ApplyOverrides

    ApplyOverrides --> FinalConfig
```

### rfmedia Configuration

```mermaid
flowchart TB
    subgraph Sources["Configuration Sources"]
        YAML_FILE[".rfmedia.yaml"]
        JSON_FILE[".rfmedia.json"]
        CLI["CLI Options"]
    end

    subgraph LoadConfig["loadConfig()"]
        FIND["Find config file"]
        PARSE["Parse YAML/JSON"]
        VALIDATE["Validate schema"]
    end

    subgraph ConfigSections["Config Sections"]
        COPY["copy:<br/>range, hardlink, etc."]
        TRACKING["tracking:<br/>useLegacy, database"]
        UNDO["undo:<br/>enabled, retentionDays"]
        PLEX["plex:<br/>url, token, libraries"]
    end

    YAML_FILE --> FIND
    JSON_FILE --> FIND
    FIND --> PARSE
    PARSE --> VALIDATE

    VALIDATE --> COPY
    VALIDATE --> TRACKING
    VALIDATE --> UNDO
    VALIDATE --> PLEX

    CLI -->|Override| ConfigSections
```

## Tracking System Data Flow

### Dual-Mode Tracking

The tracking system supports both database and legacy file modes:

```mermaid
flowchart TB
    subgraph Entry["Copy Action Entry"]
        CHECK_MODE{{"useLegacy?"}}
    end

    subgraph DatabaseMode["Database Mode"]
        INIT_DB["initializeDatabase()"]
        CREATE_OP["createOperation()"]
        LOAD_STATE["loadTrackingStateFromDb()"]
        RECORD_DB["recordCompletedInDb()"]
    end

    subgraph LegacyMode["Legacy Mode"]
        CREATE_FILE["Create .completed.txt"]
        LOAD_FILE["Parse .completed.txt"]
        APPEND_FILE["appendFile()"]
    end

    subgraph TrackingState["TrackingState"]
        COMPLETED["completed: Set<string>"]
        FAILED["failed: Set<string>"]
    end

    CHECK_MODE -->|No| INIT_DB
    CHECK_MODE -->|Yes| CREATE_FILE

    INIT_DB --> CREATE_OP
    CREATE_OP --> LOAD_STATE
    LOAD_STATE --> TrackingState

    CREATE_FILE --> LOAD_FILE
    LOAD_FILE --> TrackingState

    TrackingState -->|Filter sources| PROCESS["Process pending"]

    PROCESS -->|Success| RECORD_DB
    PROCESS -->|Success| APPEND_FILE

    RECORD_DB --> DB[(SQLite)]
    APPEND_FILE --> FILE[(.completed.txt)]
```

### History Recording Flow

```mermaid
sequenceDiagram
    participant Action as Copy Action
    participant Recorder as HistoryRecorder
    participant DB as SQLite
    participant File as JSONL File

    Action->>Recorder: createHistorySession("copy", db?)

    alt Database Mode
        Recorder->>DB: INSERT INTO history_sessions
        DB-->>Recorder: session_id
    else Legacy Mode
        Recorder->>File: Create JSONL with header
    end

    loop For each operation
        Action->>Recorder: recordCopy(src, dest)

        alt Database Mode
            Recorder->>DB: INSERT INTO history_operations
        else Legacy Mode
            Recorder->>File: Append JSONL entry
        end
    end

    Action->>Recorder: close()

    alt Database Mode
        Recorder->>DB: UPDATE sessions SET ended_at, operation_count
    else Legacy Mode
        Recorder->>File: Update header with final count
    end
```

## Signal Handling Flow

Graceful interruption for long-running operations:

```mermaid
flowchart TB
    subgraph SignalHandler["signal-handler.ts"]
        GLOBAL_SIGNAL["Global AbortController"]
        CLEANUP_REGISTRY["Cleanup Handler Registry"]
    end

    subgraph Action["Copy Action"]
        LOCAL_ABORT["Local AbortController"]
        IN_PROGRESS["inProgressFiles Set"]
    end

    subgraph CleanupHandlers["Registered Handlers"]
        H1["priority: 10<br/>Abort controller"]
        H2["priority: 15<br/>Partial file cleanup"]
        H3["priority: 50<br/>History recorder"]
        H4["priority: 70<br/>Database connection"]
    end

    SIGINT((SIGINT/SIGTERM)) --> GLOBAL_SIGNAL
    GLOBAL_SIGNAL --> LOCAL_ABORT
    GLOBAL_SIGNAL --> CLEANUP_REGISTRY

    CLEANUP_REGISTRY --> H1
    H1 --> H2
    H2 --> H3
    H3 --> H4

    LOCAL_ABORT -->|Abort| IN_PROGRESS
    IN_PROGRESS -->|Cleanup| H2

    H3 -->|Save| HISTORY[(History)]
    H4 -->|Close| DATABASE[(Database)]
```

## Error Propagation Flow

The rfapps-cli uses a structured error handling system built on the `@rfmedia/common` error
formatting pipeline. Errors are represented as custom error classes with context-rich fields and
formatted through registered formatters that produce user-friendly messages with actionable
suggestions.

### Library Error Path

Validation and lookup errors thrown in library code propagate through Commander.js to the `main()`
catch block, where `handleCliError()` formats and outputs them.

```mermaid
sequenceDiagram
    participant User
    participant CLI as cli.ts (main)
    participant Commander as Commander.js
    participant Action as actions/*.ts
    participant Lib as lib/*.ts
    participant Handler as handleCliError()
    participant Format as formatError()
    participant Registry as Formatter Registry
    participant Stderr as stderr

    User->>CLI: rfapps deploy -s typo
    CLI->>Commander: program.parseAsync()
    Commander->>Action: Route to action handler
    Action->>Lib: resolveServicesWithInteractive()

    Lib->>Lib: Validate service name
    Note over Lib: Service 'typo' not found

    Lib->>Lib: findClosestMatch('typo', available)
    Lib-->>Lib: suggestion = 'traefik'

    Lib->>Commander: throw ServiceNotFoundError('typo', [...], 'traefik')
    Commander->>CLI: Error propagates to catch block

    CLI->>Handler: handleCliError(error)
    Handler->>Format: formatError(error)
    Format->>Registry: Check registered formatters
    Registry->>Registry: canHandle(error) -> instanceof match
    Registry-->>Format: formatMessage() + getSuggestions()
    Format-->>Handler: FormattedError

    Handler->>Stderr: outputFormattedError(formatted)
    Note over Stderr: Error: Service 'typo' not found
    Note over Stderr: Did you mean 'traefik'?
    Handler->>Handler: process.exit(1)
```

### Action Docker Error Path

Actions that execute Docker operations process multiple services in loops. When one service fails,
the loop continues processing remaining services. These actions use local formatting instead of
throwing.

```mermaid
sequenceDiagram
    participant Action as actions/deploy.ts
    participant Docker as docker.ts
    participant Engine as Docker Engine
    participant Format as formatError()
    participant Output as outputFormattedError()
    participant Stderr as stderr
    participant Result as result.failed[]

    loop For each service
        Action->>Docker: pullImages(services)
        Docker->>Engine: docker compose pull
        Engine-->>Docker: Exit code 1 + stderr

        Docker-->>Action: Error result

        Note over Action: Do NOT throw -- loop must continue

        Action->>Action: new ImagePullError(services, stderr)
        Action->>Format: formatError(error)
        Format-->>Action: FormattedError

        Action->>Output: outputFormattedError(formatted)
        Output->>Stderr: Error + suggestions

        Action->>Action: process.exitCode = 1
        Action->>Result: push({ name, error: message })

        Note over Action: Continue to next service
    end

    alt Machine Format (JSON/YAML/CSV)
        Action->>Action: formatOutput({ services, failed })
        Note over Action: Failures embedded in structured output
    else Human Format
        Action->>Stderr: logSuccess/logError summary
    end
```

### Error Formatting Pipeline

When an error is passed to `formatError()`, it traverses the formatter registry to find a matching
handler. Formatters are checked in registration order, with more specific formatters registered
before generic ones. If no registered formatter matches, a default formatter provides a generic
message.

```mermaid
flowchart TB
    ERROR((Error Occurs)) --> FORMAT["formatError(error)"]

    FORMAT --> LOOP{"Check formatter registry<br/>(in registration order)"}

    LOOP --> CHECK1{"formatter.canHandle(error)?"}
    CHECK1 -->|No| CHECK2{"Next formatter?"}
    CHECK2 -->|Yes| CHECK1
    CHECK2 -->|No formatters left| DEFAULT["Default Formatter"]

    CHECK1 -->|Yes| MATCHED["Matched Formatter"]

    MATCHED --> MSG["formatMessage(error)"]
    MATCHED --> SUGGEST["getSuggestions(error)"]
    MATCHED --> EXIT_CODE["exitCode (default: 1)"]

    DEFAULT --> DEFAULT_MSG["error.message"]
    DEFAULT --> DEFAULT_SUGGEST["'Run with --debug for more details'"]
    DEFAULT --> DEFAULT_EXIT["exitCode: 1"]

    MSG --> FE["FormattedError"]
    SUGGEST --> FE
    EXIT_CODE --> FE
    DEFAULT_MSG --> FE
    DEFAULT_SUGGEST --> FE
    DEFAULT_EXIT --> FE

    FE --> OUTPUT_FN["outputFormattedError()"]
    OUTPUT_FN --> STDERR_MSG["stderr: Error message"]
    OUTPUT_FN --> STDERR_SUGGEST["stderr: Suggestions list"]

    OUTPUT_FN --> DEBUG_CHECK{"isDebugMode()?"}
    DEBUG_CHECK -->|Yes| DEBUG_OUT["stderr: Error type + properties + stack trace"]
    DEBUG_CHECK -->|No| DONE((Done))
    DEBUG_OUT --> DONE
```

### Hybrid Error Strategy

The rfapps-cli uses a hybrid approach where the error propagation method depends on where the error
originates. Library-level errors throw and rely on the global catch handler, while action-level
Docker errors are formatted locally to preserve multi-service loop execution and structured output.

```mermaid
flowchart LR
    subgraph LibraryErrors["Library Errors (throw)"]
        direction TB
        L1["ServiceNotFoundError"]
        L2["GroupNotFoundError"]
        L3["ProfileNotFoundError"]
        L4["ConfigNotFoundError"]
        L5["ConfigValidationError"]
        L6["InvalidArgumentError"]
        L7["PlanValidationError"]
        L8["DeploymentNotFoundError"]
        L9["InsufficientHistoryError"]
    end

    subgraph DockerErrors["Docker Errors (local format)"]
        direction TB
        D1["DockerCommandError"]
        D2["ImagePullError"]
        D3["ServiceStartError"]
    end

    LibraryErrors -->|"throw"| COMMANDER["Commander.js catch"]
    COMMANDER --> HANDLE["handleCliError()"]
    HANDLE --> FORMAT_THROW["formatError()"]
    FORMAT_THROW --> OUTPUT_THROW["outputFormattedError()"]
    OUTPUT_THROW --> EXIT["process.exit(1)"]

    DockerErrors -->|"instantiate"| FORMAT_LOCAL["formatError()"]
    FORMAT_LOCAL --> OUTPUT_LOCAL["outputFormattedError()"]
    OUTPUT_LOCAL --> EXIT_CODE["process.exitCode = 1"]
    EXIT_CODE --> CONTINUE["Continue loop + result.failed[]"]
```

Key rules for the hybrid strategy:

- Library errors (validation, lookup, config) **throw** and propagate to `handleCliError()`, which
  calls `process.exit()`
- Docker operation errors are **formatted locally** inside action functions to preserve
  multi-service loop execution
- `formatError()` always returns a `FormattedError` (never null), so no null-check is needed at call
  sites
- Machine-format output (JSON/YAML/CSV) embeds failures in the `result.failed[]` array, not just
  stderr

## JSON Output Flow

All commands support JSON output for scripting:

```mermaid
flowchart LR
    subgraph Input["User Input"]
        JSON_FLAG["--json flag"]
    end

    subgraph GlobalHook["preAction Hook"]
        SET_JSON["setJsonMode(true)"]
    end

    subgraph Logging["Logger Module"]
        LOG_INFO["logInfo() -> no-op"]
        LOG_SUCCESS["logSuccess() -> no-op"]
        OUTPUT_JSON["outputJson() -> stdout"]
    end

    subgraph Progress["Progress Module"]
        SILENT["Listr: silent renderer"]
    end

    subgraph Output["Output"]
        STDOUT["stdout: JSON data"]
        STDERR["stderr: (empty)"]
    end

    JSON_FLAG --> SET_JSON
    SET_JSON --> LOG_INFO
    SET_JSON --> LOG_SUCCESS
    SET_JSON --> OUTPUT_JSON
    SET_JSON --> SILENT

    OUTPUT_JSON --> STDOUT
    LOG_INFO --> STDERR
```

## Related Documentation

- [Architecture Overview](./overview.md) - High-level system architecture
- [Sidecar Linking](../features/sidecar-linking.md) - Automatic sidecar management
- [Plan/Apply Workflow](../features/plan-apply-workflow.md) - Deployment planning
