# Docker Fullmag na nowym komputerze Windows

Stan 15.10.2026: dwa kontenery developerskie są zaimplementowane na branchu
zadania; końcowa kwalifikacja GPU/Workspace i integracja do mastera trwają.
Nie jest jeszcze potwierdzona instalacja od zera jednym `docker compose up`.

## Interaktywny kreator

W poprawnym checkoutcie zawierającym te zmiany otwórz **PowerShell** i uruchom:

```powershell
python -B scripts/setup_docker.py
```

Kreator sprawdza narzędzia, Docker Linux i widoczność NVIDIA, pyta o lokalny
storage, checkout źródeł i port frontendu. Pokazuje plan przed zapisem. Tworzy
lub aktualizuje `.env` głównego checkoutu, zachowuje istniejące hasła i pozostałe
ustawienia oraz generuje brakujące hasła PostgreSQL/MinIO. Nie przejmuje
niepustego storage bez markera ani storage innego projektu. Własny nowy root
rejestruje markerem projektu dopiero po zatwierdzeniu przez operatora.

Kontrola już zapisanej konfiguracji, bez pytań i zapisu:

```powershell
python -B scripts/setup_docker.py --check
```

Kod wyjścia `0` oznacza poprawną konfigurację hosta i dostępność wymaganych
narzędzi. Nie oznacza zbudowanej aplikacji ani potwierdzonego wykonania GPU.
Kreator obecnie **nie instaluje toolchaina, nie inicjalizuje runnera i nie
uruchamia kontenerów**; te etapy opisano poniżej. Checkout i port zapisuje w
`index/docker-host-settings.json` rozwiązanego storage; przy starcie przekazuj je
jako jawne argumenty poleceń z sekcji 4.

Kreator obsługuje również konfigurację z Linux/WSL, w tym checkout w katalogu
domowym WSL. Użyj `python3 -B scripts/setup_docker.py`, a do kontroli bez zapisu
dodaj `--check`; szczegóły: [konfiguracja Linux/WSL](docker-setup-linux-wsl.md).
Launcher aplikacji nadal ma osobne wymagania Windows opisane poniżej.
Sam kreator nie przenosi klona ani danych i nie kwalifikuje startu z WSL.

## 1. System i narzędzia hosta

Wymagane są Docker Desktop z silnikiem Linux i backendem WSL 2, sterownik
NVIDIA obsługujący WSL GPU, aktualny WSL, Git for Windows (z Git Bash), Python
co najmniej 3.10 oraz `just`. Biblioteki FEM, CUDA toolkit, Rust i Node używane
do budowania Fullmaga należą do obrazu toolchaina; nie instalujemy ich na
Windows tylko po to, aby zbudować wariant Docker.

W PowerShell sprawdź:

```powershell
wsl --status
wsl --update
docker version
docker compose version
docker context show
docker info --format '{{.OSType}}'
nvidia-smi
git --version
python --version
just --version
```

`docker info` musi zwrócić `linux`. W Docker Desktop włącz **Use the WSL 2
based engine**. Test samego dostępu do GPU, według dokumentacji Docker:

```powershell
docker run --rm -it --gpus=all nvcr.io/nvidia/k8s/cuda-sample:nbody nbody -gpu -benchmark
```

Test nbody sprawdza GPU Dockera; nie kwalifikuje Fullmaga ani jego bibliotek.
Model GPU musi być zgodny z wybranym toolchainem CUDA i architekturami builda.

