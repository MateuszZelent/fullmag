# ADR 0064 — Docker DEV z natywnym storage Linux/WSL

Status: decyzja użytkownika przyjęta 19.10.2026; implementacja integracyjna
w toku, build i pełny runtime **NOT VERIFIED**.

## Kontekst

PR Kelvas888/fullmag#1 dodaje Linux/WSL do starszej ścieżki Docker.
Obecny master używa już kontrolera buildów w named volumes i stałego backendu
zgodnie z ADR 0061. Bezpośrednie scalenie starego launchera przywróciłoby
nieaktualny kontrakt hostowego stagingu i runnera. Użytkownik jawnie wybrał
pełny DEV Linux/WSL w aktualnej architekturze zamiast samego admission storage.

## Decyzja

Windows, Linux i WSL używają jednego launchera `docker_dev.py`,
`docker_volume_dev.py` i `docker_build_control.py`, tych samych recept,
projektu Compose checkoutu oraz dwóch stałych usług. Backend buduje
aplikację i uruchamia runtime; frontend obsługuje HMR. Dane budowania
pozostają w named volumes/BuildKit, dane użytkownika w storage hosta.
Nie przywracamy dawnego runnera, hostowego Cargo/CMake ani źródłowego ZIP/TAR.

Linux/WSL używa `linux-native-v1` i lokalnego ext4/XFS/Btrfs; Windows zachowuje
`windows-folder-v1` i istniejącą atestację NTFS/ReFS/9p. Host Linux działa jako
nie-rootowy użytkownik. Jawne runtime UID/GID są zgodne w Compose, host ledger,
cache, markerach i receipcie oraz końcowym inspect. Różny owner jest odmową,
bez chmod0777, rekursywnego chown i przejęcia istniejących danych.

Windows wybiera Docker Desktop `desktop-linux`; Linux/WSL lokalny aktywny
kontekst Docker Linux, widzący te same ścieżki hosta. Zdalny daemon nie jest
lokalnym bindem. Admission odrzuca symlinki, DrvFS, CIFS, NFS i storage
tymczasowy. Ustawienie profilu nie może ominąć walidacji hosta i kontenera.

Nie zmieniamy fizyki, czterech realizacji solvera, Python DSL, ProblemIR,
requested/resolved execution, OpenAPI ani workspace. Dostępność nowego hosta
nie poszerza naukowej kwalifikacji GPU ani capability map.

## Obowiązki implementacji

Kreator konfiguruje host bez buildu i uruchamiania usług. Toolchain,
kontroler i launcher muszą stosować tę samą tożsamość checkoutu, kontekstu,
profilu hosta i runtime usera. Backend/frontend cache muszą zachowywać
ownership oraz trwałość. Guest bootstrap potwierdza filesystem `/state`
i granice urządzenia; probe potwierdza publikację, sync, blokady, SQLite
i readback po restarcie. Restart/resume/recovery zachowują piny image,
źródeł, ownera, attempt i config hash; timeout nie oznacza braku skutków.

## Migracja i rollback

Nie przenosimy aktywnych sesji i nie przejmujemy istniejącego storage.
Konfiguracja Linux jest osobnym wyborem operatora, nie kopią `.env` Windows.
Rollback wyłącza trasę Linux w launcherze, zachowując dane i dowody.
Nie przeklasyfikowuje sesji jako Windows-folder i nie usuwa cache innych zadań.

## Weryfikacja

Testy interpretowane pokrywają wybór hosta, kontekstu i UID/GID, odrzucanie
niebezpiecznych filesystemów/ścieżek, ownership cache i regresję Windows.
Build Rust, cold start, restart, HMR/WebGL, SessionStore i GPU wymagają
osobnych dowodów. Zakaz kompilacji testów jednostkowych pozostaje w mocy.
`verify_docker_all_runtime.py` dla Windows nie kwalifikuje Linux/WSL.
Power-loss i restart całej VM pozostają **NOT VERIFIED**.

Instrukcja operatora: [Docker w WSL](../guides/docker-wsl.md).

### Granica współbieżności różnych rootów

Host ledger pozostaje powiązany z projektem/storage. Nowa trasa Linux
odmawia startu przy aktywnych backendach Fullmag na tym samym daemonie
z innym backing/mount/project ledgeru; nie tworzy niezależnego allocatora
dla tego samego fizycznego GPU. Ten sam kanoniczny ledger obsługuje grupy
worktree. Globalna koordynacja pomiędzy różnymi rootami nie jest częścią
tej integracji i wymaga osobnej decyzji infrastrukturalnej.
