# Practices Research: Tag Preservation During Conversion

## Executive Summary

Implement issue #42 once at the existing `convertFile()` seam with one focused new module,
`conversion-metadata.ts`. Reuse the repository's normalized rating model, MP3 writer, result
envelopes, logger, and validated atomic stage; do not add a caller-specific preservation fix,
universal tag framework, FFmpeg wrapper, or general writer registry. This is the smallest design
that can preserve tags consistently across all seven callers while keeping process lifecycle and
metadata policy independently testable.

Opus artwork is required, not an unsupported-format warning. Build the narrow standard mapping the
target actually needs: a bounded FLAC picture block, base64-encoded into a private exclusive `0600`
FFmetadata sidecar, passed to FFmpeg by generated path and always cleaned up. That small serializer
is easier to audit and maintain than another cross-format dependency. Upgrade only the vulnerable
`music-metadata` chain, preserve all existing CLI options and action signatures, add warnings
additively to existing result envelopes, and concentrate tests at the shared seam rather than
duplicating the target matrix in every action.

## Existing Reusable Code

| Module or utility                                         | Location                                                                                                                        | Existing purpose                                                                                                                       | Reuse for issue #42                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `convertFile()` and `ConversionPreset`                    | `packages/rfmedia-cli/src/lib/convert.ts`                                                                                       | Shared FFmpeg façade, progress, typed failures, cancellation, destination naming                                                       | Keep as the only public conversion lifecycle. Replace combined option strings with token arrays and delegate metadata policy to the new module.                                                                                        |
| `replaceFileWithValidatedStage()`                         | `packages/rfmedia-cli/src/lib/filesystem.ts`                                                                                    | Creates a private `0600` sibling stage, validates inode/parent/destination identities, fsyncs, atomically renames, and cleans failures | Wrap encode, MP3 rating write, and output audit in its materialize/validate callbacks. Declare an explicit FFmpeg muxer because its generated stage ends in `.tmp`.                                                                    |
| Validated-stage tests                                     | `packages/rfmedia-cli/src/lib/filesystem.test.ts`                                                                               | Prove original preservation, cleanup, abort, symlink rejection, parent recheck, and commit failure                                     | Trust this coverage. Add filesystem tests only if the helper API itself changes; do not repeat its entire matrix in conversion tests.                                                                                                  |
| `NormalizedRating` and conversion helpers                 | `packages/rfmedia-cli/src/types/index.ts`, `packages/rfmedia-cli/src/lib/ratings.ts`                                            | Normalize POPM, Vorbis, and Plex values                                                                                                | Export one parsed-metadata extraction helper and reuse it from `readRating()`, `readRatingAndFormat()`, `metadata.ts`, and conversion. Native-first selection fixes the Vorbis `0.80` regression.                                      |
| `writeRating()` MP3 path                                  | `packages/rfmedia-cli/src/lib/tag-writer.ts`                                                                                    | Updates MP3 POPM with `node-id3` while retaining existing ID3 frames                                                                   | Reuse only for staged MP3 output. Add optional source counter alongside existing POPM email; a false result is fatal inside conversion.                                                                                                |
| `syncTrackRating()`                                       | `packages/rfmedia-cli/src/lib/sync-helper.ts`                                                                                   | Best-effort Plex-to-file rating override                                                                                               | Leave unchanged and after conversion. It is an intentional later authority, not a general preservation writer.                                                                                                                         |
| `logWarn()`/`logDebug()`                                  | `packages/rfmedia-cli/src/lib/logger.ts`                                                                                        | Human logging suppressed for JSON, YAML, and CSV modes                                                                                 | Render sorted, deduplicated, value-free warnings only at the action/command boundary after progress stops. Machine modes must receive the same warnings in their result envelope because the logger intentionally emits nothing there. |
| Existing action results and MCP envelope                  | `packages/rfmedia-cli/src/types/results.ts`, `packages/rfmedia-cli/src/types/plex.ts`, `packages/rfmedia-cli/src/mcp/server.ts` | Stable structured output returned by actions and exposed as MCP `structuredContent`                                                    | Add an ordered `warnings` collection to conversion-capable result envelopes and aggregate `ConversionResult.warnings` at each caller. Reuse the envelope; do not add a parallel event channel.                                         |
| `music-metadata` common/native/picture API                | Dependency used in `ratings.ts` and `metadata.ts`                                                                               | One-pass normalized and native metadata reads                                                                                          | After the security upgrade, perform one cover-aware source parse and one bounded destination audit parse. Use `selectCover()` or equivalent deterministic primary-cover selection.                                                     |
| `createHash("sha256")` pattern                            | `packages/rfmedia-cli/src/lib/filesystem.ts`                                                                                    | Streaming content digests                                                                                                              | Use the same Node primitive for picture-byte audit digests; no hashing dependency is needed.                                                                                                                                           |
| `clearMocksPreservingImplementations()` and hoisted mocks | `packages/rfmedia-cli/src/test-utils/mock-lifecycle.ts`, current tests                                                          | Keeps Vitest mock defaults stable across cases                                                                                         | Reuse for new child-process/filesystem tests; do not reset hoisted implementations.                                                                                                                                                    |
| Existing first-copy optimization                          | Album, filter, sync, and Plex action modules                                                                                    | Converts once, then copies or hardlinks the first result                                                                               | Finalize tags before `convertFile()` resolves so every later copy inherits identical metadata with no extra parse/write work.                                                                                                          |

