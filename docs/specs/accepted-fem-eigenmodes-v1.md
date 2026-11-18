# Specyfikacja: Zaakceptowane FEM Eigenmodes (v1)

## Cel
Wdrożenie wysokowydajnego solvera dla eigenmodów w układach FEM, eliminującego wąskie gardła synchronizacji.

## Wymagania techniczne
1. **Floquet k≠0:** Pełna obsługa dyspersji dla k≠0.
2. **Wsparcie GPU (CUDA):** Przeniesienie kluczowych operacji algebraicznych na GPU.
3. **Redukcja synchronizacji (A4):** Eliminacja zbędnych wywołań `cudaDeviceSynchronize`.
4. **PETSc/cuDSS:** Wdrożenie wsparcia dla cuDSS w PETSc 3.24.6 (zgodnie z `https://petsc.org/release/docs/manual/petsc-cuDSS-support.html`).

## Wymagania wydajnościowe
- **Baseline:** Porównanie wydajności z wersją `origin/master`.
- **Target:** Redukcja czasu wykonania o co najmniej 30% w testach `just fem-gpu-headless`.
- **Metryki:** P50/P95 z wykorzystaniem Nsight Systems.
