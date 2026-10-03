# Issue #125 Metadata Reconciliation Pattern Research

The safest fit for issue #125 is a report-first, three-source reconciliation pipeline built from
the repository's existing command/action/library boundaries. The implementation should combine
the modern `rfmedia` output and error contracts with the stronger authorization ceremony used by
the existing plan/apply and `rfapps reconcile` flows; the older Plex sync action is useful for
rating conversion and adapter calls, but not as a safety template.

## Relevant Files

- `packages/rfmedia-cli/src/cli.ts`: Registers top-level Commander commands and global output
  options; a new top-level `reconcile` command belongs here.
- `packages/rfmedia-cli/src/commands/lidarr-reconcile.ts`: Best current example of a thin,
  dependency-injected command with validation before lazy action loading and stable machine
  envelopes.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Contains shared typed failure reporting and the
  reviewed plan/apply presentation flow.
- `packages/rfmedia-cli/src/actions/lidarr/reconcile.ts`: Read-only action that separates provider
  acquisition, complete bounded paging, cache persistence, and offline database access.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Enforces approval and dry-run constraints
  again at the action boundary before acquiring writable dependencies.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: Canonical confirmation behavior,
  including non-interactive and machine-output restrictions.
- `packages/rfmedia-cli/src/actions/plex-sync.ts`: Closest domain precedent for normalized
  file/server rating comparison and bidirectional updates.
- `packages/rfmedia-cli/src/lib/ratings.ts`: Canonical file-rating normalization and format-specific
  read behavior.
- `packages/rfmedia-cli/src/lib/metadata.ts`: Single-pass file metadata reads; currently returns
  `null` on parse failure, which needs a stricter reconciliation wrapper.
- `packages/rfmedia-cli/src/lib/tag-writer.ts`: Existing file-tag write boundary and unsupported
  format results.
- `packages/rfmedia-cli/src/lib/db.ts`: Inventory queries, transactional writes, and hardened
  read-only SQLite snapshots.
- `packages/rfmedia-cli/src/types/db.ts`: Inventory row and fingerprint types that define the
  persisted metadata available to reconciliation.
- `packages/rfmedia-cli/src/types/media-server.ts`: Provider-neutral rating types, capability
  contracts, and sanitized adapter error requirements.
- `packages/rfmedia-cli/src/lib/adapters/plex/metadata.ts`: Maps normalized ratings to Plex-native
  values and contains HTTP/cache behavior behind the adapter.
- `packages/rfmedia-cli/src/lib/formatters/index.ts`: Machine serializer selection and
  formula-neutral CSV projection.
- `packages/rfmedia-cli/src/lib/redact-error-message.ts`: Credential, URL-userinfo, query-secret,
  and terminal-control redaction.
- `packages/rfapps-cli/src/{commands,actions,lib}/reconcile.ts`: Strongest repository precedent for
  report-first reconciliation, dry-run vetoes, reviewed target lists, and late mutation dependency
  acquisition.

## Architectural Patterns

### Command, Action, and Pure Planning Separation

- The Commander module should own syntax, option conflicts, presentation, and exit semantics. It
  should validate cheap invariants before dynamically importing the action.
- The action should acquire adapters, file readers/writers, and database connections through
  injectable dependencies. It must repeat every mutation-safety invariant because callers can
  bypass Commander.
- A pure reconciliation library should normalize observations, classify drift, select a winner,
  and produce deterministic proposed writes. It should not open SQLite, parse files, call a media
  server, prompt, log, or mutate.
- Use discriminated unions rather than optional-field bags. Useful stable concepts include
  `ReconcileSource = "file" | "database" | "server"`,
  `ReconcileStrategy = "file-wins" | "db-wins" | "server-wins"`, and findings such as
  `missing-tag`, `conflicting-value`, `stale-db-entry`, `unreadable-file`,
  `unmatched-server-item`, and `ambiguous-path`.

### Collect Completely, Then Decide

- Scan all requested inventory rows and all bounded server pages before proposing any mutation.
  Follow the Lidarr reconciliation guards for changing totals, duplicate page items, stalled
  pagination, cancellation, and incomplete scope.
- Preserve raw source state separately from the canonical comparison value. In particular,
  `missing` must remain distinct from numeric zero, and parse failure must remain distinct from a
  missing tag.
- Sort findings and proposed writes by a stable identity before rendering or applying. A useful
  identity is the normalized inventory source plus relative path, augmented by a server item ID
  only after an unambiguous match.
- Path matching needs an explicit normalization/mapping policy. Do not copy the older Plex sync
  action's exact-string `filePath` map without addressing container paths, case sensitivity,
  symlinks, duplicate rows, and multiple server matches.

### Report-First Reconciliation

- `reconcile scan` is inherently read-only and returns findings, including stale SQLite entries,
  without treating ordinary drift as an operational failure.
- `reconcile apply` should run the same scan/planner and show the exact proposed targets and values.
  A strategy selects the authoritative source; it does not authorize mutation.
