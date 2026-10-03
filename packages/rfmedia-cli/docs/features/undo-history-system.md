# Undo/History System

This document describes the undo/history system in rfmedia-cli, which records filesystem operations for later reversal. Phase 2.5 introduced SQLite database storage as the primary backend, with legacy JSONL file support for backward compatibility.

## Overview

The undo/history system provides:

- **Operation recording** - All filesystem operations (copy, hardlink, convert, mkdir, remove, trash) are logged during command execution
- **Session-based tracking** - Each command invocation creates a session grouping all its operations
- **LIFO undo** - Operations are reversed in last-in-first-out order to maintain filesystem consistency
- **Dual-mode storage** - Supports both SQLite database (default) and legacy JSONL files
- **Automatic migration** - Legacy JSONL files are automatically migrated when database mode is used

### Phase 2.5 Migration

Phase 2.5 introduced SQLite database storage for the undo/history system, aligning it with the tracking system's database architecture. Key improvements:

| Feature           | Legacy (JSONL)            | Database (SQLite)         |
| ----------------- | ------------------------- | ------------------------- |
| Storage format    | Individual `.jsonl` files | Centralized `tracking.db` |
| Query capability  | File parsing required     | SQL queries supported     |
| Concurrent access | File locking issues       | SQLite transaction safety |
| Session metadata  | Header line parsing       | Structured table columns  |
| Migration path    | N/A                       | Automatic on first use    |

## Database Schema

### history_sessions Table

Stores session metadata (replaces JSONL file headers):

```sql
CREATE TABLE IF NOT EXISTS history_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,        -- {timestamp}-{command}-{pid}
  version TEXT NOT NULL,                  -- Format version "1"
  command TEXT NOT NULL,                  -- 'copy', 'clean', etc.
  started_at TEXT NOT NULL,               -- ISO timestamp
  ended_at TEXT,                          -- ISO timestamp (nullable)
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'undone', 'partial'
  cwd TEXT NOT NULL,                      -- Working directory
  operation_count INTEGER DEFAULT 0       -- Total operations
);
```

| Column            | Type    | Description                                                  |
| ----------------- | ------- | ------------------------------------------------------------ |
| `id`              | INTEGER | Primary key (auto-increment)                                 |
| `session_id`      | TEXT    | Unique session identifier: `{ISO-timestamp}-{command}-{pid}` |
| `version`         | TEXT    | History format version (currently "1")                       |
| `command`         | TEXT    | Command that was executed (e.g., "copy", "clean")            |
| `started_at`      | TEXT    | ISO timestamp when session started                           |
| `ended_at`        | TEXT    | ISO timestamp when session ended (nullable)                  |
| `status`          | TEXT    | Session status: `pending`, `undone`, or `partial`            |
| `cwd`             | TEXT    | Working directory when command was run                       |
| `operation_count` | INTEGER | Total number of operations recorded                          |

**Indexes:**

```sql
CREATE INDEX idx_history_sessions_session_id ON history_sessions(session_id);
CREATE INDEX idx_history_sessions_started_at ON history_sessions(started_at DESC);
CREATE INDEX idx_history_sessions_status ON history_sessions(status);
```

### history_operations Table

Stores individual filesystem operations:

```sql
CREATE TABLE IF NOT EXISTS history_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,            -- FK to history_sessions.id
  operation_type TEXT NOT NULL,           -- 'copy', 'hardlink', 'convert', 'mkdir', 'remove', 'trash'
  occurred_at TEXT NOT NULL,              -- ISO timestamp
  source_path TEXT,                       -- Source file (nullable for mkdir/remove/trash)
  dest_path TEXT NOT NULL,                -- Destination file/directory
  created_dir INTEGER DEFAULT 0,          -- Boolean: 1 if mkdir created dir
  convert_format TEXT,                    -- Target format for convert ops
  FOREIGN KEY (session_id) REFERENCES history_sessions(id) ON DELETE CASCADE
);
```

