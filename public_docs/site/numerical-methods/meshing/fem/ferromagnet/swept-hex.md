---
title: "Swept-hexahedral ferromagnet mesh"
description: "Serialized hex8 controls and their current fail-closed boundary."
summary: "Hex vocabulary exists, but swept-hex execution is unsupported and cannot fall back to prisms or tetrahedra."
status: unsupported
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 969efa0941905825ac569d525f4bdaefc059e2af
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-swept-hex)=
# Swept-hexahedral ferromagnet mesh

(swept-hex-problem-statement)=
## Physical problem

`element_family="hex"` describes a requested `hex8` sweep from a quadrilateral source. Current controls can serialize it and typed ingress can preserve imported `hex8`, but there is no executable swept-hex route.

(swept-hex-governing-equations)=
## Governing equations

```{math}
:label: eq-swept-hex-arity
a(\mathrm{hex8})=8,\qquad K_c=\mathrm{cell\_nodes}[o_c:o_{c+1}].
```

The arity identity is owned by `_MESHIO_SUPPORTED_ELEMENTS["hexahedron"]`; the variable-arity CSR slice is owned by `MeshData`.

(swept-hex-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $a(\mathrm{hex8})$ | Linear-hexahedron node arity | $1$ |
| $K_c$ | Local node-index sequence | $1$ |
| $o_c$ | Cell start offset | $1$ |
| $c$ | Volume-cell ordinal | $1$ |

(swept-hex-assumptions-and-validity)=
## Assumptions and validity

`SweptMeshControls` accepts `hex`, rejects its pyramid-to-tetrahedra transition, and requires a uniform distribution for exact layers. Passing those object checks does not make the generator executable.

(swept-hex-python-api)=
## Python API

This inspection example serializes controls only; it does not build or solve.

```python
# %%
from fullmag.model.discretization import SweepDistribution, SweptMeshControls

controls = SweptMeshControls(distribution=SweepDistribution(kind="uniform", num_layers=2), sweep_direction="z", element_family="hex", transition_policy="reject", exact_layer_count=True)

# %%
requested_ir = controls.to_ir()
print(requested_ir)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `distribution` | `SweepDistribution` | `SweepDistribution()` | $1$ | instance of `SweepDistribution` | Layer distribution | FEM unsupported; FDM N/A | `distribution` |
| `sweep_direction` | `Literal["auto", "x", "y", "z"]` | `"auto"` | $1$ | one of `auto`, `x`, `y`, `z` | Requested axis | FEM unsupported; FDM N/A | `sweep_direction` |
| `element_family` | `Literal["prism", "hex"]` | `"prism"` | $1$ | one of `prism`, `hex` | Requested family | FEM unsupported; FDM N/A | `element_family` |
| `transition_policy` | `Literal["pyramid_to_tetrahedra", "reject"]` | `"reject"` | $1$ | hex cannot use pyramid transition | Transition | FEM unsupported; FDM N/A | `transition_policy` |
| `exact_layer_count` | `bool` | `False` | $1$ | Boolean; needs uniform distribution | Exact layers | FEM unsupported; FDM N/A | `exact_layer_count` |
| `distribution.kind` | `Literal["uniform", "arithmetic", "geometric"]` | `"uniform"` | $1$ | one of `uniform`, `arithmetic`, `geometric` | Layer-spacing law | FEM unsupported; FDM N/A | `distribution.kind` |
| `distribution.num_layers` | `int` | `1` | $1$ | bool rejected; integer at least 1 | Number of swept element layers | FEM unsupported; FDM N/A | `distribution.num_layers` |
| `distribution.growth_rate` | `float` | `1.0` | $1$ | must be positive for arithmetic/geometric; ignored for uniform | Nonuniform growth factor | FEM unsupported; FDM N/A | `distribution.growth_rate` |

(swept-hex-problem-ir)=
## ProblemIR

The canonical request is `{ "sweep_direction": "z", "distribution": {"kind": "uniform", "num_layers": 2}, "element_family": "hex", "transition_policy": "reject", "exact_layer_count": true }`. `SweepDistribution.to_ir()` always emits `kind` and `num_layers`; it emits `growth_rate` only for `arithmetic` or `geometric`, and omits it for `uniform`. The request contains no resolved mesh or runtime provenance.

(swept-hex-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is the controls object. **Resolved execution** is absent: `sweptHex.enabled` is false. **Validation errors** include invalid enums, nonuniform exact layers, and hex/pyramid-transition contradiction. **Unsupported combinations** include current CPU/GPU swept hex. `swept_hex` must raise before Gmsh starts and must not realize `prism6` or `tet4`.

(swept-hex-discrete-realization)=
## Discrete realization

`_MESHIO_VOLUME_TYPES` owns the imported `hexahedron -> hex8` mapping, but typed ingress differs from generated sweep realization. The Control Room reports swept hex disabled, unsupported, with no supported layer counts.

| Solver | Device | Status | Reason |
| --- | --- | --- |
| FEM | CPU | unsupported | No qualified swept-hex CPU route. |
| FEM | GPU | unsupported | No qualified swept-hex GPU route. |
| FDM | CPU | not applicable | FEM meshing. |
| FDM | GPU | not applicable | FEM meshing. |

(swept-hex-implementation-mapping)=
## Implementation mapping

`SweptMeshControls` owns vocabulary, `generate_swept_mesh` owns fail-closed dispatch, and `resolveObjectMeshTopologyCapabilities` marks swept hex unsupported.

(swept-hex-validation)=
## Validation

`test_explicit_swept_hex_never_silently_realizes_prism` requires rejection before Gmsh import. It is not a proof of hex assembly, CPU/GPU execution, parity, or accuracy.

(swept-hex-limitations)=
## Limitations

There is no production swept-hex route, qualified hex transition, generated `hex8` execution, or fallback authorization. Do not bypass the capability gate.

(swept-hex-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, "Gmsh," *International Journal for Numerical Methods in Engineering* **79** (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, "Micromagnetics and spintronics," *European Physical Journal B* **92** (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(swept-hex-source-code-index)=
## Source-code index

| Path | Stable symbol | Responsibility |
| --- | --- | --- |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class SweptMeshControls` | Controls/IR |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class SweepDistribution` | Distribution defaults, validation, and lowering |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `class MeshData` | Canonical variable-arity CSR ownership |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | `_MESHIO_SUPPORTED_ELEMENTS` | Linear `hex8` arity ownership |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | `_MESHIO_VOLUME_TYPES` | Imported `hexahedron` to `hex8` ownership |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_swept_mesh` | Fail-closed dispatch |
| `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts` | `resolveObjectMeshTopologyCapabilities` | Disabled gate |
| `packages/fullmag-py/tests/test_mixed_element_meshing.py` | `test_explicit_swept_hex_never_silently_realizes_prism` | No fallback |

## Scope and purpose

This page defines the public contract for swept hexahedral FEM meshes. It is an authoring and implementation reference: the Python example, the serialized ProblemIR description, the implementation mapping, and the adjacent source map are the source-backed contract. A capability marked partial or not evaluated is not presented as a production guarantee.

## Scientific and numerical model

The mesh or grid is a discrete approximation of the continuous domain. For a Cartesian partition, each spacing satisfies `Delta_i = L_i / N_i`; for a geometry-dependent FEM mesh, the requested local target is bounded by the active bulk, interface, boundary, and topology constraints. In compact form, `h_target(x) = min(h_bulk(x), h_interface(x), h_boundary(x))`. Length quantities use SI metres (`m`); counts, orders, and topology labels are dimensionless.

The equations and assumptions in the earlier physical-problem and governing-equations sections state the model-specific specialization. This section does not introduce a conversion from FEM to FDM, a hidden topology conversion, or a silent CPU fallback.

## Parameters

The exact callable and argument names are the ones shown in the `## Python API` section above. For this page the parameter family is source surface, layer count, element size, and topology. Use the documented defaults, validation rules, and ProblemIR lowering exactly as shown; do not replace a canonical argument with an unlisted alias. Numerical lengths must be supplied in metres, and invalid positive-length, count, order, periodicity, or topology constraints must fail closed rather than being silently repaired.

## Control Room workflow

In Control Room, select the engine and mesh workflow, enter the same values as the Python authoring example, inspect the planned mesh or grid report, and only then submit the run. The UI is a projection of the public contract: a missing control is not evidence that the backend accepts the option, and a visible control is not evidence that a production lane is enabled. When the page or capability register marks a field partial or not evaluated, keep the workflow explicitly bounded to the implemented path.

## Diagnostics and failure semantics

A valid request must preserve the declared geometry, units, element or cell topology, and backend lane. Reject non-finite or non-positive lengths, invalid counts and orders, incompatible periodic or shared-boundary data, and unsupported topology combinations at the owning validation layer. Reports should retain requested and resolved values, source identity, and any capability gate. No diagnostic may hide a failed mesh realization by substituting another discretization.

## Where this is implemented

The existing implementation-mapping and source-code-index sections identify the exact public authoring, ProblemIR, planner, realization, and runtime owners for this topic. The adjacent `.source-map.json` file is the machine-readable source of truth for those paths, symbols, responsibilities, backend matrix, and reviewed revision. Claims in this page must be updated together with that map when an owner moves.