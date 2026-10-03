# Design: rfmedia lidarr sync-ratings (#221)

**Status:** authoritative. **Issue:** #221. **Package:** `packages/rfmedia-cli`.
**Depends on:** #208 (reconciliation), #209/#292 (consumption-policy engine), #202 (plan/apply lifecycle).

Every source claim below was verified against the tree at `d5f9c395`. File:line references are
literal.

**Reconciled copy.** §A of the sibling `plan.md` re-verified every claim here against source and
corrected nine facts and eighteen hazards. Those corrections are folded into this document — most
visibly the rung selector, which is `--mode <recommend|plan|apply>`, **not** `--plan` / `--apply`
(§A.3.1). Where this document and `plan.md` §A ever disagree, **§A wins**.

---

## 1. Problem and delta vs shipped code

### 1.1 What #209 already ships

The consumption-policy engine already computes **both** decisions #221 names, and already emits them
as before/after diffs with full threshold provenance.

`evaluateRatingQualityUpgrade` (`src/lib/bridge/policy-rule-rating-upgrade.ts:89`) **is** "Plex rating
→ Lidarr quality profile". Verified at `:186-214` it emits:

```
before: { qualityProfileId, qualityProfileName }
after:  { qualityProfileId: targetProfile.id, qualityProfileName: targetProfile.name }
handoff: buildPolicyHandoff("artist-profile-assignment",
         ["lidarr","plan","artist-profiles","--ids",String(link.lidarrId),
          "--quality-profile", targetProfile.name])
```

`evaluateStaleMonitoringCleanup` (`src/lib/bridge/policy-rule-stale-monitoring.ts:98`) **is** "Plex
plays → Lidarr monitoring". Verified at `:305-337` it emits `before: { monitored: true }` →
`after: { monitored: false }` with handoff argv `["lidarr","plan","artist-monitoring","--ids",…,"--unmonitored"]`.

Both already carry: the branded `PolicyIdentityLink` gate, `PolicyThresholdCheck.configPath` dotted
`.rfmedia.yaml` keys, deterministic cohort caps, stable non-rotating decision keys, deep freezing, and
a fully serializable `PolicyEvaluationReport`.

`POLICY_PRODUCER_IDS` (`src/types/lidarr-policy.ts:108`) is **already exactly**
`["artist-profile-assignment", "artist-monitoring"]` — the two sealed v3 plan operations #221 needs.

### 1.2 The precise gap

Reaching a rating-driven mutation today costs **three hand-typed commands with manual id
transcription**:

```bash
rfmedia lidarr policy evaluate                      # read ids off a report
rfmedia lidarr plan artist-profiles --ids 118,204,… --quality-profile Lossless
rfmedia lidarr apply <artifact> --yes
```

At three thousand artists that transcription step is the single most likely source of a wrong
mutation. A `policy plan` verb was deliberately deferred to a named child issue
(`packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md:1717`). **#221 is that verb**, and
it delivers the five requirements the issue states:

| #   | Issue requirement                                                 | How this design meets it                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Recommendations first; apply only with explicit confirmation/flag | `--mode recommend` (the default) is read-only; `--mode plan` seals; `--mode apply` + (`--yes` \| interactive confirm) mutates                                                                                                                             |
| 2   | Thresholds for rating/play-count actions                          | `--min-stars`, `--max-plays`, `--quality-profile`, `--max-proposals`, resolved at the single existing defaults site                                                                                                                                       |
| 3   | Integrate with policy engine where available                      | The recommendation stage **is** the unmodified `executeLidarrPolicyEvaluate`; the report embeds the **verbatim frozen `PolicyEvaluationReport`** it returned, and the projection reads only from it, so the two commands cannot disagree about a decision |
| 4   | Emit before/after diffs for applied changes                       | Three shipped presenters: `renderPolicyEvaluation`, `renderMutationPlan`, `renderMutationApply`                                                                                                                                                           |
| 5   | Uses Plex ratings/play behaviour                                  | Inherited verbatim from the shipped rules                                                                                                                                                                                                                 |

### 1.3 What is genuinely NEW

Only four things:

1. **A per-invocation threshold seam** — four optional fields on `PolicyEvaluationOverrides`, plus six
   changed expressions and one module-private helper in `resolvePolicyConfig` (the exact list is in
   §4.3). ~20 lines. No new default, no new config key.
2. **A pure proposal→cohort projection** (`src/lib/bridge/rating-sync.ts`) with a per-decision sealing
   gate and cross-decision conflict detection. Neither exists anywhere today.
3. **A three-rung orchestration action** composing `executeLidarrPolicyEvaluate` →
   `executeLidarrArtistProfilePlan` / `executeLidarrPlan` → `executeLidarrApply`.
4. **A CLI leaf + presenter.**

### 1.4 What is explicitly NOT new

No new policy rule. No new `PolicyRuleId`. No new plan `operation.kind`. No new `.rfmedia.yaml` key.
No new CSV schema. No new report schema for the evaluation. No new mutation dispatch path. See §10.

---

## 2. Command surface

### 2.1 Synopsis

```
rfmedia lidarr sync-ratings [options]
```

> Turn Plex ratings and play counts into Lidarr monitoring and quality-profile changes.

A **flat leaf** registered at index 8 of the `lidarr` parent (immediately after `policy`, before
`validate-import`).

### 2.2 The three rungs

| Invocation                        | Reads Plex + Lidarr | Writes plan artifacts  | Mutates Lidarr |
| --------------------------------- | ------------------- | ---------------------- | -------------- |
| `sync-ratings` (default)          | yes                 | **no**                 | **no**         |
| `sync-ratings --mode plan`        | yes                 | yes (0–2, mode `0600`) | **no**         |
| `sync-ratings --mode apply --yes` | yes                 | yes (0–2)              | yes            |

The rung is one value-taking option, `--mode <recommend|plan|apply>`, defaulting to `recommend`.
There is no way to mutate without `--mode apply`. Because the flag value **is**
`LidarrSyncRatingsMode`, there is no derivation, no "`--apply` implies `--plan`", no mutual-exclusion
logic and no `OptionConflictError` (§A.3.1; see §2.4 for why boolean `--plan` / `--apply` were
rejected).

### 2.3 Options

Declaration order below **is** `LIDARR_SYNC_RATINGS_OPTION_LONGS`.

#### helpGroup `Selection:`

| Flag                    | Type                                                | Default                          | Semantics                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--plex-library <name>` | string                                              | `policy.plexLibrary` → `"Music"` | Plex music library the ratings/plays drain scopes to. Forwarded to `PolicyEvaluationOverrides.plexLibrary`.                                                                                                                                                                                    |
| `--decision <kinds>`    | repeatable + CSV; `quality-profile` \| `monitoring` | both                             | Which decisions to consider. Values are named after the plan `operation.kind` they seal into. Maps to rule ids via `SYNC_RATINGS_DECISION_BINDING`; `discovery-seed` is structurally unreachable (its descriptor `producer` is `null`). Non-throwing accumulator; narrowed inside `.action()`. |

#### helpGroup `Thresholds:`

| Flag                      | Type                                    | Default                                                    | Semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--min-stars <n>`         | float, `1.0`–`5.0` inclusive            | `policy.rules.rating-quality-upgrade.minRating` → `4`      | Plex star floor for a quality upgrade. Overrides **only** the rating rule; `discovery-seed.minRating` is untouched. Compared on the normalized `0..1` scale inside `checkArtistRating`; never re-implemented.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--max-plays <n>`         | int, `0`–`1 000 000`                    | `policy.rules.stale-monitoring-cleanup.maxPlays` → `0`     | Inclusive absolute play ceiling at or below which a monitored artist is proposed for unmonitor. **Not** a recency measure — there is no recency signal anywhere in the domain; see §5.4 and non-goal §10.3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--quality-profile <ref>` | string (profile **name** or numeric id) | `policy.rules.rating-quality-upgrade.targetQualityProfile` | Target Lidarr quality profile. Resolved against the **live** profile list by the engine's `resolveTargetProfileId` (`policy-engine.ts:281`), **numeric id first**: `Number(trimmed)` + `Number.isSafeInteger` is tried before any name match (`policy-engine.ts:294-300`), so a profile literally named `"320"`, `"2024"` or `"3.0"` (`Number("3.0") === 3`) silently resolves to whichever profile carries that **id**. The report echoes the resolved **id + name pair** and the presenter renders both, so a mis-resolution is visible before `--mode apply` (§A.1.8). An unresolvable value becomes the §16.1 rule skip naming every available profile — never a throw. **Required whenever the `quality-profile` decision is selected and `policy.rules.rating-quality-upgrade.targetQualityProfile` is unset** (§A.1.6). |
| `--max-proposals <n>`     | int, `1`–`100`                          | per rule: `rating` 25, `stale` 25, **`seed` 10**           | Cohort cap. **This is a per-rule cap, not a run total**, and it **replaces each rule's own cap**: `resolvePolicyConfig` writes `overrides.maxProposals` into the rating rule's `maxProposals` (`policy-engine.ts:341`), the stale rule's `maxProposals` (`:353`) and the seed rule's **`maxSeeds`** (`:361`). The defaults it displaces are the `POLICY_DEFAULTS` keys `ratingMaxProposals` / `staleMaxProposals` / `seedMaxSeeds` = `25 / 25 / **10**` (`policy-engine.ts:134-144`). `--max-proposals 10` yields up to 10 profile changes **and** 10 monitoring changes.                                                                                                                                                                                                                                                      |

#### helpGroup `Safety:`

| Flag            | Type                             | Default       | Semantics                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | -------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--mode <mode>` | `recommend` \| `plan` \| `apply` | `"recommend"` | The rung. `recommend` reads and reports only; `plan` additionally seals one `rfmedia.lidarr-plan.v3` artifact (mode `0600`) per non-empty sealable cohort into the producers' default plan directory; `apply` additionally runs `executeLidarrApply` on each sealed artifact. Validated in `.action()` against `SYNC_RATINGS_MODES` — **never** with Commander's `.choices()`, which installs a throwing `argParser`. |
| `--yes`         | boolean                          | `false`       | Approve the apply without an interactive prompt. **Required** whenever output is a machine format or stdout is not an interactive TTY (`assertInteractiveApplyApproval`, verified `lidarr-mutation-presenter.ts:975`).                                                                                                                                                                                                |

#### helpGroup `Output:`

| Flag              | Type    | Default | Semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--explain <key>` | string  | —       | Print one decision's full causal chain. Delegates to the shipped `renderPolicyExplain(result.report, key)`. Validated against `policyDecisionKeys(result.report)` for **every** format, so `--output json --explain <typo>` fails loudly. Keys are the shipped non-rotating strings and have **four** concrete forms — proposals never carry a code, skips always do (§A.4.7):<br>`<ruleId>:artist:<lidarrId>` (linked proposal, `policy-rule-support.ts:166,67-69`)<br>`<ruleId>:plex:<plexId>` (discovery-seed proposal, `:207,78-80`)<br>`<ruleId>:artist:<lidarrId>:<code>` (linked skip, `:253-257`)<br>`<ruleId>:plex:<plexId>:<code>` (Plex-only skip, `:253-257`).<br>`PolicyDecisionKey` is a bare `string` alias (`types/lidarr-policy.ts:270`) — nothing is enforced at compile time. |
| `-v, --verbose`   | boolean | `false` | Show every decision row instead of the first `POLICY_HUMAN_ROW_CAP` (20), and every plan/apply entry row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

#### helpGroup `Connection:`

`--plex-url <url>`, `--plex-token <token>`, `--lidarr-url <url>`, `--lidarr-api-key <key>` — forwarded
**RAW** (never pre-resolved against config) so the frozen cross-origin credential guard stays live.
Both secrets are passed to `reportLidarrFailure`'s `sensitiveValues`.

### 2.4 Deliberately absent

| Flag                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--output` / `--json`           | Root options reconciled by `cli.ts`'s `preAction`; redeclaring shadows them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--plan` / `--apply` (booleans) | **Replaced by `--mode`** (§A.3.1). `bash.ts:381` classifies `--apply` as a **value-taking, file-completing** option in an **unguarded** arm shared by every command family, pinned verbatim by `templates.spec.ts:1523-1525`; bash `case` is first-match-wins, so a later `--apply)` arm is dead code and the cross-shell value-option contract (`templates.spec.ts:1150-1152,1187`) would fail. `copy --apply <plan-file>` and `delete --apply <plan-file>` already give the flag a **file-valued** meaning — reusing it as a boolean would put two incompatible types behind one name, exactly the argument used below to reject `--min-rating`. `--mode` reuses the **reachable** `--mode)` arm at `bash.ts:317-327` and needs zero special-casing |
| `--dry-run`                     | `--mode plan` **is** the dry rung; `rfmedia lidarr apply <artifact> --dry-run` is the shipped apply check. A leaf declaration would also shadow the root global                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--max-batch`                   | Bound to cohort size (§3.4). Two coupled caps is a footgun                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--rule`                        | `--decision` is the narrowing lever and excludes the inert rule structurally                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--fail-on`                     | `policy evaluate --fail-on proposals` owns the CI-gate surface on identical decision keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--offline`                     | `bridge_identity_snapshots` (snapshot-v2) carries identity only — zero ratings, zero plays. An offline run could emit nothing but refusals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--plan-file`                   | A run emits up to two artifacts, so a single path is ill-typed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--min-rating`                  | **Name collision.** Verified across `copy.ts:538`, `sync.ts:271`, `delete.ts:428`, `queue.ts:142/581`, `watch.ts:145`: `--min-rating` already means **0–100** while `--min-stars` already means **1.0–5.0**. Using `--min-rating` for a star bound would put two incompatible scales behind one flag name in one CLI                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--sync-ratings`                | Already exists on `plex playlist export`/`sync` in the completion namespace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 2.5 Exit codes

`0` on success. `1` when `deps.reportLidarrFailure` handled a thrown error, **or** when any apply
result's `status` is `"failed"` or `"partial"`. The gate is applied **after** all rendering.
`process.exit()` is never called.

### 2.6 Usage transcript

```console
$ rfmedia lidarr sync-ratings --min-stars 4.5 --quality-profile Lossless

  Plex → Lidarr Ratings Sync
  plex http://plex:32400 · lidarr http://lidarr:8686 · library "Music"
  Evaluated 2026-07-28T14:02:11Z · engine v1 · mode: recommend

  Thresholds
    min stars          >= 4.5           flag --min-stars
    quality profile    "Lossless"       flag --quality-profile
    max plays          <= 0             default
    max proposals      25 per decision  default

  Coverage
    authoritative links 412 · non-authoritative 192 (never auto-consumed)
    tracks examined 18,204 · plays observed 41,118 · changed 17 of 412 (4.1%)

  Decisions
  Decision         Rule                      State     Changes
  ───────────────  ────────────────────────  ────────  ───────
  quality-profile  rating-quality-upgrade    sealable       14
  monitoring       stale-monitoring-cleanup  sealable        3

  quality-profile — 14 artists → "Lossless"
  Artist                  Stars  Before                 After
  ──────────────────────  ─────  ─────────────────────  ─────────
  Alcest                    4.5  Standard               Lossless
  Anathema                  5.0  Standard               Lossless
  … 12 more (-v)

  monitoring — 3 artists → unmonitored
  Artist                  Plays  Before                 After
  ──────────────────────  ─────  ─────────────────────  ─────────
  Some Compilation Act        0  monitored              unmonitored
  … 2 more (-v)

  Refusals — 1 artist withheld from both decisions
  Code                     Count  Detail
  ───────────────────────  ─────  ───────────────────────────────────────
  cross-decision-conflict      1  artist 902 is proposed by both decisions

  Next
    rfmedia lidarr sync-ratings --explain rating-quality-upgrade:artist:118
    rfmedia lidarr sync-ratings --min-stars 4.5 --quality-profile Lossless --mode plan

  Nothing was written. Ratings are never written back to Plex.
  Execution: local-only lane · 1 attempt
