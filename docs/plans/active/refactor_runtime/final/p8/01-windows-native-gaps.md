# P8-C — natywny produkt Windows, luki i kolejność zamknięcia

Data: 02.10.2026. Wymaganie operatora: Windows bez Docker Desktop, WSL i Linuxa.
Status całej bramki: NOT VERIFIED. Audyt źródeł nie jest kwalifikacją runtime.

| Kolejność | Luka i źródła | Wymagana zmiana | Dowód zamknięcia |
|---|---|---|---|
| 1 | Launcher budował CLI/API bez UI: `scripts/windows/run_fullmag.ps1`; `control_room.rs::open_in_tauri` wymaga `fullmag-ui.exe`. | Wykonano source increment: osobny build `fullmag-desktop` bez solver CUDA feature, hash/UI manifest i fail-closed przed launch. | 16 regresji PS/Python i 6 kontroli źródeł PASS; aktualny build oraz rzeczywiste okno nadal NOT VERIFIED. |
| 2 | `crates/fullmag-fem-sys/build.rs` emituje Unix rpath także dla targetu MSVC. Wielokonfiguracyjny CMake nie otrzymuje jawnego `--config`. | Linkowanie według targetu Cargo, Windows import library i ścieżka wybranego config; osobne runtime DLL staging. Zachować Linux rpath i ABI. | Build Windows CPU z właściwą `.lib`/DLL; brak Unix linker flags. Osobny Linux regression build. |
| 3 | `native/CMakeLists.txt` rozpoznaje external FDM jako `.so`; launcher Windows używa DLL. | Imported target z target-aware library/runtime paths; nie uznawać DLL za import library MSVC. | Configure/link z Windows `.lib` i DLL, istniejący Linux `.so`; brak fałszywego discovery. |
| 4 | Natywny launcher odrzuca FEM; `run_fullmag_fem.ps1` uruchamia Linux container. | Natywny dependency bundle MFEM/hypre/libCEED i odpowiednie adaptery Windows dla CPU, następnie CUDA GPU; osobno potrzebne workflow dependencies. | Native FEM CPU i FEM GPU receipts, requested/resolved execution oraz wymagane bramki fizyki. GPU bez cichego CPU fallbacku. |
| 5 | `build_windows_msi.ps1` publikuje tylko manifesty FDM; brak FEM dependency bundle. | Pakować zweryfikowane native binaries, import/runtime dependencies, statyczne UI i Python; nie kopiować Linux libraries. Usunąć niekontrolowane fallbacki i uporządkować staging przez resolver. | Instalacja na czystym Windows i dependency inventory/hashes; brak Docker/WSL/Linux w ścieżce wykonania. |
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
