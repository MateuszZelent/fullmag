# ADR-0031: Two FEM representations for nonzero-k dispersion

- Status: accepted for implementation planning
- Date: 2026-09-12
- Scope: FEM frequency-domain magnetic modes, dynamic demagnetization and
  dispersion sampling
- Owners: Fullmag FEM frequency-domain backend

## Context

Fullmag already has a shared modal pencil, k-point and k-path authoring, a
phase convention, and a narrow K0/Floquet algebra path. Those pieces do not
constitute a complete nonzero-k dynamic demagnetization solver. A forced
frequency response and an eigenfrequency result are separate products, and a
finite isolated object does not acquire a Bloch wave vector merely because a
response was Fourier transformed.

Two geometries are required by the approved dispersion plan:

1. A periodic three-dimensional unit cell can contain a modulation of geometry,
   material or equilibrium inside the cell. Its full complex finite-element
   fields use ordinary spatial derivatives and complex phase constraints across
   paired faces.
2. A propagating waveguide can have an arbitrary finite cross-section while
   geometry, material and equilibrium are invariant along one axis. Its
   transverse envelope uses a shifted derivative and a modified Helmholtz
   magnetostatic problem.

Treating these as one operator would either apply the Bloch wave vector twice
or silently assume translational invariance that is not present. Reusing the
K0 shared-domain operator at nonzero k has the same defect.

The local Micromagnetics Module User's Guide is a useful presentation and
workflow reference. Its V2.13 document is a custom Physics Builder module
loaded through a jar, and its Frequency Domain and Eigenfrequency interfaces
are distinct. Pages 27--28 of the 71-page repository copy show Floquet phase
conditions; pages 40--43 show dynamic magnetization coupled to a second
magnetic-fields interface. These observations do not establish a native
standard COMSOL LLG implementation. TetraX is a primary reference for the
translationally invariant waveguide reduction, not for a general periodic
3D cell.

## Decision

### 1. One sign and unit convention

All Fullmag frequency-domain products use
$\exp(+\mathrm{i}\omega t-\mathrm{i}\mathbf k\cdot\mathbf r)$ and
$\lambda=\mathrm{i}\omega$. Wave vectors are in
$\mathrm{rad\,m^{-1}}$, magnetization fields in $\mathrm{A\,m^{-1}}$, scalar
potentials in $\mathrm{A}$, angular frequencies in
$\mathrm{rad\,s^{-1}}$, and published cyclic frequencies in Hz. The canonical
phase is
$p=\exp(-\mathrm{i}\mathbf k\cdot\Delta\mathbf r)$.

The sign convention is encoded once in PhaseConventionIR and shared by
Python, IR, runner, native FEM and artifacts. TetraX or an external solver
may use a different time convention; an adapter must convert it explicitly.

### 2. Full 3D Bloch fields use ordinary gradients and C(k)

The full-cell representation writes
$\widetilde{\mathbf m}_{n\mathbf k}=
\mathbf u_{n\mathbf k}\exp(-\mathrm{i}\mathbf k\cdot\mathbf r)$ with periodic
$\mathbf u_{n\mathbf k}$. It applies ordinary $\nabla$ to the full complex
phasor and imposes the phase through a complex constraint/prolongation
$C(\mathbf k)$. A matrix-free magnetic action may be reduced as
$C(\mathbf k)^\mathsf{H}A C(\mathbf k)$.

The magnetic constraint transports the physical tangent frame:
$T_{\mathrm{dst}}q_{\mathrm{dst}}=
pQ T_{\mathrm{src}}q_{\mathrm{src}}$. For pure translations $Q=I$. The
current native layout is interleaved local coefficients
$q[2\,\mathrm{node}+\mathrm{component}]$; a future representation must retain
that layout or document a verified conversion.

The scalar potential is a full complex airbox field with the same phase. When
dynamic demagnetization is requested, the full magnetic and air domains are
coupled through
\[
\nabla^2\widetilde\phi=\nabla\cdot\widetilde{\mathbf M}
\quad\text{in }\Omega_m,\qquad
\nabla^2\widetilde\phi=0\quad\text{in }\Omega_a,\qquad
\widetilde{\mathbf h}_d=-\nabla\widetilde\phi.
\]
The ordinary-gradient weak form and opposite-normal flux condition are part of
the same seam and airbox contract. A scalar gauge is conditional: add it only
when the assembled scalar block has an actual constant nullspace.

