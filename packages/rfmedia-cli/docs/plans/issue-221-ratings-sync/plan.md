# Implementation Plan: `rfmedia lidarr sync-ratings` (#221)

**Status:** authoritative implementation plan. Supersedes `design.md` wherever §A below says so.
**Package:** `packages/rfmedia-cli`. **Tree verified at:** `d5f9c395`.

Read `design.md` first for intent. Read §A of this file before writing a single line: it corrects
nine factual errors and eighteen missed hazards in that design, and two of the corrections change the
**command surface** and the **completion contract**, not just a citation.

---

## A. Reconciliation — corrected facts and their implementation impact

Every row below was independently re-verified against source while writing this plan. Where a
correction invalidates part of `design.md`, the replacement is stated explicitly.

### A.1 Engine seam (`src/lib/bridge/policy-engine.ts`)

**A.1.1 — `resolvePolicyConfig`'s third parameter is `qualityProfiles`, not `qualityProfilesSlot`.**
Verified `policy-engine.ts:323-327`. Cosmetic in the flow diagram (`design.md:307`); no code impact.
Fix the diagram when copying the design into the shipped plan folder.

**A.1.2 — `resolvePolicyConfig` is called TWICE per evaluation, not once.**
`src/actions/lidarr/policy-evaluate.ts:247-252` (`resolveGatherLibrary`) calls it **before any
gather**, with a synthetic `notRequestedSlot("lidarrQualityProfiles")`, purely to read `.plexLibrary`
(invoked at `policy-evaluate.ts:403`). The second call is inside the engine at `policy-engine.ts:815-819`.

_Impact:_ every new override MUST be side-effect-free, cheap, and **inert against a `not-requested`
profile slot**. `resolveTargetProfileId` already early-returns `null` when
`slot.status !== "available"` (`policy-engine.ts:288-290`), so `ratingTargetQualityProfile` is safe —
but this is now a **required test case** (T2-c below), not an assumption. Design §4.3's "the ONLY
engine change / single call site" framing is wrong and must be reworded.

**A.1.3 — `overrides.maxProposals` line citations were wrong; the seed default is 10, not 25.**
Actual lines carrying `overrides.maxProposals`: `policy-engine.ts:341` (rating), `:353` (stale),
`:361` (seed). The resolved **field** names are `maxProposals`, `maxProposals`, and **`maxSeeds`**
(`types/lidarr-policy.ts:341,358,366`); `ratingMaxProposals` / `staleMaxProposals` / `seedMaxSeeds`
are `POLICY_DEFAULTS` **keys** (`policy-engine.ts:134-144`) with values `25 / 25 / 10`.

_Impact:_ `design.md:124`'s option table says "Default `25`" for every rule — **wrong for
`discovery-seed`** (10). The `--max-proposals` help text and the feature doc must say: _"a per-rule
cap, not a run total; it replaces each rule's own cap (`rating` 25, `stale` 25, `seed` 10)."_
Design §9 risk 2's citation `policy-engine.ts:337,352,360` is wrong → `341,353,361`.

**A.1.4 — `forceEnable` does not exist; it is new. The `disabled` gate is at `:770`, not `:769`.**
`grep -rn forceEnable packages/rfmedia-cli/src/` → zero hits. `PolicyEvaluationOverrides`
(`policy-engine.ts:211-214`) has exactly `plexLibrary` and `maxProposals`. Gate ordering **is**
confirmed: `not-selected` at `:765-766` precedes `if (!resolved.enabled)` at `:770-771`. The gate
reads `input.policy.rules[id].enabled` — the value `resolvePolicyConfig` produced — so routing
`forceEnable` through `resolvePolicyConfig` is the correct **and only** seam.

**A.1.5 — §4.3's own edit count is internally inconsistent (`4` vs `5` vs `6`).**
Replace both counts with this exact line-by-line list against current source:

| Site                   | Current                                                              | Becomes                                                                             |
| ---------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `policy-engine.ts:332` | `const targetQualityProfile = rating?.targetQualityProfile ?? null;` | `overrides.ratingTargetQualityProfile ?? rating?.targetQualityProfile ?? null`      |
| `policy-engine.ts:336` | `enabled: rating?.enabled ?? false,`                                 | `enabled: forceEnabled("rating-quality-upgrade", rating?.enabled),`                 |
| `policy-engine.ts:337` | `minRating: rating?.minRating ?? POLICY_DEFAULTS.ratingMinRating,`   | `overrides.ratingMinRating ?? rating?.minRating ?? POLICY_DEFAULTS.ratingMinRating` |
| `policy-engine.ts:346` | `enabled: stale?.enabled ?? false,`                                  | `enabled: forceEnabled("stale-monitoring-cleanup", stale?.enabled),`                |
| `policy-engine.ts:347` | `maxPlays: stale?.maxPlays ?? POLICY_DEFAULTS.staleMaxPlays,`        | `overrides.staleMaxPlays ?? stale?.maxPlays ?? POLICY_DEFAULTS.staleMaxPlays`       |
| `policy-engine.ts:358` | `enabled: seed?.enabled ?? false,`                                   | `enabled: forceEnabled("discovery-seed", seed?.enabled),`                           |

Six changed expressions plus the one `forceEnabled` helper. `POLICY_DEFAULTS` remains the single
defaults site (module-private, referenced only inside this function — verified).

**A.1.6 — HAZARD (new, blocking): `forceEnable` on `rating-quality-upgrade` with no target profile
produces a `degraded` report for a pure operator omission.**
The §16.1 gate `findUnresolvedTargetProfile` (`policy-engine.ts:486-491`) early-returns `undefined`
when `targetQualityProfile === null`, so the rule **dispatches**, then hits
`policy-rule-rating-upgrade.ts:92-98` → `{ ruleSkip: { reason: "signal-unavailable", … } }`, which
`policy-engine.ts:791` converts with `degraded` hard-coded `true`. The detail string never names
`--quality-profile` and carries no available-profile list. Today unreachable (rule ships
`enabled: false`); `forceEnable` is exactly what makes it reachable.

_Required:_ validate in the **command**, before `loadActions()`: if `quality-profile` is among the
selected decisions and **neither** `--quality-profile` **nor**
`policy.rules.rating-quality-upgrade.targetQualityProfile` is set, throw
`MissingRequiredArgumentError("--quality-profile is required when the quality-profile decision is
selected and policy.rules.rating-quality-upgrade.targetQualityProfile is unset")`. This reads the raw
config through `getLoadedPolicyConfig()` — which the command may call because it is a pure
synchronous read of already-validated config (`lib/loaded-config.ts:76`), no I/O. Add as command test
case T6-b2.

**A.1.7 — HAZARD (new): under `forceEnable`, `report.policy.rules[id].enabled` is contaminated.**
`policy-engine.ts:336/346/358` write `enabled` into the frozen resolved rule, echoed verbatim into
the report at `:883`. The design's §5.5 G1 tri-state is derived from the **raw** config.

_Required:_ §4.3/§5.5 must state that `report.policy.rules[id].enabled` is override-contaminated and
MUST NOT be the presenter's source for decision state/provenance — the presenter takes that from the
raw `PolicyConfigOptions` the action already read and echoed on `LidarrSyncRatingsReport`. Pin the
contamination as a documented property with an assertion in T2's engine test.

**A.1.8 — HAZARD (new): `--quality-profile` inherits numeric-first coercion.**
`policy-engine.ts:294-300`: `Number(trimmed)` + `Number.isSafeInteger` is tried **before** any name
match, so a profile literally named `"320"`, `"2024"` or `"3.0"` (`Number("3.0") === 3`) silently
resolves to whichever profile has that **id**.

_Required:_ document numeric-first precedence in the option table and the feature doc; the
sync-ratings report echoes the **resolved id + name pair** (`cohort.resolvedProfileId` +
`cohort.qualityProfileName`, both already in the type) and the presenter renders both so a
mis-resolution is visible before `--mode apply`.

### A.2 Producers and apply

**A.2.1 — the `maxBatch` throw reachable from V3 is at `plan-engine.ts:1681-1682`, not `:1608`.**
`:1608` lives in `buildLidarrMutationPlan` (V1, declared `:1601`), which `buildLidarrMutationPlanV3`
(`:1926-1934`) never calls; V3 delegates to `buildLidarrMutationPlanV2` (`:1674`) whose identical
check is at `:1679-1683`. Throw type is `LidarrPlanValidationError` via `validationError`
(`src/lib/lidarr/plan-validation.ts:11`). Citation-only fix; behaviour unchanged.

**A.2.2 — the `@throws` taxonomy on `executeLidarrSyncRatings` is WRONG for the profile path.**
`design.md:916-917` claims `LidarrPlanValidationError` for a vanished artist id, an unresolvable
profile, and an over-cap cohort. On the **artist-profile-assignment** path every one of those is a
plain `Error`/`TypeError` from `src/lib/lidarr/artist-selection.ts`: `:187` (`Unknown artist IDs:`),
`:133-137` (`Unknown profile reference`), `:366-368` (`exceeding maxBatch`), `:160-162`
(`TypeError: maxBatch must be a positive safe integer…`), `:152` (`Exactly one artist selection mode
is required…`). Only the **monitoring** producer's vanished-id path is typed (`plan.ts:81-83`).

_Required:_ widen the documented throw set to `{Error}` for the profile-cohort path. **Do NOT assert
`LidarrPlanValidationError` in tests for profile-cohort failures.** Keep the failure envelope generic:
`reportLidarrFailure` already handles `unknown`.

