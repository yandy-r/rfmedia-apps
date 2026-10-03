# Security Research: Tag Preservation During Conversion

## Executive Summary

Issue #42 adds no network, authentication, database, or secrets boundary. Its security boundary is
local but meaningful: potentially hostile media bytes, tag keys and values, artwork buffers, paths,
and FFmpeg diagnostics enter a privileged local CLI process that can consume CPU/memory and replace
files with the user's permissions.

The current lockfile contains a direct, high-severity denial-of-service vulnerability in
`music-metadata` 11.10.6 and two affected `file-type` 21.3.0 paths. Because this feature would invoke
cover-aware metadata parsing for every conversion, the vulnerable parser upgrade is a hard stop.
Safe delivery also requires shell-free FFmpeg argument handling and private, identity-checked,
same-directory staging; otherwise malicious values or filesystem races can become command execution
or arbitrary file clobbering. Resource bounds, log redaction, cancellation coverage, and dependency
verification are warning-level requirements that must be resolved before shipping.

## Threat Model and Trust Boundaries

| Boundary                          | Untrusted or variable input                                                | Privileged operation                            | Primary risk                                                            |
| --------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| Media file to `music-metadata`    | Container headers, tag counts, lengths, encodings, pictures, native values | In-process parsing and buffer allocation        | Infinite loop, CPU/memory exhaustion, parser exception                  |
| Media file to FFmpeg              | Codec/container payloads, attached-picture streams, malformed timestamps   | Native child process reads and decodes media    | Native parser vulnerability, process hang/crash, disk exhaustion        |
| Metadata to target mapping        | Keys, values, encodings, POPM identity/counter, picture type and MIME      | Serialization into target tags or FFmpeg inputs | Argument/config injection, truncation, unexpected semantic control      |
| CLI/action paths to filesystem    | Source and destination names, symlinks, hardlinks, writable parents        | Create, truncate, rename, and replace files     | Path escape, source clobber, symlink/TOCTOU overwrite                   |
| Child-process diagnostics to logs | FFmpeg stderr, filenames, tag names, parser errors                         | Terminal/stderr and debug logging               | Control-sequence injection, sensitive metadata disclosure, log flooding |
| Temporary artifact to final file  | Full converted media and copied personal metadata                          | Same-directory staged commit                    | World-readable temporary data, stale partials, replacement race         |
| Dependency/runtime boundary       | npm parser/writer packages and system FFmpeg selected from `PATH`          | Executes third-party JavaScript and native code | Known CVEs, supply-chain compromise, inconsistent runtime capabilities  |

The realistic attacker is someone able to place or modify a media file in a scanned source tree, or
to influence a path in a directory processed by the CLI. The feature should not assume that a file
is trustworthy because its extension is familiar or because a local operator initiated the copy.
An attacker who already controls the user's account is out of scope, but another principal with
write access to a shared source or destination directory is in scope.

## Findings by Severity

### CRITICAL — Hard Stops

| ID      | Finding                                                                                                                                                                                                                                                 | Risk                                                                                                                                                                                                            | Required mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-C01 | The lockfile resolves `music-metadata` 11.10.6, affected by high-severity CVE-2026-32256, and `file-type` 21.3.0, affected by CVE-2026-31808 and CVE-2026-32630. The planned `parseFile()` call expands exposure to all conversions, including WMA/ASF. | A tiny crafted file can indefinitely block the Node event loop; other crafted inputs can consume excessive memory. Cancellation cannot recover an in-process infinite loop.                                     | Upgrade and lock `music-metadata` to a patched current release, recommended 11.14.0, whose dependency requires `file-type ^21.3.4`. Require at least `music-metadata >=11.12.3` and `file-type >=21.3.2`, refresh the lockfile, rerun the conversion fixtures, and prove the conversion dependency chain is clear in a fresh audit before merge.                                                                                                                       |
| SEC-C02 | Metadata or paths must not be interpolated into a shell command, shell-enabled spawn, or executable command string.                                                                                                                                     | A crafted filename or tag can execute commands with the CLI user's permissions.                                                                                                                                 | Retain `spawn(executable, argv, { shell: false })`; use one argv element per option/value; keep codec/muxer options in typed allowlists; never pass raw arbitrary tag bags as option tokens. Replace the fixed-string availability `exec()` opportunistically, but do not introduce any value-bearing `exec()` call. Tests must cover spaces, leading dashes, quotes, newlines, Unicode, and shell metacharacters without shell interpretation.                        |
| SEC-C03 | Direct `ffmpeg -y <final-destination>` plus later tag writes cannot provide a safe multi-stage transaction and follows filesystem names at each open.                                                                                                   | Failure or cancellation can destroy a prior destination; source/destination aliasing or a symlink/race can redirect writes to another file. A completed audio stream can be exposed before metadata validation. | Materialize to a random same-directory stage created exclusively with `open(..., "wx", 0o600)`, preserve and recheck parent/stage/destination identities, validate the complete artifact, flush it, and atomically rename only at commit. Reuse or extend `replaceFileWithValidatedStage()` rather than recreating weaker staging. Reject a non-regular/symlink destination and any source/destination identity collision. No caller may observe the stage as success. |

