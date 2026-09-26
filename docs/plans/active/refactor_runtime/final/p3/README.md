# P3 — studies, RunSpec i trwałe przyjęcie

Ten katalog zapisuje przyrosty P3. P3 nie jest jeszcze zamknięte: kontrakt
study, identity admission, format komunikatów, coordinator state machine i
trwałe zastosowanie decyzji retry są typowane. Jednorazowy
`fullmag-api-accepted-worker` wykonuje ograniczoną ścieżkę FDM CPU double
strict, a `fullmag-api-accepted-supervisor` uruchamia go jako osobny proces pod
dokładnym claimem i lease. Supervisor stosuje globalny dla store limit jednego
workera, czeka na exit, uzgadnia journal/inbox/completion barrier i zwalnia
lease dopiero po potwierdzonym terminalnym sukcesie. Pending effect zachowuje
lease; pending sprzed pierwszego side effectu lub z ukończonym receiptem może
zostać odtworzony bez drugiego uruchomienia solvera. Supervisor wymaga jawnego
`--worker-timeout-seconds`, a po przekroczeniu monotonicznego deadline zabija
proces, czeka na potwierdzony exit i dopiero potem rekoncyliuje trwały stan.

Brakuje automatycznego wyboru taska, puli większej niż jeden, heartbeat/Stop ACK
dla zdalnego transportu, anulowania przed `Start`, retry/orphan reconciliation
oraz process E2E pozostałych lane'ów.
Runtime/browser i kwalifikacja fizyczna także są otwarte. Szczegóły opisują
[`28-one-shot-accepted-worker-process.md`](28-one-shot-accepted-worker-process.md),
[`29-accepted-worker-supervisor.md`](29-accepted-worker-supervisor.md),
[`30-supervisor-timeout.md`](30-supervisor-timeout.md),
[`31-supervisor-worker-e2e.md`](31-supervisor-worker-e2e.md),
[`32-supervisor-process-heartbeat.md`](32-supervisor-process-heartbeat.md),
[`33-operator-task-cancellation.md`](33-operator-task-cancellation.md)
i [`34-supervisor-cancel-e2e.md`](34-supervisor-cancel-e2e.md).

API ma jawny adapter allow-listy `RunResult` → typowane payloady dla
wspieranych wyjść. Szczegóły i wcześniejszy dowód opisuje
[`20-runner-output-allowlist-adapter.md`](20-runner-output-allowlist-adapter.md).

Audyt brakującego połączenia accepted task → runner → CAS/katalog artefaktów →
terminalny completion oraz kryteria kolejnego slice'u opisuje
[`23-runner-worker-output-publication-bridge.md`](23-runner-worker-output-publication-bridge.md).

Syntetyczny CAS input adapter wiążący `ResolvedTaskInput` z kopią planu
wykonawczego opisuje checkpoint
[`24-cas-input-to-runner-plan.md`](24-cas-input-to-runner-plan.md). Nie jest
jeszcze wywoływany przez production worker.

Fenced, wyłączny katalog outputu pojedynczego attemptu oraz regresję claim/lease
opisuje [`25-private-attempt-output-directory.md`](25-private-attempt-output-directory.md).
To izoluje miejsce zapisu, ale nie uruchamia supervisora ani workera.

Testowe przejście durable `Start` → rzeczywisty FDM CPU → fenced CAS, wraz z
provenance oraz replay bez ponownego wykonania, opisuje
[`26-durable-start-fdm-cpu-execution.md`](26-durable-start-fdm-cpu-execution.md).
To weryfikuje runner w regresji API; produkcyjny supervisor, transport,
restart/recovery i pozostałe lane'y są nadal otwarte.

Niezmienny receipt `started` przed solverem i receipt `completed` wiążący
deklarowane payloady z CAS są odczytywane ponownie przed publikacją. Test
potwierdza odczyt przez świeży uchwyt storage i replay ACK bez ponownego
solvera; nie symuluje procesu potomnego ani awarii/restartu w każdym punkcie
zapisu. Poprzedni checkpoint receiptów:
[`27-durable-worker-execution-receipt.md`](27-durable-worker-execution-receipt.md).

Wersjonowanie i przekazanie czasu zakończenia dla `TimeEvolution` opisuje
checkpoint [`14-time-evolution-horizon.md`](14-time-evolution-horizon.md).

Szczegółowa granica durable coordinator journal jest opisana w
[`03-coordinator-journal.md`](03-coordinator-journal.md).
Rozdzielenie Live preparation v1 i accepted-run FDM preparation v2 opisuje
[`06-accepted-run-preparation.md`](06-accepted-run-preparation.md).
Trwały, niezmienny receipt per task oraz jego archiwizację opisuje
[`07-task-preparation-receipts.md`](07-task-preparation-receipts.md).
Typed odczyt trwałego receipt przez immutable accepted-study snapshot opisuje
[`08-typed-task-preparation-reader.md`](08-typed-task-preparation-reader.md).
Połączenie receipt z trwałym `Prepare` outboxem opisuje
[`09-durable-prepare-outbox.md`](09-durable-prepare-outbox.md). Regresja API
jest zapisana, lecz nieuruchomiona; adapter zapisuje komendę do journalu, ale
nie uruchamia transportu ani workera.
Read-only odtworzenie bieżącego claimu z run catalog i resource lease opisuje
[`10-current-task-claim-recovery.md`](10-current-task-claim-recovery.md); nie
tworzy ono nowego claimu ani nie odtwarza stanu z coordinator journal.
Genesis coordinatora, watermark projekcyjny catalogu, auto-reconciliation
transitionów i fail-closed recovery opisuje
[`11-coordinator-watermark.md`](11-coordinator-watermark.md). Kod i regresje
są zapisane; wymagają ponownego managed run przed zaliczeniem.
Store-backed resolver automatycznie wyprowadza wejścia `StepOutput` z deklaracji
zaakceptowanego portu, durable lifecycle i katalogu artefaktów. Dispatch study
sprawdza wymagane wejścia i sukces tasków źródłowych, a każde wejście musi
odpowiadać dokładnemu artefaktowi, portowi i `case_id` z bieżącego attemptu.
Append-only artifact catalog zachowuje
immutable wpisy poprzednich attemptów, ale nowe wpisy muszą przejść bieżący
attempt/epoch fence. Nowe study outputy publikuje się przed `Completed` pod
aktywnym lease; replay jest idempotentny, a nowe wpisy po zakończeniu są
odrzucane. To blokuje spóźnionego workera bez usuwania jego diagnostyki.
Runtime-control ma
fenced publication helper, ale supervisor nie wywołuje go jeszcze z wynikami
workerów. Granice opisuje
[`12-study-dependency-dispatch.md`](12-study-dependency-dispatch.md).

