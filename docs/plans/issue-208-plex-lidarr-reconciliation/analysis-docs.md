# Documentation Analysis: Issue 208 Plex-Lidarr Reconciliation

## Executive Summary

Issue #208 needs a new canonical operator guide at
`packages/rfmedia-cli/docs/features/lidarr-reconciliation.md` plus coordinated changes to the
package README, documentation index, Lidarr audit guide, media-server adapter guide, tracking
database guide, output-format guide, shell-completion guide, changelog, roadmap, and roadmap
archive. The documentation must make the safety boundary unmistakable: `rfmedia lidarr reconcile`
is a complete, bidirectional report by default; exact MBID evidence is the only automatic identity;
name and duplicate diagnostics are suggestions; cached evidence is explicitly stale; and no
Plex/Lidarr correction occurs without a separate reviewed plan/apply authorization and fresh exact
target revalidation.

The offline promise is currently blocked by the version-1 identity snapshot, not merely
undocumented. It stores Plex-oriented outcomes and a Lidarr count but not the complete Lidarr artist
projection needed to derive `lidarr_only`; exact reads also require Plex machine/library IDs that
cannot currently be discovered without contacting Plex. Public documentation must not advertise
complete offline reconciliation until the implementation adds a complete versioned snapshot and a
deterministic, scope-safe cache selection contract. It must also say whether offline mode can run
without configured secrets, because eager `.rfmedia.yaml` template expansion currently may require
`PLEX_TOKEN` and `LIDARR_API_KEY` even when provider I/O is forbidden.

Several existing documents are already stale. Most importantly,
`packages/rfmedia-cli/docs/features/lidarr-audit.md` says no Plex artist join key exists and that
issue #207 has not landed, while the shipped optional media-server identity capability now exposes
MusicBrainz artist IDs. `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md` still
calls schema version 9 current even though the code is version 11 and owns
`bridge_identity_snapshots`. These are release-blocking corrections, not optional cleanup.

## Must-Read Documents

### Issue and predecessor contracts

| Priority | Document                                                                  | Why it is required                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | `docs/plans/issue-208-plex-lidarr-reconciliation/analysis-integration.md` | Current integration source of truth for provider reads, report categories, offline blockers, cache scope, output, audit reuse, cancellation, mutation boundaries, and child-issue sequencing |
| P0       | `docs/plans/plex-lidarr-identity-mapping/feature-spec.md`                 | Settled #207 identity rules: unique exact MBID authority, suggestion-only names, uncertainty states, provider-instance scope, strict cached evidence, and no mutation                        |
| P0       | `docs/plans/plex-lidarr-identity-mapping/parallel-plan.md`                | What #207 actually intended to ship, including cache, architecture checks, tests, and deliberate deferral of the public command to #208                                                      |
| P0       | `docs/plans/plex-lidarr-identity-mapping/analysis-code.md`                | Implemented bridge boundaries and the explicit handoff to #208                                                                                                                               |
| P1       | `docs/plans/plex-lidarr-identity-mapping/research-technical.md`           | Matching, offline, cache, and error rationale; its proposed normalized three-table schema was not the final implementation and must be treated as historical design input                    |
| P1       | `docs/plans/211-lidarr-audit/design.md`                                   | Authoritative reason the `plex-alignment` slot was reserved and the false-positive checks that #208 must still reject                                                                        |
| P1       | `docs/plans/211-lidarr-audit/plan.md`                                     | Executable audit registry, output, completion, and documentation contracts; historical line anchors may have drifted                                                                         |

### Current public contracts

