===== REVIEW DIMENSION: security =====
SECURITY AND SECRET HYGIENE REVIEW — PR #291 (issue #251)

## Verified clean (the high-value checks)

- **Cross-origin guard is INTACT and unchanged.** `adapters/index.ts:217` is still a presence test on the RAW override object: `if (overrides?.plexUrl !== undefined && overrides.plexToken === undefined)`. It runs _before_ `selectPlexCredential`, so the new stored-credential source cannot unlock an origin change. Traced the MCP path: `mcp/adapters.ts` (unmodified) forwards `plexUrl`/`plexToken` into `createMediaServerAdapter`; if an untrusted caller supplies `plexUrl` alone the guard fires, and if it supplies `plexUrl` + `plexToken` then `selectPlexCredential` branch 1 returns the _caller's own_ token — the enrolled credential is unreachable. Pinned by `plex-adapter.test.ts:770` ("still rejects a changed-origin override when that origin IS enrolled"). No bypass found.
- **Credential cell enforces origin on every read AND every rotation.** `credential-cell.ts:77` checks `requestOrigin !== cell.origin || requestOrigin !== binding.origin`; `rotatePlexCredentialCell` re-uses `binding.origin` for the replacement record, so a rotated credential can never change origin. `jwt-provider.ts` always passes `this.#connection.origin`.
- **Nothing decodes an unverified JWT.** `jwt.ts` only signs. Expiry comes from `issuedAt + lifetimeSeconds` where `issuedAt` is the TLS-authenticated `Date` header and `lifetimeSeconds` is a server-declared field or the assumed constant — never a JWT claim. No trust/permission/endpoint decision reads token contents.
- **`enrollment-client.ts` origin is a module constant** (`PLEX_ACCOUNT_ORIGIN`) with a post-construction assertion (`buildAccountUrl:287`); no caller-facing origin seam exists. It never receives the PMS credential: its header set is `{Accept, X-Plex-Client-Identifier, X-Plex-Product, Content-Type}` — no `X-Plex-Token`.
- **No mutation is auto-replayed after a refresh.** `client.ts:248` `replayable = input.replayable ?? method === "GET"`, and `#handleNonSuccess:342` gates `handleAuthFailure` on `attempt.replayable`. All writes use POST/PUT/DELETE, and the three GET-transported scan triggers explicitly set `replayable: false` (`query-library.ts:619,632,650`).
- **File permissions actually work.** I ran the primitives directly: `0600` file + `0700` dirs under `umask 000`, `umask 022` and `umask 277`; and `replacePrivateFileAtomically` over a pre-existing **0666** target produces **0600** (it publishes a new inode via `rename`, it does not rely on `writeFile(mode)`). `stageTemporaryFile` uses `O_CREAT|O_EXCL|O_NOFOLLOW` + an explicit `handle.chmod`, and `prepareSafeParent` chmods any directory it created. A `0640` store is refused with `chmod 600`, not repaired.
- **Symlink/TOCTOU** — full component walk with `lstat` (symlink rejected at every level), `O_NOFOLLOW` on both read and staging opens, `{dev,ino}` re-assertion of both the file and the parent after every I/O step. A non-root attacker owning an ancestor cannot produce a final directory owned by our uid, and any swap is caught by `assertSafeParentUnchanged`.
- **No secret in `--json`.** `PlexAuthStatusResult`, `PlexEnrollmentResult`, `PlexRefreshResult`, `PlexForgetResult` carry no credential, key, code, or nonce. Store secrets live in module-private `WeakMap`s (`credential-store.ts:183`, `types.ts:98`), so they survive `JSON.stringify`/`util.inspect`/spread. `plan.ts` forbids `plexJwt`/`plexCredential`/`privateKey` keys. Cache keys are origin-scoped, not token-scoped.

## Findings

**SEVERITY: medium**
**FILE:LINE** `packages/rfmedia-cli/src/lib/adapters/plex/http.ts:34`
**CLAIM** `sanitizeMessage`'s documented "stage 2" — key/value redaction — does not match any of the wire shapes this feature actually produces (JSON quoted keys, `Bearer <jwt>`, PEM blocks), so the only working redaction is the caller-supplied `secrets` array, which is empty or incomplete on exactly the two calls that handle credential-bearing responses.
**FAILURE SCENARIO** I ran `sanitizeMessage` against real shapes with `secrets: []`:

- `Unexpected token in {"authToken":"eyJhbGci…c2lnbmF0dXJl","expires_in":600}` → returned **verbatim, unredacted**
- `bad body {"auth_token": "eyJ…"}` → **verbatim**
- `Authorization: Bearer eyJ…` → key redacted, **JWT survives** (`[REDACTED] eyJhbGci…`)
- `{"nonce":"abcdef0123456789"}` → **verbatim**
- `-----BEGIN PRIVATE KEY-----\nMC4CAQAw…` → **verbatim**
  Only `X-Plex-Token: …` and `?deviceJWT=…` are caught. Concretely: `enrollment-client.ts:463` passes `secrets: []` for `createNonce`, and `enrollment-client.ts:489` passes `secrets: [deviceJwt]` for `exchangeDeviceAssertion` — i.e. the _issued account credential_ returned by that call is in no secrets array. If a stream/transport error thrown out of `readBoundedBody` in `#readSuccessBody` (any non-`BodyLimitError`) carries partially-read body text, `#toAccountFailure` → `sanitizeMessage(error, [deviceJwt])` → `logDebug` prints the freshly issued JWT under `--debug`. Today no confirmed reachable path exists, because every body-parse failure is caught and replaced with a frozen `PLEX_AUTH_INVALID_RESPONSE`; the leak is one `logDebug(body)` or one new call site away, and the JSDoc at `http.ts:88-96` tells the next maintainer the pattern already covers this.
  **EVIDENCE**

```ts
const SENSITIVE_KEY_VALUE_PATTERN =
  /[\w-]*(?:x-plex-token|authorization|token|jwt|nonce|privatekey|pincode|code|secret|signature|assertion|refresh|devicejwt)[\w-]*\s*[:=]\s*[^\s,;]+/giu;
```

The `[\w-]*` after the alternation cannot cross the closing `"` of a JSON key, so `"authToken":"…"` never reaches the `[:=]`. There is no alternative for a quoted key, no `Bearer` alternative, and no PEM alternative. JSDoc claim: _"2. removal of `key: value` pairs whose key names authentication material"_.

---

**SEVERITY: low**
**FILE:LINE** `packages/rfmedia-cli/src/lib/secure-store/paths.ts:112`
**CLAIM** `assertSafeDirectory` inspects only group/other **write** bits, so a pre-existing store directory at mode `0755`/`0750` is silently accepted — neither tightened nor reported — contradicting both the documented "`0600`, in a `0700` directory" and the module's own stated contract that a failing directory "is reported, never chmod-ed back into shape".
**FAILURE SCENARIO** Operator (or a config-management tool) creates `~/.config/rfmedia/plex-auth` at `0755` before the first `rfmedia plex auth login`, or later runs `chmod -R go+rX ~/.config`. `prepareSafeParent` accepts it (I verified: `0755` parent accepted, no error). `rfmedia plex auth status` then prints `mode 600, owner-only` and reports no problem, so the operator has no signal that every local user can `stat` the store, learn the enrollment exists, and watch its mtime to observe each refresh. The credential itself stays protected by the `0600` file mode, so this is metadata exposure plus a silent divergence from the documented posture — not credential disclosure.
**EVIDENCE**

```ts
/** Group/other write bits: a directory carrying either is hijackable. */
const FOREIGN_WRITE_BITS = 0o022;
...
  if ((info.mode & FOREIGN_WRITE_BITS) !== 0) {
    throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, directory);
  }
```

Compare the file check three lines above, which correctly uses `FOREIGN_ACCESS_BITS = 0o077`.

---

**SEVERITY: low**
**FILE:LINE** `packages/rfmedia-cli/src/lib/adapters/plex/enrollment-client.ts:444`
**CLAIM** The device assertion — a bearer-equivalent secret that yields the account credential — is placed in a URL query string, the one thing the PMS transport explicitly forbids, and neither the module header's "SECRET HYGIENE" note nor the `plex auth` docs disclose it.
**FAILURE SCENARIO** During `plex auth login`, rfmedia polls `GET https://clients.plex.tv/api/v2/pins/<pinId>?deviceJWT=<compact JWS>` once per second for up to 1800 s. Anyone who can read that URL — plex.tv's own access/CDN logs, or a corporate TLS-terminating proxy — holds `(pinId, deviceJWT)`, and replaying that exact request after the user clicks approve returns the account `authToken` (`readPinClaim`). The assertion's own 1800 s lifetime exactly spans the strong pin's window, so the replay window is the whole enrollment. It is protocol-mandated (`deviceJWT` query param is marked VERIFIED in `jwt-wire.ts`) and the code does keep it out of local logs (`#toAccountFailure` logs `request.path` only, and `deviceJwt` is in `secrets`), so the residual risk is off-host — but the asymmetry with the PMS client is undocumented.
**EVIDENCE**

