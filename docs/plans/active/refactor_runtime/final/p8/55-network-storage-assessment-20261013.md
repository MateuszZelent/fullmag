# Ocena storage sieciowego — 13.10.2026

## Wynik

Nie kierować następnego aktywnego buildu ani runtime na
`Z:\mateuszz\Fullmag\Storage` w obecnej konfiguracji. Katalog jest dostępny,
ale bieżący resolver odrzuca tę ścieżkę. Storage lokalny i RAM-disk pozostają
bez zmian. Ocena nie stanowi kwalifikacji SMB do aktywnego wykonania.

## Aktualne dowody

- Checkout przy ponownej kontroli: HEAD `499c7c902b40ad7a69e3e03108f26caecb28d3ca`;
  współdzielony checkout zawiera także niezacommitowane zmiany innych zadań.
- `Get-SmbMapping`: `Z:` → `\\150.254.111.3\zfn2`, status `OK`.
- `Test-Path`: wskazany katalog istnieje.
- `Win32_LogicalDisk`: `DriveType=4` (sieciowy), raportowane wolne miejsce
  `12768995573760` bajtów, około 12,77 TB. Raportowane `NTFS` nie zmienia
  sieciowego charakteru dostępu klienta.
- `Path.resolve()` daje
  `\\150.254.111.3\zfn2\mateuszz\Fullmag\Storage`.
- Wywołanie `fullmag_storage.resolve_layout` z nadpisaniem korzenia wyłącznie
  w diagnostycznym procesie odrzucono przed zapisem:
  `FULLMAG_PROJECT_STORAGE_ROOT must not traverse a symlink/junction`.
  Powodem jest różnica między literową ścieżką a rozwiązaną ścieżką UNC;
  nie jest to dowód istnienia junctiona w samym katalogu.
- Brak `.fullmag-storage.json` we wskazanym katalogu. Bezpośredni UNC nie
  rozwiązuje samodzielnie wymagań rejestracji i kwalifikacji storage.
- `.env` nadal wskazuje `C:/git/fullmag/storage` oraz
  `FULLMAG_WINDOWS_VOLATILE_ROOT=R:/fullmag/volatile`.

Nie wykonywano zapisu na udział, testu przepustowości, kompilacji, migracji,
testów blokad SMB ani testów awarii sieci. Historyczny mały test I/O nie
zastępuje tych bramek.

Ponowna kontrola 13.10.2026 potwierdziła dostępność katalogu, rozwiązanie do
tego samego UNC, brak markera oraz odrzucenie przez aktualny `resolve_layout`
(exit code 1). Nadpisanie storage zastosowano tylko w procesie diagnostycznym;
nie zmieniono `.env` ani nie utworzono danych na udziale. Odczyt `Get-PSDrive`
raportował `12768993869824` bajtów wolnego miejsca. Odczyt CIM w sandboxie
był niedostępny; wcześniejszy wynik mapowania nie jest nowym pomiarem CIM.

## Przeznaczenie danych

Ostatnia kontrola w tym wątku: `Get-PSDrive Z` potwierdził mapowanie do
`\\150.254.111.3\zfn2` oraz `12768992034816` bajtów wolnego miejsca.
Sam katalog ma atrybut `Directory` bez wskazanego `LinkType`. Ponowne
wywołanie `resolve_layout(..., profile="windows-native-fdm-cpu-dev")`
z nadpisaniem zmiennej wyłącznie w lokalnym procesie diagnostycznym
zakończyło się kodem 1 i tym samym komunikatem o różnicy ścieżki Z:/UNC.
Nie jest to odmowa systemu Windows ani dowód, że kompilator nie potrafi
zapisywać na SMB: to odmowa bieżącego resolvera Fullmaga. Nie wykonano
benchmarku, zapisu na udział ani zmiany konfiguracji.

| Dane | Ocena |
|---|---|
| Cargo target/cache, pliki pośrednie, aktywny frontend | Pozostawić lokalnie. Brak kwalifikacji aktywnego buildu na SMB; wiele małych operacji i opóźnienia sieci mogą spowolnić iterację. |
| EXE aktywnego runtime, lease, rejestry właściciela, aktywne sesje | Pozostawić lokalnie. Niezbędne są osobne kontrakty blokad, trwałości, awarii połączenia i używanej bazy danych. |
| Odtwarzalne dane kompilatora TEMP | Zachować istniejący RAM-disk R: zgodnie z adapterem Windows. |
| Kopie gotowych pakietów, eksporty i zakończone wyniki | Kandydat na archiwum. Publikacja wymaga jawnej ścieżki, kontroli hashy i poprawnego zakończenia kopii; w tej ocenie nie wdrożono synchronizacji. |
| Ciężki build Linux/FEM bezpośrednio na CIFS | Niedopuszczony przez bieżący kontrakt; zachować zarządzaną trasę ext4. |

## Warunki przyszłego rozszerzenia

### Najnowsza kontrola w tym wątku — 13.10.2026

Ponowna kontrola na `master`, HEAD
`becaf9e8f183b80413f02d181d5a56763e925c57`, potwierdziła:

- `Get-SmbMapping`: udział `\\150.254.111.3\zfn2`, status `OK`.
- Wskazany katalog istnieje; `Get-PSDrive Z` raportuje
  `12768990855168` bajtów wolnego miejsca.
