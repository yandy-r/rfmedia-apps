# Half-Star Ratings Support

This document describes the half-star rating support feature, which enables precise rating-based filtering with 1.0-5.0 star range (including increments like 3.5 stars).

## Overview

The `--min-stars` option now accepts float values between 1.0 and 5.0, allowing half-star precision for rating-based filtering. This enhancement affects all commands that support rating filtering: copy, verify, watch, and sync.

## User Interface

### Command Line Option

```bash
# Filter tracks rated 3.5+ stars
rfmedia copy "/music/Artist" /dest --min-stars=3.5

# Integer values still work (backward compatible)
rfmedia copy "/music/Artist" /dest --min-stars=4

# Available in all filtering commands
rfmedia verify "/music/Artist" /dest --min-stars=3.5
rfmedia watch "/music/incoming" /dest --mode=filter --min-stars=3.5
rfmedia sync --file=sources.txt /dest --min-stars=3.5
```

### Configuration File

```json
{
  "copy": {
    "minStars": 3.5
  }
}
```

### Shell Completions

All shells (bash, zsh, fish) provide half-star suggestions:

```
1 1.5 2 2.5 3 3.5 4 4.5 5
```

## Format-Specific Precision

Actual rating precision depends on the audio format's metadata storage:

| Format   | Metadata System    | Precision   | Notes                                                |
| -------- | ------------------ | ----------- | ---------------------------------------------------- |
| MP3      | POPM (0-255 scale) | ~0.02 stars | 255 discrete levels mapped to 5 stars                |
| FLAC     | Vorbis Comment     | Arbitrary   | Float values stored directly (0.0-1.0 or 0.0-5.0)    |
| OGG/Opus | Vorbis Comment     | Arbitrary   | Same as FLAC                                         |
| M4A      | iTunes rating      | Limited     | iTunes stores ratings in database, not file metadata |

### MP3 POPM Precision Example

MP3 files use the Popularimeter (POPM) frame with a 0-255 byte value:

- 255 / 5 = 51 levels per star
- Precision: 5 / 255 ≈ 0.02 stars
- A threshold of 3.5 stars translates to ~178/255

### FLAC/Vorbis Precision

FLAC and OGG files store ratings as text values in Vorbis Comments, supporting arbitrary precision. The format auto-detects the scale:

- `0.0-1.0` scale (normalized)
- `0-5` scale (stars)
- `0-100` scale (percentage)

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLI Option Parsing                           │
├─────────────────────────────────────────────────────────────────┤
│  1. parseFloatArg() parses string to float                      │
│  2. Validates range: 1.0 <= value <= 5.0                        │
│  3. Passes float value to RatingFilter interface                │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Config Validation                            │
├─────────────────────────────────────────────────────────────────┤
│  validateStarRating() accepts float values (1.0-5.0)            │
│  No longer requires integer values                              │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Rating Comparison (ratings.ts)               │
├─────────────────────────────────────────────────────────────────┤
│  meetsThreshold(rating, filter):                                │
│  1. Convert minStars to normalized scale: threshold / 5.0       │
│  2. Compare: rating >= normalizedThreshold                      │
│  3. No rounding - preserves float precision                     │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    normalizedToStars(rating)                    │
├─────────────────────────────────────────────────────────────────┤
│  Returns: rating * 5 (no Math.round())                          │
│  Example: 0.7 -> 3.5 stars (previously rounded to 4)            │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Files

| File                          | Purpose                                      |
| ----------------------------- | -------------------------------------------- |
| `src/lib/ratings.ts`          | Core rating functions with float precision   |
| `src/commands/copy.ts`        | CLI option parsing with `parseFloatArg()`    |
| `src/commands/verify.ts`      | CLI option parsing with `parseFloatArg()`    |
| `src/commands/watch.ts`       | CLI option parsing with `parseFloatArg()`    |
| `src/commands/sync.ts`        | CLI option parsing with `parseFloatArg()`    |
| `src/lib/config.ts`           | Config validation for float `minStars`       |
| `src/types/options.ts`        | Type documentation for `RatingFilter`        |
| `src/lib/shell-completions/*` | Shell completions with half-star suggestions |

