#!/bin/sh
# Fake `npx` for the macOS/Linux e2e, copied to <fakebin>/npx next to the
# fake bun, so scheduled runs never reach a real npx (and the network). They
# get here only when bun cannot run ccusage: see `no-bun-x` in fake-bun.sh.
# Like real npx it insists on `-y ccusage@^...`, then execs node in place.
# (Windows uses fake-npx.mjs behind an npx.cmd batch file.)
#
# Every call is appended to <fakebin>/calls.log.
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s npx pid=%s ppid=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$PPID" "$*" >>"$dir/calls.log"

case "$1 $2" in
  "-y ccusage@^"*) ;;
  *)
    echo "fake npx: unexpected invocation: $*" >&2
    exit 1
    ;;
esac
shift 2
exec node "$dir/fake-ccusage.mjs" "$@"