These three findings block implementation approval. They are not target-format warnings and cannot
be deferred or converted into best-effort behavior.

### WARNING — Must Address

| ID      | Finding                                                                                                                                                                                                    | Risk                                                                                                                                                       | Suggested mitigation                                                                                                                                                                                                                                                                                                                                                                                                                      | Alternatives                                                                                                                                                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SEC-W01 | Cover-aware parsing and arbitrary tag preservation are currently unbounded.                                                                                                                                | Many pictures, oversized comments, base64 Opus artwork, or parallel workers can exhaust memory, exceed `ARG_MAX`, flood logs, or fill disk.                | Centralize tested ceilings. Suggested initial limits: 16 pictures, 16 MiB per picture, 32 MiB total picture bytes; 4,096 text tags, 255 UTF-8 bytes per key, 1 MiB per value, and 8 MiB aggregate text. Reject a source when the canonical snapshot cannot be trusted; otherwise omit an over-limit optional field with one safe warning. Never place picture/base64 or arbitrary long values in argv.                                    | Raise documented constants after representative-library tests, or isolate metadata parsing/writing in a memory-limited worker. Unbounded processing is not an acceptable alternative.                                                                              |
| SEC-W02 | Native tag values are `unknown`, while FFmpeg metadata files and Vorbis/ID3 serializers have control syntax.                                                                                               | NUL, `=`, CR/LF, backslash, comment markers, invalid Unicode, or deceptive keys can alter serialization, create unexpected fields, or fail child creation. | Validate types before casts; normalize only where the target contract requires it; reject NUL; enforce key grammar per target; bound UTF-8 byte lengths; escape through one format-specific serializer. Only canonical allowlisted fields may become `-metadata`, each as the value paired with a fixed option.                                                                                                                           | Use FFmpeg's direct `-map_metadata 0` for compatible source metadata and a maintained format writer for post-processing, but audit the destination rather than assuming the muxer preserved it.                                                                    |
| SEC-W03 | Full paths, untrusted tag names, parser messages, and raw FFmpeg stderr can contain control characters or sensitive custom metadata. Current conversion debug errors can include the retained stderr tail. | Terminal escape injection, forged log lines, accidental disclosure of POPM emails/comments/identifiers, and log-volume denial of service.                  | Log only escaped path text, target format, validated tag key or safe category, stable reason code, and outcome. Strip or escape C0/C1 controls and ANSI sequences. Never log values, artwork, base64, POPM email/counter, or raw native objects. Keep stderr bounded, sanitize it, and map known failures to stable messages before exposing it. Deduplicate/sort warnings and cap detail with an omitted-count summary.                  | In structured logging, store fixed fields with encoded values; paths may be reduced to basenames if operationally sufficient.                                                                                                                                      |
| SEC-W04 | `AbortSignal` currently covers FFmpeg but the new pre-parse, post-write, audit, flush, and commit phases can delay or ignore cancellation. `parseFile()` has no native signal parameter.                   | Cancelled work can continue consuming resources, publish output, or leave private full-media stages behind.                                                | Check the exact signal before and after every awaited phase, pass it to FFmpeg, terminate and await the child, and use `finally` cleanup. Recheck immediately before rename and preserve `signal.reason`. Test abort before parse, during FFmpeg, after encode, during post-write/audit, and before commit.                                                                                                                               | An abortable `ReadStream` with a verified `parseStream()` path or an owned worker can make metadata parsing promptly cancellable. If `parseFile()` remains, document the bounded residual delay after the dependency fix and never commit after an observed abort. |
| SEC-W05 | Temporary files can contain the entire audio object and personal metadata; the existing FLAC writer uses a UUID path with a non-exclusive default-mode `createWriteStream()`.                              | Other local users may read a permissive stage, a pre-created path may be followed, and cleanup failures can leave durable copies.                          | For new conversion staging, use exclusive 0600 creation, a resolved sibling directory, random names, regular-file/no-symlink checks, recorded device/inode checks, explicit flush, and explicit single-file unlink in `finally`. Preserve the destination extension or pass a fixed muxer so FFmpeg never infers format from an attacker-controlled name. Treat cleanup failure as a safe warning attached to the fatal/cancelled result. | Materialize through an already-open file descriptor where platform support is reliable; otherwise reject destination parents whose ownership/writability makes identity checks insufficient. Do not reuse the weaker FLAC temporary-file pattern for this feature. |
| SEC-W06 | Source and destination paths may traverse symlinks or shared writable directories, and FFmpeg supports URL/protocol inputs in addition to local files.                                                     | The parser and FFmpeg may read a different file than the one selected, access an unintended resource, or overwrite an alias of the source.                 | Resolve the existing source, require a regular file, record identity, and ensure the source is not the destination or stage. Resolve and recheck the destination parent as the existing validated-stage helper does. Do not derive paths from tag values or artwork descriptions. Pass only the selected local source as the fixed `-i` value; never follow URLs contained in metadata.                                                   | Stronger deployments may reject all symlinked sources or use descriptor-based input. Preserve current legitimate symlink workflows only if the resolved regular-file and identity contract is maintained.                                                          |
| SEC-W07 | FFmpeg is an unpinned native executable resolved from `PATH`; builds differ in codecs, muxers, security patches, and protocol support.                                                                     | A stale or substituted binary can process hostile media with known vulnerabilities or violate mapping assumptions.                                         | Resolve/check the executable without a shell, fail on missing required codecs/muxers, keep fixed arguments such as `-nostdin`, run with inherited user—not elevated—privileges, and document that operators must use a supported security-patched FFmpeg. Capability mismatch remains a fatal conversion error.                                                                                                                           | A configurable absolute executable path with validation can reduce `PATH` ambiguity; bundling FFmpeg increases update and distribution responsibility and is not recommended solely for this issue.                                                                |
| SEC-W08 | Destination auditing itself reparses attacker-influenced output and may compare raw/native objects naively.                                                                                                | Parser exposure is doubled, cyclic/large objects may cause expensive comparisons, and value serialization may leak data.                                   | Audit only a bounded canonical projection plus the explicitly supported custom-key set and picture digests/metadata. Compare normalized typed values, not `JSON.stringify(native)`. Reuse the upgraded parser and stop before commit on supported-field mismatch.                                                                                                                                                                         | A writer-returned manifest can reduce reparsing but does not independently prove muxer output; use it only with targeted real-file fixtures.                                                                                                                       |
| SEC-W09 | A new Opus tag/artwork writer may be proposed because existing packages cannot produce `METADATA_BLOCK_PICTURE`.                                                                                           | A broad or abandoned native dependency expands supply-chain and memory-safety exposure for a small format gap.                                             | Prefer a narrow, bounded, tested serializer or an already-maintained dependency with active releases, compatible license, integrity-locked package, advisory review, and explicit limits. Document the build-versus-depend decision.                                                                                                                                                                                                      | A format-limitation warning is not acceptable for primary Opus artwork under the business contract, but invoking a vetted external tool with safe argv may be preferable to an unmaintained library.                                                               |

