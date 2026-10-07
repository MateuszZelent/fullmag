# Odbiór audytu GPT PRO eigensolve — 2026-10-01

Audyt oryginalny: [zachowana kopia](2026-10-01-gpt-pro-eigensolve-ab64bac-original.md). Audytowany SHA: ab64bac46b7ceda295812da93244b2eba81174e4. Odbiór dotyczy HEAD 3b67a9f3c6a75e0d8d5c28116170477784c3a570. Oryginał nie jest przepisywany. Dołączony raport odsyła do SOURCE_INDEX.md, którego nie otrzymano; weryfikacja korzysta z obecnych źródeł i podanych zamrożonych odwołań. Liczby commitów za masterem w oryginale są historyczne; nie wykonano fetch/merge ani nie uznano ich za bieżący pomiar.

## Weryfikacja ustaleń i priorytety

| ID | Etap planu | Stan odbioru | Dowód bieżący i działanie |
|---|---|---|---|
| F01 | S03/S04/S12 | Potwierdzony, otwarty P1 | assemble_native_magnetic_a_qq nadal używa reguły rzędu1 również dla prism6. Przygotować politykę kwadratury z transformacją/Jacobianem; kontrola rzędu/nullspace, kontrprzykład hourglass, permutacje, geometrie afiniczne/deformowane i nadcałkowanie. Bieżący pilot tetrahedral nie korzysta z prism6. Nie kompensować błędu zmianą A. |
| F02 | S07/S08 | Poprawiony źródłowo; runtime NOT VERIFIED | get_mode/get_mode_v2 używają read_selected_eigen_mode bez sample→legacy fallbacku. Brak404/parse500 zachowane; legacy tylko bez sample_index. Cztery regresje filesystem przygotowane, niekompilowane. Parser PASS; endpoint/runtime/browser oraz pełny run/stage ownership nadal wymagają dowodu. |
| F03 | S08/S10 | Poprawiony źródłowo; direct source check PASS | Spec i writer: damping_rate_hz=frequency_imag_hz=HWHM; usunięto także błędne /2. Rachunek w Hz, konwersja osi, unknown units unsupported i label illustrative. Direct Node24 productionTS:5grup kontroli PASS, Vitest niekompilowany/nieuruchomiony. Nowoczesny panel używa innego rank-vsHz modelu; browser/produkt nadal NOT VERIFIED. |
| G01 | S10 | Otwarty; częściowo nowsze źródła | Migracja canonical/raw Ku jest już w799be85, lecz runtime NOT VERIFIED i publiczny guard nadal działa. Nie usuwać strażnika przed pochodnymi/accepted state/runtime; DMI/spatial/surface/cubic/Gilbert mają osobne bramki. |
| G02 | S05/S06/S12 | Potwierdzone ograniczenie smoke | collect_record nadal wymaga pojedynczego sample0/rawmode0. Smoke nie jest certyfikatem branch continuity. Wdrożyć multi-candidate, consistent-mass complex MAC, degeneracy/subspaces, branch/cluster/confidence i transfer między siatkami. |
| G03 | S00/S04/S05/S12 | Otwarta bramka wykonania | Lokalnie build#188 i14artefaktów receipt były zweryfikowane; audyt zewnętrzny ich nie otrzymał. Aktualny solve nadal bez końcowej nowej częstotliwości; kapsuła#188 nie zawiera799be85 ani3b67a9f3. Nie przypisywać starych wyników nowemu HEAD. |
| G04 | S00/S04/S12 | Zasadna rozbieżność modelu; do sprawdzenia na danych | Pilot skończonego Dirichleta i open-film oracle to dwa BC. Dla t10nm,d2µm porównać Gamma z Nzz=1-t/(t+2d), około9.299249694GHz, a granicę otwartą z9.309813709GHz. Zweryfikować faktyczne boundary tags i projekcję pola. Nie przesuwać częstotliwości ani rozluźniać residualu. |
| H01 | S05/S06 | Hipoteza, nie potwierdzony błąd | Prześledzić deduplikację realifikacji wszystkich tras aż do writera: q/iq kontra niezależne mody zdegenerowane. MAC/subspace i count/completeness, nie częstotliwość jako jedyne kryterium. |
| H02 | S01/S04/S10 | Hipoteza, otwarty dowód | Ta sama dyskretna energia, ramki i accepted state: pochodne ograniczone do rozmaitości, Aqq i coupling, przypadki tekstur/material fields. |
| H03 | S01/S04 | Hipoteza, otwarty dowód | Gauge według BC i trywialności wszystkich faz, nie wyłącznie normy k; Gamma,k→0, reciprocal Gamma, Neumann compatibility i Dirichlet bez usuwania pola. |