- A persisted plan artifact is unnecessary unless cross-process apply is a requirement. If plans
  are persisted later, use the sealed checksum, bounded-read, private atomic-write, and staleness
  patterns from `lib/lidarr/plan-engine.ts`.
- Immediately before each write, re-read the relevant source state and compare it to the reviewed
  observation. Abort that entry on change instead of applying a stale decision.

### Safe Authorization Ceremony

The recommended CLI contract is:

```text
rfmedia reconcile scan
rfmedia reconcile apply --file-wins
rfmedia reconcile apply --file-wins --execute
rfmedia reconcile apply --file-wins --execute --yes
```

- `apply` requires exactly one of `--file-wins`, `--db-wins`, or `--server-wins`.
- `apply` is preview-only by default, even when a winner strategy is present.
- Real mutation additionally requires `--execute`. This positive authorization is clearer than
  making users negate a default `--dry-run`.
- In an interactive terminal, `--execute` renders the deterministic reviewed target list and asks
  for confirmation with default No.
- In non-interactive or machine-output mode, real mutation requires both `--execute` and `--yes`;
  machine mode must never prompt.
- `--yes` only skips the prompt. It must never imply `--execute`, select a winner, or weaken
  preflight checks.
- If `--dry-run` is retained for consistency, it is an unconditional mutation veto even when
  `--execute` is present.
- The action must enforce the same matrix before opening writable SQLite, constructing writers, or
  calling adapter update methods.

### Database Read/Write Isolation

- Scan with `openDatabaseReadOnly`. Its snapshot, no-follow, sidecar, schema, and `query_only`
  protections are part of the expected safety contract.
- Put reconciliation queries behind named, typed persistence functions with bound parameters and
  unknown-row validation. Do not embed ad hoc SQL in the command.
- Open a writable database only after scan completion, strategy validation, execute authorization,
  and confirmation. Use a SQLite transaction for its own writes, while acknowledging that SQLite,
  file tags, and remote server updates cannot share one atomic transaction.
- A winner determines target writes explicitly: file-wins proposes database and server changes;
  server-wins proposes file and database changes; db-wins proposes file and server changes.
  Already-equal targets remain no-ops.

### Metadata and Adapter Boundaries

- Read tags through an injected wrapper around `ratings.ts`/`metadata.ts`, and write through
  `tag-writer.ts`. The wrapper should turn parse failures and unsupported formats into typed source
  observations rather than silently reporting a missing value.
- Keep all server reads and writes on `MediaServerAdapter`. The reconciliation action must not
  contain Plex HTTP paths or native-scale conversion.
- Compare canonical normalized values. Let the adapter perform native server-scale conversion and
  cache invalidation.
- Capture per-target outcomes. Because a file write, remote update, and SQLite commit are not
  jointly atomic, partial success must be reported honestly and followed by a fresh scan.

### Machine Output and Exit Semantics

- Follow the stable `{ command, result }` envelope used by modern `rfmedia` commands. The result
  should expose a versioned schema, operation, mode, strategy when applicable, dry-run/execute
  state, status, summary counts, deterministic entries, `success`, and `exitCode`.
- JSON and YAML should serialize the whole envelope. CSV needs fixed columns and explicit row
  kinds, with nested evidence serialized into neutralized cells.
- Human output and prompts go to stderr. Machine modes emit exactly one document to stdout and
  suppress progress/log noise.
- Set `process.exitCode`; never call `process.exit()`. Found drift is successful scan data and
  should normally exit zero. Invalid authority, incomplete evidence, stale preflight, or any failed
  or partial real apply should exit nonzero after output is emitted.

## Code Conventions

- Keep strict TypeScript with no `any`; validate `unknown` at file, database, and provider
  boundaries.
- Use NodeNext ESM imports with `.js` suffixes.
- Prefer readonly interfaces, frozen literal records, discriminated unions, and stable reason
  codes.
- Inject action dependencies and load the action lazily so command grammar and invalid-option
  tests cannot acquire provider, database, or writer resources.
- Keep ordering deterministic across human, JSON, YAML, and CSV output.
- Use conditional object spreads where fields are genuinely absent; do not serialize ambiguous
  `undefined` state.
- Reuse `formatOutput()` and the shared logger/output-mode suppression rather than writing directly
  to stdout.
- Use the formatter's CSV neutralization for paths, messages, and provider-controlled strings.
- A new top-level command also requires Bash, Zsh, and Fish completion template parity and the
  associated template tests.

## Error Handling

- Define typed errors for invalid strategy combinations, unsafe execution mode, incomplete scans,
  ambiguous identity, stale observations, malformed database rows, and unavailable adapter
  capabilities.
- Register error formatters before command execution and route unexpected errors through the shared
  failure envelope.
- Pass known sensitive values to `redactErrorMessage()`. Never expose raw provider bodies, request
  URLs containing credentials, nested causes, or database connection details.
- Treat source conditions as data when a user can act on them: missing tags, unsupported writable
  formats, unmatched server items, and stale inventory rows belong in findings with stable reason
  codes.
- Treat loss of trustworthy evidence as a fail-closed operational error: unreadable database,
  incomplete server paging, duplicate/ambiguous identity, or a source changing after review must
  prevent the affected write.
