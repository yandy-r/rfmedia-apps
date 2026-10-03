# UX Research: Lidarr Quality Presets

## Executive Summary

Issue #213 should present preset management as an inspectable desired-state workflow, not as a
one-click optimization. The safest command shape is a dedicated `lidarr presets` subtree with
`list`, `show`, `diff`, and `apply` leaves. `list` and `show` explain local policy without requiring
Lidarr. `diff` performs fresh live reads and stops read-only. `apply` repeats the complete preflight,
shows the same semantic diff, and requests confirmation in an interactive human terminal; machine
or non-interactive apply requires explicit `--yes`. Global `--dry-run` always wins and performs no
writes.

Every review should make five things immediately clear:

1. Which exact pack and version was selected.
2. Which listening-quality, storage, bandwidth, upgrade, scoring, and naming assumptions it makes.
3. Which custom formats, quality profiles, and naming fields will be created, updated, unchanged,
   or retained.
4. Which artists and profiles are affected indirectly.
5. What the operation explicitly does **not** do: delete unrelated resources, reassign artists,
   search for releases, or rename existing files.

Human output should keep the existing Lidarr conventions: review/progress on stderr, concise
tables, a 20-row default preview where appropriate, `--verbose` for full detail, textual status
labels that do not depend on color, and a literal safe-next-step command after incomplete work.
JSON and YAML should emit one versioned document on stdout. CSV should use a fixed multi-row
contract rather than placing the entire diff in one opaque cell.

The strongest external patterns are Terraform's review-before-apply model, Kubernetes' live
would-be-applied diff and strict server validation, Ansible's explicit check-plus-diff separation,
and Recyclarr's configuration ownership and preview behavior. Recyclarr currently manages these
resource classes for Sonarr and Radarr, but its official service tables do not include Lidarr,
which confirms the product gap while providing useful UX precedents.

**Confidence**: High. The recommendation is supported by current repository command/presenter
behavior, the sibling business and API research, and current official documentation retrieved
2026-07-25.

## User Workflows

### Command hierarchy

Recommended initial grammar:

```text
rfmedia lidarr presets list
rfmedia lidarr presets show <pack-ref>
rfmedia lidarr presets diff <pack-ref>
rfmedia lidarr presets apply <pack-ref> [--dry-run] [--yes]
```

All leaves inherit the existing global `--output`, `--json`, `--verbose`, `--debug`,
`--lidarr-url`, and credential/config behavior where applicable. `list` and `show` should not
connect to Lidarr because their purpose is policy discovery. `diff` and `apply` target exactly one
canonical Lidarr origin.

`<pack-ref>` should resolve to one source unambiguously. If built-in and configured names can
collide, require a qualified form such as `builtin:lossless-baseline` or
`config:studio-archive`; never choose a source by precedence without displaying it. Shell
completion should enumerate built-in IDs and local configured names, but must not perform network
requests.

The specialized subtree avoids changing the meaning of the existing
`rfmedia lidarr apply <plan-file>` command. If implementation instead extends the generic sealed
plan format, the user-facing information architecture should remain the same and the plan artifact
must display pack identity, version, assumptions, resolved state, and target origin.

**Confidence**: High for a dedicated, discoverable hierarchy; Medium for exact names because the
issue does not decide whether shared configuration should extend the generic plan artifact.

### Discover a pack

`presets list` should produce a compact offline catalog:

```text
ID                    Version  Quality target  Upgrade policy  Naming layout
lossless-baseline     1        Lossless        To lossless     Artist/Album/Track
storage-conscious     1        Mixed lossy     Bounded         Artist/Album/Track
```

Each row should also expose `Source` when configured and built-in packs are mixed. Do not market a
pack as "best", "recommended for everyone", or "optimal". Use factual labels such as
`lossless-baseline`, then make tradeoffs discoverable through `show`.

`presets show` should display:

- stable ID, version, source/provenance, supported Lidarr assumptions, and whether the pack is
  built-in or configured;