## Przyrost P3-A — typed study contract

`crates/fullmag-authoring/src/study_contract.rs` wprowadza wersjonowany
`StudyPlan` (`study_plan.v2`) jako granicę pomiędzy authoringiem a plannerem:

- każdy `StudyStep` ma osobne referencje `model`, `solver_config`,
  `discretization` i `execution_profile`; żadna z nich nie wybiera backendu ani
  nie odczytuje zmiennego `current`;
- primitive, macro i group są reprezentowane przez typowane `StudyStepKind`;
  grupa przechowuje jawne zależności dzieci, a porty mają określony
  `StudyPortDataKind`;
- `StudyInputSource` dopuszcza wyłącznie authored initial state, pinned
  artifact z SHA-256, step output z `step_id`/`port`/`case_id` albo explicit
  continuation z `run_id`;
- acceptance (`Any`, `Converged`, `Tolerance`, `StepLimit`) i acquisition
  (`Exclusive`, `Shared`, `PreferResident`, `Fresh`) są odrębnymi kontraktami;
- walidacja sprawdza referencje, typy portów, duplikaty i cykle; kolejność
  topologiczna nie jest zgadywana przez UI;
- nieznany `kind` jest zachowany jako `Unsupported` wraz z pełnym payloadem i
  blokuje `validate_for_execution()`. Nieobsługiwane dane nie są cicho
  odrzucane;
- `StudyPlan::from_pipeline()` wykonuje jawny adapter dotychczasowego
  `StudyPipelineDocument`. Payload primitive/macro/group zostaje w
  `legacy_payload`, jawny `Run.until_seconds` trafia dodatkowo do typowanego
  pola, a domyślne referencje są podawane przez caller, nie wymyślane przez
  solver;
- dla każdego `ProblemIR` z `TimeEvolution` lowering wymaga dodatniego,
  skończonego `until_seconds` z zaakceptowanego `StudyPlan v2`; starszy plan v1
  pozostaje czytelny, ale nie dostaje domyślnego horyzontu.

Kontrakt zachowuje canonical bytes i SHA-256 planu. Nie jest to jeszcze
materializacja runu, ale `fullmag-plan::lower_study_plan` udostępnia już
jawną granicę lowering: application/catalog resolver dostarcza immutable
`ProblemIR` dla każdego kroku, a canonical `plan(&ProblemIR)` wykonuje
walidację i capability resolution, zachowując requested/resolved backend w
`ExecutionPlanIR`. Brak resolvera lub błąd capability kończy się błędem
kroku; nie ma odczytu `current` ani cichego pomijania `Unsupported`.

Per-step horyzont wykonania oraz wersjonowanie `StudyPlan v2` i
`study_execution_plan.v2` opisuje [ADR-0036](../../../../../adr/0036-study-step-runtime-horizon.md).
Runner boundary musi przekazać zaakceptowane `until_seconds` bez wyliczania go
z okresu zapisu, `legacy_payload` ani wartości domyślnej.

`fullmag-plan` ma także `study_problem_catalog.v1` i
`lower_study_plan_with_catalog`. Katalog przechowuje jeden zweryfikowany,
niemutowalny snapshot `ProblemIR` dla każdego włączonego kroku oraz wiąże go
z dokładnym `study_id`, rewizją, digestem planu i wszystkimi czterema
referencjami kroku. Brak snapshotu, snapshot dla wyłączonego kroku, zmiana
referencji albo niepoprawny `ProblemIR` kończą się błędem przed plannerem.
Nie ma lookupu `current` ani automatycznego uzupełniania katalogu.

## Przyrost P3-B — immutable RunSpecification

`crates/fullmag-application/src/run_spec.rs` wprowadza:

- `ProjectSnapshot` z `ProjectId`, revision i hash-em dokładnych bajtów
  definicji;
- `StudyReference` z jawnym `study_id`, `plan_version` i
  `plan_sha256` dokładnego typowanego planu;
- `RequestedExecution` z walidowanym backend/device/precision/mode;
- `RunDependency`, która rozróżnia authored initial state, pinned artifact,
  step output i explicit continuation;
- `ImmutableAssetReference` z wymaganym content SHA-256;
- `RunSpecification` z parametrami, seedami, zależnościami i immutable assets;
- `study_catalog_sha256` wiążący kompletny katalog `ProblemIR` dla włączonych
  kroków study z fingerprintem RunSpec;
- `RunIntentLedger`, który przy tym samym kluczu zwraca replay tego samego
  `run_id`, a dla zmienionego payloadu odmawia przez
  `IdempotencyConflict`.

Specyfikacja jest kompletna w momencie przyjęcia. Nie ma pustego pola, które
można później uzupełnić z `current` UI; zależność do przyszłego meshu lub
equilibrium musi być jawnie nazwana jako `RunDependency`.

## Trwały accepted-intent journal

`crates/fullmag-session` dodaje `FmsRunIntent` oraz
`SessionStore::commit_run_intent`:

- rekord `runs/<run_id>/run_intent.json` zawiera pełny JSON specification,
  idempotency key, `run_id`, czas przyjęcia i canonical SHA-256 payloadu;
- zapis odbywa się przez istniejący single-writer lease i atomową publikację
  jednego pliku przed zwróceniem `Accepted`;
- ponowienie tego samego klucza i payloadu zwraca `Replayed` z pierwotnym
  `run_id`, a zmiana payloadu kończy się odmową;
