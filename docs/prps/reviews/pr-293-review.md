# PR Review #293 — Preserve Tags During Conversion

**Reviewed**: 2026-07-28T16:42:58Z
**Mode**: PR
**Author**: yandy-r
**Branch**: feat/42-tag-preservation → master
**Decision**: BLOCK

## Summary

The three-lens review found a strong fail-closed design and broad verification, but identified
two blocking data-loss/security risks plus source, destination, artwork, comment, cancellation,
and sidecar gaps that must be corrected before merge. Local validation and all five GitHub checks
passed on the reviewed head.

## Findings

### CRITICAL

- **[F001]** `packages/rfmedia-cli/src/lib/convert.ts:567` — The transaction does not reject a source that is the destination or the same filesystem object, so staged publication can destroy the original source.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Resolve and record both endpoints before parsing, reject equal canonical paths or device/inode identities, retain source identity checks through commit, and add same-path and hardlink-alias regressions.

- **[F002]** `packages/rfmedia-cli/src/lib/filesystem.ts:552` — The exclusive stage handle is closed before path-based materialization; an attacker with destination-directory write access can replace the stage with a symlink and make FFmpeg truncate its target before the later inode check.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Keep the exclusive file description authoritative through materialization and make FFmpeg write to that descriptor, or reject shared-writable destination parents when descriptor-backed output is unavailable; add an adversarial stage-swap test.

### HIGH

- **[F003]** `packages/rfmedia-cli/src/lib/conversion-metadata.ts:268` — Source identity is not bound across metadata snapshotting and encoding, allowing audio and metadata to come from different source inodes after a path replacement.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Capture a source identity/version tuple before parsing, verify it after snapshotting and immediately before and after FFmpeg, fail on any change, and add a source-swap race regression.

- **[F004]** `packages/rfmedia-cli/src/lib/conversion-metadata.ts:593` — The Opus sidecar handle and inode are discarded after creation, while FFmpeg and cleanup later trust only its pathname.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Record and revalidate the resolved parent and sidecar device/inode before use and unlink; preferably pass an already-open read descriptor to FFmpeg.

- **[F005]** `packages/rfmedia-cli/src/lib/conversion-metadata.ts:775` — Real ID3 `COMM` frames are structured objects, but scalar projection rejects objects, so promised comment preservation can degrade to a warning instead of being audited.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Add a narrowly typed `COMM` projection that retains validated text and descriptor semantics, audit it through the compatible comment identity, and add parser-shaped and real conversion regressions.

- **[F006]** `packages/rfmedia-cli/src/lib/convert.ts:325` — Snapshot projection prefers a front cover, but FFmpeg always maps `0:v:0?`; back-cover-first inputs therefore stage the wrong image and fail the expected audit.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Carry and map the selected picture stream index, or materialize the selected bounded picture as an explicit artwork input, with a back-first/front-second conversion regression.

- **[F007]** `packages/rfmedia-cli/src/lib/convert.ts:551` — Destination mode and destination identity are captured in separate transactions, allowing a destination created or replaced during metadata parsing to become the accepted overwrite baseline.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Capture mode and identity atomically at the validated-stage boundary, reject mismatches before publication, and test created-between-checks and replaced-between-checks races.

### MEDIUM

- **[F008]** `ROADMAP.md:10` — The header retains pre-merge live counts even though merging this PR will close #42 and reduce the projected totals to 86 open issues, 40 rfapps and 46 rfmedia.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Update the header from the projected post-merge audit and recheck live issue totals immediately before merge.

- **[F009]** `packages/rfmedia-cli/src/lib/conversion-metadata.ts:167` — `pictureCount` is optional in the exported type even though production snapshots and child-response validation require it, weakening the static contract and permitting missed extra-artwork warnings.
  - **Status**: Fixed
  - **Category**: Type Safety
  - **Suggested fix**: Make `pictureCount` required, remove the fallback, and update fixtures and the feature specification.

- **[F010]** `packages/rfmedia-cli/src/lib/conversion-metadata.ts:265` — Metadata child parsing is not abort-aware, so cancellation during source parsing or staged audit waits for response or timeout and delays cleanup.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Thread the transaction signal into both parse calls, terminate and disconnect the child on abort, reject with the exact signal reason, and add source-parse and audit-parse cancellation tests.

