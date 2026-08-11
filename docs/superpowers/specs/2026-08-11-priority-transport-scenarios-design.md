# Projekt priorytetowych scenariuszy transportu spinowego

**Status:** zatwierdzony kierunek; oczekuje na przegląd zapisanej specyfikacji

**Data:** 2026-08-11

**Zakres:** racetrack ze skyrmionem, spójny Oersted oraz pełny CPP-MTJ

**Pierwsza bramka wykonawcza:** FDM / CUDA / FP64 / strict

## 1. Cel

Celem jest uzyskanie trzech produkcyjnych scenariuszy, które korzystają z
jednego kontraktu transportu ładunku i spinu:

1. racetrack ze skyrmionem pobudzanym rozwiązanym prądem, z direct SHE,
   akumulacją spinową, transportowym SOT/STT i pomiarem kąta Halla;
2. pole Oersteda obliczane z dokładnie tego samego zaakceptowanego pola
   gęstości prądu `J_c`, które zasila transport spinowy i torque;
3. wielowarstwowy CPP-MTJ z TMR/GMR, akumulacją spinową i interfejsowym
   mixing conductance.

Pierwszym wykonawczym celem jest ograniczona, jawna ścieżka
FDM/CUDA/FP64/strict. FEM nie otrzymuje odmiennego modelu fizycznego. Po
kwalifikacji ścieżki FDM realizuje ten sam kontrakt na wspólnej domenie FEM.

## 2. Decyzja architektoniczna

Wspólnym stanem źródłowym jest niezmienny, zaakceptowany snapshot transportu
ładunku. Zawiera potencjał `V`, konserwatywne prądy ścianowe `J_c`, geometrię,
maski przewodników, materiały, interfejsy, warunki brzegowe, rewizje operatorów
oraz kryteria akceptacji. Snapshot jest tworzony tylko po przejściu residual,
bilansu elektrod, zgodności gauge i kontroli topologii przewodzącej.

```text
Python/UI
  -> ProblemIR
  -> planner i capability gate
  -> solved charge snapshot: V, J_c, topology, provenance
       |-> steady spin + direct SHE -> mu_s, Q -> torque -> LLG
       |-> Oersted[J_c] -> H_Oe -> ten sam krok LLG
       `-> CPP-MTJ interfaces -> TMR/GMR, mixing, torque
  -> artefakty, obserwable i kwalifikacja
