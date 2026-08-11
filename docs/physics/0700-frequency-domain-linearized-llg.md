# Frequency-domain linearized LLG

Status: reference contract
Applies to: FEM eigen, dispersion, periodic and Floquet studies

The single canonical dynamic-pencil dictionary, typed frequency/shift units,
original-operator residual, reduced-order projection rules, and CPU/GPU lane
names are defined in
`0831-fem-dynamic-pencil-modal-response-and-krylov.md`. The equations below are
the physical specialization of that contract.

## Convention

Fullmag uses SI units. Effective fields are stored in `A/m`. The LLG
precession coefficient used in frequency-domain operators is:

```text
gamma0 = mu0 * |gamma|
```

when `gamma` is stored in `rad/(s T)`.

The phasor convention is:

```text
m(r,t) = m0(r) + Re[delta_m(r) exp(+i omega t)]
H_eff[m] = H0 + Re[delta_H[delta_m] exp(+i omega t)]
```

with:

```text
|m0| = 1
m0 dot delta_m = 0
```

## Product Split

Frequency-domain authoring uses one linearized tangent-operator contract, but
it produces two separate study products:

- `modal_eigen` with UI label `Eigenmodes`,
- `driven_response` with UI label `Frequency Response`.

They are not interchangeable and neither product inherits execution status from
the other.

The modal product solves the generalized eigenproblem

```text
A q = lambda B q
```

with `lambda = i omega`.

The driven product solves the forced harmonic system

```text
(i omega B - A) q = b
```

at user-requested frequencies.

Both products use:

- `gamma0 = mu0 * |gamma|`,
- tangent variables `q`, not unconstrained three-component unknowns,
- manifest `analysis_family = "magnetic_frequency_domain"`,
- explicit `study_product = "modal_eigen"` or `study_product = "driven_response"`.

## COMSOL parity requirements

`docs/comsol/Manual_for_Micromagnetics_Module.pdf` is not a Fullmag semantic
source, but it is a useful parity reference for user-facing frequency-domain
behavior. Fullmag must preserve the following product-level distinctions:

- Time-domain dynamics and frequency-domain dynamics are separate study
  surfaces.
- Frequency-domain dynamics means linearized LLG around a static equilibrium
  `m0`.
- Modal `eigenmodes` and driven `frequency_response` are separate solvers.
  The modal path solves the eigensystem; the driven path solves a forced
  harmonic linear system at requested frequencies.
- The dynamic magnetization perturbation `delta_m` is a complex phasor. Field
  resources and inspectors must expose `real`, `imag`, `abs`, and `phase`
  views.
- Mode animation is phasor reconstruction, not time integration:

```text
m_anim(r,t) = m0(r) + scale * Re[delta_m(r) exp(i (omega t + phi0))]
```

- A dynamic drive `delta_h` is a phasor. Public UI/API surfaces must not require
  users to encode the sinusoidal `sin(omega t)` or `cos(omega t)` factor by
  hand.
- For textured states, the equilibrium used by the frequency-domain study must
  come from an explicit static or relaxation stage, and artifacts must preserve
  the equilibrium provenance and residual diagnostics.
- Floquet/Bloch periodic studies use the phase convention owned by
  `docs/physics/0710-periodic-and-floquet-boundary-conditions.md`, including
  the `exp_minus_i_k_dot_delta_r` sign convention.
- Nonzero-k Floquet dynamic demagnetization remains unsupported until Fullmag
  implements and validates a mathematically consistent dynamic demag-k
  operator.
