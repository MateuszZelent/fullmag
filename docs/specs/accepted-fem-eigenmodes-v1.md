# Specyfikacja FEM Eigenmodes v1

## Przegląd
Specyfikacja implementacji solvera opartego na układzie rozszerzonym.

## Wymagania
1. Wsparcie dla MUMPS (CPU) i cuDSS (GPU).
2. Wykorzystanie układu rozszerzonego (q, φ).
3. Spójność z istniejącymi kontraktami residuali.
4. Język implementacji: C++/CUDA dla backendu, Rust dla runnera.
