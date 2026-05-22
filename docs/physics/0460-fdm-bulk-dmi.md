
# Bulk DMI in FDM

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
  - `docs/physics/0400-fdm-exchange-demag-zeeman.md`
  - `docs/physics/0420-fdm-dipolar-demag-foundations.md`
  - `docs/physics/0440-fdm-interfacial-dmi.md`

## 1. Problem statement

This note defines how **bulk Dzyaloshinskii–Moriya interaction (DMI)** should be
implemented in the **finite-difference** backend of Fullmag.

Scope:

- isotropic cubic / B20-type bulk DMI,
- one scalar constant `D` with unit `J/m^2`,
- one reduced magnetization field `m`,
- Cartesian cell-centered FDM,
- CPU reference first, CUDA path second.

Bulk DMI is physically distinct from interfacial DMI:

- interfacial DMI prefers Néel-like chiral textures tied to a symmetry axis,
- bulk DMI prefers Bloch-like chiral textures through a fully 3D curl term.

This note defines the **bulk** term only.

## 2. Physical model

### 2.1 Governing equations

Let

\[
m : \Omega \to \mathbb{R}^3,\qquad |m|=1,
\]

and `M = M_s m`.

For isotropic bulk DMI the continuum energy is

\[
E_{\mathrm{bDMI}}[m]
=
D\int_\Omega m\cdot(\nabla\times m)\,dV.
\]

Expanded in Cartesian components,

\[
m\cdot(\nabla\times m)
=
m_x(\partial_y m_z - \partial_z m_y)
+
m_y(\partial_z m_x - \partial_x m_z)
+
m_z(\partial_x m_y - \partial_y m_x).
\]

The effective field is

\[
H_{\mathrm{bDMI}}
=
-\frac{1}{\mu_0 M_s}
\frac{\delta E_{\mathrm{bDMI}}}{\delta m}.
\]

Take a variation `m \mapsto m+\varepsilon v`:

\[
\delta E_{\mathrm{bDMI}}(m;v)
=
D\int_\Omega
\left[
v\cdot(\nabla\times m) + m\cdot(\nabla\times v)
\right] dV.
\]

Using

\[
\nabla\cdot(v\times m)
=
m\cdot(\nabla\times v) - v\cdot(\nabla\times m),
\]

we obtain

\[
\delta E_{\mathrm{bDMI}}(m;v)
=
2D\int_\Omega v\cdot(\nabla\times m)\,dV
+
D\int_{\partial\Omega}(v\times m)\cdot \nu\, dS.
\]

Therefore the strong-form field is

\[
H_{\mathrm{bDMI}}
=
-\frac{2D}{\mu_0 M_s}(\nabla\times m).
\]

In components,

\[
H_{\mathrm{bDMI}}
=
-\frac{2D}{\mu_0 M_s}
\begin{bmatrix}
\partial_y m_z - \partial_z m_y \\
\partial_z m_x - \partial_x m_z \\
\partial_x m_y - \partial_y m_x
\end{bmatrix}.
\]

### 2.2 Natural boundary condition and coupling to exchange

From the boundary term,

\[
(v\times m)\cdot \nu = v\cdot(m\times \nu),
\]

so the DMI boundary contribution is

\[
D\int_{\partial\Omega}(m\times \nu)\cdot v\, dS.
\]

Combining with exchange yields the free-boundary stationarity condition

\[
2A\partial_\nu m + D(m\times \nu) = 0.
\]

Equivalently,

\[
2A\partial_\nu m - D(\nu\times m) = 0.
\]

As with interfacial DMI, this boundary law must be built into the FDM closure if
free surfaces are meant physically.

### 2.3 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `m` | reduced magnetization | 1 |
| `M=M_s m` | physical magnetization | A/m |
| `M_s` | saturation magnetization | A/m |
| `A` | exchange stiffness | J/m |
| `D` | bulk DMI constant | J/m² |
| `\mu_0` | vacuum permeability | N/A² |
| `H_bDMI` | bulk DMI field | A/m |
| `E_bDMI` | bulk DMI energy | J |
| `\nu` | outward unit normal | 1 |

### 2.4 Assumptions and approximations

