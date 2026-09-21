# P0 — protokół zapisu i bezpieczne wznowienie weryfikacji

Status: implementacja źródłowa w trakcie weryfikacji, 2026-09-20. Ten opis nie jest dowodem trwałości danych ani zgodą na GC danych użytkownika. Stan bramek: [03-implementation-status.md](03-implementation-status.md).

## Granice protokołu

`SessionStore` i jego CAS współdzielą natywną blokadę jednego writera. CAS otwarty pod nazwą `objects` używa właściciela katalogu nadrzędnego także wtedy, gdy plik blokady jeszcze nie istnieje. Operacje wieloplikowe utrzymują `WriteTransaction` przez całą publikację. Kernel utrzymuje własność deskryptora; PID, wiek i heartbeat są informacją diagnostyczną, a nie upoważnieniem do przejęcia.

`WRITER.lock` ma stałą tożsamość pliku. Rekord właściciela `WRITER.owner.json` jest osobnym atomowo publikowanym dokumentem. Sam rekord nie zastępuje blokady natywnej. Stary `LOCK`, obcy niezakończony owner lub nieznany schemat wymagają kontrolowanego odzysku. Nie usuwać ich na podstawie wieku.

Publiczny `write_document` zapisuje tylko `project/`. Wewnętrzny importer jest używany po pełnym preflight archiwum. Checkpoint wymaga zgodnych ID, własnej ścieżki common state, zgodnego kroku/czasu i kompletnego grafu zadeklarowanych danych. Istniejący marker checkpointu blokuje późniejsze nadpisanie jego dokumentów. Checkpointy z tego samego kroku mają różne identyfikatory.

Publikacja zapisuje unikalny plik tymczasowy, synchronizuje dane i dopiero potem zmienia nazwę. Kolejność checkpointu to payload/CAS → common state → walidacja grafu → marker. Manifest sesji ma niezmienną generację; `CURRENT` zmienia się dopiero po zapisaniu generacji. Czytelnik nie traktuje katalogu bez markera jako opublikowanego checkpointu.

## GC i ingest

- Domyślne `session gc` tworzy podgląd. Nie usuwa danych.
- Apply wymaga jawnego katalogu i pliku wcześniej przejrzanego planu. Pod jedną blokadą ponownie wyznacza graf i generację repozytorium. Zmiana źródeł lub kandydatów unieważnia plan.
- Wspólny walker obejmuje manifesty, runy, checkpointy, common state, deskryptory, chunks, deklarowane backend/aux refs i recovery. Brakujący, uszkodzony lub nieznany root blokuje sweep; nie jest ignorowany.
- CAS zakłada pin przed publikacją blobu, aby GC nie wszedł między ingest a commit checkpointu. Niepewne piny pozostają zachowane.
- Pin może zostać wycofany dopiero po potwierdzeniu referencji przez niezmienny checkpoint. Referencja wyłącznie w mutowalnym recovery/run manifest nie wystarcza.
- W P0 nie ma automatycznego odzyskiwania miejsca z osieroconych pinów. To jawne ograniczenie pojemności, preferowane wobec nieudowodnionego usuwania. Przyszłe odzyskiwanie wymaga planu wskazującego dokładne obiekty i dowodu braku aktywnego ingest.

Nie uruchomiono GC na danych użytkownika. Przykłady regresji używają wyłącznie syntetycznych katalogów tymczasowych.

## Import, eksport i zgodność

Preflight sprawdza nie tylko nazwy ZIP, lecz również identyfikatory w treści manifestów, tożsamość run/checkpoint i hashe danych. Walidacja portable paths odrzuca traversal, ścieżki absolutne, nazwy zarezerwowane Windows i istniejące linki/reparse points. Root jest zaufanym wyborem operatora; ta implementacja nie zapewnia ochrony przed wrogim lokalnym procesem, który może równocześnie podmieniać składniki ścieżki. Taki model zagrożeń wymaga dodatkowego handle-relative IO.

`unpack_fms` wymaga pustego, izolowanego docelowego store. Istniejący API importer przygotowuje staging. CLI odmawia nadpisania zajętego domyślnego store; pełna zamiana aktywnego projektu i rollback należą do P1. Po przerwanym imporcie nie promować częściowego katalogu i nie ponawiać importu w tym samym katalogu jako rzekomo pustym.

Eksport do pliku używa unikalnego stagingu obok celu; błędy przed końcowym rename zachowują dotychczasowe archiwum. Eksport zachowuje dokumenty projektu, a dane CAS dobiera z grafu rzeczywistych referencji. Puste deskryptory i brak restart payload nie stanowią dowodu resume. Inspekcja nie przyznaje `ExactResume` bez sprawdzenia zgodności z docelowym runtime.

## Platformy i wynik niepewny

Przed inicjalizacją writera odbywa się sprawdzenie filesystemu. Nieznane/network FS nie otrzymują automatycznie statusu wspieranego. Dopuszczenie lokalnego FS do operacji nie jest kwalifikacją awarii zasilania.

Na Unix wykorzystywane są file sync i directory sync. Na Windows dostępne w tej implementacji file sync nie dowodzi trwałości wpisu katalogowego po utracie zasilania. `power_loss` pozostaje `Unverified` na każdej platformie do wykonania właściwej kwalifikacji. Zabicie procesu sprawdza zwolnienie lease, nie power loss.

Błąd synchronizacji po udanym rename ma wynik niepewny: plik może już być opublikowany. Caller powinien zachować tożsamość operacji, ponownie odczytać docelowy dokument i porównać ID/hash, zamiast automatycznie tworzyć nowy checkpoint lub raportować brak zapisu. Nie usuwać docelowego pliku w reakcji na taki błąd.

## Kontrolowany odzysk i następne bramki

1. Zachować katalog i stan źródeł; odczytać `CURRENT`, marker, owner i log błędu bez modyfikacji.
2. Ustalić rzeczywistego właściciela i brak aktywnego procesu/lease; sam brak PID lub stary timestamp nie wystarcza.
3. Pod natywną blokadą sprawdzić graf, schematy i hashe. Niepełny graf pozostawia apply zablokowany.
4. Przy niepewnym rename porównać stan docelowy z zamierzoną generacją/ID/hash. Wynik oznaczyć jako opublikowany, nieopublikowany albo nadal niepewny na podstawie odczytu; nie zgadywać.
5. Katalog po niepełnym imporcie zachować do diagnozy; kolejną próbę kierować do nowego izolowanego stagingu. Kasowanie pozostałości wymaga osobnego, dokładnego planu i upoważnienia.
6. Regresje `p0_store`, `p0_archive` i fault injection wykonano po scoped zgodzie użytkownika: [minimalny odbiór](05-minimal-gate.md) zapisuje wynik 70 passed na Windows. Osobno pozostają rzeczywiste scenariusze power-loss i kwalifikacja innych filesystemów/platform. Ten odbiór nie przyznaje automatycznie gwarancji nowemu adapterowi projektu P1.

Nie wprowadzono automatycznego „repair”, kradzieży blokad ani kasowania starego stagingu. Nieukończony odzysk pozostaje jawną blokadą publikacji P0/P1.
