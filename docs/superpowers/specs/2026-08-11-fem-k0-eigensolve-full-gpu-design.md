# Produkcyjny FEM eigensolve K0 z demagnetyzacją, w pełni rezydentny na GPU

Data: 2026-08-11  
Status: zatwierdzony projekt, zrewidowany po audycie kodu i masterplanu
Dokument wykonawczy: `docs/superpowers/plans/2026-08-11-fem-k0-eigensolve-full-gpu-implementation.md`

## 1. Decyzja i cel

Produkcję realizuje istniejący adapter
`backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc`.
Nie powstaje drugi eigensolver. Praca polega na utwardzeniu obecnej ścieżki
PETSc/SLEPc CUDA, domknięciu jej lifecycle, pomiarów i kontraktów oraz na jej
kwalifikacji fizycznej i produktowej.

Celem jest FEM eigensolve K0 z demagnetyzacją Poisson-airbox, w którym:

- operator magnetyczny i zredukowany operator Schura są wykonywane na GPU;
- rozwiązania Poissona i preconditioner używają rzeczywistej polityki HYPRE
  device memory/device execution;
- `EPS`, `ST`, `KSP`, `PC`, `BV`, baza Kryłowa, wektory Ritz i wszystkie
  pełnowymiarowe workspace'y pozostają na urządzeniu przez cały solve;
- w pętli iteracyjnej nie występują pełnowektorowe transfery H2D/D2H,
  hostowe synchronizacje użyte do obliczeń ani host-projected Ritz solve;
- wynik zachowuje dokładnie tę samą fizykę, siatkę, równowagę, jednostki,
  konwencje i formaty modów co referencja CPU;
- ścisłe żądanie `device="gpu"` nigdy nie przechodzi niejawnie na CPU ani na
  ścieżkę hybrydową;
- spektrum i zespolone pola modów są publikowane przez istniejący resource-first
  API i wyświetlane w Results oraz zunifikowanym viewporcie Control Room.

Zakres obejmuje pojedynczy punkt K0, okno częstotliwości, wiele modów,
scenariusz `relax -> eigensolve`, bias-field sweep oraz referencyjny przypadek
okresowej warstwy z dziurą. FDM nie jest częścią tej realizacji.

Określenie „full-GPU” dotyczy stage'u eigensolve. Workflow, w którym relaksacja
CPU przekazuje stan do eigensolve GPU, jest poprawnym hybrydowym workflow
stage'ów, ale nie wolno nazywać całego workflow full-GPU.

## 2. Granica stanu bieżącego i docelowego

### 2.1. Co już istnieje

W aktualnym kodzie istnieją:

- Python DSL i ProblemIR dla `Eigenmodes`, K0, `periodic_airbox_k0`, okna
  częstotliwości, liczby modów, bias-field sweep oraz jawnego wyboru CPU/GPU;
- planner zachowujący requested/resolved execution i ścisły brak CPU fallbacku
  dla żądania GPU;
- wspólna siatka magnetyk-airbox, identity siatki i handoff
  `relax -> eigensolve` bez zamierzonego ponownego meshowania;
- referencyjny CPU selected-spectrum z fizycznym shared-domain assembly;
- produkcyjnie przeznaczony adapter GPU tworzący `VECCUDA`,
  `MATSEQAIJCUSPARSE`, `EPSKRYLOVSCHUR`, `STSINVERT`, `KSPGMRES` oraz
  `PCHYPRE`/BoomerAMG;
- zapis `spectrum.v2`, diagnostyki, zespolonych pól modów,
  `source_mesh_identity` i ich publikacja przez API;
- Results/Inspector, wybór modu oraz revision- i topology-bound handoff pola
  modu do jednego viewportu.

To jest realny postęp źródłowy, ale nie jest jeszcze dowodem produkcyjnej
realizacji GPU.

### 2.2. Dlaczego status GPU nadal jest `source_visible / unvalidated`

Aktualne źródła mają cztery krytyczne luki prawdomówności:

1. `modal_petsc_slepc.cpp::write_success_diagnostics` publikuje zera transferów,
   ale równocześnie `per_iteration_transfer_telemetry_measured=false`. Zera bez
   pomiaru nie dowodzą braku transferów.
2. `crates/fullmag-runner/src/fem_eigen.rs::native_solver_diagnostics_json` i
   `insert_native_poisson_airbox_execution_provenance` potrafią wyprowadzić
   `implementation_state="executable"`, production claim i
   `device_residency="gpu_device_resident"` z samej nazwy adaptera. Runner nie
   może sam poświadczać wykonania natywnego.
3. Modalny `PCHYPRE` nie ustawia i nie poświadcza jawnie
   `HYPRE_MEMORY_DEVICE` oraz `HYPRE_EXEC_DEVICE`. Analogiczna konfiguracja
   istnieje w time-domain, ale nie jest dowodem dla obiektu PC użytego przez
   eigensolver.
4. Bieżący test GPU K0 jest małym, materializowanym oracle. Nie dowodzi
   produkcyjnej ścieżki matrix-free, kompletności okna ani rezydencji dla
   problemu o `operator_dimension > 1024`.

