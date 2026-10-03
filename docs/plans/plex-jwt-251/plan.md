# AUTHORITATIVE IMPLEMENTATION PLAN — Issue #251 (Plex JWT enrollment & refresh lifecycle)

**Worktree:** `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-plex-jwt-251`
**Design (read in full before any task):** `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/docs/plans/plex-jwt-251/design.md`
**Package root for all relative paths:** `packages/rfmedia-cli/` unless prefixed `/`.

> **Precedence:** this plan overrides the design wherever they conflict. Design §15 overrides design §1–§14. Section A lists every override; sections A5/A6 are the amendments added after critic review and override sections B–H wherever they were written before those amendments.

---

## A. Corrections to the design

### A1. BLOCKERS — the design as written cannot pass its own gates

| #        | Design claim                                                                                                                                                                                         | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                  | What the implementer MUST do instead                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1.1** | §3 line 131: _"Architecture-gate blast radius: one `FETCH_OWNERS` line."_ §9 has `adapters/index.ts` calling `plexAuthStoreExistsSync`; §4 types `PlexAdapterCredential` with `PlexAuthStoreHandle`. | **FALSE — blocks `typecheck` AND `build`.** Verified: `check-direct-plex-imports.mjs:574-585` fires `private-plex-import` for any file importing `src/lib/adapters/plex/*` that is not under `PRIVATE_PLEX_DIRECTORY` and is not `PRIVATE_PLEX_COMPOSER` (`src/lib/adapters/plex-adapter.ts`). `MODULE_SPECIFIER_PATTERN` (`:154`) is a raw-text regex — **`import type` is NOT exempt**. `check:architecture` runs under `prebuild` AND `pretypecheck`. | **Mandate a façade.** `plex-adapter.ts` becomes the sole re-export surface. `adapters/index.ts`, `actions/plex-auth.ts`, `commands/plex-auth.ts`, `actions/lidarr/audit-plex.ts`, and `lib/error-formatters.ts` import **only** from `./plex-adapter.js` (or `../lib/adapters/plex-adapter.js`). Exhaustive export list in **T-19 step 5**. Gate diff is **+2** script lines (A1.2), and `plex-adapter.ts` budget rises 140 → **~300**.        |
| **A1.2** | §3: `FETCH_OWNERS` is _"One line"_.                                                                                                                                                                  | **PARTIALLY FALSE.** Verified: entries key on named constants (`:15-19`, map at `:123-127`, three entries today).                                                                                                                                                                                                                                                                                                                                        | **+2 lines**: `const PLEX_ENROLLMENT_FETCH_OWNER = "src/lib/adapters/plex/enrollment-client.ts";` near `:15-19`, plus the Map entry. Also: `FETCH_CALL_PATTERN` (`:158`) is `/\b(?:fetch                                                                                                                                                                                                                                                       | trustedFetch)\s\*\(/g` — it matches **`trustedFetch(`too, and matches inside comments and string literals**.`enrollment-client.ts`must contain exactly **one** combined occurrence in the whole file. Never write`fetch(` in a JSDoc example. |
| **A1.3** | §4: `PlexJwtWireError` (design 331-336) and `PlexAuthError` (design 528-538) declared with `readonly` fields, no constructor.                                                                        | **TS2564 ×3 under `strict: true`.**                                                                                                                                                                                                                                                                                                                                                                                                                      | Give both classes **real constructors** assigning every non-optional field, mirroring `MediaServerError` (`src/types/media-server.ts:307-314`). Per **D21**, populate `observedKeys` **before** `Object.freeze(this)`.                                                                                                                                                                                                                         |
| **A1.4** | §7 `#handleNonSuccess` snippet passes `retryAfterSeconds` to `mediaServerError(...)`.                                                                                                                | **TS2353.** Verified: the local helper at `client.ts:91-104` types `options` as `{ readonly statusCode?: number; readonly retryable?: boolean }`.                                                                                                                                                                                                                                                                                                        | Widen the helper's `options` with `readonly retryAfterSeconds?: number` and forward it to `new MediaServerError(...)`. Safe: `exactOptionalPropertyTypes` is **absent/false** (verified — zero repo-wide hits). **Record this dependency in the ADR** — enabling that flag later breaks it.                                                                                                                                                    |
| **A1.5** | §4 `PlexAdapterConfiguration.clientIdentifier: string` (required) + §3 _"Delete `PLEX_CLIENT_IDENTIFIER`"_.                                                                                          | **Unimplementable.** Precedence branches 1 (`--plex-token`) and 3 (`plex.token`) have no store and therefore no persisted UUIDv4, but `createPlexConnectionSettings` requires `clientIdentifier` (`plex/types.ts:77`).                                                                                                                                                                                                                                   | **Keep `PLEX_CLIENT_IDENTIFIER = "rfmedia-cli"`** at `plex-adapter.ts:17` as the static-branch default. Declare `readonly clientIdentifier?: string` and resolve `configuration.clientIdentifier ?? PLEX_CLIENT_IDENTIFIER` at the settings-construction call. Safe: it never reaches the wire (`client.ts:387` header set is `{Accept, X-Plex-Token}`, fenced by `client.test.ts:70-73`) and no test pins the production value.               |
| **A1.6** | §4 `PlexAdapterCredential = {kind:"enrolled"; store: PlexAuthStoreHandle}`; §9 resolves the credential inside `new PlexAdapter(...)`.                                                                | **Breaks the `optional` adapter contract.** `readStoredCredential` throws `PlexAuthError`; `createMediaServerAdapter` (`index.ts:144-152`) catches nothing after `resolved.ok`. `createOptionalMediaServerAdapter` must return `undefined` + `logWarn`, never throw.                                                                                                                                                                                     | **Resolve the stored credential to a `string` inside `buildPlexAdapterConfiguration`**, where the `not-enrolled` failure reason already lives. `PlexAdapterCredential` becomes `{kind:"static"; token} \| {kind:"enrolled"; token; storePath; refreshMarginSeconds}` — a resolved value plus the coordinates the rotating provider needs, **not** a live store handle. This also removes `PlexAuthStoreHandle` from `index.ts`'s type surface. |
| **A1.7** | §12 runs `src/commands/plex-auth.test.ts`, `src/actions/plex-auth.test.ts`, `src/lib/adapters/plex/jwt.test.ts`.                                                                                     | **§10 defines none of them.**                                                                                                                                                                                                                                                                                                                                                                                                                            | See **section E**. Keep a minimal `jwt.test.ts` and a minimal `commands/plex-auth.test.ts`. **Drop `actions/plex-auth.test.ts`** — remove it from the §12 command list.                                                                                                                                                                                                                                                                        |

### A2. Wrong anchors — use these instead

| Design cite                                                                         | Reality (verified)                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §8 bash step 4: _"L266-274 … (`status` is already present)"_                        | **FALSE.** The plex sub-sub `case` pattern at **`bash.ts:270`** is `run\|list\|query-results\|export\|push\|pull\|both\|create\|add\|show\|delete)` — **no `status`**. Add **`\|status\|login\|refresh\|logout`**, or `plex auth status --<TAB>` completes nothing.                                                                                   |
| §8 zsh step 2: _"modelled on `sync)` at L1346-1360"_                                | **FALSE.** `zsh.ts:1346-1360` is the `collection delete)` leaf tail + `esac` closers. The plex **`sync)` arm is `zsh.ts:1186-1244`**. The correct `_arguments` leaf model is **`zsh.ts:1345-1353`**.                                                                                                                                                  |
| §8 bash step 5: _"`sync)` branch at L834-865 (four flag-only leaves)"_              | Branch is **`bash.ts:833-864`** with **three** leaves (`push` 837, `pull` 844, `both` 853), each with a `_filedir -d` fallback (omit those).                                                                                                                                                                                                          |
| §8 bash step 7: _"unlike the lidarr arm at L209"_                                   | Plex arm **`bash.ts:208-209`** (unguarded — bug is real). Guarded lidarr arm is **`bash.ts:210-211`**.                                                                                                                                                                                                                                                |
| §8: _"repairs `plex query list`, `plex playlist list`, `plex collection …`"_        | `plex playlist list` is **NOT** repaired. `playlist`, `copy`, `sync` also appear in the **top-level** alternation at `bash.ts:200`, so `cmd` is clobbered one layer earlier. Repaired by the `-z "$subcmd"` guard: `plex query list`, `plex collection list\|show\|add\|create`. **Do not claim the playlist fix in the PR.**                         |
| §7 + D9: _"the Lidarr precedent documented at `config.ts:297`"_                     | **WRONG FILE.** `src/lib/config.ts:297` is `validatePositiveInteger`. The real precedent is **`src/types/config.ts:297`** (`retryBackoffCapMs`, default 15_000), implemented at `lidarr/scheduler.ts:47,65,416-418` and `lidarr/resilience.ts:114`.                                                                                                   |
| §9/§10: _"`ExcludedFromPlan` fence at `plan.ts:877`"_                               | `plan.ts:877` is `\| "plexToken"`. The build fence is **`plan.ts:884-885`** (`const _planAllowlistCoversCopyOptions: UnclassifiedCopyOptionKeys extends never ? true : never = true;`).                                                                                                                                                               |
| §8: _"`plex.ts:48,59,72,98` all throw `InvalidArgumentError`"_                      | All four wrong. Parsers declared at **49, 66, 82, 108**; throws at **52, 69, 85, 89, 118**. The architectural point (Commander `process.exit(1)` before `.action()`) is correct.                                                                                                                                                                      |
| §8: _"matching `plex collection delete` at `plex.ts:2392`"_                         | `-y, --yes` is at **`plex.ts:2393`** (`:2392` is `--library`).                                                                                                                                                                                                                                                                                        |
| §10/§3: `templates.spec.ts:33-40`                                                   | Tree literal is **`34-41`**; the `plex:` array is **`35`**; append the `auth:` key after **40**.                                                                                                                                                                                                                                                      |
| §8: _"`assertInteractiveApplyApproval` (`lidarr-mutation-presenter.ts:975`)"_       | File is **`src/commands/lidarr-mutation-presenter.ts:975`**. Signature `(machineOutput: boolean): void`; it does **not** check `--yes` — the caller (`commands/lidarr.ts:1354`) does.                                                                                                                                                                 |
| §2 out-of-scope: _"`filesystem.ts:533`"_ copy of `PRIVATE_FILE_MODE`                | `:533` is an **inline literal** `await open(stagedPath, "wx", 0o600)`, not a named constant.                                                                                                                                                                                                                                                          |
| §9: _"`~25 production call sites`"_ of `createMediaServerAdapter`                   | **2 direct**, both inside `index.ts` (`:159`, `:166`); 21 transitive via `lib/adapters/action-helpers.ts`. **`src/mcp/adapters.ts` calls no adapter factory** — it forwards `plexUrl`/`plexToken` into action option objects (`:294-295, 385-386, 490-491`). The security argument holds one hop further out; the "stay sync" conclusion still holds. |
| §12 comment: _"`check:architecture` runs under both `pretypecheck` and `prebuild`"_ | **TRUE for `check:architecture`.** **FALSE for `test:architecture`** — `prebuild = codegen:lidarr:check && check:architecture`. `test:architecture` gates `typecheck` only.                                                                                                                                                                           |
| ROADMAP _"Line ~7 / Line ~11"_                                                      | **Line 8** (`**Last updated:** 2026-07-27`), **line 10** (`**Open issues:** 85 (rfapps 40 · rfmedia 45)`).                                                                                                                                                                                                                                            |

### A3. False premises — delete the work they imply

| Design claim                                                                                                                                                             | Verdict                                                                                                                                                                                                                                                                                                 | Action                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3/§4 line 171: `validateOpaqueCredential` _"Re-exported from `auth.ts` for backward compatibility"_                                                                     | **Moot AND inverted.** It is **not exported** today (`auth.ts:26`, plain `function`), zero importers.                                                                                                                                                                                                   | **Move it to `credential-cell.ts`. Add NO re-export** — that would be dead code. After the move, `readPlexCredentialCell` validates on read, so `StaticPlexTokenProvider.getToken` must **not** call it a second time.                                              |
| §10: _"`plex-adapter.test.ts` — construction sites `token` → `credential`"_                                                                                              | **FALSE.** Zero `new PlexAdapter(` and zero `PlexAdapterConfiguration` in any test. The only producer is `index.ts:89-99`; only consumer `index.ts:152`. `plex-adapter.test.ts:26`'s `token: "test-token"` is a `PlexConfigOptions` field fed to the `getLoadedPlexConfig` mock — **it stays `token`**. | That file needs only the mandatory `RFMEDIA_PLEX_AUTH_DIR` tmpdir in `beforeEach` plus the new T1 cases.                                                                                                                                                            |
| §3/§6/§11-Risk-3/§10: `secure-store.ts` is _"extracted verbatim"_ from `profile-preset-persistence.ts`; _"No new locking scheme is invented"_; 250 lines; needs no test. | **FALSE on all four counts, and §15 Q4 (`ppp` untouched) destroys the no-test justification.** `ppp` is **100% async** — its only fs import is `node:fs/promises`, **zero** `Sync(` calls. `acquireLidarrPresetApplyLock` has **no backoff loop, no deadline, no `AbortSignal`**.                       | `secure-store` is **new code modelled on** `ppp`, shipping **both sync and async** safe-path machinery plus a genuinely new waiting lock. Budget **~560 lines across 5 files** in `src/lib/secure-store/`. **It gets its own test file.**                           |
| §3 changed-files row for `lidarr/profile-preset-persistence.ts`; §6 line 652; §10 lines 1040/1050; §11 Risk 3; §12 line 1122; **D7 `(b) lidarr only`**; §14 Q4           | **All stale — §15 Q4 = NO.**                                                                                                                                                                                                                                                                            | `profile-preset-persistence.ts` is **NOT TOUCHED**. Treat D7 as resolved to **(c)**. Its test must pass unmodified. The follow-up chore issue lists **four** duplicate sites.                                                                                       |
| §2/§9: the silently-dropped-field precedent is `pageSize`                                                                                                                | **Understated — it is threefold.** `grep -c` in `src/lib/config.ts` returns **0** for `pageSize`, `syncRatingsOnCopy`, and `syncOnCopyDefaults` (declared at `types/config.ts:266, 278, 280`).                                                                                                          | Cite all three in the ADR. Fixing them is out of scope; add to the follow-up chore issue. `plex-adapter.test.ts:27` sets `pageSize: 250` and masks the bug by bypassing the validator.                                                                              |
| §5 stage 3 / §11 Risk 1: _"compose a throwaway `PlexClient` … and call `getInstanceId()`"_                                                                               | **Not reachable from a bare `PlexClient`.** `getInstanceId` is produced by `createPlexIdentityCapability` (`identity.ts:155-207`), which needs a `getMachineIdentifier` private to `createPlexQueryLibraryFamily`.                                                                                      | Probe by calling the transport directly: `transport.request<unknown>({ path: "/", operation: "verify Plex enrollment", options: { method: "GET", signal } })`, then validate with **`isPlexWireServerResponse`** (`plex/types.ts:645`) to read `machineIdentifier`. |
| §5 note / §3: `errors.ts` _"colocated in jwt-provider.ts"_                                                                                                               | **Self-inconsistent.** Four modules need `PlexAuthError`.                                                                                                                                                                                                                                               | Ship **`src/lib/adapters/plex/errors.ts`** as a real file (T-06).                                                                                                                                                                                                   |
| §3: `src/lib/http/retry-after.ts`                                                                                                                                        | Creates a directory adjacent to the existing file `src/lib/http-url.ts`.                                                                                                                                                                                                                                | Ship as **`src/lib/retry-after.ts`** — flat.                                                                                                                                                                                                                        |

### A4. Specification gaps — decided here so the implementer never guesses

