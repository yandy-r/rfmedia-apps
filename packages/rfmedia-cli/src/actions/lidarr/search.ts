/**
 * Scheduled Lidarr search and lookup action.
 *
 * The action validates before resolving I/O dependencies, caches only the
 * complete deduplicated/ranked projection, and pages after live or terminal
 * stale resolution so every page shares one exact query cache row.
 */

import {
  resolveLidarrScheduler,
  resolveRequiredLidarrExecutionContext,
} from "../../lib/lidarr/index.js";
import { LidarrError } from "../../lib/lidarr/errors.js";
import {
  createLidarrSearchDiscriminator,
  normalizeLidarrSearchTerm,
  pageLidarrSearchCandidates,
  rankLidarrSearchCandidates,
  resolveLidarrSearchPageOptions,
  type LidarrSearchPageOptions,
} from "../../lib/lidarr/search.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import type { LidarrCacheStatus } from "../../types/lidarr-resilience.js";
import type {
  LidarrSearchActionResult,
  LidarrSearchCandidate,
  LidarrSearchCandidateInput,
  LidarrSearchMode,
  LidarrSearchQuery,
} from "../../types/lidarr.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";

const MAX_CACHED_CANDIDATES = 1_000;
const MAX_CACHED_LABEL_LENGTH = 2_048;
const MUSICBRAINZ_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UNSAFE_LABEL_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;

const TASKS = Object.freeze({
  search: Object.freeze({ id: "lidarr-search", operation: "lidarr search" }),
  artist: Object.freeze({
    id: "lidarr-lookup-artist",
    operation: "lidarr lookup artist",
  }),
  album: Object.freeze({
    id: "lidarr-lookup-album",
    operation: "lidarr lookup album",
  }),
}) satisfies Readonly<
  Record<LidarrSearchMode, { readonly id: string; readonly operation: string }>
>;

/** Reliability tier for all Lidarr search and lookup operations. */
export const TIER = "metadata-dependent" as const satisfies LidarrTier;

/** Inputs shared by combined search and typed lookup commands. */
export interface LidarrSearchActionOptions extends LidarrSearchPageOptions {
  readonly mode: LidarrSearchMode;
  readonly term: string;
  readonly allowStale?: boolean;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
  readonly signal?: AbortSignal;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isSafeLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CACHED_LABEL_LENGTH &&
    value.trim().length > 0 &&
    !UNSAFE_LABEL_PATTERN.test(value)
  );
}

function isOptionalSafeLabel(value: unknown): value is string | undefined {
  return value === undefined || isSafeLabel(value);
}

function isOptionalPositiveId(value: unknown): value is number | undefined {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

function projectCachedCandidate(
  value: unknown,
  mode: LidarrSearchMode,
  expectedRank: number,
): LidarrSearchCandidate | undefined {
  if (
    !isRecord(value) ||
    (value["kind"] !== "artist" && value["kind"] !== "album") ||
    (mode !== "search" && value["kind"] !== mode) ||
    value["rank"] !== expectedRank ||
    typeof value["foreignId"] !== "string" ||
    !MUSICBRAINZ_ID_PATTERN.test(value["foreignId"]) ||
    !isSafeLabel(value["name"]) ||
    !isOptionalPositiveId(value["lidarrId"])
  ) {
    return undefined;
  }

  const common = {
    kind: value["kind"],
    foreignId: value["foreignId"],
    name: value["name"],
    rank: expectedRank,
    ...(value["lidarrId"] === undefined ? {} : { lidarrId: value["lidarrId"] }),
  };

  if (value["kind"] === "artist") {
    if (
      !hasOnlyKeys(value, [
        "kind",
        "foreignId",
        "name",
        "rank",
        "lidarrId",
        "disambiguation",
        "artistType",
      ]) ||
      !isOptionalSafeLabel(value["disambiguation"]) ||
      !isOptionalSafeLabel(value["artistType"])
    ) {
      return undefined;
    }
    return Object.freeze({
      ...common,
      kind: "artist",
      ...(value["disambiguation"] === undefined ? {} : { disambiguation: value["disambiguation"] }),
      ...(value["artistType"] === undefined ? {} : { artistType: value["artistType"] }),
    });
  }

  if (
    !hasOnlyKeys(value, [
      "kind",
      "foreignId",
      "name",
      "rank",
      "lidarrId",
      "artistName",
      "artistForeignId",
      "albumType",
      "releaseDate",
    ]) ||
    !isOptionalSafeLabel(value["artistName"]) ||
    !isOptionalSafeLabel(value["albumType"]) ||
    !isOptionalSafeLabel(value["releaseDate"]) ||
    (value["artistForeignId"] !== undefined &&
      (typeof value["artistForeignId"] !== "string" ||
        !MUSICBRAINZ_ID_PATTERN.test(value["artistForeignId"])))
  ) {
    return undefined;
  }
  return Object.freeze({
    ...common,
    kind: "album",
    ...(value["artistName"] === undefined ? {} : { artistName: value["artistName"] }),
    ...(value["artistForeignId"] === undefined
      ? {}
      : { artistForeignId: value["artistForeignId"] }),
    ...(value["albumType"] === undefined ? {} : { albumType: value["albumType"] }),
    ...(value["releaseDate"] === undefined ? {} : { releaseDate: value["releaseDate"] }),
  });
}

/** Strictly revalidates and copies one complete ranked cache projection. */
function projectCachedCandidates(
  value: unknown,
  mode: LidarrSearchMode,
): readonly LidarrSearchCandidate[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CACHED_CANDIDATES) {
    return undefined;
  }
  const identities = new Set<string>();
  const projected: LidarrSearchCandidate[] = [];
  for (const [index, entry] of value.entries()) {
    const candidate = projectCachedCandidate(entry, mode, index + 1);
    if (candidate === undefined) {
      return undefined;
    }
    const identity = `${candidate.kind}\u0000${candidate.foreignId}`;
    if (identities.has(identity)) {
      return undefined;
    }
    identities.add(identity);
    projected.push(candidate);
  }
  return Object.freeze(projected);
}

