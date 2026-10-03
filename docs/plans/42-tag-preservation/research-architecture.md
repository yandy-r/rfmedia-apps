# Architecture Research: 42-tag-preservation

## System Overview

Tag preservation belongs at the `rfmedia-cli` conversion library boundary, not in each command or
action. Every relevant workflow ultimately calls `convertFile()` in
`packages/rfmedia-cli/src/lib/convert.ts`; centralizing source-tag extraction, destination mapping,
and format-limitation warnings there gives ordinary copy, sync, Plex export/copy, and verify repair
the same behavior without duplicating policy across callers.

The CLI is an ESM TypeScript package with Commander command definitions, framework-agnostic action
modules, and shared library utilities. Conversion currently delegates directly to an FFmpeg child
process, while metadata/rating reads and rating writes are separate library concerns built on
`music-metadata`, `node-id3`, and `flac-metadata`.

## Relevant Components

- `packages/rfmedia-cli/src/lib/convert.ts`: Central conversion façade. It owns target presets,
  destination naming, FFmpeg availability, FFmpeg argument construction, progress parsing, abort
  propagation, and conversion errors. Its current FFmpeg arguments select an audio codec and output
  path but do not explicitly map input metadata or embedded artwork streams.
- `packages/rfmedia-cli/src/lib/ratings.ts`: Reads normalized ratings from `music-metadata` common
  tags and falls back to native MP3 POPM or Vorbis `RATING` fields. `readRating()` currently parses
  with `skipCovers: true`, so it is suitable for rating extraction but not embedded-artwork
  preservation.
- `packages/rfmedia-cli/src/lib/metadata.ts`: Performs a single `music-metadata` parse for common
  title, genre, year, BPM, artist, artists, album, and album-artist fields. It duplicates native
  rating extraction from `ratings.ts` and also uses `skipCovers: true`; it is a useful precedent but
  is currently filter-oriented rather than a lossless conversion metadata model.
- `packages/rfmedia-cli/src/lib/tag-writer.ts`: Destination-side rating writer. MP3 uses
  `node-id3.update()` to retain existing ID3 data while adding POPM; FLAC rebuilds the Vorbis
  comment block while retaining non-rating comments. OGG/Opus and M4A/AAC rating writes are
  explicitly unsupported, and this module does not write the full issue #42 tag set.
- `packages/rfmedia-cli/src/types/index.ts`: Defines `NormalizedRating` and `RatingSource`, including
  POPM email and play-count information that can matter when translating ratings.
- `packages/rfmedia-cli/src/types/options.ts`: Defines the existing target union,
  `ConvertFormat = "alac" | "mp3" | "aac" | "opus"`. Tag preservation is transparent behavior for
  this existing option rather than a new command mode.
- `packages/rfmedia-cli/src/actions/copy-album.ts`: Recursively converts audio files through
  `convertFile()`, copies non-audio sidecars unchanged, records conversion history, and runs plugin
  hooks around the operation.
- `packages/rfmedia-cli/src/actions/copy-filter.ts`: Filters tracks using ratings/metadata, then
  calls `convertFile()` through `copyOrConvertFile()`. Range copies reuse the first converted
  artifact, so preserving tags on the first conversion automatically preserves them across later
  hardlinks/copies.
- `packages/rfmedia-cli/src/actions/sync.ts`: Uses the same conversion façade for incremental sync.
- `packages/rfmedia-cli/src/actions/verify-album.ts` and
  `packages/rfmedia-cli/src/actions/verify-filter.ts`: Repair missing or mismatched converted
  artifacts by staging a fresh `convertFile()` result before validated replacement. A fix at the
  conversion boundary therefore also fixes repair output.
- `packages/rfmedia-cli/src/actions/plex-copy.ts` and
  `packages/rfmedia-cli/src/actions/plex-playlist.ts`: Convert through the shared façade, then may
  call `syncTrackRating()` when Plex rating synchronization is enabled. That post-conversion write
  is an intentional later authority and must remain after source-tag preservation.
- `packages/rfmedia-cli/src/lib/sync-helper.ts`: Converts a Plex 0-10 rating to normalized form and
  delegates to `tag-writer.ts`. It is not a general conversion metadata path.
- `packages/rfmedia-cli/src/lib/logger.ts`: All logs, including `logWarn()`, go to stderr. This is
  the correct boundary for required format-limitation warnings without corrupting JSON stdout.
- `packages/rfmedia-cli/src/lib/convert.test.ts`: Current focused coverage only proves abort
  behavior and signal forwarding; it does not pin metadata/artwork FFmpeg arguments or
  post-conversion tag handling.
- `packages/rfmedia-cli/src/lib/tag-writer.test.ts`: Pins rating-writer format behavior and
  preservation semantics, including current destination-format limitations.
- `packages/rfmedia-cli/docs/features/audio-conversion.doc.md`: Documents the existing conversion
  flow, first-copy optimization, FFmpeg process boundary, and affected copy actions.
- `ROADMAP.md`: Lists issue #42 as medium-priority core copy/convert correctness with the explicit
  exit condition that conversion preserves tags.

