---
title: FEM FDM Comparison
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-validation-fem-fdm-comparison)=
# FEM/FDM comparison

FEM and FDM are two discretizations of the same continuum micromagnetic model, so FullMag expects
them to converge to the same physical observables when geometry, material parameters, boundary
conditions, and initial conditions match. This page records the executed cross-backend comparisons
completed in November 2026 alongside the discretization pitfalls they expose and the remaining gaps
toward a full differential matrix.

## Shared physical contract

Both backends lower the same `ProblemIR`: the same Gilbert LLG equation, the same variational
effective-field definitions ($\mathbf{H}_{\mathrm{eff}} = -(\mu_0 M_s)^{-1} \delta E / \delta \mathbf{m}$),
and the same SI material constants. A cross-backend comparison is physically meaningful only when
the occupied magnetic geometry, material payload, boundary closure, and volume-weighted observables
are matched and only the spatial discretization differs.

## Thin-film $300 \times 300 \times 5\;\mathrm{nm}$ cross-backend benchmark (November 2026)

Zero-field relaxation of a $300 \times 300 \times 5\;\mathrm{nm}$ Permalloy film
($M_s = 800\;\mathrm{kA\,m^{-1}}$, $A_{\mathrm{ex}} = 13\;\mathrm{pJ\,m^{-1}}$,
$\ell_{\mathrm{ex}} \approx 5.69\;\mathrm{nm}$, $\alpha = 0.02$, uniform normalized initial
$\mathbf{m}_0 = (1, 0.1, 0)/\lVert (1, 0.1, 0) \rVert_2$, PGBB `tolT = 1e-7 T`) was executed across
FullMag FDM GPU, MuMax3 3.12, and three FullMag FEM mesh families (`tet P2`, `mixed prism P1`, and
`pure_prism_p2`) using
[`scripts/benchmarks/relax_film_compare_case.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/scripts/benchmarks/relax_film_compare_case.py).

### Uniform-state Aharoni and full-relaxation comparison

| Code / FEM mesh family | Grid / mesh | Demag DOFs | Uniform $E_{\mathrm{demag}}$ [$\mathrm{J}$] (vs Aharoni) | Relaxed $E_{\mathrm{total}}$ [$\mathrm{J}$] (vs FDM) | Relaxed $\langle m_x \rangle, \langle m_y \rangle$ | Steps / mean step |
|---|---|---:|---:|---:|---|---:|
| **Analytical Aharoni (1998)** | Exact prism | — | $4.632850 \times 10^{-18}$ ($0.00\%$) | — | — | — |
| **FullMag FDM GPU** (FP64) | $120 \times 120 \times 2$ ($2.5\;\mathrm{nm}$) | $28\,800$ FFT | $4.632850 \times 10^{-18}$ (`-6e-7%`) | $3.109921 \times 10^{-18}$ ($0.00\%$) | `0.6719, 0.6715` | `17 073` / `7.7 ms` |
| **MuMax3 3.12** (`Relax()`, FP32, acc 6) | $120 \times 120 \times 2$ ($2.5\;\mathrm{nm}$) | $28\,800$ FFT | $4.610057 \times 10^{-18}$ (`-0.49%`) | $3.08758 \times 10^{-18}$ (`-0.72%`) | `0.708, 0.631` (soft-mode stop at $5.2\times 10^{-5}\;\mathrm{T}$) | `44 406` / `1.5 ms` |
| **FEM `tet P2`** (RTX 5050) | $487\,736$ nodes, $3.1\times 10^6$ `tet4` | $4\,082\,076$ ($P_2$) | $4.603813 \times 10^{-18}$ (`-0.63%`) | *(timed out at $> 3\,600\;\mathrm{s}$; $59.4\;\mathrm{GiB}$ factor)* | — | `170` / `~7 600 ms` |
| **FEM `mixed prism P1` `L=1`**, $h = 5.0\;\mathrm{nm}$, `cuDSS` | $10\,896$ nodes | $10\,896$ ($P_1$) | $3.116337 \times 10^{-18}$ (`-32.73%`) | $2.490147 \times 10^{-18}$ (`-19.93%`) | `0.7528, 0.5991` | `1 661` / `5.23 ms` |
| **FEM `mixed prism P1` `L=1`**, $h = 2.5\;\mathrm{nm}$, `cuDSS` | $36\,576$ nodes | $36\,576$ ($P_1$) | $3.237685 \times 10^{-18}$ (`-30.11%`) | $2.507958 \times 10^{-18}$ (`-19.36%`) | `0.7530, 0.5941` | `4 393` / `6.09 ms` |
| **FEM `mixed prism P1` `L=2`**, $h = 2.5\;\mathrm{nm}$, `cuDSS` | $54\,016$ nodes, $159\,714$ cells (untangler `6 → 0`) | $54\,016$ ($P_1$) | $3.429791 \times 10^{-18}$ (`-25.97%`) | $2.582721 \times 10^{-18}$ (`-16.95%`, reached $1.73\times 10^{-6}\;\mathrm{T}$) | `0.7028, 0.6547` | `18 091` / `7.52 ms` |
| **FEM `pure_prism_p2` `L=1`**, $h = 5.0\;\mathrm{nm}$, `cuDSS` | $76\,832$ nodes, $143\,490$ `prism6` | $594\,239$ ($P_2$) | $4.595727 \times 10^{-18}$ (`-0.80%`) | $3.094433 \times 10^{-18}$ (**`-0.50%`** vs FDM, **`+0.22%`** vs MuMax3) | `0.6743, 0.6691` | `7 807` / `38.53 ms` |
| **FEM `pure_prism_p2` `L=2`**, $h = 5.0\;\mathrm{nm}$, `cuDSS` | $91\,238$ nodes, $172\,188$ `prism6` | $709\,253$ ($P_2$) | $4.605080 \times 10^{-18}$ (**`-0.60%`**) | $3.096700 \times 10^{-18}$ (**`-0.43%`** vs FDM, **`+0.30%`** vs MuMax3) | **`0.6745, 0.6688`** | `8 153` / `51.88 ms` |

### Relaxed energy decomposition (`pure_prism_p2` vs FDM and MuMax3)

| Realization | $E_{\mathrm{ex}}$ [$\mathrm{J}$] | $E_{\mathrm{demag}}$ [$\mathrm{J}$] | $E_{\mathrm{total}}$ [$\mathrm{J}$] | $\langle m_x \rangle$ | $\langle m_y \rangle$ | Final $\max\lvert \tau \rvert$ [$\mathrm{T}$] |
|---|---:|---:|---:|---:|---:|---:|
| **FullMag FDM GPU** ($2.5\;\mathrm{nm}$) | $3.895426 \times 10^{-19}$ | $2.720379 \times 10^{-18}$ | $3.109921 \times 10^{-18}$ | `0.671866` | `0.671542` | $9.50 \times 10^{-8}$ |
| **MuMax3 3.12** (`DemagAccuracy = 12` on FDM state) | $3.895426 \times 10^{-19}$ | $2.712516 \times 10^{-18}$ | $3.102059 \times 10^{-18}$ | `0.671866` | `0.671542` | $1.20 \times 10^{-4}$ |
| **FEM `mixed prism P1` `L=1`** ($2.5\;\mathrm{nm}$) | $2.713702 \times 10^{-19}$ (`-30.3%`) | $2.236588 \times 10^{-18}$ (`-17.8%`) | $2.507958 \times 10^{-18}$ (`-19.4%`) | `0.752951` | `0.594054` | $8.49 \times 10^{-8}$ |
| **FEM `pure_prism_p2` `L=1`** ($5.0\;\mathrm{nm}$) | $3.881510 \times 10^{-19}$ (`-0.36%`) | $2.706282 \times 10^{-18}$ (`-0.52%`) | $3.094433 \times 10^{-18}$ (`-0.50%`) | `0.674284` | `0.669116` | $9.97 \times 10^{-8}$ |
| **FEM `pure_prism_p2` `L=2`** ($5.0\;\mathrm{nm}$) | $3.892977 \times 10^{-19}$ (`-0.06%`) | $2.707402 \times 10^{-18}$ (`-0.48%`) | $3.096700 \times 10^{-18}$ (`-0.43%`) | `0.674475` | `0.668814` | $9.78 \times 10^{-8}$ |

Key physical conclusions:

1. **Order of the magnetostatic potential dominates FEM–FDM agreement in thin films:**
   `pure_prism_p2` (`L = 2`, $h = 5.0\;\mathrm{nm} < \ell_{\mathrm{ex}}$) closes the $19.4\%$
   `mixed prism P1` energy deficit to **`-0.43%`** against FullMag FDM (`-0.06%` on exchange,
   `-0.48%` on demagnetization, and `+0.30%` vs MuMax3 `DemagAccuracy = 6`), while matching the
   diagonal equilibrium orientation $\langle \mathbf{m} \rangle = (0.6745, 0.6688, 0)$ vs FDM
   $(0.6719, 0.6715, 0)$.
2. **Practical FEM GPU operating envelope:** Compared with `tet P2`, `pure_prism_p2` (`L = 2`,
   $h = 5.0\;\mathrm{nm}$) meshes $246\times$ faster ($0.51\;\mathrm{s}$ vs $123\;\mathrm{s}$),
   uses $5.76\times$ fewer $P_2$ DOFs, fits in $6.73\;\mathrm{GiB}$ `cuDSS` VRAM on a
   $16\;\mathrm{GiB}$ RTX 4080 SUPER, and runs at $51.88\;\mathrm{ms/step}$. See
   {ref}`numerical-methods-performance-fem-gpu-demag` for factorization details and scaling limits.

## Four-lane µMAG Standard Problem 4 relaxation comparison

The November 2026 four-lane audit compared zero-field SP4 ($500 \times 125 \times 3\;\mathrm{nm}$
Permalloy) S-state relaxation across FEM GPU (`R2`, $26\,149$ nodes / $138\,199$ elements), FDM CPU
($128 \times 32 \times 1$), FDM GPU `nativecuda` ($128 \times 32 \times 1$), and MuMax3 3.12:

| Metric | FEM GPU `R2` | FDM CPU | FDM GPU `nativecuda` | MuMax3 3.12 |
|---|---:|---:|---:|---:|
| Accepted steps | `1 567` (`+2` rejected) | `271` | `255` | `1 028` |
| $E_{\mathrm{ex}}$ [$\mathrm{J}$] | $8.2262 \times 10^{-20}$ | $8.9251 \times 10^{-20}$ | $8.9250 \times 10^{-20}$ | $8.9236 \times 10^{-20}$ |
| $E_{\mathrm{demag}}$ [$\mathrm{J}$] | $5.40839 \times 10^{-19}$ | $5.40520 \times 10^{-19}$ | $5.40521 \times 10^{-19}$ | $5.40366 \times 10^{-19}$ |
| $E_{\mathrm{total}}$ [$\mathrm{J}$] | $6.23102 \times 10^{-19}$ | $6.29771 \times 10^{-19}$ | $6.29771 \times 10^{-19}$ | $6.29602 \times 10^{-19}$ |
| $\langle m_x \rangle$ | `0.969261` | `0.966959` | `0.966960` | `0.966962` |
| $\langle m_y \rangle$ | `0.120943` | `0.125294` | `0.125290` | `0.125292` |
| Final $\max\lvert \tau \rvert$ [$\mathrm{T}$] | $9.0557 \times 10^{-7}$ | $9.8704 \times 10^{-7}$ | $6.2231 \times 10^{-7}$ | $8.515 \times 10^{-7}$ |
| Wall time [$\mathrm{s}$] | `756.3` (pre-`cuDSS`) | `29.07` | `1.45` | `2.38` |

FDM CPU and FDM GPU agree with MuMax3 to within **$0.03\%$** on $E_{\mathrm{total}}$ and
$\sim 10^{-6}$ on $\langle \mathbf{m} \rangle$. The pre-`pure_prism_p2` FEM GPU `R2` run deviates
by $-7.8\%$ in $E_{\mathrm{ex}}$ and $-3.5\%$ in $\langle m_y \rangle$; attributing that residual
cleanly requires a dedicated multi-mesh FEM convergence sweep (now practical with `pure_prism_p2`
and `cuDSS`).

## Periodic demagnetization supercell check

The periodic airbox demagnetization validation compares the primitive periodic-cell magnetostatic
energy against a central-cell $3 \times 3$ periodic-supercell reference in
[`tests/fem_demag_validation/periodic_airbox_validation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/fem_demag_validation/periodic_airbox_validation.py).
The recorded primitive-vs-central-cell energy relative error is `2.4168e-3` against a `2.0e-2`
tolerance, with lateral seam metrics at `0.0` and `robin_periodic_seam_face_count = 0`. This is a
FEM-side periodic consistency check rather than a full FDM $\leftrightarrow$ FEM periodic matrix.

