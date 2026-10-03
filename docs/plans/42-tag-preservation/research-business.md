# Business Research: Tag Preservation During Conversion

## Executive Summary

GitHub issue #42 addresses a correctness failure in the existing `rfmedia` conversion workflow:
users expect converted tracks to remain recognizably the same library objects, but FFmpeg's default
container mapping can silently discard ratings, custom fields, and embedded artwork. The feature is
successful when every existing conversion caller produces a destination with the same meaningful
metadata as its source, subject only to explicit destination-format limitations.

This is transparent behavior behind the existing `--convert` option. It must not add a flag,
configuration setting, command, output mode, or completion entry. The named acceptance baseline is
artist, album, title, track number, year/date, genre, rating, and primary embedded artwork.
Compatible custom text tags must also be retained. A source field that the destination genuinely
cannot represent may be omitted only with a non-fatal, actionable warning; a failure to preserve a
field that the destination does support is a failed conversion.

The contract belongs to the shared `convertFile()` boundary. Album copy, filter copy, sync, Plex
copy, Plex playlist copy, and both verification-repair workflows must inherit the same result.
Preservation must finish before the conversion resolves because downstream callers immediately
record, hash, copy, hardlink, validate, or deliberately override the completed artifact.

## User Stories

1. As a user converting a FLAC, MP3, Ogg/Vorbis, Opus, M4A, or other supported audio source, I want
   the converted track to retain its identity and library metadata so that conversion does not
   require manual retagging.
2. As a user who relies on ratings for filters and media workflows, I want the destination rating
   to represent the same preference even when the source and destination use different rating
   scales.
3. As a user browsing a converted library, I want the primary embedded cover to remain embedded,
   independently of separately copied files such as `cover.jpg`.
4. As a user with custom text tags, I want every compatible field preserved and a clear warning for
   each field or field class that the target container cannot represent.
5. As an automation user, I want a valid audio conversion to continue when loss is an inherent
   target-format limitation, but I do not want a conversion reported as successful when supported
   metadata work failed.
6. As a Plex copy user with rating synchronization enabled, I want the selected Plex rating to
   remain the final rating authority without losing the source's other tags.
7. As a user who cancels or encounters a failed conversion, I want no partial artifact, false
   history, stale hash, or damaged pre-existing destination left behind.

## Business Rules

### Core Preservation Rules

**BR-01 — Transparent default behavior.** Every actual conversion through `convertFile()` attempts
metadata preservation automatically. Copy-only and hardlink-only operations remain unchanged.
Dry-run behavior remains non-mutating. No user opt-in is required and no new CLI surface is added.

**BR-02 — Canonical acceptance baseline.** When present on the source and representable by the
target, the destination must preserve the semantic values of:

- artist, including the primary artist;
- album;
- title;
- track number, including a total when the target supports it;
- year or date, using the destination's compatible date representation;
- genre, including multiple values where the destination supports them;
- rating; and
- primary embedded artwork.

Preservation is semantic rather than byte-for-byte: equivalent ID3, Vorbis, and MP4 fields satisfy
the rule even when frame names, numeric encodings, or container structures differ.

**BR-03 — Custom and native fields.** Compatible textual custom tags must be carried to the
destination without changing their values. A native frame, binary field, chapter, identifier,
additional picture, or custom key that has no safe target representation may be omitted only under
BR-10. The implementation must not claim that native frames are losslessly portable across
containers.

**BR-04 — No invented metadata.** Missing source fields remain absent. Conversion must not create
placeholder artists, dates, genres, ratings, artwork, tag values, POPM identities, or counters merely
to fill the destination schema.

**BR-05 — Source immutability.** Metadata preservation reads the source and writes only the
destination artifact. It must never mutate source tags, artwork, timestamps, or audio bytes.

### Target-Format Rules

| Target      | Required outcome                                                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MP3         | Preserve canonical text fields, compatible custom text, primary artwork as an ID3 picture, and a rated source as POPM. Preserve selected POPM email/counter provenance when it can be represented safely.                                                  |
| Opus        | Preserve canonical text fields, compatible Vorbis comments, rating as `RATING`, and primary artwork using the standard picture-comment representation. The current writer's lack of Opus support is an implementation gap, not a target-format limitation. |
| AAC in M4A  | Preserve canonical text fields and primary artwork in the M4A container. Warn when source ratings or custom/native fields cannot be represented through a tested file-tag convention.                                                                      |
| ALAC in M4A | Apply the same metadata contract and limitations as AAC/M4A; codec losslessness does not imply metadata losslessness.                                                                                                                                      |