## Data Flow

1. Existing CLI, queue, plan, and MCP entry points validate an existing `convertFormat` and ensure
   FFmpeg is available; no new command surface is required for the issue's default-preservation
   contract.
2. An action computes the converted destination filename and calls
   `convertFile(source, destination, format, progress?, signal?)`.
3. `convertFile()` ensures the destination directory, looks up the `ConversionPreset`, spawns
   FFmpeg, parses stderr for progress/errors, and resolves only after the output file is complete.
   This is the narrow point where source metadata can be read once, mapped to target-compatible
   fields, artwork streams can be explicitly included, and unsupported fields can be reported.
4. Album/filter/playlist range workflows use the first completed conversion as the source for
   subsequent copies or hardlinks. No later per-copy metadata pass is needed.
5. The action records history/inventory and invokes after-copy behavior. Plex-backed flows may then
   overwrite the destination rating from Plex; source preservation must not run after that step.
6. Verify-fix paths materialize a staged conversion through the same function, validate the staged
   artifact, and atomically replace the destination, so conversion metadata failures must surface
   before `convertFile()` reports success.

There are two distinct metadata channels that must not be conflated:

- FFmpeg/container metadata and embedded artwork, which should be handled as part of conversion.
- Application-specific rating tags, normalized today by `ratings.ts` and written only for a subset
  of formats by `tag-writer.ts`.

## Integration Points

The primary integration point is `convertFile()` and its `ConversionPreset`. The preset is the
natural place to associate target-container metadata/artwork capabilities with the existing codec,
extension, and output arguments. Keeping the behavior inside this façade preserves every existing
caller and avoids changes to command/action contracts.

`ratings.ts` is the source of truth for interpreting POPM and Vorbis rating scales. Any reusable
rating extraction used by conversion should be exposed from that module rather than adding a third
copy of the parsing rules already duplicated in `metadata.ts`. A conversion-oriented metadata
model must also retain artwork and tag values beyond the filter-oriented `ExtendedMetadata`
projection.

`tag-writer.ts` can remain the format-specific rating mutation layer where it supports the
destination. Its limitations must be modeled explicitly: MP3 is supported, while current target
formats M4A/AAC and Opus cannot receive ratings through this writer. Conversion should not silently
claim full preservation when the target container or available writer cannot represent a source
field; use `logWarn()` on stderr, and keep successful audio conversion distinct from best-effort tag
translation.

Existing action-level interactions need preservation, not parallel implementations:

- Plugin `beforeCopy`/`afterCopy` hooks continue to wrap the final converted artifact.
- History still records one `convert` operation.
- Inventory hashes the completed destination, so all tag writes must finish before returning.
- Plex rating sync remains a post-conversion override when enabled.
- Staged verify repair must receive the same complete, tagged output as first-time copy.

No Bash, Zsh, or Fish completion template change is architecturally required unless implementation
adds a new user-visible flag or format. The issue's stated behavior can be delivered behind the
existing `--convert` option.

## Key Dependencies

- `ffmpeg` executable: Performs transcoding and is the only process boundary in `convert.ts`.
  Explicit metadata/artwork mapping and target muxer behavior are part of its argument contract.
- `music-metadata` (`^11.0.0`): Reads normalized common tags, native tag frames/comments, and
  embedded pictures. Existing readers intentionally skip pictures for filter performance, so
  conversion needs a purpose-specific parse path or options.
- `node-id3` (`^0.2.6`): Writes/updates MP3 ID3 tags and is the existing POPM destination writer.
- `flac-metadata` (`^0.1.0`): Rewrites FLAC Vorbis comments while preserving other FLAC metadata
  blocks. FLAC is a supported source but is not currently a conversion target.
- `node:child_process`, `AbortSignal`, and filesystem helpers: Define conversion lifecycle,
  cancellation, destination creation, and error propagation.
- `@rfmedia/common` logger via `lib/logger.ts`: Preserves stdout/JSON separation for
  format-limitation warnings.

## Architectural Constraints

- Preserve the command/action/library separation: commands validate inputs, actions orchestrate,
  and conversion/tag policy stays in `lib/`.
- Keep `convertFile()` atomic from a caller's perspective: it must resolve only after audio and all
  supported metadata work are complete, or reject with an actionable conversion failure.
- Do not turn tag loss into silent success. Warnings should identify unsupported source-to-target
  fields without logging tag values or other potentially sensitive metadata.
- Avoid caller-specific metadata fixes; they would miss verify repair, sync, or future conversion
  consumers.
- Avoid reusing the filter-oriented `ExtendedMetadata` type as a lossless tag bag: it intentionally
  omits track number, date variants, artwork, custom/native fields, and other information in issue
  #42's preservation scope.
- Preserve the first-copy optimization. Tag preservation must happen once on the first conversion,
  before subsequent hardlinks/copies and before inventory hashing.
- Critical test coverage should concentrate on the conversion contract (FFmpeg metadata/artwork
  arguments, rating translation, unsupported-field warning, cancellation/error behavior) rather
  than duplicating equivalent assertions across every action caller.