| Column           | Type    | Description                                                               |
| ---------------- | ------- | ------------------------------------------------------------------------- |
| `id`             | INTEGER | Primary key (auto-increment)                                              |
| `session_id`     | INTEGER | Foreign key to `history_sessions.id`                                      |
| `operation_type` | TEXT    | Operation type: `copy`, `hardlink`, `convert`, `mkdir`, `remove`, `trash` |
| `occurred_at`    | TEXT    | ISO timestamp when operation occurred                                     |
| `source_path`    | TEXT    | Source file path (nullable for mkdir/remove/trash)                        |
| `dest_path`      | TEXT    | Destination file or directory path                                        |
| `created_dir`    | INTEGER | Boolean flag (1 if mkdir actually created the directory)                  |
| `convert_format` | TEXT    | Target audio format for convert operations (nullable)                     |

**Indexes:**

```sql
CREATE INDEX idx_history_operations_session ON history_operations(session_id);
CREATE INDEX idx_history_operations_type ON history_operations(operation_type);
```

### Entity Relationship

```mermaid
erDiagram
    history_sessions ||--o{ history_operations : contains
    history_sessions {
        INTEGER id PK
        TEXT session_id UK
        TEXT version
        TEXT command
        TEXT started_at
        TEXT ended_at
        TEXT status
        TEXT cwd
        INTEGER operation_count
    }
    history_operations {
        INTEGER id PK
        INTEGER session_id FK
        TEXT operation_type
        TEXT occurred_at
        TEXT source_path
        TEXT dest_path
        INTEGER created_dir
        TEXT convert_format
    }
```

## Mermaid Diagrams

### History Recording Flow

Shows how operations are recorded from copy action through to database storage:

```mermaid
flowchart TD
    subgraph CopyAction["Copy Action (copy-album.ts / copy-filter.ts)"]
        A1[executeAlbumCopyWithFileInput]
        A2[Check history enabled]
        A3{undo.enabled<br/>!= false?}
        A4[createHistorySession]
        A5[Process files]
        A6[Copy/convert file]
        A7[Record operation]
        A8[Close session]
    end

    subgraph HistoryModule["History Module (history.ts)"]
        H1[createHistorySession]
        H2{Database<br/>mode?}
        H3[Generate session_id]
        H4[createHistorySessionInDb]
        H5[Create JSONL file with header]
        H6[Return HistoryRecorder]
        H7[recordEntry]
        H8{Database<br/>mode?}
        H9[recordHistoryOperation]
        H10[appendFile to JSONL]
        H11[close]
        H12{Database<br/>mode?}
        H13[closeHistorySessionInDb]
        H14[Update JSONL header]
    end

    subgraph Database["Database (db.ts)"]
        D1[(history_sessions)]
        D2[(history_operations)]
        D3[INSERT session]
        D4[INSERT operation]
        D5[UPDATE session ended_at]
    end

    subgraph Legacy["Legacy JSONL"]
        L1["{session_id}.jsonl"]
        L2["Header line (JSON)"]
        L3["Operation entries (JSONL)"]
    end

    %% Copy action flow
    A1 --> A2 --> A3
    A3 -->|Yes| A4
    A3 -->|No| A5
    A4 --> A5
    A5 --> A6 --> A7 --> A5
    A5 --> A8

    %% Session creation
    A4 --> H1
    H1 --> H2
    H2 -->|Yes| H3 --> H4 --> D3 --> D1
    H2 -->|No| H5 --> L1 --> L2
    H4 --> H6
    H5 --> H6
    H6 --> A5

    %% Recording operations
    A7 --> H7
    H7 --> H8
    H8 -->|Yes| H9 --> D4 --> D2
    H8 -->|No| H10 --> L3

    %% Closing session
    A8 --> H11
    H11 --> H12
    H12 -->|Yes| H13 --> D5
    H12 -->|No| H14

    %% Styling
    classDef action fill:#e3f2fd,stroke:#1565c0
    classDef history fill:#e8f5e9,stroke:#2e7d32
    classDef database fill:#f3e5f5,stroke:#7b1fa2
    classDef legacy fill:#fff3e0,stroke:#ef6c00
    classDef decision fill:#ffecb3,stroke:#ffa000

    class A1,A2,A4,A5,A6,A7,A8 action
    class H1,H3,H4,H5,H6,H7,H9,H10,H11,H13,H14 history
    class D1,D2,D3,D4,D5 database
    class L1,L2,L3 legacy
    class A3,H2,H8,H12 decision
```

### Session Lifecycle

