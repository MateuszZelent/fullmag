# ADR 0083: Zaakceptowane FEM Eigenmodes

## Status
Zaakceptowane

## Kontekst
Optymalizacja solvera FEM dla eigenmodów (wartości własnych) w Fullmag jest kluczowa dla wydajności symulacji magnetycznych. Obecna implementacja cierpi na nadmiarowe synchronizacje hosta (`cudaDeviceSynchronize` w punktach krytycznych) oraz nieefektywne zarządzanie pamięcią między procesami CPU i GPU. Audyty (A1-E2) wskazują na potrzebę głębokiej refaktoryzacji ścieżki solvera.

## Decyzja
Zastosowanie podejścia opartego na fuzji kerneli (`H_eff`) oraz asynchronicznych operacjach CUDA (strumienie) dla ujednolicenia ścieżki obliczeniowej. Wykorzystanie biblioteki cuDSS (PETSc 3.24.6+) jako preconditionera GPU dla przyspieszenia konwergencji.

## Konsekwencje
- **Zalety:** Znaczne skrócenie czasu symulacji, lepsze wykorzystanie zasobów GPU.
- **Wady:** Zwiększona złożoność kodu źródłowego, konieczność rygorystycznej kontroli synchronizacji strumieni.
