# Task Structure Analysis: Tag Preservation During Conversion

## Executive Summary

Issue #42 fits an eleven-task implementation graph with one short dependency task, four
foundation tasks, one policy task, one central conversion task, two narrow verified-repair
adapters, one documentation task, and one delivery-closeout task. Each implementation task
has exclusive ownership of one to three files. The sequence preserves maximum safe
parallelism without allowing two workers to edit the same source, test, lock, documentation,
or ROADMAP file.

The critical path is:

`dependency floor -> native-first ratings -> conversion metadata -> convert lifecycle -> verified-repair adapters -> real FFmpeg evidence -> docs -> closeout`

The MP3 POPM writer can run in parallel with ratings, and the existing extended-metadata
reader can be simplified in parallel with the new conversion-metadata module after the shared
rating extractor is stable. `convert.ts` remains the only FFmpeg/process and conversion-stage
owner; exactly one validated transaction publishes each conversion. Machine warning schemas,
commands, databases, and completions remain audit boundaries.

## Recommended Phase Structure

### Phase 0: Baseline and Contract Freeze

Before concurrent edits:

- Record the active head SHA and focused baseline results for `convert.test.ts`,
  `ratings.test.ts`, `metadata.test.ts`, and `tag-writer.test.ts`.
- Confirm the current dependency chain with `npm ls music-metadata file-type --all`.
- Confirm `ConvertFormat`, `convertFile()` arguments, caller ordering, and the existing
  `replaceFileWithValidatedStage()` contract are unchanged public boundaries.
- Freeze the internal contracts from the feature spec:
  `extractNormalizedRating(parsed, filePath)`, optional `popmCounter`, the conversion snapshot
  and policy types, `ConversionResult.warnings`, and the four warning codes.
- Resolve transaction ownership before implementation. `verify-album.ts` and
  `verify-filter.ts` already call `convertFile()` while their own
  `replaceFileWithValidatedStage()` owns the destination transaction. An independently
  atomic inner `convertFile()` would rename over the outer staged inode and correctly fail
  the outer identity check. The safe design is:
  - one internal `convertFileWithValidation()` or equivalent owns stage creation, encode,
    POPM, metadata audit, an optional additional staged validator, publication, cleanup, and
    warning emission;
  - public `convertFile()` delegates to it without an additional validator; and
  - converted verified-repair branches delegate to it with their tier validator, while their
    existing outer helper remains only for non-converted copy/link repair.
- Freeze the resolved mode contract: the stage remains private `0600` through materialization
  and every validator; an optional publish mode is applied and fsynced at the last safe
  pre-rename point. Conversion preserves an existing destination's mode, otherwise uses
  `0o666 & ~process.umask()` to match normal FFmpeg-created media. Sidecars remain `0600`.
- Record that no CLI/configuration/database/MCP/completion change is authorized and no action
  change is allowed beyond the two narrow repair adapters below. If typechecking proves a
  broader result-envelope edit unavoidable, stop for a scope decision.

This phase owns no files and prevents parallel workers from inventing incompatible interfaces.
The two repair adapters below are a narrow, evidence-required exception to the original
"callers unchanged" file list; weakening filesystem identity checks or recognizing stage
filenames heuristically is not an acceptable substitute.

### Phase 1: Dependency, Rating, and Atomic-Stage Foundations

#### Task 1: Patch the Metadata Parser Chain

**Owns**

- `packages/rfmedia-cli/package.json`
- `package-lock.json`

**Responsibilities**

- Set `music-metadata` to `^11.14.0`.
- Resolve `file-type` to at least `21.3.4` without unrelated dependency churn.
- Review the focused lockfile diff and verify that the three named advisories no longer occur
  in the production conversion chain.
- Probe representative parser results enough to catch dependency-upgrade projection changes;
  do not start target-conversion behavior in this task.

**Gate**

- `npm ls music-metadata file-type --all` reports the required floors.
- The production dependency audit is reviewed and the identified parser-chain advisories are
  absent.
