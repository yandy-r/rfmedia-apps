# Tag Preservation During Conversion

Issue #42 belongs in one shared internal conversion transaction, where one cover-aware source
snapshot and typed target policy serve album, filter, sync, Plex, playlist, and verification-repair
callers. Public `convertFile()` delegates without an extra validator; converted verify repairs
delegate with their tier validator so metadata and tier checks share one stage, while non-converted
repairs keep their outer stage. Encoding, MP3 POPM, semantic audit, optional tier validation,
publish-mode restoration, and publication run inside that one validated transaction. The stage
stays `0600`; publication preserves an existing regular destination mode or uses
`0o666 & ~process.umask()` for a new file. Typed warnings stop at `ConversionResult` and human
logging; no CLI, config, database, machine/MCP schema, or completion change is needed.

## Relevant Files

- `packages/rfmedia-cli/src/lib/convert.ts`: Central conversion lifecycle, target presets, process, and result seam.
- `packages/rfmedia-cli/src/lib/convert.test.ts`: Existing abort tests and target-policy test home.
- `packages/rfmedia-cli/src/lib/filesystem.ts`: Private validated stage, optional last-moment publish mode, and atomic publication.
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`: Identity, cleanup, abort, commit, and minimal publish-mode coverage.
- `packages/rfmedia-cli/src/lib/ratings.ts`: Shared rating parsing and normalization boundary.
- `packages/rfmedia-cli/src/lib/ratings.test.ts`: Native rating-scale regression coverage.
- `packages/rfmedia-cli/src/lib/metadata.ts`: Duplicated common-first rating extraction to remove.
- `packages/rfmedia-cli/src/lib/tag-writer.ts`: Existing MP3 POPM update seam.
- `packages/rfmedia-cli/src/lib/tag-writer.test.ts`: MP3 preservation and writer-failure contracts.
- `packages/rfmedia-cli/src/types/options.ts`: Stable four-format `ConvertFormat` union.
- `packages/rfmedia-cli/src/actions/copy-filter.ts`: Unchanged first-copy reuse integration reference.
- `packages/rfmedia-cli/src/actions/plex-playlist.ts`: Unchanged post-conversion Plex override reference.
- `packages/rfmedia-cli/src/actions/verify-album.ts`: Converted branch supplies its tier validator; non-converted repair keeps the outer helper.
- `packages/rfmedia-cli/src/actions/verify-album.test.ts`: Focused one-stage converted and unchanged non-converted repair coverage.
- `packages/rfmedia-cli/src/actions/verify-filter.ts`: Converted branch supplies its tier validator; non-converted repair keeps the outer helper.
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts`: Focused one-stage converted and unchanged non-converted repair coverage.
- `packages/rf-common/src/logger.ts`: Existing human warning renderer used after successful audit.
- `packages/rfmedia-cli/package.json`: Direct metadata-parser dependency declaration.
- `package-lock.json`: Reviewed parser and `file-type` dependency resolution.
- `ROADMAP.md`: Live issue status and delivery closeout source.

## Relevant Patterns

**Central Conversion Seam**: Cross-cutting preservation belongs in one action-independent lifecycle.
See
[`packages/rfmedia-cli/src/lib/convert.ts`](../../../packages/rfmedia-cli/src/lib/convert.ts).

**Typed Target Policy**: Keep codec, muxer, mapping, rating, artwork, and audit capabilities
exhaustive by `ConvertFormat`. See
[`packages/rfmedia-cli/src/types/options.ts`](../../../packages/rfmedia-cli/src/types/options.ts)
and
[`packages/rfmedia-cli/src/lib/convert.ts`](../../../packages/rfmedia-cli/src/lib/convert.ts).

**Validated Atomic Stage**: Materialize, fsync, validate, recheck identities, and rename only the
complete tagged artifact. See
[`packages/rfmedia-cli/src/lib/filesystem.ts`](../../../packages/rfmedia-cli/src/lib/filesystem.ts).

**Single Verify Transaction**: Never nest conversion staging inside verify staging. The internal
conversion transaction accepts an optional validator over its stage; public `convertFile()` passes
none, converted verify branches pass `verifyFileByTier()`, and non-converted repairs retain the
outer helper. The callback never receives a materializer or publisher. See
[`packages/rfmedia-cli/src/actions/verify-album.ts`](../../../packages/rfmedia-cli/src/actions/verify-album.ts)
and
[`packages/rfmedia-cli/src/actions/verify-filter.ts`](../../../packages/rfmedia-cli/src/actions/verify-filter.ts).

