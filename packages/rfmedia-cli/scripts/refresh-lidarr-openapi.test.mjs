import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runLidarrOpenApiRefresh } from "./refresh-lidarr-openapi.mjs";

const COMMIT = "a".repeat(40);
const RAW_URL =
  `https://raw.githubusercontent.com/Lidarr/Lidarr/${COMMIT}/` + "src/Lidarr.Api.V1/openapi.json";
const CONTENTS_URL =
  "https://api.github.com/repos/Lidarr/Lidarr/contents/" +
  `src/Lidarr.Api.V1/openapi.json?ref=${COMMIT}`;

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function blobDigest(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function schema(overrides = {}) {
  return {
    openapi: "3.0.4",
    info: { title: "Lidarr", version: "1.0.0" },
    security: [{ "X-Api-Key": [] }, { apikey: [] }],
    paths: {
      "/api/v1/artist": {
        get: {
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ArtistResource" },
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/health": {
        get: {
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/HealthResource" },
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/system/status": {
        get: {
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SystemResource" },
                },
              },
            },
          },
        },
      },
      "/api/v1/wanted/missing": {
        get: {
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AlbumResourcePagingResource" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        "X-Api-Key": { type: "apiKey", in: "header", name: "X-Api-Key" },
        apikey: { type: "apiKey", in: "query", name: "apikey" },
      },
      schemas: {
        ArtistResource: { type: "object" },
        HealthResource: { type: "object" },
        SystemResource: { type: "object" },
        AlbumResourcePagingResource: { type: "object" },
      },
    },
    ...overrides,
  };
}

function bytesFor(spec = schema()) {
  return Buffer.from(`${JSON.stringify(spec)}\n`);
}

function response(body, init) {
  return new Response(body, init);
}

function metadata(bytes, overrides = {}) {
  return {
    type: "file",
    path: "src/Lidarr.Api.V1/openapi.json",
    download_url: RAW_URL,
    sha: blobDigest(bytes),
    ...overrides,
  };
}

function makeFetch(snapshotBytes, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === RAW_URL) return options.rawResponse ?? response(snapshotBytes);
    if (url === CONTENTS_URL) {
      return (
        options.metadataResponse ??
        response(JSON.stringify(metadata(snapshotBytes, options.metadataOverrides)))
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { calls, fetchImpl };
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "rfmedia-lidarr-refresh-test-"));
  const oldSnapshot = Buffer.from('{"old":true}\n');
  const oldManifest = {
    schemaVersion: 1,
    upstream: { commit: "b".repeat(40) },
    snapshot: { sha256: "old" },
    generator: { package: "@hey-api/openapi-ts", version: "0.93.0" },
  };
  write(join(root, "openapi/lidarr-v1.json"), oldSnapshot);
  write(join(root, "openapi/lidarr-v1.manifest.json"), `${JSON.stringify(oldManifest, null, 2)}\n`);
  write(join(root, "src/lib/lidarr/generated/old.ts"), "old generated tree\n");
  write(join(root, "package.json"), '{"type":"module"}\n');
  write(join(root, "openapi-ts.config.mjs"), "export default {};\n");
  write(join(root, "tsconfig.json"), "{}\n");
  return { oldManifest, oldSnapshot, root };
}

