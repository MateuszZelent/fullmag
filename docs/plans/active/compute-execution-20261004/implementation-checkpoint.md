# Checkpoint implementacji Compute execution

Zlecenie: cały zakres E0–E7, bez redukcji celu. Aktualizacja: 2026-10-05.
Checkout: `C:/git/fullmag/fullmag`, branch `master`, zgodnie z jawnym
poleceniem użytkownika; bez nowego worktree. Baza pierwszego etapu:
`e012c8c46c6d5c62fcd2fde45009b1a59eaf971b`.
HEAD podczas weryfikacji fragmentu profili:
`e9f29dda537ca9866fbbcedcbb2b9da97552b19b` (niezależny commit dokumentacji
restartu workspace). Bieżące zmiany compute pozostają lokalne; dowody używają
digestu dirty źródeł z receipt, a nie samego HEAD.

Owner: `codex:01a10878-2ffd-7f21-b54a-35d981ba50ea`.
Osobny rekord: `<FULLMAG_PROJECT_STORAGE_ROOT>/index/tasks/compute-execution-20261004.json`.
Wspólny index checkoutu należy do innej aktywnej pracy i nie został nadpisany.
Nie stage'owano ani nie commitowano cudzych plików. Istniejąca lokalna zmiana
odczytowego Compute environment pozostaje zachowana.

## Etapy

| Etap | Stan | Pozostała bramka |
|---|---|---|
| E0 | Potwierdzono bazę, reuse schedulera, wersje RunSpec v1/v2 i StudyPlan v1/v2; ADR 0052 przyjęty zleceniem | Śledzenie kolejnych migracji i tożsamości źródeł |
| E1 | W toku: typowane ComputeResources Python/IR, konsumenci CPU i walidacja wszystkich kroków; Python i kontrola kompilacji źródeł PASS | Profile materializer/origins, CLI/env import, UI round-trip, runtime |
| E2 | Oczekuje | Topologia, polityka, wspólny ledger, cap usługi, recovery |
| E3 | Oczekuje | CPU/native pools/affinity, GPU binding, OS enforcement, receipts |
| E4 | Oczekuje | Typed API/facade/resources, Settings/Study/rail/Jobs i browser proof |
| E5 | Oczekuje | Batch expansion, concurrency, dependencies, OutputStorage i wyniki |
| E6 | Oczekuje | Remote providers, CAS transfers, cluster allocation i reconnect |
| E7 | Oczekuje | Noty numeryczne, partition/collectives, wykonanie i kwalifikacja distributed solve |

## Pierwszy fragment E1

- `crates/fullmag-ir/src/compute_resources.rs`: wersjonowane requested
  resources, jawne Auto, CPU/NUMA/pule, selektor UUID, pamięć, target i ranki;
  walidacja requestu oddzielona od dostępności wykonania.
- `ProblemIR::validate`: odczyt typed metadata i odrzucenie sprzeczności
  z dotychczasowym runtime_selection.
- `fullmag-plan::plan`: przejściowa jawna odmowa wymagań, których obecny
  worker jeszcze nie egzekwuje. Te bramki zostaną zastąpione dowodami admission
  i capability w E2/E3/E7; nie są docelowym ograniczeniem zakresu projektu.
- Runner czyta typed CPU threads przed legacy selection; explicit Auto nie
  jest nadpisywane przez odziedziczony numeric FULLMAG_CPU_THREADS.
- Python eksportuje `ComputeResources`, `CpuResources`, `GpuResources`,
  `MemoryReservation`, `ComputeTarget` i `DistributedResources` oraz
  `StudyBuilder.resources()`. Walidacja obejmuje kolejność wywołań
  `.device()`/`.threads()` i późniejsze mutacje płaskiego DSL.
- `RequestedExecution::validate_problem_resources` porównuje minimum
  admission z jawnymi zasobami kroku; nowy request wymaga budżetu v2.
- `validate_requested_execution` sprawdza backend/device/precision/mode
  każdego zaplanowanego kroku na podstawie immutable ProblemIR. Nie odpytuje
  hosta. Typed resolved-device provenance istnieje tylko dla FEM Eigen;
  ogólne potwierdzenie rzeczywistego urządzenia pozostaje E3.

Zakres jest polityką wykonania zgodną z notą
[0532](../../../physics/0532-fem-demag-solver-policy-and-runtime-threading.md),
bez zmiany równań ani deklaracji parytetu. Advanced resource requests muszą
być odrzucane przed wykonaniem, dopóki nie istnieje obsługa przydziału;
nie wolno ich przyjmować i ignorować.

## Dowody i następne kroki

Kompilacja testów jednostkowych pozostaje zabroniona. Źródła regresji Rust
powstają, ale nie są kompilowane ani uruchamiane. Kontrole źródeł/Python
oraz managed source check bez unit tests mają osobne wyniki; żaden
nie zastępuje runtime/browser/nauki.