**A.2.3 — HAZARD (new): the profile producer can fail on the cohort's BEFORE state.**
`plan-artist-profiles.ts:256-265` re-resolves **every** cohort artist's current
`qualityProfileId` against the live list via
`resolveLidarrProfileReference(String(artist.qualityProfileId), context.qualityProfiles)`. An artist
whose current profile was deleted → `Unknown profile reference` Error (`artist-selection.ts:133`); an
artist with `qualityProfileId === 0` → `TypeError: profile ID must be a positive safe integer`
(`:64-69`, `value > 0`). This throws **mid-run**, after the full Plex drain and possibly after
artifact #1 is already on disk.

_Required:_ §6.9 must state the profile producer can fail on the artists' BEFORE state. **No pre-seal
filter is added** (the action holds no live artist list and adding one would duplicate the producer's
read) — instead the feature doc's Troubleshooting table gets a row for it, and the partial-failure
narrative covers it. This is a documentation + `@throws` change only.

**A.2.4 — the cohort assertion must be two-sided and name both caps.**
`types/lidarr-plan.ts:14` `LIDARR_PLAN_MAX_BATCH = 1_000` **and** `:15`
`LIDARR_PLAN_MAX_ENTRIES = 1_000` are enforced independently at `plan-engine.ts:1679-1685`.
Separately, `artist-selection.ts:158-163` validates `maxBatch` and `:365-368` caps the cohort — for
the profile producer this fires **first**. An empty cohort fails even earlier at `:171-173`
(`Artist ID selection requires at least one ID`) and at `plan.ts:57-59`.

