# ADR 0052: cykl życia danych managed Build Runnera

Data: 2026-10-05. Status: przyjęta decyzja w zakresie wdrożenia zleconego przez
użytkownika; kwalifikacja runtime pozostaje otwarta w planie wdrożenia.

## Kontekst

Runner zachowuje pełną kapsułę źródeł, jej zapisywalną kopię kompilacji i
wybrane artefakty. Dotychczas retencja planowała usuwanie, ale go nie wykonywała.
Powoduje to narastanie milionów plików niezależnie od ustawionego TTL.

## Decyzja

1. Katalog `execution` jest prywatną, wygasającą kopią roboczą. Po terminalnym
   stanie joba, utrwaleniu dowodów i upływie polityki wykonawca może go usunąć.
   Przed mutacją ponownie sprawdza tożsamość, stan, piny, blokady i rzeczywistych
   użytkowników. Nie usuwa źródeł, wyników ani współdzielonych cache.
2. Niepodzielną jednostką odtwarzalności źródeł jest manifest kapsuły plus jej
   treść, a nie osobna fizyczna kopia każdego pliku. Współdzielone obiekty są
   niezmienne i identyfikowane hashem i trybem pliku. `source/tree` pozostaje
   zgodnym widokiem dla istniejących konsumentów; execution otrzymuje kopię.
3. Paczka runtime może wygasnąć dopiero po wykazaniu braku odwołań z wyników,
   jobów, aktywnych instancji, bieżących wskaźników oraz pinów. Nieznana lub
   częściowa inwentaryzacja chroni paczkę. Zachowujemy manifesty i dowody buildu.
4. Każda próba sprzątania ma trwały identyfikator, dokładny zakres i wynik.
   Estymata logiczna, usunięte pliki i obserwowana zmiana wolnego miejsca są
   różnymi metrykami. Błąd częściowy nigdy nie oznacza pełnego sukcesu.
5. Jeden istniejący koordynator jest właścicielem automatycznej retencji.
   Blokady retencji i ciężkich operacji serializują decyzję z uruchomieniami.
   Tryb podglądu pozostaje dostępny; zmiana ustawienia nie omija walidacji.
6. Uruchomienie publikujące konsumenta runtime używa krótkiej bramki `mkdir`
   i własnego trwałego ticketu w `locks/runtime-users`. Niezależne obliczenia
   mogą działać równolegle. Sprzątanie trzyma tę samą bramkę przez całą mutację
   i odmawia przy dowolnym aktywnym lub nieznanym tickecie. Nie zakładamy
   interoperacyjności blokad `msvcrt` i `flock` przez Docker Desktop.
   Przerwany gate lub ticket wymaga sprawdzenia właściciela; sam wiek go nie wygasza.

7. Plan administracyjny wiąże zakres i wskazane joby. Przy zajętym wykonawcy
   klient dostaje odmowę, a nie ID wcześniejszego planu o innym zakresie.
   Częściowe usunięcie paczki wymaga sprawdzenia danych; świeży plan nie może
   automatycznie ponowić takiej operacji.
8. Kompletność historycznych lokalizacji konsumentów jest osobnym warunkiem.
   Rejestr metadanych nie uzyskuje tego statusu przez samo utworzenie pliku.
   Nowy COMSOL/DE output jest rejestrowany pod bramką admission przed zwolnieniem
   ticketu, bez poświadczania historii. Brak potwierdzonego inventory blokuje
   retencję runtime; błędny consumer chroni również nieznane odwołania cross-job.

9. Konserwatywne preview nie musi mierzyć zasobów, które są już chronione przez
   zakres, pin albo TTL; ich rozmiar pozostaje nieznany. Fingerprint kandydatów
   i walidacja executora pozostają obowiązkowe. Dla utrwalonego, nazwanego
   read-only execution preview dopuszczamy jawne porzucenie przy maintenance,
   po ukończonym Drain i po potwierdzeniu braku apply, admission i aktywnych
   użytkowników runnera. Automatyczna retencja i mutacja nie korzystają z tego
   wyjątku; default replacement nadal odmawia przy retention_busy.

## Zgodność i migracja

Nie zmieniamy ProblemIR, fizyki, publicznego Python DSL ani Control Room API.
Zmienia się kontrakt administracyjnego API runnera: apply może faktycznie
usunąć zatwierdzone zasoby, a UI musi jednoznacznie to komunikować.
Manifest źródeł v1 i jego digest pozostają zgodne. Stare kapsuły i paczki nie
stają się automatycznie osierocone z powodu braku nowych metadanych.
Migracja historycznych danych wymaga aktualnego wykazu użytkowników i zachowania
tożsamości przed/po; aktywne dane są pomijane.

Wycofanie automatyzacji oznacza przejście do preview. Nie odtwarza usuniętych
kopii roboczych; ich odtworzenie korzysta z zachowanych źródeł i kontraktu buildu.
Współdzielone źródła pozostają czytelne przez stary układ `source/tree`.

## Zobowiązania i testy

Zakresy, źródła i bramki określa
[plan](../superpowers/plans/2026-10-05-runner-storage-retention.md).
Wymagane są regresje odmowy przy aktywnym użyciu, błędach metadanych, pinach,
linkach poza drzewo i zmianach pomiędzy planem i wykonaniem, testy deduplikacji
oraz kontrola zachowania danych naukowych. Wdrożenie musi przejść rzeczywisty
przebieg przez istniejący koordynator i jego UI.


## Integralność archiwum a zgodność runtime — korekta 2026-10-05

