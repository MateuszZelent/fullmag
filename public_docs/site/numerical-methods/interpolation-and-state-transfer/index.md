---
title: Interpolation and State Transfer
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: FEM-to-FDM and FDM-to-FEM terminal pages, source maps, and source revision 88c7160080bc1e8519950df283d2dd02087cc3da
---

(public-docs-numerical-methods-interpolation-and-state-transfer-root)=
# Interpolation and cross-backend state transfer

:::{admonition} Transfer creates a new discrete state
:class: important

Cross-backend continuation evaluates one discrete magnetization representation on another mesh or
grid. It does not transfer interaction matrices, demagnetizing potentials, FFT kernels, solver
history, or discrete energy. All derived fields are rebuilt on the target backend, and a transfer
can introduce an energy/torque jump even when the magnetization looks visually unchanged.
:::

## Scope

Fullmag automatically selects a transfer when an accepted continuation artifact is consumed by a
stage with a different spatial representation:

- {doc}`fem-to-fdm`: evaluate the FEM field at target FDM cell centres;
- {doc}`fdm-to-fem`: evaluate the FDM field at target FEM interpolation points.

There is no separate public energy term or `transfer_*()` physical model. The requested backend
sequence is author intent; the realized interpolation, coverage, normalization, counters, and
artifact identities are runtime continuation metadata.

## Common coordinate contract

Before interpolation, source and target must agree on:

- SI length units;
- world coordinate frame and origin;
- geometry placement and transforms;
- magnetic-region identity;
- source field ordering and component convention;
- target sampling locations;
- periodic wrapping, if any;
- outside-domain and tolerance policy.

A numerically valid interpolation in the wrong frame is a silent geometry error. Provenance should
therefore store the source and target bounding boxes and geometry/mesh digests in addition to the
field arrays.

## FEM to FDM

Let a target FDM cell centre $\mathbf x_i$ lie in source simplex $T_i$. For a P1 source field,

```{math}
:label: eq-transfer-root-fem-to-fdm
\mathbf m_{\mathrm{FDM}}(\mathbf x_i)
=\sum_{a\in T_i}\lambda_a(\mathbf x_i)\mathbf m_a,
\qquad
\sum_{a\in T_i}\lambda_a=1,
```

where $\lambda_a$ are barycentric coordinates and $\mathbf m_a$ are source nodal values. For a
valid interior point of a nondegenerate simplex, $0\leq\lambda_a\leq1$ up to the declared geometric
tolerance.

The runtime must:

1. construct or reuse a point-location structure for the source FEM mesh;
2. locate each active target FDM cell centre;
3. evaluate the source field using the actual source element order supported by the transfer;
4. account for points outside the FEM magnetic domain;
5. normalize valid transferred magnetization vectors according to the continuation policy;
6. publish transfer counters and the new artifact digest.

The stable implementation owner is
`crates/fullmag-engine/src/fem_solution_transfer.rs` — `transfer_fem_field_to_grid`.

## FDM to FEM

For a target point $\mathbf x$, define fractional Cartesian coordinates
$(\xi,\eta,\zeta)\in[0,1]^3$ in the source interpolation cell. Trilinear weights are

```{math}
:label: eq-transfer-root-trilinear-weights
w_{abc}(\xi,\eta,\zeta)
=\left[a\xi+(1-a)(1-\xi)\right]
\left[b\eta+(1-b)(1-\eta)\right]
\left[c\zeta+(1-c)(1-\zeta)\right],
```

for $a,b,c\in\{0,1\}$, and

```{math}
:label: eq-transfer-root-fdm-to-fem
\mathbf m_{\mathrm{FEM}}(\mathbf x)
=\sum_{a,b,c\in\{0,1\}}
 w_{abc}(\mathbf x)\mathbf m_{abc},
\qquad
\sum_{a,b,c}w_{abc}=1.
```

The source is cell-centred, so the exact interpolation neighbourhood and boundary handling must use
the cell-centre coordinate convention rather than reinterpret values as grid vertices. Target
points outside the source coverage require an explicit error/fallback result; extrapolation and
nearest-neighbour sampling are different algorithms and cannot be silent substitutes.

The stable primitive is
`crates/fullmag-engine/src/fem_solution_transfer.rs` — `transfer_vector_field`.
Cross-backend routing is owned by
`crates/fullmag-cli/src/step_utils.rs` — `resample_continuation_if_cross_backend`.

## Unit-vector normalization

A convex interpolation of unit vectors generally has norm smaller than one. Fullmag's documented
continuation policy applies

