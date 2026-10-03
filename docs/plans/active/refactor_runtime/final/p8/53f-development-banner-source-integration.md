# P8-53F — integracja bannera i kontroli źródeł po scaleniu

Data: 03.10.2026. Status: źródła zweryfikowane; restart authoring nadal w realizacji.

## Zmiana

Banner dev zajmuje osobny wiersz nad workspace. Schowanie Inspectora nie jest
blokowane przez banner. Hook obserwuje widoczność dokumentu przez
`useSyncExternalStore`; ukryta karta nie polluje, a powrót do karty nie powoduje
automatycznych ponowień nieobsługiwanego endpointu. Facade i cache pozostają
przypięte do instancji klienta API. Gotowy build jawnie informuje, że komenda
kontrolowanego restartu nie jest jeszcze dostępna.

W `GeometryObjectPanel` rejestracja szkicu poprzedza callback zatwierdzenia.
Kod mutacji pozostał ten sam; zmiana usuwa zgłoszenie lintera dotyczące użycia
deklaracji przed jej definicją. Fixture DOM przechwytuje formularz w efekcie,
zamiast mutować obcy obiekt podczas renderowania. Test DOM pozostaje
NOT COMPILED / NOT RUN zgodnie z obowiązującym zakazem.

Dodano zarządzaną receptę `just doctor-control-room-source`: lokalny React
Doctor 0.9.12, zakres zmian względem HEAD, wynik w kanonicznym storage,
wyłączone zewnętrzne score/supply-chain. Shell przyjmuje wyłącznie zamknięty
kształt wywołania helpera.

## Dowody

Po scaleniu mastera źródła przywrócono z własnej kopii stash, bez podmiany
nowego ekranu startowego. Wszystkie poniższe receipty mają terminalny exit 0:

| Kontrola | Receipt | Wynik |
|---|---|---|
| Produkcyjne TypeScript | `f699742633c849dc9a07fc90fb6cede2` | PASS |
| Pełny lint | `acd61345780f4e96b423cccded56b473` | PASS |
| Higiena API | `0b79060ba6f8410cb14f7173a6f4040b` | PASS |
| React Doctor | `3fe3c6c061214f7eb68d10ef9a21d51a` | 5 plików, brak zgłoszeń |

Profile: `windows-control-room-source-check`, podkatalogi właściwych tras.
Próba równoległego lintu została poprawnie zatrzymana przez zajęty profil;
po zakończeniu typowania lint wykonano sekwencyjnie i przeszedł.

Poprzedni browser na 3197 potwierdził układ bannera, Hide/Show Inspectora,
utworzenie box 200×100×10 nm oraz WebGL bez utraty kontekstu, z buforem
514×304. Ten dowód poprzedza scalanie i nie jest ponowną kwalifikacją jego
nowego UI. Handle uruchomienia 95546 zwrócił terminalne exit 0 oraz zatrzymanie
watchera. Kapsuły, kopie EXE i scratch model pozostają zachowane.

## Pozostaje

Komenda restartu, guard szkiców, autorytatywny drain, instalacja pełnej sceny
przed listenerem, świeży pin oraz przebieg z regionami/materiałami i fault
gates. Ta zmiana nie kończy P8 ani całego planu.
