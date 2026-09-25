# 0600. FEM Eigenmodes from Linearized LLG

Status: MVP public reference path  
Applies to: `StudyIR::Eigenmodes`, `BackendPlanIR::FemEigen`, CPU reference runner

This note covers the `modal_eigen` study product only. Driven harmonic solves
belong to the separate `driven_response` product and use `(i omega B - A) q = b`
rather than the modal generalized eigensystem `A q = lambda B q`.

The canonical backend-neutral `L`/`B_alpha`/`A_omega` dictionary, typed units,
eigenvalue mapping, residual rules, and truthful CPU/GPU lane names are frozen
in `0831-fem-dynamic-pencil-modal-response-and-krylov.md`. This note retains the
public reference workflow and must not redefine that contract.

## Scope

This note defines the first executable FEM eigenmode workflow in Fullmag.
It is intentionally narrower than the long-term MFEM/SLEPc target:

- equilibrium state `m0` is taken from the provided initial state, a saved artifact, or an internal overdamped relaxation pass,
- the eigenproblem is solved on the merged FEM magnetic mesh,
- the current executable path exports spectrum, mode fields, and V2 dispersion artifacts,
- the solver is CPU reference quality, not the final production eigensolver.

The production target for large geometries is not the dense reference solver.
Large FEM eigenmode studies must be formulated as sparse frequency-window
queries: for example, "return up to 20 modes in 100 MHz..5 GHz".  The public
authoring contract must therefore preserve both the requested mode count and
the requested frequency interval in SI units.  The backend may use a wider
internal search interval for robustness, but artifacts and provenance must
report the user-requested window and the resolved numerical search policy.

## Physical model

We linearize magnetization dynamics around an equilibrium state `m0(r)` with `|m0| = 1`:

`m(r, t) = m0(r) + dm(r, t)`

with the tangent-space constraint:

`m0 . dm = 0`

For the MVP, Fullmag constructs a local tangent basis `(e1, e2)` at each active FEM node and represents perturbations in that reduced basis. This avoids the non-physical radial component that would appear in an unconstrained `3N` formulation.

The executable reference path currently retains the following field contributions:

- exchange
- demag
- zeeman / external field
- uniaxial anisotropy (first- and second-order)
- cubic anisotropy (first-order)
- interfacial DMI
- bulk DMI
- surface anisotropy (boundary-face mass term)

Spin torques and Bloch-periodic complex operators remain future work.

## Operator variants

Two operator formulations are available (selected via `EigenOperatorIR`):

### Scalar projected operator (`LinearizedLlg`)

The default and historically first path. The perturbation at each node is
represented by a single scalar amplitude in a local e1 tangent direction.
This yields an `N × N` generalized eigenproblem and is accurate when the
equilibrium is approximately uniform.

### Full 2×2 Herring–Kittel block operator (`Full2x2`)

The full tangent-plane formulation. At each node the perturbation is
represented by two scalar amplitudes `(u1, u2)` in the `(e1, e2)` tangent
basis, yielding a `2N × 2N` generalized eigenproblem. This correctly
captures cross-coupling between tangent-plane components and is required
for non-uniform equilibria (vortices, skyrmions, domain walls).

See `docs/physics/0600-fem-eigenmodes.md` for the block-matrix equations.

## Discrete operator

The current dense/reference solver assembles:

- a consistent scalar mass matrix on the active FEM nodes,
- a projected scalar stiffness-like operator built from exchange plus the field component parallel to `m0`,
- a tangent-basis lift from reduced nodal amplitudes back to vector mode fields.

This is an MVP reference generalized eigenproblem:

`K u = lambda M u`

followed by a frequency mapping:

`omega = gamma * mu0 * max(lambda, 0)`

`f = omega / (2 pi)`

Fullmag's public `gamma` parameter is the internal LLG constant
`gamma0 = mu0 * gamma_SI` with units `rad s^-1 (A/m)^-1`, historically also
written as `m/(A s)`. Therefore frequency artifacts must report both constants:
`gamma0_rad_s_per_A_m = gamma0` and `gamma_rad_s_T = gamma0 / mu0`. The
frequency mapping above is equivalently `omega = gamma0 * max(lambda, 0)` when
`lambda` is an effective-field eigenvalue in `A/m`.