### Patterns Not to Reuse

- `ExtendedMetadata` in `metadata.ts` is filter-oriented and intentionally omits track totals,
  dates, native/custom fields, POPM provenance, and artwork. Extending it into a lossless bag would
  couple filters to conversion and still miss required data.
- `cleanupPartialFile()` is best-effort direct-output cleanup. It is not a substitute for
  `replaceFileWithValidatedStage()` because it cannot preserve an existing destination after
  `-y`.
- The FLAC writer's UUID plus default `createWriteStream()` temporary path is weaker than the
  exclusive validated-stage pattern. FLAC is not a target, so issue #42 should not expand that code.
- `sanitizeForFilesystem()` changes characters to produce path components. Tag keys and values are
  not filenames; use target-specific validation/escaping without altering semantic metadata.

## Modularity Design

### Recommended Module Boundaries

#### `convert.ts`: Lifecycle and Process Owner

Keep responsibilities that already belong to the conversion façade:

1. validate early cancellation and ensure the destination parent;
2. ask `conversion-metadata.ts` for one source snapshot and target policy;
3. create any required Opus sidecar;
4. call `replaceFileWithValidatedStage()`;
5. construct fully tokenized FFmpeg argv from the policy;
6. own the child process, progress, bounded stderr, and settle-once behavior;
7. perform the staged MP3 POPM update;
8. invoke destination audit;
9. return typed warnings to the caller;
10. clean the sidecar in `finally`; and
11. resolve only after atomic publication.

This boundary is concrete: `convert.ts` already owns process state and cancellation, so moving spawn
or progress into a metadata module would split one lifecycle across files.

#### `conversion-metadata.ts`: Projection and Format Policy

Add one file at `packages/rfmedia-cli/src/lib/conversion-metadata.ts`. It should own:

- immutable conversion snapshot types;
- the cover-aware source/destination projection;
- typed MP3, AAC/M4A, ALAC/M4A, and Opus capability policies;
- supported-versus-limited field classification;
- bounded text and picture validation;
- primary-cover selection and digest;
- pure FLAC-picture-block creation;
- pure FFmetadata serialization and escaping;
- the small private sidecar create/dispose helper;
- semantic destination audit; and
- structured warning construction, sorting, and deduplication.

One file is preferable to separate `metadata-policy`, `metadata-audit`, `opus-artwork`, and
`warning-formatter` modules at this size. Those concerns share one snapshot and target vocabulary
and have no other callers. Split later only if the file develops independently reusable
subsystems.

The module must not spawn FFmpeg, record history, know command/action options, or log. Returning
typed warnings/errors keeps pure decisions testable. `convert.ts` returns those warnings; action
boundaries aggregate them, and command/MCP presentation decides whether to render human text or
structured output.

#### `ratings.ts`: Shared Rating Interpretation

Rating interpretation already appears in `ratings.ts` and is duplicated in `metadata.ts`; the new
conversion read would be the third copy. This satisfies the rule of three. Export a single helper
that accepts parsed metadata and a source path/format, selects native POPM or Vorbis first, and uses
the common projection only as a compatible fallback.

Keep scale conversion functions beside it. Do not move ratings into `conversion-metadata.ts`,
because filters, Plex sync, and conversion all use the same domain semantics.

#### `tag-writer.ts`: Narrow Destination Mutation