function runSelectedSearch(
  client: LidarrClientApi,
  query: LidarrSearchQuery,
): Promise<readonly LidarrSearchCandidateInput[]> {
  switch (query.mode) {
    case "search":
      return client.search(query);
    case "artist":
      return client.lookupArtists(query);
    case "album":
      return client.lookupAlbums(query);
    default: {
      const exhaustive: never = query.mode;
      throw new Error(`Unhandled Lidarr search mode: ${String(exhaustive)}`);
    }
  }
}

/** Executes one combined or typed Lidarr search through the metadata lane. */
export async function executeLidarrSearch(
  options: LidarrSearchActionOptions,
): Promise<LidarrSearchActionResult> {
  const term = normalizeLidarrSearchTerm(options.term);
  const pageOptions = resolveLidarrSearchPageOptions(options);
  const discriminator = createLidarrSearchDiscriminator(options.mode, term);
  const task = TASKS[options.mode];

  let cacheStatus: LidarrCacheStatus | undefined;
  let fallbackReason: string | undefined;
  const context = resolveRequiredLidarrExecutionContext(
    {
      lidarrUrl: options.lidarrUrl,
      lidarrApiKey: options.lidarrApiKey,
    },
    {
      tier: TIER,
      allowStale: options.allowStale,
      onStaleServe: (status) => {
        cacheStatus = status;
      },
    },
  );

  const scheduled = await resolveLidarrScheduler().runSingle(
    TIER,
    {
      id: task.id,
      operation: task.operation,
      idempotent: true,
      run: async ({ signal }) => {
        const candidates = await runSelectedSearch(context.client, {
          mode: options.mode,
          term,
          signal,
        });
        const ranked = rankLidarrSearchCandidates(candidates);
        await context.writeLookupCache(discriminator, ranked);
        return ranked;
      },
    },
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      preflight: context.preflight,
      terminalFallback: async (error) => {
        const fallback = await context.tryServeStale({
          category: "lookup",
          discriminator,
          error,
          validate: (value) => projectCachedCandidates(value, options.mode),
        });
        if (fallback.served) {
          fallbackReason = error instanceof LidarrError ? error.code : "unknown";
        }
        return fallback;
      },
    },
  );

  const page = pageLidarrSearchCandidates(scheduled.value, pageOptions);
  const degraded = fallbackReason !== undefined;
  const provider = degraded
    ? Object.freeze({
        requested: "lidarr" as const,
        used: "sqlite-cache" as const,
        degraded: true as const,
        fallbackReason,
      })
    : Object.freeze({
        requested: "lidarr" as const,
        used: "lidarr" as const,
        degraded: false as const,
      });
  const execution = Object.freeze({ ...scheduled.execution });
  const servedCacheStatus =
    cacheStatus === undefined ? undefined : Object.freeze({ ...cacheStatus });
  return Object.freeze({
    query: Object.freeze({ mode: options.mode, term }),
    ...page,
    provider,
    ...(servedCacheStatus === undefined ? {} : { cacheStatus: servedCacheStatus }),
    execution,
  });
}
