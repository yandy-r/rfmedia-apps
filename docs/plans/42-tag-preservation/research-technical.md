# Technical Specification: Tag Preservation During Conversion

## Executive Summary

Implement issue #42 once inside the shared `convertFile()` boundary. Before encoding, parse one
cover-aware source metadata snapshot and normalize its rating with native tags taking precedence
over `music-metadata`'s common projection. Encode to a private sibling stage using a typed,
target-specific FFmpeg argument policy; perform the MP3 POPM write; parse and audit the staged
artifact; then atomically publish it. Every existing copy, sync, Plex, and verify-repair caller
inherits the behavior without a new CLI option, configuration field, database migration, or shell
completion change.

The correctness boundary is:

- canonical artist, album, title, track, year/date, and genre fields must round-trip when supported;
- compatible arbitrary text tags must round-trip for MP3 and Opus;
- ratings are translated to MP3 POPM or Opus `RATING`;
- one bounded primary/front cover is copied for MP3 and M4A and translated to the standard Opus
  `METADATA_BLOCK_PICTURE` comment;
- known target/toolchain limitations produce sorted, deduplicated, non-fatal warnings;
- a mapping declared supported but missing in the post-conversion audit is fatal and the stage is
  removed without replacing the destination;
- the vulnerable metadata-parser chain is upgraded before cover-aware parsing is added to every
  conversion; and
- Plex `syncTrackRating()` remains a later, intentional rating override.

The implementation must also repair the current FFmpeg argument bug: preset entries such as
`"-b:a 320k"` are one invalid `spawn()` argument. Every option and value must be a separate array
element, for example `["-b:a", "320k"]`.

## Architecture Design

### Component Diagram

```text
album/filter/sync/Plex/verify callers
                 |
                 v
          convertFile()
                 |
        +--------+---------+
        |                  |
        v                  v
source metadata       target policy
snapshot              + FFmpeg argv
        |                  |
        +--------+---------+
                 v
       private sibling stage
                 |
        +--------+---------+
        |                  |
        v                  v
   MP3 POPM write     output metadata parse
        |                  |
        +--------+---------+
                 v
        capability-aware audit
          |              |
          |              +--> sorted limitation warnings
          v
   atomic destination publish
                 |
                 v
 history/hash/plugin consumers
                 |
                 v
 optional Plex rating override
```

### Component Responsibilities

#### `convert.ts`

Keep `convertFile()` as the public library façade and process owner. It should:

1. check cancellation and ensure the destination directory;
2. obtain a source `ConversionMetadataSnapshot`;
3. select a typed `ConversionTargetPolicy`;
4. materialize an encoded sibling stage;
5. apply target-specific rating post-processing;
6. audit the complete staged file;
7. emit deterministic limitation warnings;
8. atomically publish the stage; and
9. return only after all metadata work is finished.

Extract child-process execution into a small internal async helper so a single `try/finally`
controls stage and sidecar cleanup. Guard process `close` and `error` callbacks with a settle-once
flag. Preserve the exact caller abort reason instead of wrapping it in `ConversionError`.

#### New `conversion-metadata.ts`

Create `packages/rfmedia-cli/src/lib/conversion-metadata.ts` for conversion-specific metadata
policy. This keeps broad tag projection and auditing out of the process/progress code while avoiding
a general-purpose tag framework.

It should own:

- the cover-aware `music-metadata` snapshot;
- canonical and compatible custom-text projection;
- bounded FLAC picture-block serialization for Opus;
- private ffmetadata sidecar serialization and escaping;
- target capability records;
- deterministic limitation discovery;
- post-conversion semantic auditing; and
- warning sorting/deduplication/formatting.

It must not spawn the transcoder, write output media, log, or know about commands/actions. Its only
filesystem responsibility is the private, disposable Opus ffmetadata sidecar. Keep picture framing,
escaping, policy, and audit helpers pure so the format matrix is testable without duplicating caller
tests.

#### `ratings.ts`

Export one parsed-metadata helper and make it authoritative:

```ts
export function extractNormalizedRating(
  metadata: Pick<IAudioMetadata, "common" | "native">,
  filePath: string,
): NormalizedRating | null;
```

Selection order must be format-aware and native-first:

