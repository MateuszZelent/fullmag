# Airbox feature refinement: curvature and narrow air gaps

- Status: FEM tetrahedral shared-domain routes implemented (OCC conformal,
  OCC single geometry, GEO/STL component-aware); exact-layer, swept and
  mixed-element air routes reject the controls; 0105 production evidence
  **NOT VERIFIED**
- Last updated: 2026-10-29
- Governing ADR: `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md`
- Related notes: `docs/physics/0102-airbox-mesh-grading-geometric.md` (air
  grading law), `docs/physics/0100-mesh-and-region-discretization.md` (object
  curvature and narrow-region controls)

(problem-statement)=
## 1. Problem statement

The Poisson-airbox FEM demagnetization solve resolves the scalar potential
$\phi$ in the air surrounding the magnets. The interface grading of note 0102
makes air elements grow with distance from the magnetic surface, but it is
blind to two geometric features of the exterior domain:

1. **Curved magnetic surfaces.** Near a sphere or a cylinder of radius $R$ the
   exterior field varies on the length scale $R$. A coarse air element next
   to a strongly curved surface represents it with a few flat facets and
   under-resolves the near field.
2. **Narrow air gaps.** Between two magnets separated by a gap $w$ (or between
   a magnet and the truncation boundary when the padding is small) the
   potential changes across $w$. If the gap is smaller than the air target
   size, it is spanned by one element or fewer.

Object-level `curvature_factor` and `narrow_region_resolution` (note 0100)
act inside magnetic bodies only; the object narrow-region field is restricted
to body volumes on purpose. This note defines the air-scoped counterparts
authored on the universe (Airbox) policy. They only refine air: they never
coarsen a magnetic body or an interface target, because they enter the
canonical $\operatorname{Max}(\operatorname{Min}(\text{upper}),\operatorname{Max}(\text{lower}))$
composition as additional upper bounds restricted to air volumes.

(governing-equations)=
## 2. Governing equations

In source-free air the scalar potential obeys

```{math}
:label: eq-air-feature-laplace

\nabla^2\phi=0\quad\text{in }\Omega_\mathrm{air}.
```

**Curvature target.** For each air-adjacent magnetic surface $S_k$ with
sampled radius of curvature $R_k$, the requested curvature factor $c$ sets a
surface target

```{math}
:label: eq-air-curvature-target

h_k=\operatorname{clamp}\!\left(c\,R_k,\;h_\mathrm{lo},\;h_\mathrm{air}\right),
\qquad
R_k=\frac{1}{\max_{q}|\kappa_k(u_q,v_q)|},
```

where $\kappa_k$ is the curvature returned by Gmsh at the interior parametric
samples $(u_q,v_q)$. Flat surfaces ($\kappa_k=0$ everywhere) receive no target.
The target relaxes away from $S_k$ with a linear profile:

```{math}
:label: eq-air-curvature-ramp

h_{c}(\mathbf x)=\min_k\left[
\min\!\left(h_k+(g-1)\,d_k(\mathbf x),\;h_\mathrm{air}\right)\right],
\qquad \mathbf x\in\Omega_\mathrm{air}.
```

A linear profile with slope $g-1$ keeps the ratio of neighbouring element
sizes at the growth rate $g$ of the air policy: for $h(d)=h_k+(g-1)d$ one has
$h(d+h(d))=g\,h(d)$. The profile reaches $h_\mathrm{air}$ at
$d=(h_\mathrm{air}-h_k)/(g-1)$.

**Narrow-gap target.** Let $W_1,\dots,W_N$ be the air walls: the
air-adjacent surface set of every magnetic component and, when it exists,
the outer truncation boundary $\Gamma_\mathrm{out}$. The local gap width is
estimated by

```{math}
:label: eq-air-gap-width

w(\mathbf x)=\min_{i\ne j}\big(d_i(\mathbf x)+d_j(\mathbf x)\big),
```

with $d_i(\mathbf x)$ the distance from $\mathbf x$ to wall $W_i$. By the
triangle inequality $d_i+d_j\ge\operatorname{dist}(W_i,W_j)$, with equality on
the shortest segment between the two walls, so $w$ is the true gap on that
segment and an over-estimate elsewhere. The requested resolution $r$ is
mapped to an element count across the gap with the same map as the object
control (note 0100):