**BR-06 — All current sources remain eligible.** The existing supported audio extensions remain
eligible inputs. Acceptance evidence must exercise the materially distinct tag dialects—ID3,
Vorbis/FLAC, and MP4/iTunes—and must not narrow conversion to only the fixture formats.
Unrecognized-but-valid fields follow BR-03 and BR-10.

**BR-07 — Primary artwork is guaranteed where the target supports it.** If a source contains
embedded artwork, at least its primary/front cover must be present and readable in each current
target. Opus supports embedded pictures through its standard metadata convention, so dropping all
Opus artwork is not acceptable. If additional source pictures or their type/description cannot be
represented, retain the primary picture and warn about the additional loss. Sidecar artwork remains
under the existing non-audio copy behavior and is not a substitute for embedded-artwork
preservation.

### Rating Rules

**BR-08 — Normalize semantics once.** Ratings are interpreted as a normalized value from zero to
one at the source boundary, then encoded using the destination convention. Existing semantics
remain authoritative:

- MP3 POPM zero means unrated; rated POPM values occupy the one-to-255 scale.
- Vorbis-family `RATING` values may use normalized zero-to-one, star zero-to-five, or percent
  zero-to-100 scales.
- Native Vorbis scale detection must win over an incorrect generic parser projection; for example,
  literal `RATING=0.80` means 0.8, not 0.008.
- Normal quantization caused by a destination scale is allowed, but the value must round-trip to
  the closest destination-representable rating.
- An absent or unrated source must not become a positive destination rating.

Where the destination supports the same provenance data, preserve the selected POPM identity and
play counter. If a target can preserve the rating value but not POPM-specific provenance, preserve
the value and warn about the incompatible provenance only when it was present.

**BR-09 — Plex remains the deliberate final authority.** Source metadata preservation completes
first. In Plex copy and Plex playlist workflows, an enabled, positive Plex rating is then allowed to
replace the preserved source rating through the existing sync behavior. If rating sync is disabled,
the Plex item is unrated, or no Plex rating is available, the source rating remains. A best-effort
Plex override failure must not erase an already preserved source rating or discard other metadata.

### Warning and Failure Rules

**BR-10 — Inherent loss is non-fatal but visible.** A valid destination may be kept when a particular
source field cannot be represented by the target format. The warning must identify:

- the affected source or destination path;
- the target format;
- the tag name or safe category, such as rating, artwork, custom text, or unknown native field;
- the reason, such as unsupported target representation or malformed individual value; and
- that the audio output remains usable.

Warnings may aggregate repeated losses for one file, but must not hide which fields or categories
were lost. They go through the existing warning logger on stderr so JSON stdout remains valid.
Warnings must not include raw tag values, artwork bytes, or other sensitive metadata.

**BR-11 — Implementation gaps are fatal.** A parse failure that prevents the source metadata
snapshot, an FFmpeg/spawn/codec/I/O failure, inability to write a mapping the target is expected to
support, destination validation failure, or metadata finalization error rejects the conversion.
Such failures must retain the existing typed/actionable conversion behavior rather than being
downgraded to format-limit warnings. A source that validly contains no metadata is not an error.

**BR-12 — No silent supported-field loss.** Before reporting success, the conversion must establish
that the canonical fields and primary artwork expected for that target were preserved. A
representable required field missing from the destination is a fatal failure, not a warning.

### Lifecycle and Integrity Rules

**BR-13 — Conversion success is atomic to callers.** `convertFile()` resolves only after audio
encoding, supported tag writes, artwork handling, rating translation, and required validation are
complete. History recording, inventory hashing, first-copy reuse, plugin after-copy behavior, and
verify replacement must see the final tagged bytes.

**BR-14 — Cancellation spans the whole operation.** The existing abort signal applies before and
during metadata reading, FFmpeg processing, post-write handling, and validation. Cancellation
preserves the caller's exact abort reason and is not wrapped as a generic conversion failure.

