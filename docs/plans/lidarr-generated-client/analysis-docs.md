# Documentation Analysis: Lidarr Generated Client

## Executive Summary

Issue #194 is an internal client-boundary replacement with a substantial maintainer workflow, not a
new operator command. Documentation should therefore preserve the existing `rfmedia lidarr` command
surface while making the generation decision, immutable OpenAPI provenance, secure transport split,
offline drift contract, refresh procedure, rollback procedure, and packaging constraints durable.
The primary new document should be
`packages/rfmedia-cli/docs/features/lidarr-generated-client.md`; it can serve as both the TsArr/OpenAPI
decision record and the code-generation runbook, matching the repository's existing feature-guide
convention instead of introducing a new ADR directory.

The package also needs a separate `packages/rfmedia-cli/THIRD_PARTY_NOTICES.md`. The checked-in Lidarr
OpenAPI document identifies GPL-3.0 while `packages/rfmedia-cli/package.json` declares MIT and has no
`private`, `files`, or notice field. The notice must preserve upstream identity and license
attribution, and the package README must link to it. This analysis does not make a legal conclusion:
the maintainer must approve the notice and publication treatment, `npm pack --dry-run` must be
inspected, and #194 must not publish the package.

`ROADMAP.md` should mark only #194 shipped after every merge gate passes. The four command names,
options, output formats, Bash/Zsh/Fish completion source, and completion documentation remain
unchanged. Passing the existing completion parity tests is evidence for that deliberate non-change.

## Must-Read Documents

| Path and useful range                                                      | Why it is authoritative for this change                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/lidarr-generated-client/feature-spec.md:3-11`                  | Defines the outcome: private generated SDK, existing facade, deterministic drift, strict runtime projection, and bounded parsing.       |
| `docs/plans/lidarr-generated-client/feature-spec.md:49-62`                 | Defines ownership, offline generation, unchanged completions, attribution, and the no-publish boundary.                                 |
| `docs/plans/lidarr-generated-client/feature-spec.md:118-127`               | Lists integration files and the required `generated -> transport` boundary.                                                             |
| `docs/plans/lidarr-generated-client/feature-spec.md:151-181`               | Defines maintainer UX, measurements, technology choices, and the explicit completion non-change.                                        |
| `docs/plans/lidarr-generated-client/research-external.md:1-35`             | Captures the TsArr Node engine, Node 22 smoke, redirect/result-shape, and local-generation recommendation.                              |
| `docs/plans/lidarr-generated-client/research-external.md:37-83`            | Records official spec identity, commit/blob evidence, four operations, authentication schemes, and mutable-branch risks.                |
| `docs/plans/lidarr-generated-client/research-security.md:29-34`            | Identifies the MIT/GPL publication question and the current absence of a package notice.                                                |
| `docs/plans/lidarr-generated-client/research-security.md:84-97`            | Defines attribution, tarball inspection, path-confinement, and future refresh-bot requirements.                                         |
| `packages/rfmedia-cli/docs/plans/lidarr-integration-foundation.md:1-40`    | Describes the temporary handwritten client, stable layered architecture, command parity, and #194 deferral that this change supersedes. |
| `packages/rfmedia-cli/README.md:30-65`                                     | Documents the Node 22 floor and source-development workflow that generated-client guidance must preserve.                               |
| `packages/rfmedia-cli/README.md:4904-5071`                                 | Existing Development, testing, typecheck, build, and License sections where codegen commands and the third-party-notice link belong.    |
| `packages/rfmedia-cli/package.json:10-30`                                  | Existing script lifecycle and Node engine; generation must not become install/runtime network work.                                     |
| `packages/rfmedia-cli/package.json:40-80`                                  | MIT package metadata and dependency split; the generator belongs in exact-pinned `devDependencies`.                                     |
| `.github/workflows/rfmedia-cli.yml:21-50`                                  | Existing read-only permissions, pinned checkout, Node 22, `npm ci`, typecheck, and coverage controls to retain and extend.              |
| `ROADMAP.md:95-106`                                                        | Current shipped/open narrative; only #194 changes state while #195, #196, #202, and later work remain open.                             |
| `ROADMAP.md:210-224`                                                       | Sprint ordering and exit criteria that currently call #194 an outstanding API-client ADR.                                               |
| `ROADMAP.md:341-360`                                                       | Canonical Lidarr checklist; the generated-client entry is the narrow checkbox to close.                                                 |
| `.github/pull_request_template.md:1-35`                                    | Required PR evidence sections, exact test results, issue closure, risk, rollback, and documentation checklist.                          |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts:102-137` | Existing cross-shell contract locking exactly `status`, `list`, `wanted`, and `health`.                                                 |