_Required:_ state the action's defensive assertion as `1 <= cohort.artistIds.length <=
LIDARR_PLAN_MAX_BATCH` — **lower bound included**; an empty cohort must be filtered out before the
producer call (it already is: `gate === "sealable"` requires ≥1 change). Note `LIDARR_PLAN_MAX_ENTRIES`
is a second identical cap.

**A.2.5 — drop `defaultOutputPath` from the reused-symbol list.**
Both producers own path resolution (`plan.ts:106`; `plan-artist-profiles.ts:283-285` has a private
byte-identical copy) and the design's producer calls never pass `output`. `defaultOutputPath` is
**not** on the `src/actions/lidarr/index.ts` barrel. The action reads `generated.planPath` off the
producer result. Remove `defaultOutputPath` **and** `getDefaultPlanDir` from §3.6's reused list.

### A.3 Command surface and completions

**A.3.1 — BLOCKER, design invalidated: `--apply` cannot be a boolean flag. Replaced by
`--mode <recommend|plan|apply>`.**

`bash.ts:381` classifies `--apply` as a **value-taking, file-completing** option in an **unguarded**
arm shared by every command family:

```
--file|--completed-file|--path|--protect|--plan-file|--out|--tracking-database|--history-path|--paths|--from-folder|--plan-output|--apply)
```

pinned verbatim by `templates.spec.ts:1523-1525`. Bash `case` is first-match-wins with no
fallthrough, so a later `--apply)` arm is dead code. The cloned cross-shell contract computes bash
value-options by regex over `bashScript.slice(indexOf('case "$prev" in'), indexOf("# Complete command
or options based on position"))` (`templates.spec.ts:1150-1152`, section spans `bash.ts:304-498`);
`|--apply)` matches, so bash would report `--apply` as a value option while zsh/fish report it
boolean → `expect(sorted(contract.valueOptions)).toEqual(sorted(expectedValueOptions))`
(`templates.spec.ts:1187`) fails. Behaviourally, `rfmedia lidarr sync-ratings --apply <TAB>` offers
**filenames** today.

This is not merely a completion artifact: `copy --apply <plan-file>` and `delete --apply <plan-file>`
already give `--apply` a **file-valued** meaning across this CLI. Reusing it as a boolean puts two
incompatible types behind one flag name — exactly the argument `design.md` §2.4 used to reject
`--min-rating`.

**Replacement (adopted):** collapse `--plan` + `--apply` into a single value-taking

```
--mode <mode>    recommend | plan | apply    (default: recommend)
```

Consequences, all improvements:

- The flag value **is** `LidarrSyncRatingsMode`, which `design.md:573` already declares as
  `"recommend" | "plan" | "apply"`. No derivation, no `--apply implies --plan`, no mutual-exclusion
  logic, no `OptionConflictError`.
- `bash.ts` already has a **reachable** `--mode)` arm at `bash.ts:317-327` whose `else` branch answers
  `$watch_modes`. We add one guarded `elif` — an edit to an existing arm, which is legal, unlike a new
  duplicate arm. Bash then reports `--mode` as a value option, matching zsh (`:mode:(…)`) and fish
  (`-r -xa "…"`). Cross-shell contract passes with **zero** special-casing.
- `--yes` stays boolean and is clean: no `--yes` arm exists anywhere in `bash.ts:304-498` (verified).

**Every design section that must change:** §2.2 (rung table rows become `--mode plan` / `--mode apply
--yes`), §2.3 helpGroup `Safety:` table (`--plan`/`--apply` rows → one `--mode` row), §2.6 all three
transcripts, §4.1 `LIDARR_SYNC_RATINGS_OPTION_LONGS`, §6.2 gate 1, §7.4 B2/B4, §7.5 Z2, §7.6 F3,
§7.7, §8.3 test 3.

Resulting option-longs (14, Commander declaration order = completion order):

```
--plex-library --decision --min-stars --max-plays --quality-profile --max-proposals
--mode --yes --explain --verbose --plex-url --plex-token --lidarr-url --lidarr-api-key
```

**A.3.2 — `--min-stars` cannot get its own bash value list; align zsh/fish to the shipped list.**
`bash.ts:343-346` is an **unguarded, earlier** arm answering `1 1.5 2 2.5 3 3.5 4 4.5 5` for
`--min-stars` and six siblings. A second `--min-stars)` arm is unreachable (verified empirically with
`bash --noprofile --norc`).

_Required:_ **delete** `local lidarr_sync_ratings_min_stars="1 2 3 3.5 4 4.5 5"` from §7.4 B2, and
change the zsh snippet `:stars:(1 2 3 3.5 4 4.5 5)` and the fish `-xa "1 2 3 3.5 4 4.5 5"` to the
shipped `1 1.5 2 2.5 3 3.5 4 4.5 5`. Zero bash edits for `--min-stars`; all three shells agree.

**A.3.3 — bash needs SIX edit sites, and the `case "$prev" in` block is at `304-498`, not `~355-396`.**
Confirmed: `--max-proposals)` at `:368-371` answers `1 5 10 25 50 100` unguarded (reused as-is);
`--quality-profile`, `--explain`, `--plex-library`, `--plex-url`, `--plex-token`, `--lidarr-url`,
`--lidarr-api-key` are all already in the no-completion string arm at `:393`; `--decision` and
`--max-plays` have **no** existing arm anywhere (verified by grep) and so need new arms — unguarded,
following the `--rule)` precedent at `:365-368` ("owned exclusively by …" comment), because the
literals are globally unique. B5's tab-indentation observation is real (`bash.ts:629-640` uses literal
tabs, `:641` uses eight spaces) and cosmetic; nothing asserts it, but match the neighbouring
`reconcile`/`policy` tab style by hand since Prettier does not reformat template-literal interiors.

**A.3.4 — the fish predicate must go AFTER `__fish_rfmedia_lidarr_policy_evaluate_active`.**
`templates.spec.ts:1103-1107` slices `fishScript` from `function
__fish_rfmedia_lidarr_reconcile_active` to `function __fish_rfmedia_lidarr_validate_import_active`
and asserts at `:1116` that the slice `.not.toContain('test "$cmd[2]" = "lidarr"')`. Inserting a new
predicate between them (fish.ts:1268) widens that slice. Function-definition order is otherwise
unconstrained.

_Required:_ define `__fish_rfmedia_lidarr_sync_ratings_active` **after** `fish.ts:1400`'s
`__fish_rfmedia_lidarr_policy_evaluate_active` block. Only the `needs_subcommand` **complete** lines
are order-asserted; the new one goes at `fish.ts:1543`, between the `policy` line (`:1542`) and the
`validate-import` line (`:1543`).

**A.3.5 — `renderMutationPlan` accepts a CLOSED union; reuse `LidarrMutationPlanV3`.**
`lidarr-mutation-presenter.ts:60-68` `AnyLidarrPlanGenerationResult` is presenter-private and not
exported; `LidarrPlanV3` (`types/lidarr-plan.ts:925-929`) is closed.
`LidarrSyncRatingsPlan = Extract<LidarrMutationPlanV3, { operation: { kind: "artist-monitoring" |
"artist-profile-assignment" } }>` is a **subset** of `LidarrMutationPlanV3` ⊂ `LidarrPlanV3`, and
`LidarrPlanGenerationResultV3<TPlan>` holds `TPlan` in a `readonly` position, so
`LidarrPlanGenerationResultV3<LidarrSyncRatingsPlan>` is structurally assignable to
`LidarrPlanGenerationResultV3<LidarrPlanV3>` (covariant). It typechecks **unchanged** — this is the
same `Extract` idiom both producers use privately (`plan-artist-profiles.ts:37-40`, `plan.ts:36-39`).
**Do not** add anything to the presenter-local union. If a bespoke plan version were ever needed it
would go in `LidarrPlanV3` (`types/lidarr-plan.ts:925`).

**A.3.6 — `MutationApplyPresentationOptions` has six REQUIRED fields; spell them out.**
`lidarr-mutation-presenter.ts:71-77`: `{ verbose, allowTagReplacement, allowArtistDelete,
allowAlbumDelete, allowFileDelete, plexScan }`, none optional. The literal sync-ratings passes:

```ts
{ verbose, allowTagReplacement: false, allowArtistDelete: false,
  allowAlbumDelete: false, allowFileDelete: false, plexScan: false }
```

A monitoring / quality-profile leaf is non-destructive, so all four `allow*` are `false` and
`plexScan` is `false` (no Plex write, §6.1). Same object is passed to `renderMutationApply` and
`confirmMutationApply`.

**A.3.7 — drop the "`parseIdList` is **not** injected" framing; declare `loadActions?`.**
Both shapes ship: `LidarrPolicyCommandDeps` injects `parseIdList` with a documented rationale
(`lidarr.ts:1482-1489` passes it); `LidarrReconcileCommandDeps` omits it. Either is fine — sync-ratings
omits it, no emphasis needed. `loadActions?: () => Promise<…>` is present on **both** shipped deps
interfaces as the test/embedding seam; `design.md` §4.6 already declares it, keep it.

### A.4 Evaluate action and report shape

**A.4.1 — `report.rules` is an ARRAY, not a map, and rule results carry COUNTS, not decisions.**
`types/lidarr-policy.ts:421` `readonly rules: readonly PolicyRuleResult[];`. `PolicyRuleResult`
(`:309-330`) is a three-arm union: `{id,title,status:"proposals",proposedCount,skippedCount}` |
`{id,title,status:"clean",proposedCount:0,skippedCount}` |
`{id,title,status:"skipped",skipReason,detail}`. Its status union is `"proposals" | "clean" |
"skipped"` — **not** the report-level `"clean"|"proposals"|"degraded"` (`:417`). Proposals and skips
live **only** in the flat top-level `report.proposals` / `report.skips` (`:422-423`).
`report.policy.rules` **is** keyed by rule id (`:376`), each arm carries `.kind`, and only the
`rating-quality-upgrade` arm carries `resolvedProfileId: number | null` (`:340`).

_Required:_ delete `report.rules[ruleId]` from the §2 flow diagram (`design.md:317`). Specify G2 as:

```ts
const result = report.rules.find((r) => r.id === ruleId);
if (result === undefined) throw new SyncRatingsProjectionError(ruleId, "rule absent from report");
if (result.status === "skipped") {
  /* result.skipReason and result.detail are in scope HERE only */
}
```

The engine maps over `POLICY_RULE_IDS` (`policy-engine.ts:831`), so `undefined` is an **invariant
violation** → a G4-class throw, not a G2 refusal. Per-rule decisions are recovered by filtering the
flat arrays on `.ruleId`.

**A.4.2 — `proposal.after.monitored` is a COMPILE ERROR in this package.**
`tsconfig.json:14` `noUncheckedIndexedAccess: true` and `:16` `noPropertyAccessFromIndexSignature:
true` (both verified). `before`/`after` are `Readonly<Record<string, string|number|boolean|null>>`
(`types/lidarr-policy.ts:280-286`) — a string index signature. Dot access raises TS4111; bracket
access yields `string|number|boolean|null|**undefined**`. Shipped code already pays this tax:
`lidarr-policy-presenter.ts:327-328` uses `proposal.before[key] ?? null`;
`policy-engine.ts:524-525` uses `proposal.observations["rating"]` into a helper that accepts
`undefined` (`:504`).

_Required:_ every design snippet using `after.monitored` / `after.qualityProfileId`
(`design.md:383`, `:1069-1071`, §5.6) is rewritten to bracket access, and the G4 invariant checks
**are** the narrowing site:

```ts
const next = proposal.after["monitored"];
if (typeof next !== "boolean") throw new SyncRatingsProjectionError(proposal.key, "…");
const target = proposal.after["qualityProfileId"];
if (typeof target !== "number") throw new SyncRatingsProjectionError(proposal.key, "…");
```

`SyncRatingsChange.before`/`.after` must stay declared as
`Readonly<Record<string, string|number|boolean|null>>` (they carry the proposal's maps verbatim); a
narrower declaration is not assignment-compatible. Same rule for `observations[…]`.

**A.4.3 — `subject.artistId` is OPTIONAL (`number | undefined`).**
`types/lidarr-policy.ts:231-238`, `:236` documents "Absent for a Plex-only seed subject".
`createPolicyProposal` always sets it (`policy-rule-support.ts:157-163`);
`createPolicySeedProposal` deliberately omits it (`:199-204`). `PolicyProposal` has **eleven** fields
(`:273-289`). The profile rule's `after` also carries `qualityProfileName: string`; the seed
constructor emits `before/after = { inLidarr: false }` (`policy-rule-support.ts:212-213`).

**A.4.4 — HAZARD (new, blocking): an EMPTY `rules` array silently selects ALL THREE rules.**
`policy-evaluate.ts:217-222`: `if (rules === undefined || rules.length === 0) return POLICY_RULE_IDS;`.
`POLICY_RULE_IDS` includes `discovery-seed`, whose proposals carry **no** `subject.artistId` — the
exact condition G4 turns into a thrown `SyncRatingsProjectionError`. `design.md:846-847` says
`decisions` "Undefined or empty selects every decision", so an empty resolved decision set would hand
`rules: []` to evaluate and get seed proposals back.

_Required, two changes:_

1. `executeLidarrSyncRatings` **always** forwards an explicitly non-empty `rules` array derived from
   `SYNC_RATINGS_DECISION_BINDING` — never `undefined`, never `[]`. If the resolved decision set is
   empty after G1, it returns the report **without projecting** rather than calling evaluate.
2. `buildRatingSyncPlan` filters `report.proposals` on `proposal.ruleId ∈ selectedRuleIds` **before**
   applying the G4 `subject.artistId` invariant, so a seed proposal can never be mistaken for an
   engine-invariant violation. This filter is also what §8.1's "proposals from a non-selected
   decision are excluded" case pins.

**A.4.5 — `String(resolvedProfileId)` silently accepts `null` → the literal `"null"`.**
`types/lidarr-policy.ts:340` types it `number | null`, and `String()` accepts anything. The runtime
invariant that saves it lives in a different module (`policy-rule-rating-upgrade.ts:92-99`).

_Required:_ after narrowing `report.policy.rules["rating-quality-upgrade"]` on `.kind`, assert
`typeof resolved.resolvedProfileId === "number"` and throw `SyncRatingsProjectionError` otherwise.
This becomes the **fifth** G4 invariant (design lists four).

**A.4.6 — `report.coverage` has exactly eight fields and NO `footprint`.**
`buildPolicyEvaluationCoverage` (`policy-signals.ts:475-498`) exists and is wired at
`policy-engine.ts:727`/`:889`; `PolicyEvaluationCoverage` (`types/lidarr-policy.ts:389-402`) =
`plexArtistsExamined, plexTracksExamined, authoritativeLinks, nonAuthoritativeArtists,
ambiguousNameArtists, sentinelArtistTracks, unjoinedTracks, totalPlaysObserved`. `grep -rn footprint
packages/rfmedia-cli/src` → **zero** hits.

_Required:_ `SyncRatingsFootprint` is a **new** type this feature defines. `fraction` is computed in
`rating-sync.ts` as `changedArtists / Math.max(report.coverage.authoritativeLinks, 1)`, rounded to
four decimals. It is not readable off the policy report.

**A.4.7 — decision keys have FOUR concrete forms, not one optional-suffix form.**

| Kind                      | Format                              | Source                             |
| ------------------------- | ----------------------------------- | ---------------------------------- |
| proposal (linked)         | `<ruleId>:artist:<lidarrId>`        | `policy-rule-support.ts:166,67-69` |
| proposal (discovery seed) | `<ruleId>:plex:<plexId>`            | `policy-rule-support.ts:207,78-80` |
| skip (linked)             | `<ruleId>:artist:<lidarrId>:<code>` | `policy-rule-support.ts:253-257`   |
| skip (Plex-only)          | `<ruleId>:plex:<plexId>:<code>`     | `policy-rule-support.ts:253-257`   |

Proposals **never** carry a code. `PolicyDecisionKey` is a bare `string` alias
(`types/lidarr-policy.ts:270`) — no branding, nothing enforced at compile time. Fix `design.md:138`'s
`<ruleId>:artist:<lidarrId>[:<code>]` and the §2.6 transcript's `--explain` example.

**A.4.8 — "byte-identical to `policy evaluate`" is false; restate the property.**
Counter-evidence: `report.evaluatedAt` is stamped per run (`policy-evaluate.ts:429`); the four new
overrides mutate the resolved policy echoed at `policy-engine.ts:334-362`, and `forceEnable` enables
rules the policy leaf never enables; `plexOrigin`/`lidarrOrigin` fall back to the literal
`"unknown"` (`policy-evaluate.ts:91,366-368`).

_Required replacement wording (§4.1 JSDoc on `evaluation`, and §1.2 requirement 3):_ "the
sync-ratings report embeds the **verbatim frozen `PolicyEvaluationReport` object** returned by the
unmodified `executeLidarrPolicyEvaluate`, and the projection reads only from it — so the two commands
cannot disagree about a decision." Drop "byte-identical". **No test asserts byte-identity.**

### A.5 Confirmed and unchanged

`PolicyEvaluationOverrides` widening is safe (`exactOptionalPropertyTypes` is NOT set; `PolicyRuleId`
already type-imported at `policy-engine.ts:69`). `POLICY_MAX_PROPOSALS_PER_RULE = 100`
(`:429`, plain `number`). `POLICY_PRODUCER_IDS = ["artist-profile-assignment", "artist-monitoring"]`
(`:108`) and the `producer` field on `PolicyRuleDescriptor` (`:156-157`, `null` for `discovery-seed`).
`executeLidarrArtistProfilePlan` / `executeLidarrPlan` / `executeLidarrApply` signatures, required vs
optional fields, and the `approved`/`dryRun` gates. `assertInteractiveApplyApproval` at
`lidarr-mutation-presenter.ts:975`. All five policy-presenter exports. Root `--output`/`--json`
ownership by `cli.ts`. `POLICY_HUMAN_ROW_CAP = 20` and the hard-coded "first 20" help string. The
report is deep-frozen along every path. `LIDARR_POLICY_EVALUATE_OPTION_LONGS` lives in
`src/types/lidarr-policy.ts:689` — confirming the option-longs const belongs in the **types** module,
as the design places it. The `lidarr-editor-body-owner` rule flags an object literal only when it has
`artistIds` **and** one of `{addImportListExclusion, applyTags, deleteFiles, metadataProfileId,
moveFiles, qualityProfileId, rootFolderPath, tags}` (`scripts/check-direct-plex-imports.mjs:39-47,
437-446`) — `{ artistIds, qualityProfile, maxBatch }` and `{ artistIds, monitored, maxBatch }` are
clean, **including in test fixtures**.

---

## B. Non-negotiable constraints (restated)

1. **Only critical tests. No test bloat.** §8's plan is carried forward with three deletions
   (see §D). Do not add snapshot tests, golden output, e2e, or re-tests of reused machinery.
2. **~500-line soft cap per file.** The presenter split exists for this reason. If
   `lidarr-sync-ratings.ts` drifts past ~400, move rendering, not logic.
3. **Strict TS, no `any`.** `noUncheckedIndexedAccess` + `noPropertyAccessFromIndexSignature` are on:
   bracket-access every index-signature record and narrow with `typeof` (see A.4.2).
4. **ESM with `.js` import extensions**, `verbatimModuleSyntax` → `import type` for every type-only
   import.
5. **Lazy dynamic import of actions from commands.** `deps.loadActions ?? (() =>
import("../actions/lidarr/index.js"))`, called only after all validation.
6. **Validation lives inside `.action()`, never in an `argParser`.** A throwing parser routes through
   `Command.error()` → `process.exit(1)` before the action handler, bypassing the failure envelope and
   credential redaction.
7. **Façade rule:** nothing above `src/lib/adapters/plex-adapter.ts` may import `./plex/*`. No new
   module names `src/types/plex`, `src/lib/lidarr/generated/**`, a `/api/v1/` literal, or `fetch`.
8. **CI gate:** `test:codegen:lidarr`, `codegen:lidarr:check`, build `rf-common`, `typecheck`
   (fires `check:architecture` + `test:architecture`), `test:coverage`, `bench`.
9. **`FORCE_COLOR` must be unset locally** (`env -u FORCE_COLOR …`) or two rf-common logger tests
   fail and the pre-push hook blocks.
10. **Never put `artistIds` and `qualityProfileId` in the same object literal**, anywhere, including
    fixtures — `check:architecture` runs under both `pretypecheck` and `prebuild`.

---

## C. Batches

27 files total: **11 new**, **16 modified**.

### Batch 1 — contracts (no behaviour change)

Tasks are file-disjoint and have no inter-dependency.

---

#### T1 — Contract module for sync-ratings

**Goal:** land the zero-value-import contract the command, the pure module, the action and
`templates.spec.ts` all bind to.

**Files created:**

- `packages/rfmedia-cli/src/types/lidarr-sync-ratings.ts`

**Contract (exact exported surface):**

```ts
export const SYNC_RATINGS_SCHEMA = "rfmedia.lidarr-ratings-sync.v1" as const;

export const SYNC_RATINGS_DECISIONS = ["quality-profile", "monitoring"] as const;
export type SyncRatingsDecision = (typeof SYNC_RATINGS_DECISIONS)[number];
export function isSyncRatingsDecision(value: string): value is SyncRatingsDecision;

export const SYNC_RATINGS_MODES = ["recommend", "plan", "apply"] as const;
export type LidarrSyncRatingsMode = (typeof SYNC_RATINGS_MODES)[number];
export function isSyncRatingsMode(value: string): value is LidarrSyncRatingsMode;

export interface SyncRatingsDecisionBinding {
  readonly ruleId: PolicyRuleId;
  readonly producer: PolicyProducerId;
}
export const SYNC_RATINGS_DECISION_BINDING: Readonly<Record<SyncRatingsDecision, SyncRatingsDecisionBinding>>;

export const SYNC_RATINGS_REFUSAL_CODES = [
  "decision-disabled",
  "rule-not-evaluated",
  "cross-decision-conflict",
] as const;
export type SyncRatingsRefusalCode = (typeof SYNC_RATINGS_REFUSAL_CODES)[number];
export interface SyncRatingsRefusal {
  /* design.md:497-510, unchanged */
}

export interface SyncRatingsChange {
  readonly decisionKey: PolicyDecisionKey;
  readonly artistId: number;
  readonly artistName: string;
  readonly plexId: string;
  readonly artistMbid: string | null;
  readonly before: Readonly<Record<string, string | number | boolean | null>>; // A.4.2
  readonly after: Readonly<Record<string, string | number | boolean | null>>; // A.4.2
  readonly checks: readonly PolicyThresholdCheck[];
  readonly summary: string;
}
export interface SyncRatingsCohort {
  /* design.md:529-543, unchanged */
}

export type SyncRatingsThresholdSource = "flag" | "config" | "default";
export interface SyncRatingsThreshold<T> {
  readonly value: T;
  readonly source: SyncRatingsThresholdSource;
  readonly configPath: string | null;
}
export interface SyncRatingsResolvedThresholds {
  minStars;
  maxPlays;
  qualityProfile;
  maxProposals;
}

export type LidarrSyncRatingsPlan = Extract<
  LidarrMutationPlanV3,
  { readonly operation: { readonly kind: "artist-monitoring" | "artist-profile-assignment" } }
>; // A.3.5
export interface LidarrSyncRatingsOutcome {
  decision;
  ruleId;
  producer;
  generated;
  apply?;
}
export interface SyncRatingsFootprint {
  authoritativeLinks;
  changedArtists;
  fraction;
} // A.4.6
export interface LidarrSyncRatingsReport {
  schema;
  mode;
  decisions;
  thresholds;
  cohorts;
  refusals;
  footprint;
  outcomes;
  readonly evaluation: PolicyEvaluationReport; // JSDoc per A.4.8 — NOT "byte-identical"
  /** Raw `policy.rules.*.enabled` tri-state, uncontaminated by forceEnable (A.1.7). */
  readonly decisionStates: Readonly<Record<SyncRatingsDecision, "on" | "unset" | "off">>;
}

export const SYNC_RATINGS_MIN_STARS = 1;
export const SYNC_RATINGS_MAX_STARS = 5;
export const SYNC_RATINGS_MAX_PLAYS = 1_000_000;

export const LIDARR_SYNC_RATINGS_OPTION_LONGS = [
  "--plex-library",
  "--decision",
  "--min-stars",
  "--max-plays",
  "--quality-profile",
  "--max-proposals",
  "--mode",
  "--yes",
  "--explain",
  "--verbose",
  "--plex-url",
  "--plex-token",
  "--lidarr-url",
  "--lidarr-api-key",
] as const; // A.3.1
```

Every import carries `type` (`./lidarr-plan.js`, `./lidarr-policy.js`). `decisionStates` is new
(A.1.7) — it is what the presenter renders for decision state/provenance.

**Depends on:** none.

**Verify in isolation:**

```bash
cd packages/rfmedia-cli && env -u FORCE_COLOR npx tsc --noEmit
```

---

#### T2 — Engine override seam + passthrough + engine tests

**Goal:** widen `PolicyEvaluationOverrides` with four additive optional fields, wire them into
`resolvePolicyConfig`'s six expressions, forward them from the evaluate action, and pin the whole
seam.

**Files modified:**

- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`
- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.test.ts`

**Contract:**

```ts
// policy-engine.ts:211-214 — additive only
export interface PolicyEvaluationOverrides {
  readonly plexLibrary?: string;
  readonly maxProposals?: number;
  readonly ratingMinRating?: number;
  readonly ratingTargetQualityProfile?: string;
  readonly staleMaxPlays?: number;
  readonly forceEnable?: ReadonlySet<PolicyRuleId>;
}
```

Edits are exactly the six expressions in A.1.5, plus one module-private helper immediately above
`resolvePolicyConfig`:

```ts
const forceEnabled = (id: PolicyRuleId, configured: boolean | undefined): boolean =>
  overrides.forceEnable?.has(id) === true || (configured ?? false);
```

`policy-evaluate.ts`: four optional fields on `LidarrPolicyEvaluateActionOptions`
(`ratingMinRating?`, `ratingTargetQualityProfile?`, `staleMaxPlays?`, `forceEnableRules?:
ReadonlySet<PolicyRuleId>`) and four verbatim lines in the single `overrides` literal at `:399-402`.
JSDoc on each: "#221 sync-ratings is the sole consumer; the policy leaf never sets it."

**Tests added to `policy-engine.test.ts` (~45 lines, five assertions — required, load-bearing):**

- **T2-a** each of `ratingMinRating` / `ratingTargetQualityProfile` / `staleMaxPlays` wins over both
  config and `POLICY_DEFAULTS`; `ratingTargetQualityProfile` resolves against a live profile slot into
  `resolvedProfileId`; `discovery-seed.minRating` is unaffected by `ratingMinRating`.
- **T2-b** `forceEnable: new Set(["rating-quality-upgrade"])` enables only that rule, and the echoed
  `policy.rules["rating-quality-upgrade"].enabled === true` even though config never set it —
  **pins the contamination documented in A.1.7**.
- **T2-c** `resolvePolicyConfig(config, { ratingTargetQualityProfile: "Lossless" },
notRequestedSlot("lidarrQualityProfiles"))` returns `resolvedProfileId === null` and does not
  throw — **pins the second, pre-gather call site (A.1.2)**.
- **T2-d** one `runLidarrPolicyEvaluation` case with `forceEnable` covering all three rules but
  `selected` covering two: `discovery-seed` still reports `not-selected` (gate ordering `:765` before
  `:770`).
- **T2-e** an `overrides` object with none of the four new fields produces a resolved policy deep-equal
  to today's — the `policy evaluate` no-regression pin.

**Depends on:** none.

**Verify in isolation:**

```bash
cd packages/rfmedia-cli && env -u FORCE_COLOR npx vitest run src/lib/bridge/policy-engine.test.ts \
  && env -u FORCE_COLOR npx vitest run src/actions/lidarr/policy-evaluate.test.ts 2>/dev/null; \
  env -u FORCE_COLOR npx tsc --noEmit
```

---

### Batch 2 — the pure projection module

#### T3 — `rating-sync.ts` + its test

**Goal:** the only genuinely new decision logic in the feature: gate, project, detect conflicts, throw
on invariant violations, resolve threshold provenance, compute the footprint.

**Files created:**

- `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts`
- `packages/rfmedia-cli/src/lib/bridge/rating-sync.test.ts`

**Contract:**

```ts
export const SYNC_RATINGS_REMEDY: Readonly<Record<SyncRatingsDecision, string>>;

export class SyncRatingsProjectionError extends Error {
  readonly decisionKey: string;
  constructor(decisionKey: string, detail: string);
}

export interface RatingSyncPlanInput {
  readonly report: PolicyEvaluationReport;
  readonly decisions: readonly SyncRatingsDecision[];
  readonly disabledDecisions: ReadonlySet<SyncRatingsDecision>;
}
export interface RatingSyncPlan {
  readonly cohorts: readonly SyncRatingsCohort[];
  readonly refusals: readonly SyncRatingsRefusal[];
  readonly sealable: readonly SyncRatingsDecision[];
  readonly footprint: SyncRatingsFootprint;
}
export function buildRatingSyncPlan(input: RatingSyncPlanInput): RatingSyncPlan;

export interface SyncRatingsThresholdInput {
  readonly report: PolicyEvaluationReport;
  readonly config: PolicyConfigOptions | undefined;
  readonly overrides: {
    readonly minStars?: number;
    readonly maxPlays?: number;
    readonly qualityProfile?: string;
    readonly maxProposals?: number;
  };
}
export function resolveSyncRatingsThresholds(input: SyncRatingsThresholdInput): SyncRatingsResolvedThresholds;
```

**Implementation requirements (each is a correction from §A):**

- Imports **only** `../../types/*.js`, all `import type` except the error class. No
  `./policy-engine.js`, no `./policy-rules.js` (ESM cycle).
- `report.rules.find((r) => r.id === ruleId)`; `undefined` → `SyncRatingsProjectionError`
  (invariant), `status === "skipped"` → G2 refusal carrying `skipReason` + `detail` (**A.4.1**).
- Filter `report.proposals` on `proposal.ruleId ∈ selectedRuleIds` **before** any invariant check
  (**A.4.4**).
- Gate order: G1 `decision-disabled` → G2 `rule-not-evaluated` → project → G3
  `cross-decision-conflict` (bilateral drop, one artist-scoped refusal with `decision: null`).
- G4 throws — **five** invariants (**A.4.5** adds the fifth):
  1. proposal has no `subject.artistId`;
  2. `after["monitored"]` is not a `boolean` (bracket + `typeof`, **A.4.2**);
  3. `after["qualityProfileId"]` is not a `number` (bracket + `typeof`);
  4. two profile proposals name different `after["qualityProfileId"]` values;
  5. `report.policy.rules["rating-quality-upgrade"]` narrowed on `.kind` has
     `resolvedProfileId` that is not a `number` while its cohort is non-empty.
- `footprint.fraction = round4(changedArtists / Math.max(report.coverage.authoritativeLinks, 1))`
  (**A.4.6**).
- `artistIds` ascending + deduplicated; refusals sorted by `SYNC_RATINGS_REFUSAL_CODES` order then
  `artistId` ascending. `Object.freeze` the returned plan and every nested array/record.
- `resolveSyncRatingsThresholds` reads effective **values** off `report.policy.rules[…]` (a
  `Record<PolicyRuleId, …>` mapped type — safe bracket access, no `undefined` taint) and derives only
  the `source` tag from `overrides` vs raw `config`.

**Tests — 7 cases, exactly §8.1, no additions:** G1 kill switch + sibling unaffected; G2 per-decision
skip carrying `skipReason`/`detail` + sibling still sealable; G3 bilateral drop with one refusal;
happy path (verbatim `key`/`before`/`after`/`checks`, ascending deduplicated `artistIds`, converged
artist absent); non-selected decision's proposals excluded (this case must include a
`discovery-seed` proposal with no `subject.artistId` in `report.proposals`, proving **A.4.4**'s
filter runs before the invariant); the five `SyncRatingsProjectionError` throws; threshold provenance
`flag`/`config`/`default` for all four thresholds. Frozen-literal fixtures, **no mocks**.

**Depends on:** T1.

**Verify in isolation:**

```bash
cd packages/rfmedia-cli && env -u FORCE_COLOR npx vitest run src/lib/bridge/rating-sync.test.ts
```

---

### Batch 3 — the impure orchestration action

#### T4 — `sync-ratings.ts` action + test + barrel

**Goal:** compose evaluate → project → seal → apply with no scheduler slot of its own.

**Files created:**

- `packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts`
- `packages/rfmedia-cli/src/actions/lidarr/sync-ratings.test.ts`

**Files modified:**

- `packages/rfmedia-cli/src/actions/lidarr/index.ts`

**Contract:**

```ts
export const TIER: LidarrTier = "local-only"; // barrel symmetry only; schedules nothing

export interface LidarrSyncRatingsActionOptions {
  readonly mode: LidarrSyncRatingsMode;
  readonly plexLibrary?: string;
  /** MUST be non-empty when projection is wanted; see A.4.4. */
  readonly decisions?: readonly SyncRatingsDecision[];
  readonly minStars?: number;
  readonly maxPlays?: number;
  readonly qualityProfile?: string;
  readonly maxProposals?: number;
  readonly onPlanSealed?: (outcome: LidarrSyncRatingsOutcome) => void;
  readonly plexUrl?: string;
  readonly plexToken?: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
  readonly signal?: AbortSignal;
}
export interface LidarrSyncRatingsActionResult {
  readonly report: LidarrSyncRatingsReport;
  readonly execution: LidarrExecutionSuccessMetadata;
}
export interface LidarrSyncRatingsDependencies {
  readonly executeEvaluate: typeof executeLidarrPolicyEvaluate;
  readonly buildPlan: typeof buildRatingSyncPlan;
  readonly resolveThresholds: typeof resolveSyncRatingsThresholds;
  readonly executeArtistProfilePlan: typeof executeLidarrArtistProfilePlan;
  readonly executeMonitoringPlan: typeof executeLidarrPlan;
  readonly executeApply: typeof executeLidarrApply;
  readonly loadedPolicyConfig: typeof getLoadedPolicyConfig;
  readonly confirm: (outcome: LidarrSyncRatingsOutcome) => Promise<boolean>;
}
export async function executeLidarrSyncRatings(
  options: LidarrSyncRatingsActionOptions,
  dependencies?: LidarrSyncRatingsDependencies,
): Promise<LidarrSyncRatingsActionResult>;
```

Barrel block appended to `src/actions/lidarr/index.ts`:

```ts
export { executeLidarrSyncRatings, TIER as LIDARR_SYNC_RATINGS_TIER } from "./sync-ratings.js";
export type {
  LidarrSyncRatingsActionOptions,
  LidarrSyncRatingsActionResult,
  LidarrSyncRatingsDependencies,
} from "./sync-ratings.js";
```

**Implementation requirements (corrections applied):**

- **No `runSingle`.** The returned `execution` is the evaluation lane's
  (`policy-evaluate.ts:264-267` deadlock hazard).
- `rawConfig = deps.loadedPolicyConfig()` → tri-state `decisionStates` (`on` / `unset` / `off`) and
  `forceEnable = { ruleId | rawConfig?.rules?.[ruleId]?.enabled === undefined }`.
  `disabledDecisions = { d | … === false }`.
- **Always** pass a non-empty `rules` array to `executeEvaluate`; if every selected decision is
  `off`, return the report with all-refused cohorts and **do not call evaluate** (**A.4.4**).
- Producer calls, in `POLICY_PRODUCER_IDS` order, with `maxBatch: cohort.artistIds.length` and a
  two-sided assertion `1 <= length <= LIDARR_PLAN_MAX_BATCH` (**A.2.4**):
  - `deps.executeArtistProfilePlan({ artistIds, qualityProfile: String(resolvedProfileId), maxBatch, lidarrUrl, lidarrApiKey })`
  - `deps.executeMonitoringPlan({ artistIds, monitored: false, maxBatch, lidarrUrl, lidarrApiKey })`
- `options.onPlanSealed?.(outcome)` fires **immediately** after each seal, before the next producer
  and before any apply.
- Apply: `deps.executeApply({ planPath, dryRun: false, approved: true, expectedPlanId: plan.id,
expectedPlanChecksum: plan.payloadChecksum, lidarrUrl, lidarrApiKey, signal })`.
- `signal?.throwIfAborted()` before evaluation, after it, before each producer, before each apply.
- **JSDoc `@throws` (corrected per A.2.2/A.2.3):**
  `@throws {Error} From the artist-profile producer — a vanished artist id, an unresolvable target or
BEFORE-state profile, or an over-cap cohort all surface as plain Error/TypeError from
src/lib/lidarr/artist-selection.ts.`
  `@throws {LidarrPlanValidationError} From the monitoring producer (plan.ts:81-83) and from the plan
engine's maxBatch/entry caps (plan-engine.ts:1681-1682).`
  `@throws {SyncRatingsProjectionError} …` `@throws {DOMException} AbortError …`

**Tests — 7 cases, exactly §8.2, no additions:** recommend mode calls no producer and no apply
(**the single most important assertion in the feature**); plan mode routes both producers with exact
`artistIds`, `qualityProfile: String(resolvedProfileId)`, `monitored: false`,
`maxBatch === artistIds.length`, outcomes ordered profile-then-monitoring, apply uncalled; tri-state
`forceEnableRules` wiring; a `skipped` rule leaves its producer uncalled while the sibling runs;
apply-mode confirm true/false; `onPlanSealed` before `executeApply`; pre-aborted signal rejects with
nothing called. `satisfies LidarrSyncRatingsDependencies` harness of `vi.fn()`s; no `vi.mock` of
client or adapter. **Do not assert `LidarrPlanValidationError` for profile-cohort failures.**

**Depends on:** T1, T2, T3.

**Verify in isolation:**

```bash
cd packages/rfmedia-cli && env -u FORCE_COLOR npx vitest run src/actions/lidarr/sync-ratings.test.ts
```

---

### Batch 4 — the presenter

#### T5 — `lidarr-sync-ratings-presenter.ts`

**Goal:** own every stderr byte, delegating to the three shipped renderers, keeping the command inside
the line budget.

**Files created:**

- `packages/rfmedia-cli/src/commands/lidarr-sync-ratings-presenter.ts`

**Contract:**

```ts
export interface SyncRatingsPresentationOptions {
  readonly verbose: boolean;
}

/** Header, thresholds (with flag|config|default source), coverage + footprint, decisions, cohorts, refusals, next steps. */
export function renderSyncRatings(report: LidarrSyncRatingsReport, options: SyncRatingsPresentationOptions): void;

/** Delegates to the shipped renderPolicyExplain over report.evaluation. */
export function renderSyncRatingsExplain(report: LidarrSyncRatingsReport, key: string): boolean;

/** Valid --explain keys; delegates to the shipped policyDecisionKeys(report.evaluation). */
export function syncRatingsDecisionKeys(report: LidarrSyncRatingsReport): readonly string[];

/** The six-field literal renderMutationApply / confirmMutationApply require (A.3.6). */
export function mutationPresentationOptions(verbose: boolean): MutationApplyPresentationOptions;
```

**Implementation requirements:**

- Decision **state/provenance** is rendered from `report.decisionStates` (raw config), **never** from
  `report.evaluation.policy.rules[id].enabled` (**A.1.7**).
- The quality-profile cohort header renders **both** `resolvedProfileId` and `qualityProfileName` so a
  numeric-coercion mis-resolution is visible before approval (**A.1.8**).
- Every read of a proposal's `before`/`after` uses bracket access with `?? null` (the
  `lidarr-policy-presenter.ts:327-328` idiom) — **A.4.2**.
