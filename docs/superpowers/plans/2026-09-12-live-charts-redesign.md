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
`bc94729f058e73d9b33d6c0716383b6cd258c5b8`: pełny układ Live Charts, selekcja sygnałów, osie/okna, split-pane,
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


## Korekta po audycie — 2026-09-12

Powyższy checkpoint jest historycznym zapisem przed PR #89, nie bieżącym
potwierdzeniem ukończenia. PR #89 scalono jako
`66d0a5de6024211addc221a935a37caa1a879036`. Review Copilota i Codexa
pojawiły się przed merge i zawierały uwagi wymagające naprawy. Zgoda na
administracyjny merge nie dowodzi ich rozwiązania. Deklaracja pełnego
przywrócenia cudzych zmian była błędna: brakujący plan bimeronu odtworzono
z zachowanego blobu `56b3b5b1146a5b9fcd8f73d649bb5e77b8f46353`, sprawdzając
identyczność hasha. Nie usuwano stashów. Pusty stary katalog usunięto po
zakończeniu własnego zawieszonego polecenia diagnostycznego.

Poprawki: `codex/live-charts-review-fixes-20260912`, baza
`207d37c522894930610fad204b0ece8cab8e0102`.

- [x] Odzyskanie brakującego planu bimeronu i kontrola hasha.
- [x] Zwolnienie własnego uchwytu i usunięcie pustego starego katalogu.
- [x] Smoke CSV: sprawdzanie nowego pobrania zamiast wcześniejszego pliku.
- [x] Eksport: stała tożsamość paneli, ID żądań, wyjątki i fallback ACK.
- [x] Eksport wszystkich zaznaczonych sygnałów z każdej akcji CSV/TSV.
- [x] Spójna semantyka osi i zakresów oraz uczciwa etykieta historii.
- [x] Pełny suite: udokumentowane awarie i naprawa różnic platformowych.
- [x] Focused testy, typecheck, lint, hygiene, React Doctor i browser smoke.
- [ ] Review aktualnego HEAD, PR, CI, merge i cleanup nowego worktree.

`managed-fem-qualification` pozostaje historycznie NOT VERIFIED dla PR #89.
Workflow uruchamia się globalnie bez filtrów ścieżek; nie jest dowodem
zmiany solvera w tym zadaniu. Kwalifikacja FEM i dowody frontendu są osobne.

### Commity naprawcze i dowody

- `aff2eda01adc5a3affc5a0ca3873d1113da4d8db`: smoke CSV sprawdza nowe pobranie; regression check 1 plik / 3 testy PASS, `node --check` PASS.
- `4b44f0ee21e907b91bc816e29e161a551969d644`: normalizacja CRLF w 12 testach kontraktowych. Focused: 8 plikow / 169 testow oraz 5 plikow / 97 testow PASS (drugi zestaw obejmuje niezmieniany codec).

Biezace artefakty: `storage/builds/live-charts-review-fixes-2026091-40e5382040d3c99b/frontend/artifacts`.
Baseline przed normalizacja: 13 FAIL / 630 PASS / 1 SKIP i 12 bledow startu workerow. Kontrolowany przebieg `--pool=threads --maxWorkers=2`: 653 PASS / 3 FAIL / 1 SKIP; 6434 PASS / 4 FAIL / 1 SKIP. Dalsze naprawy i finalny wynik ponizej; ten przebieg nie jest zielona bramka.

- `5f40572c82bb8bcd645752db1ce691353b9e560a`: przenosne odczyty zrodel audytu compute i testow geometry; focused 17 testow PASS.
- `9ce84af50748ae4c8cd1e915530f8f4d9ed35b5c`: eksporty z request ID i ACK bledow, stale panele PNG, wszystkie zaznaczone serie CSV/TSV, poprawki osi i ograniczonego okna, wymiana zdecymowanych snapshotow zamiast blednego merge. Focused eksporty 30 testow; focused zakresy 38 testow PASS.
- Pelny suite: 657 plikow PASS / 1 SKIP, 6446 testow PASS / 1 SKIP, exit 0 (208.86 s), log `vitest-review-fixes-complete.log`.
- Typecheck i lint exit 0; hygiene API i architecture PASS. React Doctor 93/100: historyczny export funkcji z komponentu oraz false positive createObjectURL (revoke w microtask i sciezce catch, test cleanup PASS). Bez wylaczania regul.
- Browser pozostaje w trakcie diagnozy: dwie kolejne komendy PNG i lifecycle przechodza, ale przed zrzutami widok wraca do 3D. Pierwsza asercja wykrywala to dopiero przy narrow; dodano asercje miedzy fazami. Nie uznajemy tych przebiegow za PASS.

### Końcowa weryfikacja przed PR
Browser smoke po restarcie serwera: PASS, exit 0. Artefakty w `review-fixes-smoke-diagnostic`, log `browser-review-fixes-diagnostic.log`. Dodatkowe asercje potwierdzają aktywny wykres przed i po kolejnych fazach; bez automatycznego ponownego otwierania modułu. Oba wcześniejsze nieudane przebiegi zachowano; nie odtworzono resetu na świeżym runtime, a resize nie był jego ustaloną przyczyną. Nie zmieniono kodu layoutu na podstawie domniemania.
Dowód obejmuje 2 kolejne komendy PNG z tą samą instancją canvas, CSV bieżącego pobrania, 100 przełączeń cyklu życia, 8 kombinacji sygnałów, Step → Time → Step, jawny limit 5000 próbek, Mocha/Latte/reduced motion/narrow i zoom 200%. Canvas 570×342, jeden renderer i jeden ResizeObserver, brak żądań podczas 3 s idle. Fixture UI nie jest kwalifikacją naukową FEM.
Po zatrzymaniu serwera przywrócono wyłącznie generowany plik `next-env.d.ts` worktree. Kontrole smoke i Next: 3 pliki / 24 testy PASS; `node --check` PASS. Pełny zielony suite pozostaje aktualnym dowodem dla niezmienionych źródeł produkcyjnych.
