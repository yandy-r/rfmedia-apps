I read the design in full (all 1231 lines) and verified every load-bearing claim below against the actual worktree. **Verdict: the plan's corrections (A1–A4) are accurate — I re-verified `check-direct-plex-imports.mjs:574-583`, `bash.ts:270` (no `status`), `zsh.ts:897-905/1186/1345-1353`, `fish.ts:706-715/765-775/777-781`, `templates.spec.ts:34-41`, `plan.ts:355/884-885`, `client.ts:76-89/91-104/337/356-366/407-435`, `plex-adapter.ts:17/61-68/94-105`, `types/config.ts` mutability, absent `exactOptionalPropertyTypes`, `prebuild` vs `pretypecheck`. Those are all correct.** The defects below are what the plan still misses.

## REQUIRED PLAN AMENDMENTS (prioritized)

### P0 — will break the build or produce incompatible code

**1. `normalizePlexOrigin` has no owner and the plan inverts its dependency.** Verified: it is a **module-private function inside `src/lib/adapters/index.ts:44-64`** — not exported, not in `plex/`, not in `http-url.ts`. A4.7 requires `login/refresh/logout/status` to normalize origins "via `normalizePlexOrigin`", and T-18 (batch 2) + T-21 (batch 4) both need it, but its only home is T-20's file in **batch 4**. Options the plan leaves open are both wrong: duplicating it diverges origin semantics between "the origin we enrolled" and "the origin the resolver looks up" (silent `not-enrolled` for a working enrollment, or a looser match than the cross-origin guard); exporting it from `index.ts` makes T-18 depend on T-20 — a **dependency inversion across two batches**.
**Amendment:** add a BATCH-0 task owning a new `src/lib/plex-origin.ts` (move `normalizePlexOrigin` verbatim, exported, JSDoc'd). T-20 imports it; `plex-adapter.test.ts:424-426` and `mcp/adapters.spec.ts:672` must stay green unmodified as proof the guard is unchanged.

**2. `sanitizeMessage(value: unknown, secrets: Iterable<string>)` is a silent type trap.** `string` **is** `Iterable<string>`. The existing call `configurationError` → `sanitizeMessage(error, token)` (`client.ts:106-108`) will **compile unchanged** and redact every individual character. `tsc` will not catch it; `client.test.ts`'s positive `toContain("[REDACTED]")` may still pass.
**Amendment:** signature must be `readonly string[]` (or `ReadonlySet<string>`). Fix in T-03 and restate in T-16's call-site update.

**3. T-19 must use `createPlexRotatingConnectionSettings` for `kind: "enrolled"`.** T-19 step 3 says only "resolve `clientIdentifier` into `createPlexConnectionSettings`". If the enrolled branch builds a **static** cell, T-17's `rotatePlexCredentialCell` throws `TypeError` on the first refresh (T-07's own contract: "static cell refuses rotation"). No acceptance command in the plan catches this — `jwt-provider.test.ts` builds its own connection.
**Amendment:** state it explicitly in T-19, and add one assertion to T-20's T1 that an `enrolled` resolution produces a rotatable connection.

**4. `PlexJwtTokenProvider`'s constructor contract is never specified.** T-17 defines it (batch 2), T-19 constructs it (batch 3), across a barrier. The design gives the class name only. Two implementers produce incompatible signatures (`(connection, storePath, margin, deps)` vs `(connection, PlexAdapterCredential, deps)` vs `(deps object)`).
**Amendment:** pin it in T-19's spec (the consumer owns the contract), e.g. `new PlexJwtTokenProvider(connection, { storePath, refreshMarginSeconds, now?, fetch? })`, and have T-17 implement to that.