- `read_run_intent` i `find_run_intent` pozwalają odtworzyć decyzję po restarcie;
- reachability GC oraz eksport/import `.fms` rozpoznają ten plik jako typowany
  dokument, więc nie powstaje osobny, ukryty root danych.

`crates/fullmag-api/src/run_intent_persistence.rs` łączy typowany
`RunIntent` z trwałym `FmsRunIntent`: waliduje kompletną specyfikację,
wiąże `ProjectSnapshot` z dokładnymi bajtami `ProjectEnvelope.raw_definition`,
publikuje te bajty w CAS przed przyjęciem, waliduje `StudyPlan` do wykonania
i porównuje `study_id`, wersję oraz canonical SHA-256 z RunSpec. Kanoniczne
bajty study trafiają do CAS przed przyjęciem. Adapter waliduje także
`StudyProblemCatalog::validate_for(study)`, wymaga zgodności jego canonical
SHA-256 z RunSpec i przypina katalog w CAS. Adapter wymaga także bajtów
każdego `immutable_asset`, porównuje ich SHA-256 i przypina mapę `asset_id ->
object_ref` w CAS. Rekord zapisuje jawne `definition_object_ref`,
`study_object_ref`, `study_catalog_object_ref` i `asset_object_refs`;
reachability oraz eksport/import `.fms` śledzą wszystkie odnośniki. Magazyn odmawia publikacji, jeśli którykolwiek
obiekt nie istnieje, a replay ponownie dekoduje oryginalny RunSpec i zwraca
pierwotny `run_id`. Regresje źródłowe obejmują restart magazynu, konflikt
zmienionego payloadu, zmianę bajtów definicji/study/katalogu/assetu i brak obiektu CAS.
`commit_archived_run_intent` otwiera dokładne bajty przenośnego archiwum
przez jeden `FileProjectRepository` i wymaga jawnej mapy `asset_id ->
project/assets/...`; brak ścieżki w archiwum lub archiwum tylko do odczytu
blokuje przyjęcie. Jest to wewnętrzna granica rozwiązywania wejścia, bez
odwołania do bieżącej sesji ani cache runtime.
Publiczny `POST /v2/persistence/projects/{project_id}/runs` przyjmuje pełne, przypięte
wejście: bajty archiwum, typowany `RunIntent`, `StudyPlan`, katalog
`ProblemIR` oraz mapę assetów. Weryfikuje `project_id` z URI wobec RunSpec,
przenosi odczyt archiwum i trwały zapis poza wątek HTTP oraz zwraca pierwotny
`run_id` przy idempotentnym replay. Odpowiedź jawnie podaje
`execution_state=pending_materialization`: sam zapis nie tworzy katalogu
tasków ani nie uruchamia workera. Odrębny idempotentny
`POST /v2/persistence/projects/{project_id}/runs/{run_id}/materialization`
odczytuje przyjęte obiekty CAS, sprawdza ich powiązanie z RunSpec, wykonuje
kanoniczny lowering study i zapisuje katalog tasków o stabilnych ID i
fingerprintach wejścia. Taski pozostają `accepted/blocked` do czasu
przygotowania i rozwiązania zależności; odpowiedź ma
`execution_state=pending_preparation`. Replay Submit odczytuje stan katalogu
i również zwraca `pending_preparation`, jeżeli materializacja już zaszła.
`GET /v2/persistence/projects/{project_id}/runs/{run_id}` czyta po restarcie
trwały RunIntent i opcjonalny katalog. Zwraca `catalog_state`, rewizję oraz
typowane lifecycle/readiness/observation tasków i żądaną konfigurację
wykonania; nie korzysta z aktywnej sesji i nie interpretuje samego katalogu
jako uruchomionego workera. Fasada `ControlRoomApi.persistence.projects.getRun`
używa tej ścieżki. Sekcja Study w Control Room listuje trwałe runy otwartego
projektu i po wyborze pokazuje katalog oraz lifecycle/readiness tasków. Dane
pozostają zasobami serwera kluczowanymi przez `ProjectId` i `RunId`.
Konflikt istniejących tożsamości blokuje publikację. Źródłowy test trasy obejmuje accepted/replay,
konflikt klucza i brak zależności od aktywnej sesji; test Rust pozostaje
nieuruchomiony zgodnie z aktualnym zakazem kompilacji testów jednostkowych.
Przed publikacją tasków materializator porównuje jawny backend, tryb i
precyzję RunSpec z planem każdego wykonywalnego kroku. Dla FEM eigen, gdzie
planner publikuje requested/resolved device, odrzuca również różnicę lub
fallback sprzeczny z jawnym CPU/GPU. Pozostałe rozstrzygnięcia urządzenia są
bramką późniejszego preparation/runtime; taski pozostają `blocked`, więc
materializacja nie dowodzi wykonania na żądanym urządzeniu. Zarządzany check
źródeł API po tej zmianie **PASS** (receipt
`windows-api-source-check/api-source-check/58faa080e38a43629a279d3a47ffe8fe`);
nowe regresje źródłowe są zapisane, ale nieuruchomione.
Trasa zapisuje nowy intent pod `FULLMAG_RUNS_ROOT/session-store`, po walidacji
zmiennych przekazanych przez zarządzany resolver i markera storage. Uruchomienie
API bez tej konfiguracji kończy się odmową zapisu; nie kieruje nowych runów do
legacy `.fullmag/local-live/session-store`. Resolver bieżącego checkoutu
wskazał `runs/fullmag-0950f4dca4ffe38f` i istniejący marker projektu.
Obecna komenda `run` nadal używa starej kolejki sesji, a endpoint projektu
zwraca archiwum tylko w pamięci. Powiązanie UI z nowym Submit i
materializacją oraz worker transport są kolejnymi bramkami; fasada API ma
typowaną metodę `materializeRun`.
Źródłowy check API ma osobną receptę `just check-api-source` przez zarządzany
profil bez compatibility links. Po naprawie pięciu błędów typowania w handlerze
polityki realtime zakończył się **PASS** (receipt
`windows-api-source-check/api-source-check/8790d5a6867a4bda86b754b1d33ace53`,
`exit_code=0`, `source_changed_during_run=false`). Istniejącego rzeczywistego
katalogu `.fullmag` nie przenoszono ani nie usuwano. Po dodaniu digestu study,
katalogu ProblemIR i odnośników CAS ponowny zarządzany check API również
przeszedł **PASS** (ostatni receipt
`windows-api-source-check/api-source-check/1525266d9e36489497fb151b752cde7d`).
Po przypięciu immutable assets następny check API przeszedł **PASS** (receipt
`windows-api-source-check/api-source-check/32a7b95c330345de967bac046ab8491f`,
`source_changed_during_run=false`).
Po dodaniu archiwalnego wejścia adaptera check API przeszedł **PASS** (receipt
`windows-api-source-check/api-source-check/927f226f754d451daa2c4771d8cc4a79`,
`source_changed_during_run=false`).
Po podłączeniu publicznej trasy check API przeszedł **PASS** (receipt
`windows-api-source-check/api-source-check/32e5ec23207b43f69cc33ad90567c549`,
`source_changed_during_run=false`). Po doprecyzowaniu stanu odpowiedzi
i statusu konfliktu check ponowiono: **PASS** (receipt
`windows-api-source-check/api-source-check/8b0f867bfa9e4315bc6300c5f44625dd`,
`source_changed_during_run=false`). OpenAPI wygenerowano przez zarządzaną
receptę `just generate-api-openapi` (receipt
`windows-api-source-check/api-openapi-codegen/21a504bf91774c61b933e46e7a7343c1`,
`source_changed_during_run=false`), a typy, listę ścieżek i transport klienta
odświeżono. `ControlRoomApi.persistence.projects.submitRun` używa tej ścieżki;
frontend typecheck i API hygiene **PASS**. HTTP test pozostaje **NOT RUN**;
payloady `run_intent`, `study_plan` i `study_problem_catalog` mają walidowane
kontrakty Rust. Ich root OpenAPI jest teraz obiektem mapy JSON, a TypeScript
generuje `Record<string, unknown>`; zagnieżdżony schema `ProblemIR` nadal nie
jest w pełni rozwinięty w OpenAPI. Bieżący managed
`just generate-api-openapi` **PASS** (receipt
`windows-api-source-check/api-openapi-codegen/85721129616549b6b1c5ca4f7dd03fcc`),
`pnpm --dir apps/control-room generate:api-v2-types` **PASS** i zarządzany
`just check-api-source` **PASS** (receipt
`windows-api-source-check/api-source-check/0de7fc89a2f241c1aaa0b0577cc5811f`).
Pierwsze wywołanie nowej recepty zostało błędnie przechwycone przez domyślny
dispatch `just_storage_shell.sh` i uruchomiło istniejącą trasę testów sesji
(receipt `windows-session-check/session-persistence/9732f524d69a4b29a77a55e4cf2f6e43`).
To było niezamierzone naruszenie bieżącego zakazu uruchamiania testów
jednostkowych; dispatch poprawiono przed właściwym codegenem. Tego receiptu
nie zalicza się jako dowodu odbioru P3.
Odczyt inwentarza naprawiono,
aby ignorował tablicowe metryki w `storage/index`; inwentarz jest tylko odczytem,
nie zgodą na migrację lub usunięcie. Celowana regresja Python inwentarza:
**1 passed**. Testy jednostkowe Rust nie były kompilowane; zachowanie
adaptera podczas wykonania pozostaje `NOT VERIFIED`.