- The package and lockfile diff contains no unexplained package upgrades.

Run this task first because it mutates the shared installation and lockfile. Do not run package
tests concurrently with the install.

#### Task 2: Centralize Native-First Rating Extraction

**Owns**

- `packages/rfmedia-cli/src/lib/ratings.ts`
- `packages/rfmedia-cli/src/lib/ratings.test.ts`

**Responsibilities**

- Export `extractNormalizedRating(parsed, filePath)` and route `readRating()` plus
  `readRatingAndFormat()` through it.
- Select MP3 POPM and case-insensitive FLAC/Ogg/Opus `RATING` before the
  `music-metadata` common projection; retain deterministic POPM email selection and counter.
- Inspect both ID3v2.3 and ID3v2.4 collections deliberately rather than preserving the current
  nullish-choice behavior when both families are present.
- Preserve the established normalized range and distinct invalid, 0-1, 0-5, 0-100, fallback,
  and unrated branches.
- Add the regression where native `RATING=0.80` wins over common `0.008`, plus POPM
  email/counter provenance.

**Gate**

- The focused ratings suite passes against the upgraded parser.
- Native-first behavior and every distinct scale/error branch are proven without deleting
  existing parameterized coverage.

**Dependency:** Task 1 for final validation.

#### Task 3: Preserve MP3 POPM Provenance on Write

**Owns**

- `packages/rfmedia-cli/src/lib/tag-writer.ts`
- `packages/rfmedia-cli/src/lib/tag-writer.test.ts`

**Responsibilities**

- Add only optional `popmCounter` to `WriteRatingOptions`.
- Use the selected source email and counter when conversion writes MP3 POPM.
- Retain `preserveTags: true` and the existing writer's format-specific behavior.
- Confirm `NodeID3.update()` does not replace the private staged inode; never weaken validated
  staging to accommodate it.

**Gate**

- The focused writer suite passes with one provenance assertion and an explicit
  `preserveTags: true` assertion.
- Existing FLAC, unsupported-format, clamp, and path coverage remains intact.

**Dependency:** Task 1 for final validation.

#### Task 4: Add Late-Bound Publish Mode to Validated Staging

**Owns**

- `packages/rfmedia-cli/src/lib/filesystem.ts`
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`

**Responsibilities**

- Add optional `publishMode` to `ValidatedStageOptions`; leave the default behavior unchanged
  for every existing caller.
- Keep the staged inode at private `0600` through materialization, fsync, and validation.
- When `publishMode` is supplied, apply it only after validation at the last safe
  pre-publication point, fsync the mode change, then recheck the stage identity and abort
  signal before rename.
- Preserve all existing parent, destination, regular-file, symlink, inode, rollback, and
  cleanup checks. Do not relax identity validation or make sidecars public.

**Gate**

- Existing filesystem tests remain green.
- One critical mode test proves the validator observes `0600`, the committed file receives
  the requested mode, the same staged inode is retained, and the mode path honors abort and
  cleanup.
- An existing/default-path assertion proves omitted `publishMode` preserves current behavior.

**Dependency:** None; final test execution waits for Task 1's install to finish.  
**Parallelism:** Tasks 1-4 can edit concurrently after the baseline; all own disjoint files.

### Phase 2: Metadata Projection and Delegation

#### Task 5: Remove the Duplicate Extended-Metadata Rating Reader

**Owns**

- `packages/rfmedia-cli/src/lib/metadata.ts`

**Responsibilities**

- Delete the common-first duplicate rating logic.
- Delegate the already-parsed metadata object to
  `extractNormalizedRating(metadata, filePath)` while retaining the single
  `skipCovers: true` parse used by filter evaluation.
- Preserve the `ExtendedMetadata` shape and all smart-filter behavior.

**Gate**

- Existing `metadata.test.ts` passes unchanged.
- The ratings and metadata suites together show one rating interpretation contract and no
  extra parse.

**Dependency:** Task 2.

#### Task 6: Build Conversion Metadata Policy, Opus Serialization, and Audit

**Owns**

- `packages/rfmedia-cli/src/lib/conversion-metadata.ts`
- `packages/rfmedia-cli/src/lib/conversion-metadata.test.ts`

**Responsibilities**

- Define the bounded source snapshot, warning types, and exhaustive
  `Record<ConvertFormat, ConversionTargetPolicy>`.
- Parse one cover-aware snapshot containing canonical text, compatible custom text,
  native-first rating, source tag families, and deterministic primary artwork.
- Implement target capability decisions for MP3, AAC/M4A, ALAC/M4A, and Opus, including
  sorted value-free warnings for genuine limitations.
- Build and serialize the bounded FLAC picture block plus Opus ffmetadata content. Enforce all
  picture, text, key, aggregate, and sidecar limits; reject NUL; escape backslash, CR/LF,
  `=`, `;`, and `#`.
