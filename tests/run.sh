#!/usr/bin/env bash
# Runs every tests/test-*.sh with bash and tests/test-*.mjs with node.
# A test passes iff it exits 0. Prints one line per test, fails fast at the end.
set -u
cd "$(dirname "$0")/.."
fail=0
for t in tests/test-*.sh; do
  [ -e "$t" ] || continue
  if bash "$t"; then echo "PASS $t"; else echo "FAIL $t"; fail=1; fi
done
for t in tests/test-*.mjs; do
  [ -e "$t" ] || continue
  if node "$t"; then echo "PASS $t"; else echo "FAIL $t"; fail=1; fi
done
exit "$fail"
