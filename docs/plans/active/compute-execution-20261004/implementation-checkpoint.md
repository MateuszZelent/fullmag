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