- quality and codec policy, allowed qualities/groups, upgrade cutoff, and score thresholds;
- each custom format and its scoring rationale;
- naming switches, raw templates, and representative examples bundled as documentation;
- storage, bandwidth, compatibility, and future-import implications;
- a fixed consequences block stating that inspection performs no network calls and apply does not
  reassign artists, search, download, rename, move, or delete existing files.

For a configured pack that inherits from a baseline, `show` must render the fully resolved pack and
identify each override's source. Showing only an override fragment makes the actual desired state
undiscoverable.

**Confidence**: High. Explicit assumptions and resolved provenance are necessary because curated
settings are policy choices, not facts inferred from the user's library.

### Review a live diff

`presets diff <pack-ref>` should follow this visible sequence:

1. Resolve and validate the pack locally.
2. Display pack identity, provenance, version, and assumptions.
3. Resolve the target Lidarr origin without exposing credentials.
4. Fetch fresh custom formats, custom-format schema, quality profiles/schema, naming state,
   naming examples, and impact/reference data.
5. Validate all names, quality/group references, conditions, scores, templates, and dependencies.
6. Render a deterministic semantic diff and stop with `No changes were made`.

The human summary should appear before detail:

```text
Lidarr Preset Diff

  Pack: builtin:lossless-baseline@1
  Target: https://lidarr.example.test
  Assumptions: lossless preferred; upgrades stop at Lossless; no pruning
  Scope: 2 custom formats, 1 quality profile, complete naming policy
  Changes: 1 create, 2 updates, 3 unchanged, 7 retained
  Impact: 184 artists use "Lossless"; 2 profiles reference changed formats
  Side effects: future grabs/imports may change; existing files are not renamed
```

Then group resources in dependency order:

```text
Action     Type             Name                 ID   Impact
CREATE     Custom format    Preferred Lossless   -    Used by Lossless after apply
UPDATE     Quality profile  Lossless             4    184 assigned artists
UPDATE     Naming           Instance naming      1    Future imports/explicit renames
UNCHANGED  Custom format    Reject Transcode      8    Referenced by Lossless
RETAIN     Quality profile  Spoken Word           7    Unmanaged
```

For each update, show field-level directional values. Preserve behavioral order instead of sorting
qualities or conditions into a misleading no-op:

```text
Quality profile "Lossless" (id 4)
  upgradeAllowed        false -> true
  cutoff                FLAC  -> Lossless
  qualities[1]          FLAC  -> Lossless group [FLAC, ALAC]
  formatScores.Preferred Lossless
                         0     -> 100
  impact                184 artists currently assigned
```

Naming review should show both raw templates and server-generated examples. Label dormant
templates when `renameTracks=false`, and state that changing the singleton affects future imports
or later explicit Lidarr rename operations, not files during this command.

Unchanged managed resources should be summarized by default and expanded with `--verbose`.
Retained unmanaged resources should be counted and optionally listed; they must never appear as
deletions. Long output should be paged by the user's shell, not by spawning an internal pager.

A valid no-op diff is success:

```text
Converged: all managed Lidarr preset resources already match.
No changes were made.
```

**Confidence**: High. This extends the current Lidarr mutation presenter's before/after, risk,
impact, truncation, and convergence conventions to shared configuration resources.

### Apply interactively

`presets apply` should perform the same local resolution, fresh reads, validation, dependency
resolution, and diff rendering as `presets diff`. The prompt comes only after the complete review:

```text
Apply builtin:lossless-baseline@1 to https://lidarr.example.test?
This will create 1 custom format, update 1 profile used by 184 artists,
and update future-import naming. Existing files will not be renamed. [y/N]
```

The default is no. Cancellation before mutation should say `Lidarr preset apply cancelled; no
changes were made` and return without history writes. `--yes` skips only this confirmation; it does
not skip validation, live-state comparison, origin checks, or read-back verification. A no-change
apply should not prompt or write.

