# Checkpoint implementacji Compute execution

Zlecenie: cały zakres E0–E7, bez redukcji celu. Aktualizacja: 2026-10-13.
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
| E1 | W toku: typed ComputeResources i profile materialization per Study/step, Python/SceneDocument/script round-trip zasobów, Preview/Settings plumbing, allowlista `FULLMAG_CPU_THREADS` dla zadeklarowanych profili oraz użycie external resolution dla typed Auto | Pełne CLI/env compatibility, durable Submit provenance i runtime |
| E2 | W toku: host ledger, typed service policy, host-aware admission/recovery, pre-spawn cancellation, walidowany `ComputeNodeSnapshot` v2 z lease'em publishera i epoch fencing requestu/rezerwacji; explicit CPU/GPU placement jest porównywany z bieżącym inventory; sampler publikuje topologię Linux/Windows, CPU set i limit cgroup Linux; owner-bound CPU admission używa minimum budżetu polityki i świeżej efektywnej pojemności OS/cgroup | Windows Job quota i wielogrupowa affinity Windows pozostają nieraportowane; runtime affinity proof, Linux build, migracja i ścieżki recovery |
| E3 | W toku: exact host lease/UUID binding, GPU visibility checks, przypięte CPU IDs, fail-closed OS affinity oraz źródłowa polityka pul wątków FEM; wcześniejszy Windows backend-dev potwierdził API przed ostatnią zmianą pul | measured receipts, NUMA placement, Linux build i Linux/Windows runtime execution proof; aktualne źródła pul nie są skompilowane |
| E4 | W toku: profile drafts, compute preview, Jobs/Cancel, statusy solverów, `stale` po 30 s, podsumowanie polityki batcha oraz podwidoki Settings Overview/Resources/Profiles z inwentarzem tylko do odczytu | Generated OpenAPI/types, pełne resource-policy mutation APIs/facade, pełna integracja Study/Jobs i browser proof na bieżącym backendzie |
| E5 | W toku: typed case bindings/materialization, trwały `FmsBatchIntent` i sequence-fenced cursor, parent Submit/List/Cases, OutputStorage snapshot, fair publisher child RunIntent, `max_parallel_cases`, `failure_policy`/`stopped` i Inspector z lifecycle oraz odkrywaniem SolutionSetów | Batch retry/cancel, pełne przeglądanie artefaktów wyników i runtime/browser proof pozostają otwarte |
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
W trakcie pracy inny uczestnik zapisał lokalne zmiany jako `c0eebebf8`
i scalił remote do `056d4f50d10389be83a68b9941d2fbcdcb8fc072`.
Ten agent nie wykonał tych commitów ani push. Sprawdzono zachowanie zmian;
kontrola źródeł tego fragmentu dotyczy nowego HEAD z dalszym lokalnym diffem.
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
Scheduler ocenia ofertę wewnątrz pętli kroków, a bezpośrednie admission
sprawdza to samo urządzenie i wszystkie cztery minima budżetu. Niedopasowanie
oferty dla kroku GPU nie blokuje oceny późniejszego kroku CPU.

Źródła regresji obejmują per-step CPU/GPU, explicit conflict, Auto, budget,
wersjonowany replay i odrzucenie niezgodnego requestu. Zakaz kompilowania
testów Rust pozostaje w mocy. `just check-api-source`: **PASS**, exit 0,
`source_changed_during_run=false`; HEAD
`056d4f50d10389be83a68b9941d2fbcdcb8fc072` z lokalnym diffem.
Receipt:
`<FULLMAG_PROJECT_STORAGE_ROOT>/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/56aaeb0a3f9d4ea6a92fb61c6c6b054b/receipt.json`.
Scoped rustfmt i `git diff --check`: PASS. Kontrola źródeł nie wykonywała
testów Rust ani solverów; 101 ostrzeżeń kompilatora pozostaje w szerszym API.
Nie deklaruje to jeszcze runtime proof ani E2/E3: Auto task bez konkretnego
wyboru nadal potrzebuje legalnego resolve, mieszane precision/mode wymagają
migracji run summary, a durable profile provider i UI/DSL/CLI/env wymagają
dalszej implementacji.

## E1/E4 — trwały katalog i edytor profili (2026-10-05)

Dodano katalog immutable wersji w skonfigurowanym accepted-run SessionStore,
z atomowym zapisem, blokadą istniejącego writera, rewizją katalogu i
idempotentnym `client_intent_id`. Powtórzenie tej samej kanonicznej treści
zachowuje wersję również po ponownym odczycie z dysku. Uszkodzony katalog
nie jest zastępowany pustym. Limity: 1024 wersje, 4 MiB katalogu, 32 KiB
profilu i 64 KiB żądania publikacji.

`GET/POST /v2/platform/compute/profiles` oraz wygenerowany klient udostępniają
typowane częściowe ustawienia. Settings pozwala tworzyć profil i nową
wersję, zachowuje zaawansowane pola zasobów, rozróżnia Inherit i jawne Auto,
stosuje Apply/Cancel, zachowuje szkic po konflikcie i uzgadnia nieznany wynik
zapisu przez ten sam intent. Katalog i formularz są związane z instancją API.
Zapis profilu nie przypisuje go do Study ani nie zmienia zaakceptowanego runu.

Dowody tego fragmentu:

- OpenAPI codegen: PASS, receipt `5ad048e987a741e6abe1e89dc88f1f6a`.
- Generowanie klienta: PASS, receipt `2fca9616496e464083ea249c1ba1e59e`.
- Production TypeScript: PASS, receipt `7dbf651639ff441980474b4a1552b467`.
- Aktualna kontrola API po poprawce canonical replay: PASS, receipt
  `00068b93e3fa48e3bcf144b8e74b20e9`, HEAD
  `91d0788bd6b7c63327b45fab1770a44720176689` z lokalnym diffem.
- Interpreted checks szkicu i wygenerowanego OpenAPI oraz scoped ESLint: PASS.
- Pierwszy kontrolowany przebieg przeglądarkowy: 14/14, receipt
  `16c81049c74d43d2bf7b9b50983dc455`, źródła niezmienione i zamknięcie
  wyłącznie własnego serwera potwierdzone. To fixture HTTP z rzeczywistym
  komponentem, fasadą API i resource hook, nie dowód backendowego zapisu.
- React Doctor: brak zgłoszeń w 10 skanowanych plikach, exit 0; receipt
  `115600d56d6b4a4c88a3c64ddab9993f` odrzucony przez zmianę źródeł sprawdzianu
  podczas skanu. Wymaga powtórzenia na ustalonych źródłach.

Po pojawieniu się kolejnych zmian origin/master zachowano dwa nakładające
się pliki w stashu `64eb1cd91af2cbee5f5de94c7654eaaf1342a454`, wykonano merge
`e5f704b12094dac0b061bd8785c0552a4b6f8458` i przywrócono zmiany. Usunięto
duplikat pola institution powstały z niezależnych identycznych poprawek.
Brak unmerged entries; master zawiera origin/master, 2 lokalne commity,
0 brakujących. Nie wykonano push ani commita zmian compute. Dowody sprzed
tego merge wymagają osobnej interpretacji; ponowna kontrola jest w toku.

Zakaz kompilacji testów jednostkowych zachowano. Dodane regresje Rust są
wyłącznie źródłami. Trwałość katalogu po restarcie rzeczywistego API pozostaje
NOT VERIFIED. E1 nadal wymaga powiązania wersji profilu z authoring/submit,
adapterów UI/DSL/CLI/env i podsumowania mieszanych precision/mode. E2/E3
ledger, enforcement oraz E5–E7 nie są ukończone.

Weryfikacja po scaleniu `e5f704b12094dac0b061bd8785c0552a4b6f8458`:
browser fixture `5f9229d0ff07436d89d9aabae73c624b` **PASS**, 14/14,
`source_changed_during_run=false`, własny serwer zamknięty. Oceniono zrzut
jasnego motywu; przełączanie schematu kolorów i stabilizacja animacji usunęły
przejściowy zły kontrast. Nie zmieniano globalnych styli dla tego artefaktu.
Production TypeScript `39dd72c60ac548ac97c161335e7608c8` **PASS** i React Doctor
`e8cdfd1907e3475f9476675294cacf03` **PASS**, bez zgłoszeń. Oba receipts
potwierdzają niezmienione źródła. Ostatnie uproszczenie wykonywania zrzutu
(Playwright `animations: disabled`) przeszło scoped ESLint; dotyczy drivera,
nie produkcyjnego formularza. Współdzielony master został następnie
zsynchronizowany na remote przez innego uczestnika: ahead/behind 0/0.
Kontrola API po merge: `46eea741bbcb4fd4a160c619a82e67fc` **PASS**, exit 0,
źródła niezmienione. Nie uruchamiano testów Rust ani solverów.

## E1 — published profile provider przy HTTP Submit (2026-10-05)

Application ma `materialize_referenced_execution`: provider musi zwrócić
dokładne ID/version, a wspólny resolver odtwarza ustawienia i origins.
Nie czyta hosta/env i nie stosuje zastępczego profilu. Nowy HTTP Submit
sprawdza snapshoty materializacji względem katalogu profili tego samego
accepted-run store. Podmiana treści pod istniejącą wersją, brak wersji lub
niezgodne pochodzenie są konfliktami przed zaakceptowaniem runu. Jawne
warstwy study/step/submit pozostają wejściem tego samego resolvera.
Powtórzenie przyjętego intentu zachowuje existing fingerprint i nie odczytuje
ponownie katalogu preferencji. Katalogi v1 bez snapshotów nadal przechodzą
dotychczasową trasą zgodności; nie dopisujemy fikcyjnego provenance.

Managed `check-api-source`: **PASS**, exit 0, niezmienione źródła, receipt
`83789f02a2964b06aa4f306a86628f5b`, HEAD
`3ea4ad3ce94ca4733529b8bf5b4293a0320f7328` z lokalnym diffem. Po przerwaniu
odczytano terminalny receipt zamiast uruchamiać drugi build. Regresje Rust
opisują exact version, brak fallbacku, obcą wersję, forged content i origins
oraz jawne warstwy. Zgodnie z zakazem nie były kompilowane ani wykonywane.
HTTP runtime i trwałość po restarcie nadal **NOT VERIFIED**. Kształt
transportu nie zmienił się; rozszerzono walidację istniejącego Submit/409.

Import opublikowanego sparse profilu do typed Python jest zaimplementowany
w `ExecutionProfile.from_ir` i odpowiednich typed overrides. Zachowuje
omission/Auto/null, pełny GPU/target/parallelism oraz content identity;
odrzuca obce pola, schematy i typy. Puste sparse bloki normalizują się do
pominięcia. Nie powstał drugi resolver ani odczyt hosta/env.
Interpretowany check z `PYTHONDONTWRITEBYTECODE=1`, `PYTHONPATH` wskazującym
`packages/fullmag-py/src`, `python -B -m pytest -q -p no:cacheprovider
packages/fullmag-py/tests/test_execution_profile.py`: **44 passed in 1.54s**,
exit 0. SHA-256 źródła modelu:
`7a48cd74a387cfbe2941dce0dd8fad139ea9b15792438ace1bd4bc644f5715a5`;
testu `5209ea3c8665ec8a9e6d83f50485f66488504a9d343eac102e291c5eb479e6d2`.

Review skorygowało rozróżnienie uszkodzonego zapisanego profilu (500) od
niezgodnego snapshotu klienta (409). Ponowny source check
`e3b9d688b3044c85af4d9d2e0123c41c`: PASS. Następnie master zaktualizowano
fast-forward do `b0ab9e4e32f68caaf4e9bcc115681c5d71307032`. Lokalny import
modułu profili zachowano w stashu
`6ab0ab178c251d9a58ee8c0a8d4cf1541db516f3` i przywrócono bez konfliktów.
Kontrola API po zmianach SessionStore: **PASS**, receipt
`73d9f63693314653968b05127a8c8cc7`, exit 0, źródła niezmienione.
Ahead/behind 0/0, brak unmerged entries. Nie wykonano push.

Przypisanie do Study UI, CLI/env, mieszane precision/mode i dalsze E2–E7
pozostają otwarte. Runtime HTTP i restart store nie zostały zweryfikowane.
Nie wykonano stagingu ani commita zmian tego etapu.

## E1 — materializacja całego kanonicznego Study (2026-10-05)

Po odczycie bieżącego Study UI ustalono, że nadal edytuje wcześniejszą scenę
i pipeline etapów. Kanoniczne StudyPlan i StudyProblemCatalog są wejściem
Submit. Dodanie lokalnego selectora nie zamknęłoby tej różnicy. Application
otrzymało `materialize_study_execution` i typed `StudyStepExecutionInput`.
Funkcja weryfikuje kompletność wejść wszystkich enabled steps, odrzuca
powielenia/unknown/disabled, przypina immutable wersje przez provider,
stosuje jawne warstwy per step, tworzy nowy ProblemIR i katalog związany
z rewizją/hashem StudyPlan. Kolejność transportu nie zmienia kolejności
wyniku. Wspólna wersja profilu jest odczytywana raz w obrębie materializacji.

Nowy HTTP Submit używa tej samej funkcji i porównuje snapshoty według step_id.
Dotychczasowa ścieżka v1 oraz zaakceptowany replay pozostają bez zmian.
Application ma teraz bezpośrednią zależność od istniejącego fullmag-authoring;
Cargo.lock zaktualizowano wyłącznie o tę krawędź. Nie dodano nowego formatu
transportu ani osobnego resolvera we frontendzie.

`just check-api-source`: **PASS**, exit 0, niezmienione źródła, receipt
`0ab95377aff24b8690ffe3de8731d8d2` na
`b0ab9e4e32f68caaf4e9bcc115681c5d71307032` z lokalnym diffem.
Dodano trzy źródła regresji całego Study: wspólna wersja i odrębne warstwy,
stabilna kolejność/hash i niezmieniony oryginał, błędne wejścia oraz brak/zła
wersja profilu. Po ograniczeniu dostępu rustfmt w sandboxie formatter
uruchomiono z zatwierdzonym dostępem: format, rustfmt --check i scoped
git diff --check PASS. Testów Rust nie kompilowano ani nie wykonywano.
Dowodu HTTP runtime/solverów ten etap nie dostarcza. Inny uczestnik zapisał
frontendowy commit `c168dc5ff1c5d281c50aeabb0b7ba3d782fb740c`; hashe produkcyjnych
plików materializatora i API nadal odpowiadają receiptowi powyżej.
Kolejna integracja: kanoniczne przypisanie profilu w authoringu sceny/Study,
eksport Python i cienki preview przed Submit. CLI/env i mixed precision/mode
oraz E2–E7 nadal wymagają implementacji. Cel pozostaje aktywny.

## E1/E4 — stateless execution preview w API (2026-10-05)

Dodano `POST /v2/platform/compute/preview` korzystający z materializacji
całego Study oraz istniejącego planner lowering. Wymaga rewizji katalogu
profili i exact canonical inputs; zwraca katalog do Submit, SHA-256, source
digest, scoped preview_id i typowane per-step requested/origins. Rewizja
nieaktualna lub brak wersji daje 409. Limit to 256 kroków i 8 MiB body/response.
Odczyt katalogu jest wspólny z GET profiles i nie tworzy missing store.
Nie ma trwałego zapisu, przyjęcia runu ani startu preparation/workera.
Admission ma wyłącznie `not_evaluated` oraz blocker
`host_admission_not_evaluated`; 200 nie oznacza gotowości hosta do wykonania.

Kontrakt typuje pełne zasoby (odrębnie od sparse patches), profile, warstwy,
origins i envelope. StudyPlan/ProblemIR/catalog zachowują istniejącą opaque
kanoniczną granicę ProjectRunSubmit, walidowaną przez Rust. Usunięcie tej
granicy oraz authoring formularza Study pozostają do migracji E1/E4.
Fasada `ControlRoomApi.platform.computeExecutionPreview` używa wygenerowanych
typów i centralnego path. Nie dodano lokalnego resolvera ani component fetch.

Weryfikacja:

- OpenAPI codegen `7edd43fbb85d44a5be09081468643980`: **PASS**, exit 0,
  źródła niezmienione. Poprzedni `4a4b5aa902b8471ca33beacc117140cd`
  wygenerował spec, lecz został odrzucony jako source_changed; nie jest PASS.
- Generator klienta `4151948c48de4ae48db483d45d9a6204`: **PASS**.
- Production TypeScript `cc48cc50cda94bdf9878c064cb29097b`: **PASS**.
- Interpreted `check-compute-preview-openapi.mjs` i dotychczasowy checker
  profili: **PASS**. Scoped ESLint, rustfmt --check i diff check: **PASS**.
- Dodano trzy źródła regresji preview: stabilny digest przy innym input order,
  scoping instancji, brak admission, revision/reference/input errors i
  nieutworzenie missing storage. Testów Rust nie kompilowano ani nie wykonano.

Browser rendering nie zmieniał się w tym etapie. HTTP runtime proof oraz
admission/solver proof pozostają **NOT VERIFIED**. Pozostałe E1–E7 nie są
zamknięte. Następne: kanoniczne pole wyboru profilu i request layers w
authoringu Study/sceny, eksport Python oraz resource hook/formularz preview.
Nie wykonano commita ani push zmian tego etapu; zachowano cudzą pracę.

## E1 — profil w scenie, Pythonie i loaderach (2026-10-05)

SceneStudyState i ScriptBuilderState przechowują immutable profil oraz typed
execution layers. Adaptery i projekcja authoring model zachowują pola;
legacy JSON bez profilu nadal je pomija. Python udostępnia publiczny
ExecutionRequestLayer i study.execution_profile(). Deklaracja poprzedza
kroki; legacy selection (także jawne Auto), change_device i eager solver
execution nie mogą być łączone z nowym profilem. Capture/eksport pozostają
dostępne. Round-trip scena/builder/skrypt zachowuje profile i sparse patches,
bez lokalnego resolvera ani odczytu hosta.

Wspólny bind_declared_execution materializuje deklaracje przed plannerem
w API scene loader i loaderach CLI. Oba przebiegi importu skryptu stosują
jawne CLI backend/mode/precision jako warstwę; wymuszony device sprzeczny
z managed lane jest błędem. Binder zapisuje pełny snapshot w ProblemIR;
istniejący snapshot przechodzi replay także bez nowych override layers.
Planner odrzuca pozostawione deklaracje i zmianę konkretnych wartości
bound intentu. Auto może zostać zawężone operacyjnie przy zachowanym request.

Weryfikacja i aktualizacja mastera:

- Python: 67/67 interpreted checks, exit 0, python -B / no cacheprovider;
  model SHA-256 3eddbddcdb8e62c300fc8c4fd4815c8962bf20205bee4c419615ed786479025c,
  nowy round-trip check 8a4cfd87e84067f15537f1892bd70e5631583932716bcce1a7cb98df94567bfb.
- Przed aktualizacją: API source c594de270b614e64939f723dd1f222b7 PASS.
  Pierwszy 8dd525f1197c4e8ea4491cb44dd1b2e1 miał compiler exit 0, ale
  source_changed; nie jest PASS. Pierwszy CLI c6a9da4ae19f44acab54c638412a002d
  PASS poprzedza końcową walidację replay i aktualizację remote.
- Pobrano origin/master i scalono jako
  25a449c44dda53684b63c5281c6bc59c6b49ab87. 13 nakładających się dirty plików
  zabezpieczono w zachowanym stash 4c137b778a50c9bbb6108f3c23571593b87d5b33.
  Przywrócenie dało pięć konfliktów; importy połączono semantycznie,
  generowane pliki odtworzono ze scalonych źródeł. Zachowano workspace API,
  IndexedLocations, compute profiles/preview i development build requests.
  Brak unmerged paths i pusty staging; pozostała cudza praca jest zachowana.
- Po scaleniu OpenAPI cb3fbe99e3a748b899ac96eec226db7e PASS;
  klient 794d272e8d42477b9e26ca38fc625d12 PASS;
  CLI source de4b0e34255c4113b49953d668171f06 PASS;
  produkcyjny TypeScript 33fd3d156609443baa0d5c0d397731ef PASS.
  Oba interpreted checkery generated OpenAPI compute PASS.
- Scoped rustfmt/diff checks PASS. Dodano źródła regresji Rust, również
  replay tampered snapshot i nested change_device. Testów Rust nie kompilowano
  ani nie wykonywano zgodnie z zakazem użytkownika.

Automatyczna kontrola odrzuciła zbiorczą operację usuwania markerów i
nadpisania generated files bez dowodu semantycznego rozwiązania. Operację
zastąpiono jawnymi poprawkami importów i zarządzaną regeneracją; nie ma
pozostałej blokady uprawnień tego kroku.

Formularz przypisania profilu w Study i resource hook/formularz preview nie
są jeszcze wdrożone. API scene loader zachowuje istniejącą granicę auto/fdm.
HTTP runtime, admission i solver proof pozostają NOT VERIFIED; browser UI
nie zmieniał się poza przywróceniem obu importów Settings. E1–E7 pozostają
aktywne; kolejne prace dotyczą kanonicznego authoringu Study/preview i
adapterów admission/enforcement. Lokalnych zmian tego etapu nie commitowano
ani nie pushowano; merge dotyczył wyłącznie istniejących commitów mastera.

## E1/E4 — transport i własność preview; authoring Study w toku (2026-10-05)

Poprawiono OpenAPI preview: StudyPlan i ProblemIR są otwartymi JSON maps,
nie Record<string, never>. Bezpośrednie additional_properties na Object
zostało pominięte przez generator; końcowy schema shadow używa BTreeMap
z serde_json::Value. Rust nadal deserializuje dokładne typy domenowe.
Końcowy generator OpenAPI 86be39e1fc064cccb503654e9d2c2ad3 PASS, klient
cce3eb4c5e794d7397b25e66f4853bf0 PASS; generated checker potwierdza
additionalProperties {}, a klient przyjmuje wartości unknown.

Dodano prepareComputeExecutionPreview: detached/frozen body, limit 8 MiB,
digest HTTP body oraz API/session scope. useComputeExecutionPreviewResource
korzysta z fasady i wspólnego useResource; cache key obejmuje digest i sesję,
API scope jest sprawdzany przed odczytem, stare inflight jest anulowane przy
zmianie wejścia. Sprawdza również profile catalogue revision odpowiedzi.
Nie wyprowadza StudyPlan z legacy pipeline ani nie wykonuje Submit.
Interpreted check immutability/body change/API-session fencing/limit PASS;
scoped ESLint PASS. Production TypeScript cc7a10631f8f4d9badd2ac49581a987f
PASS z niezmienionym frontendem w trakcie kontroli.

Materializator całego Study otrzymał guard carried execution: nie można
cicho pominąć profilu/layers zapisanych w authored ProblemIR ani zastąpić
ich inną treścią bez nowego authored wejścia. Bound snapshot przechodzi
canonical replay, a explicit layers muszą zachować carried prefix.
API production source 48293cf4088949b7b766db54cdb726f7 PASS, exit 0.
Następnie dodano wyłącznie źródło regresji guardu: omitted layers, changed
profile, preserved declaration/snapshot i tampered replay. Rustfmt PASS;
testów Rust nie kompilowano ani nie wykonano.

Worker /root/study_profile_ui (Luna max, bez dalszej delegacji) realizuje
StudyExecutionProfileModel/Section i integrację z StudyInspectorPanel,
StudyGlobalAuthoringModel oraz StudyPipelineSection. Kontrakt: jeden root
Inspector edit-session owner, history/model transaction/base revision,
exact profile version z resource hook, Apply/Cancel i scope reset,
preservation advanced layers, brak mieszania z legacy requested_* lub
Change device. Na chwile checkpointu seam jest rozpoznany; implementacja
UI i fixture nie są jeszcze oddane ani zweryfikowane. Nie przedstawiamy
tego panelu jako gotowego.

Dodano zarządzaną receptę verify-study-execution-profile-browser: fixed
scenario/port 3256, source snapshot/storage/lease/receipt i cleanup tylko
owned fixture process. Parser Python i just --list PASS; browser nie został
jeszcze uruchomiony, ponieważ fixture powstaje z workerem. Parent jest
właścicielem justfile/wrappera, worker fixture/smoke.

Pozostałe szwy: serwerowa kanoniczna projekcja Scene/pipeline → StudyPlan
i ProblemIR per enabled step dla formularza preview; current legacy stage
editor zapisuje flat stages. Live authoring i portable project archive są
odrębnymi ścieżkami: synchronizeAuthoring jest wołany jawnie przy NewProblem,
nie zakładamy automatycznego archive Save po mutacji Inspectora. Oba szwy
wymagają dalszej integracji. Host admission/enforcement, browser nowego
panelu, runtime/physics oraz E2–E7 pozostają NOT VERIFIED lub niewdrożone.
Cel aktywny; bez staging/commita/push tego fragmentu.

## E1 — atomowe przypisanie i szwy restore/import (2026-10-05)

Review panelu ujawnił problem RFC7396: merge_patch execution_profile scalałby
sparse defaults nowej wersji z poprzednią. Dodano wariant istniejącej model
transaction assign_study_execution: wymagane base_revision, pełny typed
execution_profile i execution_layers. Handler zastępuje oba pola w kopii
sceny, waliduje originy/Change device i korzysta z istniejącego session/revision
commit. Pozostałe pola sceny są zachowane. Non-null profile przez zwykły merge
jest odrzucany; jawne wyczyszczenie obu pól null i pełne ReplaceScene/Undo
pozostają dostępne. Nie jest to publikacja profilu ani host admission.

- OpenAPI a8e8eda3d9ea4cebbc3cafdd00118807 PASS, client
  c3b67234c64b49cbbe0890479957c7bd PASS, interpreted schema checker wymaganej
  rewizji/full profile/typed layers PASS. Pierwszy 39c118e84a0e4a3b98cfaa72af0e1e63
  został odrzucony jako source_changed podczas formatowania nowych regresji.
