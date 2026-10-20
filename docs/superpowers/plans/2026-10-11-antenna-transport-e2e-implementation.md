# Anteny i transport — realizacja E0–E12, 11.10.2026

## Zakres i stan

Zadanie obejmuje cały zakres E0–E12 z polecenia użytkownika. Ten dokument jest
wewnętrznym rejestrem implementacji i bramek, nie publikacją naukową ani dowodem
kwalifikacji backendów. R1 pumping, R2 termika i R3 termoelektryka/pełne RF mają
oddzielny, niezatwierdzony zakres; nie blokują E0–E12 i nie są implementowane.

Statusy pozostają rozdzielone: brak implementacji; kod poza publicznym przepływem;
fixture; rzeczywisty runtime; kwalifikacja naukowa określonej lane i zakresu;
kwalifikacja end-to-end UI. Brak testu nie oznacza braku kodu. Zielony build nie
oznacza kwalifikacji fizyki ani UI.

## Zamrożone wejścia

- Worktree zadania: `D:/git/fullmag/worktrees/antenna-transport-e2e-20261011`.
- Branch: `codex/antenna-transport-e2e-20261011`.
- Owner: `codex-01a12a56-002e-7660-8424-c7e07fb0907a`.
- Po dwóch jawnie zleconych `git fetch origin`, baza `origin/master`:
  `2a3c6becb9c7e111ae1497ec0cd9ac9576acba95`.
- Referencyjna gałąź anten:
  `be8376c21db8b633e4c2a4bd4f33b381c074578d`.
- Master jest przodkiem gałęzi anten; 273 commity ponad bazą, 0 commitów mastera
  brakujących w antenach. Nowy branch utworzono z mastera i przesunięto fast-forward
  do anten; nie wybierano pojedynczego commita bez zależności.
- Publikacja owned J:
  `62d9618b2eebec639e52eeea842ffde19525a4bd`.
- Audyt BORIS:
  `6fbe4a6403d01ef3545bb5ac1500fb0559af6be4`.
- BORIS audytu: `048503d2ca6475e91b073eb1762ecf9d3634c3e1`; nowszych wersji nie
  utożsamia się z tym snapshotem.
- Użytkownik jawnie zatwierdził kopię także niezacommitowanych zmian. Capture
  zawiera 16 plików; lista, rozmiary i SHA256 znajdują się w
  `storage/runs/antenna-transport-e2e-20261011-5e7f0d529ca256ef/e0/input-capture.json`.
  Hash każdego źródła i kopii sprawdzono, status oryginału podczas capture nie
  zmienił się. Oryginału nie stage'owano, nie commitowano ani nie nadpisywano.
- Resolver wyznaczył `D:/git/fullmag/storage`; odziedziczony legacy
  `CARGO_TARGET_DIR` usuwany jest tylko z procesu zadania. Konfiguracja hosta
  pozostaje nietknięta. Rejestr nowego ownera ma bazę mastera.
- Nie zmieniono sceny użytkownika ani localhost:3197.

## Właściciele i rzeczywiste przepływy E0

