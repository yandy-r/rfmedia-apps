# Tag Preservation During Conversion Implementation Plan

Implement issue #42 once at the shared conversion boundary: read a bounded source metadata
snapshot, apply an exhaustive target policy, encode into one private validated stage, finalize
ratings and artwork, semantically audit the result, and publish atomically. Establish the patched
parser dependency barrier first, then build native-first ratings, MP3 POPM provenance, and a
late-bound filesystem publish mode in parallel before converging in a focused
conversion-metadata module and one `convertFileWithValidation()` transaction. Converted verify
repairs supply their existing tier validator to that transaction, while a parallel real-FFmpeg
probe supplies documentation evidence and all public CLI, configuration, database, action-result,
machine-output, MCP, and shell-completion contracts remain unchanged.

## Critically Relevant Files and Documentation

- `docs/plans/42-tag-preservation/shared.md`: Consolidated issue scope, architectural decisions,
  target behavior, warnings, and delivery constraints.
- `docs/plans/42-tag-preservation/feature-spec.md`: Authoritative functional, security, bounds,
  transaction, target-matrix, and acceptance requirements.
- `docs/plans/42-tag-preservation/research-recommendations.md`: Conflict-resolution authority for
  target policy, ratings, warning scope, testing, and deferred work.
- `docs/plans/42-tag-preservation/analysis-context.md`: Cross-cutting architecture, file scope, and
  integration ordering.
- `docs/plans/42-tag-preservation/analysis-code.md`: Existing implementation patterns, transaction
  composition hazard, and code-level gotchas.
- `docs/plans/42-tag-preservation/analysis-tasks.md`: Source dependency graph, exclusive file
  ownership, and validation gates; this final plan separates its real-FFmpeg gate into a
  validation-only task.
- `packages/rfmedia-cli/src/lib/convert.ts`: Shared conversion façade, FFmpeg lifecycle, public
  result, and new single-transaction integration point.
- `packages/rfmedia-cli/src/lib/convert.test.ts`: Existing cancellation tests and home for compact
  target-argv, lifecycle, warning, mode, and atomicity coverage.
- `packages/rfmedia-cli/src/lib/filesystem.ts`: Hardened private-stage, fsync, identity, validation,
  rename, and cleanup primitive.
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`: Existing atomic replacement and rollback
  contract tests.
- `packages/rfmedia-cli/src/lib/ratings.ts`: Current rating parsing, POPM selection, Vorbis scaling,
  and normalized rating provenance.
- `packages/rfmedia-cli/src/lib/metadata.ts`: Duplicate common-first rating extraction to replace
  with the shared parsed-metadata helper.
- `packages/rfmedia-cli/src/lib/tag-writer.ts`: Existing `node-id3` POPM writer to extend with source
  counter provenance.
- `packages/rfmedia-cli/src/types/options.ts`: Stable `ConvertFormat` union; no public option change
  is allowed.
- `packages/rfmedia-cli/src/actions/verify-album.ts`: Existing converted repair nested inside an
  outer validated stage; must supply tier validation to the shared conversion transaction.
- `packages/rfmedia-cli/src/actions/verify-filter.ts`: Filter repair equivalent of the same
  transaction-composition boundary.
- `packages/rfmedia-cli/src/actions/copy-filter.ts`: Read-only reference for first-conversion then
  copy/hardlink reuse.
- `packages/rfmedia-cli/src/actions/plex-playlist.ts`: Read-only reference proving source
  preservation precedes the optional Plex rating override.
- `packages/rfmedia-cli/src/lib/logger.ts`: Existing human `logWarn()` surface that suppresses
  diagnostics in JSON, YAML, and CSV modes.
- `packages/rfmedia-cli/docs/features/audio-conversion.doc.md`: Primary detailed user documentation
  for the verified target matrix and failure boundary.
- `.github/pull_request_template.md`: Required delivery template and testing evidence structure.

## Implementation Plan

### Phase 1: Security and Transaction Foundations

#### Task 1.1: Patch the Metadata Parser Dependency Chain Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/package.json`
- `package-lock.json`
- `docs/plans/42-tag-preservation/feature-spec.md`
- `docs/plans/42-tag-preservation/research-recommendations.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/package.json`
- `package-lock.json`

