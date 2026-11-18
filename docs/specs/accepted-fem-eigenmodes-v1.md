# Specyfikacja: Zaakceptowane FEM Eigenmodes (v1)

## Cel
Wdrożenie wysokowydajnego solvera dla eigenmodów w układach FEM.

## Wymagania techniczne
1. Obsługa Floquet k≠0.
2. Wsparcie dla GPU (CUDA).
3. Redukcja synchronizacji Host-Device (A4).

## Wymagania wydajnościowe
- P50/P95 w testach `just fem-gpu-headless`.