Do czasu zamknięcia tych luk capability matrix oraz dokumentacja fizyczna nie
mogą promować GPU do `executable` ani `production_qualified`.

## 3. Dokładny kwalifikowany zakres fizyczny

Pierwsza produkcyjna promocja dotyczy wyłącznie następującego przecięcia:

| Wymiar | Zakwalifikowana wartość |
|---|---|
| Backend | FEM |
| Urządzenie | NVIDIA CUDA, double precision |
| Fala | dokładnie K0 |
| Geometria okresowa | okresowe x/y, kierunek z otwarty dla airbox |
| Mesh | jedna wspólna siatka magnetyk-airbox, P1, elementy tet4 lub prism6 |
| Model demag | `periodic_airbox_k0`, ten sam BC/gauge tuple co CPU |
| Operator | `full_2x2`, exchange + Zeeman + dynamic demag |
| Exchange | natywny MFEM weak form, jednorodny skalarny `A_ex` w pierwszym scope |
| Damping | `alpha = 0` dla modalnego problemu własnego |
| Target | `real_frequency_rotated`, `tau = omega_target` |
| Spectrum | finite positive physical modes w zadanym oknie |
| Artefakty | `spectrum.v2`, diagnostyka z `eps_phi` oraz publiczne zespolone `delta_m` |

Anizotropia i DMI są poza pierwszą promocją, ponieważ aktualny natywny
shared-domain producer nie certyfikuje ich weak forms. Heterogeniczny exchange,
inne rzędy FE, niezerowe K, w pełni okresowe 3D, single precision i inne modele
demag wymagają osobnego rozszerzenia noty fizycznej, capability scope i
kwalifikacji. Planner ma je odrzucać przed alokacją GPU stabilnym reason tokenem.

Zakres jest celowo precyzyjny. „Full GPU” opisuje miejsce wykonywania
zakwalifikowanego algorytmu, a nie rozszerza samoczynnie zakresu fizyki.

## 4. Nienaruszalny kontrakt fizyczny

Realizacja GPU zachowuje kontrakt z
`docs/physics/0830-fem-poisson-airbox-modal-eigen.md`:

- ta sama zaakceptowana równowaga i ta sama siatka wspólnej domeny;
- K0 i pełne klasy równoważności węzłów zgodne z certyfikatem siatki v6;
- identyczne `A_qq`, `A_qphi`, `A_phiq`, `A_phiphi`, `B_qq`, scaling oraz
  ordering jak w referencji CPU;
- identyczny znak pola demag, układ jednostek SI, konwencja fazora i mapowanie
  wartości własnej na częstotliwość;
- identyczne kryteria finite mode, positive branch, deduplikacji klastrów,
  kompletności okna i oryginalnych block residuals;
- brak ponownego meshowania, resamplingu i niejawnej interpolacji pomiędzy
  stage'ami;
- analityczna wartość Kittela jest wyłącznie postsolve oracle i nie wpływa na
  assembly, target, preconditioner, wybór gałęzi ani solver pass/fail.

Zamrożone ABI może zachować legacy slot na expected/reference frequency, lecz
produkcja wymaga jego wartości zerowej i nigdy go nie odczytuje. Niezerowa
wartość jest legalna wyłącznie w jawnie `validation_only` syntetycznym oracle.
Mutacja lub usunięcie wszystkich danych Kittela nie może zmienić digestu
operatora, target/window, surowych modów, solver status ani residual
certification.

GPU jest osobną realizacją numeryczną wspólnego kontraktu, nie osobnym modelem
fizycznym.

## 5. Architektura i właściciele

### 5.1. Stos wykonawczy

- PETSc: `VECCUDA`, AIJ cuSPARSE dla jawnych bloków i `MatShell` dla
  produkcyjnego zredukowanego operatora;
- SLEPc: Krylov-Schur, shift-invert, device-resident `BV` i Ritz vectors;
- HYPRE CUDA: Poisson airbox i skalowalny preconditioner;
- MFEM: wspólne fizyczne assembly i mapy true DOF;
- repozytoryjny managed runtime i container-backed recepty `just`.

`backends/fem/gpu/cuda/frequency_domain/modal_krylov.cu` pozostaje
validation-only host-Ritz oracle i nie może zostać przemianowany ani promowany
do produkcyjnej ścieżki.

### 5.2. Granice modułów

- `backends/fem/cpu/frequency_domain` jest CPU oracle i właścicielem CPU solve;
- `backends/fem/gpu/frequency_domain` posiada adapter SLEPc, lifecycle,
  residency checks, telemetrykę i result attestation;
- `backends/fem/gpu/cuda/frequency_domain` posiada własne device kernels i
  workspace'y operatora;
- współdzielona, mała warstwa GPU runtime policy posiada konfigurację i
  odczyt attestation HYPRE device; nie wolno duplikować globalnej polityki
  HYPRE między time-domain i frequency-domain;
- `native/include/fullmag_fem.h` oraz `crates/fullmag-fem-sys` zachowują
  zamrożone v18 i definiują osobny caller-sized ABI v19;
