# Lidarr Consumption Policy

## Overview

`rfmedia lidarr policy` joins Plex consumption signals onto the shipped Plex-Lidarr identity bridge
and reports **explainable proposed Lidarr actions**. The `evaluate` leaf stops at the report. The
`plan` leaf runs that same evaluation once, accounts for every proposal, and can hand supported
proposals to the existing Lidarr plan producers through typed cohorts. Every proposal carries the
exact threshold arithmetic that produced it, the dotted `.rfmedia.yaml` key behind each threshold,
and an inert argument vector naming an already-shipped plan producer.

`rfmedia lidarr policy evaluate` is strictly read-only. It writes nothing to Plex, nothing to
Lidarr, and **no plan artifact**. It never calls a mutation method, never touches `adapter.metadata`,
and never imports a plan writer. The only write anywhere in the flow is the observational
`bridge_identity_snapshots`
replacement performed inside the reused `rfmedia lidarr reconcile` read path, which is pre-existing
behavior and is not a provider mutation.

Three rules ship, all disabled by default:

| Rule id                    | Intent                                                     | Proposed action                        |
| -------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| `rating-quality-upgrade`   | Highly rated artists deserve a better quality profile      | `artist-profile-assignment`            |
| `stale-monitoring-cleanup` | Monitored artists with no demonstrated Plex consumption    | `artist-monitoring` (unmonitor)        |
| `discovery-seed`           | High-signal artists absent from Lidarr become search seeds | none — an inert `lidarr discover` hint |

### Read this before you enable `stale-monitoring-cleanup`

Three behaviors and limits must be understood, because each can make a **wrong result look exactly
like a correct one**. Recency is configurable; account scope and album-artist attribution are
structural.

