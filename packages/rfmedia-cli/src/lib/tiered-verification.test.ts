import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { DbInventoryFingerprint } from "../types/db.js";
import type { FileVerifyStatus, VerifiedFile } from "../types/results.js";
import { FileChangedDuringReadError } from "./integrity.js";
import {
  addExtraFile,
  addVerifyFailure,
  addVerifyOutcome,
  applyVerifyFileOutcome,
  createVerifyResult,
  hasUnresolvedVerificationProblems,
  mergeVerifyResults,
  resolveFingerprintCandidate,
  transitionVerifyOutcome,
  verifyFileByTier,
  type VerificationDependencies,
  type VerifyFileInput,
} from "./tiered-verification.js";

const sourcePath = "/music/Artist/Album/track.flac";
const destinationPath = "/destination/Artist/Album/track.flac";
const relativePath = "Album/track.flac";
const validHash = "a".repeat(64);

function fingerprint(overrides: Partial<DbInventoryFingerprint> = {}): DbInventoryFingerprint {
  return {
    id: 1,
    operation_id: 1,
    source_path: sourcePath,
    relative_path: relativePath,
    mtime: 1_000.9,
    size: 42,
    rating: null,
    genre: null,
    year: null,
    bpm: null,
    artist: null,
    dest_path: destinationPath,
    content_hash: validHash,
    copied_at: 2_000,
    convert_key: null,
    ...overrides,
  };
}

function dependencies(overrides: Partial<VerificationDependencies> = {}): VerificationDependencies {
  return {
    statFile: vi.fn(async () => ({ size: 42, mtimeMs: 1_000.9, isFile: true })),
    calculateHash: vi.fn(async () => validHash),
    compareFileBytes: vi.fn(async () => ({
      status: "match" as const,
      sameInode: false,
      bytesCompared: 42,
    })),
    ...overrides,
  };
}

function input(overrides: Partial<VerifyFileInput> = {}): VerifyFileInput {
  return {
    tier: "default",
    sourcePath,
    destinationPath,
    converted: false,
    fingerprint: fingerprint(),
    ...overrides,
  };
}

describe("resolveFingerprintCandidate", () => {
  it("requires normalized exact source, relative, destination, and conversion identity", () => {
    const exact = fingerprint();
    const wrongDestination = fingerprint({ id: 2, dest_path: "/destination/other.flac" });
    const wrongConversion = fingerprint({ id: 3, convert_key: "mp3" });

    expect(
      resolveFingerprintCandidate([wrongDestination, wrongConversion, exact], {
        sourcePath: "/music/Artist/Album/./track.flac",
        relativePath: "Album/./track.flac",
        destinationPath: "/destination/Artist/Album/./track.flac",
        convertKey: null,
      }),
    ).toEqual({ status: "found", fingerprint: exact });
  });

  it("returns missing for unrepresented ranged output and ambiguous for duplicate exact rows", () => {
    const exact = fingerprint();
    const duplicate = fingerprint({ id: 2, operation_id: 2 });
    const identity = { sourcePath, relativePath, destinationPath, convertKey: null };

    expect(
      resolveFingerprintCandidate(
        [fingerprint({ dest_path: "/destination/Album-001/track.flac" })],
        identity,
      ),
    ).toEqual({ status: "missing" });
    expect(resolveFingerprintCandidate([exact, duplicate], identity)).toEqual({
      status: "ambiguous",
    });
  });
});