## State transfer and volume-preserving restriction between backends

Backend continuation transfers Cartesian cell-centred FDM magnetization onto a FEM mesh, and FEM
nodal fields back onto FDM cell centres, with trilinear/$P_1$ interpolation and explicit
outside-domain semantics:

- {doc}`../numerical-methods/interpolation-and-state-transfer/fdm-to-fem`
- {doc}`../numerical-methods/interpolation-and-state-transfer/fem-to-fdm`

For diagnostic field-to-field comparisons on tetrahedral meshes (such as the SP5 FEM/FDM diagnostic
in {doc}`mumag-standard-problems`),
[`build_tet4_cartesian_restriction`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/analysis/fem_cartesian_restriction.py#L603)
computes the exact clipped-polyhedron affine-$P_1$ volume integral per Cartesian voxel
($\vartheta_c = 1.0 \pm 2 \times 10^{-14}$), separating field-mapping error from solver
discretization differences.

## Current status

Thin-film zero-field relaxation now has executed cross-backend FEM–FDM–MuMax3 evidence achieving
$-0.43\%$ $E_{\mathrm{total}}$ agreement with `pure_prism_p2` (`L = 2`), and SP4 relaxation has a
four-lane comparison snapshot. However, an automated multi-problem, multi-resolution
FDM $\leftrightarrow$ FEM differential qualification matrix (covering dynamic SP4 reversal, SP5
Zhang–Li transport convergence, DMI, and spectral response) is not yet closed. Do not infer broad
FDM/FEM equivalence from state-transfer support or from single-mesh comparisons alone.
