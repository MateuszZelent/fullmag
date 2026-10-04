# P8-C — wspólna walidacja katalogu danych

Data: 02.10.2026. Status: IMPLEMENTED SOURCE; runtime NOT VERIFIED.

CLI i API przyjmowały względny FULLMAG_STATE_ROOT, podczas gdy desktop
odrzucał go przed utworzeniem logów. Taki override uzależniał zapis od
bieżącego katalogu procesu, a więc mógł kierować dane pod instalację.
Wspólny `python_runtime::validated_state_override` w fullmag-runtime-control
odrzuca niepustą ścieżkę względną. None/pusta wartość zachowuje domyślny
root; ścieżka absolutna pozostaje niezmieniona. CLI, API i desktop konsumują
tę samą kontrolę. Nie zmieniono domyślnej lokalizacji danych ani migracji.

API propaguje ApiError; CLI zachowuje istniejący model startup expect;
desktop zwraca błąd przed utworzeniem logu. Nie wprowadzono nowego endpointu,
zmian OpenAPI/DSL/IR, zależności od Docker/WSL ani silent fallbacku.

Rustfmt check helpera i sidecara PASS; parser API i CLI PASS. Scoped diff
check PASS. Niezależny przegląd: brak P0/P1. Dwie regresje Rust (relative
rejection i absolute/empty/None) są NOT RUN: zakaz kompilacji unit tests.
Nie przypisujemy tym dowodom wykonania aplikacji ani kwalifikacji storage.

## Stan egzekutorów

Read-only vswhere potwierdził zainstalowane Windows MSVC Build Tools 2022.
Cargo/rustc i CMake są dostępne. WiX i uv nie są dostępne w PATH; nie jest
to pełny inventory dysku. Brak skonfigurowanego procesowego prefixu FEM;
gotowego natywnego API nie było w sprawdzonym profilu resolvera. Pakiet
Python i pozostałe operatorowe inputs nadal wymagają przygotowania.

Workflow Windows MSI dla 6166c82a30815413c574d2ef10a9f982c169fff2:
[run 37062432264](https://github.com/MateuszZelent/fullmag/actions/runs/37062432264),
job build-windows-msi PENDING, steps=[] przy odczycie 02.10.2026.
Nie jest to uruchomiony build ani gotowy instalator. Workflow wymaga labeli
self-hosted/windows/x64/fullmag-native-msvc-wix oraz operatorowych inputs.
Nie zastępowano go ciężkim hostowym buildem poza zarządzaną trasą.

Job 210: native-build exit 0; frontend-dependencies exit 0; kompilacja Next
zakończona, TypeScript w toku przy ostatnim odczycie. Nadal bez terminalnego
receiptu i pełnej walidacji artifact hashes. Nie zawiera tej poprawki.

Kolejne wymagane bramki pozostają niezmienione: pełny managed pakiet Linux,
runtime na wspieranym storage, accepted FEM CPU/pin/archive oraz natywny
pakiet Windows z rzeczywistym New/Save/Open/restart/restore bez Linux/WSL/Docker.
3104 zachowane; cały P0–P8 pozostaje otwarty.
