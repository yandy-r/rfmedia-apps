# Documentation Research: Metadata Drift Reconciliation

## Overview

Issue #125 needs one new canonical operator guide plus coordinated updates to the rfmedia package
reference, tracking-database documentation, completion guide, shared output contract, changelog, and
roadmap. The documentation must keep three similarly named workflows distinct:
`rfmedia reconcile scan|apply` reconciles per-track metadata across files, SQLite inventory, and a
media server; `rfmedia plex sync` is an older two-plane, rating-only synchronizer; and
`rfmedia lidarr reconcile` is a report-only artist-identity bridge.

The settled public contract in
`docs/plans/125-metadata-drift-reconciliation/feature-spec.md` is preview-first:
`scan` is always read-only, while `apply` requires exactly one of `--file-wins`, `--db-wins`, or
`--server-wins` and still writes nothing until `--execute` plus default-No interactive approval or
`--yes` authorize execution. Documentation must not describe the winner flag as authorization,
call `--dry-run` global, or imply that machine output supplies approval.

## Documentation Gaps

### Create the canonical feature guide

- **Required — create
  `packages/rfmedia-cli/docs/features/metadata-reconciliation.md`.** This should be the complete,
  stable operator contract rather than spreading behavioral details across README examples. Include:
  1. scope and explicit disambiguation from `plex sync` and `lidarr reconcile`;
  2. `scan` and `apply` syntax, every option, configuration/database precedence, and examples;
  3. exact-path identity, source-root containment, `--operation-id`, duplicate inventory/server
     evidence, and why filename/fuzzy matching is refused;
  4. the comparable fields (`rating`, `artist`, first `genre`, `year`) and a read/write capability
     matrix;
  5. finding definitions for missing values/planes, conflicting values, stale inventory,
     ambiguity, read failure, unsupported targets, and in-sync records;
  6. authority semantics for `file-wins`, `db-wins`, and `server-wins`, including missing authority
     never falling back to another plane;
  7. preview-first safety: `apply` without `--execute` is the default dry run, `--yes` alone does
     nothing, machine/non-TTY execution requires `--execute --yes`, and interactive confirmation
     defaults to No;
  8. read-only SQLite snapshot restrictions, fresh pre-write revalidation, exact optimistic DB
     updates, write ordering, post-apply rescan, partial outcomes, and safe rerun guidance;
  9. human output on stderr; versioned JSON/YAML on stdout; fixed-row-kind CSV; deterministic
     ordering; stable codes; empty results; and output examples for scan, preview, successful apply,
     unsupported residuals, and partial failure;
  10. exit behavior: ordinary drift is successful scan data, while invalid/incomplete evidence and
      incomplete requested execution are nonzero;
  11. limitations: only rating is writable across all three planes, non-rating file/provider writes
      are unsupported, inventory metadata may be absent, stale rows are not deleted, and no
      cross-resource transaction exists;
  12. privacy, redaction, cancellation, and troubleshooting for missing/active/old/oversized DBs,
      path mismatches, duplicate evidence, unsupported formats, parse failures, and provider errors;
      and
  13. links to the centralized database, media-server adapter, Plex metadata sync, shared output,
      and shell-completion guides.

### Update public references and indexes

- **Required — `packages/rfmedia-cli/README.md`:** Add metadata reconciliation to the feature list
  near lines 19-33 and add a dedicated top-level command section. The section should give scan,
  strategy preview, interactive execute, non-interactive execute, and machine-output examples; link
  the canonical guide; summarize fields/findings/capabilities; and state the no-mutation matrix.
  Keep detailed schemas and troubleshooting in the feature guide.

  Also correct directly relevant database-location prose. The current README repeatedly calls
  `~/.rfmedia/tracking.db` the default, including lines 1884-1898, 2541-2567, 3255-3258, and
  4974-4979. The authoritative current order in
  `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md:24-43` is existing XDG
  `~/.config/rfmedia/tracking.db`, then existing legacy `~/.rfmedia/tracking.db`, then XDG for a new
  writable database. At minimum, the new command section must state the correct order and must not
  repeat the legacy path as the universal default. A broad cleanup of all old README examples is
  documentation debt, not permission for `scan` to choose a different database.

- **Required — `docs/README.md`:** Add
  `packages/rfmedia-cli/docs/features/metadata-reconciliation.md` under **rfmedia CLI Features**
  (currently lines 77-103). The description should say “three-plane metadata report and
  preview-first repair” so it is not confused with the existing rfapps reconcile guide at lines
  56-59 or the Lidarr audit entry at lines 102-103.

