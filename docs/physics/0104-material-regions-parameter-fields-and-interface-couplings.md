# Material regions, parameter fields, and interface couplings

- Status: accepted implementation contract
- Owners: Fullmag core
- Last updated: 2026-06-08
- Related ADRs: `docs/adr/0011-resource-first-api.md`, `docs/adr/0013-frontend-v2-module-kernel.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`
- Related plans:
  - `docs/plans/active/region-owned-mesh-material-texture-plan-2026-06-04-pl.md`
  - `docs/plans/active/region-owned-implementation-masterplan-2026-06-04-pl.md`
- Related physics notes:
  - `docs/physics/0100-mesh-and-region-discretization.md`
  - `docs/physics/regions/0460-sharp-interfaces-multi-body-and-parameter-fields.md`
  - `docs/physics/regions/0461-multi-region-note-corrected.md`
  - `docs/physics/0400-fdm-exchange-demag-zeeman.md`
  - `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`

## 1. Problem statement

Fullmag needs one canonical way to describe local mesh refinement, local
material variation, initial texture overrides, and explicit coupling between
magnetic bodies. These concepts must not collapse into one "region id" trick.

The physical ambiguity is severe:

- one material object can contain spatially varying coefficients and still own
  one reduced magnetization field `m`,
- two different material objects can touch and still have no direct exchange
  unless an explicit coupling is declared,
- RKKY/contact/interlayer exchange is surface physics with units `J/m^2`, not a
  volumetric `Aex` override,
- airbox is a mesh/field domain for demag and diagnostics, not a magnetic
  material region.

This note defines the contract for:

1. material objects,
2. object-owned authored regions,
3. material parameter fields,
4. realized mesh/material region markers,
5. interface couplings,
6. quantity scoping for airbox and magnetic-only fields.

## 2. Physical model

### 2.1 Governing equations

For a single material object, the reduced magnetization is

```text
m : Omega x [0, T] -> S^2
M(x, t) = Ms(x) m(x, t)
```

`m` belongs to the material object, not to each authored region. Regions inside
one object are spatial selectors over the same field `m`.

The exchange energy for a heterogeneous single-object continuum is

```text
E_ex = integral_Omega A(x) |grad m|^2 dV
```

The exchange effective field is

```text
H_ex = 2 / (mu0 Ms(x)) div(A(x) grad m)
```

Across a sharp internal material interface `Gamma` inside one object, with no
additional surface coupling, the natural condition is exchange flux continuity:

```text
A_1 partial_n m_1 = A_2 partial_n m_2
```

This is the physical reason that two regions inside one object are not
automatically disconnected. They share one continuum field.

For multiple material objects, each object owns its own reduced field:

```text
m_k : Omega_k x [0, T] -> S^2
M_k = Ms_k(x) m_k
```

Direct exchange between two objects is absent unless the user declares an
explicit coupling. Demag still acts through the total physical magnetization
over all objects.

RKKY/interlayer exchange is a surface energy:

```text
E_RKKY = -J1 integral_Gamma (m_1 dot m_2) dS
```

where `J1` has units `J/m^2`. It is not represented by setting the volumetric
exchange stiffness `Aex` on both sides.

### 2.2 Symbols and SI units

| Symbol / parameter | Meaning | SI unit |
|---|---|---|
| `m` | reduced magnetization | dimensionless |
| `M` | physical magnetization | `A/m` |
| `Ms(x)` | saturation magnetization | `A/m` |
| `A(x)`, `Aex` | exchange stiffness | `J/m` |
| `alpha(x)` | Gilbert damping | dimensionless |
| `Ku1(x)`, `Ku2(x)` | uniaxial anisotropy constants | `J/m^3` |
| `Kc1(x)`, `Kc2(x)`, `Kc3(x)` | cubic anisotropy constants | `J/m^3` |
| `Dind(x)` | interfacial DMI coefficient | `J/m^2` |
| `Dbulk(x)` | bulk DMI coefficient | `J/m^2` under the current Fullmag convention |
| `J1` | bilinear RKKY/interlayer surface coupling | `J/m^2` |
| `mu0` | vacuum permeability | `N/A^2` |

### 2.3 Assumptions and approximations