| #         | Gap                                                                                                                                                 | **Binding decision**                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------------------------------------------------------- |
| **A4.1**  | §10 ships `secure-store` untested.                                                                                                                  | **Write `src/lib/secure-store/secure-store.test.ts`.** Six cases: (i) lock contention — holder + waiter, waiter backs off then acquires after release; (ii) stale steal by dead pid; (iii) stale steal by `createdAt` age; (iv) live peer → `SECURE_STORE_LOCK_BUSY` at deadline; (v) sync load refuses a `0o640` file and a symlink; (vi) atomic replace of a pre-existing `0o644` file yields `0o600` and a new inode.                  |
| **A4.2**  | §5 line 628 adopts on _"peer's version advanced"_; `back-off`, `authorize-origin`, `forget-origin` bump `version` **without issuing a credential**. | **Adoption predicate is: `credentialState.kind === "fresh"` AND `refreshNotBeforeEpochSeconds <= now`.** Version is used **only** for CAS, never for adoption. If the re-read is expired-but-backed-off, throw `PLEX_AUTH_RATE_LIMITED` carrying the peer's remaining wait, **zero network calls**.                                                                                                                                       |
| **A4.3**  | §4's `withPlexAuthStoreLock` JSDoc vs §6 layer 3's version CAS are mutually exclusive.                                                              | **Re-read under the lock is authoritative.** The version CAS compares the **re-read** version against disk immediately before `rename`; it guards a non-conforming writer that bypassed the lock, nothing else. There is **no caller-held stale snapshot**. Delete §6's "Stale-write rejection" paragraph from the mental model.                                                                                                          |
| **A4.4**  | Stale detection is pid-liveness only; PID reuse or `EPERM` wedges the lock forever.                                                                 | Add an **age rule**: a lock whose `createdAt` is older than `SECURE_STORE_LOCK_MAX_AGE_MS = 120_000` is stale **regardless of host or pid** and is stolen exactly once. `EPERM` ⇒ treat-as-alive is intentional and documented. `plex auth status` reports `lockPath`; the busy error's `remediation` names it verbatim. **No `--force-unlock` verb.**                                                                                    |
| **A4.5**  | No transition for a PMS offline at enrollment.                                                                                                      | **If the PMS is unreachable, `login` fails with `PLEX_AUTH_UNREACHABLE` and the freshly minted credential is discarded.** No `--skip-probe`. Documented in help text and `plex-configuration.md`, including that each retry mints a new PIN against an IP-scoped budget.                                                                                                                                                                  |
| **A4.6**  | The probe's token provider is unspecified.                                                                                                          | **The probe MUST use `createStaticPlexCredentialCell` + `StaticPlexTokenProvider`.** Never the rotating provider.                                                                                                                                                                                                                                                                                                                         |
| **A4.7**  | `plex auth login --plex-url` vs the cross-origin guard.                                                                                             | **Enrollment goes AROUND `buildPlexAdapterConfiguration`.** `login`/`refresh`/`logout`/`status` normalize `--plex-url ?? plex.url` themselves via the shared `normalizePlexOrigin` (**A5.1**). Rationale for the ADR: enrollment is an explicit interactive action minting a **fresh** credential for the origin the user just named; the D3 guard exists to stop an **untrusted MCP caller** redirecting an **already-held** credential. |
| **A4.8**  | `observedKeys`' `[A-Za-z0-9_.-]` filter is a superset of base64url + `.`.                                                                           | **Reject, never strip.** Drop any key that (a) exceeds 32 chars, (b) contains a character outside `[A-Za-z0-9_.-]`, or (c) matches `/[A-Za-z0-9_-]{16,}/`. Recurse **exactly one level** into a top-level object value, prefixing `parent.child`. Cap 12 entries after filtering; set `observedKeysTruncated` when anything was dropped for **any** reason.                                                                               |
| **A4.9**  | §7 points at `reportLidarrFailure`, which is **module-private** and hard-codes `lidarr-${subcommand}`.                                              | **Define a new plex-auth failure envelope** in `actions/plex-auth.ts`: `{ command: "plex-auth-<verb>", error: { message, code, retryable, retryAfterSeconds, statusCode, remediation, diagnostics? } }`. `retryAfterSeconds` is **mandatory** on `PLEX_AUTH_RATE_LIMITED` for every verb. Apply `redactErrorMessage(error, sensitiveValues)` (`src/lib/redact-error-message.ts:7`).                                                       |
| **A4.10** | §9's replacement gate `staticToken === undefined` is an **undefined** test where today's `!token` is a **falsy** test.                              | Use **`!staticToken`**: `if (!rawUrl                                                                                                                                                                                                                                                                                                                                                                                                      |     | (!staticToken && !plexAuthStoreExistsSync(storeDeps)))`. |
| **A4.11** | D13's _"no successful token exchange recorded"_ disambiguator is dead logic; `PlexCredentialState {kind:"absent"}` is unreachable.                  | **D13 becomes a call-site discriminator parameter**: `enrollPlexClient` maps `422/1097` → `PLEX_AUTH_NOT_ENROLLED`; `refreshPlexCredential` maps it → `PLEX_AUTH_KEY_REJECTED`. **`{kind:"absent"}` is DELETED from the union** (**A5.11**).                                                                                                                                                                                              |
| **A4.12** | `handleAuthFailure`'s reactive refresh is unbounded per process.                                                                                    | (a) `handleAuthFailure` **does** bypass the freshness gate. (b) **Per-process, per-storePath cap of 2 reactive refreshes** — `PLEX_MAX_REACTIVE_REFRESHES_PER_PROCESS = 2`; beyond that return `"fail"` with no network call.                                                                                                                                                                                                             |
| **A4.13** | `plex auth status` reports `clockSkewSeconds` but status is offline.                                                                                | **`status` makes no network call.** `clockSkewSeconds` reports the **last persisted** observation (`lastObservedSkewSeconds` in the store schema, written on any successful enrollment/refresh response) or `null`.                                                                                                                                                                                                                       |
| **A4.14** | §9's _"add a commented `auth` block to `buildConfigTemplate`"_.                                                                                     | **Impossible and unwanted.** `buildConfigTemplate` (`config.ts:4089-4197`) returns a plain object fed to `yaml.dump`. **Do not touch it.** Document `plex.auth` in `plex-configuration.md` and the README config table instead. **Remove `config.ts:4140` from the changed-anchors list.**                                                                                                                                                |
| **A4.15** | §12 verification block.                                                                                                                             | `lint:md` and `format*` are **root** scripts. Also **the design doc itself fails `lint:md`** with 3 × MD031 at `design.md:868, 874, 886` — fix in T-26.                                                                                                                                                                                                                                                                                   |
| **A4.16** | ADR path ambiguity.                                                                                                                                 | **Repo root: `/docs/internal/plex-jwt-deferrals.md`.** New directory.                                                                                                                                                                                                                                                                                                                                                                     |

### A5. Critic amendments — P0 (compile/correctness blockers and runnability)

