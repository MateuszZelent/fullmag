# Compute resources, execution profiles i równoległe sweeps

Status: **architektura przyjęta do implementacji**, 2026-10-04. Dokument nie deklaruje
wdrożenia wszystkich opisanych rozszerzeń. Stan prac podaje
[checkpoint](../plans/active/compute-execution-20261004/implementation-checkpoint.md).
Zachowanie bazowe sprzed implementacji jest opisane w
[audycie źródeł](../plans/active/compute-execution-20261004/source-audit.md).
Projekt UI: [Settings i Compute environment](../design/start-screen/docs/10-compute-settings-and-multi-device.md).
Kolejność wdrożenia i bramki: [plan](../plans/active/compute-execution-20261004/README.md).

## 1. Decyzja produktowa i zakres

Użytkownik ma móc uruchomić jeden solve na CPU/GPU, rozdzielić niezależne
przypadki sweepu między kilka kart i/lub grup rdzeni, a docelowo wykonywać
jeden obsługiwany solve przez wiele urządzeń lub węzłów. Każdy przypadek ma
mieć odtwarzalne wejście, zasoby, wynik i historię prób. Zamknięcie UI nie
może być poleceniem zatrzymania zaakceptowanej pracy.

Trzy oddzielne obiekty odpowiadają na trzy pytania:

1. **Compute environment:** co host wykrył, udostępnił, zarezerwował i faktycznie
   wykonuje? Odczyt nie zmienia ustawień problemu.
2. **Execution profile / Study execution:** czego żąda zadanie i jakiego
   sposobu wykonania wymaga? Ustawienia numeryczne pozostają w solver config.
3. **Allocation:** które rzeczywiste urządzenia i procesy otrzymała konkretna
   próba? Przydział jest decyzją backendu, potwierdzoną przez worker.

Nie utożsamiamy: GPU wykrytego, kompatybilnego runtime, przyjętego zadania,
przydzielonego GPU, wykonania na GPU i kwalifikacji naukowej. Są to osobne fakty.

Zakres obejmuje FDM CPU, FDM GPU, FEM CPU i FEM GPU. Nie zmienia równań fizyki,
integratorów, tolerancji, precyzji ani semantyki termów. Zmiany numeryki
wymagane przez rozproszony pojedynczy solve mają osobne bramki naukowe (§11).

## 2. Słownik i własność

| Pojęcie | Jednoznaczne znaczenie |
|---|---|
| Node / węzeł | Host wykonawczy o trwałym `node_id`; nie karta i nie proces MPI |
| Socket | Fizyczny procesor w płycie; nie utożsamiamy go automatycznie z NUMA node |
| Physical core | Rdzeń; jego rodzeństwo SMT jest jawnie widoczne w topologii |
| Logical CPU | Jednostka schedulera OS; 48 logical CPUs nie dowodzi 48 rdzeni |
| Worker thread | Wątek biblioteki/solvera; liczba wątków nie jest maską affinity |
| Rank | Jeden proces zadania rozproszonego; ma własne wątki i urządzenia |
| Case | Jeden niezmienny zestaw parametrów sweepu i zależności wejściowych |
| Task | Istniejący wykonawczy węzeł grafu study; case może wymagać kilku tasków |
| Attempt | Jedna próba taska z własnym claimem, epoch, lease i receiptami |
| Batch | Niezmienna kolekcja runów/cases oraz polityka ich współbieżności |
| Pool | Zbiór dozwolonych zasobów i polityk; nie nowa fizyczna pojemność |
| Allocation | Złożona rezerwacja CPU, RAM, GPU/VRAM i scratch dla attemptu |

### 2.1 Rozszerzenie obecnych właścicieli

```mermaid
flowchart TD
  A[Python DSL i UI Study] --> B[StudyPlan i solver configs]
  P[Settings: profile i polityka hosta] --> C[RunSpecification / BatchSpecification]
  B --> C
  C --> D[Planner: legalność i wymagania]
  I[Discovery: sprzęt i runtime capabilities] --> D
  D --> E[Istniejący durable scheduler]
  L[Wspólny ledger zasobów hosta] --> E
  E --> Q[Preparation admission]
  Q --> R[Preparation receipt i zwolnienie]
  R --> E
  E --> W[Supervisor i worker adapter]
  W --> N[Istniejące backends/fdm i backends/fem]
  N --> O[CAS, manifest, wynik i execution receipt]
  E --> V[Zasoby OpenAPI v2 i invalidations]
  O --> V
  I --> V
  V --> U[Compute environment, kolejka, wyniki]
```

- `fullmag-authoring` / `fullmag-ir`: semantyka study i żądania wykonania.
- `fullmag-plan` i aplikacyjny planner: legalność przed heurystyką placementu.
- `fullmag-application`: immutable submit, batch/case expansion, RunSpecification.
- `fullmag-runtime-control`: istniejący scheduler, supervisor, resource admission
  i nowy wspólny bilans zasobów; bez operatorów numerycznych.
- `fullmag-session`: trwałe katalogi, rezerwacje, fencing, journal i CAS.
- Obecna usługa runtime: jedyny właściciel lokalnego wykonania; API i UI są klientami.
- `backends/*`: wykonanie numeryki i faktyczne potwierdzenie urządzeń/precyzji.
- `fullmag-api` → generated v2 → facade → resource hooks → moduły UI:
  jedyna droga odczytu i mutacji. Nie powstaje drugi scheduler w przeglądarce.

Zachowujemy ADR 0035, 0037 i 0049: preparation oraz solve mają różne leases
i lifecycle, ale korzystają ze wspólnego fizycznego bilansu CPU/RAM/storage.
Nie wstawiamy prac symulacji do kolejki Fullmag_build_runner. Build runner
buduje i kwalifikuje pakiety; runtime scheduler wykonuje zaakceptowane zadania.

## 3. Warstwy konfiguracji i pierwszeństwo

| Warstwa | Przechowywanie | Zastosowanie zmiany |
|---|---|---|
| Polityka operatora węzła | Trwała konfiguracja usługi, revision, ACL | Nowe admission; zmniejszenie budżetu drenuje nadmiar, nie zabija zadań |
| Preferencje użytkownika | Istniejący SQLite workspace przez typowane API | Domyślne wartości nowych draftów |
| Execution profile | Wersjonowany katalog, immutable opublikowana wersja | Referencja `profile_id/version`, rozwinięta przy Submit |
| Study / step | Kanoniczny authoring, eksport Python, solver config | Dotyczy wskazanych kroków i następnego Submit |
| Parametry uruchomienia | Immutable RunSpecification / BatchSpecification | Dotyczą jednego przyjęcia pracy |
| Allocation | Ledger + attempt/lease | Faktyczny przydział podczas admission |
| Executed resources | Receipt workera i runtime | Rzeczywistość po starcie, nie edytowalna preferencja |

**Limity operatora, widoczność urządzeń i legalność solvera są ograniczeniami,
nie warstwą nadpisywaną przez preferencje.** Efektywne żądanie powstaje z:
domyślnych wartości produktu → przypiętego profilu → jawnych pól study/step
→ jawnych, dopuszczonych override'ów tego Submit. Pochodzenie każdego pola
jest zapisane. Profile nie śledzą ruchomej wersji `latest` po przyjęciu runu.

Jawny override CLI/Run dialog musi być widoczny w preview, kanonicznym eksporcie
i RunSpec. Nie może zmienić `gpu` na `cpu`, `double` na `single` lub parametrów
fizyki pod pretekstem oszczędzania zasobów. Konflikt profilu kroku z jawną
polityką runu daje `execution_intent_conflict`, z oboma źródłami wartości.
Nie redukujemy różniących się profili kroków do jednej pary backend/device.

Obecny szew między `RuntimeSelection`, referencją profilu kroku i
`RunSpecification.requested_execution` wymaga jednego resolvera. Rozwija on
profil do **każdego** kroku przed zaakceptowaniem snapshotu i sprawdza zgodność
wszystkich czterech pól: backend, device, precision, mode. Run-level request
jest ograniczeniem/udokumentowanym override'em; nie drugim wyborem urządzenia
wykonywanym po plannerze. `auto` na poziomie runu dopuszcza jawne per-step
żądania. Forced `gpu` wymaga GPU we wszystkich objętych nim solver tasks;
CPU preparation ma odrębny zakres i receipt. Jawne sprzeczne profile dają
błąd, a overlay override'u ma osobny digest i nie zmienia zapisanej bazy modelu.

Przejściowy kontrakt per-task w implementacji E1: `resolved_task_input.v3`
przenosi żądanie wyprowadzone z immutable ProblemIR danego kroku przez
`RequestedExecution::for_problem`. Ten sam resolver jest używany przy
doborze oferty, admission i kontroli wejścia workera. `resolved_task_input.v2`
pozostaje czytany jako kopia globalnego żądania RunSpec; nie reinterpretujemy
zapisanych komunikatów. Obie wersje zachowują fingerprint całego RunSpec.
Run-wide wejścia nadal używają v2; nowe materializowane kroki Study używają v3.
Globalne `auto` dopuszcza konkretne backend/device kroku; konkretne ograniczenie
runu może zawęzić Auto, ale nie zastępuje innej konkretnej wartości kroku.
Brak wyboru hosta w tym resolverze: Auto bez konkretnego ograniczenia pozostaje
Auto. Rozstrzygnięcie sprzętowe i jego receipt należą do admission/wykonania.

Do czasu wersjonowania podsumowania runu, precision/mode RunSpec v2 pozostają
jawnymi ograniczeniami wszystkich kroków. Mieszane precision/mode wymagają
dalszej migracji E1, nie specjalnej wartości w istniejącym polu. Budżet v2
pozostaje konserwatywnym minimum per task, z zerowym VRAM dla kroku CPU;
GPU wymaga dodatniego minimum VRAM. To nie jest jeszcze estymator zużycia
ani rezerwacja we wspólnym ledgerze hosta (E2).

`justfile` pozostaje klientem uruchomieniowym. Przekazuje wybór profilu i
jawne parametry do tego samego resolvera, którego używa UI/Submit. Nie jest
bazą preferencji użytkownika i UI nie edytuje repozytoryjnego `justfile`.
Zmienne builda, np. liczba kompilacji równoległych, nie trafiają do Study.

Dotychczasowe env/CLI mają adapter migracyjny:

1. Tylko jawna allow-lista zmiennych zasobowych jest odczytywana; bez dumpu env.
2. Adapter normalizuje wartość, jednostkę i źródło (`legacy_env`, `cli`, `script`).
3. Nieuzupełnione pole może otrzymać tę wartość; konflikt dwóch jawnych źródeł
   jest błędem z podglądem różnicy, bez cichego zwycięzcy.
4. `CUDA_VISIBLE_DEVICES` / ograniczenie kontenera jest granicą widoczności,
   nie żądaniem liczby niezależnych zadań ani sposobem nadpisania lease.
5. Worker dostaje oczyszczone środowisko wyliczone z allocation. Adaptery
   bibliotek nie odczytują sprzecznych odziedziczonych indeksów GPU/wątków.
6. Import legacy jest audytowany, odwracalny i nie przepisuje istniejących runów.

## 4. Model danych — proponowane rozszerzenia

Nazwy poniżej są kontraktem projektu, **nie istniejącym API do wywołania**.
Nowe wersje są wymagane dla typów z `deny_unknown_fields` i dla zmiany
semantyki lease/protokołu. Nie dopisujemy pól po cichu do formatu v1.

### 4.1 ComputeNodeSnapshot i dane obserwacyjne

| Pole/grupa | Kontrakt |
|---|---|
| `node_id`, `boot_id`, `inventory_revision` | Trwały host, bieżące uruchomienie, rewizja topologii |
| `runtime_owner_id`, `owner_epoch`, `capabilities_revision` | W v1 stabilna tożsamość host ledgeru i epoka przypiętej polityki; nie PID ani dynamiczna epoka procesu |
| `cpu.topology` | Socket, NUMA, core, logical IDs, SMT siblings, grupy procesorów Windows, cpuset/quota ograniczająca host |
| `cpu.effective_capacity_millis` | Pojemność OS/cgroup; 1000 oznacza ekwiwalent jednego logical CPU, nie fizycznego rdzenia |
| `memory.total_bytes`, `available_bytes` | Osobne wartości całkowite i bieżący pomiar; brak pomiaru to null/status |
| `gpus[]` | Trwały pełny UUID, PCI ID, nazwa, lokalny ordinal, VRAM, zgodność runtime, topology/NUMA gdy dostępna |
| `gpus[].partition` | Całe GPU lub jawna partycja MIG z parent UUID; unknown nie jest pełną kartą |
| `sample` | Source, collected_at, freshness, error/reason; brak danych nie jest zerem |
| `enforcement` | Osobno `cpu_affinity`, CPU quota, memory cap, GPU visibility, storage quota: supported/advisory/unavailable |

`inventory_revision` jest dodatnią, monotoniczną rewizją trwałego inventory.
Zwiększa się wyłącznie, gdy zmieni się kanoniczny opis CPU topology/OS
constraints, GPU UUID/partition lub ich trwałe powiązanie. Zmiany wolnej RAM,
obciążenia, temperatury i innych próbek telemetrycznych nie zmieniają tej
rewizji. `capabilities_revision` jest niezależne i zmienia się tylko po zmianie
zgłoszonych capabilities runtime. Publikujący zachowuje ostatnią rewizję dla
tej samej tożsamości node/boot; nie może jej wyliczać z chwilowego capacity.

`sample.collected_at` jest czasem UTC pobrania próbki. Próbka jest `current`
przez maksymalnie 30 sekund; po przekroczeniu limitu jest `stale`. Czas z
przyszłości, błąd odczytu i brak pomiaru dają jawny `unavailable` z reason,
nigdy świeżą próbkę ani wartość zero. Ten sam limit obowiązuje przy późniejszym
admission; odczyt inventory nie tworzy ani nie rezerwuje allocation.

`compute_node_snapshot.v2` zawiera `host_owner_id` i `host_owner_epoch` dla
wyłącznego producenta próbki fizycznego hosta, zakotwiczonego we wspólnym root
`HostResourceLedger`. Pola te pozostają oddzielne od `RuntimeServiceOwner`,
który nadal jest przypisany do `SessionStore`, oraz od
`HostResourceLedgerPolicy.owner_epoch`, który fence'uje przypiętą konfigurację.
Snapshot używany do admission musi pasować do aktywnego host-owner lease'a i jego
epoki; przejęcie lease'a po kontrolowanym recovery unieważnia poprzednią próbkę
niezależnie od jej wieku 30 sekund. Rezerwacje z poprzedniej epoki pozostają
zajęte do exact reconciliation/release. `HostReservationRequest` oraz trwała
rezerwacja przypinają osobne `compute_node_owner_id` i
`compute_node_owner_epoch`; solver/preparation admission i launch permit
sprawdzają tę parę wraz ze świeżym snapshotem pod wspólną blokadą ledgera.
Ledger odczytuje v1 i zapisuje v2 po migracji. Znaczenie `runtime_owner_id` i
`owner_epoch` z v1 snapshotu pozostaje bez zmian.

Bieżące GPU oparte tylko na `index`/nazwie w telemetrii UI trzeba wzbogacić
o UUID i wiązanie z inventory. Przekierowanie API na innego hosta/epoch
unieważnia wszystkie cache zasobów i draft bindings do starej topologii.
Stan last-good pozostaje tylko przy zgodnej tożsamości źródła i jest oznaczony.

### 4.2 NodePolicy i ExecutionProfile

`NodePolicy` ma revision, allowed GPU UUIDs/CPU sets, rezerwę dla OS/UI,
budżet RAM/scratch, limit równoległych workerów, kolejność priorytetów,
tryb drain i dopuszczone wzorce parallelism. GPU obsługujące monitor można
wykluczyć lub jawnie dopuścić z rezerwą; obciążenie graficzne nie jest runem.

`ExecutionProfile` ma `profile_id`, immutable `version`, opis, target/pool,
domyślne żądania zasobów, dozwolone lane'y, kryteria placementu i politykę
awarii. Profil nie jest image name ani zestawem niekontrolowanych env.
Numerical solver configuration (tolerancje, integrator, demag strategy,
preconditioner) pozostaje istniejącym odrębnym obiektem study.

