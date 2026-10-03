# File-Aware Lidarr Artist Deletion UX Research

## Executive Summary

Artist deletion is a destructive, multi-system workflow whose safest interface is a staged
select → inspect → plan → apply model. Before any mutation, the CLI should identify every
selected artist and display the artist name, Lidarr path, album count, file count, and total
bytes affected, then require an explicit plan-wide policy of `keep-files` or
`delete-files`.

The generated plan must be sealed and immutable: dry-run and apply consume the same plan,
with apply rejecting drift rather than silently recalculating destructive work. Applying a
plan requires `--allow-artist-deletion`; plans that delete files additionally require
`--allow-file-deletion`. Noninteractive execution also requires `--yes`. Import exclusion,
verified postconditions, structured partial-failure reporting, and resumable execution are
essential because a multi-artist sequence of Lidarr mutations is not atomic.

## User Workflows

### 1. Select artists

Selection should support exact artist IDs as the canonical input and allow names or filters
only as discovery aids. Ambiguous names must produce a candidate list and stop without
creating a plan. The resolved selection should be stable, deduplicated, and shown before
continuing.

Recommended interaction:

1. Resolve artist selectors against Lidarr.
2. Display all matched artists.
3. Require the user to confirm the selection or refine it.
4. Store Lidarr artist IDs and observed metadata in the plan.

Bulk filters should never imply consent to delete newly matching artists at apply time.
Selection is resolved when the plan is created, not reevaluated when it is applied.

### 2. Inspect impact

For every selected artist, show:

| Field       | Purpose                                                            |
| ----------- | ------------------------------------------------------------------ |
| Artist      | Human verification of the deletion target                          |
| Path        | Shows the artist path reported by Lidarr                           |
| Album count | Communicates Lidarr library impact                                 |
| File count  | Communicates Lidarr's reported file impact                         |
| Bytes       | Communicates storage impact in human-readable and exact byte forms |

Display per-artist rows plus aggregate totals. If counts or bytes are unavailable, label
them `unknown`; never render unknown values as zero. These values are evidence reported by
Lidarr, not the result of a local filesystem walk. If Lidarr cannot provide required impact
statistics, the plan should identify the gap and block `delete-files` until the impact can
be reviewed confidently.

### 3. Choose the file policy

Require an explicit choice:

- `keep-files`: delete the artist from Lidarr but leave media files intact.
- `delete-files`: ask Lidarr to delete the artist and its files.

There should be no implicit default for destructive interactive use. The chosen policy must
appear in summaries, the sealed plan, dry-run output, confirmation prompts, machine output,
and final results. The policy applies to every artist in the plan; mixed per-artist policies
require separate plans.

### 4. Configure import exclusion

Offer an explicit import-exclusion option so removed artists are not immediately rediscovered
or reimported. The plan should record whether exclusion is requested, the exact exclusion
identity for each selected artist, and whether exclusion creation is supported by the
connected Lidarr version. The choice is plan-wide; every artist in the plan uses the same
import-exclusion setting.

Import exclusion is a distinct mutation with its own result. Failure to create it must not be
reported as successful deletion, and retries must not create duplicates.

### 5. Create a sealed plan

Planning gathers current Lidarr facts and emits a sealed artifact containing:

- Plan ID, schema version, creation time, and tool version.
- Lidarr instance identity without credentials.
- Artist IDs, names, paths, album counts, file counts, and byte totals.
- The plan-wide file policy and import-exclusion intent.
- Preconditions and Lidarr-observed values used for drift detection.
- Intended operation order and resumability metadata.
- A checksum or signature covering all destructive inputs.

Applying must consume this artifact as written. Any edit invalidates its seal. Secrets,
tokens, and unnecessary personal path data must not appear in distributable logs or machine
output.

### 6. Dry-run the plan

Dry-run should execute all safe reads, validation, authorization checks, capability checks,
and drift detection through fresh targeted Lidarr reads, while performing no mutations. Its
output should mirror apply ordering and state exactly what would happen:

- Artists that would be removed from Lidarr.
- Files that would be kept or deleted.
- Import exclusions that would be created.
- Preconditions that passed, failed, or could not be verified.
- Whether a Plex library scan would be eligible after successful apply.

Dry-run success means the sealed plan is currently applicable; it does not reserve the
underlying state. Apply must repeat drift checks.

### 7. Apply with layered consent

Applying any plan requires `--allow-artist-deletion`. A plan containing `delete-files`
operations also requires `--allow-file-deletion`. These flags express capability consent;
they do not replace the final confirmation.

Interactive apply should show the sealed-plan summary and require explicit confirmation.
Noninteractive apply must require all applicable allow flags plus `--yes`. Missing consent
must fail before any mutation. Environment variables, config defaults, or prior confirmation
must not silently supply destructive consent.

Example consent matrix:

| Plan                            | Required flags                                  |
| ------------------------------- | ----------------------------------------------- |
| Artist deletion with files kept | `--allow-artist-deletion`                       |
| Artist and file deletion        | `--allow-artist-deletion --allow-file-deletion` |
| Either plan, noninteractive     | Applicable allow flags plus `--yes`             |

### 8. Verify, report, and optionally scan Plex

