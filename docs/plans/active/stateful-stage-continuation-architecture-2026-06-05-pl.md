# Architektura płynnej kontynuacji etapów

Status: aktywny plan architektoniczny. Faza kontraktu jest czesciowo
zaimplementowana: mamy typowane metadane przejsc, klasyfikator kompatybilnosci,
API stage execution i minimalna widocznosc w Explorerze. Prawdziwa stateful
egzekucja solvera, bez sampled-field injection miedzy kompatybilnymi etapami,
jest nadal kolejnym krokiem.

Data: 2026-06-05

Przegląd: 2026-06-05. Zweryfikowano względem kodu źródłowego. Poprawiono
kolizję nazw `ExecutionPlanIR`, uzupełniono lokalizacje Rust, dodano
odniesienia do istniejących zarodków (`matches_plan`, `ContinuationSource`,
makra pipeline).

## Cel

Etapy `study` maja przechodzic przez siebie plynnie, jezeli nie ma jawnej
granicy stanu. Typowe ciagi:

```text
minimize(method="bb") -> relax(algorithm="llg_overdamped")
hysteresis(field_schedule=...) -> dynamics(...)
relax(...) -> eigenmodes(...) -> frequency_domain(...)
```

nie powinny eksportowac magnetyzacji po kazdym etapie, dopisywac jej jako
`initial_magnetization` nastepnego etapu i uruchamiac kolejnego problemu od
zera. Pipeline powinien kontynuowac prace na tym samym stanie runtime: tej
samej siatce, tych samych buforach solvera, tej samej magnetyzacji, tym samym
punkcie pracy i tej samej topologii obiektow.

To dotyczy wszystkich kompatybilnych etapow, nie tylko pary `minimize -> relax`:

- relaksacja i minimizacja,
- histereza i sweepy parametrow,
- dynamika czasowa,
- eigen/eigenmodes,
- frequency-domain / small-signal response,
- analizy, eksporty i obserwable, jezeli sa read-only wobec stanu.

Dla etapow analitycznych, takich jak eigen albo frequency-domain, "plynne
przejscie" oznacza zachowanie aktualnego punktu pracy jako bazy linearyzacji.
Taki etap moze tylko czytac stan i produkowac artefakty modalne/widmowe, a
nastepny etap nadal widzi ten sam stan bazowy. Jezeli analiza ma zmienic stan,
to musi byc jawnie oznaczona jako etap mutujacy albo jako branch/transfer.

Transfer stanu jest dozwolony tylko jako jawna granica:

- remesh,
- zmiana backendu wymagajaca resamplingu,
- load/checkpoint,
- import/load oraz jawny `export_only` jako granica galezi,
- zmiana geometrii, liczby obiektow, regionow lub mapowania materialow,
- inna operacja, ktora uniewaznia aktualny kontekst solvera.

Zwykly export obserwabli albo snapshot read-only nie przerywa kontynuacji. Jest
artefaktem aktualnego punktu pracy, dopoki uzytkownik nie oznaczy go jako
oddzielnej granicy albo nowego wejscia.

Jezeli taka granica wystepuje, ma byc widoczna w modelu wykonania i w Explorerze.
Jezeli jej nie ma, Explorer powinien pokazac plynne przejscie miedzy etapami.

## Diagnoza obecnego bledu

Obecny blad:

```text
multi-stage flat scripts currently require exactly one magnet; found 4
```

nie jest tylko brakiem obslugi wielu magnesow. To objaw zlego modelu
kontynuacji.

Aktualna sciezka multi-stage robi:

1. uruchomienie etapu jako osobnego `ProblemIR`,
2. odczyt `final_magnetization`,
3. wstrzykniecie tego pola do kolejnego etapu jako `initial_magnetization`,
4. uruchomienie nastepnego etapu jako nowego problemu.

W Pythonie robi to `packages/fullmag-py/src/fullmag/runtime/cli.py` przez
`_apply_continuation_initial_state`. W Rust CLI analogiczna funkcja
`apply_continuation_initial_state` jest w `crates/fullmag-cli/src/step_utils.rs`,
ale wywoływana z trzech kluczowych miejsc:

- `step_utils.rs` — definicja `apply_continuation_initial_state` i
  `resample_continuation_if_cross_backend` (zarodek transferu FEM→FDM),
- `interactive_runtime_host.rs` — `InteractiveRuntimeHost`, właściciel
  `continuation_magnetization` i zarządca przebudowy backendu między etapami
  (główny punkt refaktoru),
- `orchestrator.rs` — wywoływanie kontynuacji w sekwencji headless.

Dodatkowo w `step_utils.rs` istnieje już `ContinuationSource` (`Fdm`/
`Fem(MeshIR)`) i `CrossBackendTransferResult`, które są zarodkami
proponowanego `StateTransferOperator`.

To ma trzy konsekwencje architektoniczne:

