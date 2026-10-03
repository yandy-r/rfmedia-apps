#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runLidarrGeneration } from "./generate-lidarr-client.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultPackageRoot = resolve(scriptDir, "..");
const REPOSITORY = "Lidarr/Lidarr";
const UPSTREAM_PATH = "src/Lidarr.Api.V1/openapi.json";
const SNAPSHOT_PATH = "openapi/lidarr-v1.json";
const MANIFEST_PATH = "openapi/lidarr-v1.manifest.json";
const GENERATED_PATH = "src/lib/lidarr/generated";
const CONFIG_PATH = "openapi-ts.config.mjs";
const TSCONFIG_PATH = "tsconfig.json";
const PACKAGE_PATH = "package.json";
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const REQUIRED_RESPONSES = new Map([
  ["/api/v1/artist", { type: "array", ref: "#/components/schemas/ArtistResource" }],
  ["/api/v1/health", { type: "array", ref: "#/components/schemas/HealthResource" }],
  ["/api/v1/system/status", { ref: "#/components/schemas/SystemResource" }],
  ["/api/v1/wanted/missing", { ref: "#/components/schemas/AlbumResourcePagingResource" }],
]);

function fail(message) {
  throw new Error(message);
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(`${label} is not valid UTF-8 JSON.`);
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function assertLocalReferences(value) {
  if (Array.isArray(value)) {
    for (const entry of value) assertLocalReferences(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && (typeof entry !== "string" || !entry.startsWith("#/"))) {
      fail("OpenAPI snapshot contains a non-local $ref.");
    }
    assertLocalReferences(entry);
  }
}

function validateResponseSchema(operationPath, operation, contract) {
  const schema = operation.responses?.["200"]?.content?.["application/json"]?.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    fail(`OpenAPI snapshot is missing the JSON 200 response for GET ${operationPath}.`);
  }
  if (contract.type === "array") {
    if (schema.type !== "array" || schema.items?.$ref !== contract.ref) {
      fail(`OpenAPI snapshot response contract changed for GET ${operationPath}.`);
    }
  } else if (schema.$ref !== contract.ref) {
    fail(`OpenAPI snapshot response contract changed for GET ${operationPath}.`);
  }
}

export function validateLidarrOpenApi(bytes) {
  const spec = assertObject(parseJson(bytes, "OpenAPI snapshot"), "OpenAPI snapshot");
  if (spec.openapi !== "3.0.4") fail("OpenAPI snapshot must use version 3.0.4.");
  for (const [operationPath, contract] of REQUIRED_RESPONSES) {
    const operation = spec.paths?.[operationPath]?.get;
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      fail(`OpenAPI snapshot is missing GET ${operationPath}.`);
    }
    validateResponseSchema(operationPath, operation, contract);
  }
  const schemes = spec.components?.securitySchemes;
  if (
    schemes?.["X-Api-Key"]?.type !== "apiKey" ||
    schemes?.["X-Api-Key"]?.in !== "header" ||
    schemes?.["X-Api-Key"]?.name !== "X-Api-Key" ||
    schemes?.apikey?.type !== "apiKey" ||
    schemes?.apikey?.in !== "query" ||
    schemes?.apikey?.name !== "apikey"
  ) {
    fail("OpenAPI snapshot security schemes do not match the Lidarr contract.");
  }
  const globalSecurity = spec.security;
  if (
    !Array.isArray(globalSecurity) ||
    !globalSecurity.some((entry) => Array.isArray(entry?.["X-Api-Key"])) ||
    !globalSecurity.some((entry) => Array.isArray(entry?.apikey))
  ) {
    fail("OpenAPI snapshot global security requirements do not include both Lidarr schemes.");
  }
  assertLocalReferences(spec);
  return spec;
}

function abortError(signal, label) {
  return signal.reason instanceof Error ? signal.reason : new Error(`${label} timed out.`);
}