```{math}
:label: eq-transfer-root-normalization
\mathbf m_i^{+}
=\frac{\widetilde{\mathbf m}_i}
{\lVert\widetilde{\mathbf m}_i\rVert_2}
\quad\text{for }\lVert\widetilde{\mathbf m}_i\rVert_2>0.
```

Normalization preserves the interpolated direction but not the vector average. It can strongly
amplify roundoff when nearly antiparallel source vectors cancel. Production telemetry should
include:

- minimum, maximum, and distribution of pre-normalization norms;
- number of exactly or nearly zero vectors;
- maximum normalization correction
  $|1-\lVert\widetilde{\mathbf m}_i\rVert_2|$;
- policy and threshold used for degenerate vectors.

Leaving a zero vector unchanged at an active magnetic target is not a physically valid normalized
magnetization. Such points must be counted and either fail the transfer or use an explicitly named
fallback with provenance.

## What interpolation preserves

For constant vector fields, both barycentric P1 and trilinear interpolation should reproduce the
constant exactly up to floating-point roundoff. Under smoothness and shape-regularity assumptions,
pointwise interpolation has the expected local approximation order of its basis. These theoretical
properties do **not** imply preservation of Fullmag's discrete energy.

The operation generally does not preserve:

- total exchange, DMI, anisotropy, or demagnetizing energy;
- volume-integrated magnetization;
- topological charge on a different stencil/mesh;
- maximum torque;
- divergence or flux constraints of auxiliary fields;
- an eigenmode's normalization or orthogonality;
- time-integrator or minimizer history.

A conservative $L^2$ projection would solve a mass-matrix problem and is a different algorithm from
the pointwise transfers documented here.

## Mask and domain mismatch

Let $\Omega_s$ and $\Omega_t$ denote source and target magnetic domains. Three cases must be
separated:

1. $\mathbf x\in\Omega_s\cap\Omega_t$: interpolate normally;
2. $\mathbf x\in\Omega_t\setminus\Omega_s$: target magnetic point has no source value;
3. $\mathbf x\in\Omega_s\setminus\Omega_t$: source value is intentionally discarded.

Case 2 cannot be repaired by normalization. It requires a declared initialization fallback or a
failed continuation. The build/runtime report should include counts and, preferably, spatial bounds
for all uncovered points.

Boundary tolerances deserve explicit units. A tolerance proportional to the global domain can be too
large for a nanometre-scale gap; a fixed absolute tolerance can be too small after coordinate
scaling. The resolved tolerance and mesh length scale belong to provenance.

## Transfer error metrics

### Direct reference error

For a known analytical field $\mathbf m_{\mathrm{ref}}$ sampled at target points,

```{math}
:label: eq-transfer-root-l2-error
\varepsilon_{L^2}
=\left(
\frac{\sum_iw_i
\lVert\mathbf m_i^{+}-\mathbf m_{\mathrm{ref}}(\mathbf x_i)\rVert_2^2}
{\sum_iw_i
\lVert\mathbf m_{\mathrm{ref}}(\mathbf x_i)\rVert_2^2}
\right)^{1/2},
```

where $w_i$ is a target cell volume or FEM quadrature/mass weight.

### Directional error

For normalized vectors,

```{math}
:label: eq-transfer-root-angular-error
\theta_i
=\arccos\!\left(
\operatorname{clip}
(\mathbf m_i^{+}\cdot\mathbf m_{\mathrm{ref},i},-1,1)
\right).
```

Report maximum and weighted RMS angle. This remains interpretable when vector-component errors are
small but physically localized.

### Round-trip error

A diagnostic round trip $A\rightarrow B\rightarrow A$ gives

```{math}
:label: eq-transfer-root-roundtrip
\varepsilon_{\mathrm{rt}}
=\frac{\lVert\mathcal T_{B\to A}
\mathcal T_{A\to B}\mathbf m_A-\mathbf m_A\rVert_W}
{\lVert\mathbf m_A\rVert_W}.
```

The round trip is not expected to be the identity, especially when the target is coarser or its
magnetic domain differs. It is nevertheless useful for detecting coordinate, ordering, mask, and
point-location defects.

## Continuation workflow

A safe cross-backend continuation is:

1. require a successfully accepted source stage and content-addressed source artifact;
2. validate source mesh/grid metadata and field length;
3. build the target discretization and content-address it;
4. execute the appropriate transfer with strict outside-domain accounting;
5. validate finite values and unit-vector norms;
6. rebuild every target interaction operator and auxiliary field;
7. compute target energy and torque **before** advancing;
8. optionally perform a short target-backend re-relaxation;
9. record the discontinuity between source and target observables;
10. start the target stage from the validated transferred artifact.