| Priority | Document                                                            | What to extract before editing                                                                                                                                                     |
| -------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | `packages/rfmedia-cli/README.md`                                    | Canonical rfmedia command discovery, Lidarr overview, global output rules, configuration/secrets behavior, audit wording, plan/apply boundary, and examples                        |
| P0       | `packages/rfmedia-cli/docs/features/lidarr-audit.md`                | Reserved `plex-alignment` contract, stable check/finding/skip codes, request planning, no-mutation guarantee, output schemas, and stale #207/#208 wording                          |
| P0       | `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`           | Only approved Lidarr mutation boundary, exact-MBID revalidation, expected-absence artist add, destructive authorization, dry-run, history, resume, and uncertain-dispatch recovery |
| P0       | `packages/rfmedia-cli/docs/features/media-server-adapter.md`        | Provider-neutral dependency direction, optional capability model, Plex transport/auth ownership, import rules, and adapter mocking guidance                                        |
| P0       | `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`     | Stable facade versus generated SDK ownership, complete artist-list/exact-MBID reads, origin-bound transport, strict projections, and offline codegen distinction                   |
| P0       | `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md` | SQLite location, migration/read-only behavior, schema documentation, and the stale schema-version/table inventory                                                                  |
| P0       | `docs/features/output-formats.md`                                   | Shared text/table versus JSON/YAML/CSV behavior, stdout/stderr purity, flat CSV constraints, and global flag precedence                                                            |
| P0       | `packages/rfmedia-cli/docs/features/shell-completion.doc.md`        | Static Bash/Zsh/Fish behavior, installation refresh, and current Lidarr subtree documentation                                                                                      |
| P1       | `packages/rfmedia-cli/docs/features/plex-configuration.md`          | Plex origin/token/library selection and the in-memory response-cache configuration that must be distinguished from durable reconciliation snapshots                                |
| P1       | `packages/rfmedia-cli/docs/features/plex-api-caching.md`            | Adapter-local TTL cache ownership and its deliberately non-persistent lifecycle                                                                                                    |
| P1       | `docs/features/secrets-management.md`                               | Eager config-template substitution, dotenvx/1Password bootstrap behavior, missing-secret failures, and secret-redaction expectations                                               |
| P1       | `packages/rfmedia-cli/docs/features/config-validation-caching.md`   | Pre-action config loading and eager template injection that affect credential-free offline mode                                                                                    |
| P1       | `docs/README.md`                                                    | Public documentation index for the new guide                                                                                                                                       |
| P1       | `README.md`                                                         | Root discovery surface, which currently has no Lidarr example                                                                                                                      |
| P1       | `packages/rfmedia-cli/CHANGELOG.md`                                 | Keep a Changelog `[Unreleased]` destination for the command and safety behavior                                                                                                    |
| P1       | `ROADMAP.md`                                                        | All live #208 positions, Next Up ordering, Layer 3 summary, exit criteria, last-updated date, and aggregate open counts                                                            |
| P1       | `docs/roadmap-archive.md`                                           | Shipped-work table and operator-note destination requiring real PR/date evidence                                                                                                   |

### Maintainer and completion contracts

| Priority | Document                                                           | Relevance                                                                                                       |
| -------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| P0       | `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` | Executable cross-shell parity contract and pinned Lidarr command hierarchy                                      |
| P0       | `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`           | Bash static command/option source that must expose `lidarr reconcile` without provider I/O                      |
| P0       | `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`            | Zsh static command/option source that must remain in parity                                                     |
| P0       | `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`           | Fish static command/option source that must remain in parity                                                    |
| P1       | `.github/pull_request_template.md`                                 | Required PR sections, issue closure syntax, exact test commands/results, risk, rollback, and checklist          |
| P1       | `docs/prps/plans/completed/lidarr-mutation-plan-apply.plan.md`     | Repository precedent for preserving an accepted implementation plan as a completed artifact                     |
| P1       | `docs/prps/reports/lidarr-mutation-plan-apply-report.md`           | Repository precedent for a post-implementation report that maps changes, validations, and remaining limitations |
| P2       | `docs/templates/github/pull-request.md`                            | Offline drafting mirror only; the GitHub PR template remains authoritative                                      |

## Architecture Docs

### Required architecture updates

#### `packages/rfmedia-cli/docs/features/media-server-adapter.md`

The capability list and Plex composition description omit the shipped optional `identity`
capability. Add:

- provider-neutral artist identity paging and instance-ID lookup;
- optional-capability behavior for non-Plex adapters;
- Plex-private GUID parsing and machine/library details staying behind the adapter;
- bridge consumers depending only on generic projected types;
- caller cancellation on every page and instance lookup; and
- the distinction between the adapter-local response cache and bridge-owned durable snapshots.

Keep the one-way dependency explicit:

```text
lidarr reconcile command
  -> reconciliation action
  -> generic MediaServerAdapter.identity + stable LidarrClientApi
  -> pure bridge resolver/report
  -> feature-owned SQLite snapshot
```

No bridge module may import a private Plex endpoint, generated Lidarr module, or own authenticated
Fetch.

#### `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`

This guide must stop claiming schema version 9 is current. At minimum:

- document the actual post-#208 schema version;
- include `bridge_identity_snapshots` in the table inventory and name
  `src/lib/bridge/cache.ts` as its sole CRUD owner;
- distinguish copy inventory from versioned provider-identity/reconciliation evidence;
- explain exact provider scope, strict payload validation, transactional replacement, timestamps,
  version compatibility, corruption behavior, and future-version refusal;
- update migration and read-only schema-version prose without implying historical v9 databases are
  directly readable as current; and
- state that failed, cancelled, or partial live acquisition preserves the previous complete
  generation.

If #208 keeps the v11 table and only advances the payload document version, say so explicitly. If
scope discovery needs indexed columns or a new table, document the actual migration and new schema
version rather than pre-announcing one.

#### `docs/architecture/data-flow.md`

Add an `rfmedia lidarr reconcile` flow showing:

1. option/config validation before I/O;
2. a live branch that fully pages Plex and lists the complete Lidarr artist catalog;
3. a zero-provider-request offline branch that selects one exact compatible cached scope;
4. pure mapping/report classification;
5. transactional cache replacement only after complete live success;
6. one human or machine result; and
7. a hard boundary to separate `lidarr plan` / `lidarr apply` for any correction.

The diagram must show that cancellation, cache ambiguity/corruption/version drift, and partial
enumeration terminate without a gap report or snapshot replacement. It must not imply fuzzy
evidence can remove a `lidarr_only` item or authorize a write.

#### `docs/architecture/overview.md`

The rfmedia package description currently emphasizes copy, tracking, and Plex workflows. Update its
high-level component map for the provider-neutral media adapter, stable Lidarr facade, pure bridge
domain, and feature-owned SQLite snapshot. This is an in-process CLI feature, not a new service,
daemon, HTTP API, or Docker topology component.

### Architecture documents to cross-link, not broaden

- `packages/rfmedia-cli/docs/features/plex-api-caching.md` should retain its accurate
  adapter-local, process-local, non-persistent scope but add a short cross-link explaining that
  reconciliation snapshots are a separate durable SQLite mechanism.
- `packages/rfmedia-cli/docs/features/plex-configuration.md` should explain which configured
  origin/library values scope reconciliation and link to the new guide. Do not mislabel the
  existing `plex.cache` TTL as the offline reconciliation cache.
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md` needs a concise reconciliation
  consumer note only if facade contracts change. Generated modules remain private and the normal
  codegen workflow remains offline.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` should add reconciliation handoff
  examples only for mutation operations that actually exist. Do not document inert suggestions as
  executable plans or generalize the Last.fm-specific artist-add producer without implementing and
  testing that provenance change.
- `docs/reference/architecture-diagram.md` describes deployed infrastructure. Reconciliation adds
  no container or network and should not change that diagram.
- `docs/features/rfapps-reconcile-command.md` documents a different CLI and authority model. It is a
  useful report-first precedent, not a page to reuse for `rfmedia lidarr reconcile`.

## Reading List

### P0: Read before implementation

1. `docs/plans/issue-208-plex-lidarr-reconciliation/analysis-integration.md`
2. `docs/plans/plex-lidarr-identity-mapping/feature-spec.md`
3. `docs/plans/plex-lidarr-identity-mapping/parallel-plan.md`
4. `packages/rfmedia-cli/docs/features/media-server-adapter.md`
5. `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
6. `packages/rfmedia-cli/docs/features/lidarr-audit.md`
7. `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
8. `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`
9. `docs/features/output-formats.md`
10. `packages/rfmedia-cli/docs/features/shell-completion.doc.md`

This order establishes the implemented #207 and audit boundaries before defining the new public
surface, then closes persistence, output, and discoverability contracts.

### P0: Documentation required for release

#### Create

- `packages/rfmedia-cli/docs/features/lidarr-reconciliation.md`

Minimum sections:

1. purpose, scope, and quick-start examples;
2. complete option table, including live/offline/stale, duplicate, suggestion, scope, freshness,
   connection override, and output options that actually ship;
3. exact definitions for `matched`, `plex_only`, `lidarr_only`, uncertainty categories, duplicate
   groups, and summary counts;
4. evidence categories (`exact-mbid`, normalized/fuzzy suggestion), similarity score and margin,
   and an explicit statement that scores are not probabilities;