- zwykle przejscie etapu udaje transfer stanu,
- wiele magnesow rozbija zalozenie "jeden magnet = jedno pole poczatkowe",
- frontend nie moze uczciwie pokazac, czy stan byl kontynuowany, przeniesiony,
  zremeshowany, czy odtworzony z checkpointu.

Poprawka polegajaca na rozdzieleniu `final_magnetization` na 4 magnesy bylaby
lokalnym obejściem, ale utrwalilaby zly model. Ten sam problem wrocilby przy
histerezie, dynamice, eigen/frequency-domain i kazdym innym wieloetapowym
workflow, w ktorym stan powinien byc dziedziczony, a nie przepakowywany.

## Zasada docelowa

Stan fizyczny jest wlasnoscia aktywnego kontekstu runtime, a nie kolejnego
`ProblemIR`.

`ProblemIR` opisuje problem do materializacji. Po uruchomieniu solvera runtime
ma juz stan:

- siatke albo grid,
- mapowanie wezlow/komorek do regionow magnetycznych,
- materialy,
- aktualna magnetyzacje,
- pomocnicze bufory solvera,
- dane demag/exchange/field cache,
- stan backendu CPU/GPU.

Kolejny etap powinien byc traktowany jako zmiana kontroli wykonania nad tym
samym stanem, o ile jego wymagania sa kompatybilne z aktualnym kontekstem.

`final_magnetization` pozostaje waznym artefaktem:

- do zapisu wynikow,
- do eksportu,
- do checkpointow,
- do jawnego transferu miedzy niekompatybilnymi kontekstami,
- do testow i walidacji.

Nie jest natomiast domyslnym mechanizmem przejscia miedzy kompatybilnymi
etapami.

## Podejscia

### Podejscie A: naprawic obecny transfer sampled field

Opis: rozszerzyc `_apply_continuation_initial_state`, zeby obslugiwal wiele
magnesow przez dzielenie `final_magnetization` wedlug regionow.

Zalety:

- najmniejsza zmiana lokalna,
- szybko usuwa blad `found 4`.

Wady:

- dalej robi ukryty export/import miedzy etapami,
- wymaga idealnego mapowania wezlow na obiekty,
- nie zachowuje buforow solvera i cache,
- nie rozroznia plynnej kontynuacji od transferu,
- bedzie stale pekac przy remeshu, FEM/FDM, wielu domenach i zmianach geometrii.

Ocena: nie rekomendowane jako architektura. Mozna uzyc tylko jako awaryjny
legacy fallback dla jawnego `load_state` albo starego trybu single-stage.

### Podejscie B: jawny graf etapow, ale nadal osobne uruchomienia solvera

Opis: zbudowac `StageTransitionIR`, klasyfikowac krawedzie miedzy etapami i
pokazywac je w UI, ale nadal wykonywac kazdy etap jako osobny `ProblemIR`.

Zalety:

- poprawia widocznosc i diagnostyke,
- pozwala wykryc przypadki, gdzie transfer jest niejawny,
- moze byc etapem migracyjnym.

Wady:

- plynne przejscie nadal nie jest prawdziwie plynne,
- backend nadal traci kontekst solvera,
- solver moze ponownie inicjalizowac dane, ktore powinny zostac w pamieci,
- wielomagnesowe przypadki nadal wymagaja sztucznego przepakowywania stanu.

Ocena: dobre jako przejsciowy kontrakt testowy, ale nie jako cel koncowy.

### Podejscie C: stateful runtime pipeline

Opis: materializacja buduje plan wykonania i pierwszy kontekst runtime. Wszystkie
kompatybilne etapy wykonuje sie przez `continue_in_place` na tym samym
kontekście: minimizacje, relaksacje, histereze, dynamike, eigen, frequency-domain
i analizy read-only. Tylko jawne granice tworza transfer, remesh albo nowy
kontekst.

Zalety:

- odpowiada fizyce i intuicji uzytkownika,
- naturalnie obsluguje wiele magnesow,
- nie powiela materializacji stanu poczatkowego,
- pozwala frontendowi pokazac prawdziwe przejscia,
- daje czysty kontrakt dla FEM, FDM, CPU, GPU i przyszlych checkpointow.

Wady:

- wymaga nowej warstwy `StageRuntimeContext`,
- wymaga klasyfikacji kompatybilnosci etapow,
- wymaga migracji obecnych miejsc uzywajacych `final_magnetization` jako
  domyslnej kontynuacji.

Rekomendacja: podejscie C jako cel, z podejsciem B jako pierwszym etapem
kontrolnym i testowym.

## Model docelowy

### 1. StudyExecutionPlanIR

Materializacja skryptu powinna produkowac jawny plan wykonania:

```text
StudyExecutionPlanIR
  problem_identity
  initial_context_spec
  stages[]
  transitions[]
  artifacts_policy
```

Uwaga: nazwa `StudyExecutionPlanIR` zamiast `ExecutionPlanIR`, bo istniejący
`ExecutionPlanIR` (w `crates/fullmag-ir/src/plan.rs`) to per-stage backend plan
zawierający `common`, `backend_plan`, `output_plan`, `provenance`. Ten typ
pozostaje jako pod-kontrakt w ramach nowej architektury.