1. **Play counts belong to one Plex account — the account behind the resolved token.** If you run
   under an admin or service token while listening actually happens under a managed user, every
   artist in the library reports `playCount: 0`, and a "no demonstrated consumption" verdict is
   simply wrong. The engine refuses the whole rule when the library-wide total is exactly zero, but
   a _partially_ wrong account (a second listener, a shared server) produces an implausibly low
   total instead of a zero, and nothing can detect that automatically. Read
   [Which Plex account do the consumption signals come from?](#which-plex-account-do-the-consumption-signals-come-from)
   and check `totalPlaysObserved` on every run before you act on a proposal.
2. **Recency is opt-in and remains conjunctive with lifetime plays.** With
   `minDaysSinceLastViewed` unset, the legacy rule uses only the absolute `maxPlays` ceiling. When
   the day threshold is set, the latest trustworthy Plex view must also be old enough; a viewed old
   artist still cannot qualify unless `maxPlays` is raised above `0`. A never-viewed artist has no
   recency timestamp and is refused rather than treated as ancient. See
   [Legacy absolute plays versus opt-in recency](#legacy-absolute-plays-versus-opt-in-recency).
3. **Plays are credited to the ALBUM artist.** Every track on a compilation credits its plays to the
   compilation's album artist, so a performer you only listen to on compilations reads as zero plays
   under their own name — and `requireTrackCoverage` does not catch it, because the tracks did join.
   See [Compilation plays roll up to the ALBUM artist](#compilation-plays-roll-up-to-the-album-artist).

Everything the engine proposes is reversible and human-gated. The default planning rung is also
write-free; sealing requires an explicit mode, and mutation remains a
[separate checksum-pinned apply](#review-seal-and-apply-remain-separate).

## Use

A minimal run needs no flags. With no `policy:` block in `.rfmedia.yaml` it prints every registered
rule, its title, its description, and the exact key that would enable it:

```bash
rfmedia lidarr policy evaluate
```

Narrow the evaluation to one rule. This changes which rules are **evaluated**; it does not make the
run cheaper (see [A full evaluation is expensive](#a-full-evaluation-is-expensive)):

```bash
rfmedia lidarr policy evaluate --rule rating-quality-upgrade
```

Override the Plex library and the connection settings for one invocation:

```bash
rfmedia lidarr policy evaluate \
  --plex-library Music \
  --plex-url http://plex.example:32400 \
  --plex-token "$PLEX_TOKEN" \
  --lidarr-url http://lidarr.example:8686 \
  --lidarr-api-key "$LIDARR_API_KEY"
```

Inspect the full causal chain behind one decision. The key is printed on every proposal row, and on
every skip row under `--verbose` (the default skip section is a `Code` / `Count` / `Detail` rollup
that carries no keys):

```bash
# A proposal key — three segments
rfmedia lidarr policy evaluate --explain stale-monitoring-cleanup:artist:233

# A refusal key — four segments; the trailing segment is the skip code
rfmedia lidarr policy evaluate --verbose
rfmedia lidarr policy evaluate --explain stale-monitoring-cleanup:artist:233:rating-protected
```

Machine output, and the optional CI gate:

```bash
rfmedia --output json lidarr policy evaluate
rfmedia --output json lidarr policy evaluate --fail-on proposals
```

### Review and seal policy proposals

`policy plan` is the typed handoff from evaluation to the existing plan producers. Its default
`recommend` mode evaluates and projects the complete selected scope, but calls no producer and
writes no artifact:

```bash
# REVIEW ONLY: evaluate and show every projectable cohort or refusal
rfmedia lidarr policy plan

# Narrow both evaluation and projection to one rule
rfmedia lidarr policy plan --rule rating-quality-upgrade
```

Only an explicit `--mode plan` may seal artifacts. Before the first producer runs, the command
validates every selected rule outcome and accounts for every selected proposal. A selected rule
skipped as `signal-unavailable`, `consumption-signal-empty`, or `rule-error` fails closed through the
redacted projection-failure envelope; only `not-selected` and intentionally `disabled` outcomes are
safe to ignore for sealing. A discovery proposal, a conflicting same-artist intent, or any other
refusal likewise blocks **all** artifact writes for that invocation; nothing is silently dropped to
create a smaller plan. Recommend mode still returns the complete review, including rule-level skips
and degraded evaluation status, without calling a producer.

```bash
# Seal supported cohorts only when the complete selected scope is projectable
rfmedia lidarr policy plan --rule rating-quality-upgrade --mode plan
```

The current mappings are closed and typed:

| Policy handoff              | Existing sealed plan operation       |
| --------------------------- | ------------------------------------ |
| `artist-profile-assignment` | `artist-profile-assignment` v3 plan  |
| `artist-monitoring`         | `artist-monitoring` v3 plan          |
| `discovery`                 | Unsupported refusal; no plan is made |

Each producer re-reads fresh Lidarr state and writes its own strict
`rfmedia.lidarr-plan.v3` artifact under the private plan directory. A run may therefore seal zero,
one, or two independent artifacts. The command never combines them into an aggregate artifact and
never applies them.

Apply each artifact separately, pinning the identity and checksum printed by the plan result:

```bash
rfmedia lidarr apply ~/.config/rfmedia/plans/lidarr-<stamp>-<id8>.json \
  --expected-plan-id <plan-id> \
  --expected-plan-checksum <sha256-checksum>
```

The suggested command deliberately omits `--yes`: sealing reviewed intent is not apply consent.
Interactive apply remains default-no; add `--yes` yourself only for an intentionally
non-interactive apply.

### A full evaluation is expensive

`plex.cache.enabled` defaults to `false`, so nothing here is free. A run that needs
`plexTrackPlays` drains the **entire** Plex track catalog for the selected library, 500 items per
page, up to a hard ceiling of 200,000 tracks (and 10,000 artists). Exceeding either ceiling fails
the slot closed rather than truncating it.

**`--rule` is not a cost lever.** The gather plan is the union of `requires` and `enriches` across
the selected rules, and **every** registered rule either requires `plexTrackPlays`
(`stale-monitoring-cleanup`) or enriches with it (`rating-quality-upgrade`, `discovery-seed`). No
`--rule` selection can therefore drop the track drain: `--rule` narrows which rules **evaluate**,
never what is **gathered**.

The one lever that reduces the cost is `plex.cache.enabled: true` in `.rfmedia.yaml`, which is worth
setting whenever you intend to run repeatedly.

Cancellation is immediate: every await is guarded, so Ctrl-C stops the drain rather than finishing
the page.

## Options

### Evaluate options

| Option                   | Group      | Description                                                                                       |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------------------- |
| `--plex-library <name>`  | Selection  | Plex music library to read consumption from; overrides `policy.plexLibrary` (default `Music`)     |
| `--rule <ids>`           | Selection  | Run only these rules. Repeatable and comma-separated. Default: every **registered** rule          |
| `--max-proposals <n>`    | Selection  | Per-rule proposal cap override, 1-100                                                             |
| `--explain <key>`        | Output     | Print one decision's full causal chain instead of the report (human output only)                  |
| `--fail-on <level>`      | Output     | `none` (default) or `proposals`                                                                   |
| `-v, --verbose`          | Output     | Show every row instead of the first 20, and every refusal individually instead of the code rollup |
| `--plex-url <url>`       | Connection | Override the canonical Plex origin                                                                |
| `--plex-token <token>`   | Connection | Override the Plex token                                                                           |
| `--lidarr-url <url>`     | Connection | Override the canonical Lidarr origin                                                              |
| `--lidarr-api-key <key>` | Connection | Override the Lidarr API key                                                                       |

Global `--json` and `--output <json|yaml|csv|table|text>` retain their normal behavior. There is
deliberately **no** `--apply`, `--yes`, `--dry-run`, `--offline`, or `--plex-library-id`:

- No `--dry-run`, because offering one would imply a non-dry mode exists. Evaluation is always dry.
- No `--offline`. The bridge snapshot stores identity evidence only — `plexId`, `title`, `state`,
  `reason`, `method`, `candidates`, and the Lidarr counterpart — and carries **zero** consumption
  evidence, so an offline run could emit nothing but skips. Consumption requires a live Plex read.

`--rule` and `--fail-on` are validated **inside** the action handler, before any adapter, Lidarr
client, or tracking database is constructed. An unknown value produces the standard redacted failure
envelope listing the accepted values, not a bare `process.exit(1)`.

### Plan options

| Option                   | Group      | Description                                                                              |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------------- |
| `--plex-library <name>`  | Selection  | Plex music library to read; overrides `policy.plexLibrary`                               |
| `--rule <ids>`           | Selection  | Run only these rules; repeatable and comma-separated. Default: every registered rule     |
| `--max-proposals <n>`    | Selection  | Per-rule proposal cap override, 1-100                                                    |
| `--mode <mode>`          | Safety     | `recommend` (default, no artifacts) or `plan` (seal only after a clean global preflight) |
| `--explain <key>`        | Output     | Render the full human policy-plan report, then append one decision's causal chain        |
| `-v, --verbose`          | Output     | Show every cohort and refusal row instead of the first 20                                |
| `--plex-url <url>`       | Connection | Override the canonical Plex origin                                                       |
| `--plex-token <token>`   | Connection | Override the Plex token                                                                  |
| `--lidarr-url <url>`     | Connection | Override the canonical Lidarr origin                                                     |
| `--lidarr-api-key <key>` | Connection | Override the Lidarr API key                                                              |

The plan leaf inherits global `--json` and `--output <json|yaml|csv|table|text>`. It deliberately
has no `--apply`, `--yes`, `--dry-run`, `--fail-on`, `--plan-file`, output-path option, threshold
override, or offline mode. Recommend mode is already the dry rung; apply is a different command;
one invocation may produce two artifacts, so a single output path is ambiguous. Policy thresholds
remain owned by `.rfmedia.yaml`; this general handoff does not duplicate the specialized
`sync-ratings` threshold surface.

Plan options use the same in-handler validation and redacted failure envelope as evaluate. An empty
or unknown rule, an invalid cap, or a mode outside `recommend|plan` fails before the lazy action
module is loaded. `--explain` changes presentation only: the default mode remains write-free, while
an explicit `--mode plan --explain <key>` may still seal after a successful global preflight.

### The default `--rule` selection is every registered rule

Omitting `--rule` selects **all three** registered rules, not just the ones enabled in config. A rule
that is disabled is then skipped individually, with the rule-level reason `disabled` and the exact
dotted key that would enable it. That is why a disabled rule still appears as a row in the `Rules`
section and in the machine envelope's `rules` array: selection and enablement are separate stages,
and a refusal is data.

### `--explain` is a human-output feature

`--explain <key>` is validated on every run — an unknown key fails with a lookup error listing the
keys the report actually carries — but it only changes what is **rendered** under the default human
output. Under `--output json`, `--output yaml`, or `--output csv` the machine envelope is emitted in
full and the `--explain` selection is discarded, because a machine consumer already has every
decision's evidence in the document.

### `--max-proposals` is one global override

`--max-proposals` sets the same per-rule cap for every selected rule. There is no
`--max-proposals rule=N` syntax; per-rule tuning belongs in `policy.rules.<id>.maxProposals` (or
`maxSeeds` for `discovery-seed`), where it persists. The flag exists for a one-off narrowing, not as
a second configuration surface.

### The cap ranking is not the display order

When a rule's cohort exceeds its cap, proposals are ranked **by evidence strength** before the cut,
so the cap discards the weakest evidence rather than an arbitrary id range:

| Rule                       | Cap ranking                                      |
| -------------------------- | ------------------------------------------------ |
| `rating-quality-upgrade`   | `rating desc, lidarrId asc`                      |
| `stale-monitoring-cleanup` | `plays asc, lidarrId asc` (least-consumed first) |
| `discovery-seed`           | `rating desc, plays desc, plexId asc`            |

**This ranking deliberately differs from the order the report displays.** The report always renders
in one deterministic total order — rule declaration order, then `lidarrId` ascending, then `plexId`
ascending — regardless of how a cohort was cut. When a cut actually happens, the trimmed subjects
appear as `cohort-cap-exceeded` skips and the human render prints a `Cohort cap` block restating
both the ranking and the fact that it is not the display order.

Overrides are classified only **after** this ranking and cut. An active or stale override withholds
the proposal that already won a capped position; the engine never refills that position from a
`cohort-cap-exceeded` skip. Consequently, `summary.proposed`, each ran rule's `proposedCount`, and
`report.proposals` count only proposals that remain actionable after override classification.

## Signals and Their Limits

Five signals exist. Each rule declares which it `requires` (a hard gate — the rule skips when the
slot is unavailable) and which it `enriches` (gathered when possible, adds depth, never gates).

| Signal                  | Source                                 | Join                                    |
| ----------------------- | -------------------------------------- | --------------------------------------- |
| `bridgeIdentity`        | `rfmedia lidarr reconcile`             | —                                       |
| `lidarrArtists`         | Lidarr `listArtists`                   | `exact-artist-mbid` via the bridge link |
| `lidarrQualityProfiles` | Lidarr `listQualityProfiles`           | by profile name or numeric id           |
| `plexArtistRatings`     | Plex artist query for the library      | `exact-plex-id`                         |
| `plexTrackPlays`        | Plex track drain for the whole library | `normalized-name` — the weak seam       |

A slot that is absent reports **why**, and the reason decides whether the report degrades:

| Reason                | Meaning                                             | Degrades the report |
| --------------------- | --------------------------------------------------- | ------------------- |
| `not-requested`       | No selected rule declared this signal               | No                  |
| `plex-not-configured` | No Plex URL, or no token and no enrolled credential | No                  |
| `data-unavailable`    | The read failed, stalled, or exceeded a bound       | Yes                 |

A **Lidarr outage reports `data-unavailable`, not `lidarr-unreachable`.** The reason type declares a
`lidarr-unreachable` member, but the gatherers deliberately never mint it: `data-unavailable` is the
reason that marks a report `degraded`, and a Lidarr failure must degrade rather than read as an
expected absence. Treat `lidarr-unreachable` as reserved and unused by this command.

### Which Plex account do the consumption signals come from?

**From exactly one account: the account behind the resolved Plex token or enrolled credential.**
Both `MediaTrack.playCount` and `MediaTrack.lastViewedAt` reflect only the history visible to that
account. A run under an admin or service credential while listening happens under a managed user can
therefore see zero plays, missing timestamps, or stale timestamps — the exact shape of a correct,
dangerous-looking result.

Five layered mitigations, in the order they act:

1. **Structural refusal.** When `coverage.totalPlaysObserved === 0`, `stale-monitoring-cleanup`
   refuses to run at all with the rule-level skip reason `consumption-signal-empty` and a detail
   naming the token-account hypothesis. This catches the pure case, where the token's account has
   never played anything.
2. **The `totalPlaysObserved` tell.** The library-wide play total is printed in the human
   `Coverage` footer and carried in `coverage.totalPlaysObserved` in the machine envelope on
   **every** run. A partially wrong account — a second listener, or a token that only sees part of
   the history — shows up as an implausibly low total rather than a zero, and only you can judge
   that. Compare it against what you know your library's listening history to be before you accept
   a proposal.
3. **Recency coverage refuses when enabled.** A missing latest view or an incomplete timestamp set
   on played rows cannot become an unmonitor proposal, although a wrong account can still expose a
   plausible but stale timestamp.
4. `stale-monitoring-cleanup` is disabled by default, and its cap defaults to 25 proposals.
5. The proposed action is `artist-monitoring`, which the plan-operation registry classifies as
   `level: low`, `destructive: false` — existing files remain unchanged, so the action is fully
   reversible by re-monitoring.

If you run this rule in an automated context, use the token or enrolled credential of the account
that actually listens. There is no way for the engine to verify that for you.

### Legacy absolute plays versus opt-in recency

`maxPlays` is always an **absolute lifetime play ceiling**. With
`minDaysSinceLastViewed` omitted, the resolved value is `null` and the shipped legacy behavior is
unchanged: only the lifetime ceiling expresses consumption age. Set
`policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed` to a whole number from **1 through
36,500** to require the newest trustworthy `lastViewedAt` to be at least that many 86,400-second
days old at the run's captured evaluation instant.

The two thresholds are conjunctive. For example, `maxPlays: 5` with
`minDaysSinceLastViewed: 90` means "at most five lifetime plays **and** no view in the last 90
days." The `maxPlays: 0` default cannot admit an artist with a recorded view, however old it is, so
raise the ceiling above zero deliberately when that is the intended cohort.

Recency does not invent age for missing evidence. An artist whose joined tracks never expose a
timestamp is refused with `signal-unavailable` and `no-recency-coverage`. If any **played** joined
track omits its timestamp, the artist is refused with `partial-recency-coverage` even when another
track has a timestamp. Zero-play rows may omit the field without poisoning otherwise complete
evidence. `skipCount`, per-item acquisition age, and longitudinal history remain out of scope.

### Play and recency signals are a normalized-name rollup, not an id join

`MediaTrack` carries `artist: string` and no artist id, and `playCount` exists only on
`MediaTrack` — so **no id path to plays or recency exists at all**. Tracks are bucketed under
`normalizeBridgeArtistName(track.artist)`, reusing the same versioned normalizer the identity bridge
uses, so the join inherits `BRIDGE_ARTIST_NORMALIZATION_VERSION` rather than inventing a second
normalization policy. Its join grade is reported honestly as `normalized-name` on every play or
`lastViewedAt` observation it produces.

These join and recency conditions **fail closed** — they suppress a decision rather than producing
a wrong one:

| Condition                                                              | Result                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| One normalized key claimed by **two or more distinct Plex artist ids** | Play and recency observations become `ambiguous-name-join`; counted in `coverage.ambiguousNameArtists` |
| A track bucketed under the `"Unknown Artist"` sentinel                 | That key is **permanently poisoned** for every artist; counted in `coverage.sentinelArtistTracks`      |
| Every joined track omits `lastViewedAt`                                | Recency becomes `no-recency-coverage`; a configured recency gate refuses the artist                    |
| A played joined track omits `lastViewedAt`                             | Recency becomes `partial-recency-coverage`, even when another joined track carries a timestamp         |
| A track whose normalized artist matches no bridge item                 | Counted in `coverage.unjoinedTracks`; never silently dropped                                           |

The sentinel poisoning is not optional. The Plex track mapper sets
`artist: track.grandparentTitle ?? "Unknown Artist"`, so every track lacking a grandparent title
collapses into one bucket. Without poisoning that bucket, plays would be inflated for any artist
whose title normalizes to that string, **and** the real artists behind those orphaned rows would
appear to have zero plays — pushing them straight toward an unmonitor proposal.

Ratings do not have this problem. `MediaArtist.id` and the bridge's `source.plexId` are both the
Plex `ratingKey`, so ratings join exactly, with grade `exact-plex-id`, and are unaffected by name
collisions.

### Compilation plays roll up to the ALBUM artist

**This one does not fail closed, and it is the sharpest edge on `stale-monitoring-cleanup`.**

`MediaTrack.artist` is Plex's `grandparentTitle` — the **album** artist, not the performing artist.
Every track on a compilation ("Various Artists", a soundtrack, a DJ mix) therefore credits its plays
to the compilation's album artist. Only the `"Unknown Artist"` sentinel bucket is poisoned; no other
rollup bucket is treated as anything but a legitimate artist.

The consequence: a performer whose consumption is compilation-only reads as **zero plays** under
their own name while still having track coverage, so `requireTrackCoverage` does **not** catch this
case, and `stale-monitoring-cleanup` can propose unmonitoring an artist you actually listen to.

This is documented rather than mitigated on purpose. Poisoning "various artists" and friends would
be a locale- and language-specific string heuristic, not a structural invariant like the sentinel
bucket (which is poisoned because the Plex track mapper _provably_ mints that exact literal as its
fallback — a closed set of one). There is no closed set of compilation album-artist names, so any
list would be a guess that silently changes real proposals.

If your library leans on compilations, keep `stale-monitoring-cleanup` in review-only use, or raise
`maxPlays` gating expectations accordingly.

### Unrated is not zero-rated

A Plex native rating of 0 means **unrated**, which is _no signal_. It is mapped to `null` and
reported as the observation gap `unrated`. An unrated artist is skipped by
`rating-quality-upgrade`, and is never treated as a low rating anywhere. Configured rating values
use the same public 1-5 star input scale as the `filters:` section, and must be **finite** — YAML
`.nan` and `.inf` are rejected at load with
`Expected number between 1.0 and 5.0 for policy.rules.<rule>.<field>, got NaN`.

### Missing Lidarr statistics are never read as zero

`LidarrArtist.statistics` is optional — Lidarr omits it for freshly added or unscanned artists. When
it is absent, the acquisition gate produces the observation gap `lidarr-statistics-absent` and the
subject is skipped with `signal-unavailable`. It is never coerced to `0`, which would make the gate
fail open on exactly the freshly added artists it exists to protect.

## Evidence Tiers

Only one identity tier can carry a proposal.

| Bridge category          | Meaning                                                  | May carry a proposal          |
| ------------------------ | -------------------------------------------------------- | ----------------------------- |
| `authoritative`          | Unique one-to-one exact artist-MBID join                 | Yes                           |
| `review-normalized-name` | Unique normalized-name evidence                          | No                            |
| `review-fuzzy-name`      | Threshold-and-margin-qualified fuzzy evidence            | No                            |
| `ambiguous`              | Multiple or insufficiently separated candidates          | No                            |
| `unmatched`              | Complete evidence produced no authoritative match        | No — but see `discovery-seed` |
| `conflict`               | Malformed, duplicate, or contradictory identity evidence | No                            |
| `unavailable`            | Required compatible evidence could not be trusted        | No                            |

This is enforced by the type system, not by review discipline. Only the reconciliation report's
`matchedExact` array mints a `PolicyIdentityLink`, that type is nominally branded and constructible
by exactly one indexer, and the sole proposal factory requires one. Review-grade name evidence
cannot reach a proposal without a deliberate type change.

Every non-authoritative subject is enumerated as an `identity-not-authoritative` skip. Refusals are
data, never omissions.

### Refusals are counted once, not once per rule

The universal `identity-not-authoritative` refusal list is computed **once** over the whole
reconciliation report and emitted **once**, attributed to the first rule in declaration order that
actually ran (or, when no rule ran at all, to the first registered rule id). It is not duplicated
across rules, so `summary.skipped` is not multiplied by the number of rules that ran, and the
attributed `ruleId` on such a skip is a bookkeeping owner rather than a claim that only that rule
refused the subject.

## The Three Rules

All three iterate the bridge's `matchedExact` array, except `discovery-seed`, which iterates a
strictly filtered slice of `plexOnly`.

### Decision codes

Stable kebab codes; a proposal always carries exactly one.

| Code                          | Rule                       | Meaning                                                    |
| ----------------------------- | -------------------------- | ---------------------------------------------------------- |
| `rating-below-target-profile` | `rating-quality-upgrade`   | Rated at or above the floor, but not on the target profile |
| `monitored-artist-unconsumed` | `stale-monitoring-cleanup` | Monitored with low plays and any configured recency met    |
| `high-signal-discovery-seed`  | `discovery-seed`           | Highly rated in Plex with no Lidarr candidate at all       |

### Skip codes and their precedence

A subject can be blocked by more than one cause. The engine always reports the **first** blocking
cause in this fixed order (`POLICY_SKIP_ORDER`), so a skip code is deterministic across runs:

| #   | Code                         | Meaning                                                                       |
| --- | ---------------------------- | ----------------------------------------------------------------------------- |
| 1   | `identity-not-authoritative` | Review-grade name evidence is never auto-consumed by a policy decision        |
| 2   | `no-consumption-coverage`    | No Plex counterpart, no joined track, or Lidarr has not acquired enough files |
| 3   | `ambiguous-name-join`        | The normalized name is claimed by two artists, or is the sentinel bucket      |
| 4   | `signal-unavailable`         | A required observation could not be made, or a threshold was not met          |
| 5   | `rating-protected`           | The rating veto fired; the artist is never unmonitored                        |
| 6   | `already-converged`          | The desired state is already the current state; nothing to propose            |
| 7   | `cohort-cap-exceeded`        | Trimmed by the per-rule cap after the evidence-strength ranking               |

A whole rule can also skip. Rule-level skip reasons are:

| Reason                     | Meaning                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `not-selected`             | `--rule` did not name this rule                                                            |
| `disabled`                 | `policy.rules.<id>.enabled` is false or unset                                              |
| `signal-unavailable`       | A `requires` signal was unavailable, or `targetQualityProfile` resolved to no live profile |
| `consumption-signal-empty` | `coverage.totalPlaysObserved === 0` — the per-account sanity gate                          |
| `rule-error`               | The evaluator threw; the message is bounded and every sibling rule still runs              |

Per-artist observation gaps, which appear inside `observations` and in `--explain`, are `unrated`,
`no-plex-artist`, `ambiguous-name-join`, `sentinel-artist-name`, `no-track-coverage`, and
`lidarr-statistics-absent`. Recency adds `no-recency-coverage` when every joined track lacks a
timestamp and `partial-recency-coverage` when a played joined row lacks one.

### `rating-quality-upgrade`

Promotes artists you demonstrably love onto a better Lidarr quality profile. It proposes an
`artist-profile-assignment` change and deletes nothing.

Requires `bridgeIdentity`, `lidarrArtists`, `lidarrQualityProfiles`, and `plexArtistRatings`;
enriches with `plexTrackPlays`, which is shown as context and never gates.

| Threshold              | Config key                                                 | Bounds             | Default                      |
| ---------------------- | ---------------------------------------------------------- | ------------------ | ---------------------------- |
| `enabled`              | `policy.rules.rating-quality-upgrade.enabled`              | boolean            | `false`                      |
| `minRating`            | `policy.rules.rating-quality-upgrade.minRating`            | 1.0-5.0 stars      | `4`                          |
| `targetQualityProfile` | `policy.rules.rating-quality-upgrade.targetQualityProfile` | profile name or id | none — required when enabled |
| `maxProposals`         | `policy.rules.rating-quality-upgrade.maxProposals`         | 1-100              | `25`                         |

Evaluation order, first blocking cause wins:

1. No `LidarrArtist` for the linked id → `signal-unavailable`.
2. No `MediaArtist` for the linked Plex id → `signal-unavailable` (`no-plex-artist`).
3. Rating unavailable → `signal-unavailable` (`unrated`). Rating below `minRating` →
   `signal-unavailable` with the check attached.
4. The artist is already on the target profile → `already-converged`.
5. Otherwise propose.

**An unresolvable `targetQualityProfile` degrades this rule, it does not kill the report.**
The profile name is resolved live against Lidarr's quality profiles, because config-time validation
cannot check that a profile exists. When it resolves to nothing, the engine does **not** throw: it
emits a rule-level `signal-unavailable` skip carrying the configured name plus the available profile
names, and the report status becomes `degraded`. A misconfigured rule never silences a sibling rule.

### `stale-monitoring-cleanup`

Unmonitors artists Lidarr is tracking that show sufficiently low Plex consumption. It proposes `artist-monitoring`
with `desiredMonitored: false`. **Files are never touched, so the change is fully reversible.** This
is the only rule with real blast radius; read the three behaviors and limits at the top of this
document and the gates below before enabling it.

Requires `bridgeIdentity`, `lidarrArtists`, and `plexTrackPlays`; enriches with `plexArtistRatings`,
which the rating veto consumes — and when that slot is unavailable the veto cannot be evaluated, so
the rule refuses rather than proceeding blind.

| Threshold                | Config key                                                     | Bounds                   | Default        |
| ------------------------ | -------------------------------------------------------------- | ------------------------ | -------------- |
| `enabled`                | `policy.rules.stale-monitoring-cleanup.enabled`                | boolean                  | `false`        |
| `maxPlays`               | `policy.rules.stale-monitoring-cleanup.maxPlays`               | 0-1000000                | `0`            |
| `minDaysSinceLastViewed` | `policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed` | 1..36,500 whole days     | unset (`null`) |
| `protectRatingAtOrAbove` | `policy.rules.stale-monitoring-cleanup.protectRatingAtOrAbove` | 1.0-5.0 stars, always on | `4`            |
| `requireTrackCoverage`   | `policy.rules.stale-monitoring-cleanup.requireTrackCoverage`   | boolean                  | `true`         |
| `minTrackFileCount`      | `policy.rules.stale-monitoring-cleanup.minTrackFileCount`      | 0-1000000                | `1`            |
| `maxProposals`           | `policy.rules.stale-monitoring-cleanup.maxProposals`           | 1-100                    | `25`           |

Five safety gates, four configurable and one structural:

1. **Rating veto** — `protectRatingAtOrAbove`. An artist rated **at or above** this is never
   unmonitored, whatever the play count. The comparison is inclusive: an artist sitting exactly on
   the configured floor is refused with `rating-protected`; one star below it stays proposable.
   **There is no off-switch.** The schema admits a finite number in `1.0`-`5.0` and nothing else, so
   the veto is always active; the narrowest useful setting is `5`, which protects only five-star
   artists. Do not write `protectRatingAtOrAbove: null` — a YAML `null` fails validation, and
   `loadConfig` responds by logging one warning and falling back to an **empty** config, which
   silently discards your entire `.rfmedia.yaml` (Plex URL and token, library roots, everything) for
   that run.
2. **Coverage** — `requireTrackCoverage`. Requires at least one Plex track to have actually joined
   this artist. Without it, "no plays observed" could be read as "not consumed" when the truth is
   "the artist is not in this Plex library." Leave it `true`.
3. **Acquisition** — `minTrackFileCount`. Only artists Lidarr already has this many files for are
   considered, so an artist still in the acquisition queue is never unmonitored out of it. An
   artist whose Lidarr `statistics` block is absent is skipped, never read as zero.
4. **Optional recency** — `minDaysSinceLastViewed`. When configured, the latest trustworthy view
   must be at least the configured number of 86,400-second days old. Never-viewed artists and
   partial played-row evidence are refused rather than assigned an artificial age. It remains an
   additional requirement after `maxPlays`, not a replacement for the lifetime ceiling.
5. **Empty consumption (structural, not configurable)** — the rule refuses to run at all when the
   library-wide play total is zero, which is the signature of a token whose Plex account is not the
   listening account. See [above](#which-plex-account-do-the-consumption-signals-come-from).

Evaluation order, first blocking cause wins:

1. Rule-level gate: `coverage.totalPlaysObserved === 0` → the whole rule skips with
   `consumption-signal-empty`.
2. No `LidarrArtist` → `signal-unavailable`.
3. Not monitored → `already-converged`.
4. Play observation: ambiguous normalized name or the sentinel bucket → `ambiguous-name-join`; no
   joined track with `requireTrackCoverage: true` → `no-consumption-coverage`.
5. Rating veto: ratings slot unavailable → `signal-unavailable`; rating at or above the veto →
   `rating-protected`.
6. Acquisition gate: `statistics` absent → `signal-unavailable` (`lidarr-statistics-absent`);
   `trackFileCount` below `minTrackFileCount` → `no-consumption-coverage`.
7. Plays above `maxPlays` → `signal-unavailable` with the check attached.
8. With `minDaysSinceLastViewed` configured: missing or partial recency → `signal-unavailable` with
   its named gap; a recent or future latest view → `signal-unavailable` with an unsatisfied
   `older-than-days` check.
9. Otherwise propose.

A Lidarr-only artist — one with no Plex counterpart at all — is **always** refused with
`no-consumption-coverage`. It has produced no evidence, and absence of evidence is not evidence of
non-consumption.

The empty-consumption gate is **rule-scoped**: `totalPlaysObserved === 0` skips only
`stale-monitoring-cleanup`. The other two rules use plays exclusively to make themselves _more_
conservative — `minPlays` is a floor a candidate must clear — so a zero-play library makes them
propose less, never more, and degrading the whole report would suppress correct, useful output. The
rule skip already sets the report status to `degraded`, so the condition stays visible at the top
level.

### `discovery-seed`

Emits **inert** `rfmedia lidarr discover --artist "<name>"` seeds for high-signal Plex artists that
Lidarr does not have. It produces no plan, adds no artist, and makes no provider call — in
particular no Last.fm call. The existing `discover` leaf keeps sole ownership of that provider
boundary and its traversal budgets.

Requires `bridgeIdentity` and `plexArtistRatings`; enriches with `plexTrackPlays`.

| Threshold   | Config key                              | Bounds        | Default                    |
| ----------- | --------------------------------------- | ------------- | -------------------------- |
| `enabled`   | `policy.rules.discovery-seed.enabled`   | boolean       | `false`                    |
| `minRating` | `policy.rules.discovery-seed.minRating` | 1.0-5.0 stars | `5`                        |
| `minPlays`  | `policy.rules.discovery-seed.minPlays`  | 0-1000000     | none — rating-only ranking |
| `maxSeeds`  | `policy.rules.discovery-seed.maxSeeds`  | 1-100         | `10`                       |

Candidates come from `plexOnly` filtered to unmatched items with `reason === "no-candidate"` **only**.
That filter is deliberate: the `plexOnly` union also contains review-normalized-name,
review-fuzzy-name, ambiguous, conflict, and unavailable items, all of which probably already exist
in Lidarr under a slightly different name. `no-candidate` means the resolver found nothing at all,
which is the only honest "absent from Lidarr" signal.

When `minPlays` is unset, the play observation is ignored. When it is set, there are two distinct
refusal paths, both reported as `signal-unavailable` and distinguishable by their detail:

| Case                          | Detail                                                                         | Checks                                      |
| ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| Play total not observable     | `<reason>: no trustworthy Plex play total backs the configured minPlays floor` | none                                        |
| Observed, but below the floor | `<observed> Plex plays are below the configured floor of <minPlays>`           | one, `policy.rules.discovery-seed.minPlays` |

Candidates are ranked `rating desc, plays desc, plexId asc` and cut at `maxSeeds`.

Seeds carry **no identity link** — there is no Lidarr counterpart to link to — and their subject has
no `artistId`. Their handoff producer is fixed to `discovery`, so the type prevents a seed from ever
being routed to a mutation producer.

## Configuration Reference

The generated config template feeds `yaml.dump`, which cannot carry comments, so no `policy:`
skeleton is emitted into a generated `.rfmedia.yaml` — an uncommented empty block would be worse
than none. Copy the annotated block below into `.rfmedia.yaml` instead.

Every top-level policy field and rule field is optional. Each configured override entry, however,
requires all three of `action`, `evidenceFingerprint`, and `reason`. Unknown keys — **including an
unknown rule id** — are rejected with a `ConfigError` carrying the exact property path, so a typo
cannot silently disable a rule or erase a suppression. The validator injects no defaults:
`undefined` keeps meaning "unset" all the way to the engine, which applies every default at one
place.

```yaml
# .rfmedia.yaml — consumption-driven Lidarr policy engine (issue #209).
#
# Every key is optional. Unknown keys — including an unknown RULE ID — are
# rejected with a ConfigError carrying an exact dotted propertyPath, e.g.
#   policy.rules.stale-monitoring-cleanup.maxPlays
# so a typo cannot silently disable a rule.
#
# Rating values use the SAME 1-5 star input scale as the `filters:` section.
# Plex native 0 means UNRATED, which is "no signal", never "zero stars" — an
# unrated artist is SKIPPED, never treated as low-rated.
#
# `{{ VAR }}` template substitution works here for free (raw-text pre-parse),
# but no field in this section is a credential: policy reads Plex and Lidarr
# through the existing `plex.*` / `lidarr.*` sections.

policy:
  # Plex music library consumption signals are read from.
  # Overridable per invocation with --plex-library.
  plexLibrary: "Music"

  rules:
    # ── 1. Rating-informed quality upgrade ───────────────────────────────────
    # Promote artists you demonstrably love to a better quality profile.
    # Proposes an `artist-profile-assignment` change; never deletes anything.
    rating-quality-upgrade:
      enabled: true # default: false
      minRating: 4 # 1-5 stars.        default: 4
      # Existing Lidarr quality profile, by name or numeric id. Resolved live
      # against client.listQualityProfiles(). When the configured name resolves
      # to nothing, the rule is skipped: a rule-level skip carries the configured
      # name plus the available profile names, and the report status becomes
      # `degraded`. It never throws and never suppresses sibling rules.
      # REQUIRED when the rule is enabled.
      targetQualityProfile: "Lossless"
      maxProposals: 25 # 1-100.            default: 25

    # ── 2. Stale monitoring cleanup ──────────────────────────────────────────
    # Unmonitor artists Lidarr is tracking that show no Plex consumption.
    # Proposes `artist-monitoring` (desiredMonitored: false). FULLY REVERSIBLE:
    # files are never touched. This is the only rule with real blast radius —
    # read the five safety gates below before enabling it.
    stale-monitoring-cleanup:
      enabled: false # default: false. Opt in deliberately.

      # Inclusive ceiling on the artist's TOTAL Plex play count. This remains
      # active when recency is enabled. Raise it above 0 deliberately if old,
      # previously viewed artists should qualify.
      maxPlays: 5 # 0-1000000.        default: 0

      # SAFETY GATE 4 — optional recency conjunct. The newest trustworthy Plex view must be at
      # least this many 86,400-second days old at the captured evaluation time.
      # Omit this key for legacy absolute-play-only behavior. Never-viewed
      # artists and incomplete played-row timestamps are refused, not aged.
      minDaysSinceLastViewed: 90 # 1..36,500 whole days. default: unset (null)

      # SAFETY GATE 1 — rating veto. An artist rated AT OR ABOVE this is never
      # unmonitored, regardless of play count. ALWAYS ACTIVE: the schema admits
      # a finite 1.0-5.0 value and nothing else, so there is no disabling value.
      # The narrowest setting is 5 (protects five-star artists only). Writing
      # `null` here fails validation. The override-sensitive policy and ratings
      # commands abort on the highest-precedence config instead of falling back.
      protectRatingAtOrAbove: 4 # 1-5 stars.        default: 4

      # SAFETY GATE 2 — coverage. Require at least one Plex track to have
      # actually joined this artist. Without it, "no plays observed" could be
      # read as "not consumed" when the truth is "the artist is not in Plex".
      requireTrackCoverage: true # default: true. Leave it true.

      # SAFETY GATE 3 — acquisition. Only consider artists Lidarr already has
      # this many files for, so an artist still in the acquisition queue is
      # never unmonitored out of it. An artist whose Lidarr `statistics` block
      # is absent (freshly added / unscanned) is SKIPPED, not treated as zero.
      minTrackFileCount: 1 # 0-1000000.        default: 1

      # SAFETY GATE 5 (structural, not configurable) — the rule refuses to run
      # at all when the library-wide play total is zero, which is the signature
      # of a token whose Plex account is not the listening account.

      maxProposals: 25 # 1-100.            default: 25

    # ── 3. Discovery seed generation ─────────────────────────────────────────
    # Emits INERT `lidarr discover --artist "<name>"` seeds. Produces no plan,
    # no add, and makes no provider call.
    discovery-seed:
      enabled: false # default: false
      minRating: 5 # 1-5 stars.        default: 5
      minPlays: 25 # omit to rank on rating alone. no default
      maxSeeds: 10 # 1-100.            default: 10

  # Durable, suppression-only review records. Copy the proposal key and FULL
  # evidence fingerprint from `policy evaluate --explain <key>` in the same
  # environment. Quote the key so YAML treats it as one mapping key.
  overrides:
    "stale-monitoring-cleanup:artist:233":
      action: suppress # the only accepted action; there is no force/allow
      evidenceFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      reason: "Compilation listening is intentionally excluded from this decision"
```

## Disputing a Decision

Every proposal and every refusal carries a **stable, non-rotating** decision key. It is deliberately
not a content hash: editing a threshold must not silently invalidate the key you just read out of a
report. Every proposal also carries a rotating, scope-bound evidence fingerprint. The key identifies
which decision you reviewed; the full `sha256:<64 lowercase hex>` fingerprint proves which origins,
library, subject identity, observations, thresholds, before/after state, and producer you reviewed.

| Decision | Key format                                   | Example                                                       |
| -------- | -------------------------------------------- | ------------------------------------------------------------- |
| Proposal | `<ruleId>:artist:<lidarrId>`                 | `rating-quality-upgrade:artist:41`                            |
| Proposal | `<ruleId>:plex:<plexId>` (no Lidarr subject) | `discovery-seed:plex:60`                                      |
| Skip     | `<ruleId>:artist:<lidarrId>:<skipCode>`      | `stale-monitoring-cleanup:artist:999:no-consumption-coverage` |
| Skip     | `<ruleId>:plex:<plexId>:<skipCode>`          | `discovery-seed:plex:60:signal-unavailable`                   |

**A skip key carries the skip code as a fourth segment; a proposal key does not.** Rule plus subject
alone is not total for refusals — one subject can legitimately draw two refusals from the same rule,
for example when `stale-monitoring-cleanup` refuses a Lidarr-only artist with
`no-consumption-coverage` while the universal pass also attributes `identity-not-authoritative` to
the same subject. Without the code both rows would share a key and `--explain` would render whichever
one it reached first. A rule proposes at most one change per subject, so proposal keys stay at three
segments.

Proposal keys are printed on every proposal row. Skip keys are printed under `--verbose`; the default
skip section is a `Code` / `Count` / `Detail` rollup and carries no keys.

```bash
rfmedia lidarr policy evaluate --explain stale-monitoring-cleanup:artist:233
rfmedia lidarr policy evaluate --explain stale-monitoring-cleanup:artist:233:rating-protected
```

`--explain` prints one decision's full causal chain:

- **Head** — the key, the outcome (`proposed` or `skipped`), the rule title, the decision or skip
  code, and the subject with its Plex id, Lidarr id, and MBID.
- **Identity evidence** — the bridge category and reason, plus the one sentence every decision is
  measured against: _only a unique one-to-one exact artist-MBID join may carry a proposal_.
- **Observations** — each observed value with its join grade and sample size, or the gap reason when
  it could not be made. This is where you see `join normalized-name` next to a play count and know
  it is a name rollup. A recency-enabled proposal also shows the raw `lastViewedAt` epoch seconds;
  a refusal can instead show `no-recency-coverage` or `partial-recency-coverage`.
- **Threshold checks** — every check in evaluation order with its comparator, bound, observed value,
  and `SATISFIED` / `NOT MET` verdict. Each configured check prints its dotted `.rfmedia.yaml` path
  on its own line; a structural gate is marked `(structural gate)` and has no path. The recency
  check renders the latest view as a stable ISO timestamp, comparator `older-than-days`, the integer
  day bound, and `policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed`.
- **Evidence** — the full copy-grade proposal fingerprint. Human summary tables may shorten it only
  as a recognition aid; `--explain`, JSON, YAML, and CSV retain the complete hash.
- **Proposal** and **Follow-up** for a proposal, or **Refusal** for a skip.
- **Override** — when the key has a configured record, its lifecycle state, rationale, expected and
  current full fingerprints, stale reason, exact config path, and safe next step.

An unknown key fails with a lookup error listing the keys the report actually carries, including
withheld override keys that no longer appear in the actionable proposal array.

### Suppress a reviewed proposal

The workflow is deliberately manual and review-first:

1. Run `rfmedia lidarr policy evaluate` and copy the proposal key you intend to dispute.
2. Run `rfmedia lidarr policy evaluate --explain <key>`. Review the identity, observations,
   thresholds, before/after state, and producer; then copy the **full** evidence fingerprint.
3. Add a quoted `policy.overrides` entry to `.rfmedia.yaml` with `action: suppress`, the copied
   fingerprint, and a concrete operational reason.
4. Re-run the original evaluate, plan, or ratings-sync command and verify the override state before
   relying on the result.

The exact entry shape is:

```yaml
policy:
  overrides:
    "stale-monitoring-cleanup:artist:233":
      action: suppress
      evidenceFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      reason: "Compilation listening is intentionally excluded from this decision"
```

Replace the example hash with the full value from the same environment and review. Only
three-segment **proposal** keys are accepted; skip/refusal keys cannot be overridden. `suppress` is
the only action. There is no force, allow, alternate desired state, skip-to-proposal conversion,
editor command, or automatic fingerprint refresh.

Reasons are required, already trimmed, terminal-safe strings of at most **512 UTF-8 bytes**.
Control characters, bidi controls, empty reasons, unknown fields, malformed hashes, unsafe mapping
keys, and more than 500 override entries fail validation with the exact quoted bracket path.

### Override lifecycle and recovery

Human output always includes an `Overrides` section. Its state labels are textual, not color-only:

| Human state               | Machine state and cause                                                                  | Effect and recovery                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ACTIVE SUPPRESSION`      | `suppressed`; proposal key and evidence fingerprint match                                | The reviewed proposal is withheld. Leave the record in place, or remove it only when the reason is obsolete                                                        |
| `STALE — REVIEW REQUIRED` | `stale: evidence-changed`; the same proposal now has a different fingerprint             | The current proposal stays withheld. Re-run `--explain`, review the full current evidence, then replace the fingerprint to keep suppressing or remove the override |
| `STALE — REVIEW REQUIRED` | `stale: outcome-changed`; the subject now produces a real skip/refusal                   | The real skip remains visible and nothing is synthesized. Review it; update only if a proposal returns, or remove an obsolete record                               |
| `STALE — REVIEW REQUIRED` | `stale: decision-absent`; a selected, completed rule emitted no decision for the subject | Verify identity, convergence, delete/re-add, and instance scope. There is no current hash to copy; remove the record only if it is obsolete                        |
| `NOT EVALUATED`           | Rule was deselected, disabled, or blocked before subject evaluation                      | The record was not assessed. Re-run with the rule enabled and selected before changing it; do not refresh its fingerprint                                          |

Active and stale matches are removed centrally from `report.proposals` before either `policy plan`
or `sync-ratings` projects producer cohorts. They cannot enter a new plan artifact or apply lane;
unrelated actionable proposals remain eligible. Stale records also trip
`policy evaluate --fail-on proposals` **after** the report has rendered.

Recency evidence is stable across clock passage: the fingerprint contains the raw latest-view
timestamp and configured day threshold, not the ever-increasing computed age or a moving cutoff.
The human summary may report the computed whole-day age, but rerunning later with unchanged Plex
evidence and configuration does not stale an active override. A new view timestamp or changed
`minDaysSinceLastViewed` value reclassifies the override: `evidence-changed` when the subject still
produces a proposal, or `outcome-changed` when the recency gate now refuses it.

### Strict loading for override-sensitive commands

`lidarr policy evaluate`, `lidarr policy plan`, and `lidarr sync-ratings` treat the
highest-precedence existing config file as authoritative. A read failure, unresolved or malformed
template, YAML/JSON parse error, or validation error aborts before plugin initialization, action
loading, evidence gathering, producer calls, prompts, sealing, or apply. These commands never warn
and fall through to a lower-priority or empty config that could silently erase a veto. Commands
outside those three retain the established permissive loading behavior.

### Tuning a threshold

The dotted path on a check is the exact key to edit. If `--explain` shows

```text
plays           <=  0     observed 3     NOT MET
    policy.rules.stale-monitoring-cleanup.maxPlays
```

then raising `policy.rules.stale-monitoring-cleanup.maxPlays` to `3` would admit that artist. Edit
the key, re-run, and re-read the same key — it does not move.

Threshold tuning changes policy for every matching subject. Use a suppression override instead
when the rule is correct but one reviewed proposal should remain inert. In either case, re-run and
re-read the same stable key; an existing override becomes stale rather than silently following new
evidence.

## Output Schemas

Human output goes to **stderr**; machine output goes to **stdout**, so `--output json | jq` stays
usable. Detail sections show at most 20 rows by default, and refusals are rolled up by code;
`--verbose` shows every proposal row and every refusal individually.

A run whose rules all skipped and which proposed nothing switches to a self-teaching layout: every
registered rule appears with its title, its description, and the exact dotted key that would enable
it.

JSON and YAML write one prose-free document:

```json
{
  "command": "lidarr-policy-evaluate",
  "result": {
    "schema": "rfmedia.lidarr-consumption-policy.v3",
    "engineVersion": 3,
    "evaluatedAt": "2026-07-28T18:04:11.000Z",
    "plexOrigin": "https://plex.example.net",
    "lidarrOrigin": "https://lidarr.example.net",
    "plexLibrary": "Music",
    "status": "proposals",
    "policy": {},
    "signals": {},
    "summary": {
      "proposed": 4,
      "skipped": 21,
      "suppressed": 1,
      "staleOverrides": 0,
      "notEvaluatedOverrides": 0,
      "rulesRun": 2,
      "rulesSkipped": 1
    },
    "rules": [],
    "proposals": [],
    "skips": [],
    "overrides": [],
    "coverage": {
      "plexArtistsExamined": 604,
      "plexTracksExamined": 18220,
      "authoritativeLinks": 586,
      "nonAuthoritativeArtists": 18,
      "ambiguousNameArtists": 1,
      "sentinelArtistTracks": 12,
      "unjoinedTracks": 4,
      "totalPlaysObserved": 18204
    }
  }
}
```

Structural guarantees a `--json` consumer may rely on:

- **Every registered rule appears in `rules` exactly once, always** — even when deselected,
  disabled, or ungathered. Key on ids without probing.
- `status` follows the precedence `degraded` > `proposals` > `clean`.
- Ordering is a deterministic total order: rule declaration order, then `lidarrId` ascending, then
  `plexId` ascending. The whole report is deep-frozen.
- Every actionable proposal carries its full `evidenceFingerprint`. `overrides` retains every
  configured record with `expectedEvidenceFingerprint`, nullable `currentEvidenceFingerprint`,
  rationale, lifecycle status/stale reason, and the full current proposal, skip, or `null` decision.
- `summary.proposed` and per-rule proposal counts are actionable-only. Separate `suppressed`,
  `staleOverrides`, and `notEvaluatedOverrides` counts explain every configured record.
- A throwing evaluator costs exactly one rule (`rule-error`); the report degrades and every sibling
  rule still runs.
- `handoff.argv` is a machine argument vector, never shell text, and never names `apply` or
  `--plan-file` in a **structural** position — the leading verb segments and the option names. The
  assertion deliberately exempts option **values**, because those are library data: a Plex artist or
  a Lidarr quality profile literally titled `apply` is a legal string, and refusing it would turn the
  whole rule into a `rule-error` and delete every proposal it had made.
- The envelope excludes credentials, raw provider records, GUID URLs, and response bodies. Failures
  use the standard redacted Lidarr error envelope,
  `{ "command": "lidarr-policy-evaluate", "error": { … } }`.

CSV uses a fixed flat schema discriminated by `rowType` (`summary`, `rule`, `proposal`, `skip`,
`override`). Rows are ordered: one summary row, then one row per registered rule, then proposals,
skips, and configured overrides.
Because the shared serializer supports only two levels of nesting, compound cells
(`before`, `after`, `checks`, `observations`, `handoff.argv`) are JSON-encoded into the
`decision.beforeJson`, `decision.afterJson`, `decision.checksJson`, `decision.observationsJson`, and
`decision.handoffArgvJson` columns. Proposal rows include the full
`decision.evidenceFingerprint`; override rows include action, status, stale reason, rationale, and
the full expected/current fingerprints. The shared CSV formula guard neutralizes a rationale that
begins with `=`, `+`, `-`, `@`, tab, carriage return, or line feed. The `coverage.*` columns carry
the same eight counters as the JSON envelope.

### Policy plan output

Human policy-plan output goes to stderr and labels the result `REVIEW ONLY`, `NO CHANGES`,
`REFUSED`, `SEALED`, `PARTIAL`, or `FAILED` without relying on color. It includes the complete
evaluation context, deterministic producer cohorts, refusals and remedies, total proposal
accounting, and every completed artifact's path, plan ID, checksum, and proposal keys. Human detail
is capped at 20 rows unless `--verbose` is set; keys, paths, IDs, checksums, and machine data are
never truncated.

JSON and YAML emit one prose-free `{ "command": "lidarr-policy-plan", "result": ... }` document.
The result schema is `rfmedia.lidarr-policy-plan.v1`; it keeps the full
`rfmedia.lidarr-consumption-policy.v3` evaluation report beside `mode`, `status`, deterministic
`cohorts`, `refusals`, `outcomes`, `summary`, and optional `failure`. Policy decision keys and
threshold provenance stay in this wrapper result, not in the strict v3 artifacts. Retain machine
output alongside a sealed artifact when that provenance matters operationally:

```bash
rfmedia --output json lidarr policy plan --mode plan > policy-plan-run.json
```

| Result status | Meaning                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| `reviewed`    | Recommend mode projected proposals; outcomes stay empty even when refusals are visible      |
| `no-changes`  | Evaluation produced no proposals; no producer ran and no empty artifact was written         |
| `refused`     | Plan-mode preflight found at least one refusal, so no producer ran and nothing was written  |
| `sealed`      | Every projectable cohort sealed successfully in deterministic producer order                |
| `partial`     | A later producer failed after at least one artifact sealed; completed outcomes are retained |
| `failed`      | The first producer failed, so no artifact outcome exists                                    |

A projection invariant error does not fabricate a result status: it uses the standard redacted
`lidarr-policy-plan` failure envelope. CSV uses the same single clean stdout boundary and the fixed
row order `summary`, registered `rule` rows, `cohort` rows, evaluation `proposal`, `skip`, and
`override` rows, `refusal` rows, then `artifact` rows.

### Engine bounds on a rule's own decisions

Two defensive per-rule bounds sit above the configurable caps. They exist so one pathological rule
cannot produce an unbounded document.

| Bound                           | Value | Applies to           | Cut order                           |
| ------------------------------- | ----- | -------------------- | ----------------------------------- |
| `POLICY_MAX_PROPOSALS_PER_RULE` | `100` | One rule's proposals | Evidence-strength ranking, then cut |
| `POLICY_MAX_SKIPS_PER_RULE`     | `500` | One rule's own skips | Deterministic emission order, head  |

The proposal bound is unreachable through configuration: `maxProposals` / `maxSeeds` are themselves
capped at `100`.

The skip bound has one interaction worth knowing. The universal `identity-not-authoritative`
refusals are attached to their owning rule **after** the bound is applied, never before — so the
refusal-owning rule's row can legitimately report up to `500 + coverage.nonAuthoritativeArtists`
skips, and `coverage.nonAuthoritativeArtists` is always the **untruncated** count. Refusals are data,
never omissions: a rule that emits 500 skips of its own must not silently delete the universal
refusals attributed to it. `summary.skipped === report.skips.length` holds either way.

## Exit Behavior

Only exit codes `0` and `1` exist. The command sets `process.exitCode` and never calls
`process.exit()`.

- Exit `0` means a report was produced. Proposals, skips, coverage gaps, and degraded slots are
  report data, not failures.
- Exit `1` covers invalid options (an unknown `--rule`, a `--rule` carrying no id, a
  `--max-proposals` outside 1-100, an unknown `--fail-on` level, an `--explain` key no decision
  owns), a missing capability or configuration, provider failure, and cancellation.
- Exit `1` also results from the opt-in `--fail-on` gate.

`--fail-on` accepts exactly two values:

| Value       | Trips when                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `none`      | Never. This is the default                                                                        |
| `proposals` | At least one actionable proposal or stale override exists, **or** the report status is `degraded` |

`degraded` is **not** a `--fail-on` level. It is a report status, and it trips any non-`none` level,
so an incomplete evaluation can never read green under a CI gate.

The gate is applied **after** rendering, so an operator always sees the evidence behind a failing
run.

`policy plan` uses the same two exit codes but has no `--fail-on`:

- Exit `0` covers a default review (including visible refusals), `no-changes`, and a fully `sealed`
  plan-mode result.
- Exit `1` covers invalid input, provider or projection failures, cancellation, and plan-mode
  `refused`, `partial`, or `failed` results.

The plan exit gate also runs after rendering, so a refused or partial run still discloses all review
evidence and any artifact already sealed.

## Safety and Follow-Up Boundaries

`policy evaluate` performs zero writes. No plan writer, history appender, or plan claim is imported.
No Lidarr mutation method is called — only `listArtists` and `listQualityProfiles`, both reads, plus
the Plex artist and track queries. `adapter.metadata` is never referenced, so no Plex rating is ever
written by policy evaluation. Other commands own their own rating-mutation paths; none is reachable
from `policy evaluate`.

Policy provenance lives in the evaluation report and **never** in a plan artifact. The sealed v3
plan envelope is frozen at an exact key set and its validator re-derives cascade analysis from
canonical plan facts, so a `policy`, `ruleId`, or `rationale` field on an artifact is structurally
impossible.

Overrides govern only new evaluations and their same-run projections. Adding or changing an
override does **not** revoke, rewrite, or invalidate a plan artifact that was already sealed. Such
an artifact remains independently governed by its recorded origin, plan ID, checksum, drift
preflight, confirmation, claim, and apply rules; remove an obsolete artifact deliberately if it
must no longer be eligible for apply.

### Review, seal, and apply remain separate

Issue #209 deliberately shipped evaluation without a writer. That provenance remains true:
`policy evaluate` is unchanged, strictly read-only, and cannot turn a report into a plan. Issue #311
adds a separate `policy plan` leaf while preserving the review and authorization boundaries.

```bash
# Step 1 — review. Runs evaluation and projection; writes no plan artifact.
rfmedia lidarr policy plan --rule stale-monitoring-cleanup

# Step 2 — seal. Re-evaluates, globally preflights, then invokes the existing
#          fresh-state producer. It never applies.
rfmedia lidarr policy plan --rule stale-monitoring-cleanup --mode plan

# Step 3 — apply one sealed artifact separately, with both review pins.
rfmedia lidarr apply ~/.config/rfmedia/plans/lidarr-<stamp>-<id8>.json \
  --expected-plan-id <plan-id> \
  --expected-plan-checksum <sha256-checksum>
```

Every `policy plan` invocation performs a new evaluation; it does not consume or trust a saved
`policy evaluate` report. In seal mode, the profile producer re-reads live artists and quality
profiles, while the monitoring producer re-reads live artists. The positive numeric profile ID and
desired monitoring boolean from the cohort select the target; display names and evaluation `before`
state never authorize the artifact. The separate apply step retains origin/checksum validation,
drift preflight, confirmation, resume, history, exclusive claims, and all existing authorization.

The general policy-plan leaf does not apply or auto-apply, execute `handoff.argv`, accept a single
artifact path, create a new plan schema or operation kind, add policy fields to an artifact, execute
discovery, persist recency history, or edit/refresh override config. Suppression is evaluation input,
not a force-like plan operation. `sync-ratings` remains the specialized recommend/plan/apply lane
with threshold overrides and its own confirmation behavior.

A separate command, `rfmedia lidarr sync-ratings --mode apply --yes`, is the gated apply lane for the
same two rating-driven rules on identical decision keys: it runs its own evaluation and then climbs
its own `--mode` ladder through these same producers and this same sealed apply lifecycle, so
nothing changes here — `policy evaluate` still only proposes, and no report it prints can become a
mutation.

The `Suggested follow-up` block and every `handoff.argv` are **inert data**: argument arrays for
inspection, following the same precedent as reconciliation suggestions. Nothing in them is executed,
and none of them names `apply` or `--plan-file` in a structural position (see the `handoff.argv`
guarantee under [Output Schemas](#output-schemas)).

## Troubleshooting

| Symptom                                                                 | What it means and what to do                                                                                                                                                                              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stale-monitoring-cleanup` skipped with `consumption-signal-empty`      | The library-wide play total is zero. Almost always a token whose Plex account is not the listening account. Re-run with the listener's token                                                              |
| `totalPlaysObserved` is far lower than your real listening history      | A partially wrong account, or a second listener. Nothing detects this automatically — do not act on proposals until it looks right                                                                        |
| Every proposal says the artist has 0 plays                              | Same cause. Check `Coverage` in the footer before you accept anything                                                                                                                                     |
| A rule skipped with `signal-unavailable` naming `targetQualityProfile`  | The configured profile name matches no live Lidarr profile. The skip lists the available names; fix `policy.rules.rating-quality-upgrade.targetQualityProfile`                                            |
| Many `identity-not-authoritative` skips                                 | Expected. Only a unique exact artist-MBID join can carry a proposal. Improve identity coverage via `rfmedia lidarr reconcile`, not here                                                                   |
| `ambiguous-name-join` on an artist you know is unique                   | Two Plex artists normalize to the same name, or the artist's tracks fell into the `"Unknown Artist"` sentinel bucket. Fix the Plex tags                                                                   |
| `signal-unavailable` with gap `lidarr-statistics-absent`                | Lidarr has not scanned the artist yet. Let it scan; the gate deliberately refuses rather than reading the absent block as zero                                                                            |
| `no-consumption-coverage` on a Lidarr artist you do own in Plex         | The bridge did not authoritatively match it. Run `rfmedia lidarr reconcile` and resolve the identity first                                                                                                |
| A recently added artist is proposed for unmonitoring                    | Legacy absolute-play-only behavior is active because `minDaysSinceLastViewed` is unset. Configure it to fail closed on missing/recent timestamps, or keep using `minTrackFileCount` and review-only mode  |
| `signal-unavailable` names `no-recency-coverage`                        | Every joined track lacks `lastViewedAt`; the artist may be never viewed or the resolved Plex credential may not see that account's history. The rule never treats absence as an old view                  |
| `signal-unavailable` names `partial-recency-coverage`                   | At least one played joined track lacks `lastViewedAt`. Fix the Plex/account evidence or leave the artist refused; another timestamp cannot make the partial bucket trustworthy                            |
| The report is `degraded` and the CI gate fails despite zero proposals   | A required signal failed, or a rule refused wholesale. `degraded` trips any non-`none` `--fail-on` level by design. Read the `Signals` footer                                                             |
| The run is slow                                                         | `plex.cache.enabled` defaults to `false` and every run drains the whole track catalog. Set `plex.cache.enabled: true`; `--rule` does **not** reduce the drain                                             |
| A slot is unavailable with `data-unavailable` and a bound in the detail | The library exceeded 10,000 artists or 200,000 tracks. The slot fails closed rather than truncating; narrow the library                                                                                   |
| `--explain <key>` reports an unknown key                                | Keys are stable but per-report. Copy the key from the current run's rows; a skip key ends in its skip code and only prints under `--verbose`, and a rule that skipped wholesale emits no per-subject keys |
| `policy plan --explain` printed the full report before one decision     | Expected. Human plan output preserves complete status, artifact, and failure evidence before appending the causal chain; machine formats always emit the full envelope                                    |
| A compilation-only artist is proposed for unmonitoring                  | Plays credit the **album** artist, so compilation listening never reaches the performer's own bucket. Not detectable here; see the compilation-rollup section                                             |

### Policy plan troubleshooting

- **Plan mode is `refused` and wrote nothing:** at least one selected proposal was unsupported or
  conflicting. Plan mode is globally fail-closed; read the refusal and remedy, or narrow `--rule`.
  A discovery seed is review-only and never becomes `artist-add`.
- **The result is `no-changes`:** the selected evaluation produced no proposals. This is successful
  and intentionally creates no empty artifact.
- **The result is `partial` with one artifact:** the first producer sealed, then a later producer
  failed against fresh state or storage. The first artifact is inert and retained; inspect its pins
  and apply or remove it deliberately.

## Related Documentation

- [Lidarr Ratings Sync](lidarr-ratings-sync.md)
- [Lidarr Plan and Apply](lidarr-plan-apply.md)
- [Plex-Lidarr Reconciliation](plex-lidarr-reconciliation.md)
- [Lidarr Library Health Audit](lidarr-audit.md)
- [Lidarr Quality Presets](lidarr-quality-presets.md)
- [Plex Configuration](plex-configuration.md)