- **Optional but recommended — `README.md`:** The root discovery page currently gives only copy,
  delete, and Plex playlist examples for rfmedia at lines 90-101. Add one concise
  `rfmedia reconcile scan ...` example and a link to the canonical guide. Do not add rfmedia flags
  to the following generic-looking option block at lines 103-114; that block is actually the rfapps
  surface.

### Update the database contract

- **Required — `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`:** Add metadata
  reconciliation as a consumer of `inventory`, without presenting inventory as a canonical global
  catalog. Preserve the documented schema-v11 table and explain:
  - rows are operation-scoped by the unique key shown at lines 82-105;
  - repeated destinations across operations can be ambiguous and `--operation-id` selects a
    generation;
  - `rating`, `genre`, `year`, `bpm`, and `artist` columns exist, but current production inventory
    creation generally persists only rating/stat/path/hash data, so `NULL` is absent evidence and
    never a `db-wins` instruction to clear another plane;
  - `scan` reuses the hardened read-only snapshot contract at lines 174-204 and never initializes,
    migrates, checkpoints, or creates the database;
  - preview apply also remains read-only;
  - executed apply opens writable SQLite only after authorization and updates exactly one selected
    row with expected-old-value guards and a short transaction;
  - stale rows remain historical evidence and are reported, not deleted;
  - file/server writes cannot share SQLite atomicity, so partial outcomes and a post-apply scan are
    required; and
  - issue #125 adds no table or migration. Keep “current schema version is 11” at lines 49-65 unless
    implementation actually changes the schema.

- **Optional cleanup — `packages/rfmedia-cli/docs/features/tracking-system.md`:** This older,
  range-focused guide is stale: line 11 and line 485 call `~/.rfmedia/tracking.db` the single
  database location; lines 475-481 stop schema history at version 3; and lines 498-499 list only
  tracking/history tables. Either update those statements to defer to
  `centralized-tracking-db.doc.md` or explicitly label this page as historical range-tracking
  detail. It should not become the reconciliation authority.

### Update structured-output and dry-run documentation

- **Required — `docs/features/output-formats.md`:** Preserve the shared root
  `--output <json|yaml|csv|table|text>` and `--json` rules at lines 1-24 and the stdout/stderr rules
  at lines 367-386. Correct the unsafe statement at lines 674-678 that machine formats suppress
  confirmation “equivalent to using `--yes`.” That cannot be true for
  `rfmedia reconcile apply --execute`: machine/non-interactive execution must explicitly require
  `--yes`, and selecting JSON/YAML/CSV must never authorize mutation. State that commands own their
  approval policy and that machine mode never prompts.

  A short reconcile example is useful, especially a fixed CSV row-kind note, but the complete
  reconciliation schema belongs in the new feature guide. Do not rely on the generic serializer's
  two-level flattening described at lines 317-341 for nested findings.

- **No change — `docs/features/dry-run-mode.md`:** This page explicitly documents rfapps Docker
  simulation (lines 1-22). Do not broaden it to rfmedia. The metadata guide must explain that
  preview is the default absence of `--execute`, not a root `--dry-run` flag.

- **No change — `docs/features/json-output.md`:** Despite its introductory cross-link, its actual
  contract and examples are rfapps-specific (lines 5-24 onward). The shared output page and new
  rfmedia feature guide are the correct homes.

- **No change — `docs/features/plan-apply-workflow.md`:** Reconciliation does not persist a sealed
  plan artifact. The new guide may cite report-first/revalidation concepts, but must explicitly say
  that each apply invocation reacquires evidence rather than consuming a saved plan.

### Update shell-completion documentation

- **Required — `packages/rfmedia-cli/docs/features/shell-completion.doc.md`:** Add the root
  `reconcile` parent, `scan`/`apply` leaves, static strategy values, and every leaf option. State
  that completion performs no file scan, database open, config/provider lookup, prompt, or write.
  Document Bash/Zsh/Fish parity and the reinstall/cache-refresh requirement after upgrading.

  This update should also repair existing dangerous stale prose:
  - lines 11-12, 83-84, and 210-221 enumerate a small historical command set and omit most current
    commands, not only the new `reconcile`;
  - lines 223-231 claim `--dry-run` is global, contradicting
    `packages/rfmedia-cli/README.md:86-89` and `src/cli.ts:77-89`;
  - the command-specific completion options must show `--execute`, `--allow-partial`, and `--yes`
    only on `apply`, and the three mutually exclusive winner flags only where valid. `scan` must not
    suggest mutation options.