| Przepływ | Właściciel i symbole | Ustalony kontrakt i luka |
|---|---|---|
| Python/UI → authoring → IR | `packages/fullmag-py/src/fullmag/model/antenna.py::AntennaFieldSolveStage.to_ir`, `AntennaPortMode.to_ir`, `AntennaTargetProjection.to_ir`, `SolvedAntennaDrive.to_ir`; `current_transport.py::CurrentTransport`; `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts`; `crates/fullmag-ir` | Istnieje jeden model port/stage/projection/drive, kreatory dodają current transport. Kompletne zasilanie i wybór powierzchni wymagają weryfikacji; nie aktywować fizyki nazwą ani typem. |
| Planner → mesh → transport | `crates/fullmag-plan/src/antenna_field_solve.rs::plan_antenna_field_solve_execution`, `resolve_field_sampling`; `antenna_current_source.rs::materialize_antenna_external_lead_current_input`; `crates/fullmag-runner/src/native_fem/charge_transport.rs::execute_native_fem_charge_transport` | Global wymaga FEM domain asset, Object independent asset, Region jawnie odrzucany; executable sampling wymaga Tet4 P1. Standardowa ścieżka wykonuje charge solve oraz oddzielny RT0/Oersted solve. |
| Accepted current → H → publikacja | `antenna_external_lead_solution/execution.rs::execute_antenna_external_lead_inspection`; native `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_external_lead_source.cpp::solve_accepted_external_lead_display_bundle`; `antenna_external_lead_solution/publication.rs::publish_antenna_external_lead_solution_atomically` | Osobny owned bundle publikuje V/RT0/J/H z jednego źródła. Nie wolno promować truncated inspection do reusable basis. Standardowy tor pozostaje odrębnym problemem E3. |
| Archiwum → API → hooks → Inspector → renderer | `antenna_external_lead_solution/publication.rs::load_published_antenna_external_lead_solution`; `crates/fullmag-api/src/router_v2/handlers/data/antenna_inspection.rs::get_antenna_external_lead_inspection`, `get_antenna_external_lead_inspection_display`, `get_antenna_external_lead_inspection_payload`; `apps/control-room/src/kernel/resources/antennaResources.ts`; `AntennaVisualizationPanel.tsx`; `AntennaFieldLayer.tsx` | Kod obsługuje v1 bez J i v2 z J, binary payload oraz current cell-local traces. Nowa sesja, cold-load i rzeczywisty UI nadal wymagają osobnych dowodów. Nie wystarcza fixture. |
| Basis → projection → waveform → LLG | `crates/fullmag-runner/src/antenna_field_solution.rs::load_solved_antenna_drive_basis_projected`, `materialize_fem_solved_antenna_drives`, `materialize_fdm_solved_antenna_drives`; `crates/fullmag-plan/src/antenna_projection.rs::resolve_fem_antenna_projection_mask` | Loaders i projekcje istnieją. Własność normalizacji, pełne cache dependencies, wszystkie RHS integratory, rollback/checkpoint i activation wymagają audytu/wykonania. |
| Source FFT oraz odpowiedź | `crates/fullmag-runner/src/antenna_spectrum.rs::compute_antenna_source_spectrum_artifact`, `compute_structured_antenna_source_spectrum`, `compute_nonuniform_k_antenna_source_spectrum`; `spin_wave_response.rs::append_requested_spin_wave_artifacts`, `build_gamma_response`; `spin_wave_sampling.rs` | Istnieją FFT i interpolacja Tet4; publiczny transverse/equilibrium loader jest niezrealizowaną bramką, nie wolno zastępować m0 osią z. Obecność Gamma nie dowodzi pełnej odpowiedzi m(k,ω). |

## Potwierdzone różnice i zachowane odmowy

1. Wersjonowane J i frontendowy overlay istnieją już w zatwierdzonej historii.
   Skopiowany WIP dodaje rozpoznawanie v2 do niezależnych skryptów export/HTTP;
   nie jest drugim API ani solverem.
2. Owned external-lead inspection istnieje równolegle do standardowej ścieżki;
   nie usuwa jeszcze mieszania jej dwóch rozwiązań.
3. Region sampling pozostaje jawnie odrzucony; dowód na probe magnetycznym nie
   zamyka niemagnetycznego scenariusza E4B.
4. Routing inspektorów już istnieje w `inspectorRouteCatalog.tsx`. Geometry,
   Conductor, Port, Solution, Projection, Drive, Spectrum i Visualization mają
   osobne selection kinds. `AntennaCompositionPanels.tsx::AntennaCompositionPanel`
   nadal pokazuje read-only Port/Projection i composer tworzenia przy Solution;
   osobnego edytora istniejącej Projection/Spectrum w tym właścicielu nie ma.
   Terminals oraz Results/diagnostics wymagają dedykowanych semantic nodes/views.
5. Na bazie BORIS `_concat_qia` transponował indeksy; także
   `verify_boris_nf_interface.py::compute_interface_slice` wybierał błędny wiersz.
   Poprawkę zapisano w `a2dfef79c31a9c4716da8888c44edceababad64f`.
   Niezależne wejście OVF musi przejść publiczny normalizer, nie tylko tensor
   przygotowany przez ten sam adapter. Historycznych porównań nie promować.
6. `reject_unqualified_external_lead_source` oraz odmowy projection/FFT w
   plannerze pozostają obowiązujące. Bilans terminali nie kwalifikuje brakującego
   obwodu. Zmiana UI lub tolerancji nie może tej bramki obchodzić.

## Rejestr etapów i kryteria odbioru

Każdy wiersz obejmuje scenariusz, stan początkowy, plan zmiany, kontrakt,
zależność oraz dowód odbioru. Pliki i symbole właścicieli podano w mapie powyżej;
dokładne nowe symbole i commands/exit codes dopisuje checkpoint danego etapu.