1. MP3: native ID3v2.3/2.4 POPM, including preferred email and counter;
2. FLAC/Ogg/Opus: case-insensitive native Vorbis `RATING`, with scale detection;
3. other readable formats: the common projection as a fallback;
4. M4A/AAC: no interoperable embedded user-rating contract, unless a future target policy adds one.

`readRating()`, `readRatingAndFormat()`, and `metadata.ts` must reuse this helper. Remove the
duplicated common-first rating implementation from `metadata.ts`. This fixes the observed
`RATING=0.80` problem where `music-metadata` 11.10.6 exposes common `0.008` even though the native
value correctly normalizes to `0.8`.

#### `tag-writer.ts`

Reuse the existing MP3 `NodeID3.update()` path after FFmpeg has created the stage. Extend
`WriteRatingOptions` with an optional `popmCounter` and use the source `NormalizedRating.email` and
`counter` when present. This preserves the selected POPM identity rather than resetting every
converted rating to `no@email` and counter zero.

Do not turn `tag-writer.ts` into a cross-container metadata writer. Opus rating and primary artwork
are serialized into a private ffmetadata sidecar and mapped by FFmpeg to Vorbis comments;
AAC/ALAC-in-M4A has no portable embedded user-rating field and produces a limitation warning.

#### Existing atomic filesystem boundary

Reuse `replaceFileWithValidatedStage()` from `lib/filesystem.ts` rather than adding another atomic
replacement implementation. Because its sibling stage ends in `.tmp`, each conversion preset must
declare an explicit FFmpeg muxer (`-f mp3`, `-f ipod`, or `-f opus`) instead of relying on filename
extension inference.

The materializer encodes and performs the MP3 rating write. The validator parses and audits the
stage. The existing helper then fsyncs and renames only the validated inode. Any failure or
cancellation removes the stage and leaves an existing destination unchanged.

### End-to-End Data Flow

1. `convertFile(source, dest, format, onProgress?, signal?)` checks `signal`.
2. `readConversionMetadata(source)` calls `parseFile(source, { skipCovers: false })` once.
3. `extractNormalizedRating()` reads native POPM/Vorbis before the common projection.
4. `getConversionTargetPolicy(format)` returns muxer, codec tokens, stream mapping, rating mode,
   custom-tag support, and artwork support.
5. Known limitations are computed from the source snapshot and policy, without inspecting tag
   values in log messages.
6. For every Opus conversion, a private `0600` ffmetadata sidecar is written with the header plus
   normalized `RATING` and a bounded base64 FLAC picture block when present.
7. `replaceFileWithValidatedStage(dest, ...)` creates the private sibling stage.
8. FFmpeg receives fully tokenized argv and writes to the stage using the explicit muxer.
9. For MP3, `writeRating(stage, value, { popmEmail, popmCounter })` updates POPM after FFmpeg.
10. The validator reparses the stage with covers enabled and compares it with the source snapshot.
11. A missing supported mapping throws `ConversionError`; known unsupported classes become
    `ConversionWarning` values.
12. Warnings are deduplicated, sorted, and emitted through `logWarn()` on stderr.
13. The validated stage is atomically renamed to `dest`; `ConversionResult.warnings` returns the
    same ordered warning list.
14. The ffmetadata sidecar is unlinked in `finally`.
15. Existing action code records history and hashes the final bytes.
16. Plex actions may call `syncTrackRating(dest, plexRating, ...)` afterward. This deliberately
    supersedes the preserved source rating and must not move before conversion.

## Data Models

There are no database tables, indexes, or migrations. All new models are in-memory, immutable
TypeScript contracts.

### Conversion Metadata Snapshot

| Field               | Type                           | Constraint                                                   |
| ------------------- | ------------------------------ | ------------------------------------------------------------ |
| `sourceTagFamilies` | `readonly string[]`            | Sorted unique `music-metadata` native tag-family names       |
| `canonical.title`   | `string \| undefined`          | Source common title                                          |
| `canonical.artists` | `readonly string[]`            | Prefer `common.artists`; otherwise one `common.artist`       |
| `canonical.album`   | `string \| undefined`          | Source common album                                          |
| `canonical.track`   | `{ no?: number; of?: number }` | Preserve number and total independently                      |
| `canonical.year`    | `number \| undefined`          | Common normalized year                                       |
| `canonical.date`    | `string \| undefined`          | Original date when available; year is the portable baseline  |
| `canonical.genres`  | `readonly string[]`            | Preserve all normalized genre values                         |
| `textTags`          | `readonly ConversionTextTag[]` | Only scalar UTF-8 text/number values with a semantic key     |
| `rating`            | `NormalizedRating \| null`     | Native-first normalized `0 < value <= 1`; zero means unrated |
| `pictures`          | `readonly ConversionPicture[]` | Bounded cover data; primary/front cover sorted first         |

