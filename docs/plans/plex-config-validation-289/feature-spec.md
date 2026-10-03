# Feature Spec: Plex Config Validation (#289)

## Executive Summary

Issue #289 repairs a silent configuration-boundary defect: `PlexConfigOptions` declares
`pageSize`, `syncRatingsOnCopy`, and `syncOnCopyDefaults`, but `validatePlexConfigOptions` drops
all three. The fix validates and retains those values, preserves existing CLI precedence and
consumption-site defaults, and adds a compile-time fence so future top-level Plex config drift
fails typecheck. It uses only existing TypeScript validators and Vitest coverage. The required
repository-wide audit found one separate defect, now tracked as child issue #302.

## External Dependencies

### APIs and Services

No new external API or service integration is required. Plex pagination continues using the
existing adapter and `X-Plex-Container-Start` / `X-Plex-Container-Size` request headers.

### Libraries and SDKs

No dependency changes are required. The implementation reuses:

| Existing capability                        | Purpose                                       |
| ------------------------------------------ | --------------------------------------------- |
| TypeScript `keyof`, `Exclude`, and `never` | Compile-time validator coverage fence         |
| Existing config validators                 | Runtime scalar and bounded-integer validation |
| Vitest                                     | Focused config-boundary regression coverage   |

### External Documentation