- A modal `KSamplingIR::Path` is orchestrated as repeated single-k modal solves
  plus branch tracking. Each sample must use the most specific legal modal
  entrypoint for that sample: gamma-equivalent free-boundary `Full2x2`
  `FrequencyWindow` samples may use the production CPU selected-spectrum /
  shift-invert path, while no-demag `Full2x2` nonzero-k Floquet samples may use
  the native production CPU selected-spectrum path when the runner can build an
  explicitly labelled Bloch/Floquet tangent payload from periodic pair
  metadata. Reference/MVP nonzero-k dispersion artifacts must stay explicitly
  labelled as such and must publish `production_cpu_rejection_reason =
  "production_cpu_modal_nonzero_k_floquet_operator_missing"` only when that
  labelled payload path is unavailable. Native diagnostics also publish
  `required_operator_payload_kind = "bloch_floquet_tangent_operator"` on
  rejection so the presence of Floquet pair metadata is not mistaken for the
  actual production operator payload. The native modal C ABI can now carry a Floquet k-vector,
  phase convention, explicit Floquet periodic-pair tail, and a direct dense
  modal payload explicitly labelled as
  `payload_kind = "bloch_floquet_tangent_operator"`. Native production CPU may
  pass such an explicitly labelled payload into the selected-spectrum adapter.
  The runner has the algebraic materializer for that payload: a complex
  Bloch/Floquet generalized operator
  `K q = lambda M q` can be embedded as a real gyrotropic pencil with
  `K_embedded = diag(K_R, K_R)` and
  `B_embedded = [[0, -M_R], [M_R, 0]]`, producing the native
  `lambda = i omega` form for the selected-spectrum adapter. Native positive
  branches in the embedded form `v = [x, i x]` are reduced back to the physical
  complex tangent vector by recovering `x` and mapping
  `q = x_re + i x_im`. The Rust native modal wrapper and FEM eigen runner build
  the periodic-pair payload for each `KSamplingIR::Single` Floquet request from
  `MeshIR.periodic_node_pairs` plus matching
  `MeshIR.periodic_boundary_pairs[*].translation`, using
  `phase_rad = -k dot translation` for the current
  `exp_minus_i_k_dot_delta_r` convention. The native GPU modal lane is
  validated only for the K0 no-demag macrospin/Kittel field sweep through
  `gpu_dense_k0_macrospin_modal_eigen` and cuSolverDN dense generalized solve;
  dynamic demag-k, nonzero-k Floquet GPU modal dispersion, and broader
  sparse/matrix-free Floquet validation remain gated.
- A gamma-only k-path is a production-adapter proof, not a spin-wave dispersion
  proof: it may verify that multi-k orchestration preserves production CPU
  selected-spectrum provenance and mode-field sample remapping, but it must not
  be described as nonzero-k Bloch/Floquet dispersion.

## Linearized equation

The frequency-domain perturbation satisfies:

```text
i omega delta_m =
-gamma0 * (m0 x delta_H[delta_m] + delta_m x H0)
  + i omega alpha * (m0 x delta_m)
  + tau_lin[delta_m]
```

Equivalently, after projection to the local tangent basis:

```text
L q = i omega B_alpha q
```

where `q` contains the two tangent components of `delta_m` at each magnetic
node or cell, `L` is the projected linearized effective-field/torque operator,
and `B_alpha` is the mass/gyrotropic operator including the chosen damping
convention. Older notes may use `A` or `M` for the same roles; new production
contracts must spell out the operator definitions before mapping eigenvalues
to frequency.

For the modal product, Fullmag's canonical production convention is:

```text
lambda q = B_alpha^{-1} L q
lambda = i omega
```

or the algebraically equivalent generalized pencil:

```text
L q = lambda B_alpha q
lambda = i omega
```

For an energy-Hessian gyrotropic implementation with physical `G`, this means
the generalized solver matrix on the right-hand side is `B = -G`, because the
canonical phasor equation is `K phi = -i omega G phi`. A solver that reports
`lambda = i omega` must therefore solve `K phi = lambda (-G) phi` or publish a
different, explicitly derived mapping.

If a gyrotropic energy Hessian form is used instead, it must include the
phasor factor explicitly. With the `exp(i omega t)` convention and a real
skew-symmetric gyrotropic form `G`, the pencil is:

```text
K phi = -i omega G phi
```

