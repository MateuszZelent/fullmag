# ADR 0060 — accepted FEM GPU w developerskim Workspace Docker

Status: przyjęte do implementacji; kwalifikacja runtime **NOT VERIFIED**.
Data: 2026-10-15.

## Kontekst

Obraz z CUDA i działający managed CLI nie wystarczają do wykonania zadania GPU
przez formularz Workspace. Wersja profilu Docker v1 publikuje wyłącznie CPU,
a adapter accepted FEM z ADR 0045 obsługuje tylko CPU. Użytkownik wymaga obu
usług developerskich i rzeczywistego GPU z jednego publicznego Workspace.
Sesje i wyniki mają pozostać bezpośrednio w storage Windows.

## Decyzja

Rozszerzamy istniejący accepted FEM adapter o GPU; wspólny worker zachowuje
Start/Prepare, heartbeat, Stop, durable completion i publication. Numeryka
pozostaje w natywnym backendzie `backends/fem`; adapter wywołuje kanonicznego
runnera z niezmiennym planem i `StageFemMeshIdentity`. Jeden Python DSL,
ProblemIR, planner i API v2 nadal obsługują FDM/FEM oraz CPU/GPU.

Requested `cpu` lub `gpu` musi zgadzać się z rzeczywistym lease. `auto` pozostaje
w authored intent; jawny override managed launchera wskazuje przydzielony
resolved device. Brak zgodnego lease, natywnego runtime lub dowodu urządzenia
kończy preflight przed solver side effect i `started receipt`. GPU nie może
spaść do CPU. Pierwszy adapter GPU obejmuje H1/P1, double, strict, time evolution,
LLG-overdamped relaxation oraz jawnie wybrany FEM `ProjectedGradientBb` z
realizacją `native_cuda_pgbb`. Inne minimizery, FDM direct minimizers,
nieobsługiwane outputs oraz niezakwalifikowane kombinacje pozostają odrzucone.
Nie promujemy przy tym statusu naukowej walidacji żadnej fizyki.

GPU worker wymaga aktywnego host launch binding zweryfikowanego przez wspólny
`HostResourceLedger`, dokładnego lease i jednego fizycznego UUID. Supervisor
ogranicza widoczność do tego UUID, a runner używa ordinału 0 w ograniczonym
środowisku. Nazwa zasobu ani sam plan nie są dowodem urządzenia. Readiness GPU
wymaga rzeczywistego natywnego probe; polityka hosta wiąże kanoniczną topologię,
aktualny inventory i budżety. Brak lub utrata tych dowodów zamyka admission,
zachowując istniejące rezerwacje i obowiązek kontrolowanego recovery.

Stan GPU ma osobny wersjonowany envelope
`fullmag.fem.gpu.accepted-state-snapshot.v1`. Cztery primary carriers wiążą
natywne wartości, mapę lokalnych węzłów, indexed geometry oraz typed native
execution receipt wraz z przydzielonym UUID. Receipt musi dowodzić strict
`device_resident`: zgodnych masek required/resolved/executed, pustych masek
host/unknown, zera fallbacków i transferów compute w hot loop. Pozytywny krok
i zegar pochodzą z natywnego snapshotu. Recovery odczytuje bounded immutable
`m_final.json`, ponownie dekoduje receipt i porównuje odtworzony envelope;
nie uruchamia solvera ponownie. CPU zachowuje własny schema v1 i carriers.
Dla FEM `ProjectedGradientBb` final provenance musi dodatkowo zachować
`requested_energy_minimizer=projected_gradient_bb`,
`resolved_energy_minimizer=projected_gradient_bb` oraz
`energy_minimizer_realization=native_cuda_pgbb`; brak zgodności kończy attempt
failure bez fallbacku.

Wspólny ledger hosta używa oddzielnego profilu `host-ledger-v1`: ext4 backing
pod kanonicznym `storage/build-volumes`, zarządzany mount i bind `/host-ledger`
wyłącznie w backendzie. Nie rozszerzamy sesyjnego grantu `windows-folder-v1`
na globalny ledger ani nie tworzymy ukrytego named volume. Jednorazowy helper
montowania jest narzędziem utrzymania; frontend i backend pozostają dwiema
usługami aplikacji. Frontend nie otrzymuje ledgeru, GPU ani accepted store.