- Raise the direct `music-metadata` declaration to `^11.14.0` and regenerate only the affected
  package-lock subtree.
- Require the resolved production conversion path to contain `music-metadata >=11.14.0` and
  `file-type >=21.3.4`; do not add an unnecessary direct `file-type` dependency if the patched
  parser resolves it transitively.
- Review the lock diff for unrelated upgrades, duplicate parser versions, lifecycle scripts, or
  unexpected package-source changes. Do not run `npm audit fix`.
- Complete the install and focused lock review before Tasks 1.2-1.4 start; this task is the formal
  shared package-state barrier for their source work and tests.
- Validation gate:
  - `npm ls music-metadata file-type --all` reports the required versions on the `rfmedia`
    production path.
  - `npm audit --omit=dev --json` no longer reports GHSA-v6c2-xwv6-8xf7,
    GHSA-5v7r-6r5c-r473, or GHSA-j47w-4g3g-c36v on that path.
  - The manifest/lock diff is focused and any unrelated existing audit finding is recorded
    separately rather than concealed or broadly fixed.

#### Task 1.2: Centralize Native-First Rating Extraction Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/ratings.ts`
- `packages/rfmedia-cli/src/lib/ratings.test.ts`
- `packages/rfmedia-cli/src/lib/metadata.ts`
- `packages/rfmedia-cli/src/types/index.ts`
- `docs/plans/42-tag-preservation/analysis-code.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/ratings.ts`
- `packages/rfmedia-cli/src/lib/ratings.test.ts`

- Export a strictly typed `extractNormalizedRating(metadata, filePath)` helper accepting the
  parsed `common` and `native` portions needed from `music-metadata`.
- For MP3, inspect both ID3v2.3 and ID3v2.4 POPM collections, apply the existing deterministic
  preferred-email ordering across all candidates, and retain selected email and counter.
- For FLAC, Ogg, and Opus, inspect native Vorbis `RATING` case-insensitively before consulting the
  common projection. Preserve distinct normalized, star, percentage, invalid, zero, and unrated
  branches.
- Use `metadata.common.rating` only as the compatible fallback after the source-native lookup.
  Preserve the current M4A/AAC no-file-rating behavior.
- Route `readRating()` and `readRatingAndFormat()` through the helper without changing their
  cover-skipping parse behavior, error handling, result types, or public signatures.
- Add focused regressions for native `RATING=0.80` winning over common `0.008`, both ID3 family
  collections, deterministic POPM identity/counter, common fallback, scale boundaries, invalid
  values, and unrated values. Retain distinct existing parameterized coverage.
- Validation gate:
  - `npm run test:run -w packages/rfmedia-cli -- src/lib/ratings.test.ts` passes.
  - Tests prove one normalization contract and preserve the selected POPM provenance without
    loading cover art.

#### Task 1.3: Preserve MP3 POPM Counter and Email on Write Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/tag-writer.ts`
- `packages/rfmedia-cli/src/lib/tag-writer.test.ts`
- `packages/rfmedia-cli/src/lib/ratings.ts`
- `packages/rfmedia-cli/src/lib/filesystem.ts`
- `docs/plans/42-tag-preservation/analysis-code.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/tag-writer.ts`
- `packages/rfmedia-cli/src/lib/tag-writer.test.ts`

- Add optional `popmCounter` to `WriteRatingOptions` without changing existing defaults,
  `WriteRatingResult`, FLAC behavior, or unsupported-format behavior.
- In the MP3 branch, write the provided POPM counter together with the selected source email and
  normalized rating; retain counter `0` when no source counter is supplied.
- Continue using `NodeID3.update()` when `preserveTags` is true. A false result or thrown error
  remains a failed supported write that conversion must treat as fatal.
- Add one provenance test showing email and counter reach `NodeID3.update()` with
  `preserveTags: true`, plus a representative same-path assertion that the update retains the
  staged inode. Do not replace `node-id3` with bespoke ID3 framing or broaden the writer to M4A or
  Opus.
