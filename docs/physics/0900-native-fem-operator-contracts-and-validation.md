# Native FEM Operator Contracts and Validation

- Status: canonical numerics standard
- Owners: Fullmag core
- Last updated: 2026-08-24
- Related ADRs:
  - `docs/adr/0014-native-fem-backend-modularization.md`
- Related specs:
  - `docs/specs/native-fem-backend-architecture-v1.md`
  - `docs/specs/capability-matrix-v0.md`
- Related reports:
  - `docs/reports/16.05.2026/fullmag_fem_cpu_audit.md`
  - `docs/reports/16.05.2026/fullmag_fem_cpu_implementation_instructions.md`
  - `docs/reports/16.05.2026/fullmag_fem_cpu_validation_matrix.md`

> **Spin-transport reconciliation (2026-07-15).** For STT, prescribed SOT,
> spin drift-diffusion, and dynamic Oersted, this general operator standard is
> specialized by physics notes 0960–0980. Those notes govern signs, SI units,
> stage cadence, interface orientation, observables, and validation. Existing
> STT/Oersted executability remains below `validated` unless its named workload
> gates pass; prescribed SOT must not be labelled as solved SHE.

(problem-statement)=
## 1. Problem Statement

The native FEM backend must stop treating the MFEM bridge as the place where
all physics, runtime, solvers, and telemetry meet. Each interaction or solver
must have a documented contract that can be validated independently before it
is treated as production-grade.

This note defines the minimum physics and numerics standard for native FEM
operator modules.

(governing-equations)=
## 2. Governing Runtime Form

Fullmag uses reduced magnetization:

```{math}
:label: fem-native-reduced-magnetization
\lVert \mathbf{m}(\mathbf{x},t) \rVert = 1,
\qquad
\mathbf{M}(\mathbf{x},t) = M_s(\mathbf{x})\,\mathbf{m}(\mathbf{x},t).
```

The explicit LLG path uses:

```{math}
:label: fem-native-explicit-llg
\frac{\partial \mathbf{m}}{\partial t}
=
-\frac{\gamma_0}{1+\alpha^2}
\left[
\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}
+\alpha\,\mathbf{m}\times
\left(\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}\right)
\right]
+\boldsymbol{\tau}_{\mathrm{direct}}.
```

For `llg_overdamped` relaxation, native FEM must disable precession explicitly:

```{math}
:label: fem-native-overdamped-llg
\frac{\partial \mathbf{m}}{\partial t}
=
-\frac{\gamma_0\alpha}{1+\alpha^2}
\mathbf{m}\times
\left(\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}\right)
+\boldsymbol{\tau}_{\mathrm{direct}}.
```

The native runtime contract field is `precession_enabled`. It must be imported
from the planner/FFI plan, stored in native FEM runtime state, consumed by both
CPU and GPU RHS implementations, and reported as `llg_mode = precessional` or
`llg_mode = pure_damping` in provenance/startup diagnostics.

where:

- `H_eff` is in `A/m`;
- `gamma_mu0` is in `m/(A s)`;
- `tau_direct` is in `1/s`.

An interaction must choose one of two paths:

1. effective field contribution added to `H_eff`;
2. direct torque contribution added to `tau_direct`.

It must not mix those paths without an explicit derivation.

A spin torque is first represented as a Gilbert source `T_G` in `1/s`. The
explicit integrator contribution is exactly
`(T_G + alpha m x T_G)/(1 + alpha^2)`. A backend must not add an `A/m` field
directly to `tau_direct`, apply this conversion twice, or erase signed current.

## 3. Energy to Field Contract

For an energy-derived term:

```{math}
:label: fem-native-energy-field-variation
\delta E
=
-\mu_0\int_{\Omega_m}
M_s\,\mathbf{H}_{\mathrm{term}}\cdot\delta\mathbf{m}\,\mathrm{d}V.
```

for tangent perturbations `delta_m` with `delta_m perpendicular m`.

Every energy-derived module needs at least one finite-difference directional
derivative test:

```{math}
:label: fem-native-directional-derivative
\frac{
E\!\left(\operatorname{normalize}(\mathbf{m}+\varepsilon\mathbf{v})\right)
-E\!\left(\operatorname{normalize}(\mathbf{m}-\varepsilon\mathbf{v})\right)
}{2\varepsilon}
\approx
-\mu_0\int_{\Omega_m}
M_s\,\mathbf{H}\cdot\mathbf{v}\,\mathrm{d}V.
```

The tolerance must be feature-specific. Local anisotropy should be stricter
than exchange, DMI, or demag because it has no FE gradient recovery error.

