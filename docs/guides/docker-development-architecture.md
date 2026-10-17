# Architektura developerska Fullmaga w Docker Compose

Decyzja użytkownika z 17.10.2026: [ADR 0061](../adr/0061-docker-development-build-and-runtime-container.md).
Kontrakt: dwa stałe kontenery aplikacji; backend buduje i uruchamia kod w tej
samej instancji. Wdrożenie i dowody tego wariantu: **NOT VERIFIED**.

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

Główny checkout używa `fullmag-master`, a worktree
`fullmag-worktree-<worktree_id>`. Każda grupa ma własną sieć bridge, port,
ustawienia i historię projektów. Docker IPAM przydziela osobną podsieć;
nie używamy sieci external, host network ani stałych adresów IP.
Port wybiera operator. Kolizja kończy się błędem, bez automatycznego
przejęcia portu lub zatrzymania innej grupy.

### Kontrakt wejść developerskich

Launcher rozwiązuje storage i tożsamość checkoutu oraz przekazuje readonly źródła
i Git common directory. Przy każdym starcie backend sam sprawdza aktualne pliki
i zależności i przygotowuje zweryfikowany manifest oraz prywatny cień ext4.
Kompilator pracuje na spójnym wejściu danego buildu; zapis kolejnej zmiany
w Windows nie miesza plików trwającej kompilacji. Provenance opisuje rzeczywiste
wejście tego buildu, także po restarcie bez procesu launchera na hoście.

Ten sam kontener `backend` wykonuje build i następnie uruchamia aplikację.
Nie powstaje oddzielny kontener `backend-build` dla iteracji dev; nie ma też
TAR-u źródeł ani transferu dużego pakietu przez storage Windows między
kontenerem budującym a runtime. Przygotowanie przypiętego obrazu toolchaina
oraz krótkie narzędzia sprawdzające storage są osobnymi operacjami utrzymania,
a nie dodatkowymi usługami aplikacji.

Cache Cargo i osobne katalogi CMake FDM/FEM leżą na trwałym ext4 przypisanym do
checkoutu/profilu. Nie zależą od UUID kolejnego uruchomienia. Niezmienione pliki
cienia zachowują zawartość i metadane potrzebne kompilacji przyrostowej.
Zmiana modułu przebudowuje go oraz rzeczywistych zależnych konsumentów;
zmiana wspólnego typu może wymagać więcej pracy niż zmiana pliku wykonawczego.
Zmiana kodu aplikacji nie przebudowuje automatycznie CUDA, MFEM, hypre ani
libCEED. Zmiana zależności, kompilatora lub flag może unieważnić szerszy cache.
Blokada backendu chroni konkretny trwały cache; odrębne grupy mogą kompilować
równolegle. Hostowy heavy lock służy przygotowaniu obrazów i receiptów, nie
obejmuje kompilacji w uruchomionej usłudze. Przydział fizycznego GPU nadal
przechodzi przez wspólny host ledger.

## Polecenia trybu developerskiego

Uruchamiaj je z natywnego PowerShella Windows, z Git, natywnym Pythonem i Docker
Desktop w trybie kontenerów Linux. GPU wymaga obsługi NVIDIA w Docker Desktop.
WSL może edytować źródła; obecny launcher odrzuca WSL jako ścieżkę startową.
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
just docker-dev-toolchain
just docker-dev "$source" 3197
```

Toolchain przygotowuje się przy pierwszym użyciu lub zmianie przypiętych
zależności. Start uruchamia dwie stałe usługi; backend wykonuje swój build
przed API. Otwórz `http://127.0.0.1:3197/workspace`. Brak `--script` oznacza Home,
a nie automatyczny wybór dawnej sesji.

Odpowiednik bez `just`:

```powershell
python -B "$main\scripts\bootstrap_docker_toolchain.py" --repo-root $main --direct-development
python -B "$main\scripts\docker_dev.py" --repo-root $main up --source-root $source --port 3197
```

### Cykl edycji i przebudowy

Frontend reaguje przez HMR na zapis plików Windows. Watchpack domyślnie używa
pollingu `5000` ms; lokalne `FULLMAG_WATCHPACK_POLLING_MS` dopuszcza
`250`–`10000` ms. Wykrycie edycji może więc poczekać do następnego skanu,
po którym Next przebudowuje zmienione moduły. Docker DEV pomija wygenerowane
katalogi `.fullmag-frontend`, `.next*` i `node_modules`; `app`, `src`, `public`
i `scripts` pozostają obserwowane. Zależności pnpm i cache Next zostają na
ext4; HMR nie buduje backendu ani toolchaina.

Backend przebudowuje się po jawnym restarcie. Przed nim zapisz projekt i zakończ
aktywną symulację. W Docker Desktop otwórz backend właściwej grupy i wybierz
Restart; odpowiednik CLI to:

