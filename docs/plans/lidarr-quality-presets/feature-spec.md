# Feature Spec: Lidarr Quality Preset Packs

## Executive Summary

Issue #213 adds a dedicated `rfmedia lidarr presets` desired-state workflow for discovering,
reviewing, and applying opinionated Lidarr quality-profile, custom-format, and naming policy. The
first release ships three immutable versioned packs plus strict configured packs. It uses fresh
live reads, deterministic semantic diffs, explicit approval, an origin-scoped apply lock, ordered
writes, and post-write verification. The workflow is additive: it manages declared same-name
resources while retaining undeclared resources and scores, and it never prunes, reassigns artists,
searches, downloads, or renames existing files.

## External Dependencies

### APIs and Services

The implementation uses the existing generated Lidarr v1 client through the handwritten
`LidarrClientApi` facade. The committed OpenAPI snapshot already includes the required operations:

| Resource         | Reads                   | Writes            | Important contract                                                                        |
| ---------------- | ----------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| Custom formats   | collection and schema   | create and update | Conditions have dynamic fields and require bounded projection and live-schema validation. |
| Quality profiles | collection and schema   | create and update | Every current custom format must appear exactly once in `formatItems`.                    |
| Naming           | singleton and examples  | update            | Examples are advisory; PUT followed by fresh GET is authoritative.                        |
| Artists          | bounded collection read | none              | Used only to report assignment impact for managed profiles.                               |

The connected Lidarr instance is capability-probed from these endpoints instead of being accepted
solely by a version string. Missing or incompatible endpoints, schema implementations, qualities,
or naming fields fail the complete preflight before mutation.

### Libraries and Tooling

- Keep the existing Commander, generated-client, scheduler, formatter, YAML, Vitest, and filesystem
  locking/tooling stack.
- Add no Lidarr SDK, schema framework, diff engine, workflow engine, regex evaluator, or other new
  runtime dependency.
- Upgrade direct `js-yaml` to a patched supported release because configured preset data extends
  the parser-controlled input surface.
- Do not refresh the OpenAPI snapshot or generator unless a contract test proves the committed
  generated operations cannot represent a required request or response.

### External Documentation

The API design is grounded in the current Lidarr controller/service behavior captured in
[external research](./research-external.md). Terraform, Kubernetes, Ansible, Configarr, Recyclarr,
and Buildarr provide comparison points for preview, ownership, and convergence behavior, but their
artifact and exit-code contracts are not copied blindly.

## Business Requirements

### User Stories

1. As a new Lidarr operator, I can list and inspect curated quality policies offline so I understand
   their storage, bandwidth, compatibility, upgrade, and naming tradeoffs before connecting.
2. As an operator, I can compare one selected pack with fresh Lidarr state and review every managed
   create, update, unchanged item, retained resource, dependency, and impact before mutation.
3. As an operator, I can apply the reviewed policy safely and rerun it until the instance converges
   without deleting unrelated settings or duplicating same-name resources.
4. As an automation author, I can use versioned JSON, YAML, or CSV results, require explicit
   approval, distinguish complete, partial, uncertain, and no-op outcomes, and trust dry-run to
   perform zero writes.
5. As an advanced user, I can define strict self-contained local packs in `rfmedia` configuration
   without fetching or executing remote preset content.

### Business Rules

- Provide these commands:

  ```text
  rfmedia lidarr presets list
  rfmedia lidarr presets show <pack-ref>
  rfmedia lidarr presets diff <pack-ref>
  rfmedia lidarr presets apply <pack-ref> [--dry-run] [--yes]
  ```

- Ship exactly three built-ins in v1: `balanced@1`, `lossless@1`, and `space-saver@1`.
- Built-ins are immutable, local package data with a stable ID, integer version, provenance,
  normalized digest, assumptions, consequences, complete profile definitions, at least one real
  custom format, and complete persisted naming policy.
- Configured packs are strict, fully self-contained, versioned, local config values. V1 has no
  inheritance, remote catalogs, external preset files, or built-in shadowing.
- `builtin:<id>` and `config:<id>` always select a source. An unqualified ID is accepted only when
  it resolves uniquely.
- Same normalized name means adoption of that live resource after the complete diff and explicit
  approval. Zero or multiple matches block the run; matching is never fuzzy.
