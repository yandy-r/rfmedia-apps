# UX Research: Plex Adapter Refactor

## Executive Summary

The successful user experience for GitHub issue #119 is deliberate invisibility. The refactor
should reduce Plex platform risk without asking users to learn a new command, change configuration,
rewrite automation, reinterpret output, or troubleshoot a new layer. `rfmedia plex` is an existing
product surface, while `MediaServerAdapter` is an internal architecture surface. Those concerns
must not be conflated.

The current CLI already has a broad and mature Plex workflow:

- `rfmedia plex query run|list`
- `rfmedia plex copy query-results|query`
- `rfmedia plex playlist export|sync|list|create|add`
- `rfmedia plex sync push|pull|both`
- `rfmedia plex collection create|add|list|show|delete`

Users can override configuration through `--plex-url` and `--plex-token`, preview mutations through
command-local `--dry-run`, control scans through existing `--plex-scan`/`--no-plex-scan` flags, and
request text, JSON, YAML, CSV, or table output through the existing global output contract. Human
tables and progress are separated from machine output; failed item counts set a non-zero exit
status; destructive collection deletion has `--yes`; and Bash, Zsh, and Fish templates describe
the complete nested command tree.

The UX risk in this refactor is accidental semantic drift at the adapter boundary. Renaming a
command “server” instead of “plex,” normalizing a JSON field, changing an error prefix, turning an
optional scan warning into a fatal error, replaying a mutation after JWT refresh, or adding cache
status to stdout would all be user-facing regressions even if unit-level API behavior remained
correct.

**Shell completions do not need to change for the planned refactor.** No command, subcommand,
argument, or option should be added, removed, or renamed. The current Bash, Zsh, and Fish templates
must remain behaviorally identical and their parity tests must continue to pass. The only reason to
change all three would be a separately approved additive authentication option; the preferred JWT
UX is to let the existing `plex.token`/`--plex-token` credential slot accept the supported token
form so no new CLI surface is necessary.

## User Workflows

### Primary workflow: query and inspect Plex media

1. The user runs `rfmedia plex query run`, optionally providing `--library`, `--type`, rating or
   metadata filters, a named `--filter`, and Plex connection overrides.
2. The CLI keeps current precedence: explicit CLI values override named-filter/config values, and a
   named filter can provide library/type defaults.
3. The internal adapter authenticates, resolves the library, queries Plex, translates the result,
   and paginates without exposing adapter concepts.
4. Text mode prints the existing Tracks, Albums, or Artists table with counts and star formatting.
   Empty matches remain a successful “No ... found” state, not an infrastructure error.
5. Machine mode returns the existing `command: "plex-query"` envelope and unmodified result schema.
   Saved-query behavior and `--no-save` remain unchanged.

Alternative paths:

- `rfmedia plex query list` reads prior saved queries without requiring new adapter terminology.
- `--json` remains shorthand for global `--output json`; explicit `--output` retains precedence and
  the current warning when both conflict.
- A named filter can supply library/type; a missing named filter continues to list available names.

### Primary workflow: copy from a live or saved Plex query

1. The user chooses `plex copy query <destination>` or `plex copy query-results <destination>`.
2. The CLI preserves all current copy choices: hardlink/convert, folder structure, workers, range or
   count, rating sync, fail-fast, dry-run, and scan control.
3. The adapter supplies media paths and optional scan behavior; the copy engine remains the visible
   owner of file creation, skipped/failed counts, and safety warnings.
4. Machine output remains `command: "plex-copy"` with `created`, `skipped`, `failed`, and
   `totalSize`. Any failed operations preserve non-zero exit behavior.
5. An optional Plex scan failure remains a warning after successful copying rather than rewriting
   the copy result as an adapter failure.

Alternative paths:

- `--dry-run` previews without copying, rating writes, or scanning.
- `--no-plex-scan` suppresses the post-copy scan without suppressing the query/copy itself.
- A query returning zero matches preserves the existing warning/success behavior rather than
  manufacturing an error solely because the adapter returned an empty collection.

### Primary workflow: export, synchronize, or manage a playlist

1. The user lists playlists or names a playlist for export/sync/create/add.
2. Case-insensitive lookup and the existing “Available audio playlists” recovery hint remain.
3. Create/add queries tracks with the existing filter options. Export/sync performs file work and
   reports current counts; sync may remove files only under its existing explicit option.
