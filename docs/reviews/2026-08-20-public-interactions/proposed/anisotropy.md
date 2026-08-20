---
title: Magnetocrystalline anisotropy — audited revision proposal
status: review-ready
doc_kind: audit-and-revision
targets:
  - public_docs/site/physics/interactions/anisotropy/uniaxial.md
  - public_docs/site/physics/interactions/anisotropy/cubic.md
reviewed_revision: f79c65d43ef2ac550f89932b47940489f719acb0
---

# Magnetocrystalline anisotropy

## Audit verdict

| Area | Verdict |
|---|---|
| Uniaxial energy and field | Correct for FullMag's negative-power convention. |
| Cubic energy and field | Correct for the declared `Kc1/Kc2/Kc3` invariant polynomial. |
| Axis handling | Scientific contract differs by backend; this should be eliminated or made fail-closed. |
| Coefficient conventions | Current constant-shift note is true but insufficient for common `K1 sin^2(theta) + K2 sin^4(theta)` data. |
| Examples | Stage-first, but need analytic expected states and one consistent initializer. |
| Completeness | Needs phase/easy-direction guidance, crystal-frame provenance, and derivative tests. |

## Required corrections

1. Add the exact coefficient conversion between FullMag's uniaxial polynomial and the common
   `K1 sin^2(theta) + K2 sin^4(theta)` convention.
2. Require one physical crystal-frame contract for all lanes. A backend must not silently accept
   nonorthogonal cubic axes merely because a kernel can normalize the two inputs independently.
3. Record authored axes and resolved orthonormal axes in provenance.
4. Explain that `Kc3` is a FullMag higher-order invariant coefficient and should not be confused
   with every literature convention called “third-order cubic anisotropy.”
5. Add easy-axis/easy-plane and cubic easy-direction examples with expected energies.
6. Consolidate compatibility constructors and material-owned canonical fields so that one page
   clearly owns migration and conflict semantics.

# Uniaxial anisotropy

Let `u` be a normalized easy-axis direction and `q = m·u`. FullMag uses

```math
w_u = -K_{u1}q^2 - K_{u2}q^4,
\qquad
E_u = \int_{\Omega_m} w_u\,dV.
```

The effective field is

```math
H_u = \frac{2K_{u1}q+4K_{u2}q^3}{\mu_0 M_s}\,u.
```

Positive `Ku1` favours `|q| = 1` when the fourth-order term does not create another minimum;
negative `Ku1` favours the plane `q = 0` under the corresponding stability conditions. The user
reference should not infer the complete phase diagram from the sign of `Ku1` alone when `Ku2` is
nonzero.

## Conversion from the common angular convention

A widespread form is

```math
w_{std}=K_1\sin^2\theta+K_2\sin^4\theta,
\qquad q=\cos\theta.
```

Up to the constant `K1 + K2`, this is

```math
w_{std}=-(K_1+2K_2)q^2+K_2q^4+\mathrm{const}.
```

Therefore the equivalent FullMag coefficients are

```math
K_{u1}=K_1+2K_2,
\qquad
K_{u2}=-K_2.
```

The current statement that `Ku1(1-q^2)+Ku2(1-q^4)` differs only by a constant is algebraically
correct for that explicitly written polynomial. It must not be generalized to every publication
that uses symbols `K1` and `K2`.

# Cubic anisotropy

Let `c1`, `c2`, and `c3 = c1 × c2` form a right-handed orthonormal crystal frame and define
`alpha_a = m·c_a`. With

```math
Sigma=\alpha_1^2\alpha_2^2+\alpha_2^2\alpha_3^2+\alpha_3^2\alpha_1^2,
```

FullMag uses

```math
w_c
=K_{c1}\Sigma
+K_{c2}\alpha_1^2\alpha_2^2\alpha_3^2
+K_{c3}\Sigma^2.
```

For `Kc2 = Kc3 = 0`, positive `Kc1` favours the `<100>` family and negative `Kc1` favours the
`<111>` family. With higher-order coefficients, the extrema must be evaluated from the full
polynomial; the sign of `Kc1` alone is not decisive.

The field can be written

```math
H_c=-\frac{1}{\mu_0M_s}\sum_{a=1}^3
\frac{\partial w_c}{\partial\alpha_a}\,c_a.
```

The componentwise expanded formula may remain on the detailed page, while the invariant form
should be the primary scientific contract.

## Crystal-frame contract

For an active cubic term:

- `c1` and `c2` must contain finite components;
- both must have nonzero norm;
- after normalization, `|c1·c2|` must be below a declared tolerance;
- `c3 = c1 × c2` must be normalized and the handedness recorded;
- invalid frames must fail before planning, not be repaired differently by CPU and GPU paths.

If FullMag later supports automatic orthogonalization, it must be an explicit requested policy and
serialize both authored and resolved frames.

## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `m` | reduced magnetization | 1 |
| `u` | uniaxial direction | 1 |
| `c1`, `c2`, `c3` | cubic crystal axes | 1 |
| `Ku1`, `Ku2` | FullMag uniaxial coefficients | J/m^3 |
| `Kc1`, `Kc2`, `Kc3` | FullMag cubic coefficients | J/m^3 |
| `w_u`, `w_c` | energy density | J/m^3 |
| `H_u`, `H_c` | effective field | A/m |

## Stage-first example

```python
# %% Uniaxial anisotropy relaxation
import fullmag as fm

nm = 1.0e-9
study = fm.study("uniaxial_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 1 * nm))

film = study.geometry(fm.Box(40 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.5
film.Ku1 = 0.5e6
film.Ku2 = 0.05e6
film.anisU = (0.0, 0.0, 1.0)
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=20_000,
    tolT=1.0e-6,
)
```

A second short example should set `Kc1`, `Kc2`, `Kc3`, `anisC1`, and `anisC2`. Documentation CI
must execute both blocks and compare the material-owned IR fields with the live serializer.

## Required validation suite

### Uniaxial

1. Parallel, antiparallel, and perpendicular analytic energies.
2. Field collinearity with `u` and finite-difference energy derivative.
3. `Ku2` phase scan locating all stationary values of `q` in `[-1,1]`.
4. Axis scale invariance after normalization and fail-closed zero-axis handling.
5. Spatial coefficient-field cardinality and interpolation tests.

### Cubic

1. Energies for `<100>`, `<110>`, and `<111>` states.
2. Frame rotation covariance.
3. Rejection of parallel and nonorthogonal axes under one global tolerance.
4. Finite-difference derivative of the full `Kc1/Kc2/Kc3` polynomial.
5. CPU/GPU field and energy parity for scalar and spatial coefficients.
6. FEM quadrature/lumping convergence for heterogeneous material regions.

## Recommended extensions

- typed crystal-frame objects with explicit laboratory-to-crystal rotation matrices;
- additional symmetry families only as separately versioned formula objects;
- a coefficient-conversion utility that names the source convention;
- automatic easy-direction analysis and energy-surface visualization;
- grain-wise orientation fields with interpolation and discontinuity semantics.

## Bibliography

- W. F. Brown Jr., *Micromagnetics*, Wiley, 1963.
- R. Skomski, *Simple Models of Magnetism*, Oxford University Press, 2008.
- A. Hubert and R. Schäfer, *Magnetic Domains*, Springer, 1998.