```ts
// enrollment-client.ts readPin
query: { deviceJWT: deviceJwt },
secrets: [deviceJwt],
```

versus `client.ts:22,142` for the PMS transport:

```ts
const SENSITIVE_QUERY_KEY_PATTERN = /(?:authorization|jwt|nonce|privatekey|token)/iu;
...
if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) {
  throw new TypeError("Plex request query must not contain authentication material");
}
```

## Non-findings checked and dismissed

- Six backward-compat files: **all untouched** (`git diff --name-only` returns none of them).
- `plex-auth-envelope.ts:198` passes only `getLoadedPlexConfig().token` to `redactErrorMessage`, not the enrolled JWT — traced every throw that reaches it (`PlexAuthError` frozen table, `PlexJwtWireError` frozen table, `MediaServerError` already sanitized with the live token in `client.ts`, `TypeError`s that never embed values). No reachable leak.
- `readStoredSigningKey` has no origin check, but both call sites (`jwt-provider.ts:434`, `enrollment-refresh.ts:146`) are gated first by `readStoredCredential(..., origin)` / `requireAuthorizedOrigin`, and the key is only ever used to sign an assertion for the constant plex.tv audience.
- `SENSITIVE_KEY_VALUE_PATTERN` is polynomial-backtracking on long word-char runs, but every message it sees is a short Node/undici transport error. Not worth reporting.
- Lock staleness is attacker-influenceable only by a same-uid process inside a `0700` directory — DoS-equivalent to `kill`, not a boundary crossing.
- Full suite for the touched areas passes: 20 files / 323 tests green (`vitest run src/lib/secure-store src/lib/adapters/plex src/lib/adapters/plex-adapter.test.ts src/commands/plex-auth.test.ts`). Worktree left clean.

===== REVIEW DIMENSION: concurrency =====
I have read all four target files plus the supporting modules (`paths.ts`, `credential-store-document.ts`, `credential-cell.ts`, `client.ts`, `types.ts`, `enrollment-client.ts`, `enrollment-refresh.ts`, `enrollment-support.ts`, `retry-after.ts`, `errors.ts`, `adapters/index.ts`, `action-helpers.ts`) and the existing tests.

---

## FINDINGS

### 1. SEVERITY: high

**FILE:** `packages/rfmedia-cli/src/lib/adapters/plex/jwt-provider.ts:237-247` (with `:482-499`, `:450-461`)

**CLAIM:** The proactive `getToken()` refresh path has no per-process cap and writes no cooperative backoff for any failure other than HTTP 429, so any repeatable refresh failure makes every subsequent `getToken()` spend one or two more nonces against the measured IP-scoped budget of 10 per 300 s.

**FAILURE SCENARIO:** Local clock is 400 s ahead of `clients.plex.tv` (NTP drift/VM resume). The stored credential is `refresh-soon`. `rfmedia copy … --plex-per-source` over 5 sources:

- source 1 → `adapter.scan()` → `PlexClient.request` → `getToken()` → state not `fresh` → `#refresh` → `#obtainFreshNonce` fetches nonce #1, `nowSeconds - receivedAt = 400 > 300` → re-fetch nonce #2 → still stale → `throw PlexAuthError("PLEX_AUTH_CLOCK_SKEW")`.
- `planCooperativeBackoff` rethrows (not `PLEX_AUTH_RATE_LIMITED`), so `mutate` throws, **zero mutations are written**, and the store is byte-identical.
- `PlexClient.request` loops to attempt 1 and calls `getToken()` again → 2 more nonces.
- After ~3 requests (2 getToken calls each) the 10-nonce/300 s IP budget is exhausted; plex.tv 429s the whole household IP for 5 minutes, affecting every Plex client behind it.

The same loop occurs for `PLEX_AUTH_INVALID_RESPONSE` — which is _expected to be reachable_ because U1/U2 (the token-response body shape) were never observed: there each `getToken()` spends exactly one nonce (nonce fetched + assertion exchanged, then `readTokenGrant` rejects the body).

`PLEX_MAX_REACTIVE_REFRESHES_PER_PROCESS = 2` guards only `handleAuthFailure`; nothing guards `getToken`.

**EVIDENCE:**

```ts
async getToken(options?: PlexCredentialRequestOptions): Promise<string> {
    try {
      const handle = this.#requireStore();
      if (handle.credentialState.kind === "fresh") {
        return this.#publish(readStoredCredential(handle, this.#connection.origin));
      }
      return await this.#refresh({ signal: options?.signal });   // <- no budget, no backoff
```

```ts
function planCooperativeBackoff(error: unknown, nowSeconds: number) {
  if (!(error instanceof PlexAuthError) || error.code !== "PLEX_AUTH_RATE_LIMITED") throw error;
```

```ts
  async #obtainFreshNonce(clientIdentifier, signal) {
    for (let attempt = 0; attempt < PLEX_MAX_NONCE_ATTEMPTS; attempt += 1) {
      const issue = await this.#account.createNonce({ clientIdentifier, signal });   // 2 nonces spent
      if (this.#nowSeconds() - issue.receivedAtEpochSeconds <= PLEX_NONCE_MAX_AGE_SECONDS) return issue;
    }
    throw new PlexAuthError("PLEX_AUTH_CLOCK_SKEW");
```

Contrast the module header, which asserts the opposite: _"A refresh spends one of an IP-scoped budget of ten nonces per 300 s, so burning a redundant one can lock a user out for five minutes."_

---

### 2. SEVERITY: high

**FILE:** `packages/rfmedia-cli/src/lib/adapters/plex/jwt-provider.ts:391-398`

**CLAIM:** The clock-skew branch **persists** the freshly issued credential (`mutations` is returned alongside the failure) even though it has just been computed as already expired, so the store is left in a state that guarantees the next `getToken()` refreshes again — an unbounded nonce-burn loop. The sibling implementation of the same rule in `enrollment-refresh.ts` correctly discards it.

**FAILURE SCENARIO:** plex.tv returns `expires_in: 100` on a nonce whose `Date` header is 200 s old (or the local clock is >lifetime ahead). `secondsRemaining = -100 <= -60` → the `issue` mutation is committed with `expiresAt = now-100`, `refreshNotBefore` reset to `0`, `version` bumped to 2, and `PLEX_AUTH_CLOCK_SKEW` is thrown. The next `getToken()` reads the store: `credentialState.kind === "expired"` → `#refresh` → another nonce → same outcome, forever. `jwt-provider.test.ts:293-308` pins exactly this state (`expect(handle?.version).toBe(2)`) without testing the follow-up call, so the loop is asserted-in rather than caught.

**EVIDENCE:**

```ts
// jwt-provider.ts
const secondsRemaining = issued.issuedAtEpochSeconds + issued.grant.lifetimeSeconds - nowSeconds;
if (secondsRemaining <= -PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS) {
  return {
    mutations, // <- credential IS written
    result: { kind: "failure", error: new PlexAuthError("PLEX_AUTH_CLOCK_SKEW") },
  };
}
```

```ts
// enrollment-refresh.ts:254-257 — same decision, opposite handling
const expiresAtEpochSeconds = issued.issuedAtEpochSeconds + issued.grant.lifetimeSeconds;
if (expiresAtEpochSeconds <= nowSeconds) {
  return { mutations: [], result: { kind: "clock-skew" } };
}
```

---

### 3. SEVERITY: medium

**FILE:** `packages/rfmedia-cli/src/lib/adapters/plex/jwt-provider.ts:66-71, 330-334` (with `lock.ts:47`)

**CLAIM:** `PLEX_REFRESH_BUDGET_MS` is documented as a hard ceiling "covering the cross-process lock wait AND both network calls", but it is only passed as `deadlineEpochMs` to `acquireExclusiveLock` — nothing bounds the network work performed _while the lock is held_. The maximum legal hold (135 s) exceeds `SECURE_STORE_LOCK_MAX_AGE_MS` (120 s), so a peer steals a lock whose owner is still mid-refresh.

**FAILURE SCENARIO:** Process A acquires the lock at T0 and enters `#issueCredential`. Worst legal path through `PlexEnrollmentClient.#send` is `15 s fetch timeout + ≤15 s honored Retry-After + 15 s fetch timeout = 45 s` per call; `#obtainFreshNonce` may make two `createNonce` calls (90 s) plus one `exchangeDeviceAssertion` (45 s) = **135 s**. Process B starts at T0+65 s (deadline T0+125 s), sees `nowEpochMs - Date.parse(createdAt) = 121 s > 120 s`, declares the lock stale, unlinks it and creates its own — while A is still exchanging. Both spend nonces. A publishes first (its CAS still passes); B's `assertVersionUnchanged` then fails and B's freshly issued credential is **discarded** with `PLEX_AUTH_STORE_VERSION_CONFLICT`. Net: 2 of 10 nonces burned for one usable credential, plus a user-visible failure. (The CAS does prevent a lost update — process A cannot overwrite a newer document written by B — so this is nonce waste and a spurious error, not data loss.)