- Rust runner serializuje natywny wynik i egzekwuje fail-closed, ale nie
  syntetyzuje claimów wykonawczych;
- API publikuje typowane zasoby; React konsumuje je wyłącznie przez centralny
  klient i resource hooks.

Nie wolno dodawać solvera do `dispatch.rs`, `Context` ani `mfem_bridge.cpp`.

## 6. Lifecycle kontekstu GPU

Procesowy global `cached_gpu_context` nie jest docelowym właścicielem. Docelowy
`GpuModalSessionContext` jest własnością dokładnego stage/session execution.
Ma dwa length-prefixed, SHA-256 klucze:

- `OperatorKey`: CUDA device UUID, precision/scalar representation, mesh
  generation/revision/topology, certificate/map binding, equilibrium,
  linearization, material, physics, operator terms, boundary, gauge,
  bias-field sample, FE family/order, demag/Poisson i matrix-free operator
  policy;
- `TargetKey`: `OperatorKey` digest, target/window/subwindow, liczba modów,
  spectral transform/shift, tolerancje, iteration limits, EPS/KSP/PC policy i
  artifact-completeness policy.

Kontekst posiada przez pełne okno solve:

- device blocks, mapy redukcji, tangent frames i masy;
- Poisson `KSP`/`PC` i ich workspace;
- `MatShell`, mass matrix, `EPS`, `ST`, shifted `KSP`/`PC`;
- `BV`, basis, Ritz, locking/restart state;
- residual/reconstruction/export workspace;
- telemetrykę alokacji, transferów i synchronizacji.

Zmiana pola `OperatorKey` niszczy OperatorState i TargetState. Zmiana wyłącznie
`TargetKey` zachowuje OperatorState i odtwarza TargetState. Device loss niszczy
oba; cancel/error co najmniej niszczy TargetState. Każda operacja publikuje
generation/reuse/rebuild counters, invalidation flags i stabilny reason. Zmiana
subwindowu nie może bez powodu przesłać ponownie niezmiennych bloków operatora.
Destroy jest idempotentny dla stanu częściowego i pełnego.

Produkcja używa wyłącznie matrix-free Schur. Materializowany shifted operator
i `PCILU` są dozwolone tylko dla jawnie oznaczonego `validation_only=true`
oracle o ograniczonym rozmiarze. Taki wynik nigdy nie ustawia
`scalable_selected_spectrum=true` ani capability produkcyjnej.

## 7. Handoff `relax -> eigensolve`

Handoff jest testowalną granicą stage, nie luźnym przekazaniem tablicy:

1. Relax publikuje zaakceptowaną magnetyzację, equilibrium ID, content SHA-256,
   mesh generation/revision, topology fingerprint i certificate binding.
2. Eigensolve ponownie sprawdza identity, indexing, node count, part registry,
   magnetic/scalar equivalence classes, BC/gauge i operator input signature.
3. Jednorazowy upload setup obejmuje dokładnie frozen mesh/material/equilibrium
   i mapy redukcji. Każdy upload jest liczony w fazie `setup`.
4. Po rozpoczęciu hot loop pełny readback magnetyzacji, potencjału, Ritz vector
   lub Krylov workspace jest zakazany.
5. Final export pobiera wyłącznie wartości własne i zaakceptowane końcowe pola
   modów. Transfery eksportu są liczone osobno i wiązane z mode IDs.
6. `source_mesh_identity` w każdym mode musi być bitowo zgodne z tożsamością
   wejścia. Brak zgodności unieważnia stage i nie może być naprawiony przez
   resampling.

## 8. Kontrakt pełnej rezydencji i pomiaru

### 8.1. Reguła prawdomówności

Każda metryka rezydencji ma stan `measured`, `unavailable` albo `failed`.
Wartość zero jest ważna wyłącznie przy `measured`. `unavailable` nie jest
zerem i blokuje ukończenie ścisłego GPU stage.

Per-run `native_device_residency_attested=true` wolno ustawić tylko, gdy
wszystkie poniższe dowody native dotyczą dokładnie wykonanego solve i jego
runtime digest:

- rzeczywisty device UUID, nazwa, compute capability, driver i CUDA runtime;
- PETSc device type dla każdego rozwiązaniowego i Fullmag-owned `Vec` oraz
  `MatShell` default vec type; wewnętrzne work vectors biblioteki są
  kwalifikowane przez publiczne type hooks tam, gdzie istnieją, oraz przez
  external allocation/transfer trace bez używania prywatnego ABI PETSc;
- typy każdej jawnej `Mat` i preconditioner matrix;
- typ każdego `BV` column i Ritz vector;
- HYPRE memory location `device` i execution policy `device` dla modalnego PC;
- zmierzone setup/hot-loop/export H2D/D2H count i bytes, rozdzielone na state,
  telemetry i final export;
- zmierzona liczba hot-loop full-vector crossings, computational host
  synchronizations, scalar telemetry synchronizations i hot-loop allocations;