```{math}
:label: eq-air-gap-count

n(r)=\min\!\Big(12,\;\max\big(1,\;\operatorname{round}(1+6\,\operatorname{clamp}(r,0.1,2))\big)\Big),
```

and the air target is

```{math}
:label: eq-air-gap-target

h_{n}(\mathbf x)=\operatorname{clamp}\!\left(\frac{w(\mathbf x)}{n(r)},\;h_\mathrm{lo},\;h_\mathrm{air}\right),
\qquad \mathbf x\in\Omega_\mathrm{air}.
```

Because $w$ never under-estimates the gap, the field never requests elements
finer than $\operatorname{dist}(W_i,W_j)/n$.

**Composition and bounds.** Both targets are upper bounds restricted to
$\Omega_\mathrm{air}$ (boundaries included) and enter the background minimum
next to the 0102 grading field:

```{math}
:label: eq-air-feature-composition

h_\mathrm{lo}=\max\!\big(0.05\,h_\mathrm{air},\;h_\mathrm{air,min}\big),
\qquad
h(\mathbf x)=\min\!\big(h_\mathrm{grading}(\mathbf x),\,h_c(\mathbf x),\,h_n(\mathbf x),\dots\big).
```

$h_\mathrm{air,min}$ is the authored air minimum element size; when it is
absent only the $0.05\,h_\mathrm{air}$ floor applies.

(symbols-and-si-units)=
## 3. Symbols and SI units

| LaTeX token | Meaning | SI unit |
|---|---|---|
| $\phi$ | scalar magnetostatic potential in air | $\mathrm A$ |
| $\nabla^2$ | Laplace operator | $\mathrm{m^{-2}}$ |
| $\Omega_\mathrm{air}$ | air (airbox) volume of the shared domain | $\mathrm{m^3}$ |
| $\mathbf x$ | point in the air volume | $\mathrm m$ |
| $S_k$ | $k$-th air-adjacent magnetic surface | $\mathrm{m^2}$ |
| $k$ | surface index | $1$ |
| $\kappa_k$ | sampled surface curvature magnitude of $S_k$ | $\mathrm{m^{-1}}$ |
| $(u_q,v_q)$ | interior parametric sample of $S_k$ | $1$ |
| $q$ | sample index | $1$ |
| $R_k$ | smallest sampled radius of curvature of $S_k$ | $\mathrm m$ |
| $c$ | air curvature factor (`curvature_factor`) | $1$ |
| $h_k$ | surface target of $S_k$ | $\mathrm m$ |
| $d_k(\mathbf x)$ | distance from $\mathbf x$ to $S_k$ | $\mathrm m$ |
| $g$ | air growth rate (`maximum_element_growth_rate`) | $1$ |
| $h_c(\mathbf x)$ | curvature target in air | $\mathrm m$ |
| $W_i$ | $i$-th air wall (component surface set or $\Gamma_\mathrm{out}$) | $\mathrm{m^2}$ |
| $N$ | number of air walls | $1$ |
| $i,j$ | wall indices | $1$ |
| $d_i(\mathbf x)$ | distance from $\mathbf x$ to $W_i$ | $\mathrm m$ |
| $\operatorname{dist}(W_i,W_j)$ | shortest distance between two walls | $\mathrm m$ |
| $w(\mathbf x)$ | estimated local gap width | $\mathrm m$ |
| $r$ | air narrow-region resolution (`narrow_region_resolution`) | $1$ |
| $n(r)$ | elements requested across a gap | $1$ |
| $h_n(\mathbf x)$ | narrow-gap target in air | $\mathrm m$ |
| $h_\mathrm{air}$ | air maximum element size (`maximum_element_size`) | $\mathrm m$ |
| $h_\mathrm{air,min}$ | air minimum element size (`minimum_element_size`) | $\mathrm m$ |
| $h_\mathrm{lo}$ | lower clamp of both feature targets | $\mathrm m$ |
| $h_\mathrm{grading}(\mathbf x)$ | 0102 interface grading target | $\mathrm m$ |
| $h(\mathbf x)$ | background target size | $\mathrm m$ |
| $\Gamma_\mathrm{out}$ | outer truncation boundary of the airbox | $\mathrm{m^2}$ |