```

```console
$ rfmedia lidarr sync-ratings --min-stars 4.5 --quality-profile Lossless --mode plan
  … (identical report) …

  Lidarr Artist Profile Assignment Plan
    Plan: 7c1f…  Checksum: sha256:9ab3…
    Path: ~/.config/rfmedia/plans/lidarr-2026-07-28T14-02-13Z-7c1f2a9b.json
    Changed 14 · Unchanged 0 · Risk: low · non-destructive
    Artist            Before      After
    Alcest            Standard    Lossless        CHANGE
    …

  Lidarr Artist Monitoring Plan
    Plan: 4e8d…  Checksum: sha256:11cc…
    Path: ~/.config/rfmedia/plans/lidarr-2026-07-28T14-02-14Z-4e8d55a1.json
    Changed 3 · Unchanged 0 · Risk: low · non-destructive
    …

  Apply (each re-reads live Lidarr and refuses on drift):
    rfmedia lidarr apply ~/.config/rfmedia/plans/lidarr-…-7c1f2a9b.json --yes \
      --expected-plan-id 7c1f… --expected-plan-checksum sha256:9ab3…
    rfmedia lidarr apply ~/.config/rfmedia/plans/lidarr-…-4e8d55a1.json --yes \
      --expected-plan-id 4e8d… --expected-plan-checksum sha256:11cc…
```

```console
$ rfmedia lidarr sync-ratings --decision monitoring --mode plan
  …
  monitoring — refused: rule-not-evaluated
    consumption-signal-empty: the Plex library reported zero plays library-wide;
    the resolved Plex token's account may not be the listening account
  Nothing was sealed.
$ echo $?
0
```

---

## 3. Architecture

### 3.1 Module map

| Path                                            | Lines (est.) | Responsibility                                                                                                                                                                                          |
| ----------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/lidarr-sync-ratings.ts`              | ~150         | **NEW.** Zero-value-import contract: decision vocabulary, decision→rule binding, refusal codes, option-longs const, result types, threshold-provenance types. Statically imported by the command.       |
| `src/lib/bridge/rating-sync.ts`                 | ~260         | **NEW. PURE, zero I/O.** `buildRatingSyncPlan` (per-decision gate, cohort projection, cross-decision conflict, fail-fast invariants) + `resolveSyncRatingsThresholds`. Imports only `../../types/*.js`. |
| `src/lib/bridge/rating-sync.test.ts`            | ~250         | **NEW.** Frozen-literal fixtures; no mocks.                                                                                                                                                             |
| `src/actions/lidarr/sync-ratings.ts`            | ~290         | **NEW.** The impure edge: mode dispatch, force-enable computation, producer calls, apply calls. Frozen `LidarrSyncRatingsDependencies`. No client call, no plan writer import, no rendering.            |
| `src/actions/lidarr/sync-ratings.test.ts`       | ~260         | **NEW.** `satisfies`-harness DI tests for the mutation gating.                                                                                                                                          |
| `src/commands/lidarr-sync-ratings.ts`           | ~330         | **NEW.** Commander leaf; all validation inside `.action()`; lazy actions barrel; interactive-approval wiring; output split; exit gate. Never imports `./lidarr.js`.                                     |
| `src/commands/lidarr-sync-ratings-presenter.ts` | ~280         | **NEW.** All stderr rendering, delegating to the three shipped presenters. Keeps the command inside the ~500-line budget (the `lidarr-policy.ts` 388 + presenter 1139 precedent).                       |
| `src/commands/lidarr-sync-ratings.test.ts`      | ~200         | **NEW.** Commander surface + validation-before-load contract.                                                                                                                                           |

Modified: `src/lib/bridge/policy-engine.ts` (~22 lines), `src/actions/lidarr/policy-evaluate.ts`
(~16 lines), `src/actions/lidarr/index.ts` (barrel), `src/commands/lidarr.ts` (import + one
`addCommand`), plus tests, completions and docs (§7).

### 3.2 Data flow

```
commands/lidarr-sync-ratings.ts  .action()
  │  resolveFormat() → OutputFormat
  │  resolveSyncRatingsDecisions(raw)   → LookupNotFoundError / MissingRequiredArgumentError
  │  resolveStarBound("--min-stars", raw, 1, 5)        → InvalidNumericArgumentError
  │  resolveIntegerBound("--max-plays", raw, 0, 1e6)   → InvalidNumericArgumentError
  │  resolveIntegerBound("--max-proposals", raw, 1, POLICY_MAX_PROPOSALS_PER_RULE)
  │  resolveMode(raw)                                   → LookupNotFoundError
  │  requireTargetProfile(decisions, raw, getLoadedPolicyConfig())
  │        → MissingRequiredArgumentError when "quality-profile" is selected and neither
  │          --quality-profile nor policy.rules.rating-quality-upgrade.targetQualityProfile
  │          is set (§A.1.6; a pure synchronous config read, no I/O)
  │  if (mode === "apply" && !yes) assertInteractiveApplyApproval(isMachineFormat(format))
  │        ── every check above runs BEFORE the lazy import ──
  ▼
  await (deps.loadActions ?? (() => import("../actions/lidarr/index.js")))()
  ▼
actions/lidarr/sync-ratings.ts  executeLidarrSyncRatings(options, deps)
  │  signal?.throwIfAborted()
  │  rawConfig = deps.loadedPolicyConfig()                    // no defaults injected
  │  decisionStates = { d ↦ "on" | "unset" | "off" }          // RAW tri-state, uncontaminated
  │  forceEnable = { ruleId | rawConfig?.rules?.[ruleId]?.enabled === undefined }
  │  disabledDecisions = { d | rawConfig?.rules?.[bind(d).ruleId]?.enabled === false }
  │  if every selected decision is "off" → return the all-refused report WITHOUT evaluating
  ▼
  deps.executeEvaluate({ rules: selectedRuleIds,  // ALWAYS non-empty, never undefined (§A.4.4)
                         plexLibrary, maxProposals,
                         ratingMinRating, ratingTargetQualityProfile, staleMaxPlays,
                         forceEnableRules: forceEnable,
                         plexUrl, plexToken, lidarrUrl, lidarrApiKey, signal })
       └─ actions/lidarr/policy-evaluate.ts (UNCHANGED behaviour; 4 new passthrough fields)
            selectRules → buildGatherPlan(requires ∪ enriches)
            resolveGatherLibrary → resolvePolicyConfig(config, overrides,
                                     notRequestedSlot("lidarrQualityProfiles"))  ◀ call #1 of 2,
              (policy-evaluate.ts:247-252, invoked :403) — BEFORE any gather, purely to read
              .plexLibrary, so every override must be side-effect-free, cheap, and inert against a
              `not-requested` profile slot (§A.1.2)
            gatherBridgeIdentity  → executeLidarrReconcile
            scheduler.runSingle("local-only") ▸
              gatherLidarrArtists / gatherLidarrQualityProfiles
              gatherPlexArtistRatings / gatherPlexTrackPlays     (never throw, never truncate)
              runLidarrPolicyEvaluation
                resolvePolicyConfig(config, overrides, qualityProfiles)   ◀ call #2, 6 edited slots
                  (policy-engine.ts:815-819; third parameter is `qualityProfiles`, :323-327)
                buildIndexes → indexAuthoritativeIdentities (mints PolicyIdentityLink)
                             → indexArtistRatings, buildTrackJoinSummary, toPolicyPlayIndex
                EVALUATORS["rating-quality-upgrade"], ["stale-monitoring-cleanup"]
            ⇒ deep-frozen PolicyEvaluationReport + LidarrExecutionSuccessMetadata
  │  signal?.throwIfAborted()
  ▼
  deps.buildPlan({ report, decisions, disabledDecisions })
       └─ lib/bridge/rating-sync.ts   PURE
            G1 decision-disabled   ← rawConfig enabled === false
            G2 rule-not-evaluated  ← report.rules is an ARRAY (types/lidarr-policy.ts:421):
                                     report.rules.find(r => r.id === ruleId)?.status === "skipped"
            filter report.proposals on ruleId ∈ selectedRuleIds  ← BEFORE any invariant (§A.4.4)
            project proposals → cohorts (verbatim before/after/checks/key)
            G3 cross-decision-conflict → drop from BOTH cohorts
            invariants (five) → SyncRatingsProjectionError (throw, never silent drop)
       ⇒ frozen RatingSyncPlan { cohorts, refusals, sealable, changedArtists }
  │
  │  if mode === "recommend" → return
  ▼  for each sealable cohort, in POLICY_PRODUCER_IDS declaration order:
  │    signal?.throwIfAborted()
  │    "artist-profile-assignment" →
  │       deps.executeArtistProfilePlan({ artistIds, qualityProfile: String(resolvedProfileId),
  │                                       maxBatch: artistIds.length, lidarrUrl, lidarrApiKey })
  │    "artist-monitoring" →
  │       deps.executeMonitoringPlan({ artistIds, monitored: false,
  │                                    maxBatch: artistIds.length, lidarrUrl, lidarrApiKey })
  │         ↳ both re-read FRESH live Lidarr, then buildLidarrMutationPlanV3 → writeLidarrPlanArtifact
  │    options.onPlanSealed?.(outcome)      ← path printed BEFORE any apply runs
  │
  │  if mode === "plan" → return
  ▼  for each sealed outcome, in the same order:
  │    signal?.throwIfAborted()
  │    if (!await deps.confirm(outcome)) continue            ← default dependency returns FALSE
  │    deps.executeApply({ planPath, dryRun: false, approved: true,
  │                        expectedPlanId: plan.id,
  │                        expectedPlanChecksum: plan.payloadChecksum,
  │                        lidarrUrl, lidarrApiKey, signal })
  ▼
commands/lidarr-sync-ratings-presenter.ts   (stderr)
  renderSyncRatings(result, { verbose })          ← thresholds, coverage, cohorts, refusals
      decision state/provenance comes from report.decisionStates (RAW config), NEVER from
      report.evaluation.policy.rules[id].enabled, which forceEnable contaminates (§A.1.7)
  renderMutationPlan({ planPath, plan }, verbose) ← per outcome, SHIPPED
  renderMutationApply(apply, mutationPresentationOptions(verbose))   ← per applied outcome, SHIPPED
      { verbose, allowTagReplacement: false, allowArtistDelete: false, allowAlbumDelete: false,
        allowFileDelete: false, plexScan: false }   ← all six fields REQUIRED (§A.3.6)
  renderSyncRatingsExplain(result, key)           ← delegates to SHIPPED renderPolicyExplain
  deps.renderExecutionSummary(execution)
  ▼  exit gate applied AFTER rendering
```

### 3.3 Scheduler: no nesting (load-bearing)

`executeLidarrSyncRatings` **must not** open its own `runSingle` slot. Every composed action already
schedules its own `local-only` unit, and nesting a second acquisition in the same lane deadlocks
whenever `lidarr.scheduler` narrows that lane's concurrency to one — the hazard documented verbatim at
`policy-evaluate.ts:264-267`. `TIER` is exported for barrel symmetry only; the returned `execution` is
the evaluation lane's, which is the only honest lane to report.

### 3.4 `maxBatch` is bound to cohort size (verified trap)

Both producers default `maxBatch` to `LIDARR_PLAN_DEFAULT_MAX_BATCH = 25`
(`plan.ts:88`, `plan-artist-profiles.ts:250`; const at `types/lidarr-plan.ts:13`), and there are **two**
independent throws above it:

- `selectLidarrArtists` → `` `Artist selection matched ${sorted.length} artists, exceeding maxBatch ${maxBatch}` `` (`artist-selection.ts:365-368`) — hit by the profile producer, and it fires **first** on that path.
- `buildLidarrMutationPlanV2` → `` `entries exceed maxBatch (${n} > ${maxBatch})` `` (`plan-engine.ts:1679-1683`) — hit by both. This is the throw reachable from V3: `buildLidarrMutationPlanV3` (`:1926-1934`) delegates to V2 (`:1674`) and **never** calls V1's byte-identical check at `:1608` (`buildLidarrMutationPlan`, declared `:1601`). The type is `LidarrPlanValidationError` via `validationError` (`src/lib/lidarr/plan-validation.ts:11`).

Since `--max-proposals` allows up to `POLICY_MAX_PROPOSALS_PER_RULE = 100`, leaving `maxBatch` at its
default would break every run above 25 proposals — precisely the highest-blast-radius runs — **after**
the full Plex drain and, in apply mode, after the operator typed `--mode apply --yes`.

