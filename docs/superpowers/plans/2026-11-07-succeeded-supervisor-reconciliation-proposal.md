# Rozliczenie udanego GSG przez istniejącego nadzorcę i aktualizacja grupy 3203

Status: konkretny zakres do zatwierdzenia; nadzorca nie został wywołany,
rezerwacja nie została zmieniona, build i restart nie zostały uruchomione.
Nie proponujemy nowego formatu recovery ani zmiany jego dotychczasowych odmów.

## Co zmienia ten przegląd

[Poprzedni audyt](2026-11-07-corner25-runtime-upgrade-audit.md) dotyczył ścieżek
recovery wymagających terminalnego właściciela. Dalszy przegląd ujawnił osobne,
już wdrożone wejście fullmag-api-accepted-supervisor. Może ono rozliczyć
autentyczny exit receipt przed próbą uruchomienia workera. Zwolnienie hosta
pozostaje zadaniem działającego, host-aware schedulera.

To istniejąca ścieżka zgodna z kontraktem, jeszcze niewykonana dla bieżącego
przypadku. Nie deklarujemy pozytywnego wyniku native ani testu E2E tego host-bound
przypadku. Nie wysyłamy SIGTERM do właściciela, aby wymusić Unknown.

## Dokładny zakres operacji

1. Powtórzyć odczytowe sprawdzenie grupy, pakietu, krytycznej historii i
   nieobecności workera. Przerwać, jeśli piny lub stan są inne.
2. Zachować command/stdout/stderr, PID/start token uruchomionego nadzorcy i
   trwały znacznik jednego wywołania w prywatnym control volume. Nie powtarzać
   komendy po utracie odpowiedzi; odczytać jej rzeczywisty stan i zapisane wyniki.
3. Wywołać istniejący, opublikowany fullmag-api-accepted-supervisor dokładnie
   raz w obecnym backendzie, dla run/task poniżej, z max_automatic_retries=0.
   Nie wykonywać zapisu lease ani ledgeru z Pythona.
4. Odebrać recovered_terminal_completion=true, retry_scheduled=false i
   zwolnienie dokładnie wskazanego lokalnego lease. Działający scheduler ma
   zwolnić host reservation przez zwykłe reconcile_released_store_reservations,
   z trwałym proof. Jeżeli tego nie potwierdzi, nie uruchamiać buildu.
5. Potwierdzić brak nowego worker launch i niezmienność naukowych artefaktów,
   dziennika, inboxu oraz tożsamości udanego zadania.
6. Dopiero po Released po obu stronach i ponownej kontroli braku obliczeń,
   wykonać zwykłą aktualizację przez istniejące just docker-dev-restart-idle
   w tej samej grupie, z zachowaniem cache i danych. Ta recepta kontrolowanie
   zatrzymuje i uruchamia obecne usługi oraz buduje spójny pakiet we właściwym
   stałym backendzie. Nie jest poleceniem build-only; UI/API będą czasowo
   niedostępne. Nie używać backend-build, dawnego runnera ani hostowego Cargo.
7. Odebrać managed receipt, nową tożsamość API/CLI, poprawny odczyt zachowanego
   wyniku i widoczny frontend. Nie uznawać samego Running za gotowość.

Zakres nie obejmuje ponownego Prepare, nowego meshowania, Submit/Solve,
H-only, LLG, zmiany limitów, usuwania kontenerów/wolumenów ani czyszczenia
cache. Odmowa nadzorcy kończy to jedno wywołanie; nie przechodzimy do wersji
bez bindingu, nie zmieniamy identity ani historii, nie ponawiamy automatycznie.

## Przypięcie istniejącej instancji

