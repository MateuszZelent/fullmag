# Podsumowanie wykonawcze audytu LLG

## Najważniejsze ryzyka przekrojowe

1. Jeden kanoniczny kontrakt musi rozstrzygać `H_eff` versus `B_eff`, skalę `gamma`, obecność `mu0` i czynnik `1/(1+alpha^2)`.
2. Adaptacyjna norma błędu nie może zależeć od liczby komórek/DOF; dla FEM musi uwzględniać miarę, a dla obu metod preferowana jest norma RMS/per-spin lub kątowa.
3. Rejected step musi atomowo przywracać stan, cache, RNG, krok czasu i liczniki outputów.
4. GPU wymaga rozróżnienia requested backend, operator acceleration i pełnego device-resident kroku. Silent fallback jest niedopuszczalny.
5. FDM jest zwykle ograniczony demag FFT i liczbą ocen pola na krok; FEM — assembly, solve/preconditioner i stiffness narzucanym przez `h_min`.
6. Wszystkie bufory stage, plany FFT, formy FEM, restrictions, quadrature data i preconditionery muszą być trwałe w steady state.
7. Produkcyjna kwalifikacja wymaga oracles fizycznych, parity na poziomie RHS/stage/step/trajectory oraz benchmarków time-to-solution przy ustalonym błędzie.

## Raporty

- [FDM CPU](fdm-cpu.md)
- [FDM GPU](fdm-gpu.md)
- [FEM CPU](fem-cpu.md)
- [FEM GPU](fem-gpu.md)
