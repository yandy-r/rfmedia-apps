# Pattern Research: Tag Preservation During Conversion

## Scope and Current Contract

Issue #42 asks conversion to preserve artist, album, title, track number, year, genre, rating,
artwork, and custom tags, while warning when a target format cannot represent a source tag. The
public conversion formats and CLI flags already exist, so the relevant pattern is an internal
library change rather than a new command surface.

`convertFile()` is the shared mutation seam. It is called by album copy, filter copy, sync, Plex
copy, Plex playlist export, and verification repair paths. Keeping preservation inside this seam
gives those workflows identical behavior without duplicating metadata logic in their actions.

- `packages/rfmedia-cli/src/lib/convert.ts`: typed conversion presets, FFmpeg process lifecycle,
  cancellation, progress parsing, and typed conversion errors
- `packages/rfmedia-cli/src/actions/copy-album.ts`: album-copy consumer
- `packages/rfmedia-cli/src/actions/copy-filter.ts`: filter-copy consumer
- `packages/rfmedia-cli/src/actions/sync.ts`: incremental-sync consumer
- `packages/rfmedia-cli/src/actions/plex-copy.ts`: Plex copy consumer
- `packages/rfmedia-cli/src/actions/plex-playlist.ts`: playlist export/sync consumer
- `packages/rfmedia-cli/src/actions/verify-album.ts`: repair consumer
- `packages/rfmedia-cli/src/actions/verify-filter.ts`: repair consumer

Graphify confirms that `convertFile()` is a high-degree shared node imported by all of those
callers. The graph also shows that conversion and ratings currently meet through consumers such as
`sync.ts`, not through a direct `convert.ts` to `ratings.ts` dependency.

## Architectural Patterns

**Central library seam**: Cross-cutting conversion behavior belongs in `convertFile()` rather than
in individual commands or actions.

- Example: `packages/rfmedia-cli/src/lib/convert.ts`
- Examples of consumers:
  `packages/rfmedia-cli/src/actions/copy-album.ts`,
  `packages/rfmedia-cli/src/actions/copy-filter.ts`, and
  `packages/rfmedia-cli/src/actions/sync.ts`

The existing call signature accepts source path, destination path, target format, optional progress
callback, and optional abort signal. Preserving this signature avoids changes in every consumer and
keeps cancellation behavior stable.

**Typed preset table**: Format differences are represented as a
`Record<ConvertFormat, ConversionPreset>`.

- Example: `packages/rfmedia-cli/src/lib/convert.ts`
- Type source: `packages/rfmedia-cli/src/types/options.ts`

Metadata/container-specific FFmpeg options should follow this table-driven convention rather than a
format switch scattered through process orchestration. One important current gotcha is that the
direct `spawn()` API expects one token per array entry, but bitrate presets currently contain
combined entries such as `"-b:a 320k"`. New metadata options must be tokenized as distinct argv
entries; implementation should not copy the combined-token pattern.

**Direct process ownership**: The library owns the complete FFmpeg child-process lifecycle using
`spawn()`, captures bounded stderr, translates known failure text, and resolves only on exit code
zero.

- Example: `packages/rfmedia-cli/src/lib/convert.ts`
- Historical convention: commit `aa82fb12` replaced `fluent-ffmpeg` with direct process execution

Metadata preservation should therefore be expressed through explicit, deterministic FFmpeg argv
construction and result inspection, not by reintroducing a fluent wrapper.

**Single-pass metadata reading**: Repository metadata readers use `music-metadata` once per file and
derive normalized application data from that parse.

- Rating reader: `packages/rfmedia-cli/src/lib/ratings.ts`
- Extended common-tag reader: `packages/rfmedia-cli/src/lib/metadata.ts`

Both readers currently use `skipCovers: true`, which is appropriate for filtering but cannot satisfy
artwork preservation. A conversion-specific parse, if needed, must make artwork loading an explicit
choice rather than silently reusing the filter-optimized reader.

**Normalize at the format boundary**: Ratings are normalized to `0..1` internally, then converted to
format-native representations only at read or write boundaries.

