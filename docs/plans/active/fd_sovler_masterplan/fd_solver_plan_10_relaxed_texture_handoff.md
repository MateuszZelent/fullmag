# Frequency-driven solver — relaxed nonlinear texture handoff

Status: **COMSOL-aligned v3 addendum**  
Scope: transfer of a relaxed nonlinear magnetic texture, e.g. skyrmion/domain wall/antidot equilibrium, from relaxation/static demag into modal and driven frequency-domain solvers.

---

## 1. Decision

The frequency-domain solver must **not** build its own hidden equilibrium state. It must consume an explicitly accepted and versioned `EquilibriumArtifact` produced by a relaxation/static-demag stage.

The canonical workflow is:

```text
mesh/material/physics/BC
  -> relaxation/static demag solve
  -> accepted equilibrium artifact
  -> linearization state builder
  -> tangent/cartesian equivalence gates
  -> frequency solve planner
  -> backend solve
```

For nonlinear textures such as skyrmions, the relaxed field is not an optional initial guess. It is the **linearization point**:

```text
m(r,t) = m0(r) + delta_m(r) exp(+i omega t)
```

where `m0(r)` is the relaxed texture and `delta_m` is constrained by:

```text
m0(r) · delta_m(r) = 0
```

Any frequency-domain response or eigenfrequency result is physically meaningful only for the exact `m0`, static fields, material snapshot, boundary conditions, demag model, mesh and periodic-pair mapping used to construct the linearized operator.

---

## 2. Physics contract after relaxation

### 2.1. Inputs from relaxation

The frequency-domain stage consumes:

```text
m0_unit(r)                relaxed unit magnetization
H_demag0(r)               static demagnetizing field, if demag enabled
phi_demag0(r)             static scalar potential, if airbox Poisson is used
h_ext0(r)                 static external/bias field
material_snapshot(r)      Ms, alpha, A, K, D, anisotropy axes, region IDs
physics_terms             exchange/aniso/Zeeman/DMI/demag/STT/EASA flags
mesh_snapshot             magnetic mesh, airbox mesh, FE spaces, node ordering
periodic_pairs            magnetic and airbox pair maps, translations, orientations
relaxation_diagnostics    torque residual, energy trend, unit norm, seam residuals
```

The frequency-domain solver may recompute some static fields from `m0`, but the artifact must still record whether the consumed static field was:

```text
stored_from_relaxation
recomputed_for_frequency
recomputed_and_compared_to_relaxation
```

### 2.2. Linearized LLG around nonuniform texture

The physical equation is:

```text
i omega delta_m
  = - gamma m0 x delta_h_eff
    - gamma delta_m x h_eff0
    + i omega alpha m0 x delta_m
    + linearized source terms
```

where:

```text
h_eff0 = h_exchange0 + h_anisotropy0 + h_ext0 + h_DMI0 + h_demag0 + ...
delta_h_eff = delta_h_exchange[delta_m]
            + delta_h_anisotropy[delta_m]
            + delta_h_drive
            + delta_h_DMI[delta_m]
            + delta_h_demag[delta_m]
            + ...
```

For a skyrmion or any noncollinear equilibrium, `m0`, `h_eff0`, tangent frames and projected operator blocks vary spatially. The solver must never assume a global transverse plane.

### 2.3. Equilibrium quality gate

The artifact is usable for frequency-domain analysis only if:

```text
max_i ||m0_i|| - 1                      <= tolerance
max_i ||m0_i x h_eff0_i|| / scale       <= tolerance
energy trend near final relaxation      is stable
static demag seam residual              <= tolerance, if PBC/airbox enabled
magnetization seam residual             <= tolerance, if PBC enabled
material/BC periodic compatibility      passes
```

The frequency-domain stage must reject a short smoke relaxation artifact unless it carries an explicit `accepted_for_linearization=true` flag and the required diagnostics.

---

## 3. Artifact contract

### 3.1. EquilibriumArtifact schema

Minimum schema:

```json
{
  "schema_version": "frequency_domain_equilibrium.v1",
  "accepted_for_linearization": true,
  "equilibrium_id": "sha256:...",
  "mesh_snapshot_id": "sha256:...",
  "magnetic_mesh_id": "sha256:...",
  "airbox_mesh_id": "sha256:...",
  "material_snapshot_id": "sha256:...",
  "physics_snapshot_id": "sha256:...",
  "boundary_snapshot_id": "sha256:...",
  "demag_model": "periodic_airbox_k0",
  "phase_convention_for_frequency": "exp_plus_i_omega_t",
  "fields": {
    "m0_unit": "fields/m0_unit.zarr",
    "h_eff0_a_per_m": "fields/h_eff0.zarr",
    "h_demag0_a_per_m": "fields/h_demag0.zarr",
    "phi_demag0": "fields/phi_demag0.zarr"
  },
  "periodic_pairs": {
    "magnetic": "mesh/periodic_pairs.v1.json",
    "airbox_scalar_potential": "mesh/airbox_periodic_pairs.v1.json"
  },
  "diagnostics": {
    "max_m0_norm_error": 0.0,
    "max_relative_torque_residual": 0.0,
    "max_magnetic_seam_mismatch": 0.0,
    "max_static_demag_seam_mismatch": 0.0,
    "primitive_supercell_parity": "accepted"
  }
}
```

The solver must store and compare all IDs. If any relevant ID changes, the frequency-domain plan must invalidate the artifact.

### 3.2. Required field layouts

`m0_unit`:

```text
node_count magnetic nodes
components x,y,z
unitless
same node order as magnetic mesh snapshot
```

`h_eff0_a_per_m`:

```text
node_count magnetic nodes
components x,y,z
A/m
contains all static effective field terms included in the linearized operator
```

`h_demag0_a_per_m`:

```text
node_count magnetic nodes, and optionally airbox nodes
components x,y,z
A/m
static demag field used in h_eff0
```

`phi_demag0`:

```text
airbox scalar-potential FE nodes
units documented by demag backend
same gauge policy as the static demag solve
```

---

## 4. LinearizationState builder

### 4.1. Builder responsibilities

The builder turns a relaxation artifact into native data used by frequency-domain backends:

```text
EquilibriumArtifact
  -> verified mesh/material/BC snapshot
  -> m0 normalization check
  -> h_eff0 recompute/verify
  -> tangent frame construction
  -> periodic frame transport
  -> operator descriptors
  -> drive projection
  -> solver planner input
```

### 4.2. C++ skeleton

```cpp
struct EquilibriumArtifactDescriptor {
    const char* equilibrium_id;
    const char* mesh_snapshot_id;
    const char* magnetic_mesh_id;
    const char* airbox_mesh_id;
    const char* material_snapshot_id;
    const char* physics_snapshot_id;
    const char* boundary_snapshot_id;

    const double* m0_xyz;       // length = 3 * magnetic_node_count
    const double* h_eff0_xyz;   // optional but preferred
    const double* h_demag0_xyz; // optional if demag disabled
    const double* phi0;         // optional scalar potential on airbox mesh

    uint64_t magnetic_node_count;
    uint64_t airbox_node_count;
    bool accepted_for_linearization;
    const char* demag_model;
};

struct LinearizationBuildOptions {
    double m0_norm_tolerance = 1.0e-10;
    double equilibrium_torque_relative_tolerance = 1.0e-6;
    double periodic_seam_tolerance = 1.0e-8;
    bool allow_m0_renormalization = true;
    bool require_static_demag_if_enabled = true;
    bool require_symmetric_periodic_mesh = true;
    bool recompute_h_eff0_and_compare = true;
};

struct LinearizationStateNative {
    uint64_t node_count;
    std::vector<TangentFrameNode> tangent_frames;
    std::vector<double> m0_xyz;
    std::vector<double> h_eff0_xyz;
    std::vector<double> h_demag0_xyz;
    std::vector<double> tangent_lumped_mass;
    std::string equilibrium_id;
    std::string linearization_signature_hash;
};

FrequencyDomainStatus build_linearization_state_from_equilibrium(
    const EquilibriumArtifactDescriptor& artifact,
    const MeshSnapshot& mesh,
    const MaterialSnapshot& material,
    const BoundaryConditionSnapshot& boundary,
    const LinearizationBuildOptions& options,
    LinearizationStateNative& out_state,
    LinearizationDiagnostics& out_diagnostics) noexcept;
```