(symbols-and-si-units)=
## 4. Symbols and SI Units

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| zredukowana magnetyzacja | $\mathbf{m}$ | $1$ |
| magnetyzacja | $\mathbf{M}$ | $\mathrm{A\,m^{-1}}$ |
| magnetyzacja nasycenia | $M_s$ | $\mathrm{A\,m^{-1}}$ |
| pole efektywne | $\mathbf{H}_{\mathrm{eff}}$ | $\mathrm{A\,m^{-1}}$ |
| wkład pola energetycznego | $\mathbf{H}_{\mathrm{term}}$ | $\mathrm{A\,m^{-1}}$ |
| ogólne pole skuteczne w teście wariacyjnym | $\mathbf{H}$ | $\mathrm{A\,m^{-1}}$ |
| pole demagnetyzacji | $\mathbf{H}_{\mathrm{demag}}$ | $\mathrm{A\,m^{-1}}$ |
| zaburzenie styczne | $\delta\mathbf{m}$ | $1$ |
| kierunek testu różnicowego | $\mathbf{v}$ | $1$ |
| współczynnik żyromagnetyczny solvera | $\gamma_0$ | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| tłumienie Gilberta | $\alpha$ | $1$ |
| bezpośredni moment | $\boldsymbol{\tau}_{\mathrm{direct}}$ | $\mathrm{s^{-1}}$ |
| przenikalność próżni | $\mu_0$ | $\mathrm{N\,A^{-2}}$ |
| energia | $E$ | $\mathrm{J}$ |
| energia demagnetyzacji | $E_{\mathrm{demag}}$ | $\mathrm{J}$ |
| wkład energii brzegowej | $E_{\partial D}$ | $\mathrm{J}$ |
| wariacja energii | $\delta E$ | $\mathrm{J}$ |
| parametr różnicy centralnej | $\varepsilon$ | $1$ |
| dziedzina magnetyczna | $\Omega_m$ | $\mathrm{m^3}$ |
| pełna dziedzina Poissona | $D$ | $\mathrm{m^3}$ |
| funkcja testowa Poissona | $v$ | $\mathrm{A}$ |
| miara objętości | $\mathrm{d}V$ | $\mathrm{m^3}$ |
| czas | $t$ | $\mathrm{s}$ |
| położenie | $\mathbf{x}$ | $\mathrm{m}$ |
| exchange stiffness | $A_{\mathrm{ex}}$ | $\mathrm{J\,m^{-1}}$ |
| uniaxial/cubic anisotropy | $K_u, K_{c*}$ | $\mathrm{J\,m^{-3}}$ |
| interfacial DMI | $D_i$ | $\mathrm{J\,m^{-2}}$ |
| bulk DMI | $D_b$ | $\mathrm{J\,m^{-2}}$ |
| scalar magnetic potential | $u$ | $\mathrm{A}$ |
| current density | $\mathbf{J}$ | $\mathrm{A\,m^{-2}}$ |

If a literature formula uses `gamma` in `rad/(T s)`, the implementation note
must state how it is converted to the solver's `gamma_mu0`.

(assumptions-and-validity)=
## 4.1. Założenia i zakres ważności

Kontrakt dotyczy zredukowanej magnetyzacji o normie jeden oraz natywnego FEM
opartego na MFEM/hypre/libCEED. Produkcyjny kandydat jest ograniczony do P1;
każde rozszerzenie topologii, rzędu, precyzji albo modelu demagnetyzacji wymaga
osobnej capability i osobnej kwalifikacji. Równość masek receipt dowodzi miejsca
wykonania operatorów, ale sama nie dowodzi poprawności fizycznej ani zbieżności
siatkowej.

Jawny stan wsparcia i kwalifikacji czterech lane jest częścią kontraktu tej
strony; „udokumentowane” nie oznacza automatycznie „zwalidowane”:

| Lane | Wsparcie na tej stronie | Stan kwalifikacji | Powód / wymagany dowód |
|---|---|---|---|
| FDM CPU | nie dotyczy | nie dotyczy | kontrakt operatorów FDM ma osobnych właścicieli; ABI receipt v1 nie opisuje FDM |
| FDM GPU | nie dotyczy | nie dotyczy | natywny receipt FEM GPU nie jest dowodem wykonania CUDA FDM |
| FEM CPU | udokumentowane i wykonywalne dla wskazanych operatorów | zależne od interakcji; brak promocji przez tę stronę | wymagane są testy numeryczne i artefakty CPU dla konkretnego workloadu |
| FEM GPU | zaimplementowane dla wąskiego strict FP64 time-domain | `implemented/unvalidated` | brak świeżego managed GPU receipt z tożsamością urządzenia i źródeł |

(discrete-realization)=
## 5. FEM Discretization Contract

The current production target is low-order P1 FEM unless a feature-specific
high-order contract says otherwise.

Polynomial order and cell topology are independent capability dimensions. The
current production-executable P1 path remains tetrahedral. Bounded mixed-P1
CPU and GPU paths are implemented but await managed public-runtime proof. The
native mixed-P1 target in
`docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md` adds canonical
`prism6`, `pyramid5`, `tet4`, `tri3`, and `quad4` contracts; it is not executable
or validated merely because all cells are first order. Unsupported topology
must reject before backend startup, without connectivity truncation or hidden
prism-to-tet conversion.

For each FEM operator, document:

- FE space for input and output;
- whether data is nodal, element, quadrature-point, or global;
- mass policy: lumped, consistent, or projected;
- material averaging policy for heterogeneous `Ms`, `A_ex`, anisotropy, and
  DMI coefficients;
- magnetic/nonmagnetic/airbox handling;
- periodic-map handling if supported;
- boundary conditions and natural boundary terms;
- setup vs apply costs.

