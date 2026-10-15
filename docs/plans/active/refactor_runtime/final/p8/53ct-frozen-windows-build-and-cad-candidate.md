# P8-53CT — pakiet Windows z zamrożonych źródeł i kandydat CAD

Data: 15.10.2026. HEAD rozpoczęcia `90d35237d529ad55e9a30a868e11473eb7399bad`.
Pełny cel P0–P8 pozostaje **IN PROGRESS**.

## Trwający zarządzany build

Uruchomiono `just windows-workspace-build dev dev 3197 auto`, bez startu UI,
bez kompilowania testów jednostkowych Rust/native. Preflight wykazał brak
nasłuchu 3197/3104 i 88075448320 wolnych bajtów na woluminie repozytorium.
Po rzeczywistym oczekiwaniu build uzyskał wspólny zasób; nie omijano blokady
i nie zatrzymywano innych procesów.

- Log: `C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-native-fdm-cpu-dev\logs\native-build-e5a6aae5110b439aa0466bc6677fa195.log`.
- Uchwyt własnego procesu do kontynuacji: `6897`.
- Frozen snapshot: `753429e3c94e24b7f7b4dc990c24f4aaedddabaf9a7051bf1bcc8e1a707160e1`.
- Pakiet Python: `0.1.0.dev20261015+g90d35237d529.dirty.se4141c4bca76`.
- MSVC zaimportowany; pnpm frozen lockfile zakończył 744 pakiety, bez pobrania nowych; Rust/Cargo 1.100.0-nightly wykryte.

Build nadal wymaga terminalnego exit code, receiptu i kompletnego manifestu.
To nie jest jeszcze udany pakiet Windows, browser proof ani kwalifikacja
FEM/GPU. Ramdisk R pozostaje używany dla compiler TEMP; normalizacja ścieżki
RAM-dysku nie jest obsługiwana, więc launcher zachowuje jeden trwały mirror.
Nie zmieniano walidacji ścieżek ani polityki storage.

Po utworzeniu snapshotu pojawiły się dalsze cudze edycje API/desktop/frontend
w checkoutcie. Nie dołączano ich do własnego stagingu. Build ma nadal używać
swojej utrwalonej kopii; jego wynik nie będzie dowodem dla późniejszych edycji.

## Kandydat konstrukcji CAD od obiektu

Driver ma 14 prób, w tym `body_first_cad_30/50`. Najpierw tworzy magnetyczne
interwały od body lower cap, potem air w górę i w dół. Mapy wolumenów wracają
do oryginalnej kolejności interwałów przed nadaniem grup fizycznych. Zachowano
oryginalny plan poziomów, pola 3D, authored targets, x-span klasyfikację hole
i meshed-prism guard. Nie zmieniono produkcyjnego generatora poza wcześniejszym WIP.

Kontrole źródłowe klona, AST call budget, authored controls i CLI help:
**PASS**. Candidate function SHA256:
`ad7fc38a9d26ee25bcc94d6bccfa1885f3219581f8ab7d93e304f94d7b6b8944`.
Managed Gmsh observation: **NOT RUN** do zakończenia buildu i zwolnienia storage.
Sukces kompilacji źródła klona nie zalicza owner XY, PBC, lokalnego ROI ani Box.

## Współdzielony index

Próba zapisu 53CS trafiła na index.lock. Read-only Windows Restart Manager
wskazał uchwyt COM Surrogate/dllhost.exe PID 35964; sam brak git.exe nie dowodził
braku właściciela. Pierwszą próbę przeniesienia cofnięto po błędzie wyłącznego
otwarcia; hash indexu nie zmienił się. Późniejszą próbę zachowania pustego
pliku przerwano po zmianie timestampu. Nie zakończono procesu systemowego,
nie usunięto locka i nie wymuszano historii. Następny odczyt wykazał zwolnienie
index.lock; staging nadal wymaga osobnej kontroli cudzych wpisów.

## Terminalny wynik buildu i dalsze obserwacje

Build `e5a6aae5110b439aa0466bc6677fa195` zakończył się **FAIL**: cargo exit 101,
wrapper/just exit 1, sesja `6897` odczekana. Nie przerwano go z powodu późniejszych
edycji checkoutu: kompilator odczytał utrwalony snapshot i zgłosił E0382
w `router_v2/handlers/platform/compute_nodes.rs:171` (`node_id` przeniesione
do closure, następnie użyte przy ETag). Była to część współdzielonego WIP.
W bieżącym checkoutcie dodano wyłącznie osobną kopię `policy_node_id` dla closure;
nie dołączono całego cudzego handlera do commita. Diff check PASS, parser rustfmt
przetwarza plik, ale format check wskazuje wcześniejsze różnice poza poprawką.
Odbiór tej poprawki przez nowy produkcyjny build pozostaje wymagany.

Nie ma nowego kompletnego pakietu runtime. Snapshot, log i stan końcowy należy
zachować do diagnozy i odtworzenia; nie modyfikowano kopii frozen. Cache Cargo,
compiler mirror, wcześniejszy manifest i pakiety rollback pozostają zachowane.
Brak kwalifikacji do usunięcia oraz brak operacji prune; ponowna ocena po
potwierdzeniu kompletnego pakietu zastępującego ten nieudany etap.

Po zwolnieniu blokady wykonano driver 14 wariantów: receipt
`84350daa85c449e3b5924494f33e9c9d`, PID 192184 odczekany, exit 0,
bez timeout/terminate/kill, fingerprints stabilne. Oba `body_first_cad_30/50`
mają status observed, body tags `[1,3,5]` i body XY digest
`20947abb5339b7a562623a057cbb7727db67ca7d7aea0445381245a96da4f320`.
Dwie fazowe próby pozostają error; ich porażki nie zmieniają się w PASS
z powodu sukcesu innych wariantów. Nowa obserwacja uzasadnia roboczą poprawkę
kolejności CAD; nadal wymagane pełne regresje Box/owner-fields/scoped-ring.