- Validation gate:
  - `npm run test:run -w packages/rfmedia-cli -- src/lib/tag-writer.test.ts` passes.
  - Existing FLAC, clamp, unsupported-format, and path tests remain intact, and the focused inode
    assertion passes.

#### Task 1.4: Add Late-Bound Publish Mode to Validated Staging Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/filesystem.ts`
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`
- `docs/plans/42-tag-preservation/analysis-code.md`
- `docs/plans/42-tag-preservation/analysis-tasks.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/filesystem.ts`
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`

- Add optional `publishMode` to `ValidatedStageOptions`; omission must preserve every existing
  caller's behavior.
- Keep the exclusive staged inode at `0600` through materialization, the first fsync, and
  `options.validate()`. Do not apply the publish mode before any metadata or caller-supplied
  validator.
- At the last safe pre-rename point, apply a supplied mode to the already-validated staged inode
  through a checked file handle, fsync the mode change, close the handle, and recheck the stage
  identity and abort signal before rename.
- Retain all parent, destination, regular-file, symlink, inode, rollback, and exact cleanup checks.
  Never infer trust from a temporary filename or weaken the existing identity contract.
- Add a critical test proving the validator observes `0600`, the requested final mode appears only
  on the committed destination, the inode is retained, and abort/failure in the late-mode path
  leaves the prior destination intact with no leaked stage.
- Keep an explicit omitted-option assertion demonstrating backward-compatible mode behavior.
- Validation gate:
  - `npm run test:run -w packages/rfmedia-cli -- src/lib/filesystem.test.ts` passes.
  - The new mode test proves privacy-before-validation, fsync-before-rename, identity retention,
    abort handling, and default compatibility.

### Phase 2: Metadata Interpretation and Target Policy

#### Task 2.1: Delegate Extended Metadata to the Shared Rating Helper Depends on [1.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/metadata.ts`
- `packages/rfmedia-cli/src/lib/metadata.test.ts`
- `packages/rfmedia-cli/src/lib/ratings.ts`
- `packages/rfmedia-cli/src/lib/ratings.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/metadata.ts`

- Remove the private duplicate POPM selection, Vorbis scale, source detection, and common-first
  extraction logic.
- Pass the already-parsed metadata object to `extractNormalizedRating(metadata, filePath)`.
- Preserve the single `{ skipCovers: true }` parse, `ExtendedMetadata` result shape, smart-filter
  semantics, logger behavior, and existing failure contract.
- Do not modify `metadata.test.ts` unless a genuine existing assertion is wrong; its unchanged
  suite is the consumer-compatibility proof.
- Validation gate:

  ```bash
  npm run test:run -w packages/rfmedia-cli -- \
    src/lib/ratings.test.ts \
    src/lib/metadata.test.ts
  ```

  - The metadata path performs one parse, loads no artwork, and uses the same native-first rating
    result as the direct rating readers.

#### Task 2.2: Implement Conversion Metadata Policy, Opus Sidecar, and Audit Depends on [1.1, 1.2]

**READ THESE BEFORE TASK**

- `docs/plans/42-tag-preservation/feature-spec.md`
- `docs/plans/42-tag-preservation/research-recommendations.md`
- `packages/rfmedia-cli/src/lib/ratings.ts`
- `packages/rfmedia-cli/src/lib/convert.ts`
- `packages/rfmedia-cli/src/types/options.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/conversion-metadata.ts`
- `packages/rfmedia-cli/src/lib/conversion-metadata.test.ts`

Files to Modify

- None.

- Define readonly conversion-specific snapshot, canonical metadata, text tag, picture, target
  policy, warning, and audit types. Do not reuse or expand filter-oriented `ExtendedMetadata`.
- Accept only a local regular-file source. Reject URL/protocol inputs and non-regular sources,
  never fetch tag URLs, and never derive a path from a tag key, value, MIME type, or description.
- Read one cover-aware source snapshot containing tag families, canonical title/artists/album,
  independent track number/total, year/date, genres, compatible text tags, the Task 1.2
  native-first rating, and deterministic primary/front artwork.
