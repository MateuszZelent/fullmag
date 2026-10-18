# Docker Windows — FEM GPU w Workspace/API

Data: 15.10.2026. Status: W TRAKCIE / runtime NOT VERIFIED.

## Cel i decyzje użytkownika

Dokończyć dwa kontenery developerskie: frontend HMR z głównego checkoutu lub
zarejestrowanego worktree oraz backend budowany na żądanie. Sesje i wyniki
pozostają bezpośrednio w rzeczywistym storage Windows. Tylko frontend publikuje
port hosta; backend komunikuje się po prywatnej sieci Compose. Użytkownik
rozszerzył zakres o rzeczywiste FEM GPU w Workspace/API, obok istniejącego CLI.

Zachowujemy jeden Python DSL, ProblemIR, planner, API v2 i workspace. Nie
zmieniamy fizyki ani natywnych operatorów: obowiązują noty 0410 i 0960, backend
golden masterplan oraz aktualne ograniczenia capability matrix. Pierwszy
accepted producer GPU respektuje ograniczenia H1/P1, double, strict i
final_state/total_energy istniejącego adaptera; unsupported workloads pozostają
jawnie odrzucone. Jawne GPU nie może wykonać CPU. Requested auto pozostaje
zapisane, a resolved device wynika z legalnego planu i faktycznie przydzielonego
zasobu. CPU zachowuje własny istniejący kontrakt i recovery.

## Etapy i kryteria odbioru

1. Naprawić prywatnego wykonawcę CI: pinned Buildx, kontrola przed JIT i
   rzeczywisty reproducer COPY --chmod. Następnie wykonać niezmienioną
   managed FEM qualification z CUDA 12.6.3 i fizycznym NVIDIA GPU. Zachować
   pobrane warstwy, compiler cache, backing ext4 i logi nieudanych prób.
2. Po przeglądzie kontraktów zapisać ADR 0060 dla accepted FEM GPU. Powiązać
   pojedyncze fizyczne GPU i rzeczywisty VRAM z ofertą, lease, host ledger,
   workerem i execution identity. Nie publikować zasobów wymyślonych ani
   podwójnie wydawać tego samego CPU/RAM/GPU. Runtime service pozostaje
   właścicielem lifecycle i publikacji zasobów.
3. Rozszerzyć accepted FEM adapter i snapshot/recovery: immutable request,
   preparation i plan, preflight przed started receipt, natywny GPU runner,
   rzeczywisty native execution receipt, osobna tożsamość GPU state i ten sam
   wspólny Start/heartbeat/Stop/completion protocol. CPU snapshot v1 oraz
   publiczne kodeki zachowują kompatybilność. Nie konstruować GPU evidence z
   samego planu, CUDA visibility lub nazwy silnika.
4. Sprawdzić capability/transport i konsumentów. Wykorzystać istniejące zasoby
   v2 i typed outputs; zmieniać OpenAPI oraz generowane typy tylko przy
   rzeczywistej zmianie schematu. W jednym workspace wykazać GPU allocation,
   accepted run, końcowe native provenance i odczyt opublikowanego wyniku.
5. Zbudować pełny backend i frontend bezpośrednio we własnych usługach Compose,
   bez starej kolejki runnera (decyzja użytkownika 16.10.2026). Uruchomić oba kontenery, wykazać HMR po zapisie pliku
   Windows, poprawny WebGL, połączenie API, GPU execution oraz zachowanie
   zapisanego FMS i jego hashy po normalnym stop/start. Wymagane CI/review,
   commit/push/PR/merge, bezpieczny fast-forward głównego checkoutu i qualified
   cleanup własnego worktree kończą cykl.

## Uruchomienie skryptu w Dockerze — doprecyzowanie użytkownika

Polecenie wskazujące skrypt ma zachować istniejący kontrakt Fullmaga:
Workspace od razu przedstawia załadowany, aktywny model. Przygotowanie modelu
oraz siatki poprzedza Solve. Symulacja uruchamia się automatycznie według
skryptu, chyba że interaktywny skrypt ma `wait_for_solve=True`; wówczas
przygotowany model czeka na Compute. Nie wolno bezwarunkowo wymuszać headless,
zmieniać authored auto na CPU ani omijać wspólnego ledgeru GPU.