- Row cap is `POLICY_HUMAN_ROW_CAP` (20) unless `verbose`; help strings say "first 20" verbatim.
- Everything goes to `console.error`. Nothing here touches stdout.
- `mutationPresentationOptions(verbose)` returns
  `{ verbose, allowTagReplacement: false, allowArtistDelete: false, allowAlbumDelete: false,
allowFileDelete: false, plexScan: false }`.

**Depends on:** T1, T4.

**Verify in isolation:**

```bash
cd packages/rfmedia-cli && env -u FORCE_COLOR npx tsc --noEmit
```

---

### Batch 5 — the command leaf

#### T6 — `lidarr-sync-ratings.ts` + test

**Goal:** the Commander leaf: fourteen options, all validation inside `.action()`, lazy actions
barrel, interactive-approval wiring, output split, exit gate.

**Files created:**

- `packages/rfmedia-cli/src/commands/lidarr-sync-ratings.ts`
- `packages/rfmedia-cli/src/commands/lidarr-sync-ratings.test.ts`

**Contract:**

```ts
export interface LidarrSyncRatingsActions {
  readonly executeLidarrSyncRatings: (
    options: LidarrSyncRatingsActionOptions,
    dependencies?: LidarrSyncRatingsDependencies,
  ) => Promise<LidarrSyncRatingsActionResult>;
}
export interface LidarrSyncRatingsCommandDeps {
  readonly resolveFormat: () => OutputFormat;
  readonly reportLidarrFailure: (
    subcommand: string,
    error: unknown,
    options: {
      readonly staleHint: boolean;
      readonly format: OutputFormat;
      readonly sensitiveValues?: readonly unknown[];
    },
  ) => Promise<void>;
  readonly renderExecutionSummary: (execution: LidarrExecutionSuccessMetadata) => void;
  readonly loadActions?: () => Promise<LidarrSyncRatingsActions>;
}
export interface LidarrSyncRatingsMachineOutput {
  readonly command: "lidarr-sync-ratings";
  readonly result: LidarrSyncRatingsReport;
}
/** Non-throwing --decision accumulator; validation happens in .action(). */
export function parseSyncRatingsDecisions(value: string, previous?: readonly string[]): string[];
export function createLidarrSyncRatingsCommand(deps: LidarrSyncRatingsCommandDeps): Command;
```

