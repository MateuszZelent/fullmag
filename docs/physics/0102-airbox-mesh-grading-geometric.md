# Airbox mesh grading

- Status: geometric and legacy linear field generation implemented; full 0105 production evidence pending
- Last updated: 2026-08-27
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
