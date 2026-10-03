# Lidarr Execution Lanes

## Overview

Lidarr work runs through four isolated execution lanes. Each lane has a separate concurrency pool,
per-batch operation budget, retry allowance, and retry-delay cap. Saturation or failure in one lane
does not consume another lane's capacity.

The current `status`, `list`, `wanted`, `health`, plan producers, plan/apply lifecycle, and quality
preset diff/read-back work use `local-only`. Search and typed artist/album lookup use
`metadata-dependent` because Lidarr may delegate those requests to its configured metadata service.
Last.fm similar-artist discovery uses `discovery` without resolving Lidarr. Quality preset creates
and updates use `destructive`. Profile assignment and tag mutation remain supported only through
sealed plan/apply. The operation's reviewed risk level is separate from its scheduler lane.

## Lanes and Defaults

| Lane                 | Current use                                  | Concurrency | Batch budget | Retries | Delay cap |
| -------------------- | -------------------------------------------- | ----------- | ------------ | ------- | --------- |
| `local-only`         | Reads, sealed plan/apply, and preset reviews | 8           | 1000         | 1       | 15 s      |
| `metadata-dependent` | Search and typed lookup                      | 2           | 50           | 1       | 30 s      |
| `discovery`          | Last.fm similar-artist discovery             | 4           | 100          | 2       | 30 s      |
| `destructive`        | Preset writes and destructive mutations      | 1           | 25           | 0       | 15 s      |

`Retries` means additional attempts after the first attempt. Destructive and non-idempotent work is
never retried even if a configuration override is higher. Lidarr plan/apply resolves its resilient
client with zero internal retries. Apply marks editor writes non-idempotent, so scheduler retry
configuration cannot automatically repeat a mutation.

Configuration values are validated before Lidarr client I/O:

| Field               | Inclusive bounds |
| ------------------- | ---------------- |
| `concurrency`       | 1–32             |
| `operationBudget`   | 1–10,000         |
| `retryAttempts`     | 0–10             |
| `retryBackoffCapMs` | 1–300,000        |

## Configuration

Defaults require no configuration. Override only the fields that need tuning in `.rfmedia.yaml`:

```yaml
lidarr:
  baseUrl: "{{ LIDARR_URL }}"
  apiKey: "{{ LIDARR_API_KEY }}"
  scheduler:
    lanes:
      local-only:
        concurrency: 6
      metadata-dependent:
        concurrency: 1
        operationBudget: 25
        retryAttempts: 1
        retryBackoffCapMs: 20000
      discovery:
        concurrency: 2
        operationBudget: 50
        retryAttempts: 1
        retryBackoffCapMs: 20000
      destructive:
        concurrency: 1
        retryAttempts: 0
```

Lane policies are configuration-only. Search and lookup expose paging, connection override, and
explicit stale-consent options, but none of those options changes scheduler lane policy.

## Admission, Ordering, and Cancellation

The configured scheduler is shared process-wide and owns one persistent limiter per lane.
Simultaneous batches and action invocations in the same lane share that limit, while different lanes
share no capacity. Replacing the loaded scheduler configuration rebuilds the scheduler without
retaining connection credentials. A batch admits its ordered prefix up to the lane's operation
budget; remaining entries return `skipped` with `budget-exhausted` and their task closures are not
invoked.

Batch results preserve input order even when work completes out of order. An aborted queued task
settles as `skipped` with `aborted` and does not start. Every batch includes aggregate totals for
admitted, succeeded, failed, skipped, and attempted work.

Plan/apply orchestration supplies its own cap, exclusive claim, per-target ordering, durable
history, and recovery contract. Its fresh target and verification reads run as `local-only` work.
Artist-add planning and each non-idempotent create or album-normalization dispatch run in the
`metadata-dependent` lane with the execution context's required health/circuit preflight. A real
apply admits one artist mutation at a time. Other artist editor operations send one artist ID per
request and perform up to three fresh targeted verification reads 100 ms apart. An inconclusive
post-dispatch state is recorded as uncertain, stops later admissions, and marks later pending
entries `not-attempted`.