**Option declaration order (= `LIDARR_SYNC_RATINGS_OPTION_LONGS`, A.3.1):**

| helpGroup     | Options                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `Selection:`  | `--plex-library <name>`, `--decision <kinds>` (argParser = accumulator only)           |
| `Thresholds:` | `--min-stars <n>`, `--max-plays <n>`, `--quality-profile <ref>`, `--max-proposals <n>` |
| `Safety:`     | `--mode <mode>` (`.default("recommend")`), `--yes`                                     |
| `Output:`     | `--explain <key>`, `-v, --verbose`                                                     |
| `Connection:` | `--plex-url`, `--plex-token`, `--lidarr-url`, `--lidarr-api-key`                       |

**Validation, all inside `.action()` before `loadActions()`** (order matters):

1. `resolveSyncRatingsDecisions(raw)` → `MissingRequiredArgumentError` when `--decision` contributed
   nothing; `LookupNotFoundError` on the first unknown value (mirrors `resolveSelectedRules`).
2. `resolveMode(raw)` → `LookupNotFoundError("sync-ratings mode", value, [...SYNC_RATINGS_MODES])`.
   **Never `.choices()`** — it installs a throwing `argParser`.
3. `resolveStarBound("--min-stars", raw, 1, 5)` → `InvalidNumericArgumentError` (accepts decimals).
4. `resolveIntegerBound("--max-plays", raw, 0, SYNC_RATINGS_MAX_PLAYS)`.
5. `resolveIntegerBound("--max-proposals", raw, 1, POLICY_MAX_PROPOSALS_PER_RULE)`.
6. **New (A.1.6):** if `quality-profile` is selected and neither `--quality-profile` nor
   `getLoadedPolicyConfig()?.rules?.["rating-quality-upgrade"]?.targetQualityProfile` is set →
   `MissingRequiredArgumentError` naming `--quality-profile`.
