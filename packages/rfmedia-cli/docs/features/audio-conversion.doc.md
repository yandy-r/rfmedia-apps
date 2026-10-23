# Audio Conversion

The copy and sync workflows can transcode recognized audio files while preserving supported
metadata and publishing only validated output.

## Usage

Use `-c, --convert` with an existing copy or sync command:

```bash
# Apple Lossless
rfmedia copy /source /destination --range=001-010 --convert=alac

# MP3
rfmedia copy /source /destination --min-stars=4 --convert=mp3

# Short form
rfmedia copy /source /destination -r 001-010 -c aac
```

Conversion applies only to recognized audio files. Cover files, playlists, and other non-audio
files continue through the normal copy or hardlink path.

### Targets

| Target | Codec        | Container and extension | Encoding setting |
| ------ | ------------ | ----------------------- | ---------------- |
| `mp3`  | `libmp3lame` | MP3 (`.mp3`)            | 320 kbps         |
| `aac`  | `aac`        | M4A (`.m4a`)            | 256 kbps         |
| `alac` | `alac`       | M4A (`.m4a`)            | Lossless         |
| `opus` | `libopus`    | Ogg Opus (`.opus`)      | 128 kbps         |

With a range, the first destination is converted from the source and later copies reuse that
converted file. Hardlinks can therefore apply to later copies, but conversion itself always creates
new audio bytes.

## Dependencies

- Node.js >= 22.23.4, as required by the CLI package.
- `ffmpeg` available in `PATH`, with the selected encoder enabled.
- Linux or macOS for descriptor-backed conversion publication. Conversion fails closed on hosts
  that cannot expose inherited file descriptors to FFmpeg and the isolated MP3 rating worker.

The empirical matrix below used FFmpeg and ffprobe 8.1.2. That version records the verification
environment; it is not a new minimum-version promise. ffprobe was used to inspect the test outputs
and is not a new command-line or configuration requirement.

Install FFmpeg using the package manager for the host system, for example:

```bash
# Ubuntu/Debian
sudo apt install ffmpeg

# macOS
brew install ffmpeg
```

The CLI checks FFmpeg availability before a requested conversion.

## Verified Compatibility Matrix

The final integration probe converted four source tag models to every target, for 16 successful
cases:

| Source metadata model | MP3  | AAC/M4A | ALAC/M4A | Opus |
| --------------------- | ---- | ------- | -------- | ---- |
| ID3                   | Pass | Pass    | Pass     | Pass |
| FLAC/Vorbis           | Pass | Pass    | Pass     | Pass |
| MP4/iTunes            | Pass | Pass    | Pass     | Pass |
| Tagless               | Pass | Pass    | Pass     | Pass |

Each pass required a playable audio output, the expected target codec/container, and successful
semantic audit of every field supported by that target. Format-specific limitations were reported
as non-fatal warnings rather than silently treated as preserved.

The probe verified these details:

- canonical title, artist, album, date/year, genre, and track `3/12` survived when present;
- the selected primary cover had the exact source digest in every supporting target;
- MP3 preserved the normalized rating as POPM, including its email provenance and counter;
- Opus preserved normalized rating, compatible custom text, and comment semantics;
- Opus `METADATA_BLOCK_PICTURE` appeared through ffprobe as one `attached_pic` stream, with zero
  non-attached playback video streams;
- AAC and ALAC used standard M4A metadata fields without `use_metadata_tags`;
- tagless sources did not acquire user metadata merely to satisfy the audit.

## Preservation Contract

### Canonical Metadata

When present, the conversion audit requires preservation of:

- title;
- artists;
- album;
- track number and total;
- date and year;
- genres.

Text comparison normalizes canonical Unicode for semantic comparison. Artist and genre order may
change, but their values must remain present.

### Artwork

The primary cover is selected deterministically, preferring a front cover, and is preserved with an
exact SHA-256 digest match. Only its bounded payload crosses the metadata parser boundary. Attached
artwork targets receive that selected payload through an unlinked inherited descriptor; the
implementation does not assume the parser's picture-array index is an FFmpeg video-stream index.

When a source contains more than one picture, the conversion remains usable but emits
`additional_artwork_unsupported`: only the primary picture is guaranteed. A missing or changed
primary picture is a fatal audit failure, so the staged output is not published.

For Opus, the primary image is written as `METADATA_BLOCK_PICTURE`. Tools such as ffprobe may expose
that block as an attached-picture video stream; it is cover metadata, not playback video.

### Ratings

| Target | Behavior                                                                            |
| ------ | ----------------------------------------------------------------------------------- |
| MP3    | Preserves a positive rating as POPM, including bounded email provenance and counter |
| Opus   | Preserves a positive normalized rating as a Vorbis `RATING` comment                 |
| AAC    | Emits `rating_unsupported`; standard M4A mapping does not represent the rating      |
| ALAC   | Emits `rating_unsupported`; standard M4A mapping does not represent the rating      |

MP3 comparison allows the unavoidable POPM `0..255` quantization step. Opus writes six decimal
places and audits at that precision.

### Custom and Native Tags

Compatible custom text is mapped and audited for MP3 and Opus. Custom identity and values remain
case-sensitive and byte-exact; arbitrary custom values are not Unicode-normalized.

The audit recognizes only narrow, verified comment aliases across containers:

- ID3 `COMM` and `TXXX:comment`;
- Vorbis `COMMENT` and `DESCRIPTION`;
- iTunes `©cmt`.

The text of a structured ID3 `COMM` frame remains portable comment text. A non-empty `COMM`
descriptor is not guaranteed to survive container conversion, so it is reported additively as
`native_tag_unsupported` (`COMM:descriptor`) instead of being silently claimed as preserved.

