#!/bin/sh
# Fake `bun` for the macOS/Linux e2e, copied to <fakebin>/bun and put first on
# PATH, so `bun x ccusage@... <source> <daily|session> ...` lands here. Real
# `bun x` execs ccusage's node bin in place (same pid), so this does too: a
# signal the CLI sends its ccusage child reaches node, exactly as it would in
# production. (Windows has no exec; it uses the compiled fake-bun.ts.)
#
# Every call is appended to <fakebin>/calls.log.
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s bun pid=%s ppid=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$PPID" "$*" >>"$dir/calls.log"

# <fakebin>/hang makes every call hang the way npx does when the network
# black-holes: this shell stays the parent of a child that never exits (no
# exec), so only killing the whole process group stops it.
if [ -f "$dir/hang" ]; then
  sleep 86399
  exit 1
fi

if [ "$1" != x ]; then
  echo "fake bun: unsupported invocation: $*" >&2
  exit 1
fi
shift
while [ $# -gt 0 ]; do
  case "$1" in
    ccusage*)
      shift
      exec node "$dir/fake-ccusage.mjs" "$@"
      ;;
  esac
  shift
done
echo "fake bun: unsupported invocation: no ccusage package" >&2
exit 1
