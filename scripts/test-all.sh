#!/usr/bin/env bash
# Phase 10: run BOTH runtimes' full test suites with one command.
# See docs/TESTING.md for setup (a live Postgres is required — most tests
# in both suites are real-database integration tests by design).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> TypeScript suite (apps/web, Vitest)"
npm run test -w apps/web

echo ""
echo "==> Python suite (services/voice-gateway, pytest)"
if [ ! -d "services/voice-gateway/.venv" ]; then
  echo "services/voice-gateway/.venv not found — see docs/TESTING.md setup steps." >&2
  exit 1
fi
(
  cd services/voice-gateway
  # shellcheck disable=SC1091
  source .venv/bin/activate
  python -m pytest -q
)

echo ""
echo "==> Both suites passed."