`StudyExecutionPlanIR` nie jest drugim solverem. To opis tego, jak runtime ma
przejsc przez etapy.

### 2. StageControlIR

Kazdy etap powinien miec kontrolny opis wykonania, oddzielony od deklaracji
stanu poczatkowego:

```text
StageControlIR
  stage_id
  kind: minimize | relax | hysteresis | dynamic | eigen | frequency_domain |
        analyze | save_state | load_state | export
  state_effect:
        mutates_state | reads_state | branches_state | checkpoints_state |
        imports_state | exports_state
  algorithm
  solver
  stop_criteria
  parameter_schedule
  operating_point_policy
  output_policy
  live_preview_policy
  allowed_state_updates
```

Uwaga implementacyjna: w obecnym codebasie parametry sterowania etapem
(algorytm, solver, stop criteria) sa czescia `StudyIR` wewnatrz `ProblemIR`
(warianty `StudyIR::Relaxation`, `StudyIR::TimeEvolution`,
`StudyIR::Eigenmodes`, `StudyIR::FrequencyResponse`). W Fazie 1
`StageControlIR` powinien byc widokiem/projekcja z istniejacego `StudyIR`,
nie nowym typem zastepujacym `ProblemIR`. Dopiero w Fazie 3 mozna rozwazyc
faktyczna separacje.

Przyklad:

```text
stage 1: minimize(bb, max_steps=1000)
stage 2: relax(llg_overdamped, rk23, max_steps=2000)
stage 3: eigenmodes(linearize_at=current_state)
stage 4: frequency_domain(linearize_at=current_state)
```

Kolejny etap nie powinien zawierac "nowej magnetyzacji poczatkowej", jezeli
kontynuuje stan poprzedniego etapu. Etap mutujacy zmienia stan runtime. Etap
read-only czyta aktualny punkt pracy, produkuje artefakty i zostawia stan bazowy
do dalszej kontynuacji.

### 3. StageTransitionIR

Krawedz miedzy etapami musi byc typowana:

```text
StageTransitionIR
  source_stage_id
  target_stage_id
  kind:
    continue_in_place
    transfer_state
    remesh_transfer
    backend_transfer
    load_state
    save_checkpoint
    export_only
    unsupported
  reason:
    same_runtime_context
    explicit_remesh
    backend_change
    mesh_generation_changed
    object_topology_changed
    material_topology_changed
    checkpoint_load
    user_export
    incompatible_implicit_state
  source_state_identity
  target_state_identity
  source_mesh_generation
  target_mesh_generation
  source_backend
  target_backend
  transfer_operator
  ui_presentation
```

`ui_presentation`:

- `smooth_arrow` dla `continue_in_place`,
- `boundary_bar` dla transferu, remeshu, checkpointu i load/export,
- `error_boundary` dla `unsupported`.

### 4. StageRuntimeContext

Runtime musi posiadac kontekst, ktory przezywa wiele etapow:

```text
StageRuntimeContext
  context_id
  backend_engine
  mesh_identity
  object_topology_identity
  material_identity
  magnetization_state_handle
  solver_cache_handles
  device_residency
  artifact_handles
```

Dla FEM native ten kontekst powinien odpowiadac natywnemu `Context`:

- mesh MFEM,
- regiony magnetyczne,
- material fields,
- magnetyzacja,
- demag data,
- CUDA buffers,
- hypre/libCEED/MFEM device state,
- statystyki i kryteria zakonczenia.

Dla FDM analogicznie:

- grid,
- warstwy,
- magnetyzacja,
- demag convolution state,
- GPU buffers,
- runtime stepping state.

Najwazniejsze: `minimize -> relax` na tej samej siatce FEM to ta sama instancja
kontekstu z nowymi parametrami sterowania, a nie nowy `ProblemIR` z
`sampled_field`.

To samo dotyczy innych etapow, o ile sa kompatybilne:

- histereza zmienia pole/parametr sweepu i kontynuuje z poprzedniego punktu
  krzywej,
- dynamika startuje z aktualnego stanu runtime,
- eigen/eigenmodes linearyzuje wokol aktualnego punktu pracy,
- frequency-domain uzywa aktualnego punktu pracy jako bazy odpowiedzi,
- analiza read-only produkuje artefakty bez resetowania stanu.

## Klasyfikacja przejsc

### Continue in place

Dozwolone, gdy:

- backend runtime zostaje ten sam albo potrafi zachowac ten sam kontekst,
- mesh/grid generation jest ten sam,
- mapowanie wezlow/komorek do regionow magnetycznych jest to samo,
- zestaw obiektow magnetycznych jest ten sam,
- material topology jest ta sama,
- zmieniaja sie tylko parametry sterowania etapem: algorytm, solver,
  stop criteria, autosave, preview, output cadence, schedule pola albo parametru,
- ewentualne zmiany pol/materialow sa jawnie oznaczone jako hot-update i
  backend ma dla nich kontrakt.

