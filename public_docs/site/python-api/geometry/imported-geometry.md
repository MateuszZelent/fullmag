---
title: Imported Geometry
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Imported geometry

(public-docs-python-api-geometry-imported-geometry)=
(python-api-geometry-imported-geometry-problem-statement)=
## Problem statement

`ImportedGeometry` records an external geometry or mesh asset path, its multiplicative unit/scale
normalization, and its volume-vs-surface import policy; CAD tessellation or mesh extraction happens
in the downstream resolver rather than at Python construction time.

Construction validates source asset identifiers, scale factors, units, and import modes in Python;
calling `to_ir()` emits the canonical `ProblemIR` record consumed by the meshing and study pipeline.

(python-api-geometry-imported-geometry-governing-equations)=
## Governing equations

`ImportedGeometry` maps an external CAD or mesh asset (`.step`/`.stp`, `.stl`, `.msh`, or `.npz`
geometry asset) onto physical SI coordinates $\mathbf{x}_{\mathrm{SI}} = \mathbf{s}_{\mathrm{eff}} \odot \mathbf{x}_{\mathrm{src}}$,
where the effective scale $\mathbf{s}_{\mathrm{eff}} = \mathbf{s} \cdot u_{\mathrm{unit}}$ is the
product of the explicit `scale` factor and the SI factor implied by `units` (e.g. `units="nm"`
multiplies `scale` by $10^{-9}\,\mathrm{m}$). Never pass both `scale=1.0e-9` and `units="nm"`, as
that scales coordinates by $10^{-18}\,\mathrm{m}$. Coordinate normalization and mesh import
semantics are documented in {doc}`../../physics/geometry-and-materials` and
{doc}`../../numerical-methods/meshing/fem/ferromagnet/imported-mesh`.

(python-api-geometry-imported-geometry-symbols-and-si-units)=
## Symbols and SI units

After applying `scale` and `units`, realized physical coordinates and domain extents use SI metres
($\mathrm{m}$). The parameters `source`, `scale`, `units`, `name`, and `volume` are dimensionless
descriptors ($1$).

(python-api-geometry-imported-geometry-assumptions-and-validity)=
## Assumptions and validity

- `source` must be a non-empty string. `infer_geometry_format(source)` maps `.step`/`.stp` to
  `"step"`, `.stl` to `"stl"`, `.msh` to `"msh"`, `.npz` to `"npz_asset"`, and any other suffix to
  `"unknown"` (`.iges` and `.brep` are NOT supported formats).
- `scale` must be strictly positive (scalar or three-component vector) after multiplying by the
  `units` conversion factor.
- `units` accepts recognized SI length unit strings (`"m"`, `"mm"`, `"um"`, `"nm"`) or `None`.
- `volume` accepts `"full"` (default volumetric solid import) or `"surface"` (surface-only /
  shell import). Unrecognized formats, non-positive scales, or unsupported `volume` modes fail
  closed during construction, lowering, or meshing.

(python-api-geometry-imported-geometry-python-api)=
## Python API

### Constructor or function

`fm.ImportedGeometry(source, scale=1.0, units=None, name=None, volume="full")` (also available via
`fm.shapes.imported(source, *, center=None, name=None, scale=1.0, units=None, volume="full")`).

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `ImportedGeometry.source` | `str` | `required` | $1$ | non-empty; extension inferred as `.step`/`.stp`, `.stl`, `.msh`, or `.npz` | source asset path or identifier | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | `source` |
| `ImportedGeometry.scale` | `float \| tuple[float, float, float]` | `1.0` | $1$ | strictly positive scalar or 3-vector; multiplied by `units` factor | explicit import scale factor | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | `scale` |
| `ImportedGeometry.units` | `str \| None` | `None` | $1$ | recognized unit (`"m"`, `"mm"`, `"um"`, `"nm"`) or `None` | source coordinate units converted into effective `scale` | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | `scale` |
| `ImportedGeometry.name` | `str \| None` | `None` | $1$ | non-empty when supplied; defaults to file stem | stable geometry name | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `ImportedGeometry.volume` | `Literal["full", "surface"]` | `"full"` | $1$ | `"full"` or `"surface"` | volumetric vs surface-only import policy | FEM/FDM CPU/GPU: IR; resolver-specific | `volume` |

