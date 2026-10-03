# rfapps Native Backup

`rfapps backup` creates a cold filesystem backup of persistent directory data declared by Docker
Compose. It archives eligible bind-mounted directories and named volumes, records exactly what was
captured in a private manifest-last bundle, and restores the exact containers that were running
before the backup. `rfapps backup verify` checks that bundle later without Docker or rfapps
configuration.

This is a filesystem-level safety layer. It does not replace PostgreSQL, Redis, SQLite, or other
application-native backup procedures when transaction-level consistency is required.

## Command Syntax

Create a backup:

```text
rfapps backup [selection options] --destination <directory>
```

Verify a published bundle:

```text
rfapps backup verify <manifest>
```

Creation accepts these selection and configuration options:

| Option                  | Meaning                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `-s, --service <name>`  | Select one service                                          |
| `--services <names>`    | Select comma-separated services                             |
| `-g, --group <name>`    | Select a configured service group                           |
| `--all`                 | Explicitly select every service in the resolved Compose app |
| `--no-sidecars`         | Disable configured sidecar expansion                        |
| `--destination <dir>`   | Existing directory that will contain the generated bundle   |
| `-f, --compose <path>`  | Use another Compose file                                    |
| `-e, --env-file <path>` | Use another environment file                                |
| `-p, --profile <name>`  | Use another Compose profile                                 |

`--destination` is always required. `--all` cannot be combined with `--service`, `--services`, or
`--group`.

In an interactive terminal with text or table output, omitting a target opens the existing service
selector. An explicit target or `--all` is required in a non-interactive terminal, in JSON or YAML
mode, or whenever `--yes` is supplied. JSON and YAML creation also require `--yes`; machine output
never prompts for approval.

Examples:

```bash
# Inspect the complete plan without persistent mutation
rfapps backup -s plex --destination /mnt/backups --dry-run

# Back up a group after one confirmation
rfapps backup -g media-stack --destination /mnt/backups

# Back up an explicit service set without prompting
rfapps backup --services sonarr,radarr --destination /mnt/backups --yes

# Back up the full resolved Compose project with one JSON result
rfapps backup --all --destination /mnt/backups --output json --yes

# Verify a completed bundle offline
rfapps backup verify /mnt/backups/rfapps-backup-rfmedia-apps-20260729T120000Z/manifest.json
```

CSV is rejected for both creation and verification because the nested storage, recovery, and
integrity evidence cannot be flattened without losing information. Use JSON or YAML for automation.

## What Gets Backed Up

rfapps reads the fully resolved canonical Compose model. It does not infer storage from raw YAML
strings.

Eligible sources are:

- directory-shaped bind mounts;
- stable named volumes.

An eligible source is archived once even when several services consume it. The manifest records
every consumer, mount target, and read-only flag.

The following sources are intentionally skipped and recorded with a stable reason:

- tmpfs mounts;
- read-only host system files;
- Docker sockets and other sockets;
- devices and sources rooted at `/dev`, `/proc`, `/sys`, `/run`, or `/var/run`.

Writable anonymous volumes, unsupported mount types, missing sources or volumes, non-directory bind
sources, ambiguous bind paths, and nested selected bind sources fail preflight. rfapps fails closed
instead of silently publishing an incomplete bundle.

## Cold-Backup and Writer Semantics

The requested services determine which persistent sources are selected, but the quiesce calculation
uses the full resolved Compose project. A running service is treated as a writer when it has a
writable mount of a selected source. For bind mounts, writable equal, ancestor, and descendant
paths also count as overlapping writers.

Before reading archive bytes, rfapps:

1. captures the exact running container IDs for every detected writer service;
2. stops those services;
3. re-observes the complete writer set and refuses to archive while a declared writer remains
   running;
4. archives each source;
5. starts each captured container ID that is no longer running, in dependency-first service
   layers.

Recovery runs after any stop attempt, including partial stop, archive failure, timeout, cancellation,
or interruption. A successful manifest records:

```text
consistency: detected-compose-writers-stopped
```