Domyślna polityka nowej instalacji: lokalny host, `strict`, zachowanie
autorskiej precyzji, wyłączność jednego Fullmag attemptu na całe GPU,
brak automatycznego retry, brak oversubscription, brak auto-preemption.
Budżety discovery muszą być rzeczywiste i jawnie zaakceptowane przez istniejącą
fabrykę konfiguracji. Nie zastępujemy ich stałą wartością RAM/VRAM. Rezerwy
i wybór SMT są parametrami operatora; profil „Interactive” proponuje zachowanie
rezerwy na UI, a preview pokazuje dokładne obliczone wartości przed zapisem.

### 4.3 RunResourceRequest i profil kroku

| Pole | Typ i walidacja | Semantyka |
|---|---|---|
| `target` | local/node/pool ID, dokładny scope | Miejsce wykonania, bez adresu/shell command w skrypcie |
| `cpu.threads` | `auto` lub dodatnie u32 | Żądany limit wątków obliczeniowych procesu; stare `threads(n)` zachowuje to znaczenie |
| `cpu.core_policy` | physical-first / logical, capability gated | Przydział rdzeni i SMT; nie przelicza 48 logical na 48 physical |
| `cpu.affinity` | auto/compact/spread/numa, opcjonalne ID | Rozmieszczenie; wymuszony wariant bez wsparcia jest odrzucany |
| `cpu.native_threads`, `blas_threads` | auto lub dodatnie u32, advanced | Tylko w budżecie procesu; nie mnożymy zagnieżdżonych pul |
| `ram.reservation_bytes` | dodatnie u64 lub estimate-ref | Minimum dla admission; osobny limit egzekwowania i peak actual |
| `gpu.selector` | any-compatible / allow-list UUID / required UUID | Zbiór dozwolony ≠ lista GPU jednego solve'a |
| `gpu.devices_per_task` | dodatnie u32 dla GPU, 0 CPU | Początkowo dokładnie 1; >1 wymaga osobnej capability distributed solve |
| `gpu.vram_per_device_bytes` | dodatnie u64 lub wektor per rank | Wymaganie na każdą kartę; VRAM różnych kart nie sumuje się domyślnie |
| `parallelism` | single-process / distributed | Intra-solve; nie to samo co batch concurrency i nie `mode=hybrid` |
| `distributed` | ranks, threads_per_rank, ranks_per_node, GPUs_per_rank | Tylko przy wspieranej parze workflow/runtime i wspólnym planie topologii |
| `scratch.reservation_bytes` | dodatnie u64 | Budżet per attempt w kanonicznym storage |
| `placement` | balanced / throughput / pinned | Heurystyka po sprawdzeniu legalności; bez automatycznego benchmarku |

`auto` pozostaje w request. Resolve zapisuje konkretną liczbę oraz przesłanki.
Explicit `threads=16` przy allocation=8 nie staje się po cichu 8: zadanie czeka
lub jest odrzucane jako niemożliwe, a użytkownik widzi proponowaną zmianę.
`minimum_resources.cpu_millis` pozostaje minimalnym budżetem admission, nie
aliasem liczby wątków ani dowodem wykorzystania wszystkich tych CPU.
Resolver wyprowadza dodatkowo wymagany zbiór CPU: w polityce bez
oversubscription każdy równocześnie aktywny wątek obliczeniowy potrzebuje
jednego przydzielonego logical CPU i 1000 jednostek pojemności. Physical-first
wybiera różne rdzenie, o ile request nie dopuszcza SMT; topology ledger
blokuje konflikt rodzeństwa przy wyłącznej rezerwacji całego rdzenia.
Efektywne minimum jest maksimum z jawnego `cpu_millis` i wyliczonego budżetu
wszystkich współbieżnych pul/ranków. CPU quota OS może ograniczyć ten zbiór
poniżej jego liczności; wtedy obowiązuje mniejsza pojemność, nie sam cpuset.
Mniejsza rzeczywista liczba aktywnych wątków, np. przy małej siatce, jest
poprawna i raportowana; nie uzasadnia cichego zmniejszenia przydziału requestu.

### 4.4 BatchSpecification

- `batch_id`, snapshot/digest, study/catalog digest, versioned execution profiles.
- Osie parametrów: nazwa, typ, jawny typowany cel w konkretnym kroku Study,
  jednostka kanoniczna, lista/przedział, `cartesian` albo `zip`; porządek,
  wiązanie i reguły walidacji są częścią hasha. Wartość osi zmienia
  case-local `ProblemIR` w `StudyProblemCatalog`; generyczne
  `RunSpecification.parameters` nie jest wejściem solvera. Application wiąże
  `external_field_b` z pojedynczym składnikiem Zeeman B w teslach oraz
  `zhang_li_current_density` z nazwanym modułem Zhang–Li w A/m²; oba cele
  wymagają jawnego, normalizowanego kierunku. Zhang–Li musi być wykonywalny,
  a nazwane źródło transportu nie może być nadpisywane osią. Pozostałe cele
  wymagają własnego typu i sprawdzenia przez planner przed udostępnieniem.
- `cases`: trwałe case IDs, canonical parameter tuples, niezerowy seed
  wyprowadzony deterministycznie z master seed i identyfikatora case,
  zależności oraz odpowiednie child run IDs. Seed komponentu trafia do
  stochastycznych pól wejściowego `ProblemIR`; generyczne
  `RunSpecification.seeds` nie jest przekazywane jako zastępstwo bindingu.
  Jeśli thermal noise wynika wyłącznie z legacy `ProblemIR.temperature` bez
  jawnego `ThermalNoise`, materializacja odmawia zamiast zostawić system
  entropy niezwiązane z zadanym seedem. Duże zbiory mają stronicowany,
  content-addressed manifest; UI nie przesyła milionowej tablicy w status.
- `max_parallel_cases`: auto lub dodatni limit; to górna granica, nie gwarancja.
- `resources_per_case`: domyślny profil/request; kroki nadal mają własne profile.
- `execution_strategy`: independent / continuation / dependency-graph.
- `failure_policy`: continue-independent / stop-admission; wartości wire to
  `continue_independent` i `stop_admission`. Brak pola w starszym Submit oznacza
  zgodne wstecz `continue_independent`; nie uruchamia to auto-retry. Liczbowy
  limit retry, jeśli włączony, jest immutable.
- `lane_policy`: homogeneous domyślnie; mixed CPU/GPU dopiero po jawnym wyborze
  `auto` i kwalifikowanym zbiorze równoważnych lane'ów. Forced GPU wyklucza CPU.
- Polityka wyników: required ports, scalar summaries, field retention,
  indeks częściowych rezultatów, sposób agregacji i oczekiwany komplet.
- `output_storage`: przypięty snapshot istniejącej OutputStorage policy,
  rozwiązany przy Submit z authoring i workspace defaults zgodnie z ADR 0051.
  Child RunSpecs dziedziczą ten sam snapshot; późniejsza zmiana Settings nie
  zmienia ich writera ani katalogu docelowego. Istniejący właściciel
  OutputStorage rezerwuje osobne ścieżki case/attempt/scratch, wiążąc je
  trwale z BatchId/CaseId/AttemptId. Retry/odtworzenie ekspansji odczytuje
  tę samą rezerwację albo tworzy nową dla nowego attemptu; nigdy nie nadpisuje
  ukończonego wyniku ani nie losuje innej ścieżki dla tego samego intentu.

Batch nie jest drugim schedulerem. Materializuje child RunSpecifications
i zależności w istniejącym durable store. Przyjęcie batcha i zakres case IDs
są trwałe i idempotentne; recovery kontynuuje ekspansję bez duplikowania runów.
Przy bardzo dużej ekspansji ACK potwierdza batch i manifest, a nie gotowość
wszystkich tasków. Postęp ekspansji jest osobnym zasobem.

Postęp `stopped` oznacza, że opublikowany prefiks jest niepusty i niepełny, a
`stop_admission` zatrzymało publikowanie po terminalnym niepowodzeniu,
anulowaniu lub przerwaniu jednego z opublikowanych cases. Ten stan jest
trwały i nie jest prezentowany jako pełna ekspansja.

`max_parallel_cases` liczy cases rozpoczęte pierwszym admission (także
preparation), aż do terminalnego zakończenia case. Nie liczy liczby tasków
ani ranków. Case oczekujący po preparation nadal zajmuje slot case, ale nie
trzyma zwolnionego GPU/CPU lease. Każdy task otrzymuje osobny allocation;
równoległe taski jednego case podlegają łącznemu limitowi workerów i ledgerowi.
`resources_per_case` określa domyślne wymagania tasków oraz opcjonalny łączny
limit case; preview analizuje rzeczywistą szerokość DAG, nie zakłada zawsze
jednego taska na case. Pause new cases pozwala aktywnym cases wykonać pozostałe
kroki. Canceled/failed dependency propaguje stan blocked/skipped descendants
z przyczyną, zamiast pozostawić je bez końca w zwykłym waiting for resources.

Dla `homogeneous` resolver utrwala zgodny zestaw resolved lanes dla kroków
przed pierwszym admission batcha. Następne cases nie przechodzą samodzielnie
na CPU ani inną precyzję, gdy GPU jest zajęte. Requested Auto nadal pozostaje
w snapshot; trwały zapis batch resolution określa wspólny wybór. Mixed lanes
wymagają jawnej polityki i kwalifikowanej równoważności wyników.

### 4.5 Allocation i receipt

Allocation łączy: node/boot/owner epoch, pełny RunId/TaskId/AttemptId,
lease token, profile/policy/inventory revisions, logical CPU set i powiązane
rdzenie, per-rank threads, GPU UUIDs i lokalne ordinale, RAM/VRAM/scratch,
poziom enforcement i powód wyboru. Wektor zasobów zastępuje założenie,
że pojedynczy tekstowy `resource_id` dowodzi całego przydziału.

Receipt osobno zapisuje requested → resolved → allocated → executed:
załadowany runtime/build, rzeczywiste GPU UUID, CPU affinity i pulę wątków
zgłoszoną przez backend, precyzję, fallbacks, peak memory, stop reason,
manifest i exit receipt. Brak native thread telemetry jest `unreported`,
nie kopią requested value. Nie kopiujemy tajnych env ani lokalnych tokenów.

## 5. Jeden bilans zasobów i admission

### 5.1 Granica hosta

Obecne blokady/pule w store nie dowodzą wyłączności fizycznego GPU między
dwoma różnymi store'ami, natywnym procesem i kontenerem. Docelowo jeden
właściciel zasobów hosta, rozszerzający usługę runtime, utrzymuje ledger
CPU/RAM/GPU/scratch dla wszystkich podłączonych store'ów i obu faz.
Build runner może publikować do tego ledgeru własną rezerwację pojemności
na czas ciężkiego buildu, zachowując swoją kolejkę i storage locks. Brak
takiej integracji wymaga konserwatywnego admission/rozłącznej puli; UI nie
anuluje builda ani symulacji w celu zwolnienia zasobów.
Jeśli operator nie uruchamia takiego właściciela, pule muszą być jawnie
rozłączne; konfiguracja bez dowodu rozłączności nie uruchamia multi-worker.

Rezerwacja węzła i claim taska są dwoma trwałymi zapisami. Stosujemy
fenced prepare/commit, nie fikcyjną atomową transakcję między bazami:

1. Właściciel zapisuje tentative allocation dla dokładnego admission ID/epoch.
2. Store atomowo sprawdza snapshot, gotowość, claim i zapisuje allocation-ref.
3. Właściciel potwierdza committed; worker rusza dopiero po zgodnych zapisach.
4. Crash pomiędzy zapisami uruchamia reconciliation po admission ID. Nie
   powstaje druga alokacja, a lease nie jest zwalniany przez sam timeout.
5. Release wymaga worker exit i dopuszczonego terminalnego receiptu;
   osierocony proces/nieznany wynik pozostawia zasób quarantined/unknown.

W jednym store i procesie można zoptymalizować tę ścieżkę transakcyjnie,
ale identyczna semantyka recovery pozostaje kontraktem.

### 5.2 Reguły budżetów

- Suma aktywnych, tentative i quarantined rezerwacji CPU/RAM/scratch nie
  przekracza puli po rezerwie operatora; przygotowanie mesh liczy się do sumy.
  Gdy operator obniża politykę poniżej istniejących rezerwacji, powstaje
  jawny stan over-budget/draining: nowe admission jest zablokowane do zejścia
  poniżej limitu. Stare leases zachowują pierwotny budżet; nie udajemy,
  że zmiana konfiguracji natychmiast zwolniła fizyczne zasoby.
- Dla GPU wyłącznego aktywne allocation sets nie przecinają się po pełnym
  UUID. Całe GPU i jego MIG children także mają relację konfliktu.
- CPU jobs i GPU helper threads mają rozłączne CPU sets przy exclusive
  placement. SMT siblings nie tworzą dwóch niezależnych physical cores.
- Budżet ranków obejmuje sumę/równoczesne pule, a nie samo największe
  `OMP_NUM_THREADS`. Zagnieżdżone BLAS/OpenMP/Rayon są ograniczane przez adapter.
- Rezerwacje są odrębne od bieżącego użycia. Nie odejmujemy jednocześnie
  całej rezerwacji i tego samego zmierzonego RSS od identycznej pojemności.
- Gdy request przypina CPU IDs, bieżący snapshot musi zawierać topologię oraz
  OS-allowed CPU set obejmujące zarówno politykę, jak i wybrane IDs. Przydział
  GPU wymaga bieżącego UUID, potwierdzonego `full_device` i VRAM co najmniej
  równego skonfigurowanemu oraz żądanemu limitowi. `last_known`, brak pomiaru
  i `unknown` partycji nie otwierają admission. Tożsamość inventory nie
  dowodzi jeszcze egzekwowania affinity ani maski urządzenia w workerze.
- Dla owner-bound host admission raportowane `cpu.effective_capacity_millis`
  ogranicza sumę rezerwacji CPU do minimum tej wartości i
  `HostResourceLedgerPolicy.total_budget.cpu_millis`. Liczą się wszystkie
  niezwolnione rezerwacje, również tentative i quarantined; limit jest ponownie
  sprawdzany przy promowaniu i wydaniu/zużyciu launch permit. Brak bieżącego
  pomiaru effective capacity nie używa wartości last-known ani zera i blokuje
  nowe owner-bound rezerwacje CPU. Jawny limit operatora pozostaje górną granicą,
  ale nie zastępuje bieżącego pomiaru OS/cgroup ani nie dowodzi egzekwowania
  workerów. Obniżenie zmierzonego limitu nie zwalnia ani nie przerywa już
  działających procesów, a ścieżka release pozostaje dostępna.
- Oprócz bilansu jest świeży preflight wolnej RAM/VRAM/scratch. Konserwatywnie
  uwzględnia niewykorzystany jeszcze zapas z istniejących rezerwacji i obce
  procesy. Nieznana atrybucja lub pomiar blokuje automatyczne zwiększenie puli.
- Podane minimum pamięci ma źródło: operator, model estimator lub kalibracja
  zgodnego workloadu. Estymata zawiera margines i wersję; nie jest pomiarem.
- Rezerwacja RAM nie jest twardym limitem OS. Worker publikuje poziom
  enforcement; wymagany hard limit bez wsparcia daje odmowę przed startem.

### 5.3 Algorytm wyboru

1. Wybierz istniejącą kolejnością priority/fairness gotowe taski i case DAG.
2. Zastosuj immutable requested backend/device/precision/mode, workflow
   legality, profile version i required output/input codecs.
3. Sprawdź finalized preparation oraz dependency manifests; nie trzymaj GPU
   podczas długiego oczekiwania na mesh lub poprzedni case.
4. Zbuduj kandydatów z dozwolonej topologii i zgodnych runtime manifests.
5. Usuń kandydatów niespełniających RAM/VRAM/storage/threads/affinity/limits.
6. W ramach pozostałych wybierz zgodnie z polityką: lokalność danych i NUMA,
   zachowanie dużych kart dla dużych zadań, fairness, opcjonalnie kwalifikowany
   koszt historyczny. Brak pomiarów oznacza brak obietnicy przyspieszenia.
7. Atomowo/fenced zarezerwuj cały zestaw albo nic. Gang z 2 GPU nie może
   trzymać jednej karty, czekając bez końca na drugą.
8. Zbuduj per-process environment, uruchom supervisor i zweryfikuj receipt
   rzeczywistej tożsamości urządzeń przed przyjęciem wyników.

Przyczyny są rozłączne: `unsupported_parallelism`, `incompatible_runtime`,
`resource_request_exceeds_capacity` (nigdy się nie zmieści),
`waiting_for_resources` (chwilowo zajęte), `inventory_stale`,
`awaiting_preparation`, `awaiting_dependency`, `policy_conflict`,
`allocation_outcome_unknown`. UI pokazuje przyczynę i działanie naprawcze.
Zmiana profilu nie naprawia automatycznie już zaakceptowanego requestu.

