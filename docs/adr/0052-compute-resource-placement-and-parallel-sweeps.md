# ADR 0052 — zasoby wykonania i równoległe przypadki sweepu

Status: **accepted** jako architektura objęta zleceniem implementacji użytkownika.
Data: 2026-10-04. Implementacja i kwalifikacja pozostają w toku; accepted
nie oznacza wsparcia wszystkich opisanych ścieżek przez bieżący runtime.

## Kontekst

Fullmag ma publiczne CPU/device controls, StudyPlan, RunSpecification,
resource pools, trwały scheduler i GPU UUID binding w workerze. Ustawienia
wątków są jednak rozwiązywane przez kilka niezależnych warstw, referencja
execution profile nie jest jeszcze pełnym materializerem, a store-local
resource IDs nie dowodzą wyłączności fizycznego hosta między store'ami.
Compute environment pokazuje odczyty; nie jest katalogiem przydziałów.

Użytkownik potrzebuje jednego modelu łączącego Settings, wymagania solvera,
kilka GPU/socketów CPU, równoległe sweeps oraz docelowo distributed solve.

## Proponowana decyzja

1. Rozdzielamy obserwowany ComputeNodeSnapshot, wersjonowaną NodePolicy,
   ExecutionProfile/RunResourceRequest, immutable BatchSpecification oraz
   allocation i executed receipt. Telemetria nie jest rezerwacją.
2. Jeden resolver materializuje profile i jawne override'y do każdego
   kroku Study/ProblemIR oraz RunSpec. Zachowuje Auto, origin i wersje;
   wykrywa sprzeczności backend/device/precision/mode przed Submit.
3. Rozszerzamy istniejący runtime owner/scheduler i store catalogs.
   Wspólny ledger hosta rezerwuje CPU/RAM/GPU/scratch dla wszystkich store'ów,
   preparation i solve. Fenced prepare/commit i reconciliation poprzedzają
   spawn; release wymaga dowodu zakończenia workera.
4. GPU wiążemy po pełnym UUID i potwierdzamy native receipt; ordinal jest
   lokalny dla maski procesu. CPU allocation steruje rzeczywistymi pulami
   i affinity, ze wskazanym poziomem OS enforcement.
5. Independent batch tworzy trwałe child RunIds i stable CaseIds. Liczba
   równoległych cases jest niezależna od liczby GPU/ranków jednego solve'a.
   Continuation/histereza zachowuje zależności stanu.
6. Settings zarządza zasobami i profilami, Study żądaniem wykonania oraz
   osobnymi solver configs, Compute environment pokazuje fakty, Jobs kolejkę,
   a Results rzeczywisty przydział. Wszystko używa typed API/resource hooks.
7. Wielourządzeniowy pojedynczy solve wymaga PartitionPlan, gang admission,
   collective lifecycle i lane/workflow-specific kwalifikacji numerycznej.
   UI nie otwiera tej możliwości na podstawie samej liczby wykrytych GPU.

## Relacja z istniejącymi decyzjami

Rozwijamy [ADR 0049](0049-native-runtime-owner-control.md), zachowując jednego
właściciela wykonania. [ADR 0037](0037-accepted-preparation-resource-admission.md)
nadal oddziela preparation i solve leases. [ADR 0035](0035-typed-study-artifact-manifest-and-worker-boundary.md)
zachowuje typed outputs/CAS/fencing, a [ADR 0051](0051-project-output-storage.md)
jest jedyną polityką output paths/writer/tmp. Nie tworzymy drugiej kolejki
buildów ani drugiej ścieżki publicznego Python DSL.

## Rozważone alternatywy

| Alternatywa | Powód odrzucenia |
|---|---|
| UI edytuje justfile/env | Brak immutable intent, izolacji równoległych workerów i typowanego kontraktu |
| Tylko zwiększyć max-concurrency | Nie rozwiązuje CPU/RAM budget, UUID overlap między store'ami i wątków native |
| GPU count oznacza też concurrency | Miesza niezależne cases z podziałem jednego operatora i jego pamięci |
| Nowa kolejka sweepów obok schedulera | Dubluje admission, fairness, recovery i katalog wyników |
| Najpierw wdrożyć rozproszony solver | Opóźnia niezależne cases i łączy prostszy problem scheduling z osobną numeryką |

