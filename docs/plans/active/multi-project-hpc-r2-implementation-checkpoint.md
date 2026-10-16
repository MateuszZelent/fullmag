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
- Stan przed następnym source slice H0: wire compatibility obejmował `run_spec.v1`/`run_spec.v2` i `run_intent.v1`. Nie dodawano user identity do RunSpec i `x-fullmag-session-scope` nie jest auth.
- `git diff --check`: zaliczone; ręcznie sprawdzono resolution trzech nowych ADR links (P7, HPC plan, compute spec): wszystkie istnieją. Zmiana dokumentacyjna nie wymaga builda; testy jednostkowe nie były uruchamiane.
- HEAD przed tym fragmentem: `c111221ed48fedc43e4b77a44b80f97125c771aa`. Kod authority/session registry, scoped API, multi-document kernel, UI tabs i równoległy runtime nie są jeszcze zaimplementowane ani zweryfikowane.

## H0 source slice — wersjonowany target wykonania — 16.10.2026

- Dodano `ExecutionTargetReference`: `execution_target.v1` rozróżnia `local` i `microlab`; profil MicroLab wymaga `profile_id` oraz dodatniego `profile_revision`. Typ nie przenosi principalu ani credentials.
- Nowe authoringowe zlecenia materializują `run_spec.v3`, a serializowany target wchodzi do pełnego payload fingerprintu. Odczyt v1/v2 zachowuje pierwotny JSON bez pola targetu; brak targetu rozwiązuje się jako local w pamięci.
- API `run_authoring` domyślnie mapuje brak nowego pola na local dla zgodności starych klientów. Obecny runtime-control odrzuca target MicroLab przed trwałym Submit, ponieważ provider i profil nie są zarejestrowane; nie istnieje lokalny fallback.
- CLI zachowuje wybrany target podczas round-trip przygotowanego RunIntent. OpenAPI i generowane TypeScript zostały odświeżone. Schemat wejścia nadal opisuje dynamiczne `run_authoring` jako mapę; pełne typed fields/authoring w UI i Python pozostają do zrobienia.
- Dodano regresje RunSpec v3/fingerprintu, odczytu legacy, domyślnego authoringu oraz odmowy nieobsługiwanego targetu. Nie uruchamiano testów jednostkowych zgodnie z zakazem repo.
- Kontrole zarządzane: just check-cli-source **passed**, receipt c9346d511ce3424c858284ed25731bf5; just generate-api-openapi **passed**, receipt 97fcb49422784355906be38568aa51cf, content_sha256 f5fb6d5f8c8091f05197c2f29a4305e4ad6c409c9755ca6a9ba2fbf360b21ff7, source_changed_during_run=false. Obie trasy kompilują produkcyjne targety, bez targetów testowych.
- `openapi-typescript 7.13.0` i generator klienta zakończyły się sukcesem przy użyciu istniejącej instalacji z głównego checkoutu, zapisując tylko artefakty worktree. Lokalny package typecheck pozostaje `NOT RUN`, bo worktree nie ma `node_modules`; bez instalowania zależności.
- Ten slice nie dodaje MicroLab HTTP/token vault, target catalog, identity authority, API auth/scope, multi-document registry, kart UI, input transfer, sweeps ani runtime HPC. Te warstwy, testy jednostkowe, browser/runtime i kwalifikacja naukowa pozostają `NOT VERIFIED`.
- API hygiene, git diff --check oraz scoped rustfmt check zmienionych źródeł: **passed**. Pełny rustfmt check nadal wykazuje wyłącznie istniejące różnice kolejności eksportów/importów w crates/fullmag-application/src/lib.rs i crates/fullmag-runtime-control/src/study_tests.rs, obecne już w bazowym HEAD. Testy jednostkowe i package typecheck pozostają **NOT RUN** zgodnie z ograniczeniami repo i brakiem node_modules w worktree.

## H0 documentation alignment — 16.10.2026

- Ujednolicono HPC v1, compute-resource spec, ADR 0049/0052 i API v2 z ADR 0060: sesja UI i session-scope nie są tożsamością ani auth; prywatny deployment może zawierać wiele projektów, a Run/Task/Attempt pozostają odrębne.
- Rozdzielono lokalny bilans fizycznego hosta od allocation envelope wydanego przez MicroLab. Fullmag nie rezerwuje hosta HPC poza envelope ani nie łączy się bezpośrednio ze Slurm.
- Dodano H0 przed P7-B/MT-1/2; E6 pozostaje zależne od H0–H3 i akceptacji kontraktu przez właścicieli MicroLab. ADR 0035/0051 pozostają późniejszymi pracami H2/H5.
- To jest wyłącznie wyrównanie dokumentów. Źródła nadal nie ustanawiają uwierzytelnionego principalu ani autoryzacji per resource; MicroLab API, runtime, transfer, UI tabs, sweeps, klaster i kwalifikacja naukowa pozostają niezaimplementowane lub NOT VERIFIED.
- Kontrole tekstu: 30+2+7 dokładnych dopasowań przed zapisem; skan trailing whitespace PASS dla dziewięciu dokumentów, nowe linki H0 PASS (9 targetów), kontrola starych sformułowań PASS. Testów i buildów nie uruchamiano.
- Worktree: codex/microlab-fullmag-r2-20261016, HEAD a2d0786e267cb6123952e70a294db398d411ac9c. Główny checkout pozostał read-only na master/f9179caf0a0681bdc92c2a87a308be21e9903919.
- Stan przed commitem: 10 śledzonych dokumentów zmienionych, bez plików nieśledzonych; po zatwierdzonym odczycie worktree `git diff --check` przechodzi. Zwykły sandbox nie może wykonać Git status/diff poza workspace; zatwierdzona kontrola została wykonana. Ten fragment jest gotowy do zapisu na branchu; PR #185 jeszcze go nie zawiera.
