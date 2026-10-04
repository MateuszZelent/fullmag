# P6-C — strumieniowy eksport osiągalnych obiektów CAS

Data: 30.09.2026
Status: **SOURCE IMPLEMENTED / REVIEW PASS / API SOURCE CHECK PASS / TESTS NOT RUN / MEMORY QUALIFICATION NOT VERIFIED**.

## Usunięta alokacja

`fms.rs::plan_cas_entries` wczytywał cały namespace `objects/sha256` do mapy
bajtów, następnie ponownie wczytywał wybrane obiekty do `PackEntry<Vec<u8>>`.
Peak RAM zależał także od dużych obiektów nieobjętych eksportem.

Plan zachowuje teraz tylko ścieżkę, digest i zweryfikowaną długość CAS.
Skan całego namespace sprawdza nazwy, regular files, containment i linki,
bez wczytywania zawartości. Katalog jest walidowany przed `read_dir`, także
gdy jest pusty lub jest dangling link. Wybrane CAS refs są sortowane.

`reachability::walk_export_documents` korzysta z tego samego ArchiveWalker
i typed validators co dotychczasowe `walk_archive_documents`. Rozwiązuje
CAS z plików tylko dla wybranego grafu run/solution. Binarny obiekt i chunk
są strumieniowo hashowane; długości solution artifacts i tensor chunks nadal
muszą odpowiadać manifestom. Brakujący obiekt oznacza incomplete; przed
publikacją pozostaje obowiązkowe `require_complete()`. Unknown reference
zachowuje incomplete po weryfikacji bajtów i nie tworzy uproszczonego grafu.

`cas::copy_verified_file` kopiuje do ZIP przez bufor 64 KiB, ponownie liczy
hash oraz sprawdza planned length. Wzrost, skrócenie lub zmieniony digest
dają błąd. Dopiero poprawne wpisy pozwalają wykonać `zip.finish()`.
Istniejący `pack_fms_file` zachowuje sibling staging, sync i atomową
publikację; błąd nie zastępuje poprzedniego pliku docelowego.

## Jawny budżet i kompatybilność

Structural CAS JSON (descriptor, common state, backend/integrator/RNG payload)
jest czytany pojedynczo, z limitem zawartości 16 MiB. Przekroczenie budżetu
powoduje jawny błąd eksportu; nie obcina się ani nie przelicza danych.
Historyczny poprawny strukturalny JSON większy od limitu nie uzyskuje
automatycznej kompatybilności z tą trasą. Wymaga jawnej obsługi/chunkowania
lub następnego kontraktu budżetu. Unknown CAS nie jest materializowany.
Limit zawartości nie jest deklaracją peak RAM 16 MiB: parser i allocator
mają własny koszt, a pomiar pozostaje otwarty.

Nie zmieniono archive schema, zakresu ArtifactPolicy ani globalnych limitów
100 000 entries / 64 GiB. Publiczny mapowy walker i preflight zachowują
dotychczasową trasę; nie jest to bounded importer.

## Dowody

- Rust parser nowych fragmentów i scoped diff check: PASS.
- Read-only review: PASS po korekcie walidacji katalogu i obsługi Unknown.
- `just check-api-source`: PASS, exit 0, bez kompilacji testów ani solverów.
  Receipt `b66bfad2ab794b799c1c14a25096314f`,
  schema `fullmag_api_source_check_v1`, state `passed`,
  `source_changed_during_run=false`.
- Receipt przypina bieżące źródła współdzielonego dirty checkoutu:

| Plik | SHA-256 przed/po kontroli i obecnie |
|---|---|
| `cas.rs` | `0a44a702fdb3048b7748e262284789e1e7b5b705162826b9abf1a60da338978e` |
| `fms.rs` | `44b845f248894fb0a52d8ed4a2fb9c3a858cbc0c8f7d443d03708989c1a902fb` |
| `reachability.rs` | `bbce5d1207a2585ef1823cae2c90e934d09c924bb465db68e205361329ce23b0` |

Nie jest to deklaracja identycznego clean HEAD; istniejące obce formatowanie
w fms/reachability pozostaje poza commitem tego przyrostu.

Authored regresje obejmują pełne bytes/digest i maksymalny rozmiar write,
odmowę niewłaściwej planned length, zły hash, zgodność file-backed/mapowego
grafu, pominięcie nieosiągalnego CAS oraz odrzucenie zmienionego osiągalnego
obiektu. Testy **NOT RUN** zgodnie z zakazem kompilacji jednostkowych.
Istniejący test roundtrip archiwum pozostaje częścią przyszłej bramki;
nie uruchomiono go dla tego przyrostu.

## Pozostałe bramki P6-C

Dokumenty run/solution/journal/checkpoint nadal są materializowane jako Vec,
a preflight FMS wczytuje całe archiwum. Kolejne kroki muszą strumieniować te
źródła i import oraz zmierzyć peak RAM dużego datasetu, checksum cost,
throughput, partial/corrupt i slow-reader. Sam limit write nie dowodzi peak RAM.

Writer transaction chroni współpracujących mutatorów. Klasyczny race między
walidacją ścieżki a otwarciem dla wrogiego lokalnego procesu nie jest zamknięty
przez tę poprawkę; potrzebny byłby osobny kontrakt uchwytów/no-follow.
Hash i długość dotyczą rzeczywiście kopiowanych bajtów. Arbitralny writer
przekazany do `pack_fms` może zawierać częściowy wynik po błędzie i musi
zostać odrzucony przez callera; publikacja plikowa używa stagingu.

P6 pozostaje **52%**. Przyrost usuwa nieograniczoną materializację binary CAS
w eksporcie, ale nie zamyka całej bramki bounded I/O ani release qualification.
