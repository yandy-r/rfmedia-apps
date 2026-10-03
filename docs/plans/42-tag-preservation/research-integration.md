# Integration Research: 42-tag-preservation

## Executive Summary

Issue #42 is a file-format integration change, not an HTTP API or database feature. The central
integration point is `packages/rfmedia-cli/src/lib/convert.ts`: every copy, sync, Plex export, and
verify-fix path delegates conversion to `convertFile()`, so metadata must be finalized before that
function resolves. The current dependency set can read broad metadata and can write MP3 and FLAC
ratings, but it cannot byte-for-byte round-trip every native tag across all target containers.
Implementation therefore needs an explicit contract: preserve every representable tag, normalize
the required portable fields (artist, album, title, track, date/year, genre, rating, artwork), and
emit a specific warning for each target-format limitation rather than silently dropping data.

GitHub issue #42 has no parent, tracked issue, or child issues as of 2026-07-28.

## API and CLI Surface

There are no API endpoints, routes, middleware, credentials, or remote services involved.
`ConvertFormat` is already `"alac" | "mp3" | "aac" | "opus"` at
`packages/rfmedia-cli/src/types/options.ts:75`; FLAC is a supported input extension but is not a
conversion target.

The preservation behavior should remain automatic when `--convert` is used. No new CLI option or
configuration key is required by the issue, so Bash, Zsh, and Fish completion templates should not
change unless implementation introduces a user-facing flag despite this recommendation.

`convertFile()` is called by these integration paths:

- `packages/rfmedia-cli/src/actions/copy-album.ts`
- `packages/rfmedia-cli/src/actions/copy-filter.ts`
- `packages/rfmedia-cli/src/actions/sync.ts`
- `packages/rfmedia-cli/src/actions/plex-copy.ts`
- `packages/rfmedia-cli/src/actions/plex-playlist.ts`
- `packages/rfmedia-cli/src/actions/verify-album.ts`
- `packages/rfmedia-cli/src/actions/verify-filter.ts`

Keeping extraction, FFmpeg mapping, target-specific rating/artwork work, and warnings inside the
conversion boundary gives every caller identical behavior. Duplicating post-processing in callers
would be error-prone and would miss verify-fix or Plex-driven conversion paths.

## Database and Persistent State

No schema, table, migration, or database query is needed. Embedded metadata lives only in the
source and destination media files.

There is nevertheless an ordering constraint with existing state:

1. `convertFile()` must finish audio encoding and all metadata writes.
2. The caller may then record the convert operation.
3. Inventory and verification code may then hash the final destination bytes.

For example, `copy-album.ts:258-266` awaits `convertFile()`, records the operation, and then hashes
the destination. Metadata written after `convertFile()` resolves would invalidate stored content
hashes and make later verification report false drift. The same rule applies to staged verify-fix
artifacts: tag finalization belongs before staged content is accepted or moved into place.

## Installed Dependency Capabilities

Exact resolved versions come from the current `package-lock.json`.

| Dependency       | Resolved version | Relevant capability                                                                                                                                                             | Gap for issue #42                                                                                                                                                                                     |
| ---------------- | ---------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `music-metadata` |          11.10.6 | Read-only parsing of common and native ID3, Vorbis, FLAC, MP4/iTunes, APE, ASF, RIFF, and related tags; exposes `common.picture`, `common.rating`, and `native` tag collections | It is not a writer. `native` values are parsed objects/unknown values, not a lossless serialization API. Existing rating reads use `skipCovers: true`, so conversion needs its own cover-aware parse. |
| `node-id3`       |            0.2.9 | Reads and writes MP3 ID3 tags; `update()` preserves existing frames; supports ordinary aliases, raw supported frame IDs, APIC artwork, TXXX custom text, and POPM ratings       | MP3 only. It cannot write Vorbis/Opus or MP4 atoms, and it does not promise arbitrary unknown-frame round trips.                                                                                      |
| `flac-metadata`  |            0.1.1 | Streaming transformation of FLAC metadata blocks, including Vorbis comments and picture blocks                                                                                  | FLAC only. It does not write Ogg/Opus or M4A; FLAC is not currently a conversion target.                                                                                                              |
| system `ffmpeg`  |     probed 8.1.2 | Audio transcoding, container tag mapping, and attached-picture stream mapping; current build includes `libmp3lame` and `libopus`                                                | Runtime version/build is external and not pinned by the repository. Muxers translate only supported metadata, so mapping is not lossless across tag systems.                                          |