describe("verifyFileByTier", () => {
  it("runs quick metadata checks without hashing or byte comparison", async () => {
    const deps = dependencies();

    await expect(
      verifyFileByTier(input({ tier: "quick", fingerprint: undefined }), deps),
    ).resolves.toEqual({
      status: "present",
      evidence: ["metadata"],
    });
    expect(deps.statFile).toHaveBeenCalledTimes(2);
    expect(deps.calculateHash).not.toHaveBeenCalled();
    expect(deps.compareFileBytes).not.toHaveBeenCalled();
  });

  it.each([
    [43, 1_000.9, "size-mismatch", undefined],
    [42, 1_001.1, "metadata-mismatch", "mtime"],
  ] as const)(
    "classifies quick destination size=%s mtime=%s as %s",
    async (size, mtimeMs, status, reason) => {
      const deps = dependencies({
        statFile: vi.fn(async (path) =>
          path === sourcePath
            ? { size: 42, mtimeMs: 1_000.9, isFile: true }
            : { size, mtimeMs, isFile: true },
        ),
      });

      const outcome = await verifyFileByTier(input({ tier: "quick" }), deps);

      expect(outcome.status).toBe(status);
      if (reason) {
        expect(outcome).toMatchObject({ reason });
      }
    },
  );

  it("marks converted quick verification unavailable without reading metadata or content", async () => {
    const deps = dependencies();

    await expect(
      verifyFileByTier(input({ tier: "quick", converted: true }), deps),
    ).resolves.toEqual({
      status: "unverifiable",
      evidence: [],
      reason: "conversion-metadata-unavailable",
    });
    expect(deps.statFile).not.toHaveBeenCalled();
    expect(deps.calculateHash).not.toHaveBeenCalled();
  });

  it.each([
    [sourcePath, "source"],
    [destinationPath, "destination"],
  ] as const)("rejects a non-regular quick %s as an operational error", async (path, role) => {
    const deps = dependencies({
      statFile: vi.fn(async (candidatePath) => ({
        size: 42,
        mtimeMs: 1_000.9,
        isFile: candidatePath !== path,
      })),
    });

    await expect(verifyFileByTier(input({ tier: "quick" }), deps)).rejects.toThrow(
      `Verification ${role} is not a regular file: ${path}`,
    );
    expect(deps.calculateHash).not.toHaveBeenCalled();
    expect(deps.compareFileBytes).not.toHaveBeenCalled();
  });

  it("uses no-follow metadata for quick symlink and directory rejection", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "rfmedia-tiered-verification-"));
    const regularPath = join(fixtureRoot, "regular.flac");
    const symlinkPath = join(fixtureRoot, "linked.flac");
    const directoryPath = join(fixtureRoot, "album");
    await writeFile(regularPath, "audio");
    await symlink(regularPath, symlinkPath);
    await mkdir(directoryPath);

    try {
      await expect(
        verifyFileByTier({
          tier: "quick",
          sourcePath: symlinkPath,
          destinationPath: regularPath,
          converted: false,
        }),
      ).rejects.toThrow(`Verification source is not a regular file: ${symlinkPath}`);
      await expect(
        verifyFileByTier({
          tier: "quick",
          sourcePath: regularPath,
          destinationPath: directoryPath,
          converted: false,
        }),
      ).rejects.toThrow(`Verification destination is not a regular file: ${directoryPath}`);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [undefined, undefined, "fingerprint-missing"],
    [fingerprint({ content_hash: null }), undefined, "fingerprint-null"],
    [fingerprint({ content_hash: "INVALID" }), undefined, "fingerprint-invalid"],
    [undefined, "fingerprint-ambiguous", "fingerprint-ambiguous"],
  ] as const)(
    "classifies unavailable default evidence as %s",
    async (stored, fingerprintReason, reason) => {
      const deps = dependencies();

      await expect(
        verifyFileByTier(input({ fingerprint: stored, fingerprintReason }), deps),
      ).resolves.toMatchObject({ status: "unverifiable", reason });
      expect(deps.calculateHash).not.toHaveBeenCalled();
    },
  );

  it("hashes the destination once and never exposes digest values in the outcome", async () => {
    const deps = dependencies();
    const outcome = await verifyFileByTier(input(), deps);

    expect(outcome).toEqual({ status: "present", evidence: ["hash"] });
    expect(deps.calculateHash).toHaveBeenCalledOnce();
    expect(deps.calculateHash).toHaveBeenCalledWith(destinationPath, undefined);
    expect(JSON.stringify(outcome)).not.toContain(validHash);
  });

  it("returns hash mismatch before any deep comparison", async () => {
    const deps = dependencies({ calculateHash: vi.fn(async () => "b".repeat(64)) });

    await expect(verifyFileByTier(input({ tier: "deep" }), deps)).resolves.toEqual({
      status: "hash-mismatch",
      evidence: ["hash"],
    });
    expect(deps.compareFileBytes).not.toHaveBeenCalled();
  });

  it.each([
    [
      { status: "match", sameInode: false, bytesCompared: 42 },
      { status: "present", evidence: ["hash", "bytes"] },
    ],
    [
      { status: "mismatch", sameInode: false, bytesCompared: 42 },
      { status: "content-mismatch", evidence: ["hash", "bytes"] },
    ],
    [
      { status: "unstable", sameInode: false, bytesCompared: 42 },
      { status: "unstable", evidence: ["hash", "bytes"], reason: "changed-during-read" },
    ],
    [
      { status: "match", sameInode: true, bytesCompared: 0 },
      { status: "present", evidence: ["hash"], notApplicableReason: "same-inode-byte-compare" },
    ],
  ] as const)("maps deep comparison %# to a typed outcome", async (comparison, expected) => {
    const deps = dependencies({ compareFileBytes: vi.fn(async () => comparison) });
    await expect(verifyFileByTier(input({ tier: "deep" }), deps)).resolves.toEqual(expected);
  });

  it("retains successful hash evidence while converted deep comparison is not applicable", async () => {
    const deps = dependencies();

    await expect(verifyFileByTier(input({ tier: "deep", converted: true }), deps)).resolves.toEqual(
      {
        status: "present",
        evidence: ["hash"],
        notApplicableReason: "conversion-byte-compare",
      },
    );
    expect(deps.compareFileBytes).not.toHaveBeenCalled();
  });

  it("classifies an unequal-length deep comparison as a content mismatch", async () => {
    const deps = dependencies({
      compareFileBytes: vi.fn(async () => ({
        status: "mismatch" as const,
        sameInode: false,
        bytesCompared: 0,
      })),
    });

    await expect(verifyFileByTier(input({ tier: "deep" }), deps)).resolves.toEqual({
      status: "content-mismatch",
      evidence: ["hash", "bytes"],
    });
  });

  it("propagates a missing deep source as an operational failure", async () => {
    const missingSourceError = Object.assign(new Error("source missing"), { code: "ENOENT" });
    const deps = dependencies({
      compareFileBytes: vi.fn(async () => {
        throw missingSourceError;
      }),
    });

    await expect(verifyFileByTier(input({ tier: "deep" }), deps)).rejects.toBe(missingSourceError);
  });

  it("converts stable hash-read mutation into unstable while propagating other errors", async () => {
    const changed = dependencies({
      calculateHash: vi.fn(async () => {
        throw new FileChangedDuringReadError(destinationPath);
      }),
    });
    await expect(verifyFileByTier(input(), changed)).resolves.toMatchObject({
      status: "unstable",
      reason: "changed-during-read",
    });

    const failed = dependencies({
      calculateHash: vi.fn(async () => {
        throw new Error("read failed");
      }),
    });
    await expect(verifyFileByTier(input(), failed)).rejects.toThrow("read failed");
  });

  it("propagates abort before evidence work", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = dependencies();

    await expect(
      verifyFileByTier(input({ tier: "deep", signal: controller.signal }), deps),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(deps.calculateHash).not.toHaveBeenCalled();
  });

  it("propagates aborts raised during injected evidence work", async () => {
    const controller = new AbortController();
    const deps = dependencies({
      calculateHash: vi.fn(async () => {
        controller.abort();
        return validHash;
      }),
    });

    await expect(
      verifyFileByTier(input({ signal: controller.signal }), deps),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps --verify-size additive without weakening the selected hash tier", async () => {
    const mismatch = dependencies({
      statFile: vi.fn(async (path) =>
        path === sourcePath
          ? { size: 42, mtimeMs: 1_000, isFile: true }
          : { size: 43, mtimeMs: 1_000, isFile: true },
      ),
    });
    await expect(verifyFileByTier(input({ verifySize: true }), mismatch)).resolves.toMatchObject({
      status: "size-mismatch",
    });
    expect(mismatch.calculateHash).not.toHaveBeenCalled();

    const matching = dependencies();
    await expect(verifyFileByTier(input({ verifySize: true }), matching)).resolves.toMatchObject({
      status: "present",
      evidence: ["hash"],
    });
    expect(matching.calculateHash).toHaveBeenCalledOnce();
  });
});