### ADVISORY — Best Practices

| ID      | Finding                                    | Benefit                                                              | Recommendation                                                                                                                                                                                             | Defer justification                                                                                                                                         |
| ------- | ------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-A01 | Parser isolation beyond patched known CVEs | Contains future CPU/memory parser failures and enables hard timeouts | Consider parsing in a worker thread or helper process with memory/time ceilings for media from untrusted shares.                                                                                           | The CLI is local, conversion is already resource-intensive, and patched dependencies plus bounded fields/concurrency provide reasonable initial protection. |
| SEC-A02 | FFmpeg sandboxing                          | Limits impact of future native decoder vulnerabilities               | Where deployment permits, run without root, with a restrictive service profile/container, no unnecessary network access, and only required source/destination mounts.                                      | Cross-platform CLI packaging cannot reliably impose one sandbox; operator guidance is acceptable for this issue.                                            |
| SEC-A03 | Final output permissions                   | Makes access policy deliberate after private staging                 | Keep the stage 0600; before commit, set a documented ordinary data-file mode derived from repository policy/umask, never copying setuid/setgid/sticky bits from a source.                                  | Leaving the final file 0600 is secure, though it may be less convenient in shared media deployments.                                                        |
| SEC-A04 | Security regression corpus                 | Detects parser/serializer regressions without broad redundant tests  | Add small fixtures for NUL/control keys, large declared picture sizes, malformed POPM/Vorbis values, symlinks, collision, cancellation, and log escaping. Fuzz pure key/value classifiers and serializers. | Full fuzz infrastructure may be deferred; deterministic boundary tests are required now.                                                                    |
| SEC-A05 | Warning/result observability               | Gives callers machine-readable evidence without exposing values      | If warnings are added to `ConversionResult`, use stable codes/categories and counts, not raw metadata. Continue stderr visibility for current users.                                                       | The current issue can ship with safe stderr warnings because no structured warning API is requested.                                                        |
| SEC-A06 | Dependency provenance automation           | Detects future drift after the one-time upgrade                      | Keep registry integrity hashes in `package-lock.json`, use Dependabot/current audit policy, and record conversion-chain versions in PR evidence.                                                           | Existing repository-wide dependency automation may cover this; no new release mechanism is required.                                                        |