The existing `packages/rfmedia-cli/src/lib/tag-writer.ts` is reusable for an MP3 destination rating:
it writes POPM with `NodeID3.update()` and preserves the tags FFmpeg already produced. Its FLAC
writer atomically replaces a same-directory temporary file while preserving non-RATING comments
and other FLAC metadata blocks. Its current contract explicitly rejects Ogg/Opus and M4A/AAC
ratings (`tag-writer.ts:72-95`).

No installed universal tag-writing library covers MP3, Opus/Vorbis, and M4A. If the implementation
requires embedded Opus artwork rather than a documented warning, it needs either a narrowly scoped
`METADATA_BLOCK_PICTURE` writer or an additional maintained tag-writing dependency; the current
packages cannot perform that write.

## FFmpeg Metadata and Stream Mapping Semantics

The current command is assembled at `convert.ts:254-267` as:

```text
ffmpeg -i <source> -acodec <preset codec> <bitrate options> -y <destination>
```

FFmpeg's documented defaults copy global metadata from the first input and copy per-stream
metadata with selected streams. An explicit `-map_metadata 0` makes that intent auditable but does
not expand what the destination muxer can represent. Any explicit `-map` switches stream selection
to manual mode, so audio and optional cover streams must both be deliberately selected.

Attached artwork is exposed to FFmpeg as a video stream. Without `-map`, FFmpeg selects one stream
of each type accepted by the output format, then applies that muxer's default encoder unless a
codec is specified. This matters because:

- MP3 and FLAC muxers advertise PNG as their default video codec; the probe preserved an attached
  PNG automatically.
- The iPod/M4A muxer selected the cover but tried its default H.264 video encoder, causing the
  current AAC command to fail before writing a valid file.
- Mapping the optional cover and setting `-c:v copy` produced valid AAC/ALAC M4A output with
  standard tags and artwork in the current FFmpeg build.
- The Opus muxer accepts audio only. The attached cover stream was omitted, so Opus artwork needs a
  `METADATA_BLOCK_PICTURE` Vorbis comment rather than a video stream.

The portable FFmpeg mapping should therefore be format-aware rather than one common argument list:
select the intended audio stream explicitly, map global metadata, and map/copy an optional attached
picture only for muxers that support it. Do not assume that successful global tag mapping implies
rating or artwork preservation.

### Reproducible Environment Probe

The following behavior was observed with the installed FFmpeg 8.1.2 and parsed again with installed
`music-metadata` 11.10.6:

| FLAC source field                        | MP3 using current args      | Opus using current args     | M4A using current args                  | M4A with explicit cover copy         |
| ---------------------------------------- | --------------------------- | --------------------------- | --------------------------------------- | ------------------------------------ |
| title, artist, album, track, date, genre | Preserved                   | Preserved                   | Conversion failed when source had cover | Preserved                            |
| custom text `CUSTOMTAG`                  | Preserved as ID3 TXXX       | Preserved as Vorbis comment | Conversion failed                       | Dropped by standard iTunes atom mode |
| text `RATING=0.80`                       | Preserved as TXXX, not POPM | Preserved as Vorbis comment | Conversion failed                       | Dropped                              |
| attached PNG                             | Preserved as APIC           | Dropped                     | Caused default H.264 mux failure        | Preserved as `covr`                  |

Using the MOV muxer's `use_metadata_tags` flag retained arbitrary M4A text keys in the probe, but
`music-metadata` no longer exposed them as standard common tags and the attached picture was lost.
That mode is therefore not an acceptable blanket solution for portable M4A output.

## Target Format Limitations

