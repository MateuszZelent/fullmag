# FEM K0 eigensolve — głęboki audyt kodu i fizyki (2026-08-29)

Ten katalog jest modularną wersją pełnego audytu. Audyt wykonano statycznie względem `master` `9d7bd3191959513ad31879a9c5ccecaa48e28558`; nie wykonano świeżego solve ani profilu GPU, ponieważ bieżący czysty checkout GitHub Actions zatrzymuje się na błędnych symlinkach.

## Części

- [Audyt: konkluzja, zakres, fizyka i architektura](./01-executive-scope-physics-architecture.md)
- [Audyt: rejestr problemów SCM i ABI](./02-findings-scm-and-abi.md)
- [Audyt: problemy fizyczne linearizacji](./03-findings-physics.md)
- [Audyt: problemy numeryczne](./04-findings-numerics.md)
- [Audyt: wydajność i Poisson-airbox](./05-findings-performance-and-poisson.md)
- [Audyt: GPU, artefakty, identity i telemetria](./06-findings-gpu-artifacts-identity-telemetry.md)
- [Audyt: testy, UI, werdykt i referencje](./07-findings-tests-ui-and-verdict.md)

## Najważniejszy werdykt

**NO-GO** dla claimu produkcyjnego CPU/GPU, pełnego okna, Q1/Q2/Q3 i bezpośredniego merge historycznego rescue. Dokument rozdziela 50 ustaleń na błędy P0/P1, ograniczenia bounded oracle oraz brakujące dowody kwalifikacyjne.