---

## 5. Tangent frames for nonlinear textures

### 5.1. Why this matters

For a collinear equilibrium, all nodes share approximately the same tangent plane. For a skyrmion, `m0` changes rapidly, so every node has its own tangent plane. The local unknown is:

```text
q_i = [u_i, v_i] in C^2
```

and:

```text
delta_m_i = e1_i u_i + e2_i v_i
```

A bad frame gauge can create artificial discontinuities across periodic seams or inside smooth textures.

### 5.2. Deterministic frame construction

Use a deterministic reference axis with fallback:

```cpp
inline TangentFrameNode make_tangent_frame_from_m0(
    const double m0[3],
    const double preferred_axis[3]) noexcept
{
    TangentFrameNode f{};
    f.m[0] = m0[0]; f.m[1] = m0[1]; f.m[2] = m0[2];

    double a[3] = {preferred_axis[0], preferred_axis[1], preferred_axis[2]};
    if (std::abs(dot3(a, f.m)) > 0.95) {
        a[0] = 1.0; a[1] = 0.0; a[2] = 0.0;
        if (std::abs(dot3(a, f.m)) > 0.95) {
            a[0] = 0.0; a[1] = 1.0; a[2] = 0.0;
        }
    }

    // e1 = normalized(a - (a.m)m)
    double e1[3] = {
        a[0] - dot3(a, f.m) * f.m[0],
        a[1] - dot3(a, f.m) * f.m[1],
        a[2] - dot3(a, f.m) * f.m[2]
    };
    normalize3(e1);

    double e2[3];
    cross3(f.m, e1, e2);
    normalize3(e2);

    f.e1[0] = e1[0]; f.e1[1] = e1[1]; f.e1[2] = e1[2];
    f.e2[0] = e2[0]; f.e2[1] = e2[1]; f.e2[2] = e2[2];
    return f;
}
```

For periodic meshes, this is not sufficient by itself. Paired boundary frames must be repaired or transported.

### 5.3. Periodic frame transport

For a zero-phase periodic unit cell:

```text
delta_m_dst = delta_m_src
```

With tangent bases:

```text
T_dst q_dst = T_src q_src
q_dst = T_dst^T T_src q_src
```

For Floquet/Bloch perturbations:

```text
delta_m_dst = exp(-i k · delta_r) delta_m_src
q_dst = exp(-i k · delta_r) (T_dst^T T_src) q_src
```

The periodic constraint is scalar-only **only when**:

```text
T_dst^T T_src ≈ I
```

Otherwise the backend must either enforce the full 2x2 transport matrix or reject the request.

### 5.4. Frame seam repair

For strict matched periodic meshes, the preferred approach for k=0 static periodic slices is:

```text
1. Build frames on source side.
2. Copy/transport source frame orientation to destination side when m0_dst ≈ m0_src.
3. Re-orthonormalize destination frame against m0_dst.
4. Record frame transport residual.
```

Diagnostics:

```json
{
  "periodic_frame_transport": {
    "max_TdstT_Tsrc_minus_I_frobenius": 2.0e-12,
    "max_m0_pair_mismatch": 4.0e-13,
    "transport_policy": "source_to_destination_reorthonormalized"
  }
}
```

---

## 6. Symmetric mesh contract

### 6.1. Strict v1 policy

For production PBC/Floquet frequency-domain FEM, v1 requires a **matched symmetric mesh** on periodic boundaries.

Required properties:

```text
same number of source/destination boundary nodes
bijective node pairing
x_dst = x_src + translation within tolerance
same FE order and boundary element topology
same material labels and region IDs across paired nodes/elements
same magnetic/airbox boundary classification
consistent normal orientation
no duplicate source or destination nodes
no missing seam vertices/edges/faces
```

If this is not true, v1 rejects PBC/Floquet frequency-domain solve. Future versions can add mortar/Nitsche/interpolation constraints, but not in the first production path.

### 6.2. Magnetic mesh and airbox mesh must both be compatible