This real symmetric reference problem is not the production gyrotropic modal
contract for general frequency-domain FEM. It is valid only as a small
effective-field/reference lane for the explicitly documented MVP scope. The
production modal/eigenfrequency contract must use the tangent LLG convention
from `docs/physics/0700-frequency-domain-linearized-llg.md`:

```text
L q = lambda B_alpha q
lambda = i omega
```

or, for an energy-Hessian gyrotropic form with the canonical
`exp(i omega t)` phasor:

```text
K phi = -i omega G phi
G_t(p, q) = integral (mu0 * Ms / gamma0) * eta dot (m0 x xi) dV
```

The documentation must not promote a real pencil `K phi = omega G phi` unless
the operator has been explicitly transformed into a real Hamiltonian or
symplectic form and the transform, signs, norm, and eigenvalue-to-frequency
mapping are stated. Before SLEPc/shift-invert promotion, a 2-DOF macrospin test
without MFEM must prove:

- undamped sign and magnitude `omega = gamma0 * H0`,
- the positive-frequency branch,
- the conjugate partner,
- residual consistency for the selected pencil,
- damping sign and linewidth mapping when damping is included.

## Nonzero-k Floquet dynamic demag-k payload boundary

For a Bloch/Floquet modal problem with nonzero wavevector `k`, the tangent
operator is partitioned as

```text
K_total(k) = K_local_and_exchange(k) + K_demag(k).
```

`K_demag(k)` is the linear dynamic demagnetizing-field contribution evaluated
at the same Bloch wavevector and represented in the same real block form and
local tangent basis as `K_local_and_exchange(k)`. Its matrix entries therefore
carry the same operator units and sign convention as the supplied modal
stiffness matrix; it is added directly before solving
`K_total(k) phi = -i omega G phi`.

The narrow native CPU bridge may consume a caller-supplied dense
`dynamic_demag_k` tangent matrix only when all of the following are true:

- the request is `Full2x2`, nonzero-k, Floquet, and has accepted periodic-pair
  metadata;
- the matrix has exactly `tangent_dof_count^2` finite block-real values;
- the declared payload kind is `dynamic_demag_k_operator`;
- the base Bloch/Floquet stiffness and the demag matrix share the same tangent
  DOF ordering, phase convention `exp(i omega t)`, and periodic-pair map.

This is an explicit operator-input contract for native numerical validation.
It remains separate from the production shared-domain path. The current
sources also contain a native CPU shared-domain Floquet/airbox assembly for
constructing `K_demag(k)` from mesh and airbox data, together with the
real-frequency rotated SLEPc pencil. That implementation is selected only by
the strict planner prerequisites and is still distinct from a qualified
runtime result. Python and `ProblemIR` may express
`magnetostatic_bc="floquet_airbox"`, while unsupported combinations fail in
planning rather than silently falling back; the current snapshot has no
managed or physical qualification for this lane.

Sparse/matrix-free and assembled MFEM dynamic-demag-k operators are therefore
source-visible but not promoted. Promotion still requires solver telemetry,
residual checks, analytical controls, and managed convergence evidence.

Validation for this bridge requires a zero-matrix equivalence check, a nonzero
matrix frequency-shift check against the same dense block-real oracle, shape
and finite-value rejection tests, and an explicit planner/runtime gate for
requests whose shared-domain Floquet implementation lacks the required
managed evidence.

## Poisson-airbox `k=0` modal eigensolve implementation

The active implementation contract for full-coupled Poisson-airbox `k=0`
modal eigensolve is:

`docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md`.

The earlier plan 18 remains supporting implementation history for the PA-E1
dense full-coupled algebraic oracle and staged CPU/GPU work. Synthetic
Poisson-airbox payloads validate algebra only and cannot carry a production
periodic-airbox claim.