## Health Gates and Retry Ownership

Scheduled actions make the scheduler the only retry owner. A non-empty `metadata-dependent` batch
must provide a typed scheduler preflight created with `createLidarrSchedulerPreflight`; the
scheduler runs it exactly once before any admitted task closure. A missing or rejected preflight
settles the batch safely with classified failures. `local-only`, `discovery`, and `destructive`
work never invokes the metadata preflight under the current tier descriptors.

Search and lookup resolve one execution context containing:

- one raw `LidarrClient` used only by the preflight;
- one resilience-decorated facade used by live task attempts;
- the exact shared persisted `lidarr` and `metadata` circuit-breaker pair;
- one non-throwing complete-projection cache writer; and
- one exact-query stale fallback helper.

The breaker pair is initialized lazily and shared by the preflight and live facade. This prevents a
decorated preflight from recursively health-gating itself or creating breaker state that live
attempts cannot observe.

### Search and Lookup Lifecycle

Each `lidarr search`, `lidarr lookup artist`, or `lidarr lookup album` invocation submits one
idempotent `metadata-dependent` task:

1. The scheduler runs one raw-client health/circuit preflight.
2. If admitted, each scheduler attempt calls exactly one decorated facade method.
3. The scheduled facade path records breaker failure or success but performs no internal health
   gate, retry, cache read, or stale serve.
4. A successful attempt validates, deduplicates, and ranks the complete projection, then performs a
   non-fatal exact-query cache write before local paging.
5. Only after preflight rejection or retry exhaustion may `runSingle` invoke the terminal fallback,
   at most once.
6. A served fallback revalidates the complete cached projection and returns success metadata with
   the original task identity and exact number of live attempts.

The terminal helper serves only with explicit `--allow-stale`, enabled cache policy, an exact row
within the stale ceiling, and a final `lidarr-unreachable`, `timeout`, or
`metadata-provider-unavailable` error. It emits the sole stale warning and cache-status callback
only after successful revalidation. Cache miss, corruption, expiry, and database failure preserve
the original terminal error.

The cache identity is canonical Lidarr origin × category `lookup` ×
`v1:<mode>:<sha256(NFC-normalized-term)>`. It excludes paging, cleartext terms, and API keys. Live
results, including `[]`, cache the complete pre-page projection; stale data is never consulted
between scheduler attempts.

Retries require all of the following:

- The task is idempotent.
- The lane is not `destructive`.
- The failure is `lidarr-unreachable`, `timeout`, or `rate-limited`.
- The lane still has retry allowance.

Validation, configuration, authentication, authorization, not-found, invalid-response,
metadata-provider-unavailable, abort, and unknown failures do not retry. A `429`, or a `503`
carrying `Retry-After`, is `rate-limited`. A plain `503` remains `lidarr-unreachable`. A
delta-seconds `Retry-After` is honored exactly when it fits within the lane cap; otherwise the
failure is returned without waiting. Other eligible failures use bounded exponential backoff with
jitter.

Caller cancellation is checked before preflight, while queued, during retry delay, and in the
generated request. The same signal and abort reason flow through those layers. An aborted operation
does not retry or invoke terminal cache fallback.

### Last.fm Discovery Lifecycle

Ordinary `rfmedia lidarr discover --artist <name>` submits one idempotent task to the `discovery`
lane. The task performs one fixed-origin Last.fm `artist.getSimilar` request and carries provider
attribution and fresh execution metadata even when the result is empty. `--deep` uses the same
task contract for deterministic breadth-first waves: the initial request produces depth-one
candidates, then pre-registered admitted candidates may become seeds whose requests produce
depth-two candidates. It never schedules depth three.