Fairness zachowuje istniejący trwały kursor między runami, rozszerzony o
grupę batch. Jeden sweep 10000 przypadków nie monopolizuje całej kolejki.
Przy jednorodnych, niezależnych cases górna granica concurrency to minimum:
limit użytkownika i operatora, liczba gotowych cases, liczba dostępnych GPU
podzielona przez GPU/case oraz całkowitoliczbowe ilorazy dostępnego CPU,
RAM i scratch przez zasób/case. Warunek VRAM obowiązuje osobno na każdej
karcie; nie sumujemy pamięci niezależnych GPU. Ten wzór jest tylko granicą:
NUMA, heterogeniczne karty, gang i zależności wymagają rzeczywistego placementu.
UI pokazuje ten sam wynik preview co scheduler oraz zasób ograniczający.
Obowiązuje także trwały service-wide limit współbieżnych workerów istniejącej
usługi, osobno dla preparation/solve, niezależny od `max_parallel_cases`.
Przy jednym workerze na case service cap=1 serializuje również batch z
limitem 4. Zmiana cap wymaga wersjonowanej konfiguracji runtime ownera,
spójnej z NodePolicy i ledgerem; nie jest efektem otwarcia UI ani chwilowego
pomiaru wolnego RAM. Preview uwzględnia oba limity i aktualne obciążenie.
Priorytet nie przerywa aktywnych zadań. Backfill nie głodzi dużego gang job:
po ustalonym przez politykę wieku tworzy trwałą rezerwację przyszłego okna.
Drain zatrzymuje nowe admission, Pause batch zatrzymuje nowe cases, a Stop
jest osobnym protokołem zakończenia i publikacji receiptów.

## 6. Przydział GPU i CPU w procesie

Wyłączny worker GPU otrzymuje pełny UUID w masce i lokalny ordinal 0.
To zachowuje istniejący wzorzec `spawn_worker`; ordinal 0 w tym procesie
może oznaczać fizyczne GPU 3 hosta. Maski ustawiamy przed inicjalizacją CUDA.
Nie ustawiamy globalnego środowiska procesu API dla wielu jednoczesnych runów.
Kontener dostaje zgodny zestaw device UUID; maska CUDA nie daje prawa dostępu
do GPU, którego kontener lub zewnętrzny scheduler nie przyznał.

Źródło zasady enumeracji: [NVIDIA CUDA Environment Variables](https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/environment-variables.html).
Pełny UUID jest identyfikatorem trwałym w Fullmag; skróty i numeracja z UI
służą prezentacji. Kolejność kart po reboot nie może zmienić przypięcia.
Legacy `cuda:N` rozwiązuje się w widocznej enumeracji procesu importującego,
z uwzględnieniem odziedziczonej maski. Import utrwala ordinal, maskę i UUID.
Brak możliwości ustalenia tego powiązania wymaga jawnego wyboru; N nie może
zostać cicho zinterpretowane jako indeks fizycznej karty innego hosta.

Native Windows i kontenerowy FEM mają oddzielne adaptery tego samego allocation.
Windows uwzględnia processor groups oraz możliwości affinity/limitów procesu;
Linux cpuset/cgroup i quota, również gdy kontener widzi więcej CPU niż dostał.
Adapter używa runtime-specific thread pools. Nie zakładamy, że zmienna
`RAYON_NUM_THREADS` dowodzi liczby wątków OpenMP albo zmieni raz utworzoną pulę.

Po starcie limitów wątków/urządzeń nie edytujemy w miejscu. Zmiana tworzy nową
próbę/run z jawnym restartem od wspieranego checkpointu. Scheduler nie
przenosi aktywnego CUDA contextu na inną kartę. Migracja po checkpointach
wymaga zgodności codec/mesh/runtime/precision i jawnej proweniencji.

## 7. Sweeps, zależności i wyniki

### 7.1 Dwa typy równoległości

**Niezależne cases:** każdy ma własny snapshot parametrów, seed, katalog scratch
i wynik. Można wykonać je na różnych GPU lub grupach CPU; awaria jednego
nie unieważnia ukończonych niezależnych przypadków.

**Continuation / zależny sweep:** `case[i+1]` wymaga zaakceptowanego outputu
`case[i]`. Histereza zachowuje warm-start i kolejność gałęzi zgodnie z
[notą 0930](../physics/0930-hysteresis-sweep-semantics.md). Równoleglić można
niezależne zewnętrzne łańcuchy, np. kąty lub próbki, jeśli ich initial states
są niezależne; nie dowolne kolejne punkty pola. Przeniesienie stanu między
FDM/FEM lub layoutami wymaga istniejącego jawnego transferu i walidacji.

Bifurkacje/adaptive sweeps dopisują deterministyczną, wersjonowaną decyzję
ekspansji z rodzicami i seed; nigdy nie edytują wcześniej przyjętego manifestu.
Warm caches mesh/operatorów są reuse'owane wyłącznie po kluczu obejmującym
geometrię, materiał, dyskretyzację, fizykę, solver policy, precision i runtime.
Między procesami współdzielimy immutable artifacts; mutable native Context
i CUDA allocations należą do pojedynczego workera.

### 7.2 Idempotencja, awarie, cancel i retry

- Submit używa istniejącego `client_intent_id`; utrata ACK wymaga lookup,
  nie ponownego wysłania z nową tożsamością. Batch ma ten sam kontrakt.
- Case IDs są stabilne wobec kolejności zakończenia. Seed wynika z master
  seed, canonical case ID i nazwanej polityki; nie z indeksu GPU ani PID.
- Retry zachowuje run/task/case i tworzy nowy attempt, dopiero po terminalnym
  dowodzie poprzedniej próby i zgodnym zwolnieniu lease.
- Batch retry używa tej samej komendy `POST .../batches/{batch_id}/commands`
  z akcją `retry` i payloadem `{case_id, task_id, retry_id,
  expected_catalog_revision}`. Serwer wiąże CaseId z RunId z immutable
  manifestu; replay zachowuje command ID i retry ID. Rewizja katalogu,
  terminalny exit receipt oraz dokładne zwolnienie lease są sprawdzane pod
  writer lease przed ACK. Nieudana walidacja nie zapisuje komendy ani nie
  zmienia pozostałych cases.
- Trwały `batch_command.v2` dodaje opcjonalny, digestowany target retry.
  Historyczne `batch_command.v1` bez targetu pozostaje czytelne i nie jest
  przepisywane; nowe pause/resume/cancel i retry zapisują v2. Progress v2
  zachowuje istniejącą listę komend oraz monotoniczny command revision.
- OOM nie wywołuje automatycznie zmiany precision, siatki lub GPU→CPU.
  Można wybrać większą zgodną kartę w ramach requestu; zwiększenie żądanych
  limitów wymaga nowego jawnego requestu. Nauka retry z mniejszym timestep
  jest osobnym kontraktem solvera, nie polityką schedulera.
- Cancel batch ma dwa jawne warianty: zatrzymaj przyjmowanie i dokończ
  aktywne albo zażądaj Stop aktywnych. Oba zachowują wyniki i historię.
- Lost heartbeat / niedostępny node oznacza unknown, nie success ani wolny
  zasób. Stale epoch nie publikuje outputów. Zdalny reconnect uzgadnia
  ten sam attempt przed decyzją o retry.

### 7.3 Wyniki i obserwacja

Każdy case ma manifest outputów i lineage zgodne z ADR 0035. Batch result
jest indeksem tych rezultatów: kompletność, brakujące/failed/canceled cases,
parametry, resolved/executed lanes, jednostki, scalar summaries i referencje
do pól. Nie skleja niezgodnych mesh/precision/parametrów w jedną pozornie
jednorodną tablicę. Agregacje mają określone kryteria równoważności.

Wyniki korzystają z istniejącej [OutputStorage](project-output-storage.md)
i [ADR 0051](../adr/0051-project-output-storage.md): jednej requested policy,
rzeczywistego writera i resolved paths. Defaults pozostają w SQLite workspace
za `/v2/platform/output-storage`. Batch rezerwuje odrębne miejsca cases/attempts
bez kolizji; reservation scratch dotyczy konkretnego attemptu. Nie tworzymy
drugiego rootu storage ani nie zmieniamy własności CAS/receipts. Publikacja
wyników wymagana przez OutputStorage kończy się przed durable completed;
nieudana publikacja pozostaje jawnym stanem, bez usuwania poprawnych danych.

UI obserwuje wybrany run/case przez istniejące identyfikowane źródło danych,
nie przepina wszystkich workerów na alias `current`. W tle mogą pracować
wiele runów, a jeden viewport pokazuje wybrane observation source.
Przełączenie źródła ma własne generation/epoch i czyści niezgodne cache.
Pola pozostają na binary data plane; queue/status zawierają małe podsumowania.

## 8. OpenAPI, mutacje i cache

Tabela opisuje **proponowane** zasoby, poza wierszami oznaczonymi „istnieje”.
Kanoniczną trasą submit pozostaje `persistence/projects`, a nie nowy endpoint
wykonujący solver bez durable RunSpec.

| Zasób / operacja | Odpowiedzialność |
|---|---|
| `GET /v2/platform/runtime-service` — istnieje | Read-only stan ownera; nie lista sprzętu ani uprawnienie do mutation |
| `GET /v2/platform/capabilities` — istnieje | Rejestr runtime; rozszerzenie o parallelism/workload qualification |
| `GET /v2/platform/compute/nodes` — istnieje dla lokalnego hosta; lista zdalna i stronicowanie są proponowane | Inventory/topologia, observed/revision/epoch |
| `GET /v2/platform/compute/nodes/{node_id}` — istnieje dla skonfigurowanego lokalnego hosta | Snapshot węzła; zdalni providerzy pozostają proponowani |
| `GET /v2/platform/compute/nodes/{node_id}/telemetry` | Bieżące bounded samples, per-resource freshness |
| `GET/PUT /v2/platform/compute/nodes/{node_id}/policy` — istnieje dla lokalnego hosta | Typed policy; desktop operator capability, `If-Match`/ledger CAS i walidacja przed durable apply; brak lokalnej capability daje tylko odczyt |
| `GET/POST /v2/platform/compute/profiles` | Katalog; POST wymaga bearer capability lokalnego operatora aplikacji desktopowej i tworzy nową immutable wersję, nie zmienia użytej |
| `GET /v2/platform/compute/queue` | Stronicowany read-model istniejących schedulerów, bez drugiej kolejki |
| `POST /v2/persistence/projects/{project_id}/execution-previews` | Plan legalności i szacowany placement bez lease/spawnu |
| `POST /v2/persistence/projects/{project_id}/runs` — istnieje | Rozszerzony typowany request przyjęcia z profile/resource snapshot |
| `GET /v2/persistence/projects/{project_id}/runs/{run_id}` — istnieje | Run/Tasks; rozszerzone references do allocation i executed receipt |
| `POST/GET .../projects/{project_id}/batches` — parent przyjęcia/listy istnieje | Immutable przyjęcie i stronicowana lista kolekcji; idempotentny parent nie oznacza opublikowanych child runów |
| `GET .../batches/{batch_id}/cases` — manifest projection istnieje | Stronicowane parametry z nazwami osi i jednostkami kanonicznymi oraz planowane RunIds; opublikowane child runy zwracają lifecycle tasków i informację o trwałym żądaniu anulowania przed claimem |
| `POST .../batches/{batch_id}/commands` | Pause admission/resume/cancel or retry one task in a stable case; ACK + command lifecycle |
| `GET /v2/platform/compute/allocations/{allocation_id}` | Read-only szczegóły przydziału; bez tokenów operacyjnych |
| `GET /v2/platform/compute/events/ws` | Proponowane platform-scoped invalidations; potrzebne bez aktywnej sesji |

Pierwsza implementacja hostowa zwraca zero albo jeden lokalny węzeł. Brak
konfiguracji lub próbki ma stan `not_probed`; niebezpieczny odczyt konfiguracji
lub ledgeru zwraca `503`, a lookup nieobserwowalnego `node_id` zwraca `404`.
Świeżość jest przeliczana przy każdym odczycie: próbka starsza niż 30 sekund
ma stan `stale`. Odpowiedzi używają ETag/304. Sam zasób pozostaje read-only i
nie stanowi jeszcze dowodu admission ani przydziału urządzenia.

Preview zawiera `preview_id`, input digest, snapshot/profile/policy/capability
revisions, predicted placement, estimate confidence i reasons. Jest orientacyjne:
Submit przypina wejście, ponownie waliduje wersje, a allocation powstaje dopiero
przy admission. Zajęcie karty między Preview a Submit daje queued, nie zmianę
żądania. Zmiana modelu/profilu wymaga nowego preview lub jawnego 409/stale.

Rewizje inventory, policy, queue i telemetry są oddzielne. Cache key obejmuje
API instance, node/owner epoch i odpowiedni scope project/run/batch. WebSocket
przesyła tylko rewizje/invalidations/lifecycle; reconnect odczytuje HTTP
snapshot i nie wnioskuje o wolnym zasobie z ciszy. Ukryty widok zatrzymuje
odpytywanie telemetryczne; stan kolejki nie zależy od otwarcia strony Home.

Zmiana API oznacza: backend schemas/OpenAPI → generated v2 types/transport →
facade → resource hooks → adapters → wspólne UI. Obecne session diagnostics
pozostają adapterem zgodności do platform host telemetry, z jednym właścicielem
próbkowania i terminem usunięcia podwójnej ścieżki po migracji konsumentów.

Aktualny batch `POST` przyjmuje dokładne archiwum projektu, client
`idempotency_key`, typowany `BatchExpansionRequest`, StudyPlan, immutable
StudyProblemCatalog oraz jawne mapowanie assetów. Przed ACK sprawdza project
snapshot, wejścia źródłowe i każdy case przez canonical planner, po czym
utrwala batch intent i content-addressed expansion manifest. Odpowiedź zwraca
BatchId, logiczny digest i liczbę cases. Nie potwierdza materializacji child
runów, admission ani startu solvera. Batch `GET` zwraca stronicowane summary
parentów wraz z total/published prefix oraz stanem ekspansji. Cases GET zwraca
tuple parametrów i planowane RunIds z manifestu; opublikowany prefix jest
`pending_materialization`, a pozostałe przypadki `pending_expansion`. Nie ma
jeszcze task statusu ani output refs. Commands i worker ekspansji pozostają do
wdrożenia.

Mutacje Settings korzystają z typowanej walidacji i optimistic concurrency.
Nie wysyłają dowolnego polecenia shell ani ścieżki do urządzenia. Lokalny
instance pin ani Origin nie są autoryzacją. Desktop generuje jednorazową,
losową capability dla swojego API sidecara i udostępnia ją wyłącznie głównemu
oknu Tauri z dokładnym lokalnym URL przez IPC. Frontend trzyma ją tylko w
pamięci procesu; standalone browser i uruchomienie z `FULLMAG_UI_URL` pozostają
read-only. `PUT .../policy` wymaga `Authorization: Bearer <capability>` oraz
`If-Match: "compute-node-policy:<node_id>:<revision>"`; brak capability daje
403, brak precondition 428, nieaktualna rewizja 412, a wyścig CAS w ledgerze
409. Zapis waliduje limity względem jawnej konfiguracji hosta. Nie zmienia już
istniejących rezerwacji: obniżenie limitu może oznaczyć politykę jako
`over_budget` i blokować nowe admission do czasu zakończenia pracy. Sekrety i
administracja runtime service nie są częścią tej capability. Zdalny target
wymaga osobnego uwierzytelnienia, ACL projektu/puli oraz TLS, a sekrety
pozostają poza eksportem problemu.

## 9. Python, IR, CLI i odtwarzalność

Zachowujemy obecne `StudyBuilder.engine/device/mode/threads` i typowaną
`RuntimeSelection`. `StudyExecutionProfileReference` staje się wspólnym
wiązaniem StudyPlan z rozwiniętą wersją profilu; nie wprowadzamy osobnego
zestawu znaczeń dla UI, Python i CLI.

