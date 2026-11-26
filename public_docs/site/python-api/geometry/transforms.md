---
title: Transforms
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Geometry transforms

(public-docs-python-api-geometry-transforms)=
(python-api-geometry-transforms-problem-statement)=
## Problem statement

Geometry transforms are explicit nested IR operations: `Translate` applies a pure translation
without discarding existing centers, `Transform` applies general affine placement (translation,
unit-quaternion rotation, component-wise scale, and pivot), and `RigidTransform` (aliased as
`AntennaRigidTransform`) encodes orthonormal rigid frames for 3D conductor antenna layouts. Every
geometry node also exposes fluent `.translate(...)`, `.rotate(...)`, `.scale(...)`, and
`.transform(...)` methods, mirrored by `fm.shapes.rotate`, `fm.shapes.scale`, and `fm.shapes.affine`.

(python-api-geometry-transforms-governing-equations)=
## Governing equations

- `Translate`: $\Omega' = \{ \mathbf{x} + \mathbf{b} : \mathbf{x} \in \Omega_{\mathrm{base}} \}$ for Cartesian displacement $\mathbf{b} \in \mathbb{R}^3$.
- `Transform`: about pivot $\mathbf{p}$, scale $\mathbf{S} = \operatorname{diag}(s_x, s_y, s_z)$, rotation matrix $\mathbf{R}_q \in \mathrm{SO}(3)$ from normalized unit quaternion $q = (q_x, q_y, q_z, q_w)$, and translation $\mathbf{t}$:
  $$\mathbf{x}' = \mathbf{t} + \mathbf{p} + \mathbf{R}_q \mathbf{S} (\mathbf{x} - \mathbf{p}).$$
- `RigidTransform` (`AntennaRigidTransform`): $\mathbf{x}' = \mathbf{R} \mathbf{x} + \mathbf{t}$ with $3 \times 3$ proper orthogonal rotation matrix $\mathbf{R}$ and translation vector $\mathbf{t}$.

Domain conventions and mesh realization semantics are documented in
{doc}`../../physics/geometry-and-materials` and {doc}`../../numerical-methods/meshing/index`.

(python-api-geometry-transforms-symbols-and-si-units)=
## Symbols and SI units

Displacements and pivots (`Translate.offset`, `Transform.translation`, `Transform.pivot`,
`RigidTransform.translation_m`) use SI metres ($\mathrm{m}$). Euler/axis-angle convenience inputs
(`euler_deg`, `angle_deg`) use degrees ($\mathrm{deg}$). Unit quaternions (`rotation_quat`),
rotation matrices (`rotation_matrix`), scale factors (`scale`), child geometry operands, and `name`
descriptors are dimensionless ($1$).

(python-api-geometry-transforms-assumptions-and-validity)=
## Assumptions and validity

`geometry`/`child` must be a typed `Geometry` node, translation and pivot vectors must be finite
three-element sequences, scale components must be finite and strictly positive, `rotation_quat` must
be a finite non-zero 4-tuple `(qx, qy, qz, qw)`, `RigidTransform.rotation_matrix` must be a valid
$3 \times 3$ orthonormal matrix with $\det(\mathbf{R}) = +1$, and `name` must be non-empty when
supplied. Invalid operands, zero quaternions, or non-positive scales fail closed at construction or
lowering.

(python-api-geometry-transforms-python-api)=
## Python API

### Constructors, fluent methods, and `fm.shapes` helpers