The discovery action, rather than the scheduler, owns invocation-wide traversal budgets because a
scheduler operation budget is per batch and would reset between waves. Before scheduling or
admission, the action enforces:

- a provider result limit of 1–100 per request (`--limit`, default 15);
- an admitted-candidate limit of 1–100 per seed (`--max-per-seed`, default 10);
- a fixed default depth of one and `--deep` depth of two;
- at most 25 provider requests and 25 visited seed identities;
- at most 100 visible candidates; and
- at most 25 approved add ranks (`--max-add`, default 1).

The initial seed and every future seed are registered in the invocation-wide MBID-first visited set
before scheduling. Candidates without an MBID use a Last.fm-scoped NFC case-folded name identity
for loop prevention, but remain ineligible for an add plan. Duplicate paths update graph-exposure
evidence without consuming another visible row or request. `--deep` conflicts with
`--no-cascade`; without `--deep`, both the normal cascade default and `--no-cascade` are one hop.

The ordinary path does not resolve a Lidarr client, run metadata preflight, read Lidarr cache state,
affect the Lidarr/metadata circuit breakers, persist provider data, or create durable quarantine
state.

The scheduler remains the only retry owner. An idempotent discovery task may retry
`discovery-provider-unavailable`, `timeout`, or `rate-limited` within the lane allowance.
Configuration, validation, authentication, authorization, invalid-response, caller abort, and
unknown failures do not retry. A safe `Retry-After` delay is bounded by the discovery lane cap.

There is no provider cache or stale fallback. `--allow-stale`, provider federation, response
caching, listener/play-count popularity data, and other provider enrichment remain under #204.
Optional popularity dampening uses only disclosed graph-exposure counts from the current
invocation, not provider popularity data.

Those general rules apply to idempotent scheduled tasks such as reads. Plan/apply mutation requests
have no automatic retry path. A retryable failure known to occur before dispatch may become a
durable deferred intent. Once dispatch may have happened, apply uses bounded targeted
reconciliation; if the result remains uncertain, the operator must explicitly run `lidarr apply
--resume`. Health, status, startup, and other commands never replay deferred mutations.

The optional discovery `--add <ranks>` handoff is not part of a provider task. It atomically
validates one or more visible ranks, performs fresh Lidarr planning reads, writes at most one
bounded sealed multi-entry plan in visible-rank order, and leaves mutation to the separate
`lidarr apply` approval. `discover --add` never accepts `--yes`; real non-interactive or machine
apply requires `lidarr apply <plan> --yes`.

Artist-add dispatch is non-idempotent and non-deferable: apply persists possible-dispatch evidence
before each single create request and reconciles by exact MusicBrainz ID instead of retrying
blindly. On resume, possible-dispatch entries are reconciled before fresh entries. Any unresolved
uncertainty stops admission and leaves later pending entries `not-attempted`.

The sealed artist-add policy maps the reviewed `monitored` boolean into the live create request but
always sends `monitorNewItems: "none"`, album monitor mode `none`, and
`searchForMissingAlbums: false`. Omission therefore creates an unmonitored artist; `--monitored` is
the only positive override.

When a plan includes `--unmonitor-types`, creation and album normalization are one durable recovery
workflow with four machine-visible stages:

1. `create-pending` — no verified artist creation exists.
2. `creation-verified-normalization-pending` — exact-MBID reconciliation proved the artist and
   stored its Lidarr ID, but normalization is not complete.
3. `normalization-verification-pending` — a sorted batch of matching album IDs may have been
   dispatched and requires a fresh read.
4. `completed` — a fresh artist-scoped read proved that no album matching the sealed selectors
   remains monitored.

Normalization reads only the created artist's albums, refuses to treat an empty list as completion,
and updates sorted matching IDs in batches of at most 200. Before each batch it checks the exclusive
claim and persists `normalization-verification-pending`; after all batches it performs a fresh
artist-scoped verification read. A partial or ambiguous result stops later admissions and is
continued only by explicit `lidarr apply <plan> --resume`. Resume uses the durable Lidarr artist ID
and stage evidence and never authorizes another artist create.