GET lista/szczegół runu jest używana przez sekcję Study: można odświeżyć listę,
przejść strony i odczytać task catalog po wyborze runu. Ostatnie kontrole UI:
frontend typecheck, scoped ESLint zmienionych plików, API hygiene, architecture
hygiene i repository consistency **PASS**; HTTP, restart i browser smoke
pozostają **NOT VERIFIED**. Pełny `pnpm --dir apps/control-room lint` nadal
zatrzymuje się na błędach w szerszym checkoutcie: poprzedni przebieg wykazał
17 błędów i 2 ostrzeżenia; zmieniony P3a loader miał jedno z tych ostrzeżeń,
które następnie naprawiono. Pozostałe błędy wymagają osobnego zakresowego
przeglądu, nie są maskowane tym celowanym wynikiem.

## Tożsamość próby i wejście resolved

`crates/fullmag-application/src/execution.rs` wprowadza kontrakty, które nie
mogą być zastąpione numerem sesji ani aktywnym projektem:

- `TaskId` identyfikuje logiczny task w runie;
- `AttemptId` identyfikuje konkretną próbę po retry;
- `OwnershipEpoch` rośnie przy każdej nowej próbie i jest częścią prawa do
  publikacji;
- `TaskClaim` zawiera epoch, lease token, resource budget i heartbeat sequence;
- `TaskRecord` rozdziela lifecycle tasku od `blocked`, stanu obserwacji i oceny
  naukowej, a `fence()` odrzuca stary claim;
- `ResolvedTaskInput` zachowuje fingerprint RunSpec, fingerprint planu,
  requested execution i konkretne content hashes wejść.

To jest kontrakt przed workerem: przydział i reconciliation po awarii są
oddzielone od transportu oraz supervisora.

## Przyrost P3-B — worker protocol identity

`crates/fullmag-application/src/execution.rs` dodaje `worker_protocol.v1`:

- `ClaimIdentity` niesie wyłącznie `RunId`, `TaskId`, `AttemptId`,
  `OwnershipEpoch` i token lease;
- `WorkerCommandEnvelope` ma `message_id`, monotoniczną sekwencję i jawny
  command (`Prepare`, `Start`, `Heartbeat`, `Stop`, `Release`);
- `WorkerEventEnvelope` używa tej samej granicy identity, a zakończenie niesie
  odrębną ocenę `ScientificAssessment`;
- `WorkerProtocolLedger` deduplikuje ten sam komunikat po digest, odrzuca
  konflikt ponownie użytego `message_id`, stare sekwencje, obcy claim i każdy
  event po terminalnym zakończeniu;