| Pole | Wartość |
|---|---|
| Worktree | /home/kking/git/fullmag/worktrees/antenna-transport-e2e-20261011 |
| Compose | fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1 |
| Development attempt | 894d4efb43eb483eb6179d8d49fd449e |
| Config SHA256 | 1c0a74f52438f272836dd5c248dd06559cf19774c2c92b8394efd23a4ec10bd4 |
| Backend | 05de79a8e6d4f33d1c7b8b201c69cc9813fa3beec0ccbe9d99013941de301ced |
| Frontend | 271d8c4d455871a1b7b4b2fc34c55b9a122a3df305e0cd0c3382f072ac6779c4 |
| Nadzorca SHA256 | 12f30b30209cac3586d296f35112344b0c1568550196b40b851bfd473dd82dfb |
| Package receipt SHA256 | f0040181bfe0ae904afdfad724736f79ea153beaca8b2ca59ce9714b9fda8a36 |
| Provenance SHA256 | b61a215d2755fde723c3c065afa12850627ccce2d0bf69d31184572fa4a20f82 |
| Manifest źródeł SHA256 | 86b26492706e10194b28b1d123fe6578ed4b55ff7b4bfe8d7924f4fde2ce8643 |

Run: run-40c6990b8231f8fd7194d8b634e780aab9af3a559dbd21b27f8b7bcb8425be5e.
Task: task-902544fbad21c9da53757ca22786517f6866733c15a4e24dd380524b0c4cd859.
Attempt: attempt-b7eaad04933643379cd377462f2899b6, ownership_epoch=1.
Lease: lease-59f9d3a7b6384d23887e3ed3eec88664, heartbeat=222.
Resource: docker-all.compute.cpu. Obecnie local=Active, host=Quarantined.
Istniejący exit receipt ma exit_code=0 i status_success=true. PID workera
jest nieobecny; katalog supervisor-slots jest pusty.

Pełna tablica argumentów, źródła, piny dokumentów oraz PID/start time
działających usług są w prywatnym control volume grupy:
verification/gsg-corner-refinement-20261107/runtime-upgrade-audit-v1/standalone-supervisor-proposal-v1/.

operator-request.json ma SHA256
235f61780eb29608194bc944510af9331f14ae48d476b995244d71f1ea66e636.
To opis propozycji, nie nowy format autoryzacji native ani receipt wykonania.
Stan not-executed-awaiting-authorization oznacza brak uruchomienia.

Nadzorca dostanie istniejący store_root, powyższe run_id/task_id i prawdziwy
sibling worker executable; max_concurrency=1, worker_timeout_seconds=60,
heartbeat_interval_milliseconds=1000, max_automatic_retries=0.
Nie podstawiamy atrapy workera. Te parametry nie uruchamiają fizyki:
udana rekoncyliacja wraca przed spawn, a host-bound lease bez host context
ma osobną bramkę odmowy przed spawn, gdy rekoncyliacja nie zwróci wyniku.

Po Released wejście aktualizacji:
just docker-dev-restart-idle 894d4efb43eb483eb6179d8d49fd449e
1c0a74f52438f272836dd5c248dd06559cf19774c2c92b8394efd23a4ec10bd4
/home/kking/git/fullmag/worktrees/antenna-transport-e2e-20261011 3203 false.
To jedna linia argumentów istniejącej recepty; nie wykonywać jej przed
zgodą i potwierdzeniem zwolnienia zasobów.

## Dowód ze źródeł wdrożonego pakietu

Manifest capture /build/.fullmag-live-source/manifest.json potwierdził zgodność
source_snapshot_sha256 z pakietem i provenance. Hash faktycznego binarium
nadzorcy jest zgodny jednocześnie z artifacts i binary_hashes. Pliki poniżej
odczytano z /build/workspace, a nie tylko z nowszego worktree.

| Plik | SHA256 |
|---|---|
| accepted_supervisor_main.rs | d632a5d51d0d7e9297647ecb4b62e21c97fba6f8f627e0a89466ce92b413b286 |
| accepted_study_supervisor.rs | 498aa8a2c4f85b4b3a23b5f378f07e4ae3ed795abaacd7103296e7791310bf8b |
| accepted_scheduler_main.rs | 359a1f3b8f6b34dc406d81ba915985acef694bfcf83b3de7738cdcac319e7c8d |
| host_runtime.rs | aeea52a824c1723fd6c9fe7d8792903371cfe272fe6792180cb5499a39fa5b01 |
| docker_desktop_storage.rs | 07f6e9286214667c883562c7178507d683321bdb05120780fc59196b176a65a8 |