For periodic-airbox demag, the symmetry requirement is not only magnetic:

```text
magnetic periodic pairs      required for m0 and delta_m
airbox scalar-potential pairs required for phi / demag Poisson
open-axis airbox labels       required for nonperiodic direction
```

For a thin-film unit cell with lateral PBC and open z:

```text
x/y periodic faces: matched pairs
z open faces: Robin/Dirichlet/open-airbox policy, not periodic pairs
```

### 6.3. MeshSymmetryCertificate

```cpp
struct MeshSymmetryCertificate {
    bool accepted;
    uint64_t source_node_count;
    uint64_t destination_node_count;
    uint64_t pair_count;
    double max_translation_residual_m;
    double max_material_mismatch;      // 0 for exact categorical match
    double max_m0_pair_mismatch;
    double max_frame_transport_error;
    double max_airbox_phi_pair_mismatch;
    const char* rejection_reason;
};
```

### 6.4. Runtime rejection examples

Reject with detailed reason:

```text
periodic_mesh_pair_count_mismatch
periodic_mesh_translation_residual_too_large
periodic_material_mismatch
periodic_airbox_pair_missing
periodic_tangent_frame_transport_unsupported
nonzero_k_dynamic_demag_unsupported
```

---

## 7. Static demag and airbox handoff

### 7.1. Static demag belongs to h_eff0

The relaxation/static stage computes:

```text
H_demag0 = -grad(phi0)
```

or equivalent demag field. This field enters `h_eff0`, hence the linearized term:

```text
- gamma delta_m x h_eff0
```

If `H_demag0` is omitted, the frequency operator is linearized around the wrong equilibrium.

### 7.2. Dynamic demag belongs to delta_h_eff

The frequency solve also needs the derivative:

```text
delta_m -> delta_H_demag[delta_m]
```

Representations:

```text
full coupled:
  [ A_mm(omega)  A_mphi ] [delta_m] = [b_m]
  [ A_phim       A_phiphi] [delta_phi] [b_phi]

Schur reduced:
  S(omega) delta_m = b_m - A_mphi A_phiphi^{-1} b_phi
```

The full coupled representation is the reference path. Schur is a certified fast path only.

### 7.3. Same airbox, same gauge, same pair map

The dynamic demag operator must use the same geometric and boundary-condition model as the static demag solve unless an explicit remap has been certified:

```text
same airbox mesh ID
same magnetic submesh ID
same periodic pair map
same open-axis treatment
same Poisson gauge/nullspace policy
same Ms scaling convention
```

---

## 8. Operator assembly around a skyrmion

### 8.1. Local terms

Local terms become nodewise tangent blocks depending on `m0_i` and material:

```text
Zeeman/static field:        T_i^T d[-gamma delta_m x h0] T_i
Anisotropy derivative:      T_i^T d[-gamma m x h_aniso] T_i
Damping/mass/gyrotropic:    T_i^T [m0_i x] T_i
```

### 8.2. Exchange/nonlocal terms

Exchange for a noncollinear texture is not a scalar-only global plane operator. Between nodes `i` and `j` the tangent block is conceptually:

```text
K_ij^tan = T_i^T K_ij^cart T_j
```

For strict production, edge operators should be able to represent full 2x2 tangent blocks, not only scalar stiffness. A scalar edge can still be used as a compact storage only if the apply function receives both endpoint frames and constructs the correct `T_i^T T_j` coupling.

### 8.3. Dynamic demag derivative

Dynamic demag should be tested as a Frechet derivative:

```text
D_demag[m0](delta_m) = H_demag[m0 + epsilon delta_m] - H_demag[m0]
                       ---------------------------------------------
                                      epsilon
```

for small problems or diagnostic fixtures.

---

## 9. API additions

### 9.1. Frequency response request references equilibrium

```cpp
struct FrequencyLinearizationInput {
    const char* equilibrium_artifact_uri;
    const char* equilibrium_id;
    const char* mesh_snapshot_id;
    const char* material_snapshot_id;
    const char* physics_snapshot_id;
    const char* boundary_snapshot_id;
    bool require_accepted_equilibrium;
    bool require_symmetric_periodic_mesh;
    bool require_static_demag_consistency;
};
```