| Znaczenie | Obecny owner | Docelowe obniżenie |
|---|---|---|
| backend/device/mode/precision | Python RuntimeSelection + Study authoring | Kanoniczny request w ProblemIR/study → planner → per-task requested execution |
| CPU threads | `study.threads`, `requested_cpu_threads` | Żądanie runtime; adapter do `cpu.threads`, zachowany origin i auto |
| GPU index/count | RuntimeSelection | Legacy single-solve selector; UUID resolve z inventory revision; nie liczba przypadków |
| Profile reference | StudyPlan step.execution_profile | Immutable profile snapshot w RunSpec |
| RAM/VRAM/storage minimum | RequestedResourceBudget | Zachowane minimum + allocation/enforcement, bez interpretacji jako pomiar |
| Case parameters i dependencies | RunSpecification + StudyPlan | Immutable batch manifest → istniejące runy/task DAG |
| Liczba równoległych cases | Nowy BatchSpecification | Scheduler limit; nie parametr kernela ani fizycznego termu |
| GPU UUID/cpuset/host | Nowy allocation binding | Operacyjne receipt/provenance; bez hostowych ścieżek w fizycznym IR |

Rozszerzenia publicznego Python API powinny przyjąć typowane profile/resources
i batch builder, a nie dziesiątki env. Konkretne sygnatury są bramką etapu E1:
muszą mieć walidatory, round-trip i mapę do kanonicznych typów przed eksportem
z UI. Ten dokument nie podaje nieistniejącego skryptu jako wykonalnego przykładu.

Eksport ma dwa jawne warianty: **portable study + wymagania** (domyślny,
bez numerów kart/hostowych ścieżek) oraz **reproduction manifest** wskazujący
rozwiązane profile, UUID/node, runtime/build, seeds i artifacts. Dokładny
replay na innym hoście zgłasza brak przypiętego zasobu, a nie używa podobnej
nazwy GPU. Request `auto` i jego resolution history pozostają odrębne.

## 10. Wiele hostów i scheduler zewnętrzny

Ten sam model node/pool/allocation obsługuje lokalny komputer, kolejny
zarządzany węzeł i adapter klastra. Remote worker wykonuje tylko przypięty
runtime oraz immutable inputy; API użytkownika nie uruchamia arbitralnego
SSH/shell z formularza. Transfer CAS weryfikuje digest, ma resume i osobny
status staging. Ścieżka Windows klienta nie staje się ścieżką scratch Linuksa.

Adapter np. Slurm/HPC otrzymuje jeden konkretny przydział zewnętrzny i
publikuje ograniczone nim zasoby. Fullmag nie rezerwuje całego hosta obok
tego przydziału. Provider job ID wiąże się z admission/attempt; utrata ACK
powoduje lookup tego samego joba. Requeue zewnętrzny jest nowym uzgodnionym
attemptem, nie równoległą drugą próbą. Polityka CPU/GPU/RAM jest przecięciem
limitu klastra, operatora i requestu. Pierwsza integracja wielowęzłowa powinna
przenosić niezależne cases; pojedynczy distributed solve ma dodatkową §11.

Przed wywołaniem providera runtime zapisuje trwały submission record związany
z `run_id`, `task_id`, `attempt_id`, `ownership_epoch` i admitted `resource_id`.
Record przypina provider, target, scheduler, digest niezmiennego requestu oraz
deterministyczny idempotency key. Początkowy stan `submission_unknown` oznacza
„provider mógł przyjąć job”; po restarcie coordinator najpierw wyszukuje tę
samą tożsamość, zanim podejmie dalszą akcję. Nieznany, wysłany, oczekujący ani działający job
blokuje retry i admission kolejnego attemptu. Job ID nie może zmienić się w
trakcie obserwacji, a status przechodzi tylko do przodu. Potwierdzona odmowa
bez utworzenia joba (`rejected`) albo terminalny status istniejącego joba wraz
z jawnym zwolnieniem lease pozwala skoordynować nowy attempt.

## 11. Jeden solve na wielu GPU/CPU — pełny kontrakt docelowy

To odrębny wzorzec od sweepu. Samo ustawienie `gpu_count=2`, dwóch UUID lub
MPI-capable zależności nie oznacza, że solver potrafi podzielić problem.

| Realizacja | Kontrakt wymagany do otwarcia opcji |
|---|---|
| FDM CPU | Jedna obecna CPU route z kontrolą wątków; distributed-memory wymaga osobnego podziału siatki, halo i globalnych redukcji |
| FDM GPU | Partycjonowanie siatki, halo termów lokalnych/gradientowych, rozproszona demag/FFT, globalne kryteria kroku i energii, collective checkpoints |
| FEM CPU | Rozproszony mesh/DoF, ownership/ghosting/constraints, kompatybilne MPI/hypre solvery i wszystkie użyte strategie demag |
| FEM GPU | Wymagania FEM CPU oraz per-rank CUDA device, rezydencja operatorów, CUDA-aware transfers/collectives i ścisły execution receipt |

Planner generuje `PartitionPlan` o własnym digest: global entity IDs,
podział ranków, granice, rank↔node↔GPU binding, topologia komunikacji i
per-rank memory estimates. Nie tworzy osobnego modelu fizycznego dla partycji.
Gang admission obejmuje komplet ranków/CPU/GPU/RAM; ready wymaga wszystkich
uczestników i potwierdzenia zgodnego planu. Awaria ranka zatrzymuje cały
attempt lub uruchamia jawnie wspierany collective recovery, nigdy częściowy sukces.

Checkpoint obejmuje globalny stan i zgodny krok czasu wszystkich partycji;
nie można kontynuować z mieszanki różnych iteracji. Completion manifest
wymaga wszystkich shardów oraz ich indeksu. Globalne energie/obserwable
zachowują jednostki i definicje; kolejność redukcji, błędy zaokrągleń i
deterministyczność są jawnie kwalifikowane dla konfiguracji ranków/precyzji.

Capability jest per workflow/interaction set/demag strategy/precision,
nie ogólnym `supports_multi_gpu=true`. Dopóki jej bramki są otwarte,
UI pokazuje niedostępny „One solve across multiple devices” z powodem.
Plan wdrożenia obejmuje tę ścieżkę, ale nie odblokowuje jej przez zmianę UI.
Nowe noty naukowe rozszerzają istniejących właścicieli interakcji; wymagane
są zbieżność, energia, parity z jednym urządzeniem i właściwe benchmarki.

## 12. Scenariusze odbioru projektu

Liczby są przykładami planistycznymi, nie pomiarem obecnego komputera.

| Scenariusz | Oczekiwany rozkład i warunek |
|---|---|
| 4 GPU, 32 dozwolone rdzenie, 24 niezależne cases; 1 GPU + 4 CPU/case | Do 4 cases równolegle i 16 CPU; kolejne czekają. RAM/VRAM może obniżyć limit |
| 2 sockety po 24 rdzenie; operator udostępnia 40, CPU/case=10 | Do 4 cases, jawne 10-rdzeniowe zestawy; NUMA locality uwzględniona, nie 4×48 |
| 4 GPU, request pojedynczego solve'a wymaga 2 GPU, concurrency=2 | Dwa gang allocations po 2 GPU, wyłącznie po kwalifikacji distributed lane |
| GPU 12/24/48 GiB, case wymaga 20 GiB + margines | Karta 12 GiB nie jest kandydatem; 24/48 według fit i innych rezerwacji |
| Histereza 100 punktów, 4 niezależne kąty | 4 łańcuchy równoległe, w każdym 100 zależnych punktów w kolejności |
| Mixed CPU/GPU pool, forced GPU | CPU nie staje się fallbackiem; czeka na GPU albo jawna odmowa |
| Dwa store'y i kontener żądają tego samego UUID | Jeden host ledger przyznaje najwyżej jeden wyłączny allocation |
| Zmiana polityki podczas solve'a | Aktywny attempt zachowuje przydział; nowe admission respektuje rewizję/drain |
| Brak RAM telemetry lub nieznany UUID po reboot | unknown/blocked, bez sztucznego zera i bez przypięcia po starej pozycji listy |
| API timeout po Submit / crash przy release | Lookup istniejącego intentu; uzgodnienie claim/lease/exit, bez duplicate spawn |

Macierz implementacji i dowodów jest w planie. Powstanie dokumentacji zamyka
projekt architektury, nie implementację ani kwalifikację wielu urządzeń.

## 13. Wersjonowanie pierwszego kontraktu authoring — E1

Typed request używa `problem_meta.runtime_metadata.compute_resources` oraz
`schema_version="compute_resources.v1"`. Dotychczasowe dokumenty bez tego klucza
zachowują obecną ścieżkę. Mapa runtime_metadata jest istniejącym rozszerzalnym
kontenerem IR; nowy obiekt ma własną wersję i odrzuca nieznane pola.

W wire format tokeny używają snake_case: `physical_first`, `any_compatible`,
`allow_list`, `single_process`. Target ma `kind` i tylko dla node/pool `id`;
parallelism ma `kind`, a distributed dodatkowo ranks/threads_per_rank/
ranks_per_node/gpus_per_rank. `cpu.core_policy` jest opcjonalne: brak oznacza
dziedziczenie polityki, nie potwierdzenie affinity. Jawne Auto to string `auto`,
liczba wątków to dodatni u32; bool/ułamek/overflow są błędem. Bajty pamięci
to dodatni u64, NUMA ID nieujemny u32. Brak opcjonalnej rezerwacji nie jest zerem.

Właściciel IR: `crates/fullmag-ir/src/compute_resources.rs` —
`ComputeResourcesIR::validate`, `validate_legacy_selection`.
Właściciel runtime support pozostaje planner/adapter; przejściowy
`validate_current_runtime_support` odrzuca niewdrożone wymagania zamiast je
ignorować. Nie jest to dowód ich wykonania ani docelowe wyłączenie E2–E7.
Runner `requested_cpu_threads` / `configured_cpu_threads` czyta nowy request;
explicit Auto zachowuje Auto i nie dziedziczy numeric env jako jawnego intentu.

Profil, pochodzenie pól, przydział i actual native threads pozostają osobnymi
kontraktami. Pole request nie jest kopiowane do wykonanej telemetrii.
FDM CPU, FDM GPU, FEM CPU i FEM GPU podlegają tej samej walidacji danych;
wykonanie nowej polityki i parity każdej lane pozostają **NOT VERIFIED**,
dopóki nie istnieją odpowiednie dowody z etapów E2/E3/E7.

### 13.1 Przypięty profil i sparse overrides

Kolejny fragment E1 dodaje `execution_profile.v1` i `execution_request.v1`.
Typy i shape validation należą do `fullmag-ir::execution_profile`, a czysta
materializacja i weryfikacja jej odtworzenia do `fullmag-application`.
Profil zawiera immutable `profile_id/version`, opis i częściowe `defaults`.
Digest jest SHA-256 kanonicznego JSON UTF-8 z posortowanymi kluczami.
Wersja `latest` nie może być przypięta do zadania.
`execution_request.v1` przypina również semantykę domyślnych wartości i
pierwszeństwa resolvera. Zmiana tych reguł wymaga nowej wersji i zachowania
odtwarzania v1 dla wcześniej przyjętych runów; nie wolno reinterpretować
starego snapshotu według nowych preferencji aplikacji.

Patch ma odrębny typ od pełnego requestu. `FieldPatch::Absent` pomija pole,
`Value("auto")` zapisuje jawne Auto, a `Value(None)` resetuje pole nullable.
Nie wolno zamieniać tych trzech stanów w jeden opcjonalny odczyt.
Python eksportuje analogiczne `ExecutionProfile`, `ExecutionOverrides`,
`ComputeResourceOverrides`, `CpuResourceOverrides`, `MemoryResourceOverrides`.
Pominięte argumenty znikają z wire format; `None` pozostaje resetem tylko dla
pól nullable. Są to konstruktory danych dla resolvera, nie przełącznik
aktywnego solvera. Walidacja ograniczeń powiązanych pól odbywa się po
materializacji; samo utworzenie częściowego patcha nie dowodzi wykonalności.

`study_problem_catalog.v2` przechowuje pełną materializację dla każdego
włączonego kroku: przypiętą treść profilu i jej hash, warstwy wejść, efektywne
żądanie oraz origin. Katalog sprawdza zgodność id/version z referencją Study
oraz backend/device/precision/mode/resources z immutable ProblemIR.
Application ponownie wylicza materializację przed publikacją runu i przy
jego odczycie. Podmiana requestu, originów lub hash profilu musi być błędem.
RunSpec v2 już przypina hash całego katalogu; nie wymaga nowego pola z
drugim, niezależnym wyborem profilu.

Katalogi v1 pozostają odczytywalne i serializują się bez dopisywania nowych
pól. `from_entries` zachowuje v1 dla starych wpisów; użycie snapshotów
przechodzi na v2 i wymaga ich dla całego katalogu. Nie dopisujemy originów
historycznym runom. Binding tworzy nowy ProblemIR, nie mutuje oryginału.

Szczegóły zaakceptowanego runu wiążą task z krokiem przez deterministyczne
`task_id_for_study_step(run_id, step_id)` i odczytują `execution_materialization`
z przypiętego StudyProblemCatalog. API nie rozwiązuje ponownie profilu z
bieżących Settings ani hosta. Nowe katalogi zwracają na tasku pełny snapshot:
profil i hash, warstwy, efektywny request oraz origin każdego pola. Starsze
katalogi mogą zwrócić `step_id`, ale nie dopisują brakującej materializacji ani
originów. Lista runów pozostaje podsumowaniem RunSpec; dla mieszanych kroków
wybór per-task należy odczytywać ze szczegółów runu.

Ten fragment nie zamyka E1: allowed lanes i failure policy, powiązanie
profilu Settings ze Study/DSL/CLI/env oraz preview pozostają do połączenia
z tym samym resolverem. Provider opisany w 13.2 przechowuje wersje; nie
jest dowodem wykonania ich zasobów.

### 13.2 Trwały katalog profili i publikacja z Settings

Właścicielem `execution_profile_catalog.v1` jest skonfigurowany accepted-run
`SessionStore`. Jedyny plik `compute/EXECUTION_PROFILES.json` jest zapisywany
atomowo pod istniejącą blokadą writera. Nie należy do odbudowywalnego indeksu
ostatnich projektów ani localStorage. Odczyt nie tworzy katalogów. Brak
konfiguracji magazynu zwraca 503; nieprawidłowy istniejący katalog pozostaje
błędem i nie jest zastępowany pustym.

`GET /v2/platform/compute/profiles` zwraca rewizję, stronicowane entries,
`total`, `offset` i `next_offset`. Limit domyślny wynosi 50, maksymalny 100.
Kolejne strony przypinają `revision`; jej zmiana daje 409. Filtry
`profile_id`, `version` (tylko wraz z ID) i `client_intent_id` umożliwiają
lookup konkretnej wersji lub uzgodnienie publikacji. ETag obejmuje treść
strony i instancję API.

POST przyjmuje `expected_revision`, `client_intent_id` oraz typowany profil.
Wymaga `Authorization: Bearer <capability>` wydanego lokalnej aplikacji
desktopowej; sam `Origin` ani dostęp do sieciowego listenera nie uprawniają do
zapisu katalogu. Zwykła przeglądarka zachowuje odczyt katalogu bez edycji.
Application materializuje i sprawdza semantykę defaults przed zapisem.
Publikacja dopisuje wersję z kanonicznym SHA-256, datą UTC i kolejną rewizją;
odpowiedź 201 oznacza nowy zapis. Ten sam intent i ta sama treść zwracają 200
oraz oryginalny wpis, nawet przy nieaktualnej expected_revision. Ponowne
użycie intentu z inną treścią lub pary ID/version z innym intentem daje 409.
Rewizja chroni dwa równoczesne szkice; użyta wersja nigdy nie jest nadpisywana.
Granice katalogu: 1024 wpisy, 4 MiB pliku, 32 KiB pojedynczego profilu.

Settings rozdziela szkic od zapisu. Apply tworzy stałą wersję; Cancel porzuca
nieopublikowany szkic. Refresh aktualizuje katalog bez nadpisania szkicu.
Nieznany wynik POST wymaga lookup po tym samym intent ID; retry zachowuje
identyczną treść i tożsamość. Inherit pomija pole, Auto pozostaje jawne.
Edytor podstawowych pól zachowuje pozostałe sparse resources skopiowanego
profilu. Zapis nie przypisuje profilu do Study ani nie zmienia aktywnych runów.
Uprawnienia operatora NodePolicy i profili korzystają z lokalnej capability;
pełna integracja authoring pozostaje bramką E4. Bieżące dowody implementacji są
w checkpointcie planu.

### 13.3 Powiązanie opublikowanej wersji z nowym Submit