- Dodano trzy source-only regresje atomowego zastąpienia, zachowania innych
  pól, stale revision/illegal layers/missing revision i jawnego clear.
  Rustfmt tych źródeł oraz scoped diff check PASS. Nie kompilowano testów.
- Restore compatibility w kategorii execution obejmuje authored profile/layers;
  no-profile snapshot zachowuje legacy formę. API source check
  83838c6c7c6542cf86f616156e22271b PASS przed dodaniem atomowej transakcji;
  późniejszy OpenAPI build powyżej obejmuje oba rozszerzenia. Source-only
  regresja sprawdza zmianę wersji/layers przy tych samych runtime fields.
  Formatter ograniczono do własnego kodu; przypadkowy churn pozostałej części
  session_persistence usunięto po dokładnym porównaniu z formatowanym HEAD.
- Python ExecutionRequestLayer.from_ir akceptuje omitted request jako {},
  zgodnie z Rust serde default; explicit null nadal odrzucany. Interpreted
  profile/authoring suite: 68/68, exit 0. Model SHA-256
  765348aa584acf3454c190bb38a3821fa9a2a0ad16210a98953e2313ee3bfc99;
  roundtrip test 67dd4a884dffbbaafed48f65c4899d16c4f2a4ea6cc9acad78e9c2ff35e20ca0.
- Przygotowanie preview przechwytuje API/session scope przed async digest;
  mutacja obiektu scope w trakcie await nie może przepiąć starych wejść.
  Dodany interpreted check PASS.

Worker ma już model, komponent i integrację Study. Review rodzica wymusił
zachowanie pierwotnej rewizji dirty draftu, brak silent overwrite advanced
layers, dostępność None przy offline catalogue, uint32 threads i canonical
empty request. Profile-only root Inspector Apply korzysta z callbacku panelu.
Simultaneous profile + global/stage drafts wymagają jawnego oddzielnego zapisu
z widoczną przyczyną blokady zamiast kolejnych stale mutations. Pełny combined
Apply pozostaje dalszym szwem authoringu. Po wcześniejszym ACK zwykłe Study
mutacje uzgadniają świeżą scenę; wymagane są reset po scope change i właściwy
history-before snapshot. Worker kończy te poprawki oraz fixture/smoke.

Pierwszy managed TypeScript 74ae9a91af29470d811f0bc06f70ce39: FAILED, dwie
diagnozy w istniejącym ObjectMagneticTexturePanel po rozszerzeniu unionu.
Producent requestu zawężono do Extract<..., patch_magnetization>, zachowując
wymaganą rewizję nowego wariantu; scoped ESLint PASS. Końcowy managed TypeScript,
React Doctor i browser po freeze workera pozostają do wykonania. Panel UI nie
jest jeszcze zweryfikowaną dostawą. Runtime/solver/admission i E2–E7 nadal
nie są ukończone; cel aktywny, master bez nowego worktree, bez staging/push.

## E1/E4 — Study profile UI i powiązany Save (2026-10-05)

Study Inspector ma wersjonowany wybór profilu i sparse overrides. Korzysta
z katalogu resource hook i atomowego assign_study_execution. Nieedytowane
warstwy/advanced values pozostają pełne; Inherit i Auto są rozróżnione.
None czyści przypisanie. Konflikt rewizji zachowuje szkic i wymaga Cancel;
zmiana API/session scope resetuje go. Apply jest podłączone do wspólnego
właściciela sesji Inspectora i historii. Jednoczesny szkic profilu i innych
zmian Study pozostaje blokowany z przyczyną; combined Apply nie jest gotowe.

ProjectDocumentController przed Save projektu jawnie powiązanego po Create
pobiera kanoniczną scenę i synchronizuje archiwum. ID zaakceptowanej sesji,
API scope i potwierdzone epoch/request scope są fence; zmiana kontekstu,
błąd odczytu lub unknown sync outcome zatrzymuje zapis. Wspólna projekcja
sceny zachowuje study/profile/layers i wyklucza metadata zasobu. Nie ma
panelowego autosync ani cichego fallbacku do starszych bajtów. Otwarte,
niepowiązane archiwa zachowują swoje dane; powiązanie po import/restore
i development handoff pozostaje wymagane. Nie potwierdzono rzeczywistego
hostowego zapisu ani backend runtime.

- Interpreted check-project-authoring-save PASS: profile/layers w zapisanych
  bajtach fixture, brak zapisu/adopcji po błędzie lub zmianie scope, projekt
  zastąpiony podczas odczytu i read-only. No test compilation.
- Dotychczasowy interpreted development-run-outcome-handoff: 5 grup PASS.
- Interpreted Study profile model, atomic OpenAPI i preview OpenAPI PASS;
  scoped ESLint komponentów, persistence, projection i smoke PASS.
- Managed TypeScript 63bf1873810c44b2917dd95eb0653835 PASS przed finalną
  drobną poprawką ref i kolejnym merge. Doctor b57d08bb16784c1cb8532b70a7c07f20
  ukończony z jednym warning computed ref initializer; poprawiono tylko ten
  initializer, istniejący ready effect pozostaje właścicielem rewizji.
- Browser 126f70e8af974af6abe6a90d7f299c90 PASS, 9/9, bez page/console errors.
  Rzeczywiste komponenty/facade/history z kontrolowanym HTTP i pustym WS;
  sprawdzono Apply/Cancel, full layers, stale revision, reset sesji,
  Change device i brak preview/solver operacji. Obejrzano dark/light PNG.
  Jest to fixture-only, nie runtime/admission/science.
- Poprzednie browser receipts 8077f7948d0f4c20aa3c1a1c51213623,
  b87e7dcb6d2642cfb1339f16a41d95be, aa1c1f8dc7f646f098c48ec1085285ad,
  543864bec511418c8391a408689cfb50 są FAILED: kolejno niejednoznaczny
  locator, zła ścieżka asercji scratch, przycisk oczekiwany w podsumowaniu
  istniejącego pipeline i nieobsłużony websocket fixture. Poprawiono
  selektory/scenariusz oraz kontrolowany kanał; nie osłabiono contract checks.
  Pierwszy receipt obejmuje również source_changed po poprawce Doctor.

Remote #139 (d4292406e7ae3f8f3e8a82b0ece88df8e13dcd6c) został pobrany i
scalony na masterze jako 259ee4593ccabb40e3850515f670ebbb0c763f6b. Dziesięć
pokrywających się dirty plików zabezpieczono w retained stash
a4a7d2f87508b47da6133049df6a2b91a4bfa463 i przywrócono bez konfliktów.
Brak unmerged i staged plików. Bez nowego worktree, resetu lub push.
Po merge: OpenAPI a5962810e6a742468e5242f0a16d11ff PASS, client
747aed3d9b7041e38c0412e8a4b42e7b PASS, końcowy managed TypeScript
6e185aa031504ca59e546aee4c56a7f2 PASS i Doctor
e43084b3ed87470f91bf6e3bd1c6d4f3 PASS. Atomic/preview OpenAPI checkers
po regeneracji PASS. Brak unmerged i staging potwierdzony ponownie.
Kanoniczna Scene-step projekcja preview, import/restore binding oraz E2–E7
pozostają do wykonania; pełny cel nadal active.

## E1/E4 — wspólni producenci authoring/preview (2026-10-05)

Dodano `scene_document_to_study_plan` w fullmag-authoring. Caller dostarcza
jawne immutable references; adapter nie wymyśla modelu, solvera, dyskretyzacji
ani profilu. Niepusty authored pipeline korzysta ze wspólnego from_pipeline;
fallback flat stages zachowuje kolejność, pełny payload, ID/label/enabled.
Unknown kind pozostaje Unsupported, błędne enabled/source są odrzucane,
brak etapów nie tworzy Run. Profil/layers są walidowane i ID/version muszą
odpowiadać referencji. Parser czasu Run jest współdzielony, bez kopii logiki.
Dodano source-only regresje tych przypadków.

Review ujawnił rozbieżność migracji grup z kanonicznym CLI: disabled parent
dotychczas pozostawiał dzieci jako enabled. From_pipeline dziedziczy teraz
enabled po wszystkich przodkach, zachowując dokument wejściowy. Dodano
source-only regresję z nested group, macro, lokalnie disabled child i enabled
sibling. Nie kompilowano ani nie wykonywano Rust unit tests. To nadal adapter
struktury, bez portów stanu ani producer per-step ProblemIR.

API ma wydzielony `scene_document_to_authored_problem_ir`, korzystający
z istniejącego Python scene lowering bez bindingu. Live preparation nadal
stosuje dotychczasowe auto/FDM restriction → capture → bind → validate.
Whole-Study materializer jest jedynym przyszłym ownerem opublikowanego profilu
w preview. Python interpreted suite 68/68 PASS (exit 0); nowa asercja potwierdza
brak execution_materialization i brak mutacji sceny. SHA-256 regression file:
8d7212138ec071582f1917deb77b83c7986459811e8ade6fd524e6d96204aee0.

Przeniesiono istniejącą czystą konfigurację autosave do
`fullmag_ir::configure_project_autosave_policy`. Runner zachowuje format
availability guard i deleguje. Nie zmieniono cadence, conflict, modal ani
hysteresis policy, rezerwacji katalogów lub I/O. Dokładna zgodność ciała
ze źródłem przed przeniesieniem PASS, body SHA-256
44a84a502f1f721ba02f0e6f34ac0125d6881de5902b6c6e81ceecbde2fd936e.
Pełny nowy plik SHA-256
71bae5d15fe538034f7ae6b2afc175574788660596634158782d780e493eb81d.
To usuwa zależność od runtime z czystej części przyszłego producenta etapów;
sama konfiguracja nie dowodzi writer availability.

Next seam jest konkretny: CLI materialize_script_stages oraz jego pipeline
producenci już posiadają per-stage IR, actions, transitions i output policy.
Należy współdzielić tę czystą część w application/API, zamiast kopiować bazowy
IR lub dodawać drugą implementację solver/stage semantics. Dopiero później
można produkować pełne inputs dla obecnego endpointu preview i podłączyć formę.
Scene references, state ports i dependencies nadal wymagają materializacji.

Weryfikacja: managed API source 585c834e46aa45d8bdd1b1b81bab4d8d PASS;
CLI f354411526044161905417388c37c750 ma compiler exit 0, lecz source_changed
w main.rs/development_api_owner.rs (cudza bieżąca praca), więc nie jest PASS.
Następny CLI 8e896658ce224bd89962c3c75141d0db PASS. Po usunięciu własnych
ubocznych zmian formatowania aktualny API source
3b0733e5f3604aee894f9d2891cbbd34 PASS; końcowy CLI
2dfe53e2ef5a4f9bbc31c665c3c30dd5 PASS.

Pierwszy formatter workera z edition 2024 na lib.rs rekurencyjnie dotknął
sąsiednie moduły. Przywrócono wyłącznie potwierdzone format-only hunks
geometry.rs/geometry_features.rs; oba pliki ponownie mają czysty diff.
Nowe pliki adaptera sformatowano według repo edition 2021 z skip_children=true.
Pozostałe wcześniej dirty moduły pozostawiono, chroniąc współdzieloną pracę.
Nowe pliki, wrapper i zmieniony study_contract mają targeted format/diff PASS;
pełny IR lib rustfmt check wskazuje wcześniejsze order-only różnice poza
dodanym eksportem, których nie zmieniano. Brak nowej kompilacji testów,
uruchomienia solvera, restartu workspace, staging/push lub nowego worktree.
Aktualny obserwowany HEAD: f33e2fa53b3c5e4e5da46af399666aa84d3dc7a8.
Cały cel E0–E7 pozostaje active; ten increment nie zamyka preview ani E2–E7.

## E1/E4 — relokacja kanonicznego producenta etapów (2026-10-05)

Wspólne script capture DTO przeniesiono mechanicznie do application
script_stage_contract, z aliasami w CLI. RuntimeResolutionSummary zachowano
w CLI. Pierwotny blok (377 linii, zawierający również ten summary) miał SHA-256
0a19660de9f6eb8d64cfc118a0eeca98b6aa3118e20eb33998543021a4556717.
Nie zmieniono pól/serde; zmiana visibility pozwala użyć wspólnego ownera.
Nowe source-only fixtures dotyczą current terminal key, default true,
state_snapshot, unknown string values i transition serialization.

Przeniesiono 3126 linii czystego producenta do script_stage_materialization.
CLI zachowuje binder wrapper i polecenia live; istniejący runtime output
materializer jest jawnym callbackiem, w tej samej kolejności co wcześniej.
Application nie zależy od engine/runner/CLI/OS i nie wykonuje I/O/solvera.
Shared API używa czystego IR output policy, co nie potwierdza writer availability.
Polecenia live/minimizer validation pozostają w CLI. Przy przenoszeniu dowód
exact body identity po usunięciu visibility substitutions PASS; źródłowy span
1b99ba2a7dc0cbf8eea61104648c37e0a7d635ffccff1e7c85ce7ab354e5e5a1,
moved body 4286db2a5bbcf3c42660f8463dbc1cb1db457b157fbaf5c86b8b9739ca096cee.
Anyhow jest istniejącą workspace dependency; dodano tylko zależność application
i odpowiedni wpis lock. Stare źródła regresji CLI zachowano przez shared helper
imports, a nowo nieużywane produkcyjne importy przeniesiono pod cfg(test).
Nie kompilowano testów jednostkowych.

API capture jest wspólne dla base IR i pełnego configu, z zamkniętym enumem
komend export-scene-ir/export-scene-config. Kompozycja pełnych authored stages
używa rzeczywistego wspólnego producenta, bez clone base IR na każdy krok,
bez bindingu lub nowego endpointu. Nie produkuje jeszcze typed execution graph,
state ports ani CaseIds; te bramki nadal poprzedzają preview form i Submit.
ADR0052 dokumentuje ownera i compatibility/removal criterion.

Managed API ff8baf9c960445bf91fc0029016e5de3 PASS i CLI
afcb594234954484afe5dbfe63d49139 PASS dla przeniesionych typów/producenta.
Po kompozycji API i cleanup imports aktualny API
8863eb86370b4a3bb9587a9264a92499 PASS. Targeted non-recursive edition2021
rustfmt/diff PASS. Końcowy CLI po cleanup imports czeka na shared storage.
Najpierw owner PID91208/native dev build request 1a86350e-94dd-4194-b07d-7365d7ed11c1
był potwierdzony live; zakończył i zwolnił lock o 12:26:59 UTC. Następnie
owner PID61932, token e37fdce3a64943db98d574bf05ac4e71, potwierdzony live
14:54:41 lokalnie, uruchomił następny windows-native-fdm-cpu-dev build 3197.
Nie zatrzymano procesów, nie restartowano workspace ani nie zastosowano
alternate target/fallback. To nie jest kwalifikacja tego incrementu.

Python worker profile_python_import ma owned helper.py/scene_document_ir.py,
nowy run_config_export.py i focused test_scene_execution_config.py. Shared
export-run-config extraction i nowa komenda capture są w toku; legacy
asset/run-config selectors test_api.py 7/7 PASS. Nowa regresja ujawniła, że
renderer flat_workspace pomija overrides stages i zwraca jedynie bootstrap/
pojedynczy relax mimo relax/save_state/run w scenie. Rozszerzono scope workera
o script_builder.py: canonical Scene export/config mają zachować pełne
authored stages, a base/single IR/live behavior jest osobnym compatibility
obowiązkiem. Tej regresji nie oznaczamy PASS; fix i pełny capture proof pending.
Goal active, master bez nowego worktree, bez staging/push. E2–E7 nadal pending.

Aktualizacja tego incrementu: końcowy CLI po cleanup imports
6120fbf7a52e4661a5966cda6b0becd6 PASS. Owner61932 zakończył i zwolnił lock
15:02:07.607006 lokalnie; OS potwierdził brak PID przed uruchomieniem gate.
Niezależny porównawczy check wszystkich przeniesionych DTO/impls z HEAD,
normalizujący jedynie visibility i format, PASS. RuntimeResolutionSummary
pozostaje dokładnie w CLI. SHA-256 HEAD comparison span:
d89f8e452b6d388f76eb9485114667d44671c659f062bfc1bcedcba6a56a0114.

Python worker ma też autoryzowany narrow renderer fix w script_builder.py.
Capture rozpoznaje już relax/save_state/run; w toku checks stage IDs,
cumulative time offset oraz pokrycie pozostałych dotychczas supported stage
kinds/macros/groups. Canonical Scene export nie może zachować stage-dropping
jako domyślnego wyniku; bootstrap-only single IR jest osobnym explicit mode.
Legacy selectors 7 PASS przed renderer fix nie zastępują końcowego full capture
proof. Ten worker pozostaje aktywny, bez native solve/build/test compilation.

## E1/E4 — bounded ekspansja i granica accepted graph (2026-10-05)

Shared materializer ma nowy bounded entrypoint; Scene capture API stosuje
limit 256 wynikowych etapów. CLI zachowuje swój dwuargumentowy entrypoint
bez nowego limitu. Explicit list/minimum-one fallback są sprawdzane przed
kopiowaniem assets/metadata. Wspólny licznik obejmuje enabled groups;
disabled nodes nie zużywają budżetu. Dwuetapowe makra i faktyczne mnożniki
run/relax/save sweeps są sprawdzane przed wektorami punktów/kopiami IR.
Jawne hysteresis field_values są liczone przed float Vec. Checked arithmetic
wykrywa overflow. Primitive może utworzyć jeden stage IR przed odrzuceniem;
nie powstał drugi klasyfikator kindów. Review usunął jego początkową wersję.

Rust source regressions obejmują boundary/group accumulation, disabled group
i overflow. Nie kompilowano ani nie uruchamiano unit tests. Workerowy rustfmt
otrzymał os error 5; parent uruchomił targeted edition2021/skip_children=true
w dozwolonym checkoutcie, z eskalacją: format/diff PASS. SHA-256 materializer:
c09adc8492ab3701b742cb4de98d11e98c473ec3bfcf496be0c388ef7c48528d;
API script cbf4bc19585258c7f40b254c90c32d860ba81813e7e1267e7583a279959c3bcb.
Managed API source a875e85898fc4b4f822424cc0a5fcf94 PASS, exit 0;
managed CLI source fc68d9ee929c40c99f01ced1435ab5ca PASS, exit 0.
API source digest e6c7c9656c3fe5beeeb44f45e7dc6f22ff6a598a694e7d85423f1d6d6a50d4c8.
Native Windows owner PID18548 był potwierdzony live; źródłowe kontrole
uruchomiono dopiero po zwolnieniu shared lock. Bez kill/restart/fallback.

Read-only audit accepted worker wskazał dokładne bramki przyszłego compiler:
task identity ma step_id bez wymiaru case, worker używa case default,
nie ma action contract. Standardowe supported backend plans/horizon oraz
magnetization CAS State edge nie zastępują ContinueInPlace ani historii
integratora. Model/preset/mesh references są sprawdzane pod względem równości,
ale nie mają jeszcze pełnego mapowania do immutable content owners.
Nie wprowadzono testowych default refs do produkcji. Spec13.11 utrwala
te ograniczenia; spec13.12 opisuje bounded contract.

Python full capture nadal w toku. Review wymusił pipeline ownership:
nonempty Scene pipeline ma stage-free base IR i stages=[] dla shared Rust
producer; empty pipeline korzysta z actual LoadedStage records. Usunięto
duplikat Python expansion/coverage. Odkryto też whitelisting Run payloadu
w canonical exporter, pomijający integrator/timestep: naprawa u właściciela
eksportera, bez merge stale flat Scene.stages do authoritative pipeline.
Końcowe interpreted parity/action fidelity checks pozostają pending.

Fetch origin/master wykonany; master ahead11/behind0, brak unmerged paths
i brak staged task files. Aktualny HEAD 7f5c52459dd0697d976c5e41eedab24cbf7b3c7d.
Bez nowego worktree, staging/commit/push zmian zadania. Cel E0–E7 active;
typed Scene preview/Submit, immutable refs i runtime gates oraz E2–E7 pending.

## E1/E4 — content owner referencji captured input (2026-10-05)

Dodano StudyProblemCatalog v3 obok niezmienionych v1/v2. Captured identity v1
ma jawny source_id, schema oraz digest całego finalnego bound ProblemIR.
Model/solver/discretization references są rolami tego samego content ownera,
z captured-prefixed IDs i version sha256:digest. Nie powstały fikcyjne default
presets ani druga kopia IR. Validate i resolve ponownie sprawdzają bytes,
wyprowadzone role refs oraz pinned execution snapshot. V3 wymaga identity
i materialized execution dla wszystkich entries; downgrade/missing/mixed
identity są odrzucane. V1/v2 zachowują stary format i odczyt.

Application ma materialize_captured_study_input. Wspólna ekstrakcja dotychczasowej
sekwencji validate → referenced profile resolver → carried intent → bind
zachowuje stary WholeStudy materializer i cache lookupu. Referencje powstają
po tym jednym bindingu. Source regressions obejmują once-bound hash/lookup,
carried layer omission, tampering, source ID limits oraz legacy serialization.
Nie kompilowano ani nie uruchamiano Rust unit tests.

Publiczny canonical_ir_json_sha256 współdzieli istniejący writer profili:
sorted-key UTF-8, bez zmiany profili lub numeric semantics. Poprawiono początkowe
błędne określenie ASCII w komentarzu/nowej dokumentacji po odczycie faktycznego
writera i Python profile encoder ensure_ascii=False. Doc-only korekta nastąpiła
po API source check; nie zmieniono wykonującego kodu ani hasha profili.
ADR0052/spec13.13 utrwalają content ownership i otwartą lossless transport gate:
browser JSON.parse/stringify nie może zastępować immutable catalog bytes,
zmieniać metadata 1.0→1 lub gubić dużych integers. Nie normalizujemy scientific
input w celu dopasowania digestu. Scene preview/Submit musi zachować encoded
content albo referencję do jego utrwalonego ownera. Ta trasa nie jest gotowa.

Managed API 3b3cdacef6934303b8286001920dd996 PASS/exit0/source unchanged,
source digest 8b45cb68219cbeaceba7e329e0fcf1edb5bc37dd11ef10834ab1d57d17ec896d.
Managed CLI 9980c0f126744a3f9515ec537670f4f4 PASS/exit0/source unchanged,
source digest fa7e1b94523352f91afe27069f505335ce33cf04d05e1904ab7cd2bca8f0e201.
Targeted format/diff PASS. Final source SHA-256: study_catalog
2322fff3fcd587c90b84f7ee330ca2838b8dbce300e41175a049983794ee3eff;
IR execution_profile 5af2aa144ecc987a1e1ea8ff5af36c63be3844ba6692cc99a1521fb9daf623f4;
application study materializer 5c611b6f6f3d42c9fe3b6588c337889f05369e14d21276adfc7938bbde4af781.
Source gates nie potwierdzają działania nowego ownera w runtime ani compiler.

Python worker zgłosił final focused Scene module 8 PASS, stare scene/roundtrip
63 PASS oraz helper subset 7 PASS. Run whitelist usunięty; pełne solver payloads
są zachowane. Source/capture powtarzalne, bez TemporaryDirectory path leakage;
profile/layers i input scene pozostają nietknięte. Przejście output-storage
StageAutosave jest realizowane przez istniejący DSL. Pełny manifest/końcowy
freeze i jawne unsupported forms są jeszcze oczekiwane; nie deklarujemy
wszystkich makr/actions ani runtime Scene preview jako gotowych.

Read-only E2 seam audit potwierdza per-SessionStore atomic admission w store.rs,
brak host-wide ledger/identity/topology ownera, publisher resource_pool_main.rs
i discovery local_resources.rs. Scheduler/claim muszą w przyszłości powiązać
host reservation z task/attempt/epoch i local claim w reconciled protokole;
heartbeat age nie daje prawa do release. Nie podniesiono concurrency/cap=1.
Cały E0–E7 pozostaje active; bez nowego worktree, staging/commit/push.

### Końcowy Python freeze i asset-light review

Manifest: [python-scene-config-evidence.json](python-scene-config-evidence.json).
Final focused Scene checks 9 PASS/exit0; stare scene/roundtrip 63 PASS/exit0
i helper subset 7 PASS/exit0 dla niezmienionych legacy routes. Początkowy
AppData os.replace WinError5 rozwiązano jedną próbą z uprzednio sprawdzonym
repo-local basetemp, bez obchodzenia uprawnień. Scoped diff PASS; Ruff format
NOT VERIFIED, ponieważ moduł ruff nie jest zainstalowany. Nie instalowano
zależności ani nie kompilowano testów/solvera.

Parent review znalazł include_geometry_assets=True w Scene config: light loader
sam nie blokował build_geometry_assets_for_request w to_ir. Obie granice
base/stage zmieniono na False. Regresja monkeypatch zgłasza błąd przy dowolnej
próbie wywołania asset buildera, zarówno dla pipeline, jak i concrete stages.
Base/stage/shared assets None, geometry recipe zachowana. Legacy export-run-config
pełne assets pozostają bez zmian. Final scene_document_ir SHA-256
b77a2a32cbfdd3c9454e02ec6123a9a93bc06b8f20be10f96bf4549616baa264;
focused test ac039e01531c27b72cd5d45e0236fa241a49d27b9c7f4ff1b6a67d9b560c38c2.

Canonical Python render nadal jawnie blokuje makra bez shared materializera,
export action i wybrane rich policies opisane w manifeście. Raw pipeline
przechodzi bez strat do Rust ownera. Nie nazywamy tych ograniczeń pełnym
round-trip ani gotowym Scene preview/Submit. Następne kroki obejmują pełny
typed compiler/actions/state continuity, lossless v3 transport oraz host
ledger/enforcement/cases i pozostałe E2–E7. Goal active.

