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
