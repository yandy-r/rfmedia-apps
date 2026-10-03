/**
 * Declarative tag-inference rule catalog (design §8.2–§8.4).
 *
 * Structurally modelled on `lib/hardening-rules.ts` so rule ids are completable the
 * same way: a frozen array of rules plus a derived `*_RULE_IDS` array.
 *
 * Every rule is a pure, synchronous function of **configuration and compose only**.
 * No daemon calls, no filesystem, no runtime state (`docker stats` and health belong
 * to issue #62), no logging, no exit codes.
 *
 * `evaluate` returns **un-normalized** proposal strings. Normalization to `TagPath`
 * happens once, in the engine (`tag-inference.ts`), so this module deliberately owns
 * no normalizer and imports none.
 */

import { TAG_MAX_SEGMENT_LENGTH } from "../../types/tags.js";
import type { RfappsConfig } from "../../types/config.js";
import type { TagInferenceConfidence, TagInferenceRuleId } from "../../types/tags.js";

/**
 * Local structural view of one compose service (design §8.3).
 *
 * `ComposeServiceConfig` in `lib/docker.ts` has no `labels` field and MUST NOT gain
 * one — it is consumed by plan-generation fingerprinting, so widening it would
 * invalidate every saved plan. The engine casts the resolved compose config to this
 * view once, at its own call boundary (`as unknown as TagInferenceComposeConfig`),
 * mirroring the `HardenComposeConfig` precedent at `actions/harden.ts:244`.
 */
export interface TagInferenceComposeService {
  readonly image?: string;
  readonly labels?: Readonly<Record<string, string>> | readonly string[];
}

/** Local structural view of the resolved compose document (design §8.3). */
export interface TagInferenceComposeConfig {
  readonly services: Readonly<Record<string, TagInferenceComposeService>>;
}

/** Everything a rule may look at. `composeService` is absent in degraded mode (§8.4). */
export interface TagInferenceContext {
  /** Compose service name under evaluation. */
  readonly service: string;
  /** Fully merged rfapps configuration. */
  readonly config: RfappsConfig;
  /** Resolved compose service, or `undefined` when the Docker CLI was unavailable. */
  readonly composeService?: TagInferenceComposeService;
}

/** One inference rule. Declaration order is the catalog print order. */
export interface TagInferenceRule {
  readonly id: TagInferenceRuleId;
  readonly description: string;
  readonly confidence: TagInferenceConfidence;
  /** When true the rule is skipped in degraded mode because it reads compose. */
  readonly needsDocker: boolean;
  /** Pure and synchronous. Returns un-normalized tag proposals, possibly empty. */
  evaluate(ctx: TagInferenceContext): readonly string[];
}

/**
 * Profile slug -> proposed tag, anchoring `profiles.mapping` onto the §5.1 taxonomy.
 *
 * `all` is deliberately absent: it is the "everything" sentinel (`defaultProfile: all`),
 * not a facet.
 */
const PROFILE_TAGS: Readonly<Record<string, string>> = {
  core: "platform/core",
  infrastructure: "platform/infrastructure",
  downloads: "media/downloads",
  "arr-stack": "media/automation",
  media: "media/streaming",
  photos: "photos",
};

/**
 * Group slug -> proposed tag. The second segment is the group slug's facet, which is
 * a semantic rename for some groups (`auth-stack` -> `platform/identity`).
 */
const GROUP_TAGS: Readonly<Record<string, string>> = {
  "infra-stack": "platform/infrastructure",
  "auth-stack": "platform/identity",
  "vpn-stack": "network/vpn",
  "media-stack": "media/streaming",
  "arr-stack": "media/automation",
  "download-stack": "media/downloads",
  "photo-stack": "photos/library",
};

/** Root segment used when a profile/group slug is not in the tables above. */
const GENERIC_FACET_ROOT = "platform";

/** The "everything" profile sentinel, which carries no taxonomic meaning. */
const ALL_PROFILE = "all";

const ARR_SERVICE_NAME = /^(son|rad|lid|read|baz|prowl)arr$/;
const ARR_IMAGE = /linuxserver\/.*arr/;

const DATABASE_IMAGES: ReadonlySet<string> = new Set(["postgres", "mariadb", "mysql", "mongo"]);
const CACHE_IMAGES: ReadonlySet<string> = new Set(["redis", "valkey", "memcached"]);
const INGRESS_IMAGES: ReadonlySet<string> = new Set(["traefik", "nginx", "caddy", "haproxy"]);

