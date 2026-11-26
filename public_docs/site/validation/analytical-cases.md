---
title: Analytical Cases
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-validation-analytical-cases)=
# Analytical Cases

Analytical validation compares FullMag against closed-form continuum and algebraic micromagnetic
oracles rather than against another solver. Each section below records the governing closed-form
expression, the measured or required acceptance criterion, and the exact boundary between executed
runtime verification and scripted or local contract coverage across all four solver lanes.

## Aharoni (1998) exact rectangular prism demagnetization benchmark

For a uniformly magnetized rectangular ferromagnetic prism of dimensions $L_x \times L_y \times L_z$,
Aharoni's closed-form demagnetizing factors $(N_x, N_y, N_z)$ determine the exact magnetostatic
self-energy:

```{math}
:label: eq-validation-aharoni-energy
E_{\mathrm{demag}}^{\mathrm{Aharoni}}
= \frac{1}{2}\mu_0 M_s^2 V \bigl(N_x m_x^2 + N_y m_y^2 + N_z m_z^2\bigr),
\qquad
N_x + N_y + N_z = 1.
```

FullMag benchmarks a $300 \times 300 \times 5\;\mathrm{nm}$ Permalloy thin film with
$M_s = 800\;\mathrm{kA\,m^{-1}}$, $A_{\mathrm{ex}} = 13\;\mathrm{pJ\,m^{-1}}$
(exchange length $\ell_{\mathrm{ex}} = \sqrt{2 A_{\mathrm{ex}} / (\mu_0 M_s^2)} \approx 5.69\;\mathrm{nm}$),
and uniform normalized initial magnetization
$\mathbf{m}_0 = (1, 0.1, 0)/\lVert (1, 0.1, 0) \rVert_2$. The exact Aharoni demagnetizing factors
are $N_x = N_y = 0.02560212$ and $N_z = 0.94879577$, yielding:

```{math}
:label: eq-validation-aharoni-reference-value
E_{\mathrm{demag}}^{\mathrm{Aharoni}} = 4.632850 \times 10^{-18}\;\mathrm{J}.
```