## E2 — wspólny bilans hosta i proof-backed worker release (2026-10-05)

HostResourceLedger w fullmag-session rezerwuje wspólny CPU/RAM/scratch oraz
wyłączne pełne GPU UUID z osobnymi limitami VRAM. Root/policy/topology/owner
są jawne; native Writer serializuje operacje wielu store'ów. Trwały marker
inicjalizacji zapobiega uznaniu usuniętego dokumentu za pusty ledger. Request
digest wiąże identity i cały przydział; checked sums oraz document/record limits
blokują overflow i corruption. Tentative/Committed/Quarantined trzymają capacity.

Admission bridge stosuje host writer → store writer, utrwala tentative przed
local claim i committed przed dopuszczeniem spawn. Runtime-control udostępnia
commit_claimed_task_admission_with_host z dotychczasową walidacją ready task,
execution compatibility oraz retry authorization. Istniejąca trasa nie jest
automatycznie przełączana; aktywne leases pozostają zachowane.

Worker release wymaga durable process-exit receipt oraz exact już Released
local lease, zgodnych także w heartbeat i budżecie. Bounded content-addressed
proof jest utrwalany przed Released i sprawdzany przy każdym odczycie. Brak
proof, niejednoznaczna publikacja lub aktywny local lease nie zwalnia capacity.
Receipt sam nie wystarcza: supervisor może zatrzymać lease przy ambiguous
pending effect. Stop request i heartbeat age nie są exit proof.

Regresje Rust pozostają source-only, bez kompilacji zgodnie z zakazem. Kontrole
źródeł tego nowego fragmentu są jeszcze oczekiwane. E2 nie jest ukończony:
typed preparation identity/admission/release, inventory/config ownership,
policy lifecycle/drain/recovery i scheduler wiring pozostają otwarte. MIG,
tentative cancellation i owner/policy migration nie są zaimplementowane.
Cap=1 pozostaje; brak dowodu runtime dwóch store'ów i worker enforcement.

Frozen solver-only ledger SHA-256:
c86d1a64e37800b20fa5c3f5ee5a842b8ceab5fdb37d18a8fe2f34100bffb3d5.
Claim adapter SHA-256:
d0d5e4134841f384fcb4c2f7af7665dbb51010b498f9ec20e0f2a7e91b1fdd6d.
Managed API 2f0bcd34780241239b824d692e9b3ea6 PASS/exit0, source unchanged,
digest 33942d8595260e41c072b6a75afab61574db3a14ba95b455610f9391f09c754d.
Managed CLI 450c88f36e594d7399fef7bc732fba96 PASS/exit0, source unchanged,
digest 853eb82b4f209056ad68c26977e2ee4075c3da1a944c7f62ba99645ef3798a12.
Focused format/diff PASS. HEAD przy tych bramkach:
99b829704caca663808c7484cd6b928ddfb26584, master, brak unmerged paths.
Foreign staged files zachowane; bez task staging/commit/push/worktree.

Kolejny fragment rozszerza wspólną identity o typed Solver/Preparation owner
oraz preparation admission i proof-backed release. Dowody powyżej dotyczą
zamrożonej solver-only wersji, nie nowych zmian tego fragmentu ani runtime.

### E2 — typed preparation owner i adapter dispatch (w toku)

Identity rozróżnia Solver attempt/epoch i Preparation process attempt oraz
wiąże common store/run/task/resource/token. Resource ID należy do request
digest. Preparation admission używa istniejącego pool generation i retry
authorization sequence, pod host→store writer; None/error pozostawia hold.
Release weryfikuje exact host identity/budget przed lokalną finalizacją,
następnie Released lease i content-addressed proof. Replay już Released host
reservation omija finalizer, który może odrzucać task po przejściu do solvera.
Immutable proof publication odrzuca inne bytes i metadata/read errors.

Runtime-control ma host_allocation oraz schedule_next_ready_accepted_task_with_host.
Jeden constructor requestu używa exact claim i explicit placement; nie odczytuje
UUID z nazwy oferty. Host admission precedes Prepare/Start. CPU/preparation
nie rezerwują VRAM; single-GPU legacy lease ma jeden UUID i per-device budget.
Source-only regresje rozszerzono o phase owners, resource substitution,
prep/solve shared sums, immutable proof i replay. Nie kompilowano testów.
Kontrole źródeł nowego fragmentu pozostają oczekiwane; poprzednie PASS dotyczą
wyłącznie zapisanej wyżej wersji. Service config i CLI scheduler wiring,
inventory/topology, policy lifecycle/drain i runtime recovery pozostają otwarte.

Freeze typed-owner fragment:
host_resource_ledger SHA-256 cc287b575bb5e640fc58c6372b7b785dd30d4dc7162b1ac30ba689982428c990;
host_allocation SHA-256 317a1f202a9e2652bd459fdd6755f23afc15ffc242daa6028c68a2078f706ddc;
scheduler SHA-256 16fbc09220fce362b1899002011953d9dc1d4b16486fc13d00306e73ff3c3438.
Focused format/diff PASS. Review poprawił sprawdzenie host identity/budget
przed mutującym preparation finalizer, Released replay przed finalizer oraz
immutable proof publication z odmową overwrite/read/metadata errors.

Managed API source check nie wystartował: Storage busy, wrapper exit1 /
recipe exit2, bez receipt/kompilacji. Lock token c8bb405c709e4bddb232216d7b231c68,
PID 99336 python.exe potwierdzony jako żywy w OS; nie zatrzymywano procesu,
nie obchodzono blokady i nie zmieniano target/cache. Nowe API/CLI source gates
są NOT VERIFIED do zwolnienia wspólnego zasobu. HEAD
99b829704caca663808c7484cd6b928ddfb26584; goal active, service cap=1.

### E2 — konfiguracja v2 i typowany backpressure: bramki źródeł

Dodano RuntimeServiceHostExecution/Placement i optional host_execution w
RuntimeServiceConfig. V1 pomija nowe pole, ma cap1/1 i zachowuje trwałe reuse
APPLICATION.json; v1+binding/v2 bez bindingu są błędami. V2 przypina policy,
root, role caps i exact placement maps z limitami CPU/RAM/scratch/per-GPU VRAM.
Nie zapisujemy migracji ani nie wykrywamy topologii przy walidacji. Source-only
regresja porównuje serializer v1 z legacy field layout; nie kompilowano jej.

HostRuntimeAdmission otwiera już istniejący exact ledger bez initialization/
fallback. Scheduler adapter sprawdza pełny typed config digest, store, pool,
role i cap. HostTaskPlacement jest aliasem wspólnego session DTO. Service
start v2 ma jawną odmowę do podłączenia CLI schedulerów/supervisorów/lifecycle;
nie ignoruje nowych limitów i nie podnosi concurrency aktywnej usługi.

Try solver/preparation admission zwraca None dla contention nowego provisional
request przed publikacją. Candidate jest odrzucany w pamięci; nie jest to
rollback nieznanej durable publikacji. Ready task zostaje queued bez claimu
i Prepare/Start. Read/identity/digest corruption, stale fence, overflow lub
unknown publication pozostają błędami. Source-only regresja rozdziela capacity
wait bez zmiany snapshotu od corruption. Local prep None po durable tentative
nadal wymaga reconciliation. Nie kompilowano ani nie uruchamiano Rust tests.

Nowa managed recepta check-api-service-source obejmuje wyłącznie produkcyjne
API, runtime-service i oba schedulery. Pierwsza próba została odrzucona przez
explicit shell allowlist, bez kompilacji; dodano dokładną trasę, bez fallbacku.
Python AST/just parse PASS; istniejące interpreted wrapper checks 2 PASS/exit0
potwierdzają odmowę unknown route oraz wykluczenie testów z CLI source route.

Managed API/service a13528ef17e445d88ab6d98941d8029c PASS/exit0/source unchanged,
digest 4abb35d24f0c89adb6775beda3f24ef7e0912efcba053cecd6208c6459c26d0d.
Managed CLI e4e22fa35b684e9f9d4d414f8ef16f54 PASS/exit0/source unchanged,
digest cc0d1b400f6427981465b50899d3903daeeec94722fba01da4691e487986cd80.
Owned sources i service guard ponownie porównano z API receipt: identyczne.
Aktualny HEAD 7214071e8630ee1f859f57b9438e621442d2be31 pochodzi z obcego
documentation-only commita Windows; nie zmienia sprawdzonych źródeł zadania.

Final SHA-256: host ledger 0069bab6f58186745d391adfb5ff8fe6469b19375be73e40ad62e285fd345a7e;
service host config 5a98ed647039052d04aa7e3970cbe30f074fd70ddeb1853dead9744530507963;
service config 011401509111a3545e7a8ad6704209b6e31c2668300860a204e99e4ab5564272;
host allocation ee43414f10225fe7f92bed6129057107142575d117fadaf8a34dc6aba899a2bd;
host runtime db7b58c5c2e9a2c11b43a554a785959bb8ee8af8d1a9ffff697bc8785a9d526c;
claim ce4eaf2ec369cea35ebb682ff6be7646fb6692d1b87d34c9e711acf93ecfc05b;
scheduler 4465577fa8f225ba197671c4dac98c31d45d831244a529c0647d6b01170f0525.

Goal active. Kolejny krok: rzeczywiste CLI/service wiring obu schedulerów,
release/recovery w supervisorach i wiązanie GPU worker visibility z explicit
placement. Następnie owner/policy lifecycle, topology/freshness, no-spawn/
tentative reconciliation oraz wymagane runtime gates. Brak odbioru E2/E3–E7;
nie ma dowodu równoległego runtime ani kwalifikacji GPU/fizyki.

### E2 — połączenie CLI schedulerów i supervisorów

Oba schedulery czytają sparowane --host-service-config/--host-config-sha256
przed mutacjami. Pełny typed digest, store/pool/role/cap i exact offers są
sprawdzane; compute host mode wymaga pool discovery bez custom override.
Ready i admission nie mogą poprzedzić walidacji poola. Legacy bez flag zostaje.
Context przechodzi do każdego supervisora, także preparation recovery.
Przejrzano lock order: preparation recovery transaction jest zwolniona przed
host admission; validation pool jest pure i nie pobiera host lock.

Supervisor przed spawn wymaga exact Committed request (identity, policy fence,
budget, CPU IDs, GPU UUID/VRAM). GPU child visibility bierze explicit placement,
bez parsowania labela w host mode. Worker exit i retry recovery używają
durable exact receipt + Released lease dla host release, również po terminalnym
Err. Active lease po ambiguous effect pozostawia quarantine; retry recovery
bez exit proof jest błędem. Cancel przed spawn nie fabrykuje exit receipt:
host pozostaje quarantined do przyszłej durable no-spawn reconciliation.

Preparation finalizer jest wykonywany przez host release pod host→store lock,
z zachowaniem rzeczywistego disposition. Usunięto okno między local readiness
a host proof publication. Pierwszy host release po awarii, gdy local lease już
Released i task zdążył przejść do queued/solve, wymaga exact launch+exit proof
i nie uruchamia starego finalizatora przeciw późniejszej fazie. Host Released
replay nadal porównuje niezmienny proof. Service command builder przekazuje
config path/digest i role caps, lecz startup v2 guard nadal pozostaje.

Managed API/service c388ebd8015a49c884d29d33fbfdaf3d PASS/exit0/source unchanged,
digest 857fd11645a7547e0564ee8f7c1f22ab8f4f5e57bc624a2aed25a8c74eea8c00.
Managed CLI 2ffb43f24eef4f739df27090dde3edee PASS/exit0/source unchanged,
digest 7796ec38c3bbd50b0dfe72b8e5eb2e4563007c6d9f341bdfe7e15612eadc497c.
Focused format/diff PASS; nie kompilowano Rust unit tests, nie uruchamiano
solverów/buildów native ani nie zmieniano aktywnego workspace.

SHA-256: compute scheduler 83c5ffc1b4f250e9d4b0bb01e7d132801a3f6159cf05c74cc64fc79ef34acf57;
prep scheduler 779e3ede07daa11b567e94ad05af5ba645a0af92d6d3a0d701d95f5c81ded949;
worker supervisor 24093b9e38a0c6b9058473ccf380117578463a4ebcb704abab94ff347db95923;
prep supervisor d1e91d717b00d4f2565879690499e79ecedff83cc95a76713496d98dc4524807;
service 83a2016eb2ef0a174fa91473750a439e0bb5555db7a4e57ca9ebb7b3831c129a;
host runtime 4c3d131a764406b541fb1526ee28c1338db8b540ae5304f301aa59a4d6ee51ba;
ledger 2318edc5ce92291fe023b7ee5f1cd330c2ccd3b2ba4108663a85d6405353dee8.
HEAD 7214071e8630ee1f859f57b9438e621442d2be31; shared master, bez nowego
worktree/task staging/commit/push. Goal active.

Otwarte przed startem v2: durable no-spawn/claim reconciliation, całe recovery
po partial publication/queued retry, owner/policy lifecycle, topology/freshness
oraz runtime gates. Następny contract audit sprawdza per-step GPU UUID/count
i CPU placement intents względem rzeczywistej oferty; sama zgodność CPU/GPU
plus minimum budget nie dowodzi respektowania tych szczegółowych selectorów.
E2/E3–E7 nie są ukończone; brak runtime/OS enforcement/GPU/physics qualification.

### E2 — recovery potwierdzonego local release przed wyborem oferty

HostRuntimeAdmission.reconcile_released_store_reservations uzgadnia tylko
canonical store ID, nonreleased host records, exact już Released local lease
oraz jedno matching durable typed exit receipt. Solver owner/epoch i prep
process attempt, resource/token/heartbeat są scope'owane; ledger ponownie
sprawdza cały proof/budget pod host→store lock. Receipts cache per run na pass.
Active/missing lease lub brak exit proof pozostawiają hold. Multiple matching
proofs/corruption pozostają błędami. Task może już być queued po retry lub
prep, więc recovery nie opiera się na obecnym lifecycle/attempt w catalogu.

Oba schedulery wykonują ten pass przed następnym wyborem. Preparation robi
to przed lokalną recovery transaction, bez store→host lock inversion. Dodano
source-only regresję missing local lease nie zwalnia host reservation; nie
kompilowano ani nie uruchamiano tego Rust testu.

Managed API/service fd7585cc17d14651b2d2aac94e3ccab3 PASS/exit0/source unchanged,
digest 277c09e6df0735b9d16418e7eeed9add21c03112cde619b76a3b1b8fd4ec4e5c.
Odbiór dotyczy czterech production bins i zmienionej shared library; brak
runtime/solver/physics qualification. Scoped format/diff PASS, HEAD
7214071e8630ee1f859f57b9438e621442d2be31, goal active.

Read-only selector audit potwierdził pełny intent w compute_resources i
execution_materialization immutable ProblemIR. Scheduler/host allocation
sprawdzają lane+minimum budget i configured placement, lecz typed GPU request,
distributed mode i non-Auto CPU placement/native/BLAS policies są już wcześniej
blokowane przez planner. Nie stwierdzono reachable UUID-selector bypass dla
tych zablokowanych forms. Numeric CPU threads są reachable, zachowane w
runtime_selection.cpu_threads i wymagają minimum CPU >= threads*1000 w RunSpec
validation. Planner gates pozostają do matching/enforcement/qualification;
nie usuwamy ich dlatego, że powstał ledger. Legacy cuda:N nuance jest jeszcze
oddzielnie badany. No-spawn/claim recovery, owner/topology lifecycle, OS/runtime
gates i cały zakres E0–E7 pozostają otwarte; startup v2 nadal guarded.

### E2/E3 — zachowanie tożsamości legacy CUDA ordinal

Audit wykazał reachable `cuda:N`: generic lane matching pomijał indeks,
a UUID mask z lokalnym FDM ordinal 0 mogła zmienić intencję. FEM mógł
odziedziczyć inny index albo próbować użyć N wewnątrz pojedynczej maski.
Tymczasowy zakaz wszystkich indeksów zastąpiono ścieżką frozen import binding,
zgodną z sekcją 6 specyfikacji. Nie interpretujemy N w numeracji schedulera.

Importer Python zapisuje `legacy_cuda_binding.v1`: ordinal, observed inherited
mask i CUDA v2 UUID, albo jawny błąd rozpoznania bez CPU fallbacku. Host matcher
wymaga exact schema/ordinal, pełnego canonical UUID, obecnej widoczności i
membership w physical policy. Inna skonfigurowana oferta jest pomijana przed
local queue/claim. Zmiana kolejności obecnej enumeracji nie zmienia bindingu.
Brak/nieudany binding starego indeksowanego wejścia wymaga jawnego wyboru GPU.

Nowa natywna sonda runtime-control ładuje system CUDA Driver API bez nowych
zależności, contextu ani zmiany środowiska. Wymaga UUID v2, bounds count do256
i odrzuca duplicate UUID/errors. Sam prefix GPU przy UUID bytes nie dowodzi
physical/MIG realization: autoryzuje wyłącznie exact physical-policy membership.
Host context cache'uje obserwację; przed spawn rewaliduje immutable input i
Committed placement. Child FDM/FEM ma exact single UUID i local index0.
Dodane regresje Rust pozostają source-only, bez kompilacji/uruchomienia testów.

Managed API/service `2a9e9c63baa34dfa9a0f518daed6175f` PASS/exit0/source unchanged,
digest `6ac8aaff8c4aceb4a5854d9303de3b02bcddd1e5d3c50c9c4616df023633c9f4`.
Po run potwierdzono current hashes sześciu zmienionych Rust implementation files
zgodne z receipt. HEAD `25379fe8084bfa58481326b6ccc095430f2a1537` to zachowany
równoległy commit Windows storage. Scoped format/diff PASS.

CLI `142ca78255614d0e8acdc86df410c2a8`: compilation exit0, lecz source_changed;
wynik nie jest gate PASS. Zmieniał się foreign
`crates/fullmag-cli/src/control_room/development_workspace_probe.rs`.
Kolejny CLI `6ded3d6054b2416094bd0ef6b50de40d` failed/exit101/unchanged source:
w tym samym foreign pliku E0282 line280, E0061 line349, E0596 line746 oraz
lifetime error line926. Plik pozostawiono właścicielowi równoległej pracy.
API/service pass nie jest zastępczym odbiorem CLI. Python focused tests 13/13
PASS oraz trzy istniejące compatibility tests runtime selection/Simulation
3/3 PASS. Przypadki obejmują mask drift, cached repeat, fork identity, bounds,
duplicates, brak UUID v2 symbol i niedostępny driver bez CPU fallbacku.
Read-only live importer observation: ordinal0, observed mask=null,
UUID `GPU-fcb9fbf1-8284-37c7-af5b-76bcbf2d2937`, bez resolution_error.
To jest inventory observation, nie dowód solver execution/GPU qualification.
Parent potwierdził final current hashes:
problem.py `b1f135d2543f0be1520c0d1953623c5edab10336f907fe6f6526d9604d06ec4d`,
Python helper `9e8879bd5aea316ba5a781ac3cb520381978ca5d07fbaf97dd97527a48337d37`,
test `d1fceed7d5edf0f87877c4900c41a82148a8a8457b35876dc90051dc20e63590`.

Po kolejnej zmianie foreign pliku ponowiono CLI gate na aktualnych źródłach:
`d64ea1a7e1474e39aee1dcbb32b39b9c` failed/exit101/source unchanged,
digest `4db87fda1f68425f04362ef53847be0ac6cf5b2e609421303715792dc8241a01`.
Nadal cztery błędy w development_workspace_probe.rs (type inference,
argument count, mutable borrow, lifetime). Nie ponawiamy tej niezmienionej
porażki bez następnej konkretnej zmiany. CLI pozostaje NOT VERIFIED.

E2/E3 pozostają nieukończone: no-spawn/partial admission reconciliation,
owner/policy lifecycle, NodeSnapshot freshness, pełne OS enforcement i runtime
gates. V2 startup guard pozostaje. Nie uruchamiano solvera, nie kwalifikowano
GPU/MIG ani fizyki; cały goal E0–E7 nadal active na shared master, bez nowego
worktree/task staging/commit/push.

### E2/E3 — bramka startu i dowód anulowania przed spawn

Solver admission zapisuje w lease `host_launch_binding.v1` (exact ledger root
i policy); binding należy do identity fence, bez zmiany JSON starego v1 przy
None. Host reservation ma optional launch gate. Nowy solver otrzymuje Pending,
preparation nie otrzymuje solver gate, a brak pola w starym rekordzie nie jest
automatyczną migracją do Pending.

Supervisor pod host→store lock wymaga exact active bound lease, Committed host
record i current Preparing/Ready task z identyczną attempt/epoch/resource,
następnie trwale zużywa gate przed process creation. Token nie jest ponownie
wydawany przy replay. Worker odczytuje host binding z durable lease, sprawdza
permit na wejściu i przed katalogiem próby; pominięcie argv nie daje downgrade.
GPU sprawdza exact pojedynczy UUID mask i oba backend local indices=0.

Pre-start cancel zamyka tylko niewykorzystany Pending pod host→store lock,
publikuje Stopped i local release, a host release wymaga content-addressed
WorkerNoSpawn proof z Closed i exact Released bound lease. Proof publikowany
przed host Released jest rewalidowany na każdym read. Scheduler uzgadnia
Closed+Released lease po awarii publikacji host proof. Consumed, absent lease,
brak Started lub brak PID nigdy nie stanowią dowodu no-spawn.

Managed API/service `f69bac6d4d044a0dad0b8b31bce253fe` PASS/exit0/source unchanged,
digest `462e163d68f83f2ec80508ea02c86d89ce3f5d352ca5862a2ffa2e127f920fc0`.
Trasa obejmuje teraz pięć production bins: API, service, compute scheduler,
accepted worker i preparation scheduler, bez Rust test targets.
Focused format/diff i parser managed route PASS. Regresje binding/legacy JSON
oraz no-spawn Closed/Released/fencing zostały dodane wyłącznie jako źródła;
nie kompilowano ani nie uruchamiano Rust tests.

CLI `b735eeab6dcc42e3a992c37cf721e474` failed/exit101/source unchanged,
digest `c1ae23af125e8144700ad90f098d541303caae661f8ca11a19b522d5e569a445`:
foreign development_workspace_probe.rs ma E0282 line311, E0502 line529,
E0596 line877. Nie przejmowano równoległej pracy i nie uznano CLI gate za PASS.

E2/E3 nadal wymagają pełnego recovery po partial admission bez local lease,
awarii po Consumed/przed spawn, preparation no-spawn, owner/policy lifecycle,
NodeSnapshot freshness oraz OS/runtime gates. Startup usługi v2 pozostaje
guarded. Nie uruchamiano nowych procesów solvera ani nie kwalifikowano GPU,
fizyki lub równoległego wykonania. HEAD
`25379fe8084bfa58481326b6ccc095430f2a1537`, shared master, bez nowego worktree,
task staging/commit/push; pełny goal E0–E7 pozostaje active.

Bounded niezależny przegląd wskazał jeden konkretny problem: typed Worker
exit proof nie wykluczał Closed gate. Poprawiono wspólny validator release/read:
Closed nie może przyjąć Worker proof, a nowy bound lease wymaga Consumed.
Regresja źródłowa rozróżnia Closed no-spawn od Consumed process exit.
Legacy unbound exit proof pozostaje kompatybilny. Przegląd nie znalazł innych
actionable błędów w badanych ścieżkach i potwierdził host→store lock order;
nie był runtime qualification. Końcowa bramka po poprawce:
`7381663fcbc64e098399f50fd8213357` PASS/exit0/source unchanged,
digest `9a46bf37fe2e2b0e32cc3f9aec4b423f3cc488a68f5d0876b286c80058537ce5`.
Current hashes sześciu implementation files odpowiadają receipt; doc diff PASS.

### E2 — targeted replay częściowej local admission

SessionStore.read_task_admission i reconcile_task_admission odczytują/replayują
wyłącznie exact run/task/attempt, z limitem metadata 1 MiB i typed identity.
NotFound jest odróżnione od corruption/IO failure. Replay korzysta z istniejącej
projekcji admission pod native store writer; sibling intents nie są uruchamiane.

HostResourceLedger.reconcile_solver_admission pod host→store lock wymaga
Tentative/Pending, canonical store ID, exact persisted binding/identity/budget,
następnie odtwarza local claim i potwierdza active lease oraz current ready
Preparing/Stopping ownership. Promuje wyłącznie zgodny rekord do Committed.
Missing intent, superseded i unavailable claim pozostawiają hold. Nie ma
nowej próby/tokena ani synthetic rollback. Oba schedulery wykonują pass przed
wyborem ofert i recovery Released records.

Managed API/service `3cd445186c9e4f37a1e838d9fedfdfbd` PASS/exit0/source unchanged,
digest `458e2c2bbb82ca9eda56adf4117ea0f3c6fc60d23fc46a66de3007a3fae91f5d`.
Pięć current implementation hashes odpowiada receipt; format/diff PASS.
Targeted replay/missing/corrupt/identity/sibling regressions oraz host missing
intent hold mają wyłącznie source code; Rust tests nie były kompilowane.

Trace ujawnił kolejną lukę: accepted queue obejmuje tylko Accepted lub unclaimed
Queued, więc po samym przywróceniu allocation zadanie Preparing nie trafi
automatycznie do supervisora. Implementacja host-aware resume Prepare/Start
jest rozpoczęta i jeszcze nie ma końcowej source/runtime bramki. Istniejący
Prepare ma zachować persisted ResolvedTaskInput, a bootstrap bez niego może
korzystać tylko z automatycznie rozwiązywalnych inputs i current Pending grant.
Consumed/Closed oraz niejednoznaczny inbox nie mogą uruchamiać solver replay.
Allocation-only pass nie jest odbiorem handoff ani E2/E3. Goal E0–E7 active,
startup v2 guarded, shared master bez worktree/task staging/commit/push.

