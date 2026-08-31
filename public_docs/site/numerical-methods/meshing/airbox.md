---
title: "FEM airbox meshing"
description: "Exterior-domain geometry, grading, boundary markers and convergence for FEM magnetostatics."
summary: "Public authoring and realization semantics for a conforming FEM airbox around magnetic geometry."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 969efa0941905825ac569d525f4bdaefc059e2af
source_of_truth: "current public authoring, ProblemIR lowering, mesh realization, and build report"
---

(public-docs-numerical-methods-meshing-airbox)=
# FEM airbox meshing

(airbox-problem-statement)=
## Problem statement

An airbox is the finite nonmagnetic exterior domain around magnetic geometry in an
unstructured FEM shared-domain mesh. It is authored at study scope, not as an
independent magnetic body. The outer geometry, region markers, conforming interfaces and
outer-boundary marker are mesh data; a physical outer-boundary closure remains a separate
solver decision.

(airbox-governing-equations)=
## Governing equations

For the scalar-potential demagnetization formulation on the shared magnetic-plus-air domain,
the current-free exterior uses

```{math}
:label: eq-airbox-poisson

\nabla\!\cdot\!\left(-\nabla u+\mathbf{M}\right)=0,
\qquad \mathbf{H}_d=-\nabla u.
```

Exterior sizing can use geometric grading from a near-interface target $h_0$:

```{math}
:label: eq-airbox-geometric-grading

h_j=\min(h_{\mathrm{far}},h_0 r^j),\qquad r>1.
```

