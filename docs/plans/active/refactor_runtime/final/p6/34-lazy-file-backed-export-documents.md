# P6-C — leniwy katalog plików run/solution przy eksporcie FMS

Data: 30.09.2026
Status: **SOURCE IMPLEMENTED / API SOURCE CHECK PASS / REVIEW PASS / TESTS NOT RUN / MEMORY QUALIFICATION NOT VERIFIED**.

## Zmiana

Eksport zachowuje dla dokumentów run/solution wyłącznie względną ścieżkę,
SHA-256 i rozmiar. Usunięto agregację `PackEntry<Vec<u8>>` oraz drugą mapę
kopii tych bajtów w plannerze CAS. Fingerprint pliku i zapis do ZIP używają
wspólnego czytnika strumieniowego CAS z buforem 64 KiB.

`ArchiveDocuments` rozdziela caller-owned mapę pamięciową od katalogu
fingerprintów. Ten sam ArchiveWalker oraz typed validators odpowiadają za
closure eksportu i preflight. Structural JSON jest odczytywany leniwie tylko
dla jawnej roli dokumentu/referencji, z kontrolą fingerprintu. Publiczna
mapowa trasa pożycza slice przez Cow zamiast dodawać kopię każdego payloadu.
`walk_export_file_documents` zastępuje wewnętrzną trasę z przyrostu 33.

Opaque artifact/checkpoint extras są hashowane i kopiowane strumieniowo.
Rozszerzenie `.json` nie uruchamia parsera ani limitu structural JSON.
Unknown typed reference nadal oznacza incomplete i blokuje publikację przez
`require_complete`, bez wczytania nieinterpretowanego payloadu. ArtifactPolicy,
archive schema, compression i zawartość eksportu pozostają zgodne z istniejącą
trasą. Globalne limity nadal wynoszą 100 000 entries i 64 GiB. Każdy katalog
run/solution dodatkowo odrzuca wzrost ponad limit liczby plików przy push;
walidacja całego planu egzekwuje wspólny limit archiwum.

Przed odczytem struktury i ponownie podczas zapisu sprawdzane są planned hash
oraz długość. Zmiana source po inventory, brak pliku albo błędny digest dają
błąd; `zip.finish()` i publikacja plikowa wymagają poprawnego eksportu.
Writer transaction oraz istniejący sibling staging pozostają granicą dla
współpracujących zapisów. Arbitralny writer przekazany do `pack_fms` musi być
odrzucony przez callera po błędzie. Wrogi lokalny path/open race nadal wymaga
osobnego kontraktu uchwytów/no-follow.

## Budżet i otwarte ograniczenia

Structural JSON run/solution/checkpoint/journal ma limit zawartości 16 MiB,
jak structural CAS w przyroście 33. Większy poprawny control document jest
jawnie odrzucany, bez truncation ani automatycznej reinterpretacji jako binary.
To ograniczenie kompatybilności wymaga przyszłego kontraktu chunkowania lub
jawnego rozszerzenia budżetu. Binary artifact może przekraczać ten limit.

Ten przyrost usuwa agregację bajtów plików, lecz **nie dowodzi bounded peak RAM
całego eksportu**. Parser i typed kolekcje zachowują własne alokacje, a walker
nadal utrzymuje parsed historię rewizji SolutionSet do walidacji successor.
Project documents są caller-owned mapą; preflight/import nadal materializuje
archiwum. Otwarte pozostają streaming import, streaming historii, pomiary peak
RAM/throughput/checksum cost oraz duży dataset, corrupt i slow-reader.

## Dowody

- `just check-api-source`: PASS, exit 0, bez kompilacji jednostkowych i solverów.
- Receipt `b4a36dd4e2ee44b09837db772951c222`, schema
  `fullmag_api_source_check_v1`, state `passed`, `source_changed_during_run=false`.
- Hash źródeł przed/po kontroli zgadza się z poniższym stanem dirty checkoutu.
  Istniejące obce formatowanie pozostaje poza scoped commitem; receipt nie
  udaje weryfikacji identycznego clean HEAD.

| Plik | SHA-256 źródła |
|---|---|
| `archive_document.rs` | `4ecdb670636f67a34ddab0cde8ad29a2845c14382ab4dcb3b0ad60b8b12c1a81` |
| `cas.rs` | `0642be28ad0a1d55cd3485f7490a80030d0022834e00a584118cb589df574c10` |
| `fms.rs` | `b5b9eaead37999d5e93a39b1e3cd094466177517676f5f8d607a36b9d7f307ce` |
| `lib.rs` | `709bf947d4fa64b1f02b23ff5c1dd35a8f4e1d0dc3a9c1d1aef3840661ee97b9` |
| `reachability.rs` | `c1b7ddfe58e3e7fda41ee9d4929aaafd8f4bd6fdc33b1cdbb64c9704c9f89e67` |

Authored regresje: file-backed/memory graph parity, zmieniony/missing control
source, odmowa oversized control, opaque `.json` większy niż 16 MiB i odmowa
wzrostu inventory ponad 100 000 wpisów. Testy **NOT COMPILED / NOT RUN** zgodnie
z aktualnym AGENTS.md. Nie zgłoszono runtime roundtrip ani pomiaru RAM.

P6 pozostaje **52%**; pełna bramka P6-C i kwalifikacja wydania są otwarte.

Read-only review: PASS po dodaniu kontroli każdego liścia przed fingerprintem.
Statyczny junction/reparse jest odrzucany przed odczytem; hostile TOCTOU
pozostaje ograniczeniem wskazanym wyżej. Historyczne opaque dodatki checkpointu
poza typed rootem nie uzyskują nowej interpretacji GC przez ten przyrost;
nie deklarujemy zamknięcia pełnej parity GC/export dla nieznanych extras.
