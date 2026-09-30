# Przyrost 42 — właściciel przypiętego tensora w FMS

Data: 2026-09-30. Cel P0–P8 pozostaje aktywny; P6 nadal **52%**.
Kod i kontrakt: `e7c6d28e4a76143a9aaf281b63771835cfefda62`, opublikowany na remote master.

## Wynik

Usunięto P1 integracyjny wskazany w review przyrostu 41. Plan eksportu
dołącza dokładny `runs/<run_id>/run_intent.json` właściciela każdej
eksportowanej rewizji zawierającej `fullmag.tensor.v1`, również poza
`session.run_refs`. Nie zmienia sesji, katalogu ani wyboru SolutionSet;
nie dodaje run manifests, leases ani działającego runtime'u.

Bounded odczyt 16 MiB weryfikuje manifest/path/revision, typed RunIntent,
run ID i digest payloadu względem provenance SolutionSet. Owner entries
mają stabilną kolejność i deduplikację po ścieżce, długości oraz SHA.
Brak lub konflikt właściciela zatrzymuje eksport przed zapisem ZIP.

ArchiveWalker weryfikuje ownera typed tensorów przed publikacją importu,
konsumuje standalone intent i przechodzi jego definition/study/catalog/assets
CAS refs. Root i chunky nadal używają wspólnego typed traversal przyrostu 41.
Opaque SolutionSet zachowuje dotychczasową kompatybilność.

## Dowody

| Bramka | Wynik |
|---|---|
| Produkcyjne źródła API/session/quantities | PASS, exit 0, `source_changed_during_run=false` |
| Niezależny bounded review helpera i ArchiveWalker | PASS, bez blokera P0/P1 w zakresie owner closure |
| Parser/format nowych regresji, scoped diff, UTF-8 isolation | PASS |
| Typed FMS pack/preflight/unpack → resolver oraz dodatkowy owner asset | Regresja źródłowa dodana; NOT COMPILED / NOT RUN |
| Brak ownera przed ZIP; missing/foreign owner przy restore | Regresje źródłowe dodane; NOT COMPILED / NOT RUN |
| Managed runtime, wykonany import/recovery, RAM i nauka | NOT VERIFIED |

Receipt:
`C:/git/fullmag/storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/78995751c9924680befd32ed1deb0d97/receipt.json`.

Aktualizacja: lokalną publication owner barrier wdrożono źródłowo
w [przyroście 43](43-local-pinned-tensor-owner-barrier.md). Poniższy opis
pozostaje historycznym stanem granicy przyrostu 42.

## Otwarte granice

Lokalny `publish_solution_set` nadal może zapisać typed SolutionSet bez
obecnego run intentu. Resolver takiego źródła odmawia, a eksport FMS odrzuca
niepełnego właściciela. Ta bramka publikacji pozostaje następnym wymaganym
krokiem; nie utożsamia się owner closure archiwum z kompletną integralnością
wszystkich lokalnych producentów.

Nie opublikowano MaterializedDataset ani wyniku porównania, comparison API
i consumer UI. Odczyt metadanych nie promuje oceny naukowej ani kwalifikacji.
Legacy memory preflight ZIP oraz nieznane structural schemas nadal mają
ograniczenia wskazane w poprzednich checkpointach.

## Runner i następne kroki

Poprzednie joby zakończyły się `failed`, exit 2:

- source36 `a5b88dbd27414615ae44413357d542b7`: unsafe cache mountpoint;
- source37 `106c264dfe954e6b816a7811bbde2d4b`: brak wymaganego Rust nightly.

Odczytano ich terminalne receipts i ograniczone logi. Ten sam układ mountów
przeszedł kontrolę w job37; nie luzowano fail-closed guard. Storage ma około
16,9 GiB wolnego miejsca. Klient głównego checkoutu zgłasza obecnie
`Container profile allow-list mismatch`; nie obchodzono tej blokady ani
nie wdrażano koordynatora podczas aktywnych zadań.

Następne kroki: lokalna publication owner barrier, durable dataset owner/materializer,
comparison API/client oraz PlotDefinition/export/UI. Unit tests i runtime
wymagają oddzielnych wykonalnych bramek. Cały plan pozostaje niezakończony.

Kontrakt: [Przypięty tensor SolutionSet](../../../../../specs/pinned-solution-tensor-v1.md).
