# Architektura developerska Fullmaga w Docker Compose

Decyzja użytkownika z 17.10.2026: [ADR 0061](../adr/0061-docker-development-build-and-runtime-container.md).
Kontrakt: dwa stałe kontenery aplikacji; backend buduje i uruchamia kod w tej
samej instancji. Dane techniczne procesu budowania są izolowane w nazwanych
wolumenach Docker/BuildKit przypisanych do grupy Compose. Sesje, projekty,
ustawienia i wyniki symulacji pozostają w fizycznym storage Windows. Wdrożenie
i dowody tego wariantu: **NOT VERIFIED**.

## Źródła i usługi

[`compose.dev.yaml`](../../compose.dev.yaml) definiuje projekt wybranego,
zarejestrowanego checkoutu Git. Jedna ścieżka wskazuje główny checkout lub
worktree; oba kontenery dostają jego readonly bind mount.

| Usługa | Odpowiedzialność | Dostęp sieciowy |
| --- | --- | --- |
| `frontend` | Przypięte zależności JS, Next.js dev, HMR i proxy API | Jeden wybrany port `127.0.0.1:<port>:8080` |
| `backend` | Przyrostowy build, potem API, Python DSL i native runtime | Wyłącznie `backend:8081` w prywatnej sieci projektu |

Backend zawiera FDM CPU, FDM GPU, FEM CPU i FEM GPU. Wybór realizacji następuje
w modelu i plannerze, a wymuszone GPU nie ma cichego fallbacku CPU. Obecność
bibliotek i udany build nie dowodzą wykonania ani obsługi dowolnego modelu.

Dostępność wyboru GPU w formularzu wymaga aktualnego potwierdzenia urządzenia
przez backend oraz obsługi wybranej ścieżki FDM/FEM przez runtime. Brak GPU,
nieaktualny odczyt, błąd lub trwające wykrywanie blokują wybór GPU z podaniem
powodu; poprzednia próbka nie zastępuje aktualnego potwierdzenia. CPU pozostaje
dostępne, jeżeli runtime zgłasza obsługę tej ścieżki. Zapisany model lub skrypt
wymuszający GPU zachowuje ten zamiar i otrzymuje błąd dostępności zamiast
niejawnego przełączenia na CPU.

Główny checkout używa `fullmag-master`, a worktree
`fullmag-worktree-<worktree_id>`. Każda grupa ma własną sieć bridge, port,
ustawienia i historię projektów. Docker IPAM przydziela osobną podsieć;
nie używamy sieci external, host network ani stałych adresów IP.
Port wybiera operator. Kolizja kończy się błędem, bez automatycznego
przejęcia portu lub zatrzymania innej grupy.

### Kontrakt wejść developerskich

Launcher rozwiązuje tożsamość checkoutu, grupę Compose i storage danych użytkownika
oraz przekazuje readonly źródła i Git common directory. Przy każdym starcie backend
sam sprawdza aktualne pliki i zależności i przygotowuje zweryfikowany manifest oraz
prywatny cień źródeł w technicznym wolumenie Docker. Kompilator pracuje na spójnym
wejściu danego buildu; zapis kolejnej zmiany w Windows nie miesza plików trwającej
kompilacji. Provenance, logi i receipty buildu również trafiają do wolumenu
technicznego, a nie do hostowego storage sesji. Ten podział po restarcie bez procesu
launchera na hoście pozostaje **NOT VERIFIED**.

Ten sam kontener `backend` wykonuje build i następnie uruchamia aplikację.
Nie powstaje oddzielny kontener `backend-build` dla iteracji dev; nie ma też
TAR-u źródeł ani transferu dużego pakietu przez storage Windows między
kontenerem budującym a runtime. Przygotowanie przypiętego obrazu toolchaina
oraz krótkie narzędzia sprawdzające storage są osobnymi operacjami utrzymania,
a nie dodatkowymi usługami aplikacji.

Backend DEV używa profilu v2 opisanego w ADR 0061: jawnej pary prywatnych
wolumenów Docker pod `/build` i `/opt/fullmag/package`. Cache Cargo, CMake,
CUDA, MFEM, hypre, libCEED, zależności pnpm, staging, pakiety, logi, receipty
i provenance należą do technicznych wolumenów grupy; Docker Desktop przechowuje
je w swoim wewnętrznym dysku danych, a nie w Windows `storage` projektu.
Control volume przechowuje kontrolę operacji, manifesty, receipty i provenance
launchera, a package volume przechowuje kandydata, bieżący pakiet, rollback oraz
metadane rotacji. Warstwy obrazów i ich BuildKit context pozostają w magazynie
obrazu/BuildKit Dockera. Mały hostowy run root może zawierać wyłącznie dane
operacyjne sesji i handoffu; nie jest stagingiem, cache'em ani magazynem
receiptów buildu.
Frontend ma analogiczny nazwany wolumen cache/control. Przygotowanie wolumenów
i migracja technicznych markerów mają dowód częściowy; cold build, API, mounty,
brak zapisu buildu do hosta oraz pomiary restartu i kompilacji przyrostowej
pozostają **NOT VERIFIED**. Stare cache zachowujemy do osobnej kontroli użycia
i rollbacku. Nie usuwaj ani nie przenoś aktywnego cache ręcznie.

Niezmienione pliki cienia zachowują zawartość i metadane potrzebne kompilacji
przyrostowej. Zmiana modułu przebudowuje go oraz rzeczywistych zależnych konsumentów;
zmiana wspólnego typu może wymagać więcej pracy niż zmiana pliku wykonawczego.
Zmiana kodu aplikacji nie przebudowuje automatycznie CUDA, MFEM, hypre ani
libCEED. Zmiana zależności, kompilatora lub flag może unieważnić szerszy cache.
Blokada backendu chroni konkretny trwały wolumen; odrębne grupy mogą kompilować
równolegle. Blokady i rejestry techniczne buildu pozostają w granicy grupy Compose.
Przydziały CPU/RAM/GPU grupy przechodzą przez jej własny ledger
(`group-ledger-v1`, [ADR 0067](../adr/0067-docker-dev-group-isolation.md)):
nazwany wolumen grupy pod `/host-ledger`, operacyjny stan runtime, a nie cache
buildu ani dane sesji. Grupy nie rezerwują zasobów między sobą; chronią je
statyczne budżety `FULLMAG_DEV_*`. Globalny `host-ledger-v1` dotyczy release,
kwalifikacji i managed runtime.