**EVIDENCE:**

```ts
// jwt-provider.ts — the budget reaches only the lock wait
const outcome = await withPlexAuthStoreLock<PlexRefreshOutcome>(
  this.#storeDependencies(),
  { deadlineEpochMs: this.#now() + PLEX_REFRESH_BUDGET_MS, signal: request.signal },
  async (current) => this.#planRefresh(current, request), // unbounded network work inside
);
```

```ts
// lock.ts
export const SECURE_STORE_LOCK_MAX_AGE_MS = 120_000;
...
function isStale(record, host, nowEpochMs, isProcessAlive): boolean {
  if (record.host === host && !isProcessAlive(record.pid)) return true;
  return nowEpochMs - Date.parse(record.createdAt) > SECURE_STORE_LOCK_MAX_AGE_MS;
}
```

There is no heartbeat: `createdAt` is stamped once at acquisition and never refreshed.

---

### 4. SEVERITY: medium

**FILE:** `packages/rfmedia-cli/src/lib/adapters/plex/jwt-provider.ts:318-327`

**CLAIM:** `#refresh` joins an in-flight refresh unconditionally, ignoring `request.rejectedCredential`, so the reactive path can be handed back the exact credential the Plex Media Server just rejected. The joiner also never runs `#publish`, so on a second provider instance its connection cell keeps a stale credential and its origin is never checked against `authorizedOrigins`.

**FAILURE SCENARIO:** Store holds `K1`, written moments ago by a peer process, state `fresh`. Two concurrent replayable requests on the same adapter:

- R1 calls `getToken()`; it read the store before the peer's write (state `refresh-soon` on `K0`) so it enters `#refresh({ signal })` with **no** `rejectedCredential`, takes the lock, re-reads, sees `K1` fresh → adopts `K1`, zero network calls, promise still pending.
- R2's in-flight request with `K1` returns 401 (server-side revocation). `handleAuthFailure` finds `inFlightRefreshes.has(storePath) === true`, skips the budget, calls `#refresh({ rejectedCredential: K1 })` → `existing !== undefined` → returns R1's promise → resolves to **`K1`** → returns `"retry"`.
- R2 replays with the identical rejected `K1`, gets 401 again, and this time `allowAuthRetry === false`, so the user sees `Plex authentication failed (HTTP 401)` instead of a recovered request. The `#planRefresh` guard `held !== request.rejectedCredential` — whose whole purpose is this case — never executes for R2.

**EVIDENCE:**

```ts
#refresh(request: PlexRefreshRequest): Promise<string> {
    const existing = inFlightRefreshes.get(this.#storePath);
    if (existing !== undefined) return existing;      // <- request.rejectedCredential discarded
```

against the documented contract at `:164-172`:

```
 * A re-read that yields this exact value is NOT an adoptable peer refresh — it
 * is the credential that already failed — so the refresh proceeds.
```

and the "ONE DOOR" invariant at `:17-19` ("Every value this provider returns comes out of `getPlexConnectionToken`"), which the joiner return path bypasses.

---

### 5. SEVERITY: medium

**FILE:** `packages/rfmedia-cli/src/lib/adapters/plex/jwt-provider.ts:416` vs `enrollment-refresh.ts:166`

**CLAIM:** The two writers of the persisted `lastObservedSkewSeconds` field use **opposite sign conventions**, so the value has no single meaning and `plex auth status --output json`'s `clockSkewSeconds` flips sign depending on which code path last refreshed.

**FAILURE SCENARIO:** Local clock is 200 s ahead of plex.tv.

- An adapter-driven proactive refresh writes `+200`. (`jwt-provider.test.ts:306` pins `expect(handle?.lastObservedSkewSeconds).toBe(200)`.)
- The user then runs `rfmedia plex auth refresh`, which writes `-200` for the identical physical skew.
- `readPlexAuthStatus` surfaces `clockSkewSeconds` verbatim (`enrollment.ts:446`), so an operator diagnosing NTP drift is told the clock is 200 s _behind_ when it is 200 s _ahead_, and any tooling that thresholds on the sign misclassifies it.

**EVIDENCE:**

```ts
// jwt-provider.ts:416  — local minus plex
const observedSkewSeconds = this.#nowSeconds() - issue.receivedAtEpochSeconds;
```

```ts
// enrollment-refresh.ts:166 — plex minus local
observedSkewSeconds: issue.receivedAtEpochSeconds - epochSeconds(input.now),
```

Both feed the same `{ kind: "issue", observedSkewSeconds }` mutation, which sets `target.lastObservedSkewSeconds` (`credential-store-document.ts:318-320`).

---

### 6. SEVERITY: low

**FILE:** `packages/rfmedia-cli/src/lib/secure-store/lock.ts:325` (with `:165-179`)

**CLAIM:** An unparseable lock record throws before the staleness rule is ever consulted, so a corrupt/zero-byte `store.json.lock` permanently wedges every credential-store _write_ (refresh, login, logout) — the 120 s age rule that is documented as preventing "a permanent wedge" cannot reach it — and the resulting error mis-attributes the corruption to the credential store.

**FAILURE SCENARIO:** `~/.config/rfmedia/plex-auth/store.json.lock` is left empty (backup restore, `touch`, filesystem repair). Every `acquireExclusiveLock` call: `createPrivateFileAtomically` → `EEXIST` → `readExistingLock` → `JSON.parse("")` throws → `SECURE_STORE_CORRUPT`. `isStale` is never evaluated, so the lock is never stolen no matter how old. `asPlexAuthError` maps it to `PLEX_AUTH_STORE_CORRUPT`, whose message reads _"The Plex credential store could not be parsed as a valid store document"_ — the store is fine; the lock is the broken file. Every `plex auth refresh` and every proactive refresh fails identically until the user manually deletes the lock.

**EVIDENCE:**

```ts
    const existing = readExistingLock(path, subject);          // throws SECURE_STORE_CORRUPT
    let retryImmediately = existing === undefined;
    if (existing !== undefined && !hasStolen && isStale(existing.record, host, now(), isProcessAlive)) {
```

```ts
const record = parseLockRecord(parsed);
if (record === undefined) {
  throw secureStoreError("SECURE_STORE_CORRUPT", subject, lockPath);
}
```

against `lock.ts:43-46`: _"a reused pid or an `EPERM` … would otherwise wedge the lock forever"_ and `:125`: _"the age rule … prevents a permanent wedge."_

---

### 7. SEVERITY: low

**FILE:** `packages/rfmedia-cli/src/lib/secure-store/atomic.ts:122-131`

**CLAIM:** `createPrivateFileAtomically` publishes with `link()` and only unlinks the staging file afterwards, so a kill in that window orphans a `0o600` temp file containing the **full store document — private key and credential included** — and nothing ever cleans it up.

**FAILURE SCENARIO:** `rfmedia plex auth login` completes the PMS probe and performs the first store write. `link(temporaryPath, input.path)` succeeds; the process receives SIGKILL (or the shell is closed) before `removeIfPresent(temporaryPath)`. `~/.config/rfmedia/plex-auth/.plex-auth-store.<uuid>.tmp` remains forever with a full copy of `privateKeyPkcs8Pem` and `credential`. `rfmedia plex auth logout` unlinks only `store.json` (`credential-store.ts:425-432`), so the "destroys the local root of authority" guarantee of logout is false while an orphan exists. Repeated crashes accumulate copies. (`replacePrivateFileAtomically` is unaffected: `rename` consumes the temp.)

**EVIDENCE:**

```ts
    const identity = await stageTemporaryFile(temporaryPath, input.text, parent, input.subject);
    try {
      await link(temporaryPath, input.path);
    ...
    await assertOpenedFileIdentity(input.path, identity, input.subject);
    await assertSafeParentUnchanged(parent, input.subject);
    await removeIfPresent(temporaryPath);          // <- unreached on SIGKILL
```

---

## CLEAN IN THIS DIMENSION

