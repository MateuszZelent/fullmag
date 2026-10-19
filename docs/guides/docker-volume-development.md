# Development Fullmaga z danymi builda w Dockerze

Codzienny build używa grupy Compose wybranego checkoutu. Stały `backend`
kompiluje aplikację i uruchamia API oraz runtime; `frontend` obsługuje Next/HMR.
Obrazy zależności i helperów przygotowuje BuildKit w tym samym projekcie.
Nie powstaje trzecia usługa aplikacyjna ani hostowy katalog kompilacji.

## Uruchomienie

Na Windows użyj natywnego PowerShell, Pythona i Docker Desktop z silnikiem Linux. Na Linux/WSL użyj powłoki Linux, lokalnego Docker Engine, nie-rootowego użytkownika oraz checkoutu i storage na ext4/XFS/Btrfs; szczegóły i granice kwalifikacji opisuje [przewodnik Linux/WSL](docker-wsl.md).
Najpierw skonfiguruj `.env` głównego checkoutu przez `scripts/setup_docker.py`.
Worktree korzysta z konfiguracji przez resolver; nie kopiuj do niego `.env`.
Przeczytaj skill `.agents/skills/fullmag-docker-build/SKILL.md`.

```powershell
$source = "<absolutny-zarejestrowany-checkout>"
Set-Location $source
just docker-dev-toolchain
just docker-dev
```

Kreator zapisuje `FULLMAG_SOURCE_ROOT` i `FULLMAG_HTTP_PORT` do `.env` głównego
checkoutu. Domyślne źródła: jawny argument → zmienna procesu → bieżący worktree
→ `.env` → zapis konfiguratora → główny checkout. Port startu: jawny argument →
zmienna procesu → `.env` → zapis konfiguratora → `3197`. Zajęty port kończy start
błędem. Toolchain, obrazy pomocnicze i aplikacja stosują ten sam wybór źródeł.
Aktywacja kolejnego skryptu odczytuje rzeczywisty port działającej grupy, więc
nie wymaga ponownego podawania wcześniejszego nadpisania portu.

Zakończ edycje i staging przed startem; nie zmieniaj źródeł do zakończenia
próby. Migawka odczytuje checkout dwukrotnie i odrzuca niespójne wejście.

Port musi być wolny. Wybierz wolny port, jeśli inna instancja już działa.
`docker-dev-images` przygotowuje wyłącznie obrazy helperów; `docker-dev-build`
ma tę samą semantykę startu usług co `docker-dev`.

Receipt wypisuje projekt, nazwę wolumenu kontrolnego i identyfikator próby.
Konfiguracja JSON jest w `development/attempts/<attempt>/compose.json`,
a wynik w `terminal.json` w tym samym katalogu wolumenu. SHA konfiguracji to
SHA256 kanonicznego JSON (`docker_build_control.canonical`), nie pliku z newline.
Nie kopiuj tych plików do hostowego `storage/builds`.

## Iteracje i awarie

`just docker-dev-restart-idle <attempt> <config-sha256> <source> <port>`
sprawdza dokładny kontener, obraz, polecenie, etykiety i mounty oraz wymaga
zdrowego API bez aktywnej sesji. Na czas kontroli zamyka jedyne wejście HTTP przez zatrzymanie własnego frontendu,
sprawdza prywatną sieć bez obcych konsumentów, restartuje backend i ponownie
uruchamia ten sam frontend. Zachowuje cache oraz storage użytkownika wybranego hosta. Nie jest komendą do przerywania obliczeń. Wymaga wyłącznego okna operatorskiego,
bez równoległych klientów wysyłających polecenia do tej grupy; odczyt health
nie jest dowodem opróżnienia wszystkich kolejek aplikacji.
Frontend obserwuje katalogi `app`, `src`, `public`, `scripts` i aktualizuje UI
przez HMR. Zmiana helperów obrazu wymaga przygotowania nowego obrazu i jawnego
odtworzenia usług; sam restart zachowuje przypięty obraz.

`docker-dev-resume` wznawia obserwację konkretnego potwierdzonego nieudanego
startu; opcja `restart_backend=true` może uruchomić zachowany zatrzymany backend, również po wcześniej udanym starcie.
`docker-dev-recreate-volume` wymaga zatrzymanego backendu i dokładnych pinów
próby/konfiguracji. Zachowuje wolumeny; opcja `fresh_state=true` tworzy nowy root
sesji, pozostawiając poprzedni. Nie powtarza automatycznie aktywacji Solve.
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

Domyślny `request_id` jest deterministyczny na podstawie próby i hasha pliku:
ten sam skrypt z tym samym domyślnym ID odtwarza terminalny wynik, a inny hash
otrzymuje odrębny receipt. Nowe żądanie nadal przechodzi przez istniejącą
walidację Workspace: musi być pusty według kontraktu API. Zamknięcie runu nie
retiruje bieżącego Workspace, więc samo podanie nowego `request_id` jako piątego
argumentu nie wystarcza; potrzebne jest istniejące, jawne przejście do pustego
Workspace. Ten draft nie dodaje mechanizmu retire/reset. Nie używaj ponownie ID,
którego receipt ma stan `unknown`.

Nieznany wynik operacji zachowuje zasoby i blokadę do jawnego rozstrzygnięcia.
Nie usuwaj ręcznie `active`, pakietu ani lease, aby wymusić kolejny build.
Launcher przyjmuje wynik dopiero po zdarzeniu `handoff` z bieżącego uruchomienia
kontenera i zgodnym hashu receipt/provenance. Stary udany pakiet nie dowodzi
zakończenia nowego startu. Nieoczekiwany restart kontenera między publikacją
pakietu a gotowością API również przerywa obserwację.

## Granica zapisu i retencja

| Dane | Miejsce |
| --- | --- |
| Cargo/CMake, cień źródeł, log Make, CUDA cache | backend build named volume |
| Pakiet, kandydat, zweryfikowany rollback, archiwum metadanych | backend package named volume |
| pnpm, Next, metadata workspace, next.log | frontend named volume |
| Konfiguracje, provenance, receipty, manifesty, logi BuildKit i dowody kontroli | build-control named volume |
| Warstwy zależności/helperów | Docker image store / BuildKit |
| Sesje, wyniki, ustawienia, historia, ledger | skonfigurowany trwały storage hosta |

Źródła są readonly. Krótkie helpery utrzymania należą do tej samej grupy;
nie budują ani nie uruchamiają aplikacji i nie mają Docker socketu.
Helper utrzymania cache ma wyłącznie `CHOWN` i `DAC_OVERRIDE`, aby inicjalizować
markery również w katalogach należących do UID backendu; widzi tylko trzy
zweryfikowane named volumes, bez sieci, writable rootfs ani bindów hosta.
Inicjalizator control-volume ma dodatkowo `FOWNER`; przejmuje wyłącznie znane
katalogi metadanych, bez rekurencyjnej zmiany właścicieli. Kanoniczny helper
bootstrap otrzymuje `DAC_OVERRIDE` tylko dla operacji na tym samym wolumenie,
aby zachować odczyt i atomowy zapis rekordów należących do UID backendu.

Przed operacją launcher mierzy wolne miejsce w VM oraz na fizycznym wolumenie
Windows pod rozwiązanym katalogiem danych Docker Desktop. Obecny próg odmowy
wynosi 32 GiB; jest rezerwą operacyjną, nie quota ani gwarancją rozmiaru zimnego
buildu. Pakietowy preflight dodatkowo szacuje miejsce na kandydata i rollback.

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