- Treat an unreadable or untrustworthy parse as fatal. Treat a successfully parsed tagless source
  as valid and produce no fabricated metadata or limitation warning.
- Enforce the fixed limits before expensive digest or serialization work: at most 16 inspected
  pictures, 16 MiB selected primary picture, 32 MiB aggregate pictures, 24 MiB complete Opus
  sidecar, 4,096 text tags, 255 UTF-8 bytes per key, 1 MiB per value, and 8 MiB aggregate text.
  Reject NUL and object/binary coercion.
- Implement one exhaustive `Record<ConvertFormat, ConversionTargetPolicy>`:
  - MP3 uses muxer `mp3`, mapped canonical/custom text, optional attached-picture copy, and POPM
    post-write.
  - AAC and ALAC use muxer `ipod`, standard M4A atoms, optional `covr` artwork copy, and
    deterministic rating/custom/native limitation warnings. Never use `use_metadata_tags`.
  - Opus uses muxer `opus`, Vorbis text, normalized `RATING`, and
    `METADATA_BLOCK_PICTURE` without mapping a video stream.
- Build the Opus primary image as an exact unsigned 32-bit big-endian FLAC picture block with type
  `3`, safe MIME/description, known dimensions when available, zeros otherwise, and original
  bytes. Base64 it into a `;FFMETADATA1` document.
- Implement one ffmetadata escaper for backslash, CR/LF, `=`, `;`, and `#`. Create the sidecar
  beside the destination with an unpredictable `open(path, "wx", 0o600)`, then write, sync, and
  close it before returning its exact path. Disposal must target only that path, be idempotent, and
  report non-`ENOENT` cleanup failure so the transaction can reject before publication.
- Generate sorted, deduplicated, value-free warnings only for known target incapabilities using
  the four fixed warning codes. Multiple source pictures produce exactly one
  `additional_artwork_unsupported` warning when only the primary picture is representable.
  Primary artwork failure and any supported write/audit loss are fatal.
- Reparse the staged destination once with covers and semantically audit NFC-normalized scalars,
  artist/genre and custom-text multisets, independent track fields, supported year/date, MP3
  rating within `1 / 255`, Opus rating within emitted precision, and primary-art SHA-256. Ignore
  encoder/vendor fields and native frame identifiers.
- Keep FFmpeg spawn, progress, child settlement, final media mutation, and publication out of this
  module.
- Validation gate:

  ```bash
  npm run test:run -w packages/rfmedia-cli -- \
    src/lib/conversion-metadata.test.ts \
    src/lib/ratings.test.ts
  ```

  - One table-driven suite proves all four policies, exact tiny picture-block/base64 bytes,
    escaping, NUL and every bound, warning order/deduplication, semantic tolerances, artwork
    digest, and a fatal supported-field mismatch.
  - Tests prove a tagless source invents and warns about nothing, parse failure is fatal, URL and
    non-regular sources are rejected without fetching, tag content cannot affect paths, and
    multiple pictures produce one deduplicated additional-artwork warning.
  - Tests confirm sidecars are private, synced/closed before use, and removed exactly on success,
    failure, and abort without exposing metadata values; a non-`ENOENT` disposal failure remains
    fatal.

### Phase 3: Single Atomic Conversion Transaction

#### Task 3.1: Integrate Metadata With One Validated Conversion Transaction Depends on [1.2, 1.3, 1.4, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/convert.ts`
- `packages/rfmedia-cli/src/lib/convert.test.ts`
- `packages/rfmedia-cli/src/lib/filesystem.ts`
- `packages/rfmedia-cli/src/lib/conversion-metadata.ts`
- `packages/rfmedia-cli/src/lib/tag-writer.ts`
- `docs/plans/42-tag-preservation/analysis-code.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/convert.ts`
- `packages/rfmedia-cli/src/lib/convert.test.ts`

- Keep the public five-argument `convertFile(source, dest, format, onProgress?, signal?)`
  signature. Add required readonly warnings to `ConversionResult` without changing action or
  machine-output envelopes.