Immediately before the first write, re-read operation-relevant state or verify a sealed
expected-state/checksum. If it changed, stop affected work and direct the user to run a fresh diff.
Execute custom formats first, read back their IDs, then dependent quality profiles. Naming is
independent but should be reported as a distinct pipeline. Every write needs a read-back result.

**Confidence**: High. This matches the existing `confirmMutationApply` flow and addresses Lidarr's
lack of a cross-resource transaction.

### Apply in automation

Machine/non-TTY mutation requires explicit `--yes`. Machine format alone must never authorize a
write:

```bash
rfmedia lidarr presets apply builtin:lossless-baseline \
  --yes --output json > lidarr-preset-result.json
```

`--dry-run` has precedence over `--yes` and performs the full live preflight with zero mutation and
history writes:

```bash
rfmedia lidarr presets apply config:studio-archive \
  --dry-run --output yaml
```

A successful diff with changes and a successful no-op diff should both use the normal success exit
status; automation inspects `result.hasChanges` and summary counts. Invalid configuration,
incompatible server state, failed apply, uncertain writes, and partial convergence must be
nonzero. If change-sensitive exit status is desired, add a future explicit option rather than
making ordinary diff use the same exit code as an operational failure.

**Confidence**: High for explicit approval and structured status; Medium for exact change-sensitive
exit behavior because the repository should decide this centrally rather than copying another
tool's convention.

### Recover from partial or uncertain work

The terminal summary must account for every selected resource using stable outcomes:
`succeeded`, `satisfied`, `failed`, `uncertain`, and `not-attempted`. A failed custom format makes
dependent quality profiles `not-attempted`; it must not produce placeholder IDs. An ambiguous
timeout after a write becomes `uncertain` until a fresh read proves the result.

Recovery is convergence-based:

1. Fix the reported permission, compatibility, validation, or connectivity problem.
2. Rerun the same apply command.
3. Fresh reads classify already-converged resources as `satisfied`.
4. Only remaining changes are attempted.

Human output should print the exact rerun command with the selected pack ref and necessary approval
flags, shell-quoted safely. Do not promise rollback: Lidarr has no transaction spanning these
resources, and reversing a partially applied desired state may itself be harmful.

**Confidence**: High. The current Lidarr apply presenter already exposes partial outcomes and a
literal safe-next-step command.

## CLI UX Best Practices

### Feedback and State Design

Human text and table output should remain entirely on stderr, matching the current Lidarr
presenters. Machine formats should emit exactly one document/stream on stdout with no banners,
prompts, progress, ANSI codes, or debug lines.

Recommended JSON/YAML shape:

```json
{
  "schemaVersion": "lidarr-preset-diff.v1",
  "command": "lidarr-presets-diff",
  "mode": "diff",
  "pack": {
    "ref": "builtin:lossless-baseline",
    "id": "lossless-baseline",
    "version": 1,
    "source": "builtin"
  },
  "target": {
    "origin": "https://lidarr.example.test"
  },
  "assumptions": [
    {
      "code": "quality.lossless-preferred",
      "category": "quality",
      "summary": "Prefer lossless releases"
    }
  ],
  "summary": {
    "hasChanges": true,
    "create": 1,
    "update": 2,
    "unchanged": 3,
    "retained": 7,
    "warnings": 1
  },
  "resources": [
    {
      "type": "quality-profile",
      "name": "Lossless",
      "id": 4,
      "action": "update",
      "impact": {
        "assignedArtists": 184
      },
      "changes": [
        {
          "path": "upgradeAllowed",
          "before": false,
          "after": true
        }
      ]
    }
  ],
  "namingExamples": {
    "singleTrack": "Artist/Album/01 - Track.flac"
  },
  "warnings": [],
  "execution": {
    "outcome": "succeeded"
  }
}
```

Apply should use a sibling `lidarr-preset-apply.v1` schema with `status`,
`dryRun`, `summary`, and ordered per-resource outcomes. Keep stable codes separate from localized
human messages. Treat fields as additive within v1; renamed, removed, or semantically changed
fields require a new schema version.

