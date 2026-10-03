# Documentation Research: Tag Preservation During Conversion

## Architecture Docs

### Required

- [`packages/rfmedia-cli/docs/features/audio-conversion.doc.md`](../../../packages/rfmedia-cli/docs/features/audio-conversion.doc.md)
  is the authoritative feature guide for the existing conversion pipeline. It documents the direct
  FFmpeg invocation, first-copy conversion optimization, non-audio sidecar handling, verification
  extension mapping, errors, and dry-run behavior. The implementation should update this guide with:
  - the source-to-destination metadata flow;
  - the tags guaranteed by the feature: artist, album, title, track number, year, genre, rating, and
    embedded artwork;
  - how unsupported or lossy mappings are reported;
  - the distinction between embedded artwork and separately copied artwork files;
  - the interaction with first-copy conversion and later copies;
  - the supported target-format limitations.
- [`packages/rfmedia-cli/CLAUDE.md`](../../../packages/rfmedia-cli/CLAUDE.md) is the package-level
  engineering contract. Its architecture, conversion, rating-detection, error-handling, logging, and
  testing sections are required reading before implementation. Update it only if the work changes a
  durable developer-facing module responsibility or convention; do not duplicate user documentation
  there.
- [`docs/plans/42-tag-preservation/research-architecture.md`](research-architecture.md) is the
  issue-specific architecture analysis. It establishes the current conversion and rating boundaries
  and should guide the plan, but it is a planning artifact rather than shipped user documentation.

### Nice to Have

- [`docs/architecture/data-flow.md`](../../architecture/data-flow.md) describes the complete
  `rfmedia copy` flow, error propagation, and JSON output. It is useful for confirming where
  conversion warnings surface. It needs an update only if the feature materially changes the
  cross-layer copy flow.
- [`docs/architecture/overview.md`](../../architecture/overview.md) describes the commands, actions,
  and library separation. It provides general orientation but should not need a feature-specific
  update.

## API Docs

There is no public HTTP API or database schema involved. The relevant APIs are the media tooling and
tag-library contracts.

### Required External References

