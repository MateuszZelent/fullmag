# Development Fullmaga z danymi builda w Dockerze

Codzienny build używa grupy Compose wybranego checkoutu. Stały `backend`
kompiluje aplikację i uruchamia API oraz runtime; `frontend` obsługuje Next/HMR.
Obrazy zależności i helperów przygotowuje BuildKit w tym samym projekcie.
Nie powstaje trzecia usługa aplikacyjna ani hostowy katalog kompilacji.

## Uruchomienie

Użyj Pythona z Windows PowerShell albo Linux/WSL oraz silnika Docker Linux.
WSL wymaga włączonej integracji dystrybucji w Docker Desktop. Linux/WSL
używa lokalnego ext4/xfs/btrfs i bieżącego endpointu Docker; Windows zachowuje
NTFS/ReFS oraz context `desktop-linux`. Szczegóły:
[konfiguracja Linux/WSL](docker-setup-linux-wsl.md).
Najpierw skonfiguruj `.env` głównego checkoutu przez `scripts/setup_docker.py`.
Worktree korzysta z konfiguracji przez resolver; nie kopiuj do niego `.env`.
Przeczytaj skill `.agents/skills/fullmag-docker-build/SKILL.md`.

```powershell
$source = "<absolutny-zarejestrowany-checkout>"
Set-Location $source
just docker-dev
```

`just docker-dev` sam przygotowuje lub ponownie wykorzystuje zgodny toolchain
i obrazy helperów. Osobne `just docker-dev-toolchain` jest opcjonalne: pozwala
przygotować zależności wcześniej albo diagnozować ten etap bez startu aplikacji.
Nie kompiluje aplikacji; ta buduje się w stałym `backend`.

`just docker-dev` obsługuje również grupę istniejącą dla wybranego checkoutu.
Działający backend z pasującymi wejściami jest używany ponownie. Zmiana źródeł
uruchamia kontrolowany restart bez aktywnych obliczeń; backend sprawdza istniejący
pakiet i wykonuje przyrostowy build tylko wtedy, gdy jego wejścia się zmieniły.
Zatrzymana grupa jest wznawiana z przypiętej konfiguracji. Domyślnie pozostaje
jej zapisany port; jawna zmiana portu wymaga odtworzenia konfiguracji.
Cache i dane użytkownika pozostają zachowane. Nieznany wynik wcześniejszej
aktywacji lub obcy właściciel blokuje automatyczny restart; launcher nie kasuje
blokad i nie powtarza historycznego Solve. Kolejny skrypt jest aktywowany dopiero
w gotowej grupie przez tę samą ścieżkę co `docker-dev-script`.

Kreator zapisuje `FULLMAG_SOURCE_ROOT` i `FULLMAG_HTTP_PORT` do `.env` głównego
checkoutu. Domyślne źródła: jawny argument → zmienna procesu → bieżący worktree
→ `.env` → zapis konfiguratora → główny checkout. Port startu: jawny argument →
zmienna procesu → `.env` → zapis konfiguratora → `3197`. Zajęty port kończy start
błędem. Toolchain, obrazy pomocnicze i aplikacja stosują ten sam wybór źródeł.
Aktywacja kolejnego skryptu odczytuje rzeczywisty port działającej grupy, więc
nie wymaga ponownego podawania wcześniejszego nadpisania portu.

Zakończ edycje przed startem; nie zmieniaj źródeł do zakończenia próby.
Migawka odczytuje checkout dwukrotnie i odrzuca niespójne wejście.

Nowe, jeszcze nieśledzone pliki można jawnie dodać do migawki bez `git add`:

```powershell
python -B scripts/docker_dev.py --repo-root $source up --source-root $source --port 3197 `
  --include-untracked apps/control-room/src/new-module.ts `
  --include-untracked examples/new-fixture.json
```

