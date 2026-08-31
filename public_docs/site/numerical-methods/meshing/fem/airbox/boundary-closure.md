---
title: "Airbox outer-boundary closure"
description: "Outer mesh marker versus separately selected FEM demagnetization closure."
summary: "A boundary marker is mesh provenance, not a physical boundary equation."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 969efa0941905825ac569d525f4bdaefc059e2af
source_of_truth: "AirboxOptions, periodic OCC groups, and demag authoring"
---

(public-docs-numerical-methods-meshing-fem-airbox-boundary-closure)=
# Airbox outer-boundary closure

(airbox-boundary-closure-problem-statement)=
## Physical problem

The mesher marks non-periodic outer airbox faces as `Gamma_out`; `study.demag(...)` separately authors the physical model. A closed mesh surface is not proof of an open-boundary closure.

(airbox-boundary-closure-governing-equations)=
## Governing equations

```{math}
:label: eq-airbox-boundary-marker
\Gamma_{\mathrm{out}}=\partial\Omega_a\setminus\Gamma_{\mathrm{periodic}}.
```

(airbox-boundary-closure-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\Gamma_{\mathrm{out}}$ | non-periodic outer airbox surface | $\mathrm{m^2}$ |
| $\partial\Omega_a$ | boundary of auxiliary airbox domain | $\mathrm{m^2}$ |
| $\Gamma_{\mathrm{periodic}}$ | outer faces assigned periodic pairing | $\mathrm{m^2}$ |

(airbox-boundary-closure-assumptions-and-validity)=
## Assumptions and validity

`AirboxOptions.boundary_marker` is a Gmsh tag with default `99`; it does not expose a Robin
coefficient. OCC first selects outer min/max surfaces for periodic pairing, assigns paired-face
physical groups, and removes those paired tags from the faces later assigned to `Gamma_out`.
The invalid state is simultaneous ordinary-outer and periodic ownership of one face. A solved
system can still have truncation error.

| Solver lane | Status | Limit |
| --- | --- | --- |
| FEM CPU | source-backed | No runtime closure result is claimed. |
| FEM GPU | capability-gated | No GPU closure receipt is claimed. |
| FDM CPU | not applicable | FEM shared-domain marker contract. |
| FDM GPU | not applicable | FEM shared-domain marker contract. |

(airbox-boundary-closure-python-api)=
## Python API

```python
# %%
import fullmag as fm
nm = 1e-9
study = fm.study("airbox_boundary")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(600 * nm, 400 * nm, 200 * nm))

# %%
study.universe.mesh(maximum_element_size=80 * nm, minimum_element_size=10 * nm)
body = study.geometry(fm.Box(size=(200 * nm, 100 * nm, 10 * nm), name="film"), name="film")
body.mesh(maximum_element_size=8 * nm, minimum_element_size=4 * nm, order=1)
body.Ms = 800e3
body.Aex = 13e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %%
study.demag(model="airbox", variant="robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", algorithm="llg_overdamped", max_steps=1000)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AirboxOptions.boundary_marker` | `int` | `99` | $1$ | direct dataclass field; mesh-group allocation avoids collisions | Gmsh tag for `Gamma_out` | FEM authoring and mesh metadata are source-backed; runtime lane requires separate qualification; FDM not applicable | `generated boundary physical-group tag` |
| `study.demag.enabled` | `bool` | `True` | $1$ | coerced with `bool(enabled)` after `Demag` validation | demag enablement | Authoring/lowering contract only; runtime depends on the resolved realization and a separately qualified lane | `_state._demag_enabled` |
| `study.demag.model` | `str \| None` | `None` | $1$ | `None`, `airbox`, `bem`, `fredkin_koehler`, or `fmm`; mutually exclusive with `realization` | canonical demag model | Authoring vocabulary only; `bem` is future/unimplemented; runtime requires separate qualification | `_state._demag_realization` |
| `study.demag.variant` | `str \| None` | `None` | $1$ | With `model="airbox"`: `auto`, `dirichlet`, or `robin`; with another model: rejected; with non-`None` `realization` and no model: ignored; without model/realization: rejected | airbox closure variant | Authoring/lowering contract only; runtime depends on the resolved realization and a separately qualified lane | `_MODEL_TO_IR` |
| `study.demag.realization` | `str \| None` | `None` | $1$ | Exact string membership; accepts `auto`, `bem`, `fmm`, `fredkin_koehler`, `poisson_dirichlet`, `poisson_robin`, `poisson_airbox`, `airbox_robin`, or `airbox_dirichlet`; no whitespace/case normalization; unknown values are rejected | legacy realization request | Authoring/lowering contract only; runtime depends on the resolved realization and a separately qualified lane | `_state._demag_realization` |

### Demagnetization branch precedence and legacy vocabulary

The constructor separates authored intent from resolved realization in this exact order:

| Authored state | Validation and lowering | Resolved consequence |
| --- | --- | --- |
| `model is not None` and `realization is not None` | Rejected as mutually exclusive before either model or legacy realization is selected. | No realization is produced. |
| `model is not None`, `realization is None` | The model branch validates `model`; `variant` is validated for that model. Only `model="airbox"` accepts `auto`, `dirichlet`, or `robin`; a non-airbox model rejects a supplied variant. | `airbox/auto` and `airbox/robin` lower to `poisson_robin`; `airbox/dirichlet` lowers to `poisson_dirichlet`; the other accepted models with no variant lower to their model realization. |
| `model is None`, `realization is not None` | The legacy realization branch runs before standalone-variant validation. It checks exact membership in `_DEMAG_ALLOWED` without `strip()` or `lower()` and ignores `variant`, including an otherwise invalid value. | The exact legacy value is lowered through the alias table below. |
| `model is None`, `realization is None`, `variant is not None` | Rejected because no branch owns the variant. | No realization is produced. |

| Accepted legacy authored realization (exact string) | Resolved realization |
| --- | --- |
| `auto` | `auto` |
| `bem` | `bem` |
| `fmm` | `fmm` |
| `fredkin_koehler` | `fredkin_koehler` |
| `poisson_dirichlet` | `poisson_dirichlet` |
| `poisson_robin` | `poisson_robin` |
| `poisson_airbox` | `poisson_robin` |
| `airbox_robin` | `poisson_robin` |
| `airbox_dirichlet` | `poisson_dirichlet` |

Any other exact legacy realization is rejected; values such as `" BEM "` and `"BEM"` are not accepted. These tables establish Python validation and lowering, not runtime availability. In particular, `Demag(model="bem")` is accepted vocabulary but BEM is explicitly future/unimplemented in the current Python source; `fmm` acceptance likewise does not qualify a runtime lane.

(airbox-boundary-closure-problem-ir)=
## ProblemIR

The marker is generated mesh data. `study.demag(...)` first constructs `Demag`, then coerces
`enabled` with `bool` and stores `Demag._resolved_realization()`. Canonical mappings are
`airbox/auto -> poisson_robin`, `airbox/robin -> poisson_robin`,
`airbox/dirichlet -> poisson_dirichlet`, and each non-airbox model with implicit `auto` maps to
its model name. Legacy aliases use exact-key lookup: `poisson_airbox` and `airbox_robin` map to
`poisson_robin`, and `airbox_dirichlet` maps to `poisson_dirichlet`; no whitespace or case
normalization is applied.

(airbox-boundary-closure-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is airbox mesh plus `enabled`, `model`, `variant`, or legacy `realization`.
**Resolved execution** contains disjoint outer/periodic marker data and a canonical demag
realization. **Validation errors** include `model` with `realization`, `variant` without `model`,
an airbox variant outside the supported set, any variant on a non-airbox model, invalid legacy
vocabulary, invalid mesh generation, or missing required shared-domain air. **Unsupported
combinations** include retaining one face simultaneously as ordinary outer and periodic, or
interpreting a marker as a physical equation.

In validator vocabulary, unsupported combinations are rejected rather than lowered to a fallback.

(airbox-boundary-closure-discrete-realization)=
## Discrete realization

The OCC path assigns periodic physical surfaces first, then adds remaining `gamma_out` faces using `boundary_marker` and name `Gamma_out`; interface faces are separate.

(airbox-boundary-closure-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol |
| --- | --- | --- |
| marker default | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `class AirboxOptions` |
| periodic marker allocation | `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py` | `def _add_periodic_boundary_physical_groups` |
| periodic exclusion | `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py` | `def _configure_axis_periodic_surfaces` |
| demag authoring | `packages/fullmag-py/src/fullmag/world.py` | `def demag` |

(airbox-boundary-closure-validation)=
## Validation

Inspect outer and interface facets, markers, and periodic-face exclusion; then run an outer-distance and mesh-refinement study. No runtime, coefficient, or parity proof is supplied.

(airbox-boundary-closure-limitations)=
## Limitations

The marker default is not a global uniqueness proof and no public coefficient API is exposed.

(airbox-boundary-closure-scientific-bibliography)=
## Scientific bibliography

- C. Abert, *European Physical Journal B* **92** (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(airbox-boundary-closure-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Evidence |
| --- | --- | --- | --- |
| marker default | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `class AirboxOptions` | source-backed |
| periodic groups | `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py` | `def _add_periodic_boundary_physical_groups` | source-backed |
| outer pairing | `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py` | `def _configure_axis_periodic_surfaces` | source-backed |
| canonical realization validation/lowering | `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | source-backed |
| direct demag request | `packages/fullmag-py/src/fullmag/world.py` | `def demag` | source-backed module-level public entry point; the `StudyBuilder.demag` method delegates to it |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | Public `StudyBuilder.demag` delegates to `world.demag`; world state owns enabled-state and resolved-realization lowering. |
