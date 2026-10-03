#!/usr/bin/env bash
# test-tokenhop-service.sh — opt-in runtime contract test for the tokenhop image

set -euo pipefail

log() { printf '[test-tokenhop] %s\n' "$*"; }
fail() {
  printf '[test-tokenhop] ERROR: %s\n' "$*" >&2
  exit 1
}

repo_root() {
  if command -v git >/dev/null 2>&1 && git rev-parse --show-toplevel >/dev/null 2>&1; then
    git rev-parse --show-toplevel
  else
    cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
  fi
}

if [[ "${RUN_TOKENHOP_CONTRACT_TEST:-}" != "1" ]]; then
  log 'skipped (set RUN_TOKENHOP_CONTRACT_TEST=1 to pull and run the tokenhop image)'
  exit 0
fi

for command_name in curl docker node od; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command not found: $command_name"
done

docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required'
docker buildx version >/dev/null 2>&1 || fail 'Docker Buildx is required for multi-platform manifest verification'
docker info >/dev/null 2>&1 || fail 'the Docker daemon is unavailable'

REPO_ROOT="$(repo_root)"
cd "$REPO_ROOT"

# Production tracks tokenhop:latest; set TOKENHOP_DIGEST to verify a specific manifest.
TOKENHOP_IMAGE="${TOKENHOP_IMAGE:-ghcr.io/tokenhop/tokenhop}"
TOKENHOP_TAG="${TOKENHOP_TAG:-latest}"
TOKENHOP_DIGEST="${TOKENHOP_DIGEST:-}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env.example}"
COMPOSE_IMAGE="${TOKENHOP_IMAGE}:${TOKENHOP_TAG}"
IMAGE_REF="$COMPOSE_IMAGE"

if [[ -n "$TOKENHOP_DIGEST" ]]; then
  [[ "$TOKENHOP_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'TOKENHOP_DIGEST must be a sha256 digest'
  IMAGE_REF="${COMPOSE_IMAGE}@${TOKENHOP_DIGEST}"
fi
[[ -f "$COMPOSE_ENV_FILE" ]] || fail "Compose environment file not found: $COMPOSE_ENV_FILE"

resource_suffix="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
CONTAINER_NAME="rfapps-tokenhop-contract-${resource_suffix}"
VOLUME_NAME="rfapps-tokenhop-contract-${resource_suffix}"
container_started=false
volume_created=false

cleanup() {
  local exit_status=$?

  if ((exit_status != 0)) && [[ "$container_started" == true ]]; then
    printf '[test-tokenhop] container logs (failure diagnostics):\n' >&2
    docker logs "$CONTAINER_NAME" >&2 2>/dev/null || true
  fi

  if [[ "$container_started" == true ]]; then
    docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  if [[ "$volume_created" == true ]]; then
    docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
  fi

  return "$exit_status"
}
trap cleanup EXIT

random_secret() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

# These values are deliberately short-lived and are never printed.
JWT_SECRET="$(random_secret)"
INITIAL_PASSWORD="contract-$(random_secret)"
API_KEY_SECRET="$(random_secret)"
MACHINE_ID_SALT="$(random_secret)"

log "verifying multi-platform image ${IMAGE_REF}"
manifest_output="$(docker buildx imagetools inspect "$IMAGE_REF")"
if [[ -n "$TOKENHOP_DIGEST" ]]; then
  grep -Fq "Digest:    ${TOKENHOP_DIGEST}" <<<"$manifest_output" || fail 'manifest digest does not match TOKENHOP_DIGEST'
fi
grep -Eq 'Platform:[[:space:]]+linux/amd64([[:space:]]|$)' <<<"$manifest_output" || fail 'image manifest is missing linux/amd64'
grep -Eq 'Platform:[[:space:]]+linux/arm64([[:space:]]|$)' <<<"$manifest_output" || fail 'image manifest is missing linux/arm64'

log 'pulling the image reference'
docker pull "$IMAGE_REF" >/dev/null

log 'validating resolved Compose and Traefik contracts'
compose_json="$({
  TOKENHOP_IMAGE="$TOKENHOP_IMAGE" \
    TOKENHOP_TAG="$TOKENHOP_TAG" \
    docker compose --env-file "$COMPOSE_ENV_FILE" config --format json
})"