| Surface | Signature |
| --- | --- |
| `fm.Translate` | `(geometry, offset, name=None)` |
| `fm.Transform` | `(child, translation=(0,0,0), rotation_quat=(0,0,0,1), scale=(1,1,1), pivot=(0,0,0), name=None)` |
| `fm.RigidTransform` / `fm.AntennaRigidTransform` | `(rotation_matrix=None, translation_m=None, *, rotation=None, translation=None)` |
| Fluent `Geometry` methods | `.translate(offset)`, `.rotate(*, euler_deg=None, axis=None, angle_deg=None, quat=None, pivot=(0,0,0), name=None)`, `.scale(sx, sy=None, sz=None, *, pivot=(0,0,0), name=None)`, `.transform(*, translation=..., rotation_quat=..., scale=..., pivot=..., name=None)` |
| `fm.shapes` helpers | `fm.shapes.rotate(geometry, *, quaternion=None, euler_deg=None, axis=None, angle_deg=None, pivot=(0,0,0))`, `fm.shapes.scale(geometry, *, factors, pivot=(0,0,0))`, `fm.shapes.affine(geometry, *, translation=..., quaternion=..., scale=..., pivot=...)` |

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `Translate.geometry` | `Geometry` | `required` | $1$ | typed geometry | source geometry for translation | FEM/FDM CPU/GPU: IR; resolver-specific | `base` |
| `Translate.offset` | `tuple[float, float, float]` | `required` | $\mathrm{m}$ | finite three-vector | translation offset | FEM/FDM CPU/GPU: IR; resolver-specific | `by` |
| `Translate.name` | `str \| None` | `None` | $1$ | non-empty when supplied | optional result name | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `Transform.child` | `Geometry` | `required` | $1$ | typed geometry | child geometry node | FEM/FDM CPU/GPU: IR; resolver-specific | `child` |
| `Transform.translation` | `tuple[float, float, float]` | `(0.0, 0.0, 0.0)` | $\mathrm{m}$ | finite three-vector | post-rotation translation vector | FEM/FDM CPU/GPU: IR; resolver-specific | `translation` |
| `Transform.rotation_quat` | `tuple[float, float, float, float]` | `(0.0, 0.0, 0.0, 1.0)` | $1$ | finite non-zero quaternion `(qx, qy, qz, qw)` | active 3D rotation quaternion | FEM/FDM CPU/GPU: IR; resolver-specific | `rotation_quat` |
| `Transform.scale` | `tuple[float, float, float]` | `(1.0, 1.0, 1.0)` | $1$ | three positive finite scale factors | per-axis coordinate scaling around `pivot` | FEM/FDM CPU/GPU: IR; resolver-specific | `scale` |
| `Transform.pivot` | `tuple[float, float, float]` | `(0.0, 0.0, 0.0)` | $\mathrm{m}$ | finite three-vector | rotation and scaling pivot point | FEM/FDM CPU/GPU: IR; resolver-specific | `pivot` |
| `Transform.name` | `str \| None` | `None` | $1$ | non-empty when supplied | optional result name | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `RigidTransform.rotation_matrix` | `Sequence[Sequence[float]] \| None` | identity | $1$ | $3 \times 3$ proper orthonormal matrix ($\det = +1$) | rigid-body orientation for 3D antenna layouts | FEM/FDM CPU/GPU: IR; resolver-specific | `transform.rotation_matrix` |
| `RigidTransform.translation_m` | `Sequence[float] \| None` | `(0.0, 0.0, 0.0)` | $\mathrm{m}$ | finite three-vector | rigid-body displacement for 3D antenna layouts | FEM/FDM CPU/GPU: IR; resolver-specific | `transform.translation_m` |

### Stage-first example

```python
# %% Stage-first study with Translate, fluent rotate/scale/transform, and RigidTransform
import fullmag as fm

nm = 1.0e-9

bar = fm.Box(size=(100 * nm, 20 * nm, 5 * nm), name="bar")
rotated = bar.rotate(euler_deg=(0.0, 0.0, 45.0), pivot=(0.0, 0.0, 0.0))
scaled = fm.shapes.scale(rotated, factors=(1.2, 1.0, 1.0))
shifted = fm.Translate(bar, offset=(10 * nm, 0.0, 0.0))
rigid = fm.RigidTransform(translation_m=(0.0, 0.0, 15 * nm))

assert rotated.to_ir()["kind"] == "transform"
assert scaled.to_ir()["kind"] == "transform"
assert shifted.to_ir()["kind"] == "translate"
assert rigid.to_ir()["translation_m"] == [0.0, 0.0, 15 * nm]

study = fm.study("transforms_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(maximum_element_size=5 * nm)
body = study.geometry(rotated, name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)
```

