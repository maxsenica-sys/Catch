#!/usr/bin/env bash
# Deploy Catch to Fly.io without flyctl or Docker (neither is allowed in the
# Claude Code cloud sessions this is run from). Builds the PWA, stages the
# production files, pushes an image to Fly's registry, then creates or updates
# the app's IPs, secrets, volume and single machine through Fly's APIs.
#
#   bash scripts/deploy.sh
#
# Needs FLY_API_TOKEN. Passes OPENAI_API_KEY and CATCH_ANTHROPIC_API_KEY
# (as ANTHROPIC_API_KEY) to the app when present. Safe to re-run.
set -euo pipefail
APP="${FLY_APP:-catch-maxsenica-sys}"
REGION="${FLY_REGION:-fra}"
cd "$(dirname "$0")/.."
: "${FLY_API_TOKEN:?FLY_API_TOKEN is not set}"

TAG="deploy-$(git rev-parse --short HEAD)"
[ -n "$(git status --porcelain -- server web package.json package-lock.json)" ] && TAG="$TAG-dirty-$(date +%s)"

npm run build --silent
STAGE="$(mktemp -d)/app"
mkdir -p "$STAGE/web"
cp package.json package-lock.json "$STAGE/"
cp -r server "$STAGE/"
cp -r web/dist "$STAGE/web/dist"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --silent)

python3 -I scripts/fly/push_image.py "$APP" "$TAG" "$STAGE"
python3 -I scripts/fly/setup.py "$APP" "registry.fly.io/$APP:$TAG" "$REGION"

for _ in $(seq 1 12); do
  if out=$(curl -fsS --max-time 10 "https://$APP.fly.dev/healthz"); then
    echo "$out"
    echo "Live: https://$APP.fly.dev"
    exit 0
  fi
  sleep 5
done
# Some sandboxes' network policy blocks *.fly.dev while allowing Fly's API, so
# fall back to Fly's own health check on the machine before calling it failed.
status=$(curl -fsS "https://api.machines.dev/v1/apps/$APP/machines" -H "Authorization: Bearer $FLY_API_TOKEN" \
  | python3 -c "import sys,json; ms=json.load(sys.stdin); print(' '.join(c['status'] for m in ms for c in m.get('checks',[])))" || true)
if [ -n "$status" ] && [ -z "${status//passing/}" ] || [ "$status" = "passing" ]; then
  echo "https://$APP.fly.dev is not reachable from here, but Fly reports the health check passing."
  echo "Live: https://$APP.fly.dev"
  exit 0
fi
echo "Deployed, but /healthz did not answer within 150s (Fly health check: ${status:-unknown})" >&2
exit 1