# The single-quoted block is JavaScript; shell expansion would be incorrect here.
# shellcheck disable=SC2016
printf '%s\n' "$compose_json" | node -e '
const fs = require("node:fs");
const expectedImage = process.argv[1];
const project = JSON.parse(fs.readFileSync(0, "utf8"));
const service = project.services?.["tokenhop"];

function assert(condition, message) {
  if (!condition) {
    console.error(`[test-tokenhop] ERROR: Compose contract: ${message}`);
    process.exit(1);
  }
}

assert(service, "service tokenhop is missing");
assert(service.image === expectedImage, `expected image ${expectedImage}, received ${service.image}`);
assert(!service.ports || service.ports.length === 0, "backend port must not be published on the host");

const labels = service.labels ?? {};
assert(String(labels["traefik.enable"]) === "true", "Traefik must be enabled");
assert(/^Host\(`tokenhop\.[^`]+`\)$/.test(labels["traefik.http.routers.tokenhop.rule"] ?? ""), "native tokenhop host route is missing");
assert(labels["traefik.http.routers.tokenhop.entrypoints"] === "websecure", "router must use websecure");
assert(String(labels["traefik.http.routers.tokenhop.tls"]) === "true", "router TLS must be enabled");
assert(String(labels["traefik.http.services.tokenhop.loadbalancer.server.port"]) === "20128", "backend port must be 20128");
assert(labels["traefik.http.routers.tokenhop.middlewares"] === "authentik-dev@docker", "dashboard router must use authentik-dev");
assert(/^Host\(`tokenhop\.[^`]+`\) && PathPrefix\(`\/v1`\)$/.test(labels["traefik.http.routers.tokenhop-api.rule"] ?? ""), "tokenhop-api /v1 route is missing");
assert(!labels["traefik.http.routers.tokenhop-api.middlewares"], "API router must rely on native API keys, not Authentik");

const volumes = service.volumes ?? [];
assert(volumes.some((mount) => (typeof mount === "string" ? mount.split(":")[1] : mount.target) === "/app/data"), "/app/data persistent mount is missing");
assert(service.read_only === true, "root filesystem must be read-only");
assert(service.init === true, "Docker init must be enabled");
assert((service.tmpfs ?? []).some((mount) => String(mount).startsWith("/tmp")), "/tmp tmpfs is missing");
assert((service.security_opt ?? []).includes("no-new-privileges:true"), "no-new-privileges must be enabled");
assert((service.cap_drop ?? []).includes("ALL"), "all capabilities must be dropped by default");
for (const capability of ["CHOWN", "SETGID", "SETUID"]) {
  assert((service.cap_add ?? []).includes(capability), `${capability} must be restored for the privilege-dropping entrypoint`);
}
assert(Number(service.deploy?.resources?.limits?.pids) === 256, "PID limit must be 256");
assert(String(service.environment?.AUTH_COOKIE_SECURE) === "true", "secure auth cookies must be enabled behind Traefik");
' "$COMPOSE_IMAGE"

docker volume create "$VOLUME_NAME" >/dev/null
volume_created=true

start_container() {
  docker run --detach \
    --name "$CONTAINER_NAME" \
    --hostname tokenhop-contract \
    --init \
    --read-only \
    --pids-limit 256 \
    --cpus 2 \
    --memory 1g \
    --cap-drop ALL \
    --cap-add CHOWN \
    --cap-add SETGID \
    --cap-add SETUID \
    --security-opt no-new-privileges:true \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
    --publish 127.0.0.1::20128 \
    --volume "${VOLUME_NAME}:/app/data" \
    --env DATA_DIR=/app/data \
    --env PORT=20128 \
    --env HOSTNAME=0.0.0.0 \
    --env NODE_ENV=production \
    --env JWT_SECRET="$JWT_SECRET" \
    --env INITIAL_PASSWORD="$INITIAL_PASSWORD" \
    --env API_KEY_SECRET="$API_KEY_SECRET" \
    --env MACHINE_ID_SALT="$MACHINE_ID_SALT" \
    --env AUTH_COOKIE_SECURE=true \
    --env ENABLE_REQUEST_LOGS=false \
    "$IMAGE_REF" >/dev/null
  container_started=true
}