**5. Per-task acceptance commands are package-global in a shared worktree.** `npx tsc --noEmit`, `npm run check:architecture`, `npm run test:architecture` and `npm run test:run` all scan the whole package. Eleven BATCH-0 agents editing one worktree will fail each other's acceptance gates nondeterministically for unrelated reasons.
**Amendment:** state the isolation model. Either (a) one worktree per task and a merge step per batch, or (b) per-task acceptance is **file-scoped only** (`vitest run <own file>`), with `tsc --noEmit` / `check:architecture` / `test:architecture` run **once by the orchestrator at each batch barrier**. Without this the plan is unrunnable as written.

### P1 — work that will be discovered mid-implementation

**6. `PlexAssertionInput` is referenced but never defined.** Design §4 uses it in `buildPinExchangeClaims` / `buildRefreshClaims`; it appears nowhere in the design or the plan. T-05 owns `jwt-wire.ts`; T-17/T-18 construct the inputs. Two implementers → incompatible claim sets (`iss`/`sub`/`aud`/`jti`/`iat`/`exp`/`clientIdentifier`/`kid`).
**Amendment:** T-05 must define and export `PlexAssertionInput` with the exact field list, and T-17/T-18 must be told to consume it (never hand-build claims).

**7. Fish leaf candidate lines are missing from T-10.** `extractFishCandidates(script, "auth")` (`templates.spec.ts:425-436`) collects **every** line matching `-n "__fish_rfmedia_plex_auth_needs_subcommand"` and reads its `-a "…"`, then `toEqual(["login","status","refresh","logout"])`. T-10's fish spec lists only the predicates, the `plex_needs_subcommand -a "auth"` line, and leaf **option** lines — it never requires the four `complete -c rfmedia -n "__fish_rfmedia_plex_auth_needs_subcommand" -a "<leaf>" -d "<desc>"` lines, in order. The new tree key will fail.
**Amendment:** add them to T-10 explicitly, in tree order.

**8. `src/types/index.ts` is unowned and must change.** Verified: it is a **named** re-export list (`:96-124`) containing `PlexConfigOptions`, `PlexCacheConfig`, `PlexLibraryMapping`, … — not `export *`. `PlexAuthConfigOptions` will not surface from the barrel unless added.
**Amendment:** add `src/types/index.ts` to T-08's owned files (+1 line).

**9. `src/commands/plex-auth.ts` is not in `PLEX_COMPATIBILITY_ALLOWLIST`.** The plan states the `src/types/plex` prohibition for T-21 only. `check-direct-plex-imports.mjs:133-145` lists `src/commands/plex.ts` but not the new module; an import of `src/types/plex` from it is a `plex-compatibility-import` violation that fails **build and typecheck**.
**Amendment:** restate the prohibition in T-23.

**10. T-06's `SECURE_STORE_LOCK_BUSY` message entry is a type error.** `PLEX_AUTH_MESSAGES` is `Readonly<Record<PlexAuthErrorCode, string>>`; `SECURE_STORE_LOCK_BUSY` is a `SecureStoreErrorCode`. The union member is `PLEX_AUTH_REFRESH_BUSY`.
**Amendment:** correct the name in T-06 and in A4.4.

**11. A4.11 leaves `{kind:"absent"}` to the implementer's judgment.** `PlexCredentialState` is re-exported through the façade (T-19) and rendered in the `plex auth status` envelope (T-21) — a conditional variant produces divergent envelopes.
**Amendment:** decide now. **Delete the variant** (a `PlexAuthStoreHandle` only exists when a store parsed successfully, so `absent` is unreachable by construction) and have `readPlexAuthStatus` return `{enrolled: false}` when `loadPlexAuthStoreSync` returns `undefined`.

**12. T-16 omits two `isRead` sites.** Beyond the retry gate (`:419-424`) and the advisory flag (`:433`), `PlexRequestAttempt.isRead` is a declared field (`client.ts:~44`) and is computed and passed in `request()` at `:329` and `:342`. All four move together.

**13. `npm run format` is not runnable.** Verified: the root script is bare `prettier --write` with no target — it errors `No parser and no file path given`. T-24's acceptance (`npm run format && npm run lint:md`) never formats anything and the design's §12 has the same bug.
**Amendment:** use `npm run format:all` (or `format:md`) `&& npm run lint:md`.

