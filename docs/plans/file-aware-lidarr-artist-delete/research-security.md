# Security Research: File-Aware Lidarr Artist Delete

## Executive Summary

File-aware deletion is a high-impact, externally mutating workflow whose primary security boundary is not the CLI prompt alone, but a chain of independently verified authority, immutable plan identity, fresh Lidarr-reported disk evidence, and target-specific API behavior. The safest design treats every delete as a new authorization decision, confines deletion to Lidarr's remote API, never performs local filesystem deletion, never automatically retries mutations, and records only privacy-preserving evidence sufficient for explicit resume.

The plan/apply boundary must be cryptographically bound to an exact, versioned schema and canonical payload. Apply must revalidate the current target, credentials, endpoint capability, and Lidarr-reported path/statistics immediately before each mutation; uncertainty must fail closed. Plex scanning is a separate post-delete side effect and must not influence, authorize, or be included in retry/resume decisions for Lidarr deletion.

## Findings by Severity

### CRITICAL

- **Destructive authorization must be explicit and scoped to each execution.** Possession of a valid Lidarr API credential authenticates the caller but does not establish authority to delete every artist represented by a plan. A plan created under one credential, server, library, or user context must not silently authorize execution under another.
  - Mitigation: bind the plan to a non-secret target identity derived from the normalized Lidarr base URL, server identity/version when available, and library/root context. At apply time, authenticate again, verify the binding, and require an interactive destructive confirmation unless a deliberately supplied `--yes` is valid for this exact invocation.
  - Mitigation: reject redirects or endpoint changes that cross the normalized target origin. Never serialize API keys, authorization headers, cookies, or credential-derived values into plans, logs, errors, or reports.

- **`--yes` can create confused authority.** A global or inherited non-interactive flag can be mistaken for blanket permission to execute stale, broadened, or newly discovered destructive actions. It is especially dangerous if nested commands, environment-derived arguments, or resume behavior inherit it implicitly.
  - Mitigation: interpret `--yes` only as consent to the exact validated deletion set presented by the current plan checksum. Do not let it bypass target binding, schema validation, checksum validation, disk-evidence validation, endpoint capability checks, or per-target preconditions.
  - Mitigation: `--yes` must never imply consent to file deletion. Requests with `deleteFiles=true` require an independent, explicit `--allow-file-deletion` authorization that is represented in the checksummed plan and revalidated during apply.
  - Mitigation: reject `--yes` when the validated deletion set differs from the plan, when targets are added during apply, or when the plan cannot be rendered safely for operator review. Do not persist consent into resume artifacts.

- **Plan schema and checksum ambiguity can authorize altered operations.** Lenient parsing, ignored unknown fields, mutable defaults, or checksumming a non-canonical representation permits semantically different plans to share operator approval.
  - Mitigation: define an exact versioned schema with required fields, closed objects (`additionalProperties: false` or equivalent), bounded arrays and strings, explicit nullability, and deterministic ordering rules. Reject unknown schema versions and unknown operation kinds.
  - Mitigation: checksum a canonical encoding of every security-relevant field, including schema version, target binding, artist identifiers, expected paths/evidence, operation type, and endpoint expectations. Include a domain-separation prefix and checksum algorithm identifier; use a standard collision-resistant hash such as SHA-256 from the runtime cryptography library.
  - Mitigation: recompute and compare the checksum before any network mutation. Never "repair," normalize, or migrate a plan during apply; require regeneration and renewed approval.

- **Stale Lidarr disk evidence creates a TOCTOU deletion hazard.** Lidarr's knowledge of an artist's path and file statistics can change after planning or between validation and the delete request. Previously recorded statistics do not prove that the artist still has the same on-disk state.
  - Mitigation: issue fresh, targeted Lidarr reads immediately before each artist mutation and compare the returned path and statistics exactly with the checksummed plan evidence. rfmedia must use Lidarr as the authoritative evidence source and must not traverse, resolve, or stat local media paths itself.
  - Mitigation: treat missing fields, changed paths or statistics, ambiguous responses, artist identity mismatch, or evidence that cannot be obtained from Lidarr as a hard stop for that target. Do not substitute local filesystem observations or broader name-based searches.
  - Mitigation: do not combine validation for all targets into one early check. Revalidate each target just before its mutation and report the remaining targets as unattempted if a global invariant changes.

- **File deletion requires authority independent of ordinary confirmation.** Lidarr's artist delete endpoint may accept `deleteFiles=true`, which authorizes Lidarr to remove media in addition to deleting its database record. Ordinary deletion approval, including `--yes`, is insufficient for that broader effect.
  - Mitigation: default the remote request to `deleteFiles=false`. Set `deleteFiles=true` only when the exact plan authorizes file deletion and the current invocation independently supplies `--allow-file-deletion`; reject a flag/plan mismatch rather than silently changing the operation.
  - Mitigation: include the intended `deleteFiles` value in the canonical checksummed payload and display it prominently during review. Verify the outgoing request shape in contract tests and fail closed when the generated client cannot prove the requested semantics.
  - Mitigation: rfmedia must never directly invoke filesystem unlink, recursive removal, trash, shell deletion, or equivalent local operations. Any authorized file removal is requested through the target-specific Lidarr API and performed by Lidarr.

### WARNING

- **Endpoint behavior and identity must be verified per target.** Lidarr versions may differ in delete routes, identifier types, query parameters, and missing-resource responses. A single capability probe does not prove that every artist identifier maps to the intended remote object.
  - Mitigation: immediately before deletion, fetch the artist by its immutable Lidarr identifier and compare security-relevant identity fields from the plan. Use the generated client endpoint intended for that server version and construct requests from typed fields rather than string concatenation.
  - Mitigation: treat redirect, unexpected response shape, multiple matches, identifier mismatch, unsupported `deleteFiles` semantics, or any endpoint uncertainty as non-mutating failure for that target. Never fall back to name-based search or a broader endpoint.