## Required Documentation Deliverables

### Durable decision record and maintenance runbook

Create `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`. Keep the decision and the
operational workflow together because the repository already stores durable feature architecture and
maintenance guidance under `packages/rfmedia-cli/docs/features/`; there is no established ADR
directory. Include these sections:

1. **Decision and status**
   - State that #194 selects a locally generated, committed Fetch SDK behind `LidarrClientApi`.
   - State the exact selected generator version and whether its Fetch runtime is bundled or an exact
     runtime dependency. Do not copy a provisional version after the implementation spike; record the
     versions actually committed in `package-lock.json` and the manifest.
   - Name `openapi-typescript` plus `openapi-fetch` only as the rejected/deferred fallback and record
     the conditions that would trigger reconsideration.
2. **TsArr evaluation evidence**
   - Record `tsarr@2.12.0`, its declared `node >=24.16.0` contract, the repository's Node `>=22.0.0`
     contract, and the successful Node 22 import/construct/mock-request smoke.
   - Record that smoke success does not make Node 22 supported.
   - Record the observed `{ data, request, response }` result, default redirect-following behavior,
     and failed two-client origin/API-key isolation caused by shared configuration.
   - State that TsArr is a design reference only and is not added to package dependencies.
3. **OpenAPI provenance**
   - Identify upstream repository `Lidarr/Lidarr`, path `src/Lidarr.Api.V1/openapi.json`, full commit
     `3e2858439ff35b372d0af00bcea1b0a357572d26`, the verified Git blob SHA, exact-byte SHA-256 from the
     committed manifest, and local snapshot path `packages/rfmedia-cli/openapi/lidarr-v1.json`.
   - Explain that mutable `develop` URLs are discovery inputs only; ordinary generation and CI use the
     checked-in snapshot without network access.
4. **Architecture and ownership**
   - Diagram or state `commands -> actions -> LidarrClientApi -> generated operations -> hardened
transport -> Lidarr`.
   - Generated code owns paths, verbs, query serialization, and wire DTOs. Handwritten code owns
     per-instance credentials/origin, redirects, cancellation/timeout, bounded strict bodies,
     runtime projection, and sanitized domain errors.
   - Generated modules are private and replace-only. Every generated source file must have a stable,
     non-timestamped machine-owned header naming the regeneration command; never instruct maintainers
     to edit generated output manually.
5. **Commands and workflows**
   - Document exact workspace commands for offline write, non-mutating check, codegen tests, and
     immutable-ref refresh. Use the final script names from `packages/rfmedia-cli/package.json`, such
     as `npm run codegen:lidarr --workspace packages/rfmedia-cli`.
   - Distinguish the network-free ordinary path from the explicit network refresh path. Refresh must
     accept an immutable ref, validate provenance and local-only references, update snapshot/manifest,
     regenerate, and leave all diffs for human review.
   - Describe common drift failures (changed, missing, extra, non-file/symlink), their repair command,
     and the rule that check mode does not modify the working tree.
6. **Review, rollback, and ownership**
   - Require review of snapshot/manifest, generator config/lockfile, generated tree, handwritten
     transport/facade, tests, notice, package contents, and size/timing measurements as distinct diff
     classes.
   - Rollback is the Git revert of snapshot/manifest/config/generated/transport/facade changes; never
     hand-repair the generated tree.
   - State that generator or upstream-spec updates repeat the security, isolation, body-bound,
     projection, deterministic-drift, pack, and Node 22 gates.
