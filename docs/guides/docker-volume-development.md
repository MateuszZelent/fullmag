# Development Fullmaga z danymi builda w Dockerze

Codzienny build używa grupy Compose wybranego checkoutu. Stały `backend`
kompiluje aplikację i uruchamia API oraz runtime; `frontend` obsługuje Next/HMR.
Obrazy zależności i helperów przygotowuje BuildKit w tym samym projekcie.
Nie powstaje trzecia usługa aplikacyjna ani hostowy katalog kompilacji.

Frontend ma limit **16 GiB RAM i 4 CPU**. Launcher Next oraz środowisko
narzędzi uruchamianych w usłudze frontend przypinają
`NODE_OPTIONS=--max-old-space-size=6144` (6 GiB starej generacji sterty V8
na proces). To górne limity, a nie rezerwacja pamięci. Budżet kontenera
pozostawia miejsce na Next, osobny proces lint/typecheck, pozostałe obszary
sterty i alokacje natywne. Launcher nie dziedziczy dowolnych flag Node z hosta.
Zmiana Compose lub helpera wymaga zarządzanego odtworzenia usług z aktualnym
obrazem; sam restart istniejącego kontenera nie zmienia jego limitów.
Odbiór wymaga `docker inspect` (Memory/NanoCpus), odczytu cgroup oraz
potwierdzenia limitu sterty i środowiska procesu Node.

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

### Konsola interaktywna

`just fullmag master examples/model.py` uruchamia tryb GUI: zarządzana grupa
Compose buduje i uruchamia backend oraz frontend, a terminal pokazuje logi
budowania i obliczeń. Terminal pozostaje aktywny po zakończeniu obliczeń aż do
Ctrl+C. Jawny tryb GUI ma postać `just fullmag gui master examples/model.py`;
`just fullmag headless master examples/model.py` uruchamia tylko backend.

Selektorem źródeł może być `master` (główny zarejestrowany checkout), ścieżka
do zarejestrowanego checkoutu albo nazwa brancha. Dwuelementowa forma domyślna
korzysta też z domyślnego portu i `gpu_access=auto`. Aby ustawić port lub dostęp
do GPU (`auto`, `required`, `disabled`), użyj jawnego `gui` albo `headless`, np.:
`just fullmag gui master examples/model.py 3197 required`. Gdy podajesz tylko GPU,
przekaż pusty port: `just fullmag headless master examples/model.py "" disabled`.

Przykład dla warstwy z bimeronem i górnego walca:

```sh
just fullmag master examples/bimeron-cylinder-relax/relax.py
just fullmag headless master examples/bimeron-cylinder-relax/relax.py
```

Nowa konsola wymaga zatrzymanej grupy; aktywnej grupy nie przejmuje. Do ponownego
wykonania skryptu w świadomie pozostawionej działającej grupie służy dotychczasowe
`fullmag-dev-container`. Tryb headless wymaga skryptu uruchamiającego Solve;
`study.wait_for_solve(True)` zachowuje swoje oczekiwanie na osobne Compute.

Ctrl+C prosi o zatrzymanie dokładnie zaakceptowanego uruchomienia, a potem
łagodnie zatrzymuje tylko zweryfikowane kontenery tej grupy; wyniki i wolumeny
pozostają zachowane. Przy zmienionej tożsamości lub nieznanym wyniku mutacji
launcher zgłasza stan wymagający recovery zamiast wykonywać niepotwierdzone
sprzątanie.

`just docker-dev` obsługuje również grupę istniejącą dla wybranego checkoutu.
Działający backend z pasującymi wejściami jest używany ponownie. Zmiana źródeł
uruchamia kontrolowany restart bez aktywnych obliczeń; backend sprawdza istniejący
pakiet; cache-hit przechodzi do API bez kompilacji, a build po zmianie wejść może
wymagać pełnej kompilacji zgodnie z ADR 0076.
Zatrzymana grupa jest wznawiana z przypiętej konfiguracji. Domyślnie pozostaje
jej zapisany port; jawna zmiana portu wymaga odtworzenia konfiguracji.
Współdzielone zależności, pakiety current/rollback i dane użytkownika zachowują
własną retencję; prywatne compiler outputs podlegają ADR 0076. Nieznany wynik wcześniejszej
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

Migawka odczytuje checkout jednym przebiegiem. Git porównuje tylko rozmiar
i sekundy mtime (`core.checkStat=minimal`), bo indeks hosta nie może być
odświeżony przez readonly mount; treść wiąże SHA-256 każdego pliku. Digest pliku
o niezmienionym rozmiarze, `mtime` (ns) i trybie jest brany z cache poprzedniej
migawki (`/build/.fullmag-live-source/hash-cache.json`), więc ponowny start czyta
tylko zmienione pliki. Zapis pliku
w trakcie startu (edytor, formatter) nie kończy próby błędem: odczyt w capture
albo synchronizacja shadow wykrywa zmianę i wykonuje ponowne przechwycenie,
najwyżej trzy razy. Dopiero ciągłe zmiany przez wszystkie próby zatrzymują start.

Nowe, nieśledzone i nieignorowane pliki runtime (poza `docs/`, frontendem,
testami, katalogami administracyjnymi, plikami sekretów i plikami > 16 MiB)
trafiają do migawki automatycznie, więc nowy moduł kompiluje się bez `git add`.
Inne nieśledzone pliki można jawnie dodać do migawki:

```powershell
python -B scripts/docker_dev.py --repo-root $source up --source-root $source --port 3197 `
  --include-untracked apps/control-room/src/new-module.ts `
  --include-untracked examples/new-fixture.json
```

Każda opcja wskazuje dokładną ścieżkę względną do jednego regularnego pliku,
który w chwili przechwycenia zwraca `git ls-files --others --exclude-standard`.
Dozwolone są powtórzone opcje; globs, katalogi, ścieżki absolutne, traversal,
sekrety i pliki administracyjne są odrzucane. Pozostałe nieśledzone pliki spoza
reguły automatycznej nadal pozostają wykluczone. Lista z CLI jest zapisywana jako kanoniczne JSON w
środowisku backendu i wchodzi do digestu Compose; zmiana listy istniejącej grupy
przechodzi przez zarządzane odtworzenie z wymaganym bezpiecznym drainem. Brak
opcji przy uzgadnianiu istniejącej grupy zachowuje przypiętą listę; nowa grupa
bez opcji zaczyna z pustą listą. Jeżeli wybrany plik zostanie później dodany do
indeksu Git, capture akceptuje go jako już obecny w `files` i nie dubluje go w
`included_untracked`.
Programowe przekazanie `[]` jawnie czyści listę; hostowa zmienna środowiskowa
`FULLMAG_DEV_INCLUDE_UNTRACKED` nie ustala jej wartości.

Build DEV kompiluje CUDA tylko dla GPU widocznych w kontenerze backendu (FEM
i FDM, np. `89-real` dla RTX 40xx). Gdy sonda sterownika nie jest dostępna,
build wraca do przenośnej macierzy obrazu. Wybrana lista jest zapisana
w `build.cuda_architectures` receiptu. `backend_dev.py` rozumie też
`FULLMAG_DEV_CUDA_ARCHITECTURES` (`auto`, `all` albo lista CMake), ale launcher
nie przekazuje jeszcze tej zmiennej do usługi, więc DEV zawsze używa `auto`.
Pakiet DEV nie jest artefaktem przenośnym ani wydaniem.

Restart backendu po zmianie wyłącznie `docs/`, frontendu lub plików testowych
wykorzystuje istniejący pakiet: cache-hit porównuje `runtime_source_digest`
receiptu z plikami runtime świeżej migawki. Commit lub zmiana brancha nadal
wymaga przebudowy, bo commit jest wkompilowany w tożsamość binariów.

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

Na Linux/WSL launcher nadaje UID 65532 dostęp POSIX ACL wyłącznie do katalogów wewnątrz jawnie wybranego podkatalogu. Zachowuje dotychczasowe efektywne uprawnienia innych użytkowników i grup oraz właścicieli; pliki źródeł i wyników nie są przepisywane. Domyślne ACL zapewniają operatorowi dostęp do nowych wyników kontenera. Dowiązania, obca własność bez gotowego grantu, zagnieżdżone dane Git i przekroczenie limitu drzewa powodują odmowę przed startem usług. Nie jest to grant na cały checkout.

Przed przyjęciem skryptu backend sprawdza zapis i usunięcie własnego pliku kontrolnego w faktycznych katalogach wyjścia i scratch objętych aliasem. Błąd zwraca `docker_startup_output_mapping_invalid` przed publikacją placeholdera aktywacji i RunIntent; launcher rozpoznaje go jako odrzucenie, bez powtórnego POST. Ten punktowy test nie gwarantuje późniejszego zapisu po zmianie praw lub zapełnieniu dysku.

Skrypt `examples/model.py` używa domyślnie sąsiedniego `model.zarr`.
HDF5 zachowuje obecny kontener `model.results` z plikami `.h5`.
Jawna OutputStorage jest nadrzędna. Zapis sesji wskazuje `model.fms`,
a kolizja tworzy nową nazwę. Export nadal pobiera archiwum przez przeglądarkę.
Wyniki i sesje nie są danymi buildu. Pliki wynikowe bez wpisu w indeksie Git
nie zmieniają source identity; świadomie śledzone fixtures nadal są sprawdzane.

### Historyczna odmowa mapowania wyjścia bez przyjęcia wykonania

Starszy helper mógł zapisać `started`, mimo kompletnej odpowiedzi HTTP422
`docker_startup_output_mapping_required` albo `docker_startup_output_mapping_invalid`.
Nowy helper zapisuje dla tych konkretnych kodów terminal `rejected`; odczyt
terminalu nie wysyła ponownie POST. Błędy nieznane,409 i500 pozostają odrębne.

Historyczne rozstrzygnięcie korzysta wyłącznie z przypiętego requestu w control
volume i istniejącej blokady oryginalnej operacji. `docker_activation_preflight`
wymaga kompletnej końcowej odpowiedzi422 z receiptu kontrolera, zgodnych bajtów
autoryzacji/provenance, skryptu, obrazu i nieprzerwanej inkarnacji backendu.
Skan store/ledgera i bieżącej sesji jest kontrolą anomalii, a nie dowodem globalnej
bezczynności API. Przypadek przyjętego wykonania lub niepełnego logu jest odrzucany.

