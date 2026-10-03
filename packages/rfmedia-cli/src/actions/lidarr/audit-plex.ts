/**
 * Plex probe for `rfmedia lidarr audit` — the audit's sole media-server boundary.
 *
 * Every Plex-shaped concern of the feature lives here: the readiness gate, the
 * adapter construction, and the failure classification. Evaluators consume only
 * the {@link LidarrAuditPlexProbe} union, so widening the audit's Plex reach
 * (issues #207/#208) changes this module and nothing else.
 *
 * The probe is deliberately incapable of throwing. An audit whose media server
 * is down or misconfigured must still produce a report, with the outage
 * expressed as a finding rather than as a command failure.
 */

import { resolveRequiredMediaServerAdapter } from "../../lib/adapters/action-helpers.js";
import { plexAuthStoreExistsSync } from "../../lib/adapters/plex-adapter.js";
import { getLoadedPlexConfig } from "../../lib/loaded-config.js";
import { logDebug } from "../../lib/logger.js";
import { MediaServerError } from "../../types/media-server.js";
import type { LidarrAuditPlexProbe, LidarrAuditSlot } from "../../types/lidarr-audit.js";
import type { MediaServerErrorCode, MediaServerLibrary } from "../../types/media-server.js";

/**
 * `detail` for the slot returned when no usable Plex credentials exist.
 *
 * Enrollment (issue #251) is a credential source the audit never sees through
 * config, so the text names it explicitly: an install that dropped `plex.token`
 * after `rfmedia plex auth login` is fully configured, and telling that operator
 * to "set plex.token" would send them back to the credential they just retired.
 */
const PLEX_NOT_CONFIGURED_DETAIL =
  "Plex is not configured; set plex.url plus either plex.token or an enrolled credential " +
  "(run rfmedia plex auth login), or pass --plex-url and --plex-token";

/** CLI Plex connection overrides accepted by the audit probe. */
export interface LidarrAuditPlexOverrides {
  /** `--plex-url` override for the configured server URL. */
  readonly plexUrl?: string;
  /** `--plex-token` override for the configured API token. */
  readonly plexToken?: string;
}

/** Extracts a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Narrows a configuration or override value to one that carries content. */
function isPresent(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/**
 * Whether a library with the given title exists, matched the way the adapter's
 * own `library.byName()` matches: case-insensitively on the title.
 */
function hasLibraryNamed(libraries: readonly MediaServerLibrary[], name: string): boolean {
  const normalized = name.toLowerCase();
  return libraries.some(({ title }) => title.toLowerCase() === normalized);
}

/**
 * Detail for a configured library name that matched nothing. Mirrors the
 * adapter's not-found text so `evidence.available` keeps carrying the
 * `Available: <titles>` list the operator acts on.
 */
function unresolvedLibraryDetail(libraries: readonly MediaServerLibrary[], name: string): string {
  return `Library "${name}" not found. Available: ${libraries.map(({ title }) => title).join(", ")}`;
}

/**
 * Probes the media server for the audit. NEVER throws.
 *
 * Returns `{ status: "unavailable", reason: "plex-not-configured" }` WITHOUT
 * constructing an adapter when the URL is absent, or when no credential source
 * exists at all. None of the existing factories is a readiness check:
 * `requireMediaServerAdapter` throws on missing credentials,
 * `createOptionalMediaServerAdapter` is gated on the unrelated scan flag
 * (`plexScan ?? plex.scanAfterCopy ?? false`, default `false`), and
 * `getConfiguredMediaServerType` ORs URL and token. The gate below therefore
 * reads the same values the adapter itself reads, in the same order.
 *
 * A credential source is a static token (`--plex-token` or `plex.token`) OR an
 * enrollment store on disk (issue #251). Enrollment is invisible to the config,
 * so a token-only gate reports `plex-not-configured` for a fully migrated,
 * perfectly working server. The store probe is deliberately coarse — it asks
 * only "does a store exist", never "is it valid for this origin". Answering the
 * narrower question is the resolver's job, and its refusals
 * (`not-enrolled`, `ambiguous-credential`, an unauthorized origin) surface
 * through the `catch` below as `reachable: false`, which is a finding the
 * operator can act on rather than a silent skip.
 *
 * The readiness gate is the ONLY consumer of the config-resolved pair. The
 * factory receives the RAW overrides, exactly as every other Plex call site
 * passes them, so its cross-origin guard stays live: a `--plex-url` that changes
 * origin without an accompanying `--plex-token` is refused instead of shipping
 * the configured token to the new host. Resolving here and handing the factory
 * the resolved pair would make that guard structurally unreachable, because it
 * keys on `overrides.plexToken === undefined`.
 *
 * Adapter construction is inside the same `try` as the round-trips it enables:
 * `resolveRequiredMediaServerAdapter` throws a plain `Error` on an unusable URL
 * or a refused cross-origin override, which must be reported as an unreachable
 * probe rather than escaping and failing the whole audit. Anything that is not a
 * `MediaServerError` is classified as `"configuration"`.
 *
 * When `plex.libraryName` is configured, it is resolved against the library list
 * already in hand rather than through `adapter.library.byName()`. That call is
 * not a filter over the listed libraries — it re-issues the section request, and
 * the response cache is off by default — so a transport failure on that second
 * request would be misreported as an unresolved library name. The
 * `Available: <titles>` detail the operator needs is reproduced here verbatim.
 *
 * @param overrides - CLI Plex connection overrides, forwarded raw to the factory.
 * @returns The probe slot; `MediaServerError` is converted, never rethrown.
 */
export async function probeLidarrAuditPlex(
  overrides: LidarrAuditPlexOverrides,
): Promise<LidarrAuditSlot<LidarrAuditPlexProbe>> {
  const config = getLoadedPlexConfig();
  const url = overrides.plexUrl ?? config.url;
  const token = overrides.plexToken ?? config.token;

  // Short-circuits, so the store is stat'd only when no static token is present.
  const hasCredentialSource =
    isPresent(token) || plexAuthStoreExistsSync({ storePath: config.auth?.storePath });

  if (!isPresent(url) || !hasCredentialSource) {
    logDebug("lidarr audit: Plex credentials absent, skipping the media-server probe");
    return {
      status: "unavailable",
      reason: "plex-not-configured",
      detail: PLEX_NOT_CONFIGURED_DETAIL,
    };
  }

  try {
    const adapter = resolveRequiredMediaServerAdapter({
      plexUrl: overrides.plexUrl,
      plexToken: overrides.plexToken,
    });
    logDebug("lidarr audit: listing Plex libraries");
    const libraries: readonly MediaServerLibrary[] = await adapter.library.list();

    const configuredLibraryName = config.libraryName;
    if (!isPresent(configuredLibraryName)) {
      return { status: "available", data: { reachable: true, libraries } };
    }

    logDebug(`lidarr audit: resolving configured Plex library "${configuredLibraryName}"`);
    if (hasLibraryNamed(libraries, configuredLibraryName)) {
      return {
        status: "available",
        data: {
          reachable: true,
          libraries,
          configuredLibraryName,
          configuredLibraryResolved: true,
        },
      };
    }

    return {
      status: "available",
      data: {
        reachable: true,
        libraries,
        configuredLibraryName,
        configuredLibraryResolved: false,
        resolutionDetail: unresolvedLibraryDetail(libraries, configuredLibraryName),
      },
    };
  } catch (error) {
    const code: MediaServerErrorCode =
      error instanceof MediaServerError ? error.code : "configuration";
    logDebug(`lidarr audit: Plex probe failed (${code})`);
    return { status: "available", data: { reachable: false, code, message: errorMessage(error) } };
  }
}
