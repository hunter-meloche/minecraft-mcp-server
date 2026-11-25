#!/usr/bin/env bash
# Restart claudebot (the systemd user service) only when no villager depends on the bot staying up: the brain's
# fetch-safe tool says "safe" unless a villager is being led, the bot is in a step only flight may cut short (a gate
# held open for a villager, a chores visit inside the villager hall), or it stands in the hall or its lock. The
# unit's stop kills the game client with the brain, and the bridge's hold on a gate dies with the client: a gate held
# for a villager then stands open until the bot is back, about 90 s (idle-plan V 3.3, 6.6). Maintenance runs and the
# improvement run restart the bot through this script, not `systemctl --user restart claudebot`.
#
# It asks every 15 s, 10 minutes at most; then it restarts all the same (the harness's /stop runs the brain's exit
# handler first). The harness not answering, a brain that does not answer, or a build without the tool: at once.
#   scripts/safe-restart.sh            (CLAUDEBOT_PORT=7790, SAFE_RESTART_MAX_S=600 by default)
#   scripts/safe-restart.sh --check    (only says what fetch-safe answers; restarts nothing)
set -u
PORT="${CLAUDEBOT_PORT:-7790}"
MAX_S="${SAFE_RESTART_MAX_S:-600}"
EVERY_S=15

ask() { curl -s -m 30 "127.0.0.1:$PORT/call" -d '{"name":"fetch-safe","args":{}}' 2>/dev/null; }

if [ "${1:-}" = "--check" ]; then
  r="$(ask)"
  echo "${r:-the harness does not answer on $PORT}"
  case "$r" in safe*) exit 0 ;; *) exit 1 ;; esac
fi

deadline=$((SECONDS + MAX_S))
while :; do
  r="$(ask)"
  case "$r" in
    safe*) echo "fetch-safe: ${r%%$'\n'*}"; break ;;
    "") echo "the harness does not answer on $PORT: restarting now"; break ;;
    "[harness error]"*) echo "the harness answers but the brain does not (${r%%$'\n'*}): restarting now"; break ;;
    "[error]"*) echo "fetch-safe gave an error (an older build?): ${r%%$'\n'*}: restarting now"; break ;;
  esac
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "still not safe after ${MAX_S}s (${r%%$'\n'*}): restarting all the same (the stop runs the brain's exit handler first)"
    break
  fi
  echo "waiting: ${r%%$'\n'*}"
  sleep "$EVERY_S"
done
exec systemctl --user restart claudebot
