# Recovery niezamrożonego workspace’u frontendu

Status: techniczny kontrakt naprawy w ramach zatwierdzonego recovery własnej
grupy; odbiór runtime i pełne P22 pozostają otwarte.

## Problem i wybór

Attempt `08a6cbffbe874153a6e7547eb5898650` jest failed-confirmed z powodu
frontendu Exited1. Prywatny next-env.d.ts ma 0 B, brak inputs-freeze.json
oraz frozen copy; źródłowy plik jest czysty, ma 247 B i SHA-256
`7b550dda9686c16f36a17bf9051d5dbf31e98555b30d114ac49fc49a1e712651`.
Backend `1d3311194d38` jest healthy, API/runtime Ready, app commit
`48845db952a902d3dafaf6885dc259becb8eba1a`.

Rozważono nadpisanie prywatnego pliku, istniejący frozen refresh i nową
prywatną generację. Nadpisanie utrudnia zachowanie diagnostyki, frozen refresh
wymaga nieobecnego dowodu. Wybrano nową generację jako decyzję implementacyjną:
ścisły hash guard pozostaje, stary workspace zachowany, backend bez restartu.
Nie przypisuje się pustemu plikowi nieudowodnionego pochodzenia z Next.

## Kontrakt

- Jawny tryb `--failed-seed-new-generation` w istniejącym managed refresh.
  Domyślne ścieżki i frozen-resume nie zmieniają warunków.
- Exact attempt/config/terminal/current/verified CAS, własny frontend Exited1,
  PID0, brak restart/OOM/pauzy, dokładny mismatch w logu, zerowy stary plik
  oraz brak freeze. Pełna kontrola pod lease i przed zmianą Compose.
- Nowa nieistniejąca generacja private/frontend/generations/<operation>,
  bez symlinków i z poprawnym właścicielem. Poprzednie pliki i receipt
  zachowane. Dodanie katalogu generacji zmienia listę katalogów kontrolnych;
  nie deklaruje się bajtowej identyczności całego ich drzewa.
- Dokładna zgodność bieżących seed files/dependencies/toolpins/live directories
  ze starym autentycznym manifestem; jedynie source_commit może się różnić.
  Osobno zapisane controller/helper commit, input commit i backend app commit.
  To nie jest ogólna deklaracja zgodności całych HEAD-ów ani kwalifikacja S46.
- Compose zmienia tylko generację /state/development dla frontendu.
  Backend declaration, ID, StartedAt, PID, fingerprint, owner/certificate
  i runtime observation zachowane. Backend healthy oraz idle wymagane.
  Tylko up --no-deps --force-recreate frontend, bez backend build/restart.
- Nieznani konsumenci, rozbieżne hashe/CAS, zajęta generacja i niejednoznaczny
  stan kończą próbę bez automatycznego fallbacku. Brak działań na obcych
  checkoutach Windows. Nie ponawiać Solve/Compute.

## Wdrożenie i odbiór

1. Meaningful mocked Python RED/GREEN: exact pass, złe CAS/log/hash, brak
   manifestu source, rozbieżny seed, aktywny frontend, zmieniony backend,
   symlink/istniejąca generacja, nieznany konsument. Zachowanie defaultów.
2. Wąski validator/proof, bezpieczne tworzenie generacji i caller istniejącego
   refreshu; reuse lease/CAS i backend preservation, bez kopiowania całego flow.
3. Review diffu i istniejące adekwatne testy. `just --dry-run` sprawdza jedynie
   rozwinięcie recepty, bez wykonywania rzeczywistych guardów.
4. Managed apply zaczyna się od rzeczywistych kontroli tylko do odczytu przed
   utworzeniem generacji, ponawia je pod lease i przed granicą Compose.
   Nie dodaje się osobnego workflow zatwierdzania; apply własnej grupy jest
   wcześniej autoryzowane. Potwierdzenie nowego frontend ID, zdrowego UI oraz identycznego
   backendu. Wszystkie seed bytes i freeze zweryfikowane, stara kopia zachowana.
5. Dopiero potem rzeczywisty odbiór UI/Cell. P22/S46 oraz matrix/integracja
   pozostają oddzielnymi bramkami; sam start usług ich nie zamyka.
