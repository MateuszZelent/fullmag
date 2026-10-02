# P6-68 — obowiązkowy kompletny pakiet accepted runtime

## Problem i zmiana

Kontrola `REQUIRED_OUTPUTS` w `scripts/local_runner/build_entrypoint.py`
wcześniej akceptowała pakiet zawierający tylko CLI, API, Python core,
marker lane i frontend. Brak schedulerów, preparera, workerów lub poolów
nie blokował statusu `succeeded`, mimo że publiczna trasa accepted FEM ich wymaga.
Instalacja tych programów została wcześniej uzupełniona w P6-64c.

Kontrola wymaga teraz także niepustych plików:

- `bin/fullmag-api-accepted-worker`
- `bin/fullmag-api-accepted-supervisor`
- `bin/fullmag-api-accepted-scheduler`
- `bin/fullmag-api-resource-pool`
- `bin/fullmag-api-accepted-fem-preparer`
- `bin/fullmag-api-accepted-fem-preparation-scheduler`
- `bin/fullmag-api-preparation-resource-pool`

Brak pliku, symlink albo zerowy rozmiar obowiązkowego outputu kończy walidację
błędem przed publikacją sukcesu. Wymóg dotyczy wszystkich trzech profili release,
które używają wspólnej instalacji `make install-cli-dev`; nie zmienia wyboru lane
ani nie rozszerza kwalifikacji fizyki.

## Dowody

- Dwie nowe regresje na baseline: FAIL z właściwej przyczyny — siedem braków
  binariów i pusty preparer były akceptowane.
- Po poprawce `python -B -m unittest scripts.test_local_runner_build_entrypoint`:
  **18 testów PASS**, exit 0, 02.10.2026.
- Python wykonano z `PYTHONDONTWRITEBYTECODE=1`; nie kompilowano ani nie
  uruchamiano natywnych testów jednostkowych i nie wykonywano buildu solvera.
- Spójność nazw obowiązkowych binariów z instalacją `makefile` i deklaracjami
  `crates/fullmag-api/Cargo.toml`: **7/7 PASS**; scoped `git diff --check`: PASS.
- Niezależny source review: **PASS, brak P0/P1**. Regresje uruchamiają profil
  FEM CPU; wspólna walidacja ma zastosowanie do pozostałych profili, ale nie
  stanowi dowodu ich wykonania.

## Granice odbioru

To jest source gate kontroli pakowania. Zmiana repozytorium nie dowodzi,
że operatorowo wdrożony trusted entrypoint runnera zawiera ten kod. Przed
wykorzystaniem nowego buildu trzeba sprawdzić tożsamość wdrożonego entrypointu
oraz każdy wymagany artefakt w terminalnym receipt: niezerowy rozmiar i hash.
Nie zmieniano konfiguracji ani obrazu aktywnego koordynatora.

Managed build nadal czeka na pojemność storage. Native execution,
SolutionSet/materialized dataset/pin i kwalifikacja naukowa pozostają
**NOT VERIFIED**. P6-60/P6-61 oraz cały plan pozostają otwarte.

Review wskazał oddzielną rozbieżność portable/MSI: skrypty pakowania oczekują
także `accepted-fem-preparation-supervisor` i `preparation-retry`, których
bieżąca instalacja nie obejmuje. Ten przyrost nie dowodzi kompletności tych
tras dystrybucji; ich lista programów wymaga osobnej kontroli konsumentów.

Kontrolę konsumentów oraz uzupełnienie tych dwóch programów w instalacji i
required outputs opisuje [P6-69](69-preparation-supervisor-retry-packaging.md).
Historyczny wynik 18 testów dotyczy powyższego przyrostu P6-68; późniejszy
wynik oraz nadal otwarte bramki dystrybucji pozostają w osobnym checkpointcie.
