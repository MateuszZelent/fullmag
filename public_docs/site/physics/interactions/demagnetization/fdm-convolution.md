---
title: FDM Convolution
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-demagnetization-fdm-convolution)=
# FDM Convolution

The FDM realization evaluates the non-local demagnetizing operator by a cell-averaged Newell
tensor and FFT convolution. CPU and CUDA implementations share the physical tensor contract but
have separate storage, precision, and execution paths.

(demag-fdm-problem-statement)=
## Physical problem

For cells $p$ and $q$, $N^{\mathrm{cell}}_{pq}$ is the cell-averaged demagnetization tensor.

(demag-fdm-governing-equations)=
## Governing equations

```{math}
:label: eq-fdm-demag-field
H_{\mathrm d,p,i}=-\sum_qN^{\mathrm{cell}}_{pq,ij}M_{q,j}.
```

```{math}
:label: eq-fdm-demag-energy
E_{\mathrm d}=-\frac{\mu_0}{2}\sum_pV_p\mathbf M_p\cdot\mathbf H_{\mathrm d,p}.
```

(demag-fdm-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $N^{\mathrm{cell}}_{pq,ij}$ | cell-averaged demag tensor | $1$ |
| $M_{q,j}$ | component $j$ of cell magnetization | $\mathrm{A\,m^{-1}}$ |
| $H_{\mathrm d,p,i}$ | component $i$ of cell demag field | $\mathrm{A\,m^{-1}}$ |
| $V_p$ | cell volume | $\mathrm{m^3}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $p,q$ | destination and source cell indices | $1$ |
| $i,j$ | Cartesian component indices | $1$ |

(demag-fdm-assumptions-and-validity)=
## Assumptions and validity

The grid is Cartesian and the tensor is averaged over source and destination cells. Open-boundary
FFT convolution requires adequate zero padding. Periodic FDM uses a finite truncated-image sum and
is not an exact infinite periodic sum.

(demag-fdm-python-api)=
## Python API

```python
# %% Select a multi-layer FDM convolution policy
import fullmag as fm

policy = fm.FDMDemag(
    strategy="multilayer_convolution", mode="two_d_stack",
    common_cells_xy=(512, 512),
)
print(policy.to_ir())
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FDMDemag.strategy` | `str` | `auto` | $1$ | `auto`, `single_grid`, or `multilayer_convolution`. | Selects convolution topology. | FDM CPU/GPU. | `discretization.demag.strategy` |
| `FDMDemag.mode` | `str` | `auto` | $1$ | `auto`, `two_d_stack`, or `three_d`. | Selects stack dimensionality. | FDM CPU/GPU. | `discretization.demag.mode` |
| `FDMDemag.common_cells` | `tuple[int,int,int] \| None` | `None` | $1$ | Three positive integers. | Explicit 3-D convolution shape. | FDM lanes. | `discretization.demag.common_cells` |

(demag-fdm-problem-ir)=
## ProblemIR

`FDMDemag.to_ir()` records strategy, mode, and explicit common-grid sizes. The planner resolves
whether the selected policy is legal for the magnets and backend.

(demag-fdm-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is preserved in the exported policy. Resolved execution identifies CPU reference
or CUDA precision. Validation errors and unsupported combinations are reported explicitly; the removed
single-grid fallback flag cannot authorize a hidden fallback.

(demag-fdm-discrete-realization)=
## Discrete realization

Newell spectra are computed once for a grid and applied component-wise by FFT. CUDA has separate
FP32 and FP64 kernels and reductions. Precision is part of execution provenance.

(demag-fdm-implementation-mapping)=
## Implementation mapping

`compute_newell_kernels` creates the cell tensor; `accumulate_tensor_convolution` applies it in the
FDM demag crate; `launch_demag_field_fp64` is the CUDA FP64 dispatch.

(demag-fdm-validation)=
## Validation

Validate tensor symmetry, self-kernel values, uniform rectangular demagnetizing factors, zero-padded
open-boundary results, and CPU/CUDA field and energy parity at equal precision.

(demag-fdm-limitations)=
## Limitations

Finite image truncation is an approximation for periodic FDM. GPU source presence is not equivalent
to executed-device qualification.

(demag-fdm-scientific-bibliography)=
## Scientific bibliography

- Newell, A. J., Williams, W. and Dunlop, D. J., *Geophysical Research Letters* 21, 1994.
- FullMag internal reference: `docs/physics/0420-fdm-dipolar-demag-foundations.md`.

(demag-fdm-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | Public FDM demag strategy. |
| `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels` | Newell tensor construction. |
| `crates/fullmag-fdm-demag/src/multiply.rs` | `accumulate_tensor_convolution` | Tensor convolution application. |
| `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `launch_demag_field_fp64` | CUDA FP64 field dispatch. |
| `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `launch_demag_field_fp32` | CUDA FP32 field dispatch. |
| `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `reduce_demag_energy_fp64` | CUDA FP64 demag-energy reduction. |
