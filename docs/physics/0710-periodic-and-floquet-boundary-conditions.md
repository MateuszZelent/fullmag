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
`phase*(T_dst^T T_src)` modal transport for `Full2x2`. The current source also
contains a CPU shared-domain Floquet/airbox demagnetization assembly boundary,
but that bridge is not yet a managed or physics-qualified selected-spectrum
lane. It must remain explicitly labelled source-visible and cannot be promoted
to a production Floquet eigensolver or GPU capability without runtime,
residual, and convergence evidence.

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

Dynamic demagnetization for nonzero-k Floquet FEM is source-visible through the
CPU shared-domain `floquet_airbox` assembly boundary, but it is not yet
managed-runtime or physics-qualified. An explicitly planned CPU request may
reach this source path when its mesh, airbox, phase, and provider metadata pass
the execution guards; the resulting run remains unqualified until a managed
receipt and the residual/convergence evidence are present. Other lanes and
incomplete combinations with `include_demag=true` and
`spin_wave_bc.kind='floquet'` must fail closed with a capability diagnostic.

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


### Numerical Gamma classification in the FEM runner

The FEM planner and runner classify a finite wavevector as numerical Gamma when
all Cartesian components satisfy `abs(k_i) <= 1e-12 rad/m`. This is a routing
threshold, not an eigensolver residual or a field-phase validation tolerance.
The runner uses `GAMMA_K_TOLERANCE_RAD_PER_M` consistently in capability checks,
path routing and the real/complex reduction decision. Original sampled k values
remain in the output provenance. Non-finite components are never accepted as
Gamma. At this threshold, any physical comparison still uses the declared SI
wavevector and the independently validated boundary conditions.

## Contract index for this page

(problem-statement)=
Periodic and Floquet conditions constrain paired source and destination traces.
For a nonzero wave vector the phase belongs to the physical reconstructed
perturbation and must be transported through the local tangent frames before a
modal operator is assembled.

(governing-equations)=
```{math}
:label: eq-0710-phase
p(k)=\exp(-\mathrm{i}\,k\cdot\Delta\mathbf r).
```

```{math}
:label: eq-0710-tangent-transport
q_{\mathrm{dst}}=p(k)\,(T_{\mathrm{dst}}^\mathsf{T}T_{\mathrm{src}})q_{\mathrm{src}}.
```

```{math}
:label: eq-0710-gamma-classification
\max_i|k_i|\leq 10^{-12}\,\mathrm{rad\,m^{-1}}
\quad\Longrightarrow\quad \text{numerical Gamma routing}.
```

(symbols-and-si-units)=
| Token | Meaning | SI unit |
|---|---|---|
| $k$ | Bloch wave vector | $\mathrm{rad\,m^{-1}}$ |
| $\Delta\mathbf r$ | source-to-destination translation | $\mathrm{m}$ |
| $p$ | Floquet phase | $1$ |
| $q$ | tangent coefficients | $1$ |
| $T_{\mathrm{dst}}^\mathsf{T}T_{\mathrm{src}}$ | tangent transport | $1$ |

(assumptions-and-validity)=
Pair metadata must provide a unique source and destination map, a translation,
and a compatible equilibrium seam. The phase is checked modulo $2\pi$ against
the translation. Identity-frame transport is valid only when the certificate
proves matching frames; otherwise the full transport matrix is required.

(python-api)=
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `study.pbc(x, y, z)` | `tuple[bool, bool, bool]` | `(False, False, False)` | $1$ | boolean axes and matching pair metadata | periodic cell topology | FEM/FDM authoring; execution lane gated | `study.periodic_boundary_conditions.axes` |

```python
# %%
import fullmag as fm

study = fm.study("floquet_contract")
study.engine("fem")
study.pbc(x=True, y=True, z=False)
study.stages.add_eigenmodes(count=4, include_demag=True)
```

(problem-ir)=
The Python periodic declaration becomes axis metadata and pair identities in
the ProblemIR. A Floquet eigen or response request adds the sampled $k$ vector
and phase convention; the planner retains both the requested wave vector and
the resolved Gamma/non-Gamma routing decision.

(round-trip-and-failure-semantics)=
Round-trip serialization preserves requested intent and resolved execution,
including pair maps, translations, phase convention, and transport policy.
Validation errors reject duplicate mappings, seam mismatches, inconsistent
phase metadata, non-finite wave vectors, and missing operator enforcement.
Unsupported combinations fail with a capability error rather than changing
the request to open boundaries, K0 periodicity, or a CPU fallback.

(discrete-realization)=
FEM operators apply phase constraints to reconstructed tangent vectors and
publish pair residuals and mesh fingerprints. FDM uses axis-wise periodic
stencils and its own truncated-image demagnetization contract. These lanes
share metadata semantics but not a discretization or qualification result.

(implementation-mapping)=
The source index below covers public boundary objects, phase serialization,
k-path expansion, and the numerical Gamma threshold used by the FEM runner.

(validation)=
Acceptance requires phase round-trip tests, duplicate-node rejection,
translation residuals, static-field and demag seam checks, and
`Floquet(k=0) == Periodic`. Exchange-only reciprocal dispersion must satisfy
`f(k)=f(-k)` before a nonreciprocal interaction is enabled.

(limitations)=
The current snapshot exposes the CPU shared-domain `floquet_airbox` boundary
as source-visible but unqualified. GPU periodic demagnetization and full
nonzero-k coupled response remain gated. A numerical Gamma classification is a
routing policy and does not certify an open-boundary physical limit.

(scientific-bibliography)=
Kalinikos and Slavin, *Theory of dipole-exchange spin wave spectrum for
ferromagnetic films*, J. Phys. C 19 (1986), DOI:10.1088/0022-3719/19/35/7013.

(source-code-index)=
| Path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/study.py` | `class PeriodicBC` | Validate explicit periodic pair identities. |
| `packages/fullmag-py/src/fullmag/model/study.py` | `class FloquetBC` | Preserve the Floquet phase convention and pair identities. |
| `crates/fullmag-ir/src/eigen_contract.rs` | `PhaseConventionIR` | Serialize the canonical phase convention. |
| `crates/fullmag-runner/src/eigen/path.rs` | `expand_k_sampling` | Expand open and closed k paths deterministically. |
| `crates/fullmag-runner/src/fem/eigen_constants.rs` | `GAMMA_K_TOLERANCE_RAD_PER_M` | Define the numerical Gamma routing threshold. |
