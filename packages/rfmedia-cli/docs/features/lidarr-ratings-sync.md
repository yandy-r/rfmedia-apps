# Lidarr Ratings Sync

## Overview

`rfmedia lidarr sync-ratings` turns Plex ratings and play counts into Lidarr monitoring and
quality-profile changes. It decides nothing of its own: it runs the shipped
[consumption policy engine](lidarr-consumption-policy.md), projects two of that engine's rules onto
the shipped plan producers, and embeds the evaluation report it read verbatim — so this command and
`rfmedia lidarr policy evaluate` are structurally incapable of disagreeing about a decision.

Where `policy evaluate` stops at a report, this command is the gated apply lane for the same two
decisions. The write envelope is a single value-taking `--mode`, and every rung above the first is
typed by a human:

| Invocation                                  | Reads Plex + Lidarr | Seals plan artifacts   | Mutates Lidarr |
| ------------------------------------------- | ------------------- | ---------------------- | -------------- |
| `sync-ratings` (default `--mode recommend`) | yes                 | **no**                 | **no**         |
| `sync-ratings --mode plan`                  | yes                 | yes (0-2, mode `0600`) | **no**         |
| `sync-ratings --mode apply --yes`           | yes                 | yes (0-2)              | yes            |

**Nothing is ever written to Plex under any flag combination.** Issue #221 reads Plex and writes
Lidarr, never the reverse: `adapter.metadata` and `updateTrackRating` are never referenced, so no
rating, play count, or collection is written back.

Two decisions ship, and they are the two policy rules that own a plan producer:

| Decision          | Policy rule                | Sealed plan operation       |
| ----------------- | -------------------------- | --------------------------- |
| `quality-profile` | `rating-quality-upgrade`   | `artist-profile-assignment` |
| `monitoring`      | `stale-monitoring-cleanup` | `artist-monitoring`         |

The shared evaluation also applies `policy.overrides`. Exact reviewed matches appear as
`ACTIVE SUPPRESSION`; changed or missing evidence appears as `STALE — REVIEW REQUIRED`; and a rule
that did not run appears as `NOT EVALUATED`. Active and stale proposals are withheld before this
command builds cohorts, so neither can be sealed or applied by the same run. Unrelated actionable
proposals remain eligible.

### Read this before you type `--mode apply`

Three behaviors and limits are inherited from the engine, and each can make a wrong result look
exactly like a correct one. Recency is configurable; account/name attribution and numeric-first
profile resolution are structural.

