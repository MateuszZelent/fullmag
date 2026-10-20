# ADR 0059 — sesja Docker Desktop w bezpośrednim folderze Windows

Status: implementacja i kwalifikacja w toku, 2026-10-14.

## Kontekst

Użytkownik wymaga obrazu z UI/API/Python/FEM/GPU oraz sesji zapisanej
bezpośrednio w Windows storage. Docker Desktop udostępnia lokalny NTFS jako 9p,
który istniejący writer słusznie odrzuca jako niekwalifikowany. Named volume nie
spełnia uzgodnionego wymagania. Nie zmieniamy fizyki, DSL, ProblemIR, API ani
requested/resolved execution.

## Decyzja

Wprowadzamy scoped adapter `windows-folder-v1` dla sesji, zgodny z istniejącą
rodziną profili z Windows-first development. Nie dodajemy 9p do globalnej allowlisty.
Admission wymaga natywnego NTFS/ReFS i no-reparse preflight hosta, jawnego readonly
attestation, pojedynczego owned namespace, rzeczywistych prób operacji oraz
readback po ponownym starcie własnego kontenera. Grant musi odpowiadać bieżącemu
mount namespace, device/inode `/state` i źródłom/binary/image/artefaktom.

Writers kontenera nadal używają istniejących native locks i publication barriers.
Native Windows writer odmawia użycia wewnętrznego namespace oznaczonego jako
Docker-owned. Nie zakładamy współdzielenia locków Win32/Linux. Portable `.fms`
pozostaje sposobem przenoszenia danych pomiędzy odrębnymi runtime'ami.

Kontener mapuje kanoniczny storage na `/state` i bootstrapuje wyłącznie
attested store `/state/runs/docker-all/session-store`. Rust tworzy nowy store
albo otwiera kompletny istniejący store bez przejmowania częściowego katalogu.
Python nadzoruje proces API; kanoniczny Rust runtime service nadal posiada
scheduler, resource pools, owner metadata i authenticated drain. Nie rozszerzamy
publicznego API ani kwalifikacji host execution v2.

## Granica trybu developerskiego

Aktualizacja z 17.10.2026: [ADR 0061](0061-docker-development-build-and-runtime-container.md)
zastępuje opis developerskiego buildu przez runner i gotowy pakiet opisany poniżej.
Dev używa dwóch stałych usług, samodzielnego build → runtime oraz typed hostowej
delegacji `development_build` dla aktualnego receipt/provenance. Dotychczasowe
inwarianty storage, ownera, image/engine, no-follow i grantów pozostają wymagane.
Exact binary/source pin bez delegacji nadal obowiązuje release/static. Nowy
wariant i rzeczywisty restart pozostają **NOT VERIFIED** do kwalifikacji.


Wersjonowanym źródłem topologii trybu developerskiego jest rootowy
`compose.dev.yaml`. Kontrakt obejmuje dokładnie usługi `backend` i `frontend` oraz
prywatną sieć Compose. `backend` nie publikuje portu hosta i udostępnia tylko
wewnętrzne `8081`; `frontend` publikuje `127.0.0.1:3197` na swoje `8080` i
proxyfikuje API przez `http://backend:8081`. Wartość portu hosta może zostać
rozwiązana przez launcher, ale nie zmienia to prywatnego portu backendu.

`FULLMAG_SOURCE_ROOT` wskazuje główny checkout Git domyślnie albo jawnie
wybrany worktree. Obraz developerski nie kopiuje źródeł aplikacji ani
pakietu runtime. Backend dostaje readonly bind źródła jako
`/opt/fullmag/source`, pakietu jako `/opt/fullmag/package` i jego provenance
pod `/opt/fullmag/provenance.json`. Frontend dostaje readonly bind czterech
żywych katalogów Control Room (`app`, `src`, `public`, `scripts`) z tego samego
checkoutu; polling/HMR obserwuje te katalogi. Konfiguracja i metadane freeze są
utrwalane osobno i nie są objęte HMR.

