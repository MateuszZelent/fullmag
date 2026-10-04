# P4-B — pula zasobów przygotowania accepted runu

Data: 27.09.2026
Implementacja: `dcf2f13348497f9199b76472b346ff15b2554f9f`

## Zaimplementowany zakres

- `preparation_resource_pool.v1` jest osobnym kontraktem od solverowego
  `scheduler_resource_pool.v1`. Oferta zawiera resource_id i budżet; wymaga
  dodatnich CPU, RAM i storage oraz zerowego VRAM.
- Snapshot puli ma monotoniczną generację, wykrywa zduplikowane resource_id i
  może być pusty, aby zatrzymać nowe admission bez naruszania aktywnych lease.
- Store zapisuje snapshot przez compare-and-swap i waliduje jego tożsamość
  podczas odczytu. Store reachability rozpoznaje typowany plik
  `scheduler_pools/<pool_id>.preparation-resources.json`.
- Nowe binarium `fullmag-api-preparation-resource-pool` publikuje jawne oferty,
  obsługuje dry-run oraz idempotentny replay dokładnie tej samej generacji.
- Atomowe admission lease może wskazać pool_id i zaobserwowaną generację.
  Pod writer lockiem store ponownie sprawdza generację, obecność resource_id i
  identyczny budżet, a następnie wykonuje istniejące kontrole taska oraz
  globalnej wyłączności względem lease solvera i przygotowania.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| `cargo check --locked -p fullmag-session -p fullmag-api --bin fullmag-api-preparation-resource-pool --bin fullmag-api-accepted-fem-preparer` | **PASS** |
| `rustfmt --edition 2024 --check` nowego binarium | **PASS** |
| `git diff --check` i staged diff check | **PASS** |
| Targety testów jednostkowych | **NOT RUN** — aktywny zakaz ich kompilowania |
| Managed process/native FEM E2E | **NOT VERIFIED** |

Nie ma jeszcze rezydentnego schedulera, który wybiera FEM task i wolną ofertę,
ani supervisora/exit receiptu i recovery. P4 pozostaje na **50%**, a cały plan
na około **49%** do czasu dowodu procesu i native runtime.
