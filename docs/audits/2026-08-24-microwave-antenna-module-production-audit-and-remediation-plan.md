# Fullmag — audyt naukowo-techniczny i plan produkcyjnego wdrożenia modułu anten mikrofalowych

**Repozytorium:** `MateuszZelent/fullmag`  
**Bazowy commit raportu Pro:** `7aeaf2e6b91882209f6f6d506d29852884890b6c`  
**Commit użyty do ponownej inspekcji i scalenia:** `0388c3e7c4804923ee02a00b7ac4a789a44092d9`  
**Gałąź robocza podczas scalenia:** `codex/fix-pr-ci-gates-20260823`  
**Data audytu:** 24 sierpnia 2026  
**Tryb:** scalony audyt statyczny oraz skupiona walidacja dokumentacji, Python API i ProblemIR  
**Zakres:** Python API → IR → planner → runtime → FEM/FDM CPU/GPU → quantity/data plane → API v2 → frontend → analiza FFT/$k$-przestrzeni  
**Status dokumentu:** scalony audyt kanoniczny i rekomendowany plan produkcyjnego wdrożenia; twierdzenia o planowanych typach, zasobach i solverach nie opisują istniejącego kodu

> Dokument łączy szczegółowy raport ChatGPT Pro z niezależnym audytem
> repozytorium Fullmag. W razie rozbieżności pierwszeństwo mają symbole istniejące
> w bieżącym drzewie źródeł, wykonane testy i jawny status capability. Fragmenty
> docelowego API oraz architektury są oznaczone jako projekt, nie jako stan wdrożony.

## Spis treści

