# Recommendations: Tag Preservation During Conversion

## Executive Summary

Implement issue #42 inside one shared internal conversion transaction. Public `convertFile()`
delegates without another validator; converted verify-album and verify-filter repairs delegate with
their existing tier validator, so metadata and tier checks run on the same stage. Add one focused
`conversion-metadata.ts` module for a bounded source snapshot, target policy, Opus ffmetadata,
limitation warnings, and destination audit. Keep `convert.ts` responsible for FFmpeg, cancellation,
the single validated stage, MP3 POPM post-write, both validators, warning emission, publish-mode
selection, and atomic publication.

The shipped contract should:

- preserve canonical artist, album, title, track, date/year, genre, rating, and one primary cover;
- preserve compatible arbitrary text for MP3 and Opus;
- warn only for genuine target-representation limits;
- fail when parsing, a supported write, audit, or publication fails;
- leave optional Plex rating sync as the later final authority;
- add warnings to `ConversionResult` and the human logger without broad caller/output-schema churn;
- preserve direct-FFmpeg file modes while keeping materialization and audit private `0600`;
- add no CLI/config/database/completion surface; and
- use minimal central contract tests plus deliberate real-FFmpeg fixture evidence.

Four blockers precede shipment: patch the vulnerable `music-metadata` chain, retain shell-free
tokenized FFmpeg argv, replace direct final-path output with identity-checked atomic staging, and
avoid nested staging in converted verify repairs.

## Implementation Recommendations

### Core Design

1. **`conversion-metadata.ts`**
   - project immutable canonical, safe-text, native-first rating, and picture metadata;
   - enforce target-aware text/picture bounds;
   - hold an exhaustive `Record<ConvertFormat, ConversionTargetPolicy>`;
   - build the Opus FLAC picture block and escaped ffmetadata;
   - classify deterministic limitation warnings; and
   - audit destination semantics and primary-picture digest.
2. **`ratings.ts`**
   - export one parsed-metadata extractor;
   - prefer native POPM for MP3 and native Vorbis `RATING` for FLAC/Ogg/Opus;
   - use common rating only as fallback; and
   - reuse it from `readRating()`, `readRatingAndFormat()`, `metadata.ts`, and conversion.
3. **`convert.ts`**
   - fix combined tokens such as `"-b:a 320k"` to `["-b:a", "320k"]`;
   - use explicit per-target stream/metadata mapping and fixed output muxers;
   - expose one internal convert-with-additional-validator transaction and keep public
     `convertFile()` as its no-extra-validator delegate;
   - run encode, MP3 write, metadata audit, optional tier validation, mode application, and publish
     inside one `replaceFileWithValidatedStage()` call;
   - preserve exact abort reasons and settle process events once;
   - return sorted warnings and emit one safe human warning per conversion/reason; and
   - resolve only after publication.
4. **`tag-writer.ts`**
   - reuse `NodeID3.update()` only for staged MP3 POPM;
   - preserve optional source POPM email/counter; and
   - keep Opus/M4A whole-tag handling outside this rating-only module.
5. **Verify repair actions**
   - change only converted branches in `verify-album.ts` and `verify-filter.ts` to pass their
     `verifyFileByTier()` validator to the internal conversion transaction;
   - retain the existing outer validated-stage helper for non-converted repairs; and
   - never nest stages or expose a raw materializer/publisher callback.
6. **`filesystem.ts`**
   - add optional `publishMode` to `ValidatedStageOptions`, with no behavior change when omitted;
   - keep the stage `0600` during materialization and validation;
   - apply and fsync requested mode at the last safe pre-rename point; and
   - recheck cancellation and inode before the atomic rename.

Do not extend filter-oriented `ExtendedMetadata`, patch other actions, add a universal tag writer,
expose a raw conversion materializer, or reintroduce an FFmpeg wrapper.

### Target Matrix

| Target   | Required mapping                                           | Genuine warning cases                                 |
| -------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| MP3      | Canonical ID3/TXXX, POPM, optional APIC stream copied      | Extra pictures; incompatible structured/binary frames |
| AAC/M4A  | Standard iTunes canonical atoms and copied `covr`          | Rating and incompatible custom/native keys            |
| ALAC/M4A | Same metadata policy as AAC/M4A                            | Same M4A limitations                                  |
| Opus     | Vorbis text, normalized `RATING`, `METADATA_BLOCK_PICTURE` | Extra pictures; incompatible structured/binary fields |

For MP3/M4A, map optional `0:v:0?` and use `-c:v copy`. For Opus, map no video stream; create a
private ffmetadata second input and use `-map_metadata 0:g -map_metadata:s:a 1:g`. Reject MOV
`use_metadata_tags` because the probe lost artwork and common-field normalization.

