# ADR — Plex JWT enrollment & refresh lifecycle: deferrals, unknowns, and pinned contracts

**Status:** Accepted
**Date:** 2026-07-28
**Amended:** 2026-07-30 — §4 Q4, §8 item 1 and §9 updated while closing [#288](https://github.com/yandy-r/rfmedia-apps/issues/288); 2026-08-07 — §8 item 1 and §9 updated for [#304](https://github.com/yandy-r/rfmedia-apps/issues/304), resolved by [PR #319](https://github.com/yandy-r/rfmedia-apps/pull/319); 2026-08-08 — §8 item 1 and §9 updated for [#305](https://github.com/yandy-r/rfmedia-apps/issues/305) and [#306](https://github.com/yandy-r/rfmedia-apps/issues/306), resolved by [PR #331](https://github.com/yandy-r/rfmedia-apps/pull/331), and [#308](https://github.com/yandy-r/rfmedia-apps/issues/308), resolved by [PR #333](https://github.com/yandy-r/rfmedia-apps/pull/333)
**Issue:** [#251](https://github.com/yandy-r/rfmedia-apps/issues/251) — Plex JWT enrollment and refresh lifecycle
**Design:** [`docs/plans/plex-jwt-251/design.md`](../plans/plex-jwt-251/design.md)
**Plan of record:** [`docs/plans/plex-jwt-251/plan.md`](../plans/plex-jwt-251/plan.md) (overrides the design; design §15 overrides design §1–§14)
**Follow-up issues:** [#286](https://github.com/yandy-r/rfmedia-apps/issues/286), [#287](https://github.com/yandy-r/rfmedia-apps/issues/287), [#288](https://github.com/yandy-r/rfmedia-apps/issues/288) (resolved — see §8 item 1), [#289](https://github.com/yandy-r/rfmedia-apps/issues/289), [#302](https://github.com/yandy-r/rfmedia-apps/issues/302), and the five filed while closing #288 (§9)

This record exists so that nothing decided under #251 has to be re-derived from the diff. It captures what was
deliberately **not** built, what about the Plex wire protocol is still **unverified**, which contracts are **pinned**
across module boundaries, and which debt was **knowingly** accepted. Line-number anchors, where given, are stated against
base commit `85909525` and will drift.

---

## 1. Context

`rfmedia plex …` previously had exactly one way to obtain a credential: the user copies a long-lived legacy token out of
a browser and pastes it into `plex.token`, `--plex-token`, or `PLEX_TOKEN`. #251 adds PIN + JWK enrollment
(`rfmedia plex auth login`), a durable owner-only credential store, and a refreshing token provider — without removing
the legacy path, whose unmodified tests are the backward-compatibility proof.

Everything in this document is a consequence of one fact: **most of the JWT half of the plex.tv API was live-probed on
2026-07-28, but the parts that require a claimed JWK and a real account were not** (§15 Q2 below).

---

## 2. The five deferrals

Each deferral has a durable in-tree artifact — a declared-but-unimplemented protocol member, a runtime error that names
the remedy, or a frozen test — so the deferral is discoverable from the code, not only from this file.

| #   | Deferred                                                              | Why                                                                                                                                                                                                        | In-tree artifact                                                                                                                                              | Follow-up                                                  |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | **Server-side device revocation**                                     | **No client-callable endpoint exists.** Verified 2026-07-28: revocation is only reachable through the plex.tv _Authorized Devices_ UI.                                                                     | `revokeDevice?()` declared and deliberately unimplemented on `PlexAccountProtocol`; `serverSideRevocation: "manual"` in the `plex auth logout` JSON envelope. | [#286](https://github.com/yandy-r/rfmedia-apps/issues/286) |
| 2   | **Enrollment Option 2** (`POST /api/v2/auth/jwk` with a legacy token) | **Rejected, not merely postponed.** Plex documents _"Your legacy token will expire after this process."_ That destroys the rollback credential and makes migration one-way.                                | `registerJwkWithLegacyToken?()` declared and unimplemented. Option 1 (fresh PIN) is the only enrollment path.                                                 | none — a deliberate rejection, not a gap                   |
| 3   | **Per-server `accessToken` exchange** (`GET /api/v2/resources`)       | Only needed **if U6 turns out false**. The per-install PMS probe answers that empirically, so building it now would be speculative.                                                                        | Optional protocol member `exchangeServerAccessToken?()`; the probe's `PLEX_AUTH_PMS_REJECTED` failure names it as the known remedy.                           | [#287](https://github.com/yandy-r/rfmedia-apps/issues/287) |
| 4   | **RS256 / `jose` adoption**                                           | No RSA JWK example is published and none was tested. Ed25519 via `node:crypto` is verified end-to-end (RFC 8037 §3.1 raw 64-byte signatures; RFC 7638 thumbprint reproduces the RFC's own worked example). | `jwt.ts` throws `TypeError` on any `alg !== "EdDSA"`; the two `jose` adoption trip-wires are written into `jwt.ts`'s header JSDoc.                            | none — trip-wire driven                                    |
| 5   | **MCP enrollment arguments**                                          | MCP tools accept arguments from an **untrusted caller**; an enrollment argument would let an MCP client drive credential issuance. `mcp/schema.spec.ts` freezes the tool schema with exact `toEqual`.      | Documented non-goal. **Zero MCP changes** in this work; `mcp/schema.spec.ts` and `mcp/adapters.spec.ts` pass unmodified.                                      | none — a permanent boundary                                |

Not a deferral, recorded to stop it being re-litigated: **`Authorization: Bearer` is not modelled.** Plex's docs are
explicit that JWTs travel in `X-Plex-Token`, with a `:32400/library/sections` example.

---

## 3. Unverified protocol facts (probe date 2026-07-28)

Six items were never observed. They are quarantined inside `src/lib/adapters/plex/jwt-wire.ts` — a pure, IO-free,
clock-free module — with each `U*` annotated inline, so a protocol correction is **one file plus one fixture**.

| ID     | Unknown                                                                                                                                  | Status                                                                                                               | Containment                                                                                                                                                                                                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **U1** | Success body of `POST /api/v2/auth/token`. The doc says `auth_token`; the sibling pins endpoint uses `authToken`. One of them is a typo. | UNVERIFIED — never observed                                                                                          | The tolerant reader accepts **both** casings; a body with neither throws `PlexJwtWireError` carrying bounded `observedKeys` (names only, §5 A4.8) so the real field name is diagnosable from a bug report. Fenced by `jwt-wire.test.ts`.                                                                        |
| **U2** | Whether a lifetime / `expires_in` field is returned at all                                                                               | UNVERIFIED — never observed; the doc says "7 days" in prose only                                                     | A conservative assumed lifetime is applied with `lifetimeAssumed: true`, surfaced in `plex auth status` and the JSON envelope so the assumption is visible rather than laundered.                                                                                                                               |
| **U3** | Whether the pin-exchange `deviceJWT` requires a `nonce` claim                                                                            | UNVERIFIED — a 200 against an **unclaimed** PIN proves nothing                                                       | The pin-exchange assertion **omits** `nonce` (design D6). Including it would spend one of ten nonces per 300 s and invent a failure window: a nonce lives 300 s while a `strong:true` PIN lives 1800 s. If a live claim proves it required, that is one field in `jwt-wire.ts`.                                 |
| **U4** | HTTP 498                                                                                                                                 | UNVERIFIED — never emitted by any reachable path                                                                     | Mapped to `PLEX_AUTH_KEY_REJECTED`, but **nothing depends on receiving it**: proactive expiry refreshes before the request, and 401/422 (both observed) drive reactive recovery.                                                                                                                                |
| **U5** | Duplicate-thumbprint / key-rotation behaviour                                                                                            | UNVERIFIED — an identical JWK was accepted `201` three times; `422 "Thumbprint Already Taken"` fires somewhere later | Every `login` mints a **fresh** key pair (new `kid`, same `clientIdentifier`); in-place rotation is never attempted. `422/1097` maps to an actionable re-enroll with a "remove the old device at plex.tv" remedy.                                                                                               |
| **U6** | Whether a plex.tv-issued JWT is accepted by a PMS                                                                                        | UNVERIFIED — **the doc contradicts itself on the same page**                                                         | Answered **empirically, per install**: `login` probes the configured PMS origin and refuses to persist a credential the probe rejects. A broken assumption surfaces at enrollment, never mid-copy. Tested by `enrollment.test.ts` (probe 401 ⇒ `PLEX_AUTH_PMS_REJECTED` **and the store file does not exist**). |

**Verified live on the same date** (recorded so the unknowns are not mistaken for wholesale uncertainty): the pins
endpoint with `{jwk, strong:true}` → `201`; `GET /api/v2/pins/<id>?deviceJWT=…` with `authToken === null` meaning
_not yet claimed_; `GET /api/v2/auth/nonce` → `200 {"nonce": "<uuidv4>"}`; the IP-scoped rate limit
(`x-ratelimit-limit: 10`, `x-ratelimit-period: 300`, `retry-after: 287`, shared across distinct
`X-Plex-Client-Identifier` values); and the two coexisting error envelopes `{"errors":[{code,message,status}]}` and
`{"error":"…"}`. **No invented endpoint path appears anywhere in this work.**

---

## 4. Resolved decisions (design §15, verbatim)

Restated here so the repo owner can overrule any of them cheaply.

| Q                                                     | Decision                                                                                                                                                                                                                                                                    | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 — ship `plex auth` public surface?                 | **YES.** Four leaves (`login`, `status`, `refresh`, `logout`), a new `src/commands/plex-auth.ts`, and all three completion templates.                                                                                                                                       | AC-1 requires enrollment "without manually copying a browser token". That is unachievable without a user-invocable command. The issue's "only if an explicit auth workflow is approved" is satisfied by AC-1 itself.                                                                                                                                                                                                                                                         |
| Q2 — live Plex enrollment during verification?        | **NO.** U1 and U6 stay open.                                                                                                                                                                                                                                                | Enrolling would register a real device against the owner's Plex account — an outward-facing, account-mutating action that was not requested. The PR's `## Testing` section states plainly that enrollment has never been exercised end-to-end against a real account, and names U1/U6 as the residual risk. Containment is unchanged: the tolerant wire reader accepts both `auth_token` and `authToken`, and `login` refuses to persist a credential its PMS probe rejects. |
| Q3 — hybrid `Retry-After`?                            | **ACCEPT the hybrid.** Bounded in-process wait ≤15 s; above that, persist a cooperative cross-process refusal window.                                                                                                                                                       | The budget is IP-scoped (measured: 10 nonces / 300 s, `retry-after: 287`). A literal always-sleep turns `queue run --workers=2` into a ~5-minute hang. Acknowledged on the issue rather than silently chosen.                                                                                                                                                                                                                                                                |
| Q4 — refactor `lidarr/profile-preset-persistence.ts`? | **NO** for #251, **YES** under [#288](https://github.com/yandy-r/rfmedia-apps/issues/288). `src/lib/secure-store` shipped consumed **only** by the Plex credential store; `profile-preset-persistence.ts` was **untouched** in that PR and now delegates to `secure-store`. | Minimal blast radius wins inside a credential PR: that module is 1003 lines of already-hardened, shipped, security-critical code. The duplication was temporary and tracked by a follow-up issue. The bet held: because `secure-store` was authored as a general-purpose module, the later migration was a delete-and-delegate rather than a rewrite, and `profile-preset-persistence.test.ts` passed unmodified.                                                            |

**Q2 is the single most important line in this document.** Enrollment has **never** been exercised end-to-end against a
real Plex account. The first user to run `rfmedia plex auth login` is the test. What makes that acceptable rather than
reckless is structural: the wire reader accepts both plausible field names, the PMS probe refuses to persist a
credential the server rejects, and an unrecognized 2xx body produces a diagnosable error instead of a silent
`undefined`.

---

## 5. Permanent architecture rules established here

### 5.1 The façade rule

`src/lib/adapters/plex-adapter.ts` is the **sole** re-export surface for everything under `src/lib/adapters/plex/`. Any
consumer above the adapter layer — `lib/adapters/index.ts`, `actions/plex-auth.ts`, `commands/plex-auth.ts`,
`actions/lidarr/audit-plex.ts`, `lib/error-formatters.ts` — imports plex symbols **only** from the façade.

Three properties make this non-negotiable rather than stylistic:

- `scripts/check-direct-plex-imports.mjs` matches module specifiers as **raw text**, so `import type` is **not** exempt.
- The gate runs under **both** `prebuild` and `pretypecheck`, so a violation breaks `npm run build` **and**
  `npm run typecheck` — it does not merely fail a lint.
- The failure surfaces as `private-plex-import`, which reads like an unrelated tooling problem to anyone who has not
  read this file.

**A consumer that needs a symbol the façade does not export extends the façade's re-export list. It never adds a
`./plex/*` import.** The façade's line budget is ~300 with an abort criterion at 450: past that, trim the export list to
what consumers actually use rather than creating a second façade (a second file would need its own gate exemption).

### 5.2 One origin-normalization authority

`src/lib/plex-origin.ts` is the single home of `normalizePlexOrigin`, shared by the adapter resolver's cross-origin
credential guard and by the `plex auth` verbs. It was extracted verbatim from a module-private function in
`src/lib/adapters/index.ts`.

Divergence between "the origin we enrolled" and "the origin the resolver looks up" produces **no compile error and no
failing test** — it produces a silent `not-enrolled` for a working enrollment, or an enrollment match looser than the
security guard. `grep -rn "function normalizePlexOrigin" packages/rfmedia-cli/src` must return **exactly one** hit,
permanently.

---

## 6. Contracts pinned across module boundaries

These four were pinned in the plan of record because their definition and their use are separated by a batch barrier, or
because the obvious spelling is a silent trap.

| Ref      | Contract                                                                                                                                                                                                                                                                                | Why it is pinned rather than left to the implementer                                                                                                                                                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A5.2** | `sanitizeMessage(value: unknown, secrets: readonly string[])` — an **array**, and the parameter is **required** (empty array is the "no secrets" case).                                                                                                                                 | `string` **is** `Iterable<string>`. Had the parameter been typed `Iterable<string>`, every existing bare-`string` call site would have compiled unchanged while redacting each individual **character** — and a positive `toContain("[REDACTED]")` assertion could still pass. The array type forces every call site to be visited. |
| **A5.4** | `new PlexJwtTokenProvider(connection: PlexConnectionSettings, options: { storePath: string; refreshMarginSeconds: number; deviceName?: string; now?: () => number; account?: PlexAccountProtocol })`; `account` defaults to the real enrollment client, `now` to `Date.now`.            | Defined in one task and constructed in another, across a barrier. Divergence would only surface at the barrier typecheck, after both sides were written.                                                                                                                                                                            |
| **A6.1** | `PlexAssertionInput = { clientIdentifier; kid; audience; issuedAtEpochSeconds; lifetimeSeconds; jti; nonce? }`. The **pin-exchange** assertion omits `nonce` (U3/D6); the **refresh** assertion requires it. Callers construct `PlexAssertionInput` and never hand-build claim objects. | The type was referenced by the design's claim builders but never defined there. Hand-built claim objects would let the U3 decision drift silently between the two call paths.                                                                                                                                                       |
| **A6.6** | `PlexCredentialState` has **no `{kind: "absent"}` variant**. `readPlexAuthStatus` returns `{ enrolled: false }` when the store is missing.                                                                                                                                              | A store handle only exists when a store parsed successfully, so `absent` is unreachable by construction — and the state is re-exported through the façade and rendered in the `plex auth status` envelope, where a dead variant is a permanent source of confusion.                                                                 |

---

## 7. Specification gaps decided here (not left to implementer judgement)

| Ref       | Gap                                                          | Binding decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A4.2**  | When does a refresh loser **adopt** the winner's credential? | Adoption predicate is `credentialState.kind === "fresh"` **and** `refreshNotBeforeEpochSeconds <= now`. The monotonic version is used **only** for CAS, **never** for adoption — `back-off`, `authorize-origin`, and `forget-origin` all bump the version without issuing a credential. A re-read that is expired-but-backed-off throws `PLEX_AUTH_RATE_LIMITED` carrying the peer's remaining wait, with **zero** network calls. Adopting on "version advanced" would reproduce exactly the nonce-budget exhaustion this design exists to prevent. |
| **A4.4**  | A lock whose holder cannot be probed                         | Staleness is pid-liveness **plus an age rule**: a lock whose `createdAt` is older than `SECURE_STORE_LOCK_MAX_AGE_MS = 120_000` is stale regardless of host or pid, and is stolen exactly once. `EPERM` from `process.kill(pid, 0)` means **alive** — intentional and documented. `plex auth status` reports `lockPath`, and the busy error's remediation names it verbatim. **There is no `--force-unlock` verb.** Consequence to document for users: the credential store must live on a **local filesystem** — the lock is `link()`-based.       |
| **A4.5**  | PMS offline at enrollment time                               | `login` fails with `PLEX_AUTH_UNREACHABLE` and **discards** the freshly minted credential. There is **no `--skip-probe`**. Each retry mints a new PIN against the IP-scoped budget, which the help text and `plex-configuration.md` say plainly.                                                                                                                                                                                                                                                                                                    |
| **A4.7**  | `plex auth login --plex-url` vs the cross-origin guard       | **Enrollment goes around `buildPlexAdapterConfiguration`.** `login`/`refresh`/`logout`/`status` normalize `--plex-url ?? plex.url` themselves via `src/lib/plex-origin.ts`. Rationale: enrollment is an explicit interactive action minting a **fresh** credential for the origin the user just named; the cross-origin guard exists to stop an **untrusted MCP caller** redirecting an **already-held** credential. The guard itself is unchanged, and its regression tests pass unmodified.                                                       |
| **A4.8**  | Bounding `observedKeys` (U1 diagnostics)                     | **Reject, never strip.** Drop any key that exceeds 32 characters, contains a character outside `[A-Za-z0-9_.-]`, or matches `/[A-Za-z0-9_-]{16,}/` (a value-shaped key). Recurse **exactly one level** into a top-level object value, prefixing `parent.child`. Cap at 12 entries after filtering; set `observedKeysTruncated` when anything was dropped for **any** reason. Key **names** only — never values, never in `message`, surfaced only in the JSON `diagnostics` field and under `--debug`.                                              |
| **A4.9**  | The `plex auth` failure envelope                             | A dedicated envelope in `actions/plex-auth.ts`: `{ command: "plex-auth-<verb>", error: { message, code, retryable, retryAfterSeconds, statusCode, remediation, diagnostics? } }`. `retryAfterSeconds` is **mandatory** on `PLEX_AUTH_RATE_LIMITED` for every verb. `redactErrorMessage(error, sensitiveValues)` is applied. Boundary: the **action** returns a typed result or throws and never writes to stdout; the **command** prints and sets `process.exitCode = 1`.                                                                           |
| **A4.12** | Unbounded reactive refresh                                   | `handleAuthFailure` **does** bypass the freshness gate, but is capped at `PLEX_MAX_REACTIVE_REFRESHES_PER_PROCESS = 2` **per process, per store path**. Beyond the cap it returns `"fail"` with no network call. Without the cap, a server rejecting every token turns one failed command into an unbounded refresh storm against an IP-scoped budget.                                                                                                                                                                                              |

---

## 8. Technical debt knowingly accepted

1. **Duplicated private-file primitives — corrected here, and resolved by [#288](https://github.com/yandy-r/rfmedia-apps/issues/288).** Per §15 Q4,
   `src/lib/secure-store/` shipped as new code **modelled on** `lidarr/profile-preset-persistence.ts` rather than an
   extraction from it, and that module was untouched by #251. Two claims recorded here were wrong and are corrected.

   **Correction 1 — six, not four.** Six expressions in production carried a `0o600`/`0o700` private mode, not four:
   named `PRIVATE_DIRECTORY_MODE` / `PRIVATE_FILE_MODE` pairs in `profile-preset-persistence.ts`, `plan.ts` and
   `lidarr/plan-engine.ts`, plus three inline `open(path, "wx+", 0o600)` literals in `filesystem.ts`,
   `tag-writer/mp3-publisher.ts` and `conversion-metadata.ts`. The last two appear in neither the original inventory
   nor [#288](https://github.com/yandy-r/rfmedia-apps/issues/288)'s own text.

   **Correction 2 — `filesystem.ts` is not an "owner-only file/directory mode".** Its `0o600` is a _transient
   stage-privacy floor_: the stage is created private so a half-built artifact is unobservable, then **relaxed** to
   the computed publish mode by `stagedHandle.chmod(publishMode)` at `filesystem.ts:1032` — the only `chmod` in the
   file. Conversions publish at ~`0o644` and `filesystem.test.ts` pins `0o640`/`0o604`, so importing
   `PRIVATE_FILE_MODE` there would have encoded a false invariant and invited a later "consistency" pass to break
   three tests. All three inline literals took a named local constant instead (`STAGE_PRIVATE_MODE` in
   `filesystem.ts` and `tag-writer/mp3-publisher.ts`, `UNLINKED_DESCRIPTOR_MODE` in `conversion-metadata.ts`).

   **What #288 shipped.** `profile-preset-persistence.ts` delete-and-delegates its safe-parent walk, bounded reader,
   both atomic writers and its origin lock onto `secure-store`, shedding ~250 lines with its test file unmodified.
   `plan.ts` and `lidarr/plan-engine.ts` take the constants only.

   **Why #304 was split from #288.** The claim lock could not safely join #288's preset-lock migration:
   `plan-engine.test.ts` requires a corrupt partial claim to yield `LidarrPlanAlreadyRunningError` **and** remain
   byte-identical where `secure-store` reports `SECURE_STORE_CORRUPT`; its staleness policy inverts under the shared
   age rule; and `claim.assertOwned` is threaded through 68 references across 15 files under `src/actions/lidarr/`.
   Bundling that compatibility boundary into #288 would have made both review and independent rollback materially
   harder.

   **Single shared-lock architecture — #304 resolved by [PR #319](https://github.com/yandy-r/rfmedia-apps/pull/319).**
   `secure-store`'s `acquireExclusiveLock` is the sole `link()`-based lock implementation. The Plex credential store,
   Lidarr preset apply lock, and Lidarr plan claim consume it through domain adapters. `acquireLidarrPlanClaim()` keeps
   the existing `LidarrPlanClaim` capability and Lidarr error taxonomy while selecting zero-wait acquisition, disabling
   age-based stealing, requiring the exact four-key legacy claim shape, and keeping ownership and staging UUID sources
   separate. No action-layer claim callback or on-disk published claim path/schema changes.

   **Plan I/O consolidation — #305 and #306 resolved by
   [PR #331](https://github.com/yandy-r/rfmedia-apps/pull/331).** `plan.ts` and
   `lidarr/plan-engine.ts` now delete-and-delegate their safe-parent walks, bounded readers, staging writers,
   publication, cleanup, and directory syncing to `secure-store`. Copy-plan retains literal traversal rejection,
   hardens only its descriptor-validated final parent, and selects identity-guarded replacement for overwrite.
   Lidarr retains create-only plans and identity-guarded history replacement. Both keep non-mutating
   `allow-foreign-read` compatibility; the permissive-umask fixtures now declare their intended `0o644`/`0o700`
   modes explicitly instead of accidentally creating foreign-writable inputs. The shared writer's pre-publication
   descriptor chmod also removes #306's post-rename pathname race. #308's lock-metadata taxonomy correction shipped
   in [PR #333](https://github.com/yandy-r/rfmedia-apps/pull/333); #307 remains an independent open defect, and #323
   separately tracks release-path error discrimination.

2. **Three declared `plex.*` config fields are silently dropped.** `pageSize`, `syncRatingsOnCopy`, and
   `syncOnCopyDefaults` are declared on `PlexConfigOptions` in `src/types/config.ts` but never read by
   `validatePlexConfigOptions` in `src/lib/config.ts` (`grep -c` returns 0 for all three). This predates #251 and is
   **not** fixed here; the new `plex.auth` block is wired through the validator precisely so it does not join them.
   `plex-adapter.test.ts` currently masks the bug by feeding a config object straight to a mocked loader, bypassing the
   validator. Tracked by [#289](https://github.com/yandy-r/rfmedia-apps/issues/289).
   **Resolved 2026-07-30 by
   [#303](https://github.com/yandy-r/rfmedia-apps/pull/303):** the validator now retains all three
   fields, validates their nested contract, and has a compile-time fence against future top-level
   drift. The same audit found `copy.conflictStrategy` is dropped independently; that follow-up is
   [#302](https://github.com/yandy-r/rfmedia-apps/issues/302).
3. **`parseRetryAfter` supports numeric seconds only.** The HTTP-date form of `Retry-After` is deliberately
   unsupported — a real limitation of the moved-verbatim parser, recorded in its JSDoc. Every observed response from
   both plex.tv and the PMS used numeric seconds.
4. **`exactOptionalPropertyTypes` is OFF, and `retryAfterSeconds` depends on that.** Verified: the flag appears in no
   tsconfig in the repo. Forwarding `retryAfterSeconds` through the local `mediaServerError` helper in
   `plex/client.ts` compiles only because the flag is off. **Enabling it later will break that call path** — this is a
   knowing dependency, recorded so it is not rediscovered as a mystery diagnostic.
5. **`PLEX_CLIENT_IDENTIFIER = "rfmedia-cli"` is retained** as the static-branch default, contrary to the design's
   proposal to delete it. Precedence branches 1 (`--plex-token`) and 3 (`plex.token`) have no credential store and
   therefore no persisted per-install UUIDv4, while connection settings require a client identifier. Enrolled
   installs use their persisted UUIDv4; the static default never reaches the wire (the PMS request header set is
   `{Accept, X-Plex-Token}`, fenced by an existing test).

---

## 9. Follow-up issues filed for this work

The first four were filed while closing #251, and #302 while closing #289. The rest were filed while
closing #288, whose verification widened the duplicate-site inventory and surfaced two defects that
must not ship inside a chore commit (§8 item 1).

| Issue                                                      | Type        | Scope                                                                                                                                                                           |
| ---------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#286](https://github.com/yandy-r/rfmedia-apps/issues/286) | enhancement | Plex device revocation endpoint — **blocked**: no documented client-callable API.                                                                                               |
| [#287](https://github.com/yandy-r/rfmedia-apps/issues/287) | enhancement | Per-server `accessToken` exchange via `GET /api/v2/resources` — **implement only if U6 proves false**.                                                                          |
| [#288](https://github.com/yandy-r/rfmedia-apps/issues/288) | chore       | Migrate the duplicate private-file-mode primitives onto `src/lib/secure-store`. **Resolved** — see §8 item 1 for what shipped and what deferred.                                |
| [#289](https://github.com/yandy-r/rfmedia-apps/issues/289) | chore       | Retain and validate every declared `PlexConfigOptions` field — resolved by [#303](https://github.com/yandy-r/rfmedia-apps/pull/303).                                            |
| [#302](https://github.com/yandy-r/rfmedia-apps/issues/302) | chore       | `validateCopyConfig` silently drops the declared `conflictStrategy` field.                                                                                                      |
| [#304](https://github.com/yandy-r/rfmedia-apps/issues/304) | chore       | **Resolved by [PR #319](https://github.com/yandy-r/rfmedia-apps/pull/319).** The plan claim now delegates to the canonical shared lock through its unchanged domain capability. |
| [#305](https://github.com/yandy-r/rfmedia-apps/issues/305) | chore       | **Resolved by [PR #331](https://github.com/yandy-r/rfmedia-apps/pull/331).** Copy and Lidarr plan I/O now delegate to canonical secure-store primitives.                        |
| [#306](https://github.com/yandy-r/rfmedia-apps/issues/306) | security    | **Resolved by [PR #331](https://github.com/yandy-r/rfmedia-apps/pull/331).** Plan publication hardens the open staging descriptor before atomic publication.                    |
| [#307](https://github.com/yandy-r/rfmedia-apps/issues/307) | bug         | **Open.** `filesystem.ts` can publish a `0o400` destination under a `0277` umask on the non-converting `verify --fix` path. Found by #288, not changed by #304.                 |
| [#308](https://github.com/yandy-r/rfmedia-apps/issues/308) | chore       | **Resolved by [PR #333](https://github.com/yandy-r/rfmedia-apps/pull/333).** Invalid preset lock-owner metadata now reports `LIDARR_PRESET_LOCK_METADATA_INVALID`.              |

Deliberately **not** filed: a `refactor` issue to split `src/lib/adapters/plex/types.ts` (669 lines, already over the
soft cap). This work makes that file **smaller**, not larger — the credential `WeakMap` moves out — so the split has no
trigger yet. File it separately if the file grows again.

---

## 10. Revisit triggers

- **U1 resolves** (a real enrollment returns a token body): correct the field name in `jwt-wire.ts` and update one
  fixture. Nothing else changes.
- **U6 proves false** (`PLEX_AUTH_PMS_REJECTED` from a healthy PMS): implement `exchangeServerAccessToken()` per
  [#287](https://github.com/yandy-r/rfmedia-apps/issues/287). The probe failure message already names it.
- **U5 bites** (`422 "Thumbprint Already Taken"` in the field): the remedy is already actionable — re-enroll after
  removing the old device at plex.tv. Revisit only if it fires without a duplicate device.
- **Plex publishes a client-callable revocation endpoint:** implement `revokeDevice()`
  ([#286](https://github.com/yandy-r/rfmedia-apps/issues/286)) and change `serverSideRevocation` from `"manual"` to a
  real result.
- **An RSA JWK example is published, or the `jwt.ts` trip-wires fire:** re-evaluate adopting `jose` instead of hand-rolled
  EdDSA compact JWS.
- **`exactOptionalPropertyTypes` is turned on:** expect the `retryAfterSeconds` forwarding in `plex/client.ts` to break
  first (§8 item 4).