- Declared quality-profile policy and declared custom-format definitions are managed. Undeclared
  profiles, formats, and existing format scores are retained.
- The selected pack owns every supported persisted naming field as one complete policy.
- V1 has no delete, prune, rename, artist reassignment, search, download, existing-file move, or
  existing-file rename operation.
- `list` and `show` are offline. `diff` is read-only. `apply --dry-run` performs the full live
  preflight and diff with zero API writes, journal writes, or lock-authorized mutations.
- A valid diff succeeds whether or not changes exist and exposes `hasChanges` in machine output.
- A converged apply performs no writes and does not prompt.
- Real interactive apply prompts once after the complete review and defaults to no.
  Machine/non-TTY apply requires `--yes`; `--yes` bypasses only the prompt.
- Any failed, stale, uncertain, or non-durable resource outcome stops every later write admission.
  Recovery is a fresh forward-convergence rerun, never automatic rollback.

### Edge Cases

- Built-in/configured reference collisions require an explicit qualified reference.
- Duplicate names after trim and Unicode-safe case normalization are invalid locally and live.
- An existing same-name resource with a malformed or ambiguous definition blocks adoption.
- Unknown custom-format implementations or fields, incompatible live schema, unresolved qualities,
  cutoffs, or scores, and invalid naming tokens block the complete preflight.
- Profile writes preserve every fresh unmanaged custom-format score and contain each current format
  exactly once.
- Behaviorally significant quality/group and condition order is preserved and compared.
- Server normalization is accepted only through explicitly tested per-field canonicalization.
- Concurrent drift between review and any write produces a stale outcome; no force override exists.
- An ambiguous network result after dispatch is `uncertain` until fresh state proves satisfaction.
- Interruption stops new admissions and classifies the in-flight resource through bounded
  stabilization/read-back.
- Hostile YAML complexity, oversized graphs, unsafe regex syntax, controls, bidirectional text,
  path traversal shapes, and CSV formula prefixes are rejected or safely represented.

### Success Criteria

- All four commands work in human, JSON, YAML, and supported fixed-row CSV output modes.
- The three built-ins validate against committed representative Lidarr fixtures and disclose their
  exact policy and non-effects.
- Diff classifies all selected resources as create, update, unchanged, or retained with stable
  ordering and field-level changes.
- Dry-run and diff prove zero mutation and zero journal writes.
- Apply uses the sequence custom formats, refreshed catalogs/schema, quality profiles, then naming.
- Every write is preceded by a fresh drift check and followed by a fresh semantic read-back.
- Second-run convergence issues zero writes.
- Error and partial results contain stable codes, resource paths, dispatch state, retryability, and
  a concrete secret-free next action.
- Help, docs, example config, architecture gates, generated-client contract checks, and Bash, Zsh,
  and Fish completions remain in parity.

## Technical Specifications

### Architecture Overview

The feature uses one-way dependencies:

```text
commands/lidarr-presets.ts
        |
        v
actions/lidarr/profile-presets.ts
        |
        +--------> lib/lidarr/client.ts --------> generated SDK
        |                    |
        |                    +------------------> hardened transport
        v
lib/lidarr/profile-presets.ts
        |
        v
types/lidarr-presets.ts
```

- `types/lidarr-presets.ts` owns generated-independent pack, live projection, diff, result, and
  outcome contracts.
- `lib/lidarr/profile-presets.ts` owns the frozen built-in registry, strict resolution,
  normalization, live capability/reference validation, body intent construction, semantic
  comparison, and deterministic pure diff.
- `actions/lidarr/profile-presets.ts` owns config selection, fresh reads, impact analysis, the
  scheduler, origin lock, approval-ready result creation, dependency-ordered mutation, journaling,
  drift checks, and read-back verification.
- `commands/lidarr-presets.ts` owns Commander registration, human rendering, machine envelopes,
  confirmation, and failure reporting. `commands/lidarr.ts` only registers the subtree and passes
  shared callbacks.
- Generated imports remain private to `client.ts`; authenticated Fetch remains private to
  `transport.ts`. Existing `listQualityProfiles(): LidarrProfile[]` stays narrow for artist
  assignment, while new facade methods expose separate rich definitions.
- The feature does not extend `rfmedia.lidarr-plan.v2`; global name-resolved configuration does not
  fit its sealed numeric artist/album target and history model.

### Data Models

Core discriminated models:

| Model                        | Required identity and fields                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `LidarrPresetPack`           | source, stable ID, version, digest, assumptions, consequences, capabilities, complete profiles, complete naming, custom formats            |
| `LidarrPresetCustomFormat`   | portable name, ordered supported conditions, inclusion flag                                                                                |
| `LidarrPresetQualityProfile` | portable name, upgrade policy, cutoff, ordered qualities/groups, minimum score, upgrade-until score, managed scores by format name         |
| `LidarrPresetNaming`         | every supported persisted rename and template field                                                                                        |
| `LidarrPresetResourceDiff`   | stable key, type, live ID when present, action, impact, ordered field changes, dependencies                                                |
| `LidarrPresetDiffResult`     | schema version, pack identity/digest, target origin, assumptions, summary, resources, warnings, execution metadata                         |
| `LidarrPresetApplyOutcome`   | stable resource key, attempted/dispatch state, succeeded/satisfied/failed/uncertain/not-attempted status, verification and safe error data |

Stable resource keys are `custom-format:<normalized-name>`,
`quality-profile:<normalized-name>`, and `naming:<positive-id>`. Domain IDs are positive integers;
the generated PUT path's string conversion remains inside the facade.

Configured packs live under an exact-key `lidarr.profilePresets` config section. Parsing preserves
backward compatibility when that section is absent and applies explicit limits to file size,
object depth, scalar length, pack/resource/condition counts, quality-tree depth/nodes, scores, and
expanded result size.

### Approved Built-In Policy Checkpoint

The Task 2.3 design-owner checkpoint approved the following immutable `@1` policies. The committed
representative capability fixture is `LIDARR_PRESET_SUPPORTED_FIXTURE_V1`; its name deliberately
contains no Lidarr marketing version. Its evidence is the OpenAPI manifest's upstream commit
`3e2858439ff35b372d0af00bcea1b0a357572d26` plus official `Quality.cs` and `NamingConfig.cs` source
at `d4c72f8ee93113ce82321b78c3365dbaf435f1b8`.

The fixture requires all nine capabilities in this order:

1. `custom-format-schema`
2. `custom-format-create`
3. `custom-format-update`
4. `quality-profile-schema`
5. `quality-profile-create`
6. `quality-profile-update`
7. `naming-read`
8. `naming-examples`
9. `naming-update`

It freezes these custom-format schemas:

- `ReleaseTitleSpecification` with `value: string`
- `ReleaseGroupSpecification` with `value: string`
- `IndexerFlagSpecification` with `value: integer`
- `SizeSpecification` with `min: number` and `max: number`

The approved ordered quality groups are:

- `Mid Quality Lossy`: `OGG Vorbis Q7`, `MP3-VBR-V2`, `MP3-256`, `OGG Vorbis Q8`, `AAC-256`
- `High Quality Lossy`: `MP3-VBR-V0`, `AAC-VBR`, `MP3-320`, `OGG Vorbis Q9`, `AAC-320`,
  `OGG Vorbis Q10`
- `Lossless`: `FLAC`, `ALAC`, `APE`, `WavPack`, `FLAC 24bit`, `ALAC 24bit`

Every built-in owns the same complete active naming policy:

```yaml
renameTracks: true
replaceIllegalCharacters: true
colonReplacementFormat: 4
standardTrackFormat: "{Album Title} ({Release Year})/{Artist Name} - {Album Title} - {track:00} - {Track Title}"
multiDiscTrackFormat: "{Album Title} ({Release Year})/{Medium Format} {medium:00}/{Artist Name} - {Album Title} - {track:00} - {Track Title}"
artistFolderFormat: "{Artist Name}"
```

This enables naming for future imports and explicit Lidarr rename operations. Applying a preset
does not issue a rename command and never renames existing files.

#### `balanced@1`

- Profile: `RFMedia Balanced`
- Ordered items: `High Quality Lossy`, then `Lossless`; every listed group and child is allowed.
- Cutoff and upgrades: `Lossless`, `upgradeAllowed: true`
- Scores: `minFormatScore: 0`, `cutoffFormatScore: 25`
- Custom format: `RFMedia WEB Source`, not included when renaming; one required, non-negated
  `ReleaseTitleSpecification` named `WEB source` with
  `value: \bWEB(?:[-_. ]?DL)?\b`; profile score `25`
