# Produkcyjne domknięcie FEM eigensolve K0 z dynamicznym demag CPU/GPU oraz Control Room FMR

**Data audytu:** 2026-08-09
**Status dokumentu:** audyt stanu i wykonawczy plan produkcyjny; nie jest dowodem kwalifikacji
**Zakres źródłowy:** worktree `eigensolve-k0-demag-recovery`, gałąź `codex/eigensolve-k0-demag`
**HEAD audytu (snapshot historyczny):** `138d95325cee241fae1b6ffa44d3d7c883242cbf`
**Bieżący snapshot wykonawczy (2026-08-09):** `5acc73bd7046d5e93828d3c3a424eb83e939e5cc`
**Bieżący audyt i instrukcje etapowe:** `docs/superpowers/plans/2026-08-09-fem-k0-eigensolve-current-audit-and-execution.md`
**Snapshot źródeł runtime (`--ignore-non-runtime-dirty`):** `c019532792dc8b0e73bb9f42ce05c85e3e885fa1c626981dcbfc3e87177411ec`
**Digest brudnej zawartości runtime:** `b0ccb2e7442bb3f466e2d1d5ec452c9cd2cee697dc3b0338da419b22b5f24ce0`
**Dokument nadrzędny DoD:** `24_production_definition_of_done.md`
**Plan poprzedzający:** `docs/superpowers/plans/2026-07-12-fem-k0-demag-final-production.md`

**Rewizja wykonawcza 2026-08-09:** C3 publiczny ABI v18 z deskryptorem
`FullmagFemModalLinearizationDescriptor` ma zaakceptowany source/ABI review
(pełny caller-buffer gate v3, spójny v2 slot, digest binding i exact
exchange `NULL/count`); managed native runtime pozostaje zablokowany. A2
resource invalidation jest source-approved, a U1 ma osobne Results/Inspector
węzły `resonance-fits` i `kittel-fit`, fail-closed `missing/partial/corrupt` i
331/331 focused GREEN. N1 nadal nie dostarcza authoritative descriptor ani
natywnego MFEM `A_qq`; CPU/GPU i UI nie są production-qualified. Szczegółowy
stan, inwentaryzacja 39 worktree, zależności i komendy etapowe są w
`docs/superpowers/plans/2026-08-09-fem-k0-eigensolve-current-audit-and-execution.md`.

> **Instrukcja dla wykonawców agentowych:** przed wykonaniem zadania należy użyć
> odpowiednich umiejętności repozytorium: `using-git-worktrees`,
> `scientific-documentation-contract`, `physics-publication`,
> `backend-golden-masterplan`, `fem-native-backend-architecture`,
> `problem-ir-design`, `resource-first-api-check`,
> `frontend-v2-module-architecture`, `frontend-v2-state-hygiene`,
> `frontend-v2-viewport-lifecycle`, `test-driven-development` oraz
> `verification-before-completion`. Zadania rozdzielone poniżej mają wyłączne
> zakresy własności plików. Agent nie może samowolnie rozszerzać zakresu ani
> promować komórki capability na podstawie obecności kodu.

## 1. Cel, architektura i kryterium sukcesu

Celem jest produkcyjne domknięcie **FEM modalnego eigensolvera dla dokładnego
`k=0` z dynamicznym demag Poisson-airbox**, osobno dla CPU i GPU, oraz
dostarczenie w jednym Control Room:

1. widma modów dla pojedynczego pola;
2. widma zależnego od pola bias, z każdym punktem rozwiązanym z niezależnego
   fizycznego stanu i równowagi;
3. widoków modalnych rezonansów, odpowiedzi wymuszonej FMR oraz jawnego
   porównania tych dwóch różnych produktów;
4. wyboru modu z wykresu, tabeli lub drzewa;
5. wizualizacji zespolonego pola modowego w jednym zunifikowanym viewport 3D;
6. pełnej proweniencji requested/resolved CPU/GPU, certyfikatów, reszt,
   kompletności okna, zakresu walidacji i statusu kwalifikacji;
7. niezmiennego release bundle zamykającego `DOD-01`–`DOD-14` dla dwóch
   oddzielnych zakresów: CPU oraz GPU.

Architektura docelowa pozostaje warstwowa:

```text
Python DSL / UI authoring
  -> ProblemIR: fizyka + jawny bias-field scan
  -> walidacja i planner legalności
  -> certyfikaty equilibrium / mesh / periodicity / BC / gauge
  -> wspólny backend-neutral request i ABI
  -> natywne MFEM shared-domain assembly
       -> CPU PETSc/SLEPc Schur
       -> GPU PETSc/SLEPc CUDA Schur
  -> runner: orkiestracja, tracking, artifacts-v2
  -> OpenAPI v2 JSON control plane + binarny field data plane
  -> Results Navigator / Analysis / Inspector / unified viewport-3d
  -> scope-bound qualification bundle
```

### Granica promocji modalnej i driven response

Dokładne scope CPU/GPU definiowane w tym dokumencie kwalifikują **modalny
eigensolver** K0. Driven response, peak fitting i modal-vs-driven comparison
są wymaganymi powierzchniami produktu oraz niezależnymi analizami, ale nie
wchodzą automatycznie do modalnego claimu. Ich promocja wymaga osobnych scope
CPU/GPU, ukończenia K0-P7 oraz własnego kompletu właściwych DoD. Bez tego UI
pokazuje je z rzeczywistym stanem `unvalidated` lub z węższym historycznym
scope. Modalna eigenfrequency bez jawnego sprzężenia z RF/oscillator strength
jest „modal resonance”, nie zmierzoną lub wymuszoną intensywnością FMR.

Sukces nie oznacza tylko kompilacji lub jednego wyniku zgodnego z Kittlem.
Sukces zachodzi dopiero, gdy:

- gałąź jest zintegrowana z aktualnym `master`;
- dokładny snapshot ma świeży, zgodny managed runtime;
- CPU przechodzi K0-P1–K0-P6;
- GPU przechodzi K0-G1–K0-G4 na tym samym kontrakcie fizycznym;
- `frequency_domain_production_dod.v1.json` zawiera `pass` dla wszystkich
  właściwych `DOD-01`–`DOD-14`, a wyłącznie dla pozycji wykluczonych przez
  dokładny katalog scope — schema-enumerowane `not_applicable` z dozwolonym
  reason code; oba rekordy mają `open_blockers=[]` i zaakceptowane wiązania
  exact-scope;
- natywny browser proof pokazuje widmo, wybór modu, zmianę fazy i pole 3D dla
  rzeczywistych artefaktów CPU i GPU;
- capability matrix jest promowana wyłącznie przez G2 dla zakresu rzeczywiście
  pokrytego dowodami, z jawnym rozdzieleniem R1 runtime commit i governance
  promotion commit.

## 2. Werdykt wykonawczy

Nie należy implementować modułu od początku. W recovery worktree znajduje się
jedyna istotna, nieopublikowana implementacja treściowa. Audyt 37
zarejestrowanych worktree nie wykazał konkurencyjnej implementacji K0 ani
unikalnych commitów UI/eigensolve, które należałoby odzyskać. Worktree
`fem-solver-optimization-remediation-current` ma w sprawdzonych plikach jedynie
zmiany trybu pliku, bez różnic treściowych.

Stan należy opisać następująco:

| Warstwa | Stan źródłowy | Stan wykonania dla bieżącego snapshotu | Stan kwalifikacji |
|---|---|---|---|
| Python DSL / Scene / ProblemIR | szeroko obecne | nieweryfikowane po aktualnym dryfcie | otwarte |
| Planner FEM K0 | obecny, fail-closed dla wielu kombinacji | nieweryfikowany świeżo | otwarte |
| FDM modal eigensolve | nieobecny i poprawnie odrzucany | niewykonywalny | poza zakresem tej promocji |
| Certyfikaty v6 i ABI v16 | częściowo obecne | bundle runtime niezgodny | otwarte |
| Shared-domain assembly | częściowo natywne | brak świeżego managed proof | otwarte |
| CPU Schur/SLEPc | realna ścieżka źródłowa | brak świeżego solve | `source_visible / unvalidated` |
| GPU PETSc/SLEPc CUDA | realna ścieżka źródłowa | brak świeżego solve | `source_visible / unvalidated` |
| Artifacts-v2 i mode fields | writer/verifier obecne | brak świeżego pełnego bundle | otwarte |
| OpenAPI/resource hooks | trasy i fasada obecne | payloady częściowo nietypowane | otwarte |
| Results/Analysis/Inspectors | duży zakres UI istnieje | brak natywnego browser proof | otwarte |
| Mode visualization | overlay i komendy istnieją | brak świeżego proof CPU/GPU | otwarte |
| DOD-01–DOD-14 | kontrakt istnieje | brak aktualnego kompletnego evidence record | `promotion blocked` |

Najkrótsza uczciwa odpowiedź brzmi: **kod jest zaawansowany, ale produkt nie
jest jeszcze gotowy do realnych obliczeń kwalifikacyjnych ani do claimu
produkcyjnego**. Najpierw trzeba zintegrować `master`, poprawić kontrakty i
bloki numeryczne wymienione w tym audycie, zbudować świeży runtime, a dopiero
potem wykonać fizyczne obliczenia kwalifikacyjne.

Nie podajemy jednego procentu ukończenia. Taki procent mieszałby obecność
źródeł, wykonywalność i kwalifikację. Dla dokładnego bieżącego snapshotu żaden
z `DOD-01`–`DOD-14` nie ma jeszcze kompletnego, niezmiennego dowodu wydaniowego.

## 3. Stan Git, worktree i runtime

### 3.1 Rozjazd z `master`

W chwili audytu:

```text
master = 220262df5d84fa04b842c414e3e5868444b356e5
HEAD   = 5acc73bd7046d5e93828d3c3a424eb83e939e5cc
master...HEAD = 119 commitów po stronie master, 64 po stronie gałęzi
tracked diff = 96 plików, około 14642 insertions i 1680 deletions
```

To jest bramka zerowa. Nie wolno kontynuować zmian implementacyjnych na
gałęzi pozostającej 119 commitów za `master`. Najpierw trzeba zachować cały
dirty recovery state, utworzyć kontrolowany checkpoint, scalić aktualny
`master` i dopiero na zintegrowanym stanie odświeżyć audyt oraz testy.

### 3.2 Runtime

Aktywny symlink wskazuje stary bundle:

```text
.fullmag/runtimes/fem-gpu-host
-> /mnt/fullmag-zfn2-native/managed-fem-runtime/
   eigensolve-k0-demag-recovery-d0d97519e713ac75148b8f4003a558dd6219534f07b0d49b9cac1fbbc737236c/
   runtime-variants/hypre-baseline-094d8cf31990cf5f56aae77285ed62a4410125a11bd96e2c94c828ab6ac14d4c
```

Manifest bundle jest związany z commitem `976d9f64c6ad7be917e257b47db9c81bb1d792a0`,
snapshotem `3a3b0148…`, PETSc `3.15.5` i SLEPc `3.15.2`. Nie odpowiada
bieżącemu ABI ani źródłom i może służyć wyłącznie diagnostyce.

Plik `.fullmag/runtimes/.fem-gpu-host.export.lock` nadal istnieje. W bieżącym
namespace odczyt 2026-08-09 nie pokazał właściciela w `lslocks`, a historyczne
PID-y `3469027`, `4183057` i `4183149` nie były widoczne. Nie jest to dowód
host-wide, ponieważ namespace i sandbox mogą ukrywać proces lub prawdziwy stan
mountu. Przed eksportem wymagane jest zatwierdzone hostowe, read-only
potwierdzenie locka, właściciela, mountów `/zfn2` i
`/mnt/fullmag-zfn2-native`. Usunięcie osieroconego pliku lock może wykonać
wyłącznie właściciel przepływu runtime po tym potwierdzeniu; agent nie może
zabijać procesu ani usuwać blokady na podstawie samego wieku pliku.

### 3.3 Historyczne wyniki

Historyczny bounded run uzyskał częstotliwość około `1.956981356 GHz`, różnicę
CPU/GPU `0.21249866485595703 Hz`, względną różnicę około `4.772e-11` i
maksymalną resztę około `4.81e-10`. Jest to wartościowy sygnał diagnostyczny,
ale nie dowód bieżącego snapshotu, pełnej zbieżności, skalowania, residency,
UI ani `DOD-01`–`DOD-14`.

Wcześniejsze lokalne testy Rust/Python/Control Room również nie są ponownie
przypisane do snapshotu `c0195327…`. W tym audycie nie uruchomiono natywnego
builda, solve ani przeglądarki.

## 4. Niezmienne rozróżnienie poziomów dowodu

Każde zadanie i każdy wpis capability musi używać następującej drabiny:

| Poziom | Znaczenie | Czego nie wolno z niego wnioskować |
|---|---|---|
| `contract_only` | istnieje semantyka, typ lub interfejs | że backend implementuje fizykę |
| `source_visible` | istnieje routowana implementacja źródłowa | że aktualny bundle ją zawiera lub że zbiega |
| `executable` | dokładny snapshot wykonał managed run i wydał poprawne artefakty | że fizyka, skalowanie i UI są zakwalifikowane |
| `physics_validated` | niezależne oracles i zbieżność przeszły dla jawnego zakresu | że GPU jest resident albo produkt jest gotowy do wydania |
| `production_qualified` | wszystkie właściwe DoD mają hash-bound dowód exact-scope | że szerszy zakres, inny backend lub niezerowe k są zakwalifikowane |

`implementation_state=executable` nie może być inferowane z nazwy adaptera,
obecności route ani pola diagnostics. `validation_state=unvalidated` wymaga
`validated_scope=null`.

## 5. Co już zaimplementowano

### 5.1 Python DSL, IR i planner

- `packages/fullmag-py/src/fullmag/model/study.py::Eigenmodes` i
  `::FrequencyResponse` zapewniają publiczne konstrukty study.
- `packages/fullmag-py/src/fullmag/world.py::StudyStagesBuilder.add_eigenmodes`
  i `.add_frequency_response` obniżają je do sceny/IR.
- `crates/fullmag-ir/src/study.rs::StudyIR::Eigenmodes` przenosi dynamikę,
  operator, count, target/window, equilibrium, k sampling, normalization,
  damping, spin-wave BC, magnetostatic BC, tracking i sampling.
- `crates/fullmag-ir/src/plan.rs::FemEigenPlanIR` oraz
  `FemEigenExecutionResolutionIR` przechowują rozwiązane wykonanie.
- `crates/fullmag-plan/src/fem.rs::plan_fem_eigen` i
  `resolve_k0_periodic_airbox_execution` wybierają jawne CPU/GPU i zachowują
  requested/resolved intent.
- FDM `Eigenmodes` i `FrequencyResponse` pozostają jawnie niewykonywalne. FDM
  time-domain FFT jest innym produktem i nie publikuje natywnych eigenvectors
  ani q/phi mode fields.

### 5.2 Certyfikaty i przygotowanie problemu

`crates/fullmag-runner/src/fem_eigen.rs` zawiera między innymi:

- `modal_shared_domain_equivalence_classes`;
- `build_modal_certificate_map_binding`;
- `build_shared_domain_linearization_state`;
- `build_native_shared_domain_modal_problem`;
- `execute_native_modal_window_from_full_2x2`.

Runner potrafi budować `LinearizationState.v6`, klasy periodyczne, digesty i
native request. `backends/fem/include/frequency_domain/linearization_state.hpp`
oraz `mesh_symmetry_certificate.hpp` zawierają natywne reprezentacje v6.

### 5.3 Shared-domain assembly i CPU

- `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp`
  składa P1 `P`, `A_qphi`, `A_phiq`, `B_qq`, Robin/Dirichlet/pure-Neumann,
  gauge i redukcję klasową.