The first target energy is not expected to equal the source energy because the discrete functional
has changed. A large jump can still indicate inadequate resolution, domain mismatch, or transfer
failure and should be treated as a gate.

## Public authoring model

There is no independent transfer constructor. A normal ordered-stage workflow requests a backend
transition, and runtime continuation metadata records what happened. The essential provenance is:

| Category | Required fields |
|---|---|
| Source | backend/device, mesh/grid digest, geometry digest, field artifact digest, accepted stage ID |
| Target | backend/device, mesh/grid digest, geometry digest, target-point convention |
| Operation | direction, interpolation family, point-location method, coordinate units/frame |
| Coverage | requested, interpolated, outside, discarded, fallback, degenerate-vector counts |
| Normalization | policy, threshold, pre-norm statistics, correction statistics |
| Validation | finite-value status, target norm error, transfer error/round-trip cases |
| Scientific discontinuity | source and initial-target energy, torque, volume magnetization, optional topology metrics |

Requested backend intent and resolved source/target execution must not be collapsed into a single
“continued” flag.

## Realization matrix

| Direction/lane | Status | Meaning |
|---|---|---|
| FEM CPU source $\rightarrow$ FDM CPU target | source-backed | source topology point location and target cell-centre initialization |
| FEM source $\rightarrow$ FDM GPU target | partial/target-dependent | transfer artifact is validated before target device upload/execution |
| FDM CPU source $\rightarrow$ FEM CPU target | source-backed | Cartesian interpolation and target FEM initialization |
| FDM GPU source $\rightarrow$ FEM target | partial/source-artifact-dependent | GPU state must first be exported as a validated continuation artifact |

The interpolation is runtime continuation work. A target GPU label does not imply that point
location or interpolation itself executed on the GPU.

## Implementation mapping

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| FEM field evaluated on FDM grid | `crates/fullmag-engine/src/fem_solution_transfer.rs` | `transfer_fem_field_to_grid` |
| Vector-field interpolation primitive | `crates/fullmag-engine/src/fem_solution_transfer.rs` | `transfer_vector_field` |
| Direction selection and reporting | `crates/fullmag-cli/src/step_utils.rs` | `resample_continuation_if_cross_backend` |

## Validation programme

1. **Constant field:** exact preservation and zero normalization correction.
2. **Affine field in a simplex:** P1 FEM-to-FDM exactness before normalization.
3. **Trilinear polynomial:** FDM-to-FEM exactness at interior target points for the documented
   coordinate convention.
4. **Rigid coordinate transform:** source and target world-frame agreement.
5. **Boundary points:** deterministic element/cell ownership and tolerance behavior.
6. **Outside coverage:** exact counters and strict failure when no fallback is permitted.
7. **Antiparallel cancellation:** near-zero pre-normalization vector gate.
8. **Round trip:** convergence of the weighted error under coordinated source/target refinement.
9. **Physics restart:** finite target fields, energy, torque, and stable first accepted target step.
10. **CPU/GPU artifact parity:** identical transfer input artifact and target mesh/grid digest.

## Limitations

- The documented transfers are pointwise interpolation, not conservative projection.
- P1 FEM transfer does not reproduce arbitrary higher-order source fields exactly.
- FDM trilinear interpolation depends on the cell-centre convention and explicit boundary policy.
- Renormalization is nonlinear and changes averages and interpolation order near cancellation.
- Derived fields, scalar potentials, FFT spectra, operator caches, and solver histories are not
  transferable state.
- A visually smooth result can still have a large exchange-energy or topological error.
- Cross-backend continuation cannot establish physical equivalence of FDM and FEM discretizations.

## Scientific bibliography

1. S. C. Brenner and L. R. Scott, *The Mathematical Theory of Finite Element Methods*, 3rd ed.,
   Springer, 2008, [doi:10.1007/978-0-387-75934-0](https://doi.org/10.1007/978-0-387-75934-0).
2. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM Classics, 2002,
   [doi:10.1137/1.9780898719208](https://doi.org/10.1137/1.9780898719208).
3. R. Anderson et al., “MFEM: A modular finite element methods library,” *Computers & Mathematics
   with Applications* **81**, 42--74 (2021),
   [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).

```{toctree}
:maxdepth: 1

fem-to-fdm
fdm-to-fem
```
## Control Room crosswalk

This is a navigation page; use the terminal page named by the selected stage or solver. The category itself has no standalone editor. TODO: frontend support applies to numerical parameters without a matching control. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
