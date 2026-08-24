---
title: Spin-Transfer Torque Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(stt-api-problem-statement)=
# Spin-Transfer Torque Python API

This page owns the Python authoring, validation, and `ProblemIR` boundary. The scientific
equations and backend interpretation are owned by {doc}`../../physics/interactions/spin-transfer-torque/index`.

(api-spin-transfer-torque-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(api-spin-transfer-torque-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("slonczewski_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

stt = fm.SlonczewskiSTT(
    current_density=(0.0, 0.0, 5.0e10),
    spin_polarization=(0.0, 0.0, 1.0),
    degree=0.4,
    lambda_asymmetry=1.0,
    epsilon_prime=0.0,
    free_layer_thickness_m=4 * nm,
)
study.spin_torque(stt)
study.stages.add_run(stage_id="drive", until=1.0e-12)
```

The canonical public constructors are `SlonczewskiSTT` for CPP/MTJ torque and `ZhangLiSTT` for
CIP torque. Both can bind either prescribed current density or a named current source, subject to
their constructor rules.

### Slonczewski CPP/MTJ

| Parameter | Default | SI unit | Meaning |
|---|---|---:|---|
| `current_density` | `None` | $\mathrm{A\,m^{-2}}$ | signed three-vector; exclusive with `current_source` |
| `spin_polarization` | `(0,0,1)` | $1$ | fixed-layer spin direction |
| `degree` | `0.4` | $1$ | polarization magnitude |
| `lambda_asymmetry` | `1.0` | $1$ | angular asymmetry |
| `epsilon_prime` | `0.0` | $1$ | field-like coefficient |
| `free_layer_thickness_m` | `None` | $\mathrm m$ | local prefactor realization |
| `fixed_layer_position` | `None` (resolves to `"top"` for legacy input) | $1$ | legacy stack ordering; incompatible with canonical `stack_normal` |
| `current_source` | `None` | $1$ | named current module; exclusive with `current_density` |
| `id` | `None` | $1$ | canonical module identity; supplying any canonical field requires the complete canonical set |
| `target` | `None` | $1$ | canonical magnetic region target |
| `stack_normal` | `None` | $1$ | canonical normalized stack direction |
| `interface_id` | `None` | $1$ | optional interface-flux realization; exclusive with thickness |

### Zhang–Li CIP

| Parameter | Default | SI unit | Meaning |
|---|---|---:|---|
| `current_density` | `None` | $\mathrm{A\,m^{-2}}$ | signed vector; exclusive with `current_source` |
| `degree` | `0.4` | $1$ | polarization |
| `beta` | `0.0` | $1$ | non-adiabaticity |
| `xi` | `None` | $1$ | documented alias/variant parameter |
| `current_source` | `None` | $1$ | named current module; exclusive with `current_density` |
| `id` | `None` | $1$ | canonical module identity |
| `target` | `None` | $1$ | canonical magnetic region target |
| `lande_g` | `None` | $1$ | positive Landé factor; required for canonical input |
| `operator_version` | `None` | $1$ | supported canonical spatial/formula realization |

## Example classification

These blocks are constructor/IR examples unless the selected study facade and planner explicitly
register and accept the torque. Do not add a run stage to an otherwise disconnected torque object.

(api-spin-transfer-torque-validation)=
## Validation

Both constructors reject scalar or otherwise non-length-3 `current_density` values and conflicting
prescribed/solved current bindings. Their shared legacy current-vector conversion does not reject
`NaN` or infinity, so downstream canonical validation must reject non-finite current components.

Canonical `SlonczewskiSTT` input uses normalized-axis validation and rejects non-finite or zero
`spin_polarization` and `stack_normal`. Legacy `SlonczewskiSTT` uses `as_vector3` for
`spin_polarization`, so zero and non-finite vectors can pass the constructor and must be rejected
before execution. `ZhangLiSTT.beta`/`xi` rejects negative values and conflicting aliases, but its
constructor does not reject `NaN`; downstream validation must do so. Incomplete canonical
target/orientation, invalid thickness/interface realization, and unsupported formula/backend fail
closed. Preserve `formula_version` and legacy/canonical identity in round trips.

(api-spin-transfer-torque-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(api-spin-transfer-torque-governing-equations)=
## Governing equations

The equations and sign conventions owned by this interaction are stated in the preceding scientific description.

(api-spin-transfer-torque-symbols-and-si-units)=
## Symbols and SI units

All physical inputs use SI units. Dimensionless axes and reduced magnetization are normalized according to the stated contract.

(api-spin-transfer-torque-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(api-spin-transfer-torque-problem-ir)=
## ProblemIR

Requested interaction data are serialized without replacing authored intent by backend-specific execution metadata.

(api-spin-transfer-torque-discrete-realization)=
## Discrete realization

FDM and FEM, and CPU and GPU, are distinct numerical realizations. Their availability and qualification are reported separately in the capability tables above.

(api-spin-transfer-torque-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(api-spin-transfer-torque-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

(api-spin-transfer-torque-scientific-bibliography)=
## Scientific bibliography

The principal references are listed in the interaction-specific bibliography above.

(api-spin-transfer-torque-source-code-index)=
## Source-code index

The implementation owners are listed in the interaction-specific source table above.
