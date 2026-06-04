# Region-Owned Mesh, Material, and Texture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make named regions the canonical user-facing way to express local mesh refinement, material overrides, and initial texture overrides inside a magnetic object.

**Architecture:** A region is a named spatial selector owned by a parent magnetic object. It does not replace `Geometry`, `Ferromagnet`, or `Material`; instead, mesh/material/texture policies reference the region. Python and UI authoring lower to one canonical `ProblemIR` region-extension model, and the planner realizes it as FEM mesh size fields/domain markers or FDM masks.

**Tech Stack:** Fullmag Python DSL in `packages/fullmag-py`, `ProblemIR` in `crates/fullmag-ir`, planner in `crates/fullmag-plan`, mesh lowering in `packages/fullmag-py/src/fullmag/meshing`, control-room OpenAPI/API/resources in `crates/fullmag-api` and `apps/control-room`.

---

## Current State

Existing region concepts are real but incomplete for this goal:

- `packages/fullmag-py/src/fullmag/model/structure.py` has `Region(name, geometry)` and `Ferromagnet(region=...)`.
- `crates/fullmag-ir/src/model.rs` has `RegionIR { name, geometry }`.
- `/v2/sessions/current/model/regions` exposes `RegionResource` with material/texture-facing fields.
- `runtime_metadata.mesh_workflow.per_geometry[].size_fields` already carries local mesh controls, but as raw Gmsh-ish size fields.
- `docs/physics/0100-mesh-and-region-discretization.md` says regions are topology/ownership labels, not energy terms.
- `docs/physics/regions/0461-multi-region-note-corrected.md` separates `Geometry`, `Region`, `Ferromagnet`, `MaterialLaw`, `ParameterField`, and `Coupling`.

The missing concept is a **region inside a parent object**:

```python
waveguide = study.geometry(
    fm.shapes.arch_waveguide(
        length=3000e-9,
        width=1500e-9,
        height=2e-9,
        arch_height=0.0,
        z0=0.0,
    ),
    name="waveguide",
)
skyrmion_region = waveguide.add_region(
    "skyrmion_core",
    shape=fm.shapes.cylinder(radius=350e-9, height=2e-9, center=(0.0, 0.0, 0.0)),
    translate=(0,0,0), # to move
    rotate=(0,0,0), #rotate or equivalent like for goemetry maybe phi theta? 
)
skyrmion_region.mesh.remesh(
    maximum_element_size=2e-9,
    minimum_element_size=1e-9,
    transition_distance=None,
    order=1,
)
skyrmion_region.m = fm.texture.neel_skyrmion(300e-9, 40e-9, -1, 1, "xy")
```

This should replace public example code like:

```python
waveguide.mesh.size_field(
    "ComponentRestrictedCylinder",
    GeometryName="arch_waveguide_geom",
    VIn=1e-9,
    VOut=10e-9,
    Radius=350e-9,
    XCenter=0.0,
    YCenter=0.0,
    ZCenter=0.0,
)
```

## Design Rules

1. **Region is a semantic selector, not a raw Gmsh field.**
   Public scripts should describe “skyrmion region” instead of “ComponentRestrictedCylinder”.

2. **Object remains the owner of the magnetic field.**
   A region inside `waveguide` can override initial texture or material coefficients, but it does not create a second independent magnet unless the user explicitly creates another `Ferromagnet`.

3. **Region shape is object-local by default.**
   `center=(0,0,0)` means the parent object local coordinate frame. Explicit world-space selectors can come later through `frame="world"` after the object-local path is stable.

4. **Mesh policy, material policy, and texture policy are independent attachments.**
   A region may have only mesh refinement, only material override, only texture override, or any combination.

5. **Overlaps must be deterministic.**
   Region declarations have `priority`; later declarations get higher default priority. Validation reports overlapping material/texture assignments unless priority resolves them.

6. **FDM and FEM lower differently but share intent.**
   FDM lowers regions to masks over cells/nodes; FEM lowers mesh-only regions to size fields and material/texture regions to element/node classification.

7. **Raw `mesh.size_field(...)` remains available as an advanced/debug escape hatch.**
   New examples should prefer `region.mesh.remesh(...)`.

8. **`fm.shapes` is the canonical shape namespace for geometry and regions.**
   The same constructors should be usable for top-level object geometry and object-local region selectors. Context determines lowering:
   `study.geometry(fm.shapes.cylinder(...))` creates a full geometry object, while
   `waveguide.add_region(shape=fm.shapes.cylinder(...))` creates a selector inside the parent object.

9. **Region registries are owner-scoped first, flattened second.**
   The primary registry is `waveguide.regions`; the study-level registry is a read-only flattened view used for lookup,
   UI resources, and script export diagnostics.

10. **Material gradients are parameter fields, not region spam.**
    A named region may host a spatial material field, for example `region.material.Ms = fm.fields.linear(...)`, but a
    smooth gradient must lower as a coefficient field over nodes/elements. It must not be approximated by silently
    generating many hidden regions.

11. **Material interfaces have explicit coupling semantics.**
    Adjacent regions with different `Aex`, `Ms`, DMI, or anisotropy remain one magnetization field unless the user creates
    separate magnets. Exchange across an internal material interface is coupled by default, with explicit per-interface
    overrides for reduced, zero, or custom coupling.

12. **UI editing is first-class authoring.**
    Region creation, deletion, overlap diagnostics, mesh/material/texture policy editing, and script export must round-trip
    through the same `ProblemIR` as Python scripts.

## UI Product Contract

Regions are not hidden mesh fields. They must be visible and manageable as authored children of the owning object.

Explorer tree target:

```text
Objects
  arch_waveguide
    Regions
      skyrmion
      edge_softening
Mesh
  study_domain
    Parts
      airbox
      arch_waveguide
    Region fields
      arch_waveguide/skyrmion
```

The `Objects -> <object> -> Regions` branch is the authoring source of truth. The `Mesh -> Region fields` branch is a
realized/reporting view; it must link back to the authored region and never become the editing source of truth.

Required UI behavior:

- Selecting an object shows an object inspector with a `Regions` section and an `Add Region` command.
- Selecting a region node selects `selection.kind = "object_region"` with `{ ownerObjectId, regionId }`.
- The context menu for a region includes `Rename`, `Duplicate`, `Delete`, `Move priority up`, `Move priority down`,
  `Show/hide overlay`, and `Rebuild mesh`.
- `Add Region` opens a dialog using the shared shape catalog (`fm.shapes` concepts): shape kind, dimensions, center,
  frame, priority, and optional initial mesh/material/texture attachments.
- Deleting a region is a semantic delete. The confirmation dialog must list attached mesh/material/texture policies and
  remove them with the region. It must not leave orphan size fields or texture references.
- The region inspector has tabs or sections for identity, shape, mesh policy, material override, texture override,
  interface/coupling policy, diagnostics/provenance, and realized mesh quality.
- Viewport rendering shows object-local region overlays: translucent fill, wire outline, selected-region highlight, and
  overlap warning hatch. Hovering/selecting a region in the Explorer highlights the same region in the viewport.
- Mesh histograms and quality panels can filter to an authored region or realized region field. Hovering a histogram bin
  highlights only matching elements within the selected scope.
- Mesh rebuild progress uses the existing overlay/module path (`MeshBuildDialog`) and reports the region(s) that triggered
  invalidation, the planned size-field stack, current meshing phase, and latest failure reason.

## Region Registry and Conflict Contract

Python registry target:

```python
skyrmion = waveguide.add_region("skyrmion", shape=fm.shapes.cylinder(radius=350e-9, height=2e-9))

waveguide.regions["skyrmion"] is skyrmion
waveguide.regions[0] is skyrmion
list(waveguide.regions) == [skyrmion]

study.regions["arch_waveguide/skyrmion"] is skyrmion
study.regions[0] is skyrmion
```

Registry rules:

- `RegionHandle.region_id` is stable and opaque. `RegionHandle.name` is the user label and script-export identifier.
- `waveguide.regions[...]` is mutable only through object methods: `add_region`, `remove_region`, `rename_region`, and
  `reorder_region`.
- `study.regions[...]` is a read-only flattened view. It accepts `"<owner>/<name>"`, stable `region_id`, or integer index.
- `waveguide.remove_region("skyrmion")` and `skyrmion.delete()` are equivalent. Both remove attached mesh/material/texture
  policies and invalidate derived mesh/runtime resources.
- Renaming a region updates name-based references in the current authoring model. Stable internal references use
  `region_id`, so rename does not break existing selection or runtime diagnostics.
- Duplicate names are invalid inside one owner object. The same region name may exist under two different objects and is
  addressed as `owner/name` in flattened views.

