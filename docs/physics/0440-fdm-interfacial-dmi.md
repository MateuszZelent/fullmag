
# Interfacial DMI in FDM

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-03-24
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
  - `docs/specs/output-naming-policy-v0.md`
- Related physics notes:
  - `docs/physics/0000-physics-documentation-standard.md`
  - `docs/physics/0050-shared-problem-semantics-and-embedded-python-api.md`
  - `docs/physics/0400-fdm-exchange-demag-zeeman.md`
  - `docs/physics/0420-fdm-dipolar-demag-foundations.md`

## 1. Problem statement

This note defines how **interfacial Dzyaloshinskii–Moriya interaction (DMI)** should be
implemented in the **finite-difference / regular-grid** backend of Fullmag.

Scope of this note:

- one reduced magnetization field `m(x,t)` with `|m| = 1`,
- interfacial DMI in the micromagnetic thin-film sense,
- one scalar DMI constant `D` with SI unit `J/m^2`,
- one global interface symmetry axis fixed to `+z` for the first implementation,
- Cartesian cell-centered FDM with CPU reference first and CUDA second,
- coexistence with exchange, demag, and Zeeman under one shared physical contract.

This note is intentionally not about bulk DMI, curved-manifold DMI, atomistic DMI,
or region-dependent chirality axes. Those are deferred.

Why this term matters:

- it is the first chiral interaction that couples **volume energetics** to
  **free-surface boundary twists**;
- it tests whether Fullmag is truly **energy-first** rather than only field-first;
- it is one of the first terms where FDM and FEM must agree on continuum semantics
  while using genuinely different numerical realizations.

## 2. Physical model

### 2.1 Governing equations

Let

\[
m : \Omega \to \mathbb{R}^3, \qquad |m| = 1,
\]

be the reduced magnetization, and let

\[
M = M_s m
\]

be the physical magnetization in `A/m`.

For a film with interface symmetry axis fixed to `\hat z`, the interfacial DMI energy is

\[
E_{\mathrm{iDMI}}[m]
=
\int_{\Omega}
w_{\mathrm{iDMI}}(m,\nabla m)\, dV,
\]

with density

\[
w_{\mathrm{iDMI}}
=
D\left[
m_z \nabla \cdot m - (m \cdot \nabla)m_z
\right].
\]

Since the `m_z \partial_z m_z` terms cancel, this is equivalent to

\[
w_{\mathrm{iDMI}}
=
D\left(
m_z \partial_x m_x - m_x \partial_x m_z
+
m_z \partial_y m_y - m_y \partial_y m_z
\right).
\]

The effective field is defined by the variational derivative

\[
H_{\mathrm{iDMI}}
=
-\frac{1}{\mu_0 M_s}
\frac{\delta E_{\mathrm{iDMI}}}{\delta m}.
\]

Take a variation `m \mapsto m + \varepsilon v`. Then

\[
\delta E_{\mathrm{iDMI}}(m;v)
=
D\int_\Omega
\left[
v_z(\partial_x m_x + \partial_y m_y)
+
m_z(\partial_x v_x + \partial_y v_y)
-
v_x \partial_x m_z
-
m_x \partial_x v_z
-
v_y \partial_y m_z
-
m_y \partial_y v_z
\right] dV .
\]

Integrating by parts gives the volume contribution

\[
\delta E_{\mathrm{iDMI}}^{\mathrm{vol}}(m;v)
=
2D \int_\Omega
\left[
(\partial_x m_x + \partial_y m_y) v_z
-
(\partial_x m_z) v_x
-
(\partial_y m_z) v_y
\right] dV,
\]

hence

\[
H_{\mathrm{iDMI}}
=
\frac{2D}{\mu_0 M_s}
\begin{bmatrix}
\partial_x m_z \\
\partial_y m_z \\
-(\partial_x m_x + \partial_y m_y)
\end{bmatrix}.
\]

In a more compact vector form, for the fixed axis `\hat z`,

\[
H_{\mathrm{iDMI}}
=
\frac{2D}{\mu_0 M_s}
\left[
\nabla m_z - (\nabla \cdot m)\hat z
\right],
\]

with the understanding that only in-plane derivatives contribute because of the
interfacial symmetry assumed here.

### 2.2 Natural boundary condition and its coupling to exchange

The integrated-by-parts form contains a boundary term