- **Q1 (single-flight, 3× 401):** Correct. The `inFlightRefreshes.has()` check in `handleAuthFailure:269` and the `get`/`set` pair in `#refresh:319-325` are separated by no `await`, so no interleaving can double-enter. Exactly one nonce is spent for N concurrent 401s on one provider. The only defect is issue #4 (what the joiner receives), not the count.
- **Q2 (cross-process clobber):** No lost update. The CAS is real and is checked before the write commits: `assertVersionUnchanged` (`credential-store.ts:385-398`) re-reads under the lock and compares **both** `{dev,ino}` and `version`, and `replacePrivateFileAtomically` re-asserts `expectedIdentity` immediately before `rename` (`atomic.ts:160-161`). `version` is monotonic by construction (`credential-store-document.ts:366`: `(current?.version ?? 0) + 1`). Process A cannot overwrite a newer document written by B — it fails with `PLEX_AUTH_STORE_VERSION_CONFLICT` instead.
- **Q3 (loser adopts an expired credential):** Sound. Adoption is gated on `current.credentialState.kind === "fresh"` computed from `issuedAt + lifetimeSeconds` against the injected clock (`jwt-provider.ts:356-362`), never on the version — so a `back-off` / `authorize-origin` / `forget-origin` version bump cannot trigger adoption of a stale credential. `jwt-provider.test.ts:259-280` pins this. No spin: the loser either adopts or performs exactly one refresh.
- **Q4 (lock liveness, partial):** No deadlock, livelock or busy-spin. `LOCK_MAX_IMMEDIATE_RETRIES = 8` bounds no-sleep iterations even under a frozen injected clock; `hasStolen` makes the steal exactly-once per acquisition; backoff is jittered and clamped to the remaining deadline (`lock.ts:342-351`). Pid liveness is sound in the safe direction — `EPERM` is treated as _alive_ (`isProcessAliveByDefault:130-137`) and cross-host pids are never probed (`isStale:241`). Residual gaps are findings #3 and #6.
- **Q5 (atomic replace):** Correct. `rename(2)` is atomic w.r.t. readers; the directory is fsynced after both publication paths (`atomic.ts:132, 164`) and the file is fsynced before publication (`atomic.ts:90`). A reader cannot observe a truncated document: `readBoundedPrivateFileSync` (`paths.ts:326-347`) `fstat`s before and after the read and rejects a mid-read inode swap, then re-asserts the path identity and the parent directory. Residual gap is finding #7.
- **Q6 (cancellation):** Lock release is correct on every path. `runUnderStoreLock` wraps `mutate` in `try/finally { await lock.release() }` (`credential-store.ts:449-472`); an abort during the _wait_ throws from `acquireExclusiveLock` before any lock exists; `waitAbortable` (`lock.ts:216-233`) removes its `abort` listener on the timer path and clears the timer on the abort path, so neither leaks. Partial files are removed in the `catch` of both atomic writers. `jwt-provider.test.ts:310-337` proves release-on-abort with a real clock.
- **Q7 (sync store load per adapter construction):** Not a problem for copy runs — the adapter is constructed **once per run**, before the source loop, not per source:
  - `src/actions/copy-album.ts:1734` — `const { adapter: mediaServerAdapter, scanPerSource } = resolveOptionalScanAdapter({...})` sits above `for (const entry of sourceEntries)`.
  - `src/actions/copy-filter.ts:3037` — identical placement, comment reads `// Resolve media server adapter early for optional per-source scanning.`

  So a 10 000-album copy performs one `loadPlexAuthStoreSync` (one `lstat` walk + one bounded `openSync`/`readSync`), not 10 000. Actions that construct several adapters (`plex-playlist.ts:246, 361, 874, 989, 1351, 1521`) do so sequentially in distinct code paths, so the cost is a handful of reads per command. Note the ordering: `plexAuthStoreExistsSync` (`adapters/index.ts:208`) short-circuits to one `lstat` when a static token is configured, so non-enrolled installs pay nothing.

===== REVIEW DIMENSION: correctness =====
Verification scripts are at `/home/yandy/.claude/jobs/466c0bd0/tmp/` (`verify-jwt.mjs`, `verify-wire.mjs`, `verify-precedence.mjs`).

## Clean results (no findings)

**1. jwt.ts crypto — VERIFIED CORRECT, 16/16 checks.** `node --experimental-strip-types verify-jwt.mjs` against the shipped module: RFC 7638 §3.1 RSA vector reproduces `NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs` under the same canonicalization; RFC 8037 A.3 Ed25519 vector reproduces `kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k` through `jwkThumbprint()`; `x` re-derived from A.1's private `d` matches; any non-lexicographic member order yields a different digest (so order is load-bearing and correct); thumbprint is 43 chars `[A-Za-z0-9_-]`; all three JWS parts are unpadded base64url with no `=`/`+`/`/`; signature is exactly 64 bytes (RFC 8037 §3.1 raw form); the JWS verifies against the _published_ public JWK, fails on a tampered payload, and fails under a different key; non-ASCII payloads round-trip as UTF-8.

**2. `readTokenGrant` — correct.** Empirically accepts `auth_token` and `authToken` (snake wins when both present), throws `PlexJwtWireError` with bounded `observedKeys` when neither is present or the body is not a record. Both plex.tv error envelopes normalize without either throwing on the other (`{errors:[{code}]}` → `{httpStatus,code}`; `{error:"…"}` → `{httpStatus}`), as do `errors` being a string, `errors[0]` a string, an HTML body, an array body, and `undefined`.

**5. `replayable` — complete and correct.** All three scan-trigger sites are marked (`query-library.ts:619,632,650`); they are the only side-effecting `GET`s in the adapter (every other mutation is POST/PUT/DELETE, which default non-replayable via `input.replayable ?? method === "GET"`). No legitimate read lost its retry: `/library/sections`, `/`, `/library/sections/{id}/all`, `/library/metadata/{id}/children`, `identity.ts:190`, and the enrollment probe all keep the default. The advisory flag moves in lockstep at all four throw sites (`client.ts:359,376,401,413`).

**7. logout/status — correct.** `forgetPlexEnrollment` emits a lone `destroy` mutation → `destroyDocument` unlinks the single document holding _both_ the PKCS#8 key and the credential, then `syncDirectory`; `keyDestroyed` is only `true` when the file was actually removed, and `serverSideRevocation: "manual"` is never faked. `readPlexAuthStatus` projects only `kid`, `clientIdentifier`, `deviceName`, paths, mode bits, timings and origins — no `WeakMap` secret is ever read.

**Retry-After HTTP-date:** not a finding. Delta-seconds only is an explicitly recorded deferral (`retry-after.ts:14-22` and `docs/internal/plex-jwt-deferrals.md:164`); garbage/negative/HTTP-date → `undefined`; the 15 s in-process bound and the 900 s persisted bound are both applied. (`parseRetryAfter("")` → `0` rather than `undefined` is the only rough edge; harmless.)

---

## Findings

### 1. SEVERITY: high

**FILE:** `packages/rfmedia-cli/src/lib/adapters/index.ts:208`
**CLAIM:** An _empty-string_ `plexToken` override disengages the cross-origin credential guard whenever a Plex auth store file exists on disk, sending the configured `plex.token` to an arbitrary caller-supplied origin — a case `master` refuses outright.
**FAILURE SCENARIO:** Config has `plex.url: http://localhost:32400`, `plex.token: REAL-PLEX-TOKEN`, no `plex.auth.mode` (or `static`), and the user has run `plex auth login` at least once (so `~/.config/rfmedia/plex-auth/store.json` exists). An MCP client calls `plex_query` with `{plexUrl: "http://attacker.example", plexToken: ""}` (`mcp/schema.ts:363` is `schemaOptional(schemaString())` — no `minLength`, so `""` validates; `mcp/adapters.ts:294-295` forwards both raw). Trace: `staticToken = "" ?? token` → `""`, so `!staticToken` is `true`, but `!plexAuthStoreExistsSync(...)` is `false`, so the presence gate **passes**. The guard at `:217` tests `overrides.plexToken === undefined`, which is `false` for `""`, so it is **skipped**. `selectPlexCredential` then sees `if (cliToken)` falsy, falls through to branch 3, and returns `{kind:"static", token: "REAL-PLEX-TOKEN"}` bound to `http://attacker.example`. `verify-precedence.mjs` (faithful transcription of both revisions) prints: master `refused: missing`; branch `OK http://attacker.example <- static:REAL-PLEX-TOKEN`. The same input from the CLI is reached by `rfmedia plex query --plex-url "$URL" --plex-token "$TOKEN"` with `TOKEN` unset in CI.
**EVIDENCE:**

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

The comment's own claim is the bug: "with no store on disk this stays byte-identical to the legacy gate" — _with_ a store on disk it is not. The guard must stay a presence test (per the standing lesson), so the fix belongs in the gate at `:208`, not at `:217`.

---

### 2. SEVERITY: medium

