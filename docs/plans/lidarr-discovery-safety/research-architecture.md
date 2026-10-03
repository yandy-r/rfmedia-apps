# Architecture Research: lidarr-discovery-safety

## System Overview

The shipped discovery path is a deliberately split pipeline:

```text
rfmedia CLI/config bootstrap
  -> packages/rfmedia-cli/src/commands/lidarr.ts
  -> packages/rfmedia-cli/src/commands/lidarr-discover.ts
  -> packages/rfmedia-cli/src/actions/lidarr/discover.ts
  -> discovery scheduler lane
  -> packages/rfmedia-cli/src/lib/discovery/lastfm.ts
  -> ranked, attributed preview
  -> optional single-rank artist-add plan
  -> later `rfmedia lidarr apply` dry-run/confirmation/mutation
```

Ordinary discovery is independent of Lidarr. The action resolves only the process-wide scheduler
and the Last.fm client; it does not resolve a Lidarr execution context, health gate, cache, circuit
breaker, or client. That separation must remain true for preview, filtering, re-ranking, visited
candidate tracking, and deep traversal.

The current command is already preview-first: without `--add <rank>`, it returns recommendations
and `handoff.status: "not-requested"`. With `--add`, it still does not create an artist. It performs
fresh Lidarr resolution and writes one sealed `artist-add` plan. Actual creation is confined to
`rfmedia lidarr apply`, whose command path performs a dry-run review and interactive confirmation
unless the operator explicitly passes `--yes`. Issue #205 should extend this established
quarantine-to-plan-to-apply boundary rather than introduce a direct POST from discovery.

The issue's original affected-file estimate is stale relative to the shipped architecture. A pure
candidate policy fits the named discovery files, but multi-candidate approval is not a local
change: the current artist-add plan contract is explicitly single-entry (`maxBatch: 1`, one
foreign-ID selection, one tuple entry), and its apply orchestration also assumes one entry.

## Relevant Components

- `packages/rfmedia-cli/src/commands/lidarr.ts`
  - Registers the `discover` sibling command returned by
    `packages/rfmedia-cli/src/commands/lidarr-discover.ts`.
  - Owns shared output/failure helpers and the existing `lidarr apply` review, confirmation, and
    `--yes` approval boundary.
- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`
  - Defines the current public grammar: `--artist`, `--limit`, `--no-autocorrect`, and the
    conditional single-rank add-plan options.
  - Validates add-only option dependencies before lazily importing the action.
  - Owns text rendering plus stable JSON/YAML/CSV projection, including one summary row even when
    there are no candidates.
  - Is the primary integration point for `--max-add`, `--max-per-seed`, `--no-cascade`, `--deep`,
    and any optional diversity/popularity policy flags.
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`
  - Normalizes and bounds the seed and limit, schedules the provider request, removes the resolved
    seed, deduplicates, assigns visible ranks, and optionally hands one selected rank to add-plan
    generation.
  - Currently uses `runSingle("discovery", ...)`; deep traversal requires bounded wave scheduling
    or another explicitly bounded orchestration strategy.
  - Is the correct orchestration point for a pure policy module such as
    `packages/rfmedia-cli/src/lib/discovery/policy.ts`.
- `packages/rfmedia-cli/src/types/discovery.ts`
  - Defines the generated-independent provider query/result, attributed recommendation,
    discovery result, and handoff unions.
  - Must carry resolved safety policy, traversal provenance, quarantine/approval state, and
    machine-readable counts without leaking provider wire objects.
- `packages/rfmedia-cli/src/lib/discovery/lastfm.ts`
  - Sole credential-bearing Last.fm Fetch owner.
  - Performs one strict, bounded `artist.getSimilar` request per call and projects only `name`,
    `similarity`, optional canonical MusicBrainz ID, and Last.fm catalogue URL.
  - Does not expose popularity, genre, tag, listener, or play-count evidence. True popularity
    dampening cannot be claimed from the current contract without a new authoritative input or
    additional provider calls. A graph-exposure or source-rank proxy must be named as a proxy.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`
  - Accepts one MBID-backed recommendation, performs fresh exact Lidarr lookup and resource
    resolution, returns `already-present`, or writes one sealed artist-add plan.
  - Preserves conservative add policy: unmonitored, monitor-new-items none, and no missing-album
    search.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`
  - Public action barrel through which the command lazily resolves discovery.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` and
  `packages/rfmedia-cli/src/types/lidarr-plan.ts`
  - Enforce the current one-entry artist-add artifact, exact MBID identity, checksum, resource
    policy, and `maxBatch: 1`.
  - Must change with the apply/presenter stack if #205 approves more than one candidate into one
    plan; otherwise the design must retain one approved candidate per plan.
- `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts` and
  `packages/rfmedia-cli/src/commands/lidarr.test.ts`
  - Current critical action and CLI contract coverage.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
  - Static public surfaces that must move together. The parity test checks ordered discover
    options, value-taking flags, file completion, forbidden flags, and side-effect-free
    generation.
- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`,
  `packages/rfmedia-cli/README.md`, `ROADMAP.md`, and `docs/roadmap-archive.md`
  - User contract and lifecycle boundaries. `ROADMAP.md` currently lists #205 first in Layer 2 and
    keeps #206 safe add defaults and #219 cascade-impact estimation separate.

