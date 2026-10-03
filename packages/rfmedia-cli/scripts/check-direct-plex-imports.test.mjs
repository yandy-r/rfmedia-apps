import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { auditPlexBoundaries } from "./check-direct-plex-imports.mjs";

const realPackageRoot = join(import.meta.dirname, "..");
const artistAddEntryOwner = "src/actions/lidarr/apply-artist-add-entry-execution.ts";

function withFixture(files, assertion) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rfmedia-plex-audit-"));
  try {
    const fixtureFiles = {
      "src/lib/adapters/plex/client.ts":
        'export const load = (token) => fetch("/library", { headers: { "X-Plex-Token": token } });\n',
      ...files,
    };
    for (const [relativePath, content] of Object.entries(fixtureFiles)) {
      const absolutePath = join(fixtureRoot, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content, "utf8");
    }
    assertion(auditPlexBoundaries(fixtureRoot));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function assertOnlyRule(result, rule) {
  assert.deepEqual(
    result.violations.map((violation) => violation.rule),
    [rule],
  );
}

test("rejects a direct import of the deleted legacy Plex facade", () => {
  withFixture({ "src/actions/example.ts": 'import { query } from "../lib/plex.js";\n' }, (result) =>
    assertOnlyRule(result, "legacy-plex-module"),
  );
});

test("rejects an upper-layer import of a private Plex adapter module", () => {
  withFixture(
    { "src/lib/adapters/bypass.ts": 'import { PlexClient } from "./plex/client.js";\n' },
    (result) => assertOnlyRule(result, "private-plex-import"),
  );
});

for (const [label, source, extraFiles, rule] of [
  [
    "private Plex modules",
    'import { PlexTransport } from "../adapters/plex/client.js";\nexport { PlexTransport };\n',
    {},
    "private-plex-import",
  ],
  [
    "generated Lidarr modules",
    'import { generated } from "../lidarr/generated/sdk.gen.js";\nexport const value = generated;\n',
    { "src/lib/lidarr/generated/sdk.gen.ts": "export const generated = 1;\n" },
    "private-lidarr-generated-import",
  ],
  [
    "handwritten Lidarr endpoints",
    'export const endpoint = "/api/v1/artist";\n',
    {},
    "handwritten-lidarr-api-path",
  ],
  [
    "owned provider fetch",
    'export const load = () => fetch("https://musicbrainz.org/ws/2/artist");\n',
    {},
    "plex-fetch-owner",
  ],
]) {
  test(`rejects bridge access to ${label}`, () => {
    withFixture(
      {
        "src/lib/bridge/bypass.ts": source,
        ...extraFiles,
      },
      (result) => assertOnlyRule(result, rule),
    );
  });
}

test("rejects authenticated fetch ownership outside the private Plex adapter", () => {
  withFixture(
    {
      "src/actions/example.ts":
        'export const load = (token) => fetch("https://plex.invalid", { headers: { "X-Plex-Token": token } });\n',
    },
    (result) => assertOnlyRule(result, "plex-fetch-owner"),
  );
});

test("rejects a second fetch owner in another private Plex endpoint module", () => {
  withFixture(
    { "src/lib/adapters/plex/query-library.ts": 'export const load = () => fetch("/library");\n' },
    (result) => assertOnlyRule(result, "plex-fetch-owner"),
  );
});

test("rejects an upper-layer endpoint fetch without an inline authentication literal", () => {
  withFixture(
    { "src/actions/example.ts": 'export const load = () => fetch("/library/sections");\n' },
    (result) => assertOnlyRule(result, "plex-fetch-owner"),
  );
});

test("rejects an imported MusicBrainz dependency without adding a fetch exemption", () => {
  withFixture(
    {
      "src/lib/bridge/mapping.ts":
        'import { MusicBrainzApi } from "musicbrainz-api";\nexport const client = new MusicBrainzApi();\n',
    },
    (result) => assertOnlyRule(result, "musicbrainz-dependency"),
  );
});

test("rejects a MusicBrainz package manifest dependency", () => {
  withFixture(
    {
      "package.json": JSON.stringify({
        dependencies: { "musicbrainz-api": "1.0.0" },
      }),
    },
    (result) => assertOnlyRule(result, "musicbrainz-dependency"),
  );
});

test("requires exactly one fetch site in the private Plex client", () => {
  withFixture(
    { "src/lib/adapters/plex/client.ts": "export const load = () => undefined;\n" },
    (result) => assertOnlyRule(result, "plex-fetch-owner-count"),
  );
});

test("rejects Plex compatibility imports outside the documented projection allowlist", () => {
  withFixture(
    { "src/lib/generic-helper.ts": 'import type { PlexTrack } from "../types/plex.js";\n' },
    (result) => assertOnlyRule(result, "plex-compatibility-import"),
  );
});

test("allows the private transport, public composer, and established projection boundary", () => {
  withFixture(
    {
      "src/lib/adapters/plex-adapter.ts":
        'import { PlexClient } from "./plex/client.js";\nexport { PlexClient };\n',
      "src/commands/plex.ts": 'import type { PlexTrack } from "../types/plex.js";\n',
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

test("allows the Lidarr transport as the sole handwritten Fetch owner", () => {
  withFixture(
    {
      "src/lib/lidarr/transport.ts": "export const load = (request) => trustedFetch(request);\n",
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

test("requires exactly one Fetch site in the Lidarr transport when present", () => {
  withFixture(
    { "src/lib/lidarr/transport.ts": "export const load = () => undefined;\n" },
    (result) => assertOnlyRule(result, "lidarr-fetch-owner-count"),
  );
});

test("rejects multiple Fetch sites in the Lidarr transport", () => {
  withFixture(
    {
      "src/lib/lidarr/transport.ts":
        "export const first = (request) => fetch(request);\nexport const second = (request) => fetch(request);\n",
    },
    (result) => assertOnlyRule(result, "lidarr-fetch-owner-count"),
  );
});

test("rejects upper-layer Fetch ownership", () => {
  withFixture(
    { "src/actions/example.ts": 'export const load = () => fetch("https://lidarr.invalid");\n' },
    (result) => assertOnlyRule(result, "plex-fetch-owner"),
  );
});

test("allows the exact Last.fm module as the sole provider Fetch owner", () => {
  withFixture(
    {
      "src/lib/discovery/lastfm.ts":
        'export const load = (request) => fetch(request, { redirect: "error" });\n',
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

test("requires exactly one Fetch site in the Last.fm module when present", () => {
  withFixture(
    { "src/lib/discovery/lastfm.ts": "export const load = () => undefined;\n" },
    (result) => assertOnlyRule(result, "lastfm-fetch-owner-count"),
  );
});

test("rejects multiple Fetch sites in the Last.fm module", () => {
  withFixture(
    {
      "src/lib/discovery/lastfm.ts":
        "export const first = (request) => fetch(request);\nexport const second = (request) => fetch(request);\n",
    },
    (result) => assertOnlyRule(result, "lastfm-fetch-owner-count"),
  );
});

for (const [label, file] of [
  ["the command layer", "src/commands/lidarr-discover.ts"],
  ["the action layer", "src/actions/lidarr/discover.ts"],
  ["a second provider module", "src/lib/discovery/musicbrainz.ts"],
]) {
  test(`rejects a provider Fetch site in ${label}`, () => {
    withFixture(
      {
        "src/lib/discovery/lastfm.ts":
          'export const load = (request) => fetch(request, { redirect: "error" });\n',
        [file]: 'export const load = () => fetch("https://ws.audioscrobbler.com/2.0/");\n',
      },
      (result) => assertOnlyRule(result, "plex-fetch-owner"),
    );
  });
}

test("allows the facade to import generated operations", () => {
  withFixture(
    {
      "src/lib/lidarr/client.ts":
        'import { getSystemStatus } from "./generated/sdk.gen.js";\nexport const load = () => getSystemStatus();\n',
      "src/lib/lidarr/generated/sdk.gen.ts": "export const getSystemStatus = () => undefined;\n",
      "src/lib/lidarr/transport.ts": "export const load = (request) => trustedFetch(request);\n",
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

test("allows imports wholly within the generated tree", () => {
  withFixture(
    {
      "src/lib/lidarr/generated/client/client.gen.ts":
        'import type { ApiResponse } from "../core/types.gen.js";\nexport type Result = ApiResponse;\n',
      "src/lib/lidarr/generated/core/types.gen.ts": "export type ApiResponse = unknown;\n",
      "src/lib/lidarr/transport.ts": "export const load = (request) => trustedFetch(request);\n",
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

for (const [label, file, specifier] of [
  ["action", "src/actions/example.ts", "../lib/lidarr/generated/sdk.gen.js"],
  ["command", "src/commands/example.ts", "../lib/lidarr/generated/sdk.gen.js"],
  ["public type", "src/types/example.ts", "../lib/lidarr/generated/types.gen.js"],
  ["helper", "src/lib/helper.ts", "./lidarr/generated/sdk.gen.js"],
]) {
  test(`rejects a generated import from an upper-layer ${label}`, () => {
    withFixture(
      {
        [file]: `import { generated } from "${specifier}";\nexport const value = generated;\n`,
        "src/lib/lidarr/generated/sdk.gen.ts": "export const generated = 1;\n",
        "src/lib/lidarr/generated/types.gen.ts": "export type Generated = unknown;\n",
        "src/lib/lidarr/transport.ts": "export const load = (request) => trustedFetch(request);\n",
      },
      (result) => assertOnlyRule(result, "private-lidarr-generated-import"),
    );
  });
}

for (const [label, file, source, rule] of [
  [
    "preset action generated operation import",
    "src/actions/lidarr/profile-presets.ts",
    'import { postApiV1Customformat } from "../../lib/lidarr/generated/sdk.gen.js";\nexport const apply = postApiV1Customformat;\n',
    "private-lidarr-generated-import",
  ],
  [
    "preset type generated mutation body",
    "src/types/lidarr-presets.ts",
    'import type { CustomFormatResource } from "../lib/lidarr/generated/types.gen.js";\nexport type PresetBody = CustomFormatResource;\n',
    "private-lidarr-generated-import",
  ],
  [
    "preset action handwritten endpoint",
    "src/actions/lidarr/profile-presets.ts",
    'export const endpoint = "/api/v1/customformat";\n',
    "handwritten-lidarr-api-path",
  ],
  [
    "preset action Fetch ownership",
    "src/actions/lidarr/profile-presets.ts",
    "export const apply = (request) => fetch(request);\n",
    "plex-fetch-owner",
  ],
]) {
  test(`rejects ${label} outside the stable facade`, () => {
    withFixture(
      {
        [file]: source,
        "src/lib/lidarr/generated/sdk.gen.ts":
          "export const postApiV1Customformat = () => undefined;\n",
        "src/lib/lidarr/generated/types.gen.ts": "export type CustomFormatResource = unknown;\n",
        "src/lib/lidarr/transport.ts": "export const load = (request) => trustedFetch(request);\n",
      },
      (result) => assertOnlyRule(result, rule),
    );
  });
}

test("rejects direct generated re-exports from the facade", () => {
  withFixture(
    {
      "src/lib/lidarr/client.ts": 'export { generated } from "./generated/sdk.gen.js";\n',
      "src/lib/lidarr/generated/sdk.gen.ts": "export const generated = 1;\n",
      "src/lib/lidarr/transport.ts": "export const load = (request) => trustedFetch(request);\n",
    },
    (result) => assertOnlyRule(result, "lidarr-generated-reexport"),
  );
});

test("rejects imported generated symbols re-exported from the facade", () => {
  withFixture(
    {
      "src/lib/lidarr/client.ts":
        'import { generated } from "./generated/sdk.gen.js";\nexport { generated };\n',
      "src/lib/lidarr/generated/sdk.gen.ts": "export const generated = 1;\n",
      "src/lib/lidarr/transport.ts": "export const load = (request) => trustedFetch(request);\n",
    },
    (result) => assertOnlyRule(result, "lidarr-generated-reexport"),
  );
});

test("rejects generated re-exports from a public barrel", () => {
  withFixture(
    {
      "src/index.ts": 'export * from "./lib/lidarr/generated/index.js";\n',
      "src/lib/lidarr/generated/index.ts": "export const generated = 1;\n",
      "src/lib/lidarr/transport.ts": "export const load = (request) => trustedFetch(request);\n",
    },
    (result) => assertOnlyRule(result, "lidarr-generated-reexport"),
  );
});

test("rejects handwritten Lidarr API path literals", () => {
  withFixture(
    {
      "src/lib/lidarr/helper.ts": 'export const path = "/api/v1/health";\n',
      "src/lib/lidarr/transport.ts": "export const load = (request) => trustedFetch(request);\n",
    },
    (result) => assertOnlyRule(result, "handwritten-lidarr-api-path"),
  );
});

test("allows Lidarr API path strings in generated code, tests, and non-source docs", () => {
  withFixture(
    {
      "src/lib/lidarr/generated/sdk.gen.ts": 'export const path = "/api/v1/health";\n',
      "src/lib/lidarr/client.test.ts": 'const path = "/api/v1/health";\n',
      "docs/plans/example.md": "`/api/v1/health`\n",
      "src/lib/lidarr/transport.ts": "export const load = (request) => trustedFetch(request);\n",
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

test("rejects a generated artist editor operation outside the stable Lidarr client", () => {
  withFixture(
    {
      "src/actions/example.ts":
        "export const edit = () => putApiV1ArtistEditor({ body: undefined });\n",
    },
    (result) => assertOnlyRule(result, "lidarr-generated-editor-owner"),
  );
});

test("rejects an artist-editor-shaped request body outside the stable Lidarr client", () => {
  withFixture(
    {
      "src/actions/example.ts":
        "export const body = { artistIds: [1], qualityProfileId: 4, moveFiles: false };\n",
    },
    (result) => assertOnlyRule(result, "lidarr-editor-body-owner"),
  );
});

test("rejects broad generated artist editor body types outside the stable Lidarr client", () => {
  withFixture(
    {
      "src/actions/example.ts": "export const edit = (body: ArtistEditorResource) => body;\n",
    },
    (result) => assertOnlyRule(result, "lidarr-editor-body-owner"),
  );
});

for (const [method, args] of [
  ["setArtistProfiles", "1, { qualityProfileId: 4 }"],
  ["updateArtistTags", '1, { mode: "add", tagIds: [2] }'],
]) {
  test(`rejects ${method} calls outside the registered operation ownership path`, () => {
    withFixture(
      {
        "src/actions/example.ts": `export const edit = (client) => client.${method}(${args});\n`,
      },
      (result) => assertOnlyRule(result, "lidarr-profile-tag-mutation-owner"),
    );
  });
}

for (const [label, source] of [
  [
    "string-literal element access",
    'export const edit = (client) => client["setArtistProfiles"](1, { qualityProfileId: 4 });\n',
  ],
  [
    "an alias of a property access",
    "export const edit = (client) => { const assign = client.setArtistProfiles; return assign(1, { qualityProfileId: 4 }); };\n",
  ],
  [
    "an alias of string-literal element access",
    'export const edit = (client) => { const mutate = client["updateArtistTags"]; return mutate(1, { mode: "clear", tagIds: [] }); };\n',
  ],
  [
    "a destructured binding",
    "export const edit = (client) => { const { setArtistProfiles } = client; return setArtistProfiles(1, { qualityProfileId: 4 }); };\n",
  ],
  [
    "a renamed destructured binding",
    'export const edit = (client) => { const { updateArtistTags: mutate } = client; return mutate(1, { mode: "add", tagIds: [2] }); };\n',
  ],
  [
    "an alias of a destructured binding",
    'export const edit = (client) => { const { updateArtistTags } = client; const mutate = updateArtistTags; return mutate(1, { mode: "add", tagIds: [2] }); };\n',
  ],
]) {
  test(`rejects ${label} outside the registered operation ownership path`, () => {
    withFixture({ "src/actions/example.ts": source }, (result) =>
      assertOnlyRule(result, "lidarr-profile-tag-mutation-owner"),
    );
  });
}

test("allows editor construction in the facade and mutation calls in registered owners", () => {
  withFixture(
    {
      "src/lib/lidarr/client.ts":
        "export const edit = () => putApiV1ArtistEditor({ body: { artistIds: [1], qualityProfileId: 4 } });\n",
      "src/lib/lidarr/plan-operation-definitions.ts":
        'export const apply = async (client) => { const { setArtistProfiles: assign } = client; await assign(1, { qualityProfileId: 4 }); await client["updateArtistTags"](1, { mode: "clear", tagIds: [] }); };\n',
      "src/lib/lidarr/resilience.ts":
        'export const wrap = async (inner) => { const mutate = inner.updateArtistTags; await inner.setArtistProfiles(1, { qualityProfileId: 4 }); await mutate(1, { mode: "clear", tagIds: [] }); };\n',
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

test("does not treat unrelated local functions with mutation-like names as client bindings", () => {
  withFixture(
    {
      "src/actions/example.ts": [
        "const setArtistProfiles = () => undefined;",
        "const updateArtistTags = setArtistProfiles;",
        "const shadowed = client.setArtistProfiles;",
        "export const safe = () => { const shadowed = () => undefined; return shadowed(); };",
        "export const edit = () => updateArtistTags();",
        "",
      ].join("\n"),
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

for (const [method, args] of [
  ["deleteAlbum", "1, { deleteFiles: false, addImportListExclusion: true }"],
  ["setAlbumAnyReleaseOk", "1, true"],
]) {
  test(`rejects ${method} calls outside the registered album operation ownership path`, () => {
    withFixture(
      {
        "src/actions/example.ts": `export const edit = (client) => client.${method}(${args});\n`,
      },
      (result) => assertOnlyRule(result, "lidarr-album-mutation-owner"),
    );
  });
}

test("allows album mutation calls in the album operation module and resilience decorator", () => {
  withFixture(
    {
      "src/lib/lidarr/plan-album-operations.ts":
        "export const apply = async (client) => { await client.deleteAlbum(1, { deleteFiles: false, addImportListExclusion: true }); await client.setAlbumAnyReleaseOk(1, true); };\n",
      "src/lib/lidarr/resilience.ts":
        "export const wrap = async (inner) => { await inner.deleteAlbum(1, { deleteFiles: true, addImportListExclusion: false }); await inner.setAlbumAnyReleaseOk(1, false); };\n",
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

test("confines bulk trackfile deletion to its apply owner and resilience decorator", () => {
  withFixture(
    {
      "src/actions/example.ts":
        "export const remove = (client) => client.bulkDeleteTrackFiles([1]);\n",
    },
    (result) => assertOnlyRule(result, "lidarr-track-filter-mutation-owner"),
  );
  withFixture(
    {
      "src/actions/lidarr/apply-track-filter-execution.ts":
        "export const apply = (client) => client.bulkDeleteTrackFiles([1]);\n",
      "src/lib/lidarr/resilience.ts":
        "export const wrap = (inner) => inner.bulkDeleteTrackFiles([1]);\n",
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

for (const [label, file, source] of [
  [
    "planner action",
    "src/actions/lidarr/plan-artist-add.ts",
    "export const add = (client, input) => client.addArtist(input);\n",
  ],
  [
    "command",
    "src/commands/lidarr-discover.ts",
    "export const add = (client, input) => client.addArtist(input);\n",
  ],
  [
    "plan operation definition",
    "src/lib/lidarr/plan-operation-definitions.ts",
    "export const add = (client, input) => { const create = client.addArtist; return create(input); };\n",
  ],
]) {
  test(`rejects addArtist calls from an unauthorized ${label}`, () => {
    withFixture({ [file]: source }, (result) =>
      assertOnlyRule(result, "lidarr-artist-add-mutation-owner"),
    );
  });
}

test("allows addArtist calls in the dedicated apply owner and resilience decorator", () => {
  withFixture(
    {
      "src/actions/lidarr/apply-artist-add-entry-execution.ts":
        "export const apply = (client, input) => client.addArtist(input);\n",
      "src/lib/lidarr/resilience.ts":
        "export const wrap = (inner, input) => inner.addArtist(input);\n",
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

test("rejects setAlbumsMonitored calls outside the registered apply ownership paths", () => {
  withFixture(
    { "src/commands/lidarr-discover.ts": "client.setAlbumsMonitored([], false);\n" },
    (result) => assertOnlyRule(result, "lidarr-album-monitoring-mutation-owner"),
  );
});

test("allows setAlbumsMonitored calls only in established apply owners and resilience", () => {
  withFixture(
    {
      "src/lib/lidarr/plan-engine.ts": "client.setAlbumsMonitored([], true);\n",
      [artistAddEntryOwner]: "client.setAlbumsMonitored([], false);\n",
      "src/lib/lidarr/resilience.ts": "inner.setAlbumsMonitored([], false);\n",
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

test("passes while the album operation owner is absent and no album mutation call sites exist", () => {
  withFixture({ "src/actions/example.ts": "export const value = 1;\n" }, (result) =>
    assert.deepEqual(result.violations, []),
  );
});

test("does not flag a local deleteAlbum helper unrelated to the Lidarr client", () => {
  withFixture(
    {
      "src/actions/example.ts": [
        "const deleteAlbum = async (album) => {",
        "  return undefined;",
        "};",
        'export const run = async () => { await deleteAlbum("Album Name"); };',
        "",
      ].join("\n"),
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

test("ignores editor-like text in comments, strings, tests, and separate domain objects", () => {
  withFixture(
    {
      "src/actions/example.ts": [
        "// putApiV1ArtistEditor({ body: { artistIds: [1], moveFiles: true } });",
        'export const note = "client.updateArtistTags(1, mutation)";',
        "// const { setArtistProfiles: assign } = client; assign(1, { qualityProfileId: 4 });",
        "export const aliasNote = 'client[\"updateArtistTags\"](1, mutation)';",
        'export const selection = { kind: "ids", artistIds: [1] };',
        "export const filter = { qualityProfileId: 4 };",
        "",
      ].join("\n"),
      "src/actions/example.test.ts":
        'const { setArtistProfiles } = client;\nsetArtistProfiles(1, { qualityProfileId: 4 });\nclient["updateArtistTags"](1, mutation);\n',
    },
    (result) => assert.deepEqual(result.violations, []),
  );
});

test("the real rfmedia production tree satisfies the Plex and Lidarr architecture boundaries", () => {
  const result = auditPlexBoundaries(realPackageRoot);
  assert.deepEqual(result.violations, []);
  assert.ok(result.filesScanned > 0);
});
