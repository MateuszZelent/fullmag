# Propozycja kwalifikacji zawartych dowiązań katalogowych LX

Status: operator zatwierdził implementację i weryfikację. Zmiana jest zastosowana
w źródłach; rzeczywisty preflight pozostaje niezaliczony (szczegóły poniżej).
Dotyczy wyłącznie recovery grupy anteny na porcie 3203 i odczytowego dowodu
izolacji obcych bindów Windows. Nie jest nową polityką solvera.

## Stan i rzeczywista odmowa

Bazowy commit recepty: `a41d4c9cdc46a64ed2d4a1f4ad5f4042636d06f5`.
Bieżący adapter obsługuje zwykłe katalogi i zawarte względne linki do plików,
lecz odrzuca linki katalogowe. Ma przypięte źródła:

| Plik | SHA256 |
|---|---|
| `scripts/docker_windows_bind_isolation.py` | `4411410a48c18b49dbdfb982683853e3937aabb375d4f36680cfea9a74b372dd` |
| `scripts/test_docker_windows_bind_isolation.py` | `910add55d62a518c16c6652143ba19f7d6f19b7cde322da25e45e519c94fe4e7` |

77 testów adaptera i jego integracji z kanonicznym recovery przeszło.
Rzeczywisty preflight nadal odmawia. Dowody w control volume grupy:
`verification/recovery-mount-order-20261028/windows-contained-tests.json`,
`actual-contained-error.log` oraz `contained-provider-1.stderr`.

Konkretna ścieżka odmowy:
`D:/git/fullmag/storage/runs/microwave-antenna-latest-2026090-78aaec16ccf52671/ff4035657e4a40ad84e15ca2a07764a0/execution/node_modules/react-doctor`.
Kernel WSL odczytał następujący względny cel:
`.pnpm/react-doctor@0.9.12_@opentelemetry+core@2.10.0_@opentelemetry+api@1.9.1__eslint@9.39.4_jiti@2.7.0_/node_modules/react-doctor`.
Obserwacja lstat: mode 41471, device 118, inode 281474981481733.
Windows podał atrybuty 1040, bez obsługi Target w Get-Item. Ten odczyt nie
zastępuje kwalifikacji natywnego tagu i całego łańcucha.

Automatyczna kontrola odrzuciła zapis rozszerzenia, uzasadniając:
„zatwierdzony zakres obejmował wyłącznie zawarte względne linki do plików”
i kwalifikując dopuszczenie katalogów jako nieautoryzowane osłabienie ochrony.
Nie ponawiano odrzuconego zapisu inną drogą.

## Dokładny zakres proponowanej zmiany

1. `WINDOWS_PROVIDER` / `Descendants`: pełna enumeracja zwykłych katalogów
   pozostaje. Nie schodzić w żaden reparse. Zbierać plikowe i katalogowe
   dowiązania wyłącznie z dokładnym tagiem LX_SYMLINK `0xa000001d`.
   Junction, UNC oraz pozostałe tagi nadal odrzucać.
2. `_validate_descendants` i `_file_link_paths`: nieopublikowane `file_links`
   zastąpić przez `links: [{path, tag, kind}]`, z kind `file` albo `directory`.
   Zastosować nazwę `_link_paths`. Zachować zamknięte pola, unikalność,
   sortowanie, liczniki i limity: 100 000 wpisów, 256 linków, 15 sekund.
3. `_relative_link_target` i mały `_resolve_link_target`: dopuścić wyłącznie
   wiodące `..`, cofające po znanych zwykłych rodzicach, bez przekroczenia
   korzenia kandydata. Odrzucać `x/../y`, cele absolutne, drive/UNC,
   backslash, colon, znaki kontrolne i niejednoznaczne segmenty.
4. `_qualify_file_links` i `_validate_file_link_evidence`: uogólnić na
   `_qualify_links` / `_validate_link_evidence`. Każdy hop musi występować
   w dokładnym inventory LX, mieć zgodny kind i stabilne lstat/readlink/lstat.
   Rodzice pozostają zwykłymi katalogami na tym samym DrvFs. Końcowy obiekt
   musi być zwykłym plikiem lub katalogiem zgodnym z kind, nadal pod tym
   samym korzeniem i na tym samym urządzeniu. Maksymalnie 16 hopów;
   cykle, nieznane hopy i dowiązania w katalogach pośrednich odrzucać.
5. `_observation` / `validate_windows_bind_disjoint_proof`: użyć nazwy
   `contained_links`; oba pełne odczyty muszą zgadzać się co do natywnego
   inventory, celów, tożsamości hopów i końcowego obiektu. Nie zmieniać
   sprawdzania root FileID, serial, ancestry, backing VHD, nlink ani engine ID.