## Key Functions

### parseFloatArg (in each command file)

```typescript
function parseFloatArg(value: string, optionName: string = "value"): number {
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number for ${optionName}: ${value}`);
  }
  if (parsed < 1.0 || parsed > 5.0) {
    throw new Error(`${optionName} must be between 1.0 and 5.0, got ${parsed}`);
  }
  return parsed;
}
```

### normalizedToStars (ratings.ts)

```typescript
// Before: return Math.round(rating * 5);
// After:
export function normalizedToStars(rating: number): number {
  return rating * 5; // Preserves float precision
}
```

### meetsThreshold (ratings.ts)

```typescript
export function meetsThreshold(rating: number, filter: RatingFilter): boolean {
  if (filter.minStars !== undefined) {
    // Direct comparison on normalized scale for precision
    const normalizedThreshold = starsToNormalized(filter.minStars);
    return rating >= normalizedThreshold;
  }
  // ... minRating handling
}
```

### validateStarRating (config.ts)

```typescript
function validateStarRating(value: unknown, propertyPath: string, configPath: string): number {
  // Changed: removed Number.isInteger() check
  if (typeof value !== "number" || value < 1 || value > 5) {
    throw new ConfigError(
      `Expected number between 1.0 and 5.0 for ${propertyPath}, got ${value}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}
```

## Backward Compatibility

This feature is fully backward compatible:

- Integer values (1-5) continue to work exactly as before
- Existing config files with integer `minStars` values are unchanged
- The `--min-rating` option (0-100 scale) is unaffected

## Usage Examples

### Basic Half-Star Filtering

```bash
# Copy tracks rated 3.5+ stars
rfmedia copy "/music/Artist" /dest --min-stars=3.5

# Verify tracks rated 2.5+ stars
rfmedia verify "/music/Artist" /dest --min-stars=2.5

# Watch for 4.5+ star tracks
rfmedia watch "/music/incoming" /dest --mode=filter --min-stars=4.5
```

### Combined with Other Options

```bash
# Half-star filter with album mode
rfmedia copy "/music/Artist" /dest --min-stars=3.5 --range=001-005

# Half-star filter with conversion
rfmedia copy "/music/Artist" /dest --min-stars=3.5 --convert=mp3

# Half-star filter with preserve structure
rfmedia copy "/music/Artist" /dest --min-stars=3.5 --preserve-structure
```

### Config File Usage

```json
{
  "copy": {
    "minStars": 3.5,
    "outputFolder": "half-star-test",
    "preserveStructure": true
  }
}
```

## Design Decisions

### Why Remove Math.round()?

The original `normalizedToStars()` function rounded the result, preventing half-star precision. For a track with normalized rating 0.7 (3.5 stars), rounding would return 4, preventing precise filtering at the 3.5 threshold.

### Why Threshold Comparison on Normalized Scale?

Converting the threshold to normalized scale (0.0-1.0) before comparison avoids precision loss from multiple conversions. The stored rating and threshold are compared directly without intermediate rounding.

### Why parseFloat Instead of parseInt?

The `parseFloatArg()` function uses `parseFloat()` to accept both integer (`4`) and decimal (`3.5`) input formats, supporting the full 1.0-5.0 range.

## Precision Considerations

When using half-star ratings with MP3 files (POPM format), be aware of quantization:

- POPM stores 0-255, giving ~0.02 star precision
- A track rated at exactly 3.5 stars might store as 178/255
- When read back: 178/255 \* 5 = 3.49 stars
- With threshold 3.5: track might be filtered out due to rounding

For critical half-star filtering of MP3 files, consider using slightly lower thresholds (e.g., 3.49 instead of 3.5) or use the `--min-rating` option for more precise control.

## Related Documentation

- README.md - User-facing documentation with half-star examples
- CLAUDE.md - Technical details for rating detection
- docs/features/audio-conversion.doc.md - Format handling details
