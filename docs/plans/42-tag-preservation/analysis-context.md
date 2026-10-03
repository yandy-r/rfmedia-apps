# Context Analysis: Tag Preservation During Conversion

## Executive Summary

Issue #42 should be implemented at the shared `convertFile()` boundary so every existing
conversion caller receives identical preservation behavior without caller-specific patches.
The change is a conversion-pipeline enhancement, not a CLI, configuration, database, action
schema, MCP, or completion-surface feature. Its core is a new pure
`conversion-metadata.ts` module that snapshots source metadata, selects an exhaustive
target-format policy, prepares explicit FFmpeg mappings, and audits the staged output before
the existing atomic publication step.

The task breakdown should separate policy and serialization from process lifecycle. Metadata
policy, native-first rating normalization, and MP3 POPM provenance can be developed
independently; `convert.ts` should remain the sole owner of spawning FFmpeg, cancellation,
temporary resources, validation, and publication. Conversion succeeds only after semantic
metadata audit. Unsupported target capabilities produce deduplicated `ConversionResult`
warnings and human-readable logs, while supported metadata that is unexpectedly absent is a
fatal error. A dependency upgrade, real-FFmpeg evidence for all four targets, documentation,
and the normal ROADMAP/PR closeout are part of completion.

## Architecture Context

### System Structure

- `packages/rfmedia-cli/src/lib/convert.ts` is the central seam used by album, filter, sync,
  Plex playlist, and verify-repair workflows. Keep target behavior here rather than
  duplicating it across the seven callers.
- `packages/rfmedia-cli/src/lib/conversion-metadata.ts` should become the pure policy layer:
  source snapshot types, per-target capability policy, FFmpeg metadata preparation, Opus
  sidecar serialization, warning generation, and destination audit.
- `packages/rfmedia-cli/src/lib/ratings.ts` should own one exported
  `extractNormalizedRating(parsed, filePath)` implementation. `metadata.ts` should consume it
  rather than maintain a second normalization path.
- `packages/rfmedia-cli/src/lib/tag-writer.ts` remains the narrow MP3 POPM writer. Extend its
  input only as needed to preserve the source POPM email and counter.
- `packages/rfmedia-cli/src/lib/filesystem.ts` already provides the validated atomic staging
  primitive. Reuse it; do not introduce a second publication mechanism.
- Existing orchestration callers remain structurally unchanged. In particular, Plex rating
  sync stays downstream of source preservation so an explicit positive Plex rating can
  intentionally override the preserved source rating.

### Data Flow

1. Parse the source once with cover-aware `music-metadata` options and build a bounded,
   normalized snapshot of canonical text, compatible custom text, native-first rating, and
   primary artwork.
2. Resolve an exhaustive policy for `mp3`, `aac`, `alac`, or `opus`; generate deterministic,
   sorted warnings for information the target cannot represent.
3. Create the existing private staged destination. For Opus only, also create a bounded,
   same-directory, exclusive `0600` ffmetadata sidecar and fully sync/close it before spawn.
4. Invoke FFmpeg with discrete argv tokens, `-nostdin`, explicit stream and metadata maps, and
   an explicit output muxer. Never combine option and value into one argv element.
5. Apply the narrow MP3 POPM post-write when the target is MP3, preserving rating provenance
   and counter.
6. Parse the staged destination once and audit every supported mapped field, normalized
   rating, and primary artwork. Treat an unexplained supported-field loss as fatal.
7. Only after the audit passes, allow `replaceFileWithValidatedStage()` to publish atomically.
   On failure or cancellation, keep the prior destination untouched and remove every stage
   and sidecar.
8. Return warnings in `ConversionResult`; emit their human rendering after successful audit.
   Existing callers continue to use the converted file before any optional Plex override.

### Integration Points

- `music-metadata` provides source and destination parsing; issue #42 requires
  `music-metadata ^11.14.0` and a lock resolution of `file-type >=21.3.4`.
- FFmpeg receives metadata through explicit native input mapping. Opus additionally uses a
  private ffmetadata input for `RATING` and `METADATA_BLOCK_PICTURE`; MP3/M4A use their native
  muxer behavior.
- `ConversionResult` and the existing `rf-common` logger are the only warning surfaces in
  scope. Broader action results and JSON/YAML/CSV/MCP contracts are deferred.
- `copy-filter.ts`, `plex-playlist.ts`, and `verify-filter.ts` are regression boundaries, not
  new metadata implementations.

## Critical Files Reference

### Create

- `packages/rfmedia-cli/src/lib/conversion-metadata.ts` — normalized snapshot, target policy,
  sidecar serializer, audit, and warning logic.