- peak device memory oraz baseline/final memory dla leak check;
- brak CPU fallbacku, host-projected solve i niezapowiedzianej zmiany adaptera;
- immutable qualification registry zawiera rekord kluczowany dokładnym runtime
  manifest digest oraz tym samym build/source/device-policy scope.

Zewnętrzny trace nie jest uruchamiany przy każdym zwykłym solve produkcyjnym.
Jest obowiązkowy dla qualification runów danego runtime build i przypadków
K0-G3.
Po tych runach evidence assembler wiąże trace z native attestation i runtime
manifestem. Zmiana source snapshot, runtime digest, wersji bibliotek, device
policy albo kwalifikowanego device class unieważnia to powiązanie i wymaga
ponownej kwalifikacji. Dopiero artifact-level qualification record może
opublikować `gpu_device_resident_modal_eigensolver=true` jako claim
produkcyjnego runtime.

### 8.2. Fazy transferów

| Faza | Dozwolone | Niedozwolone |
|---|---|---|
| `setup` | jednorazowy upload frozen input i tworzenie device objects | powtarzane uploady wynikające z błędnego lifecycle |
| `hot_loop` | bounded scalars progress/reason/timing, których payload nie skaluje się z DOF | pełne wektory, hostowe orthogonalization/Ritz, obliczeniowy readback, computational host sync |
| `export` | eigenvalues i zaakceptowane końcowe mode fields | eksport odrzuconych/niecertyfikowanych work vectors |

Native self-report i zewnętrzny trace mają osobne SHA-256 i outcome. Ich
rozbieżność daje `k0_poisson_airbox_gpu_transfer_audit_failed`.

### 8.3. Attestation native

Zamrożony, zwracany przez wartość symbol
`fullmag_fem_modal_eigen_solve` i layout `FullmagFemFrequencyDomainResult` v18
pozostają bitowo bez zmian. Dopisanie taila do struct zwracanego przez wartość
nie jest bezpiecznym rozszerzeniem ABI, ponieważ odbiorca nie może podać swojego
rozmiaru przed wywołaniem.

Nowy symbol v19 przyjmuje caller-sized out-parameter i zwraca status:

```c
int fullmag_fem_modal_eigen_solve_v19(
    const FullmagFemModalEigenRequest *request,
    FullmagFemFrequencyDomainResultV19 *out_result);
```

`FullmagFemFrequencyDomainResultV19` ma `abi_version`, `struct_size`,
kompatybilny wynik naukowy oraz owned opaque/typed sidecar
`FullmagFemModalGpuAttestationV1`. Strict production GPU wymaga symbolu v19;
legacy v18 może obsługiwać CPU i validation-only, ale nie może poświadczyć
full-GPU. Osobny destroy v19 jest idempotentny. Manifest ABI publikuje wszystkie
size/offset, a cross-version test uruchamia starego v18 producenta/odbiorcę.

Attestation v19 zawiera co najmniej:

- `measurement_state`, `measurement_coverage`,
  `device_residency_verified`, `fallback_state`;
- identity urządzenia i wersje MFEM/PETSc/SLEPc/HYPRE/CUDA;
- typy `Vec`, `Mat`, `MatShell`, `BV`, `EPS`, `ST`, `KSP`, `PC`;
- HYPRE memory/execution policy;
- count/bytes dla setup, hot-loop computational state, scalar telemetry i
  export;
- hot-loop allocations, computational syncs, scalar telemetry syncs i
  full-vector crossings;
- device-memory baseline, peak i final;
- production/validation flags, operator kind i zmierzony operator dimension;
- pełne operator/target/session key digests, state generations, reuse/rebuild
  counters, invalidation flags i reason;
- operator/Poisson/PC/EPS iteration counters i convergence reasons;
- object-graph attestation digest i native trace digest;
- source commit, source snapshot digest, runtime manifest digest i device UUID.

Runner publikuje te wartości bez domyślnych promocji. External trace digest i
qualification outcome są dodawane później w evidence/artifact envelope, nie do
native result zwracanego przed zakończeniem profilu. Brak sidecara, nieznana
wersja, niepełny prefix, `measurement_state != measured`, brak digestu albo
niezgodność hashy blokują completion i production claim.
Native boundary i Rust parser sprawdzają pointer, `abi_version` i `struct_size`
przed odczytem pierwszego pola poza headerem; dla V1 wymagają co najmniej pełnego
rozmiaru V1. Nieznana wersja lub krótszy sidecar są odrzucane fail-closed bez
dereferencji taila, a envelope nadal jest zwalniany wyłącznie przez destroy v19.

## 9. HYPRE device policy

Konfiguracja wykorzystuje jeden współdzielony, idempotentny właściciel polityki
HYPRE CUDA. Właściciel:

1. ustawia `HYPRE_SetMemoryLocation(HYPRE_MEMORY_DEVICE)`;
2. ustawia `HYPRE_SetExecutionPolicy(HYPRE_EXEC_DEVICE)`;
3. ustawia wymagane vendor kernels zgodnie z obsługiwaną wersją HYPRE;
4. zwraca typowany snapshot ustawień i reason przy błędzie;
5. jest wywoływany przed stworzeniem modalnego `PCHYPRE`;
6. umożliwia odczyt/poświadczenie polityki dokładnie dla wykonanego adaptera.

