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

Ledger ma źródłowe połączenie ze schedulerem, preparation i przypiętą
konfiguracją; physical inventory/lifecycle i runtime odbiór są nadal otwarte.
Preparation ma własny typed owner z process attempt ID,
bez fikcyjnego solver ownership epoch. Common identity zawiera local resource
ID, a request digest uniemożliwia podmianę oferty przy replay. Runtime-control
tworzy request z exact claimu i jawnego placement; nie wyprowadza physical
UUID z etykiety. Wariant dispatch z host ledger zatrzymuje odmowę przed
Prepare/Start; start usługi v2 pozostaje zablokowany przez niezamknięte bramki.
Nie podnosimy cap=1,
nie zmieniamy aktywnych leases i nie deklarujemy E2 ukończonego. Dopiero
integracja wszystkich ścieżek admission/release oraz test dwóch store'ów
z recovery/fencing mogą otworzyć równoległe wykonanie.

RuntimeServiceConfig v2 przypina explicit host policy/root, role-specific
concurrency i exact placement maps. V1 zachowuje format, cap=1 i trwałe reuse;
migracja nie następuje przy discovery lub odczycie APPLICATION.json.
HostRuntimeAdmission porównuje pełny config digest/store/pool/role/cap
i otwiera już istniejący ledger bez fallbacku lub initialization. Service
przekazuje binding do schedulerów; start v2 jest jawnie odrzucany do odbioru
pełnego recovery, owner/policy lifecycle, topology i runtime.

### Właściciel próbki inventory na wspólnym hoście

`RuntimeServiceOwner` pozostaje właścicielem jednego `SessionStore` i jego
schedulerów. Własność próbkowania fizycznego hosta należy do osobnego,
wyłącznego `HostInventoryOwner` zakotwiczonego we wspólnym root `HostResourceLedger`.
Wiele usług store'owych może korzystać z tej samej próbki i ledgeru; tylko
proces z hostowym lease'em publikuje snapshot. Per-store lock nie może być
traktowany jako wyłączna własność hosta.

Host inventory owner ma trwałą, stabilną tożsamość oraz własną monotoniczną
`host_owner_epoch`, odrębną od `HostResourceLedgerPolicy.owner_epoch` (fence
przypiętej polityki). W następnej wersji snapshot i każdy request admission są
przypięte do bieżącej epoki host ownera. Publikacja weryfikuje lease i epokę pod
blokadą writera host ledgeru. Przejęcie po kontrolowanym recovery inkrementuje
epokę; restart jednego `SessionStore` jej nie zmienia, jeśli inny store nadal
trzyma lease hosta. Format v1 zachowuje swoje dotychczasowe pola i znaczenie.

Po przejęciu poprzedni snapshot nie staje się bieżący nawet wtedy, gdy ma mniej
niż 30 sekund. Admission dla wszystkich store'ów czeka na pierwszą poprawną
próbkę nowej epoki. Rezerwacje z poprzedniej epoki pozostają zajęte lub
quarantined do exact reconciliation/release; samo przejęcie lease'a i wiek
heartbeat nie zwalniają zasobów. Ten kontrakt wymaga wersjonowania snapshotu
oraz odrębnych testów dwóch store'ów, właściciela inventory, awarii pierwszej
próbki i recovery przed odblokowaniem admission.

Try admission rozróżnia typed capacity contention nowego candidate od
corruption/fencing/unknown publication. Tylko contention przed publikacją
pozostawia task queued bez local claim i Prepare/Start. Nie wyprowadzamy
tego wyniku z tekstu dowolnego błędu lub wieku heartbeat.

Solver lease przechowuje optional `host_launch_binding.v1` jako część trwałej
tożsamości. Supervisor trwale zużywa launch gate Pending→Consumed przed spawn,
a worker weryfikuje matching permit z durable lease, niezależnie od argv.
Stare rekordy hosta bez gate nie są migrowane do Pending automatycznie.

No-spawn release jest odrębnym typem proof: wymaga gate trwale Closed pod
host→store lock i exact Released local lease. Closed może powstać wyłącznie
z niewykorzystanego Pending, a nie z Consumed na podstawie PID/heartbeat.
Proof jest publikowany przed host Released i walidowany przy każdym odczycie.
Awaria po local release jest uzgadniana przez scheduler przed kolejną ofertą.
Partial admission bez local lease, awaria między consume i spawn, protokół
preparation oraz owner lifecycle nadal wymagają pełnego odbioru E2.


Rollback przed lokalnym admission wymaga oddzielnego AdmissionAbsent proof,
wydanego pod host→store locks z exact queued/unclaimed task epoch, bez local
lease, admission i journalu próby. Nie jest oparty na wieku/PID ani samym braku
pliku. Taki rollback nie zużywa solver epoch; exact identity i attempt pozostają
trwale zabronione do reuse, a nowa próba może użyć następnej epoki niezmienionego
tasku. Jest to wąski wyjątek od monotoniczności rezerwacji, uzasadniony brakiem
ustanowionego claimu. Runtime i fault-injection odbiór tej ścieżki są oddzielne.

Preparation ma oddzielną launch gate, lecz wspólny typ bindingu host policy/root.
Supervisor trwale zużywa jednorazowy permit przed utworzeniem procesu; preparer
weryfikuje go z durable lease przed native preparation. Stare bramki nie są
automatycznie migrowane, a no-spawn i Consumed recovery nadal wymagają odbioru.


Żądanie anulowania przed claimem zapisujemy jako osobny immutable intent
ze snapshotem i expected catalog revision, bez fikcyjnego solver attempt lub
WorkerCommand. NEW admission i Pending→Consumed launch sprawdzają intent
pod właściwymi writer locks; exact wcześniej opublikowany admission pozostaje
naprawialny. Właścicielem zastosowania żądania jest scheduler/host gate protocol,
a samo requested nie potwierdza zakończenia ani nie zwalnia capacity.
Wire contract zachowuje dotychczasowy Stop dla rzeczywistego claimu; nowa gałąź
pre-claim wymaga odrębnego wyniku i odbioru API/OpenAPI/UI. Reguły i aktualne
ograniczenia określa sekcja 13.28 specyfikacji; pełna integracja jest w toku.
