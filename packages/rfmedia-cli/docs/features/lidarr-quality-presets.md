# Lidarr Quality Presets

`rfmedia lidarr presets` is a desired-state workflow for reviewing and applying custom formats,
quality profiles, and Lidarr's complete supported naming policy. It is separate from sealed
`rfmedia lidarr plan` artifacts: a preset run always starts from the selected local pack and fresh
live state.

The workflow is additive. It adopts declared same-name resources, preserves undeclared resources
and scores, and never deletes or renames resources.

## Command Surface

| Command                                             | Connection | Effect                                                      |
| --------------------------------------------------- | ---------- | ----------------------------------------------------------- |
| `rfmedia lidarr presets list`                       | Offline    | Lists built-in and configured packs                         |
| `rfmedia lidarr presets show <pack-ref>`            | Offline    | Shows one fully resolved pack                               |
| `rfmedia lidarr presets diff <pack-ref>`            | Fresh read | Reports the complete semantic difference; writes nothing    |
| `rfmedia lidarr presets apply <pack-ref>`           | Fresh read | Reviews, approves, applies, journals, and verifies changes  |
| `rfmedia lidarr presets apply <pack-ref> --dry-run` | Fresh read | Runs the complete review without mutation, lock, or journal |

Connection options are available on `diff` and `apply`:

```bash
rfmedia lidarr presets diff builtin:balanced \
  --lidarr-url https://lidarr.example.test \
  --lidarr-api-key "$LIDARR_API_KEY"
```

Prefer configuration or a supported secret-injection mechanism over placing the API key in shell
history.

Typical workflows:

```bash
# Offline discovery
rfmedia lidarr presets list
rfmedia lidarr presets show builtin:lossless

# Fresh, read-only review
rfmedia lidarr presets diff builtin:balanced

# Full apply review without mutation
rfmedia lidarr presets apply builtin:balanced --dry-run

# Interactive apply; the single prompt defaults to no
rfmedia lidarr presets apply builtin:balanced

# Non-interactive apply after reviewing the same complete live policy
rfmedia lidarr presets apply builtin:balanced --yes

# Machine-readable review
rfmedia --output json lidarr presets diff builtin:space-saver
rfmedia --output yaml lidarr presets show config:vinyl-archive
rfmedia --output csv lidarr presets apply builtin:balanced --dry-run
```

Use `--verbose` on `diff` or `apply` for a larger, still bounded human review.

## Pack References and Digests

Every pack has a source, lowercase kebab-case ID, positive integer version, provenance, and
normalized SHA-256 digest:

- `builtin:<id>` always selects immutable package data.
- `config:<id>` always selects `lidarr.profilePresets.packs.<id>`.
- An unqualified `<id>` is accepted only when it resolves to exactly one source.

Use qualified references in automation. Configured IDs cannot shadow `balanced`, `lossless`, or
`space-saver`. A configured pack's digest is computed from its fully resolved normalized content;
it is not supplied in YAML. Digests identify exact policy content and detect drift, but they are
not signatures.

## Built-In Policies

The v1 release contains exactly these immutable packs:

| Reference             | Version | Digest                                                             |
| --------------------- | ------- | ------------------------------------------------------------------ |
| `builtin:balanced`    | 1       | `01083817a0ba42c29d3993e7d275caead6709f9e2e5bd5a518973d37d941207d` |
| `builtin:lossless`    | 1       | `de08001183d18276a071cdc7b1058458f51aba98d7e4e6badfc7a128dfe91710` |
| `builtin:space-saver` | 1       | `ec0c6b3d0c6b1d629a6c1e41844ce0c75b9445833d848aa6321cd1bca340b3d2` |

All three require the connected Lidarr schema to expose the exact named qualities and groups they
declare. Group and child order is policy-significant.

### Shared Naming Policy

Every built-in owns the same complete supported naming policy:

```yaml
renameTracks: true
replaceIllegalCharacters: true
colonReplacementFormat: 4
standardTrackFormat: "{Album Title} ({Release Year})/{Artist Name} - {Album Title} - {track:00} - {Track Title}"
multiDiscTrackFormat: "{Album Title} ({Release Year})/{Medium Format} {medium:00}/{Artist Name} - {Album Title} - {track:00} - {Track Title}"
artistFolderFormat: "{Artist Name}"
```

This policy controls future imports and a later explicit Lidarr rename operation. Preset apply does
not send a rename command and does not rename or move existing files.