**14. The "docs trigger no CI" claim is half wrong.** `.github/workflows/rfmedia-cli.yml:5-10` filters on `packages/rfmedia-cli/**` — so T-24's edits to `packages/rfmedia-cli/README.md`, `CLAUDE.md`, `AGENTS.md`, and `docs/features/*` **do** trigger the PR job (typecheck/tests, not `lint:md`). Only `/ROADMAP.md`, `/docs/**`, `/CLAUDE.md`, `/AGENTS.md` are CI-invisible.

**15. T-21/T-23 output boundary is unspecified.** Design §3 says the action "Builds JSON envelopes"; §8 says envelopes go to stdout "via `formatOutput`"; T-21 says the action builds them and T-23 says nothing about who prints or who sets `process.exitCode` for `PLEX_AUTH_RATE_LIMITED` ("exits 1"). Pin it: action returns a typed result/throws; command calls `formatOutput` and sets `exitCode`, matching `commands/plex.ts`.

### P2 — acceptance commands that would NOT fail if the task were done wrong

Otherwise the acceptance commands are sound and file-scoped. These five are not discriminating:

**16. T-09** — `check:architecture && test:architecture` with `alwaysRequired: false` and `enrollment-client.ts` absent makes the new `FETCH_OWNERS` entry a **no-op**; a typo'd path passes both commands identically. Move the assertion into T-14 ("the gate must report exactly one fetch for this owner" — that one _is_ discriminating), or have T-09 verify against a throwaway stub file it deletes.

**17. T-03** — `plex/http.ts` has **zero importers** until T-16, so `tsc --noEmit && check:architecture` passes on an empty file. Worse: the hardened `sanitizeMessage` (new `[\w-]*` boundaries, `pincode|code|secret|signature|assertion|refresh|devicejwt`, bidi stripping) is **security-relevant behavior whose only test file, `client.test.ts`, is owned by T-16 two batches later**. That is a real ownership conflict masquerading as "no collision".
**Amendment:** either give T-03 its own `src/lib/adapters/plex/http.test.ts` with ~4 assertions (`refresh_token=…` redacted, `auth_token=…` redacted, previous-secret redaction via the array arg, bidi stripped), or move the `sanitizeMessage` hardening out of T-03 into T-16.

**18. T-06** — same shape: `errors.ts` has no importer in batch 0; wrong message text or a missing union member passes.