- **Required implementation evidence, not prose-only —
  `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`:** These static templates are
  the executable command documentation. Add the root hierarchy and exact options to all three in
  one change and extend parity tests. Existing templates themselves incorrectly advertise
  `--dry-run` globally (`bash.ts:19-20`, `zsh.ts:11-19`, `templates.spec.ts:204-213`, and Fish token
  routing such as `fish.ts:1252-1257`); do not carry that false global into the new command.

### Record delivery

- **Required — `packages/rfmedia-cli/CHANGELOG.md`:** Add an `[Unreleased]` / `Added` entry
  describing the root `reconcile scan|apply` hierarchy, three-plane findings, the three authority
  strategies, preview-by-default `--execute` gate, capability-bounded repair, deterministic
  structured output, and tri-shell completion parity. Do not add a release date or claim support
  for arbitrary metadata writes.

- **Required after authoritative merge — `ROADMAP.md`:** Issue #125 currently appears in Current
  Focus at lines 50-51, the Parallel rfmedia Next Up row and exit criterion at lines 81-89, the
  medium backlog at lines 174-182, and the cross-cutting table at lines 273-280. After merge:
  - remove it from open Next Up/backlog positions;
  - change the drift/reconcile theme from “Metadata drift still open” to shipped;
  - summarize the delivered report/preview-first capability in Current Focus;
  - update the date and regenerate live open/rfmedia counts with the command at lines 285-289; and
  - use the actual merged PR number and state rather than a planned value.

- **Required after authoritative merge — `docs/roadmap-archive.md`:** Add #125 and its real closing
  PR to the shipped-work table, add a concise operator note covering read-only scan, default apply
  preview, `--execute` authorization, capability-bounded repair, and residual/partial reporting,
  and add the completed singleton rfmedia metadata-drift track to Former Next Up. The archive says
  it contains shipped work and real closing PRs (lines 1-14), so do not pre-populate it before merge.

## Related Documents to Cross-Link, Not Rewrite

- `packages/rfmedia-cli/docs/features/plex-metadata-sync.md`: The page accurately documents
  two-plane rating push/pull/both, explicit `--dry-run`, and `--prefer plex|file` at lines 1-18 and
  36-100. Add at most a short “use metadata reconciliation when SQLite inventory must participate”
  cross-link. Do not change `plex sync` behavior as part of #125.
- `packages/rfmedia-cli/docs/features/plex-lidarr-reconciliation.md`: This accurately describes
  artist-identity-only, report-only behavior at lines 3-12 and explicitly has no `--apply` at lines
  78-93. A short disambiguation link is optional; the new top-level guide must carry the primary
  distinction.
- `packages/rfmedia-cli/docs/features/media-server-adapter.md`: The current generic metadata
  capability is rating-only (lines 25-40), which is a material limitation to cite. Update the page
  only if implementation changes the adapter contract; adding reconciliation as a consumer is
  optional.
- `packages/rfmedia-cli/docs/features/conflict-resolution.md`: This is destination-file conflict
  policy for copy/verify, not metadata authority selection. Do not add `file-wins`/`db-wins`/
  `server-wins` here.
- `docs/features/rfapps-reconcile-command.md`: Useful safety precedent, but it documents Compose
  authority, `--auto-apply`, lifecycle locks, and a `reconcile.v1` service result. Do not reuse its
  command syntax or imply shared schemas.

## Planning-Document Conflicts to Resolve

- `docs/plans/125-metadata-drift-reconciliation/research-patterns.md:96-115` shows individual
  `--file-wins`, `--db-wins`, and `--server-wins` flags and discusses an optional `--dry-run`.
  The later feature spec settles the individual winner flags, adds explicit `--allow-partial`, and
  uses no explicit dry-run flag. User-facing docs and completions must follow the feature spec.
- `docs/plans/125-metadata-drift-reconciliation/research-integration.md:417-420` permits deleting
  stale rows on explicit apply, while
  `docs/plans/125-metadata-drift-reconciliation/feature-spec.md:154-162` says stale inventory is
  never deleted. Follow the feature spec.
- `docs/plans/125-metadata-drift-reconciliation/research-integration.md:360-363` says the default
  prefers an existing legacy database, while the current centralized database guide says existing
  XDG first, then legacy. Verify the implementation and make the feature guide, README, and database
  guide agree before release.