After each mutation, verify the resulting Lidarr state with a fresh targeted read. Do not
walk the local filesystem or claim local file-level verification. A file-deleting success
means a `delete-files` artist mutation has a confirmed Lidarr postcondition.

An optional Plex scan should run when at least one artist has a verified file-deleting
success, even if another target later fails and the overall apply is partial. The scan should
be opt-in, targeted where possible, and reported as a separate follow-up result. A Plex scan
failure must not rewrite any verified deletion result; report it as a separate warning with
retry guidance.

## Performance UX

Impact calculation may require many Lidarr requests. The CLI should stay responsive and make
progress legible without weakening validation.

- Show phase-oriented progress: resolving artists, reading Lidarr statistics, sealing the
  plan, validating drift, applying mutations, and verifying postconditions.
- Include completed/total counts when totals are known; otherwise use an activity indicator
  with the current artist.
- Bound concurrent Lidarr requests to avoid overloading Lidarr.
- Cache read-only responses within a single planning run, but use fresh targeted Lidarr
  reads for dry-run and apply drift validation.
- Keep human output concise by default, with `--verbose` for per-artist details.
- Send progress and diagnostics to stderr so stdout remains valid for machine output.
- Make cancellation safe: planning can stop without cleanup; apply should stop at an
  operation boundary, persist its journal, and print the exact resume command.
- Report elapsed time and phase timing in verbose or machine output to help diagnose slow
  Lidarr calls.

## Error Handling

Errors must preserve the distinction between no mutation, partial mutation, uncertain
outcome, and verified completion.

### Preflight and drift

Reject the plan before mutation when:

- The plan seal or schema is invalid.
- The Lidarr instance differs from the planned instance.
- Fresh targeted Lidarr reads show that an artist ID, path, album count, file count, or byte
  total has drifted beyond the plan's declared tolerance.
- Required permissions, capabilities, or consent flags are missing.

Drift output should identify the changed field and artist, show planned versus observed
values, and instruct the user to create and review a new plan. Apply must not silently
refresh a stale plan.

### Partial and uncertain outcomes

Because remote API calls can time out after Lidarr commits a mutation, every step should be
journaled with one of these states:

- `pending`: not attempted.
- `in_progress`: dispatched but not yet verified.
- `succeeded`: postcondition verified.
- `failed`: known not to have completed.
- `uncertain`: outcome could not be established.
- `skipped`: intentionally not run because a dependency failed or consent was absent.

On a partial failure, stop operations whose prerequisites are no longer safe, verify as much
state as possible, persist the journal, and return a nonzero exit status. Never retry an
`uncertain` destructive action blindly; first reconcile the current Lidarr state through a
fresh targeted read. If at least one file-deleting target is verified, preserve eligibility
for the optional Plex scan even though the overall apply remains partial.

### Resume

Resume should use the original sealed plan and its append-only execution journal. It should:

- Re-verify already successful postconditions instead of repeating mutations.
- Reconcile `in_progress` and `uncertain` operations before deciding whether to retry.
- Retry only failed or pending idempotent steps whose prerequisites still hold.
- Repeat drift checks for all remaining destructive targets.
- Require the same allow flags and noninteractive `--yes` consent as the original apply.
- Produce a new execution-attempt ID while retaining the plan ID and prior history.

If safe continuation is impossible, the CLI should stop with manual recovery instructions
and machine-readable evidence rather than claim that the operation is resumable.

### Machine output

`--json` should emit a versioned result envelope suitable for automation, with stable enum
values and no ANSI formatting. Include:

- Schema version, plan ID, execution-attempt ID, mode (`plan`, `dry-run`, `apply`, or
  `resume`), and overall status.
- Consent requirements and whether each was satisfied.
- Planned and observed totals for artists, albums, files, and bytes.
- Plan-wide file and import-exclusion policies plus per-artist progress, mutation results,
  verification results, and errors.
- Import-exclusion and optional Plex-scan results as separate operations.
- Drift records with planned and observed values.
- Resume availability and a safe resume command or token.
- Structured error codes, human-readable messages, retryability, and uncertainty flags.

Avoid interleaving multiple JSON documents unless an explicit JSON Lines mode is selected.
Machine output must preserve unknown values as `null`, not zero, and must never expose
credentials.

## Recommendations

1. Make a sealed, reviewable plan the only input accepted by destructive apply.
2. Require explicit `keep-files` or `delete-files` selection and provide no destructive
   default; apply the selection to the entire plan.
3. Enforce layered consent with `--allow-artist-deletion`,
   `--allow-file-deletion` when applicable, and `--yes` for noninteractive execution.
4. Use Lidarr path and statistics as impact evidence, and compare them with fresh targeted
   Lidarr reads for drift detection; do not walk or verify the local filesystem.
5. Model execution as a journaled state machine so partial and uncertain outcomes are
   visible, reconcilable, and safely resumable.
6. Keep the plan-wide import-exclusion choice explicit and independently verified.
7. Provide versioned JSON output with stable status and error enums for automation.
8. Run an optional Plex scan after at least one verified file-deleting success, including
   partial applies; report it independently from all deletion results.
9. Add scenario tests for stale plans, ambiguous artists, unknown Lidarr statistics, API
   timeouts after commit, later-target failure after a verified file deletion, exclusion
   duplication, resume, and Plex scan failure.