Każda opcja wskazuje dokładną ścieżkę względną do jednego regularnego pliku,
który w chwili przechwycenia zwraca `git ls-files --others --exclude-standard`.
Dozwolone są powtórzone opcje; globs, katalogi, ścieżki absolutne, traversal,
sekrety i pliki administracyjne są odrzucane. Pozostałe nieśledzone pliki nadal
pozostają wykluczone. Lista z CLI jest zapisywana jako kanoniczne JSON w
środowisku backendu i wchodzi do digestu Compose; zmiana listy istniejącej grupy
przechodzi przez zarządzane odtworzenie z wymaganym bezpiecznym drainem. Brak
opcji przy uzgadnianiu istniejącej grupy zachowuje przypiętą listę; nowa grupa
bez opcji zaczyna z pustą listą. Jeżeli wybrany plik zostanie później dodany do
indeksu Git, capture akceptuje go jako już obecny w `files` i nie dubluje go w
`included_untracked`.
Programowe przekazanie `[]` jawnie czyści listę; hostowa zmienna środowiskowa
`FULLMAG_DEV_INCLUDE_UNTRACKED` nie ustala jej wartości.

Port musi być wolny. Wybierz wolny port, jeśli inna instancja już działa.
`docker-dev-images` przygotowuje wyłącznie obrazy helperów; `docker-dev-build`
ma tę samą semantykę startu usług co `docker-dev`.

Receipt wypisuje projekt, nazwę wolumenu kontrolnego i identyfikator próby.
Konfiguracja JSON jest w `development/attempts/<attempt>/compose.json`,
a wynik w `terminal.json` w tym samym katalogu wolumenu. SHA konfiguracji to
SHA256 kanonicznego JSON (`docker_build_control.canonical`), nie pliku z newline.
Nie kopiuj tych plików do hostowego `storage/builds`.

## Wyniki obok skryptu

Po jawnej zgodzie na zapis wybranego podkatalogu ustaw w `.env` głównego
checkoutu `FULLMAG_SCRIPT_OUTPUT_DIRECTORY=examples` (albo inny istniejący
podkatalog źródeł). Backend dostaje osobny alias tylko tego katalogu.
Może technicznie zmieniać również inne jego pliki. Główny checkout nie może
zostać wybrany jako writable alias. Zmiana grantu wymaga odtworzenia usług;
`docker-dev` wybiera kontrolowaną ścieżkę odtworzenia i zachowuje wolumeny.

Skrypt `examples/model.py` używa domyślnie sąsiedniego `model.zarr`.
HDF5 zachowuje obecny kontener `model.results` z plikami `.h5`.
Jawna OutputStorage jest nadrzędna. Zapis sesji wskazuje `model.fms`,
a kolizja tworzy nową nazwę. Export nadal pobiera archiwum przez przeglądarkę.
Wyniki i sesje nie są danymi buildu. Pliki wynikowe bez wpisu w indeksie Git
nie zmieniają source identity; świadomie śledzone fixtures nadal są sprawdzane.

## Iteracje i awarie

`just docker-dev-restart-idle <attempt> <config-sha256> <source> <port>`
sprawdza dokładny kontener, obraz, polecenie, etykiety i mounty oraz wymaga
zdrowego API bez aktywnej sesji. Na czas kontroli zamyka jedyne wejście HTTP przez zatrzymanie własnego frontendu,
sprawdza prywatną sieć bez obcych konsumentów, restartuje backend i ponownie
uruchamia ten sam frontend. Zachowuje cache oraz storage hosta. Nie jest komendą do przerywania obliczeń. Wymaga wyłącznego okna operatorskiego,
bez równoległych klientów wysyłających polecenia do tej grupy; odczyt health
nie jest dowodem opróżnienia wszystkich kolejek aplikacji.
Wyjątkiem od braku aktywnej sesji jest dokładnie przypięty model nieudanej
aktywacji, którego przyjęte zadanie zostało jawnie anulowane przed rozpoczęciem
przygotowania. Wymagany jest trwały dowód anulowania, brak rezerwacji i bieżącego
runu, pusta kolejka oraz zgodność skryptu i rewizji sceny. Kontrola odbywa się
ponownie po zatrzymaniu frontendu. Po zatrzymaniu backendu launcher weryfikuje
autentykowany drain właściciela runtime przed ponownym startem; nieznany wynik
zatrzymania pozostawia usługi zatrzymane i wymaga odzyskiwania.
Po wcześniejszym odzyskaniu namespace kolejne zwykłe restarty weryfikują
uwierzytelniony drain późniejszego właściciela. Historyczne archiwum recovery
pozostaje niezmienne; nowszy `LAUNCH.json`, generacje pul i checkpointy są
sprawdzane względem tego właściciela i konfiguracji, zamiast porównywania ich
bajtów ze starym archiwum. Istniejące runy i ich historia pozostają zachowane.
Frontend obserwuje katalogi `app`, `src`, `public`, `scripts` i aktualizuje UI
przez HMR. Zmiana helperów obrazu wymaga przygotowania nowego obrazu i jawnego
odtworzenia usług; sam restart zachowuje przypięty obraz.