- [FFmpeg documentation](https://ffmpeg.org/ffmpeg.html) is the authoritative reference for stream
  selection, `-map`, `-map_metadata`, attached-picture streams, and output dispositions. The plan
  must not assume that automatic stream selection preserves artwork or every metadata category.
- [FFmpeg format and metadata documentation](https://ffmpeg.org/ffmpeg-formats.html#Metadata) is the
  reference for muxer-specific metadata behavior. Destination capabilities must be verified per
  container rather than inferred from a single format.
- [`music-metadata` documentation](https://github.com/Borewit/music-metadata) defines the existing
  parser's `common` and `native` metadata, cover-art parsing, and `skipCovers` option. This is required
  reading if implementation reads source tags before or after conversion.

### Conditional External References

- [`node-id3` documentation](https://github.com/Zazama/node-id3) is required if the implementation
  explicitly rewrites MP3 tags. Its update-versus-write behavior matters because a full write can
  replace existing tags, while the feature contract requires preservation.
- [`flac-metadata` documentation](https://github.com/claus/flac-metadata) is required if the
  implementation explicitly rewrites FLAC Vorbis-comment or picture blocks.
- [Vitest mocking documentation](https://vitest.dev/guide/mocking.html) is a supporting reference for
  process and filesystem mocks, but the repository's testing guide takes precedence for local
  conventions.

## Development Guides

### Required

- The root [`CLAUDE.md`](../../../CLAUDE.md) defines the commands/actions/library separation, ESM
  import style, strict typing, fail-fast errors, validation expectations, and Markdown rules.
- [`packages/rfmedia-cli/docs/testing/troubleshooting.md`](../../../packages/rfmedia-cli/docs/testing/troubleshooting.md)
  defines the package's Vitest conventions. In particular, preserve mock implementations with
  `vi.clearAllMocks()`, use `vi.hoisted()` when necessary, and prefer shared helpers under
  `src/test-utils`.
- [`packages/rfmedia-cli/src/lib/convert.test.ts`](../../../packages/rfmedia-cli/src/lib/convert.test.ts)
  is the current conversion test boundary. It primarily covers cancellation and spawned-process
  behavior, so the feature needs focused metadata-preservation and warning coverage rather than only
  extending signal tests.
- [`packages/rfmedia-cli/src/lib/tag-writer.test.ts`](../../../packages/rfmedia-cli/src/lib/tag-writer.test.ts)
  captures current format-specific rating-writing behavior and unsupported-format expectations. New
  tests should remain consistent with those contracts where the feature reuses the writer.
- [`.github/pull_request_template.md`](../../../.github/pull_request_template.md) is required for
  delivery. The pull request must preserve every template section and list exact targeted and
  package-level verification commands with pass/fail outcomes.

### Documentation and Validation Conventions

- Format changed Markdown with the root Prettier configuration and check it with
  `npx prettier --check <paths>` or the corresponding root format script.
- Run Markdown lint for changed documentation with `npm run lint:md`.
- Do not copy stale test counts from historical documents. Record current commands and outcomes.
- A conversion-internal behavior change does not require Bash, Zsh, or Fish completion updates.
  Audit all three templates only if implementation introduces or changes a CLI flag, argument, or
  completion-visible format.

## README Files

### Required

- [`packages/rfmedia-cli/README.md`](../../../packages/rfmedia-cli/README.md) is the public
  package-level reference. Update its **Audio Conversion** section with the preservation guarantee,
  supported tag set, embedded-artwork behavior, and destination-format warnings. If the final
  implementation changes rating behavior, also reconcile:
  - **Plex Rating Sync**, which describes optional file-rating synchronization;
  - **Rating Format Compatibility**, which describes MP3, FLAC/Vorbis, and M4A/AAC support;
  - the conversion and verification notes that explain converted output hashing.
- [`packages/rfmedia-cli/docs/features/plex-metadata-sync.md`](../../../packages/rfmedia-cli/docs/features/plex-metadata-sync.md)
  is the supporting user guide for rating writes. Its sync-on-copy section says rating updates target
  the converted file. Update it only if the feature changes that precedence or its documented format
  limitations. General source-tag preservation and an explicit Plex rating override must remain
  conceptually distinct.

### No Expected Change

- The root [`README.md`](../../../README.md) is a monorepo and self-hosting-platform overview. The
  issue does not change its user-facing command summary, so a tag-preservation section there would
  duplicate package documentation.

## Issue and Roadmap Sources

### Authoritative Sources

- [GitHub issue #42](https://github.com/yandy-r/rfmedia-apps/issues/42) is the authoritative feature
  contract. It requires preservation of artist, album, title, track number, year, genre, rating, and
  artwork, with warnings for destination-format limitations.
- [`ROADMAP.md`](../../../ROADMAP.md) currently places issue #42 first in the parallel `rfmedia`
  medium-priority track and defines the exit condition as conversion preserving tags. Update the
  roadmap's live counts/status when the issue is completed, following the repository's normal
  closeout workflow.

### Historical Provenance

`packages/rfmedia-cli/TODO.md` no longer exists. Git history shows it was removed in commit
`8060c9da` (`docs: remove redundant and obsolete documentation files`) after issue tracking moved to
GitHub. The deleted section 2.3 contains the origin of the current issue and the same preservation
list, but its link points to the obsolete `rfamily-apps` repository name. Treat that content as
provenance only:

- do not restore the package TODO;
- do not use the historical URL;
- resolve scope questions against the live issue and current code;
- update the live ROADMAP and GitHub issue state after delivery.

## Must-Read Documents

Read these in order before finalizing the implementation plan:

1. [GitHub issue #42](https://github.com/yandy-r/rfmedia-apps/issues/42) — acceptance scope.
2. [`research-architecture.md`](research-architecture.md) — current boundaries and change surface.
3. [`audio-conversion.doc.md`](../../../packages/rfmedia-cli/docs/features/audio-conversion.doc.md) —
   existing conversion contract.
4. [`packages/rfmedia-cli/CLAUDE.md`](../../../packages/rfmedia-cli/CLAUDE.md) — package architecture
   and testing rules.
5. [`packages/rfmedia-cli/README.md`](../../../packages/rfmedia-cli/README.md) — public conversion,
   rating, and verification behavior.
6. [`plex-metadata-sync.md`](../../../packages/rfmedia-cli/docs/features/plex-metadata-sync.md) —
   existing rating-write and sync-on-copy boundary.
7. [`testing/troubleshooting.md`](../../../packages/rfmedia-cli/docs/testing/troubleshooting.md) and
   the current conversion/tag-writer tests — test implementation conventions.
8. The official FFmpeg and `music-metadata` references above — actual stream, metadata, and artwork
   capabilities.

## Documentation Gaps

1. **No metadata compatibility matrix.** Existing docs list output codecs but do not say which tag
   fields and artwork forms can be represented in each destination container. The implementation
   plan needs a tested matrix, and the audio-conversion guide should publish the user-relevant
   result.
2. **No explicit preservation contract.** The audio-conversion guide and README do not state whether
   tags survive conversion. They need a concise guarantee bounded by tested fields and target
   limitations.
3. **Embedded and sidecar artwork are conflated.** Current copy documentation covers non-audio files
   such as `cover.jpg`, while issue #42 also requires embedded artwork. Documentation must distinguish
   copying a sidecar file from mapping or rewriting an embedded picture.
4. **Warning behavior is unspecified.** The issue requires warnings when tags cannot be preserved,
   but current docs do not define warning granularity, destination-path context, stderr behavior, or
   structured-output representation. The plan must settle this using existing logger and JSON-output
   conventions before documentation is written.
5. **Rating precedence is unclear.** Source tag preservation and optional Plex sync-on-copy can both
   affect the destination rating. The final contract must say whether preserved source ratings are
   retained or intentionally replaced when Plex rating synchronization is enabled.
6. **Native/custom tag scope is ambiguous.** The issue says both “all metadata tags” and names a
   finite required set. The plan should define the named fields as the acceptance baseline and state
   what happens to unrecognized/native tags; documentation should not promise lossless preservation
   of arbitrary fields without format-pair tests.
7. **No documented regression fixture strategy.** Current conversion tests do not establish a
   source/target tag matrix. Tests should use small deterministic fixtures or generated media and
   assert values by reparsing output; documentation need only describe the resulting support matrix,
   not the fixture mechanics.
8. **Historical TODO is intentionally absent.** Any implementation notes that remain useful belong in
   the live issue, plan artifacts, feature guide, or README—not a recreated TODO.