Do not use the filter-oriented `ExtendedMetadata` type. It omits track totals, date variants,
custom/native fields, POPM identity, and artwork.

### Conversion Text Tag

| Field           | Type                      | Constraint                                                                      |
| --------------- | ------------------------- | ------------------------------------------------------------------------------- |
| `key`           | `string`                  | Trimmed semantic key; reject NUL and `=`; retain original case only for display |
| `normalizedKey` | `string`                  | Uppercase comparison key                                                        |
| `values`        | `readonly string[]`       | Stable source order, bounded length; no binary/object coercion                  |
| `sourceFamily`  | `string`                  | Native family such as `ID3v2.4` or `vorbis`                                     |
| `kind`          | `"canonical" \| "custom"` | Canonical keys are audited through the canonical model                          |

Structured/binary native frames that have no safe semantic text mapping are not flattened into
FFmpeg arguments. They become a warning when the target cannot represent them.

### Conversion Picture

| Field         | Type                  | Constraint                                                                       |
| ------------- | --------------------- | -------------------------------------------------------------------------------- |
| `format`      | `string`              | MIME/format reported by `music-metadata`                                         |
| `type`        | `string \| undefined` | Used to select front cover first                                                 |
| `description` | `string \| undefined` | Never included in warning logs as raw content                                    |
| `data`        | `Uint8Array`          | Primary picture must be at most 16 MiB; oversize is a fatal resource-limit error |
| `digest`      | `string`              | SHA-256 of image bytes for exact copy audit                                      |

The issue's minimum artwork contract is one primary/front cover. Additional pictures generate one
ordered limitation warning. Bound the snapshot to at most 16 pictures and 32 MiB total picture data;
exceeding either bound is fatal before FFmpeg. The primary image itself is capped at 16 MiB so its
base64 Opus representation and temporary file remain bounded.

### Target Policy

```ts
interface ConversionTargetPolicy {
  readonly format: ConvertFormat;
  readonly container: "mp3" | "m4a" | "opus";
  readonly muxer: "mp3" | "ipod" | "opus";
  readonly audioArgs: readonly string[];
  readonly artworkMode: "attached-picture-copy" | "vorbis-picture-comment";
  readonly ratingMode: "popm-postwrite" | "vorbis-comment" | "unsupported";
  readonly customTextMode: "mapped-and-audited" | "unsupported";
}
```

All option/value pairs in `audioArgs` are separate tokens. Add a test invariant that no preset
element contains whitespace.

### Warning Contract

```ts
type ConversionWarningCode =
  | "additional_artwork_unsupported"
  | "custom_tag_unsupported"
  | "native_tag_unsupported"
  | "rating_unsupported";

interface ConversionWarning {
  readonly code: ConversionWarningCode;
  readonly field: string;
  readonly target: ConvertFormat;
  readonly reason: string;
}
```

Warnings contain field/category names, never raw tag values or artwork. Sort by
`code`, then `field`, then `reason`; deduplicate on the same tuple. Add
`warnings: readonly ConversionWarning[]` to `ConversionResult`. Existing callers remain
source-compatible because they do not destructure the result.

## API Design

### External and CLI API

No endpoints, routes, request bodies, configuration keys, flags, or output formats are added.
Existing invocations such as `rfmedia copy --convert mp3` gain preservation automatically.

Bash, Zsh, and Fish completion templates remain unchanged. If implementation adds any CLI surface
despite this specification, all three templates and parity tests must be audited together.

### Internal Function Contracts

Keep the existing call signature:

```ts
export async function convertFile(
  source: string,
  dest: string,
  format: ConvertFormat,
  onProgress?: ConversionProgressCallback,
  signal?: AbortSignal,
): Promise<ConversionResult>;
```

Add internal conversion-metadata contracts:

```ts
export async function readConversionMetadata(
  filePath: string,
  signal?: AbortSignal,
): Promise<ConversionMetadataSnapshot>;

export function getConversionLimitations(
  source: ConversionMetadataSnapshot,
  policy: ConversionTargetPolicy,
): readonly ConversionWarning[];

export function auditConvertedMetadata(
  source: ConversionMetadataSnapshot,
  destination: ConversionMetadataSnapshot,
  policy: ConversionTargetPolicy,
): void;

export async function createOpusMetadataSidecar(
  destinationDirectory: string,
  source: ConversionMetadataSnapshot,
  signal?: AbortSignal,
): Promise<{ path: string; dispose(): Promise<void> }>;
```

`auditConvertedMetadata()` returns normally only when every policy-supported requirement is
present. It throws a typed audit error carrying field names, not values. `convertFile()` wraps that
error as a `ConversionError` whose public `destPath` is the requested destination, never the private
stage path.

### Error Semantics

| Condition                                             | Result                                           | Destination effect               |
| ----------------------------------------------------- | ------------------------------------------------ | -------------------------------- |
| Target inherently cannot represent a source field     | Ordered `ConversionWarning`; conversion succeeds | Valid staged output is published |
| Additional artwork exceeds one-cover contract         | Ordered warning; primary cover continues         | Valid staged output is published |
| Source metadata cannot be parsed                      | `ConversionError`                                | Stage is not published           |
| Picture count/bytes exceed resource bounds            | `ConversionError`                                | No sidecar or stage is published |
| Opus ffmetadata sidecar cannot be written or encoded  | `ConversionError`                                | Sidecar/stage are removed        |
| FFmpeg spawn/codec/mux failure                        | Existing typed error behavior                    | Stage is removed                 |
| MP3 POPM write fails                                  | `ConversionError`                                | Stage is removed                 |
| Supported canonical/custom/rating/artwork audit fails | `ConversionError` naming fields only             | Stage is removed                 |
| Destination audit parse fails                         | `ConversionError`                                | Stage is removed                 |
| Abort before, during, or after FFmpeg                 | Reject with exact `signal.reason`                | Stage and sidecars are removed   |
| Warning log formatting fails                          | Must not happen; formatting is pure              | No raw tag values are logged     |

### Warning Example

```text
Metadata preservation warning [rating_unsupported] song.flac -> song.m4a (aac): rating is not supported by the standard M4A tag mapping
```

The logger uses stderr, preserving stdout and JSON output integrity. Emit warnings only after the
audit succeeds so a failed conversion does not produce a misleading “usable output” warning.

## Target Format Mapping

### Shared FFmpeg Rules

Every target explicitly maps the first audio stream and global metadata:

```text
-i <source> -map 0:a:0 -map_metadata 0:g
```

Do not interpolate a shell command. Do not place arbitrary native tag values or binary artwork in
argv. Continue using `spawn("ffmpeg", args, { signal })`.

The destination stage has a `.tmp` name, so append the preset's explicit muxer before the final
stage argument:

```text
-f <mp3|ipod|opus> -y <stage>
```

### MP3

```text
-map 0:a:0
-map 0:v:0?
-map_metadata 0:g
-map_metadata:s:v:0 0:s:v:0
-c:a libmp3lame
-b:a 320k
-c:v copy
-disposition:v:0 attached_pic
-f mp3
```

- FFmpeg maps canonical fields and compatible arbitrary text to ID3/TXXX.
- Copy the primary optional artwork stream as APIC; do not let FFmpeg re-encode it.
- After FFmpeg, write the native-first normalized rating as POPM with source email/counter.
- Audit canonical fields, compatible custom text, POPM value within one POPM quantization step, and
  exact primary-cover digest.
- Warn for additional pictures and structured/binary native frames with no ID3 representation.

### M4A Container: AAC and ALAC

Both `aac` and `alac` targets use the M4A/iPod muxer and the same tag policy:

```text
-map 0:a:0
-map 0:v:0?
-map_metadata 0:g
-map_metadata:s:v:0 0:s:v:0
-c:a <aac|alac>
[-b:a 256k for AAC only]
-c:v copy
-disposition:v:0 attached_pic
-f ipod
```

- Explicit picture mapping plus `-c:v copy` is required. With current automatic selection, a PNG
  cover can be sent to the default H.264 encoder and make M4A conversion fail.
