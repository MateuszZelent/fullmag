# FEM K0 Dynamic-Demag Eigensolve: CPU and GPU Production Design

## Decision

Finish the FEM `Eigenmodes(include_demag=True)` K0 path as a physically
qualified shared-domain modal solver on both CPU and GPU. The first qualified
scope is P1, `alpha=0`, uniform material fields, an accepted equilibrium,
`k=(0,0,0)`, x/y periodicity, and an open-z magnetic-plus-airbox domain.

The implementation uses the canonical dynamic pencil
`L q = lambda B q`, `lambda = i omega`, with
`delta_m = T q` and dynamic demag determined by
`delta_H_demag = -grad(delta_phi)`. Static equilibrium demag remains part of
the accepted equilibrium only; it is never substituted for the Frechet action
on `delta_m`.

The existing synthetic algebra oracle and one-thread CUDA dense oracle remain
validation-only. They are not selected for a physical K0 run and cannot emit a
production claim.

## Architecture

```text
accepted EquilibriumArtifact
  -> LinearizationState(m0, H_eff0, H_demag0, phi0, provenance digests)
  -> shared-domain MFEM assembler
       -> Aqq, Aqphi, Aphi_q, P, Bqq
       -> BC/gauge certificate
  -> certified Schur operator
       -> phi(q) = -P^-1 Aphi_q q
       -> Leff q = lambda Bqq q
  -> CPU: SLEPc Krylov-Schur with sigma=i*omega_target
  -> GPU: persistent PETSc CUDA-vector / hypre-device / SLEPc operator context
  -> reconstruct phi and certify q, phi, and gauge residuals
  -> native mode fields plus artifact and capability evidence
```

CPU and GPU share equations, SI units, block residuals, request validation,
and provenance. They have separate workspaces and execution adapters. The
runner only forwards the canonical request and publishes native results; it
does not assemble modal matrices, fabricate eigenvectors, own PETSc/SLEPc
state, or downgrade a forced GPU request to CPU.

## Boundary and Gauge Policy

The scalar-potential block is assembled on the shared magnetic-plus-airbox
domain. For Robin boundaries it contains the open-boundary mass term; for
Dirichlet boundaries it eliminates essential potential DOFs. Both use
`gauge_policy=none`. Pure Neumann uses an explicitly augmented mean-zero
constraint. Fully 3D periodic K0, nonzero-k dynamic demag, and nonzero-k DMI
remain rejected.

Every accepted mode must satisfy the reconstructed original descriptor:

```text
r_q     = Aqq q + Aqphi phi - lambda Bqq q
r_phi   = Aphi_q q + P phi + c eta
r_gauge = c^T phi
epsilon_full = max(epsilon_q, epsilon_phi, epsilon_gauge)
```

Backend-reported residuals are diagnostic only and cannot replace this
certificate.

## Device Semantics

The managed runtime uses `libpetsc-real-dev` and `libslepc-real-dev`. It
therefore implements the ADR-017 real-split `real_frequency_rotated` pencil:
`R(L)y = omega R(i B_alpha)y`, with the interior target
`tau=omega_target`. A real `EPSSetTarget(omega_target)` on the original
`lambda=i omega` pencil is forbidden. GPU uses the same real-split contract
through PETSc CUDA vectors, a device-capable `MatShell` or `MatNest`, hypre
device preconditioning, and SLEPc. Its vectors, Krylov basis, operator
application, preconditioner state, and modal hot loop persist on the device.
Scalar checkpoints are permitted only when transfer telemetry records them;
per-iteration full-vector host/device copies are forbidden.

An explicitly requested GPU path fails with a precise unavailable reason when
the device stack or qualification certificates are absent. It never silently
falls back to CPU.

## Delivery Boundaries

1. Replace synthetic K0 production routing with a native real shared-domain
   MFEM block assembler and certified CPU selected-spectrum solve.
2. Move modal ownership out of runner-owned dense/reference assembly; remove
   fabricated mode-vector fallback from the production route.
3. Add the persistent GPU K0 modal implementation in a dedicated modal owner,
   not in the driven-response source, and publish residency/transfer evidence.
4. Promote capability only after the required managed physics, parity,
   convergence, and artifact gates pass.

## Validation

- Manufactured Robin, Dirichlet, and pure-Neumann Poisson cases verify weak
  assembly, sign, and gauge policy.
- Full-descriptor versus Schur parity verifies finite-mode extraction and all
  block residuals.
- K0-1 Larmor and K0-2 local stiffness remain independent local-term gates.
- K0-3 thin-film Kittel is a post-solve oracle: three mesh levels and an
  independent airbox-padding study must converge without inserting an
  analytical frequency or `M_eff` into the assembled operator.
- The selected-spectrum test uses modes at `+/- i omega_1` and
  `+/- i omega_2` and proves that an `i omega_2` target selects the correct
  pair.
- CPU/GPU parity uses identical assembled blocks and compares eigenvalues,
  modal overlap, reconstructed residuals, and artifact provenance.
- GPU qualification adds persistent-context, transfer-trace, restart,
  cancellation, and Compute Sanitizer coverage.
- Authoritative evidence is produced through the managed repository `just`
  recipes, never a host-only native build.

## Non-goals

- nonzero-k Floquet dynamic demag and DMI;
- fully 3D periodic K0 demag;
- damping or nonuniform-texture production qualification;
- a public API exposing PETSc, SLEPc, hypre, CUDA, or backend-only knobs.

## Acceptance Criteria

The feature is complete only when a real
`assembly_kind=mfem_weak_form_shared_domain` artifact is emitted for both CPU
and GPU K0 dynamic-demag runs; each mode carries native `q` and reconstructed
`phi`, all block residuals satisfy tolerance, forced GPU has no CPU fallback,
and fresh managed CPU/GPU physics, convergence, parity, and residency gates
pass. Capability, planner, provenance, and documentation then report the same
qualified scope.