That statement is intentionally narrow. It does not exclude host processes, containers in another
Compose project, non-rfapps Docker clients, or daemon alias paths that cannot be proven. It also
does not provide application-native database consistency or atomicity across several filesystems.

## Dry-Run and Helper Image

Backup source probing and archive streaming use this source-controlled, digest-pinned helper:

```text
docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1
```

A real creation makes that exact helper available before planning, resolves it to an immutable
daemon-local image ID, and executes by image ID. Each helper container has no network, a read-only
root filesystem, all capabilities dropped, `no-new-privileges`, and exactly one read-only source
mount.

`--dry-run` does not create a bundle, pull an image, acquire either lock, stop a service, prompt, or
archive data. If the pinned helper is already cached, dry-run may create a short-lived sandboxed
read-only probe container so the selected Docker authority can establish the kind and existence of
a bind source. Every probe is awaited and forcibly removed. Probe or cleanup failure fails the
dry-run. If the helper is absent, dry-run returns stable failure evidence without pulling it.

## Destination and Authority Safety

The destination must already be an owned, writable, real directory with no symlinked path
component. Existing bundles and artifacts are never overwritten.

For a local Docker authority, rfapps rejects a destination or reserved bundle that equals or is
beneath an eligible bind source. This prevents the backup from recursively archiving itself. For a
remote Docker authority, daemon bind paths and the client-local destination belong to different
namespaces, so rfapps does not compare them lexically. Bind kind and existence are always probed
through the selected Docker authority rather than with a client-local `stat()`.

Real creation holds both the root rfapps state-mutation lock and the project/Docker-authority
lifecycle lock across revalidation, stop, archive, and exact-container recovery. Dry-run and
verification acquire neither lock.

## Bundle and Manifest

A successful creation publishes:

```text
<destination>/rfapps-backup-<project>-<UTC timestamp>/
  artifacts/
    mount-0001.tar.gz
    mount-0002.tar.gz
  manifest.json
```

Bundle directories use mode `0700`; regular files use mode `0600`. Archives are streamed through
gzip, byte counting, and SHA-256 calculation into exclusive temporary files. `manifest.json` is
published last with an atomic no-replace operation, after every archive is synchronized and exact
container recovery succeeds. A directory without `manifest.json` is an incomplete attempt, not a
valid backup.

The runtime-validated `rfapps-backup.v1` manifest contains:

- creation and completion timestamps plus the consistency statement;
- Compose project, resolved-config SHA-256, and one-way Docker-authority fingerprint;
- requested, resolved, quiesced, and previously running service scopes;
- pinned helper reference and resolved image ID;
- every skipped source and its reason;
- one entry per archive with source identity, all consumers, byte count, SHA-256, and restore hint;
- bounded filesystem-level and database-consistency warnings.

The manifest is sensitive topology metadata. Protect the complete bundle accordingly. SHA-256
detects byte changes; it does not prove authenticity and is not a signature.

## Offline Verification

Verification requires only the manifest and its bundle:

```bash
rfapps backup verify /path/to/bundle/manifest.json
rfapps backup verify /path/to/bundle/manifest.json --output json
```

The verifier does not load rfapps configuration, contact Docker or Compose, acquire a lock, stop a
service, or extract an archive. It validates the strict schema and bundle-relative paths, rejects
symlink substitution, streams each declared regular archive, and compares exact compressed byte
counts and SHA-256 checksums. Missing, unexpected, unsafe, non-regular, size-mismatched, and
checksum-mismatched artifacts are reported in deterministic order.

Verification proves that the published compressed bytes still match the manifest. It does not test
archive extraction, application startup, database semantics, or cryptographic authenticity.

## Machine Result Contracts

JSON and YAML creation emit exactly one `rfapps-backup-result.v1` document. Important fields
include:

- `operation: "backup"`, `status`, `success`, `exitCode`, and `dryRun`;
- requested, resolved, writer, and previously running scopes;
- destination, bundle, and manifest paths when applicable;
- complete `planned`, `skipped`, and `artifacts` outcomes;
- `primaryFailure`, `recoveryFailures`, and `errors`;
- `stagingDisposition`: `none`, `removed`, `published`, or `retained-incomplete`;
- summary counts.