Sam fakt, że time-domain solver używa HYPRE device, nie jest dowodem dla
frequency-domain. Test musi przejść przez modalny `MatShell -> KSP -> PCHYPRE ->
Poisson` object graph.

## 10. Fail-closed i statusy

### 10.1. Preflight przed solve

Stage kończy się błędem przed alokacją, gdy:

- host i kontener nie widzą tego samego urządzenia NVIDIA;
- PETSc/SLEPc nie mają CUDA albo HYPRE nie ma device policy;
- snapshot źródeł nie odpowiada managed runtime;
- żądanie wykracza poza zakres z sekcji 3;
- mesh, certificate, equilibrium, material lub boundary/gauge digest są
  niepełne albo niezgodne;
- brakuje miejsca pamięci dla admission estimate;
- żądanie GPU nie rozstrzyga się na produkcyjny adapter GPU.

### 10.2. Błędy w czasie solve

Naruszenie rezydencji, brak pomiaru, błąd subwindowu, niezbieżność, NaN/Inf,
przekroczony residual, cancel, utrata urządzenia lub niezgodność trace kończą
stage bez CPU fallbacku. Partial modes mogą zostać zachowane wyłącznie jako
`complete=false`, z certyfikatem każdego zachowanego modu i dokładnym stop
reason.

### 10.3. Minimalne stabilne reason tokens

- `k0_poisson_airbox_gpu_preflight_failed`
- `k0_poisson_airbox_gpu_runtime_source_mismatch`
- `k0_poisson_airbox_gpu_attestation_abi_required`
- `k0_poisson_airbox_gpu_attestation_abi_mismatch`
- `k0_poisson_airbox_gpu_hypre_device_policy_unavailable`
- `k0_poisson_airbox_gpu_object_graph_not_device_resident`
- `k0_poisson_airbox_gpu_transfer_measurement_unavailable`
- `k0_poisson_airbox_gpu_transfer_audit_failed`
- `k0_poisson_airbox_gpu_persistent_context_unavailable`
- `k0_poisson_airbox_gpu_window_incomplete`
- `k0_poisson_airbox_gpu_full_residual_not_certified`
- `k0_poisson_airbox_gpu_solver_parity_failed`
- `k0_poisson_airbox_gpu_device_lost`
- `k0_poisson_airbox_gpu_cancelled`

Runner nie może zastępować tych przyczyn ogólnym sukcesem ani wyprowadzać
`implementation_state` z nazwy adaptera.

## 11. Artefakty, API i UI

### 11.1. Publikacja atomowa

Produkcja zapisuje najpierw unikalny immutable staging bundle. Po zakończeniu:

1. waliduje schematy, SHA-256, source/runtime/device binding i kompletność;
2. dla qualification runu wiąże external trace sidecary z attestation;
3. publikuje katalog finalny atomowym rename;
4. nigdy nie kasuje poprzedniego poprawnego report root przed nowym solve.

Wynik niekompletny pozostaje w osobnym failed/interrupted staging i nie zasłania
ostatniego ważnego bundle.

### 11.2. Wspólny format naukowy

CPU i GPU zapisują ten sam kontrakt:

- `frequency_domain/manifest.v1.json`;
- `eigen/spectrum.v2.json`;
- `eigen/diagnostics/solver.v1.json`;
- `eigen/modes/{sample_id}/{mode_id}.json`;
- `eigen/mode_fields.zarr/{sample_id}/{mode_id}/vector_xyz_complex/<chunk-key>`;
- `validation/k0_poisson_airbox/gpu_transfer_audit.v1.json`;
- `validation/k0_poisson_airbox/cpu_gpu_parity.v1.json`;
- `validation/k0_poisson_airbox/kittel_convergence.v2.json`;
- `validation/registrations/<producer_id>.v1.json`.

Każdy mode zawiera frequency, eigenvalue, cluster ID, multiplicity, residuale,
normalizację, phasor convention, zespolone `delta_m`, `source_mesh_identity`,
equilibrium/handoff digest oraz execution attestation ID. Zespolone `phi`
pozostaje natywnym workspace'em potrzebnym do rekonstrukcji i `eps_phi`; nie
jest publicznym polem Zarr ani widokiem UI pierwszej promocji. Jego brak w Zarr
nie jest brakiem mode field, lecz brak `eps_phi` jest błędem certyfikacji.

