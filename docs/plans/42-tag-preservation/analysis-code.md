# Code Analysis: Tag Preservation During Conversion

## Executive Summary

Issue #42 should add one conversion-specific metadata module and integrate it through the existing
`convertFile()` façade. The core transaction is source snapshot → target policy → private staged
encode → MP3 POPM finalization when applicable → destination metadata audit → atomic publication,
with required Opus rating and primary artwork supplied through a bounded private ffmetadata
sidecar. Existing normalized-rating, tag-writer, logger, filesystem, and Vitest patterns are usable,
and the transaction decisions are now fixed: one conversion-owned transaction accepts an optional
additional stage validator, and the validated-stage helper publishes with an explicit ordinary file
mode after private staging. The final warning scope is deliberately narrow:
`ConversionResult.warnings` plus safe human `logWarn()` output; broader action-result,
JSON/YAML/CSV, MCP, config, database, and shell-completion changes are deferred.

## Existing Code Structure

### Package and Layer Boundaries

`packages/rfmedia-cli` is strict ESM TypeScript targeting Node 22+. Commands own Commander parsing
and presentation, actions orchestrate workflows, and `src/lib/` owns reusable conversion, metadata,
rating, filesystem, and writer behavior. All seven conversion consumers already converge on
`convertFile()`:

- `actions/copy-album.ts`
- `actions/copy-filter.ts`
- `actions/sync.ts`
- `actions/plex-copy.ts`
- `actions/plex-playlist.ts`
- `actions/verify-album.ts`
- `actions/verify-filter.ts`

Preservation therefore belongs in `lib/convert.ts` and the new
`lib/conversion-metadata.ts`. The only authorized action changes are the converted branches in
`verify-album.ts` and `verify-filter.ts`, which must join the single conversion transaction instead
of nesting another stage.

### Current Conversion Contracts

The target union is stable:

```ts
export type ConvertFormat = "alac" | "mp3" | "aac" | "opus";
```

The current private preset shape and public function/result contracts are:

```ts
interface ConversionPreset {
  codec: string;
  extension: string;
  outputOptions: string[];
  description: string;
}

export interface ConversionResult {
  outputPath: string;
  duration: number;
  success: boolean;
  error?: string;
}

export async function convertFile(
  source: string,
  dest: string,
  format: ConvertFormat,
  onProgress?: ConversionProgressCallback,
  signal?: AbortSignal,
): Promise<ConversionResult>;
```

`convertFile()` currently:

1. calls `signal?.throwIfAborted()`;
2. creates the destination directory with `ensureDir()`;
3. checks the signal again;
4. builds `ffmpeg -i <source> -acodec <codec> ... -y <dest>`;
5. spawns FFmpeg directly, passing `{ signal }` only when supplied;
6. retains a bounded stderr tail and parses progress from it;
7. resolves on `close(0)` or maps selected stderr text to `ConversionError`; and
8. maps an `ENOENT` spawn error to `FfmpegNotFoundError`.

`ConversionError` retains `sourcePath`, `destPath`, and `reason`. Cancellation is returned as the
exact `signal.reason` when it is an `Error`. `shouldConvert()`, filename/extension helpers, format
validation, and the public target union do not need behavior changes.

### Current FFmpeg Presets and Process Semantics

The preset table is already a `Record<ConvertFormat, ConversionPreset>`, which is the correct
table-driven shape. Its `outputOptions`, however, contain invalid direct-spawn tokens such as
`"-b:a 320k"`; option and value must be separate array elements. The current command also:

- writes directly to the requested destination with `-y`;
- relies on extension inference rather than an explicit muxer;
- has no `-nostdin`;
- does not explicitly map global metadata, audio, or optional artwork;
- has independent `close` and `error` handlers without a settle-once guard; and
- treats successful FFmpeg stderr as progress/debug material, not a metadata-warning source.

The implementation should keep direct `spawn()` ownership and an argv array. It should not
reintroduce `fluent-ffmpeg`, invoke a shell, interpolate tag values into a command string, or infer
known metadata loss from generic stderr.