(python-api-geometry-transforms-problem-ir)=
## ProblemIR

- `Translate.to_ir()` emits `{"kind": "translate", "name": ..., "base": <child>, "by": [dx, dy, dz]}`.
- `Transform.to_ir()` emits `{"kind": "transform", "name": ..., "child": <child>, "translation": [...], "rotation_quat": [qx, qy, qz, qw], "scale": [sx, sy, sz], "pivot": [...]}`.
- `RigidTransform.to_ir()` emits `{"rotation_matrix": [[...], [...], [...]], "translation_m": [tx, ty, tz]}`.

(python-api-geometry-transforms-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves nested translation, affine transform, and rigid-frame composition in
`ProblemIR` independently of `resolved execution`. `Validation errors` reject untyped child
geometries, non-finite vectors, zero quaternions, non-positive scales, and non-orthonormal
`RigidTransform` matrices, while `unsupported combinations` fail closed downstream.

(python-api-geometry-transforms-discrete-realization)=
## Discrete realization

| Solver | Device | Transform realization | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Evaluates inverse affine transform when testing structured cell-centre occupancy | Staircase approximation for rotated edges remains problem-dependent |
| FDM | GPU | Consumes the planner-materialized active-cell mask on CUDA | GPU solver parity validated separately |
| FEM | CPU | Applies exact OpenCASCADE/Gmsh rigid and affine transformations before tetrahedral meshing | Conforming mesh quality verified per study |
| FEM | GPU | Consumes the host-built conforming FEM mesh uploaded to CUDA | Executed-device GPU qualification remains separate |

(python-api-geometry-transforms-implementation-mapping)=
## Implementation mapping

Authoritative implementations live in `packages/fullmag-py/src/fullmag/model/geometry.py`
(`_GeometryOps`, `class Translate`, `class Transform`, `class RigidTransform` /
`AntennaRigidTransform`) and `packages/fullmag-py/src/fullmag/shapes.py` (`rotate`, `scale`,
`affine`).

(python-api-geometry-transforms-validation)=
## Validation

Focused repository unit tests cover additive translation (`test_region_shape_translation_adds_to_existing_center`),
quaternion/Euler/axis-angle `Transform` normalization, and `RigidTransform` orthonormality checks.
Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-geometry-transforms-limitations)=
## Limitations and Control Room

The **Placement** tab in Control Room's `ObjectGeometrySpec`
(`apps/control-room/src/modules/inspector/inspectors/objects/geometry/ObjectGeometrySpec.tsx` and
`apps/control-room/src/modules/inspector/inspectors/objects/geometry/GeometryTransformSections.tsx`)
supports interactive **translation** (and 3D viewport Move gizmo `W`), **Euler XYZ rotation**,
**pivot** selection, and **scale / bake** (with optional uniform-scale lock), with `scene_revision`
rebase reconciliation if a live Python script modifies unrelated objects.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| `Translate` & `Transform` (translation, Euler XYZ rotation, pivot, scale / bake) | `Model Explorer -> Objects -> <object> -> Placement` (`ObjectGeometrySpec` / `GeometryTransformSections`) & viewport Move `W` | `implemented` | `applyGeometryDraftMutation` on `scene_revision` (invalidates stale mesh) |
| `RigidTransform` (`AntennaRigidTransform`) and scripted nested transform chains | Python DSL | `Python-only` | Author in Python |

```{image} /_static/images/ui/inspector-geometry-and-csg.png
:alt: Control Room Geometry Inspector showing the Geometry and Placement tab switcher for translation, rotation, pivot, and scale editing
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/objects-and-materials`.

(python-api-geometry-transforms-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: A 3-D finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79**(11), 1309–1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579) | [Open-access HAL PDF](https://hal.science/hal-03406365v1/file/Geuzaine2009.pdf).

(python-api-geometry-transforms-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2527) | [`class Translate`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2527) | pure translation constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2600) | [`class Transform`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2600) | affine translation, quaternion rotation, scale, and pivot transform |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L582) | [`class RigidTransform`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L582) | rigid rotation-matrix/translation frame for 3D antenna layouts |