1. **Recency is opt-in and does not replace `--max-plays`.** With
   `minDaysSinceLastViewed` unset, monitoring retains legacy absolute-play-only behavior. When the
   config key is set, an artist must satisfy both its day threshold and the lifetime ceiling; raise
   `--max-plays` above `0` deliberately if previously viewed old artists should qualify. See
   [Legacy absolute plays versus opt-in recency](#legacy-absolute-plays-versus-opt-in-recency).
2. **Consumption signals belong to one Plex account and join by normalized name.** Plays and latest
   views are credited to the **album** artist and bucketed under a normalized name, not an id. If the
   resolved token or enrolled credential is not the listening account, the engine can see zero
   plays or missing/stale recency and produce a wrong-looking result. See
   [Play totals are a weak normalized-name rollup](#play-totals-are-a-weak-normalized-name-rollup).
3. **`--quality-profile` resolves numeric ids before names.** A profile literally named `"320"` or
   `"3.0"` resolves to whichever profile has that **id**. The report echoes the resolved id and name
   as a pair for exactly this reason — check them before approving. See
   [`--quality-profile` resolves numeric ids first](#--quality-profile-resolves-numeric-ids-first).

## Use

The default rung is read-only and needs no flags. It evaluates both decisions, prints the cohorts it
would seal, and writes nothing:

```bash
rfmedia lidarr sync-ratings
```

A first real run usually names a target profile and a star floor. The report echoes the resolved
profile id beside its name so a numeric mis-resolution is visible before anything is sealed:

```bash
rfmedia lidarr sync-ratings --min-stars 4.5 --quality-profile Lossless
```

Narrow to one decision. This changes what is **projected**, not what is gathered (see
[`--decision` is not a cost lever](#--decision-is-not-a-cost-lever)):

```bash
rfmedia lidarr sync-ratings --decision monitoring --max-plays 0
rfmedia lidarr sync-ratings --decision quality-profile,monitoring
```

Seal the artifacts without applying them. One checksummed `rfmedia.lidarr-plan.v3` artifact is
written per non-empty cohort, mode `0600`, under `~/.config/rfmedia/plans`
(`RFMEDIA_PLAN_DIR` overrides the directory). Lidarr is not touched:

```bash
rfmedia lidarr sync-ratings --min-stars 4.5 --quality-profile Lossless --mode plan
```

Seal and apply. Without `--yes` each artifact is reviewed by a real dry-run apply and confirmed
individually; with `--yes` every sealed artifact is applied unprompted:

```bash
rfmedia lidarr sync-ratings --quality-profile Lossless --mode apply
rfmedia lidarr sync-ratings --quality-profile Lossless --mode apply --yes
```

Inspect the causal chain behind one decision. Keys are printed on every cohort row and come from the
embedded evaluation, so they are the same keys `policy evaluate --explain` accepts:

```bash
rfmedia lidarr sync-ratings --explain rating-quality-upgrade:artist:118
```

Machine output, and the connection overrides:

```bash
rfmedia --output json lidarr sync-ratings
rfmedia lidarr sync-ratings \
  --plex-url http://plex.example:32400 \
  --plex-token "$PLEX_TOKEN" \
  --lidarr-url http://lidarr.example:8686 \
  --lidarr-api-key "$LIDARR_API_KEY"
```

### Every run pays for a full evaluation

This command runs the same evaluation `rfmedia lidarr policy evaluate` runs, including the whole-
library Plex track drain, on **every** rung — the default one included. `plex.cache.enabled` defaults
to `false`, so set `plex.cache.enabled: true` in `.rfmedia.yaml` whenever you intend to run
repeatedly. Cancellation is immediate: every await is guarded, so Ctrl-C stops the drain rather than
finishing the page.

## Options

| Option                    | Group      | Description                                                                                         |
| ------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `--plex-library <name>`   | Selection  | Plex music library to read ratings and plays from; overrides `policy.plexLibrary` (default `Music`) |
| `--decision <kinds>`      | Selection  | Consider only these decisions. Repeatable and comma-separated. Default: both                        |
| `--min-stars <n>`         | Thresholds | Plex star floor for a quality upgrade, `1`-`5` inclusive, decimals allowed                          |
| `--max-plays <n>`         | Thresholds | Inclusive **absolute** play ceiling, `0`-`1000000`; remains conjunctive with configured recency     |
| `--quality-profile <ref>` | Thresholds | Target Lidarr quality profile, by name or numeric id. **Numeric ids resolve first**                 |
| `--max-proposals <n>`     | Thresholds | Per-rule proposal cap, `1`-`100`. **Not** a run total                                               |
| `--mode <mode>`           | Safety     | `recommend` (default), `plan`, or `apply`                                                           |
| `--yes`                   | Safety     | Approve each apply without an interactive prompt                                                    |
| `--explain <key>`         | Output     | Print one decision's full causal chain instead of the report (human output only)                    |
| `-v, --verbose`           | Output     | Show every row instead of the first 20                                                              |
| `--plex-url <url>`        | Connection | Override the canonical Plex origin                                                                  |
| `--plex-token <token>`    | Connection | Override the Plex token                                                                             |
| `--lidarr-url <url>`      | Connection | Override the canonical Lidarr origin                                                                |
| `--lidarr-api-key <key>`  | Connection | Override the Lidarr API key                                                                         |

Global `--json` and `--output <json|yaml|csv|table|text>` retain their normal behavior; they are root
options and this leaf deliberately does not redeclare them. There is no `--dry-run` (`--mode plan`
**is** the dry rung), no `--max-batch` (it is bound to the cohort), no `--rule` (`--decision` is the
narrowing lever), no `--fail-on` (`policy evaluate --fail-on proposals` owns the CI-gate surface on
identical decision keys), and no `--offline` (the identity snapshot carries zero consumption
evidence, so an offline run could emit nothing but refusals).

Every option is validated **inside** the action handler, before any adapter, Lidarr client, or
tracking database is constructed. An unknown value produces the standard redacted failure envelope
listing the accepted values, not a bare `process.exit(1)`.

### `--mode` is the only rung selector

There is no `--plan` flag and no boolean `--apply` flag. `--apply` already means a **plan file**
elsewhere in this CLI (`rfmedia lidarr apply <plan-file>`, `copy --apply <plan-file>`), and one flag
name may not carry two incompatible types: reusing it as a boolean here would also break the
cross-shell completion contract, which classifies `--apply` as a file-completing value option for
every command family at once. Collapsing both rungs into one value-taking `--mode` removes the
implication rule, the mutual-exclusion check, and the special case, all at once.

`--mode` accepts exactly `recommend`, `plan`, and `apply`. An unknown value fails with a lookup error
listing all three.

### `--max-proposals` is a per-rule cap, not a run total

`--max-proposals` replaces **each selected rule's own cap** with the same number. It is not a budget
shared across the run: `--max-proposals 10` yields up to 10 profile changes **and** 10 monitoring
changes.

The per-rule defaults it replaces are not uniform:

| Rule                       | Config key                                           | Default |
| -------------------------- | ---------------------------------------------------- | ------- |
| `rating-quality-upgrade`   | `policy.rules.rating-quality-upgrade.maxProposals`   | `25`    |
| `stale-monitoring-cleanup` | `policy.rules.stale-monitoring-cleanup.maxProposals` | `25`    |
| `discovery-seed`           | `policy.rules.discovery-seed.maxSeeds`               | `10`    |

`discovery-seed` is listed because the override is written into all three rule caps by the engine's
single resolution site, not because this command can ever seal a seed. The engine's hard ceiling
`POLICY_MAX_PROPOSALS_PER_RULE` is `100` and is what bounds the flag.

When a cohort exceeds its cap, the cut is evidence-ranked before it is taken — rating descending for
the profile rule, plays ascending for the monitoring rule — and every trimmed subject appears as a
`cohort-cap-exceeded` skip in the embedded evaluation.

Override classification happens after that cut. A suppressed or stale proposal keeps its ranked
position withheld; the engine does not refill the cohort from a lower-ranked
`cohort-cap-exceeded` skip. The embedded evaluation's `summary.proposed`, per-rule proposal counts,
and proposal array are therefore actionable-only.

### `--quality-profile` resolves numeric ids first

The value is resolved against the **live** Lidarr profile list, and a numeric-id match is attempted
**before** any name match. A profile literally named `"320"`, `"2024"`, or `"3.0"` therefore resolves
to whichever profile carries that **id**, silently.

Nothing can detect that automatically, so the report makes it visible instead: every quality-profile
cohort header prints the resolved profile **id** beside the resolved profile **name**, and the
producer binds by the id.

```text
  quality-profile — 14 artist(s) → "Lossless" (profile id 6)
```

Read that pair before approving anything. An unresolvable value is not a crash: the rule refuses
wholesale with a skip that lists every available profile name, and this command surfaces it as a
`rule-not-evaluated` refusal.

### `--decision` is not a cost lever

`--decision` narrows what is **projected and sealed**; it does not narrow what is **gathered**.
`rating-quality-upgrade` requires the Plex artist ratings and enriches with track plays, and
`stale-monitoring-cleanup` requires the track plays outright — so no selection can drop the whole-
library track drain. The one lever that reduces cost is `plex.cache.enabled: true`.

Omitting `--decision` selects **both** decisions. `--decision` with a value that contributes no kind
at all — `--decision ""` from an unset CI variable, or `--decision ,` — is an error, deliberately: an
empty selection would otherwise reach the evaluation with "every registered rule" semantics and pull
in `discovery-seed`.

## The Two Decisions

Each decision names the plan `operation.kind` it seals into, so the flag value and the artifact kind
are the same word.

| Decision          | Rule                       | Producer                    | What it makes true                                   |
| ----------------- | -------------------------- | --------------------------- | ---------------------------------------------------- |
| `quality-profile` | `rating-quality-upgrade`   | `artist-profile-assignment` | Highly rated artists move to the target profile      |
| `monitoring`      | `stale-monitoring-cleanup` | `artist-monitoring`         | Monitored, unconsumed artists become **unmonitored** |

### `discovery-seed` is structurally absent

The engine's third rule, `discovery-seed`, emits inert `lidarr discover` hints and its descriptor's
`producer` is `null`. It can never be bound to a decision here, can never be sealed into an artifact,
and never appears in a cohort. Use `rfmedia lidarr policy evaluate` when you want seeds.

### Configuration and the tri-state `enabled`

This command adds no command-specific threshold keys. It reads the same `policy.rules.*` block and
the shared `policy.overrides` mapping the consumption policy engine reads; see
[Configuration Reference](lidarr-consumption-policy.md#configuration-reference) for the annotated
template.

For a monitoring cohort that admits previously viewed but old artists, configure both conjuncts:

```yaml
policy:
  rules:
    stale-monitoring-cleanup:
      maxPlays: 5
      minDaysSinceLastViewed: 90 # whole days; valid range 1..36,500
```

`--max-plays` may override the lifetime ceiling for one run. There is no recency flag;
`minDaysSinceLastViewed` remains config-only, and omitting it preserves legacy absolute-play-only
behavior.

An override is a quoted proposal key mapped to exactly `action: suppress`, the full
`sha256:<64 lowercase hex>` fingerprint copied from `--explain`, and a required terminal-safe
rationale of at most 512 UTF-8 bytes. There is no force/allow action, no skip override, and no
automatic refresh. For example:

```yaml
policy:
  overrides:
    "stale-monitoring-cleanup:artist:233":
      action: suppress
      evidenceFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      reason: "Compilation listening is intentionally excluded from this decision"
```

Use the review workflow in
[Disputing a Decision](lidarr-consumption-policy.md#disputing-a-decision): evaluate, inspect the
same key with `--explain`, copy the full fingerprint, record the reason, and rerun `sync-ratings` to
verify the lifecycle state. This command, `lidarr policy evaluate`, and `lidarr policy plan` load the
highest-precedence config strictly. Any read, unresolved/malformed template, parse, or validation
failure aborts before evidence gathering, producer calls, prompts, sealing, or apply; there is no
fallback that can silently erase an override.

For recency-enabled proposals, the fingerprint stores the raw latest-view timestamp and configured
day bound. It deliberately excludes the moving computed age and cutoff, so rerunning later with
unchanged Plex evidence and config does not stale an active suppression. A new view or a changed
`minDaysSinceLastViewed` value yields `evidence-changed` when the subject remains a proposal, or
`outcome-changed` when recency now refuses it. Review the current `older-than-days` check under
`--explain` before changing the record.

What is specific to this command is how `policy.rules.<id>.enabled` is interpreted. The config
validator injects no defaults, so `enabled` is genuinely tri-state, and this command uses all three
states:

| `enabled`   | Meaning                             | `sync-ratings` behavior                                                         |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| `true`      | deliberately on                     | run                                                                             |
| `undefined` | never configured (the ship default) | **run** — typing the command is the opt-in, so the feature works with no config |
| `false`     | deliberately switched off           | **refuse** the decision with `decision-disabled`                                |

`rfmedia lidarr policy evaluate` cannot make this distinction: its resolution step collapses
`undefined` and `false` to the same `false`. This command reads the raw config first, force-enables
only the never-configured rules, and emits the kill-switch refusal itself. The kill switch works, and
the ship default does not become a first-run cliff.

One consequence is worth knowing if you read the JSON envelope: `result.evaluation.policy.rules[id]
.enabled` is **contaminated** by that force-enable and must not be read as decision state. The report
carries the uncontaminated raw tri-state at `result.decisionStates`, and that is what the human
`Decisions` table renders in its `State` column.

## Thresholds and Their Limits

| Threshold                | Comparator                                         | Applies to                 | Fail-closed behavior                                                  |
| ------------------------ | -------------------------------------------------- | -------------------------- | --------------------------------------------------------------------- |
| `--min-stars`            | `rating >= minStars` on the normalized scale       | `rating-quality-upgrade`   | unrated or below floor → `signal-unavailable` with the check attached |
| `--max-plays`            | `plays <= maxPlays`                                | `stale-monitoring-cleanup` | unobservable join → a named gap refusal, **never** zero               |
| `minDaysSinceLastViewed` | `lastViewedAt older-than-days configured bound`    | `stale-monitoring-cleanup` | recent, future, missing, or partial evidence → `signal-unavailable`   |
| `--quality-profile`      | structural `qualityProfileId != resolvedProfileId` | `rating-quality-upgrade`   | unresolvable → rule skip naming every available profile               |
| `--max-proposals`        | per-rule cohort cap                                | every selected rule        | over-cap → `cohort-cap-exceeded` skips after an evidence-ranked cut   |

The outer sync report echoes its four flag-capable thresholds with honest per-field provenance —
`flag`, `config`, or `default` — because a proposal's own `configPath` always cites the
`.rfmedia.yaml` key even when the effective bound arrived from a flag. Config-only
`minDaysSinceLastViewed` is echoed in the embedded evaluation's resolved policy and recency check,
not duplicated into the outer threshold object. Only the `Source` column tells a persistent policy
from a one-off experiment:

```text
  Thresholds
  Threshold        Effective        Source
  ───────────────  ───────────────  ─────────────────────────────────────────────────
  min stars        >= 4.5           flag --min-stars
  max plays        <= 5             config policy.rules.stale-monitoring-cleanup.maxPlays
  quality profile  "Lossless"       flag --quality-profile
  max proposals    25 per decision  config policy.rules.rating-quality-upgrade.maxProposals
```

### Legacy absolute plays versus opt-in recency

`--max-plays` is always an **absolute lifetime play ceiling**. If
`policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed` is unset, its resolved value is
`null` and sync-ratings retains the legacy absolute-play-only decision. Set the config key to a
whole number from **1 through 36,500** to require the latest trustworthy Plex view to be at least
that many 86,400-second days old at the captured evaluation instant.

The thresholds are conjunctive. `--max-plays 0` still means "zero plays ever" and prevents a viewed
artist from qualifying, however old its view is. Use a higher `--max-plays` or configured
`maxPlays` only when old, previously viewed artists are intentionally in scope.

A never-viewed artist has no `lastViewedAt`, so recency-enabled evaluation refuses it with
`no-recency-coverage` rather than calling it old. A played row without a timestamp makes the whole
artist bucket `partial-recency-coverage`, even if another row has a timestamp. Zero-play rows may
omit the field without poisoning otherwise complete recency evidence.

### Play totals are a weak normalized-name rollup

Plex tracks carry the **album** artist as a string with no artist id, so play totals and latest-view
timestamps are bucketed under one normalized artist name, not an id join. Every resulting
observation reports `join: normalized-name`. The rollup fails closed in these ways:

| Gap or poisoning           | Cause                                                   | Result                                                     |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| `sentinel-artist-name`     | Tracks fell into the `"Unknown Artist"` sentinel bucket | The bucket is discarded, not credited                      |
| `ambiguous-name-join`      | Two distinct Plex ids normalize to the same name        | Play and recency evidence are refused for both             |
| `no-consumption-coverage`  | The artist's name has no track coverage at all          | Refused; the artist is never read as zero plays            |
| `no-recency-coverage`      | Every joined track omits `lastViewedAt`                 | A configured recency gate refuses rather than guessing     |
| `partial-recency-coverage` | A played joined track omits `lastViewedAt`              | The artist is refused even if another timestamp is present |

Two consequences follow directly. A performer you only hear on compilations reads as zero plays and
no latest view under their own name, because every compilation track credits its album artist. And
a library-wide play total of exactly zero makes the monitoring rule refuse wholesale with
`consumption-signal-empty` — almost always a token whose Plex account is not the listening account.
The timestamp has the same resolved-account scope. Check the `Coverage` block's `plays observed`
and the recency evidence under `--explain` before acting on a proposal.

For a recency-enabled decision, `--explain` shows the raw epoch-seconds `lastViewedAt` observation
with its `normalized-name` join, followed by a stable ISO `older-than-days` check, integer day bound,
and exact `policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed` path. Computed age may
appear in summary prose but is not evidence.

### Unrated is not zero-rated

Plex native `0` and an absent `userRating` both mean **UNRATED**, which is no signal, never a low
rating. An unrated artist is skipped with `signal-unavailable`, never proposed and never punished.
Ratings are not aggregated from tracks or albums: the artist's own `userRating` is the signal, joined
by exact Plex id.

## Safety Gates

Four gates run inside the projection, per selected decision, in this order. The first three produce
**refusals**, which are data; the fourth throws.

| Code                      | Scope    | Fires when                                                          | Remedy it names                                                |
| ------------------------- | -------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `decision-disabled`       | decision | `policy.rules.<id>.enabled` is explicitly `false`                   | `policy.rules.<id>.enabled`                                    |
| `rule-not-evaluated`      | decision | The rule skipped wholesale; carries its `skipReason` and detail     | — (the detail names the cause)                                 |
| `cross-decision-conflict` | artist   | One artist is proposed by **both** decisions; dropped from **both** | `policy.rules.stale-monitoring-cleanup.protectRatingAtOrAbove` |

`rule-not-evaluated` is deliberately a **per-rule** gate, not a whole-report one. Any rule's evaluator
skip marks the whole report `degraded`, so a report-level gate would let one unrelated rule block a
perfectly healthy cohort — and the per-rule gate is what carries `consumption-signal-empty` or the
available-profile list to you verbatim.

`cross-decision-conflict` is reachable in practice: with `--min-stars 4` and
`protectRatingAtOrAbove: 5`, a four-star zero-play artist draws a profile upgrade **and** an
unmonitor. The two artifacts apply independently with no ordering guarantee, so sealing both is
incoherent; the artist is withheld from both cohorts and the refusal names the threshold to change.

Conflicts occur exactly while an artist's rating falls in the half-open band
`[--min-stars, protectRatingAtOrAbove)`, so the band is empty only once
`protectRatingAtOrAbove` is at or below `--min-stars`. **Close** the gap to resolve them: in the
example above, set `protectRatingAtOrAbove: 4` (or raise `--min-stars` to `5`). Widening the gap
enlarges the band and withholds more artists.

A refused decision still appears in `cohorts` with `gate: "refused"` and an empty change list. A
cohort silently missing an artist would be indistinguishable from a bug, so refusals are never
omissions.

### Engine invariants throw

The fourth gate raises `SyncRatingsProjectionError` and ends the run rather than shrinking an
artifact. It fires when a proposal carries no `subject.artistId`, when a monitoring proposal's
`after["monitored"]` is not a boolean, when a profile proposal's `after["qualityProfileId"]` is not a
number, when two profile proposals in one cohort name different target ids, or when the resolved
policy carries no numeric `resolvedProfileId` behind a non-empty profile cohort.

Each means the policy engine changed underneath this command. Quietly dropping the proposal would
seal the wrong artists, and a cohort is what becomes a mutation.

### Four independent mutation gates

Any one of these stops a mutation:

1. **Mode.** `--mode apply` is the only way to reach the apply lifecycle at all. Under `recommend` no
   producer and no apply is called; under `plan` no apply is called.
2. **Interactive-approval assertion.** Without `--yes`, any machine output format or a
   non-interactive stdout fails with `MissingRequiredArgumentError` — checked **before** the lazy
   action import, so a refused run spends no Plex drain.
3. **Per-artifact confirmation.** Without `--yes` on a TTY, each sealed artifact is first applied
   with `dryRun: true, approved: false` and the review is rendered for confirmation. A dry run
   acquires no claim and writes no history. A declined prompt leaves that artifact sealed and
   unapplied.
4. **Apply's own gate.** The shipped apply lifecycle hard-throws when a real apply is requested
   without explicit approval, independently of everything above.

### Caps, footprint, and pinning

- The cohort cap is `--max-proposals` (per rule, ceiling `100`), and `maxBatch` is bound to the exact
  cohort size — never defaulted — so a large approved cohort cannot fail after the drain.
- `result.footprint` reports `changedArtists` over `coverage.authoritativeLinks` as a fraction
  rounded to four decimals. It is **reported, never a gate**: a hard ceiling would refuse legitimate
  first runs, and the absolute cap already bounds the blast radius.
- Every apply pins both `--expected-plan-id` and `--expected-plan-checksum` from the artifact just
  written, so an artifact swapped, regenerated, or truncated between seal and apply fails loudly
  instead of applying the wrong desired state.
- Idempotency is inherited: converged artists never enter a cohort, the producers re-read fresh live
  Lidarr state at seal time, and an already-desired entry is recorded as `satisfied` at apply time.
  Re-running after a successful apply yields `already-converged` skips and zero artifacts.

## Output Schemas

Human output goes to **stderr**; machine output goes to **stdout**, so `--output json | jq` stays
usable. Detail sections show at most 20 rows by default; `--verbose` shows every cohort row and every
refusal.

The human report is, in order: a header with both origins and the mode, the four flag-capable
thresholds with
their provenance, coverage and footprint, the per-decision verdict table, the always-visible
`Overrides` section, one block per cohort, the refusals, every sealed artifact, and a next-steps
block. Under `--mode plan` and `--mode apply` each artifact's path is rendered **the moment it is
sealed**, before the next producer runs. Human tables may shorten fingerprints as recognition aids;
`--explain` prints the full expected/current hashes and stale recovery.

JSON and YAML write one prose-free document:

```json
{
  "command": "lidarr-sync-ratings",
  "result": {
    "schema": "rfmedia.lidarr-ratings-sync.v1",
    "mode": "recommend",
    "decisions": ["quality-profile", "monitoring"],
    "thresholds": {
      "minStars": {
        "value": 4.5,
        "source": "flag",
        "configPath": "policy.rules.rating-quality-upgrade.minRating"
      },
      "maxPlays": {},
      "qualityProfile": {},
      "maxProposals": {}
    },
    "cohorts": [],
    "refusals": [],
    "footprint": { "authoritativeLinks": 412, "changedArtists": 17, "fraction": 0.0413 },
    "outcomes": [],
    "evaluation": {},
    "decisionStates": { "quality-profile": "unset", "monitoring": "off" }
  }
}
```

Structural guarantees a `--json` consumer may rely on:

- **Every selected decision appears in `cohorts` exactly once**, with `gate` one of `sealable`,
  `refused`, or `no-changes`. Key on decisions without probing.
- `cohorts[].artistIds` is ascending and deduplicated, and is empty unless `gate === "sealable"`.
- `refusals` is ordered by refusal-code declaration order, then `artistId` ascending. A
  decision-scoped refusal carries `artistId: null`; the cross-decision refusal carries
  `decision: null`.
- `outcomes` carries 0-2 entries in producer declaration order — `artist-profile-assignment` first,
  then `artist-monitoring` — and an entry's `apply` field is **absent** unless that artifact was
  actually applied.
- `evaluation` is the verbatim, deep-frozen `rfmedia.lidarr-consumption-policy.v3` report the
  projection read. It is not byte-identical to a standalone `policy evaluate` run — `evaluatedAt` is
  stamped per run and the threshold overrides mutate the echoed resolved policy — but every decision
  in `cohorts` traces to it.
- The outer sync schema remains `rfmedia.lidarr-ratings-sync.v1`. Its embedded evaluation is v3;
  sealed producer artifacts remain `rfmedia.lidarr-plan.v3`.
- `decisionStates` is the **raw** `policy.rules.*.enabled` tri-state; `evaluation.policy.rules[id]
.enabled` is not, and must not be read as decision state.
- The envelope excludes credentials, raw provider records, and response bodies. Failures use the
  standard redacted Lidarr error envelope,
  `{ "command": "lidarr-sync-ratings", "error": { … } }`.

`--output csv` projects the **embedded evaluation** through the shipped policy CSV schema rather than
inventing a second flat schema for the same decisions: the columns, the `rowType` discriminator, and
the JSON-encoded compound cells are exactly those documented under
[Output Schemas](lidarr-consumption-policy.md#output-schemas) for `policy evaluate`. Proposal and
override rows retain full fingerprints, override rows retain rationale and lifecycle state, and the
shared CSV formatter guards formula-looking rationale cells.

### Decision keys and `--explain`

Keys come from the embedded evaluation, so they are identical to the keys `policy evaluate` prints
and are stable across runs — editing a threshold does not invalidate a key you just read.

| Decision | Key format                              | Example                                                       |
| -------- | --------------------------------------- | ------------------------------------------------------------- |
| Proposal | `<ruleId>:artist:<lidarrId>`            | `rating-quality-upgrade:artist:41`                            |
| Skip     | `<ruleId>:artist:<lidarrId>:<skipCode>` | `stale-monitoring-cleanup:artist:999:no-consumption-coverage` |

A skip key carries the skip code as a fourth segment; a proposal key never does. Configured override
keys remain explainable after their proposals are withheld. `--explain` is validated on **every** run
and in **every** format — an unknown key fails with a lookup error listing the keys the report
actually carries — but it only changes what is **rendered** under human output. Under
`--output json|yaml|csv` the full envelope is emitted and the selection is discarded, because a
machine consumer already holds every decision's evidence.

Override recovery depends on the stale reason. For `evidence-changed`, review the full current
proposal and replace the fingerprint only if suppression is still intended, or remove the record.
For `outcome-changed`, keep the real skip visible and update only if a proposal later returns. For
`decision-absent`, investigate identity/convergence and remove the entry only if obsolete; there is
no current hash to copy. `NOT EVALUATED` means rerun with the rule enabled and selected before
changing the record.

## Exit Behavior

Only exit codes `0` and `1` exist. The command sets `process.exitCode` and never calls
`process.exit()`.

- Exit `0` means a report was produced. Refusals, skips, coverage gaps, and cohorts that sealed
  nothing are report data, not failures.
- Exit `1` covers invalid options (an unknown `--decision` or `--mode`, a `--decision` carrying no
  kind, `--min-stars` outside 1-5, `--max-plays` outside 0-1000000, `--max-proposals` outside 1-100,
  a missing `--quality-profile` target, an `--explain` key no decision owns), a missing `--yes` under
  machine output or a non-interactive stdout, a provider failure, a producer failure, an engine
  invariant violation, and cancellation.
- Exit `1` also results when any applied artifact reports `status: "failed"` or `"partial"`.

The apply gate is applied **after** all rendering, so you always see the evidence behind a failing
run.

## Safety and Follow-Up Boundaries

`--mode recommend` performs zero writes. That branch never calls a producer and never calls apply:
no plan writer, history appender, or plan claim is reachable from it. The only filesystem write on
that path is the pre-existing observational `bridge_identity_snapshots` replacement performed inside
the reused reconcile read path — exactly what `policy evaluate` already does.

**Nothing is ever written to Plex**, on any rung. Rating writes back to Plex belong to a separate,
unshipped issue.

Policy provenance lives in the sync report and **never** in a plan artifact. The sealed v3 envelope
is frozen at an exact key set, so a `policy`, `ruleId`, or `rationale` field on an artifact is
structurally impossible. Capture provenance with `--output json` instead — the threshold sources,
every check's `configPath`, and the entire embedded evaluation are all in there.

Overrides govern new evaluations and same-run projections only. Creating one does not revoke or
rewrite an already sealed artifact, which remains eligible or ineligible according to its own
origin, plan ID, checksum, drift, confirmation, claim, and apply checks. Remove an obsolete sealed
artifact deliberately if it must no longer be applied.

`rfmedia lidarr policy evaluate` remains strictly read-only and unchanged: evaluation proposes, it
never applies. This command is the gated apply lane for the same two rules on identical decision
keys, and its gating is the `--mode` ladder above, not a relaxation of that property.

### Partial failure is ordered, not atomic

Artifacts are sealed one at a time in producer declaration order. If the second producer throws —
an artist deleted between evaluation and seal, or an artist whose current profile no longer exists —
the first artifact **remains on disk**. It is inert: it has mutated nothing, it is checksum-sealed,
and its path was already rendered to you by the time the next producer ran. The error routes through
the redacted failure envelope and sets exit `1`.

Recovery is the shipped apply lifecycle, with the pins the report printed:

```bash
rfmedia lidarr apply ~/.config/rfmedia/plans/lidarr-<stamp>-<id8>.json --yes \
  --expected-plan-id <id> --expected-plan-checksum <checksum>
```

Apply failures do **not** throw. A failed or partial apply returns a structured result the presenter
renders with a copy-pasteable `--resume` recovery command, and the exit gate sets `1`.

## Troubleshooting

| Symptom                                                                                    | What it means and what to do                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monitoring` refused with `rule-not-evaluated` / `consumption-signal-empty`                | The library-wide play total is zero. Almost always a token whose Plex account is not the listening account. Re-run with the listener's token; do not act on the report until `plays observed` looks right                                       |
| `plays observed` is far below your real listening history                                  | A partially wrong account, or a second listener. Nothing detects this automatically. Every monitoring proposal is suspect until it looks right                                                                                                  |
| A run threw mid-way and one artifact is sealed but unapplied                               | Sealing is ordered, not atomic. The artifact is inert and its path was already printed. Apply it deliberately with `rfmedia lidarr apply <path> --yes`, or delete it                                                                            |
| The profile producer threw `Unknown profile reference` on an artist you were not upgrading | The producer re-resolves **every** cohort artist's **current** profile against the live list. An artist whose current profile was deleted in Lidarr fails the whole seal. Fix or reassign that artist in Lidarr, then re-run                    |
| The applied profile is not the one you named                                               | `--quality-profile` resolves numeric ids **before** names, so a profile named `"320"` resolves to profile id 320. Check the `(profile id N)` pair in the cohort header before approving                                                         |
| `quality-profile` refused, and the detail lists profile names                              | The value matched no live profile. Pick one of the listed names, or set `policy.rules.rating-quality-upgrade.targetQualityProfile`                                                                                                              |
| `--quality-profile is required …`                                                          | The quality-profile decision is selected and no target exists. Pass `--quality-profile`, set `policy.rules.rating-quality-upgrade.targetQualityProfile`, or run `--decision monitoring`                                                         |
| A decision is refused with `decision-disabled`                                             | That rule is explicitly `enabled: false` in `.rfmedia.yaml`. The refusal names the exact key. Leaving the key **unset** runs the decision; only an explicit `false` refuses                                                                     |
| An override reports `STALE — REVIEW REQUIRED`                                              | Read its stale reason and run `--explain <key>`. Replace the fingerprint only for reviewed current proposal evidence; outcome-changed/decision-absent may have no current hash, so follow their recovery guidance or remove an obsolete record  |
| An override reports `NOT EVALUATED`                                                        | Its rule did not run. Enable/select the rule and rerun before changing the record; do not copy or invent a fingerprint                                                                                                                          |
| An artist you expected is missing, with a `cross-decision-conflict` refusal                | Both decisions proposed it, so it was withheld from both. Close the gap by setting `policy.rules.stale-monitoring-cleanup.protectRatingAtOrAbove` at or below `--min-stars` (or raising `--min-stars` to it), or run one `--decision` at a time |
| `--max-proposals 10` produced 20 changes                                                   | It is a per-rule cap, not a run total: up to 10 per decision. Use `--decision` to narrow to one                                                                                                                                                 |
| A recently added artist is proposed for unmonitoring                                       | Legacy absolute-play-only behavior is active because `minDaysSinceLastViewed` is unset. Configure it to refuse missing/recent recency, or keep using `minTrackFileCount` and review-only mode                                                   |
| Monitoring is refused with `no-recency-coverage`                                           | Every joined track lacks `lastViewedAt`; the artist may be never viewed or the resolved Plex credential may not see that account's history. Missing evidence is never treated as ancient                                                        |
| Monitoring is refused with `partial-recency-coverage`                                      | At least one played joined track lacks `lastViewedAt`. Fix the Plex/account evidence or keep the refusal; another timestamp cannot make the partial artist bucket trustworthy                                                                   |
| A compilation-only artist is proposed for unmonitoring                                     | Plays credit the **album** artist, so compilation listening never reaches the performer's own bucket. Not detectable here                                                                                                                       |
| `--yes is required for non-interactive or machine-output apply`                            | `--mode apply` under `--output json`, or with a non-TTY stdout, must be explicit. Add `--yes`, or drop back to `--mode plan` and apply the artifacts separately                                                                                 |
| `--explain <key>` reports an unknown key                                                   | Keys are stable but per-report. Copy the key from the current run's rows; a skip key ends in its skip code and only prints under `--verbose`                                                                                                    |
| `--explain` printed the whole report instead of one decision                               | You were in a machine format. `--explain` only changes human rendering; `--output json\|yaml\|csv` always emits the full envelope                                                                                                               |
| The run is slow                                                                            | Every rung pays for a full evaluation, including the whole-library track drain. Set `plex.cache.enabled: true` in `.rfmedia.yaml` before running repeatedly; `--decision` does **not** reduce the drain                                         |
| A `SyncRatingsProjectionError` was raised                                                  | An invariant the policy engine guarantees was violated, so the run ended instead of sealing a partly wrong cohort. This is a bug report, not a configuration problem                                                                            |

## Related Documentation

- [Lidarr Consumption Policy](lidarr-consumption-policy.md)
- [Plex-Lidarr Reconciliation](plex-lidarr-reconciliation.md)
- [Lidarr Plan and Apply](lidarr-plan-apply.md)
- [Lidarr Quality Presets](lidarr-quality-presets.md)
- [Plex Configuration](plex-configuration.md)
