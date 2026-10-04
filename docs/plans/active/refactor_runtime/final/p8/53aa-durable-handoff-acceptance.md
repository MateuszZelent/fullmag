# P8-53AA — trwała granica zatwierdzenia handoffu

## Zachowanie i granice

`SessionStore::accept_development_handoff` publikuje jednorazowy
`development/HANDOFF-COMMIT.json`. Zapis wiąże UUID API, nonce przejęcia,
referencję i hash kapsuły, docelowy build, binding magazynu oraz pełny fence.
Wymaga kanonicznych UUID, hashów i zgodności bindingu z rzeczywistą lokalną
ścieżką magazynu. Pod WRITER ponownie sprawdza dokładny fence, globalny idle
i brak wcześniejszego zatwierdzenia. Następnie publikuje record, potwierdza
dostępne bariery trwałości i odczytuje identyczną treść.

Zastany marker, również uszkodzony, blokuje kolejne zatwierdzenie oraz zwykłe
`release_development_idle_fence`. Nie ma domyślnego usunięcia, retry publikacji
ani zwolnienia fence po błędzie. Odczyt rekordu jest ograniczony rozmiarem,
odrzuca nieznane pola i weryfikuje tożsamości oraz lokalny binding. Osobna
granica potwierdzonego zakończenia lifecycle pozostaje do realizacji.

Ta operacja przyjmuje referencję już sprawdzoną przez właściciela. Sama nie
waliduje kapsuły, assetów ani kandydata i nie zatwierdza shutdown API. Prywatny
konsument musi zachować guard przejęcia, sprawdzić staging/kandydata, uzyskać
globalny dowód idle i dopiero potem użyć tej granicy. Pełny restart nie jest
udostępniony użytkownikowi; `restart_available` nadal pozostaje `false`.

## Weryfikacja

Zarządzany natywny build produkcyjnych EXE: exit 0. Pierwsza sonda wykryła
różnicę bindingu ścieżki: dotychczasowy resolver do kanonicznego katalogu
dodaje pusty suffix, zachowując końcowy separator. Nowa warstwa początkowo
pomijała separator. Poprawka odtwarza istniejące kodowanie, bez zmiany bindingów
wcześniejszych uruchomień. Powtórzony build i weryfikacja przeszły.

`just verify-windows-development-backend-api`: **129 kontroli**, exit 0,
**34 procesy** z potwierdzonym wait. Receipt względem
`storage/builds/fullmag-0950f4dca4ffe38f`:
`development-backend-api-checks/checks/47609cb01a594df1a1bc4f5e0dcd94ab/receipt.json`.

- Digest backendu przed/po: `22420391bca940c93c7ebe765c465e8036e4705102729e2cbf58aa24fde64ae2`.
- Snapshot buildu: `4a705278489c789c0f684a1f24dad4ca74b07e3c2fa86ecf5ac7919c378a2378`.
- Hash zatwierdzenia sondy: `a5df43f13bd029bbf61b9413a128bf2b38dbb6f4ff04555c62d6415ffecb5441`.

Ukryty natywny CLI używa rzeczywistych produkcyjnych operacji magazynu.
Sprawdza błędne UUID/hashy, poprawnie sformatowany obcy binding, obcy fence,
brak publikacji po odmowie, poprawny zapis/readback, odmowę powtórzenia,
odmowę zwykłego abort i zachowanie rekordu po ponownym otwarciu.
Osobny magazyn z celowo uszkodzonym markerem odrzuca odczyt i ponowne
zatwierdzenie oraz zachowuje fence po próbie abort. Oba magazyny pozostają
zachowane pod katalogiem receipt; nie są danymi użytkownika.

Review źródeł i poprawki bindingu nie znalazł actionable findings.
Nie kompilowano testów jednostkowych. Uszkodzony marker nie jest dowodem
rzeczywistej awarii zasilania; Windows directory power-loss pozostaje
NOT VERIFIED. Istniejący UI na 3197 odpowiadał HTTP 200 bez restartu.

## Następna integracja

Prywatny owner-control API musi połączyć aktualny guard, zweryfikowaną kapsułę
i globalny idle z jednorazowym zatwierdzeniem. Po zatwierdzeniu mutacje mają
pozostać zamknięte również przy utracie ACK. Potrzebne są graceful shutdown,
potwierdzony exit własnego procesu, replacement, odtworzenie przed listen,
nowy pin i hydration szkiców w przeglądarce. ACK ani zamknięty port nie
zastępują wait procesu. Timeout jest nierozstrzygniętym wynikiem, bez
automatycznego powtórzenia commit lub wymuszonego zakończenia procesu.
Procent całego planu pozostaje bez awansu na podstawie tej granicy.