- `packages/rfmedia-cli/src/lib/conversion-metadata.test.ts` — policy tables, escaping and
  bounds, audit mismatch behavior, and warning determinism.

### Modify

- `packages/rfmedia-cli/src/lib/convert.ts` and `convert.test.ts` — integrate the policy,
  correct FFmpeg argv construction, own stage/sidecar lifecycle, return warnings, and prove
  cancellation plus atomic failure behavior.
- `packages/rfmedia-cli/src/lib/ratings.ts` and `ratings.test.ts` — export the native-first
  normalized extractor and cover common-tag scaling, Vorbis rating, and POPM provenance.
- `packages/rfmedia-cli/src/lib/metadata.ts` — remove its duplicate rating interpretation and
  delegate to `ratings.ts`.
- `packages/rfmedia-cli/src/lib/tag-writer.ts` and `tag-writer.test.ts` — preserve an optional
  POPM counter together with email and normalized rating.
- `packages/rfmedia-cli/package.json` and `package-lock.json` — upgrade the parser and resolve
  the vulnerable transitive `file-type` version.
- `packages/rfmedia-cli/docs/features/audio-conversion.doc.md`,
  `packages/rfmedia-cli/docs/features/plex-metadata-sync.md`, and
  `packages/rfmedia-cli/README.md` — document preservation, target limitations, warnings, and
  source-versus-Plex rating precedence.
- `ROADMAP.md` — update only during closeout, using live issue and dependency state.

### Preserve as Integration Boundaries

- `packages/rfmedia-cli/src/lib/filesystem.ts` — reuse its identity checks, fsync, cleanup, and
  atomic rename contract.
- `packages/rfmedia-cli/src/lib/types/options.ts` — retain the stable `ConvertFormat` surface.
- `copy-filter.ts`, `plex-playlist.ts`, and `verify-filter.ts` — retain current first-copy,
  override, and nested-repair ordering.
- Action result types, command schemas, MCP schemas, database code, Bash/Zsh/Fish completion
  templates, root README, and unrelated TODO files — explicitly outside this issue.

## Patterns to Follow

- **Central seam:** implement once in `convertFile()` and keep callers ignorant of
  target-specific tag mechanics.
- **Exhaustive typed policy:** use a discriminated or exhaustive mapping keyed by
  `ConvertFormat`; avoid scattered format conditionals and silent defaults.
- **Native-first normalization:** inspect MP3 POPM and Vorbis `RATING` before common metadata,
  then apply one scale contract. This prevents a common value such as `0.80` from becoming
  `0.008`.
- **Target-native representation:** MP3 uses canonical/custom tags, APIC, and POPM; AAC/ALAC
  use M4A atoms and `covr`; Opus uses Vorbis comments and a FLAC picture block. Preserve
  meaning, not byte-for-byte container identity.
- **Validated atomic stage:** encode, post-write, parse, and semantically audit the stage
  before the existing rename. Cleanup belongs in `finally` paths.
- **Explicit FFmpeg invocation:** raw spawn argv only, no shell interpolation, discrete
  option/value tokens, explicit maps and muxer, and no tag-derived paths or network fetching.
- **Bounded private artifacts:** sidecars are unpredictable, exclusive, same-directory,
  `0600`, synced before use, and unlinked after every outcome.
- **Scoped warnings:** sort and deduplicate capability warnings, omit raw tag values, return
  them only from `ConversionResult`, and render them only through the human logger.
- **Risk-owned tests:** test each behavior at the module that owns it; do not replicate a
  target matrix across every caller.

## Cross-Cutting Concerns

- **Security:** the dependency bump closes known parser-chain exposure. Enforce the agreed
  limits of 16 inspected pictures, 16 MiB primary picture, 32 MiB total pictures, and 24 MiB
  sidecar. Reject NUL, escape backslash/CR/LF/`=`/`;`/`#`, and never log raw metadata or
  base64 artwork.
- **Integrity:** a target limitation may warn, but a supported mapping that disappears or
  changes during conversion must abort publication. Primary artwork failure is fatal; an
  explicitly unsupported extra-picture loss may warn.
- **Cancellation:** preserve the exact abort reason, check cancellation between phases,
  settle the FFmpeg child once, and prove cleanup for pre-spawn, in-flight, post-write, audit,
  and publication boundaries.
- **Compatibility:** M4A output must reject `use_metadata_tags`; Opus must not accidentally
  emit an attached-picture video stream. MP3 POPM email and counter provenance must survive.
- **Ordering:** source preservation is finalized before file reuse. An optional successful
  Plex rating sync is the sole intentional downstream rating override; failure leaves the
  source-preserved rating intact.