### E2/E3 — host-aware resume Prepare/Start

Wdrożono resume_next_admitted_accepted_task_with_host dla exact istniejącego
Preparing/Ready claim na danym resource. Selector potwierdza admission identity,
budget i pinned host binding oraz current Committed/Pending launch gate.
Bootstrap genesis wymaga braku genesis/watermark/journal tej próby. Existing
Prepare/Start są authoritative i nie dostają nowych envelope IDs lub inputs.
Brak Prepare używa wyłącznie original automatic-input predicate i read-only
resolver z claim-bound validation, bez zgadywania manual overrides.

Inbox jest odzyskiwany; pending readonly Prepare może zostać zwalidowane i
confirmed, a pending Start pozostaje exact handoff. Prepared event ma stable
attempt ID i next durable sequence. Applied Start, divergent envelopes albo
missing inbox po durable Start pozostawiają ambiguous state jako błąd. Helper
nie wykonuje solvera i nie tworzy nowej próby/tokena. API compute scheduler
wybiera recovery przed unclaimed queue, w granicach cap/drain; recovery nie
przesuwa cursor ani nie jest nowym admission.

Scoped rustfmt/diff PASS. Production source gate końcowego handoff jest
NOT VERIFIED: managed route odmówiła startu z powodu zajętej blokady storage.
Potwierdzono live PID 104220, a następnie nowego ownera PID38616, token
cdcb5ed0a19e465d9c10ee50dd3529f7, started2026-10-05T21:40:46.557266+02:00.
Nie zatrzymywano ich i nie używano alternatywnego target/cache. Wcześniejszy
3cd445... PASS dotyczy tylko targeted admission przed zmianami handoff;
nie jest odbiorem aktualnych źródeł. Rust tests nie kompilowano ani nie
uruchamiano solvera. Następny krok: po terminalnym ownerze ta sama managed
source route, naprawa ewentualnych błędów, następnie dalsze recovery/gates.

Stopping/Consumed, missing admission, preparation no-spawn, owner/policy,
topology/freshness, OS enforcement i runtime nadal otwarte. Startup guard
v2 zachowano i zaktualizowano jego komunikat do rzeczywistych bramek. Goal
E0–E7 active na master, bez nowego worktree/staging/commit/push.

Po zakończeniu ownera PID38616 potwierdzono terminalny released record i brak
procesu, następnie uruchomiono końcową managed source route. Wynik handoff:
`29e2017b43d0419784e58167fa08d2f1` PASS/exit0/source unchanged,
digest `393e4c3a726f7614823dab142222d08a14ecf947bc300fc6edaf018f48116af3`.
Siedem current implementation hashes odpowiada receipt. Odbiór nadal obejmuje
wyłącznie pięć production source targets, bez compiled Rust tests i bez
uruchomienia solvera. CLI nie uzyskało końcowej bramki: nowa managed próba
odmówiła startu przy live owner PID101140, token046f789b2f3f42b7b3f0e1e8c7d8e274.
Niezależny przegląd handoff trwa; pełny E2/E3 runtime odbiór i goal E0–E7
pozostają otwarte, v2 startup guard pozostaje.


### Korekta trwałości wejść przy wznowieniu handoff

Przegląd wykazał, że publiczna kolejka dopuszcza optional/manual inputs, których
nie można odtworzyć przez resolver z pustą mapą. Host admission otrzymuje teraz
kopię dokładnych wejść; recovery wymaga jej przy brakującym Prepare, rewaliduje
mapę i odrzuca rozbieżności. Istniejące Prepare jest porównywane z kopią, jeżeli
rekord ją zawiera. Legacy bez obu zapisów wymaga jawnej migracji.

Zmiana jest w trakcie integracji schematu/store/reachability. Production source
gate dla tej korekty: NOT VERIFIED; wcześniejszy 29e2017 nie obejmuje nowej zmiany.
Zakaz kompilowania testów Rust pozostaje zachowany.

Integracja types/store/reachability zakończona: optional snapshot zachowuje stare
JSON; replay wymaga identycznych wejść, live i archive walkers chronią referencje
CAS. Dodano source-only regresje hash/tamper/bounds/refs/replay-conflict, bez ich
kompilacji ani uruchomienia. Scoped rustfmt i diff-check PASS.
Managed `just check-api-service-source` odmówił startu przy aktywnej blokadzie:
PID106240, token e0011197543e4acd95428513f762da23, started 2026-10-05 22:10:56
(local). Bieżący proces python potwierdzony przez Get-Process. Kontrola
produkcyjnych źródeł tej zmiany pozostaje NOT VERIFIED; następny krok to ta sama
trasa po zwolnieniu zasobu. Nie tworzono alternatywnego target/cache.


### Kontrola kopii wejść i przerwanego anulowania

Domknięto gap Closed+Cancelled+active local lease: ledger pod host→store locks
weryfikuje dokładne Committed/Closed i current cancelled ownership, a następnie
kończy lokalny release. Runtime reconciler ponownie odczytuje lease i stosuje
istniejący immutable no-spawn proof. Consumed i inne fazy nie są zwalniane.

Managed API/service source check `f5c2e36eb5f246bbb5644844f7dbbda7` PASS, exit0,
source_changed=false; digest
`bd30b8563b548c3fd476928f36bee7548dd9de638305e6a9122badfe00fc79e4`.
Siedem implementation hashes odpowiada terminalnemu receipt. Zakres: pięć
production bin targets; Rust tests nie kompilowano, solver/runtime nie uruchamiano.
CLI source check trwa; niezależny przegląd recovery trwa. Pełne E2/E3 otwarte.

CLI source check `6873f160c8f1414da0aaf698562f0140` PASS/exit0/unchanged,
digest `29a0221f9a64cc8e87690ed0b926a55658e6a49b202f3fba8daaba18f44b3230`.
Bieżące hashy ledger/store/host_runtime zgodne z receipt. Behavior regression
dla interrupted cancellation zlecona jako source-only; compiled tests nadal
zakazane. To nie jest dowód runtime ani ukończenia E2/E3.

Niezależny bounded review Closed/Cancelled recovery: bez actionable findings; potwierdzono host→store lock order, exact ownership/binding, wykluczenie Consumed i pozostawienie Closed+Stopping do durable Stopped. Review tylko źródłowy, bez runtime proof.


### Wznowienie Stopping przed spawn

Dodano host reconciler dla current Stopping z Committed Pending/Closed, exact
lease/task/owner i coordinator journal bez Started. Zamyka niewykorzystaną
bramkę, publikuje durable Stopped; journal Cancelled+catalog Stopping naprawia
przez projekcję. Closed+Cancelled release i immutable proof używają istniejących
adapterów. Consumed pozostaje do positive process reconciliation.
Scoped rustfmt PASS. Source gate i niezależny review tej nowej ścieżki jeszcze
NOT VERIFIED; wcześniejsze f5c2e36/6873f160 nie obejmują tego dodatku.
Source-only behavior regressions poprzedniego gap w trakcie. Rust tests nie
kompilowano; E0–E7 active na master, bez worktree/staging/commit/push.

Managed production source gate Stopping recovery:
`1d773665143c4ea78cafd0f52c433f69` PASS/exit0/source unchanged, digest
`ea71fb0ed2b629f39066006abaa7899a348f55fc51a1b1e9cb62d1919c77cd07`;
current host_runtime hash zgodny z receipt. Independent bounded review nie
znalazł actionable correctness gap w race, fencing i replay. Scheduler używa
zewnętrznego retry_store_writer_busy wokół całego reconciler. CLI gate trwa.
Behavior regression nadal brak: poprzedni worker nie zmienił testów i został
ponownie ograniczony do jednego pozytywnego przypadku Closed+Cancelled.
Testy Rust pozostają nieskompilowane; runtime/scheduler restart fault injection
NOT VERIFIED. Nie oznacza to zakończenia E2/E3.

Review rozszerzony wykrył required correction: visible Stopped journal po
PublicationUncertain nie był reconfirmed przed terminal projection/release.
Dodano exact entry lookup/typed envelope match i replay
commit_coordinator_journal_entry, które confirmuje publikację. Poprzednia
bramka 1d773665 oraz CLI51dcf38c066741789286f98e7e6bbdf7 PASS dotyczą źródeł
przed tą poprawką; nowa API/service source gate trwa.

Po durability correction managed API/service source gate `d7da1ca0512e445bbb9e574681e711ce` PASS/exit0/unchanged, digest `5a65d1a9389869924621f6e4018eb1c736d0161c6acff89259362d32543a0aeb`. Current hash potwierdzony przed dalszymi test-only edycjami. Narrow re-review potwierdził reconfirm przed projection/release, bez dalszych findings. Source-only regression pozostaje w toku; compiled tests i runtime recovery NOT VERIFIED.


### Nieopublikowane admission — kandydat rollback

Dodano host→store locked positive certificate Ready/Queued/unclaimed exact next
epoch + brak admission/lease/journal/genesis. Immutable AdmissionAbsent proof
poprzedza Closed+Released; unknown/missing catalog pozostaje held. Review
wykazał potrzebę zachowania nowej próby: tylko validated AdmissionAbsent nie
zużywa epoch, stare identity/attempt nadal odrzucone. Source gate/review tej
nowej ścieżki NOT VERIFIED. Dodana regresja cancellation source-only w trakcie
finalnego formatowania; testów Rust nie kompilujemy.

Rollback source gate: first ecfa1ae failed E0624 (task validator private); visibility narrowed to pub(crate), no public API change. Final managed `4750df74bb1b4a1e9d28abed54ed329a` PASS/exit0/unchanged, digest `0d6bc3c01bf8f412686b57dd335dc77e1055702acaad65bc0968b8907099c63d`; three current hashes verified. Scoped rustfmt/diff PASS. Independent review confirms exact absent-intent certificate and non-consuming epoch exception with old identity/attempt fenced. Cancellation behavior regression added and source-reviewed, NOT COMPILED/NOT RUN per prohibition. Rollback regression and fault injection runtime remain open; E2/E3 and E0–E7 active.


### Preparation launch barrier

Dodano optional prep lease binding (default None dla legacy), identity check,
osobną host preparation gate i host→store authorize/validate. Scheduler zwraca
bound lease, supervisor po durable launch record consumeuje gate przed spawn
i przekazuje token; preparer sprawdza go przed native side effects. Bound exit
proof wymaga Consumed i pinned policy/root. Stare host records bez gate wymagają
migracji; v1 unbound zachowano. Startup v2 guard pozostaje.

Managed source gate `7189a1af16e844bebac80080926a6cab` PASS/exit0/unchanged,
digest `e5c0b8f40c355ed53723eeffecdfa58a6161959cdd48f8239cc39a3f8a443efc`;
siedem current hashes zgodne. Route rozszerzono do sześciu production bins,
w tym fullmag-api-accepted-fem-preparer. Scoped rustfmt/diff PASS. Compiled
Rust tests nadal zakazane. Rollback source regressions dodano i sformatowano
(queued exact/retry epoch1/old identity rejection, epoch mismatch held), NOT RUN.
Prep gate review i source-only exit regression w toku. Native/runtime/fault
injection NOT VERIFIED. E0–E7 active, bez staging/commit/push.

Prep barrier bounded review: brak false release lub lock-order gap. Znaleziono
legacy gate None rejection dopiero po local launch: naprawiono przez Pending
preflight przed publikacją, z atomic recheck/consume po niej. Gate po tej
korekcie trwa; wcześniejsze 7189a1af dotyczy sources before preflight.
Wciąż otwarty liveness gap local launch+Pending po crash: immutable launch ma
historycznego supervisor PID/start token, więc potrzebne explicit truthful owner
adoption; nie emitujemy nowych exit receipts podszywających się pod starego
ownera. Źródłowa prep exit regression dodana/sformatowana, NOT COMPILED/NOT RUN.

Final six-bin production source gate po preflight: `44b34a6cf9704ff7abbfe9c4eaddc296` PASS/exit0/unchanged; digest `a84448cdab1ba6109a74e6a0de15624b692ccf66345ec4e112422b45ebe92b3f`, current ledger/supervisor hashes zgodne. Runtime/no-spawn/owner-adoption nadal NOT VERIFIED; E0–E7 active.


### Przejęcie Pending preparation launch

Host consumed permit zapisuje actual supervisor PID/start token i original
launch ID/canonical digest. Historyczny local launch bez zmian; pojedynczy exact
Pending launch można odzyskać bez tworzenia drugiego. Authorization pod oboma
locks wyklucza related exit/preparation receipt, confirmuje launch replay i
atomowo zapisuje owner+Consumed. Worker sprawdza digest/identity, release proof
pinuje owner. Legacy replay nie otrzymuje tej zgody. Source regressions bound
exit rozszerzono o nową metadata; nadal NOT COMPILED/NOT RUN.

Managed sześć-bin gate `bd9da21feea1416b93df643bbe1e70e3` PASS/exit0/unchanged,
digest `abc94a8b127afc9e8e5d56b985a9ece07ec4e4da23973d379df993b86cb86a95`.
Current ledger/store/supervisor hashes zgodne. Scoped rustfmt/diff PASS.
Protocol design review zaakceptował mniejszy host-owned adoption record; final
implementation review trwa. Native/runtime/fault injection NOT VERIFIED.
Next: final review, source-only adoption regression, prep Tentative recovery,
no-spawn i Consumed/process owner lifecycle. Pełny E0–E7 active, startup guard v2
pozostaje; bez staging/commit/push.


### Preparation admission roll-forward i release provenance

Dodano exact Active bound lease recovery dla Tentative/Pending preparation
reservation: canonical store/identity/policy/budget/catalog i no prepared receipt;
confirm_publication lease przed Committed. Brak/released lease nie zwalnia
zasobów. Oba schedulery korzystają z istniejącego wspólnego reconcile loop.
Release przed local finalization porównuje sole original launch ID/digest z owner
i sprawdza bound ledger root. Independent source review obu korekt bez findings.

Managed six-bin gate `9561d1849867433f9f7dff2566537a9e` PASS/exit0/unchanged;
digest `25e64dd865c292f3ef156c382c849f34db562afb3946a8bbb0453bd6e3c3726d`.
Current ledger/host_runtime hashes zgodne. Scoped rustfmt/diff PASS. Real-API
source adoption regression dodana (original launch unchanged, owner/PID/digest,
missing start token, correct/wrong token, duplicate consume). NOT COMPILED/NOT RUN.
Roll-forward source regression zlecona; runtime/fault injection, prep rollback
bez lease, no-spawn i Consumed recovery nadal otwarte. E0–E7 active/master.


### Preparation rollback przed local lease

Dodano positive accepted/awaiting-preparation certificate, exact Tentative/Pending
i brak lokalnych side-effect records pod host→store locks. Immutable
PreparationAdmissionAbsent proof przed Closed+Released; brak/mismatch/unknown
nie zwalnia capacity. Wspólny reconciler wywołuje tę ścieżkę, gdy nie ma local
lease do roll-forward. Gate najpierw odmówił zajętej blokady; potwierdzono terminal
released owner PID107064/token67946dae1f5c4ff6b8fb637ab3abe9c8 przed kolejną próbą.

Managed six-bin source `d36d27c368724259a5b016d69dea798f` PASS/exit0/unchanged,
digest `2af7271b1d2e7a15f438f7a8420cebf4224aaa9a450028b5420cbda4c5d3a75a`.
Current ledger/host_runtime hashes zgodne. Rustfmt-check PASS. Source-only
roll-forward crash/wrongbinding regressions dodane, NOT COMPILED/NOT RUN.
Rollback review trwa. Runtime/fault injection, preparation no-spawn i Consumed
recovery pozostają otwarte, podobnie pełny E0–E7. Startup guard v2 zachowano.

Review rollback wykrył required correction: catalog-based solver lease lookup
nie wykrywa orphan Active lease dla Accepted/Queued task. Obie ścieżki rollback
używają teraz raw bounded scan run/resource_leases, niezależny od catalogu,
z path/schema/link checks. Tylko genuine NotFound oznacza brak katalogu; inne
IO/access errors blokują absence proof. Prep active-lease enumeration również
odróżnia NotFound od innych directory errors.

Source `395fbc365aca4028a42c5f09c1061683` PASS przed ostatnimi directory-error
korektami. Końcowy source gate odmówił startu przy live owner PID70588,
token862a07401a8040ef8a3b3b69e922d277, oraz child powershell PID52520; obie
aktywności potwierdzono przez CIM snapshot JSON. Latest sources NOT VERIFIED.
Dodano real-API source orphan regression (catalog lookup None/rawscan true),
sformatowano; NOT COMPILED/NOT RUN. Master HEAD obecnie
`87deab6b6e2332b912e7e521e5b65df6e3df1ed7`, cudze zmiany zachowane.
Next: final source gate po terminalnym ownerze i narrow review absence scan.


### No-spawn release anulowanej preparation

Dodano hook host→store dla exact bound lease i unclaimed Cancelled task, także
przy crash przed host promotion. Pending/Closed + no actual spawn owner;
Consumed pozostaje held. Confirm catalog → Closed publication → local Released
confirmation → immutable PreparationNoSpawn proof → host Released. Raw orphan
solver/other active prep, prepared receipt lub exit blokuje release.
Public pre-preparation cancel API/UI nie są jeszcze odebrane.

Scoped rustfmt/diff PASS; latest source gate NOT VERIFIED — shared resource
pozostaje zajęty, obecnie live python PID63144, token0cba3b337a40435fa6a3ec4a7027a945.
Potwierdzony CIM JSON, bez zatrzymywania innych procesów. Review no-spawn w toku.
Dotychczasowe rawscan/source gates nie obejmują nowego hook; runtime, fault
injection i pełny E0–E7 nadal otwarte, startup v2 guard zachowano.

Po terminalnym released owner63144 potwierdzono brak jego procesu i uruchomiono
managed source gate. Final `1d5c11b35cc146c68eda2615891278e9` PASS/exit0/unchanged,
digest `1dc55b3715975c0fe3002e07270295af18b5894939ba07ac1928b71430417721`;
current store/ledger/host_runtime hashes zgodne. Receipt HEAD
`b16d00ee4273aa4884209dc670fb0e14bc1a5e9e` z mastera; cudze zmiany zachowano.
Zakres: sześć production targets, nie compiled Rust tests ani runtime.
Rawscan/no-spawn review w toku; source no-spawn regression oraz public cancel
producer/API/UI i dalsze runtime gates pozostają otwarte.

Dodano real-API source no-spawn regression: exact bound Pending + unclaimed
Cancelled zwalnia local/host jednokrotnie z Closed/proof; osobne Consumed fixture
z rzeczywistą authorization pozostaje Active/Committed bez release proof.
Parent rustfmt/diff PASS. NOT COMPILED/NOT RUN. Receipt1d5c11b35 dotyczy identycznego
production body przed test-only addition; compiled gate nie obejmuje wykonania
tych asercji. API contract pre-admission/preparation cancellation jest badany
odrębnie, bez zgody na dopisywanie fikcyjnego WorkerCommand/claim/epoch.

Narrow re-review potwierdził raw orphan scan oraz preparation no-spawn close/
release/proof order, bez concrete lock/replay/false-release findings. Review
wyłącznie source; nie zastępuje runtime. Public cancellation producer z safe
prelaunch i consumed/native-active boundaries jest kolejną badaną częścią E4.


### Trwały intent anulowania przed admission — integracja w toku

Osobny rekord task_cancellation_intent.v1 zachowuje żądanie i snapshot zadania
bez fikcyjnego claimu ani WorkerCommand. Implementacja modułu store jest w toku.
Parent dodał blokady NEW solver/preparation admission po zapisie intentu;
exact wcześniej zapisany admission/aktywny preparation lease może być odtworzony.
Oba host launch permits sprawdzają intent pod blokadami host→store przed
konsumowaniem pozwolenia. Anulowanie nie zwalnia samo capacity i nie zmienia
Consumed na Pending. Retencja pack/live/archive obejmuje osobne płaskie rekordy.

Scoped rustfmt/diff PASS. Dodano source-only regresje NEW admission vs prior
durable replay oraz preparation lease replay; NOT COMPILED/NOT RUN. Latest
production sources NOT VERIFIED, moduł intent oraz scheduler/API/UI integration
pozostają otwarte. Receipt1d5c11b35 nie obejmuje tych nowych zmian.

Moduł intent zapisany; read/replay sprawdza istniejący root i exact wcześniejszy
admission dla późniejszego claimu. Scoped rustfmt/diff PASS. Managed six-bin
source `deb04235b05e4838868db34990dd9fc4` PASS/exit0/unchanged, digest `fde5e444fe50d58fba831a1dbb851d8797939e1b75e1a82df88955585a53503a`.
Current module/store/ledger/fms/reachability/lib hashes zgodne z receipt.
Receipt HEAD `1bdb48274050e66aabcb490b52873c5b9cc02f98` na masterze; cudze zmiany zachowano.
Dodatkowa source-only preparation spawn regression zachowuje Pending/Committed,
local Active i Accepted task po intent; wszystkie Rust regresje NOT COMPILED/NOT RUN.
Review cancellation integration trwa; scheduler/API/UI i runtime/fault injection
pozostają otwarte. To nie jest odbiór pełnego E0–E7.


### Zastosowanie cancellation intent w schedulerach — integracja w toku

Dodano run-scoped bounded list intentów, early host admission guard przed NEW
rezerwacją i project_unclaimed_task_cancellation pod host→store writers.
Unused prep gate jest Closed przed catalog Cancelled; release/proof pozostaje
w istniejącym no-spawn reconcilerze. Consumed/Quarantined/unknown owners oraz
orphan local leases pozostają held, bez zmiany Accepted. Po normalnej
finalizacji i proof-backed host release intent może anulować zadanie przed solve.
Oba schedulery wykonują dispatch intentów; exact prior solver admission naprawia
się, a Start handoff otrzymuje real Stop zamiast spawn. Missing Start pozostaje
w istniejącej ścieżce recovery; Completing nie jest nadpisywany Stop.

Review poprzedniej warstwy wykazał hostless supervisor guards i future catalog
revision validation w archive/live: obie korekty wprowadzono. Scoped source
regresje obejmują brak NEW reservation, Closed→Cancelled→proof release oraz
Consumed zachowujące Accepted. NOT COMPILED/NOT RUN. Latest production source
NOT VERIFIED: gate odmówił shared lock PID88116/token46b0e52999094754b3f2116c7ea868f7;
CIM potwierdził live python88116 i child powershell86924. Nie zatrzymywano procesów.
Public API/OpenAPI/UI, runtime/fault-injection i pełny E0–E7 pozostają otwarte.

Dodatkowa ochrona: projection sprawdza exact task_admissions folder i odmawia
Cancelled przy wcześniejszym nieuzgodnionym published admission. Runtime nie
replayuje zbiorczo historycznych admissions; używa istniejącego exact host
recovery. Scoped rustfmt-check PASS. Shared lock zmienił ownera na live
python107500/token d03001dca35a4f32ad92ddf05713f461 (CIM potwierdzony).
Latest scheduler sources nadal NOT VERIFIED, bez nowej próby ciężkiego builda.


### API/OpenAPI/UI cancellation intent — 07.10.2026

Po przerwaniu potwierdzono zapis review fixes: exact pre-bump task snapshot
w archive/live oraz real admission Stop po genesis, przed nowym Prepare/Start.
Dodano API optional cancellation_id+expected_catalog_revision (obie albo żadna),
wersjonowany Requested response bez command_id i optional task cancellation
summary. Legacy Stop zachowuje wire shape i wcześniejszą walidację reason.

Managed six-bin source `982697d51c274fc6a26e0bd714623d3e` PASS/exit0/unchanged,
digest `584024960a562d366ee238e6ddbdc3e6d0c8fad8dbd3d15cecb92fa0180bcc6e`, HEAD
`2a3d9722649e4df0f034bdaaf63c50786fbe496f`. Managed OpenAPI gate
`1803cbc855fe4e138557dc99c11a85d1` PASS/exit0/unchanged, digest
`6cacab8bc7cc9f978a83d122cf8db5b0410b870a32cc28432395043f011d423f`; wygenerował
kanoniczny openapi-v2.json. Types/client regenerated właściwymi skryptami pnpm.

Review znalazł outer writer busy→500: poprawiono na map_run_store_error/409
run_store_busy. Pure intent.validate_task_scope chroni task readmodel, bez
mutacji na GET. Osobny run_task_cancel_revision_conflict oznacza jednoznaczne
odrzucenie NEW żądania sprzed publication; inne/unknown wyniki zachowują retry id.
Te późniejsze backend poprawki NOT VERIFIED: source gate odmówił shared lock
PID35220/tokenb901e049c8744762a5ea1f2f52e9013d, live Python + fullmag37204 i
node141404 potwierdzone CIM. Nie zatrzymywano zasobów ani nie tworzono fallbacku.

Control Room oferuje Cancel dla Accepted/Queued/Preparing/Running, pokazuje
recorded cancellation jako requested dla nonterminal task, zachowuje request
id/revision przy niepewnym wyniku i odświeża owning resource po błędzie.
Typecheck końcowy PASS po naprawie błędnego invalidate bez revision. API hygiene
PASS. Vitest 2 pliki/6 testów PASS: original retry po transport failure, fresh id
po potwierdzonym revision conflict, legacy Stop oraz resource ownership.
React Doctor changed scope: 3 pliki, 100/100, brak findings.

Browser/endpoint/runtime/fault-injection NOT VERIFIED. Rust tests nie były
kompilowane/uruchamiane. OpenAPI schema pochodzi z green gate sprzed późniejszych
behavior-only review fixes (shape unchanged). Latest backend gate i pełny E0–E7
pozostają otwarte; startup v2 guard zachowano.


