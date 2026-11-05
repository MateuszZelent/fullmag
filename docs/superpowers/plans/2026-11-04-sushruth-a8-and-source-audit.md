# Sushruth2020: kontrola tłumienia A8/A5 i źródeł autorów — 04.11.2026

Raport historyczny z 04.11.2026; podane liczniki i oczekujące decyzje opisują
wyłącznie tamtą chwilę. Aktualny stan: [plan wykonania](2026-10-11-antenna-transport-e2e-implementation.md).

**Pominięcie tłumienia w liczniku nie wyjaśnia rozbieżności Fig.3.**
Nie potwierdzono jeszcze ilościowej reprodukcji pracy. Wykonany krok
rozstrzyga jedną hipotezę; nie zastępuje kwalifikacji pełnego GSG ani LLG.

## Co sprawdzono

Wydawniczy AppendixA podaje A8 z członem tłumienia w liczniku. Przy tych
samych parametrach jest on równaniem1 pomnożonym przez czynnik zespolony
niezależny od wektora falowego. Czynnik można więc zastosować algebraicznie
do zachowanych R/T, bez kolejnej kwadratury. A8 nadal pomija wyrazy alfa²
w mianowniku; nie nazwano go pełnym rozwiązaniem macierzy A5.

Osobno policzono dokładny swobodny biegun A5 przy k=0. To częstotliwość
tłumionego swobodnego oscylatora, inny obserwabl niż maksimum Re(T).
Równania, SI, walidację i parametry opisuje nota0951, sekcja
`sushruth-a8-diagnostic`; mapa źródeł obejmuje obie funkcje i testy.
Nie zmieniano domyślnego modelu Eq1 lub parametrów TableI.

## Wynik

| Wielkość dla S, alfa0,01 | Eq1 | Diagnostyka | Przybliżony odczyt Fig.3 |
|---|---:|---:|---:|
| Maksimum Re(T) | 7,800GHz | A8:7,805GHz | 7,340GHz |
| Minimum Re(T) | 7,605GHz | A8:7,605GHz | 7,208GHz |
| f0 i Re(fp), osobne obserwable | f0:7,500GHz | A5:7,499250075GHz | Znacznik FMR:7,208GHz |

Ekstrema odczytano na zachowanej siatce5MHz w6–9GHz. Przesunięcie
maksimum o5MHz nie tłumaczy około460MHz różnicy z rysunkiem.
Dokładny biegun przy alfa0,01 przesuwa się o−0,750MHz; nie tłumaczy
około292MHz różnicy między literalnym f0 i znacznikiem publikacji.
Przy większych alfa część rzeczywista bieguna przesuwa się o−6,744,
−36,571 i−74,257MHz; nie utożsamiano jej z maksimum transmisji.

## Dowody i zakres

- Nowy osobny moduł `scripts/reference_sushruth_2020_a8_diagnostic.py`:
  algebraiczny czynnik i swobodny biegun, bez solvera lub fitu.
- `scripts/test_sushruth_a8_diagnostic.py`:7/7 PASS, bez skipów.
  Bezpośrednie A8 w cyklach/s kontra Eq1 w rad/s dla48 kombinacji,
  granice, sprzężenie, jednostki i wyznacznik A5.
- Zachowane12 przebiegów po701 częstotliwości przetworzono do osobnego
  JSON. Oryginał nie został zmieniony. Czas0,0724s, peak RSS40,16MB,
  limit2GiB; istniejący backend właściwej grupy Docker.
- Focused validator noty i source-map PASS. Wcześniejsze41 testów
  niezmienionego kontraktu dokumentacji pozostaje dowodem tamtego zakresu.
- Brak nowej kwadratury, pełnego Solve anteny, H-only lub LLG.
  Nowy zatwierdzony eksperyment nadal V/J/H0/3, pełne kontrole H0/9,
  build0/1; dawne wyniki i historia zachowane.

Receipt, logi testów, oba JSON i przypięte źródła są w control volume grupy:
`verification/sushruth-a8-diagnostic-20261104/`.

## Dodatkowa kontrola materiałów autorów

Odczytano [stronę arXiv](https://arxiv.org/abs/2001.11483) oraz dokładnie
archiwum [2001.11483v1](https://arxiv.org/src/2001.11483v1). Zawiera
7 PNG, main.tex i main.bbl; brak kodu obliczeniowego i surowych tabel
w tym archiwum. Nie wykonywano jego zawartości.

TeX potwierdza parametry TableI i podpis Fig.3 użyte w naszym wzorcu.
Roboczy komentarz przy grubości rozważa20 lub16,8nm, lecz jawna tabela
podaje20nm. Nie zastąpiono nim parametru i nie ogłoszono, że wyjaśnia
przesunięcie. Fig03.png wysokiej rozdzielczości obejrzano; liczby odczytane
wcześniej z wydawniczego PDF pozostają osobnym, przybliżonym pomiarem.
Nie wykonano nowej digitizacji ani dopasowania do obrazu arXiv.

Archiwum nie daje rozstrzygającej recepty generowania krzywych. Brak kodu
w tym pliku nie dowodzi jego braku w innych publicznych zbiorach.
Nie przypisano błędu autorom ani implementacji bez dalszych dowodów.

## Co pozostaje

Potrzebne jest rozstrzygnięcie parametrów/definicji krzywych Fig.3,
kwalifikacja pełnego źródła GSG na trzech zamrożonych siatkach,
następnie baza/projekcja na ferromagnetyk i rzeczywista odpowiedź fal
spinowych. Nie zmniejszono zakresu E0–E12 do niezależnego wzorca.

Patch metadanych capture8→12MiB4581df0a… pozostaje niezastosowany,
ponieważ wcześniej wysłana decyzja nadal oczekuje na odpowiedź.
Nie ponawiano pytania ani nie obchodzono istniejącej granicy.

## Piny

- Gęsty JSON Eq1: `3fa8dd8400f906870c9e794a88dbfda902c74616ab54328d73b031d9fa2751cd`.
- Osobny JSON A8: `3ba7f5e27c29c50d58207f9da960eb4d4599c1922292401eb45f563f29540f01`.
- Archiwum arXiv: `3f4a0b06f64182ad842437dc00738afad144c07a0840a0adebcaf8b9cb084b89`.
- Fig03.png arXiv: `dc7a08ec34e42eeefc854437b64d9a3c071a2d59c68d3a012a23d470011329ba`.

Źródło wydawnicze: M.Sushruth iin., Electrical spectroscopy of forward volume
spin waves in perpendicularly magnetized materials, Phys.Rev.Research2,043203
(2020), [DOI](https://doi.org/10.1103/PhysRevResearch.2.043203), CC BY4.0.
