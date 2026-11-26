---
title: Boolean Operations
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Boolean geometry operations

(public-docs-python-api-geometry-boolean-operations)=
(python-api-geometry-boolean-operations-problem-statement)=
## Problem statement

Boolean CSG operations (`Union`, `Difference`, `Intersection`, `Xor`) and solid modifiers
(`SlicePlane`, `Array3D`) preserve operand structure in `ProblemIR` without performing hidden
meshing at construction time. Every geometry primitive and composite node also supports Python CSG
operators (`\|`, `+`, `-`, `&`, `^`) and fluent composition methods (`.union`, `.subtract`,
`.intersect`, `.xor`, `.slice_plane`, `.array_3d`).

(python-api-geometry-boolean-operations-governing-equations)=
## Governing equations

Boolean operators define set-theoretic solid domains in $\mathbb{R}^3$:

- `Union` (`a \| b` or `a + b`): $\Omega_{\mathrm{union}} = \Omega_a \cup \Omega_b$
- `Difference` (`a - b`): $\Omega_{\mathrm{diff}} = \Omega_{\mathrm{base}} \setminus \Omega_{\mathrm{tool}}$
- `Intersection` (`a & b`): $\Omega_{\mathrm{int}} = \Omega_a \cap \Omega_b$
- `Xor` (`a ^ b`): $\Omega_{\mathrm{xor}} = (\Omega_{\mathrm{left}} \setminus \Omega_{\mathrm{right}}) \cup (\Omega_{\mathrm{right}} \setminus \Omega_{\mathrm{left}})$
- `SlicePlane`: half-space clip $\Omega_{\mathrm{slice}} = \{ \mathbf{x} \in \Omega_{\mathrm{child}} : \pm(\mathbf{x}-\mathbf{p}_0)\cdot\hat{\mathbf{n}} \ge 0 \}$
- `Array3D`: finite 1D/2D/3D lattice replication of a child geometry with per-axis pitch/gap, optional step translation/rotation/scale increments, and optional overlap merging (`merge_overlapping`).

Meshing and active-cell/tetrahedral realization of CSG trees are documented in
{doc}`../../physics/geometry-and-materials` and {doc}`../../numerical-methods/meshing/index`.

(python-api-geometry-boolean-operations-symbols-and-si-units)=
## Symbols and SI units

`SlicePlane.plane_origin`, `ArrayAxisSpec.pitch_m`, `ArrayAxisSpec.gap_m`, and
`ArrayAxisSpec.step_translation_extra_m` use SI metres ($\mathrm{m}$);
`ArrayAxisSpec.step_rotation_euler_deg` uses degrees ($\mathrm{deg}$); operand geometries,
normalized plane normals, counts, flags, and `name` strings are dimensionless ($1$).

(python-api-geometry-boolean-operations-assumptions-and-validity)=
## Assumptions and validity

Operands must be valid `Geometry` instances (primitives, transforms, modifiers, or nested CSG
trees), and `name` must be non-empty when supplied. `SlicePlane.plane_normal` must be finite and
non-zero, and `keep_side` must be `"positive"` or `"negative"`. `ArrayAxisSpec` requires
`axis` in `{"x", "y", "z"}` and `count >= 1`. Invalid operand types or empty result domains fail
closed at construction, lowering, or mesh generation.

(python-api-geometry-boolean-operations-python-api)=
## Python API

### Constructors, operators, and fluent methods