**FILE:** `packages/rfmedia-cli/src/lib/adapters/plex/enrollment-client.ts:342`
**CLAIM:** HTTP 404 is classified as `PLEX_AUTH_ENROLLMENT_EXPIRED` for _every_ account endpoint, including the two the module itself flags as never-observed, even though the endpoint-scoped disambiguation mechanism (`keyRejectionCode`) already exists one branch below.
**FAILURE SCENARIO:** `PLEX_TOKEN_PATH = "/api/v2/auth/token"` is quarantined as U1 ("Documented token exchange. Its success body has NEVER been observed"), so a wrong path/version is exactly the expected failure. `rfmedia plex auth refresh` → `exchangeDeviceAssertion` → `POST /api/v2/auth/token` → 404 → `classifyWireFailure` returns `PLEX_AUTH_ENROLLMENT_EXPIRED` → the user is shown "The Plex authorization code expired before it was claimed." + "Run: rfmedia plex auth login". `login` uses only the pins endpoints, so it **succeeds**, minting a fresh Ed25519 key pair and a fresh client identifier (adding a device to plex.tv Authorized Devices and invalidating the old credential). The next `refresh` 404s identically. The loop is unbounded, and every iteration burns a pin plus a device registration. `createNonce` (`GET /api/v2/auth/nonce`) has the same exposure.
**EVIDENCE:**

```ts
if (status === 404) {
  // The only reachable 404 is an unknown pin (VERIFIED as code 1020), which
  // for the user means the authorization code is gone.
  return "PLEX_AUTH_ENROLLMENT_EXPIRED";
}
```

"The only reachable 404 is an unknown pin" holds only for `readPin`; `createNonce` and `exchangeDeviceAssertion` reach the same line. Two lines later the module already proves it knows how to scope per-endpoint: `return failure.code === PLEX_WIRE_CODE_JWK_NOT_FOUND ? keyRejectionCode : "PLEX_AUTH_INVALID_RESPONSE";`

---

### 3. SEVERITY: medium

**FILE:** `packages/rfmedia-cli/src/lib/adapters/plex/enrollment-refresh.ts:255`
**CLAIM:** On the clock-skew path `refreshPlexCredential` throws away a credential plex.tv already issued, writes zero mutations and no back-off, and uses a 0-second threshold — while the automatic provider path persists the same credential and uses a −60 s tolerance for the identical condition.
**FAILURE SCENARIO:** Host clock is a week slow (fresh VM, dead RTC, container without NTP). `rfmedia plex auth refresh` acquires the store lock, spends one nonce from the measured IP budget of 10/300 s, signs, and exchanges successfully. `expiresAtEpochSeconds = issuedAt(server Date) + lifetime` then compares `<= nowSeconds(local)` and returns `{mutations: [], ...}` — the brand-new credential is discarded, nothing is written, no `back-off` window is recorded. `PLEX_AUTH_CLOCK_SKEW`'s remediation is literally "Synchronize this system's clock, then run: rfmedia plex auth refresh", so a user or wrapper script re-runs; each re-run burns another nonce with zero persisted progress, and after ten the whole IP is rate-limited for 300 s. The same condition on the automatic path _does_ persist. The thresholds also diverge: a credential whose deadline is 30 s in the past is `clock-skew` here but a normal, persisted refresh in `jwt-provider.ts`.
**EVIDENCE:**
`enrollment-refresh.ts:254-257`

```ts
const expiresAtEpochSeconds = issued.issuedAtEpochSeconds + issued.grant.lifetimeSeconds;
if (expiresAtEpochSeconds <= nowSeconds) {
  return { mutations: [], result: { kind: "clock-skew" } };
}
```

versus `jwt-provider.ts:390-397`

```ts
const secondsRemaining = issued.issuedAtEpochSeconds + issued.grant.lifetimeSeconds - nowSeconds;
if (secondsRemaining <= -PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS) {
  return {
    mutations, // <-- the `issue` mutation IS written here
    result: { kind: "failure", error: new PlexAuthError("PLEX_AUTH_CLOCK_SKEW") },
  };
}
```

---

### 4. SEVERITY: medium

**FILE:** `packages/rfmedia-cli/src/lib/adapters/plex/enrollment-refresh.ts:166`
**CLAIM:** `observedSkewSeconds` is computed with **opposite sign** in the two code paths that write it to the same persisted field, so `plex auth status` reports the clock as fast or slow depending only on which path last refreshed.
**FAILURE SCENARIO:** Local clock is 600 s **ahead** of plex.tv. (a) A copy/query triggers the in-adapter rotation: `jwt-provider.ts:416` computes `local − server = +600`, persisted as `lastObservedSkewSeconds: 600`; `plex auth status` prints "Last observed clock skew 600s." (b) The user instead runs `rfmedia plex auth refresh`: `enrollment-refresh.ts:166` computes `server − local = −600`, persisted as `-600`; `plex auth status` prints "Last observed clock skew -600s." Same machine, same skew, inverted sign — and the operator uses this number to decide which way to correct NTP. Only the provider sign is pinned by a test (`jwt-provider.test.ts:306` expects `200` from `nonceReceivedAt: [NOW_SECONDS - 200]`); the refresh-verb sign has no test at all. `#warnOnceOnClockSkew` masks it with `Math.abs`, and the refresh verb emits no warning, so nothing catches the divergence.
**EVIDENCE:**
`enrollment-refresh.ts:164-167`

```ts
    issuedAtEpochSeconds: issue.receivedAtEpochSeconds,
    observedSkewSeconds: issue.receivedAtEpochSeconds - epochSeconds(input.now),
```

`jwt-provider.ts:416`

```ts
const observedSkewSeconds = this.#nowSeconds() - issue.receivedAtEpochSeconds;
```

Both feed the identical mutation field (`credential-store-document.ts:318-320` → `lastObservedSkewSeconds`), surfaced verbatim at `commands/plex-auth.ts:216`.

---

### 5. SEVERITY: medium

**FILE:** `packages/rfmedia-cli/src/lib/adapters/index.ts:208`
**CLAIM:** The first-run case for `plex.auth.mode: "jwt"` never reaches the `not-enrolled` branch; it is short-circuited by the presence gate into `missing`, whose message tells a JWT-mode user to set the exact credential that mode exists to retire.
**FAILURE SCENARIO:** User sets `plex.url` + `plex.auth.mode: "jwt"`, removes `plex.token`, and runs `rfmedia plex query …` _before_ `plex auth login`. At `:208` `staticToken` is `undefined` and `plexAuthStoreExistsSync` is `false`, so the gate returns `{reason: "missing"}` and `selectPlexCredential` — with the entire jwt branch and its `not-enrolled` reason — is never called. `requiredResolutionError("missing")` throws "Plex URL and token are required. Set in config or use --plex-url and --plex-token" instead of the reachable `PlexAuthError("PLEX_AUTH_NOT_ENROLLED")` whose remediation is "Run: rfmedia plex auth login". `verify-precedence.mjs` confirms: jwt mode + no store → `missing`; jwt mode + store present + origin unauthorized → `not-enrolled`. So the correct message only appears in the _rarer_ case (already enrolled, wrong origin), never on first run.
**EVIDENCE:** `:208` gate quoted above, versus the branch it makes unreachable at `:168-173`:

```ts
return (
  resolveEnrolledCredential(storeDependencies, origin, refreshMarginSeconds) ?? {
    ok: false,
    reason: "not-enrolled",
  }
);
```

---

### 6. SEVERITY: low

**FILE:** `packages/rfmedia-cli/src/lib/adapters/plex/enrollment.ts:357`
**CLAIM:** `enrollPlexClient` anchors the persisted expiry to the **local** clock, contradicting design D19 ("`issuedAt` comes from the HTTP `Date` header … with local fallback"), even though the transport already parses that header on the pin-claim response and simply drops it.
**FAILURE SCENARIO:** Host clock is 3 h fast at enrollment. Login persists `issuedAtEpochSeconds = local`, so `expiresAt = local + 518400`; after the first `refresh` the same field is rewritten from the **server** `Date` (`enrollment-refresh.ts:164`). `computeCredentialState` always compares against the local clock, so the store's expiry silently switches time frames between login and first refresh, and `plex auth status` reports a deadline that shifts by the skew for no user-visible reason. `PlexEnrollmentClient.#readObservedAt` runs on every 2xx (including `GET /api/v2/pins/<id>`), but `readPin` returns only `PlexPinClaim` and discards `response.observedAtEpochSeconds`, so the authenticated instant D19 asks for is computed and then thrown away.
**EVIDENCE:**

```ts
const issuedAtEpochSeconds = epochSeconds(now);
```

against `enrollment-client.ts:474-476`, where the value exists but never leaves the method:

```ts
return this.#readWire(() => this.#wire.readPinClaim(response.body));
```

---

### 7. SEVERITY: low