Launcher ma tłumaczyć ścieżkę Windows względem wybranego readonly checkoutu.
`docker compose run fullmag <ścieżka>` nie jest obecnie działającym
interfejsem: usługi aplikacji to frontend/backend, a ich entrypoint uruchamia
Workspace. Implementacja i dowód startupu skryptowego są osobnym wymaganym
etapem. Skrypt `tests/vlad/4.5GHz_fem.py` zawiera `device=auto`, wiele etapów
BB/PG-BB i długą symulację anteny; prosty bounded LLG proof nie kwalifikuje
jego całej sekwencji.

## Weryfikacja i granice

Lokalnie nie kompilujemy testów jednostkowych. Wyjątek użytkownika obejmuje
wyłącznie CI tego zadania. Regresje obejmą niewłaściwy lease/GPU binding,
CPU fallback, brak lub mismatch native receipt, zachowanie requested auto,
CPU compatibility oraz recovery bez ponownego solver side effect. Interpretowane
kontrole Python, parsery, formatowanie i przegląd nie zastępują wykonania GPU.
Managed runtime i browser proof są osobnymi bramkami. Udane wykonanie bounded
workload nie jest ogólną kwalifikacją fizyki FEM GPU.

Historyczne blokery przed rozpoczęciem tego rozszerzenia: bootstrap CI ma jeden
nieudany test batcha (1101 PASS), a tymczasowy runner nie zawierał Buildx.
Diagnoza i naprawa tych przyczyn są częścią tego samego zadania. Cudzy dirty
master, procesy, cache i wyniki pozostają zachowane.


## Stan bramek i dowody odbioru

| Obszar | Obecny dowód | Wymagane do odbioru |
| --- | --- | --- |
| Konfigurator nowego hosta | PR #174 scalony do mastera `f9179caf`; skrypt istnieje lokalnie i na GitHub | Pełny bootstrap toolchaina/runnera na czystym hoście pozostaje osobnym etapem |
| Compose i storage | Wersjonowane definicje, kontrole parsera, host ledger i regresje interpretowane | Realny start dwóch usług, odczyt plików Windows i restart |
| Toolchain FEM/CUDA | Prywatny run 38755955047: MFEM CPU i manifest DONE; budowanie warstwy developerskiej Python | Udana managed FEM qualification na poprawionym obrazie |
| Zgodność źródeł i CI | CI e17d56f: build Control Room i dispersion PASS; d2aaac87e: dedykowany krok Compute/recovery PASS | Wymagane kontrole dla końcowego commita |
| Polecenia live CPU/auto/GPU | Adapter accepted, czysta migracja legacy i Stop z aktualną rewizją katalogu; source review po poprawkach | Kompilacja w CI, admission, lifecycle i wynik w tym samym Workspace |
| FEM przygotowanie / wait_for_solve | Pinned preparation publikuje typed mesh, materiały i initial m; polling zwalnia transition dla Stop | Widoczny aktywny model i siatka przed Compute, bez solver side effect |
| Uruchomienie skryptu | Launcher 8e41f9d92: 12 testów startup PASS Linux/Windows, runtime 30 PASS/3 SKIP Linux i 27 PASS/6 SKIP Windows | Internal startup API zachowuje całe Study i manualny gate; końcowa kompilacja/runtime auto-run oraz wait_for_solve wymagane |
| Frontend HMR i WebGL | Definicja source bind i przygotowane procedury dowodowe | Zapis pliku w Windows widoczny w przeglądarce, zachowanie stanu i żywy WebGL |
| FDM/FEM GPU | Source admission, worker i receipt nie stanowią runtime proof | Formularz → fizyczny GPU → terminalny wynik, native receipt i zwolnienie lease |
| Integracja | Pozostałe zmiany w PR #175, master zachowany z cudzym dirty submodule | Review/CI, merge, lokalny fast-forward i qualified cleanup |

