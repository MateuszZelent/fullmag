# Checkpoint implementacji R2 — HPC przez MicroLab

Data: 16.10.2026. Branch: codex/microlab-fullmag-r2-20261016. Baza: f9179caf0a0681bdc92c2a87a308be21e9903919 (master w chwili utworzenia worktree).
Commit implementacji i kontraktu: 18ffe83bcf8078278f88ed4bccb14f64a1355f8d.

## Uzgodniona granica

MicroLab jest jedynym brokerem połączenia Fullmaga z HPC. MicroLab odpowiada za uwierzytelniony principal, lifecycle VM/alokacji, connection/transfer grants, quota, audyt i potwierdzony resource envelope. Slurm jest pierwszym schedulerem za MicroLab. Fullmag nie uruchamia klienta Slurma, nie przyjmuje Slurm credentials i nie traktuje request body ani scheduler job ID jako źródła tożsamości lub uprawnień. Repozytorium containers_admin2/amucontainers jest właściwym repozytorium brokera; jego właściciele muszą zatwierdzić API przed S1. Nie ma obecnie dostępu do klastra ani eksportowalnej wersji Fullmaga, więc S7 pozostaje deferred.

## Wykonane w tym branchu

- Dodano propozycję [kontraktu MicroLab–Fullmag v1](../../specs/microlab-fullmag-broker-v1.md) i [planu integracji](microlab-fullmag-integration-skeleton-20261016.md).
- Skorygowano [audyt HPC](multi-project-hpc-execution-20261005.md), [audyt kart](multi-project-tabs-20261005.md) i [HPC Cluster Execution v1](../../specs/hpc-cluster-execution-v1.md), aby MicroLab był providerem Fullmaga, a Slurm schedulerem wyłącznie po stronie brokera.
- Dodano Fullmag-only ArtifactTransferManifestV1 w crates/fullmag-application/src/artifact_transfer_manifest.rs: kanoniczny digest, limitowany JSON, ścisła walidacja metadanych, portable logical names, SHA-256, provenance, kierunek i read-only inputs.
- Dodano build_accepted_output_transfer_manifest w crates/fullmag-api/src/accepted_artifact_transfer.rs: wiąże lokalny manifest z zaakceptowanym RunSpec/Study, dokładnym udanym task/attempt/ownership epoch, opublikowanym output manifestem/katalogiem i zweryfikowanymi obiektami CAS.
- Bieżący producent outputów dopuszcza tylko magnetization JSON i scalar JSON. Odrzuca manifesty z accepted_state_ref lub observation_source, dopóki te referencje nie zostaną przeniesione w jawnej wersji kontraktu. Nie ma producenta input bundles.

## Świadomie poza zakresem tego wycinka

Kod nie implementuje endpointu MicroLab, HTTP klienta, login/token vault, broker scope v2, idempotentnego outbox/reconciliation, allocation state machine, scoped grantów, input/output transfer, chunk/resume, importu, UI/CLI/Python authoringu ani sweep coordinatora. Moduł API nie jest wywoływany przez route. Ten wycinek przygotowuje lokalny kontrakt danych; nie jest providerem HPC.

## Weryfikacja i bramki

- git diff --check: zaliczone po końcowych zmianach.
- just check-api-source: zaliczony dwukrotnie; najnowszy receipt: C:/git/fullmag/storage/builds/fullmag-921bdb8691e88c4c/windows-api-source-check/api-source-check/0565599a03184432a327f26bd69569b7/receipt.json. source_changed_during_run=false.
- rustfmt --edition 2021 --check dla dwóch nowych plików Rust: zaliczony. Szeroki cargo fmt dla całych crate’ów zgłosił liczne różnice w niezmienionych plikach; kontrolę ograniczono do plików zmiany, bez masowego formatowania.
- Retention preview dla dokładnego source-check joba zakończył się błędem Runner API request failed; niczego nie usunięto. Zachowano receipt, log, pusty katalog stagingu i przyrostowy Cargo target. Wolne miejsce C: po kontroli: 27 817 361 408 B.
- Unit/integration tests: nieuruchamiane zgodnie z repozytoryjnym zakazem kompilowania testów jednostkowych.
- MicroLab API/OpenAPI, VM/agent, realny Slurm, multi-user isolation, zdalny transfer, solver runtime, sweeps i walidacja naukowa: NOT VERIFIED.
- Stary dirty worktree C:/git/fullmag/worktrees/multi-project-hpc-r2-20261005 pozostaje zachowany; jego szerokie WIP nie zostało kopiowane ani resetowane.

