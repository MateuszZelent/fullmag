# P8-C — Node należący do pakietu Windows

Data: 02.10.2026. Źródła i lekkie regresje PASS; pełne MSI NOT VERIFIED.
Decyzja: [ADR 0046](../../../../../adr/0046-native-windows-node-runtime-ownership.md).

MSI wymaga operatorowego `FULLMAG_WINDOWS_NODE_RUNTIME_ROOT`: natywnej x64
dystrybucji z niepustymi `node.exe` i `LICENSE`. Helper sprawdza PE AMD64
i rzeczywistą wersję w istniejącym zakresie 24.18–24.99, zamraża inventory
SHA-256 przed produkcyjnym buildem i odrzuca zmienione wejścia przed kopią.
Kopia Node trafia do `bin`, licencja do `share/licenses`; oba pliki są
wymagane przez layout i zapisane w metadanych MSI. Node uczestniczy
w planowaniu DLL closure i audycie PE. Staged version oraz hashe są
sprawdzane po audycie. Workflow przekazuje operatorową zmienną root.

Launcher statycznego Control Room wybiera `bin/node.exe` bezpośrednio.
Developerski frontend oraz starsze eksporty zachowują istniejącą ścieżkę
Node z PATH. Uszkodzona obecna kopia bundled nie uruchamia fallbacku.

## Dowody i granice

`scripts/test_windows_node_runtime_package.py`: 13 PASS. Jedna próba
kopiuje rzeczywisty Windows Node v24.19.0 i uruchamia go z pustym PATH;
używa frontdoor CLI helpera inspect/stage, identycznego jak MSI.
licencja w tej próbie jest jawnie fixture i nie kwalifikuje legalności
dystrybucji. Pozostałe przypadki sprawdzają odrzucenie braków, pustych
plików, złego PE, niedozwolonej wersji, względnego root, zmiany wejść,
inventory path escape, niekompletnego inventory, konfliktu stagingu
i nakładających się drzew source/stage.
61 istniejących regresji FEM assembly oraz 15 storage PASS.
Końcowe testy metadanych powtórzono dla PowerShell 5 i 7 po dodaniu
asercji inventory Node, obowiązkowego bin i licencji: 2 PASS.

Oddzielny odczyt rzeczywistego Node przez MSVC dumpbin i wspólny parser
PE potwierdził AMD64 oraz 11 importów sklasyfikowanych jako OS, bez innych
zależności. SHA-256 Node:
`3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`.
To diagnostyka tej konkretnej kopii, nie clean-machine qualification.

`just check-cli-source`: PASS, produkcyjny native Windows Cargo check
bez unit tests i solverów. Receipt:
`storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/cli-source-check/8d1af716b672400481094831ece7edaf/receipt.json`.
Exit 0, `source_changed_during_run=false`, SHA-256 receipt:
`672512235c55ecc4d86efc0d8fe980599fc531485b542417ad10413fa297290e`.
Dowód dotyczy kompilowalności źródeł CLI, nie uruchomienia zmienionego CLI.
Niezależny scoped review źródeł, testów i dokumentacji: brak blockerów
P0/P1; zachowano granice dowodu oraz otwarte bramki kwalifikacji.

Brak pełnego buildu MSI i zatwierdzonego SDK/executora; nie podano fake
runtime root jako konfiguracji produkcyjnej. CPython i jego Windows wheels
nadal wymagają osobnego bundle. Clean machine, prawdziwa licencja/signature,
pełny CLI/UI/WebGL i runtime czterech lane'ów pozostają NOT VERIFIED.
Sesja 3104, obce zmiany i aktywne zasoby pozostały bez zmian. P8 pozostaje
otwarty; nie awansowano procentów całego planu.