Aktualizując tę tabelę, zachowujemy rozdział konfiguracji, kompilacji, runtime,
przeglądarki i walidacji naukowej. Stan jednej bramki nie promuje pozostałych.

## Bieżący fragment integracji API

Adapter live publikuje RunIntent przed wykonaniem przez istniejące accepted
workers. Projector odczytuje zwalidowane manifesty i CAS, zachowuje binding
API/session/epoch/scene/run i jawny manualny gate. Przygotowanie publikuje
pinned plan przez istniejące zasoby domeny oraz materiałów; początkowe `m`
jest wejściem planu, bez sfabrykowanych scalar rows lub zdarzeń solvera.
Stop i zmiana sesji mogą uzyskać transition pomiędzy próbami odczytu receiptu.

W CI dodano osobny krok czterech modułów kontraktowych Docker/API. Lokalnie
wykonano tylko parser Rust i YAML oraz kontrolę diffu. Kompilacja i runtime
tego fragmentu pozostają NOT VERIFIED do wyniku CI i kolejnego managed builda.
Obecny accepted scalar artifact `E_total` aktualizuje terminalne podsumowanie
run; nie stanowi pełnej historii `ScalarRow`. Publikacja historii i zgodność
natywnego indeksowania FEM wymagają osobnej weryfikacji przed odbiorem całości.

Trwały receipt przygotowania jest zatwierdzany przed publikacją read modelu.
Jeżeli publikacja się nie powiedzie, receipt i jego exact immutable identity
pozostają podstawą retry/replay; nie cofamy durable preparation ani nie
uruchamiamy drugiego solvera. Brak zgodnego read modelu nadal blokuje zwolnienie
manualnego gate przez startup.

Pole początkowe obejmuje pojedynczy FDM, FEM oraz FDM multilayer. Multilayer
używa kanonicznego layoutu runnera: niezależnych native grids i offsetów
wartości. Bieżący pinned plan zastępuje wcześniejszy artifact_layout nawet
wtedy, gdy poprzedni layout również należał do multilayer. Regresja obejmuje
dwie różne siatki warstw i stary błędny offset; parser Rust przechodzi.
Kompilacja regresji w CI i runtime pozostają NOT VERIFIED.
Przełączenie metadata FEM → fdm_multilayer czyści poprzednią typed siatkę FEM.

Review projectora wykrył jeszcze brak jawnego bindingu późniejszego stanu do
stage-specific domeny przy zmianie geometrii między krokami Study. Zgodna
liczba węzłów nie dowodzi zgodnej topologii. Przed odbiorem wymagane są
publikacja pinned preparation właściwego etapu i regresja dwóch topologii
o tej samej liczbie węzłów. Ten checkpoint służy kompilacji CI, nie jest
kwalifikacją poprawnego wykonania całego Study ani zgodą na merge.

CI checkpointu `916e2c3d8` wykrył osiem błędów kompilacji nowej ścieżki API.
Commit `a3154eadc` poprawia ownership Arc pod transition guard, typ wyniku
mutacji journalu oraz pełny ExecutionProfileIR zamiast referencji. Lookup
katalogu sprawdza również hash i treść authored profilu. Cztery regresje
journalu mają jawne selektory CI. Bootstrap run `38786312168` jest w toku;
wynik parsera nie zastępuje jego kompilacji.

## Korekta cache i gotowości po rzeczywistym starcie Windows

Dowód z kontenera diagnostycznego: instalacja pnpm zakończyła się po 28 min
13 s. Kontrolowany restart zachował node_modules i pominął install; probe pnpm
zajął 0,439 s. Poprawka 67f4e5f24 naprawia require.resolve z wygenerowanego
cache i publikuje postęp do Docker stdout. Sam Workspace nadal nie załadował
się nawet w 600-sekundowej próbie. Profil Next zawiera 9765/10521 próbek idle;
worker threads czekają w p9_client_rpc/d_alloc_parallel. Nie ma dowodu OOM
ani CPU throttlingu. Surowy odczyt pliku 1 MiB trwa 26 ms, więc rozdzielamy
koszt metadata od przepustowości. Dotychczasowy healthcheck HEAD / akceptował
redirect, a nie gotowy Workspace; poprawka wymaga 2xx z HEAD /workspace.