- Provide narrow sidecar creation/disposal helpers using an unpredictable, exclusive,
  same-directory `0600` file that is synced and closed before use.
- Implement semantic destination audit: NFC scalar comparison, artist/genre and custom-text
  multisets, independent track number/total, supported date/year, rating tolerances, and
  primary artwork SHA-256. A supported mismatch must throw.
- Keep process spawn, progress, cancellation settlement, and atomic publication out of this
  module.

**Gate**

- One table-driven suite covers all four policies, deterministic deduplication, exact tiny
  picture-block/base64 bytes, escaping/NUL/bounds, semantic normalization, rating tolerances,
  artwork digest, and at least one fatal supported-field mismatch.
- No raw metadata values, POPM content, base64, or raw stderr can enter a warning.

**Dependencies:** Tasks 1 and 2.  
**Parallelism:** Tasks 5 and 6 can run together; they have no overlapping files.

### Phase 3: Shared Conversion Transaction

#### Task 7: Integrate Metadata Into the Atomic Conversion Lifecycle

**Owns**

- `packages/rfmedia-cli/src/lib/convert.ts`
- `packages/rfmedia-cli/src/lib/convert.test.ts`

**Responsibilities**

- Keep the public `convertFile(source, dest, format, onProgress?, signal?)` signature and add
  required `warnings` only to `ConversionResult`.
- Expose one internal `convertFileWithValidation()` or equivalent that accepts an optional
  additional staged validator and owns the complete validated-stage transaction. Public
  `convertFile()` delegates without an additional validator.
- Replace combined option strings such as `"-b:a 320k"` with discrete fixed argv tokens.
- Use `spawn("ffmpeg", argv, { shell: false, signal })`, `-nostdin`, bounded stderr, explicit
  audio/artwork/metadata maps, explicit `mp3`/`ipod`/`opus` muxers, and the private stage as
  the final argument.
- Reuse `replaceFileWithValidatedStage()` unchanged for materialize, sync, identity check,
  validation, atomic rename, and rollback apart from its new optional `publishMode`. Never
  nest two validated-stage transactions around the same artifact.
- Determine `publishMode` before staging: preserve the existing destination's permission bits
  when it exists; otherwise use `0o666 & ~process.umask()`, matching a normal FFmpeg-created
  file. Pass that mode to the atomic helper without exposing it during audit.
- Snapshot before encoding; create the Opus sidecar before spawn; apply MP3 POPM after FFmpeg;
  parse and audit the stage; recheck cancellation; then publish.
- When supplied, run the additional staged validator after the conversion metadata audit and
  before the final cancellation check and rename.
- Dispose the exact Opus sidecar in an outer `finally` after success, spawn failure, nonzero
  close, post-write failure, audit rejection, publication failure, and abort.
- Settle child `error`, `close`, and abort once while preserving the exact `signal.reason`.
- Emit sorted human warnings only after successful publication and return them from
  `ConversionResult`, regardless of whether an additional validator was supplied. Do not add
  action-result or machine-schema propagation.
- Retain the existing ordering where callers await final publication before history, hashing,
  copy/hardlink reuse, or an optional later Plex rating override.

**Gate**