- `Prepare` dodatkowo sprawdza, że `ResolvedTaskInput` ma identyczny run/task/
  attempt/epoch. Nie ma ścieżki, która mapuje stary event na nowy attempt.

Deserializacja `ResolvedTaskInput` omija konstruktory `RunId`, `TaskId`,
`AttemptId` i `OwnershipEpoch`. Walidator granicy workera sprawdza więc
ponownie portable IDs i dodatni epoch. Regresja źródłowa podstawia do
zdeserializowanego wejścia traversal/empty ID i epoch zero; jest zapisana,
ale `NOT RUN` przy bieżącym zakazie kompilacji testów jednostkowych.

Jest to kontrakt procesowy przed transportem. `WorkerCoordinator` w
`crates/fullmag-application/src/coordinator.rs` dodaje outbox commandów,
fenced apply eventów, fazy `Preparing/Running/Stopping/Terminal/Released` oraz
jawny `Release` dopiero po terminalnej obserwacji. Ledger nie jest jeszcze
trwałym journalem coordinatora, a coordinator nie zatrzymuje procesu workera
i nie dowodzi zwolnienia GPU/VRAM po utracie heartbeat.

`RetryDecision` (`retry_decision.v1`) rozdziela decyzję po reconciliation od
samego przydzielenia nowej próby. Warstwa application waliduje decyzję, a
`SessionStore` utrwala jej fenced snapshot w
`runs/<run_id>/retry_decisions/<decision_id>.json`. Dopuszcza `Retry`, `DoNotRetry` albo
`AwaitReconciliation`, zawsze wskazuje trigger, reason i bieżący claim.
`TaskRecord::apply_retry_decision()` dla retry czyści stary claim przed
powrotem do `Queued`; kolejny `claim()` dopiero wtedy tworzy nowy
`AttemptId` i zwiększa `OwnershipEpoch`. Stary worker nie ma okresu, w którym
może publikować po decyzji retry.

Trwały rekord jest idempotentny po `decision_id`, wchodzi do reachability i
eksportu `.fms`, ale nie uruchamia sam polityki automatycznego retry. Coordinator
pozostaje odpowiedzialny za zastosowanie decyzji do kolejnego snapshotu katalogu.

## Minimalny katalog runu

`fullmag-session` przechowuje także `runs/<run_id>/run_catalog.json` jako
monotoniczny snapshot tasków. Rekord zawiera lifecycle, osobną readiness
(`blocked` z przyczyną), attempt/ownership epoch, fingerprint wejścia oraz
referencje do znanych artefaktów. Rewizja katalogu jest publikowana atomowo;
stary snapshot lub payload o tej samej rewizji są odrzucane, a identyczny retry
jest idempotentny. Reachability i `.fms` obsługują katalog jako typowany plik.

`SessionStore::commit_artifact_catalog` publikuje
`runs/<run_id>/artifact_catalog.json` dopiero po sprawdzeniu bieżącego
`TaskId`/`AttemptId`/`OwnershipEpoch` w run catalog. Wpis `Published` musi
wskazywać istniejący i zgodny digestem obiekt CAS; istniejące `artifact_id`
nie mogą zostać podmienione ani usunięte w nowszej rewizji. Katalog również
wchodzi do reachability i eksportu `.fms`, więc jego object refs są częścią
tego samego grafu GC/restore.

`SessionStore::reconcile_run_catalog` po restarcie podnosi rewizję katalogu i
ustawia obserwację nieukończonych tasków na `reconciling`, zachowując ich
lifecycle, attempt i ownership epoch. Nie tworzy retry automatycznie; nowa
próba wymaga późniejszej decyzji coordinatora i nowego `AttemptId`.

`ResourceLeaseRegistry` w warstwie application egzekwuje w jednym procesie
zasadę jednego aktywnego claimu na `resource_id`, sprawdza token/epoch przy
heartbeat i release oraz odmawia zajętego zasobu. Nie jest to jeszcze dowód
żywotności procesu, zwolnienia VRAM ani synchronizacji między hostami.

`SessionStore` dodaje `resource_lease.v1` i rekordy
`runs/<run_id>/resource_leases/<resource_id>/<lease_token>.json`:

- `commit_resource_lease` sprawdza bieżący `TaskId`/`AttemptId`/`OwnershipEpoch`
  w durable run catalog, serializuje admission writer lease i odrzuca drugi
  aktywny rekord tego samego fizycznego zasobu również z innego runu;
- retry tego samego tokenu i tej samej tożsamości jest `Replayed`, a konflikt
  pozostaje błędem; rekordy released nie są kasowane;
- `heartbeat_resource_lease` wymaga dokładnie kolejnego numeru heartbeat i
  odrzuca stary claim, natomiast `release_resource_lease` wymaga aktualnego
  numeru i publikuje jawny stan `Released`;
- reachability oraz eksport/import `.fms` rozpoznają rekordy lease jako
  kontrolne dokumenty runu.

Analogicznie rekordy `retry_decision.v1` są kontrolnymi dokumentami runu i nie
są usuwane przy ponowieniu decyzji.

`SessionStore::apply_retry_decision` domyka teraz brakującą granicę pomiędzy
journalem decyzji a katalogiem tasków. Zapis decyzji jest wykonywany przed
atomową publikacją kolejnego `run_catalog.json`, więc po przerwaniu procesu
ponowienie odtwarza przejście idempotentnie. `Retry` wymaga terminalnego
`failed`/`interrupted`, zachowuje poprzedni `ownership_epoch`, czyści attempt,
resolved input i resource binding oraz ustawia task na `queued` z obserwacją
`reconciling`. Jeśli istnieje aktywny lease, przejście jest blokowane — retry
nie udaje zwolnienia urządzenia. To nadal nie jest dowód, że worker został
zatrzymany; jawny `Stop`/`Release` i transport pozostają osobną bramką.

Brak heartbeat nie zwalnia zasobu automatycznie. Przed ponownym admission
coordinator musi wykazać zatrzymanie starego procesu albo izolację urządzenia;
sam rekord trwały nie jest jeszcze takim dowodem.

## Dowód

