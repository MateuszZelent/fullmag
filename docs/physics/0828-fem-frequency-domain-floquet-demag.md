# FEM frequency-domain Floquet demag

- Status: design contract, not yet production implemented
- Applies to: FEM driven frequency response, periodic airbox demag, Floquet/Bloch studies

## 1. Problem statement

Frequency-domain FEM studies use a complex perturbation around a static
equilibrium:

```text
m(r,t) = m0(r) + Re[delta_m(r) exp(i omega t)]
```

For a periodic film or antidot lattice, a single unit cell is only physical when
the dynamic magnetostatic field sees the same lattice as `delta_m`. The static
k=0 periodic Poisson reduction in `0800-fem-static-pbc-demag.md` is not enough
for this problem: the frequency-domain unknown is a phasor `delta_phi`, and for
nonzero wavevector it must carry the same Bloch phase as `delta_m`.

This note defines the target physics contract for:

```text
spin_wave_bc = periodic or floquet
magnetostatic_bc = periodic_airbox_k0 or floquet_airbox
include_demag = true
study_product = driven_response
```

Until the complete coupled operator is assembled and validated, production code
must reject these requests with explicit capability diagnostics rather than
falling back to finite isolated airbox demag.

COMSOL taxonomy alignment, 2026-06-30: COMSOL's Micromagnetics Module uses the
same frequency-domain linearized LLG formulation for two distinct studies.
`Frequency Domain` is a forced harmonic response study with a dynamic external
field perturbation; `Eigenfrequency` is a modal/eigenvalue study that returns
natural frequencies and mode profiles. Fullmag must keep the same separation:
the current `study_product=driven_response` artifacts prove only forced
response/susceptibility behavior. Peaks extracted from a response sweep are
mode candidates, not eigenmodes. A production modal path must introduce a
separate `study_product=eigenfrequency` contract over the same tangent LLG,
PBC/Floquet constraints, and dynamic demag operator.

## 2. Physical model

Fullmag stores fields in SI units. The dynamic magnetization perturbation is
represented in the local tangent basis, but the magnetostatic equation is most
naturally written in vector form. With saturation magnetization `Ms`, the
dynamic magnetization is:

```text
delta_M = Ms * delta_m
```

The dynamic scalar potential phasor satisfies, inside the magnetic domain:

```text
div(grad(delta_phi)) = div(delta_M)
```

and in the airbox:

```text
div(grad(delta_phi)) = 0
```

The dynamic demag field phasor is:

```text
delta_H_demag = -grad(delta_phi)
```

Equivalently:

```text
div(-grad(delta_phi)) = -div(delta_M)
```

This sign convention follows from `H = -grad(phi)` and `div(H + M) = 0`.
Weak forms may multiply both sides by `-1`, but the implementation and
artifacts must preserve the same physical field relation. Production promotion
requires tests for demag energy sign, an analytical field-sign oracle such as
an ellipsoid/sphere case, and symmetry of the k=0 demag Hessian.

For a lateral periodic pair with source point `r_src`, destination point
`r_dst`, and lattice vector:

```text
delta_r = r_dst - r_src
phase = exp(-i k dot delta_r)
```

the boundary conditions are:

```text
delta_m_dst = phase * delta_m_src
delta_phi_dst = phase * delta_phi_src
```

For tangent-space magnetic unknowns this condition is enforced on the
reconstructed vector, not on raw local tangent coordinates:

```text
T_dst q_dst = phase * T_src q_src
q_dst = phase * (T_dst^T T_src) q_src
```

The scalar-potential constraint is phase-only because `delta_phi` is a scalar.
The magnetic block must report whether it used full-vector transport,
tangent-frame transport, identity-frame transport, or rejected the pair set.

The normal flux check must account for opposite outward normals on paired side
faces:

```text
partial_n(dst) delta_phi_dst + phase * partial_n(src) delta_phi_src = 0
```