Keep this module narrow. It owns MP3 POPM and existing FLAC rating writes. Add only optional
`popmCounter` support needed to preserve source POPM provenance. Do not add Opus full-tag writing:
Opus rating and artwork are part of one FFmetadata input created before FFmpeg, while this writer is
a post-write mutation API.

`node-id3.update()` reads and rewrites the full MP3 synchronously using `writeFileSync()` but keeps
the same existing file inode. That is compatible with the validated-stage identity check; add one
focused integration assertion rather than weakening the stage helper. Retain current conversion
worker limits because concurrent full-file buffers can multiply memory.

### Shared vs. Feature-Specific Code

| Component                                         | Classification                 | Rationale                                                                                                             |
| ------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Native-first normalized rating extraction         | Shared                         | Already needed by rating reads and smart metadata; conversion is the third consumer.                                  |
| Atomic validated stage                            | Shared                         | Existing generic mutation primitive already proves the required filesystem contract.                                  |
| Logger                                            | Shared                         | Existing suppression in JSON, YAML, and CSV modes is repository-wide behavior; use it only for final human rendering. |
| Action/MCP result envelopes                       | Shared                         | They are the existing machine-output channel and must carry warnings that the logger suppresses.                      |
| Conversion metadata snapshot                      | Feature-specific               | Broader than filter metadata but meaningful only during format conversion.                                            |
| Target capability policy                          | Feature-specific               | Describes the four current conversion outputs, not a package-wide plugin API.                                         |
| Opus FLAC picture block and FFmetadata serializer | Feature-specific               | One bounded interoperability requirement; no second repository consumer exists.                                       |
| Conversion warning codes                          | Feature-specific internal type | Useful to `ConversionResult` and tests but not a global error taxonomy.                                               |
| Destination semantic audit                        | Feature-specific               | Its required fields and tolerances depend on the conversion target policy.                                            |
| Picture/text resource limits                      | Feature-specific constants     | Bound the new buffering/serialization work and should evolve with its fixtures.                                       |

## Opus Artwork Decision

Primary Opus artwork is required. The target format supports it through the
`METADATA_BLOCK_PICTURE` Vorbis comment, so the absence of support in the existing tag writer or
FFmpeg's attached-video stream mapping is an implementation gap, not a format limitation.

Use this bounded flow:

1. Select one primary/front picture from the source snapshot.
2. Enforce at most 16 MiB for that picture, 16 pictures inspected, and 32 MiB total source picture
   data.
3. Construct the standard FLAC picture block with fixed big-endian 32-bit lengths and picture type
   3; use validated MIME/description bytes and zero for unavailable dimensions.
4. Base64-encode only that bounded block.
5. Serialize generated `METADATA_BLOCK_PICTURE=<base64>` and normalized `RATING=<value>` entries
   through one tested FFmetadata escaper. Do not stringify arbitrary native objects.
6. Create the sidecar in the resolved destination directory using an unpredictable basename and
   `open(path, "wx", 0o600)`.
7. Cap the complete sidecar at 24 MiB, `sync()` and close it before spawn, and pass only its absolute
   path as a separate FFmpeg input argument.
8. Map source canonical/custom text and sidecar overrides deliberately to the Opus output stream;
   prove the exact precedence with a real probe.
9. Unlink the sidecar in one outer `finally` on success, spawn failure, nonzero exit, audit failure,
   and cancellation.
10. Reparse the staged Opus file and compare the embedded picture digest and normalized rating
    before publication.

An unsupported warning remains valid for additional pictures beyond the issue's one-primary-cover
contract. It is not valid for loss of the primary cover.

## KISS Assessment