Launcher tworzy nowy state root z UUID dla każdego pełnego startu. Obecny
cache przeżywa restart tego samego kontenera, lecz nie jest ponownie używany
przez taki nowy launch. Nie wolno przedstawiać tego jako pełnego trwałego
cache developerskiego.

Decyzja implementacyjna: zależności i cache Next mają korzystać z osobnego
zarządzanego ext4 backing pod kanonicznym storage/build-volumes, z jawnym
profilem frontend-cache-v1 i attestation rzeczywistego mountu. Źródła pozostają
readonly bindem checkoutu Windows; sesje, wyniki, logi i receipty pozostają
bezpośrednio w storage Windows. Nie używamy ukrytego named volume ani ledgeru
hosta jako cache frontendu. Docelowy backing 8 GiB jest zasobem cache;
nie usuwamy starego cache jako skutku wdrożenia.

1. Dodać osobny adapter/maintenance Compose/helper, korzystając z wzorców
   docker_host_ledger: exact project/layout/engine/image identity, regular
   backing, ext4 UUID, kontrolowany loop/mount i ograniczone katalogi cache.
   Nie zmieniać profilu host ledger ani nie udostępniać go frontendowi.
2. Ustalić stabilny cache key z worktree/source identity, host portu i digestu
   zamrożonych dependency inputs. Odmówić użycia cache podłączonego do innego
   aktywnego procesu/kontenera. Nowy launch z tym samym kluczem ma odzyskać
   dependencies; zmiana zależności wybiera nowy klucz zamiast nadpisywania
   aktywnego środowiska.
3. Compose montuje jawnie native cache, pnpm-store oraz oba realne importer
   node_modules pod obecnymi guest paths; seeder i receipts pozostają Windows.
   Launcher wiąże cache receipt z input manifest i sprawdza mounty po starcie.
4. Regresje interpretowane: layout i traversal/symlink rejection, attestation,
   konflikt aktywnego cache, zgodność Compose/input manifest oraz reuse nowego
   run UUID. Testy nie kompilują unit tests. Weryfikacja runtime wymaga
   prawdziwego ext4 mountu i faktycznej odpowiedzi Workspace.
5. Po review/commicie wykonać kontrolowany restart własnego diagnostycznego
   frontendu z zachowaniem starego cache/logów. Potwierdzić Windows source
   mount, widoczną stronę, HMR A→B→C z zachowaniem stanu oraz brak restartu
   procesu. Zmierzyć drugi launch używający tego samego cache. Te dowody nie
   zastępują końcowego startu dwóch usług ani GPU/FMS qualification.

## Checkpoint 16.10.2026 — frontend nadal bez kwalifikacji

Adapter frontend-cache-v1 jest wdrożony w commitach 2cd5739579 i 71fbad8a6e.
Rzeczywisty mount ext4 UUID `8f88ffb4-51eb-4785-8670-eab20953cb35`
został potwierdzony w Docker Desktop i kontenerze. Zimna instalacja zależności
trwała 160,141 s, a Next zgłosił ready po 0,428 s. Źródła aplikacji pozostały
readonly bindami Windows; Windows zachował sesje, wyniki, logi i receipty.

Próba przeglądarki zwróciła HTTP 200 i tytuł Workspace, ale widoczny był tylko
`Checking for sessions`. To nie dowodzi działania Home ani aktywnego Workspace.
Kontener diagnostyczny nie miał backendu. Został normalnie zatrzymany, ponieważ
blokował admission kolejki. Potwierdzony przez użytkownika adres to
`http://127.0.0.1:32871/workspace`; po zatrzymaniu port nie nasłuchiwał.
Wynik HMR A→B→C, zachowanie stanu, WebGL i pełna aplikacja pozostają NOT VERIFIED.
Eksperyment piątego bindu parent workspace nie dał dowodu poprawy; produkcyjny
Compose nadal montuje cztery katalogi cache. Nie usunięto starych danych.