1. One material object owns one reduced magnetization field `m`.
2. Authored object regions do not create independent fields.
3. Smooth material variation is modeled as a material parameter field.
4. An object region with `realization_policy="inherit"` and only a
   `mesh_policy` is mesh-size-only. It may change element density, but it must
   not create an FEM object-region domain marker, a separate magnetic material,
   a material coefficient field, a local texture override, or duplicated
   magnetization degrees of freedom. If an OCC/Gmsh realization returns
   coincident but topologically duplicated nodes on an intra-object region
   interface, Fullmag must merge those nodes before FEM execution.
5. Sharp internal jumps in one object are allowed, but FEM requires conformal
   boundary/domain markers in strict mode.
6. Projection mode for a sharp FEM jump is an explicit extended-mode
   approximation and must be reported.
7. `Ms(x) > 0` is required for every active magnetic cell/node/element. A void
   is represented by geometry or active masks, not by `Ms=0`.
8. DMI interfaces between distinct materials are deferred to a separate physics
   note.
9. Full RKKY runtime support is capability-gated. If authored RKKY cannot be
   realized by the selected backend, the run is blocked.

### 2.4 Region-local material transition semantics

For one continuous magnetic object, a region-local material parameter change
does not automatically imply a sharp material interface. The authored region is
a support selector; the material transition describes how the parent parameter
and local region parameter are blended near the selector boundary.

Supported authored transition intents are:

- `mesh_relative(cells=N)`: smooth transition width tied to the local mesh scale,
- `metric(width=...)`: smooth transition width tied to a physical SI distance,
- `sharp`: discontinuous coefficient jump that may require conformal FEM
  realization.

Smooth transitions also define where the transition is anchored relative to the
region boundary:

- `scope="boundary"`: transition spans both sides of the region boundary,
- `scope="inside"`: transition is consumed only inside the region,
- `scope="outside"`: transition is consumed only outside the region.

The default for region-local `Ms` and `Aex` overrides in one object is:

```text
mesh_relative(cells=3, scope="boundary")
```

With signed distance `d(x) < 0` inside the authored region and `d(x) > 0`
outside, a smooth region-local defect realizes:

```text
p(x) = p_parent + w(d(x), h_local(x)) (p_region - p_parent)
```

where `p` is the material parameter and `w` is a smooth weight determined by
the authored transition kind, width, and scope. A smooth transition requires a
supported signed-distance evaluator for the authored region shape. Unsupported
shapes must capability-block instead of silently falling back to a bounding-box
distance or binary mask.

## 3. Numerical interpretation

### 3.1 FDM

FDM realizes material fields on a Cartesian grid. For v1, the runner/planner
materializes authored fields into cellwise arrays:

- `Ms_i`,
- `A_i`,
- `alpha_i`,
- anisotropy/DMI fields where supported,
- object/region masks,
- exchange pair descriptors.

Two material objects in one FDM grid are one backend plan, not two hidden
backend instances. The plan contains a shared `active_mask`, per-cell object or
region indices, cellwise material fields, and an explicit exchange pair table.

Intra-object region-region exchange default:

```text
A_ij = harmonic_mean(A_i, A_j) * scale(region_i, region_j)
```

with

```text
harmonic_mean(A_i, A_j) = 2 A_i A_j / (A_i + A_j)
```

unless an explicit `inter_exchange` is provided. `scale=0` or `mode=disabled`
means no direct exchange across that interface.

An authored region with no local material override, no coefficient field, and
no explicit exchange override is only a selector/authoring subobject. It must
not create a physical material boundary. If a backend materializes such a
region into an internal mask for UI, texture, or future local policy
bookkeeping, the resolved physics remains one continuous magnetic medium with
the parent material parameters.

Inter-object default:

```text
A_ij = 0
```

unless the user declares `study.couplings.exchange(...)`.

This remains true even if the two objects use the same material preset. If a
backend packs multiple authored objects into one technical region mask or
combined grid, it must emit explicit disabled exchange pairs between object ids.
The harmonic default is only an intra-object region default.

The exchange field must divide by local `Ms_i`:

```text
H_ex,i = 2 / (mu0 Ms_i V_i) sum_j A_ij (S_ij / d_ij) (m_j - m_i)
```

The exchange energy reduction must use the same `A_ij` as the field kernel.
This is a required validation target, not an implementation detail.

