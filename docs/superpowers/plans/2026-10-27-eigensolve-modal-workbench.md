# Przebudowa przeglądarki dyspersji i modów

Cel: te same opublikowane wyniki FEM i krzywe odniesienia dostępne w głównym UI, z wyborem konkretnego k i rzeczywistego zespolonego modu. Nie uruchamiamy ponownie solvera przy nawigacji.

## Usterki potwierdzone

- Spektrum nakłada wszystkie próbki k na jedną oś numeru modu. To nie jest widmo dla konkretnego k ani widmo intensywności.
- Kliknięcie kolekcji Results zmienia Inspector, ale pozostawia główny viewport 3D.
- Metadane i wewnętrzne identyfikatory wypychają wykres poza widoczny obszar.
- Karty modów w wąskim Inspectorze kolidują z kontrolkami.
- Importowana referencja nie ma współrzędnych wektora k i wyłącza podpisaną oś dyspersji.

## Etapy i kryteria odbioru

1. **Izolacja spektrum według k.** Zachować oryginalne rowIndex, sample/raw mode i właściciela. Wybór próbki, tylko jej mody. Widmo indeksów modów wyraźnie opisane jako diagnostyczne, bez sugerowania intensywności.
2. **Główny obszar analizy.** Kliknięcie spektrum/dyspersji Results otwiera Analysis. Wykres zajmuje pierwsze miejsce, szczegóły naukowe i provenance są zwijane. Dostępna akcja wybranego modu do 3D.
3. **Odniesienie i dyspersja.** Numeryczne punkty scatter i referencje line. Przekształcać referencje path→k wyłącznie po jednoznacznej opublikowanej ścieżce; nigdy ekstrapolować ani wybierać modu z referencji. Zachować run/stage/revision.
4. **Weryfikacja.** Testy modeli i komponentów w CI; rzeczywisty browser na aktualnych 15 punktach: Gamma, ±10 i ±25, wybór modu→pole, obie osie, brak kolizji i odcięcia przy zmianie rozmiaru. Porównać wartości z CSV. Przed zamknięciem zarchiwizować screenshot i dowody.

## Granice

Zachować istniejące FMR, driven i dynamics. Dane serwerowe tylko przez resource hooks; stan UI przechowuje identyfikatory i preferencje. Referencja analityczna musi opisywać model i warunki brzegowe; dopasowanie jednej gałęzi nie kwalifikuje kompletności widma. Niedokończona migracja FMS pozostaje oddzielna. Pełne zamknięcie wymaga przejścia bramek, a nie tylko poprawnego kodu.

## Checkpoint wdrożenia

Etapy 1–3: wdrożone. Etap 4: PASS w zakresie benchmarku — pełne CI frontend/browser `40589135703`, metoda/Doctor `40586700787` oraz rzeczywiste pięć pól i piętnaście punktów na `d99aa5b2c`. Domyślne punkty FEM i opcjonalne linie opublikowanych gałęzi mają osobne, sprawdzone tryby.

Dowody i ograniczenia: `docs/audits/2026-10-27-eigensolve-modal-workbench-ui.md`. HTTP 500 katalogu artefaktów, FMS roundtrip, osobna kwalifikacja starszego globalnego Spectrum na danych runtime oraz kompletność i zbieżność naukowa nie są zamknięte przez tę przebudowę UI.