Źródło wymagań GPU: [Docker Desktop GPU support](https://docs.docker.com/desktop/features/gpu/).

## 2. Checkout i lokalny storage

Kopia plików repozytorium nie przenosi obrazów Docker, konfiguracji runnera,
cache ani pakietu backendu. Skopiowany worktree może zawierać plik `.git`
wskazujący na poprzedni komputer; taki katalog wymaga właściwego klona lub
zarejestrowania worktree na nowym hoście.

W katalogu repozytorium sprawdź:

```powershell
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
Test-Path .\compose.dev.yaml
Test-Path .\compose.toolchain.yaml
```

Oba pliki Compose muszą istnieć w wersji zawierającej implementację Docker.
Samo skopiowanie starego mastera nie dodaje zmian z niescalonego PR.

Poniższa konfiguracja ręczna jest alternatywą dla kreatora. Utwórz `.env` wyłącznie, jeśli jeszcze go nie ma:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

Ustaw `FULLMAG_PROJECT_STORAGE_ROOT` na bezwzględny, lokalny katalog storage
wybrany dla **tego komputera**. Nie kopiuj ścieżek, tokenów ani całego `.env`
z pierwszego hosta. Sesje wymagają lokalnego NTFS/ReFS bez junctionów; UNC
ani dysk sieciowy nie są zamiennikiem. Domyślna kanoniczna lokalizacja storage
jest rodzeństwem głównego checkoutu. Inny root wymaga jawnego zarejestrowania
markera projektu zgodnie z governance; resolver ma go odrzucić, jeśli nie jest
poprawnie przygotowany.

Sprawdzenie rozwiązanych ścieżek, bez uruchamiania aplikacji:

```powershell
python -B scripts/fullmag_storage.py resolve --repo-root . --profile docker-all-gpu --format json
```

Worktree i profile muszą być zarejestrowane przed budowaniem. Wartości
`FULLMAG_BUILD_ROOT`, `FULLMAG_CACHE_ROOT`, target i runtime wyprowadza resolver;
nie wypełniaj ich przypadkowymi folderami ani ścieżkami poprzedniego hosta.

## 3. Toolchain i lokalny koordynator buildów

Nowy host potrzebuje lokalnego obrazu zależności FEM/GPU z kanonicznego
`docker/fem-gpu/Dockerfile`, manifestu zbudowanych wersji oraz jednego
`Fullmag_build_runner`. Konfiguracja i immutable image IDs pierwszego
komputera nie istnieją automatycznie w drugim Docker Engine.

Definicja toolchaina: `compose.toolchain.yaml`. Definicja aplikacji:
`compose.dev.yaml`. Konfiguracja koordynatora i profilu `fem-gpu-release`:
[local-container-runner.md](local-container-runner.md). Stan koordynatora:

```powershell
just runner-container-status
```

Na nowym hoście, **przed rejestracją koordynatora**, zbuduj zależności:

```powershell
just docker-all-toolchain-bootstrap
```

Recepta używa `compose.toolchain.yaml` i kanonicznego
`docker/fem-gpu/Dockerfile`. Zamraża tylko kontekst zależności, zachowuje jego
hashy, trzyma wspólną blokadę ciężkich prac i zapisuje końcowy receipt w storage.
CUDA toolkit, MFEM, hypre, libCEED, PETSc/SLEPc oraz narzędzia pobierane są
wewnątrz builda Docker. Windows nie musi mieć tych bibliotek.

Bootstrap odrzuca istniejącą konfigurację runnera, także częściową, oraz istniejący
rejestr kolejki — również bez aktywnych wierszy. Nie jest trasą do obchodzenia działającego koordynatora przy
aktualizacji zależności. Nie usuwa cache ani nie inicjalizuje drugiego runnera.
Po błędzie zachowaj receipt i logi; przerwanej obserwacji nie traktuj jako
potwierdzenia zatrzymania Docker BuildKit. Niepotwierdzony wynik pozostawia
blokujący wpis `index/docker-toolchain-bootstrap.json`; następna próba wymaga
najpierw sprawdzenia dokładnie wskazanych zasobów i jawnego recovery operatora.
Nie kasuj wpisu ani cache, aby ominąć tę kontrolę.

Wynik podaje lokalny tag i immutable `image_id` obrazu toolchaina. Wersje
bibliotek są przypięte w Dockerfile; zbudowany manifest znajduje się w obrazie
pod `/opt/fullmag-deps/share/fullmag/dependency-versions.json`. Bootstrap odczytuje
ten manifest z niezmiennego image ID i zachowuje jego kopię oraz SHA-256 w receipt.
Sam sukces builda obrazu zależności nie kwalifikuje wykonania solvera GPU.

Następnie przygotuj workera z otrzymanego lokalnego tagu oraz jeden koordynator
według [instrukcji runnera](local-container-runner.md#konfiguracja-i-obsługa).
Skonfiguruj profil `fem-gpu-release` z **rzeczywistym image ID workera**, nie ID
samego toolchaina. Nie wklejaj hashy z pierwszego komputera. Kreator nadal nie
wykonuje automatycznie tego całego wieloetapowego enrollmentu.

## 4. Właściwe uruchomienie developerskie

`docker compose run dev` korzysta ze starego `compose.yaml`. Jego usługa
`dev` to środowisko narzędziowe z `sleep infinity`, a nie frontend/backend
Fullmaga. Wymaga też wcześniej rozwiązanych zmiennych storage.

Po przygotowaniu koordynatora i profilu budowanie backendu rozpoczyna:

```powershell
just docker-all-dev-backend-build
```

Zgłoszenie zwraca `job_id`, commit i dwa digesty snapshotu. Poczekaj na sukces,
następnie złóż obraz i uruchom Workspace zgodnie z
[all-in-docker-windows.md](all-in-docker-windows.md). Argumenty są pozycyjne;
`assembly_receipt` jest wynikiem składania obrazu, a nie nazwą obrazu:

```text
just runner-wait <job_id> 30
just docker-all-dev-image <job_id> <commit> <source_digest> <native_snapshot_sha256>
just docker-all-dev <assembly_receipt> 3197
```

Frontend publikuje loopback port 3197 i obserwuje źródła HMR; backend
komunikuje się po prywatnej sieci. Sesje/wyniki pozostają w Windows storage.
Kod 124 z `runner-wait` kończy tylko obserwację: sprawdzaj ten sam job.

## Dane potrzebne do diagnozy błędu

Prześlij dokładny komunikat, wykonane polecenie, wersję Windows, model GPU,
wynik kontroli Git/Compose oraz wybraną ścieżkę storage. Nie przesyłaj całego
`.env`, tokenów runnera ani credentiali. Błąd o wymaganym `FULLMAG_BUILD_ROOT`
w starym Compose oznacza brak środowiska resolvera; nie dowodzi awarii CUDA.

## Konkretny błąd interpolacji w WSL

Komunikaty o `FULLMAG_FRONTEND_CONTAINER_ROOT`, `FULLMAG_BUILD_ROOT`, target,
cache i runtime oznaczają brak wyeksportowanego środowiska resolvera starego
`compose.yaml`. W powłoce Linux/WSL, w katalogu repozytorium:

```bash
test -f .env || cp .env.example .env
nano .env
# Set FULLMAG_PROJECT_STORAGE_ROOT to the operator-selected absolute storage.
fullmag_paths="$(python3 -B scripts/fullmag_storage.py resolve \
  --repo-root . --profile linux-host --create --format sh)" &&
eval "$fullmag_paths" &&
docker compose config --quiet
```

Kopiowanie szablonu zachowuje istniejący `.env`. Resolver musi zakończyć się
sukcesem przed Compose; `eval` nie może maskować jego błędu. Ten krok usuwa
błąd konfiguracji starego kontenera narzędziowego, nie buduje ani nie uruchamia
nowej aplikacji. Ostrzeżenia MinIO/PostgreSQL wynikają z braku `.env`.

Codzienny development uruchamiaj przez `just docker-dev-toolchain` i
`just docker-dev`, zgodnie z [procedurą volume DEV](docker-volume-development.md).
Adapter Windows wymaga lokalnego NTFS/ReFS i odrzuca UNC oraz ścieżki Linux.
Launcher uruchomiony w Linux/WSL wybiera osobny profil `linux-native-v1`
na lokalnym ext4/xfs/btrfs; może korzystać z checkoutu pod `~/git`.
Użyj [konfiguracji Linux/WSL](docker-setup-linux-wsl.md), aby zachować kontrolę
storage, mapowania mountów i receiptów. Ręczne eksportowanie zmiennych starego
Compose nie zastępuje tych kontroli ani nie dowodzi startu aplikacji.
