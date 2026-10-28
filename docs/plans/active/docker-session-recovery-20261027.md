# Odzyskiwanie zatrzymanych grup bez utraty sesji

## Kontrakt

Inwentarz obejmuje dziesięć grup zakwalifikowanych wcześniej jako blocked-recovery. Stara grupa docker-volume-only-implementation została następnie odłożona decyzją użytkownika; jej źródła i pozostałe dane pozostają zachowane. Zachowuje bieżące sesje, wyniki, checkpointy oraz historyczne receipty. Nie uruchamia API ani Solve, nie zatrzymuje działających grup. Migracja nastąpi dopiero przy świadomym uruchomieniu wybranej grupy. Siedem migracji odłożonych osobną decyzją użytkownika pozostaje poza zakresem.

## Naprawa technicznej blokady operacji

`docker_dev.py reconcile-offline-volume` ma domyślnie tryb kwalifikacji. Wykonanie wymaga dokładnego attemptu, digestu Compose, tokenu osieroconej operacji oraz SHA planu. Obsługuje tylko właściciela terminalnego (drained/failed), zatrzymaną prywatną parę backend/frontend, brak helpera i innych konsumentów, brak żywych zadań/rezerwacji oraz zgodne piny zachowanych danych.

Transakcja pod blokadą kontrolną publikuje własny dowód offline, sprawdza CAS i zwalnia wyłącznie marker technicznej operacji. Nie tworzy fikcyjnego stop journal, nie zmienia OWNER, process-tree, katalogów runów ani wyników. Oryginalny receipt activation pozostaje unknown. Nowa aktywacja jest zablokowana; migracja bez skryptu może jawnie konsumować dowód przez `recreate-volume --offline-reconciliation <token>`.

Brak dawnego bridge wymaga wspólnego dowodu: historycznego name+ID w obu zatrzymanych usługach, poprawnej izolacji PID/IPC i portów, dokładnego błędu not-found dla pełnego ID oraz dwóch zgodnych inwentarzy sieci. Błąd demona, ponowne użycie nazwy lub zmiana dowodu pod blokadą przerywa naprawę.

Terminalne wyniki nie są traktowane jako held run i nie są automatycznie wznawiane. Po przerwaniu samej naprawy wznowienie używa tego samego zamiaru i pinned evidence; nie powstaje drugi dowód dla zmienionych danych.

## Pozostałe przypadki

Brak pliku przy `docker cp` ze starego zatrzymanego kontenera nie dowodzi braku pliku w wolumenie. Kwalifikacja sprawdza dokładny control volume przez zarządzany odczyt tylko do odczytu. Historyczny failed development receipt może nie mieć container IDs; późniejszy udany resume ma osobny autorytatywny łańcuch. Starych ID nie przepisujemy.

Ready/draining po utracie namespace, aktywny persisted run, niezgodny Compose CAS i brak urządzenia ext4 wymagają własnych dowodów. Nie wolno zastępować ich ręcznym ustawieniem drained, usunięciem ownera, pustą sesją ani skasowaniem rezerwacji. Sam stan exited nie stanowi dowodu zakończenia zadania naukowego.

## Weryfikacja

Wymagane są kontrakty negatywne dla zmienionych ID/pinów, aktywnych konsumentów, nieterminalnego ownera lub runu, zmiany danych i restartu transakcji; istniejące kontrakty aktywacji oraz recreation/resume zachowują obowiązywanie. Próba live dotyczy wyłącznie kwalifikowanej zatrzymanej grupy i potwierdza niezmienność danych oraz brak startu aplikacji. Raport operacyjny zapisuje wynik każdej z dziesięciu grup osobno; obecność kodu nie jest dowodem wykonanej naprawy.

## Terminalne wyniki i rzeczywista zdolność programu

Natywne recovery v3 dopuszcza dokładnie przypięty pełny inwentarz terminalnych runów: succeeded, failed lub cancelled, ze zwolnionymi rezerwacjami oraz zgodnymi katalogami, CAS, inbox i dziennikami koordynatora. Pierwszy zakres obejmuje pojedynczy compute attempt na task. Historyczne compute leases/admissions z innych prób powodują odmowę; zwolnione rezerwacje przygotowania mają własne identyfikatory prób i nie są porównywane z compute attempt. Stany accepted, queued, running i draining nie są terminalizowane przez tę ścieżkę.

Dla claimed cancelled zdarzenie Stopped zachowuje `terminal=false`, zgodnie z producentem. Zamknięcie potwierdzają checkpoint Cancelled, zastosowany Stop, zwolniona właściwa rezerwacja i pasujący process-exit receipt z zaobserwowanym żądaniem stop. Brak receiptu pozostaje blokadą. Wąski wyjątek pojedynczego końcowego heartbeat wymaga dowodu rzeczywistego zakończenia workera i zgodnych liczników; nie upoważnia do odtwarzania obliczeń.

Komenda `fullmag runtime service-container-recovery-capabilities` odczytuje wyłącznie możliwości i build identity wykonywanego programu. Nie przyjmuje konfiguracji ani ścieżki sesji. Sam nowy helper nie aktualizuje programu w starszym worktree: bridge musi potwierdzić obsługę schematu przez faktyczny pakiet przed recovery. Brak obsługi v3 blokuje operację, bez fallbacku do starszego schematu.

## Dyspozycje operacyjne

- `awesome-mayer-5cef23`: zachować źródła i zamrożony run; brak potwierdzenia zakończenia procesu i brak decyzji o terminalizacji.
- `saved-results-playback`: ponowna kwalifikacja po zakończeniu pracy właściciela; stan zmieniał inny aktywny wątek.
- `docker-volume-only-implementation`: wyłączona z bieżącej migracji. Późniejszy build może odtworzyć obraz i cache, ale nie brakujące wyniki użytkownika.
- `frontend-production-audit`: odnaleziona kopia stanu na innym dysku wymaga uwierzytelnionej relokacji; nie tworzyć pustego zamiennika.
- `wsl-build-check`: przywrócono istniejące urządzenie ledger z tym samym UUID i identycznymi bajtami ledger. Pozostała kwalifikacja ownera i operacji; nie jest to dowód zakończonej migracji.

Bieżące wyniki dla wszystkich grup zapisuje osobny raport operacyjny. Zmiana źródeł, udane testy i przywrócenie urządzenia nie oznaczają, że migrowano stare kontenery.