Każdy niezależny walidator publikuje osobny immutable derived validation bundle
i rejestruje swoje wyjścia przez `frequency_domain_validation_registration.v1`.
Source solve bundles są tylko do odczytu. Rejestr zawiera derived bundle ID,
identyfikator i wersję producenta oraz posortowane `source_runs`. Każdy wpis
`source_runs` wiąże dokładnie jeden `run_id`, immutable bundle URI/SHA-256,
kanoniczny `scope_id`, digest scope recordu i execution `cpu|gpu`; niezależne
listy run IDs i scope IDs są niedozwolone. Rejestr zawiera także posortowane
`subject_scope_bindings` oraz posortowaną listę artefaktów z relatywną ścieżką,
schema version, rozmiarem, SHA-256 i wiązaniem `direct` albo `coverage`.
Bundle URI jest normalną ścieżką `runs/...` względem stałego source report root,
a jego SHA-256 jest digestem finalnego source manifestu wiążącego artefakty.
Pierwsza wersja używa scope IDs
`modal_cpu_k0_periodic_airbox_real_shared_domain.production` i
`modal_gpu_k0_periodic_airbox_scalable.production`. Ścieżka jest zawsze
względna względem derived bundle root;
ścieżki absolutne, `..`, symlinki, hardlinki, duplikaty i brakujący sidecar są
odrzucane. Wiązanie `coverage` wymaga osobnego, zahashowanego coverage-rule
artefaktu wyliczającego wszystkie objęte scope/run IDs. Runner i core artifact
writer weryfikują ten mechaniczny kontrakt, ale nie importują algorytmu Kittela,
parity ani innego walidatora naukowego. Kittel, CPU/GPU parity i antydot E2E
publikują trzy osobne registrations.

### 11.3. Typowany API v2

`FrequencyDomainDiagnosticsArtifactPayload` nie może pozostawiać GPU evidence w
nieustrukturyzowanym `FrequencyDomainArtifactExtras`. OpenAPI definiuje typy:

- `FrequencyDomainExecutionAttestationPayload`;
- `FrequencyDomainGpuDeviceIdentityPayload`;
- `FrequencyDomainGpuObjectGraphPayload`;
- `FrequencyDomainGpuTransferAuditPayload`;
- `FrequencyDomainSolverProgressPayload`;
- `FrequencyDomainQualificationScopeBindingPayload`;
- `FrequencyDomainQualificationAttestationPayload`.

Ciężkie pola modów pozostają na binarnym data plane. Status sesji pozostaje
cienki i revision-driven.

### 11.4. Dwutożsamościowa promocja

Kwalifikacja ma dwie niezamienne tożsamości:

1. `R1` — czysty commit, z którego zbudowano runtime i na którym zebrano
   CPU/GPU/browser evidence oraz immutable scientific candidate manifest;
2. `G2-governance` — późniejszy commit zmieniający wyłącznie allowlistowane
   capability/readiness/docs po przyjęciu candidate manifestu.

Po commicie `G2-governance` zewnętrzny, niedestrukcyjny publisher przygotowuje
niekanoniczny release tree z `promotion_attestation.v1.json`. Rekord wiąże pełne
OID obu commitów, runtime source snapshot i runtime manifest SHA-256,
root-relative ścieżkę i SHA-256 scientific manifestu, dokładne CPU/GPU scope
bindings jako
`scope_id` + digest kanonicznego scope recordu + execution, digest allowlist
diff oraz digest i outcome każdego verifier record. Nie jest to natywna solver
attestation i nie wymaga
ponownego solve ani przebudowy runtime. Brak pliku, nieznana wersja schematu,
niezgodny digest, scope lub outcome pozostawia produkt w stanie `unvalidated`.
Statyczny capability record sam nie wystarcza do zielonego statusu w API/UI.
Rzeczywisty typed API/UI smoke działa na prepared tree przez process-scoped
read-only qualification root. Dopiero pass record wiążący dokładny prepared-tree
digest pozwala atomowo rename'ować go do canonical `releases/`; failure nie
publikuje canonical release. Smoke record pozostaje zewnętrzną bramką rename i
nie jest dopisywany do testowanej attestation, więc nie tworzy self-hash cycle.
Handler rozwiązuje `scientific_manifest.relative_path` wyłącznie względem
`<configured_qualification_root>/<qualification_id>/`, wymaga normalnej ścieżki
bez `..`/symlinków i ponownie liczy SHA-256. Dlatego te same bajty przechodzą
smoke pod rootem `prepared` i odczyt produkcyjny pod rootem `releases`.

### 11.5. Results i viewport

Control Room wykorzystuje istniejące moduły Results i istniejący mode-field
handoff. Uzupełnienia obejmują:

- spectrum chart z jednostką Hz/GHz, residualem i cluster/multiplicity;
- tabelę modów z wyborem, normalizacją i statusem pola;
- Inspector `Execution & residency` z requested/resolved device, UUID,
  compute capability, wersjami bibliotek, object types, HYPRE policy,
  transferami, peak memory, fallback i attestation outcome;
- stage progress z subwindow, EPS iteration, converged pairs, current residual
  i cancel state;
- wizualizację zespolonego modu jako `real`, `imag`, `magnitude`, `phase` i
  `phase_rotated_real` oraz animację fazora na dokładnie tej samej topologii;
- jawny komunikat `unmeasured/unqualified` zamiast zielonego statusu przy
  brakujących danych.

Zmiana UI nie tworzy drugiego viewportu ani osobnych formatów CPU/GPU.

## 12. Bramki kwalifikacyjne K0-G0–K0-G9