- `backends/fem/src/frequency_domain/modal_eigen_solver.cpp::solve_modal_eigen_contract`
  materializuje payload i routuje CPU lub GPU bez dopuszczania ukrytego CPU
  fallbacku dla strict GPU.
- `poisson_airbox_modal_eigen.cpp::solve_poisson_airbox_modal_eigen_cpu_slepc`
  implementuje real-frequency rotated pencil, `STSINVERT`, target
  `tau=omega_target` oraz reszty q/phi/gauge.
- `poisson_airbox_schur_matshell.cpp::solve_poisson_airbox_modal_eigen_cpu_schur`
  implementuje PETSc MatShell, `phi=-P^-1 A_phiq q`, deduplikację dodatniej
  gałęzi, rekonstrukcję i certyfikację oryginalnego deskryptora.

### 5.4 GPU

- `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`
  jest rzeczywistą produkcyjną ścieżką PETSc/SLEPc CUDA.
- `configure_schur_context` tworzy CUDA CSR/Vec oraz Poisson CG z
  HYPRE/BoomerAMG.
- `apply_schur` i `split_schur_matmult` realizują operator Schura/MatShell.
- EPS używa Krylov-Schur, shift-invert i GMRES z CUDA ILU dla małych układów
  albo HYPRE dla większych.
- `device_modal_residual_metrics` oblicza rekonstrukcję i reszty bloków q/phi
  na GPU.
- `modal_krylov.cu` pozostaje validation-only host-Ritz oracle i nie jest
  produkcyjnym eigensolverem, mimo historycznie mylących nazw funkcji.

### 5.5 ABI, runner, artefakty i API

- `native/include/fullmag_fem.h` zawiera
  `FullmagFemModalSharedDomainPayload`, `FullmagFemModalEigenRequest` i
  `FullmagFemFrequencyDomainResult`.
- `backends/fem/src/api.cpp::fullmag_fem_modal_eigen_solve` oraz
  `fullmag_fem_frequency_domain_result_destroy` obsługują solve i owned
  multi-mode buffers.
- `crates/fullmag-runner/src/fem_eigen.rs::write_eigen_v2_bundle` publikuje
  spectrum, branches, dispersion, diagnostics, per-mode metadata oraz complex
  mode fields.
- Dostępne są trasy v2 dla manifestu, spectrum, branches, dispersion,
  diagnostics, mode-field metadata, response sweep/progress/cancel/points i
  response-field metadata.
- Ciężkie wektory są kierowane przez
  `/v2/sessions/current/data/fields/{quantity_id}/samples/vector`, z field ID
  takimi jak `analysis:eigen:sample-0001:mode-0002`.

### 5.6 Control Room

Obecne UI nie jest pustym szkieletem. Istnieją:

- builder drzewa
  `apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts`;
- mapowanie szczegółów
  `apps/control-room/src/modules/inspector/panels/frequencyDomainNodeDetails.ts`;
- duży zestaw dedykowanych paneli w
  `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx`;
- `ModeVisualizationInspectorPanel` i
  `FrequencyDomainModeDisplayControls`;
- `analysis-plots`, modele spectrum/branches/dispersion/response/FMR;
- `AnalysisFieldOverlayController`, komendy real/imag/magnitude/phase,
  phase-rotated real i animacja;
- resource hooks, centralny `ControlRoomApi`, wygenerowane ścieżki OpenAPI;
- zunifikowany `viewport-3d`, bez drugiego viewportu specyficznego dla FEM.

To oznacza, że UI należy uporządkować i domknąć kontraktowo, a nie przepisać
od zera.

## 6. Krytyczne luki i poprawki obowiązkowe

### 6.1 P0 — `k0_kittel_validation` nie może sterować fizycznym sweepem

Kanoniczna nota 0830 mówi, że Kittel jest niezależnym oracle postsolve i nie
może ustalać pola, równowagi, targetu ani podpisu operatora. Obecnie jednak:

- `StudyBuilder.k0_kittel_validation` zapisuje próbki w `runtime_metadata`;
- `dispatch.rs::eigen_path_single_k_point_plan` oraz
  `fem_eigen.rs::execute_k0_kittel_field_sweep` używają tych próbek jako pól
  bias i relaksują dla nich stany.

To jest naruszenie kontraktu fizycznego, nawet jeśli obliczenia dają poprawne
liczby. Należy dodać jawny, physics-owned kontrakt:

```text
BiasFieldSweepIR {
  samples_a_per_m: Vec<[f64; 3]>,
  equilibrium_policy,
  continuation_policy,
  ordering,
}
```

Pole powinno być częścią `StudyIR::Eigenmodes`, Python DSL, UI authoring i
planera. `K0KittelFieldSweepValidation` ma konsumować wyniki po solve oraz
niezależne `M_eff_reference`, nigdy produkować pola wejściowe. Istniejący
`eigen_contract.rs::SweepIR { values_hz }` nie powinien być przeciążany
innym wymiarem fizycznym.

### 6.2 P0 — `A_qq` nie jest jeszcze własnością natywnego MFEM assemblera

`build_native_shared_domain_modal_problem` wywołuje rustowe
`assemble_full_2x2_operator_real` i przekazuje CSR do C++. Funkcja ma model
MVP Hessianu oraz ograniczenia dla jednolitego equilibrium i wąskiej listy
interakcji. Produkcyjny kontrakt wymaga, by pełne `A_qq`, `B_qq`, `A_qphi`,
`A_phiq` i `P` powstały z tego samego natywnego mesh/quadrature/region map oraz
tych samych certyfikatów. Runner ma orkiestrwać, nie posiadać numerycznego
assembly.

### 6.3 P0 — ABI i certyfikat nie są fail-closed

- Native payload nie otrzymuje pełnego
  `mesh_certificate_map_binding_digest` ani kanonicznej mapy regionów/part IDs.
- Native boundary ufa licznikom par i flagom kompletności ustawionym przez
  importera.
- `cell_marker != 0` jest traktowany jako materiał magnetyczny, a brak
  markerów może oznaczać cały mesh magnetyczny; airbox nie jest fail-closed.
- `fullmag_fem_modal_eigen_solve` musi najpierw sprawdzić prefix `struct_size`,
  zanim odczyta `shared_domain_payload`.
- Handshake ABI nie fingerprintuje rozmiarów i offsetów całego modal request,
  result oraz shared-domain payload.
- resolved execution fields bywają kopiowane z requestu zamiast z realnie
  wykonanej ścieżki.

Nie wolno zamrażać bieżącego ABI jako produkcyjnego przed przeniesieniem
`A_qq` i ustaleniem ostatecznej mapy certyfikatów.

### 6.4 P0 — CPU nie ma dowodu kompletności okna ani skalowania

- Stała liczba subwindowów i ograniczone `nev` nie dowodzą braku pominiętych
  modów, multiplicity ani klas zdegenerowanych.
- `PETSC_COMM_SELF`, sekwencyjny Poisson LU i materializacja shifted Schur do
  rozmiaru 1024 są bounded implementation, nie skalowalnym dowodem.
- Testy assemblera używają głównie syntetycznych lub w pełni magnetycznych
  fixture; brakuje end-to-end magnetic+airbox, seam x/y, narożnych klas i
  natywnej negatywnej walidacji certyfikatu.
- Dense/2x2/CSR oracle nie zastępuje rzeczywistego MFEM shared-domain run.

### 6.5 P0 — GPU persistence, telemetry i window są obecnie nadmiernymi claimami

`GpuPersistentContext` przechowuje operator, Poisson KSP i scratch residual,
ale EPS, BV/basis, mass, MatShell, shifted preconditioner oraz `xr/xi` są
tworzone i niszczone dla każdego solve lub subwindow. Zatem
`persistent_solver_context=true` nie jest jeszcze prawdziwe dla pełnego
solver state.

Pola `hot_loop_allocations`, H2D/D2H i residency nie są niezależnie
instrumentowane. Zera są wartościami początkowymi, a diagnostics publikuje
brak transferów na podstawie deklaracji. Performance capture kopiuje ten sam
native JSON i mierzy wall/RSS całej komendy, nie pamięć GPU i hot loop.

GPU window ma 16 shiftów i jeden mode na shift, pomija nieudane subwindows i
może zwrócić `ok`, gdy ocaleje dowolny kandydat. Brakuje
`EPSGetConvergedReason`, restart/apply counts, completeness certificate,
EPS monitor cancellation oraz natychmiastowego przerwania pozostałych shiftów
po cancel.

Dodatkowo:

- production dimension <=256 materializuje shifted Schur i używa cuSPARSE
  ILU, ale diagnostics może raportować inny preconditioner;
- powyżej 256 HYPRE preconditioner pomija Schur feedback i nie ma jeszcze
  dowodu zbieżności;
- `validate_problem` musi jawnie odrzucać `requested_mode_count=0`, nieznany
  target i niezgodne konwencje;
- jedyny bezpośredni test adaptera PETSc/SLEPc CUDA używa
  `synthetic_algebraic_oracle` i `validation_only_adapter=true`.

### 6.6 P1 — artefakty, FMR i release DAG nie są przyczynowo zamknięte

- Nie istnieje pierwszoklasowy artefakt bias-field scan z jawną osią,
  próbkami, branch tracking i proweniencją pól.
- Piki FMR są wyprowadzane w UI z dwóch payloadów. Potrzebny jest kanoniczny
  `fmr/peaks.v1.json` lub jawny, wersjonowany derived dataset z metodą,
  tolerancjami i source references.
- CSV/Zarr/logi wymagają `validation_artifact_manifest.v1`.
- Writer DoD przyjmuje dowody z bundle, lecz obecna recipe kwalifikuje CPU/GPU
  przed utworzeniem parity i performance. Release musi generować raw runs,
  convergence, parity, performance i browser proof, następnie ingestować je do
  bundle, dopiero potem uruchamiać writer/verifier DoD.
- Performance tiers `128/256/512` nie pokrywają wymaganej macierzy >1024.

### 6.7 P1 — API/OpenAPI/realtime nie są jeszcze produkcyjne

- `FrequencyDomainJsonArtifactResource.payload` jest `Option<Value>`/
  `payload?: unknown`, więc frontend heurystycznie parsuje naukowe payloady.
- response diagnostics route nie jest kompletnie opisana w OpenAPI.
- `analysis_payload_revision` oraz część artifact revision nie są w pełni
  content-addressed; payload o tej samej długości może zachować revision.
- realtime nie invaliduje precyzyjnie manifestu, spectrum, branches, progress
  i mode metadata.
- analysis field responses wymagają spójnych nagłówków revision, topology,
  indexing, units i representation.
- Stare aliasy `/analysis/eigen/*` i kanoniczne
  `/analysis/frequency-domain/*` muszą mieć jedną kontrolowaną migrację, a nie
  trwałe dwie powierzchnie.

### 6.8 P1 — UI ma realne funkcje, ale także błędy semantyczne

- `FrequencyDomainEigenSection` może traktować kopertę zasobu jak sam payload
  zamiast czytać typowane `.payload`, co prowadzi do pozornie pustego spectrum,
  branches lub dispersion mimo dostępnego artefaktu.
- Model spectrum ma rozjazd osi: jedna warstwa traktuje `x` jako frequency,
  inna podpisuje je jako mode index.
- Response wymusza `a.u.` i `W/m^3` mimo że kontrakt może dostarczać proxy o
  innych jednostkach.
- Frequency-domain dispersion nie ma własnej poprawnej powierzchni Analysis;
  obecny tab jest związany z time-domain dynamic structure factor.
- Progress artefaktowy nie jest jeszcze jednoznacznie fallbackiem wobec live
  stage execution.
- Część Explorera pokazuje placeholdery `ready` bez zasobu HTTP.
- `FrequencyDomainResultInspectors.tsx` ma około 6949 linii i miesza wiele
  odpowiedzialności; wymaga podziału domenowego, nie kosmetycznego.
- Obecny smoke authoring przechwytuje `/v2/**` i deklaruje fixture jako źródło
  prawdy; nie jest native/browser qualification.

## 7. Decyzje architektoniczne zamrożone przez ten plan

1. Produkcyjny eigensolve K0 w tym planie dotyczy FEM. FDM modal eigensolve
   pozostaje niezaimplementowany; FDM FFT nie jest substytutem.
2. Dynamiczny demag używa shared-domain Poisson-airbox i dokładnego `k=0`.
   Nonzero-k Floquet-airbox jest osobnym zakresem.
3. W realnym buildzie target to `tau=omega_target` na
   `real_frequency_rotated` pencil; nie wolno użyć realnego targetu na
   oryginalnym `lambda=i*omega` pencil.
4. Kittel i inne analityczne oracles są wyłącznie postsolve.
5. Bias-field scan jest fizycznym wejściem study, nie metadanymi walidatora.
6. CPU i GPU dzielą równania, certyfikaty, ABI oraz artefakty, lecz mają
   oddzielne implementacje i oddzielne dowody.
7. `modal_krylov.cu` pozostaje validation-only; produkcyjny GPU to
   PETSc/SLEPc CUDA.
8. Modal eigen i driven response są odrębnymi produktami. Ten plan promuje
   modalne scope; driven response wymaga osobnych scope i K0-P7. Porównanie
   nie promuje jednego produktu na podstawie drugiego.
9. HTTP v2 jest źródłem prawdy. WebSocket tylko invaliduje revision.
10. JSON przenosi metadata; ciężkie pola przechodzą przez jeden binarny data
    plane `/data/fields/{field_id}/samples/vector`.
11. Results jest kontekstem jednego workspace. Nie powstaje druga aplikacja,
    drugi shell ani drugi viewport.
12. UI pokazuje oddzielnie stan zasobu, stan artefaktu i kwalifikację naukową.

## 8. Zależności i DAG wykonania

```text
G0  checkpoint + merge aktualnego master + baseline
 -> C1 physics/docs/scope
    -> C2 Python DSL / BiasFieldSweepIR / planner / UI authoring
    -> C3 certificates + finalny ABI
       -> N1 natywne pełne MFEM assembly
          +-> N2 CPU selected spectrum P1-P6 --------> Q1 CPU evidence
          +-> N3 GPU persistent PETSc/SLEPc G1-G4 ---+
          +-> A1S artifacts/analysis schema freeze
                 -> A2 typed OpenAPI/revisions/realtime
                    -> U0 tree/selection/adapters
                       +-> U1 Results/Analysis/Inspectors
                       +-> U2 unified viewport

A1S -> A1E evidence ingest + staged-release infrastructure
N2 + N3 + A1E + A2 + U0 + U1 + U2
  -> R1 integration + fresh managed runtime + frozen source/UI/release tooling
R1 + A1E -> Q1 CPU evidence
Q1 + N3 + A1E -> Q2 GPU parity/performance/residency evidence
Q1 + Q2 + A1E + A2 + U1 + U2 -> Q3 native browser + pre-release regression
Q3 -> DoD writer/verifier -> final scientific manifest
  -> G2 governance-only promotion -> two-identity promotion attestation
```

N2, N3 i A1S mogą powstawać równolegle po N1/C3, ale Q2 czeka na Q1 jako
oracle. Prace nad fixtures UI mogą ruszyć po zamrożeniu schematów A1S/A2. Finalna
kwalifikacja UI zależy od natywnych artefaktów N2/N3. GPU zależy od
kwalifikowanego CPU oracle, ale samo implementowanie CPU i GPU może przebiegać
równolegle po zamrożeniu assembly/ABI, o ile oba lane'y nie edytują wspólnych
plików.

`R1` ma jednego właściciela integracji/runtime. Tylko on po scaleniu całego
kodu C1–C3, N1–N3, A1S/A1E, A2 i U0–U2 wykonuje przebudowę, przełączenie
symlinku oraz zamrożenie manifestu.
Lane'y N2/N3 nie przebudowują ani nie przełączają managed runtime samodzielnie;
ich native checks są wykonywane przez właściciela runtime na wskazanym
zintegrowanym commicie, a wyniki wracają do lane'u jako review gate.

