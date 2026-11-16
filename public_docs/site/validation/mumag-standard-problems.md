---
title: µMAG Standard Problems
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-validation-mumag-standard-problems)=
# µMAG Standard Problems

µMAG standard problems are community reference benchmarks with published reference outputs.
FullMag's primary standard-problem target is **NIST µMAG Standard Problem 4** (SP4), solved with
the strict FEM backend in double precision.

## Problem definition

SP4 is a $500 \times 125 \times 3\ \mathrm{nm}$ permalloy film with saturation magnetization
$M_s = 800\,000\ \mathrm{A\,m^{-1}}$, exchange stiffness $A_{\mathrm{ex}} = 1.3 \times
10^{-11}\ \mathrm{J\,m^{-1}}$, and damping $\alpha = 0.02$. An S-shaped magnetization state is
relaxed, then one of two applied fields drives a dynamic reversal:

- field 1: $\mathbf{B} = (-24.6, 4.3, 0)\ \mathrm{mT}$;
- field 2: $\mathbf{B} = (-35.5, -6.3, 0)\ \mathrm{mT}$.

The canonical observable is the volume-weighted average of the reduced magnetization; the first
zero-crossing of $\bar m_x$ is compared against the NIST reference corpus (NIST is authoritative,
MuMax3/OOMMF endpoint values are supplementary regression metrics only).

## FullMag setup

- Meshes: magnetic element sizes $3.0$, $2.0$ and $1.5\ \mathrm{nm}$; airboxes $700^3\ \mathrm{nm}$
  and $1000 \times 500 \times 500\ \mathrm{nm}$ with `airbox_hmax = 20 nm`.
- SP4 relaxation uses a strict mixed-prism thin-film route in strict mode:
  `film.mesh.thin_film(..., layers=1, topology="prismatic", exact_layers=True, transition="pyramid_to_tetrahedra", order=1)`.
  The topology-only mesh contract is in
  `tests/standard_problems/mumag/sp4/fem/scenarios/mesh_single_prism_layer.py`.
- Lanes: strict FEM CPU and strict FEM GPU in double precision; GPU demagnetization must resolve to
  `device_hypre_poisson`, never `hybrid_cpu_poisson`.
- Observables use native $M_s \times V$ lumped-volume averages from `scalars.csv`; unweighted node
  averages are not accepted as the NIST observable.
- Uninterrupted trajectories are sampled every $1\ \mathrm{ps}$; replay runs start from the same
  S-state and stop at the bracketing zero-crossing.

The public stage scenario is
`tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`, and the managed
gate is:

```console
just verify-fem-standard-problem-4
```

## Standard SP4 source-first entry

### 1) Introduction

Public qualification for muMag Standard Problem #4 follows the same chain: scenario authoring →
`strict` meshing topology → managed verification harness (`verify-fem-standard-problem-4`) → NIST/convergence/CPU-GPU acceptance gates.

### 2) Direct source-level contract

The scenario and mixed-element mesh tests fix the required configuration:

- `tests/standard_problems/mumag/sp4/fem/scenarios/mesh_single_prism_layer.py`
  constructs the film geometry and prismatic mesh constraints;
- `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`
  runs the NIST SP4 relaxation sequence;
- `packages/fullmag-py/tests/test_mixed_element_meshing.py`
  validates the `prism6` + `pyramid5` + `tet4` mixed-element profile.

For the meshing route:

- `GeometryMeshHandle.thin_film(...)`
  → `topology="prismatic"`, `exact_layers=True`, `transition="pyramid_to_tetrahedra"`, `order=1`

### 3) Python authoring pattern

```python
import fullmag as fm
from fullmag.select import in_object

study = fm.study("sp4_strict")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(
    mode="manual",
    size=(800e-9, 400e-9, 200e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=100e-9)

film = study.geometry(
    fm.Box(500e-9, 125e-9, 3e-9),
    name="film",
    object_id="film",
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh(
    topology="prismatic",
    exact_layer_count=True,
    through_thickness_elements=1,
    through_thickness_distribution="fixed",
    transition_policy="pyramid_to_tetrahedra",
    order=1,
    mesh_strategy="swept_prism",
    sweep_face_meshing="triangular",
    sweep_direction="auto",
    element_family="prism",
)

frozen = fm.FrozenSpins(
    id="sp4_init_fixed",
    selector=in_object("film"),
    stage_ids=("relax",),
)
study.stages.add_relax(
    stage_id="relax",
    dt=5.0e-13,
    max_steps=1,
    constraints=(frozen,),
)
```

### 4) Functions and arguments (used directly)

| Function | Arguments relevant to SP4 |
|---|---|
| `GeometryMeshHandle.thin_film` | `hmax`, `hmin`, `order`, `curvature_factor`, `narrow_region_resolution`, `layers`, `topology`, `exact_layers`, `transition`, `interface_maximum_element_size`, `surface_maximum_element_size`, `edge_maximum_element_size`, `corner_maximum_element_size` |
| `PerObjectMeshRecipe` fields (strict route) | `mesh_strategy="swept_prism"`, `topology="prismatic"`, `through_thickness_elements` (`1`/`2`/`3`), `through_thickness_distribution`, `exact_layer_count=True`, `sweep_face_meshing="triangular"`, `transition_policy="pyramid_to_tetrahedra"`, `element_family="prism"`, `order=1` |
| `study.mode` | `strict` (gates mixed-topology route) |
| `GeometryMeshHandle.configure` | forwards the full size, quality, layer, and strategy configuration contract to the thin-film meshing route |

### 5) Code references

- `tests/standard_problems/mumag/sp4/fem/scenarios/mesh_single_prism_layer.py`
- `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`
- `packages/fullmag-py/src/fullmag/world.py` (`GeometryMeshHandle.thin_film`, `topology="prismatic"` validation)
- `packages/fullmag-py/src/fullmag/model/discretization.py` (`PerObjectMeshRecipe`, `PerObjectMeshLayeredRecipe`)
- `packages/fullmag-py/tests/test_mixed_element_meshing.py`

### 6) Bibliography

- MuMax3/SP4 reference datasets and NIST SP4 artifacts (public NIST benchmark references used as acceptance target).
- Abert, C. “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

## Current status

Relaxed S-state and reversal-run artifacts exist for FEM CPU and FEM GPU
(coarse/baseline). The time-domain `qualification` record currently reports
`not_evaluated` / `unvalidated` for the adaptive RK runs: artifact creation alone is not evidence
of validation, and the dedicated NIST/convergence/CPU-GPU/no-fallback gate has not yet been
closed. Do not treat this page as a claim that SP4 is physics-validated.

SP4 acceptance requires, per lane: NIST trajectory agreement, mesh and airbox convergence,
CPU/GPU parity within the documented tolerances, and no silent fallback. Status advances only
when the full managed gate passes.
## Control Room crosswalk

Validation pages are `inspection-only` in Control Room. The UI may expose runtime metadata, fields, tables, or reports for inspection, but it does not create a qualification claim. `TODO: frontend support` applies to validation workflow authoring and report publication unless a specific control is named. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Validation is not a standalone Python constructor unless the linked case page names one. Reproduce the exact case, inputs, device, precision, and receipt described by the page; use the referenced API pages for callable signatures.

## Physics and bibliography scope

The page either states the governing benchmark model or delegates it to the linked physics/numerical-methods page. Any missing derivation is a documented boundary, not an implicit equation. Bibliography and source evidence remain the authoritative references listed by the validation case.
## Source-code index

- No standalone implementation function is introduced by this validation page. Source evidence is the exact API, managed recipe, runtime manifest, and receipt named by the validation case.

