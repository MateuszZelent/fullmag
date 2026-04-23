# Fullmag Canonicalization Backbone Program (2026-04-23)

- Status: active
- Start date: 2026-04-23
- Owner group: `arch/core`
- Program ADR: `docs/adr/0012-canonicalization-backbone.md`

## Scope

This program is the enforcement layer for one canonical contract across:

- Python authoring,
- `ProblemIR`,
- planner/runtime lifecycle,
- resource-first API,
- browser control room (`Viewport3D`).

It does not replace existing subsystem plans; it gates and sequences them.

## Frozen Boundaries

The following boundaries are frozen unless changes include spec update + owner approval + contract tests:

- `ProblemIR` wire semantics and versioning,
- session/stage lifecycle states and terminal semantics,
- resource-first revision vocabulary and thin-status rule,
- mesh round-trip semantics (universe, per-object, shared-domain),
- frontend capability gating contract (`status.capabilities` as source of truth).

## Owner Matrix

| Boundary | Primary owner | Required reviewer | Mandatory gate |
|---|---|---|---|
| `ProblemIR` | `arch/core` | `py`, `ui/platform` | golden IR parity |
| Lifecycle + completion | `runtime` | `api`, `ui/platform` | lifecycle matrix |
| Resource-first data plane | `api/data` | `runtime`, `ui/platform` | revision contract tests |
| Mesh semantics | `fem/mesh` | `py`, `ui/platform` | mesh round-trip goldens |
| Frontend contracts | `ui/platform` | `api/data` | routing + capability E2E |

## Migration Policy

- Backward read compatibility is required for one previous public `ir_version`.
- Forward writes emit only the current canonical version.
- Any deprecation must include migration notes and fixture coverage.
- Legacy paths may remain transitional, but new usages are CI-blocked.

## Acceptance Gates

A change touching frozen boundaries is mergeable only when all are true:

1. affected spec sections are updated,
2. ownership approvals are present,
3. contract tests are green,
4. `contract-guard` CI is green,
5. rollout/rollback notes are updated when behavior changes.

## Rollback Policy

- Cutovers keep a short rollback window with explicit owner on-call.
- Rollback may restore previous routing/flags but cannot silently alter canonical contracts.
- Every rollback event must be recorded in `exception_log.md` with root cause and follow-up gate.
