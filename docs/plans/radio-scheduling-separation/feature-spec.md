# Feature Spec: Radio-Scheduling Separation

## Executive Summary

GitHub issue #113 adds an optional sequencing stage to local, filter-backed M3U playlist creation:
`filter → select → sequence → output`. A named smart filter may declare artist and genre spacing
constraints plus tempo, era, and BPM-derived energy preferences. The sequencer is deterministic,
keeps every selected track exactly once, uses bounded local backtracking before relaxing an
impossible spacing constraint, and reports every relaxation without failing playlist generation.

This is one cohesive implementation slice. No child issues are required: issue #114 owns
non-destructive stickers and issue #134 owns radio-style categorization, while #113 can operate on
the artist, genre, year, and BPM metadata already read for local filters.

## Product Contract

### User Story

As a self-hosted music operator, I want a filtered playlist to avoid obvious artist and genre
clumps and to vary tempo, era, and energy, so that a large personal library plays more like a
curated radio station without requiring a server, cloud API, or external dependency.

### Configuration

Separation is an optional property of a named local smart filter:

```yaml
filters:
  radio-rock:
    match: all
    rules:
      - type: rule
        field: genre
        operator: contains
        value: Rock
    separation:
      artist: 5
      genre: 3
      tempo: alternate
      era: distribute
      energy: wave
```

Supported fields:

| Field    | Values                              | Meaning                                                                           |
| -------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| `artist` | Integer `1..100`                    | Require this many intervening tracks before a normalized artist repeats           |
| `genre`  | Integer `1..100`                    | Require this many intervening tracks before any normalized genre repeats          |
| `tempo`  | `alternate`                         | Prefer a different BPM tercile from the previous track with BPM metadata          |
| `era`    | `distribute`                        | Prefer the least-used release decade among remaining candidates                   |
| `energy` | `alternate`, `rise`, `fall`, `wave` | Prefer a repeating low/medium/high arc derived from library-relative BPM terciles |

Energy is intentionally documented as a BPM-derived sequencing proxy, not audio analysis or a
durable track classification. Sticker- or category-derived energy is deferred to
[issue #114](https://github.com/yandy-r/rfmedia-apps/issues/114) and
[issue #134](https://github.com/yandy-r/rfmedia-apps/issues/134).

### Observable Behavior

1. Filters without `separation` retain their current path-sorted output.
2. Filter rules still determine membership; separation changes order only.
3. Artist and genre are hard preferences. The sequencer first tries a greedy choice, then
   progressively wider bounded local backtracking. If bounded search cannot find a valid
   rearrangement, it chooses the least-violating deterministic candidate and emits a warning.
4. Tempo, era, and energy are scoring preferences and never exclude a track.
5. Missing artist, genre, year, or BPM metadata neither creates a synthetic category nor blocks a
   track.
6. Every matched track appears exactly once, including in dry-run results, M3U output, and
   generation history.
7. Given the same matched tracks and configuration, output order and relaxation diagnostics are
   stable.

## Technical Design

### Pipeline

```text
audio discovery
    ↓
parallel metadata read + filter evaluation
    ↓
stable path sort (deterministic input)
    ↓
optional separation sequence
    ↓
dry-run preview or M3U write
    ↓
existing database/history persistence
```

Only filter-backed playlists use the new stage. Plex playlist ordering remains server-owned.

### Data Model

`SmartFilter` gains an optional `separation` property. The new sequencing module accepts an internal
track projection containing the public `M3UTrackInfo` fields plus artist contributors, genres,
year, and BPM. Rich metadata stays private to playlist generation; public M3U and persistence types
do not grow metadata fields they do not use.

The pure sequencing API returns:

- the ordered generic track array;
- structured relaxation records containing the output position, file path, and violated
  constraints.

Playlist creation logs a summary warning and debug-level relaxation details. Its existing result
shape remains compatible.

### Deterministic Sequencing Algorithm

1. Sort candidates by file path before sequencing.
2. Normalize artists and genres with trim + case folding; missing values yield no keys.
3. Derive low, medium, and high BPM bands from deterministic tercile cut points over finite,
   positive BPM values.
4. At each output position, reject candidates that repeat an artist or genre inside the configured
   gap.
5. Score eligible candidates for tempo alternation, era balance, and the requested energy target.
   Break all ties by file path.
6. If no candidate is eligible, search deterministic permutations across progressively wider
   trailing windows of 4, 8, and 12 tracks plus remaining candidates. Each window has a fixed
   branch width and node budget.
7. If bounded backtracking cannot advance, select the candidate with the smallest total spacing
   shortfall, break ties by soft score then path, record the violated constraints, and continue.

The algorithm is in-memory, dependency-free, and bounded for personal-library scale. It never
performs network or database work.

### Validation and Errors

Configuration loading rejects:

- a non-object `separation` value;
- unknown separation keys;
- non-integer or out-of-range artist/genre gaps;
- unsupported tempo, era, or energy modes.

Errors use the existing `ConfigError` property-path convention. Runtime inability to satisfy a
valid rule is not a configuration error and does not abort playlist creation.

## Scope

### In Scope

- Typed per-filter separation configuration and strict validation.
- Pure deterministic sequencing with bounded backtracking and relaxation diagnostics.
- Integration into local filter-backed playlist creation.
- Focused unit tests for ordering, relaxation, missing metadata, determinism, and validation.
- One playlist action integration test proving the post-filter stage.
- User documentation, example YAML, and `ROADMAP.md`.
- Shell-completion parity audit.

### Out of Scope

- New commands, flags, interactive prompts, or shell completion candidates.
- Changes to the interactive or human-readable filter-management surface; machine output already
  returns the full typed filter.
- Random seeds or nondeterministic shuffle modes.
- Plex playlist reordering.
- Persistent track stickers, learned energy analysis, acoustic feature extraction, or radio
  categories (#114 and #134).
- Database migrations or storing separation configuration in smart-playlist rows.
- Optimal global scheduling guarantees for adversarial catalogs.

## Acceptance Criteria

- [ ] A named filter can configure each documented separation field independently or together.
- [ ] Artist and genre gaps are honored whenever the bounded deterministic search constructs a
      valid schedule.
- [ ] Bounded backtracking is attempted before a hard constraint is relaxed.
- [ ] Impossible catalogs complete with deterministic warnings and no lost or duplicated tracks.
- [ ] Tempo, era, and energy preferences use only existing local metadata.
- [ ] Missing metadata is preserved and never fabricated.
- [ ] Filters without separation produce their historical path-sorted order.
- [ ] Dry-run, written M3U, and persisted history observe the same sequence.
- [ ] Focused tests, package typecheck/coverage, build, formatting, markdown, and graph validation
      pass.
- [ ] Bash, Zsh, and Fish completion templates require no changes because the command surface is
      unchanged; the completion parity suite still passes.
- [ ] `ROADMAP.md` records issue #113 as shipped through the implementing PR.

## Risks and Mitigations

| Risk                                         | Mitigation                                                        |
| -------------------------------------------- | ----------------------------------------------------------------- |
| Unsatisfiable gaps stall generation          | Bounded backtracking followed by explicit best-effort relaxation  |
| Soft preferences produce unstable results    | Stable input ordering, deterministic scoring, and path tie-breaks |
| Energy wording implies acoustic analysis     | Document BPM-derived proxy and defer durable enrichment           |
| Large gap values cause excessive work        | Validate an upper bound and cap the local backtracking window     |
| Metadata omissions accidentally group tracks | Treat missing values as absent keys, never sentinel categories    |
| Feature leaks into Plex ordering             | Integrate only in the filter-backed playlist path                 |
