# P6-C — preflight ZIP bez kopii całego skompresowanego źródła

Data: 30.09.2026
Status: **SOURCE IMPLEMENTED / API SOURCE CHECK PASS / REVIEW PASS / TESTS NOT RUN / MANAGED BUILD NOT VERIFIED / MEMORY QUALIFICATION NOT VERIFIED**.

## Trasa produkcyjna

`preflight_fms` nie wczytuje już całego skompresowanego archiwum do Vec przed
utworzeniem ZipArchive. `ArchiveSource` mapuje Read+Seek na okno od pozycji
wejściowej callera do EOF i zachowuje offsety względem tego okna. Kontroluje
przepełnienia, seek poza okno oraz zakres odczytu metadanych.

Wspólny preflight używany przez inspect/unpack i importer API najpierw czyta
końcówkę ZIP (maksymalnie 22 + 65 535 bajtów), a potem pojedyncze rekordy
central directory. Sprawdza długość komentarza EOCD, obecność i zakres ZIP64,
spójność obu deklaracji, single-disk, rozmiary, liczbę wpisów, nazwy, kolizje
case-fold, portable namespace oraz sumę declared uncompressed bytes.
Signature wewnątrz komentarza nie jest bezwarunkowo uznawana za EOCD.
ZIP64 locator jest interpretowany także bez sentinel w standardowym EOCD,
aby alternatywna deklaracja nie omijała budżetu. Rekordy nie mogą nachodzić
na EOCD/ZIP64. Arytmetyka offsetów i sum compressed bytes jest checked.

Przed dekodowaniem każdej pozycji jej nazwa i compressed/uncompressed sizes
z biblioteki ZIP muszą zgadzać się ze zwalidowanym katalogiem. CRC, CAS hash,
script hash i typed closure pozostają obowiązkowe. Zmiana nie pisze nic do
SessionStore przed dotychczasowym preflight; checkpoint publication nadal
następuje po danych. Caller nadal odpowiada za stabilne źródło Read+Seek;
nie ustanowiono nowego kontraktu snapshotu wrogiego mutable pliku.

## Budżet i kompatybilność

Central directory ma limit 64 MiB; ZIP64 end record ma taki sam limit.
Pojedynczy odczyt variable metadata jest ograniczony przez trzy pola u16
(name, extra, comment), a tail przez komentarz EOCD. To limity formatu/parsera,
nie twierdzenie o peak RAM. Skan i biblioteka zachowują katalog wpisów.
Globalne limity 100 000 entries / 64 GiB pozostają obowiązujące.

Eksport ma odpowiadający konserwatywny budżet katalogu: 46 bajtów nagłówka,
name bytes i 28 bajtów rezerwy ZIP64 na wpis. Nie emituje entry comments ani
caller extras. Odrzuca nazwę ponad limit u16. Przy granicy eksport może odmówić
archiwum, którego rzeczywisty katalog byłby mniejszy od rezerwy; nie pozwala
natomiast wyemitować katalogu ponad limitem importera.

Historyczne archiwa z metadanymi ponad budżetem, multidisk lub nieprawidłowym
komentarzem nie są automatycznie zgodne z tą trasą. Odmowa jest jawna, bez
truncation. Schema FMS i zawartość prawidłowych dokumentów nie są zmieniane.

## Dowody i pozostała implementacja

`just check-api-source`: PASS, exit 0, bez kompilacji jednostkowych/solverów.
Receipt `486cd2b8dd62491faca16418c809da2f`, schema
`fullmag_api_source_check_v1`, state passed, source_changed_during_run=false.
Źródła dirty checkoutu były zgodne przed/po kontroli; obce formatowanie jest
wyłączone ze scoped commita i porównane przez format-normalized parser.

| Plik | SHA-256 |
|---|---|
| `archive_source.rs` | `888df19a451acfaea9130f2313f8dd11c3c1c2167c89cdb2053b06619d1ffe69` |
| `fms.rs` | `f8f1374444c6249b02028d3e82fce5827484a78fc8b8fbda819b09c1f59836fc` |
| `lib.rs` | `a21ff9f2da5608281ecbef96082012ffc1d86b661bf390c83a59cb4921b03604` |

Authored regresje: okno niezerowego offsetu, wszystkie seek origins,
bounded metadata read dla 4 MiB stored payload, signature w komentarzu,
truncation, ZIP64 overflow/overlap, multidisk i metadata budget.
Testy **NOT COMPILED / NOT RUN** zgodnie z AGENTS.md. Nie wykonano nowego
runtime roundtrip ani pomiaru RAM; source check nie zastępuje tych bramek.

Decoded dokumenty nadal są agregowane przez FmsPreflight, a API nadal posiada
wejściowe bytes uploadu. Następna implementacja musi spoolingować validated
entries do prywatnego stagingu, użyć leniwego typed walker i przenieść CAS,
ordinary documents oraz checkpoint markers strumieniowo. Musi zachować
integrity, destination pristine, cleanup/recovery i atomic publication przed
przełączeniem callera API. StoreWalker/SolutionSetCatalog także pozostają
osobnymi konsumentami parsed history. Pełna bramka P6-C nie jest zamknięta.

Rollback polega na przywróceniu implementacji preflight; nie wymaga migracji
bajtów archiwum ani store. P6 nadal **52%**.

Read-only review: PASS po korekcie actual length i central disk number.
Odczyt decoded entry jest ograniczony do declared size + 1 i wymaga dokładnej
zgodności długości; złe krótsze/dłuższe payloads są odrzucane. Central header
`disk_number_start` musi być zero, także przy sentinel wymagającym innego
codec. Authored regresje obejmują oba kierunki długości oraz central disk 1.
Żadna z tych regresji nie została skompilowana ani uruchomiona.

## Przypięty build produkcyjny — queued

Kod przyrostu: `69e11c75abdea606dd9c709b0fd517742158fe8c`, wypchnięty na master.
Zlecono jeden job `a5b88dbd27414615ae44413357d542b7`,
profil `fem-cpu-release`, request key `p6-seekable-zip-preflight-20260930-v1`,
source **commit** z powyższym pełnym SHA. Digest kapsuły:
`68c623ed240badce16fe4278e4f893c01e7be8daca770646a1ebfb8ee75913c5`.
Capture ID `cb1b45c29562467db1a845f88700c5aa`.

Sprawdzono, że archive_source.rs, fms.rs i lib.rs w kapsule są byte-for-byte
zgodne z plikami tego commita. Build nie korzysta z obcych dirty zmian hosta;
weryfikacja źródeł powyżej obejmowała współdzielony dirty checkout, a build
jest osobną bramką integracji konkretnego HEAD. Kolejka przyjęła zlecenie,
stan ponownego odczytu **queued**, exit code null. Worker jest zdrowy i
wykonuje inny job; nie zatrzymywano go i nie uruchomiono drugiego wykonawcy.
Queued nie jest PASS. Następny krok: terminalny receipt, inventory i source
identity tego samego joba. Testy/runtime/peak RAM nadal NOT VERIFIED.