Prefiks `K0-G` oznacza bramkę naukowo-runtime'ową tego slice'u. Nazwa
`G2-governance` oznacza osobny etap promocji masterplanu i nie jest bramką
`K0-G2`.

### K0-G0 — identity i preflight

- host i managed container raportują ten sam GPU UUID, nazwę i compute
  capability;
- `PetscDeviceInitialize(PETSC_DEVICE_CUDA)` przechodzi;
- source commit/snapshot digest odpowiada runtime manifestowi;
- brak dostępu do GPU daje oczekiwany fail-closed, nie skip udający pass.

### K0-G1 — kontrakty negatywne

Brak CUDA, CPU-backed Vec, zła polityka HYPRE, stale digest, nieobsługiwany
scope, NaN/count zero i próba fallbacku dają właściwe reason tokens przed solve.

### K0-G2 — runtime substrate

Realny modalny mini-problem przechodzi przez `MatShell + STSINVERT + KSP +
PCHYPRE + BV`, a test sprawdza cały object graph, nie tylko jeden Vec i jedną
kolumnę BV.

### K0-G3 — mierzona rezydencja

- `measurement_state=measured`;
- hot-loop computational-state H2D bytes = 0;
- hot-loop computational-state D2H bytes = 0;
- hot-loop full-vector crossings = 0;
- hot-loop computational host syncs = 0;
- każdy scalar telemetry payload ma najwyżej 256 bajtów, jego łączny count jest
  ograniczony liczbą callbacków monitora i nie skaluje się z DOF;
- native self-report i external trace są zgodne;
- trzy production matrix-free cases mają różne, zmierzone rzeczywiste
  `operator_dimension`, rosnące wraz z realnym meshem; co najmniej jeden ma
  `operator_dimension > 1024` i dowodzi ścieżki powyżej limitu
  materializowanego oracle. Etykieta tieru nie zastępuje wymiaru z artefaktu.

### K0-G4 — CPU oracle

CPU zwraca kompletne okno, finite positive modes, pełne block residuals i
niezależny certyfikat Kittela. Jest oracle dla K0-G5–K0-G7, nie fallbackiem.

### K0-G5 — fizyka GPU

GPU przechodzi manufactured/action parity, full residuals, Kittel field sweep,
mesh convergence i airbox-padding convergence bez analitycznej wartości w
solver input.

### K0-G6 — CPU/GPU parity

Porównanie jest cluster- i subspace-aware:

- relative frequency cluster delta `<= 1e-8` dla ścisłych parity fixtures;
- sine największego kąta invariant subspace `<= 1e-8`;
- relative delta zespolonych reconstructed mode fields `<= 1e-7` po
  dozwolonej phase/subspace alignment;
- porównuje multiplicity i cluster rank, a nie arbitralną kolejność wektorów.
- accepted/rejected outcome mismatch count = 0;
- oryginalne `eps_full <= 1e-8` oddzielnie na CPU i GPU.

### K0-G7 — Kittel i okresowy antydot

Gałąź Kittela wybierana jest przed odczytem reference, według mode shape:

- production uniform overlap `>= 0.95`;
- branch/subspace continuity `>= 0.85`;
- original full residual, tangent leakage i periodic seam mismatch `<= 1e-8`;
- maximum Kittel relative error `<= 2e-2`, median `<= 1e-2`;
- maximum finest-two mesh delta `<= 1e-2`;
- maximum finest-two airbox-truncation delta `<= 5e-3`;
- fitted `M_eff` mesh delta `<= 1e-2`;
- fitted `M_eff` truncation delta `<= 5e-3`;
- fitted `M_eff` relative error `<= 5e-3`;
- fitted relative standard uncertainty `<= 2.5e-3`;
- scaled-Jacobian condition number `<= 1e6`;
- Poisson original constraint residual `<= 1e-8`.

Antydot przechodzi pełne `relax -> eigensolve`, zachowuje bitowo zgodną
tożsamość siatki/równowagi, generuje niepuste spektrum i co najmniej wymagane
mode fields bez remeshu i fallbacku.

### K0-G8 — odporność i wydajność

Powtarzane uruchomienia, reuse/invalidation, cancel przed solve i w hot loop,
out-of-memory admission oraz device loss zachowują poprawny lifecycle i nie
wyciekają pamięci. Wydajność CPU/GPU jest raportowana dla tej samej fizyki,
tolerancji i artefaktów. Nie ma sztucznego minimalnego speedup gate, dopóki
osobna opublikowana decyzja nie ustali takiej wartości.

Sanitizery tworzą osobne sidecary dla `memcheck`, `racecheck` i `synccheck`.

### K0-G9 — UI i release

- OpenAPI/type generation i resource hooks przechodzą;
- Results pokazuje spektrum i attestation;
- wybór kilku modów pobiera właściwe pola binarne;
- browser smoke potwierdza widoczny canvas, aktywny WebGL context, niezerowy
  drawing buffer i topologię zgodną z `source_mesh_identity`;
