# Design Review: Metadata Drift Detection and Reconciliation

- **Issue:** #125
- **Reviewed artifact:** `feature-spec.md`
- **Research considered:** architecture, patterns, integration, and documentation research
- **Verdict:** Approved after final re-review

## Initial Verdict

The report-first architecture, exact-path matching, read-only scan, fresh revalidation, and
provider-neutral boundaries are sound. The specification should not advance to implementation
until the mutation contract is narrowed and made unambiguous. As written, an executed apply may
change the writable subset of a field while knowingly leaving unsupported targets divergent, yet
there is no field scope or explicit partial-apply authorization. That makes both the safety gate
and the meaning of success unclear.

The smallest honest V1 is:

- scan observes `rating`, `artist`, `genre`, and `year`;
- apply repairs `rating` only;
- non-rating drift remains an observed residual and is never planned as a requested V1 mutation;
- known blockers within the rating plan prevent every write unless an explicit `--allow-partial`
  option is added; and
- the three authority choices are separate, mutually exclusive flags.

If non-rating SQLite-only repair must ship in V1, the command instead needs explicit field
narrowing plus explicit partial authorization. It must not infer permission to leave a file or
server target divergent merely because SQLite happens to be writable.

## Prioritized Findings

### P0: Apply currently authorizes implicit partial repair

The specification says V1 repairs every supported target and returns `unsupported-target`
residuals. For `artist`, `genre`, and `year`, that can update SQLite while file or server targets
remain knowingly divergent. The command has neither a requested-field boundary nor an
`--allow-partial` gate, so selecting a strategy and `--execute` implicitly authorizes partial
convergence.

Required correction:

- Prefer the minimal boundary: declare V1 apply rating-only while retaining the broader scan.
  Include `requestedFields: ["rating"]` and separately report non-rating `observedResiduals`.
- A known missing authority, ambiguous identity, unsupported rating target, or invalid rating in
  the requested plan must block mutation before confirmation and before writable dependencies.
- If useful partial execution is required, add a positive `--allow-partial` option. Without it,
  the presence of a known blocker means zero writes. With it, only independently actionable
  records may run, the aggregate status is `partial`, and the exit code is nonzero while requested
  drift remains.
- Remove the success criterion promising repair of all SQLite metadata targets unless field
  narrowing and partial authorization are fully specified.

This keeps V1 feasible with the repository's actual write capabilities and avoids presenting a
database-only change as three-plane reconciliation.

### P0: Use explicit winner flags, not `--strategy`

The issue language and repository command patterns favor boolean intent flags, and Commander
already supports declaring conflicts. A free-valued `--strategy` is less direct in help and
completion output and conflicts with the research's reviewed command shape.

Required correction:

```text
rfmedia reconcile apply <source-path>
  (--file-wins | --db-wins | --server-wins)
  [--execute]
  [--allow-partial]
  [-y | --yes]
```

- Declare the three options mutually conflicting and require exactly one before lazy-loading the
  action.
- Normalize the selected flag to the internal
  `"file-wins" | "db-wins" | "server-wins"` enum.
- Repeat the exactly-one check inside the action.
- Update every example, completion, result field, test, and documentation reference consistently.

A winner selects authority; it does not authorize execution. `--yes` must remain inert without
`--execute`, and `--allow-partial` must remain inert without `--execute`.

### P1: Database identity and stale-entry repair need one exact rule

The specification alternates between “normalized file path,” inventory provenance, and
destination evidence without naming the database column used for the three-plane join. It also
says stale rows are never deleted but may have “stat evidence” updated without defining when that
is valid or how it relates to the selected metadata winner.

Required correction:

- State the exact join key. For a media-server library reconciliation, this should be the
  root-contained normalized absolute `inventory.dest_path`; `source_path`, `relative_path`,
  `operation_id`, and row ID remain provenance and optimistic-update guards.
- Do not case-fold paths or use basename fallback.
- Without `--operation-id`, more than one inventory row for one destination is ambiguous even when
  values currently agree; do not select the newest or first row.
- Define stale behavior separately from metadata authority:
  - missing destination: report-only and unrepairable;
  - present destination with changed stat: refresh only the uniquely selected row from freshly
    verified filesystem facts;
  - no stale-row deletion in V1.
- Name the expected-old-value guard used for an update so a concurrent row change produces
  `stale-evidence`.

### P1: Result and exit semantics are incomplete

The finding and target types are useful, but the aggregate contract does not define a closed
status/success/exit model for preview blockers, known unsupported targets, read failures, partial
execution, or an empty CSV result.

Required correction:

- Add a versioned aggregate with closed `status`, `success`, and `exitCode` fields.
- A completed scan exits zero when it finds ordinary drift, missing values, stale rows, ambiguity,
  or unsupported capabilities as report data. Acquisition, database, paging, or file-read/parse
  failure exits nonzero with an error envelope and no reconciliation result.
- A preview exits zero when it successfully reports a blocked or actionable plan; its
  `executable` flag and blocker counts carry that distinction.
- An executed apply exits zero only when every requested update is freshly verified and no
  requested drift remains. Decline, blocked execution, partial execution, stale evidence, or
  failed verification must have explicit statuses and nonzero codes.