Obraz release zachowuje statyczny frontend. Tryb developerski uruchamia dwa
kontenery z tego samego niezmiennego obrazu: frontend Next/HMR oraz backend
API/Python/FEM/GPU. Frontend publikuje jeden port loopback Windows i przekazuje
API do backendu w prywatnej sieci Compose. Cztery katalogi źródeł Control Room
z wybranego checkoutu są montowane readonly, z pollingiem zmian. Manifesty
zależności i konfiguracja są utrwalane przy przygotowaniu workspace.

Frontend zapisuje wyłącznie swój katalog `state/development`; nie otrzymuje
accepted store, certyfikatu writera ani GPU. Backend pozostaje jedynym writerem
sesji i właścicielem runtime service. HMR nie zmienia modelu ani kontraktu API.
Build backendu wymaga jawnego zlecenia do managed runnera i nie restartuje
bieżącej symulacji. Zmiana obrazu nie deklaruje odtworzenia niezapisanej sesji.

`compose.static.yaml` pozostaje opcjonalną, osobną ścieżką release/legacy z
jednym backendem i frontendem statycznym. Nie jest źródłem topologii HMR.

Zależności FEM pozostają kanoniczne dla `docker/fem-gpu/Dockerfile`, w tym
stage `fem-gpu-dev` i przypięte wersje z tego pliku. `Dockerfile.dev` ma jedynie
zintegrować ten toolchain; Compose i ADR nie utrzymują drugiej listy wersji.
Raport zależności oraz śledzenie wersji wymagają osobnego review.

Implementacja rootowego Compose, renderowanie przez launcher oraz dowód
cold-start/HMR są jeszcze **VERIFICATION PENDING**. Ten kontrakt nie zatwierdza
nowych flag recept ani nie zastępuje późniejszego sprawdzenia rzeczywistej
konfiguracji Compose.

Interfejs developerski launchera pozostaje ograniczony do:

```text
just docker-all-dev <assembly_receipt> [port=3197] [source_root=""]
just docker-all-dev-backend-build [source_root=""]
just docker-all-dev-image <job_id> <commit> [source_digest=""] [native_snapshot_sha256=""] [source_root=""]
```

Pusty `source_root` wybiera główny checkout, jawny parametr zarejestrowany
worktree. Dla snapshotowego joba z worktree ścieżka musi być taka sama jak przy
submission; można podać ją jako piąty argument obrazu albo przez
`FULLMAG_SOURCE_ROOT`. `docker-all-image` pozostaje opcjonalną ścieżką packaged release
dla `compose.static.yaml`. Resolved Compose JSON i kopia YAML są zamrażane w
owned run; launcher nie generuje topologii przez Python.

Implementacja: `scripts/docker_development_inputs.py`, launcher
`scripts/fullmag_docker_runtime.py`, `docker/all-in-one/frontend_dev.py`,
entrypoint/healthcheck i recepta `docker-all-dev`. Kontrole podziału montowań,
freeze oraz lifecycle są osobne od dowodu HMR w rzeczywistej przeglądarce.

## Obowiązki i rollback

Launcher oraz entrypoint muszą wydawać i sprawdzać dowody; `fullmag-session`
sprawdza je przed admission. Brak, zmiana, błąd lub rozszerzenie zakresu dowodu
ma kończyć się odmową. Zachowujemy no-follow, owner metadata, niepewną publikację
po błędzie bariery i kontrolowane recovery. Dowody oraz sesje pozostają w storage.

Rollback wyłącza profil i zachowuje dane; nie przenosi ich do named volume,
nie usuwa ich ani nie dopuszcza niekwalifikowanego 9p. Active session nie jest
restartowana z powodu końca buildu. Nowy obraz nie obiecuje automatycznego restore.

## Dowody

Sonda 7656cafdee4d4d78816536e272582fee potwierdziła podstawowe operacje 9p
na lokalnym NTFS, w tym no-follow Windows junction i readback po restarcie.
Właściwy SessionStore, restart API, browser/WebGL i GPU wymagają osobnych bramek.
Awaria zasilania i restart całej VM pozostają NOT VERIFIED, jak w obecnym
platformowym kontrakcie durability. Szczegółowy plan i schema:
[plan zadania](../plans/active/docker-all-windows-20261014.md).
