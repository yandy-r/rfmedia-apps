# UX Research: Plex-Lidarr Identity Mapping

_Research date: 2026-07-27. Repository behavior was inspected in the issue #207 worktree. External
guidance was checked on the same date._

## Executive Summary

Issue #207 should ship as a typed, read-only identity and expansion-evidence foundation, not as the
reconciliation command from #208 or the consumption-policy workflow from #209. No existing public
`bridge` command was found. The UX contract therefore belongs first in result types, JSON
projections, and reusable terminal presenters that later commands can call without changing the
meaning of a mapping.

The central user-facing rule is:

> Exact typed MBID evidence may resolve automatically. A name-derived score may suggest a target,
> but only an explicit review decision naming the target MBID may turn it into a durable mapping.

Every result needs two independent dimensions:

- **identity state**: `resolved`, `suggested`, `ambiguous`, `unmatched`, `conflict`, or
  `unavailable`;
- **observation provenance**: live or cache, online or offline, fresh or stale, complete or
  degraded.

These dimensions must not be collapsed into a `matched: boolean`. In particular, `unmatched` means
a complete applicable candidate set was searched and no candidate qualified; `unavailable` means
the program lacked enough evidence to decide, such as an offline cache miss. Likewise, a resolved
offline mapping can be useful for analysis while still being ineligible to authorize a Lidarr
mutation.

Human output should optimize for review: state, source entity, proposed target, method, evidence,
freshness, and next action. A fuzzy score must be labeled `score 0.94`, never `94% confidence` or
`94% certain`. Ambiguous rows need a stable bounded candidate list and must never select the first
candidate by response order. Machine output needs a versioned schema, stable enum values, complete
provenance, deterministic ordering, and no prose parsing requirement.

Expansion UX is also evidence-first in #207. The mapping layer should calculate and seal distinct
source-track, target-album, and estimated target-track counts plus a track expansion ratio. It
should not choose an action or prompt on its own. A later action presenter must show that evidence
immediately before approval, default to No, and block non-interactive action when the evidence is
missing, unresolved, stale-only, or offline-only.

The existing repository supplies the right conventions:

- prompts write to stderr and `[y/N]` defaults to No;
- machine formats emit one structured document on stdout;
- machine or non-TTY apply requires `--yes`;
- stale Lidarr data is opt-in through `--allow-stale` and carries `source`, `fetchedAt`, and
  `ageSeconds`;
- mutation plans are reviewed, revalidated, and applied separately.

**Confidence**: High. The issue, roadmap, linked research, current prompt/output/cache code, and
existing plan/apply presenter all agree on a read-only, fail-closed foundation. Confidence is
Medium on the proposed `unavailable` state because it is a new product-level distinction, although
it prevents a materially misleading offline “no match.”

## User Workflows

### Consume an exact live mapping

The common successful path is one typed Plex MusicBrainz GUID matching one same-kind Lidarr MBID.
The library result should be immediately usable for read-only analysis and durable cache refresh:

```text
Plex-Lidarr Identity

STATE     PLEX ARTIST      LIDARR ARTIST    METHOD      EVIDENCE       FRESHNESS
resolved  Massive Attack   Massive Attack   exact-mbid  artist MBID    live · fresh

MBID: 10adbe5d-6b17-4be1-99a9-2ffc3b2d555c
Validated: 2026-07-27T14:03:12Z
Next: available for read-only comparison; revalidate by MBID before any Lidarr change
```

The display name is comprehension evidence, not identity. Full typed MBID and scope remain in the
structured result even when a terminal table abbreviates other fields.

**Confidence**: High. MBID-first resolution is the issue's explicit requirement and matches
current Lidarr projections.

### Inspect a name-derived suggestion

When there is no conclusive typed MBID, a unique normalized/fuzzy candidate may be returned as a
suggestion:

```text
STATE      PLEX ARTIST        LIDARR ARTIST       METHOD  EVIDENCE
suggested  National, The      The National        fuzzy   score 0.96 · margin 0.11

Not saved as resolved: name-derived matches require explicit review.
Target MBID: 69ee3720-a7cb-4402-b48d-a02c366f2bcf
```

The result must include the scoring and normalization versions, the winning score, runner-up
score, margin, and the same-kind candidate context used. `score` is a ranking metric, not a
calibrated probability. #207 may expose a typed review-decision input for later consumers, but
without a public review surface it must not silently persist this suggestion as resolved.