The full 3D path must not also apply a shifted derivative
$\nabla_\perp-\mathrm{i}k\hat{\mathbf z}$.

### 3. Waveguide envelopes use D(k) and no longitudinal C(k)

The 2.5D representation is legal only after a topology and field certificate
proves invariance along a selected axis $\hat{\mathbf z}$. Its 2D transverse
unknown satisfies
\[
D_{\mathbf k}=\nabla_\perp-\mathrm{i}k\hat{\mathbf z},\qquad
(\nabla_\perp^2-k^2)\phi
=\nabla_\perp\cdot\delta\mathbf M_\perp-\mathrm{i}k\delta M_z,
\]
with $\mathbf h_{d,\perp}=-\nabla_\perp\phi$ and
$h_{d,z}=\mathrm{i}k\phi$. There are no longitudinal periodic face pairs and
therefore no longitudinal C(k). The norm is declared per unit waveguide
length. Its k-to-zero limit is a separately tested 2D operator limit.

The waveguide path is a separate owner from the full 3D path. A 3D periodic
cell cannot be routed to it as an optimization, and a waveguide cannot acquire
artificial seam constraints.

### 4. Modal, damping and tracking semantics are shared

At every sampled k, the constrained operator is rebuilt or applied with that k.
The result includes a complex mode field, normalization, phase convention,
sample identity, and original full descriptor residual after potential and
gauge reconstruction. The reduced residual is diagnostic only.

Lossless alpha=0 is the first selected-spectrum science lane. With Gilbert
damping or another nonconservative term the pencil is non-Hermitian:
published decay rate Gamma follows the canonical time convention. A damped
modal projection requires left/right information or an equivalent nonnormal
certificate.

Branch tracking uses a mass-weighted complex overlap and Hungarian assignment
for isolated modes. Near crossings it uses mass-weighted subspace principal
angles. Raw sample and mode IDs remain stable; tracking resolves a branch
identity and does not reindex the underlying samples. Existing rich output
selectors are interpreted as a union of mode selections intersected with the
requested sample set. A branch filter is resolved after tracking. The branch
table is optional output, while tracking remains mandatory internally.

### 5. Capability and provenance semantics

The requested representation, k sampling, magnetic boundary, magnetostatic
boundary, solver method, device, precision and damping policy remain distinct
from resolved execution. A forced GPU request cannot fall back to CPU. A
source-visible foundational operator cannot promote a runtime capability.

The S01 documentation state is:

| Solver | Device | State |
|---|---|---|
| FEM | CPU | source_visible / unvalidated; foundational constraint source is present, but no connected dynamic demag or managed physics qualification |
| FEM | GPU | source_visible / unvalidated; device operator, residency and parity are unqualified |
| FDM | CPU | separate owner; not introduced by this FEM decision |
| FDM | GPU | separate owner; not introduced by this FEM decision |

The existing K0 provider stays a distinct capability. Unsupported nonzero-k
demagnetization fails closed and retains its reason in provenance.

## Consequences

The backend has two explicit numerical contracts and two validation trees. The
full-cell path can support periodic holes and material modulation; the
waveguide path can support arbitrary cross-sections at lower dimensional cost.
Both publish the same modal artifact family and branch/sample vocabulary.

The split adds a topology certificate, complex seam handling, potential
continuity and flux checks to the full-cell path. It adds a translational
invariance certificate, per-length normalization, and a separate k-to-zero
check to the waveguide path. It prevents a convenient K0 or post-processing
substitution from looking like a physical dispersion result.

The first implementation may use the full-cell magnetic C(k) action without
dynamic demagnetization. That foundational algebra remains source-level until
it is compiled, connected to the native ABI, tested on a real FEM operator and
covered by managed runtime evidence.

## Implementation obligations

1. Keep the governing equations and symbol table in
   docs/physics/0828-fem-frequency-domain-floquet-demag.md. Keep the shared
   pencil, residual, damping and tracking contract in
   docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md.