### Atomic Stage Contract

`replaceFileWithValidatedStage(destinationPath, options)` is the existing hardened transaction:

```ts
export interface ValidatedStageOptions {
  signal?: AbortSignal;
  publishMode?: number;
  materialize: (stagedPath: string, signal: AbortSignal) => Promise<void>;
  validate: (stagedPath: string, signal: AbortSignal) => Promise<void>;
}

export async function replaceFileWithValidatedStage(
  destinationPath: string,
  options: ValidatedStageOptions,
): Promise<void>;
```

The helper resolves the destination parent, records parent and destination identities, creates a
random sibling `.<name>.rfmedia-stage-<uuid>.tmp` with exclusive `open("wx", 0o600)`, and records
the stage inode. After `materialize`, it reopens the stage, requires the same regular-file identity,
fsyncs, invokes `validate`, rechecks the parent, stage, and destination identities, checks abort,
then atomically renames. Its `finally` unlinks the exact stage on every pre-commit failure.

Add optional `publishMode` without changing the private creation mode. A conversion transaction
selects the existing regular destination's ordinary permission bits when replacing it, or
`0o666 & ~process.umask()` when creating a destination. The helper keeps the stage `0600` through
materialization and every validator, applies and fsyncs `publishMode` at the last safe pre-rename
point, then rechecks stage identity and the exact signal before rename. Ignore file-type and
setuid/setgid/sticky bits. If mode application, metadata sync, identity recheck, or cancellation
fails, cleanup runs and the original destination remains untouched. Omitting `publishMode` retains
the helper's existing `0600` publication behavior; the conversion transaction is responsible for
capturing and passing its selected mode.

This matches the observed direct-FFmpeg contract: under umask `077`, a new output was `0600`, while
overwriting an existing `0660` output retained `0660`. Keeping the helper-created `0600` mode after
rename would therefore regress existing destinations; copying source mode would also be wrong
because direct conversion does not use source mode and could propagate special or executable bits.

The existing filesystem tests already prove:

- replacement of an existing file and creation of a missing destination;
- original preservation on materialize, validation, and rename failures;
- abort before validation;
- rejection of a staged symlink;
- parent-identity change detection; and
- absence of leaked stage artifacts.

Conversion tests should consume this contract rather than duplicate the complete filesystem matrix.
Add focused helper coverage for missing/existing publication modes and pre-rename mode failure.
Because the stage ends in `.tmp`, every target must pass an explicit output muxer.

### Rating Read Structure and Duplication

`ratings.ts` currently has three read paths:

```ts
export async function readRating(filePath: string): Promise<NormalizedRating | null>;
export async function readRatingAndFormat(filePath: string): Promise<RatingAndFormat | null>;
export function popmToNormalized(popm: number): number;
export function normalizedToPopm(normalized: number): number;
```

`readRating()` and `readRatingAndFormat()` parse with `{ skipCovers: true }`. They consult
`metadata.common.rating` first, then native POPM or Vorbis comments. `metadata.ts` duplicates the
POPM selection, Vorbis scale detection, format detection, and the same common-first extraction in a
private `extractRating()`. Its `readExtendedMetadata()` also deliberately uses
`skipCovers: true` for filter performance.

The shared `NormalizedRating` already retains the required provenance:

```ts
export interface NormalizedRating {
  value: number;
  source: "POPM" | "Vorbis" | "iTunes" | "unknown";
  email?: string;
  counter?: number;
}
```

The new exported parsed-metadata helper must be native-first:

```ts
export function extractNormalizedRating(
  metadata: Pick<IAudioMetadata, "common" | "native">,
  filePath: string,
): NormalizedRating | null;
```

MP3 should prefer native POPM, Vorbis-family sources should prefer native `RATING`, and the common
projection is only a fallback. This fixes the observed `RATING=0.80` case that
`music-metadata` 11.10.6 projected as `0.008`. `readRating()`, `readRatingAndFormat()`,
`readExtendedMetadata()`, and conversion should all reuse the helper without making filter reads
load covers.

