# Documentation Analysis: lidarr-similar-artist-discovery

## Executive Summary

Issue #203 needs one canonical operator guide,
`packages/rfmedia-cli/docs/features/lidarr-discovery.md`, plus focused changes to the existing
Lidarr execution-lane, generated-client, and plan/apply guides. The documentation must keep the
default Last.fm-only read path separate from the optional Lidarr add-plan handoff: discovery is
read-only, attributed, and available without Lidarr, while mutation remains exclusively owned by a
sealed `artist-add` plan and `lidarr apply`.

Release documentation is also part of the contract. Update the package README, example
configuration, changelog, documentation index, all three completion templates, and parity tests;
move #203 from both live roadmap locations to the archive only after delivery. No new
repository-wide architecture page is necessary, and the generic shell-completion guide need not
change unless installation or generation behavior changes.

## Must-Read Documents

### Required

- `docs/plans/lidarr-similar-artist-discovery/feature-spec.md`: authoritative command, data,
  security, plan/apply, output, scope, and release contracts.
- `docs/plans/lidarr-similar-artist-discovery/analysis-architecture.md`: read-only provider flow,
  expected-absence `artist-add` flow, transport ownership, and plan/apply constraints.
- `docs/plans/lidarr-similar-artist-discovery/analysis-integration.md`: Last.fm and Lidarr
  endpoints, generated operations, persistence boundaries, and integration-specific doc impacts.
- `docs/plans/lidarr-similar-artist-discovery/analysis-patterns.md`: closest command/action
  precedents, completion parity, output conventions, and implementation gotchas.
- `packages/rfmedia-cli/docs/features/lidarr-search-lookup.md`: nearest operator-facing precedent
  for ranked candidates, strict projection, human and machine output, and empty results.
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`: current `discovery` lane,
  scheduler retry/cancellation ownership, and execution metadata.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: canonical sealed-artifact, approval,
  drift, claim, history, resume, verification, and uncertainty behavior.
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`: private generated-client
  boundary, sole transport ownership, strict facade projections, and offline contract workflow.
- `packages/rfmedia-cli/README.md`: public command/config examples and placement among the existing
  Lidarr read and mutation workflows.
- `ROADMAP.md` and `docs/roadmap-archive.md`: the two live #203 entries, Layer 2 sequencing, and the
  shipped-history format.

### Supporting

- `docs/plans/lidarr-similar-artist-discovery/research-external.md`: official Last.fm method,
  attribution, licensing, credential, rate-limit, and freshness constraints.
- `docs/plans/lidarr-similar-artist-discovery/research-ux.md`: text/JSON/YAML/CSV presentation,
  stream discipline, empty output, autocorrection, and handoff language.
- `docs/plans/lidarr-similar-artist-discovery/research-security.md`: secret redaction,
  fixed-origin transport, hostile provider data, and safe-add documentation requirements.
- `rfmedia.example.yaml`: public template location for `discovery.lastfm.apiKey` and `timeoutMs`.
- `.github/pull_request_template.md`: required release handoff sections and exact validation
  evidence.

## Architecture Docs

- **Create `packages/rfmedia-cli/docs/features/lidarr-discovery.md`:** Make this the canonical
  operator guide. Cover Last.fm API-key setup through `{{ LASTFM_API_KEY }}`, fixed provider scope,
  syntax/options/defaults, validation, requested versus resolved seed, rank/dedupe/similarity/MBID
  semantics, attribution in every format, empty output, failures/retries/cancellation, no provider
  cache, and the guarantee that ordinary discovery performs no Lidarr calls.
- **Extend the same guide with the optional handoff:** Document `--add <rank>` as one ephemeral
  visible-rank selection that requires an MBID, explicit root/quality/metadata policy, and
  `--plan-file`. State that it creates at most one sealed plan, never accepts `--yes`, never posts,
  and may return `already-present`; show the later `lidarr apply` review/recovery workflow.
- **Update `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`:** Replace “future
  discovery providers” with the shipped Last.fm action, describe the provider-neutral classified
  failure metadata, scheduler-only bounded retry, safe `Retry-After`, and cancellation. Keep
  artist creation non-idempotent, non-deferable, and outside automatic retry.