Przyklady:

- `minimize(bb) -> relax(llg_overdamped)` na tej samej siatce FEM,
- `relax(max_steps=1000) -> relax(max_torque=...)` bez remeshu,
- `relax(...) -> dynamics(...)` na aktualnym stanie,
- `hysteresis(H_i) -> hysteresis(H_{i+1})` w tej samej galezi sweepu,
- `relax(...) -> eigenmodes(...)` jako analiza punktu pracy,
- `eigenmodes(...) -> frequency_domain(...)` bez zmiany bazy linearyzacji,
- `frequency_domain(...) -> dynamics(...)`, jezeli frequency-domain byl
  read-only i nie zmienil stanu bazowego,
- zmiana czestosci podgladu live,
- zmiana kryterium stopu.

### State effect

Kazdy etap powinien jawnie deklarowac, jaki ma efekt na stan:

- `mutates_state`: etap przesuwa magnetyzacje albo inne zmienne stanu, np.
  minimizacja, relaksacja, dynamika, punkt histerezy po rozwiazaniu.
- `reads_state`: etap tylko czyta aktualny punkt pracy i tworzy artefakty, np.
  eigenmodes, frequency-domain, analiza widmowa, eksport obserwabli.
- `branches_state`: etap tworzy nowa galaz z istniejacego punktu pracy, np.
  oddzielna galaz histerezy, perturbacja modalna uruchamiana jako nowy
  eksperyment, porownawcza sciezka parametrow.
- `checkpoints_state`: etap zapisuje stan bez zmiany aktywnego kontekstu.
- `imports_state`: etap jawnie wczytuje stan i tworzy granice.
- `exports_state`: etap zapisuje artefakt z aktualnego stanu.

`reads_state` nie moze resetowac ani nadpisywac aktywnego punktu pracy. Jezeli
uzytkownik chce, zeby wynik eigen/frequency-domain stal sie nowym stanem
startowym dynamiki, to musi byc jawna operacja: branch, perturbacja albo import
artefaktu.

### Histereza i sweepy

Histereza jest stateful z definicji. Kolejny punkt krzywej powinien startowac z
wyniku poprzedniego punktu tej samej galezi, nie z pierwotnej magnetyzacji ze
skryptu.

Reguly:

- zmiana pola zewnetrznego w ramach schedule jest hot-update, jezeli mesh,
  regiony i material topology zostaja te same,
- punkt `H_i -> H_{i+1}` to `continue_in_place`,
- przejscie z galezi forward do backward jest nadal stateful, jezeli uzytkownik
  chce kontynuowac z punktu nasycenia/odwrocenia,
- jezeli uzytkownik chce porownawcza galaz od starego punktu, to runtime powinien
  utworzyc jawny branch z checkpointu,
- kazdy punkt sweepu powinien miec w stage execution wlasny rekord albo
  podrekord, ale krawedzie miedzy punktami powinny nadal byc typowane.

Uwaga: w `crates/fullmag-cli/src/step_utils.rs` istnieja juz makra pipeline
`hysteresis_loop`, `field_sweep_relax`, `field_sweep_relax_snapshot` i
`parameter_sweep`, ktore materializuja sekwencje etapow z histereza/sweepem.
Te makra sa pierwszym punktem integracji ze stateful kontynuacja.

### Eigen i frequency-domain

Eigen/frequency-domain zwykle nie sa kolejnymi "stanami poczatkowymi", tylko
analizami aktualnego punktu pracy.

Reguly:

- `relax -> eigen` oznacza: linearyzuj wokol aktualnego stanu po relaksacji,
- `eigen -> frequency_domain` oznacza: uzyj tej samej bazy albo artefaktow
  modalnych, bez resetu magnetyzacji,
- `frequency_domain -> dynamics` oznacza: kontynuuj z punktu pracy sprzed
  analizy, chyba ze uzytkownik jawnie zada perturbacji/branchu,
- artefakty eigen/frequency-domain ida do output/artifact registry, nie do
  `initial_magnetization`,
- jezeli analiza wymaga innego operatora, preconditionera albo macierzy, ale nie
  zmienia mesh/topology, to jest nadal `continue_in_place` z read-only operator
  setup.

### Transfer state

Wymagany, gdy:

- uzytkownik jawnie laduje checkpoint,
- etap wymaga innego backendu bez wspolnego kontekstu,
- FEM -> FDM albo FDM -> FEM wymaga resamplingu,
- runtime przechodzi z CPU do GPU w sposob, ktory nie moze zachowac kontekstu,
- stan jest importowany z artefaktu.

Transfer musi miec operator:

```text
identity_copy
device_to_host_checkpoint
host_to_device_restore
fem_to_fdm_grid_resample
fdm_to_fem_mesh_resample
mesh_to_mesh_interpolation
checkpoint_load
sampled_field_import
```

Brak operatora oznacza blad planu, nie ciche przepakowanie przez
`initial_magnetization`.

### Remesh transfer