`fe_order > 1` must remain a capability rejection until those points are true
for the affected operator.

(implementation-mapping)=
## 6. Required Interaction Records

Every native FEM interaction module must have this record in its physics note
or module header:

```text
interaction_id:
energy:
field_or_torque:
input_units:
output_units:
FEM weak form:
boundary conditions:
material coefficient policy:
capability restrictions:
observables:
telemetry:
validation tests:
known limits:
```

No new interaction should be accepted into native FEM as "just another branch"
inside a bridge or context file.

(validation)=
## 7. Interaction-Specific Minimum Gates

| Interaction | Minimum gates before production qualification |
|---|---|
| Exchange | sinusoidal Laplacian, exchange energy convergence, heterogeneous `A_ex`/`Ms`, periodic continuity if PBC is enabled |
| Demag | sphere `H=-M/3`, ellipsoid or rectangular prism factors, airbox convergence, energy sign, Poisson residual and iteration telemetry |
| Zeeman | energy sign, nodal/constant field copy, time envelope refresh |
| Uniaxial anisotropy | axis normalization, easy-axis/easy-plane sign, directional derivative, per-node coefficient scaling |
| Cubic anisotropy | orthonormal axis validation, known minima, directional derivative, rotation invariance |
| DMI | separate bulk/interfacial variants, unit contract, directional derivative, chirality, spiral pitch, boundary tilt |
| Thermal | seed reproducibility, variance vs `dt`, nodal volume scaling, Boltzmann macrospin test |
| Slonczewski STT | direct `1/s` torque or effective `A/m` field derivation, current sign, `1/(Ms*t)` scaling, macrospin switching |
| Zhang-Li STT | exact explicit/Gilbert form, zero gradient test, 1D domain-wall velocity, current direction |
| Oersted | analytic cylinder field inside/outside, arbitrary-axis rotation, envelope timing |
| Prescribed SOT | signed-current involution, `gamma_e` SI prefactor, single Gilbert conversion, DL/FL macrospin vector oracle; no SHE-solver claim |
| Steady spin drift-diffusion | charge conservation, 1D spin profile, direct-SHE sign, interface flux/torque balance, FDM/FEM convergence |
| Dynamic Oersted | closed-circuit source, same `J_charge` as transport, direct-quadrature oracle, stage-time consistency, FEM airbox convergence |
| Magnetoelastic | prescribed-vs-coupled scope, energy derivative if energy is reported, zero-strain and uniform-strain tests |

## 8. Demag Poisson Contract

The current native FEM demag realization solves for scalar potential `u`:

```{math}
:label: fem-native-demag-poisson
\int_D \nabla u\cdot\nabla v\,\mathrm{d}V
=
\int_{\Omega_m}\mathbf{M}\cdot\nabla v\,\mathrm{d}V,
\qquad
\mathbf{H}_{\mathrm{demag}}=-\nabla u,
\qquad
E_{\mathrm{demag}}
=
-\frac{\mu_0}{2}
\int_{\Omega_m}
\mathbf{M}\cdot\mathbf{H}_{\mathrm{demag}}\,\mathrm{d}V
+E_{\partial D}.
```

where `boundary_term` is present only for boundary models that require it.

The module boundary must separate:

```text
space setup
boundary policy
matrix/preconditioner setup
RHS assembly
linear solve
field recovery
energy
telemetry
```

FEM GPU demag has two explicit runtime modes:

| Mode | Contract |
|---|---|
| `device_hypre_poisson` | Strict GPU demag. RHS assembly, hypre PCG/GMRES+BoomerAMG, warm-start potential, recovery `H_demag`, and demag energy stay device-resident during RK stage evaluation. |
| `hybrid_cpu_poisson` | Compatibility/debug mode only. A stage performs `D->H` magnetization transfer, CPU MFEM/Hypre Poisson, then `H->D` demag-field upload. This mode must never be silently selected for strict `study.device("gpu")`. |

Strict `device_hypre_poisson` must publish provenance:

```text
fem_execution_mode = all_in_gpu_legacy_sparse
uses_gpu_poisson = true
fem_demag_operator_mode = device_hypre_poisson
hypre_execution_policy = device
demag_residency = device
hot_loop_compute_h2d_bytes = 0
hot_loop_compute_d2h_bytes = 0
hot_loop_compute_host_sync_count = 0
```

Initial production-executable strict GPU scope remains tetrahedral P1, double
precision, non-periodic shared-domain airbox Poisson with Dirichlet/Robin
boundary policy. The bounded certificate-bound mixed-P1 relaxation tuple is
`implemented` for explicit GPU, but is not yet `production_executable` or
`validated`. Wider mixed-P1 requests, `fe_order > 1`, periodic demag, and
Fredkin-Koehler GPU demag must reject with an actionable diagnostic.