| #        | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **Binding resolution**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A5.1** | **`normalizePlexOrigin` has no owner and the plan inverted its dependency.** Verified: it is a **module-private function at `src/lib/adapters/index.ts:45-64`** (used at `:76` and `:83`) — not exported, not in `plex/`, not in `http-url.ts`. A4.7 requires it in T-18 (batch 2) and T-21 (batch 4); its only home is T-20's file in **batch 4**. Duplicating it diverges origin semantics between "the origin we enrolled" and "the origin the resolver looks up" (silent `not-enrolled` for a working enrollment, or a looser match than the cross-origin guard). | **New BATCH-0 task T-00** owning a new `src/lib/plex-origin.ts`: move `normalizePlexOrigin` **verbatim**, exported, JSDoc'd. T-20 (owner of `index.ts`) deletes the private copy and imports from it. Verified safe against the gate: `LEGACY_PLEX_MODULES` uses **exact `Set.has(target)`** (`check-direct-plex-imports.mjs:565`) on `"src/lib/plex"`, so `src/lib/plex-origin` does **not** match. `plex-adapter.test.ts:424-426` and `mcp/adapters.spec.ts:672` must stay green unmodified as proof the guard is unchanged.                                                                                                                                                                                                                                                                      |
| **A5.2** | **`sanitizeMessage(value, secrets: Iterable<string>)` is a silent type trap.** `string` **is** `Iterable<string>`. Verified today's signature is `sanitizeMessage(value: unknown, token?: string)` (`client.ts:76`) with call sites `configurationError` (`:106-108`) and `#throwAttemptError` (`:475`) passing a bare `string`. Those would **compile unchanged** and redact every individual character; `client.test.ts`'s positive `toContain("[REDACTED]")` could still pass.                                                                                     | Signature is **`sanitizeMessage(value: unknown, secrets: readonly string[])`** — an array type, so a bare `string` argument is a **compile error**, forcing every call site to be visited. Binding on T-03 and on T-16's call-site updates. Empty array is the "no secrets" case (the parameter is **required**, not optional).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **A5.3** | **T-19 must build a rotating connection for `kind: "enrolled"`.** If the enrolled branch builds a **static** cell, T-17's `rotatePlexCredentialCell` throws `TypeError` on the first refresh (T-07's own contract). No acceptance command caught this — `jwt-provider.test.ts` builds its own connection.                                                                                                                                                                                                                                                             | T-19 **must** call `createPlexRotatingConnectionSettings` for `kind: "enrolled"` and `createPlexConnectionSettings` for `kind: "static"`. T-20's T1 gains one assertion: an `enrolled` resolution produces a connection whose cell accepts `rotatePlexCredentialCell` (and a `static` resolution's cell rejects it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **A5.4** | **`PlexJwtTokenProvider`'s constructor contract is never specified** — defined in T-17 (batch 2), constructed in T-19 (batch 3), across a barrier.                                                                                                                                                                                                                                                                                                                                                                                                                    | **Pinned here, consumer-owned.** Exact signature: `new PlexJwtTokenProvider(connection: PlexConnectionSettings, options: { readonly storePath: string; readonly refreshMarginSeconds: number; readonly deviceName?: string; readonly now?: () => number; readonly account?: PlexAccountProtocol })`. `account` defaults to the real enrollment client; `now` defaults to `Date.now`. T-17 implements exactly this; T-19 constructs exactly this.                                                                                                                                                                                                                                                                                                                                                    |
| **A5.5** | **Per-task acceptance commands are package-global in a shared worktree.** `npx tsc --noEmit`, `npm run check:architecture`, `npm run test:architecture`, `npm run test:run` all scan the whole package; 12 concurrent BATCH-0 agents would fail each other's gates for unrelated reasons.                                                                                                                                                                                                                                                                             | **Isolation model (binding): one shared worktree; per-task acceptance is FILE-SCOPED; global gates run once per barrier by the orchestrator.** Every per-task acceptance block uses only:<br>• `env -u FORCE_COLOR npx vitest run <files the task owns>`<br>• **scoped typecheck**: `! (npx tsc --noEmit 2>&1 \| grep -E '^(<owned paths>)')` — succeeds when no diagnostic names a file the task owns.<br>• **scoped architecture check**: `! (npm run check:architecture 2>&1 \| grep -E '<owned paths>')`.<br>Unscoped `npm run typecheck`, `check:architecture`, `test:architecture`, `test:run`, `build:*` are **orchestrator-only, at each batch barrier** (command block in section G.0). A task must never "fix" a diagnostic in a file it does not own — it reports the collision instead. |

### A6. Critic amendments — P1/P2/P3 (discovered work, non-discriminating gates, missing test)

| #         | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **Binding resolution**                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A6.1**  | **`PlexAssertionInput` is referenced but never defined** — design §4 uses it in `buildPinExchangeClaims` / `buildRefreshClaims`; it appears nowhere in the design.                                                                                                                                                                                                                                                                                               | **T-05 defines and exports it** with this exact field list: `{ readonly clientIdentifier: string; readonly kid: string; readonly audience: string; readonly issuedAtEpochSeconds: number; readonly lifetimeSeconds: number; readonly jti: string; readonly nonce?: string }`. `buildPinExchangeClaims` **omits** `nonce` (D6/U3); `buildRefreshClaims` **requires** it. T-17 and T-18 **construct `PlexAssertionInput` and never hand-build claim objects**. |
| **A6.2**  | **Fish leaf candidate lines are missing from T-10.** Verified `extractFishCandidates(script, "auth")` builds condition `__fish_rfmedia_plex_auth_needs_subcommand`, then `extractFishConditionCandidates` (`templates.spec.ts:430-436`) collects **every** line containing `-n "<condition>"`, reads its `-a "…"`, and compares in order.                                                                                                                        | T-10 must emit the four lines `complete -c rfmedia -n "__fish_rfmedia_plex_auth_needs_subcommand" -a "<leaf>" -d "<desc>"` for `login`, `status`, `refresh`, `logout` **in that order**, using the T-10 description table. Without them the new tree key fails.                                                                                                                                                                                              |
| **A6.3**  | **`src/types/index.ts` is unowned and must change.** Verified: it is a **named** re-export list (`:96-124`) containing `PlexConfigOptions`, `PlexCacheConfig`, … — not `export *`.                                                                                                                                                                                                                                                                               | **Add `src/types/index.ts` to T-08's owned files** (+1 line: `PlexAuthConfigOptions` in the `./config.js` export block).                                                                                                                                                                                                                                                                                                                                     |
| **A6.4**  | **`src/commands/plex-auth.ts` is not in `PLEX_COMPATIBILITY_ALLOWLIST`.** Verified the set (`check-direct-plex-imports.mjs:134-146`) lists `src/commands/plex.ts` but not the new module.                                                                                                                                                                                                                                                                        | Restate the prohibition in **T-23**: `commands/plex-auth.ts` must **not** import `src/types/plex*` (violation = `plex-compatibility-import`, fails build and typecheck). Same prohibition already stated for T-21. **Do not add either file to the allowlist.**                                                                                                                                                                                              |
| **A6.5**  | **T-06's `SECURE_STORE_LOCK_BUSY` message entry is a type error** — `PLEX_AUTH_MESSAGES` is keyed by `PlexAuthErrorCode`; that code is a `SecureStoreErrorCode`.                                                                                                                                                                                                                                                                                                 | The union member is **`PLEX_AUTH_REFRESH_BUSY`**. Corrected in T-06 and in A4.4's wording: `SecureStoreError(SECURE_STORE_LOCK_BUSY)` maps to `PlexAuthError(PLEX_AUTH_REFRESH_BUSY)`, whose remediation names `lockPath`.                                                                                                                                                                                                                                   |
| **A6.6**  | **A4.11 left `{kind:"absent"}` to implementer judgment**, but `PlexCredentialState` is re-exported through the façade and rendered in the `plex auth status` envelope.                                                                                                                                                                                                                                                                                           | **DELETE the `{kind:"absent"}` variant.** A `PlexAuthStoreHandle` only exists when a store parsed successfully, so it is unreachable by construction. `readPlexAuthStatus` returns `{ enrolled: false }` when `loadPlexAuthStoreSync` returns `undefined`.                                                                                                                                                                                                   |
| **A6.7**  | **T-16 omits `isRead` sites.** Verified **8** occurrences in `client.ts`: declaration `:41`, computed `:329`, passed `:342`, retry gate `:420`, advisory flag `:433`, and three more — `:448` (timeout in `#parseSuccessBody`), `:473` (timeout in `#throwAttemptError`), `:485` (network error).                                                                                                                                                                | **All 8 move together** in one atomic rename `isRead → replayable`. A scan-trigger GET marked `replayable: false` must not be advertised as `retryable` on timeout or network failure either.                                                                                                                                                                                                                                                                |
| **A6.8**  | **`npm run format` is not runnable.** Verified root `"format": "prettier --write"` — no target; errors `No parser and no file path given`.                                                                                                                                                                                                                                                                                                                       | Use **`npm run format:all && npm run lint:md`** from the repo root (or `npm run format:md` when only markdown changed). Applies to T-24, T-26, section G.                                                                                                                                                                                                                                                                                                    |
| **A6.9**  | **The "docs trigger no CI" claim is half wrong.** Verified `.github/workflows/rfmedia-cli.yml:4-10` PR filter includes `packages/rfmedia-cli/**`.                                                                                                                                                                                                                                                                                                                | T-24's edits to `packages/rfmedia-cli/README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/features/*` **do** trigger the PR job (typecheck/tests, not `lint:md`). Only `/ROADMAP.md`, `/docs/**`, `/CLAUDE.md`, `/AGENTS.md` are CI-invisible.                                                                                                                                                                                                                       |
| **A6.10** | **T-21/T-23 output boundary unspecified** — who prints, who sets the exit code.                                                                                                                                                                                                                                                                                                                                                                                  | **Pinned:** the action **returns a typed result object or throws**; it never writes to stdout and never sets `process.exitCode`. The **command** calls `formatOutput` for success, catches, builds the A4.9 failure envelope, prints it, and sets `process.exitCode = 1`. Matches `commands/plex.ts`. The failure-envelope **builder** lives in `actions/plex-auth.ts` and is exported for the command to call.                                              |
| **A6.11** | **T-09's acceptance is non-discriminating** — with `alwaysRequired: false` and the file absent, a typo'd owner path passes both gate commands identically.                                                                                                                                                                                                                                                                                                       | T-09 must **create a throwaway stub** at the exact owner path containing one `fetch(`, confirm the gate reports the owner; add a second `fetch(`, confirm the gate **fails** with `plex-enrollment-fetch-owner-count`; then **delete the stub**. The batch-0 barrier verifies `git status --porcelain` contains no `enrollment-client.ts`.                                                                                                                   |
| **A6.12** | **T-03's acceptance is non-discriminating and hides an ownership conflict** — `plex/http.ts` has zero importers until T-16, and the hardened `sanitizeMessage` is security-relevant behavior whose only test file (`client.test.ts`) is owned by T-16, two batches later.                                                                                                                                                                                        | **T-03 gets its own `src/lib/adapters/plex/http.test.ts`** with exactly four assertions: (i) `refresh_token=<value>` is redacted (the `\b` bug); (ii) `auth_token=<value>` is redacted; (iii) a **previous** secret passed in the `secrets` array is removed (post-rotation case); (iv) a bidi control character is stripped. Nothing else.                                                                                                                  |
| **A6.13** | **T-06's acceptance is weak.**                                                                                                                                                                                                                                                                                                                                                                                                                                   | Missing union members **are** caught: `Readonly<Record<PlexAuthErrorCode, string>>` is a mapped type over a finite literal union, so an omission is a compile error under the scoped typecheck. Message **text** is exercised by T-17/T-21 consumers; no extra test. Acceptance stays scoped typecheck + scoped architecture check, with that rationale recorded in the task.                                                                                |
| **A6.14** | **T-19's façade completeness is only proven when batch 4 compiles.**                                                                                                                                                                                                                                                                                                                                                                                             | T-19 acceptance adds a **throwaway consumer probe**: create `src/lib/adapters/facade-probe.tmp.ts` (outside `plex/`) importing **every** symbol from T-19's re-export list from `./plex-adapter.js`, run the scoped typecheck **and** `npm run check:architecture` (this probe is the one place the unscoped gate is run inside a task — batch 3 is a single task, so there is no concurrency), then **delete the probe**. Barrier verifies it is gone.      |
| **A6.15** | **CRITICAL MISSING TEST — `src/lib/adapters/plex/enrollment.test.ts`.** T-18's "no test file" justification was factually wrong: T-13 tests the store, **T-14 has no test at all**, T-17 tests refresh (not enroll), T-23 tests Commander wiring. The enroll → poll → **PMS probe → discard-on-reject** → single locked CAS write path had **zero** coverage. That path is AC-1, half of AC-3, and the entire containment story for Risk 1 (U6, rated Critical). | **Add a minimal 3-case `enrollment.test.ts` to T-18** (injected wire client + injected transport + `tmpdir()` store): (i) claimed PIN + probe 200 ⇒ exactly **one** store write, `version === 1`, mutations `{enroll, issue, authorize-origin}`; (ii) probe 401 ⇒ `PLEX_AUTH_PMS_REJECTED` **and the store file does not exist**; (iii) `forgetPlexEnrollment` ⇒ file unlinked, result carries `serverSideRevocation: "manual"`.                             |
| **A6.16** | **T3(b) is in the wrong task** — "two store handles over one temp file; A holding `v7` is rejected with `PLEX_AUTH_STORE_VERSION_CONFLICT`" is a **`credential-store`** invariant, yet it sat in `jwt-provider.test.ts` while T4 had no version-conflict case. T-13 could ship a broken CAS and pass its own acceptance.                                                                                                                                         | **Move T3(b) into T-13/T4** as a seventh case. T-17 keeps only the provider-level concurrency cases.                                                                                                                                                                                                                                                                                                                                                         |
| **A6.17** | **AC-3's "revocation" and "clock skew" have no test.**                                                                                                                                                                                                                                                                                                                                                                                                           | Revocation is covered by A6.15(iii). Skew: **add one case to T-17** — a refresh that succeeds but whose new credential immediately reads expired emits `PLEX_AUTH_CLOCK_SKEW`, never "token expired" (design §5.8's infinite-re-enrollment guard).                                                                                                                                                                                                           |
| **A6.18** | **Minor gold-plating in T5** — `JSON.stringify(adapter)` requires constructing a full `PlexAdapter` inside `jwt-provider.test.ts`, a cross-layer reach into T-19's composition.                                                                                                                                                                                                                                                                                  | **Drop that sink from T5**; move the `JSON.stringify(adapter)` assertion into **T-20's T1**, where an adapter is already built. The other six sinks stay.                                                                                                                                                                                                                                                                                                    |

---

## B. Batched task list

**Global rules for every task:** no `any`; `.js` extensions on all relative imports; `import type` for type-only imports (`verbatimModuleSyntax: true`); bracket access on index-signature reads (`noPropertyAccessFromIndexSignature: true`); JSDoc on **every** exported symbol; `override readonly name = …` on error subclasses (`noImplicitOverride: true`); throw early, no silent fallbacks; ~500-line soft cap per file; `env -u FORCE_COLOR` on every vitest invocation.

**Acceptance discipline (A5.5):** per-task commands are **file-scoped only**. Do not run `npm run typecheck`, `npm run check:architecture` (except T-19's single-task probe), `npm run test:architecture`, `npm run test:run`, or any `build:*` inside a task. Those are barrier commands (G.0).

Scoped helpers used below (run from `packages/rfmedia-cli/`):

```bash
# scoped typecheck: succeeds only when no diagnostic names an owned file
! (npx tsc --noEmit 2>&1 | grep -E '^(<OWNED_PATHS>)')
# scoped architecture check: succeeds only when no violation names an owned file
! (npm run check:architecture 2>&1 | grep -E '<OWNED_PATHS>')
```

---

### BATCH 0 — foundations (12 tasks, zero cross-dependencies)

---

#### T-00 — extract `normalizePlexOrigin` into a shared module

**Owns (new):** `packages/rfmedia-cli/src/lib/plex-origin.ts`

**Depends on:** none. **Unblocks:** T-18, T-20, T-21.

**Spec (A5.1).** Copy `normalizePlexOrigin` **verbatim** from `src/lib/adapters/index.ts:45-64` into the new module and `export` it with JSDoc stating that it is the single origin-normalization authority shared by the adapter resolver (cross-origin guard) and the enrollment verbs, and that any divergence produces silent `not-enrolled` results for working enrollments.

- **Do NOT edit `src/lib/adapters/index.ts` here** — T-20 owns that file and deletes the private copy in batch 4. Temporary duplication across the barrier is intentional and mirrors the T-03/T-16 pattern.
- Behaviour must be **byte-identical**: same trimming, same protocol/host/port handling, same `undefined` return for invalid input. No added validation, no added normalization, no error throwing.
- File placement verified safe against the architecture gate: `LEGACY_PLEX_MODULES` uses exact `Set.has(target)` on `"src/lib/plex"` (`check-direct-plex-imports.mjs:565`), so `src/lib/plex-origin` does not match.

**Acceptance:**

```bash
cd packages/rfmedia-cli && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/plex-origin\.ts)')
```

**~25 lines.**

---

#### T-01 — `secure-store` module (sync + async hardened FS primitives)

**Owns (all new):**

- `packages/rfmedia-cli/src/lib/secure-store/errors.ts`
- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`
- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`

**Depends on:** none.

**Spec.** Read design §6 in full, then **A3 row 4** and **A4.1/A4.4**. `lidarr/profile-preset-persistence.ts` is a **read-only reference model — do not edit it**. It is 100% async; every sync primitive here is new code.

- **`errors.ts`** — `SecureStoreError extends Error` with a real constructor (A1.3 pattern), `override readonly name`, `readonly code: SecureStoreErrorCode`, `readonly path: string`. Code union: `SECURE_STORE_UNSAFE_PATH`, `SECURE_STORE_PERMISSIONS`, `SECURE_STORE_CORRUPT`, `SECURE_STORE_VERSION_CONFLICT`, `SECURE_STORE_LOCK_BUSY`, `SECURE_STORE_CANCELLED`, `SECURE_STORE_TOO_LARGE`. Messages are **subject-parameterized** (`subject: string` constructor arg) so the Plex store names itself.
- **`paths.ts`** — `PRIVATE_DIRECTORY_MODE = 0o700`, `PRIVATE_FILE_MODE = 0o600`. Async `prepareSafeParent(path, create)` and **sync** `prepareSafeParentSync(path)`: walk **every** path component from the filesystem root with `lstat`/`lstatSync`; reject non-directory, symlink, foreign owner, `(mode & 0o022) !== 0`. `assertSafeParentUnchanged` / `…Sync`, `assertOpenedFileIdentity` / `…Sync` (compare `{dev, ino}`). `readBoundedPrivateFileSync(path, maxBytes)`: `openSync(path, O_RDONLY | O_NOFOLLOW)`, `fstatSync`, reject `(mode & 0o077) !== 0` with `SECURE_STORE_PERMISSIONS` and a `chmod 600 <path>` remedy, bounded read, re-`lstatSync`, compare `{dev,ino}`. **No silent repair anywhere.** Model on `ppp:146-273`.
- **`atomic.ts`** — `syncDirectory`, `createPrivateFileAtomically`, `replacePrivateFileAtomically`. Sibling temp in the **same directory** (never `os.tmpdir()` — `EXDEV`). Sequence exactly as design §6 layer 3: `open(tmp, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)` → **`handle.chmod(0o600)` (MANDATORY — mode is ignored on an existing file and a `0277` umask yields `0400`)** → write → `fsync` → `fstat` → close → `assertOpenedFileIdentity` → `rename` → re-assert identity → `fsync(dir)`. Model on `ppp:858-948`.
- **`lock.ts`** — `acquireExclusiveLock(lockPath, { deadlineEpochMs, signal, now, hostname, pid, isProcessAlive, randomUUID })`. Record `{host, pid, createdAt, ownershipToken: uuidv4}`. `link(tmp, lockPath)` for atomic exclusive create. On `EEXIST`: read the record; steal **exactly once** if (dead pid on the same host) **or** (`now - createdAt > SECURE_STORE_LOCK_MAX_AGE_MS = 120_000`, any host — **A4.4**); otherwise **jittered backoff `min(50·2ⁿ + rand(0,50), 2000) ms`** until `deadlineEpochMs`, then `SECURE_STORE_LOCK_BUSY`. `signal` aborts the wait with `SECURE_STORE_CANCELLED`. `release()` re-reads and unlinks **only if `ownershipToken` still matches**. `EPERM` from `process.kill(pid, 0)` ⇒ **alive** (documented, intentional). This backoff/deadline/signal loop **does not exist in `ppp` — it is new**.
- **`index.ts`** — barrel re-exporting the public surface only.
- **Test** — exactly the six cases in **A4.1**, using `tmpdir()` and injected `now`/`pid`/`isProcessAlive`. No new mocking infrastructure.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/secure-store/secure-store.test.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/secure-store/)')
```

**~560 lines** (5 modules) + ~150 test. **Abort criterion:** if any single module exceeds 500 lines, split `paths.ts` into `paths-sync.ts` / `paths-async.ts`.

---

#### T-02 — `parseRetryAfter` relocation + shared caps

**Owns:** `packages/rfmedia-cli/src/lib/retry-after.ts` (new), `packages/rfmedia-cli/src/lib/lidarr/errors.ts` (modified).

**Depends on:** none.

**Spec.** Move `parseRetryAfter` **verbatim** from `lidarr/errors.ts:251-257` to `src/lib/retry-after.ts` (flat path — A3 row 8). `lidarr/errors.ts` re-exports it (`export { parseRetryAfter } from "../retry-after.js";`) so every existing importer is untouched. **Zero behaviour change.** JSDoc must note that HTTP-date form is deliberately unsupported (numeric seconds only) — a real limitation the ADR records.

Also export from the same module:

- `PLEX_RETRY_AFTER_WAIT_CAP_SECONDS = 15`, JSDoc citing the real precedent **`src/types/config.ts:297` (`retryBackoffCapMs`) / `lidarr/scheduler.ts:416-418`** (A2).
- `PLEX_REFRESH_BACKOFF_CAP_SECONDS = 900`.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/lidarr/errors.test.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/retry-after\.ts|src/lib/lidarr/errors\.ts)')
```

**~35 lines.**

---

#### T-03 — `plex/http.ts` shared HTTP primitives + `http.test.ts`

**Owns:** `packages/rfmedia-cli/src/lib/adapters/plex/http.ts` (new), `packages/rfmedia-cli/src/lib/adapters/plex/http.test.ts` (new).

**Depends on:** none.

**Spec.** **Create** this module by copying — **not deleting** — the following from `client.ts`: `BodyLimitError` (`:52-54`), `isAborted` (`:68-70`), `callerAbortReason` (`:72-74`), `sanitizeMessage` (`:76-89`), `composeAbortSignals` (`:169-200`), `readBoundedBody` (`:202-235`). **T-16 deletes the originals and repoints `client.ts`'s imports** — do not touch `client.ts` here. The temporary duplication compiles; the batch barrier resolves it.

Harden `sanitizeMessage` per design §7 "Redaction":

- Signature becomes **`sanitizeMessage(value: unknown, secrets: readonly string[])`** — an **array**, required, not `Iterable<string>` and not optional (**A5.2**: `string` is assignable to `Iterable<string>`, so an `Iterable` signature would let today's bare-`string` call sites compile while redacting every individual character). Every secret with `length > 0` is exact-removed with `[REDACTED]`.
- Replace `\b…\b` with `[\w-]*` boundaries so `refresh_token=` and `auth_token=` match (`\btoken\b` does **not** match `refresh_token` — `_` is `\w`).
- Add `pincode|code|secret|signature|assertion|refresh|devicejwt` to the key alternation.
- Add `\p{Bidi_Control}` stripping (parity with `redact-error-message.ts:1`; `plex/types.ts:335` uses an enumerated codepoint class instead — match `redact-error-message.ts`).
- **Redaction stays before truncation**; `[REDACTED]` stays the literal marker (`client.test.ts` asserts on it positively); 512-char cap preserved.

Keep `BodyLimitError`'s `override readonly name`.

**Test (A6.12) — exactly four assertions:** (i) `refresh_token=<value>` redacted; (ii) `auth_token=<value>` redacted; (iii) a **previous** secret supplied in the `secrets` array is removed (post-rotation case); (iv) a bidi control character is stripped. Nothing else — `client.test.ts` (T-16) covers the rest.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/adapters/plex/http.test.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/adapters/plex/http)')
```

**~200 lines** + ~50 test.

---

#### T-04 — `plex/jwt.ts` + minimal test

**Owns:** `packages/rfmedia-cli/src/lib/adapters/plex/jwt.ts`, `packages/rfmedia-cli/src/lib/adapters/plex/jwt.test.ts` (both new).

**Depends on:** none.

**Spec.** Implement design **§4 block 3** exactly: `PlexEd25519PublicJwk`, `PlexClientKeyPair`, `generatePlexClientKeyPair`, `jwkThumbprint` (RFC 7638), `signCompactJws` (EdDSA, `sign(null, …)` — OpenSSL **rejects** a digest argument on Ed25519). `node:crypto` only; **no `jose`** (D17). Reproduce the two `jose` adoption trip-wires verbatim in the header JSDoc (design lines 196-203). `signCompactJws` **throws `TypeError` when `alg !== "EdDSA"`**.

**Test (critical, justified):** a wrong RFC 7638 thumbprint yields a `kid` the server never matches — enrollment fails with a server-side error no local test would catch, and §15 Q2 means no live run will catch it. Two cases only: (i) the **RFC 7638 §3.1 worked example** as a known-answer vector; (ii) `signCompactJws` throws on a non-EdDSA `alg`.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/adapters/plex/jwt.test.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/adapters/plex/jwt\.)')
```

**~150 lines** + ~40 test.

---

#### T-05 — `plex/jwt-wire.ts` THE QUARANTINE + T7 test

**Owns:** `packages/rfmedia-cli/src/lib/adapters/plex/jwt-wire.ts`, `packages/rfmedia-cli/src/lib/adapters/plex/jwt-wire.test.ts` (both new).

**Depends on:** none. (Imports `PlexEd25519PublicJwk` as a **type only** from `./jwt.js`; use `import type`.)

**Spec.** Implement design **§4 block 4** verbatim, including the full header JSDoc with the 2026-07-28 probe date and every `U1..U6` annotation. **Pure — no `fetch`, no IO, no clock, no `Date.now()`.** All constants, `PlexAccountWire` members, `PlexTokenGrant`, `PlexPinRecord`, `PlexPinClaim`, `PlexWireFailure`, `PlexJwtWireErrorCode`, `PlexJwtWireError`.

Binding corrections:

- **`PlexJwtWireError` needs a real constructor** (A1.3). Populate `observedKeys` **before** `Object.freeze(this)` (D21).
- **`observedKeys` uses reject-not-strip, one-level recursion, long-base64url rejection, 12-entry cap, `observedKeysTruncated`** — implement exactly **A4.8**.
- **Define and export `PlexAssertionInput`** with the exact field list in **A6.1**. `buildPinExchangeClaims(input)` **omits `nonce`** (D6/U3); `buildRefreshClaims(input)` **requires** it and throws `TypeError` if absent.
- `readTokenGrant` accepts **both** `auth_token` and `authToken` (U1). No lifetime field ⇒ `PLEX_JWT_ASSUMED_LIFETIME_SECONDS` (6 days) with `lifetimeAssumed: true` (D11).
- `normalizeFailure` handles **both** envelopes (`{"errors":[{code,…}]}` and `{"error":"…"}`) and reads **only** the numeric `code`, validated as a safe integer. **The `message` is never read, never stored, never returned.**
- `readNonce` **throws on `200 {}`** — never infer success from status (a `200 {}` nonce response was actually observed).
- PIN code validation is **D14 (b)**: non-empty, ≤64 chars, no whitespace, printable ASCII. **No `/^[A-Z0-9]{4}$/` regex.**

**Test = T7**, exactly design §10 T7's six assertions, plus the `observedKeys` bounding from A4.8.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/adapters/plex/jwt-wire.test.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/adapters/plex/jwt-wire)')
```

**~250 lines** + ~140 test.

---

#### T-06 — `plex/errors.ts` (`PlexAuthError` + frozen message table)

**Owns:** `packages/rfmedia-cli/src/lib/adapters/plex/errors.ts` (new).

**Depends on:** none.

**Spec.** Implement design **§4 block 6**, promoted to a real file (A3 row 9). Full `PlexAuthErrorCode` union (15 members, verbatim from the design, **including `PLEX_AUTH_REFRESH_BUSY`**). `PLEX_AUTH_MESSAGES: Readonly<Record<PlexAuthErrorCode, string>>` — `Object.freeze`d, populated from design §7's message column.

- **A6.5:** the store-busy entry is **`PLEX_AUTH_REFRESH_BUSY`**, not `SECURE_STORE_LOCK_BUSY` (that is a `SecureStoreErrorCode` and would be a type error in this table). Its `remediation` names the lock path (A4.4).
- `noUncheckedIndexedAccess` does **not** affect a finite literal-union `Record` (mapped type, not an index signature), so `PLEX_AUTH_MESSAGES[code]` is `string` — no guard needed.
- `PlexAuthError extends Error` with a **real constructor** (A1.3) assigning `code`, `remediation` (fixed local literal naming the exact next command), `retryAfterSeconds?`, `path?`, `observedKeys?`; `override readonly name = "PlexAuthError"`; `Object.freeze(this)` **after** `observedKeys` is set (D21).
- Export `PLEX_MAX_REACTIVE_REFRESHES_PER_PROCESS = 2` (A4.12).
- **Server-supplied text is never a message input.** No parameter accepts wire text.

**Acceptance (rationale in A6.13 — a missing union member is a compile error because the table is a mapped type over the union):**

```bash
cd packages/rfmedia-cli \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/adapters/plex/errors\.ts)') \
  && ! (npm run check:architecture 2>&1 | grep -E 'src/lib/adapters/plex/errors\.ts')
```

**~110 lines.**

---

#### T-07 — `plex/credential-cell.ts` + T2 test

**Owns:** `packages/rfmedia-cli/src/lib/adapters/plex/credential-cell.ts`, `packages/rfmedia-cli/src/lib/adapters/plex/credential-cell.test.ts` (both new).

**Depends on:** none.

**Spec.** Implement design **§4 block 1** exactly. Secrets live in a **module-private `WeakMap`** keyed by the cell — never an enumerable property.

- **Move** `validateOpaqueCredential` here from `auth.ts:26-34`, preserving both error literals **byte-for-byte**: `"Plex credential must not be empty"` and `"Plex credential contains a control character"`. **Add no re-export in `auth.ts`** (A3 row 1) — T-12 deletes the original.
- **Validation happens on READ, not at creation** — this is what keeps `auth.test.ts:33-56` green (it builds the connection with a bad token and asserts rejection at `provider.getToken()`).
- `readPlexCredentialCell` checks **origin first, then credential**.
- `rotatePlexCredentialCell` throws `TypeError` for a **static cell**, a foreign origin, or an invalid new credential. (T-19/A5.3 depends on this contract: the enrolled branch must build a **rotating** cell.)

**Test = T2**, exactly design §10 T2: foreign-origin release throws **before any fetch**; static cell refuses rotation; rotation validates; `inspect(error)` and `JSON.stringify(cell)` contain neither the old nor the new credential. Use `describe("… security", …)` naming (`client.test.ts:43` convention).

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/adapters/plex/credential-cell.test.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/adapters/plex/credential-cell)')
```

**~140 lines** + ~120 test.

---

#### T-08 — leaf type edits

**Owns:** `packages/rfmedia-cli/src/types/media-server.ts`, `packages/rfmedia-cli/src/lib/plan.ts`, `packages/rfmedia-cli/src/types/config.ts`, `packages/rfmedia-cli/src/types/index.ts`.

**Depends on:** none.

**Spec.** Four surgical, independent edits.