Wymagany, gdy:

- uzytkownik jawnie zada remesh,
- geometria zmienila mesh generation,
- lokalna adaptacja siatki zmienia indeksy wezlow,
- dodano/usunieto obiekty,
- zmieniono Boolean/CSG/topologie domen.

Remesh transfer powinien zapisac w metadanych:

- stary `mesh_generation_id`,
- nowy `mesh_generation_id`,
- operator interpolacji,
- liczbe wezlow zlokalizowanych,
- liczbe wezlow poza domena,
- blad lub ostrzezenie, jezeli interpolacja nie jest pelna.

### Unsupported

Plan powinien zatrzymac sie przed solverem, gdy:

- przejscie wymaga transferu, ale nie ma jawnego zlecenia albo operatora,
- docelowa siatka nie ma zgodnego region ownership,
- liczba komponentow pola nie zgadza sie z docelowym backendiem,
- stage probuje jednoczesnie zmienic topologie i ukrycie kontynuowac stan.

## Semantyka wielu magnesow

Wielomagnesowy model nie powinien byc specjalnym przypadkiem zwyklej
kontynuacji.

W `continue_in_place` runtime ma jeden stan magnetyzacji osadzony na domenie
obliczeniowej oraz mapowanie regionow. Etapy nie musza rozdzielac tego stanu na
magnesy, bo nic nie jest przepisywane do `initial_magnetization`.

Dopiero przy eksporcie albo jawnym transferze mozna produkowac formaty:

- field over mesh,
- per-object sampled field,
- checkpoint backend-native,
- portable state archive.

Jezeli transfer jest per-object, musi korzystac z region ownership i zapisac,
ktore obiekty zostaly pokryte. Nie moze zakladac `magnets.len() == 1`.

## Przeplyw wykonania

### Obecny przeplyw

```text
script
  -> stage 1 ProblemIR
  -> run solver
  -> final_magnetization
  -> inject as initial_magnetization
  -> stage 2 ProblemIR
  -> run solver
```

To nalezy traktowac jako legacy continuation shim.

Ten shim jest niepoprawny dla calego pipeline'u, nie tylko dla relaksacji:

- w histerezie niszczy semantyke kontynuacji punktow krzywej,
- w dynamice moze odciac historie solvera i stan cache,
- w eigen/frequency-domain myli artefakt analizy z nowym stanem poczatkowym,
- przy wielu magnesach wymusza sztuczne per-magnet przepakowanie.

Uwaga: w codebasie istnieja dwa tryby multi-stage:

1. **Flat sequence** — stare `loaded.stages` z Python CLI, sekwencyjne
   uruchomienie z `_apply_continuation_initial_state`.
2. **Study pipeline** — `StudyPipelineDocument` materializowane przez
   `materialize_study_pipeline` w Rust, z makrami `relax_run`,
   `relax_eigenmodes`, `hysteresis_loop`, `parameter_sweep`,
   `field_sweep_relax`.

Oba tryby wymagaja migracji, ale study pipeline jest blizszy docelowej
architekturze i powinien byc migrowany najpierw.

### Docelowy przeplyw

```text
script
  -> materialize StudyExecutionPlanIR
  -> create StageRuntimeContext for stage 1
  -> execute stage 1 controls
  -> classify transition 1 -> 2
      continue_in_place:
        apply stage 2 controls to same context
      boundary:
        run explicit transfer/remesh/load operator
        create or update context
  -> execute stage 2 controls
  -> execute read-only analyses against current operating point
  -> continue subsequent mutating stages from the same operating point unless
     a branch/transfer was explicit
  -> emit final artifacts
```

Najwazniejsza zmiana: klasyfikacja przejscia jest czescia planu, a nie skutkiem
ubocznym `final_magnetization`.

## API i IR

### Minimalne nowe typy

Rust/shared IR:

```text
StageTransitionKind
  ContinueInPlace
  TransferState
  RemeshTransfer
  BackendTransfer
  LoadState
  SaveCheckpoint
  ExportOnly
  Unsupported

StageTransitionReason
  SameRuntimeContext
  ExplicitRemesh
  BackendChange
  MeshGenerationChanged
  ObjectTopologyChanged
  MaterialTopologyChanged
  CheckpointLoad
  UserExport
  IncompatibleImplicitState

StateTransferOperatorKind
  IdentityCopy
  FemToFdmGridResample
  FdmToFemMeshResample
  MeshToMeshInterpolation
  CheckpointLoad
  SampledFieldImport
```

### Rozszerzenie stage execution

Obecnie `CurrentLiveStageExecutionRecord` i API maja `state_transition:
Option<String>`. To jest za malo, bo string typu `preserved` albo `restored`
nie mowi, czy stage plynnie kontynuowal stan, czy przekroczyl granice.

Docelowe pola:

```text
state_transition_kind
state_transition_reason
state_transition_label
source_state_identity
target_state_identity
source_mesh_generation_id
target_mesh_generation_id
source_backend
target_backend
transfer_operator_kind
transfer_report_ref
ui_presentation
```