- Standard iTunes atoms carry canonical title, artist, album, track, date/year, genre, and `covr`
  artwork.
- Do not use MOV `use_metadata_tags`: the environment probe retained some arbitrary keys but lost
  the cover and stopped exposing standard common fields through `music-metadata`.
- Standard M4A has no interoperable file user-rating mapping in the current contract. Emit
  `rating_unsupported` when the source is rated.
- Emit one sorted `custom_tag_unsupported` warning per incompatible custom key.
- Audit canonical fields and exact primary-cover digest. AAC and ALAC differ only in codec/bitrate,
  not metadata policy.

### Opus

Always create the second input, even when it contains only the `;FFMETADATA1` header. This keeps one
auditable argv shape and lets rating/artwork entries be added without placing their values in argv.

```text
-i <source>
-f ffmetadata
-i <private-sidecar>
-map 0:a:0
-map_metadata 0:g
-map_metadata:s:a 1:g
-c:a libopus
-b:a 128k
-f opus
```

- Vorbis comments carry canonical and arbitrary UTF-8 text. Audit compatible text by semantic key
  and value.
- A normalized `RATING` entry in the sidecar is generated from the native-first snapshot so MP3
  POPM survives MP3-to-Opus conversion.
- Do not map the input video stream: the current Opus muxer accepts audio only.
- Serialize the primary cover as a FLAC picture block, then base64-encode it as
  `METADATA_BLOCK_PICTURE` in the sidecar. This is the standard Opus/Vorbis representation and was
  preserved by the direct environment probe; direct attached-video mapping was not.
- The FLAC picture block uses 32-bit big-endian fields: picture type, MIME length/value,
  description length/value, width, height, depth, indexed-color count, data length, and image
  bytes. Use picture type 3 for the selected front cover. Use known dimensions when available and
  zero for unknown numeric properties, which the format permits.
- Escape ffmetadata values exactly for backslash, newline, `=`, `;`, and `#`. The sidecar contains
  only generated keys and bounded values, never arbitrary binary coerced to text.
- Audit canonical fields, arbitrary text, normalized rating, and exact primary-cover digest. Rating
  tolerance is the stable decimal precision chosen by the writer.

### Mapping Matrix

| Target      | Canonical text         | Arbitrary compatible text          | Rating                            | Primary artwork                         |
| ----------- | ---------------------- | ---------------------------------- | --------------------------------- | --------------------------------------- |
| MP3         | ID3 mapped and audited | TXXX mapped and audited            | POPM post-write                   | APIC stream copy                        |
| AAC in M4A  | Standard iTunes atoms  | Unsupported; warn per key          | Unsupported; warn                 | `covr` stream copy                      |
| ALAC in M4A | Standard iTunes atoms  | Unsupported; warn per key          | Unsupported; warn                 | `covr` stream copy                      |
| Opus        | Vorbis comments        | Vorbis comments mapped and audited | Normalized `RATING` in ffmetadata | Base64 FLAC picture block in ffmetadata |

## Post-Conversion Audit

### Comparison Rules

- Normalize comparison strings to Unicode NFC; do not lowercase user values.
- Compare title and album as scalar values.
- Compare artist and genre values as stable multisets so container ordering does not create false
  failures.
- Compare track number and total independently.
- Compare normalized year; compare full date only when both source and target policy support it.
- Compare MP3 rating within `1 / 255`; compare Opus rating within the emitted decimal precision.
- Compare primary artwork by SHA-256 bytes: MP3/M4A use `-c:v copy`, while the Opus picture block
  contains the original bytes.
- Compare supported arbitrary text by normalized semantic key and value multiset.
- Ignore encoder-generated tags such as FFmpeg vendor/encoder fields.
- Do not require native frame identifiers to match across containers; audit semantic values.

### Fatal Versus Non-Fatal

The target policy decides support before encoding. This prevents the audit from weakening the
feature:

- if policy says a field is supported and it is missing or changed, the audit fails and publication
  is aborted;
- if policy says it is unsupported, the exact limitation warning is known and the audit does not
  expect it;
- a new FFmpeg version silently dropping a formerly supported field therefore becomes a testable
  failure, not a false success;
- raw tag values remain absent from errors and warnings.

## Temporary Files, Cleanup, and Cancellation