**19. T-18** — `tsc --noEmit && check:architecture && vitest run src/lib/adapters/plex/` means ~240 lines of enrollment logic are verified by "it compiles" (see #21).

**20. T-19** — façade completeness is only proven when batch 4 compiles. Add to T-19's acceptance a throwaway consumer probe (a temp file outside `plex/` importing every re-exported symbol, typechecked then deleted), or the plan's own H1 risk lands inside its own ordering.

### P3 — test plan: one CRITICAL test is missing; no material gold-plating

**21. CRITICAL MISSING TEST — `src/lib/adapters/plex/enrollment.test.ts`.** T-18's "no test file" justification is factually wrong: T-13 tests the store, **T-14 has no test at all**, T-17 tests refresh (not enroll), T-23 tests Commander wiring. So the enroll → poll → **PMS probe → discard-on-reject** → single locked CAS write path has **zero** coverage. That path is the entire containment story for Risk 1 (U6, rated **Critical**, "the feature is inert if false"), it is AC-1, and half of AC-3. Combined with §15 Q2 (never exercised against a live account), nothing anywhere verifies it.
**Amendment:** add a minimal 3-case `enrollment.test.ts` to T-18 (injected wire + injected transport + `tmpdir()`): (i) claimed PIN + probe 200 ⇒ exactly one store write with `version === 1` and `{enroll, issue, authorize-origin}`; (ii) probe 401 ⇒ `PLEX_AUTH_PMS_REJECTED` **and the store file does not exist**; (iii) `forgetPlexEnrollment` ⇒ file unlinked, `serverSideRevocation: "manual"`. This is the highest value-per-line test in the whole change and is required by "only critical tests", not excluded by it.

**22. T3(b) is in the wrong task.** "Two store handles over one temp file; A holding `v7` is rejected with `PLEX_AUTH_STORE_VERSION_CONFLICT`" is a **`credential-store`** invariant, but the plan puts it in `jwt-provider.test.ts` (T-17) while T4 (T-13) has no version-conflict case. T-13 can therefore ship with a broken CAS and pass its own acceptance.
**Amendment:** move T3(b) into T-13/T4.

**23. AC-3's "revocation" and "clock skew" have no test.** Revocation is fixed by #21(iii). Skew: T3(d) covers only the `-30 s`/`-90 s` freshness boundaries; nothing asserts that a refresh which immediately reads expired emits `PLEX_AUTH_CLOCK_SKEW` rather than "token expired" (design §5.8 calls this the infinite-re-enrollment-loop guard).
**Amendment:** one case in T-17.

**24. Minor gold-plating in T5.** `JSON.stringify(adapter)` requires constructing a full `PlexAdapter` inside `jwt-provider.test.ts` — a cross-layer reach into T-19's composition. Move that single sink to T-20's T1 (where an adapter is already built) or drop it; the other six sinks are justified. Everything else in E is correctly scoped; no test task is gold-plated.

### Batch ownership: file-by-file result

I checked all 26 tasks path by path. **No two tasks name the same file** — the literal ownership table in §D is correct and complete for the files it lists. The collisions are logical, not textual, and are items **#1** (`normalizePlexOrigin`, unowned), **#8** (`src/types/index.ts`, unowned), **#17** (`sanitizeMessage` behavior owned by T-03, its only test owned by T-16), **#16** (gate entry owned by T-09, the file that makes it meaningful owned by T-14), and **#5** (shared-worktree global commands). Batch ordering is otherwise sound — the only dependency inversion is **#1**.

### AC-map (issue #251, all 10)

| AC                                                              | Delivered by                                                    | Status                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| 1 enroll w/o browser token                                      | T-18 + T-21 + T-23                                              | delivered, **untested** → #21                      |
| 2 stable identity + Ed25519 owner-only                          | T-04, T-13, T-01 (+T4, secure-store test)                       | ✅                                                 |
| 3 tests: acquisition/expiry/nonce/revocation/skew/cancel/atomic | T-17 (expiry, nonce, cancel), T-13/T-01 (atomic)                | **acquisition ✗, revocation ✗, skew ✗** → #21, #23 |
| 4 single-flight, no stale overwrite                             | T-17 T3(a)(c) + T-13 (after #22)                                | ✅ with #22                                        |
| 5 read retry ≤1, no mutation replay                             | T-16 T6 + query-library                                         | ✅                                                 |
| 6 typed/actionable/secret-free errors + rate limit              | T-06, T-05/T7, T-02, T-21 (A4.9)                                | ✅                                                 |
| 7 legacy compat + migration/rollback                            | T-12 (unmodified `auth.test.ts`/`types.test.ts`) + T-24         | ✅                                                 |
| 8 secrets absent everywhere                                     | T-07 T2, T-17 T5, T-08 (`FORBIDDEN_KEYS` + `plan.ts:884` fence) | ✅                                                 |
| 9 config/command/docs/3-shell completion tests                  | T-15, T-23, T-10, T-24                                          | ✅ with #7                                         |
| 10 typecheck/build/tests/architecture/security                  | §G                                                              | ✅ with #13                                        |

**Bottom line:** the plan is materially stronger than the design and its A1–A4 corrections are all verified true. Do not start implementation until #1–#5 are amended (they are correctness/compile blockers or make the plan unrunnable) and #21 is added (the only genuinely missing critical test).
