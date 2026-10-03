# External API Research: Tag Preservation During Conversion

## Executive Summary

Issue #42 is a local file-conversion problem, not a network integration. There
are no service endpoints, credentials, quotas, or per-request costs. The
authoritative external boundary is the installed FFmpeg executable, with
`music-metadata` used to inspect source and destination tags and `node-id3`
used only where MP3 needs a semantic POPM rating.

The smallest reliable design is:

1. Read a normalized preservation contract from the source before conversion,
   including the primary picture and a native-first rating.
2. Invoke FFmpeg with explicit audio, metadata, and target-specific artwork
   mapping. Every option and value must be a separate `spawn()` argument.
3. For MP3, translate the normalized source rating to POPM after FFmpeg using
   the existing `node-id3`-backed writer.
4. Parse the destination and audit guaranteed fields. Fail when a supported
   mapping is missing; emit a structured, non-fatal warning when the target
   cannot represent a source field.

FFmpeg can preserve semantic metadata, but it cannot provide byte-for-byte
native-tag parity across Vorbis comments, ID3v2, and iTunes atoms. Target
capability must therefore be explicit. In particular:

- MP3 preserves common text, custom text, and artwork, but a FLAC `RATING`
  becomes `TXXX:RATING`, not POPM.
- AAC/ALAC in M4A preserve common text and artwork when the picture stream is
  explicitly copied, but standard iTunes atoms drop `RATING` and arbitrary
  custom keys.
- Opus preserves Vorbis text, including `RATING` and custom keys, but FFmpeg's
  Opus muxer rejects an attached-picture stream.

No dependency upgrade or new tag-writing dependency is required for this
scope.

## Primary APIs

### FFmpeg CLI

Documentation:

- [FFmpeg command-line documentation](https://ffmpeg.org/ffmpeg.html)
- [FFmpeg formats and muxers](https://ffmpeg.org/ffmpeg-formats.html)
- [FFmpeg licensing and legal information](https://ffmpeg.org/legal.html)

| Concern         | Contract                                                                     |
| --------------- | ---------------------------------------------------------------------------- |
| Authentication  | None; local executable                                                       |
| Endpoints       | None; process invocation through `spawn()`                                   |
| Rate limits     | None; bounded by local CPU, memory, disk, and process concurrency            |
| Pricing         | No usage fee; distribution obligations depend on how FFmpeg was built        |
| Failure surface | Non-zero exit, process error, abort signal, or post-conversion audit failure |

The relevant FFmpeg contracts are:

- `-map` selects streams. A trailing `?` makes a stream mapping optional, so
  `-map 0:v:0?` accepts files without artwork.
- `-map_metadata 0:g` explicitly maps input global metadata to output global
  metadata. FFmpeg otherwise copies global metadata from the first input by
  default, but an explicit mapping makes the preservation intent testable and
  stable when more inputs or mappings are introduced.
- The MP3 muxer writes ID3v2.3 or ID3v2.4 and accepts attached pictures as
  single-packet video streams. Picture-stream `title` and `comment` become the
  APIC description and picture type.
- The MOV/MP4 muxer's `use_metadata_tags` flag writes metadata through `mdta`
  atoms. It is not suitable for this feature: the empirical probe retained
  arbitrary keys but lost artwork and stopped the installed
  `music-metadata` version from normalizing the common fields.
- ADTS AAC has a separate `write_id3v2` option, disabled by default. It does
  not apply to this repository's AAC preset because that preset writes
  `.m4a`, which selects the MOV-family muxer.

### ffprobe

[ffprobe](https://ffmpeg.org/ffprobe.html) is useful for empirical validation
and fixture development, but the production audit should use the already
installed `music-metadata` API. Depending on a second executable would expand
the runtime surface without providing normalized ID3/Vorbis/iTunes semantics.

Like FFmpeg, ffprobe has no authentication, endpoint, rate-limit, or usage-cost
contract.

## Libraries and SDKs

### `music-metadata`

Sources:

- [Official repository and API documentation](https://github.com/Borewit/music-metadata)
- [npm package](https://www.npmjs.com/package/music-metadata)

The repository supports MP3, MP4/M4A, FLAC, Ogg, and Opus along with ID3v2,
iTunes, and Vorbis tags. Its Node API is:

```ts
parseFile(filePath: string, options?: IOptions): Promise<IAudioMetadata>
```

`IAudioMetadata.common` provides normalized fields, while
`IAudioMetadata.native` retains the original tag IDs and values.
`skipCovers` defaults to `false`; setting it to `true` deliberately omits
embedded pictures. `selectCover()` chooses a cover by picture type and falls
back to the first picture.

Repository state:

| Item                           | Value                                           |
| ------------------------------ | ----------------------------------------------- |
| Declared range                 | `^11.0.0`                                       |
| Lockfile version               | `11.10.6`                                       |
| npm version checked 2026-07-28 | `11.14.0`                                       |
| Runtime                        | Pure ESM, Node.js 18 or newer                   |
| Role                           | Reader and normalizer; not a general tag writer |

The installed version already reads every source and destination format in
scope, pictures, native tags, and normalized ratings. An upgrade is not needed
unless implementation uncovers a specific parser defect.

### `node-id3`

Sources:

- [Official repository and API documentation](https://github.com/Zazama/node-id3)
- [npm package](https://www.npmjs.com/package/node-id3)

The repository documents that `write()` removes existing tags, while
`update()` keeps or overwrites existing tags. It supports APIC, POPM, TXXX,
album artist, track/disc numbers, and the common ID3 text fields. POPM accepts
an email, a rating from 1 through 255, and a counter.

The lockfile and current npm version are both `0.2.9`. It should remain a
narrow MP3 post-processor through the repository's existing `writeRating()`
abstraction. It is not a cross-container solution.

An empirical `update()` of FFmpeg's ID3v2.4 output:

- retained common text, APIC artwork, and custom TXXX frames;
- added a POPM rating readable through `music-metadata.common.rating`; and
- rewrote the ID3 tag as ID3v2.3.

That version rewrite is acceptable only if tests prove the repository's
semantic preservation contract; native-frame byte parity must not be claimed.

### `flac-metadata`

Sources:

- [Official repository and usage documentation](https://github.com/claus/flac-metadata)
- [npm package](https://www.npmjs.com/package/flac-metadata)

The installed and current npm version is `0.1.1`. It is a FLAC transform-stream
processor that can inspect, remove, and inject FLAC metadata blocks. Its
documentation demonstrates Vorbis-comment and picture blocks, but it cannot
write MP3, M4A, or Opus targets. It should remain behind the existing FLAC
rating writer and should not be extended into this conversion path.

## Empirical Compatibility Matrix

The following probe was run locally on 2026-07-28 with:

- FFmpeg and ffprobe `8.1.2`;
- `music-metadata` `11.10.6`; and
- `node-id3` `0.2.9`.

The generated FLAC source contained title, artist, album, album artist, track
`3/9`, disc `1/2`, date, genre, comment, `RATING=80`,
`CUSTOM_TAG=custom-value`, and a 32-by-32 PNG front cover.

| Target and invocation                          | Common text                        | Rating                                              | Custom text       | Artwork                                                          | Result                                 |
| ---------------------------------------------- | ---------------------------------- | --------------------------------------------------- | ----------------- | ---------------------------------------------------------------- | -------------------------------------- |
| MP3, current automatic selection               | Preserved                          | Stored as `TXXX:RATING`; not normalized as a rating | Preserved as TXXX | Preserved as APIC                                                | Success                                |
| MP3, then `node-id3.update()` POPM             | Preserved                          | Preserved semantically as POPM                      | Preserved         | Preserved                                                        | Success; output ID3 version became 2.3 |
| AAC/ALAC M4A, current automatic selection      | N/A                                | N/A                                                 | N/A               | Automatic PNG-to-H.264 selection is unsupported by the M4A muxer | Conversion failed                      |
| AAC/ALAC M4A, explicit picture copy            | Preserved                          | Dropped                                             | Dropped           | Preserved as `covr`                                              | Success                                |
| AAC/ALAC M4A with `use_metadata_tags`          | Not normalized by installed parser | Raw key retained                                    | Raw key retained  | Dropped                                                          | Unsuitable                             |
| Opus, automatic or audio-only explicit mapping | Preserved                          | Preserved as Vorbis `RATING`                        | Preserved         | Dropped                                                          | Success with artwork warning required  |
| Opus with explicit attached-picture mapping    | N/A                                | N/A                                                 | N/A               | Muxer reports unsupported codec for the picture stream           | Conversion failed                      |

These results are implementation evidence, not a universal guarantee across
every FFmpeg build. Tests should mock the exact argument policy, while a small
fixture integration test can be enabled where FFmpeg is available.

## Integration Patterns

### Pattern 1: Explicit Per-Target FFmpeg Policy

Use one typed policy beside the conversion implementation. Preserve the primary
attached picture for MP3 and M4A targets; do not map a video stream to Opus.

```ts
type OutputFormat = "mp3" | "aac" | "alac" | "opus";

function buildMappingArgs(format: OutputFormat): string[] {
  const metadata = ["-map", "0:a:0", "-map_metadata", "0:g"];

  if (format === "opus") {
    return metadata;
  }

  return [...metadata, "-map", "0:v:0?", "-c:v", "copy", "-disposition:v:0", "attached_pic"];
}

const args = ["-i", source, ...buildMappingArgs(format), "-c:a", preset.codec, ...preset.options, "-y", destination];
```

Do not pass an option and its value as one array element. For example,
`["-b:a", "320k"]` is valid for direct `spawn()`;
`["-b:a 320k"]` is not.

### Pattern 2: Normalize Before, Audit After

Read artwork during the preservation pass; existing metadata and rating paths
that use `skipCovers: true` are intentionally insufficient for this feature.

```ts
import { parseFile, selectCover } from "music-metadata";

const sourceMetadata = await parseFile(source, { skipCovers: false });
const primaryArtwork = selectCover(sourceMetadata.common.picture);

await runFfmpeg(args);

const outputMetadata = await parseFile(destination, { skipCovers: false });
```

Build the audit from canonical fields rather than comparing all native IDs:

- guaranteed when present and representable: title, artists, album, album
  artist, track/disc numbers and totals, date/year, genre, and primary artwork;
- rating: normalized semantically, then written in the target's supported
  representation;
- compatible custom text: preserve when the muxer supports it, otherwise warn;
- binary, structured, or target-incompatible native tags: warn rather than
  claiming silent preservation.

The audit should distinguish:

- a supported mapping that unexpectedly disappeared, which is fatal; and
- an unsupported target representation known before conversion, which is a
  non-fatal structured warning.

### Pattern 3: MP3 Rating Translation

FFmpeg's generic mapping is not sufficient for the repository's MP3 rating
contract. Preserve the normalized source rating through the existing
abstraction:

```ts
const sourceRating = await readRating(source);

await runFfmpeg(args);

if (format === "mp3" && sourceRating) {
  const result = await writeRating(destination, sourceRating.value, {
    preserveTags: true,
  });

  if (!result.success) {
    throw new ConversionError(`Failed to preserve MP3 rating: ${result.message}`);
  }
}
```

The source rating must be captured before any later synchronization step.
Callers that intentionally apply a Plex rating after conversion remain the
later authority.

## Constraints and Gotchas

1. **Default metadata copying is not a capability guarantee.** FFmpeg maps
   global metadata by default, but each output muxer decides which keys and
   stream types it can encode.
2. **Artwork is a stream at the FFmpeg boundary.** Parsing only text tags or
   using `skipCovers: true` cannot establish artwork preservation.
3. **M4A needs explicit picture codec handling.** With the probe source,
   automatic selection tried H.264 and failed. Copying the PNG picture stream
   succeeded.
4. **`use_metadata_tags` trades compatibility for arbitrary keys.** In the
   probe it retained raw names but removed the cover and produced native keys
   that `music-metadata` `11.10.6` did not map to common fields.
5. **Opus artwork is not a video stream.** The muxer rejected direct picture
   mapping. Implementing `METADATA_BLOCK_PICTURE` serialization would be a
   separate feature and is unnecessary when issue #42 explicitly allows
   warnings for target limitations.
6. **Ratings are semantic, not string-identical.** Vorbis `RATING=80`,
   ID3 POPM `204`, and a normalized value near `0.8` can represent the same
   user rating.
7. **Native tags are not portable one-to-one.** ID3 frames such as POPM/APIC
   and iTunes atoms such as `covr` require translation. Unknown binary or
   structured tags need a warning policy.
8. **`node-id3.update()` is not byte-preserving.** It retained the tested
   fields but changed the ID3 version. Audit semantics, not raw bytes.
9. **FFmpeg availability differs by environment.** The local probe has FFmpeg
   `8.1.2`; the rfmedia CLI CI workflow does not install it explicitly.
   Contract tests should mock `spawn()`, and any real-FFmpeg test must be
   deliberately gated or provisioned.
10. **No API retry strategy applies.** Process failures should remain typed
    conversion failures. Unsupported target fields should not be inferred from
    FFmpeg stderr; derive them from the target policy and confirm with the
    output audit.

## Code Examples

### Target Capability Declaration

```ts
interface TagCapabilities {
  artwork: boolean;
  customText: boolean;
  rating: "popm" | "vorbis" | "unsupported";
}

const TAG_CAPABILITIES = {
  mp3: { artwork: true, customText: true, rating: "popm" },
  aac: { artwork: true, customText: false, rating: "unsupported" },
  alac: { artwork: true, customText: false, rating: "unsupported" },
  opus: { artwork: false, customText: true, rating: "vorbis" },
} as const satisfies Record<OutputFormat, TagCapabilities>;
```

This declaration keeps warnings deterministic and prevents target checks from
being scattered across conversion callers.

### Primary Artwork Selection

```ts
import { parseFile, selectCover } from "music-metadata";

async function readPrimaryArtwork(filePath: string) {
  const metadata = await parseFile(filePath, { skipCovers: false });
  return selectCover(metadata.common.picture);
}
```

The direct FFmpeg path usually does not need to materialize this buffer; it can
copy the input picture stream. The parsed picture exists to define and audit
the contract.

## Open Questions

1. Does "all metadata tags" mean the documented canonical fields plus
   compatible custom text, or must lyrics, chapters, identifiers, replay-gain
   structures, and unknown binary frames also be enumerated?
2. Is preserving one primary artwork image sufficient, or must multiple APIC
   and FLAC picture blocks be retained where the target permits them?
3. Should MP3 output deliberately standardize on ID3v2.3 because
   `node-id3.update()` rewrites to it, or is semantic compatibility across
   either ID3v2.3/2.4 the intended contract?
4. For M4A, should a source rating/custom key always produce a warning, or only
   warnings for the canonical fields explicitly named in issue #42?
5. Should the production audit parse every successful output, or can it be
   limited to conversions whose source contained metadata requiring target
   translation?
6. If real-FFmpeg integration coverage is required in CI, which workflow will
   provision and pin FFmpeg so muxer behavior is reproducible?