- Assumptions: the approved groups exist in the connected schema; release titles identify WEB
  sources when meaningful; the operator accepts lossless storage growth.
- Consequences: high-quality lossy and lossless codecs are accepted; upgrades continue toward
  lossless plus the WEB preference; WEB is not provenance proof; unmanaged resources and scores
  remain retained.

#### `lossless@1`

- Profile: `RFMedia Lossless`
- Ordered items: `Lossless`; every listed child is allowed.
- Cutoff and upgrades: `Lossless`, `upgradeAllowed: true`
- Scores: `minFormatScore: 0`, `cutoffFormatScore: 100`
- Custom format: `RFMedia 24-bit Lossless`, not included when renaming; one required, non-negated
  `ReleaseTitleSpecification` named `24-bit marker` with
  `value: \b(?:FLAC|ALAC)[-_. ]?24(?:[-_. ]?bit)?\b|\b24[-_. ]?bit\b`; profile score `100`
- Assumptions: the approved Lossless group exists; titles identify 24-bit releases when meaningful;
  the operator prioritizes preservation over storage and bandwidth.
- Consequences: no lossy fallback; substantially higher storage and bandwidth; the group also
  admits ALAC, APE, and WavPack; 24-bit is preferred rather than required; unmanaged resources and
  scores remain retained.

#### `space-saver@1`

- Profile: `RFMedia Space Saver`
- Ordered items: `Mid Quality Lossy`, then `High Quality Lossy`; every listed group and child is
  allowed.
- Cutoff and upgrades: `High Quality Lossy`, `upgradeAllowed: true`
- Scores: `minFormatScore: 0`, `cutoffFormatScore: 25`
- Custom format: `RFMedia MP3 320`, not included when renaming; one required, non-negated
  `ReleaseTitleSpecification` named `MP3 320 marker` with
  `value: \bMP3[-_. ]?320\b|\b320(?:kbps|k)\b`; profile score `25`
- Assumptions: the approved lossy groups exist; lossy audio is acceptable; titles identify MP3-320
  when present; reduced storage is more important than lossless preservation.
- Consequences: lossless releases are excluded; compression is irreversible; AAC, OGG Vorbis, and
  MP3 remain eligible; MP3-320 is preferred rather than required; unmanaged resources and scores
  remain retained.

### API Design

Add intention-revealing facade methods for:

- rich quality-profile schema and definitions;
- create/update quality profiles;
- custom-format schema and definitions;
- create/update custom formats;
- naming singleton and bounded naming examples;
- naming update.

Every wire response is treated as `unknown` and projected into frozen bounded domain objects.
Projectors reject malformed whole collections, duplicate IDs/names, excessive recursive state,
unsafe labels, non-finite numbers, unknown dynamic field shapes, and terminal-control content.

GET methods may join the explicit safe read retry allowlist. POST/PUT methods are forwarded through
the resilience facade but never hot-retried. All calls retain canonical-origin confinement,
header-only API-key injection, redirect rejection, timeout/cancellation composition, bounded
response bodies, and typed sanitized errors.

### Validation and Diff

Validation is phased:

1. Parse exact local config and resolve one pack.
2. Validate pack bounds, names, naming templates, local capabilities, score/reference integrity,
   and a conservative regex subset.
3. Resolve connection/authentication and fetch fresh live schemas/resources.
4. Intersect custom-format implementations and exact fields with the live schema.
5. Resolve qualities, groups, cutoffs, format IDs, naming fields, and impact relationships.
6. Build a deterministic semantic diff and bounded review model.

The initial custom-format allowlist is:

- `ReleaseTitleSpecification`
- `ReleaseGroupSpecification`
- `IndexerFlagSpecification`
- `SizeSpecification`

Regex values reject controls, bidirectional controls, backreferences, lookbehind, nested ambiguous
quantifiers, and excessive bytes. Naming values allow only supported tokens and reject absolute
paths, traversal segments, NUL/C0/C1/bidirectional controls, and missing required semantic tokens.
Server naming examples are sanitized advisory evidence and never authorize mutation.

Equality ignores server-assigned/derived/volatile fields, preserves behaviorally significant array
order, retains explicit `false`, `0`, empty arrays, and whitespace-bearing templates, and uses a
documented field order with additive unknown paths sorted last.

### Apply State Machine

