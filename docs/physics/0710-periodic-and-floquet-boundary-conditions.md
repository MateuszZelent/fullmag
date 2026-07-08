# Periodic and Floquet Boundary Conditions

## Convention

Fullmag uses SI units and stores Bloch wavevectors in `rad_per_m`.

For static periodic fields and zero-phase dynamic studies, paired boundary
nodes satisfy:

```text
m_dst = m_src
```

For frequency-domain Floquet studies, the dynamic perturbation satisfies:

```text
delta_m_dst = delta_m_src * exp(-i k dot delta_r)
delta_r = r_dst - r_src
```

The canonical phase convention identifier is:

```text
exp_minus_i_k_dot_delta_r
```

When an explicit Floquet pair carries both `translation` and `phase_rad`, the
runtime must validate the metadata before it reaches an operator:

```text
phase_rad ~= -k dot translation  (mod 2*pi)
```

Inconsistent phase metadata is a validation error, not a valid unsupported
Floquet solve request.

For tangent-space FEM unknowns, the boundary condition applies to the
reconstructed vector `delta_m`, not automatically to raw local coordinates
`q`. If `delta_m = T q` with orthonormal tangent frames `T_src` and `T_dst`,
then a paired node must satisfy:

```text
T_dst q_dst = exp(-i k dot delta_r) * T_src q_src
q_dst = exp(-i k dot delta_r) * (T_dst^T T_src) q_src
```

The shortcut `q_dst = phase * q_src` is valid only when the paired tangent
frames are identical within tolerance. Production operators must either enforce
the full tangent-frame transport or reject the case with a diagnostic. Runtime
artifacts must state:

```text
basis_transport_policy = full_vector | tangent_frame_transport | tangent_frame_identity | rejected
static_periodic_frame_max_mismatch
floquet_tangent_transport_max_nonunitarity
```

## Capability Policy

If a mesh declares `periodic_node_pairs` and the selected backend does not
enforce them in the active operator, the planner or runtime must reject the
study. A warning is not sufficient because it would produce physically invalid
results.

FEM static and time-domain paths support only the limited k=0 static-reduction
slice where the active native operator enforces `periodic_node_pairs`. Requests
outside that slice, including unsupported GPU periodic demag reductions, must
reject. FEM eigen supports periodic and Floquet phase reduction for exchange,
anisotropy, external field, and DMI terms. The reference/MVP modal path supports
scalar tangent reduction only for identity-frame pairs, and supports
nonzero-k `Full2x2` tangent blocks by reducing each complex stiffness and mass
contribution with the selected Bloch phase and the local tangent-frame
transport matrix `T_node^T T_root`. This implements the reference/MVP CPU
`phase*(T_dst^T T_src)` modal transport for `Full2x2`; it does not implement
dynamic Floquet demagnetization or a production selected-spectrum/GPU modal
Floquet eigensolver.

FEM driven frequency response is narrower still: the native production CPU lane
supports gamma/free response and k=0 static-periodic magnetic response without
dynamic demag. The native production GPU lane supports gamma/free response and
the k=0 static-periodic no-demag magnetic slice through its CUDA tangent
operator. It also has a narrowly gated no-demag Floquet development slice that
phase-projects the complex response block for supplied pair metadata with local
terms and a supplied exchange-edge tangent operator. The high-level driven
response planner may reach this slice only for explicitly requested GPU,
magnetic-body, no-demag/no-DMI requests with complete periodic boundary and node
pair metadata; the runner then treats `FrequencyExcitationIR.field_au_per_m` as
the reference-cell drive amplitude and applies the Bloch phase to paired
tangent-drive DOFs. Full periodic exchange graph assembly, DMI, dynamic demag,
and magnetostatic periodic constraints are still absent from that slice. Both
static-periodic lanes require complete periodic pair metadata for requested
`pair_ids`; full nonzero-k Floquet production response, shared-domain airbox
response, frequency-response demag, DMI on GPU, and GPU periodic demag remain
gated.

