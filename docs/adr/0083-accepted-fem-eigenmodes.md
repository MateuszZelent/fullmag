# ADR 0083: Zaakceptowane FEM Eigenmodes

## Status
Zaakceptowane

## Kontekst
Optymalizacja solvera FEM dla eigenmodów wymaga ujednolicenia ścieżki obliczeniowej i usunięcia zbędnych synchronizacji hosta.

## Decyzja
Zastosowanie fuzji kerneli i poprawnej obsługi zależności strumieniowych CUDA.

## Konsekwencje
Poprawa wydajności w ścieżce GPU przy zachowaniu poprawności fizycznej.