**FILE:** `packages/rfmedia-cli/src/commands/plex-auth.ts:249`
**CLAIM:** `PlexRefreshResult.retryAfterSeconds` is `null` at every producer, so this rendering branch is dead and the field is a permanently-null part of the `--output json` contract.
**FAILURE SCENARIO:** A user hits a persisted cooperative back-off and runs `rfmedia plex auth refresh --output json` expecting the documented "next rotation allowed in Ns" value. It never arrives: the rate-limited outcome does not _return_ a `PlexRefreshResult` at all — `refreshPlexCredential` re-throws `PlexAuthError("PLEX_AUTH_RATE_LIMITED")`, which is rendered by the _failure_ envelope instead. The only two `PlexRefreshResult` producers (`enrollment-refresh.ts:177` `adoptCurrentCredential`, `:278` the success object) both hard-code `retryAfterSeconds: null`, so `if (result.retryAfterSeconds !== null)` can never be true and the success envelope always carries `"retryAfterSeconds": null`.
**EVIDENCE:**

```ts
if (result.retryAfterSeconds !== null) {
  logInfo(`The next rotation is allowed in ${result.retryAfterSeconds}s.`);
}
```

versus `enrollment-refresh.ts:320-324`, the only path that has a number, which throws rather than returns:

```ts
if (outcome.kind === "rate-limited") {
  throw new PlexAuthError("PLEX_AUTH_RATE_LIMITED", {
    retryAfterSeconds: outcome.retryAfterSeconds,
  });
}
```

===== REVIEW DIMENSION: quality =====
All gates pass (typecheck, architecture check, 323 plex/secure-store tests, 244 completion/config tests). Findings below.

---

## FINDINGS

### 1. SEVERITY: high

**FILE:LINE:** `packages/rfmedia-cli/src/lib/adapters/plex/enrollment-refresh.ts:166` (vs `packages/rfmedia-cli/src/lib/adapters/plex/jwt-provider.ts:416`)

**CLAIM:** The two independently-written refresh pipelines compute `observedSkewSeconds` with **opposite signs**, and both write it to the same store field that `plex auth status` renders.

**FAILURE SCENARIO:** Host clock is 200s ahead of plex.tv. (a) A copy triggers the adapter's proactive refresh → `jwt-provider` stores `lastObservedSkewSeconds = +200`; `plex auth status` prints "Last observed clock skew 200s." (b) User instead runs `rfmedia plex auth refresh` → `enrollment-refresh` stores `-200`; `plex auth status` prints "Last observed clock skew -200s." Same physical skew, opposite sign, depending only on which code path happened to rotate. An operator using the sign to decide whether the host is ahead of or behind NTP is told the wrong direction half the time. `jwt-provider.ts:468` also renders the warning text `Local clock appears off by ~N seconds` using its own (opposite) convention, so the warning and the persisted value disagree.

**EVIDENCE:**

```ts
// jwt-provider.ts:416          (local − server)
const observedSkewSeconds = this.#nowSeconds() - issue.receivedAtEpochSeconds;

// enrollment-refresh.ts:166    (server − local)
observedSkewSeconds: issue.receivedAtEpochSeconds - epochSeconds(input.now),
```

Both feed the identical mutation (`credential-store-document.ts:318-320`: `target.lastObservedSkewSeconds = mutation.observedSkewSeconds`) surfaced as `clockSkewSeconds` by `enrollment.ts:446`. Only the `jwt-provider` convention is pinned by a test (`jwt-provider.test.ts:296,306`: nonce at `NOW_SECONDS - 200` → expects `+200`); the `enrollment-refresh` sign is untested, which is why the divergence shipped.

---

### 2. SEVERITY: medium

**FILE:LINE:** `packages/rfmedia-cli/src/lib/adapters/plex/enrollment-refresh.ts:255-257` (vs `packages/rfmedia-cli/src/lib/adapters/plex/jwt-provider.ts:391-398`)

**CLAIM:** The duplicated refresh pipeline also diverges on clock-skew handling: one path persists the freshly issued credential, the other silently discards it after burning a nonce — and the two use different skew thresholds.

**FAILURE SCENARIO:** Host clock is 30 minutes ahead. User runs `rfmedia plex auth refresh`: a nonce is spent (1 of the IP-scoped 10 per 300s), plex.tv issues a valid credential, `expiresAtEpochSeconds <= nowSeconds` fires, and the function returns `mutations: []` — the credential is thrown away and nothing is written. The user re-runs, burns another nonce, gets the same result, and after ~10 attempts is locked out for 5 minutes with no credential to show for it. The `jwt-provider` path in the identical situation returns `mutations` containing the `issue` mutation, so the credential _is_ persisted and the retry costs nothing. The thresholds also differ: `enrollment-refresh` uses `<= nowSeconds` (zero tolerance) while `jwt-provider` uses `<= -PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS` (60s grace), so a host 10 seconds off is a hard failure on one path and fine on the other.

**EVIDENCE:**

```ts
// enrollment-refresh.ts:254-257 — nonce spent, credential discarded
const expiresAtEpochSeconds = issued.issuedAtEpochSeconds + issued.grant.lifetimeSeconds;
if (expiresAtEpochSeconds <= nowSeconds) {
  return { mutations: [], result: { kind: "clock-skew" } };
}

// jwt-provider.ts:391-398 — credential persisted, 60s tolerance
const secondsRemaining = issued.issuedAtEpochSeconds + issued.grant.lifetimeSeconds - nowSeconds;
if (secondsRemaining <= -PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS) {
  return { mutations, result: { kind: "failure", error: new PlexAuthError("PLEX_AUTH_CLOCK_SKEW") } };
}
```

`jwt-provider.test.ts:307` pins `handle?.version).toBe(2)` — i.e. the write happened — for the provider path. No equivalent test exists for `enrollment-refresh`.

**Root cause common to findings 1 and 2 — duplicated refresh pipeline.** Four near-identical function pairs were written independently:

| concern                                                                | `enrollment-refresh.ts`             | `jwt-provider.ts`                 |
| ---------------------------------------------------------------------- | ----------------------------------- | --------------------------------- |
| stale-nonce re-fetch (2 attempts, 300s window, `PLEX_AUTH_CLOCK_SKEW`) | `requireFreshNonce` L102-118        | `#obtainFreshNonce` L450-461      |
| nonce → sign → exchange                                                | `issueRefreshedCredential` L129-168 | `#issueCredential` L411-440       |
| 429 → `back-off` mutation, `Math.min(retryAfter ?? CAP, CAP)`          | `toBackOffOutcome` L187-200         | `planCooperativeBackoff` L482-499 |
| locked decision (rate window → freshness → issue → skew)               | `decideRefresh` L211-282            | `#planRefresh` L346-401           |

A third divergence sits in the same seam: the refresh device assertion is signed with `ASSERTION_LIFETIME_SECONDS = 1800` (`enrollment-support.ts:40`) on one path and `PLEX_ASSERTION_LIFETIME_SECONDS = 60` (`jwt-provider.ts:77`) on the other, for the same operation. This is the one place in the change where the otherwise-strict single-authority discipline (`normalizePlexOrigin`, `parseRetryAfter`, `readBoundedBody`, `sanitizeMessage` are each single-sourced and correctly shared) was not applied.

---

### 3. SEVERITY: medium

**FILE:LINE:** `packages/rfmedia-cli/src/lib/adapters/plex/enrollment-refresh.ts:170-179` (rendered at `packages/rfmedia-cli/src/commands/plex-auth.ts:246-248`)

**CLAIM:** `singleFlightLeader: false` is returned on the ordinary "nothing to do" path, not only on the peer-adoption path, so `plex auth refresh` asserts a concurrent process rotated the credential when none exists.

**FAILURE SCENARIO:** Single machine, no other rfmedia process running, credential fresh (e.g. 5 days remaining). User runs `rfmedia plex auth refresh`. `decideRefresh` L233-235 takes the `state.kind === "fresh" && !force` branch → `adoptCurrentCredential` → `singleFlightLeader: false`. Output is:

```
No rotation performed (already-fresh).
Credential expires 2026-08-03T...
Adopted a credential rotated by a concurrent rfmedia process.
```

The last line is false. Machine consumers are misled the same way: the JSON envelope reports `singleFlightLeader: false` against a field documented as meaning a peer refresh occurred, so a script counting concurrent rotations over-reports on every no-op refresh.

**EVIDENCE:**

```ts
// enrollment-refresh.ts:170-179 — used for the plain no-op case, not just adoption
function adoptCurrentCredential(handle: PlexAuthStoreHandle): PlexRefreshResult {
  return Object.freeze({
    refreshed: false,
    reason: "already-fresh" as const,
    singleFlightLeader: false,
    ...

// enrollment-refresh.ts:233-235 — reached with no peer involved
if (state.kind === "fresh" && !input.force) {
  return { mutations: [], result: { kind: "done", result: adoptCurrentCredential(current) } };
}

// enrollment-refresh.ts:71-72 — the contract this violates
/** False when a peer's credential was adopted under the lock with zero calls. */
readonly singleFlightLeader: boolean;

// commands/plex-auth.ts:246-248
if (!result.singleFlightLeader) {
  logInfo("Adopted a credential rotated by a concurrent rfmedia process.");
}
```

