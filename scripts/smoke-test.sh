#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
API_KEY="${API_KEY:?Set API_KEY to the value from your .env file}"

echo "== Health check =="
curl -sf "${BASE_URL}/healthz"
echo

echo "== Models =="
curl -sf "${BASE_URL}/v1/models" -H "Authorization: Bearer ${API_KEY}"
echo

echo "== Non-streaming chat completion =="
curl -sf "${BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Say PONG and nothing else."}]}'
echo

echo "== Streaming chat completion =="
curl -sf -N "${BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Count from 1 to 5."}],"stream":true}'
echo