Multilayer FDM with region-owned material/coupling is out of scope for v1 and
must be capability-gated. It cannot silently fall through to a partially
implemented path.

### 3.2 FEM

FEM realizes material fields as coefficients over elements, nodes, or
quadrature points. For sharp piecewise constants, strict mode requires a
conformal region boundary or domain marker so the weak form can preserve the
material interface. A conformal authored-region marker is valid only when the
shared-domain mesh actually contains elements with that marker; metadata alone
must not satisfy strict conformal planning.

For exchange:

```text
E_ex = integral_Omega A(x) grad m : grad m dV
```

and the weak form naturally imposes flux continuity at conformal internal
interfaces unless an explicit surface coupling changes the condition.

For consistent-mass exchange projection with spatial `Ms(x)`, the discrete
field equation uses the `Ms`-weighted mass matrix:

```text
M_Ms H_ex = -(2 / mu0) K_A m
```

where `(M_Ms)_ij = integral Ms(x) phi_i phi_j dV`. Solving an unweighted mass
system and dividing its solution nodewise by `Ms_i` is not equivalent when
`Ms` varies spatially. The lumped path may use the corresponding diagonal
approximation `M_lumped,ii * Ms_i`.

Projection mode:

- does not split geometry,
- samples/project material coefficients onto the existing mesh,
- is acceptable for smooth fields and mild variation,
- has no v1 quantitative error guarantee for sharp piecewise jumps,
- is not the default for sharp `Aex`, `Ms`, DMI, RKKY, or validation-grade
  contact physics,
- must be visible in mesh reports, runtime provenance, and UI diagnostics.

If conformal split is requested but mesh quality or degenerate tetrahedron gates
fail, the solver must not silently continue with projected sharp jumps. The run
is blocked unless the user explicitly switches to projection mode.

Contact/interface discovery is a realization step, not an authoring shortcut.
FDM resolves contact from object/region masks and cell adjacency on one grid.
FEM resolves contact from boundary/domain markers in the shared-domain mesh. If
an explicit coupling endpoint cannot be resolved to runtime faces, planning must
fail instead of dropping the coupling.

### 3.3 Hybrid

Hybrid or cross-discretization workflows must preserve authored intent and
resolved realization separately:

- authored region id/name,
- owner object,
- material field descriptor,
- projection/conformal realization,
- backend capability result,
- realized field or marker asset id.

Projection between FDM grids and FEM meshes is a realized numerical operation,
not a change in public physics semantics.

## 4. API, IR, and planner impact

### 4.1 Python API surface

The canonical public model is:

- `fm.shapes` for geometry and region selectors,
- `fm.fields` for material parameter fields,
- object-owned regions such as `waveguide.add_region(...)`,
- global `study.couplings` for inter-object/interface coupling,
- optional convenience aliases such as `waveguide.interfaces` that lower into
  `study.couplings`.

Example:

```python
waveguide = study.geometry(
    fm.shapes.arch_waveguide(length=2.5e-6, width=1.0e-6, height=2e-9),
    name="waveguide",
)

core = waveguide.add_region(
    "skyrmion_core",
    shape=fm.shapes.cylinder(radius=60e-9, height=2e-9),
)
core.mesh.maximum_element_size = 1e-9
core.material.Ms = 7.5e5
core.m = fm.texture.neel_skyrmion(300e-9, 40e-9, -1, 1, "xy")
```

Region mesh policy is a local sizing policy unless the region explicitly asks
for a conformal realization. A region with `realization_policy="inherit"` may
emit local mesh size fields and diagnostic authored overlays, but it does not
create a separate FEM domain marker or field-capable mesh-part visualization
target. A conformal region may create a realized region marker/mesh part when
the backend can fragment the owner geometry.

Mesh controls are validated with the same ordering rule as object mesh
controls: if both bounds are present, `minimum_element_size <=
maximum_element_size`. Reversed ranges are invalid because they make local
Gmsh size fields ambiguous and can otherwise look like ignored region controls.
For local region size fields, `maximum_element_size` is the requested target
size inside the region (`VIn` in the Gmsh field). `minimum_element_size` is the
lower bound that must be allowed by the global Gmsh characteristic-length clamp;
it is not the target size by itself. A region-local target below an object-level
minimum must therefore lower the generated `Mesh.CharacteristicLengthMin`, or
the local field is clipped before meshing.

