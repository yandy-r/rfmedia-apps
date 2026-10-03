/**
 * The on-disk Plex credential-store document: its schema, its parser, and the
 * mutation algebra applied to it under the store lock (issue #251).
 *
 * Kept separate from `credential-store.ts` so that a schema change is a diff to
 * a module with **no filesystem, lock, clock or secret-custody code in it**. The
 * document type is the only place that knows the JSON layout.
 *
 * Two invariants are enforced here rather than documented:
 *
 * - A parsed document always carries a credential, an issue time and a lifetime.
 *   Enrollment writes `enroll`, `issue` and `authorize-origin` in one atomic
 *   write, so a credential-less document never reaches disk; anything else on
 *   disk is corrupt. This is what makes an `absent` credential state unreachable
 *   by construction.
 * - `version` is monotonic and is incremented by exactly one on every write, so
 *   it can serve as the content axis of the store's compare-and-swap.
 */

import { PlexAuthError } from "./errors.js";

/** On-disk document format. Bumped only by a migration, never by a write. */
export const PLEX_AUTH_STORE_SCHEMA = 1 as const;

/** One Plex Media Server origin the account credential may be sent to. */
export interface PlexAuthorizedOrigin {
  /** Canonical origin, exactly as produced by `normalizePlexOrigin`. */
  readonly origin: string;
  /** PMS `machineIdentifier` observed by the enrollment probe. Detects an origin swap. */
  readonly machineIdentifier: string;
  readonly authorizedAtEpochSeconds: number;
  readonly lastVerifiedAtEpochSeconds: number;
}

/**
 * One state change applied to the store under the exclusive lock.
 *
 * The refresh nonce appears in no variant: it is a function-local constant used
 * within a single signing operation and is never persisted.
 */
export type PlexStoreMutation =
  | {
      /** Starts a brand-new document: a fresh key pair invalidates everything else. */
      readonly kind: "enroll";
      readonly clientIdentifier: string;
      readonly deviceName: string;
      readonly kid: string;
      readonly privateKeyPkcs8Pem: string;
    }
  | {
      /** Records a newly issued credential and clears any cooperative backoff. */
      readonly kind: "issue";
      readonly credential: string;
      readonly issuedAtEpochSeconds: number;
      readonly lifetimeSeconds: number;
      readonly lifetimeAssumed: boolean;
      /** Clock skew observed on this response, persisted for `plex auth status`. */
      readonly observedSkewSeconds?: number;
    }
  | {
      readonly kind: "authorize-origin";
      readonly origin: string;
      readonly machineIdentifier: string;
    }
  | { readonly kind: "back-off"; readonly notBeforeEpochSeconds: number }
  | { readonly kind: "forget-origin"; readonly origin: string }
  | { readonly kind: "destroy" };

/** Mutations to apply plus the value handed back to the lock's caller. */
export interface PlexStoreMutationOutcome<T> {
  readonly mutations: readonly PlexStoreMutation[];
  readonly result: T;
}

/** Parsed store document. Carries both secrets; never leaves this package. */
export interface PlexAuthStoreDocument {
  readonly schema: typeof PLEX_AUTH_STORE_SCHEMA;
  readonly version: number;
  readonly clientIdentifier: string;
  readonly deviceName: string;
  readonly kid: string;
  readonly privateKeyPkcs8Pem: string;
  readonly credential: string;
  readonly issuedAtEpochSeconds: number;
  readonly lifetimeSeconds: number;
  readonly lifetimeAssumed: boolean;
  readonly refreshNotBeforeEpochSeconds: number;
  readonly lastObservedSkewSeconds: number | null;
  readonly authorizedOrigins: readonly PlexAuthorizedOrigin[];
}