The current native GPU modal exception is narrower: the K0 no-demag macrospin
Kittel field sweep may use `gpu_dense_k0_macrospin_modal_eigen`, where
cuSolverDN solves the dense generalized field problem and the runner maps the
positive field eigenvalue to `lambda = i omega`. This does not implement
nonzero-k Floquet modal GPU, dynamic demag-k, or a broad sparse/matrix-free GPU
modal eigensolver.

The small-reference implementation uses a dense symmetric reduction:

1. Cholesky factorization of `M`
2. transformed symmetric eigen solve
3. back-lift to generalized eigenvectors

This is appropriate for the small reference cases used to validate semantics
and artifacts, but it is not the scalable eigensolver architecture.  The
transitional runner may use sparse LOBPCG for real-valued problems above the
dense threshold, but LOBPCG remains a bridge.  The production FEM eigen backend
must use PETSc/SLEPc-style sparse or matrix-free eigensolvers with spectral
targeting:

- Krylov-Schur, Arnoldi, LOBPCG, Jacobi-Davidson, or equivalent EPS methods for
  exterior modes;
- shift-invert or Cayley spectral transformations for interior modes near a
  target frequency;
- FEAST / contour-integral style interval solvers for frequency-window queries
  when the user asks for modes in a band;
- PETSc/hypre/MFEM linear solves and preconditioners for shifted systems;
- matrix-free `y = A x` operator application whenever assembled matrices would
  dominate memory.

Dense diagonalization is allowed only as a reference/validation lane.  It must
not be marketed as the route for COMSOL-class large-object eigenmode studies.

## Equilibrium handling

`StudyIR::Eigenmodes.equilibrium` supports three sources:

- `provided`
- `artifact`
- `relaxed_initial_state`

For `relaxed_initial_state`, the current reference runner performs a short overdamped relaxation loop before assembling the operator. The number of relaxation steps is recorded in the exported metadata.

## Normalization and modal fields

The runner currently supports:

- `unit_l2`
- `unit_max_amplitude`

Mode artifacts export:

- `real`
- `imag`
- `amplitude`
- `phase`

The current circular polarization export is a tangent-basis reconstruction convenience for visualization. It should be treated as a reference visualization product contract, not yet as a full non-Hermitian modal analysis package.

## Branch identity at crossings and degeneracies

`KSamplingIR::Path` solves each sample independently, so the order and phase
of eigenvectors returned by a solver are not branch identity.  The tracker
compares only modes represented in the same active magnetic FEM basis.  The
mass weights are the positive per-node FE weights supplied with the reduced
vectors; they are applied to every Cartesian component at that node.  Airbox
degrees of freedom and vectors on a different mesh are not part of this
metric.

For a reduced vector $v$, the internal mass-normalized representation is

```{math}
:label: eq-eigenmode-branch-mass-normalization
\widetilde v = \frac{M^{1/2}v}{\lVert M^{1/2}v\rVert_2},
\qquad
M=\operatorname{diag}(w_1,w_1,w_1,\ldots,w_n,w_n,w_n),
\qquad w_i>0.
```

The implementation orthonormalizes each previous and current candidate group
in this metric.  If $U$ and $V$ are the resulting bases of the same rank
$r$, it computes

```{math}
:label: eq-eigenmode-branch-principal-angles
C=U^\ast V=P\,\Sigma\,Q^\ast,
\qquad
\cos\theta_j=\sigma_j(C),
\qquad
s_{\mathrm{sub}}=\min_{1\leq j\leq r}\cos\theta_j .
```

The minimum principal-angle cosine is the geometric continuity criterion; a
single raw-vector overlap is not used to certify a degenerate group.  The
Procrustes transport

```{math}
:label: eq-eigenmode-branch-procrustes-transport
R=Q P^\ast,
\qquad
V R\ \text{is the current basis transported closest to }U,
```

provides a private frame for the next path sample.  A Hungarian assignment on
$|R_{ij}|$ gives stable raw-mode slots for the next step.  Individual labels
inside a degenerate subspace remain gauge-dependent; the published branch
point therefore leaves `overlap_prev` empty for a subspace edge and keeps the
subspace decision in the internal confidence/diagnostic path until the V2
artifact extension defines explicit principal-angle fields.