Smooth gradients should be authored as fields:

```python
waveguide.material.Ms = fm.fields.linear(
    base=7.7e5,
    gradient=(0.0, 2.0e11, 0.0),
    frame="object",
)
```

Object-object coupling must be explicit:

```python
study.couplings.exchange(layer_a, layer_b, mode="harmonic_mean")
study.couplings.rkky(
    source=layer_a.surface("top"),
    target=layer_b.surface("bottom"),
    J1=-0.3e-3,
)
```

Precomputed shared-domain FEM meshes may carry authored-region conformal
markers explicitly:

```python
study.domain_mesh(
    "prebuilt_domain.json",
    region_markers={"waveguide": 1},
    object_region_markers={"waveguide:skyrmion_core": 2},
)
```

`object_region_markers` are not generated from region shapes by this API. They
are declarations that the referenced marker IDs already exist in the mesh
element marker array. The planner must reject metadata-only markers that do not
appear in the mesh topology.

### 4.2 ProblemIR representation

`ProblemIR` needs distinct authored and realized concepts:

- legacy `RegionIR` remains a body/geometry binding compatibility type,
- new `ObjectRegionIR` represents owner-scoped authored regions,
- `MaterialParameterFieldIR` represents authored scalar/vector field intent,
- `MaterialIR.*_field` remains realized/runtime payload, not authored intent,
- `CouplingIR` represents explicit exchange/RKKY/interface coupling,
- realized mesh/material region markers remain runtime/meshing assets.

Required validation:

- object region owner exists,
- region names are unique within an owner,
- `region_id` is stable and globally unique,
- shape dimensions are positive,
- material parameter fields have finite values and valid units,
- `Ms > 0` for active magnetic domains,
- airbox cannot receive `m`, `Ms`, `Aex`, anisotropy, DMI, or texture
  attachments,
- RKKY endpoints are surface/object boundary endpoints,
- unsupported RKKY blocks runtime planning,
- multilayer FDM + region-owned material/coupling is rejected for v1.

### 4.3 Planner and capability-matrix impact

The planner must resolve:

1. authored regions,
2. material object ownership,
3. material parameter fields,
4. overlap/priority conflicts,
5. conformal versus projected realization,
6. coupling endpoints and surface selectors,
7. backend support and capability diagnostics,
8. realized mesh/material/runtime payloads.

Default exchange policy:

- intra-object region-region: harmonic mean,
- inter-object without explicit coupling: none/free surface,
- object-object harmonic mean only after explicit `study.couplings.exchange`.

Surface selector v1:

- `surface("top")` is the maximum local-`z` bounding-box face with tolerance,
- FDM resolves it to exposed/contact cell faces and adjacency pairs,
- FEM resolves it to boundary face markers in the shared-domain mesh,
- named surfaces and arbitrary feature selectors are v2.

### 4.4 Review decision log

The following answers close the architectural questions raised during review.
They are part of the physics contract, not implementation preferences.

| Question | Contract answer |
|---|---|
| Do two regions inside one object exchange-couple by default? | Yes. They are one continuum field `m`; default exchange uses harmonic mean `A_ij` unless explicitly overridden. |
| Do two separate objects exchange-couple by default? | No. Separate objects have free surfaces unless `study.couplings.exchange(...)` or another explicit coupling is authored. |
| Can FDM keep the old cross-region zero default? | Only for legacy plan versions. Current region-owned semantics require explicit `exchange_pair_default=harmonic_mean` and pair descriptors; `exchange_pair_default=unspecified` is a zero-initialized legacy compatibility value, not current region-owned semantics. |
| Can unsupported RKKY be a warning? | No. Authored RKKY can remain in the model, but solver start is blocked until the selected backend supports the operator. |
| Is `Ms=0` a valid way to make a void? | No. Active magnetic cells/nodes/elements require `Ms > 0`; voids are geometry or masks. |
| How is field/energy consistency validated? | Exchange field and energy must share one `A_ij` definition and pass a directional-derivative/Taylor test. |
| What does `surface("top")` mean in v1? | A local bounding-box face selector with tolerance, resolved during materialization to FDM cell-face pairs or FEM boundary markers. |
| What if a selector cannot be resolved? | Explicit coupling endpoints that cannot resolve to runtime faces block planning; the coupling is not silently dropped. |
| Is FEM projection equivalent to conformal material splitting? | No. Projection is an explicit extended-mode approximation for smooth or intentionally smeared fields, not a production default for sharp jumps. |
| Is projection allowed for RKKY/contact/DMI interfaces? | No default projection path. These need an explicit runtime interface or a capability block. |
| Is multilayer FDM with regions in v1? | No. It is capability-gated out of scope until the multilayer plan descriptor supports region masks/material fields/couplings. |
| Is old `MaterialIR.ms_field` authored intent? | No. It is a realized/runtime compatibility payload; authored fields use `MaterialParameterFieldIR`. |
| How are object contacts discovered? | Contact discovery is a runtime materialization step: FDM uses mask adjacency; FEM uses shared-domain boundary/domain markers. |

