# Kontrola tożsamości porównania DE — 2026-09-30

## Wykryty błąd i poprawka

Starsze narzędzie `scripts/compare_de_100nm_pilot.py` nie wiązało opcjonalnego
`model_source` między żądaniem i wynikiem. Ponadto porównanie `return_code != 0`
przyjmowało wartości JSON `false` i `0.0`. Nie sprawdzano zgodności nazwy próby,
listy przypadków i operacji. Taki wynik mógł wejść do raportu porównawczego.
Nie wykazano, że którekolwiek historyczne dane solvera były w ten sposób pomylone.

Dodano `scripts/de_pilot_receipts.py::validate_de_pilot_receipts`, używane przez
wejście porównania. Wymaga ono całkowitego kodu procesu 0, właściwych schematów,
statusu `completed_unqualified` oraz zgodności model_sha256, job i source.
Jeżeli występuje oddzielny model_source, musi być niepustym obiektem identycznym
w obu receiptach. Jednostronny model_source nie przechodzi. Pola cases/operation
są sprawdzane, gdy są obecne; archiwalna trasa bez tych pól pozostaje obsługiwana.

## Dowody

- Przepisana dotychczasowa logika: RED, 10 niepowodzeń regresji/podtestów;
  przyczyny to niewłaściwy typ kodu, zmieniony model i niezgodne przypadki.
- Bieżący konsument i poprawiona logika: 15 testów i 19 podtestów PASS.
- Dokładnie staged poprawka na bazowych konsumentach HEAD, bez wcześniejszego
  WIP: 11 testów i 19 podtestów PASS; staged diff check PASS.
- Test wejścia `main` potwierdza odrzucenie przed dostępem do artefaktów
  i przed powstaniem katalogu analytic-comparison.
- Dane testowe są syntetyczne i dowodzą kontroli receiptów, nie wykonania FEM.
- Nie zmieniono żywych kontrolerów ani zależności przypiętych przez odbiornik
  sześciu prób DE/BV. Zmiana nie aktualizuje kapsuł #178 ani #179.

## Granice i kolejne kroki

Ta kontrola nie dowodzi hashy binarnego runtime, zgodności siatki, certyfikatu
widma, profilu moda ani zbieżności. Te bramki pozostają osobne. Pełny cel S00–S12
nie jest zakończony. Nowe wyniki warstw DE/BV i Γ nadal wymagają udanego #178,
odczytu artefaktów i oceny naukowej; A1 czeka dodatkowo na #179.