- Use the existing same-directory `replaceFileWithValidatedStage()` helper for encoded output.
- Pass the caller's `AbortSignal` through materialize, FFmpeg spawn, metadata post-write, audit, and
  validation.
- Call `signal.throwIfAborted()` before source parsing, after directory creation, after parsing,
  after FFmpeg closes, after rating write, after audit, and immediately before publication.
- On an already-aborted signal, perform no parse, directory creation, or spawn.
- The stage is private, same-filesystem, fsynced, identity-checked, and removed by the existing
  helper on every pre-commit failure.
- For Opus, create the ffmetadata sidecar in the resolved destination directory with exclusive
  `open(path, "wx", 0o600)`. Use a randomized, non-user-controlled basename, write the complete
  sidecar, `sync()` and close it before spawn, and keep its path as a separate argv element.
- Unlink the sidecar in an enclosing `finally` after every success, parse failure, spawn error,
  nonzero exit, audit failure, and abort. Treat cleanup failure as an error unless the file is
  already absent.
- Cap source pictures at 16 entries, total picture bytes at 32 MiB, the selected primary picture at
  16 MiB, and the complete ffmetadata sidecar at 24 MiB. Check the encoded size before writing.
- Ensure child `error` and `close` events cannot resolve/reject twice.
- Keep stderr bounded exactly as the current implementation does; successful generic FFmpeg stderr
  is not a metadata-warning source.
- Never remove or mutate the source. Never publish a stage that failed metadata post-processing or
  audit.

## System Constraints

### Performance

- Parse source metadata once with covers enabled and destination metadata once for audit.
- Preserve the existing “convert first copy, copy/hardlink subsequent copies” optimization.
- Bound picture count, per-picture bytes, total picture bytes, text-tag count, and text value length
  before serialization. Reject pathological inputs with a typed conversion failure rather than
  creating an unbounded sidecar.
- Do not add an audit to ordinary non-converting copies.
- Avoid a full action-level test matrix; all callers use the same conversion seam.

### Security

- Continue passing an argv array to `spawn`; never use a shell or concatenate file/tag values into a
  command string.
- Do not place Opus picture base64 or arbitrary source values in argv. The bounded value goes only
  in the private ffmetadata sidecar; argv contains its path.