7. **Security and publication**
   - Document header-only `X-Api-Key`, exact-origin enforcement, redirect rejection, per-instance
     clients, 8 MiB success/4 KiB error caps, strict UTF-8, and non-escape of generated request/response
     envelopes.
   - Link `../../THIRD_PARTY_NOTICES.md` using the correct relative path from the feature document.
   - State that #194 does not publish to npm and that publication remains blocked until a maintainer
     approves license/notice treatment and reviews the dry-run tarball contents.

### Third-party notice and generated-source notice

Create `packages/rfmedia-cli/THIRD_PARTY_NOTICES.md` with maintainer-approved wording. At minimum it
must identify:

- the Lidarr OpenAPI source repository, immutable commit, source path, commit-pinned source URL, local
  snapshot path, and the upstream document's GPL-3.0 designation;
- whether the checked-in snapshot is byte-identical or mechanically normalized, as established by the
  implementation;
- the selected generator and bundled/runtime client package names and licenses;
- where to find the machine-verifiable manifest and source/regeneration instructions; and
- that rfmedia's own package metadata remains MIT while named third-party materials retain their own
  notices. This last sentence must not imply an unreviewed legal conclusion about generated output.

The deterministic generation wrapper must place a stable machine-owned comment in generated `.ts`
files with the generator identity and exact local regeneration command. Do not include generation
timestamps, local paths, usernames, or other machine-specific values. If the generator cannot emit
that header natively, add it through deterministic post-processing before the complete tree is
compared. The third-party notice, not a generated comment, is the durable license-attribution record.

### Package README guidance

Update `packages/rfmedia-cli/README.md` only in maintainer-facing areas:

- Under `## Development` (`README.md:4904`), add a **Lidarr client generation** subsection linking to
  `docs/features/lidarr-generated-client.md` and listing the exact offline regenerate, offline check,
  codegen-test, and immutable-ref refresh commands.
- Make the network boundary explicit: `install`, normal `typecheck`, tests, build, and runtime never
  refresh from GitHub or contact Lidarr; only the named refresh command uses the network.
- Explain that generated files are committed and must not be edited manually.
- Under `## License` (`README.md:5069-5071`), retain the MIT statement for the package and link
  `THIRD_PARTY_NOTICES.md` for vendored/generated materials.

Do not add an operator-facing command or flag to expose codegen. The package README currently contains
no dedicated Lidarr command section; filling that pre-existing user-documentation gap is useful future
work, but it is not required to describe an internal implementation replacement in #194.

### Script naming and help-text contract

`packages/rfmedia-cli/package.json` is executable configuration, but its script names are part of the
documented maintainer interface. Add and document one purpose per script:

| Intended script          | Documented behavior                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `codegen:lidarr`         | Mutating, offline regeneration from the checked-in snapshot after complete validation.   |
| `codegen:lidarr:check`   | Non-mutating, offline full-tree drift check with an exact repair command.                |
| `test:codegen:lidarr`    | Local `node:test` suites for generation and refresh tooling using fixtures/mocked Fetch. |
| `openapi:lidarr:refresh` | Explicit network workflow requiring an immutable `--ref`; never run implicitly.          |

The generated guide and README must match the final names exactly. Script `--help`/failure output should
use the same terms (`write`, `check`, `refresh`, `changed`, `missing`, `extra`) and should never print
raw generated diffs, credentials, response bodies, or machine paths.

## ROADMAP and Changelog Scope

Update `ROADMAP.md` only after implementation, focused/full validation, documentation, packaging
inspection, review, and CI are complete:

- At `ROADMAP.md:95-106`, move only #194 from open follow-up to shipped and link the merged PR; keep
  #195, #196, #202, #203+, and #208+ explicitly open.
- At `ROADMAP.md:214-224`, strike through order 3, mark it shipped with the PR link, and update the exit
  criteria so the client ADR/generation contract is complete rather than outstanding.