## 9. Reguły pracy równoległej

1. Każdy lane pracuje w osobnym worktree i na osobnej gałęzi utworzonej z
   dokładnego zintegrowanego commitu po G0.
2. Żadne dwa lane'y nie mają prawa edytować tego samego pliku. Wspólne typy i
   ABI są najpierw scalane przez właściciela C3; CPU/GPU zaczynają od tego
   commitu.
3. Właściciel integracji scala najpierw C1, C2, C3 i N1. Następnie integruje
   niezależne N2, N3 i A1S, potem A2/U0/U1/U2, a A1E dopiero na zamrożonych
   schematach. Nie przepisuje implementacji agentów podczas merge.
4. Każdy commit jest wąski; przed commitem osobno wykonywane jest
   `git diff --cached --name-only`.
5. Native FEM używa wyłącznie container-backed recipes z `justfile` jako
   dowodu. Host build jest tylko diagnostyką i nie może zamknąć gate'a.
6. Ciężkie buildy używają storage pod `/zfn2/mateuszz/git/fullmag`; nie wolno
   tworzyć wielogigabajtowego targetu w workspace.
7. Jeden właściciel ma prawo przebudowywać lub przełączać symlink managed
   runtime. Pozostałe lane'y konsumują zamrożony manifest.
8. GPU device i export runtime są współdzielonym zasobem; ich użycie jest
   serializowane. Lekkie testy Rust/Python/UI mogą biec równolegle.
9. Lane kwalifikacyjny zaczyna się po zamrożeniu R1. Jakakolwiek zmiana kodu,
   schema, generatora, recipe, UI lub physics contract unieważnia wszystkie
   późniejsze evidence artifacts. Jedyny wyjątek następuje po przyjęciu final
   scientific manifest: osobny governance-only commit może dotknąć wyłącznie
   jawnej allowlisty readiness/capability docs i musi dostać promotion
   attestation wiążącą commit R1, governance commit i manifest. Zmiana poza
   allowlistą unieważnia dowody.
10. Agent UI nie może zmienić physics claim ani capability matrix. Agent
    backendu nie może ręcznie edytować wygenerowanego OpenAPI.

## 10. Etap G0 — zabezpieczenie recovery i integracja `master`

**Właściciel:** jeden integration owner.
**Równoległość:** zabroniona dla operacji Git i runtime; pozostałe agenty mogą
wykonywać wyłącznie read-only audyt.
**Cel:** otrzymać jeden zachowany, odtwarzalny i zintegrowany punkt startowy.

### G0.1 Inwentaryzacja i checkpoint

1. Zapisz wynik osobnych komend:

   ```bash
   git status --short
   git diff --cached --name-only
   git diff --name-status
   git ls-files --others --exclude-standard
   git worktree list --porcelain
   git rev-parse HEAD master
   git rev-list --left-right --count master...HEAD
   ```

2. Sklasyfikuj każdy untracked path. `native-debug/` i artefakty builda nie
   mogą wejść do checkpointu bez potwierdzenia, że są źródłami lub wymaganym
   dowodem. Nie usuwaj ich automatycznie.
3. Sprawdź, czy indeks nie zawiera obcych zmian. Staging wykonuj wyłącznie
   ścieżkami przypisanymi do recovery K0.
4. Utwórz checkpoint commit ze wszystkimi intencjonalnymi źródłami, testami i
   dokumentacją recovery. Zalecany komunikat:

   ```text
   chore: checkpoint FEM K0 eigensolve recovery before master sync
   ```

5. Zapisz pełny commit, tree ID, source snapshot SHA i listę wyłączonych
   untracked artifacts. Checkpoint musi być możliwy do odtworzenia bez stash.

**Bramka G0.1:** recovery sources są w commicie, nie ma nieopisanych staged
plików, a untracked artifacts mają jawny status retain/ignore.

### G0.2 Aktualizacja i merge

1. Pobierz aktualny `master` bez modyfikowania worktree:

   ```bash
   git fetch origin master
   git rev-parse origin/master
   git log --oneline --decorate HEAD..origin/master
   ```

2. Scal `origin/master` do gałęzi recovery. Nie używaj destrukcyjnego resetu
   ani rebase brudnego drzewa:

   ```bash
   git merge --no-ff origin/master
   ```

3. Konflikty rozwiązuj według hierarchii: aktualna physics/spec semantics z
   master, następnie zachowanie K0 recovery, następnie wygenerowane pliki.
4. Dla generated OpenAPI i full pack nie rozwiązuj konfliktu ręcznym
   sklejaniem; po scaleniu źródeł uruchom kanoniczny generator.
5. Po konflikcie sprawdź, czy nie wrócił stary demag/dynamics contract ani
   hidden fallback. Szczególnie porównaj zmiany master w demag, planowaniu,
   runtime selection, field store i viewport.

**Bramka G0.2:** `git rev-list --left-right --count origin/master...HEAD`
zwraca `0` po lewej stronie, merge ma rozstrzygnięte konflikty, a wszystkie
zmiany recovery nadal mają właściciela i test.

### G0.3 Baseline po merge

Najpierw uruchom lekkie testy, bez starego native bundle:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q \
  packages/fullmag-py/tests/test_api.py \
  packages/fullmag-py/tests/test_problem_ir.py

cargo test -p fullmag-ir --quiet
cargo test -p fullmag-plan --quiet
cargo test -p fullmag-runner --lib --quiet

python3 scripts/build_fd_solver_masterplan_full_pack.py --check
pnpm --dir apps/control-room typecheck
```

Następnie sprawdź runtime storage i osierocony lock w trybie read-only.
Właściciel runtime usuwa plik lock tylko po ponownym potwierdzeniu braku
właściciela. Pierwszy autorytatywny native build po zmianach to:

```bash
just rebuild-fem-runtime
just ensure-managed-fem-runtime
just verify-managed-fem-runtime-source-provenance
just inspect-managed-fem-frequency-domain-deps
```

**Bramka G0.3:** lekki baseline ma zapisane exit codes; świeży runtime manifest
wiąże dokładny commit, source snapshot, ABI, PETSc/SLEPc/MFEM/CUDA i device.
Stary bundle nie jest już aktywnym kandydatem do dowodów.

## 11. Etap C1 — korekta fizyki, scope i dokumentacji

**Właściciel plików:** `docs/physics/0830-*`, jego source map, rozdziały 02,
17–19, 24 i ten plan, capability matrix oraz właściwy ADR/spec.
**Zależność:** G0.
**Może biec równolegle z:** przygotowaniem testów UI na zamrożonych fixtures,
ale nie z edycją tych samych dokumentów.

### Kroki

1. Ustal dwa dokładne zakresy kwalifikacji:

   - `fem_k0_periodic_airbox_cpu_double_v1`;
   - `fem_k0_periodic_airbox_gpu_double_v1`.

   Oba obejmują dokładne `k=0`, periodic x/y, open z, dynamiczny Poisson-airbox,
   P1, jawne BC/gauge, `alpha=0`, double, real-frequency rotated target,
   wybrane geometrie/materiały/rozmiary oraz bias-field scan.
2. Dodaj lub zaktualizuj publikacyjną notę tak, by:

   - rozdzielała physical bias-field input od Kittel oracle;
   - nie twierdziła, że `A_qq` już powstaje w natywnym MFEM, dopóki N1 tego
     nie implementuje;
   - precyzyjnie nazywała bounded CPU i GPU source state;
   - opisywała faktyczną granicę exact shifted PC oraz HYPRE;
   - usuwała duplikat anchor, poprawiała bloki math, jednostki source map,
     stabilne path+symbol i bibliografię primary-source;
   - zawierała prawdziwy Python example z `full_2x2`,
     `periodic_airbox_k0`, periodic x/y/open z i jawny bias-field scan.
3. Po merge sprawdź katalog ADR i przydziel kolejny wolny numer dla decyzji:
   „bias-field scan jest physical ProblemIR input; Kittel/FMR peak detection są
   derived validation/analysis”. ADR musi też zamrozić Results jako widok nad
   modal/driven artifacts, nie trzeci solver.
4. Zaktualizuj masterplan statusy. Rozdziały historyczne pozostają opisane
   jako historyczne; bieżąca sekcja ma wskazywać snapshot po G0.
5. Capability matrix pozostaje `unvalidated` do Q3. Nie wolno promować statusu
   po samym zakończeniu dokumentacji.
6. Zaktualizuj source-map symbols do stabilnych nazw funkcji bez typów
   zwrotnych i z prawidłowymi jednostkami LaTeX.

### Weryfikacja

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json \
  --repo-root .

python3 -m pytest -q \
  .agents/skills/scientific-documentation-contract/scripts/test_validate_scientific_docs.py \
  .agents/skills/scientific-documentation-contract/scripts/test_validate_changed_scientific_docs.py \
  scripts/test_frequency_domain_math_contract_docs.py

python3 scripts/build_fd_solver_masterplan_full_pack.py --write
python3 scripts/build_fd_solver_masterplan_full_pack.py --check
```

**Akceptacja C1:** dokumenty nie przeczą sobie w kwestii field scan, `A_qq`,
ABI, CPU/GPU persistence, runtime i statusu capability; walidator
publication-grade przechodzi; status nadal nie wykracza ponad dowody.

## 12. Etap C2 — kanoniczny bias-field scan, DSL, IR, planner i authoring

**Właściciel plików:** publiczne klasy Python study, SceneDocument lowering,
`crates/fullmag-ir` study/eigen contracts, `crates/fullmag-plan`, testy tych
warstw oraz frequency-domain authoring w Study Inspector.
**Zależność:** zaakceptowany kontrakt C1.
**Nie edytuje:** native backend, runner artifacts, Results UI.

### Model docelowy

Wprowadź backend-neutral `BiasFieldSweepIR`, nie rozszerzaj metadata Kittela:

```text
BiasFieldSweepIR
  samples_a_per_m: non-empty Vec<[f64; 3]>
  equilibrium_policy: relax_each | continuation
  ordering: declared
  continuation_seed: previous_accepted_equilibrium | initial_state
```

`StudyIR::Eigenmodes` otrzymuje opcjonalny `bias_field_sweep`. Dla bieżącego
K0 scope:

- `bias_field_sweep` może współistnieć tylko z single gamma;
- `k_path` i bias-field sweep są wzajemnie wykluczające się;
- każdy sample ma fizyczne pole w A/m, własny equilibrium ID, operator input
  signature i sample index;
- continuation jest algorytmem przygotowania, nie pozwala ponownie użyć
  niezgodnego certyfikatu;
- Kittel validator otrzymuje solved scan oraz niezależne reference data.

### Kroki TDD

1. Dodaj failing Python round-trip tests dla pojedynczego pola i scanu 3–5
   pól, CPU/GPU intent, export script i canonical ordering.
2. Dodaj failing IR tests dla pustego scanu, NaN/Inf, k-path+field-scan,
   złych jednostek, nonzero-k K0 reuse, fully periodic 3D, alpha !=0, single
   precision, braku demag i braku periodic x/y/open z.
3. Dodaj publiczną klasę Python z SI-first argumentami oraz eksport w
   `fullmag.__init__`.
4. Obniż do `ProblemIR` i zachowaj w SceneDocument/UI/Python round-trip.
5. Usuń sterowanie polem z `StudyBuilder.k0_kittel_validation`. Zachowaj
   kompatybilny odczyt starego metadata wyłącznie jako deprecated validation
   oracle; stary payload nie może uruchomić scanu.
6. Planner najpierw sprawdza legalność, potem wybiera CPU/GPU. Każdy sample
   otrzymuje jawny plan i requested/resolved provenance.
7. UI authoring pokazuje sekcję `Bias field scan` z tabelą `[Hx, Hy, Hz] A/m`,
   polityką equilibrium i walidacją inline. Nie eksponuje PETSc/SLEPc jako
   fizycznego parametru.

### Weryfikacja

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q \
  packages/fullmag-py/tests/test_api.py \
  packages/fullmag-py/tests/test_problem_ir.py \
  packages/fullmag-py/tests/test_scene_document_roundtrip.py

cargo test -p fullmag-ir --quiet
cargo test -p fullmag-plan --quiet

pnpm --dir apps/control-room test -- --run \
  StudyStageAuthoringModel \
  StudyInspectorPanel \
  StudyAuthoringSmokeScript
pnpm --dir apps/control-room typecheck
```

**Akceptacja C2:** Python-authored i UI-authored scan dają identyczny
znormalizowany ProblemIR; Kittel metadata nie wpływa na pola, operator,
equilibrium ani target; FDM i nielegalne kombinacje odrzucają się stabilnym
reason tokenem.

## 13. Etap C3 — certyfikaty i ostateczny ABI

**Właściciel plików:** backend-neutral certificate structs, C ABI/Rust FFI,
native layout query i testy ABI.
**Zależność:** C1 oraz projekt payloadu uzgodniony z N1.
**Integracja:** C3 publikuje nagłówki przed rozpoczęciem N2/N3.

**Stan bieżący:** checkpoint `5acc73bd7` i poprawki po review mają czysty
review względem parenta `236ccbd79`: legacy v1 layout zachowano, v2 manifest
ma pełne offsety/prefix gate, a `validation` jest resolved-only. Etap nadal nie
jest produkcyjnie zamknięty, ponieważ canonical certificate-binding verifier
oraz świeży managed-native runtime proof pozostają otwarte.

### Kroki

1. Zdefiniuj kompletne, wersjonowane pola dla:

   - `LinearizationState.v6` i acceptance tolerances;
   - magnetic/scalar equivalence classes, corner classes, orientation,
     translation, seam i frame cycles;
   - region/part identity oraz magnetic/airbox cell map;
   - BC/gauge tuple;
   - `mesh_certificate_map_binding_digest`;
   - operator input signature i source/runtime identity;
   - bias-field sample identity.
2. Native assembly musi ponownie obliczyć lub zweryfikować digest wiązania,
   zamiast ufać `equivalence_classes_complete=true`.
3. Rozszerz layout handshake o schema/version, size i offsets każdego
   publicznego pola `FullmagFemModalEigenRequest`,
   `FullmagFemModalSharedDomainPayload` i result.
4. Każdy odczyt opcjonalnego ogona ABI poprzedź prefix-size check.
5. Result zapisuje rzeczywiście resolved execution target, scalar mode,
   spectral transform, engine i fallback state.
6. Destroy pozostaje idempotentny dla zero/partial/full result.
7. Dodaj cross-language golden layout test kompilujący C++ producer i Rust
   consumer z tym samym manifestem ABI.

### Negatywne testy

- za mały `struct_size`;
- unknown enum;
- stale certificate digest;
- licznik par niezgodny z mapą;
- brak airbox part albo nieznany marker;
- corner class incomplete;
- changed mesh/equilibrium/bias field;
- podmieniony resolved field;
- partial allocation i dwukrotne destroy.

### Weryfikacja

```bash
just verify-fem-frequency-domain-native-contract
cargo test -p fullmag-fem-sys --quiet
cargo test -p fullmag-runner native_fem --quiet
```

**Akceptacja C3:** niezgodny runtime jest odrzucany przed solve; native boundary
nie ufa niezweryfikowanym licznikom/flagom; resolved provenance pochodzi z
wykonanej ścieżki.

## 14. Etap N1 — pełne natywne MFEM shared-domain assembly

**Właściciel plików:** `backends/fem/cpu/frequency_domain/operators/`,
backend-neutral request adapter i dedykowane native tests.
**Zależność:** C2/C3.
**Nie edytuje:** eigensolver CPU/GPU poza minimalnym podłączeniem payloadu.

**Stan bieżący:** istnieje source-level helper map-binding z testami
fail-closed, ale review potwierdził, że jest on wyłącznie jednostkowy. Nie jest
wywoływany przez C ABI/MFEM, używa pair-map preimage odmiennego od runnerowego
bindingu i nie ma jeszcze v6 magnetic/scalar class closure, corner/edge
evidence ani trusted part registry. Akceptacja N1 pozostaje otwarta.

### Kroki

1. Napisz failing end-to-end test z rzeczywistym mesh: magnetic film + airbox,
   periodic x/y, open z, narożniki i oddzielne part IDs.
2. Przenieś assembly pełnego `A_qq` z runnera do backend-owned MFEM operatora.
3. Składaj `A_qq`, `B_qq`, `A_qphi`, `A_phiq`, `P`, Robin boundary mass i
   gauge z jednego mesh/quadrature/region map oraz accepted linearization.
4. Ogranicz magnetic terms do magnetic parts; scalar Poisson działa na całym
   shared domain.
5. Zastosuj pełne equivalence classes dla magnetic i scalar true DOFs,
   łącznie z narożnikami; pair-only reduction jest niedozwolona.
6. Opublikuj ordering, jednostki, scaling, region IDs, BC/gauge, block digests
   i operator input signature.
7. Usuń production dependency od rustowego MVP `assemble_full_2x2_operator_real`.
   Może pozostać wyłącznie jawnie validation-only oracle.
8. Dodaj niezależne oracles:

   - manufactured Poisson dla Robin, Dirichlet i pure-Neumann;
   - sign-flip negative control dla `A_qphi/A_phiq`;
   - reciprocity/energy variation;
   - random-vector assembled action;
   - region-isolation i airbox marker failure;
   - analytical metadata perturbation, która nie zmienia bloków.

### Weryfikacja

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
```

