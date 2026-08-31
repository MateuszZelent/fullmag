---
title: Magnetoelastic Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(magnetoelastic-api-problem-statement)=
# Magnetoelastic Python API

This page owns the Python authoring, validation, and `ProblemIR` boundary. The scientific
equations and backend interpretation are owned by {doc}`../../physics/interactions/magnetoelastic/index`.

(api-magnetoelastic-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(api-magnetoelastic-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("magnetoelastic_authoring_boundary")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# The current stage facade does not yet attach the complete mechanics graph.
elastic = fm.ElasticMaterial(name="substrate_material", C11=1.66e11, C12=6.39e10, C44=7.96e10, rho=2329.0)
substrate_geometry = fm.Box(40 * nm, 20 * nm, 4 * nm, name="substrate_geometry")
substrate = fm.ElasticBody(name="substrate", geometry=substrate_geometry, elastic_material=elastic)
law = fm.MagnetostrictionLaw(name="cubic_b1_b2", kind="cubic", B1=2.4e6, B2=3.1e6)
load = fm.MechanicalLoad(kind="prescribed_strain", strain=(1.0e-4, 0.0, 0.0, 0.0, 0.0, 0.0))
coupling = fm.Magnetoelastic(magnet="film", body=substrate.name, law=law.name)
study.stages.add_run(stage_id="authoring_boundary", until=1.0e-15)
```

This is an **IR construction example**. The audited stage builder does not expose a complete
end-to-end mechanics registration workflow, so the page must not claim that this block runs a
coupled simulation.

## Parameter corrections

| Object | Parameters | Required validation |
|---|---|---|
| `ElasticMaterial` | `C11,C12,C44,rho` | finite; $\rho>0$; cubic stability $C_{44}>0$, $C_{11}-C_{12}>0$, $C_{11}+2C_{12}>0$ |
| `MagnetostrictionLaw` | `B1,B2` or `lambda_s` | finite; exact supported law kind |
| `MechanicalLoad` | engineering-Voigt `strain` or `stress` | exactly six finite values; one supported load kind |
| `Magnetoelastic` | `magnet,body,law` | non-empty, unique, resolvable graph references |

The current positivity rule for `C12` is not the physical cubic stability condition. The current
finite checks for law and load coefficients are incomplete.

(api-magnetoelastic-problem-ir)=
## Lowering

```json
{"kind": "magnetoelastic", "magnet": "magnetic_film", "body": "elastic_film", "law": "b1b2"}
```

The law, body, material, load, and strain convention remain separate typed records.

## Executable subset

Only cubic $B_1/B_2$ prescribed strain is currently an executable FEM subset. Isotropic
`lambda_s`, displacement solves, two-way coupling, and elastodynamics must fail closed until
their complete graph and runtime exist.

(api-magnetoelastic-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(api-magnetoelastic-governing-equations)=
## Governing equations

The equations and sign conventions owned by this interaction are stated in the preceding scientific description.

(api-magnetoelastic-symbols-and-si-units)=
## Symbols and SI units

All physical inputs use SI units. Dimensionless axes and reduced magnetization are normalized according to the stated contract.

(api-magnetoelastic-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(api-magnetoelastic-discrete-realization)=
## Discrete realization

FDM and FEM, and CPU and GPU, are distinct numerical realizations. Their availability and qualification are reported separately in the capability tables above.

(api-magnetoelastic-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(api-magnetoelastic-validation)=
## Validation

Validation must cover units, signs, energy/field or torque consistency, discretization convergence, boundary behavior, and lane-specific CPU/GPU evidence.

(api-magnetoelastic-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

(api-magnetoelastic-scientific-bibliography)=
## Scientific bibliography

The principal references are listed in the interaction-specific bibliography above.

(api-magnetoelastic-source-code-index)=

## Control Room crosswalk

Status: Interaction selection is partial; only fields advertised by the current physics panel are UI-supported.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Objects -> <object> -> Physics` | `partial` | Apply physics draft; solver/stage resources are invalidated |
| Parameters without a named UI field | `Model Explorer -> Objects -> <object> -> Physics` | `not implemented` | Python-only until implemented |

Frontend support is not implemented for interaction-specific parameters absent from `PhysicsInteractionPanel`.
See [Control Room capability register](/frontend/capability-register) for the support matrix and explicit not-implemented status.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx (PhysicsInteractionPanel)`.

## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

## Source-code index

The implementation owners are listed in the interaction-specific source table above.

