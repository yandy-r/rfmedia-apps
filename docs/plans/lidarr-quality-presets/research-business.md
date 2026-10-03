# Business Research — Lidarr Quality Presets and Configuration Management

## Executive Summary

Issue #213 should make Lidarr's shared quality configuration reviewable and repeatable without
turning a preset into an opaque "best settings" button. The user value is a portable desired-state
pack that explains its assumptions, compares them with one live Lidarr instance, validates every
server-specific reference, and converges only the resources the pack owns. A second run against the
same state must be a no-op.

This feature is different from the shipped `lidarr plan artist-profiles` workflow. That command
assigns an existing quality-profile ID to selected artists; issue #213 creates or updates the
quality profile itself, the custom formats and scores it depends on, and Lidarr's singleton naming
configuration. These resources have dependency and blast-radius relationships: changing one
quality profile affects every artist assigned to it, changing one custom format can affect several
profiles, and naming changes affect future imports or explicit rename operations.

The recommended initial ownership rule is conservative: manage named resources declared by the
selected pack, retain every unrelated resource, and never infer deletion from omission. A preset
must disclose its quality target, upgrade policy, storage and bandwidth tradeoffs, custom-format
intent, naming layout, compatibility range, and whether it changes an existing resource. Diff and
dry-run are read-only; apply uses the same validation and fresh-state comparison, reports partial
convergence honestly, and is safe to rerun after a recoverable failure.

## User Stories

- As a new Lidarr operator, I can select a curated baseline and understand the listening-quality,
  storage, bandwidth, and upgrade assumptions before changing my server.
- As an experienced operator, I can declare quality profiles, custom formats, scores, and naming
  conventions in configuration instead of reproducing web UI changes on every instance.
- As a cautious operator, I can see which resources would be created, updated, retained, or left
  unchanged, including field-level before/after values, before approving apply.
- As an operator with local customization, I can apply one preset without deleting or overwriting
  unrelated profiles and custom formats.
- As an operator, I can see how many artists use a profile that will change and which profiles
  reference a custom format that will change.
- As an operator, I can validate naming templates against the connected Lidarr version and inspect
  representative path examples before saving them.
- As an automation author, I can run diff and dry-run in a machine-readable format with stable
  classifications and a nonzero result when configuration is invalid or apply is incomplete.
- As an automation author, I can apply the same desired state repeatedly and receive an unchanged
  result after convergence.
- As an operator recovering from a failed apply, I can see what succeeded, what failed, what was
  not attempted, and safely rerun the same desired state.
- As a security-conscious operator, no API key or secret-derived value appears in preset
  definitions, diffs, plan artifacts, logs, or machine output.
- As an existing user, my current Lidarr status, list, search, album, artist-profile, artist-tag,
  and plan/apply workflows continue to behave as before.

## Business Rules

### Desired-state source and preset provenance

1. A run must have exactly one unambiguous desired-state source: a named built-in pack or an
   explicitly selected configured pack. If combining a baseline with user overrides is supported,
   the merge order and final resolved state must be shown before live comparison.
2. No preset is applied merely because it exists in the config file. Selection and apply approval
   remain explicit.
3. A built-in pack has a stable identifier and a version. The diff records both so a future CLI
   release cannot silently reinterpret an already reviewed pack name.
4. Built-in packs are local, reviewed release content. Normal diff/apply does not fetch a changing
   community profile from the network.
5. Every pack must disclose:
   - intended audio quality and accepted codecs or quality groups;
   - whether upgrades are enabled and the stopping cutoff;
   - minimum and cutoff custom-format scores;
   - custom-format scoring rationale;
   - naming and folder layout examples;
   - expected storage and bandwidth tradeoffs;
   - supported Lidarr feature/version assumptions; and
   - whether applying it can change an existing resource used by artists.
6. "Curated" does not mean universally optimal. Human and machine output must identify assumptions
   as pack policy rather than as facts inferred from the user's library.