Następny krok po walidacji źródeł: przegląd kontraktu przez właścicieli MicroLab i zatwierdzenie versioned OpenAPI/auth/lifecycle/transfer semantyki. Dopiero potem można wejść w S1/S2. Nie zgadywać endpointów na podstawie nieopublikowanych plików development.

## Kontynuacja audytu H0 — 16.10.2026

- Ponowny przegląd źródeł wykazał, że rzeczywiste schematy Fullmaga to `run_spec.v1`/`run_spec.v2` i `run_intent.v1` (`crates/fullmag-application/src/run_spec.rs:16-18`, `crates/fullmag-session/src/types.rs:232`). Nie znaleziono implementacji `execution_scope_identity.v1` ani historycznego `authority=slurm`.
- Usunięto z propozycji brokera i planu S0 twierdzenie, że te dwa symbole opisują istniejącą historię kompatybilności. Przyszły scope brokera ma być jawnym, wersjonowanym kontraktem po decyzjach H0; istniejące RunSpec/RunIntent zachowują odczyt.
- `git diff --check` dla tej korekty dokumentacyjnej: zaliczone. Unit tests pozostają nieuruchamiane zgodnie z zakazem repozytorium.
- HEAD worktree przy rozpoczęciu korekty: `bc665c997844aa747a212819571eec889bacabe4`; główny checkout nadal `master` na `f9179caf0a0681bdc92c2a87a308be21e9903919`. PR #185 oczekuje na CI/review, więc integracja na `master` jeszcze nie nastąpiła.

## H0 — granica deploymentu i authority — 16.10.2026

- Dodano [ADR 0060](../../adr/0060-principal-scoped-deployments-and-multi-project-execution.md): pierwszy release ma prywatny Fullmag deployment/SessionStore przypisany do jednego principalu; jeden deployment koordynuje wiele dokumentów i tasków, ale każdy Task/Attempt dostaje osobną allocation, scratch/tmp i output. Wspólny multi-user API jest odłożony do osobnego, kompletnego projektu auth/ACL. MicroLab pozostaje jedyną granicą HPC; Slurm jest ukryty za brokerem.
- Uzgodniono specyfikację zasobów §10 oraz P7-C z R2. Status API MicroLab nadal jest propozycją czekającą na S1; nie twierdzimy, że istnieje provider.
- Źródła uzasadniają migrację: `AppState.current_live_state` w `crates/fullmag-api/src/types.rs:140`; sesyjny header/fencing w `crates/fullmag-api/src/router_v2/middleware/session_scope.rs:13,30,77`; lokalna capability tylko dla NodePolicy w `crates/fullmag-api/src/types.rs:125-126`; pojedynczy frontendowy kontroler dokumentu w `apps/control-room/src/kernel/KernelProvider.tsx:129`.
- Obecny wire compatibility to `run_spec.v1`/`run_spec.v2` oraz `run_intent.v1` w `crates/fullmag-application/src/run_spec.rs:16-18`; `crates/fullmag-session/src/types.rs:232` ma projekcję RunIntent. Nie dodano user identity do RunSpec i nie uznano `x-fullmag-session-scope` za auth.
- `git diff --check`: zaliczone; ręcznie sprawdzono resolution trzech nowych ADR links (P7, HPC plan, compute spec): wszystkie istnieją. Zmiana dokumentacyjna nie wymaga builda; testy jednostkowe nie były uruchamiane.
- HEAD przed tym fragmentem: `c111221ed48fedc43e4b77a44b80f97125c771aa`. Kod authority/session registry, scoped API, multi-document kernel, UI tabs i równoległy runtime nie są jeszcze zaimplementowane ani zweryfikowane.