Resolution: pass `maxBatch: cohort.artistIds.length`. Always valid
(`1 ≤ 100 ≪ LIDARR_PLAN_MAX_BATCH = 1000`), removes the coupled-knob footgun entirely, and needs no
CLI flag. The action's defensive assertion is **two-sided** — `1 <= cohort.artistIds.length <=
LIDARR_PLAN_MAX_BATCH` — because the lower bound is real: an empty cohort fails at
`artist-selection.ts:171-173` (`Artist ID selection requires at least one ID`) and at `plan.ts:57-59`.
It is never reached in practice, since `gate === "sealable"` already requires ≥1 change.
`LIDARR_PLAN_MAX_ENTRIES = 1_000` (`types/lidarr-plan.ts:15`) is a second, independently enforced
identical cap (`plan-engine.ts:1679-1685`), and `artist-selection.ts:158-163` separately rejects a
`maxBatch` that is not a positive safe integer with a `TypeError`.

### 3.5 Profile targeting binds by ID, not by name

The profile producer is invoked with `String(resolvedProfileId)` read off
`report.policy.rules["rating-quality-upgrade"]` after narrowing on `.kind`, **never** with
`after["qualityProfileName"]`.

`resolvedProfileId` is typed `number | null` (`types/lidarr-policy.ts:340`) and `String()` accepts
anything, so `String(null)` would bind the literal `"null"`; the runtime invariant that prevents it
lives in a **different** module (`policy-rule-rating-upgrade.ts:92-99`). The projection therefore
asserts `typeof resolved.resolvedProfileId === "number"` after the `.kind` narrow and throws
`SyncRatingsProjectionError` otherwise — the fifth G4 invariant (§A.4.5).

Why: `resolveLidarrProfileReference` → `resolveResourceReference` tests
`POSITIVE_DECIMAL_PATTERN = /^\d+$/u` **first** (`artist-selection.ts:107`), then falls to
case-insensitive exact name matching, and throws on an ambiguous name. Binding by id is
unambiguous, and it is what the rule actually decided on — the name is a display projection. The
shipped producer already uses this exact idiom internally for the `before` state
(`plan-artist-profiles.ts:257`).

This is also safe against the `lidarr-editor-body-owner` architecture rule, which is a raw AST check
for a literal containing key `artistIds` **together with** key `qualityProfileId`
(`scripts/check-direct-plex-imports.mjs`). The literal constructed here is
`{ artistIds, qualityProfile: string, maxBatch }` — no `qualityProfileId` key.

### 3.6 Exact existing symbols reused

**Actions:** `executeLidarrPolicyEvaluate`, `executeLidarrReconcile`, `executeLidarrArtistProfilePlan`,
`executeLidarrPlan`, `executeLidarrApply`.

Neither `defaultOutputPath` nor `getDefaultPlanDir` is reused (§A.2.5): both producers own path
resolution themselves (`plan.ts:106`; `plan-artist-profiles.ts:283-285` keeps a private byte-identical
copy), the producer calls here never pass `output`, and `defaultOutputPath` is not even on the
`src/actions/lidarr/index.ts` barrel. The action reads `generated.planPath` off the producer result.

**Pure engine:** `runLidarrPolicyEvaluation`, `resolvePolicyConfig`, `resolveTargetProfileId`,
`POLICY_DEFAULTS`, `indexAuthoritativeIdentities`, `indexArtistRatings`, `buildTrackJoinSummary`,
`toPolicyPlayIndex`, `lookupArtistPlays`, `buildPolicyEvaluationCoverage`, `createPolicyProposal`,
`createPolicySkip`, `checkArtistRating`, `buildPolicyHandoff`, `applyCohortCap`, `selectBlockingCause`.

**Plan/apply:** `buildLidarrMutationPlanV3`, `writeLidarrPlanArtifact`, `readLidarrPlanArtifact`,
`acquireLidarrPlanClaim`, `appendLidarrPlanHistory`, `selectLidarrResumeEntries`,
`getLidarrMutationOperationDefinition` (all reached indirectly, none imported here).

**Presenters:** `renderPolicyEvaluation`, `renderPolicyExplain`, `policyDecisionKeys`,
`projectPolicyEvaluationCsv`, `LIDARR_POLICY_EVALUATE_CSV_COLUMNS`, `renderMutationPlan`,
`renderMutationApply`, `confirmMutationApply`, `assertInteractiveApplyApproval`.

**Types/registry:** `POLICY_RULE_IDS`, `POLICY_RULE_DESCRIPTORS`, `POLICY_PRODUCER_IDS`,
`POLICY_MAX_PROPOSALS_PER_RULE`, `POLICY_HUMAN_ROW_CAP`, `PolicyEvaluationReport`, `PolicyProposal`,
`PolicyThresholdCheck`, `LidarrPlanGenerationResultV3`, `LidarrPlanApplyResult`.

**Errors/infra:** `LookupNotFoundError`, `MissingRequiredArgumentError`, `InvalidNumericArgumentError`,
`LidarrPlanValidationError`, `isMachineFormat`, `formatOutput`, `resolveFormat`,
`reportLidarrFailure`, `renderExecutionSummary`, `logDebug`.

---

## 4. Types

### 4.1 `src/types/lidarr-sync-ratings.ts` (ZERO value imports)

```ts
/**
 * Contract module for `rfmedia lidarr sync-ratings` (#221).
 *
 * ZERO VALUE IMPORTS — every import below carries `type`.
 * `src/commands/lidarr-sync-ratings.ts` imports this statically for the
 * option-long list, the decision vocabulary, and the numeric bounds; a single
 * value import would drag the evaluator graph, the Plex adapter, the Lidarr
 * client and the tracking database into every CLI cold start.
 */

import type { LidarrPlanApplyResult, LidarrPlanGenerationResultV3, LidarrMutationPlanV3 } from "./lidarr-plan.js";
import type {
  PolicyDecisionKey,
  PolicyEvaluationReport,
  PolicyProducerId,
  PolicyRuleId,
  PolicyRuleSkipReason,
  PolicyThresholdCheck,
} from "./lidarr-policy.js";

export const SYNC_RATINGS_SCHEMA = "rfmedia.lidarr-ratings-sync.v1" as const;

/* ── Decision vocabulary ─────────────────────────────────────────────────── */

/**
 * The two rating-driven decisions, named after the plan `operation.kind` they
 * seal into so the flag value and the artifact kind are the same word.
 *
 * `discovery-seed` is deliberately absent: its descriptor `producer` is `null`,
 * so it can never be sealed into a plan artifact.
 */
export const SYNC_RATINGS_DECISIONS = ["quality-profile", "monitoring"] as const;
export type SyncRatingsDecision = (typeof SYNC_RATINGS_DECISIONS)[number];

export interface SyncRatingsDecisionBinding {
  readonly ruleId: PolicyRuleId;
  readonly producer: PolicyProducerId;
}

/** Decision → the shipped rule that computes it → the producer that seals it. */
export const SYNC_RATINGS_DECISION_BINDING = Object.freeze({
  "quality-profile": {
    ruleId: "rating-quality-upgrade",
    producer: "artist-profile-assignment",
  },
  monitoring: {
    ruleId: "stale-monitoring-cleanup",
    producer: "artist-monitoring",
  },
} satisfies Readonly<Record<SyncRatingsDecision, SyncRatingsDecisionBinding>>);

/** Narrowing guard for `--decision`, applied INSIDE `.action()`. */
export function isSyncRatingsDecision(value: string): value is SyncRatingsDecision {
  return (SYNC_RATINGS_DECISIONS as readonly string[]).includes(value);
}

/* ── Modes ───────────────────────────────────────────────────────────────── */

/**
 * The three rungs, in ascending write authority. This IS the `--mode` value
 * list, shared verbatim with all three completion templates.
 */
export const SYNC_RATINGS_MODES = ["recommend", "plan", "apply"] as const;
export type LidarrSyncRatingsMode = (typeof SYNC_RATINGS_MODES)[number];

/** Narrowing guard for `--mode`, applied INSIDE `.action()` — never `.choices()`. */
export function isSyncRatingsMode(value: string): value is LidarrSyncRatingsMode {
  return (SYNC_RATINGS_MODES as readonly string[]).includes(value);
}

/* ── Refusals ────────────────────────────────────────────────────────────── */

/** Stable kebab refusal codes — a public contract; CI may grep these. */
export const SYNC_RATINGS_REFUSAL_CODES = [
  "decision-disabled",
  "rule-not-evaluated",
  "cross-decision-conflict",
] as const;
export type SyncRatingsRefusalCode = (typeof SYNC_RATINGS_REFUSAL_CODES)[number];

/** A refusal is DATA, never an omission. */
export interface SyncRatingsRefusal {
  readonly code: SyncRatingsRefusalCode;
  /** `decision` blocks one cohort; `artist` withholds one subject. */
  readonly scope: "decision" | "artist";
  /** The decision blocked, or `null` for an artist withheld from BOTH. */
  readonly decision: SyncRatingsDecision | null;
  /** Present only for `scope: "artist"`. Id keys stay SINGULAR by contract. */
  readonly artistId: number | null;
  /** The blocking rule's own `skipReason`, when the cause was a rule skip. */
  readonly ruleSkipReason: PolicyRuleSkipReason | null;
  readonly detail: string;
  /** The exact `.rfmedia.yaml` key or CLI flag that resolves it, or null. */
  readonly remedy: string | null;
}

/* ── Cohorts ─────────────────────────────────────────────────────────────── */

/**
 * One artist-level change, projected VERBATIM off a frozen `PolicyProposal`.
 *
 * `before` / `after` carry the proposal's maps verbatim and MUST keep this exact
 * index-signature declaration — a narrower one is not assignment-compatible. With
 * `noPropertyAccessFromIndexSignature` on, dot access raises TS4111, and with
 * `noUncheckedIndexedAccess` on, bracket access yields `… | undefined`; every read
 * therefore uses bracket access plus a `typeof` narrow (§A.4.2).
 */
export interface SyncRatingsChange {
  /** The proposal's stable, non-rotating key; `--explain` accepts it. */
  readonly decisionKey: PolicyDecisionKey;
  readonly artistId: number;
  readonly artistName: string;
  readonly plexId: string;
  readonly artistMbid: string | null;
  readonly before: Readonly<Record<string, string | number | boolean | null>>;
  readonly after: Readonly<Record<string, string | number | boolean | null>>;
  readonly checks: readonly PolicyThresholdCheck[];
  readonly summary: string;
}

/** One producer cohort. `changes` is empty unless `gate === "sealable"`. */
export interface SyncRatingsCohort {
  readonly decision: SyncRatingsDecision;
  readonly ruleId: PolicyRuleId;
  readonly producer: PolicyProducerId;
  readonly gate: "sealable" | "refused" | "no-changes";
  /** The single sealed target profile id; `null` for a monitoring cohort. */
  readonly resolvedProfileId: number | null;
  /** Display-only target name; the producer binds by id, never by this. */
  readonly qualityProfileName: string | null;
  /** Desired monitored state; `null` for a profile cohort. */
  readonly desiredMonitored: boolean | null;
  readonly changes: readonly SyncRatingsChange[];
  /** Ascending, deduplicated. Empty unless `gate === "sealable"`. */
  readonly artistIds: readonly number[];
}

/* ── Thresholds ──────────────────────────────────────────────────────────── */

export type SyncRatingsThresholdSource = "flag" | "config" | "default";

export interface SyncRatingsThreshold<T> {
  readonly value: T;
  readonly source: SyncRatingsThresholdSource;
  /** Dotted `.rfmedia.yaml` key, or null when the knob is flag-only. */
  readonly configPath: string | null;
}

/**
 * Honest per-field provenance.
 *
 * `PolicyThresholdCheck.configPath` on a proposal always cites the
 * `.rfmedia.yaml` key even when the effective bound arrived from a flag, so a
 * reviewer needs this block to tell a persistent policy from a one-off
 * experiment.
 */
export interface SyncRatingsResolvedThresholds {
  readonly minStars: SyncRatingsThreshold<number>;
  readonly maxPlays: SyncRatingsThreshold<number>;
  readonly qualityProfile: SyncRatingsThreshold<string | null>;
  readonly maxProposals: SyncRatingsThreshold<number>;
}

/* ── Result ──────────────────────────────────────────────────────────────── */

/**
 * The only two v3 plan shapes sync-ratings can seal.
 *
 * A SUBSET of `LidarrMutationPlanV3` ⊂ the closed `LidarrPlanV3`, and
 * `LidarrPlanGenerationResultV3<TPlan>` holds `TPlan` in a `readonly` position,
 * so `LidarrPlanGenerationResultV3<LidarrSyncRatingsPlan>` is structurally
 * assignable to the presenter's parameter and `renderMutationPlan` typechecks
 * UNCHANGED. Do NOT widen the presenter-private `AnyLidarrPlanGenerationResult`
 * union (`lidarr-mutation-presenter.ts:60-68`) — this is the same `Extract`
 * idiom both producers already use privately.
 */
export type LidarrSyncRatingsPlan = Extract<
  LidarrMutationPlanV3,
  { readonly operation: { readonly kind: "artist-monitoring" | "artist-profile-assignment" } }
>;

/** One sealed artifact and, in apply mode, its outcome. */
export interface LidarrSyncRatingsOutcome {
  readonly decision: SyncRatingsDecision;
  readonly ruleId: PolicyRuleId;
  readonly producer: PolicyProducerId;
  /** `{ planPath, plan }` exactly as `renderMutationPlan` consumes it. */
  readonly generated: LidarrPlanGenerationResultV3<LidarrSyncRatingsPlan>;
  /** Absent in `"plan"` mode and when an interactive confirm was declined. */
  readonly apply?: LidarrPlanApplyResult;
}

/**
 * Proportion of the matched library this run would change. Reported, never a gate.
 *
 * NEW to this feature. `PolicyEvaluationCoverage` has exactly eight fields and
 * NO `footprint` (`types/lidarr-policy.ts:389-402`), so `fraction` is computed
 * in `rating-sync.ts`, not read off the policy report.
 */
export interface SyncRatingsFootprint {
  /** `report.coverage.authoritativeLinks` — the exact-MBID population. */
  readonly authoritativeLinks: number;
  /** Distinct artists across every sealable cohort. */
  readonly changedArtists: number;
  /** `changedArtists / Math.max(authoritativeLinks, 1)`, rounded to four decimals. */
  readonly fraction: number;
}

export interface LidarrSyncRatingsReport {
  readonly schema: typeof SYNC_RATINGS_SCHEMA;
  readonly mode: LidarrSyncRatingsMode;
  readonly decisions: readonly SyncRatingsDecision[];
  readonly thresholds: SyncRatingsResolvedThresholds;
  readonly cohorts: readonly SyncRatingsCohort[];
  /** Decision- and artist-scoped refusals, in `SYNC_RATINGS_REFUSAL_CODES` order. */
  readonly refusals: readonly SyncRatingsRefusal[];
  readonly footprint: SyncRatingsFootprint;
  /** 0-2 outcomes, ordered by `POLICY_PRODUCER_IDS` declaration order. */
  readonly outcomes: readonly LidarrSyncRatingsOutcome[];
  /**
   * The verbatim frozen `PolicyEvaluationReport` object returned by the
   * unmodified `executeLidarrPolicyEvaluate`.
   *
   * The projection reads ONLY from it, so the two commands cannot disagree
   * about a decision. It is deliberately NOT described as byte-identical to a
   * `lidarr policy evaluate --rule …` run and nothing asserts that: the report
   * stamps `evaluatedAt` per run, the four overrides mutate the echoed resolved
   * policy, `forceEnable` enables rules the policy leaf never enables, and
   * `plexOrigin`/`lidarrOrigin` fall back to the literal `"unknown"`.
   * `--explain` reads it.
   */
  readonly evaluation: PolicyEvaluationReport;
  /**
   * The RAW `policy.rules.<id>.enabled` tri-state per decision, straight from
   * `getLoadedPolicyConfig()`.
   *
   * Load-bearing: `report.evaluation.policy.rules[id].enabled` is
   * override-CONTAMINATED under `forceEnable` (the engine writes the forced
   * value into the frozen resolved rule and echoes it at
   * `policy-engine.ts:883`), so the presenter MUST take decision state and
   * provenance from here instead.
   */
  readonly decisionStates: Readonly<Record<SyncRatingsDecision, "on" | "unset" | "off">>;
}

/* ── Bounds ──────────────────────────────────────────────────────────────── */

/** Inclusive `--min-stars` bounds, matching `validateStarRating`. */
export const SYNC_RATINGS_MIN_STARS = 1;
export const SYNC_RATINGS_MAX_STARS = 5;
/** Inclusive `--max-plays` ceiling, matching the config validator's bound. */
export const SYNC_RATINGS_MAX_PLAYS = 1_000_000;