not `K phi = omega G phi`, unless `G` has already been transformed into a
complex or Hamiltonian operator that contains the factor `i`. Documentation and
artifacts for such a transformed operator must name the transform and the
eigenvalue-to-`omega_rad_s` mapping.

If `K` is the second variation of physical magnetic energy in joules and
`gamma0 = mu0 * |gamma|`, the gyrotropic bilinear form uses:

```text
G_t(p, q) = integral (mu0 * Ms / gamma0) * eta dot (m0 x xi) dV
```

where `xi = T p` and `eta = T q`. A form using `Ms / gamma0` is valid only if
`K` has been defined as an effective-field form rather than an energy Hessian
in joules.

The artifact contract stores:

```text
omega_rad_s
frequency_hz = Re(omega) / (2 pi)
```

`line_width_hz` is meaningful only when the damping policy includes damping.
With the canonical `exp(i omega t)` convention, a decaying damped mode has:

```text
omega_complex = omega_r + i Gamma
exp(i omega_complex t) = exp(i omega_r t - Gamma t)
Gamma > 0
damping_rate_hz = Gamma / (2 pi)
linewidth_fwhm_hz = Gamma / pi
```

Any path using `exp(-i omega t)` must state that convention in the manifest and
must invert the corresponding signs consistently for LLG, absorption, Floquet
metadata, and linewidth.

## Tangent basis

For every magnetic degree of freedom `i`, choose an orthonormal local frame:

```text
(u_i, v_i, m0_i)
```

and represent perturbations as:

```text
delta_m_i = q_{2i} * u_i + q_{2i+1} * v_i
```

Production frequency-domain paths must not solve unconstrained three-component
eigenvectors as the final physical operator. A full three-component
representation is allowed only for debug export, temporary materialization, or
visual reconstruction from the tangent solution.

For non-uniform equilibria, tangent-frame variation is part of the operator
contract. A production FEM operator may interpolate reconstructed vector
fields `delta_m = T q`, or it may assemble directly in tangent coordinates, but
the chosen implementation must match the full-vector weak form. Promotion
requires a derivative/projection test on a non-uniform `m0` texture such as a
domain wall, vortex, or skyrmion.

The Zeeman energy Hessian for a fixed external field is zero, but the
linearized dynamics still contains the restoring/precessional term from the
static effective field:

```text
-gamma0 * P_T(delta_m x H0)
```

or its equivalent in the selected `L`/`K` formulation. A frequency-domain
operator that includes only second energy derivatives and omits this term is
not a valid FMR operator.

## Static equilibrium requirement

The input equilibrium should satisfy:

```text
m0 x H0 ~= 0
```

The diagnostics artifact must expose at least:

- maximum `|m0 x H0|`,
- maximum `||m0| - 1|`,
- residual norms for exported modes when available.

If the equilibrium is not sufficiently static for the selected study, the
planner or runner should emit a capability diagnostic or reject the study
instead of silently exporting misleading eigenfrequencies.

## Driven-response residual stop policy

Production driven-response solvers must report both tracked Krylov residuals
and recomputed true residuals when available. A tracked GMRES residual alone is
not enough to publish convergence.

For long production GMRES runs, Fullmag applies the v5 stagnation guard:

```text
if relres_256 / relres_0 > 0.9 and relres_256 > 1e-2:
    status = solve_error
    stop_reason = stagnated
```

This guard is a runtime safety policy, not a physics tolerance. It prevents
large periodic-airbox or Schur-reduced workloads from consuming the full
8192-iteration budget after early residual evidence already shows no useful
contraction. A stagnated result is an invalid frequency-response solve and must
not be promoted to a solved production point.

## Boundary conditions

Periodic and Floquet studies use the convention in
`docs/physics/0710-periodic-and-floquet-boundary-conditions.md`.