- Reject NUL in any value considered for process options and never log raw custom values or artwork.
- Keep source and destination paths in typed errors, consistent with current conversion errors.
- Same-directory staging avoids cross-device publication and keeps partial output private.
- Upgrade `music-metadata` before expanding `parseFile()` to every conversion. The current locked
  11.10.6 is affected by CVE-2026-32256 /
  [GHSA-v6c2-xwv6-8xf7](https://github.com/advisories/GHSA-v6c2-xwv6-8xf7), and its `file-type`
  21.3.0 dependency is affected by
  [GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473) and
  [GHSA-j47w-4g3g-c36v](https://github.com/advisories/GHSA-j47w-4g3g-c36v).

### Compatibility

- Preserve the existing `ConvertFormat = "alac" | "mp3" | "aac" | "opus"` union.
- ALAC and AAC share `.m4a`/iPod muxer behavior.
- FFmpeg is a system dependency with unpinned build capabilities. Require a local real-file probe for
  the four target policies during implementation, while keeping CI tests deterministic through
  mocks and pure audits.
- Require `music-metadata` 11.14.0 or a newer compatible patched version and confirm the lockfile
  resolves `file-type` 21.3.4 or newer. The registry metadata for 11.14.0 declares
  `file-type ^21.3.4`.
- Source FLAC, Vorbis, ID3v2, and other formats supported by `music-metadata` may enter the snapshot;
  only mappings proven by the target policy are correctness requirements.
- No package API export is necessary beyond the existing library functions.

### Scalability

The feature remains file-local and stateless. Existing action concurrency controls conversion
parallelism. The bounded snapshot prevents one file's metadata from creating unbounded memory use;
no queue, cache, or database state is added.

## Codebase Changes

### Create

| File                                                       | Change                                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/conversion-metadata.ts`      | Snapshot types/read, target policies, bounded Opus FLAC picture block and ffmetadata sidecar, limitations, pure audit |
| `packages/rfmedia-cli/src/lib/conversion-metadata.test.ts` | One table-driven policy/limitation/audit matrix                                                                       |

### Modify

| File                                                         | Change                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/convert.ts`                    | Tokenize preset argv, add explicit muxers/mapping, stage/validate/publish lifecycle, return/log warnings |
| `packages/rfmedia-cli/src/lib/convert.test.ts`               | Table-driven argv assertions plus one cleanup/publication lifecycle case; retain cancellation cases      |
| `packages/rfmedia-cli/src/lib/ratings.ts`                    | Export and reuse native-first parsed-metadata extraction                                                 |
| `packages/rfmedia-cli/src/lib/ratings.test.ts`               | Pin native Vorbis `0.80 -> 0.8`, common fallback, and POPM identity/counter                              |
| `packages/rfmedia-cli/src/lib/metadata.ts`                   | Delete duplicate rating readers and reuse `extractNormalizedRating()`                                    |
| `packages/rfmedia-cli/src/lib/tag-writer.ts`                 | Accept/preserve optional POPM counter                                                                    |
| `packages/rfmedia-cli/src/lib/tag-writer.test.ts`            | Assert source POPM email/counter are passed to `NodeID3.update()`                                        |
| `packages/rfmedia-cli/package.json`                          | Raise `music-metadata` to a patched compatible version, targeting `^11.14.0`                             |
| `package-lock.json`                                          | Resolve patched `music-metadata` and `file-type >=21.3.4`; review the complete dependency diff           |
| `packages/rfmedia-cli/docs/features/audio-conversion.doc.md` | Document preservation flow, matrix, warnings, artwork distinction, and atomic audit                      |
| `packages/rfmedia-cli/README.md`                             | Add public preservation guarantee and target limitation summary                                          |
| `packages/rfmedia-cli/docs/features/plex-metadata-sync.md`   | Clarify source preservation occurs before optional Plex rating override                                  |
| `ROADMAP.md`                                                 | Update live issue status/counts at delivery closeout                                                     |

No command, action, option type, MCP schema, configuration schema, database, or completion file
needs modification.

### Dependencies

Use the existing dependency set, but upgrade the vulnerable metadata parser chain before shipment:

- `music-metadata ^11.14.0` for cover-aware source/destination parsing;
- `file-type >=21.3.4` transitively through `music-metadata`;
- FFmpeg for codec/container mapping and Opus `RATING`/`METADATA_BLOCK_PICTURE`;
- `node-id3` through the existing writer for MP3 POPM;
- Node filesystem/crypto primitives and the existing atomic stage helper.

Do not add a universal tag-writing dependency for this issue. Its cross-format behavior would still
require an audit and would expand supply-chain and maintenance risk. The small FLAC picture-block
serializer is deterministic binary framing around already parsed artwork and stays local to the Opus
sidecar path.

## Minimal Test Plan

1. **Target argv table in `convert.test.ts`:**
   - all preset tokens are separate and no token contains an option plus its value;
   - all targets map `0:a:0`, map global metadata, and specify an output muxer;
   - MP3 and both M4A targets optionally map/copy artwork;
   - Opus does not map video, adds the ffmetadata input, and maps its metadata to the audio stream;
   - the private stage, not the public destination, is FFmpeg's final argument.
2. **Policy/audit table in `conversion-metadata.test.ts`:**
   - MP3 expects canonical/custom/rating/primary artwork;
   - AAC/ALAC warn for rating/custom text but expect canonical/artwork;
   - Opus expects canonical/custom/rating/primary artwork;
   - a fixed tiny PNG produces the expected FLAC picture-block bytes and base64;
   - ffmetadata escaping covers backslash, newline, `=`, `;`, and `#`;
   - picture/sidecar resource bounds reject without writing;
   - warning order/deduplication is stable;
   - one supported-field mismatch throws.
3. **Rating regression in `ratings.test.ts`:**
   - native Vorbis `RATING=0.80` wins over common `0.008`;
   - POPM retains email/counter;
   - common projection is used only when no supported native rating exists.
4. **Lifecycle/cancellation in `convert.test.ts`:**
   - retain both existing abort tests;
   - one failed audit removes the stage and does not publish;
   - one successful audited conversion publishes before resolving;
   - Opus sidecar is created `0600`, closed before spawn, and removed on success, failure, and abort.
5. **Writer assertion in `tag-writer.test.ts`:**
   - MP3 update receives preserved POPM email/counter and keeps `preserveTags: true`.

Do not duplicate the conversion matrix across album, filter, sync, Plex, playlist, or verify action
tests. The only action-level ordering evidence needed is the existing code review showing
`syncTrackRating()` is awaited after `convertFile()`; add a focused regression only if refactoring
touches that caller sequence.

### Verification Commands

```bash
npm run build:common
npm run test:run -w packages/rfmedia-cli -- src/lib/convert.test.ts src/lib/conversion-metadata.test.ts src/lib/ratings.test.ts src/lib/tag-writer.test.ts
npm run typecheck -w packages/rfmedia-cli
npm run test:rfmedia
npm ls music-metadata file-type
npm audit --omit=dev --json
npm run lint:md
npx prettier --check packages/rfmedia-cli/src/lib/convert.ts packages/rfmedia-cli/src/lib/conversion-metadata.ts packages/rfmedia-cli/src/lib/ratings.ts packages/rfmedia-cli/src/lib/metadata.ts packages/rfmedia-cli/src/lib/tag-writer.ts packages/rfmedia-cli/docs/features/audio-conversion.doc.md packages/rfmedia-cli/docs/features/plex-metadata-sync.md packages/rfmedia-cli/README.md ROADMAP.md
```

Supplement CI with one local FFmpeg fixture per target family and reparse the output with the
installed `music-metadata`. Record exact commands/results in the pull request; do not make the
normal Vitest suite depend on a system FFmpeg installation.

## Technical Decisions

| Decision               | Options                                           | Recommendation and rationale                                                                                                                    |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration boundary   | Patch every caller; central conversion façade     | Centralize in `convertFile()` so all seven callers and verify repairs behave identically                                                        |
| Metadata structure     | Reuse `ExtendedMetadata`; add conversion snapshot | Add a focused snapshot because the filter model intentionally omits artwork, track totals, and native/custom tags                               |
| Target handling        | One common argv; typed policy table               | Use a policy table because M4A stream artwork, MP3 POPM, and Opus picture comments are materially different                                     |
| Rating read precedence | Common-first; native-first                        | Native-first prevents the observed Vorbis 100x distortion and retains POPM identity/counter                                                     |
| Rating write           | New universal writer; existing seams              | Reuse MP3 writer and FFmpeg Opus comment; warn for M4A to minimize dependencies                                                                 |
| Artwork                | Automatic FFmpeg selection; explicit policy       | Explicitly map/copy MP3/M4A cover and map a bounded Opus FLAC picture block from private ffmetadata; automatic stream selection is insufficient |
| M4A arbitrary tags     | `use_metadata_tags`; standard atoms               | Standard atoms because the alternative loses artwork and common normalization                                                                   |
| Output publication     | Direct `-y` destination; validated sibling stage  | Reuse atomic validated staging so partial or metadata-invalid output never replaces the destination                                             |
| Loss handling          | Warn for every mismatch; policy-aware fail/warn   | Known limitations warn; failure of a declared-supported mapping is fatal                                                                        |
| Warning surface        | Logs only; structured result plus logs            | Add ordered warnings to `ConversionResult` and emit them through stderr for visibility and testability                                          |
| Tests                  | Full caller matrix; central contract tests        | Test the shared seam and pure policy once; retain existing action behavior                                                                      |

## Open Questions

No product or CLI decision is blocking implementation. The following are bounded technical
validation gates:

1. Confirm the repository's supported FFmpeg floor accepts explicit `mp3`, `ipod`, and `opus`
   muxers plus optional `0:v:0?` mapping. If no version floor exists, document the probed version in
   the pull request and keep actionable codec/muxer errors.
2. Confirm `NodeID3.update()` preserves the staged inode expected by
   `replaceFileWithValidatedStage()`. If it replaces the inode, perform the POPM update before
   entering the helper's identity-validated stage or introduce a narrowly scoped materializer seam;
   do not weaken the filesystem identity check.
3. Confirm the chosen canonical/custom text projection names against representative ID3, Vorbis,
   and FLAC fixtures. Unknown structured frames remain warnings rather than unsafe string coercions.
4. Confirm the patched dependency resolution removes the three metadata-parser advisories above.
   Other repository-wide audit findings are outside this feature unless the lockfile update changes
   them, but the pull request must not claim a clean global audit without evidence.
