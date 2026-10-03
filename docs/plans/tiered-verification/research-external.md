# External API Research: Tiered Verification

## Executive Summary

Issue #116 can be implemented entirely with Node.js 22 built-ins. The recommended model is:

- **Quick**: stat both paths, require regular files, compare size and a deliberately documented
  modification-time policy. This reads no file contents and is only a change detector, not an
  integrity proof.
- **Default**: stream the destination through Node's built-in SHA-256 implementation and compare
  the result with the inventory `content_hash`. This needs one full destination read, bounded
  memory, and works for converted outputs because the stored hash describes destination bytes.
- **Deep**: first perform the default stored-hash check, then compare source and destination bytes
  for operations that promise byte identity. This makes deep a strict confidence superset of
  default. A source/destination byte comparison alone is not stronger than a stored hash: two
  identically corrupted files, and especially a modified hardlink, would still compare equal.

Borg and restic support the product idea—cheap structural or metadata checks by default and
explicit expensive data verification—but their deepest checks validate data against cryptographic
identity, not merely against another mutable path. Restic also demonstrates a useful future pattern:
bounded or partitioned deep verification rather than forcing every scheduled run to read all data.

No new runtime dependency is justified. The repository already uses `node:crypto`, Node streams,
`AbortSignal`, Vitest benchmarks, and an inventory SHA-256 generated from final destination bytes.

## Primary APIs/official URLs

All sources below are primary project or standards documentation.

### Node.js 22 APIs

- [`crypto.createHash()`](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptocreatehashalgorithm-options)
  creates a streaming `Hash`; `sha256` is supported by the OpenSSL build used by Node. The official
  example hashes a file incrementally with `createReadStream()`.