For a nonzero-k Floquet FEM study, every selected periodic pair must be enforced
inside the active operator. Backends that do not enforce the selected pair set
must reject the study.
If explicit Floquet pair metadata contains both translation and phase, the
runtime validates `phase_rad = -k dot translation (mod 2*pi)` before the current
unsupported solve path. A mismatch is a metadata validation error.

The native FEM production CPU driven-response lane can include dynamic
demagnetization for legal k=0/open or gamma-equivalent requests by supplying the
linearized operator with a backend demag-tangent provider `delta_H_demag[delta_m]`.
This is a matrix-free magnetic tangent operator, not a full nonzero-k
Bloch/Floquet demag-k operator. The `periodic_airbox_k0` CPU slice additionally
uses the same provider with scalar-potential diagnostics for the shared-domain
airbox path.

The native FEM production GPU driven-response lane currently enforces the
gamma-point/free-boundary magnetic slice and the k=0 static-periodic magnetic
slice. It supports exchange, Zeeman, uniform uniaxial anisotropy, and uniform
or nodal Gilbert damping through a CUDA tangent operator; ordinary k=0 dynamic
demag is supplied by the backend demag-tangent provider and is therefore a
hybrid GPU/operator-provider path, not a fully device-resident GPU Poisson
operator. Static-periodic response requires complete
`mesh.periodic_node_pairs` and boundary-pair translation/tolerance metadata and
publishes static-periodic diagnostics. A development GPU slice also accepts
nonzero-k Floquet metadata only for a no-demag projected response with local
terms and a supplied exchange-edge tangent operator; DMI, nonzero-k dynamic
demag, magnetostatic periodic constraints, and full periodic exchange-graph
assembly remain outside this slice. The high-level planner may reach this slice
only for explicit GPU, magnetic-body, no-demag/no-DMI requests with complete
periodic pair metadata. The runner treats `FrequencyExcitationIR.field_au_per_m` as the
reference-cell drive amplitude and applies `phase_rad=-k dot translation` to
paired tangent-drive DOFs before the native solve. The implementation projects
the complex real/imaginary response block onto the supplied Floquet pair phase
relations and reports `floquet_phase_projection=true`. This is not a full
Bloch-reduced production operator. Nonzero-k Floquet/Bloch response with
dynamic demag, DMI, periodic Poisson, full mesh-periodic exchange reduction, or
magnetoelastic
coupling must fail with explicit capability diagnostics on the GPU lane; it
must not be rerouted through dense validation or CPU response.

## Demagnetization policy

Dynamic demagnetization at `k = 0` can be included by the current native FEM CPU
driven-response operator through a matrix-free backend demag-tangent provider.
Nonzero-k dynamic demagnetization for Floquet FEM is not implemented. Requests
with nonzero-k Floquet and demag enabled must fail with a capability error until
a mathematically valid dynamic demag-k operator exists.

The public `magnetostatic_bc` value for the future nonzero-k FEM path is
`floquet_airbox`. It is distinct from `periodic_airbox_k0`:

- `periodic_airbox_k0` means zero-phase periodic magnetization and zero-phase
  scalar-potential constraints for the shared-domain airbox;
- `floquet_airbox` means Bloch/Floquet phase constraints for the dynamic
  magnetic perturbation `delta_m` and the dynamic magnetostatic scalar
  potential `delta_phi` on the selected in-plane periodic cuts.

`floquet_airbox` is therefore a physics model request, not a backend hint. Until
the coupled demag-k operator is implemented and validated, a request with
`magnetostatic_bc="floquet_airbox"` must preserve the requested intent in IR and
provenance, then fail explicitly with a capability error. It must not be
rewritten to `periodic_airbox_k0`, `open`, dense validation fallback, or a CPU
Poisson solve.

The dynamic scalar potential sign convention is:

```text
delta_H_demag = -grad(delta_phi)
div(grad(delta_phi)) = div(Ms * delta_m)
div(-grad(delta_phi)) = -div(Ms * delta_m)
```