- A compact four-target argv table proves tokenization, mappings, codecs, explicit muxers,
  private output, M4A's lack of `use_metadata_tags`, and Opus's lack of a video stream.
- Lifecycle tests prove settle-once behavior, exact cancellation reason, prior-destination
  preservation, audit-before-rename, MP3 post-write-before-audit, and private stage/sidecar
  cleanup on every outcome.
- Warning-only conversion returns `success: true` and human diagnostics do not corrupt
  machine stdout.
- Direct conversion uses one stage/rename, preserves the expected destination mode, and does
  not weaken regular-file, parent, destination, or inode checks.
- Mode tests cover both existing-destination preservation and missing-destination umask
  derivation while proving metadata and tier validators still observe private `0600`.
- Existing abort tests remain; do not duplicate the target matrix in the seven caller suites.

**Dependencies:** Tasks 2, 3, 4, and 6. Task 5 must complete before the phase gate but does
not block editing this task.

#### Task 8: Adapt Verified Album Repair to the Shared Conversion Transaction

**Owns**

- `packages/rfmedia-cli/src/actions/verify-album.ts`
- `packages/rfmedia-cli/src/actions/verify-album.test.ts`

**Responsibilities**

- In the converted repair branch only, call the Task 7 transaction seam with the existing
  tier verifier as its additional staged validator.
- Preserve fingerprint decisions, cancellation, tier semantics, and a single atomic
  publication. Retain the existing outer validated-stage helper only for non-converted
  copy/link repair.
- Let the shared conversion transaction own publication and post-publication human warning
  emission. Do not add warnings to the action result.
- Update only the existing staging assertion needed to prove one transaction owner; do not
  add a four-target or metadata matrix to this action suite.

**Gate**

- The existing verify-album suite passes.
- A focused assertion proves converted repair uses one stage/rename, runs metadata audit
  before tier validation, and publishes only after both validators pass.

**Dependency:** Task 7.

#### Task 9: Adapt Verified Filter Repair to the Shared Conversion Transaction

**Owns**

