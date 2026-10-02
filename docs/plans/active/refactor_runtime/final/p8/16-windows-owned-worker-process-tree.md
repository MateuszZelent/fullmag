# P8-16 — własność drzewa procesów Windows

Data: 02.10.2026. Zakres: P7-C/P8-C, procesy accepted worker i FEM preparer.
Stan: implementacja źródłowa; native runtime NOT VERIFIED.

## Problem i zmiana

Supervisor używał `Child::kill()`, które nie obejmuje potomnych procesów
Windows. Samo `CREATE_NEW_PROCESS_GROUP` nie ustanawia własności drzewa.
Przy timeout lub utracie kontroli solver/Python mógł nadal działać, a
odziedziczone stdout/stderr uniemożliwiać zakończenie czytelników logów.

Wspólny `OwnedWorkerProcess` przypisuje worker i preparer do nienazwanego,
nieodziedziczanego Windows Job Object z `KILL_ON_JOB_CLOSE`. Nie dopuszcza
breakaway ani fallbacku do niekontrolowanego procesu. Przed otwarciem store
worker/preparer czeka na wersjonowany sygnał przez stdin. Supervisor wysyła
go dopiero po przypisaniu Job Object; błąd przypisania kończy zablokowane
dziecko. Durable Start/inbox i fencing nie są zastępowane tym sygnałem.
Pending Start już istnieje przed spawn, dlatego samo durable przypisanie
zadania nie chroni przed uruchomieniem solvera przed przypisaniem Job Object.

Przy kill oraz przy zaobserwowanym zakończeniu procesu głównego supervisor
kończy drzewo i sprawdza `ActiveProcesses == 0`, zanim dołączy czytelników
logów. Oczekiwanie ma limit pięciu sekund; błąd nie staje się potwierdzonym
wynikiem zakończenia drzewa. Utrata supervisora zamyka jego własny handle
Job Object. Linux zachowuje dotychczasową realizację Child; ten przyrost nie
kwalifikuje Linux process-tree cleanup.

Po review cleanup jest jawnie idempotentny: odczyt pustego job i wcześniej
potwierdzony koniec pomijają ponowne `TerminateJobObject`. Odmowa przypisania
lub błąd zwolnienia gate zamyka stdin i zatrzymuje dziecko; potwierdzony
koniec jest zbierany przez obserwator jako startup/control failure z logami.
Jeżeli nie da się potwierdzić końca drzewa, błąd zachowuje znany status root
procesu, a slot/launch/lease pozostają do reconciliacji. Nie publikujemy
exit receipt uwalniającego zasób. Odzyskanie stdout/stderr i reconciliation
takiej awarii pozostają bramką P2 operacyjną, bez bezwarunkowego join pipe.

Mechanizm dotyczy zgodnych binariów producenta Fullmaga. Dowolny zewnętrzny
executable ignorujący protokół startu nie uzyskuje kwalifikacji przez samą
obecność flagi. Własność procesów nie zmienia wyboru lane ani fizyki.

## Kontrole i bramki

Parser wszystkich zmienionych plików PASS; format nowych modułów PASS;
`cargo metadata --locked --offline --no-deps` PASS. To nie kompilacja
produkcji ani dowód ABI Win32. Regresja źródłowa bariery startu obejmuje
poprawny token, EOF i niepoprawny token. Dodatkowy wykonywalny test Windows
uruchamia gated fixture z rzeczywistym potomkiem PowerShell i sprawdza jego
handle po kill, normalnym exit rodzica oraz drop właściciela. Te testy nie
zostały skompilowane ani uruchomione zgodnie z zakazem kompilacji unit tests.
Review wskazało startup race i idempotencję cleanupu; uwzględniono powyższe
poprawki. Dodatkowo naprawiono receipt worker: exit 0 przy control failure
lub timeout nie publikuje `status_success=true`. Regresja sprawdza rzeczywisty
fenced receipt oraz jego serializację dla tych trzech przypadków; pozostaje
NOT RUN. Końcowy review logiki nie wykazał pozostałego P0/P1; wskazaną
niezgodność prefiksu komunikatu w oczekiwaniu testu poprawiono.

Wymagane pozostają rzeczywiste testy Windows: blokada przed release,
przypisanie przy nested job, odmowa przypisania, worker/preparer z potomnym
solverem, timeout, utrata heartbeat, normal exit z pozostawionym potomkiem,
awaria supervisora, zamknięcie pipe i potwierdzony brak procesu przed
ponownym przydziałem zasobu. MSI oraz release nadal NOT VERIFIED.

## Następny etap produktu

Lokalny produkt nie ma jeszcze właściciela uruchamiającego resource pool,
resident accepted scheduler i FEM preparation scheduler niezależnie od UI.
API tylko przyjmuje intenty; nie dokładamy do niego drugiego schedulera.
MSI zawiera executables, ale obecne CLI/Tauri startuje tylko API i scratch.
Usługa runtime, attach/detach UI, reconnect i kontrolowany drain pozostają
otwarte. Sam zapis Submit z P8-15 nie dowodzi wykonania runu.

Build 212 pochodzi z wcześniejszych źródeł i nie obejmuje tego przyrostu.
Nie zmieniamy procentów realizacji planu. Sesja na 3104 pozostaje zachowana.

Podstawa Win32: [Microsoft — Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