Overlap rules:

- Mesh policies combine by choosing the smallest requested element size at each point; equal priority is allowed for mesh.
- Material and texture overrides are property-level. If two overlapping regions assign the same property, higher priority
  wins.
- Equal-priority overlap for the same material coefficient or texture is a validation error.
- Overlap between different assigned properties is allowed and reported as informational.
- Interface/coupling overrides are pairwise and must name both regions or one region and the parent/background material.

## Physics Lessons and Boundary Contract

External solver audit findings to preserve in the Fullmag design:

- Mumax+ uses integer region labels for cells and lets material parameters be set globally, per cell/function, or with
  `set_in_region(...)` (`external_solvers/plus/mumaxplus/parameter.py`). Inter-region exchange is an explicit
  `InterParameter`; if no inter-region exchange is set, the exchange stiffness between neighboring cells falls back to the
  harmonic mean of both local `Aex` values, and `scale_exchange.set_between(i, j, 0)` disables exchange across that region
  interface (`external_solvers/plus/mumaxplus/ferromagnet.py`, `external_solvers/plus/src/physics/dmi.hpp`).
- Mumax+ applies the same pattern in the CUDA exchange kernel: for neighboring cells in different regions it reads
  `inter_exchange` and `scale_exchange`; otherwise it uses local `aex` values and the harmonic mean
  (`external_solvers/plus/src/physics/exchange.cu`).
- Tetrax separates material management into `SampleMaterial` and `MaterialParameter`; non-global scalar parameters are
  `MeshScalar` arrays, so `Msat` and `Aex` can be spatially inhomogeneous without creating region labels
  (`external_solvers/tetrax/tetrax/sample/material/parameter.py`,
  `external_solvers/tetrax/doc/usage/sample.rst`).
- Tetrax exchange is formulated as `div(A grad m)` with spatial `Aex` and local `Msat` entering the assembled operator
  (`external_solvers/tetrax/tetrax/interactions/exchange.py`). Its DMI implementation also treats physical boundary
  conditions explicitly rather than hiding them behind region assignment (`external_solvers/tetrax/doc/new_in_v2.rst`).

Fullmag policy:

- One object with two regions is still one magnetization field `m`. There is no discontinuity in `m` at an internal material
  interface unless the user explicitly authors separate magnetic bodies or a future contact model that permits it.
- For FEM, piecewise or spatial material coefficients enter the weak form as coefficient fields. The natural interface
  condition for exchange is continuity of exchange flux, `A partial_n m`, across conforming internal material interfaces.
- For FDM, nearest-neighbor heterogeneous exchange uses the same default coefficient rule as Mumax+: harmonic mean of
  neighboring local `Aex` values, multiplied by an optional pairwise scale. This gives a clear default and a way to express
  no exchange or reduced exchange.
- `Ms(x)` gradients are allowed coefficient fields. The magnetization direction remains a unit field `m`; full
  magnetization is `M = Ms(x) m`.
- Air/nonmagnetic space is not an `m` region. Exchange and region-local material overrides only apply inside magnetic
  bodies. Demag and external fields can live in the airbox, but `m`, `Ms`, `Aex`, anisotropy, and DMI material parameters
  do not.
- DMI boundary/interface behavior needs its own explicit policy and physics note update. Do not infer DMI interface
  behavior from the exchange default.

## Public Python API Target

### Minimal script target

```python
waveguide = study.geometry(
    fm.shapes.arch_waveguide(
        length=3000e-9,
        width=1500e-9,
        height=2e-9,
        arch_height=0.0,
        z0=0.0,
        name="arch_waveguide",
    ),
    name="arch_waveguide",
)

waveguide.mesh(
    maximum_element_size=10e-9,
    minimum_element_size=2e-9,
    transition_distance=120e-9,
    order=1,
)

skyrmion = waveguide.add_region(
    "skyrmion",
    shape=fm.shapes.cylinder(
        radius=350e-9,
        height=2e-9,
        center=(0.0, 0.0, 0.0),
    ),
)
skyrmion.mesh.remesh(
    maximum_element_size=1e-9,
    minimum_element_size=1e-9,
    transition_distance=80e-9,
)
skyrmion.m = fm.texture.neel_skyrmion(300e-9, 40e-9, -1, 1, "xy")
```

### Material override target

```python
edge = waveguide.add_region(
    "edge_softening",
    shape=fm.shapes.box(
        size=(3000e-9, 120e-9, 2e-9),
        center=(0.0, 690e-9, 0.0),
    ),
)
edge.material.Ms = 6.5e5
edge.material.Aex = 8e-12
edge.material.Ku1 = 390e3
```

### Explicit conflict resolution target

```python
core = waveguide.add_region(
    "core",
    shape=fm.shapes.cylinder(radius=80e-9, height=2e-9),
    priority=20,
)
shell = waveguide.add_region(
    "shell",
    shape=fm.shapes.cylinder(radius=350e-9, height=2e-9),
    priority=10,
)
```

The higher priority region wins where both regions assign the same property.

---

## Files and Responsibilities

### Documentation

- Modify: `docs/physics/0100-mesh-and-region-discretization.md`
  - Add object-local subregions and policy attachments.
- Create: `docs/specs/region-owned-authoring-v1.md`
  - Canonical API/IR/UI contract for region-owned mesh/material/texture.
- Modify: `docs/specs/fullmag-application-architecture-v2.md`
  - Update Python API examples and `ProblemIR` stack text.

### Python DSL

- Modify: `packages/fullmag-py/src/fullmag/model/geometry.py`
  - Add the canonical `fm.shapes` namespace backed by the same shape classes used for full geometry and region selectors.
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
  - Export `shapes` namespace once stable.
- Modify: `packages/fullmag-py/src/fullmag/world.py`
  - Add `MagnetHandle.add_region(...)`, `RegionHandle`, `RegionMeshHandle`, and lowering into runtime metadata.
- Modify: `packages/fullmag-py/src/fullmag/model/structure.py`
  - Add typed region policy dataclasses.
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
  - Export canonical scripts using `waveguide.add_region(...)`.

### ProblemIR and Planner

- Modify: `crates/fullmag-ir/src/model.rs`
  - Extend `RegionIR` or add `ObjectRegionIR`.
- Modify: `crates/fullmag-ir/src/lib.rs`
  - Validate region ownership, shapes, priorities, and references.
- Modify: `crates/fullmag-plan/src/fem.rs`
  - Lower region material/texture maps and mesh-refinement intent.
- Modify: `crates/fullmag-plan/src/fdm.rs`
  - Lower region masks for future FDM parity.
- Modify: `crates/fullmag-plan/src/tests.rs`
  - Add canonical planning tests.

### Meshing

- Modify: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`
  - Convert region mesh policies to component-restricted size fields.
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`
  - Prefer semantic field labels in realized reports.
- Modify: `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`
  - Report region-owned fields as region-owned realized size fields.
- Modify: `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`
  - Carry region selectors into shared-domain mesh generation.

### API and UI

- Modify: `crates/fullmag-api/src/schemas/authoring.rs`
  - Extend `RegionResource`, region registry summaries, overlap diagnostics, and patch requests.
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
  - Keep typed region create/update/delete/reorder operations through central API facade.
- Modify: `apps/control-room/src/kernel/resources/geometryLifecycleResources.ts`
  - Add region registry resource hooks and invalidation wiring.
- Modify: `apps/control-room/src/kernel/selection/selectionTypes.ts`
  - Add object-region selection identity.
- Modify: `apps/control-room/src/kernel/authoring/geometryLifecycleCommands.ts`
  - Add add/delete/rename/duplicate/reorder region commands.
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
  - Render `Objects -> <object> -> Regions -> <region>` authoring nodes.
- Modify: `apps/control-room/src/modules/explorer/explorerSelection.ts`
  - Map region tree nodes to canonical object-region selection.
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`
  - Move local refinement editing from raw size fields toward region policies.
- Create or modify: `apps/control-room/src/modules/inspector/panels/ObjectRegionPolicyPanel.tsx`
  - Inspector for region identity, shape, mesh, material, texture, coupling, diagnostics, and realized mesh quality.
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanel.tsx`
  - Add region list, add/delete/reorder commands, and overlap diagnostics.
- Modify: `apps/control-room/src/modules/overlay/MeshBuildDialog.tsx`
  - Show region-triggered mesh rebuild progress and failure diagnostics.
- Modify: `apps/control-room/src/modules/viewport-3d/*`
  - Render region overlays, overlap hatching, selection targets, and mesh-quality histogram highlighting scoped by region.

---

## Task 1: Specify Region Semantics

**Files:**
- Modify: `docs/physics/0100-mesh-and-region-discretization.md`
- Create: `docs/specs/region-owned-authoring-v1.md`