\[
\delta E_{\mathrm{iDMI}}^{\partial\Omega}(m;v)
=
D \int_{\partial\Omega}
\left[
m_z (\nu \cdot v) - (\nu \cdot m) v_z
\right] dS,
\]

where `\nu` is the outward unit normal.

Using the vector identity

\[
(\hat z \times \nu)\times m
=
\nu m_z - \hat z(\nu \cdot m),
\]

the boundary term becomes

\[
\delta E_{\mathrm{iDMI}}^{\partial\Omega}(m;v)
=
D \int_{\partial\Omega}
\big[(\hat z \times \nu)\times m\big]\cdot v \, dS.
\]

With exchange

\[
E_{\mathrm{ex}} = A \int_\Omega |\nabla m|^2 \, dV,
\]

the free-boundary stationarity condition is

\[
2A \, \partial_\nu m
+
D \big[(\hat z \times \nu)\times m\big]
=
0.
\]

This boundary condition is not optional detail.
It is the physical source of chiral edge tilts and must be realized in the FDM boundary closure.

### 2.3 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `m` | reduced magnetization | 1 |
| `M = M_s m` | physical magnetization | A/m |
| `M_s` | saturation magnetization | A/m |
| `A` | exchange stiffness | J/m |
| `D` | interfacial DMI constant | J/m² |
| `\mu_0` | vacuum permeability | N/A² |
| `H_iDMI` | interfacial DMI effective field | A/m |
| `E_iDMI` | interfacial DMI energy | J |
| `\nu` | outward unit normal | 1 |
| `\Delta x,\Delta y,\Delta z` | cell sizes | m |
| `S_x,S_y,S_z` | face areas | m² |

### 2.4 Assumptions and approximations

The first Fullmag interfacial DMI implementation freezes:

- one scalar `D`,
- one global axis `\hat z`,
- Cartesian FDM only,
- cell-centered reduced magnetization field,
- free surfaces treated through exchange + DMI boundary closure,
- no spatially varying `D(x)`,
- no curved-shell or manifold DMI.

Deferred:

- region-dependent `D`,
- arbitrary axis `\hat n`,
- anti-interfacial sign conventions as separate API objects,
- curved-surface geometric corrections,
- periodic DMI boundary policies,
- hybrid surface/volume DMI realizations.

## 3. Numerical interpretation

### 3.1 FDM

#### 3.1.1 State layout and interior stencil

Use a cell-centered Cartesian grid with state

\[
m_{i,j,k} = (m_x,m_y,m_z)_{i,j,k}.
\]

For interior cells, use second-order centered differences:

\[
\partial_x m_\alpha \approx
\frac{m_{\alpha,i+1,j,k} - m_{\alpha,i-1,j,k}}{2\Delta x},
\qquad
\partial_y m_\alpha \approx
\frac{m_{\alpha,i,j+1,k} - m_{\alpha,i,j-1,k}}{2\Delta y}.
\]

Define

\[
c_i = \frac{2D_i}{\mu_0 M_{s,i}},
\]

for active magnetic cells. Then the interior DMI field is

\[
(H_{\mathrm{iDMI}})_x = c_i\, \partial_x m_z,
\qquad
(H_{\mathrm{iDMI}})_y = c_i\, \partial_y m_z,
\qquad
(H_{\mathrm{iDMI}})_z = -c_i\,(\partial_x m_x + \partial_y m_y).
\]

This yields a compact 5-point in-plane stencil per component.
No `z`-derivatives appear in the interfacial term under the present convention.

#### 3.1.2 Energy-first discrete reference on faces

The reference CPU implementation should define the DMI energy on oriented interior faces.

For an `x`-face shared by cells `L` and `R`, define midpoint average and jump

\[
\bar m_f = \frac{m_R + m_L}{2},
\qquad
\delta_x m_f = \frac{m_R - m_L}{\Delta x}.
\]

Then define the face contribution

\[
E^{(x)}_f = D_f S_x \left( \bar m_{z,f}\,\delta_x m_{x,f} - \bar m_{x,f}\,\delta_x m_{z,f} \right).
\]

Likewise for a `y`-face,

\[
E^{(y)}_f = D_f S_y \left( \bar m_{z,f}\,\delta_y m_{y,f} - \bar m_{y,f}\,\delta_y m_{z,f} \right).
\]

The total discrete energy is