container_port() {
  docker inspect "$CONTAINER_NAME" --format '{{(index (index .NetworkSettings.Ports "20128/tcp") 0).HostPort}}'
}

wait_for_health() {
  local port status attempt
  port="$(container_port)"

  for attempt in $(seq 1 60); do
    if [[ "$(docker inspect "$CONTAINER_NAME" --format '{{.State.Running}}')" != true ]]; then
      fail 'container exited before becoming healthy'
    fi

    status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
      --connect-timeout 2 --max-time 5 "http://127.0.0.1:${port}/api/health" || true)"
    if [[ "$status" == 200 ]]; then
      printf '%s\n' "$port"
      return 0
    fi
    sleep 1
  done

  fail 'health endpoint did not return HTTP 200 within 60 seconds'
}

assert_application_is_non_root() {
  local app_uid
  app_uid="$(docker top "$CONTAINER_NAME" -eo pid,uid,args | awk 'NR > 1 && /next-server/ { print $2; exit }')"

  [[ "$app_uid" =~ ^[0-9]+$ ]] || fail 'could not identify the tokenhop application process UID'
  [[ "$app_uid" != 0 ]] || fail 'the tokenhop application process is running as root'
}

request_status() {
  local port=$1
  shift
  curl --silent --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 2 --max-time 5 "$@" "http://127.0.0.1:${port}/v1/models" || true
}

assert_unauthorized() {
  local label=$1 port=$2 status
  shift 2
  status="$(request_status "$port" "$@")"
  [[ "$status" == 401 ]] || fail "${label} /v1/models request returned HTTP ${status}, expected 401"
}

login_and_capture_cookie() {
  local port=$1 response status headers
  response="$(curl --silent --show-error --dump-header - --output /dev/null \
    --write-out $'\n%{http_code}' --connect-timeout 2 --max-time 5 \
    --request POST --header 'Content-Type: application/json' \
    --data "{\"password\":\"${INITIAL_PASSWORD}\"}" \
    "http://127.0.0.1:${port}/api/auth/login")"
  status="${response##*$'\n'}"
  headers="${response%$'\n'*}"
  [[ "$status" == 200 ]] || fail "native dashboard login returned HTTP ${status}, expected 200"

  AUTH_COOKIE="$(printf '%s\n' "$headers" | awk 'tolower($1) == "set-cookie:" { print $2; exit }' | tr -d '\r' | cut -d';' -f1)"
  [[ "$AUTH_COOKIE" == auth_token=* ]] || fail 'native dashboard login did not return an auth_token cookie'
  grep -Eqi '^set-cookie: auth_token=.*;.*secure' <<<"$headers" || fail 'native dashboard login cookie is missing the Secure attribute'
}

json_request() {
  local port=$1 request_path=$2 response
  shift 2
  response="$(curl --silent --show-error --write-out $'\n%{http_code}' \
    --connect-timeout 2 --max-time 5 "$@" "http://127.0.0.1:${port}${request_path}")"
  RESPONSE_STATUS="${response##*$'\n'}"
  RESPONSE_BODY="${response%$'\n'*}"
}

assert_effective_api_key_requirement() {
  local port=$1
  json_request "$port" /api/settings --header "Cookie: ${AUTH_COOKIE}"
  [[ "$RESPONSE_STATUS" == 200 ]] || fail "authenticated settings request returned HTTP ${RESPONSE_STATUS}, expected 200"
  printf '%s' "$RESPONSE_BODY" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const settings = JSON.parse(input);
      if (settings.requireApiKey !== true) process.exit(1);
    });
  ' || fail 'effective tokenhop settings do not require API keys'
}