- [ ] **Step 1: Add failing documentation check**

Run:

```bash
rg -n "object-local subregion|region-owned mesh|RegionMeshPolicy" docs/physics/0100-mesh-and-region-discretization.md docs/specs/region-owned-authoring-v1.md
```

Expected before implementation:

```text
rg: docs/specs/region-owned-authoring-v1.md: No such file or directory
```

- [ ] **Step 2: Extend the physics note**

Add this section to `docs/physics/0100-mesh-and-region-discretization.md` after section `3.2 FEM`:

```markdown
### 3.2.1 Object-local subregions

An object-local subregion is a named spatial selector inside one parent magnetic
object. It is used for topology labeling, mesh refinement intent, piecewise
material assignment, and initial-condition assignment. It is not an energy term
and it does not create a separate magnetization field unless a separate magnetic
body is authored.

Subregion coordinates are object-local by default. Backends lower the same intent
differently:

- FDM: selector masks over cells or nodes.
- FEM: mesh-only selectors become background size fields; material or texture
  selectors become element/node classification maps and, where needed, domain
  markers.

Overlapping assignments must be deterministic. Region priority resolves conflicts
for the same assigned property. If two overlapping regions assign the same
property with the same priority, validation fails.

Material gradients are coefficient fields, not hidden region tessellations. A
region may bind a spatial field such as `Ms(x)` or `Aex(x)`, but the lowered
model stores this as a parameter field over cells, nodes, or elements.

For one magnetic object split into multiple material regions, the magnetization
direction field remains one continuous unknown unless the user authors separate
magnetic bodies. FEM exchange uses spatial coefficients in the weak form and
therefore enforces the natural internal-interface exchange-flux condition. FDM
exchange across neighboring material cells uses the harmonic mean of local `Aex`
values by default, with an explicit pairwise interface scale/override for reduced
or zero exchange.

Airbox space is not a magnetic region. It may carry demag/external-field
quantities, but not `m`, `Ms`, `Aex`, anisotropy, or DMI material coefficients.
```

- [ ] **Step 3: Create the spec file**

Create `docs/specs/region-owned-authoring-v1.md`:

```markdown
# Region-Owned Authoring V1

## Goal

Make regions the public authoring abstraction for local mesh refinement,
piecewise material overrides, and region-specific initial magnetization textures.

## Canonical Concepts

- `Geometry`: object shape or standalone shape asset.
- `Ferromagnet`: magnetic body and owner of the magnetization field.
- `ObjectRegion`: object-local spatial selector owned by one `Ferromagnet`.
- `RegionMeshPolicy`: local mesh refinement intent bound to an `ObjectRegion`.
- `RegionMaterialOverride`: material coefficient overrides bound to an `ObjectRegion`.
- `RegionTextureOverride`: initial magnetization override bound to an `ObjectRegion`.

## Python DSL

```python
waveguide = study.geometry(
    fm.shapes.arch_waveguide(length=3e-6, width=1.5e-6, height=2e-9),
    name="waveguide",
)
region = waveguide.add_region(
    "skyrmion",
    shape=fm.shapes.cylinder(radius=350e-9, height=2e-9, center=(0.0, 0.0, 0.0)),
)
region.mesh.remesh(maximum_element_size=1e-9, minimum_element_size=1e-9)
region.m = fm.texture.neel_skyrmion(300e-9, 40e-9, -1, 1, "xy")
```

## Precedence

Parent object values apply first. Region overrides apply in ascending priority.
Later declarations receive higher default priority. Equal-priority overlapping
regions cannot assign the same material coefficient or texture.

Mesh policies combine by minimum requested size. Material and texture overrides
combine by property and priority. Equal-priority overlap is allowed only when
the overlapping regions do not assign the same material coefficient or texture.

## Registry

The owner object exposes the mutable registry:

```python
waveguide.regions["skyrmion"]
waveguide.regions[0]
waveguide.remove_region("skyrmion")
```

The study exposes a read-only flattened registry:

```python
study.regions["arch_waveguide/skyrmion"]
study.regions[0]
```

Each region has a stable opaque `region_id` plus a mutable user-facing `name`.
Canonical script export uses names; internal selections, API patches, runtime
reports, and mesh provenance use stable ids.

## UI Contract

Regions appear in the Explorer under their owner object:

```text
Objects
  arch_waveguide
    Regions
      skyrmion
      edge_softening
```

Selecting a region opens a region inspector with identity, shape, mesh policy,
material override, texture override, interface/coupling policy, diagnostics, and
realized mesh quality sections. The object inspector exposes `Add Region`.
Region context menus expose rename, duplicate, delete, priority reorder,
overlay visibility, and rebuild mesh commands. The viewport renders region
overlays and overlap warnings, and mesh quality histograms can filter/highlight
elements scoped to the selected region.

## Physics Boundary Contract

Region material overrides remain within one magnetization field. Adjacent
regions with different `Ms` or `Aex` do not create two independent magnets.
`Ms(x)` gradients are represented as material parameter fields, and full
magnetization is `M = Ms(x) m` while `m` remains a unit direction field.

Default exchange coupling across internal FDM material interfaces uses the
harmonic mean of neighboring local `Aex` values, with explicit pairwise scale or
override for reduced, zero, or custom coupling. FEM uses spatial coefficient
fields in the exchange weak form and keeps the natural internal exchange-flux
continuity condition. DMI interface behavior is intentionally separate and must
be specified in the physics note before implementation.

## Mesh Lowering

Region-owned mesh policies lower to backend-neutral IR first. FEM planners lower
them to component-restricted size fields or domain markers. FDM planners lower
them to masks and local resolution/adaptive-remesh hints where supported.

## Unified Shape Namespace

`fm.shapes` is the canonical constructor namespace for both top-level geometry
and object-local region selectors. The namespace wraps the same shape classes as
the legacy public constructors:

- `fm.shapes.box(...)` -> `fm.Box` or `fm.Translate(fm.Box(...), center)`
- `fm.shapes.cylinder(...)` -> `fm.Cylinder` or `fm.Translate(fm.Cylinder(...), center)`
- `fm.shapes.arch_waveguide(...)` -> `fm.ArchWaveguide`
- `fm.shapes.sin_waveguide(...)` -> `fm.SinWaveguide`
- `fm.shapes.ellipsoid(...)` -> `fm.Ellipsoid`
- `fm.shapes.sphere(...)` -> `fm.Sphere`
- `fm.shapes.ellipse(...)` -> `fm.Ellipse`
- `fm.shapes.imported(...)` -> `fm.ImportedGeometry`
- `fm.shapes.difference(a, b)` -> `fm.Difference`
- `fm.shapes.union(a, b)` -> `fm.Union`
- `fm.shapes.intersection(a, b)` -> `fm.Intersection`
- `fm.shapes.translate(shape, offset)` -> `fm.Translate`

The legacy classes remain compatibility aliases. New examples and canonical
script export should prefer `fm.shapes`.

## Non-Goals

- No per-region independent time stepping.
- No hidden separate magnet unless the user creates a separate `Ferromagnet`.
- No public dependence on Gmsh field names.
```

- [ ] **Step 4: Verify docs**

Run:

```bash
rg -n "object-local subregion|region-owned mesh|RegionMeshPolicy" docs/physics/0100-mesh-and-region-discretization.md docs/specs/region-owned-authoring-v1.md
```

Expected:

```text
docs/physics/0100-mesh-and-region-discretization.md:...
docs/specs/region-owned-authoring-v1.md:...
```

---

## Task 2: Add IR for Object-Local Regions

**Files:**
- Modify: `crates/fullmag-ir/src/model.rs`
- Modify: `crates/fullmag-ir/src/lib.rs`
- Test: `crates/fullmag-ir/tests/ir_tests.rs`

- [ ] **Step 1: Write failing IR round-trip test**

Add to `crates/fullmag-ir/tests/ir_tests.rs`:

```rust
#[test]
fn object_region_round_trips_mesh_material_and_texture_intent() {
    let json = serde_json::json!({
        "ir_version": "0.2.0",
        "problem_meta": {"name": "region_test", "script_language": "python"},
        "geometry": {
            "entries": [{
                "kind": "box",
                "name": "waveguide_geom",
                "size": [3e-6, 1.5e-6, 2e-9],
                "center": [0.0, 0.0, 0.0]
            }]
        },
        "regions": [{"name": "waveguide", "geometry": "waveguide_geom"}],
        "object_regions": [{
            "name": "skyrmion",
            "owner": "waveguide",
            "shape": {
                "kind": "cylinder",
                "radius": 3.5e-7,
                "height": 2e-9,
                "center": [0.0, 0.0, 0.0],
                "frame": "object"
            },
            "priority": 10,
            "mesh": {
                "maximum_element_size": 1e-9,
                "minimum_element_size": 1e-9,
                "transition_distance": 8e-8,
                "order": 1
            },
            "material": {"saturation_magnetisation": 7.0e5},
            "initial_magnetization": {
                "kind": "preset_texture",
                "preset_kind": "neel_skyrmion",
                "preset_params": {
                    "radius": 3e-7,
                    "wall_width": 4e-8,
                    "chirality": -1,
                    "core_polarity": 1,
                    "plane": "xy"
                }
            }
        }],
        "materials": [{
            "name": "mat",
            "saturation_magnetisation": 7.7e5,
            "exchange_stiffness": 1e-11,
            "damping": 0.1
        }],
        "magnets": [{
            "name": "waveguide",
            "region": "waveguide",
            "material": "mat"
        }],
        "energy_terms": [],
        "study": {"kind": "relaxation"},
        "backend_policy": {"requested_backend": "fem"},
        "validation_profile": {"execution_mode": "strict"}
    });

    let problem: fullmag_ir::ProblemIR = serde_json::from_value(json).unwrap();
    problem.validate().unwrap();
    assert_eq!(problem.object_regions.len(), 1);
    assert_eq!(problem.object_regions[0].name, "skyrmion");
    assert_eq!(
        problem.object_regions[0]
            .mesh
            .as_ref()
            .unwrap()
            .maximum_element_size,
        1e-9
    );
}
```

- [ ] **Step 2: Run failing test**

Run:

```bash
cargo test -p fullmag-ir object_region_round_trips_mesh_material_and_texture_intent
```

Expected before implementation:

```text
error[E0609]: no field `object_regions` on type `ProblemIR`
```

- [ ] **Step 3: Add IR structs**

Add to `crates/fullmag-ir/src/model.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ObjectRegionShapeIR {
    Cylinder {
        radius: f64,
        height: f64,
        #[serde(default)]
        center: [f64; 3],
        #[serde(default = "default_object_frame")]
        frame: String,
    },
    Box {
        size: [f64; 3],
        #[serde(default)]
        center: [f64; 3],
        #[serde(default = "default_object_frame")]
        frame: String,
    },
}

fn default_object_frame() -> String {
    "object".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ObjectRegionMeshPolicyIR {
    pub maximum_element_size: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_element_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_distance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ObjectRegionMaterialOverrideIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saturation_magnetisation: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_stiffness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub damping: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uniaxial_anisotropy: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interfacial_dmi: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ObjectRegionIR {
    pub name: String,
    pub owner: String,
    pub shape: ObjectRegionShapeIR,
    #[serde(default)]
    pub priority: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh: Option<ObjectRegionMeshPolicyIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<ObjectRegionMaterialOverrideIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_magnetization: Option<InitialMagnetizationIR>,
}
```

- [ ] **Step 4: Add `ProblemIR.object_regions`**

Modify `ProblemIR` in `crates/fullmag-ir/src/lib.rs`:

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub object_regions: Vec<ObjectRegionIR>,
```

Also add the field to wire serialization/deserialization and `ProblemIR::minimal`.

- [ ] **Step 5: Add validation**

In `ProblemIR::validate`, add checks:

```rust
let magnet_names: BTreeSet<&str> = self.magnets.iter().map(|m| m.name.as_str()).collect();
let mut object_region_keys = BTreeSet::new();
for region in &self.object_regions {
    if region.name.trim().is_empty() {
        errors.push("object_region name must not be empty".to_string());
    }
    if !magnet_names.contains(region.owner.as_str()) {
        errors.push(format!(
            "object_region '{}' references missing owner magnet '{}'",
            region.name, region.owner
        ));
    }
    if !object_region_keys.insert((region.owner.as_str(), region.name.as_str())) {
        errors.push(format!(
            "object_region '{}' is duplicated for owner '{}'",
            region.name, region.owner
        ));
    }
    match &region.shape {
        ObjectRegionShapeIR::Cylinder { radius, height, frame, .. } => {
            if *radius <= 0.0 || !radius.is_finite() {
                errors.push(format!("object_region '{}' cylinder radius must be positive", region.name));
            }
            if *height <= 0.0 || !height.is_finite() {
                errors.push(format!("object_region '{}' cylinder height must be positive", region.name));
            }
            if frame != "object" {
                errors.push(format!("object_region '{}' frame must be 'object'", region.name));
            }
        }
        ObjectRegionShapeIR::Box { size, frame, .. } => {
            if size.iter().any(|value| *value <= 0.0 || !value.is_finite()) {
                errors.push(format!("object_region '{}' box size components must be positive", region.name));
            }
            if frame != "object" {
                errors.push(format!("object_region '{}' frame must be 'object'", region.name));
            }
        }
    }
}
```

- [ ] **Step 6: Run IR tests**

Run:

```bash
cargo test -p fullmag-ir object_region_round_trips_mesh_material_and_texture_intent
```

Expected:

```text
test object_region_round_trips_mesh_material_and_texture_intent ... ok
```

---

## Task 3: Add Python DSL Region Handles

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/model/geometry.py`
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
- Test: `packages/fullmag-py/tests/test_region_owned_authoring.py`

- [ ] **Step 1: Write failing Python DSL test**

Create `packages/fullmag-py/tests/test_region_owned_authoring.py`:

```python
from __future__ import annotations

import fullmag as fm
from fullmag.runtime.loader import load_problem_from_script


def test_region_owned_mesh_and_texture_lower_to_ir(tmp_path):
    script = tmp_path / "region_script.py"
    script.write_text(
        """
import fullmag as fm

study = fm.study("region_test")
study.engine("fem")
waveguide = study.geometry(
    fm.shapes.arch_waveguide(length=3e-6, width=1.5e-6, height=2e-9, arch_height=0.0, z0=0.0),
    name="waveguide",
)
waveguide.Ms = 7.7e5
waveguide.Aex = 1e-11
waveguide.alpha = 0.1
waveguide.mesh(maximum_element_size=10e-9, minimum_element_size=2e-9, order=1)
skyrmion = waveguide.add_region(
    "skyrmion",
    shape=fm.shapes.cylinder(radius=350e-9, height=2e-9, center=(0.0, 0.0, 0.0)),
)
skyrmion.mesh.remesh(maximum_element_size=1e-9, minimum_element_size=1e-9, transition_distance=80e-9)
skyrmion.m = fm.texture.neel_skyrmion(300e-9, 40e-9, -1, 1, "xy")
study.build_domain_mesh()
""",
        encoding="utf-8",
    )

    loaded = load_problem_from_script(script, lightweight_assets=True)
    ir = loaded.to_ir(backend="fem", mode="strict", precision="double")
    regions = ir.runtime_metadata["mesh_workflow"]["per_geometry"][0]["object_regions"]
    assert regions[0]["name"] == "skyrmion"
    assert regions[0]["mesh"]["maximum_element_size"] == 1e-9
    assert regions[0]["initial_magnetization"]["preset_kind"] == "neel_skyrmion"
```