## Konsekwencje i migracja

Potrzebne są wersjonowane kontrakty, profile catalog, host ledger, native
receipts i adaptery Windows/Linux. Koszt złożoności jest uzasadniony ochroną
przed podwójnym przydziałem oraz możliwością odtworzenia wyników. Historyczne
runy pozostają czytelne jako legacy/unreported; nowe pola nie fabrykują
brakujących dowodów. Rollback blokuje nowe admission, zachowując aktywne
runy, journal i wyniki. Distributed capabilities pozostają zamknięte do
kwalifikacji konkretnych workflowów.

Pełna [specyfikacja](../specs/compute-resource-execution-v1.md),
[projekt UI](../design/start-screen/docs/10-compute-settings-and-multi-device.md),
[audyt i plan etapów](../plans/active/compute-execution-20261004/README.md)
określają pola, precedence, błędy, przykłady, właścicieli i bramki.

## Granica wspólnego producenta etapów (2026-10-05)

Preview i wykonanie mają korzystać z jednego istniejącego producenta per-stage
ProblemIR, actions i transitions. Jego czysty owner przechodzi z CLI do
fullmag-application. Binding profilu pozostaje w istniejącym resolverze,
runtime writer availability i I/O pozostają u ownera runtime/OutputStorage.
Nie kopiujemy base IR jako substytutu konfiguracji każdego kroku.

Historyczny ScriptExecutionConfig i jego untyped pipeline są transportem
kompatybilności kanonicznego Python helpera, a nie drugim publicznym StudyPlan.
Wspólne typy application zachowują obecne pola, serde tags/defaults i zachowanie;
CLI używa re-exports. Nie zmienia to publicznego OpenAPI ani numerics. Kryterium
usunięcia aliasów CLI: wszyscy konsumenci importują wspólnego ownera. Czytnik
historycznego wire format pozostaje kompatybilny z zapisanymi skryptami.

Relokacja zachowuje kolejność binding → materializacja → planner. Preview
korzysta z authored wejść i późniejszego jednego lookupu opublikowanego profilu;
nie wykonuje solvera i nie domyśla się state dependencies ani host admission.
Macro expansion i synthetic actions muszą zostać jawnie związane z typed
steps/cases i portami stanu przed Submit. Nie traktujemy samego przeniesienia
kodów/types jako gotowego preview ani równoległego wykonania.

Weryfikacja obejmuje niezmieniony transport, zgodność ciał istniejących
producentów, source gates obu konsumentów oraz późniejsze runtime/preview
regresje. Rollback przenosi ownera z powrotem bez zmiany wire format i blokuje
niegotowe nowe wejścia; nie przepisuje zaakceptowanych RunSpecifications.

## Właściciel referencji przechwyconego wejścia Study (2026-10-05)

Scene capture nie wymaga istnienia fikcyjnego zarejestrowanego preset/recipe.
Nowy katalog v3 może sam posiadać immutable content, którego referencje model,
solver config i discretization dotyczą. Każdy entry zawiera rzeczywisty,
kompletny bound ProblemIR, profil oraz opis tożsamości captured input v1.
Trzy referencje są rolami tego samego utrwalonego wejścia; ich version jest
`sha256:<digest całego ProblemIR>`, nie wersją dowolnego zewnętrznego presetu.
Role IDs powstają z jawnego stabilnego source ID i mają prefiks `captured-`.
Nie udajemy trzech niezależnych publicznych bibliotek ani wersji ModelDefinition.

Digest stosuje istniejące sorted-key/UTF-8 encoding execution profiles.
Obejmuje wszystkie pola bound IR, także provenance, a nie fizyczną równoważność.
Zmiana dowolnego pola wejścia konserwatywnie zmienia wszystkie trzy wersje.
Nie usuwa to pól w celu dopasowania starszego hasha. Katalog weryfikuje content
digest oraz wyprowadzone ID/version przy validate i resolve; nie czyta current,
pliku skryptu ani mutable preset/mesh później. Source ID jest jawny i nie służy
do wyszukania mutable modelu. Nie kopiujemy drugiego pełnego IR do identity.