### 9.2. Planner feature flags

```cpp
struct FrequencyProblemDescriptor {
    bool has_relaxed_texture;
    bool has_noncollinear_m0;
    bool has_periodic_pairs;
    bool has_symmetric_periodic_mesh_certificate;
    bool has_airbox;
    bool has_static_demag0;
    bool has_dynamic_demag_operator;
    bool has_full_coupled_demag_blocks;
    bool has_schur_certificate;
    uint64_t magnetic_node_count;
    uint64_t tangent_dof_count;
};
```

Planner rule:

```cpp
if (problem.has_periodic_pairs &&
    !problem.has_symmetric_periodic_mesh_certificate &&
    policy.strict_periodic_fem) {
    return reject("periodic_frequency_domain_requires_symmetric_mesh_certificate");
}

if (problem.has_airbox && !problem.has_static_demag0) {
    return reject("frequency_domain_airbox_requires_static_demag_equilibrium_field");
}
```

---

## 10. Validation gates

### 10.1. Equilibrium artifact gate

```text
verify_equilibrium_artifact_schema
verify_m0_unit_norm
verify_equilibrium_torque_residual
verify_material_physics_hash_match
verify_static_demag_available_if_required
verify_no_mesh_mutation_after_relaxation
```

### 10.2. Symmetric mesh gate

```text
verify_periodic_pair_bijection
verify_translation_residual
verify_boundary_element_topology_match
verify_material_periodic_match
verify_m0_periodic_seam_match
verify_airbox_periodic_pair_match
verify_open_axis_boundary_labels
```

### 10.3. Linearization gate

```text
verify_cartesian3_to_tangent2_lift_project_roundtrip
verify_m0_dot_delta_m_zero
verify_tangent_frame_periodic_transport
verify_drive_delta_h_projection_sign
verify_dense_cartesian_vs_dense_tangent
```

### 10.4. Demag gate

```text
verify_static_demag_sign
verify_static_demag_seam
verify_dynamic_demag_linearity
verify_full_coupled_vs_schur_residual_reconstruction
verify_primitive_vs_supercell_static_demag_parity
```

---

## 11. Implementation patch queue

### Patch R1 — documentation and schema only

- Add this document.
- Add `EquilibriumArtifact` and `FrequencyLinearizationInput` schemas to docs.
- Document symmetric mesh certificate.
- No behavior changes.

### Patch R2 — runner consumes accepted equilibrium artifact

- Frequency-response and modal stages must receive an `equilibrium_artifact_uri`.
- Reject periodic-airbox frequency solves without accepted static PBC equilibrium.
- Preserve legacy path only behind `allow_unaccepted_relaxation_smoke=true` for tests.

### Patch R3 — native LinearizationState builder

- Load `m0`, `h_eff0`, `h_demag0` and material snapshot.
- Build tangent frames.
- Emit tangent-frame diagnostics.
- Validate `m0 · delta_m` and `|m0|`.

### Patch R4 — symmetric mesh certificate

- Build magnetic periodic-pair certificate.
- Build airbox scalar-potential pair certificate.
- Enforce strict v1 matched mesh policy for periodic frequency-domain FEM.

### Patch R5 — full coupled demag reference path

- Build full coupled block operator using accepted equilibrium.
- Add tiny/dense full-vs-Schur oracle.
- Only then promote Schur-reduced path.

### Patch R6 — artifact export in physical coordinates

- Export `dmX/dmY/dmZ` as public fields.
- Export `u/v` tangent fields as internal provenance.
- Export `m0`, `m0_dot_delta_m`, tangent leakage, frame transport diagnostics.

---

## 12. Non-negotiable rule

A frequency-domain result for a nonlinear texture is valid only if it can answer:

```text
Which exact equilibrium was linearized?
Which exact mesh and periodic pair map were used?
Which static demag field and gauge were used?
How was Cartesian delta_m constrained/projected to tangent unknowns?
Was the periodic seam symmetric and frame-transported?
Was full coupled demag consistent with Schur, if Schur was used?
```

If any answer is missing, the backend may still be a diagnostic experiment, but it is not production.
