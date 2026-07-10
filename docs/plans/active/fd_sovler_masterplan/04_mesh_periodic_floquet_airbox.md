---
title: Frequency-driven solver - mesh symmetry, periodic, Floquet and airbox
version: target v6 contract over current v5 runtime
date: 2026-07-10
status: normative target; v6 runtime schema and consumers not yet implemented
---

# Mesh symmetry, periodic/Floquet and airbox contract

## 1. Authority and strict matched-mesh policy

This chapter consumes the nonzero-k phase and dynamic-demag semantics from
[physics note 0828](../../../physics/0828-fem-frequency-domain-floquet-demag.md)
and the K0 Poisson boundary/gauge semantics from
[physics note 0830](../../../physics/0830-fem-poisson-airbox-modal-eigen.md).

Target-v6 production FEM periodic/Floquet frequency-domain uses a matched
symmetric mesh and complete periodic equivalence classes. Nonmatching faces
require a separately named mortar/interpolation backend and are not accepted by
this contract. This chapter defines `periodic_mesh_certificate.v6`; it does not
claim that its schema or runtime consumers are implemented.

## 2. Complete periodic equivalence classes

A pair list is input evidence, not the canonical topology. The certificate
closes the transitive relation and stores one class for every periodic orbit:

```text
representative_dof
members[]
translation_from_representative[]
orientation_transform[]
material_region
boundary_role
```

`members`, translations, and orientation transforms have identical ordering.
The representative is included with zero translation and identity transform.
Magnetic classes cover the magnetic FE space. Scalar classes independently
cover the full shared magnetic-plus-airbox scalar FE space.

Corners and edges touched by more than one periodic face belong to one closed
class. The builder must merge all paths to the same member and verify identical
lattice translation and orientation transform within tolerance. It emits one
representative-to-member constraint per nonrepresentative member. Contradictory
duplicate constraints, path-dependent corner phases, incomplete side coverage,
or one DOF assigned to multiple representatives reject the certificate.

The target certificate contains at least:

```json
{
  "schema_version": "periodic_mesh_certificate.v6",
  "certificate_status": "accepted",
  "magnetic_class_count": 0,
  "magnetic_pair_count": 0,
  "scalar_class_count": 0,
  "scalar_pair_count": 0,
  "magnetic_equivalence_classes_sha256": "sha256:...",
  "scalar_equivalence_classes_sha256": "sha256:...",
  "translation_residual_max_m": 0.0,
  "orientation_residual_max": 0.0,
  "normal_mismatch_max": 0.0,
  "boundary_topology_match": true,
  "fe_order_match": true,
  "material_region_match": true,
  "corner_edge_cycle_unique": true,
  "m0_seam_mismatch_max": 0.0,
  "h_demag0_seam_mismatch_max": 0.0
}
```

For each space, `class_count` is the number of nontrivial closed classes and
`pair_count = sum(class.members.length - 1)`. Hash input is canonicalized by
representative, member, translation, orientation, material region, boundary
role, FE-space identity, and tolerance policy. Magnetic and scalar hashes are
separate and neither may stand in for the other. The certificate also records
input relation counts, unmatched counts, and topology/orientation/translation
residual tolerances in its provenance envelope.

## 3. Physical and tangent-coordinate transfer

For a source/destination relation, let `R_orient` be the physical vector
orientation transform, `R_lattice = r_dst - r_src` the lattice translation,
and `phase = exp(-i*k dot R_lattice)`. The Cartesian conditions are:

```text
delta_m_dst = phase R_orient delta_m_src
delta_phi_dst = phase delta_phi_src
```

With `delta_m = T q`, the magnetic transfer is exactly:

```text
G_pair = T_dst^T R_orient T_src
q_dst = exp(-i*k dot R_lattice) G_pair q_src
```

Phase-only scalar periodicity must not be imposed on tangent coordinates `q`
unless `G_pair` is certified as identity within tolerance.

### Tangent-frame gauge invariance

Let arbitrary independent local frame rotations be
`T'_src = T_src S_src` and `T'_dst = T_dst S_dst`, with
`S_src,S_dst in SO(2)`. Coordinates and transfer then transform as:

```text
q'_i = S_i^T q_i
G'_pair = S_dst^T G_pair S_src
q'_dst = phase G'_pair q'_src
```

The constrained operator must transform by the corresponding block-coordinate
similarity/congruence. Arbitrary SO(2) frame-gauge rotations must preserve the
eigenvalue set, original-operator residuals, and reconstructed Cartesian fields
`T'_i q'_i = T_i q_i` within declared tolerances. Testing only a globally
constant frame rotation is insufficient.

