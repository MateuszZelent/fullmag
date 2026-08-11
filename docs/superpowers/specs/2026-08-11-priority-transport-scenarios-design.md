# Roadmapa priorytetowych scenariuszy transportu spinowego

**Status:** zatwierdzona kolejność; etap 1 jest jedynym aktywnym programem

**Data:** 2026-08-11

## 1. Kolejność

Rozwój jest podzielony na trzy niezależne programy produkcyjne:

1. racetrack ze skyrmionem pobudzanym rozwiązanym prądem, transportowym
   SOT/STT i pomiarem kąta Halla;
2. pole Oersteda obliczane z zaakceptowanego pola prądu;
3. pełny CPP-MTJ z TMR/GMR, akumulacją spinową i mixing conductance.

Etap 1 jest zamykany od Python/UI i `ProblemIR`, przez solver charge/spin i
LLG, aż po managed CUDA runtime, walidację fizyczną oraz porównanie z MuMax3.
Nie rozpoczynamy wdrażania etapu 2 ani 3 przed produkcyjnym zamknięciem etapu
1. Dokumenty wspólnej fizyki mogą zachowywać przyszłe kontrakty, ale nie wolno
na tej podstawie traktować Oersteda albo MTJ jako aktywnych zadań.

Szczegółowy projekt etapu 1 znajduje się w
[2026-08-11-solved-current-skyrmion-racetrack-design.md](./2026-08-11-solved-current-skyrmion-racetrack-design.md).

## 2. Wspólna zasada fizyczna

Rozwiązany charge transport tworzy niezmienny zaakceptowany snapshot `V` i
konserwatywnego pola `J_c`. W etapie 1 snapshot zasila direct SHE, steady spin,
transportowy torque i LLG. W przyszłości ten sam kontrakt źródła zostanie
wykorzystany przez Oersteda i CPP-MTJ; nie oznacza to jednak wspólnego
harmonogramu wdrożenia.

Prescribed SOT/STT pozostaje osobnym modelem pomocniczym. Nie jest dowodem
wykonania ścieżki solved-current ani podstawą promocji capability transportu.

## 3. Kryterium przejścia do etapu 2

Etap 1 musi mieć jednocześnie status:

- publicznie wykonywalny w Python DSL i Control Room;
- wykonany w FDM/CUDA/FP64/strict bez fallbacku;
- zgodny z niezależnymi oraklami charge, SHE, spin i torque;
- zbieżny względem siatki oraz kroku czasu;
- porównany z MuMax3 w jawnie wspólnym limicie dynamiki;
- wyposażony w wersjonowany pomiar trajektorii i kąta Halla;
- odtwarzalny z artefaktów, checkpointu i pełnej proweniencji;
- oznaczony jako produkcyjnie kwalifikowany dla dokładnie wymienionego
  workloadu.

Dopiero spełnienie wszystkich warunków pozwala przygotować osobną
specyfikację i plan pola Oersteda.

## 4. Zakres odroczony

### 4.1. Pole Oersteda

Odroczone w całości do etapu 2. Nie jest częścią kryteriów ani kodu racetracku
etapu 1. Przyszła realizacja musi konsumować ten sam zaakceptowany snapshot
`J_c`, ale otrzyma własny projekt, plan, bramki i kwalifikację.

### 4.2. CPP-MTJ

Odroczone w całości do etapu 3. Model thin-layer homogenized Slonczewski nie
kwalifikuje pełnego CPP-MTJ. Przyszły etap otrzyma osobny projekt obejmujący
TMR/GMR, spin accumulation, nieciągłe ślady i mixing conductance.