| Etap | Stan i plan | Kontrakt, zależności, walidacja i kryterium |
|---|---|---|
| E0 | Zamrożona baza i kopia WIP; mapowanie trwa | Pełne SHA, owner i source pins; żadnego równoległego modelu/klienta. Odbiór po potwierdzeniu sześciu przepływów i spin lanes; source reading nie kwalifikuje runtime. |
| E1 | Mapowanie adaptera naprawione i sprawdzone na raw OVF; nowy benchmark solverów otwarty | Q_ia row-major: i flow, a spin; wersjonowane units; raw OVF z 9 różnymi składowymi, wieloma punktami N/F, signs; RED→GREEN przed nowym benchmarkiem pinned źródeł/binariów. E0. |
| E2 | Istnieją kontrakty external leads i draft creators; workflow niekompletny | Geometria signal/feed/return oddzielona od terminal BC i port weights; stable surface IDs, closure/gauge/component rejection przed solve; UI→Python→UI bez JSON. E0 + nota naukowa. |
| E3 | Owned inspection istnieje; standardowy charge/RT0 split otwarty | Jeden accepted owner V/J/H/raw currents/normalization/certificate, SI, atomowa publikacja, getters bez mutacji; regresja dwóch stanów i próg błędu ustalony przed wynikami. E2. |
| E4 | Tet4 sampling istnieje; Region brak, nonmagnetic public execution niezweryfikowane | V conductor, J local cells, H sampling, target projection osobno; jawne outside status i invalidation; oba A/B przez prawdziwy field-only bez m/Ms/Aex. E3. |
| E5 | v2 metadata/binary i disk loader istnieją, cold archive HTTP niezweryfikowane | V[V], J[A/m²], H[A/m], basis[1/m]; session/epoch/stage/source/carrier/revision/digest; legacy bez J; mismatch/corruption/stale/session switch odmowa; native→archive→cold HTTP. E3–E4. |
| E6 | Dedykowane routes częściowo read-only; edit/rebind/remove brak dowodów | Właściciel canonical zasobu, Apply/Reset/history, field transaction pending, revision conflict, explicit dependent removal policy; każdy node własny view; focus/scroll/root stability Object/Airbox. E2–E5. |
| E7 | Wspólny szablon i antenna overlay istnieją; real browser otwarty | Scalar V bez vectors, RT0 interpolation vector before norm bez nodal averaging, units/carrier/raw-perA-scaled legenda; canvas/context/drawing buffer, camera, bounded requests/payload/idle. E5–E6. |
| E8 | Loaders/projections/waveforms istnieją; kwalifikacja niezamknięta | Fixed linear source basis z accepted signed Iref, operator dependencies, waveform nie invaliduje basis; RHS substeps/retry/origin/checkpoint, DC Relax, requested/resolved device; 0/sign/2x/superposition i brak solve w LLG. E3–E5 kwalifikowane. |
| E9 | Structured/nonuniform FFT istnieją, transverse public loader brak | Fizyczny resampling, exponent/origin/window/Nyquist/units, transfer budget, amplitude/phase/Re/Im/squared spectrum; osobny Run monitoring m(k,ω); modal refusal bez qualified basis. E8; known harmonic i independent normalization + real source/response. |
| E10 | Spin contracts i 9-channel codec istnieją, tensor/UI formularze otwarte | canonical IDs, rank/layout, 9 components, Q_dot_a flow vector, Frobenius norm, 3×3 table, surface flux tylko carrier+normal; bez implicit XYZ; Python/UI round-trip. E0–E1 + catalog/API. |
| E11 | Lane implementations istnieją z oddzielnymi ograniczeniami | FDM CPU M1/M2/M3 combinations, GPU steady M1 scope, FEM CPU M1/M2; forced GPU bez fallback; charge/spin/SHE/iSHE/torque/balance i LLG checkpoint evidence; supported/unsupported/unqualified matrix. E1+E10. |
| E12 | Nie rozpoczęto odbioru całego zakresu | Własne sesje: nonmagnetic field-only/cold-load; microstrip qualified basis/DC Relax/AC Run; source FFT/response; N/F tensor/torque; round-trip/invalidation/refusals/Object/Airbox. Analytic + independent refinements transport/field/projection, far/near/inside osobno; commands/exit codes/SHA/screenshots i raport PL. Wszystkie wymagane wcześniejsze etapy. |

## Dowody i bramki operacyjne

- Runner odczytany 11.10.2026: `accepting_jobs=true`, `worker_alive=true`,
  `worker_error=null`, aktywna kolejka pusta. Sam stan Docker nie jest dowodem.
- Istniejący job `1128d9f468ee4b0981387a8cdf448451`: `succeeded`, exit 0,
  FEM CPU release, źródła `62d9618b2eebec639e52eeea842ffde19525a4bd`.
  Jest pakietem wcześniejszego checkoutu, nie dowodem obecnego HEAD/WIP.
- Zakaz kompilacji testów jednostkowych nadal obowiązuje. Interpretowane Python
  checks są odrębne; Rust/C++/TS unit build nie został uruchomiony.
