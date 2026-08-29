---
title: FDM Convolution
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-demag-solvers-fdm-convolution)=
# FDM tensor convolution and FFT demagnetization

(numerical-methods-demag-fdm-problem-statement)=
## Physical and numerical problem

The canonical demagnetizing interaction is documented in
{doc}`../../physics/interactions/demagnetization/fdm-convolution`. This page owns the FDM
realization: a Cartesian cell grid, a cell-averaged demagnetization tensor, zero-padded open-boundary
convolution, and a field/energy reduction with one shared physical convention. Python can author an
FDM CPU or GPU request, but execution and qualification remain separate per device lane.

(numerical-methods-demag-fdm-governing-equations)=
## Governing equations

The cell-averaged field is the tensor convolution

```{math}
:label: eq-numerical-demag-fdm-field
H_{\mathrm d,p,i}=-\sum_q\sum_jN^{\mathrm{cell}}_{pq,ij}M_{q,j}.
```

The energy is reduced from the accepted field and magnetization:

```{math}
:label: eq-numerical-demag-fdm-energy
E_{\mathrm d}=-\frac{\mu_0}{2}\sum_pV_p\,
\mathbf M_p\cdot\mathbf H_{\mathrm d,p}.
```

The open-boundary FFT implementation embeds the finite convolution in a padded domain:

```{math}
:label: eq-numerical-demag-fdm-fft
\widehat{\mathbf H}_{\mathrm d}
=-\widehat{\mathbf N}^{\mathrm{cell}}\widehat{\mathbf M},
\qquad
\mathbf H_{\mathrm d}=\mathcal F^{-1}\left[\widehat{\mathbf H}_{\mathrm d}\right].
```

The tensor is constructed from Newell cell integrals; the FFT is an acceleration of the finite
convolution, not an assumption of periodic physical boundaries.

(numerical-methods-demag-fdm-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $H_{\mathrm d,p,i}$ | field component $i$ in destination cell $p$ | $\mathrm{A\,m^{-1}}$ |
| $N^{\mathrm{cell}}_{pq,ij}$ | cell-averaged demagnetization tensor | $1$ |
| $M_{q,j}$ | source-cell magnetization component | $\mathrm{A\,m^{-1}}$ |
| $\mathbf M_p$ | magnetization in destination cell | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm d,p}$ | demagnetizing field in destination cell | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $V_p$ | destination-cell volume | $\mathrm{m^3}$ |
| $\widehat{\mathbf H}_{\mathrm d}$ | FFT-domain demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\widehat{\mathbf N}^{\mathrm{cell}}$ | FFT of the tensor kernel | $1$ |
| $\widehat{\mathbf M}$ | FFT of packed magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathcal F$ | discrete Fourier transform | $1$ |
| $p,q$ | destination and source cell indices | $1$ |
| $i,j$ | Cartesian component indices | $1$ |

(numerical-methods-demag-fdm-assumptions-and-validity)=
## Assumptions and validity

- The mesh is Cartesian and each active cell has a defined volume and magnetization mask.
- Open boundaries require the documented padding and kernel embedding. A periodic FFT without the
  periodic demag policy is a different problem.
- The cell-averaged Newell tensor is exact for the chosen rectangular-cell discretization; it does
  not remove grid, geometry-mask, or finite-precision error.
- GPU FP32 and FP64 are separate precision lanes. Matching source code is not parity evidence, and
  authoring a GPU request does not prove that the GPU executed it.
- Multilayer convolution uses an explicit multilayer policy with an authored or
  planner-resolved common scratch layout. A failed common-grid resolution must
  not silently fall back to a single-grid approximation.
- Omitting both `common_cells` and `common_cells_xy` delegates scratch-grid selection to Fullmag's
  planner-auto policy. This is not a reproduction of BORIS `ncommonstatus=false`: the authored
  `ProblemIR` simply has no `common_cells*` fields, while the resolved union-scratch layout is
  recorded separately in the plan/provenance.
- Fullmag `mode="two_d_stack"` is not BORIS `2dmulticonvolution=1` or `=2`. It requires one
  native Z cell per layer; use `three_d` for native through-thickness cells.

(numerical-methods-demag-fdm-python-api)=
## Python API

