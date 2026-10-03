#!/usr/bin/env bash
# Terraform wrapper for infra/terraform/<stack> with dotenvx or 1Password secrets injection.
#
# Usage: scripts/tf.sh <plan|apply|plan-apply> [stack...] [-- terraform args]
#   plan        init + plan, saves <stack>/tfplan
#   apply       applies the saved <stack>/tfplan
#   plan-apply  init + interactive `terraform apply` (shows plan, asks to confirm)
# No stack = every stack under infra/terraform/. Args starting with "-" go to terraform.
#
# Env file: TF_ENV_FILE (default .env.local). Tool: TF_ENV_TOOL (dotenvx|op); unset = dotenvx when
# the file carries a DOTENV_PUBLIC_KEY header (dotenvx-encrypted), otherwise op (op:// references).
# After apply, outputs listed in <stack>/env-outputs ("<output> <ENV_KEY>" per line) are written
# back: encrypted into the env file via `dotenvx set`, or into the 1Password field the key's
# op:// reference points at (field must already exist).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${TF_ENV_FILE:-$ROOT/.env.local}"
[[ -f "$ENV_FILE" ]] || { echo "tf: env file not found: $ENV_FILE" >&2; exit 1; }

ENV_TOOL="${TF_ENV_TOOL:-}"
if [[ -z "$ENV_TOOL" ]]; then
  if grep -q '^DOTENV_PUBLIC_KEY' "$ENV_FILE"; then ENV_TOOL=dotenvx; else ENV_TOOL=op; fi
fi
case "$ENV_TOOL" in
  dotenvx | op) ;;
  *) echo "tf: TF_ENV_TOOL must be dotenvx or op (got '$ENV_TOOL')" >&2; exit 2 ;;
esac

if [[ -z "${RFAPPS_TF_ENV_LOADED:-}" ]]; then
  export RFAPPS_TF_ENV_LOADED=1 TF_ENV_TOOL="$ENV_TOOL"
  if [[ "$ENV_TOOL" == dotenvx ]]; then
    exec dotenvx run -q -f "$ENV_FILE" -- bash "$0" "$@"
  fi
  exec op run --no-masking --env-file "$ENV_FILE" -- bash "$0" "$@"
fi

action="${1:-}"
shift || true
case "$action" in
  plan | apply | plan-apply) ;;
  *) echo "usage: $0 <plan|apply|plan-apply> [stack...] [terraform args]" >&2; exit 2 ;;
esac

stacks=() tf_args=()
for arg in "$@"; do
  if [[ "$arg" == -* ]]; then tf_args+=("$arg"); else stacks+=("$arg"); fi
done
if ((${#stacks[@]} == 0)); then
  for d in "$ROOT"/infra/terraform/*/; do stacks+=("$(basename "$d")"); done
fi

# Env-file keys -> Terraform inputs. Empty values fail the stack's variable validation.
export TF_VAR_domain="${DOMAIN-}"
export TF_VAR_domain2="${DOMAIN2-}"
export TF_VAR_cloudflare_account_id="${CF_ACCOUNT_ID-}"
export CLOUDFLARE_API_TOKEN="${CF_TERRAFORM_API_TOKEN-}"
[[ -n "$CLOUDFLARE_API_TOKEN" ]] || { echo "tf: CF_TERRAFORM_API_TOKEN is not set in $(basename "$ENV_FILE")" >&2; exit 1; }

# Writes $2 into the 1Password field referenced by KEY=op://vault/item/[section/]field in the env file.
write_op_ref() {
  local key="$1" value="$2" ref vault item field tmp rc=0
  ref="$(sed -n "s|^${key}=op://||p" "$ENV_FILE")"
  [[ -n "$ref" ]] || { echo "tf: $key has no op:// reference in $(basename "$ENV_FILE")" >&2; return 1; }
  IFS=/ read -r vault item _ <<<"$ref"
  field="${ref##*/}"
  # A 0600 template file (not argv, not stdin — op rejects a stdin template) carries the value.
  tmp="$(mktemp)"
  op item get "$item" --vault "$vault" --format json | jq --arg f "$field" --arg v "$value" '
    if ([.fields[] | select(.label == $f)] | length) == 1
    then .fields |= map(if .label == $f then .value = $v else . end)
    else error("expected exactly one field labelled \($f)") end' >"$tmp" &&
    op item edit "$item" --vault "$vault" --template "$tmp" >/dev/null </dev/null || rc=$?
  rm -f "$tmp"
  return "$rc"
}

sync_outputs() {
  local dir="$1" map="$1/env-outputs" output key value
  [[ -f "$map" ]] || return 0
  while read -r output key; do
    [[ -z "$output" || "$output" == \#* ]] && continue
    value="$(terraform -chdir="$dir" output -raw "$output")"
    [[ "${!key-}" == "$value" ]] && continue
    if [[ "$ENV_TOOL" == dotenvx ]]; then
      dotenvx set -q -f "$ENV_FILE" "$key" -- "$value"
      echo "tf: wrote $key to $(basename "$ENV_FILE") (encrypted)"
    else
      write_op_ref "$key" "$value"
      echo "tf: wrote $key to 1Password"
    fi
  done <"$map"
}

for stack in "${stacks[@]}"; do
  dir="$ROOT/infra/terraform/$stack"
  [[ -d "$dir" ]] || { echo "tf: unknown stack '$stack' (no $dir)" >&2; exit 2; }
  echo "==> $stack: $action"
  case "$action" in
    plan)
      terraform -chdir="$dir" init -input=false >/dev/null
      terraform -chdir="$dir" plan -input=false -out=tfplan "${tf_args[@]}"
      ;;
    apply)
      [[ -f "$dir/tfplan" ]] || { echo "tf: no saved plan for '$stack'; run tf:plan first" >&2; exit 1; }
      terraform -chdir="$dir" apply -input=false "${tf_args[@]}" tfplan
      rm -f "$dir/tfplan"
      sync_outputs "$dir"
      ;;
    plan-apply)
      terraform -chdir="$dir" init -input=false >/dev/null
      terraform -chdir="$dir" apply "${tf_args[@]}"
      sync_outputs "$dir"
      ;;
  esac
done
