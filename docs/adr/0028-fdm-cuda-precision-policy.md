# ADR 0028 — Wersjonowana polityka precyzji FDM CUDA

**Status:** accepted for implementation

**Date:** 2026-08-30

**Decision makers:** Fullmag core

## Context

Pojedyncze `execution_precision=single|double` nie określało precyzji stanu,
lokalnych operatorów, widma FFT ani redukcji. Użytkownik mógł więc wybrać FP32,
ale publiczny model nie potrafił dowieść, czy energie, normy i decyzje
adaptacyjne były akumulowane w FP32 czy FP64. Taki kontrakt nie pozwalał
odróżnić requested intent od resolved i faktycznie executed realization.

Chroniony invariant produktu to jeden Python DSL, jeden `ProblemIR`, jeden
planner i jedna proweniencja dla tej samej fizyki, przy osobnych realizacjach
CPU/GPU. Wymuszony FDM CUDA nie może zmienić precyzji ani przejść na CPU bez
jawnej decyzji użytkownika.

## Decision

Publiczna polityka FDM rozdziela `storage`, `compute`, `fft`, `reduction` oraz
stabilny `realization_id`. Wersja v1 dopuszcza dokładnie:

1. `fullmag.fdm.cuda.precision.full_double.v1` — FP64 dla wszystkich czterech
   składników;
2. `fullmag.fdm.cuda.precision.single_storage_fp64_reduction.v1` — FP32 dla
   stanu, operatorów i FFT oraz FP64 dla redukcji skalarnych.

Python zachowuje coarse `execution_precision` dla prostego stage-first
authoring i udostępnia exact `RuntimeSelection.precision_policy(...)`.
`ProblemIR`, `FdmPlanIR`, natywne ABI, runner i artefakty transportują pełną
politykę. Planner rozwiązuje brak exact-policy deterministycznie z coarse
precision; sprzeczna lub nieznana kombinacja jest błędem przed wykonaniem.

Receipt zapisuje osobno requested, resolved i executed realization. Brak pola,
nieznany enum lub różnica resolved/executed unieważnia dowód. Status capability
może zostać promowany wyłącznie dla dokładnego tuple backend/device/precision/
integrator/interactions objętego czystym, source-bound artefaktem. Dowód
single-grid nie przechodzi na periodic exchange, subcell boundary correction,
termikę, heterogeniczne pola materiałowe ani multilayer FP32.

## Consequences

- Znaczenie `single` jest stabilne i audytowalne, ale nie oznacza pełnego FP32:
  redukcje pozostają FP64.
- CPU reference pozostaje double-only i niezależnym oraclem.
- FDM i FEM nie dziedziczą wzajemnie kwalifikacji precyzji.
- Dodanie kolejnej kombinacji wymaga nowego realization ID, walidacji
  planner/runtime i osobnej kwalifikacji.
- Istniejące skrypty używające tylko `precision="double"` zachowują domyślne
  zachowanie.

## Implementation obligations

1. Zachować zgodne pola w Python DSL, `BackendPolicyIR`, `FdmPlanIR`, C ABI,
   runtime receipt i provenance.
2. Utrzymać produkcyjną numerykę i własność buforów w `backends/fdm`; runner
   pozostaje fasadą planu, ABI i artefaktów.
3. Odrzucać unsupported combinations przed pierwszym krokiem bez silent
   fallbacku.
4. Mierzyć parity pola/RHS/stage/step, długą trajektorię, energie, normę, VRAM,
   alokacje hot loop i time-to-accuracy.
5. Wiązać kwalifikację z pełnym commitem, hashem diffu lub czystym source
   identity i rzeczywistym urządzeniem.

## Migration and rollback

Coarse `execution_precision` pozostaje kompatybilnym wejściem i rozwiązuje się
do jednej polityki v1. Nie ma drugiej produkcyjnej ścieżki legacy. Rollback
usuwa publiczną exact-policy i jej promocję, ale nie interpretuje receiptów v1
jako innej kombinacji typów. Checkpoint lub artefakt z nieznanym realization ID
jest odrzucany zamiast konwertowany po cichu.

## Tests and validation

- Python authoring → `ProblemIR` oraz konflikt coarse/exact policy;
- serializacja i walidacja `FdmPrecisionPolicyIR`;
- planner fail-closed dla unsupported combinations;
- stabilny layout i symbol ABI telemetrii;
- actual-device CPU FP64↔GPU FP64 i GPU FP64↔GPU FP32;
- niezależne orakle Newella thin-film i periodic truncated-images;
- trajectory/energy/norm/VRAM/time-to-accuracy i zero steady-state allocation;
- provenance z dokładnym requested/resolved/executed realization.

## References

- `docs/physics/0300-gpu-fdm-precision-and-calibration.md`
- `docs/specs/problem-ir-v0.md`
- `docs/specs/capability-matrix-v0.md`
- `docs/architecture/backend-golden-masterplan.md`
