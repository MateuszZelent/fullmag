# Raport remediacji Task 3

## Zakres

Task 3 domyka źródłowo przypięty format `benchmark.v2`, wiąże go z faktycznie
opublikowanym artefaktem performance receipt v2 i zaostrza identyfikację bundla
używanego przez Nsight.

## Zrealizowane

- Benchmark FEM GPU odczytuje snapshot wyłącznie z końcowego artefaktu runnera
  `performance/fem_gpu_performance_snapshot.v2.json`. Dane z procesu lub
  przedfinalizacyjnego metadata nie są już fallbackiem kwalifikacyjnym.
- Błędny albo nieczytelny plik snapshotu v2 powoduje fail-closed.
- Identyfikacja Nsight ponownie hashuje wszystkie zadeklarowane binaria i
  natywne biblioteki bundla, sprawdza zgodność z manifestem oraz odrzuca ścieżki
  wychodzące poza katalog runtime.
- Niepoprawny bundle tworzy podsumowanie `NOT VERIFIED`, zamiast wyjątku bez
  artefaktu kwalifikacyjnego.
- Receipt kwalifikacyjny wymaga `requested=strict_device`; zwykłe żądanie GPU
  nie jest traktowane jako dowód ścisłej rezydencji.
- Kontrakt `setup_count` odpowiada append-only ABI v2: licznik musi być dodatni
  i nie może przekroczyć `apply_count + 1`.
- Dodano brakujące zakresy NVTX `fem.gpu.setup` oraz
  `fem.gpu.accepted_finalization` dla ścieżki NCG.

## Weryfikacja

- `python -m unittest scripts.test_fem_gpu_benchmark_contract`: **VERIFIED**,
  16/16 testów przeszło.
- `python -m py_compile ...`: **VERIFIED** dla zmienionych skryptów Python.
- `git diff --check -- <pliki Task 3>`: **VERIFIED**, bez błędów; wyłącznie
  ostrzeżenia o konwersji LF/CRLF.
- `python -m pytest -q -p no:cacheprovider scripts/test_capture_fem_gpu_nsight.py`:
  **VERIFIED**, 30/30 testów przeszło. `pytest` uruchomiono z izolowanego
  katalogu tymczasowego, bez instalacji zależności w checkoutcie.
- Managed baseline GPU i capture Nsight: **NOT VERIFIED**. Aktualny fixture
  używa `nonlinear_cg`, natomiast runner publikuje strict receipt i performance
  snapshot v2 tylko dla ścieżki RK. Bez poszerzenia kontraktu receipt na
  direct-minimizer uruchomienie receptury nie może wytworzyć kwalifikującego
  `benchmark.v2` i nie należy maskować tego sztucznym fallbackiem.

## Granica dowodu

Zielone testy źródłowe nie dowodzą przyspieszenia. Promocja fazy wymaga pięciu
zgodnych prób, CPU oracle, kompletnego strict-device receipt, p50/p95 oraz jednej
osi czasu Nsight zawierającej uporządkowane fazy setup -> attempt -> accepted
finalization -> snapshot -> export. Brak któregokolwiek elementu pozostaje
`NOT VERIFIED`.