7. `if (mode === "apply" && !yes) assertInteractiveApplyApproval(isMachineFormat(format));`

**Runtime wiring:** `onPlanSealed` renders the artifact via `renderMutationPlan({ planPath, plan },
verbose)` in human mode (path visible before any apply — §6.9). `confirm` runs a real
`executeLidarrApply({ dryRun: true, approved: false, … })` and hands the review to
`confirmMutationApply(planFile, review, reviewedPlan, mutationPresentationOptions(verbose))`; with
`--yes` it returns `true` without the dry run. Machine formats emit
`{ command: "lidarr-sync-ratings", result: report }` on stdout through the lazily imported
`formatOutput`; `--output csv` reuses `projectPolicyEvaluationCsv(report.evaluation)` with
`LIDARR_POLICY_EVALUATE_CSV_COLUMNS`. `--explain` is validated against
`syncRatingsDecisionKeys(report)` in **every** format. Exit gate: `process.exitCode = 1` when any
`outcome.apply.status` is `"failed"` or `"partial"`, applied **after** all rendering.
`process.exit()` is never called. `catch` routes to `deps.reportLidarrFailure("sync-ratings", error,
{ staleHint: false, format, sensitiveValues: [cmdOptions["lidarrApiKey"], cmdOptions["plexToken"]] })`.
Never imports `./lidarr.js`.