| Area                      | More complex proposal                                                       | Recommended simpler design                                                                                                        | Trade-off                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-format architecture | General tag reader/writer registry with pluggable format classes            | One typed target-policy record and a few pure helpers in `conversion-metadata.ts`                                                 | Adding a fifth target requires one policy entry and perhaps one branch, but avoids framework indirection today.                             |
| Caller integration        | Add preservation to album, filter, sync, Plex, playlist, and repair actions | Change only the shared `convertFile()` behavior                                                                                   | Callers cannot customize preservation independently, which is desirable for correctness.                                                    |
| Metadata model            | Make `ExtendedMetadata` lossless or expose every native library type        | Define one bounded conversion snapshot with canonical fields, safe text, rating, and pictures                                     | Unknown structured fields become explicit warnings instead of pretending to be portable.                                                    |
| Opus artwork              | Add a universal tag-writing package                                         | Build one bounded FLAC-picture-block/FFmetadata serializer                                                                        | The repository owns a small binary format routine, but avoids a broad dependency and still needs exact tests.                               |
| Output validation         | Compare full native metadata object graphs                                  | Compare canonical semantics, supported custom text, normalized rating, and picture digest                                         | Does not promise byte-identical native frames, matching the cross-container product contract.                                               |
| Warnings                  | Infer loss from arbitrary FFmpeg stderr                                     | Compute known limitations from policy and confirm supported fields through audit                                                  | Requires explicit capability maintenance but is deterministic and safe.                                                                     |
| Temporary output          | Add conversion-specific temp/rename logic                                   | Reuse `replaceFileWithValidatedStage()` with explicit muxer                                                                       | The stage keeps a `.tmp` suffix, so target policies must always provide `-f`.                                                               |
| Rating implementation     | Add a conversion-only rating parser                                         | Extract the duplicated native-first helper in `ratings.ts`                                                                        | Slight shared refactor, but prevents the demonstrated 100x Vorbis error everywhere.                                                         |
| Dependency update         | Run a broad `npm update` or audit fix                                       | Raise only `music-metadata` to `^11.14.0` and review its lockfile subtree                                                         | Unrelated advisories remain visible but issue scope and regression risk stay bounded.                                                       |
| Real FFmpeg tests         | Make every Vitest target invoke system FFmpeg                               | Pure/mocked CI contracts plus one provisioned or manual fixture probe per target family                                           | CI does not prove every system build, so the supported environment must be recorded.                                                        |
| Warning API               | Add events, callbacks, or configuration                                     | Add ordered `warnings` to `ConversionResult` and existing action/MCP result envelopes; render human warnings after progress stops | This is an additive output-schema change, but it is the smallest way to avoid silently dropping warnings in JSON, YAML, CSV, and MCP modes. |

## Abstraction vs. Repetition

### Extract: Worth Abstracting

- **Rating extraction:** common-first/native parsing is duplicated in `ratings.ts` and
  `metadata.ts`, and conversion needs the same decision. Extract
  `extractNormalizedRating(parsed, filePath)` in `ratings.ts`.
- **Target policy:** four formats differ in muxer, codec tokens, stream mapping, artwork, rating,
  and custom-text capability. Put these differences in one exhaustive
  `Record<ConvertFormat, ConversionTargetPolicy>` checked with `satisfies`.
- **Conversion snapshot/audit:** source projection and destination projection must use identical
  normalization. One helper prevents asymmetric reads and makes semantic audit reliable.
- **Warning ordering:** limitations arise from custom keys, native categories, rating, and artwork.
  One pure sort/deduplicate function prevents nondeterministic output under parallel conversion.
  Actions aggregate and sort once by source, destination, code, and safe field name; reused
  first-copy results contribute each source-conversion/reason only once.
- **Opus FFmetadata escaping:** every generated value uses the same format control characters. One
  serializer is safer than inline replacements for rating and artwork.
- **Child-process settle-once helper:** `close`, `error`, and abort may race. A small internal runner
  in `convert.ts` is justified because it centralizes one process lifecycle and bounded stderr.

### Repeat: Acceptable Duplication

- **Per-target argv fragments:** short literal arrays for MP3, M4A, and Opus are clearer than a
  fluent argument builder. Store common tokens once, then concatenate explicit fragments.
- **AAC and ALAC target entries:** keep two complete policy entries even though both use M4A.
  Their codecs/bitrates differ, and exhaustive entries are easier to review than inheritance.
- **Canonical field comparisons:** a handful of named comparisons is clearer than a reflection-
  based deep-diff engine that could expose values or mishandle arrays.
- **Source and destination cancellation checks:** repeated `signal.throwIfAborted()` calls document
  lifecycle boundaries; hiding them in a generic wrapper would reduce clarity.
- **One local real-FFmpeg probe per target family:** fixture commands can repeat a little because
  their explicit outputs are review evidence, not a production abstraction.

### Do Not Extract Yet

- A generic `TemporaryResource` class for the one Opus sidecar.
- A repository-wide warning/event bus.
- A tag-provider plugin interface.
- A universal binary metadata AST.
- A generic audit framework shared with future drift detection issue #125. The semantics are not
  yet proven identical; extract only after a third real consumer appears.

## Interface Design

### Preserve Existing Surfaces

Keep the existing signature and target union:

```ts
export async function convertFile(
  source: string,
  dest: string,
  format: ConvertFormat,
  onProgress?: ConversionProgressCallback,
  signal?: AbortSignal,
): Promise<ConversionResult>;
```