This workflow is separate from the generic deferred-intent queue. Neither artist creation nor its
post-add normalization creates a deferred queue entry, and generic deferred replay does not execute
either operation. The only automatic re-execution is scheduler retry of eligible idempotent
planning or read work; non-idempotent create and normalization writes have zero automatic retries.

### Quality Preset Reads and Writes

Preset diff and each apply pre-dispatch/read-back review are idempotent `local-only` tasks. Their
facade calls use the explicit safe-read retry allowlist:

- custom-format list, targeted read, and schema read;
- quality-profile definition list, targeted read, and schema read; and
- naming configuration and naming-example reads.

The resilience decorator is configured with zero internal retries for these calls because the
scheduler owns retry policy for the complete review task. This avoids independently retrying only
part of the multi-read snapshot.

Preset apply sends custom-format create/update, quality-profile create/update, and naming update
calls through `destructive` one resource at a time. Every write task declares `idempotent: false`,
the lane defaults to zero retries, and the writes are absent from the facade's in-place retry
allowlist. A post-dispatch error therefore triggers a fresh read-back, not an automatic replay. If
the read-back cannot prove the reviewed state, apply records an uncertain or failed outcome,
persists it when possible, and stops later writes.

## Output Contract

Successful action results add an `execution` object without changing their existing domain fields:

```json
{
  "command": "lidarr-status",
  "result": {
    "version": "2.0.0",
    "artistCount": 42,
    "execution": {
      "taskId": "lidarr-status",
      "operation": "lidarr status",
      "lane": "local-only",
      "outcome": "succeeded",
      "attempts": 1
    }
  }
}
```

Human success output ends with a concise lane and attempt summary on stderr. JSON and YAML retain
the nested envelope above. CSV uses flat dot-path columns such as `result.execution.lane` and
JSON-encoded cells for compound domain values, keeping output compatible with the shared CSV
serializer. All machine formats continue to use stdout exclusively.

Machine-readable failures use one formatter envelope and exit code 1:

```json
{
  "command": "lidarr-status",
  "error": {
    "message": "Lidarr is unreachable",
    "code": "lidarr-unreachable",
    "lane": "local-only",
    "outcome": "failed",
    "attempts": 2,
    "failureType": "lidarr-unreachable",
    "statusCode": 503,
    "retryable": true
  }
}
```

`retryAfterSeconds` is included when Lidarr supplies a usable overload hint. Scheduler metadata
contains task identifiers and sanitized operation labels only; it never contains API keys, task
closures, response bodies, or credential-bearing URLs.

Search and lookup preserve the same execution object on live and degraded success. A cache serve
after preflight rejection reports `attempts: 0`; a cache serve after retry exhaustion reports the
number of completed live attempts. Their provider and cache output is documented in
[Lidarr Search and Lookup](lidarr-search-lookup.md).

Similar-artist discovery always reports `lane: "discovery"` and fresh provider work. Its attributed
text, JSON, YAML, and CSV contracts are documented in
[Lidarr Similar-Artist Discovery](lidarr-discovery.md).

## Adoption Contract

Future callers use the shared `resolveLidarrScheduler()` instance, declare exactly one canonical
lane, mark whether the complete task is idempotent, and use the matching resilient-client tier. Use
`runSingle` when the command should preserve thrown-error identity, or `runBatch` when every item
needs a structured `succeeded`, `failed`, or `skipped` result plus aggregate statistics.

Metadata-dependent single reads that support degradation must pass the shared preflight and a
terminal fallback to `runSingle`. They must not perform cache lookup or live retry inside the task
closure; otherwise stale data could be served between attempts and retry/circuit accounting would
have competing owners.

Automatic deferred replay is intentionally excluded. Health checks remain diagnostic, and future
mutations must retain the separate plan/apply safety contract.