JSON and YAML verification emit exactly one `rfapps-backup-verify-result.v1` document. It includes
the supplied manifest and bundle paths, every declared and unexpected artifact outcome, errors,
warnings, and counts for verified, unexpected, missing, unsafe, size-mismatched, and
checksum-mismatched artifacts.

Progress, the reviewed plan, and human diagnostics go to stderr. Valid machine-mode operations
reserve stdout for the single terminal result document.

## Exit Codes

| Code | Creation                                                       | Verification                                      |
| ---- | -------------------------------------------------------------- | ------------------------------------------------- |
| `0`  | Dry-run completed, or bundle published and writers recovered   | Every declared artifact verified                  |
| `1`  | Docker, filesystem, archive, cleanup, or recovery failure      | Missing, unexpected, size, or checksum failure    |
| `2`  | Invalid/unsafe usage, unsupported input, or cancelled approval | Invalid, unsafe, or unsupported manifest or usage |

Creation does not use exit `3` because a valid published bundle is all-or-nothing. Verification may
report several entry failures in one result but still exits `1`.

## Manual Restore

rfapps does not provide an automated restore command. Treat the manifest's `restore` value as
structured operator guidance, not executable shell text:

- `kind: "bind-tar"` identifies the canonical destination path;
- `kind: "volume-tar"` identifies the effective Docker volume name, driver, and external status;
- both require `precondition: "writers-stopped"`.

Before restoring:

1. run `rfapps backup verify <manifest>`;
2. inspect `scope.quiescedServices`, each mount's `consumers`, and its `restore` hint;
3. stop every writer that could modify the destination;
4. preserve or relocate current data before extracting;
5. stage and inspect the selected archive before copying approved content into the hinted bind
   directory or named volume using tools appropriate to the Docker authority;
6. restore application-native database dumps when required;
7. restart services and validate the application.

Do not extract an untrusted bundle directly into a live destination, especially as root. SHA-256
verification does not authenticate provenance or make archive entries safe. For a local bind
archive, first use an unprivileged account and a new private staging directory:

```bash
tar -tvzf artifacts/mount-0001.tar.gz
staging_dir=$(mktemp -d)
chmod 700 "${staging_dir}"
tar -xzf artifacts/mount-0001.tar.gz \
  --no-same-owner \
  --no-same-permissions \
  -C "${staging_dir}"
find "${staging_dir}" -xdev \( -type l -o -links +1 -o \( ! -type f -a ! -type d \) \) -print
```

Reject the restore if any entry has an absolute or traversal path, escapes the staging directory, is
a symbolic or hard link, or is not a regular file or directory. Review the staged tree, ownership,
permissions, and application-specific contents. Only after independently trusting the bundle's
provenance should an administrator copy approved content into the stopped destination with the
ownership and modes required by that service. Remove the staging directory afterward.

Named-volume and remote-daemon restores require Docker-authority-specific commands; do not assume a
client-local path is visible to a remote daemon.

## Limitations and Complementary Backups

Version 1 does not provide:

- application-native database dumps or online/point-in-time consistency;
- automated restore or archive extraction;
- scheduling, retention, pruning, or remote upload;
- encryption, signatures, or authenticity verification;
- protection from host writers, other Compose projects, or non-cooperating Docker clients;
- anonymous-volume or non-directory bind backup.

Use native database tools such as `pg_dump`, tested Redis/Valkey persistence procedures, and
application-specific exports alongside rfapps backups. Separately schedule, retain, encrypt, and
copy bundles off-host according to your recovery objectives.

## Related Documentation

- [Backup and Restore Guide](../guides/backup-restore.md)
- [rfapps CLI Reference](../../packages/rfapps-cli/README.md#backup)
- [Output Formats](output-formats.md)
- [JSON Output](json-output.md)
- [Error Handling](error-handling.md)
- [Shell Completion](shell-completion.md)