## Trwały cache frontendu developerskiego

Rzeczywisty start na Docker Desktop ujawnił koszt operacji metadata na bindzie
Windows: instalacja zależności trwała ponad 28 minut, a kompilacja Workspace
nie zakończyła się podczas dziesięciominutowej próby. Nowy run UUID tworzył
również nowy cache. Sam otwarty port i przekierowanie HTTP nie dowodzą gotowości.

Zależności pnpm, oba importer node_modules i cache Next otrzymują oddzielny
profil `fullmag-frontend-cache-v1`, z backing ext4 w kanonicznym
`storage/build-volumes`. Stabilny klucz obejmuje ścieżkę checkoutu, worktree,
port, dependency seed i wersje narzędzi. Zwykła edycja źródeł lub nowy commit
nie zmienia klucza; zmiana zależności wybiera inny cache. Źródła nadal pochodzą
z readonly bindu Windows, a sesje, wyniki, logi i receipty pozostają bezpośrednio
w storage Windows. Frontend nie otrzymuje host ledgeru ani GPU.

Jednorazowy helper przygotowuje i weryfikuje dokładny backing, loop mount,
UUID ext4 i owner marker. Compose jawnie deklaruje cztery writable bindy;
nie stosuje ukrytych named volumes. Aktywny konsument tego samego cache
blokuje konkurencyjny start. Launcher zapisuje tożsamość cache i sprawdza
rzeczywiste mounty kontenera. Zmiana nie usuwa wcześniejszego cache ani nie
modyfikuje aktywnego środowiska. Gotowość wymaga odpowiedzi 2xx z `/workspace`.

Implementacja cache, jego ponowne użycie po restarcie Docker Desktop i
HMR z checkoutu Windows wymagają odrębnych dowodów runtime; pozostają
**NOT VERIFIED**, dopóki te bramki nie przejdą. Wycofanie polega na zatrzymaniu
własnego frontendu i przywróceniu wcześniejszej konfiguracji z jej zachowanym
cache; backing ani wyniki nie są kasowane.

## Migracja poleceń live w Dockerze

Backend Docker nie ma konsumenta starszej kolejki live. Dlatego w tej trasie
zarówno CPU, GPU, jak i `auto` przechodzą przez istniejący accepted pipeline.
Natywny launcher zachowuje dotychczasową trasę legacy; rozpoznanie trasy należy
do granicy API, a nie do czystego helpera aplikacyjnego.

Dla sceny bez zadeklarowanego profilu adapter używa kanonicznego, pustego
`ExecutionProfileIR::default()` (`exec:default@1`). Wybory autora trafiają do
jawnej warstwy `Study` lub `Script`, łącznie z `auto` i pełnym
`ComputeResourcesIR`. Profil nie może ukrywać domyślnego CPU ani nadpisywać
zasobów. API jawnie publikuje lub odczytuje niezmienny profil w katalogu;
niezgodny istniejący hash lub konflikt rewizji kończy admission. Efektywna
kopia sceny użyta do materializacji nie zmienia po cichu sceny autora.

Helper migracyjny nie czyta hosta, nie zapisuje storage i nie tworzy UUID GPU.
Starszy ordinal nie staje się tożsamością fizycznego urządzenia: pojedynczy
ordinal 0 oznacza wyłącznie dopuszczalny indeks po ograniczeniu widoczności
przez przydział hosta. Żądanie wielu GPU lub innego ordinału jest odrzucane.
`MeshBuild` i `FdmGridRefresh` pozostają przygotowaniem modelu, bez Solve;
Run/Relax wymagają osobnego accepted admission oraz publikacji do istniejącego
live read model. Sam helper migracyjny nie potwierdza wykonania tych etapów.

## Przygotowanie bez automatycznego Solve