- At `ROADMAP.md:341-360`, mark only **Generated client (#194)** complete. Replace the old
  "evaluate TsArr" wording with the recorded result: locally generated client from pinned Lidarr
  OpenAPI, deterministic regeneration/drift, and preserved hardened transport.
- At `ROADMAP.md:381-389`, strike through only #194 and add the merged PR reference.

`packages/rfmedia-cli/CHANGELOG.md:1-10` declares that all notable changes appear under
`[Unreleased]`. A concise **Changed** entry for the generated-client replacement and offline
regeneration workflow is recommended, but it should describe no new command behavior and should not
claim an npm release. It is secondary to the ROADMAP, durable guide, and PR evidence.

## PR Testing and Review Evidence

Use `.github/pull_request_template.md` unchanged as the PR body baseline and preserve every required
section. `## Related Issues` must say `Closes #194`. Set the risk to high because transport confinement,
generated parsing, supply-chain input, and package licensing are merge-sensitive even though the
operator surface is unchanged. The rollback text should identify a squash-commit revert and restoration
of the previous handwritten client as one atomic repository rollback, not manual generated-file edits.

In `## Testing`, list exact commands and pass/fail results for:

- generator and refresh script tests;
- offline generated-tree drift check;
- architecture scanner and its fixture tests;
- focused transport, facade, connection, error, and tier tests;
- existing Lidarr action and command tests;
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` unchanged;
- package typecheck, full coverage, and build on Node 22;
- `npm pack --dry-run --workspace packages/rfmedia-cli`, including recorded file/byte inspection;
- generated/tracked/packed size, typecheck duration, and cold `rfmedia --help` comparison;
- `git diff --check`, Markdown lint/formatting, and the offline CI job.

The PR `## Changes` section should separate upstream snapshot/manifest, generated output, handwritten
transport/facade, tooling/CI, and documentation/notice changes so reviewers can audit each trust class.
The PR must explicitly state that no live Lidarr instance, GitHub network fetch, npm publish, command,
flag, output envelope, or shell completion change is part of ordinary validation.

## Documentation Explicitly Unchanged

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`

These files remain byte-for-byte unchanged because issue #194 changes no command, subcommand, flag,
enum candidate, or help text. The existing parity assertions at
`packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts:102-137` must pass unchanged and be
listed in PR evidence. If implementation unexpectedly changes any CLI surface, this non-change decision
is invalid: update all three generators, their parity tests, the completion guide, command tests, and
the package README together.

Also leave these surfaces unchanged unless implementation reveals a genuine contract change:

- root `README.md`: it links to the package README and does not need codegen details;
- `packages/rfmedia-cli/docs/plans/lidarr-integration-foundation.md`: retain as the historical #193/#197
  design artifact; the new guide records the superseding #194 decision;
- operator command examples and machine-output documentation: generated types and result envelopes do
  not escape `LidarrClientApi`;
- issue templates and `.github/pull_request_template.md`: use them, do not customize them for this PR;
- a scheduled refresh workflow, live-container contract guide, publication guide, or bot ownership
  document: all remain future scope unless separately authorized.

## Documentation Acceptance Criteria

- The feature guide records the tested TsArr version/evidence and the exact final generator/runtime
  choice; provisional research language is removed.
- Snapshot provenance in the guide, manifest, third-party notice, and generated header agrees exactly.
- README commands execute from the documented working directory and match package scripts byte for byte.
- Regeneration/check/refresh network and mutation boundaries are unambiguous, with an exact recovery
  command for drift.
- Security ownership and the two critical merge stops are documented without exposing secrets or raw
  request/response examples.
- The package License section links the notice; `npm pack --dry-run` evidence shows whether every
  snapshot, notice, source, declaration, map, and compiled generated file is included.
- ROADMAP marks #194 alone as shipped and links the merged PR; later Lidarr issues remain open.
- Bash, Zsh, Fish, and the completion guide have no diff, and the existing cross-shell test passes.
- PR testing lists exact commands and outcomes and states that no publication or live-network contract
  test occurred.
