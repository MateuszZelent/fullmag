---
title: Geometry, regions, materials and meshes
status: partial
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
source_of_truth: packages/fullmag-py/src/fullmag/model/geometry.py and structure.py
---

# Geometry, regions, materials and meshes

Geometry and material declarations are the physical input to FullMag. They are authored once and
then lowered to the selected FDM or FEM realization. The lowerer may choose different cells,
elements, markers, quadrature locations, and boundary machinery, but it must preserve the authored
object identity, region membership, material assignment, and mesh intent or reject the request.

This page is the physics-level map of the complete path:

```text
geometry object -> magnetic object -> object-owned region -> material assignment -> mesh policy
        -> ProblemIR -> FDM grid or FEM mesh -> interaction and solver realization
```

The Python terminal pages linked below are the authoritative reference for each constructor. This
page explains how those contracts compose and records the physical assumptions and current limits.

## Physical model

Let `Omega` be the magnetic domain and `Omega_i` its authored regions. A valid realization preserves
the intended membership relation:

```{math}
:label: eq-geometry-material-domain-partition

\Omega_{\mathrm{mag}} = \bigcup_i \Omega_i,
\qquad
\Omega_i \cap \Omega_j = \varnothing \quad (i \ne j)
```

The equation describes the resolved physical partition, not every intermediate authoring shape.
Boolean operands may overlap by design, and object-owned region policies may overlap while they
are being resolved. Such cases require explicit priority and conflict policy; insertion order is
not a physical rule.

For a material parameter `p`, the object scalar is the default value and a scoped field is an
override evaluated only where its owning object and optional region have support. A resolved
operator consumes the material value at its own cells, nodes, elements, or quadrature points. The
Python field declaration does not by itself prove that a particular backend, interpolation rule,
precision, or device can materialize it.

## Authoring layers

### 1. Geometry object

Use a typed primitive, an imported geometry, or a composition of typed objects. Dimensions are in
metres. Primitive objects are centered at the origin unless a transform or centered shape helper
is used.

The public constructors implemented in `fullmag.model.geometry` are:

| Constructor | Physical meaning | Main dimensional arguments |
|---|---|---|
| `fm.Box(...)` | axis-aligned box | `size=(dx, dy, dz)` or `dx, dy, dz` in `m` |
| `fm.Cylinder(...)` | circular cylinder | `radius`, `height` in `m`; optional unit `axis` |
| `fm.Ellipsoid(...)` | ellipsoid | semi-axes `rx`, `ry`, `rz` in `m` |
| `fm.Sphere(...)` | uniform ellipsoid convenience function | `radius` in `m` |
| `fm.Ellipse(...)` | extruded elliptical disk | `rx`, `ry`, `height` in `m` |
| `fm.SinWaveguide(...)` | sinusoidal waveguide | `length`, `width`, `height`, `period`, `amplitude` |
| `fm.ArchWaveguide(...)` | arched waveguide | `length`, `width`, `height`, `arch_height` |
| `fm.ImportedGeometry(...)` | imported CAD or mask source | `source`, `scale`, optional `units` |

Every typed geometry exposes `geometry_name` and `to_ir()`. `to_ir()` is the object-level
serialization boundary: it emits a typed record such as `kind="box"`, `kind="cylinder"`, or
`kind="imported_geometry"`; it does not generate a mesh.

### 2. Magnetic object

`study.geometry(shape, name=...)` or `fm.geometry(shape, name=...)` creates the object handle used
to attach magnetic parameters. The handle stores the physical object name and the base material
values. A magnetic object must have `Ms` and `Aex` before it can be lowered to a ferromagnet;
`alpha` defaults to `0.01` on the flat handle and can be set explicitly.

### 3. Object-owned region

`body.add_region(name, shape, ...)` creates a region scoped to one magnetic object. The default
identifier is `<object-name>:<region-name>`; pass `region_id` when a stable external identity is
required. `frame` accepts `object` or `world`, `priority` controls overlap precedence, and
`realization_policy` accepts `inherit`, `conformal`, or `project`.

The region is not a second independent solver object. It contributes membership, material
overrides, optional texture override, and local mesh intent to the owning object and shared domain.