Oczekiwanie interaktywnego skryptu jest trwałą polityką accepted run, a nie
pominięciem pojedynczego wywołania kolejki. Scheduler może sam kolejkować
zadania po opublikowaniu preparation receipt, dlatego `wait_for_solve` zapisuje
w immutable RunSpec.parameters zarezerwowany klucz
`fullmag.accepted_run_start` z `schema_version=accepted_run_start_policy.v1`
i `mode=manual`. Brak tego klucza zachowuje dotychczasowy start automatyczny.
Niepoprawny zadeklarowany kontrakt jest odrzucany bez automatycznego fallbacku.

Native FEM preparation i publikacja siatki mogą zakończyć się przed Compute.
Scheduler compute, bezpośrednie kolejkowanie i obie granice admission sprawdzają
start gate przed claim/allocation. Dopiero jawne Compute po sprawdzeniu
session/epoch/revision publikuje immutable `start_release.json`, związany
z run ID, dokładnym SHA-256 specyfikacji i identyfikatorem żądania. Zapis jest
chroniony writer lease; replay zwraca pierwotny grant bez zastępowania autora
lub czasu. Brak grantu po restarcie nadal oznacza oczekiwanie. Nie jest to
implementacja Pause ani cofanie już uruchomionego Solve.

Odtworzenie istniejącego claimu `Preparing` sprawdza ten sam exact release
zarówno w scheduler recovery, jak i w procesie accepted worker przed odczytem
stanu Study i efektem solvera. Sam utrwalony claim lub wcześniejszy admission
nie zastępuje jawnego grantu Compute. Regresje obejmują przygotowany FDM task,
niezależność przygotowania FDM/FEM oraz odtworzony claim bez grantu.

Ten kontrakt nie dodaje browser endpointu ani drugiego modelu viewportu.
Wdrożenie policy/release w adapterze live i dowód `wait_for_solve` w przeglądarce
pozostają oddzielnymi bramkami od samego modułu persistence.

## Granica aktualnej implementacji UI

Kod trasy Docker kieruje komendy przygotowania i Compute przez
`live_accepted_execution`, zamiast wymagać konsumenta starszej kolejki live.
Journal komendy jest rezerwowany przed długim przygotowaniem; publikacja wyniku
ponownie sprawdza exact run/session context. Compute materializuje kanoniczny
accepted Study, a Stop korzysta z durable accepted control. Pause pozostaje
odrzucone do czasu implementacji jawnego protokołu workera.

Wewnętrzny startup API przyjmuje cały authored Study i przygotowuje aktywny
model. `wait_for_solve` zachowuje opisany wyżej trwały start gate. Projector
udostępnia przygotowaną geometrię i zaakceptowany stan przez istniejący live
read model; nie tworzy drugiego viewportu. Te ścieżki są zaimplementowane
źródłowo, lecz końcowa kwalifikacja formularz → GPU → widoczny wynik oraz
skrypt → aktywny model → Solve nadal ma status **NOT VERIFIED**. Działający
frontend lub build obrazu nie dowodzą wykonania tych bramek.

## Trwałe przygotowanie kolejnych etapów Study

Jeden accepted run może zmieniać geometrię pomiędzy etapami. Niezmienny
run-level preparation receipt pozostaje kotwicą pierwszej publikacji; nie
zastępujemy go receipt kolejnego etapu. Oddzielne append-only stage receipts
w `accepted_stage_preparation_receipts/<task_id>.json` wiążą run, Study step,
deterministyczny task, input fingerprint, preparation ID, plan fingerprint
oraz digest niezmiennego payloadu task preparation receipt.

Przed publikacją pola projector odczytuje przygotowanie dokładnego etapu.
Stan musi pasować do tego samego run/stage i preparation domain; FEM sprawdza
także rząd elementu, liczbę węzłów i fingerprint topologii. Zgodna liczba
węzłów sama nie wystarcza. Błąd powiązania usuwa stare pole magnetyzacji
z bieżącego read model zamiast nakładać je na inną siatkę.

Po restarcie wybór etapu wymaga ponownego odczytu i rewalidacji trwałego stage
receipt względem exact task receipt, katalogu i intentu. Stage receipt nie
przyznaje uprawnień wykonania, schedulera, zasobów hosta ani solvera.
Brakujące, sprzeczne, nieaktualne, podlinkowane, nieregularne lub zbyt duże
rekordy zamykają publikację. Reachability sprawdza powiązanie tych rekordów;
rollback zachowuje je wraz z task receipts.

