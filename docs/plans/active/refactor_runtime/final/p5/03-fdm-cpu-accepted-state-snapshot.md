# P5-C — snapshot zaakceptowanego stanu FDM CPU

Data: 28.09.2026

Status: **FDM CPU SOURCE/IN-PROCESS PASS / FULL ACCEPTED STATE REF NOT VERIFIED**.

## Wynik

Prosty lane FDM CPU emituje po finalnym zaakceptowanym stanie artefakt
`solver/fdm_cpu_accepted_state_snapshot.v1.json` o schemacie
`fullmag.fdm.cpu.accepted-state-snapshot.v1`. Snapshot zawiera kanoniczny
`ObservationClock`, `clock_digest`, `state_digest` oraz identyfikator primary
carriera `fdm.cpu.transactional-state-digest.v1`.

Carrier jest dokładnym transakcyjnym digestem właściciela stanu FDM CPU. Wiąże
magnetyzację, czas, pamięć integratora i zaakceptowany interwał thermal RNG.
`state_digest` powstaje przez wspólny `accepted_state_digests`, więc zmiana
receipt'u stanu zmienia tożsamość, a sam zegar pozostaje odrębnym digestem.

Lane nie publikuje snapshotu dla coupled spin transport ani Frozen Spins. Te
konfiguracje mają dodatkowe primary carriers, których nie wolno pominąć ani
rekonstruować. Ich brak daje niedostępność snapshotu, a nie częściową lub
zmyśloną tożsamość.

## Weryfikacja

- kontrakt helpera: **1/1 PASS** — content binding, strict digest i fail-closed
  dla Frozen Spins;
- rzeczywisty krótki przebieg FDM CPU: **1/1 PASS** — artefakt jest emitowany,
  jego krok odpowiada `accepted_step_count`, a digest odtwarza się z
  `checkpoint_digest` receipt'u transakcyjnego;
- scoped `rustfmt`, `git diff --check`, kompilacja runnera i kontrola spójności
  repozytorium: wymagane przed commitem tego przyrostu.

## Granica dowodu

Snapshot nie zawiera jeszcze `run_id`, `stage_id`, `domain_digest`,
`plan_digest` ani lokalnej generacji runtime'u, dlatego nie jest pełnym
`AcceptedStateRef`. Nie dowodzi również publikacji przez API, checkpoint
compatibility, rejected-step rollback poza istniejącym kontraktem solvera ani
managed runtime. Następny krok ma związać snapshot z zaakceptowanym RunSpec,
ProblemIR i resolved planem w durable workerze, bez ponownego uruchamiania
solvera.

P5 rośnie do **92%**, a cały plan pozostaje około **49%**.