| Target      | Portable fields                                                      | Custom/native fields                                                                                                                                         | Rating                                                                                                                        | Artwork                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MP3         | Strong ID3 mapping for required text fields                          | FFmpeg maps many unknown text keys to TXXX; `node-id3` can write supported raw frames, but unrelated binary/private native frames are not generally portable | Must write POPM explicitly after FFmpeg; FFmpeg does not translate a source-only POPM into a Vorbis-style field or vice versa | Supported as ID3 APIC; optional input cover stream should be copied                                                                                                                    |
| AAC in M4A  | Standard iTunes atoms cover required text fields                     | Arbitrary custom keys are not portable in standard atom mode                                                                                                 | No interoperable embedded user-rating field in the current code/dependencies; warn                                            | Supported as `covr`; requires explicit optional cover mapping and stream copy                                                                                                          |
| ALAC in M4A | Same container/tag constraints as AAC                                | Same as AAC                                                                                                                                                  | Same as AAC; warn                                                                                                             | Same as AAC                                                                                                                                                                            |
| Opus        | Vorbis comments preserve standard and arbitrary UTF-8 key/value text | Strong for text comments; native binary/structured ID3 frames still require semantic conversion                                                              | Write a normalized `RATING` comment explicitly; source POPM is otherwise lost                                                 | Opus convention is a base64 FLAC picture block in `METADATA_BLOCK_PICTURE`; current FFmpeg stream mapping and installed writers do not create it, so implement it or warn specifically |

“Preserve all tags” cannot mean byte-identical native frames after a container change: ID3 POPM,
APIC, PRIV, UFID, and chapters do not have one-to-one representations in Vorbis or MP4, and M4A
does not expose arbitrary iTunes-style fields through the standard muxing mode. The faithful
contract is:

1. Preserve every source tag for which the target has a compatible representation.
2. Semantically translate the required canonical fields.
3. Preserve compatible custom text fields where the muxer supports them.
4. Report the exact field/class that cannot be represented; never silently claim full
   preservation.

## Rating Behavior

`packages/rfmedia-cli/src/lib/ratings.ts` already understands:

- MP3 ID3v2.3/v2.4 POPM, including multiple email identifiers and counters.
- FLAC/Ogg/Opus `RATING`, with intended detection of normalized, 5-star, and percent scales.
- M4A/AAC as unsupported for file-based user ratings.

Two integration details are critical:

1. FFmpeg does not translate an MP3 that contains only POPM into a destination Vorbis `RATING`.
   A controlled MP3-to-FLAC/Opus probe retained title but lost POPM entirely. The conversion path
   must read the normalized rating before encoding and write it in the target convention.
2. `readRating()` currently checks `metadata.common.rating` before native Vorbis data
   (`ratings.ts:59-80`). With installed `music-metadata` 11.10.6, a literal Vorbis
   `RATING=0.80` was returned through `common.rating` as `0.008`, while the existing native parser
   would interpret it as `0.8`. Issue #42's planned `ratings.ts` change must make the native Vorbis
   scale-aware path authoritative for Vorbis-family files, or otherwise prevent this 100x rating
   distortion. The same duplicated common-first logic exists in `readRatingAndFormat()` and
   `metadata.ts`, so shared extraction should avoid another divergent rating parser.

Rating preservation should keep the source POPM email/counter where the target is MP3 if feasible;
the current `writeRating()` instead defaults the email to `no@email` and resets the counter to zero.
At minimum, star value preservation is required; preserving source identity/counter is the closer
interpretation of “all metadata.”

## Artwork Behavior

`music-metadata` exposes embedded covers as `common.picture[]` when `skipCovers` is false. Existing
rating and extended-metadata reads intentionally set `skipCovers: true` for scan performance, so
the conversion path must not reuse those optimized reads as its only metadata snapshot.

Format handling must preserve more than “the first image” when possible:

- ID3 and FLAC allow multiple pictures with types/descriptions.
- Xiph's Vorbis convention permits multiple `METADATA_BLOCK_PICTURE` fields, with ordering relevant
  to some applications.
- The current FFmpeg automatic selection chooses one video stream, so it cannot prove preservation
  of every embedded picture.

The minimum issue contract names artwork singularly, so preserving a primary/front cover and
warning when additional pictures cannot be represented is defensible. Silent loss of all artwork
for Opus is not.