No test covers `singleFlightLeader` (grep across `src/` finds only the three production sites).

---

### 4. SEVERITY: low

**FILE:LINE:** `packages/rfmedia-cli/src/lib/adapters/plex/credential-cell.ts:48`

**CLAIM:** `validateOpaqueCredential` is exported but imported by nothing — it is only called from two functions in its own module.

**FAILURE SCENARIO:** No runtime failure. It widens the private-adapter surface for no consumer: a future contributor can call it directly and bypass `readPlexCredentialCell`'s origin binding, which is the exact "one door for the origin guard" invariant the module header (L8-11) exists to protect. It moved here verbatim from `auth.ts`, where it was correctly module-private (see the diff: `auth.ts` previously had `function validateOpaqueCredential` with no `export`); the `export` was added during the move without a caller needing it.

**EVIDENCE:**

```ts
// credential-cell.ts:48 — was `function validateOpaqueCredential` (no export) in auth.ts
export function validateOpaqueCredential(token: string): string {
```

Only call sites are `readPlexCredentialCell` (L130) and `rotatePlexCredentialCell` (L158), both in the same file. `grep -rlw validateOpaqueCredential src` outside `credential-cell.ts` → 0 files.

---

## Dimensions that came back clean

- **Backward-compat non-modification:** all six protected files are byte-identical to `master` (`git diff master...HEAD --stat` on them returns empty). No violation.
- **Cross-origin credential guard:** intact and still a presence test on raw overrides — `adapters/index.ts:217`: `if (overrides?.plexUrl !== undefined && overrides.plexToken === undefined)`. Credential selection was correctly ordered _after_ the guard (L225), so an enrolled credential cannot unlock an origin change.
- **Selective catch in `client.ts` `#getToken`:** the design's fix landed. `client.ts:278-287` rethrows `MediaServerError` unchanged and only collapses genuinely unclassified throws to the fixed configuration message — actionability preserved.
- **Type safety:** zero `any`, zero `as unknown as`, zero non-null assertions, zero missing `.js` extensions across every new module. All `import type` correctly marked.
- **Duplication (other than finding 2):** `parseRetryAfter` is single-sourced in `lib/retry-after.ts` with `lidarr/errors.ts:251` re-exporting rather than copying; `normalizePlexOrigin` is single-sourced in `lib/plex-origin.ts` and imported by both the resolver and the verbs; base64url exists once (`jwt.ts:43`); `readBoundedBody`/`composeAbortSignals`/`sanitizeMessage` are shared by both HTTP owners via `plex/http.ts`. No accidental second copies.
- **JSDoc:** every exported symbol in the new modules is documented; the only bare `export` lines are pure re-exports documented at their definition site.
- **Deferred protocol members:** `PlexAccountProtocol.registerJwkWithLegacyToken` / `revokeDevice` / `exchangeServerAccessToken` (`enrollment-client.ts:191-217`) are optional-typed so callers must use `?.`, each with a JSDoc stating _why_ it is deferred. `PLEX_JWK_PATH` (`jwt-wire.ts:43`) is likewise documented as deliberately unused. Correctly handled, not silently broken.
- **Command/action separation:** `commands/plex-auth.ts` uses lazy `await import("../actions/plex-auth.js")` in all four actions, validates nothing itself, and owns rendering + `process.exitCode`; the action layer never writes stdout. Matches the repo convention and the lesson about Commander `argParser` (none registered; pinned by `plex-auth.test.ts:152-158`).
- **File sizes:** new files over 500 lines are `enrollment-client.ts` (673), `jwt-wire.ts` (600), `credential-store.ts` (508), `enrollment.ts` (506). `jwt-wire.ts` is ~200 lines of protocol documentation over a flat table of pure readers — defensible as contiguous. `enrollment-client.ts` is constrained by the `FETCH_OWNERS` gate requiring exactly one request call site in the file, so splitting it would fight the architecture check. Both acceptable; not flagged.
- **Tests:** no gold-plating found — no test asserts `Object.freeze`, and no test merely re-states a frozen table. `jwt-wire.test.ts`, `http.test.ts`, and `jwt.test.ts` each pin a real invariant (U1/U2 tolerance, the `refresh_token` word-boundary regression, the RFC 8037 known-answer vector). The gaps are the ones named in findings 1–3: the `enrollment-refresh` skew sign, its clock-skew discard, and `singleFlightLeader` are all untested.

===== REVIEW DIMENSION: surface =====

## VERIFIED CLEAN

- **Non-modification invariant holds.** `git diff master...HEAD --name-only` matches none of the six protected files (`plex/auth.test.ts`, `plex/types.test.ts`, `mcp/schema.spec.ts`, `mcp/adapters.spec.ts`, `lidarr/profile-preset-persistence.test.ts`, `scripts/check-direct-plex-imports.test.mjs`). No critical finding.
- **Completions work in all three shells.** Generated and executed: `bash -n` exit 0, `zsh -n` exit 0. Drove real bash completion (via `/usr/share/bash-completion/bash_completion` + `COMP_WORDS`) and real zsh completion (via a pty + `compinit`): `plex auth <TAB>` → login/status/refresh/logout, and each leaf's flags complete correctly in both. Leaves, flags, and descriptions are identical across bash/zsh/fish and match the Commander `.description()` strings verbatim. The `-z "$subcmd"` guard added to `bash.ts:208` is a net fix — `rfmedia plex query run -<TAB>` produced _nothing_ on master and now produces the full option list.
- **`templates.spec.ts` genuinely locks the surface**, not loosened: `plexCommandTree.auth` feeds the order-sensitive cross-shell assertion at `templates.spec.ts:477-484`, and the new test at :1453 pins exact bash candidate arrays plus verbatim zsh/fish strings. All 300 tests in `templates.spec.ts`/`plex-auth.test.ts`/`plex.test.ts`/`config.test.ts` pass.
- **Validation placement is correct.** No `argParser` anywhere in `commands/plex-auth.ts`; `plex-auth.test.ts:152` asserts `option.parseArg` is `undefined` on every option of every leaf. Confirmed live: `plex auth refresh --timeout abc` → `PLEX_AUTH_ARGUMENT_INVALID` envelope, `process.exitCode = 1`, no `process.exit`.
- **CLI output quality is good.** Non-enrolled text output is sane and secret-free; `--json`/`--output yaml|csv` all emit valid structured output on both success _and_ error paths with exit 1; `--output table`/`text` fall back to human rendering, matching the repo-wide `isMachineFormat` convention (`formatters/index.ts:79`). `--plex-url ""` (unset CI var) fails loudly rather than falling back.
- **Config validation has real bounds** (mode enum, `refreshMarginSeconds` 60–86400, non-object `plex.auth` rejected), all throwing typed `ConfigError` with correct `propertyPath`, covered by ~15 new cases in `config.test.ts`. Not adding `plex.auth` to `buildConfigTemplate` is deliberate and documented (`buildConfigTemplate` cannot carry comments). `prettier --check` passes on all 13 changed docs; `check:architecture` passes.

---

## FINDINGS

### 1. Docs assert a working invocation is broken — `--output json` / `--json` after the subcommand

**SEVERITY:** medium
**FILE:LINE:** `packages/rfmedia-cli/docs/features/plex-configuration.md:337-342`, `packages/rfmedia-cli/README.md:3916-3921`, `packages/rfmedia-cli/CLAUDE.md:1111`, `packages/rfmedia-cli/AGENTS.md:1075`, `packages/rfmedia-cli/src/commands/plex-auth.ts:87`

**CLAIM:** Four documents and the command's own JSDoc state that `rfmedia plex auth status --output json` is "NOT parsed as JSON" and that the flag "must precede the subcommand" — it is parsed, in every format.

**FAILURE SCENARIO:** An operator writing a monitoring script reads the code block, believes trailing `--output json` is unsupported, and rewrites working automation (or, worse, treats a correct JSON response as a bug and files one). Measured on this branch with `RFMEDIA_PLEX_AUTH_DIR` pointed at a clean 0700 dir:

```
$ npx tsx src/cli.ts plex auth status --output json
{ "command": "plex-auth-status", "result": { "enrolled": false, ... } }      # exit 0
$ npx tsx src/cli.ts plex auth status --output yaml
command: plex-auth-status                                                     # exit 0
$ npx tsx src/cli.ts plex auth status --json
{ "command": "plex-auth-status", "result": { ... } }                          # exit 0
```

Mechanism: `--json` and `--output` are declared on `program` (`cli.ts:82,86`) and Commander is not in positional-options mode, so a trailing occurrence is still bound to the root; `root.getOptionValueSource("output") === "cli"` is then true regardless of position, and the `preAction` hook writes `opts["output"] = resolvedOutput` onto the root (`cli.ts:195`), which is exactly what `resolveOutputFormat()` reads.