async function withFixture(callback) {
  const fixture = createFixture();
  try {
    await callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function snapshotFixture(root) {
  return {
    generated: readFileSync(join(root, "src/lib/lidarr/generated/old.ts"), "utf8"),
    manifest: readFileSync(join(root, "openapi/lidarr-v1.manifest.json"), "utf8"),
    snapshot: readFileSync(join(root, "openapi/lidarr-v1.json")),
  };
}

const writeGeneratedFixture = async ({ packageRoot }) => {
  write(join(packageRoot, "src/lib/lidarr/generated/new.ts"), "new generated tree\n");
};

test("rejects mutable, abbreviated, and otherwise invalid refs before Fetch", async () => {
  for (const commit of ["develop", "main", "abc123", "g".repeat(40), `${COMMIT}0`]) {
    let called = false;
    await assert.rejects(
      runLidarrOpenApiRefresh({
        commit,
        fetchImpl: async () => {
          called = true;
        },
      }),
      /full 40-hex commit/,
    );
    assert.equal(called, false);
  }
});

test("constructs only fixed allowlisted URLs and rejects redirects", async () => {
  await withFixture(async ({ root }) => {
    const bytes = bytesFor();
    const { calls, fetchImpl } = makeFetch(bytes, {
      rawResponse: response(null, { status: 302, headers: { Location: "https://example.test" } }),
    });
    await assert.rejects(
      runLidarrOpenApiRefresh({
        commit: COMMIT.toUpperCase(),
        packageRoot: root,
        fetchImpl,
        generateClient: writeGeneratedFixture,
      }),
      /redirects are forbidden/,
    );
    assert.deepEqual(
      calls.map((call) => call.url),
      [RAW_URL],
    );
    for (const call of calls) assert.equal(call.init.redirect, "error");
  });
});

test("times out a stalled response body and cancels its reader", async () => {
  await withFixture(async ({ root }) => {
    let cancelled = false;
    const stalledResponse = {
      body: {
        getReader: () => ({
          cancel: async () => {
            cancelled = true;
          },
          read: async () => new Promise(() => {}),
        }),
      },
      headers: new Headers(),
      redirected: false,
      status: 200,
      url: "",
    };
    const bytes = bytesFor();
    const { fetchImpl } = makeFetch(bytes, { rawResponse: stalledResponse });
    await assert.rejects(
      runLidarrOpenApiRefresh({
        commit: COMMIT,
        packageRoot: root,
        fetchImpl,
        generateClient: writeGeneratedFixture,
        timeoutMs: 20,
      }),
      /timed out/,
    );
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(cancelled, true);
  });
});

test("rejects declared and streamed oversized downloads", async (t) => {
  await t.test("declared", async () => {
    await withFixture(async ({ root }) => {
      const bytes = bytesFor();
      const { fetchImpl } = makeFetch(bytes, {
        rawResponse: response(bytes, { headers: { "Content-Length": "1000" } }),
      });
      await assert.rejects(
        runLidarrOpenApiRefresh({
          commit: COMMIT,
          packageRoot: root,
          fetchImpl,
          generateClient: writeGeneratedFixture,
          maximumSnapshotBytes: 100,
        }),
        /size limit/,
      );
    });
  });
  await t.test("streamed", async () => {
    await withFixture(async ({ root }) => {
      const bytes = bytesFor();
      const rawResponse = response(bytes);
      rawResponse.headers.delete("content-length");
      const { fetchImpl } = makeFetch(bytes, { rawResponse });
      await assert.rejects(
        runLidarrOpenApiRefresh({
          commit: COMMIT,
          packageRoot: root,
          fetchImpl,
          generateClient: writeGeneratedFixture,
          maximumSnapshotBytes: 100,
        }),
        /size limit/,
      );
    });
  });
});

test("rejects invalid JSON and non-local references", async (t) => {
  await t.test("invalid JSON", async () => {
    await withFixture(async ({ root }) => {
      const bytes = Buffer.from("not json");
      const { fetchImpl } = makeFetch(bytes);
      await assert.rejects(
        runLidarrOpenApiRefresh({
          commit: COMMIT,
          packageRoot: root,
          fetchImpl,
          generateClient: writeGeneratedFixture,
        }),
        /not valid UTF-8 JSON/,
      );
    });
  });
  await t.test("remote ref", async () => {
    await withFixture(async ({ root }) => {
      const spec = schema();
      spec.components.schemas.ArtistResource = { $ref: "https://example.test/schema.json" };
      const bytes = bytesFor(spec);
      const { fetchImpl } = makeFetch(bytes);
      await assert.rejects(
        runLidarrOpenApiRefresh({
          commit: COMMIT,
          packageRoot: root,
          fetchImpl,
          generateClient: writeGeneratedFixture,
        }),
        /non-local \$ref/,
      );
    });
  });
});

test("rejects missing operation, response, and security contracts", async (t) => {
  await t.test("operation", async () => {
    await withFixture(async ({ root }) => {
      const spec = schema();
      delete spec.paths["/api/v1/health"];
      const bytes = bytesFor(spec);
      const { fetchImpl } = makeFetch(bytes);
      await assert.rejects(
        runLidarrOpenApiRefresh({
          commit: COMMIT,
          packageRoot: root,
          fetchImpl,
          generateClient: writeGeneratedFixture,
        }),
        /missing GET \/api\/v1\/health/,
      );
    });
  });
  await t.test("response schema", async () => {
    await withFixture(async ({ root }) => {
      const spec = schema();
      spec.paths["/api/v1/artist"].get.responses[200].content[
        "application/json"
      ].schema.items.$ref = "#/components/schemas/OtherResource";
      const bytes = bytesFor(spec);
      const { fetchImpl } = makeFetch(bytes);
      await assert.rejects(
        runLidarrOpenApiRefresh({
          commit: COMMIT,
          packageRoot: root,
          fetchImpl,
          generateClient: writeGeneratedFixture,
        }),
        /response contract changed/,
      );
    });
  });
  await t.test("security", async () => {
    await withFixture(async ({ root }) => {
      const spec = schema();
      delete spec.components.securitySchemes.apikey;
      const bytes = bytesFor(spec);
      const { fetchImpl } = makeFetch(bytes);
      await assert.rejects(
        runLidarrOpenApiRefresh({
          commit: COMMIT,
          packageRoot: root,
          fetchImpl,
          generateClient: writeGeneratedFixture,
        }),
        /security schemes/,
      );
    });
  });
});

test("rejects provenance mismatches", async () => {
  await withFixture(async ({ root }) => {
    const bytes = bytesFor();
    const { fetchImpl } = makeFetch(bytes, { metadataOverrides: { sha: "b".repeat(40) } });
    await assert.rejects(
      runLidarrOpenApiRefresh({
        commit: COMMIT,
        packageRoot: root,
        fetchImpl,
        generateClient: writeGeneratedFixture,
      }),
      /does not match its immutable GitHub provenance/,
    );
  });
});

test("generation failure preserves the complete last-known-good state", async () => {
  await withFixture(async ({ root }) => {
    const before = snapshotFixture(root);
    const bytes = bytesFor();
    const { fetchImpl } = makeFetch(bytes);
    await assert.rejects(
      runLidarrOpenApiRefresh({
        commit: COMMIT,
        packageRoot: root,
        fetchImpl,
        generateClient: async ({ packageRoot }) => {
          assert.deepEqual(readFileSync(join(packageRoot, "openapi/lidarr-v1.json")), bytes);
          const manifest = JSON.parse(
            readFileSync(join(packageRoot, "openapi/lidarr-v1.manifest.json"), "utf8"),
          );
          assert.equal(manifest.upstream.commit, COMMIT);
          throw new Error("generation failed");
        },
      }),
      /generation failed/,
    );
    assert.deepEqual(snapshotFixture(root), before);
    assert.equal(
      readdirSync(root).some((name) => name.startsWith(".lidarr-refresh-")),
      false,
    );
  });
});

test("rollback failure preserves and reports the last-known-good backup", async () => {
  await withFixture(async ({ root }) => {
    const bytes = bytesFor();
    const { fetchImpl } = makeFetch(bytes);
    let renameCalls = 0;
    let failure;

    try {
      await runLidarrOpenApiRefresh({
        commit: COMMIT,
        packageRoot: root,
        fetchImpl,
        generateClient: writeGeneratedFixture,
        installOperations: {
          rename: (source, destination) => {
            renameCalls += 1;
            if (renameCalls === 6) throw new Error("simulated install failure");
            if (renameCalls === 7) throw new Error("simulated rollback failure");
            renameSync(source, destination);
          },
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof Error);
    assert.match(failure.message, /simulated install failure/);
    assert.match(failure.message, /simulated rollback failure/);
    const backupMatch = failure.message.match(/Backup preserved at (.+)\.$/);
    assert.ok(backupMatch);
    const backupRoot = backupMatch[1];
    assert.equal(dirname(backupRoot), root);
    assert.match(backupRoot, /\.lidarr-refresh-backup-/);
    assert.deepEqual(readFileSync(join(backupRoot, "snapshot")), Buffer.from('{"old":true}\n'));
    assert.match(readFileSync(join(backupRoot, "manifest"), "utf8"), /"schemaVersion": 1/);
    assert.equal(
      readFileSync(join(backupRoot, "generated/old.ts"), "utf8"),
      "old generated tree\n",
    );
    assert.equal(
      readdirSync(root).some(
        (name) =>
          name.startsWith(".lidarr-refresh-") && !name.startsWith(".lidarr-refresh-backup-"),
      ),
      false,
    );
  });
});

test("success installs the snapshot, manifest, and generated tree together", async () => {
  await withFixture(async ({ root }) => {
    const bytes = bytesFor();
    const { calls, fetchImpl } = makeFetch(bytes);
    const result = await runLidarrOpenApiRefresh({
      commit: COMMIT,
      packageRoot: root,
      fetchImpl,
      generateClient: writeGeneratedFixture,
    });
    assert.deepEqual(readFileSync(join(root, "openapi/lidarr-v1.json")), bytes);
    const manifest = JSON.parse(
      readFileSync(join(root, "openapi/lidarr-v1.manifest.json"), "utf8"),
    );
    assert.equal(manifest.upstream.repository, "Lidarr/Lidarr");
    assert.equal(manifest.upstream.commit, COMMIT);
    assert.equal(manifest.upstream.path, "src/Lidarr.Api.V1/openapi.json");
    assert.equal(manifest.upstream.url, RAW_URL);
    assert.equal(manifest.upstream.gitBlobSha, blobDigest(bytes));
    assert.equal(manifest.snapshot.size, bytes.length);
    assert.equal(manifest.snapshot.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(
      readFileSync(join(root, "src/lib/lidarr/generated/new.ts"), "utf8"),
      "new generated tree\n",
    );
    assert.equal(readdirSync(join(root, "src/lib/lidarr/generated")).includes("old.ts"), false);
    assert.deepEqual(calls.map((call) => call.url).sort(), [CONTENTS_URL, RAW_URL].sort());
    assert.deepEqual(result, {
      commit: COMMIT,
      gitBlobSha: blobDigest(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    });
    assert.equal(
      readdirSync(root).some((name) => name.startsWith(".lidarr-refresh-")),
      false,
    );
  });
});