The bounded mixed-P1 extension is specified in
`docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`. Its Poisson
stiffness spans the complete conforming prism/pyramid/tetrahedron domain, while
the `m -> rhs` source and `u -> H_demag` recovery operators integrate and
normalize only over magnetic cells. In particular, air-cell mass at shared
interface nodes must not dilute recovered magnetic fields. The topology-aware
MFEM operators are assembled once per topology generation, fingerprint-bound,
uploaded once, and then applied through the existing device CSR/Hypre path.
Mixed-P1 remains at `implemented` until an identical-fingerprint managed
CPU/GPU run proves operator parity, device identity, empty fallback trails, and
raw zero-transfer/zero-host-sync compute counters. Only that next proof may
justify `production_executable`; it does not by itself establish `validated`.

Poisson/airbox/Robin is an executable approximation to open-boundary
magnetostatics. It is not a blanket proof of full-space demag accuracy. Release
documentation must state the airbox and boundary-condition limits.

## 9. CPU/GPU Interpretation

CPU/MFEM and GPU/CUDA may differ in:

- sparse vs partial/matrix-free assembly;
- host vs device memory layout;
- preconditioner implementation;
- reduction and projection kernels;
- precision path.

They may not differ in:

- field sign;
- energy sign;
- SI units;
- direct torque vs effective field interpretation;
- capability semantics;
- observable names;
- provenance fields.

Native FEM CPU must not require GPU residency state unless the requested mode is
an explicit interop path.

### 9.1. Wersjonowany receipt wykonania FEM GPU

Plan nie jest dowodem wykonania. `GpuRkPlan` publikuje maski
`required_operator_mask` oraz `resolved_*_operator_mask` przed pierwszą próbą,
natomiast `fullmag_fem_gpu_execution_receipt_v1` z handshake
`FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1` publikuje maski
`executed_device_operator_mask`, `executed_host_operator_mask` i
`executed_unknown_operator_mask` dopiero po zaakceptowanej próbie.
`gpu_execution_receipt_commit_attempt` wykonuje publikację atomic: odrzucenie,
błąd albo anulowanie zwiększa odpowiedni licznik, ale nie zastępuje ostatniego
zaakceptowanego snapshotu maskami częściowej próby.

Publiczny, append-only zbiór bitów ABI v1 jest następujący:

| Bit | Stała ABI | Operator ID | Kiedy jest required |
|---:|---|---|---|
| 0, `0x001` | `FULLMAG_FEM_GPU_OPERATOR_EXCHANGE` | `exchange` | aktywny exchange |
| 1, `0x002` | `FULLMAG_FEM_GPU_OPERATOR_DEMAG_RHS` | `demag_rhs` | aktywny demag Poisson |
| 2, `0x004` | `FULLMAG_FEM_GPU_OPERATOR_DEMAG_SOLVE` | `demag_solve` | aktywny demag Poisson |
| 3, `0x008` | `FULLMAG_FEM_GPU_OPERATOR_DEMAG_RECOVERY` | `demag_recovery` | aktywny demag Poisson |
| 4, `0x010` | `FULLMAG_FEM_GPU_OPERATOR_LOCAL_FIELDS` | `local_fields` | co najmniej jedno aktywne pole lokalne |
| 5, `0x020` | `FULLMAG_FEM_GPU_OPERATOR_DIRECT_TORQUES` | `direct_torques` | co najmniej jeden aktywny bezpośredni moment |
| 6, `0x040` | `FULLMAG_FEM_GPU_OPERATOR_LLG_RHS` | `llg_rhs` | każdy krok time-domain GPU |
| 7, `0x080` | `FULLMAG_FEM_GPU_OPERATOR_RK_STEPPER` | `rk_stepper` | każdy krok time-domain GPU |
| 8, `0x100` | `FULLMAG_FEM_GPU_OPERATOR_REDUCTIONS` | `reductions` | każdy krok time-domain GPU |
| 9, `0x200` | `FULLMAG_FEM_GPU_OPERATOR_PRECONDITIONER` | `preconditioner` | aktywny solve wymagający preconditionera |

Strict `device_resident` jest akceptowany wyłącznie wtedy, gdy required mask
jest niepusta i znana, obie maski device są dokładnie równe required mask,
maski host/unknown są zerowe, `fallback_count=0`, istnieje zaakceptowany krok,
a liczniki `hot_loop_compute_h2d_bytes`,
`hot_loop_compute_d2h_bytes` i
`hot_loop_compute_host_sync_count` są zerowe. Każde naruszenie kończy forced
GPU typed error bez fallbacku CPU.

`hybrid_cpu_poisson` jest odrębną klasą execution receipt. W niej
`demag_solve|preconditioner` są jawnie hostowe, transfery D→H/H→D są
widoczne, a artefakt nigdy nie może deklarować strict ani
`device_resident`. Komparator kwalifikacji odrzuca taki mismatch.

Artefakt kwalifikacji wiąże receipt z
`source_identity.source_snapshot_sha256`. CPU i GPU parity jest ważne tylko
dla identycznego hasha źródeł; brak receipt, brak wymaganych operator IDs albo
rozbieżny hash kończy bramkę fail-closed. Ta zmiana ustanawia stan
`implemented/unvalidated`: bez świeżego managed GPU artefaktu nie promuje
`production_executable` ani `validated`.