### Required Opus Artwork Flow

1. Select one deterministic front/primary picture.
2. Enforce 16 pictures inspected, 16 MiB primary, and 32 MiB total picture data.
3. Build the standard big-endian FLAC picture block and base64-encode it.
4. Serialize `;FFMETADATA1`, normalized `RATING`, and `METADATA_BLOCK_PICTURE` with one escaper;
   escape backslash, CR/LF, `=`, `;`, and `#`, and reject NUL.
5. Cap the sidecar at 24 MiB and create it beside the destination with
   `open(path, "wx", 0o600)`.
6. Write, `sync()`, close, and pass only its generated path to FFmpeg.
7. Unlink that exact sidecar in `finally` on success, failure, audit rejection, and abort.
8. Reparse staged Opus and require matching rating and primary-picture SHA-256 before commit.

Primary Opus artwork is supported and required; only additional images may warn.

### Warning and Failure Boundary

Add ordered `warnings` to `ConversionResult`. Include stable code/reason, target, safe field names,
source/destination context, and `outputUsable: true`; never include values, artwork, POPM identity,
or raw FFmpeg stderr.

- Known M4A/custom/native/additional-picture limits: warn and keep valid output.
- Source parse, bounds preventing the required snapshot, FFmpeg, writer, supported-field audit,
  sidecar/stage cleanup, or publication failure: reject and preserve the prior destination.
- Log only after metadata/tier validation, publication, and required cleanup succeed; warning-only
  completion remains successful.
- Stop at `ConversionResult` plus human logging for issue #42. Machine/MCP envelope propagation is a
  coordinated follow-up if a current consumer proves it necessary.

### Security and Atomicity

