#!/usr/bin/env bash
# Cloud Agent bootstrap for rfmedia-apps.
#
# Idempotent: safe to re-run. Provisions the toolchain the repo expects, then
# installs and builds the TypeScript CLI workspaces (rf-common, rfmedia-cli,
# rfapps-cli).
#
#   - Node 24: the root package.json requires Node >=24. The base image ships an
#     older Node, so we pin 24 via nvm and make it the login-shell default.
#   - dotenvx: the rfapps CLI shells out to the `dotenvx` binary to decrypt the
#     encrypted `.env.local` (secrets injection). Provide the decryption key by
#     setting the DOTENV_PRIVATE_KEY_LOCAL secret in the Cloud Agent settings.
#   - better-sqlite3: rfapps depends on this native module; it is compiled/
#     fetched for the active Node ABI during `npm ci`, so Node must be pinned
#     before install and match at runtime.
set -euo pipefail

NODE_VERSION=24

log() { printf '\n[install] %s\n' "$*"; }

log "Ensuring nvm is available"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  log "nvm not found; installing nvm"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

log "Installing and selecting Node ${NODE_VERSION}"
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
nvm use default

# Persist Node ${NODE_VERSION} as the default for future login shells.
if ! grep -q 'NVM_DIR/nvm.sh' "$HOME/.bashrc" 2>/dev/null; then
  {
    echo 'export NVM_DIR="$HOME/.nvm"'
    echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
  } >> "$HOME/.bashrc"
fi

log "Node: $(node -v), npm: $(npm -v)"

log "Installing dotenvx globally (encrypted .env.local secrets injection)"
npm install -g @dotenvx/dotenvx@2
log "dotenvx: $(dotenvx --version)"

log "Installing workspace dependencies (npm ci)"
npm ci

log "Building all packages"
npm run build:all

log "Smoke check: native better-sqlite3 loads under Node $(node -v)"
node -e "const D=require('better-sqlite3'); const db=new D(':memory:'); db.exec('create table t(x)'); db.close(); console.log('better-sqlite3 OK');"

log "Smoke check: rfapps CLI runs"
node packages/rfapps-cli/dist/cli.js --version

log "Bootstrap complete"