## 4. Exact K0 outer-boundary and gauge tuple

The scalar block accepts only these tuples:

```text
poisson_robin(beta>0) -> gauge_policy=none, no eta row
poisson_dirichlet     -> gauge_policy=none, eliminated boundary DOFs, no eta row
pure_neumann          -> gauge_policy=mean_zero_augmented, eta row present
```

For `pure_neumann`, the augmented rows are `P phi + c eta = rhs` and
`c^T phi = 0`. The mean functional `c` is assembled from the active scalar FE
space and its quadrature. It may contain zero weights for eliminated or
inactive entries. A global strictly positive weight rule is forbidden.

Lateral periodic constraints alone do not create a gauge nullspace. Robin and
Dirichlet open-boundary policies remain coercive after lateral K0 reduction and
must not receive an eta row or a mean-zero projection.

## 5. Primary nonzero-k operator representation

Matched-mesh complex constraints are the target-v6 primary representation for
both magnetic tangent unknowns and scalar potential:

```text
q_full = C_m(k) q_reduced
phi_full = C_phi(k) phi_reduced
C(k) = block_diag(C_m(k), C_phi(k))
A_reduced(k) = C(k)^H A_full C(k)
```

Every representative-to-member entry in both `C_m(k)` and `C_phi(k)` uses the
same `exp(-i*k dot R_lattice)` convention, where `R_lattice` is that member's
lattice translation from its representative. `C_m(k)` additionally applies
`G_pair`; `C_phi(k)` is phase-only. The same maps reduce every coupled operator
block, mass block, RHS, and residual reconstruction. Constraint application
occurs before solving and is part of the operator.

For a real split, the complex phase is represented by its exact 2x2 real block;
it is not dropped or approximated as a real periodic constraint.

An envelope backend using Bloch `grad_k`/`div_k` is legal only after automated
matrix parity on assembled fixtures and action parity on matrix-free fixtures
against the primary matched-constraint operator over the accepted k domain.
Parity includes magnetic/scalar coupling, signs, BC/gauge handling, residuals,
and reconstructed Cartesian fields. Passing at K0 alone is insufficient.

Applying phase to a solved K0 field, viewport payload, or exported mode is a
postsolve projection. Postsolve projection is not an operator and cannot
implement nonzero-k exchange, DMI, or dynamic demag.

## 6. Static and dynamic airbox requirements

```text
magnetic and scalar equivalence-class hashes are accepted
static equilibrium uses the matching mesh, boundary, and static-demag signatures
magnetic q and scalar phi use one exp(-i*k dot R_lattice) phase convention
corner/edge cycles are unique in both FE spaces
normal-flux checks account for opposite outward normals on paired faces
the exact outer-boundary/gauge tuple is recorded
```

Static `h_demag0`/`phi0` provenance belongs to `EquilibriumArtifact.v6`.
Dynamic `delta_phi` and `delta_H_demag` belong to the constrained coupled
operator. A K0 static Poisson solve, a magnetic-only phase constraint, or a
postsolve phase projection is not nonzero-k dynamic demag.

## 7. Current-v5 to target-v6 migration

| Current v5 | Target v6 | Migration rule |
|---|---|---|
| `periodic_mesh_certificate.v5` | `periodic_mesh_certificate.v6` | build and validate a new certificate; do not relabel v5 |
| magnetic/airbox pair maps | closed magnetic/scalar equivalence classes | compute transitive closure and reject contradictory paths |
| pair-map fingerprints and hashes | canonical class hashes per FE space | hash full classes, transforms, roles, regions, and policy |
| one aggregate `pair_count` | class and representative-pair counts per FE space | derive counts after corner/edge merging |
| stored pairwise 2x2 blocks | class-consistent `G_pair` transfers | validate every representative-to-member path |
| duplicate-pair rejection | corner/edge cycle uniqueness | reject duplicate representatives and path-dependent closure |
| gauge-policy presence check | exact BC/gauge/eta tuple | rebuild scalar block policy from boundary kind |
| pairwise phase metadata | `C_m(k)` and `C_phi(k)` operator constraints | assemble both maps with the same negative phase convention |
| no frame-gauge certificate | local SO(2) invariance evidence | rerun operator/eigenfield parity under independent frame rotations |

## 8. Production boundary

This file closes the target documentation contract only. Existing v5 pair-map
artifacts, candidate certificates, K0 providers, or planner checks do not prove
target-v6 equivalence-class construction, complex nonzero-k operator
constraints, frame-gauge invariance, or runtime consumption. Production status
may advance only after v6 schemas and consumers exist and the required CPU/GPU,
K0/nonzero-k, modal/driven validation scopes are separately evidenced.