**EVIDENCE:**

```md
`--output json` (and `--json`) are honored on the **root** command only, so the flag must precede
the subcommand:

rfmedia --output json plex auth status # correct
rfmedia plex auth status --output json # NOT parsed as JSON
```

```ts
// commands/plex-auth.ts:86-88
 * `--output` is reconciled against `--json` by `cli.ts`'s `preAction` hook, and
 * is only honoured on the ROOT command, so `--output json` must precede `plex`.
```

---

### 2. A typo in the new `plex.auth` block silently discards the whole config file and falls through to another Plex server

**SEVERITY:** medium
**FILE:LINE:** `packages/rfmedia-cli/src/lib/config.ts:1147` (`validatePlexAuthConfigOptions`, reached from `:1305`), consumed by `loadConfig` at `packages/rfmedia-cli/src/lib/config.ts:4172-4174`

**CLAIM:** The new credential-policy validators throw `ConfigError`, and `loadConfig` treats any `ConfigError` as "skip this file and keep searching" — so a one-character mistake in `plex.auth.mode` silently swaps the entire Plex connection (URL _and_ token) for whatever the next config in the search path holds, with exit code 0.

**FAILURE SCENARIO:** Reproduced end-to-end. `~/.rfmedia.yaml` holds `url: http://home-fallback-server:32400`, `token: HOME_TOKEN`. The project's `./.rfmedia.yaml` holds `url: http://project-server:32400`, `token: PROJECT_TOKEN`, `auth: {mode: JWT}` (uppercase — YAML does not normalize it). Run from the project dir:

```
[WARN] Config validation error in /tmp/rfproj/.rfmedia.yaml: Invalid credential mode for plex.auth.mode: JWT. Valid modes: static, jwt
{ "command": "plex-auth-status",
  "result": { "enrolled": false, "origin": "http://home-fallback-server:32400" } }
EXIT=0
```

`origin` is the _home_ server. Since `requireOrigin()` (`actions/plex-auth.ts:165`) reads `getLoadedPlexConfig().url`, the very next command — `rfmedia plex auth login` — enrolls the device against `home-fallback-server` while the operator believes they are enrolling against `project-server`. The same fall-through applies to `refreshMarginSeconds` out of range and to a non-object `auth` block, and to every non-auth command (`plex copy`, `plex sync push`) which will now talk to the fallback server with `HOME_TOKEN`.

This is the exact hazard the PR author identified and deliberately routed _around_ for the jwt/token ambiguity case, but then reintroduced through the new `ConfigError` sites:

**EVIDENCE:**

```ts
// lib/adapters/index.ts — selectPlexCredential JSDoc
 * A `mode: "jwt"` config that also sets `plex.token` is reported as
 * `ambiguous-credential` rather than resolved, and deliberately not as a
 * `ConfigError`: `loadConfig` warns and falls through to the next search path on
 * a `ConfigError`, which could silently select different credentials.
```

```ts
// lib/config.ts:4172-4174
if (err instanceof ConfigError) {
  logWarn(`Config validation error in ${err.configPath}: ${err.message}`);
  continue;
}
```

```ts
// lib/config.ts:1152-1160 — one of the new throw sites
    if (typeof mode !== "string" || !VALID_PLEX_AUTH_MODES.includes(mode as "static" | "jwt")) {
      throw new ConfigError(
        `Invalid credential mode for plex.auth.mode: ${String(mode)}. ` + ...
```

(The `loadConfig` behavior is pre-existing and repo-wide; what is new is applying it to the credential-source policy block, where the consequence is a silent server/credential swap rather than a lost formatting preference.)

---

### 3. ROADMAP header count no longer reconciles with its own tables

**SEVERITY:** low
**FILE:LINE:** `ROADMAP.md:10` (with stale rows at `:38`, `:59`, `:199`)

**CLAIM:** `**Open issues:** 87 (rfapps 40 · rfmedia 47)` does not match the document's own section counts, which sum to 88 (rfapps 9 + 31 = 40 ✓; rfmedia 13 + 3 + 9 + 23 = **48**, not 47). On master the header and tables agreed (40 + 45 = 85); this PR's header edit breaks that.

**FAILURE SCENARIO:** The `## Maintenance` section tells the next maintainer to regenerate counts with `gh issue list`; they get 87 post-merge, see the tables sum to 88, and cannot tell which is authoritative. Root cause: #208 was closed 2026-07-28T04:41Z (verified via `gh issue view 208 --json state` → `CLOSED`) but is still listed as **Sprint 1, Order 1** in Next Up, in the Phase D table, and in the Layer 3 diagram, and the "Current focus" prose still calls it "the next dependency for Layer 3 intelligence". Scripted reconciliation confirms it: of the 88 table rows, the only one not open on GitHub is #208, and the only open issue absent from the tables is #251 (correct — it closes on merge).

**EVIDENCE:**

```md
ROADMAP.md:10 **Open issues:** 87 (rfapps 40 · rfmedia 47)
ROADMAP.md:59 | 1 | [#208](...) Reconciliation & gap analysis | Turns the shipped identity bridge into actionable gaps |
ROADMAP.md:160 ### Medium priority — copy, verify & metadata (13)
ROADMAP.md:217 ### Low priority — docs, polish & future ideas (23)
```

---

### 4. `plex auth status` never prints `lockPath` in the default (text) mode the docs point users to

**SEVERITY:** low
**FILE:LINE:** `packages/rfmedia-cli/src/commands/plex-auth.ts:197-228` (`renderStatus`), versus `packages/rfmedia-cli/docs/features/plex-configuration.md:377` and `:658`

**CLAIM:** Two doc tables tell an operator that `plex auth status` reports `lockPath`, but the human renderer prints `storePath`, `storeMode`, credential state, skew, and origins — never `lockPath`. Only `--output json|yaml|csv` exposes it.

**FAILURE SCENARIO:** `plex auth refresh` fails with `PLEX_AUTH_REFRESH_BUSY`. Following the doc's table row, the operator runs `rfmedia plex auth status` (text mode, the default) to find the lock file to inspect or delete, and the field is simply absent from the output with no hint that a machine format is required.

**EVIDENCE:**

```md
| Lock file | `<storePath>.lock`, reported by `plex auth status` as `lockPath` |
| `PLEX_AUTH_REFRESH_BUSY` | Another rfmedia process holds the lock named by `status`'s `lockPath` |
```

```ts
logInfo(
  `Store ${result.storePath} (mode ${result.storeMode}${result.storeOwnerOnly ? ", owner-only" : ", NOT owner-only"})`,
); // ...no lockPath anywhere in renderStatus
```

(Mitigated: `PLEX_AUTH_REFRESH_BUSY`'s own remediation interpolates the path — `"…delete the stale lock file at {path}."` — so the user is not blocked, only misdirected.)

---

### 5. `--timeout` value candidates exist in zsh and fish but not bash; the spec locks the asymmetry in

**SEVERITY:** low
**FILE:LINE:** `packages/rfmedia-cli/src/lib/shell-completions/bash.ts:112` (and the `case "$prev"` block, generated script line 273), versus `zsh.ts` `'--timeout[…]:seconds:(60 120 300 900)'` and `fish.ts` `-l timeout … -xa "60 120 300 900"`

**CLAIM:** bash offers `--timeout` as a _flag_ candidate but has no `--timeout)` arm in its `case "$prev"` value dispatch, so `rfmedia plex auth login --timeout <TAB>` yields nothing, while zsh and fish both suggest `60 120 300 900`. `templates.spec.ts:1453` asserts the zsh and fish candidate lists explicitly but has no bash counterpart, so the gap is now pinned by test.

**FAILURE SCENARIO:** bash user types `rfmedia plex auth login --timeout <TAB>`, gets an empty completion, and has to read `--help` to learn the units/range — while a zsh or fish user on the same build is handed the four suggested values. Measured with the real bash-completion harness: `COMPREPLY` is empty. bash _does_ have this convention for other numeric flags, so the omission is a deviation from the file's own pattern, not a shell limitation:

**EVIDENCE:**

```bash
# generated bash, line 320-327 — the established pattern
    --max-per-seed)
      COMPREPLY=($(compgen -W "1 5 10 25 50 100" -- "$cur"))
      return ;;
    --max-add)
      COMPREPLY=($(compgen -W "1 2 5 10 25" -- "$cur"))
      return ;;
```

```
$ grep -n '\-\-timeout' generated-rfmedia.bash
102:  local plex_auth_login_opts="--plex-url --device-name --timeout -y --yes"
104:  local plex_auth_refresh_opts="--plex-url --timeout --force"      # …and nowhere else
```

(Note: `--limit` has the same bash/zsh asymmetry on master, so the _class_ of gap is pre-existing; this PR adds a new instance and tests around it.)
