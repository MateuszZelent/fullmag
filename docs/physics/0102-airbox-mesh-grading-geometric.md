# Airbox mesh grading

- Status: geometric and legacy linear field generation implemented; full 0105 production evidence pending
- Last updated: 2026-10-10
- Governing ADR: `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md`

(airbox-grading-problem-statement)=
## 1. Problem statement

Poisson-airbox FEM needs a conforming fine magnetic-air interface and a coarser
far field. Airbox policy controls only air-eligible zones; it cannot coarsen an
object/interface target selected by canonical
`Max(Min(upper), Max(lower))` composition.

(airbox-grading-governing-equations)=
## 2. Governing equations

In a source-free air region the scalar magnetostatic potential satisfies

```{math}
:label: eq-airbox-laplace

\nabla^2\phi=0.
```

For a localized source, the exterior multipole expansion has the asymptotic
orders

```{math}
:label: eq-airbox-multipole-decay

|\phi_\ell(r)|=O(r^{-(\ell+1)}),
\qquad
|\nabla\phi_\ell(r)|=O(r^{-(\ell+2)}),
\qquad r\to\infty,
```

where the dipole term ($\ell=1$) is commonly the leading nonzero far-field
contribution for a finite magnet. This decay motivates allocating smaller
elements near the magnetic interface and larger elements farther away. It
does not by itself prove an element-count reduction or a solution-error bound;
those are scenario- and discretization-dependent and require the 0105 measured
quality, convergence, and observable gates.

For distance $d$ over resolved span $[d_0,d_1]$:

```{math}
:label: eq-airbox-normalized-distance

s(d)=\operatorname{clamp}\!\left(\frac{d-d_0}{d_1-d_0},0,1\right).
```

The implemented normalized geometric profile is

```{math}
:label: eq-airbox-geometric-profile

\psi(s,g)=
\begin{cases}
s,&g\le1,\\
\dfrac{\log(1+(g-1)s)}{\log g},&g>1,
\end{cases}
\qquad
h(d)=h_\min\exp\!\left[\log\!\left(\frac{h_\max}{h_\min}\right)\psi(s,g)\right].
```

Thus $h(d_0)=h_\min$ and $h(d_1)=h_\max$. For explicit rectangular airboxes,
the envelope uses independent normalized side clearances and their maximum;
corner plumes additionally use diagonal clearance. Linear grading remains a
legacy explicit option, not the default scientific recommendation.

(airbox-grading-symbols-and-si-units)=
## 3. Symbols and SI units

| LaTeX token | Meaning | SI unit |
|---|---|---|
| $\phi$ | scalar magnetostatic potential in air | $\mathrm A$ |
| $r$ | radial distance in the exterior asymptotic model | $\mathrm m$ |
| $\ell$ | multipole order | $1$ |
| $O(\cdot)$ | asymptotic order | stated by its argument |
| $d$ | distance from the owning magnetic feature | $\mathrm m$ |
| $d_0$ | hold/start distance | $\mathrm m$ |
| $d_1$ | resolved outer transition distance | $\mathrm m$ |
| $s(d)$ | clamped normalized distance | $1$ |
| $g$ | geometric ramp-shape/growth parameter | $1$ |
| $\psi(s,g)$ | normalized geometric interpolation | $1$ |
| $h(d)$ | airbox target size at distance $d$ | $\mathrm m$ |
| $h_\min$ | eligible near-feature air target | $\mathrm m$ |
| $h_\max$ | far-air maximum target | $\mathrm m$ |
| $R$ | exact radius of the circular hole in a ring geometry | $\mathrm m$ |
| $i$ | index of a consecutive polygon edge, wrapping after the final vertex | $1$ |
| $\pi$ | ratio of a circle's circumference to its diameter | $1$ |
| $\sin$ | sine function applied to an angle in radians | $1$ |
| $\sum_i$ | sum over all consecutive polygon edges | $1$ |
| $\Delta\theta_i$ | positive angular gap between consecutive polygon vertices on the hole wall | $\mathrm{rad}$ |
| $\Delta\theta_\max$ | largest angular gap on the polygonal hole wall | $\mathrm{rad}$ |
| $A_\mathrm{poly}$ | cross-sectional area of the polygonal hole used by the straight-sided mesh | $\mathrm{m^2}$ |
| $\Delta A$ | circular-hole area minus polygonal-hole area | $\mathrm{m^2}$ |
| $t$ | axial thickness of the ring body | $\mathrm m$ |
| $V_\mathrm{tet}$ | volume represented by the straight-sided tetrahedra in the ring body | $\mathrm{m^3}$ |
| $V_\mathrm{CAD}$ | exact box-minus-cylinder volume of the ring body | $\mathrm{m^3}$ |