- Python: **PASS**, 33 przypadki, exit 0, 1,70 s. Uruchomienie przez
  `python -B -m pytest -q -p no:cacheprovider tests/test_compute_resources.py`,
  jawne `PYTHONPATH`, `--basetemp` i JUnit pod kanonicznym storage. Hashy źródeł
  przed/po nie zmieniono. Receipt:
  `<FULLMAG_PROJECT_STORAGE_ROOT>/runs/fullmag-0950f4dca4ffe38f/compute-execution-20261004/e1-python-215e4b0d5b2741a18f0d089eb277afe7/receipt.json`.
- `just check-api-source`: **PASS**, exit 0, receipt `state=passed`,
  `source_changed_during_run=false`. Polecenie wykonawcze:
  `cargo check --locked -p fullmag-api --bin fullmag-api`; nie buduje testów.
  Digest źródeł: `14e4edb59c1b6a02a6b4395a33a8ee063b4d894424df6094b6b522766673419c`.
  Receipt:
  `<FULLMAG_PROJECT_STORAGE_ROOT>/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/392c644969744fa9950043dbd362741e/receipt.json`.
  Kompilator zgłasza istniejące ostrzeżenia; wynik nie jest kwalifikacją
  FEM/native/GPU ani uruchomieniem źródeł regresji Rust.
- Przegląd zmian delegowanych, `rustfmt` dla nowych modułów i scoped
  `git diff --check`: **PASS**. Nie zmieniano ani nie restartowano działającego
  runtime. Dowody wcześniejszego odczytowego UI są opisane osobno w
  [Compute environment](../../../design/start-screen/docs/09-compute-environment.md).

Następny krok: materializacja wersji profilu z pochodzeniem każdego pola,
następnie CLI/env import i trwałe zasoby hosta. Cel pozostaje aktywny
aż do pełnego audytu E0–E7.

Granice następnego fragmentu: patch profilu musi odróżniać brak pola od
jawnego `auto`; pełny `ComputeResourcesIR` ma już wartości domyślne i sam nie
przechowuje tej informacji. Walidacja minimalnego budżetu nie jest dowodem
ograniczenia rzeczywistych wątków do lease. Szczególnie CPU `auto` wymaga
resolution przy admission i binding w workerze E2/E3 przed zwiększeniem
współbieżności. Nie należy wyprowadzać przydziału z samej telemetrii.

## Drugi fragment E1 — profile i pochodzenie pól

W toku, bez deklaracji ukończenia E1:

- Oddzielne sparse patche zachowują absent / explicit Auto / nullable reset.
  Python udostępnia pięć typowanych konstruktorów profilu i override'ów.
- Kontrakt profilu `execution_profile.v1` oraz snapshotu
  `execution_request.v1` ma właściciela danych w IR; czysty resolver i replay
  należą do application, bez odpytywania hosta.
- Katalog `study_problem_catalog.v2` przypina treść i hash profilu. Katalog
  weryfikuje referencję kroku oraz zgodność efektywnego requestu z ProblemIR.
  Stare v1 zachowują format bez fabrykowania originów.
- Binding kopiuje ProblemIR. API waliduje materializację wszystkich wpisów
  oraz zgodność RunSpec przed pierwszą publikacją CAS/intent; runtime-control
  ponawia kontrolę przy odczycie immutable snapshotu.
- Dopisane źródła regresji Rust obejmują round-trip v1, brak profilu w v2,
  zmianę requestu/originów/hashu/wersji i odmowę Submit przed publikacją.
  Zakaz kompilowania testów jednostkowych pozostaje w mocy.

Python po poprawce zgodności Unicode: **PASS**, 58 przypadków, exit 0,
1,73 s; hashe testowanych źródeł przed/po zgodne. Receipt:
`<FULLMAG_PROJECT_STORAGE_ROOT>/runs/fullmag-0950f4dca4ffe38f/compute-execution-20261004/e1-profiles-python-b8681b056be146c4a89c9de7b8c095d6/receipt.json`.
Wspólny fixture `execution_profile.v1.json` ma canonical SHA-256
`f1382ed093185748f7e1099588f60b4dba15974e65c84eeba1343e88542a663a`.

Kontrola źródeł Rust dla tego fragmentu: **PASS**. `just check-api-source`
zakończył się exit 0, `state=passed`, `source_changed_during_run=false`.
Digest: `8f1bfbded46d1109c5317d7c393df626c02aa4be5afaf175a1847edf9e1e973e`.
Receipt:
`<FULLMAG_PROJECT_STORAGE_ROOT>/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/97396e4caa854cfb9475fa63c89098de/receipt.json`.
Nie kompilowano ani nie wykonywano testów Rust.

`just generate-api-openapi`: **PASS**, exit 0, `state=passed`,
`source_changed_during_run=false`. Receipt:
`<FULLMAG_PROJECT_STORAGE_ROOT>/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-openapi-codegen/ab5191a1b3a946db976c12d42bcd47a4/receipt.json`.
`pnpm run generate:api-v2-types` i `pnpm run generate:api-v2-client`: **PASS**.
Diff OpenAPI/types zawiera tylko opis katalogu v1/v2; wygenerowany klient
nie zmienił metod. Pierwszy odczyt zależności pnpm z sandboxa zwrócił EPERM;
autoryzowane powtórzenie z dostępem do zainstalowanych zależności zakończyło się
exit 0. Nie instalowano nowych zależności.
Brakuje jeszcze providera trwałego katalogu profili: hash snapshotu chroni
przyjęty run, lecz sam nie zabrania opublikowania innej treści pod tym samym
id/version w przyszłym katalogu Settings. Ta bramka, lane/failure policy,
UI/DSL/CLI/env oraz preview muszą zostać domknięte w dalszej pracy E1/E4.

