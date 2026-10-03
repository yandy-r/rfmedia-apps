# Roadmap

Living plan for open work in [rfmedia-apps](https://github.com/yandy-r/rfmedia-apps). Issue numbers
link to GitHub for full acceptance criteria.

Shipped history lives in [`docs/roadmap-archive.md`](docs/roadmap-archive.md).

**Last updated:** 2026-08-08

**Open issues:** 81 (rfapps 39 · rfmedia 42) — includes the three #63 follow-ups (#328, #329, #330)
and the two #307 follow-ups (#334, #335).

## How to read this

| Label                     | Meaning                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `priority:high`           | Foundation, correctness, or high-leverage operational capability |
| `priority:medium`         | Valuable feature work with clear user impact                     |
| `priority:low` / `future` | Backlog, polish, or exploratory ideas                            |

Priorities come from issue labels. Sequencing in **Next Up** adds dependency and risk ordering on
top of those labels.

---

## Current focus

No `priority:high` issue remains. Lifecycle, Lidarr Layers 1–3, secure-store completion, Plex JWT
enrollment, metadata drift reconciliation, and hierarchical service tagging (#63) have shipped — see
[archive](docs/roadmap-archive.md).

Near-term work is three parallel medium tracks: **artifact / selector correctness** (bugs filed from
issues #63 and #307), **rfapps operator UX**, and **rfmedia enrichment & mobility**. Lidarr Phase E is
optional and unblocked. Plex JWT deferrals (#286, #287, enrollment Option 2) stay in
[`docs/internal/plex-jwt-deferrals.md`](docs/internal/plex-jwt-deferrals.md).

---

## Next Up

Recommended order for the next few cycles. Finish each sprint row (or an explicit subset) before
starting dependent rows below it. Tracks may run in parallel when they do not share owners or
blockers.

Sprint 2 (secure-store) and #63 (hierarchical tagging) are closed; narratives live in the
[archive](docs/roadmap-archive.md). [#323](https://github.com/yandy-r/rfmedia-apps/issues/323),
[#328](https://github.com/yandy-r/rfmedia-apps/issues/328), and
[#329](https://github.com/yandy-r/rfmedia-apps/issues/329) remain low-priority follow-ups and are
not required for the work below.

### Sprint 3 — Artifact & selector correctness

Small, high-confidence fixes from the last two closed tracks. Prefer finishing this before large UX
or domain slices that touch the same paths.

| Order | Issue                                                                                         | Why now                                      |
| ----- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1     | [#330](https://github.com/yandy-r/rfmedia-apps/issues/330) `--profile` silent no-op           | Medium bug from #63; selector honesty        |
| 2     | [#334](https://github.com/yandy-r/rfmedia-apps/issues/334) `verify --fix` publishes `0600`    | Medium bug from #307; destination mode truth |
| 3     | [#335](https://github.com/yandy-r/rfmedia-apps/issues/335) `backup-docker` umask-narrowed pub | Low sibling of #334; same defect family      |

**Exit criteria:** #330 and #334 closed with regression tests. #335 may slip if ownership differs.

### Parallel — rfapps operator UX (medium)

Independent of Sprint 3 when ownership differs; order flexible:

| Order | Issue                                                                                  | Why now                  |
| ----- | -------------------------------------------------------------------------------------- | ------------------------ |
| 1     | [#66](https://github.com/yandy-r/rfmedia-apps/issues/66) Silence by default            | Operator noise reduction |
| 2     | [#74](https://github.com/yandy-r/rfmedia-apps/issues/74) Contextual help with examples | Discoverability          |
| 3     | [#153](https://github.com/yandy-r/rfmedia-apps/issues/153) `rfapps describe`           | Compose-as-docs          |
| 4     | [#154](https://github.com/yandy-r/rfmedia-apps/issues/154) `rfapps eject`              | Portability escape hatch |

**Exit criteria:** At least one help/describe/eject slice ships with docs and tests.

### Parallel — rfmedia enrichment & mobility (medium)

Independent of Sprint 3 and rfapps UX when ownership differs. Suggested cluster order:

| Order | Issue                                                                                                                                                                | Why now                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1     | [#114](https://github.com/yandy-r/rfmedia-apps/issues/114) Sticker database                                                                                          | Non-destructive enrichment   |
| 2     | [#124](https://github.com/yandy-r/rfmedia-apps/issues/124) Beets integration                                                                                         | Enrichment / rename pipeline |
| 3     | [#126](https://github.com/yandy-r/rfmedia-apps/issues/126) / [#127](https://github.com/yandy-r/rfmedia-apps/issues/127) Metadata portability & migration             | Library mobility             |
| 4     | [#131](https://github.com/yandy-r/rfmedia-apps/issues/131)–[#134](https://github.com/yandy-r/rfmedia-apps/issues/134) Classical / onboarding / auto-organize / radio | Domain expansion             |

**Exit criteria:** One enrichment or mobility cluster reaches a usable operator surface.

### Later — Lidarr Phase E (optional)

Unblocked; run when ownership differs from the tracks above:

| Order | Issue                                                                                    | Why later / optional                                   |
| ----- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| —     | [#210](https://github.com/yandy-r/rfmedia-apps/issues/210) Temporal library intelligence | Builds on shipped #314 recency signals                 |
| —     | [#204](https://github.com/yandy-r/rfmedia-apps/issues/204) Federated discovery providers | Optional Layer 2 extension                             |
| —     | [#201](https://github.com/yandy-r/rfmedia-apps/issues/201) Bulk import/export            | Convenience after core mutation path is one-hop (#311) |

---

## rfapps-cli backlog

### High priority

_None open._ Lifecycle high-priority work (#147, #148, diagnostics) and hierarchical tagging (#63)
shipped — see [archive](docs/roadmap-archive.md).

### Medium priority — operator UX & selector honesty (5)

| Issue                                                      | Summary                                         |
| ---------------------------------------------------------- | ----------------------------------------------- |
| [#66](https://github.com/yandy-r/rfmedia-apps/issues/66)   | Silence by default                              |
| [#74](https://github.com/yandy-r/rfmedia-apps/issues/74)   | Contextual help with examples                   |
| [#153](https://github.com/yandy-r/rfmedia-apps/issues/153) | `rfapps describe` (compose-as-docs)             |
| [#154](https://github.com/yandy-r/rfmedia-apps/issues/154) | `rfapps eject` portability escape hatch         |
| [#330](https://github.com/yandy-r/rfmedia-apps/issues/330) | `--profile` silently no-ops (profile-less file) |

Issue #63 made [#62](https://github.com/yandy-r/rfmedia-apps/issues/62) smaller: smart groups now extend
`SelectorFlags` instead of inventing a parallel targeting mechanism. Tag writer v2 (#328) and the
completion split (#329) stay low-priority; see [archive](docs/roadmap-archive.md).

### Low priority — UX, extensibility & scale (34)

<details>
<summary>Click to expand (#62, #72, #75, #155–#158, #163, #165–#184, #246–#247, #268, #328–#329, #335)</summary>

| Issue                                                      | Summary                                             |
| ---------------------------------------------------------- | --------------------------------------------------- |
| [#62](https://github.com/yandy-r/rfmedia-apps/issues/62)   | Smart service groups — extends `SelectorFlags`      |
| [#72](https://github.com/yandy-r/rfmedia-apps/issues/72)   | Container runtime abstraction (Podman/nerdctl)      |
| [#75](https://github.com/yandy-r/rfmedia-apps/issues/75)   | Interactive tutorial mode                           |
| [#155](https://github.com/yandy-r/rfmedia-apps/issues/155) | Command alias management                            |
| [#156](https://github.com/yandy-r/rfmedia-apps/issues/156) | Next-command suggestions                            |
| [#157](https://github.com/yandy-r/rfmedia-apps/issues/157) | `rfapps self-update`                                |
| [#158](https://github.com/yandy-r/rfmedia-apps/issues/158) | Extension/plugin architecture                       |
| [#163](https://github.com/yandy-r/rfmedia-apps/issues/163) | Resource monitoring & alerting                      |
| [#165](https://github.com/yandy-r/rfmedia-apps/issues/165) | Dependency graph visualization                      |
| [#166](https://github.com/yandy-r/rfmedia-apps/issues/166) | Cost & resource estimation                          |
| [#167](https://github.com/yandy-r/rfmedia-apps/issues/167) | Migration assistant for stack portability           |
| [#168](https://github.com/yandy-r/rfmedia-apps/issues/168) | Operational runbook generation                      |
| [#169](https://github.com/yandy-r/rfmedia-apps/issues/169) | Scheduled maintenance windows                       |
| [#170](https://github.com/yandy-r/rfmedia-apps/issues/170) | Multi-host & remote management                      |
| [#171](https://github.com/yandy-r/rfmedia-apps/issues/171) | Docker context switching                            |
| [#172](https://github.com/yandy-r/rfmedia-apps/issues/172) | Git-aware deployment / GitOps                       |
| [#173](https://github.com/yandy-r/rfmedia-apps/issues/173) | Expand MCP tool coverage                            |
| [#174](https://github.com/yandy-r/rfmedia-apps/issues/174) | Tailscale integration enhancements                  |
| [#175](https://github.com/yandy-r/rfmedia-apps/issues/175) | Catalog templates for service blueprints            |
| [#176](https://github.com/yandy-r/rfmedia-apps/issues/176) | `rfapps watch --restart-failed`                     |
| [#177](https://github.com/yandy-r/rfmedia-apps/issues/177) | Volume relationship inspection                      |
| [#178](https://github.com/yandy-r/rfmedia-apps/issues/178) | Secrets generation utility                          |
| [#179](https://github.com/yandy-r/rfmedia-apps/issues/179) | Shared infrastructure addons framework              |
| [#180](https://github.com/yandy-r/rfmedia-apps/issues/180) | Deployment transaction history enhancements         |
| [#181](https://github.com/yandy-r/rfmedia-apps/issues/181) | Resource policy audit                               |
| [#182](https://github.com/yandy-r/rfmedia-apps/issues/182) | Live resource view (`rfapps top`)                   |
| [#183](https://github.com/yandy-r/rfmedia-apps/issues/183) | Post-deploy hooks & health gates                    |
| [#184](https://github.com/yandy-r/rfmedia-apps/issues/184) | Ink-based operational TUI _(future)_                |
| [#246](https://github.com/yandy-r/rfmedia-apps/issues/246) | Plumb `config.docker.sshRetry` into exec paths      |
| [#247](https://github.com/yandy-r/rfmedia-apps/issues/247) | `tsconfig.build.json` excluding tests from dist     |
| [#268](https://github.com/yandy-r/rfmedia-apps/issues/268) | `history --action update` rejected (valid action)   |
| [#328](https://github.com/yandy-r/rfmedia-apps/issues/328) | `rfapps tag set/remove` config writer (v2)          |
| [#329](https://github.com/yandy-r/rfmedia-apps/issues/329) | Split shell completion generators into per-shell    |
| [#335](https://github.com/yandy-r/rfmedia-apps/issues/335) | `backup-docker` publishes a umask-narrowed artifact |

</details>

---

## rfmedia-cli backlog

### High priority — quality & core behavior (0)

_None open._ Radio-scheduling separation (#113) shipped via
[#264](https://github.com/yandy-r/rfmedia-apps/pull/264).

### Medium priority — copy, verify, policy & metadata (9)

| Issue                                                      | Summary                                       |
| ---------------------------------------------------------- | --------------------------------------------- |
| [#114](https://github.com/yandy-r/rfmedia-apps/issues/114) | Sticker database (non-destructive enrichment) |
| [#124](https://github.com/yandy-r/rfmedia-apps/issues/124) | Beets integration                             |
| [#126](https://github.com/yandy-r/rfmedia-apps/issues/126) | Cross-platform metadata portability           |
| [#127](https://github.com/yandy-r/rfmedia-apps/issues/127) | Migration assistant (beets/Plex → rfmedia)    |
| [#131](https://github.com/yandy-r/rfmedia-apps/issues/131) | Classical music metadata model                |
| [#132](https://github.com/yandy-r/rfmedia-apps/issues/132) | Progressive onboarding (`rfmedia init`)       |
| [#133](https://github.com/yandy-r/rfmedia-apps/issues/133) | Event-driven auto-organize pipeline           |
| [#134](https://github.com/yandy-r/rfmedia-apps/issues/134) | Radio-style track categorization              |
| [#334](https://github.com/yandy-r/rfmedia-apps/issues/334) | `verify --fix` publishes `0600`, not derived  |

### Lidarr integration (open)

Foundation (#193), baseline commands (#197), generated client (#194), metadata resilience (#195),
execution lanes (#196), mutation plan/apply (#202), search/lookup (#222), album suite (#223),
file-aware artist delete (#200), quality preset management (#213), library health audit (#211),
pre-import validation / post-acquisition filtering (#216), cascade/indexer budget analysis (#219),
Plex–Lidarr identity/reconciliation (#207–#208, #284–#285), the consumption-driven policy engine
(#209), and Plex ratings sync to Lidarr decisions (#221) shipped — see
[archive](docs/roadmap-archive.md).

```text
Layer 1 — Local bulk management     (shipped)
Layer 2 — Discovery pipeline        (#203, #205, #206, #219 shipped; optional #204)
Layer 3 — Plex–Lidarr intelligence  (#207–#209, #221, #284–#285, #311–#314 shipped)
```

#### Phase D follow-ups (shipped)

Split out of #209. Policy plan (#311 / PR #315), config-validation extraction (#312 / PR #316),
decision overrides (#313 / PR #317), and Plex recency signals (#314 / PR #318) are complete. The
recency slice carries account-scoped `lastViewedAt`; `skipCount` remains deferred until Plex exposes
a trustworthy contract for it.

#### Phase E — Later / optional

| Issue                                                      | Summary                                    |
| ---------------------------------------------------------- | ------------------------------------------ |
| [#201](https://github.com/yandy-r/rfmedia-apps/issues/201) | Bulk import/export (CSV/JSON/YAML)         |
| [#204](https://github.com/yandy-r/rfmedia-apps/issues/204) | Federated discovery providers              |
| [#210](https://github.com/yandy-r/rfmedia-apps/issues/210) | Temporal library intelligence (`timeline`) |
| [#212](https://github.com/yandy-r/rfmedia-apps/issues/212) | Event-driven automation via webhooks       |
| [#214](https://github.com/yandy-r/rfmedia-apps/issues/214) | Music request CLI _(future)_               |
| [#215](https://github.com/yandy-r/rfmedia-apps/issues/215) | MusicBrainz collection import              |
| [#217](https://github.com/yandy-r/rfmedia-apps/issues/217) | Lidarr-to-Beets post-processing bridge     |
| [#218](https://github.com/yandy-r/rfmedia-apps/issues/218) | MusicCollectionManager backend abstraction |
| [#220](https://github.com/yandy-r/rfmedia-apps/issues/220) | Configurable metadata provider endpoints   |

### Low priority — docs, polish & future ideas (24)

<details>
<summary>Click to expand (#38, #50, #54–#55, #118–#143, #286–#287, #323)</summary>

| Issue                                                      | Summary                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| [#38](https://github.com/yandy-r/rfmedia-apps/issues/38)   | Deduplication detection                                      |
| [#50](https://github.com/yandy-r/rfmedia-apps/issues/50)   | Structured logging (log levels)                              |
| [#54](https://github.com/yandy-r/rfmedia-apps/issues/54)   | API documentation for library use                            |
| [#55](https://github.com/yandy-r/rfmedia-apps/issues/55)   | Video tutorials                                              |
| [#118](https://github.com/yandy-r/rfmedia-apps/issues/118) | OpenSubsonic/Navidrome adapter _(future)_                    |
| [#120](https://github.com/yandy-r/rfmedia-apps/issues/120) | Library health analytics _(future)_                          |
| [#121](https://github.com/yandy-r/rfmedia-apps/issues/121) | Quality profiles _(future)_                                  |
| [#122](https://github.com/yandy-r/rfmedia-apps/issues/122) | ListenBrainz integration _(future)_                          |
| [#123](https://github.com/yandy-r/rfmedia-apps/issues/123) | Expression language _(future)_                               |
| [#128](https://github.com/yandy-r/rfmedia-apps/issues/128) | Discogs reconciliation _(future)_                            |
| [#129](https://github.com/yandy-r/rfmedia-apps/issues/129) | Bandcamp purchase pipeline _(future)_                        |
| [#130](https://github.com/yandy-r/rfmedia-apps/issues/130) | Concert attendance connection _(future)_                     |
| [#135](https://github.com/yandy-r/rfmedia-apps/issues/135) | Playlist composition _(future)_                              |
| [#136](https://github.com/yandy-r/rfmedia-apps/issues/136) | AccurateRip-style verification _(future)_                    |
| [#137](https://github.com/yandy-r/rfmedia-apps/issues/137) | BPM detection plugin _(future)_                              |
| [#138](https://github.com/yandy-r/rfmedia-apps/issues/138) | Spatial audio metadata _(future)_                            |
| [#139](https://github.com/yandy-r/rfmedia-apps/issues/139) | Opus HD / 24-bit profiles _(future)_                         |
| [#140](https://github.com/yandy-r/rfmedia-apps/issues/140) | Ink operational TUI _(future)_                               |
| [#141](https://github.com/yandy-r/rfmedia-apps/issues/141) | WASM distribution _(future)_                                 |
| [#142](https://github.com/yandy-r/rfmedia-apps/issues/142) | AI provenance metadata _(future)_                            |
| [#143](https://github.com/yandy-r/rfmedia-apps/issues/143) | Stem separation command _(future)_                           |
| [#286](https://github.com/yandy-r/rfmedia-apps/issues/286) | Plex device revocation endpoint _(blocked upstream; future)_ |
| [#287](https://github.com/yandy-r/rfmedia-apps/issues/287) | Per-server Plex `accessToken` exchange _(future)_            |
| [#323](https://github.com/yandy-r/rfmedia-apps/issues/323) | Discriminate the release-path `UNSAFE_PATH` swallow          |

</details>

---

## Cross-cutting themes

| Theme               | rfapps                                                                                                                            | rfmedia                                                                              | Notes                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| Plan/apply safety   | shipped (#148)                                                                                                                    | shipped copy (#115), Lidarr (#202), and policy→plan (#311)                           | One fewer manual hop for policy mutations     |
| Drift & reconcile   | shipped (#146, #151)                                                                                                              | shipped (#125)                                                                       | Report-first reconciliation complete          |
| Adapter boundaries  | —                                                                                                                                 | shipped (#119, #251); [#218](https://github.com/yandy-r/rfmedia-apps/issues/218)     | Manager abstraction remains                   |
| Test infrastructure | shipped (#70, #73)                                                                                                                | shipped (#56)                                                                        | rfmedia action coverage complete              |
| MCP / automation    | [#173](https://github.com/yandy-r/rfmedia-apps/issues/173)                                                                        | —                                                                                    | Expand after core command surface stabilizes  |
| Secure artifact I/O | [#335](https://github.com/yandy-r/rfmedia-apps/issues/335)                                                                        | Sprint 2 shipped; [#334](https://github.com/yandy-r/rfmedia-apps/issues/334) remains | Sprint 3 owns the mode follow-ups             |
| Service selection   | #63 shipped; [#330](https://github.com/yandy-r/rfmedia-apps/issues/330), [#62](https://github.com/yandy-r/rfmedia-apps/issues/62) | —                                                                                    | Tag axis done; profile honesty + smart groups |

---

## Maintenance

- Regenerate issue counts: `gh issue list --state open --limit 200 --json number,labels`
- When closing work, update **Next Up** and the relevant backlog table; move narrative to
  [`docs/roadmap-archive.md`](docs/roadmap-archive.md) only when a full sprint closes
- Re-prioritize after major releases or new research epics