CSV should use a fixed row union:

- `summary`: pack, target, mode, and aggregate counts;
- `assumption` and `warning`: stable code, category/severity, and message;
- `resource`: type, name, ID, action, dependency, and impact counts;
- `field`: resource identity, property path, and canonical JSON before/after values;
- `naming-example`: example kind and safely encoded value.

Use a `rowType` discriminator and fixed columns in every row. Preserve the existing CSV
spreadsheet-formula neutralization. If a future output mode cannot represent a safety-critical
field, reject that combination explicitly rather than silently omitting the field.

**Confidence**: High. This preserves the repository's stdout/stderr and formatter contracts while
making the diff directly queryable by automation.

### Determinism

- Order resource groups as custom formats, quality profiles, then naming.
- Within a group, order by normalized portable name and use resource ID only as a tie-breaker.
- Preserve behavioral array order inside quality groups and custom-format specifications.
- Order field changes by a documented schema path order, with unknown/additive paths lexical last.
- Exclude timestamps, durations, request IDs, and server-local IDs from semantic equality.
- Include pack ID/version and canonical origin in every result.
- Emit explicit `false`, `0`, empty arrays, and whitespace-bearing templates; never treat them as
  missing.

The same desired and live semantic states should produce byte-stable resource ordering and the same
classification, apart from documented volatile metadata.

**Confidence**: High. Stable review and idempotency require deterministic ordering without
normalizing away behavioral priority.

### Assumptions and consequences

Assumptions should appear in three places:

1. `presets list`: a short quality-target and tradeoff label.
2. `presets show`: the complete policy explanation and bundled examples.
3. Every `diff`, dry-run, and apply review: selected version, high-impact assumptions, and an
   invitation to run `presets show` for full detail.

Machine output should use stable assumption codes and categories, not only prose. Separate policy
from evidence:

- `Assumption: lossless releases are preferred` is preset policy.
- `Observed: 184 artists use profile Lossless` is live evidence.
- `Consequence: future grabs may change for those artists` is impact.

Always state the negative scope: no pruning, artist reassignment, searches/downloads, or implicit
renames. These statements prevent users from inferring side effects from Lidarr terminology.

**Confidence**: High. The feature's largest UX risk is an opaque preset whose policy looks like a
server-derived recommendation.

### Validation feedback

Validation should be phased and path-specific:

1. Parse and strict config validation.
2. Pack resolution and override validation.
3. Connection/authentication.
4. Live capability and schema validation.
5. Identity/reference/dependency resolution.
6. Naming example and path-safety review.
7. Stale-state check immediately before write.
8. Read-back verification after each write.

Report all independent local validation errors in one run so users can fix a config once. Stop
before mutation on any blocking preflight error. Server-side errors should retain safe field
details when available, but never raw response bodies, authorization headers, API keys, or URLs
containing credentials.

Every error needs:

- a stable machine code and phase;
- the affected pack/resource/property path;
- expected and sanitized observed values where safe;
- whether any write may have been dispatched;
- whether retry is safe; and
- one concrete next action.

**Confidence**: High. This follows the current Lidarr typed-error and apply-outcome model and avoids
trial-and-error configuration editing.

### Accessibility and terminal safety