function raceAbort(promise, signal, label) {
  if (signal.aborted) return Promise.reject(abortError(signal, label));
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(abortError(signal, label));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

async function readBoundedBody(response, maximumBytes, signal, label) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) fail(`${label} has an invalid size.`);
    if (length > maximumBytes) fail(`${label} exceeds the download size limit.`);
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail(`${label} has no readable response body.`);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await raceAbort(reader.read(), signal, label);
      if (done) break;
      if (!(value instanceof Uint8Array)) fail(`${label} returned an invalid response chunk.`);
      total += value.byteLength;
      if (total > maximumBytes) {
        void reader.cancel().catch(() => {});
        fail(`${label} exceeds the download size limit.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function download(url, { fetchImpl, maximumBytes, timeoutMs, label, headers }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out.`)), timeoutMs);
  try {
    const response = await raceAbort(
      fetchImpl(url, {
        headers,
        redirect: "error",
        signal: controller.signal,
      }),
      controller.signal,
      label,
    );
    if (
      response.redirected === true ||
      (response.status >= 300 && response.status < 400) ||
      (response.url && response.url !== url)
    ) {
      fail(`${label} redirected; redirects are forbidden.`);
    }
    if (response.status !== 200) fail(`${label} returned HTTP ${response.status}.`);
    return await readBoundedBody(response, maximumBytes, controller.signal, label);
  } catch (error) {
    if (controller.signal.aborted) throw abortError(controller.signal, label);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function findWorkspaceLock(packageRoot) {
  let directory = packageRoot;
  while (true) {
    const path = join(directory, "package-lock.json");
    if (exists(path)) {
      const lock = parseJson(readFileSync(path), "Package lockfile");
      const workspace = relative(directory, packageRoot).split("\\").join("/");
      if (lock.packages?.[workspace]) return { lock, workspace };
    }
    const parent = dirname(directory);
    if (parent === directory) fail("Unable to locate the rfmedia workspace lockfile.");
    directory = parent;
  }
}

function prepareStagingPackage(packageRoot, stagingRoot, manifest, bytes) {
  for (const path of [PACKAGE_PATH, CONFIG_PATH, TSCONFIG_PATH]) {
    copyFileSync(join(packageRoot, path), join(stagingRoot, path));
  }
  mkdirSync(join(stagingRoot, "openapi"), { recursive: true });
  writeFileSync(join(stagingRoot, SNAPSHOT_PATH), bytes);
  writeFileSync(join(stagingRoot, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
}

function prepareDefaultGenerator(packageRoot, stagingRoot) {
  const { lock, workspace } = findWorkspaceLock(packageRoot);
  const stagedLock = structuredClone(lock);
  stagedLock.packages[""] = structuredClone(lock.packages[workspace]);
  writeFileSync(join(stagingRoot, "package-lock.json"), `${JSON.stringify(stagedLock)}\n`);
}

function assertInstallTargetsSafe(packageRoot) {
  const paths = [SNAPSHOT_PATH, MANIFEST_PATH, GENERATED_PATH];
  for (const path of paths) {
    let current = packageRoot;
    for (const part of path.split("/")) {
      current = join(current, part);
      if (!exists(current)) continue;
      if (lstatSync(current).isSymbolicLink()) {
        fail(`Refusing to refresh through a symlink: ${path}.`);
      }
    }
  }
}

function removeConfinedDirectory(packageRoot, path, prefix) {
  if (dirname(path) !== packageRoot || !basename(path).startsWith(prefix)) {
    fail("Refusing to remove an unconfined refresh directory.");
  }
  rmSync(path, { recursive: true, force: true });
}

function installAtomically(
  packageRoot,
  stagingRoot,
  { rename = renameSync, remove = rmSync } = {},
) {
  assertInstallTargetsSafe(packageRoot);
  const backupRoot = mkdtempSync(join(packageRoot, ".lidarr-refresh-backup-"));
  const entries = [
    { relativePath: SNAPSHOT_PATH, backupName: "snapshot" },
    { relativePath: MANIFEST_PATH, backupName: "manifest" },
    { relativePath: GENERATED_PATH, backupName: "generated" },
  ];
  const backedUp = [];
  const installed = [];
  try {
    for (const entry of entries) {
      const destination = join(packageRoot, entry.relativePath);
      const staged = join(stagingRoot, entry.relativePath);
      const backup = join(backupRoot, entry.backupName);
      if (exists(destination)) {
        rename(destination, backup);
        backedUp.push({ destination, backup });
      }
      rename(staged, destination);
      installed.push(destination);
    }
  } catch (installError) {
    try {
      for (const destination of installed.reverse()) {
        if (exists(destination)) remove(destination, { recursive: true, force: true });
      }
      for (const { destination, backup } of backedUp.reverse()) {
        if (exists(backup)) rename(backup, destination);
      }
    } catch (rollbackError) {
      const installMessage =
        installError instanceof Error ? installError.message : String(installError);
      const rollbackMessage =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(
        `Lidarr OpenAPI install failed (${installMessage}); rollback failed (${rollbackMessage}). ` +
          `Backup preserved at ${backupRoot}.`,
        { cause: new AggregateError([installError, rollbackError]) },
      );
    }
    removeConfinedDirectory(packageRoot, backupRoot, ".lidarr-refresh-backup-");
    throw installError;
  }
  removeConfinedDirectory(packageRoot, backupRoot, ".lidarr-refresh-backup-");
}

function buildManifest(current, commit, rawUrl, bytes, blobSha) {
  const manifest = structuredClone(assertObject(current, "Current Lidarr manifest"));
  manifest.upstream = {
    repository: REPOSITORY,
    commit,
    path: UPSTREAM_PATH,
    url: rawUrl,
    gitBlobSha: blobSha,
  };
  manifest.snapshot = {
    path: SNAPSHOT_PATH,
    sha256: sha256(bytes),
    size: bytes.byteLength,
    openapiVersion: "3.0.4",
  };
  return manifest;
}

/**
 * Refresh from one immutable upstream commit. The injected callbacks and limits
 * are test-only seams; the CLI exposes only the commit and no path or URL input.
 */
export async function runLidarrOpenApiRefresh({
  commit,
  packageRoot = defaultPackageRoot,
  fetchImpl = globalThis.fetch,
  generateClient = runLidarrGeneration,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  maximumSnapshotBytes = MAX_SNAPSHOT_BYTES,
  maximumMetadataBytes = MAX_METADATA_BYTES,
  installOperations,
} = {}) {
  if (typeof commit !== "string" || !/^[a-fA-F0-9]{40}$/.test(commit)) {
    fail("Lidarr ref must be a full 40-hex commit.");
  }
  if (typeof fetchImpl !== "function") fail("Fetch is unavailable.");
  const immutableCommit = commit.toLowerCase();
  const rawUrl = `https://raw.githubusercontent.com/${REPOSITORY}/${immutableCommit}/${UPSTREAM_PATH}`;
  const contentsUrl = `https://api.github.com/repos/${REPOSITORY}/contents/${UPSTREAM_PATH}?ref=${immutableCommit}`;
  const snapshotBytes = await download(rawUrl, {
    fetchImpl,
    maximumBytes: maximumSnapshotBytes,
    timeoutMs,
    label: "Lidarr OpenAPI download",
    headers: { Accept: "application/json" },
  });
  const metadataBytes = await download(contentsUrl, {
    fetchImpl,
    maximumBytes: maximumMetadataBytes,
    timeoutMs,
    label: "Lidarr provenance download",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "rfmedia-lidarr-openapi-refresh",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  validateLidarrOpenApi(snapshotBytes);
  const metadata = assertObject(
    parseJson(metadataBytes, "Lidarr provenance response"),
    "Lidarr provenance response",
  );
  const calculatedBlobSha = gitBlobSha(snapshotBytes);
  if (
    metadata.type !== "file" ||
    metadata.path !== UPSTREAM_PATH ||
    metadata.download_url !== rawUrl ||
    typeof metadata.sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(metadata.sha) ||
    metadata.sha !== calculatedBlobSha
  ) {
    fail("Downloaded Lidarr schema does not match its immutable GitHub provenance.");
  }

  const resolvedPackageRoot = realpathSync(resolve(packageRoot));
  assertInstallTargetsSafe(resolvedPackageRoot);
  const currentManifest = parseJson(
    readFileSync(join(resolvedPackageRoot, MANIFEST_PATH)),
    "Current Lidarr manifest",
  );
  const manifest = buildManifest(
    currentManifest,
    immutableCommit,
    rawUrl,
    snapshotBytes,
    calculatedBlobSha,
  );
  const stagingRoot = mkdtempSync(join(resolvedPackageRoot, ".lidarr-refresh-"));
  try {
    prepareStagingPackage(resolvedPackageRoot, stagingRoot, manifest, snapshotBytes);
    if (generateClient === runLidarrGeneration) {
      prepareDefaultGenerator(resolvedPackageRoot, stagingRoot);
    }
    await generateClient({ packageRoot: stagingRoot, mode: "write" });
    if (!exists(join(stagingRoot, GENERATED_PATH))) {
      fail("Lidarr generation did not produce the staged client tree.");
    }
    installAtomically(resolvedPackageRoot, stagingRoot, installOperations);
    return {
      commit: immutableCommit,
      gitBlobSha: calculatedBlobSha,
      sha256: manifest.snapshot.sha256,
      size: snapshotBytes.byteLength,
    };
  } finally {
    if (exists(stagingRoot)) {
      removeConfinedDirectory(resolvedPackageRoot, stagingRoot, ".lidarr-refresh-");
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) fail("Usage: refresh-lidarr-openapi.mjs <40-hex-commit>");
  const result = await runLidarrOpenApiRefresh({ commit: args[0] });
  console.log(
    `OK: refreshed Lidarr OpenAPI at ${result.commit} (${result.size} bytes, SHA-256 ${result.sha256}).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Lidarr OpenAPI refresh failed.");
    process.exitCode = 1;
  });
}