## Data Flow

The recommended extension keeps policy deterministic and provider-independent:

```text
validated CLI policy
  -> normalize initial seed
  -> fetch one breadth wave through the discovery scheduler lane
  -> strict Last.fm projection
  -> candidate identity and visited-set admission
  -> per-seed fanout cap
  -> threshold/filter/re-rank policy
  -> default quarantine preview
  -> explicit rank approval, bounded by max-add
  -> existing exact-MBID add-plan handoff
  -> later shared apply review/confirmation
```

Candidate identity should reuse the shipped rule: canonical MBID, lower-cased, is authoritative;
otherwise use a provider-scoped normalized-name identity. The initial seed and every admitted
candidate should be marked visited before scheduling another fetch, not after completion, so two
parents cannot enqueue the same candidate concurrently. Result rows should retain originating
seed, depth, provider rank/similarity, policy-adjusted rank or score, and quarantine/approval
reason so human and machine output explain why a candidate is visible or excluded.

`--no-cascade` should stop candidates from becoming traversal seeds while retaining the ordinary
one-hop preview. `--deep` should enable a bounded additional traversal mode; it must not mean
unbounded recursion. `--max-per-seed` caps fanout before the next wave is admitted. `--max-add`
caps approved mutation handoffs and is separate from provider request, returned-candidate, and
scheduler budgets.

The scheduler's discovery lane has concurrency and an operation budget, but
`runBatch()` applies its budget per batch call. Iterative breadth-first waves could reset that
budget. The discovery action or policy therefore needs one invocation-wide request/seed budget in
addition to `runBatch()` enforcement. Cancellation must cover every wave and prevent new
admissions.

Default quarantine should be a result state, not an implicit mutation queue. No candidate reaches
planning until all traversal, deduplication, policy checks, approval parsing, and `--max-add`
validation succeed. MBID-less candidates remain valid previews but are ineligible for approval.
The actual add remains separately reviewed by `lidarr apply`.

## Integration Points

1. Add `packages/rfmedia-cli/src/lib/discovery/policy.ts` as a pure module for option validation,
   candidate identity, visited tracking, per-seed and total bounds, eligibility/quarantine
   decisions, and deterministic re-ranking. It should not import Commander, Fetch, the Lidarr
   client, or filesystem plan code.
2. Refactor `packages/rfmedia-cli/src/actions/lidarr/discover.ts` around bounded traversal waves
   while preserving the zero-Lidarr ordinary path. Keep provider retries solely in the scheduler.
3. Extend `packages/rfmedia-cli/src/types/discovery.ts` before presentation code so text,
   JSON/YAML, and CSV share one exact safety/result contract.
4. Extend `packages/rfmedia-cli/src/commands/lidarr-discover.ts` with strict numeric/boolean option
   parsing and fail-fast combination rules. Machine output cannot depend on an interactive prompt;
   explicit rank selection plus later `lidarr apply` approval is the existing automation-safe
   model.
5. Decide the multi-approval artifact shape before implementation:
   - preserve one approved rank and make `--max-add` a cap of one, which does not realize bulk
     approval; or
   - widen artist-add plans and apply execution to multiple foreign-ID entries, which also touches
     `packages/rfmedia-cli/src/types/lidarr-plan.ts`,
     `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`,
     `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`, entry execution/history types,
     and `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`.
     Creating several unrelated plan files from one `--plan-file` should not be inferred silently.
6. Add only contract-critical tests:
   - policy unit tests for bounds, visited-loop prevention, deterministic ordering, and quarantine;
   - action tests for shallow/deep call counts, per-seed and invocation caps, cancellation, and no
     Lidarr resolution on preview;
   - command tests for option grammar, machine output, approval eligibility, and redaction;
   - the existing cross-shell parity test for every new value-taking or boolean flag.
7. Update all three shell templates together, then update
   `packages/rfmedia-cli/docs/features/lidarr-discovery.md`,
   `packages/rfmedia-cli/README.md`, and `ROADMAP.md`. After merge, move #205 to
   `docs/roadmap-archive.md` while leaving #206 and #219 open unless independently completed.

## Key Dependencies

- Commander supplies parsing and command registration; option semantics belong in
  `packages/rfmedia-cli/src/commands/lidarr-discover.ts`.
- The process-wide scheduler in `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts` supplies the
  discovery bulkhead, retry classification, concurrency, cancellation, and per-batch budget.
- `packages/rfmedia-cli/src/lib/discovery/lastfm.ts` remains the sole provider transport and
  credential boundary.
- MusicBrainz IDs are the only mutation-safe candidate identity; name-only candidates remain
  quarantined.
- The sealed plan/apply system is the authoritative confirmation, live revalidation, origin
  binding, history, possible-dispatch, and reconciliation boundary.
- Issue #206 still owns configurable monitoring/search/profile defaults and post-add
  normalization. Issue #219 still owns downstream indexer/download cascade estimation. Issue #205
  owns discovery traversal containment and candidate approval; `--no-cascade` should not be
  presented as #219-style downstream impact analysis.
- CI-relevant verification includes focused discovery/policy/command tests, shell completion
  parity, rfmedia typecheck/build, architecture checks, generated-client drift checks, and the
  rfmedia coverage suite. No generated Lidarr client file needs modification for discovery policy.