\[
E_{\mathrm{iDMI}}^h
=
\sum_{f\in \mathcal{F}_x^{\mathrm{int}}} E^{(x)}_f
+
\sum_{f\in \mathcal{F}_y^{\mathrm{int}}} E^{(y)}_f.
\]

This is the preferred reference definition because it:

- mirrors the continuum energy density,
- keeps the operator antisymmetric in the right way,
- provides a trustworthy CPU baseline,
- gives a direct route to regression-checking any faster CUDA stencil path.

The production CUDA path may compute the field with direct centered-difference kernels,
but it must be validated against the energy-derived CPU reference.

Current CPU/native scalar reporting uses the same cell-centered centered-derivative
density as the native CUDA reduction for parity of `E_iDMI` rows:

\[
E_{\mathrm{iDMI}}^{\mathrm{scalar}}
=
\sum_i
D V_i
\left[
m_{z,i}(\partial_x m_x+\partial_y m_y)_i
-m_{x,i}(\partial_x m_z)_i
-m_{y,i}(\partial_y m_z)_i
\right].
\]

The centered derivatives use the same periodic/clamped neighbor policy as the
field stencil; inactive neighbor cells are replaced by the active center value.
This scalar reduction is the current CPU/GPU reporting and line-search contract.
The face-energy form above remains the stricter variational reference for future
boundary-closure hardening.

#### 3.1.3 Boundary closure with ghost cells

At free boundaries, a centered stencil needs ghost values.
These ghost values must encode the coupled exchange + DMI natural boundary condition

\[
2A \partial_\nu m + D\big[(\hat z \times \nu)\times m\big] = 0.
\]

Using a ghost value `m_g` mirrored across the boundary from boundary-adjacent cell `m_b`,
approximate

\[
\partial_\nu m \approx \frac{m_g - m_b}{\Delta_\nu}.
\]

Then the boundary condition gives the ghost closure

\[
m_g
=
m_b
-
\frac{D \Delta_\nu}{2A}
\big[(\hat z \times \nu)\times m_b\big].
\]

For axis-aligned boundaries this becomes explicit.

At `x_min` (`\nu = -\hat x`):

\[
(\hat z \times \nu)\times m = (-m_z,0,m_x),
\]

hence

\[
m_g =
\begin{bmatrix}
m_x + \kappa_x m_z \\
m_y \\
m_z - \kappa_x m_x
\end{bmatrix},
\qquad
\kappa_x = \frac{D \Delta x}{2A}.
\]

At `x_max` (`\nu = +\hat x`):

\[
m_g =
\begin{bmatrix}
m_x - \kappa_x m_z \\
m_y \\
m_z + \kappa_x m_x
\end{bmatrix}.
\]

At `y_min` (`\nu = -\hat y`):

\[
m_g =
\begin{bmatrix}
m_x \\
m_y + \kappa_y m_z \\
m_z - \kappa_y m_y
\end{bmatrix},
\qquad
\kappa_y = \frac{D \Delta y}{2A}.
\]

At `y_max` (`\nu = +\hat y`):

\[
m_g =
\begin{bmatrix}
m_x \\
m_y - \kappa_y m_z \\
m_z + \kappa_y m_y
\end{bmatrix}.
\]

At `z`-normal free surfaces, the present interfacial DMI contributes no extra in-plane derivative,
so the first implementation should retain pure exchange Neumann closure unless a later
surface-specific thin-film policy is introduced.

#### 3.1.4 Coexistence with demag and Zeeman

The effective field used by LLG is

\[
H_{\mathrm{eff}}
=
H_{\mathrm{ex}}
+
H_{\mathrm{demag}}
+
H_{\mathrm{iDMI}}
+
H_{\mathrm{ext}}.
\]

DMI is local and nearest-neighbor; demag is nonlocal and FFT-based.
The planner and runner should therefore treat DMI like exchange in the local field pipeline:

1. load `m`,
2. compute exchange,
3. compute DMI,
4. compute demag,
5. add Zeeman,
6. sum into `H_eff`.

The field-sum ordering is numerically irrelevant in exact arithmetic, but the
implementation should keep a stable canonical order for reproducibility and diagnostics.

#### 3.1.5 CUDA/GPU realization

Recommended CUDA architecture:

- SoA storage for `m_x,m_y,m_z`,
- one local-field kernel that can compute exchange and DMI together,
- separate demag kernel chain via cuFFT,
- boundary closure implemented either:
  - explicitly via ghost planes, or
  - implicitly via boundary branches in the stencil kernel,