1. `src/types/media-server.ts:284-291` — add `readonly retryAfterSeconds?: number;` to `MediaServerErrorOptions`; assign it in `MediaServerError`'s constructor (`:307-314`) as a public readonly field. Safe under absent `exactOptionalPropertyTypes` (A1.4).
2. `src/lib/plan.ts:355` — `FORBIDDEN_KEYS` gains `"plexJwt"`, `"plexCredential"`, `"privateKey"`. **This line only. No other edit to `plan.ts`** (the file is 1642 lines and hosts the package's only `.snap`).
3. `src/types/config.ts` — add `PlexAuthConfigOptions` (design **§4 block 9**) and `auth?: PlexAuthConfigOptions;` to `PlexConfigOptions` (`:252-281`). **Fields are mutable, NOT `readonly`** — `validatePlexConfigOptions` (`config.ts:1097-1101`) builds `const config: PlexConfigOptions = {}` and assigns by mutation.
4. **`src/types/index.ts` (A6.3)** — add `PlexAuthConfigOptions` to the **named** `export type { … } from "./config.js"` block (`:96-124`). It is not an `export *`, so the type will not surface from the barrel otherwise. **+1 line.**

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/plan.test.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/types/media-server\.ts|src/types/config\.ts|src/types/index\.ts|src/lib/plan\.ts)')
```

**~23 lines.**

---

#### T-09 — architecture gate registration

**Owns:** `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`.

**Depends on:** none.

**Spec.** **+2 lines** (A1.2): add `const PLEX_ENROLLMENT_FETCH_OWNER = "src/lib/adapters/plex/enrollment-client.ts";` beside the constants at `:15-19`, and `[PLEX_ENROLLMENT_FETCH_OWNER, { countRule: "plex-enrollment-fetch-owner-count", alwaysRequired: false }]` to `FETCH_OWNERS` (`:123-127`). **`alwaysRequired: false`** so trees predating the module are not tripped.

**Do not** widen `PRIVATE_PLEX_COMPOSER` (D8), **do not** touch `check-direct-plex-imports.test.mjs`, and **do not** add anything to `PLEX_COMPATIBILITY_ALLOWLIST`. The façade (A1.1) makes all three unnecessary.

**Discriminating verification (A6.11)** — the entry is a no-op while the owner file is absent, so a typo'd path would pass silently. Required sequence:

1. Write a throwaway stub at exactly `src/lib/adapters/plex/enrollment-client.ts` containing one `fetch(` call and nothing else meaningful.
2. `npm run check:architecture` ⇒ passes and the owner is recognized.
3. Add a second `fetch(` to the stub ⇒ `npm run check:architecture` **fails** with `plex-enrollment-fetch-owner-count`.
4. **Delete the stub.** Confirm `git status --porcelain` shows no `enrollment-client.ts`.

(These three gate runs are unscoped; run them only while no other batch-0 task is mid-edit, or accept unrelated noise and grep for the `plex-enrollment-fetch-owner-count` rule name specifically.)

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && npm run test:architecture \
  && git -C . status --porcelain | grep -q 'enrollment-client.ts' && echo "STUB LEAKED - FAIL" || echo "stub removed"
```

**+2 lines.**

---

#### T-10 — all three completion templates + `templates.spec.ts`

**Owns:** `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`, `.../zsh.ts`, `.../fish.ts`, `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`.

**Depends on:** none.

**Spec.** Read design §8, then apply **every** correction in **A2**. Completions must be **100% static** — no dynamic candidate helper, no config read, no store read, no shell-out (`templates.spec.ts:486` stubs `fetch` and spies the three adapter factories).

**Canonical option-description table — the SINGLE source of truth for all three templates, the new test, and T-23's help text:**

| Flag              | Description                                                                     | Arg                 |
| ----------------- | ------------------------------------------------------------------------------- | ------------------- |
| `--plex-url`      | `Plex server URL (overrides config)`                                            | url                 |
| `--device-name`   | `Device label shown in your Plex account`                                       | name (`-r` in fish) |
| `--timeout`       | `Authorization timeout in seconds`                                              | `60 120 300 900`    |
| `--force`         | `Rotate now even if the credential is fresh (does not bypass Plex rate limits)` | —                   |
| `-y, --yes`       | `Skip confirmation prompt`                                                      | —                   |
| subcommand `auth` | `Manage Plex account authorization`                                             | —                   |
| `login`           | `Enroll this device with your Plex account`                                     | —                   |
| `status`          | `Show enrollment and credential status`                                         | —                   |
| `refresh`         | `Rotate the stored credential`                                                  | —                   |
| `logout`          | `Remove local enrollment material`                                              | —                   |

**bash.ts:** (1) `:88` → append `auth` **last**. (2) new vars beside the `:88-114` block, exactly design §8 item 2. (3) `:203` — add `auth` to the second-level alternation. (4) **`:270`** — add **`|status|login|refresh|logout`** (`status` is **NOT** present — A2). (5) new `elif [[ "$subcmd" == "auth" ]]` branch before `:897`, modelled on the `sync)` branch at **`833-864`** (three leaves), **omitting** its `_filedir -d` fallbacks. (6) `:349` — add `--device-name` to the string-argument `case "$prev"` arm. (7) **`:208`** — add `&& -z "$subcmd"` to the plex arm, matching the guarded lidarr arm at **`:210`**.

**zsh.ts:** (1) append `'auth:Manage Plex account authorization'` after `:904` in `plex_subcmds` (`:897-905`). (2) new `auth)` arm in `case $line[1]`, modelled on the plex **`sync)` arm at `:1186-1244`** (**not** 1346-1360). The array **must** be named **`auth_subcmds`** (`templates.spec.ts:478` derives `${command}_subcmds`) and **must** be emitted **after** the `plex)` case arm (`extractZshCandidates` slices from `script.indexOf("        plex)")`). (3) leaf `_arguments` blocks in the **`collection delete)` shape at `:1345-1353`**, dropping the trailing positional, `${globalOpts}` last.

**fish.ts:** (1) `__fish_rfmedia_plex_auth_needs_subcommand` (`-eq 3`, `cmd[3] = auth`) copying **`:706-715`**; four `-ge 4` leaf predicates named exactly `__fish_rfmedia_plex_auth_{login,status,refresh,logout}_active`, pattern at `:765-775`. (2) append the `auth` subcommand line at **`:782`** (after `:777-781`) — **last**, to preserve tree order. (3) **MANDATORY (A6.2)** — emit the four leaf candidate lines, **in this order**:

```
complete -c rfmedia -n "__fish_rfmedia_plex_auth_needs_subcommand" -a "login"   -d "Enroll this device with your Plex account"
complete -c rfmedia -n "__fish_rfmedia_plex_auth_needs_subcommand" -a "status"  -d "Show enrollment and credential status"
complete -c rfmedia -n "__fish_rfmedia_plex_auth_needs_subcommand" -a "refresh" -d "Rotate the stored credential"
complete -c rfmedia -n "__fish_rfmedia_plex_auth_needs_subcommand" -a "logout"  -d "Remove local enrollment material"
```

Verified: `extractFishConditionCandidates` (`templates.spec.ts:430-436`) filters every line containing `-n "<condition>"`, reads `-a "…"`, and the tree assertion compares the resulting array **in order**. (4) leaf option lines in the **`:912-914`** style.

**`templates.spec.ts`:** `:35` → `plex: ["query","copy","playlist","collection","sync","auth"]` (**append last** — `:471` asserts exact, **order-sensitive** array equality across all three shells). Add `auth: ["login","status","refresh","logout"]` after `:40`. Add **exactly one** new case in the `:1404` style: a typed-option lock covering all three shells' auth leaf flags, using the description table above verbatim.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/shell-completions/templates.spec.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/shell-completions/)')
```

Run the spec after **each** template edit, not once at the end.
**~150 lines** across four files.

---

#### T-11 — file the four follow-up child issues

**Owns:** no files (GitHub only).

**Depends on:** none. **Blocks:** T-25, T-26 (both embed issue numbers).

**Spec.** File four issues on `yandy-r/rfmedia-apps` as children of #251, using the **YAML forms** in `.github/ISSUE_TEMPLATE/` (never `--title`-only; if `gh issue create --template` fails, use the GitHub API with a body mirroring the form fields, then apply labels from the repo's existing taxonomy):

1. **enhancement** — _Plex device revocation endpoint (blocked: no documented client-callable API)_.
2. **enhancement** — _Per-server `accessToken` exchange via `GET /api/v2/resources` (implement only if U6 proves false)_.
3. **chore** — _Migrate duplicate private-file-mode primitives onto `src/lib/secure-store`_ — listing **four** sites: `plan.ts:67-68`, `lidarr/plan-engine.ts:189-190`, `filesystem.ts:533` (inline `0o600` literal), **`lidarr/profile-preset-persistence.ts:20-21, 146-273, 745-948`** (A3 row 4).
4. **chore** — _`validatePlexConfigOptions` silently drops three declared fields_ — `pageSize` (`types/config.ts:266`), `syncRatingsOnCopy` (`:278`), `syncOnCopyDefaults` (`:280`); all three return **0** `grep` matches in `src/lib/config.ts`.

Optionally also file the `plex/types.ts` split (`refactor`) named in design §2.

**Acceptance:** four issue URLs reported back; each renders the form's sections.

---

### BATCH 1 — core plex modules (barrier: all of BATCH 0)

---

#### T-12 — `plex/types.ts` + `plex/auth.ts` (credential rebinding + seam widening)

**Owns:** `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`, `packages/rfmedia-cli/src/lib/adapters/plex/auth.ts`.

**Depends on:** T-07.

**Spec.** Implement design §3's `types.ts` and `auth.ts` rows plus **§4 block 2**.

`types.ts`:

- `credentialBindings` (`:87`) becomes `WeakMap<PlexConnectionSettings, PlexCredentialCell>`; the write site at `:155` stores a cell.
- **`getPlexConnectionToken` (`:167-179`) keeps its EXACT exported signature and BOTH error message literals byte-for-byte** — `"Plex connection credential is unavailable"` (`:173`) and `"Plex credential cannot be used for a different origin"` (`:176`) — and delegates the origin+credential check to `readPlexCredentialCell`. This is **D2 (c)**: both providers terminate at the same guard, so #119's SEC-001 cannot evaporate.
- Additive **`createPlexRotatingConnectionSettings`** (consumed by T-19 per **A5.3**).
- `PlexRequestInput` (`:41-45`) gains `readonly replayable?: boolean` **at the top level**, not inside `PlexRequestOptions` — several read sites omit `options` entirely (`playlists.ts:159`).
- **`types.test.ts` must stay green with ZERO edits.**

`auth.ts`:

- Add `PlexCredentialRequestOptions { readonly signal?: AbortSignal }`; widen `getToken(options?)` and `handleAuthFailure(status, options?)`. **`status` stays the first positional parameter** (`auth.test.ts:69-78` passes one positional arg and asserts `expectTypeOf(...).toEqualTypeOf<"fail">()`). A method with fewer params is assignable to one with a trailing optional param, so `client.test.ts:374-377`, `:146-150`, `:403-406` and `auth.test.ts:30` all still compile.
- **Delete** the now-duplicate private `validateOpaqueCredential` (`:26-34`). **Add no re-export** (A3 row 1). `StaticPlexTokenProvider.getToken` (`:61-64`) must **not** call it — `readPlexCredentialCell` already validates on read.
- `StaticPlexTokenProvider` behaviour stays **byte-identical**; `handleAuthFailure` still returns `"fail"`.
- Repoint the `#251` JSDoc at `:69` to `jwt-provider.ts`.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/adapters/plex/types.test.ts src/lib/adapters/plex/auth.test.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/adapters/plex/types\.ts|src/lib/adapters/plex/auth\.ts)')
```

Both suites must pass with **zero edits to those test files** — that is the AC-7 proof. **HARD ABORT if either test needs a change** (see H3).
**~55 lines net.**

---

#### T-13 — `plex/credential-store.ts` + T4 test

**Owns:** `packages/rfmedia-cli/src/lib/adapters/plex/credential-store.ts`, `packages/rfmedia-cli/src/lib/adapters/plex/credential-store.test.ts` (both new).

**Depends on:** T-01, T-05, T-06.

**Spec.** Implement design **§4 block 5** in full, plus design §5 stages 4-5 and §6 layer 3.

- Store path resolution: **`RFMEDIA_PLEX_AUTH_DIR`** → `plex.auth.storePath` → `~/.config/rfmedia/plex-auth/store.json`. XDG-only, **no legacy `~/.rfmedia` fallback** — mirror `getDefaultPlanDir` (`plan.ts:121-122`).
- **All FS work routes through `src/lib/secure-store/`** (T-01). Do not reimplement any check.
- `loadPlexAuthStoreSync` — bounded **8 KiB**, `O_NOFOLLOW`, `{dev,ino}` re-assert. Secrets (`privateKeyPkcs8Pem`, credential) are **stripped into a module-private `WeakMap` keyed by the returned handle at parse time**; the raw document is never embedded and never an enumerable property. Returns `undefined` when no store file exists.
- `plexAuthStoreExistsSync` — cheap existence probe (used by A4.10's gate ordering and by T-22).
- `withPlexAuthStoreLock` — **`mutate` receives the state RE-READ under the lock** (A4.3). The version CAS compares the re-read version against disk immediately before `rename`. Callers acquire the lock **before** any network call (design §6 "Refresh-token single-use hazard").
- Schema additions: `lastObservedSkewSeconds: number | null` (A4.13); handle exposes `lockPath` (A4.4).
- All six `PlexStoreMutation` variants. **The nonce appears in no variant** — it is never persisted.
- Errors are `PlexAuthError` (T-06); map `SecureStoreErrorCode → PlexAuthErrorCode` 1:1, with **`SECURE_STORE_LOCK_BUSY → PLEX_AUTH_REFRESH_BUSY`** (A6.5).
- **`PlexCredentialState` has NO `{kind:"absent"}` variant** (A6.6) — it is unreachable by construction because a handle only exists after a successful parse.

**Test = T4**, design §10 T4's six assertions **plus a seventh moved here from T3(b) (A6.16)**: two store handles over one temp file; the writer holding `v7` while disk holds `v8` is rejected with `PLEX_AUTH_STORE_VERSION_CONFLICT` and the file still holds `v8`. Use `tmpdir()` + `RFMEDIA_PLEX_AUTH_DIR`.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/adapters/plex/credential-store.test.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/adapters/plex/credential-store)')
```

**~340 lines** + ~200 test.

---

#### T-14 — `plex/enrollment-client.ts` (the sole new `fetch` owner)

**Owns:** `packages/rfmedia-cli/src/lib/adapters/plex/enrollment-client.ts` (new).

**Depends on:** T-02, T-03, T-05, T-06.

**Spec.** Implement design **§4 block 4b** (`PlexAccountProtocol`, `PlexNonceIssue`).

**Hard constraints:**

- **Exactly ONE `fetch(`/`trustedFetch(` textual occurrence in the entire file**, in a private `#send`. `FETCH_CALL_PATTERN` is textual and matches comments and string literals — **never write `fetch(` in a JSDoc example** (A1.2).
- Origin is the **module constant** `PLEX_ACCOUNT_ORIGIN` from `jwt-wire.ts` — **never caller-supplied**.
- **This module never receives the PMS credential.**
- **All wire knowledge is delegated to `jwt-wire.ts`** (D18). No response-shape logic here. Claims are built from `PlexAssertionInput` (A6.1).
- `redirect: "error"`, bounded body via `readBoundedBody` (T-03), abort composition via `composeAbortSignals` (T-03), message sanitization via the array-signature `sanitizeMessage` (A5.2).
- Headers sent to plex.tv: `X-Plex-Client-Identifier`, `X-Plex-Product: rfmedia-cli`, `X-Plex-Device-Name`. **These never touch the PMS** (D5).
- `Retry-After` via `parseRetryAfter` (T-02): `≤ PLEX_RETRY_AFTER_WAIT_CAP_SECONDS (15)` ⇒ **one bounded, cancellable wait + one retry** inside the attempt loop; above that ⇒ throw `PLEX_AUTH_RATE_LIMITED` with `retryAfterSeconds` (the caller persists the cooperative window under its held lock).
- `PlexNonceIssue.receivedAtEpochSeconds` from the response's **HTTP `Date` header**, falling back to the local clock (D19).
- The three optional members (`registerJwkWithLegacyToken?`, `revokeDevice?`, `exchangeServerAccessToken?`) are **DECLARED AND DELIBERATELY UNIMPLEMENTED** so each deferral is visible to the compiler. JSDoc each with its reason.
- `fetch` is injectable via a dependency parameter so callers' tests stay deterministic.

**Acceptance (this is where the gate assertion from A6.11 becomes discriminating):**

```bash
cd packages/rfmedia-cli \
  && test "$(grep -cE '\b(fetch|trustedFetch)\s*\(' src/lib/adapters/plex/enrollment-client.ts)" = "1" \
  && ! (npm run check:architecture 2>&1 | grep -E 'enrollment-client') \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/adapters/plex/enrollment-client\.ts)')
```

**~210 lines.**

---

#### T-15 — `config.ts` validator + sensitive names

**Owns:** `packages/rfmedia-cli/src/lib/config.ts`, `packages/rfmedia-cli/src/lib/config.test.ts`.

**Depends on:** T-08.

**Spec.**

1. `SENSITIVE_FIELD_NAMES` (`:141-149`) gains `"privatekey"`, `"jwt"`, `"nonce"`, **`"pincode"`**, `"credential"`, `"devicejwt"`. **NOT bare `"pin"`** and **NOT bare `"key"`** — `isSensitiveFieldName` (`:151-157`) uses `lowerKey.includes(...)`, so `"pin"` matches `mapping`/`pinned`/`spinner`/`shipping` and `"key"` matches `keyword` (D15).
2. **Mandatory** `plex.auth` branch in `validatePlexConfigOptions` (`:1097-1234`), validating `mode` (`"static"|"jwt"`), `storePath` (string, tilde-expanded), `deviceName` (string), `refreshMarginSeconds` (integer, **min 60, max 86_400, default 300**). Without this branch the block is silently dropped — the verified three-field precedent (A3 row 6).
3. **Do NOT touch `buildConfigTemplate` (`:4089-4197`) — A4.14.**
4. `config.test.ts` — `plex.auth` round-trips through the validator; each field's bounds; the `mode: "jwt"` **+** `plex.token` combination is **retained at load time** (the conflict is raised at _use_ time as `ambiguous-credential`, asserted in T1). Deliberately **not** a `ConfigError`: `loadConfig` warns and falls through to the **next search path** on `ConfigError` (`:4063-4066`), which could silently select a different config file with different credentials.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/config.test.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/config\.ts)')
```

**~55 lines** + ~60 test.

---

### BATCH 2 — transport, provider, use-cases (barrier: BATCH 1)

---

#### T-16 — `plex/client.ts` + `query-library.ts` + T6

**Owns:** `packages/rfmedia-cli/src/lib/adapters/plex/client.ts`, `packages/rfmedia-cli/src/lib/adapters/plex/client.test.ts`, `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`.

**Depends on:** T-02, T-03, T-08, T-12.

**Spec.** Five coupled changes to `client.ts` (single owner by design — D2).

1. **Delete** `BodyLimitError` (`:52-54`), `isAborted` (`:68-70`), `callerAbortReason` (`:72-74`), `sanitizeMessage` (`:76-89`), `composeAbortSignals` (`:169-200`), `readBoundedBody` (`:202-235`); import them from `./http.js` (T-03). **Update BOTH `sanitizeMessage` call sites to the array signature (A5.2):** `configurationError` (`:106-108`, currently `sanitizeMessage(error, token)`) and `#throwAttemptError` (`:475`, currently `sanitizeMessage(error, attempt.token)`) both become `sanitizeMessage(error, token === undefined ? [] : [token])` / `sanitizeMessage(error, attempt.token === undefined ? [] : [attempt.token])`. A bare `string` argument is now a compile error — that is the point.
2. **Widen the local `mediaServerError` helper** (`:91-104`) with `readonly retryAfterSeconds?: number` and forward it to `new MediaServerError(...)` — **required, or §7's snippet is TS2353** (A1.4).
3. `#getToken` (`:356-366`) gains a `signal` parameter and becomes **selective** per design §7: rethrow `MediaServerError` untouched; otherwise collapse to `mediaServerError(operation, "configuration", "Plex credential is unavailable or invalid")`. Update the call site at **`:337`** to `this.#getToken(input.operation, callerSignal)`. Pass `{ signal }` to `getToken` at `:358`.
4. `#handleNonSuccess` (`:407-435`): read `parseRetryAfter(response.headers.get("retry-after"))` — the **first** response-header read in this file — and attach it via the widened helper.
5. **Rename `isRead` → `replayable` at ALL EIGHT verified occurrences (A6.7):** declaration `:41`, computation `:329`, attempt construction `:342`, retry gate `:420`, advisory flag `:433`, timeout flag in `#parseSuccessBody` `:448`, timeout flag in `#throwAttemptError` `:473`, network flag `:485`. They move in lockstep — a GET marked `replayable: false` must not be advertised as `retryable` on timeout or network failure either. Pass `{ signal: attempt.callerSignal }` to `handleAuthFailure`. **The transport never sleeps** — the 2-attempt loop exists for auth recovery only.
6. `attempt.replayable` default is **`input.replayable ?? (method === "GET")`** — **NOT** `=== true`. Verified: `playlists.ts:159` omits `options` entirely and `playlists.ts:171`, `collections.ts:104/123/183` omit `method`; any other default silently disables auth retry for the whole collection/playlist read family.