`docker-dev-resume` wznawia obserwację konkretnego potwierdzonego nieudanego
startu; opcja `restart_backend=true` może uruchomić zachowany zatrzymany backend, również po wcześniej udanym starcie.
`docker-dev-recreate-volume` wymaga zatrzymanego backendu i dokładnych pinów
próby/konfiguracji. Zachowuje wolumeny; opcja `fresh_state=true` tworzy nowy root
sesji, pozostawiając poprzedni. Nie powtarza automatycznie aktywacji Solve.
Oczekująca transakcja recovery zachowuje dokładną pierwotną autoryzację po
ponownej walidacji. Sama publikacja receipt `recovered` nie usuwa uprawnienia
potrzebnego przy pierwszym starcie po recovery. Jeżeli późniejszy właściciel
zakończy start błędem, `docker-dev-stop-failed` zapisuje dowód jego kontrolowanego
zatrzymania. Przy następnym `docker-dev-recreate-volume` launcher sprawdza ten
dowód oraz zakończoną transakcję recovery, pomija jej zużytą autoryzację i
przypina SHA bieżącej konfiguracji odczytanej pod `OWNER.lock`. Nowy start może
zmienić wyłącznie generację przy zachowaniu profilu operatora. Metadane tego
restartu są oddzielone od autoryzacji recovery. Nie powstaje nowy request recovery,
nie zmienia się historia i nie jest ponawiane Solve. Zachowywany jest oryginalny
storage sesji; `fresh_state=true` pozostaje odrzucane.
Nadzór startu odczytuje receipt PID 1 przez kanoniczne `runtime_service.process_receipt_path(canonical_paths())`, z technicznego wolumenu runtime-control. Potwierdzony `failed_outcome_retained` przerywa oczekiwanie na gotowość; nie czeka na pełny timeout i nie ponawia Solve.
`just docker-dev-stop-failed <source> <container-id> <image-id> <process-receipt-sha256>` może zatrzymać nadzorcę po potwierdzonej awarii. Pierwotny błąd startu native wymaga poprawnego zakończenia obu schedulerów. Błąd po wcześniejszym `READY` przypina zachowany `service_owner` wyłącznie jako tożsamość. Osobny wariant `api-start-failure` rozpoznaje dokładny prefiks `API binding did not become ready:` w trwałym receipcie procesu, a nie tekst prywatnego stderr; może zachować historycznego ownera `Failed` z terminalnym błędem dziecka. Nie dowodzi, że native runtime nigdy wcześniej nie działał.

Każdy wariant wymaga zakończonego API, braku żywych procesów i aktywnych lease’ów oraz zwolnionych rezerwacji hosta. Bezpośrednio przed zapisem journalu komenda ponownie pobiera dowody i porównuje receipt oraz surowe piny `OWNER`; drift przerywa operację. Po zatrzymaniu weryfikuje niezmienionego ownera. Sam stop nie odzyskuje GPU, nie zmienia ownera i nie powtarza skryptu; dalszy start nadal podlega natywnym bramkom recovery. Obserwacja nieznana lub aktywne zasoby blokują komendę.
Stara komenda odtwarzania przez hostowy receipt DEV odmawia wykonania.