**Tests — 4 cases, exactly §8.3 (case 3 restated for `--mode`):**

1. `command.options.map(o => o.long).filter(Boolean)` equals `[...LIDARR_SYNC_RATINGS_OPTION_LONGS]`
   in order; help contains neither `--output` nor `--json`.
2. `--decision zzz`, `--min-stars 9`, `--max-plays -1`, and `--mode zzz` each → `reportLidarrFailure`
   called with the typed error, `process.exitCode === 1`, `deps.loadActions` **never called**,
   `process.exit` never called.
3. `--mode apply` with `resolveFormat: () => "json"` and no `--yes` → `MissingRequiredArgumentError`
   through `reportLidarrFailure`; the action is never invoked.
4. `--explain <unknown-key>` under `--output json` → `LookupNotFoundError`, not a silently full
   envelope.

**Depends on:** T1, T4, T5.

**Verify in isolation:**

```bash
cd packages/rfmedia-cli && env -u FORCE_COLOR npx vitest run src/commands/lidarr-sync-ratings.test.ts
```

---

### Batch 6 — the mechanical lockstep (ONE task; these must move together)

#### T7 — six ordered lists + three completion templates + `templates.spec.ts`

**Goal:** register the leaf at index 8 and move every order-bearing artifact in one commit. Missing
any one produces three simultaneous completion failures plus a hierarchy failure.

**Files modified (6):**

- `packages/rfmedia-cli/src/commands/lidarr.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**L1 — `lidarr.ts`.** Import `createLidarrSyncRatingsCommand` from `./lidarr-sync-ratings.js`; insert
the `addCommand` **immediately after** the `createLidarrPolicyCommand` block (`lidarr.ts:1482-1489`)
and **before** `createLidarrImportValidationCommand` (`:1490`):

```ts
lidarrCommand.addCommand(
  createLidarrSyncRatingsCommand({ resolveFormat, reportLidarrFailure, renderExecutionSummary }),
);
```

**L2 — `lidarr.test.ts:25-41`.** `LIDARR_COMMAND_NAMES` gains `"sync-ratings"` at index 8
(between `"policy"` and `"validate-import"`). Asserted order-sensitively at `:1056`.

**L3 — bash, SIX edit sites (A.3.1–A.3.3):**

| Id  | Site                                                     | Edit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `bash.ts:164`                                            | `lidarr_subcommands` gains a space-separated `sync-ratings` after `policy`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| B2  | beside `bash.ts:175-178`                                 | `local lidarr_sync_ratings_opts="--plex-library --decision --min-stars --max-plays --quality-profile --max-proposals --mode --yes --explain -v --verbose --plex-url --plex-token --lidarr-url --lidarr-api-key"` on **one physical line** (`extractBashCandidates` splits on a single space); plus `local lidarr_sync_ratings_decisions="quality-profile monitoring"`, `local lidarr_sync_ratings_modes="recommend plan apply"`, `local lidarr_sync_ratings_max_plays="0 1 3 5 10 25"`. **No `lidarr_sync_ratings_min_stars`** (A.3.2) |
| B3  | word-scan loop, after `policy)` `:236-241`               | own guarded arm — `sync` already lives in the shared arm at `:213` for the plex family: `sync-ratings)` → `if [[ "$cmd" == "lidarr" && -z "$subcmd" ]]; then subcmd="${words[i]}"; fi`                                                                                                                                                                                                                                                                                                                                                 |
| B4  | **existing** `--mode)` arm `:317-327`                    | insert `elif [[ "$cmd" == "lidarr" && "$subcmd" == "sync-ratings" ]]; then COMPREPLY=($(compgen -W "$lidarr_sync_ratings_modes" -- "$cur"))` **before** the final `else` (watch_modes). Do NOT add a second `--mode)` arm                                                                                                                                                                                                                                                                                                              |
| B5  | inside `case "$prev" in` (`:304-498`)                    | two NEW unguarded arms with the `--rule)` comment style: `--decision)` → `$lidarr_sync_ratings_decisions`; `--max-plays)` → `$lidarr_sync_ratings_max_plays`. Both literals are globally unique (verified)                                                                                                                                                                                                                                                                                                                             |
| B6  | `lidarr)` dispatch, after the `policy` branch `:633-640` | flat branch, **literal TAB indentation** matching neighbours: `elif [[ "$subcmd" == "sync-ratings" ]]; then` / `if [[ "$cur" == -* ]]; then` / `COMPREPLY=($(compgen -W "$lidarr_sync_ratings_opts $global_opts" -- "$cur"))` / `fi`                                                                                                                                                                                                                                                                                                   |

No edit for `--min-stars` (`:343`), `--max-proposals` (`:368`), `--quality-profile`/`--explain`/
`--plex-*`/`--lidarr-*`/`--plex-library` (`:393`) — all already correct and reused.

**L4 — zsh, two edits:**

- Z1 `zsh.ts:407-424` — `'sync-ratings:Turn Plex ratings and plays into Lidarr monitoring and quality changes'` after the `policy:` entry.
- Z2 — a `sync-ratings)` arm in the `lidarr_args` state after the `policy)` arm (`:516-541`), inside
  the region `extractZshCaseBlock` scans from the `lidarr)` marker at `zsh.ts:406` (eight spaces),
  ending in the interpolated `${globalOpts}` or `expectZshGlobalOptions` fails. `--decision` carries
  the `*` repeatable prefix. `--min-stars` value list is `(1 1.5 2 2.5 3 3.5 4 4.5 5)` (A.3.2);
  `--mode` is `:mode:(recommend plan apply)`; `--yes` is boolean.

**L5 — fish, three edits (A.3.4):**

- F1 — `function __fish_rfmedia_lidarr_sync_ratings_active` in the newer `$command_path` form,
  defined **after** `__fish_rfmedia_lidarr_policy_evaluate_active` (`fish.ts:1400` block), NOT between
  reconcile and validate-import.
- F2 — `complete -c rfmedia -n "__fish_rfmedia_lidarr_needs_subcommand" -a "sync-ratings" -d "…"` at
  `fish.ts:1543`, between the `policy` line (`:1542`) and the `validate-import` line.
- F3 — a `# Lidarr sync-ratings options` block. Value options carry `-r`; choice-valued carry `-xa`;
  booleans (`--yes`, `-s v -l verbose`) carry neither. `-l min-stars … -xa "1 1.5 2 2.5 3 3.5 4 4.5 5"`;
  `-l mode … -r -xa "recommend plan apply"`.

**L6 — `templates.spec.ts`:**

- `"sync-ratings"` into `lidarrCommandTree.lidarr` at index 8 (`:50-71`).
- `lidarrSyncRatingsOptions` `[["--flag", takesValue], …] as const` modelled on
  `lidarrPolicyEvaluateOptions` (`:178-193`), including `["-v", false], ["--verbose", false]`.
  Value-taking: `--plex-library, --decision, --min-stars, --max-plays, --quality-profile,
--max-proposals, --mode, --explain, --plex-url, --plex-token, --lidarr-url, --lidarr-api-key`.
  Boolean: `--yes, -v, --verbose`. **No special-casing needed** — this is the payoff of A.3.1.
- One cross-shell contract test cloned from the policy loop (`:1118-1201`): commands equal
  `lidarrCommandTree.lidarr` per shell; sorted option-set and value-option-set equality across
  bash/zsh/fish;
  `expect(expectedOptions.filter(o => o.startsWith("--"))).toEqual([...LIDARR_SYNC_RATINGS_OPTION_LONGS])`;
  `--decision` value lists equal `[...SYNC_RATINGS_DECISIONS]` and `--mode` value lists equal
  `[...SYNC_RATINGS_MODES]` in all three shells; `expectZshGlobalOptions`; zero
  adapter/client/scheduler/config/`fetch` calls; `.not.toContain("rfmedia lidarr sync-ratings")`.
- Add the new predicate + its value options to the fish `valueOptionsByCondition` map.
- One live `bash --noprofile --norc` routing test:
  `run(["rfmedia","lidarr","sync-ratings","--m"])` must equal exactly
  `["--min-stars","--max-plays","--max-proposals","--mode"]` — a routing bug a string-presence check
  cannot catch. Also assert `run([...,"--mode",'""'])` equals `["recommend","plan","apply"]`,
  proving B4's guarded `elif` fires ahead of `watch_modes`.

**Depends on:** T1, T6.

**Verify in isolation:**

```bash
cd packages/rfmedia-cli && env -u FORCE_COLOR npx vitest run \
  src/lib/shell-completions/templates.spec.ts src/commands/lidarr.test.ts
```

---

### Batch 7 — docs

#### T8 — new feature doc

**Files created:**

- `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`

Plain `.md`, no front matter. Spine: `# Lidarr Ratings Sync` → Overview (command in backticks + the
three-rung write-safety envelope in the first two paragraphs) → Use → Options → The Two Decisions →
Thresholds and Their Limits → Safety Gates → Output Schemas → Exit Behavior → Safety and Follow-Up
Boundaries → Troubleshooting → Related Documentation.