- [`fs.createReadStream()`](https://nodejs.org/docs/latest-v22.x/api/fs.html#fscreatereadstreampath-options)
  accepts an `AbortSignal` and defaults to a 64 KiB `highWaterMark`. It does not load the entire file.
- [`stream/promises.pipeline()`](https://nodejs.org/docs/latest-v22.x/api/stream.html#streampipelinestreams-options)
  forwards errors, destroys participating streams on failure, returns a promise, and accepts
  `{ signal }` for cancellation.
- [`fsPromises.stat()` and `FileHandle.stat()`](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesstatpath-options)
  expose file type, size, and timestamps. With `{ bigint: true }`, Node 22 exposes nanosecond fields
  such as `mtimeNs`; `mtimeMs` is the last-content-modification time in epoch milliseconds, while
  `ctimeMs` is file-status change time and `birthtimeMs` is creation time.
- [`FileHandle.read()`](https://nodejs.org/docs/latest-v22.x/api/fs.html#filehandlereadbuffer-options)
  reads into caller-owned buffers and reports the actual `bytesRead`. End-of-file is indicated by
  zero bytes read. Code must handle short reads rather than assuming one call fills the buffer.
- [`AbortSignal.throwIfAborted()`](https://nodejs.org/docs/latest-v22.x/api/globals.html#abortsignalthrowifaborted)
  provides a standard cancellation checkpoint for manual read loops.
- [`Buffer.compare()`](https://nodejs.org/docs/latest-v22.x/api/buffer.html#static-method-buffercomparebuf1-buf2)
  performs byte ordering comparison. For reusable buffers, compare only the filled subarrays.
- [`process.hrtime.bigint()`](https://nodejs.org/docs/latest-v22.x/api/process.html#processhrtimebigint)
  and [`process.memoryUsage()`](https://nodejs.org/docs/latest-v22.x/api/process.html#processmemoryusage)
  provide high-resolution duration and process-memory evidence for one-shot benchmark probes.

### Proven verification patterns

- [Borg `check`](https://borgbackup.readthedocs.io/en/stable/usage/check.html) separates repository
  consistency, archive metadata/reference checks, and the much slower `--verify-data` cryptographic
  content verification. Borg 2 also documents resumable time-bounded repository checks through
  `--max-duration`, although partial checks have reduced guarantees.
- [restic repository checking](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#checking-integrity-and-consistency)
  separates structural consistency from `--read-data`, which reads every pack, and supports
  `--read-data-subset` as deterministic partitions, random percentages, or a size budget.
- [NIST FIPS 180-4, Secure Hash Standard](https://csrc.nist.gov/pubs/fips/180-4/upd1/final)
  specifies SHA-256. It is suitable for accidental-corruption detection here. A plain digest does
  not authenticate an inventory database that an attacker can also rewrite.

## Libraries/SDKs

### Recommended: Node.js built-ins only

| Need                 | Built-in                    | Recommendation                                                        |
| -------------------- | --------------------------- | --------------------------------------------------------------------- |
| SHA-256              | `node:crypto`               | Reuse/extend the existing streaming hash helper with `AbortSignal`.   |
| Streaming file input | `node:fs`                   | Use `createReadStream()` for hashing; keep a bounded `highWaterMark`. |
| Paired exact reads   | `node:fs/promises`          | Use two `FileHandle`s and two reusable buffers for deep comparison.   |
| Stream lifecycle     | `node:stream/promises`      | Use `pipeline(..., { signal })` for hashing and automatic cleanup.    |
| Byte comparison      | `node:buffer`               | Use `Buffer.compare()` or `.equals()` on filled subarrays.            |
| Benchmarks           | Existing Vitest bench setup | Extend `benchmarks/verify.bench.ts`; do not add another harness.      |

Third-party hashing, file-comparison, worker-pool, or benchmark packages add no capability needed by
this feature. Native SHA-256 avoids shell portability and executable-discovery problems. The current
`workers`/`processInParallel` infrastructure should remain the concurrency control point.

## Integration Patterns

### 1. Make tier guarantees explicit and monotonic

Represent the tier as one value (`"quick" | "default" | "deep"`) and reject conflicting CLI flags.
Do not silently downgrade when an expected hash is missing: return a distinct `unverifiable` or
`missing-baseline` result. Otherwise `rfmedia verify` can report success without providing its
advertised default guarantee.

Recommended per-file flow:

1. Resolve the expected source/destination pair and inventory record.
2. Open or stat paths and reject non-regular files according to a defined symlink policy.
3. Quick: compare metadata and stop.
4. Default: SHA-256 the destination once and compare with `content_hash`.
5. Deep: perform step 4, then byte-compare source and destination only for byte-identical copy or
   hardlink outputs.
6. Re-stat open handles after content reads. If size or modification time changed during the read,
   return `unstable` and allow a later retry rather than claiming success.

The existing inventory hash is especially valuable for conversions: it is computed from the final
destination artifact. Current inventory size and mtime describe the source, however, so they are not
a valid destination-metadata baseline for converted files.

### 2. Stream SHA-256 against the stored destination fingerprint

Hashing only the destination halves read I/O compared with hashing both source and destination. It
also retains meaning for transcoded output.

```ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path, { signal }), hash, { signal });
  return hash.digest("hex");
}

const actual = await sha256File(destPath, signal);
const matches = actual === expectedContentHash;
```

Passing the signal to both `createReadStream()` and `pipeline()` is intentional: it makes the input
itself abortable and lets the pipeline coordinate destruction and error propagation. Treat an
`AbortError` as cancellation, not as a corrupt-file result.

### 3. Compare bytes with fixed memory and correct short-read handling

For deep comparison, first reject different sizes. Open handles once, allocate two reusable buffers,
advance by the actual bytes read, and close both handles in `finally`. The outline below omits the
small helper that repeatedly reads until the requested window is full or EOF; that helper is
required because `FileHandle.read()` may return fewer bytes than requested.

```ts
import { open } from "node:fs/promises";

const CHUNK_BYTES = 1024 * 1024;

async function filesEqual(aPath: string, bPath: string, signal?: AbortSignal): Promise<boolean> {
  const [a, b] = await Promise.all([open(aPath, "r"), open(bPath, "r")]);
  const aBuffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const bBuffer = Buffer.allocUnsafe(CHUNK_BYTES);

  try {
    const [aBefore, bBefore] = await Promise.all([a.stat(), b.stat()]);
    if (!aBefore.isFile() || !bBefore.isFile() || aBefore.size !== bBefore.size) return false;

    let position = 0;
    while (position < aBefore.size) {
      signal?.throwIfAborted();
      const length = Math.min(CHUNK_BYTES, aBefore.size - position);
      const [aRead, bRead] = await Promise.all([
        readFullyOrEof(a, aBuffer, length, position),
        readFullyOrEof(b, bBuffer, length, position),
      ]);
      if (aRead !== bRead) return false;
      if (aRead === 0) break;
      if (!aBuffer.subarray(0, aRead).equals(bBuffer.subarray(0, bRead))) return false;
      position += aRead;
    }

    const [aAfter, bAfter] = await Promise.all([a.stat(), b.stat()]);
    if (aAfter.size !== aBefore.size || bAfter.size !== bBefore.size) {
      throw new Error("file changed during verification");
    }
    return position === aBefore.size;
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
  }
}
```

At 1 MiB chunks, working buffers cost approximately 2 MiB per concurrent deep comparison, plus
runtime overhead. Total memory therefore scales with `workers`; it does not scale with file size.
Measure 64 KiB, 256 KiB, and 1 MiB rather than assuming the largest buffer is fastest on local,
network, and FUSE-backed libraries.

Manual `FileHandle.read()` in Node 22 has no signal parameter. Cancellation occurs at explicit
checkpoints between syscalls, so a stalled filesystem read may delay cancellation. A stream-based
comparator can use abortable `createReadStream()`, but it must reconcile unequal chunk boundaries;
comparing each stream event one-for-one is incorrect.

### 4. Bound I/O concurrency

Hash and byte-comparison tiers are storage-throughput operations. Reuse the existing worker limit,
pass the worker-provided signal into every file verifier, and do not launch unbounded `Promise.all()`
across the library. Benchmark worker counts on representative storage: more concurrent reads can
reduce throughput on rotating disks and remote mounts even when it helps SSDs.

Quick metadata calls use Node's libuv threadpool and may benefit from moderate concurrency. Default
and deep reads should begin with a conservative default and preserve the user's existing `--workers`
override.

### 5. Benchmark guarantees, not only happy-path throughput

Extend the existing real-filesystem benchmark instead of creating a synthetic in-memory test.
Report both files/second and MiB/second, because quick is driven largely by file count while default
and deep are driven by bytes read.

Recommended matrix:

- 10/100/1,000 small files for metadata syscall overhead.
- A bounded large-file fixture, for example 64 files at 8 MiB, using the existing
  `RFMEDIA_BENCH_TRACK_BYTES` control.
- Quick, default, and deep with the same fixture and worker counts 1, 2, and 4.
- Equal-size single-byte corruption, size mismatch, timestamp-only change, missing hash, missing
  file, converted output, hardlink, cancellation mid-read, and mutation during verification.
- Peak RSS/heap via the existing memory probe; assert or review that growth is bounded by
  chunk-size times workers rather than total library bytes.

Filesystem cache dominates repeated read benchmarks. CI results are normally warm-cache evidence;
label them that way. Run optional cold-cache/manual storage trials separately rather than relying on
non-portable cache-dropping commands. The issue's “10x faster” target should state its comparator,
dataset, byte volume, cache state, filesystem, and worker count. Tiny 1 KiB fixtures cannot establish
a meaningful ratio between metadata-only and content-reading tiers.

## Constraints/Gotchas

- **Quick is not integrity verification.** Equal size and mtime do not imply equal bytes, and a
  timestamp can be preserved or restored after mutation.
- **Timestamp precision is filesystem-dependent.** Node exposes precise numeric fields, but the
  underlying filesystem or network protocol may round them. Exact cross-filesystem mtime equality
  can produce false mismatches; an arbitrary global tolerance can hide real changes. This policy
  must be explicit and tested on supported destinations.
- **Do not compare atime.** Reading a file can update it. `ctime` is status-change time, not content
  modification time, and `birthtime` is not portable creation identity.
- **Converted files break pairwise assumptions.** Their source and destination size, mtime, and
  bytes can legitimately differ. The stored final-artifact hash is the current portable integrity
  baseline.
- **Hardlinks break “deep is strongest” if deep only compares paths.** Both names reference the same
  inode; corruption or later edits affect both. The stored expected hash is what detects drift from
  the originally recorded bytes.
- **Concurrent modification creates race conditions.** Open handles and before/after stats reduce
  path-replacement and mutation ambiguity, but Node does not provide portable filesystem snapshot
  semantics. Return `unstable` rather than success when a change is observed.
- **Do not use `readFile()` or `Buffer.concat()` for content tiers.** They make memory proportional
  to file size. Streaming hash and reusable compare buffers are bounded.
- **Do not assume stream chunk boundaries match.** Two read streams may emit different chunk sizes
  for identical content.
- **Cancellation must propagate through every layer.** Stop scheduling new files, abort active hash
  streams, checkpoint deep loops, close handles, and preserve cancellation as a distinct outcome.
- **A missing or malformed stored hash is not a match.** It is missing evidence and should be
  reported distinctly. Never log complete fingerprints by default; hashes can identify media.
- **SHA-256 provides integrity, not inventory authenticity.** An actor who can rewrite both the
  destination and SQLite inventory can replace the digest too.
- **Content-tier parallelism can be counterproductive.** Benchmark storage behavior rather than
  treating CPU count as the correct worker count.

## Open Questions

1. What exact database operation/inventory row identifies the expected hash when multiple copy
   operations contain the same source or destination? Destination path plus operation identity must
   be unambiguous.
2. Should default verification fail, report `unverifiable`, or offer an explicit migration/backfill
   when legacy rows have `content_hash = NULL`? Silent source re-hashing is not valid for conversions.
3. For quick mode, is the contract source-versus-destination metadata, current source-versus-stored
   source metadata, or destination-versus-a new stored destination metadata baseline? The current
   inventory stores source size/mtime, so converted destinations need schema or contract work.
4. What mtime precision/tolerance is supported across ext4, APFS, SMB/NFS, and FUSE destinations?
   This should be evidence-driven, not an undocumented epsilon.
5. Is deep verification unsupported for converted outputs, reported as partially applicable, or
   defined as stored-hash verification only for those files? It must not compare transcoded bytes
   with source bytes.
6. Must deep always run the default stored-hash check first? This research recommends yes so the
   confidence ordering is monotonic and hardlinks remain meaningfully verified.
7. Should a file that changes during verification be retried automatically once, or reported as
   `unstable` immediately?
8. What representative dataset and environment define the “quick is 10x+ faster” acceptance gate?
9. Should a future command adopt restic-style deterministic subsets or a byte/time budget for
   scheduled deep verification of very large libraries?