4. Machine output keeps the existing discriminators:
   `plex-playlist-list`, `plex-playlist-export`, `plex-playlist-sync`,
   `plex-playlist-create`, and `plex-playlist-add`.
5. Playlist rating keys, counts, action values (`created`/`updated`), and optional removed counts
   remain schema-compatible.

Alternative paths:

- Dry-run previews create/add/export/sync without mutation.
- `--update-existing` retains its current meaning rather than being inferred by the adapter.
- Empty filter results remain an actionable “No tracks added” outcome.

### Primary workflow: synchronize ratings

1. The user chooses `plex sync push`, `pull`, or `both` and supplies a source path/library.
2. Existing 1-5-star and file-tag language remains visible; Plex's 0-10 protocol scale stays hidden
   inside the adapter/rating conversion layer.
3. The CLI preserves worker count, progress, only-rated, POPM email, Vorbis scale, dry-run, and
   bidirectional conflict preference.
4. Text mode retains the Total/Synced/Skipped/Conflicts/Failed summary. Machine mode retains
   `command: "plex-sync-{mode}"`, including `failedCount` and the `failed` array.
5. Partial item failures continue to produce a non-zero exit status while preserving successful
   item counts for recovery.

Alternative paths:

- Dry-run lets users validate matching and conflict resolution without writing Plex or file tags.
- No matched tracks continues to explain that file paths should be checked.
- An interrupted confirmation remains “Operation aborted,” with no new adapter jargon.

### Primary workflow: manage collections

1. The user selects `collection create`, `add`, `list`, `show`, or `delete`, usually with a library.
2. Existing `--type`, `--mode`, and `--add-track|album|artist` relationships and conflict errors
   remain at the command layer.
3. The adapter translates the chosen media kind to Plex-specific metadata behavior.
4. List/show/create/add/delete keep their existing human messages and the existing
   `plex-collection-*` machine envelopes, including current `mediaType` and `metadataType` fields.
5. Delete retains confirmation and `--yes`; deleting the collection does not delete media.

Alternative paths:

- `--from-folder` remains track-only and continues to explain mount/path mismatch when files cannot
  be matched.
- Deprecated `--min-stars` continues to warn and direct users to `--min-track-stars` during the
  existing compatibility period.
- Smart collections remain track-only and explain the valid replacement when another type is used.

### Alternative workflow: optional scan after non-Plex media operations

Copy, delete, sync, queue, watch, and playlist actions can request Plex scanning without becoming
Plex-first workflows. If scanning is disabled, no adapter is created and primary media work
continues. If scanning is requested but URL/token is unavailable or invalid, the current warning is
shown and scanning is skipped. Mapped destinations request the narrow path scan; lookup failure
warns and falls back to a full scan. This best-effort contract is an important UX distinction from
required query/CRUD operations, which fail when Plex is unavailable.

## CLI UX Best Practices and Accessibility

### Stability and predictability

- Treat command paths, positional argument order, short aliases, long option names, defaults,
  negatable flags, and option precedence as compatibility contracts.
- Preserve `rfmedia plex`; do not introduce a parallel `rfmedia server` namespace in this issue.
  A future generic alias can be additive only after its behavior and migration policy are designed.
- Preserve exact machine-output command discriminators and field names. Internal generic names
  must be translated back to the existing Plex schemas at the command boundary.
- Preserve exit status meaning. Zero means the command's requested work met its current success
  rule; partial item failures continue to set status 1. An optional post-operation scan does not
  silently change the primary operation's established result.
- Keep dry-run visibly non-mutating across server writes, file writes/deletes, rating changes, and
  scans. Adapter initialization or capability checks must not create mutation side effects.

### Actionable errors and recovery

- Lead errors with the failed user operation, then state the cause and recovery. Existing prefixes
  such as `Copy failed`, `Collection create failed`, and `Plex scan failed` should remain where
  callers/tests rely on them.
- Keep Plex-specific recovery language where users must act on Plex configuration (“check your plex
  token,” available Plex libraries/playlists). Do not replace it with vague “adapter unavailable.”
- Keep validation local and early: mutually exclusive options, missing library, unsupported smart
  type, and bad numeric/rating values should fail before network or file mutation.
- Distinguish empty success (“No tracks found matching the criteria”) from unavailable server,
  invalid response, and authentication failure.
