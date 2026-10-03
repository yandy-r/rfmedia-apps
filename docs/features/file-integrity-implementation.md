# File Integrity Verification - Technical Implementation

**Branch**: `issue-41/verify-integrity`  
**Issue**: #41

## Architecture

### Module Structure

```
packages/rfmedia-cli/src/
├── lib/
│   ├── integrity.ts          # Core integrity verification logic
│   └── integrity.test.ts     # Unit tests
├── commands/
│   └── copy.ts               # CLI option parsing
├── actions/
│   └── copy-album.ts         # Integration into copy workflow
└── types/
    ├── options.ts            # TypeScript interfaces for options
    └── config.ts             # TypeScript interfaces for config
```

## Code Changes

### 1. New Files

#### `integrity.ts` (54 lines)

```typescript
// Core functions:
- calculateHash(filePath: string): Promise<string>
- verifyFileIntegrity(sourcePath: string, destPath: string): Promise<boolean>
```

**Key Implementation Details:**

- Uses `crypto.createHash('sha256')` for hashing
- Streams files using `fs.createReadStream()` to handle large files
- Uses `stream/promises.pipeline()` for proper backpressure handling
- Parallel hash calculation with `Promise.all()`
- Comprehensive debug logging

#### `integrity.test.ts` (100 lines)

**Test Coverage:**

- Mock-based unit tests using Vitest
- Tests for successful hash calculation
- Tests for pipeline failures
- Tests for matching/mismatching hashes
- Tests for missing destination files

### 2. Modified Files

#### `copy.ts` Changes

```typescript
// Added to RawCopyOptions interface
interface RawCopyOptions {
  // ... existing options
  verify?: boolean;  // NEW
}

// Added to buildCopyOptions()
verify: rawOptions.verify ?? copyConfig.verify ?? false,

// Added CLI options
.addOption(new Option("--verify", "Verify file integrity after copy (SHA-256 checksum)"))
.addOption(new Option("--no-verify", "Disable file integrity verification"))
```

#### `copy-album.ts` Changes

**Function Signature Updates:**

```typescript
// Before
async function copyDirectoryWithConversion(
  sourceDir: string,
  destDir: string,
  options: { hardlink: boolean; convertFormat?: ConvertFormat; recorder?: HistoryRecorder },
  // ...
);

// After
async function copyDirectoryWithConversion(
  sourceDir: string,
  destDir: string,
  options: {
    hardlink: boolean;
    convertFormat?: ConvertFormat;
    recorder?: HistoryRecorder;
    verify?: boolean; // NEW
  },
  // ...
);
```

**Verification Logic Insertion:**

```typescript
// After file copy, before hooks
if (options.verify) {
  try {
    const valid = await verifyFileIntegrity(sourcePath, finalDestPath);
    if (!valid) {
      await remove(finalDestPath); // Cleanup corrupted file
      throw new Error(`Integrity check failed for ${entry.name}`);
    }
  } catch (error) {
    logError(`Verification failed for ${entry.name}: ${(error as Error).message}`);
    throw error;
  }
}
```

**Call Site Updates:**

```typescript
// Pass verify option through
await copyDirectoryWithConversion(
  albumSource,
  task.destPath,
  { hardlink, convertFormat, recorder, verify: options.verify }, // Added verify
  onProgress,
  signal,
);
```

#### `config.ts` Changes

```typescript
// Added validation for verify config option
if ("verify" in raw && raw["verify"] !== undefined) {
  config.verify = validateBoolean(raw["verify"], "copy.verify", configPath);
}
```

#### Type Definition Changes

**`options.ts`:**

```typescript
export interface CopyOptions {
  // ... existing options
  verify?: boolean; // NEW: Verify file integrity after copy using SHA-256 checksum
}
```

**`config.ts`:**

```typescript
export interface CopyConfigOptions {
  // ... existing options
  /**
   * Verify file integrity after copy using SHA-256 checksum.
   * If verification fails, the copy is considered failed.
   */
  verify?: boolean; // NEW
}
```

### 3. Shell Completion Updates

Updated all three shell completion scripts to include `--verify` option:

- `bash.ts`
- `fish.ts`
- `zsh.ts`

## Data Flow

### Option Resolution

```
CLI Flag (--verify/--no-verify)
    ↓
    ├─ If present → Use CLI value
    └─ If absent → Check config
                      ↓
                      ├─ If in config → Use config value
                      └─ If not in config → Default to false
```

### Copy + Verify Flow

