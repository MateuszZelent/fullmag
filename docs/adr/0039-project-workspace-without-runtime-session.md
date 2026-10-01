# ADR 0039 — Workspace projektu bez sesji runtime

Status: accepted for implementation. Data: 01.10.2026.

## Kontekst

Dokument projektu i trwałe wyniki nie wymagają aktywnej sesji. Dotychczas
WorkspaceShellClient pokazywał EmptyWorkspace przy pustej kolekcji sesji,
a połączenia kernelu równolegle odpytujące `sessions/current` były montowane
niezależnie od kolekcji. Zapisany wynik można było odczytać resource hookiem,
ale użytkownik nie miał do niego dostępu bez istniejącej sesji.

## Decyzja

Pozostają jeden kernel, ModuleRegistry, selekcja, Inspector i WorkspaceDockLayout.
Jawny, lokalny dla drzewa React zakres treści `project | session` określa
montowane moduły. Nie jest capability backendu, stanem wykonania ani nowym store.

- Potwierdzona kolekcja z sesją montuje dotychczasowy workspace sesji.
- Otwarty projekt przy braku dostępnej sesji montuje ten sam docking z Saved
  Results i readonly Inspectorem przypiętego datasetu. Viewport pokazuje jawny
  placeholder bez canvasu. Moduły bieżącego runtime'u, ribbon sesji, dolny dock
  runtime'u i pomocniczy viewport pozostają niezamontowane.
- Loading, error i potwierdzona pusta kolekcja mają odrębne komunikaty.
  Nie tworzy się fikcyjnej sesji ani nie zamienia błędu kolekcji w potwierdzony brak.
  Poprzednia potwierdzona kolekcja pozostaje authoritative podczas refresh failure
  zgodnie z istniejącym kontraktem useSessionCollection.
- Bez otwartego projektu zachowuje się dotychczasowy EmptyWorkspace oraz jawne
  ekrany loading/error.

Kernel montuje realtime, synchronizację wizualizacji/kamery i skróty runtime'u
dopiero po potwierdzeniu dostępnej sesji. Bez sesji menu i skróty dopuszczają
wyłącznie jawny zestaw poleceń dokumentu i lokalnego chrome. Utworzenie nowej
sesji pozostaje wyraźną akcją użytkownika. Stara selekcja Object/Airbox nie
montuje edytora ani nie daje możliwości mutacji z workspace projektu.

Tożsamość runtime'u wymaga zgodności statusu z dokładnie jednym wpisem
`current=true` w kolekcji sesji. Pusty wynik albo mismatch unieważnia scope
komend. Realtime odświeża również kolekcję. Przy utracie lub zmianie scope
selekcja runtime'u jest usuwana mimo starego dirty draft guard; przypięty
dataset nadal podlega granicy projektu. Zapis kamery ma request scope,
generation i anulowanie żądania; stary pending/dirty stan oraz późna odpowiedź
nie mogą zostać zastosowane w kolejnej sesji.

## Kontrakty i konsekwencje

Nie zmieniają się OpenAPI, generated transport ani semantyka solverów.
Trwałe żądania nadal zawierają projekt/run/SolutionSet/exact revision/member/
artifact. Aktualna sesja nie jest fallbackiem źródła wyników. Nieaktywny canvas
nie pozostaje zamontowany; zachowuje się ADR 0016.

Stan układu nie jest nadpisywany presetem sesji. Przejście do sesji przywraca
zarejestrowane moduły i istniejące ustawienia dockingu. Zamknięcie lub zmiana
projektu blokuje wyświetlanie starego payloadu. Podgląd binarny pól pozostaje
oddzielną funkcją, bez zerowego pola i bez niejawnego solve.

## Implementacja i walidacja

Obowiązki: WorkspaceShellClient/DockLayout, jawny context treści,
ResultsNavigator, Inspector, KernelProvider oraz wspólna polityka poleceń
projektu. Browser fixture musi potwierdzić sesje=[], dostęp do zapisanych
wyników, brak current-session HTTP/WS i mutacji, brak canvasu, błędny manifest
oraz zmianę projektu. Oddzielna kontrola zachowuje sesyjny lifecycle i last-good
refresh semantics. Testów jednostkowych nie kompiluje się podczas bieżącego
zakazu; brak ich wykonania nie jest kwalifikacją.

## Rollback

Wyłączenie montowania zakresu project przywraca EmptyWorkspace, pozostawiając
trwałe manifesty i readonly endpointy. Nie cofa się ochrony ID, rewizji ani
integrity. Implementacja i dowody nie są jeszcze potwierdzone samym ADR.