### Aktywacja skryptu w już działającym Workspace

Jeżeli grupa ma już zdrowe, działające usługi `backend` i `frontend`, skrypt
można aktywować bez restartu, odtwarzania ani przebudowy kontenerów:

```powershell
just docker-dev-script "examples/fem_relax_gpu_smoke.py"

# Explicit pins remain available for operator recovery and diagnostics:
just docker-dev-script-pinned <attempt> <config-sha256> <checkout> <script>
```

Zwykła komenda ustala `attempt` i `config-sha256` automatycznie z bieżącej
grupy i zweryfikowanych receiptów; wymaga dokładnie jednej zgodnej, zdrowej
pary usług. Nie uruchamia kontenerów, nie buduje i nie wybiera historycznej
próby według daty. Przy aktywnej sesji trzeba najpierw zamknąć bieżący projekt
w Workspace; samo zakończenie Solve nie oznacza pustego Workspace.

W jawnej komendzie `docker-dev-script-pinned` wartości muszą pochodzić z tego samego
`development/attempts/<attempt>/{terminal,compose}.json` w wolumenie control.
Jeżeli pierwotny start nie powiódł się, zachowaj jego piny: launcher wymaga
trwałego, pomyślnego `resume`/`iteration` powiązanego z tą samą próbą,
konfiguracją i aktualnymi identyfikatorami usług. Nie zmienia historii błędu.
Launcher ponownie sprawdza grupę Compose, identyfikatory obu kontenerów, obraz,
readonly bind źródeł i zdrowie backendu. Autoryzacja skryptu oraz techniczne
receipty trafiają do control volume; skrypt nie jest kopiowany do storage
Windows ani pakowany do ZIP/TAR.

Polecenie wykonuje wyłącznie stały wrapper `python -I -B -c` w istniejącym
kontenerze `backend`; kod wrappera jest częścią zarządzanej recepty i nie zawiera
żadnej wartości użytkownika. Host weryfikuje niezmienny identyfikator obrazu,
a wrapper weryfikuje hash obrazu `docker_startup_script.py`, ładuje go i wywołuje
`docker_startup_script.run_from_environment()`, które korzysta z wewnętrznego
API live. API dopuszcza pusty bieżący Workspace albo dokładny replay
tego samego `request_id` i hashów. Dla nowego żądania helper najpierw odpytuje
`GET /v2/platform/health` w tym samym backendzie i wymaga `status="ok"` oraz
`active_session=false`; przy aktywnej albo nieznanej sesji nie tworzy markera i
nie wysyła POST. Dokładny replay terminalnego receipt'u omija ten preflight,
natomiast receipt ze stanem `started` nadal oznacza nieznany wynik i blokuje
każdą próbę ponowienia.

Każde żądanie ma własny trwały receipt w control volume:
`/opt/fullmag/control/backend/script-activation-<sha256(request_id)>/activation.json`.
Oryginalny entrypoint bez aktywacji zarządzanej zachowuje swój marker
`/state/.fullmag/docker-startup/activation.json`; wrapper aktywacji ustawia
per-request ścieżkę dopiero po zweryfikowaniu klucza 64 znaków hex. Receiptów
nie kopiuje się do Windows storage i nie archiwizuje automatycznie.

Odrzucenie skryptu jest wynikiem `failed-confirmed` operacji i kończy polecenie
kodem 2; nie oznacza wykonania symulacji. Raport zachowuje osobno identyfikator
operacji oraz `development_attempt`. Długi komunikat błędu pozostaje ograniczony
do 2048 znaków, lecz zachowuje początek i końcową przyczynę tracebacku.