**Akceptacja N1:** `assembly_kind` jest produkcyjny, wszystkie bloki powstają
w natywnym MFEM, analityczne Kittel data nie wpływają na assembly, a realny
magnetic+airbox fixture przechodzi i odrzuca błędne certyfikaty.

## 15. Etap N2 — CPU selected spectrum K0-P1–K0-P6

**Właściciel plików:** CPU modal eigen/Schur, CPU tests i CPU-only diagnostics.
**Zależność:** N1 i C3.
**Może biec równolegle z:** N3 po zamrożeniu ABI, lecz N2 jest oracle dla Q2.

### Kroki

1. Zachowaj dokładny `real_frequency_rotated` target i pełną rekonstrukcję
   q/phi/delta-m.
2. Pobieraj i publikuj PETSc/SLEPc convergence reason, iterations, restarts,
   operator/PC applies, shift/target i stop reason.
3. Certyfikuj oryginalne, nieskalowane reszty magnetic, Poisson i gauge dla
   każdego zaakceptowanego modu. Biblioteczna reszta SLEPc pozostaje osobnym
   polem i nie może capować pełnej reszty.
4. Wprowadź fail-closed window coverage:

   - żaden subwindow nie może po cichu zawieść;
   - powiększenie `nev` i zagęszczenie/offset siatki shiftów nie może zmienić
     zaakceptowanych klastrów w production tolerance;
   - overlapping shifts muszą odtwarzać te same invariant subspaces;
   - multiplicity/degenerate clusters są porównywane subspace overlap;
   - małe admitted cases są porównane z pełnym dense descriptor spectrum;
   - certificate zapisuje subwindows, coverage margins, cluster ranks i
     perturbation result.
5. Określ jawny bounded scope sekwencyjnego CPU. Jeśli LU/PETSC_COMM_SELF ma
   pozostać, scope musi zawierać limit DOF i zmierzoną memory/time envelope;
   nie wolno nazywać go szeroko skalowalnym.
6. Cancellation zachowuje wyłącznie certyfikowane partial modes i dokładny
   stop reason.
7. Przejdź K0-P1–P5 na niezależnych fixture, następnie K0-P6 na fizycznym
   bias-field scan z C2.

### Weryfikacja

Lane N2 przekazuje commit właścicielowi integracji/runtime. Poniższe recipe
uruchamia wyłącznie ten właściciel na zintegrowanym kandydacie i zapisuje
manifest wykorzystanego runtime; lane N2 nie wykonuje `rebuild` ani `ensure`:

```bash
just verify-managed-fem-runtime-source-provenance
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell
just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu
```

**Akceptacja N2:** wszystkie accepted modes przechodzą pełne reszty; window
certificate jest fail-closed; fizyczny scan nie korzysta z oracle jako input;
CPU scope ma jawne granice rozmiaru i wydajności.

## 16. Etap N3 — GPU persistent PETSc/SLEPc K0-G1–K0-G4

**Właściciel plików:** `modal_petsc_slepc.cpp`, GPU result telemetry, jego
native tests oraz GPU-only adapter code.
**Zależność:** zamrożone C3/N1; Q2 zależy od zaakceptowanego N2.
**Zakaz:** nie promować `modal_krylov.cu` do produkcji.

### Kroki

1. Rozszerz `GpuPersistentContext`, aby dla identycznej operator signature
   posiadał i reuse'ował:

   - CUDA matrices/vectors;
   - Poisson KSP/workspace;
   - MatShell i mass;
   - shifted preconditioner;
   - EPS/ST/KSP/PC;
   - BV/Krylov basis i locking/restart state;
   - residual/reconstruction i result workspace.
2. Zdefiniuj jawne invalidation przy zmianie mesh, equilibrium, bias field,
   BC/gauge, target policy, precision lub operator terms.
3. Instrumentuj rzeczywiste setup/hot-loop/final allocation oraz H2D/D2H
   events/bytes. Dodaj operator/PC apply counts, EPS/KSP iterations/restarts,
   GPU memory high-water mark i faktyczne Mat/Vec/BV/PC types.
4. Dodaj niezależny trace wykorzystujący PETSc/CUDA tooling; native self-report
   jest jednym źródłem, nie oracle dla samego siebie.
5. Wdróż ten sam fail-closed window/cluster certificate co CPU. Jakikolwiek
   failed subwindow blokuje `complete=true`.
6. Dodaj `EPSGetConvergedReason` i EPS monitor cancellation. Cancel przerywa
   pozostałe shifty, zachowuje tylko certyfikowane modes i nie deklaruje
   sukcesu przy częściowej zbieżności.
7. Napraw preconditioner diagnostics. Exact materialized Schur+ILU i
   magnetic approximation+HYPRE mają różne, prawdziwe identyfikatory.
8. Waliduj `target_kind`, count >0, conventions, dimensions, adapter kind i
   production flags przed alokacją.
9. Dodaj real shared-domain tests: nearest, window, multimode, degeneracy,
   failed subwindow, reuse/invalidation, cancel przed/w trakcie solve,
   unavailable CUDA/HYPRE/SLEPc, zero-count i NaN.
10. Uruchom rozmiar >1024, dla którego production path nie może polegać na
    bounded exact materialization. Dla zadeklarowanego produkcyjnego scope
    dowód zbieżności scalable lane jest obowiązkowy; brak tego dowodu blokuje
    promocję i nie może być naprawiony późnym zawężeniem scope.

### Weryfikacja

Lane N3 przekazuje commit właścicielowi integracji/runtime. Poniższe recipe
uruchamia wyłącznie ten właściciel na zintegrowanym kandydacie i zapisuje
manifest wykorzystanego runtime; lane N3 nie wykonuje `rebuild` ani `ensure`:

```bash
just verify-managed-fem-runtime-source-provenance
just verify-fem-frequency-domain-gpu-petsc-slepc-runtime
just verify-fem-frequency-domain-eigen-k0-gpu-petsc-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-gpu
```

**Akceptacja N3:** pełny solver state jest faktycznie persistent; niezależny
trace potwierdza brak hot-loop full-vector migration; window jest kompletne;
przypadek >1024 przechodzi scalable path; GPU residuale i outcome zgadzają się
z CPU; strict GPU nie ma fallbacku.

## 17. Etapy A1S/A1E — schematy artefaktów i przyczynowo zamknięty release bundle

**A1S — właściciel plików:** runner artifact writer/tracking, spec artefaktów i
schema verifiers. Zależy od C2/C3/N1 i może biec równolegle z N2/N3.
**A1E — właściciel plików:** evidence ingest, qualification verifiers i recipes
staged release. Zależy od zamrożonego A1S; konsumuje wyniki Q1/Q2/Q3.
**A2/UI:** zaczynają dopiero po zatwierdzeniu A1S JSON schema.

### Wymagany kanoniczny zestaw

```text
frequency_domain/manifest.v1.json
eigen/spectrum.v2.json
eigen/branches.v2.json
eigen/field_sweep.v1.json
eigen/diagnostics/solver.v1.json
eigen/modes/{sample_id}/{mode_id}.json
eigen/mode_fields.zarr/{sample_id}/{mode_id}/vector_xyz_complex/...
fmr/peaks.v1.json
fmr/resonance_fits.v1.json
fmr/kittel_fit.v1.json
response/magnetic_response_sweep.v2.json
response/frequency_points/{point_id}.json
response/field_payloads.zarr/...
validation/frequency_domain_production_dod.v1.json
validation/release_manifest.v1.json
```

`eigen/field_sweep.v1.json` publikuje dla każdej próbki:

- trwały `sample_id` oraz opcjonalny `sample_index` tylko do prezentacji;
- `scan_axis.kind=bias_field`;
- `bias_field_a_per_m[3]` i jawne display conversions;
- equilibrium/mesh/operator signature;
- solved mode refs i complete/partial state;
- branch/tracking refs;
- requested/resolved execution;
- artifact revision i cross-artifact hashes.

`fmr/peaks.v1.json` jest derived dataset, nie solver result. Zawiera source
kind (`modal_coupling` albo `driven_response`), algorytm, parametry, jednostki,
uncertainty, source artifact/revision, sample/mode/frequency refs oraz status
walidacji. Sam zestaw modalnych eigenfrequency nie jest peak datasetem; wariant
`modal_coupling` wymaga fizycznego drive/polarization i zatwierdzonego coupling
lub oscillator-strength observable. UI nie wyznacza naukowo kwalifikowanych
pików heurystyką bez proweniencji.

`fmr/resonance_fits.v1.json` zapisuje dla response jawny model linii
(symetryczny/antysymetryczny Lorentzian lub inny zatwierdzony model), fit range,
baseline, weights, peak frequency, linewidth, Q, covariance/uncertainty,
conditioning, residual i source hash. `fmr/kittel_fit.v1.json` zapisuje model
Kittela właściwy geometrii, fitted parameters, units, covariance, conditioning,
excluded samples oraz niezależne reference comparison. Fit jest wersjonowanym
derived analysis job, nie lokalnym stanem wykresu i nie wejściem solvera.

### Kroki

1. Dodaj schema i failing verifier tests dla missing fields, stale revisions,
   wrong units, wrong sample mapping, fabricated mode field, mismatched
   topology, invalid tracking refs, niepoprawnej covariance/fit range i
   incomplete scan oznaczonego complete.
2. Usuń każdy fallback tworzący jednorodne lub syntetyczne mode vectors w
   produkcyjnym bundle.
3. Publikuj q/phi provenance i Cartesian complex delta-m. Tangent-local dane
   bez rekonstrukcji XYZ nie są wizualizowalnym field ID.
4. Partial/cancel/failure zachowują ukończone modes, lecz mają
   `complete=false`, dokładny stop reason i brak promotion binding.
5. Dodaj sidecary `validation_artifact_manifest.v1` dla CSV, Zarr, logów
   sanitizer, browser evidence i zewnętrznych trace.
6. Zmień release DAG na:

   ```text
   raw CPU + raw GPU
     -> niezależna convergence CPU/GPU
     -> parity
     -> performance/residency/cancel/sanitizer
     -> native browser proof
     -> pre-release managed regression + expected negative controls
     -> ingest hash-bound evidence do CPU/GPU bundle
     -> write DoD records
     -> verify DoD records
     -> immutable final scientific release manifest
     -> governance-only capability promotion commit
     -> external promotion attestation wiążąca obie tożsamości
   ```

   `DOD-14` wskazuje hash-bound pre-release regression record. DoD record nie
   hashuje finalnego manifestu, który dopiero zostanie utworzony. Finalny
   scientific manifest referuje zweryfikowane CPU/GPU DoD records. Następnie
   osobny governance-only commit może zmienić wyłącznie allowlistowane readiness
   i capability docs z `unvalidated` na exact-scope promotion, referując hash
   scientific manifestu. Zewnętrzna promotion attestation referuje oba commity,
   runtime source snapshot i finalny manifest. Ta dwufazowość usuwa cykl
   samohashowania bez przebudowy kwalifikowanego runtime.
7. Production CPU/GPU recipes nie mogą usuwać dowodów ani input evidence
   manifestów, które dopiero będą potrzebne po solve. Trwały staging i final
   release bundle mają oddzielne katalogi. Ponieważ obecny writer dopuszcza
   evidence wyłącznie wewnątrz `bundle_root`, A1E implementuje atomowy ingest:

   - zweryfikuj staging index oraz hash każdego źródła przed kopiowaniem;
   - utwórz nowy tymczasowy CPU/GPU `bundle_root` na tym samym filesystemie co
     final directory;
   - kopiuj zwykłe pliki bez symlinków/hardlinków do bezpiecznych relatywnych
     ścieżek `evidence/...`, ponownie weryfikując hash i size po kopiowaniu;
   - wygeneruj per-bundle `evidence_manifest.v1.json`, którego ścieżki są
     względne względem tego `bundle_root` i który konsumuje istniejący writer;
   - po DoD verification wykonaj atomic rename; w razie błędu usuń wyłącznie
     nieopublikowany katalog tymczasowy, nigdy staging ani istniejący final.
8. Każdy verifier zapisuje command, exit code, stdout/stderr hashes, timestamp,
   source/runtime/scope identity i verifier version.
9. Dodaj nową fail-closed recipe
   `verify-fem-frequency-domain-eigen-k0-poisson-airbox-staged-release`, która
   konsumuje trwały staging, wykonuje opisane kopiowanie/przepisanie manifestu,
   nie uruchamia ponownie destructive raw producers i wykonuje kolejno ingest,
   DoD verification oraz final scientific manifest. Dodaj osobną recipe
   `attest-fem-frequency-domain-eigen-k0-poisson-airbox-promotion`, uruchamianą
   dopiero w G2, która nie modyfikuje scientific bundle i tworzy two-identity
   promotion attestation.
10. Rozszerz sanitizer producers o osobne, hash-bound przebiegi `memcheck`,
    `racecheck` i `synccheck`. Obecny pojedynczy memcheck nie zamyka DOD-13.
11. Zastąp performance tiers `128/256/512` konfigurowalnymi przypadkami
    `gpu_performance_release.v2.json`. Producer ma zapisywać rzeczywiste
    `magnetic_true_dofs`, `scalar_true_dofs` i `operator_dimension` z native
    artifact; verifier wymaga co najmniej trzech różnych wymiarów oraz jednego
    `operator_dimension > 1024`. Etykieta case ani oczekiwany rozmiar z configu
    nie może zastąpić zmierzonego wymiaru. N3 dostarcza przypadki, A1E recipe i
    verifier; legacy v1 fail-closed nie zamyka release.

### Weryfikacja

```bash
python3 -m pytest -q \
  scripts/test_verify_fem_frequency_domain_eigen_artifacts.py \
  scripts/test_verify_fem_eigen_k0_periodic_airbox_convergence.py \
  scripts/test_verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity.py \
  scripts/test_verify_fem_eigen_k0_periodic_airbox_performance.py \
  scripts/test_verify_fem_frequency_domain_production_dod.py \
  scripts/test_write_fem_frequency_domain_validation_bundle.py

cargo test -p fullmag-runner --lib --quiet
```

**Akceptacja A1S/A1E:** bundle jest self-contained i hash-bound; żadna raw file nie
udaje evidence bez sidecar; field scan i FMR peaks mają kanoniczną proweniencję;
release recipe tworzy DoD dopiero po wszystkich dowodach.

