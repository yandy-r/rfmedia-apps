<!-- markdownlint-disable MD026 -->

# Documentation Analysis:

<!-- markdownlint-enable MD026 -->

## Executive Summary

Issue #200 requires a focused update to the existing Lidarr plan/apply documentation, not a new
documentation hierarchy. The public contract must explain the artist-only workflow, explicit
selection, reviewed file-impact evidence, the safe `keep-files` default, cumulative destructive
authorization, dry-run behavior, verified absence, resume guidance, and the independent optional
Plex scan. Album deletion remains in issue #223.

The documentation change is incomplete unless command help and all shell completions expose the
same command and flags, both `ROADMAP.md` references to #200 are reconciled, and the pull request
records exact validation results using the repository template.

## Must-Read Documents

### Required

- `docs/plans/file-aware-lidarr-artist-delete/feature-spec.md`: authoritative scope, safety rules,
  CLI behavior, edge cases, and success criteria.
- `docs/plans/file-aware-lidarr-artist-delete/analysis-architecture.md`: plan/apply ownership,
  present-versus-absent semantics, history, recovery, and non-deferability.
- `docs/plans/file-aware-lidarr-artist-delete/analysis-integration.md`: generated Lidarr endpoint,
  optional Plex scan boundary, and persistence constraints.
- `docs/plans/file-aware-lidarr-artist-delete/analysis-patterns.md`: repository conventions,
  command/presenter patterns, completion parity, tests, and known 404/dry-run gotchas.
- `packages/rfmedia-cli/README.md`: public command reference and copy-paste workflow examples.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: canonical plan schema, review, apply,
  verification, history, resume, and recovery guide.
- `ROADMAP.md`: update both existing #200 references consistently while retaining #223 as the
  owner of album deletion.

### Nice-to-have

- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`: useful background for
  maintainers, but its generated-client ownership rules do not change.
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`: provenance reference for maintainers;
  no content update is expected.

## Architecture Docs

No new architecture document is required. The existing Lidarr plan/apply guide should describe
`artist-delete` as an additive `rfmedia.lidarr-plan.v2` operation and make these boundaries
explicit:

- Planning seals stable artist IDs, paths, album counts, track-file counts, exact bytes, and the
  plan-wide `keep-files` or `delete-files` mode.
- Real apply always requires `--allow-artist-delete`; delete-files plans also require
  `--allow-file-delete`. `--yes` bypasses only confirmation.
- Initial absence is stale. Only a typed targeted not-found after a possible dispatch verifies the
  `{ exists: false }` postcondition.
- Deletes are sequential, single-ID, non-retried, and excluded from generic deferred replay.
- `--plex-scan` is apply-time, best-effort intent outside the plan, checksum, history, and resume
  identity; scan failure never changes a verified Lidarr result.
- `rfmedia` reports Lidarr-provided impact and never traverses or deletes the local filesystem
  directly.

## Reading List

### Required implementation and release parity

- Update `packages/rfmedia-cli/README.md` with syntax and examples for
  `rfmedia lidarr plan artist-delete`, keep-files versus delete-files behavior, required selection,
  dry-run, apply authorization, optional Plex scanning, and resume.
- Update `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` with the strict delete artifact,
  evidence and totals, drift checks, per-target outcomes, verified absence, uncertainty, history,
  and recovery rules.
- Update both #200 references in `ROADMAP.md`; mark only artist deletion delivered and keep album
  deletion assigned to issue #223.
- Update all three hand-maintained completion templates:
  `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`.
- Update `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` so completion parity
  covers `artist-delete`, its planning flags, and apply flags.
- Use `.github/pull_request_template.md` unchanged as the PR body baseline. Preserve every required
  section and list the exact repository/package validation scripts run with pass/fail outcomes.

### Nice-to-have follow-up

- Add a dedicated artist-delete feature page only if the plan/apply guide becomes difficult to
  navigate; otherwise keep one canonical workflow description.
- Add a short cross-link from generated-client documentation if maintainers need help locating the
  single-ID delete facade. Do not document private generated modules as public API.

## Documentation Gaps

- The current public docs do not explain an artist deletion operation whose success condition is
  absence rather than a changed artist record.
- The distinction between `--yes`, `--allow-artist-delete`, and conditional
  `--allow-file-delete` must be explicit in examples, resume commands, and troubleshooting.
- File-impact wording must distinguish Lidarr-reported counts/bytes from guaranteed reclaimed disk
  space and state that missing evidence blocks planning.
- Dry-run documentation must distinguish planning dry-run, which writes no plan artifact, from
  apply dry-run, which writes no claim, history, SQLite state, Lidarr state, files, or Plex scan.
- Partial and uncertain outcomes need actionable, checksum-pinned recovery guidance without
  suggesting an automatic retry.
- Completion parity is part of the documented CLI contract; Bash, Zsh, Fish, and
  `templates.spec.ts` are required changes rather than optional release polish.
- Roadmap wording can accidentally broaden #200 to albums; both #200 references must remain
  artist-only, with albums retained by #223.