Każde jawne wywołanie otrzymuje nowy domyślny `request_id` w postaci
`docker-volume-<uuid>`, zapisany w receipcie przed wysłaniem żądania. Dzięki temu
ten sam plik może posłużyć do kolejnej symulacji. Jawny `request_id` pozostaje
stabilnym kluczem idempotencji i odtwarza wynik tego konkretnego żądania.
Nieznany wynik wcześniejszej operacji nadal blokuje nowe wywołanie. Nowe żądanie
przechodzi przez istniejącą
walidację Workspace: musi być pusty według kontraktu API. Zamknięcie runu nie
retiruje bieżącego Workspace, więc samo podanie nowego `request_id` jako piątego
argumentu nie wystarcza; potrzebne jest istniejące, jawne przejście do pustego
Workspace. Ten draft nie dodaje mechanizmu retire/reset. Nie używaj ponownie ID,
którego receipt ma stan `unknown`.

Nieznany wynik operacji zachowuje zasoby i blokadę do jawnego rozstrzygnięcia.
Nie usuwaj ręcznie `active`, pakietu ani lease, aby wymusić kolejny build.
Jeżeli host utraci obserwację już po `READY`, a zarządzany stop potwierdzi
zatrzymanie tego samego backendu po nieudanym native runtime, odtworzenie grupy
może wykonać wyłącznie przypiętą reconciliację aktywacji. Sprawdza ona UUID
aktywnej operacji, niezmieniony receipt `outcome-unknown-resources-retained`,
source/config/image/backend, etykiety i polecenie oryginalnego helpera oraz
`READY`/`LOGGED`. Helper dostaje techniczny terminal i sam usuwa `active` oraz
zwalnia blokadę. Oryginalny receipt i marker pozostają nienaruszone, a
`activation/unresolved.json` w control volume trwale blokuje nowe aktywacje i
Solve; nie jest to dowód wyniku symulacji ani zgoda na ponowienie skryptu.
Jeżeli oryginalny helper został już usunięty przez demona, ten wariant nie
przejmuje go na podstawie timeoutu: wymaga osobnego dowodu `inspect`/`ps`, że
jego dokładna nazwa jest nieobecna, a nowy krótkotrwały helper wykonuje pod
`operation.lock` transakcję CAS na `active` i pierwotnym receipcie. Zmieniony
marker, obca zajęta nazwa, cudzy lock lub niezgodny receipt pozostawiają
quarantine i zasoby bez ręcznego czyszczenia.
Launcher przyjmuje wynik dopiero po zdarzeniu `handoff` z bieżącego uruchomienia
kontenera i zgodnym hashu receipt/provenance. Stary udany pakiet nie dowodzi
zakończenia nowego startu. Nieoczekiwany restart kontenera między publikacją
pakietu a gotowością API również przerywa obserwację.

Kopia postępu w konsoli jest diagnostyczna. Rozłączenie stdout (`BrokenPipeError`,
`EINVAL` lub `EBADF`) wyłącza tę kopię i nie przerywa kontrolera ani potwierdzenia
storage Windows. Log w wolumenie kontrolnym i trwałe receipty pozostają wymagane;
błąd ich zapisu nadal przerywa operację. Zakończenie samego procesu kontrolera
pozostaje odrębną utratą obserwacji i wymaga rozstrzygnięcia stanu.

### Browser QA istniejącej grupy

Po uruchomieniu zdrowej grupy można wykonać kontrolę Home, sesji i WebGL przez
obraz Playwright przypięty do digestu:

```powershell
just docker-dev-browser-qa "$source" 3197
```

Kontrola wymaga istniejącego control volume, dokładnie jednej zdrowej pary
`backend`/`frontend`, zgodnych receiptów źródła i portu oraz przypiętego
frontend state volume. Nie tworzy brakującego control volume, nie naprawia
named volume i nie restartuje usług. Domyślny limit pracy przeglądarki wynosi
180 sekund, a osobny limit pobrania brakującego obrazu wynosi 1800 sekund;
parametry `timeout` i `pull_timeout` są ostatnimi argumentami pozycyjnymi
recepty, po `browser_image`. Nieudane lub
niejednoznaczne kontrole kończą się zachowaniem zasobów i wymagają ręcznego
przeglądu receiptu operacji.

## Granica zapisu i retencja