- Trwałe `GET /v2/persistence/projects/{project_id}/runs` listuje zaakceptowane
  intenty projektu z limitem 1–100, kursorem `run_id` i stanem katalogu;
  `SessionStore::list_run_intents` odczytuje tylko walidowane wpisy. Typowana
  fasada klienta i sekcja Study pokazują stronę runów otwartego projektu.
  `just check-api-source`, generacja OpenAPI, frontend typecheck, API hygiene
  i architecture hygiene: **PASS**. Test paginacji/izolacji projektu jest
  zapisany, ale **NOT RUN**; HTTP, restart i przeglądarka są **NOT VERIFIED**.

- `cargo check --locked -p fullmag-authoring --lib`: **PASS** po dodaniu
  typed study contract i migracji pipeline; testy Rust kontraktu pozostają do
  uruchomienia w osobnej bramce.
- `cargo check --locked -p fullmag-plan --lib`: **PASS** po dodaniu
  `study_execution_plan.v2`, `lower_study_plan`, `study_problem_catalog.v1`
  i `lower_study_plan_with_catalog`; celowany
  `cargo test --locked -p fullmag-plan study_catalog --lib`: **2 passed**
  (catalog binding i brak snapshotu), a pozostałe testy lowering primitive /
  unsupported pozostają do uruchomienia.
- `cargo check --locked -p fullmag-session --lib`: **PASS**.
- `SessionStore::apply_retry_decision` + test źródłowy przejścia
  `failed -> queued`: zapis decyzji, monotoniczny epoch, czyszczenie starego
  claimu i replay po restarcie są zdefiniowane; celowany
  `cargo test --locked -p fullmag-session retry --lib`: **2 passed**.
- `WorkerCoordinator` + test źródłowy worker streamu: command outbox, event
  fencing, heartbeat ACK, terminal completion, rejected prepare i jawny
  release command; celowany
  `cargo test --locked -p fullmag-application coordinator --lib`: **2 passed**.
- `p3/03-coordinator-journal.md` i `SessionStore::commit_coordinator_journal_entry`:
  durable command/event sequence, replay i terminal fencing; zależny
  `cargo check --locked -p fullmag-api`: **PASS**.
- `cargo check --locked -p fullmag-application --lib`: **PASS** po dodaniu
  identity/fencing/resolved-input contracts.
- Pozostałe testy Rust ledger/fingerprint i pełna macierz API są zapisane w
  źródle, ale nie zostały uruchomione w tym checkpointcie.
- `FmsRunIntent::validate` odrzuca rozbieżność `run_id` między kopertą a
  osadzonym RunSpec; test źródłowy sprawdza trwały replay pierwotnego runu,
  konflikt klucza i brak publikacji błędnego rekordu. Parser `rustfmt` i
  `git diff --check`: **PASS**; testu nie uruchomiono zgodnie z bieżącym
  zakazem kompilacji testów jednostkowych w `AGENTS.md`.

## Granica odbioru

Wynik: **P3-A typed study contract, explicit lowering boundary i immutable
catalog do `fullmag-plan` oraz P3-B RunSpecification, durable accepted-intent journal,
fenced resource-lease, worker-protocol identity i retry-decision journal
slices PASS / P3 overall IN PROGRESS**.

Następne bramki to reconciliation po utracie ACK, rzeczywisty transport i
supervisor workerów, dowód zatrzymania starego workera, adapter starego
wykonawcy z limitem współbieżności i pełna publication. Bez nich nie wolno
nazywać submitu exactly-once ani całego runtime durable.

## Rewalidacja 24.09.2026

Jawna zgoda użytkownika na testowanie zastąpiła wcześniejszy tymczasowy zakaz
kompilacji testów. Aktualny `just runner-container-status` zakończył się jednak
błędem `Docker Desktop coordinator request failed`, dlatego nie uruchomiłem
kompilujących testów poza zarządzaną kolejką.

Przegląd P3 wykrył, że endpoint materializacji próbował inicjalizować store
przy żądaniu dla nieistniejącego runu. Handler otwiera teraz wyłącznie istniejący
store, zwraca 404 dla brakującego rootu, a regresja sprawdza brak utworzenia
katalogu. Zmieniony plik przechodzi `rustfmt --edition 2021 --check` i
`git diff --check`; regresja Rust pozostaje **NOT RUN** do przywrócenia runnera.
Ta poprawka source-level nie zmienia procentu P3 ani globalnego, ponieważ nie
ma dowodu wykonania testu lub materializacji przez HTTP.


## Weryfikacja kontraktu study — 24.09.2026

Trasa `just verify-authoring-contracts`: **104/104 PASS**; run `5fd7f5da290345e6ad8ae3b0c26ef9cd`, exit 0, `source_changed_during_run=false`. Skorygowano fixture nieznanego rodzaju kroku do faktycznego obiektowego pola `StudyStep.kind`. Test potwierdza pełny payload, ponowny zapis/odczyt i odmowę wykonania. To dowód kontraktu źródłowego; materializacja HTTP/runtime pozostaje osobną bramką.


## Bramka HTTP — 24.09.2026

`just verify-api-project-runs`: **3/3 PASS**, run `ac211a968f4d4df5867c424fdc390363`, exit 0, `source_changed_during_run=false`. Przyjęcie/replay, materializacja, dwa runy, stronicowanie i odmowa obcego projektu są zweryfikowane w routerze HTTP. Szczegóły i granice: [04-http-submit-materialization.md](04-http-submit-materialization.md). Wcześniejsze wpisy HTTP NOT RUN dla tego modułu są historyczne; restart procesu i wykonanie workerów pozostają niezweryfikowane.


## Atomowość koordynatora — 24.09.2026

Naprawiono zużywanie sekwencji przez odrzucone zdarzenia i komendy. `ReleaseRequested` oznacza żądanie, bez deklaracji fizycznego zwolnienia zasobu. `just verify-project-application`: **38/38 PASS**. [Szczegóły i receipty](06-coordinator-atomicity.md). Transport i supervisor nadal pozostają otwarte.

## Typowane wejście StepOutput — 25.09.2026

