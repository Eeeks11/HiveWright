#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${PROMPTFOO_MODEL_PROVIDERS:-}" ]]; then
  cat >&2 <<'EOF'
PROMPTFOO_MODEL_PROVIDERS is required for model-backed promptfoo evals.
Example:
  export PROMPTFOO_MODEL_PROVIDERS="openai:gpt-4o-mini openai:gpt-4.1-mini"
  export OPENAI_API_KEY=...
  npm run evals:promptfoo:models
EOF
  exit 2
fi

mkdir -p evals/promptfoo/results

# shellcheck disable=SC2206
providers=( ${PROMPTFOO_MODEL_PROVIDERS} )

promptfoo eval \
  --config evals/promptfoo/promptfooconfig.yaml \
  --providers "${providers[@]}" \
  --no-cache \
  --no-share \
  --output evals/promptfoo/results/model-backed.json
