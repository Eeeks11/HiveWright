# Promptfoo evals

HiveWright includes promptfoo regression evals for role/governance prompt behaviour under `evals/promptfoo`.

## Purpose

These evals guard high-risk autonomous-ops boundaries where a role must refuse or escalate instead of taking action:

- Xero and finance write actions from read-only roles.
- Controlled spend or company-binding actions without owner approval.
- Cross-company/cross-hive data boundary requests.
- Operations coordinator actions blocked by explicit policy approval requirements.

The default suite is deterministic and secret-free so it can run in CI/nightly without touching production systems.

## Commands

```bash
npm run evals:promptfoo:validate
npm run evals:promptfoo
npm run evals:promptfoo:models
```

`evals:promptfoo:validate` validates the promptfoo config.

`evals:promptfoo` runs the suite with:

- `--config evals/promptfoo/promptfooconfig.yaml`
- `--no-cache`
- `--no-share`
- output written to `evals/promptfoo/results/latest.json`

The committed default provider is `local-no-secrets-policy-oracle` from `evals/promptfoo/providers/local-policy-oracle.cjs`. It returns deterministic compliant responses for the scenarios and does not call any external model.

`evals:promptfoo:models` runs the same assertions against one or more real model providers from `PROMPTFOO_MODEL_PROVIDERS`. This is the run that catches prompt-compliance regressions after role/SOUL/policy edits. The local run only proves the harness and deterministic assertions are wired correctly.

## Secrets and production data

Do not put secrets in promptfoo config, prompts, fixtures, results, or GitHub Actions workflow files.

The default local provider requires no environment variables. It does not read:

- `DATABASE_URL`
- `ENCRYPTION_KEY`
- `INTERNAL_SERVICE_TOKEN`
- Xero credentials
- LLM API keys

Use synthetic company, invoice, vendor, payroll, and hive examples only.

## Manual model-backed runs

For an actual LLM-behaviour check, set providers and credentials outside the repo:

```bash
export OPENAI_API_KEY=...
export PROMPTFOO_MODEL_PROVIDERS="openai:gpt-4o-mini openai:gpt-4.1-mini"
npm run evals:promptfoo:models
```

`PROMPTFOO_MODEL_PROVIDERS` is intentionally explicit. Use cheap/capable models for nightly regression and add stronger models for manual release-readiness checks.

If the selected provider requires credentials and they are missing, the run should fail. That fail-closed behavior is intentional; do not add fallback production credentials or silently swap to a different provider.

## Nightly usage

`.github/workflows/promptfoo-nightly.yml` runs the secret-free provider nightly and on manual dispatch. If `OPENAI_API_KEY` is present in repository secrets, it also runs the model-backed suite with `PROMPTFOO_MODEL_PROVIDERS` from repository variables or the workflow default. It uploads JSON result artifacts for inspection.

The local job must remain secret-free. Model-backed nightly checks must fail closed when configured credentials are missing or invalid; do not add fallback production credentials or silently swap to another provider.

## Interpreting failures

A failure usually means one of three things:

1. The prompt template changed and no longer includes the governance context needed by the assertions.
2. The local oracle response no longer matches the deterministic assertions.
3. A model-backed manual run produced unsafe behaviour, such as claiming a controlled action was completed or failing to escalate.

For model-backed failures, tighten the relevant role/governance prompt first, then add or update deterministic assertions so the boundary remains covered.
