# P6-C — odczyt historii SolutionSet po jednej parze rewizji

Data: 30.09.2026
Status: **SOURCE IMPLEMENTED / API SOURCE CHECK PASS / REVIEW PASS / TESTS NOT RUN / MEMORY QUALIFICATION NOT VERIFIED**.

## Usunięta alokacja

ArchiveWalker gromadził wszystkie sparsowane SolutionSet w mapie rewizji.
Po przyroście 34 bajty źródeł były już leniwe, ale parsed history nadal rosła
z liczbą rewizji. Katalog zawiera teraz tylko numer rewizji i ścieżkę.
Walker czyta, waliduje i zwalnia poprzednią rewizję przy przejściu do kolejnej.
Zachowuje current manifest oraz sąsiadującą parę historii; liczba żywych
parsed SolutionSet nie rośnie z długością historii. Kolekcja samych ścieżek
nadal rośnie i podlega limitowi wpisów przy eksporcie.

Zachowano wspólne typed validation, identity/path revision, closure obiektów,
ciągłość numerów od 1 oraz `validate_successor` (w tym terminal immutability).
Current może wskazywać wcześniejszą rewizję, gdy jest z nią dokładnie zgodny;
nie dodano wymagania current=latest. Brak tej rewizji lub konflikt treści
odrzuca archiwum. Nie podnosimy scientific assessment.

Zmiana dotyczy wspólnego ArchiveWalker eksportu i preflight. StoreWalker,
SolutionSetCatalog oraz preflight/import przechowujący bajty całego archiwum
nie uzyskują przez to bramki bounded I/O. Nadal potrzebne są pomiary peak RAM,
throughput/checksum cost, duży dataset i runtime roundtrip.

## Dowody

`just check-api-source`: PASS, exit 0; bez kompilacji jednostkowych i solverów.
Receipt `83ddd1f879f14d1eac57f11fb50ac0bf`, schema
`fullmag_api_source_check_v1`, state `passed`, source_changed_during_run=false.
Poniższe źródła dirty checkoutu zachowują hash przed/po kontroli; obce
formatowanie jest wyłączone ze scoped commita, a format-normalized parser
sprawdza zgodność jego źródeł z kontrolowanym checkoutem.

| Plik | SHA-256 |
|---|---|
| `fms.rs` | `67bc22ddf8b1db6c7fd28db591c5d3b62e7d770dc8b1947530ba0e768f4342a8` |
| `reachability.rs` | `3295a93567db521f65a76102fb44136db2098250a2ec8e05adc6304dd7a63fa2` |

Authored regresja porównuje file-backed i memory graph, zaakceptowanie zgodnego
lagging current, odmowę konfliktu current, luki historii, zmiany execution
identity oraz niezgodnej rewizji w ścieżce. Testy jednostkowe
**NOT COMPILED / NOT RUN**, zgodnie z aktualnym AGENTS.md.

P6 nadal **52%**, pełna kwalifikacja pozostaje otwarta.

Read-only review: PASS; nie wykryto nowego blokera ani regresji w zakresie
leniwie walidowanej historii. Nie jest to wykonanie authored regresji.