Kolejna istotna integracja: scheduler i `accepted_study_worker` nadal używają
globalnego `RunSpec.requested_execution`, a worker odmawia globalnego Auto
i obsługuje ograniczony zestaw lane'ów. Snapshot profilu nie otwiera nowych
lane'ów. Przed uznaniem E1/E3 za gotowe trzeba wyprowadzać żądanie taska
z jego materializacji oraz odróżnić run summary od jawnych ograniczeń Submit;
aktualny globalny wybór precision/mode nie reprezentuje mieszanych kroków.
Punkty następnej zmiany: `TaskRecord::resolve_input_with_fingerprint`
w `fullmag-application/src/execution.rs`, kontrola zgodności resolved input
w `fullmag-runtime-control/src/study.rs`, wybór ofert w `scheduler.rs`
i adaptery `accepted_study_worker`/`accepted_fem_study_worker`.
Trzeba zachować fingerprint RunSpec i jawnie wersjonować semantykę
`ResolvedTaskInput`, zamiast zmieniać znaczenie istniejącego pola po cichu.

## Synchronizacja mastera — 2026-10-05

Na jawne polecenie użytkownika pobrano origin i scalono
`b317562fbc6803a3e51ed16b2448d23da3d89d53` z lokalnym masterem.
Commit scalający: `39427c8683911f69b4f77790468543642a5158ae`.
Lokalne niezacommitowane zmiany przywrócono po scaleniu; kopia pozostaje
w stashu `9e2905b9895c60751f68a457784ddb94926f3512`.
Rozwiązano konflikty `StartScreen.tsx` i `ProjectInspector.tsx`, zachowując
obsługę skryptów z remote oraz lokalne Compute/About. Uzupełniono brakujący
import typu `RecentIndexState` w inspectorze.

Weryfikacja: brak unmerged entries i markerów konfliktów, pusty staging,
origin/master jest przodkiem mastera (6 lokalnych commitów, 0 brakujących).
Porównanie blobów potwierdziło identyczną zawartość 36 plików nieśledzonych
oraz wszystkich lokalnie zmienionych plików poza siedmioma nakładającymi
się ścieżkami. ESLint obu rozstrzyganych plików: PASS. TypeScript noEmit:
4 błędy istniejących lokalnych zmian About — brak pola `institution`
w `ExtendedAuthor` (`aboutFullmag.ts`, `AboutSection.tsx`).
Pełnego buildu i kompilacji testów nie uruchamiano. Powyższe dowody Rust
i runtime dotyczą stanu sprzed synchronizacji; nie kwalifikują nowego HEAD.
Nie wykonano push. Cel E0–E7 pozostaje aktywny.

## E1 — żądanie kroku w schedulerze i workerze (2026-10-05)

Kontynuacja po synchronizacji, baza HEAD
`39427c8683911f69b4f77790468543642a5158ae`, współdzielony dirty master.
Poprzedni punkt następnej integracji (globalne żądanie w schedulerze/workerze)
jest realizowany w tej części; dalsze bramki E1–E7 pozostają otwarte.

`RequestedExecution::for_problem` wyprowadza backend/device/precision/mode
z immutable ProblemIR przy zachowaniu jawnych ograniczeń RunSpec. Nie czyta
hosta ani środowiska. Globalne Auto pozwala na konkretne wybory CPU/GPU
poszczególnych kroków. Dla CPU zeruje się tylko minimum VRAM; wspólne
konserwatywne minima CPU/RAM/storage nadal obowiązują. Typed resources
muszą mieścić się w tym budżecie.

Nowe wejście kroku ma `resolved_task_input.v3`; odczyt v2 zachowuje znaczenie
globalnego żądania. `validate_execution_for_problem` odtwarza właściwą wersję
i sprawdza tożsamość RunSpec. Worker sprawdza żądanie przed dispatch i używa
go zamiast ponownie wybierać globalny request. Adapter FDM zachowuje pozostałe
pola `runtime_selection`, w tym `cpu_threads`, przy projekcji device/precision.

Źródła regresji obejmują per-step CPU/GPU, explicit conflict, Auto, budget,
wersjonowany replay i odrzucenie niezgodnego requestu. Zakaz kompilowania
testów Rust pozostaje w mocy. Bieżąca weryfikacja źródeł: **w toku**.
Nie deklaruje to jeszcze runtime proof ani E2/E3: Auto task bez konkretnego
wyboru nadal potrzebuje legalnego resolve, mieszane precision/mode wymagają
migracji run summary, a durable profile provider i UI/DSL/CLI/env wymagają
dalszej implementacji.