- When JWT recovery is introduced, do not narrate refresh internals during success. On final failure,
  explain the user-owned remedy without printing credential contents.

### Output channels and automation accessibility

- Preserve machine output on stdout and human diagnostics/progress on stderr as currently intended.
  Adapter debug/cache/auth messages must not contaminate JSON/YAML/CSV output.
- Continue disabling progress rendering for machine formats. A refactor must not add spinners,
  retry counters, or cache-hit text to structured output.
- Avoid ANSI/color in machine formats. In human output, color may reinforce state but must not be
  the only signal; the existing textual labels, counts, warnings, and exit status carry meaning.
- Preserve deterministic field names and collection ordering where current tests/consumers observe
  them. Do not expose nondeterministic cache or retry timing in outputs.
- Keep errors concise at normal verbosity and put implementation detail behind `--debug`. Debug
  output still must redact token/JWT values and credential-bearing URLs.

### Keyboard, shell, and non-interactive use

- Every operation remains fully operable through flags/arguments; no new mandatory interactive
  prompt is appropriate for an internal refactor.
- Destructive collection deletion retains `--yes`. Machine/non-interactive behavior must never hang
  waiting for input.
- Preserve shell-native nested completion for all command paths and dynamic named-filter completion.
  Completion helpers must not contact Plex merely to render the static command surface.
- Prefer configuration templates and `--use-dotenvx`/`--use-op` for credentials. The existing
  `--plex-token` override must remain, but documentation should continue to discourage secrets in
  shell history and process listings.
- Signals/aborts should not be swallowed by auth retry or pagination. An interrupted operation must
  stop promptly and retain current partial-result/cleanup behavior.

### Help and terminology

- Keep “Plex,” “library,” “playlist,” “collection,” “track,” “album,” and “artist” in user-facing
  help. These are the user's concepts for this namespace, even if internal types become generic.
- Keep star values described as 1-5. Do not surface Plex's protocol-level 0-10 rating scale in CLI
  flags.
- If an adapter capability is unsupported, name the unavailable feature and the relevant Plex
  context; do not expose class names, capability keys, or implementation paths.
- No help text should claim JWT refresh or Sonic Analysis support until those behaviors are defined
  and tested. Capability metadata alone is not a new user feature.

## Error States and Recovery