### Balanced Version 1

`builtin:balanced` manages:

- Quality profile `RFMedia Balanced`.
- Allowed `High Quality Lossy` children, in order: `MP3-VBR-V0`, `AAC-VBR`, `MP3-320`,
  `OGG Vorbis Q9`, `AAC-320`, and `OGG Vorbis Q10`.
- Allowed `Lossless` children, in order: `FLAC`, `ALAC`, `APE`, `WavPack`, `FLAC 24bit`, and
  `ALAC 24bit`.
- `upgradeAllowed: true`, cutoff `Lossless`, minimum format score `0`, and cutoff format score
  `25`.
- Custom format `RFMedia WEB Source`, excluded from renaming, with one required, non-negated
  `ReleaseTitleSpecification` named `WEB source` and expression `\bWEB(?:[-_. ]?DL)?\b`.
- A profile score of `25` for `RFMedia WEB Source`.

It accepts high-quality lossy and lossless releases, then continues upgrading toward the lossless
cutoff and WEB preference. Lossless upgrades can increase storage and bandwidth. The WEB marker is
a title-based preference, not proof of provenance.

### Lossless Version 1

`builtin:lossless` manages:

- Quality profile `RFMedia Lossless`.
- The allowed `Lossless` children `FLAC`, `ALAC`, `APE`, `WavPack`, `FLAC 24bit`, and
  `ALAC 24bit`, in that order.
- `upgradeAllowed: true`, cutoff `Lossless`, minimum format score `0`, and cutoff format score
  `100`.
- Custom format `RFMedia 24-bit Lossless`, excluded from renaming, with one required, non-negated
  `ReleaseTitleSpecification` named `24-bit marker` and expression
  `\b(?:FLAC|ALAC)[-_. ]?24(?:[-_. ]?bit)?\b|\b24[-_. ]?bit\b`.
- A profile score of `100` for `RFMedia 24-bit Lossless`.

It provides no lossy fallback. FLAC, ALAC, APE, and WavPack remain compatible; 24-bit releases are
preferred rather than required. This policy prioritizes preservation and can consume substantially
more storage and bandwidth.

### Space Saver Version 1

`builtin:space-saver` manages:

- Quality profile `RFMedia Space Saver`.
- Allowed `Mid Quality Lossy` children, in order: `OGG Vorbis Q7`, `MP3-VBR-V2`, `MP3-256`,
  `OGG Vorbis Q8`, and `AAC-256`.
- Allowed `High Quality Lossy` children, in order: `MP3-VBR-V0`, `AAC-VBR`, `MP3-320`,
  `OGG Vorbis Q9`, `AAC-320`, and `OGG Vorbis Q10`.
- `upgradeAllowed: true`, cutoff `High Quality Lossy`, minimum format score `0`, and cutoff format
  score `25`.
- Custom format `RFMedia MP3 320`, excluded from renaming, with one required, non-negated
  `ReleaseTitleSpecification` named `MP3 320 marker` and expression
  `\bMP3[-_. ]?320\b|\b320(?:kbps|k)\b`.
- A profile score of `25` for `RFMedia MP3 320`.

It excludes lossless releases and reduces typical storage and bandwidth at the cost of irreversible
lossy compression. AAC, OGG Vorbis, and MP3 remain compatible; MP3-320 is preferred rather than
required.

## Configured Packs

Configured packs live only under `lidarr.profilePresets.packs` in `.rfmedia.yaml`. See the complete
secret-free `vinyl-archive` example in [`rfmedia.example.yaml`](../../../../rfmedia.example.yaml).

The schema is exact and self-contained:

| Path or object   | Required fields                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `profilePresets` | `packs`                                                                                                                                   |
| One pack         | `version`, `description`, `assumptions`, `consequences`, `capabilities`, `customFormats`, `qualityProfiles`, `naming`                     |
| Custom format    | `name`, `includeCustomFormatWhenRenaming`, `specifications`                                                                               |
| Specification    | `name`, `implementation`, `negate`, `required`, `fields`                                                                                  |
| Quality profile  | `name`, `upgradeAllowed`, `cutoff`, `items`, `minFormatScore`, `cutoffFormatScore`, `formatScores`                                        |
| Quality item     | Quality: `kind`, `name`, `allowed`; group: those fields plus `items`                                                                      |
| Format score     | `customFormatName`, `score`                                                                                                               |
| Naming           | `renameTracks`, `replaceIllegalCharacters`, `colonReplacementFormat`, `standardTrackFormat`, `multiDiscTrackFormat`, `artistFolderFormat` |