Nowy HTTP Submit z materializacją profilu w katalogu Study odczytuje katalog
profili tego samego accepted-run store. Application rozwiązuje dokładne
`profile_id/version` przez provider i odtwarza zapisane jawne warstwy requestu.
Cały otrzymany snapshot — profil, SHA-256, requested i origins — musi mieć tę
samą kanoniczną treść co żądanie klienta. Brak opublikowanej wersji daje 409
`execution_profile_reference_conflict`; inna treść pod tym samym ID/version
lub niezgodne pochodzenie daje 409 `execution_profile_snapshot_conflict`.
Nie ma fallbacku do domyślnego profilu ani ruchomej wersji.

Przenośny profil zaimportowany ze skryptu trzeba opublikować w docelowym store
przed nowym HTTP Submit. Publikacja nie uruchamia zadania. Stare katalogi v1
bez materializacji zachowują trasę zgodności; nie dopisujemy im pochodzenia.
Powtórzenie zaakceptowanego intentu nie korzysta ponownie z bieżącego katalogu
preferencji: obowiązują zapisane immutable wejścia i fingerprint runu.
Nie zmienia to admission ani nie stanowi dowodu użycia zasobów przez worker.

Python przyjmuje opublikowaną kanoniczną odpowiedź przez
`ExecutionProfile.from_ir(profile_json)`. Typed import zachowuje omission,
jawne Auto i nullable null; `to_ir()` oraz `canonical_sha256()` odtwarzają
treść i tożsamość profilu. Pełny obiekt GPU z opublikowanej odpowiedzi wymaga
selector, UUID list i devices_per_task; VRAM pozostaje opcjonalne. Puste
sparse obiekty normalizują się do pominięcia, zgodnie z Rust. Import odrzuca
obcy schema, nieznane pola, błędne typy i ruchomą wersję `latest`. Nie czyta
hosta, nie rozwiązuje dziedziczenia i nie przypisuje profilu do Study.

### 13.4 Jedna materializacja całego Study

`fullmag-application::materialize_study_execution` przyjmuje dokładny
StudyPlan, authored ProblemIR i jawne warstwy każdego włączonego kroku oraz
provider immutable profili. Nie wnioskuje warstw ze środowiska. Odrzuca
nieznane, wyłączone, brakujące i powielone wejścia. Wersja współdzielona przez
kilka kroków jest odczytywana raz; każdy krok nadal ma własny request/origins.
Wynik powstaje w kolejności StudyPlan, niezależnie od kolejności wejść.
Binding tworzy nowy ProblemIR i katalog v2 związany z rewizją i hashem planu;
oryginalne authored wejście pozostaje niezmienione.

Nowy HTTP Submit używa tej materializacji dla całego katalogu i porównuje
snapshoty po step_id, również gdy klient przesłał inną kolejność entries.
Nie jest to admission preview: topologia, polityka hosta i przydział pozostają
odrębnymi bramkami E2–E4. Study UI nadal wymaga połączenia wcześniejszego
modelu sceny/etapów z kanonicznym authoringiem StudyPlan; sam selector profilu
nie zastępuje tej migracji.

### 13.5 Stateless preview żądania wykonania

`POST /v2/platform/compute/preview` przyjmuje rewizję katalogu profili,
kanoniczny StudyPlan oraz ProblemIR i jawne warstwy każdego kroku. Odtwarza
całe Study tym samym resolverem co Submit i sprawdza lowering przez istniejący
planner. Zwraca pełny katalog do Submit, jego SHA-256, digest znormalizowanych
authored wejść oraz typowane requested/origins per step. `preview_id` obejmuje
instancję API, oba digests i rewizję profili. Kolejność inputów nie zmienia
tożsamości; zmiana instancji lub treści tak. Tożsamość preview nie zastępuje
tożsamości archiwum projektu ani fingerprintu RunSpecification.

Preview nie zapisuje katalogu, nie przyjmuje runu i nie uruchamia preparation
ani workera. `admission_state` ma obecnie wyłącznie `not_evaluated`, a
`blocking_reasons` zawiera `host_admission_not_evaluated`. Sukces 200 oznacza
poprawny podgląd intentu; nie jest potwierdzeniem available capacity, GPU
execution ani kwalifikacji. Policy/inventory/allocation preview wymaga E2–E4.

Granice: 256 kroków, 8 MiB body i 8 MiB odpowiedzi. Nieaktualna rewizja lub
brak opublikowanej wersji daje 409; błędne wejścia/lowering dają 400, brak
skonfigurowanego store 503, uszkodzony istniejący katalog 500. Odczyt
nieistniejącego skonfigurowanego store nie tworzy katalogu na dysku.

OpenAPI typuje envelope, warstwy, profile, pełne zasoby i pochodzenie. Wewnętrzny
StudyPlan/ProblemIR oraz katalog zachowują dotychczasową kanoniczną granicę
JSON stosowaną przez ProjectRunSubmit; Rust jest właścicielem deserializacji
i walidacji tych domain objects. Ta granica nie oznacza pełnych wygenerowanych
typów StudyPlan w UI. Jej usunięcie należy do migracji authoringu E1/E4;
frontend nie tworzy drugiego modelu ani własnego resolvera.

Transport StudyPlan/ProblemIR w preview jest otwartą mapą JSON z wartościami
unknown w wygenerowanym kliencie. Nie jest obiektem bez dozwolonych pól;
pełna deserializacja i walidacja domenowa nadal należy do Rust.
`prepareComputeExecutionPreview` odłącza i zamraża HTTP body oraz zapisuje
jego digest. To digest transportu, nie kanoniczny `source_digest` serwera.
`useComputeExecutionPreviewResource` używa fasady i wspólnej warstwy resource;
klucz obejmuje body i sesję, a API scope izoluje cache. Zmiana epoch/scope
wyłącza stary preview. Hook nie konwertuje sceny do StudyPlan, nie zgaduje
wejść i nie wywołuje Submit; ta projekcja pozostaje oddzielną integracją.

### 13.6 Deklaracja profilu w scenie i Pythonie

SceneStudyState i ScriptBuilderState zachowują opcjonalny `execution_profile`
oraz `execution_layers`. Brak deklaracji pomija oba pola w dotychczasowym
JSON. Projekcje scena → builder → skrypt zachowują wersję i sparse patches;
nie rozwiązują żądań na podstawie hosta ani bieżących preferencji.

Kanoniczny Python udostępnia `ExecutionRequestLayer` oraz
`study.execution_profile(profile, layers=[...])`. Deklaracja musi poprzedzać
kroki solvera/pipeline. Nie można mieszać jej z legacy engine/device/mode/
threads/resources ani change_device, również gdy użytkownik jawnie wybrał
Auto. Eksport używa typed `from_ir()` i zachowuje geometrię oraz numerykę.
Bezpośrednie eager wykonanie z deklaracją profilu jest odrzucane; capture
do ProblemIR pozostaje dostępny i wymaga wspólnej materializacji Rust.

`fullmag-application::bind_declared_execution` rozstrzyga deklarację przed
planowaniem. Zastępuje authored markers w kopii ProblemIR pełnym snapshotem
`execution_materialization`; zapisany snapshot jest odtwarzany również bez
nowych nadpisań. API scene loader, CLI JSON loader oraz oba przebiegi importu
skryptu korzystają z tej samej funkcji. Jawne opcje CLI backend/mode/precision
są warstwą `cli`; sprzeczny wymuszony device i managed lane dają błąd.

Materializacja całego Study nie może pomijać deklaracji przeniesionej w
ProblemIR: pinned profile musi odpowiadać authored wejściu, a lista jawnych
warstw musi zachowywać carried layers przed dodaniem kolejnych. Zastąpienie
profilu wymaga nowego authored wejścia zamiast ukrytego rebindu. Istniejący
snapshot jest sprawdzany przez canonical replay przed wykorzystaniem.

Planner odrzuca unresolved markers i późniejszą zmianę konkretnych bound
backend/device, precision/mode lub zasobów. Auto może zostać zawężone przez
wybór wykonania; requested snapshot nadal zachowuje Auto. Ta kontrola nie
jest host admission ani dowodem egzekwowania przydziału. Scene loader API
nadal ma istniejącą granicę auto/fdm; obsługa FEM i formularz authoringu
Study wymagają kolejnej integracji. Profile nie odblokowują zasobów, których
istniejący planner jawnie nie obsługuje.

### 13.7 Atomowe przypisanie wersji profilu

Istniejący endpoint model transactions obsługuje `assign_study_execution`:
wymagane base_revision, pełny execution_profile oraz execution_layers.
Transakcja zastępuje dokładny snapshot i tablicę warstw, zachowując pozostałą
scenę. Nie scala sparse defaults z poprzednią wersją, nie przydziela zasobów
i nie zmienia przyjętych runów. Walidacja sceny sprawdza originy i konflikt
z Change device; commit nadal korzysta z istniejącego session/revision fence.

Non-null execution_profile w zwykłym merge_patch jest odrzucany jako
execution_profile_requires_atomic_assignment. Merge patch obu pól null
pozostaje sposobem jawnego wyczyszczenia przypisania; ReplaceScene służy
nadal pełnemu importowi i Undo/Redo. Nie ma pośredniej transakcji kasowania
starego profilu przed przypisaniem nowego.

Porównanie zgodności restore uwzględnia authored execution_profile/layers
w kategorii execution. Dotychczasowe sceny bez przypisania zachowują formę
tej kategorii. Sam niezmieniony resolved device nie oznacza tożsamości dwóch
różnych authored profili. Python importuje pominięty request warstwy jako
pusty patch zgodnie z domyślną deserializacją IR; jawny request null jest błędem.

### 13.8 Study Inspector i zapis przypisania w projekcie

Study Inspector wybiera dokładną wersję z resource hook katalogu, zachowuje
nieedytowane warstwy i zaawansowane wartości oraz rozróżnia Inherit i Auto.
Apply korzysta z atomowej transakcji i pierwotnej rewizji szkicu; konflikt
zachowuje szkic i blokuje ponowne Apply do Cancel. Zmiana sesji lub scope API
resetuje szkic. None jawnie czyści przypisanie i warstwy. Profil blokuje
Change device; admission pozostaje Not evaluated. Jednoczesny szkic profilu
i innych zmian Study wymaga osobnego Apply/Cancel; combined Apply jest dalszą
pracą. Formularz kanonicznego preview nie jest jeszcze podłączony.

Zapis projektu korzysta ze wspólnego ProjectDocumentController i projekcji
kanonicznej sceny. Po jawnym utworzeniu projektu powiązanie przechwytuje ID
zaakceptowanej sesji, scope API i potwierdzoną tożsamość session/epoch/request
scope. Save pobiera scenę z tego zakresu, synchronizuje archiwum i dopiero po
potwierdzeniu zapisuje plik. Błąd odczytu, nieznany wynik synchronizacji lub
zmiana zakresu zatrzymuje zapis; starsze bajty nie są używane jako fallback.
Projection zachowuje cały Study wraz z profilem/warstwami, a pomija metadane
zasobu takie jak scene_revision. Same panele nie synchronizują archiwum.

Otwarte archiwum bez jawnego powiązania nadal zapisuje własne dane; nie wolno
zgadywać, że bieżąca sesja do niego należy. Powiązanie po imporcie/restore
i development handoff wymaga dalszej integracji. Kontrole interpretowane
oraz browser fixture nie dowodzą rzeczywistego zapisu przez host/backend ani
egzekwowania zasobów solvera.

### 13.9 Wspólna granica producentów authoringu i preview

API rozdziela przechwycenie authored ProblemIR od wiązania profilu.
`scene_document_to_authored_problem_ir` używa istniejącego kanonicznego Python
DSL i zachowuje surowe profile/layers. Walidacja i binding należą do granicy
materializacji wybranej przez konsumenta. Dotychczasowe live preparation nadal
stosuje swoje ograniczenie auto/FDM, binding i końcową walidację. Funkcja nie
generuje per-step inputs i nie jest oceną dostępności wykonania.

Czysta konfiguracja głównego autosave jest współdzielona jako
`fullmag_ir::configure_project_autosave_policy`. Runtime wrapper zachowuje
sprawdzenie dostępnych formatów przed delegacją; rezerwacje katalogów i zapis
pozostają u istniejącego właściciela OutputStorage. Przeniesienie nie zmienia
cadence, istniejącego explicit stage policy, konfliktów formatu ani reguł dla
modal/hysteresis. Sama konfiguracja polityki nie dowodzi dostępności writera.

Kanoniczne per-step IR wraz z akcjami i przejściami są obecnie produkowane
przez `materialize_script_stages` w CLI. Podgląd musi współdzielić ten producent
po wydzieleniu jego czystej części; kopiowanie jednego base ProblemIR do każdego
kroku nie zastępuje materializacji solvera, zmian stanu ani zależności. Sam
strukturalny adapter StudyPlan nie jest kompilatorem sekwencyjnego wykonania.

`scene_document_to_study_plan` wymaga jawnych migration references modelu,
solver config, discretization i profilu. Nie pobiera mutable current. Niepusty
authored study_pipeline korzysta ze wspólnego from_pipeline; inaczej płaskie
stages zachowują kolejność i pełny legacy payload. Brak etapów nie tworzy Run.
Nieznane rodzaje pozostają Unsupported. Jawne błędne enabled lub source są
odrzucane; brak enabled oznacza true. Podany profil musi odpowiadać referencji
ID/version i poprawnemu authored intent. Wspólny parser Run jest używany także
dla płaskich etapów. Migracja grup dziedziczy enabled od wszystkich przodków,
zgodnie z istniejącym CLI: wyłączona grupa wyłącza wszystkie swoje dzieci,
zachowując źródłowy dokument. Adapter nie tworzy per-step ProblemIR ani portów
stanu/zależności wykonania.

### 13.10 Jeden kanoniczny producent per-stage danych

Historyczne typy capture config są współdzielone przez
`fullmag_application::script_stage_contract`; CLI używa aliasów. Pola,
serde defaults/tags i nazwy terminal_outward_current_density_Apm2 pozostają
niezmienione. Nie jest to drugi canonical StudyPlan. RuntimeResolutionSummary
i dane live pozostają w CLI, bez zależności application od engine/runner/OS.

`script_stage_materialization` posiada istniejącą logikę produkcji stage IR,
actions, macro expansion, sampling i transitions. Binding profilu jest jawnym
krokiem caller-side. Output policy jest przekazywana jako callback: CLI nadal
korzysta z runtime ownera sprawdzającego writer availability, capture API
konfiguruje tylko czystą politykę IR. Nie ma tu przydziału hosta, wykonania
solvera ani pozwolenia na uruchomienie writera. Walidacja poleceń live pozostaje
w CLI. Historyczne źródła regresji są zachowane; nowe Rust fixtures pozostają
source-only przy obowiązującym zakazie kompilowania unit tests.

API współdzieli jeden transport SceneDocument capture dla base ProblemIR
i pełnego ScriptExecutionConfig (`export-scene-ir`/`export-scene-config`).
Pełne authored stages korzystają następnie z tego samego producenta application.
Binding opublikowanego profilu nadal musi być wykonany raz przez materializer
Study. Te wewnętrzne funkcje nie są jeszcze formularzem ani nowym endpointem
preview. Związanie wyników ekspansji/actions z typed steps, CaseIds i portami
stanu pozostaje osobną bramką przed Submit; base IR nie zastępuje rzeczywistych
stage inputs.

Renderer przy flat_workspace pomijał authored flat stages; naprawa capture
i Run payloadu ma focused interpreted regressions. Single/base IR zachowuje
jawny bootstrap-only mode. Nonempty pipeline korzysta ze stage-free base IR
i pustych explicit stages, aby shared Rust owner rozwinął grupy/makra. Empty
pipeline korzysta z rzeczywistych LoadedStage records. Canonical Python export
makr, export actions i niektórych rich policies nadal kończy się jawnym błędem;
nie deklarujemy pełnego Scene → Python round-trip tych form.

Scene preview capture ma być asset-light także na granicy to_ir, nie tylko
podczas load. Include geometry assets uruchamia ich producenta, więc ta
ścieżka musi pomijać zarówno base, jak i stage assets. Nie tworzy siatki/grid
ani pozornej readiness. Legacy export-run-config zachowuje dotychczasowe
pełne assets. Przygotowanie i walidacja realized assets mają własny admission
oraz receipt i pozostają osobnym etapem.

### 13.11 Granica kompilacji etapów do accepted Study

Wspólny producent zwraca uporządkowane solver IR oraz akcje. Accepted worker
ma obecnie jeden task na `step_id`, bez pola akcji i bez wymiaru case w tasku.
Execution i recovery korzystają z case `default`. Nie wolno traktować akcji
save/load/export, zmian urządzenia, drive, autosave/FFT lub transportu jako
solver tasków. Settery zmieniające IR bez emisji etapu również wymagają
audytowalnej reprezentacji skutku. Samo zachowanie źródłowego pipeline w
metadata nie dowodzi zachowania jego wykonania.