The tracker groups complex frequencies only for numerical degeneracy
detection.  With real and imaginary frequencies in Hz, the current private
policy is

```{math}
:label: eq-eigenmode-branch-degeneracy-policy
\delta_f=
\sqrt{(f_r-f'_r)^2+(f_i-f'_i)^2}
\leq
10^{-6}\,\mathrm{Hz}
 +10^{-9}\max\!\left(
 \sqrt{f_r^2+f_i^2},
 \sqrt{(f'_r)^2+(f'_i)^2},
 1\,\mathrm{Hz}\right).
```

This is a conservative numerical grouping rule for solver round-off around an
exact crossing, not a claim that bands separated by this value are physically
identical.  It is intentionally private while the versioned IR/artifact
contract has no authored degeneracy tolerance.  A degenerate sample adjacent
to split singleton modes forms a candidate group from the nearest complex
frequency center and still requires the mass-weighted principal-angle test;
an ambiguous boundary, unequal rank, invalid vector, mismatched positive mass
diagonal, or different last sample causes the candidate to be rejected and
leaves ordinary overlap matching or branch restart in control.

The present implementation is scoped to right eigenvectors in a common FEM
coordinate basis.  It is phase-invariant and can transport a rotated basis,
but it does not yet remove a known Bloch envelope phase before comparison and
does not claim a left/right biorthogonal metric for strongly non-Hermitian
damped pencils.  Those cases require explicit phase-frame and left/right
fields in a later versioned contract.

The numerical owner is
`crates/fullmag-runner/src/eigen/tracking_subspace.rs::mass_weighted_subspace_transport`;
assignment and restart policy remain in
`crates/fullmag-runner/src/eigen/tracking.rs::track_branches`.  Regression
coverage includes rotated mass-weighted degenerate bases,
split–degenerate–split crossings, unequal-rank rejection, and rejection of
frames retained from different last samples in
`crates/fullmag-runner/src/eigen/tracking.rs::tests`.

## Artifact contract

The runner writes:

- `eigen/spectrum.v2.json`
- `eigen/branches.v2.json` when branch tracking is available
- `eigen/dispersion.csv`
- `eigen/spectrum.json`
- `eigen/modes/mode_XXXX.json`
- `eigen/dispersion/branch_table.csv`
- `eigen/dispersion/path.json`
- `eigen/metadata/eigen_summary.json`
- `eigen/metadata/normalization.json`
- `eigen/metadata/equilibrium_source.json`

The V2 artifact contract is defined in
`docs/specs/frequency-domain-artifacts-v2.md`. These artifacts are consumed by
the Analyze UI and by the v2 API resources under
`/v2/sessions/current/analysis/eigen/*`.

Production-scale artifacts must additionally record the spectral search
contract:

- requested frequency window in Hz (`frequency_min_hz`, `frequency_max_hz`);
- requested mode cap (`count`);
- resolved eigensolver family (`krylov_schur`, `lobpcg`, `jacobi_davidson`,
  `feast`, `shift_invert`, or equivalent);
- spectral transform and shift/window actually used;
- linear solver and preconditioner used by shifted systems;
- residual tolerance, maximum iterations, converged mode count, and final
  residuals;
- whether modes outside the requested window were computed only as internal
  guard modes and filtered before publication.

## Production large-object solver requirement

For large structures, the correct user-level question is not "compute the first
N eigenvectors of the full dense operator".  It is:

```python
study.stages.add_eigenmodes(
    count=20,
    target="frequency_window",
    frequency_min=100e6,
    frequency_max=5e9,
    equilibrium_source="relax",
)
```

The SI contract is:

- `frequency_min` and `frequency_max` are in Hz;
- both bounds must be finite and positive;
- `frequency_min < frequency_max`;
- `count` is a maximum number of accepted modes returned from that window;
- if fewer modes exist in the interval, the solver returns fewer modes and
  reports `stop_reason="window_exhausted"`;
- if the iteration cap or tolerance stops the solve first, the solver reports a
  partial result with residual diagnostics instead of pretending success.