| Error state                                  | Current visible behavior                                                                  | User recovery                                                          | Refactor requirement                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Required Plex URL/token missing              | `Plex URL and token are required. Set in config or use --plex-url and --plex-token`       | Add `plex.url`/`plex.token`, inject template values, or pass overrides | Preserve message intent, failure timing, and non-zero status                                |
| Optional scan disabled                       | No adapter and no Plex request                                                            | None; enable scan explicitly/configure it if wanted                    | Remain a silent skip, not an error                                                          |
| Optional scan requested with unusable config | Warning: scan requested but URL/token is missing or invalid; scan skipped                 | Fix config/overrides, or disable scan                                  | Primary file operation remains successful under existing rules                              |
| Invalid Plex URL                             | Required mode throws `Invalid Plex URL format: ...`; optional mode warns/skips            | Supply a valid HTTP(S) base URL                                        | Keep required/optional distinction; do not reveal credentials                               |
| Legacy token rejected (401)                  | `Authentication failed (401) - check your plex token` or unsuccessful scan/rating result  | Replace token/config or override with a valid credential               | Preserve operation-specific throw/result contract and status                                |
| JWT expired or rejected                      | Not currently implemented; would surface as the same 401                                  | Refresh/replace credential if bounded adapter recovery cannot do so    | Recover internally at most once where safe; final UX must remain actionable and secret-free |
| Auth recovery on a mutation                  | No current JWT retry path                                                                 | Retry manually only if the result is known not to have applied         | Never blindly replay create/add/delete/rating mutations when outcome is ambiguous           |
| Connection refused                           | Scan/rating results identify the configured server; query/CRUD network error propagates   | Start Plex, fix host/port, then retry                                  | Preserve recognizable cause and avoid “adapter unavailable”                                 |
| DNS/host resolution failure                  | Scan result says `Could not resolve host`                                                 | Fix hostname/DNS/config                                                | Preserve distinct recovery from timeout/auth                                                |
| Request timeout                              | Scan/rating result says connection timed out; other operations reject                     | Check Plex/network/load and retry                                      | Keep bounded timeout, support cancellation, and do not cache failure                        |
| Other Plex HTTP error                        | Operation-specific `Failed to ...: HTTP <status>` or scan result `HTTP <status>`          | Inspect Plex/service state; retry when safe                            | Preserve operation context and status code                                                  |
| Malformed Plex response                      | Examples include invalid server/library/collection/playlist data                          | Check Plex version/API response; use debug diagnostics                 | Fail explicitly rather than displaying empty success; redact response secrets               |
| Library not found                            | Names the requested library and lists available libraries                                 | Correct `--library` or config mapping                                  | Keep case-insensitive lookup and available-values hint                                      |
| Named filter missing                         | Names filter and reports available configured filters                                     | Correct `--filter` or update `plexFilters`                             | Preserve precedence and suggestion quality                                                  |
| Saved query missing                          | `Query not found: <id>`                                                                   | Run `plex query list` and choose an existing ID                        | Adapter refactor must not alter database lookup behavior                                    |
| Query has no matches                         | Human warning/empty table state; no infrastructure error                                  | Broaden filters or select another library/type                         | Remain a valid empty result with stable machine schema                                      |
| Copy query is not track type                 | Explains that Plex copy supports track queries                                            | Use `--type track`                                                     | Validate before file mutation                                                               |
| Playlist not found                           | Names playlist and lists available audio playlists                                        | Correct name or use `plex playlist list/create`                        | Preserve case-insensitive lookup and recovery hint                                          |
| Collection not found                         | Names collection/key and fails relevant operation                                         | Correct name/library or use collection list                            | Preserve 404 distinction and avoid mutation                                                 |
| Collection library missing                   | `Library name is required...` with flag/filter guidance                                   | Add `--library` or filter library                                      | Validate before adapter call                                                                |
| Conflicting collection mode flags            | Names conflicting `--type`/`--mode`/alias options                                         | Choose one compatible selector                                         | Keep early, specific command-level validation                                               |
| Smart non-track collection                   | Explains smart collections support track mode                                             | Use track or remove `--smart`                                          | Do not delegate an invalid request then expose a Plex HTTP error                            |
| `--from-folder` mismatch/no audio            | Explains missing folder, no audio, or mount/path mismatch; may list first unmatched files | Correct folder/mount mapping or select tracks by filter                | Preserve bounded examples and actionable path guidance                                      |
| No tracks matched for rating sync            | Warns to check file paths                                                                 | Correct local/Plex path mapping                                        | Remain warning/summary behavior rather than generic adapter failure                         |
| Partial copy/sync item failures              | Successful counts retained; failed count/list shown; exit status 1                        | Fix listed failures and rerun safely                                   | Preserve counts, details, and non-zero status                                               |
| Optional post-operation scan fails           | `Plex scan failed: <reason>` warning                                                      | Retry scan/fix Plex; copied files remain copied                        | Do not rewrite primary result or roll back successful media work                            |
| Destructive delete not confirmed/aborted     | Prompt unless `--yes`; abort leaves collection intact                                     | Confirm or rerun with `--yes` intentionally                            | No adapter mutation before confirmation; non-interactive use must not hang                  |
| Unsupported adapter feature                  | No Sonic-specific flow currently exists                                                   | Choose supported behavior/context                                      | If surfaced later, name feature and fallback; do not expose internal capability identifiers |
| Cache miss/expiry/invalidation               | Not user-visible except debug cache logs                                                  | None                                                                   | Stay transparent; never add cache metadata to stable output                                 |

## Performance UX

- **Startup:** `commands/plex.ts` lazy-loads action handlers. Preserve lazy imports so moving code
  behind the adapter does not make `rfmedia --help`, completion generation, or unrelated commands
  pay Plex client initialization cost.
- **Completion latency:** Static command/flag completion and dynamic configured-filter completion
  must remain local. The refactor must not instantiate the adapter, validate credentials, or call
  Plex during shell completion.
- **Cache transparency:** The existing cache is opt-in with a 300-second default TTL when enabled.
  Hits should reduce latency without changing order, schema, messages, or rate-limit behavior that
  users can observe. Cache keys and debug logs must not contain tokens/JWTs.
- **Perceived progress:** Long copy, playlist, and sync workflows retain progress in human mode and
  suppress it in machine mode. Adapter pagination/auth recovery should feed existing progress/count
  behavior rather than introduce a second progress UI.
