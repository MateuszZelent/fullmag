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

External solver alignment, 2026-07-04: TetraX's dipolar spin-wave tensor is the
right implementation warning for Fullmag's future demag-k path. TetraX updates
the dynamic matrix when `k` changes, modifies the potential solve with `k^2`
terms, adds complex source terms such as `i k Ms m_z`, and recovers the
longitudinal field with a k-dependent gradient term. Fullmag must implement the
same mathematical idea in its own FEM shared-domain airbox architecture:
`k=0` periodic-airbox demag is a real scalar-potential constrained provider,
while nonzero-k Floquet demag requires a complex Bloch/Floquet
`grad_k`/`div_k` operator. Reusing a static k=0 Poisson solve or applying
Floquet phase only in the viewport is not dynamic demag-k.

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

Current implementation note, 2026-07-04: the native CPU driven-response path can
include dynamic demag at k=0 by routing the magnetic GMRES operator through a
matrix-free backend demag tangent provider. The narrow CPU
`periodic_airbox_k0` path uses the same idea with a Schur/phi-consistency
provider and may expose provider-side scalar-potential diagnostics, but that
does not make `delta_phi` an independently assembled coupled unknown. It must be
described as a qualified driven-response slice, not as an eigenmode solver and
not as complete `[delta_m, delta_phi]` physics. The native GPU driven-response
path can include ordinary k=0 demag through the backend demag-tangent provider
while keeping the local/exchange operator on CUDA. The same CUDA magnetic
operator may include open/gamma and k=0 static-periodic P1 interfacial or bulk
DMI when the native frequency-domain request carries complete element tangent
payloads, lumped mass, and positive `Ms`. Static-periodic DMI uses the same k=0
tangent input/output projection as the other magnetic operators; this does not
implement nonzero-k Floquet DMI assembly across paired seams. For
`periodic_airbox_k0`, a GPU request is legal only when
the backend demag tangent-with-potential provider is created on the GPU demag
backend (`device_hypre_poisson`) and the artifacts preserve
`requested_execution_lane="production_gpu"`. It must not silently run a CPU
coupled block or dense validation solve. Floquet-airbox, nonzero-k Floquet DMI
assembly, and nonzero-k demag-k remain gated until the corresponding GPU
dynamic operators exist.

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

The first GPU `periodic_airbox_k0` implementation is the matrix-free provider
path: the GMRES solve may remain the host-side frequency-response Krylov
driver, but operator application calls the GPU demag tangent-with-potential
backend and reports GPU Poisson provenance. The CUDA magnetic operator owns a
persistent per-adapter context for static device buffers such as tangent frames,
exchange edges, nodal damping, Zeeman field, anisotropy axis, and optional P1
DMI element tangent payloads for open/gamma or k=0 static-periodic magnetic
slices; each Krylov application uploads only the current
tangent vector and optional demag tangent payload, then downloads the
stiffness/mass action. This is not the same as accepting an explicit CPU
dense/coupled-block payload, and it is not yet a fully device-resident Krylov
solve. Explicit dense validation and CPU coupled-block payloads remain invalid
for a requested production GPU lane.

Floquet-airbox and nonzero-k demag-k GPU support remain out of scope until strict
GPU periodic/Bloch Poisson or equivalent libCEED/hypre operators exist and pass
the same continuity, gauge, convergence, and provenance checks.

Implementation contract update, 2026-07-04: the driven-response GMRES core and
native C ABI can now accept a complex matrix-free coupled-block provider for
`[delta_m, delta_phi]`. This is required for Bloch/Floquet demag because the
scalar-potential constraints mix real and imaginary components. The legacy real
matrix-free provider remains valid only for real-valued k=0 operators. A
`floquet_airbox` request is still not production-complete until a native
Bloch/Floquet Poisson provider supplies those complex stiffness/mass callbacks
and passes the validation gates below.

Implementation contract update, 2026-07-05: the `periodic_airbox_k0` reduced
magnetic Schur solve must not describe a local magnetic block-Jacobi
preconditioner as a demag-aware production preconditioner. For large
periodic-airbox response systems, the preconditioner must approximate the same
matrix-free Schur operator seen by GMRES:

```text
S(omega) delta_m = L_m(delta_m, delta_H_demag(delta_m))
                 + i omega B_alpha(delta_m)
```

where `delta_H_demag(delta_m)` is supplied by the resolved CPU/GPU
demag-tangent-with-potential provider and the lateral k=0 periodic projection is
part of the operator. A block-Jacobi preconditioner built only from local
Zeeman/anisotropy/exchange diagonal terms is a fallback candidate, not a
production Schur preconditioner. If a graph or demag-coarse variant is selected,
diagnostics must prove that it changes the effective preconditioner action
relative to plain block-Jacobi or report that it was disabled. A matrix-free
Schur residual-correction preconditioner is acceptable as a first production
step: apply the local magnetic inverse, evaluate the actual reduced Schur
residual with the resolved demag provider, and apply one or more local
corrections. This is more expensive per Krylov iteration, but it preserves the
CPU/GPU demag realization and avoids pretending that local block-Jacobi captures
the airbox coupling.

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
dynamic_demag_matrix_form = coupled_demag_block | schur_phi_consistency_provider | magnetic_only
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
  explicit CPU dense/coupled-block payloads on requested production GPU lanes,
  and unsupported nonzero-k demag unless a complete coupled-block provider is
  supplied for that lane.
- Native CPU: must assemble and solve the coupled `[delta_m, delta_phi]` block.
- Native GPU: may execute only the matrix-free provider path with CUDA magnetic
  operator application, optional open/gamma or k=0 static-periodic P1 DMI
  tangent payloads, and GPU demag tangent-with-potential provenance; nonzero-k
  Floquet DMI assembly, full device-resident periodic/Bloch Poisson, dense
  coupled-block GPU solves, and nonzero-k demag-k remain gated until
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