Dispersion validation should mirror the common experimental/theoretical workflow
instead of defaulting to an exhaustive sweep over every k direction. Production
acceptance must include narrow one-dimensional film sweeps in both standard
geometries:

- Damon-Eshbach (DE): in-plane `k` perpendicular to the equilibrium
  magnetization;
- backward-volume (BV): in-plane `k` parallel to the equilibrium magnetization.

Domyślny preset `ThinFilmDEBVDispersionValidation` zachowuje
`max_k_rad_per_m=3e6` i `frequency_window_hz=(0, 5e9)` w jednostkach SI.
Nie są to uniwersalne granice fizyczne modelu. Użytkownik może podać dowolne
skończone dodatnie maksimum wektora falowego oraz skończone, uporządkowane
okno częstotliwości z nieujemnym minimum. Oba parametry przechodzą bez
zmiany do `runtime_metadata.dispersion_validation` i planu FEM.

To rozróżnienie jest istotne dla benchmarku C1: jego zakres nie mieści się w
historycznym presecie. Dla filmu o okresie $a=200\,\mathrm{nm}$ używa się
`max_k_rad_per_m=pi/(200e-9)` oraz okna obejmującego co najmniej
$0$--$15\,\mathrm{GHz}$;
wartości te muszą być jawnie podane w konfiguracji benchmarku. C0 z wyłączonym
dynamicznym demagiem jest osobnym testem kontrolnym i nie dowodzi zgodności
operatora demagnetyzacji dla C1.

Porównanie KS n=0 dotyczy jednorodnej warstwy, równowagi w płaszczyźnie,
modu podstawowego o prawie jednorodnym profilu po grubości oraz odpowiedniej
orientacji BV lub DE. Walidator wymaga dodatniej zgodności kierunku pola z
magnetyzacją i odrzuca niezerowe DMI, anizotropię oraz niejednorodne Ms/A,
których ta postać wzoru nie zawiera. Nie kwalifikuje antydotów, modów wyższych ani dowolnie
grubych warstw. Zakres zależy od grubości, materiału, pola i hybrydyzacji modów;
samo zaakceptowanie parametrów przez planner nie dowodzi stosowalności.
Wymagane są zgodność częstości z zadanym `max_relative_error`, kontrola profilu
modu oraz zbieżność siatki i zewnętrznej granicy magnetostatycznej.
Przykład `examples/fem_eigenmodes_dispersion_de_bv_low_k.py` ma film
20 nm i po 2 mikrometry powietrza z obu stron (domena 4.02 mikrometra).
Poprzednia domena 40 nm dawała po 10 nm powietrza i silnie zmieniała kontrolę
Gamma z granicą Dirichleta. Większy odstęp zmniejsza ten błąd brzegowy,
lecz nie zastępuje numerycznego sprawdzenia zbieżności.

Skończony airbox należy porównywać z odpowiednią korektą lub granicą zbieżności,
a nie utożsamiać z otwartą przestrzenią. Dla C1 grubość wynosi 10 nm,
maksimum na odcinku Gamma-X wynosi pi/(200 nm), a okno musi obejmować
częstość Kittela około 9.31 GHz. Odcinki ukośne wymagają osobnego modelu
kątowego; nie wolno oznaczać ich jako BV albo DE.