5. complete-enumeration and fail-closed rules;
6. live versus SQLite-cache provenance, capture/verification time, age, freshness ceiling, scope
   selection, and cache replacement behavior;
7. zero-provider-request offline semantics and the exact credential/config prerequisites;
8. human output plus complete JSON/YAML examples and the documented flat per-artist CSV projection;
9. exit codes, stable error/result codes, stdout/stderr behavior, and cancellation;
10. duplicate diagnostics and bounded, inert remediation suggestions;
11. default no-mutation guarantee and the separate sealed plan/apply path for supported
    corrections;
12. privacy/security notes for credentials, origins, artist names, IDs, cache contents, and
    terminal-safe rendering;
13. limitations: artist-only v1 scope, stale evidence, no direct MusicBrainz request, no automatic
    correction, and no safe inference from file-count ratios; and
14. troubleshooting for unsupported identity capability, no GUIDs, incomplete paging, cache miss,
    ambiguous scope, incompatible/corrupt snapshot, stale ceiling, and provider failure.

#### Update

- `packages/rfmedia-cli/README.md`
  - add reconciliation to the Lidarr feature summary;
  - add a dedicated `Lidarr Reconciliation` section before the audit section;
  - include live, offline, duplicates/suggestions, and machine-output examples;
  - summarize categories, completeness, stale provenance, exit behavior, and no-mutation boundary;
  - link the canonical guide;
  - replace the audit statement that `plex-alignment` always skips until #207/#208.
- `docs/README.md`
  - add the canonical reconciliation guide under rfmedia CLI features.
- `README.md`
  - add one concise `rfmedia lidarr reconcile` example or feature link so the new command is
    discoverable from the repository root.
- `packages/rfmedia-cli/docs/features/lidarr-audit.md`
  - activate or redefine the `plex-alignment` slot from the same pure reconciliation report;
  - update the active/reserved check count, requirements, request costs, skip reasons, finding
    codes, remediation, examples, JSON/CSV samples, and no-cache/no-mutation wording;
  - preserve the rejected album-count and mixed-track-count heuristics.
- `docs/features/output-formats.md`
  - add the `lidarr reconcile` envelope and per-artist CSV projection;
  - document how summary/provenance rows remain present for empty results and how uncertainty and
    duplicate groups flatten without loss or unbounded nesting.
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`
  - document the new `lidarr reconcile` leaf and every static option/value candidate;
  - state that Bash, Zsh, and Fish are in parity and completion never loads config, opens SQLite,
    contacts Plex/Lidarr, or expands live artist names.
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`
  - correct the schema version and document the bridge/reconciliation snapshot lifecycle.
- `packages/rfmedia-cli/docs/features/media-server-adapter.md`
  - document the optional identity capability and bridge dependency rules.
- `packages/rfmedia-cli/docs/features/plex-configuration.md`
  - document reconciliation-relevant origin/library selection and cache distinctions.
- `packages/rfmedia-cli/docs/features/plex-api-caching.md`
  - cross-link the separate durable bridge snapshot and keep its own no-persistence statement
    clearly scoped to Plex response caching.
- `docs/features/secrets-management.md`
  - add `LIDARR_API_KEY` to rfmedia examples and document the actual offline credential behavior;
  - if #208 changes eager expansion, document the narrowly deferred selectors rather than claiming
    all templates are lazy.
- `packages/rfmedia-cli/CHANGELOG.md`
  - add the operator-visible command, bidirectional report, exact-versus-suggested evidence,
    explicit offline snapshots, duplicate diagnostics, completion parity, and mutation boundary
    under `[Unreleased]`.
- `ROADMAP.md`
  - only after merge, remove #208 from Next Up and Phase D, advance #209 as the next Layer 3
    dependency, update current-focus/exit-criteria prose, date, and live open totals;
  - if prerequisite or mutation child issues are created, count and position them from live issue
    state rather than assuming #208 reduces the total by one.
- `docs/roadmap-archive.md`
  - only after authoritative merge verification, add #208 and its real PR to the shipped-work
    table and add an operator note summarizing report-first behavior, offline provenance, and the
    plan/apply mutation boundary;
  - replace the #207 note that reconciliation remains open and the audit note that
    `plex-alignment` is awaiting #208.

### P1: Completion evidence

- Update all three completion templates and `templates.spec.ts` in the same change; the public
  completion guide is not sufficient evidence by itself.