### Odbiór poprawek backendu i ograniczony browser proof — 07.10.2026

Po terminalnym released owner35220 wykonano production six-bin gate
`de5e7b6a7b424e8fb1c38d1f0d9d386e` PASS, lecz późniejszy hash handlera nie
odpowiadał receipt (nie tylko EOL). Nie przeniesiono tego wyniku na zmieniony
plik. Powtórzony gate `9e991e41e25944b7bd9190a5528fd07b` PASS/exit0/unchanged,
digest `54c3a1f0c26ae9014c02ab8205cd1da32954a590c370cbca4a6abf198fa1e6cb`,
HEAD `c6b8e4f08be06e39a7e3855bc01f72dcce1a6f26`; aktualny handler hash zgodny.
Poprzedni de5 gate miał zgodne pozostałe ledger/store/runtime/reachability files.
Rust testów nie kompilowano.

Browser tab2 na port3258 potwierdził Compute environment i Settings,
rozdzielenie unavailable GPU telemetry od no GPU oraz profile draft/Cancel:
po ID compute-draft-check/CPU4 i Cancel nadal 0 versions/catalog revision0.
Nie zapisywano profilu ani nie modyfikowano modelu/aktywnej sesji. Szczegóły:
[browser-check-20261007.md](browser-check-20261007.md). Podgląd był na starszym
backendzie innego zadania; nie dowodzi nowej cancellation API ani solvera.

Poprawiono tylko tekst Settings Inspectora sugerujący immediate apply;
scoped diff PASS, render tej ostatniej zmiany NOT VERIFIED, bo owner zamknął
frontend przed kolejną obserwacją (connection refused). Nie restartowano usług.
API endpoint/browser cancellation/Apply, runtime/fault-injection i pełny E0–E7
pozostają otwarte. Startup v2 guard pozostaje.


### Natywny pakiet i rzeczywisty cancellation HTTP — 07.10.2026

Managed native build460bf2ca PASS/exit0, pakiet9776/manifestb4f69e4158693a7f1ae05c233baefb7d1a0b3f4aff1eb99a5ccf2284fece40fd
zweryfikowany existing identity validator. Rust tests nie kompilowano.
Dodano scoped fixture, fixed just recipe i Windows/64hex allowlist wrapper.
Pierwsza CLI fixture bez managed context FAILED/0 checks; poprawiono kontekst
z rzeczywistych metadanych pakietu. Ponowienie15bfd6c4c92046e5b5eac71f6abba5bd
completed/exit0/19checks: Accepted/Queued requested, idempotent retry, metadata
time, changed id, stale revision, malformed pair, real writer busy409, legacy
reason-only rejected i retry po cudzym task revision bump. Seeded fixture nie
dowodzi Submit, terminal cancellation, scheduler ani solvera. Wszystkie własne
procesy waited/reaped; CIM potwierdził brak, pusty API został terminate.

Native canonical OpenAPI imported z receipt/commit/snapshot checks; types/client
regenerated. Final TypeScript i API hygiene PASS. Szczegóły i ścieżki dowodów:
[cancellation-http-check-20261007.md](cancellation-http-check-20261007.md).
Full E0–E7/Apply/browser cancellation/OS enforcement/CPU-GPU runtime open,
startup guard v2 zachowano, master bez staging/commit/push.

### Readiness po końcowym anulowaniu — 07.10.2026

`accepted_run_has_scheduler_ready_task` po odczycie poprawnego intentu i katalogu
zwraca false dla pustego katalogu lub samych Succeeded/Failed/Cancelled/Interrupted,
bez ładowania immutable Study potrzebnego wyłącznie do niezakończonych zadań.
Zapobiega to błędowi odczytu kolejki po końcowym anulowaniu, gdy dane Study są
niedostępne. Pozostałe lifecycle nadal wymagają Study; błędy intentu/katalogu
nie są ukrywane. Dodano regresję z rzeczywistym SessionStore, obejmującą pusty
katalog, mieszane stany końcowe i wszystkie stany niezakończone bez assets.
Rust regresja NOT COMPILED/NOT RUN zgodnie z zakazem kompilacji testów.

Scoped rustfmt-check i diff-check PASS. Scheduler SHA-256
`6a59e88ba233eb047a8c6f536d21b97608ab890809b613c57e083c5de67e0583`;
HEAD `c6b8e4f08be06e39a7e3855bc01f72dcce1a6f26`. Production source gate
odmówił zajętej blokady: PID148396/token27d6d0bf33b442f3ba196749e0653dfa,
CIM potwierdził aktywny verifier innego zadania. Nie zatrzymywano procesu
ani nie wybierano zastępczego targetu. Najnowsza poprawka source/runtime
NOT VERIFIED. Cały zakres E0–E7 pozostaje aktywny.

Odczyt produkcyjnej ścieżki potwierdził brak initializer host ledger/config v2
w runtime ownerze. Szczegóły i następny kontrakt implementacji zapisano w
[scheduler-cancellation-gate-design.md](scheduler-cancellation-gate-design.md).
Sam scheduler obsługuje przypięty host config; pełny service start v2 nadal
jest chroniony istniejącym guardem. Raport nie jest dowodem wykonania.

### Przypięta inicjalizacja host application — 07.10.2026

Dodano produkcyjne `RuntimeServiceConfig::initialize_host_application` i wejście
CLI `runtime initialize-host-application --config --config-sha256`. Client
sprawdza kanoniczny typed digest przed otwarciem existing store. Session boundary
wymaga konfiguracji v2, exact store binding, startup guard i otwartej development
admission. OWNER.lock/OWNER.json/LAUNCH.json wykluczają inicjalizację; nie
zastępujemy recovery ownera oceną PID lub wieku.

Konfiguracja jest najpierw utrwalona przez istniejące for_application i dokładnie
porównana z kandydatem. Dopiero po zwolnieniu store writera inicjalizowany jest
host ledger. Ponownie przejęty launch guard i drugi odczyt rekordów chronią
ledger przed wyścigiem launchera; startup guard pozostaje przejęty. Błąd ledgera
zachowuje config do exact retry, częściowego ledgera nie odbudowuje. Wynik JSON
wiąże config/store/host/policy/epoch/topology i ma execution_available=false.
Nie zmieniono guardu startu v2 ani aktywnych pul i procesów.

Dodano 7 regresji SessionStore oraz 2 regresje client digest, wszystkie
NOT COMPILED/NOT RUN zgodnie z zakazem kompilacji testów Rust. Scoped rustfmt
check (skip_children=true) PASS/exit0, diff-check PASS. Odczyt pełnego main przez
rustfmt wykazuje wcześniejsze formatowanie dwóch niepowiązanych atrybutów args;
zachowano je zamiast rozszerzać diff.

Po zakończeniu owner148396 bramkę przejął verifier PID150368,
token2b7a0112b8d34dafbc11915ae9829fa5. `just check-cli-source` odmówił busy;
CIM potwierdził aktywny proces. Nie uruchomiono równoległego targetu ani buildu.
Najnowsza implementacja source/runtime NOT VERIFIED. Następny krok: dozwolone
kontrole CLI/service sources, native package i rzeczywisty initializer probe;
następnie dalsze owner lifecycle/topology/enforcement gates przed startem v2.
Cały E0–E7 nadal w realizacji; master bez staging/commit/push.

### Odbiór źródeł inicjalizatora — 07.10.2026

Po terminalnym zakończeniu owner150368 wykonano zarządzane kontrole:
CLI `fdeda604052d433c81896a44661d6dbb` PASS/exit0/unchanged, digest
`3f0c3e6f686a0df0c28df9218ed3ae05503aa8e7d46065fde098bed715be5acf`;
API/service/schedulers `eb034451076148bc8a4bd1bae725337d` PASS/exit0/unchanged,
digest `31eae6842227d3f36b88be64b5a50efb97384ce2907a09ae83b3641f3266b6a8`.
Obie kontrole użyły HEAD `1ee35b19e4a0e28da31ed5b9e52097d8b01919f8` na
współdzielonym masterze. Zmiana HEAD pochodzi z innej pracy; nie wykonywano
commita ani integracji w tym zadaniu. Hashe runtime_service, runtime client,
scheduler oraz CLI args/main odpowiadają receipt. Testów Rust nie kompilowano.

Przygotowywana osobna bramka natywnego inicjalizatora używa jawnej syntetycznej
polityki fixture, bez uruchamiania schedulera lub workerów. Ta bramka nie dowodzi
fizycznej topologii, lifecycle usługi ani egzekwowania przydziałów. Weryfikacja
pakietu i uruchomieniowa inicjalizacja nadal otwarte; startup v2 guard zachowano.

### Odbiór pakietu i rzeczywistego inicjalizatora — 07.10.2026

Native build `b417e9db3c904228852d66cfdab28998` PASS/exit0 po potwierdzonym
zwolnieniu blokady. Manifest `0d5df1073bba5900909e577e5809d5b9f8124375490ee09ad645f7ef78fbb2cb`
przeszedł istniejącą walidację tożsamości w managed preflight oraz końcową
kontrolę bramki. Scoped source files odpowiadają frozen snapshotowi f4198af9.

`just verify-compute-host-initialization <manifest>` completed/exit0/26checks,
receipt `6b7c3dfa0e1f4033a26e8b65e96e70c5`. Rzeczywiste CLI potwierdziło publikację,
exact retry, odmowę changed config/wrong pin/v1/partial ledger/owner metadata
i development admission fence. Wszystkie 20 CLI procesów waited/reaped, CIM
potwierdził brak. Git Bash syntax, Python AST, read-only Windows path helpers,
3 conflicting-scope refusals oraz scoped diff-check PASS.

Polityka/topology oraz owner/fence metadata są jawnie syntetycznymi wejściami;
nie dowodzą fizycznej topologii ani lifecycle. Nie uruchamiano usługi,
schedulera ani solvera. Testów Rust nie kompilowano. Dokumentacja:
[host-initialization-check-20261007.md](host-initialization-check-20261007.md).
Initializer runtime potwierdzony w tym zakresie; owner lifecycle, topology,
enforcement, scheduler terminal cancellation/release i pełny E0–E7 nadal otwarte.
Startup v2 guard zachowano; master bez staging/commit/push tego zadania.

### Recovery bez niepotrzebnego odczytu Study — 07.10.2026

`resume_next_admitted_accepted_task_with_host` odczytuje zwalidowany katalog
przed Study. Gdy brak Preparing/Ready taska z dokładnym resource ID oraz
attempt/epoch, zwraca None bez ładowania immutable assets. Rzeczywisty kandydat
nadal przechodzi wcześniejszą walidację Study, claimu, admission i host binding.
Regresja z rzeczywistym SessionStore obejmuje terminalny/queued/wrong-resource
katalog bez assets oraz zachowany błąd brakującej definicji dla eligible claim.
Rust regression NOT COMPILED/NOT RUN, zgodnie z zakazem.

Production API/service six-bin gate `9a81deb4d0a04aa98e36a11c376aaecd`
PASS/exit0/unchanged, digest `0cce4a3b9678f3834222a4740d4336b4d991258ac8ae1a24c947053e5df5b7dc`,
HEAD `1ee35b19e4a0e28da31ed5b9e52097d8b01919f8`. Aktualne scheduler/host_runtime
hashe odpowiadają receipt.

Dodano odrębną zarządzaną receptę `verify-compute-scheduler-cancellation`.
Fixture używa actual API cancellation, CLI publikacji oferty, standalone
schedulera z config/digest oraz jawnego byte drain. Nie podaje fikcyjnego
service owner token i nie omija guardu startu runtime_service v2. To jest
odrębna bramka komponentu; pełny service owner lifecycle pozostaje otwarty.
Python AST, Git Bash syntax i 3 mixed-scope refusals PASS. Próba runtime oraz
build nowego pakietu odmówiły przed startem z powodu drugiego aktywnego
natywnego buildu PID147956/tokencc25a52965704db7b9de3da28e8bafc6; CIM potwierdził
proces. Nie zatrzymywano go ani nie wybrano drugiego targetu. Runtime proof
poprawki oraz terminal scheduler cancellation pozostają NOT VERIFIED do
odbioru przypiętego pakietu i uruchomienia bramki. E0–E7 nadal aktywne.

### Rzeczywisty scheduler po anulowaniu — 07.10.2026

Po terminalnym zwolnieniu blokady `native Windows Fullmag build` pakiet
774c99aba27347cda7e1bbb169cf449e został zweryfikowany przez managed
`build_snapshot verify`. Zgodnie z bieżącym manifestem
`7d87e9c8bdeaf1ad95c9aa8884db6758e4e657f4bb852e90c5995b54a44dd74e`, uruchomiono
`just verify-compute-scheduler-cancellation <manifest>`; ukończone/exit0/21
kontroli. Frozen source snapshot303581c8 obejmuje aktualne pliki recovery,
host runtime, API schedulera i cancellation handler.

Wynik runtime: dwie prawdziwe HTTP prośby (Accepted/Queued) pozostały `requested`
przed schedulerem. Pool CPU opublikował natywny CLI. Dwa standalone host-bound
schedulery wykonały jawny drain, oba bez schedule/execute, taski zakończyły się
`cancelled` przy rev5, brak host reservations i pool checkpoint, API replay
zwróciło 200/original IDs/current revision5. Procesy z receipt mają terminalne
exit/wait; API fixture zostało zatrzymane po idle, nie przedstawiamy tego jako
service shutdown.

Granice dowodu są opisane w [scheduler-cancellation-check-20261007.md](scheduler-cancellation-check-20261007.md).
Nie uruchamiano testów Rust; guard `runtime_service` v2 pozostaje. Owner
lifecycle, rzeczywista topologia i enforcement, Submit, worker/solver release,
E5–E7 oraz ukończenie całego E0–E7 pozostają otwarte. Checkout `master`, bez
worktree, stagingu i commita tego zadania.

### Terminalne anulowanie przez API i standalone scheduler — 07.10.2026

Managed build `native-build-774c99aba27347cda7e1bbb169cf449e` PASS/exit0.
Manifest `7d87e9c8bdeaf1ad95c9aa8884db6758e4e657f4bb852e90c5995b54a44dd74e`
przeszedł preflight i `build_snapshot verify`. Bramka
`just verify-compute-scheduler-cancellation <manifest>` ukończona exit0/21
checks z source binding `verified_frozen_native_package`, HEAD
`1ee35b19e4a0e28da31ed5b9e52097d8b01919f8`, source snapshot
`4f987a46d5b83ef08d5b378f14aa0b2c7b25e5709f97474a0e5bab793b021a8f`.

Dwa fixture taski wysłały 202; native scheduler projekował je do Cancelled:
catalog revision5, attempt/epoch/resource/genesis puste, ledger reservations0.
Pool generacja1 pozostała identyczna, checkpoint nie powstał. Oba procesy
schedulera zakończyły się po jawnym drain, scheduled0. API replay zwrócił 200
z pierwotnymi ID i aktualną rewizją. Raport:
[scheduler-cancellation-check-20261007.md](scheduler-cancellation-check-20261007.md).

To potwierdza komponent API→scheduler z syntetyczną polityką, nie service v2
owner lifecycle, Submit, worker/solver, release zasobów, fizyczną topologię,
enforcement, sweeps ani fizykę. Testów Rust nie kompilowano. Guard v2 został.
E0–E7 nadal aktywne; bez stagingu i commita tego zadania.

### E5 — deterministyczna ekspansja niezależnych cases — 07.10.2026

`fullmag-application` udostępnia czysty `expand_independent_batch`: waliduje
typowane osie, rozwija Cartesian/Zip oraz listy i zakresy decimal
`start/stop/step` z jawnym endpoint, tworzy stabilne CaseId/RunId i zapisuje
seed case oddzielnie od child RunSpecification. Targety
`external_field_b` [T] i `zhang_li_current_density` [A/m²] wiążą wartość z
konkretnym krokiem; prąd dodatkowo wymaga nazwanego, wykonywalnego modułu;
`materialize_independent_batch_case` tworzy case-local StudyPlan/catalog,
rebinduje oba digesty RunSpec, materializuje seed case do stochastycznych pól
ProblemIR i weryfikuje wynik przez canonical planner. Legacy temperature-only
thermal noise bez jawnego `ThermalNoise` jest odrzucany, bo nie da się mu
przypiąć seedu bez zmiany semantyki. `validate_integrity` sprawdza osie,
tuple, relacje CaseId/RunId/seed, pusty generyczny parameters/seeds i wspólny
template. Po każdym case manifest zapisuje jego nowe digesty childa i własny
digest, co pozwala deterministycznie odtworzyć częściową ekspansję.
Ekspansja ma caller limit do 10 000 cases i odrzuca continuation oraz
dependency-graph, których semantyka nie jest tu jeszcze zaimplementowana.

To nie przyjmuje batcha do durable store, nie publikuje child runów, nie
rezerwuje OutputStorage i nie uruchamia schedulera. Durable Submit musi przed
ACK przypiąć również dokładne project/Study/catalog/asset bytes oraz
OutputStorage snapshot; wszystkie te CAS roots muszą wejść do GC/recovery.
Zakres nie obsługuje jeszcze continuation/dependency edges, failure/retry
policy, paged manifestów, limitu concurrency ani wyników. Testy regresyjne
źródła dodano, ale zgodnie z repozytoryjnym zakazem nie kompilowano ani nie
uruchamiano testów Rust. Wcześniejszy managed build `native-build-18ff9eabc5864dc59161d7ee8653226d`
zakończył się exit0 dla snapshotu `b428ff2f2885e21975f8b42c3ea12ea08d4a9e3388ee64c66cc4bcffdb1b0eef`
(`af3ffc42bce185a70482e1e830e32677215a1887b92d151b77a13f886e8464c6`), HEAD
`2102e64c040ddeecb5dba6b454154081769c1e42`; wtedy Application/API/CLI/Desktop
skompilowały się w profilu `backend-dev` i source identity check przeszedł.

Po formatowaniu tylko nowych plików batch powstał nowszy managed build
`native-build-b4e66701721d4b7fbaf57730afc0fdd7`, przypięty do snapshotu
`c5e0ce11496c3b9fe2e97516d07fb6e93d3e686584ea72f0a0e7ba814ccaa574` na HEAD
`3730a770a58acfb598ea75fe89aea600427b9e3e`, lecz cały build zakończył się
exit1/Cargo 101 i nie ma terminalnego receipt. Application nie zgłosił błędu;
CLI zatrzymał się na dwóch `E0599` w `crates/fullmag-cli/src/orchestrator.rs`
(6991, 8774): brak `spawn_for_grid_refresh` na
`CurrentLiveDisplaySelectionHandle` oraz `snapshot` na
`LocalLiveWorkspaceState`. To bieżąca niedokończona zmiana post-restore w
wspólnym checkoutcie; nie została zmieniona w ramach E5.

Po dodaniu walidacji managed build `native-build-e1e306d2bba044f089d4cd0c7bb2e049`
zamroził snapshot `d166263da029cd8e761b66100c3eeb951c22e7f88673b1b79a7aa6b82a26ac47`
(source digest `e9aaa4c2c784c2437847cae9aecde89fdc34a73f61ff8f157f34bc808267106b`),
HEAD `3730a770a58acfb598ea75fe89aea600427b9e3e`. Cały build ponownie zakończył
się Cargo 101 bez terminalnego receipt: jedyny zgłoszony błąd to
`crates/fullmag-cli/src/orchestrator.rs:8808`, wywołanie `.snapshot()` na
`LocalLiveWorkspaceState` w równoległych zmianach post-restore. Log nie zawiera
błędu z `fullmag-application`, lecz pełna bramka pozostaje **NOT VERIFIED**.
Testów Rust nie kompilowano; E5 pozostaje w toku.

Następny managed build `native-build-613f81c5080e4d828f38fe5817b587fd`
zakończył się PASS/exit0 po aktualizacji CLI. Zweryfikowany snapshot
`2106d9b37265aa1f796928f2199dcf9516bbe306a2f46223d6690b1a1a45b16a` ma source
digest `43d75e091bda579e51d31b3849e2b4545e8dc33b1aaab5f909aad0bb06e44073`,
HEAD `3730a770a58acfb598ea75fe89aea600427b9e3e`; pre/post source digests są
identyczne, `source_identity_check=passed`, `local_changes_check=enforced`.
API, CLI i Desktop zbudowały się w `backend-dev`. Testów Rust nie kompilowano
ani nie uruchamiano batchy/schedulerów; E5 pozostaje w toku.

Audyt przepływu parametrów pokazał, że `RunSpecification.parameters` i `seeds`
są utrwalane i wchodzą do fingerprintu, lecz nie są podstawiane do fizycznych
pól Study/ProblemIR. FDM worker odrzuca niepuste wartości; FEM worker ich nie
otrzymuje. Pythonowa biblioteka parametrów pozostaje osobną ścieżką authoringu,
bez kanonicznego pola w ProblemIR. Dlatego ekspansja w pamięci nie jest jeszcze
wykonywalnym sweepem: przed batch Submit potrzebne są typowane bindings,
walidacja przez istniejący planner oraz ich obsługa w obu workerach. E5 pozostaje
NOT VERIFIED dla solver execution.

### E4 — statusy torów solvera na ekranie Home — 07.10.2026

Karta Compute Environment w rail pokazuje teraz cztery kombinacje FDM/FEM ×
CPU/GPU na podstawie już pobranego `runtimeLanes`. Stany są jawne:
Loading, Available, Unavailable i Not reported; sama obecność urządzenia nie
wyznacza dostępności toru. Zachowano ograniczoną, przewijaną kartę oraz
przejście do Compute Settings. Notę dopisano do dokumentu projektu interakcji.

Weryfikacja: Control Room typecheck PASS; pełny ESLint PASS oraz końcowy lint
zmienionych plików PASS; test SSR komponentu PASS (3/3); ograniczony React
Doctor dla zmienionych linii
Control Room przeskanował 7 plików bez uwag. Pełny Vitest: 757 plików PASS,
1 FAIL, 1 skipped;
niepowiązany test `ScratchAuthoringInspectorStability.test.tsx` oczekuje
`Ku1 draft is ready`, a aktualny Inspector wyrenderował błąd odczytu
`Aex`. Zmiana nie dodaje inventory/ledger, liczników kolejki ani runtime
proof. E4 i cały cel
E0–E7 pozostają w toku; bez stagingu i commita.

### E5 — typed binding wejść case — 07.10.2026

Application batch contract ma jawne cele `external_field_b` [T] i
`zhang_li_current_density` [A/m²], ze wskazaniem `step_id`, kierunku i
modułu dla prądu. Materializer wyprowadza
case-local StudyPlan i StudyProblemCatalog, aktualizuje dokładne
`RunSpecification.study.plan_sha256` i `study_catalog_sha256`, oraz odrzuca
brakujące kroki/moduły, niezgodne jednostki i wielokrotne osie modyfikujące ten
sam target. Prąd nie nadpisuje named `current_source`. Seed case jest
przechowywany w manifeście; dla `RandomSeeded` oraz
`ThermalNoise` materializuje się jako niezerowy, stabilny seed w konkretnym
ProblemIR; legacy temperature-only noise jest odrzucany. Child
RunSpecification pozostaje bez nieobsłużonych `parameters` i `seeds`. Katalog
v3 zachowuje source ID; v1/v2 dostają deterministyczny
identyfikator wejścia case. Ten mechanizm nie jest jeszcze trwałym rekordem
postępu ani transakcją Submit.

Dodano źródłowe regresje dla rebindu katalogów v1/v2/v3 oraz materializacji
pola, prądu Zhang–Li i seedów. `git diff --check` PASS/exit0. `rustfmt --check`
nie uzyskał dostępu do canonicalizacji ścieżki workspace, więc parser/format
pozostaje NOT VERIFIED; testów Rust nie kompilowano ani nie uruchamiano.
Managed build jest NOT VERIFIED: `storage/locks/fullmag-0950f4dca4ffe38f.owner.json`
zawierał `state=active`, PID `124416`, host `Orion`; kolejka builda była pusta,
ale odczyt procesu przez CIM/tasklist odmówiono. Nie wykonano recovery ani buildu.
Późniejszy odczyt ownera wykazał `state=released` i pustą kolejkę. Próba
`just check-project-application` zakończyła się przed Cargo komunikatem
`MXC launcher: native MXC is unavailable on this Windows build`; kolejne
powłoki zwracały ten sam błąd, więc kontrola kompilacji nadal jest
NOT VERIFIED.
Lokalny `master` i `origin/master` są równi `008ea9ca3d0465eeee225f1ea435d15c0d2cc15e`.
Nadal brakuje trwałego Submit, publikacji child runów, snapshotu OutputStorage,
admission/fairness batcha, limitowania `max_parallel_cases`, pauzy, polityki
błędów/retry i indeksu wyników. Ten fragment nie kwalifikuje wykonania solvera;
E5 pozostaje w toku.

### E5 — trwały rekord rodzica batcha i archiwum sesji — 07.10.2026

Dodano `FmsBatchIntent` z digestem payloadu, dokładnymi referencjami CAS do
manifestu ekspansji, definicji, Study, katalogu i assetów. `SessionStore`
udostępnia commit, odczyt, wyszukiwanie po kluczu idempotencji i enumerację;
commit sprawdza wszystkie referencje pod writer lease, replay zwraca pierwotny
batch, a konflikt klucza i brak CAS zamykają publikację. Opcjonalne
`FmsSessionManifest.batch_refs` zachowuje zgodność starych sesji. Store
reachability, walidacja namespace, pack, archive preflight i import FMS
przechodzą po batch-intentach i ich CAS; regresje źródłowe obejmują replay,
conflict, brakujący CAS oraz round-trip pakietu.