- Upgrade `music-metadata` to `^11.14.0`; verify locked `file-type >=21.3.4`.
- Confirm the conversion chain clears
  [GHSA-v6c2-xwv6-8xf7](https://github.com/advisories/GHSA-v6c2-xwv6-8xf7),
  [GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473), and
  [GHSA-j47w-4g3g-c36v](https://github.com/advisories/GHSA-j47w-4g3g-c36v).
- Keep `spawn("ffmpeg", argv, { shell: false, signal })`, fixed options, `-nostdin`, bounded stderr,
  and no tag-derived paths/URLs.
- Reuse exactly one `replaceFileWithValidatedStage()` transaction for exclusive `0600` staging,
  metadata audit, optional verify-tier validation, identity checks, fsync, atomic rename, and
  cleanup.
- Extend its options with `publishMode?: number`. Conversion preserves an existing regular
  destination's permission bits or uses `0o666 & ~process.umask()` for a new destination.
- Apply/fsync requested mode only after validation at the last safe pre-rename point, then recheck
  signal and stage inode before rename. Omitted `publishMode` retains existing helper behavior.
- Check cancellation around every metadata/process/write/audit/commit phase and never commit after
  abort.

The mode rule is empirically grounded: with umask `077`, direct FFmpeg created a new output at
`0600`, while replacing an existing `0660` destination retained `0660`. Renaming a fixed `0600`
stage without `publishMode` would regress replacement behavior.

### Exact File Scope

Create:

- `packages/rfmedia-cli/src/lib/conversion-metadata.ts`
- `packages/rfmedia-cli/src/lib/conversion-metadata.test.ts`

Modify:

- `packages/rfmedia-cli/package.json`, `package-lock.json`
- `packages/rfmedia-cli/src/lib/convert.ts`, `convert.test.ts`
- `packages/rfmedia-cli/src/lib/filesystem.ts`, `filesystem.test.ts`
- `packages/rfmedia-cli/src/lib/ratings.ts`, `ratings.test.ts`
- `packages/rfmedia-cli/src/lib/metadata.ts`
- `packages/rfmedia-cli/src/lib/tag-writer.ts`, `tag-writer.test.ts`
- `packages/rfmedia-cli/src/actions/verify-album.ts`, `verify-album.test.ts`
- `packages/rfmedia-cli/src/actions/verify-filter.ts`, `verify-filter.test.ts`
- `packages/rfmedia-cli/docs/features/audio-conversion.doc.md`
- `packages/rfmedia-cli/docs/features/plex-metadata-sync.md`
- `packages/rfmedia-cli/README.md`
- `ROADMAP.md` at closeout

Do not change other actions, commands, completion templates, config/option types, database schema,
root README, MCP schema, or broad result-envelope types. The two verify action changes are limited
to converted-branch transaction wiring and focused tests.

### Conflict Resolution

| Conflict                                             | Decision                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| External research says no dependency update          | Live security audit wins; patched parser chain is blocking                                   |
| Early research says warn for Opus artwork            | Business contract and later empirical ffmetadata proof win; primary artwork is required      |
| Common-first versus native-first rating              | Native-first fixes the observed Vorbis `0.80 -> 0.008` error                                 |
| Direct final output versus atomic stage              | Security/integrity contract wins; audit before atomic publish                                |
| Nested conversion and verify stages                  | One internal conversion transaction owns the stage; verify supplies only an extra validator  |
| Fixed private stage mode versus direct FFmpeg mode   | Keep stage `0600`, then restore existing mode or derive new-file mode immediately pre-rename |
| UX/practices request all machine/MCP warning schemas | Adopt `ConversionResult` plus human logger; defer broad schema churn                         |
| NFC comparison versus exact identifiers              | Preserve values; semantic normalization only for canonical comparison, never custom rewrite  |
| Best-effort tag writer versus correctness            | Supported preservation failures are fatal; only inherent target limits warn                  |
| Multiple-picture capability versus scope             | Guarantee one primary picture; warn once for unrepresented remainder                         |

## Improvement Ideas

- Later propagate warnings across JSON/YAML/CSV/MCP through one coordinated schema change.
- Isolate metadata parsing in a worker for hostile shared libraries.
- Add multiple-picture guarantees after primary-cover behavior stabilizes.
- Establish a supported FFmpeg version/capability floor.
- Provision the real-format matrix in CI if environment drift becomes recurrent.
- Reuse the canonical projection for future drift detection only after that feature defines matching
  semantics.

Defer universal writers, plugin registries, new flags/config, parser pools, output modes, conversion
formats, unrelated audit remediation, and shell-completion changes.

## Risk Assessment

| Risk                                    | Severity | Mitigation / success gate                                               |
| --------------------------------------- | -------- | ----------------------------------------------------------------------- |
| Vulnerable parser chain                 | Critical | Upgrade/lock; fresh audit proves conversion chain clear                 |
| Shell/argv injection                    | Critical | `shell: false`, discrete tokens, fixed policies, adversarial path tests |
| Existing/final file clobber             | Critical | Validated sibling stage, collision/identity checks, atomic rename       |
| Opus picture framing/precedence wrong   | High     | Binary/escaping golden tests and real Opus reparse                      |
| Supported metadata silently lost        | High     | Semantic destination audit before publication                           |
| FFmpeg build differs from probe         | High     | Explicit muxers/policies, fatal audit, recorded capability evidence     |
| Metadata resource exhaustion            | High     | Picture/text/sidecar caps; no base64/native values in argv              |
| Stage/sidecar survives failure          | High     | One cleanup scope, `0600`, all-path lifecycle tests                     |
| `node-id3` alters inode or fields       | Medium   | Inode and semantic integration assertion; never weaken checks           |
| Converted verify nests atomic stages    | Critical | One conversion-owned stage plus optional tier validator                 |
| Fixed `0600` stage regresses final mode | High     | Optional last-moment `publishMode`; direct-FFmpeg mode probe            |
| Parser upgrade changes normalization    | Medium   | Native-first rating/picture fixtures after upgrade                      |
| M4A rating/custom loss                  | Medium   | Deterministic warning plus documented tested matrix                     |
| Warning/progress interleaving           | Medium   | One post-audit line; narrow renderer only if validation proves needed   |
| Machine warnings remain internal        | Medium   | `ConversionResult` seam now; explicit follow-up if required             |
| Extra parse/rewrite cost                | Medium   | First-copy reuse, existing concurrency, representative MP3 measurement  |

Integration gates:

- ordinary callers keep public `convertFile()`, while converted verify branches import only the
  internal additional-validator conversion seam;
- history/hash/plugins/verify repair see only final tagged bytes;
- Plex rating override remains later and best-effort;
- converted verify runs metadata and tier validation inside one conversion-owned stage;
- non-converted verify retains its existing outer staged-copy transaction; and
- final permissions match direct FFmpeg: preserve existing regular destination mode or derive new
  mode from `0o666 & ~process.umask()`.

## Alternative Approaches

| Approach                            | Pros                                     | Cons                                             | Decision |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------------ | -------- |
| Shared façade plus focused module   | One behavior for every caller; testable  | One new module and output parse                  | Adopt    |
| Patch callers                       | Workflow control                         | Duplication and missed paths                     | Reject   |
| Trust FFmpeg defaults               | Minimal code                             | Proven rating/artwork loss and M4A failure       | Reject   |
| Universal writer dependency         | Possible abstraction                     | No proven all-target fit; more supply-chain risk | Reject   |
| Bounded Opus ffmetadata             | Standard, no new dependency              | Own small binary serializer                      | Adopt    |
| Warn for primary Opus art           | Avoid serializer                         | Violates target capability and acceptance        | Reject   |
| MOV `use_metadata_tags`             | Some custom keys                         | Loses cover/common normalization                 | Reject   |
| Direct `-y` destination             | Simple                                   | Cannot preserve prior output                     | Reject   |
| Validated stage                     | Existing hardened transaction            | Needs explicit muxer/inode-compatible writer     | Adopt    |
| Nested verify and conversion stages | Reuses both helpers unchanged            | Inner rename changes inode; outer helper rejects | Reject   |
| Additional verify validator seam    | One stage and both correctness checks    | Narrow internal callback contract                | Adopt    |
| Publish fixed private mode          | Simplest stage flow                      | Regresses existing-destination FFmpeg semantics  | Reject   |
| Optional last-moment publish mode   | Private audit plus compatible final mode | Small shared-helper extension                    | Adopt    |
| Broad warning schema now            | Complete machine visibility              | High public/caller churn                         | Defer    |
| Pure/mocked tests plus real probe   | Stable CI and empirical evidence         | Probe is separately provisioned                  | Adopt    |

## Task Breakdown Preview

### Phase 0 — Security and Baseline (P0, Medium)

- Upgrade/lock the parser chain and review only its lockfile subtree.
- Extract native-first rating logic and pin the `0.80 -> 0.8` regression.
- Fix argv tokenization; add fixed muxers and `-nostdin`.

Gate: advisories cleared, rating tests green, no combined argv tokens, baseline probe repeated.

### Phase 1 — Metadata Policy (P1, Medium)

- Add bounded snapshot/types, exhaustive target record, warning classifier, and semantic audit.
- Add primary-picture digest plus Opus FLAC-block/ffmetadata serializer.
- Add one table-driven pure test covering policies, bounds, escaping, warnings, and fatal mismatch.

Gate: all four targets covered; serializer golden output exact; limits and warning order proven.

### Phase 2 — Atomic Integration (P1, High)

- Add optional `publishMode` to the validated-stage helper and its minimal mode/abort/identity test.
- Add one internal conversion-with-additional-validator transaction; public `convertFile()`
  delegates without one.
- Rewire only converted verify-album/filter repairs to supply their tier validator; retain outer
  staging for non-converted repair.
- Add per-target argv, Opus sidecar lifecycle, MP3 POPM provenance, metadata plus optional tier
  audit, warnings, settle-once process behavior, publish-mode restoration, and full abort checks.

Gate: all four targets reparse with canonical fields and primary art; MP3/Opus rating round-trips;
M4A limitations warn; supported or tier loss fails; one stage owns converted repair; prior
destination, mode, and cleanup survive every failure.

### Phase 3 — Evidence, Docs, Closeout (P2, Medium)

- Add one argv/lifecycle suite, compact rating/writer regressions, the minimal filesystem mode
  contract, and focused verify wiring tests; retain existing abort tests.
- Run deliberate MP3/AAC/ALAC/Opus fixture probes without making ordinary Vitest depend on FFmpeg.
- Run focused/full rfmedia tests, typecheck, architecture/codegen guards, audit, format, Markdown
  lint, and `graphify update .`.
- Update package docs/README/Plex precedence, then ROADMAP/live issue state after verified merge.

Gate: tests/CI green, docs match reparsed evidence, review threads resolved, issue closed, roadmap
counts correct, and worktree cleanup follows authoritative merge verification.

Dependency order:

```text
Phase 0 -> Phase 1 -> Phase 2 -> Phase 3
```

## Key Decisions Needed

Product decisions are resolved: preservation is automatic; no CLI/config/completion change; one
primary picture is guaranteed; Opus uses private ffmetadata; M4A limitations warn; supported loss
fails; `ConversionResult` plus human logging is the scoped warning surface; Plex remains later.

Implementation must confirm:

1. exact `mp3`, `ipod`, and `opus` muxers/mappings on the supported FFmpeg floor;
2. Opus source-global and second-input metadata precedence;
3. `NodeID3.update()` stage-inode and semantic preservation;
4. upgraded parser rating/picture semantics; and
5. readable human warnings with current progress rendering.

Two integration decisions are settled, not open confirmations:

- converted verify repairs use the internal additional-validator transaction and never nest stages;
  non-converted repairs retain the outer helper; and
- conversion passes `publishMode`, preserving an existing regular destination mode or using
  `0o666 & ~process.umask()` for new output, while the stage remains `0600`.

## Open Questions

No question blocks implementation. Follow-ups are:

1. Should machine CLI/MCP warnings be added later through a coordinated schema?
2. Should multiple pictures become guaranteed?
3. Should parsing move to an isolated worker for hostile libraries?
4. Should the project enforce an FFmpeg capability/version floor?
