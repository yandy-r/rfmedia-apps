# External Research: issue-160-native-backup

## Docker Data Model

Docker Compose exposes the fully merged, interpolated, normalized application model through
`docker compose config --format json`. That model is the authoritative source for service mount
selection: <https://docs.docker.com/reference/cli/docker/compose/config/>.

Compose services can mount bind paths, named volumes, anonymous volumes, and temporary filesystems.
Top-level named volumes may be project-scoped, externally managed, or assigned an explicit engine
name. Compose itself applies project and logical-volume labels, while `docker volume inspect`
returns the engine name, driver, options, scope, and mountpoint:

- <https://docs.docker.com/reference/compose-file/volumes/>
- <https://docs.docker.com/reference/cli/docker/volume/inspect/>

The backup workflow must preserve the distinction between the Compose source and the resolved
engine volume name. It must reject anonymous volumes because they have no stable declarative
identity suitable for a restore hint. It must also report, rather than archive, `tmpfs`, socket,
device, and other non-persistent mounts.

## Archive Transport

Docker documents volume backup by mounting the data into a short-lived helper container and
streaming a tar archive to a host destination. Read-only `--mount` syntax is preferred over the
ambiguous `-v` shorthand:
<https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes>.

For rfapps, the archive should stream over Docker CLI stdout to a local temporary file instead of
bind-mounting the local backup directory into the helper. Streaming keeps the final artifact under
the CLI process's ownership, works with Docker transports that return stdout, and allows an atomic
rename only after the helper exits successfully. Both bind sources and named volumes can be mounted
read-only at a fixed `/source` path. The helper command must receive arguments as an argv array,
never through a shell interpolation boundary.

The helper image and its digest/tag are part of verification metadata. This first release should
use one documented default image and let Docker surface an ordinary pull/run failure; it should not
invent a plugin system or database-specific hook abstraction.

## Integrity and Consistency

SHA-256 verifies artifact bytes after transport and during later offline verification. A checksum
does not prove application-level consistency. A file-level archive taken while a database is
writing may be crash-inconsistent even when its checksum is valid.

The manifest therefore needs separate facts:

- `integrity`: archive size and SHA-256;
- `consistency`: `filesystem-live` for this first release;
- `warnings`: database-like services and any source skipped or deduplicated;
- `restoreHints`: explicit operator commands and preconditions, not an automated restore claim.

Database-aware dumps, quiesce hooks, scheduling, retention, encryption, remote storage, and an
automated restore command are follow-up concerns. They should not enlarge issue #160's initial
file/volume contract.

## Security and Failure Ordering

Backup contents can include credentials, databases, and private application state. The destination
directory and manifest should be owner-only, archive files should not be overwritten, and
destination paths must be resolved before invoking Docker. Archive filenames must derive from
sanitized stable identifiers rather than raw paths.

The safe write order is:

1. resolve and validate the complete selected scope;
2. create one private staging directory beside the destination;
3. stream each archive to an exclusive temporary file;
4. hash the completed temporary file;
5. atomically publish the archive;
6. write and atomically publish the manifest last;
7. remove only staging paths owned by the current attempt after failure.

`backup verify` must be Docker-independent and mutation-free: validate schema/version, reject unsafe
manifest-relative paths, ensure every declared artifact exists as a regular file, compare exact byte
size and SHA-256, report every mismatch deterministically, and return non-zero if any artifact or
manifest invariant fails.

## Child-Issue Assessment

The requested command, archive engine, manifest, verification, completions, and documentation form
one cohesive vertical slice with a single acceptance boundary. No child issue is required for this
delivery. Database-aware hooks, scheduling/retention, encryption/remote targets, and automated
restore are independently releasable follow-ups and must remain out of scope unless separately
requested.