Dlatego trzy liczby widoczne na wykresach nie są zamienne: kontrola C0 bez
demagu ma około $2.800264\,\mathrm{GHz}$, analityczna granica otwartego filmu
C1 w punkcie $\Gamma$ ma około $9.309814\,\mathrm{GHz}$, a wstępny natywny
solve C1 z periodycznym airboxem dał $8.906582\,\mathrm{GHz}$. Ta ostatnia
wartość pochodzi z diagnostycznej siatki 391-węzłowej z jednym elementem po
grubości i około $1\,\mu\mathrm{m}$ powietrza; jej residual był mały, ale
nie przeszła certyfikacji okna/zbieżności. Różnica nie jest dowodem błędu
analityki ani solvera, dopóki nie zostanie powtórzona kampania zbieżności
siatki, liczbą warstw i airboxem. Jako diagnostyczna wskazówka, przeliczenie tej jednej liczby na skalarnego
Kittela daje efektywny $N_z\approx0.9068$. Dla modelu
$N_z=1-t/(t+2d)$ oznacza to efektywną odległość granicy Dirichleta
$d\approx48.7\,\mathrm{nm}$ od każdej powierzchni filmu; bezpośrednio dla
$d=50\,\mathrm{nm}$ model daje około $8.916623\,\mathrm{GHz}$. Jest to
zgodne ze skalą starego wyniku i nie jest zgodne z deklarowanym w C1
$d=2\,\mu\mathrm{m}$, dla którego oczekujemy $N_z\approx0.997506$ i
$9.299250\,\mathrm{GHz}$. Wniosek z preview jest więc węższy: artefakt miał
efektywną geometrię lub dyskretyzację normalną odpowiadającą znacznie
mniejszemu airboxowi (ewentualnie jego bounds nie były tymi z konfiguracji),
albo nie rozwiązywał poprawnie profilu po grubości. Residual nie wykrywa takiej
niespójności fizycznej; trzeba odczytać rzeczywiste bounds z `DomainFrameIR` i
wykonać sweep paddingu oraz liczby warstw.

Współczynnik P00 jest obliczany stabilnie: dla małego bezwymiarowego argumentu
`x=|k|*t` używane jest rozwinięcie `x/2-x^2/6+x^3/24-x^4/120+x^5/720`,
a poza nim `1+expm1(-x)/x`. Granica w zerze wynosi zero. Generator CSV
importuje `scripts/verify_fem_frequency_domain_eigen_artifacts.py::p00_demag_factor`,
aby współczynnik i częstość korzystały z tej samej realizacji. Rust stosuje tę
samą postać w `eigen/artifacts/modal_manifest.rs::kalinikos_slab_n0_frequency_hz`.
Test `test_frequency_is_continuous_at_gamma` sprawdza częstość BV i DE,
nie tylko pomocniczy współczynnik. To kontrola referencji analitycznej,
nie dowód wykonania FEM.

This is the route to COMSOL-class behavior: sparse operators, spectral targeting,
preconditioned shifted solves, and clear diagnostics.  The UI must expose this
as a first-class eigenmode target, not as an advanced hidden backend knob.

## Live progress contract

Production eigensolve progress is solver progress, not time-step telemetry.
The control room should show:

- assembly phase and DOF count;
- requested frequency window and requested mode cap;
- resolved eigensolver and spectral transform;
- Krylov/FEAST outer iteration;
- shifted linear-solve iterations where applicable;
- residual norm and converged mode count;
- last checkpoint or last emitted artifact;
- clear dense-path warning when no internal iteration telemetry exists.

### Jawna polityka wykonania natywnego CPU

Obecny adapter publikuje `execution_policy=petsc_sequential_cpu`,
`execution_scope=single_process_shared_memory`, `communicator=PETSC_COMM_SELF`
oraz `scalability_scope=single_process_only`. Sparse/matrix-free nie oznacza
w tej realizacji obliczeń rozproszonych MPI. Polityka jest obecnie ustalona
przez adapter, a nie wybierana przez dowolne opcje użytkownika.

Dla dynamicznego demagu Floqueta rozwiązanie potencjału używa PREONLY/LU,
a układ przesunięty GMRES/Jacobi. Manifest rozdziela `poisson_ksp_*` od
`ksp_*` układu przesuniętego. Wartości tolerancji i limitów odczytuje
`KSPGetTolerances`; zachowano domyślną tolerancję absolutną PETSc.
`poisson_iteration_semantics=preonly_factorization_no_iterative_convergence`
wyjaśnia, że tolerancje Poissona nie dowodzą iteracyjnej zbieżności PREONLY.
Weryfikacja wymaga nadal residualu oryginalnego operatora.

