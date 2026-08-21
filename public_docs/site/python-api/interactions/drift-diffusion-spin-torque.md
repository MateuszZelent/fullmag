---
title: Drift-diffusion spin torque Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-interactions-drift-diffusion-spin-torque)=
# Drift-diffusion spin torque Python API

This page owns the Python authoring, validation, and `ProblemIR` boundary. The scientific
equations and backend interpretation are owned by {doc}`../../physics/interactions/drift-diffusion-spin-torque/index`.

(api-drift-diffusion-spin-torque-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(api-drift-diffusion-spin-torque-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("spin_transport_authoring_boundary")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

region = fm.RegionRef("film")
spin = fm.SpinDriftDiffusion(
    id="spin",
    current_source_id="charge",
    domain=(region,),
    materials=(fm.SpinTransportMaterialAssignment(
        region,
        fm.SpinTransportMaterial(
            sigma_s_Spm=5.0e6,
            polarization_p=0.2,
            theta_sh=0.1,
            lambda_sf_m=2.0e-9,
            lambda_j_m=1.0e-9,
            lambda_phi_m=1.0e-9,
        ),
    ),),
)
study.spin_transport(spin)
study.spin_torque(fm.DriftDiffusionSpinTorque("transport_torque", spin.id, region))
study.stages.add_run(stage_id="authoring_boundary", until=1.0e-15)
```

The exported canonical classes live in `fullmag.model.spin_transport`. A duplicate placeholder
class named `DriftDiffusionSpinTorque` exists in `spin_torque.py`; remove or rename it. Public
documentation and type checking must bind only the canonical class.

## `SpinDriftDiffusion` parameters

| Parameter | Default | Meaning |
|---|---|---|
| `id` | required | stable solve identity |
| `current_source_id` | required | compatible `CurrentTransport` name |
| `domain` | required non-empty | solved regions |
| `materials` | required non-empty | typed spin-material assignments |
| `interfaces` | `()` | transparent/mixing interface laws |
| `boundaries` | `()` | typed spin boundary conditions |
| `solver` | `SpinSolverPolicy()` | linear/nonlinear policy |
| `requested_execution` | default transport target | strict requested lane |
| `mode` | `"steady"` | `"steady"` or `"transient"` |

Transient mode requires physical spin-capacitance metadata for every material.

## `DriftDiffusionSpinTorque`

| Parameter | Meaning |
|---|---|
| `id` | stable torque-module identity |
| `solve_id` | named accepted spin solve |
| `target` | magnetic region receiving absorbed transverse angular momentum |

## Capability warning

FDM GPU and FEM GPU are semantic-only at the audited revision. CPU M1/M2 support is bounded and
variant-specific. Constructor/IR success is not a generic executable capability.

(api-drift-diffusion-spin-torque-validation)=
## Validation

Require current-source compatibility, material/domain coverage, positive finite transport
coefficients, explicit reaction disabling, gauge and boundary ownership, interface orientation,
M2 Schur positivity, supported operator version, and fail-closed strict execution.

(api-drift-diffusion-spin-torque-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(api-drift-diffusion-spin-torque-governing-equations)=
## Governing equations

The equations and sign conventions owned by this interaction are stated in the preceding scientific description.

(api-drift-diffusion-spin-torque-symbols-and-si-units)=
## Symbols and SI units

All physical inputs use SI units. Dimensionless axes and reduced magnetization are normalized according to the stated contract.

(api-drift-diffusion-spin-torque-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(api-drift-diffusion-spin-torque-problem-ir)=
## ProblemIR

Requested interaction data are serialized without replacing authored intent by backend-specific execution metadata.

(api-drift-diffusion-spin-torque-discrete-realization)=
## Discrete realization

FDM and FEM, and CPU and GPU, are distinct numerical realizations. Their availability and qualification are reported separately in the capability tables above.

(api-drift-diffusion-spin-torque-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(api-drift-diffusion-spin-torque-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

(api-drift-diffusion-spin-torque-scientific-bibliography)=
## Scientific bibliography

The principal references are listed in the interaction-specific bibliography above.

(api-drift-diffusion-spin-torque-source-code-index)=
## Source-code index

The implementation owners are listed in the interaction-specific source table above.