Dopuszczenie linku nie jest pominięciem walidacji. Zwykłe katalogi docelowe
wewnątrz root są niezależnie objęte pełną enumeracją. Link wychodzący poza
root, zmieniający urządzenie lub prowadzący przez inny reparse nadal blokuje
operację. To dowód obserwacyjny przed/po, bez gwarancji atomowości wobec
złośliwego administratora hosta.

## Ryzyko i obowiązkowe dowody

Błąd kwalifikacji mógłby dopuścić obcy kontener z dostępem do chronionych danych.
Dlatego przed zmianą runtime wymagane są regresje: PNPM z katalogiem docelowym,
wiodące ../../ pozostające pod root, root escape, x/../y, kind mismatch,
niezinwentaryzowany hop, cykl, symlink rodzica, junction/unknown tag oraz drift
celu i końcowej tożsamości. Następnie rzeczywisty preflight pełnych 43 runów
musi przejść bez modyfikowania historii. Fixture nie zamyka tej bramki.

Decyzja dotyczy implementacji i weryfikacji tego ograniczonego rozszerzenia.
Nie obejmuje zmiany obcej grupy, usuwania danych ani promowania zapisanego
wyniku Failed/unassessed do zakwalifikowanej bazy. Build własnego backendu,
probe i recovery pozostają oddzielnymi, przypiętymi krokami już zleconej pracy.
Nie istnieje jeszcze zastosowany patch tego rozszerzenia; niniejszy dokument
jest konkretnym zakresem zmiany po odmowie zapisu, a nie dowodem jej wykonania.

## Weryfikacja po zgodzie operatora — 28.10.2026

Operator odpowiedział „Tak, wdroż i zweryfikuj”. Wdrożono zakres pięciu punktów
powyżej w dwóch plikach adaptera i regresji. 149 testów interpretowanych
adaptera, readmission oraz recovery przeszło (0 błędów i 0 niepowodzeń).
Przegląd źródeł nie zgłosił wymaganych poprawek; późniejsza obserwacja hosta
ujawniła ograniczenia, których te fixtures nie reprezentowały.

Dowody zapisano wyłącznie w control volume własnej grupy, pod
`verification/windows-contained-lx-directory-approved-20261028/`:
`tests.json`, `tests.log`, `actual-error.log`, `literal-error.log`,
`literal-provider-1.stdout`, `literal-provider-1.stderr` oraz
`retained-inventory-error.log`.

Przypięte źródła przetestowanego rozszerzenia:

| Plik | SHA256 |
|---|---|
| `scripts/docker_windows_bind_isolation.py` | `09389c3b0f58ecaa71e8f36331db0ad7ff91efa3801997a9755e90964ed68dad` |
| `scripts/test_docker_windows_bind_isolation.py` | `50fe6e9e7a41a7af751beb668b2c19943c0380ba0158508095447b4c3a27db71` |

Rzeczywiste kontrole nie uprawniają jeszcze do startu:

1. Pełny kanoniczny preflight odrzucił dawne kontenery z bindami zapisanymi jako
   `/run/desktop/mnt/host/d/...` i `/mnt/host/d/...`. Aktualny master zabrania
   traktowania tych ścieżek jako zwykłego dowodu POSIX. Zatwierdzone rozszerzenie
   linków LX nie zmieniło tej bramki ani obcych kontenerów.
2. Oddzielna próba adaptera dla literalnego `D:/git/fullmag/storage` zatrzymała
   się na zapytaniu `fsutil reparsepoint query` dla 264-znakowej ścieżki PNPM
   kończącej się `zustand@5.0.12_@types+react@19.2.14_immer@11.1.8_react@19.2.4_use-sync-external-store@1.6.0_react@19.2.4_/node_modules/immer`.
   Windows zwrócił Error 3. Sam kod błędu nie dowodzi przyczyny ani braku pliku.
3. Ten link istnieje w WSL: device 118, inode 281474981422629, mode 41471.
   Cel `../../immer@11.1.8/node_modules/immer` jest zwykłym katalogiem na device
   118, inode 281474981442328, mode 16877. Windows pokazuje atrybuty 1056,
   czyli ReparsePoint+Archive bez Directory. Natywny typ samego wpisu linku
   nie jest wiarygodną deklaracją typu jego celu. Obecny kontrakt `kind`
   odmówi również po naprawie samego odczytu tagu; nie został poluzowany.
4. Oddzielny odczyt inwentarza zachowanych runów napotkał limit 8192 plików
   w kanonicznym readerze store. Wcześniejszy pełny snapshot obejmował 15 919
   plików. Limitu nie zwiększano i nie zastępowano pełnej bramki częściowym
   wynikiem. Nie uzyskano nowego pozytywnego dowodu dla 43 runów.