- [ ] **Step 2: Run failing test**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src pytest packages/fullmag-py/tests/test_region_owned_authoring.py -q
```

Expected before implementation:

```text
AttributeError: module 'fullmag' has no attribute 'shapes'
```

- [ ] **Step 3: Add unified shape namespace**

In `packages/fullmag-py/src/fullmag/model/geometry.py`, keep the existing geometry classes as the concrete shape model and add a namespace that constructs them:

```python
class _ShapesNamespace:
    def box(
        self,
        *,
        size: tuple[float, float, float],
        center: tuple[float, float, float] = (0.0, 0.0, 0.0),
        name: str = "box",
    ) -> Geometry:
        shape = Box(size=size, name=name)
        return shape if center == (0.0, 0.0, 0.0) else Translate(shape, center)

    def cylinder(
        self,
        *,
        radius: float,
        height: float,
        center: tuple[float, float, float] = (0.0, 0.0, 0.0),
        name: str = "cylinder",
    ) -> Geometry:
        shape = Cylinder(radius=radius, height=height, name=name)
        return shape if center == (0.0, 0.0, 0.0) else Translate(shape, center)

    def arch_waveguide(
        self,
        *,
        length: float,
        width: float,
        height: float,
        arch_height: float = 0.0,
        z0: float = 0.0,
        name: str = "arch_waveguide",
    ) -> ArchWaveguide:
        return ArchWaveguide(
            length=length,
            width=width,
            height=height,
            arch_height=arch_height,
            z0=z0,
            name=name,
        )

    def sin_waveguide(
        self,
        *,
        length: float,
        width: float,
        height: float,
        period: float,
        amplitude: float,
        phase: float = 0.0,
        z0: float = 0.0,
        name: str = "sin_waveguide",
    ) -> SinWaveguide:
        return SinWaveguide(
            length=length,
            width=width,
            height=height,
            period=period,
            amplitude=amplitude,
            phase=phase,
            z0=z0,
            name=name,
        )

    def ellipsoid(
        self,
        *,
        rx: float,
        ry: float,
        rz: float,
        name: str = "ellipsoid",
    ) -> Ellipsoid:
        return Ellipsoid(rx=rx, ry=ry, rz=rz, name=name)

    def sphere(
        self,
        *,
        radius: float,
        center: tuple[float, float, float] = (0.0, 0.0, 0.0),
        name: str = "sphere",
    ) -> Geometry:
        shape = Sphere(radius=radius, name=name)
        return shape if center == (0.0, 0.0, 0.0) else Translate(shape, center)

    def ellipse(
        self,
        *,
        rx: float,
        ry: float,
        height: float,
        center: tuple[float, float, float] = (0.0, 0.0, 0.0),
        name: str = "ellipse",
    ) -> Geometry:
        shape = Ellipse(rx=rx, ry=ry, height=height, name=name)
        return shape if center == (0.0, 0.0, 0.0) else Translate(shape, center)

    def imported(
        self,
        *,
        source: str,
        scale: float | tuple[float, float, float] = 1.0,
        units: str | None = None,
        volume: str = "full",
        name: str | None = None,
    ) -> ImportedGeometry:
        return ImportedGeometry(source=source, scale=scale, units=units, volume=volume, name=name)

    def difference(self, base: Geometry, tool: Geometry, *, name: str = "difference") -> Difference:
        return Difference(base=base, tool=tool, name=name)

    def union(self, a: Geometry, b: Geometry, *, name: str = "union") -> Union:
        return Union(a=a, b=b, name=name)

    def intersection(self, a: Geometry, b: Geometry, *, name: str = "intersection") -> Intersection:
        return Intersection(a=a, b=b, name=name)

    def translate(
        self,
        shape: Geometry,
        offset: tuple[float, float, float],
        *,
        name: str = "translate",
    ) -> Translate:
        return Translate(geometry=shape, offset=offset, name=name)


shapes = _ShapesNamespace()
```

The method signatures must be adjusted to the exact constructors already present
in `packages/fullmag-py/src/fullmag/model/geometry.py`. Do not invent a second
shape model for regions. For region lowering, normalize these existing shape
objects into selector IR:

```python
def _shape_to_object_region_shape_ir(shape: object) -> dict[str, object]:
    if isinstance(shape, Cylinder):
        return {
            "kind": "cylinder",
            "radius": shape.radius,
            "height": shape.height,
            "center": [0.0, 0.0, 0.0],
            "frame": "object",
        }
    if isinstance(shape, Box):
        return {
            "kind": "box",
            "size": list(shape.size),
            "center": [0.0, 0.0, 0.0],
            "frame": "object",
        }
    if isinstance(shape, Translate):
        inner = _shape_to_object_region_shape_ir(shape.geometry)
        inner["center"] = list(shape.offset)
        return inner
    raise TypeError("region shape must be a primitive object-local shape")
```

- [ ] **Step 3a: Add shape namespace coverage test**

Add to `packages/fullmag-py/tests/test_region_owned_authoring.py`:

```python
def test_shapes_namespace_covers_existing_public_geometry_classes():
    assert isinstance(fm.shapes.box(size=(1e-9, 2e-9, 3e-9)), fm.Box)
    assert isinstance(fm.shapes.cylinder(radius=1e-9, height=2e-9), fm.Cylinder)
    assert isinstance(
        fm.shapes.cylinder(radius=1e-9, height=2e-9, center=(1e-9, 0.0, 0.0)),
        fm.Translate,
    )
    assert isinstance(
        fm.shapes.arch_waveguide(length=3e-6, width=1e-6, height=2e-9, arch_height=0.0),
        fm.ArchWaveguide,
    )
    assert isinstance(
        fm.shapes.sin_waveguide(
            length=3e-6,
            width=1e-6,
            height=2e-9,
            period=500e-9,
            amplitude=10e-9,
        ),
        fm.SinWaveguide,
    )
    assert isinstance(fm.shapes.ellipsoid(rx=1e-9, ry=2e-9, rz=3e-9), fm.Ellipsoid)
    assert isinstance(fm.shapes.sphere(radius=1e-9), fm.Ellipsoid)
    assert isinstance(fm.shapes.ellipse(rx=1e-9, ry=2e-9, height=1e-9), fm.Ellipse)
    box = fm.shapes.box(size=(1e-9, 1e-9, 1e-9))
    cutter = fm.shapes.cylinder(radius=0.25e-9, height=1e-9)
    assert isinstance(fm.shapes.difference(box, cutter), fm.Difference)
    assert isinstance(fm.shapes.union(box, cutter), fm.Union)
    assert isinstance(fm.shapes.intersection(box, cutter), fm.Intersection)
    assert isinstance(fm.shapes.translate(box, (1e-9, 0.0, 0.0)), fm.Translate)
```

- [ ] **Step 4: Export `shapes`**

In `packages/fullmag-py/src/fullmag/__init__.py`:

```python
from .model.geometry import shapes
```

Add `"shapes"` to `__all__`.

- [ ] **Step 5: Add region handles**

In `packages/fullmag-py/src/fullmag/world.py`, add:

```python
@dataclass
class _ObjectRegionSpec:
    name: str
    shape: object
    priority: int
    mesh: dict[str, object] | None = None
    material: dict[str, object] = field(default_factory=dict)
    initial_magnetization: object | None = None


class RegionMeshHandle:
    def __init__(self, region: "RegionHandle") -> None:
        self._region = region

    def remesh(
        self,
        *,
        maximum_element_size: float,
        minimum_element_size: float | None = None,
        transition_distance: float | None = None,
        order: int | None = None,
    ) -> "RegionMeshHandle":
        self._region._spec.mesh = {
            "maximum_element_size": float(maximum_element_size),
            "minimum_element_size": None if minimum_element_size is None else float(minimum_element_size),
            "transition_distance": None if transition_distance is None else float(transition_distance),
            "order": order,
        }
        return self


class RegionMaterialOverrideHandle:
    def __init__(self, region: "RegionHandle") -> None:
        object.__setattr__(self, "_region", region)

    def __setattr__(self, name: str, value: object) -> None:
        self._region._spec.material[name] = value


class RegionHandle:
    def __init__(self, owner: "MagnetHandle", spec: _ObjectRegionSpec) -> None:
        object.__setattr__(self, "_owner", owner)
        object.__setattr__(self, "_spec", spec)
        object.__setattr__(self, "mesh", RegionMeshHandle(self))
        object.__setattr__(self, "material", RegionMaterialOverrideHandle(self))

    def __setattr__(self, name: str, value: object) -> None:
        if name == "m":
            self._spec.initial_magnetization = value
            return
        object.__setattr__(self, name, value)
```

Add to `MagnetHandle`:

```python
def add_region(self, name: str, *, shape: object, priority: int | None = None) -> RegionHandle:
    specs = self._region_specs
    resolved_priority = int(priority) if priority is not None else len(specs)
    spec = _ObjectRegionSpec(name=name, shape=shape, priority=resolved_priority)
    specs.append(spec)
    return RegionHandle(self, spec)
```

For top-level geometry, `study.geometry(fm.shapes.arch_waveguide(...), name="waveguide")` must remain equivalent to `study.geometry(fm.ArchWaveguide(...), name="waveguide")`.

- [ ] **Step 6: Lower region specs to runtime metadata**

Where `world.py` builds `mesh_workflow.per_geometry`, add:

```python
if handle._region_specs:
    entry["object_regions"] = [
        {
            "name": region.name,
            "shape": region.shape.to_ir(),
            "priority": region.priority,
            "mesh": region.mesh,
            "material": dict(region.material),
            "initial_magnetization": (
                region.initial_magnetization.to_ir()
                if region.initial_magnetization is not None
                else None
            ),
        }
        for region in handle._region_specs
    ]
```

- [ ] **Step 7: Run Python DSL test**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src pytest packages/fullmag-py/tests/test_region_owned_authoring.py -q
```

Expected:

```text
1 passed
```

---

## Task 4: Lower Region Mesh Policies to Size Fields

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`
- Test: `packages/fullmag-py/tests/test_region_owned_mesh_lowering.py`

- [ ] **Step 1: Write failing lowering test**

Create `packages/fullmag-py/tests/test_region_owned_mesh_lowering.py`:

```python
from fullmag.meshing._size_field_plan import _mesh_options_from_runtime_metadata