(airbox-symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
| --- | --- | --- |
| $u$ | scalar magnetic potential | $\mathrm{A}$ |
| $\mathbf{M}$ | magnetization in the magnetic region | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_d$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $h_j$ | target airbox element size in grading layer $j$ | $\mathrm{m}$ |
| $h_0$ | near-interface target element size | $\mathrm{m}$ |
| $h_{\mathrm{far}}$ | far-field element-size cap | $\mathrm{m}$ |
| $r$ | geometric grading ratio | $1$ |

(airbox-assumptions-and-validity)=
## Assumptions and validity

The finite airbox is a truncation of an exterior problem, not proof of an open-boundary
solution. Converge outer distance separately from magnetic and air-region discretization.
The OCC shared-domain route realizes an exact sphere only when
`AirboxOptions.shape == "sphere"`; every other value takes its box branch. The mixed swept
shared-domain route accepts only normalized `bbox`; a non-bbox request is rejected. In
`component_aware` and `concatenated_stl_fallback` modes, a requested sphere is realized as a
`bbox` and the mesh report records `status="degraded"`, `requested_method="sphere"` and
`actual_method="bbox"`.

When that mixed route derives size automatically, `padding_factor` must be finite and strictly
greater than `1`. Explicit `size` and `center` are finite three-vectors and the airbox must
strictly contain the magnetic body. The public `study.universe(...)` handle does not expose
`shape` or `padding_factor`; they are realization-schema fields, documented here so that
requested and realized shapes are not conflated.

(airbox-python-api)=
## Python API

### Complete public signature and IR matrix

The following rows are the exhaustive public-signature contract for this page; each row mirrors one public_api.parameters entry in the source map.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| study.universe(mode=...) | str \| None | None | 1 | forwarded to StudyUniverseConfig | domain mode | FEM CPU/GPU capability-gated | runtime_metadata.study_universe.mode |
| study.universe(size=...) | Sequence[float] \| None | None | m | as_vector3; explicit dimensions must be positive when realized | outer dimensions | FEM CPU/GPU capability-gated | runtime_metadata.study_universe.size |
| study.universe(center=...) | Sequence[float] \| None | None | m | as_vector3 | outer center | FEM CPU/GPU capability-gated | runtime_metadata.study_universe.center |
| study.universe(padding=...) | Sequence[float] \| None | None | m | as_vector3; domain validation governs signs | directional padding | FEM CPU/GPU capability-gated | runtime_metadata.study_universe.padding |
| study.universe.mesh(maximum_element_size=...) | float \| None | None | m | positive | airbox coarse target | FEM CPU/GPU capability-gated | runtime_metadata.study_universe.airbox_hmax |
| study.universe.mesh(minimum_element_size=...) | float \| None | None | m | positive and no greater than numeric maximum | airbox lower clamp | FEM CPU/GPU capability-gated | runtime_metadata.study_universe.airbox_hmin |
| study.universe.mesh(maximum_element_growth_rate=...) | float \| None | None | 1 | finite positive at most 2.5 | airbox growth target | FEM CPU/GPU capability-gated | runtime_metadata.study_universe.airbox_growth_rate |
| study.universe.mesh(grading=...) | str \| None | None | 1 | forwarded without vocabulary validation by this handle | airbox grading request | FEM CPU/GPU capability-gated | runtime_metadata.study_universe.airbox_grading |
| study.universe(mode=...) | str or None | None | $1$ | normalized by `_configure_study_universe` | requested universe mode | FEM authoring/lowering; runtime not qualified here | runtime_metadata.study_universe.mode |
| study.universe(size=...) | Sequence[float] or None | None | $\mathrm{m}$ | explicit realized dimensions must be positive | requested outer-domain dimensions | FEM authoring/lowering; runtime not qualified here | runtime_metadata.study_universe.size |
| study.universe(center=...) | Sequence[float] or None | None | $\mathrm{m}$ | supplied center is a finite three-vector at realization | requested outer-domain center | FEM authoring/lowering; runtime not qualified here | runtime_metadata.study_universe.center |
| study.universe(padding=...) | Sequence[float] or None | None | $\mathrm{m}$ | universe configuration validation | requested directional clearance | FEM authoring/lowering; runtime not qualified here | runtime_metadata.study_universe.padding |
| study.universe.mesh(maximum_element_size=...) | float or None | None | $\mathrm{m}$ | positive when supplied | far-field airbox target | FEM authoring/lowering; runtime not qualified here | runtime_metadata.study_universe.airbox_hmax |
| study.universe.mesh(minimum_element_size=...) | float or None | None | $\mathrm{m}$ | positive and no greater than maximum size | near-interface airbox target | FEM authoring/lowering; runtime not qualified here | runtime_metadata.study_universe.airbox_hmin |
| study.universe.mesh(maximum_element_growth_rate=...) | float or None | None | $1$ | positive when supplied | requested neighbor growth limit | FEM authoring/lowering; runtime not qualified here | runtime_metadata.study_universe.airbox_growth_rate |
| study.universe.mesh(grading=...) | str or None | None | $1$ | stored as requested grading mode | requested exterior grading mode | FEM authoring/lowering; runtime not qualified here | runtime_metadata.study_universe.airbox_grading |
| study.build_domain_mesh() | StudyBuilder | n/a | $1$ | requires a realizable shared-domain configuration | public realization boundary | FEM build path; no device-runtime claim | current builder state to shared-domain mesh artifact |
| AirboxOptions.padding_factor | float | 3.0 | $1$ | finite and greater than `1` for automatic mixed shared-domain sizing | automatic magnetic-bounding-box scale | FEM realization only | runtime_metadata.study_universe to AirboxOptions.padding_factor |
| AirboxOptions.shape | str | bbox | $1$ | OCC: exact `sphere` only for that value; mixed swept route requires `bbox` | requested outer geometry | FEM realization only | runtime_metadata.study_universe to route-specific AirboxOptions.shape |



The public authoring boundary is `study.universe(...)`, followed by the separately scoped
`study.universe.mesh(...)`; `StudyBuilder.build_domain_mesh()` realizes the configured shared
domain. `AirboxOptions` is the source-backed realization schema, not a replacement for the
canonical study API.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `study.universe(mode=...)` | `str or None` | `None` | $1$ | normalized by `_configure_study_universe` | requested universe mode | FEM authoring/lowering; runtime not qualified here | `runtime_metadata.study_universe.mode` |
| `study.universe(size=...)` | `Sequence[float] or None` | `None` | $\mathrm{m}$ | explicit realized dimensions must be positive | requested outer-domain dimensions | FEM authoring/lowering; runtime not qualified here | `runtime_metadata.study_universe.size` |
| `study.universe(center=...)` | `Sequence[float] or None` | `None` | $\mathrm{m}$ | supplied center is a finite three-vector at realization | requested outer-domain center | FEM authoring/lowering; runtime not qualified here | `runtime_metadata.study_universe.center` |
| `study.universe(padding=...)` | `Sequence[float] or None` | `None` | $\mathrm{m}$ | universe configuration validation | requested directional clearance | FEM authoring/lowering; runtime not qualified here | `runtime_metadata.study_universe.padding` |
| `study.universe.mesh(maximum_element_size=...)` | `float or None` | `None` | $\mathrm{m}$ | positive when supplied | far-field airbox target | FEM authoring/lowering; runtime not qualified here | `runtime_metadata.study_universe.airbox_hmax` |
| `study.universe.mesh(minimum_element_size=...)` | `float or None` | `None` | $\mathrm{m}$ | positive and no greater than maximum size | near-interface airbox target | FEM authoring/lowering; runtime not qualified here | `runtime_metadata.study_universe.airbox_hmin` |
| `study.universe.mesh(maximum_element_growth_rate=...)` | `float or None` | `None` | $1$ | positive when supplied | requested neighbor growth limit | FEM authoring/lowering; runtime not qualified here | `runtime_metadata.study_universe.airbox_growth_rate` |
| `study.universe.mesh(grading=...)` | `str or None` | `None` | $1$ | stored as requested grading mode | requested exterior grading mode | FEM authoring/lowering; runtime not qualified here | `runtime_metadata.study_universe.airbox_grading` |
| `study.build_domain_mesh()` | `StudyBuilder` | `n/a` | $1$ | requires a realizable shared-domain configuration | public realization boundary | FEM build path; no device-runtime claim | current builder state to shared-domain mesh artifact |
| `AirboxOptions.padding_factor` | `float` | `3.0` | $1$ | finite and greater than `1` for automatic mixed shared-domain sizing | automatic magnetic-bounding-box scale | FEM realization only | `runtime_metadata.study_universe` to `AirboxOptions.padding_factor` |
| `AirboxOptions.shape` | `str` | `bbox` | $1$ | OCC: exact `sphere` only for that value; mixed swept route requires `bbox` | requested outer geometry | FEM realization only | `runtime_metadata.study_universe` to route-specific `AirboxOptions.shape` |

**Complete Python example**

```python
# %%
import fullmag as fm

# %%
nm = 1.0e-9
study = fm.study("airbox_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(600 * nm, 400 * nm, 240 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=80 * nm,
    minimum_element_size=10 * nm,
    maximum_element_growth_rate=1.3,
    grading="geometric",
)

# %%
film = study.geometry(fm.Box(size=(200 * nm, 100 * nm, 10 * nm), name="film"), name="film")
film.mesh(maximum_element_size=8 * nm, minimum_element_size=4 * nm)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=20_000)
```

(airbox-problem-ir)=
## ProblemIR

The public calls lower requested universe mode, dimensions, center, padding and mesh controls
through `runtime_metadata.study_universe`. `build_domain_mesh()` consumes that builder state to
produce the shared-domain mesh artifact. OCC solids, physical tags, quality metrics and any
fallback report are realized artifacts, not user-authored ProblemIR fields.

(airbox-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is the universe and air-mesh policy preserved in builder metadata.
**Resolved execution** is the selected build route, effective shape, mesh artifact and status
report. **Validation errors** reject invalid dimensions, containment and mixed-route padding or
shape violations. **Unsupported combinations** remain fail closed: ordinary open airbox authoring
does not silently become a periodic domain, a different topology, or a CPU/GPU fallback.

(airbox-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Limit |
| --- | --- | --- | --- |
| FEM | CPU | source-backed authoring and mesh lowering | no new native runtime or convergence receipt in this page |
| FEM | GPU | capability-gated after mesh realization | source inspection is not GPU execution or parity proof |
| FDM | CPU | not applicable | structured FDM domain sizing is outside this unstructured FEM airbox page |
| FDM | GPU | not applicable | structured FDM domain sizing is outside this unstructured FEM airbox page |

(airbox-implementation-mapping)=
## Implementation mapping

`StudyUniverseHandle.__call__` and `StudyUniverseHandle.mesh` own the public study policy;
`StudyBuilder.build_domain_mesh` is the public build boundary. `_build_problem` preserves the
builder metadata, and the asset pipeline selects the shared-domain realization. The OCC route
constructs a sphere or box; the mixed swept route enforces its bbox-only policy; the report helper
records route-specific sphere degradation.

(airbox-validation)=
## Validation

After a build, inspect the realized outer marker, magnetic and air-region markers, interface
conformity, counts, quality report, effective shape and any fallback status. Converge outer
distance, exterior sizing and magnetic sizing independently against a physical observable. The
page-specific executable probe exercises public builder/lowering semantics only; it is not a
native FEM, GPU, or scientific-convergence qualification.

(airbox-limitations)=
## Limitations

A geometrically valid mesh does not establish a correct boundary closure or a converged solution.
No runtime claim follows from the page, source map, or builder/lowering probe. Sphere support is
route-specific, and mixed swept meshing deliberately rejects non-bbox requests.

(airbox-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, "Gmsh: a three-dimensional finite element mesh generator with
  built-in pre- and post-processing facilities," *International Journal for Numerical Methods in
  Engineering* **79** (2009), 1309-1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European Physical
  Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(airbox-source-code-index)=
## Source-code index

| ID | Path | Symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| airbox_options | packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py | class AirboxOptions | realization schema and defaults | source-inspected |
| universe_authoring | packages/fullmag-py/src/fullmag/world.py | class StudyUniverseHandle | public universe and air-mesh authoring | source-inspected |
| domain_build | packages/fullmag-py/src/fullmag/world.py | class StudyBuilder | public shared-domain build boundary | source-inspected |
| problem_lowering | packages/fullmag-py/src/fullmag/world.py | _build_problem | builder-state lowering | source-inspected |
| domain_realization | packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py | realize_fem_domain_mesh_asset_from_components_with_report | shared-domain asset realization | source-inspected |
| occ_airbox | packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py | generate_shared_domain_mesh_via_occ | OCC sphere and box realization | source-inspected |
| mixed_airbox | packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py | _add_conforming_swept_box_airbox_geo | mixed-route bbox and padding checks | source-inspected |
| airbox_status | packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py | _airbox_shape_status | requested/effective shape reporting | source-inspected |
| planner | crates/fullmag-plan/src/lib.rs | plan | capability rejection after lowering | source-inspected; runtime unverified |
| runtime | crates/fullmag-runner/src/lib.rs | run_planned_problem | resolved-plan execution boundary | source-inspected; device runtime unverified |
