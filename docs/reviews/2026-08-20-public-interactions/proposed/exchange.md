---
title: Exchange interaction — audited revision proposal
status: review-ready
doc_kind: audit-and-revision
target: public_docs/site/physics/interactions/exchange/index.md
reviewed_revision: f79c65d43ef2ac550f89932b47940489f719acb0
---

# Exchange interaction

## Audit verdict

| Area | Verdict |
|---|---|
| Continuum energy and field | Correct for the declared SI convention. |
| Variable-stiffness form | Correctly requires `div(A grad m)`, not `A laplacian(m)`. |
| Boundary treatment | Substantially correct, but the exchange–DMI combined natural boundary must be cross-linked. |
| FDM/FEM discussion | Good technical depth; capability and qualification language should be normalized. |
| Python example | Stage-first, but it should declare the execution lane consistently and include an expected validation result. |
| Completeness | Missing exchange-length mesh guidance, dispersion validation, and a concise heterogeneous-interface derivation. |

No sign or SI-unit error was identified in the canonical equations. The main risks are status
language, stale implementation links, and insufficient user guidance on mesh resolution.

## Required corrections

1. Replace page-wide `status: implemented` with a capability matrix that distinguishes reference,
   production, and validated lanes.
2. Use namespaced MyST labels, for example `(exchange-problem-statement)=`; do not use globally
   duplicated bare labels.
3. Generate the documented `ProblemIR` fragment with the current serializer. Do not maintain a
   hand-shaped approximation.
4. Pin source links to the reviewed revision or use stable path-plus-symbol source maps; remove
   stale commit-specific links.
5. Add the exchange length and state explicitly that it is a physical resolution scale, not an
   automatic proof of discretization convergence.
6. Add a separate interface formula for unequal centre-to-interface distances. A simple harmonic
   mean is exact only for symmetric link geometry.

## Proposed canonical physical content

Let `m = M / Ms` be the reduced magnetization, `|m| = 1`, and let `A(x)` be the exchange stiffness.
The continuum energy is

```math
E_ex[m] = \int_{Omega_m} A(x)\,\nabla m : \nabla m\,dV.
```

With the FullMag effective-field convention

```math
H_eff = -\frac{1}{\mu_0 M_s}\frac{\delta E}{\delta m},
```

the exchange field is

```math
H_ex = \frac{2}{\mu_0 M_s}\nabla\cdot\left(A\nabla m\right).
```

For constant `A`, this reduces to

```math
H_ex = \frac{2A}{\mu_0 M_s}\nabla^2 m.
```

The natural free-boundary condition associated with exchange alone is

```math
A\,\partial_n m = 0 \qquad \text{on } \partial\Omega_m.
```

When DMI is active, this condition is replaced by the variationally combined exchange–DMI
boundary condition. The exchange page must not imply that a zero-normal-gradient closure remains
physically complete in that case.

### Exchange length and mesh guidance

For a material with saturation magnetization `Ms`, define

```math
ell_ex = \sqrt{\frac{2A}{\mu_0 M_s^2}}.
```

`ell_ex` is a useful scale for initial mesh design. It is not a universal maximum cell size:
DMI, anisotropy, geometric curvature, domain-wall width, interfaces, and the target observable can
require a finer mesh. Public examples should include at least one refinement study.

### Heterogeneous interface coefficient

For two one-dimensional control volumes whose cell centres lie distances `d_a` and `d_b` from an
interface, flux continuity gives the link stiffness

```math
A_ab = \frac{d_a+d_b}{d_a/A_a+d_b/A_b}.
```

For `d_a = d_b`, this becomes the harmonic mean

```math
A_ab = \frac{2A_aA_b}{A_a+A_b}.
```

The documentation should distinguish this ordinary material-interface flux from an explicitly
authored RKKY or interlayer surface coupling.

## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `M`, `Ms` | magnetization and saturation magnetization | A/m |
| `m` | reduced magnetization | 1 |
| `A` | exchange stiffness | J/m |
| `E_ex` | exchange energy | J |
| `H_ex` | exchange effective field | A/m |
| `mu0` | vacuum permeability | N/A^2 |
| `ell_ex` | exchange length | m |
| `d_a`, `d_b` | centre-to-interface distances | m |

## Capability statement

| Solver | Device | Recommended public status | Required qualification boundary |
|---|---|---|---|
| FDM | CPU | `reference_executable` | variable-A stencil, masks, PBC, energy/field derivative tests |
| FDM | GPU | `production_executable` | executed-device FP64/FP32 parity and boundary/PBC coverage |
| FEM | CPU | `production_executable` | weak-form convergence, heterogeneous material fields, boundary terms |
| FEM | GPU | `production_executable` | device-resident operator, reduction, and executed-device parity |

The exact status should be generated from the capability registry rather than copied manually into
multiple pages.

## Stage-first authoring example

```python
# %% Exchange-only relaxation
import fullmag as fm

nm = 1.0e-9
study = fm.study("exchange_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))

film = study.geometry(fm.Box(80 * nm, 20 * nm, 4 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.5
film.m = fm.texture.uniform(0.8, 0.6, 0.0)

study.exchange()
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=20_000,
    tolT=1.0e-6,
)
```

The documentation test should execute this authoring block, serialize it, and verify that exchange
is enabled and `Aex = 13e-12 J/m` reaches the canonical material record. A separate native test
must verify energy decrease and final uniformity; constructing the study is not that test.

## Numerical validation required before `validated`

1. **Uniform state:** `H_ex = 0` and `E_ex = 0` to round-off.
2. **Sinusoidal mode:** for `m_y ~ sin(kx)`, verify the `-k^2` field scaling and second-order FDM
   convergence.
3. **Spin-wave dispersion:** recover the exchange contribution proportional to `k^2`.
4. **Variational derivative:** compare field work with centred finite differences of energy.
5. **Material interface:** compare weighted harmonic links with a one-dimensional analytic flux
   solution for unequal cell spacing.
6. **PBC:** constant and Fourier modes must be translationally invariant across the periodic seam.
7. **CPU/GPU:** compare both field and total energy, not only one RK trajectory.
8. **FEM refinement:** verify convergence in the energy norm on a manufactured smooth solution.

## Recommended extensions

- expose and document higher-order exchange only under a new formula/version identifier;
- support tensor exchange only with a positive-definiteness contract and full frame provenance;
- publish mesh-advisor diagnostics based on exchange length, DMI pitch, anisotropy wall width, and
  local geometric feature size;
- add an interaction-composition page for exchange plus DMI boundary conditions.

## Bibliography

- W. F. Brown Jr., *Micromagnetics*, Wiley, 1963.
- A. Aharoni, *Introduction to the Theory of Ferromagnetism*, 2nd ed., Oxford University Press,
  2000.
- H. Kronmüller and M. Fähnle, *Micromagnetism and the Microstructure of Ferromagnetic Solids*,
  Cambridge University Press, 2003.