Do not add a CLI flag, config property, environment variable, database migration, or new conversion
format. Bash, Zsh, and Fish completions remain unchanged. MCP `structuredContent` and machine CLI
results do gain the same additive `warnings` data returned by their underlying action.

An additive result field is source-compatible with current callers because repository code awaits
the function but does not destructure or construct `ConversionResult` elsewhere:

```ts
interface ConversionResult {
  outputPath: string;
  duration: number;
  success: boolean;
  error?: string;
  warnings: readonly ConversionWarning[];
}
```

Define one shared warning shape usable by conversion and the affected action result types:

```ts
interface ConversionWarning {
  code: string;
  reason: string;
  source: string;
  destination: string;
  target: ConvertFormat;
  fields: readonly string[];
  outputUsable: true;
}
```

It must contain stable reason codes and safe field names, never raw tag values or FFmpeg stderr.
Each conversion-capable action aggregates warnings into its existing result envelope. Human
rendering uses `logWarn()` only after progress has stopped; JSON, YAML, CSV, and MCP serializers
must include warnings structurally rather than relying on logger side effects. Warning-only
completion remains successful with exit status zero.

### Recommended Internal Contracts

Use small data-in/data-out functions:

```ts
readConversionMetadata(path, signal?): Promise<ConversionMetadataSnapshot>;
getConversionTargetPolicy(format): ConversionTargetPolicy;
getConversionLimitations(snapshot, policy): readonly ConversionWarning[];
serializeOpusMetadata(snapshot): Uint8Array;
createPrivateOpusSidecar(parent, bytes, signal?): Promise<DisposableSidecar>;
auditConvertedMetadata(source, destination, policy): void;
```

Keep side effects visible:

- `serializeOpusMetadata()` is pure and owns escaping/bounds.
- `createPrivateOpusSidecar()` owns only exclusive write, sync, close, and unlink.
- `convertFile()` owns resource lifetime and invokes `dispose()` in `finally`.
- `auditConvertedMetadata()` throws a typed field/category mismatch without including values.

Avoid dependency injection objects threaded through production APIs solely for tests. Vitest can
mock the module and Node boundaries already used by the repository.

### Extension Points

Future formats extend the target record and add a focused serializer only if their container
requires one. Future metadata drift reporting may reuse the immutable canonical projection after
its requirements are known. Neither possibility justifies a plugin framework now.

## Correctness, Performance, and Maintainability

### Correctness

- Snapshot once before mutation; preserve source immutability.
- Make native POPM/Vorbis authoritative before generic common rating values.
- Treat policy-supported loss as fatal and only genuine target incapability as warning.
- Explicitly map audio, metadata, and MP3/M4A artwork; do not trust FFmpeg automatic selection.
- Use the private sidecar for Opus rating and primary artwork.
- Post-write MP3 POPM before destination audit.
- Audit semantic values, rating tolerance, and exact picture digest.
- Return warnings only after successful audit; aggregate and render them after progress stops.
- Publish only through validated atomic rename.
- Leave Plex rating sync after conversion as the deliberate final override.

### Performance

Conversion adds one source metadata parse with covers and one destination audit parse. That is
appropriate for a correctness feature and occurs only for actual conversions, not ordinary copies.
The first-copy optimization prevents repeated work for ranges and hardlinks.

Performance constraints:

- keep picture count/byte, text count/value, and sidecar caps centralized;
- select and serialize one primary picture only;
- avoid arbitrary native-object cloning or deep equality;
- retain bounded stderr and existing action concurrency;
- do not create a separate metadata worker pool;
- compute picture digest while projecting rather than in another pass when practical; and
- recognize that `node-id3.update()` synchronously buffers and rewrites the staged MP3. Measure a
  representative long track under current worker concurrency, but do not replace it with bespoke
  ID3 code without evidence of a real regression.

### Maintainability

- Keep target capability claims next to argv policy so behavior and audit cannot drift.
- Use readonly interfaces and exhaustive union/record checks.
- Give warnings stable codes and deterministic order.
- Propagate warnings through machine-result and MCP envelopes; `logWarn()` is deliberately silent
  in JSON, YAML, and CSV modes.
- Deduplicate by source conversion and reason so first-copy reuse produces one diagnostic.
- Put resource limits in named constants with unit comments and boundary tests.
- Document why Opus uses FFmetadata and why M4A `use_metadata_tags` is rejected.
- Keep raw values out of error/warning types.
- Do not export internals through a package barrel unless another package needs them.