- JSON and YAML emit one envelope. CSV must use a fixed row union and include a summary row so an
  empty successful scan is still a meaningful machine document.
- Keep non-rating residual counts separate from requested rating-plan completion so V1 can be
  truthful without claiming whole-library convergence.

### P1: “Fresh” server and file evidence needs a realizable boundary

The specification promises fresh server verification and that apply never writes through a
symlink, while the research notes that the adapter can cache queries and the existing pathname
rating writer cannot provide a race-free no-follow guarantee by itself.

Required correction:

- Specify how scan-before-write and post-write server reads bypass or invalidate cached evidence.
  A normal cached query is not postcondition proof.
- Either include a hardened checked rating-writer boundary in scope, or narrow the guarantee to
  immediate root-containment, `lstat`, fingerprint revalidation, and post-write verification while
  documenting the inherited pathname race. Do not promise stronger no-follow semantics than the
  chosen writer can enforce.

This decision affects feasibility but does not require broad generic metadata writers.

## Approved Design Decisions

- New top-level `rfmedia reconcile scan|apply`, distinct from both existing reconciliation flows.
- Exact shared-path identity only; no fuzzy, basename, or implicit mount-prefix matching.
- Hardened read-only SQLite snapshot for scan and preview.
- Complete bounded acquisition before planning, with duplicate evidence preserved as ambiguity.
- Provider-neutral reads and rating writes through `MediaServerAdapter`.
- Preview-first apply with `--execute`, default-No interactive confirmation, and explicit `--yes`
  for machine or non-interactive execution.
- Per-target outcomes, external writes before SQLite, optimistic database updates, and fresh
  post-apply verification.
- Stable JSON/YAML/CSV output, deterministic ordering, and Bash/Zsh/Fish completion parity.
- No schema migration, saved plan, stale-row deletion, or generic non-rating writer in V1.

## Required Spec Corrections Before Approval

1. Replace `--strategy` everywhere with exactly-one
   `--file-wins | --db-wins | --server-wins`.
2. Make V1 apply explicitly rating-only, or fully specify field narrowing and
   `--allow-partial`; remove implicit partial mutation.
3. Define the exact inventory join key, ambiguity rule, and stale-stat repair behavior.
4. Close the aggregate status/output/exit-code contract, including preview blockers and empty CSV.
5. Choose realizable fresh-query and checked-file-write guarantees.

After those corrections, the design is suitable for implementation without a child issue.

## Re-Review of Revised Specification

The revised specification resolves the original P0 findings:

- apply now uses exactly one mutually exclusive `--file-wins`, `--db-wins`, or `--server-wins`
  flag;
- V1 apply is rating-only, while artist, genre, and year remain separately counted observations;
- known requested-plan blockers cause zero writes unless `--allow-partial` is explicit; and
- partial execution remains non-successful while requested drift remains.

It also resolves most P1 findings:

- the three-plane database join is explicitly the root-contained normalized absolute
  `inventory.dest_path`;
- duplicate destinations remain ambiguous without an exact `--operation-id`;
- missing destinations are report-only, while changed stats may be refreshed only for one freshly
  verified, uniquely selected row;
- the optimistic guard names row ID, operation ID, destination, stat, and prior rating;
- scan, preview, execution, cancellation, partial, and failure exit behavior is closed;
- blocked previews are explicitly successful report data;
- empty CSV results include a summary row; and
- fresh server reads and the checked pathname-writer limitation are stated honestly.

### Remaining P1 blocker: stat refresh has no result representation

The revised contract treats stale-stat refresh as a requested V1 mutation and includes it in apply
success, blocker, and postcondition semantics. However:

- `requestedFields` can contain only `["rating"]`;
- `ReconciliationTargetOutcome.field` requires a `ReconciliationField`; and
- `ReconciliationField` has no stat/fingerprint member.

Consequently, a planned, applied, blocked, stale, or failed stat refresh cannot be represented in
the promised stable machine result or counted consistently when deciding apply success.

Required correction: either make stale stat entries report-only in V1, or add an explicit
discriminated database-stat outcome/request kind carrying old and intended `mtime`/`size` values.
Keep stat refresh separate from metadata authority; it is filesystem-derived maintenance, not a
fourth metadata field selected by a winner flag. The aggregate counts and post-apply contract must
include that outcome kind.

### Final verdict

**Revise.** All original safety decisions are corrected, but the requested stale-stat mutation must
be modeled in the result contract (or removed from V1 apply) before the design is implementation
ready. No other blocker remains.

## Final Focused Re-Review

The final revision resolves the remaining stale-stat result-contract blocker:

- `DatabaseStatOutcome` is a distinct discriminated outcome rather than a metadata field;
- it identifies the exact inventory row and carries old and intended `mtime`/`size` values;
- `requestedOperations` explicitly includes rating and database-stat refresh;
- aggregate counts distinguish rating work from stat-refresh work; and
- apply succeeds only after a fresh postcondition proves no requested rating drift or pending
  database-stat refresh remains.

This keeps filesystem-derived stat maintenance separate from the selected metadata authority while
making planned, applied, skipped, stale, and failed work representable in stable machine output.
Together with the earlier corrections, the contract is now fail-closed, capability-honest, and
small enough for the planned V1 implementation.

### Final verdict

**Approve.** No design blocker remains.