- [TypeScript `keyof`](https://www.typescriptlang.org/docs/handbook/2/keyof-types.html): produces
  the source-interface key union.
- [TypeScript `Exclude`](https://www.typescriptlang.org/docs/handbook/utility-types.html#excludeuniontype-excludedmembers):
  computes unclassified keys.
- [Plex pagination](https://developer.plex.tv/pms/#section/API-Info/Pagination): documents Plex
  container paging semantics; the repository supplies its own safety ceiling.

## Business Requirements

### User Stories

**Primary User: rfmedia operator**

- As an operator, I want valid Plex paging and rating-sync config to affect ordinary commands so
  that `.rfmedia.yaml` matches documented behavior.
- As an operator, I want invalid values rejected at the config boundary with an exact property
  path so that failures do not surface later during Plex requests or file writes.

**Secondary User: maintainer**

- As a maintainer, I want a new `PlexConfigOptions` key to fail typecheck until the validator
  classifies it.
- As an auditor, I want unrelated config drift tracked separately so this PR stays Plex-specific.

### Business Rules

1. **Plex page-size validation**: `plex.pageSize` accepts integers from 1 through
   `MEDIA_IDENTITY_MAX_PAGE_SIZE` (1,000), inclusive.
   - Validation: reject other types, fractions, values below 1, and values above 1,000.
   - Exception: omission preserves downstream defaults.
2. **Rating-sync opt-in**: `plex.syncRatingsOnCopy` accepts only booleans.
   - Validation: explicit `false` must survive; no truthy/falsy coercion.
3. **Nested sync defaults**: `plex.syncOnCopyDefaults` accepts a non-null, non-array object.
   - `popmEmail`, when present, is a non-empty string.
   - `vorbisScale`, when present, is `normalized`, `stars`, or `percent`.
   - An empty object is valid; defaults remain consumption-site concerns.
4. **Precedence**: explicit CLI values continue to override config defaults.
5. **Compatibility**: unknown-key handling remains unchanged; #289 does not add strict runtime
   schemas, byte limits, NUL checks, or email-format validation.
6. **Audit disposition**: `CopyConfigOptions.conflictStrategy` is not fixed here; child issue #302
   owns it.

### Edge Cases

| Scenario                                 | Expected Behavior    | Notes                           |
| ---------------------------------------- | -------------------- | ------------------------------- |
| `pageSize: 1` or `1000`                  | Accepted             | Inclusive boundaries            |
| `pageSize: 0`, `1001`, `1.5`, or `"250"` | `ConfigError`        | Path `plex.pageSize`            |
| `syncRatingsOnCopy: false`               | Retained as `false`  | False is not omission           |
| `syncOnCopyDefaults: {}`                 | Accepted as `{}`     | No defaults written into config |
| Nested wrong type/value                  | `ConfigError`        | Exact nested path               |
| Existing valid config after upgrade      | Values become active | Behavior-changing fix           |

### Success Criteria

- [ ] All three fields survive `validateConfig` unchanged.
- [ ] Each field rejects representative malformed input with exact `ConfigError.propertyPath`.
- [ ] A new unclassified top-level `PlexConfigOptions` key breaks typecheck.
- [ ] The config-option audit is recorded and child issue #302 owns the unrelated finding.
- [ ] Focused, full-package, lint, formatting, and whitespace gates pass.
- [ ] The upgrade activation risk, validated range, and completed ROADMAP item are documented.

## Technical Specifications

### Architecture Overview

```text
.rfmedia.yaml / JSON
        |
        v
validateConfig()
        |
        v
validatePlexConfigOptions()
  |-- validate pageSize: 1..1000
  |-- validate syncRatingsOnCopy: boolean
  |-- validatePlexSyncOnCopyDefaults()
  `-- compile-time handled-key fence
        |
        v
loaded ConfigFile.plex
  |-- pageSize -> query / identity / playlist / collection
  `-- sync defaults -> plex copy / playlist export
```

### Data Models

No database or persistence migration is required.

#### `PlexConfigOptions`

| Field                | Type                     | Constraints          | Description                        |
| -------------------- | ------------------------ | -------------------- | ---------------------------------- |
| `pageSize`           | `number`                 | Safe integer 1–1,000 | Default Plex API request page size |
| `syncRatingsOnCopy`  | `boolean`                | No coercion          | Enables copy-time rating writes    |
| `syncOnCopyDefaults` | `PlexSyncOnCopyDefaults` | Object shape         | Optional metadata-write defaults   |

#### `PlexSyncOnCopyDefaults`

| Field         | Type         | Constraints                      | Description         |
| ------------- | ------------ | -------------------------------- | ------------------- |
| `popmEmail`   | `string`     | Non-empty when present           | POPM identifier     |
| `vorbisScale` | string union | `normalized`, `stars`, `percent` | Vorbis rating scale |

### API Design

No public command, option, endpoint, or adapter interface changes.

#### Runtime config contract

**Input:**

```yaml
plex:
  pageSize: 250
  syncRatingsOnCopy: true
  syncOnCopyDefaults:
    popmEmail: "user@example.com"
    vorbisScale: "stars"
```

**Validated result:**

```json
{
  "plex": {
    "pageSize": 250,
    "syncRatingsOnCopy": true,
    "syncOnCopyDefaults": {
      "popmEmail": "user@example.com",
      "vorbisScale": "stars"
    }
  }
}
```

**Errors:**

| Condition                | Error type    | Property path                         |
| ------------------------ | ------------- | ------------------------------------- |
| Invalid page size        | `ConfigError` | `plex.pageSize`                       |
| Non-boolean sync option  | `ConfigError` | `plex.syncRatingsOnCopy`              |
| Invalid nested container | `ConfigError` | `plex.syncOnCopyDefaults`             |
| Invalid POPM identifier  | `ConfigError` | `plex.syncOnCopyDefaults.popmEmail`   |
| Invalid Vorbis scale     | `ConfigError` | `plex.syncOnCopyDefaults.vorbisScale` |

### System Integration

#### Files to Create

- No production files.

#### Files to Modify

- `packages/rfmedia-cli/src/lib/config.ts`: validators, assignments, and coverage fence.
- `packages/rfmedia-cli/src/lib/config.test.ts`: focused accepted/rejected boundary coverage.
- `packages/rfmedia-cli/docs/features/plex-configuration.md`: validated range and activation note.
- `packages/rfmedia-cli/CHANGELOG.md`: Unreleased behavior-changing fix note.
- `ROADMAP.md`: remove completed #289 and refresh live counts.
- `docs/roadmap-archive.md`: archive the completed issue with the closing PR.
- `docs/internal/plex-jwt-deferrals.md`: mark the recorded #289 deferral resolved.

#### Configuration

No new keys are introduced. Existing declared keys become effective after validation.

## UX Considerations

### User Workflows

#### Primary Workflow: Load valid configuration

1. **Configure**
   - User: supplies one or more existing Plex keys.
   - System: validates and retains each supplied value.
2. **Execute**
   - User: runs an ordinary Plex command.
   - System: applies config defaults only when no explicit CLI value overrides them.
3. **Success State**
   - Paging and rating-sync behavior reflects the validated config.

#### Error Recovery Workflow

1. **Error Occurs**: a present value violates its type, range, or nested contract.
2. **User Sees**: a `ConfigError` warning naming the file and dotted property path under the
   existing loader policy.
3. **Recovery**: correct or remove the key, then rerun the same command.

### UI Patterns

| Component        | Pattern                    | Notes                                   |
| ---------------- | -------------------------- | --------------------------------------- |
| YAML/JSON config | Exact dotted paths         | Match existing config error style       |
| CLI overrides    | Explicit precedence        | No new flags or prompts                 |
| Release note     | Upgrade activation warning | Especially rating writes with hardlinks |

### Accessibility Requirements

No visual UI changes. Error messages remain plain text and machine-readable through
`ConfigError.propertyPath`.

### Performance UX

`pageSize` changes the balance between Plex request count and response size. The shared ceiling
prevents unbounded amplification without rejecting the existing valid value of 250.

## Recommendations

### Implementation Approach

**Recommended Strategy**: repair the existing explicit validator, add a local compile-time fence,
and prove the real config boundary with one combined success case plus compact parameterized
rejections.

**Phasing:**

1. **Boundary repair**: nested validator, three assignments, drift fence.
2. **Contract proof**: critical focused tests and package validation.
3. **User communication**: docs, changelog, live ROADMAP/archive updates.

### Technology Decisions

| Decision          | Recommendation                        | Rationale                                         |
| ----------------- | ------------------------------------- | ------------------------------------------------- |
| Page bound        | Shared `MEDIA_IDENTITY_MAX_PAGE_SIZE` | Tightest downstream shared contract               |
| Nested validation | Dedicated small function              | Avoids accepting unrelated sync-default keys      |
| Exhaustiveness    | `keyof` + `Exclude` + `never`         | Existing repository pattern                       |
| Tests             | Config-boundary Vitest cases          | Direct adapter mocks cannot prove config survival |
| Dependencies      | None                                  | Existing utilities fully cover the contract       |

### Quick Wins

- A combined success fixture proves all three dropped fields in one boundary test.
- Reusing the shared maximum prevents validator/adapter drift.
- Child issue #302 preserves the broader audit result without widening this implementation.

### Future Enhancements

- Resolve child issue #302 for `copy.conflictStrategy`.
- Consider broader validator fences and fail-closed loader behavior only as separately designed
  compatibility work.

## Risk Assessment

### Technical Risks

| Risk                                                | Likelihood | Impact | Mitigation                                           |
| --------------------------------------------------- | ---------- | ------ | ---------------------------------------------------- |
| Existing `syncRatingsOnCopy: true` activates writes | Medium     | High   | Upgrade note; preserve opt-in and CLI precedence     |
| Large page increases Plex response work             | Medium     | Medium | Inclusive 1–1,000 validation                         |
| Fence misses future nested fields                   | Medium     | Low    | Keep explicit nested validator; separate future work |
| Over-strict new rules break tolerated config        | Low        | Medium | Match current validation policy                      |

### Integration Challenges

- The same page size feeds four capability families; validate against their shared ceiling.
- Documentation already describes rating sync aspirationally; update only the missing bounds and
  activation warning.

### Security Considerations

#### Critical — Hard Stops

| Finding         | Risk                           | Required Mitigation               |
| --------------- | ------------------------------ | --------------------------------- |
| None identified | No new auth or secret boundary | Preserve existing token redaction |

#### Warnings — Must Address

| Finding                                     | Risk                                 | Mitigation                                 | Alternatives                            |
| ------------------------------------------- | ------------------------------------ | ------------------------------------------ | --------------------------------------- |
| Rating writes activate for existing config  | Destination/source metadata mutation | Release note and retained hardlink warning | Remove the key to preserve old behavior |
| Unbounded paging could amplify resource use | Plex load and response memory        | Shared 1,000 ceiling                       | Lower configured value                  |

#### Advisories — Best Practices

- The type fence complements but does not replace runtime validation.
- Keep `popmEmail` documentation clear that it is embedded in MP3 metadata.

## Task Breakdown Preview

### Phase 1: Validator and Fence

**Focus**: restore the three fields safely.

**Tasks**:

- Add runtime validation and assignments.
- Add compile-time top-level key coverage.

**Parallelization**: runtime and tests may be planned as separate file owners.

### Phase 2: Tests and Documentation

**Focus**: prove and communicate the behavior change.

**Dependencies**: validator contract finalized.

**Tasks**:

- Add minimal boundary coverage.
- Update focused docs and changelog.
- Update ROADMAP/archive from live issue state.

### Phase 3: Verification and Delivery

**Focus**: complete all package/repository gates, review, CI, and merge cleanup.

**Tasks**:

- Run focused and full validation.
- Audit Bash/Zsh/Fish completion templates; record that no change is required.
- Review/fix, create PR, monitor CI, squash merge, and clean the worktree/branch.

## Decisions Needed

All implementation-blocking decisions are resolved:

1. **Page-size bound**
   - Choice: 1 through 1,000 inclusive.
   - Rationale: shared downstream identity contract and existing value 250.
2. **Nested strictness**
   - Choice: match neighboring validators; no new unknown-key/NUL/byte rules.
   - Rationale: avoids an unrelated compatibility change.
3. **Audit finding**
   - Choice: child issue #302.
   - Rationale: required audit disposition without scope expansion.

## Research References

- [research-external.md](./research-external.md): external semantics and language patterns.
- [research-business.md](./research-business.md): business rules and upgrade behavior.
- [research-technical.md](./research-technical.md): code paths, audit method, and validation design.
- [research-ux.md](./research-ux.md): config workflows and error recovery.
- [research-security.md](./research-security.md): severity-classified risks.
- [research-practices.md](./research-practices.md): reuse, KISS, and testability guidance.
- [research-recommendations.md](./research-recommendations.md): resolved decisions and delivery plan.
