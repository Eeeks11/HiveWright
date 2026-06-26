# ADR: Business OS v1 owner-visible definition of done

Date: 2026-06-26
Status: Accepted for recovery Phase 0

## Context

HiveWright has accumulated useful Business OS substrate: business profile tables, setup/audit profile tables, readiness rows, gaps, recommendations, and governed actions. That is not enough to call the product ready. The owner must be able to open the dashboard and understand which business is being operated, what state its Business OS is in, what is missing, and which action can be converted into governed work.

The recovery definition of done therefore moves from "the code substrate exists" to "the owner can see and act on the Business OS surface."

## Decision

Business OS v1 is not complete unless these owner-visible requirements are true:

1. Business OS discoverability
   - A primary dashboard navigation item named `Business OS` exists.
   - `/business-os` is an owner-visible index of business hives, not an internal implementation page.
   - Business hives link to the command view or setup/audit CTA from the index.

2. Business hive status inventory
   - `/api/hives` returns a `businessOs` status object for every hive whose `kind` is `business`.
   - Non-business hives return `businessOs: null`.
   - Business hives without a Business OS profile are not silently omitted; they are marked `setup_required` with a setup/audit href.

3. Missing profile handling
   - `/api/hives/:id/business-os-dashboard` must not return a bare 404 for a business hive with no `business_os_profiles` row.
   - It must return an owner-facing setup/audit CTA explaining that the Business OS has not been initialized.

4. Action conversion contract
   - Active Business OS actions must expose enough contract for a later workflow to convert them into governed work: expected outcome, measurement metric, and whether owner approval is required.
   - A visible label should make the intent explicit: `Convert to governed work`.

5. Honest evidence state
   - Empty readiness rows mean unknown evidence, not health.
   - The owner UI should prefer `unknown/setup required/audit required` over blank sections or false-positive green states.

## Consequences

- Phase 0 adds failing acceptance tests first, then the minimum harness and placeholder surfaces needed to make those tests pass.
- Full setup/audit workflows, action execution conversion, and rich Business OS UI are intentionally downstream recovery cards.
- Future Business OS work should preserve these acceptance tests; adding deeper functionality without preserving owner-visible discoverability is a regression.