- Aktualne `fullmag_storage.absolute` odrzuca ścieżkę
  `Z:\mateuszz\Fullmag\Storage`, ponieważ `Path.resolve()` zwraca UNC.
  Diagnostyka zakończyła się kodem 0, jawnie przechwytując `StorageError`;
  nie oznacza to pozytywnego preflight storage.
- Brak `.fullmag-storage.json`; bieżąca konfiguracja nadal wskazuje
  `C:/git/fullmag/storage` i `R:/fullmag/volatile`.

Kontrola była wyłącznie do odczytu: bez migracji, zapisu na SMB, benchmarku
ani uruchamiania nowego buildu. Dostępność udziału nie dowodzi wydajności
kompilacji ani trwałości sesji. Rekomendacja dla następnego buildu pozostaje
bez zmian: trwałe dane lokalnie, dane ulotne na R:, SMB jako kandydat
na osobne archiwum gotowych artefaktów.

Nie obchodzić resolvera junctionem ani samą zmianą `.env`. Aktywny profil
sieciowy wymaga jawnego adaptera i decyzji architektonicznej, rejestracji
operatora, sprawdzenia tożsamości udziału, atomowej publikacji, blokad między
procesami/hostami, odzyskania po zerwaniu sieci oraz kontraktu aktywnego
storage sesji. Dopiero potem można mierzyć rzeczywisty przyrostowy build.

Źródła bieżących reguł: `scripts/fullmag_storage.py::absolute` i
`resolve_layout`, `docs/guides/fullmag-build-storage-governance.md`,
`docs/guides/windows-first-development.md`, `.agents/instructions/backend.md`.

### Kontrola na HEAD 9112d38880f45ff85db2bbd82dd5da67b778cb40

Odczyt 13.10.2026: mapowanie Z: ma status `OK`, katalog istnieje,
wolne miejsce wynosi `12768988626944` bajtów (około 12,77 TB).
Bezpośrednia sonda `absolute` potwierdziła odrzucenie ścieżki Z: po
rozwiązaniu do `\\150.254.111.3\zfn2\mateuszz\Fullmag\Storage`.
Wyjątek został przechwycony przez sondę: jej kod 0 oznacza zakończenie
diagnostyki, a nie zaakceptowanie storage. Marker nadal nie istnieje.
Odczyt dwóch ustawień `.env` potwierdził lokalny trwały storage i RAM-disk R:.
Nie wykonano zapisu, migracji, benchmarku ani buildu na SMB.

Wniosek dla następnego buildu: nie przełączać aktywnego storage na Z:.
Udział może być celem osobnej, sprawdzanej kopii gotowych artefaktów,
eksportów i zakończonych wyników. Aktywny build/runtime na tym udziale
pozostaje `NOT VERIFIED` i wymaga obsługi resolvera oraz kwalifikacji
blokad, trwałości i odzyskania po utracie połączenia.

## Dodatkowe granice techniczne — HEAD 48d3893c

Kontrola na `master`, pełny HEAD
`48d3893cca7d7f7fdd0b7408051d3955039318ac`, nie zmieniła `.env` ani
danych udziału. Katalog jest dostępny, mapowanie prowadzi do tego samego
udziału, a bieżący `Win32_LogicalDisk` potwierdza `Z: DriveType=4`
oraz `R: DriveType=3`. Dostęp klienta przez SMB pozostaje sieciowy również
przy raportowanym `FileSystem=NTFS`.

Oprócz opisanej odmowy resolvera istnieją niezależne bramki:

| Obszar | Obecne zachowanie kodu | Znaczenie dla Z: |
|---|---|---|
| Aktywna sesja, CAS i writer runtime | `crates/fullmag-session/src/writer.rs::classify_local_filesystem` na Windows akceptuje `GetDriveTypeW` tylko 2, 3 lub 6; pozostałe typy odrzuca jako niekwalifikowane do session writes. `cas.rs::CasStore::open`, `repository_path.rs` i `runtime_service_startup.rs` konsumują `require_local_filesystem`. | Samo dopuszczenie rootu przez resolver nie dopuści aktywnej sesji na sieciowym wolumenie typu 4. Nie wyłączano tej bramki. |
| Bezpośrednia publikacja archiwum FMS | `crates/fullmag-session/src/fms.rs` sprawdza lokalny filesystem katalogu nadrzędnego przed publikacją. | Kopia zakończonego lokalnego archiwum na udział jest odrębnym przypadkiem od bezpośredniego eksportu na Z:. Nie wykonano żadnego z nich w tej kontroli. |
| Odtwarzalna kopia kompilatora i TEMP | `scripts/windows/volatile_build_storage.py::_validate_root` wymaga na Windows lokalnego dysku fixed/RAM, typ 3 lub 6. | Z: nie może zastąpić R: w `FULLMAG_WINDOWS_VOLATILE_ROOT`. |

To ustalenia ze źródeł i odczytu rodzaju wolumenu; nie są nowym wykonaniem
writerów, pozytywnym preflight udziału ani pomiarem wydajności. Dla następnego
buildu zachować istniejący trwały root na C: oraz TEMP na R:. Aktywne
użycie Z: wymaga osobnego kontraktu i kwalifikacji, obejmujących wszystkie
powyższe bramki, a nie tylko zmiany jednej zmiennej konfiguracji.