7. User-defined resources must pass the same validation as built-in resources. A built-in preset
   is not exempt from live compatibility checks.
8. Config values must be structurally validated with precise property paths. Typos in managed
   profile, custom-format, or naming keys must not be accepted as a successful empty policy.

### Resource identity and ownership

1. Configuration is portable across Lidarr instances, so desired resources are identified by
   unique normalized names, not by server-local numeric IDs.
2. Name matching is exact after trimming and case normalization; fuzzy matching is not allowed.
   Zero matches means create when creation is valid. Multiple normalized matches are ambiguous and
   block the run.
3. After resolution, live numeric IDs are authoritative for references within that run. The diff
   must display both the portable name and resolved ID.
4. A same-name resource is treated as managed and eligible for update only after its complete live
   shape can be read and validated. An incomplete or malformed server response blocks mutation.
5. A differently named resource is unrelated. The tool must not infer that it is an older name of
   a desired resource, rename it, or transfer references without explicit migration metadata.
6. Omission is not deletion. Unlisted quality profiles and custom formats remain untouched.
   Automatic pruning is outside the safe baseline unless separately authorized and designed.
7. The first version should not delete profiles or custom formats. Deletion has cross-resource and
   artist-assignment consequences that are not represented by a simple desired-state omission.
8. Server-managed fields such as numeric IDs are excluded from semantic diff. Behavioral order,
   including quality priority and nested quality groups, is not normalized away.
9. Text values are compared exactly after only documented transport normalization. The tool must
   not silently rewrite naming templates, regular expressions, or custom-format field values.

### Quality profiles

1. A managed quality profile is a complete behavioral definition, not merely a name. Its diff must
   cover allowed quality items and groups, their order, upgrade policy, quality cutoff, minimum
   format score, cutoff format score, and per-custom-format scores.
2. Every referenced quality item and cutoff must resolve against the connected Lidarr profile
   schema. Missing, duplicate, or unsupported qualities block the entire run before writes.
3. A cutoff must refer to an allowed quality or group. Score thresholds and upgrade settings must
   be internally coherent; contradictory settings fail validation rather than being repaired.
4. Nested quality groups and priority order are behaviorally significant. Reordering them is an
   update even when the same qualities remain allowed.
5. Every custom format referenced by a profile must resolve to the custom format created or matched
   in the same desired-state pack. A dangling score entry blocks apply.
6. Duplicate custom-format score entries are invalid. A score of zero remains explicit policy and
   must not be dropped as if absent.
7. Updating a profile used by artists is not a local cosmetic edit. Diff must report its current
   artist-assignment count and warn that future grabs and upgrade eligibility may change.
8. Applying a profile definition does not reassign artists to it. Artist assignment remains the
   separate, already shipped `lidarr plan artist-profiles` workflow.
9. Applying a profile does not trigger an automatic search or download command. The result must not
   imply that the library was upgraded immediately.

### Custom formats

1. A managed custom format includes a unique name, `includeCustomFormatWhenRenaming`, and a complete
   ordered set of specifications with implementation, negate/required flags, and typed fields.
2. Specifications must be validated against the live custom-format schema. An implementation or
   field accepted by one Lidarr version must not be assumed valid on another.
3. Unknown fields, invalid field types, invalid regular expressions, and unsupported
   implementations fail before the first write.
4. Specification order is preserved unless Lidarr's live response proves it non-semantic.
   Deterministic display order must not change the request's behavioral order.
5. A changed custom format must report every quality profile that currently scores it. The
   custom-format definition and the profile's score are separate changes and must not be conflated.
6. Setting `includeCustomFormatWhenRenaming` affects future naming tokens or rename behavior; it
   does not itself rename existing files.
7. A custom format created in the current run must be read back and assigned its server ID before
   dependent quality profiles are written.
8. Existing unmanaged custom formats and their scores in unmanaged profiles remain untouched.

### Naming conventions

1. Lidarr naming configuration is a singleton resource, not a named collection. Diff must show
   each managed field and the connected resource ID.