(assumptions-and-validity)=
## 4. Assumptions and validity

- Both controls require an authored air maximum element size $h_\mathrm{air}$:
  it is the size the targets relax to and the cap of every clamp. Authoring a
  control without it is rejected (Python `ValueError`, API `400`, IR
  `far-air maximum is required`).
- $R_k$ comes from at most $5\times5$ interior parametric samples. Surfaces
  without a parametrization (discrete STL patches on the GEO route) yield no
  radius and receive no curvature target; the build reports the number of
  refined surfaces, so an inactive control is visible.
- The gap estimate measures gaps between **different** walls. A concave
  single body (for example the inside of a U) is one wall, so its own
  re-entrant gap is not detected; the object-level control covers the body
  interior.
- The pairwise construction costs $N(N-1)/2$ distance sums per evaluation
  point. More than $32$ walls is rejected with a clear error instead of
  silently degrading.
- The magnetic-air interface is shared by both sides, so `Restrict`
  includes it: the interface triangulation, and with it the outermost body
  elements, follows the finer air target. Body interior targets are not
  changed and no body element is coarsened.
- The outer truncation boundary is a wall, so a padding layer thinner than
  $n(r)\,h_\mathrm{air}$ is treated as a narrow gap and refined. This is the
  intended resolution of the body-to-boundary layer, and it can raise the
  air element count by an order of magnitude (see Validation).
- The scalar-potential decay of note 0102 motivates both refinements; no
  universal error bound in $h$ is claimed.

(python-api)=
## 5. Python API

| Python | Type | Default | SI unit | Validation / error | Meaning | Backend support | ProblemIR destination | Source |
|---|---|---|---|---|---|---|---|---|
| `study.universe.mesh.curvature_factor` | `float \| None` | `None` | $1$ | finite $>0$; requires `maximum_element_size`; FDM `cell_size` combination rejected; otherwise `ValueError` | air target $c\,R_k$ at curved magnetic surfaces | FEM CPU/GPU | `runtime_metadata.study_universe.airbox_curvature_factor`; `fem_mesh_policy.airbox.curvature_factor` | `packages/fullmag-py/src/fullmag/world.py::StudyUniverseHandle.mesh` |
| `study.universe.mesh.narrow_region_resolution` | `float \| None` | `None` | $1$ | finite $>0$; requires `maximum_element_size`; FDM `cell_size` combination rejected; otherwise `ValueError` | elements $n(r)$ across air gaps | FEM CPU/GPU | `runtime_metadata.study_universe.airbox_narrow_region_resolution`; `fem_mesh_policy.airbox.narrow_region_resolution` | `packages/fullmag-py/src/fullmag/world.py::StudyUniverseHandle.mesh` |

```python
# %% Two spheres with a narrow air gap and curved surfaces.
import fullmag as fm

nm = 1e-9
fm.reset()
study = fm.study("airbox-feature-refinement")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(400 * nm, 240 * nm, 240 * nm))
study.universe.mesh(
    maximum_element_size=40 * nm,
    minimum_element_size=3 * nm,
    maximum_element_growth_rate=1.3,
    grading="geometric",
    curvature_factor=0.3,
    narrow_region_resolution=0.5,
)

# %% Geometry, material and magnetization.
for name, x in (("left", -60 * nm), ("right", 60 * nm)):
    body = study.geometry(fm.Sphere(radius=50 * nm).translate((x, 0.0, 0.0)), name=name)
    body.Ms = 800e3
    body.Aex = 13e-12
    body.alpha = 0.02
    body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
    body.mesh(maximum_element_size=10 * nm)

# %% Interactions and stages.
study.exchange()
study.demag(realization="poisson_robin")
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1)
```

The UI Airbox panel writes the same two values; the script builder exports
them back as the `study.universe.mesh(...)` keywords above.

(problem-ir)=
## 6. ProblemIR