At `k = 0`, `phase = 1` and the constraint becomes ordinary periodicity. For a
fully periodic scalar potential block, the constant-potential nullspace must be
handled by an explicit gauge only when the assembled operator actually has that
nullspace. Open top and bottom airbox boundaries must not receive a mean-zero
pin just because lateral boundaries are periodic.

## 3. Coupled frequency-domain system

The target driven-response system is not a magnetic-only solve with a post hoc
demag correction. It is a coupled harmonic forced-response system:

```text
[A_mm(omega)  A_mphi] [delta_m]   [drive_m]
[A_phim       A_phiphi] [delta_phi] = [drive_phi]
```

where:

- `A_mm` contains the tangent linearized LLG terms that do not require the
  dynamic scalar potential.
- `A_mphi` maps `delta_phi` to `delta_H_demag = -grad(delta_phi)` and then into
  the linearized LLG precession term.
- `A_phim` maps `delta_m` to the magnetostatic source term `div(Ms delta_m)`.
- `A_phiphi` is the airbox Poisson/Laplace operator with periodic or Floquet
  lateral constraints and open-z exterior approximation.

The static Poisson matrix may be reused only as a building block when its
linearized RHS, boundary constraints, phase convention, and gauge semantics are
explicitly correct for the dynamic phasor. Reusing a static k=0 solve while
ignoring `A_mphi`, `A_phim`, or nonzero-k phase is not an implementation of this
contract.

Current implementation note, 2026-06-30: the narrow CPU `periodic_airbox_k0`
driven-response work is not this full assembled block. It routes the magnetic
GMRES operator through a matrix-free demag tangent provider / Schur-like
magnetic operator and may expose provider-side scalar-potential diagnostics, but
that does not make `delta_phi` an independently solved coupled unknown. It must
be described as a qualified driven-response slice, not as an eigenmode solver
and not as complete `[delta_m, delta_phi]` physics.

The target eigenfrequency system reuses the same linearized operators but has no
external RF drive. In abstract form it is a generalized eigenproblem over the
periodic/Floquet constrained tangent space and, when dynamic demag is enabled,
the matching scalar-potential airbox space:

```text
L(q) = omega B(q)
q = [delta_m, delta_phi]
```

For practical FEM sizes this should be solved as a selected-spectrum problem
around a requested frequency window/shift, not as a dense full diagonalization.
The eigenfrequency path must have separate artifacts for eigenvalues, damping
or linewidth convention, mode profiles, normalization, residuals, and the
constraint families used for `delta_m` and `delta_phi`.

## 4. Numerical interpretation

### FEM

The FEM implementation must assemble the magnetic tangent unknowns on the
magnetic domain and scalar-potential unknowns on the full magnetostatic domain
including air. Lateral airbox side faces use the same periodic or Floquet phase
as the magnetic cell. Top and bottom airbox faces approximate open space and
require convergence evidence with respect to z padding and boundary policy.

For `periodic_airbox_k0`, the lateral constraints are real-valued periodic
constraints. For `floquet_airbox`, complex phase constraints mix real and
imaginary components:

```text
u_dst_re =  cos(theta) u_src_re + sin(theta) u_src_im
u_dst_im = -sin(theta) u_src_re + cos(theta) u_src_im
theta = k dot delta_r
```

The phase loop around a corner must be path independent:

```text
phase_x * phase_y == phase_y * phase_x
```

If pair metadata is missing, duplicate, geometrically inconsistent, or does not
cover the requested magnetic and magnetostatic side faces, the planner or
runtime must reject the study.

### GPU

GPU support is out of scope until strict GPU periodic Poisson or equivalent
libCEED/hypre operators exist and pass the same continuity, gauge, convergence,
and provenance checks. A GPU request must not silently run the CPU coupled block
or dense validation solver.

### FDM and hybrid backends

FDM demag periodicity is represented by its convolution kernel, not by an FEM
scalar-potential airbox. A future hybrid path must declare its own capability
and artifact model instead of reusing the FEM `floquet_airbox` name.

