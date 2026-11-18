# Roadmapa optymalizacji solvera eigensolve FEM (2026-11-18)

Niniejszy dokument przedstawia plan wdrożenia optymalizacji solvera eigensolve FEM na podstawie audytów wykonanych w 2026 roku.

## Tabela pozycji audytu

| ID | Opis | Status |
|---|---|---|
| A1 | Floquet k≠0 i GPU | Planowane |
| A3 | Optymalizacja transferów D2H | Planowane |
| A4 | Redukcja synchronizacji FEM/BEM | Planowane |
| A5 | Wielowątkowość i preconditioner GPU | Planowane |
| A6 | Fuzja kerneli H_eff | Planowane |
| A7 | ACA BEM | Planowane |
| B4 | Obsługa błędów demag | Planowane |
| C1-C4 | Zbieżność, mesh, modalność | Planowane |
| D | Inne interakcje | Planowane |
| E1-E2 | Frequency domain | Planowane |

## Kolejność wdrożenia

### Etap 3: Optymalizacje rdzeniowe (Low-hanging fruits)
- Wdrożenie A3, A4.
- Optymalizacja DMI (patrz: `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu:10-50` w `origin/master`).

### Etap 4: Skalowanie i wielowątkowość (A5, A6)
- Wdrożenie preconditionera GPU dla relaksacji.
- Implementacja fuzji kerneli `H_eff` (`backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu:5-40` w `origin/master`).

## Protokół pomiaru wydajności
- **Headless:** Testy `just fem-gpu-headless` (patrz: `justfile:50-70`).
- **Metryki:** Nsight Systems/Compute dla całego kroku integracji.
- **Porównanie A/B:** Baseline (obecna rewizja) vs. kandydat (optymalizacja).

## Plan wielowątkowości i GPU
Weryfikacja dostępności cuDSS w PETSc 3.24.6: Zgodnie z oficjalną dokumentacją PETSc, interfejs cuDSS jest dostępny w eksperymentalnej formie dla solverów rzadkich bezpośrednich. Wymagana jest weryfikacja stabilności API (źródło: `https://petsc.org/release/docs/manual/petsc-cuDSS-support.html`).