(airbox-grading-assumptions-and-validity)=
## 4. Assumptions and validity

- Surface, edge and corner air plumes are independent zones with independent
  spans; no implicit reuse is hidden after public lowering.
- `"airbox_boundary"` requires explicit/effective rectangular bounds and fails
  when those bounds cannot be resolved.
- Flat faces do not receive curvature refinement solely because curvature is
  enabled; curvature contributes an independent upper source only where a
  positive radius is sampled.
- The current spherical envelope has its own radial expression; production
  status still requires the same distance-band evidence.
- The Laplace and multipole equations apply to the source-free exterior model;
  material interfaces supply boundary data and the bounded airbox plus Robin
  truncation approximate the infinite exterior.
- The decay order is physical motivation only. Mesh error also depends on
  polynomial order, element shape, boundary truncation, coefficients and the
  target observable; no universal $\varepsilon(h)$ law is asserted here.

(airbox-grading-python-api)=
## 5. Python API

| Python | Type | Default | SI unit | Validation / error | Meaning | Backend support | ProblemIR destination | Source |
|---|---|---|---|---|---|---|---|---|
| `study.universe.mesh.maximum_element_size` | `float \| None` | `None` | $\mathrm m$ | finite $>0$; malformed value gives `ValueError` | far-air upper target | FEM CPU/GPU | `runtime_metadata.mesh_workflow.airbox.maximum_element_size` | `packages/fullmag-py/src/fullmag/world.py::StudyUniverseHandle.mesh` |
| `study.universe.mesh.minimum_element_size` | `float \| None` | `None` | $\mathrm m$ | finite $>0$ and $\le$ maximum; conflict gives `ValueError` | near-air lower policy, never magnetic clamp | FEM CPU/GPU | `runtime_metadata.mesh_workflow.airbox.minimum_element_size` | `packages/fullmag-py/src/fullmag/world.py::StudyUniverseHandle.mesh` |
| `study.universe.mesh.maximum_element_growth_rate` | `float \| None` | `None` | $1$ | finite $0<g\le2.5$; otherwise `ValueError` | requested air growth/ramp shape | FEM CPU/GPU | `runtime_metadata.mesh_workflow.airbox.maximum_element_growth_rate` | `packages/fullmag-py/src/fullmag/world.py::StudyUniverseHandle.mesh` |
| `study.universe.mesh.grading` | `"auto" \| "geometric" \| "linear" \| None` | `None` | $1$ | other token gives `ValueError` | grading algorithm intent | FEM CPU/GPU | `runtime_metadata.mesh_workflow.airbox.grading` | `packages/fullmag-py/src/fullmag/world.py::StudyUniverseHandle.mesh` |

Compatibility aliases `hmax`, `hmin`, and `growth_rate` are accepted by the
current reader, but canonical exporters emit the long names.

```python
# %% Configure one conforming airbox grading policy.
import fullmag as fm

fm.reset()
study = fm.study("airbox-grading")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(300e-9, 220e-9, 180e-9))
study.universe.mesh(
    maximum_element_size=40e-9,
    minimum_element_size=2e-9,
    maximum_element_growth_rate=1.3,
    grading="geometric",
)
body = study.geometry(fm.Box(size=(80e-9, 40e-9, 4e-9)), name="film")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(maximum_element_size=4e-9, transition_distance="airbox_boundary")
study.exchange()
study.demag(realization="poisson_robin")
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1)
```

(airbox-grading-problem-ir)=
## 6. ProblemIR

Requested token/value stays in `runtime_metadata.mesh_workflow`. Resolved
numeric spans, Gmsh field descriptors, side/corner coverage and statuses belong
to the build report. The mesh asset is derived evidence, not authoring truth.

Typowany model V04 przechodzi wyłącznie w jednym atomic writer cutover z ADR
0024/0027; dual-write V03/V04 jest zabroniony.