## Testability Patterns

### Minimal Critical Coverage

1. **`conversion-metadata.test.ts`: one table-driven policy/audit suite**
   - MP3 supports canonical/custom/rating/primary artwork.
   - AAC and ALAC support canonical/artwork and warn for rating/custom text.
   - Opus supports canonical/custom/rating/primary artwork.
   - One tiny known picture produces exact FLAC-picture-block bytes and base64.
   - FFmetadata escaping covers backslash, CR/LF, `=`, `;`, `#`, NUL rejection, and length caps.
   - Warning sort/deduplication is stable.
   - One representative supported-field mismatch is fatal.
   - Picture count, per-picture, total-picture, text, and sidecar bounds fail before write.
2. **`convert.test.ts`: one table-driven process policy plus lifecycle**
   - All four target argv arrays use separate option/value tokens, explicit audio/metadata mapping,
     fixed muxers, `-nostdin`, and the private stage as final output.
   - MP3/M4A map optional picture streams; Opus maps no video and uses the private sidecar input.
   - Keep the existing pre-abort and in-flight abort tests.
   - One failed post-write audit preserves the prior destination and removes stage/sidecar.
   - One success proves audit and atomic publication finish before resolution.
   - Sidecar is closed before spawn and disposed on success, FFmpeg error, audit failure, and abort.
3. **`ratings.test.ts`: compact extraction regressions**
   - Native Vorbis `RATING=0.80` wins over common `0.008`.
   - Normalized, star, percent, invalid, zero, and out-of-range values cover distinct branches.
   - Native POPM retains selected email/counter; common fallback runs only when native is absent.
4. **`tag-writer.test.ts`: one additive MP3 provenance assertion**
   - `NodeID3.update()` receives the source POPM email/counter and `preserveTags: true`.
   - Retain current writer failure tests; do not duplicate every existing value/path case.
5. **Action/output propagation: one representative integration path**
   - A conversion warning appears once in the action result after first-copy reuse.
   - Human mode renders it after progress teardown.
   - One machine-mode serializer and MCP `structuredContent` retain the typed warning.
   - Test shared result/rendering plumbing rather than repeating the case for all seven callers.
6. **Real format evidence: one small probe per target family**
   - Generate or check in minimal deterministic tagged input, invoke the actual installed FFmpeg,
     reparse output, and record MP3, AAC/M4A, ALAC/M4A, and Opus results.
   - Gate/provision this if added to CI; the normal Vitest suite must not accidentally depend on
     whatever FFmpeg happens to be on a runner.

### Coverage to Avoid

- Do not copy the metadata matrix into album, filter, sync, Plex copy, playlist, and both verify
  suites. They all call the same seam.
- Do not add shell-completion tests because no surface changes.
- Do not add database tests because no persistence schema changes.
- Do not assert byte-identical whole audio files or native frame IDs across containers.
- Do not snapshot raw FFmpeg stderr or full metadata objects.
- Do not add separate tests for AAC and ALAC warning semantics when a table row proves their shared
  M4A policy; retain distinct argv rows for their codec difference.
- Do not remove existing parameterized rating/writer tests merely to reduce a test count; distinct
  failure modes remain valuable.

### Anti-Patterns to Avoid

- Testing only argv and claiming metadata preservation without destination reparse evidence.
- Mocking the pure audit so thoroughly that supported-field failure cannot be exercised.
- Using broad `toMatchSnapshot()` on tag objects containing binary pictures.
- `vi.resetAllMocks()` with hoisted defaults.
- Race-prone tests that use fixed temporary filenames.
- Tests that assert warning arrival order from parallel callers instead of the pure sorted contract.

## Build vs. Depend