def test_object_region_cylinder_mesh_policy_lowers_to_component_restricted_cylinder():
    metadata = {
        "mesh_workflow": {
            "default_mesh": {"algorithm_3d": 1},
            "per_geometry": [{
                "geometry": "waveguide",
                "mode": "custom",
                "hmax": 10e-9,
                "hmin": 2e-9,
                "object_regions": [{
                    "name": "skyrmion",
                    "shape": {
                        "kind": "cylinder",
                        "radius": 350e-9,
                        "height": 2e-9,
                        "center": [0.0, 0.0, 0.0],
                        "frame": "object",
                    },
                    "mesh": {
                        "maximum_element_size": 1e-9,
                        "minimum_element_size": 1e-9,
                        "transition_distance": 80e-9,
                        "order": 1,
                    },
                }],
            }],
        }
    }

    options = _mesh_options_from_runtime_metadata(metadata, include_size_fields=True)
    fields = [field for field in options.size_fields if field["kind"] == "ComponentRestrictedCylinder"]
    assert fields
    assert fields[0]["params"]["GeometryName"] == "waveguide_geom"
    assert fields[0]["params"]["VIn"] == 1e-9
    assert fields[0]["params"]["VOut"] == 10e-9
    assert fields[0]["params"]["Radius"] == 350e-9
    assert fields[0]["region"] == "skyrmion"
```

- [ ] **Step 2: Run failing test**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src pytest packages/fullmag-py/tests/test_region_owned_mesh_lowering.py -q
```

Expected before implementation:

```text
AssertionError: assert []
```

- [ ] **Step 3: Implement cylinder lowering**

In `_size_field_plan.py`, when reading each `per_geometry` entry, process `object_regions`:

```python
def _region_mesh_size_fields(entry: Mapping[str, object], *, geometry_name: str, object_hmax: float) -> list[dict[str, object]]:
    fields: list[dict[str, object]] = []
    for region in entry.get("object_regions", []) or []:
        if not isinstance(region, Mapping):
            continue
        mesh = region.get("mesh")
        shape = region.get("shape")
        if not isinstance(mesh, Mapping) or not isinstance(shape, Mapping):
            continue
        if shape.get("kind") == "cylinder":
            center = shape.get("center") if isinstance(shape.get("center"), list) else [0.0, 0.0, 0.0]
            fields.append({
                "kind": "ComponentRestrictedCylinder",
                "region": str(region.get("name", "")),
                "params": {
                    "GeometryName": f"{geometry_name}_geom",
                    "VIn": float(mesh["maximum_element_size"]),
                    "VOut": float(object_hmax),
                    "Radius": float(shape["radius"]),
                    "XCenter": float(center[0]),
                    "YCenter": float(center[1]),
                    "ZCenter": float(center[2]),
                },
            })
    return fields
```

Use this helper before appending legacy raw `size_fields`, so explicit raw fields can still override by `Min`.

- [ ] **Step 4: Report semantic region ownership**

In `mesh_build_report.py`, preserve `field["region"]` into `size_fields_realized`:

```python
if field_desc.get("region"):
    payload["region"] = str(field_desc["region"])
```

- [ ] **Step 5: Run lowering test**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src pytest packages/fullmag-py/tests/test_region_owned_mesh_lowering.py -q
```

Expected:

```text
1 passed
```

---

## Task 5: Canonical Script Export

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Test: `packages/fullmag-py/tests/test_region_owned_script_export.py`

- [ ] **Step 1: Write failing export test**

Create `packages/fullmag-py/tests/test_region_owned_script_export.py`:

```python
from fullmag.runtime.script_builder import build_script_from_ir


def test_region_owned_mesh_exports_add_region_syntax(region_owned_problem_ir):
    script = build_script_from_ir(region_owned_problem_ir)
    assert 'skyrmion = waveguide.add_region(' in script
    assert 'shape=fm.shapes.cylinder(' in script
    assert 'skyrmion.mesh.remesh(' in script
    assert 'VIn=1e-9' not in script
    assert 'ComponentRestrictedCylinder' not in script
```

- [ ] **Step 2: Run failing test**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src pytest packages/fullmag-py/tests/test_region_owned_script_export.py -q
```

Expected before implementation:

```text
AssertionError: assert 'skyrmion = waveguide.add_region(' in ...
```

- [ ] **Step 3: Render regions after parent mesh**

In `script_builder.py`, after rendering `waveguide.mesh(...)`, render object regions:

```python
def _render_object_regions(target_var: str, mesh_entry: dict[str, object]) -> list[str]:
    lines: list[str] = []
    for region in mesh_entry.get("object_regions", []) or []:
        name = str(region["name"])
        shape = region["shape"]
        region_var = _safe_identifier(name)
        if shape["kind"] == "cylinder":
            center = shape.get("center", [0.0, 0.0, 0.0])
            shape_expr = (
                "fm.shapes.cylinder("
                f"radius={_py_repr(shape['radius'])}, "
                f"height={_py_repr(shape['height'])}, "
                f"center=({_py_repr(center[0])}, {_py_repr(center[1])}, {_py_repr(center[2])})"
                ")"
            )
        elif shape["kind"] == "box":
            center = shape.get("center", [0.0, 0.0, 0.0])
            size = shape["size"]
            shape_expr = (
                "fm.shapes.box("
                f"size=({_py_repr(size[0])}, {_py_repr(size[1])}, {_py_repr(size[2])}), "
                f"center=({_py_repr(center[0])}, {_py_repr(center[1])}, {_py_repr(center[2])})"
                ")"
            )
        else:
            continue
        lines.append(f"{region_var} = {target_var}.add_region({_py_repr(name)}, shape={shape_expr})")
        mesh = region.get("mesh")
        if isinstance(mesh, dict):
            kwargs = [f"maximum_element_size={_py_repr(mesh['maximum_element_size'])}"]
            if mesh.get("minimum_element_size") is not None:
                kwargs.append(f"minimum_element_size={_py_repr(mesh['minimum_element_size'])}")
            if mesh.get("transition_distance") is not None:
                kwargs.append(f"transition_distance={_py_repr(mesh['transition_distance'])}")
            if mesh.get("order") is not None:
                kwargs.append(f"order={int(mesh['order'])}")
            lines.append(f"{region_var}.mesh.remesh({', '.join(kwargs)})")
    return lines
```

- [ ] **Step 4: Run export test**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src pytest packages/fullmag-py/tests/test_region_owned_script_export.py -q
```

Expected:

```text
1 passed
```

---

## Task 6: Planner Semantics for Material and Texture Overrides

**Files:**
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Test: `crates/fullmag-plan/src/tests.rs`

- [ ] **Step 1: Add FEM planner test**

Add to `crates/fullmag-plan/src/tests.rs`:

```rust
#[test]
fn fem_plan_preserves_object_region_material_and_texture_overrides() {
    let mut ir = minimal_fem_problem();
    ir.object_regions.push(fullmag_ir::ObjectRegionIR {
        name: "skyrmion".to_string(),
        owner: "body".to_string(),
        shape: fullmag_ir::ObjectRegionShapeIR::Cylinder {
            radius: 350e-9,
            height: 2e-9,
            center: [0.0, 0.0, 0.0],
            frame: "object".to_string(),
        },
        priority: 10,
        mesh: None,
        material: Some(fullmag_ir::ObjectRegionMaterialOverrideIR {
            saturation_magnetisation: Some(7.0e5),
            ..Default::default()
        }),
        initial_magnetization: Some(fullmag_ir::InitialMagnetizationIR::PresetTexture {
            preset_kind: "neel_skyrmion".to_string(),
            preset_params: serde_json::json!({
                "radius": 300e-9,
                "wall_width": 40e-9,
                "chirality": -1,
                "core_polarity": 1,
                "plane": "xy"
            }),
            mapping: None,
            texture_transform: None,
            ui_label: None,
            preview_proxy: None,
        }),
    });

    let plan = plan_problem(&ir).unwrap();
    assert_eq!(plan.fem_region_overrides.len(), 1);
    assert_eq!(plan.fem_region_overrides[0].region_name, "skyrmion");
}
```

- [ ] **Step 2: Implement planner preservation**

Add a planner structure such as:

```rust
pub struct FemObjectRegionOverridePlan {
    pub owner: String,
    pub region_name: String,
    pub priority: i32,
    pub material: Option<ObjectRegionMaterialOverrideIR>,
    pub initial_magnetization: Option<InitialMagnetizationIR>,
}
```

Populate it from `ProblemIR.object_regions`.

- [ ] **Step 3: Add capability gate**

If a backend cannot realize region material/texture overrides, strict mode must fail:

```rust
if !capabilities.supports_object_region_overrides && !problem.object_regions.is_empty() {
    return Err(PlanError::Unsupported(
        "object-local region material/texture overrides require region override support".to_string(),
    ));
}
```

- [ ] **Step 4: Run planner tests**

Run:

```bash
cargo test -p fullmag-plan object_region
```

Expected:

```text
test fem_plan_preserves_object_region_material_and_texture_overrides ... ok
```

---

## Task 7: Resource-First API and OpenAPI

**Files:**
- Modify: `crates/fullmag-api/src/schemas/authoring.rs`
- Modify: API route backing `/v2/sessions/current/model/regions`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`