Measured November 2026 results (`double` FP64 in FullMag, `float32` in MuMax3 3.12) across FDM and
FEM discretizations using
[`scripts/benchmarks/relax_film_compare_case.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/scripts/benchmarks/relax_film_compare_case.py):

| Code / discretization | Mesh / grid | Demag potential DOFs | Uniform $E_{\mathrm{demag}}$ [$\mathrm{J}$] | Relative error vs Aharoni |
|---|---|---:|---:|---:|
| **Analytical Aharoni (1998)** | Exact $300\times 300\times 5\;\mathrm{nm}$ prism | — | $4.632850 \times 10^{-18}$ | $0.00\%$ |
| **FullMag FDM GPU** (FP64 Newell FFT) | $120 \times 120 \times 2$ ($2.5\;\mathrm{nm}$) | $28\,800$ cells | $4.632850 \times 10^{-18}$ | $-6 \times 10^{-7}\%$ ($-6 \times 10^{-9}$) |
| **MuMax3 3.12** (`DemagAccuracy = 6`, default) | $120 \times 120 \times 2$ ($2.5\;\mathrm{nm}$) | $28\,800$ cells | $4.610057 \times 10^{-18}$ | $-0.49\%$ (`-0.33%` / `-0.25%` / `-0.18%` at acc `8` / `10` / `12`) |
| **FullMag FEM `pure_prism_p2` `L=2`** ($h = 5.0\;\mathrm{nm}$) | $91\,238$ nodes, $172\,188$ `prism6` | $709\,253$ ($P_2$) | $4.605080 \times 10^{-18}$ | $-0.60\%$ |
| **FullMag FEM `tet P2`** ($h = 2.5\;\mathrm{nm}$) | $487\,736$ nodes, $3.1\times 10^6$ `tet4` | $4\,082\,076$ ($P_2$) | $4.603813 \times 10^{-18}$ | $-0.63\%$ |
| **FullMag FEM `pure_prism_p2` `L=1`** ($h = 5.0\;\mathrm{nm}$) | $76\,832$ nodes, $143\,490$ `prism6` | $594\,239$ ($P_2$) | $4.595727 \times 10^{-18}$ | $-0.80\%$ |
| **FullMag FEM `mixed prism P1` `L=2`** ($h = 2.5\;\mathrm{nm}$) | $54\,016$ nodes, $159\,714$ mixed cells | $54\,016$ ($P_1$) | $3.429791 \times 10^{-18}$ | $-25.97\%$ |
| **FullMag FEM `mixed prism P1` `L=1`** ($h = 2.5\;\mathrm{nm}$) | $36\,576$ nodes, $123\,796$ mixed cells | $36\,576$ ($P_1$) | $3.237685 \times 10^{-18}$ | $-30.11\%$ |
| **FullMag FEM `mixed prism P1` `L=1`** ($h = 5.0\;\mathrm{nm}$) | $10\,896$ nodes | $10\,896$ ($P_1$) | $3.116337 \times 10^{-18}$ | $-32.73\%$ |

The Aharoni benchmark demonstrates two key discretization facts:

1. FullMag's analytic Newell demagnetizing tensor on FDM reproduces the exact rectangular prism
   energy to $-6 \times 10^{-7}\%$ (near FP64 round-off), whereas MuMax3's numerical quadrature
   converges monotonically toward Aharoni as `DemagAccuracy` increases.
2. On thin films ($L_z \ll L_x, L_y$), first-order scalar-potential FEM (`mixed prism P1`)
   underestimates $E_{\mathrm{demag}}$ by $26\%\text{–}33\%$, whereas pure extruded prismatic meshes
   with quadratic scalar potential (`pure_prism_p2`, $H^1$ wedge order 2) reach $-0.60\%$ at
   $L = 2$, $h = 5.0\;\mathrm{nm}$ — slightly closer to Aharoni than tetrahedral $P_2$ (`-0.63%`)
   with $5.76\times$ fewer potential DOFs. See {doc}`fem-fdm-comparison` for the corresponding
   relaxed-state cross-backend energies.

## Exchange sinusoidal mode

A helical sinusoidal magnetization $\mathbf{m}(x) = (0, \cos(kx), \sin(kx))$ with wave number
$k = 2\pi / \lambda$ has a closed-form exchange effective field and total exchange energy:

```{math}
:label: eq-validation-exchange-sinusoidal
\mathbf{H}_{\mathrm{ex}} = \frac{2 A_{\mathrm{ex}}}{\mu_0 M_s} \nabla^2 \mathbf{m}
= -\frac{2 A_{\mathrm{ex}}}{\mu_0 M_s} k^2 \mathbf{m},
\qquad
E_{\mathrm{ex}} = A_{\mathrm{ex}} k^2 V.
```

The FEM acceptance gate is scripted in
[`tests/fem_exchange_validation/sinusoidal_mode.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/fem_exchange_validation/sinusoidal_mode.py)
($200 \times 20 \times 10\;\mathrm{nm}$ box, $\lambda = 100\;\mathrm{nm}$, $h_{\max} \in \{16, 12, 8\}\;\mathrm{nm}$).

- **Criterion** — recovered $\max\lVert \mathbf{H}_{\mathrm{ex}} \rVert$ agrees with the analytic
  Laplacian within $25\%$ on the finest mesh, and $E_{\mathrm{ex}}$ converges to
  $A_{\mathrm{ex}} k^2 V$ within $8\%$ under mesh refinement.
- **Status** — scripted; the representative finest-mesh stage materializes and runs on the managed
  FEM CPU path (`fem_cpu_native`), while the full Python CSV refinement sweep requires a PyO3
  `_fullmag_core` built with MFEM/libCEED and remains runtime-open.

## Uniformly magnetized sphere

A uniformly magnetized sphere of radius $R$ has isotropic demagnetizing factor $N = 1/3$, uniform
interior field $\mathbf{H}_{\mathrm{demag}} = -(M_s / 3)\mathbf{m}$, and exact demagnetizing energy
$E_{\mathrm{demag}} = \frac{1}{6}\mu_0 M_s^2 V$ ($V = \frac{4}{3}\pi R^3$). The FEM Poisson gate is
[`tests/fem_demag_validation/sphere_validation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/fem_demag_validation/sphere_validation.py)
($R = 50\;\mathrm{nm}$, $h_{\max} \in \{12, 8, 6, 4\}\;\mathrm{nm}$, comparing `poisson_robin` and
`poisson_dirichlet`), and the body-only Fredkin–Koehler FEM/BEM counterpart is scripted in
[`tests/fem_demag_validation/fem_bem_body_validation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/fem_demag_validation/fem_bem_body_validation.py).

- **Criterion** — interior $\mathbf{H}_{\mathrm{demag}} \approx -(M_s/3)\mathbf{m}$ and effective
  $N = 2 E_{\mathrm{demag}} / (\mu_0 M_s^2 V)$ converges to $1/3$ under refinement.
