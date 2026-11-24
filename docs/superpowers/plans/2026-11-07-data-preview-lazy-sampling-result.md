# Podgląd danych: leniwe przechodzenie próbek — 07.11.2026

## Problem i zmiana

`apps/control-room/src/kernel/layout/dataPreviewModel.ts::centerBiasedSourceIndices`
przygotowywał tablicę indeksów wszystkich punktów nośnika, zanim
`buildDataPreviewRows` kończył pracę po najwyżej 64 niezerowych wierszach.
`DataPreviewDialog` ponownie wywołuje ten model dla podpisu danych.
Mały podgląd dużego tensora lub wektora alokował więc miliony indeksów.

Zastąpiono tablicę generatorem. Zachowano dokładnie centralny zakres,
naprzemienne rozszerzanie lewo/prawo, pomijanie zer, wartości i podpisy.
Pamięć pomocnicza iteratora jest stała; nie dodano limitu skanowanych zer.
Dla rzadkich pól lub samych zer najgorszy czas CPU nadal zależy od całego
nośnika. Nie zmieniono requestów, próbkowania API, wartości ani renderera.

## Pomiary przed i po

Scenariusze i metryki zapisano przed zmianą. Node v24.18.0 w istniejącym
frontendzie 271d8c4d455871a1b7b4b2fc34c55b9a122a3df305e0cd0c3382f072ac6779c4,
trzy próby każdego scenariusza, milion punktów, Float64. Pole wejściowe
alokowano przed pomiarem i nie wliczano go do heap delta.
Czas obejmuje utworzenie wierszy oraz podpisu, jak w dialogu.

| Scenariusz | Mediana przed [ms] | Mediana po [ms] | Heap delta po wierszach przed [B] | Heap delta po wierszach po [B] |
|---|---:|---:|---:|---:|
| Wektor, 17 wierszy | 46,216 | 0,138 | 17405960–31336360 | 11456–18000 |
| Tensor, 17 wierszy | 92,455 | 0,264 | 17404240–31338832 | 12336–270824 |
| Tensor, 64 wiersze | 57,202 | 0,642 | 17437056–31190272 | 45304–65984 |
| Tensor, dwa niezerowe punkty na krańcach | 154,894 | 67,875 | 17468160–71347288 | 181416–348272 |

To pomiar przyrostu użytego heap, nie peak RSS, czasu całej przeglądarki
ani limitu pamięci solvera. JIT, GC i obciążenie hosta wpływają na trzy
próby; nie deklarujemy uniwersalnego współczynnika przyspieszenia.
Wszystkie hashe wierszy i podpisów czterech scenariuszy są identyczne
przed i po. Nie zmniejszono jakości ani liczby pokazywanych próbek.

## Weryfikacja i zakres

- 14/14 focused Vitest: model podglądu, dialog, projekcja tensora.
- Nowe regresje obejmują parzyste i nieparzyste liczby punktów,
  rozszerzanie przez zera, wszystkie dziewięć składowych i nośnik zerowy.
- Typecheck całego frontendu i ESLint obu zmienionych plików: exit 0.
- Niezależny review całego diffu i pomiarów: brak Required findings.

Nie uruchamiano całej suite frontendu, nowego browser smoke, natywnego
buildu, meshowania, Solve lub restartu. Nie zmieniano DOM, lifecycle canvas,
Inspectora lub store. To wąska poprawka kosztu modelu podglądu, nie
kwalifikacja całego E10, renderowania tensora lub zgodności z publikacją.

## Dowody

Prywatna część frontend tego samego wolumenu grupy Compose:
`/state/development/verification/data-preview-sampling-20261107/` we frontendzie,
`/opt/fullmag/control/private/frontend/verification/data-preview-sampling-20261107/`
w backendzie. Nie zapisywano pomiarów w hostowym storage.

| Artefakt | SHA256 |
|---|---|
| plan.json | 6de3703a21688dbace4fec277b4c933e4d73d1b8bfb4715a1a6de452d9c7045f |
| baseline.json | a3c746ca02afaec5cda93832f67f2291f84ba3586d61f9bc870b14fe9e4d7c80 |
| after.json | 0f9a3d6e3fdb1b58e400f2a470a87701f358cb2f75f428a03213af07bcad2617 |
| comparison.json | ad6d339ed576b28395d155bad625cb47376d4956fc6f8badd25c0c9222fb831c |
| focused-tests.json | d3aa89ec34e0ddc2162af58f0f9aa57c8bec383fa7a9dd979de7c5d968da196f |
| typecheck.json | e045354ae2d74f5bdceb5b3ad73113b36ce64ca874a04d5512fd657469fb30bc |
| lint.json | 43c1e4eccda6bcc9135a32b3b5a91135d1b9de2922f295f55f9f448a2d64f9f2 |

`acceptance.json` wiąże pomiary i skrypty. SHA modelu przed zmianą:
eaa783b091a5c9080595ed68cdb30bae71c7d7234fbb53bc7fb1a60551db1bef;
po zmianie: 7c877060e786c08adc84dd2e2f6ec2f98dd64d576b50d52a0e9aafdcb95fb0ac.
Bazowy commit: ce72d0079a8b618e7cceb4110bd1f75845d3f11e.

Pełny cel E0–E12, kwalifikacja źródła i reprodukcja Sushruth pozostają otwarte.
