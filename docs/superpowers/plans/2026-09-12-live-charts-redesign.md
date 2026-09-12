# Refaktoryzacja Live Charts — 2026-09-12

## Cel i zakres

Przebudować moduł `live-charts` w Control Room jako czytelną powierzchnię do
obserwacji i porównywania przebiegów aktywnej symulacji. Zachować istniejące
zasoby v2, binarne dane tabeli, jednostki, decymację, stan Follow/Pause i eksport.

Worktree: `C:/git/fullmag/worktrees/live-charts-redesign-20260912`.
Branch: `codex/live-charts-redesign-20260912`.
Baza: `5084a94ed14b151fc865e8def5a5c28401e98b44`.
Owner: `codex:01a09454-1d4d-78a3-a2c7-ea91ca856d87`.

## Etapy i kryteria

1. Uporządkować hierarchię, akcje i selektory: preset, oś czasu/kroku, okno danych.
   Preferencje pozostają w istniejącym właścicielu; zmiana osi usuwa poprzedni
   zakres, którego wartości mają inne znaczenie. UI pokazuje tylko dostępne osie.
2. Lista sygnałów: wyszukiwanie, aktualna wartość i jednostka, All/None,
   obsługa klawiatury i izolowanie sygnału. Wybrane sygnały zajmują powierzchnię
   wykresu; nieaktywne jednostki nie tworzą pustych kart.
3. Stałe kolory serii po zmianie widoczności; dopasowane formatowanie wartości
   i jednostek. Osobne wykresy dla niezgodnych jednostek. Brak nowego polling.
4. Weryfikacja: testy modeli i UI, istniejące kontrakty i lifecycle, typecheck,
   lint, architecture hygiene, test suite, React Doctor dla zmian. Browser smoke
   z fixture: interakcje, jasny/ciemny motyw, wąski panel, canvas i idle.
5. Review, spójne commity, push, PR do master, wymagane CI/review, merge,
   bezpieczna aktualizacja głównego checkoutu i cleanup worktree.

## Bieżący checkpoint

- [x] Identyfikacja modułu, konsumentów i kontraktów; osobny zarejestrowany worktree.
- [x] Implementacja układu, sterowania, selekcji i eksportu — focused Vitest zakończony PASS.
- [x] Instalacja zależności w izolowanym storage worktree; końcowy focused Vitest:
  17 plików, 83 testy, PASS, 11.74 s.
- [x] Typecheck, pełny ESLint, architecture hygiene, API hygiene i składnia smoke
  zakończone PASS.
- [x] React Doctor dla zmienionych plików: brak problemów; zewnętrzne API oceny
  było niedostępne, więc wynik liczbowy nie został użyty jako dowód.
- [x] Browser smoke z fixture, canvas/WebGL, zmiana osi i okna, Search, All/None,
  motywy, reduced motion, zoom 200%, idle oraz lifecycle zakończone PASS.
- [ ] PR, kontrole integracyjne, merge i bezpieczny cleanup worktree.

Ciężkie buildy pozostają na trasie container-backed runnera (`just runner-build`),
natomiast lekkie testy frontendowe są wykonywane poza katalogiem buildów, w
własnym storage worktree. Instalacja `pnpm` zakończyła się z własnym
`virtual-store-dir`, ochroną `build_lock` oraz zapisanym logiem i statusem.
Zadanie nie zmienia solvera ani fizyki.

## Zmiany przygotowane do wykonawczej weryfikacji

- Responsywny nagłówek, pasek sterowania oraz lista sygnałów; na wąskiej
  powierzchni lista przechodzi nad wykres. Jawny wybór osi opiera się na
  publikowanych kolumnach i zachowuje wcześniej skonfigurowaną oś.
- Search, All/None, wartości z pasującymi jednostkami, keyboard/Shift solo;
  ukryte jednostki nie tworzą pustych pane'ów.
- `unitLayout: split-panes` pozwala Live Charts zachować wszystkie rodziny
  jednostek bez zmiany domyślnej polityki adaptera dla innych konsumentów.