- Never encode `create`, `update`, `unchanged`, warning, or failure by color alone; print the word
  or symbol plus text. This follows [WCAG 2.2 use-of-color guidance](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
  (W3C Recommendation; guidance retrieved 2026-07-25).
- Honor non-TTY color suppression and the [`NO_COLOR`](https://no-color.org/) convention (last
  updated 2026-07-21). Machine output contains no ANSI styling.
- Use the repository's display-width-aware truncation for CJK, combining marks, emoji, and ANSI
  content. Never truncate IDs, pack refs, property paths, or recovery commands.
- Sanitize or reject C0/C1 controls, terminal escape sequences, and bidirectional controls in
  configured and server-returned names, templates, examples, and messages.
- Prefer short static lines over continuously redrawn spinners. Screen readers and redirected logs
  must receive meaningful status in execution order.
- On narrow terminals, switch field-level diffs to one property per line rather than forcing a
  wide before/after table. `--output yaml` provides a readable non-tabular alternative.
- Prompts go to stderr, default to no, accept the existing `y`/`yes` grammar, and never appear in
  machine or non-interactive execution.

**Confidence**: High. The repository already has Unicode-aware terminal utilities and textual
status conventions; the external accessibility principles are stable.

## Error Handling

| State                                    | Human message                                                                | Machine evidence                                                       | Mutation/recovery                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| Pack not found                           | `Preset "x" was not found. Run rfmedia lidarr presets list.`                 | `pack_not_found`, requested ref                                        | No network or mutation; list available refs              |
| Ambiguous source/name                    | Name both matching qualified refs                                            | `pack_ambiguous`, candidates                                           | Require `builtin:` or `config:` qualification            |
| Unknown config key                       | Include exact path, for example `lidarr.presets.archive.naming.trackFormatx` | `config_unknown_key`, path                                             | No network; correct typo and rerun                       |
| Invalid override merge                   | Name conflicting sources and resolved property                               | `pack_merge_conflict`, path, sources                                   | No network; make precedence explicit                     |
| Authentication rejected                  | Name target origin, never key                                                | `authentication`, phase `connect`                                      | No writes; correct credential/config                     |
| Lidarr unavailable/timeout               | Identify Lidarr and operation; include retry timing when known               | Existing Lidarr error code, retryability, attempts                     | Diff fails; never authorize writes from stale cache      |
| Unsupported custom-format implementation | Name implementation and connected schema/version evidence                    | `unsupported_condition`, resource/path                                 | Zero writes; choose compatible pack or upgrade Lidarr    |
| Invalid regex/typed condition            | Exact condition and field path, sanitized value class                        | `invalid_condition`, path                                              | Zero writes; correct preset                              |
| Missing/ambiguous quality                | Name requested quality/group and available exact candidates                  | `quality_unresolved` or `quality_ambiguous`                            | Zero writes; correct portable name                       |
| Duplicate resource match                 | Name every same-normalized live resource and ID                              | `resource_ambiguous`, candidates                                       | Zero writes; resolve collision in Lidarr                 |
| Dangling format score                    | Name profile and unresolved format                                           | `format_reference_unresolved`                                          | Zero writes; add/correct format                          |
| Invalid naming template                  | Name field and server/local reason                                           | `naming_invalid`, path                                                 | Zero writes; correct template                            |
| Naming example unavailable/unsafe        | State that naming preflight cannot be proven                                 | `naming_preview_invalid`                                               | Block naming apply; do not present an unsafe example     |
| Concurrent drift before write            | Show expected, newly observed, and desired projections                       | `stale`, affected resource/dependents                                  | Do not overwrite; rerun diff                             |
| Server rejects a write                   | Name resource, status, safe validation detail                                | `failed`, dispatch state, retryability                                 | Stop dependents; independent pipeline policy is explicit |
| Timeout after possible write             | `Outcome uncertain; checking live state before retry`                        | `uncertain`, dispatch/verification state                               | Fresh read; never blindly create a duplicate             |
| Read-back differs                        | Show requested and normalized observed fields                                | `verification_mismatch`                                                | Partial/nonzero; rerun after review                      |
| Rate limited                             | Include `Retry-After` when present                                           | `rate_limited`, retryAfterSeconds                                      | Stop new dependent admissions; retry later               |
| No changes                               | `Converged... No changes were made.`                                         | `hasChanges:false`, zero counts                                        | Success; no prompt, write, or history                    |
| User declines                            | `Apply cancelled; no changes were made.`                                     | Human-only flow; no result required unless project convention adds one | Success/cancel before mutation                           |
| Ctrl+C before first write                | `Interrupted before mutation; no changes were made.`                         | Stable cancelled status if machine handling supports it                | No history; safe rerun                                   |
| Ctrl+C during apply                      | Identify in-flight resource and stabilization result                         | `partial` or `uncertain`; all resource outcomes                        | Stop new admissions; print exact rerun command           |
| Partial convergence                      | Count succeeded/satisfied/failed/uncertain/not-attempted                     | `status:partial`, complete ordered outcomes                            | Nonzero; convergence-based rerun                         |

Usage/configuration errors should fail before network access when possible. A completed valid diff,
including a no-op, succeeds. Any result that cannot prove full requested apply convergence is
nonzero. Preserve the repository's established exit-code taxonomy instead of assigning
change-present semantics to an existing error code.

**Confidence**: High. The states derive from verified API constraints and the existing Lidarr
failure, stale-state, partial-result, and recovery contracts.

## Performance/Progress UX

Fresh reads are necessary for authorization, but progress should communicate phases rather than
invent precision:

```text
[1/5] Validating preset builtin:lossless-baseline@1
[2/5] Reading Lidarr configuration
[3/5] Resolving schema, references, and impact
[4/5] Building deterministic diff
[5/5] Validating naming examples
```

For apply, use resource counts after approval:

```text
[1/3] Custom format "Preferred Lossless"  created and verified
[2/3] Quality profile "Lossless"          updated and verified
[3/3] Naming configuration                updated and verified
```

Guidelines:

- Show progress only on an interactive human stderr. Machine formats produce a single final
  document and no spinner/event stream.
- Do not render a progress UI for fast offline `list`/`show` or a fast one-resource diff.
- Parallelize independent GET discovery only within the existing scheduler/transport bounds.
  Maintain deterministic output order regardless of response completion order.
- Writes remain dependency-aware: custom formats before profiles. Safe independent work, such as
  naming, must have an explicit continue/stop policy and still produce ordered final output.
- Report retry backoff as a static message with attempt count and next retry time. Avoid a
  second-by-second countdown.
- Use elapsed duration only as diagnostic metadata; never imply a fixed completion estimate.
- For large retained/unchanged sets, display aggregate progress and cap detail at the existing
  preview limit. `--verbose` expands only final static output, not progress noise.
- On interruption, stop admitting new writes, allow the current bounded request/read-back to reach a
  classified state, then print a complete partial summary.

Recyclarr's current official
[sync behavior](https://recyclarr.dev/guide/sync-behavior/) (retrieved 2026-07-25) uses separate
pipelines, skips dependent quality-profile work when custom formats fail, and continues independent
pipelines. That is a useful model, but rfmedia should preserve its scheduler, ordered outcome, and
explicit recovery conventions.

**Confidence**: High for phase-based/static progress and dependency ordering; Medium for whether
independent naming should continue after another pipeline fails, which remains a product decision.

## Competitive Analysis

| Tool/pattern            | Current official behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Useful lesson                                                                                                                                          | Caution                                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terraform plan/apply    | [`terraform plan`](https://developer.hashicorp.com/terraform/cli/commands/plan) refreshes remote objects, computes a desired-state plan, supports saved plans, JSON UI, `-no-color`, and optional detailed exit codes. [`terraform apply`](https://developer.hashicorp.com/terraform/cli/commands/apply) previews and prompts unless explicitly auto-approved; JSON implies non-interactive input and therefore requires approval or a saved plan. Documentation retrieved 2026-07-25.                                      | Show exact changes before approval, bind reviewed intent, re-check drift, and require explicit automation approval.                                    | Terraform warns that saved plans can contain secrets. rfmedia's artifacts/results must remain secret-free, and its existing exit codes should not be copied blindly.                          |
| Kubernetes diff/apply   | [`kubectl diff`](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_diff/) compares live state with the would-be-applied state and has distinct no-diff/diff/error statuses. [`kubectl apply`](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_apply/) supports client/server dry-run and strict/warn/ignore validation. Pages last modified 2026-04-24 and 2026-03-22.                                                                                                                          | Validate against the connected server, expose would-be state, distinguish warning from blocking errors, and keep scope explicit.                       | Lidarr has no server-side non-persisting apply, so rfmedia dry-run must use GET/schema/example endpoints and cannot claim perfect write validation.                                           |
| Ansible check/diff      | [Ansible check and diff mode](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_checkmode.html) separates no-change simulation from before/after display and warns that unsupported modules may report nothing; diff can reveal secrets. Current docs retrieved 2026-07-25.                                                                                                                                                                                                                         | Make dry-run and detailed diff independently understandable, and disclose what validation is not authoritative.                                        | A silent partial preview is unsafe here. All three Lidarr resource pipelines must explicitly report validated, unsupported, or blocked.                                                       |
| Recyclarr               | Current [features](https://recyclarr.dev/guide/features/) and [preview CLI](https://recyclarr.dev/cli/sync/) support templates, custom formats, profiles, naming, and GET-only preview for Sonarr/Radarr. Its [quality-profile reference](https://recyclarr.dev/reference/configuration/quality-profiles/) treats omitted properties as unmanaged; [custom-format deletion](https://recyclarr.dev/reference/configuration/custom-formats/) is off by default and scoped to synchronized formats. Docs retrieved 2026-07-25. | Offer local templates, preview full work, preserve omitted/unmanaged state, make deletion opt-in, validate collisions, and expose dependency failures. | Official service tables list Sonarr and Radarr, not Lidarr. Guide-backed resources may float; rfmedia built-ins should have explicit local versions and assumptions.                          |
| Buildarr                | The official [Buildarr project](https://github.com/buildarr/buildarr) describes static YAML, multi-instance configuration, and idempotent writes. Its [quality-profile docs](https://buildarr.github.io/plugins/sonarr/configuration/profiles/quality/) make `delete_unmanaged` explicit and warn about deletion. Sources retrieved 2026-07-25.                                                                                                                                                                             | Use readable named resources, idempotent convergence, and visibly conservative ownership defaults.                                                     | Current official plugin listings do not show a Lidarr management plugin, and some plugin docs are version-lagged. Treat this as a secondary pattern, not evidence of current Lidarr behavior. |
| Existing rfmedia Lidarr | `lidarr-mutation-presenter.ts` shows plan ID/checksum/origin/risk, before/after tables, 20-row previews, `--verbose`, dry-run review, explicit non-TTY/machine `--yes`, partial outcomes, and a shell-safe recovery command. `lidarr.ts` keeps machine data on stdout and human review on stderr. Inspected 2026-07-25.                                                                                                                                                                                                     | Reuse this vocabulary and safety behavior so preset management feels native.                                                                           | Current plan entries target artists/albums. Shared resource dependencies and field-level config diffs require new typed presentation rather than forcing them into artist rows.               |

**Confidence**: High for Terraform, Kubernetes, Ansible, Recyclarr, and local behavior based on
current primary sources; Medium for Buildarr's current competitive reach because its official
plugin documentation is uneven and does not establish Lidarr support.

## Recommendations

### Must

1. Add offline `list`/`show` discovery and read-only live `diff`; make mutation a separately named
   `apply` action.
2. Display stable pack ID, version, source, fully resolved state, assumptions, compatibility, and
   explicit non-effects before every diff/apply.
3. Use fresh live reads with no stale-cache authorization; validate all three resource types and
   dependencies before the first write.
4. Render deterministic `create`, `update`, `unchanged`, and `retained` classifications plus
   field-level before/after values, naming examples, artist assignment counts, and profile/format
   references.
5. Preserve unrelated resources. Omission is not deletion, and v1 should expose no prune behavior.
6. Apply in dependency order, revalidate before writes, read back every write, and report
   `succeeded`, `satisfied`, `failed`, `uncertain`, and `not-attempted`.
7. Show the complete review before one default-no prompt. Require `--yes` for machine/non-TTY
   mutation; `--yes` never bypasses validation and `--dry-run` always wins.
8. Keep human/progress output on stderr and emit exactly one versioned JSON/YAML result on stdout.
   Provide a fixed, safety-complete CSV row contract.
9. Give every failure a stable code, phase, resource/path, dispatch state, retryability, and concrete
   next action without secrets or raw server bodies.
10. Do not rely on color; honor plain/non-TTY output, sanitize terminal-unsafe text, use
    display-width-aware truncation, and keep essential identifiers untruncated.
11. Update help and Bash/Zsh/Fish completions together. Complete local pack refs only; never contact
    Lidarr during completion.
12. Test no-op, invalid config, unsupported schema, ambiguous name, concurrent drift, failed
    prerequisite, uncertain write, partial apply, cancellation, non-TTY approval, machine stream
    purity, Unicode width, control characters, and second-run convergence.

**Confidence**: High. These are required to meet the issue's reviewability, determinism,
dry-run, safety, and automation goals without regressing existing CLI contracts.

### Should

1. Qualify colliding preset refs with `builtin:` and `config:` and surface override provenance per
   resolved field.
2. Use a compact summary, grouped resource table, then vertical field diffs; collapse
   unchanged/retained details unless `--verbose`.
3. Print an exact shell-quoted rerun command after partial/uncertain work.
4. Use phase-based interactive progress, deterministic final ordering, and static retry messages.
5. Expose structured assumption, warning, impact, and consequence codes in machine output.
6. Provide an explicit machine `hasChanges` field and preserve success for valid changed/no-op
   diffs.
7. Make server normalization visible after read-back so users can distinguish benign canonical
   representation from persistent semantic drift.
8. Treat naming as an independent pipeline in result data even if the initial execution policy
   stops after any prior failure.

**Confidence**: High except for independent naming continuation, which is Medium pending a
product-level failure policy.

### Nice

1. Add `--assumptions-only` or a machine filter only if `presets show` proves too verbose for
   onboarding; avoid expanding the initial command surface prematurely.
2. Offer a future opt-in detailed diff exit code after the repository defines one consistently
   across commands.
3. Add an explicit saved diff/plan artifact for team review if issue #213 does not initially extend
   the generic Lidarr plan engine.
4. Add `--explain <assumption-or-resource>` for deep preset rationale when the bundled catalog grows.
5. Consider a terminal narrow mode that omits optional columns automatically, while retaining
   complete vertical field detail.

**Confidence**: Medium. These improve scale or specialist workflows but are not necessary for a
safe first release.

## Open Questions

1. Should the command be a specialized `lidarr presets diff/apply` subtree, or should shared
   configuration extend the existing sealed `lidarr plan` and `lidarr apply <plan-file>` contract?
2. Which built-in packs ship first, who approves their policy, and are pack versions pinned in user
   config or allowed to float with the CLI release?
3. What is the exact merge model for configured packs inheriting built-ins: replace complete
   collections, merge resources by name, or permit field-level overrides?
4. Does a same-name live resource become managed automatically, require explicit adoption, or block
   by default?
5. Does a pack own the entire naming singleton or only declared fields?
6. When custom-format/profile work fails, should independent naming still run or should apply stop
   all later admissions?
7. Should a normal changed diff exit success with `hasChanges=true`, or should an opt-in
   `--detailed-exit-code` be included in v1?
8. Is CSV required to contain every field-level change in v1, or may the command explicitly reject
   CSV until a stable multi-row contract is implemented?
9. What minimum supported Lidarr version/capability set should `presets show` disclose?
10. Are server naming examples advisory only, and which additional local path-safety checks are
    required for Linux, macOS, Windows, and Docker-mounted libraries?
11. Should interruption during an in-flight write wait for read-back stabilization, and what upper
    bound applies before the result becomes `uncertain`?
12. Is saved-plan/team-review UX required now, or can deterministic diff plus immediate
    revalidation satisfy the first release?