/**
 * Every long option the leaf declares, in Commander declaration order.
 *
 * The single artifact binding the leaf to the hand-written completion
 * templates: `templates.spec.ts` never constructs the Commander program, so
 * nothing else in the repo reconciles the two. Root `--output` / `--json` are
 * declared on the root program and deliberately absent here.
 */
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
] as const;
```

### 4.2 `src/lib/bridge/rating-sync.ts` (PURE)

```ts
/**
 * The pure decision-projection layer for `lidarr sync-ratings` (#221).
 *
 * ZERO I/O: no client, no adapter, no database, no clock, no fetch. Imports
 * only `../../types/*.js` — never `./policy-rules.js` or `./policy-engine.js`,
 * which would close an ESM cycle.
 */

import type { PolicyConfigOptions } from "../../types/config.js";
import type { PolicyEvaluationReport } from "../../types/lidarr-policy.js";
import type {
  LidarrSyncRatingsMode,
  SyncRatingsCohort,
  SyncRatingsDecision,
  SyncRatingsFootprint,
  SyncRatingsRefusal,
  SyncRatingsResolvedThresholds,
} from "../../types/lidarr-sync-ratings.js";

/** Dotted `.rfmedia.yaml` keys and flags a refusal may cite as its remedy. */
export const SYNC_RATINGS_REMEDY = {
  "quality-profile": "policy.rules.rating-quality-upgrade.enabled",
  monitoring: "policy.rules.stale-monitoring-cleanup.enabled",
} as const;

/**
 * An invariant the engine guarantees was violated.
 *
 * Thrown, never silently skipped: a malformed proposal that is quietly dropped
 * produces a silently WRONG cohort, and a cohort is what becomes a mutation.
 */
export class SyncRatingsProjectionError extends Error {
  readonly decisionKey: string;
  constructor(decisionKey: string, detail: string);
}

export interface RatingSyncPlanInput {
  /** A completed, deep-frozen evaluation report. */
  readonly report: PolicyEvaluationReport;
  /** The operator's `--decision` selection, in declaration order. */
  readonly decisions: readonly SyncRatingsDecision[];
  /**
   * Decisions whose rule is EXPLICITLY `enabled: false` in `.rfmedia.yaml`.
   *
   * Computed by the action from the RAW config, where `undefined` (never
   * configured) and `false` (deliberately switched off) are still
   * distinguishable — `resolvePolicyConfig` collapses both to `false`.
   */
  readonly disabledDecisions: ReadonlySet<SyncRatingsDecision>;
}

export interface RatingSyncPlan {
  readonly cohorts: readonly SyncRatingsCohort[];
  readonly refusals: readonly SyncRatingsRefusal[];
  /** Decisions whose cohort passed every gate AND has at least one change. */
  readonly sealable: readonly SyncRatingsDecision[];
  readonly footprint: SyncRatingsFootprint;
}

/**
 * Projects a frozen evaluation report into sealable producer cohorts.
 *
 * Pure, synchronous, deep-freezing. Gates, in order: explicit config disable;
 * per-decision rule-not-evaluated; cross-decision conflict. There is
 * deliberately NO whole-report gate — `report.status === "degraded"` is set by
 * ANY rule's evaluator skip, so gating on it would let one unrelated rule block
 * a perfectly healthy cohort. Gating on each selected rule's own
 * `PolicyRuleResult` is both strictly more precise and carries the rule's own
 * `skipReason` and `detail` to the operator verbatim.
 *
 * `report.proposals` is filtered on `proposal.ruleId ∈ selectedRuleIds` BEFORE
 * any invariant runs, so a `discovery-seed` proposal — which legitimately
 * carries no `subject.artistId` — can never be mistaken for an engine-invariant
 * violation.
 *
 * `footprint.fraction` is computed here as
 * `changedArtists / Math.max(report.coverage.authoritativeLinks, 1)` rounded to
 * four decimals; the policy report has no footprint field.
 *
 * @param input - The report, the selection, and the explicit-disable set.
 * @returns The frozen plan.
 * @throws {SyncRatingsProjectionError} On any of the five G4 invariants — a
 *   proposal with no `subject.artistId`; an `after["monitored"]` that is not a
 *   boolean; an `after["qualityProfileId"]` that is not a number; two profile
 *   proposals naming different target ids; a non-empty profile cohort whose
 *   `resolvedProfileId` is not a number — and on the same G4-class violation of a
 *   selected rule being absent from `report.rules` entirely.
 */
export function buildRatingSyncPlan(input: RatingSyncPlanInput): RatingSyncPlan;

export interface SyncRatingsThresholdInput {
  readonly report: PolicyEvaluationReport;
  /** Raw `policy:` config exactly as the validator returned it — no defaults. */
  readonly config: PolicyConfigOptions | undefined;
  readonly overrides: {
    readonly minStars?: number;
    readonly maxPlays?: number;
    readonly qualityProfile?: string;
    readonly maxProposals?: number;
  };
}

/**
 * Resolves every threshold with honest `flag | config | default` provenance.
 *
 * Effective VALUES are read back off `report.policy.rules[…]`, which the engine
 * already defaulted at its single site (`POLICY_DEFAULTS`), so this module never
 * re-declares a policy default. Only the SOURCE tag is derived here.
 *
 * @param input - The report, raw config, and CLI overrides.
 * @returns The frozen resolved thresholds echoed in the report.
 */
export function resolveSyncRatingsThresholds(input: SyncRatingsThresholdInput): SyncRatingsResolvedThresholds;
```

### 4.3 `src/lib/bridge/policy-engine.ts` — the engine override seam

`resolvePolicyConfig` is called **twice** per evaluation, not once (§A.1.2): first from
`resolveGatherLibrary` (`policy-evaluate.ts:247-252`, invoked at `:403`) **before any gather**, with a
synthetic `notRequestedSlot("lidarrQualityProfiles")` purely to read `.plexLibrary`; then inside the
engine at `policy-engine.ts:815-819`. Every new override must therefore be side-effect-free, cheap,
and **inert against a `not-requested` profile slot**. `resolveTargetProfileId` already early-returns
`null` when `slot.status !== "available"` (`:288-290`), so `ratingTargetQualityProfile` is safe — but
that is a **required test case** (§8.4), not an assumption.

```ts
export interface PolicyEvaluationOverrides {
  readonly plexLibrary?: string;
  readonly maxProposals?: number;
  /** #221 `--min-stars`. Overrides ONLY `rating-quality-upgrade.minRating`. */
  readonly ratingMinRating?: number;
  /**
   * #221 `--quality-profile`. A name or numeric id, resolved against the LIVE
   * profile slot by `resolveTargetProfileId` exactly as the config value is.
   */
  readonly ratingTargetQualityProfile?: string;
  /** #221 `--max-plays`. Overrides ONLY `stale-monitoring-cleanup.maxPlays`. */
  readonly staleMaxPlays?: number;
  /**
   * Rule ids treated as enabled regardless of `policy.rules.<id>.enabled`.
   *
   * NEW in #221 — `forceEnable` does not exist anywhere in the tree today, and
   * `PolicyEvaluationOverrides` (policy-engine.ts:211-214) carries exactly
   * `plexLibrary` and `maxProposals`. Because the `disabled` gate reads
   * `input.policy.rules[id].enabled` — the value `resolvePolicyConfig` produced —
   * routing it through `resolvePolicyConfig` is the correct AND ONLY seam.
   *
   * Callers MUST narrow `selected` to the same ids. `runRule` applies the
   * `not-selected` gate (policy-engine.ts:765-766) BEFORE the `disabled` gate
   * (:770-771), so a force-enabled but unselected rule still reports
   * `not-selected` — verified.
   *
   * The sync-ratings action populates this ONLY for rules whose config
   * `enabled` is `undefined` (never configured). An explicit `false` is a
   * deliberate kill switch and is honoured as a `decision-disabled` refusal.
   */
  readonly forceEnable?: ReadonlySet<PolicyRuleId>;
}
```

`resolvePolicyConfig` gains one module-private helper and **six** changed expressions — this exact
list, verified line by line against current source (§A.1.5):

| Site                   | Current                                                              | Becomes                                                                             |
| ---------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `policy-engine.ts:332` | `const targetQualityProfile = rating?.targetQualityProfile ?? null;` | `overrides.ratingTargetQualityProfile ?? rating?.targetQualityProfile ?? null`      |
| `policy-engine.ts:336` | `enabled: rating?.enabled ?? false,`                                 | `enabled: forceEnabled("rating-quality-upgrade", rating?.enabled),`                 |
| `policy-engine.ts:337` | `minRating: rating?.minRating ?? POLICY_DEFAULTS.ratingMinRating,`   | `overrides.ratingMinRating ?? rating?.minRating ?? POLICY_DEFAULTS.ratingMinRating` |
| `policy-engine.ts:346` | `enabled: stale?.enabled ?? false,`                                  | `enabled: forceEnabled("stale-monitoring-cleanup", stale?.enabled),`                |
| `policy-engine.ts:347` | `maxPlays: stale?.maxPlays ?? POLICY_DEFAULTS.staleMaxPlays,`        | `overrides.staleMaxPlays ?? stale?.maxPlays ?? POLICY_DEFAULTS.staleMaxPlays`       |
| `policy-engine.ts:358` | `enabled: seed?.enabled ?? false,`                                   | `enabled: forceEnabled("discovery-seed", seed?.enabled),`                           |

```ts
const forceEnabled = (id: PolicyRuleId, configured: boolean | undefined): boolean =>
  overrides.forceEnable?.has(id) === true || (configured ?? false);
```

`POLICY_DEFAULTS` remains the single defaults site (module-private, referenced only inside this
function — verified). `policy evaluate` supplies none of the new fields, so its resolved policy is
unchanged; §8.4 pins that as an explicit no-regression assertion.

**Contamination is a documented property, not a bug.** Lines `:336` / `:346` / `:358` write `enabled`
into the frozen resolved rule, which the report echoes verbatim at `:883`. Under `forceEnable`,
`report.policy.rules[id].enabled` therefore reports `true` for a rule the operator never configured.
It MUST NOT be the presenter's source for decision state or provenance — that comes from
`LidarrSyncRatingsReport.decisionStates`, derived from the raw `PolicyConfigOptions` (§A.1.7).

### 4.4 `src/actions/lidarr/policy-evaluate.ts` — passthrough only

```ts
export interface LidarrPolicyEvaluateActionOptions {
  // … existing fields unchanged …
  /** #221 `--min-stars`. Declared here; the policy leaf never sets it. */
  readonly ratingMinRating?: number;
  /** #221 `--quality-profile`. Declared here; the policy leaf never sets it. */
  readonly ratingTargetQualityProfile?: string;
  /** #221 `--max-plays`. Declared here; the policy leaf never sets it. */
  readonly staleMaxPlays?: number;
  /** #221 per-invocation rule enablement. The policy leaf never sets it. */
  readonly forceEnableRules?: ReadonlySet<PolicyRuleId>;
}
```

and the single `overrides` literal gains the four fields verbatim. No other change; the module's
documented zero-writes property is untouched.

### 4.5 `src/actions/lidarr/sync-ratings.ts`

```ts
/** Reliability tier; exported for barrel symmetry. This action schedules nothing itself. */
export const TIER: LidarrTier = "local-only";

export interface LidarrSyncRatingsActionOptions {
  readonly mode: LidarrSyncRatingsMode;
  readonly plexLibrary?: string;
  /**
   * Omitted selects every decision; an EMPTY array is not a valid selection.
   *
   * The action always forwards an explicitly non-empty `rules` array derived
   * from `SYNC_RATINGS_DECISION_BINDING` — never `undefined`, never `[]` —
   * because `policy-evaluate.ts:217-222` treats both as "all rules", which pulls
   * in `discovery-seed` whose proposals carry no `subject.artistId` (§A.4.4).
   */
  readonly decisions?: readonly SyncRatingsDecision[];
  readonly minStars?: number;
  readonly maxPlays?: number;
  readonly qualityProfile?: string;
  readonly maxProposals?: number;
  /** Emitted the moment an artifact is sealed, BEFORE any apply runs. */
  readonly onPlanSealed?: (outcome: LidarrSyncRatingsOutcome) => void;
  /** Forwarded RAW so the cross-origin credential guard stays live. */
  readonly plexUrl?: string;
  readonly plexToken?: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
  readonly signal?: AbortSignal;
}

export interface LidarrSyncRatingsActionResult {
  readonly report: LidarrSyncRatingsReport;
  /** The evaluation lane's metadata; no second scheduler slot is acquired. */
  readonly execution: LidarrExecutionSuccessMetadata;
}

/**
 * Injectable ownership seams.
 *
 * Mirrors `LidarrPolicyEvaluateDependencies` / `LidarrReconcileDependencies`:
 * every collaborator that performs I/O or reads process-wide state is named
 * here, so the tests drive the whole flow with no Plex adapter, no Lidarr
 * client, no plan directory and no prompt.
 */
export interface LidarrSyncRatingsDependencies {
  readonly executeEvaluate: typeof executeLidarrPolicyEvaluate;
  readonly buildPlan: typeof buildRatingSyncPlan;
  readonly resolveThresholds: typeof resolveSyncRatingsThresholds;
  readonly executeArtistProfilePlan: typeof executeLidarrArtistProfilePlan;
  readonly executeMonitoringPlan: typeof executeLidarrPlan;
  readonly executeApply: typeof executeLidarrApply;
  readonly loadedPolicyConfig: typeof getLoadedPolicyConfig;
  /**
   * Approval collaborator, consulted ONCE per sealed artifact in `"apply"`
   * mode. The default REFUSES: an embedder that forgets to inject an approval
   * path gets zero mutations, not silent ones.
   */
  readonly confirm: (outcome: LidarrSyncRatingsOutcome) => Promise<boolean>;
}

const DEFAULT_DEPENDENCIES: LidarrSyncRatingsDependencies = Object.freeze({
  executeEvaluate: executeLidarrPolicyEvaluate,
  buildPlan: buildRatingSyncPlan,
  resolveThresholds: resolveSyncRatingsThresholds,
  executeArtistProfilePlan: executeLidarrArtistProfilePlan,
  executeMonitoringPlan: executeLidarrPlan,
  executeApply: executeLidarrApply,
  loadedPolicyConfig: getLoadedPolicyConfig,
  confirm: async () => false,
});

/**
 * Runs one recommend / plan / apply pass over the rating-driven policy rules.
 *
 * Schedules no work of its own: every composed action already acquires its own
 * `local-only` slot, and nesting `runSingle` deadlocks a lane narrowed to
 * concurrency 1 (`policy-evaluate.ts:264-267`).
 *
 * Writes nothing to Plex under any flag combination. Never writes to stdout and
 * never sets `process.exitCode`.
 *
 * @param options - Mode, selection, thresholds, and connection overrides.
 * @param dependencies - Injected collaborators; defaults to the real ones.
 * @returns The frozen report plus the evaluation lane's execution metadata.
 * @throws {Error} From the artist-profile producer. On that path a vanished
 *   artist id (`artist-selection.ts:187`), an unresolvable target profile
 *   (`:133-137`), an unresolvable profile on the cohort's BEFORE state
 *   (`plan-artist-profiles.ts:256-265` re-resolves every cohort artist's current
 *   `qualityProfileId`; a deleted profile throws `Unknown profile reference` and
 *   a `qualityProfileId === 0` throws a `TypeError` at `:64-69`), an over-cap
 *   cohort (`:366-368`) and a bad `maxBatch` (`:160-162`) are all plain
 *   `Error`/`TypeError`, NOT `LidarrPlanValidationError`.
 * @throws {LidarrPlanValidationError} From the monitoring producer's vanished-id
 *   path (`plan.ts:81-83`) and from the plan engine's `maxBatch` / entry caps
 *   (`plan-engine.ts:1681-1682`).
 * @throws {SyncRatingsProjectionError} When the engine violated an invariant.
 * @throws {DOMException} `AbortError`, when `signal` aborts between stages.
 */