- Add an internal exported `convertFileWithValidation()` using a narrow options object containing
  `onProgress`, `signal`, and an optional additional staged validator. It owns directory setup,
  one `replaceFileWithValidatedStage()` call, source snapshot, FFmpeg, post-write, metadata audit,
  optional additional validation, publication, cleanup, timing, result construction, and
  post-publication human warnings. Public `convertFile()` delegates with no additional validator.
- Determine the helper's `publishMode` before staging: preserve an existing regular destination's
  permission bits; when the destination is absent, use `0o666 & ~process.umask()` to match normal
  FFmpeg creation. Let the filesystem helper remain authoritative for symlink, identity, parent,
  and destination-race rejection.
- Replace combined arguments such as `"-b:a 320k"` with discrete tokens. Spawn with
  `spawn("ffmpeg", argv, { shell: false, signal })`, `-nostdin`, fixed tokens, bounded stderr, an
  explicit muxer, and fixed `-y` immediately before the private stage final argument.
- Use explicit target argv:
  - MP3 maps `0:a:0`, global metadata, optional `0:v:0?`, copies the attached picture, uses
    `libmp3lame`, separate `-b:a`, `320k`, and `-f mp3`.
  - AAC uses the same audio/global/optional-art maps, `aac`, separate `-b:a`, `256k`, picture copy,
    and `-f ipod`.
  - ALAC uses the same maps, `alac`, picture copy, no bitrate, and `-f ipod`.
  - Opus supplies the private ffmetadata as a second input, maps `0:a:0`,
    `-map_metadata 0:g`, `-map_metadata:s:a 1:g`, uses `libopus`, separate `-b:a`, `128k`, and
    `-f opus`, and maps no video.
- Within the stage transaction, run in this order: source snapshot and limitations, optional Opus
  sidecar creation, FFmpeg encode, MP3 POPM write with Task 1.3 provenance, staged metadata parse
  and semantic audit, optional additional validator, required Opus sidecar disposal, final
  cancellation check, late publish mode, and rename.
- On the successful validation path, complete idempotent disposal of the exact Opus sidecar before
  returning from the helper's validation callback. A non-`ENOENT` cleanup failure rejects
  validation, so `replaceFileWithValidatedStage()` never applies `publishMode`, fsyncs the public
  mode, rechecks, or renames.
- Retain an outer `finally` only as retry/safety cleanup for spawn error, nonzero close, abort,
  post-write failure, audit rejection, additional-validator rejection, or an earlier disposal
  attempt. It must never make a failed required cleanup publishable.
- Use one settle-once guard for child `error`, `close`, and abort. Preserve the exact
  `signal.reason`; check cancellation before and after every new asynchronous phase.
- Clamp FFmpeg-derived progress below `100` throughout encode, metadata audit, optional validation,
  required sidecar cleanup, mode application, and publication. Emit the single final `100` progress
  update only after the atomic rename succeeds, then emit sorted sanitized `logWarn()` lines and
  resolve.
- Return warning-only conversions with `success: true`; never log raw values, POPM data, artwork,
  base64, raw argv, or raw FFmpeg stderr. A failed or cancelled conversion emits neither final
  `100` progress nor a usable-output warning.
- Keep existing actionable process errors, first-conversion/reuse behavior, and later Plex override
  ordering.
- Add compact tests using hoisted process/parser/writer/filesystem mocks:
  - one four-target argv table asserting discrete tokens, explicit maps/muxers, and fixed `-y`
    immediately before the private stage for every target;
  - existing pre-abort and in-flight abort cases;
  - settle-once and exact abort reason;
  - stage/audit/additional-validator/publication order;
  - required sidecar disposal before mode/publication, cleanup failure preventing rename, outer
    safety cleanup, and prior-destination preservation;
  - MP3 POPM before audit;
  - warning-only success and human-versus-machine logging;
  - progress clamped below `100` through every pre-publication phase, with one final `100` only
    after successful rename;
  - existing-destination mode preservation and missing-destination umask mode while all validators
    observe `0600`.
