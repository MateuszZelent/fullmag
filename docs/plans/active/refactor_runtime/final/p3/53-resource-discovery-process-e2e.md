# P3/P5 — procesowe E2E lokalnego discovery i lease

Data checkpointu: 27.09.2026.

## Zakres

Dodano zarządzaną receptę `just verify-api-resource-discovery-runtime`, która
sprawdza jeden pełny przepływ na rzeczywistych binariach produkcyjnych:

1. publiczny HTTP Submit przyjmuje immutable `run_spec.v2` z minimalnym
   budżetem CPU, RAM i storage;
2. materializacja zapisuje task i preparation receipt;
3. `fullmag-api-resource-pool` wykrywa pojemność hosta i publikuje generację
   puli do `SessionStore`;
4. rezydentny `fullmag-api-accepted-scheduler` odczytuje pulę, wykonuje
   admission i uruchamia `fullmag-api-accepted-worker`;
5. ponownie uruchomione API pokazuje terminalny stan `succeeded` i zachowane
   minima RunSpec;
6. trwały `resource_lease.v1` dokładnej oferty ma stan `released` i
   niepuste `released_at`.

Fixture jest wersjonowany w
`tests/fixtures/runtime/resource-discovery-run-v2.json`. Bramka buduje wyłącznie
binaria aplikacyjne przez `cargo build --bin`; nie kompiluje ani nie uruchamia
targetów testowych. Receipt wiąże binaria, fixture i wynik ze snapshotem źródeł
przed i po wykonaniu.

Wspólny store zawierał starsze zablokowane runy. Scheduler użył jawnego RunId,
nowego `pool_id` i `--max-tasks 1`, a następnie potwierdził, że wykonany RunId
jest dokładnie RunId-em próby. Dynamiczne discovery zasobów nie wymaga skanowania
obcych runów.

## Dowody

| Bramka | Wynik | Dowód |
|---|---:|---|
| Build czterech binariów produkcyjnych | PASS | `build_exit_code=0`; API, publisher, scheduler i worker zachowane z SHA-256 w receipcie. |
| Publiczny Submit + materializacja | PASS | jeden immutable RunSpec v2, task `accepted/blocked` przed schedulerem. |
| Discovery + publikacja | PASS | generacja 1, dwie oferty; 48 000 CPU millis, 90 612 031 488 B RAM, 18 257 960 960 B storage, GPU `available`. |
| Admission + worker | PASS | `scheduled_count=1`, `run_source=explicit`, `resource_source=store`, worker `completed`, oferta `runtime-61dc4f8fb04345e88920.cpu`. |
| Publiczny readback | PASS | lifecycle `succeeded`, niezmienione `minimum_resources`. |
| Dokładny lease | PASS | stan `released`, `released_at=2026-09-27T11:33:44.127076800Z`. |
| Tożsamość źródeł | PASS | `source_changed_during_run=false`. |

Receipt:
`C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-project-api-runtime\resource-discovery-runtime\61dc4f8fb04345e889207ca3aecaa47a\receipt.json`.

## Granica checkpointu

Dowód obejmuje FDM CPU/double/strict na jednym hoście. Nie kwalifikuje wykonania
GPU, FEM CPU/GPU, zdalnego transportu, limitów wymuszanych przez system
operacyjny, priorytetów, backpressure ani steering. Jedna zwolniona oferta CPU
nie dowodzi jeszcze fizycznego zwolnienia VRAM lub urządzenia w pozostałych
lane'ach.

Po tym przyroście: **P3 87%, P5 72%, całość około 44%**.
