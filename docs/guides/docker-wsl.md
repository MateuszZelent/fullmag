# Fullmag Docker DEV na Linux i WSL

Decyzja użytkownika z 19.10.2026 rozszerza obecną ścieżkę wolumenową DEV
o Linux/WSL. Integracja PR #1 jest w toku; build i pełny runtime tej wersji
pozostają **NOT VERIFIED**, dopóki nie ma przypiętych dowodów.

## Jeden kontrakt developmentu

Windows, Linux i WSL używają tych samych recept `docker-dev-toolchain`
i `docker-dev` oraz projektu Compose wybranego zarejestrowanego checkoutu:
`fullmag-master` lub `fullmag-worktree-<worktree_id>`. Stały `backend`
buduje i uruchamia aplikację, a `frontend` obsługuje Next/HMR z tego samego
readonly checkoutu. Nie używaj dawnego runnera, hostowego Cargo/CMake,
ręcznego Docker ani archiwum ZIP/TAR źródeł jako zastępczej ścieżki DEV.

Build, cache, staging, pakiety, logi, provenance i receipty buildu pozostają
w named volumes / BuildKit. Sesje, wyniki, projekty, ustawienia i historia
pozostają w jawnym trwałym storage hosta. Szerszy kontrakt opisują
[przewodnik wolumenowy](docker-volume-development.md) i
[architektura DEV](docker-development-architecture.md).

## Wymagania hosta Linux/WSL

Używaj nie-rootowego użytkownika, Python 3.10+, Git, `just`, `findmnt`,
lokalnego Docker Engine z silnikiem Linux i pluginu Compose. W WSL integracja
Docker Desktop musi być włączona dla wybranej dystrybucji. GPU wymaga osobno
działającej obsługi NVIDIA w Dockerze; wymuszone GPU nie przechodzi na CPU.

Checkout, Git/worktree i storage muszą przejść kontrolę lokalnego ext4, XFS
albo Btrfs oraz ścieżek bez symlinków. `/mnt/c`, DrvFS/9p, CIFS/SMB, NFS
oraz katalogi tymczasowe nie zastępują trwałego storage Linux. Kontekst
Docker musi wskazywać lokalny silnik widzący te same ścieżki. SSH/TCP do
innego hosta nie jest lokalnym bindem i nie może przejść admission.

Na nowym hoście wskaż własny storage w kreatorze; nie kopiuj `.env` z Windows
ani innego hosta. Worktree dziedziczy konfigurację głównego checkoutu przez
resolver. Kreator zachowuje istniejące ustawienia, nie przejmuje obcego
storage i nie przenosi aktywnych danych.

```bash
cd '<absolutny-zarejestrowany-checkout-na-ext4>'
python3 -B scripts/setup_docker.py
python3 -B scripts/setup_docker.py --check
just docker-dev-toolchain
just docker-dev '<absolutny-zarejestrowany-checkout-na-ext4>' 3197
```

Oba etapy wybierają ten sam checkout i projekt. Wybierz wolny port loopback.
`--check` jest diagnostyką konfiguracji, nie buildem ani dowodem GPU.
Dostęp z przeglądarki Windows do WSL zależy także od forwardingu localhost.

## Admission i ownership

Linux używa `linux-native-v1`; Windows zachowuje `windows-folder-v1`
i scoped grant NTFS/ReFS/9p. Linux runtime korzysta z jawnego UID/GID
nie-rootowego użytkownika hosta. Compose, markery i klucze cache, host ledger,
receipty i końcowy inspect muszą potwierdzać tę samą tożsamość. Różny owner
kończy próbę bez przejmowania danych. Nie stosuj chmod0777 ani rekursywnego
chown cudzych wolumenów. Zmiana użytkownika nie uprawnia do użycia jego cache.

Host i kontener potwierdzają filesystem, sentinela, trwałą publikację,
blokady i transakcje SQLite oraz readback po restarcie. Nie klasyfikuj 9p
jako natywnego Linux ani nie wybieraj profilu samą zmienną w celu obejścia
walidacji. Piny `attempt`, `config_sha256`, image i źródeł obowiązują również
przy resume/restart/recovery. Timeout klienta oznacza nieznany stan demona.

## Odbiór i granice dowodów

Oddzielne dowody są wymagane dla builda Rust, zimnego startu dwóch usług,
zdrowego API, restartu bez zmian, HMR/WebGL, zapisu i ponownego otwarcia
SessionStore oraz faktycznego wykonania GPU. Testy interpretowane, wykryte
urządzenie lub kontrola mountów nie zastępują tych bramek. Kompilowanie
testów jednostkowych pozostaje czasowo zabronione przez użytkownika.

Odporność na utratę zasilania i restart całej VM pozostaje **NOT VERIFIED**.
Windows-specific `verify_docker_all_runtime.py` nie kwalifikuje Linux/WSL.
Decyzja i rollback: [ADR 0064](../adr/0064-docker-linux-native-session-storage.md).

## Wspólny daemon i różne storage

Obecny host ledger jest powiązany z projektem i storage; integracja Linux
nie tworzy nowego globalnego allocatora dla wszystkich klonów na komputerze.
Przed startem Linux kontroler ma odmówić, jeżeli aktywny backend Fullmag
na tym samym daemonie używa innego backing/mount/project ledgeru. Grupy
worktree używające tego samego kanonicznego ledgeru mogą współistnieć.
Nie zatrzymuj obcej grupy ani nie twórz równoległego allocatora, aby ominąć
ten warunek. Współbieżność różnych rootów wymaga osobnej decyzji i migracji
infrastruktury hosta. Samo wykrycie wspólnego UUID GPU tego nie rozwiązuje.