Pierwszy jawny adapter może korzystać z rzeczywistych per-stage IR dla
obsługiwanych Run/Relax, dodatniego skończonego horizon oraz wspieranej
rodziny BackendPlan. Standardowy accepted FDM wymaga double/strict; FEM
obecnie CPU/double/strict i H1/P1. Modal, frequency response i multilayer
mają osobne plan variants i nie stają się obsługiwane przez sam capture.
To ograniczenia aktualnej ścieżki, a nie docelowa capability matrix.

Sekwencyjna zależność może wskazywać dokładny output poprzednika:
`initial_state: State <- StepOutput(step_id, final_state, default)`, przy
zadeklarowanym `final_state: State`. Istniejący CAS wiąże artefakt z próbą
producenta i ownership epoch. Worker odtwarza magnetyzację; osobne taski nie
zachowują historii integratora ani cache runtime. Taki transfer nie jest
równoważny `ContinueInPlace`. Kompilator musi blokować sekwencje wymagające
tej ciągłości, dopóki właściwy runtime nie zapewni jej kontraktu.

Rozwinięte makro nadaje dziś wszystkim etapom parent `active_stage_id`.
Przyszły compiler musi utworzyć stabilne unikalne step IDs z zachowaniem
parent ID i parametrów ekspansji. Nie wolno przedstawiać niezależnego sweep
jako sekwencji ani nadawać case IDs, których task creation/worker nie obsługuje.

StudyProblemCatalog wiąże digest StudyPlan, komplet per-step ProblemIR oraz
równość referencji ID/version. Nie rozwiązuje treści modelu, presetów solvera
i mesh recipes. ModelDefinition ma canonical digest bez pola version;
ProjectSnapshot ma definition revision/hash, lecz nie ma jeszcze mapowania
do StudyModelReference. Solver/discretization references nie mają obecnie
wspólnego immutable content ownera. Testowe `solver:default`/`mesh:default`
nie są produkcyjnymi defaults. Przed formularzem Scene preview/Submit trzeba
ustanowić jawne mapowanie do rzeczywistych utrwalonych snapshots; brak
referencji blokuje kompilację, zamiast tworzyć pozornie gotowy katalog.

### 13.12 Limit materializacji Scene preview

Wewnętrzny capture API korzysta z bounded wariantu tego samego producenta,
z limitem 256 wynikowych etapów. Explicit stage list jest sprawdzana przed
klonowaniem assets/polityk; wspólny licznik obejmuje zagnieżdżone enabled groups.
Wyłączone węzły nie zużywają limitu. Makra sprawdzają rzeczywistą liczbę
punktów pomnożoną przez liczbę emitowanych run/relax/save records, z checked
arithmetic, przed alokacją sweep vectors i kopii IR. Hysteresis z jawnymi
field_values sprawdza ich liczbę przed parsowaniem do wektora float.

Primitive sprawdza wynik po jednorazowej materializacji i przed dołączeniem
do kolekcji; nie ma drugiego klasyfikatora rodzajów etapów. Limit ten nie
jest admission ani oceną pamięci solvera. Dotychczasowy dwuargumentowy caller
CLI zachowuje ścieżkę bez nowego limitu. Źródła regresji Rust nie są kompilowane
przy aktualnym zakazie unit-test builds; produkcyjne source gates i dalsza
runtime weryfikacja pozostają odrębnymi dowodami.

### 13.13 Referencje captured input zamiast fikcyjnych presetów

Nowy katalog v3 może posiadać model/solver/discretization input jako trzy
role jednego kompletnego bound ProblemIR. Captured identity v1 zawiera jawny
stabilny source ID i digest tych rzeczywistych bajtów; entry jest właścicielem
content i nie przechowuje jego drugiej kopii. Role mają IDs `captured-model:`,
`captured-solver:` i `captured-discretization:` z tym samym source ID oraz
version `sha256:<digest>`. To nie są registered presets ani wersje mutable
ModelDefinition. Konserwatywnie każda zmiana IR/provenance zmienia wersje.

Canonical IR JSON używa istniejącego sorted-key/UTF-8 encoding profili,
z zachowaniem kolejności tablic. Hash identyfikuje wejście, nie fizyczną
równoważność. Weryfikacja ponownie haszuje całe IR i porównuje role references.
V3 wymaga captured identity i materialized execution dla wszystkich entries.
Brak, mieszanie i downgrade nowej identity do v1/v2 są błędami. Stare katalogi
v1/v2 zachowują dotychczasowy odczyt bez dopisywania brakujących dowodów.

Application współdzieli dotychczasową kolejność validate → published profile
lookup/resolver → carried intent check → bind. Captured input wyprowadza
referencje dopiero z finalnego bound IR, bez ponownego bindingu. Caller nadal
musi zachować authored layers i skompilować rzeczywiste actions/transitions/
typed steps. Sam content owner nie odblokowuje Submit ani równoległości.

V3 preview/Submit wymaga lossless transportu zamrożonego catalog JSON lub
referencji do jego utrwalonego ownera. Read-only parsed projekcja w browserze
nie może być ponownie zakodowana jako accepted content: Number może zmienić
metadata 1.0 na 1 oraz duże integers. Zmienione bytes muszą zostać odrzucone,
zamiast normalizacji scientific input dla dopasowania digestu. Ta bramka
transportu pozostaje do wdrożenia przy Scene preview/Submit.

### 13.14 Trwały ledger hosta przed zwiększeniem concurrency

HostResourceLedger posiada jeden jawny lokalny root, stable host ID,
topology digest, policy revision i owner epoch. Wykorzystuje istniejący
native Writer; JSON owner descriptor nie zastępuje kernel lock. Policy
initialize porównuje już utrwaloną konfigurację, zamiast ponownie próbkować
free RAM lub resetować rezerwacje. Reader nie inicjuje brakującej polityki.

Wspólny `FULLMAG_STATE_ROOT` lokalnej aplikacji zawiera bounded rejestr
`host_id` → dokładny kanoniczny root ledgera. Rejestr używa native Writer,
walidowanego JSON i atomowej publikacji. Jawna inicjalizacja operatora przypina
pierwszy root; runtime open wymaga istniejącego, zgodnego wpisu i nigdy go nie
tworzy. Druga ścieżka dla tego samego hosta, brak wpisu, brak rejestru lub jego
corruption kończą się fail-closed przed otwarciem/admission. Istniejąca
instalacja wymaga jawnej inicjalizacji lub uzgodnienia przez operatora;
system nie scala ani nie migruje ledgerów automatycznie.

Rezerwacje sumują host CPU/RAM/scratch oraz trzymają wyłączne pełne GPU UUIDs
z osobnymi limitami VRAM. Nie mnożymy RAM przez liczbę GPU offers. Jawne
CPU IDs są sprawdzane pod kątem dozwolonego zbioru i konfliktu; bez IDs
bilans agregatów nie jest deklaracją placement/affinity. Tentative i unknown/
quarantined konsumują zasoby tak jak committed. Exact replay nie tworzy
drugiej rezerwacji, a zmiana tokenu/budżetu/fence nie jest replayem.

Dla admission przypiętego do aktywnego host inventory ownera bieżące
`cpu.effective_capacity_millis` jest dodatkowym limitem nad polityką: suma
niezwolnionych rezerwacji nie może przekroczyć mniejszej z pojemności
skonfigurowanej i zmierzonej. Kontrola obejmuje dodanie rezerwacji, przejście
`Tentative→Committed` oraz launch solvera i preparation. Brak pola effective
capacity, `Unavailable` lub próbka `stale` nie otwierają nowego owner-bound
admission CPU i nie są zastępowane limitem polityki, zerem ani wartością
last-known. Jawny limit polityki nadal ogranicza przydział, gdy świeży pomiar
jest dostępny. To ograniczenie admission nie kwalifikuje affinity, quota
enforcement ani zachowania już działających workerów po zmianie OS limitu.

Na Linuxie `enforcement.cpu_quota=Supported` wymaga działającej delegacji
cgroup v2: bezwzględnego `FULLMAG_WORKER_CGROUP_ROOT`, dostępnego kontrolera
`cpu` i jego aktywacji dla dzieci. Usługa nie włącza kontrolera ani nie tworzy
hierarchii hosta. Probe tworzy krótko żyjące dziecko, ustawia i odczytuje
`cpu.max`, a następnie usuwa dokładnie ten katalog. Brak konfiguracji lub
delegacji oznacza `Unavailable` i blokuje owner-bound CPU admission na Linuxie;
affinity ani zmienne środowiskowe nie zastępują quota. Każdy worker host-bound
przed `exec` trafia do własnego dziecka z quota wyliczoną z przydziału, a
supervisor sprawdza członkostwo procesu. Próbka hosta dowodzi jedynie
dostępności adaptera; nie zastępuje trwałego worker receipt ani runtime proof
rzeczywistego wykonania E3.

Windows Job Object quota pozostaje `Unavailable`, jeśli proces należy do joba,
którego pełnego łańcucha limitów nie można potwierdzić. `QueryInformationJobObject`
z `hJob = NULL` odczytuje job bezpośredni procesu; w hierarchii zagnieżdżonej
odczyt nie reprezentuje automatycznie całego łańcucha. Stawka CPU child joba
jest względna wobec stawki przydzielonej parent jobowi. Adapter nie może
traktować odczytu bezpośredniego joba jako efektywnej pojemności hosta;
owner-bound admission pozostaje zamknięte do chwili uzyskania wiarygodnej
pojemności z całego zakresu ograniczeń. Zob. Microsoft Learn:
[QueryInformationJobObject](https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)
oraz [JOBOBJECT_CPU_RATE_CONTROL_INFORMATION](https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information).

Ledger ma bounded document/record limits i checked arithmetic. Każdy zapis
waliduje kompletny stan, a uszkodzony dokument blokuje admission. Nie
odzyskujemy zasobów po wieku heartbeat ani śmierci service ownera. Początkowy
moduł nie udostępnia niepotwierdzonego release/cancel. Worker release sprawdza
trwały process-exit receipt i już zwolniony local lease, wraz z exact identity,
heartbeat i budżetem. Aktywny lease nadal blokuje release, nawet po zapisaniu
receipt. Content-addressed proof jest publikowany przed Released i sprawdzany
przy każdym odczycie; jego brak/uszkodzenie blokuje admission. Publication
unknown nie jest podstawą zwolnienia. Durable local admission precedes spawn.
Identity rozróżnia typed owners Solver (attempt i ownership epoch) oraz
Preparation (preparation attempt), z common store/run/task/resource/token.
Resource ID jest częścią request digest; zmiana lokalnej oferty nie jest
idempotentnym replayem. Preparation nie otrzymuje fikcyjnej epoki solvera.

Runtime-control ma wspólny adapter host allocation oraz wariant dispatch
schedulera z host admission przed Prepare/Start. GPU placement wymaga jawnego
UUID od właściciela topologii, także gdy label lokalnej oferty zawiera UUID.
Adapter przekształca legacy single-GPU lease w per-device VRAM, bez poolingu.
Nie jest to jeszcze konfiguracja działającej usługi ani dowód enforcement.

Root/config/topology ownership, service scheduler/preparation wiring, owner lifecycle
i runtime recovery są nadal otwartymi bramkami E2. Service cap pozostaje 1.


### 13.15 Przypięta konfiguracja usługi i wynik oczekiwania admission

RuntimeServiceConfig v1 zachowuje dotychczasowy format bez host_execution,
limity 1/1 i reuse APPLICATION.json bez resamplingu. V2 wymaga jawnego bindingu:
lokalnego root ledgeru, kompletnej polityki, limitów compute/preparation oraz
map placement o dokładnie tych samych kluczach co skonfigurowane oferty.
V1 z nowym bindingiem i v2 bez bindingu są błędami. Nie ma automatycznej
migracji zapisu operatora. Limity mają dodatnie bounded wartości; pojedyncze
oferty mieszczą się w host budget i per-device VRAM, a wspólny ledger sprawdza
ich współbieżny bilans. Placement nie nadaje qualification ani OS enforcement.

HostRuntimeAdmission otwiera exact istniejący ledger według przypiętej polityki;
nie inicjuje pustego bilansu ani nie przechodzi na v1 po błędzie. Adapter dla
schedulera porównuje digest kompletnej typed konfiguracji, store, pool, role
i cap przekazane przez service ownera. Podmiana pliku podczas handoff nie
autoryzuje innego placement. Oba CLI schedulery mają sparowane flagi bindingu
i digestu oraz walidację pełnych opublikowanych poolów przed ready/admission.
Zmiana oferty wymaga drain i nowej konfiguracji; nie podmienia aktywnego budżetu.

Try host admission zwraca None dla typowanego contention nowego przydziału,
przed publikacją host reservation i local claim. Task pozostaje queued, bez
Prepare/Start. Read corruption, fencing, overflow i publication unknown są
błędami; nie wolno zmienić ich w zwykły stan oczekiwania. Local preparation
admission None po już opublikowanym tentative nadal wymaga reconciliation.

Usługa jawnie odmawia startu v2 do czasu podłączenia host-aware schedulerów,
supervisor release/recovery i lifecycle. Nie ignoruje nowych limitów,
nie podnosi aktywnego cap i nie zmienia pracujących runów. Nowe źródłowe
typy nie stanowią odbioru E2 ani dowodu równoległego wykonania.

Scheduler przekazuje immutable host context do supervisorów. Przed spawn
supervisor wymaga exact Committed reservation, razem z policy fence i całym
przydziałem. GPU visibility pochodzi z explicit placement, a nie etykiety
oferty. Legacy bez bindingu zachowuje dotychczasową trasę.

Worker exit/retry recovery zwalnia host tylko przez durable exit receipt
i exact Released local lease, również gdy terminalna porażka kończy się
błędem supervisora. Active lease po niejednoznacznej reconciliation pozostawia
quarantine. Cancel przed spawn nie ma exit receipt i nie zwalnia host capacity;
trwała no-spawn reconciliation pozostaje otwartą bramką przed startem v2.

Preparation finalize i host proof publication używają jednego host→store lock.
Nie ma okna, w którym local readiness zmienia się przed host release. Recovery
już Released local lease z exact launch/exit proofs omija wcześniejszy finalizer,
ponieważ task może już być queued lub solver-owned po awarii publikacji hosta.
Utrwalony proof jest weryfikowany przed ponownym udostępnieniem capacity.
Service launcher ma forwarding config path/digest i role caps; startup guard
pozostaje do zamknięcia pełnego recovery/lifecycle i runtime gates.

Oba schedulery uzgadniają również host holds, dla których exact local lease
jest już Released, a durable matching exit receipt pozostał po awarii host
publication. Reconciliation jest scope'owana canonical store ID i owner
attempt/epoch/resource/token/heartbeat. Receipt jest ponownie sprawdzany przez
ledger pod host→store lock. Active/missing local lease, brak proof albo proof
innej próby nie zwalniają capacity. History receipts są cache'owane per run
na jeden pass; age/PID lub stan taska nie zastępują dowodu zakończenia.

### 13.16 Import legacy CUDA ordinal i fizyczne przypięcie

`runtime_selection.legacy_cuda_binding` (`legacy_cuda_binding.v1`) utrwala
authored ordinal, odziedziczone `CUDA_VISIBLE_DEVICES` (null oznacza brak maski)
i pełny UUID uzyskany w procesie importującym przez CUDA Driver API.
Nieudana obserwacja zapisuje null UUID i konkretny `resolution_error`; nie
zmienia forced GPU na CPU. CPU, Auto i GPU bez indeksu nie inicjują tej sondy.

Host-aware dispatch wymaga poprawnego bindingu zgodnego z authored ordinal.
UUID musi być obecnie widoczny i dopuszczony przez fizyczną politykę hosta.
Scheduler dopasowuje UUID do configured placement przed zmianą lokalnego
taska; inna oferta jest pomijana. Nowa kolejność enumeracji nie zmienia
przypięcia. Stare indexed wejście bez bindingu wymaga jawnego wyboru GPU;
nie jest interpretowane na nowo według numeracji innego hosta.