**BR-15 — Failure and cancellation clean up safely.** A failed or cancelled conversion removes its
temporary and partial artifacts. It must not replace or corrupt a pre-existing destination, record a
successful conversion, persist a final hash, or seed later copies/hardlinks from incomplete output.

**BR-16 — First-copy reuse preserves the finalized artifact.** Range and repeated-copy workflows
convert and tag the first artifact once. Subsequent copies or hardlinks derive from that finalized
artifact without retranscoding or independently reinterpreting source metadata.

## Edge Cases

| Case                                                    | Required behavior                                                                                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source has no tags or artwork                           | Convert successfully without inventing values or emitting loss warnings.                                                                                   |
| Source has only a rating                                | Translate the rating even when FFmpeg would otherwise drop POPM or `RATING`.                                                                               |
| Source rating is zero/unrated                           | Keep the destination unrated; do not create a positive rating.                                                                                             |
| Source Vorbis rating uses 0.8, 4, or 80                 | Interpret each as 0.8 and encode the closest target value.                                                                                                 |
| Source has multiple POPM frames                         | Apply the established preferred-identity selection for the canonical rating; preserve other compatible frames or warn about their loss.                    |
| Source has multiple artists, genres, dates, or pictures | Preserve multiplicity where supported; at minimum retain the canonical primary value/cover and warn about unrepresentable remainder.                       |
| Source has unknown text tags                            | Preserve safe, compatible keys and values; otherwise warn by key/category without logging the value.                                                       |
| Source has binary or structured native fields           | Never flatten unsafe data into process arguments; preserve through a tested native mapping or warn.                                                        |
| Metadata contains an invalid individual value           | Preserve other fields, omit the invalid value with a warning when the media remains parseable; fail if a trustworthy metadata snapshot cannot be obtained. |
| Destination is M4A and source has a file rating         | Preserve all other supported fields and warn that the file rating is not representable through the tested convention.                                      |
| Destination is Opus and source has artwork              | Embed the primary picture; treating the current FFmpeg default or writer gap as a format limitation is not acceptable.                                     |
| Plex sync is enabled with a positive rating             | Preserve source tags first, then make Plex rating the final rating while all non-rating metadata remains unchanged.                                        |
| Plex sync is absent, disabled, or unrated               | Leave the preserved source rating unchanged.                                                                                                               |
| Abort occurs after encoding but before validation       | Reject with the abort reason and remove staged/partial output without altering the prior destination.                                                      |
| Later copy or hardlink reuses the first conversion      | Reused artifacts contain the exact finalized tag state, including any Plex override intentionally applied before reuse.                                    |

## Workflows

### Primary Conversion Workflow

1. An existing action selects one of the current conversion targets: MP3, Opus, AAC/M4A, or
   ALAC/M4A.
2. The shared conversion boundary checks cancellation and obtains a trustworthy, cover-aware source
   metadata snapshot.
3. It classifies each field as canonical, compatible custom text, compatible native data, or
   unrepresentable for the selected target.
4. It converts audio while explicitly carrying the target-compatible metadata and primary artwork.
5. It translates and writes the normalized rating where the target supports file ratings.
6. It reparses or otherwise validates the completed destination against the required source
   projection.
7. It emits safe non-fatal warnings for genuine target limitations.
8. It atomically exposes the completed artifact and returns success.
9. The caller may then record history, compute a hash, invoke hooks, validate a repair, or reuse the
   result.

### Plex Rating Override Workflow

1. The shared workflow produces a fully tagged destination, including the source rating where
   representable.
2. If the existing Plex synchronization option is enabled and Plex supplies a positive rating, the
   Plex action applies that rating after conversion.
3. A successful write becomes the final destination rating. Other preserved metadata is unchanged.
4. A skipped or failed best-effort Plex override leaves the source-preserved artifact intact and
   follows the existing sync diagnostic contract.

### Target-Limitation Recovery

1. Conversion detects a field that the target cannot safely represent.
2. It retains all other supported fields and a valid audio artifact.
3. It emits one actionable warning identifying the field/category and reason.
4. The operation continues and downstream history/hash behavior reflects the actual completed
   artifact.

