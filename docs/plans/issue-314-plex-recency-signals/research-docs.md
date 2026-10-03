# Documentation Research: issue-314-plex-recency-signals

## Architecture Docs

- **Required:**
  [`packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md`](../../../packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md)
  is the source design for this child issue. Read sections 2.4, 6.2, 8, 9.1-9.3,
  10, 12-15. It records the original decision to use lifetime `viewCount`, the
  absence of recency fields, the full-drain/join model, output and explanation
  contracts, completion parity, and the explicit recency follow-up.
- **Required:**
  [`packages/rfmedia-cli/docs/features/media-server-adapter.md`](../../../packages/rfmedia-cli/docs/features/media-server-adapter.md)
  defines the provider-neutral adapter boundary. Plex wire fields remain private to
  the adapter; actions and policy code consume mapped domain entities. Any new
  capability must preserve the one-way dependency from command/action to generic
  contract to `PlexAdapter`.
- **Required:** [issue #210](https://github.com/yandy-r/rfmedia-apps/issues/210)
  is the Temporal Library Intelligence boundary. It owns the future read-only
  `rfmedia lidarr timeline` analytics experience. Issue #314 should expose only the
  minimal shared Plex/domain recency signal and policy behavior needed now, without
  implementing timeline trends, state transitions, or reporting.
- **Required:** [`ROADMAP.md`](../../../ROADMAP.md) establishes the sequencing:
  #314 must make policy decisions time-aware before #210 becomes signal-complete.
  The current-focus, Sprint 1, Phase D/E, and backlog entries all need completion
  parity after merge.
- **Nice to have:**
  [`packages/rfmedia-cli/docs/plans/issue-209-policy-engine/plan.md`](../../../packages/rfmedia-cli/docs/plans/issue-209-policy-engine/plan.md)
  explains the implementation history, standing invariants, and tests deliberately
  omitted from #209. Use it to avoid reopening settled policy-engine decisions.

## API Docs

- **Required:** [issue #314](https://github.com/yandy-r/rfmedia-apps/issues/314)
  is the acceptance contract: carry `lastViewedAt` and, if justified, `skipCount`
  through Plex wire guards, mappers, and typed domain models; add a time-aware policy
  configuration and explanation; update policy/ratings-sync caveats; and fail closed
  for missing or partial wire data.
- **Required:** the official [Plex Media Server API documentation](https://developer.plex.tv/pms/)
  is the primary external field reference. Its current examples represent
  `lastViewedAt` as a numeric Unix timestamp and describe optional response-field
  inclusion. The rendered specification does not currently document `skipCount`, so
  do not assume its shape or availability from memory: validate it against an
  authoritative fixture or real response, or defer it explicitly.
- **Required:**
  [`packages/rfmedia-cli/docs/features/media-server-adapter.md`](../../../packages/rfmedia-cli/docs/features/media-server-adapter.md)
  is the local API contract guide. Pair it with the existing private Plex types,
  guards, and mappers under `packages/rfmedia-cli/src/lib/adapters/plex/`; those
  implementation files, rather than policy code, own wire normalization.
- **Required:** [issue #210](https://github.com/yandy-r/rfmedia-apps/issues/210)
  is the authoritative public specification for the neighboring timeline feature.
  Shared signal plumbing is in scope for #314 only when it does not pull timeline
  aggregation or presentation into this change.

## Development Guides

- **Required:** [`CLAUDE.md`](../../../CLAUDE.md) provides repository-wide Markdown,
  architecture, workflow, and contribution rules.
- **Required:**
  [`packages/rfmedia-cli/CLAUDE.md`](../../../packages/rfmedia-cli/CLAUDE.md)
  provides the CLI-specific architecture guard, testing conventions, build commands,
  and Bash/Zsh/Fish completion-parity rule.
- **Required:** [`.mise.toml`](../../../.mise.toml) pins the Node.js 22 development
  contract. Run repository commands through `mise exec -- ...` when the ambient
  runtime is uncertain.
- **Required:**
  [`packages/rfmedia-cli/package.json`](../../../packages/rfmedia-cli/package.json)
  is the command source for CLI typecheck, build, Vitest, code-generation drift, and
  architecture checks. Root [`package.json`](../../../package.json) defines the
  workspace lint, contract, coverage, and rfmedia test gates.
- **Required:**
  [`.github/workflows/rfmedia-cli.yml`](../../../.github/workflows/rfmedia-cli.yml)
  is the registered CI contract: Node 22, clean install, codegen checks, common build,
  typecheck, coverage, and benchmark smoke coverage.
- **Required:** [`lefthook.yml`](../../../lefthook.yml) defines the real local hook
  path. The pre-push contract runs the workspace test suite and must not be bypassed.
- **Required audit:**
  [`packages/rfmedia-cli/docs/features/shell-completion.doc.md`](../../../packages/rfmedia-cli/docs/features/shell-completion.doc.md)
  documents rfmedia completions. Audit
  `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`, `zsh.ts`, `fish.ts`, and
  `templates.spec.ts`. A config-only recency threshold needs no completion change;
  any new CLI option requires all three templates and parity tests together.
- **Nice to have:**
  [`packages/rfmedia-cli/docs/testing/troubleshooting.md`](../../../packages/rfmedia-cli/docs/testing/troubleshooting.md)
  is useful when focused or full-suite verification fails, but it does not define
  feature semantics.
- **Not applicable:** [`docs/features/shell-completion.md`](../../features/shell-completion.md)
  documents the `rfapps` CLI, not `rfmedia`; do not update it for this feature.

## README Files

- **Required:** [`packages/rfmedia-cli/README.md`](../../../packages/rfmedia-cli/README.md)
  is the public CLI summary. Update both the Consumption Policy and Ratings Sync
  sections: configuration tables, examples, the current lifetime-play/no-recency
  caveat, explanation behavior, and testing commands when their contract changes.
- **Required audit:** [`rfmedia.example.yaml`](../../../rfmedia.example.yaml) is the
  public configuration example, but it currently has no policy block or stale-rule
  example. Decide explicitly whether to add a minimal policy example or keep the
  feature-doc YAML as the only complete example; do not leave the omission accidental.
- **Nice to have:** [`README.md`](../../../README.md) is the repository overview.
  It needs no issue-specific edit unless the implementation changes a linked public
  capability or top-level setup instruction.
- **Nice to have:**
  [`packages/rfmedia-cli/docs/features/plex-configuration.md`](../../../packages/rfmedia-cli/docs/features/plex-configuration.md)
  is relevant only if recency semantics require explaining which Plex account owns
  viewing history; authentication and credential-storage behavior are otherwise
  unchanged.

## Must-Read Documents

Before design or coding:

1. **Required:** [issue #314](https://github.com/yandy-r/rfmedia-apps/issues/314),
   then sections 2.4, 6.2, 8, 9, 14, and 15 of
   [`issue-209-policy-engine/design.md`](../../../packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md).
2. **Required:**
   [`media-server-adapter.md`](../../../packages/rfmedia-cli/docs/features/media-server-adapter.md)
   and [issue #210](https://github.com/yandy-r/rfmedia-apps/issues/210) to preserve
   both the Plex abstraction and feature boundary.
3. **Required:** the official [Plex API documentation](https://developer.plex.tv/pms/)
   before committing to wire-field presence, units, or optionality.
4. **Required:**
   [`lidarr-consumption-policy.md`](../../../packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md)
   and
   [`lidarr-ratings-sync.md`](../../../packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md)
   because both expose the same policy semantics to users.

Before closeout:

1. **Required:** [`packages/rfmedia-cli/README.md`](../../../packages/rfmedia-cli/README.md),
   [`rfmedia.example.yaml`](../../../rfmedia.example.yaml), and the two feature docs
   above for public-contract parity.
2. **Required:** [`ROADMAP.md`](../../../ROADMAP.md) and
   [`docs/roadmap-archive.md`](../../roadmap-archive.md) for authoritative issue/PR
   completion recording after merge.
3. **Required:** the package/root manifests, rfmedia CI workflow, `lefthook.yml`, and
   CLI development guide for the exact verification gates.
4. **Conditional:** the rfmedia completion doc plus all three shell templates and
   `templates.spec.ts` if a CLI flag is added; otherwise record that the audit found
   no completion delta.

## Documentation Gaps

- The root [`rfmedia.example.yaml`](../../../rfmedia.example.yaml) has no policy
  configuration example. The design and feature guide currently carry the only
  complete YAML, which makes configuration discoverability and drift control weaker.
- Existing policy and ratings-sync docs repeat the lifetime-play/no-recency caveat in
  several places. Update the feature guide, package README, ratings-sync guide,
  configuration table, YAML examples, explanation examples, and troubleshooting text
  as one contract; a partial edit will leave contradictory semantics.
- `lastViewedAt` cannot by itself distinguish a never-viewed old artist from a newly
  added artist because both may omit the field. The design and user docs must state
  the fail-closed behavior and any acquisition-age prerequisite explicitly; if
  `addedAt` is required, treat that as a deliberate domain/API addition rather than
  silently interpreting absence as epoch zero.
- The current official Plex API page does not document `skipCount`. Unless an
  authoritative fixture establishes its type, scope, and absence semantics, defer it
  and document why; “optional” in the issue does not make an unverified wire contract
  safe.
- There is no checked-in `packages/rfmedia-cli/docs/plans/issue-210-*` design to refine
  the timeline boundary. Record any reusable recency-domain decision in the #314
  design so #210 can consume it later without importing policy-specific behavior.
- Shell completion parity is easy to over-edit: a config-only rule threshold produces
  no new tokens. Document the audit result; only modify Bash, Zsh, Fish, and their
  parity test if the final interface actually adds a command-line option.
- [`docs/roadmap-archive.md`](../../roadmap-archive.md) contains historical #209 and
  ratings-sync statements that recency was unavailable, while `ROADMAP.md` still
  lists #314 as live. On completion, add an authoritative shipped record and update
  current status without obscuring what the earlier releases originally supported.