| Operation | Constructor | Operator | Fluent method / `fm.shapes` helper |
| --- | --- | --- | --- |
| Union | `fm.Union(a, b, name="union")` | `a \| b` or `a + b` | `a.union(b, name=None)` |
| Difference | `fm.Difference(base, tool, name="difference")` | `base - tool` | `base.subtract(tool, name=None)` |
| Intersection | `fm.Intersection(a, b, name="intersection")` | `a & b` | `a.intersect(b, name=None)` |
| Symmetric difference | `fm.Xor(left, right, name="xor")` | `left ^ right` | `left.xor(right, name=None)` |
| Half-space clip | `fm.SlicePlane(child, plane_origin=(0,0,0), plane_normal=(0,0,1), keep_side="positive", name=None)` | — | `child.slice_plane(origin=..., normal=..., keep="positive", name=None)` / `fm.shapes.slice_plane(...)` |
| 3D lattice array | `fm.Array3D(child, axes, merge_overlapping=False, name=None)` | — | `child.array_3d(nx=1, ny=1, nz=1, dx=0.0, dy=0.0, dz=0.0, ...)` / `fm.shapes.array_3d(...)` |

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `Difference.base` | `Geometry` | `required` | $1$ | typed geometry operand | base solid for Boolean subtraction | FEM/FDM CPU/GPU: IR; resolver-specific | `base` |
| `Difference.tool` | `Geometry` | `required` | $1$ | typed geometry operand | subtracted tool solid | FEM/FDM CPU/GPU: IR; resolver-specific | `tool` |
| `Union.a` | `Geometry` | `required` | $1$ | typed geometry operand | first operand of `Union` (`Intersection.a` mirrors this contract) | FEM/FDM CPU/GPU: IR; resolver-specific | `a` |
| `Union.b` | `Geometry` | `required` | $1$ | typed geometry operand | second operand of `Union` (`Intersection.b` mirrors this contract) | FEM/FDM CPU/GPU: IR; resolver-specific | `b` |
| `Xor.left` | `Geometry` | `required` | $1$ | typed geometry operand | first operand of symmetric difference | FEM/FDM CPU/GPU: IR; resolver-specific | `left` |
| `Xor.right` | `Geometry` | `required` | $1$ | typed geometry operand | second operand of symmetric difference | FEM/FDM CPU/GPU: IR; resolver-specific | `right` |
| `SlicePlane.child` | `Geometry` | `required` | $1$ | typed geometry operand | geometry clipped by half-space plane | FEM/FDM CPU/GPU: IR; resolver-specific | `child` |
| `SlicePlane.plane_origin` | `tuple[float, float, float]` | `(0.0, 0.0, 0.0)` | $\mathrm{m}$ | finite 3-vector | point lying on the cutting plane | FEM/FDM CPU/GPU: IR; resolver-specific | `plane_origin` |
| `SlicePlane.plane_normal` | `tuple[float, float, float]` | `(0.0, 0.0, 1.0)` | $1$ | finite non-zero 3-vector | outward normal of the positive half-space | FEM/FDM CPU/GPU: IR; resolver-specific | `plane_normal` |
| `SlicePlane.keep_side` | `Literal["positive", "negative"]` | `"positive"` | $1$ | `"positive"` or `"negative"` | half-space retained after clipping | FEM/FDM CPU/GPU: IR; resolver-specific | `keep_side` |
| `Array3D.child` | `Geometry` | `required` | $1$ | typed geometry operand | unit-cell solid replicated across the lattice | FEM/FDM CPU/GPU: IR; resolver-specific | `child` |
| `Array3D.axes` | `Sequence[ArrayAxisSpec \| Mapping[str, object]]` | `required` | $1$ | valid `ArrayAxisSpec` sequence | per-axis repeat counts, spacing mode, pitch/gap, and step transforms | FEM/FDM CPU/GPU: IR; resolver-specific | `axes` |
| `Array3D.merge_overlapping` | `bool` | `False` | $1$ | boolean | boolean-fuse touching/overlapping array copies | FEM/FDM CPU/GPU: IR; resolver-specific | `merge_overlapping` |

`ArrayAxisSpec(axis, enabled=False, count=1, direction="positive", spacing_mode="lattice_step", pitch_m=0.0, relative_factor=1.0, gap_m=0.0, step_translation_extra_m=(0,0,0), step_rotation_euler_deg=(0,0,0), step_scale_factor=(1,1,1))` configures each replication axis for `Array3D`.

### Stage-first example

```python
# %% Stage-first study with CSG operators, Xor, SlicePlane, and Array3D
import fullmag as fm

nm = 1.0e-9

base_plate = fm.Box(size=(120 * nm, 60 * nm, 6 * nm), name="plate")
hole = fm.Cylinder(radius=10 * nm, height=8 * nm, name="hole")
perforated = (base_plate - hole).slice_plane(
    origin=(0.0, 0.0, 0.0),
    normal=(1.0, 0.0, 0.0),
    keep="positive",
    name="half_perforated",
)
lattice = fm.Box(size=(20 * nm, 20 * nm, 5 * nm), name="dot").array_3d(
    nx=3,
    ny=2,
    dx=30 * nm,
    dy=30 * nm,
)
xor_ring = fm.Cylinder(radius=25 * nm, height=5 * nm) ^ fm.Cylinder(radius=12 * nm, height=5 * nm)
assert perforated.to_ir()["kind"] == "slice_plane"
assert lattice.to_ir()["kind"] == "array_3d"
assert xor_ring.to_ir()["kind"] == "xor"

study = fm.study("boolean_csg_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(maximum_element_size=5 * nm)
body = study.geometry(perforated, name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)
```