interface MutableStore {
  clientIdentifier: string;
  deviceName: string;
  kid: string;
  privateKeyPkcs8Pem: string;
  credential: string | undefined;
  issuedAtEpochSeconds: number | undefined;
  lifetimeSeconds: number | undefined;
  lifetimeAssumed: boolean;
  refreshNotBeforeEpochSeconds: number;
  lastObservedSkewSeconds: number | null;
  authorizedOrigins: PlexAuthorizedOrigin[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isEpochNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readAuthorizedOrigins(value: unknown): readonly PlexAuthorizedOrigin[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const origins: PlexAuthorizedOrigin[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isNonEmptyString(entry["origin"]) ||
      !isNonEmptyString(entry["machineIdentifier"]) ||
      !isEpochNumber(entry["authorizedAtEpochSeconds"]) ||
      !isEpochNumber(entry["lastVerifiedAtEpochSeconds"])
    ) {
      return undefined;
    }
    origins.push(
      Object.freeze({
        origin: entry["origin"],
        machineIdentifier: entry["machineIdentifier"],
        authorizedAtEpochSeconds: entry["authorizedAtEpochSeconds"],
        lastVerifiedAtEpochSeconds: entry["lastVerifiedAtEpochSeconds"],
      }),
    );
  }
  return Object.freeze(origins);
}

/** Returns `undefined` for a value that is neither `null` nor a safe integer. */
function readSkewSeconds(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return undefined;
}

/**
 * Parses and fully validates a store document.
 *
 * Every field is checked; there is no partial acceptance and no repair. A
 * document this build cannot vouch for is a hard failure, because silently
 * treating it as "not enrolled" would trigger a re-enrollment that overwrites
 * key material the operator may still need.
 *
 * @param text - Raw file contents.
 * @param path - Store path, used only for the error's remediation.
 * @returns The frozen, validated document.
 * @throws {PlexAuthError} `PLEX_AUTH_STORE_CORRUPT` for any deviation.
 */
export function parsePlexAuthStoreDocument(text: string, path: string): PlexAuthStoreDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new PlexAuthError("PLEX_AUTH_STORE_CORRUPT", { path });
  }
  if (!isRecord(parsed)) throw new PlexAuthError("PLEX_AUTH_STORE_CORRUPT", { path });

  const skew = readSkewSeconds(parsed["lastObservedSkewSeconds"]);
  const origins = readAuthorizedOrigins(parsed["authorizedOrigins"]);
  if (
    parsed["schema"] !== PLEX_AUTH_STORE_SCHEMA ||
    !isEpochNumber(parsed["version"]) ||
    parsed["version"] < 1 ||
    !isNonEmptyString(parsed["clientIdentifier"]) ||
    !isNonEmptyString(parsed["deviceName"]) ||
    !isNonEmptyString(parsed["kid"]) ||
    !isNonEmptyString(parsed["privateKeyPkcs8Pem"]) ||
    !isNonEmptyString(parsed["credential"]) ||
    !isEpochNumber(parsed["issuedAtEpochSeconds"]) ||
    !isEpochNumber(parsed["lifetimeSeconds"]) ||
    typeof parsed["lifetimeAssumed"] !== "boolean" ||
    !isEpochNumber(parsed["refreshNotBeforeEpochSeconds"]) ||
    skew === undefined ||
    origins === undefined
  ) {
    throw new PlexAuthError("PLEX_AUTH_STORE_CORRUPT", { path });
  }

  return Object.freeze({
    schema: PLEX_AUTH_STORE_SCHEMA,
    version: parsed["version"],
    clientIdentifier: parsed["clientIdentifier"],
    deviceName: parsed["deviceName"],
    kid: parsed["kid"],
    privateKeyPkcs8Pem: parsed["privateKeyPkcs8Pem"],
    credential: parsed["credential"],
    issuedAtEpochSeconds: parsed["issuedAtEpochSeconds"],
    lifetimeSeconds: parsed["lifetimeSeconds"],
    lifetimeAssumed: parsed["lifetimeAssumed"],
    refreshNotBeforeEpochSeconds: parsed["refreshNotBeforeEpochSeconds"],
    lastObservedSkewSeconds: skew,
    authorizedOrigins: origins,
  });
}

/**
 * Serializes a store document for atomic publication.
 *
 * @param document - Document produced by {@link applyPlexStoreMutations}.
 * @returns The UTF-8 payload to write.
 */
export function serializePlexAuthStoreDocument(document: PlexAuthStoreDocument): string {
  return JSON.stringify(document);
}

/**
 * Reports whether a mutation batch destroys the store.
 *
 * @param mutations - Mutation batch returned by a lock mutator.
 * @returns `true` when the batch contains a `destroy` mutation.
 */
export function containsDestroyMutation(mutations: readonly PlexStoreMutation[]): boolean {
  return mutations.some((mutation) => mutation.kind === "destroy");
}

function toDraft(document: PlexAuthStoreDocument): MutableStore {
  return {
    clientIdentifier: document.clientIdentifier,
    deviceName: document.deviceName,
    kid: document.kid,
    privateKeyPkcs8Pem: document.privateKeyPkcs8Pem,
    credential: document.credential,
    issuedAtEpochSeconds: document.issuedAtEpochSeconds,
    lifetimeSeconds: document.lifetimeSeconds,
    lifetimeAssumed: document.lifetimeAssumed,
    refreshNotBeforeEpochSeconds: document.refreshNotBeforeEpochSeconds,
    lastObservedSkewSeconds: document.lastObservedSkewSeconds,
    authorizedOrigins: [...document.authorizedOrigins],
  };
}

function requireDraft(draft: MutableStore | undefined): MutableStore {
  if (draft === undefined) {
    throw new TypeError("Plex credential store mutation requires an existing enrollment");
  }
  return draft;
}