- Skopiowany WIP: pierwsze wykonanie miało 134 PASS, 1 FAIL, 34 errors oraz
  49 subtests PASS; isolated DSL nie mógł zaimportować numpy. Log zachowany;
  uzupełniono wymagane zależności w środowisku zadania. Odbiór po ponowieniu.
- Native FEM build/run tylko właściwe container-backed `just`, jeden runner.
  Browser będzie używać własnego portu i sesji. localhost:3197 pozostaje chroniony.
- Końcowe interpretowane regresje kopii WIP i adaptera: 186 testów oraz
  49 subtests PASS, exit 0; receipt `e0/regressions-final.json` i pełny log.
  Brakująca zależność numpy była przyczyną wcześniejszego niepowodzenia.
- Adapter E1: RED exit 1 (48 błędnych komponentów pozadiagonalnych i błędne
  strumienie), GREEN exit 0, 72/72 komponentów w 8 punktach N/F, normalna ±z,
  kolejność punktów, dokładny historyczny współczynnik jednostek, odmowa torque.
  Raporty `e1/red/report.json` i `e1/green/report.json` kwalifikują tylko adapter.
- Noty 0950 i 0970: focused source-map validators exit 0. Testy kontraktu
  dokumentacji: 33 PASS, exit 0. Poprawiono dwa nieaktualne źródła stage actions.
- Następny krok: E2 authoring istniejącego obwodu i E3 jeden accepted owner;
  przygotowanie bieżącego source-pinned runtime. Cel E0–E12 pozostaje aktywny.

## Checkpoint po E0 i fragmencie E1

- Adapter commit: `a2dfef79c31a9c4716da8888c44edceababad64f`; 186 Python PASS,
  49 subtests PASS, raw OVF RED/GREEN; nowy benchmark solverów pozostaje otwarty.
- Kopia skryptów kwalifikacyjnych i HTTP: `258e2ff5348b4d18d31bf6e30aead72e55a6f554`.
  Review 16 plików znalazł rozbieżność statusów pass/passed; poprawiono ją oraz
  dodano test z rzeczywistym frozen smoke. 23 lifecycle checks PASS, exit 0.
  To bramka transportowa, jeszcze nie dowód rzeczywistego HTTP ani cold-load.
- E2: kreator legacy BC wskazuje nieistniejące rt0 ref. Import/export oraz
  materializacja ExternalLeadPreparation już istnieją. Jedyny kind straight
  stubs kończy się external_electrode_truncation. Readiness musi rozróżnić
  inspection i qualified basis; nie wyprowadzać outer actuator z wag portu.
- E3: drugi RT0 solve sam wybiera closure voltage. ABI ma wspólny V/RT0/H digest,
  lecz standardowy publisher używa pierwszego V/nodal J i jego prądów. Samo
  zastąpienie V nie naprawi normalizacji ani cell-local J. Owned inspection v2
  jest właściwym wzorcem; basis v1 wymaga nowego jawnego nośnika J.
- E10: canonical katalog ma TensorField/9/A/m², export_only. API c0…c8 oraz
  Frobenius istnieją; buffer i renderer klasyfikują nComp≥3 jako vector,
  planar API nie ma cN. Tabela debug ma limit 8. Najpierw explicit rank/layout
  descriptor, następnie konsumenci i browser proof, dopiero potem preview gate.
- Użytkownik wybrał pełny obwód 3D. Do uzgodnienia przekazano pętlę microstrip:
  zachowany signal i szeroka return plate, połączenia na obu końcach, idealny
  skok potencjału na wejściowym przekroju przy ciągłym prądzie. Nie zmieniono
  sceny ani nie przyjęto wymiarów/położenia źródła bez uzgodnienia.

## Oddzielne proponowane rozszerzenia R1–R3

R1 (niezatwierdzony): osobny jawny model interfejsu pumping, normalna i complex
mixing conductance; dm/dt tego samego trial stage, reciprocal torque, brak
podwójnego damping, rollback/checkpoint. Bramki static m→0, precesja, odwrócenie
normalnej i bilans momentu; Python/IR/capability/UI bez aktywacji samym g_r.

R2 (niezatwierdzony): najpierw diagnostyka zaakceptowanego E/J oraz wyprowadzona
pełna dyssypacja M2; potem osobny heat equation model z materiałami, IC/BC oraz
interfejsami; dopiero następnie sigma(T) i jawna polityka sprzężenia. Brown noise
nie zastępuje temperatury. Wymaga osobnych niezależnych przypadków energetycznych.

R3 (niezatwierdzony): Seebeck/Peltier/Thomson oraz pełny Maxwell RF ze skin,
proximity i S-parametrami mają odrębne kontrakty, solver realizacje i kwalifikację.
Nie wynikają ze stałej quasistatycznej bazy anteny ani z obecności kodu BORIS.