## Polecenia trybu developerskiego

Uruchamiaj je z PowerShella Windows albo Linux/WSL, z Git, Pythonem hosta i
silnikiem Docker Linux. GPU wymaga dostępu NVIDIA z kontenera. Windows używa
contextu `desktop-linux` oraz profilu `windows-folder-v1` na NTFS/ReFS.
Linux/WSL używa bieżącego endpointu Docker i osobnego profilu `linux-native-v1`
na lokalnym ext4/xfs/btrfs; WSL wymaga integracji dystrybucji w Docker Desktop.
Checkout w katalogu domowym WSL jest obsługiwany. Szczegóły:
[konfiguracja Linux/WSL](docker-setup-linux-wsl.md) oraz
[ADR 0064](../adr/0064-docker-development-linux-wsl-host.md).
Host nie potrzebuje Cargo ani CMake. `just` jest potrzebny dla recept i pełnego
`setup_docker.py --check`; launcher Pythona można wywołać bez niego.

### Nowy klon i konfiguracja

Zastąp przykładowe ścieżki własnymi. Storage musi być poza checkoutami.
Dla głównego checkoutu ustaw `$source = $main`; worktree jest opcjonalne.

```powershell
$main = "C:\path\to\fullmag-project\fullmag"
$source = "C:\path\to\fullmag-project\worktrees\my-task"
$storage = "C:\path\to\fullmag-storage"

git clone https://github.com/MateuszZelent/fullmag $main
Set-Location $main
git worktree add $source -b codex/my-task master
python -B scripts/setup_docker.py --repo-root $main --source-root $source --storage-root $storage --port 3197
python -B scripts/setup_docker.py --repo-root $main --check
```

Kreator zachowuje istniejące ustawienia i sekrety `.env`. Pyta o ścieżki i port,
zapisuje `FULLMAG_PROJECT_STORAGE_ROOT` oraz konfigurację hosta w głównym
checkoutcie i waliduje marker storage. Nie buduje, nie uruchamia ani nie
zatrzymuje kontenerów i nie usuwa danych. Nowe worktree tego samego projektu
korzystają z tej konfiguracji przez resolver, bez kopiowania `.env`.

### Start

```powershell
Set-Location $source
just --list
just docker-dev "$source" 3197
```

Start sam przygotowuje toolchain przy pierwszym użyciu lub zmianie przypiętych
zależności, a zgodne obrazy wykorzystuje ponownie. Osobne
`just docker-dev-toolchain` pozostaje opcjonalnym przygotowaniem zależności
lub narzędziem diagnostycznym. Start uruchamia dwie stałe usługi; backend wykonuje swój build
przed API. Otwórz `http://127.0.0.1:3197/workspace`. Brak `--script` oznacza Home,
a nie automatyczny wybór dawnej sesji.

Ponowne `just docker-dev` uzgadnia istniejącą grupę przez `ensure_up`.
Przy zgodnych źródłach, obrazach i konfiguracji wykorzystuje działające usługi
bez restartu; podany skrypt aktywuje istniejącą ścieżką w tej grupie. Zmiana
źródeł uruchamia kontrolowany restart, a zatrzymana grupa jest wznawiana na
podstawie zachowanych receiptów. Niezdrowy backend, nieznany owner lub
niejednoznaczne zasoby nie są przerywane ani przejmowane; wymagają rozstrzygnięcia
stanu. Szczegóły uzgadniania opisuje [przewodnik DEV](docker-volume-development.md).

Po uruchomieniu tej grupy skrypt można aktywować bez ręcznego przepisywania
attemptu i digestu konfiguracji:

```powershell
just docker-dev-script "examples/x.py"
```

Launcher czyta tylko bieżący `development/current.json` oraz trzy zweryfikowane
wskaźniki faz z control volume, wiąże je z dokładnymi kontenerami backendu i
frontendu, sprawdza immutable image, źródło, config digest, prywatną sieć
backendu i loopbackowy port frontendu. Brak jednej pary lub więcej niż jedna
zgodna para kończy się błędem. Jawne `source_root`, `port` i `request_id` można
przekazać jako opcjonalne argumenty recepty, a istniejące ręczne piny pozostają
pod `just docker-dev-script-pinned`.

Na Windows wolne miejsce dla danych technicznych sprawdzaj na dysku danych
Docker Desktop: tam znajdują się named volumes i BuildKit. `FULLMAG_PROJECT_STORAGE_ROOT`
zawiera dane użytkownika i nie powinien być używany jako rezerwuar cache buildu.
Dokładne progi dla cache frontendu, Cargo i toolchaina muszą być sprawdzane przez
launcher; ich zgodność z tym podziałem pozostaje **NOT VERIFIED**. Brak miejsca
powinien przerwać start przed kosztownym buildem i zachować dotychczasowy cache,
sesje oraz wyniki.

Odpowiednik bez `just`:

```powershell
python -B "$main\scripts\docker_dev.py" --repo-root $main up --source-root $source --port 3197
```

### Cykl edycji i przebudowy

Frontend reaguje przez HMR na zapis plików. Tryb obserwacji wynika z mountu
źródeł `/opt/fullmag/source` i jest zapisany w receipcie jako `watch_mode`:

- `native` — bind z ext4, xfs albo btrfs (checkout w Linux/WSL). Zapis generuje
  zdarzenia inotify w kontenerze, więc Watchpack nie odpytuje drzewa;
- `polling` — każdy inny mount, w tym bind z dysku Windows przez 9p, który nie
  dostarcza zdarzeń. Watchpack domyślnie odpytuje co `5000` ms, a lokalne
  `FULLMAG_WATCHPACK_POLLING_MS` dopuszcza `250`–`10000` ms. Wykrycie edycji
  może poczekać do następnego skanu. Każdy działający frontend odpytuje przez
  ten sam serwer 9p, więc bezczynne grupy obciążają też I/O pozostałych.

Po wykryciu zmiany Next przebudowuje zmienione moduły. Docker DEV pomija wygenerowane
katalogi `.fullmag-frontend`, `.next*` i `node_modules`; `app`, `src`, `public`
i `scripts` pozostają obserwowane. Zależności pnpm i cache Next zostają w
nazwanym wolumenie frontendowym; HMR nie buduje backendu ani toolchaina.

Tailwind używa jawnych wzorców plików w `app/globals.css`, ograniczonych do
`app` i `src`. Nowe pasujące pliki i klasy pozostają wykrywane przez HMR.
Wzorce unikają kosztownego wyznaczania globów katalogów na montowaniu Windows;
nie zmieniają źródeł na kopię w kontenerze ani nie obejmują storage/cache.

Backend przebudowuje się po jawnym restarcie. Przed nim zapisz projekt i zakończ
aktywną symulację. W Docker Desktop otwórz backend właściwej grupy i wybierz
Restart; odpowiednik CLI to:

```powershell
docker ps --filter "label=com.docker.compose.project=<compose-project>" --filter "label=com.docker.compose.service=backend"
docker restart <backend-container-id>
docker logs -f <backend-container-id>
```