Trwała projekcja artefaktu ma dokładny schemat
`fullmag.fem_gpu_execution_receipt.native_projection.v1` i wskazuje
`rust_projection = FemGpuExecutionReceipt.v1`. Zawiera bezstratnie handshake ABI
(`native_abi_version`, `native_struct_size`), `requested`, `resolved`, `executed`,
klasę wykonania, ordinal urządzenia, precyzję i integrator, wszystkie maski,
liczniki fallback/accepted/rejected/failed, wszystkie trzy strict compute
transfer/sync counters, `accounting_valid` oraz kanoniczne `operator_ids`.
`resolved` i `executed` są wyprowadzane wyłącznie z zaakceptowanego natywnego
receipt; requested strict intent nie może uzupełniać brakującego wykonania.

## 10. Capability and Provenance Impact

Capability documentation must distinguish:

- legal semantics in Python and `ProblemIR`;
- executable implementation on a lane;
- validated workload coverage.

Artifacts and runtime metadata for native FEM operators must preserve:

- requested and resolved engine id;
- requested device and fallback reason;
- solver policy and boundary mode where relevant;
- iteration and residual telemetry for linear solves;
- operator timing for expensive phases;
- known degradation or approximation notes.

(python-api)=
## 10.1. Publiczne authoring Python

Ta strona nie wprowadza nowego publicznego konstruktora ani parametru. Używa
istniejącego stage-first API, a szczegółowe tabele parametrów należą do stron
kanonicznych interakcji. Minimalny kompletny kształt strict FEM GPU time-domain
jest następujący:

```python
# %%
import fullmag as fm

study = fm.study("fem_gpu_receipt_contract")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(160e-9, 120e-9, 120e-9),
)
study.universe.mesh(maximum_element_size=20e-9)

# %%
film = study.geometry(
    fm.Box(size=(80e-9, 40e-9, 8e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
film.mesh(maximum_element_size=8e-9, order=1)

# %%
study.exchange(enabled=True)
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    max_iterations=500,
)
study.solver(
    integrator="rk45",
    dt_initial=1e-15,
    dt_min=1e-16,
    dt_max=1e-14,
    max_err=1e-6,
    g=2.115,
)
study.stages.add_run(until=1e-12)
```

Blok jest sprawdzany składniowo przez validator publikacyjny. Wykonanie
hardware wymaga bramki `just verify-fem-llg-time-domain-qualification-gpu`;
sam parser, source test ani plan nie stanowi dowodu wykonania CUDA.