- Read and normalization: `packages/rfmedia-cli/src/lib/ratings.ts`
- Format-specific write boundary: `packages/rfmedia-cli/src/lib/tag-writer.ts`
- Best-effort orchestration: `packages/rfmedia-cli/src/lib/sync-helper.ts`

`ratings.ts` first uses `music-metadata`'s common rating projection, then falls back to native POPM
for MP3 and case-insensitive Vorbis `RATING` comments for FLAC/OGG/Opus. This is the established
pattern to reuse if conversion needs an explicit cross-format rating mapping. Preserve the POPM
email and counter when available; do not reduce a native rating to only a star number unless the
target format requires that loss.

**Format-specific writer returns a result**: `tag-writer.ts` encapsulates MP3 POPM and FLAC Vorbis
rating writes behind a structured `{ success, message, format? }` result.

- Example: `packages/rfmedia-cli/src/lib/tag-writer.ts`
- Caller example: `packages/rfmedia-cli/src/lib/sync-helper.ts`

This module is useful evidence for rating scale and best-effort conventions, but it is not a
general metadata copier. It only writes ratings, cannot write OGG/Opus or M4A/AAC ratings, and does
not preserve arbitrary tags or artwork. It should not be treated as sufficient for the whole issue.

## Code Conventions

- Use strict TypeScript interfaces and unions; avoid `any`.
- Keep ESM imports with `.js` suffixes in TypeScript source.
- Keep target-format differences in typed declarative records.
- Preserve the existing `convertFile()` library boundary and its action-independent behavior.
- Keep filenames/path handling in `node:path`; pass paths to `spawn()` as independent argv entries
  rather than interpolating a shell command.
- Use `error instanceof Error ? error.message : String(error)` for unknown caught values.
- Keep debug-only process details on `logDebug()` and actionable non-fatal loss on `logWarn()`.
- Preserve the caller's exact abort reason. `convertFile()` checks before directory creation, after
  directory creation, and in process event handlers.
- Bound retained FFmpeg stderr rather than accumulating unbounded output.
- Document thrown errors with JSDoc and keep fields such as source path, destination path, and reason
  on typed errors.
- Original sources are immutable. Conversion writes only to the destination path, as documented in
  `packages/rfmedia-cli/README.md`.

## Error Handling

The repository distinguishes fatal conversion failure from best-effort metadata limitations.

**Fatal conversion failures throw typed errors**:

- `FfmpegNotFoundError` identifies a missing executable.
- `ConversionError` carries `sourcePath`, `destPath`, and an actionable `reason`.
- `packages/rfmedia-cli/src/lib/error-formatters.ts` registers user-facing formatters for both types.

Do not collapse codec failure, invalid input, permission failure, or spawn failure into a warning.
Those cases currently reject the conversion and must remain fatal. Likewise, cancellation must
remain cancellation rather than being wrapped as `ConversionError`.

**Unsupported metadata is best-effort and visible**:

- `packages/rfmedia-cli/src/lib/ratings.ts` and
  `packages/rfmedia-cli/src/lib/metadata.ts` log a warning and return `null` when metadata cannot be
  read.
- `packages/rfmedia-cli/src/lib/tag-writer.ts` returns a failure result for unsupported target
  formats rather than throwing.
- `packages/rfmedia-cli/src/lib/sync-helper.ts` is explicitly designed never to throw for rating
  synchronization; callers can continue while retaining the failure message.

Issue #42 explicitly requires a warning for representational limitations. Follow the latter
best-effort pattern for an individual tag that cannot be expressed in the target container, while
retaining typed failure behavior when the conversion itself fails. Warnings should name the
category or target limitation without logging binary artwork or raw untrusted tag values.

The current conversion path keeps stderr for error reporting but ignores it on successful exit.
If successful FFmpeg output is used to detect dropped metadata, warning extraction needs an explicit
bounded contract; generic stderr noise should not become an unconditional user warning.

## Testing Approach

Tests are co-located Vitest files. The relevant baseline is:

- `packages/rfmedia-cli/src/lib/convert.test.ts`: hoisted mocks for `spawn()` and `ensureDir()`;
  currently covers pre-abort and in-flight abort propagation