### 4. Material assignment

The base material is an SI-only `fm.Material` record or the equivalent properties on a magnetic
object handle. A region can override a material parameter through `region.material.<name>`, or an
object can register a scoped field with `body.set_material_field(...)`.

### 5. Discretization and mesh

FDM realizes the geometry through structured cells, active masks, and grid ownership. FEM realizes
the same physical intent through a shared domain, element topology, material markers, and boundary
markers. An object-region mesh policy refines a region in that shared realization; it never creates
an overlapping independent submesh.

## Geometry operations

### Boolean operations

The geometry mixin implements these operators:

| Python expression | Set operation | Canonical IR kind |
|---|---|---|
| `a - b` | difference `a \\\\ b` | `difference` |
| `a + b` | union `a \\\\cup b` | `union` |
| `a & b` | intersection `a \\\\cap b` | `intersection` |

The explicit constructors `fm.Difference(base, tool)`, `fm.Union(a, b)`, and
`fm.Intersection(a, b)` produce the same typed records. Operands remain nested in `to_ir()`;
the operation is not silently converted to a triangulated mesh during authoring.

### Translation

`geometry.translate((dx, dy, dz))` creates a `Translate` record with the nested base geometry and
the `by` vector. It preserves any existing center or transform in the nested object. The vector is
finite and has three components; the derived name is stable unless `Translate(..., name=...)` is
used.

### Imported geometry

```python
# %%
# Import a source geometry with an explicit physical scale
import fullmag as fm

cad = fm.ImportedGeometry(
    source="mesh.step",
    scale=1.0,
    units="mm",
    name="cad_body",
    volume="full",
)
record = cad.to_ir()
study = fm.study("imported_geometry")
body = study.geometry(cad, name="cad_body")
body.Ms = 800.0e3
body.Aex = 13.0e-12
study.stages.add_run(stage_id="inspect_import", until=1.0e-15)
```

`units` is normalized against the source scale table (`m`, `cm`, `mm`, `um`, `nm`, and supported
micro-metre spellings). A scalar `scale` is applied uniformly; a three-vector scale is applied per
axis. `volume="full"` is the default. `volume="surface"` is a preview-only authoring route in
the current problem lowering and must not be presented as a volumetric solver mesh.

Detailed constructor and failure semantics: {doc}`/python-api/geometry/imported-geometry`.

## Materials and units

`fm.Material` stores magnetic constitutive parameters in SI units only. The class implemented in
`fullmag.model.structure` validates positive `Ms` and `A`, non-negative `alpha`, finite anisotropy
and DMI constants, and three-component anisotropy directions when supplied.

| Python field | Meaning | SI unit | Lowered ProblemIR field |
|---|---|---:|---|
| `Ms` | saturation magnetization | `A/m` | `saturation_magnetisation` / `ms` |
| `A` on `fm.Material` or `Aex` on an object handle | exchange stiffness | `J/m` | `exchange_stiffness` / `aex` |
| `alpha` | Gilbert damping | `1` | `damping` / `alpha` |
| `Ku1`, `Ku2` | uniaxial anisotropy constants | `J/m^3` | `uniaxial_anisotropy`, `uniaxial_anisotropy_k2` |
| `anisU` | uniaxial axis or easy-plane normal | `1` | `anisotropy_axis` |
| `Kc1`, `Kc2`, `Kc3` | cubic anisotropy constants | `J/m^3` | `cubic_anisotropy_kc1..3` |
| `anisC1`, `anisC2` | cubic anisotropy axes | `1` | `cubic_anisotropy_axis1..2` |
| `Dind` | interfacial DMI coefficient | `J/m^2` | `interfacial_dmi` / `dind` |
| `Dbulk` | bulk DMI coefficient | `J/m^2` in the current material contract | `bulk_dmi` / `dbulk` |

`unit` values on spatial fields are non-empty metadata. The current Python factories preserve that
metadata but do not convert it or check that it matches the selected parameter. Authors must pass
SI-valued numbers and use the unit string consistently.

### Base material example