## 18. Etap A2 — typed OpenAPI v2, revisions i realtime invalidation

**Właściciel plików:** Rust API handlers/types/OpenAPI, generated frontend
transport, `ControlRoomApi`, resource hooks i testy API.
**Zależność:** zamrożone A1S schemas.
**Nie edytuje:** prezentacyjnych React components.

### Kroki

1. Zastąp `Option<Value>` typowanymi strukturami dla manifestu, spectrum,
   branches, field sweep, eigen diagnostics, FMR peaks/fits, response sweep,
   progress, point i field metadata.
2. Dodaj pełne `#[utoipa::path]` oraz OpenAPI registration dla każdej routy,
   w tym response diagnostics.
3. Ustal kanoniczne namespace
   `/v2/sessions/current/analysis/frequency-domain/*`. Stare
   `/analysis/eigen/*` pozostają aliasem przez jeden release z deprecation
   telemetry, następnie są usuwane.
4. Revision/ETag licz z content digest oraz source artifact revision, nie ze
   ścieżki i długości.
5. Realtime publikuje resource-specific invalidation dla manifest, spectrum,
   branches, field sweep, diagnostics, mode metadata, response sweep/progress,
   FMR peaks i artifact list. Payload naukowy nadal pobiera HTTP.
6. Mode field metadata zwraca `field_id`, kanoniczne `sample_id`/`mode_id`,
   opcjonalne indeksy prezentacyjne, complex representation, component order,
   units, topology/domain generation, indexing, k/phase convention, source
   revision i native provenance.
7. Ciężkie dane pozostają wyłącznie na canonical vector route; nie dodawaj
   równoległego mode-specific binary codec.
8. `ControlRoomApi.analysis.frequencyDomain` i resource hooks korzystają
   wyłącznie z generated paths/types. React nie buduje endpoint strings.
9. Testuj complete, partial, interrupted, unavailable, malformed, stale ETag,
   content change o tej samej długości, missing mode, invalid topology i
   superseded request abort.
10. Dodaj typowany read-only resource promotion attestation. API weryfikuje
    scientific manifest hash, R1 runtime identity, governance commit i exact
    scope; UI nie wyprowadza `production_qualified` z samej capability matrix.
    Missing/mismatch/unknown signer fail-closed do `unvalidated`.

### Weryfikacja

```bash
cargo test -p fullmag-api router_v2 --no-fail-fast
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room check:api-hygiene
git diff --check -- apps/control-room/src/kernel/api/generated
pnpm --dir apps/control-room test -- --run \
  ControlRoomApi \
  openapiV2GeneratedContract \
  studyRuntimeResources
pnpm --dir apps/control-room typecheck
```

**Akceptacja A2:** generated client nie zawiera `payload?: unknown` dla
frequency-domain; zmiana treści zmienia revision; każdy zasób ma typowany
status i invalidation; binary field ma pełną identity/provenance.

## 19. Docelowa architektura Control Room Results i FMR

### 19.1 Zasada produktu

`results` jest ID najwyższego workspace context, nie samodzielnym modułem.
Kernel `src/kernel/layout` jest właścicielem planowanego presetu
`workspace.results.frequency-domain`; `ribbon` renderuje grupy komend dla
context `results`. Docelowy moduł `results-navigator` z własnym
`apps/control-room/src/modules/results-navigator/manifest.ts` jest właścicielem
zakładki `panel-left` i drzewa wyników. Dzisiejsza zakładka Results wewnątrz
`explorer` jest jawnym compatibility shim: U0 migruje builder/selection do
`results-navigator`, po czym Explorer pozostaje właścicielem pozostałych
zakładek nawigacyjnych i wspólnego panel hosta.

`analysis-plots` jest właścicielem centralnych wykresów, `viewport-3d`
centralnego renderu pól, `inspector` panelu prawego, a `transport-footer`
dolnego docku Jobs/Diagnostics/Quick Chart. Nie powstaje osobna aplikacja,
drugi shell ani drugi viewport. Domyślny layout Results ma Results Navigator po
lewej, aktywną powierzchnię Analysis albo preset istniejącego `viewport-3d` w
centrum, semantyczny Inspector po prawej i dolny dock. Przełączenie powierzchni
nie zmienia kanonicznego modelu sesji.

Modal eigen, driven response i FMR views są rozdzielone:

- **Modal Eigen** jest wynikiem eigenproblem i ma eigenvectors;
- **Driven Response** jest rozwiązaniem wymuszonym dla częstotliwości;
- **FMR Views** to naukowe widoki/presety nad dwoma powyższymi źródłami;
- peak odpowiedzi wymuszonej nie staje się eigenmode;
- zgodność modal/driven jest osobnym validation/comparison artifact.

### 19.2 Docelowe drzewo Results Navigator

```text
Results
└─ Runs
   └─ <run label>
      └─ <stage label>
         └─ Frequency Domain
            ├─ Overview
            ├─ Modal Eigen
            │  ├─ Spectrum                       [viewRef]
            │  ├─ Field Sweep                    [viewRef; gdy bias_field_sweep]
            │  ├─ Dispersion                     [viewRef; gdy k_path]
            │  ├─ Samples                        [kanoniczne drzewo storage]
            │  │  └─ Sample <sampleId>
            │  │     └─ Modes
            │  │        └─ Mode <modeId>
            │  │           ├─ Metadata
            │  │           ├─ Field
            │  │           └─ Residuals
            │  └─ Branches                       [viewRefs]
            │     └─ Branch <branchId>
            ├─ Driven Response
            │  ├─ Frequency Sweep
            │  ├─ Frequency Points
            │  │  └─ Point <pointId>
            │  │     ├─ Observables
            │  │     └─ Field
            │  ├─ Progress
            │  └─ Diagnostics
            ├─ FMR Views
            │  ├─ Modal Resonances
            │  ├─ Driven Sweep
            │  ├─ Peaks
            │  │  └─ Peak <peakId>
            │  ├─ Resonance Fits
            │  │  └─ Fit <fitId>
            │  ├─ Kittel Fit
            │  ├─ Field-Frequency Map            [gdy istnieje kompatybilny dataset 2D]
            │  └─ Modal vs Driven
            ├─ Validation & Provenance
            │  ├─ Requested vs Resolved
            │  ├─ Equilibrium & Mesh
            │  ├─ Operator & Solver
            │  ├─ Residuals & Completeness
            │  ├─ Scope & Qualification
            │  └─ CPU/GPU Parity                 [gdy istnieje]
            └─ Artifacts & Exports
```

Kanoniczną hierarchią modalnych danych jest `Sample -> Mode`; `Branches` oraz
wszystkie `FMR Views` są skrótami `viewRef` do tych samych identyfikowalnych
datasets i SelectionRef. Nie tworzą duplikatu zasobu ani drugiej selekcji.
`Field-Frequency Map` jest widoczny wyłącznie, gdy jeden kanoniczny zasób 2D
publikuje rzeczywistą macierz bias-field × frequency wraz z fail-closed
compatibility certificate wiążącym obie osie, siatkę, observable, jednostki i
source revisions. Taki zasób może utworzyć wersjonowany analysis job; frontend
nie skleja dwóch scanów. Sama obecność dwóch niezależnych scanów nie wystarcza.
`Resources`, `Jobs` i `Diagnostics` zachowują osobne zakładki Explorera dla
technicznego wglądu.

Drzewo nie używa cichego `slice(0, 64)`. Duże listy modes, samples i points są
wirtualizowane albo stronicowane z trwałymi node IDs. Brak zasobu daje jawny
`loading`, `missing`, `unsupported`, `partial` lub `error`, a nie zniknięcie
węzła.

### 19.3 Powierzchnie centralne

W module Analysis należy udostępnić:

1. **Eigen Spectrum** — oś X: mode index/rank, oś Y: frequency z jednostką z
   artefaktu. Tabela jest pełną alternatywą dostępną klawiaturą.
2. **Modal Resonances** — częstotliwości jako markers/stems. Widok może być
   nazwany modalnym FMR dopiero, gdy artifact publikuje fizyczny RF coupling,
   oscillator strength lub inną zatwierdzoną intensywność. Bez tego nie ma osi
   intensywności i nie wolno uruchamiać peak detection na samych eigenfrequency.
3. **Field Sweep** — oś X: jawnie wybrane `H_bias [A/m]` albo pochodne
   `mu0 H_bias [T]`; oś Y: `f [Hz/GHz]`; kolor oznacza branch, a nie backend.
   Konwersja `mu0 H` jest podpisana i nie jest nazywana B bez uzasadnienia.
4. **Driven FMR** — oś X: frequency, oś Y: wybrany observable z dokładną
   jednostką artefaktu. Amplitude, susceptibility, absorbed power, phase i
   residual nie są mieszane bez selektora lub jawnej dual axis.
5. **Field-Frequency Map** — heatmap tylko dla prawdziwego dwuwymiarowego
   datasetu bias field x frequency; nie interpoluje brakujących punktów bez
   oznaczenia.
6. **Dispersion** — modalny k-path, niezależny od time-domain dynamic structure
   factor. DSF pozostaje wariantem Spectrum, nie zastępuje dispersion.
7. **Comparison** — modal markers nakładane na driven curve wyłącznie, gdy
   serwerowy compatibility certificate wiąże: run/stage, equilibrium i bias
   sample, mesh/topology, geometry/material, BC/gauge, damping, drive i jego
   polaryzację, observable i normalizację, phasor convention, modal coupling,
   frequency units/grid oraz exact scope. Brak któregokolwiek wiązania jest
   stanem `incompatible`, nie ostrzeżeniem do zignorowania.
8. **FMR Fits** — peak range wybierany z chart/table uruchamia wersjonowany
   analysis command. UI pokazuje line model, fitted resonance, linewidth, Q,
   uncertainty, covariance/conditioning i residual. Kittel fit korzysta z
   solved Field Sweep i nie może modyfikować ani selekcjonować solver modes.
9. **Modes/Table** — wirtualizowana lista modes z frequency, branch,
   multiplicity, residual, tracking confidence, field availability i
   qualification badge.

Nagłówek każdej powierzchni pokazuje:

```text
product | run/stage | artifact state | qualification | resolved execution
```

Poniżej są controls source/observable/branch/unit, chart + table, a w stopce
selection, revision, partial/dropped count i data provenance. Bottom dock
zachowuje Jobs, Diagnostics i Quick Chart; nie montuje drugiego Analysis.

### 19.4 Inspektory semantyczne

| Węzeł | Obowiązkowa zawartość Inspektora | Główne akcje |
|---|---|---|
| Frequency Domain / Overview | stan run/stage, rodzaje wyników, requested/resolved, complete/partial, qualification | Open Analysis, open diagnostics |
| Modal Eigen | operator, equilibrium, BC/gauge, target/window, count, scan kind | Open Spectrum |
| Spectrum | osie/jednostki, mode count, completeness, source revision | Select mode, export table |
| Field Sweep | pola sample, equilibrium per sample, branch/tracking, missing/partial samples | Select sample/branch |
| Dispersion | k coordinates/units, Floquet convention, branches | Select k/mode |
| Samples (group) | liczba i stronicowanie samples, scan axis, brakujące/partial samples | Expand, open Field Sweep |
| Sample | `sampleId`, fizyczny bias/k-point, equilibrium/operator signature, complete state | Select sample, open modes |
| Modes (group) | liczba modes, completeness window, aktywne filtry i sort | Expand, open table |
| Branches (group) | tracking contract, liczba branches/gaps, source revision | Open branch view |
| Branch | tracking method, overlap/confidence, gaps, fallback reason | Focus branch |
| Mode | frequency, eigenvalue mapping, multiplicity, q/phi/delta-m, full residuals, native provenance | Plot in 3D |
| Mode Metadata | `modeId`, sample/branch refs, normalization, global phase, degeneracy/subspace provenance | Copy reference, open validation |
| Mode Field | field IDs, representation/component, phase, presentation scale, topology/revision, animation | Activate/clear overlay |
| Mode Residuals | magnetic/Poisson/gauge/tangent/reconstruction i SLEPc residual osobno, tolerances | Open evidence |
| Driven Response | drive/polarization, damping, observable catalog, solver i completeness | Open Frequency Sweep |
| Driven Sweep | observable, units, drive, solver/residual, partial state | Select point/export |
| Frequency Points (group) | liczba/stronicowanie points, frequency grid, partial boundary | Expand, open table |
| Response Point | frequency, complex observables, residual, field metadata | Plot response field in 3D |
| Observables | wartości zespolone, physical/proxy kind, units i normalization | Choose chart observable |
| Response Field | complex field IDs, phasor, topology, units i availability | Activate/clear overlay |
| Progress | live stage execution jako primary, artifact fallback i source timestamp | Open Jobs/cancel if legal |
| Diagnostics | EPS/KSP/PC, subwindows, iterations, stop/failure reason i log refs | Open technical Diagnostics |
| FMR Views (group) | dostępne viewRefs, source kinds i qualification każdego widoku | Open selected view |
| Modal Resonances | modal frequencies, coupling/intensity availability, exact source scope | Select mode |
| Driven Sweep (FMR viewRef) | wybrany physical observable, units, source point refs | Select point/peak |
| Peaks (group) | source kind, algorithm/version, liczba zaakceptowanych/odrzuconych peaks | Run approved extraction |
| Peak | `peakId`, source point/mode refs, frequency/intensity/uncertainty i validation | Focus peak/compare |
| Resonance Fits (group) | modele, source revisions, accepted/rejected fits | Start fit job |
| Resonance Fit | model, fit window, baseline, linewidth, Q, covariance, residual, source revision | Refit approved range, export report |
| Kittel Fit | geometry/model, fitted parameters, M_eff/gamma, covariance, conditioning, exclusions, independent reference | Open field sweep, export report |
| Field-Frequency Map | compatibility certificate, obie osie/units, mask braków, interpolation policy | Select sample/point |
| Modal vs Driven | compatibility certificate, frequency delta, tolerance, excluded points | Open comparison |
| Validation & Provenance (group) | exact scope, source/runtime identity, status wszystkich child resources | Open evidence index |
| Requested vs Resolved | requested backend/device/precision i rzeczywiście wykonana ścieżka | Copy provenance |
| Equilibrium & Mesh | hashes, mesh/airbox convergence, region/topology binding | Open mesh evidence |
| Operator & Solver | block/signature digests, target/window, PETSc/SLEPc/MFEM/CUDA versions | Open solver evidence |
| Residuals & Completeness | budgets, cluster/window certificate, rejected/partial modes | Open residual report |
| Scope & Qualification | scope catalog, DoD items, blockers, promotion decision | Open DoD record |
| CPU/GPU Parity | matched signatures, cluster/subspace/residual/outcome deltas | Open parity evidence |
| Artifacts & Exports | schema, hash, size, revision, sidecar, download/export | Verify/download |

Każdy semantic kind ma własne mapowanie. Generic fallback jest dozwolony
wyłącznie dla nieznanego przyszłego schema i musi pokazać `unsupported
inspector`, nie cudzy panel.

### 19.5 Selekcja, komendy i handoff do viewportu

Selection jest dyskryminowaną unią, nie `kind: string`:

```text
ModalSelectionRef
  runId, stageId, artifactRevision
  sampleId, modeId, branchId?
  sampleIndex?, rawModeIndex?    [wyłącznie metadata prezentacyjne]

ResponseSelectionRef
  runId, stageId, artifactRevision
  pointId, observableId?
  frequencyIndex?               [wyłącznie metadata prezentacyjne]
```

`sampleId`, `modeId` i `pointId` są trwałymi identyfikatorami publikowanymi
przez artifacts/API. Indeksy mogą się zmienić po stronicowaniu, sortowaniu,
deduplikacji lub branch tracking i nigdy nie uczestniczą w identity, cache key,
node ID ani request field. `branchId` jest referencją widoku do tego samego
`modeId`, nie alternatywną tożsamością modu.