- energy kernels for `E_iDMI` separate from field kernels.

For calibration and determinism:

- keep a reference CPU energy-first implementation,
- compare GPU vs CPU on `H_iDMI`, `E_iDMI`, and relaxation trajectories,
- record precision mode and stencil realization in provenance.
- until the face-energy reference is promoted into production, CPU and CUDA
  `E_iDMI` scalar reports must match the cell-centered reduction in section 3.1.2.

### 3.2 FEM

For the FEM weak-form and MFEM/libCEED/hypre implementation, see:

- `0450-fem-interfacial-dmi-mfem-gpu.md`

The shared invariant is the continuum energy, not the discrete stencil.

### 3.3 Hybrid

Deferred.
A future hybrid realization must preserve the same interfacial DMI energy and
boundary semantics across any grid/mesh coupling interface.

## 4. API, IR, and planner impact

### 4.1 Python API surface

The current public term

```python
fm.InterfacialDMI(D=...)
```

is semantically correct for this note if interpreted as:

- one scalar `D`,
- one fixed axis `+z`,
- one chirality convention tied to the density used above.

Deferred but likely future extension:

```python
fm.InterfacialDMI(D=..., axis=(0,0,1))
```

Only add `axis` once both FDM and FEM can honor it consistently.

### 4.2 ProblemIR representation

The current IR term

```json
{ "kind": "interfacial_dmi", "D": ... }
```

is enough for the first implementation if the axis is frozen by spec.
Planner-side provenance should additionally record:

- `dmi_kind = "interfacial"`,
- `dmi_axis = [0,0,1]`,
- `dmi_sign_convention = "mz_divm_minus_m_dot_grad_mz"`.

### 4.3 Planner and capability-matrix impact

Strict-mode planner rules:

- require at least one ferromagnet,
- require positive `D`,
- require `Exchange` when `InterfacialDMI` is active in strict mode,
- reject unsupported backend/mode combinations honestly,
- record whether the FDM boundary closure is reference CPU or CUDA realization.

Capability matrix should separate:

- `InterfacialDMI` semantic support,
- FDM public-executable support,
- FEM semantic/internal/public status independently.

## 5. Validation strategy

### 5.1 Analytical checks

1. **Uniform magnetization**
   \[
   m = \text{const}
   \Rightarrow
   H_{\mathrm{iDMI}} = 0,\quad E_{\mathrm{iDMI}} = 0.
   \]

2. **1D Néel spiral**
   \[
   m(x) = (\sin qx, 0, \cos qx).
   \]
   Then
   \[
   w_{\mathrm{iDMI}} = Dq
   \]
   is constant, and
   \[
   H_{\mathrm{iDMI}} = -\frac{2Dq}{\mu_0 M_s} m
   \]
   is parallel to `m`, hence torque-free.

3. **Sign-reversal test**
   Replacing `D` by `-D` must flip chirality and the sign of `H_iDMI` and `E_iDMI`.

### 5.2 Cross-backend checks

On the same `Box` geometry and same sampled initial condition:

- compare `E_iDMI(t)`,
- compare projected `H_iDMI`,
- compare edge canting profile in a thin strip,
- compare final relaxed Néel-wall chirality under equal parameters.

### 5.3 Regression tests

- CPU reference vs CUDA on `H_iDMI` max norm and `L2`,
- boundary ghost closure test on all four in-plane faces,
- random-state finite-difference check of discrete energy derivative,
- exchange + interfacial DMI thin-strip relaxation benchmark.

## 6. Completeness checklist

- [ ] Python API
- [ ] ProblemIR
- [ ] Planner
- [ ] Capability matrix
- [ ] FDM backend
- [ ] FEM backend
- [ ] Hybrid backend
- [ ] Outputs / observables
- [ ] Tests / benchmarks
- [ ] Documentation

## 7. Known limits and deferred work

- no bulk DMI here,
- no arbitrary symmetry axis,
- no region-dependent `D`,
- no periodic boundary policy,
- no curved-shell DMI,
- no higher-order stencil families,
- no tangent-plane / eigenmode linearization of the DMI operator yet.

## 8. References

Internal references:

- `docs/physics/0400-fdm-exchange-demag-zeeman.md`
- `docs/physics/0450-fem-interfacial-dmi-mfem-gpu.md`
