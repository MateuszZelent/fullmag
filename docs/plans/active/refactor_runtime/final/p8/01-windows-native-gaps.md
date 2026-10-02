# P8-C — natywny produkt Windows, luki i kolejność zamknięcia

Data: 02.10.2026. Wymaganie operatora: Windows bez Docker Desktop, WSL i Linuxa.
Status całej bramki: NOT VERIFIED. Audyt źródeł nie jest kwalifikacją runtime.

| Kolejność | Luka i źródła | Wymagana zmiana | Dowód zamknięcia |
|---|---|---|---|
| 1 | Launcher budował CLI/API bez UI: `scripts/windows/run_fullmag.ps1`; `control_room.rs::open_in_tauri` wymaga `fullmag-ui.exe`. | Wykonano source increment: osobny build `fullmag-desktop` bez solver CUDA feature, hash/UI manifest i fail-closed przed launch. | 16 regresji PS/Python i 6 kontroli źródeł PASS; aktualny build oraz rzeczywiste okno nadal NOT VERIFIED. |
| 2 | Unix rpath, konfiguracja CMake i brak eksportu publicznego C ABI na MSVC. | Wykonano fragment źródłowy: rpath według targetu Cargo, jawny `--config`, MSVC import library w wybranym config lub płaskim Ninja; jawny eksport 86 funkcji i symbolu danych ABI. Runtime DLL staging pozostaje otwarty. | Preprocessing MSVC C/C++: 6 PASS; 2 istniejące source contracts PASS. Pełny Windows link/DLL launch oraz Linux regression build: NOT VERIFIED. |
| 3 | External FDM był rozpoznawany tylko jako Linux `.so`. | Wykonano target-aware imported target: MSVC DLL + `.lib`, MinGW DLL + `.dll.a`, Linux `.so`/`.so.0`; Cargo śledzi moduł CMake. | 12 configure-only cases PASS; actual Windows/Linux link i runtime NOT VERIFIED. |
| 4 | Natywny launcher odrzuca FEM; `run_fullmag_fem.ps1` uruchamia Linux container. | Natywny dependency bundle MFEM/hypre/libCEED i odpowiednie adaptery Windows dla CPU, następnie CUDA GPU; osobno potrzebne workflow dependencies. | Native FEM CPU i FEM GPU receipts, requested/resolved execution oraz wymagane bramki fizyki. GPU bez cichego CPU fallbacku. |
| 5 | MSI ma manifesty tylko FDM i brak FEM dependency bundle. DLL trafiały do `lib`, poza katalogiem startującego EXE. | Wykonano fragment stagingu DLL obok EXE, z inventory/hashami i kontrolą konfliktów. Nadal wymagane transitive dependency closure FEM/CUDA, pełne native binaries/UI/Python oraz staging przez resolver. | 8 regresji PS stagingu PASS; actual MSI/clean install/dependency closure NOT VERIFIED. |
| 6 | Lokalny katalog `local_runner/build_executor.py` obsługuje Linux/container profile; release Windows CI jest inną trasą. | Ustalić zarządzany Windows/MSVC executor albo odrębną kwalifikowaną trasę CI bez publikacji wydania. Nie nazywać profilu Linux dowodem Windows. | Windows target receipt, source snapshot, niepuste artefakty i terminalny exit 0. Zachować zakaz kompilacji unit tests do odwołania. |
| 7 | Windows writer jest zaimplementowany; directory-sync/power-loss nie są kwalifikowane. Scratch session jest również stanem w pamięci. | Zweryfikować lokalny storage, atomowy zapis, lock/recovery, jawne odtworzenie sesji i eksporty. Nie przenosić wymagań Linux 9p na natywny Windows. | New/Open/Save, checkpoint, restart/restore na Windows; ten sam dokument/IDs i zgodne dane, bez synthetic PASS. Power-loss osobny dowód. |
| 8 | Brak dowodu całego produktu bez developer checkout/toolchain. | Clean install/open/upgrade/rollback; wspólne Python/IR/API/UI i cztery lane'y. | Macierz P8-D i pełne bramki z planu głównego; żadna brakująca realizacja nie zostaje ukryta przez zmianę zakresu. |

Źródła niezależnego review sprawdzono w bieżącym checkoutcie; szczegóły
fragmentu launchera i granic testów: [P1/14](../p1/14-windows-native-workspace.md).
`apps/desktop/src-tauri/Cargo.toml` definiuje package `fullmag-desktop` i bin
`fullmag-ui`. Wspólne UI i API nie wymagają osobnego drzewa FDM/FEM.

Istniejący `.github/workflows/release.yml` ma job Windows, ale dispatch tworzy
tag/wydanie i wykonuje cargo test. Nie uruchomiono go dla tej próby.
MSI container jest narzędziem buildu, nie dopuszczoną zależnością użytkownika
produktu. Historyczne native API replay receipts pozostają ważne w swoim
zakresie; nie dowodzą pełnego aktualnego pakietu.

Ochrona pracy: zachowano cudze dirty backendy i aktywną sesję 3104.
Nie provisionowano wolumenu, nie skasowano cache, nie uruchomiono solvera.

## Fragment: linkowanie i publiczne eksporty FEM

02.10.2026: `fullmag-fem-sys/build.rs` pomija Unix rpath dla targetu
Windows, również przy prebuilt `FULLMAG_FEM_LIB_DIR`. CMake otrzymuje
`--config Release/Debug`; dla MSVC sprawdzana jest obecność `fullmag_fem.lib`
w katalogu konfiguracji, następnie w płaskim katalogu generatora Ninja.
Brak import library po buildzie kończy się jawnym błędem.

