# Parallel Processing

This document describes the parallel processing feature for the copy command, which enables concurrent file operations to improve performance.

## Overview

The copy command supports parallel processing via the `-w, --workers` option. This allows multiple file operations (copies, rating reads, conversions) to execute concurrently, significantly improving throughput for large music libraries.

## User Interface

### Command Line Option

```bash
rfmedia-cli copy <source> <destination> --range=001-010 --workers=4

# Short form
rfmedia-cli copy <source> <destination> -r 001-010 -w 4
```

### Default Behavior

- **Auto-detection**: By default, workers = half of CPU cores
- **Minimum**: 1 worker (sequential processing)
- **Maximum**: 8 workers (prevents resource exhaustion)

Example on an 8-core machine: default is 4 workers.

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        Copy Command                              │
├─────────────────────────────────────────────────────────────────┤
│  1. Parse --workers option (or use auto-detected default)       │
│  2. Validate: clamp to 1-8 range                                │
│  3. Pass workers count to action handler                        │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Album Mode (copy-album.ts)                   │
├─────────────────────────────────────────────────────────────────┤
│  For each album:                                                │
│  1. Create first copy SEQUENTIALLY (establishes source)         │
│  2. Process remaining copies IN PARALLEL                        │
│     - Uses p-limit to control concurrency                       │
│     - Copies from first copy (optimization)                     │
│     - Reports progress via onProgress callback                  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Filter Mode (copy-filter.ts)                  │
├─────────────────────────────────────────────────────────────────┤
│  Phase 1: Rating scan (parallel)                                │
│  - Read ratings for all audio files concurrently                │
│  - Group liked tracks by album                                  │
│                                                                 │
│  Phase 2: File copies (parallel)                                │
│  - First suffix copy: sequential (establishes source)           │
│  - Remaining suffixes: parallel copy from first copy            │
│                                                                 │
│  Per-track mode: process all tracks in parallel                 │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Files

| File                         | Purpose                                          |
| ---------------------------- | ------------------------------------------------ |
| `src/lib/parallel.ts`        | Core parallel processing utilities using p-limit |
| `src/commands/copy.ts`       | CLI option definition and validation             |
| `src/actions/copy-album.ts`  | Album mode integration with parallel processing  |
| `src/actions/copy-filter.ts` | Filter mode integration with parallel processing |

## Key Functions

### parallel.ts

- `getDefaultWorkers()`: Returns half of CPU cores, clamped to 1-8
- `validateWorkers(n)`: Clamps input to valid range (1-8)
- `createTaskQueue(n)`: Creates a p-limit instance for concurrency control
- `processInParallel(items, processor, options)`: Main parallel processing function

### ParallelResult Interface

```typescript
interface ParallelResult<T> {
  success: boolean;
  value?: T;
  error?: Error;
  index: number; // Original array index for result correlation
}
```

### ParallelOptions Interface

```typescript
interface ParallelOptions {
  workers: number;
  onProgress?: (completed: number, total: number) => void;
}
```

## Design Decisions

### Why p-limit?

The `p-limit` library provides simple, reliable concurrency limiting. It prevents overwhelming the filesystem with too many open file handles (EMFILE errors) while maximizing throughput.

### Why Sequential First Copy?

For range-based copying (e.g., `--range=001-010`), the first copy must complete before subsequent copies begin. This enables an optimization where subsequent copies use the first copy as source rather than the original, which is faster especially with hardlinks.

### Why Max 8 Workers?

Testing showed diminishing returns beyond 8 parallel operations for file I/O. Higher concurrency risks:

- File descriptor exhaustion (EMFILE)
- Disk thrashing
- Memory pressure from buffered reads/writes

### Error Handling

Parallel processing collects all errors without stopping on first failure. This allows partial success when some files fail (e.g., permission errors) while others succeed. Results include the original array index for correlating failures with input items.

## Performance Considerations

| Scenario                  | Sequential | 4 Workers | Improvement |
| ------------------------- | ---------- | --------- | ----------- |
| 100 small files           | ~10s       | ~3s       | 3x          |
| 10 albums x 10 copies     | ~60s       | ~20s      | 3x          |
| Large library rating scan | ~30s       | ~8s       | 4x          |

_Actual performance depends on disk speed, file sizes, and system resources._

## Progress Reporting

The `onProgress` callback enables UI updates during parallel processing:

```typescript
await processInParallel(items, processor, {
  workers: 4,
  onProgress: (completed, total) => {
    task.title = `Processing (${completed}/${total})`;
  },
});
```

Debug logging shows progress at the DEBUG log level.

## Related Documentation

- README.md - Copy command usage examples
- CLAUDE.md - Development patterns for parallel processing
