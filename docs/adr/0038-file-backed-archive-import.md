# ADR 0038 — import archiwów przez prywatny staging plikowy

Status: przyjęta decyzja; implementacja źródeł, kwalifikacja runtime pozostaje otwarta.
Data: 2026-09-30.

## Kontekst

Preflight ZIP przestał kopiować całe skompresowane archiwum, lecz dotychczasowy
`FmsPreflight` nadal przechowuje wszystkie rozpakowane dokumenty w pamięci.
API oraz CLI dodatkowo wykonywały ponowny preflight przed zapisem sesji.
Nieznane dokumenty lub ignorowane pola rekordów grafu mogą ukrywać referencje
CAS i nie pozwalają uznać mark setu za kompletny do GC.

## Decyzja

Produkcyjny import i inspekcja API/CLI używają `preflight_fms_staged` oraz
`FmsStagedPreflight`. Caller wskazuje katalog pod zarządzanym storage.
Rozpakowanie odbywa się raz, w plikach prywatnego katalogu UUID. Każdy plik
otrzymuje fingerprint SHA-256 i długość; CRC/EOF ZIP jest sprawdzany przed
udostępnieniem uchwytu. Walidacja korzysta z tego samego typowanego walkera
co eksport i GC, z leniwymi odczytami dokumentów sterujących do 16 MiB.
Rozszerzenie `.json` samo nie czyni nieznanego pliku dokumentem sterującym.

Przed rozpakowaniem wymagane jest wolne miejsce na dwie kopie decoded data,
16 KiB na wpis i 256 MiB zapasu. Pomiar nie jest rezerwacją między procesami;
błąd zapisu nadal kończy operację. Limit ZIP i skan katalogu pozostają wspólne.

Publikacja kopiuje pliki strumieniowo przez istniejący writer, ponownie sprawdza
hash/długość, utrzymuje pin-before-publication CAS i zapisuje markery checkpointów
po ich danych. Wszystkie lease i uchwyty prywatnego store są zwalniane przed przeniesieniem
jego rootu; owner record nie może być zapisywany przez starą ścieżkę po rename.
`released=true` jest sprawdzane przed przeniesieniem; `WriterReleaseUnconfirmed`
zachowuje prywatny store do kontrolowanego recovery.
Prywatny store jest publikowany atomowym no-replace rename:
Linux `renameat2(RENAME_NOREPLACE)`, Windows `MoveFileExW` bez zastępowania.
Inna platforma lub nieobsługiwany filesystem odmawia publikacji. Niepewność
bariery po rename zachowuje opublikowane dane; staging z niepewnym zapisem
pozostaje do uzgodnienia, zamiast automatycznego usunięcia.

Rekordy sterujące grafem odrzucają nieznane pola. Nieznane ścieżki pod `runs`
i nieinterpretowany stan restartu nie mogą stanowić dowodu pełnego mark setu;
walker zachowuje konserwatywną retencję. Opaque artifacts pozostają danymi,
nie dodatkowymi deskryptorami referencji.

## Zgodność i migracja

Format ZIP, znane pola oraz DTO/OpenAPI nie zmieniają się. Archiwa z dodatkowymi
polami rekordów grafu wymagają jawnej migracji schematu i walkera. CLI `Open`
wymaga nieistniejącego celu; istniejący pusty store także nie jest zastępowany.
API nadal przyjmuje base64 w pamięci: zmiana uploadu jest osobnym zadaniem.
Błędny format lub niepełny wymagany graf daje HTTP 400; błąd storage,
pojemności albo niepewna publikacja daje HTTP 500. DTO odpowiedzi nie zmienia się.
Nieprzejrzysty stan integratora/backendu blokuje pełną kwalifikację checkpointu
oraz profili wymagających complete graph, dopóki nie ma typowanego walkera.

Publiczne `preflight_fms`, `inspect_fms` i `unpack_fms` zachowują dotychczasowy
adapter pamięciowy dla zewnętrznych konsumentów i istniejących testów. Właściciel:
moduł `fullmag-session`. Usunięcie adaptera wymaga migracji wszystkich odbiorców
oraz osobnej decyzji o zgodności publicznego Rust API. Nie przedstawia się go
jako trasy o ograniczonym zużyciu pamięci.

## Walidacja i wycofanie

Wymagane są kontrole źródeł API/CLI, review grafu i publikacji, regresje CRC,
zmiany staged bytes, pokrycia namespace, nieznanych pól, istniejącego celu
oraz niepewnej bariery. Testy jednostkowe pozostają niewykonane do odwołania
bieżącego zakazu kompilacji. Windows wymaga dodatkowego wykonania publikacji
rzeczywistego `SessionStore` po potwierdzonym zwolnieniu `WRITER.lock`. RAM, crash/power-loss i kwalifikacja
całego importu nie wynikają z kontroli kompilacji.

Wycofanie implementacji może przywrócić adapter pamięciowy, z jawnym kosztem
RAM. Nie może przywrócić ignorowania nieznanych referencji ani zastępowania
istniejącego katalogu. Wyniki i cudze katalogi nie podlegają cleanupowi tej zmiany.
