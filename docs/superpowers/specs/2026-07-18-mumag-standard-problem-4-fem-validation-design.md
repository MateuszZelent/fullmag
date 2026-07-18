# Pełna walidacja µMAG Standard Problem 4 dla FEM

- Status: zatwierdzony design
- Data: 2026-07-18
- Zakres: produkcyjny FEM CPU, MFEM/hypre, precyzja `double`
- Źródło nadrzędne: [NIST µMAG Standard Problem 4](https://www.ctcms.nist.gov/~rdm/std4/spec4.html)
- Dane referencyjne: [NIST/OOMMF Standard Problem 4 results](https://www.ctcms.nist.gov/~rdm/std4/Donahue.html)

## 1. Cel

Zbudować powtarzalną, automatyczną i audytowalną walidację produkcyjnego
solvera FEM Fullmag względem pełnego kontraktu NIST µMAG Standard Problem 4.
Walidacja ma sprawdzać przygotowanie stanu S, dynamikę LLG dla obu pól,
przebiegi przestrzennie uśrednionej magnetyzacji, stan magnetyzacji przy
pierwszym przejściu średniego `mx` przez zero oraz niezależność wyniku od
dyskretyzacji.

MuMax3 jest źródłem pomocniczym i mapą implementacyjną. Jego wartości
`expectv` po 1 ns nie są samodzielnym kryterium zgodności z NIST.

## 2. Decyzje projektowe

### 2.1 Lokalizacja

Nowy zestaw będzie żył pod:

```text
tests/standard_problems/
  README.md
  mumag/
    sp4/
      README.md
      references/
        manifest.json
        nist/
      common/
        contract.py
        metrics.py
        validation.py
      fem/
        problem.py
        run.py
        verify.py
        test_contract.py
```

Nazwa `tests/standard_problems` jest kanoniczna. Nie powstanie równoległy
katalog `standardize_testes`. W przyszłości implementacja FDM zostanie dodana
obok `fem/` i będzie korzystać z tych samych plików `common/` oraz tych samych
danych referencyjnych.

### 2.2 Rozdzielenie kontraktu od realizacji

`common/contract.py` definiuje wyłącznie fizyczny problem NIST: geometrię,
materiał, pola, parametry LLG, wymagane wielkości i schemat artefaktów. Nie
zawiera ustawień konkretnego backendu.

`fem/problem.py` materializuje kontrakt jako publiczny skrypt Fullmag i jawnie
wybiera FEM CPU, `double`, P1, MFEM/hypre oraz model demagnetyzacji
`poisson_robin`. Każda zmiana realizacji pozostaje widoczna w proweniencji.

`common/metrics.py` i `common/validation.py` nie uruchamiają solvera. Czytają
artefakty i porównują dowolną realizację z tym samym kontraktem NIST.

## 3. Kanoniczny problem fizyczny

### 3.1 Geometria i materiał

- prostopadłościan `500 nm x 125 nm x 3 nm`;
- dłuższa oś jest osią `x`, szerokość osią `y`, grubość osią `z`;
- `Ms = 8.0e5 A/m`;
- `Aex = 1.3e-11 J/m`;
- anizotropia magnetokrystaliczna `K = 0 J/m^3`;
- tłumienie dynamiczne `alpha = 0.02`;
- współczynnik żyromagnetyczny zgodny z formą Gilberta NIST,
  `gamma_mu0 = 2.211e5 m/(A s)`.

### 3.2 Stan początkowy

Stan dynamiki jest równowagowym stanem S przy zerowym polu. Fullmag tworzy go
deterministycznie przez relaksację z `normalize(1, 0.1, 0)` i zapisuje jako
osobny artefakt. Oba przypadki dynamiczne muszą używać dokładnie tego samego
zapisanego stanu, potwierdzonego identyfikatorem treści w raporcie.

Relaksacja jest osobną fazą kwalifikacji. Musi potwierdzić:

- zakończenie według jawnego kryterium momentu/torque;
- brak pola zewnętrznego;
- monotoniczny spadek energii w zaakceptowanej końcówce relaksacji;
- `|m|` zgodne z więzem jednostkowym;
- przestrzennie ważone średnie `mx`, `my`, `mz` zgodne ze stanem S;
- korelację wektorową co najmniej `0.90` i RMSE składowych nie większe niż
  `0.15` po projekcji na opublikowany stan początkowy OOMMF;
- zapis pola magnetyzacji i pełnej proweniencji mesha, demag oraz algorytmu.

### 3.3 Dwa przypadki dynamiczne

Pole jest załączane skokowo w `t = 0` i pozostaje stałe:

- przypadek A: `B = (-24.6e-3, 4.3e-3, 0) T`;
- przypadek B: `B = (-35.5e-3, -6.3e-3, 0) T`.

Każdy przypadek jest jedną ciągłą integracją LLG. Zabronione jest dzielenie
trajektorii na serię krótkich uruchomień z ponowną inicjalizacją solvera.
Domyślne próbkowanie skalarów wynosi `1 ps`, zgodnie z referencyjnymi danymi
OOMMF. Integracja trwa co najmniej `1 ns` i dalej do jawnie zdefiniowanej
równowagi, jeżeli równowaga nie została osiągnięta po 1 ns. Stan jest uznany
za równowagę dopiero po spełnieniu przez kolejne `50 ps` obu warunków:
`max_torque_T <= 1e-5 T` oraz maksymalna zmiana dowolnej z ważonych średnich
`mx`, `my`, `mz` nie większa niż `1e-4`. Twardy limit wykonania wynosi `5 ns`;
jego osiągnięcie bez równowagi jest błędem walidacji.

## 4. Dane referencyjne

### 4.1 Źródła

Repozytorium przechowuje lokalną, niezmienną kopię potrzebnych danych
opublikowanych przez NIST. Test nie pobiera danych z sieci podczas wykonania.
Minimalny zestaw obejmuje dla obu pól:

- szeregi czasowe OOMMF z próbkowaniem `1 ps`;
- pola magnetyzacji w pierwszym przejściu średniego `mx` przez zero;
- opublikowany stan początkowy OOMMF;
- co najmniej jeden dodatkowy opublikowany szereg NIST wykonany na innej
  dyskretyzacji, używany do oszacowania rozrzutu referencyjnego.

`references/manifest.json` zapisuje URL źródłowy, autora, opis dyskretyzacji,
format, jednostki, SHA-256 oraz datę pobrania każdego pliku. Dane nie mogą być
automatycznie odświeżane przez test ani przez recepturę `just`.

### 4.2 Rola MuMax3

Pliki `external_solvers/3/test/standardproblem4*.mx3` pozostają niezmienionym
materiałem porównawczym. Wartości końcowe MuMax3 są raportowane jako dodatkowa
metryka regresyjna, ale nie zastępują pełnej trajektorii NIST, pola przy
przejściu przez zero ani zbieżności przestrzennej.

## 5. Artefakty Fullmag

Każde uruchomienie zapisuje artefakty wyłącznie pod:

```text
.fullmag/reports/standard-problems/mumag/sp4/fem/
```

Wymagane wyniki:

- `relaxation/` ze stanem S, energią, torque, meshem i proweniencją;
- `case-a/scalars.csv` i `case-b/scalars.csv` z `time`, `mx`, `my`, `mz`,
  energiami i diagnostyką kroku;
- pole `m` bezpośrednio przed i po pierwszym wykrytym przejściu `mx = 0`;
- interpolowany czas przejścia oraz interpolowane pole na zdarzeniu;
- opis mesha magnetycznego i airboxa;
- requested/resolved backend, device, precision, integrator, demag realization
  i brak fallbacku;
- `metrics.json`, `validation.json`, wykresy porównawcze i `report.md`;
- deterministyczny kod zakończenia procesu: zero tylko przy przejściu pełnej
  bramki.

Średnie FEM muszą pochodzić z natywnego, ważonego przez `Ms` i lumped volume
pomiaru publikowanego w `StepStats`/`scalars.csv`. Prosta średnia wartości
węzłowych z `final_magnetization` jest niedozwolona jako metryka NIST.

## 6. Zdarzenie pierwszego przejścia `mx = 0`

Główne uruchomienie zapisuje ciągłą trajektorię skalarów bez periodycznego
zapisu ciężkiego pola. Po wykryciu przedziału przejścia wykonywane są dwa
deterministyczne replaye od tego samego stanu S: jeden ciągle od `t=0` do
`t0`, drugi ciągle od `t=0` do `t1`. Ich stany końcowe dostarczają pola
otaczające zdarzenie bez restartowania głównej trajektorii i bez setek
snapshotów. Walidator:

1. wykrywa pierwszy przedział `[t0, t1]` z `mx(t0) > 0` i `mx(t1) <= 0`;
2. wyznacza czas przejścia interpolacją liniową średniego `mx`;
3. interpoluje nodalne pole `m` pomiędzy dwiema próbkami;
4. normalizuje wektory po interpolacji;
5. projektuje pole FEM na wspólną płaszczyznę porównawczą w środku grubości;
6. zapisuje zarówno dane natywne FEM, jak i projekcję porównawczą.

Brak przejścia w oczekiwanym oknie jest błędem, a nie stanem pomijanym.

## 7. Metryki i kryteria akceptacji

NIST nie podaje jednej normatywnej liczbowej tolerancji. Dlatego tolerancja nie
może zostać skopiowana z MuMax3. Jest wyznaczana jawnie z opublikowanego
rozrzutu referencji i zabezpieczona minimalną skalą numeryczną.

### 7.1 Trajektorie

Wszystkie referencje są interpolowane do wspólnej siatki czasu `1 ps`. Dla
każdej składowej i chwili walidator buduje przedział od minimum do maksimum
opublikowanych wartości. Odległość Fullmag od przedziału wynosi zero wewnątrz
przedziału. Poza nim jest dzielona przez:

```text
scale(t, component) = max(reference_max - reference_min, 0.02)
```

Każdy przypadek przechodzi, gdy jednocześnie:

- znormalizowany RMS odległości od referencyjnego przedziału nie przekracza
  `1.0` dla żadnej składowej;
- percentyl 99 znormalizowanej odległości nie przekracza `3.0`;
- bezwzględny błąd względem głównej trajektorii OOMMF po 1 ns nie przekracza
  `0.05` dla żadnej składowej;
- wynik zawiera skończone próbki w całym wymaganym przedziale czasu.

Raport zawsze pokazuje także nieznormalizowane RMSE, maksimum błędu i błąd
końcowy dla każdej składowej.

### 7.2 Przejście przez zero i mechanizm odwrócenia

- czas pierwszego przejścia musi leżeć w przedziale czasów opublikowanych
  referencji, rozszerzonym o `10 ps` z każdej strony;
- projekcja pola Fullmag musi osiągnąć średnią korelację wektorową co najmniej
  `0.85` z co najmniej jedną oficjalną mapą referencyjną;
- RMSE składowych projekcji względem tej mapy nie może przekroczyć `0.20`;
- raport zawiera osobne mapy `mx`, `my`, `mz`, różnicę wektorową i obraz
  mechanizmu odwrócenia dla obu pól.

Porównanie map dopuszcza wyłącznie udokumentowane przekształcenie osi wymagane
przez format źródłowy. Nie wolno wybierać odbicia lub obrotu na podstawie tego,
które daje mniejszy błąd.

### 7.3 Więzy fizyczne i wykonawcze

- maksymalne `abs(|m| - 1)` w zapisanych polach nie przekracza `1e-8`;
- wszystkie wartości, energie i diagnostyki używane przez bramkę są skończone;
- resolved engine jest produkcyjnym FEM CPU;
- precision jest `double`;
- nie wystąpił fallback;
- demag został rzeczywiście rozwiązany przez zadeklarowane
  `poisson_robin`, z dostępnym residualem i liczbą iteracji;
- oba przypadki używają identycznego stanu S.

### 7.4 Zbieżność mesha i airboxa

Kwalifikacja obejmuje trzy poziomy mesha P1. Dokładne wartości `hmax` są
zapisane w kontrakcie wykonawczym jako `3.0 nm`, `2.0 nm` i `1.5 nm` dla
obszaru magnetycznego. Każdy mesh musi rzeczywiście rozdzielić grubość próbki;
raport odrzuca poziom, jeżeli metadane mesha nie potwierdzają elementów przez
całe `3 nm`.

Pomiędzy dwoma najdrobniejszymi poziomami:

- RMSE różnicy trajektorii nie przekracza `0.025` dla żadnej składowej;
- różnica czasu pierwszego przejścia nie przekracza `20 ps`;
- różnica końcowych średnich nie przekracza `0.025` na składową.

Wpływ airboxa jest sprawdzany osobno na środkowym meshu przez dwa rozmiary
domeny zewnętrznej, wycentrowane na próbce:

- bazowy airbox: `700 nm x 250 nm x 250 nm`, `airbox_hmax = 20 nm`;
- rozszerzony airbox: `1000 nm x 500 nm x 500 nm`,
  `airbox_hmax = 20 nm`.

Rozszerzenie airboxa musi zmienić RMSE trajektorii o mniej niż `0.02`, czas
przejścia o mniej niż `20 ps`, a końcowe średnie o mniej niż `0.02` na
składową. Rozmiary i `airbox_hmax` są zapisane w artefaktach oraz raporcie;
brak tych danych unieważnia kwalifikację.

## 8. Warstwy testów

### 8.1 Szybki kontrakt

`test_contract.py` nie uruchamia natywnego solvera. Sprawdza parametry SI,
dwa pola, identyczny stan startowy, schemat manifestu referencji, parsery
danych, interpolację przejścia przez zero oraz logikę metryk na małych
syntetycznych fixture'ach.

### 8.2 Managed runtime smoke

Krótki, grubszy przypadek dowodzi, że publiczny skrypt przechodzi przez
ProblemIR, planner, runner i produkcyjny natywny FEM CPU, zapisując wymagane
artefakty. Smoke nie może promować statusu `physics_validated`.

### 8.3 Pełna kwalifikacja fizyczna

Receptura:

```text
just verify-fem-standard-problem-4
```

używa `just ensure-managed-fem-runtime`, uruchamia pełną macierz dwóch pól,
trzech meshów i testu airboxa, a następnie wykonuje walidator artefaktów. Jest
bramką release/nightly, nie testem wykonywanym przy każdym szybkim PR.

Każda zmiana kodu natywnego FEM wymagająca przebudowy runtime korzysta najpierw
z repozytoryjnej ścieżki `just rebuild-fem-runtime`. Host `cargo`, `cmake` i
bezpośrednie binaria nie są dowodem kwalifikacji.

## 9. Obsługa błędów

Walidacja działa fail-closed. Błąd obejmuje między innymi:

- brak lub niezgodny checksum danych referencyjnych;
- brak wymaganej kolumny, pola albo proweniencji;
- fallback backendu lub urządzenia;
- brak przejścia `mx = 0`;
- różne stany początkowe obu przypadków;
- niepełny czas trajektorii;
- nieskończone wartości;
- niewystarczającą rozdzielczość grubości;
- przekroczenie dowolnej bramki trajektorii, mapy lub zbieżności.

Raport rozdziela awarię wykonania, niepełne artefakty, błąd fizyczny i błąd
zbieżności. Nie wolno zamieniać brakujących danych na pominięty test.

## 10. Migracja istniejących testów

Obecny `tests/stdprob4_dynamics.py` jest prototypem FDM. Nie będzie rozszerzany
o gałęzie FEM. Po uruchomieniu nowej struktury jego wspólne stałe i referencje
zostaną przeniesione do `mumag/sp4/common/`; następnie skrypt zostanie albo
zastąpiony cienkim wrapperem FDM, albo usunięty w osobnym kroku, gdy nowa
ścieżka zachowa jego użyteczne pokrycie.

Istniejące testy FDM w
`crates/fullmag-runner/tests/physics_validation/fdm_relaxation.rs` pozostają
testami regresyjnymi konkretnego lane'u. Nie są dowodem pełnej zgodności SP4,
dopóki nie użyją wspólnych artefaktów i walidatora NIST.

## 11. Kryterium ukończenia

Zakres jest ukończony dopiero wtedy, gdy:

1. dane NIST są lokalne, opisane i chronione checksumami;
2. szybkie testy kontraktu przechodzą;
3. managed runtime generuje komplet artefaktów bez fallbacku;
4. oba przypadki przechodzą bramki trajektorii i przejścia przez zero;
5. trzy meshe przechodzą bramkę zbieżności;
6. test airboxa przechodzi niezależnie od zbieżności mesha;
7. raport zawiera parametry, proweniencję, metryki, wykresy i mapy;
8. `just verify-fem-standard-problem-4` kończy się kodem zero;
9. capability/provenance nie używa określenia `physics_validated`, zanim
   wszystkie powyższe warunki nie zostaną spełnione.

Implementacja samego skryptu, uzyskanie wartości końcowej podobnej do MuMax3
albo przejście jednego grubego mesha nie oznacza ukończenia.