const TRAEFIK_ENABLE_LABEL = "traefik.enable";
const DOCKTAIL_LABEL_PREFIX = "docktail.service.";

const ARR_TAG = "media/automation/arr";
const DATABASE_TAG = "data/database";
const CACHE_TAG = "data/cache";
const INGRESS_TAG = "network/ingress";
const TAILNET_TAG = "network/tailnet";

const NO_LABELS: ReadonlyMap<string, string> = new Map<string, string>();

/**
 * Coerce one compose label value to a string.
 *
 * Non-string values are real in this repo's compose.yml (`traefik.enable: true`,
 * `docktail.service.port: 32400`), so scalars are coerced explicitly. A `key:` with
 * no value is a present-but-empty label. Objects and arrays are not label scalars and
 * are dropped rather than `String()`-ed into nonsense.
 */
function coerceLabelValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  return undefined;
}

function isLabelList(
  labels: Readonly<Record<string, string>> | readonly string[],
): labels is readonly string[] {
  return Array.isArray(labels);
}

/** Map form: `labels: { "traefik.enable": true }`. */
function readMapLabels(labels: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const [key, rawValue] of Object.entries<unknown>(labels)) {
    const value = coerceLabelValue(rawValue);
    const trimmedKey = key.trim();
    if (value === undefined || trimmedKey === "") {
      continue;
    }
    result.set(trimmedKey, value);
  }
  return result;
}

/** List form: `labels: ["traefik.enable=true"]`. Legal Compose, unused in this repo. */
function readListLabels(labels: readonly string[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const rawEntry of labels) {
    const entry: unknown = rawEntry;
    // A non-string list entry cannot carry a `key=value` pair, so it is skipped
    // rather than blindly String()-split.
    if (typeof entry !== "string") {
      continue;
    }
    const separator = entry.indexOf("=");
    const key = (separator === -1 ? entry : entry.slice(0, separator)).trim();
    if (key === "") {
      continue;
    }
    result.set(key, separator === -1 ? "" : entry.slice(separator + 1));
  }
  return result;
}

/**
 * Normalize either legal compose label shape into a `key -> value` map.
 *
 * Exported because it encodes the §8.3 safety contract and is the one place a
 * label-shape bug could hide.
 */
export function readComposeLabels(
  composeService: TagInferenceComposeService | undefined,
): ReadonlyMap<string, string> {
  const labels = composeService?.labels;
  if (labels === undefined) {
    return NO_LABELS;
  }
  return isLabelList(labels) ? readListLabels(labels) : readMapLabels(labels);
}

function hasLabel(ctx: TagInferenceContext, key: string): boolean {
  return readComposeLabels(ctx.composeService).has(key);
}

