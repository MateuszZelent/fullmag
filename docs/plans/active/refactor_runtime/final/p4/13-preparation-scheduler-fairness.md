# P4-B — trwały kursor fairness schedulera preparacji

Data: 28.09.2026
Implementacja: `3512c3b94`

## Kontrakt

Scheduler accepted FEM preparation odtwarza teraz lokalny checkpoint puli
`scheduler_pool_checkpoint.v1` z osobnej ścieżki
`scheduler_pools/<pool_id>.preparation.json`. Plik nie koliduje z kursorem
schedulera solverów ani z generacyjną pulą zasobów preparacji.

Checkpoint przechowuje monotoniczną sekwencję, aktualnie zaobserwowane RunId i
RunId, od którego ma rozpocząć się następny wybór w tej samej klasie
priorytetu. Kandydaci pozostają najpierw uporządkowani według immutable
`scheduling_priority`; round-robin działa tylko wewnątrz równego priorytetu.
Zmiana członkostwa jest legalna, ponieważ scheduler odkrywa runy z trwałego
store.

Zapis checkpointu następuje po powrocie supervisora. Awaria przed zapisem może
cofnąć fairness o jeden wybór, lecz nie może zgubić ownership ani uruchomić
drugiego preparera: lease, launch intent i exit receipt pozostają
autorytatywne. Recovery istniejącego aktywnego lease nie tworzy nowego ruchu
kursora, ponieważ jego pierwotna kolejność mogła nie zostać trwale zapisana.

Store stosuje writer lock, ciągłość sekwencji i compare-and-swap. Identyczny
replay jest dozwolony, a przestarzała lub konkurencyjna aktualizacja kończy się
fail-closed. Reachability rozpoznaje osobny checkpoint jako lokalny stan
operacyjny; plik nie jest dodawany do przenośnego `.fms`.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| `cargo check --locked -p fullmag-session -p fullmag-api --bin fullmag-api-accepted-fem-preparation-scheduler` | **PASS** |
| Scoped `rustfmt --check` schedulera | **PASS** |
| `git diff --check` i staged diff check | **PASS** |
| Regresja źródłowa izolacji, CAS, zmiany membership i reachability | dodana, **NOT RUN** — aktywny zakaz kompilacji testów jednostkowych |
| Restart/process E2E z dwoma równorzędnymi runami | **NOT VERIFIED** |
| Managed native FEM | **NOT VERIFIED** — Docker Desktop coordinator nie odpowiada |

Przyrost usuwa źródłowy starvation po restarcie, ale nie zastępuje process
E2E. Jawna decyzja retry po failed preparation pozostaje następnym otwartym
krokiem. P4 pozostaje na **50%**, a cały plan na około **49%**.