**Private Stage, Compatible Publication Mode**: `ValidatedStageOptions.publishMode` is optional and
does not change existing callers. Conversion preserves the mode of an existing regular destination
or uses `0o666 & ~process.umask()` for a new output. The helper keeps the stage `0600`, then applies
and fsyncs the requested mode at the last safe pre-rename point, rechecks signal/inode, and renames.
The empirical probe with umask `077` produced `0600` for a new FFmpeg output and retained `0660`
when replacing an existing `0660` file.

**Native-First Rating Boundary**: Normalize POPM and Vorbis semantics once before target-specific
encoding. See
[`packages/rfmedia-cli/src/lib/ratings.ts`](../../../packages/rfmedia-cli/src/lib/ratings.ts).

**Narrow Format Writer**: Reuse MP3 POPM updates without turning the rating writer into a universal
tag framework. See
[`packages/rfmedia-cli/src/lib/tag-writer.ts`](../../../packages/rfmedia-cli/src/lib/tag-writer.ts).

**Scoped Warning Surface**: Return stable safe warnings from conversion and emit human text only
after successful audit; defer machine and MCP schemas. See
[`packages/rfmedia-cli/src/lib/convert.ts`](../../../packages/rfmedia-cli/src/lib/convert.ts) and
[`packages/rf-common/src/logger.ts`](../../../packages/rf-common/src/logger.ts).

**Finalize Before Reuse or Override**: First-copy derivatives inherit audited tags, while optional
Plex rating sync remains the deliberate final authority. See
[`packages/rfmedia-cli/src/actions/copy-filter.ts`](../../../packages/rfmedia-cli/src/actions/copy-filter.ts)
and
[`packages/rfmedia-cli/src/actions/plex-playlist.ts`](../../../packages/rfmedia-cli/src/actions/plex-playlist.ts).

**Risk-Owned Tests**: Test metadata policy once, add only the shared helper's mode contract and the
two verify transaction-wiring cases, and avoid a seven-caller format matrix. See
[`packages/rfmedia-cli/src/lib/filesystem.test.ts`](../../../packages/rfmedia-cli/src/lib/filesystem.test.ts)
and
[`packages/rfmedia-cli/src/test-utils/mock-lifecycle.ts`](../../../packages/rfmedia-cli/src/test-utils/mock-lifecycle.ts).

## Relevant Tables

| Integration point                 | Resolved contract                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Ordinary conversion               | Public `convertFile()` delegates to the internal transaction without another validator                                |
| Converted verify repair           | Internal transaction owns one stage and invokes the supplied tier validator after metadata audit                      |
| Non-converted verify repair       | Existing outer `replaceFileWithValidatedStage()` transaction remains                                                  |
| New destination mode              | Conversion requests `0o666 & ~process.umask()`                                                                        |
| Existing regular destination mode | Conversion preserves its current permission bits                                                                      |
| Stage privacy                     | Materialization and all validation remain `0600`; requested mode is applied/fsynced immediately before recheck/rename |

## Relevant Docs

**`docs/plans/42-tag-preservation/research-recommendations.md`**: You _must_ read this first for the
authoritative conflict resolutions, exact file scope, and deferred machine/MCP warning propagation.

**`docs/plans/42-tag-preservation/research-technical.md`**: You _must_ read this for target mappings,
audit semantics, resource caps, lifecycle, and verification gates.

**`docs/plans/42-tag-preservation/research-security.md`**: You _must_ read this for dependency hard
stops, private sidecars, path identity, cancellation, and safe diagnostics.

**`docs/plans/42-tag-preservation/research-practices.md`**: You _must_ read this for modularity,
Opus artwork, dependency, and minimal-test guidance, subject to the final warning-scope resolution.

**`packages/rfmedia-cli/docs/features/audio-conversion.doc.md`**: You _must_ read this when changing
conversion flow, first-copy reuse, embedded artwork, or target compatibility.

**`packages/rfmedia-cli/docs/features/plex-metadata-sync.md`**: You _must_ read this when preserving
the post-conversion Plex rating override.

**`packages/rfmedia-cli/docs/testing/troubleshooting.md`**: You _must_ read this before adding
child-process, filesystem, parser, or writer tests.

**`packages/rfmedia-cli/README.md`**: You _must_ read this before documenting preservation,
destination limitations, rating behavior, or verification.

**`packages/rfmedia-cli/CLAUDE.md`**: You _must_ read this before changing package architecture,
strict TypeScript, logging, errors, tests, or documentation.

**`CLAUDE.md`**: You _must_ read this for repository-wide architecture, validation, and Markdown
requirements.

**`.github/pull_request_template.md`**: You _must_ read this before delivery so exact verification,
risk, rollback, and issue closure evidence is retained.

**`ROADMAP.md`**: You _must_ read this before changing issue #42 status or final live counts.