Każdy argument i każda właściwość jawnie użyta przez przykład ma poniżej typ,
default, jednostkę, domenę walidacji, znaczenie, wsparcie lane i cel obniżenia:

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.study.problem_name` | `str \| None` | `None` | $1$ | non-empty string when provided | stable problem name | FDM/FEM CPU/GPU | `problem_meta.name` |
| `StudyBuilder.engine.backend` | `str` | `required` | $1$ | auto, fdm, or fem; unknown value rejected during lowering | requested solver family | FDM/FEM CPU/GPU | `backend_policy.requested_backend` |
| `StudyBuilder.device.spec` | `str` | `required` | $1$ | cpu, gpu, auto, or cuda:N with non-negative N; unavailable forced GPU fails closed | requested execution device | FDM/FEM CPU/GPU | `problem_meta.runtime_metadata.runtime_selection.device (normalized requested runtime metadata)` |
| `StudyBuilder.device.precision` | `str \| None` | `None` | $1$ | single or double; this lane requires double | requested arithmetic precision | FDM/FEM CPU/GPU | `backend_policy.execution_precision` |
| `StudyBuilder.mode.execution_mode` | `str` | `required` | $1$ | strict, extended, or hybrid | fallback and legality policy | FDM/FEM CPU/GPU | `validation_profile.execution_mode` |
| `StudyUniverseHandle.mode` | `str \| None` | `None (inherits auto)` | $1$ | auto or manual; manual requires size | universe authoring policy | FEM CPU/GPU | `problem_meta.runtime_metadata.study_universe.mode (authoring metadata)` |
| `StudyUniverseHandle.size` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | finite positive three-vector for manual mode | full Poisson-domain extent | FEM CPU/GPU | `problem_meta.runtime_metadata.study_universe.size (authoring metadata)` |
| `StudyUniverseHandle.mesh.maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | finite and greater than zero | target airbox element size | FEM CPU/GPU | `problem_meta.runtime_metadata.study_universe.airbox_hmax (authoring metadata)` |
| `Box.size` | `tuple[float, float, float]` | `required` | $\mathrm{m}$ | finite positive three-vector | magnetic box dimensions | FDM/FEM CPU/GPU | `geometry.entries[0].size` |
| `Box.name` | `str` | `box` | $1$ | non-empty string; the study geometry owner normalizes the emitted asset name | geometry constructor name before owner normalization | FDM/FEM CPU/GPU | `geometry.entries[0].name (normalized to film_geom; Box.name is not preserved independently)` |
| `StudyBuilder.geometry.shape` | `object` | `required` | $1$ | object must lower through to_ir | magnetic geometry | FDM/FEM CPU/GPU | `geometry.entries[0]` |
| `StudyBuilder.geometry.name` | `str` | `body` | $1$ | non-empty string at lowering | user-facing magnet name | FDM/FEM CPU/GPU | `magnets[0].name` |
| `MagnetHandle.Ms` | `float` | `required before lowering` | $\mathrm{A\,m^{-1}}$ | finite and greater than zero | saturation magnetization | FDM/FEM CPU/GPU | `materials[0].saturation_magnetisation` |
| `MagnetHandle.Aex` | `float` | `required before lowering` | $\mathrm{J\,m^{-1}}$ | finite and greater than zero | exchange stiffness | FDM/FEM CPU/GPU | `materials[0].exchange_stiffness` |
| `MagnetHandle.alpha` | `float` | `0.01` | $1$ | finite and non-negative | Gilbert damping | FDM/FEM CPU/GPU | `materials[0].damping` |
| `MagnetHandle.m` | `InitialMagnetization` | `uniform (1,0,0)` | $1$ | supported initial-magnetization object | initial reduced magnetization | FDM/FEM CPU/GPU | `magnets[0].initial_magnetization` |
| `UniformMagnetization.value` | `Sequence[float]` | `required` | $1$ | finite three-vector | uniform initial vector | FDM/FEM CPU/GPU | `magnets[0].initial_magnetization.value` |
| `GeometryMeshHandle.maximum_element_size` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive SI value or supported calibrated token | target magnetic element size | FEM CPU/GPU | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[0].maximum_element_size (authoring metadata)` |
| `GeometryMeshHandle.order` | `int \| None` | `None (resolves 1)` | $1$ | strict qualified slice requires exactly 1 | FEM basis order | FEM CPU/GPU | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[0].order (authoring metadata)` |
| `StudyBuilder.exchange.enabled` | `bool` | `True` | $1$ | boolean | enable exchange energy | FDM/FEM CPU/GPU | `energy_terms[kind=exchange] presence/absence (no enabled field)` |
| `StudyBuilder.demag.realization` | `str \| None` | `None` | $1$ | supported demag realization; this slice uses poisson_robin | requested demag realization | FEM CPU/GPU | `energy_terms[kind=demag].realization` |
| `StudyBuilder.fem_demag_solver.solver` | `str` | `CG` | $1$ | CG or GMRES | Poisson linear solver | FEM CPU/GPU | `backend_policy.discretization_hints.fem.demag_solver_policy.solver` |
| `StudyBuilder.fem_demag_solver.preconditioner` | `str` | `AMG` | $1$ | AMG, JACOBI, or NONE | Poisson preconditioner | FEM CPU/GPU | `backend_policy.discretization_hints.fem.demag_solver_policy.preconditioner` |
| `StudyBuilder.fem_demag_solver.rtol` | `float` | `1e-8` | $1$ | finite and greater than zero | relative linear tolerance | FEM CPU/GPU | `backend_policy.discretization_hints.fem.demag_solver_policy.rtol` |
| `StudyBuilder.fem_demag_solver.max_iterations` | `int` | `500` | $1$ | integer at least 1 | linear iteration limit | FEM CPU/GPU | `backend_policy.discretization_hints.fem.demag_solver_policy.max_iterations` |
| `StudyBuilder.solver.integrator` | `str \| None` | `None` | $1$ | heun, rk4, rk23, or rk45 | time integrator | FDM/FEM CPU/GPU; strict FEM GPU here uses rk45 | `study.dynamics.integrator` |
| `StudyBuilder.solver.dt_initial` | `float \| None` | `None` | $\mathrm{s}$ | positive and between dt_min and dt_max | initial adaptive timestep | FDM/FEM CPU/GPU where adaptive integrator is supported | `study.dynamics.adaptive_timestep.dt_initial` |
| `StudyBuilder.solver.dt_min` | `float \| None` | `None` | $\mathrm{s}$ | finite and greater than zero | minimum adaptive timestep | FDM/FEM CPU/GPU where adaptive integrator is supported | `study.dynamics.adaptive_timestep.dt_min` |
| `StudyBuilder.solver.dt_max` | `float \| None` | `None` | $\mathrm{s}$ | finite, positive, and not below dt_min | maximum adaptive timestep | FDM/FEM CPU/GPU where adaptive integrator is supported | `study.dynamics.adaptive_timestep.dt_max` |
| `StudyBuilder.solver.max_err` | `float \| None` | `None` | $1$ | finite and greater than zero; required by convenience adaptive controls | embedded vector-error budget | FDM/FEM CPU/GPU where adaptive integrator is supported | `study.dynamics.adaptive_timestep.atol` |
| `StudyBuilder.solver.g` | `float \| None` | `None` | $1$ | finite and greater than zero; mutually exclusive with gamma | electron g-factor normalized to the stored gyromagnetic ratio | FDM/FEM CPU/GPU | `study.dynamics.gyromagnetic_ratio (normalized from g; g is not stored)` |
| `StudyStagesBuilder.add_run.until` | `float \| None` | `required` | $\mathrm{s}$ | finite and greater than zero | physical stage end time | FDM/FEM CPU/GPU | `canonical stage exporter stages[0].default_until_seconds; ProblemIR metadata problem_meta.runtime_metadata.study_pipeline.nodes[0].payload.until_seconds` |