Other custom keys retain their exact semantic descriptor. Destination-only tags introduced by
FFmpeg or the container do not imply source loss, but every compatible source custom key/value must
be present in the destination.

Custom descriptors that would collide with canonical or generated Opus keys, such as `TITLE`,
`ALBUM`, or `RATING`, are not serialized as custom comments. They produce
`custom_tag_unsupported`. `TXXX:MOOD`, for example, remains a compatible custom tag.

AAC and ALAC use the standard M4A mapping and warn for unsupported custom text. Structured or
binary native fields that cannot be portably flattened produce `native_tag_unsupported`.
FFmpeg/container implementation tags and encoder tags are ignored by the preservation audit.

## Warning and Failure Behavior

The conversion result contains deterministic, structured warnings:

```typescript
interface ConversionResult {
  outputPath: string;
  duration: number;
  success: boolean;
  warnings: readonly ConversionWarning[];
  error?: string;
}
```

Warnings describe known target limitations and set `outputUsable: true`. Human warning rendering
escapes terminal control characters in paths and fields. Warning fields contain safe identifiers,
not private tag values or rating provenance.

Known limitations are warnings:

- additional non-primary artwork;
- target-incompatible custom text;
- unsupported structured or binary native fields;
- ratings unsupported by AAC/ALAC.

Loss of a supported canonical field, primary artwork, rating, or compatible source custom value is
fatal. FFmpeg errors, metadata parse failures, validation failures, and aborts are also fatal. A
fatal result never replaces the requested destination.

## Isolation and Resource Bounds

General transcoding input size is not capped. Untrusted metadata parsing and conversion-time MP3
POPM mutation occur in separate Node child processes so parser, tag-writer, or heap failures do not
execute inside the main CLI process. Because `node-id3` synchronously duplicates MP3 buffers, a
staged MP3 that requires POPM restoration is capped at 32 MiB and fails before the worker is
started when larger.

The child uses V8 heap/stack flags and a 30-second parsing timeout. Those flags constrain the child
JavaScript heap; they are not represented as a cross-platform total OS-memory ceiling. Raw parser
objects never cross the boundary. The child projects and validates a bounded snapshot, serializes
it, and the parent validates the complete successful response before use.

Current metadata bounds are:

| Resource                            | Bound           |
| ----------------------------------- | --------------- |
| Serialized child IPC payload        | 32 MiB          |
| Pictures reported by the parser     | 16              |
| Primary picture payload             | 16 MiB          |
| Aggregate parsed artwork            | 32 MiB          |
| Text tags and projected text fields | 4,096           |
| Text key                            | 255 UTF-8 bytes |
| Individual text value               | 1 MiB           |
| Aggregate projected text            | 8 MiB           |
| Opus FFmetadata sidecar             | 24 MiB          |
| Staged MP3 requiring POPM mutation  | 32 MiB          |

Rating source, email provenance, and counter are validated before IPC. The rating source/email text
also counts toward the aggregate text limit. External artwork references, NUL-containing text,
unsafe image metadata, malformed child responses, and values outside these bounds are rejected.

## Atomic Publication and Permissions

Conversion follows this order:

1. Open and identity-bind the source, then pass that retained descriptor to the isolated metadata
   child.
2. Create a private sibling stage with mode `0600` and keep its exclusive descriptor open.
3. Materialize Opus FFmetadata and selected artwork in private mode-`0600` siblings, unlink them,
   and retain only their authoritative descriptors.
4. Run FFmpeg without a shell, using inherited source, stage, metadata, and artwork descriptors
   rather than reopening their pathnames.
5. Restore MP3 POPM metadata in a heap-limited child through the inherited stage descriptor when
   applicable.
6. Flush and semantically audit the staged output through the still-open authoritative stage
   descriptor.
7. Run any caller-provided additional validator.
8. Apply the publication mode and atomically rename the stage over the destination.

Before commit, the implementation revalidates the source version, stage, parent directory, and
destination identity. Opus metadata and selected artwork have no pathname to replace after their
descriptors are prepared. It rejects canonical-path and hardlink source/destination aliases. A
pre-commit failure removes the private stage and leaves an existing destination untouched. An
existing regular destination keeps its permission bits from the same identity snapshot used by
publication; a new destination uses the normal umask-derived file mode. Descriptor cleanup failures
are sanitized and remain fatal before publication.

## Current Interfaces

The internal preset contains only the codec, extension, and description:

```typescript
interface ConversionPreset {
  codec: string;
  extension: string;
  description: string;
}
```

Target-specific FFmpeg arguments and metadata capabilities come from
`getConversionTargetPolicy()`.

The public conversion entry point remains:

```typescript
convertFile(
  source: string,
  dest: string,
  format: ConvertFormat,
  onProgress?: ConversionProgressCallback,
  signal?: AbortSignal,
): Promise<ConversionResult>
```

Internal verification paths use `convertFileWithValidation()` with:

```typescript
interface ConversionValidationOptions {
  onProgress?: ConversionProgressCallback;
  signal?: AbortSignal;
  additionalValidator?: (stagedPath: string, signal: AbortSignal, stagedHandle: FileHandle) => Promise<void>;
}
```

## Dry Run and Copy Behavior

With `--dry-run`, the workflow reports the intended conversion but does not run FFmpeg or publish a
destination.

For range-based copies:

1. the first copy converts from the original source;
2. later copies reuse the first validated converted output;
3. hardlinks may be used for those later copies when the filesystem permits them.

## Related Documentation

- [Plex Metadata Sync](plex-metadata-sync.md) - Rating override order for Plex copy/export
- [Parallel Processing](parallel-processing.doc.md) - Worker scheduling around file operations
- [Verify Command](verify-command.doc.md) - Destination verification and repair