1. [Werdykt wykonawczy](#1-werdykt-wykonawczy)
2. [Terminologia normatywna](#2-terminologia-normatywna)
3. [Oczekiwany przepływ użytkownika](#3-oczekiwany-przepływ-użytkownika)
4. [Mapa aktualnej implementacji](#4-mapa-aktualnej-implementacji)
5. [Macierz aktualnych możliwości](#5-macierz-aktualnych-możliwości)
6. [Rejestr ustaleń audytowych](#6-rejestr-ustaleń-audytowych)
7. [Model fizyczny i wyprowadzenia](#7-model-fizyczny--definicje-i-pełne-wyprowadzenie)
8. [Sprzężenie z mikromagnetyką](#8-sprzężenie-pola-anteny-z-mikromagnetyką)
9. [Selekcja fal spinowych](#9-jak-poprawnie-określić-jakie-fale-spinowe-może-wzbudzić-antena)
10. [Analityczne widmo prostych anten](#10-analityczne-widmo-prostych-anten)
11. [Numeryczna analiza FFT](#11-numeryczna-analiza-fft-i-k-przestrzeni)
12. [Docelowa architektura domenowa](#12-docelowa-architektura-domenowa)
13. [Quantity, data plane i API](#13-quantity-data-plane-i-api)
14. [Docelowy frontend](#14-docelowy-frontend-i-drzewo-obiektów)
15. [Integracja z backendami](#15-integracja-z-backendami)
16. [Produkcyjny plan wdrożenia](#16-produkcyjny-plan-wdrożenia)
17. [Plan walidacji i kwalifikacji](#17-plan-walidacji-i-kwalifikacji)
18. [Kryteria akceptacji](#18-kryteria-akceptacji-per-obszar)
19. [Definition of Done](#19-definition-of-done--moduł-produkcyjny)
20. [Rekomendowane decyzje architektoniczne](#20-rekomendowane-decyzje-architektoniczne)
21. [Ryzyka](#21-ryzyka-i-działania-ograniczające)
22. [Bezpośrednia realizacja wymagań użytkowych](#22-odpowiedź-bezpośrednia-na-wymagania-użytkowe)
23. [Traceability](#23-traceability--kod-symbole-i-dowody)
24. [Układ nowych modułów](#24-rekomendowany-układ-nowych-modułów)
25. [Pseudokod](#25-pseudokod-przepływów-referencyjnych)
26. [Przykładowy Python API](#26-przykładowy-python-api-po-wdrożeniu)
27. [Bibliografia](#27-bibliografia-naukowa-i-techniczna)
28. [Lista ADR](#28-lista-decyzji-do-zapisania-jako-adr)
29. [Końcowa rekomendacja](#29-końcowa-rekomendacja)

---

(problem-statement)=
## 0. Cel, zakres i ograniczenia audytu

Celem audytu jest ustalenie rzeczywistego stanu implementacji anten mikrofalowych w Fullmagu oraz zdefiniowanie kompletnej, produkcyjnej architektury umożliwiającej:

1. utworzenie jawnego obiektu przewodzącego reprezentującego antenę mikrofalową;
2. zdefiniowanie geometrii przewodników sygnałowych i dróg powrotnych, materiałów, portów oraz wymuszenia prądowego;
3. obliczenie przestrzennego pola magnetycznego anteny w otoczeniu przewodnika, w airboxie obserwacyjnym i na domenach magnetycznych;
4. wykorzystanie tego pola jako czasowo zależnego składnika pola Zeemana w LLG;
5. niezależne udostępnienie pola każdej anteny jako quantity, między innymi w postaci użytkowej odpowiadającej `b_zeeman_antena_1`;
6. obliczenie widma przestrzennego źródła, czyli rozkładu sprzężenia anteny względem wektora falowego $\mathbf{k}$;
7. rozróżnienie widma samego źródła, odpowiedzi propagujących fal spinowych $S(\mathbf{k},\omega)$ i sprzężenia ze stojącymi modami własnymi;
8. zapewnienie zgodności FEM/FDM, CPU/GPU, trybu interaktywnego, eksportu i wizualizacji;
9. uzyskanie jednoznacznej proweniencji, wersjonowania, cache’owania i fail-closed capability routing.

Raport Pro powstał przez statyczną inspekcję bazowego commitu. Podczas scalenia
ponownie sprawdzono bieżące symbole oraz wykonano skupione testy opisane w
sekcji 30. Nie uruchamiano publikacyjnej kwalifikacji natywnego FEM/MFEM ani
eksperymentów numerycznych. Wnioski oznaczone jako „nie znaleziono ścieżki
wykonawczej” pozostają ustaleniami statycznymi wymagającymi testu end-to-end.
Przejście pojedynczego statusu CI lub testu strukturalnego nie stanowi
kwalifikacji fizyki ani solvera antenowego.

---

## 1. Werdykt wykonawczy

### 1.1. Werdykt ogólny

**Aktualny moduł nie jest produkcyjnie gotowym solverem fizycznej anteny mikrofalowej.**

Repozytorium zawiera kilka wartościowych, ale częściowo rozłącznych elementów:

- kontrakty IR i Python API dla prostych obiektów `MicrostripAntenna` i `CPWAntenna`;
- eksperymentalny kernel pola nieskończonych, prostokątnych przewodników o jednorodnym prądzie;
- działającą w referencyjnym FEM superpozycję pola antenowego z polem efektywnym LLG;
- dojrzalszy, odrębny mechanizm zadanych regionalnych pól Zeemana;
- katalog quantity zawierający zagregowane `H_ant`;
- ogólną warstwę API i wizualizacji pól przestrzennych;
- istniejącą infrastrukturę analizy czasowo-przestrzennej fal spinowych i artefaktu `dynamic_structure_factor.1d.v1`;
- dobre koncepcyjnie dokumenty projektowe ADR i fizyczne, które opisują docelowy przepływ „field solve → basis artifact → LLG”, lecz nie zostały jeszcze zrealizowane w kodzie wykonawczym.

Obecny model nazwany `mqs_2p5d_az` **nie rozwiązuje równania magnetoquasistatycznego dla potencjału wektorowego**. Jest to bezpośrednie sumowanie przybliżonych wkładów Biota–Savarta od punktowych próbek przekroju przewodnika, przy założeniu nieskończonego przewodnika wzdłuż globalnej osi $y$. Nazwa solvera, etykiety UI i parametry sugerują wyższą wierność fizyczną niż rzeczywiście zapewnia kod.

### 1.2. Co jest dziś rzeczywiście użyteczne

Za użyteczne i warte zachowania należy uznać:

1. **Separowalną bazę pola per jednostka prądu**  
   Idea
   ```{math}
:label: eq-antenna-time-field

\mathbf H_{\mathrm{ant}}(\mathbf r,t)
   =
   \sum_p I_p(t)\,\mathbf H_{p,1\mathrm A}(\mathbf r)
```
   jest poprawnym fundamentem dla liniowych modeli DC/MQS, o ile rozkład prądu nie zależy od amplitudy i — dla bazy statycznej — od częstotliwości.

2. **Typed Python API i IR dla źródeł**  
   Obecne typy są dobrą podstawą migracji, lecz wymagają rozdzielenia fizycznego przewodnika od zadanej maski pola.

3. **Referencyjna ścieżka FEM**  
   Referencyjny FEM aktualizuje pole antenowe w czasie i dodaje je do pola efektywnego LLG. Jest to użyteczny oracle dla dalszej kwalifikacji, po naprawie obecnych błędów i jednoznacznym nazwaniu modelu legacy.

4. **RegionalFieldDrive jako odrębny produkt**  
   Zadane pole przestrzenne ograniczone do obiektu/regionu jest przydatne i powinno pozostać. Nie może jednak być przedstawiane użytkownikowi jako fizyczna antena przewodząca.

5. **Warstwa quantity/data plane**  
   Fullmag ma już mechanizmy publikacji pól, zakresów przestrzennych, airboxów, rewizji i wizualizacji. Należy je rozszerzyć o tożsamość źródła i portu, zamiast budować równoległy system.

6. **Infrastruktura finite-$k$**  
   Istniejące próbkowanie FEM P1, przestrzenno-czasowe FFT i dynamic structure factor mogą zostać wykorzystane dla odpowiedzi magnetyzacji. Nie zastępują one jednak analizy widma samego pola antenowego.

7. **Istniejący stos CurrentTransport/Oersted**  
   Repozytorium ma już `CurrentTransport`, `ConservativeCurrentView` RT0,
   `DirectTetraQuadrature`, `VectorPotentialSolver`, `StageOerstedProvider`
   oraz quantities `V_electric`, `J_charge` i `H_oe`. Są to istniejący
   właściciele numeryczni docelowego Tier 1; moduł anteny ma je komponować i
   kwalifikować, nie implementować ponownie. Samo istnienie kodu nie nadaje im
   statusu produkcyjnej ścieżki antenowej.

### 1.3. Blokery krytyczne

Do czasu rozwiązania poniższych problemów modułu nie należy reklamować jako produkcyjnego solvera anten mikrofalowych:

- brak kompletnego charge-only workflow antenowego wiążącego geometrię, port
  mode, istniejący `CurrentTransport`, `ConservativeCurrentView`, Oersted,
  immutable field asset i konsumentów LLG;
- brak jawnej geometrii drogi powrotnej i bilansu portów;
- brak lokalnego układu współrzędnych i dowolnej rotacji anteny;
- brak zweryfikowanej iniekcji fizycznego pola `mqs_2p5d_az` do natywnego FEM CPU/GPU;
- błąd indeksowania baz pola przy mieszanych `current_modules`;
- sprzeczna konwencja kierunku prądu i znaku pola;
- brak obsługi geometrycznego `mqs_2p5d_az` ani solved 3D basis w FDM;
  istniejąca ścieżka FDM CPU dotyczy wyłącznie zadanych masek pola;
- brak kwalifikacji lub ścieżki CUDA dla masek antenowych;
- brak quantity per źródło i per port;
- brak wykonywalnego artefaktu `antenna_field_solution.v1`;
- brak wykonywalnej analizy `source_k_profile`;
- brak rozdzielenia widma źródła od odpowiedzi magnetyzacji;
- brak testów analitycznych, zbieżnościowych i parity obejmujących cały przepływ.

Repozytorium posiada referencyjne komponenty przewodnictwa i pola Oersteda.
Nie są one jednak automatycznie produktem antenowym ani dowodem kwalifikacji
runtime. Brak dotyczy orkiestracji, normalizacji portowej, lifecycle artefaktu,
projekcji i konsumentów, a nie braku wszystkich operatorów numerycznych.

### 1.4. Polityka wydania rekomendowana od razu

Do czasu wdrożenia produkcyjnej architektury:

- dotychczasowy kernel należy przemianować w proweniencji na  
  `legacy_infinite_uniform_strip_biot_savart.v0`;
- UI nie może nazywać go „2.5D MQS (Az)”;
- nieobsługiwane backendy muszą kończyć planowanie czytelnym błędem, a nie pomijać pole;
- quantity `H_ant` powinno być aktywne wyłącznie wtedy, gdy istnieje rzeczywiście materializowane pole antenowe;
- wszystkie stare wyniki muszą zachować wersję formuły i konwencję znaku;
- implementację produkcyjną należy prowadzić przez jawny etap rozwiązania pola i wersjonowany artefakt, zgodnie z architekturą opisaną dalej.

---

## 2. Terminologia normatywna

Obecny kod i UI mieszają trzy różne pojęcia. Ich rozdzielenie jest warunkiem poprawności architektury.

### 2.1. Fizyczna antena przewodząca

**Microwave conductor source / antenna conductor** to obiekt fizyczny zawierający:

- geometrię przewodnika lub zespołu przewodników;
- przewodnik sygnałowy;
- jedną lub więcej jawnych dróg powrotnych;
- materiał elektryczny $\sigma,\mu,\varepsilon$;
- porty i terminale;
- lokalny prawoskrętny układ $(\mathbf e_u,\mathbf e_v,\mathbf e_w)$;
- model elektromagnetyczny;
- warunki brzegowe i kryteria ważności modelu.

Wynikiem nie jest bezpośrednio waveform LLG, lecz **baza pola elektromagnetycznego** lub zestaw baz per port.

### 2.2. Zadane pole Zeemana

**Regional field drive** to pole narzucone przez użytkownika w postaci analitycznej lub maskowanej geometrycznie, bez modelowania przewodnika i przepływu prądu:

```{math}
:label: eq-merged-002

\mathbf H_{\mathrm{drive}}(\mathbf r,t)
=
a(t)\,\mathbf h(\mathbf r).
```

Może ono emulować antenę, lecz nie jest rozwiązaniem pola anteny. Jest użyteczne do testów, wymuszania sinc/Gaussian plane wave, selekcji modów i szybkich eksperymentów.

### 2.3. Rozwiązanie pola anteny

**Antenna field solution** to wersjonowany artefakt zawierający:

- rozwiązanie prądu lub pola elektromagnetycznego;
- pola bazowe per port i częstotliwość;
- domenę próbkowania;
- projekcje na domeny magnetyczne;
- diagnostykę solvera;
- podpisy zależności i proweniencję.

Artefakt jest niezależny od amplitudy waveformu dla liniowej bazy 1 A.

### 2.4. Widmo źródła

**Source $k$-spectrum** opisuje przestrzenną zawartość pola wymuszającego:

```{math}
:label: eq-merged-003

\widetilde{\mathbf h}_{\perp}(\mathbf k)
=
\int_{\Omega_a}
w(\mathbf r)\,
\mathbf h_{\perp}(\mathbf r)
e^{-i\mathbf k\cdot\mathbf r}
\,d\mathbf r.
```

Jest to własność anteny, geometrii, portów, faz i wybranego obszaru analizy. Nie jest to jeszcze odpowiedź materiału magnetycznego.

### 2.5. Odpowiedź fal spinowych

**Dynamic structure factor / driven response** opisuje magnetyzację:

```{math}
:label: eq-merged-004

\widetilde{\mathbf m}(\mathbf k,\omega)
=
\boldsymbol{\chi}(\mathbf k,\omega)
\widetilde{\mathbf h}_{\perp}(\mathbf k,\omega)
```

w ośrodku translacyjnie niezmienniczym lub odpowiedni uogólniony operator odpowiedzi w strukturze skończonej.

### 2.6. Sprzężenie ze stojącym modem

Dla obiektu skończonego wektor falowy może nie być dobrą liczbą kwantową. Wtedy podstawową miarą jest overlap pola z modem własnym, najlepiej z użyciem lewego i prawego wektora własnego zlinearyzowanego, niehermitowskiego operatora LLG.

### 2.7. $H$, $B$ i quantity użytkowe

Rdzeń solvera powinien przechowywać pole antenowe jako:

```{math}
:label: eq-merged-005

\mathbf H_{\mathrm{ant}}\quad [\mathrm{A/m}].
```

W nieferromagnetycznym tle można definiować quantity pochodne:

```{math}
:label: eq-merged-006

\mathbf B_{\mathrm{Zeeman,ant}}
=
\mu_0\mathbf H_{\mathrm{ant}}
\quad [\mathrm T].
```

Nie należy nazywać tego „całkowitym $\mathbf B$ w materiale”, ponieważ:

```{math}
:label: eq-merged-007

\mathbf B=\mu_0(\mathbf H+\mathbf M)
```

dla prostego ośrodka magnetycznego. Użytkowe `b_zeeman_antena_1` powinno być jawną transformacją $\mu_0H$, nie drugim niezależnym polem przechowywanym w solverze.

---

## 3. Oczekiwany przepływ użytkownika

Docelowy workflow powinien być jawny i reprodukowalny:

1. **Utwórz źródło mikrofalowe**  
   Użytkownik dodaje obiekt `MicrowaveConductorSource`.

2. **Zdefiniuj geometrię**  
   Wybiera microstrip/stripline/CPW lub dowolną geometrię przewodzącą, jej transformację i lokalny układ współrzędnych.

3. **Zdefiniuj materiał i porty**  
   Ustawia przewodność, grubość, przewodnik sygnałowy, zwroty prądu i jawne terminale. Suma prądów portowych musi wynosić zero dla zamkniętego układu.

4. **Wybierz poziom wierności**  
   - legacy analityczny — wyłącznie do testów;
   - Tier 1: 3D DC conduction + Biot–Savart;
   - Tier 2: harmonic MQS $A$-$\phi$;
   - Tier 3: full-wave, później.

5. **Zdefiniuj domenę pola**  
   Użytkownik wybiera:
   - airbox obserwacyjny;
   - regularną siatkę pola;
   - węzły/komórki obiektu magnetycznego;
   - region;
   - przekrój lub płaszczyznę.

6. **Uruchom jawny etap `Solve antenna field`**  
   Powstaje immutable artifact z diagnostyką. Żaden panel FFT ani viewport nie powinien uruchamiać kosztownego solvera w sposób ukryty.

7. **Wizualizuj pole**  
   Dostępne są:
   - baza 1 A per port;
   - chwilowe pole per źródło;
   - całkowite pole wszystkich źródeł;
   - $H_x,H_y,H_z,|H|$;
   - $\mu_0H$ w T/mT;
   - część rzeczywista, urojona, amplituda i faza dla pól harmonicznych;
   - pole w airboxie i jego projekcja na magnes.

8. **Zdefiniuj waveform**  
   Prąd może być stały, sinusoidalny, impulsowy, chirp, tablicowy lub składany. Waveform nie zmienia statycznej bazy pola.

9. **Uruchom LLG**  
   Backend wykorzystuje tę samą bazę i tę samą semantykę czasu dla FEM/FDM i CPU/GPU.

10. **Analizuj źródło**  
    Podwęzeł anteny generuje 1D/2D/3D $k$-spectrum pola, jego część poprzeczną i polaryzacje kołowe.

11. **Analizuj sprzężenie**  
    Możliwe jest:
    - przecięcie widma anteny z dyspersją;
    - overlap z modami własnymi;
    - odpowiedź $S(\mathbf k,\omega)$;
    - moc absorbowana i efektywność transdukcji.

12. **Zmieniaj parametry bez zbędnych przeliczeń**  
    Cache i podpisy zależności określają, czy trzeba przeliczyć prąd, pole, projekcję, widmo czy tylko waveform.

---

(implementation-mapping)=
## 4. Mapa aktualnej implementacji

### 4.1. Python API

Główne typy znajdują się w:

- `packages/fullmag-py/src/fullmag/model/antenna.py`;
- `packages/fullmag-py/src/fullmag/world.py`;
- `packages/fullmag-py/src/fullmag/model/problem.py`.

Obecne API zawiera:

- `MicrostripAntenna`;
- `CPWAntenna`;
- `RfDrive`;
- `AntennaFieldSource`;
- `SpinWaveExcitationAnalysis`;
- nowszy `RegionalFieldDrive`;
- profile `UniformFieldProfile`, `SincFieldProfile`, `GaussianPlaneWaveFieldProfile`, `GeometryMaskFieldProfile`;
- targety global/object/region;
- aktywację per stage i semantykę czasu.

### Ocena

Typed API jest użyteczne, ale model `AntennaFieldSource` łączy dwa semantycznie różne przypadki:

- `model="mqs_2p5d_az"` — deklarowany przewodnik;
- `model="prescribed_zeeman_mask"` — zadane pole.

Dodatkowo `SpinWaveExcitationAnalysis(method="source_k_profile")` jest serializowalnym kontraktem, lecz statyczny audyt nie wykazał wykonywalnej ścieżki runnera materializującej odpowiadający mu artefakt.

#### Wyczerpujący ledger zgodności publicznego API

Tabela opisuje stan istniejący. Nie należy mylić jej z docelowym API z sekcji 26.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `AntennaFieldSource.model` | `str` | `mqs_2p5d_az` | $1$ | jeden z `mqs_2p5d_az`, `prescribed_zeeman_mask` | wybór modelu kompatybilności źródła antenowego | ograniczony FDM CPU reference; pozostałe lane'y unsupported albo niekwalifikowane | `current_modules[].model` |
| `RfDrive.current_a` | `float` | required | $\mathrm{A}$ | wartość skończona; dalsze ograniczenia modelu przy planning | amplituda prądu mnożąca kompatybilne pole przestrzenne | wyłącznie ścieżka kompatybilności | `current_modules[].drive.current_a` |
| `RegionalFieldDrive.amplitude_B_T` | `float` | required | $\mathrm{T}$ | wartość skończona i nieujemna | szczytowa amplituda indukcji idealizowanego regional drive | FDM CPU reference executable; pozostałe lane'y wymagają osobnej kwalifikacji | `field_drives[].amplitude_B_T` |
| `SpinWaveExcitationAnalysis.method` | `str` | `source_k_profile` | $1$ | obecnie dokładnie `source_k_profile` | żądanie analizy wektora falowego pola źródła | semantic-only we wszystkich lane'ach | `excitation_analysis.method` |

Jawne mapowanie Python → ProblemIR jest następujące:

- `AntennaFieldSource.model` → `current_modules[].model`;
- `RfDrive.current_a` → `current_modules[].drive.current_a`;
- `RegionalFieldDrive.amplitude_B_T` → `field_drives[].amplitude_B_T`;
- `SpinWaveExcitationAnalysis.method` → `excitation_analysis.method`.

### 4.2. Intermediate Representation

Najważniejsze definicje znajdują się w:

- `crates/fullmag-ir/src/study.rs`;
- `crates/fullmag-ir/src/plan.rs`;
- `crates/fullmag-ir/src/validation.rs`;
- `crates/fullmag-ir/src/physics_object.rs`.

Istnieją:

- `RfDriveIR`;
- `AntennaFieldSourceModelIR`;
- `AntennaIR::{Microstrip,Cpw}`;
- `CurrentModuleIR::AntennaFieldSource`;
- `AntennaFieldIR`;
- `AntennaSpatialProfileIR`;
- `RegionalFieldDriveIR`;
- targety, profile i aktywacje.

### Brakujące elementy kontraktu fizycznej anteny

Nie ma kompletnego, wykonywalnego kontraktu obejmującego:

- stabilny UUID źródła;
- stabilny UUID portu;
- terminale i powierzchnie terminalowe;
- jawną drogę powrotną dla „microstrip”;
- lokalny układ i transformację źródła;
- dowolny kierunek prądu;
- przewodność, przenikalność i przenikalność elektryczną materiału;
- wieloportowe wektory wymuszeń;
- częstotliwości rozwiązania pola;
- model zasilania: prąd, napięcie, moc, fala padająca;
- wersję realizacji solvera;
- referencję do artefaktu pola;
- podpisy cache;
- domeny próbkowania;
- jawne projekcje na targety;
- zespolone pola i fazę;
- proweniencję uproszczeń.

### 4.3. Planner maski zadanej

Plik:

- `crates/fullmag-plan/src/antenna_zeeman.rs`.

Planner rozwiązuje przypadek `PrescribedZeemanMask`, nie fizyczny przewodnik. Przelicza amplitudę $B$ na $H$:

```{math}
:label: eq-merged-008

H_0=\frac{B_0}{\mu_0},
```

następnie próbkuje profil na węzłach/komórkach i ogranicza go geometrią.

### Ograniczenia

- obsługa geometrii jest ograniczona do niewielkiego podzbioru prymitywów i operacji;
- nie jest to rozwiązanie pola w wolnej przestrzeni;
- maska działa na punktach aktywnej domeny magnetycznej;
- nie tworzy niezależnego airboxu pola;
- translacja pola poza target jest po prostu przycinana maską;
- model nie zna prądu, przewodnika, portów ani równania Maxwella.

Jest to poprawny mechanizm dla `RegionalFieldDrive`, lecz nie może być traktowany jako field solver anteny.

### 4.4. Legacy kernel pola przewodnika

Plik:

- `crates/fullmag-runner/src/antenna_fields.rs`.

Główne funkcje:

- `compute_per_unit_antenna_fields`;
- `combined_antenna_field_at_time`;
- `compute_antenna_field`;
- `add_rectangular_conductor`.

Kernel:

- zakłada przewodnik nieskończony wzdłuż globalnej osi $y$;
- dyskretyzuje jego przekrój $x$-$z$;
- przypisuje każdej próbce część całkowitego prądu;
- sumuje pole nieskończonego przewodnika liniowego;
- obsługuje jeden pasek albo symetryczny CPW;
- dla CPW przypisuje przewodnikowi centralnemu $+I$, a każdej masie $-I/2$;
- generuje wyłącznie składowe $H_x,H_z$;
- nie rozwiązuje PDE;
- nie używa finite length do pola;
- nie używa `center_y`;
- nie używa jawnego lokalnego układu;
- nie modeluje przewodności ani częstotliwościowej redystrybucji prądu;
- nie materializuje artefaktu rozwiązania.

### 4.5. FEM referencyjny

Plik główny:

- `crates/fullmag-runner/src/fem_reference.rs`.

Referencyjny FEM:

- oblicza bazę pola legacy;
- składa pole z waveformem;
- umieszcza je w `EffectiveFieldTerms.per_node_field`;
- aktualizuje pole w czasie;
- udostępnia `StateObservables.antenna_field`.

To jest obecnie najpełniejsza wykonywalna ścieżka fizycznego źródła z `CurrentModuleIR::AntennaFieldSource`, ale pozostaje eksperymentalna ze względu na błędy i uproszczenia opisane w rejestrze ustaleń.

### 4.6. Natywny FEM CPU/GPU

Istotne pliki:

- `crates/fullmag-runner/src/fem/execution.rs`;
- `crates/fullmag-runner/src/native_fem.rs`;
- `crates/fullmag-runner/src/interactive_runtime/fem/mod.rs`;
- `crates/fullmag-runner/src/interactive_runtime/fem/gpu.rs`;
- `native/include/fullmag_fem.h`;
- `backends/fem/...`.

Natywny FEM posiada produkcyjny kontrakt `field_drives` i quantity `H_drive`. Statyczny audyt nie wykazał analogicznego ABI ani natywnej obserwabli dla geometrycznego `mqs_2p5d_az`.

W trybie interaktywnym Rust oblicza pole antenowe i może utrzymywać je jako nośnik podglądu `H_ant`, lecz nie znaleziono kompletnej ścieżki dowodzącej, że ta sama tablica jest wprowadzana do prawej strony natywnego LLG na każdym stadium Rungego–Kutty.

**Wniosek:** fizyczne pole legacy należy traktować w natywnym FEM jako
niezakwalifikowane. Istnienie obliczenia i przekazania tablicy po stronie Rust
nie jest dowodem konsumpcji przez natywny operator LLG; status może zmienić
wyłącznie test różnicowy trajektorii i receipt właściwego runtime.

### 4.7. FDM CPU

Istotne pliki:

- `crates/fullmag-plan/src/fdm.rs`;
- `crates/fullmag-runner/src/fdm/cpu/reference.rs`;
- `crates/fullmag-runner/src/antenna_fields.rs`.

Referencyjny FDM CPU obsługuje rozstrzygnięte maski zadanych pól antenowych/regionalnych. Statyczny audyt nie wykazał wykonania geometrycznego źródła `mqs_2p5d_az` dla FDM.

### 4.8. FDM CUDA i multilayer

Istotne pliki:

- `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`;
- ścieżki planowania i quantity FDM multilayer.

Nie znaleziono:

- transportu geometrycznej bazy anteny do CUDA;
- kompletnej ścieżki maski `H_ant` w natywnym CUDA;
- obserwabli `H_ant` w natywnym snapshot ABI;
- wsparcia `H_ant` w FDM multilayer.

Każdy z tych przypadków powinien być obecnie fail-closed.

### 4.9. Quantity i API

Istotne pliki:

- `crates/fullmag-quantities/src/catalog.rs`;
- `crates/fullmag-quantities/src/id.rs`;
- `crates/fullmag-runner/src/quantities.rs`;
- `crates/fullmag-runner/src/preview.rs`;
- `crates/fullmag-runner/src/fem_reference/outputs.rs`;
- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`;
- `apps/control-room/src/kernel/api/quantityIds.ts`.

Istnieje statyczne quantity:

- ID: `H_ant`;
- typ: wektor;
- jednostka: A/m;
- domena: full;
- możliwości: interaktywny podgląd, cache, eksport, 2D/3D.

Nie istnieją:

- `H_ant` per źródło;
- `H_ant` per port;
- baza 1 A;
- jawna pochodna $\mu_0H_{\mathrm{ant}}$;
- pola zespolone;
- faza;
- źródłowa proweniencja;
- dynamiczny selector source/port.

Warstwa API pól jest dostatecznie ogólna, by takie rozszerzenie obsłużyć.

### 4.10. Frontend

### Aktualny control room

Istotne pliki:

- `apps/control-room/src/modules/inspector/panels/AntennaObjectPanelModel.ts`;
- `apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.tsx`;
- `apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts`.

Panel nazywany „Antenna” edytuje w praktyce `RegionalFieldDrive` oparty o maskę geometrii i zadane $B$. Nie edytuje:

- portów;
- przewodników;
- materiałów;
- rozwiązania prądu;
- solvera pola;
- częstotliwościowego pola zespolonego;
- artefaktu field solve;
- widma $k$.

W drzewie nie ma wymaganych podwęzłów solvera i analiz.

### Legacy web

Istotny plik:

- `apps/legacy_web/components/panels/settings/AntennaPanel.tsx`.

Stary panel potrafi utworzyć Microstrip/CPW, ustawić prąd i poprosić o `H_ant`. Jednocześnie wyświetla etykiety „2.5D MQS (az)” i „current axis +Y”, które nie odpowiadają dokładnie implementacji.

### 4.11. Analiza fal spinowych

Istotne pliki:

- `crates/fullmag-runner/src/spin_wave_sampling.rs`;
- `crates/fullmag-api/src/router_v2/handlers/analysis/spin_wave_response.rs`;
- `apps/control-room/src/modules/analysis-plots/SpinWaveGammaView.tsx`.

Repozytorium zawiera:

- próbkowanie FEM P1 na regularnym przekroju;
- 1D FFT w przestrzeni;
- FFT w czasie;
- artefakt `dynamic_structure_factor.1d.v1`;
- osie $k$ i $f$;
- okna Hann;
- zespolone widma;
- źródłowy ślad `H_drive`;
- test odzyskiwania znanego $k$ i $f$.

Obecny mechanizm:

- dotyczy odpowiedzi magnetyzacji;
- działa dla FEM;
- jest ograniczony do kierunku $x$;
- wymaga aktywnego `field_drive`;
- używa zagregowanego `H_drive`, nie per antena;
- nie oblicza źródłowego widma fizycznego `H_ant`;
- nie wykonuje projekcji na pole poprzeczne względem $\mathbf m_0$;
- nie rozdziela polaryzacji kołowych;
- nie oblicza overlapów z modami;
- nie odpowiada samodzielnie na pytanie „jakie $\mathbf k$ antena może wzbudzić”.

### 4.12. Dokumentacja projektowa

Najważniejsze dokumenty:

- `docs/adr/0017-staged-antenna-field-basis-workflow.md`;
- `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`;
- `docs/plans/active/fullmag_fem_microwave_antenna_plan.md`;
- dokumenty `docs/superpowers/specs/...` i `docs/superpowers/plans/...`.

ADR 0017 i dokument fizyczny 0950 zawierają trafny kierunek: jawny etap field solve, baza 1 A, oddzielny artefakt, projekcje targetowe, per-source quantities i $k$-selective analysis. Wyszukiwanie symboli takich jak `AntennaFieldSolve`, `SolvedAntennaDrive` i `antenna_field_solution.v1` wykazało ich obecność przede wszystkim w dokumentacji, nie w kodzie wykonawczym.

Historyczny plan FEM jest oznaczony jako superseded, ale nadal znajduje się w katalogu `active`. Dodatkowo jego równania dla $\mathbf A=(0,A_y,0)$ mają przeciwny znak względem standardowego operatora rotacji. Dokument ten nie może być normatywną podstawą implementacji.

---

## 5. Macierz aktualnych możliwości

Legenda:

- **TAK** — istnieje wykonywalna i względnie spójna ścieżka;
- **CZĘŚCIOWO** — istnieje tylko fragment lub jedna ścieżka referencyjna;
- **DEKLARACJA** — kontrakt/UI/dokument, ale brak potwierdzonego wykonania;
- **NIE** — brak;
- **NIEZAKWALIFIKOWANE** — statycznie możliwe fragmenty, ale brak testu dowodzącego poprawność.

| Funkcja | Stan | Rzeczywista ścieżka | Ocena |
|---|---:|---|---|
| Zadane regionalne pole Zeemana | TAK | RegionalFieldDrive / maski | zachować jako osobny produkt |
| Fizyczny microstrip/CPW w API | CZĘŚCIOWO | Python + IR + legacy UI | model niekompletny |
| Jawne porty i zwroty prądu | NIE | — | blocker fizyczny |
| Dowolna transformacja/rotacja anteny | NIE | — | kernel global $+/-y$ |
| Skończona długość i efekty końcowe | NIE | preview only | `preview_length` nie zmienia pola |
| Charge transport $V\rightarrow\mathbf J$ | CZĘŚCIOWO | `CurrentTransport` | implementacja zależna od lane'u; nie jest jeszcze workflow antenowym |
| Conservative RT0 current view | CZĘŚCIOWO | `ConservativeCurrentView` | referencyjna infrastruktura FEM z certyfikatami |
| Direct Oersted z RT0 | CZĘŚCIOWO | `DirectTetraQuadrature` | ograniczony CPU-double oracle, nie production qualification |
| Vector-potential Oersted z RT0 | CZĘŚCIOWO | `VectorPotentialSolver` | bounded reference realization, nie harmoniczne $A-\phi$ |
| Charge-only antenna composition | NIE | planner wymaga obecnie solved-current powiązanego ze spin transportem | blocker orkiestracji |
| Port-mode basis per $1\,\mathrm A$ | NIE | — | brak produktu antenowego |
| `antenna_field_solution.v1` | NIE | — | brak immutable lifecycle i manifestu |
| Kwalifikowany consumer solved basis | NIEZAKWALIFIKOWANE | fragmenty FEM/reference | wymaga testów lane-specific |
| Skin/proximity effect | NIE | — | uniform current |
| Harmoniczne zespolone pole MQS | NIE | — | brak $A-\phi$ |
| Legacy pole nieskończonego paska | TAK | FEM reference | eksperymentalne |
| Airbox rozwiązania antenowego | DEKLARACJA | parametr/API | brak własnego solve |
| Pole per źródło | NIE | — | tylko agregat |
| Pole per port | NIE | — | brak portów |
| `H_ant` agregat | CZĘŚCIOWO | quantity + wybrane runtime | semantyka backendowa nierówna |
| $\mu_0H_{\rm ant}$ jako display quantity | NIE | — | łatwa pochodna |
| Wpływ anteny na FEM reference LLG | TAK | `per_node_field` | po naprawie legacy |
| Wpływ fizycznej anteny na native FEM | NIEZAKWALIFIKOWANE | nie znaleziono kompletnej ścieżki | krytyczny test |
| Wpływ maski na FDM CPU | TAK | reference CPU | ograniczony zakres |
| Wpływ anteny/maski na FDM CUDA | NIEZAKWALIFIKOWANE | brak jawnego transportu | fail-closed |
| FDM multilayer | NIE | quantity unsupported | wymaga projekcji per layer |
| Waveform czasowy | CZĘŚCIOWO | FEM reference / field drives | różna implementacja |
| Cache rozwiązania pola | NIE | — | potrzebny artefakt |
| Widmo źródła $H_{\rm ant}(k)$ | DEKLARACJA | Python/docs | brak runner artifact |
| Odpowiedź $S_m(k,\omega)$ | CZĘŚCIOWO | FEM 1D | istniejąca baza do rozbudowy |
| 2D/3D $k$-spectrum | NIE | — | planowane |
| Projekcja poprzeczna do $\mathbf m_0$ | NIE | — | konieczna fizycznie |
| Polaryzacja kołowa | NIE | — | konieczna dla chiralności |
| Overlap z modami własnymi | NIE | — | konieczny dla fal stojących |
| Wieloportowa interferencja fazowa | NIE | — | konieczna dla phased arrays |
| Testy analityczne pola | NIE | — | blocker kwalifikacji |
| Testy parity FEM/FDM CPU/GPU | NIE | — | blocker wydania |


---

## 6. Rejestr ustaleń audytowych

### 6.1. Skala ważności

- **CRITICAL** — błąd może powodować uruchomienie symulacji bez deklarowanego oddziaływania, błędną fizykę lub niemożność zaufania wynikom.
- **HIGH** — istotna luka fizyczna, numeryczna lub kontraktowa blokująca produkcyjne użycie.
- **MEDIUM** — ograniczenie jakości, skalowalności, UX albo utrzymania, które nie zawsze fałszuje wynik.
- **LOW** — niespójność terminologii, dokumentacji lub ergonomii.

### 6.2. Tabela ustaleń

| ID | Ważność | Ustalenie | Główny skutek |
|---|---|---|---|
| ANT-CRIT-001 | CRITICAL | brak potwierdzonej iniekcji geometrycznego `mqs_2p5d_az` do natywnego FEM LLG | symulacja może pokazywać pole, ale go nie odczuwać |
| ANT-CRIT-002 | CRITICAL | błędne wiązanie `current_modules` z `per_unit_fields` przez `zip` | pole anteny może zostać pominięte lub przypisane do złego modułu |
| ANT-HIGH-001 | HIGH | `mqs_2p5d_az` nie jest solverem MQS ani $A_z$ | zawyżona deklaracja wierności |
| ANT-HIGH-002 | HIGH | sprzeczna konwencja kierunku prądu i znaku Biota–Savarta | odwrócone pole, faza $\pi$, błędna chiralność |
| ANT-HIGH-003 | HIGH | `preview_length`, `center_y` i antenowy `air_box_factor` nie wpływają na kernel pola | parametry UI są pozornie fizyczne |
| ANT-HIGH-004 | HIGH | źródło jest przywiązane do globalnej osi i bounding boxu magnesu | brak dowolnego pozycjonowania i rotacji |
| ANT-HIGH-005 | HIGH | brak jawnych portów, terminali i drogi powrotnej | naruszenie ciągłości prądu i nieokreślone pole dalekie |
| ANT-HIGH-006 | HIGH | tylko zagregowane `H_ant`, brak source/port identity | brak audytowalności, FFT per antena i poprawnego UI |
| ANT-HIGH-007 | HIGH | fizyczny przewodnik i prescribed field są mieszane w API/UI | niejednoznaczny produkt i capability routing |
| ANT-HIGH-008 | HIGH | `source_k_profile` jest kontraktem bez potwierdzonego wykonania | użytkownik nie dostaje deklarowanej analizy |
| ANT-HIGH-009 | HIGH | FDM CUDA/multilayer nie mają zakwalifikowanej anteny | ryzyko cichego braku wymuszenia |
| ANT-HIGH-010 | HIGH | singular-aware CPU-double direct oracle istnieje, lecz legacy kernel i produkt antenowy nie mają wspólnej kwalifikacji błędu/zbieżności | obecność oracle nie kontroluje jeszcze błędu wykonywalnego workflow antenowego |
| ANT-HIGH-011 | HIGH | „microstrip” nie zawiera jawnej płaszczyzny powrotnej | obiekt nie jest fizycznym microstripem |
| ANT-HIGH-012 | HIGH | brak wersjonowanej proweniencji realizacji formuły | stare i nowe wyniki mogą być nierozróżnialne |
| ANT-HIGH-013 | HIGH | solved-current Oersted wymaga obecnie powiązanego `SpinDriftDiffusion` | brak naturalnego charge-only workflow metalicznej anteny |
| ANT-HIGH-014 | HIGH | równoległy stos antenowy powieliłby istniejące `CurrentTransport`/RT0/Oersted | rozjazd znaków, jednostek, tolerancji i kwalifikacji |
| ANT-MED-001 | MEDIUM | twardo zakodowana, niskiego rzędu kwadratura przekroju | brak kontrolowanego błędu |
| ANT-MED-002 | MEDIUM | zbyt szeroka aktywacja quantity `H_ant` | fałszywie dostępne quantity |
| ANT-MED-003 | MEDIUM | ograniczony zestaw geometrii maski | słaba zgodność z dowolnymi obiektami/regionami |
| ANT-MED-004 | MEDIUM | brak testów analitycznych i regression fixtures | brak kwalifikacji |
| ANT-MED-005 | MEDIUM | brak pól zespolonych i zależności od częstotliwości | brak skin/proximity i fazy |
| ANT-MED-006 | MEDIUM | brak efektów końcowych, taperów i feedów | błędne widmo $k$ dla realnej anteny |
| ANT-MED-007 | MEDIUM | hard-coded podział zwrotu CPW $-I/2,-I/2$ | brak niesymetrii i rzeczywistych impedancji |
| ANT-MED-008 | MEDIUM | brak artefaktu, cache i staleness graph | zbędne obliczenia i brak reprodukowalności |
| ANT-MED-009 | MEDIUM | brak jawnej semantyki pola na airboxie vs target LLG | pomieszanie domen obserwacji i oddziaływania |
| ANT-MED-010 | MEDIUM | brak polityki PBC dla lokalnej anteny | niejednoznaczna replikacja źródła |
| ANT-LOW-001 | LOW | drift dokumentacji i etykiet UI | utrata zaufania użytkownika |
| ANT-LOW-002 | LOW | historyczny plan „superseded” w katalogu `active` | niejasne źródło prawdy |

---

### 6.3. ANT-CRIT-001 — brak potwierdzonego oddziaływania w natywnym FEM

### Dowód statyczny

Referencyjny FEM jawnie:

1. oblicza bazy antenowe;
2. składa pole w czasie;
3. umieszcza je w `EffectiveFieldTerms.per_node_field`;
4. odświeża podczas integracji.

W natywnym FEM istnieje natomiast osobny, produkcyjny kontrakt dla `field_drives` i obserwabli `H_drive`. Nie znaleziono:

- odpowiednika `H_ant` w natywnym observable enum;
- deskryptora ABI przenoszącego geometryczną bazę anteny;
- natywnego stage callbacku dla waveformu antenowego;
- pakowania `CurrentModuleIR::AntennaFieldSource::Mqs2p5dAz` do natywnej prawej strony LLG.

Tryb interaktywny przechowuje obliczone po stronie Rust pole do preview. Sama możliwość pokazania `H_ant` nie dowodzi, że operator LLG z niego korzysta.

### Ryzyko

Najgroźniejszy scenariusz to:

- użytkownik widzi we viewportcie prawidłopodobne pole;
- uruchamia natywny FEM CPU/GPU;
- magnetyzacja ewoluuje tak, jakby anteny nie było.

Taki błąd jest trudny do zauważenia, jeżeli istnieją inne pola, szum lub mała amplituda wzbudzenia.

### Wymagana naprawa

Do czasu kompletnej implementacji:

- planner musi odrzucać fizyczne źródło antenowe dla native FEM;
- dopuszczony może być tylko `RegionalFieldDrive`, jeżeli jego natywna ścieżka jest zakwalifikowana.

Docelowo należy:

- przenieść bazę pola per port do natywnego planu albo do wersjonowanego asset handle;
- przesłać ją raz na urządzenie;
- obliczać współczynniki waveformu na każdym stadium integratora;
- wykonywać na GPU/CPU:
  ```{math}
:label: eq-merged-009

\mathbf H_{\mathrm{ant}}(t_s)
  =
  \sum_p I_p(t_s)\mathbf H_{p,1A};
```
- materializować `H_ant` z `source_ref=<uuid>` oraz `source_ref=sum` i dodać
  test wpływu na RHS.

### Test rozstrzygający

Minimalny test E2E:

- jeden tetraedr/mała siatka;
- $\mathbf m_0=\mathbf e_x$;
- tylko pole anteny wzdłuż $\mathbf e_z$;
- brak exchange, demag, anisotropy;
- porównanie po jednym bardzo małym kroku z analitycznym początkiem precesji;
- osobno FEM reference, native CPU i native GPU;
- test zerowego prądu oraz odwrócenia znaku prądu.

---

### 6.4. ANT-CRIT-002 — błąd indeksowania baz pola

### Mechanizm błędu

`compute_per_unit_antenna_fields()` buduje wektor wyłącznie dla modułów odpowiadających geometrycznym źródłom MQS. Pomija inne warianty `current_modules`.

`combined_antenna_field_at_time()` następnie łączy pełny `plan.current_modules` z krótszym wektorem baz przez `zip`.

To narusza podstawową inwariantę indeksowania.

Ustalenie zostało ponownie potwierdzone na commicie
`0388c3e7c4804923ee02a00b7ac4a789a44092d9`: gałąź
`CurrentModuleIR::CurrentTransport` nadal nie wykonuje `result.push(...)`, po
czym konsument używa `plan.current_modules.iter().zip(per_unit_fields.iter())`.

### Przykład

Dla:

```text
current_modules[0] = CurrentTransport
current_modules[1] = AntennaFieldSource(mqs_2p5d_az)
```

wektor `per_unit_fields` ma jeden element, który należy do modułu 1. `zip` paruje go jednak z modułem 0. W efekcie:

- pole może zostać zignorowane;
- kolejne źródła mogą zostać przesunięte;
- wynik zależy od kolejności niepowiązanych modułów.

### Wymagana naprawa

Zakazane jest poleganie na kolejności filtrowanego wektora. Dopuszczalne rozwiązania:

```rust
struct ResolvedAntennaBasis {
    source_id: SourceId,
    module_index: usize,
    port_id: PortId,
    values: Arc<[Vec3]>,
    unit: AntennaBasisUnit,
    provenance: BasisProvenance,
}
```

albo:

```rust
Vec<Option<ResolvedAntennaBasis>>
```

o długości identycznej z `current_modules`.

Preferowane jest pierwsze rozwiązanie, ponieważ usuwa zależność od pozycji i przygotowuje system na wiele portów.

### Testy

Macierz permutacyjna:

- antenna;
- transport + antenna;
- antenna + transport;
- antenna + prescribed + antenna;
- disabled antenna pomiędzy aktywnymi;
- rename/reorder;
- wiele portów.

Dla każdej permutacji całkowite pole musi być identyczne.

---

### 6.5. ANT-HIGH-001 — fałszywa semantyka `mqs_2p5d_az`

### Stan

Nazwa sugeruje:

- model magnetoquasistatyczny;
- 2.5D;
- rozwiązanie skalarnego potencjału wektorowego $A_z$.

Kod:

- nie składa macierzy PDE;
- nie ma potencjału $\mathbf A$;
- nie ma airboxu obliczeniowego;
- nie ma warunków brzegowych;
- nie ma częstotliwościowej przewodności;
- nie ma pola zespolonego;
- nie ma $A_z$;
- zakłada prąd w osi $y$, więc naturalnym niezerowym składnikiem potencjału byłby $A_y$, nie $A_z$.

### Wymagana naprawa

Natychmiastowa nazwa realizacji:

```text
legacy_infinite_uniform_strip_biot_savart.v0
```

UI:

```text
Legacy infinite-strip Biot–Savart
```

Docelowe nazwy:

```text
conduction_3d_biot_savart.v1
mqs_aphi_3d_harmonic.v1
mqs_au_2p5d_harmonic.v1
fullwave_eh_3d.v1
```

Nazwa realizacji musi jednoznacznie określać:

- równanie;
- wymiarowość;
- harmoniczność;
- zmienne;
- wersję.

---

### 6.6. ANT-HIGH-002 — konwencja znaku pola

Dla dodatniego prądu wzdłuż $+\mathbf e_y$, nieskończonego przewodnika położonego w $(x',z')$, standardowy wynik wynosi:

```{math}
:label: eq-merged-010

\mathbf H(x,z)
=
\frac{I}{2\pi R^2}
\left[
(z-z')\mathbf e_x
-
(x-x')\mathbf e_z
\right],
\qquad
R^2=(x-x')^2+(z-z')^2.
```

Obecny kernel sumuje:

```{math}
:label: eq-merged-011

H_x\propto -(z-z'),
\qquad
H_z\propto +(x-x'),
```

czyli pole odpowiadające prądowi wzdłuż $-\mathbf e_y$.

Jednocześnie legacy UI deklaruje „current axis +Y”.

### Skutek

Odwrócenie pola nie jest wyłącznie kosmetyczne:

- odpowiada zmianie fazy o $\pi$;
- zmienia interferencję wielu źródeł;
- zmienia znak sprzężenia z modami;
- może odwracać preferencję polaryzacji kołowej;
- może zmieniać kierunkową asymetrię wzbudzenia w układach chiralnych.

### Naprawa i kompatybilność

Nie należy po prostu zmienić dwóch znaków bez wersjonowania.

- stare uruchomienia: `legacy_sign_convention.v0`;
- nowe: `right_hand_rule_current_axis.v1`;
- migracja UI powinna wyświetlić ostrzeżenie;
- artefakt musi zapisywać `current_positive_axis` i `field_orientation_convention`.

---

### 6.7. ANT-HIGH-003 — parametry bez wpływu na wynik

### `preview_length`

Wpływa na wizualną długość obiektu, ale legacy pole pozostaje polem nieskończonego przewodnika. Zmiana długości nie zmienia:

- amplitudy pola;
- efektów końcowych;
- widma wzdłuż osi prądu;
- rozkładu prądu.

### `center_y`

W modelu translacyjnie niezmienniczym po $y$ przesunięcie po $y$ jest matematycznie niewykrywalne. Parametr powinien być jawnie oznaczony jako tylko wizualny albo usunięty z realizacji fizycznej.

### `air_box_factor`

W kontraktach istnieje `air_box_factor`, a natywny FEM ma także ogólne pola dotyczące airboxu. Legacy kernel Biota–Savarta nie rozwiązuje jednak problemu brzegowego na airboxie. Wartość ta nie kontroluje dokładności jego pola.

### Polityka

Każdy parametr powinien mieć jedną z etykiet:

- `affects_solution`;
- `affects_sampling`;
- `visual_only`;
- `deprecated_ignored`.

Parametr `deprecated_ignored` musi generować diagnostykę, nie może być cicho przyjmowany.

---

### 6.8. ANT-HIGH-004 — brak lokalnego układu anteny

Obecna geometria jest wyznaczana względem globalnego bounding boxu magnetycznego:

- wysokość względem maksymalnego $z$;
- położenie poprzeczne względem środka;
- kierunek prądu globalnie ustalony.

Nie da się poprawnie zdefiniować:

- anteny obróconej o dowolny kąt;
- anteny na bocznej powierzchni;
- anteny nad jednym z wielu obiektów;
- anteny nachylonej;
- skrzyżowanych anten;
- phased array z różnymi orientacjami.

### Docelowy kontrakt

Każda antena musi posiadać prawoskrętną ramę:

```{math}
:label: eq-merged-012

\mathbf e_u\times\mathbf e_v=\mathbf e_w,
```

gdzie:

- $\mathbf e_u$ — nominalny kierunek prądu/długości;
- $\mathbf e_v$ — kierunek szerokości;
- $\mathbf e_w$ — kierunek grubości/normalna.

Transformacja:

```{math}
:label: eq-merged-013

\mathbf r_{\mathrm{world}}
=
\mathbf t
+
\mathbf R
\mathbf r_{\mathrm{local}},
\qquad
\mathbf R\in SO(3).
```

Walidacja musi sprawdzać ortonormalność, wyznacznik $+1$ i skończoność wartości.

---

### 6.9. ANT-HIGH-005 i ANT-HIGH-011 — brak zamknięcia obwodu

### Problem fizyczny

Prąd nie może kończyć się w izolowanym, skończonym przewodniku:

```{math}
:label: eq-merged-014

\nabla\cdot\mathbf J=0
```

w stanie stacjonarnym, z wyjątkiem jawnych terminali.

Model pojedynczego „microstripu” bez powrotu nie definiuje pełnego obwodu. W realnym microstripie prąd powrotny płynie w płaszczyźnie masy. W CPW płynie w przewodnikach masowych, ale jego podział wynika z pełnego rozwiązania elektromagnetycznego, a nie zawsze dokładnie $-I/2,-I/2$.

### Skutek

Bez drogi powrotnej:

- pole w dużej odległości może mieć nieprawidłowy składnik $1/r$;
- $k=0$ nie jest poprawnie tłumione;
- widmo anteny jest błędne;
- impedancja i straty są nieokreślone;
- nie da się poprawnie modelować taperów i asymetrii.

### Wymaganie kontraktowe

Port wieloterminalowy musi spełniać:

```{math}
:label: eq-merged-015

\sum_q I_q=0.
```

Źródło powinno zawierać co najmniej:

- `signal_terminal`;
- `return_terminals[]`;
- signed current weights;
- terminal face selectors;
- policy dla rozkładu prądu powrotnego.

Dla predefiniowanego CPW można zaoferować symetryczny preset, lecz musi on generować jawne przewodniki i porty.

---

### 6.10. ANT-HIGH-006 — brak pól per źródło

Zagregowane:

```{math}
:label: eq-merged-016

\mathbf H_{\mathrm{ant,total}}
=
\sum_s \mathbf H_{\mathrm{ant},s}
```

jest potrzebne solverowi, lecz niewystarczające do:

- diagnostyki jednej anteny;
- osobnego FFT;
- strojenia faz;
- porównania z pomiarem;
- identyfikacji źródła błędu;
- selektywnego eksportu;
- cache per source;
- budowy overlapów.

### Rekomendacja

Nie należy tworzyć nieograniczonej liczby statycznych ID `H_ant_1`, `H_ant_2`, ponieważ kolejność jest niestabilna.

Canonical quantity:

```text
quantity_id = H_ant
scope_kind  = source
scope_id    = <stable-source-uuid>
```

oraz opcjonalnie:

```text
port_id     = <stable-port-uuid>
realization = basis_1A | instantaneous | phasor
```

UI może wyświetlać alias:

```text
b_zeeman_antena_1
```

ale zasób musi być identyfikowany UUID-em. Rename i reorder nie mogą zmieniać tożsamości.

---

### 6.11. ANT-HIGH-007 — mieszanie anteny i maski pola

Obecny panel control-room nazywa „anteną” obiekt, który w praktyce tworzy geometrycznie maskowany `RegionalFieldDrive`. Legacy panel nazywa anteną prosty przewodnik.

### Skutek

Użytkownik nie wie, czy:

- pole zostało obliczone z prądu;
- pole jest zadane ręcznie;
- airbox ma sens;
- FFT dotyczy przewodnika czy maski;
- zmiana przewodności powinna coś zmienić.

### Docelowy podział UI i IR

```text
Excitations
├── Regional field drives
│   └── prescribed field / geometry mask
└── Microwave conductor sources
    └── physical conductor + ports + field solve
```

Migracja starej maski powinna zachować:

```json
{
  "migration": {
    "migrated_from": "prescribed_zeeman_mask"
  }
}
```

ale nie może automatycznie przekształcać jej w fizyczny przewodnik.

---

### 6.12. ANT-HIGH-008 — niewykonywalna analiza `source_k_profile`

Python API i dokumentacja zawierają pojęcie `SpinWaveExcitationAnalysis(method="source_k_profile")`. Wyszukiwanie implementacji wykazało odwołania w:

- modelach Python;
- world authoring;
- IR/testach kontraktowych;
- dokumentach i macierzy capability.

Nie wykazało odpowiadającego, kompletnego etapu runnera tworzącego artefakt widma pola antenowego.

### Wymagana polityka

Do czasu implementacji:

- nie publikować tej funkcji jako supported;
- oznaczyć capability jako `contract_only`;
- frontend nie powinien oferować aktywnego przycisku „Compute”, jeśli endpoint nie istnieje.

Docelowy stage opisano w rozdziale 13.

---

### 6.13. ANT-HIGH-009 — niezakwalifikowane backendy FDM

### Stan

- FDM CPU reference obsługuje zadane maski.
- Geometryczna antena legacy jest związana z `FemPlanIR`.
- CUDA snapshot nie eksponuje `H_ant`.
- nie znaleziono jednoznacznego transportu maski antenowej do natywnego CUDA;
- multilayer oznacza `H_ant` jako unsupported.

### Wymagana naprawa

Planner musi opierać routing na jawnej macierzy:

```text
feature                     fdm_cpu_ref  fdm_cuda  fdm_multilayer  fem_ref  fem_native_cpu  fem_native_gpu
regional_field_drive        yes          qualified? ...
solved_antenna_field_asset  ...
legacy_infinite_strip       ...
```

Brak wsparcia ma dawać kodowany błąd:

```text
capability_unsupported:
feature=solved_antenna_drive
backend=fdm_cuda
required_realization=...
```

Nie wolno stosować silent fallback bez jawnej zgody użytkownika i proweniencji.

---

### 6.14. ANT-HIGH-010 i ANT-MED-001 — kontrola błędu całki pola

`DirectTetraQuadrature` ma adaptację i obsługę osobliwych przypadków, dlatego jest
singular-aware CPU-double oracle'em dla prądu tetrahedralnego. Nie jest jednak jeszcze
wystawiony i zakwalifikowany jako realizacja `antenna_field_solution.v1`. Poniższa lista
braków dotyczy legacy kernela nieskończonego paska oraz kompletnego produktu antenowego,
nie twierdzenia, że w repozytorium nie istnieje żadna numeryka osobliwości.

Legacy kernel wykorzystuje niewielką, twardo ograniczoną liczbę próbek przekroju. Nie ma:

- estymatora błędu;
- adaptacyjnego podziału;
- specjalnej kwadratury blisko osobliwości;
- porównania z rozwiązaniem analitycznym;
- zbieżności względem liczby próbek.

Dla całki objętościowej Biota–Savarta:

```{math}
:label: eq-merged-017

\mathbf H(\mathbf r)
=
\frac{1}{4\pi}
\int_{\Omega_c}
\frac{\mathbf J(\mathbf r')\times(\mathbf r-\mathbf r')}
{\lVert \mathbf r-\mathbf r'\rVert^3}
\,dV'
```

jądro jest słabo osobliwe dla targetu wewnątrz/nośnika prądu i szybko zmienne blisko powierzchni. Proste próbkowanie środka komórki nie daje kontrolowanego błędu.

### Docelowa strategia

- pole dalekie: standardowa kwadratura Gaussa;
- pole bliskie: adaptacyjna subdivizja;
- element zawierający target: transformacja Duffy’ego lub analityczna redukcja;
- powierzchnie/przewodniki cienkie: dedykowane jądra powierzchniowe;
- reference direct solver;
- przyspieszenie treecode/FMM dopiero po kwalifikacji reference.

---

### 6.15. ANT-MED-002 — błędna aktywacja quantity

W logice quantity dla FEM `H_ant` może być uznane za aktywne na podstawie samej niepustości `current_modules`. `CurrentTransport` nie jest automatycznie anteną i nie gwarantuje materializacji `H_ant`.

### Naprawa

Aktywność quantity musi wynikać z `QuantityMaterializationCapability`, nie z heurystyki typu modułu:

```text
planned
allocated
materialized
stale
unavailable(reason)
```

`H_ant` jest dostępne tylko, gdy istnieje przynajmniej jeden source field carrier.

---

### 6.16. ANT-MED-003 — ograniczona geometria maski

Planner maski obsługuje wybrany podzbiór prymitywów. Fullmag ma szerszy system geometrii, importów i regionów.

### Rekomendacja

`RegionalFieldDrive` powinien używać wspólnego mechanizmu Selection/Shape:

- boolean expressions;
- imported geometry;
- object/region selectors;
- transform chain;
- statyczne membership cache;
- boundary policy;
- clipping do targetu.

Nie należy utrzymywać drugiego, słabszego interpretera geometrii tylko dla anten.

---

### 6.17. ANT-MED-005 i ANT-MED-006 — brak częstotliwości i geometrii feedu

Jednorodny, statyczny rozkład prądu nie oddaje:

- efektu naskórkowego;
- efektu zbliżeniowego;
- tłoczenia prądu na krawędziach;
- fazy propagacji w feedzie;
- odbić i niedopasowania;
- taperów;
- wycieku pola z doprowadzeń;
- zależności od podłoża;
- skończonej długości.

To bezpośrednio wpływa na widmo $\mathbf k$, szczególnie dla submikronowych anten i częstotliwości GHz.

### Polityka wierności

Każde rozwiązanie musi publikować `validity_diagnostics`, między innymi:

```{math}
:label: eq-merged-018

\eta_{\mathrm{wave}}
=
\frac{2\pi L}{\lambda},
\qquad
\eta_{\mathrm{disp}}
=
\frac{\omega\varepsilon}{\sigma},
\qquad
\eta_{\mathrm{skin}}
=
\frac{t}{\delta},
```

gdzie:

```{math}
:label: eq-merged-019

\delta
=
\sqrt{\frac{2}{\omega\mu\sigma}}.
```

Tier 1 powinien ostrzegać, gdy $\eta_{\mathrm{skin}}$ lub $\eta_{\mathrm{wave}}$ przekracza ustalony próg.

---

### 6.18. ANT-MED-007 — hard-coded podział prądu CPW

Równy podział prądu między dwie masy jest poprawny wyłącznie dla idealnie symetrycznego układu i symetrycznego wzbudzenia.

W praktyce wpływają na niego:

- asymetria geometrii;
- różne impedancje;
- podłoże;
- bliskość innych obiektów;
- taper;
- połączenia portowe;
- efekt proximity.

Preset może domyślnie ustawiać $-1/2,-1/2$, ale wynik musi zawierać informację, że jest to **prescribed current split**, a nie rozwiązany rozkład.

---

### 6.19. ANT-MED-008 — brak artefaktu i grafu staleness

Obecne pole jest liczone ad hoc z planu. Brakuje:

- immutable manifestu;
- hashy wejść;
- oddzielenia solve od projekcji;
- ponownego użycia w wielu study;
- prawidłowego unieważniania;
- proweniencji dokładności;
- eksportu rozwiązania.

### Skutek

Nie da się jednoznacznie odpowiedzieć:

- czy widoczne pole odpowiada aktualnej geometrii;
- czy zmiana waveformu wymagała przeliczenia;
- czy zmiana target mesh unieważnia prąd;
- jaka wersja formuły została użyta.

Docelowe podpisy zdefiniowano w rozdziale 12.

---

### 6.20. ANT-MED-009 — airbox obserwacyjny a domena LLG

Należy rozdzielić:

1. **conductor domain** — domena rozwiązania przewodnictwa;
2. **electromagnetic air domain** — potrzebna w $A-\phi$ lub full-wave;
3. **field sampling domain** — gdzie użytkownik chce oglądać pole;
4. **magnetic target domain** — gdzie pole jest wstrzykiwane do LLG;
5. **demag airbox** — domena rozwiązania pola demagnetyzującego.

Te domeny mogą się pokrywać, ale nie są semantycznie identyczne. Parametr `air_box_factor` bez określenia, której domeny dotyczy, jest niewystarczający.

---

### 6.21. ANT-MED-010 — PBC i lokalna antena

Dla periodycznej domeny magnetycznej trzeba jawnie określić, czy antena:

- jest replikowana w każdej komórce;
- istnieje tylko w superkomórce;
- ma fazę Blocha między obrazami;
- jest polem nieperiodycznym, co może być niezgodne z redukcją stopni swobody.

Docelowy kontrakt:

```text
periodicity:
  kind: none | inherit_domain | replicated | bloch
  image_counts: [...]
  bloch_phase: [...]
```

Planner powinien odrzucać niejednoznaczną kombinację.

---

### 6.22. ANT-LOW-001 i ANT-LOW-002 — dokumentacja i źródło prawdy

Należy:

- przyjąć jeden canonical design document;
- oznaczyć ADR 0017 jako accepted dopiero po implementacji kontraktów;
- zaktualizować dokument fizyczny 0950;
- przenieść superseded plan z `docs/plans/active`;
- naprawić znak rotacji dla $\mathbf A=(0,A_y,0)$:
  ```{math}
:label: eq-merged-020

B_x=-\partial_z A_y,\qquad B_z=+\partial_x A_y;
```
- usunąć etykiety „MQS (Az)” z legacy UI;
- dodać automatyczne testy zgodności capability matrix z kodem.

---

### 6.23. ANT-HIGH-013 — solved-current Oersted jest związany z transportem spinowym

**Dowód w kodzie:** `crates/fullmag-plan/src/oersted.rs`, funkcja
`resolve_solved_current_source`, odrzuca solved-current source bez powiązanego modułu
`SpinDriftDiffusion`, mimo że sam charge solve ma właściciela w
`CurrentModuleIR::CurrentTransport` i `ChargeTransportDefinitionIR`.

**Skutek:** zwykła metaliczna antena nie ma kompletnej ścieżki charge-only. Musiałaby
zadeklarować sztuczny transport spinowy albo nie przejdzie planowania istniejącego pola
Oersteda. Jest to błąd kompozycji produktu, a nie brak równania przewodnictwa lub operatora
Oersteda.

**Wymagana naprawa:** kompletny `CurrentTransport` musi móc samodzielnie opublikować:

```text
V_electric
J_charge
ConservativeCurrentView
H_oe
```

bez `SpinDriftDiffusion`. Moduł spinowy pozostaje wymagany wyłącznie dla spin
accumulation, torque'u lub magnetorezystywnego sprzężenia zwrotnego. Testy muszą objąć:

1. poprawny charge-only solve i publikację wszystkich czterech zasobów;
2. zachowanie dotychczasowej ścieżki charge+spin;
3. brak niejawnego modułu spinowego po round-trip Python → ProblemIR → Python;
4. fail-closed, gdy definicja charge solve albo terminali jest niekompletna.

---

### 6.24. ANT-HIGH-014 — ryzyko powielenia stosu `CurrentTransport`/Oersted

Repozytorium ma już właścicieli numerycznych: `CurrentTransport`, konserwatywny widok
prądu RT0/$H(\mathrm{div})$, `DirectTetraQuadrature`, `VectorPotentialSolver`, wykonanie
steady transport oraz `StageOerstedProvider`. Osobne antenowe implementacje przewodnictwa,
rekonstrukcji prądu lub Biota–Savarta rozdzieliłyby znaki, jednostki, tolerancje,
diagnostykę i kwalifikację backendów.

**Wymagana naprawa:** warstwa antenowa jest wyłącznie warstwą kompozycji, normalizacji
portowej, trwałego assetu i projekcji. Nowe operatory są dopuszczalne dopiero jako jawnie
zakresowane rozszerzenia istniejących właścicieli numerycznych, z porównaniem do
CPU-double oracle i osobną kwalifikacją. Obecność klasy lub pliku nie jest dowodem
kwalifikacji runtime.


---

(governing-equations)=
## 7. Model fizyczny — definicje i pełne wyprowadzenie

Poniższe równania są normatywnym kontraktem fizycznym dla istniejącego łańcucha
`CurrentTransport → ConservativeCurrentView → Oersted` oraz dla jego rozszerzenia i
kwalifikacji jako workflow antenowego. Nie specyfikują drugiego solvera budowanego od
zera. `DirectTetraQuadrature` jest ograniczonym, singular-aware CPU-double oracle'em,
a `VectorPotentialSolver` ograniczoną realizacją referencyjną; sama obecność tych
komponentów nie oznacza jeszcze produktu `antenna_field_solution.v1`, kwalifikacji
konsumenta LLG ani harmonicznego solvera $A-\phi$.

(symbols-and-si-units)=
### 7.1. Konwencje, symbole i jednostki SI

W części harmonicznej przyjmujemy zależność czasową:

```{math}
:label: eq-merged-021

\mathbf F(\mathbf r,t)
=
\Re\left\{
\widehat{\mathbf F}(\mathbf r,\omega)
e^{-i\omega t}
\right\}.
```

Wtedy:

```{math}
:label: eq-merged-022

\frac{\partial}{\partial t}
\longrightarrow
-i\omega.
```

Wszystkie implementacje, artefakty i wykresy fazy muszą zapisywać tę konwencję w proweniencji. Nie wolno mieszać jej z konwencją $e^{+i\omega t}$ bez jawnej konwersji zespolonego sprzężenia.

Kanoniczny rejestr symboli używanych przez kontrakt produkcyjny:

| Id | Symbol | Znaczenie | Jednostka SI |
|---|---|---|---|
| `V` | $V$ | potencjał elektryczny | $\mathrm{V}$ |
| `J` | $\mathbf J$ | gęstość prądu | $\mathrm{A\,m^{-2}}$ |
| `sigma` | $\sigma$ | przewodność elektryczna | $\mathrm{S\,m^{-1}}$ |
| `I_p` | $I_p$ | prąd port mode $p$ | $\mathrm{A}$ |
| `w_pq` | $w_{p,q}$ | signed current weight gałęzi $q$ | $1$ |
| `H_ant` | $\mathbf H$ | natężenie pola magnetycznego | $\mathrm{A\,m^{-1}}$ |
| `M_s` | $M_s$ | magnetyzacja nasycenia | $\mathrm{A\,m^{-1}}$ |
| `m` | $\mathbf m$ | zredukowana magnetyzacja | $1$ |
| `r` | $\mathbf r,\mathbf r'$ | punkt obserwacji i punkt źródłowy | $\mathrm{m}$ |
| `k` | $\mathbf k$ | wektor falowy | $\mathrm{rad\,m^{-1}}$ |
| `W_H` | $W_H$ | nienormalizowana moc widma pola źródła | $\mathrm{(normalization\ dependent)}$ |
| `S_m` | $S_m$ | nienormalizowana dynamic structure factor | $\mathrm{(normalization\ dependent)}$ |

Pozostałe symbole używane w rozwinięciu: $\mathbf B$ ma jednostkę
$\mathrm T$, $\mathbf A$ ma jednostkę $\mathrm{Wb\,m^{-1}}$, $\mu$ ma
jednostkę $\mathrm{H\,m^{-1}}$, $\varepsilon$ ma jednostkę
$\mathrm{F\,m^{-1}}$, a $\omega$ ma jednostkę $\mathrm{rad\,s^{-1}}$.

### 7.2. Równania Maxwella

W domenie częstotliwości:

```{math}
:label: eq-merged-023

\nabla\times\widehat{\mathbf E}
=
i\omega\widehat{\mathbf B},
```

```{math}
:label: eq-merged-024

\nabla\times\widehat{\mathbf H}
=
\widehat{\mathbf J}_{\mathrm s}
+
\sigma\widehat{\mathbf E}
-
i\omega\widehat{\mathbf D},
```

```{math}
:label: eq-merged-025

\nabla\cdot\widehat{\mathbf B}=0,
```

```{math}
:label: eq-merged-026

\nabla\cdot\widehat{\mathbf D}
=
\widehat{\rho},
```

z relacjami konstytutywnymi:

```{math}
:label: eq-merged-027

\widehat{\mathbf B}
=
\boldsymbol{\mu}\widehat{\mathbf H},
\qquad
\widehat{\mathbf D}
=
\boldsymbol{\varepsilon}\widehat{\mathbf E}.
```

Dla izotropowego, nieferromagnetycznego otoczenia:

```{math}
:label: eq-merged-028

\boldsymbol{\mu}=\mu_0\mathbf I.
```

(assumptions-and-validity)=
### 7.3. Parametry ważności przybliżeń

### 7.3.1. Retardacja

Jeżeli charakterystyczny wymiar źródła wynosi $L$, a długość fali elektromagnetycznej $\lambda$, to:

```{math}
:label: eq-merged-029

\eta_{\mathrm{wave}}
=
\frac{2\pi L}{\lambda}
=
\omega L\sqrt{\mu\varepsilon}.
```

Dla $\eta_{\mathrm{wave}}\ll1$ retardacja przestrzenna jest mała i model quasi-statyczny może być wystarczający. Nie oznacza to automatycznie, że prąd jest jednorodny w przekroju.

### 7.3.2. Prąd przesunięcia

Stosunek gęstości prądu przesunięcia do przewodzenia:

```{math}
:label: eq-merged-030

\eta_{\mathrm{disp}}
=
\frac{\omega\varepsilon}{\sigma}.
```

Dla dobrych metali w GHz zwykle jest mały wewnątrz przewodnika, lecz dielektryki, porty i propagacja w linii mogą nadal wymagać pełnego modelu falowego.

### 7.3.3. Efekt naskórkowy

Dla dobrego przewodnika:

```{math}
:label: eq-merged-031

\delta
=
\sqrt{\frac{2}{\omega\mu\sigma}}.
```

Wskaźnik:

```{math}
:label: eq-merged-032

\eta_{\mathrm{skin}}
=
\frac{t_{\mathrm{char}}}{\delta}.
```

- $\eta_{\mathrm{skin}}\ll1$: prąd przez grubość może być zbliżony do jednorodnego;
- $\eta_{\mathrm{skin}}\sim1$: konieczne jest rozwiązywanie redystrybucji prądu;
- $\eta_{\mathrm{skin}}\gg1$: wymagane silne zagęszczenie siatki przy powierzchni lub model impedancji powierzchniowej.

### 7.3.4. Efekt zbliżeniowy

Nie ma jednego uniwersalnego parametru skalarnego. Solver powinien raportować co najmniej:

- stosunek szczeliny do grubości i szerokości;
- minimalną odległość między przewodnikami w jednostkach $\delta$;
- wskaźnik niejednorodności $\lVert J\rVert_{\max}/\langle\lVert J\rVert\rangle$.

### 7.4. Hierarchia modeli wierności

### Tier 0 — prescribed field

Użytkownik podaje bezpośrednio:

```{math}
:label: eq-merged-033

\mathbf H(\mathbf r,t)
=
a(t)\mathbf h(\mathbf r).
```

Brak przewodnika. Najszybszy model, dobry do badań kontrolnych.

### Tier 0L — legacy infinite-strip Biot–Savart

Prąd jednorodny, przewodnik nieskończony, przekrój prostokątny, jawnie określona oś. Model analityczno-kwadraturowy. Powinien pozostać jako szybki benchmark, nie jako „MQS solver”.

### Tier 1 — 3D DC conduction + 3D Biot–Savart

Najlepszy produkcyjny MVP:

1. rozwiązać stacjonarny przepływ prądu w rzeczywistej geometrii przewodnika i zwrotów;
2. zrekonstruować konserwatywną $\mathbf J$;
3. obliczyć pole Biota–Savarta w dowolnych targetach;
4. znormalizować do 1 A per port.

Model uwzględnia 3D geometrię, tapery i skończone długości, ale nie skin/proximity zależne od częstotliwości.

### Tier 2 — harmonic MQS $A-\phi$

Rozwiązuje zespolony rozkład prądu i pola przy danej częstotliwości. Uwzględnia skin i proximity, ale pomija istotną propagację falową i prąd przesunięcia.

### Tier 3 — pełny model falowy

Rozwiązuje pełne równania Maxwella z portami i warunkami radiacyjnymi/PML. Jest potrzebny do:

- wyznaczania dostarczonego prądu z mocy padającej;
- impedancji i $S$-parametrów;
- fal w feedach;
- silnego niedopasowania;
- radiacyjnego sprzężenia.

Tier 3 nie jest wymagany do pierwszego produkcyjnego wydania, ale kontrakty nie mogą blokować jego późniejszego dodania.

---

### 7.5. Tier 1 — równanie przewodnictwa

Niech $\Omega_c$ będzie domeną wszystkich przewodników. Dla stanu stacjonarnego:

```{math}
:label: eq-antenna-charge

\nabla\cdot\mathbf J=0,
```

```{math}
:label: eq-merged-035

\mathbf J=-\boldsymbol{\sigma}\nabla V.
```

Otrzymujemy:

```{math}
:label: eq-merged-036

\nabla\cdot
\left(
\boldsymbol{\sigma}\nabla V
\right)
=
0
\qquad
\text{w }\Omega_c.
```

### 7.5.1. Warunki brzegowe

Na izolowanych powierzchniach:

```{math}
:label: eq-merged-037

\mathbf n\cdot\mathbf J=0.
```

Na terminalu $\Gamma_q$:

- potencjał jest stały na powierzchni terminala;
- całkowity prąd terminalowy jest zadany:
  ```{math}
:label: eq-antenna-terminal-current

I_q
  =
  -\int_{\Gamma_q}
  \mathbf n\cdot\mathbf J\,dS,
```
  gdzie dodatni $I_q$ oznacza prąd wprowadzany do domeny;
- musi zachodzić:
  ```{math}
:label: eq-merged-039

\sum_q I_q=0.
```

Potencjał jest wyznaczony z dokładnością do stałej. Należy zastosować gauge, na przykład:

```{math}
:label: eq-merged-040

\sum_q U_q=0
```

lub ustawić jeden terminal referencyjny.

### 7.5.2. Słaba postać z equipotential terminals

Definiujemy przestrzeń:

```{math}
:label: eq-merged-041

\mathcal V
=
\left\{
v\in H^1(\Omega_c):
v|_{\Gamma_q}
\text{ jest stałe dla każdego }q
\right\}/\mathbb R.
```

Szukamy $V\in\mathcal V$, takiego że dla każdego $w\in\mathcal V$:

```{math}
:label: eq-antenna-conduction-weak

\int_{\Omega_c}
\nabla w\cdot
\boldsymbol{\sigma}\nabla V
\,dV
=
\sum_q I_q w_q,
```

gdzie $w_q$ jest stałą wartością testu na terminalu $q$, przy konsekwentnej definicji znaku prądu wejściowego.

Ta postać:

- wymusza equipotential terminals;
- zachowuje integralny prąd;
- naturalnie obsługuje wiele terminali;
- wymaga jednej więzi gauge.

Alternatywny MVP może zadać napięcia na terminalach, policzyć prąd, a następnie przeskalować rozwiązanie do 1 A. Dla systemu wieloportowego lepsza jest macierz przewodności terminalowej.

### 7.5.3. Dyskretyzacja

Rekomendowana ścieżka referencyjna:

1. $V_h$ w przestrzeni ciągłej $H^1$, początkowo P1;
2. rozwiązanie SPD po eliminacji gauge albo saddle-point przy terminalach;
3. rekonstrukcja:
   ```{math}
:label: eq-merged-043

\mathbf J_h^{H(\mathrm{div})}
```
   w RT0/BDM;
4. lokalna kontrola:
   ```{math}
:label: eq-merged-044

\int_{\partial K}
   \mathbf n\cdot\mathbf J_h\,dS
   =
   0
```
   dla elementów bez źródła;
5. wykorzystanie konserwatywnej $\mathbf J_h$ w całce Biota–Savarta.

Bez rekonstrukcji P1 daje elementowo stały, nieciągły strumień. Dla pola dalekiego może być wystarczający, ale dla produkcyjnej diagnostyki i sprzężenia z istniejącym transportem Fullmagu H(div) jest lepszym kontraktem.

### 7.5.4. Wielkości diagnostyczne

Bilans prądu:

```{math}
:label: eq-merged-045

\epsilon_I
=
\frac{\left|\sum_q I_q^{\mathrm{computed}}\right|}
{\max_q|I_q|+\epsilon}.
```

Rezystancja/impedancja DC:

```{math}
:label: eq-merged-046

R
=
\frac{\Delta V}{I}.
```

Moc Joule’a:

```{math}
:label: eq-merged-047

P_\Omega
=
\int_{\Omega_c}
\mathbf J\cdot
\boldsymbol{\sigma}^{-1}\mathbf J
\,dV.
```

Powinna zachodzić zgodność:

```{math}
:label: eq-merged-048

P_\Omega
\approx
\sum_q U_q I_q
```

z odpowiednią konwencją znaku.

Residual algebraiczny, liczba iteracji, estymator błędu i jakość siatki muszą znaleźć się w artefakcie.

---

### 7.6. Pole Biota–Savarta z rozkładu 3D

Dla prądu stacjonarnego w ośrodku o $\mu\approx\mu_0$:

```{math}
:label: eq-merged-049

\mathbf B(\mathbf r)
=
\frac{\mu_0}{4\pi}
\int_{\Omega_c}
\frac{
\mathbf J(\mathbf r')
\times
(\mathbf r-\mathbf r')
}{
\lVert\mathbf r-\mathbf r'\rVert^3
}
\,dV',
```

```{math}
:label: eq-antenna-biot-savart

\mathbf H(\mathbf r)
=
\frac{1}{4\pi}
\int_{\Omega_c}
\frac{
\mathbf J(\mathbf r')
\times
(\mathbf r-\mathbf r')
}{
\lVert\mathbf r-\mathbf r'\rVert^3
}
\,dV'.
```

### 7.6.1. Liniowość i baza portowa

Dla portu $p$, rozwiązania znormalizowanego do $I_p^{\mathrm{ref}}=1\ \mathrm A$:

```{math}
:label: eq-merged-051

\mathbf H_{p,1A}(\mathbf r)
=
\mathcal B[
\mathbf J_{p,1A}
](\mathbf r).
```

Dla wielu portów:

```{math}
:label: eq-merged-052

\mathbf H_{\mathrm{ant}}(\mathbf r,t)
=
\sum_p
I_p(t)\,
\mathbf H_{p,1A}(\mathbf r).
```

Dla pól harmonicznych:

```{math}
:label: eq-merged-053

\widehat{\mathbf H}_{\mathrm{ant}}(\mathbf r,\omega)
=
\sum_p
\widehat I_p(\omega)
\widehat{\mathbf H}_{p,1A}(\mathbf r,\omega).
```

### 7.6.2. Ocena blisko źródła

Jądro ma zachowanie $1/R^2$. Całka objętościowa jest lokalnie całkowalna, lecz zwykła kwadratura traci dokładność, gdy target jest blisko elementu źródłowego.

Klasyfikacja par target–element:

- far: $d/h>\tau_{\mathrm{far}}$;
- near: $d/h\le\tau_{\mathrm{far}}$;
- singular: target należy do elementu lub jego granicy.

Realizacje:

- far — stały rząd Gaussa;
- near — adaptacyjny podział;
- singular — Duffy, singularity subtraction lub formuła półanalityczna.

Artefakt powinien raportować:

- maksymalny rząd/subdivision depth;
- oszacowanie błędu;
- liczbę par near/singular;
- regularization policy.

### 7.6.3. Skalowalność

Bezpośrednia złożoność:

```{math}
:label: eq-merged-054

O(N_{\mathrm{target}}N_{\mathrm{source\ qp}}).
```

Etapy:

1. direct double-precision reference;
2. wielowątkowe CPU;
3. batched GPU direct dla średnich problemów;
4. treecode/FMM/H² dla dużych problemów;
5. porównanie każdej ścieżki z reference.

Optymalizacja nie może poprzedzać ustalenia poprawnego oracle.

---

### 7.7. Analityczny limit nieskończonego przewodnika

Dla prądu $I\mathbf e_y$ w punkcie $(x',z')$:

```{math}
:label: eq-merged-055

\mathbf H(x,z)
=
\frac{I}{2\pi}
\frac{
(z-z')\mathbf e_x
-
(x-x')\mathbf e_z
}{
(x-x')^2+(z-z')^2
}.
```

To równanie powinno być podstawowym testem znaku.

Dla jednorodnego prostokątnego przekroju o szerokości $w$, grubości $t$, środku $(x_c,z_c)$:

```{math}
:label: eq-merged-056

J_y
=
\frac{I}{wt},
```

```{math}
:label: eq-merged-057

\mathbf H(x,z)
=
\frac{I}{2\pi wt}
\int_{x_c-w/2}^{x_c+w/2}
\int_{z_c-t/2}^{z_c+t/2}
\frac{
(z-z')\mathbf e_x
-
(x-x')\mathbf e_z
}{
(x-x')^2+(z-z')^2
}
\,dz'\,dx'.
```

Ta całka może zostać zaimplementowana:

- półanalitycznie z logarytmami i $\arctan$;
- adaptacyjnie;
- jako dokładny benchmark dla legacy kwadratury.

### 7.7.1. Wymagana inwariancja

Dla nieskończonego przewodnika:

- translacja wzdłuż osi prądu nie zmienia pola;
- obrót całego układu obraca pole kowariantnie;
- odwrócenie prądu odwraca pole;
- poza przewodnikiem:
  ```{math}
:label: eq-merged-058

\nabla\times\mathbf H=0,
  \qquad
  \nabla\cdot\mathbf B=0;
```
- całka Ampère’a:
  ```{math}
:label: eq-merged-059

\oint_C \mathbf H\cdot d\mathbf l=I_{\mathrm{enclosed}}.
```

---

### 7.8. Tier 2 — harmoniczne MQS $A-\phi$

Wprowadzamy:

```{math}
:label: eq-merged-060

\widehat{\mathbf B}
=
\nabla\times\widehat{\mathbf A}.
```

Z prawa Faradaya i przyjętej konwencji:

```{math}
:label: eq-merged-061

\widehat{\mathbf E}
=
i\omega\widehat{\mathbf A}
-
\nabla\widehat{\phi}.
```

Prąd w przewodniku:

```{math}
:label: eq-merged-062

\widehat{\mathbf J}
=
\widehat{\mathbf J}_{\mathrm s}
+
\boldsymbol{\sigma}
\left(
i\omega\widehat{\mathbf A}
-
\nabla\widehat{\phi}
\right).
```

Po pominięciu prądu przesunięcia:

```{math}
:label: eq-merged-063

\nabla\times
\left(
\boldsymbol{\mu}^{-1}
\nabla\times\widehat{\mathbf A}
\right)
=
\widehat{\mathbf J}.
```

Stąd:

```{math}
:label: eq-merged-064

\nabla\times
\left(
\boldsymbol{\mu}^{-1}
\nabla\times\widehat{\mathbf A}
\right)
-
i\omega\boldsymbol{\sigma}\widehat{\mathbf A}
+
\boldsymbol{\sigma}\nabla\widehat{\phi}
=
\widehat{\mathbf J}_{\mathrm s}.
```

Równanie ciągłości:

```{math}
:label: eq-merged-065

\nabla\cdot
\left[
\widehat{\mathbf J}_{\mathrm s}
+
\boldsymbol{\sigma}
\left(
i\omega\widehat{\mathbf A}
-
\nabla\widehat{\phi}
\right)
\right]
=
0.
```

### 7.8.1. Gauge

Potencjał $\mathbf A$ nie jest jednoznaczny. Możliwości:

- gauge Coulomba:
  ```{math}
:label: eq-merged-066

\nabla\cdot\mathbf A=0;
```
- mixed formulation z mnożnikiem;
- penalty:
  ```{math}
:label: eq-merged-067

\eta_g
  \int
  (\nabla\cdot\mathbf A)
  (\nabla\cdot\mathbf v)
  \,dV;
```
- tree-cotree w odpowiednich dyskretyzacjach.

Artefakt musi zapisywać gauge i tolerancję.

### 7.8.2. Dyskretyzacja

Rekomendacja:

- $\mathbf A$: elementy krawędziowe Nédéleca $H(\mathrm{curl})$;
- $\phi$: $H^1$ w przewodnikach;
- porty: integral constraints;
- solver blokowy;
- preconditioner uwzględniający curl-curl i blok przewodnictwa;
- liczby zespolone w CPU reference;
- GPU po kwalifikacji.

### 7.8.3. Open boundary

W przeciwieństwie do Biota–Savarta, rozwiązanie $A-\phi$ wymaga domeny powietrznej i warunku otwartego.

MVP:

- duży airbox;
- warunek Dirichleta dla stycznego $\mathbf A$ na zewnętrznej granicy;
- badanie zbieżności względem rozmiaru airboxu.

Produkcja:

- infinite elements;
- boundary element coupling;
- asymptotic Robin;
- ewentualnie PML dla przejścia do pełnej fali.

`air_box_factor` jest wtedy fizycznie istotny, ale musi należeć do konkretnego `ElectromagneticDomainIR`, nie być nieopisanym skalarem źródła.

---

### 7.9. Redukcja 2.5D

Niech geometria i pola będą niezmienne wzdłuż lokalnej osi $\mathbf e_u$. Zakładamy:

```{math}
:label: eq-merged-068

\widehat{\mathbf A}
=
\widehat A_u(v,w)\mathbf e_u.
```

W jednorodnym układzie lokalnym:

```{math}
:label: eq-merged-069

-\nabla_\perp\cdot
\left(
\mu^{-1}\nabla_\perp \widehat A_u
\right)
-
i\omega\sigma\widehat A_u
=
\widehat J_{\mathrm{source},u},
```

po uwzględnieniu odpowiedniego wymuszenia pola elektrycznego/portowego i gauge.

Jeżeli prąd płynie w globalnym $+\mathbf e_y$, a:

```{math}
:label: eq-merged-070

\mathbf A=(0,A_y,0),
```

to z $\mathbf B=\nabla\times\mathbf A$:

```{math}
:label: eq-merged-071

B_x=-\frac{\partial A_y}{\partial z},
\qquad
B_y=0,
\qquad
B_z=+\frac{\partial A_y}{\partial x}.
```

To jest normatywna konwencja znaku.

### Ograniczenia 2.5D

Model nie opisuje:

- skończonej długości;
- terminali końcowych;
- taperów wzdłuż osi;
- wycieku z feedu;
- propagacji fazy wzdłuż linii;
- obrotów osi bez jawnej transformacji.

Może być bardzo użytecznym szybkim solverem przekroju, ale nie powinien udawać pełnego obiektu 3D.

---

### 7.10. Tier 3 — pełna fala

Dla pola elektrycznego w konwencji $e^{-i\omega t}$, po uwzględnieniu przewodności w zespolonej przenikalności:

```{math}
:label: eq-merged-072

\nabla\times
\left(
\mu^{-1}\nabla\times\widehat{\mathbf E}
\right)
-
\omega^2\varepsilon_c\widehat{\mathbf E}
=
i\omega\widehat{\mathbf J}_{\mathrm s},
```

gdzie:

```{math}
:label: eq-merged-073

\varepsilon_c
=
\varepsilon
+
i\frac{\sigma}{\omega}
```

dla przyjętej konwencji.

Wymagane są:

- porty modalne/lumped;
- PML lub warunki radiacyjne;
- fala padająca i odbita;
- normalizacja do mocy albo fali portowej;
- $S$-parametry;
- wyprowadzenie dostarczonego prądu.

Full-wave należy przewidzieć w kontrakcie, ale nie powinien blokować Tier 1.

---

## 8. Sprzężenie pola anteny z mikromagnetyką

### 8.1. Energia Zeemana

Dla znormalizowanej magnetyzacji:

```{math}
:label: eq-merged-074

\mathbf M(\mathbf r,t)
=
M_s(\mathbf r)\mathbf m(\mathbf r,t),
\qquad
\lVert\mathbf m\rVert=1,
```

energia antenowa:

```{math}
:label: eq-antenna-zeeman-energy

E_{\mathrm{ant}}
=
-\mu_0
\int_{\Omega_m}
M_s(\mathbf r)
\mathbf m(\mathbf r,t)
\cdot
\mathbf H_{\mathrm{ant}}(\mathbf r,t)
\,dV.
```

Odpowiadające pole efektywne:

```{math}
:label: eq-merged-076

\mathbf H_{\mathrm{eff}}
=
-\frac{1}{\mu_0M_s}
\frac{\delta E}{\delta\mathbf m}
=
\ldots+
\mathbf H_{\mathrm{ant}}.
```

### 8.2. Równanie LLG

W zapisie z polem $\mathbf H$ w A/m i $\gamma_0=\mu_0|\gamma|$:

```{math}
:label: eq-merged-077

\frac{\partial\mathbf m}{\partial t}
=
-\gamma_0
\mathbf m\times\mathbf H_{\mathrm{eff}}
+
\alpha
\mathbf m\times
\frac{\partial\mathbf m}{\partial t}.
```

Postać jawna:

```{math}
:label: eq-merged-078

\frac{\partial\mathbf m}{\partial t}
=
-\frac{\gamma_0}{1+\alpha^2}
\left[
\mathbf m\times\mathbf H_{\mathrm{eff}}
+
\alpha
\mathbf m\times
\left(
\mathbf m\times\mathbf H_{\mathrm{eff}}
\right)
\right].
```

### 8.3. Tylko składowa poprzeczna generuje moment

Dla stanu równowagi $\mathbf m_0$:

```{math}
:label: eq-merged-079

\mathbf H_\parallel
=
(\mathbf H\cdot\mathbf m_0)\mathbf m_0,
```

```{math}
:label: eq-merged-080

\mathbf H_\perp
=
\left(
\mathbf I-\mathbf m_0\mathbf m_0^\mathsf T
\right)\mathbf H.
```

Ponieważ:

```{math}
:label: eq-merged-081

\mathbf m_0\times\mathbf H_\parallel=0,
```

bezpośredni moment pochodzi od $\mathbf H_\perp$.

Nie oznacza to, że składowa równoległa zawsze jest nieistotna w nieliniowej dynamice, lecz dla liniowej selekcji modów podstawowym źródłem jest pole poprzeczne.

### 8.4. Waveform i stadium integratora

Dla bazy liniowej:

```{math}
:label: eq-merged-082

\mathbf H_{\mathrm{ant}}(\mathbf r,t)
=
\sum_p
c_p(t)\mathbf H_{p,1A}(\mathbf r),
```

gdzie $c_p(t)$ ma jednostkę A.

Dla adaptacyjnego RK pole musi być ocenione w każdym czasie stadium:

```{math}
:label: eq-merged-083

t_s=t_n+c_s\Delta t,
```

nie tylko przy zaakceptowanym kroku. Inaczej sinusoidalne wymuszenie jest próbkowane z błędną fazą i rzędem.

Semantyka `stage_local` i `absolute` musi być wspólna dla wszystkich backendów.

### 8.5. Superpozycja wielu źródeł

Dla źródeł koherentnych:

```{math}
:label: eq-merged-084

\widehat{\mathbf H}_{\mathrm{total}}
=
\sum_{s,p}
\widehat I_{s,p}
e^{i\varphi_{s,p}}
\widehat{\mathbf H}_{s,p,1A}.
```

Widmo mocy nie jest sumą widm mocy poszczególnych źródeł:

```{math}
:label: eq-merged-085

\left|
\sum_p
\widehat I_p\widetilde{\mathbf H}_p
\right|^2
=
\sum_p
|\widehat I_p|^2|\widetilde{\mathbf H}_p|^2
+
\sum_{p\ne q}
\widehat I_p\widehat I_q^*
\widetilde{\mathbf H}_p
\cdot
\widetilde{\mathbf H}_q^*.
```

Cross terms są kluczowe dla phased arrays i kierunkowego wzbudzenia.

### 8.6. Jednokierunkowe sprzężenie

Pierwsze produkcyjne wydanie może zakładać:

- antena generuje pole;
- magnetyzacja nie zmienia rozkładu prądu ani impedancji anteny.

Należy to zapisać jako:

```text
coupling = one_way_em_to_llg
```

Odbiór, back-action, indukowana SEM, $S_{21}$ i efektywność obwodowa wymagają później sprzężenia zwrotnego lub modelu reciprocity/lumped circuit.



---

## 9. Jak poprawnie określić, jakie fale spinowe może wzbudzić antena

### 9.1. Nie istnieje pojedyncza binarna odpowiedź „antenna excites $k$”

Antenna nie wybiera jednego wektora falowego. Generuje ciągły rozkład pola przestrzennego, a zatem ciągłe widmo:

```{math}
:label: eq-merged-086

\widetilde{\mathbf H}(\mathbf k).
```

Efektywne wzbudzenie zależy jednocześnie od:

1. widma pola;
2. kierunku równowagowej magnetyzacji;
3. eliptyczności i polaryzacji precesji;
4. dyspersji materiału;
5. profilu modu przez grubość i szerokość;
6. symetrii;
7. częstotliwości;
8. tłumienia;
9. geometrii skończonej;
10. interferencji wielu portów.

Dlatego UI powinno rozdzielać co najmniej cztery wyniki:

- **source spectrum** — co zawiera pole anteny;
- **torque-weighted source spectrum** — co jest poprzeczne do $\mathbf m_0$;
- **susceptibility/mode-weighted coupling** — co może być rezonansowo pobudzone;
- **measured simulated response** — co faktycznie pojawiło się w $\mathbf m(\mathbf r,t)$.

### 9.2. Konwencja transformaty Fouriera

Dla pola przestrzennego:

```{math}
:label: eq-antenna-source-spectrum

\widetilde{\mathbf h}(\mathbf k)
=
\int_{\Omega_a}
w(\mathbf r)
\mathbf h(\mathbf r)
e^{-i\mathbf k\cdot\mathbf r}
\,d\mathbf r,
```

```{math}
:label: eq-merged-088

\mathbf h(\mathbf r)
=
\frac{1}{(2\pi)^d}
\int
\widetilde{\mathbf h}(\mathbf k)
e^{+i\mathbf k\cdot\mathbf r}
\,d\mathbf k.
```

$w(\mathbf r)$ jest jawnym oknem i/lub wagą targetu. Artefakt musi zawierać:

- wymiar $d$;
- osie lokalne;
- transform convention;
- normalization;
- window;
- jednostkę;
- spacing i extent;
- origin;
- maskę.

### 9.3. Pole poprzeczne

Podstawowy wynik antenowy dla wzbudzenia liniowego:

```{math}
:label: eq-antenna-transverse-field

\mathbf h_\perp(\mathbf r)
=
\left[
\mathbf I
-
\mathbf m_0(\mathbf r)
\mathbf m_0^\mathsf T(\mathbf r)
\right]
\mathbf H_{\mathrm{ant}}(\mathbf r).
```

Jeżeli $\mathbf m_0$ jest niejednorodne, projekcja musi zostać wykonana lokalnie przed transformatą. Transformata całkowitego $|\mathbf H|$ może błędnie wskazać duże sprzężenie, mimo że pole jest równoległe do magnetyzacji.

### 9.4. Lokalna baza poprzeczna i polaryzacje kołowe

W każdym punkcie wybieramy ortonormalną bazę:

```{math}
:label: eq-merged-090

\left(
\mathbf e_1,
\mathbf e_2,
\mathbf m_0
\right),
\qquad
\mathbf e_1\times\mathbf e_2=\mathbf m_0.
```

Składowe:

```{math}
:label: eq-merged-091

h_1=\mathbf e_1\cdot\mathbf h,
\qquad
h_2=\mathbf e_2\cdot\mathbf h.
```

Polaryzacje kołowe:

```{math}
:label: eq-merged-092

h_+
=
\frac{h_1+i h_2}{\sqrt 2},
\qquad
h_-
=
\frac{h_1-i h_2}{\sqrt 2}.
```

Ponieważ etykieta „+”/„−” zależy od konwencji czasu, znaku $\gamma$ i orientacji bazy, artefakt musi przechowywać definicję. UI powinno pokazywać obie składowe i wskazywać tę rezonansową dopiero na podstawie zlinearyzowanego operatora.

### 9.5. Miary źródłowe

### 9.5.1. Surowe widmo wektorowe

```{math}
:label: eq-merged-093

W_{\mathrm{raw}}(\mathbf k)
=
\sum_{\alpha=x,y,z}
\left|
\widetilde H_\alpha(\mathbf k)
\right|^2.
```

Jest użyteczne do diagnostyki pola, ale nie jest najlepszą miarą wzbudzenia.

### 9.5.2. Widmo poprzeczne

```{math}
:label: eq-merged-094

W_\perp(\mathbf k)
=
\sum_{a=1,2}
\left|
\widetilde h_a(\mathbf k)
\right|^2.
```

### 9.5.3. Widmo polaryzacyjne

```{math}
:label: eq-merged-095

W_\pm(\mathbf k)
=
\left|
\widetilde h_\pm(\mathbf k)
\right|^2.
```

### 9.5.4. Normalizacja

Możliwe widoki:

- absolutny:
  ```{math}
:label: eq-merged-096

W_\perp
  \quad
  [(\mathrm{A/m})^2\mathrm m^{2d}];
```
- per $1\ \mathrm A$;
- normalized-to-peak;
- relative dB:
  ```{math}
:label: eq-merged-097

10\log_{10}
  \frac{W(\mathbf k)}{W_{\max}};
```
- density per $k$-bin;
- integral-normalized.

UI musi jawnie pokazać normalizację. „Excitable range” może być zdefiniowane dopiero po wybraniu progu, na przykład $-20$ dB, nie jako intrinsic binary property.

### 9.6. Zależność od podatności

W układzie translacyjnie niezmienniczym:

```{math}
:label: eq-merged-098

\widetilde{\mathbf m}(\mathbf k,\omega)
=
\boldsymbol{\chi}(\mathbf k,\omega)
\widetilde{\mathbf h}_\perp(\mathbf k,\omega).
```

Wtedy miara sprzężenia może być zdefiniowana jako:

```{math}
:label: eq-merged-099

C(\mathbf k,\omega)
=
\widetilde{\mathbf h}_\perp^\dagger
\operatorname{Im}
\boldsymbol{\chi}(\mathbf k,\omega)
\widetilde{\mathbf h}_\perp.
```

Dla przyjętej konwencji $e^{-i\omega t}$, średnia moc absorbowana w modelu liniowym ma standardową postać:

```{math}
:label: eq-merged-100

P_{\mathrm{abs}}(\omega)
=
\frac{\mu_0\omega}{2}
\int
\widetilde{\mathbf h}^\dagger
\operatorname{Im}\boldsymbol{\chi}
\widetilde{\mathbf h}
\,d\mathbf k,
```

po uwzględnieniu spójnej definicji $\chi$, objętości i normalizacji.

Wynik `source_k_profile` nie powinien być nazywany `excitation_efficiency`, dopóki podatność nie została uwzględniona.

### 9.7. Dyspersja i propagujące fale

Dla pasma $n$ o dyspersji:

```{math}
:label: eq-merged-101

\omega=\omega_n(\mathbf k),
```

antena efektywnie pobudza te obszary, gdzie jednocześnie:

```{math}
:label: eq-merged-102

W_\perp(\mathbf k)\ \text{jest istotne}
```

oraz:

```{math}
:label: eq-merged-103

\omega_{\mathrm{drive}}
\approx
\omega_n(\mathbf k).
```

Należy publikować:

- mapę $W_\perp(\mathbf k)$;
- dyspersję $\omega_n(\mathbf k)$;
- przekrój przy $\omega_{\mathrm{drive}}$;
- przewidywane piki $k$;
- szerokość pasma w $k$;
- kierunki prędkości grupowej:
  ```{math}
:label: eq-merged-104

\mathbf v_g=\nabla_\mathbf k\omega_n.
```

Dla anizotropowej dyspersji kierunek $\mathbf k$ i kierunek przepływu energii nie muszą być identyczne.

### 9.8. Struktury skończone i fale stojące

W obiekcie skończonym $\mathbf k$ nie musi być dobrą etykietą. Wtedy właściwa jest analiza modalna.

Linearyzujemy dynamikę:

```{math}
:label: eq-merged-105

\dot{\boldsymbol{\xi}}
=
\mathcal L\boldsymbol{\xi}
+
\mathcal B\mathbf h(t),
```

gdzie $\boldsymbol{\xi}$ opisuje perturbację poprzeczną.

Prawe mody:

```{math}
:label: eq-merged-106

\mathcal L\mathbf r_n
=
\lambda_n\mathbf r_n.
```

Lewe mody:

```{math}
:label: eq-merged-107

\mathbf l_n^\dagger\mathcal L
=
\lambda_n\mathbf l_n^\dagger.
```

Po normalizacji biortogonalnej:

```{math}
:label: eq-merged-108

\mathbf l_n^\dagger
\mathbf M
\mathbf r_m
=
\delta_{nm},
```

współczynnik napędu:

```{math}
:label: eq-antenna-mode-overlap

g_{n,p}
=
\mathbf l_n^\dagger
\mathbf M
\mathcal B
\mathbf h_{p,1A}.
```

Dla harmonicznego wymuszenia:

```{math}
:label: eq-merged-110

c_n(\omega)
=
\frac{
g_{n,p}\widehat I_p(\omega)
}{
-i\omega-\lambda_n
}.
```

To jest produkcyjnie poprawniejsza definicja sprzężenia niż zwykły iloczyn skalarny pola z prawym modem.

### Wymóg wdrożeniowy

Dopóki Fullmag nie ma zakwalifikowanych lewych modów i normalizacji:

- można publikować `raw_work_overlap`;
- nie należy nazywać go absolutnym coupling coefficient;
- artefakt musi zawierać `normalization="unnormalized"`.

### 9.9. Rzeczywista odpowiedź dynamiczna

Po symulacji czasowej:

```{math}
:label: eq-merged-111

\delta\mathbf m(\mathbf r,t)
=
\mathbf m(\mathbf r,t)-\mathbf m_0(\mathbf r).
```

Transformata:

```{math}
:label: eq-merged-112

\widetilde{\delta\mathbf m}(\mathbf k,\omega)
=
\int dt
\int d\mathbf r\,
w_t(t)w_r(\mathbf r)
\delta\mathbf m(\mathbf r,t)
e^{-i\mathbf k\cdot\mathbf r}
e^{+i\omega t}.
```

Dynamic structure factor może być zdefiniowany jako:

```{math}
:label: eq-antenna-dynamic-structure-factor

S_m(\mathbf k,\omega)
=
\sum_a
\left|
\widetilde{\delta m_a}(\mathbf k,\omega)
\right|^2,
```

z odpowiednim współczynnikiem normalizacji.

Istniejąca implementacja Fullmagu jest wartościowym punktem wyjścia, ale musi zostać rozszerzona o:

- wybór anteny jako źródła;
- per-source `H_ant`;
- 2D/3D;
- lokalne osie;
- większy zestaw komponentów;
- pełną proweniencję.

---

## 10. Analityczne widmo prostych anten

### 10.1. Nieskończona warstwa prądowa

Niech powierzchniowy prąd:

```{math}
:label: eq-merged-114

\mathbf K(x)
=
K_y(x)\mathbf e_y
```

znajduje się na wysokości $z=d$, a magnes poniżej.

Transformata po $x$:

```{math}
:label: eq-merged-115

\widetilde K_y(k)
=
\int_{-\infty}^{+\infty}
K_y(x)e^{-ikx}\,dx.
```

Dla $k\ne0$, potencjał:

```{math}
:label: eq-merged-116

\widetilde A_y(k,z)
=
\frac{\mu_0\widetilde K_y(k)}
{2|k|}
e^{-|k||z-d|}.
```

Dla $z<d$:

```{math}
:label: eq-merged-117

\widetilde H_x(k,z)
=
-\frac{1}{2}
\widetilde K_y(k)
e^{-|k|(d-z)},
```

```{math}
:label: eq-merged-118

\widetilde H_z(k,z)
=
\frac{i\,\operatorname{sgn}(k)}{2}
\widetilde K_y(k)
e^{-|k|(d-z)}.
```

Wnioski:

- odległość antena–magnes działa jak filtr:
  ```{math}
:label: eq-merged-119

e^{-|k|d};
```
- duże $k$ są wykładniczo tłumione;
- składowe $H_x$ i $H_z$ mają relację fazową;
- pełny wektor zespolony jest ważniejszy niż sam $|H|$.

### 10.2. Jednorodny pasek

Dla paska o szerokości $w$, całkowitym prądzie $I$:

```{math}
:label: eq-merged-120

K_y(x)
=
\frac{I}{w}
\operatorname{rect}
\left(
\frac{x-x_0}{w}
\right).
```

Przy definicji:

```{math}
:label: eq-merged-121

\operatorname{sinc}(u)
=
\frac{\sin u}{u},
```

otrzymujemy:

```{math}
:label: eq-merged-122

\widetilde K_y(k)
=
I
\operatorname{sinc}
\left(
\frac{kw}{2}
\right)
e^{-ikx_0}.
```

Zatem:

```{math}
:label: eq-merged-123

|\widetilde K_y(k)|^2
=
I^2
\operatorname{sinc}^2
\left(
\frac{kw}{2}
\right).
```

Przesunięcie zmienia fazę, ale nie widmo mocy. Szerokość ustala zera:

```{math}
:label: eq-merged-124

k_n
=
\frac{2\pi n}{w},
\qquad
n\ne0.
```

W praktyce efektywne widmo pola jest dodatkowo mnożone przez $e^{-2|k|d}$ w mocy.

### 10.3. Symetryczny CPW

Niech:

- sygnał o szerokości $w_s$ jest w $x=0$ i niesie $+I$;
- masy o szerokości $w_g$ są w $x=\pm a$ i każda niesie $-I/2$.

Wtedy:

```{math}
:label: eq-merged-125

\widetilde K_{\mathrm{CPW}}(k)
=
I
\operatorname{sinc}
\left(
\frac{kw_s}{2}
\right)
-
I
\cos(ka)
\operatorname{sinc}
\left(
\frac{kw_g}{2}
\right).
```

Dla $k=0$:

```{math}
:label: eq-merged-126

\widetilde K_{\mathrm{CPW}}(0)
=
I-I=0.
```

Jest to konsekwencja zerowego prądu netto. Widmo ma wiele pików i zer zależnych od położenia mas. Dlatego droga powrotna jest częścią fizyki selekcji $k$, nie detalem UI.

### 10.4. Asymetryczne zwroty

Dla wag $c_q$, położeń $x_q$ i szerokości $w_q$:

```{math}
:label: eq-merged-127

\widetilde K(k)
=
\sum_q
I_q
\operatorname{sinc}
\left(
\frac{kw_q}{2}
\right)
e^{-ikx_q}.
```

Asymetria wprowadza zespoloną fazę i może prowadzić do kierunkowej asymetrii po połączeniu z chiralną podatnością lub polaryzacją pola.

### 10.5. Skończona długość

Aproksymacja prostokątnego aperture o długości $L$ wzdłuż $u$:

```{math}
:label: eq-merged-128

\widetilde J(k_u,k_v)
\propto
\operatorname{sinc}
\left(
\frac{k_uL}{2}
\right)
\operatorname{sinc}
\left(
\frac{k_vw}{2}
\right).
```

Należy podkreślić, że izolowany skończony segment prądu nie jest fizycznie zamknięty. Ten wzór opisuje aperture approximation; produkcyjny solver 3D musi zawierać terminale i zwroty.

### 10.6. Taper i feed

Dla zmiennej szerokości $w(u)$ i amplitudy prądu $I(u)$ widmo jest konwolucją/całką lokalnych aperture:

```{math}
:label: eq-merged-129

\widetilde{\mathbf H}(k_u,k_v)
=
\int
du\,
I(u)
e^{-ik_uu}
\widetilde{\mathbf h}_{w(u)}(k_v;u).
```

Taper może generować:

- niskie $k$;
- side-lobes;
- asymetrię fazową;
- pole poza nominalną strefą anteny.

To uzasadnia produkcyjne modelowanie całego doprowadzenia, nie tylko centralnego paska.

---

## 11. Numeryczna analiza FFT i $k$-przestrzeni

### 11.1. FDM — regularna siatka

Dla próbek $h_j=h(x_j)$, $x_j=x_0+j\Delta x$, $j=0,\ldots,N-1$:

```{math}
:label: eq-merged-130

\widetilde h_n
=
\Delta x
\sum_{j=0}^{N-1}
w_jh_j
e^{-2\pi ijn/N}.
```

Długość okna:

```{math}
:label: eq-merged-131

L=N\Delta x.
```

Wektory falowe:

```{math}
:label: eq-merged-132

k_n
=
\frac{2\pi}{L}
n_{\mathrm{signed}},
```

gdzie:

```{math}
:label: eq-merged-133

n_{\mathrm{signed}}
=
\begin{cases}
n, & n\le N/2,\\
n-N, & n>N/2.
\end{cases}
```

Rozdzielczość:

```{math}
:label: eq-merged-134

\Delta k=\frac{2\pi}{L}.
```

Granica Nyquista:

```{math}
:label: eq-merged-135

k_{\mathrm{Nyq}}=\frac{\pi}{\Delta x}.
```

### Ważne

- zwiększenie $L$ poprawia rozdzielczość $\Delta k$;
- zmniejszenie $\Delta x$ zwiększa zakres Nyquista;
- zero padding interpoluje widmo, ale nie poprawia fizycznej rozdzielczości;
- maskowanie obiektu jest mnożeniem w przestrzeni i konwolucją w $k$.

### 11.2. Parseval

Przy powyższej normalizacji:

```{math}
:label: eq-merged-136

\Delta x
\sum_j
|w_jh_j|^2
=
\frac{1}{L}
\sum_n
|\widetilde h_n|^2.
```

Analogiczne relacje obowiązują w 2D/3D. Test Parsevala jest obowiązkowy dla każdej realizacji FFT.

### 11.3. Okna

Dla okna $w_j$:

Coherent gain:

```{math}
:label: eq-merged-137

G_c
=
\frac{1}{N}
\sum_jw_j.
```

Power gain:

```{math}
:label: eq-merged-138

U
=
\frac{1}{N}
\sum_jw_j^2.
```

Artefakt powinien zapisywać:

- nazwę okna;
- $G_c$;
- $U$;
- equivalent noise bandwidth;
- czy amplituda została skorygowana;
- czy wynik jest power spectrum czy amplitude spectrum.

Wspierane minimum:

- rectangular;
- Hann;
- Tukey;
- Blackman;
- Kaiser z parametrem.

### 11.4. 2D i 3D

Dla płaszczyzny:

```{math}
:label: eq-merged-139

\widetilde{\mathbf h}(k_u,k_v)
=
\int du\,dv\,
w(u,v)\mathbf h(u,v)
e^{-i(k_uu+k_vv)}.
```

Dla objętości:

```{math}
:label: eq-merged-140

\widetilde{\mathbf h}(\mathbf k)
=
\int d^3r\,
w(\mathbf r)\mathbf h(\mathbf r)
e^{-i\mathbf k\cdot\mathbf r}.
```

Pełna 3D tablica może być bardzo duża. UI powinno wspierać:

- 1D line spectrum;
- 2D plane spectrum;
- radial/angular reductions;
- selected $k$-path;
- 3D tylko jako opcjonalny artefakt offline.

### 11.5. FEM — nie wolno FFT-ować nieuporządkowanej listy węzłów

Dwie poprawne ścieżki:

### 11.5.1. Resampling na regularną siatkę

1. zdefiniować linię/płaszczyznę/box;
2. interpolować pole P1/P$p$;
3. zarejestrować punkty poza domeną;
4. zastosować maskę i okno;
5. użyć FFT.

Artefakt musi zawierać:

- metodę interpolacji;
- pokrycie targetu;
- fraction outside;
- topology/mesh hash;
- spacing i extent.

### 11.5.2. Bezpośrednia kwadratura FE

```{math}
:label: eq-merged-141

\widetilde{\mathbf h}(\mathbf k)
\approx
\sum_e
\sum_q
w_{e,q}
\det\mathbf J_e
\mathbf h_h(\mathbf r_{e,q})
e^{-i\mathbf k\cdot\mathbf r_{e,q}}.
```

Zalety:

- brak błędu resamplingu;
- naturalna integracja po rzeczywistej geometrii;
- łatwe wagi $M_s$, regionu i profilu przez grubość.

Wady:

- koszt $O(N_kN_q)$;
- dla wielu $k$ potrzebny NUFFT/FMM-like acceleration.

Rekomendacja:

- direct FE quadrature jako reference;
- regular-grid FFT jako szybka ścieżka;
- test parity między nimi.

### 11.6. Integracja przez grubość i szerokość

Proste uśrednienie:

```{math}
:label: eq-merged-142

\mathbf h_{\mathrm{eff}}(u)
=
\frac{
\int_{A_\perp}
w_A(\mathbf r_\perp)
\mathbf h(u,\mathbf r_\perp)
\,dA
}{
\int_{A_\perp}w_A\,dA
}.
```

To może wyzerować sprzężenie do modów nieparzystych. Produkcyjny system powinien oferować:

- average;
- integral;
- selected layer/slice;
- $M_s$-weighted;
- equilibrium transverse;
- eigenmode-weighted;
- user-defined weight asset.

### 11.7. Lokalna analiza $k$

Dla anteny o zmiennej geometrii globalne FFT miesza różne regiony. Należy wspierać krótkoczasową/przestrzenną transformatę:

```{math}
:label: eq-antenna-local-spectrum

\widetilde h(u_0,k_u)
=
\int
g(u-u_0)
h(u)
e^{-ik_uu}
\,du.
```

Parametry:

- center;
- window width;
- overlap;
- normalization;
- local frame.

Alternatywą jest wavelet transform. Pierwsze wydanie może ograniczyć się do STFT.

### 11.8. Wieloportowa analiza

Należy przechowywać FFT każdej bazy:

```{math}
:label: eq-merged-144

\widetilde{\mathbf H}_{p,1A}(\mathbf k).
```

Dla zadanych prądów:

```{math}
:label: eq-merged-145

\widetilde{\mathbf H}_{\mathrm{total}}(\mathbf k)
=
\sum_p
\widehat I_p
\widetilde{\mathbf H}_{p,1A}(\mathbf k).
```

Zmiana fazy/prądu nie wymaga ponownego FFT baz, tylko taniej kombinacji zespolonej.

### 11.9. Kryteria jakości analizy

Każdy artefakt widma musi raportować:

- $\Delta k$;
- $k_{\mathrm{Nyq}}$;
- długość okna;
- fraction masked;
- window correction;
- Parseval error;
- aliasing warning;
- source mesh resolution;
- projection error;
- equilibrium revision;
- source field solution ID;
- source/port coefficients;
- phase convention.

### 11.10. Relacja do istniejącego `dynamic_structure_factor.1d.v1`

Należy zachować obecną infrastrukturę jako analizę odpowiedzi i dodać osobny artefakt źródłowy:

```text
antenna_source_spectrum.v1
```

Następnie `dynamic_structure_factor.1d.v2` powinien wskazywać:

- `drive_field_resource`;
- `source_id`;
- `port_combination`;
- `equilibrium_asset`;
- `source_spectrum_artifact`, jeśli istnieje.

Nie należy nadpisywać `H_drive` polem `H_ant` bez rozróżnienia.



---

(problem-ir)=
## 12. Docelowa architektura domenowa i ProblemIR

### 12.1. Zasada nadrzędna

Docelowy produkt ma być kompozycją istniejących właścicieli, a nie równoległym stosem
solverowym:

```text
PhysicsObjectIR(type = Antenna | Conductor)
    │
    ├── GeometryIR
    ├── ObjectMaterialAssignmentIR
    └── terminal/port-mode composition metadata
            │
            ▼
CurrentModuleIR::CurrentTransport
            │
            ▼
ChargeTransportDefinitionIR
            │
            ▼
ConservativeCurrentView RT0/H(div)
            │
            ├── DirectTetraQuadrature
            └── VectorPotentialSolver
                    │
                    ▼
antenna_field_solution.v1
                    │
                    ├── inspection/Airbox projection
                    ├── FEM target projection
                    └── FDM target projection
                            │
                            ▼
SolvedAntennaDrive
                            │
                            ▼
LLG + H_ant/H_ant_basis resources
```

Każdy etap ma osobny kontrakt, proweniencję, cache i status, ale geometria, materiał,
transport i numeryka pola zachowują dotychczasowych właścicieli. W szczególności Fullmag
nie potrzebuje drugiego solvera przewodnictwa ani drugiego operatora pola Oersteda dla
anten. Potrzebuje charge-only kompozycji, normalizacji portowej, immutable assetu oraz
zakwalifikowanych konsumentów LLG.

### 12.2. Inwentaryzacja i minimalna warstwa kompozycyjna IR

#### 12.2.1. Byty istniejące — nie duplikować

| Właściciel | Stan i rola w workflow antenowym |
|---|---|
| `PhysicsObjectIR::{Conductor,Antenna}` | istniejąca tożsamość obiektu i powiązanie ze sceną |
| `CurrentModuleIR::CurrentTransport` | istniejący właściciel charge solve |
| `ChargeTransportDefinitionIR` | istniejący kontrakt transportu ładunku |
| `ResolvedFemConservativeCurrentViewIR` | istniejący resolved kontrakt widoku prądu |
| `ConservativeCurrentView` | istniejący konserwatywny widok RT0/$H(\mathrm{div})$ |
| `DirectTetraQuadrature` | ograniczony singular-aware CPU-double oracle Oersteda |
| `VectorPotentialSolver` | ograniczona referencyjna realizacja Oersteda; nie $A-\phi$ |
| `StageOerstedProvider` | istniejąca ewaluacja stage-time i identity source state |
| `V_electric`, `J_charge`, `H_oe` | istniejące canonical quantities |

Status „istniejący” nie jest równoznaczny z kwalifikacją w każdym lane. Macierz
capability i runtime receipts pozostają rozstrzygające.

#### 12.2.2. `AntennaPortModeIR` — projekt

```rust
pub struct AntennaPortModeIR {
    pub schema_version: String,
    pub id: String,
    pub source_object_ref: String,
    pub current_transport_ref: String,
    pub terminals: Vec<AntennaPortTerminalRefIR>,
    pub reference_current_a: f64,
}
```

Terminale są referencjami do istniejących surface selectors transportu; nie kopiują
geometrii. Signed branch weights muszą spełniać bilans, a `reference_current_a` w
pierwszej wersji wynosi dokładnie $1\ \mathrm A$.

#### 12.2.3. `AntennaFieldSolveStageIR` — projekt

```rust
pub struct AntennaFieldSolveStageIR {
    pub schema_version: String,
    pub id: String,
    pub port_mode_ref: String,
    pub oersted_realization: ExistingOerstedRealizationIR,
    pub sampling_targets: Vec<FieldSamplingTargetRefIR>,
    pub requested_outputs: Vec<AntennaFieldOutputIR>,
}
```

Typ wybiera istniejącą realizację Oersteda i cele próbkowania. Nie zawiera własnej
geometrii, materiału, solve'u przewodnictwa ani rekonstrukcji prądu.

#### 12.2.4. `AntennaFieldSolutionRefIR` — projekt

```rust
pub struct AntennaFieldSolutionRefIR {
    pub solution_asset_id: String,
    pub source_ref: String,
    pub port_mode_ref: String,
    pub normalization: AntennaFieldNormalizationIR,
    pub content_digest: String,
}
```

Referencja wskazuje immutable `antenna_field_solution.v1`; nie osadza tablic pola w IR.

#### 12.2.5. `AntennaTargetProjectionRefIR` — projekt

```rust
pub struct AntennaTargetProjectionRefIR {
    pub solution_ref: AntennaFieldSolutionRefIR,
    pub target_ref: String,
    pub projection_asset_id: String,
    pub projection_digest: String,
}
```

Projekcja jest osobnym, cache'owalnym produktem zależnym od assetu źródłowego, targetu,
carrier/topology oraz algorytmu projekcji.

#### 12.2.6. `SolvedAntennaDriveIR` — projekt

```rust
pub struct SolvedAntennaDriveIR {
    pub schema_version: String,
    pub id: String,
    pub name: String,
    pub projection_ref: AntennaTargetProjectionRefIR,
    pub current_waveform: TimeDependenceIR,
    pub activation: DriveActivationIR,
    pub time_origin: FieldTimeOriginIR,
}
```

Drive skaluje bazę per 1 A i nie uruchamia ukrytego solve'u pola.

#### 12.2.7. `AntennaSpectrumRequestIR` — projekt

```rust
pub struct AntennaSpectrumRequestIR {
    pub schema_version: String,
    pub id: String,
    pub solution_ref: AntennaFieldSolutionRefIR,
    pub target: AnalysisTargetIR,
    pub transform: WavevectorTransformIR,
    pub component: AntennaSpectrumComponentIR,
    pub equilibrium_asset_id: Option<String>,
    pub mode_asset_id: Option<String>,
    pub outputs: Vec<AntennaAnalysisOutputIR>,
}
```

Typ obejmuje raw, transverse, circular, local-$k$, mode overlap i susceptibility-weighted
coupling. Wszystkie nowe typy są projektem; nie wolno opisywać ich jak symboli obecnych
w kodzie przed implementacją i dowodem round-trip.

#### 12.2.8. Właściciel geometrii, materiału i portów

`PhysicsObjectIR` oraz wspólny system geometrii/mesha są jedynymi właścicielami bodies i
topologii. `ObjectMaterialAssignmentIR` pozostaje właścicielem przypisań materiałowych.
`AntennaPortModeIR` przechowuje wyłącznie stabilne referencje do obiektu, transportu i
terminali. Każda niezależna baza portowa tworzy osobny solve i osobny source/port ID.

#### 12.2.9. Kontrakt migracyjny

`CurrentModuleIR::AntennaFieldSource` pozostaje wyłącznie readerem migracyjnym. Legacy
`prescribed_zeeman_mask` migruje do `RegionalFieldDriveIR`, a legacy analityczna baza
może zostać opakowana w `antenna_field_solution.v1` z jednoznacznym
`realization=legacy_infinite_uniform_strip_biot_savart.v1`. Migracja nie tworzy
`CurrentTransport`, jeżeli stary dokument nie zawiera wystarczających danych fizycznych.

### 12.2.A. Odrzucony wariant równoległego modelu — materiał historyczny

Poniższe dawne szkice `MicrowaveConductorSourceIR`, lokalnego layoutu, materiału i
solver-specific field solve **nie są planem implementacji**. Pozostają wyłącznie jako
zapis odrzuconej alternatywy i lista wymagań, które należy mapować na wspólnych
właścicieli. Nie wolno tworzyć tych typów ani kopiować do nich geometrii, materiałów,
transportu lub operatorów Oersteda.

#### 12.2.A.1. Odrzucony `MicrowaveConductorSourceIR`

```rust
pub struct MicrowaveConductorSourceIR {
    pub schema_version: String,
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub frame: RigidFrameIR,
    pub geometry: ConductorLayoutIR,
    pub materials: Vec<ConductorMaterialIR>,
    pub ports: Vec<ConductorPortIR>,
    pub electromagnetic_environment: ElectromagneticEnvironmentIR,
    pub default_field_solve: Option<AntennaFieldSolveSettingsIR>,
}
```

Wymagania:

- `id` stabilne, niezmienne przy rename;
- `frame` jawna;
- `geometry` odwołuje się do stabilnych body IDs;
- każda część przewodnika ma materiał;
- porty odwołują się do terminal selectors;
- walidacja connectivity.

#### 12.2.A.2. Odrzucony lokalny `RigidFrameIR`

```rust
pub struct RigidFrameIR {
    pub origin_m: [f64; 3],
    pub axis_u: [f64; 3],
    pub axis_v: [f64; 3],
    pub axis_w: [f64; 3],
    pub normalization_version: String,
}
```

Walidacja:

```{math}
:label: eq-merged-146

\|\mathbf e_u\|=\|\mathbf e_v\|=\|\mathbf e_w\|=1,
```

```{math}
:label: eq-merged-147

\mathbf e_i\cdot\mathbf e_j=0,
```

```{math}
:label: eq-merged-148

\det[\mathbf e_u,\mathbf e_v,\mathbf e_w]=+1.
```

Można również przechowywać quaternion + translation, ale resolved IR powinien zawierać macierz.

#### 12.2.A.3. Odrzucony `ConductorLayoutIR`

```rust
pub enum ConductorLayoutIR {
    StraightStrip {
        signal_body: String,
        return_bodies: Vec<String>,
    },
    Cpw {
        signal_body: String,
        ground_bodies: Vec<String>,
    },
    Microstrip {
        signal_body: String,
        ground_plane_body: String,
        dielectric_body: Option<String>,
    },
    ArbitraryBodies {
        body_ids: Vec<String>,
    },
}
```

Preset tworzy geometrię; solver zawsze widzi jawne bodies.

#### 12.2.A.4. Odrzucony `ConductorMaterialIR`

```rust
pub struct ConductorMaterialIR {
    pub body_id: String,
    pub conductivity_s_per_m: MaterialLawComplexScalarIR,
    pub relative_permeability: MaterialLawComplexTensorIR,
    pub relative_permittivity: MaterialLawComplexTensorIR,
    pub temperature_k: Option<f64>,
}
```

Tier 1 może wymagać tylko realnego $\sigma$. Typ jest rozszerzalny częstotliwościowo.

#### 12.2.A.5. Odrzucony `ConductorPortIR`

```rust
pub struct ConductorPortIR {
    pub id: String,
    pub name: String,
    pub terminals: Vec<PortTerminalIR>,
    pub excitation: PortExcitationBasisIR,
    pub reference_impedance_ohm: Option<f64>,
}
```

```rust
pub struct PortTerminalIR {
    pub id: String,
    pub boundary_selector: SelectionRefIR,
    pub signed_current_weight: f64,
}
```

Walidacja:

```{math}
:label: eq-merged-149

\sum_q c_q=0.
```

Dla bazy 1 A:

```{math}
:label: eq-merged-150

I_q=c_q\cdot1\ \mathrm A.
```

#### 12.2.A.6. Odrzucony autonomiczny `AntennaFieldSolveIR`

Jawny node pipeline:

```rust
pub struct AntennaFieldSolveIR {
    pub schema_version: String,
    pub id: String,
    pub source_id: String,
    pub realization: AntennaFieldRealizationIR,
    pub frequencies_hz: Vec<f64>,
    pub current_mesh: ConductorMeshSettingsIR,
    pub electromagnetic_domain: Option<ElectromagneticDomainIR>,
    pub sampling_domains: Vec<FieldSamplingDomainIR>,
    pub requested_outputs: Vec<AntennaFieldOutputIR>,
    pub solver_tolerances: AntennaSolverTolerancesIR,
}
```

#### 12.2.A.7. Odrzucony równoległy `AntennaFieldRealizationIR`

```rust
pub enum AntennaFieldRealizationIR {
    LegacyInfiniteUniformStripBiotSavart {
        formula_version: String,
    },
    Conduction3dBiotSavart {
        conduction_version: String,
        flux_reconstruction: String,
        field_integrator: String,
    },
    MqsAphi3dHarmonic {
        formulation_version: String,
        gauge: GaugeIR,
        open_boundary: OpenBoundaryIR,
    },
    MqsAu2p5dHarmonic {
        formulation_version: String,
        invariant_axis: AxisIR,
        open_boundary: OpenBoundaryIR,
    },
    FullWave3d {
        formulation_version: String,
        port_model: String,
        open_boundary: OpenBoundaryIR,
    },
}
```

#### 12.2.A.8. Starszy szkic `SolvedAntennaDriveIR`

```rust
pub struct SolvedAntennaDriveIR {
    pub schema_version: String,
    pub id: String,
    pub name: String,
    pub solution_asset_id: String,
    pub port_drives: Vec<PortDriveIR>,
    pub target: FieldTargetIR,
    pub activation: DriveActivationIR,
    pub time_origin: FieldTimeOriginIR,
}
```

```rust
pub struct PortDriveIR {
    pub port_id: String,
    pub waveform: TimeDependenceIR,
    pub scale_a: f64,
    pub phase_rad: Option<f64>,
}
```

Dla Tier 2 waveform broadband wymaga osobnego kontraktu częstotliwościowego; nie wolno interpolować jednej bazy poza zakresem ważności.

#### 12.2.A.9. Starszy szkic `AntennaExcitationAnalysisIR`

```rust
pub struct AntennaExcitationAnalysisIR {
    pub schema_version: String,
    pub id: String,
    pub source_solution_asset_id: String,
    pub port_combination: Vec<ComplexPortWeightIR>,
    pub target: AnalysisTargetIR,
    pub transform: WavevectorTransformIR,
    pub field_component: AntennaSpectrumComponentIR,
    pub equilibrium_asset_id: Option<String>,
    pub mode_asset_id: Option<String>,
    pub outputs: Vec<AntennaAnalysisOutputIR>,
}
```

Outputs:

- raw vector spectrum;
- transverse spectrum;
- circular spectra;
- local spectrum;
- mode overlap;
- susceptibility-weighted coupling;
- recommended $k$ bands under explicit threshold.

---

### 12.3. Artefakt `antenna_field_solution.v1`

### 12.3.1. Manifest

Przykład normatywny:

```json
{
  "schema": "antenna_field_solution.v1",
  "asset_id": "afs_01J...",
  "source_id": "antenna_01J...",
  "created_from_commit": "7aeaf2e...",
  "realization": {
    "kind": "conduction_3d_biot_savart",
    "version": "1.0.0"
  },
  "phase_convention": "exp(-i*omega*t)",
  "reference": {
    "port_current_a": 1.0
  },
  "frequencies_hz": [0.0],
  "ports": [
    {
      "port_id": "port_01J...",
      "terminal_current_weights": [1.0, -0.5, -0.5]
    }
  ],
  "current_solution_signature": "sha256:...",
  "field_solution_signature": "sha256:...",
  "target_projection_signatures": {
    "magnet_01J...": "sha256:..."
  },
  "arrays": {
    "potential": "zarr://potential",
    "current_density": "zarr://current_density",
    "field_basis_airbox": "zarr://field_basis/airbox",
    "field_basis_targets": {
      "magnet_01J...": "zarr://field_basis/targets/magnet_01J..."
    }
  },
  "units": {
    "potential": "V/A",
    "current_density": "A/m^2/A",
    "field_basis": "A/m/A"
  },
  "diagnostics": {
    "current_balance_relative": 2.1e-11,
    "linear_residual": 4.2e-12,
    "joule_power_w_per_a2": 8.7,
    "ampere_loop_error_max": 3.0e-5,
    "field_quadrature_error_estimate": 1.2e-4
  },
  "validity": {
    "skin_parameter_max": 0.08,
    "wave_parameter": 0.01,
    "warnings": []
  }
}
```

### 12.3.2. Tablice

Minimalne tablice:

- mesh przewodnika;
- `V` lub $\phi$;
- $\mathbf J$;
- baza $\mathbf H$ per port;
- opcjonalnie $\mathbf A,\mathbf E,\mathbf B$;
- domain descriptors;
- target maps.

Dla pól zespolonych:

- real/imag jako osobne arrays albo complex dtype z jednoznaczną serializacją;
- wymiar częstotliwości;
- wymiar portu;
- wymiar punktu;
- ostatni wymiar 3.

Przykład shape:

```text
H_basis[frequency, port, point, component]
```

### 12.3.3. Immutable i content-addressed

Asset po utworzeniu jest immutable. Zmiana wejścia tworzy nowy asset. To:

- upraszcza cache;
- umożliwia reprodukcję;
- pozwala porównać rozwiązania;
- eliminuje stany częściowo zaktualizowane.

---

(round-trip-and-failure-semantics)=
### 12.4. Podpisy zależności, round-trip i failure semantics

Round-trip musi zachować **requested intent**: model fizyczny, layout, porty,
targety, żądany lane, precision, częstotliwość, waveform i politykę
aproksymacji. Planner zapisuje osobno **resolved execution**: faktyczny solver,
backend, urządzenie, wersję realizacji, użyty artefakt oraz powód każdej legalnej
degradacji. Eksport Python nie może odtwarzać resolved execution zamiast intencji
użytkownika.

Validation errors powstają przed planning dla niezamkniętego obwodu, błędnych
terminali, nieskończonych wartości, zerowego prądu referencyjnego, niezgodnych
jednostek i brakującego targetu. Unsupported combinations — przykładowo full-3D
solve na nieistniejącym lane GPU albo solved-basis consumption na
niezakwalifikowanym FEM GPU — kończą się stabilnym kodem capability i nie mogą
uruchomić hidden fallback. Requested i resolved provenance pozostają osobnymi
polami manifestu nawet wtedy, gdy są identyczne.

### 12.4.1. `current_solution_signature`

Zależy od:

- geometrii przewodnika;
- transformacji;
- materiałów;
- portów;
- terminali;
- current mesh;
- częstotliwości dla Tier 2/3;
- solver realization/version;
- tolerancji wpływających na rozwiązanie;
- precision;
- build/provenance.

Nie zależy od:

- target mesh;
- waveform amplitude;
- czasu;
- ustawień viewportu;
- equilibrium magnetization.

### 12.4.2. `field_solution_signature`

Zależy od:

- current solution signature;
- field integrator;
- electromagnetic domain dla PDE;
- airbox sampling domain;
- field quadrature;
- requested field outputs.

### 12.4.3. `target_projection_signature`

Zależy od:

- field solution signature;
- target topology/generation ID;
- target coordinates;
- interpolation/projection realization;
- target mask/region selector;
- point vs cell average;
- precision.

### 12.4.4. Dalsze podpisy analityczne

`source_spectrum_signature` zależy dodatkowo od:

- target analizy;
- okna;
- osi;
- spacing;
- FFT convention;
- komponentu;
- port weights.

`transverse_spectrum_signature` zależy dodatkowo od equilibrium asset.

`mode_overlap_signature` zależy dodatkowo od mode asset i normalizacji.

---

## 13. Quantity, data plane i API

### 13.1. Zasada

Nie tworzyć statycznego wpisu katalogowego dla każdej anteny. Katalog opisuje rodzinę quantity; tożsamość źródła jest zakresem zasobu.

### 13.2. Canonical quantities

### Fizyczne pole właściciela Oersteda

```text
H_oe
```

- A/m;
- vector;
- canonical pole wytworzone przez ogólny stos prąd → Oersted;
- payload źródłowy dla antenowego assetu i projekcji;
- nie jest liczone ponownie przy utworzeniu widoku `H_ant_basis`.

### Pole całkowite

```text
H_ant
```

- A/m;
- vector;
- suma wszystkich aktywnych solved antenna drives;
- target LLG lub wybrana domena obserwacyjna.

### Pole per źródło

```text
H_ant
scope_kind=source
source_ref=<source_uuid>
```

### Pole per port

```text
H_ant_basis
scope_kind=source_port
source_ref=<source_uuid>
port_ref=<port_uuid>
```

Jednostka:

```text
A/m/A
```

`H_ant_basis` jest source/port-scoped, znormalizowanym widokiem tego samego fizycznego
payloadu `H_oe`, a nie drugim solve'em ani niezależną kopią pola. Descriptor musi zawierać:

```text
quantity_id=H_ant_basis
derived_from_quantity=H_oe
solution_id=<solution_uuid>
source_ref=<source_uuid>
port_mode_ref=<port_mode_uuid>
normalization=per_1A
payload_ref=<shared immutable array/chunk reference>
```

Pole chwilowe jest liniową kombinacją baz:

```{math}
:label: eq-antenna-quantity-lineage

\mathbf H_{\mathrm{ant}}(\mathbf r,t)
=
\sum_p I_p(t)\,\mathbf H_{\mathrm{ant,basis},p}^{(1\mathrm A)}(\mathbf r).
```

Jedna alokacja może być współdzielona przez deskryptory `H_oe` i `H_ant_basis`, jeżeli
carrier, domena, normalizacja i lifetime są identyczne. W innym przypadku wolno utworzyć
projekcję, ale jej lineage i digest źródła muszą pozostać jawne; nie wolno ponownie
rozwiązywać pola tylko po to, aby zmienić quantity ID.

### Pole chwilowe per źródło

Pozostaje tym samym `quantity_id=H_ant`, z `source_ref=<source_uuid>` i
`realization=instantaneous`. Jednostką jest A/m po zastosowaniu waveformu.

### Pochodne display

Nie są to osobne canonical IDs. Descriptor pola zawiera
`unit_transform=mu0_H_to_B` oraz jednostkę wyświetlania T albo mT; dla bazy
portowej analogiczna transformacja ma jednostkę T/A.

Nie należy dublować pamięci. Są to transformacje quantity:

```{math}
:label: eq-merged-151

\mu_0H.
```

### Rozwiązanie elektromagnetyczne

```text
V_ant
J_ant
A_ant
E_ant
B_ant_em
```

Z dostępnością zależną od realization.

### 13.3. Użytkowe `b_zeeman_antena_1`

Rekomendowany mapping UI:

```text
Display label: B Zeeman — Antenna 1
Canonical field: H_ant
source_ref: <source_uuid>
unit_transform: mu0_H_to_B
Preferred unit: mT
```

Opcjonalny, czytelny alias eksportowy:

```text
b_zeeman_antenna_<short_id>
```

Nie używać numeru jako jedynej tożsamości.

### 13.4. Carrier i domeny

Field resource powinien zawierać:

- `carrier_kind=structured_grid | fem_mesh | point_cloud`;
- `domain_role=field_airbox | magnetic_target | conductor`;
- `topology_id`;
- `generation_id`;
- `coordinate_frame`;
- `active_mask`;
- `time_s` lub `frequency_hz`;
- `source_id`;
- `port_id`;
- `solution_asset_id`.

### 13.5. Pola zespolone

Dla Tier 2/3 endpoint powinien wspierać:

```text
representation=real
representation=imag
representation=amplitude
representation=phase
representation=phasor
```

Phase requires:

- wrap range;
- zero-amplitude mask;
- phase convention;
- reference port phase.

Viewport może animować:

```{math}
:label: eq-merged-152

\mathbf H(\mathbf r,t)
=
\Re\{
\widehat{\mathbf H}e^{-i\omega t}
\}.
```

### 13.6. Proponowane zasoby API

Rodziny zasobów, względne wobec canonical session-scoped `/v2` mount:

```text
model/antennas
simulation/stages/{stage_id}/antenna-field-solve/plan
simulation/stages/{stage_id}/antenna-field-solve/progress
simulation/stages/{stage_id}/antenna-field-solve/diagnostics
data/antenna-field-solutions/{solution_id}
data/antenna-field-solutions/{solution_id}/projections
data/fields/H_ant?source_ref=...
data/fields/H_ant_basis?source_ref=...&port_ref=...
analysis/antenna-excitation/{solution_id}/source-spectrum
analysis/antenna-excitation/{solution_id}/local-k-spectrum
```

Ciężkie $V$, $\mathbf J$, $\mathbf H$ i rastry widm należą do data plane z ETag
i revision. HTTP v2 jest źródłem prawdy; WebSocket publikuje lifecycle,
command completion i invalidation. Dokładny URL zostaje wygenerowany z
zatwierdzonego OpenAPI, a komponenty nie mogą konstruować go ręcznie.

### 13.7. Statusy

Każdy field solve i analysis:

```text
missing
planned
queued
running
ready
stale
failed
unsupported
```

`stale` musi zawierać listę przyczyn:

```json
{
  "status": "stale",
  "reasons": [
    "source_geometry_changed",
    "target_mesh_generation_changed"
  ],
  "reusable_parts": [
    "current_solution"
  ]
}
```

### 13.8. Streaming i pamięć

Dla dużych pól:

- chunked Zarr;
- range requests;
- decimation server-side;
- slice/ROI;
- component selection;
- quantization tylko dla preview;
- full precision export oddzielnie.

Nie wolno materializować całego pola 3D w JSON.

---

## 14. Docelowy frontend i drzewo obiektów

### 14.1. Rozdział kategorii

```text
Physics
├── Magnetization
├── Interactions
├── Regional field drives
└── Microwave sources
```

### 14.2. Drzewo pojedynczej anteny

```text
Microwave source: antenna_1
├── Geometry
│   ├── Signal conductors
│   ├── Return conductors
│   ├── Dielectrics
│   └── Transform / local frame
├── Materials
├── Ports
│   ├── port_1
│   │   ├── signal terminal
│   │   ├── return terminals
│   │   └── reference/current convention
├── Field solve
│   ├── Settings
│   ├── Mesh
│   ├── Potential V
│   ├── Current density J
│   ├── H basis — port_1
│   ├── Airbox field
│   └── Diagnostics
├── Drives
│   └── rf_drive_1
│       ├── waveform
│       ├── amplitude
│       ├── phase
│       └── target magnets
├── Projections
│   ├── magnet_1
│   ├── region_2
│   └── fdm_grid_1
├── Quantities
│   ├── H_ant — source
│   ├── μ0H_ant — source
│   └── H_ant — total
└── Excitation analyses
    ├── Source k-spectrum
    ├── Local k-spectrum
    ├── Transverse/circular spectrum
    ├── Mode overlap
    └── Driven response S(k,f)
```

### 14.3. Panel Geometry

Musi pokazywać:

- typ layoutu;
- wymiary w SI i jednostkach użytkownika;
- transformację;
- lokalne osie z gizmo;
- conductor body list;
- connectivity;
- minimalne odległości;
- overlap/collision diagnostics;
- terminal face highlights.

Nie należy wyznaczać automatycznie wysokości z globalnego `meshTop` jako jedynej fizycznej definicji. Można zaoferować constraint „offset above object surface”, ale resolved transform musi być jawny.

### 14.4. Panel Ports

Musi wymagać:

- sygnału;
- wszystkich zwrotów;
- signed weights;
- bilansu zero;
- kierunku dodatniego prądu;
- referencji fazy;
- typu zasilania.

Jeżeli użytkownik podaje moc dBm, UI musi wyjaśnić, że przeliczenie na prąd wymaga modelu impedancji/portu. Tier 1 może przyjmować wyłącznie prąd dostarczony.

### 14.5. Panel Field solve

Musi jawnie pokazywać:

- realization i zakres ważności;
- częstotliwości;
- siatkę przewodnika;
- airbox EM, jeśli dotyczy;
- sampling domain;
- estimated memory;
- status;
- hash;
- solver residual;
- current balance;
- warnings skin/wave;
- przycisk `Solve`;
- przycisk `Invalidate/recompute`, jeśli polityka pozwala.

Przycisk `Compute antenna field` nie może jedynie przełączyć quantity, gdy brak rozwiązania.

### 14.6. Viewport

Tryby:

- conductor geometry;
- current-density glyphs/streamlines;
- field vectors;
- magnitude volume/slices;
- phase-colored phasor;
- airbox clipping planes;
- magnetic target overlay;
- source/port selector;
- total vs basis;
- instantaneous time slider;
- unit A/m, kA/m, $\mu$T, mT.

Dla pola zespolonego:

- Re;
- Im;
- amplitude;
- phase;
- time animation.

### 14.7. Panel Source $k$-spectrum

Wymagane kontrolki:

- source/port combination;
- target object/region;
- line/plane/volume;
- local frame;
- axis;
- extent;
- spacing;
- component: full, transverse, $h_1,h_2,h_+,h_-$;
- equilibrium selection;
- window;
- normalization;
- one-sided/two-sided;
- $k$ unit: rad/m, rad/$\mu$m, cycles/m;
- dB threshold;
- output artifact status.

Wyniki:

- amplitude/power;
- phase;
- peak table;
- zero table;
- effective bandwidth;
- $-3,-10,-20$ dB bands;
- resolution/Nyquist diagnostics;
- optional dispersion overlay.

### 14.8. Panel Mode overlap

Musi pokazywać:

- mode asset/revision;
- left/right normalization;
- frequency;
- raw overlap;
- normalized overlap, jeśli qualified;
- per-port phase;
- symmetry-forbidden indication;
- field/mode spatial overlay.

### 14.9. No hidden solve

Węzeł analizy:

- nie uruchamia automatycznie field solvera;
- pokazuje zależność `requires field solution`;
- może zaoferować jawny przycisk uruchamiający wymagany pipeline;
- po zmianie geometrii pokazuje `stale`.

---

(discrete-realization)=
## 15. Integracja i realizacja dyskretna backendów

### 15.1. Wspólny kontrakt runtime

Po rozwiązaniu pola wszystkie backendy powinny otrzymać ten sam logiczny obiekt:

```rust
pub struct RuntimeAntennaDrive {
    pub drive_id: DriveId,
    pub source_id: SourceId,
    pub target_projection: FieldProjectionHandle,
    pub port_bases: Vec<RuntimePortFieldBasis>,
    pub waveforms: Vec<ResolvedWaveform>,
    pub activation: ResolvedActivation,
    pub time_origin: ResolvedTimeOrigin,
}
```

Backend nie powinien znać geometrii przewodnika ani rozwiązywać jej ad hoc podczas LLG.

### 15.2. FDM CPU

Dla każdego target cell:

```{math}
:label: eq-merged-153

\mathbf H_i(t)
=
\sum_p I_p(t)\mathbf H_{p,i}.
```

Wymagane:

- cell-center albo cell-average realization;
- active magnetic mask;
- clipping targetu;
- per-region enable;
- output per source/total;
- deterministic summation order.

### 15.3. FDM CUDA

Plan:

1. upload baz po utworzeniu sesji;
2. przechowywanie device-resident;
3. scalar coefficients waveformu w małym bufferze;
4. fused kernel:
   ```{math}
:label: eq-merged-154

H_{\mathrm{eff},i}
   \mathrel{+}=
   \sum_p c_pH_{p,i};
```
5. ocena na każdym RK stage;
6. bez host roundtrip;
7. snapshot `H_ant` na żądanie;
8. single/double parity.

Dla wielu portów można traktować pole jako macierz $3N\times P$ i wykonywać batched linear combination.

### 15.4. FDM multilayer

Każda warstwa ma osobny target projection:

```text
layer_id
cell topology
coordinates
active mask
```

Pole fizyczne jest wspólne, ale próbki różnią się po $z$. Nie wolno kopiować pola jednej warstwy do innych bez ewaluacji.

### 15.5. FEM reference

Reference powinien:

- konsumować ten sam asset;
- używać P1 nodal projection jako pierwszej realizacji;
- opcjonalnie obsługiwać quadrature coefficient;
- stanowić oracle dla native;
- nie używać już geometrycznego kernelu bezpośrednio z `CurrentModuleIR`.

### 15.6. Native FEM CPU/GPU

Możliwe kontrakty ABI:

### Opcja A — packed basis arrays

Deskryptor:

```c
typedef struct {
    const double* h_basis_xyz;
    uint64_t node_count;
    uint32_t basis_count;
    const fullmag_waveform_desc* waveforms;
    ...
} fullmag_fem_antenna_drive_desc;
```

### Opcja B — asset/buffer handles

Lepsza dla dużych danych i GPU:

```text
register_field_basis(asset_handle)
bind_drive(field_basis_handle, waveform_handle, target_mask_handle)
```

Preferowana jest B, jeśli runtime ma stabilny resource manager.

### Operacje

- field basis allocation;
- host/device residency;
- stage-time coefficient update;
- accumulation into H_eff;
- energy `E_ant`;
- observable copy;
- revision tracking.

### 15.7. Target projection FEM

Dwie realizacje:

1. `nodal_p1_sample.v1`  
   Pole w węzłach, interpolowane przez basis P1.

2. `quadrature_l2_projection.v1`  
   Pole projektowane do współczynników/kwadratury używanej przez operator.

Pierwsza jest MVP i powinna być wspólna z obecnym reference. Druga zwiększa dokładność dla silnie niejednorodnego pola.

### 15.8. Pole w airboxie

LLG potrzebuje pola tylko na aktywnych magnetycznych DOF. Wizualizacja airboxu jest osobnym carrierem. Backend LLG nie powinien przechowywać całego airboxu na GPU, jeśli nie jest potrzebny.

### 15.9. Determinizm i kolejność sumowania

Dla wielu źródeł:

- stabilna kolejność po source UUID/port UUID;
- compensated summation w reference, jeżeli potrzebna;
- jawna tolerancja CPU/GPU;
- brak zależności od kolejności w drzewie UI.



---

## 16. Produkcyjny plan wdrożenia

### 16.1. Krytyczna ścieżka

Rekomendowana kolejność:

```text
P0 hardening legacy
→ P1 canonical contracts
→ P2 field-solve asset pipeline
→ P3 conductor geometry/ports/mesh
→ P4 DC conduction
→ P5 Biot–Savart field basis
→ P6 projections + LLG consumers
→ P7 quantities/API/UI
→ P8 source k-spectrum
→ P9 mode/response coupling
→ P10 harmonic MQS
→ P11 performance qualification
→ P12 migration/release
```

Nie należy rozpoczynać pełnego UI FFT przed ustaleniem:

- stable source IDs;
- field solution asset;
- per-source quantity;
- transform convention;
- target projection.

---

### P0 — natychmiastowe utwardzenie implementacji legacy

### Cel

Usunąć błędy mogące generować jawnie niepoprawne lub cicho nieaktywne wyniki, zanim powstanie nowa architektura.

### Zakres

1. Naprawić błąd `zip`/indeksowania.
2. Wprowadzić stabilne `source_id` co najmniej w resolved runtime.
3. Nazwać realizację legacy zgodnie z fizyką.
4. Zdefiniować kierunek dodatniego prądu.
5. Wersjonować znak formuły.
6. Zablokować nieobsługiwane backendy.
7. Skorygować aktywację quantity.
8. Dodać testy analityczne.
9. Usunąć mylące etykiety UI.
10. Wygenerować proweniencję ostrzegającą o nieskończonym przewodniku.

### Konkretne zmiany

#### `crates/fullmag-runner/src/antenna_fields.rs`

- zastąpić `Vec<Vec<[f64;3]>>` przez typed basis records;
- nie łączyć filtrowanych list przez `zip`;
- dodać:
  ```rust
  enum LegacyCurrentAxis { PositiveY, NegativeYLegacy }
  ```
  albo lepiej `formula_version`;
- rozdzielić funkcję line-current oracle od integracji przekroju;
- usunąć magiczne `_y_center`, jeśli jest celowo ignorowane, lub oznaczyć warningiem;
- publikować diagnostykę ignored parameters;
- kontrolować skończoność i overflow.

#### IR/validation

- walidować niezerowy prąd reference;
- zapisać `realization_version`;
- odrzucać nieobsługiwane current distributions zamiast przyjmować string;
- dodać capability error dla native/FDM.

#### Quantity

- aktywować `H_ant` na podstawie rzeczywistego materializer;
- odróżnić `current_transport` od antenna source.

#### UI

- zmienić `2.5D MQS (Az)` na `Legacy infinite-strip Biot–Savart`;
- etykietę osi wyprowadzać z konwencji rozwiązania;
- pokazać:
  ```text
  Infinite along local current axis; length is visual only.
  ```

### Testy

1. Dodatni prąd $+\mathbf e_y$, punkt nad/pod przewodnikiem.
2. Reguła prawej dłoni.
3. Odwrócenie prądu.
4. Spadek $1/r$.
5. Symetria:
   ```{math}
:label: eq-merged-155

H_x(x,z) = H_x(-x,z),\quad
   H_z(x,z)=-H_z(-x,z)
```
   dla paska centralnego.
6. Permutacje `current_modules`.
7. CPW:
   - net current zero;
   - symetria;
   - dalekie pole szybsze niż pojedynczy przewodnik.
8. Test native FEM fail-closed.
9. Test FDM CUDA fail-closed.
10. Test proweniencji.

### Kryterium wyjścia

- żaden backend nie może uruchomić legacy anteny bez jawnie zakwalifikowanej ścieżki;
- test znaku i permutacji przechodzi;
- UI nie używa nazwy MQS;
- każdy wynik zawiera `legacy...v0/v1`.

---

### P1 — composition-first contracts

**Cel:** zbudować cienki, canonical contract antenowy z referencji do istniejących
właścicieli, bez kopiowania ich danych i bez drugiego solvera.

**Prace:**

1. Użyć `PhysicsObjectIR::Antenna` albo `PhysicsObjectIR::Conductor` jako stabilnej
   tożsamości źródła.
2. Powiązać obiekt z istniejącym `GeometryIR` i `ObjectMaterialAssignmentIR`.
3. Dodać projektowany `AntennaPortModeIR`, zawierający wyłącznie referencje do
   `CurrentTransport` i jego terminal selectors oraz signed branch weights.
4. Dodać projektowane `AntennaFieldSolveStageIR`, `AntennaFieldSolutionRefIR`,
   `AntennaTargetProjectionRefIR`, `SolvedAntennaDriveIR` i
   `AntennaSpectrumRequestIR`.
5. Zachować `RegionalFieldDriveIR` jako osobny produkt pola zadanego.
6. Pozostawić `CurrentModuleIR::AntennaFieldSource` wyłącznie jako wersjonowany reader
   migracyjny; nowy authoring nie może go emitować.
7. Przeprowadzić Python/UI → ProblemIR → planner → export round-trip bez utraty ID,
   terminali, wag, jednostek i referencji.

**Weryfikacja:** testy serde i Python round-trip, snapshot schema, odrzucenie dangling
references, duplicate IDs, niezbilansowanych wag, niezgodnego rodzaju obiektu i
nieobsługiwanej wersji. Planowane typy pozostają opisane jako projekt do chwili obecności
symboli, testów i runtime receipts.

**Kryterium wyjścia:** jedna definicja geometrii, materiału i charge transportu; żadnego
`MicrowaveConductorSourceIR` kopiującego te dane; migracja legacy deterministyczna i
idempotentna.

---

### P2 — stage graph i immutable asset lifecycle

**Cel:** utworzyć jawny DAG `AntennaFieldSolveStage → AntennaTargetProjection →
SolvedAntennaDrive` oraz immutable `antenna_field_solution.v1`, początkowo opakowując
istniejące wyniki.

**Prace:**

1. Dodać zależności do source object, port mode, `CurrentTransport`, current-view identity,
   realizacji Oersteda i sampling targets.
2. Wprowadzić statusy planned/running/validated/published/failed/cancelled i brak hidden
   solve podczas LLG.
3. Opublikować asset atomowo: obszar tymczasowy → walidacja manifestu/tablic → content
   digest → immutable commit.
4. Zachować source-state revision, current-view identity digest, solver diagnostics,
   tolerancje, backend/device/precision, phase convention oraz commit/build provenance.
5. Dopuścić pierwsze adaptery dla legacy basis oraz istniejącego `H_oe`; adapter nie może
   zmieniać statusu kwalifikacji realizacji bazowej.
6. Cache'ować po kompletnym dependency signature i unieważniać po zmianie geometrii,
   materiału, terminali, transportu, realizacji lub sampling target.

**Weryfikacja:** testy deterministycznego signature, cache hit/miss, atomic publish,
crash/cancel cleanup, odmowy mutacji assetu, import/export i wykrycia uszkodzonego
digestu.

**Kryterium wyjścia:** LLG konsumuje wyłącznie opublikowaną referencję/projekcję; żadna
ścieżka nie rozwiązuje pola niejawnie w hot loop.

---

### P3 — geometria, terminale i port-mode binding na wspólnym meshu

**Cel:** zbudować deterministyczne wiązanie źródła i portów bez osobnego meshera
antenowego.

**Prace:**

1. Wyznaczyć conductor domain z `PhysicsObjectIR` i wspólnej geometrii.
2. Związać surface selectors z terminalami istniejącego `CurrentTransport`.
3. Sprawdzić orientację normalnych, connectivity każdego terminala, rozłączność terminali,
   return path i zgodność z material assignment.
4. Zdefiniować signed branch weights z sumą zerową oraz jednoznaczną dodatnią orientację
   prądu.
5. Dla każdej liniowo niezależnej bazy portowej utworzyć osobny solve, stabilne
   `source_id`/`port_mode_id` i osobny certyfikat bilansu.
6. Użyć pełnego 3D conductor/current solve dla taperów i przewężeń; 2.5D nie może być
   realizacją produkcyjną geometrii zmiennej wzdłuż przepływu.

**Weryfikacja:** testy disconnected conductor, missing/overlapping terminal, brak return
path, odwrócenie orientacji, permutacja bodies, wiele portów, CPW, taper 3D oraz mesh
refinement.

**Kryterium wyjścia:** planner potrafi wykazać, które dokładnie domeny, terminale i mesh
zasilają każdą bazę; nie ma niejawnego wyboru powierzchni ani osi.

---

### P4 — charge-only `CurrentTransport` i normalizacja portowa per 1 A

**Cel:** usunąć zależność solved-current Oersted od `SpinDriftDiffusion` i wykorzystać
istniejący charge solve jako właściciela prądu anteny.

**Prace:**

1. Zmienić planner tak, aby kompletna `ChargeTransportDefinitionIR` mogła samodzielnie
   opublikować `V_electric`, `J_charge`, `ResolvedFemConservativeCurrentViewIR` i `H_oe`.
2. Nie tworzyć sztucznego transportu spinowego. `SpinDriftDiffusion` pozostaje potrzebny
   tylko dla spin accumulation, torque'u i jawnego sprzężenia zwrotnego.
3. Użyć istniejącego `ConservativeCurrentView` RT0/$H(\mathrm{div})$; nie implementować
   drugiej rekonstrukcji prądu.
4. Zmierzyć signed terminal currents z konserwatywnego widoku, sprawdzić bilans globalny i
   lokalny oraz utworzyć certyfikat z tolerancją i residualem.
5. Znormalizować każdą bazę przez zmierzony prąd odniesienia:
   $\mathbf J_p^{(1\mathrm A)}=\mathbf J_p/I_p$ i wymagać $I_p\neq0$ ponad progiem
   numerycznym.
6. Zachować current-view identity digest, source-state revision, precision i solver
   receipts; odrzucać niezgodną lub przeterminowaną referencję.

**Weryfikacja:** charge-only pozytywny, charge+spin regresyjny, brak spin module w eksporcie,
bilans terminali, skalowanie liniowe napięcie/prąd, odwrócenie znaku, zero-current failure,
mesh convergence i deterministyczny digest.

**Kryterium wyjścia:** metaliczna antena bez fizyki spinowej publikuje `V_electric`,
`J_charge`, `ConservativeCurrentView` i `H_oe`; baza jest certyfikowana dokładnie per 1 A.

---

### P5 — istniejący Oersted → `antenna_field_solution.v1`

**Cel:** opakować istniejący łańcuch
`CurrentTransport → ConservativeCurrentView → DirectTetraQuadrature |
VectorPotentialSolver` w audytowalny produkt pola antenowego.

**Prace:**

1. Wybierać istniejącą realizację Oersteda przez planner/capability, bez nowych
   `conduction_reference`, `current_reconstruction`, `biot_savart_reference` ani
   `biot_savart_accelerated`.
2. Traktować `DirectTetraQuadrature` jako bounded singular-aware CPU-double oracle i
   `VectorPotentialSolver` jako bounded reference. Żaden z nich nie uzyskuje statusu
   production bez pełnych receipts.
3. Próbkować bazę per 1 A na Airbox/inspection, FEM target i FDM target; zachować carrier,
   topology, coordinate frame i aktywną maskę.
4. Publikować source/port-scoped manifest, `H_oe` lineage, diagnostics operatora,
   oszacowanie błędu, current certificate oraz immutable content hash.
5. Dla małych układów porównać direct oracle i vector-potential; osobno sprawdzić przewód
   prosty, pętlę, CPW, near-field singular cases, $1/r$, prawo Ampère'a i zbieżność.
6. Zachować harmoniczne $A-\phi$ jako późniejszą, odrębnie kwalifikowaną realizację, a nie
   przemianować na nią istniejącego `VectorPotentialSolver`.

**Weryfikacja:** oracle-vs-vector-potential z jawnie ustalonymi normami i tolerancjami,
manufactured/analytic cases, refinement, sign/unit tests, content-addressing, projection
parity i fail-closed dla niezakwalifikowanego lane'u.

**Kryterium wyjścia:** jeden fizyczny solve Oersteda produkuje immutable asset oraz widoki
quantity; brak podwójnej alokacji/ewaluacji `H_oe` i `H_ant_basis`; capability status jest
potwierdzony dowodem runtime, nie obecnością kodu.

---

### P1-H — odrzucony wcześniejszy plan równoległych kontraktów (archiwalny)

Ta sekcja i kolejne P2-H–P5-H są zachowane jako historia scalenia raportów. Nie są
wykonywalnym planem. W razie konfliktu normatywne są P1–P5 powyżej.

### Cel

Zastąpić przeciążone `CurrentModuleIR::AntennaFieldSource` trzema rozłącznymi pojęciami:

- conductor source;
- solved field drive;
- regional prescribed field.

### Prace

1. Utworzyć dedykowany moduł IR:
   ```text
   crates/fullmag-ir/src/microwave_source.rs
   ```
2. Dodać typy z rozdziału 12.
3. Przenieść `RegionalFieldDriveIR` do własnego modułu, zachowując serde compatibility.
4. Dodać stable IDs dla:
   - source;
   - conductor body;
   - port;
   - terminal;
   - field solve;
   - drive;
   - analysis.
5. Zastąpić stringowe `solver` i `current_distribution` enumami wersjonowanymi.
6. Dodać local frame.
7. Dodać explicit returns.
8. Dodać model material law.
9. Dodać schema versions i `deny_unknown_fields`.
10. Zdefiniować pełny error vocabulary.

### Migracja

Legacy:

```json
{
  "kind": "antenna_field_source",
  "model": "mqs_2p5d_az"
}
```

migruje do:

```json
{
  "kind": "microwave_conductor_source",
  "migration": {
    "from": "antenna_field_source.mqs_2p5d_az",
    "resolved_realization": "legacy_infinite_uniform_strip_biot_savart.v0"
  }
}
```

Maska:

```json
{
  "model": "prescribed_zeeman_mask"
}
```

migruje do `RegionalFieldDriveIR`.

Migracja musi być:

- deterministyczna;
- idempotentna;
- wersjonowana;
- odwracalna na poziomie archiwalnego source JSON, niekoniecznie nowego authoring modelu.

### Python API

Nowe klasy:

```python
MicrowaveConductorSource
ConductorPort
PortTerminal
AntennaFieldSolve
SolvedAntennaDrive
AntennaExcitationAnalysis
```

Presety:

```python
StraightStripPreset
CpwPreset
MicrostripPreset
```

Preset zwraca jawne bodies i porty.

### Frontend authoring

Control-room musi przechowywać tę samą strukturę, nie lokalny alternatywny model.

### Testy

- serde roundtrip Rust;
- Python roundtrip;
- authoring → IR → resolved IR;
- old fixture migration;
- duplicate ID;
- invalid frame;
- unbalanced current weights;
- missing return;
- terminal references;
- version rejection;
- unknown fields;
- snapshot schema.

### Kryterium wyjścia

- physical conductor i regional drive nie współdzielą jednego wariantu;
- żaden nowy kod nie używa nazwy `mqs_2p5d_az`;
- wszystkie stare sceny są odczytywalne z jawną proweniencją migracji.

---

### P2-H — odrzucony wcześniejszy stage i asset plan (archiwalny)

### Cel

Zbudować infrastrukturę, zanim pojawi się właściwy solver, tak aby nawet proste rozwiązanie legacy przechodziło przez docelowy przepływ.

### Prace planner/DAG

1. Dodać node:
   ```text
   AntennaFieldSolve
   ```
2. Dependency edges:
   - geometry;
   - materials;
   - ports;
   - current mesh;
   - EM domain;
   - sampling domains.
3. Dodać node:
   ```text
   AntennaTargetProjection
   ```
4. Dodać node:
   ```text
   SolvedAntennaDrive
   ```
5. Wymusić brak hidden solve.
6. Dodać stage statuses i cancellation.
7. Dodać cache lookup po signature.

### Storage

1. Manifest `antenna_field_solution.v1`.
2. Chunked arrays.
3. Atomic publish:
   - temp;
   - validation;
   - commit manifest.
4. Partial failure cleanup.
5. Content hashes.
6. Read-only asset handle.
7. Export/import.

### API

- create solve;
- inspect plan;
- start/cancel;
- status;
- diagnostics;
- list assets;
- delete unreferenced asset;
- fetch field resources.

### Pierwsza realizacja

Na tym etapie można opakować legacy kernel w artefakt, aby przetestować cały lifecycle. Artefakt musi wyraźnie deklarować legacy realization.

### Staleness

Zaimplementować trzy podpisy:

- current;
- field;
- projection.

Testy muszą wykazać:

- zmiana waveformu nie unieważnia bazy;
- zmiana prądu amplitudowego nie unieważnia bazy 1 A;
- zmiana target mesh unieważnia tylko projekcję;
- zmiana geometrii unieważnia wszystko;
- zmiana equilibrium unieważnia tylko transverse/mode analysis;
- zmiana częstotliwości Tier 2 unieważnia current/field.

### Kryterium wyjścia

- pole legacy może być obliczone, zapisane, ponownie użyte i zwizualizowane bez ad hoc recompute;
- restart sesji zachowuje asset;
- stale state jest poprawnie wykrywany;
- artefakt ma pełną proweniencję.

---

### P3-H — odrzucony wcześniejszy plan osobnej geometrii/meshingu (archiwalny)

### Cel

Umożliwić fizyczny, zamknięty obwód 3D niezależny od siatki magnetycznej.

### Geometrie MVP

1. Straight strip + explicit return strip/plane.
2. Symmetric CPW.
3. Asymmetric CPW.
4. Microstrip z ground plane.
5. Tapered strip.
6. Arbitrary imported conductor bodies.

### Wymagania geometrii

- body identity;
- manifold/closed conductor volume;
- brak self-intersections;
- terminal faces na zewnętrznej granicy;
- connectivity graph;
- minimal thickness;
- overlap detection;
- local frame;
- transform covariance.

### Meshing

Conductor mesh jest oddzielny od:

- FEM magnet mesh;
- FDM grid;
- demag airbox;
- field sampling grid.

Ustawienia:

- element size;
- curvature;
- terminal refinement;
- edge refinement;
- constriction refinement;
- boundary layer dla Tier 2;
- mesh order;
- quality thresholds.

### Terminal selectors

Mają działać na stabilnych markerach/facet IDs. Nie opierać się na kolejności elementów.

### Walidacja topologiczna

- każdy terminal należy do conductor body;
- każda ścieżka signal-return jest połączona;
- brak floating conductor, chyba że jawnie dozwolony;
- suma prądów zero;
- terminale nie nakładają się;
- current path istnieje.

### UI

- geometry presets;
- gizmo;
- terminal face picking;
- current arrows;
- return path preview;
- mesh preview;
- validity diagnostics.

### Testy

- translation/rotation invariance;
- units scaling;
- CPW symmetry;
- taper;
- imported mesh;
- terminal marker persistence po remesh;
- invalid disconnected return;
- collision;
- ultra-thin geometry error;
- deterministic mesh signature.

### Kryterium wyjścia

- każda antena MVP ma jawnie zamkniętą drogę prądu;
- conductor mesh powstaje niezależnie;
- porty zachowują identity po rebuildzie.

---

### P4-H — odrzucony plan drugiego solvera 3D DC conduction (archiwalny)

### Cel

Obliczyć konserwatywny rozkład prądu 3D per port, znormalizowany do 1 A.

### Implementacja referencyjna

Rekomendowane miejsce:

```text
crates/fullmag-runner/src/antenna/conduction_reference.rs
```

lub native FEM subsystem, ale z czystym kontraktem Rust.

Etapy:

1. assembly P1 conductivity operator;
2. equipotential terminal constraints;
3. gauge;
4. current-driven RHS;
5. linear solve;
6. terminal current evaluation;
7. H(div)/RT0 flux reconstruction;
8. normalization;
9. diagnostics;
10. artifact publish.

### Solver

- SPD przy odpowiedniej redukcji;
- CG + AMG dla dużych układów;
- sparse direct oracle dla małych;
- jawna tolerancja relative/absolute;
- no silent convergence.

### Materiały

MVP:

- scalar positive $\sigma$;
- piecewise constant per body.

Następnie:

- anisotropic tensor;
- temperature law;
- contact resistance/interface.

### Multiport

Dla $P$ niezależnych portów:

- rozwiązać $P$ baz;
- wykorzystać wspólną macierz/preconditioner;
- terminal conductance matrix;
- sprawdzić reciprocity/symmetry dla liniowego układu.

### Diagnostyka

- residual;
- terminal currents;
- balance;
- power;
- resistance matrix;
- local divergence;
- flux reconstruction error;
- mesh quality;
- condition estimate.

### Testy fizyczne

1. Prostopadłościenny rezystor:
   ```{math}
:label: eq-merged-156

R=\rho L/A.
```
2. Jednorodne pole potencjału.
3. Dwa materiały w szeregu.
4. Dwa materiały równolegle.
5. Taper — zbieżność.
6. Symetryczny CPW — symetria prądu DC.
7. Current reversal.
8. Multiport superposition.
9. Gauge invariance.
10. Mesh convergence P1.
11. Local conservation RT0.
12. CPU determinism.

### Kryterium wyjścia

- current balance poniżej ustalonego gate;
- zbieżność względem siatki;
- moc terminalowa i Joule’a zgodna;
- artifact `J_ant` i `V_ant` dostępny.

---

### P5-H — odrzucony plan drugiego operatora 3D Biot–Savarta (archiwalny)

### Cel

Zamienić zakwalifikowany $\mathbf J$ na pole per port w dowolnych domenach.

### Reference integrator

1. Elementwise source representation.
2. Far/near/singular classification.
3. Adaptive quadrature.
4. Double precision.
5. Deterministic reduction.
6. Error estimate.

### Targety

- arbitrary point set;
- FDM cell centers;
- FEM nodes;
- regular airbox grid;
- line/plane;
- optional cell averages.

### Przyspieszenie

Dopiero po reference:

- SIMD CPU;
- Rayon/OpenMP;
- GPU direct;
- treecode/FMM.

Każdy accelerated path ma parity test.

### Diagnostyka

- estimated quadrature error;
- nearest source distance;
- max field;
- non-finite count;
- Ampère tests;
- divergence estimate on structured sampling;
- reference current.

### Field normalization

Artifact przechowuje:

```{math}
:label: eq-merged-157

\mathbf H_{p,1A}
```

oraz dokładny unit contract.

### Testy

1. Line current.
2. Circular loop na osi.
3. Rectangular cross-section benchmark.
4. Far-field magnetic dipole limit dla zamkniętej pętli.
5. Ampère loop.
6. Divergence-free w source-free region.
7. Translation/rotation covariance.
8. Current reversal.
9. Port superposition.
10. Near-singular convergence.
11. Target reorder invariance.
12. Direct vs accelerated.
13. FDM/FEM projection consistency.

### Kryterium wyjścia

- pole ma kontrolowany błąd;
- wszystkie symetrie i prawa całkowe przechodzą;
- per-port basis zapisuje się w asset;
- airbox i target magnetyczny są dostępne niezależnie.

---

### P6 — target projection i konsumpcja przez LLG

### Cel

Zapewnić identyczną semantykę dla FEM/FDM i CPU/GPU.

### Projection service

Nowy wspólny moduł:

```text
crates/fullmag-runner/src/antenna/projection/
```

Realizacje:

- point sample;
- FDM cell-center;
- FDM cell-average;
- FEM nodal P1;
- FEM quadrature/L2;
- regular-grid interpolation.

### Clipping

Pole fizyczne istnieje globalnie. `target` steruje tylko jego użyciem w LLG:

```{math}
:label: eq-merged-158

\mathbf H_{\mathrm{drive}}(\mathbf r)
=
\chi_{\mathrm{target}}(\mathbf r)
\mathbf H_{\mathrm{ant}}(\mathbf r).
```

Zmiana targetu nie wymaga ponownego current/field solve.

### Runtime

- typed basis handles;
- waveform evaluation per stage;
- activation per pipeline stage;
- absolute/stage-local time;
- source/port sum;
- per-source observables;
- energy.

### Backend sequence

1. FEM reference.
2. FDM CPU reference.
3. Native FEM CPU.
4. Native FEM GPU.
5. FDM CUDA.
6. FDM multilayer.

Każdy etap dopiero po parity z reference.

### Test E2E

Mała geometria z jednorodnym polem basis:

- identyczny RHS;
- identyczna energia;
- identyczny pierwszy krok;
- waveform phase;
- stage times;
- target clipping;
- source sum;
- output field.

### Kryterium wyjścia

- wszystkie reklamowane backendy przechodzą tę samą macierz;
- unsupported lanes są fail-closed;
- nie ma host-only preview bez RHS;
- per-source sum równa total.

---

### P7 — quantity, API v2 i control-room

### Cel

Udostępnić pole jako first-class resource, w tym `b_zeeman_antena_1`.

### Quantity

Dodać rodziny:

- `H_ant`;
- `H_ant_basis`;
- derived `mu0H_ant`;
- `J_ant`;
- `V_ant`;
- opcjonalne `A_ant`, `E_ant`.

Dodać source/port scopes.

### API

- field solution resources;
- status;
- diagnostics;
- slices;
- vector fields;
- derived units;
- complex representation;
- source selector;
- time/frequency selector.

### Frontend

1. oddzielne drzewo Microwave sources;
2. geometry/material/ports;
3. field solve node;
4. quantities;
5. airbox viewport;
6. source/total selector;
7. stale state;
8. diagnostics;
9. exports.

### `b_zeeman_antena_1`

Implementować jako:

- canonical H source field;
- transform $\mu_0$;
- display mT;
- stable source UUID;
- friendly ordinal tylko w label.

### E2E testy

- author source;
- solve;
- reload session;
- visualize airbox;
- visualize target;
- switch source;
- total sum;
- change current amplitude without solve;
- change geometry → stale;
- export field;
- missing asset error;
- unsupported backend message.

### Kryterium wyjścia

Użytkownik może wykonać cały workflow bez legacy panelu i bez znajomości wewnętrznych ID.

---

### P8 — źródłowa analiza $k$-przestrzeni

### Cel

Odpowiedzieć ilościowo na pytanie: jaki rozkład wektorów falowych zawiera pole danej anteny.

### Artefakt

```text
antenna_source_spectrum.v1
```

Zawartość:

- source/solution/port IDs;
- target;
- transform frame;
- axes;
- k arrays;
- complex field spectra;
- raw/transverse/circular power;
- window;
- normalization;
- diagnostics;
- peaks/bands;
- equilibrium dependency.

### Realizacje

1. FDM 1D FFT.
2. FDM 2D FFT.
3. FEM resample + FFT.
4. FEM direct quadrature oracle.
5. 3D optional.
6. local STFT.

### Reuse

Wydzielić wspólny core z `spin_wave_sampling.rs`:

- axis construction;
- windows;
- DFT convention;
- FFT normalization;
- signed k;
- Parseval;
- artifact serialization.

Nie kopiować drugiej implementacji FFT.

### Testy analityczne

1. Uniform strip:
   ```{math}
:label: eq-merged-159

\operatorname{sinc}(kw/2).
```
2. Height:
   ```{math}
:label: eq-merged-160

e^{-|k|d}.
```
3. Shift theorem.
4. Finite aperture sinc.
5. CPW zeros i harmonic peaks.
6. Port phase interference.
7. Parseval.
8. Nyquist.
9. Zero padding.
10. Window correction.
11. FE direct vs resampled.
12. Rotation of analysis frame.
13. Nonuniform $\mathbf m_0$ transverse projection.
14. Circular polarization.

### UI

- source FFT child;
- settings;
- charts;
- 2D heatmap;
- peak table;
- dB bands;
- resolution warnings;
- optional dispersion overlay.

### Kryterium wyjścia

- wynik jest reprodukowalny;
- analityczne widma zgadzają się;
- użytkownik widzi różnicę source/raw/transverse;
- nie używa się terminu „excited waves” bez susceptibility/response.

---

### P9 — sprzężenie modalne i odpowiedź $S(\mathbf k,\omega)$

### Cel

Połączyć pole anteny z właściwościami magnetycznymi.

### Etap A — response finite-$k$

Rozszerzyć istniejący `dynamic_structure_factor`:

- source `H_ant`;
- source IDs;
- 2D;
- component selection;
- target;
- equilibrium subtraction;
- per-source drive trace;
- cross spectra:
  ```{math}
:label: eq-merged-161

H^*(k,\omega)M(k,\omega).
```

### Etap B — dispersion overlay

- wyniki eigen/frequency-domain;
- bands;
- mode branch IDs;
- intersection with source spectrum.

### Etap C — mode overlap

- raw overlap;
- mass/volume weighting;
- left/right modes;
- biorthogonal normalization;
- coupling coefficient;
- predicted Lorentzian response;
- symmetry diagnostics.

### Etap D — absorbed power

Dla zakwalifikowanej susceptibility:

```{math}
:label: eq-merged-162

P_{\mathrm{abs}}
=
\frac{\mu_0\omega}{2}
h^\dagger\operatorname{Im}\chi h.
```

### Testy

- mode with matching symmetry;
- forbidden odd/even mode;
- frequency detuning;
- current scaling $m\propto I$ w reżimie liniowym;
- power $\propto I^2$;
- comparison time-domain vs frequency-domain;
- left/right normalization invariance;
- degeneracy handling;
- damping linewidth.

### Kryterium wyjścia

UI może osobno odpowiedzieć:

- co generuje antena;
- z czym się sprzęga;
- co faktycznie propaguje;
- jakie mody stojące są wzbudzane.

---

### P10 — harmoniczne MQS

### Cel

Uwzględnić skin/proximity i zespoloną fazę pola.

### Solver reference

- $A-\phi$;
- Nédélec + H1;
- complex CPU;
- explicit gauge;
- current-driven ports;
- airbox/open boundary;
- frequency sweep;
- shared sparsity/preconditioner.

### 2.5D fast lane

Może zostać dodana jako osobna, dokładnie nazwana realizacja dla prostych
przekrojów translacyjnie niezmienniczych. Nie zastępuje 3D i jest zabroniona
jako produkcyjny model anteny z taperem, przewężeniem albo dowolną zmianą
szerokości wzdłuż kierunku przepływu prądu.

### Artefakt

Dla każdej częstotliwości:

- complex J;
- H/E/A;
- impedance/current;
- phase;
- losses;
- validity.

### Wstrzykiwanie do time-domain

Jedna harmoniczna:

```{math}
:label: eq-merged-163

\mathbf H(t)
=
\Re[
\widehat{\mathbf H}e^{-i\omega t}
].
```

Broadband:

- częstotliwościowa interpolacja operatora;
- inverse FFT/convolution;
- albo bezpośredni pełny EM time-domain później.

Nie wolno używać jednej kompleksowej bazy dla dowolnego waveformu.

### Testy

- skin depth in slab/cylinder;
- current crowding;
- proximity pair;
- convergence airbox;
- gauge invariance;
- 2.5D vs 3D extruded;
- low-frequency limit vs Tier 1;
- complex power balance;
- frequency sweep continuity.

### Kryterium wyjścia

- pola zespolone mają poprawną fazę;
- skin/proximity są zweryfikowane;
- UI nie utożsamia current amplitude z delivered power bez port modelu.

---

### P11 — optymalizacja i kwalifikacja produkcyjna

### Cel

Skalować bez utraty oracle.

### Optymalizacje

- matrix/preconditioner reuse;
- multi-RHS ports;
- GPU conduction;
- GPU Biot–Savart;
- treecode/FMM;
- compressed field basis;
- lazy target projection;
- chunked loading;
- device-resident basis;
- fused accumulation;
- mixed precision z error gate.

### Budżet pamięci

Dla $N$ punktów i $P$ baz:

Real double:

```{math}
:label: eq-merged-164

M=3NP\cdot8\ \mathrm{bytes}.
```

Complex double:

```{math}
:label: eq-merged-165

M=3NP\cdot16\ \mathrm{bytes}.
```

Dla $N=10^7$, $P=2$:

- real: około 480 MB;
- complex: około 960 MB.

Planner musi raportować memory estimate przed alokacją.

### Telemetria

- time per stage;
- assembly;
- solve;
- field integration;
- projection;
- upload;
- memory;
- cache hit;
- precision;
- convergence.

### Performance gates

- brak regresji oracle;
- określone benchmark fixtures;
- scaling curves;
- cancellation;
- OOM fail-safe;
- streaming.

---

### P12 — migracja, dokumentacja i release

### Migracja

- import starych scen;
- legacy formula version;
- deprecation warnings;
- one-click conversion mask → RegionalFieldDrive;
- brak automatycznego udawania fizycznego conductor source.

### Dokumentacja publiczna

Struktura:

```text
Physics
└── Microwave antennas
    ├── Concepts and fidelity tiers
    ├── Conductor geometry and ports
    ├── DC conduction + Biot–Savart
    ├── Harmonic MQS
    ├── Coupling to LLG
    ├── Source k-spectrum
    ├── Mode overlap
    ├── Quantities and units
    ├── FEM workflow
    ├── FDM workflow
    ├── Python API examples
    └── Validation benchmarks
```

### Capability matrix

Musi być generowana/testowana z rzeczywistych capability descriptors. Ręczny JSON nie może dryfować.

### Release checklist

- wszystkie critical/high zamknięte;
- backend matrix;
- migration fixtures;
- API schema;
- frontend E2E;
- physics benchmarks;
- performance;
- docs;
- reproducibility;
- no silent fallback;
- no misleading labels.

### Kryterium końcowe

Moduł może zostać nazwany produkcyjnym dopiero po spełnieniu Definition of Done z rozdziału 19.

---

### P13 — publikacyjna kwalifikacja i zamknięcie evidence ledger

Ta faza pochodzi ze zweryfikowanego planu faz 0–13 i jest obowiązkową bramką
po P12. Release checklist nie zastępuje wykonanych workloadów.

Minimalny zestaw kwalifikacyjny:

1. prosty skończony przewodnik;
2. constant-width microstrip z jawnym return plane;
3. symetryczny CPW;
4. CPW z taperem albo przewężeniem;
5. exchange-only waveguide z propagującym pakietem;
6. wnęka ze stojącą falą;
7. porównanie pola z niezależnym solverem elektromagnetycznym;
8. parity konsumentów CPU/GPU bez per-step host transfer;
9. browser workflow od authoringu do Airboxa i obu rodzin widm.

Każdy receipt przechowuje pełny commit, dirty state, requested i resolved
execution, runtime/device identity, precision, poziomy mesh i quadrature,
tolerancje, hashes artefaktów oraz wersję konwencji znaku. Natywny FEM/MFEM i
CUDA muszą być uruchamiane przez repozytoryjne container-backed `just` recipes.
Hostowy Cargo lub samo przejście unit tests nie awansują capability.

Połączenie dwóch wcześniejszych planów jest normatywne: P0–P2 domykają kontrakt
i stage graph, P3–P5 tworzą pełny 3D Tier 1, P6–P7 uruchamiają konsumpcję i
quantities, P8–P9 rozdzielają source spectrum od response, P10 rozszerza
wierność elektromagnetyczną, P11–P12 domykają wydajność i produkt, a P13
kwalifikuje całość. Nie utrzymuje się drugiej równoległej listy faz.


---

(validation)=
## 17. Plan walidacji i kwalifikacji

### 17.1. Zasada kwalifikacji

Żadna funkcja nie jest „supported” tylko dlatego, że:

- kompiluje się;
- zwraca niezerowe pole;
- wygląda poprawnie w viewportcie;
- przechodzi pojedynczy smoke test.

Kwalifikacja wymaga czterech poziomów:

1. **unit/math** — formuła i znaki;
2. **numerical convergence** — błąd maleje zgodnie z oczekiwaniem;
3. **backend parity** — ta sama fizyka na wszystkich reklamowanych ścieżkach;
4. **end-to-end** — authoring, solve, artifact, LLG, quantity, UI i eksport.

### 17.2. Poziomy fixture

### L0 — analityczne mikro-fixtures

- line current;
- uniform resistor;
- sheet current;
- sinc spectrum;
- pojedynczy spin w polu.

### L1 — małe deterministyczne siatki

- 1–1000 elementów;
- double precision;
- sparse direct;
- golden values w repo.

### L2 — średnie benchmarki

- realistyczny strip/CPW;
- mesh refinement;
- CPU/GPU;
- artefakty Zarr.

### L3 — reprezentatywne aplikacje

- YIG waveguide + antenna;
- propagująca fala;
- standing-mode resonator;
- wiele źródeł;
- airbox.

### L4 — eksperymentalna walidacja

- porównanie pola/widma z COMSOL/CST/openEMS lub danymi pomiarowymi;
- nie jest warunkiem pierwszego merge’u, ale jest warunkiem deklaracji ilościowej dokładności dla rzeczywistych nanoanten.

---

### 17.3. Testy znaku i osi

| Test | Oczekiwany wynik | Gate |
|---|---|---:|
| line current $+\mathbf e_y$, punkt $z<z'$ | $H_x<0$ dla $x=x'$ | znak dokładny |
| punkt $x>x'$, $z=z'$ | $H_z<0$ | znak dokładny |
| current reversal | $\mathbf H(-I)=-\mathbf H(I)$ | rel. $<10^{-13}$ double |
| rotation $R$ | $\mathbf H_R(Rr)=R\mathbf H(r)$ | rel. wg precision |
| translation | field translated, amplitude unchanged | rel. wg precision |
| source reorder | total unchanged | bitwise ref lub tolerance |

Testy muszą wykorzystywać lokalny frame, nie tylko globalne osie.

### 17.4. Testy prądu DC

| Test | Miara | Gate referencyjny |
|---|---|---:|
| uniform bar | $R/(\rho L/A)-1$ | zbieżność P1 |
| terminal current | relative error | $<10^{-10}$ small fixture |
| global balance | $\epsilon_I$ | $<10^{-10}$ small, $<10^{-8}$ production |
| power identity | $P_\Omega-\sum UI$ | $<10^{-8}$ relative |
| local divergence RT0 | cell flux imbalance | near machine precision |
| gauge shift | $\mathbf J$ unchanged | $<10^{-12}$ |
| material interface | normal current continuity | convergence |
| multiport superposition | linearity | $<10^{-11}$ double |

Próg produkcyjny powinien być konfigurowalny, ale wynik przekraczający threshold musi mieć status failed, nie warning-only, jeżeli pole ma wejść do LLG.

### 17.5. Testy Biota–Savarta

### Analityczne

- infinite line;
- finite loop on axis:
  ```{math}
:label: eq-merged-166

B_z(0,0,z)
  =
  \frac{\mu_0IR^2}
  {2(R^2+z^2)^{3/2}};
```
- rectangular loop w punktach symetrii;
- dipole far field.

### Prawa całkowe

- Ampère:
  ```{math}
:label: eq-merged-167

\oint_C\mathbf H\cdot d\mathbf l;
```
- divergence:
  ```{math}
:label: eq-merged-168

\nabla\cdot\mathbf B=0
```
  poza źródłem;
- net-current cancellation dla CPW.

### Zbieżność

Osobno:

- source mesh;
- source quadrature;
- target sampling;
- near-singular refinement;
- field acceleration tolerance.

Nie wystarczy jedna seria „hmax”. Każde źródło błędu musi być izolowane.

### 17.6. Testy airboxu i otwartej granicy

Tier 1 Biot–Savart:

- wynik w targetach nie może zależeć od rozmiaru sampling airboxu;
- zmiana airboxu zmienia wyłącznie dostępny zakres wizualizacji.

Tier 2 MQS:

- field convergence przy zwiększaniu airboxu;
- porównanie boundary realizations;
- residual boundary;
- energy/power balance.

UI musi odróżniać oba przypadki.

### 17.7. Testy target projection

### FDM

- cell center vs analityczny punkt;
- cell average vs wysokorzędowa kwadratura;
- region clipping;
- inactive cells zero;
- translated/rotated grid;
- multilayer $z$-dependence;
- PBC policy.

### FEM

- P1 interpolation exact dla liniowego pola;
- nodal projection;
- quadrature projection;
- mesh reorder;
- topology generation;
- air/magnetic marker;
- region/interface;
- projection cache invalidation.

### Parity

Dla wspólnego zestawu fizycznych punktów FEM i FDM:

```{math}
:label: eq-merged-169

\epsilon_{L^2}
=
\frac{
\|\mathbf H_A-\mathbf H_B\|_{L^2}
}{
\|\mathbf H_{\mathrm{ref}}\|_{L^2}+\epsilon
}.
```

### 17.8. Testy LLG

### Pojedynczy spin

Dla stałego pola i braku tłumienia:

- zachowanie $|m|=1$;
- częstotliwość Larmora;
- właściwy kierunek precesji.

Dla sinusoidalnego pola:

- faza;
- liniowe skalowanie amplitudy;
- rezonans.

### Stadium RK

Waveform o wysokiej częstotliwości dobranej tak, aby różnica między oceną stage-time i step-time była widoczna. Test rzędu integratora musi się utrzymać.

### Energia

Zeeman energy:

```{math}
:label: eq-merged-170

E_{\mathrm{ant}}
=
-\mu_0
\sum_i
V_iM_{s,i}
\mathbf m_i\cdot\mathbf H_{\mathrm{ant},i}
```

dla FDM i odpowiednia forma masowa FEM.

### Backend parity

| Backend | Pole | RHS | 1 krok | pełna trajektoria |
|---|---:|---:|---:|---:|
| FEM ref | oracle | oracle | oracle | oracle |
| FEM native CPU | compare | compare | compare | compare |
| FEM native GPU | compare | compare | compare | compare |
| FDM CPU ref | compare at common fixture | compare | compare | compare |
| FDM CUDA | compare | compare | compare | compare |
| FDM multilayer | layer-specific | compare | compare | compare |

Tolerancje muszą uwzględniać precision i integrator, ale znak, aktywność source i target clipping są exact semantic gates.

### 17.9. Testy quantity i resource plane

1. Per-source:
   ```{math}
:label: eq-merged-171

H_{\mathrm{total}}=\sum_sH_s.
```
2. Per-port:
   ```{math}
:label: eq-merged-172

H_s=\sum_pI_pH_{s,p,1A}.
```
3. $\mu_0H$ transform.
4. Jednostki.
5. Source rename.
6. Source reorder.
7. Deleted source.
8. Stale asset.
9. Airbox carrier.
10. Magnetic carrier.
11. Time revision.
12. Frequency phasor.
13. real/imag/amplitude/phase.
14. zero amplitude phase mask.
15. export/import roundtrip.
16. chunk boundary.
17. decimation does not alter full export.

### 17.10. Testy FFT

### Transform convention

Syntetyczny sygnał:

```{math}
:label: eq-merged-173

h(x)=e^{ik_0x}
```

musi dawać peak w odpowiednio zdefiniowanym binie. Test ma sprawdzać znak $k$, nie tylko $|k|$.

### Analityczne profile

- rectangular → sinc;
- Gaussian → Gaussian;
- shifted profile → phase ramp;
- two sources → interference;
- CPW → zero przy $k=0$;
- height → exponential high-$k$ suppression.

### Normalizacja

- Parseval;
- amplitude scaling;
- current scaling;
- window coherent gain;
- power gain;
- one-/two-sided conventions.

### Resolution

- peak between bins;
- zero padding;
- changing extent;
- changing spacing;
- Nyquist alias;
- warning thresholds.

### FEM

- exact P1 synthetic field;
- direct quadrature vs regular resampling;
- irregular mesh;
- partial domain coverage;
- mask boundary.

### 17.11. Testy mode overlap

1. Pole o symetrii parzystej z modem nieparzystym → zero.
2. Current reversal → sign overlap.
3. Source shift → phase.
4. Degenerate modes → subspace-invariant total coupling.
5. Left/right normalization rescale → coupling invariant.
6. Frequency-domain vs time-domain linear response.
7. Damping dependence linewidth.
8. Port phase steering.

### 17.12. Testy staleness/cache

| Zmiana | Current solve | Field solve | Projection | Source FFT | Transverse FFT | Mode overlap |
|---|---:|---:|---:|---:|---:|---:|
| waveform amplitude | reuse | reuse | reuse | reuse bases | reuse | recombine |
| waveform phase | reuse | reuse | reuse | recombine | recombine | recombine |
| source geometry | stale | stale | stale | stale | stale | stale |
| conductivity Tier 1 | stale | stale | stale | stale | stale | stale |
| target mesh | reuse | reuse | stale | target-dependent | target-dependent | target-dependent |
| airbox sampling extent | reuse current | stale sampling | target projection may reuse | stale if target airbox | — | — |
| equilibrium $m_0$ | reuse | reuse | reuse | raw reuse | stale | stale |
| mode asset | reuse | reuse | reuse | reuse | reuse | stale |
| Tier 2 frequency | stale | stale | stale | stale | stale | stale |
| display unit | reuse | reuse | reuse | reuse | reuse | reuse |

Testy powinny automatycznie sprawdzać ten graf.

### 17.13. Testy awarii

- singular/degenerate geometry;
- disconnected port;
- zero conductivity;
- negative conductivity;
- invalid tensor;
- non-finite coordinate;
- memory estimate > limit;
- cancellation;
- disk full during artifact write;
- corrupted asset;
- hash mismatch;
- target mesh changed during solve;
- GPU unavailable;
- unsupported precision;
- solver nonconvergence;
- zero reference current;
- no magnetic target;
- source outside sampling domain.

Każdy błąd musi:

- mieć kod;
- nie zostawić assetu `ready`;
- zachować log i diagnostics;
- nie publikować częściowego field resource jako pełnego wyniku.

---

## 18. Kryteria akceptacji per obszar

### 18.1. Physics acceptance

- równania i konwencje są udokumentowane;
- znak pola zweryfikowany;
- porty bilansują prąd;
- realization validity jest raportowana;
- source spectrum używa pola poprzecznego;
- standing modes używają overlapu;
- brak mylącej deklaracji „excites $k$” bez progu i odpowiedzi.

### 18.2. Numerical acceptance

- mesh/quadrature convergence;
- residual gates;
- conservation;
- near-singular handling;
- Parseval;
- precision parity;
- deterministic reference.

### 18.3. Backend acceptance

- jawna capability;
- no silent fallback;
- RHS test;
- energy test;
- waveform stage test;
- observable parity;
- CPU/GPU.

### 18.4. Data/API acceptance

- immutable asset;
- content hashes;
- source/port scope;
- airbox;
- complex data;
- streaming;
- staleness;
- migration.

### 18.5. Frontend acceptance

- rozdzielenie maski od przewodnika;
- jawny solve;
- status;
- diagnostics;
- local frame;
- returns;
- per-source quantity;
- FFT child;
- no hidden compute;
- accessibility i unit clarity.

---

## 19. Definition of Done — moduł produkcyjny

Moduł jest produkcyjnie gotowy dopiero wtedy, gdy wszystkie poniższe warunki są spełnione.

### 19.1. Model i kontrakty

- [ ] fizyczny conductor source jest osobnym typem;
- [ ] prescribed regional field jest osobnym typem;
- [ ] każdy source/port ma stabilny ID;
- [ ] local frame jest jawny;
- [ ] return path jest jawny;
- [ ] current balance jest walidowany;
- [ ] realization i formula version są zapisane;
- [ ] wszystkie jednostki są jednoznaczne;
- [ ] phasor convention jest jawna.

### 19.2. Solver

- [ ] jawny `AntennaFieldSolve` stage;
- [ ] artifact `antenna_field_solution.v1`;
- [ ] DC conduction reference;
- [ ] H(div) current reconstruction lub równoważny konserwatywny flux;
- [ ] Biot–Savart reference z near-singular treatment;
- [ ] current/field diagnostics;
- [ ] airbox sampling;
- [ ] per-port 1 A basis;
- [ ] cache/signatures.

### 19.3. LLG

- [ ] FEM reference;
- [ ] FEM native CPU;
- [ ] FEM native GPU;
- [ ] FDM CPU;
- [ ] FDM CUDA;
- [ ] FDM multilayer albo jawne unsupported;
- [ ] waveform per RK stage;
- [ ] target clipping;
- [ ] per-source/total;
- [ ] energy.

### 19.4. Quantity i wizualizacja

- [ ] `H_ant` total;
- [ ] `H_ant` source scope;
- [ ] `H_ant_basis` port scope;
- [ ] $\mu_0H$ display;
- [ ] `b_zeeman_antena_1` friendly mapping;
- [ ] airbox;
- [ ] target;
- [ ] time/frequency;
- [ ] complex phase;
- [ ] export.

### 19.5. Analiza

- [ ] 1D source FFT;
- [ ] 2D source FFT;
- [ ] FEM direct/reference;
- [ ] transverse projection;
- [ ] circular components;
- [ ] normalization;
- [ ] diagnostics;
- [ ] dynamic response;
- [ ] mode overlap;
- [ ] explicit source vs response terminology.

### 19.6. Quality

- [ ] wszystkie CRITICAL/HIGH zamknięte;
- [ ] analytical benchmarks;
- [ ] convergence;
- [ ] backend parity;
- [ ] E2E UI;
- [ ] migration;
- [ ] docs;
- [ ] capability matrix;
- [ ] no silent fallback;
- [ ] no stale data shown as current;
- [ ] performance/memory gates.

---

## 20. Rekomendowane decyzje architektoniczne

### 20.1. Czy zaczynać od 2.5D MQS?

**Nie jako główny MVP.**

Rekomendowany MVP to 3D DC conduction + Biot–Savart, ponieważ:

- obsługuje skończone obiekty;
- obsługuje tapery i zwroty;
- daje prawidłową geometrię 3D;
- jest łatwiejszy do walidacji;
- nie wymaga airboxu PDE;
- tworzy wspólną bazę dla FEM/FDM.

2.5D MQS jest wartościową szybką ścieżką dla prostych przekrojów i skin/proximity, ale nie powinien definiować architektury obiektu.

### 20.2. Czy pole liczyć osobno dla FEM i FDM?

**Nie.**

Field solve jest solverem elektromagnetycznym niezależnym od solvera magnetycznego. Wynik ma być assetem konsumowanym przez oba backendy. Osobne są tylko target projections.

### 20.3. Czy `H_ant` czy `B_ant`?

Canonical core:

```text
H_ant [A/m]
```

Display:

```text
mu0H_ant [T]
```

`b_zeeman_antena_1` jest aliasem display, nie totalnym $\mathbf B$.

### 20.4. Czy FFT ma być podwęzłem anteny?

**Tak**, ale jako jawna analiza zależna od gotowego field solution. Powinna mieć własny artifact i status.

### 20.5. Czy FFT wystarcza dla fal stojących?

**Nie.**

Dla fal stojących wymagany jest mode overlap. FFT może być pomocniczą charakterystyką przestrzenną modu.

### 20.6. Czy source FFT ma używać $|H|$?

**Nie jako domyślny wynik fizyczny.**

Domyślne powinno być wektorowe pole poprzeczne względem $\mathbf m_0$, z zachowaniem zespolonej fazy.

### 20.7. Czy amplituda prądu należy do field assetu?

**Nie.**

Asset przechowuje bazę 1 A. Waveform i amplituda należą do drive. Wyjątek: pełny nieliniowy EM, którego nie planuje się w MVP.

### 20.8. Czy target region powinien przycinać solve?

**Nie.**

Pole powinno być rozwiązane niezależnie. Target region przycina tylko projekcję do LLG. Dzięki temu zmiana regionu nie przelicza prądu i pola.

### 20.9. Czy airbox antenowy ma być tym samym co demag airbox?

**Nie z definicji.**

Można współdzielić siatkę jako optymalizację, ale kontrakty i podpisy muszą pozostać osobne.

### 20.10. Czy obsługiwać dBm w MVP?

Tylko jeśli użytkownik jawnie poda impedancję i definicję prądu. Bez full-wave/port modelu bezpiecznym wejściem jest:

```text
delivered port current [A]
```

Nie należy automatycznie przeliczać mocy generatora na lokalny prąd anteny.

---

(limitations)=
## 21. Ryzyka, ograniczenia i działania ograniczające

| Ryzyko | Prawdopodobieństwo | Skutek | Mitigacja |
|---|---:|---:|---|
| zbyt szybkie wejście w full-wave | średnie | opóźnienie MVP | Tier 1 first |
| powielenie solverów FEM/FDM | wysokie bez assetu | drift | wspólny field asset |
| niekontrolowana całka near-field | wysokie | błędne amplitudy | direct oracle + adaptive |
| zbyt duża pamięć pola | wysokie | OOM | chunking, target projection, estimates |
| niejednoznaczne porty | wysokie | błędna fizyka | explicit terminals/returns |
| UI ukrywa staleness | średnie | stare wyniki | immutable asset/status |
| FFT daje atrakcyjny, ale błędny wykres | wysokie | błędne wnioski | conventions, Parseval, transverse |
| mode overlap źle normalizowany | średnie | fałszywa efektywność | left/right modes, explicit raw |
| GPU omija pole | wysokie bez testu | brak wzbudzenia | RHS parity gate |
| migracja zmienia znak | wysokie | nierozróżnialne wyniki | formula version |
| PBC replikuje źródło niejawnie | średnie | błędne pole | explicit periodicity policy |
| parametry dBm bez impedancji | średnie | błędna amplituda | current-only MVP |

---

## 22. Odpowiedź bezpośrednia na wymagania użytkowe

### 22.1. Pole `b_zeeman_antena_1`

Należy je zrealizować jako widok:

```{math}
:label: eq-merged-174

\mathbf B_{\mathrm{Zeeman,ant},1}
=
\mu_0
\mathbf H_{\mathrm{ant},1}.
```

Canonical resource:

```text
quantity_id = H_ant
source_ref  = <antenna_uuid>
```

Transform UI/API:

```text
unit_transform = mu0_H_to_B
display_unit = mT
display_label = B Zeeman — antenna_1
```

Pole powinno być dostępne:

- w airboxie samplingowym;
- na każdym obiekcie magnetycznym;
- na regionie;
- jako vector/magnitude/components;
- jako instantaneous time field;
- jako 1 A basis;
- jako complex phasor dla MQS.

### 22.2. Pole całkowite

```{math}
:label: eq-merged-175

\mathbf H_{\mathrm{ant,total}}
=
\sum_s
\mathbf H_{\mathrm{ant},s}.
```

Zachować `H_ant` jako total, ale per-source musi być first-class.

### 22.3. Podwęzeł FFT anteny

Podwęzeł:

```text
Excitation analyses
└── Source k-spectrum
```

powinien obliczać:

1. $\widetilde{\mathbf H}(\mathbf k)$;
2. $\widetilde{\mathbf H}_\perp(\mathbf k)$;
3. $\widetilde h_\pm(\mathbf k)$;
4. peak/band table;
5. opcjonalne przecięcie z dyspersją;
6. opcjonalny mode overlap.

Nie powinien ograniczać się do FFT amplitudy skalarnej.

### 22.4. Propagujące fale

Wynik powinien pokazywać:

- source spectrum;
- dyspersję;
- k-piki przy częstotliwości napędu;
- group velocity;
- rzeczywistą mapę $S(k,f)$ po symulacji.

### 22.5. Fale stojące

Wynik powinien pokazywać:

- listę modów własnych;
- częstotliwości;
- overlap per port;
- symmetry selection;
- przewidywaną amplitudę przy danym drive;
- przestrzenny overlay pola i modu.

### 22.6. Airbox

Pole anteny powinno być wizualizowane w niezależnym `field_sampling_domain`. Nie należy wymagać, aby każdy punkt airboxu uczestniczył w LLG.



---

(source-code-index)=
## 23. Traceability — indeks kodu, symboli i dowodów

Poniższy indeks jest kanonicznym minimum source map. Dalsze podsekcje rozszerzają
go o dodatkowe ścieżki i ustalenia raportu Pro.

| Source id | Twierdzenie | Ścieżka | Symbol | Lane | Dowód |
|---|---|---|---|---|---|
| `planner-mask` | planner idealizowanej maski Zeemana | `crates/fullmag-plan/src/antenna_zeeman.rs` | `resolve_prescribed_zeeman_masks` | planner | source + tests |
| `legacy-evaluator` | infinite-strip compatibility evaluator | `crates/fullmag-runner/src/antenna_fields.rs` | `add_rectangular_conductor` | compatibility | source inspection |
| `antenna-runtime` | czasowa kombinacja pól legacy | `crates/fullmag-runner/src/antenna_fields.rs` | `combined_antenna_field_at_time` | runtime | source inspection |
| `fdm-consumer` | materializacja pola antenowego | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `resolved_antenna_zeeman_field` | FDM CPU | source + focused tests |
| `excitation-analysis-api` | semantyczne żądanie source spectrum | `packages/fullmag-py/src/fullmag/model/antenna.py` | `class SpinWaveExcitationAnalysis` | Python | source + tests; producer missing |
| `spin-wave-sampling` | istniejący bounded finite-$k$ response | `crates/fullmag-runner/src/spin_wave_sampling.rs` | `dynamic_structure_factor_1d_with_axes` | FEM CPU source path | manufactured tests; runtime qualification missing |
| `quantity-catalog` | canonical `H_ant` i `H_drive` | `crates/fullmag-quantities/src/catalog.rs` | `quantity_catalog` | shared | source + catalog tests |

Poniższa lista wskazuje główne miejsca, które należy objąć zmianami i review. Linki są przypięte do audytowanego commitu.

### 23.1. IR i walidacja

- `crates/fullmag-ir/src/study.rs`  
  `AntennaIR`, `AntennaFieldSourceModelIR`, `CurrentModuleIR::AntennaFieldSource`, `RfDriveIR`, `RegionalFieldDriveIR`  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-ir/src/study.rs

- `crates/fullmag-ir/src/plan.rs`  
  resolved masks i planowe struktury pól  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-ir/src/plan.rs

- `crates/fullmag-ir/src/validation.rs`  
  walidacja modeli i parametrów źródeł  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-ir/src/validation.rs

- `crates/fullmag-ir/src/physics_object.rs`  
  authoring object integration  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-ir/src/physics_object.rs

### 23.2. Python API

- `packages/fullmag-py/src/fullmag/model/antenna.py`  
  `MicrostripAntenna`, `CPWAntenna`, `AntennaFieldSource`, `SpinWaveExcitationAnalysis`  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/packages/fullmag-py/src/fullmag/model/antenna.py

- `packages/fullmag-py/src/fullmag/world.py`  
  rejestracja źródeł i analiz  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/packages/fullmag-py/src/fullmag/world.py

### 23.3. Planner

- `crates/fullmag-plan/src/antenna_zeeman.rs`  
  prescribed masks, B→H, geometry/profile sampling  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-plan/src/antenna_zeeman.rs

- `crates/fullmag-plan/src/fdm.rs`  
  planowanie pól dla FDM  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-plan/src/fdm.rs

### 23.4. Legacy field runtime

- `crates/fullmag-runner/src/antenna_fields.rs`  
  `compute_per_unit_antenna_fields`, `combined_antenna_field_at_time`, `add_rectangular_conductor`  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-runner/src/antenna_fields.rs

To jest najważniejszy plik dla P0.

### 23.5. FEM

- `crates/fullmag-runner/src/fem_reference.rs`  
  referencyjna iniekcja pola do LLG  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-runner/src/fem_reference.rs

- `crates/fullmag-runner/src/fem/execution.rs`  
  routing native FEM  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-runner/src/fem/execution.rs

- `crates/fullmag-runner/src/native_fem.rs`  
  ABI packing, observables, runtime  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-runner/src/native_fem.rs

- `crates/fullmag-runner/src/interactive_runtime/fem/mod.rs`  
  runtime interaktywny i pole preview  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-runner/src/interactive_runtime/fem/mod.rs

- `crates/fullmag-runner/src/interactive_runtime/fem/gpu.rs`  
  quantity preview GPU  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-runner/src/interactive_runtime/fem/gpu.rs

- `native/include/fullmag_fem.h`  
  natywny kontrakt ABI  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/native/include/fullmag_fem.h

- `backends/fem/core/fem_plan_fields.cpp`  
  import planu bazowego, między innymi globalnego `air_box_factor`  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/backends/fem/core/fem_plan_fields.cpp

### 23.6. FDM

- `crates/fullmag-runner/src/fdm/cpu/reference.rs`  
  prescribed masks w CPU reference  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-runner/src/fdm/cpu/reference.rs

- `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`  
  natywny CUDA snapshot/ABI  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-runner/src/fdm/gpu/cuda/native.rs

### 23.7. Quantity i data plane

- `crates/fullmag-quantities/src/catalog.rs`  
  katalog `H_ant`  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-quantities/src/catalog.rs

- `crates/fullmag-quantities/src/id.rs`  
  canonical ID i alias  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-quantities/src/id.rs

- `crates/fullmag-runner/src/quantities.rs`  
  aktywacja quantity per backend  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-runner/src/quantities.rs

- `crates/fullmag-runner/src/preview.rs`  
  materializacja preview  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-runner/src/preview.rs

- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`  
  API pól  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-api/src/router_v2/handlers/data/fields.rs

- `apps/control-room/src/kernel/api/quantityIds.ts`  
  frontend IDs i units  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/apps/control-room/src/kernel/api/quantityIds.ts

### 23.8. Frontend

- `apps/control-room/src/modules/inspector/panels/AntennaObjectPanelModel.ts`  
  aktualny model panelu maski  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/apps/control-room/src/modules/inspector/panels/AntennaObjectPanelModel.ts

- `apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.tsx`  
  aktualny panel  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.tsx

- `apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts`  
  drzewo obiektów  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts

- `apps/legacy_web/components/panels/settings/AntennaPanel.tsx`  
  legacy authoring physical-like source  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/apps/legacy_web/components/panels/settings/AntennaPanel.tsx

### 23.9. FFT i odpowiedź

- `crates/fullmag-runner/src/spin_wave_sampling.rs`  
  FEM P1 probe, space-time FFT, `dynamic_structure_factor.1d.v1`  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-runner/src/spin_wave_sampling.rs

- `crates/fullmag-api/src/router_v2/handlers/analysis/spin_wave_response.rs`  
  API response analysis  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/crates/fullmag-api/src/router_v2/handlers/analysis/spin_wave_response.rs

- `apps/control-room/src/modules/analysis-plots/SpinWaveGammaView.tsx`  
  wykres czas/FFT częstotliwości  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/apps/control-room/src/modules/analysis-plots/SpinWaveGammaView.tsx

### 23.10. Dokumenty projektowe

- ADR 0017  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/docs/adr/0017-staged-antenna-field-basis-workflow.md

- Physics 0950  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md

- superseded FEM plan  
  https://github.com/MateuszZelent/fullmag/blob/7aeaf2e6b91882209f6f6d506d29852884890b6c/docs/plans/active/fullmag_fem_microwave_antenna_plan.md

### 23.11. Istniejący stos charge transport → RT0 → Oersted

| Source ID | Ścieżka i symbol | Dowodzona odpowiedzialność | Granica twierdzenia |
|---|---|---|---|
| `charge-transport-dsl` | `packages/fullmag-py/src/fullmag/model/current_transport.py` — `class CurrentTransport` | publiczny kontrakt authoringu transportu prądu | obecność DSL nie dowodzi wykonania w każdym lane |
| `charge-transport-ir` | `crates/fullmag-ir/src/validation.rs` — `validate_charge_transport_definition` (waliduje `ChargeTransportDefinitionIR` z `spin_transport.rs`) | canonical definicja i walidacja charge transport w IR | typ danych nie jest receipt solvera |
| `current-transport-planner` | `crates/fullmag-plan/src/current_transport.rs` — `resolve_current_transports` | planowanie istniejących current modules | wsparcie pozostaje lane-dependent |
| `conservative-current-view` | `backends/fem/cpu/mfem/transport/conservative_current_view.hpp` — `class ConservativeCurrentView` | konserwatywny widok RT0/$H(\mathrm{div})$ i tożsamość źródła | nie jest jeszcze samodzielnym produktem antenowym |
| `oersted-direct-tetra` | `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp` — `class DirectTetraQuadrature` | singular-aware direct CPU-double oracle | ograniczony oracle, nie ogólna deklaracja production |
| `oersted-vector-potential` | `backends/fem/cpu/mfem/interactions/oersted/vector_potential.hpp` — `class VectorPotentialSolver` | ograniczona realizacja referencyjna Oersteda | nie harmoniczny solver $A-\phi$ i nie bezwarunkowo production |
| `oersted-steady-transport` | `crates/fullmag-runner/src/native_fem/steady_transport.rs` — `execute_native_fem_steady_transport_plans` | wykonanie planów steady transport i publikacja artefaktów | wykonanie zależy od resolved plan/capability |
| `oersted-stage-provider` | `crates/fullmag-runner/src/native_fem/stage_oersted.rs` — `plan_requests_stage_oersted_callback` / `StageOerstedProvider` | stage-time Oersted callback, trial transactions i source identity | nie dowodzi solved antenna-basis consumer w każdym backendzie |
| `oersted-quantity` | `crates/fullmag-quantities/src/catalog.rs` — `quantity_catalog` | metadane `H_oe`, `V_electric`, `J_charge` | katalog nie dowodzi materializacji runtime |
| `solved-current-spin-gate` | `crates/fullmag-plan/src/oersted.rs` — `resolve_solved_current_source` | obecna zależność solved current od bound `SpinDriftDiffusion` | dowód blockeru ANT-HIGH-013, nie pożądany kontrakt docelowy |

---

## 24. Rekomendowany układ nowych modułów

```text
crates/fullmag-plan/src/antenna/
├── mod.rs
├── composition.rs
├── port_modes.rs
├── charge_binding.rs
├── field_solve.rs
├── projection.rs
├── signatures.rs
└── capabilities.rs

crates/fullmag-runner/src/antenna/
├── mod.rs
├── field_solution.rs
├── artifacts.rs
├── projection.rs
├── runtime_drive.rs
├── source_spectrum.rs
└── diagnostics.rs

crates/fullmag-api/src/router_v2/handlers/
├── antenna/
└── analysis/antenna_source_spectrum.rs

packages/fullmag-py/src/fullmag/model/
├── microwave_source.py
└── antenna_analysis.py

apps/control-room/src/modules/
├── microwave-sources/
│   ├── explorer/
│   ├── inspector/
│   ├── field-solve/
│   ├── viewport/
│   └── analyses/
```

Nowe katalogi planera i runnera są wyłącznie warstwą orkiestracyjną. Numeryka pozostaje
u istniejących właścicieli:

```text
packages/fullmag-py/src/fullmag/model/current_transport.py
crates/fullmag-ir/src/spin_transport.rs
crates/fullmag-plan/src/current_transport.rs
crates/fullmag-plan/src/oersted.rs
backends/fem/cpu/mfem/transport/
backends/fem/cpu/mfem/interactions/oersted/
crates/fullmag-runner/src/native_fem/steady_transport.rs
crates/fullmag-runner/src/native_fem/stage_oersted.rs
crates/fullmag-quantities/src/catalog.rs
```

Nie tworzyć antenowych odpowiedników `conduction_reference.rs`,
`current_reconstruction.rs`, `biot_savart_reference.rs` ani
`biot_savart_accelerated.rs`. Ewentualny harmoniczny $A-\phi$ ma wejść jako nowa,
zakresowana realizacja u właściciela elektromagnetycznego po osobnej dokumentacji,
capability review i kwalifikacji — nie jako przemianowanie obecnego
`VectorPotentialSolver`.

---

## 25. Pseudokod przepływów referencyjnych

### 25.1. Field solve

```rust
fn solve_antenna_field(
    request: &ResolvedAntennaFieldSolveStage,
    storage: &ArtifactStore,
) -> Result<AntennaFieldSolutionAsset, AntennaSolveError> {
    let object = resolve_physics_object(&request.source_object_ref)?;
    let transport = resolve_current_transport(&request.current_transport_ref)?;
    let port_mode = resolve_and_validate_port_mode(
        object,
        transport,
        &request.port_mode_ref,
    )?;

    // Delegacja do istniejącego właściciela CurrentTransport; bez drugiego solve'u.
    let transport_result = execute_or_reuse_current_transport(transport, storage)?;
    let current_view = transport_result.require_conservative_current_view()?;
    let current_certificate = certify_terminal_currents(current_view, port_mode)?;
    let normalized_view = current_view.normalize_per_ampere(
        current_certificate.reference_current_a,
    )?;

    let field_signature = hash_field_dependencies(
        request,
        normalized_view.identity_digest(),
        current_certificate.digest(),
    );
    let field_solution = match storage.find_field_solution(&field_signature)? {
        Some(asset) => asset,
        None => {
            // Delegacja do istniejącego DirectTetraQuadrature albo VectorPotentialSolver.
            let h_oe = evaluate_existing_oersted_realization(
                &request.oersted_realization,
                &normalized_view,
                &request.sampling_targets,
            )?;
            validate_oersted_field(&normalized_view, &h_oe)?;
            storage.publish_antenna_field_solution_atomically(
                field_signature,
                h_oe,
                current_certificate,
            )?
        }
    };

    let projections = request
        .target_projections
        .iter()
        .map(|target| {
            project_or_reuse(&field_solution, target, storage)
        })
        .collect::<Result<Vec<_>, _>>()?;

    publish_manifest_atomically(
        request,
        transport_result,
        field_solution,
        projections,
        storage,
    )
}
```

### 25.2. Runtime LLG

```rust
fn add_antenna_field(
    drives: &[RuntimeAntennaDrive],
    stage_time_s: f64,
    h_eff: &mut [Vec3],
) {
    for drive in drives.iter().filter(|d| d.is_active(stage_time_s)) {
        for port in &drive.port_bases {
            let current_a = port.waveform.value_at(stage_time_s);
            fused_axpy_masked(
                h_eff,
                current_a,
                port.field_basis.as_slice(),
                drive.target_mask.as_slice(),
            );
        }
    }
}
```

Natywny/GPU wariant musi zachować dokładnie tę semantykę.

### 25.3. Source spectrum

```rust
fn antenna_source_spectrum(
    request: &ResolvedAntennaSpectrumRequest,
    field: &FieldResource,
    equilibrium: Option<&EquilibriumField>,
) -> Result<AntennaSourceSpectrumArtifact, AnalysisError> {
    let samples = sample_or_integrate_field(field, &request.target)?;

    let projected = match request.component {
        RawVector => samples,
        Transverse => project_transverse(samples, equilibrium.required()?),
        CircularPlus | CircularMinus => {
            let basis = build_local_transverse_basis(equilibrium.required()?)?;
            project_circular(samples, basis, request.component)
        }
    };

    let windowed = apply_window(projected, &request.window);
    let spectrum = transform_with_declared_convention(
        windowed,
        &request.axes,
        &request.normalization,
    )?;

    let diagnostics = validate_spectrum(
        &spectrum,
        &request.axes,
        &request.window,
    )?;

    publish_source_spectrum(request, spectrum, diagnostics)
}
```

---

(python-api)=
## 26. Przykładowy docelowy Python API po wdrożeniu

Nazwy poniżej są docelowym projektem, nie twierdzeniem o istniejącym API.
Kanoniczna forma pozostaje stage-first i musi po implementacji przechodzić
Python → ProblemIR → Python bez utraty requested intent.

```python
# %%
import fullmag as fm

study = fm.study(
    name="cpw_spin_wave_excitation",
    engine="fem",
    device="cpu",
    mode="strict",
)

# %%
antenna = study.antenna_layout(
    fm.CoplanarWaveguide(
        id="antenna_1",
        length_m=8.0e-6,
        thickness_m=200.0e-9,
        conductivity_S_per_m=5.8e7,
        stations=(
            fm.CpwWidthStation(
                s=0.0,
                signal_width_m=1.0e-6,
                gap_m=0.5e-6,
                ground_width_m=3.0e-6,
            ),
            fm.CpwWidthStation(
                s=0.45,
                signal_width_m=0.3e-6,
                gap_m=0.2e-6,
                ground_width_m=3.0e-6,
            ),
            fm.CpwWidthStation(
                s=0.55,
                signal_width_m=0.3e-6,
                gap_m=0.2e-6,
                ground_width_m=3.0e-6,
            ),
            fm.CpwWidthStation(
                s=1.0,
                signal_width_m=1.0e-6,
                gap_m=0.5e-6,
                ground_width_m=3.0e-6,
            ),
        ),
    ),
    transform=fm.RigidTransform.identity(),
)

# %%
mode = antenna.port_mode(
    id="odd_cpw",
    branches=(
        fm.PortBranch(
            part="signal", inlet="u_min", outlet="u_max", current_weight=1.0
        ),
        fm.PortBranch(
            part="ground_left",
            inlet="u_min",
            outlet="u_max",
            current_weight=-0.5,
        ),
        fm.PortBranch(
            part="ground_right",
            inlet="u_min",
            outlet="u_max",
            current_weight=-0.5,
        ),
    ),
)

# %%
field_solution = study.stages.add_antenna_field_solve(
    stage_id="solve_antenna_1",
    antenna=antenna,
    port_modes=(mode,),
    model="quasistatic_conduction_biot_savart_3d",
    inspection_grid=fm.RegularFieldGrid.from_scene_airbox(spacing_m=50e-9),
    project_to=("waveguide",),
)

# %%
study.solved_antenna_drive(
    id="antenna_1_drive",
    field_solution=field_solution.output("odd_cpw"),
    peak_current_A=10e-3,
    waveform=fm.SincPulse(cutoff_hz=20e9, t0=100e-12),
    time_origin="stage_local",
)

study.stages.add_run(
    stage_id="driven_llg",
    duration_s=10e-9,
    outputs=(
        fm.SaveField("m", every=5e-12),
        fm.SaveField("H_ant", source_ref="antenna_1", every=5e-12),
    ),
)
```

#### Nienormatywny szkic obiektowy z raportu Pro

Poniższy blok zachowano jako materiał do porównania nazw i odpowiedzialności.
Nie jest alternatywnym publicznym kontraktem i nie może zostać wdrożony obok
stage-first API bez osobnej decyzji ADR.

```python
from fullmag import (
    World,
    MicrowaveConductorSource,
    CpwPreset,
    ConductorMaterial,
    CurrentDrivenPort,
    AntennaFieldSolve,
    SolvedAntennaDrive,
    SinusoidalWaveform,
    AntennaExcitationAnalysis,
    WavevectorPlane,
)

world = World()

cpw_geometry = CpwPreset(
    signal_width=300e-9,
    gap=200e-9,
    ground_width=600e-9,
    conductor_thickness=80e-9,
    active_length=8e-6,
    taper_length=20e-6,
).build(
    origin=(0.0, 0.0, 120e-9),
    current_axis=(0.0, 1.0, 0.0),
    width_axis=(1.0, 0.0, 0.0),
)

antenna = MicrowaveConductorSource(
    id="antenna_tx",
    name="TX CPW",
    geometry=cpw_geometry,
    materials=[
        ConductorMaterial(
            body="signal",
            conductivity=4.1e7,
        ),
        ConductorMaterial(
            body="ground_left",
            conductivity=4.1e7,
        ),
        ConductorMaterial(
            body="ground_right",
            conductivity=4.1e7,
        ),
    ],
    ports=[
        CurrentDrivenPort(
            id="tx_port",
            terminal_currents={
                "signal_in": +1.0,
                "ground_left_return": -0.5,
                "ground_right_return": -0.5,
            },
        )
    ],
)

world.add(antenna)

field_solution = world.solve(
    AntennaFieldSolve(
        id="tx_field_dc",
        source="antenna_tx",
        realization="conduction_3d_biot_savart",
        reference_current=1.0,
        sampling_domains=[
            world.airbox_grid(
                name="antenna_airbox",
                spacing=20e-9,
                padding=(2e-6, 2e-6, 1e-6),
            ),
            world.magnet_target("waveguide"),
        ],
    )
)

world.add(
    SolvedAntennaDrive(
        id="tx_drive",
        solution=field_solution,
        port_waveforms={
            "tx_port": SinusoidalWaveform(
                amplitude=2e-3,
                frequency=6.5e9,
                phase=0.0,
            )
        },
        target=world.object("waveguide"),
    )
)

spectrum = world.analyze(
    AntennaExcitationAnalysis(
        id="tx_source_k",
        solution=field_solution,
        ports={"tx_port": 1.0 + 0.0j},
        target=world.object("waveguide"),
        component="transverse_circular",
        equilibrium=world.latest_equilibrium("waveguide"),
        transform=WavevectorPlane(
            axes=("local_v", "local_u"),
            spacing=(20e-9, 20e-9),
            window="hann",
        ),
    )
)
```

Semantyka:

- `field_solution` nie zależy od 2 mA ani 6.5 GHz dla Tier 1;
- zmiana amplitude/phase nie przelicza pola;
- zmiana target mesh przelicza tylko projection;
- `spectrum` ma własny artifact i equilibrium dependency.

---

(scientific-bibliography)=
## 27. Bibliografia naukowa i techniczna

### 27.1. Anteny magnoniczne i selekcja $k$

1. A. Höfinger et al., **“k-Selective Electrical-to-Magnon Transduction with Finite-Element-Resolved Sub-Micron Nanoantennas,”** *Advanced Physics Research* 5, e00211 (2026).  
   DOI: https://doi.org/10.1002/apxr.202500211  
   Szczególnie istotne: pełne zespolone pole FE, projekcja poprzeczna, skin/proximity, taper i return-path wpływające na widmo $k$.

2. F. Vanderveken, V. Tyberkevych, G. Talmelli, B. Sorée, F. Ciubotaru, C. Adelmann, **“Lumped circuit model for inductive antenna spin-wave transducers,”** *Scientific Reports* 12, 3796 (2022).  
   DOI: https://doi.org/10.1038/s41598-022-07625-2  
   Istotne: liniowa baza pola per prąd, widmo anteny, susceptibility i efektywność transdukcji.

3. P. Gruszecki, M. Kasprzak, A. E. Serebryannikov, M. Krawczyk, W. Śmigaj, **“Microwave excitation of spin wave beams in thin ferromagnetic films,”** *Scientific Reports* 6, 22367 (2016).  
   DOI: https://doi.org/10.1038/srep22367  
   Istotne: warunek dopasowania widma Fouriera pola mikrofalowego do wektora falowego fali spinowej.

4. B. A. Kalinikos, A. N. Slavin, **“Theory of dipole-exchange spin wave spectrum for ferromagnetic films with mixed exchange boundary conditions,”** *Journal of Physics C: Solid State Physics* 19, 7013–7033 (1986).  
   DOI: https://doi.org/10.1088/0022-3719/19/35/014

5. D. D. Stancil, A. Prabhakar, **Spin Waves: Theory and Applications**, Springer (2009).  
   DOI: https://doi.org/10.1007/978-0-387-77865-5

### 27.2. Micromagnetyka

6. W. F. Brown Jr., **Micromagnetics**, Interscience (1963).

7. T. L. Gilbert, **“A phenomenological theory of damping in ferromagnetic materials,”** *IEEE Transactions on Magnetics* 40, 3443–3449 (2004; original report 1955).  
   DOI: https://doi.org/10.1109/TMAG.2004.836740

8. L. Landau, E. Lifshitz, **“On the theory of the dispersion of magnetic permeability in ferromagnetic bodies,”** *Physikalische Zeitschrift der Sowjetunion* 8, 153 (1935).

### 27.3. Elektromagnetyzm obliczeniowy

9. P. Monk, **Finite Element Methods for Maxwell’s Equations**, Oxford University Press (2003).  
   DOI: https://doi.org/10.1093/acprof:oso/9780198508885.001.0001

10. R. Hiptmair, **“Finite elements in computational electromagnetism,”** *Acta Numerica* 11, 237–339 (2002).  
    DOI: https://doi.org/10.1017/S0962492902000041

11. A. Bossavit, **Computational Electromagnetism: Variational Formulations, Complementarity, Edge Elements**, Academic Press (1998).

12. J.-M. Jin, **The Finite Element Method in Electromagnetics**, Wiley.

13. J. D. Jackson, **Classical Electrodynamics**, Wiley.

### 27.4. Algorytmy całkowe i FFT

14. L. Greengard, V. Rokhlin, **“A fast algorithm for particle simulations,”** *Journal of Computational Physics* 73, 325–348 (1987).  
    DOI: https://doi.org/10.1016/0021-9991(87)90140-9

15. F. J. Harris, **“On the use of windows for harmonic analysis with the discrete Fourier transform,”** *Proceedings of the IEEE* 66, 51–83 (1978).  
    DOI: https://doi.org/10.1109/PROC.1978.10837

### 27.5. Uwaga bibliograficzna

Literatura potwierdza, że realistyczna selekcja $k$ zależy nie tylko od szerokości przewodnika, ale także od pełnego zespolonego pola poprzecznego, geometrii zwrotów, taperów, skin/proximity oraz odpowiedzi magnetycznej. Dlatego plan nie powinien kończyć się na skalarnej FFT prostego profilu.

---

## 28. Lista decyzji do zapisania jako ADR

1. **ADR — physical conductor vs prescribed field separation**
2. **ADR — staged antenna field-solution asset**
3. **ADR — $H$ canonical, $\mu_0H$ derived display**
4. **ADR — source/port scoped quantities**
5. **ADR — phasor and Fourier conventions**
6. **ADR — Tier 1 production MVP**
7. **ADR — explicit return currents and port balance**
8. **ADR — target projection independent from field solve**
9. **ADR — backend fail-closed capability routing**
10. **ADR — source spectrum vs dynamic response vs mode overlap**
11. **ADR — PBC policy for localized sources**
12. **ADR — legacy sign/version migration**

Każdy ADR powinien zawierać:

- context;
- decision;
- alternatives;
- consequences;
- compatibility;
- qualification;
- migration.

---

## 29. Końcowa rekomendacja

Należy zachować dotychczasowy kod jako ograniczony oracle/legacy benchmark, ale nie rozwijać go dalej jako centralnego solvera `mqs_2p5d_az`.

Architektura docelowa powinna oprzeć się na istniejących właścicielach i czterech
cienkich produktach kompozycyjnych:

1. **`PhysicsObject` + `CurrentTransport` + `AntennaPortModeIR`** — wspólna geometria,
   materiały, terminale, zwroty i charge solve bez duplikacji;
2. **`AntennaFieldSolutionRefIR` / `antenna_field_solution.v1`** — baza pola per port
   otrzymana z istniejącego RT0 i Oersteda;
3. **`SolvedAntennaDriveIR`** — waveform i target LLG;
4. **`AntennaSpectrumRequestIR`** — source $k$-spectrum, overlap i response.

Najpierw należy wykonać P0, ponieważ aktualny błąd indeksowania i niezakwalifikowana ścieżka native FEM podważają wiarygodność bieżących symulacji. Następnie należy wdrożyć Tier 1 jako produkcyjny MVP i dopiero na jego stabilnym artefakcie rozwijać UI, FFT i harmoniczne MQS.

Po takim rozdzieleniu wymaganie użytkowe:

```text
antenna_1
├── B Zeeman field
├── airbox field
├── source k-spectrum
├── mode coupling
└── driven S(k,f)
```

staje się naturalną konsekwencją modelu danych, a nie zestawem wyjątków w solverach i frontendzie.

---

## 30. Proweniencja scalenia i wykonane dowody

### 30.1. Co wniósł raport Pro

- szczegółowy rejestr ustaleń `ANT-CRIT`, `ANT-HIGH`, `ANT-MED` i `ANT-LOW`;
- hierarchię wierności Tier 0, Tier 0L, Tier 1, Tier 2 i Tier 3;
- pełniejsze wyprowadzenie Maxwella, przewodnictwa, harmonicznego MQS i
  analitycznych widm prostych anten;
- rozbudowany projekt domenowy, API v2, Control Room, cache signatures,
  migration policy, Definition of Done i listę ADR;
- szczegółową kwalifikację FFT, FEM resampling, multiport i mode overlap.

### 30.2. Co wniósł niezależny audyt repozytorium

- rozstrzygnięcie, że `mqs_2p5d_az` jest compatibility-only infinite-strip
  Biot–Savart, a nie rozwiązaniem FEM $A_z$;
- zasadę full-3D conductor/current solve dla taperu i przewężenia;
- formalny podział `RegionalFieldDrive`, fizycznej anteny, source spectrum i
  dynamic response;
- scoped descriptor `quantity_id="H_ant"`, `source_ref="antenna_1"` oraz
  `unit_transform="mu0_H_to_B"` zamiast dynamicznego globalnego quantity ID;
- osobne projection contracts dla Airboxa i magnetycznego targetu;
- jawne statusy FDM CPU, FDM GPU, FEM CPU i FEM GPU bez hidden fallback;
- wymagane MyST anchors, równania etykietowane, source map i evidence ledger;
- fazę P13 publikacyjnej kwalifikacji.

### 30.3. Wykonane polecenia i wyniki

- walidację symboli wykonano przez inspekcję ścieżek i stabilnych symboli
  wskazanych w sekcji 23 oraz w sąsiednim pliku `.source-map.json`;
- skupione testy Python uruchomiono przez `unittest`: 24 wykonane, 23 przeszły,
  1 zakończył się `FileNotFoundError` dla brakującego repozytoryjnego fixture
  `tests/vlad/4.5GHz_fem.py`;
- `cargo test -p fullmag-ir excitation_analysis -- --nocapture` uruchomiono z
  izolowanym `CARGO_TARGET_DIR=D:\git\fullmag\antenna-audit-target`: 1 pasujący
  test przeszedł, 0 nie przeszło;
- testy walidatora kontraktu dokumentacji naukowej: 23 przeszły, 0 nie przeszło;
- nie wykonano natywnego FEM/MFEM runtime proof ani actual-device GPU proof;
  żaden lane nie został przez ten audyt awansowany do statusu production.

### 30.4. Reguła interpretacji dokumentu

Tabele stanu implementacji i indeks symboli opisują kod istniejący. Typy IR,
zasoby API, ścieżki nowych modułów i przykłady z sekcji 12–16 oraz 26 opisują
rekomendowany projekt. Każde przyszłe wdrożenie musi ponownie sprawdzić źródła,
capability matrix i evidence receipts; niniejszy plan nie jest dowodem, że
planowane elementy już istnieją.

### 30.5. Korekta composition-first po ponownej inspekcji kodu

Ponowna inspekcja wykazała istniejący fundament `CurrentTransport`,
`ChargeTransportDefinitionIR`, `ConservativeCurrentView`, `DirectTetraQuadrature`,
`VectorPotentialSolver`, steady-transport execution, `StageOerstedProvider` oraz quantities
`V_electric`, `J_charge` i `H_oe`. Dokument został skorygowany bez redukcji wyprowadzeń,
FFT, UI, testów, DoD i P13:

- zastąpiono tezę o braku solvera przewodnictwa/Oersteda tezą o braku kompletnego
  charge-only produktu antenowego;
- dodano `ANT-HIGH-013` i `ANT-HIGH-014`;
- ustanowiono łańcuch `PhysicsObject → CurrentTransport → ConservativeCurrentView →
  Oersted → antenna_field_solution.v1 → projection → SolvedAntennaDrive`;
- przepisano normatywne P1–P5 na composition-first, a wcześniejsze warianty zachowano
  jednoznacznie jako archiwalne i odrzucone;
- ustalono `H_ant_basis` jako znormalizowany widok z lineage do `H_oe`, bez drugiego
  solve'u i bez obowiązkowej drugiej kopii payloadu;
- usunięto z rekomendowanego układu modułów równoległe implementacje przewodnictwa,
  rekonstrukcji prądu i Biota–Savarta.

Najważniejsza reguła po korekcie brzmi: obecność kodu operatora jest dowodem istnienia
komponentu, lecz dopiero testy numeryczne, capability resolution i runtime receipts są
dowodem kwalifikacji produktu i konkretnego lane'u.
