#!/usr/bin/env bash
# test-llama-service.sh — runtime contract test for the llama (AMD ROCm) service.
# Compose contract always runs; runtime checks need RUN_LLAMA_CONTRACT_TEST=1 and a running `llama` container.

set -euo pipefail

log() { printf '[test-llama] %s\n' "$*"; }
fail() {
  printf '[test-llama] ERROR: %s\n' "$*" >&2
  exit 1
}

cd "$(dirname "${BASH_SOURCE[0]}")/.."

for command_name in docker node; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command not found: $command_name"
done

COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env.example}"
[[ -f "$COMPOSE_ENV_FILE" ]] || fail "Compose environment file not found: $COMPOSE_ENV_FILE"

log 'validating resolved Compose contract'
compose_json="$(docker compose --env-file "$COMPOSE_ENV_FILE" config --format json 2>/dev/null)"

# The single-quoted block is JavaScript; shell expansion would be incorrect here.
# shellcheck disable=SC2016
printf '%s\n' "$compose_json" | node -e '
const fs = require("node:fs");
const project = JSON.parse(fs.readFileSync(0, "utf8"));
const s = project.services?.llama;
function assert(ok, msg) {
  if (!ok) { console.error(`[test-llama] ERROR: Compose contract: ${msg}`); process.exit(1); }
}
assert(s, "service llama is missing");
assert(/^ghcr\.io\/ggml-org\/llama\.cpp:server-rocm-b\d+@sha256:[0-9a-f]{64}$/.test(s.image), "image must be pinned server-rocm tag + digest");
assert(!s.ports || s.ports.length === 0, "no host ports");
const labels = Object.keys(s.labels ?? {});
assert(labels.includes("traefik.enable"), "Traefik labels missing");
assert(/^Host\(`llama\.[^`]+`\)$/.test(s.labels["traefik.http.routers.llama.rule"] ?? ""), "llama host route missing");
assert(s.labels["traefik.http.routers.llama.entrypoints"] === "websecure", "router must use websecure");
assert(String(s.labels["traefik.http.routers.llama.tls"]) === "true", "TLS must be enabled");
assert(s.labels["traefik.http.services.llama.loadbalancer.server.port"] === "8080", "backend port must be 8080");
assert(!String(s.labels["traefik.http.routers.llama.middlewares"] ?? "").includes("authentik"), "must NOT use Authentik middleware; native API key guards it");
assert(s.labels["tsdproxy.enable"] === "true" && s.labels["tsdproxy.proxyprovider"] === "rfapps", "tsdproxy provider rfapps labels missing");
assert(s.labels["tsdproxy.name"] === "llama", "tsdproxy host must be llama");
assert((s.command ?? []).join(" ").includes("--api-key-file"), "native --api-key-file required");
assert((s.volumes ?? []).some((v) => String(v.source).endsWith("llama/api-keys")), "api-keys secret file mount missing");
assert(!s.privileged && s.network_mode !== "host", "no privileged / host network");
assert(Object.keys(s.networks ?? {}).join() === "apps", "apps network only");
const devices = s.devices ?? [];
const render = devices.find((d) => d.target === "/dev/dri/renderD129");
const kfd = devices.find((d) => d.target === "/dev/kfd");
assert(devices.length === 2 && render && kfd, "devices must be exactly AMD render node + /dev/kfd");
assert(render.source === "/dev/dri/by-path/pci-0000:07:00.0-render", "render node must be the AMD by-path");
assert(kfd.source === "/dev/kfd", "kfd must map host /dev/kfd");
assert(!devices.some((d) => /renderD128|card/.test(d.source)), "no Intel/card devices");
assert((s.command ?? []).join(" ").includes("--device ROCm0 --gpu-layers 99"), "explicit --device ROCm0 --gpu-layers 99");
assert((s.group_add ?? []).map(String).includes("993"), "render group 993 required");
assert(s.user && !/^0(:|$)/.test(String(s.user)), "must run non-root");
assert(Number(s.deploy.resources.limits.memory) >= 12 * 1024 ** 3, "memory limit must be >= 12 GiB for 14B model");
assert(s.healthcheck, "healthcheck missing");
assert(Number(s.deploy?.resources?.limits?.pids) > 0, "pids limit missing");
assert(s.read_only === true && (s.cap_drop ?? []).includes("ALL"), "read_only + cap_drop ALL");
assert((s.security_opt ?? []).includes("no-new-privileges:true"), "no-new-privileges");
'

if [[ "${RUN_LLAMA_CONTRACT_TEST:-}" != "1" ]]; then
  log 'compose contract passed (set RUN_LLAMA_CONTRACT_TEST=1 for runtime GPU checks)'
  exit 0
fi

docker inspect llama >/dev/null 2>&1 || fail 'llama container not running'
[[ "$(docker inspect llama --format '{{.State.Health.Status}}')" == healthy ]] || fail 'llama container is not healthy'

log 'checking /health (public, no key required)'
docker exec llama curl -sf http://localhost:8080/health | grep -q '"status":"ok"' || fail '/health did not return ok'

log 'checking inference requires native API key'
no_key_status="$(docker exec llama curl -s -o /dev/null -w '%{http_code}' -m 60 http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":5}')"
[[ "$no_key_status" == 401 ]] || fail "inference without key returned HTTP ${no_key_status}, expected 401"

if [[ -z "${LLAMA_API_KEY:-}" ]]; then
  if command -v op >/dev/null 2>&1; then
    LLAMA_API_KEY="$(op read 'op://EnvSecrets/RFMEDIA_SECRETS/.env.local/LLAMA_API_KEY' 2>/dev/null)" ||
      fail 'op read failed for LLAMA_API_KEY; check 1Password sign-in and EnvSecrets access'
  fi
  [[ -n "${LLAMA_API_KEY:-}" ]] || fail 'set LLAMA_API_KEY or run: op read op://EnvSecrets/RFMEDIA_SECRETS/.env.local/LLAMA_API_KEY (sign in first: op account whoami)'
fi
# Provisioned keys are 64 lowercase hex; refuse anything else before it reaches
# curl config interpolation or the server (llama accepts any bearer string —
# this contract is ours, see docs/services/llama-setup.md#auth).
[[ "$LLAMA_API_KEY" =~ ^[0-9a-f]{64}$ ]] || fail 'LLAMA_API_KEY must be 64 lowercase hex chars (see llama-setup.md provisioning)'

# Feed the bearer token through stdin, never process arguments or Docker env.
request() {
  printf 'header = "Authorization: Bearer %s"\n' "$LLAMA_API_KEY" |
    docker exec -i llama curl --config - -sf -m 120 "$@"
}

log 'running authenticated completion'
reply="$(request http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hi"}],"max_tokens":8}')"
printf '%s' "$reply" | node -e '
let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
  const j = JSON.parse(d);
  if (!(j.usage?.completion_tokens > 0)) { console.error("[test-llama] ERROR: no tokens returned"); process.exit(1); }
});
' || fail 'completion returned no tokens'

# GPU sysfs via PCI address (matches the compose by-path device); drm cardN numbering is unstable.
gpu_sysfs="/sys/bus/pci/devices/0000:07:00.0"
[[ -d "$gpu_sysfs" ]] || fail "AMD GPU sysfs not found at $gpu_sysfs"
vram_before="$(cat "$gpu_sysfs"/mem_info_vram_used 2>/dev/null)" || fail 'cannot read VRAM sysfs'
request http://localhost:8080/completion \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Write a long story:","n_predict":300}' >/dev/null &
bg=$!
peak_busy=0
while kill -0 "$bg" 2>/dev/null; do
  busy="$(cat "$gpu_sysfs"/gpu_busy_percent 2>/dev/null || echo 0)"
  [[ "$busy" =~ ^[0-9]+$ ]] && ((busy > peak_busy)) && peak_busy=$busy
  sleep 0.3
done
wait "$bg" || fail 'long completion request failed'
vram_now="$(cat "$gpu_sysfs"/mem_info_vram_used)"
log "gpu_busy peak=${peak_busy}% vram used=${vram_now} (idle ${vram_before})"
((peak_busy > 0)) || fail 'GPU busy never exceeded 0% during generation (possible CPU fallback)'
((vram_now > 200000000)) || fail 'VRAM usage too low for offloaded model (possible CPU fallback)'

log 'compose contract, health, completion, and GPU offload passed'

# Both ingress paths must enforce the same native bearer key, without SSO.
command -v curl >/dev/null 2>&1 || fail 'curl required for HTTPS checks'
for variable in DOMAIN TS_DOMAIN; do
  if [[ -z "${!variable:-}" ]]; then
    command -v op >/dev/null 2>&1 || fail "op required to resolve $variable"
    value="$(op read "op://EnvSecrets/RFMEDIA_SECRETS/.env.local/$variable" 2>/dev/null)" ||
      fail "op read failed for $variable; check 1Password sign-in and EnvSecrets access"
    printf -v "$variable" '%s' "$value"
  fi
  [[ -n "${!variable}" ]] || fail "$variable must not be empty"
done
for base in "https://llama.${DOMAIN}" "https://llama.${TS_DOMAIN}"; do
  log "checking HTTPS inference at $base"
  status="$(curl -sS -o /dev/null -w '%{http_code}' -m 60 "$base/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":5}')"
  [[ "$status" == 401 ]] || fail "$base without key returned HTTP $status, expected 401"
  printf 'header = "Authorization: Bearer %s"\n' "$LLAMA_API_KEY" |
    curl --config - -fsS -m 120 "$base/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"Say hi"}],"max_tokens":8}' |
    node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{if(!(JSON.parse(d).usage?.completion_tokens>0))process.exit(1)});' ||
    fail "$base authenticated generation failed"
  log "$base: 401 without key; authenticated generation passed (TLS verified)"
done