V1/v2 zachowują dotychczasowy format i odczyt; nie dopisujemy im brakujących
właścicieli ani dowodów. V3 wymaga captured identity i materialized execution
dla każdego entry. Mixed/missing identities, downgrade do v1/v2 z nowym polem
oraz tampered bytes są błędem. Właściciel hashów/ref validation pozostaje
w istniejącym StudyProblemCatalog. Application wykonuje binding raz przed
utworzeniem finalnych referencji i StudyPlan. Ten kontrakt sam nie zapewnia
compiler actions/cases, state continuity, host admission ani execution readiness.

Transport v3 musi zachować utrwalony catalog JSON bez ponownego kodowania
przez obiekt Number przeglądarki. JSON.parse/stringify może zamienić metadata
`1.0` na `1` lub utracić precyzję dużego integer; nie normalizujemy scientific
wejścia w celu dopasowania hasha. Preview/Submit muszą przenosić zamrożone
encoded bytes lub odnosić się do ich utrwalonego ownera. Read-only projekcja
do prezentacji nie jest właścicielem tych bajtów. Ta bramka jest nadal otwarta.

## Trwały host ledger i migracja admission (2026-10-05)

Właścicielem trwałych rezerwacji hosta jest odrębny HostResourceLedger w
fullmag-session, współdzielący istniejący native Writer i publication barriers.
Root jest jawny i wspólny dla podłączonych store'ów; nie jest wyprowadzany
z dowolnego host_resource_id ani tworzony automatycznie per SessionStore.
Polityka ma stable host ID, topology digest, policy revision i owner epoch.
Te wartości wymagają właściciela inventory/config; ledger ich nie wykrywa
i nie nadaje wykrytym ofertom statusu physical-host qualification.

CPU/RAM/scratch są liczone raz dla hosta. GPU są wyłączne po pełnym UUID,
a VRAM jest oceniany osobno dla każdej karty. Opcjonalne jawne CPU IDs
wyznaczają exclusivity; pusty zbiór oznacza wyłącznie bilans agregatów,
nie dowód affinity. Tentative, Committed i Quarantined trzymają budżet.
Idempotencja wymaga dokładnego store/run/task/attempt/epoch/lease token,
polityki, topologii i całego requestu. Corruption/overflow/conflicting replay
blokują operację. Publication unknown wymaga read/replay i nie zwalnia zasobów.

Integracja ma stosować porządek host writer → local store writer oraz
protokół tentative → durable local admission → committed → spawn.
Po nieznanym wyniku local admission lub publikacji hosta nie ma rollback
release. Reconciliation potwierdza exact durable claim; brak kontaktu lub
heartbeat age pozostawia quarantine. Release committed wymaga istniejącego
typed process-exit receipt i dokładnej tożsamości claimu; cancel tentative
wymaga potwierdzonego braku local admission, a nie booleanu klienta.

Worker release wymaga równocześnie trwałego process-exit receipt oraz
Released local lease z identycznymi run/task/attempt/epoch/resource/token,
heartbeat i budżetem. Sam receipt nie wystarcza, ponieważ reconciliation
może zatrzymać lease przy niejednoznacznym efekcie. Ledger utrwala bounded,
content-addressed proof przed zmianą stanu na Released; każdy odczyt tego
stanu sprawdza proof. Brak lub corruption blokuje ponowne użycie capacity.

Moduł nie jest jeszcze połączony ze schedulerem/preparation ani physical
inventory/config. Preparation ma własny typed owner z process attempt ID,
bez fikcyjnego solver ownership epoch. Common identity zawiera local resource
ID, a request digest uniemożliwia podmianę oferty przy replay. Runtime-control
tworzy request z exact claimu i jawnego placement; nie wyprowadza physical
UUID z etykiety. Wariant dispatch z host ledger zatrzymuje odmowę przed
Prepare/Start, lecz usługa wymaga jeszcze podłączenia konfiguracji.
Nie podnosimy cap=1,
nie zmieniamy aktywnych leases i nie deklarujemy E2 ukończonego. Dopiero
integracja wszystkich ścieżek admission/release oraz test dwóch store'ów
z recovery/fencing mogą otworzyć równoległe wykonanie.