(problem-ir)=
## 10.2. ProblemIR i granica planu

| Authoring | Kanoniczny cel |
|---|---|
| `study.engine("fem")` | `backend_policy.requested_backend = "fem"` |
| `study.device("gpu", precision="double")` | znormalizowane requested device jest authoring metadata w `problem_meta.runtime_metadata.runtime_selection.device = "cuda"`; precyzja trafia do `backend_policy.execution_precision = "double"` |
| `study.mode("strict")` | `validation_profile.execution_mode = "strict"` |
| `study.universe(...)` i `study.universe.mesh(...)` | authoring metadata w `problem_meta.runtime_metadata.study_universe`; `airbox_hmax` nie jest polem FEM solver hint |
| `film.mesh(..., order=1)` | authored per-object recipe w `problem_meta.runtime_metadata.mesh_workflow.per_geometry[0]`; znormalizowany wspólny hint tego przykładu jest osobno w `backend_policy.discretization_hints.fem` |
| `study.exchange(enabled=True)` | obecność wpisu `{"kind": "exchange"}` w `energy_terms[]`; w IR nie istnieje `exchange.enabled` |
| `study.demag(realization="poisson_robin")` | `energy_terms[kind=demag].realization = "poisson_robin"` |
| `study.fem_demag_solver(...)` | `backend_policy.discretization_hints.fem.demag_solver_policy` |
| `study.solver(g=2.115, ...)` | `g` jest normalizowane do `study.dynamics.gyromagnetic_ratio`; oryginalne `g` nie jest przechowywane |
| `study.stages.add_run(until=...)` | `until` należy do kanonicznego eksportera etapów: `stages[0].default_until_seconds`; kopia stringowa pipeline jest w `problem_meta.runtime_metadata.study_pipeline.nodes[0].payload.until_seconds`, nie w fizycznym `study` |

Semantyczny checker wycina powyższy blok z tej strony i uruchamia repozytoryjny
`export-run-config --skip-geometry-assets`. Porównuje wszystkie 32 wartości z
rzeczywistym ProblemIR 0.3 i dokumentem `study_pipeline.v1`; nie akceptuje samej
obecności nazwy lub ręcznie ukształtowanego JSON. ProblemIR zachowuje semantykę
fizyczną i requested intent. Planner wylicza
required/resolved masks, lecz nie może wpisać ich jako executed state.
Executed receipt pochodzi wyłącznie z natywnego ABI po zaakceptowanej próbie,
a Rust przenosi go bez rekonstrukcji z planu do provenance i artefaktów.

(round-trip-and-failure-semantics)=
## 10.3. Round-trip i semantyka odrzuceń

Eksport UI→Python zachowuje engine, precision, strict mode, interakcje, solver
i stage. Requested intent oraz resolved execution pozostają rozdzielone.
Validation errors obejmują nieznany bit, host/unknown operator, brak required
operatora, fallback, brak zaakceptowanego kroku i transfer compute w strict.
Unsupported combinations — w szczególności forced GPU z
`hybrid_cpu_poisson`, `fe_order>1` albo nieobsługiwanym modelem demag — są
odrzucane przed publikacją wyniku i nigdy nie są zamieniane na silent hybrid.

## 11. Validation Matrix

The canonical audit matrix is:

- `docs/reports/16.05.2026/fullmag_fem_cpu_validation_matrix.md`

Long-lived implementation must keep equivalent gates in tests or benchmark
artifacts. Static source tests are acceptable only for contracts that cannot run
without an MFEM host. They do not replace numerical validation for production
qualification.

## 12. Completeness Checklist

- [ ] Each native FEM interaction has a documented energy or torque contract.
- [ ] Each energy-derived field has a directional derivative test.
- [ ] Demag has analytical and airbox convergence benchmarks.
- [ ] `fe_order > 1` is rejected until high-order support is real.
- [ ] CPU and GPU lanes share physics semantics.
- [ ] Hot paths have no avoidable heap allocation.
- [ ] Capability matrix entries distinguish executable from validated.
- [ ] Mixed-P1 lanes remain below `production_executable` until the implemented
  topology-specific operators pass the managed runtime and artifact gates.
- [ ] Runtime artifacts preserve operator telemetry and solver provenance.

(limitations)=
## 13. Deferred Work

- Full high-order FEM contract.
- Production FEM GPU parity.
- FEM-BEM/FMM/Fredkin-Koehler demag alternatives.
- Full STT/SOT transport-coupled validation.
- Two-way magnetoelastic coupling.

(scientific-bibliography)=
## 14. Bibliografia naukowa

