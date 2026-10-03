import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
  MediaServerIdentityCapability,
  MediaServerLibrary,
} from "../../../types/media-server.js";
import type { PlexTransport } from "./client.js";
import { createPlexIdentityCapability } from "./identity.js";
import type { PlexRequestInput } from "./types.js";

class FakePlexTransport implements PlexTransport {
  readonly requests: PlexRequestInput[] = [];
  readonly #responses: unknown[];

  constructor(responses: readonly unknown[]) {
    this.#responses = [...responses];
  }

  async request<T>(input: PlexRequestInput): Promise<T> {
    this.requests.push(input);
    if (this.#responses.length === 0) {
      throw new Error(`No fake response for ${input.operation}`);
    }
    return this.#responses.shift() as T;
  }
}

function artist(
  id: string,
  title: string,
  guids?: readonly string[],
): Readonly<Record<string, unknown>> {
  return {
    ratingKey: id,
    title,
    ...(guids === undefined ? {} : { Guid: guids.map((guid) => ({ id: guid })) }),
  };
}

function response(
  metadata: readonly unknown[],
  options: { readonly offset?: number; readonly total?: number } = {},
): unknown {
  return {
    MediaContainer: {
      size: metadata.length,
      offset: options.offset,
      totalSize: options.total,
      Metadata: metadata,
    },
  };
}

function createSubject(
  responses: readonly unknown[],
  options: {
    readonly library?: MediaServerLibrary;
    readonly machineId?: string;
    readonly pageSize?: number;
  } = {},
): {
  readonly capability: MediaServerIdentityCapability;
  readonly transport: FakePlexTransport;
  readonly findLibrary: ReturnType<
    typeof vi.fn<
      (name: string, options?: { readonly signal?: AbortSignal }) => Promise<MediaServerLibrary>
    >
  >;
  readonly getMachineIdentifier: ReturnType<
    typeof vi.fn<(options?: { readonly signal?: AbortSignal }) => Promise<string>>
  >;
} {
  const transport = new FakePlexTransport(responses);
  const findLibrary = vi
    .fn<
      (name: string, options?: { readonly signal?: AbortSignal }) => Promise<MediaServerLibrary>
    >()
    .mockResolvedValue(
      options.library ?? Object.freeze({ id: "music/1", title: "Music", kind: "artist" }),
    );
  const getMachineIdentifier = vi
    .fn<(options?: { readonly signal?: AbortSignal }) => Promise<string>>()
    .mockResolvedValue(options.machineId ?? "machine-1");
  const capability = createPlexIdentityCapability({
    transport,
    findLibrary,
    getMachineIdentifier,
    pageSize: options.pageSize,
  });
  return { capability, transport, findLibrary, getMachineIdentifier };
}