The first Fullmag bulk DMI implementation assumes:

- isotropic cubic bulk DMI only,
- one scalar `D`,
- Cartesian FDM,
- free surfaces via exchange + DMI boundary closure,
- no region-dependent `D`,
- no anisotropic Lifshitz invariant families.

Deferred:

- tetragonal / lower-symmetry bulk DMI,
- multiple chirality tensors,
- interface-bulk mixed DMI,
- spatially varying `D(x)`.

## 3. Numerical interpretation

### 3.1 FDM

#### 3.1.1 Interior stencil

Use second-order centered derivatives:

\[
\partial_x m_\alpha \approx \frac{m_{\alpha,i+1,j,k}-m_{\alpha,i-1,j,k}}{2\Delta x},
\]

and analogously for `y,z`.

Define

\[
c_i = -\frac{2D_i}{\mu_0 M_{s,i}}.
\]

Then for interior cells

\[
(H_{\mathrm{bDMI}})_x = c_i(\partial_y m_z - \partial_z m_y),
\]
\[
(H_{\mathrm{bDMI}})_y = c_i(\partial_z m_x - \partial_x m_z),
\]
\[
(H_{\mathrm{bDMI}})_z = c_i(\partial_x m_y - \partial_y m_x).
\]

This is a 6-neighbor first-derivative stencil.

#### 3.1.2 Energy-first discrete reference on oriented faces

A trustworthy CPU reference should compute the energy through oriented face contributions.

For an `x`-face between `L` and `R`, define

\[
\bar m_f = \frac{m_R + m_L}{2},
\qquad
\delta_x m_f = \frac{m_R - m_L}{\Delta x}.
\]

The `x`-face contribution is

\[
E_f^{(x)}
=
D_f S_x\left(
\bar m_{z,f}\,\delta_x m_{y,f}
-
\bar m_{y,f}\,\delta_x m_{z,f}
\right).
\]

For a `y`-face,

\[
E_f^{(y)}
=
D_f S_y\left(
\bar m_{x,f}\,\delta_y m_{z,f}
-
\bar m_{z,f}\,\delta_y m_{x,f}
\right).
\]

For a `z`-face,

\[
E_f^{(z)}
=
D_f S_z\left(
\bar m_{y,f}\,\delta_z m_{x,f}
-
\bar m_{x,f}\,\delta_z m_{y,f}
\right).
\]

Then

\[
E_{\mathrm{bDMI}}^h
=
\sum_{f\in\mathcal{F}_x^{\mathrm{int}}} E_f^{(x)}
+
\sum_{f\in\mathcal{F}_y^{\mathrm{int}}} E_f^{(y)}
+
\sum_{f\in\mathcal{F}_z^{\mathrm{int}}} E_f^{(z)}.
\]

This is the direct discrete analogue of `D m·curl m`.

Current CPU/native scalar reporting uses the same cell-centered centered-derivative
density as the native CUDA reduction for parity of `E_bDMI` rows:

\[
E_{\mathrm{bDMI}}^{\mathrm{scalar}}
=
\sum_i D V_i\,m_i\cdot(\nabla\times m)_i .
\]

The centered derivatives use the same periodic/clamped neighbor policy as the
field stencil; inactive neighbor cells are replaced by the active center value.
This scalar reduction is the current CPU/GPU reporting and line-search contract.
The oriented-face form above remains the stricter variational reference for
future boundary-closure hardening.

#### 3.1.3 Boundary closure with ghost cells

At free boundaries use the coupled boundary law

\[
2A\partial_\nu m + D(m\times \nu)=0.
\]

With boundary-adjacent cell `m_b` and ghost cell `m_g` mirrored across the boundary,

\[
\partial_\nu m \approx \frac{m_g-m_b}{\Delta_\nu},
\]

so the ghost closure is

\[
m_g
=
m_b - \frac{D\Delta_\nu}{2A}(m_b\times \nu).
\]

Examples:

At `x_min` (`\nu=-\hat x`),

\[
m_b\times \nu = (0,-m_z,m_y),
\]

hence

\[
m_g =
\begin{bmatrix}
m_x \\
m_y + \kappa_x m_z \\
m_z - \kappa_x m_y
\end{bmatrix},
\qquad
\kappa_x = \frac{D\Delta x}{2A}.
\]