- W. F. Brown Jr., *Micromagnetics*, Interscience, 1963, ISBN 978-0-471-11040-2.
- T. L. Gilbert, “A phenomenological theory of damping in ferromagnetic
  materials”, *IEEE Transactions on Magnetics* 40(6), 2004,
  [doi:10.1109/TMAG.2004.836740](https://doi.org/10.1109/TMAG.2004.836740).
- R. Hiptmair, “Finite elements in computational electromagnetism”, *Acta
  Numerica* 11, 2002,
  [doi:10.1017/S0962492902000041](https://doi.org/10.1017/S0962492902000041).
- R. D. Falgout, U. M. Yang, “hypre: A Library of High Performance
  Preconditioners”, *Computational Science — ICCS 2002*,
  [doi:10.1007/3-540-47789-6_66](https://doi.org/10.1007/3-540-47789-6_66).

(source-code-index)=
## 15. Indeks kodu źródłowego

| Claim | Path | Symbol | Odpowiedzialność | Lane / evidence |
|---|---|---|---|---|
| Stage-first Python authoring | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | buduje kanoniczny study workflow | Python/ProblemIR, source |
| Etapy Python | `packages/fullmag-py/src/fullmag/world.py` | `class StudyStagesBuilder` | waliduje `add_run(until)` i kolejność etapów | Python/ProblemIR, source |
| Lowering ProblemIR | `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | serializuje geometry, materials, magnets, study i runtime metadata do ProblemIR 0.3 | Python/ProblemIR, wykonany przykład |
| Eksporter etapów | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `export_study_pipeline_document` | zapisuje `study_pipeline.v1` i granicę `until` | stage/runtime authoring, wykonany przykład |
| Domena Python | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseHandle` | zapisuje manual universe i mesh airbox | FEM CPU/GPU, source |
| Magnet Python | `packages/fullmag-py/src/fullmag/world.py` | `class MagnetHandle` | przenosi materiał, m0 i mesh geometrii | FDM/FEM CPU/GPU, source |
| Mesh geometrii Python | `packages/fullmag-py/src/fullmag/world.py` | `class GeometryMeshHandle` | waliduje hmax i order | FEM CPU/GPU, source |
| Bryła Box | `packages/fullmag-py/src/fullmag/model/geometry.py` | `class Box` | waliduje dodatni rozmiar i nazwę | FDM/FEM CPU/GPU, source |
| Jednorodne m0 | `packages/fullmag-py/src/fullmag/init/magnetization.py` | `class UniformMagnetization` | obniża trzykomponentowy wektor m0 | FDM/FEM CPU/GPU, source |
| Polityka liniowa FEM | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | waliduje solver, preconditioner i tolerancje | FEM CPU/GPU, source |
| CPU LLG | `backends/fem/cpu/mfem/integrators/llg_rhs.cpp` | `llg_rhs_aos` | realizuje równanie LLG na FEM CPU | FEM CPU, source/native contracts |
| GPU LLG | `backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu` | `fullmag_cuda_llg_rhs_fused` | realizuje RHS LLG na CUDA | FEM GPU, wymaga managed runtime |
| RHS demag Poisson | `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp` | `assemble_demag_poisson_rhs` | składa prawą stronę słabej postaci | FEM CPU, kontrakt współdzielony semantycznie z GPU |
| Recovery demag | `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` | `recover_demag_poisson_field` | odzyskuje $\mathbf{H}_{\mathrm{demag}}$ z potencjału | FEM CPU, kontrakt znaku |
| Energia demag | `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp` | `demag_poisson_energy_from_field` | liczy energię z odzyskanego pola | FEM CPU/GPU wspólny kontrakt znaku |
| Plan GPU RK | `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` | `gpu_rk_plan_device_resident` | wyznacza required/resolved masks i klasę | FEM GPU, plan nie jest execution |
| Atomic receipt | `backends/fem/gpu/cuda/runtime/execution_receipt.cpp` | `gpu_execution_receipt_commit_attempt` | publikuje ostatnią zaakceptowaną próbę | FEM GPU, native contract |
| ABI receipt v1 | `backends/fem/src/api.cpp` | `fullmag_fem_backend_gpu_execution_receipt_v1` | fail-closed handshake i snapshot ABI | FEM GPU, ABI contract |
| Walidacja Rust | `crates/fullmag-runner/src/fem/execution_receipt.rs` | `validate_strict_fem_gpu_execution_receipt` | odrzuca naruszenia strict bez rekonstrukcji planu | runner/provenance |
| Kwalifikacja natywna | `backends/fem/tests/llg_time_domain_qualification.cpp` | `main` | uruchamia kwalifikację wymagającą ABI v1, pełnych masek i zerowych transferów | FEM GPU, managed gate |
| Source-bound comparator | `scripts/compare_fem_llg_time_domain_qualification.py` | `validate_gpu_execution_receipt` | odrzuca brak receipt, hybrid i niepełne IDs | CPU/GPU parity |
| Testy komparatora | `scripts/test_compare_fem_llg_time_domain_qualification.py` | `class ComparatorBehaviorTests` | wykonują funkcję i CLI dla positive oraz fail-closed cases | trwały behavioral gate |
| Semantyczny checker loweringu | `scripts/check_llg_time_domain_contract_docs.py` | `_lowered_example_values` | wykonuje przykład strony przez `export-run-config` i porównuje wszystkie 32 mapowania | ProblemIR/stage pipeline, behavioral gate |
| Managed recipe | `justfile` | `verify-fem-llg-time-domain-qualification-gpu` | zapisuje hash źródeł i uruchamia GPU gate | container-first; bez fresh pass brak promocji |