2. The managed state may include track renaming, illegal-character replacement, colon replacement,
   standard and multi-disc track formats, artist-folder format, and the remaining server-supported
   naming fields. Omitted fields are unmanaged only if partial naming ownership is explicitly part
   of the config contract; otherwise the pack must provide a complete naming policy.
3. Empty templates are not automatically valid. Required templates depend on the selected naming
   switches and must be validated as one coherent configuration.
4. Token validity is Lidarr-version-specific. Validation must use the connected instance's naming
   capabilities or examples, not a permanently hard-coded token list alone.
5. Diff and dry-run show representative standard-track, multi-disc, and artist-folder examples.
   If Lidarr cannot produce valid examples, naming apply is blocked.
6. Validation warnings that merely describe unusual but valid output may be reviewable; errors
   involving unknown tokens, invalid templates, or path-unsafe output are blocking.
7. Applying naming configuration affects future imports and explicit Lidarr rename operations. It
   must not issue a rename command or move existing files as an implicit side effect.
8. Paths displayed in examples are untrusted server output and must be rendered safely.

### Diff, dry-run, and apply safety

1. Diff performs fresh reads with stale-cache fallback disabled. Cached configuration cannot
   authorize a write.
2. Diff is deterministic for the same desired and live states and classifies each managed resource
   as `create`, `update`, or `unchanged`; unrelated resources are `retained`, not `delete`.
3. Each update includes field-level before/after state. Summaries include counts by resource type,
   assigned-artist impact, profile/custom-format dependencies, assumptions, and warnings.
4. A diff with no changes is successful and clearly reports convergence.
5. Validation is all-or-nothing. Unknown references, ambiguous names, unsupported schema elements,
   malformed live resources, or invalid naming examples prevent every mutation.
6. `--dry-run` uses the same desired-state resolution, live reads, validation, dependency
   resolution, and output as real apply, but performs no create/update/delete request and writes no
   apply history or deferred intent.
7. Real apply requires the repository's existing approval convention: interactive review and
   confirmation in human mode, or explicit `--yes` in non-interactive and machine-output modes.
8. Immediately before mutation, apply must confirm that each resource still matches the observed
   state used for the reviewed diff. Unexpected drift blocks that resource and any dependent
   resources; it is never overwritten by a hidden force mode.
9. Apply orders dependencies as:
   - create or update custom formats;
   - read back and resolve custom-format IDs;
   - create or update quality profiles with resolved score references; and
   - update the independent naming singleton.
10. A resource already at desired state is `satisfied` and is not written.
11. The Lidarr API offers no transaction spanning these resource types. Apply must not claim
    atomicity. It records `succeeded`, `satisfied`, `failed`, `uncertain`, and `not-attempted`
    outcomes so partial state is visible.
12. On a definitive validation rejection, dependent writes are not attempted. On an ambiguous
    network result, the resource is `uncertain`; apply re-reads it before deciding whether a rerun
    may safely retry.
13. Recovery is convergence-based. Re-running the same desired state skips successful resources,
    reconciles uncertain resources from live state, and attempts only remaining changes.
14. A failure applying naming configuration does not roll back already converged custom formats or
    profiles. The result is partial and nonzero until a later run converges all managed resources.
15. Plans, diffs, logs, and machine envelopes are secret-free and target one canonical Lidarr
    origin. An origin mismatch blocks apply.

### Edge cases

- A preset name collides case-insensitively with two existing profiles: block as ambiguous.
- A desired custom format exists, but its live response omits specifications: block rather than
  replacing unknown state.
- Lidarr lacks a custom-format implementation used by the selected pack: report incompatibility and
  perform zero writes.
- A quality profile references a desired custom format that failed creation: mark the profile
  `not-attempted`; never send a placeholder ID.
- A custom format is unchanged but its server ID differs across instances: resolve the local ID and
  avoid a false diff.