```python
# %% Configure FDM demagnetization as a stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_demag_convolution")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
film = study.geometry(
    fm.Box(size=(100 * nm, 20 * nm, 5 * nm), name="film"),
    name="film",
)
film.mesh(cell_size=(2 * nm, 2 * nm, 5 * nm))
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.demag()
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk45",
    dt_initial=1.0e-15,
    dt_min=1.0e-17,
    dt_max=1.0e-14,
    max_err=1.0e-7,
    tolT=1.0e-6,
    max_steps=50_000,
)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `body.mesh(cell_size=...)` | `Sequence[float]` | required unless a default exists | $\mathrm{m}$ | exactly three finite positive values; object extents must divide exactly | native Cartesian cell size of one magnetic object | FDM CPU/GPU authoring; execution is lane-gated | `backend_policy.discretization_hints.fdm.per_magnet.<object>.cell` |
| `study.objects.mesh.defaults(cell_size=...)` | `Sequence[float]` | `None` | $\mathrm{m}$ | exactly three finite positive values | default native cell size for objects without overrides | FDM CPU/GPU authoring | `backend_policy.discretization_hints.fdm.default_cell` |
| `study.universe.mesh(cell_size=...)` | `Sequence[float]` | planner-selected | $\mathrm{m}$ | exactly three finite positive values; common extents must divide exactly | requested non-physical common convolution-grid resolution | FDM multilayer CPU/GPU authoring; execution is lane-gated | `backend_policy.discretization_hints.fdm.demag.common_cell_size` |
| `study.demag()` | interaction request | disabled until called | $1$ | one demagnetizing interaction per study | requests demagnetization without exposing its numerical storage layout | FDM and FEM | `energy_terms[kind=demag]` |
| `study.mode("strict")` | execution policy | backend default | $1$ | supported mode literal | forbids rounding, fallback, or silent replacement of an invalid requested discretization | all backends | `runtime_selection.mode` |

The older `study.fdm(...)`, `FDMGrid`, and `FDMDemag` forms are migration adapters, not the
canonical authoring surface. For heterogeneous layers, common-XY versus full-3D behavior, and the
complete 2 nm / 5 nm / 10 nm example, see
{doc}`../../physics/interactions/demagnetization/multilayer-convolution`.

(numerical-methods-demag-fdm-problem-ir)=
## ProblemIR and provenance

The physical request remains `Demag`; the FDM policy is nested under
`backend_policy.discretization_hints.fdm`:

```json
{
  "energy_terms": [{"kind": "demag"}],
  "backend_policy": {
    "discretization_hints": {
      "fdm": {
        "default_cell": [2e-9, 2e-9, 5e-9],
        "per_magnet": {
          "film": {"cell": [2e-9, 2e-9, 5e-9]}
        },
        "demag": {"strategy": "auto", "mode": "auto"}
      }
    }
  }
}
```

Normalization records requested strategy and mode. Planning resolves grid dimensions, FFT padding,
mask, precision and memory budget; those resolved values belong to provenance and must not be
inferred from `auto` after the run.

(numerical-methods-demag-fdm-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Script export preserves the stage-first study and object-owned discretization policy. The round
trip reports validation errors for invalid cell sizes and malformed common grids. The unsupported combinations
are explicit: FEM requests, periodic axes without the
periodic demag policy, and unavailable GPU precision lanes are rejected or reported by the planner;
they do not silently become an open single-grid CPU run. A successful Python/ProblemIR GPU request
is authoring evidence only; it becomes a GPU execution claim only with an executed-device receipt.
Requested intent, resolved execution and provenance are separate.

(numerical-methods-demag-fdm-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FDM | CPU | reference | Newell tensor preparation, CPU FFT convolution and field/energy reduction |
| FDM | GPU | source-backed | native FP64/FP32 tensor spectra, CUDA field kernel and reduction; device proof required |
| FEM | CPU | not applicable | scalar-potential FEM is documented on separate pages |
| FEM | GPU | not applicable | scalar-potential FEM is documented on separate pages |

CPU and GPU must share the tensor convention, sign and energy definition. They may differ in FFT
library, storage layout, precision, reductions and residency.

(numerical-methods-demag-fdm-implementation-mapping)=
## Implementation mapping

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | strategy, mode and common-grid validation | public API |
| Newell tensor | `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels` | cell-averaged tensor construction | CPU/reference |
| Tensor convolution | `crates/fullmag-fdm-demag/src/multiply.rs` | `accumulate_tensor_convolution` | symmetric tensor-vector product | CPU/reference |
| CPU field | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `demag_field_from_vectors` | CPU field realization | FDM CPU |
| GPU field | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `launch_demag_field_fp64` | CUDA FP64 field dispatch | FDM GPU |

(numerical-methods-demag-fdm-validation)=
## Validation

Validation requires Newell self-term and tensor symmetry checks, analytical body factors, open-boundary
padding convergence, field/energy consistency, CPU/GPU parity at the same precision, and an executed
device identity for GPU claims. A Python capture or matching FFT output alone is not continuum or
runtime qualification.

(numerical-methods-demag-fdm-limitations)=
## Limitations

The page does not claim arbitrary geometry exactness, universal FP32 accuracy, or periodic physics
from ordinary zero-padded convolution. Partial-cell corrections and multilayer modes remain lane-
and validation-dependent.

(numerical-methods-demag-fdm-scientific-bibliography)=
## Scientific bibliography

- A. J. Newell, W. Williams and D. Dunlop, “A method for computing the demagnetizing factors for rectangular ferromagnetic prisms,” *Journal of Geophysical Research* 98 (1993), DOI: [10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
- J. M. D. Coey, *Magnetism and Magnetic Materials*, Cambridge University Press, 2010.
- Canonical physics owner: {doc}`../../physics/interactions/demagnetization/fdm-convolution`.

(numerical-methods-demag-fdm-source-code-index)=

## Control Room crosswalk

Use `Model Explorer -> Stages -> Add stage -> <stage kind>` for stage-level controls when the terminal page identifies a matching field. The current editor is partial: only fields surfaced by the stage draft are authorable. TODO: frontend support applies to numerical parameters without a matching control. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| FDM policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | public strategy and grid controls | public API | Python tests |
| Newell kernel | `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels` | cell-averaged demag tensor | CPU/reference | Rust tests |
| FFT product | `crates/fullmag-fdm-demag/src/multiply.rs` | `accumulate_tensor_convolution` | tensor-vector product | CPU/reference | Rust tests |
| CPU field | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `demag_field_from_vectors` | CPU field calculation | FDM CPU | engine tests |
| GPU field | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `launch_demag_field_fp64` | CUDA FP64 field kernel dispatch | FDM GPU | CUDA/source contracts |