`git diff --check` PASS dla zmienionych źródeł. Testów Rust nie kompilowano ani
nie uruchamiano; format Rust pozostaje NOT VERIFIED. Bramka pełnej ścieżki nadal
jest NOT VERIFIED. Parent intent nie jest jeszcze powiązany z FMS session
references. Brakuje snapshotu OutputStorage, worker recovery używającego
cursor, publikacji child runów, kontroli batch admission i limitu równoległości. E5–E7
oraz cały cel E0–E7 pozostają otwarte.

### E5 — parent Submit/List i OpenAPI — 07.10.2026

`POST /v2/persistence/projects/{project_id}/batches` przyjmuje wersjonowany
`BatchExpansionRequest` wraz z dokładnym archiwum projektu, Study, katalogiem i
mapą assetów. Adapter sprawdza project snapshot, pinned profile, Study/catalog
digest, canonical planner oraz materializuje i waliduje każde case bez
kwadratowego ponownego haszowania manifestu. Przed ACK zapisuje idempotentny
`FmsBatchIntent`, logical manifest digest i source CAS refs. Odpowiedź zawiera
BatchId, digest i liczbę cases; nie deklaruje publikacji child runów ani startu
solverów. `GET .../batches` zwraca stronicowany, projektowy parent summary;
z published prefix i stanem expansion progress.
`GET .../batches/{batch_id}/cases` zwraca nazwy osi z jednostkami kanonicznymi,
tuple parametrów i planowane RunIds bez katalogów tasks; opublikowany prefix
ma stan `pending_materialization`, a reszta `pending_expansion`.

OpenAPI generation PASS: eksporter zwykłego backend binary zakończył exit 0 i
odświeżył JSON, paths oraz TypeScript types/client. `check:api-hygiene` PASS i
Control Room typecheck PASS. Kompilacja eksportera obejmowała
`fullmag-session`, `fullmag-application` i `fullmag-api`; testów Rust nie
kompilowano ani nie uruchamiano. Źródłowe regresje adaptera Submit/List oraz
store/archive zostały dodane, ale pozostają NOT COMPILED/NOT RUN. To nie jest
managed full-build ani runtime proof.

Nadal brakuje batch commands, worker recovery konsumującego trwały cursor,
ekspansji wykonywanej przez service i publikacji child runów,
rozstrzygniętego OutputStorage snapshotu z workspace defaults, batchowej puli
admission oraz UI sweeps/results. E5 pozostaje niekwalifikowane dla równoległego
wykonania; E6–E7 i cały cel E0–E7 są otwarte.

### E5 — sequence-fenced expansion progress — 07.10.2026

`FmsBatchExpansionProgress` utrwala sekwencję, immutable manifest object/logical
digest, total cases, `next_case_index` jako opublikowany prefix oraz stan pending,
expanding albo complete. `SessionStore` przyjmuje tylko kolejny sequence,
niezmniejszający się prefix i identyczny manifest; dokładny retry jest replay.
Store reachability i `.fms` pack/preflight/import walidują progress względem
parenta i manifestu, a compact archive z niekompletnym batch graph nie jest
importowany. Dodano regresje source-level dla replay, monotonicity i round-trip.

Eksporter OpenAPI skompilował aktualne biblioteki `fullmag-session`,
`fullmag-application` i `fullmag-api`, exit 0; testów Rust nadal nie
kompilowano ani nie uruchamiano. Progress nie jest jeszcze zapisywany przez
worker, a żaden recovery loop nie publikuje child runów. Batch execution pozostaje
NOT VERIFIED.

### E5 — frontendowa fasada i zasoby batchy — 07.10.2026

Control Room ma typowane metody `submitBatch`, `listBatches` i `listBatchCases`
oraz resource hooks dla obu stronicowanych odczytów. Klucze cache uwzględniają
projekt, batch, kursor i limit. Walidatory odrzucają obcy scope, powtórzone
tożsamości, niepoprawny digest/liczniki, rozjazd stanu z opublikowanym
prefiksem oraz kursor nieodpowiadający ostatniemu elementowi. Udane Submit
unieważnia listę batchy tego projektu. `StudyInspectorPanel` pokazuje teraz
stronicowaną listę przyjętych batchy; rozwinięcie pobiera strony cases i
wyświetla parameter tuple z jednostką manifestu, zaplanowany RunId, postęp published prefix oraz
stany `pending_expansion` / `pending_materialization`. Odświeżanie jest jawne,
bo worker nie emituje jeszcze invalidation progress. Widok pozostaje
read-only: nie publikuje child runów i nie pokazuje wyników wykonania.

OpenAPI zregenerowano z backendowej definicji: API binary i generowanie typów /
klienta zakończyły się PASS. Odpowiedź cases przenosi teraz `name` i
`canonical_unit` dla każdej osi; validator wymaga zgodności wszystkich kluczy
tuple z osiami, a Inspector dopisuje jednostkę do każdej wartości.

Focused Vitest dla API, resource, Compute UI i Inspector: PASS, 170 testów;
OpenAPI generated contract: PASS, 12/12; ESLint dotkniętych plików: PASS;
`check:api-hygiene`: PASS; ograniczony TypeScript noEmit dla nowych zasobów i
komponentów: PASS. React Doctor dla `src/modules/start` i
`src/modules/inspector/panels`: PASS, bez uwag.
Włączenie `StudyInspectorPanel` do tej ograniczonej kompilacji doszło do
niezmienionych użyć Radix Dialog z błędami typów; nowy import komponentu nie
zgłosił błędu. Pełny `pnpm typecheck` zatrzymał się na EPERM podczas realpath
`node_modules`; ścieżka Next typegen przez Node odmówiła kanonikalizacji
workspace. Pełny test Rust nie był kompilowany ani uruchamiany. E5 worker recovery, publikacja child runów,
OutputStorage, admission/pauza/polityka błędów, submit editor, automatyczne
odświeżanie progress oraz UI wyników nadal
pozostają otwarte; cały zakres E0–E7 jest w toku.

### E4 — jawny stan początkowy probe — 07.10.2026

Home i Settings rozróżniają `Not probed` od trwającego `Reading…`, błędu oraz
braku probe na hoście. Komunikat wyjaśnia, że legacy probe dostarcza host
desktopowy, a konkretne urządzenie jest rozstrzygane przy starcie runu.
Widok nie wybiera ani nie obiecuje alokacji GPU.

Testy SSR widgetu i Settings, resource/fasady oraz Inspector batch/case są
uwzględnione w 170 PASS powyżej; OpenAPI contract 12/12 PASS. ESLint zmienionych
plików, `check:api-hygiene`, ograniczony TypeScript i React Doctor dla katalogów
Start/Inspector: PASS. Pełny browser proof oraz implementacja Settings,
Study, Jobs, solver settings i sweeps nadal są otwarte.

### E4 — rezerwacje zasobów w profilach — 13.10.2026

Edytor wersji profilu pozwala ustawić żądane RAM i scratch per task oraz VRAM
per GPU device w GiB. Zapis przelicza wartości na istniejące pola bajtowe
`reservation_bytes` i `vram_per_device_bytes`; nie zmienia OpenAPI. Puste pole
dziedziczy, a istniejące jawne resety `null` pozostają zachowane przy edycji
niepowiązanych pól. UI zaznacza, że są to żądania profilu, a faktyczne
przyjęcie/alokacja jest rozstrzygana przy starcie zadania. Listy GPU używają
semantycznych `ul`/`li` i stabilnych kluczy telemetrycznego indeksu/nazwy.

Weryfikacja tego fragmentu: regresje modelu profilu PASS (4/4), ESLint
zmienionych TS/TSX PASS, `tsc --noEmit --project tsconfig.typecheck.json`
PASS, `git diff --check` PASS. `pnpm typecheck` pozostaje NOT VERIFIED:
Next typegen zatrzymał się na `EACCES` podczas sprawdzania
`apps/control-room/.fullmag-frontend`, które musi wskazywać zarządzany storage;
lokalnej konfiguracji linku nie zmieniano. React Doctor przeskanował 10 plików
Start i zostawił 4 ostrzeżenia: eksport helpera z komponentu oraz trzy
custom-styled `role="meter"` w widokach telemetrycznych. Browser proof nadal
brakuje. Dwa niezależne staged pliki
(`packages/fullmag-py/src/fullmag/runtime/script_builder.py` i
`scripts/test_windows_development_scene_render_incomplete.py`) pozostawiono
bez zmian; w tej kontynuacji nie stage'owano ani nie commitowano plików.

Ten fragment nie realizuje jeszcze host inventory/policy API, ustawień
Study/Jobs, pełnej materializacji profilu ani worker recovery/admission i UI
wyników batchy. E5–E7, browser/runtime proof i kwalifikacja całości E0–E7
pozostają otwarte.

### E4 — czas ostatniej próbki telemetrii — 13.10.2026

Home i Settings pokazują lokalny czas najpóźniejszego poprawnego Unix timestampu
spośród dostępnych próbek CPU/GPU. Semantyczny element `time` zachowuje wartość
ISO; UI opisuje ją jako próbkę telemetrii, nie świeżość inventory ani alokację
urządzenia.

Focused Vitest modelu telemetrii i SSR ComputeEnvironmentWidget/Settings: PASS,
9/9; ESLint zmienionych plików: PASS. Bezpośredni pełny TypeScript check
zakończył się istniejącymi błędami w innych modułach/testach; nie zgłosił błędów
w zmienionych plikach. Browser proof pozostaje NOT VERIFIED.

### E5 — OutputStorage snapshot przy Submit — 13.10.2026

Nowe przyjęcie batcha zapisuje w `batch_submit_snapshot.v2` rozstrzygnięte
OutputStorage. Polityka `ProblemIR` ma pierwszeństwo przed workspace defaults;
ścieżki względne są rozwiązywane wyłącznie względem jawnego
`output_storage_source_dir`, a brak bazy blokuje Submit przed ACK. Ścieżki
authoringu absolutne mogą być użyte bez metadanych bazy. Kroki bez jawnej polityki
dziedziczą batchową politykę, a sprzeczne polityki, konflikt z autosave etapów
lub nieobsługiwany format blokują ACK. Snapshot zapisuje pełny `OutputStorageIR`,
hash settings, hash defaults i hash wejściowych polityk authoringu. Nowe
`batch_output_storage_snapshot.v2` wymaga absolutnych ścieżek i waliduje pełny
kontrakt; dotychczasowe inner/outer `v1` pozostają czytelne.

Ponowienie tego samego idempotency key odtwarza pierwotny snapshot, więc późniejsza
zmiana defaults nie zmienia zaakceptowanego batcha. Store porównuje request i
przypięte CAS/manifest refs przy replay, a nie serwerowe ustawienia rozstrzygnięte
przy pierwszym Submit.

W stanie zapisanym w poprzednim checkpointcie snapshot był jeszcze tylko
trwałą konfiguracją rodzica: worker nie przekazywał go child RunIntent/RunCatalog
ani właścicielowi OutputStorage, nie rezerwował ścieżek case/attempt i nie
publikował wyników. Postęp kolejnej kontynuacji opisano poniżej.
Źródła regresji obejmują authoring precedence, odmowę względnej ścieżki bez
bazy i akceptację ścieżki absolutnej bez bazy, walidację
resolved settings/provenance digestów, replay po zmianie defaults oraz odczyt
starszego v1. Testów Rust ani buildów testowych nie uruchamiano zgodnie z zakazem
repozytorium. Zarządzany build
`just windows-workspace-build dev dev 3197 auto` zakończył się przed startem
launchera: `powershell.exe` zwrócił `0xC0000142`; skrypt nie wykonał preflightu
i nie powstał build receipt, więc kompilacja pozostaje NOT VERIFIED.
`rustfmt --check` również pozostaje NOT VERIFIED: formatter odmówił dostępu
przy canonicalizacji katalogu workspace; format pozostaje NOT VERIFIED.

Kontynuacja 13.10: review wykrył ryzyko rozwiązywania względnej polityki
authoringu względem rootu sesji. Resolver teraz wymaga jawnego
`output_storage_source_dir` dla względnych ścieżek; absolutna polityka nie
wymaga tej metadanej. Dodano źródłowe regresje dla obu przypadków, bez
kompilacji testów. Scoped `git diff --check` przechodzi; pełny check/status
repozytorium zatrzymuje niedostępny submoduł `external_solvers/3`. Formatter
ponownie odmówił kanonikalizacji workspace, więc format pozostaje
NOT VERIFIED. `master` i `origin/master` wskazują `f758f84404713778e1c1f2c0762c83c689bd144a`;
indeks nie zawiera konfliktów.

### E5 — walidacja OutputStorage i początkowy cursor — 13.10.2026

Przegląd wskazał, że poprawny hash nie dowodzi poprawności ustawień. Walidator
`FmsBatchIntent` zachowuje pełną walidację legacy `v1` defaults (wymagany
`output_parent`, typy enumów, absolutne ścieżki i zakaz `..`/NUL), a nowy `v2`
deserializuje rozstrzygnięty `OutputStorageIR` i sprawdza hash ustawień,
provenance digests oraz absolutne ścieżki. Wadliwy snapshot nie przechodzi przez
store ani import `.fms`. Przyjęcie Submit tworzy również trwały cursor
`sequence=1, next_case_index=0, state=pending`; replay naprawia brakujący wpis
po awarii między zapisem parenta i cursor, a istniejący cursor pozostaje
walidowany względem immutable manifestu.

Dodano źródłowe regresje dla wadliwego settings JSON, ścieżek oraz początkowego
cursor/replay. Test odtwarza też awarię między publikacją parenta i cursor:
usuwa wyłącznie cursor z tymczasowego store testowego, ponawia Submit i sprawdza
naprawę bez zmiany zaakceptowanego parenta. Testów Rust nie kompilowano ani nie
uruchamiano zgodnie z zakazem repozytorium; obowiązuje ograniczenie builda i
formattera opisane wyżej.
Na moment poprzedniej aktualizacji worker nie konsumował cursor, nie publikował
child RunIntent/RunCatalog, nie egzekwował `max_parallel_cases` i nie przekazywał
snapshotu do OutputStorage. Postęp kolejnej kontynuacji opisano w następnym
punkcie.

### E5 — child OutputStorage i odzyskiwalna publikacja przypadków — 13.10.2026

`bind_batch_case_output_storage` przenosi rozstrzygnięty, absolutny
`OutputStorageIR` do każdego ProblemIR przypadku, usuwa nieaktualną bazę
`output_storage_source_dir` i odświeża Study, katalog oraz digesty RunSpec.
Zachowuje wejściowe identity v3, a dla brakujących identity tworzy stabilne,
przenośne identyfikatory zależne od case/step.

`expand_pending_batch_children` odtwarza zaakceptowany manifest, definicję,
Study, katalog i assets wyłącznie z przypiętych referencji CAS. Publikuje każdy
child RunIntent pod deterministycznym idempotency key, z walidacją wejść i
limitem backlogu; dopiero potem przesuwa sequence-fenced cursor. Restart po
publikacji dziecka, ale przed kursorem, powtarza identyczny Submit i odzyskuje
postęp. Konflikt kursora odczytuje najnowszy zapisany prefiks. Scheduler z
discovery uruchamia publisher przed pobraniem RunIntentów do kolejki.
`max_parallel_cases` ogranicza liczbę niekońcowych child runów; następny case
jest publikowany po zwolnieniu miejsca przez terminalny run. Historyczne batch
bez przypiętego OutputStorage są pomijane z ostrzeżeniem, ponieważ defaults nie
da się wiarygodnie odtworzyć po zmianie środowiska.

Dodano źródłowe regresje helpera aplikacyjnego i ścieżki durable publishera,
obejmujące odświeżone digesty, przekazanie ustawień do child katalogów, replay
oraz niepowielanie ukończonej ekspansji. Zgodnie z zakazem repozytorium testów
Rust nie kompilowano ani nie uruchamiano. `git diff --check` dla zmienionych
plików śledzonych przechodzi; skan nowych plików nie znalazł końcowych białych
znaków. `rustfmt --check` nie może kanonikalizować workspace i kończy się
odmową dostępu OS 5, więc format pozostaje NOT VERIFIED.

Weryfikacja kompilacji jest zablokowana przed preflightem: zarówno
`just runner-container-status`, jak i dozwolony `just windows-workspace-build
dev dev 3197 auto` kończą się kodem `0xC0000142` przy starcie PowerShell.
Nie powstał build receipt; kompilacja pozostaje NOT VERIFIED. Checkout nadal
jest `master` na `f758f84404713778e1c1f2c0762c83c689bd144a`, zgodnym z
`origin/master`; indeks nie zawiera konfliktów. Nie stage'owano ani nie
commitowano zmian. Browser/runtime proof, batchowe retry/cancel, wiązanie
child statusów z wynikami w Inspectorze oraz pozostałe E0–E7 nadal wymagają
pracy.

### E5 — wyniki child runów w Inspectorze batchy — 13.10.2026

Rozwinięty case w `ProjectBatchesSection` pokazuje rewizję katalogu zadań,
lifecycle i readiness z jego `ProjectRunResource`. Jednocześnie odkrywa
opublikowane SolutionSety tego jednego wybranego child runu, wyświetla ich
stabilne ID/revision i obsługuje kolejne strony, loading oraz błędy. Zmiana
nie tworzy requestów dla wszystkich cases naraz. To jest odkrywanie wyników;
pełne przeglądanie artefaktów nadal pozostaje w Results Navigator.

Scoped ESLint dla komponentu i jego źródłowej regresji: **PASS**. Pełny
`tsc --noEmit --project tsconfig.typecheck.json` kończy się błędami w innych
modułach i testach; filtrowanie diagnostyk nie wykazało błędu w
`ProjectBatchesSection` ani jego pliku testowym. `react-doctor --verbose
--scope changed` zatrzymuje się po wyborze Control Room i nie zwraca skanu;
proces przerwano, więc React Doctor pozostaje **NOT VERIFIED**. Testów
jednostkowych nie uruchamiano zgodnie z repozytoryjnym zakazem; browser proof
pozostaje **NOT VERIFIED**.

Checkout pozostaje na `master`, HEAD i `origin/master` to
`499c7c902b40ad7a69e3e03108f26caecb28d3ca`. `git ls-files -u` i staged-file
list są puste. Zmiany pozostały niestage'owane i niezacommitowane; cudzy dirty
stan checkoutu został zachowany.

### E1 — `ComputeResources` canonical round-trip — 13.10.2026

`ComputeResources.from_ir()` dekoduje wersjonowany, kanoniczny request z
walidacją pól, a export buildera i SceneDocument zachowują zasoby w obu
kierunkach. Generator skryptu emituje `study.resources(...)` zarówno z
ProblemIR/runtime metadata, jak i SceneDocument. Dodano źródłową regresję
obejmującą decoder, builder, SceneDocument, ProblemIR oraz oba eksporty skryptu.

Python AST parse zmienionych źródeł i testu: **PASS**; `git diff --check`:
**PASS**. Testów jednostkowych nie uruchamiano. Managed OpenAPI generation
nie doszło do preflightu: `just runner-container-status` kończy się kodem
`-1073741502` (`0xC0000142`) przy starcie klienta Python. Generated OpenAPI
i typy TS pozostają nieaktualne dla nowego podsumowania batcha, a typecheck
frontendowy jest **NOT VERIFIED**. Nie użyto Cargo poza kolejką ani nie
edytowano ręcznie generated artifacts.

### E2/E5 — audyt inventory i polityka publishera batch — 13.10.2026

Niezależny audyt bieżącego `master` potwierdza, że E2 nadal nie publikuje
`ComputeNodeSnapshot` z topologią CPU/GPU, freshness i owner/boot revisions.
Ledger waliduje skonfigurowany topology digest, ale sam nie próbuje aktualnej
topologii; runtime v2 nadal ma startup guard. W chwili audytu spec nie
określała jeszcze age threshold ani reguły zwiększania `inventory_revision`;
decyzję uzupełniono poniżej.

Rozstrzygnięcie z 13.10: próbka staje się `stale` po 30 sekundach. `inventory_revision`
zmienia się wyłącznie przy trwałej zmianie CPU topology/OS constraints, GPU
UUID/partition lub wiązań PCI/topology; `capabilities_revision` jest niezależna
i obejmuje zgłoszone runtime capabilities. Próbki RAM/load/temperature nie
zmieniają żadnej z tych rewizji. Zasady zapisano w specyfikacji i projekcie
Settings.

W E5 publisher dzieli dostępny `child_budget` między pozostałe batch-parenty
i obraca kolejność startu na podstawie trwałych sequence progress, także gdy
budżet jest mniejszy niż liczba oczekujących parentów. Dodano źródłową
regresję dwóch batchy. `failure_policy` przyjmuje `continue_independent` lub
`stop_admission`; brak pola zachowuje dotychczasową kontynuację dla legacy
requestów, a default jest pomijany w serializacji manifestu dla zachowania
starych digestów. Przy stop-admission wykrycie terminalnego failed/cancelled/
interrupted child zapisuje trwały, niepełny stan `stopped`. API/UI źródłowo
pokazują stan i politykę. Dodano regresje źródłowe; nie kompilowano testów ani
backendu. Rust compile, generated OpenAPI/types, typecheck, runtime i browser
pozostają **NOT VERIFIED**.

### E2 — decyzja o freshness i synchronizacja checkoutu — 13.10.2026

Użytkownik potwierdził próg `stale` wynoszący 30 sekund. Specyfikacja oraz
projekt Settings opisują próg, niezależne rewizje inventory/capabilities i
brak zmian rewizji od telemetrycznych wartości RAM/load/temperature.

Lokalny checkout jest na `master`; po `git fetch origin master` został
fast-forwardowany do `9112d38880f45ff85db2bbd82dd5da67b778cb40`, zgodnego z
`origin/master`. Autostash przywrócił dirty changes z jednym konfliktem w
manifeście niezależnego audytu; zachowano wcześniejszą lokalną wersję pliku,
kopię `3ea5620015594a502ad90e2aaf1055921be10350` pozostawiono w stashu.
`git ls-files -u` i staged changes są puste. Pełny status nadal nie może
przejść przez `external_solvers/3`.

### E4 — świeżość telemetrii Home/Settings — 13.10.2026

Home Compute Environment i Settings oznaczają dane `stale`, gdy próbka CPU/GPU
przekracza 30 sekund; future/invalid timestamp nie jest uznawany za bieżący.
Jedna próba sprawdza oba źródła osobno, więc świeższy GPU nie ukrywa starego
CPU. Dodano regresję granicy 30 sekund i future timestamp. Scoped ESLint plików
zmiany: **PASS**; `git diff --check`: **PASS**. Testów jednostkowych nie
uruchamiano. Browser proof i typowanie całej aplikacji pozostają **NOT VERIFIED**.

### E2 — walidowany model snapshotu — 13.10.2026

`crates/fullmag-session/src/compute_node_snapshot.rs` definiuje typowany,
wersjonowany snapshot z CPU topology/OS constraints, GPU UUID/partition/
powiązaniami, osobnymi telemetry observations, capabilities i enforcement.
Waliduje tożsamość/revisions, wylicza kanoniczny digest inventory, odróżnia
`current`/`stale`/`unavailable`, odrzuca przyszłą próbkę jako bieżącą i zachowuje
brak danych jako jawny status. `name`, VRAM i telemetry nie zmieniają
`inventory_revision`; capabilities/enforcement mają osobny digest i rewizję.
W source regression zapisano granicę 30 sekund, unavailable, future timestamp
i niezależność rewizji. Testów Cargo nie uruchamiano; `rustfmt --check` nie
przeszedł z powodu odmowy dostępu podczas kanonikalizacji ścieżki. To wyłącznie
model: host sampling, trwałe przypisywanie rewizji, owner/boot publication,
read-only API i enforcement świeżości w admission pozostają otwarte.

### E2 — host sampling, trwały snapshot i read-only API — 13.10.2026

Użytkownik ustalił granicę `stale = 30 s`. Runtime-control zbiera próbkę co
5 sekund podczas działania host runtime service, zapisuje CPU effective
capacity, RAM i opcjonalną inwentaryzację NVIDIA z limitem 2 sekund. Brak
topologii CPU, affinity/quota, capabilities runtime i klasy partycji GPU
pozostaje jawnie `unsupported`/`not_reported`; widoczność GPU nie jest
deklarowana jako egzekwowana. Linux boot ID pochodzi z systemu; Windows używa
konserwatywnego identyfikatora wyprowadzonego z uptime i zegara ściennego.

`HostResourceLedger` przechowuje osobny snapshot JSON ograniczony do 4 MiB,
pod wspólną blokadą writera i atomową publikacją. Model przypisuje niezależne
rewizje inventory/capabilities z ich digestów, resetuje je przy zmianie bootu
i odrzuca replay starszej próbki. API udostępnia `GET /v2/platform/compute/nodes`
oraz `GET /v2/platform/compute/nodes/{node_id}`; freshness jest przeliczana
przy odczycie, a odpowiedź ma ETag/304. Lista zwraca najwyżej lokalny host.

Kod próbuje opublikować pierwszą próbkę przed zwolnieniem schedulera, a następnie
odświeża ją co 5 sekund. Nadal obowiązuje wcześniejsza bramka `runtime_service_main`,
która odrzuca v2 `host_execution` przed nabyciem ownera. Dlatego ten producent
nie ma jeszcze potwierdzonej, działającej ścieżki runtime; bez zapisanego
snapshotu endpoint zwraca `not_probed`. Nie usunięto bramki startu usługi.

