---
title: Inter-region couplings Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-interactions-inter-region-couplings)=
# Inter-region couplings Python API

This page owns the Python authoring, validation, and `ProblemIR` boundary. The scientific
equations and backend interpretation are owned by {doc}`../../physics/interactions/inter-region-couplings/index`.

(api-inter-region-couplings-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(api-inter-region-couplings-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("region_exchange_reference")
study.engine("fdm")
study.device("cuda", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

left = body.add_region("left", fm.Box(20 * nm, 20 * nm, 4 * nm).translate((-10 * nm, 0.0, 0.0)))
right = body.add_region("right", fm.Box(20 * nm, 20 * nm, 4 * nm).translate((10 * nm, 0.0, 0.0)))
study.couplings.exchange(source=left, target=right, mode="explicit", inter_exchange=13.0e-12)
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", max_steps=500, tolT=1.0e-6)
```

The surface forms remain IR/export examples, not executable stages at the audited revision.

## Parameter reference

| API | Parameter | Default | SI unit | Validation |
|---|---|---|---:|---|
| `exchange` | `source,target` | required | $1$ | valid region endpoints for executable subset |
| `exchange` | `mode` | `"harmonic_mean"` | $1$ | harmonic_mean / explicit / disabled |
| `exchange` | `scale` | `None` | $1$ | finite, non-negative, mode-consistent |
| `exchange` | `inter_exchange` | `None` | $\mathrm{J\,m^{-1}}$ | finite; required for explicit; planner currently requires non-negative |
| `rkky` | `J1` | required | $\mathrm{J\,m^{-2}}$ | finite and signed; surface endpoints |
| `interlayer_exchange` | `J1,J2` | required/`None` | $\mathrm{J\,m^{-2}}$ | finite and signed; surface endpoints |
| all | `coupling_id` | derived | $1$ | non-empty and unique |
| all | `enabled` | `True` | $1$ | boolean |
| all | `capability_policy` | `"require_runtime"` | $1$ | require_runtime / authored_only |

## Runtime boundary

Only FDM GPU region-to-region exchange is materialized. FDM CPU and both FEM lanes reject enabled
runtime couplings. RKKY/interlayer surface terms are authored-only on every lane.

(api-inter-region-couplings-validation)=
## Validation boundary

Generated coupling identifiers are non-empty by construction. A supplied `coupling_id` is checked
for non-empty content when the coupling is serialized, and duplicate identifiers are rejected when
the complete `Problem` is validated. Endpoint kind is preserved in export; surface terms are never
coerced into region links.

(api-inter-region-couplings-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(api-inter-region-couplings-governing-equations)=
## Governing equations

The equations and sign conventions owned by this interaction are stated in the preceding scientific description.

(api-inter-region-couplings-symbols-and-si-units)=
## Symbols and SI units

All physical inputs use SI units. Dimensionless axes and reduced magnetization are normalized according to the stated contract.

(api-inter-region-couplings-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(api-inter-region-couplings-problem-ir)=
## ProblemIR

Requested interaction data are serialized without replacing authored intent by backend-specific execution metadata.

(api-inter-region-couplings-discrete-realization)=
## Discrete realization

FDM and FEM, and CPU and GPU, are distinct numerical realizations. Their availability and qualification are reported separately in the capability tables above.

(api-inter-region-couplings-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(api-inter-region-couplings-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

(api-inter-region-couplings-scientific-bibliography)=
## Scientific bibliography

The principal references are listed in the interaction-specific bibliography above.

(api-inter-region-couplings-source-code-index)=
## Source-code index

The implementation owners are listed in the interaction-specific source table above.
