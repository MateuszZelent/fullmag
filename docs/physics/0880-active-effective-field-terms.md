# Active effective-field terms

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-05-16
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/specs/problem-ir-v0.md`, `docs/specs/resource-first-control-room-api-v2.md`, `docs/specs/capability-matrix-v0.md`

## 1. Problem statement

The control room must be able to switch individual contributions to the
micromagnetic effective field on and off before a run is planned. This includes
baseline terms such as exchange and demagnetization. The switch is a physics
authoring decision: a disabled term is absent from the canonical problem passed
to the planner and solver.

It is not a visualization flag, not a solver debug mask, and not a hidden
backend fallback.

## 2. Physical model

### 2.1 Governing equations

For LLG-style dynamics Fullmag uses:

```text
d m / d t = F(m, H_eff)
H_eff = sum_i H_i
```

where each enabled energy-derived term contributes:

```text
H_i = -(1 / (mu0 Ms)) delta E_i / delta m
```

The active effective-field set controls which `E_i` and `H_i` terms exist in
the authored problem. If `exchange_enabled = false`, `E_ex` and `H_ex` are not
part of `H_eff`. If `demag_enabled = false`, `E_demag` and `H_demag` are not
part of `H_eff`.

### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `m` | normalized magnetization | 1 |
| `H_eff` | effective magnetic field | A/m |
| `H_ex` | exchange contribution | A/m |
| `H_demag` | demagnetizing contribution | A/m |
| `E_ex` | exchange energy | J |
| `E_demag` | demagnetizing energy | J |
| `mu0` | vacuum permeability | H/m |
| `Ms` | saturation magnetization | A/m |

### 2.3 Assumptions and approximations

The first control-room slice treats exchange and demag switches as global
problem-level switches. Per-object participation masks for a global demag solve
are deferred because they require a separate field/energy contract and solver
validation. Object interaction entries may mirror the global state for authoring
round-trip, but the planner sees canonical `ProblemIR.energy_terms`.

## 3. Numerical interpretation

### 3.1 FDM

The FDM planner and runner already derive executable operators from
`ProblemIR.energy_terms`. Removing `Exchange` prevents exchange stencil
construction and contribution to `H_eff`. Removing `Demag` prevents FFT/Newell
demag setup and `H_demag` contribution. At least one executable field or torque
source must remain for a meaningful run.

### 3.2 FEM

The FEM/MFEM planner and native runtime derive operator availability from the
same `ProblemIR.energy_terms`. Removing `Exchange` omits the exchange operator.
Removing `Demag` omits Poisson demag setup, solve, recovery, energy, and demag
refresh cadence. MFEM receives resolved operators through the existing plan, not
through an extra UI-only mask.

### 3.3 Hybrid

Hybrid execution must preserve the requested active-term set and reject
unsupported combinations explicitly. No hybrid path may silently re-enable a
disabled term to satisfy a backend implementation.

## 4. API, IR, and planner impact

### 4.1 Python API surface

The flat Python DSL gains explicit active-term controls:

```python
fm.exchange(enabled=False)
fm.demag(enabled=False)
study.exchange(enabled=False)
study.demag(enabled=False, realization="poisson_robin")
```

The default remains exchange and demag enabled to preserve existing scripts.

### 4.2 ProblemIR representation

No new `ProblemIR` variant is required for this slice. Disabled terms are
represented by absence from `ProblemIR.energy_terms`. Requested frontend state is
kept in the SceneDocument/script-builder bridge as `exchange_enabled` and
`demag_enabled` so Python rewrite and UI round-trip do not reintroduce disabled
terms.

### 4.3 Planner and capability-matrix impact

The capability vocabulary remains term-based. A backend supports a run if the
resulting active `energy_terms` set is executable for the requested backend,
device, precision, and execution mode. Unsupported active-term combinations must
fail through the existing planner diagnostics.

## 5. Validation strategy

### 5.1 Analytical checks

Small uniform-state checks should show zero omitted contribution in `H_eff` and
energy outputs for disabled terms. A demag-disabled FEM run must not run Poisson
demag phases.

### 5.2 Cross-backend checks

For common terms, FDM and FEM should produce matching active-term membership in
planning/provenance. Numerical equality is checked only for enabled terms.

### 5.3 Regression tests

- Python flat API: disabled exchange/demag are absent from `energy_terms`.
- SceneDocument/script-builder: disabled term switches survive round-trip and
  rewrite overrides.
- Control room model: exchange and demag are study-level switches and emit
  `study.exchange_enabled` / `study.demag_enabled` patches.
- v2 API: object interaction `enabled` remains serializable for existing
  optional object-local interactions.

### 5.4 Runtime audit

The FDM and FEM planners already derive `enable_exchange` and `enable_demag`
from `ProblemIR.energy_terms`. The native MFEM bridge receives those resolved
flags and gates exchange/demag field and energy assembly on them. This slice
therefore changes authoring and round-trip state only; it does not add a new
native backend mask.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend runtime audit
- [x] FEM backend runtime audit
- [ ] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

## 7. Known limits and deferred work

Per-object demag participation masks are intentionally deferred. The current
contract is global term enablement. The UI should label exchange/demag as
effective-field term switches instead of implying a per-object demag solver mask.

Runtime provenance should later expose the active effective-field term set
explicitly next to requested/resolved backend state.

## 8. References

- `docs/physics/0400-fdm-exchange-demag-zeeman.md`
- `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
- `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