Shows the complete lifecycle of a history session from start to finish:

```mermaid
stateDiagram-v2
    [*] --> Creating: createHistorySession()

    Creating --> Initialized: initialize()
    note right of Creating
        Generate session_id
        {timestamp}-{command}-{pid}
    end note

    Initialized --> Recording: recordCopy/Hardlink/Convert/Mkdir()
    note right of Initialized
        Database: INSERT INTO history_sessions
        Legacy: Write header to JSONL file
    end note

    Recording --> Recording: More operations
    note right of Recording
        Database: INSERT INTO history_operations
        Legacy: Append line to JSONL file
    end note

    Recording --> Closing: close()
    note right of Closing
        Database: UPDATE ended_at, operation_count
        Legacy: Rewrite header with final metadata
    end note

    Closing --> Pending: Status = 'pending'
    note right of Pending
        Session available for undo
    end note

    Pending --> Undoing: executeUndo()

    Undoing --> Undone: All operations reversed
    Undoing --> Partial: Some operations failed
    Undoing --> Pending: All operations failed

    Undone --> [*]
    Partial --> [*]
```

### Dual-Mode Routing

Decision tree for database vs legacy JSONL mode:

```mermaid
flowchart TD
    subgraph Config["Configuration Check"]
        Start[History operation requested]
        C1{undo.useLegacy<br/>== true?}
        C2{undo.database<br/>specified?}
        C3{tracking.database<br/>exists?}
    end

    subgraph DbMode["Database Mode"]
        D1[Use SQLite database]
        D2[Path: undo.database OR tracking.database]
        D3[Tables: history_sessions, history_operations]
        D4[Full SQL query support]
    end

    subgraph LegacyMode["Legacy JSONL Mode"]
        L1[Use JSONL files]
        L2["Path: ~/.rfmedia/history/"]
        L3["Files: {session_id}.jsonl"]
        L4[File parsing required]
    end

    subgraph Functions["Function Routing"]
        F1["listSessions(options, db?)"]
        F2{db parameter<br/>provided?}
        F3[listSessionsFromDb]
        F4[Scan history directory]
        F5["loadSession(sessionId, db?)"]
        F6{db parameter<br/>provided?}
        F7[loadSessionFromDb]
        F8[Parse JSONL file]
        F9["updateSessionStatus(id, status, db?)"]
        F10{db parameter<br/>provided?}
        F11[updateHistorySessionStatusInDb]
        F12[Rewrite JSONL header]
    end

    %% Config flow
    Start --> C1
    C1 -->|Yes| L1
    C1 -->|No| C2
    C2 -->|Yes| D1
    C2 -->|No| C3
    C3 -->|Yes| D1
    C3 -->|No| L1

    D1 --> D2 --> D3 --> D4
    L1 --> L2 --> L3 --> L4

    %% Function routing
    D4 --> F1
    L4 --> F1
    F1 --> F2
    F2 -->|Yes| F3
    F2 -->|No| F4

    F1 --> F5
    F5 --> F6
    F6 -->|Yes| F7
    F6 -->|No| F8

    F5 --> F9
    F9 --> F10
    F10 -->|Yes| F11
    F10 -->|No| F12

    %% Styling
    classDef config fill:#e3f2fd,stroke:#1565c0
    classDef dbmode fill:#e8f5e9,stroke:#2e7d32
    classDef legacy fill:#fff3e0,stroke:#ef6c00
    classDef function fill:#f3e5f5,stroke:#7b1fa2
    classDef decision fill:#ffecb3,stroke:#ffa000

    class Start config
    class D1,D2,D3,D4 dbmode
    class L1,L2,L3,L4 legacy
    class F1,F3,F4,F5,F7,F8,F9,F11,F12 function
    class C1,C2,C3,F2,F6,F10 decision
```

### Undo Execution Flow

Shows how the undo command reads from database and reverses operations:

```mermaid
flowchart TD
    subgraph Command["Undo Command (undo.ts)"]
        U1["rfmedia undo [options]"]
        U2{--list flag?}
        U3[listUndoableSessions]
        U4{--session=id?}
        U5[loadSession by ID]
        U6[listSessions with limit=N]
        U7[Confirm with user]
        U8[executeUndo]
    end

    subgraph LoadSessions["Load Sessions"]
        L1["listSessions({status: 'pending', limit: N}, db)"]
        L2{Database<br/>mode?}
        L3[Query history_sessions WHERE status='pending']
        L4[Scan JSONL files, parse headers]
        L5[Return HistorySession array]
    end

    subgraph LoadOperations["Load Full Session"]
        O1["loadSession(sessionId, db)"]
        O2{Database<br/>mode?}
        O3[Query history_operations WHERE session_id=?]
        O4[Parse JSONL file entries]
        O5[Return session with entries array]
    end

    subgraph Undo["Undo Operations (LIFO)"]
        R1[Reverse entries array]
        R2[For each entry]
        R3{Operation<br/>type?}
        R4["copy/hardlink/convert:<br/>unlink(dest_path)"]
        R5["mkdir (created=true):<br/>rmdir if empty"]
        R6["remove/trash:<br/>Warn - cannot restore"]
        R7[Record result]
        R8{More entries?}
    end

    subgraph UpdateStatus["Update Session Status"]
        S1{All succeeded?}
        S2["updateSessionStatus('undone')"]
        S3{All failed?}
        S4["Keep status='pending'"]
        S5["updateSessionStatus('partial')"]
    end

    subgraph Result["Return Result"]
        T1[UndoResult object]
        T2["sessions: UndoSessionResult[]"]
        T3["totalUndone, totalFailed, totalSkipped"]
    end

    %% Command flow
    U1 --> U2
    U2 -->|Yes| U3 --> T1
    U2 -->|No| U4
    U4 -->|Yes| U5
    U4 -->|No| U6
    U5 --> U7
    U6 --> U7
    U7 --> U8

    %% Load sessions
    U6 --> L1
    L1 --> L2
    L2 -->|Yes| L3 --> L5
    L2 -->|No| L4 --> L5

    %% Load operations
    U5 --> O1
    O1 --> O2
    O2 -->|Yes| O3 --> O5
    O2 -->|No| O4 --> O5

    %% Undo execution
    U8 --> R1 --> R2 --> R3
    R3 -->|copy/hardlink/convert| R4 --> R7
    R3 -->|mkdir| R5 --> R7
    R3 -->|remove/trash| R6 --> R7
    R7 --> R8
    R8 -->|Yes| R2
    R8 -->|No| S1

    %% Update status
    S1 -->|Yes| S2 --> T1
    S1 -->|No| S3
    S3 -->|Yes| S4 --> T1
    S3 -->|No| S5 --> T1

    %% Result
    T1 --> T2 --> T3

    %% Styling
    classDef command fill:#e3f2fd,stroke:#1565c0
    classDef load fill:#e8f5e9,stroke:#2e7d32
    classDef undo fill:#f3e5f5,stroke:#7b1fa2
    classDef status fill:#fce4ec,stroke:#c2185b
    classDef result fill:#fff3e0,stroke:#ef6c00
    classDef decision fill:#ffecb3,stroke:#ffa000

    class U1,U3,U7,U8 command
    class L1,L3,L4,L5,O1,O3,O4,O5 load
    class R1,R2,R4,R5,R6,R7 undo
    class S2,S4,S5 status
    class T1,T2,T3 result
    class U2,U4,L2,O2,R3,R8,S1,S3 decision
```

## Configuration

### Undo Configuration Options

Add to `.rfmedia.yaml` (default) or `.rfmedia.json`:

```yaml
undo:
  enabled: true
  retentionDays: 30
  maxSizeMB: 100
  historyPath: null
  database: null
  useLegacy: false
```

| Option          | Type    | Default              | Description                                               |
| --------------- | ------- | -------------------- | --------------------------------------------------------- |
| `enabled`       | boolean | `true`               | Enable/disable history recording                          |
| `retentionDays` | number  | `30`                 | Days to retain history before cleanup                     |
| `maxSizeMB`     | number  | `100`                | Maximum history directory size in MB                      |
| `historyPath`   | string  | `~/.rfmedia/history` | Custom history directory path (legacy mode)               |
| `database`      | string  | `null`               | Path to SQLite database (defaults to `tracking.database`) |
| `useLegacy`     | boolean | `false`              | Use JSONL files instead of database                       |

### Mode Selection Logic