```python
# %%
# Author a base SI material and inspect its typed record
import fullmag as fm

permalloy = fm.Material(
    name="Py",
    Ms=800.0e3,
    A=13.0e-12,
    alpha=0.02,
    Ku1=0.0,
    anisU=(0.0, 0.0, 1.0),
)
material_ir = permalloy.to_ir()
study = fm.study("base_material")
body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = permalloy.Ms
body.Aex = permalloy.A
study.stages.add_run(stage_id="inspect_material", until=1.0e-15)
```

For the high-level object handle, the equivalent assignments are `body.Ms`, `body.Aex`,
`body.alpha`, `body.Ku1`, `body.anisU`, `body.Kc1`, `body.Dind`, and `body.Dbulk`. The handle
converts these values to the `Material` record during `Problem` lowering.

## Regions, fields and interfaces

### Region creation and local mesh policy

```python
# %%
# Create one object-owned region and its local FEM mesh request
import fullmag as fm

nm = 1.0e-9
study = fm.study("geometry_materials_regions")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
body = study.geometry(fm.Box(size=(200 * nm, 80 * nm, 5 * nm)), name="track")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02

core = body.add_region(
    "core",
    fm.Cylinder(radius=30 * nm, height=5 * nm),
    priority=10,
)
core.material.Ms = fm.fields.constant(750.0e3, unit="A/m")
core.mesh(
    maximum_element_size=2 * nm,
    minimum_element_size=1 * nm,
    transition_distance=5 * nm,
    order=1,
)
study.stages.add_run(stage_id="inspect_region", until=1.0e-15)
```

`ObjectRegion.mesh` has exactly this signature:

```text
mesh(*, maximum_element_size=None, minimum_element_size=None,
     transition_distance=None, order=None)
```

Sizes are positive metres, `transition_distance` is non-negative, and
`minimum_element_size <= maximum_element_size` when both are supplied. The request is serialized
under the owning object region and is resolved together with the shared mesh.

### Spatial material fields

`MaterialParameterField` provides four typed factories:

| Factory | Required arguments | Meaning |
|---|---|---|
| `constant(value, unit=None)` | finite scalar or finite 3-vector | uniform override |
| `linear(base=, gradient=, frame="object", unit=None)` | finite base and 3-vector gradient | affine spatial profile |
| `radial(center=, radius=, inside=, outside=, frame="object", unit=None)` | finite center/values and positive radius | inside/outside radial profile |
| `sampled(asset_id=, component_count=, location=, unit=)` | non-empty asset, count >= 1, valid location and unit | immutable asset reference |

For `linear` and `radial`, `frame` is exactly `object` or `world`. Object-frame coordinates follow
the object; world-frame coordinates remain fixed in the laboratory frame. Supported material
parameter names are `Ms`, `Aex`, `Alpha`, `Ku1`, `Ku2`, `AnisotropyAxis`, `Kc1`, `Kc2`, `Kc3`,
`Dind`, and `Dbulk`; ProblemIR normalizes them to lower-case canonical names.

```python
# %%
# Apply a region-scoped analytic material field
import fullmag as fm

nm = 1.0e-9
study = fm.study("region_material_field")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
body = study.geometry(fm.Box(size=(200 * nm, 80 * nm, 5 * nm)), name="track")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
core = body.add_region(
    "core",
    fm.Cylinder(radius=30 * nm, height=5 * nm),
    priority=10,
)
body.set_material_field(
    "Ms",
    fm.fields.linear(
        base=760.0e3,
        gradient=(0.0, 1.5e11, 0.0),
        frame="object",
        unit="A/m",
    ),
    region=core,
    assignment_id="track_core_ms_gradient",
    priority=10,
    conflict_policy="error",
)
study.stages.add_run(stage_id="inspect_field", until=1.0e-15)
```

`body.set_material_field` accepts `parameter`, `value`, and the keyword arguments
`assignment_id=None`, `region=None`, `unit=None`, `priority=0`, and `conflict_policy="error"`.
`region` can be an `ObjectRegion` or its key. `higher_priority_wins` and
`min_mesh_size_wins` are the other declared conflict policies. Equal-priority overlap with
`error` fails closed; assignment order is not used as a tie-breaker.