```text
just docker-dev-reconcile-activation <request-w-control-volume> <sha256-requestu> <source> <port> true
just docker-dev-reconcile-activation <ten-sam-request> <ten-sam-sha256> <source> <port> false
```

Pierwsza komenda wykonuje wyłącznie preview. Druga zachowuje oryginalny receipt
i started marker, utrwala prepared journal, publikuje marker `rejected`, a na
końcu terminal operacji. Oryginalny helper sam zwalnia `active`. Kontroler nie
restartuje usług, nie usuwa danych i nie ponawia aktywacji/Solve. Częściowy zapis
może przyjąć tylko oryginalne albo dokładnie przygotowane bajty; nieznany stan
obserwatora zachowuje jego blokadę i dokładną tożsamość w journal, zamiast
uruchamiać nowego startera. Replay kompletnego terminalu jest tylko odczytem.

Po naprawie konfiguracji nowa aktywacja jest osobnym żądaniem i ponownie podlega
zwykłym kontrolom sesji, źródeł, mountów oraz uprawnień do katalogu wyników.
Ta procedura nie przyznaje automatycznie prawa zapisu do `examples`.

## Iteracje i awarie

Gotowy kandydat pakietu po nieudanej publikacji jest odrębny od działającego
pakietu. Backend najpierw sprawdza jego kompletność i dowody Make oraz
zachowuje oryginalny manifest przed następnym capture źródeł. Dopiero świeże
wejścia pozwalają wybrać istniejącą rotację pasującego pakietu albo retirement
zbędnego stagingu. Przygotowane archiwum bez trwałego intentu niczego nie
usuwa. Logi, receipty i manifesty pozostają w ograniczonym namespace
`backend/candidate-retirements` control volume; bieżący pakiet, rollback,
cache i storage użytkownika zostają zachowane. Nie usuwaj kandydata ręcznie
i nie twórz nowych wolumenów jako obejścia blokady. Kontrakt i stan dowodu:
[ADR 0061](../adr/0061-docker-development-build-and-runtime-container.md#rozszerzenie-20102026--gotowy-nieopublikowany-staging).

`just docker-dev-restart-idle <attempt> <config-sha256> <source> <port>`
sprawdza dokładny kontener, obraz, polecenie, etykiety i mounty oraz wymaga
zdrowego API bez aktywnej sesji. Na czas kontroli zamyka jedyne wejście HTTP przez zatrzymanie własnego frontendu,
sprawdza prywatną sieć bez obcych konsumentów, restartuje backend i ponownie
uruchamia ten sam frontend. Zachowuje cache oraz storage hosta. Nie jest komendą do przerywania obliczeń. Wymaga wyłącznego okna operatorskiego,
bez równoległych klientów wysyłających polecenia do tej grupy; odczyt health
nie jest dowodem opróżnienia wszystkich kolejek aplikacji.

Opcjonalny ostatni argument `true` recepty `docker-dev-restart-idle` przekazuje
istniejący tryb `--allow-prepared-session`. Pozwala zachować nigdy niewykonane,
wstrzymane zadania Study również po zakończonym zadaniu. Nadal wymagane są
sprawdzenie ich historii i brak aktywnych konsumentów oraz natywny drain;
tryb nie zwalnia Solve i nie anuluje zadań. Domyślne `false` zachowuje
restrykcyjny restart; inne wartości argumentu są odrzucane.

Dla nigdy niewykonanego, przygotowanego Study dziennik może być pusty albo
zawierać wyłącznie ukończone `fdm_grid_refresh`, związane zachowanym targetem
z dokładnie bieżącym runem. Liczniki, rewizje, identyfikatory i czasy receiptów
muszą być spójne; synchroniczny Grid może nie mieć opcjonalnego czasu dispatch.
Obce runy, polecenia solvera i komendy nieukończone lub z błędem blokują drain.
Preflight zachowuje dopuszczony dziennik w dowodzie stopu. Nadal wymaga gotowej
siatki, samych pending stages, manualnego Held gate bez `start_release` dla
każdego zachowanego runu oraz właściwego natywnego drain; nie czyści kolejki
ani historii w celu dopuszczenia restartu.

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
Odczyt drain receipt wymaga poprawnego mountu runtime-control backendu. Launcher
sprawdza obraz, mount, subpath namespace i właściciela wolumenu jeszcze przed
lease `iteration` i przed zatrzymaniem którejkolwiek usługi; błąd tej kontroli
zostawia grupę działającą i nie tworzy próby. Grupa bez kwarantanny namespace
ma `BuildControl.namespace == ""` i używa subpath `runtime-control`.

#### Odtworzenie Linux DEV po utracie katalogu stanu

Użyj tej ścieżki tylko dla istniejącej grupy `fullmag-master` w profilu
`linux-native-v1`, gdy w katalogu stanu na WSL zostało wyłącznie potwierdzenie
zwolnienia writera. Wymagana jest udana operacja `stop-diagnostic-volume`
dla bieżącej inkarnacji backendu. Przypnij identyfikator tej operacji
i SHA-256 surowego pliku `stop-diagnostic/attempts/<stop>/terminal.json`
z wolumenu kontrolnego.

```text
just docker-dev-recreate-lost-state <development> <config-sha256> <source> <stop>@<terminal-sha256> <port>
```

Launcher sprawdza kontenery, brak dodatkowych konsumentów i zwolnienie
wszystkich rezerwacji w ledgerze przed usunięciem starej pary. Zachowuje
pozostały katalog stanu, archiwizuje runtime i ledger w tym samym prywatnym
wolumenie oraz uruchamia nową pustą sesję w tej samej grupie. Skrypty i Zarr na
hoście pozostają dostępne. Uruchomienie skryptu jest oddzielną operacją.

#### Zapis pustej sesji UI przed restartem

Zwykłą, aktywną sesję `ui_authoring` w stanie `awaiting_command`, bez bieżącego
runu i bez obiektów sceny, można zachować w archiwum projektu przed
`restart-idle`. Dla tego przypadku checkpoint używa osobnego schematu
`fullmag.saved-empty-authoring-restart.v1`: oba piny źródła (`source_entry` i
`source_sha256`) muszą jawnie mieć wartość `null`. Archiwum zachowuje dokładne
hashowane rewizje projektu i sceny; scena musi wskazywać `source_of_truth: ui`,
a `objects` musi być pominięte albo puste. Nie dodaje się zastępczego skryptu
Python ani metadanych skryptu, historii źródeł, historii projektu lub runów.

Ta ścieżka nadal wymaga zwykłego ścisłego probe stanu przed i po zatrzymaniu
frontendu, identycznych pinów kontenerów, źródeł, właściciela i archiwum oraz
uwierzytelnionego natywnego drainu. Nie przyjmuje checkpointów rozszerzonych o
anulowane lub historyczne preclaim ani katalogi zachowanych runów. Istniejący
schemat `fullmag.saved-authoring-restart.v1` pozostaje przeznaczony dla
archiwów z przypiętym skryptem źródłowym i nadal wymaga obu pinów źródła.

Do bezpiecznego zatrzymania tej grupy użyj `just docker-dev-stop-saved-authoring`
z przypiętym checkpointem. Recepta przechodzi przez probe i native drain,
następnie pozostawia frontend oraz backend zatrzymane. Nie odtwarza sesji ani
nie uruchamia skryptu; archiwum pozostaje zachowane do osobnego, jawnego otwarcia
projektu.

#### Początkowy start odrzucony z powodu wyczerpanej puli sieci

Błąd Dockera `all predefined address pools have been fully subnetted` może
wystąpić przed utworzeniem obu usług. Zachowany helper i receipt
`outcome-unknown-resources-retained` nie są zgodą na ponowne `up` ani ręczne
usunięcie `active`. Najpierw sprawdź właścicieli sieci; nie stosuj globalnego
`network prune` i nie usuwaj sieci grup z zachowanymi kontenerami lub recovery.
Usunięcie osieroconej sieci innego zadania wymaga odrębnej autoryzacji.

Dla wyłącznie początkowej próby, bez wcześniejszego udanego deploymentu,
recepta `docker-dev-reconcile-network-failure` potwierdza nieudany start.
Przyjmuje wybrany checkout, dokładny attempt, hashe oryginalnego `receipt.json`
i `compose.json` oraz ID silnika Docker. Domyślnie wykonuje tylko preview:

```text
just docker-dev-reconcile-network-failure <source> <attempt> <receipt-sha256> <compose-sha256> <engine-id>
```

Po sprawdzeniu dowodów końcowy argument `true` wykonuje failure-only CAS.
Wymagane są: dokładny błąd puli, brak usług (także zatrzymanych) i sieci tej
próby oraz zgodny oryginalny helper z potwierdzonym `LOGGED`, nadal trzymający
`operation.lock`. Pełny spis kontenerów wyklucza konsumentów zasobów
tej grupy we wszystkich stanach. Obejmuje jej tożsamość projektu i źródła,
prywatną sieć oraz nazwany wolumen kontrolny. Uwierzytelniony `Mountpoint`
wolumenu z daemona pozwala także odrzucić bezpośredni bind jego katalogu,
rodzica albo podkatalogu. Stan zasobów jest ponownie sprawdzany przed publikacją.

Zakres tej procedury failure-only stanowią metadane wskazanej grupy zgodnie
z ADR 0067. Jej transakcja zapisuje receipty i marker w wolumenie kontrolnym.
Obce bindy samego checkoutu pozostają poza tym zakresem. Admisja buildu,
przenoszenie źródeł i kwalifikacja retencji mają własne wymagania dotyczące
checkoutu, danych i konsumentów.
Adapter zachowuje oryginalny receipt i dowód, nie publikuje sukcesu ani
`verified`, nie uruchamia usług i nie usuwa danych. Domyślnie oryginalny helper
zwalnia swój marker `active` po odebraniu terminalnego wyniku.

Jeżeli oryginalny helper został utracony, istnieje osobny, jawnie wybierany tryb
`recover_absent_helper`. Najpierw wykonaj preview z argumentami `false true`:

```text
just docker-dev-reconcile-network-failure <source> <attempt> <receipt-sha256> <compose-sha256> <engine-id> false true
```

Po autoryzacji i sprawdzeniu preview argumenty `true true` wykonują recovery.
Tryb wymaga potwierdzonej przez daemon nieobecności helpera, również jako
zatrzymanego kontenera, zgodnego wolumenu kontrolnego oraz wolnej, istniejącej
blokady `operation.lock`. Zachowuje wszystkie pozostałe kontrole początkowej
próby, konsumentów, sieci i braku wcześniejszych publikacji. Nowy helper
kontrolny uzyskuje tę blokadę bez tworzenia ani obcinania pliku, sprawdza jej
tożsamość oraz przypięte receipty i marker. Pod jedną blokadą archiwizuje
oryginał, publikuje dowód i trzy zgodne zapisy `failed-confirmed`, a dopiero
wtedy usuwa dokładnie marker tej próby. Nie odtwarza starego helpera ani
nie przypisuje sobie jego tożsamości.

Nieznany wynik publikacji lub częściowy zapis wymaga odczytu zachowanych
dowodów; nie ponawiaj mutacji w ciemno. Potwierdzone zamknięcie błędu pozwala
ponowić zwykły launcher `docker-dev`; samo nie dowodzi dostępności puli
adresowej ani poprawnego buildu aplikacji.

Jeżeli domyślne pule Dockera są nadal wyczerpane, launcher przyjmuje jawną
opcję `--network-subnet <CIDR>` (ostatni argument recepty `docker-dev`).
Dotyczy ona wyłącznie prywatnego bridge tej grupy i jest zapisywana w jej
przypiętym dokumencie Compose. Dopuszczalna jest kanoniczna podsieć IPv4 RFC1918
z prefiksem od /16 do /29. Przed wyborem sprawdź bieżące trasy hosta; launcher
sprawdza dodatkowo kolizje z sieciami Dockera. Nie zmienia konfiguracji daemona,
nie usuwa innych sieci i nie dobiera zastępczego zakresu. Dla istniejącej grupy
jawnie podany zakres musi zgadzać się z jej utrwalonym Compose.

Dopiero potwierdzony terminal i zwolnienie helpera pozwalają na nowy start
standardową receptą. Ta procedura nie służy do odzyskiwania zatrzymanego
mastera z istniejącą sesją.

#### Odzyskanie grupy zablokowanej w `iteration`

Przed poprawką z 21.10.2026 idle restart grupy bez namespace (`""`) zatrzymywał
frontend i backend, a dopiero potem odrzucał pusty namespace komunikatem
`runtime-control namespace is invalid`. Taka grupa ma oba kontenery w stanie
`Exited (0)`, działający helper `fullmag-control-<attempt>`, plik `active`
z tym `<attempt>` i `iteration/attempts/<attempt>/receipt.json` ze stanem
`outcome-unknown-resources-retained`. Każde `up` kończy się wtedy komunikatem
`Existing DEV operation is active`. Faza `iteration` nie ma reconcilera, więc
helper czeka bez końca na `terminal.json` tej próby.

Trasa odzyskania (`NOT VERIFIED` na żywej grupie; wymaga zgody właściciela
grupy, bo zwalnia lease):

1. Tylko odczyt. Potwierdź, że `active` zawiera `<attempt>`, receipt tej próby
   ma dokładnie powyższy stan i błąd, a w katalogu próby są
   `idle-preflight.json` i `compose.json`, lecz nie ma `backend-drain.json`
   ani `terminal.json`. Kontenery `backend` i `frontend` mają te same `Id`
   co `backend_container`/`frontend_container` w `development/current.json`,
   `Running=false`, `ExitCode=0`, `OOMKilled=false`, a `FinishedAt` jest
   późniejsze niż `started_at` próby. Helper ma polecenie równe
   `BuildControl.operation_script("iteration", <attempt>)`. Inny stan, błąd
   albo działająca usługa oznacza inny przypadek: nie stosuj tej trasy.
2. Z checkoutu zawierającego poprawkę odczytaj drain receipt zatrzymanego
   backendu przez `_read_terminal_process_receipt` z
   `docker_volume_stop_unadmitted`. Wymagany jest stan `drained`; zapisz jego
   SHA-256 jako `iteration/attempts/<attempt>/backend-drain.json` w tym samym
   schemacie, którego używa idle restart. Brak lub inny stan drain blokuje
   dalsze kroki.
3. Zapisz przez `BuildControl.write` plik
   `iteration/attempts/<attempt>/terminal.json`: kopię receipt ze stanem
   `failed-confirmed`, `reason: "runtime-control-namespace-rejected-after-graceful-stop"`,
   SHA-256 drain receipt i czasem `finished_at`. Nie zmieniaj `receipt.json`,
   `development/current.json` ani `verified.json`. Helper sam usuwa `active`
   i kończy działanie; potwierdź brak `active` i kod wyjścia helpera 0.
4. Zwykłe `just docker-dev "<checkout>" <port>` widzi zatrzymaną grupę i wybiera
   `resume` z `restart_backend=true` (przy dryfie wejść builda lub helperów
   obrazu: zarządzane recreate bez drainu). Build odbywa się w tym samym
   kontenerze `backend` zgodnie z ADR 0076, bez zmiany storage i bez ponawiania Solve.

Nie usuwaj helpera, wolumenu control ani pliku `active` ręcznie i nie twórz
nowego namespace jako obejścia. Automatyczny reconciler tej fazy pozostaje
otwarty (audyt 21.10.2026, T3 oraz R0.7/R0.8).

Frontend obserwuje katalogi `app`, `src`, `public`, `scripts` i aktualizuje UI
przez HMR. Zmiana helperów obrazu wymaga przygotowania nowego obrazu i jawnego
odtworzenia usług; sam restart zachowuje przypięty obraz.

`docker-dev-resume` wznawia obserwację konkretnego potwierdzonego nieudanego
startu; opcja `restart_backend=true` może uruchomić zachowany zatrzymany backend, również po wcześniej udanym starcie.
Po wcześniej udanym starcie `docker-dev-resume` może również odzyskać frontend
zakończony przez OOM. Wymaga zdrowego, niezmienionego backendu, dokładnych
ID/konfiguracji oraz ponownego sprawdzenia inkarnacji przed operacją i po niej.
Dla zgodnej konfiguracji uruchamia ten sam kontener bez zmiany seeda i zależności;
osobny receipt `frontend-recovery` potwierdza odzyskanie procesu UI.

Starszy frontend bez prywatnego tmpfs właściciela nie jest uruchamiany ponownie.
Launcher wymaga już przygotowanego obrazu zgodnego z bieżącą receptą oraz
zweryfikowanego łańcucha receiptów toolchain → development → backend. Opisana
tu operacja tworząca osobny wolumen frontendu dotyczy wyłącznie recovery
historycznego layoutu. Nie jest wzorcem dla nowej grupy; odpowiedni recovery
w `private/frontend` i migration pozostają **NOT VERIFIED**. Zachowaj stary
wolumen i konfigurację do przeglądu. Nowy receipt `development`
z `recovery_scope=legacy-oom-frontend-recreation` przypina osobno obrazy obu usług.
Backend zachowuje swój obraz, kontener, procesy, pakiet, sesję i rewizję sceny;
launcher porównuje te dane przed odtworzeniem frontendu i po nim.

Żaden wariant odzyskania frontendu nie restartuje backendu ani nie ponawia Solve.
Zgodność zachowanego pakietu backendu z bieżącymi źródłami pozostaje
`NOT VERIFIED`. Odzyskanie UI nie zastępuje buildu backendu ani kontroli
przeglądarki. Nieznany wynik operacji zachowuje lease do jawnej rekonsyliacji.

`docker-dev-recreate-volume` wymaga zatrzymanego backendu i dokładnych pinów
próby/konfiguracji. Zachowuje wolumeny; opcja `fresh_state=true` tworzy nowy root
sesji, pozostawiając poprzedni. Nie powtarza automatycznie aktywacji Solve.
Przed pierwszym admission awaria samego buildu może zachować ten sam root sesji. Wymaga to dokładnego bootstrap certyfikatu, jednej potwierdzonej awarii przypiętej do bieżącego `Docker StartedAt` oraz braku handoff, publikacji pakietu i storage probe. Dowód wskazuje bezpośredni terminal tej próby development albo związany terminal resume; bieżąca inkarnacja kontenera musi być zgodna. Launcher ponawia cały dowód pod blokadą przed odtworzeniem usług. Nie ustawia `restart_verified`, nie zmienia ownera i nie powtarza Solve; nowe API nadal wymaga zwykłego admission. Brak lub zmiana dowodu blokuje tę ścieżkę.

Bezpośredni CLI `recreate-volume` obsługuje również powtarzane
`--include-untracked`. Jawne opcje przypinają kompletną listę plików nowej
konfiguracji; brak opcji zachowuje listę poprzedniej próby. Obowiązują te same
kontrole dokładnych ścieżek, regularności i spójnego capture co przy `up`.

Jeżeli prywatny request odzyskania przyjętego runu został już opublikowany,
launcher ponownie sprawdza jego niezmienne archiwum procesu i właściciela,
pierwotną aktywację, reconciliation, stop journal oraz nadal oczekujący run.
Odtworzony proof i request muszą mieć dokładnie te same bajty. Bieżące pliki
procesu mogą pochodzić z późniejszego kontenera i nie zastępują historii;
jego własny dowód zatrzymania nadal przechodzi oddzielną kontrolę przed
odtworzeniem usług. Brak lub niezgodność części opublikowanego archiwum
blokuje start, bez powtarzania Solve i bez modyfikacji danych runu.
Przerwana publikacja bez końcowego requestu może zostać dokończona wyłącznie
po walidacji bieżących rekordów procesu i właściciela oraz zgodności każdego
istniejącego fragmentu z odtworzonymi bajtami. Częściowe archiwum samo nie
uprawnia do odzyskania historii.
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

#### Diagnostyczny stop po udanym przygotowaniu, bez Start

Gdy przygotowanie FEM zakończyło się exit 0, lecz runtime jest Failed przed
Start i oryginalny helper aktywacji nadal trzyma swój lease, użyj wyłącznie
jawnego wariantu `prepared-unclaimed-v1` w `docker_volume_stop_failed.py`.
Recepta `docker-dev-stop-prepared-unclaimed` wymaga pełnych pinów źródeł,
kontenera, obrazu, process receipt, aktywacji oraz pliku target z jego SHA.
Domyślny preview nie zatrzymuje backendu. Apply wymaga odczytanego SHA planu;
kontynuacja wymaga SHA już utrwalonego signal-intent i nie powtarza TERM.

Ten wariant zachowuje udane przygotowanie i niezależnie dowodzi NoStart.
Wymaga pasującego Released lease i host release proof oraz braku aktywnych
rezerwacji, workerów i obcych procesów. Nie przerabia intencji automatycznego
startu na ręczne wstrzymanie. Oryginalny helper zwalnia swój marker dopiero po
technicznie terminalnym handshake; nie usuwa go operator ani nowy helper.
Stop zapisuje odrębny journal i quarantine `cancellation-required`, z ownerem
Failed oraz `healthy_drain=false`.

Quarantine dopuszcza następnie tylko dopasowane natywne maintenance
`cancel-unclaimed-volume --prepared-quarantine-sha256 <sha>` bez API/Solve.
Jeśli dokładne `--resume-maintenance-attempt <attempt>` blokuje nieaktualny
cache obrazów po zmianie wejść helperów, operator najpierw przygotowuje je przez
zarządzane `just docker-dev-images` w tym samym checkoutcie i projekcie Compose.
Następnie odczytuje pełny immutable ID backendu z aktualnego, zweryfikowanego
receiptu `image-backend` i podaje `--resume-backend-image-id sha256:<64 hex>`.
Bez tego opcjonalnego pinu resume nadal wymaga obrazu historycznego maintenance;
pin nie wybiera dowolnego obrazu ani nie uruchamia automatycznego rebuilda.
Pełna walidacja bieżących źródeł, toolchaina, receiptów i etykiet pozostaje
obowiązkowa. Inputs nowej operacji zachowują przejście obrazu, attempt i source
digest zweryfikowanego receiptu oraz odnośnik do niezmienionej historii requestu;
stary store i jego certyfikat pozostają związane z oryginalnym obrazem runtime.
Ta kontynuacja nadal nie uruchamia API ani solvera. Faktyczny runtime z nowym
pinem pozostaje **NOT VERIFIED** do odrębnej próby i kontroli jej receiptów.

Prepared maintenance i fresh archive zachowują dokładne limity backendu z
uwierzytelnionego witness (`Memory`, `NanoCpus`, `MemorySwap`), także przy innej
bieżącej konfiguracji `.env`. Preflight sprawdza live quarantine/admission,
Docker capacity, native contracts i allowlist przed cache, ledgerem i rotacją
certyfikatu; końcowy render nadal przechodzi dokładny guard. Zapisany budget
nadal wymaga prawidłowej historii, ale nie zastępuje retained limits. Wyłącznie
zaobserwowana odmowa `prepared recovery changed backend resource budget` przed
Compose/start może kontynuować z dokładnego parenta błędu ścieżki: własny before,
request i witness muszą się zgadzać, pełny chain stop/removal oraz archiwa są
kopiowane do nowej operacji z pinami pochodzenia. Dla tego boundary częściowo
obrócony certyfikat może wskazywać oryginalny obraz albo dokładny obraz failed
maintenance; pozostałe kontrole właściciela, store, inode, profilu i engine
pozostają obowiązkowe. Nie przywracaj markerów ani historycznych receiptów.

Dopiero po potwierdzonym Cancelled osobny
`recreate-volume --fresh-state --prepared-quarantine-sha256 <sha>` może
zarchiwizować stary runtime-control/ledger i uruchomić nową generację przez
zwykłe bramki managed build/admission. Zwykły start, zachowanie starego namespace
przez `recover-cancelled-volume` oraz odtworzenie przed anulowaniem są
odrzucane. Żaden etap nie ponawia starego skryptu ani nie usuwa sesji, wyników
lub oryginalnego Zarr.

Przerwanie po zakończonym archive przed publikacją końcowych potwierdzeń
domyka wyłącznie dopasowany wariant `resume-interrupted-fresh-archive`.
Wymaga on pary `--prepared-quarantine-sha256` oraz
`--prepared-archive-terminal-sha256`; pojedynczy pin jest odrzucany.
Musi zweryfikować istniejący intent i terminal archiwum, Unknown receipt
oryginalnej operacji, quarantine i zgodny anchor generacji group ledger.
Brak lub stary anchor odmawia kontynuacji; sam archive terminal nie wystarcza.
Nie ponawia fizycznej archiwizacji,
Solve ani sygnałów i nie wymaga odtworzenia usuniętych starych kontenerów.
Oryginalny helper odtworzenia zwalnia własny lease po terminalnym handshake.

Kontrakt i warunki rollback opisuje
[ADR 0061](../adr/0061-docker-development-build-and-runtime-container.md#awaria-runtime-po-udanym-przygotowaniu-przed-start-05112026).
Stan runtime: **NOT VERIFIED**, dopóki rzeczywiste stop, anulowanie, archiwizacja
i admission nie mają osobnych, dopasowanych receiptów.

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
próby według daty. Jeżeli poprzedni model jest terminalny, archiwizuje jego
kanoniczny model, edytowalny skrypt i typowany stan UI, zachowując odwołania do
wyników bez kopiowania ciężkich artefaktów. Dopiero potem aktywuje nowy skrypt.
Trwająca symulacja lub niepotwierdzone zwolnienie zasobów blokuje przejście;
polecenie nie anuluje symulacji ani nie zwalnia GPU.

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

Wyjątek zgłoszony przez sam skrypt podczas ładowania (np. `ValueError` z walidacji
DSL) helper SceneDocument zgłasza kopertą `fullmag.script-load-rejection.v1`
(kod wyjścia 2). Trasa startupowa API zamienia wyłącznie tę kopertę na HTTP 422
`validation_error`, zanim powstanie stan live, RunIntent lub wpis katalogu. Jest to
więc terminalne odrzucenie: grupa pozostaje wolna dla kolejnego skryptu, a wynik
`run-script` zawiera pole `rejection` z kodem i komunikatem API (wraz z numerem
linii skryptu). Inne niepowodzenie helpera pozostaje HTTP 500 i nieznanym wynikiem.

Grupa zablokowana tym błędem przed poprawką (receipt aktywacji
`outcome-unknown-resources-retained` z `HTTP 500 ... python SceneDocument helper
failed`) nie jest przeklasyfikowywana automatycznie i nie ma trasy zwalniającej
tę kwarantannę: pozostaje zablokowana do wycofania grupy przez jej właściciela
w cyklu sprzątania worktree (**NOT VERIFIED** jako trasa odzyskania). Nie usuwaj
ręcznie `active`, markera ani lease.

Przekroczenie 30-sekundowego limitu helpera Pythona podczas ładowania skryptu
(proces helpera zabity i zebrany) API zwraca teraz również jako HTTP 422
`validation_error`. Aktywację, która przed tą zmianą zapisała nieznany wynik z
dokładnie tym HTTP 500 (`Python helper exceeded the 30 second deadline`),
zwalnia trasa:

```bash
just docker-dev-release-unknown-activation "<checkout>" <activation-attempt>
just docker-dev-recreate-volume <attempt> <config-sha256> "<checkout>" <port> true
```

Pierwsze polecenie wymaga zatrzymanego backendu (`Exited (0)`, bez OOM, ten sam
kontener, który zapisał wynik, zatrzymany po jego zapisie), drzewa procesów
`drained` z tego uruchomienia, pustego magazynu zaakceptowanych runów i
działającego oryginalnego helpera lease. Zapisuje dowód
`pre-mutation-release-proof.json` i terminal `failed-confirmed`
(`activation_state: not-admitted`); marker aktywacji pozostaje `started`.
Nie ponawia skryptu i nie zmienia danych sesji. Inny błąd, uruchomiony backend
lub zaakceptowany run pozostawiają kwarantannę. Trasa na żywej grupie:
**NOT VERIFIED**.

Przepełnienie wyjścia helpera podczas odczytu flag startupu ma osobną,
ograniczoną trasę zachowującą historię terminalnych runów:

```bash
just docker-dev-reconcile-helper-output "<checkout>" <activation-attempt>
just docker-dev-reconcile-helper-output "<checkout>" <activation-attempt> true <plan-sha256>
```

Domyślny preview niczego nie zatrzymuje. Apply wymaga niezmienionego planu,
dokładnego zapisanego HTTP 500 dla limitu 1048576 bajtów, pustej aktywnej sesji,
terminalnych katalogów zadań, zwolnionych lease i dowodu braku `RunIntent`
tego żądania we wszystkich zachowanych runach. Ta trasa nie zmienia warunków
starszego `docker-dev-release-unknown-activation`.

Operator zapisuje trwały intent przed SIGTERM. Nie wysyła SIGKILL; po przerwanej
obserwacji wznowienie wymaga tego samego planu i tej samej inkarnacji backendu.
Jeżeli backend nadal działa, ponownie sprawdza brak aktywnej sesji przed sygnałem.
Po zatrzymaniu wymaga `Exited (0)`, native `drained`, ponownego sprawdzenia
magazynu i niezmienionej historii. Dopiero wtedy publikuje dowód
`terminal-history-output-proof.json` i pozwala oryginalnemu helperowi zwolnić
jego techniczny lease. Oryginalny marker `started`, receipt i wszystkie wyniki
pozostają zachowane; żądania startupu nie wolno ponawiać. Następny zarządzany
`docker-dev` może wznowić zatrzymaną grupę z zachowanym storage, bez fresh-state.
Przypadek z 14 historycznymi terminalnymi runami zweryfikowano w runtime;
pozostałe stany nadal podlegają opisanym odmowom i testom fail-closed.

Startup odczytuje teraz tylko `interactive_session_requested` i `wait_for_solve`
przez wewnętrzne `export-run-config --runtime-flags-only`. Dokument sceny nadal
przenosi odwołania do plikowych stanów magnetyzacji. Pełne wektory nie trafiają
do wyjścia helpera służącego wyłącznie odczytowi tych flag; limit 1 MiB i limit
czasu pozostają bez zmian. Lekki test regresji obejmuje 18528 wektorów i
nieprawidłowy kontener metadanych; odbiór tej zmiany przez przebudowane API
wymaga osobnego dowodu managed runtime.

Każde jawne wywołanie otrzymuje nowy domyślny `request_id` w postaci
`docker-volume-<uuid>`, zapisany w receipcie przed wysłaniem żądania. Dzięki temu
ten sam plik może posłużyć do kolejnej symulacji. Jawny `request_id` pozostaje
stabilnym kluczem idempotencji i odtwarza wynik tego konkretnego żądania.
Nieznany wynik wcześniejszej operacji nadal blokuje nowe wywołanie. Nowe żądanie
przechodzi przez istniejącą walidację pustego Workspace po potwierdzonym
archiwizowaniu poprzedniego modelu. Prywatna operacja retirement nie tworzy
RunIntent i nie wywołuje Solve. Jej trwały intent w control volume wiąże dokładne
session/run oraz wejścia operacji; niezmienne archiwum projektu trafia do
session store, obok danych użytkownika. Ponowienie tej samej operacji kończy
wyłącznie archiwizowanie. Nie ponawia startupowego POST ani Solve po nieznanym
wyniku. Nie używaj ponownie ID, którego receipt ma stan `unknown`.

Potwierdzona odmowa przy aktywnej symulacji zamyka własną operację bez mutacji
modelu. Utrata odpowiedzi po wysłaniu retirement zachowuje blokadę i dokładne
piny do reconciliacji. Nowa instancja API wymaga bieżącego zakresu żądania oraz
hasza i oryginalnego zakresu niezmiennego archiwum. Nie usuwaj markerów ręcznie.
Ta ścieżka wymaga jeszcze kwalifikacji runtime: **NOT VERIFIED**.

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
subpath `private/frontend`. Nie tworzy brakującego control root, nie naprawia
named volume i nie restartuje usług. Domyślny limit pracy przeglądarki wynosi
180 sekund, a osobny limit pobrania brakującego obrazu wynosi 1800 sekund;
parametry `timeout` i `pull_timeout` są ostatnimi argumentami pozycyjnymi
recepty, po `browser_image`; opcjonalne `saved_playback_item_id` jest kolejnym
argumentem. Nieudane lub
niejednoznaczne kontrole kończą się zachowaniem zasobów i wymagają ręcznego
przeglądu receiptu operacji.

Kontrolę odtwarzania zapisanego wyniku można jawnie skierować na istniejący,
zarejestrowany workspace item. Podaj jego dziesiętny identyfikator jako ostatni
argument recepty:

```powershell
just docker-dev-browser-qa "$source" 3298 "" 180 1800 "<item-id>"
```

Ta odrębna próba uruchamia przypięty harness w tym samym zarządzanym, tylko do
odczytu kontenerze Playwright. Nie instaluje przeglądarki na hoście i nie
uruchamia Solve ani Compute Fields. Receipt zapisuje identyfikator oraz SHA-256
źródłowego harnessu, a wynik potwierdza odczyt payloadów ramek, widoczny canvas,
żywy kontekst WebGL i stabilność Inspectora oraz kamery. Tryb SwiftShader jest
dowodem przeglądarki, nie dowodem sprzętowego GPU ani fizyki FEM.

Osobny scenariusz `--inspector-ack` sprawdza stabilność Inspectora podczas
rzeczywistego PATCH i ACK. Wymaga przygotowanego, oczekującego modelu
`examples/airbox_inspector_mixed.py`. Uruchom go dla zdrowej grupy:

```powershell
python -B scripts/docker_dev_browser_qa.py --repo-root "$source" --source-root "$source" --port 3197 --inspector-ack
```

Próba przypina sesję i obiekt `mixed_p1_box_prism`, zmienia jego nazwę na
unikalną wartość testową i potwierdza przywrócenie nazwy przez API. Wynik
obejmuje zachowanie węzła, fokusu i scrolla, dostępność pól, budżet żądań,
rewizje obu ACK oraz hashe harnessu i bibliotek. Przywracanie używa aktualnej
rewizji i własnej nazwy testowej. Konflikt sesji, obca zmiana nazwy albo
niepotwierdzony wynik zapisuje nieudaną próbę wymagającą odczytu obiektu przed
kolejnym uruchomieniem. Scenariusz ma własny trwały wynik i wyklucza pozostałe
tryby Browser QA w tej samej operacji.

## Budżet backendu podczas trwającego startu

`increase-resources` zwiększa RAM i CPU dokładnie wskazanego backendu przed
uruchomieniem API, bez odtwarzania kontenera i bez powtarzania skryptu. Wymaga
aktywnej próby `development`, jej uwierzytelnionego helpera i tego samego
zarejestrowanego checkoutu. Domyślnie pokazuje plan bez zmiany limitów:

```powershell
python -B scripts/docker_dev.py --repo-root <main> increase-resources `
  --source-root <source> --attempt <development-uuid> `
  --backend-container-id <full-container-id> --backend-memory-gib 128 --backend-cpus 16
# Zastosowanie tego samego zakresu: dodaj --apply.
```

Zmniejszenie limitów ani aktualizacja działającego solvera nie są obsługiwane
przez tę komendę. Przed zmianą helper krótko wstrzymuje przypięty proces
startowy; jeśli jego bramka cgroup już opublikowała request, odrzuca zmianę.
Proces zostaje wznowiony po potwierdzeniu nowych limitów. Przed wysłaniem zmiany
EOF/watchdog zwalnia pauzę; po uzbrojeniu aktualizacji nieznany wynik zachowuje
zatrzymany startup i zapisane dowody, blokując wejście do gate. Niezależny
hostowy finalizer wznawia przypięty proces również po śmierci helpera, jeśli
aktualizacja jest potwierdzona albo nie została wysłana. Jednoczesna utrata
hostowego kontrolera i helpera może pozostawić startup zatrzymany; nie jest
to dowód zakończenia procesu i wymaga obserwacji/reconciliation jego intentu.
Zapas swapu ponad RAM pozostaje taki sam. Budżet nie może przekraczać pojemności
Docker VM, a planowana różnica RAM musi pozostawić co najmniej 16 GiB
aktualnie dostępnej pamięci. Sam limit nie rezerwuje pamięci ani CPU dla runu.

Kontener, obraz, sesje, dane, cache i pierwotne receipty pozostają zachowane.
Nowy receipt jest zapisywany pod `development/attempts/<uuid>/resource-increases`.
Profil `backend/resource-budget.json` wskazuje surowy hash tego receipt i jest
stosowany przy kolejnych startach wyłącznie w tym samym control namespace.
Nierozstrzygnięty wcześniejszy intent blokuje następne zwiększenie, zamiast
automatycznie ponawiać `docker update`. Limit 200 GiB wymaga VM większej niż
200 GiB z zapasem dla innych usług; komenda nie restartuje Docker/WSL ani innych grup.
Odbiór uruchomienia API, meshu i solvera jest osobnym dowodem.

## Przywrócenie zapisanego budżetu po odmowie cold startu

Wariant `cold-memory-increase-restore-stored-budget` dotyczy jednej grupy DEV,
w której nowy start utworzył wyłącznie diagnostyczne API, ponieważ konfiguracja
żąda większego RAM niż zachowana polityka group ledgeru. CPU, GPU, storage,
host, topology, revision i epoch muszą być identyczne. Historyczny runtime musi
mieć uwierzytelniony idle-drain; same wpisy `released` ani brak PID nie stanowią
wystarczającego dowodu. Gotowość rzeczywistego odtworzenia pozostaje
**NOT VERIFIED** do zakończenia operacji i kontroli nowego API.

Podgląd używa aktualnej failed-development próby, jej konfiguracji, kontenera,
obrazu oraz osobnego historycznego idle-drain:

```bash
python3 -B scripts/docker_dev.py --repo-root <source> stop-preowner-policy-volume \
  --variant cold-memory-increase-restore-stored-budget \
  --source-root <source> --attempt <failed-development-uuid> \
  --config-sha256 <compose-sha256> --backend-container-id <full-container-id> \
  --image-id <sha256:image-id> --drain-attempt <successful-idle-drain-uuid>
```

Apply wymaga tych samych pinów, `--apply` oraz
`--expected-plan-sha256 <preview-sha256>`. Kontrola ponownie uwierzytelnia
historyczny native drain, bieżący failure fence i incarnation, release proofs,
wszystkie lokalne lease, terminalne katalogi runów, wolny OWNER.lock i inventory.
Read-only mount ledgeru zachowuje rzeczywisty volume subpath z HostConfig.
Nieznany lub aktywny konsument blokuje mutację.

Operacja zatrzymuje bieżący backend diagnostyczny przez SIGTERM i ograniczoną
obserwację bez SIGKILL. Frontend pozostaje uruchomiony. Zachowuje oryginalny
native drain, ledger, rezerwacje, lease, sesje i wyniki; nie wykonuje Solve.
Nowy typed journal wiąże intent, plan i terminal operacji. Przerwanej operacji
nie zastępuje nowy Stop ani usunięcie markerów: wymaga kontynuacji dokładnego
intentu, bez ponownego sygnału i z idempotentną publikacją. Kontynuacja używa
tej samej komendy i wszystkich pierwotnych pinów oraz `--apply`,
`--expected-plan-sha256 <preview-sha256>` i
`--continue-intent-sha256 <intent-sha256>`. Obserwuje ten sam backend;
nie wysyła ponownego sygnału. Nieznany wynik nadal zachowuje blokadę i dowody.

Istniejące `recreate-volume` konsumuje uwierzytelniony journal i przywraca
budżet wynikający z zapisanej polityki oraz historycznego Compose. Dotyczy to
tej grupy; globalny `.env` pozostaje bez zmian. Uwierzytelniony pin ma pierwszeństwo przed globalnymi ustawieniami
backendu i saved-budget. Pojemność sprawdza się dla efektywnego budżetu
przed końcowym hashem Compose. Jego pochodzenie jest
zapisane w receipcie i ponownie uwierzytelniane podczas kolejnego retained startu.
Nie powstaje fikcyjny receipt zwiększenia zasobów ani nowy ledger. Wymagany
native contract, explicit untracked inputs i brak startup Solve pozostają
przypięte. Zdrowe API, bieżący native owner i fizyczne wykonanie solvera są
oddzielnymi bramkami; pozytywny preview nie dowodzi ich ukończenia.

### Odmowa po wznowieniu nieudanego buildu

Wariant `cold-resume-restore-stored-budget` obejmuje odmowę polityki podczas
`resume` po nieudanym development buildzie. Parent development pozostaje
niezmienny; aktualne container ID, StartedAt, cgroup-ready i odmowa pochodzą
z osobno uwierzytelnionego, bieżącego terminala resume. Zakończony native drain
może należeć do iteracji, której późniejszy rebuild się nie powiódł. Wtedy
wymagany jest również zakończony retained recreate, który usunął dokładnie
historyczną parę kontenerów i zachował state root.

```bash
python3 -B scripts/docker_dev.py --repo-root <source> stop-preowner-policy-volume \
  --variant cold-resume-restore-stored-budget \
  --source-root <source> --attempt <parent-development-uuid> \
  --resume-attempt <failed-resume-uuid> \
  --config-sha256 <compose-sha256> --backend-container-id <full-container-id> \
  --image-id <sha256:image-id> --drain-attempt <drained-then-failed-rebuild-uuid> \
  --recreate-attempt <completed-historical-recreate-uuid>
```

Dozwolona różnica polityki obejmuje CPU i RAM wynikające z Compose oraz
rzeczywistych limitów cgroup. SHA topologii musi dać się odtworzyć z dokładnego
snapshotu CAS ledgeru i zmiany wyłącznie quota CPU. Serializacja odpowiada
`CanonicalInventory` Rust. Affinity, fizyczna topologia CPU/GPU, host, epoch,
revision i pozostałe budżety pozostają identyczne. Nieznana hierarchia cgroup,
brak CAS, zmieniony owner/lease/run lub niezgodny hash odmawia operacji.

Apply oraz kontynuacja używają wszystkich tych samych pinów i parametrów
opisanych wyżej. Journal wiąże także resume i historyczny recreate; nie daje
uprawnienia do odzyskania ownera. Kolejne odtworzenie korzysta ze zwykłego
`recreate-volume`, bez `fresh-state` i bez skryptu aktywującego Solve.
Zachowuje zapisany budżet, native contract i allowlist wejść. Późniejszy
konsument budżetu weryfikuje archiwalne receipty drain/recreate; nowy poprawnie
uruchomiony owner nie musi nadal mieć stanu historycznego `drained`.

## Zatrzymanie zbędnej kontroli rollbacków przed API

Gdy opublikowany pakiet jest gotowy, lecz stary helper nadal sprawdza rollbacki,
`stop-pre-api-start` może utworzyć checkpoint i zakończyć wyłącznie własny start
przed API, zachowując przyjęty model i istniejący kontekst pierwszego pre-ACK:

```powershell
python -B scripts/docker_dev.py --repo-root <main> stop-pre-api-start `
  --source-root <main> --attempt <development-uuid> --backend-container-id <full-id>
# Odczytowy podgląd powyżej; zastosowanie: dodaj --apply.
```

Nie służy do zatrzymywania API, solvera ani aktywnego builda. Wymaga jednego
czytanego artefaktu starego backupu, zakończonej publikacji pakietu, niezmienionego
owner/process/config i held runu bez start_release. Nie zmienia historycznych
receiptów, ownera, konfiguracji, katalogu ani limitów. Zachowuje intent i wynik
w `development/attempts/<uuid>/pre-api-stop`; pierwotny kontroler kończy własną
operację po faktycznym wyjściu backendu. Dopiero terminal `failed-confirmed` i
potwierdzony stop pozwalają właściwemu launcherowi odtworzyć usługę z nowym
helperem, bez nowego `--script`. Nieznany wynik wymaga obserwacji istniejącego
intentu; komendy nie należy ponawiać. Szczegóły i granice: ADR0066.
Jeżeli proces już zakończył się dokładnym exit143, lecz publikacja końcowego
receipt została przerwana, `--finalize` zamiast `--apply` ponownie obserwuje
ten sam zapisany intent pod nowym lease i może dokończyć wyłącznie receipt.
Nie wysyła sygnału i wymaga terminalnego `failed-confirmed` pierwotnej próby.
`--resume-unissued` służy wyłącznie do zwolnienia pauzy po przerwaniu polecenia
przed intentem: wymaga braku nazwanego publishera i samego intentu, oryginalnego
kontrolera oraz świeżych dowodów. Nie wznawia nieznanego lub wydanego stopu.

Jeżeli ręczny restart zakończył się już błędem zamykania manifestu źródeł
przed build/API, zamiast wysyłać stop użyj odrębnego checkpointu:

```powershell
python -B scripts/docker_dev.py --repo-root <main> checkpoint-pre-api-failure `
  --source-root <main> --attempt <failed-development-uuid> --backend-container-id <full-id>
```

Ta komenda zapisuje jedynie dowód istniejącego exit2 i dokładne logi capture-only,
sprawdzając niezmieniony pierwszy kontekst pre-ACK i held run. Nie powtarza
skryptu. W razie przerwanej publikacji `stop-pre-api-start --finalize` rozpoznaje
ten odrębny wariant i domyka receipt również bez sygnału. Następnie zwykła
`recreate-volume` zachowuje model, cache i dane. Przed capture wstrzymaj zapisy
źródeł do czasu potwierdzenia spójnego cienia; restart z Docker Desktop może
zbiec się z edycją hosta i nie jest dowodem ukończonego buildu ani API.

### Zachowanie profilu urządzeń przy odtwarzaniu

Odtwarzanie zachowuje zarówno żądany tryb `auto/required/disabled`, jak i
zweryfikowany wcześniej dostęp `gpu/cpu`. Dla zachowanego GPU launcher wymaga
świeżego dowodu hostowego i kontenerowego przed zatrzymaniem lub usunięciem
usług, a następnie przed nowym startem. Błąd probe lub nieznany wynik nie
powoduje przejścia na CPU. Nowa grupa nadal może rozstrzygnąć `auto` do CPU.
Nie zmienia to polityki istniejącego ledgera.

`recreate-volume` rozpoznaje także wąski przypadek następcy, który po poprawnym
buildzie zakończył się przed API na błędzie `stored host resource policy differs
from explicit ledger configuration`, ponieważ `auto` zmieniło dostęp GPU na CPU.
Osobny witness wiąże dokładny terminal, logi i namespace następcy z poprzednim
ukończonym odtworzeniem, oryginalnym dowodem afterReady oraz niezmienionymi
OWNER/config/process. Wszystkie zasoby muszą być Released; nowy skrypt startowy
jest zabroniony. Witness i obie usługi są ponownie sprawdzane pod blokadą.
Oryginalny kontekst restartu pozostaje identyczny, a nowy start wymaga GPU.

Ta ścieżka nie resetuje ownera, nie migruje ledgera i nie powtarza Solve.
Celowo nie udaje recovery po usunięciu namespace: przerwane odtworzenie
wymaga osobnego przeglądu zachowanych dowodów. Zwykłe uruchomienie tej samej
komendy nie zastępuje brakującego potwierdzenia.

## Granica zapisu i retencja

Daily DEV ma jeden stabilny prywatny `BuildControl.volume` na grupę:
dotychczasowy root control/lock/namespace oraz subpaths `private/backend`,
`private/frontend` i `private/ledger` zgodnie z [ADR 0076](../adr/0076-single-private-volume-per-dev-group.md).
Shared Cargo/pnpm/packages i image/BuildKit pozostają poza tym prywatnym volume.
Fingerprint ABI/toolchain nadal weryfikuje cache; nie zmienia nazwy volume.
Rebuild może inwalidować tylko zastąpione cache pod blokadą. Control, ledger,
checkout, sesje i wyniki nie należą do rebuild wipe. Zachowaj current + jeden
zweryfikowany rollback do udanej publikacji. Migracja dotyczy jednej
stopped/drained grupy naraz; stare zasoby pozostają do archiwizacji i kontroli
referencji. Kontrakt nie potwierdza runtime: mounty i implementacja pozostają
**NOT VERIFIED**.
Retencję `.fullmag-build` po rzeczywistej kompilacji, brak cleanupu przy cache-hit,
failed-generation limit i pełny rebuild po zmianie źródeł określa ADR 0076;
nie traktuj historycznych opisów incremental output jako aktualnego kontraktu.

| Dane | Miejsce |
| --- | --- |
| Cargo/CMake, cień źródeł, log Make, CUDA cache | `private/backend` w `BuildControl.volume` |
| Pakiet, kandydat, current/rollback | Shared packages volume, namespace `groups/<unit_key>` |
| pnpm, Next, metadata workspace, next.log | `private/frontend` w tym samym `BuildControl.volume` |
| Konfiguracje, provenance, receipty, locks, namespace | Dotychczasowy root `BuildControl.volume` |
| Ledger DEV | `private/ledger` w tym samym volume, mount `/host-ledger` |
| Warstwy zależności/helperów | Docker image store / BuildKit |
| Sesje, wyniki, ustawienia, historia, ledger | skonfigurowany storage hosta Windows albo Linux/WSL |

### Archiwizacja metadanych zakończonej aktywacji

`scripts/docker_activation_history.py` kwalifikuje jeden zamknięty rekord przez
preview i zastosowanie dokładnego `--plan-sha256`. Przenosi metadane do historii;
zachowuje sesję, Zarr, sąsiedni skrypt i eksport provenance. Nie zwiększa limitu
aktywnych rekordów, nie odtwarza Solve i nie omija pinów recovery ani blokad
współdzielonych z natywnymi writerami.

Ścieżka `storage(output_dir=...)` może być literalnym stringiem albo nazwą
jednej modułowej stałej z takim literałem. Parser nie wykonuje skryptu.
Odrzuca wyrażenia, aliasy, wielokrotne lub warunkowe przypisania, ponowne
wiązanie nazwy i wildcard imports. Nadal wymaga jednego wywołania `storage`
i kanonicznej ścieżki Zarr pod `/user-data`. Źródło musi odpowiadać oryginalnemu
hashowi aktywacji, a zachowany wynik przechodzi osobną walidację runu.

Historyczny rodzic `failed-confirmed` z zachowanym dokładnym config pinem
wymaga dodatkowo obu argumentów `--historical-runtime-witness` oraz
`--historical-runtime-witness-sha256`. Pierwszy wskazuje dokładny rekord
`resume/attempts/<id>/terminal.json` albo `iteration/attempts/<id>/terminal.json`,
drugi jego surowy SHA-256. Terminal i sąsiedni `receipt.json` muszą być zgodne,
dotyczyć tego samego rodzica, backendu, obrazu, źródeł, grupy, namespace,
wolumenu i `state_root`. Poprawne wznowienie musi następować po nieudanym
starcie, a kończyć się przed aktywacją; stop-only nie jest takim dowodem.
Oba rekordy są przypięte w planie i ponownie sprawdzane przed apply.
To kwalifikacja historycznych mountów, a nie dowód biblioteki użytej w dawnym
runie. Brak świadka, niezgodne piny lub niekompletny wynik nadal blokują
archiwizację. Dla rodzica `succeeded` świadek nie jest używany.

Źródła są readonly. Krótkie helpery utrzymania należą do tej samej grupy;
nie budują ani nie uruchamiają aplikacji i nie mają Docker socketu.
Kontrakt jednego prywatnego volume wymaga, by helper utrzymania widział tylko
zweryfikowane subpaths i mounty potrzebne operacji, bez sieci, writable rootfs
ani bindów hosta. Opisane niżej uprawnienia trzech historycznych named volumes
są dowodem starego układu; nie dowodzą jeszcze implementacji nowej topologii.
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

Polityka pakietów zachowuje current i jeden zweryfikowany rollback do udanej
publikacji nowego pakietu; ostatni dobry pakiet pozostaje do końca kompilacji i
walidacji następcy. Zastąpiony cache backend/frontend można czyścić wyłącznie
w jego subpath pod blokadą. Wpis ADR 0061 o odroczeniu retencji jest historyczny
i superseded przez [ADR 0076](../adr/0076-single-private-volume-per-dev-group.md).
Zgodność źródeł z tym kontraktem i runtime retencji pozostają **NOT VERIFIED**.
Nie ma automatycznego globalnego GC BuildKit, starych obrazów ani nieaktywnych
grup. Ich usunięcie wymaga osobnego planu właścicieli/referencji i autoryzacji.
Samo usunięcie kontenera nie odzyskuje wolumenów ani fizycznego VHDX.

`just docker-dev-control-checks <source>` uruchamia interpretowane regresje
launcherów w istniejącym backendzie; nie kompiluje natywnych testów jednostkowych.
Sukces buildu nie stanowi kwalifikacji FDM/FEM/BORIS. Release, CI i kwalifikacja
naukowa zachowują własne jawne zarządzane recepty zgodnie z AGENTS.md.


### Nieudany start API podczas odzyskiwania oczekującego runu

Awaria API przed przypięciem native ownera może pozostawić nowszy process-tree
niż archiwum pierwotnej awarii. Start rozpoznaje wyłącznie ściśle określony
legacy błąd loopback z zakończonym API, niezmienionym bootstrapem i ownerem.
Archiwa, request i natywna walidacja runu nadal są obowiązkowe. Ten wyjątek
nie powtarza Solve, nie resetuje ownera i nie zastępuje recovery. Inny błąd,
zmiana ownera lub brak dowodów nadal blokują start; nie usuwaj ręcznie receiptów.

## Kwarantanna pustej sesji po nagłym zatrzymaniu Docker

Gdy helper aktywacji zniknął, a owner zachował stan ready, zwykłe resume
pozostaje zablokowane. Jawne odzyskanie jest dostępne wyłącznie dla store
bez RunIntent, runów i wyników oraz grupowego ledgera bez rezerwacji:

```sh
python3 -B scripts/docker_dev.py --repo-root "$source" quarantine-empty-stopped \
  --source-root "$source" --activation "$activation" --recovery-id "$recovery"
# Po kontroli planu: identyczne piny i dodatkowe --apply.
```

Recovery ID jest nowym UUID bez myślników, zachowywanym przy kontynuacji.
Polecenie dowodzi zatrzymania dokładnej pary, nieobecności helpera i braku
innych konsumentów; pod blokadami ponownie sprawdza piny i publikuje trwały
intent przed usunięciem wyłącznie zatrzymanych kontenerów. Nie używa force.
Po częściowym usunięciu wolno kontynuować tylko ten sam intent z dowodem
nieobecności dokładnych ID. Stare control/state/ledger pozostają bez zmian,
a niezmienny receipt otwiera świeży namespace z nowym ledgerem. Stary
request_id pozostaje zakazany; nie potwierdzamy wyniku starej aktywacji,
drainu ani wykonania fizyki. Następnie obowiązuje zwykły docker-dev up
wybranego checkoutu i nowe jawne żądanie skryptu. Implementacja i kontrola
interpretowana nie zastępują dowodu runtime tej trasy: NOT VERIFIED do
zakończenia rzeczywistego preflight→apply→API→browser.

### Zmiana numeru urządzenia po restarcie WSL

Numer host_device (st_dev) może zmienić się po restarcie WSL. Zwykłe resume
nadal wymaga pełnej zgodności certyfikatu. Nie poprawiaj ręcznie certyfikatu,
ownera ani active. Jawne ponowne poświadczenie wybranej zatrzymanej grupy:

```sh
python3 -B scripts/docker_dev.py --repo-root <checkout> reattest-host-device-volume \
  --source-root <checkout> --attempt <development-uuid> \
  --config-sha256 <compose-sha256> --certificate-sha256 <old-file-sha256> \
  --expected-host-device <current-st_dev>
```

Pierwsze wywołanie jest podglądem; --apply zapisuje operację pod blokadą grupy.
Wymagane są zgodne: inode i ścieżka katalogu, silnik Docker, obraz, zakres i
token właściciela, sentinel i wcześniejszy restart readback. Kontenery muszą
być dokładnymi zatrzymanymi inkarnacjami z receiptu, bez innych konsumentów
storage. Operacja zachowuje inode bind-mountowanego certyfikatu, archiwizuje
stare/nowe bajty i piny w host-device-reattest/<old-sha>/intent.json oraz dopuszcza
ponowienie wyłącznie tych dwóch wersji po przerwanym zapisie. Zmienia tylko
host_device; nie potwierdza nowej symulacji ani nie uruchamia API/solvera.

Jeśli po przerwaniu hosta active wskazuje osieroconą iterację, można dodatkowo
podać --interrupted-iteration <exact-uuid>. Ścieżka jest ograniczona do starej
głównej przestrzeni kontrolnej, nieobecnego helpera, obu zatrzymanych usług i
braku zachowanych runów. Helper odzyskiwania pod operation.lock sprawdza dokładny
hash active i receipt.json, publikuje oddzielny terminal failed-confirmed i
dopiero wtedy usuwa wyłącznie zgodny wskaźnik active. Oryginalny receipt pozostaje
niezmieniony. Nie jest to ogólne odzyskiwanie lease ani trasa dla aktywnego runu.

Po sukcesie użyj zwykłego przypiętego resume-volume --restart-backend.
Inne zmiany tożsamości, aktywny/nieznany konsument albo różne piny blokują zapis.


## Osierocony restart z zachowanymi wynikami

`reconcile-offline-volume` obsługuje zatrzymaną grupę, której osierocona iteracja
pozostała w stanie `starting` albo `restarting-idle-backend`. Dla drugiego stanu
porównuje również identyfikator i czas startu backendu z oryginalnym receiptem.
Sama nazwa stanu nie upoważnia do odzyskania: wymagane są nieobecny helper,
zatrzymana para usług, terminalny owner i procesy, zwolnione rezerwacje oraz
niezmienione dane sesji i dokładne piny konfiguracji.

Odczyt ledgeru zachowuje topologię grupy: osobny starszy wolumen albo
`private/ledger` w kanonicznym wolumenie kontrolnym. Ten sam podkatalog jest
montowany tylko do odczytu podczas kwalifikacji oraz ponownej kontroli pod
`operation.lock`. Nie wolno zastępować go rootem wolumenu ani podkatalogiem
innej roli lub przestrzeni nazw.

Współdzielone wolumeny pakietów, Cargo i pnpm nie są traktowane jako prywatne
wolumeny grupy po uwierzytelnieniu ich dokładnych nazw i etykiet. Kontrola
pakietów nadal odrzuca obcy dostęp do katalogu `groups/<unit_key>` tej grupy,
niezarejestrowane mounty rootu i aliasy przez bind mount. Uwzględnia działające
oraz zatrzymane kontenery. Hash profilu cache i dowód wolumenów wchodzą do planu;
kwalifikacja jest ponawiana pod blokadą przed zatwierdzeniem naprawy.

Najpierw wykonaj podgląd `reconcile-offline-volume` z przypiętymi
`--attempt`, `--config-sha256`, `--source-root`, `--port` i nowym
`--operation-attempt`. Wykonanie wymaga `--apply --expected-plan-sha256`
z dokładnym hashem otrzymanego planu. Operacja zapisuje oddzielny dowód
odzyskania i usuwa wyłącznie zgodny, osierocony wskaźnik `active` pod blokadą.
Zachowuje oryginalny receipt, brak jego terminala, ostatni zweryfikowany pakiet,
sesje i wyniki. Wynik starej iteracji pozostaje `interrupted-retained`; nie jest
to potwierdzenie kompilacji, testu CUDA ani symulacji. Dalsze odtworzenie grupy
konsumuje ten dowód przez `--offline-reconciliation` i nie powtarza starego Solve.

## Authored input after accepted recovery

Accepted live runs retain the authored SceneDocument in the immutable project
definition, with the same versioned execution-input identity as the RunIntent.
The legacy default execution profile used to materialize the Study remains in
the accepted Study and execution catalog; it does not become an authored scene
change merely because the API restarts.

Older definitions may contain that automatically inserted default profile.
Recovery first validates the unchanged scene. Only if its input digest differs
and the profile equals the exact canonical legacy default may recovery project
that field back to absence, and only when the complete input digest then equals
the immutable pin. Explicit profiles, actual input changes, and malformed pins
remain protected. Stored definitions and RunIntent/CAS bytes are never rewritten.

This keeps terminal cancellation visible to the accepted projector: a completed
Stop must publish its terminal command resource and durable journal ACK instead
of leaving the UI at accepted/stopping. It does not replay Solve, release a held
run, or authorize editing historical journals.

## Kolejne recovery po zatrzymaniu odtworzonej grupy

Po potwierdzonym uruchomieniu isolated snapshot użytkownik może utworzyć nową
sesję. Kolejne recovery musi jawnie wskazać jej aktualny held-manual run;
ponowne użycie pierwotnego `start.json` przywróciłoby wcześniejszy model.
`docker-dev-recover-isolated` przyjmuje ostatni argument `successor_snapshot=true`
(CLI: `--successor-snapshot`). Domyślnie nadal odmawia wyboru innego recovery ID.

Ścieżka successor wymaga natywnego admission poprzednika oraz zgodności
`development/current.json` z przypiętym terminalnym receiptem. Zwykły udany start
wymaga identycznego `verified.json`. Po potwierdzonej awarii kolejnego startu
(`failed-confirmed`) verified musi wskazywać swój wcześniejszy, niezmienny
terminal udanego startu i Compose, w tym samym namespace oraz z tymi samymi
katalogami state i user-data. Obie pary dokumentów pozostają przypięte do CAS;
awaria nie jest przedstawiana jako udany start ani dowód braku OWNER.
Ścieżka sprawdza namespace, registry, attempt, konfigurację i dokładne
kontenery, po czym wykonuje dotychczasowe kontrole wszystkich runów, ledgeru,
blokad OWNER/WRITER i spójności SQLite. Kopiuje bieżące dane do nowej namespace;
oryginały, poprzedni registry i `start.json` pozostają zachowane. Piny admission
są ponownie sprawdzane przy publikacji. Podgląd niczego nie uruchamia, a apply
nie odtwarza Solve ani nie kończy runów. Nowy start nadal przechodzi osobną
natywną bramkę. Operacja dotyczy wyłącznie przypiętej, zatrzymanej grupy mastera.
Nowy snapshot ma odrębną generację prywatnego ledgeru, wyprowadzoną z recovery ID;
stary ledger pozostaje zachowany. Kontrole readmission poza tą jawną ścieżką
nadal wymagają udanego terminalnego receiptu.

Jeżeli nieudany start zakończył się przed zapisaniem identyfikatorów usług,
successor nie odgaduje ich z listy kontenerów. Operator musi jawnie przypiąć
typed journal bezpiecznego zatrzymania diagnostycznego API przez parę opcji
`--stopped-predecessor-proof` i `--stopped-predecessor-proof-sha256`.
Adapter przyjmuje tylko `fullmag.docker-preowner-policy-stop.v1` dla tej samej
nieudanej próby: potwierdzone zatrzymanie po odmowie polityki zasobów,
brak bieżącej sesji API i zachowane dane. Sprawdza surowy hash journala,
niezmienny plan oraz udany terminal operacji Stop, a także zachowane piny
OWNER, procesu i provenance. Journal nie stanowi dowodu native drain.

Brakujące lub null identyfikatory terminala uzupełnia wyłącznie w pamięci;
inne pola i istniejące identyfikatory muszą pozostać zgodne. Oryginalne bajty
terminala, current i wszystkich dokumentów dowodu pozostają pinami końcowego
CAS. Każdy ponowny odczyt zatrzymanej pary sprawdza identyfikator, obraz,
fingerprint, `StartedAt` oraz poprawne zakończenie kontenera. Dotychczasowe
bramki natywnego admission, ledgeru i magazynu wszystkich runów nadal obowiązują.
Opcje nie są dostępne dla zwykłego readmission ani udanego terminala.

## Zatrzymanie Linux DEV po OOM procesu API

Gdy proces API został zabity przez OOM, a native owner pozostaje READY,
`scripts/docker_volume_stop_failed.py` może zamknąć dokładnie przypiętą grupę.
Wymaga pełnych ID kontenera i obrazu, SHA256 process-tree oraz jednoznacznej
tożsamości źródeł, storage i prywatnego ledgeru. Pod istniejącymi blokadami
weryfikuje brak API/listenera, terminalność wszystkich katalogów zadań,
zwolnienie lease/rezerwacji i nieobecność pending transactions.

Dwie obserwacje muszą potwierdzić ten sam stan przyjęcia pracy. Porównanie
zachowuje schemat, politykę i historię, node policy, reservations, readiness,
katalogi, lease oraz release proofs. Pomija wyłącznie wskaźnik
`runtime_state.snapshot_sha256`, który zmienia sampler statystyk. Pełne surowe
hashe i obie obserwacje pozostają w receipcie operacji do diagnozy; ich zmiana
nie udaje zmiany stanu zadań. Zmiana readiness, rezerwacji lub dowolnego
innego pola nadal odmawia stopu.

SIGTERM jest wysyłany raz, bez wymuszonego SIGKILL. Sukces wymaga
uwierzytelnionego native drainu, zgodnych inkarnacji i zamkniętych procesów.
`--stop-frontend` zamyka następnie wyłącznie frontend tej samej grupy.
Nie zmienia stanów tasków, nie usuwa wyników ani nie ponawia Solve.
Niepotwierdzony efekt zachowuje lease i dowody do recovery.


### Nieudany prelaunch i archiwizacja przed nową sesją

Jeżeli pierwszy worker Study zakończył się błędem przed solverem, a pozostałe
etapy nadal czekają na jego wynik, zwykły idle stop ani dowód wszystkich
Succeeded nie pasują do tego stanu. Dedykowany tryb wymaga zwolnionych lease
i rezerwacji hosta, dokładnego receiptu wyjścia workera oraz nieprzydzielonych,
zablokowanych zależnościami następców:

```sh
just docker-dev-stop-prelaunch-failure <dev-attempt> <config-sha256> <source-root> <port>
```

Operacja zapisuje intent przed pojedynczym SIGTERM do przypiętej inkarnacji
API, potwierdza jego wyjście oraz graceful drain runtime, następnie sprawdza
zachowane rekordy pod blokadami. Przypina także kod launchera, kontrolera
i helpera. Niepotwierdzony efekt wymaga odczytania tej samej operacji;
nie ponawiaj sygnału ani aktywacji skryptu.

Po potwierdzonym sukcesie zachowaj identyfikator operacji stop i SHA-256
surowego terminalnego receiptu. Tylko ta para pozwala na odtworzenie ze świeżym
stanem i zachowaniem starego store w archiwum:

```sh
just docker-dev-recreate-prelaunch-failure <dev-attempt> <config-sha256> <source-root> <stop-attempt> <raw-stop-terminal-sha256> <port>
```

Dowody są sprawdzane przed lease odtworzenia oraz ponownie pod nim.
Plików kontrolera nie zmieniaj pomiędzy stopem i odtworzeniem. Tryb nie
przywraca starego runu, nie powtarza skryptu ani Compute i nie zmienia
nieudanych lub oczekujących etapów na Succeeded. Nową pracę można przyjąć
dopiero po potwierdzeniu gotowości nowego runtime.


### Wyczerpana pula adresów po poprawnym odtworzeniu

Jeśli archiwizacja zakończyła się sukcesem, a następny start nie utworzył
sieci ani usług przez `all predefined address pools have been fully subnetted`,
recovery wymaga dodatkowych pinów: `--recreation-attempt` i
`--recreation-sha256` dla surowego terminalnego receiptu zakończonego odtworzenia.
Skrypt `scripts/docker_volume_network_failure_reconcile.py` domyślnie wykonuje
wyłącznie podgląd; `--apply` publikuje wynik błędu dopiero po stabilnych
obserwacjach oraz transakcyjnej kontroli zachowanych rekordów.

Tryb wymaga dokładnego powiązania starego development, stopu i native drainu,
archiwum runtime oraz nowej nieudanej próby. Zachowuje poprzednie
`development/current.json` i `development/verified.json`; zapisuje wynik tylko
w receipcie i terminalu nieudanego startu. Nie nadaje prawa odtworzenia
starego runu ani nie uruchamia solvera. Nie łączy się z recovery nieobecnego
helpera ani wznowieniem częściowej publikacji.

Przed następnym startem sprawdź kolizje podsieci i trasy hosta oraz podaj
jawne `--network-subnet`. Nie usuwaj cudzych sieci. Hash receiptu pakietu w
pozostawionej proweniencji jest referencją; recovery sprawdza zgodność commit,
snapshot i tożsamości native ze zarchiwizowanym drainem, a nie deklaruje
ponownego odczytania usuniętego kontenera lub kwalifikacji jego binariów.


### Zachowanie zakończonego natywnie Study przy zablokowanym Running w API

Dla dokładnie przypiętej grupy `just docker-dev-stop-native-terminal <attempt> <config_sha256> <source_root> <port>` zapisuje publiczny stan, wiązanie zaakceptowanej komendy oraz niezmienne rekordy runu. Obsługuje zwolniony startup Study albo pojedynczy HTTP Compute nadal oznaczony jako Accepted, jeśli jego trwała recepta i bieżący dziennik wskazują ten sam run. Pozostała kolejka i aktywne komendy muszą być puste. Odczytowy preflight poprzedza zamknięcie dokładnego procesu API; właściwy natywny odczyt pod blokadą i potwierdzony drain pozostają obowiązkowe. Dla automatycznego HTTP Compute brak `start_release.json` jest przypiętą częścią dowodu. Probe korzysta z tej samej konfiguracji ABI CPU co entrypoint obrazu.

Po sprawdzeniu terminalnego receiptu stopu i jego SHA `just docker-dev-recreate-native-terminal <attempt> <config_sha256> <source_root> <stop_attempt> <stop_sha256> <port>` archiwizuje całą poprzednią przestrzeń runtime i ledgeru przed utworzeniem świeżego środowiska. Dowód zachowania natywnego wyniku służy tej archiwizacji; odtworzenie aktywnego widoku wymaga własnego kontraktu. Przebudowa zachowuje jawny pojedynczy subnet z przypiętego Compose i ponownie sprawdza jego dostępność. Wszystkie kroki pozostają lokalne dla wybranej grupy WSL.