```text
resolve pack
    -> acquire canonical-origin lock
    -> fresh complete preflight and diff
    -> no-op or approval
    -> for each custom format: drift check -> write -> read-back -> journal
    -> refresh custom formats and quality-profile schema
    -> for each quality profile: rebuild complete body -> drift check -> write -> read-back -> journal
    -> naming: drift check -> write -> read-back -> journal
    -> terminal verified result
```

The local exclusive lock is keyed by a digest of the canonical Lidarr origin and held from final
preflight until terminal outcomes are durably recorded. It prevents different local invocations
from interleaving global configuration writes; multi-host coordination remains an explicit future
deployment concern.

The apply journal is bounded, secret-free, owner-only, atomic, and independent from
`rfmedia.lidarr-plan.v2`. It records pack identity/digest, canonical origin, selected semantic
before/desired projections, ordered resource outcomes, and completion state. A rerun always starts
from fresh live state and treats already-converged resources as satisfied.

## UX Considerations

### User Workflows

`presets list` is a concise offline catalog. `presets show` renders the fully resolved pack,
provenance, exact policy, assumptions, tradeoffs, and non-effects. `presets diff` displays pack,
target, assumptions, live observations, consequences, summary counts, grouped resources, impact,
and field changes before ending with `No changes were made`. `presets apply` repeats that complete
review and prompts only when changes remain.

Human review/progress goes to stderr. JSON and YAML emit one versioned document on stdout. CSV uses
a fixed union with `rowType` values for summary, assumption, warning, resource, field, and naming
example rows; formula-like display cells are neutralized, while JSON remains the lossless machine
format.

### UI Patterns

- Use explicit textual `CREATE`, `UPDATE`, `UNCHANGED`, `RETAIN`, and outcome labels; color is
  supplementary only.
- Summarize first, group by custom format/profile/naming dependency order, then render vertical
  field changes on narrow terminals.
- Cap default detail using existing preview conventions, always report omitted counts, and use
  `--verbose` for bounded expansion.
- Keep identifiers, pack refs, property paths, and recovery commands untruncated.
- Display raw naming templates and sanitized examples, and label future-import versus existing-file
  consequences.
- Emit phase-based static progress only on interactive human stderr. Never spawn an internal pager
  or contact Lidarr during shell completion.
- Print an exact shell-quoted rerun command after partial or uncertain work.

### Accessibility and Safety

Honor plain/non-TTY output and `NO_COLOR`; never encode status by color alone. Use existing
display-width-aware handling for Unicode. Reject terminal controls before output-model creation.
Prompts default to no and never appear in machine or non-interactive flows. Errors include a stable
code, phase, resource/property path, safe expected/observed details, whether a write may have been
dispatched, retryability, and one concrete next action.

## Recommendations

### Implementation Approach

Implement in dependency order:

1. Freeze types, limits, exact config schema, fixtures, and the three real built-in policies.
2. Add bounded rich wire projectors and generated-contract/facade coverage.
3. Build the pure resolver, live validation, body builders, canonical comparison, and diff engine.
4. Add offline list/show and live diff with stable output contracts.
5. Add origin locking, journaling, sequential apply, drift checks, read-back, partial outcomes, and
   convergence reruns.
6. Complete command/help, example config, docs, all shell completions, architecture gates, and
   repository validation.

Build fixture-backed built-ins from qualities and tokens in the committed supported Lidarr
snapshot. Acceptance is capability-based: an instance must expose and satisfy every required
schema/resource contract. The CLI reports incompatible capabilities precisely instead of claiming
support from a version string alone.

### Technology Decisions

- Dedicated live preset workflow, not the existing sealed Lidarr plan family.
- Frozen TypeScript data for built-ins; strict existing YAML config for user packs.
- Pure handwritten semantic diff and resource-specific reconcilers; no generic framework.
- Parallel bounded fresh GET discovery where safe; deterministic sequential writes.
- One local canonical-origin lock; no force-stale mode and no automatic rollback.
- Complete naming ownership and self-contained configured packs in v1.
- Additive same-name adoption with explicit diff; no deletion or rename inference.
- No new runtime dependency; patch the existing YAML parser.

### Future Enhancements

Saved signed/reviewable config plans, expected-diff checksums, pack inheritance, partial naming
ownership, high-risk pruning, remote signed catalogs, distributed locks, redacted review exports,
more custom-format implementations, and a repository-wide detailed diff exit code are follow-up
work, not hidden v1 behavior.