```

Nie wolno tworzyć drugiego pola prądu dla Oersteda ani przeliczać CPP-MTJ na
homogenizowany lokalny torque Slonczewskiego. Torque transportowy konsumuje
bilans spinowego momentu pędu: objętościowe reakcje spinu oraz poprzeczną
absorpcję na zorientowanym interfejsie.

## 3. Etap A: racetrack FDM/CUDA/FP64

### 3.1. Problem fizyczny

Warstwa heavy-metal i ferromagnetyczny racetrack tworzą jedną zorientowaną
strukturę. Solver charge wyznacza `J_c`. Direct SHE generuje tensor prądu
spinowego `Q`, a steady drift-diffusion wyznacza wektorową akumulację spinową
`mu_s`. Oddziaływanie wymiany i dephasing w ferromagnetyku oraz absorpcja
poprzeczna na interfejsie przekazują moment pędu do LLG.

Nie należy utożsamiać tej ścieżki z prescribed SOT. Prescribed SOT może
pozostać osobnym modelem pomocniczym, ale nie jest dowodem wykonania solved
SHE/SOT/STT.

### 3.2. Pierwszy ograniczony workload

Pierwsza publiczna bramka obejmuje:

- FDM, jawnie `device=gpu`, `precision=double`, `mode=strict`;
- pełny prostokątny grid bez PBC i bez nieaktywnych komórek;
- jeden zaakceptowany transport charge z elektrodami prądowymi albo
  napięciowymi i jednoznacznym gauge;
- materiały HM/FM o stałych współczynnikach w każdej części;
- direct SHE w warstwie HM;
- steady spin M1, bez iSHE i bez transient spin;
- jeden zorientowany interfejs HM/FM z jawnym mixing conductance;
- torque przekazany device-to-device do RHS LLG;
- deterministyczną dynamikę FP64 bez termicznego szumu w pierwszym teście;
- śledzenie środka skyrmionu oraz estymację kąta Halla ze składowych prędkości.

Każde rozszerzenie, w tym PBC, maski częściowe, FP32, M2/iSHE, transient spin,
szum termiczny i wiele urządzeń, pozostaje fail-closed do czasu osobnej bramki.

### 3.3. Obserwable

Scenariusz publikuje co najmniej `V`, `J_c`, `mu_s`, `Q`, torque transportowy,
`H_eff`, `m`, położenie skyrmionu, ładunek topologiczny oraz kąt Halla.
Definicja kąta Halla używa regresji liniowej zaakceptowanego odcinka trajektorii:

```math
\Theta_H = \operatorname{atan2}(v_\perp, v_\parallel).
```

Kierunki równoległy i poprzeczny wynikają z podpisanego kierunku średniego
prądu w racetracku. Artefakt zapisuje przedział czasu regresji, kryteria
odrzucenia transientu, niepewność dopasowania oraz konwencję znaku.

## 4. Etap B: Oersted z tego samego prądu

Oersted jest drugim konsumentem snapshotu charge, a nie niezależnym źródłem
prądu. Identyfikatory snapshotu, rewizji źródła, siatki i etapu muszą być
identyczne w torze spinowym, torque i `H_Oe`.

Dla FDM docelowym operatorem jest open-boundary FFT/Biot-Savart z jawnym
modelem domknięcia obwodu i przewodów doprowadzających. Pierwsza bramka może
użyć ograniczonej, analitycznie sprawdzalnej geometrii przewodnika, lecz nie
może pomijać powrotu prądu, jeżeli powodowałoby to zależność wyniku od
arbitralnego ucięcia domeny.

`H_Oe` jest materializowane dla każdego zaakceptowanego źródła prądu zgodnie z
polityką refresh. Odrzucony krok adaptacyjny nie publikuje nowego snapshotu ani
nie pozostawia pola obliczonego z odrzuconego `J_c`.

## 5. Etap C: pełny CPP-MTJ

CPP-MTJ jest osobnym workloadem wielowarstwowym. Wymaga pionowego transportu
przez stos, zorientowanych interfejsów i zachowania nieciągłych śladów
potencjału oraz akumulacji spinowej.

Minimalny model obejmuje:

- pinned layer, barrier/spacer i free layer;
- CPP charge transport z zależnością rezystancji od konfiguracji magnetycznej;
- przewodnictwa kanałów spinowych albo równoważny jawny tensor
  magnetorezystywny dla TMR/GMR;
- wektorową akumulację spinową po obu stronach interfejsu;
- `G_up`, `G_down` oraz zespolone mixing conductance `G_r + iG_i`;
- konserwatywny prąd ładunku, longitudinal spin injection/backflow,
  poprzeczną absorpcję i torque interfejsowy;
- obserwable `R_P`, `R_AP`, TMR/GMR, `mu_s`, prąd spinowy i torque;
- coupling do LLG free layer przy nieruchomej albo dynamicznej pinned layer,
  zależnie od jawnej konfiguracji.

Model thin-layer homogenized Slonczewski pozostaje osobną aproksymacją i nie
kwalifikuje pełnego CPP-MTJ.

## 6. Kontrakt warstw produktu

### 6.1. Python, UI i ProblemIR

Brak modułu transportu w Python DSL albo UI oznacza brak węzła transportu w
ProblemIR i brak transportowych węzłów Explorer. `J_c=0` nie służy do
decydowania o obecności modułu.

Python i UI muszą round-tripować wszystkie materiały, interfejsy, BC, gauge,
modele SHE, solver policies, coupling, Oersted closure, outputy oraz żądanie
wykonania. UI nie może posiadać alternatywnego modelu fizycznego ani
automatycznie dodawać spin transportu do każdego obiektu magnetycznego.

### 6.2. Planner i runtime

Planner sprawdza kompletność grafu, kompatybilność modeli i dokładny tuple
backend/device/precision/mode. Wymuszone GPU failuje bez fallbacku. Runner
materializuje deskryptory, wywołuje natywne ABI, publikuje artefakty i
proweniencję; nie implementuje operatorów transportowych.

### 6.3. Własność solverów

Produkcja FDM należy do `backends/fdm`, a FEM do `backends/fem`. CPU i GPU są
odrębnymi realizacjami wspólnej fizyki. Przeniesienie do FEM następuje przez
tożsamość kontraktu fizycznego i porównanie zbieżności, nie przez kopiowanie
dyskretyzacji FDM.

## 7. Warunki błędów i fail-closed

Wykonanie kończy się przed uruchomieniem kerneli lub publikacją wyników, gdy:

- snapshot charge jest niezaakceptowany, obcy, nieaktualny albo ma inną rewizję;
- torque i Oersted wskazują różne źródła `J_c`;
- topologia, orientacja interfejsu, BC albo gauge są niepełne;
- model wymaga capability nieobsługiwanej przez wybrany tuple;
- residual lokalny, bilans elektrod, bilans spinu lub bilans momentu pędu nie
  spełniają normatywnych tolerancji;
- żądany model CPP jest zastępowany aproksymacją homogenizowaną;
- krok LLG lub transportu został odrzucony, a callback nie przywrócił całego
  wspólnego stanu.

Nie publikuje się częściowych pól jako zaakceptowanego wyniku.

## 8. Walidacja i definicja ukończenia

### 8.1. Racetrack

Wymagane są: analityczny profil direct SHE w ograniczeniu 1D, CPU-reference ↔
CUDA FP64 parity, zbieżność `mu_s` i torque, symetrie znaku po odwróceniu prądu
i `theta_SH`, zachowanie ładunku topologicznego, zbieżność kąta Halla po
zagęszczeniu siatki i kroku czasu oraz porównanie z publikowanym benchmarkiem.

### 8.2. Oersted

Wymagane są: przewodnik o rozwiązaniu analitycznym, direct Biot-Savart oracle,
sprawdzenie `curl H = J` i `div B = 0` w odpowiedniej interpretacji,
odwrócenie znaku z prądem, zbieżność przestrzenna i dowód identyczności źródła
z torem transportowym.

### 8.3. CPP-MTJ

Wymagane są: granice P/AP, zerowy mixing, transparent interface, current
reversal, bilans spinu i momentu pędu, zbieżność warstwowa, CPU-reference ↔ GPU
FP64 parity oraz porównanie z zewnętrznym solverem i literaturą. TMR/GMR muszą
być liczone z rezystancji wyprowadzonych z rozwiązanego prądu, a nie z
podstawionej wartości katalogowej.

### 8.4. Status produkcyjny

`implemented`, `publicly executable`, `runtime proven`, `physically
validated` i `production qualified` są osobnymi statusami. Żaden scenariusz
nie jest produkcyjny bez managed-device proof, niezależnego orakla, zbieżności,
proweniencji i pełnego Python/UI round-trip.

## 9. Kolejność realizacji

1. publiczny FDM/CUDA steady spin M1 konsumujący istniejący zaakceptowany
   snapshot charge;
2. direct SHE, mixing i transport torque przekazane do RHS LLG;
3. minimalny dynamiczny racetrack i pipeline kąta Halla;
4. FDM Oersted konsumujący ten sam snapshot i wspólny lifecycle kroku;
5. rozszerzenie descriptorów charge/spin o pełny CPP-MTJ i TMR/GMR;
6. referencyjne i produkcyjne realizacje FEM tego samego kontraktu;
7. kwalifikacja krzyżowa FDM/FEM, CPU/GPU oraz porównania zewnętrzne.

Każdy punkt stanowi osobną bramkę TDD, review i managed-runtime. Nie awansuje
się capability całego modelu na podstawie przejścia jednego ograniczonego
workloadu.

## 10. Poza zakresem pierwszej bramki

Pierwsza bramka FDM/CUDA nie obejmuje M2/iSHE, transient spin M3, FP32,
multi-GPU, PBC, termicznego szumu, arbitralnych masek, circuit co-simulation,
MQS skin effect ani pełnej kwalifikacji FEM. Elementy te pozostają w planie
głównym, lecz nie mogą rozszerzać pierwszego testowalnego workloadu.