function hasLabelWithPrefix(ctx: TagInferenceContext, prefix: string): boolean {
  for (const key of readComposeLabels(ctx.composeService).keys()) {
    if (key.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/** `lscr.io/linuxserver/sonarr:develop@sha256:…` -> `lscr.io/linuxserver/sonarr`. */
function imageRepository(image: string): string {
  const [withoutDigest = ""] = image.trim().toLowerCase().split("@");
  const lastSlash = withoutDigest.lastIndexOf("/");
  // Strip the tag from the final path segment only, so `localhost:5000/redis` keeps
  // its registry port.
  const finalSegment = withoutDigest.slice(lastSlash + 1);
  const colon = finalSegment.indexOf(":");
  const untagged = colon === -1 ? finalSegment : finalSegment.slice(0, colon);
  return `${withoutDigest.slice(0, lastSlash + 1)}${untagged}`;
}

/** `docker.io/library/postgres:16-alpine` -> `postgres`. */
function imageBasename(ctx: TagInferenceContext): string | undefined {
  const image = ctx.composeService?.image;
  if (image === undefined || image.trim() === "") {
    return undefined;
  }
  const repository = imageRepository(image);
  const basename = repository.slice(repository.lastIndexOf("/") + 1);
  return basename === "" ? undefined : basename;
}

/**
 * Reduce an arbitrary slug to one legal tag segment
 * (`[a-z0-9]([a-z0-9._-]*[a-z0-9])?`, design §3.1) or `undefined` when nothing
 * survives. Keeps derived proposals normalizable so the engine never throws on them.
 */
function toTagSegment(raw: string): string | undefined {
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const truncated = sanitized.slice(0, TAG_MAX_SEGMENT_LENGTH);
  const trimmed = truncated.replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Fallback for a slug absent from `PROFILE_TAGS` / `GROUP_TAGS`: drop a trailing
 * `-stack` suffix and hang the remainder off the generic organizational root, so the
 * rule stays useful on deployments whose slugs this catalog has never seen.
 */
function deriveFacetTag(slug: string): string | undefined {
  const segment = toTagSegment(slug.replace(/[-_]?stack$/, ""));
  return segment === undefined ? undefined : `${GENERIC_FACET_ROOT}/${segment}`;
}

function profileTag(profile: string): string | undefined {
  const slug = profile.trim().toLowerCase();
  if (slug === "" || slug === ALL_PROFILE) {
    return undefined;
  }
  return PROFILE_TAGS[slug] ?? deriveFacetTag(slug);
}

function groupTag(group: string): string | undefined {
  const slug = group.trim().toLowerCase();
  if (slug === "") {
    return undefined;
  }
  return GROUP_TAGS[slug] ?? deriveFacetTag(slug);
}

/**
 * The tag inference catalog.
 *
 * Declaration order is load-bearing: it is the `--list-rules` print order and the
 * order proposals are attributed in.
 */
export const TAG_INFERENCE_RULES: readonly TagInferenceRule[] = [
  {
    id: "tag-infer-profile",
    description: "Maps the service's compose profile onto the tag taxonomy.",
    confidence: "medium",
    needsDocker: false,
    evaluate: (ctx) => {
      const profile = ctx.config.profiles.mapping[ctx.service];
      if (profile === undefined) {
        return [];
      }
      const tag = profileTag(profile);
      return tag === undefined ? [] : [tag];
    },
  },
  {
    id: "tag-infer-group",
    description: "Maps every configured group the service belongs to onto the tag taxonomy.",
    confidence: "medium",
    needsDocker: false,
    evaluate: (ctx) => {
      const proposals: string[] = [];
      for (const [group, members] of Object.entries(ctx.config.groups)) {
        if (!members.includes(ctx.service)) {
          continue;
        }
        const tag = groupTag(group);
        if (tag !== undefined && !proposals.includes(tag)) {
          proposals.push(tag);
        }
      }
      return proposals;
    },
  },
  {
    id: "tag-infer-arr",
    // needsDocker is false so the service-name variant still fires in degraded mode;
    // the image variant simply finds no compose service to look at.
    description: "Detects *arr automation apps by service name, or by a linuxserver image.",
    confidence: "high",
    needsDocker: false,
    evaluate: (ctx) => {
      if (ARR_SERVICE_NAME.test(ctx.service.trim().toLowerCase())) {
        return [ARR_TAG];
      }
      const image = ctx.composeService?.image;
      if (image !== undefined && ARR_IMAGE.test(imageRepository(image))) {
        return [ARR_TAG];
      }
      return [];
    },
  },
  {
    id: "tag-infer-database",
    description: "Detects relational and document datastores by image basename.",
    confidence: "high",
    needsDocker: true,
    evaluate: (ctx) => {
      const basename = imageBasename(ctx);
      return basename !== undefined && DATABASE_IMAGES.has(basename) ? [DATABASE_TAG] : [];
    },
  },
  {
    id: "tag-infer-cache",
    description: "Detects in-memory caches and key-value stores by image basename.",
    confidence: "high",
    needsDocker: true,
    evaluate: (ctx) => {
      const basename = imageBasename(ctx);
      return basename !== undefined && CACHE_IMAGES.has(basename) ? [CACHE_TAG] : [];
    },
  },
  {
    id: "tag-infer-ingress",
    description: "Detects reverse proxies by a traefik.enable label or by image basename.",
    confidence: "high",
    needsDocker: true,
    evaluate: (ctx) => {
      if (hasLabel(ctx, TRAEFIK_ENABLE_LABEL)) {
        return [INGRESS_TAG];
      }
      const basename = imageBasename(ctx);
      return basename !== undefined && INGRESS_IMAGES.has(basename) ? [INGRESS_TAG] : [];
    },
  },
  {
    id: "tag-infer-tailnet",
    description: "Detects tailnet-advertised services by their docktail.service.* labels.",
    confidence: "high",
    needsDocker: true,
    evaluate: (ctx) => (hasLabelWithPrefix(ctx, DOCKTAIL_LABEL_PREFIX) ? [TAILNET_TAG] : []),
  },
];

/** Rule ids in declaration order. Consumed by `--rule` parsing and shell completion. */
export const TAG_INFERENCE_RULE_IDS: readonly TagInferenceRuleId[] = TAG_INFERENCE_RULES.map(
  (rule) => rule.id,
);
