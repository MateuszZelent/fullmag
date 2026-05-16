
# Bulk DMI in FEM on MFEM/libCEED/hypre with GPU

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
  - `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0460-fdm-bulk-dmi.md`

## 1. Problem statement

This note defines how **bulk Dzyaloshinskii–Moriya interaction (DMI)** should be
implemented in the **finite-element** backend of Fullmag using MFEM + libCEED + hypre + GPU.

Scope:

- isotropic cubic / B20-type bulk DMI,
- one scalar constant `D` in `J/m^2`,
- vector `H^1` finite-element representation of reduced magnetization,
- matrix-free / partial-assembly-first implementation,
- coexistence with exchange, demag, and Zeeman.

Bulk DMI is distinct from interfacial DMI and must have its own API/IR term and validation path.

## 2. Physical model

### 2.1 Governing equations

The continuum bulk DMI energy is

\[
E_{\mathrm{bDMI}}[m] = D\int_\Omega m\cdot(\nabla\times m)\,dV.
\]

Expanded componentwise,

\[
E_{\mathrm{bDMI}}[m]
=
D\int_\Omega
\left[
m_x(\partial_y m_z - \partial_z m_y)
+
m_y(\partial_z m_x - \partial_x m_z)
+
m_z(\partial_x m_y - \partial_y m_x)
\right] dV.
\]

Its first variation is

\[
\delta E_{\mathrm{bDMI}}(m;v)
=
D\int_\Omega
\left[
v\cdot(\nabla\times m) + m\cdot(\nabla\times v)
\right] dV.
\]

Using the vector identity

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

Therefore

\[
H_{\mathrm{bDMI}}
=
-\frac{2D}{\mu_0 M_s}(\nabla\times m),
\]

and the natural free-boundary condition coupled with exchange is

\[
2A\partial_\nu m + D(m\times \nu)=0.
\]

### 2.2 Why the weak residual is the right FEM object

As with interfacial DMI, the correct FEM primitive is the weak residual

\[
R_{\mathrm{bDMI}}(m;v)
=
D\int_\Omega
\left[
v\cdot(\nabla\times m) + m\cdot(\nabla\times v)
\right] dV.
\]

This is preferred because it:

- directly encodes the energy variation,
- automatically carries the natural boundary term,
- uses only first derivatives,
- fits MFEM/libCEED nonlinear operator evaluation cleanly.

### 2.3 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `m` | reduced magnetization | 1 |
| `M=M_s m` | physical magnetization | A/m |
| `M_s` | saturation magnetization | A/m |
| `A` | exchange stiffness | J/m |
| `D` | bulk DMI constant | J/m² |
| `H_bDMI` | bulk DMI field | A/m |
| `E_bDMI` | bulk DMI energy | J |
| `V_h` | vector FE space | — |
| `\nu` | outward unit normal | 1 |

### 2.4 Assumptions and approximations

The first FEM bulk DMI implementation assumes:

- one scalar `D`,
- isotropic cubic bulk DMI only,
- `V_h \subset [H^1]^3`,
- low-order nodal vector elements first,
- natural boundary treatment from the weak residual,
- matrix-free / partial-assembly-first GPU realization.

Deferred:

- lower-symmetry bulk DMI tensors,
- region-dependent `D`,
- mixed DMI families,
- shell / manifold-specific chiral terms.

## 3. Numerical interpretation

### 3.1 FDM

For the Cartesian-grid realization, see:

- `0460-fdm-bulk-dmi.md`

### 3.2 FEM

#### 3.2.1 Discrete state and function spaces

Use

\[
V_h \subset [H^1(\Omega)]^3,
\qquad
m_h(\mathbf{x}) = \sum_a m_a \phi_a(\mathbf{x}).
\]

Although `curl m_h` suggests `H(curl)` language, `H^1` nodal spaces are sufficient here
because `m_h` is differentiable enough for `\nabla\times m_h` to be evaluated in `L^2`
through its gradients.

#### 3.2.2 Quadrature-point energy density and derivatives

Let `G = \nabla m`, `G_{\alpha\beta}=\partial_\beta m_\alpha`.
Then

\[
w_{\mathrm{bDMI}}(m,G)
=
D\left[
m_x(G_{zy}-G_{yz})
+
m_y(G_{xz}-G_{zx})
+
m_z(G_{yx}-G_{xy})
\right].
\]

The derivative with respect to the pointwise value is

\[
\frac{\partial w}{\partial m}
=
D(\nabla\times m).
\]

The nonzero entries of `\partial w/\partial \nabla m` are