Wersja kompatybilna:

- zostawic `state_transition` jako tekstowy fallback,
- dodac nowe pola jako opcjonalne,
- frontend uzywa nowych pol, gdy istnieja.

## Backend runner

### Kontrakt backendu

Kazdy backend powinien miec dwie warstwy:

```text
materialize_context(initial_problem) -> StageRuntimeContext
advance_stage(context, StageControlIR) -> StageResult
```

oraz opcjonalnie:

```text
can_continue_in_place(context, StageControlIR) -> CompatibilityReport
apply_hot_update(context, StageControlIR) -> Result
export_state(context, format) -> StateArtifact
import_state(context_spec, StateArtifact) -> StageRuntimeContext
```

Uwaga: zarodek `can_continue_in_place` juz istnieje w codebasie. Backend trait
`InteractiveBackend` w `crates/fullmag-runner/src/interactive/backend.rs`
ma metody `matches_plan(plan: &ExecutionPlanIR) -> Result<bool>` i
`matches_problem(problem: &ProblemIR) -> Result<bool>`, ktore sprawdzaja, czy
backend jest kompatybilny z danym planem bez przebudowy. Ten kontrakt powinien
byc rozszerzony o klasyfikacje przejsc, a nie zastapiony nowym API.

### FEM native

FEM native powinien byc pierwszym backendiem docelowym, bo tutaj widzimy blad.

Plan:

1. utworzyc kontekst FEM raz po materializacji pierwszego etapu,
2. przechowywac magnetyzacje i cache w natywnym `Context`,
3. przy kompatybilnym kolejnym etapie zmienic tylko relaxation/integrator
   controls,
4. nie kopiowac `final_magnetization` do `ProblemIR`,
5. `final_magnetization` kopiowac tylko na koncu etapu jako artefakt i podglad.

### FDM

FDM powinien dostac ten sam kontrakt, ale moze byc drugim etapem migracji.
Kluczowe jest, zeby FEM -> FDM bylo jawna krawedzia `backend_transfer`, a nie
ukrytym `if previous_fem_mesh_ir is not None`.

## Explorer i UI

Explorer nie powinien zgadywac semantyki na podstawie nazwy etapu. Ma czytac
metadane stage execution.

### Plynne przejscie

Dla `continue_in_place`:

- pokazac stage 1 i stage 2 jako osobne wezly,
- polaczyc je zwykla strzalka,
- podpis: `continues state` albo polski odpowiednik w UI,
- bez bariery i bez ikony importu,
- po hoverze pokazac: same mesh generation, same backend, same object topology.

Przyklad:

```text
[flat_minimize] -> [llg_overdamped_relax]
      continues same FEM state

[relaxed_state] -> [eigenmodes] -> [frequency_response] -> [dynamics]
      same operating point unless a branch/perturbation is explicit

[H_i] -> [H_i+1] -> [H_i+2]
      hysteresis branch continues from previous solved point
```

### Jawna granica

Dla transferu/remeshu/load:

- wstawic miedzy etapami widoczna granice,
- pokazac rodzaj operatora,
- pokazac skad/dokad idzie stan,
- pokazac mesh generation przed/po,
- pokazac ostrzezenia interpolacji.

Przyklad:

```text
[flat_relax] | remesh + interpolate | [refined_relax]
```

albo:

```text
[fem_relax] | FEM -> FDM resample | [fdm_dynamics]
```

### Model danych dla frontendu

`/simulation/stages/execution` powinno pozostac zrodlem prawdy dla runtime
statusu etapow. Explorer moze budowac widok:

```text
StageNode[]
StageTransitionEdge[]
```

z API, zamiast rekonstruowac krawedzie z indeksow.

Minimalny widok:

- `smooth_arrow` dla `continue_in_place`,
- `boundary_bar` dla transferu,
- `error_boundary` dla przejsc nieobslugiwanych.

## Zmiany w Python runtime

Pythonowy `packages/fullmag-py/src/fullmag/runtime/cli.py` powinien przestac
byc miejscem, gdzie zwykle multi-stage robi kontynuacje przez sampled field.

Docelowo:

- Python materializuje plan i przekazuje go do Rust runtime,
- Rust runtime decyduje o `StageTransitionIR`,
- Pythonowy `_apply_continuation_initial_state` zostaje tylko dla legacy
  fallback albo jawnego `load_state`,
- cross-backend transfer nie jest ukrytym branchem w petli etapow, tylko
  nazwanym operatorem transferu.

## Zmiany w Rust CLI/orchestrator

Obecne miejsca uzywajace `continuation_magnetization` powinny zostac objete
jednym kontraktem:

```text
StagePipelineExecutor
  current_context
  stage_records
  transition_records
  artifact_registry
```

Kierunek refaktoru:

1. dodac klasyfikator przejsc bez zmiany solvera,
   status: wykonane jako `StageTransitionMetadata` i klasyfikacja topologii
   runtime,