## 5. Validation strategy

### 5.1 Analytical checks

1. Uniform material with no regions matches existing exchange reference.
2. Two intra-object regions with `A1 != A2` use harmonic face coefficients.
3. The FDM exchange field and exchange energy pass a directional derivative
   Taylor test with the same `A_ij`.
4. `Ms(x)` in the exchange denominator changes `H_ex` locally as expected.
5. `Ms=0` in active magnetic cells/nodes/elements is rejected before runtime.

### 5.2 Cross-backend checks

1. Smooth `Ms(x)` and `Aex(x)` field authoring lowers to FDM cell fields and FEM
   coefficient fields with matching provenance.
2. FEM conformal split preserves domain markers and exchange flux continuity for
   piecewise `Aex`.
3. FEM projection mode emits warning/provenance and is not accepted in strict
   mode for sharp material jumps.
4. FDM and FEM agree qualitatively on relaxation for a simple two-region
   heterogeneous body at converged mesh/grid resolution.

### 5.3 Regression tests

Required regression names can be refined during implementation, but coverage
must include:

- `intra_object_region_exchange_defaults_harmonic_mean`,
- `object_object_exchange_without_coupling_defaults_none`,
- `object_object_exchange_with_harmonic_mean_coupling_builds_pair_table`,
- `exchange_scale_zero_disables_interface_exchange`,
- `exchange_field_energy_directional_derivative_consistency`,
- `ms_zero_in_active_object_is_validation_error`,
- `rkky_unsupported_blocks_runtime_plan`,
- `surface_top_selector_resolves_to_runtime_faces`,
- `multilayer_fdm_regions_are_capability_gated`,
- `airbox_rejects_magnetic_material_and_m_quantity`.

## 6. Completeness checklist

- [ ] Python API
- [ ] ProblemIR
- [ ] Planner
- [ ] Capability matrix
- [ ] FDM backend
- [ ] FEM backend
- [ ] Hybrid backend
- [ ] Outputs / observables
- [ ] Tests / benchmarks
- [x] Documentation

## 7. Known limits and deferred work

- Full production RKKY runtime operators are deferred until backend capability
  work lands. Authored RKKY may exist, but unsupported runtime execution blocks.
- DMI interface physics between distinct material objects is deferred to a
  separate note.
- Named faces and arbitrary feature selectors are deferred to selector v2.
- Automatic conformal CSG split for arbitrary region shapes is deferred.
- Production strict-conformal runtime mapping still requires discontinuous
  element/domain `A` and `Ms` coefficients while retaining one shared
  magnetization field across the internal interface. Duplicating interface
  magnetization DOFs is not an acceptable realization of an intra-object
  material region.
  Conformal v1 supports box and cylinder regions fully contained in an
  OCC-compatible owner geometry. The cylinder axis may be arbitrary. Other
  shapes remain projection-only or require a precomputed shared-domain mesh.
  Every authored-region marker must occur in the actual element marker array;
  marker metadata alone is invalid.
- Multilayer FDM plus region-owned material/coupling is deferred behind a
  capability gate.
- Runtime texture authoring is deferred; region texture override in v1 is an
  initial-condition feature.

## 8. References

- Mumax+/Mumax region exchange semantics: default harmonic mean inside one
  shared magnet, explicit scale/inter exchange for overrides.
- Tetrax/FEM weak-form interpretation: coefficient fields and conformal domain
  markers for sharp material interfaces.
- Fullmag masterplan:
  `docs/plans/active/region-owned-implementation-masterplan-2026-06-04-pl.md`.