| Dane | Miejsce |
| --- | --- |
| Cargo/CMake, cień źródeł, log Make, CUDA cache | backend build named volume |
| Pakiet, kandydat, zweryfikowany rollback, archiwum metadanych | backend package named volume |
| pnpm, Next, metadata workspace, next.log | frontend named volume |
| Konfiguracje, provenance, receipty, manifesty, logi BuildKit i dowody kontroli | build-control named volume |
| Warstwy zależności/helperów | Docker image store / BuildKit |
| Sesje, wyniki, ustawienia, historia, ledger | skonfigurowany storage hosta Windows albo Linux/WSL |

Źródła są readonly. Krótkie helpery utrzymania należą do tej samej grupy;
nie budują ani nie uruchamiają aplikacji i nie mają Docker socketu.
Helper utrzymania cache ma wyłącznie `CHOWN` i `DAC_OVERRIDE`, aby inicjalizować
markery również w katalogach należących do UID backendu; widzi tylko trzy
zweryfikowane named volumes, bez sieci, writable rootfs ani bindów hosta.
Inicjalizator control-volume ma dodatkowo `FOWNER`; przejmuje wyłącznie znane
katalogi metadanych, bez rekurencyjnej zmiany właścicieli. Kanoniczny helper
bootstrap otrzymuje `DAC_OVERRIDE` tylko dla operacji na tym samym wolumenie,
aby zachować odczyt i atomowy zapis rekordów należących do UID backendu.

Launcher mierzy wolne miejsce w VM oraz na fizycznym wolumenie Windows pod
rozwiązanym katalogiem danych Docker Desktop. Rzeczywisty BuildKit build
oraz operacja budowania i startu aplikacji wymagają 32 GiB wolnego miejsca.
Pakietowy preflight dodatkowo szacuje miejsce na kandydata i rollback.
To rezerwa operacyjna, nie quota ani gwarancja rozmiaru zimnego buildu.

Sprawdzenie i ponowne użycie istniejących obrazów toolchaina oraz wrapperów
może użyć niższego budżetu kontrolnego: 1280 MiB, wyprowadzonego z limitów
logów i dokumentów. Wymaga zgodnego digestu wejść, grupy, control volume oraz
lokalnego immutable image ID; wrapper sprawdza także przypiętego rodzica
oraz etykiety obrazu. Brak zgodnego cache powoduje świeży pomiar i wymaga
pełnych 32 GiB przed BuildKit. Niższy budżet nie dotyczy operacji development.

Na zimnym hoście brakujący obraz helpera jest pobierany przed uruchomieniem
helpera control volume. Windows sprawdza przed pobraniem fizyczny backing
volume; Linux/WSL nie ma jeszcze w tym momencie obrazu pozwalającego zmierzyć
system plików Docker VM. Po pobraniu pełny pomiar poprzedza budowę. Ta granica
pre-pull pozostaje jawna; nie jest dowodem miejsca w VM przed pierwszym pull.

Log Make i next.log mają limit 64 MiB; nadmiar trafia do ograniczonego drivera
Docker `local` (3 pliki po 10 MB na usługę). Pełny next.log wymaga jawnego
przeglądu przed następnym startem. Log operacji ma limit 32 MiB, dokument 8 MiB,
liczba prób jednej fazy i archiwów metadanych pakietu jest ograniczona do 64.
Wyczerpanie budżetu zatrzymuje dalszy zapis, zachowując dowody.

Retencja binariów zachowuje pakiet bieżący i zweryfikowany rollback. Aktywnego
cache nie usuwa. Nie ma automatycznego globalnego GC BuildKit, starych obrazów
ani nieaktywnych grup. Ich usunięcie wymaga osobnego planu właścicieli/referencji
i zgody. Samo usunięcie kontenera nie odzyskuje wolumenów ani fizycznego VHDX.

`just docker-dev-control-checks <source>` uruchamia interpretowane regresje
launcherów w istniejącym backendzie; nie kompiluje natywnych testów jednostkowych.
Sukces buildu nie stanowi kwalifikacji FDM/FEM/BORIS. Release, CI i kwalifikacja
naukowa zachowują własne jawne zarządzane recepty zgodnie z AGENTS.md.