| Need                                 | Build custom                                        | Existing/new dependency option              | Recommendation                                                | Rationale                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read common/native tags and covers   | Reimplement parsers: prohibitive and unsafe         | Existing `music-metadata`                   | Depend, but upgrade narrowly to `^11.14.0`                    | Broad parser coverage already exists; current lock is vulnerable, so reuse requires the security update.                                                                        |
| Transcode and container-map metadata | Implement codecs/muxers: infeasible                 | Existing system FFmpeg                      | Depend on FFmpeg through direct `spawn()`                     | It is already the supported runtime boundary; explicit policies are simpler than another wrapper.                                                                               |
| MP3 POPM                             | Write ID3 framing/in-place updater                  | Existing `node-id3` 0.2.9                   | Reuse existing writer                                         | Current behavior preserves tested tags and already has failure contracts. Measure synchronous buffering rather than replacing mature code preemptively.                         |
| Opus primary artwork and rating      | Small FLAC picture block plus FFmetadata serializer | Add universal tag writer or external tool   | Build the narrow bounded serializer                           | The data format is deterministic, FFmpeg consumes the sidecar, and no current dependency spans Opus/M4A/MP3 correctly. A broad dependency still needs audit and mapping policy. |
| Atomic publication                   | New temp/rename code                                | Existing `replaceFileWithValidatedStage()`  | Reuse existing helper                                         | It already proves private creation, identity checks, fsync, atomic rename, cancellation, and cleanup.                                                                           |
| Destination metadata audit           | Invoke ffprobe or compare FFmpeg stderr             | Existing upgraded `music-metadata`          | Reuse the same parser/projection                              | Avoids a second process dependency and compares normalized cross-format semantics.                                                                                              |
| Picture hashing                      | Add hash package                                    | Node `crypto`                               | Build with `createHash("sha256")`                             | Existing repository pattern; no dependency or abstraction needed.                                                                                                               |
| Warning delivery                     | Add event emitter/output framework                  | Existing result envelopes plus human logger | Return and aggregate result data; render only at the boundary | Prevents silent loss in machine modes while preserving current progress-safe human output.                                                                                      |

### Dependency Upgrade Scope

The external-research statement that no upgrade is required is superseded by the live security
audit. Keep the fix narrow:

1. Change only `packages/rfmedia-cli/package.json` from `music-metadata ^11.0.0` to
   `^11.14.0`.
2. Regenerate `package-lock.json` through the repository package manager.
3. Confirm the lock resolves `music-metadata >=11.14.0` and `file-type >=21.3.4`.
4. Review the exact transitive lock diff; do not accept an unrelated mass update.
5. Rerun rating, common/native tag, picture, and all four target fixture probes because parser
   normalization can change between minor versions.
6. Run `npm ls music-metadata file-type` and the production audit. Report unrelated existing audit
   findings honestly; require the conversion chain to be clear.
7. Do not add a package solely for Opus artwork.

## API Compatibility

- `ConvertFormat`, file extensions, codecs/bitrates, CLI flags, config schemas, database schema,
  and action signatures remain unchanged.
- `convertFile()` keeps its positional parameters and error classes.
- `ConversionResult` and conversion-capable action result envelopes add `warnings`; this is
  source-compatible for current callers but is an intentional additive JSON/YAML/CSV/MCP schema
  change.
- Every conversion caller must aggregate warnings even if it previously ignored
  `ConversionResult`. Machine serializers must represent the array explicitly; they must not
  depend on `logWarn()`, which is suppressed in machine formats.
- `readRating()`, `readRatingAndFormat()`, and `readExtendedMetadata()` keep their public return
  shapes while sharing the corrected extractor internally.
- `WriteRatingOptions.popmCounter` is optional and therefore source-compatible.
- `syncTrackRating()` remains best-effort and later than conversion.
- Bash, Zsh, and Fish completion templates need no edits. Audit them only if implementation
  unexpectedly changes a visible format/flag.
- Export the warning type only as far as the affected result types require; do not create a public
  package-wide warning taxonomy.

## Alternatives Rejected

| Alternative                                                | Why rejected                                                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Trust FFmpeg's automatic metadata/stream behavior          | Empirical evidence shows lost POPM, dropped Opus artwork, and failing M4A artwork selection.                                           |
| Warn that Opus artwork is unsupported                      | Opus has a standard `METADATA_BLOCK_PICTURE` representation and issue #42 requires artwork; the writer gap is not a format limitation. |
| Put base64 artwork or arbitrary tags directly in argv      | Risks argument-size failure and mixes untrusted values with process options. The private bounded sidecar is safer.                     |
| Add a universal tag-writing dependency                     | No evaluated package removes the need for target policy/audit; it increases supply-chain and maintenance cost.                         |
| Extend `tag-writer.ts` into a full cross-format writer     | It is deliberately a rating mutation seam. Mixing whole-tag serialization would broaden its API and duplicate FFmpeg mapping.          |
| Reuse `ExtendedMetadata`                                   | It omits required conversion state and would couple filter performance choices to cover-aware conversion.                              |
| Patch every action caller                                  | Duplicates policy and risks missing sync, Plex, or verify repair paths.                                                                |
| Write directly to the final destination and clean on error | Cannot preserve an existing file after `-y` or hide metadata-invalid output; validated staging already exists.                         |
| Use MOV `use_metadata_tags` for arbitrary M4A keys         | The observed mode loses artwork and breaks normalized common-tag visibility.                                                           |
| Use ffprobe for production validation                      | Adds another child process and still lacks the application's normalized rating semantics.                                              |
| Compare every native frame byte-for-byte                   | Native ID3/Vorbis/MP4 representations are not portable; semantic audit matches the business contract.                                  |
| Introduce a plugin/strategy class hierarchy                | Four closed target policies fit an exhaustive record and simple pure functions.                                                        |
| Couple issue #42 to future drift detection #125            | The future consumer may share projection concepts, but preemptive abstraction would constrain both before its requirements exist.      |
| Broad `npm audit fix`                                      | Expands regression scope and obscures the parser security change; update only the affected conversion chain.                           |
| Require unprovisioned real FFmpeg in every unit test       | Makes CI environment-dependent. Keep deterministic unit contracts and deliberate fixture evidence.                                     |