`HostRuntimeAdmission` sprawdza teraz przed nowym admission i recovery, czy
snapshot istnieje, waliduje się, pasuje do skonfigurowanego ledger/node/policy
epoch, pochodzi z aktualnego bootu i ma próbkę nie starszą niż 30 sekund.
Brak, stale, unavailable lub poprzedni boot wstrzymuje wybór zadania; kontrola
przed spawn również odmawia użycia nieaktualnej próbki. Regresja źródłowa
pokrywa obliczanie granicy 30 sekund i defer przy braku snapshotu. To nie
potwierdza liveness procesu ownera ani monotonicznego epoch między jego
restartami; te fencing gates, zgodność inventory z polityką, OpenAPI/type
generation, integracja Home/Settings i browser/runtime proof pozostają otwarte.

Weryfikacja: scoped `git diff --check` nie wykazał błędów białych znaków; nowe
pliki sprawdzono przez `git diff --no-index --check` (wyłącznie ostrzeżenia o
konwersji LF/CRLF). `rustfmt --check` odmówił kanonikalizacji ścieżki repo.
`just runner-container-status` nie uruchomił klienta Python (`-1073741502`),
także przy użyciu dołączonego runtime Python; dlatego managed source check,
OpenAPI codegen i type generation nie zostały uruchomione. Testów jednostkowych
nie kompilowano ani nie wykonywano. `git fetch` zakończył się poprawnie;
`HEAD` i `origin/master` są równe `8c0b0cae6122ba3dea06a17cd2d28cd524dec849`,
`git ls-files --unmerged` jest pusty. Współdzielone dirty pliki pozostają
niestage'owane i nietknięte.

Po dodaniu freshness/boot gate: scoped `git diff --check` nadal przechodzi;
kontrola nowych plików przez `--no-index --check` zgłasza wyłącznie
ostrzeżenia CRLF, a skan zmienionych plików nie znajduje markerów konfliktu.
`HEAD` pozostaje równy `origin/master` (`0` commitów w obie strony), index jest
pusty, a testów/buildów nadal nie uruchomiono.

### E2 — API odrzuca próbkę z poprzedniego bootu — 13.10.2026

Read-only compute-node API porównuje `snapshot.boot_id` z identyfikatorem
bieżącego hosta. Rozbieżność daje stan węzła `unavailable`, także gdy próbka
ma mniej niż 30 sekund; pole freshness wewnątrz historycznego snapshotu nadal
opisuje wyłącznie wiek próbki. Odpowiedź i jej kształt się nie zmieniły.
Source regression pokrywa `Current` przy zgodnym i różnym boot ID.

Pliki: `crates/fullmag-api/src/router_v2/handlers/platform/compute_nodes.rs`
(SHA-256 `08ab4c0f3ba8e022e55049b87cf945975b915c0f73178970c76075755287ec8c`)
i `crates/fullmag-api/src/schemas/compute_nodes.rs` (SHA-256
`fc9d37ed295b27aa40a18c3188fb782a05b59e8577170ade0f72562473448ff9`). Skan
białych znaków i `git diff --check` nie wykazały błędów. `rustfmt --check`
odmówił kanonikalizacji ścieżki workspace (`os error 5`); regresji nie
kompilowano ani nie uruchamiano zgodnie z zakazem testów jednostkowych.
OpenAPI/typegen, managed build, runtime i browser pozostają niezweryfikowane.

`git fetch origin master` zakończył się poprawnie; `HEAD` i `origin/master` są
równe `3857b9f02123e97448a2b32e6dd8982f78935593` (`0/0`), bez unmerged paths
i bez staged zmian. Pozostałe bramki E2 — dynamiczny host inventory owner,
zgodność pełnego inventory z polityką — oraz pełne E0–E7 pozostają otwarte.

### E5 — projekcja trwałego child run i lifecycle case — 13.10.2026

Lista przypadków batcha wykrywa child `FmsRunIntent` także przy
`case_index == next_case_index`, czyli w dozwolonym oknie awarii po trwałym
zapisie intentu, a przed przesunięciem kursora. Przed ekspozycją runu handler
sprawdza deterministyczny idempotency key, RunId, projekt, fingerprint RunSpec
i referencje CAS. Brak dziecka wewnątrz opublikowanego prefiksu, child poza
kursem lub kursor wykraczający poza manifest kończą się błędem, nie cichym
stanem pending.

Odpowiedź `cases` zawiera opcjonalny `published_run`, status katalogu oraz
podsumowanie tasków z lifecycle. `published_case_count` pozostaje trwałym
watermarkiem kursora i może być o jeden mniejszy od już widocznego childa w
oknie replay. Regresja źródłowa odtwarza ten przypadek, idempotentny replay i
późniejszą materializację katalogu. Nie kompilowano ani nie uruchamiano testów.

Pliki źródłowe: `crates/fullmag-api/src/router_v2/handlers/persistence/projects.rs`
(SHA-256 `6a416ef543b81736f8b3015953d1b4ca73b59028d5ab5fecae09b8c88decf5cb`),
`crates/fullmag-api/src/schemas/projects.rs` (SHA-256
`4270cc5f06a946402ac7ecc9a969dc3d37107048835b8bbb24eef0fffe127c1b`) i
`crates/fullmag-api/src/router_v2/tests/project_documents.rs` (SHA-256
`da6095d1644e161f5830aa89762f67870005ef0851140a54b5b545617c1ed18f`).
Scoped `git diff --check` jest czysty. `openapi-v2-types.ts` nie zawiera jeszcze
nowego wariantu/stanu; generator i typegen pozostają nieuruchomione, a Inspector
nie konsumuje jeszcze `published_run` ani listy tasków.

### E2 — zachowanie formatu snapshot v1 i świeża synchronizacja — 13.10.2026

Ujednolicono komentarze modelu oraz specyfikacji: w obecnym
`compute_node_snapshot.v1` `runtime_owner_id` oznacza stabilną tożsamość host
ledgeru, a `owner_epoch` epokę skonfigurowanej polityki. Nie są to pola
dynamicznego host inventory producer lease. Planowana wersja v2 wprowadzi
odrębne `host_owner_id` i `host_owner_epoch`; dotychczasowych pól v1 nie
reinterpretujemy. Odpowiednia reguła jest też doprecyzowana w ADR 0052.

`git fetch origin master` zakończył się poprawnie z uprawnionym zapisem do
`.git/FETCH_HEAD`. `HEAD`, `origin/master` i `FETCH_HEAD` są równe
`e1865ce66c0291be2bfc03a77253b77972b62d4f`; rozbieżność wynosi `0/0`,
`git ls-files --unmerged` oraz staged paths są puste. Wspólne zmiany pozostają
niestage'owane i zachowane. `just runner-container-status` nadal kończy się
kodem `-1073741502`, dlatego managed OpenAPI/typegen, build, browser i runtime
pozostają `NOT VERIFIED`; testów jednostkowych nie kompilowano ani nie
uruchamiano zgodnie z zakazem repo.

### E3 — izolacja GPU w środowisku accepted worker — 13.10.2026

`accepted_study_supervisor::spawn_worker` buduje teraz środowisko widoczności
urządzeń wyłącznie z lease'u: dla CPU ustawia pustą `CUDA_VISIBLE_DEVICES` i
usuwa FDM/FEM/generic CUDA indices; dla GPU maskuje proces do UUID z lease'u,
ustawia oba backendowe ordinaly na `0` i usuwa inherited generic selector.
Dotyczy to obu ścieżek accepted worker, nie tylko host-bound, dzięki czemu
odziedziczony index FEM nie może wybrać innej karty po maskowaniu.

Dodano źródłową regresję dla CPU i pojedynczego GPU UUID; zgodnie z zakazem repo
nie kompilowano ani nie uruchamiano testów. `git diff --check` przechodzi.
`rustfmt --check` odmówił kanonikalizacji workspace (`os error 5`), więc
formatowanie pozostaje niezweryfikowane. SHA-256
`crates/fullmag-api/src/accepted_study_supervisor.rs`:
`416b60e12bae68ee206241dab36115e7e6fe9296b964ef1ee42017158ec524d8`.
To wiąże maskę GPU i ordinal, ale nie dowodzi CPU affinity, limitu OS ani
rzeczywistego device receipt; te punkty E3 są nadal otwarte.

### E5 — Inspector konsumuje trwałą projekcję child run — 13.10.2026

`ProjectBatchesSection` odróżnia teraz planowany RunId od runu potwierdzonego
przez `published_run`. Przypadek bez durable child pokazuje wyłącznie planowany
RunId i nie oferuje szczegółów ani wyników. Dla opublikowanego child panel
pokazuje stan katalogu i lifecycle tasków; dopiero jego RunId otwiera szczegóły
runu oraz odkrywanie SolutionSetów. `validateProjectBatchCasesEnvelope`
sprawdza zgodność stanu case z publikacją, identyczność planowanego i trwałego
RunId, katalogu, rewizji, lifecycle oraz unikalność tasków.

Dodano regresje źródłowe dla case bez publikacji, pending/materialized+publikacji, niespójnej tożsamości oraz zduplikowanych tasków, a także scenariusz+Inspectora z jednym planowanym i jednym materialized child. Nie kompilowano ani+nie uruchamiano testów jednostkowych.

`check-control-room-production-source` i `lint-control-room-source` przeszły+na niezmienionym fingerprintcie źródeł+`9f37bcb7efe613a516e38d96734d19f6af89caf71a3b62e4048ac47b0a964d55`.+Receipty: `C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-control-room-source-check\production-source\258b29ef64904dde80f4bf09fd1bcf12\receipt.json` i+`C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-control-room-source-check\lint\a5a70973adf547bf9c93f876a5df616b\receipt.json`.+React Doctor zakończył się kodem 0, ale zgłosił jedno ostrzeżenie+`react-doctor/prefer-useReducer` przy istniejących, powiązanych pięciu+`useState` w `ProjectBatchesSection.tsx`; ten etap nie dodaje nowego stanu.+Receipt: `C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-control-room-source-check\react-doctor\a48e2bc64e26479593333c4346259d28\receipt.json`.++Scoped `git diff --check` dla czterech zmienionych plików jest czysty. Repozytoryjny+check bez ograniczenia ścieżek nadal nie jest dostępny, bo Git nie może wejść do+submodułu `external_solvers/3` (`Permission denied`). Hashe SHA-256: `projectBatchResources.ts`+`c09052853fe560c467cd0254f0604248530e0d2a4cd6a3201be3032e85bb06d7`,+`projectBatchResources.test.ts`+`1f427b561fe5fece99c539849b19f9db7138fcd74ebe77de68aed2d9f7a85546`,+`ProjectBatchesSection.tsx`+`ff4741559fe011416b14f339c4799159beb7c79f877b07ef687acd6a7c1140fd`,+`ProjectBatchesSection.test.tsx`+`174c09cee2637374eae1ea332c71ef7f450df5f19085d7b686d29adf23ab2a15`.++`git fetch origin master` potwierdził `HEAD`, `origin/master` i `FETCH_HEAD`+na `7a70eee3345cba31b6902e00919d5b444f819913` (`0/0`); commit został+utworzony poza tym etapem i zmienia osobny zakres runtime/OpenAPI. Indeks i+unmerged paths są puste. Nie otwierano przeglądarki; browser, runtime, retry/cancel+case, pełne przeglądanie artefaktów oraz pozostałe bramki E5 pozostają+`NOT VERIFIED`/otwarte.
### E4 — Start pokazuje świeżość inventory hosta — 13.10.2026

Ekran Start odczytuje `/v2/platform/compute/nodes` przez wygenerowany typ,
fasadę `ControlRoomApi.platform` i globalny resource hook. `useComputeProbe`
pozostaje jednym właścicielem odczytu współdzielonym z rail i Settings;
obserwuje inventory co 5 sekund wyłącznie, gdy ekran jest widoczny, i obejmuje
je ręcznym odświeżeniem. Rail i Settings pokazują liczbę węzłów oraz stany
`current`, `stale`, `not_probed`, `unavailable` i błąd ostatniego refreshu
oddzielnie od telemetrii CPU/GPU i solver lanes. Granica `stale_after_seconds`
wynosi 30 sekund zgodnie z decyzją użytkownika.

Dodano źródłowe regresje dla fasady, zmiany revision snapshotu i widoku raila.
Testów jednostkowych nie kompilowano ani nie uruchamiano. Zaktualizowano
`docs/design/start-screen/docs/09-compute-environment.md`, aby opisywał osobny
zasób inventory. `git diff --check` dla zmienionych źródeł przechodzi.

Pierwszy zarządzany `generate-client` wygenerował artefakty OpenAPI, ale receipt
ma stan `failed`, ponieważ fingerprint zmienił się podczas generacji. Dwa
następne uruchomienia nie weszły do route z powodu aktywnej blokady kanonicznego
storage (`Storage is busy`); blokady nie usuwano ani nie omijano. Idempotencja
generacji, bieżący typecheck/lint i przeglądarka dla tej poprawki pozostają
`NOT VERIFIED` i wymagają wykonania po zwolnieniu storage.

### E4 — Settings pokazuje szczegóły snapshotu inventory — 13.10.2026

Panel inventory w Settings pokazuje źródło i czas próbki, revision, świeżość,
topologię CPU (logiczne ID, sockety, NUMA i znane rdzenie), dozwolone CPU,
limit oraz obserwowaną pojemność, RAM, stabilne UUID GPU, PCI ID, nazwę, VRAM,
partycję i NUMA. Pola last_known pozostają odróżnione od bieżących. Widok
pokazuje również zgłoszone mechanizmy enforcementu i wyjaśnia, że odczyt nie
jest rezerwacją ani przypisaniem solvera. Parser odrzuca snapshot o niezgodnej
wersji lub tożsamości hosta.

Dodano parser wybranych pól wersjonowanego snapshotu i widok Settings
korzystający z istniejących klas/tokens Start Screen; dokumentacja projektu
opisuje rozdzielenie inventory, telemetrii i capabilities. Testów jednostkowych
nie kompilowano ani nie uruchamiano. Generator OpenAPI i dalsze zarządzane
bramki frontendowe są nadal niezweryfikowane: kanoniczny storage pozostawał
zajęty, a poprzedni receipt generacji zakończył się failed z powodu zmiany
fingerprintu podczas runu. Przeglądarka dla nowego panelu pozostaje
NOT VERIFIED.

Zarządzany route production-source `6a47d7f0da2644528371e4e7678b662b`
dotarł do TypeScript, ale zakończył się niepowodzeniem: nullable RAM przekazano
do formattera wymagającego liczby. Poprawiono panel, aby `null` pokazywał jako
Unavailable. Ten receipt także wykrył zmianę fingerprintu źródeł podczas
kontroli; kolejna próba czeka na zwolnienie ponownie aktywnej blokady storage.
Testy jednostkowe pozostały wyłączone.


### E1 — allowlista legacy CPU threads do wspólnego resolvera — 13.10.2026

CLI importuje teraz wyłącznie `FULLMAG_CPU_THREADS` jako warstwę `legacy_env`
`resources.cpu.threads` dla skryptów z deklarowanym profilem lub przypiętą
materializacją. Normalizacja akceptuje `auto` i dodatnie `u32`; puste, zerowe,
niecałkowite, przepełnione lub nie-Unicode wartości kończą się jawnym błędem.
Warstwa jest przechowywana w tej samej materializacji i zachowuje źródło pola.
Zwykłe skrypty bez profilu pozostają na starej ścieżce. Ponowna walidacja
materializacji, która już zawiera `legacy_env`, nie dopisuje duplikatu.

`RAYON_NUM_THREADS`, `OMP_NUM_THREADS`, `CUDA_VISIBLE_DEVICES` i selektory
ordinal GPU pozostają ograniczeniami/adapterami runtime, nie są tym importerem
interpretowane jako intent użytkownika. Import pozostałych zgodnych wejść oraz
trwałe Submit provenance i runtime pozostają otwarte; E1 nie jest ukończony.
Dodano regresje źródłowe parsera, zachowania origin w resolverze i konfliktu
`auto` z odmiennym jawnym środowiskiem.

`git diff --check` dla dwóch zmienionych plików: PASS. `rustfmt --check` nie
mógł skanonikalizować katalogu workspace (Windows `os error 5`). Zarządzany
`just check-cli-source` zakończył się przed kontrolą źródeł kodem
`-1073741502` (`0xC0000142`) przy starcie repozytoryjnego interpretera Python;
nie uruchamiano bezpośredniego Cargo ani testów jednostkowych. Kompilacja
zmienionego CLI, runtime i browser pozostają NOT VERIFIED. Checkout jest na
`master`, HEAD i `origin/master` są równe
`1ce6fee668f8bbe56da0c193361bf25a258e2b16`; index i unmerged paths są puste.
Pliki pozostają niestage'owane.

SHA-256 `crates/fullmag-cli/src/python_bridge.rs`:
`063d930bf71d5f7122cf2f7b43fa9944bc5bd5beadf00d70317a2dc70f882ad5`.
SHA-256 `crates/fullmag-application/src/execution_profile_reference_tests.rs`:
`b5db611917a4d20f9aa5b5f65628d8ffcf9677c48dbbf251ca2ac9a5ffa59bca`.

Po potwierdzeniu przez użytkownika granicy `stale = 30 s` sprawdzono, że ta
sama stała `COMPUTE_NODE_SAMPLE_STALE_AFTER_SECONDS` jest ponownie liczona przez
`ComputeNodeSnapshot::is_current_at` i bramkę `HostRuntimeAdmission` używaną
przed admission, recovery oraz spawnem. Wiek równy 30 sekundom pozostaje
bieżący; próbka starsza niż 30 sekund odracza admission. Nie znaleziono
otwartego okna/karty Control Room; widoczne strony przeglądarki nie uruchamiają
Fullmag, więc browser proof pozostaje NOT VERIFIED.

Ponowny zarządzany `just windows-workspace-build dev dev 3197 auto` zakończył
się kodem `-1073741502` (`0xC0000142`) podczas uruchamiania `powershell.exe`
launcherem `scripts/windows/run_fullmag.ps1`, przed rozpoczęciem kompilacji.
Nie uruchamiano bezpośredniego Cargo ani ręcznego builda. Bieżąca kompilacja
CLI/runtime i pełny typecheck po wygenerowaniu aktualnego klienta pozostają
NOT VERIFIED.

### E4 — rozdzielenie stanu węzła od wieku próbki — 13.10.2026

Review Settings ujawnił, że UI renderowało tylko `snapshot.sample.freshness`.
API może jednak zwrócić świeżą wiekowo próbkę z `node.state=unavailable`, gdy
`boot_id` należy do poprzedniego uruchomienia hosta. Summary przenosi teraz
stan per-node do karty; badge pokazuje `Unavailable · previous host boot`, a
metryka `Sample freshness` nadal oddzielnie opisuje wiek próbki. Dodano źródłową
regresję obu stanów jednocześnie. Projekt Start Screen opisuje tę różnicę.

`git diff --check` przeszedł dla śledzonych źródeł UI. ESLint wywołany przez
pnpm nie dotarł do analizy: `EPERM` przy kanonikalizacji `apps/control-room`.
Próba z katalogu głównego także nie znalazła lokalnego binarium ESLint.
React Doctor nie zwrócił wyniku i został przerwany po zawieszeniu na selekcji
projektu; nie traktować go jako PASS. Unit testów i typechecku nie uruchomiono.
Zarządzany `just windows-ui dev 3197 auto dev` zatrzymał się przed startem
launchera kodem `-1073741502` (`0xC0000142`), dlatego przeglądarkowy proof tej
zmiany nadal jest NOT VERIFIED.

### E4 — starzenie zachowanego snapshotu inventory — 13.10.2026

Jeżeli odświeżenie API zawiedzie, Start nadal pokazuje ostatni udany snapshot.
Dotąd jego etykieta mogła pozostać `Current` po przekroczeniu limitu wieku,
ponieważ backendowy stan nie zmieniał się bez kolejnej odpowiedzi. Summary
przelicza teraz `sample.collected_at` lokalnie według `stale_after_seconds`;
dokładnie 30 sekund pozostaje bieżące, a po przekroczeniu limitu węzeł i próbka
przechodzą w `stale`. Stan `unavailable` po zmianie `boot_id` pozostaje osobny,
choć wiek próbki może później również stać się `stale`. UI nadal nie traktuje
inventory jako rezerwacji ani przydziału.

Dodano regresje źródłowe dla wieku 30 s / 30,001 s, błędu refresh i utrzymania
stanu poprzedniego bootu. Zaktualizowano opis `docs/design/start-screen/docs/09-compute-environment.md`.
`git diff --check` dla śledzonych plików oraz kontrola białych znaków i końców
wierszy dla 5 zmienionych źródeł/dokumentów: PASS. Transpile/syntax check
TypeScript przeszedł dla 3 plików produkcyjnych; pełny typecheck pozostaje
NOT VERIFIED. Nie kompilowano ani nie uruchamiano testów jednostkowych.

Zarządzany `just check-control-room-production-source` nie uruchomił repozytoryjnej
kontroli: Git Bash zakończył inicjalizację błędem `NtCreateDirectoryObject`
(`0xC0000022`), przed uruchomieniem skryptu źródłowego. Nie omijano preflightu.
Browser proof pozostaje NOT VERIFIED. Checkout: `master`, HEAD i lokalne
`origin/master` `1ce6fee668f8bbe56da0c193361bf25a258e2b16`; 52 wpisy statusu
obejmują całą istniejącą dirty pracę, index i unmerged paths są puste.
Nie stage'owano ani nie commitowano zmian.

SHA-256 `computeNodeInventory.ts`:
`402fdfdc1f0756be0829c45cb56e2c94c8cbdbcfa4ea95b49fa0c2119fa49f33`;
`useComputeProbe.ts`: `4d495d731adc31acb2ea21c88f440f0c5389380611f3eba2c6baccb8ac7bd13d`;
`ComputeNodeInventoryStatus.tsx`: `636ef477291ef3d9d2b82d849f6d5e0f6766cc3cb426bc9b2a5e030a5a0b4e4e`;
`computeNodeInventory.test.tsx`:
`05ba06cb3135446fecbf6ce8496b4653bfc12ef2e59c8fa4d192179589ed65e8`;
`09-compute-environment.md`:
`25559c8d56f6a64c3a1d24cdcfa94c8f70c530551b777a2e9c1dc7dd3a101db4`.

### E1 — zachowanie zewnętrznego rozstrzygnięcia typed Auto — 13.10.2026

CLI zachowuje `FULLMAG_CPU_THREADS=auto` w materializacji jako requested
intent. Runner odczytuje teraz osobne `FULLMAG_CPU_THREADS_AUTO_RESOLVED` przy
rozstrzyganiu typed Auto, więc liczba pochodząca z launchera/admission steruje
pulą bez zamiany intentu `auto` na liczbę. Jawny typed count nadal wygrywa z
tym zewnętrznym rozstrzygnięciem. Dodano regresję źródłową dla obu przypadków.

Testów jednostkowych nie kompilowano ani nie uruchamiano. `rustfmt --check`
zatrzymał się przed formatowaniem na Windows `os error 5` przy kanonikalizacji
repozytorium. `git diff --check` oraz kontrola białych znaków i końców wierszy
dla runnera i checkpointu: PASS. Kompilacja runnera, runtime i browser
pozostają NOT VERIFIED.

SHA-256 `crates/fullmag-runner/src/lib.rs`:
`ede525230866fd2142505a7ef361bc0bf60298e44a8b5d5a16e2d5d971a7eafd`.

### E2 — wyłączny lease właściciela inventory i ComputeNodeSnapshot v2 — 13.10.2026

Wspólny `HostResourceLedger` zyskał osobny natywny lock `HostInventoryOwner`
i ograniczony rekord ownera. Stabilne `host_owner_id` pochodzi z tożsamości
ledgera, a `host_owner_epoch` rośnie przy każdym przejęciu po zwolnieniu locka.
Epoka pozostaje niezależna od `HostResourceLedgerPolicy.owner_epoch` i
`RuntimeServiceOwner`; usługi różnych store'ów współdzielą jednego publishera.
V2 snapshot dodaje parę `host_owner_id`/`host_owner_epoch`; v1 zachowuje stare
pola i znaczenie. Publikacja v2 weryfikuje dokładny token, ID i epoch lease'a
pod writer lockiem tego samego ledgera.

Runtime service próbuje uzyskać lease i publikuje próbkę v2. Usługi bez lease'a
czekają na wspólną świeżą próbkę i ponawiają próbę przejęcia. Host admission
oraz odczyt API sprawdzają aktywny lease i jego epoch; stary snapshot po
przejęciu nie otwiera admission, niezależnie od wieku. UI parsuje v1 i v2,
odrzucając v2 bez poprawnej pary owner ID/epoch.

`HostReservationRequest` oraz trwała rezerwacja przechowują osobną parę ID/epoch
producenta inventory; nie reinterpretują `host_owner_epoch` polityki. Reserve,
solver/preparation admission i zużycie launch permit sprawdzają pod wspólną
blokadą ledgera aktywny lease oraz świeży snapshot v2 o tej samej epoce. Przejęcie
host-owner między utworzeniem requestu a zapisem lub spawnem zamyka tę próbę.
Świeżość jest ponownie sprawdzana przed finalnym `Tentative→Committed`, a
reconciliation rezerwacji poprzedniej epoki nie promuje jej po takeover.
Nowy ledger i pierwszy zapis migrowanego stanu emitują dokument v2; odczyt nadal
przyjmuje istniejące v1.

Dodano regresje źródłowe dla przydziału epoch 1, wyłączności locka, inkrementacji
epoch po zwolnieniu, stabilności ID po reopen, publikacji, aktywnego owner lease'a
oraz fencing rezerwacji po takeover. Nie kompilowano ani nie uruchamiano testów
zgodnie z zakazem. Pełna zgodność inventory z polityką, migracja/recovery
istniejących rezerwacji oraz kompilacja/runtime i browser proof pozostają
NOT VERIFIED.

