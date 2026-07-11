# Problem IR Compatibility v1

- Status: canonical compatibility policy for `ProblemIR`
- Last updated: 2026-04-23
- Parent architecture: `docs/specs/fullmag-application-architecture-v2.md`
- Program ADR: `docs/adr/0012-canonicalization-backbone.md`

## 1. Purpose

This spec defines versioning, read compatibility, and migration policy for `ProblemIR`.

## 2. Version Signals

- canonical current version: `CURRENT_IR_VERSION`
- wire field: `ProblemIR.ir_version`
- read support list: `SUPPORTED_READ_IR_VERSIONS`

## 3. Compatibility Matrix

| Producer | Version | Consumer | Supported | Notes |
|---|---|---|---|---|
| Python exporter | current | planner/runtime | yes | canonical write path |
| UI exporter | current | planner/runtime | yes | canonical write path |
| saved payload | previous supported | planner/runtime | read-only via migration | transitional read support |
| saved payload | unsupported | planner/runtime | no | validation error |

## 4. Rules

- New public semantics that alter meaning require a version bump.
- Removing a public field requires at least one supported read-compat path.
- Writer paths emit only the current canonical version.
- Python and UI must not emit divergent semantic structures for the same intent.

## 5. Canonical Serialization Rules

- deterministic field ordering in fixtures,
- no UI-only transport artifacts in canonical payloads,
- no semantic dependence on omitted-vs-null ambiguity.

## 6. Golden Corpus Policy

Golden fixtures must cover at least:

- FDM minimal and FEM minimal,
- mixed object/primitives scenarios,
- per-object mesh configuration semantics,
- multi-stage execution intent,
- migration read cases for supported previous versions.

## 7. Relaxation Compatibility

Canonical writers emit `StudyIR::Relaxation` with `algorithm`, algorithm-specific
optional `dynamics`, `stop: RelaxStopIR`, and `sampling`. `dynamics` is required
only for `llg_overdamped`; direct minimizers reject it. Compatibility aliases
for scalar torque/energy/max-step fields and the historical
`max_pseudotime_s`/`max_physical_time_s` Python spellings may be read and
normalized to `RelaxStopIR.max_relaxation_time_s`, but canonical writers emit
only the current shape. That time limit is legal only for `llg_overdamped`.

Defaults are semantic and cross-surface: `torque_tolerance_apm=1e-4` in `A/m`
and `max_steps=50000`. A direct-minimizer line-search step has unit `m/A` and
must never be migrated into `dt`, seconds, physical time, or pseudo-time.

Persisted completion payloads preserve execution-owned `status`, `converged`,
stop reason, typed metric/value/unit, and threshold. Readers must not infer
convergence from a terminal-looking artifact, a final sample, nonzero time, or
the presence of `max_torque_T`. `max_torque_Apm` is the canonical accepted-state
field residual in `A/m`; `max_torque_T` is the equivalent value in `T`, and
`max_rhs_norm_per_s` remains a separate dynamic observable in `1/s`.

`tangent_plane_implicit` remains a CPU/MFEM development-only identifier.
Strict mode and forced GPU reject it. Extended mode may resolve it only to the
CPU/MFEM development lane with explicit requested/resolved provenance; no
hidden GPU-to-CPU fallback is a compatible interpretation.