```typescript
// Pseudo-code for mode selection
if (config.undo?.useLegacy === true) {
  // Legacy JSONL mode
  mode = "legacy";
} else if (config.undo?.database) {
  // Explicit database path
  mode = "database";
  dbPath = config.undo.database;
} else if (config.tracking?.database) {
  // Share tracking database
  mode = "database";
  dbPath = config.tracking.database;
} else {
  // Default to legacy mode if no database configured
  mode = "legacy";
}
```

### Example Configurations

**Database mode (recommended):**

```yaml
tracking:
  database: "~/.rfmedia/tracking.db"
undo:
  enabled: true
  retentionDays: 30
```

**Explicit undo database:**

```yaml
undo:
  enabled: true
  database: "~/.rfmedia/history.db"
  retentionDays: 60
```

**Legacy JSONL mode:**

```yaml
undo:
  enabled: true
  useLegacy: true
  historyPath: "~/.rfmedia/history"
```

## Usage Examples

### Viewing History Sessions

```bash
# List undoable sessions (status = 'pending')
rfmedia undo --list

# Output:
# Undoable sessions:
#
#   2026-01-18T10-30-45Z-copy-12345
#     Command: copy | Operations: 150 | Date: 1/18/2026, 10:30:45 AM
#
#   2026-01-18T09-15-22Z-copy-12346
#     Command: copy | Operations: 75 | Date: 1/18/2026, 9:15:22 AM
```

### Viewing Operations for a Session

Currently, detailed operation viewing requires direct database queries (see Database Analytics section below). The CLI shows summary information in the undo preview.

### Using the Undo Command

```bash
# Undo the most recent session
rfmedia undo

# Undo the last 3 sessions
rfmedia undo --last=3

# Undo a specific session by ID
rfmedia undo --session=2026-01-18T10-30-45Z-copy-12345

# Preview undo without executing (dry-run)
rfmedia undo --dry-run

# Skip confirmation prompt
rfmedia undo --force

# Combine options
rfmedia undo --last=2 --dry-run
```

### Querying Database for History Analytics

```bash
# Open the database with sqlite3
sqlite3 ~/.rfmedia/tracking.db

# List all sessions
SELECT session_id, command, status, operation_count, started_at
FROM history_sessions
ORDER BY started_at DESC
LIMIT 10;

# View operations for a specific session
SELECT ho.operation_type, ho.source_path, ho.dest_path, ho.occurred_at
FROM history_operations ho
JOIN history_sessions hs ON ho.session_id = hs.id
WHERE hs.session_id = '2026-01-18T10-30-45Z-copy-12345'
ORDER BY ho.occurred_at;

# Count operations by type for recent sessions
SELECT hs.session_id, ho.operation_type, COUNT(*) as count
FROM history_operations ho
JOIN history_sessions hs ON ho.session_id = hs.id
WHERE hs.started_at > datetime('now', '-7 days')
GROUP BY hs.session_id, ho.operation_type
ORDER BY hs.started_at DESC;

# Find sessions with convert operations
SELECT DISTINCT hs.session_id, hs.command, hs.started_at
FROM history_sessions hs
JOIN history_operations ho ON hs.id = ho.session_id
WHERE ho.operation_type = 'convert';

# Get total files created in the last 30 days
SELECT COUNT(*) as total_operations
FROM history_operations ho
JOIN history_sessions hs ON ho.session_id = hs.id
WHERE hs.started_at > datetime('now', '-30 days')
  AND ho.operation_type IN ('copy', 'hardlink', 'convert');
```

## Implementation Details

### HistoryRecorder Class Structure

The `HistoryRecorder` class manages session-based operation logging:

```typescript
class HistoryRecorder {
  // Private fields
  private readonly sessionId: string; // Generated session ID
  private readonly filePath: string; // JSONL file path (legacy)
  private readonly command: string; // Command name
  private operationCount: number = 0; // Operations recorded
  private closed: boolean = false; // Session closed flag
  private readonly enabled: boolean; // History enabled flag
  private readonly db?: DbConnection; // Database connection (optional)
  private readonly dbSessionId?: number; // Database session ID (optional)

  // Public methods
  constructor(command: string, options?: { db?: DbConnection; dbSessionId?: number });
  getId(): string;
  getFilePath(): string;
  async initialize(): Promise<void>;
  async recordCopy(src: string, dest: string): Promise<void>;
  async recordHardlink(src: string, dest: string): Promise<void>;
  async recordConvert(src: string, dest: string, format: ConvertFormat): Promise<void>;
  async recordMkdir(path: string, wasCreated: boolean): Promise<void>;
  async recordRemove(path: string): Promise<void>;
  async recordTrash(path: string): Promise<void>;
  async close(): Promise<void>;
  getOperationCount(): number;

  // Private methods
  private async recordEntry(entry: HistoryEntry): Promise<void>;
  private recordEntryToDb(entry: HistoryEntry): void;
}
```

### Database CRUD Operations

Key functions in `src/lib/db.ts`:

```typescript
// Session operations
function createHistorySession(db: DbConnection, params: CreateHistorySessionParams): number;
function findHistorySession(db: DbConnection, sessionId: string): DbHistorySession | null;
function getHistorySessions(db: DbConnection, filter?: HistorySessionFilter): DbHistorySession[];
function closeHistorySession(db: DbConnection, sessionId: number, endedAt: string, operationCount: number): void;
function updateHistorySessionStatus(db: DbConnection, sessionId: string, status: SessionStatus): void;

// Operation recording
function recordHistoryOperation(db: DbConnection, params: RecordHistoryOperationParams): void;
function getHistoryOperations(db: DbConnection, sessionId: number): DbHistoryOperation[];
```

### Mode Selection Logic

In `src/lib/history.ts`:

```typescript
export async function createHistorySession(command: string, db?: DbConnection): Promise<HistoryRecorder> {
  let dbSessionId: number | undefined;

  // Database mode: create session record in database first
  if (db) {
    const sessionId = generateSessionId(command);
    dbSessionId = createHistorySessionInDb(db, {
      sessionId,
      version: HISTORY_VERSION,
      command,
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
    });
  }

  const recorder = new HistoryRecorder(command, { db, dbSessionId });
  await recorder.initialize();
  return recorder;
}
```

### Integration with Copy Actions

The history recorder is integrated into copy actions:

```typescript
// In copy-album.ts or copy-filter.ts
async function executeCopyWithHistory(options: CopyOptions, db?: DbConnection) {
  // Create history session
  const history = await createHistorySession("copy", db);

  try {
    // Process files
    for (const file of files) {
      const destPath = await copyFile(file.source, file.dest);
      await history.recordCopy(file.source, destPath);
    }

    // Close session on success
    await history.close();
  } catch (error) {
    // Session auto-closes on error, preserving recorded operations
    throw error;
  }
}
```

## Migration Notes

### Legacy JSONL Migration

When switching from legacy JSONL mode to database mode:

1. **Existing JSONL files remain untouched by the mode switch** - They are not deleted or modified
2. **New sessions go to the database** - All new history is stored in SQLite
3. **Manual migration is available** - Use `rfmedia migrate --history-only` for explicit control
4. **Undo can migrate automatically** - In database mode, `rfmedia undo` imports legacy history
   before processing

Each session is fully validated before import, committed atomically, and read back for exact
equivalence. An already-equivalent database session is also a successful migration outcome.
Malformed, incomplete, or conflicting JSONL files are retained.

### Auto-Migration During Undo

The undo command includes automatic migration:

```typescript
export async function executeUndo(options: UndoOptions, db?: DbConnection): Promise<UndoResult> {
  // Auto-migrate legacy history files if using database
  if (db) {
    await autoMigrateHistoryIfNeeded(db);
  }
  // ... rest of undo logic
}
```

### Manual Migration and Cleanup

Use one explicit history root for discovery and import:

```bash
# Use the configured/default history directory
rfmedia migrate --history-only

# Discover and import from this exact directory
rfmedia migrate --history-only --history-path=/path/to/history

# Remove only JSONL files proven imported or already equivalent
rfmedia migrate --history-only --history-path=/path/to/history --delete-old
```

`--delete-old` evaluates each proven file independently. Failed or unproven files remain available
for repair and retry, even when safe siblings are deleted. `--force` skips only the cleanup
confirmation; it cannot bypass durable equivalence, root containment, regular-file identity, or
symlink checks. Dry-run performs no database initialization, prompt, or deletion.

