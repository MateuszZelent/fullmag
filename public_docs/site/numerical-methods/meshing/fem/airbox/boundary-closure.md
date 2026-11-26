---
title: "Airbox outer-boundary closure"
description: "Outer mesh marker versus separately selected FEM demagnetization closure."
summary: "A boundary marker is mesh provenance, not a physical boundary equation."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "AirboxOptions, periodic OCC groups, 2D-periodic pure-Neumann gauge pin, open-airbox k=0 Robin modal closure, PBC cuDSS, and demag authoring"
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
| FEM CPU | implemented | Open-airbox Poisson Robin/Dirichlet, 2D-periodic pure-Neumann ($\beta = 0$) + singleton gauge pin, and isolated `open_airbox_k0` Robin modal closure (`demag_kind="open_airbox_k0"`) |
| FEM GPU | implemented (capability-gated) | Open-airbox and 1D/2D PBC-reduced `cuDSS` / `cg_amg` static Poisson demagnetization, plus single-$k$ GPU Floquet modal closure (`augmented_floquet_cudss_cuda`); see {ref}`numerical-methods-performance-fem-gpu-demag` |
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
study.stages.add_relax(stage_id="equilibrium", algorithm="llg_overdamped", dt=5.0e-13, max_steps=1000)
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

The OCC path assigns periodic physical surfaces first, then adds remaining `gamma_out` faces using `boundary_marker` and name `Gamma_out`; interface faces are separate. Native MFEM boundary closure applies three specialized rules on top of the realized outer marker:

1. **2D-periodic thin-film pure-Neumann closure ($\beta = 0$) with singleton gauge pin:** When a planned Poisson–Robin airbox runs on a mesh with **exactly two periodic axes**, a nonzero Robin coefficient $\beta > 0$ leaks a uniform stray field ($N_{zz} = (1+\beta d)/(1+\beta L) \ne 1$). Native demagnetization therefore resolves $\Gamma_{\mathrm{out}}$ to pure Neumann ($\beta = 0$) and eliminates the constant nullspace by pinning one open-boundary potential true-DOF whose periodic equivalence class is a singleton (`film_neumann_gauge_pin_tdof`), zeroing eliminated classes in the RHS on both CPU and GPU reduced periodic solves.
2. **Open-airbox $k=0$ Robin modal closure (`magnetostatic_bc="open_airbox_k0"`):** Isolated bodies inside a Robin airbox can request dynamic Poisson demagnetization for $k=0$ eigenmodes (`demag_kind="open_airbox_k0"`). The v6 mesh certificate accepts identity views (zero periodic boundary nodes/pairs) strictly when paired with a Robin outer boundary, reusing the CPU Schur/SLEPc modal solver while keeping GPU fail-closed for that CPU Schur lane.
3. **GPU direct `cuDSS` and single-$k$ Floquet modal solves:** For open and 1D/2D PBC-reduced static Poisson matrices, `try_initialize_demag_cudss_direct` resolves the three-state `auto | cg_amg | cudss` strategy with VRAM budget preflight. For periodic nonzero-$\mathbf{k}$ modal solves on GPU, `solve_floquet_airbox_augmented_ritz` executes the augmented Floquet `cuDSS` shift-invert path (`augmented_floquet_cudss_cuda`). See {ref}`numerical-methods-performance-fem-gpu-demag`.

(airbox-boundary-closure-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol |
| --- | --- | --- |
| marker default | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L927) | [`class AirboxOptions`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L927) |
| periodic marker allocation | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py#L384) | [`def _add_periodic_boundary_physical_groups`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py#L384) |
| periodic exclusion | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py#L244) | [`def _configure_axis_periodic_surfaces`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py#L244) |
| demag authoring | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6437) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6437) |

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
| marker default | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L927) | [`class AirboxOptions`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L927) | source-backed |
| periodic groups | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py#L384) | [`def _add_periodic_boundary_physical_groups`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py#L384) | source-backed |
| outer pairing | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py#L244) | [`def _configure_axis_periodic_surfaces`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py#L244) | source-backed |
| canonical realization validation/lowering | [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L51) | [`class Demag`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L51) | source-backed |
| 2D-periodic pure-Neumann gauge pin | [`backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L88) | [`film_neumann_gauge_pin_tdof`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L88) | Resolves 2D-periodic films to $\beta=0$ Neumann and pins one singleton-class open-boundary potential DOF. |
| GPU open/PBC `cuDSS` strategy | [`backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.hpp#L158) | [`try_initialize_demag_cudss_direct`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.hpp#L158) | Three-state `auto \| cg_amg \| cudss` resolver for open and 1D/2D PBC-reduced SPD Poisson systems. |
| single-$k$ GPU Floquet modal solve | [`backends/fem/gpu/frequency_domain/modal_augmented_ritz.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_augmented_ritz.cu#L829) | [`solve_floquet_airbox_augmented_ritz`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_augmented_ritz.cu#L829) | Guarded `cuDSS` shift-invert Floquet modal solve (`augmented_floquet_cudss_cuda`). |
| direct demag request | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6437) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6437) | Public `StudyBuilder.demag` delegates to `world.demag`; world state owns enabled-state and resolved-realization lowering. |