2. Keep the two-representation decision and its migration boundary linked from
   docs/architecture/backend-golden-masterplan.md.
3. Reuse existing Python KPoint/KPath and k_sampling lowering. A new public
   waveguide or demag-k field requires a later ProblemIR decision and a
   round-trip test; S01 must not fabricate one.
4. The native full-cell foundation is owned under
   backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp
   and its implementation. FloquetTangentProlongation must expose initialize,
   prolong and restrict_adjoint with the phase and physical frame map.
   FloquetReducedMagneticOperator must expose MFEM Mult and MultTranspose for
   the C(k) adjoint action. Its current source status is uncompiled,
   unvalidated and disconnected from the solver ABI.
5. The complete S04 implementation must add dynamic scalar-potential unknowns
   or a validated equivalent provider, ordinary-gradient weak form, magnetic
   and airbox seam pairs, conditional gauge, original residual and
   open-boundary convergence. It must not apply C(k) and D(k) to the same
   field.
6. The S09 implementation must own the transverse modified Helmholtz operator,
   -i k Mz source, +i k phi field and per-length norms. It must reject axial
   non-invariance.
7. Artifacts must identify requested and resolved execution, representation,
   k sample, phase, mode normalization, damping, branch identity, residual
   blocks and validation scope.

## Validation and promotion

Promotion requires independent evidence for:

- complex phase and tangent-frame corner cycles, including k=0 parity;
- exchange-only k-squared dispersion and reciprocal plus/minus k;
- dynamic demagnetization sign, energy, continuity, flux and airbox padding;
- one-cell versus compatible explicit supercell;
- modal versus driven resonance with the original residual;
- waveguide cross-section convergence, TetraX comparison and k-to-zero limit;
- crossing/avoided-crossing tracking and nonreciprocity where the physics
  permits it;
- damping sign and complex linewidth;
- CPU/GPU device identity, residency, per-k parity and no fallback;
- Python, IR, artifact, API and UI round-trip.

COMSOL and TetraX numbers are external comparison data only after the exact
model, mesh, units, version, boundary policy and exported results are recorded.
The local COMSOL manual's standing-wave, Floquet and dynamic-demag pages
provide workflow fixtures; they do not replace these gates. The DMI boundary
condition caveat in the manual requires a Fullmag variational boundary test
before DMI is enabled.

## Migration and rollback

Until the relevant gate passes, the planner keeps the K0 path unchanged,
accepts only explicitly supported combinations, and returns an unavailable
diagnostic for nonzero-k dynamic demagnetization. The foundational full-cell
constraint may be disabled independently without changing K0 artifacts or
public phase semantics.

If a full-cell or waveguide implementation fails a gate, remove its capability
advertisement and preserve the source contract, diagnostics and test fixture.
Do not route the request to the other representation, to K0, or to a finite
isolated airbox. Re-enable only after the failed gate is rerun with a recorded
error budget.

## References

- Approved implementation plan:
  docs/superpowers/plans/2026-09-12-eigensolve-dispersion-nonzero-k-plan.md.
- Canonical physics notes:
  docs/physics/0828-fem-frequency-domain-floquet-demag.md and
  docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md.
- Local Micromagnetics Module User's Guide V2.13:
  docs/plans/active/fd_sovler_masterplan/MicromagneticsModuleUsersGuideV2.13.pdf,
  SHA-256 6c212ed2ee9580f2917118c58ed1caafec18488076a3e7bcb3eb15a64b5e49e1,
  PDF pages 21--28 for frequency-domain/Floquet theory and 40--43 for
  dynamic demagnetization. Independent 74-page copy:
  docs/comsol/Manual_for_Micromagnetics_Module.pdf,
  SHA-256 91f8f602d82bdec0a7b6c6947c1919e127c6d4f1a71c69819e328b7d54a06e2d.
- COMSOL custom module exchange:
  https://www.comsol.com/community/exchange/883/
- COMSOL weak-form dispersion paper:
  https://www.comsol.com/paper/download/181859/mruczkiewicz_abstract.pdf
- TetraX waveguide paper and documentation:
  https://arxiv.org/abs/2104.06943 and
  https://tetrax.readthedocs.io/en/latest/usage/experiments.html
