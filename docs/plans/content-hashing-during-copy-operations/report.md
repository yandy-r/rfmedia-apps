---
title: Content Hashing During Copy Operations Implementation Report
date: 07/18/2026
original-plan: docs/plans/content-hashing-during-copy-operations/parallel-plan.md
---

## Overview

Completed issue #111 as a hardening and closeout of the schema-version-9 content fingerprint
foundation initially merged in PR #233. The implementation now rejects unsupported SQLite schemas
before writable initialization, validates every non-null persisted digest, propagates cancellation
through streamed hashing, removes only helper-owned partial outputs, and preserves inventory-before-
completion ordering across album/filter/sync flows. Focused and full regression coverage, controlled
benchmark evidence, canonical documentation, and ROADMAP state now describe the exact bounded
contract without adding a CLI/MCP/completion surface or a new schema model.

## Files Changed

### Created

- `docs/plans/content-hashing-during-copy-operations/analysis-code.md`: Condensed source-pattern analysis.
- `docs/plans/content-hashing-during-copy-operations/analysis-context.md`: Actionable architecture and constraints.
- `docs/plans/content-hashing-during-copy-operations/analysis-tasks.md`: Dependency and file-ownership analysis.
- `docs/plans/content-hashing-during-copy-operations/benchmark-results.md`: Raw repeated benchmark evidence and conclusion.
- `docs/plans/content-hashing-during-copy-operations/feature-spec.md`: Authoritative design and acceptance contract.
- `docs/plans/content-hashing-during-copy-operations/parallel-plan.md`: Validated dependency-aware implementation plan.
- `docs/plans/content-hashing-during-copy-operations/research-architecture.md`: Codebase architecture research.
- `docs/plans/content-hashing-during-copy-operations/research-business.md`: Business rules and scope research.
- `docs/plans/content-hashing-during-copy-operations/research-docs.md`: Documentation inventory and gaps.
- `docs/plans/content-hashing-during-copy-operations/research-external.md`: Node, stream, and SQLite API research.
- `docs/plans/content-hashing-during-copy-operations/research-integration.md`: CLI, MCP, queue, database, and FFmpeg integration research.
- `docs/plans/content-hashing-during-copy-operations/research-patterns.md`: Repository implementation and testing patterns.
- `docs/plans/content-hashing-during-copy-operations/research-practices.md`: Reuse and modularity guidance.
- `docs/plans/content-hashing-during-copy-operations/research-recommendations.md`: Consolidated bounded strategy.
- `docs/plans/content-hashing-during-copy-operations/research-security.md`: Failure, trust-boundary, and dependency analysis.
- `docs/plans/content-hashing-during-copy-operations/research-technical.md`: Technical architecture and data contract.
- `docs/plans/content-hashing-during-copy-operations/research-ux.md`: Compatibility and feedback behavior.
- `docs/plans/content-hashing-during-copy-operations/shared.md`: Verified implementation context.
- `docs/plans/content-hashing-during-copy-operations/report.md`: Current implementation and validation report.
- `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md`: Canonical user/maintainer fingerprint guide.
- `packages/rfmedia-cli/src/actions/sync.test.ts`: Focused sync hash persistence and failure-order coverage.

### Modified