Przepływ:

```text
WS invalidation
 -> revision pointer
 -> resource hook
 -> HTTP przez ControlRoomApi
 -> typed payload validation
 -> backend-neutral chart/table adapter
 -> global SelectionRef
 -> dedykowany Inspector
 -> jawny Plot in 3D command
 -> field metadata
 -> binary complex vector + topology check
 -> render model
 -> aktywny unified viewport-3d
```

Kliknięcie chart/table/tree ustawia tę samą selekcję. Samo zaznaczenie nie
musi pobierać ciężkiego pola. `Plot in 3D` lub jawne ustawienie auto-preview
tworzy kernel-owned `FieldOverlayIntent` z własnym request tokenem, następnie
może przełączyć centralną powierzchnię z Analysis na preset `viewport-3d`.
Intent nie należy do komponentu źródłowego, dlatego unmount chartu/Analysis po
przełączeniu nie abortuje poprawnego handoffu. Stan `pending` kończy się dopiero,
gdy:

1. metadata jest ready;
2. binary complex field jest ready;
3. domain generation/topology/revision pasują;
4. render model jest zbudowany;
5. viewport potwierdzi nieutracony WebGL i niezerowy drawing buffer.

Nowy intent dla tego samego overlay slotu, jawne `Clear overlay`, usunięcie
run/stage lub unmount docelowego viewportu abortuje metadata, binary request i
budowę modelu. Unmount źródłowego Analysis/Inspector nie abortuje handoffu.
Każdy completion sprawdza request token, selection identity oraz revisions;
spóźniona odpowiedź superseded request jest zwalniana i nie może nadpisać
aktywnego pola. Chart, Inspector i viewport nie importują się wzajemnie;
komunikują się przez kernel commands/events.

### 19.6 Mode representation i animacja

Kontrolki używają wspólnych shadcn-style primitives i klas `fm-*`. Artifact
publikuje `phasor_convention`; renderer nie zgaduje znaku czasu. Dla konwencji
`u(t)=Re(ũ exp(-i omega t))` phase-rotated real wynosi
`Re(ũ exp(-i theta))`; dla `exp(+i omega t)` znak pochodzi z metadata i jest
odwrócony. Tooltip i export zapisują konwencję oraz aktualne `theta`.

Ścisła macierz reprezentacja × komponent × renderer:

| Field/representation | Wartość renderowana | Dozwolony renderer |
|---|---|---|
| complex vector + `Phase-rotated real` | `Re(ũ exp(s i theta))`, `s` z phasor convention | vector glyphs dla `component=vector`; scalar surface/points dla x/y/z/projection |
| complex vector + `Real` | `Re(ũ)` | vector glyphs dla vector; scalar surface/points dla component |
| complex vector + `Imaginary` | `Im(ũ)` z podpisaną konwencją | vector glyphs dla vector; scalar surface/points dla component |
| complex vector + `Magnitude` | dla vector `sqrt(sum_j abs(ũ_j)^2)`, dla component `abs(ũ_j)` | wyłącznie scalar surface/points; brak glyph direction |
| complex vector + `Phase` | `arg(ũ_j)` wyłącznie dla jawnego component/projection | cykliczna scalar palette; brak glyphs; amplitude mask obowiązkowa |
| complex scalar `delta_phi` + real/imag/phase-rotated | odpowiednia część skalaru | scalar surface/points, nigdy glyphs |
| complex scalar `delta_phi` + magnitude/phase | `abs(ũ)` albo `arg(ũ)` | scalar sequential/cyclic palette, nigdy glyphs |

`Phase` wymaga komponentu lub certyfikowanej projekcji, ponieważ faza całego
wektora nie jest pojedynczą wielkością. Amplitude mask ma jawny próg i jednostkę
albo względny udział maksimum, jest widoczny w legendzie i eksporcie oraz
maskuje fazę tam, gdzie jest numerycznie nieokreślona. Magnitude nie dostaje
strzałek, ponieważ nie niesie kierunku.

Domyślnym polem modowym w viewport jest zespolone kartezjańskie
`delta_m_xyz`. Inspector może przełączać na zespolony potencjał `delta_phi`
lub odzyskane `delta_H_demag`, jeżeli artifact publikuje je z własnym field ID,
jednostką i topology binding. Współczynniki tangent `q` pozostają tabelą/
diagnostyką; nie wolno renderować ich jako XYZ bez certyfikowanej mapy ramek.

Każdy mode field publikuje `normalization_kind`, `normalization_reference`,
`phase_reference`, `multiplicity`, `cluster_id`, `basis_id` lub
`invariant_subspace_id` oraz provenance rekonstrukcji. Suwak amplitude scale
jest wyłącznie transformacją prezentacyjną i nie zmienia danych, residuali ani
normalizacji. Dla `multiplicity > 1` pojedynczy eigenvector jest zależny od
wyboru bazy; UI pokazuje ostrzeżenie „basis-dependent representative” i nie
porównuje amplitudy/fazy dwóch reprezentantów bez certyfikowanego subspace
alignment i zgodnej normalizacji/phase reference.

Animacja:

- jest opt-in w zakresie `0.05–10 Hz` prędkości prezentacyjnej;
- używa jednego załadowanego complex field i lokalnej projekcji fazowej;
- nie pobiera ponownie topologii ani pola na tick;
- używa demand rendering poza aktywną animacją;
- zatrzymuje się po clear, zmianie pola, zmianie tabu lub unmount;
- respektuje `prefers-reduced-motion`;
- nie zapisuje large typed arrays w Zustand/React state.

### 19.7 Trzy niezależne osie stanu

UI nie może redukować wszystkiego do zielonego `Ready`:

| Oś | Wartości |
|---|---|
| Stan resource | `idle`, `loading`, `ready`, `stale`, `error` |
| Stan artifact | `complete`, `partial`, `interrupted`, `missing`, `corrupt` |
| Kwalifikacja | `contract_only`, `source_visible`, `executable`, `physics_validated`, `production_qualified` |

Zasady zachowania:

- pierwszy load pokazuje stabilny skeleton;
- stale/refresh zachowuje ostatnie poprawne dane i pokazuje revision badge;
- error z cached data zachowuje chart/table i pokazuje banner/retry;
- error bez danych pokazuje pełny error panel;
- partial/interrupted renderuje ukończone punkty i wyraźny koniec serii;
- malformed/corrupt fail-closed i linkuje Diagnostics;
- unsupported pokazuje capability reason i brakujący warunek;
- route presence nigdy nie oznacza scientific availability.

### 19.8 Lifecycle, wydajność i dostępność

- Jedna instancja ECharts na aktywną powierzchnię; `ResizeObserver`, events i
  rAF są zwalniane przez właściciela.
- Nie ma redraw podczas idle. Zakres danych jest bounded/decimated poza
  tabelą wirtualizowaną.
- Jeden active-only WebGL canvas; topologia jest niezależna od field buffers.
- Przełączenie mode aktualizuje buffers bez rebuild geometry, jeśli topology
  identity jest ta sama.
- Kernel jest właścicielem aktywnego `FieldOverlayIntent`; źródłowy chart lub
  Inspector może się odmontować bez anulowania handoffu. Docelowy viewport jest
  właścicielem GPU resources i ACK.
- Zastąpione geometries/materials/textures/buffers/workers/subscriptions są
  zwalniane.
- Tabela umożliwia pełną nawigację klawiaturą; Enter wybiera, osobny przycisk
  wykonuje `Plot in 3D`, Escape zamyka modalne powierzchnie.
- Status ma tekst i ikonę, nie tylko kolor. Kolory pochodzą z `--fm-*`, Mocha
  i Latte. Wszystkie klasy mają prefix `fm-`.

### 19.9 Docelowa mapa zasobów v2 do powierzchni

Poniższe URI są docelowym kontraktem A2, a nie opisem obecnej kompletności.
Dynamiczne trasy używają kanonicznych IDs; obecne trasy oparte o
`{sample_index}/{mode_index}` i `{frequency_index}` są migracją, nie docelową
identity. Każdy wiersz ma generated type, jeden resource hook, content revision
i własny realtime invalidation key.

| Zasób HTTP pod `/v2/sessions/current/analysis/frequency-domain` | Konsument Results | Ciężki payload |
|---|---|---|
| `/manifest.v1` | Overview, nagłówki i availability drzewa | nie |
| `/eigen/spectrum.v2` | Spectrum, Modal Resonances, Modes table | nie |
| `/eigen/field-sweep.v1` | Samples, Field Sweep | nie |
| `/eigen/branches.v2` | Branches/Branch, Dispersion refs | nie |
| `/eigen/dispersion.v1` | Dispersion | nie |
| `/eigen/diagnostics/solver.v1` | Operator & Solver, Diagnostics | nie |
| `/eigen/samples/{sampleId}/modes/{modeId}/metadata.v1` | Mode/Metadata/Residuals Inspector | nie |
| `/eigen/samples/{sampleId}/modes/{modeId}/fields/{fieldKind}/meta` | Mode Field i handoff | metadata tylko; bytes przez canonical field route |
| `/response/magnetic-sweep.v2` | Driven Sweep | nie |
| `/response/frequency-points/{pointId}.v1` | Point/Observables Inspector | nie |
| `/response/frequency-points/{pointId}/fields/{fieldKind}/meta` | Response Field i handoff | metadata tylko; bytes przez canonical field route |
| `/response/progress.v1` | artifact progress fallback | nie |
| `/response/diagnostics/solver.v1` | driven Diagnostics | nie |
| `/fmr/peaks.v1` | Peaks/Peak | nie |
| `/fmr/resonance-fits.v1` | Resonance Fits/Fit | nie |
| `/fmr/kittel-fit.v1` | Kittel Fit | nie |
| `/fmr/field-frequency-map.v1` | Field-Frequency Map | binarna/chunked macierz przez wspólny analysis data-plane descriptor |
| `/fmr/modal-driven-compatibility.v1` | Modal vs Driven | nie |
| `/validation/provenance.v1` | Validation & Provenance subtree | nie |
| `/artifacts.v1` | Artifacts & Exports | nie |

Mode/response field metadata zwraca `field_id`. Dopiero potem jeden istniejący
data plane `/v2/sessions/current/data/fields/{field_id}/samples/vector` zwraca
tablicę binarną. Nie powstaje drugi codec ani React-side endpoint builder.
Field-Frequency Map również nie trafia do cienkiego statusu; descriptor wskazuje
wersjonowany/chunked payload właściwy dla analysis data plane.

## 20. Etapy U0, U1 i U2 — wykonanie UI

### U0 — information architecture i czyste modele

**Właściciel:** nowy `results-navigator` manifest/builder, migracja compatibility
shim z `explorer`, selection types, pure adapters i kernel layout preset.
**Zależność:** A1S/A2 schema freeze.
**Równolegle:** z U1 scaffold i U2 fixtures, bez wspólnych plików.

1. Zarejestruj module ID `results-navigator` w `panel-left`, przenieś Results
   tree z compatibility tabu Explorera i dodaj kernel-owned preset
   `workspace.results.frequency-domain`. `ribbon` używa context ID `results`.
2. Usuń duplikaty danych w gałęziach FMR/calculation modes/dispersion; pozostaw
   view refs.
3. Dodaj stabilne node IDs z run/stage oraz kanonicznych `sampleId`, `modeId`,
   `pointId`; indeksy są wyłącznie metadata prezentacyjnymi.
4. Wirtualizuj lub stronicuj modes/branches/points; usuń silent slice.
5. Rozszerz manifesty `results-navigator`/Explorer o wszystkie rzeczywiście
   słuchane/emitted events i usuń shim po zakończeniu migracji.
6. Usuń placeholder `ready` bez resource truth.
7. Zastąp luźne selection refs dyskryminowaną unią i dodaj kernel-owned
   `FieldOverlayIntent` odporny na unmount powierzchni źródłowej.
8. Rozdziel pure adapters na manifest, spectrum, scan, branches, response i
   FMR peaks; wszystkie przyjmują typed payload.

**Bramka U0:** każdy semantic node ma resource/state/inspector mapping;
chart/table/tree tworzą identyczny SelectionRef; duże listy są bounded.

### U1 — Analysis, Results i Inspectors

**Właściciel:** `analysis-plots`, Inspector registry/panele, Results ribbon i
styles.
**Zależność:** U0 i generated client A2.

1. Zaimplementuj powierzchnie z sekcji 19.3.
2. Napraw osie spectrum oraz units response z artefaktu.
3. Dodaj prawdziwy frequency-domain Dispersion/Field Sweep zamiast DSF
   mismatch.
4. Live stage execution jest primary progress; artifact progress jest
   fallback po zakończeniu/odłączeniu.
5. Podziel `FrequencyDomainResultInspectors.tsx` według domen:

   ```text
   frequency-domain/overview/
   frequency-domain/eigen/
   frequency-domain/scan/
   frequency-domain/response/
   frequency-domain/fmr/
   frequency-domain/validation/
   frequency-domain/resources/
   frequency-domain/diagnostics/
   ```

   Podział zachowuje publiczny registry contract i nie jest okazją do zmian
   niepowiązanych z FMR/eigen UI.
6. Każdy panel pobiera tylko własne zasoby. Brak `as unknown as` i lokalnego
   parsowania wrappera zamiast `.payload`.
7. Dodaj export CSV/TSV/PNG z chart descriptor, units, revision i provenance.
8. Dodaj analysis commands/jobs dla peak extraction, resonance fit i Kittel
   fit. Inspector przechowuje jedynie draft range/model; wynik jest zasobem
   serwera związanym z source revision.

**Bramka U1:** fizyczne osie i jednostki są zgodne w modelu, rendererze,
tooltip, tabeli i eksporcie; Inspector coverage jest kompletne; partial/stale/
error zachowują ostatnie ważne dane.

### U2 — unified viewport mode fields

**Właściciel:** overlay controller/commands, handoff controller, viewport
resource hooks i render model.
**Zależność:** A2 mode metadata i U0 SelectionRef.

1. Dokończ command -> metadata -> binary field -> topology -> viewport ACK.
2. Przekazuj k vector, cell origin, Floquet/spatial phase i phasor convention
   z metadata; dla K0 wartości są jawnie zerowe, nie domyślne.
3. Wspieraj real/imag/magnitude/phase/phase-rotated real dokładnie według
   macierzy z 19.6, łącznie z phasor convention, amplitude mask, zakazem
   bezkierunkowych glyphs, scalar `delta_phi`, normalization i degeneracy.
4. Nie rebuild topologii przy zmianie field/phase na tym samym topology ID.
5. Abortuj superseded loads, clear i target-viewport unmount; nie abortuj po
   unmount źródłowego Analysis. Odrzucaj late completion przez request token.
6. Dodaj memory stress dla co najmniej 100 zmian mode/phase/tab.
7. Browser smoke osobno dla CPU i GPU native field; fixture smoke jest tylko
   testem UI.

**Bramka U2:** wybrany mode daje wizualnie inne pole niż inny mode, zmiana fazy
zmienia obraz, canvas pozostaje aktywny, a pamięć i liczba GPU resources są
bounded.

## 21. Etapy kwalifikacji Q1–Q3

### R1 — integracja i zamrożenie runtime release candidate

**Właściciel:** jedyny integration/runtime owner.
**Zależność:** scalone C1–C3, N1–N3, A1S/A1E, A2 i U0–U2; clean
release-candidate commit. Po R1 nie może pozostać żaden lane implementacyjny.

1. Sprawdź ancestry względem aktualnego `master`, dirty state i source
   snapshot.
2. W trybie host-wide read-only potwierdź właściciela locka oraz rzeczywiste
   mounty `/zfn2` i `/mnt/fullmag-zfn2-native`; nie usuwaj locka i nie zabijaj
   procesu bez odrębnej autoryzacji.