**`client.ts:387`'s header object and `buildRequestUrl` (incl. the `serializedValue === token` guard at `:160`) are UNTOUCHED.**

`query-library.ts`: add `replayable: false` to the **three** scan triggers at **`:615-619`, `:627-631`, `:644-648`**. Verified complete — a full sweep of every `transport.request` call found no other GET-transported mutation.

**Test = T6** appended to `client.test.ts`: a GET marked `replayable: false` gets exactly one fetch, never consults `handleAuthFailure`, and throws with `retryable: false`; a normal GET still retries at most once with the rotated credential. **`:70-73`, `:163`, `:372-397`, `:400-427` must stay byte-identical** (the POST/PUT/DELETE `it.each` block is **`400-427`**).

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/adapters/plex/client.test.ts src/lib/adapters/plex/query-library.test.ts src/lib/adapters/plex/playlists.test.ts src/lib/adapters/plex/collections.test.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/adapters/plex/client|src/lib/adapters/plex/query-library)')
```

(The playlists/collections suites are the detector for a wrong `replayable` default — H8.)
`client.ts` should land near **~350-420** lines; do not chase the design's "~420" arithmetic.
**~45 lines net changed** + ~90 test.

---

#### T-17 — `plex/jwt-provider.ts` + T3 + T5

**Owns:** `packages/rfmedia-cli/src/lib/adapters/plex/jwt-provider.ts`, `packages/rfmedia-cli/src/lib/adapters/plex/jwt-provider.test.ts` (both new).

**Depends on:** T-06, T-07, T-12, T-13, T-14.

**Spec.** `PlexJwtTokenProvider implements PlexTokenProvider`, per design §5 stages 6-9, §6 layers 1-2, §7.

- **Constructor signature is PINNED by A5.4** (T-19 constructs exactly this):

  ```ts
  new PlexJwtTokenProvider(
    connection: PlexConnectionSettings,
    options: {
      readonly storePath: string;
      readonly refreshMarginSeconds: number;
      readonly deviceName?: string;
      readonly now?: () => number;
      readonly account?: PlexAccountProtocol;
    },
  )
  ```

  `account` defaults to the real enrollment client; `now` defaults to `Date.now`.

- **Layer 1 in-process single-flight:** module-private `Map<storePath, Promise<string>>`; N concurrent `getToken()` calls on expired state await **one** promise, cleared in `finally`.
- **Freshness:** `expiresAt = issuedAt + lifetimeSeconds`; 60 s skew tolerance; refresh proactively at `≤ refreshMarginSeconds` (default 300) **before** returning.
- **Cross-process:** acquire the store lock (T-13) **before** the nonce request. **Adoption predicate is A4.2** — `fresh` **AND** `refreshNotBefore <= now`, never version-advance. Expired-but-backed-off ⇒ `PLEX_AUTH_RATE_LIMITED` with the peer's remaining wait, **zero network calls**.
- **Nonce hygiene:** function-local `const`, never persisted; if `now - receivedAt > PLEX_NONCE_MAX_AGE_SECONDS (300)`, **re-fetch rather than sign**.
- **429:** `≤15 s` handled inside the enrollment client; above that persist `back-off` **under the already-held lock** and throw.
- **`handleAuthFailure`:** bypasses the freshness gate, **capped at `PLEX_MAX_REACTIVE_REFRESHES_PER_PROCESS = 2` per process per storePath** (A4.12); beyond the cap return `"fail"` with no network call.
- **Cancellation:** `signal` threads to the enrollment client and the lock-wait deadline; aborted refresh releases the lock in `finally` and throws `PLEX_AUTH_CANCELLED`. Budget `min(callerDeadline, --timeout, 60 s)`.
- **Clock skew** (design §5.8): `detectClockSkew` on any successful response; beyond ±300 s `logWarn` **once per process** and persist `lastObservedSkewSeconds`; if a refresh succeeds and the new credential immediately reads expired, emit `PLEX_AUTH_CLOCK_SKEW` — never "token expired".
- Maps `PlexAuthError → MediaServerError` itself and **never attaches `cause`** — this keeps `client.test.ts:163` (`cause === undefined`) green.
- After refresh, calls `rotatePlexCredentialCell` so both providers keep terminating at `getPlexConnectionToken`. (Requires the connection to be rotating — T-19/A5.3.)

**Test = T3 + T5 in one file.**

- **T3:** (a) `Promise.all` of three 401ing reads ⇒ exactly **one** refresh fetch, all three observe the same new credential; (b) **moved to T-13 (A6.16) — do not implement version-conflict here**; (c) a loser whose peer's write lands mid-wait **adopts it with zero refresh fetches**; (d) clock boundaries `-30 s → refresh-soon`, `-90 s → expired`; (e) **negative adoption (H10)**: a peer wrote a `back-off` mutation (version advanced, credential still expired) ⇒ the loser throws `PLEX_AUTH_RATE_LIMITED` and does **not** adopt.
- **T5** in a `describe("… security", …)`: five distinctive sentinels (PKCS8 PEM body, JWT, PIN code, nonce, device assertion) driven through enroll → issue → expire → refresh → fail, each asserted absent from `String(url)`, `inspect(error)`, `JSON.stringify(provider)`, `JSON.stringify(toPlexConnectionLogContext(conn))`, every recorded cache key, and the `plex auth status` envelope. **Plus: after rotation, the PREVIOUS JWT is still redacted.** **`JSON.stringify(adapter)` is NOT asserted here — it moved to T-20's T1 (A6.18).**
- **One case for `PLEX_AUTH_CANCELLED`** and **one for the 300 s nonce-staleness re-fetch**.
- **One case for clock skew (A6.17):** a refresh that succeeds but whose new credential immediately reads expired emits `PLEX_AUTH_CLOCK_SKEW`, not a token-expired error.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/adapters/plex/jwt-provider.test.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/adapters/plex/jwt-provider)')
```

**~290 lines** + ~340 test.

---

#### T-18 — `plex/enrollment.ts` (four use-cases + PMS probe) + enrollment test

**Owns:** `packages/rfmedia-cli/src/lib/adapters/plex/enrollment.ts` (new), `packages/rfmedia-cli/src/lib/adapters/plex/enrollment.test.ts` (new).

**Depends on:** T-00, T-04, T-05, T-06, T-12, T-13, T-14.

**Spec.** `enrollPlexClient`, `readPlexAuthStatus`, `refreshPlexCredential`, `forgetPlexEnrollment` — design §5 stages 1-4 and 10.

- **Enroll:** fresh Ed25519 key pair + fresh UUIDv4 `clientIdentifier` per `login` (never rotated in place — U5/Risk 11). `POST /api/v2/pins {jwk, strong:true}`. The 25-char code and the `https://app.plex.tv/auth#?clientID=…&code=…` link go to **stderr only** — never stdout, never a log file, never a JSON envelope — length-bounded (code ≤64, link ≤512) and **bidi-stripped** before printing.
- **Poll:** `GET /api/v2/pins/<id>?deviceJWT=…` at 1 s, bounded by `min(expiresIn, --timeout)`. `authToken === null` is **pending, not an error**. `404 code 1020` ⇒ `PLEX_AUTH_ENROLLMENT_EXPIRED`. Cancellable sleep, never a busy loop. **Nothing is written to disk until a token exists.**
- **Probe (this is how U6 is answered):** per A3 row 10, call the transport directly — `request<unknown>({ path: "/", operation: "verify Plex enrollment", options: { method: "GET", signal } })` — and validate with `isPlexWireServerResponse` (`plex/types.ts:645`) to read `machineIdentifier`. **Wire it with `createStaticPlexCredentialCell` + `StaticPlexTokenProvider`, never the rotating provider (A4.6).** On 401/403/422 ⇒ `PLEX_AUTH_PMS_REJECTED`, credential **discarded**, nothing persisted, and the error names the deferred `exchangeServerAccessToken?()` / `/api/v2/resources` seam as the known remedy. **On network failure ⇒ `PLEX_AUTH_UNREACHABLE`, credential discarded (A4.5).**
- **Origin resolution goes AROUND `buildPlexAdapterConfiguration`** (A4.7) — normalize `--plex-url ?? plex.url` using **`normalizePlexOrigin` imported from `../../plex-origin.js`** (T-00). **Never duplicate the function** (A5.1).
- **Claims:** build a `PlexAssertionInput` (A6.1) and hand it to `jwt-wire.ts`. Never hand-build claim objects.
- **Store:** single locked CAS write of `{enroll, issue, authorize-origin}`, `version → 1`.
- **422/1097 disambiguation is a call-site parameter** (A4.11): `enrollPlexClient` ⇒ `PLEX_AUTH_NOT_ENROLLED`; `refreshPlexCredential` ⇒ `PLEX_AUTH_KEY_REJECTED`.
- **`forgetPlexEnrollment`:** take the lock, `unlink`, `fsync` the directory, return `removedOrigins`, `keyDestroyed: true`, **`serverSideRevocation: "manual"`**, and the Authorized-Devices URL. **Never faked as a server call.**
- **`readPlexAuthStatus` makes NO network call** (A4.13); `clockSkewSeconds` comes from the persisted `lastObservedSkewSeconds` or is `null`; when `loadPlexAuthStoreSync` returns `undefined` it returns `{ enrolled: false }` (A6.6).

**Test (A6.15) — `enrollment.test.ts`, exactly 3 cases**, with an injected `PlexAccountProtocol` (fake wire client), an injected PMS transport, and `RFMEDIA_PLEX_AUTH_DIR` pointed at `tmpdir()`:

1. Claimed PIN + probe 200 ⇒ exactly **one** store write, `version === 1`, mutations exactly `{enroll, issue, authorize-origin}`.
2. Probe 401 ⇒ throws `PLEX_AUTH_PMS_REJECTED` **and the store file does not exist** on disk.
3. `forgetPlexEnrollment` ⇒ store file unlinked; result carries `serverSideRevocation: "manual"` and the Authorized-Devices URL.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/adapters/plex/enrollment.test.ts \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/adapters/plex/enrollment)')
```

**~240 lines** + ~130 test.

---

### BATCH 3 — the façade (barrier: BATCH 2). **Single task — this is the critical path.**

---

#### T-19 — `plex-adapter.ts`: credential union, provider selection, and the mandatory re-export façade

**Owns:** `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`.

**Depends on:** T-12, T-13, T-17, T-18.

**Spec.** This file is the **sole `PRIVATE_PLEX_COMPOSER`** (`check-direct-plex-imports.mjs:14`) and therefore the **only** module outside `src/lib/adapters/plex/` permitted to import from it. **A1.1 makes this task load-bearing for the entire build.**

1. **Keep `PLEX_CLIENT_IDENTIFIER = "rfmedia-cli"` at `:17`** (A1.5) — do **not** delete it.
2. `PlexAdapterConfiguration` (`:61-68`): `token: string` → `readonly credential: PlexAdapterCredential`; add `readonly clientIdentifier?: string`. Per A1.6:

   ```ts
   export type PlexAdapterCredential =
     | { readonly kind: "static"; readonly token: string }
     | {
         readonly kind: "enrolled";
         readonly token: string;
         readonly storePath: string;
         readonly refreshMarginSeconds: number;
       };
   ```

   **It carries a resolved token, never a live `PlexAuthStoreHandle`.**

3. Constructor (`:94-105`) — **provider AND connection selection (A5.3):**
   - `kind: "static"` ⇒ `createPlexConnectionSettings(...)` + `StaticPlexTokenProvider`.
   - `kind: "enrolled"` ⇒ **`createPlexRotatingConnectionSettings(...)`** + `new PlexJwtTokenProvider(connection, { storePath, refreshMarginSeconds })` — the **exact A5.4 signature**. A static cell here would make `rotatePlexCredentialCell` throw `TypeError` on the first refresh.
   - Resolve `configuration.clientIdentifier ?? PLEX_CLIENT_IDENTIFIER` into whichever settings factory is used.
   - **`new PlexAdapter(...)` must not throw for credential reasons** — that contract belongs to `createOptionalMediaServerAdapter`.
4. Update the `:60` JSDoc — _"Resolved, validated settings consumed only while composing one Plex adapter"_ is no longer the whole truth once a rotating credential is involved.
5. **THE FAÇADE (A1.1).** Re-export, with JSDoc explaining that this is the architecture-gate boundary and that upper layers must import from here:
   - from `./plex/errors.js`: `PlexAuthError`, `type PlexAuthErrorCode`
   - from `./plex/credential-store.js`: `loadPlexAuthStoreSync`, `plexAuthStoreExistsSync`, `readStoredCredential`, `type PlexAuthStoreHandle`, `type PlexAuthStoreDependencies`, `type PlexCredentialState`, `type PlexAuthorizedOrigin`
   - from `./plex/enrollment.js`: `enrollPlexClient`, `readPlexAuthStatus`, `refreshPlexCredential`, `forgetPlexEnrollment`, and their result types
   - from `./plex/jwt-wire.js`: `PlexJwtWireError` (needed by the error formatter)

**Nothing outside `src/lib/adapters/plex/` may import `./plex/*` directly.** If a batch-4/5 consumer needs a symbol that is not re-exported, **reopen this task** — never add a direct import.

**Acceptance — includes the façade-completeness probe (A6.14).** Batch 3 is a single task, so the unscoped gate is safe to run here:

```bash
cd packages/rfmedia-cli
# 1. write src/lib/adapters/facade-probe.tmp.ts importing EVERY symbol from step 5 via ./plex-adapter.js
npm run check:architecture           # must report zero private-plex-import violations
npx tsc --noEmit                     # must be clean for the probe and plex-adapter.ts
rm src/lib/adapters/facade-probe.tmp.ts
git status --porcelain | grep -q 'facade-probe' && echo "PROBE LEAKED - FAIL" || echo "probe removed"
env -u FORCE_COLOR npx vitest run src/lib/adapters/plex-adapter.test.ts
```

**140 → ~300 lines.** **Abort criterion:** past 450 lines, trim the re-export list to what consumers actually use — do **not** create a second façade file (it would need its own gate exemption).

---

### BATCH 4 — resolver, action, consumers (barrier: T-19)

---

#### T-20 — `adapters/index.ts` precedence resolver + T1

**Owns:** `packages/rfmedia-cli/src/lib/adapters/index.ts`, `packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts`.

**Depends on:** T-00, T-15, T-19.

**Spec.** Implement design §9 "Precedence" (5 branches) and the resolver block.

- **Import ONLY from `./plex-adapter.js`** for plex symbols (A1.1). Any `./plex/*` import fails `check:architecture`.
- **Delete the module-private `normalizePlexOrigin` (`:45-64`) and import it from `../plex-origin.js`** (T-00 / A5.1). Both existing call sites (`:76`, `:83`) keep identical behaviour.
- **All four pinned message literals at `:26-32` are unchanged**, byte-for-byte.
- **The cross-origin guard block at `:81-87` keeps its EXACT condition and message** (D3): `overrides?.plexUrl !== undefined && overrides.plexToken === undefined` — a **presence** test on the raw override object, so it fires identically whether the credential would come from config or the store. Pinned by `plex-adapter.test.ts:424-426` and `mcp/adapters.spec.ts:672`; `src/mcp/adapters.ts:294-295, 385-386, 490-491` forwards `plexUrl` verbatim from untrusted MCP tool arguments.
- **Token-presence gate uses `!staticToken`, not `=== undefined`** (A4.10):

  ```ts
  const staticToken = overrides?.plexToken ?? loadedConfig.token;
  if (!rawUrl || (!staticToken && !plexAuthStoreExistsSync(storeDeps))) {
    return { ok: false, reason: "missing" };
  }
  ```

  Order is: presence gate → `normalizePlexOrigin` → cross-origin guard → **only then** credential selection.

- New reasons `ambiguous-credential` (mode `"jwt"` **and** `plex.token` both set) and `not-enrolled` (mode `"jwt"` with no enrollment for this origin — **never falls back**; a "try JWT, on 401 try static" chain is a credential-downgrade oracle).
- **Resolve the stored credential to a `string` HERE** (A1.6), where the `not-enrolled` reason already lives — so `createOptionalMediaServerAdapter` keeps its "return `undefined` + `logWarn`, never throw" contract.

**Test = T1** appended to `plex-adapter.test.ts`:

- table-driven over all six precedence outcomes plus `ambiguous-credential`;
- **`--plex-url <other-origin>` WITH a store credential present still resolves to `cross-origin-override`** — the repo's standing recorded `MEMORY.md` regression;
- **(A5.3)** an `enrolled` resolution produces a connection whose cell **accepts** `rotatePlexCredentialCell`, and a `static` resolution's cell **rejects** it with `TypeError`;
- **(A6.18)** `JSON.stringify(adapter)` contains none of the five secret sentinels (moved here from T5);
- **`RFMEDIA_PLEX_AUTH_DIR` must be set to a `tmpdir()` in `beforeEach`** so a developer's real store is never read — mandatory, not hygiene.
- Note A3 row 3: there are **no** `PlexAdapterConfiguration` construction sites in this file; `testConfig.token` at `:26` stays `token`.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/adapters/plex-adapter.test.ts src/mcp/adapters.spec.ts src/mcp/schema.spec.ts \
  && ! (npm run check:architecture 2>&1 | grep -E 'src/lib/adapters/index\.ts') \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/lib/adapters/index\.ts)')
```

Both MCP specs must pass **unmodified**.
**~75 lines** + ~150 test.

---

#### T-21 — `actions/plex-auth.ts`

**Owns:** `packages/rfmedia-cli/src/actions/plex-auth.ts` (new).

**Depends on:** T-00, T-19.

**Spec.** Framework-agnostic action layer for the four verbs (repo command/action separation). **Imports plex symbols ONLY from `../lib/adapters/plex-adapter.js`** (A1.1). **Must not** import `src/types/plex*` — `PLEX_COMPATIBILITY_ALLOWLIST` (`check-direct-plex-imports.mjs:134-146`) does not list this file, and it must not be added.

- **Output boundary (A6.10):** each verb **returns a typed result object or throws**. The action **never writes to stdout** and **never sets `process.exitCode`**. It also **exports the failure-envelope builder** (`buildPlexAuthFailureEnvelope(verb, error)`) that the command calls.
- **Origin normalization** uses `normalizePlexOrigin` from `../lib/plex-origin.js` (T-00 / A5.1), going **around** `buildPlexAdapterConfiguration` (A4.7).
- **ALL validation lives inside the action, never in a Commander `argParser`** — an `InvalidArgumentError` thrown from a parser routes through `Command.error()` → `process.exit(1)` **before `.action()` runs**, bypassing the failure envelope, redaction, and testability (recorded `MEMORY.md` lesson). `--timeout 0`, `--timeout abc`, and `--plex-url ""` (an unset CI var) must all fail **through the action**.
- Success shapes: design §8's four `{ command, result }` shapes verbatim.
- **Failure envelope (A4.9):** `{ command: "plex-auth-<verb>", error: { message, code, retryable, retryAfterSeconds, statusCode, remediation, diagnostics? } }`. Do **not** import `reportLidarrFailure` (module-private, hard-codes `lidarr-${subcommand}`). Apply `redactErrorMessage(error, sensitiveValues)` (`src/lib/redact-error-message.ts:7`).
- **No envelope ever contains** the credential, private key, PIN code, nonce, or device assertion. `kid` and `clientIdentifier` are non-secret. `observedKeys` appears **only** in `diagnostics` (and in text mode only under `--debug`), bounded per A4.8.
- Interactivity: mirror `assertInteractiveApplyApproval` (`src/commands/lidarr-mutation-presenter.ts:975`) — when `isMachineFormat(format) || !isInteractive()`, `login`-over-an-existing-enrollment and `logout` require `--yes` or throw `MissingRequiredArgumentError`. **`login` itself is not TTY-dependent** — it prints the link to stderr and polls, so it works headlessly under `--output json`. Poll countdown is a throttled `console.error` gated on `isInteractive() && !isMachineFormat(format)`; nothing in machine mode.
- `--force` on `refresh` means _"rotate now even though the credential is fresh"_; it **cannot** bypass a server-imposed rate limit. Under an active `refreshNotBefore`, throw `PLEX_AUTH_RATE_LIMITED` with the remaining wait (D10); the **command** turns that into exit code 1.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && ! (npm run check:architecture 2>&1 | grep -E 'src/actions/plex-auth\.ts') \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/actions/plex-auth\.ts)')
```

(Behavioural coverage is T-23's three cases plus T-13/T-17/T-18 — no `actions/plex-auth.test.ts`, per section E.)
**~280 lines.**

---

#### T-22 — `audit-plex.ts` readiness gate + error formatter

**Owns:** `packages/rfmedia-cli/src/actions/lidarr/audit-plex.ts`, `packages/rfmedia-cli/src/lib/error-formatters.ts`.

**Depends on:** T-19.

**Spec.**

1. `audit-plex.ts:100-111` — the gate reads `getLoadedPlexConfig()` + `overrides.plexToken` and reports `plex-not-configured` **before** the adapter is built at `:114`, so an enrolled-only install gets a **false negative for a working server**. Teach it about the enrolled source by calling `plexAuthStoreExistsSync` **via the façade** (`../../lib/adapters/plex-adapter.js`) — **not** `plex/credential-store.js` (A1.1). Also update the frozen literal at **`:22-23`** (`PLEX_NOT_CONFIGURED_DETAIL`), which becomes actively misleading. Verified safe: `src/lib/lidarr/audit.test.ts:482-486, 555-562` asserts only `skipReason`, never the detail.
2. `error-formatters.ts` — register a formatter for `PlexAuthError` so its `remediation` renders in text mode; without it the remediation is **silently dropped** in the default output mode. Import `PlexAuthError` **via the façade**. Follow the existing registry shape at `:36` (`registerRfmediaErrorFormatters`, called at `cli.ts:61`), matching `PlanArtifactError`/`MissingRequiredArgumentError`.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/lib/lidarr/audit.test.ts \
  && ! (npm run check:architecture 2>&1 | grep -E 'src/actions/lidarr/audit-plex\.ts|src/lib/error-formatters\.ts') \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/actions/lidarr/audit-plex\.ts|src/lib/error-formatters\.ts)')
```

**~25 lines.**

---

### BATCH 5 — command surface (barrier: T-21)

---

#### T-23 — `commands/plex-auth.ts` + registration + surface tests

**Owns:** `packages/rfmedia-cli/src/commands/plex-auth.ts` (new), `packages/rfmedia-cli/src/commands/plex-auth.test.ts` (new), `packages/rfmedia-cli/src/commands/plex.ts`, `packages/rfmedia-cli/src/commands/plex.test.ts`.

**Depends on:** T-21.

**Spec.** Commander group + four leaves, in a **separate module** (`commands/plex.ts` is 2545 lines, already over cap).

- Surface exactly design §8:

  ```
  plex auth login    [--plex-url <url>] [--device-name <name>] [--timeout <seconds>] [-y|--yes]
  plex auth status   [--plex-url <url>]
  plex auth refresh  [--plex-url <url>] [--timeout <seconds>] [--force]
  plex auth logout   [--plex-url <url>] [-y|--yes]
  ```

- **No secret-valued flag exists on this group** — no `--plex-token`, `--plex-jwt`, `--plex-pin`, `--plex-refresh-token`. `--plex-token` in `ps` and shell history is a known existing exposure (SEC-011); repeating it with private-key-backed material would be strictly worse. Every new flag is a **reference** (URL, name, seconds), never a value.
- **No `argParser` anywhere** — all validation delegates to the action (T-21).
- **Output boundary (A6.10):** the command calls the action, passes the success result to `formatOutput`, and on a thrown error calls the action's `buildPlexAuthFailureEnvelope`, prints it, and sets `process.exitCode = 1`. Matches `commands/plex.ts:219-222`.
- **Must not import `src/types/plex*` (A6.4)** — this file is **not** in `PLEX_COMPATIBILITY_ALLOWLIST` and must not be added; a violation is `plex-compatibility-import` and fails build and typecheck. Plex symbols come from `../lib/adapters/plex-adapter.js` only.
- Use the option-description strings from **T-10's canonical table** verbatim so help text and completions agree.
- `-y, --yes` on the two destructive verbs only, matching `plex collection delete` at **`plex.ts:2393`** (A2).
- No `--json` leaf flag — the global `--json`/`--output` is reconciled in `cli.ts`'s `preAction` (`:115`, reconciliation `:163-186`). `--output` is only honored when its source is `"cli"` on the **root** command, so `--output json` must precede `plex` — one doc line in T-24.
- **`login`'s help footer must carry the provisional label naming U1** verbatim: _"The JWT token endpoint's success response has not been observed against a live account; report `PLEX_AUTH_INVALID_RESPONSE` with `--debug` if enrollment fails."_
- **`refresh --force` help text**: _"Rotate now even if the credential is fresh (does not bypass Plex rate limits)."_
- Lazy-load the action handler (`const { … } = await import("../actions/plex-auth.js")`) per repo convention.
- `commands/plex.ts` — **exactly 2 lines**: one import + `plexCommand.addCommand(plexAuthCommand);` appended at `:2546`. **No `cli.ts` change is needed** — `cli.ts:211` already does `program.addCommand(plexCommand)`.
- `commands/plex.test.ts:413-420` — append `"auth"` to the hierarchy array after `:419`. (`expect(help).not.toContain("jwt")` at `:461` is scoped to `plex query run`'s help, so auth help may mention JWT freely.)
- **`commands/plex-auth.test.ts` (new, minimal — 3 cases):** (i) the four leaves exist with the expected option names; (ii) **no leaf registers an `argParser`** — the structural guarantee that validation reaches the action; (iii) `--timeout abc` and `--plex-url ""` reach the action and produce the failure envelope rather than `process.exit(1)`.

**Acceptance:**

```bash
cd packages/rfmedia-cli \
  && env -u FORCE_COLOR npx vitest run src/commands/plex.test.ts src/commands/plex-auth.test.ts \
  && ! (npm run check:architecture 2>&1 | grep -E 'src/commands/plex-auth\.ts|src/commands/plex\.ts') \
  && ! (npx tsc --noEmit 2>&1 | grep -E '^(src/commands/plex-auth\.ts|src/commands/plex\.ts)')
```

**~230 lines** + ~110 test.

---

### BATCH 6 — documentation & metadata (barrier: BATCH 5; T-25/T-26 also need T-11)

---

#### T-24 — user-facing documentation

**Owns:**

- `packages/rfmedia-cli/docs/features/media-server-adapter.md`
- `packages/rfmedia-cli/docs/features/plex-configuration.md`
- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/CLAUDE.md`
- `packages/rfmedia-cli/AGENTS.md`
- `/CLAUDE.md`, `/AGENTS.md` (repo root)
- `/docs/features/secrets-management.md`
- `/docs/README.md`
- `packages/rfmedia-cli/docs/features/lidarr-audit.md`

**Depends on:** T-20, T-23.

**Spec.** Design §3's module map lists zero user-facing doc changes, yet AC-7 requires a documented migration/rollback path and AC-9 requires docs for every user-facing addition. Highest priority first:

1. **`media-server-adapter.md:97` and `:148`** — verified stale-on-merge. They state that JWT enrollment, refresh, revocation and durable persistence _"are intentionally deferred to child issue #251"_ and that this layer _"adds no enrollment command, refresh setting, persistence key, or completion candidate"_. **Both become false the moment this PR lands.** Rewrite to describe the shipped lifecycle and the remaining deferrals.
2. **`plex-configuration.md`** — add a `plex.auth` block, the **5-branch precedence table**, migration steps (§9), rollback steps, `RFMEDIA_PLEX_AUTH_DIR`, the local-filesystem-only store limitation (A4.4), and the enroll-requires-a-reachable-PMS behaviour (A4.5).
3. **`README.md`** — `## Plex Integration` (~:3821), `### Finding Your Plex Token` (~:3856-3863, currently the **only** documented way to get a credential), `### CLI Options` (~:3874), and the `#### Plex Options (plex)` config table (~:4815-4826, add an `auth` row). Document `RFMEDIA_PLEX_AUTH_DIR` next to the `RFMEDIA_PLAN_DIR` precedent (~:992), and the `--output json` ordering note from T-23.
4. **`packages/rfmedia-cli/CLAUDE.md` AND `packages/rfmedia-cli/AGENTS.md`** — **verified NOT a symlink** (distinct md5, 147k vs 143k). **Every edit must be mirrored in both.** Update `## Plex Integration` (AGENTS.md at `:963`, YAML at `:974`/`:1637`, `--plex-token` at `:1002`/`:1168`), `### Configuration Options`, `### CLI Options`, `### Adding a New Command`, and `## Media Server Adapter Boundary` — the last must state the **façade rule (A1.1)** as permanent architecture.
5. **Root `/CLAUDE.md:216`** (`## Config File Secrets Injection`) and **root `/AGENTS.md:264-286`** (env-var table row + example) — add the _"or enroll with `rfmedia plex auth login`"_ alternative.
6. **`/docs/features/secrets-management.md`** (13 `PLEX_TOKEN` hits) — note that the JWT store is **not** `{{ VAR }}`-templated (`injectSecrets` runs on raw text pre-parse at `config.ts:4025`; no new secret-bearing config field is introduced) and lives out-of-band.
7. **`/docs/README.md:82-88`** — index any new feature doc.
8. **`lidarr-audit.md`** — the `plex-not-configured` readiness gate now recognizes enrollment (T-22).

Lower-priority stale "Plex URL and token are required" phrasing exists in `plex-playlist-export.md`, `smart-playlists.md`, `plex-collections.md`, `plex-metadata-sync.md`, `plex-api-caching.md`, `queue-command.doc.md` — fix only if cheap; note in the PR otherwise.

**Acceptance (A6.8 — `npm run format` is a no-target no-op):**

```bash
# from the REPO ROOT -- these scripts do not exist in the package
npm run format:all && npm run lint:md
```

**Note (A6.9):** edits under `packages/rfmedia-cli/**` **do** trigger the PR CI job (typecheck/tests, not `lint:md`).
**~450 doc lines.**

---

#### T-25 — ADR

**Owns:** `/docs/internal/plex-jwt-deferrals.md` (new — **new directory**, repo root per A4.16).

**Depends on:** T-11 (issue numbers).

**Spec.** ADR recording, with the follow-up issue numbers from T-11 embedded:

- The **five deferrals**: server-side revocation (no client-callable endpoint), enrollment Option 2 (destroys the legacy token — one-way), per-server `exchangeServerAccessToken`, RS256/`jose`, MCP enrollment arguments.
- **U1-U6** with the 2026-07-28 probe date, and **§15 Q2 = NO**: enrollment was never exercised end-to-end against a real account.
- **§15's four resolved decisions** verbatim, so the owner can overrule cheaply.
- Technical debt knowingly accepted: `secure-store` duplicates `profile-preset-persistence` primitives (§15 Q4); **three** silently-dropped `plex.*` config fields; `parseRetryAfter` has no HTTP-date support; **`exactOptionalPropertyTypes` is off and `retryAfterSeconds` depends on that** (A1.4).
- **The façade rule (A1.1)** as permanent architecture, and **`src/lib/plex-origin.ts` as the single origin-normalization authority** (A5.1).
- The decided spec gaps **A4.2, A4.4, A4.5, A4.7, A4.8, A4.9, A4.12** and the pinned contracts **A5.2 (array secrets), A5.4 (provider constructor), A6.1 (`PlexAssertionInput`), A6.6 (no `absent` variant)** with rationale.

Commit as **`docs(internal): …`**.
**~200 lines.**

---

#### T-26 — ROADMAP, archive, and design-doc lint fix

**Owns:** `/ROADMAP.md`, `/docs/roadmap-archive.md`, `/docs/plans/plex-jwt-251/design.md`.

**Depends on:** T-11, T-25.

**Spec.** Exact, verified line-numbered edits.

`/ROADMAP.md`:

| Line           | Now                                                                               | Required                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **8**          | `**Last updated:** 2026-07-27`                                                    | merge date                                                                                                                                                                                                            |
| **10**         | `**Open issues:** 85 (rfapps 40 · rfmedia 45)`                                    | recompute **both** the total and the rfmedia sub-count, accounting for the 4 issues T-11 **adds** and #251 closing                                                                                                    |
| **40**         | `(#251, #42, #125) and the rfapps follow-on backlog … can run in parallel.`       | drop `#251`; add design §9 item 2's shipped sentence, pointing at `docs/internal/plex-jwt-deferrals.md`                                                                                                               |
| **62-73**      | Sprint table                                                                      | delete row **68** (#251); renumber **69** (#42 → 1) and **70** (#125 → 2); rewrite **Exit criteria** at **72-73** to **drop "JWT lifecycle works end-to-end"** — required for honesty, since §15 Q2 leaves U1/U6 open |
| **173**        | backlog row                                                                       | delete                                                                                                                                                                                                                |
| **253**        | `shipped (#119); [#218], [#251]` … `JWT lifecycle and manager abstraction remain` | → `shipped (#119, #251); [#218]` … `Manager abstraction remains`                                                                                                                                                      |
| backlog tables | —                                                                                 | add the 4 new follow-up issues from T-11                                                                                                                                                                              |

`/docs/roadmap-archive.md`:

- `:6` `**Archived:** 2026-07-27` → merge date.
- `:22` — `Adapter boundary & Lidarr foundation` track row: add `#251` to Issues and the closing PR to PRs.
- **`:56-57` — stale on merge:** _"**Plex adapter (#119 / #252):** … JWT enrollment deferred to #251."_ Add an operator-note bullet in the `#159 / #273` style (`:48-55`) recording: local-only revocation, `serverSideRevocation: "manual"`, U1/U6 open, store must be on a local filesystem.
- `:106` — the numbered shipped list.

`/docs/plans/plex-jwt-251/design.md`: **fix the 3 MD031 errors at `:868`, `:874`, `:886`** (verified failing; `docs/plans` is **not** in `.markdownlint-cli2.jsonc`'s ignore list).

**Acceptance:**

```bash
# from the repo root
npm run format:all && npm run lint:md && npm run format:check
```

**~30 lines.**

---

## C. Sequencing rationale

1. **BATCH 0 is everything with no inbound type dependency** — twelve tasks run fully concurrently. The completion templates (T-10), the gate script (T-09), the leaf types (T-08), the origin extraction (T-00) and issue filing (T-11) have zero coupling to the credential machinery. `plex/http.ts` (T-03) and `src/lib/plex-origin.ts` (T-00) **create without deleting** precisely so they can land in batch 0; the deletions in `client.ts` (T-16) and `adapters/index.ts` (T-20) wait for their owners. Duplication across a barrier is cheaper than serializing.

2. **T-00 exists solely to invert a dependency that would otherwise point backwards.** `normalizePlexOrigin` lives inside T-20's file in batch 4, but T-18 (batch 2) and T-21 (batch 4) both need it. Exporting it from `index.ts` would make batch 2 depend on batch 4; duplicating it would silently diverge the "origin we enrolled" from the "origin the resolver looks up". Extraction in batch 0 is the only ordering that is both correct and acyclic.

3. **BATCH 1 is the first real barrier: `types.ts` must own the credential cell before anything reads it.** T-12 rebinds `credentialBindings` to `PlexCredentialCell`. If `credential-store.ts` (T-13) or `jwt-provider.ts` (T-17) landed first they would compile against the old binding. `enrollment-client.ts` (T-14) must not land before `plex/http.ts` — it would duplicate `readBoundedBody` or fail to compile.

4. **BATCH 2 exists because the provider is the join point.** `jwt-provider.ts` needs the store (T-13), the transport (T-14), the cell (T-07), and the widened seam (T-12) simultaneously. `client.ts` (T-16) is in this batch only because it needs `PlexRequestInput.replayable` from T-12; it is otherwise independent of the provider, which is why it stays a separate task.

5. **BATCH 3 is a single task and the hard serialization point.** `plex-adapter.ts` is the only module the architecture gate permits to bridge `src/lib/adapters/plex/` and everything above it. **If T-19 is skipped, deferred, or split, `check:architecture` fails and both `npm run typecheck` and `npm run build` break.** Attempting T-20/T-21/T-22 first produces `private-plex-import` violations that look like unrelated tooling failures. Being a single task is also what makes T-19's unscoped façade probe (A6.14) safe to run.

6. **BATCH 4 fans back out.** The resolver (T-20), the action layer (T-21), and the two consumers (T-22) share only the façade.

7. **BATCH 5 is the command surface**, needing the action layer's exported types and its failure-envelope builder. Splitting `commands/plex-auth.ts` from `commands/plex.ts` would be pointless — the registration is 2 lines and the hierarchy test lives in `plex.test.ts`.

8. **BATCH 6 is last so the docs describe what shipped.** The exception is **T-11 (issue filing), pulled into batch 0** — T-25 and T-26 embed issue numbers that cannot exist until the issues do.

**Highest-risk reorderings:** (1) any batch-4 task before T-19; (2) T-16 before T-03 (deleting primitives with nothing to import from breaks the whole plex adapter and ~a dozen suites); (3) T-18 or T-21 before T-00 (silent origin divergence rather than a compile error, if the implementer "solves" it by copy-paste).

---

## D. Shared-file coordination

Every file below is touched conceptually by more than one concern. **Exactly one task owns each. Other tasks must depend on the owner and import, never edit.**

| File                                                                     | **SOLE OWNER**                   | Other tasks that need it                                                        | Required discipline                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`src/lib/adapters/plex-adapter.ts`**                                   | **T-19**                         | T-20, T-21, T-22, T-23 (all import)                                             | **THE FAÇADE.** The only `PRIVATE_PLEX_COMPOSER`. Its re-export list (T-19 step 5) is the contract; a consumer needing a missing symbol **reopens T-19** — it never adds a `./plex/*` import. Violation = `check:architecture` fails = **build and typecheck break**. |
| **`src/lib/plex-origin.ts`**                                             | **T-00**                         | T-18, T-20, T-21 (all import)                                                   | New in batch 0 purely to invert the dependency (A5.1). Behaviour byte-identical to the `index.ts` original. **Nobody re-implements or copies it.**                                                                                                                    |
| **`src/lib/adapters/index.ts`**                                          | **T-20**                         | —                                                                               | Import surface restricted to `./plex-adapter.js` + `../plex-origin.js`. Deletes the private `normalizePlexOrigin` (`:45-64`). All four `:26-32` literals and the `:81-87` guard block frozen.                                                                         |
| **`src/lib/adapters/plex/client.ts`**                                    | **T-16**                         | T-03 (creates `http.ts` it imports), T-18 (imports `PlexClient`, does not edit) | Six coupled changes (primitive removal, **array-signature `sanitizeMessage` call sites**, `mediaServerError` widening, selective `#getToken`, retry-after, **all 8 `isRead → replayable` sites**) must be one atomic edit. `:387` and `buildRequestUrl` untouchable.  |
| **`src/lib/adapters/plex/http.ts` + `http.test.ts`**                     | **T-03**                         | T-14, T-16 (import)                                                             | T-03 owns the hardened `sanitizeMessage` **and its test** (A6.12) — the behavior is security-relevant and `client.test.ts` is two batches away.                                                                                                                       |
| **`src/lib/adapters/plex/types.ts`**                                     | **T-12**                         | T-07 (cell it consumes), T-13, T-16, T-17, T-18, T-19 (import)                  | `getPlexConnectionToken`'s exported signature and **both** error literals frozen. Adds `createPlexRotatingConnectionSettings` for T-19/A5.3. `types.test.ts` green with zero edits.                                                                                   |
| **`src/lib/adapters/plex/auth.ts`**                                      | **T-12**                         | T-17, T-18 (import `StaticPlexTokenProvider` / `PlexTokenProvider`)             | Bundled with `types.ts` deliberately. `auth.test.ts` green with zero edits.                                                                                                                                                                                           |
| **`src/lib/config.ts`**                                                  | **T-15**                         | T-08 owns the type half                                                         | Split by file: T-08 declares `PlexAuthConfigOptions` and exports it from `src/types/index.ts`; T-15 validates it. **Neither touches `buildConfigTemplate` (A4.14).**                                                                                                  |
| **`src/types/index.ts`**                                                 | **T-08**                         | —                                                                               | **+1 line** in the named `./config.js` export block (A6.3). Named list, not `export *`.                                                                                                                                                                               |
| **`src/lib/shell-completions/{bash,zsh,fish}.ts` + `templates.spec.ts`** | **T-10 (all four)**              | T-23 reuses the description table                                               | **Must change together** — `templates.spec.ts:471` asserts order-sensitive equality across all three shells simultaneously. Fish leaf candidate lines are mandatory (A6.2). T-23 copies option descriptions verbatim.                                                 |
| **`src/commands/plex.ts`**                                               | **T-23**                         | —                                                                               | Exactly 2 lines appended at `:2546`.                                                                                                                                                                                                                                  |
| **`scripts/check-direct-plex-imports.mjs`**                              | **T-09**                         | Every plex task is constrained by it                                            | Do not widen `PRIVATE_PLEX_COMPOSER`; do not touch its `.test.mjs`; **do not add anything to `PLEX_COMPATIBILITY_ALLOWLIST`** (A6.4). T-09 must create-verify-delete a stub at `enrollment-client.ts` (A6.11) and leave the tree clean.                               |
| **`src/lib/adapters/plex/enrollment-client.ts`**                         | **T-14**                         | T-09 temporarily stubs it in batch 0 and **must delete the stub**               | The one-`fetch(` count assertion lives in **T-14's** acceptance, where it is discriminating.                                                                                                                                                                          |
| **`ROADMAP.md`**                                                         | **T-26**                         | T-11 supplies issue numbers                                                     | No other task edits it.                                                                                                                                                                                                                                               |
| **`docs/roadmap-archive.md`**                                            | **T-26**                         | —                                                                               | Includes the stale `:56-57` bullet.                                                                                                                                                                                                                                   |
| **`src/lib/lidarr/errors.ts`**                                           | **T-02**                         | —                                                                               | Re-export only; zero behaviour change.                                                                                                                                                                                                                                |
| **`src/lib/lidarr/profile-preset-persistence.ts`**                       | **NOBODY — read-only reference** | T-01 models on it                                                               | **§15 Q4: untouched.** Its test must pass unmodified.                                                                                                                                                                                                                 |
| **`src/lib/plan.ts`**                                                    | **T-08**                         | —                                                                               | **`:355` only.**                                                                                                                                                                                                                                                      |
| **`src/lib/adapters/plex/client.test.ts`**                               | **T-16**                         | —                                                                               | `:70-73`, `:163`, `:372-397`, `:400-427` byte-identical; T6 appends only.                                                                                                                                                                                             |
| **`src/lib/adapters/plex-adapter.test.ts`**                              | **T-20**                         | —                                                                               | T1 appends; `testConfig.token` at `:26` stays `token`; owns the `JSON.stringify(adapter)` sink moved from T5.                                                                                                                                                         |
| **`src/lib/adapters/plex/jwt-provider.test.ts`**                         | **T-17**                         | —                                                                               | Does **not** contain the version-conflict case (moved to T-13) and does **not** construct a `PlexAdapter`.                                                                                                                                                            |

**Files no task may edit** (their unmodified green is the AC-7 / SEC-001 proof): `plex/auth.test.ts`, `plex/types.test.ts`, `mcp/schema.spec.ts`, `mcp/adapters.spec.ts`, `lidarr/profile-preset-persistence.test.ts`, `scripts/check-direct-plex-imports.test.mjs`.

---

## E. Test tasks

Owner constraint: **"Do not create unnecessary tests, only critical or required tests should be created."** Every test below earns its place; one design-implied test is dropped.

| Design ref  | File                                                                    | Owning task | Verdict & justification                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **T1**      | `src/lib/adapters/plex-adapter.test.ts` (extend)                        | **T-20**    | **KEEP — highest value per line.** The cross-origin guard is a _presence_ test on `overrides.plexToken`; adding a credential source that does not flow through `overrides` is exactly the shape that silently disables it, and it is the repo's **standing recorded regression**. Now also carries the rotating-vs-static cell assertion (A5.3) and the `JSON.stringify(adapter)` sink (A6.18).                                            |
| **T2**      | `src/lib/adapters/plex/credential-cell.test.ts`                         | **T-07**    | **KEEP.** Rotation is new code that mutates a bound secret; `types.test.ts` proves nothing about it. This is #119's CRITICAL SEC-001 re-entering through the only remaining door.                                                                                                                                                                                                                                                          |
| **T3**      | `src/lib/adapters/plex/jwt-provider.test.ts`                            | **T-17**    | **KEEP** (cases a, c, d, e + cancel + nonce-staleness + skew). Every existing Plex test is single-request; concurrency is entirely unproven. Failure mode is silent lockout, non-reproducible by hand, routine under `queue run --workers=2`, catastrophic against a measured 10-nonce/300 s budget. **Case (b) moved to T-13 (A6.16).**                                                                                                   |
| **T4**      | `src/lib/adapters/plex/credential-store.test.ts`                        | **T-13**    | **KEEP + one case.** Mode and symlink bugs are 100% silent. Verified `grep -rn "chmod\|0o600\|0o700" src/lib/adapters src/actions/plex*.ts` returns **zero** matches — no existing coverage. Now also owns the version-conflict CAS case (A6.16), without which T-13 could ship a broken CAS and pass.                                                                                                                                     |
| **T5**      | `src/lib/adapters/plex/jwt-provider.test.ts` (`describe("… security")`) | **T-17**    | **KEEP, six sinks.** Verified gaps closed: `sanitizeMessage`'s `\b` does not match `refresh_token=`; its key list lacks `pin`/`code`/`secret`/`signature`/`assertion`; only the _live_ attempt token is exact-removed. Correction to the design's rationale: `SENSITIVE_QUERY_KEY_PATTERN` (`client.ts:12`) **does** contain `jwt`, `nonce`, `privatekey` — but matches key **names**, not values, so it never guards the sentinel values. |
| **T6**      | `src/lib/adapters/plex/client.test.ts` (extend)                         | **T-16**    | **KEEP.** The existing fence proves the _verb heuristic_, not _intent_. The three `/library/sections/…/refresh` scan triggers travel as GET and are auto-replayable today. Also fences that the advisory `retryable` flag moved in lockstep across all 8 sites.                                                                                                                                                                            |
| **T7**      | `src/lib/adapters/plex/jwt-wire.test.ts`                                | **T-05**    | **KEEP.** U1 is the most likely real-world failure of the whole feature and §15 Q2 means it is never exercised live. Without it the failure mode is a silent `undefined` credential or an unredacted body dump. Only place `observedKeys`' bounding (A4.8) is enforced.                                                                                                                                                                    |
| **NEW**     | `src/lib/secure-store/secure-store.test.ts`                             | **T-01**    | **ADD — the design's waiver is void.** §10 waives it because _"the extraction is proven by `profile-preset-persistence.test.ts` passing unmodified"_; §15 Q4 makes `ppp` untouched, so its suite proves nothing here, and `ppp` is 100% async with no lock backoff loop. The sync path and the waiting lock are **entirely new, security-critical, uncovered code.** Six cases (A4.1).                                                     |
| **NEW**     | `src/lib/adapters/plex/enrollment.test.ts`                              | **T-18**    | **ADD — the single most important missing test (A6.15).** T-13 tests the store, **T-14 has no test**, T-17 tests refresh not enroll, T-23 tests Commander wiring. The enroll → poll → **probe → discard-on-reject** → single locked CAS write path had **zero** coverage. It is AC-1, half of AC-3, and the entire containment story for U6 (Critical: "the feature is inert if false"). Three cases.                                      |
| **NEW**     | `src/lib/adapters/plex/http.test.ts`                                    | **T-03**    | **ADD, minimal (4 assertions) (A6.12).** The hardened `sanitizeMessage` is security-relevant behavior whose only other test file is owned two batches later; without this, T-03's acceptance passes on an empty file.                                                                                                                                                                                                                      |
| **NEW**     | `src/lib/adapters/plex/jwt.test.ts`                                     | **T-04**    | **ADD, minimal (2 cases).** §12 runs it; §10 never defines it. A wrong RFC 7638 thumbprint produces a `kid` the server never matches, so enrollment fails with a server-side error **no other test can catch**, and §15 Q2 means no live run will catch it.                                                                                                                                                                                |
| **NEW**     | `src/commands/plex-auth.test.ts`                                        | **T-23**    | **ADD, minimal (3 cases).** §12 runs it; §10 never defines it. Justified by the recorded `MEMORY.md` lesson: a Commander `argParser` throwing `InvalidArgumentError` calls `process.exit(1)` **before `.action()`**, bypassing the failure envelope and redaction. The "no argParser" assertion is a structural guarantee nothing else provides.                                                                                           |
| **DROPPED** | `src/actions/plex-auth.test.ts`                                         | —           | **DROP.** §12 runs it but §10 never defines it, and its coverage is fully subsumed: envelope shapes by T-23, store behaviour by T-13, enrollment behaviour by T-18, provider behaviour by T-17, wire behaviour by T-05/T-07. **Removed from the §12 command list** (see G).                                                                                                                                                                |

**Existing tests updated — FIVE files:**

| File                                          | Task | Change                                                                                                                                            |
| --------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/adapters/plex-adapter.test.ts`       | T-20 | T1 cases + **mandatory** `RFMEDIA_PLEX_AUTH_DIR` tmpdir in `beforeEach`. **No `token`→`credential` rename — zero construction sites (A3 row 3).** |
| `src/lib/adapters/plex/client.test.ts`        | T-16 | T6 appended; `:70-73`, `:163`, `:372-397`, `:400-427` byte-identical.                                                                             |
| `src/lib/shell-completions/templates.spec.ts` | T-10 | tree `:35` + new `auth` key + **one** typed-option lock case.                                                                                     |
| `src/commands/plex.test.ts`                   | T-23 | `:413-420` hierarchy gains `"auth"`.                                                                                                              |
| `src/lib/config.test.ts`                      | T-15 | `plex.auth` round-trip; `mode:"jwt"` + `plex.token` retained at load time.                                                                        |

**Deliberately not written:** exhaustive clock-skew arithmetic (two boundaries + the `PLEX_AUTH_CLOCK_SKEW` case live in T-17); per-status mapping tests (testing a frozen table tests `Object.freeze`); RS256/JWKS/verification (no such code); any new test for the legacy static path (its **unmodified** green is the proof); runtime plan/queue serialization (the `UnclassifiedCopyOptionKeys extends never` fence at **`plan.ts:884-885`** fails the **build**, strictly stronger than a test).

**AC coverage map (issue #251, all 10):**

| AC                                                                             | Delivered by                                                                             | Status after amendments                |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------- |
| 1 enroll without a browser token                                               | T-18 + T-21 + T-23                                                                       | delivered **and tested** (A6.15)       |
| 2 stable identity + Ed25519 owner-only material                                | T-04, T-13/T4, T-01                                                                      | covered                                |
| 3 tests for acquisition / expiry / nonce / revocation / skew / cancel / atomic | T-18 (acquisition, revocation), T-17 (expiry, nonce, cancel, skew), T-13 + T-01 (atomic) | covered after A6.15 + A6.17            |
| 4 single-flight refresh, no stale overwrite                                    | T-17 T3(a)(c)(e) + T-13 version-conflict case                                            | covered after A6.16                    |
| 5 read retry ≤1, no mutation replay                                            | T-16 T6 + `query-library.ts`                                                             | covered                                |
| 6 typed, actionable, secret-free errors + rate-limit surfacing                 | T-06, T-05/T7, T-02, T-21 (A4.9)                                                         | covered                                |
| 7 legacy compatibility + migration/rollback                                    | T-12 (unmodified `auth.test.ts`/`types.test.ts`) + T-24                                  | covered                                |
| 8 secrets absent from every sink                                               | T-07 T2, T-17 T5, T-20 T1 (adapter sink), T-08 (`FORBIDDEN_KEYS` + `plan.ts:884` fence)  | covered                                |
| 9 config / command / docs / 3-shell completion tests                           | T-15, T-23, T-10 (incl. fish leaf lines A6.2), T-24                                      | covered                                |
| 10 typecheck / build / tests / architecture / security gates                   | §G                                                                                       | covered (with A6.8's `format:all` fix) |

---

## F. Documentation and metadata

| Artifact                                                     | Task     | Note                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/docs/features/media-server-adapter.md` | T-24     | **Highest priority** — `:97` and `:148` become **false statements** on merge.                                                                                                                                                                                                                                                                                                                |
| `packages/rfmedia-cli/docs/features/plex-configuration.md`   | T-24     | `plex.auth`, 5-branch precedence table, migration/rollback (AC-7), `RFMEDIA_PLEX_AUTH_DIR`, local-FS-only limitation, reachable-PMS requirement.                                                                                                                                                                                                                                             |
| `packages/rfmedia-cli/README.md`                             | T-24     | 4 sections + config table `auth` row + `--output json` ordering note.                                                                                                                                                                                                                                                                                                                        |
| `packages/rfmedia-cli/CLAUDE.md` **and** `AGENTS.md`         | T-24     | **Verified NOT a symlink** — distinct md5. Doc work doubles. Must record the **façade rule (A1.1)** and the **single origin authority (A5.1)** as permanent architecture.                                                                                                                                                                                                                    |
| `/CLAUDE.md:216`, `/AGENTS.md:264-286`                       | T-24     | Root-level `PLEX_TOKEN` guidance gains the enrollment alternative.                                                                                                                                                                                                                                                                                                                           |
| `/docs/features/secrets-management.md`                       | T-24     | 13 `PLEX_TOKEN` hits; note the store is **not** `{{ VAR }}`-templated.                                                                                                                                                                                                                                                                                                                       |
| `/docs/README.md:82-88`                                      | T-24     | Feature-doc index.                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/rfmedia-cli/docs/features/lidarr-audit.md`         | T-24     | Readiness-gate change from T-22.                                                                                                                                                                                                                                                                                                                                                             |
| **Completion templates ×3 + spec**                           | **T-10** | All three change together; canonical description table in T-10; fish leaf candidate lines mandatory (A6.2).                                                                                                                                                                                                                                                                                  |
| `/ROADMAP.md`                                                | T-26     | 7 line-exact edits. Lines **8** and **10**, not "~7"/"~11".                                                                                                                                                                                                                                                                                                                                  |
| `/docs/roadmap-archive.md`                                   | T-26     | 4 edits incl. the stale `:56-57` deferral bullet.                                                                                                                                                                                                                                                                                                                                            |
| `/docs/internal/plex-jwt-deferrals.md`                       | T-25     | **New directory**, repo root. `docs(internal):` commit type.                                                                                                                                                                                                                                                                                                                                 |
| `/docs/plans/plex-jwt-251/design.md`                         | T-26     | Fix 3 × MD031 at `:868, :874, :886` — verified failing today.                                                                                                                                                                                                                                                                                                                                |
| **4 follow-up GitHub issues**                                | **T-11** | YAML forms mandatory; numbers feed T-25 and T-26.                                                                                                                                                                                                                                                                                                                                            |
| PR body                                                      | final    | `.github/pull_request_template.md`; `Closes #251`; `## Testing` must state **verbatim** that enrollment was **never exercised end-to-end against a real account** (§15 Q2) and name U1/U6 as residual risk; restate §15's four resolved decisions so the owner can overrule cheaply; claim only the `plex query list` / `plex collection *` completion fixes (**not** `plex playlist list`). |

---

## G. Definition of done

**`env -u FORCE_COLOR` is mandatory** — the agent shell sets it, which fails two `rf-common` logger tests and blocks the pre-push hook.

### G.0 Batch-barrier gate (orchestrator only — A5.5)

Run after **every** batch, from `packages/rfmedia-cli/`, with no task agent mid-edit:

```bash
npm run check:architecture        # runs under BOTH prebuild and pretypecheck
npm run test:architecture         # gates typecheck ONLY -- does NOT gate build
npm run typecheck
env -u FORCE_COLOR npm run test:run
git status --porcelain            # must show no facade-probe.tmp.ts and no stub enrollment-client.ts
```

A barrier failure blocks the next batch. Individual tasks never run these commands (except T-19's single-task probe).

### G.1 Final verification

From `packages/rfmedia-cli/`:

```bash
# 1. Architecture gates FIRST
npm run check:architecture
npm run test:architecture

# 2. Types (package + benchmarks)
npm run typecheck

# 3. Focused, cheapest signal first
env -u FORCE_COLOR npx vitest run \
  src/lib/secure-store/secure-store.test.ts \
  src/lib/adapters/plex/http.test.ts \
  src/lib/adapters/plex/jwt.test.ts \
  src/lib/adapters/plex/jwt-wire.test.ts \
  src/lib/adapters/plex/credential-cell.test.ts \
  src/lib/adapters/plex/credential-store.test.ts \
  src/lib/adapters/plex/jwt-provider.test.ts \
  src/lib/adapters/plex/enrollment.test.ts \
  src/lib/adapters/plex/auth.test.ts \
  src/lib/adapters/plex/client.test.ts \
  src/lib/adapters/plex/types.test.ts \
  src/lib/adapters/plex/query-library.test.ts \
  src/lib/adapters/plex/playlists.test.ts \
  src/lib/adapters/plex/collections.test.ts \
  src/lib/adapters/plex-adapter.test.ts

# 4. Must pass with ZERO source edits to those modules
env -u FORCE_COLOR npx vitest run src/lib/lidarr/profile-preset-persistence.test.ts
env -u FORCE_COLOR npx vitest run src/lib/lidarr/audit.test.ts
env -u FORCE_COLOR npx vitest run src/lib/lidarr/errors.test.ts

# 5. Surface + config + MCP
#    NOTE: src/actions/plex-auth.test.ts REMOVED -- never specified, coverage subsumed (E)
env -u FORCE_COLOR npx vitest run \
  src/lib/shell-completions/templates.spec.ts \
  src/commands/plex.test.ts \
  src/commands/plex-auth.test.ts \
  src/lib/config.test.ts \
  src/lib/plan.test.ts \
  src/mcp/schema.spec.ts \
  src/mcp/adapters.spec.ts

# 6. Full package suite
env -u FORCE_COLOR npm run test:run
```

From the repo root:

```bash
npm run build:rfmedia          # prebuild => codegen:lidarr:check + check:architecture
npm run build:all
env -u FORCE_COLOR npm run test:run
npm run format:all             # `npm run format` is a NO-TARGET NO-OP -- it errors (A6.8)
npm run lint:md                # ROOT script; docs/plans IS linted; design.md must be clean
npm run format:check
graphify update .              # from the MAIN checkout, after the change lands
```

**Green means:**

- Zero architecture violations; the gate reports **exactly one** fetch for `enrollment-client.ts`.
- `tsc --noEmit` clean in all three packages.
- **Zero `private-plex-import` and zero `plex-compatibility-import` violations** — every upper-layer plex symbol arrives via `plex-adapter.ts`, and neither `actions/plex-auth.ts` nor `commands/plex-auth.ts` touches `src/types/plex*`.
- The ten new suites pass (`secure-store`, `http`, `jwt`, `jwt-wire`, `credential-cell`, `credential-store`, `jwt-provider`, `enrollment`, `commands/plex-auth`, plus the extended `plex-adapter`).
- `auth.test.ts`, `types.test.ts`, `client.test.ts:70-73/163/372-397/400-427`, `mcp/schema.spec.ts`, `mcp/adapters.spec.ts`, and the lidarr persistence suite pass with **zero source edits to those files**.
- `templates.spec.ts:471` and `plex.test.ts:413` pass with the intended `auth` additions and nothing else.
- `lint:md` reports 0 errors including `design.md`.
- `git status --porcelain` shows no `facade-probe.tmp.ts` and no stub `enrollment-client.ts` leftovers.

**Gate topology the PR checklist must state (verified):**

- **`lint:md` and `format:check` are run by NO CI job and NO git hook.** `pre-commit` only prettier-formats staged files; `pre-push` only runs `npm run test:run`. Markdown correctness is a **manual step**.
- **`.github/workflows/rfmedia-cli.yml:4-10`** filters on `.github/workflows/rfmedia-cli.yml`, `package-lock.json`, `package.json`, `packages/rf-common/**`, `packages/rfmedia-cli/**`. So T-24's package-scoped doc edits **do** trigger the PR job; only `/ROADMAP.md`, `/docs/**`, `/CLAUDE.md`, `/AGENTS.md` are CI-invisible (**A6.9**).
- **No coverage threshold is configured**, so the new modules cannot fail `test:coverage` on coverage grounds.

**Manual verification no automated test can replace.** Per **§15 Q2 this is NOT run** — enrollment is never exercised against a real account. Reproduce design §12's manual block **verbatim in the PR's `## Testing` section, marked NOT RUN**, with U1 and U6 named as the residual risk.

---

## H. Risk register for the implementation

| #       | What is most likely to go wrong **during implementation**                                                                                                                                                                                                               | Mitigation / abort criterion                                                                                                                                                                                                                                                                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H1**  | **An agent adds a `./plex/*` import to `index.ts`, `actions/`, `commands/`, or `error-formatters.ts`** and burns time diagnosing a "tooling" failure. Highest-probability failure in the plan — the design actively instructs it.                                       | Every batch-4/5 task spec states the façade rule. **The scoped `check:architecture` grep is the FIRST acceptance command in every task touching a file outside `src/lib/adapters/plex/`.** If a needed symbol is missing from the façade, **reopen T-19** — never add a direct import. T-19's probe (A6.14) proves completeness before batch 4 starts.                                   |
| **H2**  | **`secure-store` blows the ~500-line cap** (design budgeted 250 for an extraction that does not exist).                                                                                                                                                                 | Pre-split into five modules (T-01). **Abort:** if any single module passes 500 lines, split `paths.ts` into `paths-sync.ts` / `paths-async.ts`.                                                                                                                                                                                                                                          |
| **H3**  | **`auth.test.ts` or `types.test.ts` needs an edit.** Their unmodified green is the AC-7 / SEC-001 proof.                                                                                                                                                                | **HARD ABORT for T-12.** If either needs a change, the credential-cell delegation is wrong: `getPlexConnectionToken` must keep its exact signature and both literals, and validation must stay **on read**. Re-derive; do not edit the test.                                                                                                                                             |
| **H4**  | **`templates.spec.ts:471` fails** — `auth` not appended **last** in one shell, zsh array not named `auth_subcmds`, emitted before the `plex)` arm, or the **four fish leaf candidate lines missing/out of order (A6.2)**.                                               | Assertion is order-sensitive and simultaneous across all three shells. T-10 pins all names and line order mechanically. Run the spec after **each** template edit.                                                                                                                                                                                                                       |
| **H5**  | **`plex auth status --<TAB>` silently completes nothing** because the implementer trusted _"`status` is already present"_ at `bash.ts:270`. Verified false.                                                                                                             | A2 flags it; T-10 requires `\|status\|login\|refresh\|logout`. Verify by grepping the emitted script for `status` in the sub-sub alternation.                                                                                                                                                                                                                                            |
| **H6**  | **Someone copies zsh from lines 1346-1360** (`esac` closers), producing syntactically broken zsh.                                                                                                                                                                       | A2: the plex `sync)` arm is `zsh.ts:1186-1244`; the `_arguments` model is the `collection delete)` leaf at `1345-1353`. Validate with `zsh -n <(rfmedia completion zsh)`.                                                                                                                                                                                                                |
| **H7**  | **`TS2564` / `TS2353` (A1.3, A1.4)** hit late, because §4 and §7 are written in `.d.ts` style.                                                                                                                                                                          | Called out in T-05, T-06, T-16. Any task creating an error class writes a **real constructor**; T-16 widens `mediaServerError` **before** touching `#handleNonSuccess`.                                                                                                                                                                                                                  |
| **H8**  | **`replayable` defaults to `input.replayable === true`** instead of `?? (method === "GET")`, silently disabling auth retry for the whole collection/playlist read family.                                                                                               | T-16 states the default explicitly and its acceptance runs `playlists.test.ts` + `collections.test.ts`, which a wrong default breaks.                                                                                                                                                                                                                                                    |
| **H9**  | **`plex-adapter.test.ts` reads the developer's real `~/.config/rfmedia/plex-auth/store.json`**, producing tests that pass for one person.                                                                                                                               | Mandatory `beforeEach` tmpdir in T-20. **Detection:** run the suite twice — once with a real store present, once without; results must be identical.                                                                                                                                                                                                                                     |
| **H10** | **The loser-adopts-winner path adopts an expired credential** by following §5 line 628's version-advance predicate instead of A4.2 — producing exactly the nonce-budget exhaustion the design exists to prevent. T3(c) alone would still pass.                          | A4.2 is binding, and **T3(e) is the negative case**: peer wrote `back-off` (version advanced, credential still expired) ⇒ the loser throws `PLEX_AUTH_RATE_LIMITED`, does **not** adopt.                                                                                                                                                                                                 |
| **H11** | **The lock wedges permanently** (PID reuse, `EPERM`, dead remote host).                                                                                                                                                                                                 | A4.4's `createdAt` age rule (120 s) bounds every wedge. `plex auth status` reports `lockPath`; the busy error's remediation names it.                                                                                                                                                                                                                                                    |
| **H12** | **`enrollment-client.ts` trips the fetch-count rule** via a second `fetch(` in a comment or JSDoc — the pattern is textual.                                                                                                                                             | T-14's acceptance asserts `grep -cE '\b(fetch\|trustedFetch)\s*\(' … = 1`. T-09's stub proves the owner path is not typo'd (A6.11).                                                                                                                                                                                                                                                      |
| **H13** | **`plex-adapter.ts` drifts over the 500-line cap** as symbols are added to the façade.                                                                                                                                                                                  | Budget ~300. **Abort:** past 450 lines, trim the export list to what consumers actually use. Do **not** create a second façade file — it would need its own gate exemption.                                                                                                                                                                                                              |
| **H14** | **The PR claims a `plex playlist list` completion fix that did not happen.**                                                                                                                                                                                            | A2: `playlist`, `copy`, `sync` are clobbered one layer earlier at `bash.ts:200`. Claim only `plex query list` and `plex collection list\|show\|add\|create`.                                                                                                                                                                                                                             |
| **H15** | **Docs and ROADMAP land partly unverified.**                                                                                                                                                                                                                            | T-24/T-26 acceptance is `npm run format:all && npm run lint:md` from the **repo root** (`npm run format` is a no-op that errors — A6.8), run manually, as an explicit PR-checklist line. Package-scoped docs do hit PR CI; root docs do not (A6.9).                                                                                                                                      |
| **H16** | **U1/U6 remain open** (§15 Q2) — enrollment may be inert against a real account.                                                                                                                                                                                        | Structural containment: the tolerant reader accepts both `auth_token` and `authToken`; `login` **refuses to persist** a credential its PMS probe rejects (**now tested — A6.15**); `observedKeys` makes a wire mismatch diagnosable from a bug report; a correction is one file + one fixture. **Not an abort criterion — a disclosed limitation** the PR's `## Testing` states plainly. |
| **H17** | **`normalizePlexOrigin` gets duplicated instead of imported**, because T-18 lands before anyone reads A5.1. Produces silent `not-enrolled` for a working enrollment, or an enrollment match looser than the cross-origin guard — **no compile error, no failing test**. | T-00 lands in batch 0 and is a stated dependency of T-18, T-20, T-21. Detection: `grep -rn "function normalizePlexOrigin" packages/rfmedia-cli/src` must return **exactly one** hit (`src/lib/plex-origin.ts`) after batch 4.                                                                                                                                                            |
| **H18** | **`PlexJwtTokenProvider`'s constructor signature diverges** between T-17 (batch 2) and T-19 (batch 3), across a barrier.                                                                                                                                                | A5.4 pins the exact signature in both task specs. Detection: T-19's façade probe + the batch-3 barrier typecheck.                                                                                                                                                                                                                                                                        |
| **H19** | **T-19 builds a static cell for `kind: "enrolled"`**, so `rotatePlexCredentialCell` throws `TypeError` on the first real refresh — invisible to `jwt-provider.test.ts`, which builds its own connection.                                                                | A5.3 mandates `createPlexRotatingConnectionSettings`; **T-20's T1 asserts** that an enrolled resolution yields a rotatable cell and a static one does not.                                                                                                                                                                                                                               |
| **H20** | **Twelve batch-0 agents fail each other's acceptance gates** by running package-global `tsc`/`check:architecture`/`test:run` in a shared worktree.                                                                                                                      | A5.5: per-task acceptance is file-scoped (`vitest` on owned files + grep-scoped `tsc`/gate output); unscoped gates are orchestrator-only at barriers. A task must never "fix" a diagnostic in a file it does not own.                                                                                                                                                                    |
| **H21** | **`sanitizeMessage` is typed `Iterable<string>`**, so today's bare-`string` call sites compile unchanged and redact every individual character — `tsc` silent, positive `[REDACTED]` assertions possibly still green.                                                   | A5.2: the parameter is **`readonly string[]`, required**. T-16 must visit both call sites (`client.ts:106-108` and `:475`). T-03's `http.test.ts` case (iii) exercises the multi-secret path.                                                                                                                                                                                            |
| **H22** | **T-09's stub or T-19's façade probe is left in the tree**, breaking the next barrier or shipping in the PR.                                                                                                                                                            | Both tasks end with an explicit delete + `git status --porcelain` check; the barrier gate (G.0) re-checks.                                                                                                                                                                                                                                                                               |
