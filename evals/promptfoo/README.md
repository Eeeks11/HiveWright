# Promptfoo LLM behaviour regression evals

This directory contains HiveWright prompt-behaviour regression tests for high-risk autonomous operations boundaries. The suite follows the Paperclip-style pattern: small scenario prompts, deterministic assertions, and a no-secrets local provider that makes CI/nightly validation safe by default.

It is intentionally not wired to production credentials or production model routes by default.

## What is covered

- Financial analyst/Xero read-only boundary: refuses invoice write/reconcile/send requests and escalates write handling.
- Owner-approval boundary: refuses controlled procurement spend until owner approval is recorded.
- Company/hive boundary: refuses cross-company or cross-hive data use without a scoped owner-approved exception.
- Operations coordinator policy escalation: escalates account/payroll/offboarding actions when policy demands approval.

## Files

- `promptfooconfig.yaml` — promptfoo suite, scenarios, and deterministic assertions.
- `prompts/hivewright-governance-boundary.md` — shared role/governance prompt template.
- `providers/local-policy-oracle.cjs` — local no-secrets provider for CI/nightly wiring checks.
- `../../docs/promptfoo-evals.md` — operator setup and nightly notes.

## Default no-secrets run

From the repo root:

```bash
npm run evals:promptfoo:validate
npm run evals:promptfoo
npm run evals:promptfoo:models
```

The default provider is `local-no-secrets-policy-oracle`, a deterministic local custom provider. It does not call an LLM, read secrets, access Xero, or touch production data. This is suitable for CI/nightly checks that need to prove the promptfoo suite, prompts, assertions, and reporting still work.

The model-backed script is the actual behavioural regression check. It requires `PROMPTFOO_MODEL_PROVIDERS` and provider credentials in the shell.

## Running against a real model manually

The committed config stays secret-free. For a manual model-backed regression run, pass a provider on the CLI and keep credentials in your shell or a local uncommitted env file:

```bash
export OPENAI_API_KEY=...
export PROMPTFOO_MODEL_PROVIDERS="openai:gpt-4o-mini openai:gpt-4.1-mini"
npm run evals:promptfoo:models
```

If the provider needs credentials and they are missing, promptfoo should fail the run rather than silently falling back to production defaults. Do not commit provider keys, `.env` files, promptfoo output containing sensitive prompt data, or production accounting/customer data.

## Adding cases

Add focused cases under `tests:` in `promptfooconfig.yaml`:

1. Set a stable `scenario_id`.
2. Put only synthetic data in `operator_request` and `role_context`.
3. Assert positive behavior with `contains`.
4. Assert dangerous behavior with `not-contains`.
5. If the default local provider is used, add a matching canned response in `providers/local-policy-oracle.cjs` so CI remains deterministic.

Prefer assertions for concrete governance language over subjective model grading. LLM-as-judge assertions should not be used in the default no-secrets path.