- Do not recreate the filesystem identity matrix or add target matrices to action tests.
- Validation gate:

  ```bash
  npm run test:run -w packages/rfmedia-cli -- \
    src/lib/filesystem.test.ts \
    src/lib/ratings.test.ts \
    src/lib/tag-writer.test.ts \
    src/lib/conversion-metadata.test.ts \
    src/lib/convert.test.ts
  ```

  - Tests prove one stage/rename, metadata audit before the optional validator, warnings only after
    commit, private `0600` validation, correct final mode, and unchanged public CLI/options.
  - Package typecheck and full-suite validation are intentionally deferred until Task 2.1 is
    complete.

### Phase 4: Verified Repair Transaction Composition

#### Task 4.1: Route Converted Album Repair Through the Shared Validator Seam Depends on [3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/verify-album.ts`
- `packages/rfmedia-cli/src/actions/verify-album.test.ts`
- `packages/rfmedia-cli/src/lib/convert.ts`
- `packages/rfmedia-cli/src/lib/filesystem.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/verify-album.ts`
- `packages/rfmedia-cli/src/actions/verify-album.test.ts`

- Split the existing repair transaction by behavior without changing its public action result:
  converted repair calls `convertFileWithValidation()` for the real destination and supplies the
  existing tier verifier as the additional staged validator; non-converted copy/link repair keeps
  the current outer `replaceFileWithValidatedStage()` flow.
- Preserve quick/full tier decisions, fingerprint selection and refusal behavior, source and
  destination inputs, cancellation, `verifySize`, and error text.
- Do not call public atomic `convertFile()` inside an outer validated stage, export a raw
  materializer, recognize stage filenames, or weaken inode checks.
- Let `convert.ts` retain metadata audit ordering, publication, publish-mode selection, cleanup,
  and post-publication warning emission. Do not add warnings to the album action result.
- Update only the existing converted staging assertion needed to prove one shared stage, metadata
  audit before tier validation, no publication when tier validation fails, and one final rename.
  Do not add a target-policy matrix.
- Validation gate:

  ```bash
  npm run test:run -w packages/rfmedia-cli -- \
    src/actions/verify-album.test.ts \
    src/lib/convert.test.ts
  ```

  - The non-converted branch still uses its original outer helper, and converted repair never
    nests validated-stage transactions.

#### Task 4.2: Route Converted Filter Repair Through the Shared Validator Seam Depends on [3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/verify-filter.ts`
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts`
- `packages/rfmedia-cli/src/lib/convert.ts`
- `packages/rfmedia-cli/src/lib/filesystem.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/verify-filter.ts`
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts`

- Apply the same converted/non-converted transaction split as Task 4.1. Converted repair supplies
  its existing tier verifier to `convertFileWithValidation()` for the real destination;
  non-converted repair retains the current outer validated-stage helper.
- Preserve filter-specific fingerprint resolution, ambiguous/missing reasons, tier behavior,
  conflict accounting, cancellation, `verifySize`, and error messages.
- Keep metadata audit before the tier validator and one publication after both succeed. Let
  `convert.ts` own mode, cleanup, result warnings, and human warning timing.
- Update only the existing converted staging assertion needed to prove one stage/rename and
  rollback on tier failure. Do not duplicate format, metadata, warning, or completion tests.
- Validation gate:

  ```bash
  npm run test:run -w packages/rfmedia-cli -- \
    src/actions/verify-filter.test.ts \
    src/lib/convert.test.ts
  ```

  - Converted repair uses the shared transaction without nested staging; the non-converted path
    and current action/machine result remain unchanged.

#### Task 4.3: Probe Real FFmpeg Metadata Compatibility Depends on [3.1]

**READ THESE BEFORE TASK**

- `docs/plans/42-tag-preservation/feature-spec.md`
- `packages/rfmedia-cli/src/lib/conversion-metadata.ts`
- `packages/rfmedia-cli/src/lib/convert.ts`
- `packages/rfmedia-cli/package.json`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

- Run a deliberate provisioned real-FFmpeg gate and record `ffmpeg -version`. Use temporary
  representative ID3/POPM, Vorbis/FLAC, and MP4 sources with canonical text, compatible custom
  text, ratings, multiple pictures, and a deterministic primary picture.