**Confidence**: High for review-before-persistence and score disclosure. Medium for exact terminal
wording.

### Inspect an ambiguous candidate set

Ambiguity is a successful identity-analysis outcome, not a transport failure:

```text
Ambiguous Plex artist: "Sparks"

RANK  LIDARR ARTIST  DISAMBIGUATION          MBID                                  SCORE
1     Sparks         US pop-rock duo         1f43d76f-...                           0.97
2     Sparks         UK electronic artist    22c3fd89-...                           0.96

No mapping selected: the leading margin (0.01) is below the required 0.05.
Next: review an exact target MBID or correct the source metadata.
```

Ordering should be deterministic: descending score, then canonical typed MBID. Rank is
presentation-only and must never become the stored decision key. If a future interactive reviewer
is added, its choices should be exact candidates plus `leave unresolved` and `cancel`; pressing
Enter must never accept rank 1.

**Confidence**: High. This follows the linked research and avoids response-order identity.

### Distinguish unmatched from unavailable

These states require different recovery:

```text
unmatched
  Complete live artist candidate set searched; no candidate met the minimum score.
  Next: correct metadata or provide an exact typed MBID.

unavailable
  Offline cache contains no compatible mapping for this Plex item.
  No live candidate search was attempted.
  Next: rerun online to refresh identity evidence.
```

An offline cache miss must not say “no Lidarr match,” because no complete Lidarr search occurred.
Likewise, a malformed/unsupported Plex GUID may coexist with a name-derived suggestion, but it must
remain visible as evidence rather than being silently discarded.

**Confidence**: High for the semantic distinction; Medium for adding `unavailable` to the state
union rather than representing it as a reason code on `unmatched`.

### Use cached evidence during an outage

An online consumer should prefer live evidence. It may use stale fallback only after explicit
consent from the calling command, following the existing `--allow-stale` convention. Deliberate
offline execution must perform zero Plex, Lidarr, or MusicBrainz requests.

```text
Warning: identity evidence is from the local cache; live validation was not performed.

STATE     METHOD          SOURCE  AGE       LAST VALIDATED          MODE
resolved  fuzzy-reviewed  cache   18 days   2026-07-09T09:20:11Z   offline

Read-only analysis only. This evidence cannot authorize a Lidarr mutation.
```

The warning must be textual, not color-only. A cache age is computed at read time. The result also
needs the source fingerprint and algorithm versions so an offline consumer can determine why a row
was or was not compatible.

**Confidence**: High. The repository already has explicit stale consent and structured cache age;
zero-network offline behavior is required by the issue-linked research.

### Review expansion evidence downstream

Issue #207 should provide a reusable `ExpansionEvidence` result. It should not infer monitoring, search,
download, profile, or deletion intent. A later workflow that already has an exact reviewed action
can render:

```text
Track-to-album expansion

3 distinct Plex signal tracks map to 2 Lidarr albums containing an estimated 24 tracks.
Track expansion: 8.0x
Action: monitor 2 albums; may search for missing releases
Evidence: live · observed 2026-07-27T14:05:03Z

Proceed with this reviewed album-level action? [y/N]
```

The raw counts must always accompany the ratio. Show per-artist expansion before the aggregate so
one extreme artist cannot be hidden by a low overall ratio. Crossing from track evidence to an
album action requires confirmation even at `1.0x`; the dimensional change, not an arbitrary
threshold, creates the risk.

When track totals are incomplete:

```text
Track expansion: unknown
Reason: 2 of 5 target albums have no complete track statistics.
Action blocked: refresh target evidence before applying.
```

JSON should use `trackExpansionRatio: null`, not `0` or the string `"unknown"`, and include
`trackCountStatus` plus `missingEvidence`.

**Confidence**: High for counts, ratio, provenance, and fail-closed behavior. Medium for using JSON
`null`; it is the cleanest stable machine representation but should be reconciled with final type
conventions.

## CLI UX Best Practices

### Preserve the issue boundary

- Do not add a public reconciliation report in #207; that belongs to #208.
- Do not select consumption policy, monitoring, search, download, or quality actions; those belong
  to #209 and existing mutation plan/apply lanes.
- Do not prompt merely because a mapping is suggested. A library/domain function must be
  deterministic and non-interactive.
- Provide result types and presenter-ready evidence so a future public command does not need to
  reinterpret scores, freshness, or expansion counts.