- Architecture/integration research sometimes describes broad metadata observation or updates.
  The feature spec's v1 field matrix and capability-bounded residual behavior are the release
  boundary; documentation must not promise title, album, BPM, artwork, multi-genre, or arbitrary
  file/provider writes.

## Pull Request and Contribution Documentation

- **Use without editing — `.github/pull_request_template.md`:** This is the authoritative PR body
  baseline. Preserve `Summary`, `Changes`, `Testing`, `Related Issues` with `Closes #125`,
  `Breaking Changes`, `Risk and Rollback`, and `Checklist`. Testing must list exact commands and
  pass/fail results, including focused reconciliation tests, database tests, command/output tests,
  tri-shell parity, typecheck/build/lint, and any architecture/graph checks actually run.
- **Drafting aid only — `docs/templates/github/pull-request.md`:** It is not byte-identical to the
  GitHub template and should not replace it. No template edit is required for #125.
- **No issue-template edit:** Existing issue #125 is already the authority. If a later arbitrary
  metadata-writer enhancement is filed, use `.github/ISSUE_TEMPLATE/enhancement.yml`; do not open a
  blank issue.

## Child Issue Decision

No child issue is required to ship #125. The settled feature spec intentionally keeps v1
capability-bounded: ratings can be repaired across all three planes, uniquely selected changed stat
evidence can be refreshed, and non-rating drift remains observation-only residual data.

If broad metadata mutation is requested later, file one focused follow-up enhancement for generic
field-level media-server capabilities, safe multi-tag file writers, inventory population/backfill,
and any needed schema changes. That is an independent expansion, not a blocker or hidden child of
issue #125. Longstanding global documentation cleanup (legacy tracking paths and exhaustive
completion inventories) may also be tracked separately if not repaired in this delivery, but the
safety-critical statements identified above must be corrected now.

## Architectural Documentation Patterns

- **One canonical operator guide:** README and index pages discover the feature; they do not
  duplicate every schema and edge case.
- **Winner is policy, not authority to execute:** one winner flag selects rating authority;
  `--execute` authorizes writes; confirmation or `--yes` approves them.
- **Read-only means no incidental persistence:** Document database creation, migration, sidecars,
  server cache writes, and history writes, not merely provider mutations.
- **Capabilities are explicit:** Report readable drift even when a target cannot be written, and
  retain unsupported residuals in every format.
- **Machine output is not consent:** Structured formats suppress prompts and keep stdout clean, but
  never synthesize `--yes`.
- **Historical inventory stays historical:** Exact row updates are allowed only when selected and
  revalidated; stale rows are findings, not cleanup candidates.

## Gotchas and Edge Cases

- `apply` is still a dry run by default. Documentation that says “apply changes” without
  `--execute` is materially unsafe.
- `--yes`, `--allow-partial`, or a winner flag without `--execute` must remain inert.
- The top-level name must always be written as `rfmedia reconcile`; unqualified `reconcile` is
  ambiguous with both rfapps and `rfmedia lidarr reconcile`.
- A missing DB value is not the same as a missing file tag, especially because current inventory
  producers leave several metadata columns `NULL`.
- A stale DB row is not permission to delete history or recreate a missing file.
- Exact path matching can fail when Plex and rfmedia see different mount prefixes; docs must not
  suggest basename fallback.
- MP3/FLAC are the only current file-rating write targets. OGG/Opus/M4A/AAC and non-rating writes
  must remain visible as unsupported.
- JSON/YAML can retain nested evidence; CSV needs an explicit fixed row union with a summary row so
  empty successful scans still emit a useful document.
- Drift findings normally exit successfully; evidence acquisition failures and incomplete
  authorized execution do not.
- Roadmap/archive prose and PR links must be based on merged reality, not the implementation plan.

## Relevant Docs

- `docs/plans/125-metadata-drift-reconciliation/feature-spec.md`
- `docs/plans/125-metadata-drift-reconciliation/research-architecture.md`
- `docs/plans/125-metadata-drift-reconciliation/research-integration.md`
- `docs/plans/125-metadata-drift-reconciliation/research-patterns.md`
- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`
- `packages/rfmedia-cli/docs/features/plex-metadata-sync.md`
- `packages/rfmedia-cli/docs/features/plex-lidarr-reconciliation.md`
- `packages/rfmedia-cli/docs/features/media-server-adapter.md`
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`
- `docs/features/output-formats.md`
- `docs/README.md`
- `README.md`
- `packages/rfmedia-cli/CHANGELOG.md`
- `ROADMAP.md`
- `docs/roadmap-archive.md`
- `.github/pull_request_template.md`