- Convert fixtures to MP3, AAC/M4A, ALAC/M4A, and Opus, then reparse every result with the patched
  `music-metadata`.
- Verify the target matrix empirically: canonical text, MP3/Opus compatible custom text, MP3 POPM
  provenance, Opus normalized `RATING`, identical primary-art SHA-256 for all four targets, M4A
  standard-field visibility without `use_metadata_tags`, and no Opus video stream.
- Verify source comments coexist with Opus sidecar overrides, required sidecar cleanup completes
  before publication, the MP3 writer retains the staged inode, existing-destination mode is
  preserved, and missing-destination mode equals `0o666 & ~process.umask()`.
- Verify a tagless source invents and warns about nothing, supported loss is fatal, and every
  declared container limitation produces the expected sorted warning.
- Keep this task validation-only: use temporary or provisioned fixtures, add no fixture/script
  file, and do not make ordinary Vitest depend on FFmpeg.
- Validation gate:
  - All four real outputs reparse and satisfy every policy-supported semantic audit.
  - The exact FFmpeg version, fixture matrix, commands, warnings, modes, and pass/fail results are
    captured for Task 5.1 documentation and Task 5.2 PR evidence.

### Phase 5: Empirical Evidence, Documentation, and Delivery

#### Task 5.1: Document Verified Preservation Guarantees Depends on [4.1, 4.2, 4.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/audio-conversion.doc.md`
- `packages/rfmedia-cli/docs/features/plex-metadata-sync.md`
- `packages/rfmedia-cli/README.md`
- `docs/plans/42-tag-preservation/feature-spec.md`
- `docs/plans/42-tag-preservation/analysis-tasks.md`
- `packages/rfmedia-cli/src/lib/conversion-metadata.ts`
- `packages/rfmedia-cli/src/lib/convert.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/docs/features/audio-conversion.doc.md`
- `packages/rfmedia-cli/docs/features/plex-metadata-sync.md`
- `packages/rfmedia-cli/README.md`

- Use Task 4.3's recorded real-FFmpeg evidence as the sole empirical source; do not rerun or
  reinterpret the matrix while drafting.
- Update the audio conversion guide with automatic preservation, the verified target matrix, one
  primary-cover guarantee, bounds, target-limitation warnings, fatal supported-loss behavior,
  atomicity, dependency/FFmpeg expectations, and safe warning behavior.
- Update the Plex metadata guide to state that source preservation publishes first and an
  explicitly requested positive Plex rating is the only later authority; a failed override leaves
  the source-preserved rating.
- Update the package README with a concise preservation guarantee and link to detailed behavior.
  Add no flags, config keys, machine-output promises, or broad implementation detail.
- Validation gate:
  - Documentation matches Task 4.3's four-target evidence without speculative capability claims.

  ```bash
  npx prettier --check \
    packages/rfmedia-cli/docs/features/audio-conversion.doc.md \
    packages/rfmedia-cli/docs/features/plex-metadata-sync.md \
    packages/rfmedia-cli/README.md
  npx markdownlint-cli2 \
    packages/rfmedia-cli/docs/features/audio-conversion.doc.md \
    packages/rfmedia-cli/docs/features/plex-metadata-sync.md \
    packages/rfmedia-cli/README.md
  ```

#### Task 5.2: Reconcile ROADMAP and Complete the Delivery Lifecycle Depends on [2.1, 5.1]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `.github/pull_request_template.md`
- `docs/plans/42-tag-preservation/feature-spec.md`
- `docs/plans/42-tag-preservation/analysis-tasks.md`
- `packages/rfmedia-cli/package.json`

**Instructions**

Files to Create

- None.

Files to Modify

- `ROADMAP.md`