`publish_study_outputs` zapisuje artefakty i `study_output_manifest.v1` do CAS.
Store-backed resolver odczytuje manifest dla dokładnego udanego attemptu, wiąże
każdy wpis z zaakceptowanym output portem i artifact catalog, a downstream
`ResolvedTaskInput.v2` przekazuje identyfikator artefaktu, CAS reference, data
kind i codec. `worker_protocol.v2` odróżnia ten payload od historycznego v1;
trwały inbox nie dopuszcza mieszania wire versions w ramach jednej próby.

Store-backed resolver przekazuje do `ResolvedTaskInput.v2` typowany ref CAS,
data kind i codec. Durable `commit_transition` oraz recovery blokują `Succeeded`
bez kompletnego manifestu bieżącego attemptu; SessionStore zamraża output
allow-listę po publikacji manifestu i dopuszcza tylko dokładny replay.

Wszystkie trzy ukierunkowane regresje przechodzą: SessionStore freeze
(`just verify-session-persistence`, receipt
`11ff3056f4654fdfbe04d51129bb7c9b`), fail-closed codec
(`just verify-project-application`, `a514d03c31364d13a325616edc48980f`) i
accepted-run completion barrier (`just verify-api-project-runs`,
`38bcca94e48a4ec1adaa113fc2b6772a`). Końcowe `just check-api-source` po
ostatniej zmianie **PASS** (receipt `07f91d8a4dab421ea4f2f14ed36943d4`), a
`rustfmt --check` również **PASS**. Ten checkpoint został rozszerzony o
ograniczone kodeki State i Scalar opisane w
[`13-typed-study-artifact-codecs.md`](13-typed-study-artifact-codecs.md).
Supervisor, dekodowanie wejścia w rzeczywistym workerze i runtime proof nadal
pozostają otwarte. Szczegóły dispatchu są w
[`12-study-dependency-dispatch.md`](12-study-dependency-dispatch.md).

## Horyzont TimeEvolution — 25.09.2026

`StudyPlan v2` i `study_execution_plan.v2` przypinają `until_seconds` do
zaakceptowanego kroku. Migracja mapuje znany klucz primitive `Run`, zachowuje
oryginalny payload i odrzuca wartości niedodatnie, niefinitywne lub
nienumeryczne. Lowering TimeEvolution bez jawnej wartości kończy się błędem;
plan v1 nadal da się odczytać, ale brak czasu nie jest uzupełniany wartością
domyślną. Decyzję i reguły migracji opisuje
[`ADR-0036`](../../../../../adr/0036-study-step-runtime-horizon.md).

`just verify-authoring-contracts` przeszedł (**107/107**, receipt
`3b5a9bae3fc041e98d7c67d7947f7f82`), `just verify-api-project-runs`
przeszedł (**4 PASS, 2 ignored**, receipt
`44b40955149d40abb13b347d81a09f50`), a `just generate-api-openapi` przeszedł
(receipt `0de8731b09244f12bb9173709f37d1e5`); wszystkie trzy zapisały
`source_changed_during_run=false`. Testy nie uruchamiają solvera. Call site
supervisora, rzeczywisty worker i runtime pozostają **NOT VERIFIED**. Szczegóły:
[`14-time-evolution-horizon.md`](14-time-evolution-horizon.md).

## Odtworzenie wejścia accepted task po stronie workera — 25.09.2026

`fullmag-runtime-control::load_accepted_worker_step` odtwarza `ProblemIR`,
kanoniczny `ExecutionPlanIR` i dokładne per-step `until_seconds` z immutable
accepted study/catalog. Przyjmuje tylko `Prepare` powiązany z aktualnym
claimem i aktywnym lease'em; weryfikuje persisted coordinator outbox, journal
watermark, RunSpec/plan digest, preparation receipt oraz zależności i manifesty
StepOutput. Zwrócony `AcceptedWorkerStep` przenosi te identity i
`ResolvedTaskInput` do przyszłego adaptera procesu.

Regresja `explicit_project_run_submit_is_durable_and_replays_without_live_session`
sprawdza odtworzenie dokładnego `ProblemIR`, planu i `until_seconds=1e-9`, a
także odrzucenie zmienionego digestu planu i komunikatu spoza outboxu.
`just verify-api-project-runs` przeszedł (**4 PASS, 2 ignored**, receipt
`1e1b8077acc9466da18b4853882df717`, `source_changed_during_run=false`).
`git diff --check` nie wykrył błędów whitespace. Whole-file `rustfmt --check`
pozostaje niezaliczony z powodu istniejących, niezwiązanych różnic formatowania
w brudnych plikach; zmienione hunki nie pojawiają się w raporcie rustfmt.

Ten helper nie rezerwuje procesu, nie uruchamia solvera i nie przenosi stanu
magnetyzacji do przestrzeni siatki konsumenta. Przed wykonaniem nadal trzeba
dodać fenced process admission/supervisor, jawny adapter transferu stanu,
izolowany katalog attemptu i call site publikacji manifestu przed `Completed`.
Postęp P3 pozostaje **50%**, całość planu około **27%**.
Pełny checkpoint: [`15-accepted-worker-context.md`](15-accepted-worker-context.md).

## Rehydratacja kontekstu po trwałym Start — 25.09.2026

`load_accepted_worker_step_for_start` odzyskuje wejście kroku dla workera,
który dostał `Start`: weryfikuje bieżący claim, odtwarza kompletny journal i
wymaga dokładnego zapisanego `Start` oraz dokładnie jednego poprzedzającego go
`Prepare`. Kontekst solvera pochodzi z tego `Prepare` i zachowuje przypięty
`ProblemIR`, `ExecutionPlanIR`, horyzont oraz typowane wejścia.

`just verify-api-project-runs` przeszedł (**4 PASS, 2 ignored**, receipt
`f859f5a023c3420faa60b220837626df`, `source_changed_during_run=false`).
Regresja odtwarza ten sam kontekst po `Start` i odrzuca komunikat spoza
journalu. Resolver nie wykonuje komendy ani solvera; fenced process admission,
transfer stanu, izolowany katalog próby i publikacja wyników pozostają otwarte.
Procenty bez zmian: **P3 50%, plan globalny około 27%**. Szczegóły:
[`16-start-worker-context.md`](16-start-worker-context.md).