- A profile contains the same qualities but in a different priority order: report an update.
- A profile is already desired but hundreds of artists use it: report `unchanged` with the impact
  count; do not warn that an apply will change those artists.
- A configured score is `0`, a boolean is `false`, or a template contains whitespace: preserve the
  explicit value rather than treating it as omitted.
- A custom-format or quality-profile update succeeds but the connection drops before response:
  classify as uncertain, read back, and do not blindly create a duplicate.
- Lidarr normalizes a submitted resource on write: compare the read-back semantic state and report
  server normalization; do not loop forever on non-behavioral fields.
- Naming validation returns examples containing control characters or terminal escapes: sanitize
  output without accepting unsafe path content.
- `renameTracks` is disabled while templates differ: show the templates and their dormant status;
  do not imply existing files will move.
- The selected pack is from a newer CLI version than the running CLI understands: fail explicitly,
  not as a partially ignored config.
- Config contains a misspelled preset field: fail with its path rather than silently dropping it,
  even though existing Lidarr connection validation currently drops unknown nested keys.

## Workflows

### Primary: inspect and apply a baseline

1. The operator selects one built-in or configured pack.
2. The CLI displays the pack ID, version, provenance, compatibility, and explicit assumptions.
3. It validates the resolved configuration locally, connects to one canonical Lidarr origin, and
   fetches fresh custom-format, quality-profile/schema, naming, naming-example, and artist-impact
   state.
4. It resolves names to live IDs, validates server support, constructs the dependency graph, and
   computes a deterministic semantic diff.
5. The operator reviews creates, updates, unchanged resources, retained unmanaged resources,
   naming examples, impact counts, and warnings.
6. Diff stops read-only. Dry-run performs the same complete preflight and also stops read-only.
7. Real apply obtains approval, revalidates observed state, then converges resources in dependency
   order.
8. It reads back each write, records the outcome, and prints a final complete, partial, or failed
   summary.
9. A subsequent diff reports zero changes when Lidarr retained the desired state.

### Primary: use a configured desired state

1. The operator defines a named pack under the validated Lidarr configuration section.
2. The CLI resolves any declared baseline and explicit overrides using documented precedence.
3. It prints the fully resolved pack, not only the override fragment.
4. The remaining diff, dry-run, approval, apply, and verification behavior is identical to a
   built-in pack.

### Recovery: live drift before apply

1. Apply detects that a reviewed resource changed after diff.
2. It performs no write to the drifted resource or its dependents.
3. The result identifies expected, observed, and desired state and directs the operator to review a
   fresh diff.
4. The operator either accepts the new state through config or reruns diff and approves the newly
   computed change.

### Recovery: partial or uncertain apply

1. Apply stops dependent work after a failed or uncertain prerequisite and reports all already
   durable outcomes.
2. The operator fixes the compatibility, validation, connectivity, or permission problem.
3. A rerun reads all managed resources fresh.
4. Resources already matching desired state become `satisfied`; uncertain resources are reconciled
   by observed state; only remaining changes are attempted.
5. Completion is reported only when every managed resource is `succeeded` or `satisfied`.

## Domain Model

| Concept              | Business meaning                                            | Identity and state                                                          |
| -------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| Preset pack          | Versioned, curated desired state plus disclosed assumptions | Stable pack ID, version, provenance, compatibility, assumptions             |
| Resolved pack        | Exact desired state after any documented override merge     | Custom formats, quality profiles, naming policy                             |
| Custom format        | Named release-matching policy                               | Name, rename inclusion, complete specifications                             |
| Specification        | One predicate within a custom format                        | Implementation, required/negated flags, typed fields                        |
| Quality profile      | Acquisition and upgrade policy assigned to artists          | Name, ordered qualities/groups, cutoff, scores, upgrade policy              |
| Format score         | Relationship between one profile and one custom format      | Resolved custom-format ID, score                                            |
| Naming configuration | Singleton future import/rename policy                       | Resource ID, switches, templates, separators, number style                  |
| Live schema          | Capabilities of the connected Lidarr version                | Quality items, custom-format implementations/fields, naming tokens/examples |
| Managed resource     | A live resource whose name is declared by the pack          | Absent, drifted, or converged                                               |
| Unmanaged resource   | Existing resource outside the pack's ownership              | Retained and never inferred as deletable                                    |
| Diff entry           | Review unit for one resource                                | `create`, `update`, `unchanged`, or `retained`; before/after and impact     |
| Dependency edge      | A prerequisite relationship                                 | Custom format before a quality profile that scores it                       |
| Apply outcome        | Durable operator-facing result                              | `succeeded`, `satisfied`, `failed`, `uncertain`, `not-attempted`            |