Nagłówek `native/include/fullmag_fem.h` oznacza wszystkie 86 funkcji oraz
`fullmag_fem_mesh_abi_record_v1` makrem `FULLMAG_FEM_API`. Prywatna definicja
targetu CMake `FULLMAG_FEM_BUILD_SHARED=1` wybiera `dllexport`; konsument
Windows otrzymuje `dllimport`. Poza Windows makro jest puste. Nie zmieniono
sygnatur funkcji, struktur, konwencji wywołania ani semantyki fizyki.
Nie użyto zbiorczego eksportu wewnętrznych symboli bibliotek zależnych.

Weryfikacja: `scripts/test_windows_fem_header_exports.py` uruchamia wyłącznie
preprocesor MSVC `/EP`, dla C i C++, w trzech trybach. Wszystkie 6 przypadków
PASS (MSVC 14.44.35207). Kontrola obejmuje funkcje i publiczny symbol danych.
Poprzedni nagłówek z HEAD nie przechodzi czterech przypadków Windows;
inventory 86 sygnatur pozostaje zgodne. Tryb bez `_WIN32` sprawdza gałąź
makra, nie jest dowodem kompilacji ani runtime Linux.

Dwie istniejące kontrole Python dla propagacji CUDA architectures oraz
release/parallelism do CMake: PASS. `rustfmt --check` i scoped
`git diff --check`: PASS. Te kontrole źródeł nie wykonują skryptu Cargo ani
linkera. Nie kompilowano testów jednostkowych, DLL ani solvera.

Pozostała bramka: zbudowany i uruchomiony Windows FEM z dependency inventory,
DLL staging i provenance oraz regresja Linux z kolejki. Launcher nadal nie
udostępnia natywnego FEM; znalezienie `.lib` nie dowodzi dostępności DLL
przy uruchomieniu. P8-C pozostaje NOT VERIFIED.

## Fragment: rozpoznawanie zewnętrznego FDM

`native/cmake/ImportFullmagFdm.cmake` jest rzeczywistym modułem używanym
przez `native/CMakeLists.txt`. Windows ustawia `IMPORTED_LOCATION` na
`fullmag_fdm.dll`, a `IMPORTED_IMPLIB` oddzielnie na MSVC `fullmag_fdm.lib`
lub MinGW `libfullmag_fdm.dll.a`. Brak któregokolwiek pliku kończy konfigurację
błędem. Katalog nazwany jak biblioteka nie jest akceptowany. Linux zachowuje
preferencję `.so`, następnie `.so.0`. Oba build scripts Cargo śledzą zmianę
modułu przez `rerun-if-changed`.

`scripts/test_native_external_fdm_import.py`: 12 PASS. CMake wykonuje
konfigurację `LANGUAGES NONE`, bez kompilacji/linkowania i bez wykrywania
kompilatora. Pliki bibliotek są jawnie fiksturami: dowód obejmuje rozdzielenie
właściwości imported target i odrzucenie niekompletnych/niewłaściwych ścieżek,
nie zgodność binarną. Poprzedni rzeczywisty blok CMake odrzuca obie poprawne
pary fikstur Windows. Ścieżki ze spacjami są objęte kontrolą.

Runtime staging, dependency inventory, actual link i natywny launch pozostają
NOT VERIFIED. Ten moduł nie przełącza CPU/GPU, nie uruchamia solvera ani nie
wprowadza fallbacku. P8-C nadal otwarte.

## Fragment: DLL obok plików EXE w installerze

`scripts/windows/build_windows_msi.ps1` kopiuje DLL z release oraz wymagany
native FDM CUDA DLL do `bin`. Wcześniej trafiały do `lib`, a MSI dodawał do
PATH tylko `bin`. Ustawienie PATH dla procesów potomnych przez
`control_room.rs::configure_repo_local_library_env` nie rozwiązuje zależności
wymaganej przed wejściem w kod startującego EXE. Katalog programu jest
elementem standardowej kolejności wyszukiwania DLL w Windows:
[Microsoft — DLL search order](https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-search-order).

`Copy-RuntimeDllSet` sprawdza całą listę przed kopiowaniem: wymagane regularne,
niepuste pliki `.dll`; nazwy porównywane bez rozróżniania wielkości liter;
różne hashe pod tą samą nazwą są błędem. Konflikt z istniejącym plikiem
stagingu również zatrzymuje operację przed kopiowaniem. Identyczne duplikaty
są idempotentne. Po skopiowaniu hash jest ponownie sprawdzany; wersja i
manifest stagingu zapisują `runtime_dlls` z relatywną ścieżką oraz SHA-256.
`Test-StagedLayout` ponownie kontroluje te pliki przed tworzeniem MSI.

`scripts/test_windows_msi_dll_staging.py`: 8 PASS. Wykonano rzeczywistą funkcję
PowerShell wyodrębnioną z AST installera, na jawnych fiksturach bajtowych.
Sprawdzono copy/hash, brak pliku, katalog, pusty plik, złe rozszerzenie,
konflikt nazw/hashów, zachowanie istniejącego pliku i identyczne duplikaty.
Nie budowano ani nie instalowano MSI, nie kompilowano unit tests.

To nie jest walidacja PE, ABI ani kompletności zależności tranzytywnych.
Brakujące DLL MFEM/hypre/libCEED/PETSc/SLEPc/CUDA, native FEM build i runtime,
storage governance installera oraz clean install/open/upgrade/rollback
pozostają otwarte. Nie opublikowano wydania.
