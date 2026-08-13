# Raport Task 10 — preflight planu FDM dla monitora 2D

## Zakres

Dodano ograniczony gate uruchamiany przed startem runtime, walidacją naukową i
smoke browser/WebGL w recipe `run-viewport-2d-planar-monitor-smoke` dla lane
FDM CPU. Gate obniża fixture Python do kanonicznego `ProblemIR`, wywołuje
kanoniczny planner przez opt-in `fullmag plan-json --execution-plan` i dopiero
potem sprawdza rozwiązany `FdmMultilayerPlanIR`.

Walidator wymaga:

- dokładnie dwóch natywnych warstw `planar_film` i `isolation_neighbor`;
- 768/192 komórek dla profilu bazowego oraz 6144/1536 dla profilu refined;
- długości każdej obecnej tablicy `ms_field`, `a_field`, `alpha_field` zgodnej
  z natywną siatką warstwy;
- niejednorodnego, liniowego `ms_field` tylko dla `planar_film`;
- jawnego scalar fallbacku dla jednorodnych `Aex`, `alpha` i `Ms` sąsiada,
  zgodnie z aktualnym kontraktem planera;
- lokalnej maski i legendy `qualification_core` z priorytetem 10;
- dodatniego wspólnego przedziału Z oraz rozłącznych projekcji XY obiektów;
- utrzymania `no_go` dla heterogenicznej lane FDM CUDA.

Odrzucenie przez planner kończy recipe przed science/browser i zachowuje w
diagnostyce surowe stdout oraz stderr planera.

## TDD i weryfikacja

- RED: test importu zakończył się `ModuleNotFoundError`, ponieważ walidator nie
  istniał.
- GREEN: `PYTHONPATH=packages/fullmag-py/src:. .fullmag/local/python/bin/python
  -m unittest scripts.test_validate_viewport_2d_fdm_preflight -v` — 7/7 PASS.
- Obniżenie rzeczywistego fixture Python do `ProblemIR` — PASS: backend `fdm`,
  dwa wpisy geometrii, jedno przypisanie pola materiałowego.
- `git diff --check` dla zmienionych śledzonych plików — PASS.

Nie uruchamiano solvera, managed runtime ani browser/WebGL. Zarządzany wolumen
Cargo `/tmp/fullmag-zfn2-build` ma obecnie 0 B wolnego miejsca, więc świeża
kompilacja CLI jest odroczona do przywrócenia miejsca. Obecny bundle managed ma
commit `e94ff0f3e...` i nie zawiera jeszcze nowej flagi; recipe najpierw wykonuje
`ensure-managed-fem-runtime`, dlatego pełny gate runtime wymaga odbudowanego
bundla ze źródeł zawierających tę zmianę.
