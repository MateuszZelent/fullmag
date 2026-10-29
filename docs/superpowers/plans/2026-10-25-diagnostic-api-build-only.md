# Build kandydata przy zachowanym diagnostycznym API — 25.10.2026

## Cel i zakres

Nowy benchmark RT0 odmówił przyjęcia certyfikatu, a scheduler przygotowania
zakończył się po błędzie odczytu CAS. Poprawki źródeł są w commicie
`27c4d375d1d0e135102f13a18faecd85cf4a9bd7` i wymagają rzeczywistej kompilacji.
Obecny owner pozostaje Unknown z częściowym statusem zakończenia dzieci.
Nie wolno ręcznie zmieniać go na Failed/Drained ani utożsamiać nieobecnego PID
z pełnym recovery.

Rozszerzenie istniejącego `docker-dev-recovery-build` dodaje jawny parametr
`diagnostic_api_only=true`. Buduje tylko nieopublikowanego kandydata w stałym
backendzie tej samej grupy. Nie promuje pakietu, nie restartuje API, nie uruchamia
runtime/Solve i nie zwalnia rezerwacji. Normalny wariant terminalnego Failed
pozostaje bez zmian. Build-only nie rozwiązuje jeszcze recovery namespace.

## Bramki

- Dokładne piny kontenera, obrazu, konfiguracji i udanego resume.
- Niezmienione receipty procesu, ownera, konfiguracji, provenance oraz rejestru.
- Fenced API ze stanem degraded, zgodnym PID, executable, zmienną fence i instancją HTTP.
- Dokładna tożsamość ownera Unknown względem jego pierwotnego pinu Ready.
- Brak ownera, obu schedulerów, innych procesów Fullmaga i kompilatorów.
- Wszystkie zachowane rezerwacje hosta mają stan released.
- Dotychczasowe blokady STARTUP-GATE/LAUNCH/OWNER/build, kontrola miejsca,
  publikacja kandydata i potwierdzenie zakończenia Make pozostają obowiązkowe.
- Obserwacja zmieniona po rozpoczęciu Make zachowuje blokady i dowody;
  timeout nie jest zgodą na ponowienie ani promocję.

## Dowody przed buildem

W wolumenie kontrolnym grupy, pod
`verification/surface-rt0-performance-20261025/`:

- `diagnostic-build-checks.json`: 24 interpretowane testy PASS; bez kompilacji native.
  Fixture pakietów wymagają wykonywalnego TMPDIR `/build/tmp`; `/tmp` w obrazie
  nie daje poprawnego kontraktu uruchamiania plików fixture. Kontroli executable
  nie wyłączono.
- `diagnostic-build-real-preflight.json`: dwa zgodne rzeczywiste odczyty PASS,
  bez mutacji. Receipt procesu SHA256
  `8355eee7c0a9606592a800f84aaa3b06a6fdcb1f35adfea61ef46a3765b87e63`,
  owner SHA256 `3fb4b7895428ba94d52dfc308362af33afc2ab4a4a5a15577a3edbe379681495`.
- `independent-moment-oracle-all-cells.py` i `.json`: niezależna kontrola
  arytmetyczna na 1865 Tet4, 3730 przypadkach współczynników i 11238
  sprawdzeniach, z permutacjami stable IDs i odrzuceniem zmienionego J.
  To nie wykonanie walidatora Rust, nie nowy Solve ani kwalifikacja H.

Build, wykonanie nowego pakietu, recovery oraz publiczne V/J/H pozostają
oddzielnymi bramkami. Przed deklaracją wykonania należy odczytać terminalny
receipt konkretnej operacji. Pełne Universe i UI/WebGL nadal NOT VERIFIED.

## Kontrola pełnej ścieżki recepty

Pierwsze wywołanie `just` odmówiło przed BuildControl/Make, ponieważ dodatkowy
parser `scripts/just_storage_shell.sh` nie dopuszczał nowej flagi. Uzupełniono
jego stałe argv i zachowano zakaz promocji. Regresje starego wariantu,
resume+diagnostic, promocji, powielonej flagi oraz złożonych komend przeszły:
`diagnostic-build-checks-v2.json`, 26 testów PASS. Nie uznajemy poprzedniej
odmowy za rozpoczęty lub zakończony build.

## Rzeczywisty wynik buildu

Operacja `6b7b046482f8408e850eb1918caa7985` zakończyła się `succeeded`,
exit0. Make trwał 221317 ms, pakowanie 6566 ms i objęło 24 pliki.
Źródło: `4a489e3c549e51cfb2cd30e51c14d6944baaac7c`, snapshot
`01de70a34fbee088c8120bbff41659300a686add1b9bffcfd4eb45b4f6592de5`.
Kandydat:
`/opt/fullmag/package/.development/candidates/.backend-package-candidate-sexe5b82`.
Receipt SHA256:
`ad43456987c1120f5df879afb78b0d39ef064dc0008c4ae53c6769d00b1bc307`.

Obecny pakiet i provenance pozostały niezmienione; `package_promoted=false`,
`runtime_started=false`. Kontrola niezmienności 70 plików wcześniejszego wyniku,
2 archiwów, 6 chronionych plików nieudanej próby Universe oraz sceny użytkownika
przeszła. Dowody: `diagnostic-candidate-build-checkpoint.json` oraz
`retention-after-diagnostic-build.json` w tym samym katalogu kontrolnym.

Kompilacja poprawki jest teraz potwierdzona. Nowe V/J/H, recovery ownera Unknown,
przyspieszenie RT0 i Universe w UI pozostają NOT VERIFIED. Kandydat jest
zachowany; nie wolno ponawiać buildu ani usuwać go tylko dlatego, że nie został
jeszcze promowany. Następna operacja ma wykorzystać kanoniczne dowody terminalnej
historii, bez ręcznej zmiany OWNER lub rezerwacji i bez powtórzenia starego Solve.