Pierwsze trzy pliki są w crates/fullmag-api/src; host_runtime.rs w
crates/fullmag-runtime-control/src, a docker_desktop_storage.rs w
crates/fullmag-session/src.

accepted_supervisor_main::run używa wspólnego nadzorcy z host=None.
accepted_study_supervisor::reconcile_durable_worker_exit_before_spawn
przechodzi do reconcile_worker_exit. Ten wymaga zgodnego claim/lease/receipt,
końcowego heartbeat, dokładnie jednego Start, trwałego Succeeded, kompletnego
wyniku i zastosowanego Start. Dopiero potem release_resource_lease zwalnia
ten lokalny przydział. SupervisorSlot::acquire wyklucza równoległego nadzorcę.

Brak pomyślnego rozliczenia nie otwiera spawnu: wdrożona bramka dla
host_launch_binding przy host=None odmawia przed uruchomieniem procesu.
Nadzorca nie zwalnia host capacity. accepted_scheduler_main w pętli używa
host_runtime::reconcile_released_store_reservations, który pod host→store lock
ponownie sprawdza Released local i odpowiadający exit receipt oraz publikuje
proof. Takie rozdzielenie opisuje compute-resource-execution-v1.md,
sekcje odpowiadające wierszom 1290–1295, 1346–1349 i 1360–1366.

Storage admission sprawdza bieżącą nazwę/hash programu w opublikowanym
binary_hashes; nie jest ograniczone do API i CLI. Używamy opublikowanego
programu, nie niezatwierdzonego kandydata.

Istniejący walidator historii potwierdził 457 dokumentów. Przy przygotowaniu
tej propozycji ponownie sprawdzono wszystkie 455 małych dokumentów tego
dowodu oraz pakiet, source manifest i nieobecność slotu/workera; dwa duże
artefakty pozostają objęte poprzednim pełnym odczytem. Nie przedstawiamy
tego jako ponownego cold-load ani wykonania nadzorcy.

## Ograniczenia, odbiór i decyzja

Niezależny przegląd źródeł potwierdził powyższe rozdzielenie. Nie znaleziono
osobnego dotychczasowego E2E dokładnie dla tego host-bound, udanego zadania;
historyczny exit-recovery E2E ma węższy zakres lokalnego FDM CPU. Obecny
nadzorca nie udostępnia verify-only. Jego wywołanie będzie pierwszą rzeczywistą
weryfikacją tej konkretnej operacji, z własnymi walidacjami native.

Po wykonaniu zapisać exit code, pełne logi, zmiany wyłącznie operacyjnego lease
i proof hosta, brak nowego launch, zgodność artefaktów i dokumentów oraz receipt
zarządzanej aktualizacji. Nie zmieniać Succeeded ani liczyć anteny ponownie.

Potrzebna jest zgoda na dokładnie wskazane rozliczenie lokalne przez istniejący
program oraz następującą po Released zarządzaną aktualizację grupy 3203.
Ostatnia zgoda dopuszczała wyłącznie jedną próbę prepare-only i jawnie
wykluczała build/restart/zmianę rezerwacji. Nie interpretujemy jej jako zgody
na ten nowy zakres. Nie jest potrzebna zmiana wersjonowanego kontraktu,
nowy format recovery, usuwanie danych lub nowa geometria fizyczna.

## Odbiór zatwierdzonego wykonania — 07.11.2026

Użytkownik zatwierdził rozliczenie i zarządzaną aktualizację. Operacja została
wykonana przez istniejącego nadzorcę, bez nowego Solve. Obie rezerwacje są
Released, a aktualizacja 8857232e70bc47aca8dea77ad9da0f86 ma status succeeded.
Scena została odtworzona przez publiczne API; zachowane tensory są zgodne
bajt w bajt. Odbiór wizualny po restarcie nadal oczekuje świeżej karty.
Szczegółowy [raport wykonania](2026-11-07-succeeded-supervisor-reconciliation-execution.md)
zawiera właściwą receptę saved-authoring, receipty, ograniczenia i dowody.
Powyższy opis propozycji zachowuje historyczny stan sprzed wykonania.