Equivalently, using the compact formula above is safer than hard-coding component signs.

At `x_max` (`\nu=+\hat x`),

\[
m_g = m_b - \frac{D\Delta x}{2A}(0,m_z,-m_y).
\]

Analogous formulas hold on `y`- and `z`-normal boundaries.

Implementation recommendation:
code the boundary closure from the vector formula

\[
m_g = m_b - \lambda (m_b\times \nu), \qquad \lambda = \frac{D\Delta_\nu}{2A},
\]

then unit-test all six faces against hand-worked component formulas.

#### 3.1.4 Interaction with exchange, demag, and Zeeman

The production FDM pipeline should sum

\[
H_{\mathrm{eff}}
=
H_{\mathrm{ex}}
+
H_{\mathrm{demag}}
+
H_{\mathrm{bDMI}}
+
H_{\mathrm{ext}}.
\]

Bulk DMI is local; demag remains the expensive nonlocal operator.
The local-field kernel can compute exchange + bulk DMI together.

#### 3.1.5 CUDA/GPU realization

Recommended CUDA structure:

- SoA state arrays,
- one local field kernel for exchange + bulk DMI,
- demag via cuFFT in a separate chain,
- optional energy kernel for `E_bDMI`,
- boundary treatment either through ghost planes or explicit face-aware branches.

Because bulk DMI uses all three spatial directions, halo/ghost treatment must be correct on all six domain faces.
Until the face-energy reference is promoted into production, CPU and CUDA `E_bDMI`
scalar reports must match the cell-centered reduction in section 3.1.2.

### 3.2 FEM

For the FEM weak-form realization, see:

- `0470-fem-bulk-dmi-mfem-gpu.md`

### 3.3 Hybrid

Deferred.

## 4. API, IR, and planner impact

### 4.1 Python API surface

Bulk DMI is **not** present in the current public API.
Recommended future term:

```python
fm.BulkDMI(D=...)
```

Do not overload `InterfacialDMI` with a mode switch unless the semantics remain crystal clear.

### 4.2 ProblemIR representation

Recommended new IR term:

```json
{ "kind": "bulk_dmi", "D": ... }
```

Planner provenance should record

- `dmi_kind = "bulk"`,
- `dmi_sign_convention = "D_m_dot_curl_m"`.

### 4.3 Planner and capability-matrix impact

Strict-mode rules:

- require positive `D`,
- require `Exchange` for free-surface strict mode,
- reject unsupported backend/mode combos honestly,
- record whether boundary closure is reference CPU or CUDA.

Capability matrix should distinguish bulk DMI from interfacial DMI explicitly.

## 5. Validation strategy

### 5.1 Analytical checks

1. **Uniform state**
   \[
   m=\text{const}
   \Rightarrow
   H_bDMI = 0,\quad E_bDMI = 0.
   \]

2. **1D Bloch spiral**
   \[
   m(z) = (\cos qz,\sin qz,0).
   \]
   Then
   \[
   m\cdot(\nabla\times m) = -q,
   \]
   so
   \[
   w_{bDMI} = -Dq
   \]
   is constant and
   \[
   H_{bDMI} = \frac{2Dq}{\mu_0 M_s} m
   \]
   is parallel to `m`.

3. **Sign reversal**
   `D\to -D` flips chirality and all DMI observables.

### 5.2 Cross-backend checks

- same `Box` / same sampled `m0`,
- compare `E_bDMI`,
- compare projected `H_bDMI`,
- compare relaxed skyrmion/helical chirality once both backends exist.

### 5.3 Regression tests

- discrete energy derivative vs numerical finite differences,
- CPU vs CUDA parity,
- face-specific ghost-closure tests on all six sides,
- helix benchmark.

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

- only isotropic cubic bulk DMI,
- no mixed bulk/interfacial models,
- no spatially varying `D`,
- no lower-symmetry Lifshitz invariant families,
- no hybrid realization yet.

## 8. References

Internal references:

- `docs/physics/0440-fdm-interfacial-dmi.md`
- `docs/physics/0470-fem-bulk-dmi-mfem-gpu.md`
