#!/usr/bin/env bash
#
# Daily self-check: curls the server's /admin/self-check endpoint through the
# public origin URL — one request exercises Caddy, TLS, the container, and the
# app's own health checks together — and forwards the verdict to
# healthchecks.io:
#
#   HTTP 200        → success ping.
#   anything else   → the response body is POSTed to the check's /fail URL, so
#                     the alert email carries the actual failure detail
#                     (including "unreachable" when only the app or Caddy is
#                     down while the host cron still runs).
#   host dead       → this cron never fires, no ping arrives, healthchecks
#                     alerts on the silence. That's the dead-man's switch.
#
# Needs LOOM_ADMIN_TOKEN (an lca_ admin token, created in the admin panel
# under Settings → API Keys) and HC_SELFCHECK_URL in
# ~/.config/loom-clone-ops.env. See docs/developer/operations.md.

set -uo pipefail # no -e: failures are handled explicitly below

OPS_ENV="$HOME/.config/loom-clone-ops.env"
if [[ ! -f "$OPS_ENV" ]]; then
  echo "ERROR: $OPS_ENV not found" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$OPS_ENV"
: "${LOOM_ADMIN_TOKEN:?LOOM_ADMIN_TOKEN missing from $OPS_ENV}"
: "${HC_SELFCHECK_URL:?HC_SELFCHECK_URL missing from $OPS_ENV}"

SELF_CHECK_URL="${SELF_CHECK_URL:-https://origin.v.danny.is/admin/self-check}"

body_file=$(mktemp)
trap 'rm -f "$body_file"' EXIT

http_code=$(curl -sS -m 30 \
  -H "Authorization: Bearer $LOOM_ADMIN_TOKEN" \
  -o "$body_file" -w '%{http_code}' \
  "$SELF_CHECK_URL" || true)

if [[ "$http_code" == "200" ]]; then
  curl -fsS -m 10 --retry 5 "$HC_SELFCHECK_URL" > /dev/null
else
  echo "self-check returned HTTP ${http_code:-000}" >&2
  # healthchecks.io keeps the POSTed body (capped well under its 100 KB limit)
  # and includes it in the alert email.
  {
    echo "HTTP ${http_code:-000} from $SELF_CHECK_URL"
    cat "$body_file"
  } | head -c 90000 | curl -fsS -m 10 --retry 5 --data-binary @- "$HC_SELFCHECK_URL/fail" > /dev/null
  exit 1
fi