**Must state, from §A:** `--mode` (not `--plan`/`--apply`) and why; `--max-proposals` is per-rule with
per-rule defaults 25/25/**10**; `--quality-profile` resolves **numeric id first**, so a profile named
`"320"`/`"3.0"` can mis-resolve — check the echoed id+name pair before approving; `--max-plays` is an
absolute lifetime count, **not** recency (no `lastViewedAt` anywhere in the domain); the weak
normalized-name play join and its three fail-closed poisonings; the tri-state `enabled` semantics.
Troubleshooting rows: sealed-but-unapplied artifact after a mid-run producer throw (recovery
`rfmedia lidarr apply <path> --yes`); **an artist whose current quality profile was deleted makes the
profile producer throw on the cohort's BEFORE state** (A.2.3); `plex.cache.enabled: true` for repeated
runs; `consumption-signal-empty` meaning the resolved Plex token may not be the listening account.

**Depends on:** T7.

**Verify:** `cd <repo root> && npm run lint:md`

---

#### T9 — reciprocal doc edits

**Files modified:**

- `packages/rfmedia-cli/README.md` — new `### Lidarr Ratings Sync` H3 between the Consumption Policy
  block (~5264-5365) and Quality Presets (~5366): three-rung bash examples using `--mode`, the option
  table, the reused `policy.rules.*` config table, and
  `See [Lidarr Ratings Sync](docs/features/lidarr-ratings-sync.md) for …`. Amend line ~5259.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md` — reciprocal
  `## Related Documentation` link; one sentence in Safety and Follow-Up Boundaries naming
  `sync-ratings` as the gated apply lane for the same two rules on identical decision keys, **without**
  weakening "evaluation proposes, it never applies" about `policy evaluate` itself.
- `packages/rfmedia-cli/docs/features/plex-lidarr-reconciliation.md` — line 217, replace
  "preference and rating policy remain in [#221]" with a shipped pointer.
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md` — new
  `#### Lidarr ratings sync completion` subsection listing the subtree and the static `--decision`
  and `--mode` value lists.

**Depends on:** T7 (T8 only for the link path, which this plan fixes).

**Verify:** `cd <repo root> && npm run lint:md`

---

### Batch 8 — roadmap and plan artifacts

#### T10 — ROADMAP + archive migration

**Files modified:**

- `ROADMAP.md`
- `docs/roadmap-archive.md`

`ROADMAP.md` (all eight line references re-verified): line 8 `**Last updated:**` → ship date; line 10
`**Open issues:** 85 (rfapps 40 · rfmedia 45)` → `84 (rfapps 40 · rfmedia 44)`, **verified** with
`gh issue list --state open --limit 200 --json number,labels`, preserving the middle dot `·`; line 45
rewrite "Ratings-driven decisions (#221) remain dependent future work." as shipped narrative; line 67
Sprint 1 row 2 "Why now" → `**Delivered** via [#NNN](…/pull/NNN)`; lines 78-79 exit criteria; lines
191-198 append #221 to the shipped list; line 205 fenced Layer 3 line → `#207–#209, #221, #284–#285
shipped` **preserving the en-dashes and the double space before the parenthesis**; line 213 Phase D
row delivered. **Do NOT touch** the "Medium priority … (12)" heading at line 174.

`docs/roadmap-archive.md` (#221 is the last open Sprint 1 row, so `ROADMAP.md:288-289` fires): bump
line 7 `**Archived:**` and line 11 `## What shipped (through <date>)` in sync; add a
`| Lidarr Layer 3 ratings sync | [#221](…/issues/221) | [#NNN](…/pull/NNN) |` row after line 28;
amend line 117; insert the operator-note bullet
`- **Plex ratings sync to Lidarr decisions (#221 / #NNN):** …` immediately after line 133 and
**before** the `### Minor docs follow-up` heading at 135, closing with
`See [ratings sync docs](../packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md).` — the
`Operator notes:` paragraph **must** name the weak normalized-name play join and the absence of any
recency dimension; append `12. Lidarr Layer 3 ratings sync — #221` after line 154, preserving the
curly quotes in the heading at 142.

**Depends on:** T8, T9.

**Verify:** `cd <repo root> && npm run lint:md` then re-read the counter and dates **by eye**
(Prettier reflows tables, not prose).

---

#### T11 — ship the plan artifacts

**Files created:**

- `packages/rfmedia-cli/docs/plans/issue-221-ratings-sync/design.md`
- `packages/rfmedia-cli/docs/plans/issue-221-ratings-sync/plan.md`

Copy `docs/plans/221-sync-ratings/{design.md,plan.md}` into the package, following the
`issue-209-policy-engine` precedent, **with §A's corrections folded into `design.md`** — in
particular §2.2/§2.3/§2.6 (`--mode`), §3.4, §3.6, §4.1, §4.3, §5.5 G2/G4, §7.4-§7.7, §9 risk 2. Commit
these with `docs(internal): …`.

**Depends on:** T10.

**Verify:** `cd <repo root> && npm run lint:md`

---

## D. Test plan delta (bloat removal)

Carried forward from §8, unchanged in count: **7 + 7 + 4 + 5 = 23** assertions across four files.

**Dropped as not load-bearing:**

- Any presenter snapshot / golden-output test (three renderers reused verbatim, already covered).
- Any plan-engine or apply-lane test (`apply.test.ts` is already 122 KB).
- Any `config.test.ts` case (**no new config keys**).
- Any gatherer / evaluator / identity-brand test (unchanged; a violating brand test would not compile).
- Any end-to-end fake-Plex + fake-Lidarr test (the DI harness proves the same wiring far cheaper).
- Any test asserting the embedded evaluation is byte-identical to `policy evaluate` (**A.4.8** — it
  is not, and such a test would be flaky).

**Added by §A** (all inside the existing four files, no new test file):

- T2-b (forceEnable contamination), T2-c (pre-gather `not-requested` slot), T2-e (no-regression pin).
- T3's fifth `SyncRatingsProjectionError` invariant (`resolvedProfileId` not a number).
- T3's non-selected-decision case must carry a `discovery-seed` proposal (A.4.4).
- T6 case 2 gains `--mode zzz`.
- T7's live bash `--mode` routing assertion.

---

## E. Definition of Done

- [ ] §A read in full; every correction applied. `design.md` in the shipped plan folder reflects them.
- [ ] 11 files created, 16 modified — exactly the list in §C, nothing else.
- [ ] `--apply` and `--plan` appear **nowhere** in the sync-ratings surface; `--mode <recommend|plan|apply>` is the only rung selector.
- [ ] `LIDARR_SYNC_RATINGS_OPTION_LONGS` (14 entries) equals the leaf's Commander long options **in order**, and equals the `--`-prefixed members of the `templates.spec.ts` table.
- [ ] All six ordered lists carry `sync-ratings` at index 8, between `policy` and `validate-import`.
- [ ] Six bash edits, two zsh edits, three fish edits landed; the fish predicate is defined **after** `__fish_rfmedia_lidarr_policy_evaluate_active`; no duplicate `--min-stars)` or `--apply)` arm was added.
- [ ] `rfmedia lidarr sync-ratings --m` completes to exactly `--min-stars --max-plays --max-proposals --mode` under the live bash harness.
- [ ] Default rung calls no producer and no apply — asserted.
- [ ] `maxBatch === cohort.artistIds.length`, with `1 <= n <= LIDARR_PLAN_MAX_BATCH` asserted.
- [ ] Profile targeting binds by `String(resolvedProfileId)` after a `typeof === "number"` narrow.
- [ ] Every `before`/`after`/`observations` read uses bracket access + `typeof` narrowing; `tsc --noEmit` is clean.
- [ ] `executeLidarrSyncRatings` never forwards `rules: []` or `rules: undefined`.
- [ ] No object literal anywhere (including fixtures) carries `artistIds` together with `qualityProfileId`.
- [ ] No new `.rfmedia.yaml` key, no new `PolicyRuleId`, no new plan `operation.kind`, no new CSV schema.
- [ ] No file above `src/lib/adapters/plex-adapter.ts` imports `./plex/*`; no new `fetch`.
- [ ] Every new/changed file is under the ~500-line soft cap.
- [ ] 23 test assertions across the four files; nothing from §D's dropped list was written.
- [ ] `npm run format` and `npm run lint:md` clean; ROADMAP counter and dates verified by eye.
- [ ] Full verification sequence below passes with `FORCE_COLOR` unset.

---

## F. Verification command sequence

Run in this exact order from the worktree root. `bash` must be on `PATH` (the completion specs spawn
a real one).

```bash
# 0. repo root, shared workspace build the package typecheck depends on
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-rfmedia-apps-feat-221-sync-ratings
env -u FORCE_COLOR npm run build -w packages/rf-common

# 1. codegen gates (must precede typecheck; pretypecheck runs them again)
cd packages/rfmedia-cli
npm run test:codegen:lidarr
npm run codegen:lidarr:check

# 2. architecture + type gates (pretypecheck fires check:architecture + test:architecture)
env -u FORCE_COLOR npm run typecheck

# 3. full suite with coverage
env -u FORCE_COLOR npm run test:coverage

# 4. benchmarks at reduced scale
RFMEDIA_BENCH_SCALES=10,100 env -u FORCE_COLOR npm run bench

# 5. formatting and markdown, from the repo root
cd ../..
npm run format
npm run lint:md

# 6. final: nothing unformatted, nothing untracked that should not be
git status --short
```

Per-task isolation commands are listed with each task in §C.