3. Wykonaj container-backed `just rebuild-fem-runtime`, potem `ensure` i
   source-provenance verification.
4. Zamroź symlink, runtime manifest, ABI/layout fingerprint, PETSc/SLEPc/MFEM/
   CUDA/device identity i command logs.
5. Uruchom native contract smoke CPU/GPU, typowany API decode, frontend
   typecheck i fixture browser smoke. Każda runtime-relevant zmiana kodu,
   generatora, schema, recipe lub UI po tym kroku unieważnia R1 i wszystkie
   Q1–Q3.

**Bramka R1:** Q1/Q2 konsumują dokładnie jeden read-only runtime manifest;
żaden lane solvera ani qualification owner nie przebudowuje lub przełącza go.

### Q1 — kwalifikacja CPU

**Właściciel:** niezależny qualification owner, który nie pisał solvera CPU.
**Zależność:** zaakceptowane R1, A1S oraz gotowy staging A1E.
**Zakaz:** żadnych zmian implementacyjnych podczas zbierania evidence.

1. Utwórz exact CPU scope JSON i wpis scope catalog.
2. Zweryfikuj i zamontuj read-only runtime manifest zamrożony w R1; nie
   przebudowuj runtime w lane Q1.
3. Wykonaj manufactured Poisson, reciprocity, sign/energy, dense/full/Schur,
   target-axis negative control i finite-mode classification.
4. Wykonaj niezależny bias-field scan. Każdy sample ma własne fizyczne pole,
   equilibrium, certificate i operator signature.
5. Porównaj z niezależnym Kittel reference po solve. Raport zawiera
   `M_eff_reference`, fitted `M_eff`, uncertainty, conditioning i jawne
   tolerancje.
6. Wykonaj co najmniej trzy niezależne poziomy mesh przy stałym airbox oraz
   trzy poziomy airbox padding przy stałym mesh. Nie duplikuj wierszy ani nie
   zmieniaj obu osi naraz.
7. Dla każdego accepted mode zweryfikuj magnetic, Poisson, gauge, tangent i
   reconstruction residual oraz completeness certificate.
8. Wygeneruj CPU oracle dla tych samych trzech performance cases, które będą
   użyte w Q2, w tym rzeczywisty `operator_dimension > 1024`; zapisuj DOF z
   native artifact. Brak CPU rozwiązania tego przypadku blokuje scalable GPU
   scope i nie może być zastąpiony mniejszym oracle.
9. Zmierz bounded CPU time/memory envelope dla dokładnego zakresu i zapisz
   command-level time/RSS/solver counters. Ten rekord zamyka CPU część DOD-13.
10. W CPU DoD zapisz DOD-12 wyłącznie jako `not_applicable` z dokładnym reason
   code `validated_scope.device=cpu excludes GPU`; verifier odrzuca każdy inny
   reason oraz użycie tego statusu dla właściwych CPU items.
11. Wygeneruj raw CPU `staging_index.v1.json`; per-bundle evidence manifest
    powstaje dopiero podczas atomowego ingest A1E. Nie promuj DoD przed Q3.

**Akceptacja Q1:** K0-P1–K0-P6 przechodzą dla exact CPU scope, żaden oracle nie
wpływa na solve, convergence budgets są rozdzielone, a wszystkie raw artifacts
są hash-bound; CPU DOD-13 ma zmierzoną envelope, a DOD-12 ma jedyne dozwolone
`not_applicable`.

### Q2 — kwalifikacja GPU

**Właściciel:** niezależny GPU qualification owner.
**Zależność:** zaakceptowany Q1 oracle oraz N3.
**Zasób współdzielony:** GPU używane sekwencyjnie przez jeden run owner.

1. Utwórz exact GPU scope JSON odpowiadający CPU w fizyce, precision, mesh,
   fields i target policy.
2. Materializuj niezależne CPU/GPU v6 equilibrium states i porównaj je
   tolerancją fizyczną; nie wymagaj bitowej równości lane-specific hashes.
3. Na identycznym `operator_input_signature_sha256` porównaj:

   - bloki i random actions;
   - Poisson solve i Schur action;
   - eigenvalue/frequency clusters;
   - invariant subspace/mode overlaps;
   - full residuals;
   - accepted/rejected outcomes;
   - artifacts i mode fields.
4. Wykonaj trzy mesh i trzy airbox sequences również dla GPU.
5. Wykonaj co najmniej trzy rzeczywiste rozmiary, z których jeden przekracza
   próg 1024 niewiadomych production matrix-free/scalable path. Rozmiary są
   mierzone z artefaktu, nie etykietowane arbitralnie `128/256/512`.
6. Dla cold/reuse/invalidation runs zmierz time, GPU memory, allocations,
   transfer events/bytes, EPS/KSP iterations, applies, restarts i stop reason.
7. Niezależny trace musi wykazać zero per-iteration full-vector H2D/D2H i brak
   hidden host solve w hot loop.
8. Wykonaj cancel przed solve, podczas EPS i między subwindows; partial bundle
   zachowuje wyłącznie certyfikowane modes.
9. Wykonaj Compute Sanitizer co najmniej dla memory, race i sync coverage
   właściwej dla użytego CUDA path. A1E rozszerza istniejącą memcheck-only
   recipe o osobne `memcheck`, `racecheck` i `synccheck` producers/sidecars.
10. Wykonaj strict negative controls: brak CUDA, HYPRE, SLEPc, memory admission,
    stale ABI/certificate i nielegalny input — zawsze bez CPU fallbacku.

**Akceptacja Q2:** K0-G1–K0-G4 przechodzą, parity jest exact-scope, scalable
lane >1024 ma obowiązkowy dowód, a DOD-13 opiera się na niezależnym trace, nie
self-report.

### Q3 — produkt, browser i release

**Właściciel:** release owner; żadnych zmian źródłowych.
**Zależność:** Q1, Q2, A1E, A2, U1 i U2.

Q3 ma dwa jawne podzakresy: `Q3-M` jest obowiązkowym proof modalnego release
CPU/GPU; `Q3-D` kwalifikuje driven-response UI dopiero z osobnymi CPU/GPU scope
i K0-P7. Evidence Q3-D nie jest dopisywane do modalnego DoD. Jeśli driven scope
nie jest jeszcze przyjęty, Q3-M może promować modalny eigensolver, ale cały
driven subtree pozostaje `unvalidated` i nie wolno nazwać go produkcyjnie
domkniętym.

1. Uruchom pełny artifacts/OpenAPI decode na raw CPU i GPU bundle.
2. Uruchom Control Room z rzeczywistym session/runtime, bez przechwytywania
   `/v2/**` przez fixtures.
3. Dla CPU i GPU osobno:

   - otwórz Results Navigator i właściwy run/stage;
   - potwierdź requested/resolved execution i native provenance;
   - otwórz Eigen Spectrum oraz Field Sweep;
   - wybierz mode z chart, table i tree — SelectionRef musi być identyczny;
   - otwórz Mode Inspector i pełne residuals;
   - wykonaj `Plot in 3D` dla real, imag, magnitude, phase i phase-rotated real;
   - zmień mode i phase, potwierdź różnicę renderu;
   - włącz/wyłącz animację i sprawdź cleanup;
   - potwierdź `gl.isContextLost() == false`, widoczny canvas i drawing buffer
     większy od zera;
   - wykonaj 100 przełączeń mode/phase/tab i sprawdź bounded memory/resources;
   - sprawdź stale/partial/interrupted/error/corrupt/unsupported states;
   - otwórz Modal Resonances, driven FMR i comparison bez mieszania source
     kinds ani sugerowania intensywności bez coupling artifact.
   - w podzakresie Q3-D wybierz rzeczywisty `Response Point`, otwórz jego
     Observables/Response Field Inspector, wykonaj `Plot response field in 3D`
     dla real, imag, magnitude, phase i phase-rotated real oraz zapisz te same
     field/topology/revision, WebGL, screenshot i cleanup evidence co dla mode.
4. Powtórz smoke w Catppuccin Mocha i Latte oraz z
   `prefers-reduced-motion`.
5. Zapisz screenshot hashes, browser log, resource IDs/revisions, source/runtime
   identity, field/topology IDs i WebGL metrics jako oddzielne evidence sidecars
   `modal_cpu`, `modal_gpu`, `driven_cpu` i `driven_gpu`. Dwa ostatnie są
   wymagane dla Q3-D, nigdy jako substytut Q3-M.
6. Uruchom pre-release managed regression oraz expected negative controls na
   zamrożonym R1 i zapisz hash-bound `pre_release_regression.v1.json`.
7. Ingestuj Q1, Q2, browser i pre-release evidence z trwałego staging do
   odpowiednich CPU/GPU bundle.
8. Uruchom DoD writer i verifier. Wymagaj `pass` dla właściwych items,
   wyłącznie schema-dozwolonych `not_applicable`,
   `promotion_decision=production_qualified` i `open_blockers=[]` osobno dla
   CPU i GPU.
9. Utwórz immutable final scientific release manifest referujący oba
   zweryfikowane DoD records. Żaden krok nie uruchamia ponownie destructive raw
   producer.
10. Zamknij Q3 bez zmiany source tree. Aktualizacja capability/readiness jest
    osobnym G2 i nie może być częścią commitu R1 ani evidence runu.

**Akceptacja Q3:** natywny runtime, API, UI i viewport są związane z tym samym
snapshotem i scope; wszystkie DoD mają dowody; fixture smoke nie jest użyty
jako produkcyjna kwalifikacja.

### G2 — governance promotion bez zmiany kwalifikowanego runtime

**Właściciel:** release governance owner.
**Zależność:** przyjęty Q3 i immutable final scientific manifest.

1. Utwórz osobny commit na dokładnym R1 ancestry. Dozwolona allowlista obejmuje
   wyłącznie `docs/specs/capability-matrix-v0.json`, readiness matrix/catalog,
   statusowe dokumenty masterplanu, manifest dokumentacji i deterministycznie
   wygenerowany full pack. Żaden kod, schema, recipe, test fixture, generated
   client ani runtime manifest nie może się zmienić.
2. Promuj wyłącznie exact CPU/GPU scope IDs. Każdy wpis przechowuje R1 commit,
   runtime source snapshot, final scientific manifest URI/hash i pozostawia
   szersze zakresy `unvalidated`.
3. Uruchom generator/check, scientific docs tests i allowlist diff verifier.
   Jakakolwiek ścieżka poza allowlistą unieważnia R1–Q3 zamiast być ignorowana.
4. Utwórz `promotion_attestation.v1.json`, który wiąże:

   - `qualified_runtime_commit` i source snapshot z R1;
   - `governance_promotion_commit` z G2;
   - final scientific manifest URI/hash;
   - dokładne CPU/GPU scope bindings;
   - allowlist diff digest i wyniki verifierów.

5. Control Room/API pokazuje `production_qualified` tylko po zweryfikowaniu tej
   attestation; brak lub mismatch pozostawia `unvalidated`. Mechanizm odczytu i
   typowany resource muszą być zaimplementowane przed R1 w A1E/A2.

**Akceptacja G2:** dwie tożsamości są jawne i hash-bound; governance commit nie
udaje commitu, z którego zbudowano solver, a kwalifikowany runtime nie wymaga
ponownego builda z powodu zmiany dokumentów statusowych.

## 22. Macierz zadań dla wielu subagentów

| Lane | Właściciel i wyłączny zakres plików | Zależności wejściowe | Artefakt wyjściowy | Może biec równolegle z |
|---|---|---|---|---|
| G0 | integration owner; Git, merge, generators, runtime pointer | obecny recovery | zintegrowany clean baseline commit | tylko read-only audyty |
| L0/C1 | physics/docs owner; 0830, source map, masterplan, capability/ADR | G0 | zaakceptowany scope i physics contract | wstępne UI fixtures |
| L1/C2 | DSL/IR/planner owner; Python study, Scene, IR, plan, UI authoring | C1 | BiasFieldSweep round-trip i legal plan | C3 design, U0 fixtures |
| L2/C3 | ABI/certificate owner; include, C ABI, FFI, layout tests | C1 + payload design | zamrożony ABI/certificate manifest | C2 po uzgodnieniu typów |
| L3/N1 | assembly owner; native shared-domain operators/tests | C2 + C3 | pełne MFEM blocks/digests | UI/API schema work |
| L4/N2 | CPU owner; CPU modal/Schur/tests/diagnostics | N1 + C3 | CPU engine i raw contract evidence | N3 implementation po ABI freeze |
| L5/N3 | GPU owner; PETSc/SLEPc CUDA/tests/telemetry | N1 + C3 | persistent GPU engine i raw telemetry | N2 implementation |
| L6/A1S | artifact-schema owner; runner writer/tracking/spec/schema verifiers | C2/C3/N1 schema | typed bundles i zamrożony contract | N2, N3; potem A2/U0 fixtures |
| L6E/A1E | evidence/release owner; staging/DoD/release recipes | A1S | fixed staged-release DAG | A2/U0/U1 implementacja |
| L7/A2 | API owner; Rust handlers/OpenAPI/generated client/hooks | A1S schema | typed resource plane | U0 pure adapters |
| L8/U0 | explorer/selection/adapters owner | A1S/A2 schema | stabilne drzewo i selection | U1/U2 fixtures |
| L9/U1 | Analysis/Inspector owner | A2 + U0 | spectrum/FMR/scan UI | U2 |
| L10/U2 | viewport owner | A2 + U0 | complete field handoff/render | U1 |
| R1 | jedyny integration/runtime owner; merge, managed pointer, runtime manifest | N2 + N3 + A1E + A2 + U0 + U1 + U2 | świeży zamrożony runtime/UI/release-tooling RC | brak lane'ów implementacyjnych |
| L11/Q1 | niezależny CPU qualification owner | R1 + A1S + A1E staging | exact CPU evidence | UI unit tests; nie source changes |
| L12/Q2 | niezależny GPU qualification owner | Q1 + N3/A1S + A1E staging | exact GPU/parity/perf evidence | browser fixture tests; nie GPU run |
| L13/Q3 | release owner | wszystkie lane'y + R1/Q1/Q2 | native browser + DoD + scientific manifest | brak zmian źródłowych |
| G2 | governance owner; allowlist capability/readiness docs | Q3 | promotion commit + attestation | nic; wykonywany po evidence freeze |

### Punkty integracyjne

1. **I1:** C1 zamraża equations, units, scope i field-scan semantics.
2. **I2:** C2/C3 zamrażają ProblemIR, certificates i ABI.
3. **I3:** N1 publikuje native block contract; N2/N3 nie duplikują assembly.
4. **I4:** A1S zamraża artifacts schema; A2 generuje transport; A1E zamraża
   evidence ingest i staged-release.
5. **I5:** U0 zamraża selection/node contracts; U1/U2 integrują się przez
   kernel events.
6. **I6:** po integracji wszystkich lane'ów R1 buduje i zamraża jeden runtime;
   Q1/Q2/Q3 zbierają evidence bez patchowania lub przełączania runtime.
7. **I7:** G2 zmienia tylko allowlistowane dokumenty statusowe i tworzy
   attestation wiążącą runtime commit R1 z governance commit; reszta zmian
   unieważnia evidence.

Każdy lane kończy się krótkim handoff zawierającym: commit, zmienione pliki,
kontrakt wejścia/wyjścia, uruchomione testy z exit code, nierozwiązane ryzyka i
czy zmiana unieważnia wcześniejsze fixtures/evidence.

## 23. Mapa `DOD-01`–`DOD-14`

W chwili audytu wszystkie pozycje są **otwarte dla dokładnego bieżącego
snapshotu**. `source_visible` lub historyczny run nie stanowią pass.