Sonda używa `cuDeviceGetUuid_v2`, aby UUID instancji MIG nie zostało zastąpione
UUID rodzica. Sam zapis bajtów CUDA nie dowodzi, że urządzenie jest pełną
kartą: wymagane jest exact membership w polityce fizycznych UUID.
Źródło ABI: [NVIDIA CUDA Driver API — Device Management](https://docs.nvidia.com/cuda/cuda-driver-api/cuda_driver_api/group__CUDA__DEVICE.html).

Przed spawn sprawdzane jest ponownie zgodne immutable wejście i Committed
allocation. Child otrzymuje pojedynczy UUID w masce oraz lokalny indeks 0
dla adapterów FDM i FEM; odziedziczony FEM index nie może zmienić przydziału.
Importer mask jest provenance, nie globalną zmianą środowiska API. Ta ścieżka
nie stanowi jeszcze NodeSnapshot/freshness, kwalifikacji MIG ani runtime
odbioru E2/E3. Guard startu usługi v2 pozostaje do pozostałych bramek.

### 13.17 Trwałe zezwolenie startu i dowód no-spawn

Host admission zapisuje w solver lease opcjonalny `host_launch_binding.v1`:
exact lokalny ledger root i przypiętą politykę. Binding jest częścią fence
tożsamości dzierżawy; replay lub heartbeat nie może go usuwać ani podmieniać.
Stare v1 JSON bez bindingu zachowuje format i trasę legacy. Brak nowego pola
launch gate w istniejącym rekordzie hosta wymaga jawnej migracji: nie oznacza
automatycznie Pending i nie autoryzuje nowego procesu.

Nowa rezerwacja solvera ma gate Pending. Supervisor pod host→store lock
sprawdza exact aktywny host-bound lease i Committed reservation, a następnie
trwale zużywa zezwolenie (Consumed z unikalnym tokenem) **przed** próbą tworzenia
procesu. Replay Consumed nie daje następnego spawn. Nieznany wynik publikacji
lub awaria po zużyciu zezwolenia utrzymuje capacity do reconciliation.

Worker odczytuje binding z durable lease, niezależnie od argv. Przed wykonaniem
i rezerwacją katalogu próby sprawdza Committed allocation i matching token
przekazany przez supervisora. GPU worker dodatkowo wymaga exact pojedynczego
UUID w CUDA mask oraz lokalnego indeksu 0 w adapterach FDM i FEM. Pominięcie
flagi procesu lub użycie legacy supervisora nie usuwa bindingu.

Anulowanie przed pierwszym spawn zamyka wyłącznie Pending gate pod tym samym
host→store lock. Consumed nie może zostać zamienione w Closed na podstawie
braku PID, Started eventu lub heartbeat. Po trwałym Closed, terminalnym
anulowaniu i exact local lease Released publikowany jest content-addressed
proof WorkerNoSpawn, a dopiero potem host Released. Każdy odczyt Released
waliduje ten proof, Closed gate, identity, budget i przypięty binding.
Worker process-exit proof dla nowego host-bound lease wymaga Consumed gate;
Closed nie może jednocześnie potwierdzać startu procesu i no-spawn. Te same
warunki obowiązują przy release oraz późniejszym odczycie utrwalonego proof.

Recovery przed wyborem kolejnej oferty uzgadnia również Closed gate z exact
już Released local lease, gdy owner przerwał publikację proof/host Released.
Active/missing lease nadal utrzymuje hold. Preparation ma odrębny process
launch protocol; nie otrzymuje fikcyjnego solver launch tokenu. Nadal otwarte
są partial admission bez local lease, awaria między Consumed i spawn oraz
owner/policy lifecycle i pełne runtime gates. Startup v2 pozostaje guarded.

### 13.18 Odtworzenie dokładnej intencji local admission

SessionStore udostępnia odczyt i replay pojedynczego task admission przez
run/task/attempt. Odczyt ma limit 1 MiB, walidację regular file/path oraz typed
identity. Wyłącznie rzeczywisty NotFound oznacza brak zapisu; corruption lub
inne błędy IO nie mogą być interpretowane jako brak przyjęcia zadania.
Targeted replay korzysta z istniejącego apply protokołu pod store writer,
bez uruchamiania innych intencji w tym runie.

Host reconciliation pod host→store lock sprawdza Tentative/Pending solver
reservation, canonical store ID, exact lease identity/budget i przypięty
launch binding w zapisanej intencji. Dokańcza jej lokalną projekcję bez nowej
próby/tokena. Promocja do Committed wymaga następnie exact aktywnej dzierżawy
i zgodnego current Preparing/Stopping ready task. Superseded lub niedostępny
claim zachowuje hold; nie zwalnia CPU/GPU na podstawie błędu replay.

Oba schedulery wykonują ten pass przed wyborem ofert i przed recovery już
Released leases. Brak intencji nie tworzy synthetic admission i nie jest
automatycznym rollbackiem. Resume Prepare/Start po częściowym handoff, brak
local admission record i awaria po Consumed nadal wymagają dalszego recovery.
Sam Committed allocation nie dowodzi startu workera ani ukończenia E2/E3.

### 13.19 Wznowienie przygotowanego handoff po restarcie schedulera

Host-aware compute scheduler sprawdza istniejące Preparing/Ready claims na
wolnym lokalnym slocie przed wyborem nowego unclaimed zadania. Zachowuje
attempt/token/budget i nie nalicza nowego admission ani przesunięcia queue
cursor za samo odzyskanie. Wymaga zgodnej immutable admission oraz current
Committed/Pending allocation; Consumed/Closed nie autoryzują ponownego spawn.

Jeżeli nie ma genesis, watermark ani historii journalu tej próby, odtwarza
coordinator z exact admission. W pozostałych przypadkach odzyskuje istniejący
coordinator i uzgadnia jego projekcję. Istniejące Prepare i Start envelopes
pozostają niezmienne. Prepare zawiera authoritative ResolvedTaskInput; bez
niego używany jest wyłącznie istniejący resolver automatycznie dostępnych
inputs z immutable study, preparation receipt i catalogs, z claim validation.
Nie zastępujemy utraconych explicit/manual overrides domyślnymi wartościami.

Readonly Prepare może zostać ponownie zwalidowane i potwierdzone przy pending
inbox. Prepared event używa stabilnego attempt-derived ID i kolejnego durable
sequence. Brakujące Start jest publikowane tylko raz, a już pending Start jest
przekazywane supervisorowi bez ponownego receive. Applied Start, divergent
envelopes lub missing inbox po opublikowanym Start wymagają reconciliation.
Helper nie wykonuje solvera. Drain i role cap nadal ograniczają handoff.

Ta ścieżka nie obejmuje Stopping/Consumed recovery, brakującej admission,
preparation no-spawn ani owner lifecycle i NodeSnapshot freshness. Kompilacja
i runtime bramki są dokumentowane oddzielnie w checkpoincie; startup v2 guard
pozostaje do pełnego odbioru E2/E3.


### 13.20 Odzyskanie przerwanego anulowania przed spawn

Jeżeli supervisor zapisał Closed i zakończone anulowanie, ale przerwał się przed
zwolnieniem lokalnej lease, reconciler może dokończyć ten zapis. Operacja używa
lock order host→store i wymaga exact Committed/Closed reservation, active
host-bound lease oraz current Cancelled task z tym samym attempt/epoch/resource.
Inne fazy i Consumed nie dopuszczają odzyskania bez dowodu zakończenia procesu.
Po lokalnym release istniejąca ścieżka publikuje immutable WorkerNoSpawn proof
i zwalnia host reservation. Awaria pomiędzy tymi zapisami jest replayowalna.

Nie rozwiązuje to odzyskiwania Stopping przed publikacją Stopped ani Consumed
przed potwierdzeniem uruchomienia. Startup guard v2 pozostaje.


### 13.21 Stopping przed uruchomieniem procesu

Host reconciler wybiera exact solver reservations Committed z Pending albo
Closed oraz current Stopping task i active lease. Odtwarza coordinator journal
i odrzuca sprzeczność z eventem Started. Dla Stopping zamyka niewykorzystaną
bramkę pod host→store locks, następnie publikuje trwały Stopped z bounded,
deterministycznym ID tej próby. Consumed nie może być zamknięte: race ze spawn
pozostawia rezerwację do process reconciliation.

Jeżeli Stopped jest już w journalu, lecz catalog nadal wskazuje Stopping,
odzyskiwana jest tylko projekcja. Następnie exact Closed+Cancelled kończy local
release, a istniejąca ścieżka publikuje WorkerNoSpawn proof i host release.
Nie tworzymy Prepare/Start ani nowego attempt/token. Nie obejmuje to Consumed
recovery, brakującej admission ani preparation no-spawn; startup guard pozostaje.

Po niepewnym wyniku publikacji Stopped sam odczyt widocznego journalu nie
dowodzi trwałości. Terminal replay odnajduje exact event entry (ID, sequence,
task, attempt, epoch, token), porównuje typed envelope i ponawia commit tego
samego wpisu. Dopiero potwierdzona publikacja pozwala naprawić catalog i
zwolnić local lease. Błąd potwierdzenia zatrzymuje release.


### 13.22 Rollback admission nieopublikowanego w store

Sam brak admission nie zwalnia rezerwacji. Pod host→store writer locks
rollback wymaga exact Tentative/Pending solver identity i przypiętej policy,
braku admission tej próby, exact local lease oraz aktywnej lease zadania,
braku journalu tej próby i current Ready/Queued, unclaimed task bez genesis
i watermark. Next task epoch musi dokładnie odpowiadać reserved ownership epoch.
Brak catalogu/zadania, inne epoki, corruption albo niepewne dane zatrzymują release.

Ledger publikuje immutable AdmissionAbsent certificate z exact queued snapshot
i request digest przed atomowym Closed+Released. Odczyt Released waliduje ten
historyczny certyfikat, bez odpytywania później zmienionego store. Rezerwacja
nie ustanowiła claimu, więc wyłącznie ten potwierdzony rodzaj release nie zużywa
solver epoch. Nowa próba może użyć tej samej next epoch, ale nigdy starego
attempt ani exact reservation identity. Stary publisher jest odrzucany jako
Released. Pozostałe rodzaje release zachowują monotoniczne epoki.


### 13.23 Preparation process binding i launch barrier

Preparation lease ma optional host_launch_binding, zachowany przy heartbeat
i uwzględniony w identity_matches. Host admission zapisuje exact ledger root
i policy; scheduler zwraca tę samą bound lease. Host reservation ma osobną
preparation_launch_gate, z Pending dla nowej rezerwacji; brak w starszym JSON
nie jest domyślną zgodą i wymaga jawnej migracji. Solver gate pozostaje oddzielna.

Po trwałym preparation process-launch record supervisor zużywa Pending→Consumed
pod host→store locks, dla exact Committed allocation, Active bound lease i
Accepted task oczekującego przygotowania. Token jest przekazywany do preparera,
który odczytuje binding z durable lease i sprawdza Committed/Consumed przed pracą
natywną. Bound lease bez przypiętego supervisora jest błędem. Nie ponawiamy spawn
po Consumed ani po ambiguous launch. Legacy v1 bez bindingu zachowuje swoją trasę.

Exit proof nowej preparation wymaga Consumed i zgodnego binding/policy/root;
stare unbound proof pozostaje kompatybilne. Ta dostawa nie obejmuje jeszcze
preparation no-spawn release, odzyskania Tentative po local lease ani positive
reconciliation przerwania między Consumed i spawn. Są to dalsze bramki E2/E3.

Non-consuming Pending preflight przed local launch publication odrzuca
legacy/mismatched gate bez tworzenia one-shot śladu. Atomic consume po zapisie
nadal ponownie waliduje wszystkie warunki. Awaria po local launch, przed consume
pozostawia exact Pending i historyczny supervisor owner; odzyskanie wymaga
jawnego owner takeover/adoption z zachowaniem oryginalnego launch record. Nie
podmieniamy historycznego PID/tokena ani nie przedstawiamy go jako nowego ownera.


### 13.24 Przejęcie preparation launch przed consume

Exact Committed/Pending dowodzi, że host-bound supervisor nie uzyskał jeszcze
zgody na spawn. Dopuszcza to użycie pojedynczego, niezmienionego local launch
record po restarcie, bez wnioskowania o śmierci procesu z PID/age. Historyczny
launch zachowuje swojego publishera. Atomic consume zapisuje dodatkowo
`host_preparation_launch_owner.v1`: original launch ID/digest oraz PID i start
token rzeczywistego supervisora, wyliczone dla aktualnego procesu. Brak użytecznego
start token blokuje consume. Tylko lock winner dostaje permit.

Pod host→store locks wymagamy exact Active bound lease, Committed/Pending,
Accepted/awaiting-preparation task, dokładnie jednego zgodnego launch dla próby,
braku exit evidence i preparation receipt. Exact launch replay confirmuje
trwałość zapisu przed consume. Preparer weryfikuje digest/powiązanie original
launch i consumed permit; heartbeat po spawn nie zmienia tej tożsamości.

Exit proof zawiera ten sam actual launch owner i jest porównywany z host record.
PID/start token exit receipt nadal opisuje child, a nie supervisora. Legacy
unbound replay pozostaje ambiguous; Consumed bez owner metadata wymaga migracji.
Consumed-before-spawn positive recovery i preparation no-spawn pozostają otwarte.


### 13.25 Roll-forward preparation admission

Awaria po local lease publication, przed host Committed, jest uzgadniana pod
host→store locks. Wymagane są exact canonical store/reservation, Tentative/Pending
preparation owner, Active lease z tym samym binding/policy/budget/identity oraz
current Accepted/awaiting-preparation task bez preparation receipt. Trwałość
lease jest potwierdzana przed atomowym Tentative→Committed. Operacja nie tworzy
nowej próby, tokena ani launch. Brak/released lease pozostawia hold; mismatch
lub corruption zatrzymuje recovery.

Przed finalizacją exit live release ponownie porównuje jedyny launch z owner
launch ID/canonical digest oraz ledger root lease. Immutable released proof
pinuje owner, więc późniejsze odczyty historycznego release nie resamplują store.


### 13.26 Nieopublikowane preparation admission

Rollback przed local lease wymaga pod host→store locks exact Tentative/Pending
preparation identity, braku lease pod exact token (także Released), aktywnej
preparation/solver lease zadania, related launch/exit próby oraz preparation
receipt. Pozytywnym certyfikatem jest istniejący Accepted task z readiness
awaiting-preparation, bez claim/epoch/resource/genesis/watermark. Brak catalogu
lub zadania nie jest certyfikatem; nieczytelne rekordy są błędami.

Immutable PreparationAdmissionAbsent proof z request digest i captured accepted
task jest confirmowany przed atomic Closed+Released. Historyczny proof nie
odczytuje ponownie zmiennego store. Nie tworzymy lease ani nowej próby, a stara
identity/attempt nie może być użyta ponownie. Preparation nie zużywa solver epoch.


### 13.27 Anulowane preparation przed spawn

No-spawn release wymaga exact Tentative/Committed Pending lub Closed preparation
reservation, bound local lease i durable Cancelled task bez solver claim/epoch/
resource/genesis/watermark. Raw solver-lease scan oraz active prep enumeration
odrzucają sprzeczny drugi owner; existing prepared receipt lub related exit
wyklucza tę ścieżkę. Consumed nie może zostać zamienione na no-spawn.

Pod host→store locks confirmujemy catalog, trwale zamykamy gate, zwalniamy local
lease i confirmujemy jej Released publication. Immutable PreparationNoSpawn
proof z released lease i captured cancelled task poprzedza host Released.
Awaria po Closed lub local release jest replayowalna; dowód historyczny nie
resampluje późniejszego store. Hook uzgadnia już zapisane anulowanie; publiczna
komenda anulowania pre-admission/preparation i jej UI wymagają osobnego odbioru E4.


### 13.28 Żądanie anulowania zadania bez claimu

Trwały `task_cancellation_intent.v1` jest osobnym, niezmiennym rekordem
`runs/<run>/task_cancellation_intents/<task>.json`. Zawiera identyfikator
żądania, oczekiwaną rewizję catalogu, dokładny snapshot Accepted/Queued task
bez aktywnego claimu, przyczynę i kanoniczny digest bez czasu publikacji.
Snapshot może zachować historyczną ownership epoch po retry. Rekord ma limit
256 KiB; przyczyna jest niepusta i ograniczona do 4096 bajtów.

Store serializuje żądanie swoim writerem: publikuje intent przed podbiciem
rewizji catalogu, zachowując treść zadania. Exact retry sprawdza wcześniejszy
rekord przed expected-revision CAS; naprawa brakującej rewizji wymaga dokładnego
snapshotu. Inne żądanie dla tego samego zadania jest konfliktem. Nowy admission
jest zablokowany, lecz exact wcześniej opublikowany admission może być naprawiony
i następnie obsłużony przez istniejący protokół Stop.

Supervisor pod host→store locks sprawdza intent przed konsumowaniem solver
lub preparation launch permit. Samo żądanie nie zamyka gate, nie zwalnia
capacity, nie zmienia Consumed i nie projektuje terminalnego Cancelled. Scheduler
musi zastosować anulowanie zależnie od rzeczywistego stanu bramki i procesu;
Consumed preparation zachowuje Accepted do prawidłowego uzgodnienia finalizacji.
Publiczny wynik requested jest odrębny od potwierdzenia zakończenia i od
WorkerCommand. Retencja FMS/live/archive zachowuje intent bez nowych CAS roots.

Integracja scheduler/API/OpenAPI/UI oraz runtime/fault-injection odbiór tej
ścieżki pozostają otwarte. Sam zapis rekordu nie oznacza gotowego anulowania.


Scheduler obu faz enumeruje run-scoped intent records i stosuje je po
reconciliation host reservations. NOWY host admission sprawdza intent przed
publikacją rezerwacji. Terminalna projekcja wymaga braku aktywnego solver lease
i nieuzgodnionego published admission; historycznych claimów nie odtwarza się
zbiorczo na potrzeby anulowania. Exact prior owner najpierw kończy handoff
Prepare/Start, potem zapisuje rzeczywisty Stop i wykonuje no-spawn recovery.
Consumed preparation czeka na exit/finalization/release; nie zamieniamy
niepewnego procesu na niewykorzystane pozwolenie. Oba supervisory, również
legacy bez host ledger, odmawiają spawn przy existing intent.

Live/archive traversal odrzuca intent z expected revision nowszą od catalogu;
równa rewizja jest dopuszczona dla crash przed catalog bump. Wprowadzone
podłączenia źródeł pozostają NOT VERIFIED do nowej bramki produkcyjnej oraz
nie zastępują runtime/fault-injection i public API/UI odbioru.


Publiczna cancellation surface zachowuje legacy request reason-only i Stop
response z command_id. Nowa gałąź wymaga razem cancellation_id oraz dodatniej
expected_catalog_revision; zwraca Requested z własnym cancellation_id i
aktualnym lifecycle, bez fikcyjnego WorkerCommand. Task readmodel ma optional
cancellation_intent summary walidowany pod kątem snapshot/revision/ownership.
Zajęty writer daje retryable run_store_busy. Potwierdzone odrzucenie NEW request
z nowszym catalogiem daje run_task_cancel_revision_conflict; UI może wtedy
po odświeżeniu utworzyć nowe żądanie. Unknown publication lub transport failure
zachowują pierwotny id/revision i nie oznaczają odrzucenia ani zakończenia.
Ograniczony native component gate potwierdził żądania API i projekcję obu
nieprzypisanych tasków przez standalone scheduler: rev5, Cancelled, bez claimów
i host reservations. Scheduler zakończył się jawnym `stdin-v1` drain; konfiguracja
v2 nadal nie startuje przez service ownera. [Raport](../plans/active/compute-execution-20261004/scheduler-cancellation-check-20261007.md)
oddziela ten dowód od Submit, worker/release, service lifecycle i fizycznego
enforcement. Browser/full Settings acceptance pozostaje otwarte.

### 13.29 Inicjalizacja przypiętej konfiguracji hosta

Wejście operatora `fullmag runtime initialize-host-application --config <absolute-path>
--config-sha256 <digest>` przyjmuje zwalidowaną konfigurację v2 i SHA-256 jej
kanonicznej, typowanej reprezentacji JSON, zgodnie z pinem schedulera.
Digest nie jest hashem formatowania pliku. Niepoprawny pin lub niezgodność
odrzuca operację przed otwarciem SessionStore. Store musi już istnieć.
`store_root` odpowiada dokładnej kanonicznej ścieżce SessionStore, także
kanonicznemu prefiksowi ścieżki Windows. Puste pola pomijane przez serde nie
wchodzą do typowanego pinu, nawet gdy są obecne w wejściowym JSON.

Inicjalizator utrwala `runtime-services/APPLICATION.json` przez istniejącą
granicę konfiguracji aplikacji. Istniejąca konfiguracja musi być dokładnie
równa kandydatowi; v1 ani zmieniona polityka nie są automatycznie migrowane.
Ledger jest inicjalizowany dopiero po tej publikacji, bez trzymania store
writera podczas przejęcia host writera. Błąd ledgera pozostawia przypiętą
konfigurację do dokładnego ponowienia; częściowego stanu ledgera nie odbudowuje.

Startup guard i launch guard wykluczają konkurencyjne uruchomienie podczas
inicjalizacji. Obecność OWNER.lock, OWNER.json lub LAUNCH.json wymaga osobnej
ścieżki uzgodnienia ownera; nie usuwamy tych rekordów ani nie oceniamy ich
bezpieczeństwa na podstawie wieku lub PID. Inicjalizacja nie próbkuje ponownie
zasobów, nie zmienia owner epoch, nie uruchamia procesów ani nie publikuje pul.

Wynik `runtime_host_initialization.v1` wiąże configuration digest, store ID,
target, host ID, policy revision, owner epoch i topology digest. Pole
`execution_available: false` zachowuje rozdział inicjalizacji od dostępności
wykonania. Guard startu runtime v2 pozostaje do czasu odbioru pełnego lifecycle,
topologii, enforcement i recovery. Status implementacji i bramek dowodowych
określa checkpoint; ten kontrakt sam nie dowodzi wykonania.

Ograniczony odbiór operator initialization na przypiętym pakiecie opisuje
[raport 26 kontroli natywnych](../plans/active/compute-execution-20261004/host-initialization-check-20261007.md).
Nie odblokowuje on guardu v2 ani pozostałych bramek wykonania.

### 13.30 Planowana generacja runtime i kontrolowany upgrade ABI backendu Docker

**Status: PLANOWANE — NIEZAIMPLEMENTOWANE.** Ten kontrakt nie jest dowodem
uruchomionego runtime, HMR ani kwalifikacji GPU. Ma przygotować bezpieczną
migrację backendu Docker, gdy implementacja i odbiór będą osobno gotowe.

#### 13.30.1 V4 dokumentu ledgera i bounded CAS

V4 `HostResourceLedgerDocument` dodaje mały, typowany wskaźnik `runtime_state`:

```json
{
  "schema_version": "host_runtime_state.v1",
  "readiness_sha256": "<64-lowercase-hex>",
  "snapshot_sha256": null
}
```

`readiness_sha256` jest digestem kanonicznych bajtów immutable blobu świeżej
GPU/runtime readiness. `snapshot_sha256` jest opcjonalnym digestem kanonicznych
bajtów immutable blobu `ComputeNodeSnapshot`; `null` jest wymaganym stanem po
ustanowieniu nowej generacji, zanim pierwszy snapshot zostanie zaakceptowany.
Blob zawiera pełny typed payload i jest walidowany po odczycie; dokument zawiera
wyłącznie referencje. `policy`, `reservations` i `node_policy` zachowują
obecne pola oraz semantykę.

Obowiązują dotychczasowe limity: readiness blob ma najwyżej 256 KiB, snapshot
blob najwyżej 4 MiB. Limit dokumentu ledgera pozostaje niezmieniony; jego
serializacja V4 musi sprawdzać jawnie rezerwę na mały blok wskaźników. Wskaźnik
nie może stać się obejściem limitu przez inline JSON, nieograniczony tekst lub
WAL.

#### 13.30.2 Upgrade i publikacja

Kontrolowany upgrade jest dozwolony tylko po spełnieniu wszystkich warunków:

1. host writer jest zdobyty w istniejącym lock order;
2. upgrade ma wyłączną bramkę inventory i nie ma aktywnego
   `HostInventoryOwner`;
3. wszystkie rezerwacje są `Released` (`allReleased`), bez `Active`, `Tentative`,
   `Committed` lub `Quarantined`;
4. nowa readiness jest zbudowana z aktualnego, jawnie zweryfikowanego GPU i
   ABI, a jej typed blob został zapisany i potwierdzony przed zmianą dokumentu.

Po tych warunkach następuje jedna atomiczna publikacja dokumentu V4 z nowym
`runtime_state.readiness_sha256` oraz `snapshot_sha256: null`. Nie ma etapu,
w którym dokument wskazuje nieopublikowany blob, ani etapu częściowego
przenoszenia policy/reservations/node policy.

Snapshot publikuje się w dwóch rozdzielonych, trwałych krokach: immutable CAS
blob, potwierdzenie jego treści i durability, a potem jedna atomiczna publikacja
pointera `snapshot_sha256` pod writerem oraz właściwą kontrolą ownera. Widoczny
blob bez pointera jest osieroconym, nieszkodliwym kandydatem do retencji; pointer
bez poprawnego blobu jest corruption i blokuje admission. Po publikacji można
wykonać bounded GC pod tym samym writerem: obejmuje wyłącznie nieosiągalne,
regularne pliki snapshot CAS o dokładnym 64-znakowym digest-nazewnictwie,
zachowuje bieżący pointer oraz readiness CAS, a także legacy files i dane
historyczne. Sprzątanie jest idempotentne po awarii i może być kontynuowane przy
następnej publikacji lub inicjalizacji; nie usuwa wyników ani nie wykonuje
globalnego prune storage.

#### 13.30.3 Generacja jako fence wykonania

`runtime_generation_sha256` musi być zapisany i sprawdzany w każdej nowej
konfiguracji usługi, host bindingu, `HostReservationRequest`, local admission
i worker launch permit. Jego wartością jest dokładnie `readiness_sha256` z
runtime state oraz dokładnie 64 znaki lowercase hex, bez prefiksu `sha256:`.
Żaden konsument nie może zastąpić go tagiem obrazu, numerem builda, ścieżką
Windows ani chwilowym odczytem GPU.

Stale generation, brak generation, niezgodny digest readiness/snapshot,
missing/corrupt CAS, wrong GPU, brak aktywnego ownera albo ownerless v2 request
kończą się odmową fail-closed. Rezerwacja nie może być zbudowana na snapshotcie
z poprzedniej generacji, nawet jeśli jego czas mieści się w zwykłym freshness
window. Worker odmawia przed native startem; nie ma cichego fallbacku CPU ani
ponownego użycia starego permitu.

#### 13.30.4 Wersje i ścieżka legacy

Binaria V1–V3 muszą odrzucić dokument V4 jako nieobsługiwany schemat, zanim
wykorzystają policy, reservations, node policy lub runtime state. Historyczne pliki readiness/snapshot oraz marker pozostają zachowane dla
kontrolowanej diagnostyki. Dokument ledgera jest aktualizowany atomowo do V4
z zachowaniem polityki, historii rezerwacji i NodePolicy. Nie są automatycznie
traktowane jako bieżące dowody V4 i nie mogą otworzyć ownerless admission.
Nowy czytnik może rozpoznać poprzedni format tylko przez jawny adapter
kompatybilności, bez dopisywania brakującego generation digestu.

#### 13.30.5 Wymagane źródła i odbiór

Implementacja wymaga zmian w następujących granicach:

- `crates/fullmag-session/src/host_resource_ledger.rs`;
- `crates/fullmag-session/src/runtime_service_host.rs` i
  `crates/fullmag-session/src/types.rs`;
- `crates/fullmag-runtime-control/src/host_runtime.rs`;
- `crates/fullmag-api/src/runtime_service_main.rs`;
- worker/preparer i supervisor launch paths, w szczególności
  `crates/fullmag-api/src/accepted_fem_preparer.rs` oraz powiązane worker
  permit consumers;
- Docker runtime helper `docker/all-in-one/runtime_service.py` oraz jego
  konsument startu `docker/all-in-one/entrypoint.py`; generacja jest ustalana
  przy inicjalizacji fizycznego hosta, nie podczas kompilacji obrazu.

Odbiór musi obejmować idle upgrade i restart z zachowaniem Windows storage,
sesji i wyników; odmowy dla aktywnych/quarantined reservations, wrong GPU,
corrupt/missing CAS, stale config/generation/permit i ownerless v2; oraz
fault-injection przed i po atomicznej publikacji pointera. Wymagany jest także
test granicy małego dokumentu z zachowaną rezerwą oraz testów limitów 256 KiB
i 4 MiB. Do czasu przejścia tych bramek status pozostaje PLANOWANE.

### 13.31 Jawny teardown prywatnego środowiska osieroconego workera

[ADR 0062](../adr/0062-worker-orphan-namespace-teardown.md) ustanawia oddzielny
proof `WorkerOrphanTeardown`; nie jest to `Worker`, `WorkerNoSpawn` ani wynik
symulacji. Zakres to jedna rezerwacja `Committed`, dokładny aktywny lease i
bramka `Consumed`, gdy nie istnieje trwały worker exit receipt. Wynik pozostaje
nieznany. Implementacja oraz rzeczywisty odbiór Docker: **NOT VERIFIED**.

Request `host_worker_orphan_teardown_request.v1` przypina store/host,
run/task/attempt/ownership epoch, resource/lease, runtime generation, token
Consumed i digests rezerwacji oraz lease. Digests dokumentów typowanych liczy
się z canonical JSON; zewnętrzne owner/config/launch i receipt są przypięte
po surowych bajtach. Request nie zawiera własnego digestu. Zawiera też hostową
autoryzację, storage certificate/mount attestation, Engine ID oraz dokładny
container/image/config i mapowanie GPU prywatnego dedykowanego backendu.

`begin_worker_orphan_teardown` pod host→store writerami zapisuje immutable
intent, potem `Quarantined`. Capacity nadal jest zajęte. Powtórzenie tego
samego requestu po awarii między zapisami kontynuuje jego intent; inny request
nie może przejąć kwarantanny. Brak aktywnego inventory ownera i innych
niezwolnionych rezerwacji jest wymagany pod writerem. Host sprawdza też brak
innych działających klientów z RW mountem tego samego ledgeru.

Po autorytatywnym zatrzymaniu dokładnego prywatnego PID namespace host tworzy
`docker_namespace_teardown_attestation.v1`: ten sam Engine/container/image/
config, rzeczywiste `exited`, PID 0, `FinishedAt`, zero potomków i odłączone
dokładne mapowanie zasobu. Niepewny stop lub współdzielony/hostowy namespace
nie uprawnia do zwolnienia. Native completion ponownie sprawdza request,
immutable intent i attestation; zapisuje `AwaitReconciliation`, osobny v2
release proof oraz zwalnia wyłącznie przypięty local lease i host reservation.

Historyczny token pozostaje `Consumed`. Nie powstaje syntetyczny PID, worker
exit receipt, Started ani heartbeat acknowledgement. Solve nie jest
powtarzany. Exact replay kończy częściową publikację; już zwolniony lease
wymaga dokładnego istniejącego proofu. Journale i wyniki pozostają zachowane.
Przed publikacją nowego proofu wszyscy współdzieleni klienci wymagają upgrade;
starszy reader ma odmówić odczytu nieznanego proofu. Nie deklarujemy zgodności
wstecznej tej nowej operacji. Testy regresji i live Docker są osobnymi bramkami.

## Wspólna normalizacja authoring — ADR0057

Scoped korekta ownership z E1: pure replay execution profile/layers jest współdzielony przez IR core, a application re-exportuje te same funkcje i nadal wiąże ProblemIR, rozstrzyga capability oraz steruje submit/runtime. Algorytm precedence, origins i immutable hashes pozostaje bez zmian. Authoring adaptive waliduje efektywne requested intent, zamiast stale legacy fields sceny. Nie ma zmiany wire, fizyki ani nowego GPU fallback. [ADR0057](../adr/0057-shared-execution-intent-normalization.md) określa zakres i bramki; implementacja/runtime wymagają osobnych dowodów.


### Polityka równoległości jest obiektem — korekta po GHA38294719727

Pełne authoring validation134PASS/1FAIL ujawniło serde struct sequence fallback: `[]` normalizowało się do serialdefaults. Shared `ParallelExecutionPolicyIR` Deserialize wymaga teraz mapy, zachowując canonical defaults, typy, duplicate/unknown-field rejection i validation zakresów na dotychczasowych boundary. Scene explicit null reset pozostaje wspierany przez istniejący helper; raw policy null nie staje się obiektem. JSON object wire/Serialize bez zmian, brak nowej capability lub zmiany fizyki. Dodatkowe regresje obejmują pełny roundtrip, malformed runtime metadata i duplicate rawJSON. Nowy CI pending.