### Tag Writer Behavior

The relevant writer contracts are:

```ts
export interface WriteRatingOptions {
  popmEmail?: string;
  vorbisScale?: "normalized" | "stars" | "percent";
  preserveTags?: boolean;
}

export async function writeRating(
  filePath: string,
  rating: number,
  options?: WriteRatingOptions,
): Promise<WriteRatingResult>;
```

MP3 selects `NodeID3.update()` when `preserveTags` is true, converts normalized values to POPM, and
currently always writes `counter: 0`. Add optional `popmCounter` and preserve the selected source
email/counter for a staged MP3. A false/Error result for this supported mapping is fatal to
conversion.

The installed `node-id3` implementation synchronously reads the complete file, builds a new buffer,
and calls `writeFileSync()` on the same path. That normally truncates the existing inode rather than
renaming it, which is compatible with the validated-stage identity check, but it buffers and
rewrites the whole MP3. Pin the inode behavior with one representative integration assertion and
retain existing worker limits; do not replace the writer with bespoke ID3 framing without measured
need.

The FLAC branch creates its own UUID temporary file and replaces the input. FLAC is not a target for
issue #42, so do not reuse or expand that weaker temporary-file pattern. The current writer rejects
Opus and M4A ratings; Opus preservation belongs in the generated ffmetadata input, while M4A rating
loss is a genuine warning.

### Logger and Final Warning Scope

`packages/rfmedia-cli/src/lib/logger.ts` re-exports `@rfmedia/common`. `logWarn()` writes
`[WARN]` text to stderr only in human formats; it is a no-op for JSON, YAML, and CSV. The final
issue #42 decision accepts that limitation:

- add ordered typed warnings to `ConversionResult`;
- emit safe human warnings from the conversion boundary only after successful audit, progress
  teardown, and publication;
- keep warning-only conversion successful;
- never log raw tag values, POPM identity/counter, artwork, or raw FFmpeg stderr; and
- defer action-result, command machine-output, MCP schema, summary-count, and progress-buffering
  changes.

The additive contract is exact:

```ts
type ConversionWarningCode =
  | "additional_artwork_unsupported"
  | "custom_tag_unsupported"
  | "native_tag_unsupported"
  | "rating_unsupported";

interface ConversionWarning {
  readonly code: ConversionWarningCode;
  readonly reason: string;
  readonly target: ConvertFormat;
  readonly fields: readonly string[];
  readonly source: string;
  readonly destination: string;
  readonly outputUsable: true;
}
```

`ConversionResult.warnings` is required and readonly. Sort warnings by source, destination, code,
safe field name, and reason, then deduplicate the same conversion/reason. Sanitize controls, ANSI,
and displayed paths before calling `logWarn()`.

Current callers await `convertFile()` but do not consume its fields, so the additive result field is
source-compatible. Do not modify actions or output schemas merely to expose warnings in this issue.

### Existing Caller Ordering

- `copy-album.ts` awaits conversion, records history, then hashes the converted destination.
- `copy-filter.ts` records conversion after `convertFile()` and reuses the finalized first copy for
  later range outputs.
- `sync.ts`, `plex-copy.ts`, and `plex-playlist.ts` convert only the first ranged copy and copy/link
  later derivatives.
- Plex copy/playlist paths invoke `syncTrackRating()` after conversion, so a positive configured
  Plex rating remains the deliberate final rating authority.
- Verify repair currently wraps conversion in an outer `replaceFileWithValidatedStage()` and runs
  tiered validation before replacing the repair destination. The converted branches must instead
  call the internal conversion transaction with tier verification as its additional validator;
  nonconverted repairs retain their current outer helper.

All metadata writes and semantic audit must complete before `convertFile()` resolves so these
existing orderings remain correct without caller-wide changes.

## Implementation Patterns

### Focused Conversion Metadata Module

Create one `conversion-metadata.ts` rather than a reader/writer registry. It should own:

- immutable bounded snapshot, picture, text-tag, target-policy, and warning types;
- one cover-aware `parseFile(path, { skipCovers: false })` projection;
- primary/front-cover selection and SHA-256 digest;
- safe compatible-text classification;
- exhaustive `Record<ConvertFormat, ConversionTargetPolicy>`;
- pure FLAC picture-block construction;
- pure ffmetadata escaping/serialization;
- private Opus sidecar create/dispose lifecycle;
- deterministic limitation classification and sorting; and
- semantic destination audit.

It must not spawn FFmpeg, own progress, know commands/actions, mutate final media, or introduce a
general metadata AST.

The bounds are part of this module's public correctness contract: inspect at most 16 pictures, allow
at most 16 MiB for the selected primary picture and 32 MiB across pictures, cap the complete Opus
sidecar at 24 MiB, and allow at most 4,096 text tags with 255-byte UTF-8 keys, 1 MiB individual
values, and 8 MiB aggregate text. Reject NUL and binary/object coercion before serialization.

### Explicit Target Policy

Keep target differences declarative:

| Target      | Muxer  | Artwork                                   | Rating                 | Custom text                |
| ----------- | ------ | ----------------------------------------- | ---------------------- | -------------------------- |
| MP3         | `mp3`  | optional `0:v:0?`, copied as attached pic | staged POPM post-write | mapped/audited as ID3/TXXX |
| AAC in M4A  | `ipod` | optional `0:v:0?`, `-c:v copy`            | unsupported; warn      | unsupported; warn          |
| ALAC in M4A | `ipod` | optional `0:v:0?`, `-c:v copy`            | unsupported; warn      | unsupported; warn          |
| Opus        | `opus` | ffmetadata `METADATA_BLOCK_PICTURE`       | ffmetadata `RATING`    | Vorbis comments and audit  |

Every option and value is a separate token. MP3/M4A explicitly map the first audio stream, global
metadata, and optional artwork; Opus maps no video and uses a second `-f ffmetadata` input. Do not
enable MOV `use_metadata_tags`: the probe lost portable common normalization and artwork.

### Required Opus Sidecar

Primary Opus artwork is required, not warned as unsupported. The sidecar pattern is:

1. inspect at most 16 pictures and select one deterministic front/primary picture;
2. reject more than 32 MiB aggregate or a primary picture over 16 MiB;
3. serialize a standard big-endian FLAC picture block, using zero for unknown dimensions;
4. base64-encode it as `METADATA_BLOCK_PICTURE`;
5. serialize `;FFMETADATA1`, normalized `RATING`, and picture data with one escaper;
6. escape backslash, CR/LF, `=`, `;`, and `#`; reject NUL;
7. cap the complete sidecar at 24 MiB;
8. create it beside the destination with randomized exclusive `open("wx", 0o600)`;
9. sync and close it before spawning FFmpeg; and
10. unlink that exact path in one `finally` on success, error, audit failure, and abort.

Only additional pictures and incompatible structured/binary fields may produce Opus warnings.
Primary-picture loss is a fatal audit failure.

### Semantic Audit

Reparse the staged output with covers enabled. Compare:

- scalar title and album;
- artist and genre values semantically without rewriting custom values;
- track number and total independently;
- normalized year, and full date only when target-supported;
- MP3 rating within one POPM quantization step;
- Opus rating within emitted decimal precision;
- primary picture by exact SHA-256 bytes; and
- compatible custom text by normalized key and value multiset.

Ignore encoder-generated tags and native frame identifiers. A target-policy-supported mismatch is
fatal; a policy-declared incapability produces a deterministic warning. Preserve user values; apply
normalization only for canonical comparison, never as a custom-tag rewrite.

### Direct Process Lifecycle

Keep one small child-process runner in `convert.ts` with:

- `spawn("ffmpeg", argv, { shell: false, signal })`;
- `-nostdin`, fixed target tokens, bounded stderr, and the stage as final argv;
- one settle-once guard shared by `error`, `close`, and abort paths;
- exact abort reason preservation;
- actionable existing error categories; and
- no raw command/tag-value logging.