## Prioritized Actionable Recommendations

### P0 — Must Land Before Feature Logic

1. Upgrade and lock `music-metadata ^11.14.0`; verify `file-type >=21.3.4` and rerun current parsing
   tests/probes.
2. Export one native-first `extractNormalizedRating()` and remove the duplicated extractor from
   `metadata.ts`.
3. Define the bounded snapshot, warning, and exhaustive target-policy types in one new
   `conversion-metadata.ts`.
4. Correct every FFmpeg option/value token and add explicit muxers; retain `spawn()` with no shell.

### P1 — Core Preservation Transaction

1. Route all targets through `replaceFileWithValidatedStage()`.
2. Explicitly map audio/global metadata and MP3/M4A primary artwork.
3. Implement the bounded private Opus FFmetadata sidecar for normalized `RATING` and
   `METADATA_BLOCK_PICTURE`; primary artwork loss is fatal.
4. Reuse the MP3 writer with preserved optional POPM email/counter.
5. Reparse and audit the stage, returning stable warnings only for policy-declared limitations.
6. Preserve exact abort reasons and use one settle-once child lifecycle plus one outer sidecar
   cleanup scope.
7. Aggregate typed warnings into existing action/MCP result envelopes and render human warnings
   only after progress teardown; warning-only outcomes exit zero.

### P2 — Minimal Evidence

1. Add the single table-driven policy/serializer/audit suite.
2. Expand `convert.test.ts` with one target argv table and a compact publish/failure/sidecar lifecycle
   set while retaining existing abort tests.
3. Add only the native-first rating regression and POPM counter assertion.
4. Add one representative warning propagation test spanning action result, human rendering,
   machine output, and MCP structured content; do not duplicate it across callers.
5. Run one real tagged fixture through MP3, AAC, ALAC, and Opus; reparse every output.
6. Run focused tests, full rfmedia tests, architecture/codegen contracts, typecheck/build, dependency
   audit, formatting, Markdown lint, and diff checks.

### P3 — Documentation and Closeout

1. Update the conversion guide and package README with the tested compatibility matrix, embedded
   versus sidecar artwork, warnings, and atomic audit behavior.
2. Clarify in the Plex metadata guide that optional Plex rating sync runs after source preservation.
3. Leave root README, configs, database, and shell completions untouched; document the additive
   warning field in machine and MCP result schemas.
4. Refresh graphify after code changes.
5. Re-audit live issue hierarchy, review threads, CI, issue closure, ROADMAP counts/order, and merged
   branch/worktree state rather than relying on planning snapshots.

## Open Questions and Validation Gates

No product decision blocks the recommended implementation. These are implementation validation
gates:

1. Prove the exact FFmpeg Opus metadata precedence so source canonical/custom text and sidecar
   `RATING`/`METADATA_BLOCK_PICTURE` all survive together.
2. Confirm the explicit `mp3`, `ipod`, and `opus` muxer names across the supported FFmpeg floor.
3. Confirm `node-id3.update()` retains the stage inode in an integration test. Source inspection
   shows synchronous `writeFileSync()` to the same existing path, so replacement is not expected.
4. Confirm upgraded `music-metadata` normalization and picture digests against representative ID3,
   Vorbis/FLAC, and MP4 fixtures.
5. Decide and document the final committed file mode after the private `0600` stage; do not weaken
   staging privacy merely to preserve old default permissions.