```powershell
docker ps --filter "label=com.docker.compose.project=<compose-project>" --filter "label=com.docker.compose.service=backend"
docker restart <backend-container-id>
docker logs -f <backend-container-id>
```

Każdy start sam sprawdza aktualne zamontowane źródła. Bez zmian używa istniejącego
wyniku; po edycji kompiluje zmienione moduły oraz ich zależnych konsumentów,
zachowując cache. Użytkownik nie odświeża osobno manifestu i nie uruchamia drugiego
kontenera budującego. Frontend pozostaje uruchomiony.

Przy zgodnym obrazie i mountach restart zachowuje ID backendu. Zmiana obrazu lub
mountów może wymagać odtworzenia usługi. Sesje, wyniki i baza grupy pozostają.
Nie zastępuj tego procedurą `down --volumes`, przejęciem obcej grupy ani resetem
ownera. Niepotwierdzone zatrzymanie wymaga kanonicznego recovery; nie jest zgodą
na ponowne uruchomienie aktywnej symulacji. Zachowaj logi i receipty błędu.

### Kontrolowane odtworzenie terminalnego failed run

Jeżeli własny backend zakończył się terminalnym błędem, a jego usługi są
zatrzymane i wszystkie należące do niego rezerwacje native zostały zwolnione,
można jawnie odtworzyć ten sam stan przez `docker-dev-recreate`. Polecenie
wymaga dokładnego receiptu tego runu oraz dokładnego SHA-256 poprzedniej
konfiguracji runtime; nie wyszukuje „najnowszego” runu i odrzuca niezgodność
CAS. Opcjonalny checkout musi być tym samym checkoutem zapisanym w receipcie,
a port powinien pozostać taki sam:

```powershell
just docker-dev-recreate `
  $runReceipt $previousConfigSha256 $source 3197
```

Recepta wywołuje `recreate --direct-development`, więc po walidacji używa tego
samego backendowego build-then-serve i istniejącego cache. Zachowuje run state,
session store i zaakceptowany marker. Identyfikatory kontenerów mogą się
zmienić; run, sesja i zadanie pozostają te same. Nie ponawia startupowego POST
ani polecenia Solve i nie uruchamia osobnego `up` lub kontenera budującego.

Ta ścieżka nie jest recovery nieznanego ownera. Nie używaj jej dla aktywnego
runu, niepotwierdzonego zatrzymania, obcej grupy ani niewolnych rezerwacji.
Nie dodawaj `--recover-idle-failure`, `--assembly-receipt` ani skryptu startowego;
nie resetuje ownera, nie usuwa cache i nie tworzy nowej grupy. W razie błędu
tożsamości, CAS, provenance lub storage pozostaje fail-closed, z zachowanym
receiptem i diagnostyką.

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

`examples/permalloy_layer_cofeb_rings_relax_300nm.py` pozostaje odrzucony kodem
`material_count_not_one`: obecna ścieżka nie obsługuje tego dwumateriałowego
przykładu. Udany smoke jednego materiału nie jest dowodem wykonania rings.

## Dane i wersje

| Dane | Trwałe miejsce |
| --- | --- |
| Źródła | Wybrany checkout Windows, readonly bind; frontend HMR |
| Build, zależności i pakiet dev | Prywatny trwały ext4 cache w zarządzanym backing storage |
| Sesje, modele, wyniki, logi i receipty | Fizyczny storage Windows, mount `/state` |
| Ustawienia i ostatnie projekty | `storage/user-data/<compose-project>/workspace.db`, mount `/user-data` |
| Przydziały fizycznego CPU/GPU | Wspólny `host-ledger-v1` na zarządzanym ext4; nie osobny ledger per grupa |

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

Decyzja użytkownika z 17.10.2026: kolejne buildy automatycznie usuwają
zweryfikowane, zastąpione pakiety techniczne. Bieżący pakiet i bezpośrednio
poprzedni pakiet do rollbacku pozostają. Wiek lub nazwa katalogu nie stanowią
dowodu zbędności: wymagane są zgodne receipty i łańcuch zakończonych rotacji.

Sprzątanie odbywa się wewnątrz backendu pod blokadą jego cache, po trwałej,
zweryfikowanej publikacji nowego pakietu. Przed usunięciem kopii zachowuje
log buildu, receipt, zapis rotacji i raport wykonania. Nieznane, niespójne lub
używane dane pozostają z diagnostyką. Niepowodzenie sprzątania nie unieważnia
poprawnie opublikowanego pakietu.

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
orkiestracji. Wykonanie FEM GPU i oryginalnego rings pozostaje **NOT VERIFIED**.
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