Generic successful stderr must not determine limitation warnings. Those warnings come from the
source snapshot and target policy, confirmed by the destination audit.

### Vitest Patterns

- Define child-process, parser, writer, and filesystem mocks with `vi.hoisted()`.
- Register `vi.mock()` before importing the module under test.
- Use `clearMocksPreservingImplementations()` or `vi.clearAllMocks()` in `beforeEach`; do not use
  `vi.resetAllMocks()` with hoisted defaults.
- Re-establish any mock implementation intentionally reset with `mockReset()`.
- Use table-driven target and rating cases rather than duplicating four near-identical tests.
- Use `mkdtemp()` plus exact cleanup for real filesystem behavior; avoid fixed temporary names.
- Keep the current pre-abort and in-flight abort tests.
- Reuse filesystem helper tests instead of recreating all identity/rename failure cases in
  `convert.test.ts`.
- Keep real-system FFmpeg probes deliberate and separately provisioned; ordinary Vitest must not
  depend on the runner's FFmpeg build.

## Integration Points

### Files to Create

| File                                                       | Responsibility                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/conversion-metadata.ts`      | Snapshot, policies, Opus serializer/sidecar, warnings, and semantic audit  |
| `packages/rfmedia-cli/src/lib/conversion-metadata.test.ts` | Table-driven policies, bounds, serializer golden data, warnings, and audit |

### Files to Modify

| File                                                         | Change                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `packages/rfmedia-cli/package.json`                          | Raise `music-metadata` to `^11.14.0`                                    |
| `package-lock.json`                                          | Resolve reviewed parser subtree with `file-type >=21.3.4`               |
| `packages/rfmedia-cli/src/lib/ratings.ts`                    | Export and reuse native-first parsed-metadata rating extraction         |
| `packages/rfmedia-cli/src/lib/ratings.test.ts`               | Add native Vorbis, POPM provenance, scale, and fallback regressions     |
| `packages/rfmedia-cli/src/lib/metadata.ts`                   | Delete duplicated rating logic; retain cover-skipping filter projection |
| `packages/rfmedia-cli/src/lib/tag-writer.ts`                 | Add optional POPM counter and preserve staged MP3 provenance            |
| `packages/rfmedia-cli/src/lib/tag-writer.test.ts`            | Assert email/counter plus `NodeID3.update()` behavior                   |
| `packages/rfmedia-cli/src/lib/convert.ts`                    | Target argv, atomic transaction, writer/audit, warnings, and cleanup    |
| `packages/rfmedia-cli/src/lib/convert.test.ts`               | Target argv table and compact process/stage/sidecar lifecycle tests     |
| `packages/rfmedia-cli/src/lib/filesystem.ts`                 | Add optional `publishMode` to the validated-stage commit                |
| `packages/rfmedia-cli/src/lib/filesystem.test.ts`            | Prove publication modes and mode-failure rollback                       |
| `packages/rfmedia-cli/src/actions/verify-album.ts`           | Use conversion-owned staging for converted repairs                      |
| `packages/rfmedia-cli/src/actions/verify-album.test.ts`      | Pin additional tier validation and single transaction ownership         |
| `packages/rfmedia-cli/src/actions/verify-filter.ts`          | Use conversion-owned staging for converted repairs                      |
| `packages/rfmedia-cli/src/actions/verify-filter.test.ts`     | Pin additional tier validation and single transaction ownership         |
| `packages/rfmedia-cli/docs/features/audio-conversion.doc.md` | Document preservation transaction, tested matrix, artwork, and warnings |
| `packages/rfmedia-cli/docs/features/plex-metadata-sync.md`   | Clarify preservation precedes optional Plex rating override             |
| `packages/rfmedia-cli/README.md`                             | Publish preservation guarantee and target limitations                   |
| `ROADMAP.md`                                                 | Update issue status and live counts only at delivery closeout           |

### Authorized Verify Integration

Review all seven call sites, but modify only the converted repair branches in `verify-album.ts` and
`verify-filter.ts`. They call the package-internal conversion transaction and provide tier
verification as an additional validator. Their nonconverted branches retain the outer
`replaceFileWithValidatedStage()` path. Do not change:

- command modules or `--convert` help in this issue;
- copy/sync/Plex/verification result envelopes;
- JSON/YAML/CSV formatters or MCP schemas;
- config or option types;
- database state;
- Bash, Zsh, or Fish completion templates; or
- the root README.

### Transaction Composition Resolution

The verify actions already call `replaceFileWithValidatedStage(destination)` and invoke
`convertFile(source, outerStagePath, format)` inside its `materialize` callback. If the new
`convertFile()` blindly calls `replaceFileWithValidatedStage(outerStagePath)`, the inner helper
renames a new inode over the outer stage. The outer helper then detects that its recorded stage
identity changed and rejects the repair.

The confirmed resolution is one package-internal convert-with-additional-validator transaction.
Public `convertFile(source, dest, format, onProgress?, signal?)` keeps its five-argument contract and
delegates with no additional validator. Converted verify branches call the same internal
transaction with a narrow callback:

```ts
type AdditionalStageValidator = (stagedPath: string, signal: AbortSignal) => Promise<void>;
```

That transaction alone owns source snapshot, sidecar lifecycle, validated stage, FFmpeg, MP3
post-write, semantic metadata audit, optional tier validator, publication mode, atomic rename,
warning logging, and final result. The ordering is metadata audit → additional tier validator →
publish-mode application/sync → final identity and signal checks → rename → warnings/result.

Do not export or reuse a raw encode/materializer callback, infer caller ownership from a
`.rfmedia-stage-*.tmp` filename, nest stages, weaken inode checks, or bypass either validator.
Warnings are emitted only after the single helper commits, so a failed tier validator cannot report
a usable conversion that was never published.

## Code Conventions

- Use ESM `.js` suffixes for relative imports, including type-only imports.
- Keep strict types; do not use `any`. Treat native metadata values as `unknown` and narrow them.
- Account for `noUncheckedIndexedAccess`; guard indexed array and regex-match values.
- Prefer readonly interfaces, literal unions, exhaustive records, and `satisfies`.
- Keep exported functions documented with JSDoc `@param`, `@returns`, and `@throws`.
- Use `error instanceof Error ? error.message : String(error)` for unknown catches.
- Keep paths in `node:path`; never derive a path from a tag key, value, MIME type, or description.
- Use Node `crypto.createHash("sha256")`; do not add a hashing dependency.
- Use one tested ffmetadata escaping function, not scattered replacements.
- Keep error/warning codes stable and prose separate; never include raw metadata values.
- Preserve exact cancellation reasons and check abort around every new asynchronous phase.
- Keep target policy next to argv/audit capability claims so they cannot drift independently.
- Avoid new registries, plugin abstractions, event buses, parser pools, or universal tag models.

## Dependencies and Services

| Dependency or service    | Current state                             | Required use or change                                      |
| ------------------------ | ----------------------------------------- | ----------------------------------------------------------- |
| `music-metadata`         | Declared `^11.0.0`, locked `11.10.6`      | Raise to `^11.14.0`; source/destination parsing with covers |
| `file-type`              | Transitive `21.3.0`                       | Resolve `>=21.3.4` through the reviewed parser update       |
| `node-id3`               | Declared `^0.2.6`, locked/current `0.2.9` | Reuse only for staged MP3 POPM                              |
| `flac-metadata`          | Locked `0.1.1`                            | Do not expand; FLAC is not a conversion target              |
| system FFmpeg            | External, locally probed as `8.1.2`       | Direct shell-free encode and container mapping              |
| Node filesystem/crypto   | Built in                                  | Exclusive sidecars, atomic stage, fsync, unlink, SHA-256    |
| `@rfmedia/common` logger | Existing workspace package                | Human warnings only; machine modes suppress logs            |

The parser update is a shipment hard stop: current `music-metadata` and `file-type` versions are on
the vulnerable conversion path. Review only the affected lockfile subtree, run
`npm ls music-metadata file-type`, and audit production dependencies. Report unrelated existing
audit findings honestly; do not run a broad audit fix.

There is no network API, authentication, database, cache, or persistent metadata service in this
feature. Never fetch artwork URLs. FFmpeg and local untrusted media are the only external trust
boundaries.

## Gotchas and Warnings

1. **Nested verify staging changes inode identity.** Converted repairs must use the confirmed
   conversion-owned transaction and additional tier validator, never an outer conversion stage.
2. **Rename preserves the stage mode.** Pass `publishMode`: preserve an existing destination's
   ordinary bits or use `0o666 & ~process.umask()` for a new output. Keep the stage `0600` until the
   helper's last safe pre-rename mode/sync step, then recheck identity and cancellation.
3. **`.tmp` cannot identify the output container.** Always pass `-f mp3`, `-f ipod`, or `-f opus`.
4. **Combined preset strings are invalid argv.** `"-b:a 320k"` must become `"-b:a", "320k"`; test
   that no policy token combines an option and value.
5. **M4A artwork requires explicit optional video mapping and `-c:v copy`.** Automatic selection
   attempted H.264 and failed in the environment probe.
6. **Opus artwork is required.** Do not map video or emit an unsupported-primary-art warning; use
   `METADATA_BLOCK_PICTURE` and fail if audit cannot recover it.
7. **Common-first rating is wrong for native Vorbis.** A literal `0.80` can become `0.008`; native
   parsing must be authoritative.
8. **Both ID3 families may exist.** Current `ID3v2.3 ?? ID3v2.4` reads only one collection. The
   shared extractor should deliberately define multi-family POPM selection rather than copying
   that accidental behavior.
9. **Parser cancellation is cooperative only around `parseFile()`.** Check before and after; the
   patched dependency removes known loops, but `parseFile()` itself accepts no current abort signal.
10. **Pictures are buffered.** Enforce count and byte caps before digest/base64 work and retain
    existing action concurrency.
11. **`NodeID3.update()` is synchronous and whole-file.** Measure a representative long MP3 and
    prove it retains the stage inode; never weaken stage identity checks.
12. **Supported write/audit failures are fatal.** Only inherent target incapability may warn.
13. **Human warning visibility is intentionally incomplete in machine modes.** Final scope accepts
    `ConversionResult` plus human logging and defers output-envelope propagation.
14. **Warning timing follows the single transaction.** Emit only after conversion progress, semantic
    audit, optional tier validation, and publication complete. Do not interleave warnings from an
    internal materialization phase or broaden machine warning propagation.
15. **First-copy optimization is load-bearing.** Source parse, destination parse, rating write, and
    audit must run only for the first actual conversion, not every hardlink/copy derivative.
16. **Plex rating sync is later authority.** Do not rerun source preservation after
    `syncTrackRating()`.
17. **Source parse failure differs from “no tags.”** Unreadable/untrustworthy metadata is fatal;
    valid media with absent tags converts successfully without invented values.
18. **Sidecar cleanup must be exact and idempotent.** Never use a glob, recursive removal, or a
    tag-derived path.

## Task-Specific Guidance

### Low-Conflict Task Groups

| Group                       | Owned files                                              | Depends on                               | Guidance                                                                                     |
| --------------------------- | -------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| A — Parser lock             | `packages/rfmedia-cli/package.json`, `package-lock.json` | None                                     | Upgrade only the metadata-parser subtree and capture audit evidence.                         |
| B — Rating foundation       | `ratings.ts`, `ratings.test.ts`, `metadata.ts`           | A for final parser semantics             | Establish the native-first helper API before metadata policy imports it.                     |
| C — MP3 provenance          | `tag-writer.ts`, `tag-writer.test.ts`                    | None                                     | Add optional counter and preserve current writer result behavior.                            |
| D — Pure metadata policy    | new `conversion-metadata.ts`, new test                   | A, B                                     | Implement bounds, target record, Opus serializer/sidecar, warnings, and audit.               |
| E1 — Publication primitive  | `filesystem.ts`, `filesystem.test.ts`                    | None                                     | Add `publishMode`, last-safe mode sync, identity/signal recheck, and rollback coverage.      |
| E2 — Conversion transaction | `convert.ts`, `convert.test.ts`                          | C, D, E1                                 | Own process, validators, publication, warnings, cleanup, and existing/new mode selection.    |
| E3 — Verify integration     | both verify actions and their tests                      | E2                                       | Route converted repairs through the additional validator; leave nonconverted staging intact. |
| F — User documentation      | audio guide, Plex sync guide, package README             | E2, E3, and real-format evidence         | Publish only behavior proven by the final target matrix.                                     |
| G — Closeout                | `ROADMAP.md`                                             | All implementation, review, and CI gates | Update live counts/status only after authoritative delivery evidence.                        |

Groups A, B, and C can start independently if B pins expectations against the intended patched
parser. Group D needs the rating helper contract. E1 is an independent narrow filesystem change; E2
is the convergence point and should have one owner because `convert.ts` couples process lifecycle,
stage ownership, validators, modes, and warnings. E3 follows that internal contract. The three
documentation files can be split by file after behavior and fixture evidence stabilize; ROADMAP
closeout stays sequential.

### Suggested Dependency Chain

```text
A parser lock ----+
                  +--> B native-first ratings --> D metadata policy --+
