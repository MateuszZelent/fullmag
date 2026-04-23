# ADR 0012: Canonicalization Backbone for Cross-Layer Contract Integrity

- Status: accepted
- Date: 2026-04-23
- Supersedes: none
- Related:
  - `docs/adr/0011-resource-first-api.md`
  - `docs/specs/fullmag-application-architecture-v2.md`
  - `docs/specs/session-run-api-v1.md`
  - `docs/specs/resource-first-control-room-api-v1.md`

## Context

Fullmag architecture already defines one semantic spine (`ProblemIR` + resource-first control room).
The major delivery risk is drift between layers:

- Python and UI authoring express similar intent differently,
- runtime lifecycle and UI status are not always backed by one typed model,
- heavy data access can leak through non-canonical paths,
- mesh semantics can diverge between authoring, planner, and runtime projections,
- frontend capability behavior can fall back to local heuristics instead of API truth.

Without hard boundary governance, each feature can add new translations and hidden exceptions.

## Decision

Adopt a Canonicalization Backbone Program with explicit frozen boundaries and CI guardrails.

1. `ProblemIR` is versioned and migration-aware (`ir_version` policy).
2. Session/stage lifecycle and command completion use one typed contract.
3. Resource-first revisions are independent by family and drive caching/invalidation.
4. Mesh round-trip semantics are first-class (universe/per-object/shared-domain).
5. `status.capabilities` is the only frontend gating source.
6. `Viewport3D` unification is downstream of stable contracts, not parallel ad hoc design.

## Consequences

Positive:

- predictable integration between Python, IR, runtime, API, and UI,
- smaller regression surface through explicit gates,
- cleaner rollout/cutover decisions backed by contract tests.

Trade-offs:

- more upfront specification discipline,
- stricter CI and review constraints,
- reduced freedom for quick local shortcuts on frozen boundaries.

## Enforcement

- `contract-guard` workflow is required on pull requests.
- Spec updates are mandatory for boundary contract changes.
- Exception handling uses `docs/reports/23.04.2026/canonicalization/exception_log.md`.