- **Update `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`:** Document
  `listRootFolders` and `addArtist`, their already-committed generated operations, strict
  generated-independent projections, and authoritative Lidarr lookup-to-create body construction.
  Reaffirm that generated source is not edited and Last.fm records never become writable DTOs.
- **Update `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`:** Add the exact v2
  `artist-add` operation, foreign-MBID target, expected-absence preflight, resource drift rules,
  fixed unmonitored/no-search policy, possible-dispatch evidence, MBID read-back reconciliation,
  already-present satisfaction, and uncertain no-retry recovery.
- **Do not create a new repository-wide architecture document:** `docs/architecture/overview.md`
  and `docs/architecture/data-flow.md` remain accurate at their abstraction level. Link the new
  feature guide from `docs/README.md` instead.
- **Do not expand the generic completion guide by default:**
  `packages/rfmedia-cli/docs/features/shell-completion.doc.md` explains installation and static
  generation, which #203 does not alter. The templates and their parity test are nevertheless
  mandatory CLI-contract changes.

## Reading List

1. Read `feature-spec.md`, then `analysis-architecture.md`; these settle scope and ownership before
   any lower-level documentation is changed.
2. Read `analysis-integration.md` and `analysis-patterns.md` for exact endpoints, existing
   precedents, file impacts, and known plan/apply and configuration traps.
3. Read the search/lookup and execution-lane guides together before documenting rank, output,
   retries, cancellation, or the Last.fm-only path.
4. Read the plan/apply and generated-client guides together before documenting `artist-add`,
   authoritative lookup data, expected absence, dispatch uncertainty, or generated operations.
5. Read `research-external.md`, `research-ux.md`, and `research-security.md` before finalizing
   attribution, terms, credentials, error wording, and examples; recheck live Last.fm terms before
   release because the cited pages are undated.
6. Update `rfmedia.example.yaml`, `packages/rfmedia-cli/README.md`,
   `packages/rfmedia-cli/CHANGELOG.md`, and `docs/README.md` with matching terminology and links.
7. Update Bash, Zsh, and Fish templates plus `templates.spec.ts` as one parity unit; document the
   exact command/options, but keep completions static and network-free.
8. After implementation and merge details are authoritative, remove #203 from both live
   `ROADMAP.md` locations and add its issue, PR, date, and concise operator note to
   `docs/roadmap-archive.md`. Do not move #204, #205, #206, or #219.
9. Use `.github/pull_request_template.md` unchanged and record exact documentation, completion,
   architecture, codegen, test, build, formatting, and markdown validation outcomes.

## Documentation Gaps

- No operator document currently explains `rfmedia lidarr discover`, Last.fm credential setup,
  its no-Lidarr read-only guarantee, or the distinction from Lidarr search/lookup.
- No current guide defines the stable attributed discovery envelope, requested/resolved seed,
  Last.fm-order ranking, raw similarity semantics, MBID-less eligibility, or the required empty CSV
  summary row.
- The execution-lane guide still describes `discovery` as future use and lacks a non-Lidarr
  provider failure/retry example.
- The plan/apply guide assumes present Lidarr targets; it does not explain an expected-absent,
  foreign-MBID-keyed create operation or reconciliation after a possibly dispatched POST.
- The generated-client guide does not yet cover root-folder projection or artist creation and must
  explicitly prevent Last.fm payloads from crossing into writable generated models.
- Public configuration docs have no `discovery.lastfm` section. They must explain that the API key
  is an installation credential, not a Last.fm user session, and must never be supplied through a
  documented CLI key flag.
- Configuration wording needs care: template expansion is currently eager during config loading,
  so “required only when discovery executes” must be verified or qualified to avoid promising
  unrelated commands will ignore a missing `LASTFM_API_KEY`.
- Last.fm attribution, non-commercial licensing, link, retention, and live-terms freshness
  obligations are absent from repository docs; the feature guide needs a concise operator note,
  not a copy of the terms.
- `docs/README.md` has no discovery link, the package README feature summary has no Last.fm path,
  and the changelog has no issue-203 entry.
- Completion parity is executable documentation: all three templates and
  `templates.spec.ts` must expose identical `discover` flags even though the generic completion
  installation guide does not need rewriting.
- Roadmap closeout can accidentally imply the whole Layer 2 sprint shipped. Archive only #203 and
  retain #204, #205, #206, and #219 as separate open scope.