- `packages/rfmedia-cli/src/actions/verify-filter.ts`
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts`

**Responsibilities**

- Make the same converted-repair adaptation as Task 8 by supplying the existing tier verifier
  to the shared conversion transaction. Preserve filter-specific fingerprint resolution,
  tier semantics, conflict accounting, cancellation, and the outer helper for non-converted
  repair.
- Let `convert.ts` retain publication and warning timing; keep the current action result and
  machine-output contracts.
- Update only the existing staging assertion needed to prove one transaction owner; do not
  duplicate conversion policies or warning tests here.

**Gate**

- The existing verify-filter suite passes.
- A focused assertion proves the converted repair is metadata-audited and tier-validated on
  the same stage before one publication.

**Dependency:** Task 7.  
**Parallelism:** Tasks 8 and 9 can run together with exclusive action/test ownership.

### Phase 4: Empirical Evidence and Documentation

#### Validation Gate A: Real FFmpeg Compatibility Probe

This is a verification gate, not a source-file task. Run it after Tasks 8 and 9 and before
final documentation:

- Record `ffmpeg -version`.
- Convert representative ID3, Vorbis/FLAC, and MP4 tagged fixtures to MP3, AAC/M4A, ALAC/M4A,
  and Opus.
- Reparse each destination with upgraded `music-metadata`.
- Verify supported canonical/custom data, normalized rating policy, primary artwork SHA-256,
  Opus source-comment plus sidecar precedence, no Opus video stream, M4A standard visibility,
  and usable warning-only outcomes.
- Confirm the MP3 POPM update retains the staged inode and the published mode follows the
  repository's media-file policy.
- Keep the probe deliberate/local or provisioned; do not make ordinary Vitest require FFmpeg
  or add a permanent fixture file merely to record output.

Any failed empirical confirmation returns to the owning task; it must not be papered over in
documentation.

#### Task 10: Document Verified Preservation Behavior

**Owns**

- `packages/rfmedia-cli/docs/features/audio-conversion.doc.md`
- `packages/rfmedia-cli/docs/features/plex-metadata-sync.md`
- `packages/rfmedia-cli/README.md`

**Responsibilities**

- Publish the verified target matrix, primary-cover guarantee, supported-loss failure
  boundary, warning-only target limitations, limits, and dependency/FFmpeg expectations.
- Clarify that source metadata preservation completes before an explicitly requested
  successful Plex rating override; a failed override leaves the preserved source rating.
- State that preservation is automatic and adds no flags, configuration, database, or
  machine-output schema.
- Use observed probe behavior, not speculative container capabilities.

**Gate**

- Prettier and Markdown lint pass for the three owned files.
- Examples contain no secrets, raw metadata values, or claims beyond the verified matrix.

**Dependency:** Tasks 8 and 9 plus Validation Gate A.

### Phase 5: Full Validation and Delivery Closeout

#### Validation Gate B: Repository and Scope Audit

Run after Tasks 1-10:

1. Focused tests for filesystem staging, ratings, metadata, tag writer, conversion metadata,
   and conversion.
2. Full `rfmedia` test suite.
3. Root test suite, including architecture and Lidarr codegen contracts.
4. Typecheck and full build, building `rf-common` first where required.
5. `npm ls music-metadata file-type --all`, production dependency audit, Prettier check,
   Markdown lint, and `git diff --check`.
6. `graphify update .` after the final code and documentation state, then inspect the graph
   diff for unrelated churn.
7. Inspect the branch diff for prohibited surfaces: action files other than the two verified
   repair adapters, action/MCP result envelopes, commands, options, configuration, database
   code, root README, and
   `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts`.
8. Record the completion audit explicitly: Bash, Zsh, and Fish are unchanged because there is
   no CLI-surface delta; do not add completion parity tests.

The full validation gate should include these repository commands where applicable:

```bash
npm run test:run -w packages/rfmedia-cli
npm run test:run
npm run typecheck
npm run build:all
npm run format:check
npm run lint:md
npm run test:contracts
npm ls music-metadata file-type --all
npm audit --omit=dev
git diff --check
graphify update .
```

Do not treat an unrelated audit finding as evidence that the required parser chain is still
vulnerable; document the path and disposition precisely.

#### Task 11: Reconcile ROADMAP and Complete Delivery

**Owns**

- `ROADMAP.md`

**Responsibilities**

- Update issue #42 status only after implementation and all local gates pass.
- Re-audit the live GitHub issue hierarchy and counts; do not infer closeout from stale
  ROADMAP text.
- Use `.github/pull_request_template.md` exactly, including exact commands and outcomes in
  `## Testing`, risk/rollback, and `Closes #42`.
- Resolve all actionable review threads and revalidate the active head SHA after fixes.
- Require authoritative green CI, merge state, issue closure, default-branch alignment, and
  only then branch/worktree cleanup.

**Gate**

- ROADMAP matches live issue state.
- Active-head CI is green, review threads are resolved, the PR is merged, issue #42 is closed,
  and cleanup occurs only after authoritative verification.

**Dependencies:** Tasks 1-10 and Validation Gates A-B.

## Task Granularity Recommendations

- Keep the atomic helper and its tests in Task 4. Publish-mode timing, fsync, identity, abort,
  and backward compatibility are one filesystem contract independent of conversion policy.
- Keep policy plus its colocated test in Task 6. Splitting one new module across multiple
  workers would create more coordination cost and conflicting ownership than useful
  parallelism.
- Keep `convert.ts` plus `convert.test.ts` together. FFmpeg argv, progress, cancellation,
  sidecar lifetime, post-write audit, warnings, and publication are one process lifecycle.
- Keep each verified-repair adapter with its existing test file. These tasks resolve the
  proven nested-transaction conflict with one focused assertion each, not new action-level
  metadata coverage.
- Keep ratings interpretation separate from `metadata.ts` delegation. This respects the
  three-file ceiling, gives the extractor a stable contract first, and lets the existing
  metadata tests validate an unchanged consumer surface without editing them.