## Authentication and Authorization

No new authentication, authorization, session, token, or remote service is introduced. Authority is
the operating-system identity that runs `rfmedia`; the process must not elevate privileges or invoke
FFmpeg through `sudo`. File reads and final replacement must remain constrained to paths the
existing command selected and the OS user can access.

Plex-backed callers already authenticate before reaching conversion. Issue #42 does not change
Plex credentials or authorization. Preserved file metadata must never be confused with trusted
identity or access-control data: a tag claiming an artist, application email, owner, or path is only
untrusted media content.

## Data Protection

Tags may contain personal or sensitive data even though the repository does not classify them as
secrets: POPM email identifiers, comments, unique IDs, lyrics, geolocation-like custom fields, and
artwork containing people. Copying those values to the requested destination is the feature's
purpose, but duplicating them into logs or permissive temporary files is not.

Required data-handling rules:

1. Keep all processing local; never resolve URLs or fetch artwork referenced by a tag.
2. Use 0600 temporary artifacts and remove them on every non-commit path.
3. Do not persist source metadata in the database, history details, cache, or plan artifacts.
4. Log safe keys/categories and reason codes only, never values or picture bytes.
5. Publish only the destination the user requested, with deliberate ordinary file permissions.
6. Preserve source immutability and any pre-existing destination until atomic commit.

There is no new encryption-at-rest or in-transit requirement because the feature adds no remote
transport or private metadata store. Existing filesystem encryption and access controls remain the
operator's responsibility.

## Dependency Security

Versions below are the resolved lockfile state and registry/advisory state checked on 2026-07-28.