Unknown keys, sensitive-looking keys, aliases, cycles, duplicate normalized names, and built-in
shadowing are rejected. V1 accepts no inheritance, URL, remote catalog, external file, executable
content, or placeholder policy.

Pack IDs are lowercase kebab case. A configuration may contain 1–32 packs. Each pack must contain
at least one quality profile and may manage at most 100 total custom-format/profile/naming
resources. A pack permits at most 100 specifications, 100 dynamic fields per specification, 100
items in a bounded list, 2,048 bytes per string, and 1 MiB of expanded preset data. Recursive
quality trees are limited to depth 10 and 500 nodes. Scores are integers from -10,000 through
10,000, and `cutoffFormatScore` cannot be lower than `minFormatScore`.

The supported custom-format implementations are:

- `ReleaseTitleSpecification`
- `ReleaseGroupSpecification`
- `IndexerFlagSpecification`
- `SizeSpecification`

Regular expressions and naming templates are validated conservatively. Backreferences, lookbehind,
unsafe nested quantifiers, absolute/traversal paths, controls, bidirectional controls, malformed
tokens, and missing required track/artist tokens fail before connection or mutation.

## Capabilities and Live Validation

A pack declares the capabilities it needs. The complete built-in requirement is:

1. `custom-format-schema`
2. `custom-format-create`
3. `custom-format-update`
4. `quality-profile-schema`
5. `quality-profile-create`
6. `quality-profile-update`
7. `naming-read`
8. `naming-examples`
9. `naming-update`

Before producing an actionable review, `rfmedia` reads fresh custom-format and quality-profile
schemas and definitions, the complete naming singleton, advisory naming examples, and artists used
for assignment impact. It validates required custom-format implementations and fields, exact
quality/group/cutoff resolution, complete profile construction, and naming compatibility. A
missing endpoint, malformed response, ambiguous name, unsupported implementation/field, unresolved
quality, invalid naming example, or incompatible schema blocks the complete run before mutation.
Support is capability-based; no marketing version string bypasses these checks.

## Ownership and Diff Semantics

Names are matched by trimmed, Unicode-normalized, case-insensitive exact equality. Matching is
never fuzzy:

- No match produces `CREATE`.
- One same-name match is adopted and produces `UPDATE` or `UNCHANGED`.
- Multiple normalized matches are ambiguous and block the run.
- Undeclared live custom formats and quality profiles produce `RETAIN`.

The selected pack manages every declared custom-format definition and quality-profile field.
Quality-profile writes are rebuilt from the fresh schema, include every current custom format
exactly once, and preserve scores for formats the pack does not declare. The pack owns every
supported persisted naming field as one complete policy.

The diff has deterministic dependency order: managed custom formats, managed quality profiles,
naming, then retained resources. It reports:

- pack identity, version, digest, target origin, assumptions, consequences, observations, and
  warnings;
- `hasChanges` and create/update/unchanged/retained counts;
- stable resource keys, live IDs when present, dependencies, and ordered field-level before/after
  changes;
- custom-format profile references, quality-profile assigned-artist counts, and naming's
  future-import-only impact; and
- sanitized advisory naming examples.

A valid diff exits successfully whether `hasChanges` is `true` or `false`.

## Approval and Apply Ordering

Real apply first performs a complete live review. If already converged, it returns without a lock,
prompt, journal, or API write. Otherwise it acquires the origin lock, repeats the complete preflight
under that lock, and invokes one confirmation callback while retaining the lock.

Interactive confirmation defaults to no. `--yes` bypasses only this prompt; it does not bypass pack
validation, capability checks, the under-lock review, drift checks, journaling, or read-back.
Machine output and non-interactive input require `--yes` for a changing real apply. A decline
releases the lock and creates no journal.

Confirmed writes are sequential:

1. apply custom formats;
2. refresh custom formats and the quality-profile schema;
3. rebuild and apply complete quality-profile bodies; and
4. apply the complete naming singleton.

Immediately before each resource, apply asserts lock ownership and compares a fresh semantic read
with the reviewed state. It durably records pre-dispatch intent, sends exactly one POST or PUT in
the `destructive` lane with `idempotent: false` and zero retry attempts, performs a bounded fresh
read-back, and durably records the outcome. A stale, failed, uncertain, or non-durable outcome
stops every later admission and marks dependent work `not-attempted`.