### Fatal Error or Cancellation Recovery

1. Metadata acquisition, conversion, supported mapping, finalization, or validation fails, or the
   caller aborts.
2. The operation rejects with the existing typed conversion error or exact abort reason.
3. Temporary and partial files are removed; any pre-existing destination remains unchanged.
4. The caller does not record success, hash incomplete bytes, run successful after-copy behavior,
   validate/commit a repair, or make subsequent copies from the failed artifact.

## Domain Model

### Entities

| Entity                   | Meaning                                                                     | Integrity rule                                                 |
| ------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Source media             | Immutable input audio plus its common, native, rating, and picture metadata | Never modified                                                 |
| Source metadata snapshot | Trusted view used to decide preservation and loss                           | Obtained once per conversion and before mutation               |
| Canonical field          | Cross-format semantic identity field required by issue #42                  | Preserved whenever target-representable                        |
| Custom/native field      | Source-specific metadata outside the canonical baseline                     | Preserved when safely compatible; otherwise warned             |
| Normalized rating        | Format-independent rating value in the zero-to-one domain                   | Parsed once, encoded at target boundary                        |
| Embedded artwork         | One or more pictures stored inside the source audio                         | Primary picture is required; additional-picture loss is warned |
| Destination artifact     | Converted audio plus final preserved or deliberately overridden tags        | Not visible as successful until finalized                      |
| Preservation warning     | Evidence of an inherent, non-fatal target limitation                        | Actionable, safe, and emitted on stderr                        |
| Conversion failure       | Evidence that audio or supported metadata work did not complete             | Rejects the operation and prevents downstream success          |

### State Transitions

```text
requested
  -> source metadata captured
  -> target compatibility classified
  -> audio encoded
  -> supported metadata finalized
  -> destination validated
  -> warnings emitted if needed
  -> committed
  -> caller history/hash/reuse

Any pre-commit state
  -> cancelled or failed
  -> temporary/partial output cleaned
  -> prior destination preserved

Committed Plex artifact
  -> optional Plex rating override
  -> final caller-visible rating
```

Only `committed` artifacts may be recorded, hashed, used as a first-copy source, or accepted by a
verification repair.

## Existing Codebase Integration

The business contract applies once at
`packages/rfmedia-cli/src/lib/convert.ts`. The following consumers must continue using that shared
boundary without local metadata-copy implementations:

| Caller             | Required inherited behavior                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `copy-album.ts`    | Hash and record only after the fully tagged destination exists; non-audio sidecars remain ordinary copies.                        |
| `copy-filter.ts`   | Preserve tags on the first conversion before range copies reuse it; filtering still evaluates the source under existing rules.    |
| `sync.ts`          | Incremental conversions receive the same preservation contract without altering sync selection or inventory semantics.            |
| `plex-copy.ts`     | Preserve source metadata first, then apply the existing optional Plex rating override; first-copy reuse sees final intended tags. |
| `plex-playlist.ts` | Apply the same preservation and Plex precedence to first, fallback, copied, and hardlinked playlist artifacts.                    |
| `verify-album.ts`  | A repair stage is not valid until conversion metadata is finalized and validated.                                                 |
| `verify-filter.ts` | Apply the identical staged-repair requirement to filter repair.                                                                   |

`packages/rfmedia-cli/src/lib/ratings.ts` remains the rating interpretation authority.
`tag-writer.ts` may supply destination-specific rating writes, but its current Opus limitation must
not redefine the target's actual capability. Existing logger behavior is the warning channel.

No database migration is required. Existing history and inventory records describe the finalized
file and must not be written earlier. No Bash, Zsh, or Fish completion change is required because
formats and options are unchanged.

## Success Criteria

### Functional Acceptance

- **SC-01:** Deterministic tagged fixtures demonstrate semantic preservation of artist, album,
  title, track number, year/date, genre, rating, and primary embedded artwork from representative
  ID3, Vorbis/FLAC, and MP4 sources.
- **SC-02:** Each current target—MP3, Opus, AAC/M4A, and ALAC/M4A—has an asserted compatibility
  outcome. Every target preserves canonical text and primary artwork; MP3 and Opus preserve rating;
  M4A emits an explicit rating-limitation warning.
