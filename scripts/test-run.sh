#!/usr/bin/env bash
# test-run.sh — deterministic monorepo test runner for hooks and local CI parity
#
# Several rfmedia-cli filesystem and tag-writer tests create temp directories whose
# permission bits must not be group- or world-writable. Developer shells (especially
# umask 002) and agent environments (FORCE_COLOR) otherwise fail unrelated tests and
# block git push via lefthook pre-push.

set -euo pipefail

log() { printf '[test-run] %s\n' "$*"; }

repo_root() {
  if command -v git >/dev/null 2>&1 && git rev-parse --show-toplevel >/dev/null 2>&1; then
    git rev-parse --show-toplevel
  else
    cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
  fi
}

REPO_ROOT="$(repo_root)"
cd "$REPO_ROOT"

umask 022
unset FORCE_COLOR

log "running monorepo test suite (umask 022, FORCE_COLOR unset)"
npm run test:common
npm run test:rfmedia
npm run test:rfapps
npm run test:contracts
