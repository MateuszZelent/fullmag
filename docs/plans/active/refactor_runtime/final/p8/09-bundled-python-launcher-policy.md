# P8-C — wybór dołączonego Python przez CLI i API

Data: 02.10.2026. Implementacja źródłowa; rzeczywisty runtime NOT VERIFIED.

CLI i API stosują wspólną politykę `fullmag-runtime-control/python_runtime`.
Na Windows obecność executable Python, `_pth` albo `share/version.json`
ustanawia obowiązek dołączonego interpretera. Brak/uszkodzenie podstawowych
plików daje błąd; FULLMAG_PYTHON, venv i PATH nie zastępują pakietu.
Dotyczy także markerów pakietu, którego executable usunięto.

Przed spawn kontrolujemy niepuste podstawowe pliki runtime/DSL i dokładną
konfigurację `_pth` producenta. Polecenie używa `-I -u`, bez PYTHONHOME,
PYTHONPATH i PYTHONUSERBASE; PATH zawiera tylko bin/python aplikacji.
Pełny audyt hashów/ABI i zachowania runtime pozostaje osobną bramką.
API uruchomione z bin instalacji potrafi określić jej root bez checkoutu
buildu, przed FULLMAG_REPO_ROOT. Historyczny layout bin/fullmag + web/.fullmag
także jest pakietem, gdy nie zawiera developerskiego DSL. CLI i standalone
API korzystają z magazynu LOCALAPPDATA/Fullmag lub USERPROFILE/AppData/Local/Fullmag;
brak lokalizacji wymaga jawnego FULLMAG_STATE_ROOT, bez fallbacku do katalogu
instalacji lub temp. Import/export field state używa tego samego rootu
i konfiguracji; flagi interpretera poprzedzają `-m` i argumenty modułu.

Checkout developerski bez markerów pakietu i Linux zachowują dotychczasowy
wybór. Starszy Windows bundle wymagający hostowego Pythona wymaga upgrade,
a nie fallbacku. [ADR 0047](../../../../../adr/0047-native-windows-python-runtime-ownership.md)
zapisuje tę granicę. Nie zmieniamy schematów API, IR, fizyki ani lane selection.

## Weryfikacja

Produkcyjne source checks CLI/API wykonujemy przez istniejące recepty
`check-cli-source`/`check-api-source` i ich wrapper receipt. Kompilują
wyłącznie produkcyjne źródła, bez unit tests i bez natywnych solverów.
Obie trasy: PASS, exit 0, `source_changed_during_run=false`. Receipt zawiera
także nowy moduł; jest dowodem bieżących dirty źródeł, nie kwalifikacji
czystego wydania. Odpowiednie pozostałe dirty zmiany są zachowane.

- CLI receipt: `storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/cli-source-check/69e322349bc74ee78dc8d873229030d6/receipt.json`.
- CLI receipt SHA-256: `f57beaea5bb6c7658b9d1323d2081b34e54e18e5d6f6d433f53a25b9d65480a9`.
- API receipt: `storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/9ea0d2741aa347b89a6b02ce4be1f8af/receipt.json`.
- API receipt SHA-256: `4918f94a6eab10d5470c647ea77890d8b7c45e9bc9d845ac65398071c9f2a69d`.

Cztery testy regresyjne Rust opisują: marker pakietu bez executable i brak
fallbacku, konfigurację polecenia/env oraz odrzucenie zmienionego `_pth`,
historyczny bundle versus checkout DSL i absolutną lokalizację danych użytkownika.
Nie zostały skompilowane ani wykonane — bieżące AGENTS zabrania kompilacji
unit tests. Source check nie jest dowodem tych przypadków w runtime.

Nadal wymagane: rzeczywisty CPython embeddable, aktualny lock, scientific
wheel DLL/PYD, uruchomienie/field-state/Python→IR na gotowym MSI bez Python
użytkownika i bez Docker/WSL, clean install/upgrade/rollback, trwałe sesje
oraz pozostałe bramki pełnego P0–P8. 3104 i cudze zmiany zachowane.