describe("verification aggregation", () => {
  it("counts every primary status and successful not-applicable coverage", () => {
    const result = createVerifyResult("/music", "deep");
    const statuses: FileVerifyStatus[] = [
      "present",
      "missing",
      "size-mismatch",
      "metadata-mismatch",
      "hash-mismatch",
      "content-mismatch",
      "unverifiable",
      "unstable",
    ];
    for (const status of statuses) {
      addVerifyOutcome(result, { path: `${status}.flac`, status });
    }
    applyVerifyFileOutcome(result, "converted.flac", {
      status: "present",
      evidence: ["hash"],
      notApplicableReason: "conversion-byte-compare",
    });

    expect(result).toMatchObject({
      verified: 2,
      missing: 1,
      sizeMismatch: 1,
      metadataMismatch: 1,
      hashMismatch: 1,
      contentMismatch: 1,
      unverifiable: 1,
      notApplicable: 1,
      unstable: 1,
      expectedTotal: 9,
    });
    expect(hasUnresolvedVerificationProblems(result)).toBe(true);
  });

  it("treats not-applicable alone as successful coverage", () => {
    const result = createVerifyResult("/music", "deep");
    applyVerifyFileOutcome(result, "converted.flac", {
      status: "present",
      evidence: ["hash"],
      notApplicableReason: "conversion-byte-compare",
    });

    expect(result).toMatchObject({ verified: 1, notApplicable: 1, expectedTotal: 1 });
    expect(hasUnresolvedVerificationProblems(result)).toBe(false);
  });

  it("transitions repair outcomes from mismatch to verified without changing expected total", () => {
    const result = createVerifyResult("/music", "default");
    const previous: VerifiedFile = { path: "track.flac", status: "hash-mismatch" };
    addVerifyOutcome(result, previous);

    transitionVerifyOutcome(result, previous, { path: "track.flac", status: "present" });

    expect(result).toMatchObject({ verified: 1, hashMismatch: 0, expectedTotal: 1, issues: [] });
  });

  it("aggregates extras as unresolved issues without increasing expected total", () => {
    const result = createVerifyResult("/music", "default");

    addExtraFile(result, "extra.flac");

    expect(result).toMatchObject({ verified: 0, extra: 1, expectedTotal: 0 });
    expect(result.issues).toEqual([{ path: "extra.flac", status: "extra" }]);
  });

  it("merges counters, repair state, and deterministically sorts details", () => {
    const target = createVerifyResult("aggregate", "default");
    const source = createVerifyResult("source", "default");
    addVerifyOutcome(target, { path: "z.flac", status: "missing" });
    addVerifyFailure(target, { path: "z-error", message: "later" });
    addVerifyOutcome(source, { path: "a.flac", status: "hash-mismatch" });
    addExtraFile(source, "b-extra.flac");
    addVerifyFailure(source, { path: "a-error", message: "earlier" });
    source.fixResults = {
      copiedFiles: 2,
      removedFiles: 1,
      failedFixes: [{ path: "failed-fix", message: "failed" }],
      repairedFiles: 1,
      reverifiedFiles: 2,
      refusedFiles: 1,
      remainingIssues: 1,
    };

    mergeVerifyResults(target, source);

    expect(target).toMatchObject({
      missing: 1,
      hashMismatch: 1,
      extra: 1,
      expectedTotal: 2,
      fixResults: {
        copiedFiles: 2,
        removedFiles: 1,
        repairedFiles: 1,
        reverifiedFiles: 2,
        refusedFiles: 1,
        remainingIssues: 1,
      },
    });
    expect(target.issues.map((issue) => issue.path)).toEqual(["a.flac", "b-extra.flac", "z.flac"]);
    expect(target.issues.find((issue) => issue.path === "b-extra.flac")?.status).toBe("extra");
    expect(target.failed.map((failure) => failure.path)).toEqual(["a-error", "z-error"]);
    expect(hasUnresolvedVerificationProblems(target)).toBe(true);
  });

  it.each([
    ["extra", (result: ReturnType<typeof createVerifyResult>) => addExtraFile(result, "extra")],
    [
      "failure",
      (result: ReturnType<typeof createVerifyResult>) =>
        addVerifyFailure(result, { path: "file", message: "failed" }),
    ],
    [
      "failed repair",
      (result: ReturnType<typeof createVerifyResult>) => {
        result.fixResults = {
          copiedFiles: 0,
          removedFiles: 0,
          failedFixes: [{ path: "file", message: "failed" }],
          repairedFiles: 0,
          reverifiedFiles: 0,
          refusedFiles: 0,
          remainingIssues: 0,
        };
      },
    ],
    [
      "refused repair",
      (result: ReturnType<typeof createVerifyResult>) => {
        result.fixResults = {
          copiedFiles: 0,
          removedFiles: 0,
          failedFixes: [],
          repairedFiles: 0,
          reverifiedFiles: 0,
          refusedFiles: 1,
          remainingIssues: 1,
        };
      },
    ],
  ])("treats %s as unresolved", (_label, arrange) => {
    const result = createVerifyResult("/music", "default");
    arrange(result);
    expect(hasUnresolvedVerificationProblems(result)).toBe(true);
  });
});