| DoD | Co częściowo istnieje | Brakujący dowód zamykający | Właściciel |
|---|---|---|---|
| DOD-01 Physics note | nota 0830 i masterplan | korekta field scan/Aqq/GPU claims, source-map validation, exact scope | C1 |
| DOD-02 Python/UI round-trip | Eigenmodes authoring i Scene lowering | BiasFieldSweep Python -> IR -> UI/export -> Python identity | C2/U1 |
| DOD-03 ProblemIR validation | liczne validation reasons | nowe positive/negative scan, units, K0, BC/gauge/device cases | C2 |
| DOD-04 Planner legality | CPU/GPU resolution i fail-closed FDM | świeży strict CPU/GPU/auto/fallback proof z provenance | C2/Q1/Q2 |
| DOD-05 Equilibrium/mesh certs | v6 structs i builder | native map-binding, region/airbox, corners/seams/frame/invalidation | C3/N1 |
| DOD-06 Native assembly | część P/Aqphi/Aphiq/Bqq | pełne natywne Aqq i independent MFEM oracles | N1/Q1 |
| DOD-07 Solver engine | CPU Schur i GPU PETSc/SLEPc source | convergence reasons, complete window, restart/stop, no fallback | N2/N3/Q1/Q2 |
| DOD-08 Full residual | q/phi/gauge residual code | każdy accepted mode, oryginalne nieskalowane bloki, scope tolerances | N2/N3/Q1/Q2 |
| DOD-09 Artifacts/OpenAPI/UI | writer, routes, Results/overlay | typed scan/FMR, sidecars, revisions, states, native browser | A1S/A2/U1/U2/Q3 |
| DOD-10 Analytical validation | historyczny Kittel i oracles | independent physical scan, M_eff ref/fit/uncertainty, no leakage | Q1/Q2 |
| DOD-11 Convergence | recipes i verifier | różne 3 mesh + 3 airbox CPU/GPU, raw rows i osobne budgets | Q1/Q2 |
| DOD-12 CPU/GPU parity | historyczna bounded zgodność | CPU: dozwolone `not_applicable` z exact reason; GPU: signature, block/action/mode/residual/outcome/state parity | Q1/Q2 |
| DOD-13 Performance/residency | capture/verifier i self-report | CPU: measured bounded envelope; GPU: >1024, 3 sizes, independent trace, memory, cancel, 3 sanitizers | Q1/N3/Q2 |
| DOD-14 Release regression | recipes i DoD writer | pre-release regression, negatives, verified DoD, scientific manifest i two-identity promotion attestation | A1E/Q3/G2 |

## 24. Sekwencja komend wydaniowych po naprawie kodu

Poniższe ścieżki są częścią planowanego kontraktu i mają zostać utworzone w
A1E/Q1/Q2:

```text
validation/frequency_domain/k0/cpu_scope.v1.json
validation/frequency_domain/k0/gpu_scope.v1.json
validation/frequency_domain/k0/gpu_performance_release.v2.json
validation/frequency_domain/k0/governance_promotion_allowlist.v1.json
```

### 24.1 Dokumenty i lekkie kontrakty

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json \
  --repo-root .
python3 scripts/build_fd_solver_masterplan_full_pack.py --check

PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests
cargo test -p fullmag-ir --quiet
cargo test -p fullmag-plan --quiet
cargo test -p fullmag-runner --lib --quiet
cargo test -p fullmag-api router_v2 --no-fail-fast

pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room test
```

### 24.2 Managed runtime i native contracts

```bash
just rebuild-fem-runtime
just ensure-managed-fem-runtime
just verify-managed-fem-runtime-source-provenance
just inspect-managed-fem-frequency-domain-deps
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-gpu-petsc-slepc-runtime
```

### 24.3 CPU i GPU raw physics

```bash
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell
just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu

just verify-fem-frequency-domain-eigen-k0-gpu-petsc-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-gpu
```

### 24.4 GPU performance i residency

```bash
just capture-fem-frequency-domain-eigen-k0-poisson-airbox-performance \
  validation/frequency_domain/k0/gpu_performance_release.v2.json \
  .fullmag/qualification/fem-k0/staging/gpu/performance/fem_k0_modal_performance.v1.json

just verify-fem-frequency-domain-eigen-k0-poisson-airbox-performance \
  .fullmag/qualification/fem-k0/staging/gpu/performance/fem_k0_modal_performance.v1.json
```

Te polecenia stają się wydaniowe dopiero po implementacji v2 w N3/A1E. Recipe
odrzuca legacy tiers `128/256/512`, a verifier czyta trzy rzeczywiste wartości
`operator_dimension` z outputu, w tym jedną >1024, oraz wiąże odpowiadające im
CPU oracle records z Q1.

### 24.5 Produkcyjne scope i release

Po poprawieniu DAG A1E indeksy wejściowe są generowane z raw/convergence/
parity/performance/browser artifacts w trwałym staging poza katalogami
czyszczonymi przez production producers:

```text
.fullmag/qualification/fem-k0/staging/cpu/staging_index.v1.json
.fullmag/qualification/fem-k0/staging/gpu/staging_index.v1.json
.fullmag/qualification/fem-k0/staging/browser/staging_index.v1.json
.fullmag/qualification/fem-k0/staging/gpu/performance/fem_k0_modal_performance.v1.json
```

Każdy `staging_index` używa ścieżek względnych względem staging, a każdy wpis ma
hash, size, producer command/exit, source/runtime/scope identity i sidecar. Nie
jest on podawany bezpośrednio do obecnego validation-bundle writera. Recipe
staged-release kopiuje zweryfikowane bytes do tymczasowych CPU/GPU bundle roots
i generuje w każdym z nich nowy `evidence_manifest.v1.json` ze ścieżkami
względnymi względem tego bundle root, zgodnie z kontraktem writera. Producer nie
może usuwać staging input. W końcowej części Q3, po zapisaniu browser i
pre-release evidence, uruchamia się wyłącznie nową recipe; legacy production
CPU/GPU/release recipes, które ponownie uruchamiają producers lub czyszczą
katalog wejściowy, nie są dozwolone:

```bash
FULLMAG_FEM_K0_CPU_SCOPE_JSON=validation/frequency_domain/k0/cpu_scope.v1.json \
FULLMAG_FEM_K0_GPU_SCOPE_JSON=validation/frequency_domain/k0/gpu_scope.v1.json \
FULLMAG_FEM_K0_STAGING_DIR=.fullmag/qualification/fem-k0/staging \
FULLMAG_FEM_K0_CPU_STAGING_INDEX=.fullmag/qualification/fem-k0/staging/cpu/staging_index.v1.json \
FULLMAG_FEM_K0_GPU_STAGING_INDEX=.fullmag/qualification/fem-k0/staging/gpu/staging_index.v1.json \
FULLMAG_FEM_K0_BROWSER_STAGING_INDEX=.fullmag/qualification/fem-k0/staging/browser/staging_index.v1.json \
FULLMAG_FEM_K0_PERFORMANCE_JSON=.fullmag/qualification/fem-k0/staging/gpu/performance/fem_k0_modal_performance.v1.json \
FULLMAG_FEM_K0_FINAL_RELEASE_DIR=.fullmag/qualification/fem-k0/final \
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-staged-release
```

Recipe musi fail-closed, jeżeli final directory już istnieje, staging jest
modyfikowany podczas runu, brakuje pre-release regression/negative-control
record, dowód ma inny snapshot lub którykolwiek DoD pozostaje otwarty. Obecna
legacy release recipe nie spełnia tej kolejności; jej zielony exit code nie jest
release proof.

### 24.6 Governance promotion G2

Po commicie zmieniającym wyłącznie allowlistowane dokumenty statusowe:

```bash
FULLMAG_FEM_K0_SCIENTIFIC_MANIFEST=.fullmag/qualification/fem-k0/final/release_manifest.v1.json \
FULLMAG_FEM_K0_GOVERNANCE_ALLOWLIST=validation/frequency_domain/k0/governance_promotion_allowlist.v1.json \
FULLMAG_FEM_K0_PROMOTION_DIR=.fullmag/qualification/fem-k0/promotion \
just attest-fem-frequency-domain-eigen-k0-poisson-airbox-promotion
```

Recipe odczytuje qualified R1 commit/snapshot z scientific manifestu,
`governance_promotion_commit` z bieżącego HEAD, sprawdza ancestry i allowlist
diff, ponownie weryfikuje scope/hash bindings i tworzy nowy katalog promotion.
Nie zapisuje niczego do immutable scientific final directory.

## 25. Testy UI i browser — dokładna matryca odbioru

### 25.1 Contract i pure-model tests

- single-sample modal spectrum;
- bias-field sweep z co najmniej trzema polami;
- k-path z branch gaps;
- degeneracy i subspace tracking;
- overlap tracking i jawny frequency fallback;
- partial/interrupted/corrupt response;
- content revision change przy tej samej długości payloadu;
- physical power vs proxy units;
- brak oscillator strength w modal spectrum;
- resonance fit z poprawnym linewidth/Q/covariance oraz odrzuceniem źle
  uwarunkowanego lub zbyt krótkiego zakresu;
- Kittel fit z niezależnym source/reference i zakazem wpływu na selection;
- SI/display conversion A/m i `mu0 H`;
- brak branch identity rekonstruowanej przez sort frequency/raw mode index;
- trwałe `sampleId`/`modeId`/`pointId` po sortowaniu, stronicowaniu i refresh;
- odrzucenie comparison oraz Field-Frequency Map przy niekompatybilnym drive,
  observable, damping, topology, phasor, bias sample lub source revision;
- degeneracy: basis-dependent representative, normalization i phase-reference
  bez niedozwolonego porównania amplitud.

### 25.2 Component/integration tests

- każdy Explorer kind ma unikalny Inspector;
- `results-navigator` jest zarejestrowany w `panel-left`, compatibility tree nie
  jest równolegle duplikowany w Explorerze, a context/layout IDs są stabilne;
- tree/chart/table współdzielą jeden SelectionRef;
- Results view refs nie duplikują resources;
- `loading -> ready -> stale -> error` zachowuje last valid data;
- partial ma jawny koniec i liczniki;
- unsupported pokazuje reason;
- modalny oraz driven-field `Plot in 3D` używają jednego kernel handoff;
- metadata ready + binary missing pozostaje jawnie pending/error i nie tworzy
  syntetycznego pola;
- topology/revision mismatch fail-closed przed utworzeniem render modelu;
- superseded selection, clear i target viewport unmount abortują request;
  source Analysis unmount nie abortuje poprawnego handoffu;
- spóźniony superseded completion nie nadpisuje aktywnego overlay;
- zmiana phase/component na tym samym topology ID nie rebuildi geometry;
- representation/component/renderer matrix blokuje glyphs dla magnitude,
  phase i `delta_phi`, a phase stosuje amplitude mask;
- ECharts mount/dispose/ResizeObserver/events cleanup;
- zero idle redraws;
- 100 surface switches bez wzrostu instancji;
- keyboard navigation, axe i reduced-motion;
- Mocha/Latte token compliance i wyłącznie `fm-*` classes.

### 25.3 Native browser proof

Każdy backend CPU/GPU oraz każdy tryb pola real/imag/magnitude/phase/
phase-rotated-real jest osobnym przypadkiem dowodowym. Jedna screenshot nie
kwalifikuje wszystkich wariantów. Proof musi zapisać:

- source/runtime/scope identity;
- requested/resolved device;
- artifact/field/topology revision i IDs;
- mode/sample/branch/frequency selection;
- canvas visibility;
- `isContextLost=false`;
- drawing buffer width/height >0;
- screenshot przed/po zmianie mode i phase;
- dowód, że topology object identity nie zmienia się przy phase tick, lecz
  field buffer/render output się zmienia;
- normalization, phase reference, multiplicity/cluster/basis provenance dla
  wybranego modu;
- resource/memory counts przed i po stress loop;
- browser console/network errors;
- brak fixture interception i `source_of_truth=native_runtime`.

Macierz wykonuje się osobno dla `field_source=modal_mode` w Q3-M oraz
`field_source=driven_response_point` w Q3-D, każdorazowo na CPU i GPU. Driven
proof wymaga zaakceptowanego K0-P7/scope i zawiera drive/polarization,
observable/normalization, damping i phasor convention; bez niego UI może być
funkcjonalnie obecne, ale pozostaje `unvalidated`.

## 26. Ryzyka, stop conditions i zakazane skróty

1. Jeśli po G0 branch nadal jest za `master`, prace implementacyjne zatrzymują
   się.
2. Jeśli runtime manifest nie pasuje do snapshotu/ABI, żadnego native wyniku
   nie zapisuje się jako evidence.
3. Jeśli `A_qq` pozostaje runner-owned, nie wolno zamknąć DOD-06.
4. Jeśli Kittel metadata steruje polem, nie wolno zamknąć DOD-10.
5. Jeśli window pomija failed subwindow lub nie ma coverage certificate, nie
   wolno opublikować `complete=true`.
6. Jeśli GPU telemetry jest tylko self-report, nie wolno zamknąć DOD-13.
7. Jeśli GPU case <=256 używa materialized shifted Schur, nie wolno z niego
   wnioskować skalowalności >1024.
8. Jeśli UI parsuje `unknown` payload lub hardcoduje units, DOD-09 pozostaje
   otwarte.
9. Fixture-backed browser smoke nie kwalifikuje native fields ani WebGL
   lifecycle produkcyjnego runu.
10. FDM FFT nie może być opisane jako FDM eigensolve ani mode visualization.
11. Driven peak nie może być nazwany eigenmode bez modal source reference.
12. Historyczne artifacts nie mogą być kopiowane do nowego bundle jako świeży
    causal evidence.
13. Nie wolno usuwać/killować lock holdera, build cache ani worktree bez
    osobnej autoryzacji i potwierdzenia braku aktywnych użytkowników.
14. Jakakolwiek zmiana runtime-relevant po R1 unieważnia Q1–Q3 i wymaga nowego
    runtime oraz pełnego evidence run. Jedyny wyjątek to allowlistowany G2 po
    final scientific manifest; jego attestation jest obowiązkowa.

## 27. Końcowa definicja gotowości

Moduł można uznać za produkcyjnie domknięty wyłącznie po łącznym spełnieniu:

- aktualny `master` jest przodkiem release candidate;
- recovery content jest scalony bez duplikacji z innych worktree;
- physics-owned bias-field scan zastąpił sterowanie przez Kittel metadata;
- pełne bloki shared-domain, w tym `A_qq`, są natywnym MFEM assembly;
- certificate/ABI boundary jest fail-closed i runtime-compatible;
- CPU ma complete-window, full-residual i K0-P1–P6 evidence;
- GPU ma real persistence, independent telemetry i K0-G1–G4 evidence;
- CPU/GPU przechodzą exact-scope parity, zbieżność i wydajność;
- artifacts-v2, typed OpenAPI, revisions i binary field plane są spójne;
- Results/Analysis/Inspectors pokazują poprawne osie, jednostki, stan i scope;
- selected complex mode działa w jednym viewport 3D we wszystkich wymaganych
  reprezentacjach;
- modalny native browser proof Q3-M przechodzi osobno dla CPU i GPU; driven
  subtree może być nazwany produkcyjnym dopiero po osobnym Q3-D CPU/GPU;
- `frequency_domain_production_dod.v1.json` dla obu scope ma wszystkie
  właściwe items `pass`, wyłącznie jawnie dozwolone `not_applicable` z exact
  reason code, `open_blockers=[]` i poprawną decyzję promocji;
- finalny managed regression/scientific bundle jest niezmienny i hash-bound;
- G2 promotion attestation jawnie wiąże kwalifikowany commit/runtime R1 z
  odrębnym governance-only commitem capability/readiness.

Do tego momentu prawidłowy status pozostaje:

```text
FEM K0 Poisson-airbox CPU: source_visible / unvalidated
FEM K0 Poisson-airbox GPU: source_visible / unvalidated
FDM modal eigensolve: absent / fail-closed
Control Room spectrum/mode UI: source-visible, bez native production proof
Production promotion: blocked
```
