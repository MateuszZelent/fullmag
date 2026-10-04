# P3/P5 — minimalne wymagania zasobowe runu

Data checkpointu: 27.09.2026.

Implementacja: `72049da62f4122c8f240f3984f61b6ec11d04b4d`.

## Zakres

Nowe immutable runy używają `run_spec.v2`. Pole
`requested_execution.minimum_resources` wiąże przyjętą intencję z minimalnym
budżetem CPU, RAM, VRAM i storage. CPU wymaga zerowego VRAM, GPU dodatniego
VRAM, a CPU, RAM i storage muszą być dodatnie. `run_spec.v1` pozostaje
czytelny bez nowego pola; v1 z tym polem oraz v2 bez niego są odrzucane.

Accepted scheduler porównuje klasę urządzenia i wszystkie cztery wymiary
oferty przed pierwszym zapisem queue, claim lub admission. Zbyt mała oferta
zwraca brak przydziału i nie zmienia taska. Odczyt pojedynczego runu i listy
runów udostępnia minima przez OpenAPI v2; typy Control Room zostały
wygenerowane z backendowego schematu.

## Dowody

| Bramka | Wynik | Dowód | Granica |
|---|---:|---|---|
| Source-only API/application/runtime-control | PASS | receipt `206be62e3e324810874101b74477cb2c` | Kompilacja bibliotek i binariów bez targetów testowych. |
| Generacja OpenAPI v2 | PASS | `pnpm --dir apps/control-room generate:openapi-v2` | Schemat zawiera `ProjectRunMinimumResourceBudgetResource`. |
| Generacja typów i klienta | PASS | `generate:api-v2-types`, `generate:api-v2-client` | Artefakty wygenerowane, bez ręcznej edycji. |
| Control Room typecheck | PASS | `pnpm --dir apps/control-room typecheck` | Spójność konsumentów TypeScript. |
| API hygiene | PASS | `pnpm --dir apps/control-room check:api-hygiene` | Brak nowej trasy poza generated/facade boundary. |
| Regresje Rust v1/v2 i CPU/GPU | NOT RUN | testy zapisane w `run_spec.rs` i `scheduler.rs` | Aktywny zakaz kompilowania i uruchamiania testów jednostkowych. |
| Process E2E: za mała oferta → task bez mutacji → poprawna oferta wykonuje | NOT RUN | wymagany kolejny managed proof | Nie wolno zastępować go samą kompilacją źródeł. |

## Granica checkpointu

Kontrakt stanowi admission policy, a nie egzekwowanie zasobów przez system
operacyjny, kontener lub sterownik GPU. Nie mierzy wolnej pojemności hosta, nie
sumuje wielu aktywnych tasków i nie dodaje priorytetów ani backpressure.
Legacy `run_spec.v1` nie otrzymuje wymagań przez zgadywanie.

Po tym przyroście: **P3 85%, P5 65%, całość około 42%**. Procent całości nie
rośnie bez uruchomionego process E2E i dalszych bramek runtime.