- [ ] **Step 1: Extend schemas**

Extend `RegionResource`:

```rust
#[serde(default)]
pub region_id: String,
#[serde(default)]
pub region_kind: String, // "body" | "object_region"
#[serde(default, skip_serializing_if = "Option::is_none")]
pub owner_object_id: Option<String>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub owner_object_name: Option<String>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub owner_path: Option<String>, // "arch_waveguide/skyrmion"
#[serde(default)]
pub priority: i32,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub shape: Option<serde_json::Value>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub mesh_policy: Option<serde_json::Value>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub material_override: Option<serde_json::Value>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub texture_override: Option<serde_json::Value>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub interface_coupling: Option<serde_json::Value>,
#[serde(default)]
pub overlap_diagnostics: Vec<RegionOverlapDiagnosticResource>,
```

Extend `RegionPatchRequest`:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub name: Option<String>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub priority: Option<i32>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub shape: Option<serde_json::Value>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub mesh_policy: Option<serde_json::Value>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub material_override: Option<serde_json::Value>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub texture_override: Option<serde_json::Value>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub interface_coupling: Option<serde_json::Value>,
```

Add command/request shapes for:

- create object region under owner object,
- delete object region by `region_id`,
- duplicate object region,
- reorder object regions within one owner,
- rename object region.

- [ ] **Step 2: Regenerate OpenAPI**

Run the repo's existing OpenAPI generation command. If there is no single command, use the command already used for prior v2 API updates in this repo and record it in the PR description.

Expected changed files:

```text
apps/control-room/src/kernel/api/generated/openapi-v2.json
apps/control-room/src/kernel/api/generated/openapi-v2-types.ts
apps/control-room/src/kernel/api/generated/openapi-v2-client.ts
```

- [ ] **Step 3: Keep frontend through central API**

Add facade calls only in `apps/control-room/src/kernel/api/ControlRoomApi.ts`; React components must not hand-roll `fetch()` or endpoint strings.

Required facade methods:

```ts
api.model.createRegion(ownerObjectId, request)
api.model.patchRegion(regionId, request)
api.model.deleteRegion(regionId)
api.model.duplicateRegion(regionId)
api.model.reorderRegion(ownerObjectId, regionId, direction)
```

- [ ] **Step 4: Run API/frontend contract tests**

Run:

```bash
pnpm --dir apps/control-room test -- ControlRoomApi
```

Expected:

```text
PASS
```

---

## Task 8: Control-Room Region Explorer, CRUD, Inspector, and Rebuild Progress

**Files:**
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerSelection.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerTypes.ts`
- Modify: `apps/control-room/src/kernel/selection/selectionTypes.ts`
- Modify: `apps/control-room/src/kernel/authoring/geometryLifecycleCommands.ts`
- Modify: `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts`
- Modify: `apps/control-room/src/kernel/resources/geometryLifecycleResources.ts`
- Create or modify: `apps/control-room/src/modules/inspector/panels/ObjectRegionPolicyPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanelModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`
- Modify: `apps/control-room/src/modules/overlay/MeshBuildDialog.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/*`
- Test: focused control-room tests near modified modules

- [ ] **Step 1: Add Explorer model tests**

Expected tree:

```ts
expect(tree).toContainNode({
  id: "object:arch_waveguide/regions",
  label: "Regions",
});
expect(tree).toContainNode({
  id: "object-region:arch_waveguide/skyrmion",
  label: "skyrmion",
  selection: {
    kind: "object_region",
    ownerObjectId: "arch_waveguide",
    regionId: "region-skyrmion",
  },
});
```

Also verify that realized mesh report nodes are separate from authored region nodes:

```ts
expect(tree).toContainNode({ id: "mesh-region-field:study_domain/arch_waveguide/skyrmion" });
expect(tree.get("mesh-region-field:study_domain/arch_waveguide/skyrmion").linkedRegionId)
  .toBe("region-skyrmion");
```

- [ ] **Step 2: Add region CRUD command tests**

Commands must use the command registry and `ControlRoomApi`; no component-level transport:

```ts
await commands.execute("geometry.region.create", {
  ownerObjectId: "arch_waveguide",
  shape: { kind: "cylinder", radius: "350e-9", height: "2e-9" },
});
expect(api.model.createRegion).toHaveBeenCalled();

await commands.execute("geometry.region.delete", { regionId: "region-skyrmion" });
expect(api.model.deleteRegion).toHaveBeenCalledWith("region-skyrmion");
```

- [ ] **Step 3: Add region list and object inspector controls**

The object inspector must show:

- Region count.
- Add Region button.
- Table/list of regions with name, shape, priority, enabled policy badges, and overlap status.
- Inline commands: select, show/hide overlay, duplicate, delete, move priority up/down.

- [ ] **Step 4: Add Add Region dialog**

The dialog must use shared primitives and expose:

- Name.
- Shape kind from the shared shape catalog: box, cylinder, sphere/ellipsoid, ellipse, arch waveguide selector when supported.
- Object-local frame by default; world frame disabled unless implemented end-to-end.
- Center and dimensions.
- Priority.
- Optional initial mesh refinement toggle.
- Optional initial material override toggle.
- Optional initial texture override toggle.
- Preview overlay before applying.

The dialog commits through `geometry.region.create`, invalidates model/mesh resources, and opens the new region selection.

- [ ] **Step 5: Add deletion and dependency checks**

Deletion must show a confirmation dialog when the region owns any attachment:

```text
Deleting region "skyrmion" will also remove:
- mesh refinement policy
- initial texture override
- material override: Ms, Aex
```

The implementation must not leave orphan raw size fields, texture refs, or material refs. After delete, the Explorer,
selection, viewport overlays, and mesh/quality panels must refresh through resource invalidation.

- [ ] **Step 6: Add a model test for region policy drafts**

Expected behavior:

```ts
expect(regionDraft.meshPolicy.maximumElementSize).toBe("1e-9");
expect(regionDraft.materialOverride.Ms).toBe("7e5");
expect(regionDraft.textureOverride.kind).toBe("neel_skyrmion");
expect(regionDraft.interfaceCoupling.exchange.mode).toBe("default_harmonic_mean");
```

- [ ] **Step 7: Add region inspector panel**

The panel must show:

- Identity: name, stable id, owner object, enabled flag, priority, frame.
- Shape: kind, dimensions, center, transform, object-local/world-frame status.
- Mesh policy: maximum element size, minimum element size, transition distance, order, realized size-field owner.
- Material override: `Ms`, `Aex`, `alpha`, `Ku1`, `Dind`, anisotropy axis, plus parameter-field summary for gradients.
- Texture override: preset summary, texture editor command, and sampling scope.
- Interface/coupling policy: default exchange coupling, optional pairwise exchange override/scale, DMI policy placeholder disabled until physics note is complete.
- Diagnostics/provenance: overlap diagnostics, validation errors, last mesh build generation id, linked realized mesh part/field.
- Quality: scoped node/tetra counts and histogram filter for this region.

- [ ] **Step 8: Add update commands**

Use central command/API path:

```ts
await api.model.patchRegion(regionId, {
  mesh_policy: {
    maximum_element_size: parseNumber(draft.maximumElementSize),
    minimum_element_size: parseOptionalNumber(draft.minimumElementSize),
    transition_distance: parseOptionalNumber(draft.transitionDistance),
    order: parseOptionalInteger(draft.order),
  },
  material_override: normalizeMaterialOverride(draft.materialOverride),
  texture_override: normalizeTextureOverride(draft.textureOverride),
  interface_coupling: normalizeInterfaceCoupling(draft.interfaceCoupling),
});
```

- [ ] **Step 9: Add viewport overlays and histogram highlighting**

Viewport target:

- Region translucent overlay and wire outline use region display color.
- Selected region outline is distinct from object wireframe and airbox wireframe.
- Overlap diagnostics render hatching or warning tint.
- Mesh-size histogram hover uses existing mesh highlight infrastructure but scopes element filtering to the selected region when applicable.