`--dry-run` performs the same complete live review as diff but makes no API mutation, takes no
origin lock, and creates no journal.

## Lock and Journal Security

The lock is keyed by the SHA-256 digest of the exact canonical Lidarr origin. It serializes preset
applies from processes on one host; it is not a distributed lock and does not coordinate separate
administrative hosts. A live owner is never forcibly replaced. Recovery removes a stale lock only
when the recorded owner is on the same host and its process is demonstrably dead.

By default, locks and journals live under:

```text
~/.config/rfmedia/plans/lidarr-preset-applies/
├── locks/<origin-digest>.lock
└── journals/<apply-uuid>.json
```

`RFMEDIA_PLAN_DIR` changes the parent plan directory for testing or operations. Directories and
files use owner-only modes (`0700` and `0600`). Persistence uses bounded reads, no-follow opens,
identity checks, atomic publication/replacement, directory synchronization, exact schemas, and
forward-only journal transitions.

The journal is independent from `rfmedia.lidarr-plan.v2`. It contains the secret-free pack
identity/digest, canonical origin, ordered reviewed resource intent, dispatch boundary, terminal
outcomes, and completion state. It never stores API keys, authorization headers, raw server bodies,
or credential-bearing URLs.

## Outcomes and Recovery

Resource outcomes have precise meanings:

- `succeeded`: this invocation dispatched one write and fresh read-back verified the desired state.
- `satisfied`: fresh state is already desired, including convergence after an ambiguous dispatch.
- `failed`: apply established a definite pre-dispatch, write, verification, or persistence failure.
- `uncertain`: dispatch or read-back could not be established conclusively.
- `not-attempted`: a prior non-converged or non-durable resource stopped admission.

Top-level apply status is `completed`, `partial`, `failed`, `declined`, or dry-run `checked`.
`partial`, `failed`, or any uncertain outcome exits non-zero. A completed, declined, or checked
result exits zero. Diff does not use an exit code to distinguish changes from convergence.

There is no rollback and no SQLite/deferred replay. After partial or uncertain work:

1. inspect the resource outcomes and safe next action;
2. verify that credentials still come from a secure source;
3. rerun `diff` for a fresh complete view; and
4. rerun `apply` with the same qualified pack reference.

The rerun resolves current state from scratch. Verified resources become `UNCHANGED`/`satisfied`,
and only remaining drift is eligible for a new single write. Never manually resend a write based
only on a timeout or interrupted response.

## Output Contracts

Human review, progress, prompts, and diagnostics use stderr. Machine output writes one versioned
document to stdout:

| Command | Schema version                    |
| ------- | --------------------------------- |
| list    | `rfmedia.lidarr-presets-list.v1`  |
| show    | `rfmedia.lidarr-presets-show.v1`  |
| diff    | `rfmedia.lidarr-presets-diff.v1`  |
| apply   | `rfmedia.lidarr-presets-apply.v1` |

JSON is the lossless automation format. YAML represents the same result. CSV uses one fixed,
spreadsheet-safe column union and explicit `rowType` values:

- list/show: `pack`, `capability`, `assumption`, `consequence`, `custom-format-policy`,
  `quality-profile-policy`, and `naming`;
- diff: `summary`, `assumption`, `observation`, `consequence`, `warning`, `resource`, `field`, and
  `naming-example`; and
- apply: the diff row types plus `outcome` and apply summary fields.

Human output is bounded by default; `--verbose` increases the bound. Machine documents retain the
complete bounded result. Terminal controls are rejected, CSV formula-like cells are neutralized,
credentials are redacted, and raw server response bodies are never rendered.

## Explicit Non-Effects

Preset list/show/diff/apply do not:

- delete or prune custom formats or quality profiles;
- rename existing resources;
- reassign artists to a managed quality profile;
- add, remove, monitor, unmonitor, or delete artists or albums;
- trigger a search, refresh, import, download, or queue mutation;
- rename, move, copy, hardlink, unlink, trash, or delete existing media files;
- execute a Lidarr rename command;
- fetch remote preset catalogs, URLs, or external preset files;
- inherit from another pack;
- refresh the committed Lidarr OpenAPI snapshot; or
- roll back or replay a failed or uncertain write.