### Stage-first example

```python
# %% Stage-first study and ImportedGeometry unit-scale verification
import fullmag as fm

study = fm.study("imported_geometry_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(maximum_element_size=5e-9)

body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)

# Use scale=1.0 with units="nm" (effective scale = 1e-9 m, NOT scale=1e-9 + units="nm"):
solid_cad = fm.ImportedGeometry("track.step", scale=1.0, units="nm", volume="full")
surface_stl = fm.ImportedGeometry("shell.stl", scale=1.0, units="nm", volume="surface")
assert solid_cad.to_ir()["format"] == "step"
assert solid_cad.to_ir()["scale"] == 1.0e-9
assert surface_stl.to_ir()["volume"] == "surface"
```

In a complete simulation script with an on-disk CAD/STL file, pass the constructed
`ImportedGeometry` object directly to `study.geometry(...)` or compose it with `fm.shapes.imported(...)`.

(python-api-geometry-imported-geometry-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed dictionary with `"kind": "imported_geometry"`, `"name"`, `"source"`,
`"format"` (`"step"`, `"stl"`, `"msh"`, `"npz_asset"`, or `"unknown"`), and combined effective
`"scale"`. When `volume="surface"`, `"volume": "surface"` is included; when `volume="full"`, the
default `"volume"` key is omitted.

(python-api-geometry-imported-geometry-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves the external asset path, inferred format, combined SI scaling, and
`"full"`/`"surface"` volume policy in `ProblemIR` independently of `resolved execution`.
`Validation errors` reject invalid types, empty paths, non-positive scales, and unrecognized `units`
or `volume` modes, while `unsupported combinations` (such as unhealed open shells or unsupported
extensions) fail closed at the mesher or backend boundary.

(python-api-geometry-imported-geometry-discrete-realization)=
## Discrete realization

| Solver | Device | Imported geometry realization | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Voxelizes watertight imported geometry assets onto the structured active-cell mask | Voxel staircase convergence remains problem-dependent |
| FDM | GPU | Consumes the planner-materialized active-cell mask from the shared voxelization step | Device solver qualification remains separate |
| FEM | CPU | Imports STEP/STL/MSH via Gmsh/OpenCASCADE into conforming tetrahedral meshes | See {doc}`../../numerical-methods/meshing/fem/ferromagnet/imported-mesh` |
| FEM | GPU | Consumes the conforming FEM mesh materialized on host and uploaded to CUDA | Executed-device qualification remains separate |

(python-api-geometry-imported-geometry-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/geometry.py`
(`class ImportedGeometry`) together with `infer_geometry_format` in
`packages/fullmag-py/src/fullmag/_validation.py`.

(python-api-geometry-imported-geometry-validation)=
## Validation

Focused repository unit tests covering authoring, unit scaling, and IR round-tripping include
`test_script_rewrite_preserves_imported_geometry_surface_volume`. Native CAD import and solver
convergence require separate backend qualification.

(python-api-geometry-imported-geometry-limitations)=
## Limitations and Control Room

Control Room supports interactive **Import STL** (`ImportedMesh`) inside `ObjectGeometrySpec`
(`apps/control-room/src/modules/inspector/inspectors/objects/geometry/ObjectGeometrySpec.tsx`);
STEP, MSH, NPZ assets, and `volume="surface"` import options remain authored in Python scripts.
See {doc}`/frontend/capability-register`.

(python-api-geometry-imported-geometry-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: A 3-D finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79**(11), 1309–1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579) | [Open-access HAL PDF](https://hal.science/hal-03406365v1/file/Geuzaine2009.pdf).

(python-api-geometry-imported-geometry-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L457) | [`class ImportedGeometry`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L457) | public constructor, unit-scale combination, and IR lowering |
| [`packages/fullmag-py/src/fullmag/_validation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/_validation.py#L300) | [`infer_geometry_format`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/_validation.py#L300) | `.step`/`.stp`, `.stl`, `.msh`, and `.npz` format inference |