(airbox-grading-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

Python/UI preserve requested intent; resolved execution records grading mode,
numeric spans and selected fields. Validation errors reject non-positive,
non-finite, reversed bounds and invalid tokens. Unsupported combinations fail
before meshing. A skipped plume is `degraded` with reason, never silently
equivalent. Empty near/mid/far/corner sampling bands fail the 0105 production
gate.

(airbox-grading-discrete-realization)=
## 8. Discrete realization

| Solver | Device | Status |
|---|---|---|
| FDM | CPU | not applicable: FDM uses regular-grid padding |
| FDM | GPU | not applicable: FDM uses regular-grid padding |
| FEM | CPU | GEO/OCC geometric and linear fields implemented; full solver-quality gate pending |
| FEM | GPU | consumes the same realized mesh; device qualification remains separate |

Surface, edge, corner, transition-air and far-air zones enter the canonical
upper/lower composition independently. Growth is verified on face-adjacent
final cells, not inferred from the MathEval expression.

### Straight-sided boundary of an exact-layer ring

A linear tetrahedral mesh represents a cylindrical hole with a polygonal wall.
For the uniform ring prism used by the exact-layer regression, the chordal
volume bound below applies only if the test first verifies that every hole-wall
vertex lies on radius $R$ within a coordinate-roundoff tolerance scaled by the
largest model coordinate. All exact layer planes must have the same ordered
angular vertex set, with no hole-wall vertices between those planes; the end
caps and outer box must also be flat and unchanged. Those checks make the
represented hole an inscribed polygonal prism rather than an assumption inferred from one
cross-section. For polygon gaps $0<\Delta\theta_i\le\pi$ with
$\sum_i\Delta\theta_i=2\pi$:

```{math}
:label: eq-ring-polygon-hole-area

A_\mathrm{poly}=\frac{R^2}{2}\sum_i\sin(\Delta\theta_i),
\qquad
\Delta A=\pi R^2-A_\mathrm{poly}
=\frac{R^2}{2}\sum_i\left(\Delta\theta_i-\sin(\Delta\theta_i)\right),
\qquad
0\le\Delta A\le\frac{\pi R^2}{6}(\Delta\theta_\max)^2.
```

For each edge, $0\le\Delta\theta_i-\sin(\Delta\theta_i)\le(\Delta\theta_i)^3/6$.
Summing these bounds and using
$\sum_i\Delta\theta_i^3\le(\Delta\theta_\max)^2\sum_i\Delta\theta_i$
gives the stated area bound.
Because the outer box is exact, the mesh body's volume excess is exactly the
missing cylindrical-hole volume for this verified prism case:

```{math}
:label: eq-ring-polygon-hole-volume-bound

V_\mathrm{tet}-V_\mathrm{CAD}=t\,\Delta A,
\qquad
0\le V_\mathrm{tet}-V_\mathrm{CAD}
\le\frac{\pi tR^2}{6}(\Delta\theta_\max)^2.
```

This bounds only the geometric volume difference from straight-sided boundary
facets; it is not a solver-error or physics-accuracy bound. If the common
cross-section and cap conditions are not proven, this prism equation must not
be used to explain a volume difference; a conservative facet-based bound or an
explicit failed applicability check is required instead. The regression derives
the complete body boundary from faces with one incident body tetrahedron,
requires a closed two-facet incidence at every shell edge, and classifies each
face exactly once as a flat cap, an outer side, or the cylindrical hole wall.
For both caps and all four outer sides, planar triangle incidence, boundary
edges, and covered area are checked before the chordal volume bound is used.

(airbox-grading-implementation-mapping)=
## 9. Implementation mapping

`StudyUniverseHandle.mesh` owns public validation;
`_geometric_size_profile_expression` owns the scalar profile;
`_add_airbox_grading_field` applies it; and
`_resolve_airbox_boundary_transition_span` resolves object-to-boundary spans.

(airbox-grading-validation)=
## 10. Validation

Every final air cell is assigned to surface/edge/corner and near/mid/far bands
defined in note 0105. Required bands are nonempty; p50/p95 sizes grow
monotonically within $5\%$; far p95 is within $25\%$ of $h_\max$; interface
p95 obeys the finer object target; Jacobian and quality gates pass. These are
production criteria, not claims about the current partial report.

(airbox-grading-limitations)=
## 11. Limitations

- Current reports do not yet publish the complete canonical band/growth gate.
- Linear grading remains compatibility behavior and is not removed here.
- FMMQ v1 cannot carry mixed topology quality evidence.
- The scoped exact-layer path currently invokes GEO extrusion with
  `numElements=[1]`, `heights=[1.0]` and `recombine=True` in
  `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py::_generate_coincident_ring_airbox_mesh`.
  This also creates and copies a source-face mesh, so source-face XY density is
  not yet proven independent of the airbox sizing. A planned correction is to
  create the exact CAD layer partitions without mesh-extrusion arguments, then
  generate the conforming 3D mesh after owner-volume and air-volume fields are
  installed. This is a proposed route only: it is not implemented or
  runtime-qualified. GHA regressions must still prove body XY invariance,
  scoped density, exact planes, airbox grading, positive cells and periodic
  pairing before the status changes.
- The resolved exact-layer generator cap and the reported `effective_airbox_target`
  are currently distinct. `_resolve_box_airbox_layer_sizes` derives a finite
  outer target from the interface target and growth ratio when no maximum was
  authored: for $h_\min=10\times10^{-9}\,\mathrm m$ and $g=1.3$, the generated
  cap is $10\times10^{-9}\,\mathrm m\,g^4\approx2.8561\times10^{-8}\,\mathrm m$.
  With $h_\min=15\times10^{-9}\,\mathrm m$, it is approximately
  $4.2842\times10^{-8}\,\mathrm m$. Current GHA diagnostics still
  show `effective_airbox_target.hmax=10 nm` for these implicit-cap cases. The
  report therefore does not yet identify the generator's derived outer cap.
  The intended report correction is additive: expose the derived cap separately
  while preserving authored `None` in requested intent. Until then, do not use
  this report field as evidence of the implicit generator cap.

(airbox-grading-scientific-bibliography)=
## 12. Scientific bibliography

- C. Geuzaine and J.-F. Remacle, Gmsh, <https://doi.org/10.1002/nme.2579>.
- Gmsh 4.15.2 background-field reference, <https://gmsh.info/doc/texinfo/gmsh.html>.

(airbox-grading-source-code-index)=
## 13. Source-code index

| Claim | Path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public universe mesh API | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseHandle` | validates canonical universe mesh controls | FEM CPU/GPU | API tests |
| Geometric profile | `packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py` | `_geometric_size_profile_expression` | emits normalized geometric expression | FEM meshing | unit tests |
| Airbox field | `packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py` | `_add_airbox_grading_field` | creates GEO/OCC airbox grading field | FEM meshing | Gmsh tests |
| Boundary span | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | `_resolve_airbox_boundary_transition_span` | resolves numeric side/corner transition spans | FEM meshing | planner tests |
| Physical model | `docs/physics/0102-airbox-mesh-grading-geometric.md` | `DOC-ANCHOR:airbox-grading-governing-equations` | source-free exterior equations motivating grading | FEM contract | publication review |
| Chordal ring volume bound | `docs/physics/0102-airbox-mesh-grading-geometric.md` | `DOC-ANCHOR:eq-ring-polygon-hole-volume-bound` | conditional geometric bound for a verified common polygonal hole prism | FEM mesh geometry | planned GHA regression |
| Exact-layer ring construction | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_generate_coincident_ring_airbox_mesh` | creates per-plane ring volumes; scoped XY-independence remains unqualified | FEM meshing | actual GHA required |
| Ring volume applicability regression | `packages/fullmag-py/tests/test_meshing.py` | `test_scoped_exact_ring_lower_bound_uses_layer_route_and_report` | must verify all plane vertex sets, radius, caps, and the conditional bound | FEM meshing | planned GHA regression |
| Pure chordal-bound regression | `packages/fullmag-py/tests/test_meshing.py` | `test_ring_chordal_bound_guard_and_refinement` | checks the analytic inequality, invalid geometry rejection, and bound tightening under refinement | FEM mesh geometry | source test added; GHA pending |
| Exact-layer airbox target resolution | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_resolve_box_airbox_layer_sizes` | derives interface and finite outer cap for the exact-layer Box/ring generator | FEM meshing | implemented |
| Effective-target report | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `_resolve_effective_shared_domain_targets` | reports resolved airbox intent, not yet the exact-layer generator's implicit cap | FEM meshing | report limitation |