- **Timeouts and pacing:** Existing live requests generally use a 30-second timeout and 100 ms
  pacing. Preserve bounded waiting and avoid stacking multiple timeout/retry layers that make a
  command appear hung. A single auth recovery attempt must honor the overall cancellation budget.
- **Pagination:** Large libraries/playlists/collections must continue progressing without skips or
  duplicates. Do not wait for the entire library when current commands can return a limited page;
  commands that intentionally fetch all items should retain debug/progress evidence.
- **Mutation batching:** Preserve current batching/warnings and collection fallback behavior.
  Performance optimization must not trade away clear partial-failure reporting or duplicate
  mutations after auth retry.
- **Optional operations:** Optional scanning should never delay primary work when disabled or
  unconfigured. When enabled, retain the narrow path scan where possible rather than broadening to
  a slower full scan except for the existing documented fallback.
- **Machine stability:** Do not emit cache-hit, token-refresh, retry, or adapter-selection messages
  to stdout. Automation performance includes not having to filter new noise.

## Comparison With Current Behavior and Equivalent CLIs

### Current `rfmedia plex` behavior versus the target

| UX dimension          | Current behavior                                                         | Target after refactor                                                                          |
| --------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Namespace             | Explicit `rfmedia plex` nested commands                                  | Identical                                                                                      |
| Connection overrides  | `--plex-url`, `--plex-token`; CLI overrides config                       | Identical                                                                                      |
| Query/filter language | Plex libraries; track/album/artist; 1-5 stars                            | Identical                                                                                      |
| Human rendering       | Tables, textual summaries, warnings, progress                            | Identical observable content and channels                                                      |
| Machine rendering     | Stable `plex-*` command envelopes and result fields                      | Identical schemas; internal generic models translated at command boundary                      |
| Mutation safety       | Command-local dry-run, delete confirmation, partial failures             | Identical; adapter adds no hidden mutation                                                     |
| Optional scan         | Disabled/unavailable scan does not block primary work                    | Identical                                                                                      |
| Errors                | Plex-specific, operation-oriented messages; mixed throw/result contracts | Identical external contract, even if internally normalized                                     |
| Caching               | Opt-in, debug-visible, otherwise transparent                             | Identical UX with adapter-owned implementation                                                 |
| Authentication        | Legacy token only                                                        | Legacy token unchanged; JWT handling internal unless a future approved addition is unavoidable |
| Completions           | Hand-maintained Bash/Zsh/Fish templates plus parity tests                | No change required; all existing tests pass                                                    |

### Sibling `rfapps` CLI

`rfapps` is the closest equivalent CLI because it shares repository conventions and users. It also
preserves a legacy `--json` shorthand alongside `--output`, warns when both are supplied, uses
dry-run/confirmation controls for mutations, and separates machine-readable output from human
diagnostics. The Plex refactor should align with those cross-CLI expectations rather than inventing
adapter-specific flags or output. Importantly, architecture changes inside Docker orchestration do
not rename user concepts; the same principle supports retaining `rfmedia plex` while replacing its
implementation boundary.

### Commander-based command model

The current implementation uses Commander nested commands, required options, choices, conflicts,
and negatable `--no-*` options. Users experience the generated parser/help contract, not the
underlying adapter. Therefore the strongest compatibility check is generated help plus command
parsing snapshots/tests for every Plex leaf command. Internal method names are irrelevant if the
same argv produces the same validation, action inputs, output, and exit status.

### Future media-server CLIs

OpenSubsonic/Navidrome support should eventually receive its own accurately named surface or an
explicitly designed generic surface. It should not be smuggled into #119 by renaming existing Plex
commands. A shared internal adapter does not require identical user terminology or capabilities;
truthful backend-specific help is more usable than a lowest-common-denominator CLI.

No external UX source is necessary to establish these requirements: the repository's current
commands, tests, formatter contract, docs, and sibling CLI are the authoritative compatibility
baseline for this internal refactor.

## Prioritized Recommendations

### P0 — Release blockers

1. **Freeze the full CLI contract.** Add/retain tests for every Plex leaf command's generated help,
   positional arguments, flags, aliases, defaults, conflicts, and negatable options. Do not rename
   `rfmedia plex` or any `--plex-*` flag.