Accepted anchor, catalog, intent, task i stage należą do skonfigurowanego
accepted store. Legacy MeshBuild i command journal zachowują odrębny live
store. Przeniesienie samego wskaźnika do pamięci lub zapis accepted receipt
w live store nie zastępuje tego powiązania. Regresje muszą używać różnych
fizycznych rootów obu store.

## Provenance accepted run w archiwum FMS

Eksport live snapshotu nie może utożsamiać lokalnego session run ID z accepted
run ID ani kopiować autorytatywnego drzewa accepted run do live runtime store.
Archiwum z accepted wynikami otrzymuje osobne evidence-only closure: exact
intent/catalog/task/stage, manifesty wyników i zweryfikowane referencje CAS.
Claims, leases, coordinator journals, inboxy i stan procesów nie należą do
tego closure. Nie tworzymy drugiego katalogu SolutionSet ani formatu fizyki.

Dotychczasowy manifest fullmag.session.v1 pozostaje bez zmian. Archiwum
z accepted closure wymaga jawnego fullmag.session.v2 i typed referencji
manifest/accepted_provenance.json. Import odkłada dowody pod własnym stagingiem
imports, bez zapisu do accepted store i bez uprawnień Resume lub recovery.
Historyczny binding źródłowego store nie staje się bindingiem nowego hosta.
Brak zgodnego closure dla zadeklarowanego accepted context blokuje publikację
archiwum. Zgodność v1, cross-store export/import, tampering i odrzucenie
authority records wymagają regresji oraz rzeczywistego Windows save/reopen.
Implementacja i kwalifikacja tej części FMS pozostają **NOT VERIFIED**.

## Kontrakty i konsumenci

Zmiana korzysta z istniejących typed study outputs, accepted-state reference,
resource pools, compute profiles i wspólnego runtime status. Nie dodaje
oddzielnego endpointu FEM GPU, transportu komponentowego ani drugiego viewportu.
OpenAPI i wygenerowane klienty zmieniają się tylko w razie rzeczywistej zmiany
publicznego schematu; sam nowy producer nie uzasadnia ich ręcznej edycji.
FDM GPU korzysta z istniejącego workera i tego samego host allocation boundary;
jego pełna ścieżka formularz → GPU → wynik wymaga osobnego dowodu.

Właściciele implementacji:

- `accepted_fem_study_worker` — przygotowanie i wykonanie accepted FEM;
- `accepted_fem_gpu_state::FemGpuAcceptedStateSnapshotV1` — identity/recovery;
- `FemGpuExecutionReceipt::validate_strict_device` — istniejące native reguły;
- runtime service, compute-node probe i host ledger — admission i lifecycle;
- launcher Docker, wersjonowane Compose i resolver — mounty i provenance.

## Migracja i rollback

ADR 0045 nadal określa CPU. Ten ADR rozszerza wyłącznie accepted GPU i host
execution scope, którego ADR 0059 nie kwalifikował. Profil CPU v1 pozostaje
kompatybilny; jawny profil hosta v2 wymaga nowych bramek. Nie przejmujemy
istniejącego ownera, częściowego ledgeru ani sesji o innej konfiguracji.
Rollback zamyka admission nowego profilu i zachowuje backing, sesje, logi oraz
receipty. Nie zastępuje GPU ofertą CPU i nie restartuje działającej symulacji.

## Weryfikacja

Wymagane są regresje request/lease/auto, UUID i launch binding, niepełnych lub
hybrydowych native receipts, strict `native_cuda_pgbb` provenance,
topology/freshness, recovery oraz zgodności CPU.
Kompilacja unit tests odbywa się wyłącznie w CI tego zadania, zgodnie z wyjątkiem
użytkownika. Do odbioru potrzebny jest końcowy managed build frontendu i backendu,
realne zadanie FEM GPU przez API, FDM GPU z formularza, terminal release,
browser/HMR/WebGL oraz FMS save/reopen/restart z odczytem plików Windows.
Source checks, wykrycie GPU ani build obrazu nie zastępują tych dowodów.
