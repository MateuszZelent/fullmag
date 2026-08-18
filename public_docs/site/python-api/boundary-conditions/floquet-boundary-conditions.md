---
title: Floquet Boundary Conditions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-boundary-conditions-floquet-boundary-conditions)=
# Floquet Boundary Conditions

(python-api-boundary-conditions-floquet-boundary-conditions-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Floquet boundary conditions attach a phase convention to periodic mesh pairs for spin-wave
problems.

(python-api-boundary-conditions-floquet-boundary-conditions-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Floquet phase semantics belong to {doc}`../../numerical-methods/frequency-domain/floquet-response`.

(python-api-boundary-conditions-floquet-boundary-conditions-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
The phase convention is a policy identifier; pair ids are names.

(python-api-boundary-conditions-floquet-boundary-conditions-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
At least one pair id and a non-empty phase convention are required.

(python-api-boundary-conditions-floquet-boundary-conditions-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `FloquetBC.pair_ids` | `Sequence[str]` | `required` | Non-empty | Phase-linked pairs | `spin_wave_bc` |
| `FloquetBC.phase_convention` | `str` | `"exp_minus_i_k_dot_delta_r"` | Non-empty | Phase convention | `spin_wave_bc.phase_convention` |

### Complete stage-first context

Floquet is supplied as the spin-wave boundary condition of an eigenmode or frequency-response
stage.

```python
# %% Floquet spin-wave boundary condition
import fullmag as fm

nm = 1.0e-9

study = fm.study("floquet_bc_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1000, tolT=1e-8)
study.stages.add_eigenmodes(
    count=4,
    target="lowest",
    equilibrium_source="relax",
    bc=fm.FloquetBC(pair_ids=["x_min", "x_max"], phase_convention="exp_minus_i_k_dot_delta_r"),
)
```

(python-api-boundary-conditions-floquet-boundary-conditions-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`FloquetBC.to_ir()` emits `{"kind": "floquet", "pair_ids": [...],
"phase_convention": ...}` as the `spin_wave_bc` value.

(python-api-boundary-conditions-floquet-boundary-conditions-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Empty pair ids and empty conventions fail immediately.

(python-api-boundary-conditions-floquet-boundary-conditions-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Phase linkage is consumed by the eigensolver/response solver on the periodic mesh pairs.

(python-api-boundary-conditions-floquet-boundary-conditions-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/study.py` (`class FloquetBC`).

(python-api-boundary-conditions-floquet-boundary-conditions-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-boundary-conditions-floquet-boundary-conditions-limitations)=
<!-- (limitations)= -->
## Limitations
Executed Floquet support is backend-dependent; planner resolution is authoritative.

(python-api-boundary-conditions-floquet-boundary-conditions-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Phase-convention references belong to the Floquet response page.

(python-api-boundary-conditions-floquet-boundary-conditions-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Floquet BC | `packages/fullmag-py/src/fullmag/model/study.py` | `class FloquetBC` | BC lowering | Ownership test |