Requested intent is stored in `runtime_metadata.study_universe` next to the
other air controls:

```json
{
  "mode": "manual",
  "size": [4e-07, 2.4e-07, 2.4e-07],
  "center": [0.0, 0.0, 0.0],
  "padding": [0.0, 0.0, 0.0],
  "airbox_hmax": 4e-08,
  "airbox_hmin": 3e-09,
  "airbox_growth_rate": 1.3,
  "airbox_grading": "geometric",
  "airbox_curvature_factor": 0.3,
  "airbox_narrow_region_resolution": 0.5
}
```

The canonical `fem_mesh_policy.v1` lowering copies them to
`airbox.curvature_factor` and `airbox.narrow_region_resolution`. Absent
values are omitted from serialization, so policies without them keep their
previous bytes and identity. The scene document (`universe`,
`study.universe_mesh`) stores the same `airbox_*` names; the API universe
policy accepts the unprefixed `curvature_factor` / `narrow_region_resolution`
as aliases that must agree with the prefixed names.

(round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

- UI policy write → `ScriptBuilderUniverseState` → scene document → exported
  script `study.universe.mesh(curvature_factor=..., narrow_region_resolution=...)`
  → `StudyUniverseConfig.to_ir()` → `study_universe` → `AirboxOptions`.
  Each step preserves both values; the regression tests pin each hop.
- Validation errors: non-positive or non-finite values, a missing air
  maximum element size and disagreeing aliases are rejected before meshing.
- Unsupported combinations: FDM `cell_size` together with either control, and
  a route that cannot realize the controls, fail with a clear error
  (`airbox_feature_refinement_unsupported_route` for the mesher route)
  instead of ignoring them.
- Requested intent stays in `study_universe` and `fem_mesh_policy.airbox`;
  resolved execution is the progress event below.
- Resolved execution is published as the `airbox_feature_refinement`
  progress event: requested values, $n(r)$, number of refined surfaces, the
  smallest surface target, wall count and per-control status (`active` or
  `inactive` with reason).

(discrete-realization)=
## 8. Discrete realization

| Solver | Device | Status |
|---|---|---|
| FDM | CPU | not applicable: FDM uses regular-grid padding without an air mesh |
| FDM | GPU | not applicable: FDM uses regular-grid padding without an air mesh |
| FEM | CPU | implemented on OCC conformal, OCC single-geometry and GEO/STL component-aware tetrahedral routes |
| FEM | GPU | consumes the same realized mesh; device qualification remains separate |

Gmsh realization: each curvature target is a `Distance` field on $S_k$
followed by a linear `Threshold` (`LcMin` $=h_k$, `LcMax` $=h_\mathrm{air}$,
`DistMin` $=0$, `DistMax` $=(h_\mathrm{air}-h_k)/(g-1)$); the gap target is a
`MathEval` of pairwise `Distance` sums with the clamp of
{eq}`eq-air-gap-target`. Each control is combined with `Min` and wrapped in a
`Restrict` field on the air volumes. Exact-layer, swept-prism and mixed
prism/pyramid air routes build their air layers from explicit level sets and
reject the controls.

(implementation-mapping)=
## 9. Implementation mapping

`StudyUniverseHandle.mesh` and `StudyUniverseConfig` own public validation;
`_study_universe_airbox_options` lowers `study_universe` into
`AirboxOptions`; `add_airbox_feature_fields` builds the Gmsh fields and is
called from `_add_airbox_and_fragment`, `_add_airbox_geo` and
`generate_shared_domain_mesh_via_occ`;
`require_no_airbox_feature_refinement` guards the unsupported routes. On the
Rust side `UniverseStateWire` validates the authored state and
`FemMeshPolicyIR` carries the canonical copy.

(validation)=
## 10. Validation

- Contract tests: Python DSL → IR → `AirboxOptions`, script export round trip,
  Rust universe-state aliases and canonical policy lowering.
- Gmsh regression (`GmshRealizationTests`, Gmsh 4.15.2, FEM CPU route
  `conformal_occ`): two spheres of radius $50\,\mathrm{nm}$ with a
  $20\,\mathrm{nm}$ gap, body target $12\,\mathrm{nm}$, manual airbox
  $400	imes240	imes240\,\mathrm{nm}$, $h_\mathrm{air}=40\,\mathrm{nm}$.
  Measured on 2026-10-29:

  | Case | Air cells | Air cells in the gap | Mean air edge within $10\,\mathrm{nm}$ of the spheres |
  |---|---|---|---|
  | no feature control | 4922 | 87 | $15.7\,\mathrm{nm}$ |
  | `narrow_region_resolution=1.0` ($n=7$) | 55033 | 3080 | $8.8\,\mathrm{nm}$ |
  | `curvature_factor=0.2` | 10817 | 107 | $13.2\,\mathrm{nm}$ |

  The gap control also refines the thin padding layer between the spheres
  and $\Gamma_\mathrm{out}$, which explains most of the extra air cells.
- Production gate (note 0105): band statistics of the final air cells,
  growth ratio and quality, **NOT VERIFIED** for these controls.

(limitations)=
## 11. Limitations

- No build-report schema field yet; resolved data is in the progress event.
- STL surfaces without parametrization get no curvature target.
- Self-gaps of one concave body are not detected.
- Exact-layer, swept and mixed air routes reject the controls.

(scientific-bibliography)=
## 12. Scientific bibliography

- C. Geuzaine and J.-F. Remacle, "Gmsh: A 3-D finite element mesh generator
  with built-in pre- and post-processing facilities", *Int. J. Numer. Meth.
  Engng.* 79, 1309–1331 (2009), doi:10.1002/nme.2579.
- P.-O. Persson, "Mesh size functions for implicit geometries and PDE-based
  gradient limiting", *Engineering with Computers* 22, 95–109 (2006),
  doi:10.1007/s00366-006-0014-1.
- J. D. Jackson, *Classical Electrodynamics*, 3rd ed., Wiley (1999), ch. 5.

(source-code-index)=
## 13. Source-code index

| Claim | Path | Symbol | Lane | Tests | Evidence |
|---|---|---|---|---|---|
| Public validation | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseHandle` | FEM | `packages/fullmag-py/tests/test_airbox_feature_refinement.py` | contract test |
| IR serialization | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseConfig` | FEM | same | contract test |
| Lowering to mesher | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `_study_universe_airbox_options` | FEM | same | contract test |
| Composition, Eq. eq-air-feature-composition | `packages/fullmag-py/src/fullmag/meshing/_airbox_feature_fields.py` | `add_airbox_feature_fields` | FEM CPU | same | interpreted Gmsh regression |
| Eqs. eq-air-curvature-target, eq-air-curvature-ramp | `packages/fullmag-py/src/fullmag/meshing/_airbox_feature_fields.py` | `_add_air_curvature_field` | FEM CPU | same | interpreted Gmsh regression |
| Eqs. eq-air-gap-width, eq-air-gap-target | `packages/fullmag-py/src/fullmag/meshing/_airbox_feature_fields.py` | `_add_air_gap_field` | FEM CPU | same | interpreted Gmsh regression |
| Eq. eq-air-gap-count | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `_resolve_narrow_region_count` | FEM | same | contract test |
| Curvature sampling | `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` | `_sample_surface_curvature_radius` | FEM CPU | same | interpreted Gmsh regression |
| Unsupported routes | `packages/fullmag-py/src/fullmag/meshing/_airbox_feature_fields.py` | `require_no_airbox_feature_refinement` | FEM | same | contract test |
| Script export | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_universe_feature_refinement_kwargs` | FEM | same | contract test |
| Realized refinement | `packages/fullmag-py/tests/test_airbox_feature_refinement.py` | `class GmshRealizationTests` | FEM CPU | itself | interpreted Gmsh regression |
| Authored state | `crates/fullmag-authoring/src/universe_state.rs` | `UniverseStateWire` | FEM | unit tests in the same file | written; production code checked by `cargo check` |
| Canonical policy | `crates/fullmag-ir/src/mesh_policy.rs` | `FemAirboxMeshPolicyIR` | FEM | `crates/fullmag-ir/tests/physics_object_ir.rs` | written; production code checked by `cargo check` |