\[
\frac{\partial w}{\partial G_{zy}} = D m_x,\qquad
\frac{\partial w}{\partial G_{yz}} = -D m_x,
\]
\[
\frac{\partial w}{\partial G_{xz}} = D m_y,\qquad
\frac{\partial w}{\partial G_{zx}} = -D m_y,
\]
\[
\frac{\partial w}{\partial G_{yx}} = D m_z,\qquad
\frac{\partial w}{\partial G_{xy}} = -D m_z.
\]

This is exactly the data a libCEED QFunction should emit for a matrix-free nonlinear form.

#### 3.2.3 Residual form

The discrete residual is

\[
R_{\mathrm{bDMI}}(m_h;v_h)
=
\int_\Omega
\frac{\partial w}{\partial m}(m_h,\nabla m_h)\cdot v_h
+
\frac{\partial w}{\partial \nabla m}(m_h,\nabla m_h):\nabla v_h
\, dV.
\]

Equivalently, in the more transparent vector form,

\[
R_{\mathrm{bDMI}}(m_h;v_h)
=
D\int_\Omega
\left[
v_h\cdot(\nabla\times m_h)
+
m_h\cdot(\nabla\times v_h)
\right] dV.
\]

The second form is often easier to review mathematically; the first is often easier to code in libCEED.

#### 3.2.4 Field projection

Recover the discrete field through

\[
M_{\mu_0 M_s} H_{\mathrm{bDMI},h} = -g_{\mathrm{bDMI}}(m_h).
\]

As for interfacial DMI, a lumped mass projection is preferred for explicit RK time steppers,
while a consistent mass projection may be used for high-fidelity diagnostics.

#### 3.2.5 MFEM / libCEED / hypre split

Recommended implementation split:

- **MFEM**
  - vector `H1` space,
  - nonlinear operator scaffolding,
  - element restrictions and quadrature metadata;
- **libCEED**
  - quadrature-point evaluation of bulk DMI energy and residual;
- **hypre**
  - only for global solves such as demag or consistent mass projection.

Bulk DMI itself should remain a local matrix-free operator.

#### 3.2.6 GPU realization

At each quadrature point the GPU kernel should evaluate:

1. `m_q`,
2. `\nabla m_q`,
3. `curl(m_q)` via `\nabla m_q`,
4. `w_bDMI`,
5. `\partial w/\partial m`,
6. `\partial w/\partial \nabla m`.

Because the tensor is antisymmetric in gradient indices, implementation bugs often show up as
sign mistakes. Unit tests should therefore target the quadrature-point formulas directly.

### 3.3 Hybrid

Deferred.

## 4. API, IR, and planner impact

### 4.1 Python API surface

Recommended new API term:

```python
fm.BulkDMI(D=...)
```

Keep bulk and interfacial DMI as distinct objects.

### 4.2 ProblemIR representation

Recommended IR addition:

```json
{ "kind": "bulk_dmi", "D": ... }
```

Planner provenance should record

- `dmi_kind = "bulk"`,
- `dmi_sign_convention = "D_m_dot_curl_m"`.

### 4.3 Planner and capability-matrix impact

Strict-mode rules:

- require positive `D`,
- require at least one ferromagnet,
- for first executable FEM path, require exchange in free-surface strict mode,
- record lumped-vs-consistent mass projection and partial-assembly-vs-fallback implementation.

## 5. Validation strategy

### 5.1 Analytical checks

1. **Uniform state without free-surface contribution**
   \[
   m=\text{const}\Rightarrow H_{bDMI}=0,\ E_{bDMI}=0.
   \]
   This check applies to closed/periodic domains or to the interior strong-form field.
   In a weak-residual FEM implementation on an open domain, the same uniform state can
   still expose the natural bulk-DMI surface residual through the projected boundary DOFs.

2. **1D Bloch spiral**
   \[
   m(z) = (\cos qz,\sin qz,0),
   \]
   giving constant `w_bDMI = -Dq`.

3. **Sign reversal**
   `D \to -D` flips chirality and observables.

### 5.2 Cross-backend checks

- compare `E_bDMI`,
- compare projected `H_bDMI`,
- compare relaxed helical/skyrmionic chirality,
- compare torque residuals in smooth test problems.

### 5.3 Regression tests

- numerical directional derivative of `E_bDMI` vs assembled residual,
- libCEED operator vs fallback assembled operator,
- lumped-vs-consistent mass projection parity on smooth fields,
- Bloch-helix benchmark.

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
- no mixed bulk/interfacial term bundles,
- no spatially varying `D`,
- no hybrid realization,
- no eigenmode linearization yet.

## 8. References

Internal references:

- `docs/physics/0460-fdm-bulk-dmi.md`
- `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