| Dependency                           | Locked version                         | Current evidence                                                                                                                                                                                                                                    | Risk level                  | Required posture                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `music-metadata`                     | 11.10.6                                | Direct high-severity [GHSA-v6c2-xwv6-8xf7](https://github.com/advisories/GHSA-v6c2-xwv6-8xf7) affects `parseFile()`/`parseBuffer()` through 11.12.1; 11.12.3 is the declared patched version. Registry current is 11.14.0.                          | CRITICAL                    | Upgrade to 11.14.0 or a later compatible reviewed release; minimum 11.12.3. Lock and retest parsing semantics, especially Vorbis ratings and pictures.                               |
| `file-type` through `music-metadata` | 21.3.0                                 | [GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473) fixes an ASF infinite loop in 21.3.1; [GHSA-j47w-4g3g-c36v](https://github.com/advisories/GHSA-j47w-4g3g-c36v) fixes known-size ZIP decompression-bomb handling in 21.3.2. | CRITICAL as part of SEC-C01 | Resolve at least 21.3.2. Recommended `music-metadata` 11.14.0 requests `file-type ^21.3.4`. Verify the actual lock, not only semver declarations.                                    |
| `node-id3`                           | 0.2.9                                  | Current registry release, MIT, no finding in the live npm production audit. It performs in-process parsing/writing of untrusted ID3 data.                                                                                                           | WARNING                     | Retain narrow MP3 use, keep inputs bounded, use `update()` only on a private stage, and fail supported writes that return false. Do not assume unsupported native frames round-trip. |
| `flac-metadata`                      | 0.1.1                                  | MIT and no live audit finding, but the only published version is old and its current temporary-file pattern is weaker than the repository's validated-stage helper. FLAC is not a conversion target.                                                | ADVISORY                    | Do not expand it into a general conversion writer. If touched, wrap mutation in secure staging and test malformed block sizes.                                                       |
| System FFmpeg                        | Deployment-specific; local probe 8.1.2 | Not represented in npm lock/audit and processes complex native formats.                                                                                                                                                                             | WARNING                     | Require a supported patched operator installation, safe capability checks, fixed argv, non-root execution, bounded stderr, cancellation, and fatal capability errors.                |
| Any new Opus writer                  | Not selected                           | Supply-chain, maintenance, license, and parser-safety posture unknown until selected.                                                                                                                                                               | WARNING                     | Perform advisory/license/maintenance review before adding; prefer a small auditable implementation when it is actually simpler and safer.                                            |

`npm audit --omit=dev --json` also reported current `picomatch` and `ws` findings outside the
conversion dependency chain. Do not hide those results, but do not make unrelated pre-existing
packages part of issue #42's acceptance scope. The hard stop here is that the dependency path this
feature directly expands must be patched and locked.

## Input Validation

### Paths

- Require the selected source to resolve to a regular local file.
- Never construct a destination, stage, metadata file, or artwork path from a tag value,
  description, MIME type, artist, or title.
- Resolve the destination parent once, confirm it is a directory, and recheck its identity before
  commit.
- Reject a final destination that is a symlink or non-regular file and reject source/destination
  device-and-inode equality.
- Keep generated stages as resolved siblings so rename stays same-filesystem and atomic.
- Use unpredictable names and exclusive creation; randomness alone is not a security control.
- Delete only the exact known stage path or recorded identity. Never use recursive or glob cleanup.

### Tag Keys and Values

- Treat every native tag value as `unknown`; check strings, numbers, buffers, arrays, and structured
  objects explicitly instead of using unchecked casts.
- Allowlist canonical mappings. For custom text, apply the target grammar: Vorbis field names must
  be printable ASCII excluding `=`; ID3 custom descriptions and MP4 keys need their own tested
  rules.
- Reject embedded NUL and invalid byte sequences. Escape CR/LF, backslash, `=`, semicolon, and
  comment markers according to the chosen serializer rather than with a generic replacement.
- Preserve semantic Unicode values without Unicode-normalizing user metadata unless the target
  requires it; normalization can silently change identifiers.
- Check rating numbers with `Number.isFinite()` and range/scale rules before normalization. An
  invalid rating is warned and omitted, never coerced into a positive rating.
- Hash picture bytes for comparison instead of placing bytes/base64 in logs or argv. Accept only
  target-supported picture MIME types and dimensions after bounded parsing.

### FFmpeg Arguments and Metadata Files

- Keep fixed options and values as separate argv entries. Correct existing combined bitrate entries
  such as `"-b:a 320k"` to `"-b:a", "320k"`.
- Put the generated absolute stage path in the output position so a leading dash in a user path
  cannot become an output option.
- Use explicit audio/artwork maps and fixed codec/muxer names from the typed target policy.
- Prefer direct metadata mapping plus bounded canonical overrides. Do not flatten the entire native
  tag set into command arguments.
- If an FFmetadata side file is unavoidable, create it exclusively at 0600, serialize with a single
  tested escaping function, bound its size, pass its generated absolute path as an input value, and
  unlink it in the same cleanup scope.
- Add `-nostdin`; retain bounded stderr; do not treat arbitrary successful stderr text as a warning
  classifier.

## Temporary-File and Commit Requirements

The existing `replaceFileWithValidatedStage()` provides the correct baseline: resolved sibling
parent, exclusive 0600 stage, regular-file and inode checks, flush, validation, parent/destination
revalidation, atomic rename, and `finally` cleanup. Conversion should reuse it or extract an
equivalent general helper without weakening those guarantees.

Implementation details that must be settled:

1. The stage needs a target-compatible extension or an explicit fixed output muxer; a terminal
   `.tmp` alone is insufficient for FFmpeg format inference.
2. FFmpeg and every post-writer operate on the stage, never the final destination.
3. The stage identity is checked after each tool that may reopen by pathname and once more before
   rename.
4. A supported metadata mismatch prevents commit.
5. The abort signal is checked immediately before commit.
6. Cleanup failure is reported without replacing the primary error, and the known stage location is
   included only after control-character escaping.
7. Final permissions are set explicitly; stage privacy is never relaxed early.

## Resource-Exhaustion Controls

Media duration and output size are legitimately variable, so a single short wall-clock timeout
would break valid conversions. Bound the parts introduced by this feature instead:

- enforce the picture and text ceilings in SEC-W01;
- process only one source snapshot and one bounded destination audit per conversion;
- retain existing worker/concurrency limits rather than creating a separate metadata pool;
- keep FFmpeg stderr bounded at or below the current 10 KiB retained window and sanitize before use;
- deduplicate warnings and cap per-file detail;
- stream media and temporary metadata where practical instead of concatenating whole files;
- never base64-encode artwork into argv;
- fail fast on `ENOSPC`, writer failure, invalid output, or capability mismatch;
- ensure cancellation terminates and awaits FFmpeg before unlink/commit;
- use the patched parser chain because post-parse caps cannot stop a parser infinite loop.

A progress-stall watchdog or worker-isolated parser is good defense in depth, but it must not use a
fixed duration that rejects long legitimate tracks.

## Cancellation and Cleanup

Cancellation is a state transition, not a generic metadata warning:

1. Preserve the caller's exact abort reason.
2. Check before metadata read, after metadata read, before spawn, while FFmpeg runs, after process
   exit, before/after every writer/audit, before flush, and immediately before rename.
3. On abort, terminate and await the child; do not let child close and abort race into double
   resolution.
4. Run one idempotent cleanup scope for the stage and any metadata/artwork side files.
5. Never unlink the source or a pre-existing destination.
6. Never record history, hash, invoke successful post-copy hooks, reuse a first-copy artifact, or
   commit verify repair after cancellation.

Pre/post checks around `parseFile()` are necessary but do not make its CPU loop cancellable. The
dependency hard stop removes the known infinite loop; parser isolation remains the stronger
advisory.

## Logging and Warning Safety

The format-limitation warning contract should use stable internal data such as:

```text
code=metadata_unrepresentable
target=m4a
field=rating
path=<escaped path>
output_usable=true
```

Do not interpolate the source value, POPM email/counter, native object, MIME payload, or FFmpeg
command line. Escape untrusted names and paths for a single terminal line. Sort and deduplicate
warnings so parallel completion order does not create noisy, nondeterministic evidence. If detail
limits are exceeded, emit a count and safe category summary.

Fatal errors should expose an actionable category—missing source, permission denied, unavailable
codec, invalid media, supported metadata write failed, audit mismatch—without returning the raw
FFmpeg tail. Raw sanitized diagnostics may remain debug-only and bounded.

## Infrastructure Security

CORS, CSP, CSRF, TLS, session management, network rate limiting, and secrets injection are not
applicable. No endpoint or remote fetch should be added. The relevant infrastructure controls are:

- patched local Node dependencies and FFmpeg;
- least-privilege execution;
- local-only media inputs;
- filesystem permissions and atomic replacement;
- existing bounded conversion worker concurrency; and
- optional OS/container sandboxing for hostile libraries.

## Secure Coding Guidelines

1. Preserve the single shared `convertFile()` security boundary; caller-specific post-processing
   creates gaps.
2. Use strict discriminated metadata types and exhaustive target-policy records; no `any` or blind
   native-tag casts.
3. Keep FFmpeg options fixed and typed; values occupy dedicated argv positions with `shell: false`.
4. Use private validated staging for the entire encode/write/audit transaction.
5. Apply explicit resource ceilings before copying, encoding, base64 conversion, logging, or
   serializing metadata.
6. Treat only genuine target incapability as non-fatal. Parser, writer, audit, path, cleanup-policy,
   and capability failures remain fatal.
7. Preserve abort reasons and make cleanup idempotent.
8. Reparse only a bounded projection and compare semantic values/digests.
9. Test adversarial values at pure serialization and process-boundary seams; do not duplicate the
   same security matrix across all action callers.
10. Audit and lock every dependency change; do not add a general tag library for one narrow format
    without evidence.

## Trade-off Recommendations

### Preserve Arbitrary Tags Without Arbitrary Arguments

Use FFmpeg metadata mapping for compatible fields, explicit bounded canonical overrides, and a
target writer for the few fields FFmpeg does not translate. This preserves feature value without
putting an unbounded native tag bag into argv. A field outside the tested mapping is preserved by a
safe writer or reported as unrepresentable; it is never blindly stringified.

### Primary Artwork Versus Unlimited Pictures

Guarantee one primary/front cover within the documented caps. Preserve more pictures when the target
and caps allow, then issue one category warning for the remainder. This meets issue scope while
preventing an album with thousands of images from multiplying memory use across workers.

### Immediate Cancellation Versus Parser Complexity

Upgrade the vulnerable parser now, check cancellation around the parse, and never commit after
abort. Worker isolation or an abortable stream parser is the preferred later defense if prompt
cancellation during metadata parsing is operationally important. Do not block the feature on a new
worker architecture after the known CVEs and bounded processing are addressed.

### Dependency Versus Narrow Opus Writer

Prefer the smallest reviewed solution that produces standard `METADATA_BLOCK_PICTURE` and `RATING`
comments with explicit limits. A maintained dependency is preferable if it demonstrably supports
atomic staged writes and current Node, but package breadth is a cost. An old universal tag library
is not automatically safer than a small format-specific serializer.

## Security Verification Gates

Before implementation can merge:

- the lockfile resolves patched `music-metadata` and `file-type` versions and a fresh dependency
  audit shows no advisory on that conversion chain;
- tests prove shell-free discrete argv with adversarial filenames and metadata;
- tests prove exclusive 0600 sibling staging, source/destination collision rejection, symlink and
  identity rechecks, atomic commit, and cleanup on every pre-commit failure;
- tests prove picture/tag/warning limits and no raw metadata in logs;
- tests prove cancellation across added phases and no commit after abort;
- tests prove supported-field writer/audit failures are fatal while true target limitations are
  safe warnings;
- real fixture probes reparse all four targets after the dependency upgrade; and
- review confirms no tag-derived path, URL fetch, shell invocation, recursive cleanup, or
  world-readable temporary file was introduced.

## Open Questions

1. Can the existing validated-stage helper accept a target extension or explicit muxer without
   weakening its identity checks, or should its stage-name policy be extended?
2. What repository-wide final file mode is expected for media in shared deployments after a 0600
   stage is committed?
3. Will Opus artwork use a new dependency, a narrow serializer, or a safely invoked external tool?
   The choice needs an explicit advisory/license/maintenance review.
4. Are source libraries commonly located in group/world-writable network shares? If so, descriptor-
   based materialization or stricter parent ownership checks should move from advisory to required.
5. Should warning codes become an additive `ConversionResult` field, or is safe stderr sufficient
   for the current CLI-only contract?