- **SC-03:** A compatible arbitrary text tag survives in each target family that supports it; an
  incompatible custom/native tag produces an actionable non-fatal warning and no false preservation
  claim.
- **SC-04:** Rating tests cover POPM zero and rated boundaries, Vorbis normalized/star/percent
  scales, the `0.80` normalization regression, destination quantization, and absent ratings.
- **SC-05:** Primary artwork is reparsed successfully from all four targets. Multiple-artwork loss,
  where applicable, retains the primary picture and produces a warning.
- **SC-06:** Target-limitation warnings identify path, target, field/category, and reason on stderr
  without exposing values or corrupting JSON stdout.
- **SC-07:** FFmpeg failure, metadata-snapshot failure, supported-tag write failure, destination
  validation failure, and post-encode finalization failure all reject conversion.
- **SC-08:** Pre-abort and in-flight abort behavior remains intact, and added metadata phases honor
  the same signal and exact reason. Cancellation/failure tests prove cleanup and preservation of an
  existing destination.
- **SC-09:** Conversion resolves only after the final bytes are stable; a caller-side hash matches
  the tagged artifact rather than a pre-tag version.
- **SC-10:** With Plex rating sync enabled, a positive Plex rating is the final rating while all
  other source metadata remains intact. With sync disabled, missing, unrated, or failed, the
  source-preserved rating remains.
- **SC-11:** A caller audit confirms all seven action modules above still route conversion through
  the shared boundary and no workflow bypasses preservation.

### Proportionate Test Evidence

Testing should prove distinct contracts, not multiply tests by caller:

1. Use table-driven pure tests for rating interpretation and target encoding.
2. Use a small deterministic conversion-fixture matrix for the three materially distinct source
   tag dialects and four target formats. Reparse outputs to prove behavior instead of only asserting
   FFmpeg arguments.
3. Unit-test warning classification, fatal errors, cancellation, cleanup, and atomic completion at
   the shared conversion boundary.
4. Add only the minimum action-level coverage needed to prove Plex override ordering and
   final-artifact hashing/reuse. Do not duplicate the same metadata matrix in album, filter, sync,
   Plex, playlist, and verify tests.
5. Preserve existing parameterized coverage that proves distinct rating or writer failure modes;
   “no unnecessary tests” is not a test-count reduction target.

### Documentation and Delivery Acceptance

- Update `packages/rfmedia-cli/docs/features/audio-conversion.doc.md` and the package README with
  the canonical guarantee, target compatibility matrix, embedded-versus-sidecar artwork
  distinction, warning behavior, and Plex rating precedence.
- Update `plex-metadata-sync.md` only if its current precedence or format-limit description changes.
- Do not restore the deleted historical TODO and do not add root README or completion-template
  churn without an actual public-surface change.
- Run focused tests, the full `rfmedia-cli` suite, architecture and code-generation contracts,
  typecheck/build, Markdown checks, and the repository's required broader validation. Record exact
  current commands and outcomes in the pull request template.
- Run `graphify update .` after code changes, as required by project instructions.
- Re-audit the live issue hierarchy, issue state, open roadmap counts, pull-request checks, and
  unresolved review threads at closeout. Issue #42 currently has no parent, tracked parent, or
  sub-issues, so no child completion is presently required; recheck rather than relying on this
  snapshot.
- After authoritative merge verification, ensure issue #42 is closed, remove it from the active
  parallel roadmap row and medium-priority backlog, renumber remaining work as needed, and recalculate
  live counts instead of decrementing a stale number mechanically.

## Open Questions

1. Should every additional picture and competing POPM frame be a hard acceptance guarantee when the
   target can represent multiples, or is primary artwork plus the selected canonical rating the
   intended issue baseline? This research recommends the named baseline with preservation-or-warning
   for the remainder.
2. Should non-fatal preservation warnings also be collected on `ConversionResult` for future
   programmatic consumers? Logging on stderr is required for current user visibility; an additive
   result collection is optional unless a current caller needs structured access.
3. Which custom MP4 atoms, if any, should be declared supported beyond the canonical fields?
   Acceptance should promise only mappings demonstrated by destination reparsing, not FFmpeg
   argument presence.