- **Status** — scripted; requires the MFEM/libCEED/hypre runtime for the full refinement CSV sweep.

## Osborn ellipsoid demagnetization factors

For a uniformly magnetized ellipsoid with semi-axes $(a, b, c)$ magnetized along each principal
axis $i \in \{x, y, z\}$, the interior demagnetizing field follows $H_{\mathrm{demag}, i} = -N_i M_s$
where $(N_x, N_y, N_z)$ are Osborn's closed-form demagnetizing factors ($N_x + N_y + N_z = 1$). The
gate is
[`tests/fem_demag_validation/ellipsoid_validation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/fem_demag_validation/ellipsoid_validation.py)
(sphere, prolate, oblate, and general triaxial shapes at $h_{\max} = 6\;\mathrm{nm}$).

- **Criterion** — per-axis effective demagnetization factors agree with Osborn within $10\%$ and
  sum to $1$ within $0.15$ per shape.
- **Status** — scripted; requires the MFEM/libCEED/hypre runtime.

## Macrospin LLG, STT, DMI, and thermal checkpoints

Local native C++ contract executables constrain the discrete field, torque, and energy-derivative
signs independently of full mesh sweeps:

- **Damping-only macrospin LLG** (`fem_llg_rhs_contract`): verifies Gilbert-form RHS ownership,
  nodewise damping, and monotonic energy decrease under damping-only relaxation.
- **Directed CPP spin-transfer torque** (`fem_stt_contract`): verifies Slonczewski macrospin
  precession sign and Zhang–Li additive-RHS normalization.
- **Interfacial and bulk DMI weak-residual derivative** (`fem_dmi_weak_residual`, `fem_dmi_contract`):
  verifies finite-difference directional energy derivative agreement, chirality, spiral-pitch sign,
  natural-boundary tilt, and oblique interface normals (supplemented on GPU by the 15-configuration
  CSR DMI parity benchmark on {doc}`cpu-gpu-parity`).
- **Brown thermal variance scaling** (`fem_thermal_brown_contract`): verifies $\sigma_{\mathrm{th}} \propto (V_i \Delta t)^{-1/2}$
  scaling, deterministic seeded replay at accepted $(t, \Delta t)$, and nonmagnetic zeroing, while
  full long-run Boltzmann macrospin equilibrium statistics remain runtime-open.

## Modal Kittel and Kalinikos–Slavin analytical validation

For the FEM linearized LLG modal eigensolver, FullMag provides typed analytical validation schemas
that pair coupled $(q, \phi)$ algebraic descriptor residual certification with closed-form FMR and
spin-wave dispersion oracles:

- **Uniform-mode ($\mathbf{k} = \mathbf{0}$) Kittel bias-field sweeps** (`K0KittelFieldSweepValidation`):
  validates computed FMR eigenfrequencies across $\ge 3$ static bias fields against the isotropic
  Larmor ($f_{\mathrm{Larmor}}$), laterally periodic thin-film ($f_{\mathrm{film}}$), or triaxial
  ellipsoidal ($f_{\mathrm{demag}}$) Kittel formulas.
- **Dipole-exchange thin-film dispersion ($n = 0$)** (`ThinFilmDEBVDispersionValidation`,
  `analytic_model="kalinikos_slab_n0"`): validates tracked Damon–Eshbach ($\mathbf{k} \perp \mathbf{m}_0$,
  positive initial slope) and backward-volume ($\mathbf{k} \parallel \mathbf{m}_0$, negative initial
  slope) branches against the unpinned Kalinikos–Slavin slab dispersion up to
  $k \le 3 \times 10^6\;\mathrm{rad\,m^{-1}}$ and $f \le 5\;\mathrm{GHz}$.

Full governing equations, parameter tables, coupled $(q, \phi)$ residual formulas, and Python
examples are documented on {doc}`../numerical-methods/eigensolvers/modal-validation`.

## Quasistatic and full-wave FIT antenna and surface gap-port contracts

For microwave-antenna excitation studies, FullMag maintains a **research-only CPU double**
orthogonal Finite Integration Technique (FIT) electromagnetic reference with resistive surface
gap-port excitation (peak phasors with time convention $e^{i\omega t}$):

```{math}
:label: eq-validation-fit-gap-port
\mathbf{n} \times \mathbf{H} = -Y_s \mathbf{E}_t + 2 Y_s E_{\mathrm{inc}}\mathbf{d},
\qquad
R_s = \frac{N R w}{\ell},
\qquad
Y_s = R_s^{-1},
\qquad
E_{\mathrm{inc}} = \frac{\sqrt{2 R P_{\mathrm{inc}}}}{\ell} e^{i\phi},
```

where $N$ rectangular patches of length $\ell$ along drive direction $\mathbf{d}$ and transverse
width $w$ form a port of total resistance $R$ driven with incident time-average power
$P_{\mathrm{inc}}$. On a rectangular face with grid spacings $(\Delta y, \Delta z)$, exact
piecewise-linear edge integration yields the symmetric positive-definite surface conductance block:

```{math}
:label: eq-validation-fit-gap-discrete
M_y = \frac{Y_s \Delta z}{6 \Delta y}
\begin{pmatrix}
2 & 1 \\
1 & 2
\end{pmatrix},
\qquad
b_y = Y_s E_{\mathrm{inc}} d_y \Delta z.
```

Analytical validation gates implemented in
[`scripts/test_rf_fit_surface_gap_port.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/scripts/test_rf_fit_surface_gap_port.py)
against
[`scripts/rf_fit_surface_gap_port.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/scripts/rf_fit_surface_gap_port.py#L40)
and
[`scripts/rf_fit_reference.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/scripts/rf_fit_reference.py#L212):

- **Nonuniform patch normalization and polarity**: verifies sheet admittance, resistance split
  across branches, symmetric positive semidefiniteness, zero-drive passivity, and exact sign
  reversal under opposite patch orientations.
- **Matched and mismatched analytical TEM waveguide ($1\;\mathrm{GHz}$ vacuum)**: verifies complex
  voltage phase, spatial profile, algebraic relative residual $< 10^{-11}$, and exact power
  conservation (`power_source_w == power_surface_w` within relative tolerance $10^{-11}$).

**Honest promotion boundary:** The full-wave FIT surface gap-port solver is a **research-only CPU
FP64 reference script**. It is not yet admitted into canonical `ProblemIR`, planner lowering,
public antenna stages, or any GPU lane; independent full-wave CPW comparison against Palace/CST and
mesh-refinement closure remain deferred. Separate quasistatic antenna source $k$-spectrum
postprocessing (`antenna_source_k_spectrum`) is currently `reference_executable` on FEM CPU only.

## Four-lane analytical validation coverage

| Analytical case | FDM CPU | FDM GPU | FEM CPU | FEM GPU | Notes |
|---|---|---|---|---|---|
| **Aharoni (1998) prism demag ($300\times 300\times 5\;\mathrm{nm}$)** | reference Newell kernel | executed (`-6e-7%`, FP64) | scripted / `tet P2` & `pure_prism_p2` | executed (`-0.60%` `pure_prism_p2` `L=2`, `-0.80%` `L=1`, `-0.63%` `tet P2`) | `mixed prism P1` shows `-25.97%` to `-32.73%` bias; use $P_2$ on thin films |
| **Exchange sinusoidal mode** | unit/source coverage | unit/source coverage | representative stage executed; full CSV sweep runtime-open | runtime-open | `tests/fem_exchange_validation/sinusoidal_mode.py` |
| **Uniformly magnetized sphere** | analytical Newell box geometry | analytical Newell box geometry | scripted (Poisson & FEM/BEM) | scripted (Poisson & FEM/BEM) | requires MFEM/libCEED/hypre PyO3 core for CSV sweep |
| **Osborn ellipsoid factors** | staircase-limited | staircase-limited | scripted (`<= 10%` per axis) | scripted | `tests/fem_demag_validation/ellipsoid_validation.py` |
| **Macrospin LLG / STT / DMI / thermal** | unit/reference oracles | CUDA FP64/FP32 precision-policy oracles | local C++ contracts PASS | local C++ contracts + CSR DMI 15-config parity (`<= 1.12e-15`) | Boltzmann macrospin statistics remain runtime-open |
| **Modal Kittel & Kalinikos–Slavin** | unsupported (`semantic_only`) | unsupported (`semantic_only`) | source-visible / bounded fixtures | bounded open-airbox `cuDSS` (PR #539) / source-visible Floquet (PR #558) | see {doc}`../numerical-methods/eigensolvers/modal-validation` |
| **Full-wave FIT surface gap-port TEM** | research-only CPU script | unsupported | research-only (Palace external reference) | unsupported | not promoted to public `ProblemIR` or GPU |

## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $M_s$ | Saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $A_{\mathrm{ex}}$ | Exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $\ell_{\mathrm{ex}}$ | Exchange length $\sqrt{2 A_{\mathrm{ex}} / (\mu_0 M_s^2)}$ | $\mathrm{m}$ |
| $\mu_0$ | Vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\mathbf{m}$ | Reduced unit magnetization | $1$ |
| $\mathbf{H}_{\mathrm{ex}}$, $\mathbf{H}_{\mathrm{demag}}$ | Exchange and demagnetizing effective fields | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm{ex}}$, $E_{\mathrm{demag}}$ | Exchange and demagnetizing energies | $\mathrm{J}$ |
| $N_x, N_y, N_z$ | Macroscopic demagnetizing factors ($N_x + N_y + N_z = 1$) | $1$ |
| $k$, $\lambda$ | Wave number and wavelength | $\mathrm{rad\,m^{-1}}$, $\mathrm{m}$ |
| $V$, $h$ | Magnetic volume and characteristic mesh element size | $\mathrm{m^3}$, $\mathrm{m}$ |
| $f_{\mathrm{Larmor}}, f_{\mathrm{film}}, f_{\mathrm{demag}}, f_{\mathrm{KS}}$ | Analytical Kittel and Kalinikos–Slavin frequencies | $\mathrm{Hz}$ |
| $\mathbf{E}_t$, $E_{\mathrm{inc}}$ | Tangential electric field phasor and incident gap electric amplitude | $\mathrm{V\,m^{-1}}$ |
| $R$, $R_s$, $Y_s$ | Total port resistance, sheet resistance, and sheet admittance | $\Omega$, $\Omega$, $\mathrm{S}$ |
| $P_{\mathrm{inc}}$ | Incident time-average port power | $\mathrm{W}$ |
| $\ell$, $w$, $\Delta y$, $\Delta z$ | Patch length/width and orthogonal FIT face spacings | $\mathrm{m}$ |
| $M_y$, $b_y$ | Discrete FIT edge-conductance block and drive entry | $\mathrm{S}$, $\mathrm{A}$ |

## Evidence boundary

Local no-MFEM contract executables are valid source, unit, and sign regression gates, but they are
not runtime qualification. A benchmark row advances to qualified status only when its executable
runtime case passes in the matching MFEM/CUDA managed environment with source- and device-bound
provenance; see {doc}`qualification-status` for the authoritative release-readiness ledger.

## Code references

- [`scripts/benchmarks/relax_film_compare_case.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/scripts/benchmarks/relax_film_compare_case.py) — $300\times 300\times 5\;\mathrm{nm}$ Aharoni and relaxation benchmark driver.
- [`tests/fem_exchange_validation/sinusoidal_mode.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/fem_exchange_validation/sinusoidal_mode.py) — helical sinusoidal exchange convergence gate.
- [`tests/fem_demag_validation/sphere_validation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/fem_demag_validation/sphere_validation.py) — uniformly magnetized sphere Poisson gate.
- [`tests/fem_demag_validation/ellipsoid_validation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/fem_demag_validation/ellipsoid_validation.py) — Osborn ellipsoid demagnetizing-factor gate.
- [`scripts/rf_fit_surface_gap_port.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/scripts/rf_fit_surface_gap_port.py#L40) (`assemble_gap_ports`, [`solve_gap_ports`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/scripts/rf_fit_surface_gap_port.py#L94)) — research CPU double FIT surface gap-port reference.
- [`scripts/rf_fit_reference.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/scripts/rf_fit_reference.py#L212) (`assemble`) and [`scripts/test_rf_fit_surface_gap_port.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/scripts/test_rf_fit_surface_gap_port.py) — FIT volume assembly and analytical TEM guide fixtures.

## Bibliography

- Aharoni, A. “Demagnetizing factors for rectangular ferromagnetic prisms,” *Journal of Applied Physics* **83**, 3432–3434 (1998), [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
- Osborn, J. A. “Demagnetizing factors of the general ellipsoid,” *Physical Review* **67**, 351–357 (1945), [doi:10.1103/PhysRev.67.351](https://doi.org/10.1103/PhysRev.67.351).
- Kittel, C. “On the theory of ferromagnetic resonance absorption,” *Physical Review* **73**, 155–161 (1948).
- Kalinikos, B. A., and Slavin, A. N. “Theory of dipole-exchange spin wave spectrum for ferromagnetic films with mixed exchange boundary conditions,” *Journal of Physics C: Solid State Physics* **19**, 7013–7033 (1986).