## 5. API and IR impact

The public model should distinguish magnetic and magnetostatic boundary
conditions:

```text
requested_spin_wave_bc
resolved_spin_wave_bc
requested_magnetostatic_bc
resolved_magnetostatic_bc
```

The plan IR must carry separate constraint sets:

```text
delta_m: magnetic-domain periodic or Floquet pairs
delta_phi: full airbox lateral periodic or Floquet pairs
```

Runtime artifacts must expose at least:

```text
mesh/periodic_pairs.v1.json
frequency_domain/manifest.v1.json
response/diagnostics/solver.v1.json
response/frequency_points/frequency_*.json
```

Each solved frequency point with demag must state whether dynamic demag was
solved, unavailable, or rejected, and must include the phase convention,
magnetic and magnetostatic BC provenance, gauge policy, and either
`delta_phi_complex` or an explicit unsupported reason. It must also report the
operator/preconditioner split when a coupled or Schur-like path is used:

```text
matrix_form = coupled_demag_block | schur_phi_consistency_provider | magnetic_only
ksp_type
pc_type
magnetic_block_iterations
poisson_block_iterations
converged_reason
linear_residual_absolute
linear_residual_relative
```

## 6. Validation strategy

Minimum validation before production enablement:

- `k = 0` Floquet/periodic equivalence against the static-periodic convention.
- Exchange-only reciprocal response: `response(+k) == response(-k)` within
  tolerance when all nonreciprocal terms are disabled.
- DMI nonreciprocity response: `response(+k) != response(-k)` with the expected
  sign when DMI is enabled.
- Magnetic continuity:

```text
max_pair ||delta_m_dst - phase * delta_m_src|| < eps_dm
```

- Tangent-frame transport:

```text
max_pair ||q_dst - phase * (T_dst^T T_src) q_src|| < eps_q
```

- Magnetostatic scalar-potential continuity:

```text
max_pair |delta_phi_dst - phase * delta_phi_src| < eps_phi
```

- Lateral flux anti-periodicity:

```text
max_pair |partial_n(dst) delta_phi_dst
         + phase * partial_n(src) delta_phi_src| < eps_flux
```

- Airbox z-padding convergence for response peak frequency and amplitude.
- Supercell validation: compare a `1x1` Floquet/PBC cell against a `2x2` or
  `3x3` explicit supercell with Gamma-like excitation and central-cell
  extraction.
- Gauge validation: mean-zero or equivalent gauge is applied only when the
  scalar-potential block has a constant nullspace.
- Provenance validation: no request may downgrade from periodic or Floquet
  demag to finite isolated airbox without a hard rejection.

## 7. Completeness checklist

- Python API: must expose demag periodic/Floquet intent without implying that
  magnetic PBC alone is enough.
- ProblemIR: must carry separate magnetic and magnetostatic constraint sets.
- Planner: must reject missing airbox lateral pairs, non-open z policy gaps,
  GPU, and unsupported nonzero-k demag.
- Native CPU: must assemble and solve the coupled `[delta_m, delta_phi]` block.
- Native GPU: must stay unsupported until periodic Poisson/Floquet operators are
  implemented and verified.
- Artifacts: must report requested and resolved magnetic and magnetostatic BCs,
  phase convention, gauge policy, and demag contribution.
- Tests: must cover continuity, flux, gauge, supercell, airbox convergence, and
  no silent fallback.
- Documentation: this note must remain linked from the active implementation
  plan while the feature is partial.

## 8. Known limits and deferred work

The finite z-airbox is an approximation to open space. Infinite elements,
FEM/BEM Fredkin-Koehler coupling, periodic Green functions, Ewald sums,
FFT/FMM-assisted periodic demag kernels, and mapped exterior shells are separate
capabilities. They must not be introduced as hidden improvements to
`floquet_airbox`; each needs its own capability, provenance, and validation
contract.
