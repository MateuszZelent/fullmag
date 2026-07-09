# Real FEM Poisson-Airbox Modal Design

## Decision

The existing PA-E4b topology-shaped Kittel payload remains an internal dense/
ABI algebra oracle. It must never be selected for a physical K0-3 run, write
`production_periodic_airbox_claim=true`, or consume an analytical Kittel
frequency while building the modal operator.

The production candidate is a new shared-domain FEM assembly path. It consumes
the magnetic mesh, airbox mesh, material fields, accepted `LinearizationState`,
periodic certificate and outer-boundary policy, then produces the existing
`PoissonAirboxEigenBlockProblem` blocks. The CPU SLEPc adapter owns selected
spectrum solving; it does not invent physics blocks.

## Architecture

```text
accepted EquilibriumArtifact
  -> LinearizationState(m0, h_eff0, h_demag0, phi0, hashes)
  -> shared-domain modal block assembler
       -> P = K_phi + Robin(open faces) or reduced Dirichlet P
       -> C = int_Omega_m Ms Tq dot grad(psi)
       -> A_qphi from -grad(phi) in tangent LLG
       -> A_qq and B_qq from real magnetic FEM operators
  -> PoissonAirboxEigenBlockProblem
  -> Schur-reduced selected-spectrum CPU solve
  -> full descriptor reconstruction and blockwise certification
  -> K0-3 artifact verifier and convergence report
```

`P` and the gauge are coupled decisions. Robin with positive beta and
Dirichlet have `gauge_policy=none`; only pure Neumann receives a mean-zero
constraint. Fully periodic 3D k=0 remains rejected.

## Scope

This implementation is divided into independently testable parts:

1. Correct public physics/docs/artifact semantics and demote synthetic PA-E4b.
2. Correct sparse modal request validation, residual certification and real
   PETSc targeting semantics.
3. Add a real shared-domain P1 assembly boundary with manufactured tests. The
   first real assembly supports K0, alpha=0, uniform `Ms`, scalar P1 potential,
   x/y periodic plus open z Robin or Dirichlet.
4. Route the K0-3 fixture through that assembly, require a real accepted
   equilibrium and strict verifier thresholds.
5. Keep GPU and nonzero-k demag explicitly unavailable until equivalent
   operators and device-resident iterative machinery exist. Correct their
   labels now; do not turn a dense one-thread proof into a production claim.

## Error Handling

The planner/runner rejects, rather than falls back, when the shared-domain
payload lacks an accepted equilibrium, magnetic/airbox coverage, matching
periodic pair certificate, supported outer BC, or finite block residual.
The explicit reasons are part of artifacts and tests.

## Validation

- A manufactured Poisson solve verifies Robin and Dirichlet assembly and proves
  that only pure Neumann creates a gauge block.
- The synthetic PA-E1 oracle verifies descriptor signs independently of mesh
  assembly but cannot emit K0-3 production artifacts.
- K0-1 and K0-2 remain exact macrospin/FEM local-term gates.
- K0-3 requires x/y PBC, open z, a per-field accepted equilibrium, three mesh
  levels, independent z-padding study, full block residuals and a Kittel
  comparison performed solely by the verifier.
- SLEPc tests include a multi-mode interior target to detect a real-axis shift
  used for an imaginary-axis eigenvalue.
- GPU tests distinguish a one-shot device apply from persistent device Krylov.

## Non-goals of the first production candidate

- nonzero-k Floquet dynamic demag;
- device-resident GPU Krylov-Schur;
- arbitrary damping/nonuniform texture K0-3 qualification;
- a new public Python surface for solver internals.

Those remain explicit capability rejections until their own real operators and
validation suite exist.