`sampled` fields are currently authoring-only. The asset identity and sampling location survive in
ProblemIR, but the planner rejects materialization until the asset-loading and mesh-cardinality
contract is available. A legal Python object is therefore not evidence of sampled-field runtime
support.

### Material transitions

`region.material_transition(...)` records an explicit interface policy:

```text
material_transition(*, cells=None, width=None,
                     kind="mesh_relative", scope="boundary")
```

`kind="mesh_relative"` requires `cells >= 1`; `kind="metric"` requires positive `width`; and
`kind="sharp"` carries neither. `scope` is `boundary`, `inside`, or `outside`. This is an
authoring policy for `Ms`, `Aex`, or another supported parameter; it is not an automatic smoothing
pass and does not create an RKKY or inter-object coupling.

## ProblemIR and realization

`Problem.to_ir(...)` is the canonical problem serialization boundary. The relevant output sections
are:

| Authored concern | ProblemIR section | What remains visible |
|---|---|---|
| primitive, boolean, transform, or import | `geometry.entries` | typed `kind`, dimensions, nested operands, source and scale |
| object-owned region | `object_regions` | owner, region ID, shape, frame, priority, mesh policy, overrides |
| base material | `materials` | SI scalar values, axes, anisotropy and DMI fields |
| spatial material assignment | `material_parameter_fields` | assignment ID, owner, region, field kind, frame, unit and conflict policy |
| realized grid or mesh | `geometry_assets` | backend-specific assets only when asset building is requested |

Requested intent and resolved assets are separate. A changed geometry, region membership, mesh
policy, imported source, or material-field definition invalidates dependent mesh and materialized
field provenance. A change to magnetization alone does not change mesh identity.

### FDM realization

FDM uses structured cells and active masks. Geometry defines cell ownership and region membership;
material values are evaluated at the locations consumed by the stencil. FDM periodicity, demagnetizing
boundary correction, per-magnet grids, and multilayer policies are separate contracts and must not
be inferred from a successful primitive construction.

### FEM realization

FEM uses a shared domain with typed element topology, material markers, and boundary markers.
Object-region mesh policies participate in that shared domain. Thin-film swept layers, prism or
tetrahedral topology, airbox extent, periodic pairs, and boundary layers are resolver-specific
choices that require their own mesh report and convergence evidence.

The physics page therefore claims authoring and ProblemIR semantics only. It does not claim that
every legal geometry/material combination is supported by every backend, device, precision, mesh
topology, or Control Room path.

## Complete composition example

```python
# %%
# Compose geometry, regions, materials, fields, and an explicit FEM request
import fullmag as fm

nm = 1.0e-9
study = fm.study("perforated_film")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

film_shape = fm.Box(size=(300 * nm, 100 * nm, 5 * nm), name="film_shape")
hole_shape = fm.Cylinder(radius=20 * nm, height=5 * nm).translate((80 * nm, 0.0, 0.0))
film = study.geometry(film_shape - hole_shape, name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02

core = film.add_region(
    "core",
    fm.Ellipsoid(40 * nm, 20 * nm, 2 * nm),
    frame="object",
    priority=10,
    realization_policy="inherit",
)
core.material.Ms = fm.fields.constant(760.0e3, unit="A/m")
core.material_transition(kind="mesh_relative", cells=2, scope="boundary")
core.mesh(maximum_element_size=3 * nm, minimum_element_size=1 * nm, order=1)

film.set_material_field(
    "Ms",
    fm.fields.radial(
        center=(0.0, 0.0, 0.0),
        radius=50 * nm,
        inside=780.0e3,
        outside=800.0e3,
        frame="world",
        unit="A/m",
    ),
    assignment_id="film_world_radial_ms",
    priority=1,
)
study.stages.add_run(stage_id="inspect_composition", until=1.0e-15)
```

This example creates one magnetic object, one nested CSG geometry, one object-owned region, one
region override, one region mesh policy, one interface transition policy, and one object-scoped
world-frame field. It does not claim a completed mesh or a solved field; those are produced only by
the selected build and runtime workflow.

## Control Room crosswalk