Domyślnie plan nie narzuca po stronie runnera limitu iteracji: brak
`runtime_metadata.modal_solver_policy` deleguje do domyślnych wartości
PETSc/SLEPc. Jeżeli plan poda `residual_tolerance`, `max_outer_iterations`
lub `max_linear_iterations`, są to wartości żądane; diagnostyka natywna
publikuje osobno wartości rzeczywiście rozwiązane przez EPS/KSP. Ta ścieżka
jest zintegrowana w źródłach, lecz nie została jeszcze potwierdzona w
managed runtime dla benchmarku C0/C1/A1.

Początkowy komunikat postępu ma `max_iterations=None`, dopóki callback
natywnego solvera nie dostarczy rozwiązanego limitu. Nie publikuje stałej 300.
Mapowanie: `slepc_modal_eigen.hpp::SLEPcTinyGyrotropicModalEigenResult`,
`modal/floquet_modal_solver.cpp::solve_floquet_shared_domain_sparse_modal_spectrum`,
`production_cpu_modal_eigen.cpp::solve_sparse_production_modal_payload`
w `backends/fem/cpu/frequency_domain/` oraz
`crates/fullmag-runner/src/fem/eigen_native_window.rs::execute_native_modal_window`.
Kontrakt parsera i przekazywania limitu przechodzi w CI; nie jest to jednak
dowód wykonania pełnego managed MFEM/SLEPc dla bieżącego C1/A1. Taki dowód
wymaga osobnego receiptu runtime oraz artefaktów z poprawnym niezerowym `k`.

## Current limitations

Stan źródeł dla tej noty należy identyfikować w checkoutcie przez
`git rev-parse HEAD` oraz `git status --short`; historyczne SHA z wcześniejszych
checkpointów nie są dowodem bieżącej implementacji. W tym worktree sprawdzono
źródła 2026-09-14, a dowody managed runtime i kwalifikacji fizycznej są opisane
oddzielnie w planie checkpointu.

- FEM CPU ma zintegrowaną ścieżkę shared-domain MFEM/Floquet i sparse SLEPc;
  samo istnienie tej ścieżki nie dowodzi wykonania ani poprawności demag-k.
- Eksport obejmuje diagnostykę residuali, normę masową, rekonstrukcję
  potencjału i pole elementowe. Ich kompletność i wartości wymagają kontroli
  na rzeczywistym wyniku modelu C0/C1/A1.
- Nie ma potwierdzonej w tym checkpointcie pełnej kwalifikacji B4–B6:
  Kittel/KS, 61 punktów i 8 gałęzi oraz zbieżność siatki/airboxa/liczby modów.
- Referencja analityczna jest oddzielnym produktem. Jej poprawne wartości
  nie kwalifikują FEM ani nie zastępują zaakceptowanej równowagi numerycznej.
- Wyniki FDM CPU, FDM GPU i FEM GPU nie są kwalifikowane przez tę ścieżkę
  FEM CPU. Obsługa 2.5D pozostaje osobnym kontraktem.
- Interaktywne snapshoty podglądu FEM eigen nie są obsługiwane.

## Acceptance expectations for this phase

The MVP is considered correct when:

- `Problem(..., study=fm.Eigenmodes(...))` lowers into `StudyIR::Eigenmodes`,
- FEM planning produces `BackendPlanIR::FemEigen`,
- the runner exports the eigen artifact family,
- Analyze can open spectrum, saved modes, and dispersion rows without reconstructing semantics from ad hoc UI logic,
- `KSamplingIR::Path` uses the same open/closed segment semantics in Python,
  ProblemIR validation, runtime expansion, and `eigen/dispersion.csv`: open
  paths have `len(points)-1` segments, closed paths have `len(points)` segments
  with the final segment returning to the first point, and both publish
  `sum(samples_per_segment)+1` samples,
- validation rejects mixing time outputs with eigen outputs.

## Contract index for this page

(problem-statement)=
The page defines the FEM modal product and its separation from the analytic
dispersion oracle. A requested nonzero wave vector is solved by the selected
FEM lane; the analytic frequency is a postsolve comparison value.