Bez nowego buildu, probe, Solve i zmiany stanu usług. Backend 3203 oraz frontend
pozostają zatrzymane; wyniki i pozostałe kontenery zachowano. Ta zmiana źródeł
nie jest dowodem gotowości runtime ani naukowej kwalifikacji pola anteny.

Dalsza naprawa wymaga jawnego, kompletnego dowodu tożsamości aliasów Desktop,
odczytu natywnego tagu LX niezależnego od nieskutecznego `fsutil` dla wskazanego
wpisu, rozdzielenia atrybutów linku od typu jego zakwalifikowanego celu oraz
uzasadnionego limitu inwentarza. Nie wolno pomijać wpisów ani uznawać samego
Linux `lstat` za dowód tagu LX.

Źródła diagnozy: [Microsoft — efekty dowiązań dla funkcji systemu plików](https://learn.microsoft.com/en-us/windows/win32/fileio/symbolic-link-effects-on-file-systems-functions),
[format LX_SYMLINK](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/68337353-9153-4ee1-ac6b-419839c3b7ad),
[odczyt tagów reparse](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-point-tags).

### Poprawka odczytu natywnego i aktualne ograniczenia

Po zbadaniu rzeczywistego linku poprawiono odczyt metadanych w ramach
zatwierdzonej obsługi zawartych katalogów PNPM. `FindFirstFileW` przez publiczny
PInvoke w pamięci zastępuje nieskuteczne zapytanie tagu przez `fsutil`.
Nie uruchamia kompilatora, nie tworzy plików tymczasowych i nie otwiera celu.
Natywne `kind` opisuje wpis linku; dowód zawiera osobne `native_entry_kind`
i `target_kind`, a każdy hop przypina własny natywny typ. Końcowy typ pochodzi
z `lstat` zwykłego pliku lub katalogu na tym samym urządzeniu. Dokładny tag LX,
pełne inventory, containment, cykle, granice hopów i porównanie przed/po
pozostają wymagane. Ten zapis koryguje wcześniejsze założenie, że bit Directory
linku Windows zawsze deklaruje typ jego celu.

Końcowe 152 regresje przeszły (0 błędów, 0 niepowodzeń). Przegląd nie zgłosił
Required. Dokładna funkcja z tych źródeł przeszła rzeczywistą kontrolę w Windows
PowerShell 5 dla wskazanej ścieżki 264-znakowej: tag `0xa000001d`, atrybuty 1056.
Dowody: `native-reader/tests.json`, `native-reader/tests.log`,
`native-reader/ps5-tag-reader.json` pod wskazanym katalogiem kontrolnym.

| Plik końcowy | SHA256 |
|---|---|
| `scripts/docker_windows_bind_isolation.py` | `561cfb05234f47e52e1d64a6398f28ad55fc24620153113095ed2e82dea0a1bd` |
| `scripts/test_docker_windows_bind_isolation.py` | `28d57785fd3a9dcd33bfc5f885feb1297b944091f140712a7b49c942c6c0ce52` |

Pełny adapter zatrzymał się następnie na niezmienionym limicie 256 linków.
Odczytowa diagnostyka rozmiaru starego katalogu, ograniczona do 50 s, naliczyła
830 333 wpisy, w tym 23 996 dowiązań, i nie ukończyła drzewa (139 katalogów
pozostało w kolejce). To dolna granica, nie pełny inwentarz ani dowód izolacji.
Dowód: `native-reader/native-count.stdout`. Nie zwiększono limitów admission.
Samo kosmetyczne podniesienie 256 nie rozwiązałoby ograniczeń całego skanu.

Dokładny odczyt bieżącego accepted store potwierdził 43 katalogi runów,
15 919 plików, 804 katalogi, 537 825 914 bajtów i brak symlinków.
Dowód: `native-reader/accepted-store-count.json`. To pomiar metadanych;
nie zastępuje porównania treści CAS ani pełnego kanonicznego preflightu.

Dalsze recovery wymaga przygotowania skalowalnego, nadal ograniczonego dowodu
Windows oraz osobnego dowodu fizycznej równości aliasów Desktop. Hipoteza
zamiany prefiksu na literę dysku nie jest takim dowodem. Dla store v4 potrzebny
jest osobno uzasadniony limit plików przy zachowaniu dokładnych pinów runów,
SHA, blokad i limitów zasobów. Żadnej z tych nowych polityk nie zastosowano.
Zapisany wynik pola pozostaje Failed/unassessed i `inspection_only`.