Kontrole po zmianie: scoped `git diff --check` **PASS**. `just
check-api-service-source` i `just runner-container-status` zakończyły się przed
uruchomieniem właściwej kontroli błędem inicjalizacji procesu `0xC0000142`;
kontrola kompilacji źródeł nie powstała. `rustfmt --check` zatrzymał się na
kanonikalizacji katalogu repozytorium z `os error 5`. Testów jednostkowych,
buildów i browser proof nie uruchamiano.

### E2 — admission sprawdza przypięte fakty inventory — 13.10.2026

Request z przypiętymi CPU IDs wymaga bieżącej topologii i OS-allowed setu,
które obejmują politykę oraz wybrane identyfikatory. Przydział GPU wymaga
bieżącego UUID, potwierdzonej partycji `full_device` oraz raportowanego VRAM
nie mniejszego od pojemności polityki i requestu. `last_known`, nieobecna
topologia/pojemność i `unknown` partycji nie otwierają rezerwacji ani startu.
Kontrole działają przy reserve, solver/preparation commit i reconciliation
oraz bezpośrednio przed wydaniem/zużyciem launch permit. Rezerwacje bez ownera
pozostają co najwyżej tentative; commit/launch nadal wymagają ownera.

Sampler `nvidia-smi` odczytuje teraz `mig.mode.current`: tylko `Disabled`
raportuje pełne urządzenie. Starszy query zachowuje telemetrię z partycją
`unknown`; `Enabled` i `N/A` także nie udają całej karty. NVIDIA dokumentuje
pole i wartości w [MIG User Guide](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/getting-started-with-mig.html).
CPU topology w obecnym samplerze nadal jest `unavailable`, więc host policy
z przypiętą maską CPU pozostaje zamknięta do czasu jej wiarygodnego pomiaru.
Nie jest to dowód egzekwowania affinity, maski GPU ani fizycznej kwalifikacji.

Dodano źródłowe regresje dla zachowania `last_known` CPU, nieznanej partycji
GPU, trybu MIG `Disabled` oraz fallbacku starego query. Nie kompilowano ani
nie uruchamiano testów. `git diff --check` dla zmienionych plików: **PASS**.
Ponowny `just runner-container-status` zakończył się przed uruchomieniem
kontroli błędem procesu `-1073741502` (`0xC0000142`), dlatego kompilacja źródeł
pozostaje **NOT VERIFIED**. `rustfmt` nie ponawiano po wcześniejszym błędzie
Windows `os error 5` przy kanonikalizacji repozytorium.

Bieżący checkout: `master`, `HEAD` i `origin/master`
`e87fca59f5eff6c59c45ab43a424fc5142750568`; bez unmerged entries i staged
paths. HEAD przesunął się podczas pracy do commitów dokumentacji/review innego
zadania; zachowano wszystkie lokalne zmiany. Nie tworzono worktree, nie
stage'owano i nie commitowano. Kolejny krok: uwzględnić CPU quota w pojemności,
następnie ponownie ocenić migrację i recovery rezerwacji.

### E2 — topologia CPU i OS-allowed set — 13.10.2026

Sampler Linux odczytuje online CPU IDs, package/core, SMT siblings i mapowanie
NUMA z sysfs oraz affinity wątku pobierającego próbkę przez `sched_getaffinity`;
to nie dowodzi affinity child workerów. Bufor maski
rośnie przy `EINVAL`, więc nie zakłada stałej granicy 1024 CPU. Quota czyta
z membership/mount mapowania `/proc/self/cgroup` + `/proc/self/mountinfo`,
przechodzi hierarchię cgroup v1/v2 i stosuje najniższy limit do capacity.
Niepoprawny lub niespójny sysfs/affinity nie jest zamieniany na pusty ani
last-known jako wartość current. Windows korzysta z
`GetLogicalProcessorInformationEx`, `GetNumaProcessorNodeEx`, process/group
affinity i zachowuje grupę oraz group-local ID. Jeśli proces należy do wielu
grup, topology pozostaje widoczna, ale allowed set jest `unavailable`, bo ta
ścieżka nie wylicza kompletnej maski wielu grup. `cpu.os_constraints.quota`
pozostaje unavailable na Windows, bo nie jest jeszcze czytany Job Object CPU
rate limit. Weryfikacja kompletnej pojemności cgroup/job limit i jej współpracy
z polityką/lease pozostaje otwarta.

Dodano źródłowe regresje parsera list CPU Linux (zakresy/duplikaty), limitu
cgroup v2 (w tym wartości ułamkowe) oraz ścieżek mountinfo z escapowaniem.
Zgodnie z ograniczeniem projektu nie kompilowano ani nie uruchamiano testów.
`git diff --check` dokumentacji i kontrola whitespace/końca pliku samplera:
PASS. Nie uruchamiano testów, `rustfmt` ani builda: testowe buildy są
zakazane, a poprzednia kontrola `rustfmt` zatrzymała się na Windows
`os error 5`; managed runner wcześniej kończył się `0xC0000142` przed kontrolą.
Linux/Windows compile, managed runtime, worker affinity enforcement, browser
proof i kwalifikacja pozostają **NOT VERIFIED**.

SHA-256 `crates/fullmag-runtime-control/src/compute_node_probe.rs`:
`3962d5936528187d11118bc71962709964f30bfcf2bac1c8478a7877f798c829`.
SHA-256 `docs/design/start-screen/docs/09-compute-environment.md`:
`b56547800e749c88f13dd5c4f17db034a6b01c3b33d9adb15a8ab80c9276a698`.

Checkout potwierdzono jako `master`, HEAD i `origin/master`
`3cc61e8e2ff9e72a5794fe8da7b7011f7f473187`; HEAD przesunął się podczas pracy
do kolejnego niezależnego commita na `master`. Zmiany nadal są dirty i
niestage'owane; zachowano pozostałe istniejące pliki robocze.

### E2 — efektywna pojemność CPU ogranicza admission — 13.10.2026

Odpowiedź użytkownika ustala `stale` po 30 sekundach. Wspólne źródło
`ComputeNodeSnapshot` liczy próbkę jako `current` do dokładnie 30 s włącznie,
a host admission ponownie sprawdza wiek oraz aktywny owner lease.

Owner-bound CPU reservation jest ograniczane przez minimum
`HostResourceLedgerPolicy.total_budget.cpu_millis` i bieżącego
`cpu.effective_capacity_millis`, o ile ten pomiar jest `Available`. Do sumy
wchodzą Tentative, Committed i Quarantined. Kontrola jest przed publikacją nowej
rezerwacji, przed `Tentative→Committed`, przed wydaniem solver/preparation
launch permit oraz przy walidacji permitu przed spawnem. Brak pomiaru nie
zamienia się w zero ani last-known; jawny limit operatora pozostaje wtedy
obowiązujący. Obniżenie pomiaru nie zatrzymuje istniejącego procesu ani nie
blokuje jego ścieżki release.

Dodano regresję źródłową: przy polityce 4000 milli-CPU i bieżącym pomiarze
500, rezerwacje 400 + 200 nie mogą przekroczyć obserwowanej pojemności.
Scoped `git diff --check` dla źródła, specyfikacji i checkpointu: **PASS**.
`cargo fmt --check -p fullmag-session` nie doszedł do formatowania: rustfmt
odmówił kanonikalizacji checkoutu (`os error 5`), więc format pozostaje
**NOT VERIFIED**. Testów jednostkowych ani buildów nie kompilowano/uruchamiano
zgodnie z repozytoryjnym zakazem. Pełne Rust compile/runtime oraz worker
affinity i quota enforcement pozostają **NOT VERIFIED**. Windows Job quota oraz
wielogrupowa affinity nadal są nieraportowane.

SHA-256 `crates/fullmag-session/src/host_resource_ledger.rs`:
`344a4830e220bfae13d86c510aba49e7dd53ec612070578ca765e32ceb1796ce`.
SHA-256 `docs/specs/compute-resource-execution-v1.md`:
`65eba845fe6160025fe39c02dd8367e97fe380972982334e4fcdf44b759346d1`.

Remote `refs/heads/master` i lokalny HEAD potwierdzono bezpośrednio na
`3cc61e8e2ff9e72a5794fe8da7b7011f7f473187`; nie ma nowszego commita do
fast-forward ani merge. Wcześniejszy `FETCH_HEAD` `1ce6fee...` jest przodkiem
HEAD. Brak nierozwiązanych ścieżek w scoped diff; pełny Git status nadal
zgłasza `EPERM` przy odczycie submodule `external_solvers/3`. Nie utworzono
worktree ani build/run zasobów; wszystkie istniejące dirty zmiany zachowano,
bez stagingu i commitów. Następny krok: kontynuować recovery E2, native pools i
measured receipts E3, a następnie E4–E7.

### E3 — wymuszenie CPU placementu przy starcie workerów — 13.10.2026

Supervisor solvera pobiera `cpu_ids` z zatwierdzonego placementu konkretnego
resource ID, a FEM preparation z mapy placementów tej samej host service
config. Legacy launch bez host bindingu przekazuje pustą maskę; puste CPU IDs
oznaczają samo budżetowanie i nie są deklarowane jako affinity.

Linux buduje dynamiczną maskę z CPU IDs, dobiera jej minimalny rozmiar z
`sched_getaffinity` i wywołuje `sched_setaffinity` w `pre_exec`, przed `exec`
programu workera. Odczyt zwrotny przed `exec` wymaga dokładnej zgodności maski;
jeśli OS zawęził ją po zmianie cpuset, spawn kończy się błędem zamiast
uruchamiać worker na mniejszej alokacji. Maska ma limit 16 MiB. Windows przy
żądanej masce ustawia `INHERIT_PARENT_AFFINITY`, przypisuje gated worker do Job
Object, sprawdza processor group, wywołuje `SetProcessAffinityMask` i odczytuje
`GetProcessAffinityMask` przed zwolnieniem startup gate. Proces musi zachować
dokładną maskę w systemowym zbiorze CPU; błąd affinity kończy gated proces i
nie uruchamia solvera.
Placement Windows ogranicza się do jednej grupy; obsługa wielu grup, Job CPU
quota oraz pełna konfiguracja native thread pools pozostają otwarte.

Dodano źródłowe regresje budowania maski Linux (wiele słów, minimalna szerokość
jądra i odrzucenie nadmiernego CPU ID), rzeczywistego odczytu maski uruchomionego
procesu oraz mapowania grup Windows (w tym odmowę maski wielogrupowej). Nie
kompilowano ani nie uruchamiano testów zgodnie z repozytoryjnym zakazem.
`git diff --check` przechodzi dla zmienionych supervisorów, helpera procesu i
checkpointu. Kontrola `rustfmt` zatrzymała się na Windows `os error 5` przy
kanonikalizacji checkoutu; format pozostaje **NOT VERIFIED**.

Zarządzany Windows backend-dev build z tej migawki zakończył się exit 0 i
komunikatem `Windows native Fullmag build is ready`; Cargo zbudowało
`fullmag-api` oraz `fullmag-desktop` dla `x86_64-pc-windows-msvc`, profilu
`backend-dev`. `windows-runtime/build-manifest.json` wiąże build z pełnym
commitem `1c0c35dcf8a4d7dcb0cbde10f3c723c83b729a22`, dirty source snapshot SHA-256
`30ad419872263b72330c5d54f6c6d72007453ef5b64d88c5ff1df37637a23aef` i API
binaru SHA-256 `d40f262ac4e29e5e75d9511ac4c710cbed227da21df1b94605984c84872e24e5`.
SHA-256 zmienionego `owned_worker_process.rs` w tej migawce to
`9c1281a3c8b7dff403144f7cab2b22d76452ccef0db684564abbd2606d8a4dae`.
Build nie kompilował testów, nie uruchomił workera ani nie zmienił działającego
workspace. Log:
`<FULLMAG_PROJECT_STORAGE_ROOT>/builds/fullmag-0950f4dca4ffe38f/windows-native-fdm-cpu-dev/logs/native-build-52682c8398e24769ad66d3cccbb0508a.log`.

Linux build, OS runtime affinity na Linux/Windows, trwały receipt zmierzonego
worker affinity/native threads, NUMA, FEM/GPU runtime, browser proof i
kwalifikacja pozostają **NOT VERIFIED**.
Dotychczasowa kontrola `rustfmt` zatrzymała się wcześniej na Windows
`os error 5`; format tego fragmentu pozostaje **NOT VERIFIED**.

SHA-256 `crates/fullmag-api/src/owned_worker_process.rs`:
`9c1281a3c8b7dff403144f7cab2b22d76452ccef0db684564abbd2606d8a4dae`.
SHA-256 `crates/fullmag-api/src/accepted_study_supervisor.rs`:
`f47dc392bd81e6e8c9d35f56778f8f426be0d819ce2157dfdf657c50ea494702`.
SHA-256 `crates/fullmag-api/src/accepted_fem_preparation_supervisor.rs`:
`1a9e661cf2aa4f5c5edb9519a81776268035ccbe2187b08e9b859b1681ef0e85`.

Po `git fetch origin master` `HEAD`, `refs/remotes/origin/master` i `FETCH_HEAD`
zgadzają się na `1c0c35dcf8a4d7dcb0cbde10f3c723c83b729a22`; nie ma nowszego
commita do fast-forwardu. Brak unmerged entries potwierdzono przez
`git ls-files -u`. `git diff --check` dla E3 źródeł i checkpointu: **PASS**.
Wszystkie zmiany pozostają niestage'owane; nie tworzono worktree ani commitów.

Po Windows buildzie `master` przesunął się do
`631895d044655fdc58fefdaafdd22b5945f9b872`; `origin/master`, `origin/HEAD` i
bezpośrednie `git ls-remote origin refs/heads/master` zgadzają się. Nowy commit
zmienia wyłącznie `docs/plans/active/refactor_runtime/final/p8/53bm-camera-preservation.md`,
więc skompilowane źródła compute/API pozostały identyczne. `git ls-files -u`
nadal nie zwraca konfliktów.

Microsoft dokumentuje, że `INHERIT_PARENT_AFFINITY` dziedziczy affinity
rodzica, a `SetProcessAffinityMask` ogranicza maskę do jednej grupy na
systemach >64 CPU: [Process Creation Flags](https://learn.microsoft.com/en-us/windows/desktop/ProcThread/process-creation-flags),
[SetProcessAffinityMask](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setprocessaffinitymask).
Te źródła potwierdzają użyty kształt API, nie wynik wykonania na tym hoście.

### E3 — środowisko pul wątków z alokacji — 13.10.2026

Host-bound accepted worker przed wydaniem launch permitu odzyskuje dokładny
durable `Start`, przyjęty `RunSpec` i `ProblemIR`. Środowisko potomne łączy
typed/legacy żądanie liczby wątków z cardinality CPU IDs przypiętych do lease'a;
brak przydzielonych CPU lub żądanie większe od maski kończy się błędem przed
spawnem. Auto dla ogólnego CPU i auto dla native FEM mają osobne wartości:
`FULLMAG_CPU_THREADS_AUTO_RESOLVED` oraz
`FULLMAG_NATIVE_THREADS_AUTO_RESOLVED`. FEM respektuje nową wartość native i
zachowuje starszą zmienną jako fallback. GPU z native auto dostaje limit 1;
OpenMP otrzymuje limit i blokadę nested teams, a domyślne pule BLAS są ustawione
na 1. Odziedziczone CPU/Rayon/OpenMP/BLAS i pinning GOMP/KMP są usuwane, a
wartości GPU nadal pochodzą wyłącznie z UUID allocation. Legacy worker bez host
allocation zachowuje dotychczasowe środowisko. Jawne `native_threads` i
`blas_threads` nadal są blokowane przez planner capability gate; ten kod ich nie
kwalifikuje ani nie dowodzi rzeczywistego rozmiaru utworzonych pul.

Dodano regresje źródłowe mapowania auto CPU/native i BLAS, odrzucenia oversubscription,
izolacji odziedziczonego środowiska oraz pierwszeństwa nowego native resolved
limit z kompatybilnym fallbackiem. Testów nie kompilowano ani nie uruchamiano
zgodnie z zakazem repozytorium. `git diff --check` przechodzi; `rustfmt` nadal
zwraca Windows `os error 5` przy kanonikalizacji checkoutu. Zarządzany build
został zatrzymany przed kompilacją przez zajęty heavy slot; źródła tego fragmentu
pozostają **NOT VERIFIED**.

Zapis `FETCH_HEAD` w sandboxie odmówiono (`Permission denied`). Bezpośredni
odczyt remote, lokalny `HEAD` i `origin/master` są obecnie zgodne na
`29ca31c72dd1d4d7901f88843c0e87e639372956`. Od `802fc997e` doszedł commit
`29ca31c72` z poprawką dokumentacji camera readiness; nie zmienia żadnego z
dirty plików tego zadania. Wcześniejsze `8cf2e569c` i `802fc997e` również są
poza zakresem.

Ponowiona próba zarządzanego `windows-backend-dev` zakończyła się przed
kompilacją po 120 s oczekiwania na `native Windows Fullmag build`. Ostatni
`build-status.json` opisuje poprzedni ukończony build z 19:18 UTC i PID `79048`,
który już nie działa; heavy lock nadal jest zablokowany do odczytu, a CIM nie
udostępnił procesu trzymającego uchwyt. Nie wykonano recovery ani nie przerwano
procesu. Nowe źródła pozostają **NOT VERIFIED** kompilacyjnie.

SHA-256 `crates/fullmag-api/src/accepted_study_supervisor.rs`:
`109e331a4df861d68bab7558a9160c95e996902a59a33096162a19cbad2ace05`.

### E3 — środowisko FEM preparation z rezerwacji — 13.10.2026

Host-bound FEM preparator odrzuca pustą alokację CPU i dostaje limity Rayon,
OpenMP, BLAS oraz Gmsh wyprowadzone z CPU IDs przydzielonych jego preparation
lease. Odziedziczone limity pul i affinity GOMP/KMP są czyszczone przed
ustawieniem wartości dla dziecka. Ścieżka legacy bez host bindingu zachowuje
dotychczasowe środowisko. Dodano regresje źródłowe pustej alokacji, mapowania
liczby CPU na Gmsh/OpenMP i izolacji env; testów nie kompilowano ani nie
uruchamiano.

SHA-256 `crates/fullmag-api/src/accepted_fem_preparation_supervisor.rs`:
`6c42787978b35c0fefa86e4c4b384412efb06ed893788b6e5688c343fae7c68b`.

### E3 — jedna aktywna pula dla natywnego FEM CPU — 13.10.2026

Supervisor używa odzyskanego `ExecutionPlan` do rozpoznania lane’ów FEM przed
wydaniem launch permitu. Dla natywnego FEM CPU proces potomny dostaje Rayon=1
i OpenMP ograniczony do alokacji; runner także tworzy jednowątkową pulę
sterującą podczas natywnego solve. Dla natywnego FEM z pojedynczym wątkiem
OpenMP, w tym GPU z domyślnym native=1, pula Rayon zachowuje przydzielony budżet
CPU. FDM nie zmienia swojej puli. Dodano regresje źródłowe mapowania oraz
wyboru puli runnera; nie kompilowano ani nie uruchamiano testów.

Scoped `git diff --check` dla trzech źródeł E3: **PASS**. Kompilacja runnera i
API, rzeczywiste limity runtime oraz execution receipts pozostają
**NOT VERIFIED**; zarządzany Windows build nadal nie może zająć heavy slotu.

SHA-256 `crates/fullmag-runner/src/lib.rs`:
`9e241356313bf514800db2fd6f4ab98c690bed1acb597b0d84917a3782786bcb`.

Szacunkowe pokrycie całości E0–E7 wynosi 50–55%: E0–E1 są w większości
zrealizowane; E2–E5 mają znaczące, lecz niepełne wdrożenia; E6–E7 pozostają
nierozpoczęte. To szacunek zakresu wymagań, nie liczby plików. W E3 nadal
otwarte są dowód braku nakładania pul Rayon/OpenMP dla każdej lane, raport
rzeczywistego enforcementu i pomiaru w receipt, Linux cgroup/quota, Windows
CPU sets/multi-group/Job quota oraz kompilacja i runtime. Kolejne kroki E2–E5
obejmują recovery i pełne uzgodnienie admission, profile/API/browser proof,
batch cancellation/restart oraz kwalifikację równoległych cases.

Scoped status obejmuje osiem wymienionych w tym zadaniu plików; index i
unmerged entries są puste. Pełny status nadal napotyka brak dostępu do
submodule `external_solvers/3`. Źródła thread policy pozostają **NOT VERIFIED**
kompilacyjnie; testów nie kompilowano ani nie uruchamiano zgodnie z zakazem
repozytorium. Nie wykonano recovery zajętego heavy locka.

### E4 — podwidoki Compute w Settings — 13.10.2026

Istniejąca strona Settings grupuje teraz Overview, Resources i Profiles pod
wspólnym selektorem z prymitywu `SegmentedControl`. Overview pokazuje bieżącą
telemetrię i runtime lanes; Resources pokazuje walidowany snapshot hosta,
topologię CPU i tożsamość GPU, z jawną informacją, że są to odczyty i ekran nie
zmienia polityki zasobów. Brak snapshotu ma własny stan. Panel profili pozostaje
zamontowany podczas przełączania podwidoków, aby zachować draft i stan
uzgadniania publikacji.

Dodano regresje SSR dla selektora Settings i granicy tylko do odczytu widoku
Resources. `git diff --check` dla czterech zmienionych plików: **PASS**;
ukierunkowany ESLint dla obu źródeł i obu plików testowych: **PASS**. Testów
nie uruchamiano zgodnie z zakazem repozytorium. React Doctor wybrał projekt,
lecz przez około dwie minuty nie zwrócił wyniku; przerwano wyłącznie ten skan.
Pełny typecheck pominięto, bo repozytoryjny config obejmuje `*.test.tsx`.
Browser proof i edycja host resource policy pozostają otwarte.

SHA-256 `apps/control-room/src/modules/start/sections/ComputeEnvironmentSettings.tsx`:
`62e925ef7ebd0efbc60821bf578a8cc37b523849eefc9215594dac23b30338dd`;
`SettingsSection.tsx`:
`9a551b4c453c5089484fe5fa2773b1e39160f726f570dd2901a3f53070911cd3`;
`ComputeEnvironmentSettings.test.tsx`:
`132e0ccf1769a1e30ca7d8b27cbd4e6435948df19cac97a2b9bec47f9292d660`;
`IndexedLocations.test.tsx`:
`52ceec0777c9bbd0bfd9216f6e9078ca6a55c9265125fad067154a2c9251bdfa`.

### E4 — duplikowanie profili wykonania — 13.10.2026

Lista opublikowanych profili ma teraz osobne akcje **Duplicate** i **New version**.
Duplicate klonuje pełny profil, zachowuje sparse/advanced defaults, nadaje nowe
ID `exec:copy:<uuid>` i rozpoczyna od wersji `1`; dalej korzysta z istniejącej
publikacji niezmiennej wersji, `expected_revision` i `client_intent_id`. Układ
akcji zawija się na wąskich szerokościach.

Dodano regresję modelu dla kopiowania tożsamości, wersji, wartości zasobów i
izolacji obiektu źródłowego. `git diff --check` dla czterech zmienionych plików:
**PASS**. Testów nie kompilowano ani nie uruchamiano zgodnie z zakazem
repozytorium. ESLint i `check:architecture-hygiene` zakończyły się przed
kontrolą przez `EPERM: realpath` dla `apps/control-room`; jakość tych bramek
pozostaje **NOT VERIFIED**.

Próba otwarcia managed Windows workspace na wolnym porcie `3197` przez
`just windows-ui dev 3197 false dev` zakończyła się przed dostępnością UI kodem
`-1073741502`; nie powstał listener i nie uzyskano browser proof. Nie
uruchamiano buildu ani backendu. Naprawa/wyjaśnienie startu hostowego launchera
pozostaje otwarte.

Aktualny lokalny `master`, `origin/master` i odczyt live remote są zgodne na
`48d3893cca7d7f7fdd0b7408051d3955039318ac`. Index i unmerged entries są puste;
pełny `git status` nadal nie może wejść do submodułu `external_solvers/3`, więc
scoped status jest granicą listy zmian. Nie stage'owano plików. Niezależny
`docs/plans/active/refactor_runtime/final/p8/53bm-camera-preservation.md`
pozostaje zachowany.

Szacunkowe pokrycie całości pozostaje **50–55%**: ten fragment domyka jedną
akcję katalogu profili, ale nie zamyka policy Apply/Cancel, browser proof,
pełnego API, batch lifecycle ani etapów E6–E7.

### E4 — stabilne prezentowanie metadanych inventory — 13.10.2026

Podgląd inwentarza hosta formatuje próbkę w jawnej strefie UTC i stałym locale,
żeby tekst renderowany przez serwer nie różnił się od pierwszego renderu
przeglądarki. Odczyty CPU/RAM/VRAM poza bezpiecznym zakresem integera nie są
zaokrąglane do pozornie dokładnej wartości. Dodano regresję SSR dla widocznego
czasu UTC. `git diff --check -- apps/control-room/src/modules/start`: **PASS**;
ukierunkowany `pnpm exec eslint` dla komponentów inventory i ich modelu/SSR testu:
**PASS**. Testów nie kompilowano ani nie uruchamiano zgodnie z zakazem
repozytorium. Browser proof pozostaje **NOT VERIFIED**: polityka bezpieczeństwa
przeglądarki zablokowała dostęp do otwartego adresu localhost.

Repo pozostaje na `master`, `HEAD`, `origin/master` i live remote są zgodne na
`279b634ea57f0d6383d58793c9e065e58ad45eea`; unmerged entries i staged paths są
puste. Wspólne dirty pliki pozostają zachowane i niestage'owane.