Job `11e18560e1f74022871a1bff39d7cf4b` uruchomił się na starym przypiętym
obrazie e5f70bd63201, bez wymaganego `dependency-versions.json`. Został jawnie
anulowany: terminal `cancelled`, exit 143, bez pakietu aplikacji. Profil
fem-gpu-release przypięto do istniejącego obrazu
`sha256:f9e5a4fe2393dfd6c84af9a6518cfc23a772b0bd7b7fcb427c8004286c446d85`,
zachowując 8 CPU i 24 GiB. Faktyczny manifest tego obrazu podaje CUDA 12.4.1,
MFEM 4.10, HYPRE 3.1.0, libCEED 0.12.0, PETSc 3.24.6 i SLEPc 3.24.3 oraz
commity wszystkich pięciu bibliotek. To odczyt z obrazu, nie założenie z tagu.

Nowy job `6395e30ff26740dda1bf45922872d837` buduje ten sam commit
`2cd573957926e7f1d9c2cc81c9a33aabd6cd879f` i digest kapsuły
`b4b3a183b075b6812ce349baf8d5f4926b9e56d89ea78e2e05afdb88ac4116cb`.
Kapsuła została ponownie zweryfikowana natywnie; kanoniczne POST /jobs dostało
nowy request_key i niezmieniony payload capture. Osobny receipt resubmission
zachowuje przyczynę retry. Nie modyfikowano SQLite ani nie naprawiano kapsuły.

Commit `1678b4875b12ee94833e635b85e424e93c1d99d6` dodaje kontrolę manifestu
przed capture i zgłoszeniem kolejnego buildu. Interpretowane regresje:
36 uruchomionych, 3 pominięte, exit 0. Rzeczywisty smoke odrzuca stary obraz
i przyjmuje właściwy. Nie kompilowano lokalnie testów jednostkowych.

Kolejny dowód musi obejmować oba kontenery: gotowe API, odpowiedź pustej listy
sesji, widoczny Home z wyborem symulacji i brak `session-loading`. Dopiero
potem aktywny Workspace/WebGL, HMR oraz GPU Compute i zapis/reopen FMS.
Wykryty niezależny błąd ukrywania błędu current/status jako wiecznego loading
jest poprawiany w zasobach UI; nie zastępuje to faktycznego podłączenia API.

## Doprecyzowanie 16.10.2026 — bezpośredni tryb Compose

Kontrakt: [architektura developerska](../../guides/docker-development-architecture.md).
Backend obejmuje wszystkie cztery realizacje FDM/FEM CPU/GPU. Frontend ma HMR
z zamontowanego checkoutu; backend jawny build przyrostowy w swoim kontenerze.
Poprzednia zależność od pakietu z kolejki nie obowiązuje w tej ścieżce.
Dwa działające serwisy i rzeczywisty Home/API pozostają NOT VERIFIED.

Bieżący stan bezpośredniej trasy: stary job `6395e30ff26740dda1bf45922872d837`
jest terminalny (`failed`, exit 2); nie stanowi zależności nowego buildu.
Obraz helperów oraz bezpośredni builder powstały w Docker Desktop. Rzeczywisty
cache backendu ma ext4 UUID `b61b3161-c4ec-41c9-996e-13e6780d4444` i przeszedł
ponowne verify. Windows/9p zaalokował fizyczne 12 GiB; opis „sparse” nie jest
potwierdzony. Nowy backing wymaga sprawdzenia miejsca przed utworzeniem.
Próba snapshotu `cefde6f0d6404cea8266cfcf2f5ba320` zakończyła się przed
kompilacją, ponieważ agenci edytowali launcher podczas capture. Kolejny build
musi wystartować po zapisaniu i zamrożeniu spójnego etapu źródeł.
