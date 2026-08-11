# Raport implementacyjny kontraktu kwalifikacji benchmarku GPU

Data: 2026-08-11
Gałąź: `codex/gpu-qualification-bench`

## Wynik

Dodano niezależny walidator artefaktu benchmarkowego FDM multilayer:

- `scripts/analysis/validate_fdm_multilayer_gpu_benchmark.py`;
- `scripts/test_validate_fdm_multilayer_gpu_benchmark.py`.

Kontrakt wymaga pełnej macierzy `cpu_fp64` i `cuda_fp64` dla
`L=1,2,4,8`. `L=16` jest dozwolone jako opcjonalny limit, ale po pojawieniu
się jednej lane wymaga kompletnej pary CPU/CUDA.

Artefakt rozdziela i zachowuje:

- cold kernel setup i cold FFT plan setup;
- warm apply, pair multiply, forward FFT i inverse FFT;
- setup H2D, result D2H oraz warm H2D/D2H;
- peak device memory, planner estimate, tracked residency i kategorie pamięci;
- source commit, dirty-state manifest, scenario/threshold identity oraz
  managed runtime source/binary identity;
- requested/resolved lane, device residency, CUDA/cuFFT/device identity;
- katalog kerneli oraz liczniki `L`, `L` i `L^2`.

Walidator zapisuje strukturalny wynik
`fullmag.fdm_multilayer_gpu_benchmark_qualification.v1`. Brak artefaktu,
niepełna macierz, host-only CUDA, fallback, brak managed identity, warm transfer,
niezgodne liczniki albo niespójne rozliczenie pamięci kończą się
`qualification_status=not_qualified`. CLI zwraca wtedy kod `1`, ale nadal
zapisuje raport z jednoznacznymi reason codes.

Nie zmieniono backendu CUDA, UI, dokumentacji publicznej, storage ani
produkcyjnej receptury agregującej.

## Weryfikacja

- TDD RED: nowy zestaw miał `9 failed` na minimalnym szkielecie API.
- `python3 -m pytest -q scripts/test_validate_fdm_multilayer_gpu_benchmark.py scripts/test_fdm_multilayer_runtime_targets.py`
  — `15 passed`.
- `python3 -m py_compile scripts/analysis/validate_fdm_multilayer_gpu_benchmark.py scripts/test_validate_fdm_multilayer_gpu_benchmark.py`
  — exit `0`.
- kontrola długości linii ponad 100 znaków — brak wyników.
- `ruff` nie jest zainstalowany w środowisku (`No module named ruff`), więc
  nie został zaliczony jako gate.

## Pozostałe bramki

Ten commit implementuje i testuje wyłącznie kontrakt parsera/walidatora. Nie
stanowi świeżego dowodu wykonania CUDA ani kwalifikacji produkcyjnej.

Status runtime pozostaje `not_qualified` do czasu dostarczenia prawdziwego,
immutable managed-runtime artefaktu obejmującego wszystkie wymagane lane i
wartości `L`, z realną tożsamością urządzenia, CUDA/cuFFT, device residency,
telemetrią transferów/FFT/kerneli oraz kategoriami pamięci. Osobnym krokiem
pozostaje podłączenie generatora tego artefaktu do lane-specific managed
benchmarku bez zastępowania istniejącej receptury agregującej.

## Poprawki po przeglądzie

Status przeglądu pierwszego commita: niezaakceptowany. Poniższe zmiany
zastępują pierwotny kontrakt v1.

### Zamknięcie krytycznej luki zaufania

Schema v2 nie posiada ścieżki ustawiającej `qualification_status=qualified`.
Nawet kompletny i wewnętrznie spójny payload z lokalnie wygenerowanym podpisem
ma `contract_status=valid`, ale pozostaje `not_qualified` z blockerem
`trusted_managed_attestation_unavailable`.

Dodany kontrakt przyszłej atestacji wiąże przez SHA-256:

- cały podpisywany payload bez pola atestacji;
- wszystkie rows;
- rows każdej lane osobno;
- per-lane kanoniczne `source_snapshot_sha256`, runtime manifest i runtime binary;
- SHA-256 źródłowego `metadata.json` w każdym row.

Walidator sprawdza algorytm `ed25519`, 64-bajtowy format podpisu i wszystkie
wiązania digestów. Nie ufa jednak żadnemu `key_id` ani podpisowi, ponieważ
zaufany lane-specific managed producer i rejestr kluczy nie są jeszcze
podłączone.

### Kanoniczna proweniencja wykonania

Rows używają formatu rzeczywistego `metadata.json`:

- `requested_execution` z `backend/device/precision/mode/fallback_policy`;
- CPU overall engine `cpu_reference_multilayer`;
- CUDA overall engine `cuda_assisted_multilayer`;
- osobny `fdm_multilayer_transfer_telemetry.execution_shape` równy
  `cuda_assisted_multilayer` z host-authoritative residency;
- osobny `fdm_multilayer_stage_telemetry` dla natywnego etapu D-07 z engine
  `cuda_native_multilayer_demag_v2`, `device_resident_per_refresh`, cuFFT oraz
  licznikami `L`, `L` i `L^2`.

Obecny overall CUDA pozostaje host-authoritative, dlatego każdy strukturalnie
poprawny raport ma dodatkowy blocker
`cuda_native_device_resident_lane_unavailable`. Etap D-07 nie jest już błędnie
przedstawiany jako overall execution engine.

### Telemetria rezydencji, pamięci i pomiarów

CUDA wymaga dodatnich i spójnych count/bytes H2D oraz D2H w proweniencji i
pomiarach, dodatniego peak device memory oraz dodatnich kategorii pamięci.
Jawny `not_exposed_by_runtime_v1` jest legalnym brakiem schematu, lecz zapisuje
osobny blocker kwalifikacji. Zero nie jest traktowane jako dowód rezydencji.

Każda wartość pomiarowa używa
`fullmag.benchmark_measurement.v1` i zawiera:

- `value`;
- zamkniętą jednostkę `ns`, `byte` albo `count` zależnie od pola;
- zamkniętą statystykę `median`, `maximum` albo `exact`;
- dodatni `sample_count`.

Nieznane lub mieszane jednostki, niewłaściwa statystyka oraz zerowa liczba
próbek powodują `contract_status=invalid`.

### Weryfikacja poprawek

- RED: nowe testy atestacji, kanonicznej proweniencji, zerowej telemetrii CUDA
  i wersjonowanych jednostek miały `9 failed, 3 passed` względem kontraktu v1.
- Drugi RED dla blockerów current-overall i kanonicznego absence reason miał
  `2 failed, 11 passed`.
- `python3 -m pytest -q scripts/test_validate_fdm_multilayer_gpu_benchmark.py scripts/test_fdm_multilayer_runtime_targets.py`
  — `19 passed`.
- `python3 -m py_compile scripts/analysis/validate_fdm_multilayer_gpu_benchmark.py scripts/test_validate_fdm_multilayer_gpu_benchmark.py`
  — exit `0`.
- `git diff --check` — exit `0`.

Nie wykonano benchmarku CUDA ani nie przedstawiono produkcyjnej kwalifikacji.