- After implementation and documentation stabilize, run the full local gate from a fresh
  dependency/build state where practical:
  - `npm run build:common`
  - the focused filesystem, ratings, metadata, tag-writer, conversion-metadata, conversion,
    verify-album, and verify-filter suites;
  - `npm run test:rfmedia`
  - `npm run test:run`
  - `npm run typecheck`
  - `npm run build:all`
  - `npm run test:contracts`
  - `npm run format:check`
  - `npm run lint:md`
  - `npm ls music-metadata file-type --all`
  - `npm audit --omit=dev`
  - `git diff --check`
- Run `graphify update .` after the final code and documentation state, then inspect generated
  graph changes for unrelated churn.
- Audit the complete branch diff against scope. Confirm no changes to command/options/config,
  database, action/MCP result envelopes, root README, or the Bash, Zsh, and Fish completion
  templates. Record the completion audit as no change and add no completion parity tests because
  the CLI surface is unchanged.
- Re-audit the live GitHub issue hierarchy, parent/child status, open counts, and issue #42 before
  editing `ROADMAP.md`; do not derive live state from the existing ROADMAP.
- Update only the issue #42 and live-count/status portions of `ROADMAP.md` justified by that audit.
  Do not restore deleted TODO content or perform unrelated roadmap cleanup.
- Create the PR from the active branch using `.github/pull_request_template.md` exactly. Include
  the required Summary, Changes, Testing, Related Issues with `Closes #42`, Breaking Changes, Risk
  and Rollback, and Checklist sections; record exact commands, real FFmpeg version/matrix, and
  pass/fail outcomes.
- Resolve every actionable line, file, and top-level review thread with scoped fixes and rerun
  affected plus full gates. Reconfirm that CI and review evidence apply to the active head SHA.
- Merge only after authoritative green CI and resolved review threads. Verify the merged PR,
  issue #42 closure, default-branch alignment, and final ROADMAP/live-state consistency before
  removing the feature branch and worktree.
- Validation gate:
  - Focused, full, architecture, codegen, typecheck, build, formatting, Markdown, dependency,
    audit, diff, graph, real-FFmpeg, and completion-no-change gates all pass with recorded evidence.
  - The PR template is complete, the active head is green, review threads are resolved, the PR is
    merged, issue #42 is closed, and cleanup occurs only after authoritative merge verification.

## Advice

- Complete Task 1.1 as the formal package-state barrier, then start Tasks 1.2-1.4 in parallel with
  exclusive file ownership.
- Treat target policy and semantic audit as one contract in
  `conversion-metadata.ts`: a declared container incapability may warn, but a supported field that
  fails to round-trip must abort before publication.
- Keep the stage and Opus sidecar `0600` throughout every validator. Required sidecar disposal
  must succeed before the helper applies and fsyncs `publishMode`, rechecks identity/cancellation,
  and renames.
- Preserve exactly one transaction owner. `convertFileWithValidation()` owns conversion staging,
  audit, optional tier validation, publication, cleanup, result construction, and warning timing;
  verify actions must never wrap converted calls in another stage.
- After Task 3.1, run Tasks 4.1, 4.2, and 4.3 in parallel: the two action adapters own disjoint
  files, and the real-FFmpeg probe is validation-only.
- Keep warning scope at `ConversionResult` plus post-publication human `logWarn()`. Machine-mode
  visibility through action/MCP envelopes is deliberately deferred and must not leak into this
  issue.
- Never infer format from the `.tmp` stage suffix. Every target needs an explicit muxer, and every
  FFmpeg option/value pair must be a separate fixed argv token with `shell: false` and `-nostdin`.
- Native rating data is authoritative: both ID3 families and native Vorbis `RATING` precede the
  common projection. Plex rating sync remains the intentional later override only after conversion
  has fully published.
- Keep ordinary Vitest hermetic. The four-target real FFmpeg matrix is a deliberate delivery gate,
  not a reason to introduce environment-dependent unit tests or permanent unrequested fixtures.
- The only action-test additions are the two transaction-composition assertions. Do not duplicate
  metadata, format, warning, or completion matrices across conversion callers.
- Completion is authoritative-state work: refresh graphify after final edits, audit Bash/Zsh/Fish
  as unchanged, use the exact PR template, verify active-head CI and review threads, merge, confirm
  issue closure/default-branch alignment, and only then clean the worktree.