```
1. Parse CLI options
   ↓
2. Resolve verify option (CLI > Config > Default)
   ↓
3. For each file to copy:
   ├─ Copy file (hardlink/copy/convert)
   ├─ If verify=true and operation was copy/hardlink (skip for convert):
   │  ├─ Calculate source hash
   │  ├─ Calculate dest hash
   │  ├─ Compare hashes
   │  └─ If mismatch:
   │     ├─ Delete dest file
   │     └─ Throw error
   └─ Run afterCopy hooks
```

## Error Handling Strategy

### Verification Failures

1. **Hash Mismatch**:
   - Log error with file details
   - Delete corrupted destination file
   - Throw error to abort operation
   - Prevents corrupted files from remaining in library

2. **Read Errors**:
   - Log error with file path and reason
   - Re-throw error to abort operation
   - No cleanup needed (file wasn't created or is inaccessible)

3. **Cleanup Guarantee**:
   - All verification failures result in destination file deletion
   - Uses `fs-extra.remove()` for reliable cleanup
   - Errors during cleanup are not caught (fail-fast)

## Performance Analysis

### Time Complexity

- **Without Verification**: O(n) where n = file size (single copy operation)
- **With Verification**: O(3n) where n = file size
  - 1x read for copy
  - 1x read for source hash
  - 1x read for destination hash

### Space Complexity

- **Memory**: O(1) - streaming approach, constant memory regardless of file size
- **Disk**: O(2n) temporarily during copy (source + destination)

### Optimization Techniques

1. **Parallel Hashing**: Source and destination hashes calculated concurrently
2. **Streaming**: No full file buffering, uses Node.js streams
3. **Backpressure Handling**: `pipeline()` properly manages stream backpressure

## Testing Strategy

### Unit Tests (Current)

- ✅ Mock-based tests for `calculateHash()`
- ✅ Mock-based tests for `verifyFileIntegrity()`
- ✅ Error path coverage

### Integration Tests (Planned)

- [ ] Real file copy + verification
- [ ] Large file handling (>1GB)
- [ ] Corrupted file detection
- [ ] Performance benchmarks

### Test Data Requirements

- Small files (< 1MB) for quick tests
- Medium files (10-100MB) for realistic scenarios
- Large files (>1GB) for stress testing
- Intentionally corrupted files for failure testing

## Configuration Schema

```yaml
# .rfmedia.yaml
copy:
  # Enable file integrity verification
  # Type: boolean
  # Default: false
  # CLI Override: --verify / --no-verify
  verify: true
```

## Dependencies

### Runtime Dependencies

- `node:crypto` - SHA-256 hashing
- `node:fs` - File reading
- `node:stream/promises` - Stream pipeline
- `fs-extra` - File removal (already in project)

### Development Dependencies

- `vitest` - Testing framework (already in project)

## Security Considerations

### Hash Algorithm Choice

- **SHA-256**: Cryptographically secure, industry standard
- **Collision Resistance**: Extremely unlikely for accidental corruption
- **Performance**: Fast enough for real-time verification

### Attack Vectors

- **Not Designed For**: Malicious tampering detection (no signature verification)
- **Designed For**: Accidental corruption detection during copy operations

## Backward Compatibility

- ✅ Default behavior unchanged (verify=false)
- ✅ No breaking changes to existing APIs
- ✅ Purely additive feature
- ✅ Config files without `verify` option continue to work

## Migration Path

### For Users

1. **No Action Required**: Feature is opt-in, default behavior unchanged
2. **To Enable**: Add `--verify` flag or set `copy.verify: true` in config
3. **Performance Impact**: ~2x slower due to additional file reads

### For Developers

1. **No Code Changes Required**: All changes are internal to copy module
2. **Hook Compatibility**: Verification runs before hooks, no hook changes needed
3. **Extension Points**: Can be extended for other verification methods

## Future Considerations

### Potential Enhancements

1. **Incremental Verification**: Only verify changed portions of files
2. **Hash Caching**: Store hashes to avoid recalculation
3. **Alternative Algorithms**: Support MD5, SHA-1 for compatibility
4. **Parallel Verification**: Verify multiple files concurrently
5. **Progress Reporting**: Show verification progress for large files

### Scalability

- **Current**: Sequential verification, one file at a time
- **Future**: Could parallelize verification across multiple files
- **Bottleneck**: Disk I/O, not CPU (hashing is fast)

## Monitoring and Observability

### Logging

- **Debug Level**: Hash values, comparison results
- **Error Level**: Verification failures, file paths
- **Info Level**: None (silent success)

### Metrics (Future)

- Verification success rate
- Average verification time
- Files verified per operation
- Corruption detection rate

## Related Documentation

- [File Integrity Verification Feature Doc](./file-integrity-verification.md)
- [Copy Command Reference](../reference/copy-command.md)
- [Configuration Guide](../guides/configuration.md)