## Kolejność wykonania w ramach pełnego S00–S12

1. Zamknąć trzy potwierdzone błędy w osobnych spójnych przyrostach: F02 sample ownership; F03 jednostki/definicja obwiedni; F01 kwadratura. Zachować odpowiednie wykonywalne regresje. Testów natywnych nie kompilować do odwołania zakazu w AGENTS.md; managed runtime-only pozostaje właściwą trasą.
2. Zachować aktywny Gamma #188; po zakończeniu sprawdzić oryginalne residuale, źródła, equilibrium, BC, phi/Hdemag i skończoną referencję. Nie restartować ani nie obchodzić lease, aby zbudować nowe źródła. Po lease nowy pełny SHA i receipt runtime-v2.
3. Wykonać30rzeczywistych runów signed DE/BV oraz oddzielny multi-mode branch/subspace odbiór. Wyniki smoke nadal oznaczać ograniczeniem rawmode0. Nie odbijać punktów ujemnych.
4. Rozdzielić pięć zbieżności: x/y, warstwy, airbox/BC, solve accuracy/operator action, liczba/zakres modów. W punktach Gamma/małe k/hybrydyzacje śledzić tę samą gałąź, nie indeks. Zachować algebraiczną bramkę1e-8 do jawnego error budget.
5. A1 COMSOL: antidot200×200nm,film10nm,r50nm,61punktów Gamma-X-M-Gamma,24modów — oddzielny model od filmu40nm. Dopasować geometrie/BC/material/equilibrium i profile; CSV/oracle nie są wynikiem Fullmag.
6. Zachować pełne interakcje,2.5D/TetraX,GPU z parytetem i>1024DOF oraz UI/FMS/browser. Review i integracja nie są zamknięte przez source parser ani wykres.

## Dług i niepokryte bramki

Zachować w planie: canonical/raw identity (źródła wdrożone, runtime oczekuje), model kwadratury wszystkich bloków, odróżnienie ok/build/solve/complete/qualified, adaptery v2/v3/legacy, jawne smoke windows/count, budżety tolerancji SI, przyczyny odrzucenia punktów/serii UI, definicję syntetycznej obwiedni i centralizację kontraktów. Nieukończone obszary audytu zewnętrznego nie oznaczają braku implementacji; należy objąć je kolejnym pełnym przeglądem Python→IR→planner→ABI→writer→UI.

S00–S12 pozostają otwarte. Dokument rejestruje stan źródeł i plan odbioru; nie promuje solvera do scientifically-qualified. F02 ma poprawkę źródeł i przygotowane regresje; F03 poprawkę funkcji i wykonany direct source check. F01 pozostaje otwarty; managed runtime/browser F02/F03 nadal wymagają odrębnego dowodu. Sam dokument nie jest dowodem wykonania API lub solvera.

SHA256 oryginalnego audytu: f266262a8828541fdecc5e50a9705bd7bc59046df61b55d3645b0da8e52a81c4

## F01 — niezależne potwierdzenie, 2026-10-01

Review źródeł potwierdził order1 w `assemble_native_magnetic_a_qq` i tę samą
zaniżoną regułę w `independent_prism_exchange_oracle`: obecny test jest kołowy.
Dla afinicznego prism6 skalarna macierz ma rangę najwyżej3 zamiast5. Wektor
`[0,1,-1,0,-1,1]` ma przy regule jednopunktowej energię0, choć niezależna całka
`∫|grad u|² dV=2/3` na jednostkowym pryzmacie. Dla K00 dokładne5/12 kontra11/36.

Poprawka musi zmienić kwadraturę i niezależny oracle razem. Minimalny rząd dla
afinicznego prism6 wynosi2; kandydat produkcyjny to wspólna reguła4 używana już
w pozostałych blokach. Dla zdeformowanych elementów potrzebna jest osobna
zbieżność4→5/7. Zachować CalcPhysDShape, Jacobian, mapy i transport tangent-frame.
Regresje: exact matrix/rank5/constant-only nullspace/hourglass energy/PSD,
orientacje i mapy oraz gauge k0 kontra invertible nonzero-k. F01 pozostaje
OPEN; powyższa diagnoza nie jest naprawą ani natywnym wykonaniem.

Niezależna kontrola matematyczna w Python stdlib/Fraction PASS: całkowanie
momentów `x^i y^j z^l = i!j!/(i+j+2)!/(l+1)` potwierdziło rank5/rank3,
stały nullspace, energię2/3 kontra0 i K005/12 kontra11/36. To dowód referencji
analitycznej, nie wykonania produkcyjnego MFEM. Próba Sympy nie wystartowała
(brak modułu); nie instalowano zależności ani nie zmieniano runtime.