2. dodac testy pokazujace, ze kompatybilne ciagi `minimize -> relax`,
   `relax -> dynamics`, `hysteresis point -> hysteresis point` oraz
   `relax -> eigen -> frequency_domain` na tym samym mesh daja
   `continue_in_place`,
   status: wykonane dla pipeline i explicit stages, lacznie z
   `frequency_response`,
3. zablokowac niejawny transfer tam, gdzie klasyfikator zwraca boundary,
4. przeniesc aktualne `apply_continuation_initial_state` za jawne operatory
   transferu,
5. dodac prawdziwa sciezke stateful dla FEM.

## Stopniowa migracja

### Faza 1: kontrakt i testy

Cel: najpierw nazwac bledny model i zabezpieczyc oczekiwane zachowanie.

Prace:

- dodac `StageTransitionKind` i `StageTransitionReason`,
- dodac klasyfikator kompatybilnosci etapow,
- dodac testy dla kompatybilnych solver/analyze stage'y, ktore oczekuja
  `continue_in_place`, a nie transferu,
- dodac testy dla `relax -> dynamics`, histerezy i
  `relax -> eigen -> frequency_domain`, ktore oczekuja zachowania punktu pracy,
- dodac test, ze brak jawnej granicy nie moze odpalic
  `apply_continuation_initial_state`,
- dodac test API stage execution z transition metadata.

Stan na 2026-06-05:

- wykonane: typy transition w CLI/API, klasyfikator topologii,
  `run/relax/eigen/frequency_response` jako `continue_in_place`,
  histereza branch-point jako `continue_in_place`, minimalne node'y transition w
  Explorerze,
- wykonane: materializacja primitive `frequency_response` w Rust CLI fallback,
- pozostaje: zablokowanie sampled-field injection dla kompatybilnych przejsc i
  wprowadzenie prawdziwego `StageRuntimeContext`/stateful executor.

Kryterium akceptacji:

- blad `found 4` nie jest naprawiany przez dzielenie pola na magnesy,
- testy pokazuja, ze zwykla kontynuacja nie przechodzi przez
  `initial_magnetization`.

### Faza 2: jawny model w UI

Cel: Explorer pokazuje semantyke przejsc.

Prace:

- rozszerzyc schema API o typowane pola transition,
- zmapowac stare `state_transition` na fallback,
- w Explorerze dodac krawedzie stage transition,
- pokazac `continue_in_place` jako strzalke,
- pokazac transfer/remesh/load jako granice,
- dodac testy modelu drzewa i snapshotow.

Kryterium akceptacji:

- uzytkownik widzi, czy etap kontynuuje stan, czy przekracza granice.

### Faza 3: stateful FEM runtime

Cel: FEM native wykonuje kompatybilne etapy na jednym kontekście: relaksacje,
minimizacje, dynamike, sweepy/histereze oraz analizy read-only.

Prace:

- wprowadzic `StageRuntimeContext` dla FEM,
- oddzielic `StageControlIR` od `ProblemIR`,
- dodac `advance_stage` dla FEM relaxation/dynamics/hysteresis,
- dodac read-only `analyze_stage` dla FEM eigen/frequency-domain,
- zachowac device/host residency,
- zachowac demag/exchange/cache, jezeli kompatybilne,
- emitowac `final_magnetization` jako artefakt, ale nie jako wejscie etapu.

Kryterium akceptacji:

- `minimize(bb) -> relax(llg_overdamped)` z wieloma magnesami dziala bez
  `multi-stage flat scripts currently require exactly one magnet`,
- `relax -> dynamics`, histereza i `relax -> eigen -> frequency_domain` nie
  przechodza przez `initial_magnetization`,
- logi pokazuja `continue_in_place`,
- nie ma ponownego sampling/injection initial magnetization miedzy etapami.

### Faza 4: jawne transfery

Cel: resampling i checkpointy sa pierwszoklasowymi operacjami.

Prace:

- przeniesc FEM -> FDM resampling do `StateTransferOperator`,
- dodac report transferu,
- dodac remesh boundary,
- dodac checkpoint load/save jako granice,
- usunac ukryte fallbacki tam, gdzie moglyby zmienic stan bez metadanych.

Kryterium akceptacji:

- kazdy transfer ma operator, report i widoczna granice w Explorerze.

### Faza 5: porzadki legacy

Cel: stare sampled-field continuation nie jest domyslna sciezka.

Prace:

- ograniczyc `_apply_continuation_initial_state` do jawnych importow,
- oznaczyc stare helpery jako legacy,
- usunac niejawne multi-stage injection po przejsciu testow runtime,
- zaktualizowac dokumentacje DSL/study.

Kryterium akceptacji:

- domyslna semantyka etapow jest stateful,
- sampled field jest formatem danych, nie mechanizmem pipeline.

## Testy wymagane przed uznaniem za gotowe

### Unit / contract