- Stałe kolory serii, stabilne chartId, status liczony z widocznych serii.
- CSV/TSV z górnej akcji: jeden plik dla wszystkich zaznaczonych sygnałów
  oraz provenance. PNG: osobny plik na widoczny pane jednostki, z unikalną nazwą.
  Eksport pustego wyboru jest obsłużonym no-op, nie zawiesza komendy.
- Nowa oś resetuje zakres zapytania i zoom. Selector historii jest dostępny
  tylko dla tabeli; Energy zachowuje istniejące ograniczenie historii do 800
  próbek i nie otrzymuje pozornie działającego selektora zakresu.
- Przygotowane regresje modelu, UI, eksportu i stabilności kolorów; rozszerzony
  browser smoke o Search, All/None, pojedynczy eksport i wąską powierzchnię.

## Dowody i pozostała blokada

PASS: focused Vitest obejmujący moduł Live Charts, hooki, prezentację, eksport,
legendę i scalar-table: 17 plików, 83 testy, 11.74 s. TypeScript typecheck,
pełny ESLint, architecture hygiene, API hygiene, `node --check
apps/control-room/scripts/smoke-live-charts.mjs` oraz `git diff --check`
zakończyły się kodem 0. React Doctor przeskanował 21 plików i zgłosił brak
problemów; jego serwis oceny był niedostępny w tej sesji.

PASS: browser smoke uruchomiony na fixture z izolowanymi odpowiedziami v2.
Dowód obejmuje: geometria wykresu bez ucięcia przy zoom 200%, canvas 570×342
z zachowanym kontekstem, oś `Step → Time (s) → Step`, okno
`Latest samples → Full history → Latest samples`, dokładne odczyty
`mx=0.97982`, `my=0.10317`, `mz=4.4470e-6`, osiem kombinacji widoczności,
brak nieudanych odpowiedzi, brak żądań podczas 3-sekundowego idle oraz
`chartInstances=1`, `liveResizeObservers=1`, `activeWorkers=1` po stabilizacji.
Zrzuty i logi zapisano w
`C:\\git\\fullmag\\storage\\builds\\live-charts-redesign-20260912-f2e7bb663a3cfe15\\frontend\\artifacts\\live-charts-redesign-final3`.

Pierwszy zweryfikowany etap zapisano jako
`e489b572a91f095a612c0b7286df958adfdadadf`: stałe kolory serii oraz eksport
czekający na gotowość renderera. Drugi etap zapisano jako
`f092ee508`: pełny układ Live Charts, selekcja sygnałów, osie/okna, split-pane,
smoke i dokumentacja. Dowody: focused Vitest, typecheck, lint i browser smoke.
Hook commita zgłosił istniejący, niezmieniany łańcuch iteracji w
`chartRenderer.ts:213`; nie jest to nowa regresja.

Pełny suite uruchomiony przed końcową korektą: 640 plików PASS, 15 FAIL,
1 SKIP; 6392 testy PASS, 19 FAIL, 1 SKIP, 217.97 s. Żaden błąd nie dotyczył
Live Charts; niepowodzenia wynikały z istniejących testów źródłowych
oczekujących LF przy checkoutcie CRLF oraz jednego oczekiwania angielskiego
separatora tysięcy w locale pl-PL. Test separatora został uodporniony na locale
hosta; pełny suite pozostaje oznaczony jako ograniczony przez te niezależne
awarie bazowe.

Runner nie ma osobnego profilu frontend verification/dev. Profil
`fem-cpu-release` instaluje i buduje frontend w prywatnym workspace runnera,
lecz nie uruchamia pełnego suite ani browser smoke; te bramki pozostają osobnymi
dowodami do zebrania.

Stan: oba etapy zapisane (`e489b572a91f095a612c0b7286df958adfdadadf`,
`f092ee508`). Rejestr worktree pozostaje
`active` w `storage/index/live-charts-redesign-20260912-f2e7bb663a3cfe15.json`.
Następny krok: push/PR/merge, weryfikacja na
`master` i usunięcie wyłącznie tego zweryfikowanego worktree.