- **Performance:** one cover-aware source parse and one destination audit parse per conversion
  are sufficient. Bound artwork before serialization and avoid repeated caller-side reads.
- **Observability:** warnings must be deterministic and actionable without exposing values.
  Do not broaden machine-output schemas under this issue.
- **Delivery:** run `graphify update .` after code changes, preserve the repository PR
  template, audit review threads and live issue hierarchy, and do not declare closeout from
  ROADMAP text alone.

## Parallelization Opportunities

| Workstream             | File ownership                                                   | Can run in parallel                      | Dependency                                                              |
| ---------------------- | ---------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| Dependency floor       | package manifest and lockfile                                    | Rating and writer work                   | Must finish before parser-based validation                              |
| Rating foundation      | `ratings.ts`, its tests, and the narrow `metadata.ts` delegation | Dependency and POPM writer work          | Establish extractor contract before final metadata policy integration   |
| POPM provenance        | `tag-writer.ts` and its tests                                    | Dependency, rating, and pure policy work | Required before MP3 end-to-end integration                              |
| Metadata policy        | new module and its tests                                         | Foundations once interfaces are agreed   | Depends on stable rating input contract; no process lifecycle ownership |
| Conversion integration | `convert.ts` and its tests                                       | Documentation research only              | Depends on all foundations and owns shared lifecycle                    |
| Documentation          | package guide, README, Plex precedence page                      | May draft after behavior stabilizes      | Final wording requires real fixture evidence                            |
| Closeout               | ROADMAP, graph refresh, PR/CI/review audit                       | None                                     | Runs after implementation and full verification                         |

Assign each workstream exclusive ownership of its source and colocated test files. Keep
`convert.ts` plus `convert.test.ts` in one task because argv, cancellation, cleanup, audit, and
publication assertions share the same lifecycle mocks. Avoid parallel edits to the lockfile
or ROADMAP.

## Implementation Constraints

- Preserve the public CLI and `ConvertFormat` contract; add no flags, config keys, database
  columns, commands, completion entries, or caller-specific metadata switches.
- Add warnings only to `ConversionResult` and successful human output. Do not modify broader
  action, machine-output, or MCP schemas.
- Use a generated same-directory sidecar only for Opus. It must be exclusive `0600`, closed
  and synced before FFmpeg, bounded, and removed on success, failure, audit rejection, and
  abort.
- Use `-map_metadata 0:g` plus `-map_metadata:s:a 1:g` for the Opus metadata input, with no
  output video stream. Encode the primary artwork as a valid FLAC picture block.
- Use standard M4A atoms for AAC/ALAC. Rating and incompatible custom-field loss must be
  reported as capability warnings rather than represented with unsupported muxer flags.
- Never publish before semantic audit. Existing destination content must survive every failed
  conversion path.
- Do not require native tag byte parity; require semantic equivalence for fields the target
  supports and explicit warnings for inherent limitations.
- Keep ordinary unit tests hermetic by mocking process and filesystem lifecycles. Provision
  real FFmpeg separately for the four-target fixture probe.
- Completion audit outcome is unchanged: Bash, Zsh, and Fish templates require no edits or
  parity tests because the CLI surface does not change.

## Key Recommendations

1. Make the dependency floor and native-first rating extractor the first foundation tasks;
   they determine trustworthy source snapshots and close the parser-chain vulnerability.
2. Specify the new module's inputs and outputs before integrating it: normalized snapshot,
   exhaustive target policy, optional sidecar payload, audit expectations, and sanitized
   warnings. Keep spawn and filesystem effects out of this module.
3. Extend the MP3 writer independently, then integrate all target behavior through one
   `convert.ts` lifecycle. Include the existing combined-argv correction in that integration
   rather than treating it as an unrelated refactor.
4. Make the semantic audit the publication gate. Test fatal supported-field loss, warning-only
   target limitations, destination preservation, sidecar cleanup, and exact cancellation
   reasons before adding broader happy-path coverage.
5. Use one compact policy table and one compact FFmpeg-argv table across MP3, AAC, ALAC, and
   Opus. Add focused regressions for `RATING=0.80`, POPM counter/email, M4A muxer constraints,
   Opus artwork serialization, and Plex override ordering.
6. Run a provisioned real-FFmpeg fixture probe for all four targets and parse the results with
   the upgraded dependency. Treat this as release evidence, not a permanent assumption of the
   unit-test environment.
7. Update user documentation from verified behavior, then perform the unchanged completion
   audit: package tests/build/lint, dependency audit, `graphify update .`, full CI, review
   threads, live issue/ROADMAP reconciliation, authoritative merge and closure verification,
   and only then worktree cleanup.