- Return per-target `applied`, `satisfied`, `skipped`, `failed`, or `stale` outcomes. Do not report
  whole-operation success after a partial cross-system update.

## Gotchas and Edge Cases

- The issue's affected paths omit `packages/rfmedia-cli/`, and the actual database module is
  `src/lib/db.ts`, not `src/lib/database.ts`.
- `rfmedia lidarr reconcile` already exists for a different, read-only Lidarr bridge-cache feature.
  A new top-level `rfmedia reconcile` needs distinct command identifiers and documentation.
- The older `plex sync` action is only a two-source file/server workflow and defaults to real
  execution. Reuse its normalized comparison and adapter seams, not its authorization defaults.
- `readExtendedMetadata()` currently logs and returns `null` after a parse failure. Reconciliation
  must not misclassify that as a missing tag.
- File formats do not have uniform write support. Existing OGG/M4A and other unsupported cases must
  remain explicit findings or failed proposed targets.
- Rating absence, numeric zero, and the server's minimum native rating can compare differently.
  Preserve absence in the source model and centralize equivalence rules.
- Active SQLite WAL, SHM, or rollback-journal sidecars intentionally make hardened read-only open
  fail closed.
- Duplicate inventory fingerprints are preserved and deterministically ordered. Do not silently
  select the first candidate.
- There is no transaction spanning the filesystem, SQLite, and the media server. Write ordering,
  partial outcomes, retry behavior, and post-apply rescan must be explicit.

## Testing Approach

### Smallest Critical Contract Set

The minimum high-value suite is:

1. **Command grammar and lazy loading**: scan loads no mutation dependency; apply rejects zero or
   multiple winner flags before loading the action.
2. **Pure planner table**: cover equal values, each single-source missing case, three-way conflict,
   stale database-only row, and ambiguous/unreadable evidence; assert deterministic proposed
   writes for all three winner strategies.
3. **Read-only scan integration**: use a real temporary SQLite fixture and injected file/server
   readers; assert findings while proving no database, tag, or adapter write occurs.
4. **Preview and authorization matrix**: for every strategy, default apply and explicit dry-run
   perform zero writes; prove that `--yes` alone and a strategy alone cannot mutate, machine execute
   without `--yes` fails, and declined interactive confirmation performs zero writes.
5. **One real apply seam per strategy**: inject spies and assert only the losing sources are
   updated, already-equal targets are skipped, and writable SQLite is acquired only after approval.
6. **Freshness and partial failure**: a changed source between review and write prevents that write;
   a later target failure yields stable partial outcomes and nonzero exit status.
7. **Output and secrecy**: JSON emits one parseable envelope before exit status is set; CSV columns
   are stable/formula-neutral; representative credential-bearing failures are redacted.

This set proves the safety and integration boundaries without duplicating the existing exhaustive
unit coverage for SQLite hardening, tag formats, provider-native rating conversion, or generic
formatters. Add narrow regression cases there only when reconciliation changes those modules.

### Existing Test Patterns to Reuse

- Use dependency injection and spies from
  `packages/rfmedia-cli/src/commands/lidarr-reconcile.test.ts` to prove validation occurs before
  action loading and machine output remains singular.
- Use real temporary SQLite files from `packages/rfmedia-cli/src/lib/db.test.ts` for read-only,
  bound-parameter, deterministic-order, and unchanged-file assertions.
- Reuse the no-write/claim/history assertions in
  `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts` for preview and unauthorized paths.
- Reuse the reviewed-list, decline, machine-mode, dry-run-veto, redaction, and output-before-exit
  cases in `packages/rfapps-cli/src/actions/reconcile.spec.ts`.
- Keep adapter and writer behavior mocked at the action boundary; their detailed HTTP and
  file-format behavior already belongs to their own unit suites.

## Patterns to Follow

1. Add a thin top-level command factory and dynamically load a reconciliation action.
2. Model all three source observations explicitly and build findings in a pure deterministic
   planner.
3. Complete and validate the entire scan before producing or applying a plan.
4. Make apply preview-only by default; require exactly one winner plus `--execute`.
5. Require default-No confirmation interactively and `--execute --yes` in machine or
   non-interactive mode.
6. Repeat authorization and freshness checks inside the action before acquiring mutation
   dependencies.
7. Keep scan on hardened read-only SQLite and delay writable SQLite until approval.
8. Use file tag helpers and provider-neutral adapters rather than direct filesystem-format or Plex
   protocol logic.
9. Emit deterministic versioned results, typed/redacted failures, and honest partial outcomes.
10. Update all three shell completion templates and protect the new contract with the minimal
    boundary-focused tests above.

## Relevant Docs

- [Issue #125](https://github.com/yandy-r/rfmedia-apps/issues/125)
- `docs/features/output-formats.md`
- `docs/features/plan-apply-workflow.md`
- `docs/features/rfapps-reconcile-command.md`
- `docs/plans/199-lidarr-artist-bulk-management/research-patterns.md`
- `packages/rfmedia-cli/docs/features/plex-configuration.md`