create_api_key() {
  local port=$1 parsed
  json_request "$port" /api/keys \
    --request POST \
    --header 'Content-Type: application/json' \
    --header "Cookie: ${AUTH_COOKIE}" \
    --data '{"name":"rfapps-contract-test"}'
  [[ "$RESPONSE_STATUS" == 201 ]] || fail "API-key creation returned HTTP ${RESPONSE_STATUS}, expected 201"

  # The single-quoted block is JavaScript; shell expansion would be incorrect here.
  # shellcheck disable=SC2016
  parsed="$(printf '%s' "$RESPONSE_BODY" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const result = JSON.parse(input);
      if (typeof result.key !== "string" || typeof result.id !== "string") process.exit(1);
      process.stdout.write(`${result.key} ${result.id}`);
    });
  ')" || fail 'API-key creation response did not contain a key and id'
  read -r CREATED_API_KEY CREATED_API_KEY_ID <<<"$parsed"
}

assert_api_key_authorized() {
  local port=$1 status
  status="$(request_status "$port" --header "Authorization: Bearer ${CREATED_API_KEY}")"
  [[ "$status" == 200 ]] || fail "valid API key returned HTTP ${status} for /v1/models, expected 200"
}

assert_api_key_persisted() {
  local port=$1
  json_request "$port" /api/keys --header "Cookie: ${AUTH_COOKIE}"
  [[ "$RESPONSE_STATUS" == 200 ]] || fail "persisted API-key listing returned HTTP ${RESPONSE_STATUS}, expected 200"
  printf '%s' "$RESPONSE_BODY" | node -e '
    let input = "";
    const expectedId = process.argv[1];
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const result = JSON.parse(input);
      if (!Array.isArray(result.keys) || !result.keys.some((key) => key.id === expectedId)) process.exit(1);
    });
  ' "$CREATED_API_KEY_ID" || fail 'created API key did not survive container recreation'
}

revoke_api_key() {
  local port=$1 status
  json_request "$port" "/api/keys/${CREATED_API_KEY_ID}" \
    --request PUT \
    --header 'Content-Type: application/json' \
    --header "Cookie: ${AUTH_COOKIE}" \
    --data '{"isActive":false}'
  [[ "$RESPONSE_STATUS" == 200 ]] || fail "API-key revocation returned HTTP ${RESPONSE_STATUS}, expected 200"

  status="$(request_status "$port" --header "Authorization: Bearer ${CREATED_API_KEY}")"
  [[ "$status" == 401 ]] || fail "revoked API key returned HTTP ${status} for /v1/models, expected 401"
}

log 'starting the hardened container on a random loopback-only port'
start_container
FIRST_PORT="$(wait_for_health)"
assert_application_is_non_root

assert_unauthorized 'anonymous' "$FIRST_PORT"
assert_unauthorized 'spoofed Host' "$FIRST_PORT" --header 'Host: localhost'
assert_unauthorized 'spoofed X-9r-Real-Ip' "$FIRST_PORT" --header 'X-9r-Real-Ip: 127.0.0.1'
assert_unauthorized 'spoofed X-Real-IP' "$FIRST_PORT" --header 'X-Real-IP: 127.0.0.1'
assert_unauthorized 'spoofed X-Forwarded-For' "$FIRST_PORT" --header 'X-Forwarded-For: 127.0.0.1'
assert_unauthorized 'combined spoofed locality headers' "$FIRST_PORT" \
  --header 'Host: localhost' \
  --header 'X-9r-Real-Ip: 127.0.0.1' \
  --header 'X-Real-IP: 127.0.0.1' \
  --header 'X-Forwarded-For: 127.0.0.1'

login_and_capture_cookie "$FIRST_PORT"
assert_effective_api_key_requirement "$FIRST_PORT"
create_api_key "$FIRST_PORT"
assert_api_key_authorized "$FIRST_PORT"
docker exec --user node "$CONTAINER_NAME" test -s /app/data/db/data.sqlite || fail 'tokenhop did not create its persistent SQLite database'

log 'recreating the container against the same persistent state volume'
docker rm --force "$CONTAINER_NAME" >/dev/null
container_started=false
start_container
SECOND_PORT="$(wait_for_health)"
assert_application_is_non_root
assert_unauthorized 'post-recreation anonymous' "$SECOND_PORT"
assert_api_key_authorized "$SECOND_PORT"
login_and_capture_cookie "$SECOND_PORT"
assert_effective_api_key_requirement "$SECOND_PORT"
assert_api_key_persisted "$SECOND_PORT"
revoke_api_key "$SECOND_PORT"

log 'official image, hardening, authentication boundary, persistence, and Compose contracts passed'