The intended path for scalar object parameters is `Model Explorer -> Objects -> <object> -> Material`;
region membership and local mesh controls are exposed only where the capability register marks them
as supported. Spatial fields, imported-CAD authoring, advanced boolean operations, and unqualified
mesh policies remain Python/ProblemIR-first unless a named Control Room transaction is implemented.
Backend or Python availability must not be interpreted as UI availability.

See {doc}`/frontend/capability-register` for the current support matrix.

## Validation strategy and known limits

Construction and serialization tests are evidence for the typed authoring boundary. They do not
prove mesh quality, solver convergence, CPU/GPU parity, or scientific validity. A backend
qualification for this section must include at least:

1. geometry and source identity, including the imported scale and revision when applicable;
2. resolved region membership and material markers or FDM masks;
3. mesh/grid cardinality, topology, quality, boundary policy, and provenance;
4. material-field location, interpolation, conflict resolution, and precision;
5. interaction-specific observables and refinement or convergence evidence;
6. device and execution-mode evidence when CPU/GPU behavior is claimed.

The current page does not qualify adaptive refinement, arbitrary Python geometry callables, every
boolean/import format, every periodic boundary combination, sampled material-field materialization,
or every mixed FEM topology. Unsupported combinations must fail explicitly rather than silently
fall back to another backend or device.

## Terminal API pages

- {doc}`/python-api/geometry/primitives`
- {doc}`/python-api/geometry/boolean-operations`
- {doc}`/python-api/geometry/transforms`
- {doc}`/python-api/geometry/imported-geometry`
- {doc}`/python-api/geometry/regions`
- {doc}`/python-api/materials/material`
- {doc}`/python-api/materials/spatial-parameter-fields`
- {doc}`/python-api/meshing/fem/regions`
- {doc}`/python-api/problem/problem-ir`

## Bibliography

1. W. F. Brown Jr., *Micromagnetics*, Wiley, 1963.
2. A. Hubert and R. Schafer, *Magnetic Domains*, Springer, 1998.
3. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM, 2002.
4. O. C. Zienkiewicz, R. L. Taylor, and J. Z. Zhu, *The Finite Element Method: Its Basis and
   Fundamentals*, 7th ed., Butterworth-Heinemann, 2013.
5. C. Geuzaine and J.-F. Remacle, "Gmsh: a three-dimensional finite element mesh generator,"
   *International Journal for Numerical Methods in Engineering* **79**, 1309-1331 (2009),
   [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

## Source-code index

| Claim or API | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| primitives, imports, booleans, transforms | `packages/fullmag-py/src/fullmag/model/geometry.py` | `Box`, `Cylinder`, `Ellipsoid`, `Sphere`, `Ellipse`, `ImportedGeometry`, `Difference`, `Union`, `Intersection`, `Translate` | typed geometry and `to_ir()` |
| high-level geometry handle | `packages/fullmag-py/src/fullmag/world.py` | `MagnetHandle`, `StudyBuilder.geometry` | object creation and base material properties |
| object regions and overrides | `packages/fullmag-py/src/fullmag/model/structure.py` | `ObjectRegion` | region identity, material proxy, transitions, local mesh policy |
| base material | `packages/fullmag-py/src/fullmag/model/structure.py` | `Material` | SI validation and material IR |
| analytic and sampled fields | `packages/fullmag-py/src/fullmag/model/structure.py` | `MaterialParameterField`, `MaterialParameterAssignment` | field payload and scoped assignment |
| full problem lowering | `packages/fullmag-py/src/fullmag/model/problem.py` | `Problem.to_ir`, `build_geometry_assets_for_request` | ProblemIR and optional geometry assets |
| shared-domain mesh policy | `packages/fullmag-py/src/fullmag/model/structure.py` and `world.py` | `ObjectRegion.mesh`, `GeometryMeshHandle` | mesh intent before backend realization |

Focused public API evidence includes the region-lowering, boolean-difference, centered-shape,
material-field, and ProblemIR tests in `packages/fullmag-py/tests/test_api.py`. These tests establish
source behavior; they are not a substitute for executed FDM/FEM qualification receipts.
