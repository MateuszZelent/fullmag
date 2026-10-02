# Natywny Windows: pusty workspace i brakujące bramki

Data: 02.10.2026. Status: fragment launchera zweryfikowany; produkt NOT VERIFIED.

Wymaganie operatora: Windows bez Docker/WSL/Linux. Kontenerowy build 200
nie dowodzi spełnienia tego wymagania.

## Wykonany fragment

`scripts/windows/run_fullmag.ps1` przyjmuje `-RunMode workspace` i wywołuje
istniejące `fullmag ui --web-port <port>` bez ScriptPath. Tryb dev dodaje
`--dev`; static nie dodaje flagi dev. Kontrole tożsamości źródeł, manifestu,
binarnych hashów i statycznych assetów pozostają przed uruchomieniem.
Simulation inputs oraz wymuszone backend/device są odrzucane przed resolverem
i buildem; nie powstaje cichy fallback ani ignorowany intent.

7 lekkich regresji Python/PowerShell PASS (exit 0): wykonanie rzeczywistego
bloku dispatch z atrapą procesu, static/dev argv, oraz pięć prób błędnych
wejść uruchamiających rzeczywisty preflight launchera. Parser PowerShell
potwierdził brak błędów składni. Nie kompilowano testów Rust/TypeScript,
nie wykonywano buildu ani natywnego runtime.

6 istniejących kontroli źródeł launchera również PASS: storage, GPU fail-closed,
staging DLL, source recheck, build=false i sibling CLI/API. Są to kontrole
kontraktu źródłowego, nie wykonanie GPU ani pełnego pakietu.

## Aktualne źródła i ograniczenia

- Writer ma `cfg(windows)` i rozpoznaje lokalny dysk przez GetVolumePathNameW /
  GetDriveTypeW. Linuxowy błąd 9p nie dowodzi braku adaptera Windows.
- Durability ma Windows MoveFileExW no-replace oraz jawnie niedostępną
  portable directory sync. Power-loss pozostaje unverified.
- Natywny launcher odrzuca backend=fem; trasa FEM nadal jest kontenerowa.
- Odczytany istniejący manifest windows-api-fdm-gpu-runtime dotyczy commita
  3dbc2db9eaef660f74c1a541322aec93465cbee9 i dirty snapshotu, bez statycznego UI.
  Nie zaliczono go jako aktualnego pakietu ani nie pominięto walidacji źródeł.
- Odczytany katalog runnera ma profile Linux/container release; brak w nim
  natywnego Windows/MSVC targetu. Pełnego hostowego buildu nie uruchomiono
  poza kolejką. Dostępność zatwierdzonego Windows executora wymaga ustalenia.

Istnieje również job `build-windows` w `.github/workflows/release.yml` na
windows-latest oraz MSI na self-hosted Windows Docker. Nie uruchomiono
workflow release: tworzy wydanie/tag i obejmuje cargo test. To inna trasa
niż brakujący target lokalnej kolejki, a jej obecność nie dowodzi aktualnego
PASS. Historyczny P3/05 potwierdza katalog/replay po restarcie natywnego API;
nie zalicza pełnego produktu, scratch-session checkpointów ani native FEM.

Do zamknięcia: aktualny pakiet Windows, pusty startup i browser proof,
Save/Open/checkpoint/restart/restore na lokalnym storage, natywne FEM
MFEM/hypre/libCEED CPU i CUDA GPU wraz z zależnościami oraz kwalifikacją.
Źródła i test dispatch nie zastępują tych dowodów. Sesja 3104 zachowana.

## Korekta po niezależnym review

Review wykrył P1: wcześniejszy launcher budował CLI/API, ale nie wymagane
`fullmag-ui.exe`. Dla trybów wymagających Control Room dodano do buildu
`fullmag-desktop`, weryfikację wytworzenia UI i jego path/hash w manifeście.
Build=false wymaga istniejącego pliku i zgodnego desktop_binary_sha256;
starszy manifest bez tej informacji jest odrzucany z instrukcją rebuild.
Headless binary-only nie otrzymuje zależności desktopowej.

Aktualne lekkie regresje: 12/12 PASS (exit 0). Pięć nowych przypadków wykonuje
rzeczywiste funkcje PowerShell: poprawny hash, brak pliku, zmieniony plik,
brak hasha oraz pusty plik nawet z poprawnym hashem. Fixture hashujące nie są
binariami ani dowodem otwarcia okna.
Nie uruchomiono ciężkiego buildu ani kompilacji unit tests. Native runtime
i kwalifikacja wszystkich lane'ów nadal NOT VERIFIED.

Drugi review wskazał ryzyko wspólnego `--features cuda` dla desktopu.
Build CLI/API i desktopu rozdzielono na osobne komendy; solver zachowuje
CUDA, desktop nie otrzymuje tej flagi. Cztery regresje wykonują rzeczywistą
konstrukcję komend przez atrapę Invoke-External dla CPU/CUDA z desktopem
i bez. Końcowy zestaw: 16/16 PASS (exit 0), bez kompilacji Rust.