- `packages/rfmedia-cli/src/lib/tag-writer.test.ts`: format-specific result and option behavior
- `packages/rfmedia-cli/src/lib/sync-helper.test.ts`: best-effort failure/result behavior
- `packages/rfmedia-cli/src/lib/ratings.test.ts`: table-driven pure rating/filter transformations
- `packages/rfmedia-cli/src/test-utils/mock-lifecycle.ts`: clear call history while preserving
  hoisted mock implementations

Use `vi.hoisted()` for child-process and dependency mocks. In `beforeEach()`, use
`clearMocksPreservingImplementations()` or `vi.clearAllMocks()`, never `vi.resetAllMocks()` for
hoisted defaults.

### Minimal Critical Coverage

Keep the new automated coverage focused on the central contract:

1. Add one table-driven `convert.test.ts` case that captures `spawn("ffmpeg", argv, ...)` for the
   four target formats and proves:
   - source and destination remain separate argv values;
   - global/source metadata mapping is present;
   - audio and optional artwork streams are intentionally mapped;
   - target-specific tag/container flags and codec/bitrate tokens are correct;
   - destination remains the final output argument.
2. Add one success-path child-process case that drives stderr and `close(0)` and proves an
   unsupported-tag signal becomes the required warning without failing conversion. If limitation
   warnings are derived before spawn instead, test that pure decision helper directly.
3. Add a compact rating-translation matrix only if `ratings.ts` gains a new exported or separately
   testable helper. Cover a representative POPM-to-Vorbis and Vorbis-to-POPM mapping, including the
   unrated boundary and preserved POPM identity/counter where the target supports it.
4. Retain the existing two cancellation tests unchanged to guard abort semantics.

Do not duplicate these assertions in album copy, filter copy, sync, Plex copy, playlist, and repair
action suites: all of those callers already delegate to the same conversion seam. Do not add shell
completion tests unless the CLI surface changes; issue #42 does not require a new flag or format.

A mocked argv test is the stable CI contract because the rfmedia workflow does not explicitly
install FFmpeg. A single local/manual conversion fixture can supplement implementation validation
for real tags and artwork, but it should not become a broad environment-dependent Vitest matrix.

### Verification Commands

```bash
npm run test:run -w packages/rfmedia-cli -- src/lib/convert.test.ts src/lib/ratings.test.ts
npm run typecheck -w packages/rfmedia-cli
npm run test:rfmedia
```

The package typecheck also runs Lidarr codegen drift and architecture guards. The repository CI
builds `rf-common` before rfmedia typecheck/tests, so a fresh worktree may need
`npm run build:common` first.

## Patterns to Follow

1. Implement preservation once at `convertFile()` or a focused helper owned by `convert.ts`.
2. Keep format differences declarative and argv tokenization explicit.
3. Reuse the existing normalized rating boundary from `ratings.ts`; do not create a second rating
   scale implementation.
4. Treat `tag-writer.ts` as a narrow rating-writing precedent, not as a general tag copier.
5. Preserve source immutability, typed fatal errors, bounded stderr, and exact cancellation reasons.
6. Warn on genuine target-format loss while allowing a successful audio conversion to complete.
7. Add only central contract tests plus a pure rating matrix if new rating translation exists.
8. Leave commands, action signatures, MCP contracts, and Bash/Zsh/Fish completion templates
   unchanged unless design introduces a new user-facing option.

## Implementation Risks and Gotchas

- `music-metadata` reads metadata but does not provide a general tag-writing API.
- Existing `skipCovers: true` readers deliberately omit artwork.
- `tag-writer.ts` supports only rating writes and has explicit target gaps.
- Arbitrary native tag IDs are container-specific; a "copy all" claim needs explicit evidence for
  what maps, what is preserved verbatim, and what produces a warning.
- Attached artwork is a stream concern as well as a tag concern; copying only global metadata is not
  enough.
- The current preset strings with embedded spaces are not valid direct-`spawn()` tokenization and
  should not be replicated in new options.
- Success and `"warning"` are different from failure. The existing `ConversionResult` has no warning
  field, so the design must choose a visible, stable warning channel without weakening fatal
  conversion errors.
- The same `.m4a` container is used for ALAC and AAC, while MP3 and Opus have different tag/container
  capabilities; target behavior cannot be inferred from extension alone.