Dynamic demagnetization for nonzero-k Floquet FEM is not implemented. Requests
with `include_demag=true` and `spin_wave_bc.kind='floquet'` must fail with a
capability error.

The canonical magnetostatic boundary request for that future path is
`magnetostatic_bc="floquet_airbox"`. This value means the shared-domain airbox
uses the same Bloch phase convention for the dynamic scalar potential
`delta_phi` that the magnetic domain uses for `delta_m`:

```text
delta_phi_dst = delta_phi_src * exp(-i k dot delta_r)
```

It is not equivalent to `periodic_airbox_k0`, which is restricted to
zero-phase `k=0` constraints. A nonzero-k Floquet frequency-response request
with demag enabled but without `floquet_airbox` must be rejected as an
incomplete physical model request. A request that does use `floquet_airbox`
must still be rejected until the real demag-k coupled operator exists; the
rejection must preserve the requested boundary model in IR/provenance rather
than silently falling back to `open`, `periodic_airbox_k0`, CPU Poisson, or
dense validation.

FDM uses axis-wise periodicity. The CPU reference path supports periodic
exchange/DMI stencils and truncated-image periodic demagnetization. The CUDA FDM
path supports periodic exchange/DMI wrapping and consumes the same
truncated-image Newell spectra for periodic demag; the native backend receives
explicit FFT dimensions because periodic axes use `N` instead of `2N`.

## Mesh Metadata

`periodic_boundary_pairs.translation` is the authoritative source-to-destination
translation. If it is present, node pairs must satisfy:

```text
r_dst - r_src ~= translation
```

within the pair tolerance. Duplicate source or destination node mappings for the
same `pair_id` are invalid.

For frequency-domain linearization around an equilibrium texture, paired
magnetic nodes must also carry the same static direction `m0` within the mesh
certificate tolerance. A nonzero `m0` seam mismatch is a validation error with
reject reason `periodic_m0_seam_mismatch`; production operators must not
silently phase-project dynamic tangent variables across an inconsistent static
state.

When static demagnetization is part of the linearization handoff, paired
magnetic nodes must also pass the same-step `H_demag0` seam check in `A/m`.
The scalar-potential gauge is not inferred from smooth `phi` values: the
certificate must carry an explicit Poisson gauge policy such as `mean_zero`,
`pinned_dof`, `not_required`, or `provider_responsibility`.

Runtime artifacts expose the validated pair metadata as:

```text
mesh/periodic_pairs.v1.json
```

The v2 browser/API resource for the same contract is:

```text
/v2/sessions/current/meshing/mesh/periodic_pairs.v1
```

The payload uses `schema_version = "periodic_pairs.v1"` and includes each
`pair_id`, source/destination markers, expected translation, paired node count,
unpaired source/destination counts, residual diagnostics, and a validation
status. For frequency-domain tangent-space runs, it must also expose the
resolved basis transport policy and frame-transport residuals. The API prefers
the active FEM mesh snapshot and falls back to the artifact file after a
completed run.

The native frequency-domain mesh-symmetry certificate is a stricter
solver-adjacent contract with `schema_version =
"periodic_mesh_certificate.v5"`. The current certificate-level implementation
records deterministic, order-independent `fnv1a64:` fingerprints for the
magnetic and airbox pair maps so solver lanes can detect pair-map drift while
the data is still in native memory. Serialized long-lived artifacts should
still graduate to canonical `sha256:` hashes over the fully versioned pair-map
payload; the certificate fingerprint is not a substitute for that artifact
hash.

## Sign Test

For exchange-only dispersion without DMI or other nonreciprocal terms:

```text
f(k) = f(-k)
```

Tangent-frame transport must also pass:

```text
max_pair ||q_dst - phase * (T_dst^T T_src) q_src|| < eps_q
```

For identical periodic frames this residual should be zero within numerical
tolerance. For non-identical paired frames, production code must either use the
full transport matrix or reject the case; it must not silently assume identity
transport.

For `k = pi / L` and `delta_r = [L, 0, 0]`, the Floquet phase is:

```text
exp(-i pi) = -1
```