## Internal Service and Process Boundary Constraints

There are no credentials or network requests. The external trust boundary is the spawned FFmpeg
process and the untrusted media file it parses.

- Keep `spawn("ffmpeg", args)` with an argument array. Do not build a shell command from file paths
  or tag values; the current process boundary prevents shell metacharacter injection.
- Do not flatten arbitrary native tag values or binary artwork into `-metadata key=value` command
  arguments. Besides type ambiguity, covers or large comments can exceed the OS argument-size
  limit. Prefer FFmpeg's direct metadata mapping, bounded normalized values, or a controlled
  temporary metadata file/writer.
- Validate metadata keys before using them as FFmpeg option data. Vorbis field names exclude `=`;
  NUL bytes are invalid process arguments; values may be very large or malformed.
- Preserve cancellation. `convertFile()` passes the caller's `AbortSignal` to `spawn` and returns
  the abort reason. Any pre-read or post-write phase must check the same signal and clean temporary
  artifacts.
- Bound cover count and total cover bytes before buffering. `music-metadata` returns picture data
  in memory, so malicious files can otherwise amplify memory use across parallel workers.
- Keep warnings free of raw binary values and avoid logging full sensitive/custom tag contents.
  Paths and tag names are sufficient for actionable diagnostics.
- Distinguish incompatibility from corruption. A target-format limitation should return/log a
  warning while retaining a valid conversion; parse failure, tag-writer failure for a supposedly
  supported mapping, or invalid output should remain a conversion failure.
- Finalize metadata before success is reported. A tag-writer error after FFmpeg exits zero must not
  leave the caller believing hashes and history represent a fully preserved artifact.

The current conversion writes directly to the final path with `-y`. Where callers do not already
stage output, a robust implementation should either clean a failed partial file or perform the
whole encode-plus-tag operation on a same-directory temporary path and atomically replace the
destination after validation.

## Configuration and Warning Contract

No new configuration is required. Warnings should be structured enough to identify:

- source path and target format;
- tag or class (`rating`, `artwork`, custom text, unknown native frame);
- reason (`unsupported by target`, `unsupported by installed writer`, malformed value);
- whether the output remains usable.

If `ConversionResult` gains a warning collection, existing callers can remain source-compatible
because they currently await the result but do not consume its fields. User visibility still needs
to flow through the existing logger so ordinary and JSON modes do not silently discard warnings.

## Implementation Implications

1. Add one cover-aware metadata snapshot before FFmpeg, based on
   `music-metadata.parseFile(source)` without `skipCovers`.
2. Make rating extraction share the format-aware parser in `ratings.ts`; do not rely on
   `common.rating` for Vorbis-family scale detection.
3. Build format-specific FFmpeg mappings in `convert.ts`, including explicit audio selection,
   metadata mapping, and supported optional artwork mapping/copy.
4. After FFmpeg, write the normalized rating in the destination convention:
   - MP3: existing `writeRating()`/POPM, extended if preserving POPM identity/counter.
   - Opus: safe explicit `RATING` comment support.
   - M4A: warn that user rating cannot be represented.
5. Compare the source snapshot with a destination parse for the required canonical fields and
   produce warnings for representational losses. Do this before returning so hashes include final
   bytes.
6. Keep tests contract-focused: argument mapping for each target family, POPM-to-MP3/Opus rating
   semantics, M4A limitation warnings, primary artwork preservation, and cancellation/cleanup.
   Avoid duplicating every caller test because all callers share `convertFile()`.

## Official Technical References

- [FFmpeg metadata mapping and defaults](https://ffmpeg.org/ffmpeg.html#Advanced-options)
- [FFmpeg automatic and manual stream selection](https://ffmpeg.org/ffmpeg.html#Stream-selection)
- [music-metadata supported tag headers and parse API](https://github.com/Borewit/music-metadata)
- [node-id3 update behavior, APIC, TXXX, and POPM support](https://github.com/Zazama/node-id3)
- [Xiph Vorbis comment specification](https://xiph.org/vorbis/doc/v-comment.html)
- [Xiph `METADATA_BLOCK_PICTURE` convention](https://wiki.xiph.org/VorbisComment)