- [ ] **Step 10: Add mesh rebuild progress details**

Extend `MeshBuildDialog` so a region edit shows:

- region id/name that invalidated the mesh,
- requested mesh/material/texture policy delta,
- planned size-field stack count,
- current meshing phase,
- last successful mesh generation id,
- last failure message and source field when available.

- [ ] **Step 11: Run frontend checks**

Run:

```bash
pnpm --dir apps/control-room test -- ObjectRegion ExplorerTreeView MeshBuildDialog meshSizeHistogramHover
pnpm --dir apps/control-room typecheck
```

Expected:

```text
PASS
```

---

## Task 9: Update Example and Remove Raw Local Gmsh Field from Public Path

**Files:**
- Modify: `examples/arch_waveguide_relax_50nm.py`
- Test: lightweight script export/IR checks

- [ ] **Step 1: Replace raw size field**

Replace:

```python
waveguide.mesh.size_field(
    "ComponentRestrictedCylinder",
    GeometryName="arch_waveguide_geom",
    VIn=1e-9,
    VOut=10e-9,
    Radius=350e-9,
    XCenter=0.0,
    YCenter=0.0,
    ZCenter=0.0,
)
```

with:

```python
skyrmion_region = waveguide.add_region(
    "skyrmion",
    shape=fm.shapes.cylinder(
        radius=350e-9,
        height=HEIGHT,
        center=(0.0, 0.0, 0.0),
    ),
)
skyrmion_region.mesh.remesh(
    maximum_element_size=1e-9,
    minimum_element_size=1e-9,
    transition_distance=80e-9,
)
```

Also update the example's parent geometry to use the same namespace:

```python
waveguide = study.geometry(
    fm.shapes.arch_waveguide(
        length=LENGTH,
        width=WIDTH,
        height=HEIGHT,
        arch_height=0e-9,
        z0=0,
    ),
    name="arch_waveguide",
)
```

- [ ] **Step 2: Verify lightweight contract**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src .fullmag/local/python/bin/python \
  -m fullmag.runtime.helper export-run-config \
  --script examples/arch_waveguide_relax_50nm.py \
  --backend fem --mode strict --precision double --skip-geometry-assets
```

Expected output includes:

```json
"object_regions":[{"name":"skyrmion"
```

Expected output does not include raw public intent:

```text
ComponentRestrictedCylinder
```

The realized mesh report may still include `ComponentRestrictedCylinder`; the script and authoring IR must not expose it as the primary user intent.

---

## Task 10: Material Boundary and Gradient Physics Validation

**Files:**
- Modify: `docs/physics/0100-mesh-and-region-discretization.md`
- Modify or create: `docs/physics/regions/region-material-boundary-and-gradient.md`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Modify: FEM exchange implementation tests when backend support is added
- Modify: FDM exchange implementation tests when backend support is added

- [ ] **Step 1: Add physics note section for material interfaces**

The note must state:

- one object with multiple material regions owns one unit magnetization field `m`,
- `Ms(x)`, `Aex(x)`, anisotropy, and damping are coefficient fields,
- FEM exchange uses spatial coefficients in the weak form and keeps natural internal exchange-flux continuity,
- FDM exchange uses harmonic mean of neighboring `Aex` values by default,
- pairwise interface exchange scale/override is the explicit way to model reduced or zero coupling,
- airbox is not a magnetic material region,
- DMI interface behavior is separate and blocked until specified.

- [ ] **Step 2: Add IR/planner validation tests**

Required cases:

```text
two adjacent regions with different Ms and Aex -> valid, one magnetization field
same two regions with interface exchange scale 0 -> valid, zero exchange interface
overlapping regions assign Ms with equal priority -> invalid
overlapping regions assign Ms and Aex with equal priority but different properties -> valid with diagnostics
region material Ms = linear field -> valid coefficient field, not hidden regions
region attempts to assign m or Ms in airbox -> invalid
```

- [ ] **Step 3: Add backend oracle tests before solver implementation claims**

FDM oracle:

- 1D two-material strip with `A1 != A2`; internal neighbor coefficient equals `harmonic_mean(A1, A2)`.
- Same strip with `exchange_scale(region1, region2, 0)`; interface exchange contribution is zero.
- Smooth `Ms(x)` gradient; solver uses local `Ms` in field normalization while `m` remains unit length.

FEM oracle:

- Two-material conforming mesh; exchange assembly uses element/node coefficient field and does not duplicate the
  magnetization unknown at the internal material boundary.
- Piecewise-constant `Aex` produces natural flux continuity in the weak form.
- Smooth `Ms(x)` gradient changes coefficient evaluation without changing topology or creating hidden regions.

- [ ] **Step 4: Verify against external-solver expectations**

Document in the physics note why Fullmag follows:

- Mumax+ for explicit inter-region exchange override and harmonic-mean FDM default.
- Tetrax for treating `Ms`/`Aex` gradients as material parameter fields rather than region proliferation.

---

## Task 11: End-to-End Verification Matrix

**Commands:**

- Python syntax:

```bash
python3 -m py_compile examples/arch_waveguide_relax_50nm.py
```

- Python DSL tests:

```bash
PYTHONPATH=packages/fullmag-py/src pytest packages/fullmag-py/tests/test_region_owned_authoring.py packages/fullmag-py/tests/test_region_owned_mesh_lowering.py packages/fullmag-py/tests/test_region_owned_script_export.py -q
```

- IR tests:

```bash
cargo test -p fullmag-ir object_region
```

- Planner tests:

```bash
cargo test -p fullmag-plan object_region
```

- Frontend focused tests:

```bash
pnpm --dir apps/control-room test -- ControlRoomApi ObjectRegion
pnpm --dir apps/control-room typecheck
```

- Managed runtime smoke after the feature is implemented:

```bash
just run-arch-waveguide-interactive-v2 gpu
```

Expected runtime evidence:

- Mesh build report lists one user region named `skyrmion`.
- Realized size fields include a semantic owner `region="skyrmion"`.
- Mesh histogram/viewport shows denser elements in the skyrmion region.
- Exported canonical Python uses `waveguide.add_region(...)`.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Regions become a catch-all abstraction | Keep `Geometry`, `Ferromagnet`, `Material`, `ParameterField`, and `Coupling` separate in docs and IR |
| `region.mesh.remesh` creates too many elements | Keep examples explicit about cost; UI must show estimated/refined volume and mesh rebuild progress |
| FEM and FDM drift | Store backend-neutral region intent in `ProblemIR`; lower separately in planners |
| UI patches diverge from Python DSL | Require script export tests and OpenAPI-generated types |
| Overlapping region material assignments are ambiguous | Validate priority and fail equal-priority overlaps for same property |
| Region registry becomes unstable after rename/delete | Use stable `region_id` for internal references and name paths only for user lookup/export |
| Smooth material gradients are modeled as too many regions | Represent gradients as material parameter fields over nodes/elements/cells |
| Material interface physics is accidentally backend-specific | Pin the default exchange interface rule in docs and test both FDM and FEM lowering |
| Airbox receives magnetic material state | Validate that `m`, `Ms`, `Aex`, anisotropy, and DMI material coefficients are magnetic-object-only |
| Raw Gmsh fields leak into public scripts | Keep raw `size_field(...)` as advanced API only; canonical exporter emits `add_region(...)` |

## Acceptance Criteria

- A user can write `waveguide.add_region(...).mesh.remesh(...)` in Python.
- A user can access regions through `waveguide.regions["name"]`, `waveguide.regions[0]`, and read-only `study.regions["owner/name"]`.
- A user can delete, rename, duplicate, and reorder object-local regions without orphaning mesh/material/texture policies.
- A user can assign region-local initial magnetization texture.
- A user can assign region-local material overrides.
- A user can assign a spatial material field such as `Ms(x)` without generating hidden regions.
- `ProblemIR` stores region-owned mesh/material/texture intent without Gmsh field names.
- `ProblemIR` validates overlap priority, duplicate names, missing owners, and illegal airbox magnetic-region assignments.
- Default internal exchange coupling semantics are documented and tested: FDM harmonic mean with pairwise override/scale; FEM spatial coefficient weak form.
- FEM meshing realizes region mesh policies into size fields and reports semantic region ownership.
- UI can list/select/edit region mesh/material/texture policy through v2 resource-first APIs.
- UI shows regions as Explorer children under their owner object, with a dedicated region inspector and viewport overlay.
- UI deletion/rebuild flows show dependency and mesh rebuild progress through existing command/resource mechanisms.
- `examples/arch_waveguide_relax_50nm.py` no longer needs raw `ComponentRestrictedCylinder` authoring.
- Round-trip export preserves `add_region(...)`.