- Until an explicit review surface exists, persist automatic exact-MBID mappings only. A
  name-derived result remains `suggested` or `ambiguous`.

**Confidence**: High. The roadmap orders #207 before #208 and #209, and no current public bridge
command exists.

### Human terminal contract

Use one summary followed by bounded detail:

```text
Plex-Lidarr Identity Summary
214 examined · 173 resolved · 8 suggested · 5 ambiguous · 21 unmatched · 2 conflict · 5 unavailable
Evidence: live 201 · cached 13 · stale/offline 13
```

- Sort states by source-library order for traceability, with candidates deterministically ranked
  inside each row.
- Keep state, source name, target name, method, MBID, freshness, and next action visible without
  `--verbose`.
- Truncate display names by terminal display width, never MBIDs or reason codes. Preserve full
  values in structured output.
- Group repeated problems under one explanation and show row-specific identifiers underneath.
- Human tables, warnings, progress, and prompts go to stderr, matching current rfmedia behavior.
- Never encode state only through color. Respect non-TTY color suppression, `NO_COLOR`, and
  `TERM=dumb`.
- Reject or safely escape terminal controls and bidirectional controls in provider text.
- If detail is truncated, say exactly how many rows were omitted. Never make a truncated report
  look complete.

**Confidence**: High. These rules match current repository presenters and the living
[Command Line Interface Guidelines](https://clig.dev/) (accessed 2026-07-27), which recommend
stdout/stderr separation, TTY-aware presentation, non-color cues, and bounded, actionable output.

### Machine-readable contract

Recommended envelope:

```json
{
  "schemaVersion": "plex-lidarr-identity.v1",
  "operation": "resolve-identities",
  "scope": {
    "plexServerScope": "sha256:...",
    "plexLibraryId": "7",
    "lidarrOrigin": "http://lidarr:8686"
  },
  "mode": "offline",
  "summary": {
    "examined": 1,
    "resolved": 1,
    "suggested": 0,
    "ambiguous": 0,
    "unmatched": 0,
    "conflict": 0,
    "unavailable": 0,
    "complete": true
  },
  "mappings": [
    {
      "source": {
        "kind": "artist",
        "plexItemId": "123",
        "name": "Massive Attack"
      },
      "state": "resolved",
      "target": {
        "kind": "artist",
        "lidarrId": 42,
        "mbid": "10adbe5d-6b17-4be1-99a9-2ffc3b2d555c",
        "name": "Massive Attack"
      },
      "resolution": {
        "method": "exact-cache",
        "reviewStatus": "not-required"
      },
      "provenance": {
        "source": "cache",
        "executionMode": "offline",
        "freshness": "stale",
        "degraded": true,
        "complete": true,
        "lastValidatedAt": "2026-07-09T09:20:11.000Z",
        "ageSeconds": 1576800
      },
      "nextAction": "refresh-online-before-mutation"
    }
  ],
  "execution": {
    "outcome": "succeeded",
    "networkRequests": 0
  }
}
```

Contract rules:

- Use stable snake-free field names consistent with current TypeScript/JSON output and fixed enum
  strings.
- Keep identity state separate from provenance and completeness.
- Use entity-typed MBIDs; UUID text alone is not sufficient.
- Candidate records include stable rank, target MBID, names/disambiguation, score, runner-up
  margin, scoring version, and normalization version.
- Omit inapplicable optional fields. Use explicit `null` only when unknown is itself required
  evidence, such as an expansion ratio that cannot be computed.
- `summary.complete` describes whether all requested source rows were evaluated with applicable
  evidence, not whether they all resolved.
- Exact origin values must be canonical and credential-free. Prefer an opaque/hash scope for the
  Plex server rather than exposing credentials or credential-bearing URLs.
- JSON/YAML should share the same data model. If CSV support is later required, use typed summary,
  mapping, and candidate rows; do not stringify nested evidence into one cell.
- Emit one complete machine document on stdout. Diagnostics and stale warnings stay on stderr and
  never inject ANSI into the document.
- Human rendering may evolve inside v1; removal, rename, enum/meaning change, or record-shape change
  requires a new schema version.

**Confidence**: High for a versioned, parseable evidence contract. Medium for the exact envelope
and version string, which are implementation decisions.

### State, method, and review vocabulary

| Field           | Recommended values                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `state`         | `resolved`, `suggested`, `ambiguous`, `unmatched`, `conflict`, `unavailable`                   |
| `method`        | `exact-mbid`, `exact-cache`, `normalized-name`, `fuzzy`, `fuzzy-reviewed`, `manual-reviewed`   |
| `reviewStatus`  | `not-required`, `required`, `accepted`, `rejected`, `superseded`                               |
| `source`        | `live`, `cache`                                                                                |
| `executionMode` | `online`, `offline`                                                                            |
| `freshness`     | `fresh`, `stale`, `unknown`                                                                    |
| `nextAction`    | Stable codes such as `none`, `review-target-mbid`, `refresh-online`, `correct-source-metadata` |

Human labels may use spaces and punctuation, but JSON must use these stable codes. Do not infer
review from a high score. Do not reuse `confidence` for similarity unless a future calibrated
probability model is actually introduced.

**Confidence**: High for separate vocabularies; Medium for exact enum spelling.

### Non-interactive safety

- The mapping library never prompts.
- Machine output, piped input, and non-TTY execution never select a fuzzy candidate.
- `--yes`, when used by a future consumer, may approve a fully reviewed sealed action but may not
  accept a suggestion, break an ambiguity, waive stale/offline evidence, or invent a missing MBID.
- An explicit machine review input must name the exact source scope/item and target typed MBID,
  ideally inside a sealed artifact. A rank or free-form target name is insufficient.
- Unresolved identity rows are normal report data. Execution failures remain nonzero errors.
- A future strict reporting mode may fail on selected states, but default exit semantics should not
  make `unmatched` indistinguishable from a transport error.
- SIGINT during a future interactive reviewer exits promptly without writing a decision. Pressing
  Enter never chooses rank 1.

**Confidence**: High. This follows current rfmedia apply guards and general CLI automation safety.

## Error Handling

| Condition                                       | Human behavior and recovery                                                              | Machine behavior                                                     | Exit |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---- |
| Invalid scope, kind, or MBID                    | State expected syntax; perform no cache/network I/O.                                     | Typed validation error; omit secrets/raw provider bodies.            | 1    |
| Exact live match                                | Render `resolved`, method, typed MBID, freshness, next step.                             | Normal result row.                                                   | 0    |
| Complete search, no qualifying candidate        | Render `unmatched`; suggest metadata correction or exact MBID.                           | Normal `unmatched` row with threshold/version evidence.              | 0    |
| Offline cache miss                              | Render `unavailable`; state that no live search occurred.                                | Normal row with `complete:false`, `networkRequests:0`.               | 0    |
| Unique fuzzy suggestion                         | Render score and margin; state “review required; not saved.”                             | `suggested`, candidate evidence, no durable resolution.              | 0    |
| Multiple/tied/close candidates                  | Render bounded stable candidates and required margin.                                    | `ambiguous` with candidates; never choose rank 1.                    | 0    |
| Conflicting Plex MBIDs or duplicate target MBID | Render conflict sources; names cannot override; suggest metadata repair.                 | `conflict` row with redacted evidence/reason codes.                  | 0    |
| Explicit review targets conflicting MBID        | Refuse decision; show exact conflicting identities.                                      | Typed conflict error.                                                | 1    |
| Online provider unavailable, no allowed cache   | Name Plex/Lidarr/metadata domain; suggest health, retry, or explicit offline/stale path. | Typed failure with lane, retryability, attempts, and retry timing.   | 1    |
| Explicit stale fallback succeeds                | Warn once with source time/age; mark read-only.                                          | Success with cache provenance and degradation.                       | 0    |
| Cache row corrupt or unknown schema             | Quarantine/ignore row; online may continue live, offline reports unavailable.            | Per-row reason; DB-wide unreadability is a typed failure.            | 0/1  |
| Scoring/normalization version changed           | Re-evaluate online; offline result unavailable until refresh.                            | Stable incompatibility reason, never reinterpret old score silently. | 0    |
| Live result succeeds but cache write fails      | Preserve result; warn it is not durable and give retry path.                             | Success with `persistence.status:"failed"` and redacted reason.      | 0    |
| Expansion evidence incomplete                   | Show unknown count/ratio and missing evidence; block later action.                       | `trackExpansionRatio:null`, status, missing fields/reasons.          | 0    |
| Future action attempted with unsafe evidence    | Refuse before mutation; request online refresh/re-review/new plan.                       | Typed precondition/staleness failure.                                | 1    |
| User chooses “leave unresolved”                 | Confirm no decision was saved; continue review/report.                                   | Normal unresolved outcome.                                           | 0    |
| SIGINT                                          | Stop promptly; no partial decision write.                                                | No success document; conventional interrupted process status.        | 130  |

Identity conflicts are data when discovered during a scan, so the scan can report all problems in
one pass. The same conflict becomes an execution error when a caller explicitly tries to accept or
act through it. This distinction keeps reports useful without weakening mutation gates.

**Confidence**: High for failure/domain-outcome separation and recovery text. Medium for exact exit
code `130` because the current CLI should be checked for global signal handling before it becomes a
formal contract.

## Performance UX

### Phase-level progress

Large music libraries can make an apparently idle command feel broken. Report bounded phase-level
progress only on an interactive stderr:

```text
Reading Plex artists... 214
Reading Lidarr artists... 198
Resolving exact MBIDs... 173 resolved
Scoring 41 unresolved names... 8 suggestions, 5 ambiguous
Saving 173 exact mappings... done
```

Do not print one line per item by default and do not use an animation in machine/non-TTY output.
If a phase retries, name the provider and attempt rather than restarting a spinner without context.

**Confidence**: High. This follows repository progress/output conventions and CLI guidelines.

### Make the fast path visible but not noisy

- Build exact typed-MBID indexes once, making the normal join linear in source plus target rows.
- Run fuzzy comparison only for unresolved, same-kind, context-bounded candidates.
- Fetch detail only when bulk projections omit required identity evidence.
- Use one atomic cache transaction for a completed batch so partial termination does not present a
  half-refreshed snapshot as coherent.
- Human output may truncate detail after a documented limit; structured output must be complete or
  explicitly state truncation and provide a durable full artifact/cursor.
- Report counts after each phase so operators can distinguish slow provider reads from local
  scoring or database persistence.

**Confidence**: High for progressive bounded work; Medium for exact batch/artifact mechanics.

### Offline means zero network

Offline is an execution mode, not merely a stale-cache fallback:

- make zero Plex, Lidarr, MusicBrainz, DNS-probing, health-check, or dynamic-completion requests;
- read only compatible durable mapping evidence;
- never run fuzzy matching against a partial cache and call that a complete search;
- expose `networkRequests: 0`, source, last validation, age, algorithm versions, and source
  fingerprint compatibility;
- keep offline evidence eligible for read-only analysis only;
- require a live exact-MBID/source-scope revalidation before any future mutation.

An online stale fallback differs: it attempted the preferred live path, encountered an eligible
failure, and used cache only because the calling command explicitly allowed it. Preserve that
difference in `executionMode`, degradation reason, and attempts.

**Confidence**: High. This is essential to making “offline” testable and trustworthy.

### Freshness is not correctness

A recent name-derived mapping can be wrong, while an older exact MBID may still identify the same
artist. Report both:

- age/freshness of the observation;
- method and review status of the identity decision;
- source/target fingerprints;
- last successful validation;
- scoring/normalization/schema versions;
- any contradictory live evidence.

Never show a single green “fresh match” badge that hides method or review. A cached reviewed fuzzy
decision becomes stale or conflicted when its source fingerprint changes; it is not silently
rewritten.

**Confidence**: High. This is a core consequence of durable reviewed identity.

## Comparable Patterns

### rfmedia Lidarr resilience and plan/apply

The closest local patterns are stronger than a generic external analogy:

- `packages/rfmedia-cli/src/lib/prompt.ts` writes prompts to stderr and defaults confirmation to
  No.
- `packages/rfmedia-cli/src/commands/lidarr.ts` keeps machine failure envelopes structured and
  attaches stale-cache recovery hints only where applicable.
- `packages/rfmedia-cli/src/types/lidarr-resilience.ts` exposes cache source, fetch time, and age.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts` rejects implicit apply approval
  in non-TTY/machine modes and reviews before prompting.

Issue #207 should reuse these meanings rather than introduce another prompt, cache, or error
vocabulary.

**Confidence**: High. Verified in the current worktree on 2026-07-27.

### Beets matching recommendations

Beets separates strong/medium/no recommendations and uses both a match-distance threshold and a
gap from the next candidate. It also offers “timid” mode that asks about every match. This supports
showing both the winning score and runner-up margin rather than only a top score.

The bridge should be more conservative than Beets: Beets may automatically accept a strong tag
match, while a cross-system fuzzy identity here can later influence album-wide actions. Therefore,
all name-derived bridge matches remain review-required.

Source: [Beets matching configuration](https://docs.beets.io/en/stable/reference/config.html),
current documentation accessed 2026-07-27.

**Confidence**: High for the comparable threshold/gap pattern; High for intentionally declining
auto-acceptance in this higher-blast-radius context.

### Terraform review and drift

Terraform separates plan from apply, supports a saved reviewed plan for automation, and warns that
the remote state can change between planning and final action. The useful analogy is not the exact
file format; it is preserving the reviewed target set while rechecking current state before
mutation.

Issue #207 should therefore seal expansion and identity evidence for downstream review, while the
existing Lidarr plan/apply lane owns live pre-mutation revalidation.

Source: [Terraform `plan` reference](https://developer.hashicorp.com/terraform/cli/commands/plan),
Terraform v1.15.x documentation accessed 2026-07-27.

**Confidence**: High.

### Git porcelain output

Git explicitly distinguishes human-oriented status from a porcelain format guaranteed not to
change incompatibly, and porcelain v2 permits extensible headers that parsers can ignore. The
analogous lesson is to version the identity JSON schema and let human terminal presentation evolve
without becoming an accidental parsing API.

Source: [Git `status` documentation](https://git-scm.com/docs/git-status), last updated for Git
2.53.0 on 2026-02-02; accessed 2026-07-27.

**Confidence**: High.

## Recommendations

1. Ship one provider-neutral typed result model with separate identity state, method/review,
   provenance/freshness, candidates, next action, and optional expansion evidence.
2. Add `unavailable` or an equally explicit epistemic state so offline cache misses cannot be
   mistaken for complete no-match results.
3. Automatically resolve and durably refresh only one-to-one same-kind MBID matches.
4. Return normalized/fuzzy winners as `suggested`, always including score, runner-up score, margin,
   algorithm versions, and exact target MBID.
5. Do not persist a fuzzy suggestion as resolved until an explicit review surface supplies a
   source-bound target MBID. #207 itself should not add an interactive prompt merely to close this
   gap.
6. Version machine output as a stable v1 contract. Keep human tables and warnings on stderr and
   structured output as one clean stdout document.
7. Treat offline as a zero-network mode and stale fallback as a distinct, explicit online
   degradation path.
8. Preserve live analysis if cache persistence fails, but surface that the result is not durable.
9. Provide a reusable expansion-evidence type with raw distinct counts, numeric-or-null ratio,
   completeness, missing evidence, observation time, and live/cache provenance.
10. Keep action selection and prompting outside the mapping library. A downstream action presenter
    must display expansion evidence, default to No, require sealed review plus `--yes` outside a
    TTY, and refuse unsafe identity/freshness states.
11. Test terminal and JSON parity for every identity state, live/fresh, stale fallback, deliberate
    offline, corrupt/incompatible cache, persistence failure, and complete/unknown expansion.
12. If a public mapping/review command is later approved, update Bash, Zsh, and Fish static
    completions together; never perform network-backed dynamic candidate completion.

**Confidence**: High for recommendations 1 and 3-11. Medium for recommendation 2's precise type
shape and recommendation 12's future command placement.

## Testable UX Acceptance Criteria

1. Exact same-kind MBID evidence renders `resolved`; conflicting typed identities cannot be
   overridden by names.
2. Fuzzy output never uses percentage/probability language and always exposes score, margin, and
   versions.
3. Ambiguous candidate order is deterministic and rank is never stored as identity.
4. An offline miss is visibly different from a complete live no-match.
5. Offline fixtures prove zero provider requests and expose `networkRequests: 0`.
6. Stale cache use contains source, age, last validation, mode, and degradation reason in machine
   output plus a non-color-only human warning.
7. Suggested/ambiguous/unmatched/conflict rows do not become durable positive mappings.
8. A live success plus cache-write failure remains a usable read-only result and reports degraded
   persistence.
9. Human output truncation is explicit; JSON is complete or explicitly declares truncation.
10. All untrusted provider names are terminal-safe; machine output contains no ANSI.
11. Expansion uses distinct source tracks and target albums; raw counts accompany every ratio.
12. Zero/incomplete target statistics produce `null` ratio plus a reason, never zero.
13. Mapping code does not prompt or mutate Plex/Lidarr.
14. Any later non-TTY action path requires reviewed evidence and explicit authorization; `--yes`
    cannot resolve identity or waive unsafe provenance.
15. Current Lidarr and Plex command/output behavior remains backward-compatible.

## Open Questions

1. Should `unavailable` be a first-class identity state, or should it be a separate completeness
   state paired with `unmatched`? A first-class state is clearer in terminal output, but a separate
   dimension may produce a cleaner domain model.
2. What supported Plex music-agent fixtures establish the provider scheme and entity typing of
   artist/album/track MusicBrainz GUIDs? This blocks confident user-facing “exact MBID” claims.
3. Does #207 expose any public read-only mapping command, or only library/types consumed first by
   #208? Current repository evidence supports library/types first.
4. Where will an operator explicitly accept, reject, supersede, or invalidate a fuzzy mapping? If
   that surface is deferred, fuzzy results must remain suggestions and must not enter the positive
   cache.
5. Should a reviewed fuzzy decision be reusable indefinitely while fingerprints agree, or should
   it require periodic online review independent of ordinary cache freshness?
6. What terminal detail cap is appropriate for mappings and candidates, and will a complete report
   artifact be written when human output is truncated?
7. Should the v1 machine envelope expose the canonical Lidarr origin, an origin hash, or both?
   Existing outputs expose origins, but topology minimization favors a stable opaque scope.
8. Should incomplete expansion merely block automated apply or all apply? The fail-closed
   recommendation is to block all action until a separately designed high-risk override exists.
9. Is `trackExpansionRatio` best represented as `number | null` in JSON or `number | "unknown"` in
   TypeScript? JSON `null` avoids a mixed numeric/string field.
10. Which downstream layer owns per-artist expansion grouping when a single reviewed plan spans
    multiple artists: the #207 evidence builder, #208 report projection, or #209 policy plan?

## Sources and Freshness

| Source                                                                                                    | Date / freshness                         | Use                                                                 |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| GitHub issue #207 and `ROADMAP.md`                                                                        | Read 2026-07-27                          | Scope boundary and Layer 3 sequencing                               |
| `research/rfmedia-lidarr-integration/report.md`                                                           | Repository research; read 2026-07-27     | Granularity translation and expansion prompt                        |
| `research/rfmedia-lidarr-integration/persona-findings/negative-space.md`                                  | Repository research; read 2026-07-27     | Metadata fragility, duplicate/name mismatch, ecosystem gaps         |
| `research/rfmedia-lidarr-integration/synthesis/tension-mapping.md`                                        | Repository research; read 2026-07-27     | MBID plus supporting evidence, conflict visibility, offline caching |
| `docs/plans/plex-lidarr-identity-mapping/research-business.md`                                            | 2026-07-27                               | Identity states, cache/review rules, no-silent-action policy        |
| `docs/plans/plex-lidarr-identity-mapping/research-external.md`                                            | 2026-07-27                               | Typed MBIDs, API limits, fuzzy margin, expansion evidence           |
| Current rfmedia prompt, Lidarr command, resilience type, cache, presenter, formatter, and plan/apply code | Inspected 2026-07-27                     | Local terminal/JSON/prompt/cache conventions                        |
| [Command Line Interface Guidelines](https://clig.dev/)                                                    | Living guide; accessed 2026-07-27        | TTY, prompts, streams, color, dangerous-operation guidance          |
| [Beets matching configuration](https://docs.beets.io/en/stable/reference/config.html)                     | Current stable docs; accessed 2026-07-27 | Score thresholds, candidate gap, timid review                       |
| [Terraform `plan`](https://developer.hashicorp.com/terraform/cli/commands/plan)                           | Terraform v1.15.x; accessed 2026-07-27   | Reviewable plan and state recheck                                   |
| [Git `status`](https://git-scm.com/docs/git-status)                                                       | Updated 2026-02-02; accessed 2026-07-27  | Stable machine/porcelain contract                                   |

### Freshness Notes

- Plex MusicBrainz GUID coverage remains empirically unverified. The current official Plex API
  documents optional external `Guid[]` values but does not guarantee a music MBID scheme.
- Fuzzy thresholds and margins are starting policy values, not calibrated probabilities. Fixture
  evaluation is required before terminal help or JSON presents them as stable defaults.
- No current public bridge command was found. Command naming, completion, and strict exit-policy
  decisions should remain open unless the final #207 design deliberately adds that surface.