export async function executeLidarrSyncRatings(
  options: LidarrSyncRatingsActionOptions,
  dependencies: LidarrSyncRatingsDependencies = DEFAULT_DEPENDENCIES,
): Promise<LidarrSyncRatingsActionResult>;
```

### 4.6 `src/commands/lidarr-sync-ratings.ts`

```ts
/** The slice of the actions barrel this leaf consumes. */
export interface LidarrSyncRatingsActions {
  readonly executeLidarrSyncRatings: (
    options: LidarrSyncRatingsActionOptions,
    dependencies?: LidarrSyncRatingsDependencies,
  ) => Promise<LidarrSyncRatingsActionResult>;
}

/** Parent-private helpers injected without importing `./lidarr.js`. */
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
  /** Test/embedding seam; production keeps the actions barrel lazy. */
  readonly loadActions?: () => Promise<LidarrSyncRatingsActions>;
}

export interface LidarrSyncRatingsMachineOutput {
  readonly command: "lidarr-sync-ratings";
  readonly result: LidarrSyncRatingsReport;
}

/** Non-throwing `--decision` accumulator; validation happens in `.action()`. */
export function parseSyncRatingsDecisions(value: string, previous?: readonly string[]): string[];

export function createLidarrSyncRatingsCommand(deps: LidarrSyncRatingsCommandDeps): Command;
```

---

## 5. Decision logic

### 5.1 The rating math is not re-implemented

Plex exposes exactly one rating field per entity: `userRating`, an optional finite number on the
**Plex-native `0..10`** scale (`PLEX_NATIVE_RATING_MAX = 10`, `plex/mappers.ts:34`).

`plexNativeRatingToNormalized` (`plex/mappers.ts:75-83`, verified) maps **both** `undefined`/`null`
**and** native `0` to `null` — UNRATED — and positive values to `rating / 10` on the closed `0..1`
interval, preserving fractional precision. That lands on
`MediaEntityBase.rating: NormalizedMediaRating | null`.

`--min-stars` is compared on the **normalized** scale, never on a star projection:
`checkArtistRating` (`policy-rule-support.ts:382`) delegates to `evaluateMediaFilterRule`, which
converts the 1–5 star bound via `value / 5` and reads `item.rating`. The `observed` value on the
emitted `PolicyThresholdCheck` is a display-only projection `Math.round(rating * 500) / 100`.

`checkArtistRating`'s comparator parameter is typed `">=" | "<="` **on purpose**:
`evaluateMediaFilterRule` returns `true` for `!=` / `not_contains` when the field is `undefined`,
which would invert the fail-closed semantics for an unrated artist. Nothing in this design widens it.

### 5.2 Rating aggregation: there is none, and that is correct

Ratings are **not** aggregated from tracks or albums to the artist. `indexArtistRatings`
(`policy-signals.ts:234`) is a pure id join keyed on `MediaArtist.id` = Plex `ratingKey` =
`ReconciliationSourceIdentity.plexId`, join grade `exact-plex-id`. The artist's **own** `userRating`
is the signal. `rating === null` is preserved as UNRATED, because collapsing it to `0` would make an
unrated artist read as the worst-rated in the library.

Play counts **are** aggregated, and the join is weak: `MediaTrack` carries `artist: string` (Plex
`grandparentTitle` — the **album** artist) and `playCount: number`, with no artist id. Totals bucket
under `normalizeBridgeArtistName(track.artist)` with three fail-closed poisonings (the
`"Unknown Artist"` sentinel, any name claimed by ≥2 distinct Plex ids, and absent coverage).
`lookupArtistPlays` returns a `PolicyObservation<number>` whose gaps are refusals
(`sentinel-artist-name`, `ambiguous-name-join`, `no-consumption-coverage`) — **never** zero.

### 5.3 Threshold semantics

| Threshold           | Comparator                                         | Applies to                           | Fail-closed behaviour                                                                      |
| ------------------- | -------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `--min-stars`       | `rating >= minStars` on the normalized scale       | `rating-quality-upgrade`             | unrated → `signal-unavailable`; below floor → `signal-unavailable` with the check attached |
| `--max-plays`       | `plays <= maxPlays`                                | `stale-monitoring-cleanup`           | unobservable join → `no-consumption-coverage` / `ambiguous-name-join`; never zero          |
| `--quality-profile` | structural `qualityProfileId != resolvedProfileId` | `rating-quality-upgrade`             | unresolvable → §16.1 rule skip naming every available profile                              |
| `--max-proposals`   | cohort cap                                         | **every** selected rule, identically | over-cap → `cohort-cap-exceeded` skips, evidence-ranked cut                                |

### 5.4 Edge cases (all inherited, none re-decided)

| Case                                                     | Behaviour                                                                                                                                                                                                                                                                                                                        | Verified at                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Unrated artist** (`userRating` absent or native `0`)   | `signal-unavailable` with detail `"unrated: the artist carries no Plex rating, which is no signal rather than a low rating"`. **Never** treated as a low rating.                                                                                                                                                                 | `policy-rule-rating-upgrade.ts:152-158`                             |
| **Sparse ratings** (most artists unrated)                | Each unrated artist yields one skip row; the cohort is simply small. No inference, no imputation.                                                                                                                                                                                                                                | same                                                                |
| **Artist already on the target profile**                 | `already-converged`, detail `` `artist is already assigned quality profile "<name>"` ``. Never enters a cohort.                                                                                                                                                                                                                  | `policy-rule-rating-upgrade.ts:170-176`                             |
| **Artist already unmonitored**                           | `already-converged`, detail `"artist is already unmonitored in Lidarr"`.                                                                                                                                                                                                                                                         | `policy-rule-stale-monitoring.ts:145-152`                           |
| **`lastViewedAt` / recency**                             | **Does not exist.** Verified: no `lastViewedAt`, `lastRatedAt`, `skipCount`, `viewOffset` or item-level `addedAt` on `MediaTrack`/`MediaArtist`. `--max-plays` is an **absolute lifetime count**, never a staleness measure. §10 names this a non-goal.                                                                          | grep, and `plex/mappers.ts:143` (`playCount: track.viewCount ?? 0`) |
| **Lidarr-only artist** (no Plex counterpart)             | `stale-monitoring-cleanup` emits an explicit `no-consumption-coverage` skip for every `lidarrOnly` refused subject before the link loop. Never unmonitored on absent evidence.                                                                                                                                                   | `policy-rule-stale-monitoring.ts:110-124`                           |
| **Review-only identity match** (fuzzy / normalized name) | Structurally unreachable. `createPolicyProposal` requires the nominally branded `PolicyIdentityLink`, mintable only by `indexAuthoritativeIdentities` from `report.matchedExact` (unique one-to-one exact MBID). Review-grade subjects surface as `identity-not-authoritative` skips carrying `POLICY_NON_AUTHORITATIVE_DETAIL`. | `policy-signals.ts:89-97,177-222`; `types/lidarr-policy.ts:209`     |
| **Absent `LidarrArtist.statistics`**                     | `signal-unavailable` / `lidarr-statistics-absent`; never read as zero files.                                                                                                                                                                                                                                                     | `policy-rule-stale-monitoring.ts:216-222`                           |
| **Zero library-wide plays**                              | `stale-monitoring-cleanup` emits a rule-level `consumption-signal-empty` skip: the resolved Plex token's account may not be the listening account. Surfaces here as a `rule-not-evaluated` refusal with that detail verbatim.                                                                                                    | `policy-rule-stale-monitoring.ts:99-101`                            |

### 5.5 The four sync-ratings-specific gates

Applied per selected decision, in this order, inside `buildRatingSyncPlan`.

**G1 — `decision-disabled`.** `rawConfig.rules[ruleId].enabled === false` refuses that decision,
`remedy: "policy.rules.<id>.enabled"`.

This resolves the judges' disagreement about `forceEnable`. `getLoadedPolicyConfig()` returns the raw
validated config with **no defaults injected** (verified `loaded-config.ts:76`), so `enabled` is
genuinely tri-state:

| Config value | Meaning                             | sync-ratings behaviour                                                                                                |
| ------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `true`       | deliberately on                     | run                                                                                                                   |
| `undefined`  | never configured (the ship default) | run — **typing the command with `--decision` is the opt-in**, which is what makes the feature usable with zero config |
| `false`      | deliberately switched off           | **refuse** with `decision-disabled`                                                                                   |

`resolvePolicyConfig` collapses `undefined` and `false` to the same `false`, which is why the action
computes `forceEnable` from the raw config _before_ calling the engine and emits G1 itself. The kill
switch works; the ship default does not become a first-run cliff. The same raw read produces
`report.decisionStates`, which is what the presenter renders — never the override-contaminated
`report.evaluation.policy.rules[id].enabled` (§A.1.7).

**Force-enabling the rating rule needs a target profile.** With `forceEnable`, a run that selects
`quality-profile` while neither `--quality-profile` nor
`policy.rules.rating-quality-upgrade.targetQualityProfile` is set becomes reachable for the first
time, and it produces a **`degraded` report for a pure operator omission**: the §16.1 gate
`findUnresolvedTargetProfile` (`policy-engine.ts:486-491`) early-returns `undefined` when
`targetQualityProfile === null`, the rule dispatches, hits
`policy-rule-rating-upgrade.ts:92-98` → `{ ruleSkip: { reason: "signal-unavailable", … } }`, and
`policy-engine.ts:791` hard-codes `degraded: true` — with a detail string that never names
`--quality-profile`. The command therefore refuses that combination up front with
`MissingRequiredArgumentError`, before `loadActions()` (§A.1.6, §3.2).

**G2 — `rule-not-evaluated`.** `report.rules` is an **array**
(`types/lidarr-policy.ts:421`: `readonly rules: readonly PolicyRuleResult[]`), never a map, and its
arms carry **counts**, not decisions — per-rule decisions are recovered by filtering the flat
top-level `report.proposals` / `report.skips` on `.ruleId`. The gate is therefore:

```ts
const result = report.rules.find((r) => r.id === ruleId);
if (result === undefined) throw new SyncRatingsProjectionError(ruleId, "rule absent from report");
if (result.status === "skipped") {
  /* result.skipReason and result.detail are in scope HERE only */
}
```

`undefined` is an **invariant violation**, not a refusal: the engine maps over `POLICY_RULE_IDS`
(`policy-engine.ts:831`), so a missing arm means the engine changed underneath this module. Note also
that `PolicyRuleResult.status` is `"proposals" | "clean" | "skipped"` — a different union from the
report-level `"clean" | "proposals" | "degraded"` (`:417`).

This deliberately replaces a whole-report `status === "degraded"` gate. Verified at
`policy-engine.ts:791`: **any** evaluator `ruleSkip` sets `degraded: true`, so a report-level gate
would let one unrelated rule block a perfectly healthy cohort. Gating on each selected rule's own
`PolicyRuleResult` is strictly more precise, and it is what carries `consumption-signal-empty` and the
§16.1 available-profile list to the operator.

**G3 — `cross-decision-conflict`.** An `artistId` appearing in **both** cohorts is dropped from
**both**, with one artist-scoped refusal (`decision: null`).

Reachable in practice: with `--min-stars 4` and `protectRatingAtOrAbove: 5`, a 4-star zero-play
artist draws both a profile upgrade and an unmonitor. The engine has deterministic ordering but **no**
conflict resolution, and the two artifacts apply independently with no ordering guarantee — sealing
both is incoherent. Dropping from both is the fail-closed behaviour this codebase uses everywhere
else; the operator resolves it by widening the gap between the two thresholds.

**G4 — invariants (throw, never skip).** Applied only to proposals that survived the
`ruleId ∈ selectedRuleIds` filter, so a `discovery-seed` proposal — which deliberately omits
`subject.artistId` (`policy-rule-support.ts:199-204`; the field is optional at
`types/lidarr-policy.ts:231-238`, documented "Absent for a Plex-only seed subject") — is never
mistaken for a violation. `SyncRatingsProjectionError` when:

- a proposal carries no `subject.artistId`;
- an `artist-monitoring` proposal's `after["monitored"]` is not a boolean;
- an `artist-profile-assignment` proposal's `after["qualityProfileId"]` is not a number;
- two profile proposals in one cohort name different `after["qualityProfileId"]` values (impossible
  today — the engine resolves exactly one `resolvedProfileId` per run — therefore an invariant);
- a non-empty profile cohort's `report.policy.rules["rating-quality-upgrade"]`, narrowed on `.kind`,
  carries a `resolvedProfileId` that is not a `number` (§A.4.5 — `String(null)` would otherwise bind
  the literal `"null"`).

Bracket access is mandatory and the invariant checks **are** the narrowing site, because `before` /
`after` are `Readonly<Record<string, string | number | boolean | null>>`
(`types/lidarr-policy.ts:280-286`): with `noPropertyAccessFromIndexSignature` dot access raises
TS4111, and with `noUncheckedIndexedAccess` bracket access yields `… | undefined`. Shipped code
already pays this tax (`lidarr-policy-presenter.ts:327-328`, `policy-engine.ts:524-525`):

```ts
const next = proposal.after["monitored"];
if (typeof next !== "boolean") throw new SyncRatingsProjectionError(proposal.key, "…");
const target = proposal.after["qualityProfileId"];
if (typeof target !== "number") throw new SyncRatingsProjectionError(proposal.key, "…");
```

Each violation means the engine changed underneath this module. Silently dropping the proposal would
seal the wrong artists.

### 5.6 Tie-breaks and ordering

- **Cohort cut** — `applyCohortCap` with the shipped per-rule comparators: rating descending then
  `lidarrId` ascending for the profile rule; plays ascending then `lidarrId` ascending for the
  monitoring rule (`policy-engine.ts:164-175`). Unchanged.
- **Cohort seal order** — `POLICY_PRODUCER_IDS` declaration order:
  `artist-profile-assignment`, then `artist-monitoring`. A partial failure is therefore predictable.
- **`artistIds` within a cohort** — ascending and deduplicated (the profile producer's
  `selectLidarrArtists` sorts ascending; the monitoring producer requires uniqueness at `plan.ts:59`).
- **Refusal order** — `SYNC_RATINGS_REFUSAL_CODES` declaration order, then `artistId` ascending.

---

## 6. Safety model

### 6.1 Read-only by default, structurally

In `--mode recommend` (the default), `executeLidarrSyncRatings` returns immediately after the
evaluation. That branch is statically incapable of mutating: the module imports no `LidarrClientApi`, no
`writeLidarrPlanArtifact`, no `appendLidarrPlanHistory`, no `acquireLidarrPlanClaim` — the plan
writers are reachable only _inside_ `executeLidarrArtistProfilePlan` / `executeLidarrPlan`, which the
recommend branch never calls.

The only filesystem write on the default path is the pre-existing observational
`bridge_identity_snapshots` replace performed _inside_ `executeLidarrReconcile` — exactly what
`policy evaluate` already does.

**Nothing is ever written to Plex.** `adapter.metadata` and `updateTrackRating` are never referenced:
issue #221 reads Plex and writes Lidarr, never the reverse.

### 6.2 Four independent mutation gates

Any one of these stops a mutation:

1. **Mode.** `mode !== "apply"` ⇒ `executeLidarrApply` is never called. `--mode apply` is the only way
   to set it, and the value is validated against `SYNC_RATINGS_MODES` inside `.action()`.
2. **Interactive-approval assertion.** `assertInteractiveApplyApproval(isMachineFormat(format))`
   throws `MissingRequiredArgumentError` for any machine output or non-interactive TTY without
   `--yes` — checked in the command **before** the lazy action import, so a refused run spends no
   Plex drain.
3. **Per-artifact confirmation.** Without `--yes` on a TTY, the command's injected `confirm` runs a
   real `executeLidarrApply({ dryRun: true, approved: false })` and hands the review to
   `confirmMutationApply`; a declined prompt leaves `outcome.apply` absent. A dry run **never**
   acquires a claim and **never** writes history (verified `apply.ts:1416-1441`). The default
   dependency `confirm` returns `false`, so an embedder that forgets to inject gets zero mutations.
4. **Apply's own gate.** `executeLidarrApply` hard-throws
   `LidarrPlanValidationError("real apply requires explicit approval")` when `!dryRun && !approved`
   (verified `apply.ts:1054-1056`).

### 6.3 Identity gating is a compile-time property

Every change traces to a `PolicyProposal`, whose only constructor is `createPolicyProposal`, which
requires a `PolicyIdentityLink` — a nominally branded interface whose `declare const unique symbol`
is attached by exactly one private function, fed only `ReconciliationAuthoritativeItem` values from
`report.matchedExact`. Review-grade, fuzzy, ambiguous, conflicting and unavailable matches **cannot**
reach a cohort without a deliberate type change. sync-ratings adds zero identity code.

### 6.4 Architecture gates make a bespoke apply path uncompilable

`check:architecture` runs under **both** `pretypecheck` and `prebuild`, so a violation breaks
`npm run typecheck` **and** `npm run build`.

- `LIDARR_MUTATION_OWNERSHIP_RULES` pins `setArtistProfiles` / `updateArtistTags` to
  `plan-operation-definitions.ts` + `resilience.ts`. No new module calls them.
- `setArtistsMonitored` lives only inside the sealed lifecycle. Unchanged.
- `lidarr-editor-body-owner` flags any literal containing `artistIds` **plus** `qualityProfileId`
  outside `client.ts`. This design constructs `{ artistIds, qualityProfile: string, maxBatch }` and
  `{ artistIds, monitored, maxBatch }` — neither is in the flagged key set. `PolicySubject` keeps id
  keys **singular** (`artistId`) by contract.
- No new module names `./plex/*`, `src/types/plex`, `src/lib/lidarr/generated/**`, a `/api/v1/`
  literal, or `fetch`.
- `buildPolicyHandoff`'s ban on `apply` / `--plan-file` in a structural argv position is untouched:
  the plan step is a typed function call, not an argv execution. `handoff.argv` is never parsed —
  turning an operator-facing display string into a machine contract would make an argv formatting
  change a mutation bug.

### 6.5 Caps and footprint

- Per-rule cohort cap `--max-proposals`, which **replaces** each rule's own default (`rating` 25,
  `stale` 25, `seed` **10** — `POLICY_DEFAULTS` at `policy-engine.ts:134-144`), ceiling
  `POLICY_MAX_PROPOSALS_PER_RULE = 100`, evidence-ranked cut with a `cohort-cap-exceeded` skip per
  artist cut.
- `maxBatch = cohort.artistIds.length`, always `≤ 100 ≪ LIDARR_PLAN_MAX_BATCH = 1000`.
- `footprint.fraction` = changed artists ÷ `coverage.authoritativeLinks`, computed in `rating-sync.ts`
  (the policy report has no footprint field), **reported, never a gate**. A hard ceiling would refuse
  legitimate first runs (on a freshly reconciled library, nothing is yet on the target profile); the
  absolute cap already bounds the blast radius, and the operator sees the proportion before typing
  `--mode apply`.

### 6.6 Idempotency

Three layers, all shipped:

1. The evaluators emit `already-converged` for artists already on the target profile / already
   unmonitored, so converged artists never enter a cohort.
2. The producers re-read **fresh** live Lidarr state at seal time. A stale evaluation therefore
   degrades to a sealed no-op entry (`plan.review.changed` excludes it) rather than a wrong mutation;
   a vanished artist id fails loudly — as `LidarrPlanValidationError` on the monitoring path
   (`plan.ts:81-83`) and as a plain `Error` on the profile path (`artist-selection.ts:187`).
3. `classify()` at apply time returns `satisfied` for an already-desired entry — never dispatched,
   recorded as `satisfied` in history. `selectLidarrResumeEntries` filters those out under `--resume`.

Running `sync-ratings --mode plan` twice after a successful apply yields a report with `already-converged`
skips, zero proposals, and zero artifacts. `writeLidarrPlanArtifact` refuses to overwrite
(`LIDARR_PLAN_EXISTS`), so an artifact is never mutated in place.

### 6.7 Before/after diffs, three layers

1. `PolicyProposal.before` / `.after` — flat scalar records with `checks[].configPath`, projected
   verbatim onto `SyncRatingsChange` and rendered by `renderSyncRatings`.
2. `renderMutationPlan` — `formatPlanEntryState` before/after with `NO-OP` / `CHANGE` per entry, plus
   the per-kind summary and the cascade block.
3. `renderMutationApply` — the `Before` / `After / Observed` columns, where `Observed` comes from the
   bounded post-dispatch `reconcileLidarrApplyTarget` re-read (3 attempts, 100 ms apart).

### 6.8 Plan pinning

Every `executeLidarrApply` call pins **both** `expectedPlanId: plan.id` and
`expectedPlanChecksum: plan.payloadChecksum` from the artifact just written (fields verified at
`apply.ts:99-100`, comparison at `:1060-1074`). Free correctness: an artifact swapped, regenerated or
truncated between seal and apply becomes a loud `LidarrPlanValidationError` instead of an apply of the
wrong desired state.

### 6.9 Partial failure

**Sealing is ordered, not atomic.** If the second producer throws (an artist deleted between
evaluation and seal → `Lidarr artist IDs were not found`), the first artifact remains on disk. It is
**inert** — it has mutated nothing and is checksum-sealed — and its path was already **rendered to
the operator** by `onPlanSealed` before the next producer ran. The error propagates to
`reportLidarrFailure`, which redacts credentials and sets `process.exitCode = 1`. Recovery is
`rfmedia lidarr apply <path> --yes`.

**The profile producer can also fail on the cohort's BEFORE state.**
`plan-artist-profiles.ts:256-265` re-resolves **every** cohort artist's current `qualityProfileId`
against the live profile list via `resolveLidarrProfileReference(String(artist.qualityProfileId),
context.qualityProfiles)`. An artist whose current profile has since been deleted throws
`Unknown profile reference` (`artist-selection.ts:133`), and an artist with `qualityProfileId === 0`
throws `TypeError: profile ID must be a positive safe integer` (`:64-69`, the guard is `value > 0`) —
mid-run, after the full Plex drain and possibly after artifact #1 is already on disk. **No pre-seal
filter is added:** the action holds no live artist list, and adding one would duplicate the
producer's own read. The mitigation is documentation — a Troubleshooting row in the feature doc and
the corrected `@throws` taxonomy in §4.5 (§A.2.3).

**Apply failures do not throw.** `executeLidarrApply` returns `status: "partial" | "failed"` with a
structured `LidarrPlanApplyFailure` (`code`, `stage`, `dispatchState`, `verificationState`,
`retryable`, `safeNextAction`); the presenter renders it with the copy-pasteable
`--resume --expected-plan-id --expected-plan-checksum` recovery command, and the exit gate sets `1`.

**Cancellation.** `signal?.throwIfAborted()` before the evaluation, after it, before each producer,
and before each apply. The producers do not accept a signal (verified: `LidarrPlanActionOptions` has
no `signal` field), so the checks bracket them; each is one short local read. `executeLidarrApply`
links its own `AbortController` to the global signal and releases its exclusive claim in `finally`.

**Provenance stays out of the artifact.** `requireExactKeys` freezes the sealed v3 envelope, so a
`policy` / `ruleId` / `rationale` field is structurally impossible. All provenance — the
`flag`/`config`/`default` threshold sources, every `PolicyThresholdCheck.configPath`, the full
embedded `PolicyEvaluationReport` — lives in the sync report, capturable with `--output json`.

---

## 7. Integration points

### 7.1 `src/commands/lidarr.ts` — one import, one registration at index 8

```ts
import { createLidarrSyncRatingsCommand } from "./lidarr-sync-ratings.js";
// … after the createLidarrPolicyCommand block (currently lidarr.ts:1482-1489) …
lidarrCommand.addCommand(
  createLidarrSyncRatingsCommand({
    resolveFormat,
    reportLidarrFailure,
    renderExecutionSummary,
  }),
);
```

Three parent-private helpers, matching `LidarrReconcileCommandDeps`. (`parseIdList` is simply not
part of this leaf's surface — both shipped shapes exist, `LidarrPolicyCommandDeps` injects it and
`LidarrReconcileCommandDeps` omits it, so neither choice needs defending.) The optional
`loadActions?: () => Promise<…>` seam is declared on **both** shipped deps interfaces and is kept
here (§4.6, §A.3.7); production leaves it undefined and the leaf falls back to the lazy
`import("../actions/lidarr/index.js")`.

### 7.2 `src/actions/lidarr/index.ts` — barrel block

```ts
export { executeLidarrSyncRatings, TIER as LIDARR_SYNC_RATINGS_TIER } from "./sync-ratings.js";
export type {
  LidarrSyncRatingsActionOptions,
  LidarrSyncRatingsActionResult,
  LidarrSyncRatingsDependencies,
} from "./sync-ratings.js";
```

### 7.3 The six ordered lists (all move to index 8, between `policy` and `validate-import`)

| #   | Artifact                                            | Exact edit                                              |
| --- | --------------------------------------------------- | ------------------------------------------------------- |
| 1   | `src/commands/lidarr.ts:1451-1503`                  | the `addCommand` position above                         |
| 2   | `src/commands/lidarr.test.ts:25-41`                 | `LIDARR_COMMAND_NAMES` gains `"sync-ratings"`           |
| 3   | `src/lib/shell-completions/bash.ts:164`             | `lidarr_subcommands` string                             |
| 4   | `src/lib/shell-completions/zsh.ts:407-424`          | `lidarr_subcmds` described array                        |
| 5   | `src/lib/shell-completions/fish.ts:1535-1549`       | `__fish_rfmedia_lidarr_needs_subcommand` complete lines |
| 6   | `src/lib/shell-completions/templates.spec.ts:50-71` | `lidarrCommandTree.lidarr`                              |

Missing any one produces three simultaneous completion failures plus a hierarchy failure.

### 7.4 bash — six edits (`src/lib/shell-completions/bash.ts`)

The `case "$prev" in` block spans `bash.ts:304-498` (not `~355-396`), and bash `case` is
first-match-wins with no fallthrough, so a duplicate arm for a literal that already appears earlier is
**dead code**. That constrains three of the six edits (§A.3.2, §A.3.3).

**B1 (line 164)** — insert `sync-ratings` after `policy`:

```
local lidarr_subcommands="status list albums wanted health audit reconcile policy sync-ratings validate-import discover search lookup presets plan apply"
```

**B2 (beside line 175-178)** — new locals. The option string must stay on **one physical line**
(`extractBashCandidates` splits on a single space). There is deliberately **no**
`lidarr_sync_ratings_min_stars`: `bash.ts:343-346` is an unguarded, **earlier** arm already answering
`1 1.5 2 2.5 3 3.5 4 4.5 5` for `--min-stars` and six siblings, so a second `--min-stars)` arm is
unreachable (verified empirically with `bash --noprofile --norc`) — zsh and fish are aligned to that
shipped list instead (§A.3.2):

```
local lidarr_sync_ratings_opts="--plex-library --decision --min-stars --max-plays --quality-profile --max-proposals --mode --yes --explain -v --verbose --plex-url --plex-token --lidarr-url --lidarr-api-key"
local lidarr_sync_ratings_decisions="quality-profile monitoring"
local lidarr_sync_ratings_modes="recommend plan apply"
local lidarr_sync_ratings_max_plays="0 1 3 5 10 25"
```

**B3 (the word-scan loop, after the `policy)` arm at 236-241)** — its **OWN guarded** arm. `sync` is
already in the shared arm at line 213 for the plex family, so `sync-ratings` must not rely on it:

```bash
sync-ratings)
  # "sync-ratings" is a lidarr-only leaf; guard so other families never misroute.
  if [[ "$cmd" == "lidarr" && -z "$subcmd" ]]; then
    subcmd="${words[i]}"
  fi
  ;;
```

No `$subsubcmd` loop is needed — the leaf is flat.

**B4 (the EXISTING `--mode)` arm at 317-327)** — an edit to a reachable arm, not a new one. Insert a
guarded `elif` **before** its final `else` (which answers `$watch_modes`):

```bash
elif [[ "$cmd" == "lidarr" && "$subcmd" == "sync-ratings" ]]; then
  COMPREPLY=($(compgen -W "$lidarr_sync_ratings_modes" -- "$cur"))
```

Bash then reports `--mode` as a value option, matching zsh (`:mode:(…)`) and fish (`-r -xa "…"`), so
the cross-shell contract passes with **zero** special-casing. Do **not** add a second `--mode)` arm.

**B5 (two new arms inside `case "$prev" in`, 304-498)** — `--decision)` answering
`$lidarr_sync_ratings_decisions` and `--max-plays)` answering `$lidarr_sync_ratings_max_plays`.
Neither literal has an existing arm anywhere (verified by grep), and both are globally unique, so both
are **unguarded**, following the `--rule)` precedent at `:365-368` with its "owned exclusively by …"
comment. No edit is needed for `--min-stars` (`:343`), `--max-proposals` (`:368`, already
`1 5 10 25 50 100` unguarded), or `--quality-profile` / `--explain` / `--plex-library` / `--plex-*` /
`--lidarr-*`, which are already in the no-completion string arm at `:393`.

**B6 (the `lidarr)` dispatch, after the `policy` branch at 633-640)** — flat branch. The two inner
lines **must be indented with literal TAB characters** (shown below as `»` for one tab), matching the
neighbouring reconcile/policy branches; Prettier does not reformat template-literal interiors, so the
existing tab style must be preserved by hand:

```bash
elif [[ "$subcmd" == "sync-ratings" ]]; then
»if [[ "$cur" == -* ]]; then
»»COMPREPLY=($(compgen -W "$lidarr_sync_ratings_opts $global_opts" -- "$cur"))
»fi
```

### 7.5 zsh — two edits (`src/lib/shell-completions/zsh.ts`)

**Z1 (the `lidarr_subcmds` array, 407-424)** — insert after the `policy:` entry:

```
'sync-ratings:Turn Plex ratings and plays into Lidarr monitoring and quality changes'
```

**Z2 (a `sync-ratings)` arm in the `lidarr_args` state, after the `policy)` arm at 516-541)** — must
sit inside the region `extractZshCaseBlock` scans from the `lidarr)` marker at eight spaces of
indentation, and **must** terminate in the interpolated `${globalOpts}` or `expectZshGlobalOptions`
fails:

```
sync-ratings)
  _arguments \
    '--plex-library[Plex music library for this run]:name:' \
    '*--decision[Decision kinds to consider (repeatable, comma-separated)]:decision:(quality-profile monitoring)' \
    '--min-stars[Plex star floor from 1.0 through 5.0]:stars:(1 1.5 2 2.5 3 3.5 4 4.5 5)' \
    '--max-plays[Inclusive Plex play ceiling for unmonitoring]:count:(0 1 3 5 10 25)' \
    '--quality-profile[Target Lidarr quality profile by name or id]:profile:' \
    '--max-proposals[Per-decision proposal cap from 1 through 100]:count:(1 5 10 25 50 100)' \
    '--mode[Rung: recommend, plan, or apply]:mode:(recommend plan apply)' \
    '--yes[Approve the apply without an interactive prompt]' \
    '--explain[Print one decision full causal chain]:key:' \
    '(-v --verbose)'{-v,--verbose}'[Show every row instead of the first 20]' \
    '--plex-url[Plex server URL]:url:' \
    '--plex-token[Plex API token]:token:' \
    '--lidarr-url[Lidarr server URL]:url:' \
    '--lidarr-api-key[Lidarr API key]:key:' \
    ${globalOpts}
  ;;
```

The repeatable `--decision` carries the `*` prefix, matching `*--rule` on the policy leaf. The
`--min-stars` list is the **shipped** bash list `1 1.5 2 2.5 3 3.5 4 4.5 5`, not a bespoke one — bash
cannot be given a per-leaf list for that flag, so zsh and fish align to it (§A.3.2).

### 7.6 fish — three edits (`src/lib/shell-completions/fish.ts`)

**F1** — a predicate in the **newer global-option-tolerant `$command_path`** form (the
`__fish_rfmedia_lidarr_reconcile_active` shape at 1243-1266, pinned by `templates.spec.ts:1101-1117`),
**not** the legacy `$cmd[2]`/`$cmd[3]` positional form. It **must be defined after**
`__fish_rfmedia_lidarr_policy_evaluate_active` (the `fish.ts:1400` block), never between reconcile and
`__fish_rfmedia_lidarr_validate_import_active`: `templates.spec.ts:1103-1107` slices the script
between those two function names and asserts at `:1116` that the slice
`.not.toContain('test "$cmd[2]" = "lidarr"')`, so inserting there widens the slice and fails the spec.
Function-definition order is otherwise unconstrained (§A.3.4).

```fish
function __fish_rfmedia_lidarr_sync_ratings_active
  set -l cmd (commandline -opc)
  set -l command_path
  set -l skip_next 0
  for token in $cmd[2..-1]
    if test $skip_next -eq 1
      set skip_next 0
      continue
    end
    switch $token
      case --output --use-dotenvx --use-op
        set skip_next 1
      case '--output=*' '--use-dotenvx=*' '--use-op=*'
      case --dry-run --debug --json --help --version
      case '*'
        set -a command_path $token
    end
  end
  if test (count $command_path) -ge 2
    and test "$command_path[1]" = "lidarr"
    and test "$command_path[2]" = "sync-ratings"
    return 0
  end
  return 1
end
```

**F2 (line 1543, between the `policy` line at `:1542` and the `validate-import` line)** — only the
`needs_subcommand` **complete** lines are order-asserted:

```fish
complete -c rfmedia -n "__fish_rfmedia_lidarr_needs_subcommand" -a "sync-ratings" -d "Turn Plex ratings and plays into Lidarr monitoring and quality changes"
```

**F3** — a `# Lidarr sync-ratings options` block. **Every value-taking option carries `-r`**; boolean
flags do not; choice-valued options carry `-xa`:

```fish
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -l plex-library -d "Plex music library for this run" -r
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -l decision -d "Decision kinds to consider (repeatable, comma-separated)" -r -xa "quality-profile monitoring"
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -l min-stars -d "Plex star floor from 1.0 through 5.0" -r -xa "1 1.5 2 2.5 3 3.5 4 4.5 5"
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -l max-plays -d "Inclusive Plex play ceiling for unmonitoring" -r -xa "0 1 3 5 10 25"
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -l quality-profile -d "Target Lidarr quality profile by name or id" -r
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -l max-proposals -d "Per-decision proposal cap from 1 through 100" -r -xa "1 5 10 25 50 100"
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -l mode -d "Rung: recommend, plan, or apply" -r -xa "recommend plan apply"
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -l yes -d "Approve the apply without an interactive prompt"
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -l explain -d "Print one decision full causal chain" -r
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -s v -l verbose -d "Show every row instead of the first 20"
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -l plex-url -d "Plex server URL" -r
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -l plex-token -d "Plex API token" -r
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -l lidarr-url -d "Lidarr server URL" -r
complete -c rfmedia -n "__fish_rfmedia_lidarr_sync_ratings_active" -l lidarr-api-key -d "Lidarr API key" -r
```

### 7.7 `templates.spec.ts`

- `"sync-ratings"` into `lidarrCommandTree.lidarr` at index 8.
- A `lidarrSyncRatingsOptions` `[["--flag", takesValue], …] as const` table modelled on
  `lidarrPolicyEvaluateOptions` (178-193), including the `["-v", false], ["--verbose", false]` pair.
  Value-taking: `--plex-library`, `--decision`, `--min-stars`, `--max-plays`, `--quality-profile`,
  `--max-proposals`, `--mode`, `--explain`, `--plex-url`, `--plex-token`, `--lidarr-url`,
  `--lidarr-api-key`. Boolean: `--yes`, `-v`, `--verbose`. **No special-casing is needed** — that is
  the payoff of choosing `--mode` over a boolean `--apply` (§A.3.1).
- One cross-shell contract test cloned from the policy loop, asserting: the commands list equals
  `lidarrCommandTree.lidarr` per shell; sorted option-set and value-option-set equality across
  bash/zsh/fish; `expect(expectedOptions.filter(o => o.startsWith("--"))).toEqual([...LIDARR_SYNC_RATINGS_OPTION_LONGS])`;
  the `--decision` value lists equal `[...SYNC_RATINGS_DECISIONS]` and the `--mode` value lists equal
  `[...SYNC_RATINGS_MODES]` in all three shells; `expectZshGlobalOptions`; zero
  adapter/client/scheduler/config/fetch calls; and
  `.not.toContain("rfmedia lidarr sync-ratings")`.
- The new predicate + its value options added to the `valueOptionsByCondition` fish map.
- One live `bash --noprofile --norc` routing test: `rfmedia lidarr sync-ratings --m` must yield exactly
  `--min-stars --max-plays --max-proposals --mode` — a routing bug a string-presence check would not
  catch — plus `sync-ratings --mode ""` yielding exactly `recommend plan apply`, proving B4's guarded
  `elif` fires ahead of `watch_modes`.

### 7.8 Docs

| File                                                               | Edit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`        | **NEW**, plain `.md`, no front matter. Spine: `# Lidarr Ratings Sync` → Overview (command in backticks + the three-rung write-safety envelope in the first two paragraphs) → Use → Options → The Two Decisions → Thresholds and Their Limits (incl. the no-recency rationale, §5.4) → Safety Gates → Output Schemas → Exit Behavior → Safety and Follow-Up Boundaries → Troubleshooting (Failure \| Operator action table) → Related Documentation. Must state: `--mode` and why it is not `--plan`/`--apply`; `--max-proposals` is per-rule with defaults 25/25/**10**; `--quality-profile` resolves **numeric id first**; `--max-plays` is an absolute lifetime count, not recency; the weak normalized-name play join; the tri-state `enabled`. Troubleshooting rows: sealed-but-unapplied artifact after a mid-run producer throw; an artist whose **current** profile was deleted making the profile producer throw on the cohort's BEFORE state (§A.2.3); `plex.cache.enabled: true`; `consumption-signal-empty` |
| `packages/rfmedia-cli/README.md`                                   | New `### Lidarr Ratings Sync` H3 between the Consumption Policy block (~5264-5365) and Quality Presets (~5366): bash examples for the three rungs (all using `--mode`), the option table, the reused `policy.rules.*` config table, and `See [Lidarr Ratings Sync](docs/features/lidarr-ratings-sync.md) for …`. Amend line ~5259 ("Mutation policy remains outside #208 in #209 and #221.")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`  | Reciprocal `## Related Documentation` link; one sentence in Safety and Follow-Up Boundaries naming `sync-ratings` as the gated apply lane for the same two rules on identical decision keys, **without** weakening the "evaluation proposes, it never applies" statement about `policy evaluate` itself                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/rfmedia-cli/docs/features/plex-lidarr-reconciliation.md` | Line 217: replace "preference and rating policy remain in [#221]" with a shipped pointer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/rfmedia-cli/docs/features/shell-completion.doc.md`       | New `#### Lidarr ratings sync completion` subsection listing the subtree and the static `--decision` and `--mode` value lists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 7.9 ROADMAP — eight edits

| Line    | Edit                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8       | `**Last updated:**` → ship date                                                                                                                                                                         |
| 10      | `**Open issues:** 85 (rfapps 40 · rfmedia 45)` → `84 (rfapps 40 · rfmedia 44)`. **Verify** with `gh issue list --state open --limit 200 --json number,labels` per line 287. Preserve the middle dot `·` |
| 45      | Rewrite "Ratings-driven decisions (#221) remain dependent future work." as shipped narrative                                                                                                            |
| 67      | Sprint 1 row 2 "Why now" cell → `**Delivered** via [#NNN](https://github.com/yandy-r/rfmedia-apps/pull/NNN)`                                                                                            |
| 78-79   | Sprint 1 exit criteria — satisfied/rewritten with the sprint                                                                                                                                            |
| 191-198 | "Lidarr integration (open)" prose: append #221 to the shipped list                                                                                                                                      |
| 205     | Fenced Layer 3 line → `#207–#209, #221, #284–#285 shipped`. **Preserve the en-dashes and the double space before the parenthesis**                                                                      |
| 213     | Phase D row for #221 marked delivered                                                                                                                                                                   |

**Do NOT** touch the "Medium priority … (12)" heading at line 174 — #221 is not in that table.

### 7.10 `docs/roadmap-archive.md` — migration required

Issue #221 is the **last open Sprint 1 row**, so `ROADMAP.md:288-289` ("move narrative to
`docs/roadmap-archive.md` only when a full sprint closes") fires:

1. Bump line 7 `**Archived:**` and line 11 `## What shipped (through <date>)` — keep them in sync.
2. Add a `| Lidarr Layer 3 ratings sync | [#221](…/issues/221) | [#NNN](…/pull/NNN) |` row after line 28.
3. Amend line 117 ("Ratings-driven decisions (#221) remain open dependent work.").
4. Insert the operator-note bullet
   `- **Plex ratings sync to Lidarr decisions (#221 / #NNN):** …` immediately after line 133 and
   **before** the `### Minor docs follow-up` heading at 135, closing with
   `See [ratings sync docs](../packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md).`
   The `Operator notes:` paragraph **must** name the weak normalized-name play join and the absence of
   any recency dimension.
5. Append `12. Lidarr Layer 3 ratings sync — #221` after line 154. Preserve the curly quotes in the
   heading at 142.

### 7.11 Plan artifacts

Ship this document plus `plan.md` under
`packages/rfmedia-cli/docs/plans/issue-221-ratings-sync/` in the feature commit, following the
`issue-209-policy-engine` precedent. (This working copy lives at `docs/plans/221-sync-ratings/`.)

---

## 8. Test plan

Five surfaces. Nothing else is added: the engine, the evaluators, the signal joins, the gatherers,
plan sealing, the apply lifecycle, both presenters and the CSV projection are reused verbatim and are
already covered by `policy-engine.test.ts` (934), `policy-rules.test.ts` (1025),
`policy-signals.test.ts` (599), `lidarr-policy.test.ts` (480) and the plan/apply suites.

### 8.1 `src/lib/bridge/rating-sync.test.ts` — 7 cases (NEW, required)

Pure module; frozen-literal `PolicyEvaluationReport` fixtures; no mocks.

| Case                                                                                                                                                                                                                                        | Why it is required                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `disabledDecisions` contains a decision → that cohort `refused` with `decision-disabled` and `remedy: "policy.rules.<id>.enabled"`; the sibling cohort is unaffected                                                                        | G1. The kill switch is the whole reason `forceEnable` is safe; a regression re-enables a rule the operator deliberately switched off                                     |
| A selected decision whose `PolicyRuleResult.status === "skipped"` → `rule-not-evaluated` carrying the rule's own `skipReason` and `detail`; the sibling cohort still `sealable`                                                             | G2. Proves the gate is per-decision, not per-report, and that `consumption-signal-empty` reaches the operator verbatim instead of a mass unmonitor                       |
| One `artistId` proposed by both decisions → dropped from **both** cohorts, exactly one `cross-decision-conflict` artist refusal                                                                                                             | G3. Wholly new logic with no upstream coverage; the drop must be bilateral                                                                                               |
| Happy path → each `SyncRatingsChange` carries the proposal's `key`, `before`, `after` and `checks` by equal content; `artistIds` are ascending and deduplicated; a converged artist (present only as an `already-converged` skip) is absent | Diff fidelity + `artistIds` ordering, which the monitoring producer requires unique (`plan.ts:59`) and the profile producer sorts                                        |
| Proposals from a non-selected decision are excluded from every cohort. The fixture **must** include a `discovery-seed` proposal carrying no `subject.artistId`                                                                              | Prevents an unselected rule's proposals leaking into a sealed artifact, and proves the `ruleId ∈ selectedRuleIds` filter runs BEFORE the G4 invariants (§A.4.4)          |
| The five `SyncRatingsProjectionError` throws (absent `subject.artistId`; non-boolean `after["monitored"]`; non-numeric `after["qualityProfileId"]`; two profile proposals with different target ids; non-numeric `resolvedProfileId`)       | G4. Load-bearing: a silently dropped malformed proposal produces a silently WRONG cohort, and a cohort becomes a mutation                                                |
| `resolveSyncRatingsThresholds` reports `"flag"` / `"config"` / `"default"` correctly for each of the four thresholds                                                                                                                        | Provenance is the audit trail that tells a reviewer whether a sealed plan came from persistent policy or a one-off experiment; `checks[].configPath` alone would mislead |

### 8.2 `src/actions/lidarr/sync-ratings.test.ts` — 7 cases (NEW, required)

`const deps = { … } satisfies LidarrSyncRatingsDependencies` harness of `vi.fn()`s;
`clearMocksPreservingImplementations()` in `beforeEach`; no `vi.mock` of the client or adapter.
**Do NOT assert `LidarrPlanValidationError` for profile-cohort failures** — on that path the producer
throws a plain `Error`/`TypeError` (§4.5, §A.2.2).

| Case                                                                                                                                                                                                                                                                                        | Why it is required                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode: "recommend"` → `executeArtistProfilePlan`, `executeMonitoringPlan` and `executeApply` all `not.toHaveBeenCalled()`, `outcomes` empty                                                                                                                                                 | **The single most important assertion in the feature**: the read-only default                                                                                        |
| `mode: "plan"` with one proposal per decision → each producer called exactly once with the exact `artistIds`, `qualityProfile: String(resolvedProfileId)`, `monitored: false`, and **`maxBatch === artistIds.length`**; `executeApply` not called; outcomes ordered profile-then-monitoring | Routing + the verified `maxBatch` trap (§3.4) + the id-not-name profile binding (§3.5). A producer swap, a lost id, or a defaulted `maxBatch` is invisible otherwise |
| Config `enabled: false` for one decision, `undefined` for the other → `executeEvaluate` receives `forceEnableRules` containing only the `undefined` rule, and the disabled decision seals nothing                                                                                           | The tri-state resolution (§5.5 G1) must actually be wired to the engine override, not just computed                                                                  |
| A cohort whose rule reported `skipped` + `mode: "plan"` → that producer uncalled, the sibling producer called                                                                                                                                                                               | Proves the pure gate is wired to the seal step, not computed and ignored                                                                                             |
| `mode: "apply"` with `confirm: async () => true` → `executeApply` called once per artifact with `{ dryRun: false, approved: true, planPath, expectedPlanId, expectedPlanChecksum }`; with `confirm: async () => false` → uncalled and `outcome.apply` undefined                             | The confirmation gate and the plan pinning (§6.8)                                                                                                                    |
| `onPlanSealed` fires for artifact #1 **before** `executeApply` is invoked for it                                                                                                                                                                                                            | The partial-failure recovery guarantee (§6.9): a path the operator never saw is a lost artifact                                                                      |
| Pre-aborted `signal` → rejects; `executeEvaluate` and both producers uncalled                                                                                                                                                                                                               | Cancellation contract, matching `reconcile.test.ts`'s abort assertions                                                                                               |

### 8.3 `src/commands/lidarr-sync-ratings.test.ts` — 4 cases (NEW, required)

| Case                                                                                                                                                                                                                           | Why it is required                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command.options.map(o => o.long).filter(Boolean)` equals `[...LIDARR_SYNC_RATINGS_OPTION_LONGS]` in order, and the help contains neither `--output` nor `--json`                                                              | The **only** artifact reconciling Commander with the three hand-written completion templates; redeclaring root flags would shadow them and break machine/human parity                                                                                                                                                                                                                    |
| `--decision zzz`, `--min-stars 9`, `--max-plays -1` and `--mode zzz` each → `deps.reportLidarrFailure` called with the typed error, `process.exitCode === 1`, `deps.loadActions` **never called**, `process.exit` never called | The recorded `argParser` regression: a throwing parser routes through `Command.error()` → `process.exit(1)` before `.action()`, bypassing the failure envelope and credential redaction. `--mode zzz` additionally pins that the mode is validated in `.action()` and **not** with `.choices()`. Also proves validation precedes the lazy import, so no adapter/client/DB is constructed |
| `--mode apply` with `resolveFormat: () => "json"` and no `--yes` → routed through `reportLidarrFailure` with `MissingRequiredArgumentError`; the action is never invoked                                                       | Gate 2 (§6.2). A machine-format apply must never be silently confirmable in CI                                                                                                                                                                                                                                                                                                           |
| `--explain <unknown-key>` under `--output json` → `LookupNotFoundError` rather than a silently full envelope                                                                                                                   | `--explain` must fail loudly in every format, not only in human mode                                                                                                                                                                                                                                                                                                                     |

### 8.4 `src/lib/bridge/policy-engine.test.ts` — extend (~45 lines, five assertions, required)

`resolvePolicyConfig` is the single defaults site and `policy evaluate` also calls it; a dropped
override is the shipped `pageSize` / `syncRatingsOnCopy` silent-drop bug class.

- Each of `ratingMinRating` / `ratingTargetQualityProfile` / `staleMaxPlays` wins over both config and
  `POLICY_DEFAULTS`; `ratingTargetQualityProfile` resolves against the live profile slot into
  `resolvedProfileId`; `discovery-seed.minRating` is unaffected by `ratingMinRating`.
- `forceEnable: new Set(["rating-quality-upgrade"])` enables only that rule, **and** the echoed
  `policy.rules["rating-quality-upgrade"].enabled === true` even though config never set it — this
  pins the contamination documented in §4.3 / §A.1.7 as a deliberate property.
- `resolvePolicyConfig(config, { ratingTargetQualityProfile: "Lossless" },
notRequestedSlot("lidarrQualityProfiles"))` returns `resolvedProfileId === null` and does **not**
  throw — pins the second, pre-gather call site (§A.1.2).
- One `runLidarrPolicyEvaluation` case with `forceEnable` covering all three rules but `selected`
  covering two proves `discovery-seed` still reports `not-selected` (the `runRule` gate ordering at
  `policy-engine.ts:765-766` before `:770-771`).
- An `overrides` object carrying none of the four new fields produces a resolved policy deep-equal to
  today's — the `policy evaluate` no-regression pin.

### 8.5 Mechanically required list edits

- `src/lib/shell-completions/templates.spec.ts` — §7.7 (three existing tests fail without the tree
  edit).
- `src/commands/lidarr.test.ts` — `LIDARR_COMMAND_NAMES` at index 8.

### 8.6 Deliberately NOT written

No presenter snapshot or golden-output test (the three renderers are reused verbatim and already
covered; the CSV contract is asserted through the option-surface test). No plan-engine or apply-lane
test (unchanged; `apply.test.ts` is already 122 KB). No `config.test.ts` case (**no new config keys**).
No gatherer or evaluator test (unchanged). No re-test of the identity brand (a violating test would
not compile). No end-to-end test through a fake Plex + fake Lidarr (the DI harness proves the same
wiring at a fraction of the cost). **No test asserting the embedded evaluation is byte-identical to a
`policy evaluate` run** — it is not (§A.4.8), and such a test would be flaky.

### 8.7 Verification gate

```bash
cd packages/rfmedia-cli
npm run test:codegen:lidarr
npm run codegen:lidarr:check
npm run build -w ../rf-common          # from repo root: npm run build -w packages/rf-common
env -u FORCE_COLOR npm run typecheck   # fires check:architecture + test:architecture + tsc(src, benchmarks)
env -u FORCE_COLOR npm run test:coverage
RFMEDIA_BENCH_SCALES=10,100 npm run bench
npm run format && npm run lint:md      # from repo root
```

`FORCE_COLOR` must be unset locally or two rf-common logger tests fail and the pre-push hook blocks.
The completion specs spawn a real `bash`, so `bash` must be on `PATH`.

---

## 9. Risks and mitigations

| #   | Risk                                                                                                                                                                                                                                   | Mitigation                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Sealing is ordered, not atomic.** A producer throwing after artifact #1 is written leaves an unapplied artifact on disk                                                                                                              | Deterministic `POLICY_PRODUCER_IDS` seal order; `onPlanSealed` **renders** the path before the next producer runs; the artifact is inert and independently applicable; documented in the feature doc's Troubleshooting table. True atomicity would require splitting build from write inside the shipped producers — out of scope                                                       |
| 2   | **`--max-proposals` is per-rule, not a total**, and it replaces per-rule defaults that are **not** all 25. `--max-proposals 10` yields up to 10 profile **and** 10 monitoring changes                                                  | Verified `policy-engine.ts:341` (rating `maxProposals`), `:353` (stale `maxProposals`), `:361` (seed **`maxSeeds`**); the displaced `POLICY_DEFAULTS` are `25 / 25 / **10**` (`:134-144`). Stated explicitly in the option table (§2.3), the README table, and the feature doc's Options section                                                                                        |
| 3   | **`forceEnable` makes `sync-ratings` act on rules `policy evaluate` reports as `disabled`** for the `undefined` (never-configured) case                                                                                                | Resolved by the tri-state gate (§5.5 G1): an explicit `false` is honoured as a refusal. The rendered Thresholds/Decisions block shows each decision's state and source. Pinned by an engine test and an action test                                                                                                                                                                     |
| 4   | **Widening `PolicyEvaluationOverrides` touches a shipped pure function** two leaves now call — and `resolvePolicyConfig` runs **twice** per evaluation, once before any gather with a `not-requested` profile slot                     | Purely additive optional fields with `??` slots ahead of the existing lookups; `policy evaluate` sets none, so its resolved policy is unchanged. Pinned by the new `policy-engine.test.ts` block, which asserts both the no-regression case and the pre-gather `not-requested` case (§8.4). A JSDoc note on `LidarrPolicyEvaluateActionOptions` names sync-ratings as the sole consumer |
| 5   | **`checks[].configPath` cites a `.rfmedia.yaml` key even when the bound came from a flag**                                                                                                                                             | Pre-existing wart (same as `--max-proposals` on `policy evaluate`). Mitigated by `result.thresholds`, which carries honest `flag`/`config`/`default` provenance per field, rendered beside every value. Documented in Output Schemas                                                                                                                                                    |
| 6   | **Every run costs a full-library Plex track drain** — every registered rule requires or enriches on `plexTrackPlays`, and `plex.cache.enabled` defaults to `false`                                                                     | Inherited from #209, not introduced here, but `sync-ratings` invites more frequent invocation. `plex.cache.enabled: true` documented in the Troubleshooting table                                                                                                                                                                                                                       |
| 7   | **The monitoring half rests on a weak `normalized-name` join** that credits compilation tracks to the album artist, with no recency dimension                                                                                          | Blast radius bounded by: the branded identity gate, the three fail-closed poisonings, the never-zero observation contract, the rating veto, `--max-proposals`, and the `--mode apply` + confirmation ladder. Called out as loudly in the feature doc as `lidarr-consumption-policy.md` does, and in the archive `Operator notes:` bullet                                                |
| 8   | **Six ordered lists must move in lockstep at index 8**, the bash entry needs its **own** guarded scan arm (the shared arm already carries `sync` for plex), and bash needs **six** edit sites where a duplicate arm would be dead code | §7.3-7.7 name every site, including the guarded `elif` inside the existing `--mode)` arm and the deliberate absence of a `--min-stars` edit. One miss produces three completion failures plus a hierarchy failure — noisy but caught locally by `test:run`                                                                                                                              |
| 9   | **Shipping #221 empties Sprint 1**, triggering the archive migration with exacting typography                                                                                                                                          | §7.9-7.10 enumerate all thirteen edits. Preserve the en-dashes in `#207–#209` / `Plex–Lidarr`, the `·` middle dot, the curly quotes at archive line 142, and the double space inside the fenced Layer-3 block. Prettier reflows markdown tables but not prose, so verify the counter and dates by eye after `npm run format`                                                            |
| 10  | **A first run on a fresh library can touch a large fraction of matched artists** (nothing is yet on the target profile)                                                                                                                | Deliberately **not** gated by a fraction ceiling — that would refuse legitimate first runs. `footprint.fraction` is rendered in the Coverage block so the proportion is visible before `--mode apply`, and `--max-proposals` bounds it absolutely                                                                                                                                       |
| 11  | **`src/commands/lidarr-sync-ratings.ts` carries the interactive-approval choreography**                                                                                                                                                | Rendering is split into `lidarr-sync-ratings-presenter.ts` from the start (the `lidarr-policy.ts` 388 + presenter 1139 precedent), keeping the command near ~330 lines                                                                                                                                                                                                                  |

---

## 10. Explicit non-goals

Each is a deliberate refusal, not an oversight.

1. **No fourth policy rule.** Both decisions #221 names already ship. Adding a `PolicyRuleId` would
   change `report.rules` for every existing `policy evaluate --json` consumer and force coordinated
   edits to `policy-engine.test.ts`, `policy-rules.test.ts`, `lidarr-policy.test.ts` and the bash
   `lidarr_policy_rules` literal — for zero new capability.
2. **No rating-driven monitoring-ON rule.** Monitoring-ON causes Lidarr to begin acquisition — a
   strictly larger blast radius than either shipped decision — and the issue does not ask for it. It
   is a clean 5-point mechanical follow-up if wanted.
3. **No rating-driven UNMONITOR.** There is **no recency signal anywhere** in the domain: no
   `lastViewedAt`, `lastRatedAt`, `skipCount`, `viewOffset` or item-level `addedAt`. Without recency,
   a one-star rating left years ago would silently unmonitor today. `stale-monitoring-cleanup` owns
   unmonitoring on the honest evidence (absolute play counts) with its coverage and
   `statistics.trackFileCount` gates.
4. **No new plan `operation.kind`.** `requireOperationV2` is a closed switch with a throwing
   `default`; a ninth kind would touch that validator, `canonicalizeOperationV2`/`EntryV2`/`Summary`,
   `getLidarrMutationOperationDefinition`, the cascade analyzer and every presenter — and would
   forfeit `deferability: "deferable"`, deferred-intent replay, `--resume`,
   `classify()`/`classifyLive()`/`verify()` and post-dispatch reconciliation, all of which the two
   shipped kinds already have.
5. **No bespoke apply path.** It literally cannot compile (§6.4) and would fork ~5k LOC of claims,
   history, resume, drift classification and verification.
6. **No new `.rfmedia.yaml` keys.** Every threshold #221 names already exists under `policy.rules.*`
   with validators, ceilings and docs. A parallel block would create two sources of truth for one
   number and re-enter the silently-dropped-key bug class.
7. **No parallel refusal/change/status vocabulary.** `PolicySkip`, `PolicyProposal` and
   `report.status` are the shipped vocabularies. The three sync-ratings refusal codes exist only for
   gates the engine genuinely does not have.
8. **No new CSV schema.** `--output csv` reuses `projectPolicyEvaluationCsv(result.evaluation)` with
   `LIDARR_POLICY_EVALUATE_CSV_COLUMNS` verbatim, carrying recommendation rows only; plan/apply detail
   is JSON/YAML/human. Documented, and no new machine/human parity test is needed.
9. **No blast-radius fraction ceiling.** Reported, never enforced (§6.5, risk 10).
10. **No `--offline`.** `bridge_identity_snapshots` (snapshot-v2) carries identity only — zero
    ratings, zero plays. An offline run could emit nothing but refusals. This also keeps
    `sync-ratings` off `cli.ts`'s `isCredentialFreeOfflineReconcile` classifier.
11. **No Plex writes.** `MediaServerMetadataCapability.updateTrackRating` exists but is never
    referenced. #221 reads Plex and writes Lidarr.
12. **No `--force` for any refusal.** The gates exist precisely for the cases where an escape hatch
    must not.
13. **No album- or track-level rating rollup.** No `plexAlbumRatings` signal is added. Artist ratings
    are the artist's own `userRating`, joined by exact Plex id.
14. **No nested scheduler slot.** Documented deadlock (§3.3).
15. **The pure module is named `rating-sync.ts`, not `policy-plan-intents.ts`.** The issue names
    `src/lib/bridge/rating-sync.ts`; both decisions it projects are rating-informed
    (`stale-monitoring-cleanup` carries a rating veto), so the name is accurate and the issue's hint
    is honoured.