The normal managed-resource transition is `absent -> create -> converged` or
`drifted -> update -> converged`. A prerequisite failure leaves its dependents `not-attempted`.
An ambiguous response produces `uncertain`; a fresh read then moves it to `converged` or back to
`drifted` for a safe retry. Unmanaged resources remain `retained` throughout.

## Existing Codebase Integration

| Existing area                                                  | Reusable business contract                                                                               | Gap or constraint for issue #213                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/actions/lidarr/plan-artist-profiles.ts`                   | Fresh reads, exact ID/name resolution, deterministic no-op-aware plans                                   | Assigns profiles to artists; does not manage profile definitions                                             |
| `src/actions/lidarr/plan-artist-tags.ts`                       | Explicit ownership modes, normalized state, fail-closed resolution                                       | Demonstrates why omission and replacement need different authority                                           |
| `src/actions/lidarr/apply.ts`                                  | Origin binding, dry-run, approval, preflight, live re-read, history, resume                              | Current entries target artists/albums, not shared configuration resources                                    |
| `src/lib/lidarr/plan-engine.ts` and `src/types/lidarr-plan.ts` | Strict checksummed artifacts, risk summaries, bounded input, exact operation allowlist                   | Current plan versions have no quality-definition, custom-format, or naming operation                         |
| `src/actions/lidarr/apply-resources.ts`                        | Resource IDs are authoritative; renames are warnings; missing references block writes                    | Only preflights profile/tag references used by artist plans                                                  |
| `src/lib/lidarr/client.ts`                                     | Stable facade, typed errors, cancellation, local-only scheduling                                         | Exposes only quality-profile name/ID listing; no profile CRUD, custom-format, or naming facade               |
| `src/lib/lidarr/generated/*`                                   | Pinned API contains profile/custom-format CRUD and naming GET/PUT/example operations                     | Generated types are optional/nullable and naming/custom-format schema responses are not strict domain models |
| `src/lib/config.ts` and `src/types/config.ts`                  | `lidarr` owns connection, resilience, and scheduler settings with path-aware validation                  | No preset schema; existing nested validators may silently drop unknown keys                                  |
| `src/commands/lidarr.ts`                                       | Human/machine parity, explicit `--yes`, safe `--dry-run`, grouped command help                           | Existing `lidarr apply` accepts only a saved mutation-plan file                                              |
| Artist profile/tag and apply tests                             | Prove fresh reads, no mutation during planning/dry-run, no-op handling, stale blocking, partial recovery | New tests need shared-resource dependency, read-back, schema compatibility, and singleton naming cases       |

The generated snapshot confirms the required API surface exists: quality profiles support
list/create/read/update/delete and schema reads; custom formats support
list/create/read/update/delete, bulk toggles, and schema reads; naming supports singleton read,
ID-based update, and example generation. Availability in generated code is not yet a product
capability: commands and actions must continue to consume strict domain values through the stable
facade rather than generated wire shapes.

Quality-profile assignment is already classified as medium risk because it changes future
acquisition policy. Definition changes deserve at least the same review prominence, with higher
impact messaging when a profile is assigned broadly or a custom format is referenced by multiple
profiles. Naming configuration is non-destructive in this scope because no rename command is sent,
but its future file-layout effect must remain visible.