- klasyfikator: same mesh/backend/topology -> `continue_in_place`,
- klasyfikator: explicit remesh -> `remesh_transfer`,
- klasyfikator: FEM -> FDM -> `backend_transfer`,
- klasyfikator: object topology changed -> `unsupported` albo jawny transfer,
- multi-magnet `minimize -> relax` nie wywoluje `apply_continuation_initial_state`,
- `relax -> dynamics` dziedziczy aktywny stan,
- punkt histerezy dziedziczy poprzedni punkt tej samej galezi,
- `eigen/frequency_domain` jest read-only wobec stanu bazowego, chyba ze
  stage jawnie deklaruje branch albo perturbacje.

### Integration

- Python script z 4 magnesami i 2 etapami przechodzi bez bledu `found 4`,
- `permalloy_box_relax_300x1000x10nm.py` po przywroceniu do jednego boxu nadal
  przechodzi jako prosty przypadek,
- FEM GPU `minimize -> relax` zachowuje device residency przy `continue_in_place`,
- FEM GPU `relax -> dynamics` zachowuje device residency przy `continue_in_place`,
- histereza nie resetuje sie do magnetyzacji poczatkowej miedzy punktami sweepu,
- eigen/frequency-domain tworza artefakty analizy bez nadpisywania aktywnego
  stanu bazowego,
- checkpoint/load pokazuje `boundary_bar`,
- FEM -> FDM transfer pokazuje raport interpolacji.

### UI

- Explorer renderuje `smooth_arrow`,
- Explorer renderuje `boundary_bar`,
- Transport log i stage inspector pokazuja transition reason,
- snapshot/test modelu nie zalezy od tekstowego `state_transition`.

### Managed runtime

Finalna walidacja ma isc przez repozytoryjne `just`/kontenerowe przepisy, nie
przez przypadkowy host-only build. Dla tego obszaru dowodem powinien byc
managed FEM runtime.

## Reguly UX dla Explorera

1. Strzalka oznacza: stan jest ten sam, etap zmienia tylko sterowanie.
2. Bariera oznacza: stan przekroczyl jawny operator transferu albo remesh.
3. Brak metadanych transition nie moze byc interpretowany jako transfer.
4. UI nie moze zgadywac transition po nazwach etapow.
5. Przy boundary uzytkownik musi zobaczyc przyczyne i operator.
6. Przy remesh uzytkownik musi zobaczyc stara i nowa generacje siatki.
7. Przy interpolacji uzytkownik musi zobaczyc komplet raportu lokalizacji.

## Decyzje architektoniczne

- Zwykle multi-stage to stateful continuation dla wszystkich kompatybilnych
  etapow: relaksacji, minimizacji, histerezy, dynamiki, eigen/frequency-domain i
  analiz read-only.
- `final_magnetization` jest artefaktem, nie domyslnym transportem stanu.
- Transfer jest jawna krawedzia planu.
- Remesh jest jawna granica.
- Wielomagnesowy przypadek ma dzialac naturalnie przez stan domenowy, nie przez
  per-magnet injection.
- Explorer pokazuje krawedzie, a nie tylko liste etapow.
- `/simulation/stages/execution` pozostaje runtime source of truth.
- FEM native jest pierwszym backendiem do stateful wykonania.
- FDM dostaje ten sam model po FEM albo rownolegle, ale bez ukrywania transferow.

## Najblizszy praktyczny krok

Pierwsza implementacyjna zmiana nie powinna dotykac solvera. Powinna dodac
kontrakt i testy:

1. `StageTransitionKind`,
2. klasyfikator kompatybilnosci,
3. test, ze multi-stage multi-magnet `minimize -> relax` klasyfikuje sie jako
   `continue_in_place`,
4. test, ze `relax -> dynamics`, histereza i `relax -> eigen -> frequency_domain`
   tez klasyfikuja sie jako plynna kontynuacja, gdy mesh/backend/topology sa
   zgodne,
5. test, ze stara sciezka sampled-field injection nie jest dozwolona dla
   kompatybilnej kontynuacji,
6. opcjonalne pola API dla transition metadata.

Dopiero po tym warto przenosic wykonanie FEM na prawdziwy `StageRuntimeContext`.

## Kryterium koncowe programu

Uzytkownik uruchamia skrypt z wieloma magnesami:

```text
stage 1: minimize
stage 2: relax
stage 3: dynamics
stage 4: hysteresis
stage 5: eigen
stage 6: frequency_domain
```

Jezeli geometria, mesh i backend sa kompatybilne:

- runtime tworzy jeden kontekst,
- etapy przechodza plynnie,
- etapy read-only analizuja aktualny punkt pracy bez resetu,
- sweepy/histereza dziedzicza stan poprzedniego punktu,
- Explorer pokazuje strzalki,
- nie ma sampled-field injection,
- `final_magnetization` jest zapisem wynikowym.

Jezeli uzytkownik zada remesh albo backend transfer:

- runtime pokazuje jawna granice,
- wykonuje nazwany operator transferu,
- zapisuje raport,
- Explorer pokazuje boundary,
- dalszy etap startuje z nowego, jawnie utworzonego kontekstu.