- `ROADMAP.md`: Marks all three #111 references implemented by PR #233 and completed by PR #248.
- `docs/features/file-integrity-verification.md`: Separates explicit read-back verification from persisted fingerprints.
- `packages/rfmedia-cli/README.md`: Corrects inventory producer/schema claims and documents fingerprint semantics.
- `packages/rfmedia-cli/benchmarks/helpers.ts`: Adds a benchmark-only exact track-size fixture control.
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`: Replaces obsolete schema-v1/sync-only guidance with schema v9.
- `packages/rfmedia-cli/docs/features/graceful-interruption.md`: Documents signal-aware hashing and new-path-only cleanup.
- `packages/rfmedia-cli/docs/features/performance-benchmarks.md`: Records the paired method, variance, and inconclusive result.
- `packages/rfmedia-cli/docs/features/sync-command.doc.md`: Documents SQLite/legacy hash behavior and range identity.
- `packages/rfmedia-cli/src/actions/copy-album.test.ts`: Adds method, ordering, failure, dry-run, and cancellation proof.
- `packages/rfmedia-cli/src/actions/copy-album.ts`: Passes wrapper abort state and normalizes parallel inventory/completion failures.
- `packages/rfmedia-cli/src/actions/copy-filter.test.ts`: Adds final-path and failure-before-completion coverage.
- `packages/rfmedia-cli/src/lib/db.test.ts`: Adds schema immutability, hash validation, and batch rollback tests.
- `packages/rfmedia-cli/src/lib/db.ts`: Adds read-only compatibility preflight and shared digest validation.
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`: Adds hardlink, abort, retry, cleanup, and ownership tests.
- `packages/rfmedia-cli/src/lib/filesystem.ts`: Propagates aborts, preserves error identity, and bounds cleanup ownership.
- `packages/rfmedia-cli/src/lib/inventory.test.ts`: Proves present, `null`, and omitted hash mappings.

## New Features

**Pre-mutation schema compatibility**: Existing databases are probed read-only and future or
malformed schema metadata is rejected before WAL-changing pragmas or schema DDL.

**Trusted digest persistence**: Both single and transactional batch inventory APIs accept only
lowercase 64-character SHA-256 values when a digest is present; legacy `null` remains compatible and
an invalid batch rolls back atomically.

**Signal-aware streamed fingerprints**: Regular copies pass the action `AbortSignal` through Node's
pipeline while every retry receives fresh streams, transform, and hash state.

**Ownership-bounded recovery**: Cancellation or exhausted copy failure removes only a destination
that did not exist before the helper invocation, preserving pre-existing user paths and the primary
error classification.

**Consistent action completion**: Album parallel suffixes count and report success only after
inventory persistence and granular completion succeed; filter and sync ordering are protected by
focused regression tests.

**Reproducible performance evidence**: Benchmark fixtures can select exact per-track bytes through a
benchmark-only environment variable. Three small-file and three representative repetitions are
recorded as inconclusive against the `<5%` direct-copy target because variance crosses the threshold.

**Canonical fingerprint documentation**: User and architecture guides now define final-artifact
fingerprints, legacy unknown values, conversion/hardlink behavior, tracking prerequisites, failure
semantics, and the boundary with `--verify` and issue #116.

## Additional Notes

- No runtime dependency, configuration key, migration, schema version, table, index, CLI option,
  MCP field, output field, or shell completion content was added.
- Schema version remains 9. Existing version-8 rows migrate with `content_hash = NULL`; there is no
  automatic backfill.
- Stored hashes are expected write/finalization-time fingerprints. They are not destination
  read-back verification or authenticity proof. Hardlink fingerprints can become stale after inode
  mutation.
- The bounded inventory scope remains album/filter copy and sync plus queue/MCP delegation. Plex
  query copy, playlists, repair/video-link writes, and untracked watch execution remain deferred
  until they have a durable artifact/operation identity.
- The representative direct-copy benchmark is **inconclusive**, not a pass or regression:
  independent paired overhead ranged from `-15.83%` to `+112.70%` on an unpinned local host.
- Repository-wide Markdown lint currently reports four bare-URL errors in the archived
  `docs/prps/plans/completed/content-hashing-during-copy-operations.plan.md`; all current planning,
  implementation, and documentation files pass scoped linting.
- The user's global Git `core.whitespace` includes `indent-with-non-tab`, which conflicts with the
  repository's Prettier space indentation. Repository-compatible trailing-space/space-before-tab
  diff validation passes.

## Validation Evidence

