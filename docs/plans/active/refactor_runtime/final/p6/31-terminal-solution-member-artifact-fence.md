# P6-A — niezmienne artefakty terminalnego membera

Data: 30.09.2026
Status: **SOURCE IMPLEMENTED / REVIEW PASS / API SOURCE CHECK PASS / TESTS NOT RUN / RUNTIME NOT VERIFIED**.

## Problem i korekta

Zamknięty SolutionSet jest niezmienny. W otwartym katalogu istniejący
`validate_member_successor` chronił już tożsamość membera, status terminalny
i dokładne stare artifact refs, lecz pozwalał dopisać nowy artifact do
zakończonego membera. Tę ścieżkę mógłby błędnie wykorzystać importer COW.

Dodano odmowę zmiany liczności artifacts, gdy poprzedni execution_status
membera nie jest Running. Łącznie z istniejącą walidacją starych referencji
i globalną unikalnością ID oznacza to niezmienny zestaw artefaktów.
Running może nadal publikować kolejne immutable refs, także w tej samej
rewizji, która kończy membera. Ocena naukowa pozostaje oddzielnym statusem;
nie zmieniono jej reguł ani coverage. Migracja/postprocessing wymagają własnej
jawnej publikacji zamiast dopisywania do ukończonego producenta.

Reguła działa również przy rekonsyliacji łańcucha rewizji. Historyczny łańcuch
z late artifact append do terminalnego membera nie zostanie uznany za zgodny
z tą regułą; nie przepisuje się ani nie usuwa jego bajtów. Review objął ten
skutek kompatybilności i aktualnych konsumentów. Historyczne łańcuchy nadal
wymagają osobnej kwalifikacji przed promocją.
`runtime-control/solution_set.rs` już wymaga exact immutable payload podczas
terminalnego reconciliation; nie zmieniono go.

## Dowody

- Parser nowego kodu i scoped formatting regresji: PASS.
- Authored publication regression odrzuca dopisanie do terminalnego membera
  przy nadal Open SolutionSet, zachowuje current revision 2 i brak revision 3.
- Druga regresja zachowuje prawidłowe dopisywanie do Running membera.
- Testy **NOT RUN**; nie kompilowano jednostkowych zgodnie z AGENTS.md.
- Read-only review: PASS, bez wykrytego blokera.
- `just check-api-source`: PASS, exit 0. Kontrola `cargo check --locked
  -p fullmag-api --bin fullmag-api` obejmuje produkcyjny katalog session,
  bez kompilacji testów ani solverów. Receipt `db8b3c31d14b4aaa87053256ee880df1`,
  schema `fullmag_api_source_check_v1`, state `passed`.
- SHA-256 `solution_set_catalog.rs` w receipt przed/po kontroli i obecnie:
  `e95c158207f092aa0113991fa0a67c1b20d13ceb08b53087ec3c64702abce0b5`.
  `source_changed_during_run=false`.
- Zmiana powstała po snapshotach pakietów modalnych i adaptera COW;
  nie jest nimi objęta. Kontrola źródeł nie zastępuje testów zachowania,
  managed runtime ani kwalifikacji naukowej.

P6 pozostaje **52%**. Jest to dodatkowa granica trwałej publikacji, nie dowód
migracji historycznych bundles, runtime ani release qualification.