describe("private Plex artist identity acquisition", () => {
  it("preserves all bounded MusicBrainz evidence and ignores unknown providers", async () => {
    const valid = "12345678-1234-1234-1234-123456789abc";
    const other = "abcdefab-cdef-cdef-cdef-abcdefabcdef";
    const { capability } = createSubject([
      response([
        artist("zero", "Zero"),
        artist("one", "One", [`mbid://${valid}`, "imdb://ignored"]),
        artist("duplicate", "Duplicate", [`mbid://${valid}`, `mbid://${valid}`]),
        artist("conflict", "Conflict", [`mbid://${valid}`, `mbid://${other}`]),
        artist("malformed", "Malformed", ["mbid://not-a-uuid"]),
        artist("unknown", "Unknown", ["lastfm://artist/name"]),
      ]),
    ]);

    const page = await capability.listArtists({ library: "Music" });

    expect(
      page.items.map(({ id, externalIds }) => [id, externalIds.map(({ value }) => value)]),
    ).toEqual([
      ["zero", []],
      ["one", [valid]],
      ["duplicate", [valid, valid]],
      ["conflict", [valid, other]],
      ["malformed", ["not-a-uuid"]],
      ["unknown", []],
    ]);
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.items)).toBe(true);
    expect(Object.isFrozen(page.items[1])).toBe(true);
    expect(Object.isFrozen(page.items[1]?.externalIds)).toBe(true);
    expect(Object.isFrozen(page.items[1]?.externalIds[0])).toBe(true);
    expectTypeOf(capability).toEqualTypeOf<MediaServerIdentityCapability>();
  });

  it("uses the stable library ID and exact structured pagination request", async () => {
    const controller = new AbortController();
    const { capability, transport, findLibrary } = createSubject(
      [response([artist("a", "A"), artist("b", "B")], { offset: 7, total: 12 })],
      {
        library: Object.freeze({ id: "music/main", title: "Renamed Music", kind: "artist" }),
        pageSize: 25,
      },
    );

    const page = await capability.listArtists({
      library: "Configured Music",
      offset: 5,
      limit: 2,
      signal: controller.signal,
    });

    expect(findLibrary).toHaveBeenCalledWith("Configured Music", {
      signal: controller.signal,
    });
    expect(transport.requests).toEqual([
      {
        path: "/library/sections/music%2Fmain/all",
        operation: "list Plex artist identities",
        options: {
          method: "GET",
          signal: controller.signal,
          query: {
            type: 8,
            includeGuids: 1,
            "X-Plex-Container-Start": 5,
            "X-Plex-Container-Size": 2,
          },
        },
      },
    ]);
    expect(page).toMatchObject({
      libraryId: "music/main",
      total: 12,
      offset: 7,
      returned: 2,
      hasMore: true,
    });
  });

  it("returns fresh deeply frozen pages", async () => {
    const wire = response([artist("artist-1", "Artist", ["mbid://not-canonical"])]);
    const { capability } = createSubject([wire, wire]);

    const first = await capability.listArtists({ library: "Music" });
    const second = await capability.listArtists({ library: "Music" });

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.items).not.toBe(first.items);
    expect(second.items[0]).not.toBe(first.items[0]);
    expect(second.items[0]?.externalIds).not.toBe(first.items[0]?.externalIds);
  });

  it("forwards cancellation and does not start already-aborted work", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const { capability, transport, findLibrary } = createSubject([]);

    await expect(
      capability.listArtists({ library: "Music", signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(findLibrary).not.toHaveBeenCalled();
    expect(transport.requests).toEqual([]);
  });

  it("reuses the private machine-ID callback and honors cancellation", async () => {
    const { capability, getMachineIdentifier } = createSubject([], { machineId: "machine-stable" });
    const controller = new AbortController();

    await expect(capability.getInstanceId({ signal: controller.signal })).resolves.toBe(
      "machine-stable",
    );
    await expect(capability.getInstanceId()).resolves.toBe("machine-stable");
    expect(getMachineIdentifier).toHaveBeenCalledTimes(2);
    expect(getMachineIdentifier).toHaveBeenNthCalledWith(1, { signal: controller.signal });
    expect(getMachineIdentifier).toHaveBeenNthCalledWith(2, { signal: undefined });

    const signal = AbortSignal.abort();
    await expect(capability.getInstanceId({ signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(getMachineIdentifier).toHaveBeenCalledTimes(2);
  });

  it("fails closed on malformed responses, oversized GUIDs, and stalled pages", async () => {
    const malformed = createSubject([{ MediaContainer: { Metadata: "invalid" } }]);
    await expect(malformed.capability.listArtists({ library: "Music" })).rejects.toMatchObject({
      code: "invalid-response",
      operation: "list Plex artist identities",
    });

    const oversized = createSubject([
      response([artist("artist-1", "Artist", [`mbid://${"x".repeat(1_025)}`])]),
    ]);
    await expect(oversized.capability.listArtists({ library: "Music" })).rejects.toMatchObject({
      code: "invalid-response",
    });

    const stalled = createSubject([response([], { offset: 0, total: 1 })]);
    await expect(stalled.capability.listArtists({ library: "Music" })).rejects.toThrow(
      "Pagination stalled",
    );

    const stale = createSubject([
      response([artist("artist-1", "Artist")], { offset: 4, total: 10 }),
    ]);
    await expect(
      stale.capability.listArtists({ library: "Music", offset: 5 }),
    ).rejects.toMatchObject({
      code: "invalid-response",
      operation: "list Plex artist identities",
    });
  });

  it("bounds page policy, requested ranges, library IDs, and machine IDs", async () => {
    expect(() => createSubject([], { pageSize: 1_001 })).toThrow("page size");

    const subject = createSubject([]);
    await expect(
      subject.capability.listArtists({ library: "Music", limit: 1_001 }),
    ).rejects.toThrow("limit");
    await expect(
      subject.capability.listArtists({
        library: "Music",
        offset: Number.MAX_SAFE_INTEGER,
        limit: 1,
      }),
    ).rejects.toThrow("safe integer bounds");

    const badLibrary = createSubject([], {
      library: Object.freeze({ id: "bad\u202eid", title: "Music", kind: "artist" }),
    });
    await expect(badLibrary.capability.listArtists({ library: "Music" })).rejects.toMatchObject({
      code: "invalid-response",
    });

    const badMachine = createSubject([], { machineId: "bad\u0000id" });
    await expect(badMachine.capability.getInstanceId()).rejects.toMatchObject({
      code: "invalid-response",
      operation: "fetch Plex server identity",
    });
  });
});