## Success Criteria

1. A built-in preset exposes a stable ID/version and all required assumptions in human and machine
   output before apply.
2. Configured packs validate every supported field and reject unknown or mistyped managed keys with
   an exact config property path.
3. Against fixture state, diff deterministically classifies custom formats, quality profiles, and
   naming as create/update/unchanged and shows field-level changes, dependencies, and impact counts.
4. Unrelated live profiles and custom formats are reported as retained and receive no mutation
   request.
5. Missing or ambiguous names, unsupported custom-format schema, invalid quality cutoffs, dangling
   format scores, and invalid naming examples all fail before any mutation.
6. Dry-run performs the same fresh reads, validation, dependency resolution, and result projection
   as real apply while issuing zero create/update/delete requests and writing no history.
7. Real apply creates or updates custom formats before dependent quality profiles, resolves
   server-assigned IDs by read-back, and never sends a placeholder or stale ID.
8. Every changed resource is read back and semantically verified. A second apply of the same pack
   issues zero mutations.
9. Concurrent operation-relevant drift blocks the affected resource and its dependents rather than
   overwriting it.
10. A definitive prerequisite failure yields explicit failed/not-attempted outcomes; an ambiguous
    result yields uncertain and is reconciled safely on rerun.
11. Naming templates are validated against the connected server and produce safely rendered
    representative examples. Apply changes configuration only and does not rename or move files.
12. Profile diffs report current artist-assignment counts; custom-format diffs report referencing
    quality profiles.
13. Human, JSON, YAML, and CSV output can distinguish desired source, assumptions, creates,
    updates, unchanged/retained resources, warnings, and all apply outcomes.
14. API keys and other sensitive fields are absent from config diagnostics, diff/apply output,
    artifacts, logs, and snapshots.
15. Existing Lidarr command hierarchy and artist/album plan/apply behavior remain regression-tested
    and unchanged.

## Open Questions

1. What exact baseline packs ship initially, and who owns their policy review? The issue requires
   curated presets but does not define accepted codecs, cutoffs, scores, or naming layouts.
2. Are preset versions pinned explicitly in user config, or does upgrading `rfmedia-cli` make a
   named preset float to a newer definition? Pinning is safer and makes upgrades reviewable.
3. Is the command model a specialized `diff`/`apply` workflow or an extension of the existing sealed
   `lidarr plan`/`lidarr apply` artifact contract? The current plan schema cannot represent shared
   configuration resources.
4. Does configured desired state support inheritance from one built-in pack? If so, which fields
   replace complete collections and which merge by name?
5. Does a pack own the complete naming singleton or only declared naming fields? Partial ownership
   reduces collisions; complete ownership is easier to reason about and reproduce.
6. Is deletion/pruning explicitly out of scope for the first release? If later supported, it needs
   separate authority, usage analysis, and dependency-safe migration behavior.
7. What minimum Lidarr version is supported for custom formats and naming example validation, and
   how should an older instance report incompatibility?
8. Which semantic normalizations are proven safe after Lidarr read-back? This must be decided per
   field to avoid both false drift and hidden behavior changes.
9. Should apply continue independent naming work after a profile/custom-format failure, or stop all
   later admissions? A stop-on-prerequisite-failure rule is clear, but naming is independent.
10. Is automatic rollback expected after partial apply? The recommended baseline is convergence on
    rerun because cross-resource rollback can be more destructive than the original failure.
11. Should preset application include optional artist reassignment? The recommended scope keeps it
    separate and composes with the existing `artist-profiles` workflow.
12. Should the feature ever trigger searches or rename existing files? The recommended initial
    contract explicitly does neither.
13. How are server-returned naming examples judged path-safe across Linux, macOS, Windows, and the
    user's actual Docker mount conventions?
14. Should unknown keys remain silently dropped elsewhere in `lidarr` config while preset sections
    reject them, or should issue #213 establish strict unknown-key behavior for the entire section?