- `npm run typecheck -w packages/rfmedia-cli`: passed, including benchmark TypeScript.
- `npm run test:run -w packages/rfmedia-cli`: passed, 63 files and 1,636 tests.
- `npm run build:rfmedia`: passed for `rf-common` and `rfmedia-cli`, including schema asset copy.
- `src/lib/shell-completions/templates.spec.ts`: passed within the full suite, 12 tests; completion
  source files are unchanged.
- Queue/MCP focused regression: passed, 57 tests across three files.
- Database/filesystem focused regression: passed, 66 tests across two files.
- Album/filter/sync/inventory focused regression: passed, 109 tests across four files.
- Repeated benchmark commands: passed; conclusion recorded as inconclusive.
- `npm run format:check`: passed for the full repository.
- Feature-research, feature-spec, shared-context, and parallel-plan validators: passed.
- Scoped Markdown lint for current artifacts: passed with zero errors.
- `git -c core.whitespace=trailing-space,space-before-tab diff --check`: passed.

## E2E Tests To Perform

### Test 1: Regular Copy Fingerprint

**Steps:**

1. Run a database-tracked `rfmedia copy` for a small album without conversion or hardlinks.
2. Query the resulting `inventory` rows in the selected tracking database.
3. Recompute SHA-256 from each final destination with an independent checksum tool.

**Expected Result:**

Every successful new row has a lowercase 64-character `content_hash` matching the final destination,
and the normal CLI output does not print the digest.

**Edge Cases:**

- Repeat with `--dry-run`; no file, schema, inventory, or hash work should occur.
- Repeat with completed tracking disabled or legacy tracking; no hidden SQLite hash row should be
  created.

### Test 2: Conversion and Hardlink Semantics

**Steps:**

1. Copy one album with conversion enabled and inspect the converted destination hash.
2. Copy another album with hardlink mode on a same-filesystem destination.
3. Compare the stored values with independent hashes of the final paths.

**Expected Result:**

The conversion row identifies converted output bytes. The hardlink row identifies the shared inode's
bytes at capture time, and both actions complete only after inventory persistence.

**Edge Cases:**

- Mutate a hardlink through either path and confirm documentation correctly treats the prior hash as
  a snapshot rather than automatic verification.
- Use a cross-filesystem hardlink request and confirm fallback copy behavior remains successful.

### Test 3: Cancellation and Partial Destination Cleanup

**Steps:**

1. Start a tracked copy of a sufficiently large file into a destination that does not yet exist.
2. Interrupt the command while bytes are streaming.
3. Repeat against a deliberately pre-existing destination path.

**Expected Result:**

The new partial destination is removed, no inventory/completion success is recorded, and the command
reports interruption. A path that existed before the helper invocation is not recursively removed.

**Edge Cases:**

- Interrupt during hardlink snapshot hashing.
- Trigger an exhausted transient write failure and confirm the same ownership rule.

### Test 4: Database Compatibility and Validation

**Steps:**

1. Open a copy tracking database with schema version 8 and perform a tracked copy.
2. Snapshot a synthetic version-10 database, attempt to open it with the current CLI, and compare the
   database plus journal sidecars afterward.
3. Exercise the single/batch inventory APIs with a malformed non-null digest in a development test
   harness.

**Expected Result:**

Version 8 migrates to 9 with historical hashes left `NULL`. Version 10 is rejected without schema or
journal-mode mutation. Malformed digests fail, and a mixed invalid batch commits no rows.

**Edge Cases:**

- Existing empty database files initialize normally.
- Missing or malformed schema metadata is rejected rather than treated as version zero.

### Test 5: Queue, MCP, and Completion Compatibility

**Steps:**

1. Execute equivalent album/filter copy and sync requests through the queue and MCP adapters.
2. Generate Bash, Zsh, and Fish completion output before and after the change.
3. Compare normal text and structured command results.

**Expected Result:**

Delegated actions persist the same fingerprints, while queue/MCP schemas, result fields, normal
output, and completion content remain unchanged.