### What Gets Migrated

- Session headers (version, command, timestamps, status, cwd, operation count)
- All operation entries (type, timestamps, paths, format)
- Session status preserved (pending, undone, partial)

### What Does NOT Get Migrated

- Original JSONL files are not deleted unless `--delete-old` receives durable per-file proof
- Malformed, partial, conflicting, changed, or unsafe JSONL files are not deleted
- File modification times are not preserved
- Custom metadata outside the standard schema

## Troubleshooting

### Common Issues

#### 1. "No undoable sessions found"

**Cause:** All sessions have status `undone` or `partial`, or history is disabled.

**Solutions:**

```bash
# Check if history is enabled in config
cat .rfmedia.json | jq '.undo.enabled'

# Check database for all sessions (not just pending)
sqlite3 ~/.rfmedia/tracking.db "SELECT session_id, status FROM history_sessions"

# Verify history was recorded for recent operations
sqlite3 ~/.rfmedia/tracking.db \
  "SELECT COUNT(*) FROM history_sessions WHERE started_at > datetime('now', '-1 day')"
```

#### 2. "Session not found"

**Cause:** Session ID is incorrect or session is in legacy JSONL format while using database mode.

**Solutions:**

```bash
# List all session IDs
rfmedia undo --list

# Check legacy history directory
ls -la ~/.rfmedia/history/

# Force legacy mode for old sessions
# Edit .rfmedia.json: "undo": { "useLegacy": true }
```

#### 3. "Failed to undo operation: ENOENT"

**Cause:** File was already deleted or moved.

**Solution:** This is normal - the system skips already-removed files and continues.

#### 4. "Directory not empty, skipping"

**Cause:** mkdir operation created a directory that now contains files from other operations.

**Solution:** This is expected behavior - only empty directories created by the session are removed during undo.

### Checking History State in Database

```bash
# Open database
sqlite3 ~/.rfmedia/tracking.db

# Check session counts by status
SELECT status, COUNT(*) as count
FROM history_sessions
GROUP BY status;

# Find sessions with failures
SELECT session_id, operation_count, started_at
FROM history_sessions
WHERE status = 'partial';

# Check for orphaned operations (should be 0)
SELECT COUNT(*)
FROM history_operations ho
LEFT JOIN history_sessions hs ON ho.session_id = hs.id
WHERE hs.id IS NULL;

# Verify foreign key constraints
PRAGMA foreign_key_check;

# Check database integrity
PRAGMA integrity_check;
```

### Debugging Mode Selection

Add debug logging to see which mode is being used:

```bash
# Run with debug flag
rfmedia undo --list --debug

# Look for log messages like:
# [DEBUG] History session initialized in database mode: 2026-01-18T10-30-45Z-copy-12345
# or
# [DEBUG] Created history session: 2026-01-18T10-30-45Z-copy-12345
```

### Recovery from Corrupted Database

If the database is corrupted:

```bash
# Backup existing database
cp ~/.rfmedia/tracking.db ~/.rfmedia/tracking.db.bak

# Check integrity
sqlite3 ~/.rfmedia/tracking.db "PRAGMA integrity_check"

# If corrupted, remove and let rfmedia recreate
rm ~/.rfmedia/tracking.db

# Next command will create fresh database
rfmedia copy /source /dest --range=001-001 --dry-run
```

## Key Files

| File                   | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `src/lib/history.ts`   | HistoryRecorder class and session management                  |
| `src/lib/db.ts`        | Database CRUD operations for history tables                   |
| `src/lib/schema.sql`   | SQLite schema including history tables                        |
| `src/actions/undo.ts`  | Undo action implementation                                    |
| `src/commands/undo.ts` | Undo command CLI definition                                   |
| `src/types/history.ts` | TypeScript types for history system                           |
| `src/types/db.ts`      | Database types including DbHistorySession, DbHistoryOperation |
| `src/types/config.ts`  | Configuration types including UndoConfigOptions               |

## Related Documentation

- [Tracking System](packages/rfmedia-cli/docs/features/tracking-system.md) - Granular tracking with range expansion
- [Centralized Tracking Database](packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md) - Database architecture overview
- [CLAUDE.md](packages/rfmedia-cli/CLAUDE.md) - Undo/History System section
