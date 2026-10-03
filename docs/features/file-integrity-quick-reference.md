# File Integrity Verification - Quick Reference

## Overview

SHA-256 checksum-based file integrity verification for `rfmedia copy` when performing byte-identical
copies or hardlinks (not for transcoded/converted outputs).

**Branch**: `issue-41/verify-integrity`  
**Issue**: [#41](https://github.com/yandy-r/rfmedia-apps/issues/41)  
**Status**: 🚧 In Development

## Quick Start

### Enable Verification

```bash
# Via CLI flag
rfmedia copy --verify --paths /music/Artist/Album

# Via config file
echo "copy:\n  verify: true" >> .rfmedia.yaml
rfmedia copy --paths /music/Artist/Album
```

### Disable Verification

```bash
# Explicit disable (overrides config)
rfmedia copy --no-verify --paths /music/Artist/Album
```

## Command Line Options

| Option        | Description                                       |
| ------------- | ------------------------------------------------- |
| `--verify`    | Enable SHA-256 integrity verification after copy  |
| `--no-verify` | Disable integrity verification (overrides config) |

## Configuration

```yaml
# .rfmedia.yaml
copy:
  verify: true # Enable by default
```

## How It Works

1. File is copied (hardlink, copy, or convert)
2. If `verify=true` and the operation was a **copy or hardlink** (not conversion):
   - Calculate SHA-256 hash of source file
   - Calculate SHA-256 hash of destination file
   - Compare hashes (byte-identity check)
   - If mismatch: delete destination file and abort
3. If the operation was a **conversion** (`--convert`), verification is skipped (source and
   destination content differ by design).
4. Continue with post-copy hooks

## What Gets Verified

- ✅ **Byte-identical copies** – source and destination hashes are compared
- ✅ **Hardlinked files** – same inode, hashes match
- ✅ **Regular copied files** – full hash comparison
- ⏭️ **Converted/transcoded outputs** – not verified (source and destination are different formats;
  use verification only for copy/hardlink operations)

## Error Behavior

### Verification Failure

```
Error: Integrity check failed for track.mp3
```

**What Happens:**

1. Corrupted destination file is deleted
2. Operation aborts with error
3. No corrupted files remain in library

### File Read Error

```
Error: Verification failed for track.mp3: ENOENT: no such file or directory
```

**What Happens:**

1. Operation aborts with error
2. Original error is preserved and re-thrown

## Performance Impact

- **Time**: ~2x slower (additional file reads for hashing)
- **Memory**: Minimal (streaming approach)
- **CPU**: Low (SHA-256 is fast)
- **Disk I/O**: 2x reads (source + destination)

### Benchmarks (Estimated)

| File Size | Copy Time | Verify Time | Total Time |
| --------- | --------- | ----------- | ---------- |
| 5 MB      | 0.1s      | 0.1s        | 0.2s       |
| 50 MB     | 0.5s      | 0.5s        | 1.0s       |
| 500 MB    | 5s        | 5s          | 10s        |

_Actual times vary based on disk speed_

## Use Cases

### When to Enable

- ✅ Archival copies (long-term storage)
- ✅ Network file systems (higher corruption risk)
- ✅ External drives (USB, NAS)
- ✅ Critical backups
- ✅ After hardware issues

### When to Disable

- ❌ Local SSD copies (low corruption risk)
- ❌ Time-sensitive operations
- ❌ Trusted source and destination
- ❌ Testing/development

## Examples

### Basic Album Copy

```bash
rfmedia copy --verify --paths /music/Pink\ Floyd/The\ Wall
```

### Range Copy with Verification

```bash
rfmedia copy --verify --range 1-3 --paths /music/Pink\ Floyd/The\ Wall
```

### Batch Copy with Verification

```bash
rfmedia copy --verify --paths \
  /music/Artist1/Album1 \
  /music/Artist2/Album2 \
  /music/Artist3/Album3
```

### Conversion with Verification

```bash
rfmedia copy --verify --convert flac --paths /music/Artist/Album
```

With `--convert`, only byte-identical operations (e.g. non-audio files) are hash-verified; converted
audio files are skipped (source and destination content differ by design).

## Troubleshooting

### Verification Always Fails

**Possible Causes:**

- Source file is corrupted
- Disk errors during copy
- Filesystem issues
- Insufficient permissions

**Solutions:**

1. Check source file integrity
2. Run disk diagnostics
3. Check filesystem health
4. Verify file permissions

### Slow Performance

**Possible Causes:**

- Large files
- Slow disk I/O
- Network filesystem

**Solutions:**

1. Disable verification for local copies: `--no-verify`
2. Enable only for critical operations
3. Use faster storage
4. Copy to local disk first, then verify

### Files Deleted After Copy

**This is expected behavior!**

If verification fails, the corrupted destination file is automatically deleted to prevent corrupted
files from remaining in your library.

**To investigate:**

1. Check source file integrity
2. Review debug logs: `rfmedia copy --verify --verbose`
3. Test with smaller files
4. Check disk health

## Debug Logging

Enable verbose logging to see verification details:

```bash
rfmedia copy --verify --verbose --paths /music/Artist/Album
```

**Output includes:**

- Hash calculation progress
- Source and destination hash values
- Comparison results
- Verification success/failure

## Files Modified

### New Files

- `packages/rfmedia-cli/src/lib/integrity.ts` - Core verification logic
- `packages/rfmedia-cli/src/lib/integrity.test.ts` - Unit tests

### Modified Files

- `packages/rfmedia-cli/src/commands/copy.ts` - CLI options
- `packages/rfmedia-cli/src/actions/copy-album.ts` - Integration
- `packages/rfmedia-cli/src/types/options.ts` - Type definitions
- `packages/rfmedia-cli/src/types/config.ts` - Config types
- `packages/rfmedia-cli/src/lib/config.ts` - Config validation
- Shell completion scripts (bash, fish, zsh)

## Testing

### Run Unit Tests

```bash
cd packages/rfmedia-cli
npm test -- integrity.test.ts
```

### Manual Testing

```bash
# Create test files
mkdir -p /tmp/test-source /tmp/test-dest

# Copy with verification
rfmedia copy --verify --paths /tmp/test-source

# Verify logs
rfmedia copy --verify --verbose --paths /tmp/test-source
```

## Next Steps

### Before Merge

- [ ] Integration tests with real files
- [ ] Performance benchmarks
- [ ] User documentation updates
- [ ] Example configurations

### Future Enhancements

- [ ] Progress indication during verification
- [ ] Batch verification summary report
- [ ] Hash caching for unchanged files
- [ ] Alternative hash algorithms (MD5, SHA-1)

## Related Documentation

- [Feature Documentation](./file-integrity-verification.md) - Complete feature overview
- [Technical Implementation](./file-integrity-implementation.md) - Architecture and code details
- [Copy Command Reference](../reference/copy-command.md) - Full command documentation

## Support

For issues or questions:

- GitHub Issue: [#41](https://github.com/yandy-r/rfmedia-apps/issues/41)
- Branch: `issue-41/verify-integrity`
