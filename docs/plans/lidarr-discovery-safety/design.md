# Lidarr Discovery Safety Design

## Problem

The shipped `rfmedia lidarr discover` command is safely read-only by default and can promote one
visible MBID-backed recommendation into a sealed add plan, but it has no policy layer for recursive
recommendation growth, thresholds, per-seed fanout, loop prevention, exposure bias, or
multi-candidate approval. Issue #205 requires those controls without weakening the existing
Last.fm isolation, exact-MBID mutation identity, plan review, apply confirmation, live
revalidation, or possible-dispatch recovery contracts.

## Goals

- Keep ordinary discovery a one-hop, attributed, read-only preview.
- Evaluate every candidate through explicit, immutable policy decisions.
- Bound provider fanout, traversal depth, visited seeds, visible results, and approved adds.
- Prevent cycles and duplicate scheduling with one invocation-wide MBID-first visited set.
- Make deep discovery opt-in and finite.
- Keep candidates quarantined until the operator explicitly selects their visible ranks.
- Allow a bounded set of selected candidates to share one sealed artist-add plan.
- Preserve raw Last.fm similarity and explain every adjusted score and exclusion.
- Offer optional diversity boosting and popularity dampening using disclosed graph-exposure
  evidence available in the current provider contract.
- Preserve stable text, JSON, YAML, and CSV output plus Bash/Zsh/Fish completion parity.

## Non-Goals

- Durable cross-invocation quarantine queues, expiry, rediscovery suppression, or multi-operator
  approval.
- Direct artist creation from `lidarr discover`.
- Configurable monitoring, search, profile, or post-add normalization defaults owned by #206.
- Downstream indexer/download impact estimation owned by #219.
- Provider federation, tags, listener counts, play counts, caching, or enrichment owned by #204.
- Unbounded recursion or a user-configurable arbitrary depth.
- Changes to the private generated Lidarr client.

## Public CLI Contract

The existing command keeps `--artist`, `--limit`, `--no-autocorrect`, and conditional add-plan
resource options. It adds:

- `--min-similarity <score>`: inclusive finite threshold from `0` through `1`; default `0`.
- `--max-per-seed <count>`: positive safe integer limiting admitted candidates from each seed;
  default `10`, maximum `100`.
- `--deep`: opt into breadth-first depth-two traversal.
- `--no-cascade`: explicitly force one-hop traversal; conflicts with `--deep`.
- `--diversity-boost <weight>`: finite `0` through `1`; default `0`.
- `--popularity-dampening <weight>`: finite `0` through `1`; default `0`.
- `--max-add <count>`: positive safe integer authorization ceiling; default `1`, maximum `25`.
- `--add <ranks>`: one or more comma-separated visible positive ranks. Duplicate ranks are
  rejected, their count must not exceed `--max-add`, and every selected candidate must be eligible.

Add-plan resource options remain illegal without `--add`. Supplying `--max-add` without `--add` is
allowed because the resolved policy is part of preview output, but it causes no Lidarr resolution
or filesystem write. Machine formats never prompt; explicit ranks are candidate approval, and
actual mutation approval remains `rfmedia lidarr apply --yes`.

## Safety Defaults and Bounds

- Maximum provider result limit per request: existing `100`.
- Default and maximum accepted candidates per seed: `10` and `100`.
- Default traversal depth: `1`.
- Deep traversal depth: fixed at `2`.
- Invocation-wide visited-seed/request budget: `25`.
- Invocation-wide visible-candidate budget: `100`.
- Default and maximum approved candidates: `1` and `25`.
- Default threshold and ranking weights: `0`.
- Every cap is enforced before scheduling or writing the next unit of work.
- Caller cancellation prevents new wave admission and reaches every scheduled provider call.

The fixed depth and budgets are public constants in `types/discovery.ts`, shared by command
parsing, runtime validation, results, docs, and completion hints. The scheduler remains retry
owner, but the action owns invocation-wide budgets because scheduler operation budgets otherwise
reset across breadth-first waves.

## Traversal and Loop Prevention

Traversal is breadth-first and deterministic. The initial seed identity is inserted into the
visited set before the first request. Each returned candidate receives an identity:

1. `mbid\0<canonical-lowercase-mbid>` when MBID is present;
2. otherwise `lastfm-name\0<NFC-case-folded-name>`.

A candidate is admitted to the visited set before it can be enqueued as a later seed. This prevents
two parents in one wave from scheduling the same candidate. One-hop mode never enqueues returned
candidates. Deep mode may enqueue eligible candidates until fixed depth and invocation budgets are
reached. `--max-per-seed` applies after threshold validation and before enqueueing/visible
admission.

Each candidate retains original seed, depth, provider rank, raw similarity, first path, and
exposure count. Duplicate paths update exposure evidence but do not create another visible row or
provider request.

## Policy and Ranking

Raw Last.fm `similarity` is immutable. Policy computes a separate bounded `adjustedScore` from only
available evidence:

```text
novelty = 1 / exposureCount
exposure = (exposureCount - 1) / exposureCount
adjustedScore = clamp(
  similarity
  + diversityBoost * novelty * (1 - similarity)
  - popularityDampening * exposure * similarity,
  0,
  1
)
```

Here “popularity” is explicitly `graph-exposure`, not listener or play-count popularity. The result
reports `popularityEvidence: "graph-exposure"` whenever dampening is non-zero. Stable ordering is:
adjusted score descending, raw similarity descending, depth ascending, first-seen sequence
ascending, normalized name ascending.