## Materializacja stanu w planie runnera — 25.09.2026

`study_magnetization_layout_for_plan` udostępnia tożsamość layoutu z kanonicznego
generatora artefaktów runnera. `materialize_study_magnetization_input` tworzy
kopię accepted `ExecutionPlanIR` ze stanem CAS w polu magnetyzacji
początkowej. Obsługuje FDM, FDM multilayer z walidacją segmentów warstw oraz
FEM H1 P1. Wymaga identycznego layoutu, zgodnych offsetów i liczby próbek;
nie wykonuje interpolacji ani zmiany lane'u. Pozostałe plan variants odrzuca.

`just verify-api-project-runs` przeszedł (**4 PASS, 2 ignored**, receipt
`3eb4cc2deba64adfa6a2cedb713c510b`, `source_changed_during_run=false`), a
`python scripts/check_repo_consistency.py` przeszedł. Regresja potwierdza, że
plan zmienia wyłącznie stan początkowy oraz odrzuca niezgodny layout, liczbę
próbek i wartości niefinitywne. Helper nie ma jeszcze produkcyjnego call site;
nie uruchamia solvera ani nie publikuje outputów. P3 **50%**, całość około
**27%**. Szczegóły: [`17-same-space-study-state.md`](17-same-space-study-state.md).

## Trwałe admission taska — 25.09.2026

`SessionStore::commit_task_admission` zapisuje immutable `task_admission.v1`
przed projekcją claimu w run catalog i resource lease. Replay przywraca ten sam
attempt oraz token; nie tworzy nowej próby i nie reaktywuje taska terminalnego.
`reconcile_task_admissions` kończy zapis przerwany po intent record albo po
projekcji katalogu. Reachability/GC oraz `.fms` walidują typed admission records.

`just verify-session-persistence` — **64 testy biblioteki, 9 archiwum i 13
storage PASS**, receipt `5bf26751212a46d091ca2f9300d2ca53`,
`source_changed_during_run=false`; consistency i diff check PASS. Szczegóły i
granica odbioru: [`18-durable-task-admission.md`](18-durable-task-admission.md).
Nie istnieje jeszcze production call site schedulera/supervisora ani rzeczywiste
wykonanie solvera, więc P3 pozostaje **50%**, a plan globalny około **27%**.


## Adapter aplikacji do durable admission — 25.09.2026

`commit_claimed_task_admission` waliduje świeży claim `Preparing`, zapisuje go
przez session store i odczytuje ponownie, aby potwierdzić tę samą własność.
Ponowienie tej samej operacji nie zależy od lokalnych timestampów lease'u. Test
accepted-run zastępuje ręczne zapisy catalog/lease adapterem i sprawdza replay.

`just verify-api-project-runs`: **4 PASS, 2 ignored**, receipt
`2a9aa81834e1495f86c7d92de0ab01a6`; `just verify-session-persistence`: **64 +
9 + 13 PASS**, receipt `828880b3fdac4cb0aa089fdd2e5f7f6e`; oba z
`source_changed_during_run=false`. Nadal brakuje produkcyjnego schedulera,
supervisora i uruchomienia solvera. P3 **50%**, plan globalny około **27%**.
Szczegóły: [`19-runtime-control-admission-bridge.md`](19-runtime-control-admission-bridge.md).

## Kolejka ready sterowana zależnościami — 25.09.2026

`queue_accepted_study_task` przeprowadza jeden enabled/planned task z
`Accepted/Blocked` do durable `Queued/Ready` dopiero po sprawdzeniu accepted
fingerprintu, trwałego preparation receipt oraz wymaganych wejść i lineage
`StepOutput`. Powtórzenie sprawdza te same warunki i jest idempotentne dla
nieprzypisanego taska. Regresja potwierdza odmowę niezadeklarowanego portu bez
zmiany catalogu, queue/replay, a następnie durable admission i zapis `Prepare`.

`just verify-api-project-runs`: **6 PASS, 2 ignored**, receipt
`e4cd6869dfdb40b8851d27b981e5640c`; `just check-api-source`: **PASS**, receipt
`57688c144f8344a3a79647ac82a39ce4`; oba z `source_changed_during_run=false`.
Consistency checker **PASS**; diff check plików API kończy się kodem 0. Pełny
diff check nadal raportuje CRLF w szeroko zmienionym statusie planu. Nie ma jeszcze production caller,
wyboru zasobu i limitów współbieżności, supervisora/transportu ani wykonania
solvera. P3 i plan globalny bez zmian (**50% / około 27%**). Szczegóły:
[`21-dependency-gated-ready-queue.md`](21-dependency-gated-ready-queue.md).

## Fence urządzenia przy durable admission — 25.09.2026

`commit_claimed_task_admission` weryfikuje ofertę CPU/GPU względem immutable
`RunSpec.device`, dokładnego accepted study step i ewentualnego FEM eigen device
rozstrzygniętego przez planner. Odmowa następuje przed zapisaniem task attemptu
i lease'u; `auto` zachowuje wybraną klasę urządzenia w durable lease. Managed
regresja potwierdza odmowę GPU przy żądaniu CPU bez zmiany catalogu, a następnie
poprawne CPU admission i replay.

`just verify-api-project-runs`: **6 PASS, 2 ignored**, receipt
`380986ba0aca453996e7938261e9f899`; `just check-api-source`: **PASS**, receipt
`114003e8c08d4b2f98e79bacb76c4290`; obie trasy z
`source_changed_during_run=false`. `claim.rs` rustfmt, repository consistency
i scoped API diff check **PASS**. Guard nie uruchamia workera i nie potwierdza
faktycznie użytego GPU/CPU. Scheduler, pule zasobów, supervisor/transport,
runtime i kwalifikacja fizyczna pozostają otwarte; P3 **50%**, całość około
**27%**. Szczegóły: [`22-device-lane-admission-fence.md`](22-device-lane-admission-fence.md).
