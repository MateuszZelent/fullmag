# Solver units and LLG convention

Status: canonical units contract for native FDM/FEM solver implementations.

This note defines the units that solver backends must use internally when they
consume `ProblemIR` plans and publish fields, energies, telemetry, and
artifacts. Backend modules may choose different data layouts, finite-element
spaces, FFT workspaces, or GPU kernels, but they must not reinterpret these
units.

## Reduced magnetization

The solver state is the reduced magnetization

```text
m = M / Ms
```

with `|m| = 1` on magnetic degrees of freedom after every accepted step. `M` is
the magnetization in `A/m`; `Ms` is the saturation magnetization in `A/m`.
Nonmagnetic nodes or cells may exist for FEM airbox and visualization, but they
must not contribute to the magnetic RHS unless an interaction explicitly defines
that behavior.

## Effective field

All effective-field terms are expressed in `A/m`:

```text
H_eff = H_ex + H_demag + H_ext + H_ani + H_dmi + H_oe + H_me + H_th + ...
```

An interaction implemented as a field contributes to `H_eff`. An interaction
implemented as a direct torque contributes to `tau_direct` and must have units
`1/s`. Mixing these paths silently is forbidden.

## LLG equation

Native solvers use the explicit Landau-Lifshitz-Gilbert RHS

```text
dm/dt =
  -gamma_mu0 / (1 + alpha^2)
    [m x H_eff + alpha m x (m x H_eff)]
  + tau_direct
```

where:

| Symbol | Solver field | Unit | Meaning |
|---|---|---|---|
| `m` | `m_xyz` | 1 | reduced magnetization |
| `H_eff` | `h_eff_xyz` | `A/m` | effective magnetic field |
| `alpha` | `damping`, `alpha_field` | 1 | Gilbert damping |
| `gamma_mu0` | `gyromagnetic_ratio` in native FEM material descriptors | `m/(A s)` | reduced gyromagnetic constant already including `mu0` |
| `tau_direct` | torque RHS buffers | `1/s` | direct torque added to `dm/dt` |

The native FEM ABI name `gyromagnetic_ratio` is legacy naming. Its value must be
the reduced `gamma_mu0` in `m/(A s)`, approximately `2.211e5 m/(A s)` for common
micromagnetic examples. It must not be the electron gyromagnetic ratio in
`rad/(T s)`. Code and errors should prefer the explanatory name `gamma_mu0`
whenever a new internal symbol is introduced.

## Energy-field relation

For a magnetic energy functional `E[m]` reported in joules, an effective field
term must satisfy the variational relation

```text
dE = -mu0 int_Omega Ms H_term . delta_m dV
```

for tangent perturbations `delta_m` with `delta_m . m = 0`. FEM and FDM
implementations may discretize the integral differently, but tests must state
the mass, lumping, quadrature, projection, and boundary policy used for the
comparison.

## Canonical quantities

| Quantity | Symbol | Unit | Solver contract |
|---|---|---|---|
| Vacuum permeability | `mu0` | `N/A^2` or `T m/A` | exactly `4 pi 1e-7` |
| Boltzmann constant | `kB` | `J/K` | exactly `1.380649e-23` |
| Saturation magnetization | `Ms` | `A/m` | positive on magnetic nodes/cells |
| Exchange stiffness | `A_ex` | `J/m` | nonnegative |
| Uniaxial anisotropy | `Ku`, `Ku2` | `J/m^3` | sign and energy offset documented by the anisotropy module |
| Cubic anisotropy | `Kc1`, `Kc2`, `Kc3` | `J/m^3` | axes finite, normalized, and mutually orthogonal |
| Interfacial DMI | `D_i` | `J/m^2` | must state thin-film-effective or surface-boundary realization |
| Bulk DMI | `D_b` | `J/m^2` in current public ABI | module must document the conversion used by the discretization |
| Current density | `J` | `A/m^2` | STT/Oersted inputs |
| Free-layer thickness | `t` | `m` | Slonczewski STT scaling |
| Temperature | `T` | `K` | thermal field disabled at `T = 0` |
| Time step | `dt` | `s` | accepted step size for deterministic RHS; thermal policy must define rejected-step behavior |
| Effective field | `H_*` | `A/m` | field observables and RHS field inputs |
| Energy | `E_*` | `J` | global scalar unless explicitly documented otherwise |
| Direct torque | `tau_*` | `1/s` | added directly to `dm/dt` |

## Interaction-specific conventions

### Exchange

For isotropic exchange,

```text
E_ex = int_Omega A_ex |grad m|^2 dV
H_ex = 2 A_ex / (mu0 Ms) Delta m
```

FEM implementations must document stiffness assembly, mass projection, material
averaging for heterogeneous `A_ex` and `Ms`, and periodic reduction policy.

### Zeeman

```text
E_Z = -mu0 int_Omega Ms m . H_ext dV
H_Z = H_ext
```

`H_ext` is in `A/m`. Magnetization parallel to the field must have lower energy
than magnetization antiparallel to the field.

### Demag

```text
H_demag = -grad u
div(H_demag + M) = 0
```

Poisson/airbox realizations must document the boundary mode, airbox scale,
linear solver, residual tolerance, warm-start policy, and whether visualization
fields include nonmagnetic airbox nodes.

### Anisotropy

The preferred uniaxial convention is

```text
E_ani = int_Omega Ku (1 - (m . u)^2) dV
H_ani = 2 Ku / (mu0 Ms) (m . u) u
```

If an implementation reports the shifted energy `-Ku (m . u)^2`, that offset
must be stated in the module header and in observable metadata.

### DMI

DMI must not be represented by a single ambiguous flag. At minimum, modules must
separate:

```text
BulkDmiVolume
InterfacialDmiThinFilmEffective
InterfacialDmiSurfaceBoundary
```

Each variant must state its energy, field or weak residual, boundary condition,
normal-vector convention, and unit conversion.

### Thermal noise

Thermal Brown fields must document the fluctuation-dissipation convention used
with `gamma_mu0`, the nodal/cell volume `V_i`, the accepted time step `dt`, and
the RNG policy for adaptive rejected steps.

### Spin-transfer torque

STT terms must choose exactly one representation:

```text
tau_STT [1/s] added directly to dm/dt
```

or

```text
H_STT [A/m] passed through the LLG field operator
```

The implementation must not mix a direct RHS torque with a field prefactor. The
Slonczewski damping-like scale must be tested against `J/(Ms t)` and current
sign.

## Backend implications

FDM CPU, FDM GPU, FEM CPU, and FEM GPU share this physical contract. Their
differences are limited to discretization, operator application, linear-solver
realization, precision, memory residency, and performance telemetry.

Planner and native create paths must reject unsupported combinations before the
solver starts. In particular, the current native FEM CPU path is P1-only:
`fe_order > 1` must be rejected clearly until a high-order contract and
validation matrix are implemented.
