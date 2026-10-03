# Feature Spec: Tag Preservation During Conversion

## Executive Summary

Issue #42 will make every existing audio conversion preserve portable source metadata through the
shared conversion transaction. It snapshots bounded metadata, encodes to one private validated
stage, applies target-specific rating/artwork handling, runs metadata plus optional verify-tier
validation, restores direct-FFmpeg publication mode, and publishes atomically. MP3 and Opus preserve
ratings, every target preserves one primary cover, and genuine container limitations produce safe
warnings. The change adds no CLI, configuration, database, completion, action-result, or MCP
surface.

## External Dependencies

### APIs and Services

The feature is local and file-based. It adds no HTTP API, authentication, network request, paid
service, persisted secret, or metadata URL fetch. FFmpeg remains a locally installed process
dependency.

### Libraries

| Dependency             | Required state                     | Purpose and constraint                                                                                             |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `music-metadata`       | Raise to `^11.14.0`                | Parse one cover-aware source snapshot and one staged-output audit. The upgrade is a shipment blocker.              |
| `file-type`            | Resolve transitively to `>=21.3.4` | Clear the vulnerable parser chain and verify the lockfile.                                                         |
| FFmpeg                 | Existing system dependency         | Encode four existing targets with tokenized argv, `shell: false`, `-nostdin`, bounded stderr, and explicit muxers. |
| `node-id3` `0.2.9`     | Reuse                              | Write MP3 POPM to the private stage before audit.                                                                  |
| Node `fs` and `crypto` | Reuse                              | Create/sync private files and calculate SHA-256 artwork digests.                                                   |