(governing-equations)=
```{math}
:label: eq-0600-modal-pencil
L q = \lambda B_\alpha q, \qquad \lambda = \mathrm{i}\omega,
\qquad f = \operatorname{Re}(\omega)/(2\pi).
```

```{math}
:label: eq-0600-p00-reference
P_{00}(x)=1+\frac{\exp(-x)-1}{x}, \qquad x=|k|t,
\qquad P_{00}(0)=0.
```

(symbols-and-si-units)=
| Token | Meaning | SI unit |
|---|---|---|
| $q$ | tangent-plane modal coefficients | $1$ |
| $\lambda$ | generalized eigenvalue | $\mathrm{s^{-1}}$ |
| $B_\alpha$ | gyrotropic/mass operator | $\mathrm{m^3}$ |
| $\omega$ | angular frequency | $\mathrm{rad\,s^{-1}}$ |
| $f$ | cyclic frequency | $\mathrm{Hz}$ |
| $P_{00}$ | thin-film demagnetizing factor | $1$ |
| $k$ | in-plane wave vector magnitude | $\mathrm{rad\,m^{-1}}$ |
| $t$ | film thickness | $\mathrm{m}$ |

(assumptions-and-validity)=
The Kittel/KS comparison assumes a uniform in-plane equilibrium, a matching
film geometry, and the declared finite or open magnetostatic boundary. It does
not qualify higher modes, textured equilibria, or an unverified airbox. The
small-$x$ series is a numerical reference only; it never substitutes for the
FEM solve.

(python-api)=
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `study.stages.add_eigenmodes.count` | `int` | `required` | $1$ | positive integer | maximum accepted modal count | FEM CPU/GPU authoring; runtime-qualified per lane | `studies[].eigenmodes.count` |

```python
# %%
import fullmag as fm

study = fm.study("fem_eigenmodes_contract")
study.engine("fem")
study.stages.add_eigenmodes(count=4, include_demag=True)
```

(problem-ir)=
The Python request lowers to `StudyIR::Eigenmodes`, then to
`BackendPlanIR::FemEigen`. Requested mode count, frequency window, k sampling,
boundary model, and execution lane remain explicit in the IR and provenance.

(round-trip-and-failure-semantics)=
Round-trip serialization preserves requested intent and resolved execution.
Validation errors reject non-finite ranges, incomplete equilibrium handoff,
unsupported combinations, and synthetic K0 reference requests mixed with
`dispersion_validation`. An unavailable lane returns a capability error and
does not silently fall back to an analytic or CPU implementation.

(discrete-realization)=
FEM CPU uses the tangent-space operator and the native sparse modal adapter;
FEM GPU is a separate lane. FDM lanes are outside this page's realization.
Residuals, accepted mode count, mesh identity, phase metadata, and analytic
comparison fields are published per sample.

(implementation-mapping)=
The stable implementation identities are listed in the source index below.
They cover public authoring, planning, numerical execution, and the shared
small-argument analytic reference.

(validation)=
Source contracts check P00 continuity and the FEM/analytic product split.
Runtime acceptance additionally requires finite non-empty modal rows, residual
and phase certificates, Kittel/KS checks, and mesh, airbox, and mode-count
convergence. Those runtime gates remain separate from source tests.

(limitations)=
The current checkout has no new managed receipt for the full C0/C1/A1 campaign.
The 61-sample path, eight physical branches, browser proof, and release
qualification therefore remain `NOT VERIFIED`.

(scientific-bibliography)=
Kalinikos and Slavin, *Theory of dipole-exchange spin wave spectrum for
ferromagnetic films*, J. Phys. C 19 (1986), DOI:10.1088/0022-3719/19/35/7013.

(source-code-index)=
| Path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/study.py` | `class Eigenmodes` | Validate public modal parameters. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem_eigen` | Lower the FEM eigen study and enforce capability policy. |
| `crates/fullmag-runner/src/fem/eigen_path.rs` | `execute_fem_eigen_path` | Execute k samples and publish postsolve comparisons. |
| `scripts/verify_fem_frequency_domain_eigen_artifacts.py` | `p00_demag_factor` | Stable analytic P00 reference. |