(python-api-geometry-boolean-operations-problem-ir)=
## ProblemIR

`to_ir()` emits nested CSG dictionaries with `"kind"` equal to `"difference"`, `"union"`,
`"intersection"`, `"xor"`, `"slice_plane"`, or `"array_3d"`, `"name"`, and recursive operand or
modifier fields (`"base"`/`"tool"`, `"a"`/`"b"`, `"left"`/`"right"`, `"child"`/`"plane_origin"`/`"plane_normal"`/`"keep_side"`,
or `"child"`/`"axes"`/`"merge_overlapping"`).

(python-api-geometry-boolean-operations-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves the full recursive CSG and modifier tree in `ProblemIR` independently of
`resolved execution`. `Validation errors` reject non-geometry operands, zero slice normals, invalid
`keep_side`, or non-positive array counts, while `unsupported combinations` (such as degenerate
empty cuts during meshing) fail closed at the mesher or backend boundary.

(python-api-geometry-boolean-operations-discrete-realization)=
## Discrete realization

| Solver | Device | CSG & modifier realization | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Evaluates recursive Boolean/slice/array occupancy at structured cell centres | Voxel staircase convergence remains problem-dependent |
| FDM | GPU | Consumes the planner-materialized active-cell mask on CUDA | GPU solver parity validated separately |
| FEM | CPU | Evaluates exact OpenCASCADE Boolean/cut/array B-Rep trees in Gmsh before meshing | Conforming mesh quality verified per study |
| FEM | GPU | Consumes the host-built conforming FEM mesh uploaded to CUDA | Executed-device GPU qualification remains separate |

(python-api-geometry-boolean-operations-implementation-mapping)=
## Implementation mapping

The authoritative implementations live in `packages/fullmag-py/src/fullmag/model/geometry.py`
(`_GeometryOps`, `class Difference`, `class Union`, `class Intersection`, `class Xor`,
`class SlicePlane`, `class Array3D`, `class ArrayAxisSpec`) and
`packages/fullmag-py/src/fullmag/shapes.py` (`slice_plane`, `array_3d`).

(python-api-geometry-boolean-operations-validation)=
## Validation

Focused repository unit tests covering authoring and IR serialization include
`test_boolean_geometry_exports_nested_ir`, `Xor`/`SlicePlane`/`Array3D` operator round-trip tests,
and Control Room geometry-stack tests. Mesh realization and geometric accuracy require separate
backend qualification.

(python-api-geometry-boolean-operations-limitations)=
## Limitations and Control Room

CSG Boolean operations (`Union`, `Difference`, `Intersection`, `Xor`, **Cut Hole**) and **Modify**
tools (`SlicePlane`, `Array3D` lattice replication with budget validation and inline operand stack
editing) are live in Control Room inside `ObjectGeometrySpec`
(`apps/control-room/src/modules/inspector/inspectors/objects/geometry/ObjectGeometrySpec.tsx`,
`PrimitiveModifiersBar`, `GeometryStackEditor`).

### Control Room support

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| CSG Booleans (`Union`, `Difference`, `Intersection`, `Xor`, Cut Hole) | `Model Explorer -> Objects -> <object> -> Geometry` (`ObjectGeometrySpec`, `PrimitiveModifiersBar`, `GeometryStackEditor`) | `implemented` | Staged `applyGeometryDraftMutation` with inline operand editing on `scene_revision` |
| Modifiers (`SlicePlane`, `Array3D` / `ArrayAxisSpec`) | `Model Explorer -> Objects -> <object> -> Geometry` (`Modifiers & Boolean tools` / `Geometry stack`) | `implemented` | Live budget check (`computeArray3DBudgetStatus`) and staged apply |

```{image} /_static/images/ui/inspector-geometry-and-csg.png
:alt: Control Room Geometry Inspector showing live CSG boolean and modifier controls alongside Geometry and Placement tabs
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/objects-and-materials`.

(python-api-geometry-boolean-operations-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: A 3-D finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79**(11), 1309–1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579) | [Open-access HAL PDF](https://hal.science/hal-03406365v1/file/Geuzaine2009.pdf).

(python-api-geometry-boolean-operations-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2416) | [`class Difference`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2416), `class Union`, `class Intersection` | Boolean CSG constructors and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2569) | [`class Xor`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2569) | Symmetric-difference CSG constructor (`^`) |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2661) | [`class SlicePlane`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2661) | Half-space plane clipping modifier |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2875) | [`class Array3D`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2875), `class ArrayAxisSpec` | 3D lattice array replication modifier |