- Preserve the issue plan as a completed plan and add an implementation report only if the chosen
  workflow already creates those artifacts; do not invent a parallel second source of truth.
- The PR body must use `.github/pull_request_template.md`, include `Closes #208`, list exact
  verification commands and outcomes, state the offline/cache migration risk, and explain rollback.
- Roadmap/archive and changelog wording must use the actual merged PR and implemented contract, not
  planned flags or speculative child scope.

## Documentation Gaps

- **Release-blocking — no canonical guide:** No current page defines `rfmedia lidarr reconcile`,
  its bidirectional categories, evidence semantics, offline behavior, output schemas, exit codes,
  or mutation boundary.
- **Release-blocking — false audit rationale:** `packages/rfmedia-cli/docs/features/lidarr-audit.md`
  says Plex exposes no artist GUID and #207/#208 have not landed. #207 shipped the optional identity
  capability; #208 must replace this rationale, examples, and skip contract with the implemented
  alignment behavior.
- **Release-blocking — incomplete offline evidence:** The #207 feature spec calls the cached
  identity evidence complete enough for later offline reconciliation, but the implemented v1
  payload cannot reconstruct the full `lidarr_only` set and cannot discover an exact cache scope
  without Plex. The #208 guide and plan must state the new versioned contract and compatibility
  behavior; historical #207 research should be annotated as superseded rather than silently
  rewritten as if it had shipped.
- **Release-blocking — stale schema guide:**
  `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md` says schema version 9 is
  current and omits the version-11 bridge table. Align it with the final #208 migration/document
  version and the read-only compatibility gate.
- **Release-blocking — ambiguous “offline”:** Existing config loading eagerly expands all secret
  templates. A command can make zero provider requests yet still fail because Plex/Lidarr secrets
  are absent. Documentation must either state that prerequisite exactly or track the implementation
  change that permits credential-free cache selection.
- **Release-blocking — cache terminology collision:** The Plex cache guide accurately describes a
  process-local, non-persistent TTL cache; reconciliation requires durable SQLite snapshots.
  Cross-links and naming must prevent users from configuring `plex.cache` and assuming it enables
  offline reconciliation.
- **Release-blocking — reverse-gap authority:** Only unique exact-MBID matches may subtract a
  Lidarr artist from `lidarr_only`. No current public documentation explains that name suggestions,
  ambiguity, conflict, unavailable evidence, or cached matches cannot suppress a real gap or
  authorize a correction.
- **Release-blocking — mutation wording:** Reconciliation suggestions must not imply that
  `--yes`, duplicates mode, stale mode, or a high similarity score authorizes Plex/Lidarr writes.
  Only implemented sealed plan producers may be named as next steps; unsupported removal,
  unmonitoring, or duplicate repair must remain guidance, not executable claims.
- **Required — audit/cache policy decision:** The audit guide promises no cache population. If
  `plex-alignment` reuses the online acquisition action that refreshes the bridge snapshot, update
  that promise and expose the behavior. If audit deliberately evaluates without refreshing cache,
  document the distinct orchestration while retaining the same pure report algorithm.
- **Required — output flattening:** The shared output guide gives generic CSV rules but no lossless
  projection for multi-category reconciliation. Freeze row kinds, required summary/provenance rows,
  bounded candidate representation, deterministic ordering, and empty-result behavior in docs and
  tests together.
- **Required — architecture visibility:** The media-server adapter guide omits its identity
  capability, and the general architecture docs do not show the Plex/Lidarr bridge or durable
  snapshot. Without those updates, future features are likely to bypass the generic adapter or
  stable Lidarr facade.
- **Required — completion discoverability:** The shell guide documents only selected Lidarr
  subtrees. Add the reconciliation grammar and prove Bash/Zsh/Fish parity while keeping completion
  static and offline.
- **Required — roadmap closeout:** #208 appears in current focus, Next Up, the Layer 3 diagram, and
  Phase D. All live entries, aggregate counts, archive history, and the #207 “no public command”
  note must move together only after merge and issue closure are verified.
- **Recommended — historical planning contradictions:** The #207 technical research proposed three
  normalized cache tables and origin-only selection, while the shipped implementation uses one
  full-scope JSON snapshot row. Treat old research as historical rationale, and make the #208
  feature spec, final implementation report, and current public guides the authoritative description
  of what actually ships.
