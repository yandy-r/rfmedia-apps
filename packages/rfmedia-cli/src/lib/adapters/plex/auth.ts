import { getPlexConnectionToken, type PlexConnectionSettings } from "./types.js";

/** Authentication recovery decisions understood by the private Plex client. */
export type PlexAuthFailureAction = "retry" | "fail";

/**
 * Cooperative-cancellation context for the credential seam.
 *
 * A rotating provider may perform network IO and wait on an inter-process lock
 * while producing a credential, so callers need a way to abandon that work.
 */
export interface PlexCredentialRequestOptions {
  readonly signal?: AbortSignal;
}

/** Private asynchronous credential seam for authenticated Plex requests. */
export interface PlexTokenProvider {
  /**
   * Returns the current opaque credential, refreshing proactively if required.
   *
   * @param options - Optional cooperative-cancellation context.
   * @returns The credential without decoding or normalization.
   */
  getToken(options?: PlexCredentialRequestOptions): Promise<string>;

  /**
   * Decides whether a failed authenticated request may be retried.
   *
   * @param status - HTTP status returned by Plex.
   * @param options - Optional cooperative-cancellation context.
   * @returns Whether the private client may retry once or must fail.
   */
  handleAuthFailure?(
    status: number,
    options?: PlexCredentialRequestOptions,
  ): Promise<PlexAuthFailureAction>;
}

/**
 * Static provider for configured legacy tokens and already-issued JWTs.
 *
 * The credential remains in the connection module's private binding. This
 * provider neither interprets nor persists it and never authorizes recovery.
 */
export class StaticPlexTokenProvider implements PlexTokenProvider {
  readonly #connection: PlexConnectionSettings;

  /**
   * Creates a provider for one origin-bound private connection.
   *
   * @param connection - Immutable connection whose credential is held off-object.
   */
  constructor(connection: PlexConnectionSettings) {
    this.#connection = connection;
    Object.freeze(this);
  }

  /**
   * Reads the origin-bound opaque credential.
   *
   * Validation lives in the credential cell and runs on every read, so this
   * provider deliberately performs no second check of its own.
   *
   * @param options - Ignored; this provider never performs cancellable work.
   * @returns The configured credential byte-for-byte unchanged.
   * @throws TypeError when the credential is empty or contains a control character.
   */
  async getToken(options?: PlexCredentialRequestOptions): Promise<string> {
    void options;
    return getPlexConnectionToken(this.#connection, this.#connection.origin);
  }

  /**
   * Declines authentication recovery for every Plex status.
   *
   * Rotation and a bounded refresh decision belong to `jwt-provider.ts`, which
   * serves enrolled installs; a configured static credential has no recovery.
   *
   * @param status - HTTP status returned by Plex.
   * @param options - Ignored; this provider never performs cancellable work.
   * @returns Always `"fail"` for the static provider.
   */
  async handleAuthFailure(status: number, options?: PlexCredentialRequestOptions): Promise<"fail"> {
    void status;
    void options;
    return "fail";
  }
}
