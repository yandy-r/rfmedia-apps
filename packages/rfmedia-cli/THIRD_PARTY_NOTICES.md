# Third-Party Notices

This file identifies third-party source material used to maintain rfmedia's private generated Lidarr
client. It is an attribution and provenance record, not legal advice or a conclusion about generated
output.

## Lidarr OpenAPI Document

- Upstream project: `Lidarr/Lidarr`
- Source commit: `3e2858439ff35b372d0af00bcea1b0a357572d26`
- Source path: `src/Lidarr.Api.V1/openapi.json`
- Commit-pinned source:
  <https://raw.githubusercontent.com/Lidarr/Lidarr/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/openapi.json>
- Local snapshot: `openapi/lidarr-v1.json`
- Manifest: `openapi/lidarr-v1.manifest.json`
- Upstream document license designation: GPL-3.0

The local snapshot is byte-identical to the immutable upstream Git blob. Its Git blob SHA is
`bd42875a7ad5f41ba1d00381a65fe21ee376d410`; its exact-byte SHA-256 is
`4ae9e79e9662898ed4704ce80f091161587a9f0d664f9e518b11a038616e491f`.

## Hey API Generator and Bundled Fetch Client

- Generator: `@hey-api/openapi-ts@0.93.0`, MIT license
- Client plugin: `@hey-api/client-fetch`, MIT license
- Distribution mode: client source bundled by `@hey-api/openapi-ts@0.93.0`; no separate runtime
  package dependency
- Reproducible identity: exact generator package, tarball integrity, configuration, and raw/normalized
  bundled-runtime hashes in `openapi/lidarr-v1.manifest.json`

The generated client source is committed under `src/lib/lidarr/generated/`. Generation performs an
asserted type-only replacement of exactly two `BodyInit | null | undefined` references with
`RequestInit['body']`; it fails rather than accepting any other match count. This does not alter the
OpenAPI snapshot.

See [Lidarr Generated Client](docs/features/lidarr-generated-client.md) for the offline regeneration,
drift-check, immutable refresh, review, and rollback procedures.

rfmedia's own package metadata remains MIT. The named third-party materials retain their own notices;
this statement does not determine the licensing treatment of generated output. Do not publish the
package without maintainer approval of the notice and a fresh review of `npm pack --dry-run --json`.