C MP3 provenance -----------------------------------------------------+--> E2 conversion transaction
E1 publication mode --------------------------------------------------+             |
                                                                                   +--> E3 verify integration
                                                                                   |
                                                                                   +--> F documentation --> G closeout
```

Implement the confirmed additional-validator seam in E2 before E3 changes either verify branch.

### Minimal Critical Tests

1. `conversion-metadata.test.ts`: one target-policy/audit table, exact Opus picture block/base64,
   ffmetadata escaping, bounds, warning ordering, and a supported-field mismatch.
2. `filesystem.test.ts`: preserve an existing `0660` destination mode, publish a missing destination
   with the supplied umask-derived mode, and leave the original untouched when mode application
   fails before rename.
3. `convert.test.ts`: one four-target argv table; existing two abort cases; settle-once behavior;
   successful publication; failed audit or additional validation preserving the previous
   destination; existing/new mode selection; and Opus sidecar cleanup across success, failure, and
   abort.
4. `ratings.test.ts`: native Vorbis `0.80 -> 0.8`, normalized/star/percent boundaries, invalid
   values, common fallback, and multi-family POPM provenance.
5. `tag-writer.test.ts`: source POPM email/counter reaches `NodeID3.update()` and false/throw remains
   fatal to conversion.
6. One focused assertion in each verify action test proves converted repair supplies tier validation
   to the conversion transaction and does not invoke an outer stage; retain existing nonconverted
   outer-helper assertions.
7. One focused integration assertion for `node-id3` inode retention. Do not duplicate the target
   matrix across all seven actions.
8. One deliberate real-FFmpeg fixture per target family, reparsed with the upgraded
   `music-metadata`; record exact environment and commands outside ordinary Vitest.

### Verification Order

```bash
npm run build:common
npm run test:run -w packages/rfmedia-cli -- \
  src/lib/filesystem.test.ts \
  src/lib/convert.test.ts \
  src/lib/conversion-metadata.test.ts \
  src/lib/ratings.test.ts \
  src/lib/tag-writer.test.ts \
  src/actions/verify-album.test.ts \
  src/actions/verify-filter.test.ts
npm run typecheck -w packages/rfmedia-cli
npm run test:rfmedia
npm ls music-metadata file-type
npm audit --omit=dev --json
npm run lint:md
```

The package typecheck invokes Lidarr codegen drift and architecture guards. A fresh worktree may
need `npm run build:common` before rfmedia tests/typecheck. Format all changed TypeScript and
Markdown, run `git diff --check`, and record the real-format probe separately because normal CI does
not provision a pinned FFmpeg build.