## Risk Assessment

### Security Considerations

| Severity | Risk                                                           | Required control                                                                                 |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| High     | Shared resources have library-wide blast radius.               | Complete impact/diff, additive ownership, explicit approval, no pruning.                         |
| High     | Separate applies can race on one instance.                     | Canonical-origin lock plus immediate per-resource drift checks.                                  |
| High     | Multi-resource writes are not transactional.                   | Ordered stages, durable outcomes, read-back, uncertainty classification, forward reconciliation. |
| High     | Dynamic fields and regexes become server-executed policy.      | Local allowlist, safe subset and bounds, fresh schema intersection.                              |
| High     | Complete profile PUTs can erase current state.                 | Build from fresh schema, preserve undeclared scores, include every format once, verify.          |
| High     | YAML complexity/parser advisories amplify hostile config.      | Patched parser, core schema, exact keys, byte/depth/count/expansion limits.                      |
| Medium   | Naming changes future filesystem layout and can poison output. | Complete review, token/path checks, controls rejection, sanitized advisory examples.             |
| Medium   | One API key grants broad authority.                            | One hardened transport, secret-free errors/results, explicit approval.                           |
| Medium   | Built-in content is a supply-chain policy input.               | Reviewed local immutable data, versions/digests, no automatic fetching/apply.                    |

No raw credential, header, environment value, generated envelope, raw response body, or arbitrary
cause is persisted or rendered. The digest is an integrity identifier, not a signature.

### Technical Risks

- A local origin lock cannot coordinate multiple administrative hosts; document this deployment
  boundary and fail safely within one host.
- Server normalization can create perpetual drift; accept only fixture-tested canonicalization.
- Large but byte-bounded recursive responses can exhaust work; projectors enforce semantic limits
  and reject rather than truncate authorization state.
- A narrow regex subset rejects some valid Lidarr expressions; safety and deterministic review take
  priority in v1.
- Journaling failure after a server write can leave an uncertain local record; stop admissions and
  reconcile from fresh state on rerun.
- The feature is broad across facade, config, command, completions, and docs. Keep layers
  independently testable and add only contract-critical tests.

## Task Breakdown Preview

| Task                                | Dependencies                      | Parallel opportunity                                 | Acceptance evidence                                 |
| ----------------------------------- | --------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Domain/config/built-in contracts    | none                              | config and fixture work may split after types freeze | strict parser and built-ins validate                |
| Rich projectors and client facade   | domain contracts                  | projector and config work can run together           | endpoint, body, bound, and architecture tests       |
| Pure preset engine                  | domain and live projections       | none across core semantics                           | deterministic create/update/no-op/retain fixtures   |
| Offline discovery and output        | registry/config                   | can overlap facade completion                        | list/show human and machine contracts               |
| Live diff action                    | engine and facade reads           | none                                                 | fresh zero-write full diff                          |
| Safe apply action                   | diff, facade writes, lock/journal | none                                                 | ordered, verified, stale/uncertain/second-run tests |
| Command/completion/docs integration | stable actions/results            | shell/docs can overlap late implementation           | Bash/Zsh/Fish parity and exact docs                 |
| Review and release validation       | all implementation                | review lenses can run in parallel                    | critical gates, review fixes, green CI              |

## Decisions Needed

All architecture and v1 product decisions are frozen in this specification. During implementation,
the exact built-in quality names, groups, cutoffs, conditions, scores, and naming tokens must be
derived from the committed supported Lidarr fixtures and recorded in tests and user documentation.
If those fixtures cannot support a real non-placeholder pack or if current generated operations are
insufficient, stop that implementation task and revise this specification rather than silently
reducing issue scope.

Capability probing, not one marketing version string, defines the supported floor. Naming examples
remain advisory. The origin lock is local-only. Stop-on-first-nonconverged-write is the v1 failure
policy. JSON is the lossless machine format, while CSV is spreadsheet-safe and structurally
complete.

## Research References

- [Business requirements](./research-business.md)
- [External APIs and competitors](./research-external.md)
- [Technical design](./research-technical.md)
- [UX design](./research-ux.md)
- [Security analysis](./research-security.md)
- [Engineering practices](./research-practices.md)
- [Consolidated recommendations](./research-recommendations.md)