Any weak form may multiply both sides by `-1`, but artifacts and tests must
preserve the physical relation `delta_H_demag = -grad(delta_phi)`. Required
validation includes a demag energy sign check, an ellipsoid or equivalent
field-sign oracle, and symmetry of the k=0 demag Hessian.

## Poisson-airbox `k=0` modal eigensolve implementation

The active implementation contract for full-coupled Poisson-airbox `k=0`
modal eigensolve is:

`docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md`.

The native SLEPc selected-spectrum adapter exists. Its current real-scalar
real-axis target is not the required `sigma=i omega_target` transformation, and
real shared-domain MFEM Poisson-airbox modal assembly remains open. The PA-E1
synthetic dense payload remains an algebra-validation oracle only; plan 18 is
supporting implementation history, not authority to promote the capability.

If the response unknown is dimensionless `delta_m`, response observables must
include `Ms` where required by SI units:

```text
delta_M = Ms * delta_m
chi = delta_M / h_drive
observable_name = absorbed_by_magnetization
p_abs = - 0.5 * mu0 * Ms * omega * Im(conj(h_drive) dot delta_m)
P_abs = integral p_abs dV
```

This is the absorbed power delivered to the magnetization for the
`exp(+i omega t)` convention and interaction energy `-mu0 M dot H_drive`. The
production convention must pass the gate that positive Gilbert damping gives
positive absorbed power near resonance. A value
`delta_m / h_drive` is not dimensionless susceptibility; it has units `m/A`
and must be labeled as such if exported.

FDM time-domain periodicity is axis-wise. CPU reference and CUDA FDM support
periodic exchange wrapping, and truncated-image periodic demagnetization where
the plan supplies periodic axes and image counts.

## Validation

The minimal validation set for this contract is:

- phase convention roundtrip in IR,
- macrospin undamped check `omega = gamma0 * H0`,
- modal/eigen k=0 bias-field sweep for a uniform state must match either the
  macrospin Larmor law or the in-plane thin-film Kittel formula declared in the
  run metadata before larger periodic-airbox modal cases can be used as
  production evidence,
- macrospin damping sign and linewidth mapping for `exp(i omega t)`,
- absorbed power positive near resonance for positive Gilbert damping,
- susceptibility scaling and units with `Ms`,
- dynamic Poisson sign check through `H = -grad(phi)`,
- periodic pair validation and duplicate-node rejection,
- explicit Floquet phase consistency validation against `-k dot translation`,
- periodic/Floquet rejection when pair constraints are not enforced,
- `Floquet(k=0) == Periodic`,
- exchange-only reciprocal dispersion `f(k) = f(-k)` when DMI and other
  nonreciprocal terms are disabled,
- exchange-only Floquet modal dispersion must match the analytic effective-field
  scale `H_ex(k) = 2 A k^2 / (mu0 Ms)` within the stated mesh-discretization
  tolerance,
- production-facing spin-wave dispersion validation must include narrow,
  physically typical one-dimensional sweeps rather than only broad or
  all-direction k-space scans: Damon-Eshbach geometry with in-plane `k`
  perpendicular to the equilibrium magnetization, backward-volume geometry with
  in-plane `k` parallel to the equilibrium magnetization, `|k| <= 2e6..3e6
  rad/m` (`2..3 1/um`), and requested modal/frequency windows no wider than the
  relevant low-GHz band such as `0..5 GHz`; those sweeps must be compared with
  the applicable analytic dispersion for the documented material, film
  thickness, bias field, demag model, and boundary assumptions,
- default regression tests should therefore parameterize the DE and BV
  geometries separately and sample only the narrow low-k interval needed for the
  analytic comparison; exhaustive all-direction k-space maps are optional stress
  or exploration tests, not the normal publication acceptance route,
- explicit capability error for nonzero-k Floquet demag that distinguishes
  "missing `magnetostatic_bc=floquet_airbox`" from "`floquet_airbox` requested
  but demag-k operator not implemented",
- V2 artifacts containing `path_s`, `k`, `branch_id`, and residual diagnostics.
