# Shared problem semantics and embedded Python API

- Status: draft
- Last updated: 2026-03-23
- Related specs:
  - `docs/specs/capability-matrix-v0.md`
  - `docs/plans/completed/phase-0-1-implementation-plan.md`

## 1. Problem statement

Fullmag needs a shared problem description that stays physically meaningful across FDM, FEM, and hybrid execution.
The public authoring surface therefore cannot be a grid API or a FEM-specific mesh API.

## 1.1 Three-layer model

The project maintains an explicit separation between three levels of implementation depth:

| Layer | Scope | Example |
|-------|-------|---------|
| **Shared semantics** | Python API + `ProblemIR` + validation + planning. Legal to author, serialize, validate, and plan. | `Demag`, `InterfacialDMI`, `Zeeman`, `FEM`, `Hybrid` |
| **Internal reference** | Numerically implemented inside a Rust crate as a reusable numerical baseline, whether or not a public runner exists yet. | Exchange stencil and Heun stepping primitives in `fullmag-engine` |
| **Public executable** | Fully wired: `Simulation.run()` → plan → runner → engine → artifacts. End-to-end in CI. | `Exchange + LLG(heun) + Box + fdm/strict` |

This model prevents the public API surface from silently implying more execution capability than
actually exists. The capability matrix (`docs/specs/capability-matrix-v0.md`) tracks the status
of every feature across these three tiers.

## 2. Physical model

The shared layer represents:

- geometry,
- regions,
- materials,
- ferromagnets,
- energy terms,
- dynamics,
- sampling,
- discretization hints.

It does **not** represent:

- Cartesian cell indexing,
- GPU array layout,
- MFEM-specific spaces,
- backend-only solver internals.

## 3. Numerical interpretation

### 3.1 FDM

The shared problem lowers into voxelization, cell-centered fields, and FFT-based or local operators.

### 3.2 FEM

The shared problem lowers into mesh generation or import, field spaces, and operator assembly/evaluation.

### 3.3 Hybrid

The shared problem lowers into explicitly coupled representations where some operators act on FEM spaces and others act on auxiliary Cartesian grids.

## 4. API, IR, and planner impact

- Python is the only public authoring surface.
- Python objects serialize directly into `ProblemIR`.
- Rust validates and plans canonical IR; it does not infer intent from Python source text.
- `strict`, `extended`, and `hybrid` are explicit validation and planning states.
- The preferred script contract is `build() -> Problem`; a top-level `problem` object is accepted as a compatibility entrypoint.
- `ProblemMeta` must capture Python-facing provenance: `script_language`, `script_source`, `script_api_version`, `serializer_version`, `entrypoint_kind`, and `source_hash`.
- The Rust/Python seam is private. Public classes stay pure Python, while `_fullmag_core` is reserved for validation and runner bindings only.

## 4.1 Bootstrap decisions frozen in this milestone

- The canonical public surface is split into `model` and `runtime`.
- Shared `model` objects are `Problem`, `ImportedGeometry`, `Material`, `Region`, `Ferromagnet`, energy terms, `LLG`, outputs, and discretization hints.
- Shared `runtime` objects are `Simulation`, backend target selection, execution mode selection, execution precision selection, and result handles.
- Planning-only smoke coverage must pass for `fdm/strict`, `fem/strict`, and `hybrid/hybrid`.
- Any change to the shared physics-facing surface must ship with a same-diff update under `docs/physics/`.

## 5. Validation strategy

- confirm that the same Python-authored problem serializes deterministically,
- confirm Rust can deserialize and validate the canonical IR,
- confirm planning summaries are legal for `fdm`, `fem`, and `hybrid`,
- confirm hybrid mode cannot be requested accidentally.

## 6. Completeness checklist

- [x] Python API (shared semantics layer)
- [x] ProblemIR (shared semantics layer)
- [x] Planner-facing validation (shared semantics layer)
- [x] Capability matrix with three-tier statuses
- [x] FDM backend (narrow public-executable slice)
- [ ] FEM backend (deferred to Phase 2)
- [ ] Hybrid backend (deferred to Phase 2+)
- [x] Outputs / observables (canonical names + scheduled `m`/`H_ex` artifacts)
- [x] Tests / smoke flow
- [x] Documentation

## 7. Known limits and deferred work

- The current public runtime is intentionally narrow: Box + one ferromagnet + Exchange + LLG(heun) + `fdm/strict` + `precision="double"`.
- Backend execution depth is intentionally deferred until the shared semantics are stable.
- The private PyO3 module is a seam, not yet the full hosted execution stack.
- The public API exports `Demag`, `InterfacialDMI`, `Zeeman`, `FEM`, `Hybrid` — all semantic-only.
  These are intentionally present for IR completeness and planning validation, but must not imply
  numerical execution capability. The three-tier model (§1.1) makes this distinction explicit.
