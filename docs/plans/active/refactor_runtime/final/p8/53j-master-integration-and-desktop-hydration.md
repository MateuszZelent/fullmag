# P8-53J — integracja mastera i hydracja akcji desktopowej

Data: 03.10.2026. Checkpoint integracji P8-53I z równoległą pracą frontendu.

Push lokalnego `836de7808e0131f908a13b83d1f9dafeb6d26c5f` został odrzucony
bez zastąpienia historii remote. Odczytano nowy master
`08a15f298be7d375ab33ec84102e17abafb22b9d` (PR #106) i połączono go bez
konfliktów. Zmiany remote dotyczą ekranu Start, jego Inspectora i nakładki Home.
Guard backendu oraz cudze zmiany submodułu pozostają zachowane.

React Doctor wykrył rzeczywisty problem SSR/desktop w
`modules/start/inspector/ProjectDetails.tsx`: wywołanie `tauriInvoke()`
w renderze wybierało disabled/title na podstawie obecności `window`.
Na serwerze bridge jest nieobecny, podczas pierwszego renderu klienta desktop
może już istnieć. Zastosowano `useSyncExternalStore` z serwerowym snapshotem
`null`, zgodnie z istniejącym wzorcem Start Screen. Pierwsza hydracja ma tę
samą nieaktywną akcję; następnie React pobiera stały bridge hosta. Nie powstał
store aplikacji, nowy endpoint ani efekt kopiujący stan. Bridge jest zasobem
zewnętrznym o czasie życia okna desktop.

## Dowody

- Produkcyjne typowanie po poprawce: PASS, receipt
  `eb21a17b72644ef68c8ea6a4c06a4b31`, profil `windows-control-room-source-check`.
- React Doctor przed poprawką: 18 plików, 1 błąd hydracji, receipt
  `ffcbea707f524896ad8f8c27b86a03f2`.
- React Doctor po poprawce: 18 plików, brak zgłoszeń, receipt
  `03e5b08e78b4460e9328c7c5c6b3b774`. Source digest przed/po:
  `5663df93dbb3c443142df93ddc537e40644a23cd66931601038808955143c54e`.
- Lint i higiena API po scaleniu przed poprawką przeszły:
  `939c8694b98b4905acc5a994b4539281` i `de1a51eacf5945198d51f18e41e49d33`.
  Końcowy lint po poprawce: PASS, receipt `20c77c3e1c4f4568bbb3b9715518099c`.
- Rust guard i protokół service zachowują własne dowody opisane w
  [P8-53I](53i-stable-authoring-acquisition.md); importer frontendu nie zmienia
  ich źródeł. Nie kompilowano testów jednostkowych.

## Granice i aktywne zasoby

Browser odczyt użytkowej karty 3197 wykazał `ERR_CONNECTION_REFUSED`.
Nie wykonano więc nowego przejścia Home/workspace ani kwalifikacji Tauri.
Nie wolno zastępować tego wynikiem typowania albo historycznym logiem HTTP 200.
Manager 241108, launcher 240280 i watcher 240568 były nadal obecne; nie zostały
zatrzymane ani odtworzone przez agenta. Odmowa połączenia nie jest dowodem
terminalności ich lifecycle ani zgodą na zastąpienie owner record.

Pełny kontrolowany restart, prelisten restore, nowy API pin, ochrona szkiców
i bramki Windows/browser pozostają otwarte. Sam guard nie włącza przycisku
restartu. P0–P8 nie są ukończone na podstawie tego checkpointu.

## Kolejny odczyt uruchomienia dev

Po dalszych zmianach master wskazuje `7d6facb689ffa8bbf1514fbdc4393fb2a4c2c363`.
Ponowna obserwacja użytkowej karty `http://localhost:3197/workspace` wykazała
aktywny ekran `Welcome to Fullmag`. Przejście do `Templates` i powrót przez
`Home` zadziałały; obserwowana konsola nie zawierała wpisów poziomu error.
Błąd `Command "start.section.home" is already registered` nie występuje.
Jedynym właścicielem START_COMMANDS pozostaje manifest Start Screen.

Nowy manager jest odrębnym uruchomieniem użytkownika (PID 246504), launcher
243220, watcher 209816 według owner record. Równoległy build backendu ma
status running od 20:10:48 UTC, watcher building. Próba drugiego uruchomienia
przez agenta została prawidłowo odrzucona jako storage busy; nie zatrzymano
procesów ani nie nadpisano owner record. Nie oznacza się tego trwającego
buildu jako PASS. UI pozostawało dostępne podczas jego działania.

Screenshot: `C:/Users/Mateusz/.codex/visualizations/2026/09/20/01a0be34-da2b-78d3-b0a9-52ebb7e8ecde/fullmag-dev-start-20261003.jpg`.
To dowód uruchomienia i nawigacji, bez kwalifikacji solvera, viewportu ani
kontrolowanego restartu.