Thresholding uses raw similarity so ranking weights cannot promote an otherwise rejected
candidate. MBID-less candidates may be visible and quarantined but are never eligible for add-plan
approval.

## Candidate Lifecycle

Quarantine is invocation-scoped result state:

- `filtered`: below threshold or excluded by a hard cap, with a stable reason code.
- `visited`: duplicate/back-edge retained only as exposure evidence, not another visible row.
- `quarantined`: visible but not selected, or missing a mutation-safe MBID.
- `approved`: explicitly selected by visible rank and eligible for planning.

There is no hidden queue and no database migration. A rank is invocation-local and may only select
from the fresh result returned by the same command execution. Durable intent begins when approved
candidates are written into the sealed plan; apply history begins only after later apply review.

## Multi-Candidate Plan Contract

One discovery invocation writes at most one plan file. Selected candidates are processed in
visible-rank order. Plan construction must:

- require a canonical MBID for every selected candidate;
- perform exact, unambiguous fresh Lidarr lookup for every candidate;
- classify already-present candidates without dispatch;
- resolve root folder, quality profile, and metadata profile once;
- create one entry for each still-addable candidate;
- set `maxBatch` to the approved addable entry count, bounded by the resolved `maxAdd`;
- preserve discovery provenance independently for every entry;
- write no plan if any selected rank is invalid, duplicate, ineligible, or unresolved ambiguously.

Artist-add plan types widen from a one-entry tuple to a non-empty readonly entry array. Existing
single-entry plan files remain valid. Apply executes entries through the existing per-entry
possible-dispatch and exact-MBID reconciliation machinery, stops admitting later entries after
uncertainty, and records per-entry outcomes. No direct retry or blind replay is added.

## Output Contract

JSON and YAML remain one attributed discovery document. Text renders the resolved policy,
traversal summary, candidate status/reason, raw and adjusted scores, provenance, and handoff
summary. CSV retains its mandatory summary row and fixed columns, adding stable policy and
candidate fields without leaking credentials or provider wire data.

The result includes:

- resolved policy and hard bounds;
- seeds requested, maximum depth reached, and visited/visible/filtered counts;
- each visible candidate's status, reason, MBID eligibility, provenance, exposure count, raw
  similarity, adjusted score, and visible rank;
- handoff status plus approved, already-present, planned, and failed counts;
- mandatory Last.fm attribution and scheduler execution metadata.

## Failure Contract

- Malformed flags and impossible combinations fail before lazy action loading.
- Runtime policy violations fail before configuration, scheduler, provider, Lidarr, or filesystem
  work.
- Provider failures retain `LastFmProviderError` classification and scheduler retry metadata.
- Candidate filtering and ineligibility are result data, not command failures.
- Optional planning failure preserves the complete attributed preview and returns one handoff
  failure in the same machine document.
- Missing MBID, ambiguous lookup, changed resources, unapproved real apply, and uncertain dispatch
  fail closed.
- Secrets never enter policy state, visited identities, output, errors, plans, or logs.

## Critical Test Contract

Only distinct safety boundaries require new coverage:

- pure policy: threshold/caps, MBID/name loop prevention, deterministic ranking, exposure scoring,
  and quarantine/approval decisions;
- discovery action: one-hop default, bounded depth-two waves, invocation budgets, cancellation,
  zero Lidarr work for preview, and bounded multi-rank plan handoff;
- command: exact grammar/default forwarding, fail-fast conflicts and selections, and stable machine
  output;
- artist-add plan/apply: multi-entry validation and stop-after-uncertainty behavior while retaining
  single-entry compatibility;
- completion parity: exact ordered Bash/Zsh/Fish discover options and value/file semantics.

Do not duplicate existing Last.fm transport, scheduler retry, plan checksum, apply confirmation, or
single-entry reconciliation tests unless their contract changes.

## Documentation and Lifecycle

Update `packages/rfmedia-cli/docs/features/lidarr-discovery.md`,
`packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`,
`packages/rfmedia-cli/README.md`, `packages/rfmedia-cli/CHANGELOG.md`, all three shell completion
templates, and their parity test. Update live `ROADMAP.md` using current GitHub issue state and add
issue #205 to `docs/roadmap-archive.md` with the merged PR number and date. Keep issues #204, #206,
and #219 open and explicitly out of scope.

## Acceptance Criteria

1. Plain `lidarr discover` is still a one-hop, read-only, attributed preview with zero Lidarr calls.
2. Every requested public control has strict documented defaults, bounds, and option interactions.
3. Deep discovery performs at most depth two and cannot exceed invocation-wide seed, request,
   visible-candidate, per-seed, or add bounds.
4. Cycles and duplicate paths cannot schedule the same identity twice.
5. Every visible row explains threshold, quarantine, eligibility, provenance, raw score, adjusted
   score, and graph-exposure evidence.
6. No candidate is planned until explicitly selected, and no artist is created until the separate
   reviewed apply approval.
7. Multiple selected eligible ranks produce one bounded sealed plan with per-entry provenance;
   existing single-entry artist-add plans remain valid.
8. Invalid or ambiguous selections write no partial plan and preserve fail-closed behavior.
9. Text, JSON, YAML, CSV, Bash, Zsh, and Fish expose one coherent public contract.
10. Focused tests, package validation, repository architecture/codegen gates, and CI pass.