2. **Freeze machine schemas.** Snapshot or schema-test every existing `plex-*` command discriminator
   and result field, including collection `metadataType`, playlist `ratingKey`, sync failure arrays,
   and copy/playlist count fields.
3. **Preserve error and exit behavior.** Contract-test required versus optional adapter resolution,
   401/404/network/malformed responses, partial failures, and optional scan warnings at command
   boundaries, not only inside the adapter.
4. **Keep authentication invisible on success.** Accept existing token configuration unchanged;
   contain JWT selection/recovery inside the adapter; redact secrets; never blindly replay an
   ambiguous mutation.
5. **Keep completions unchanged.** Run Bash/Zsh/Fish template tests and verify all current Plex
   command/flag blocks remain. Do not edit completion templates solely because internal types or
   filenames changed.
6. **Protect output channels.** Ensure adapter debug/cache/auth logs cannot contaminate machine
   stdout and that progress remains disabled in JSON/YAML/CSV modes.

### P1 — Important quality safeguards

7. **Use command-boundary translation.** Let actions/adapters use server-neutral internal types, but
   reconstruct the current Plex-branded human and machine output in `commands/plex.ts`.
8. **Retain early validation.** Keep mode conflicts, missing library, invalid rating/type, and
   destructive confirmation ahead of adapter/network mutation.
9. **Make auth retry cancelable and bounded.** Share the request timeout/cancellation budget, retry
   at most once, and avoid non-idempotent replay unless the first attempt is proven unapplied.
10. **Test cache as a UX invariant.** A live response and cache hit must render byte-equivalent
    structured output; successful mutations invalidate relevant data; failures are not cached.
11. **Preserve help terminology.** User docs and help should continue to say Plex and use 1-5 stars,
    while architecture docs explain the generic adapter boundary separately.

### P2 — Follow-up opportunities, not reasons to expand #119

12. **Consider typed Plex errors later.** The repository has structured error formatters, but
    converting all Plex string errors could change visible output. Do it only with compatibility
    tests and preferably as a separately reviewed UX improvement.
13. **Consider a generic alias only with a migration design.** A future server-neutral command can
    be additive, but it must not replace `rfmedia plex` or force generic terminology on
    backend-specific capabilities.
14. **Document JWT configuration only after the contract is decided.** Avoid speculative help or
    completion options. Prefer the existing token slot if it can safely represent both forms.
15. **Evaluate completion generation from command metadata separately.** Hand-maintained templates
    create drift risk, but replacing them is outside this behavior-preserving adapter refactor.

## Open Questions

1. Can Plex JWTs be supplied through the existing `plex.token` and `--plex-token` inputs, or is
   another credential/refresh value unavoidable? The no-completion-change recommendation depends
   on keeping this additive surface unnecessary.
2. What exact JWT expiry/recovery mechanism is in scope, and which operations are safe to retry?
   Reads and ambiguous mutations require different UX/error guarantees.
3. Are current Plex error strings a documented automation contract, or are only error category,
   suggestions, and exit status stable? Existing tests assert several exact messages, so the safe
   default is to preserve them.
4. Should machine-mode failures eventually receive a structured error envelope? Current Plex
   commands frequently log errors and set status 1 rather than emitting a command-specific error
   schema. Standardizing this would be valuable but is a user-facing change outside #119.
5. Does `process.exit(1)` in the two Plex copy commands need to remain exact, or may it be normalized
   to `process.exitCode = 1` if observable output/status is unchanged? Abrupt-exit timing can affect
   cleanup and tests, so this should not change incidentally.
6. Are collection `metadataType` and playlist/collection `ratingKey` fields intentionally public
   Plex details in machine output? Strict compatibility says retain them even while generic
   internal types remove Plex leakage.
7. Is Sonic Analysis only internal capability metadata in #119, or will a user-facing command be
   added later? If it is metadata only, there is no command/help/completion change now.
8. Should JWT refresh and cache events be available under `--debug`, and if so, what non-secret
   identifiers are useful for support without revealing tokens, claims, or credential-bearing URLs?
9. Which outputs are byte-for-byte snapshot contracts versus semantically compatible contracts?
   Establishing fixtures for representative text and all machine formats would remove ambiguity.
10. Should optional scan failure ever influence exit status for commands whose primary mutation
    succeeded? Current behavior treats scanning as best effort; changing that requires explicit
    product approval, not an adapter implementation decision.