- **[F011]** `packages/rfmedia-cli/src/lib/tag-writer.ts:132` — Rated MP3 conversion calls synchronous `NodeID3.update()` in the main process, which reads and duplicates the entire staged MP3 without a parent-heap bound.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Move POPM mutation to a resource-limited helper, use a bounded writer, or enforce and document a maximum staged MP3 size before invoking the synchronous library.

### LOW

- **[F012]** `docs/plans/42-tag-preservation/feature-spec.md:141` — The authoritative spec omits `pictureCount` and `unsupportedNativeFields` and names `convertFileWithAdditionalValidator()` instead of `convertFileWithValidation()`.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Update the snapshot model and internal API name to match the implemented contract.

- **[F013]** `packages/rfmedia-cli/src/lib/conversion-metadata.ts:20` — The 1,767-line module combines IPC, projection, policy, warnings, sidecar lifecycle, serialization, and audit responsibilities.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Split protocol/projection, child client, sidecar serialization, and audit/policy into focused internal modules behind the existing facade.

## Validation Results

| Check      | Result |
| ---------- | ------ |
| Type check | Pass   |
| Lint       | Pass   |
| Tests      | Pass   |
| Build      | Pass   |

## Files Reviewed

- `ROADMAP.md` (Modified)
- `docs/plans/42-tag-preservation/analysis-code.md` (Added)
- `docs/plans/42-tag-preservation/analysis-context.md` (Added)
- `docs/plans/42-tag-preservation/analysis-tasks.md` (Added)
- `docs/plans/42-tag-preservation/feature-spec.md` (Added)
- `docs/plans/42-tag-preservation/parallel-plan.md` (Added)
- `docs/plans/42-tag-preservation/research-architecture.md` (Added)
- `docs/plans/42-tag-preservation/research-business.md` (Added)
- `docs/plans/42-tag-preservation/research-docs.md` (Added)
- `docs/plans/42-tag-preservation/research-external.md` (Added)
- `docs/plans/42-tag-preservation/research-integration.md` (Added)
- `docs/plans/42-tag-preservation/research-patterns.md` (Added)
- `docs/plans/42-tag-preservation/research-practices.md` (Added)
- `docs/plans/42-tag-preservation/research-recommendations.md` (Added)
- `docs/plans/42-tag-preservation/research-security.md` (Added)
- `docs/plans/42-tag-preservation/research-technical.md` (Added)
- `docs/plans/42-tag-preservation/research-ux.md` (Added)
- `docs/plans/42-tag-preservation/shared.md` (Added)
- `package-lock.json` (Modified)
- `packages/rfmedia-cli/README.md` (Modified)
- `packages/rfmedia-cli/benchmarks/tsconfig.json` (Modified)
- `packages/rfmedia-cli/docs/features/audio-conversion.doc.md` (Modified)
- `packages/rfmedia-cli/docs/features/plex-metadata-sync.md` (Modified)
- `packages/rfmedia-cli/package.json` (Modified)
- `packages/rfmedia-cli/src/actions/verify-album.test.ts` (Modified)
- `packages/rfmedia-cli/src/actions/verify-album.ts` (Modified)
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts` (Modified)
- `packages/rfmedia-cli/src/actions/verify-filter.ts` (Modified)
- `packages/rfmedia-cli/src/lib/conversion-metadata-worker.ts` (Added)
- `packages/rfmedia-cli/src/lib/conversion-metadata.test.ts` (Added)
- `packages/rfmedia-cli/src/lib/conversion-metadata.ts` (Added)
- `packages/rfmedia-cli/src/lib/convert.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/convert.ts` (Modified)
- `packages/rfmedia-cli/src/lib/filesystem.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/filesystem.ts` (Modified)
- `packages/rfmedia-cli/src/lib/metadata.ts` (Modified)
- `packages/rfmedia-cli/src/lib/ratings.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/ratings.ts` (Modified)
- `packages/rfmedia-cli/src/lib/tag-writer.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/tag-writer.ts` (Modified)