- Keep POPM provenance isolated from conversion integration so the writer contract can be
  reviewed and tested without child-process mocks.
- Keep all three user-documentation files together because the format matrix, Plex
  precedence, and README summary must use the same verified wording.
- Treat real FFmpeg, full validation, graph refresh, and scope/completion checks as gates, not
  artificial source-file tasks.
- Do not create caller-action test tasks beyond the two repair adapters. Existing sequencing
  elsewhere is an integration invariant; centralized `convert.test.ts`, typechecking, and the
  full suite are sufficient unless a real regression is discovered.

## Dependency Analysis

```text
Task 1 dependency floor ---+
                            +--> Task 6 metadata policy ---+
Task 2 ratings ------------+                               |
        +--> Task 5 metadata delegation [phase gate]       |
                                                            |
Task 3 POPM writer -----------------------------------------+--> Task 7 convert
                                                            |
Task 4 publish mode ----------------------------------------+
                                                                    |
                                                     +--------------+--------------+
                                                     |                             |
                                         Task 8 verify-album           Task 9 verify-filter
                                                     +--------------+--------------+
                                                                    |
                                                          Real FFmpeg gate
                                                                    |
                                                               Task 10 docs
                                                                    |
                                                        Full validation gate
                                                                    |
                                                         Task 11 ROADMAP/closeout
```

Recommended execution waves:

| Wave | Work                                    | Parallelism rule                                |
| ---- | --------------------------------------- | ----------------------------------------------- |
| 0    | Baseline                                | Record clean focused evidence before edits      |
| 1    | Tasks 1, 2, 3, and 4                    | Parallel edits; tests wait for Task 1 install   |
| 2    | Tasks 5 and 6                           | Fully parallel after Task 2; disjoint files     |
| 3    | Task 7                                  | Single conversion owner after Tasks 3, 4, and 6 |
| 4    | Tasks 8 and 9                           | Parallel repair adapters; no overlapping files  |
| 5    | Real FFmpeg gate, then Task 10          | Evidence precedes final documentation           |
| 6    | Full validation, graph refresh, Task 11 | Serialize final state, live audit, and closeout |

The longest branch is Tasks 1 + 2 -> 6 -> 7 -> 8/9 -> probe -> 10 -> 11. Tasks 1-4 are
deliberately parallel at the edit stage; Task 5 runs with Task 6; and Task 8 runs with Task 9.
Do not parallelize test execution with Task 1's install or the final graph, ROADMAP, and
delivery-state mutations.

## File-to-Task Mapping

| File                                                         | Task | Ownership note                                    |
| ------------------------------------------------------------ | ---- | ------------------------------------------------- |
| `packages/rfmedia-cli/package.json`                          | 1    | Parser version only                               |
| `package-lock.json`                                          | 1    | Single lockfile owner                             |
| `packages/rfmedia-cli/src/lib/ratings.ts`                    | 2    | Rating interpretation authority                   |
| `packages/rfmedia-cli/src/lib/ratings.test.ts`               | 2    | Native-first and scale regressions                |
| `packages/rfmedia-cli/src/lib/tag-writer.ts`                 | 3    | Optional POPM counter only                        |
| `packages/rfmedia-cli/src/lib/tag-writer.test.ts`            | 3    | POPM provenance contract                          |
| `packages/rfmedia-cli/src/lib/filesystem.ts`                 | 4    | Optional late publish mode                        |
| `packages/rfmedia-cli/src/lib/filesystem.test.ts`            | 4    | Privacy, mode, fsync, and compatibility gate      |
| `packages/rfmedia-cli/src/lib/metadata.ts`                   | 5    | Delegation only                                   |
| `packages/rfmedia-cli/src/lib/conversion-metadata.ts`        | 6    | New projection/policy/serialization/audit module  |
| `packages/rfmedia-cli/src/lib/conversion-metadata.test.ts`   | 6    | Pure policy and audit contract                    |
| `packages/rfmedia-cli/src/lib/convert.ts`                    | 7    | Sole FFmpeg and conversion-transaction owner      |
| `packages/rfmedia-cli/src/lib/convert.test.ts`               | 7    | Central lifecycle, mode, and target argv coverage |
| `packages/rfmedia-cli/src/actions/verify-album.ts`           | 8    | Supply album tier validator for converted repair  |
| `packages/rfmedia-cli/src/actions/verify-album.test.ts`      | 8    | Single-stage repair assertion                     |
| `packages/rfmedia-cli/src/actions/verify-filter.ts`          | 9    | Supply filter tier validator for converted repair |
| `packages/rfmedia-cli/src/actions/verify-filter.test.ts`     | 9    | Single-stage repair assertion                     |
| `packages/rfmedia-cli/docs/features/audio-conversion.doc.md` | 10   | Detailed verified behavior                        |
| `packages/rfmedia-cli/docs/features/plex-metadata-sync.md`   | 10   | Rating-authority ordering                         |
| `packages/rfmedia-cli/README.md`                             | 10   | Concise user-facing summary                       |
| `ROADMAP.md`                                                 | 11   | Live-state closeout only                          |