- scientific candidate bundle jest składany z już zweryfikowanych bajtów w
  trwałym stagingu, bez ponownego uruchamiania producentów, a następnie
  immutable, atomowo publikowany i hash-bound do R1;
- browser capture przed assembly wiąże qualification/R1/runtime/source run IDs,
  ale nie zawiera własnego SHA ani przyszłego candidate SHA; zewnętrzny sidecar
  hashuje zamknięty capture, a osobny post-assembly record hashuje candidate bez
  jego mutacji;
- po governance-only promocji publisher przygotowuje dwutożsamościową
  attestation bez ponownego solve, uruchamia real API/UI smoke na prepared tree
  i dopiero po pass atomowo publikuje identyczne bajty; zgodność candidate, R1,
  `G2-governance`, scope i verifier records pozwala API/UI pokazać
  `production_qualified`.

## 13. Mapowanie do masterplanu

| Ten projekt | Masterplan | Znaczenie |
|---|---|---|
| exact scope i kontrakt | C1/C3 | legality, ABI, certificate binding |
| istniejący adapter GPU | N3 / K0-G1–K0-G4 | hardening, nie reimplementacja |
| native attestation | C3 + N3 | measured executed-path truth |
| immutable artifacts | A1S/A1E | schema i causally closed evidence |
| typed API | A2 | resource-first contract |
| Results/residency Inspector | U2 | spectrum, modes, provenance |
| CPU/GPU/Kittel/antidot | Q2 | physics i parity |
| browser/release proof | Q3 | product qualification |
| capability promotion | G2-governance | promocja dopiero po dowodach |

Nowy plan nie zastępuje masterplanu. Jest jego wykonawczym, węższym slice'em
dla zatwierdzonego full-GPU FEM K0.

## 14. Kolejność i równoległość

Kolejność krytyczna:

```text
scope/docs
  -> ABI + handoff contract
  -> HYPRE policy + object graph
  -> measured telemetry + lifecycle
  -> runner fail-closed + immutable artifacts
  -> typed API
  -> Results/Inspector
  -> integrated managed-runtime qualification
  -> G2-governance capability promotion
  -> external promotion attestation
```

Po zamrożeniu ABI mogą biec równolegle:

- lane Native GPU: HYPRE, object graph, telemetry, lifecycle;
- lane Validation: Kittel shape-first, parity i antidot validators;
- lane Product: typed OpenAPI, resource hooks i UI na zatwierdzonym schema;
- lane Evidence: preflight, immutable staging, sanitizer sidecary i release
  manifest.

Jeden integrator jest właścicielem `native/include/fullmag_fem.h`,
`crates/fullmag-fem-sys`, generated OpenAPI, `justfile` oraz końcowego managed
runtime. Agenci równolegli nie mogą jednocześnie edytować tych plików.

## 15. Kryteria ukończenia i granica claimu

Implementacja źródłowa jest ukończona, gdy wszystkie zadania planu mają testy
i przechodzą na zintegrowanym commicie. To nadal nie oznacza produkcyjnej
kwalifikacji.

Status `production_qualified` wolno nadać dopiero, gdy:

- K0-G0–K0-G9 przechodzą na realnym GPU i dokładnym managed runtime;
- attestation jest zmierzone, a external trace potwierdza zero hot-loop
  pełnowektorowych transferów;
- Kittel, CPU/GPU parity i antydot spełniają opublikowane tolerancje;
- UI pokazuje spectrum, mode fields oraz prawdziwy status rezydencji;
- evidence bundle jest immutable, kompletny i hash-bound;
- capability matrix zawęża claim do dokładnie wykonanego scope.

Kompilacja CUDA, obecność source, test syntetyczny, deklarowane zera transferów,
host build ani stary runtime bundle nie są dowodem produkcyjnym.

## 16. Aktualne blokery środowiskowe

W bieżącym środowisku kontener nie ma potwierdzonego dostępu do urządzenia
NVIDIA, a istniejący managed runtime nie odpowiada aktualnemu snapshotowi
źródeł. Istnieje także export lock, którego nie wolno usuwać bez host-wide
audytu właściciela i mountów.

Ponadto aktualny recovery branch nie zawiera bieżącego `master`; przed T1
obowiązkowa jest bramka `git merge-base --is-ancestor master HEAD` po
zabezpieczeniu zmian, audycie wszystkich worktree i kontrolowanej integracji
mastera. Żaden source/runtime qualification nie może opierać się na branchu
sprzed tej synchronizacji.

Te blokery nie zatrzymują prac źródłowych, testów negatywnych, schema i UI.
Blokują jednak K0-G0 oraz K0-G2–K0-G9, końcową parity, transfer trace,
wydajność i każdy claim `production_qualified`.

## 17. Poza zakresem

- drugi lub własny zamiennik SLEPc;
- promocja `modal_krylov.cu` albo gęstego/materializowanego oracle;
- full dense matrix dla problemów produkcyjnych;
- GPU single precision;
- niezerowe K, wszystkie modele demag, DMI i anizotropia;
- FDM;
- automatyczny GPU-to-CPU fallback;
- osobny viewport albo osobny format artefaktów GPU.
