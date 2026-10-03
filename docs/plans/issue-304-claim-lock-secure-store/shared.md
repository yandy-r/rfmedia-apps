# Issue 304 Claim-Lock Secure-Store Migration

Issue #304 is a behavior-preserving delete-and-delegate refactor of the Lidarr per-plan claim lock.
`acquireLidarrPlanClaim()` remains the sole domain boundary and keeps returning the unchanged
`LidarrPlanClaim` capability while `secure-store/acquireExclusiveLock()` assumes responsibility for
atomic publication, stale-owner recovery, ownership proof, and owner-safe release. The adapter must
make the existing fail-fast and never-steal-a-live-cross-host-owner policies explicit, translate all
shared failures back into Lidarr errors, and require strict record shape plus a distinct staging UUID
source so legacy fail-closed parsing and dependency injection do not weaken. The action-layer
callback fan-out stays untouched so issue #305 can reuse the same boundary for its later path-walk
and writer migration.

## Relevant Files

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Claim API, adapter seam, and legacy lock code.
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`: Supported shared-store import boundary and stale JSDoc.
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`: Canonical lock API, ownership, and stale policy.
- `packages/rfmedia-cli/src/lib/secure-store/errors.ts`: Shared error taxonomy requiring domain translation.
- `packages/rfmedia-cli/src/lib/errors.ts`: Lidarr-visible claim and artifact errors to preserve.
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`: Shipped lock-adapter precedent.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`: Unmodified claim compatibility contract.
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`: Shared lock behavior contract.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Bash/Zsh/Fish apply-option parity gate.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Primary claim acquisition and `finally` release lifecycle.
- `packages/rfmedia-cli/src/actions/lidarr/apply-track-filter-execution.ts`: Independent claim lifecycle.
- `docs/internal/plex-jwt-deferrals.md`: ADR/follow-up inventory that must record #304 completion.
- `ROADMAP.md`: Live issue inventory and secure-artifact milestone state.
- `.github/pull_request_template.md`: Required PR body and verification structure.

## Relevant Patterns

**Domain adapter over shared persistence**: Preserve the caller-facing capability and translate
shared errors at one boundary. See
[`packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts).

**Explicit lock policy**: Pass a deadline equal to the injected clock for zero-wait contention and
`maxAgeMs: null` so a healthy long-running apply cannot be stolen cross-host. See
[`packages/rfmedia-cli/src/lib/secure-store/lock.ts`](../../../packages/rfmedia-cli/src/lib/secure-store/lock.ts).

**Additive compatibility seam**: Enable exact record-key validation and provide a distinct
temporary-name UUID source without changing defaults for existing secure-store consumers. Prove the
new surface with one focused test in
[`packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`](../../../packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts).

**Capability callback fan-out**: Action modules receive `() => Promise<void>` ownership assertions,
not storage implementation details. See
[`packages/rfmedia-cli/src/actions/lidarr/apply.ts`](../../../packages/rfmedia-cli/src/actions/lidarr/apply.ts).

**Operation-specific translation**: Acquisition, assertion, and release interpret shared failures
differently; release must not mask the in-flight apply error or delete a replacement claim. See
[`packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts).

**Unmodified compatibility suite**: Existing real-filesystem tests are the migration contract. A
need to edit the claim tests means behavior changed and the migration must stop and be re-scoped.

## Relevant Docs

**`docs/plans/issue-288-secure-store-migration/design.md`**: You _must_ read this for the decided
claim-lock mapping, deferral rationale, and #305 boundary.

**`docs/plans/issue-288-secure-store-migration/plan.md`**: You _must_ read this for the shipped
secure-store surface and preset adapter precedent.

**`packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`**: You _must_ read this for the
operator-visible exclusivity, stale recovery, and claim-loss contract.

**`docs/internal/plex-jwt-deferrals.md`**: You _must_ read this before changing the secure-store
follow-up inventory.

**`ROADMAP.md`**: You _must_ read and reconcile this against live GitHub issue state immediately
before closeout.

**`.github/pull_request_template.md`**: You _must_ use this structure for the final PR body.