Read-only validation boundaries include `metadata.test.ts`, the five non-repair conversion
callers and their suites, `types/options.ts`, action/MCP result schemas, root README, and
Bash/Zsh/Fish completion templates. No task owns those files; an unexpected need to edit one
is a scope-review trigger.

Generated `graphify-out/` changes are workflow output from the final graph refresh, not
hand-authored task ownership. Review and include only the expected generated state.

## Optimization Opportunities

- Use an exhaustive policy table and table-driven tests to cover four formats without four
  implementations or seven caller matrices.
- Reuse the parsed source metadata in Task 6 and the parsed destination audit result; avoid
  extra reads in `convert.ts` or caller actions.
- Reuse the existing atomic stage, logger, rating normalization, MP3 writer, and first-copy
  behavior. Do not add a universal tag writer, generic audit framework, FFmpeg wrapper,
  provider registry, event bus, or output-schema project.
- Keep hermetic unit tests fast through process/filesystem mocks and exact tiny serializers;
  reserve installed FFmpeg for the deliberate compatibility gate.
- Merge each wave only after its focused gate. This exposes parser, type, and contract drift
  before the high-risk lifecycle task absorbs it.
- Keep one worker responsible for each source plus colocated test pair so review fixes return
  to the same owner without cross-task edits.

## Implementation Strategy Recommendations

1. Land the dependency floor first and treat it as a security gate, not incidental lockfile
   churn.
2. Stabilize native-first rating semantics and POPM write provenance before building target
   policy. Preserve exact source rating authority for later integration.
3. Extend validated staging with a backward-compatible late publish mode. Keep the inode
   private through validation, then apply and fsync mode without weakening final identity or
   cancellation checks.
4. Build the new conversion-metadata module around bounded data-in/data-out contracts. The
   sole narrow effect is private sidecar creation/disposal; all process and publication
   effects stay in `convert.ts`.
5. Integrate all formats in one transaction, derive existing-or-umask publish mode, and make
   semantic audit the publication gate. Known capability loss warns; supported-field loss
   fails.
6. Route converted verified repairs through the shared conversion transaction with their tier
   validator. Keep their outer helper only for non-converted repair; never weaken inode checks
   or infer transaction ownership from a temporary filename.
7. Keep warning scope intentionally narrow: required `ConversionResult.warnings` plus
   sanitized human stderr after success. Defer action/MCP/machine propagation.
8. Use real FFmpeg output to settle empirical compatibility before documentation. Never make
   ordinary Vitest depend on an unprovisioned binary.
9. Enforce the no-change completion audit for Bash, Zsh, and Fish; the stable CLI surface
   means no completion edits or parity-test additions.
10. Refresh graphify and execute the full repository gates before ROADMAP/PR closeout. Verify
    live GitHub state and the active head rather than relying on local or stale planning text.