Usuwanie prywatnego `execution` zakończonego buildu wymaga zgodności
terminalnych metadanych, zachowanych źródeł oraz integralności archiwalnego
receiptu i wszystkich wymienionych artefaktów. Walidator archiwalny sprawdza
schemat, tożsamość joba/obrazu/źródeł, udane etapy, regularne bezpieczne ścieżki,
unikalność wpisów, rozmiary i SHA256. Nie interpretuje historycznej konfiguracji
CMake według dzisiejszego profilu. Archiwalnych plików nie wykonuje.

To nie kwalifikuje starego runtime ani fizyki. Walidacja zakończenia nowego
buildu, dopuszczenie runtime i retencja pakietów runtime zachowują aktualne,
ścisłe wymagania. Kompakcja źródeł nadal ma własną weryfikację kapsuły.


## Duże plany i dowody wykonania — rozszerzenie 2026-10-09

Status implementacji tego rozszerzenia: planowane; brak kwalifikacji runtime.

Plan i wynik wykonania nie mogą być zapisane w formacie, którego własny loader
nie umie odczytać. Dla danych większych niż limit pojedynczego metadata JSON
stosujemy prywatny manifest oraz niezmienne części. Limit 4 MiB pojedynczego
pliku i odmowa symlink/reparse pozostają obowiązujące. Nie obcinamy kandydatów,
fingerprintów, wyników częściowych ani raw planu.

Manifest wiąże plan_id, scope, rodzaj dokumentu (plan/operation), kolejność
części, dokładne rozmiary UTF-8, counts i SHA-256. Najpierw publikowane są
niezmienne części, następnie atomowo manifest. Loader przed apply sprawdza
wszystkie części, ich integralność i tożsamość. Błąd lub niekompletność oznacza
odmowę przed mutacją, bez automatycznego retry.

Ten sam writer/reader obsługuje RetentionService i wszystkie trzy executory,
łącznie z rosnącym receipt po częściowym usunięciu. Budżet liczby części,
całkowitych danych i pojedynczego wpisu jest jawny i sprawdzany przed mutacją;
przekroczenie wymaga małego trwałego wyniku odmowy, a nie nieczytelnego receiptu.
Odmowa nie zmienia danych objętych retencją ani nie udaje ukończonego planowania.
Sam trwały wynik odmowy jest kontrolowanym zapisem metadanych.

Wymagane statusy, kody błędu, tożsamości, fingerprints oraz wszystkie częściowe
outcomes są pełne. Dowolnie długa ludzka wiadomość wyjątku jest opcjonalną
diagnostyką: jeśli nie mieści się w zarezerwowanym budżecie wpisu, pomijamy ją
jawnie, zapisując error_message_omitted, dokładną liczbę bajtów UTF-8 oraz SHA-256
pełnej wiadomości. Zwykłe wiadomości zachowujemy w całości. Typ błędu i stabilny
kod primary failure pozostają czytelne. Nie przedstawiamy tego jako pełnego
archiwum ludzkich komunikatów; żaden mandatory fingerprint ani status nie jest
ucinany. Dzięki jawnej granicy przyszłych opcjonalnych tekstów preflight może
wyliczyć budżet wyników przed mutacją. Liczba dopuszczalnych mutacji wynika
z tego budżetu, a nie z historycznego limitu queue.list(1000).

Jawne budżety prywatnego formatu: inline do 4 MiB, logiczny dokument do
256 MiB, pojedyncza część do 256 KiB, pełny wpis do 128 KiB, do 16 384
referencji części oraz manifest do 4 MiB. Opcjonalne ludzkie teksty mają
łącznie do 16 KiB na wpis, nie osobny limit na każde pole. Rozmiar odnosi
się do dokładnych bajtów UTF-8 po JSON escaping. Przed mutacją sumujemy
per-scope maksymalne szablony outcomes dla rzeczywistych kandydatów,
stałe pola wyniku, separatory oraz najgorszy rozmiar referencji i manifestu.
Zbyt duże wymagane dane blokują cały zakres, bez wykonywania mniejszego
podzbioru. Omission metadata muszą być zachowane w odpowiedzi API/UI; hash
nie oznacza możliwości odzyskania pełnego tekstu.

Ten capacity preflight nie rezerwuje fizycznego miejsca ani nie gwarantuje
I/O. Późniejsza awaria utrwalenia nadal oznacza unknown/partial z zachowaniem
wcześniejszych trwałych dowodów i odmową automatycznego ponowienia. Nie wolno
zamienić jej na succeeded tylko dlatego, że dokument mieścił się w budżecie.



Dotychczasowe inline dokumenty do 4 MiB są nadal czytelne. Istniejący oversized
legacy dokument pozostaje zachowany i jawnie niekwalifikowany; ta zmiana nie
migruje ani nie usuwa historycznych danych. Wycofanie do poprzedniego programu
wymaga zatrzymania apply dla nowych manifestów; stary loader nie może ich
interpretować jako puste plany. Paginacja publicznego API i UI jest oddzielnym
kontraktem; prywatne części nie są nowymi endpointami.

Weryfikacja obejmuje pełny roundtrip/restart planu większego niż 4 MiB,
granice rozmiaru UTF-8, brak/tamper/reorder/link części, fail-closed przed
wywołaniem executora oraz czytelny wynik częściowej awarii bez retry.
Testy wykonywane wyłącznie w GitHub Actions; SOURCE checks nie kwalifikują
sprzątania rzeczywistych danych.