No universal tag writer, FFmpeg wrapper, artwork package, or output framework is added. Review the
focused lockfile diff, run `npm ls music-metadata file-type`, and run the production audit. The
conversion chain must clear
[GHSA-v6c2-xwv6-8xf7](https://github.com/advisories/GHSA-v6c2-xwv6-8xf7),
[GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473), and
[GHSA-j47w-4g3g-c36v](https://github.com/advisories/GHSA-j47w-4g3g-c36v).

Authoritative format references are the
[FFmpeg metadata documentation](https://ffmpeg.org/ffmpeg-formats.html#Metadata-1),
[FFmpeg stream-selection documentation](https://ffmpeg.org/ffmpeg.html#Stream-selection),
[music-metadata documentation](https://github.com/Borewit/music-metadata), and
[Xiph picture-block specification](https://xiph.org/flac/format.html#metadata_block_picture).

## Business Requirements

### User Stories

1. An operator converting tagged music retains artist, album, title, track, date/year, genre,
   rating, compatible custom text, and primary artwork wherever the target supports them.
2. An operator choosing a target with a genuine limitation receives a precise warning and a usable
   output.
3. Automation retains parseable stdout because human warnings use stderr.
4. Failure or cancellation preserves the source and existing destination and leaves no private
   artifact.
5. Plex workflows preserve source metadata before an explicitly requested later Plex rating
   override.

### Business Rules

| ID    | Rule                                                                                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BR-01 | Implement one internal conversion transaction. Public `convertFile()` delegates without another validator; converted verify repairs delegate with their tier validator. |
| BR-02 | Snapshot before encoding; never mutate the source.                                                                                                                      |
| BR-03 | Preserve canonical artist, album, title, track number/total, date/year, and genre when policy-supported.                                                                |
| BR-04 | Preserve compatible arbitrary text exactly for MP3 and Opus; normalize only canonical semantics.                                                                        |
| BR-05 | Read ratings native-first: MP3 POPM, then FLAC/Ogg/Opus Vorbis `RATING`, then compatible common fallback.                                                               |
| BR-06 | Write ratings as MP3 POPM or Opus `RATING`; warn for a rated AAC/ALAC M4A source.                                                                                       |
| BR-07 | Preserve one deterministic primary/front cover for every target. Missing primary Opus art is fatal, not a warning.                                                      |
| BR-08 | Additional pictures and incompatible structured, binary, native, rating, or custom fields produce deterministic warnings only when output is otherwise valid.           |
| BR-09 | Parse, supported write, audit, process, cleanup, cancellation, and publication failures are fatal and never publish the stage.                                          |
| BR-10 | Resolve only after metadata finalization and atomic publication, so history, hashing, plugins, and reused copies observe final bytes.                                   |
| BR-11 | Optional Plex rating sync stays after conversion as the intentional later authority.                                                                                    |
| BR-12 | Dry run and first-conversion then copy/hardlink reuse remain unchanged.                                                                                                 |
| BR-13 | Warning-only completion succeeds and exits zero; warnings never contain raw values, artwork, POPM data, or raw stderr.                                                  |
| BR-14 | Add warnings only to `ConversionResult` and human logging. Action/MCP results, commands, flags, configs, databases, and completions do not change.                      |
| BR-15 | Never nest validated stages. Converted verify repairs use the conversion-owned stage; non-converted repairs retain their outer helper.                                  |
| BR-16 | Match direct FFmpeg mode semantics: preserve an existing regular destination's mode or use `0o666 & ~process.umask()` for a new output.                                 |

### Target Matrix

| Target   | Canonical text        | Custom text     | Rating              | Primary artwork          | Warnings                                                 |
| -------- | --------------------- | --------------- | ------------------- | ------------------------ | -------------------------------------------------------- |
| MP3      | ID3, audited          | TXXX, audited   | POPM post-write     | APIC stream copy         | Extra pictures and incompatible structured/binary fields |
| AAC/M4A  | Standard iTunes atoms | Unsupported     | Unsupported         | `covr` stream copy       | Rating, custom/native limits, extra pictures             |
| ALAC/M4A | Standard iTunes atoms | Unsupported     | Unsupported         | `covr` stream copy       | Rating, custom/native limits, extra pictures             |
| Opus     | Vorbis comments       | Vorbis, audited | Normalized `RATING` | `METADATA_BLOCK_PICTURE` | Extra pictures and incompatible structured/binary fields |

Do not enable MOV `use_metadata_tags`; research showed it compromises standard-field visibility and
cover preservation.

### Edge Cases and Success Criteria

- Native Vorbis `RATING=0.80` wins over a common `0.008` projection and normalizes to `0.8`.
- Track number and total are preserved independently; artists and genres compare as stable
  multisets; full date is required only where both sides support it.
- Multiple POPM entries use the existing deterministic selection and retain the selected
  email/counter for MP3.
- Multiple pictures preserve the primary image and produce one deduplicated additional-art warning.
- A tagless source produces no fabricated metadata or false warning.
- Bounds violations fail before writing; an existing destination remains unchanged until commit.
- Cancellation races settle once with the exact `signal.reason` and clean every private artifact.
- A supported-field loss, including primary art, fails before publication.
- Converted verify repairs run metadata audit and tier validation on the same stage before one
  publication; non-converted repairs retain their current staged-copy flow.
- The stage stays `0600` through materialization and audit. With umask `077`, a new output publishes
  `0600`, while replacing an existing regular destination at `0660` preserves `0660`, matching the
  direct-FFmpeg probe.
- Representative ID3, Vorbis/FLAC, and MP4 sources preserve policy-supported data across all four
  targets; every primary picture has the same SHA-256 bytes.
- Warning-only results have `success: true`, sorted `ConversionResult.warnings`, readable stderr,
  and intact stdout.
- The parser chain is patched; focused/full tests, typecheck, formatting, Markdown lint, dependency
  checks, and deliberate real FFmpeg probes pass.

## Technical Specifications

### Architecture

```text
ordinary callers -> public convertFile()
converted verify -> internal conversion + tier validator
  -> one snapshot + target policy
  -> optional private Opus sidecar
  -> one validated sibling stage
  -> FFmpeg -> MP3 POPM -> metadata audit
  -> optional verify-tier validator
  -> publish mode -> fsync -> identity recheck -> rename
  -> ConversionResult + human warnings
  -> history/hash and Plex override
```

`convert.ts` remains the sole conversion process/transaction owner. New `conversion-metadata.ts`
owns only bounded projection, target policy, Opus serialization/sidecar, warnings, and audit.
Verify actions may supply a validator callback but never receive a raw materializer.

### Data Models

Do not extend filter-oriented `ExtendedMetadata`.

```ts
interface ConversionMetadataSnapshot {
  readonly sourceTagFamilies: readonly string[];
  readonly canonical: {
    readonly title?: string;
    readonly artists: readonly string[];
    readonly album?: string;
    readonly track: { readonly no?: number; readonly of?: number };
    readonly year?: number;
    readonly date?: string;
    readonly genres: readonly string[];
  };
  readonly textTags: readonly ConversionTextTag[];
  readonly rating: NormalizedRating | null;
  readonly pictureCount: number;
  readonly pictures: readonly ConversionPicture[];
  readonly unsupportedNativeFields: readonly string[];
}

interface ConversionTargetPolicy {
  readonly format: ConvertFormat;
  readonly container: "mp3" | "m4a" | "opus";
  readonly muxer: "mp3" | "ipod" | "opus";
  readonly audioArgs: readonly string[];
  readonly artworkMode: "attached-picture-copy" | "vorbis-picture-comment";
  readonly ratingMode: "popm-postwrite" | "vorbis-comment" | "unsupported";
  readonly customTextMode: "mapped-and-audited" | "unsupported";
}
```

Warnings are additive only to the direct conversion result:

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

`ConversionResult` adds required `warnings: readonly ConversionWarning[]`. Sort by source,
destination, code, safe field name, and reason; deduplicate the same conversion/reason.

### Bounds

| Resource                 | Limit     |
| ------------------------ | --------- |
| Pictures inspected       | 16        |
| Selected primary picture | 16 MiB    |
| Aggregate picture bytes  | 32 MiB    |
| Complete Opus sidecar    | 24 MiB    |
| Text tags                | 4,096     |
| UTF-8 key                | 255 bytes |
| Individual text value    | 1 MiB     |
| Aggregate text           | 8 MiB     |

Reject NUL and binary/object coercion. Validate keys and escape serialization controls.

### API Design and Transaction

Keep the current `convertFile(source, dest, format, onProgress?, signal?)` signature. It delegates
to one internal `convertFileWithValidation()` transaction without an additional validator.
Converted branches in `verify-album.ts` and `verify-filter.ts` call that transaction with a callback
that runs their existing `verifyFileByTier()` contract on the conversion stage. The callback
receives only the staged path and transaction signal; it cannot materialize or publish. Non-
converted verify repairs retain their outer `replaceFileWithValidatedStage()` flow.

Add internal `readConversionMetadata()`, `getConversionTargetPolicy()`,
`getConversionLimitations()`, `createOpusMetadataSidecar()`, and
`auditConvertedMetadata()` data-in/data-out functions.

`ratings.ts` exports one `extractNormalizedRating(parsed, filePath)` helper used by
`readRating()`, `readRatingAndFormat()`, `metadata.ts`, and conversion. It selects MP3 POPM or
case-insensitive FLAC/Ogg/Opus Vorbis `RATING` before the common fallback. `tag-writer.ts` adds only
optional `popmCounter`.

The transaction:

1. checks cancellation before parse or directory creation;
2. parses the source once with covers and builds the bounded snapshot;
3. selects policy and computes safe known limitations;
4. creates/closes the private Opus sidecar when required;
5. enters `replaceFileWithValidatedStage()`;
6. spawns FFmpeg against the stage with tokenized argv, `shell: false`, `-nostdin`, bounded stderr,
   and one settle-once lifecycle;
7. applies MP3 POPM after FFmpeg;
8. reparses and semantically audits the stage;
9. invokes the optional verify-tier validator on that same stage;
10. applies the computed publish mode at the final safe pre-rename point and fsyncs it;
11. rechecks cancellation and stage identity, then atomically renames once;
12. disposes the exact Opus sidecar in outer `finally`; and
13. logs warnings only after both validators, progress teardown, and publication succeed.

### FFmpeg Policies

Every target maps `0:a:0`, global metadata, an explicit muxer, and the private stage as the final
argument. MP3 uses `libmp3lame`, separate `-b:a`, `320k`, optional `0:v:0?`, `-c:v copy`,
`attached_pic`, and `-f mp3`. AAC uses the same artwork mapping with `aac`, `256k`, and `-f ipod`;
ALAC substitutes `alac` and omits bitrate. All option/value pairs are separate tokens.

Opus always uses a second private FFmetadata input and no video map:

```text
-nostdin
-i <source>
-f ffmetadata
-i <private-sidecar>
-map 0:a:0
-map_metadata 0:g
-map_metadata:s:a 1:g
-c:a libopus
-b:a 128k
-f opus
-y <private-stage>
```

### Opus Artwork and Audit

Build the primary picture as a standard FLAC block: unsigned 32-bit big-endian type, MIME,
description, dimensions/depth/colors, length, and bytes. Use type `3`, known dimensions when
available, and zero otherwise. Base64 it as `METADATA_BLOCK_PICTURE`; add normalized `RATING`;
prefix `;FFMETADATA1`; escape backslash, CR/LF, `=`, `;`, and `#`; reject NUL.

Create the unpredictable sibling sidecar with `open(path, "wx", 0o600)`, then write, sync, close,
pass only its path, and unlink that exact path on every outcome. Reparse staged Opus and require the
rating and primary-image digest before commit. A real fixture must prove source canonical/custom
comments coexist with sidecar overrides.

The audit normalizes strings to NFC without lowercasing values; compares scalar title/album, artist
and genre multisets, track number/total, supported date/year, MP3 rating within `1 / 255`, Opus
rating within emitted precision, compatible custom-text key/value multisets, and primary-art SHA-256.
Ignore encoder/vendor fields and native frame identifiers. Supported mismatch is fatal; a
policy-declared limitation returns its exact warning.

### Atomicity and Cancellation

Reuse `replaceFileWithValidatedStage()` from `lib/filesystem.ts`: exclusive same-directory `0600`
stage, regular-file/inode/parent/destination checks, validation, sync, atomic rename, and cleanup.
Extend `ValidatedStageOptions` with optional `publishMode`; omitted means exact current behavior.
Conversion computes it before staging: preserve permission bits from an existing regular
destination, otherwise use `0o666 & ~process.umask()`. The stage remains `0600` through encoding
and both validators. At the last safe pre-rename point, the helper applies the requested mode,
fsyncs, rechecks signal and inode, then renames atomically.

The empirical probe is binding: with umask `077`, direct FFmpeg created a new `0600` file but
retained `0660` when replacing an existing `0660` destination. A fixed-`0600` publication would
regress replacement mode. Never weaken identity checks; confirm `NodeID3.update()` retains the
expected inode. Check cancellation after both validators and mode application as well as existing
phase boundaries. Preserve the exact caller reason and settle child events once.

### Exact File Scope

Create:

- `packages/rfmedia-cli/src/lib/conversion-metadata.ts`
- `packages/rfmedia-cli/src/lib/conversion-metadata.test.ts`

Modify:

- `packages/rfmedia-cli/package.json` and `package-lock.json`
- `packages/rfmedia-cli/src/lib/convert.ts` and `convert.test.ts`
- `packages/rfmedia-cli/src/lib/filesystem.ts` and `filesystem.test.ts`
- `packages/rfmedia-cli/src/lib/ratings.ts` and `ratings.test.ts`
- `packages/rfmedia-cli/src/lib/metadata.ts`
- `packages/rfmedia-cli/src/lib/tag-writer.ts` and `tag-writer.test.ts`
- `packages/rfmedia-cli/src/actions/verify-album.ts` and `verify-album.test.ts`
- `packages/rfmedia-cli/src/actions/verify-filter.ts` and `verify-filter.test.ts`
- `packages/rfmedia-cli/docs/features/audio-conversion.doc.md`
- `packages/rfmedia-cli/docs/features/plex-metadata-sync.md`
- `packages/rfmedia-cli/README.md`
- `ROADMAP.md` at delivery closeout

Other actions, result envelopes beyond `ConversionResult`, commands, options, MCP schemas,
configuration, database code, root README, and Bash/Zsh/Fish completions remain unchanged. The two
verify action changes are narrow transaction wiring only.

### Critical Tests Only

1. One `conversion-metadata.test.ts` table proves policies, deterministic warnings, exact tiny FLAC
   block/base64, escaping/NUL/bounds, rating/art audits, and one supported-field failure.
2. One four-target `convert.test.ts` argv table proves separate tokens, mappings, explicit muxers,
   private output, settle-once, existing abort semantics, rollback, publication ordering, and
   sidecar cleanup.
3. `ratings.test.ts` proves native `0.80` over common `0.008`, distinct scale/error branches,
   fallback, and POPM identity/counter.
4. `tag-writer.test.ts` adds one POPM provenance and `preserveTags: true` assertion.
5. `filesystem.test.ts` minimally proves optional `publishMode`: omission is unchanged; a requested
   mode is applied and fsynced before rename; abort/identity failure after mode change cannot
   publish.
6. Verify action tests prove one converted repair shares the conversion stage for metadata and tier
   validation, while a non-converted repair retains its outer helper.
7. Deliberate local/provisioned fixtures cover all four targets, reparse output, and record the
   installed FFmpeg version and matrix.

Do not duplicate the target matrix across caller suites, add unrelated action/MCP/completion/
database tests, remove distinct parameterized coverage, snapshot raw data/stderr, or make normal
Vitest depend on an unprovisioned FFmpeg.

## UX Considerations

### User Workflows

Existing commands work unchanged and preservation is automatic. Full success stays quiet. A usable
conversion with a genuine limitation prints one sorted warning per conversion/reason after progress
stops and, for verify repair, only after tier validation, publication, and required cleanup succeed.
Fatal metadata, tier, process, cleanup, or publication errors use the existing failure path and
never expose partial output.

```text
[WARN] Metadata preservation [rating_unsupported] track.flac -> track.m4a (aac): rating cannot be represented by the standard M4A mapping; converted output is usable
```

Use stderr through the existing logger, include literal `[WARN]` rather than color alone, sanitize
controls/ANSI and paths, and show only stable code, target, safe fields, reason, and usable status.

The logger already suppresses diagnostics in JSON, YAML, and CSV modes, preserving stdout. This
issue intentionally stops at `ConversionResult.warnings`; coordinated action/MCP machine-schema
propagation is deferred. Progress treats the file as incomplete until audit/publication finishes,
and cancellation retains the caller reason.

Documentation must publish the target matrix, one embedded primary-cover guarantee, warning-versus-
failure boundary, bounds, and later Plex rating authority.

## Recommendations

### Implementation Approach

Keep `convert.ts` as lifecycle owner and use one focused metadata module with an exhaustive
`Record<ConvertFormat, ConversionTargetPolicy>`. Reuse rating semantics, MP3 writer, validated
stage, logger, and first-copy optimization. Keep projection, warnings, framing/escaping, and audit
pure. Give verify repairs one narrow additional-validator seam and the stage helper one optional
publish-mode control; do not add a raw materializer, registry, provider framework, broad writer,
event bus, or generic audit system.

### Technology Decisions

| Concern         | Decision                                                                     |
| --------------- | ---------------------------------------------------------------------------- |
| Integration     | One internal transaction; public delegate and optional verify-tier validator |
| Parser          | Patched `music-metadata ^11.14.0` chain                                      |
| Ratings         | Native-first; MP3 writer and Opus comment                                    |
| Artwork         | Explicit MP3/M4A copy; required Opus picture comment                         |
| M4A             | Standard atoms; warn for custom/rating limits                                |
| Publication     | One validated stage plus optional last-moment publish mode                   |
| Loss            | Known incapability warns; supported loss fails                               |
| Warning surface | `ConversionResult` plus human logger only                                    |
| Tests           | Central contracts plus deliberate real fixtures                              |

Implement security/rating foundations, then pure policy, then atomic integration, then evidence and
documentation. Defer broad machine warning propagation, multiple-picture preservation, additional
targets, M4A rating experiments, and issue #125 audit abstraction.

## Risk Assessment

### Security Considerations

These are shipment hard stops:

| ID      | Critical condition       | Required proof                                                                                                                                                        |
| ------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-C01 | Vulnerable parser chain  | `music-metadata ^11.14.0`, `file-type >=21.3.4`, focused lock review, listing/audit, three advisories absent from the chain                                           |
| SEC-C02 | Shell/argv injection     | `spawn("ffmpeg", argv, { shell: false, signal })`, fixed tokens, `-nostdin`, bounded stderr, no values/art/URLs/tag-derived paths, adversarial paths remain one token |
| SEC-C03 | Unsafe destination write | Exclusive `0600` validated stage, identity checks, audit/sync/rename/cleanup, failure never replaces destination                                                      |

Also enforce all resource bounds, NUL/key validation and FFmetadata escaping; use unpredictable
exclusive sidecars; sanitize logs; accept only local regular-file sources; persist no metadata into
history/cache/database/plan; preserve exact cancellation and cleanup; and never fetch tag URLs.

### Technical Risks

| Risk                                                  | Impact   | Mitigation                                                                         |
| ----------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| Unsupported FFmpeg build or metadata precedence       | High     | Explicit actionable failure plus four-target real probe and recorded version       |
| Silent supported-field loss                           | High     | Adjacent policy/audit and pre-publication fatal result                             |
| NodeID3 changes stage identity                        | Critical | Integration assertion; never relax identity checks                                 |
| Parser upgrade changes projections                    | High     | ID3, Vorbis/FLAC, MP4, rating, and cover probes                                    |
| Opus framing/escaping defect                          | High     | Exact byte/base64/control/bounds tests and output digest                           |
| Memory amplification                                  | Medium   | Hard bounds, one source/audit parse, one primary image, existing concurrency       |
| Warning leakage/noise                                 | High     | Safe categories, sanitization, deterministic deduplication                         |
| Artifact leak                                         | High     | Outer `finally` plus success/failure/abort cleanup tests                           |
| Nested verify staging changes inode or bypasses audit | Critical | Conversion owns one stage; verify passes only an additional validator              |
| Published file mode regresses direct FFmpeg           | High     | Preserve existing mode or derive new mode; minimal helper test and empirical probe |

Integration review must confirm every caller still waits for conversion before history/hash/reuse,
converted verify repairs use one transaction, non-converted repairs retain their helper, Plex sync
remains later, `.tmp` output always has explicit `-f`, and real FFmpeg evidence is deliberate
because normal CI does not provision it.

## Task Breakdown Preview

### Phase 0: Security and Baseline

- Patch and verify the parser chain.
- Extract native-first ratings and remove the duplicate common-first reader.
- Tokenize argv; add `-nostdin`, explicit muxers/mappings, and `shell: false`.

Gate: existing focused tests pass, lock diff is scoped, advisories are absent from the chain, and no
option/value pair or source value can become an injected token.

### Phase 1: Metadata Policy

- Add bounded projection, exhaustive target policies, stable warnings, semantic audit, and Opus
  framing/escaping.
- Add the one central table-driven metadata suite.

Gate: policies, exact Opus bytes, bounds, warnings, rating tolerance, artwork, and fatal supported
loss are proven.

### Phase 2: Atomic Integration

- Add optional `publishMode` to the stage helper and prove private staging plus direct-FFmpeg final
  modes.
- Route all targets through one validated stage and add the internal additional-validator seam.
- Rewire only converted verify repairs to supply their tier validator; retain outer staging for
  non-converted repair.
- Integrate target mappings, Opus sidecar, MP3 POPM, both validators, cancellation, warnings, and
  publication.
- Extend only `ConversionResult`.

Gate: compact lifecycle tests prove publish order, rollback, prior-destination preservation,
sidecar privacy/cleanup, POPM provenance, argv, settle-once, exact cancellation, no nested verify
stage, and correct new/replacement modes.

### Phase 3: Evidence and Closeout

- Run/reparse tagged fixtures for MP3, AAC/M4A, ALAC/M4A, and Opus and record FFmpeg/version results.
- Run focused/full rfmedia tests, architecture/codegen contracts, build/typecheck, dependency
  checks, formatting, Markdown lint, and diff checks.
- Update scoped docs, refresh graphify, then re-audit live issue hierarchy/counts, review threads,
  CI, merge, issue closure, `ROADMAP.md`, branch alignment, and worktree cleanup.

Phase 0 blocks cover-aware work. Phase 1 policy and rating work may proceed independently after the
version is settled; Phase 2 needs both. Documentation must use observed Phase 3 results.

## Decisions Needed

No product, CLI, persistence, output-format, or scope decision remains. These are empirical
implementation confirmations with fixed gates; a failed gate requires scoped design review:

| Confirmation    | Fixed gate                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| FFmpeg floor    | Explicit `mp3`, `ipod`, `opus`, optional picture mapping, and declared codecs work in the supported environment.    |
| Opus precedence | Canonical/custom comments coexist with sidecar rating/artwork and reparse successfully.                             |
| NodeID3 stage   | Update retains the identity required by validated staging.                                                          |
| Publish mode    | Preserve an existing regular destination mode or use `0o666 & ~process.umask()` for new output; stage stays `0600`. |
| Verify staging  | Converted repair uses one conversion-owned stage and callback; non-converted repair retains its outer helper.       |
| Patched parser  | Representative ID3, Vorbis/FLAC, and MP4 rating/picture projections remain correct.                                 |
| Warning UX      | One sanitized value-free human line appears after progress; machine stdout remains valid without schema changes.    |

## Research References

- [Architecture](./research-architecture.md): seam, ordering, staging, downstream boundaries.
- [Business](./research-business.md): value, target expectations, compatibility, success measures.
- [Documentation](./research-docs.md): scoped documentation changes.
- [External](./research-external.md): FFmpeg/container behavior and library evaluation.
- [Integration](./research-integration.md): callers, Plex order, reuse, progress, results.
- [Patterns](./research-patterns.md): repository conventions and test style.
- [Practices](./research-practices.md): KISS boundaries, reuse, critical tests, rejected abstractions.
- [Recommendations](./research-recommendations.md): conflict-resolution authority for this spec.
- [Security](./research-security.md): hard stops, bounds, safe serialization/logging, advisories.
- [Technical](./research-technical.md): models, target argv, audit, files, gates.
- [UX](./research-ux.md): warning timing, progress, terminal safety, stdout integrity.