function upsertOrigin(
  draft: MutableStore,
  origin: string,
  machineIdentifier: string,
  atEpochSeconds: number,
): void {
  const existing = draft.authorizedOrigins.find((entry) => entry.origin === origin);
  draft.authorizedOrigins = [
    ...draft.authorizedOrigins.filter((entry) => entry.origin !== origin),
    Object.freeze({
      origin,
      machineIdentifier,
      authorizedAtEpochSeconds: existing?.authorizedAtEpochSeconds ?? atEpochSeconds,
      lastVerifiedAtEpochSeconds: atEpochSeconds,
    }),
  ];
}

/**
 * Folds a mutation batch onto the state re-read under the lock.
 *
 * A batch that would leave the document without a credential, or that mutates a
 * store which does not exist yet without first enrolling, is a caller bug and
 * fails fast with a `TypeError` rather than writing a document that later reads
 * as corrupt.
 *
 * @param current - State re-read under the lock, or `undefined` for a first write.
 * @param mutations - Batch to apply, in order.
 * @param nowEpochSeconds - Clock used for origin authorization timestamps.
 * @returns The next document, with `version` incremented by one.
 * @throws TypeError when the batch cannot produce a complete document, or when
 *   it contains `destroy` (which unlinks the file and is handled by the caller).
 */
export function applyPlexStoreMutations(
  current: PlexAuthStoreDocument | undefined,
  mutations: readonly PlexStoreMutation[],
  nowEpochSeconds: number,
): PlexAuthStoreDocument {
  let draft: MutableStore | undefined = current === undefined ? undefined : toDraft(current);

  for (const mutation of mutations) {
    switch (mutation.kind) {
      case "enroll":
        draft = {
          clientIdentifier: mutation.clientIdentifier,
          deviceName: mutation.deviceName,
          kid: mutation.kid,
          privateKeyPkcs8Pem: mutation.privateKeyPkcs8Pem,
          credential: undefined,
          issuedAtEpochSeconds: undefined,
          lifetimeSeconds: undefined,
          lifetimeAssumed: false,
          refreshNotBeforeEpochSeconds: 0,
          lastObservedSkewSeconds: null,
          authorizedOrigins: [],
        };
        break;
      case "issue": {
        const target = requireDraft(draft);
        target.credential = mutation.credential;
        target.issuedAtEpochSeconds = mutation.issuedAtEpochSeconds;
        target.lifetimeSeconds = mutation.lifetimeSeconds;
        target.lifetimeAssumed = mutation.lifetimeAssumed;
        // A successful issue proves the cooperative rate-limit window has passed.
        target.refreshNotBeforeEpochSeconds = 0;
        if (mutation.observedSkewSeconds !== undefined) {
          target.lastObservedSkewSeconds = mutation.observedSkewSeconds;
        }
        break;
      }
      case "authorize-origin":
        upsertOrigin(
          requireDraft(draft),
          mutation.origin,
          mutation.machineIdentifier,
          nowEpochSeconds,
        );
        break;
      case "back-off": {
        const target = requireDraft(draft);
        target.refreshNotBeforeEpochSeconds = Math.max(
          target.refreshNotBeforeEpochSeconds,
          mutation.notBeforeEpochSeconds,
        );
        break;
      }
      case "forget-origin": {
        const target = requireDraft(draft);
        target.authorizedOrigins = target.authorizedOrigins.filter(
          (entry) => entry.origin !== mutation.origin,
        );
        break;
      }
      case "destroy":
        throw new TypeError("Plex credential store destroy must be the only mutation");
      default: {
        const exhaustive: never = mutation;
        throw new TypeError(`Unknown Plex credential store mutation: ${String(exhaustive)}`);
      }
    }
  }

  const settled = requireDraft(draft);
  if (
    settled.credential === undefined ||
    settled.issuedAtEpochSeconds === undefined ||
    settled.lifetimeSeconds === undefined
  ) {
    throw new TypeError("Plex credential store mutations must produce an issued credential");
  }

  return Object.freeze({
    schema: PLEX_AUTH_STORE_SCHEMA,
    version: (current?.version ?? 0) + 1,
    clientIdentifier: settled.clientIdentifier,
    deviceName: settled.deviceName,
    kid: settled.kid,
    privateKeyPkcs8Pem: settled.privateKeyPkcs8Pem,
    credential: settled.credential,
    issuedAtEpochSeconds: settled.issuedAtEpochSeconds,
    lifetimeSeconds: settled.lifetimeSeconds,
    lifetimeAssumed: settled.lifetimeAssumed,
    refreshNotBeforeEpochSeconds: settled.refreshNotBeforeEpochSeconds,
    lastObservedSkewSeconds: settled.lastObservedSkewSeconds,
    authorizedOrigins: Object.freeze([...settled.authorizedOrigins]),
  });
}