Usługi Compose DEV ustawiają Docker `json-file` logging z rotacją `10m × 3`
na każdy kontener. Frontend zapisuje szczegóły Next w stałym
`/state/development/next.log` z named volume, z limitem 64 MiB. Nadmiar trafia
do rotowanego logu Docker. Przy następnym starcie, pod blokadą procesu,
pełny log jest atomowo przenoszony do jednej poprzedniej kopii
`next.log.rollback`; niepełny log pozostaje do dalszego dopisywania.
Szczegóły i pozostałe ograniczenia retencji opisuje
[cykl danych](docker-build-storage-lifecycle.md#4-co-sprzątamy-automatycznie-a-co-pozostaje).
Limity logów nie są quota dla cache, wolumenów ani BuildKit.

Każdy start sam sprawdza aktualne zamontowane źródła. Bez zmian używa istniejącego
wyniku; po edycji kompiluje zmienione moduły oraz ich zależnych konsumentów,
zachowując cache. Użytkownik nie odświeża osobno manifestu i nie uruchamia drugiego
kontenera budującego. Frontend pozostaje uruchomiony.

Przy zgodnym obrazie i mountach restart zachowuje ID backendu. Zmiana obrazu lub
mountów może wymagać odtworzenia usługi. Sesje, wyniki i baza grupy pozostają.
Nie zastępuj tego procedurą `down --volumes`, przejęciem obcej grupy ani resetem
ownera. Niepotwierdzone zatrzymanie wymaga kanonicznego recovery; nie jest zgodą
na ponowne uruchomienie aktywnej symulacji. Zachowaj logi i receipty błędu.

### Anulowanie nieudanej próby przed startem workera

Jeżeli natywny owner ma stan `Failed`, oba jego procesy potomne zakończyły się,
a rezerwacja solvera pozostała `Committed` z bramką `Pending`, nie usuwaj
rezerwacji ani pliku ownera ręcznie. Operator może użyć natywnego polecenia:

```text
fullmag-runtime-service --cancel-failed-no-spawn --config <absolute-config.json> --request <absolute-request.json>
```

Polecenie jest przeznaczone do kontrolowanego odzyskania po awarii, nie do
zwykłego uruchamiania symulacji. Żądanie
`runtime_service_failed_no_spawn_cancellation.v1` przypina SHA-256 konfiguracji,
surowych bajtów ownera, kanonicznego claimu, lokalnego lease i rezerwacji oraz
pełną tożsamość ownera i rezerwacji. Należy użyć konfiguracji nieudanej generacji.
Operację wykonuje się wewnątrz backendu właściwej grupy, po potwierdzeniu braku
aktywnego workera; nie inicjalizuje ona nowej generacji runtime.

Pod blokadami startup, launch i istniejącego ownera polecenie sprawdza terminalne procesy potomne,
brak zdarzenia `Started`, brak worker exit receipt i brak innych aktywnych
rezerwacji hosta. Następnie używa kanonicznego Stop, reconciliacji i dowodu
`WorkerNoSpawn`, zachowując historię. Wynik wymaga zadania `Cancelled`, lokalnego
lease `Released` i rezerwacji `Released` z zamkniętą bramką oraz trwałym dowodem.
Dokładnie przypięte częściowe zakończenie można dokończyć tym samym żądaniem;
`Consumed`, nieznany owner i niezgodna tożsamość są odrzucane. Nie jest to
reset, ponowienie Solve ani automatyczne odtworzenie zaakceptowanego skryptu.
Implementacja i regresje źródłowe nie zastępują testu tej operacji w Dockerze.

Zarządzany wrapper dla działającego diagnostycznego backendu:

```text
just docker-dev-cancel-failed-no-spawn <source_root> <backend_id> <image_id> <process_receipt_sha256> <request.json> <request_sha256> false
```

Ostatni argument `false` wykonuje podgląd. `true` wywołuje istniejący operator
natywny dokładnie raz, wewnątrz przypiętego backendu i pod lease operacji grupy.
Wrapper wymaga prywatnego ledgeru DEV, aktualnych immutable development/Compose
receiptów oraz identycznych pinów native. Publikuje trwały wynik natywny przed
oddaniem odpowiedzi i osobny record `fullmag.docker-no-spawn-cancellation.v1`
z referencją `no-spawn-cancellation/current.json`. Niepewne zakończenie zachowuje
lease operacji do inspekcji; nie jest zgodą na ponowienie.

Wrapper przygotowuje image-owned środowisko CPU CUDA ABI tak samo jak
entrypoint i sprawdza zależności loadera przed przyjęciem operacji oraz przed
wywołaniem native. Historyczny błąd tego wrappera, w którym loader odmówił
załadowania `libcuda.so.1`, ma wąską ścieżkę technicznego zakończenia operacji:
do recepty po argumencie `apply` przekazuje się attempt i SHA niepewnego
receiptu. Wymaga ona rozpoznanej wersji wykonawcy, dokładnego błędu loadera,
niezmienionych danych runu i niewykorzystanej bramki pod istniejącymi lockami.
Zachowuje oryginalny receipt oraz żądanie; tylko pierwotny helper zwalnia swój
lease po publikacji terminala technicznego. Nie rozlicza zadania ani native
zasobów i nie obejmuje innych niepewnych zakończeń operatora.

Po potwierdzonej cancellation, dla profilu Linux z zachowanym niepustym store,
`docker-dev-stop-failed` ma osobną ścieżkę
`native-runtime-supervision-linux-retained`. Sprawdza natywny wynik, wszystkie
lease/rezerwacje, pełny bounded inventory runów, immutable CAS i runy manualne
bez release/claim. Zatrzymuje wyłącznie przypiętą prywatną parę usług; zachowuje
owner `Failed` oraz receipt `shutdown_unknown`, nie przedstawia ich jako drain.
Recreate ponownie sprawdza ten sam dowód i zachowuje state/user-data. Poprzednia
ścieżka Windows i klasyfikator API exit-101 mają niezmienione warunki.

Przy braku aktualnej próbki compute-node przed spawnem scheduler zachowuje
typ `ComputeNodeSampleNotCurrent` i szczegółową przyczynę. Po ograniczonym retry
oddaje sterowanie pętli jako `WorkerLaunchDeferred`, zwalniając tylko slot
supervisora. Claim, Start, lease i niewykorzystany permit pozostają bez zmian;
drain i cancellation mogą być obsługiwane. Nieaktualna próbka nadal blokuje
spawn; błędy konfiguracji, ownera i uszkodzonego rekordu pozostają fatalne.

### Kontrolowane odtworzenie terminalnego failed run

Jeżeli własny backend zakończył się terminalnym błędem, a jego usługi są
zatrzymane i wszystkie należące do niego rezerwacje native zostały zwolnione,
można użyć wyłącznie wolumenowej trasy z dokładnym pinem próby i konfiguracji.
`docker-dev-recreate --direct-development` jest wycofane i bieżący launcher
odrzuca tę trasę. `docker-dev-resume` służy do wznowienia potwierdzonej,
zatrzymanej próby; `docker-dev-recreate-volume` służy do odtworzenia usług przy
zmianie obrazu lub mountów. Obie komendy wymagają tego samego zarejestrowanego
checkoutu, exact config SHA i portu:

```powershell
just docker-dev-resume `
  $attempt $configSha256 $source 3197 false
just docker-dev-recreate-volume `
  $attempt $configSha256 $source 3197 false
```

Resume zachowuje istniejące usługi i wolumeny; `restart_backend=true` można
ustawić tylko dla zatrzymanego, dokładnie przypiętego backendu. Recreate-volume
zachowuje named build/package/frontend/control volumes i dane sesji, a
`fresh_state=true` tworzy nowy root sesji wyłącznie w zwykłej, jawnie wybranej
recreacji. Żadna z tych komend nie uruchamia osobnego `up`, kontenera budującego,
startupowego POST ani Solve.

Ta ścieżka nie jest recovery nieznanego ownera. Nie używaj jej dla aktywnego
runu, niepotwierdzonego zatrzymania, obcej grupy ani niewolnych rezerwacji.
Nie dodawaj `--recover-idle-failure`, `--assembly-receipt` ani skryptu startowego;
nie resetuje ownera, nie usuwa cache i nie tworzy nowej grupy. W razie błędu
tożsamości, CAS, provenance lub storage pozostaje fail-closed, z zachowanym
receiptem i diagnostyką. Stara recepta hostowego receipt DEV pozostaje ścieżką
odrzuconą, a nie instrukcją kompatybilności.

### Logi i gotowość

Docker Desktop pokazuje kompilację i późniejszy start API w logu tej samej
usługi `backend`. Można również znaleźć jej ID i śledzić stdout/stderr:

```powershell
docker ps --filter "label=com.docker.compose.project=<compose-project>"
docker logs -f <backend-container-id>
```

Faza budowania nie oznacza gotowości do symulacji. Po udanym Make wrapper
sprawdza artefakty i provenance, a następnie uruchamia istniejący nadzór API
oraz native runtime. Błąd buildu zachowuje log i receipt; nie uruchamia API
z częściowo opublikowanym pakietem. Home może być dostępny podczas budowania.
Stan `ready` wymaga rzeczywistego health/readiness, nie samego otwartego portu.

### Debugger frontendu DEV

Frontend DEV domyślnie włącza Node Inspector, a jego adres zapisuje w logu
kontenera. Debugger nasłuchuje wyłącznie na loopback wewnątrz frontendu; Compose
nie publikuje dodatkowego portu na Windows. Uruchomienie Next.js nie czeka na
podłączenie debuggera. HMR działa również bez podłączonego klienta.

Inspector służy do diagnostyki serwera Node.js/Next.js: stosu wywołań, zmiennych,
CPU i pamięci. Klient debuggera musi mieć dostęp do wnętrza kontenera. Kod
działający w przeglądarce można niezależnie sprawdzać przez F12. Debugowanie
solverów Rust/CUDA jest osobną ścieżką. Obrazy i procesy release nie włączają
Inspectora. Kontrakt wymaga jeszcze potwierdzenia na uruchomionym obrazie DEV.

### Pierwszy start i następne restarty

Przy pierwszym starcie backend po buildzie czeka na wydanie hostowego certyfikatu
storage i potwierdzenie prób odczytu/zapisu. Dopiero potem uruchamia API. Dla live
dev certyfikat zawiera wąską delegację zaufanego buildera przypisaną do obrazu,
toolchaina i grupy. Przy późniejszym restarcie nadal sprawdzany jest nowy rzeczywisty
receipt/provenance i hash binarki; sam zapis zmiany kodu nie wymaga nowej zgody
hosta dla niezmienionego storage. Ścieżka release zachowuje dokładne hostowe piny.
Szczegóły i zakres delegacji określa ADR 0061; wdrożenie pozostaje **NOT VERIFIED**.

Przed pierwszym montowaniem nowego katalogu `/state` natywny launcher Windows
tworzy dokładnie `runs/docker-all/session-store/runtime-services` oraz wykonuje
rzeczywistą próbę zapisu i usunięcia pliku w końcowym katalogu. Odrzuca wpisy
istniejące i punkty reparse; nie przejmuje danych, nie wykonuje rekursywnego
`chown` ani migracji starego stanu. Dzięki temu Docker nie tworzy tych katalogów
jako `root:root` `0755`, a UID usługi może utworzyć `WRITER.lock`. Są to katalogi
danych runtime sesji na Windows; cache, staging, pakiet i logi buildu nadal
pozostają w nazwanych wolumenach Docker.

## Skrypt symulacji jako parametr startu

Trzeci argument recepty `just docker-dev` wybiera plik w tym samym checkoutcie:

```powershell
just docker-dev "$source" 3197 "examples/fem_relax_gpu_smoke.py"
# Bez just:
python -B "$main\scripts\docker_dev.py" --repo-root $main up --source-root $source --port 3197 --script "examples/fem_relax_gpu_smoke.py"
```

Ścieżka względna jest rozwiązywana względem `$source`. Absolutna ścieżka Windows
również musi należeć do tego checkoutu. Launcher zapisuje ścieżkę, hash treści
i request ID, a backend publikuje model jako aktywny w Workspace.

Zwykły skrypt uruchamia Solve automatycznie. `study.wait_for_solve(True)`
przygotowuje model i siatkę oraz czeka na Compute; przykładem jest
`examples/fem_de_smoke_numeric.py`. Restart backendu nie tworzy niejawnego
nowego polecenia Solve.

Typowane odrzucenie modelu przez API (`400`/`422`) zostawia API/runtime gotowe,
a polecenie startowe kończy błędem i zapisuje wynik `rejected` z provenance.
Po poprawnej atestacji i trwałym zapisaniu markera `started`, HTTP `409`,
błąd serwera lub utrata transportu oznaczają wynik aktywacji `unknown`.
API i native runtime pozostają nadzorowane; marker blokuje ponowny POST i Solve.
Stan skryptu oraz jego diagnostyka trafiają osobno do receipt procesu i logu.
Launcher nadal zgłasza nieudaną kwalifikację skryptu: gotowe API nie dowodzi
wykonania symulacji. Nie wolno usuwać markera ani powtarzać nieznanej aktywacji.

Niezgodność źródeł, provenance, polityki, tożsamości lub kontraktu odpowiedzi
pozostaje błędem startupu. Nie jest traktowana jako zwykłe odrzucenie modelu.

`examples/permalloy_layer_cofeb_rings_relax_300nm.py` pokazuje wąski,
źródłowo wsparty przypadek dwóch rozłącznych ciał: aktywną warstwę permalloy
oraz aktywny `top_ring`, dające odpowiednio swept `prism6` i odłączone `tet4`
z własnymi materiałami. Blok `bottom_ring` i jego konfiguracja są w bieżącym
skrypcie zakomentowane, więc dokument nie może opisywać dwóch aktywnych
CoFeB rings. Python `_disconnected_mixed_p1_pair` rozpoznaje tylko parę Box +
translated annulus, a `_validate_authored_mixed_p1_scope` wybiera dla niej
wariant dwóch materiałów; nie jest to bezwarunkowe ograniczenie liczby materiałów.
Planner `validate_mixed_p1_v2_execution_scope` utrzymuje dodatkowe bramki
strict/double, explicit FEM/CPU-or-GPU, dodatnią przerwę, body-owned P1 i brak
fallbacku. Source contract może więc opisać ten bounded case, lecz dokładny
GPU run, device identity, native operator, CPU/GPU parity i kwalifikacja
fizyczna nadal pozostają **NOT VERIFIED**. Sam planner lub source test nie jest
dowodem wykonania rings.

## Dane i wersje

Dokładne lokalizacje, etapy toolchain/aplikacja, procedura kontroli miejsca
i rzeczywiste granice automatycznego sprzątania:
[Docker DEV — budowanie, zapis danych i retencja](docker-build-storage-lifecycle.md).

| Dane | Trwałe miejsce |
| --- | --- |
| Źródła | Wybrany checkout Windows, readonly bind; frontend HMR |
| Toolchain, zależności, cache kompilatorów, staging i pakiet dev | Nazwane wolumeny Docker grupy Compose oraz BuildKit; nie hostowy `storage` |
| Manifesty wejściowe, konteksty, logi buildu, receipty i provenance | Techniczne wolumeny Docker grupy Compose; nie Windows storage |
| Kontrola runtime i metadata usług technicznych | Wydzielony podwolumen Docker grupy Compose; nie katalog sesji użytkownika |
| Sesje, modele, wyniki i logi symulacji | Fizyczny storage Windows, mount `/state` |
| Ustawienia, ostatnie projekty i historia grupy | `storage/user-data/<compose-project>/workspace.db`, mount `/user-data` |
| Przydziały CPU/RAM/GPU grupy | Ledger grupy `group-ledger-v1` w jej nazwanym wolumenie Docker, mount `/host-ledger`; nie cache buildu. Release i kwalifikacja używają `host-ledger-v1` |

### Granica zapisu i kontrola wzrostu danych technicznych

Launcher powinien tworzyć oraz przypinać do jednej grupy Compose osobne
przestrzenie techniczne dla backendowego `/build`, opublikowanego pakietu
`/opt/fullmag/package`, wspólnego control/provenance, runtime-control oraz
frontendowego cache i stanu developmentu. Ich nazwy, klucze profilu i marker
właściciela wynikają z projektu Compose oraz worktree; operator nie wskazuje
drugiego hostowego katalogu jako zamiennika. `subpath` może izolować frontend od
backendowych receiptów, ale nie zmienia własności ani trwałości wolumenu.

BuildKit przechowuje warstwy obrazu i cache zależności na dysku danych Docker
Desktop. Named volumes przechowują wynik przyrostowego buildu, staging, pakiet,
logi, receipty i provenance do czasu kontrolowanej retencji. Samo zatrzymanie
lub usunięcie kontenera nie powinno usuwać tych danych; ich usunięcie wymaga
jawnej operacji lifecycle dla dokładnej grupy, po sprawdzeniu aktywnych runów,
mountów, lease i możliwości rollbacku. `docker compose down --volumes`, globalny
prune oraz ręczne kasowanie katalogów nie są procedurą codziennego restartu.

Każdy nowy build używa klucza wejścia i istniejącego cache. Zastąpiony pakiet
można usunąć dopiero po trwałym zapisaniu nowego pakietu, receiptów rotacji i
dowodu, że żaden run, sesja, rollback ani proces go nie referuje. Cache
kompilatorów i zależności pozostaje, bo jego ponowne pobranie lub przebudowa
generuje duplikaty i wydłuża następny start. Automatyczna retencja technicznych
wolumenów, jej pomiar rozmiaru oraz bezpieczne odtworzenie pozostają
**NOT VERIFIED** w obecnym wariancie.

Backend nie udostępnia frontendowi host ledgeru, GPU ani accepted store.
Osobne grupy nie oznaczają osobnych fizycznych GPU. Zmiana generacji nadal
wymaga zgodnej polityki, rzeczywistego probe i zwolnionych rezerwacji;
`Tentative`, `Committed`, `Quarantined` albo niepotwierdzony owner blokują
przejęcie. Nie usuwamy historii rezerwacji ani nie uznajemy jej za aktywne
zadania, jeżeli zwolnienia mają zweryfikowane trwałe dowody.

`FULLMAG_RUNTIME_PACKAGE_ROOT` wskazuje zweryfikowany pakiet dla discovery
capabilities; nie wolno utożsamiać go ze storage sesji. Błąd, timeout i
utrata obserwacji zachowują fail-closed admission oraz dowody recovery.
Szczegóły: [ADR 0049](../adr/0049-native-runtime-owner-control.md),
[storage Windows](../adr/0059-docker-desktop-windows-session-storage.md) oraz
[accepted FEM GPU](../adr/0060-accepted-fem-gpu-docker-workspace.md).

### Retencja pakietów developerskich

Korekta z 20.10.2026 odracza automatyczną retencję z decyzji 17.10.2026:
start zachowuje bieżący pakiet i wszystkie historyczne rollbacki, raportując
`phase=retention state=deferred`. Pełne hashowanie starych kopii nie blokuje API.
Obowiązkowa walidacja aktualnego pakietu pozostaje. Każda nowa publikacja może
dodać pełny backup; obecnie brak limitu liczby kopii i osobnej udostępnionej
operacji konserwacyjnej. Istniejący preflight mierzy build/cache volume;
nie gwarantuje miejsca w osobnym package volume. Przed kolejnym buildem
należy ocenić również miejsce dla pakietów i rollbacków. Szczegóły:
[ADR 0061](../adr/0061-docker-development-build-and-runtime-container.md#korekta-20102026--retencja-poza-startem-api).

Zachowana w źródłach funkcja retencji wymaga blokady cache i trwałej,
zweryfikowanej publikacji nowego pakietu, lecz nie jest wywoływana przez start.
Jej kontrakt archiwum retired zachowuje tylko receipt i
rotację, bez kolejnych kopii pełnego build logu. Zostawia najwyżej 8 archiwów
i 64 MiB łącznego rozmiaru plików; zachowuje najnowsze według zapisanego
`retired_at_ns` (dla starszych wpisów kolejność wyznacza czas pliku manifestu).
Archiwa legacy z logiem są usuwane, jeśli przekraczają ten limit; log jest
sprawdzany hashem, gdy pozostaje w zachowanym archiwum. Nieznane, niespójne lub
używane dane pozostają z diagnostyką. Niepowodzenie sprzątania nie unieważnia
poprawnie opublikowanego pakietu. Limity tej funkcji nie są obecnie egzekwowane
przez ścieżkę startu; nie usunięto istniejących archiwów ani backupów.

Retencja nie obejmuje cache Cargo/CMake/CUDA, źródeł, sesji, projektów, wyników,
bazy grupy ani historii rezerwacji. Restart używający aktualnego pakietu nie
tworzy kolejnej kopii. Po zmianach źródeł kontrola miejsca na nowego kandydata
powinna zgłosić niedostatek w konkretnym cache przed kosztownym buildem, jeśli
rozmiar poprzedniego zweryfikowanego pakietu już wykazuje brak miejsca. Jest to
oszacowanie, nie gwarancja rozmiaru przyszłego buildu.

Automatyczna ścieżka wymaga regresji retencji oraz dowodu z działającego
kontenera; do ich uzyskania pozostaje **NOT VERIFIED**.

Wersje bibliotek deklaruje repozytorium:

- CUDA, CMake, MFEM, hypre, libCEED: `docker/fem-gpu/Dockerfile` i obrazowy
  `/opt/fullmag-deps/share/fullmag/dependency-versions.json`;
- Rust: `rust-toolchain.toml`, `Cargo.toml`, repozytoryjny `Cargo.lock`;
- Python: `packages/fullmag-py/pyproject.toml`;
- frontend: `apps/control-room/package.json`, repozytoryjny `pnpm-lock.yaml`.

Nie instaluj osobnego hostowego toolchaina ani nie zmieniaj bibliotek ręcznie
w działającym kontenerze. Profil dev korzysta z Cargo `backend-dev`; release
przygotowuje osobny, gotowy artefakt/obraz z zamrożonych wejść i własną
kwalifikacją. Release nie jest domyślnym sposobem codziennej edycji.

## Kontrolowane odzyskanie zasobów po awarii workera

Zwykły restart nie zwalnia rezerwacji, jeśli worker utracił trwały dowód
zakończenia. W takiej sytuacji operator może użyć jawnie przypiętej procedury
z [ADR 0062](../adr/0062-worker-orphan-namespace-teardown.md):

```sh
just docker-dev-recover-orphan PINS_JSON CONTAINER_ID COMPOSE_PROJECT DIAGNOSTICS_ROOT
```

`PINS_JSON` to uprzednio sprawdzony plik tożsamości runu, zadania, próby,
rezerwacji, lease, ownera, obrazu i współdzielonego ledgera. Nie jest to
szablon do wypełnienia przypadkowymi identyfikatorami. `CONTAINER_ID` musi
być pełnym identyfikatorem 64-znakowym; `COMPOSE_PROJECT` wskazuje dokładną
grupę checkoutu. `DIAGNOSTICS_ROOT` musi odpowiadać katalogowi
`/state/diagnostics` tego backendu na hoście. Narzędzie odrzuca inne mounty,
niezgodne digesty oraz aktywnych klientów współdzielonego ledgera.

Procedura wykonuje próby tylko do odczytu, przygotowuje natywny intent,
zatrzymuje dokładnie wskazany backend i potwierdza zakończenie jego prywatnej
przestrzeni procesów. Osobny, krótkotrwały serwis `backend-recovery` w tej
samej grupie nie uruchamia buildu, API ani solvera; nie ma sieci, GPU ani
publikowanych portów. Wyłącznie natywne CLI zapisuje dowód i zwalnia zasoby.
Historia runu i zużyty token startu pozostają; Solve nie jest ponawiany.

Pin `device_release` przed zatrzymaniem zawiera dokładny `resource_id`,
`mapping_sha256` i opcjonalny `gpu_uuid`, bez pola `mapping_detached`.
Nie poświadcza przyszłego odłączenia. Dopiero rzeczywista obserwacja
`exited` / PID 0 / `FinishedAt` prywatnego kontenera pozwala adapterowi
zapisać `mapping_detached: true` w manifeście i atestacji zakończenia.
Istniejące niezmienne piny starszej wersji z tym polem wolno odczytać
wyłącznie podczas replayu już zakończonego namespace i zachowanej atestacji;
nie uprawniają one do rozpoczęcia nowej procedury zatrzymania.

Jeśli administracyjne prepare nie powiodło się przed potwierdzeniem prepare
lub zatrzymaniem kontenera, po diagnozie operator może jawnie wznowić tę samą
próbę. Ostatni parametr recepty włącza wyłącznie tę ścieżkę:

```sh
just docker-dev-recover-orphan PINS_JSON CONTAINER_ID COMPOSE_PROJECT DIAGNOSTICS_ROOT true
```

Request i pins muszą pozostać identyczne. Nowe dowody prób trafiają do
`pre-stop-resume/<attempt-uuid>` obok wcześniejszych rekordów. Dla Windows
każdy kontener administracyjny uzyskuje świeży grant swojego namespace przez
pełne próby storage; nie przejmuje grantu poprzedniego kontenera. Brak dowodu
wyłącznego dostępu lub Failed ownera blokuje rotację. Procedura nie wykonuje
Solve ani nie usuwa zapisanej historii. Rzeczywista kwalifikacja tej ścieżki
pozostaje **NOT VERIFIED** do zakończenia testu na Dockerze.

Nie zmieniaj UUID requestu ani pliku pins przy ponowieniu po przerwaniu.
Wynik `unknown` wymaga uzgodnienia z zachowanymi dowodami; nie wolno usuwać
blokad ani wpisywać ręcznie stanu `stopped`. Po potwierdzonym odzyskaniu
stary run pozostaje archiwalny. Kolejny zwykły start powinien użyć nowego
run namespace, zachowując ustawienia grupy, cache, sesje i wyniki; wycofanie
starych kontenerów i sieci wymaga osobnej kontroli ich tożsamości i użycia.
Narzędzie odzyskiwania nie wykonuje tej operacji automatycznie.

Regresje kontraktu i adaptera nie zastępują wykonania tej procedury na żywo.
Kwalifikacja runtime pozostaje **NOT VERIFIED**, dopóki nie ma dowodu
zakończenia, zwolnienia dokładnej rezerwacji i poprawnego nowego startu.

## Generowanie OpenAPI i klienta TypeScript

Dla codziennego developmentu użyj PowerShella albo Linux/WSL z wybranego checkoutu:

```powershell
just docker-dev-codegen "<wybrany-checkout>"
# Równoważna recepta:
just generate-api-openapi "<wybrany-checkout>"
```

Obie usługi tej grupy muszą już działać, a backend musi odpowiadać bieżącym
źródłom. Polecenie nie buduje i nie uruchamia nowych kontenerów: eksportuje
OpenAPI istniejącą binarką `backend`, a generatory uruchamia w `frontend`.
Staging jest efemeryczny w jego wolumenie development; sukces zapisuje receipt
pod `/opt/fullmag/control/backend/codegen/openapi-v2/`. Powtórzenie tych samych
wejść używa tego samego klucza receiptu. Do checkoutu wracają wyłącznie cztery
wersjonowane pliki API. Przed publikacją ponownie sprawdzane są źródła,
kontenery, obrazy i backing wolumenów.

Zmiana źródeł wymaga najpierw zwykłego restartu backendu tej grupy.

Codegen wiąże się z wejściami buildu backendu: wymaga zgodności commita,
`source_snapshot_sha256` i natywnej tożsamości źródeł z receiptem pakietu, a
nie pełnego `source_digest` drzewa. Snapshot wyklucza ścieżki nieużywane przez
runtime (`LIVE_RUNTIME_STATUS_EXCLUSIONS` i `LIVE_NON_RUNTIME_*` w
`docker/all-in-one/backend_source.py`: m.in. `docs/**`, `apps/control-room/**`,
`scripts/test_*`, `*.md`, `*.source-map.json`), a backend po samej zmianie
takich plików weryfikuje istniejący pakiet zamiast go przebudowywać. Pełny
skrót drzewa różniłby się wtedy trwale, choć binarka i OpenAPI są aktualne.
Na hoście WSL z Docker Desktop źródło bind mountu ma postać
`/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/<dystrybucja>/<sha256>`;
codegen potwierdza je przez ten sam inode aliasu
`/mnt/wsl/docker-desktop-bind-mounts/…` i wybranego checkoutu. Zapieczętowane (bez bitów zapisu) binarki pakietu współdzielonego
między grupami mogą mieć wiele hardlinków; ich zawartość jest sprawdzana
skrótem z receiptu. Opublikowane pliki zachowują poprzedni tryb (domyślnie
`0644`), aby usługa `frontend` mogła je czytać. Timeout
klienta Docker nie dowodzi zakończenia zdalnego procesu generatora; receipt
awarii zachowuje identyfikator stagingu i potrzebę uzgodnienia stanu zamiast
usuwać potencjalnie używane dane. `generate-api-openapi-legacy` zachowuje
odrębną trasę wyłącznie dla jawnych bramek release/CI. Nowa trasa ma regresje
źródeł; jej rzeczywiste wykonanie w usługach pozostaje **NOT VERIFIED** do
zakończenia odbioru runtime.

## Warunki odbioru

Nowy wariant wymaga rzeczywistego potwierdzenia:

1. Dwa stałe kontenery w grupie checkoutu; ten sam backend buduje i uruchamia API.
2. Jeden log backendu, ponowne użycie cache i kontrolowany restart ze stałym ID.
3. Widoczny Home, API pod adresem frontendu oraz HMR po edycji Windows.
4. Start `.py`: aktywny model, auto Solve i osobno `wait_for_solve`.
5. Trwałość bazy grupy, sesji i wyników po restarcie.
6. Rzeczywiste wykonanie CPU/GPU oraz poprawne artefakty; build nie wystarcza.
7. Izolacja dwóch grup i brak obejścia wspólnych rezerwacji sprzętu.

Wcześniejszy backend ze źródeł `4b3a89501c3ec8cd2bb2fc9aaba34ad1a0de7900`
zbudował się poprawnie; ten wynik nie kwalifikuje jeszcze nowego cyklu
jednego kontenera. Wcześniejsze próby przeglądarkowe i HMR dotyczą starej
orkiestracji. Wykonanie FEM GPU i pełnego wariantu rings, w tym odkomentowanej
geometrii `bottom_ring`, pozostaje **NOT VERIFIED**.
Wymagane CI/review/merge oraz dostępność prywatnego runnera managed FEM są
osobnymi bramkami. Szczegółowe dowody i ograniczenia trafiają do checkpointu
zadania w rozwiązanym storage, nie do rosnącej historii komend w tym przewodniku.

## Kolejność wdrożenia — stałe numery zadań

1. Zapisać uzgodnioną architekturę.
2. Zdefiniować w Compose dwa serwisy, źródła, storage, sieć i port.
3. Przygotować obraz narzędziowy.
4. Podłączyć wybór checkoutu/worktree i przygotowanie źródeł backendu.
5. Uruchomić trwały cache kompilacji backendu.
6. Zbudować pełny backend: FDM/FEM, CPU/GPU.
7. Uruchomić frontend Next.js z montowanych źródeł.
8. Uruchomić oba kontenery w grupie checkoutu, z osobną siecią i portem.
9. Sprawdzić widoczny Home i komunikację UI–API.
10. Potwierdzić HMR po edycji pliku w Windows.
11. Potwierdzić przyrostową przebudowę backendu bez utraty cache.
12. Sprawdzić parametr skryptu, aktywację modelu, wykonanie GPU i zapis wyników w Windows.
13. Uzupełnić instrukcję, przeprowadzić wymagane CI/review i scalić na `master`.

Aktualizacje postępu używają „Zadanie X/13”. Numery oznaczają etapy;
nie są deklaracją ukończenia. Zmiana z ADR 0061 wymaga ponownego sprawdzenia
cyklu start/restart, zanim wcześniejsze dowody zostaną do niego przypisane.

### Wznowienie samego frontendu po udanym starcie

`just docker-dev-resume <start-attempt> <config-sha256> <source-root> <port>` może wznowić zatrzymany frontend także wtedy, gdy historyczny start zakończył się `succeeded`. Launcher sprawdza dokładne incarnation ID, project, image, source i mounty obu usług oraz wymaga działającego backendu i zatrzymanego frontendu. Startuje wyłącznie frontend; nie zmienia historycznego receipt, nie restartuje backendu i nie powtarza aktywacji ani Solve. Ścieżkę odtworzono po błędzie V8 heap frontendu; wynik zapisywany jest jako nowa operacja `resume`.