- **Automatic mutation retries can duplicate or broaden destructive effects.** Network timeouts and connection resets leave the server outcome unknown; retrying a delete may operate against changed state or produce misleading resume records.
  - Mitigation: set mutation calls to zero automatic retries, including retries implemented by HTTP clients, interceptors, generated SDK wrappers, or generic command infrastructure.
  - Mitigation: after an indeterminate response, stop and classify the target as `outcome_unknown`. Require a read-only reconciliation on a later explicit resume before deciding whether any further mutation is appropriate.

- **Resume must treat a confirmed missing target as satisfied, not as a new delete opportunity.** A target may be absent because the prior request succeeded despite a lost response, because another actor removed it, or because the identifier no longer resolves. Blindly retrying undermines idempotency.
  - Mitigation: on resume, perform a target-bound read by immutable identifier. If the server authoritatively reports the same planned target is missing, mark the deletion step satisfied and do not send another delete.
  - Mitigation: distinguish authoritative not-found from authentication failure, transport failure, malformed response, and identity mismatch. These are not satisfied states and must fail closed.

- **Artifact paths and names can disclose private media information.** Plan, resume, debug, and error artifacts may reveal artist names, directory layouts, usernames, mount points, hostnames, or library organization even when credentials are omitted.
  - Mitigation: use opaque plan IDs and neutral default filenames; avoid artist names and absolute media paths in filenames. Store artifacts with user-only permissions and use atomic creation that does not follow symlinks.
  - Mitigation: minimize stored path data. Prefer salted or domain-separated path fingerprints plus only the bounded metadata required for revalidation. Redact home-directory prefixes, hostnames, query strings, and API credentials in terminal and structured logs.
  - Mitigation: document retention and deletion expectations. Resume artifacts must not be world-readable and must never be written inside the media library by default.

- **Terminal output is an injection boundary.** Artist names, server messages, paths, and HTTP errors can contain ANSI escape sequences or control characters that alter the display, spoof prompts, create clickable terminal links, or corrupt logs.
  - Mitigation: escape or strip C0/C1 controls, DEL, ANSI/OSC sequences, bidi controls, and untrusted newlines before human-readable output. Render values with visible quoting and bounded length.
  - Mitigation: keep machine-readable JSON structurally encoded and send diagnostics to the appropriate stream. Never construct terminal output through shell evaluation.

- **Plex scan side effects must be isolated from Lidarr deletion.** A scan is a separate authorization domain and can be expensive, privacy-sensitive, or unavailable. Coupling it to deletion retry logic can cause repeated scans or make a successful deletion appear failed and eligible for retry.
  - Mitigation: model Plex scanning as an optional, separately authorized post-delete phase with its own result and resume state. Start it only after the Lidarr outcome is conclusively successful or satisfied.
  - Mitigation: a Plex scan failure must not retry or roll back the Lidarr mutation. Do not send Lidarr paths or artist names to Plex unless the configured mapping and target identity are validated.

### ADVISORY

- **Least-privilege credentials reduce blast radius.** Use separate Lidarr and Plex credentials, each scoped as narrowly as those products permit. Do not accept a shared generic token field or reuse authorization headers between clients.

- **Audit records should prove decisions without reproducing sensitive inputs.** Record plan ID, schema/checksum algorithm, target fingerprint, timestamps, sanitized outcome codes, and whether consent was interactive or explicit. Avoid raw response bodies, full URLs with query parameters, artist names, and absolute paths.

- **Concurrency should be conservative.** Sequential per-target validation and mutation provides the clearest authorization and evidence boundary. If concurrency is later introduced, bound it tightly and ensure one target's failure, response, or evidence cannot be attributed to another.

- **Errors must preserve uncertainty.** Use distinct result states such as `deleted`, `already_missing`, `not_attempted`, `precondition_failed`, and `outcome_unknown`. Do not collapse uncertain outcomes into success or a generic retryable failure.

## Dependency Security

- Pin the generated Lidarr client toolchain and committed API snapshot to reviewed versions. Regeneration must produce a reviewable diff; runtime code must not fetch or trust a new schema during apply.
- Validate that the generated delete method exposes the exact `deleteFiles` control and expected status/error typing. Add contract tests around request method, path, immutable identifier, query/body fields, redirect behavior, the default false value, and the explicitly authorized true value.
- Use the runtime's standard cryptographic implementation for SHA-256 and constant-time comparison where available. Do not add a bespoke canonicalization or hashing package without a focused review of duplicate-key handling, Unicode normalization, numeric encoding, and deterministic object ordering.
- Audit HTTP dependencies and wrappers for implicit mutation retries, redirect following, proxy/environment inheritance, decompression limits, timeout defaults, and accidental logging of headers or bodies. Configure destructive requests explicitly rather than relying on shared read-client defaults.
- Do not add filesystem traversal, realpath, stat, shell, or glob dependencies for media evidence; fresh targeted Lidarr responses are authoritative. Use native filesystem APIs only for secure artifact handling, such as user-only permissions and atomic exclusive creation.
- Keep validation libraries pinned and test strict rejection of unknown fields, duplicate keys, unsupported schema versions, oversized artifacts, non-finite numbers, malformed Unicode, and checksum mismatches.
- Ensure Plex client dependencies are isolated from the Lidarr mutation path. Loading, authenticating, or failing the Plex client must not alter Lidarr request construction, success classification, or resume eligibility.
- Run dependency vulnerability and license checks in CI, but do not treat an automated audit as proof of destructive-operation safety. The generated API contract and configured client behavior require direct tests.
