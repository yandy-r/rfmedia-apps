# Changelog

## [0.4.8] - 2026-10-23

### Summary

Pins Node.js to the October 21, 2026 security releases and updates `markdown-it` and `vite` for advisories published this month.

### Highlights

- Local development moves from Node 24.19.0 to 24.22.1. GitHub Actions and Forgejo CI pin Node 22.23.4 instead of floating Node 22.
- The monorepo engines floor is `>=24.22.1`. The CLI packages require `>=22.23.4`.
- `markdown-it` is 14.3.3 and `vite` is 7.3.7.

### Breaking Changes

_None_

### Features

_None_

### Fixes

- fix(deps): pin node to the october 2026 security releases (edd6b378)

### Upgrade Notes

Install Node 24.22.1 for monorepo development and Node 22.23.4 or newer to satisfy the CLI engines floor. This tag does not change compose files or schemas. On the home server, check out `v0.4.8` and re-pull Node-based images after their upstreams include the October 21 Node releases. `rfapps`, `rfmedia`, and `@rfmedia/common` are not published to npm.
