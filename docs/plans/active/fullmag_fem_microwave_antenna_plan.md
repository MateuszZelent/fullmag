
# Fullmag — precyzyjny plan implementacji modułu FEM dla pola od anten mikrofalowych nad falowodem magnonicznym

> **Status: superseded historical plan.** The 2.5D-first recommendation below
> cannot represent a CPW or microstrip whose width changes along current flow,
> including a central constriction. Do not execute this file as the active
> implementation plan. The canonical target is now:
>
> - `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`;
> - `docs/adr/0017-staged-antenna-field-basis-workflow.md`;
> - `docs/superpowers/specs/2026-07-10-microwave-antenna-field-basis-design.md`.
>
> References to `native/backends/*`, `apps/web`, and the proposed 2.5D
> production milestones are retained only to document the previous direction.

**Repozytorium docelowe:** `MateuszZelent/fullmag`  
**Zakres planu:** fizyka + dyskretyzacja FEM + CPU/GPU + integracja z `ProblemIR`, plannerem, backendem FEM, UI/control room i mode builderem  
**Cel funkcjonalny:** móc w modelu 3D umieścić nad falowodem magnetycznym antenę mikrofalową typu **microstrip** lub **CPW**, policzyć jej rozkład pola w przybliżeniu magnetoquasistatycznym, wizualizować go w 2D i 3D, pokazywać rozkład amplitudy pola w falowodzie, a następnie wyznaczać **profil pobudzenia fal spinowych** i efektywny profil **wektora falowego** wzbudzania.

---

## 0. Najkrótsza rekomendacja strategiczna

Najlepsza droga dla Fullmaga **nie** polega na zaczynaniu od pełnego 3D solvera elektromagnetycznego dla dowolnych anten.  
Najlepsza droga to trzy warstwy, dokładnie w tej kolejności:

1. **FEM 2.5D (przekrój x-z, niezmienniczość wzdłuż długości anteny)** dla microstrip/CPW z prądem płynącym wzdłuż osi `y`.  
   To dokładnie odpowiada Twojemu wymaganiu: **skończona szerokość, nieskończona długość**.
2. **Ekstruzja wizualizacyjna 3D** tego rozwiązania 2.5D, żeby w GUI mieć pełny model 3D, izolinie/izopowierzchnie i scenę geometryczną.
3. **Pełny 3D solver H(curl)** dopiero jako etap drugi, dla skończonej długości przewodników, efektów końcowych, nieregularnych anten i bardziej złożonych launcherów.

To daje:

- fizycznie poprawny model dla większości klasycznych stripline/CPW nad falowodem magnonicznym,
- bardzo dobry koszt/efekt implementacyjny,
- naturalne dopięcie do obecnej filozofii Fullmaga,
- brak przedwczesnego wejścia w ciężką infrastrukturę 3D H(curl), która dziś byłaby architektonicznie zbyt droga jak na pierwszy milestone.

---

## 1. Jak ten moduł powinien być rozumiany fizycznie

Twoja prośba używa sformułowania „pole magnetostatyczne od anten mikrofalowych”.  
Dla pobudzania fal spinowych najściślej poprawny opis jest taki:

- dla **DC**: rzeczywiście jest to pole magnetostatyczne / statyczne,
- dla **GHz AC**: jest to **pole magnetoquasistatyczne** anteny, czyli czasowo harmoniczne pole bliskie od zadanego prądu, liczone w przybliżeniu, w którym zaniedbujemy pełną propagację elektromagnetyczną w sensie falowym, ale zachowujemy poprawne rozkłady prądu i pola.

Dla geometrii typu mikro-/nano-anteny nad falowodem magnonicznym to jest dokładnie właściwy pierwszy model, o ile:

\[
\frac{L_{\text{układu}}}{\lambda_{\text{EM}}} \ll 1
\]

gdzie \(L_{\text{układu}}\) to typowy rozmiar anteny/stacku, a \(\lambda_{\text{EM}}\) to długość fali elektromagnetycznej dla częstotliwości napędu.  
W praktyce dla GHz i geometrii mikro/nano jest to bardzo dobry reżim roboczy.

### Najważniejsza decyzja modelowa

Ten moduł powinien być traktowany jako **moduł źródła pola antenowego** i **moduł analizy pobudzenia spin-wave**, a nie jako zwykły „kolejny energy term” w prostym sensie.

Powód:

- samo pole anteny jest zewnętrznym polem wymuszającym,
- jego źródłem jest prąd w przewodniku, a nie energia mikromagnetyczna w próbce,
- analiza profilu \(k\) i wzbudzania modów to już warstwa **postprocess / linear response / eigenmode overlap**.

Dlatego architektura powinna mieć dwa poziomy:

1. **Antenna field source**
2. **Spin-wave excitation analysis**

---

## 2. Stan repo i jak się w niego wpiąć

Poniższy plan jest celowo dopasowany do tego, co Fullmag już ma jako architekturę:

- publiczny Python DSL w `packages/fullmag-py`,
- typowane `ProblemIR` w `crates/fullmag-ir`,
- rustowy control plane,
- Next.js control room w `apps/web`,
- backendy natywne `fdm` i `fem` pod `native/backends`.  

Repo jest już jawnie projektowane jako platforma, w której Python serializuje problem do `ProblemIR`, Rust robi walidację/planning, a backendy realizują plan. README opisuje też kierunek FEM jako **MFEM + libCEED + hypre** pod cięższy runtime. W repo są również rozbudowane katalogi `docs/physics`, `docs/specs` i `docs/plans/active`, a w warstwie Pythona istnieje osobny model DSL (`geometry.py`, `energy.py`, `outputs.py`, `problem.py`, `study.py`). Widać też oddzielny control room (`apps/web`) i natywne backendy `fdm`/`fem`. To oznacza, że nowy moduł trzeba dopiąć **w poprzek całego stosu**, a nie jako pojedynczy kernel.  
Źródła orientacyjne w repo: README/architektura oraz układ katalogów `docs/`, `packages/fullmag-py/`, `apps/web/`, `native/backends/`. 

### Najważniejszy wniosek architektoniczny

Fullmag ma już dobrą strukturę do takiego rozszerzenia, ale trzeba ją wykorzystać w sposób spójny:

- **nota fizyczna** w `docs/physics/`,
- rozszerzenie **DSL**,
- rozszerzenie **IR**,
- rozszerzenie **plannerów**,
- rozszerzenie **backendu FEM**,
- rozszerzenie **quantity registry / control room**,
- rozszerzenie **analizy modów i profilu \(k\)**.

---

## 3. Zakres funkcjonalny modułu docelowego

### 3.1 Wersja minimum, która już daje dużą wartość

Użytkownik może:

1. dodać do sceny falowód magnetyczny,
2. dodać nad nim antenę:
   - `MicrostripAntenna`
   - `CPWAntenna`
3. zadać:
   - szerokość przewodnika,
   - grubość,
   - wysokość nad falowodem,
   - długość wizualizacyjną,
   - prąd / amplitudę / częstotliwość / fazę,
4. policzyć pole:
   - \(H_{\text{ant}}(x,z)\) w przekroju,
   - ekstruzję 3D tego pola,
5. obejrzeć:
   - 2D heatmapę,
   - izolinie jak na Twoim przykładzie,
   - 3D izopowierzchnie / slice planes,
   - rozkład amplitudy pola w regionie falowodu,
6. policzyć szybki profil źródłowy \( \tilde{h}(k) \) anteny.

### 3.2 Wersja właściwa naukowo

Dodatkowo można:

1. sprzęgnąć pole antenowe z mikromagnetycznym solverem FEM,
2. policzyć stan równowagi falowodu,
3. policzyć:
   - odpowiedź wymuszoną w czasie,
   - albo mody własne i ich overlap z polem anteny,
4. wyznaczyć:
   - które mody są wzbudzane,
   - z jaką siłą,
   - dla jakiego zakresu \(k\),
   - z jaką selektywnością symetrii.

### 3.3 Wersja docelowa high-end

Dodatkowo:

- pełny 3D solver skończonej długości,
- nieregularne anteny,
- wieloprzewodnikowe układy RF,
- prąd z solvera przewodzenia,
- tryb harmoniczny,
- tryb transient RF burst,
- pełny pipeline „antenna → micromagnetics → spectrum \(S(k,\omega)\)”.

---

## 4. Geometria i układ współrzędnych

Żeby plan był precyzyjny i nie rozjechał się numerycznie, trzeba ustalić **kanoniczny lokalny układ anteny**.

### 4.1 Zalecany lokalny frame

Przyjmujemy:

- oś `x` — oś **szerokości anteny** i jednocześnie typowa oś propagacji fali spinowej w falowodzie,
- oś `y` — oś **długości anteny**; dla etapu 2.5D antena jest nieskończona wzdłuż `y`,
- oś `z` — normalna do stacku, „góra–dół”.

Wtedy:

- prąd w microstrip/CPW płynie głównie jako \(J_y\),
- przekrój obliczeniowy 2.5D to płaszczyzna **\(x\)-\(z\)**,
- profil \(k\) dla pobudzenia fali spinowej jest naturalnie liczony względem \(k_x\).

### 4.2 Geometrie anten

#### Microstrip
- centralny przewodnik o szerokości \(w\),
- grubość \(t_c\),
- wysokość nad falowodem \(h\),
- opcjonalna warstwa dielektryczna i ground plane.

#### CPW
- pasek sygnałowy o szerokości \(w_s\),
- szczeliny \(g\),
- dwa groundy o szerokości \(w_g\),
- prąd sygnałowy i prądy powrotne.

### 4.3 Geometrie falowodu

Na start trzeba wspierać:

- prosty falowód prostokątny,
- importowany falowód z geometrii użytkownika,
- wielowarstwowy stack: magnet + spacer + antena + dielektryk + ground.

---

## 5. Fizyka — pełne wyprowadzenie modelu pola antenowego

## 5.1 Równania bazowe — magnetoquasistatyka z zadanym prądem

W obszarze roboczym \(\Omega\) rozróżniamy regiony:

- przewodnik anteny \(\Omega_c\),
- dielektryk/substrat \(\Omega_d\),
- powietrze \(\Omega_a\),
- falowód magnetyczny \(\Omega_m\).

Na pierwszym etapie solver pola antenowego ma być **jednokierunkowy**:
prąd anteny generuje pole, a sam falowód magnetyczny nie wpływa zwrotnie na rozkład prądu i pola źródłowego.

To jest bardzo ważne uproszczenie pierwszej wersji:

- jest fizycznie sensowne dla słabego sprzężenia,
- drastycznie upraszcza solver,
- pozwala potraktować pole antenowe jako zewnętrzny drive dla LLG.

### 5.1.1 Równania Maxwella w reżimie MQS

\[
\nabla \times \mathbf{H} = \mathbf{J}_{\mathrm{imp}}
\]

\[
\nabla \cdot \mathbf{B} = 0
\]

\[
\mathbf{B} = \mu \mathbf{H}
\]

gdzie:

- \(\mathbf{J}_{\mathrm{imp}}\) — zadana gęstość prądu w przewodniku,
- \(\mu\) — przenikalność magnetyczna ośrodka.

W pierwszym etapie dla regionów nie-magnetycznych przyjmujemy najczęściej:

\[
\mu = \mu_0
\]

a w regionie falowodu magnetycznego w solverze źródła także zalecam startowo:

\[
\mu \approx \mu_0
\]

zamiast wprowadzać od razu efektywną dynamiczną podatność.  
Pole źródłowe ma być najpierw policzone jako **impressed external field**, a nie jako w pełni sprzężony problem RF–micromagnetics.

---

## 5.2 Formulacja 2.5D dla przewodnika nieskończonego wzdłuż `y`

To jest rdzeń całego planu i najważniejsza część.

Zakładamy translacyjną niezmienniczość wzdłuż `y` i prąd:

\[
\mathbf{J}_{\mathrm{imp}}(x,z) = J_y(x,z)\,\mathbf{e}_y
\]

Szukamy wektorowego potencjału w postaci:

\[
\mathbf{A}(x,z) = A_y(x,z)\,\mathbf{e}_y
\]

Wtedy:

\[
\mathbf{B} = \nabla \times \mathbf{A}
\]

czyli:

\[
B_x = \frac{\partial A_y}{\partial z},
\qquad
B_z = -\frac{\partial A_y}{\partial x},
\qquad
B_y = 0
\]

oraz:

\[
\mathbf{H} = \mu^{-1}\mathbf{B}
\]

Podstawienie do równania Ampère’a daje skalarne równanie eliptyczne:

\[
-\nabla_{\perp}\cdot\left(\mu^{-1}\nabla_{\perp} A_y\right)=J_y
\]

gdzie \(\nabla_{\perp}\) działa w płaszczyźnie \(x\)-\(z\).

To jest **najlepsza możliwa postać baseline’owego solve’u**, bo:

- jest dokładnie dopasowana do „nieskończonej długości”,
- jest skalarna,
- używa przestrzeni \(H^1\), a nie od razu \(H(\mathrm{curl})\),
- świetnie mapuje się na obecną filozofię FEM w Fullmagu.

### 5.2.1 Słaba postać 2.5D

Szukamy \(A_y \in V\), takie że dla wszystkich funkcji testowych \(v \in V\):

\[
\int_{\Omega_{xz}} \mu^{-1}\nabla A_y \cdot \nabla v \, d\Omega
=
\int_{\Omega_c} J_y\, v \, d\Omega
\]

To jest klasyczny problem typu Poisson/diffusion z wymuszeniem objętościowym.

### 5.2.2 Warunki brzegowe

Na zewnętrznej granicy obszaru powietrza \(\partial \Omega_{\infty}\) baseline:

\[
A_y = 0
\]

na dostatecznie dużym air-boxie.

Wersja lepsza:

- shell transform,
- infinite elements,
- specjalny open-boundary map.

**Rekomendacja:**  
w v1 użyć **air-box + Dirichlet** z obowiązkowym testem zbieżności względem rozmiaru boxa.

### 5.2.3 Odczyt pola

Po solve’ie:

\[
H_x = \mu^{-1}\frac{\partial A_y}{\partial z}
\]

\[
H_z = -\mu^{-1}\frac{\partial A_y}{\partial x}
\]

\[
|\mathbf{H}| = \sqrt{H_x^2 + H_z^2}
\]

To daje dokładnie to, co chcesz wizualizować w przekroju 2D.

---

## 5.3 Microstrip i CPW jako modele źródła prądu

### 5.3.1 Microstrip — baseline

W przewodniku:

\[
J_y(x,z) =
\begin{cases}
I/(w\,t_c), & (x,z)\in \Omega_c \\
0, & \text{poza przewodnikiem}
\end{cases}
\]

czyli prąd objętościowy jednorodny.

To jest wersja minimum.

### 5.3.2 CPW — baseline

Mamy trzy regiony przewodzące:

- pasek sygnałowy: \(+\;I_s\),
- dwa groundy: \(-I_g\), \(-I_g\),

z warunkiem globalnym:

\[
I_s + 2I_g = 0
\]

W prostym symetrycznym modelu:

\[
I_g = -\frac{I_s}{2}
\]

### 5.3.3 Rozszerzenia późniejsze

Na dalszych etapach:

1. **sheet current**
2. **edge-crowded quasi-static current profile**
3. **skin-depth-aware profile**
4. **current distribution from electrostatic / conduction solver**

To trzeba przewidzieć w IR już teraz.

---

## 5.4 Dynamiczne pole anteny

Dla wymuszenia harmonicznego:

\[
I(t) = I_0 \cos(\omega t + \phi)
\]

lub w zapisie zespolonym:

\[
I(t)=\Re\{\hat I e^{i\omega t}\}
\]

Ponieważ problem źródłowy jest liniowy, wystarczy policzyć pole znormalizowane do \(I=1\), a potem skalować:

\[
\mathbf{H}_{\mathrm{ant}}(\mathbf{r}, t)=
\Re\left\{
\hat I \,\mathbf{H}_{\mathrm{ant},1\mathrm{A}}(\mathbf{r}) e^{i\omega t}
\right\}
\]

To jest bardzo ważna optymalizacja:

- solve geometrii robisz raz,
- w czasie tylko skalujesz pole,
- dla sweepów po amplitudzie/fazie koszt jest marginalny.

---

## 5.5 Sprzężenie z mikromagnetyzmem

Pole anteny wchodzi do LLG jako część wymuszenia zewnętrznego:

\[
\mathbf{H}_{\mathrm{eff}}
=
\mathbf{H}_{\mathrm{ex}}
+
\mathbf{H}_{\mathrm{demag}}
+
\mathbf{H}_{\mathrm{ani}}
+
\mathbf{H}_{\mathrm{ext}}
+
\mathbf{H}_{\mathrm{ant}}
+\cdots
\]

Dla drive RF:

\[
\mathbf{H}_{\mathrm{ant}}(\mathbf{r},t)=
\Re\left\{
\hat{\mathbf{h}}_{\mathrm{rf}}(\mathbf{r})e^{i\omega t}
\right\}
\]

a moment wymuszający jest:

\[
\boldsymbol{\tau}_{\mathrm{rf}}
=
-\gamma\mu_0 \mathbf{m}\times \mathbf{H}_{\mathrm{ant}}
\]

---

## 5.6 Jak formalnie zdefiniować „profil wektora falowego” anteny

To jest kluczowe, bo tu łatwo zrobić coś ładnego wizualnie, ale naukowo źle zdefiniowanego.

### 5.6.1 Czego nie robić

Nie należy twierdzić, że z samego statycznego pola natychmiast „wychodzi \(k\)”.  
Samo pole źródłowe ma tylko **widmo przestrzenne**; faktycznie wzbudzane \(k\)-składowe zależą jeszcze od:

- geometrii falowodu,
- stanu równowagi,
- relacji dyspersyjnej,
- polaryzacji modów,
- orientacji pola względem \(\mathbf{m}_0\).

### 5.6.2 Poprawna definicja na trzech poziomach

#### Poziom A — szybki profil źródła
Policz przestrzenne widmo pola anteny w osi propagacji:

\[
\tilde{\mathbf{h}}(k_x,z) = \int h(x,z)e^{-ik_x x}\,dx
\]

To daje **source spectrum**.

#### Poziom B — profil skuteczności pobudzenia
Policz overlap z modami własnymi lub liniowymi stanami falowodu:

\[
\eta_n
=
\left|
\int_{\Omega_m}
\hat{\mathbf{h}}_{\mathrm{rf}}(\mathbf{r})
\cdot
\mathbf{W}_n(\mathbf{r})
\, dV
\right|^2
\]

gdzie \(\mathbf{W}_n\) to odpowiednia funkcja wagowa / mod sprzężony / adjoint mode.

To daje **mode coupling strength**.

#### Poziom C — rzeczywisty profil wzbudzonych fal
Uruchom symulację wymuszoną i policz z odpowiedzi magnetyzacji:

\[
S(k_x,\omega)
=
\left|
\mathcal{F}_{x,t}
\left[m(x,t)\right]
\right|^2
\]

To daje **rzeczywiste wzbudzenie** wraz z tłumieniem, dyspersją i selekcją modów.

### 5.6.3 Rekomendacja produktu

W GUI i w API trzeba jawnie rozróżnić trzy quantity:

1. `antenna_source_k_profile`
2. `mode_overlap_spectrum`
3. `driven_response_S_k_omega`

Wtedy użytkownik nie miesza:
- co umie sama antena jako źródło,
- co przyjmuje falowód jako układ modalny,
- co faktycznie wychodzi z dynamiki.

---

## 6. Szybkie analityczne wzory referencyjne dla widma \(k\)

Te wzory są bardzo przydatne jako:

- walidacja,
- szybki preview bez solve’u,
- sanity-check w GUI.

### 6.1 Microstrip o szerokości \(w\)

Dla jednorodnego rozkładu po szerokości, widmo źródła w osi propagacji ma obwiednię:

\[
\tilde{h}(k_x) \propto \operatorname{sinc}\left(\frac{k_x w}{2}\right)e^{-|k_x|h_{\mathrm{eff}}}
\]

gdzie:

- \(w\) — szerokość paska,
- \(h_{\mathrm{eff}}\) — efektywna odległość od falowodu.

To mówi od razu:

- węższa antena pobudza szersze pasmo \(k\),
- większa odległość nad falowodem tłumi duże \(k\).

### 6.2 CPW

Dla CPW widmo jest różnicą wkładów od sygnału i groundów, więc ma silną zależność od symetrii:

\[
\tilde{J}(k_x)
=
I_s\,F_s(k_x)
-
I_g\,F_{g1}(k_x)
-
I_g\,F_{g2}(k_x)
\]

W wersji symetrycznej daje to selektywność modów parzystych/nieparzystych.  
To jest bardzo cenna cecha naukowa CPW i warto ją od razu uwzględnić w GUI jako „symmetry hint”.

---

## 7. Rekomendowana architektura solverów

## 7.1 Solver A — `mqs_2p5d_az` (obowiązkowy pierwszy milestone)

### Charakter
- przekrój 2D w \(x\)-\(z\),
- prąd \(J_y\),
- solve skalarnego \(A_y\),
- H1 FEM,
- air-box open boundary.

### Plusy
- najprostszy i najbardziej trafny dla Twojego przypadku,
- bardzo szybki,
- zgodny z istniejącą filozofią FEM H1 w Fullmagu,
- idealny do microstrip i CPW.

### Wniosek
To ma być **pierwszy produkcyjny solver**.

---

## 7.2 Solver B — `mqs_3d_hcurl` (drugi milestone)

### Charakter
Pełne 3D:

\[
\nabla \times (\mu^{-1}\nabla \times \mathbf{A}) = \mathbf{J}_{\mathrm{imp}}
\]

z gauge stabilization, np.

\[
\int_\Omega \mu^{-1}(\nabla\times\mathbf{A})\cdot(\nabla\times\mathbf{v})\,dV
+
\alpha_g \int_\Omega (\nabla\cdot\mathbf{A})(\nabla\cdot\mathbf{v})\,dV
=
\int_{\Omega_c}\mathbf{J}_{\mathrm{imp}}\cdot\mathbf{v}\,dV
\]

### Przestrzeń dyskretyzacji
- Nédélec \(H(\mathrm{curl})\)

### Zastosowanie
- skończona długość,
- efekty końcowe,
- launchery nieregularne,
- skośne orientacje,
- przewodniki 3D nieekstrudowane.

### Uwaga
To jest solver znacznie cięższy architektonicznie, bo wymaga wejścia w FE spaces poza H1.

### Wniosek
To nie może być pierwszy milestone.

---

## 7.3 Solver C — `conduction_plus_mqs` (etap późniejszy)

Najpierw solve rozkładu prądu w przewodniku/dielektryku:

\[
\nabla\cdot(\sigma \nabla \phi)=0
\]

potem:

\[
\mathbf{J}=-\sigma \nabla \phi
\]

a następnie pole MQS z tego \( \mathbf{J} \).

To przyda się dla:

- crowdingu,
- skomplikowanych przekrojów,
- realistycznych stacków metalicznych.

---

## 8. Dyskretyzacja FEM — precyzyjny plan

## 8.1 Etap 2.5D

### 8.1.1 Domena
Przekrój \(x\)-\(z\), zawierający:

- przewodnik(i),
- spacer/dielektryk,
- falowód magnetyczny,
- powietrze,
- opcjonalny ground.

### 8.1.2 Przestrzeń
\[
V_h \subset H^1(\Omega_{xz})
\]

dla skalarnego \(A_y\).

### 8.1.3 Elementy
- trójkąty lub czworokąty w 2D,
- rekomendacja: trójkąty jako baseline, bo naturalnie pasują do przyszłego eksportu z Gmsh.

### 8.1.4 Słaba postać dyskretna

Szukamy \(A_{y,h}\in V_h\) takiego, że:

\[
\int_{\Omega_{xz}}
\mu^{-1}\nabla A_{y,h}\cdot\nabla v_h\,d\Omega
=
\int_{\Omega_c}
J_y v_h\,d\Omega
\qquad \forall v_h\in V_h
\]

### 8.1.5 Odczyt pola

W kwadraturze lub na węzłach:

\[
H_{x,h}=\mu^{-1}\partial_z A_{y,h}
\]

\[
H_{z,h}=-\mu^{-1}\partial_x A_{y,h}
\]

oraz potem projekcja do quantity export.

### 8.1.6 Interpolacja do falowodu magnetycznego

Pole antenowe ma być przechowywane jako:

- FE field na tej samej siatce 2D,
- albo jako samplowany field w regionie falowodu,
- albo po ekstruzji jako 3D sampled field.

Najbardziej praktyczne:

- solver trzyma **mesh-native field**,
- control room i coupling do LLG dostają:
  - `node` / `element` values,
  - oraz opcjonalny kartezjański sampling do porównań.

---

## 8.2 Etap 3D

### 8.2.1 Domena
Pełny 3D mesh: przewodniki + dielektryki + powietrze + falowód magnetyczny.

### 8.2.2 Przestrzeń
\[
\mathbf{A}_h \in \mathcal{N}_h \subset H(\mathrm{curl})
\]

### 8.2.3 Preconditioner
Dla pełnego H(curl) trzeba od razu planować właściwy preconditioning:

- AMS/ADS w hypre, jeśli ścieżka technologiczna na to pozwala,
- ewentualnie mixed formulation z pomocniczym skalarowym potencjałem,
- benchmark gate przed promowaniem do production path.

### 8.2.4 Wniosek praktyczny
Dla etapu v1 nie należy uzależniać całego feature’u od wejścia w H(curl).

---

## 9. Coupling do mikromagnetycznego solve’u FEM

## 9.1 Najlepszy wariant v1

Pole antenowe traktować jako **zewnętrzne pole narzucone**:

\[
\mathbf{H}_{\mathrm{ext,total}}
=
\mathbf{H}_{\mathrm{bias}}
+
\mathbf{H}_{\mathrm{ant}}
\]

Dla DC:
- `H_ant` jest po prostu statycznym biasem.

Dla RF:
- `H_ant` jest znormalizowanym spatial profile,
- runner mnoży go przez envelope \(I(t)\).

### Dlaczego to jest najlepsze
- nie miesza solvera pola antenowego z solve’em LLG,
- jest zgodne z istniejącą semantyką `Zeeman`/external field,
- pozwala łatwo przechodzić od „field-only” do „field+LLG”.

---

## 9.2 Wersja linear-response / eigenmodes

Po wyznaczeniu stanu równowagi \(\mathbf{m}_0\), liniaryzujemy LLG wokół \(\mathbf{m}_0\) i liczymy mody własne falowodu.

Pole anteny \(\hat{\mathbf{h}}_{\mathrm{rf}}\) traktujemy jako wymuszenie.  
Współczynnik pobudzenia modu \(n\):

\[
c_n(\omega)
\propto
\frac{
\langle \mathbf{w}_n, \hat{\mathbf{h}}_{\mathrm{rf}} \rangle
}{
\omega - \omega_n + i\Gamma_n
}
\]

gdzie:

- \(\mathbf{w}_n\) — odpowiedni mod/adjoint mode,
- \(\omega_n\) — częstotliwość modu,
- \(\Gamma_n\) — efektywne tłumienie.

### Co z tego dostajesz
- bardzo szybkie wyznaczanie, które mody są wzbudzane,
- możliwość narysowania „excitation efficiency vs mode / vs \(k\)”.

### Związek z obecnym Fullmagiem
Repo już ma kierunek eigenmode/FEM, więc ten moduł trzeba z nim celowo spiąć, a nie budować osobno.

---

## 9.3 Wersja time-domain

Uruchamiasz:

- equilibrium,
- RF drive w czasie,
- sampling \(m(x,t)\) na linii/falowodzie,
- FFT w czasie i przestrzeni.

Wtedy:

\[
S(k_x,\omega)
=
\left|
\mathcal{F}_{x,t}[m(x,t)]
\right|^2
\]

To jest najlepsza „prawdziwa” odpowiedź, ale obliczeniowo najdroższa.

### Rekomendacja
W produkcie mieć trzy tryby:

1. **preview source \(k\)**
2. **mode overlap**
3. **driven response**

---

## 10. Proponowany publiczny Python DSL

## 10.1 Nowe obiekty

### Geometria źródła
```python
MicrostripAntenna(...)
CPWAntenna(...)
```

### Drive
```python
RfDrive(
    current_a=...,
    frequency_hz=...,
    phase_rad=...,
    waveform=Constant() | Sinusoidal() | Pulse() | PiecewiseLinear(...)
)
```

### Solver/source
```python
AntennaFieldSource(
    name="cpw1",
    antenna=CPWAntenna(...),
    drive=RfDrive(...),
    solver="mqs_2p5d_az",
)
```

### Analiza
```python
SpinWaveExcitationAnalysis(
    source="cpw1",
    method="source_k_profile" | "mode_overlap" | "driven_response",
    propagation_axis=(1, 0, 0),
)
```

---

## 10.2 Przykład minimum

```python
problem = fm.Problem(
    name="cpw_over_waveguide",
    magnets=[waveguide],
    energy=[
        fm.Exchange(),
        fm.Demag(),
        fm.Zeeman(B=(0, 0, 0.08)),
    ],
    current_modules=[
        fm.AntennaFieldSource(
            name="cpw",
            antenna=fm.CPWAntenna(
                signal_width=1.2e-6,
                gap=0.3e-6,
                ground_width=2.0e-6,
                thickness=150e-9,
                height_above_waveguide=80e-9,
                preview_length=12e-6,
            ),
            drive=fm.RfDrive(
                current_a=5e-3,
                frequency_hz=8e9,
                phase_rad=0.0,
            ),
            solver="mqs_2p5d_az",
        ),
    ],
    study=fm.TimeEvolution(
        dynamics=fm.LLG(integrator="rk45"),
        outputs=[
            fm.SaveField("H_ant", every=1e-12),
            fm.SaveField("H_ant_magnitude", every=1e-12),
            fm.SaveScalar("antenna_source_k_profile", every=5e-12),
        ],
    ),
)
```

---

## 11. Proponowane rozszerzenie IR

## 11.1 Kluczowa decyzja

Nie polecam upychania tego jako kolejny wariant w `EnergyTermIR` na dłuższą metę.  
`OerstedCylinder` już jest w repo jako precedens przejściowy, ale dla anten microstrip/CPW moduł powinien być częścią bardziej ogólnej rodziny **current / antenna modules**.

### Rekomendacja
Wprowadzić nowe typowane sekcje:

- `CurrentModuleIR`
- `AntennaIR`
- `ExcitationAnalysisIR`

z backward compatibility do istniejących pól.

---

## 11.2 Kształt IR — propozycja

```json
{
  "current_modules": [
    {
      "kind": "antenna_field_source",
      "name": "cpw1",
      "solver": "mqs_2p5d_az",
      "antenna": {
        "kind": "cpw",
        "signal_width": 1.2e-6,
        "gap": 0.3e-6,
        "ground_width": 2.0e-6,
        "thickness": 150e-9,
        "height_above_waveguide": 80e-9,
        "preview_length": 12e-6
      },
      "drive": {
        "kind": "sinusoidal",
        "current_a": 0.005,
        "frequency_hz": 8.0e9,
        "phase_rad": 0.0
      },
      "boundary": {
        "kind": "air_box",
        "factor": 12.0
      }
    }
  ],
  "excitation_analysis": {
    "kind": "mode_overlap",
    "source": "cpw1",
    "propagation_axis": [1, 0, 0]
  }
}
```

---

## 11.3 Minimalne zmiany w istniejącym `FemPlanIR`

Dodać:

- `antenna_sources: Vec<FemAntennaSourceIR>`
- `excitation_analysis: Option<SpinWaveExcitationPlanIR>`
- `mqs_solver_policy`
- `air_box_policy`
- `field_projection_policy`
- `preview_extrusion_policy`

---

## 11.4 Rekomendowane typy

### `FemAntennaSourceIR`
- `name`
- `kind = microstrip | cpw`
- `solver = mqs_2p5d_az | mqs_3d_hcurl`
- `geometry`
- `drive`
- `region_roles`
- `current_profile_model`
- `boundary_policy`
- `preview_length`

### `SpinWaveExcitationPlanIR`
- `method = source_k_profile | mode_overlap | driven_response`
- `source_name`
- `propagation_axis`
- `sampling_line`
- `k_range`
- `frequency_range`
- `windowing`
- `fft_policy`

---

## 12. Planner — jak to obniżać do backendu

## 12.1 Planner responsibilities

Planner musi zrobić:

1. walidację geometrii anteny,
2. walidację, czy przypadek kwalifikuje się do 2.5D,
3. budowę mesha przekroju lub pełnego mesha 3D,
4. przypisanie region roles:
   - conductor
   - dielectric
   - air
   - magnetic waveguide
5. wybór solvera:
   - `mqs_2p5d_az` jeśli geometria zgodna,
   - `mqs_3d_hcurl` jeśli nie,
6. budowę planu projection/coupling do magnetyzacji,
7. rejestrację nowych quantities i artefaktów.

---

## 12.2 Reguła wyboru solvera

### `mqs_2p5d_az` gdy:
- antena jest ekstrudowana wzdłuż jednej osi,
- prąd płynie wzdłuż osi ekstruzji,
- geometria wzdłuż tej osi jest niezmienna,
- użytkownik nie wymaga efektów końcowych.

### `mqs_3d_hcurl` gdy:
- długość skończona ma znaczenie fizyczne,
- są zakręty / feedline / pads,
- są end effects,
- orientacja jest skośna lub nieekstrudowana.

---

## 13. Backend FEM — plan implementacyjny

## 13.1 Etap M1 — solver 2.5D `A_y`

### 13.1.1 Nowy moduł natywny
`native/backends/fem/src/antenna_mqs_2p5d.cpp`

Zakres:
- mesh 2D,
- FE space H1,
- assembled bilinear form,
- source term \(\int J_y v\),
- solve,
- recovery \(H_x, H_z\),
- sampling/export.

### 13.1.2 Dlaczego assembled first
Dla tego solve’u na starcie:
- operator jest eliptyczny,
- skalarowy,
- mały/średni,
- prosto benchmarkowalny.

To powinno wejść jako:
- CPU reference assembled,
- potem GPU assembled/hypre,
- dopiero później PA/libCEED, jeśli benchmark pokaże sens.

---

## 13.2 Etap M2 — field normalization i reusable source field

Po solve’ie przechowujesz:

- `H_ant_per_1A`
- komponenty,
- magnitude,
- ewentualnie gradienty

i runner tylko skaluje przez drive:

\[
\mathbf{H}_{\mathrm{ant}}(t)=I(t)\,\mathbf{H}_{\mathrm{ant},1A}
\]

To jest bardzo ważne dla wydajności.

---

## 13.3 Etap M3 — projection do mesh micromagnetycznego

Potrzebujesz:

- wspólnego mesha,
- albo operatora projekcji `source_mesh -> magnetic_mesh`.

### Rekomendacja
Dla v1 użyć wspólnego przekroju regionowego, bo:

- antenna field solve i magnetyzacja dotyczą tej samej fizycznej sceny,
- unikasz niepotrzebnej interpolacji,
- łatwiej robić debug i GUI.

Dla pełnego 3D później można dopuścić dual mesh.

---

## 13.4 Etap M4 — CPW

CPW nie wymaga nowego solvera; wymaga tylko:

- wieloregionowego prądu źródłowego,
- prawidłowego balance current,
- sensownego UI/model buildera.

To jest świetny milestone, bo daje dużą wartość naukową przy małym koszcie względem M1.

---

## 13.5 Etap M5 — szybki profil \(k\)

Nowy moduł analizy:
`native/backends/fem/src/antenna_excitation_k.cpp`

Zakres:
- sampling pola w linii falowodu,
- FFT po osi propagacji,
- okna,
- normalizacja,
- eksport jako quantity.

---

## 13.6 Etap M6 — mode overlap

Nowy moduł:
`native/backends/fem/src/antenna_mode_overlap.cpp`

Zakres:
- pobranie modów własnych z solve’u eigen,
- obliczenie overlap integrals,
- ranking modów,
- eksport:
  - `mode_overlap`
  - `mode_overlap_vs_frequency`
  - `mode_overlap_vs_k`

---

## 13.7 Etap M7 — full 3D H(curl)

Nowy moduł:
`native/backends/fem/src/antenna_mqs_3d.cpp`

Zakres:
- Nédélec FE space,
- assembled H(curl) solve,
- gauge stabilization,
- recovery field,
- sampling/export.

---

## 14. CPU i GPU — dokładny plan numeryczny

## 14.1 CPU baseline

### 2.5D
- assembled sparse matrix,
- CG + AMG / algebraic multigrid,
- double precision,
- benchmark/reference path.

### Dlaczego
- przewidywalność,
- łatwy debug,
- dobra baza walidacyjna.

---

## 14.2 GPU baseline

### Dla 2.5D `A_y`
- operator assembled,
- device-resident vectors,
- hypre GPU CG+AMG,
- asynchroniczny sampling/export.

### Kluczowa zasada
Najpierw:
- **device-resident solve**
- brak per-step host/device bounce
- reuse solve dla `1 A`

Dopiero potem:
- partial assembly,
- libCEED,
- aggressive fusion.

### Wniosek
Dla tego modułu dokładnie tak samo jak w obecnej filozofii pełnego solvera FEM:
**measurement-driven**, a nie „PA wszędzie od razu”.

---

## 14.3 GPU path dla dynamicznego drive

W trybie time-domain runner NIE rozwiązuje pola od nowa co krok, tylko:

1. ma `H_ant_per_1A` na GPU,
2. ma `I(t)` lub \(\hat I e^{i\omega t}\),
3. robi prosty kernel:
   - scale,
   - add do `H_eff`.

To daje bardzo tani runtime.

---

## 14.4 Gdzie GPU naprawdę jest potrzebne

Największy koszt będzie w:

- pełnym solve mikromagnetycznym,
- driven response time-domain,
- ewentualnie full 3D H(curl).

Sam solver 2.5D źródła pola jest relatywnie tani i może być nawet liczony CPU-first w v1.

---

## 15. Open boundary i far-field

## 15.1 Baseline v1
- air-box,
- Dirichlet \(A_y=0\),
- obowiązkowa walidacja zbieżności względem rozmiaru boxa.

## 15.2 v2
- shell transform / mapped infinite layer.

## 15.3 v3
- bardziej zaawansowane infinite-element / BEM-like boundary.

### Wniosek
Dla microstrip/CPW nad falowodem air-box na start jest całkowicie akceptowalny, o ile:
- jest jawny w planie,
- ma test zbieżności,
- nie udaje rozwiązania dokładnie otwartego.

---

## 16. Model builder i UI — jak to spiąć

## 16.1 W model builderze

Nowa sekcja: **Antenna / RF Source**

Pola:

- typ:
  - microstrip
  - CPW
- szerokości
- grubość
- wysokość nad falowodem
- długość wizualizacyjna
- oś przewodzenia
- częstotliwość
- amplituda prądu
- faza
- solver:
  - 2.5D
  - 3D
- tryb analizy:
  - pole tylko
  - source \(k\)
  - mode overlap
  - driven response

### UI constraints
Jeśli użytkownik wybiera `2.5D`, builder powinien:
- wymuszać geometrię ekstrudowalną,
- blokować nieregularne feedline’y,
- pokazywać ostrzeżenie, gdy scena nie jest zgodna z założeniem.

---

## 16.2 Control room — quantity-driven integration

Zgodnie z filozofią quantity-driven trzeba dodać quantity:

### Vector fields
- `H_ant`
- `H_ant_rf`
- `B_ant` (opcjonalnie)

### Scalar fields
- `H_ant_magnitude`
- `H_ant_x`
- `H_ant_y`
- `H_ant_z`

### Global / analytic / spectral
- `antenna_source_k_profile`
- `mode_overlap`
- `mode_overlap_ranked`
- `S_k_omega`

### Derived visualization quantities
- `H_ant_in_waveguide`
- `H_ant_transverse_to_m0`
- `H_ant_parallel_to_m0`

To jest ważne, bo w praktyce dla pobudzenia spin-wave istotny jest komponent poprzeczny do \(\mathbf{m}_0\), a nie tylko całe \(|H|\).

---

## 16.3 Widoki 2D

### View A — przekrój x-z
- heatmapa \(|H|\),
- kontury/izolinie,
- obrys przewodnika,
- obrys falowodu,
- możliwość wyboru komponentu,
- możliwość overlay z `m0`.

To ma odpowiadać dokładnie wrażeniu z obrazka, który podałeś.

### View B — source spectrum
- wykres \(|\tilde{h}(k)|\),
- log/linear scale,
- porównanie analytic vs FEM.

---

## 16.4 Widoki 3D

### Dla 2.5D
Nie liczysz pełnego 3D pola fizycznie; tworzysz **ekstruzję wizualizacyjną** po osi `y`:

- scena 3D z anteną i falowodem,
- izopowierzchnie \(|H|\),
- slice planes,
- strzałki wektorowe rzadko próbkowane,
- opcjonalne streamlines.

### Dla 3D full solve
- pełne iso-surfaces,
- volumetric slices,
- streamlines.

### Krytyczna uwaga
W UI trzeba uczciwie oznaczyć tryb:
- `physics = 2.5D`
- `3D preview = extruded`

żeby użytkownik nie mylił tego z pełnym 3D physics solve.

---

## 16.5 Eventing i artefakty

W sesji/runie:
- event stream tylko sygnalizuje dostępność nowych frame’ów / nowych spectrum,
- ciężkie pola pobierane przez run endpoints.

Artefakty:

```text
fields/H_ant/...
fields/H_ant_magnitude/...
spectra/antenna_source_k_profile/...
analysis/mode_overlap/...
analysis/S_k_omega/...
```

---

## 17. Jak spiąć to z istniejącym pipeline’em badań modów własnych

Repo już ma kierunek FEM eigenmodes. Nowy moduł powinien korzystać z tego, a nie dublować.

### 17.1 Wersja minimalna
- solve equilibrium,
- solve eigenmodes,
- compute overlap.

### 17.2 Konieczne rozszerzenia
`KSamplingIR` w obecnym duchu trzeba rozszerzyć z pojedynczego punktu do:
- 1D sweep po \(k\),
- path,
- uniform line sampling.

### 17.3 Rekomendowana semantyka
Nie dodawać od razu nowego top-level `StudyIR`, tylko:
- zachować `Eigenmodes`,
- dodać `excitation_analysis`,
- dodać `driving_field_ref`.

To minimalizuje chirurgię architektoniczną.

---

## 18. Plan zmian plik-po-pliku

## 18.1 Dokumentacja fizyczna
Dodać:

- `docs/physics/0610-fem-mqs-microwave-antenna-fields.md`
- `docs/physics/0615-fem-microstrip-cpw-spin-wave-excitation.md`

### 0610 powinien zawierać
- równania MQS,
- 2.5D \(A_y\),
- 3D H(curl),
- SI units,
- wpływ na Python API i IR,
- validation.

### 0615 powinien zawierać
- microstrip/CPW geometry,
- source spectrum,
- coupling do spin waves,
- mode overlap,
- \(S(k,\omega)\).

---

## 18.2 Python DSL
Dodać:

- `packages/fullmag-py/src/fullmag/model/current.py`
- eksport w `packages/fullmag-py/src/fullmag/model/__init__.py`

Klasy:
- `MicrostripAntenna`
- `CPWAntenna`
- `RfDrive`
- `AntennaFieldSource`
- `SpinWaveExcitationAnalysis`

Opcjonalnie helpery:
- `SaveSpectrum`
- `SaveKProfile`

---

## 18.3 IR
Refactor lub rozszerzenie:

- `crates/fullmag-ir/src/lib.rs`
  - dodać `CurrentModuleIR`
  - dodać `AntennaIR`
  - dodać `ExcitationAnalysisIR`
  - dodać nowe enumy solver/policy

Jeśli nie chcesz od razu robić dużego refactoru:
- najpierw wprowadzić nowe structy w tym samym pliku,
- później wydzielić do `current.rs`.

---

## 18.4 Planner
Nowe moduły:
- `crates/fullmag-plan/src/current.rs`
- `crates/fullmag-plan/src/antenna.rs`
- `crates/fullmag-plan/src/excitation.rs`

Zakres:
- validation,
- lowering do `FemPlanIR`,
- mesh policy,
- quantity registration.

---

## 18.5 Runner
Nowe moduły:
- `crates/fullmag-runner/src/antenna_outputs.rs`
- `crates/fullmag-runner/src/spectral_analysis.rs`
- `crates/fullmag-runner/src/mode_overlap.rs`

---

## 18.6 Native FEM backend
Nowe pliki:
- `native/backends/fem/src/antenna_mqs_2p5d.cpp`
- `native/backends/fem/src/antenna_mqs_3d.cpp`
- `native/backends/fem/src/antenna_field_sampling.cpp`
- `native/backends/fem/src/antenna_excitation_k.cpp`
- `native/backends/fem/src/antenna_mode_overlap.cpp`

Nagłówki / ABI:
- `native/include/fullmag_fem.h`
- ewentualnie nowy `native/include/fullmag_antenna.h`

---

## 18.7 Web control room
Nowe/zmienione sekcje:
- `apps/web/components/panels/...`
- `apps/web/components/preview/...`
- `apps/web/components/plots/...`
- `apps/web/lib/...`

Potrzebne feature’y:
- selector quantity dla `H_ant`,
- 2D contour layer,
- 3D iso-surface layer,
- plot `|h(k)|`,
- plot `mode overlap`,
- plot `S(k,\omega)`.

---

## 19. Ścieżka implementacyjna — milestone’y

## M0 — dokumentacja i IR seam
### Deliverables
- 2 noty w `docs/physics/`
- draft IR
- draft DSL
- capability flags

### Acceptance
- semantyka domknięta na papierze,
- brak sprzeczności z `ProblemIR` i control room.

---

## M1 — microstrip 2.5D field-only
### Deliverables
- `MicrostripAntenna`
- `mqs_2p5d_az`
- 2D field output
- 2D contours
- amplitude in waveguide

### Acceptance
- poprawny rozkład pola,
- zgodność z prostymi referencjami analitycznymi,
- GUI pokazuje heatmapę i kontury.

---

## M2 — CPW 2.5D + 3D preview
### Deliverables
- `CPWAntenna`
- current balance
- ekstruzja wizualizacyjna 3D
- iso-surfaces/slices

### Acceptance
- CPW działa w 2D i 3D preview,
- quantity registry ma `H_ant` i `H_ant_magnitude`,
- użytkownik może umieścić CPW nad falowodem w scenie 3D.

---

## M3 — source \(k\)-profile
### Deliverables
- sampling linii w falowodzie
- FFT po osi propagacji
- analytic overlay `sinc(...)`

### Acceptance
- wykres `antenna_source_k_profile`,
- zgadza się jakościowo z teorią szerokości anteny i odległości.

---

## M4 — coupling do LLG
### Deliverables
- pole antenowe jako external drive
- time-domain RF drive
- output odpowiedzi magnetyzacji

### Acceptance
- można wzbudzić fale spinowe w falowodzie,
- w UI widać odpowiedź i pola źródłowe.

---

## M5 — mode overlap
### Deliverables
- solve eigenmodes + overlap
- ranking modów
- mapowanie na \(k\)

### Acceptance
- użytkownik może zobaczyć, które mody dana antena pobudza najlepiej.

---

## M6 — driven \(S(k,\omega)\)
### Deliverables
- time-space FFT
- spectrum panel
- eksport artefaktów

### Acceptance
- full pipeline wzbudzenia fal spinowych działa.

---

## M7 — full 3D H(curl)
### Deliverables
- solver skończonej długości
- efekty końcowe
- nieregularne launchery

### Acceptance
- 3D physics solve działa dla geometrii, których 2.5D nie obejmuje.

---

## M8 — GPU production
### Deliverables
- device-resident source field
- GPU solve 2.5D
- benchmark gate dla PA/libCEED
- async artifacts

### Acceptance
- brak zbędnych transferów,
- sensowne speedup’y,
- pipeline stabilny.

---

## 20. Walidacja — plan bardzo precyzyjny

## 20.1 Walidacja źródła pola

### Test A — degeneracja do przewodnika wąskiego
Przy \(w \to 0\) rozwiązanie ma zbliżać się do pola cienkiego przewodnika.

### Test B — symetria microstrip
- symetria względem osi centralnej,
- poprawny znak komponentów.

### Test C — symetria CPW
- poprawne znaki dla signal/ground,
- zera/symetrie w osi układu.

### Test D — zbieżność mesha
- \(L^2\) / \(H^1\) convergence.

### Test E — zbieżność air-box
- pole i energia vs rozmiar obszaru.

---

## 20.2 Walidacja source \(k\)-profile

### Microstrip
Porównanie z:
\[
\operatorname{sinc}\left(\frac{k w}{2}\right)e^{-|k|h}
\]

### CPW
Porównanie z analityczną kombinacją wkładów signal/ground.

---

## 20.3 Walidacja pobudzenia spin-wave

### Test F — zależność od szerokości anteny
Węższa antena powinna pobudzać większy zakres \(k\).

### Test G — zależność od wysokości
Większy odstęp nad falowodem powinien tłumić duże \(k\).

### Test H — selektywność CPW
Symetria pola powinna selektywnie pobudzać odpowiednie klasy modów.

### Test I — mode overlap vs driven response
Najsilniej sprzężone mody z overlapu powinny dominować w \(S(k,\omega)\).

---

## 20.4 Walidacja numeryczna CPU/GPU
- field parity CPU vs GPU,
- relative norms, nie bitwise,
- tolerancje fizyczne na \(|H|\), profile i overlapy.

---

## 21. Wydajność i polityka GPU

## 21.1 Dla solvera 2.5D
Najważniejsze KPI:
- czas pojedynczego solve’u `H_ant_per_1A`,
- koszt projekcji do falowodu,
- koszt preview/export.

To nie jest solve wykonywany co krok, więc nie trzeba tu „przepalać” architektury.

## 21.2 Dla dynamicznego RF
Najważniejsze KPI:
- koszt skalowania i dodania `H_ant`,
- koszt driven time-domain,
- koszt FFT.

## 21.3 Zasada
Najpierw zrobić poprawny **one-time source solve**, a dopiero potem optymalizować hot loop LLG.

---

## 22. Najważniejsze decyzje, które trzeba podjąć świadomie

## 22.1 Czy antenna field source to energy term?
**Nie.**
To jest zewnętrzne źródło pola i analiza pobudzenia, nie energia w sensie materiałowym.

## 22.2 Czy pierwszy solver ma być 3D?
**Nie.**
Pierwszy ma być 2.5D \(A_y\).

## 22.3 Czy pole źródłowe ma być sprzężone zwrotnie z magnetyzacją?
**Nie w v1.**
Najpierw solve jednokierunkowy: antenna \(\rightarrow\) field \(\rightarrow\) LLG.

## 22.4 Czy widok 3D ma być od razu pełnym 3D physics?
**Nie.**
Najpierw 3D preview przez ekstruzję.

## 22.5 Jak definiować profil \(k\)?
Jako trzy osobne byty:
- source spectrum,
- mode overlap,
- driven response.

---

## 23. Co powinno wejść do capability matrix

| Funkcja | Semantic-only | Internal-reference | Public-executable |
|---|---:|---:|---:|
| Microstrip 2.5D source field | tak | tak | tak |
| CPW 2.5D source field | tak | tak | tak |
| 2D contours | tak | tak | tak |
| 3D extruded preview | tak | tak | tak |
| Source \(k\)-profile | tak | tak | tak |
| RF external drive coupling | tak | tak | tak |
| Mode overlap | tak | tak | później |
| Driven \(S(k,\omega)\) | tak | tak | później |
| Full 3D H(curl) antenna solver | tak | tak | później |
| Current solver / crowding | tak | tak | później |

---

## 24. Rekomendowane nowe quantity IDs

### Fields
- `H_ant`
- `H_ant_x`
- `H_ant_y`
- `H_ant_z`
- `H_ant_magnitude`
- `H_ant_perpendicular_to_m0`
- `H_ant_parallel_to_m0`

### Spectral / modal
- `antenna_source_k_profile`
- `mode_overlap`
- `mode_overlap_ranked`
- `driven_response_s_k_omega`

### Diagnostics
- `antenna_mesh_quality`
- `antenna_airbox_factor`
- `antenna_solver_residual`

---

## 25. Ryzyka i jak je ograniczyć

## R1 — pomylenie 2.5D preview z pełnym 3D solve
**Mitigacja:** jawna flaga w UI: `physics: 2.5D`, `preview: extruded`.

## R2 — zbyt wczesne wejście w H(curl)
**Mitigacja:** milestone gate; bez M1–M5 nie ruszać production 3D.

## R3 — niejasna definicja „profilu \(k\)”
**Mitigacja:** trzy osobne quantity i trzy osobne panele w UI.

## R4 — niepotrzebna interpolacja między meshami
**Mitigacja:** wspólny mesh regionowy w v1.

## R5 — obecny IR stanie się zbyt monolityczny
**Mitigacja:** wprowadzić nowe structy current/antenna już teraz, nawet jeśli jeszcze w tym samym pliku.

---

## 26. Ostateczna rekomendacja wdrożeniowa

Jeśli miałbym wskazać **jedną** najlepszą ścieżkę dla Twojego celu, to jest nią:

### Faza 1
`MicrostripAntenna` + `CPWAntenna` + solver `mqs_2p5d_az` + 2D/3D preview + `H_ant`

### Faza 2
`antenna_source_k_profile` + amplituda pola wewnątrz falowodu + coupling do `H_ext`

### Faza 3
`mode_overlap` z istniejącą ścieżką eigenmodes FEM

### Faza 4
`driven_response_S_k_omega`

### Faza 5
pełny `mqs_3d_hcurl`

To jest ścieżka:

- fizycznie poprawna,
- zgodna z architekturą Fullmaga,
- sensowna implementacyjnie,
- i dokładnie odpowiadająca temu, co opisałeś:
  - antena w scenie 3D,
  - rozkład pola 2D jak na obrazku,
  - izolinie również w 3D,
  - amplituda pola w falowodzie,
  - profil wzbudzania spin-wave i efektywnego \(k\).

---

## 27. Minimalny backlog do natychmiastowego utworzenia

### Physics docs
- [ ] `docs/physics/0610-fem-mqs-microwave-antenna-fields.md`
- [ ] `docs/physics/0615-fem-microstrip-cpw-spin-wave-excitation.md`

### DSL / IR
- [ ] `MicrostripAntenna`
- [ ] `CPWAntenna`
- [ ] `RfDrive`
- [ ] `AntennaFieldSource`
- [ ] `SpinWaveExcitationAnalysis`
- [ ] `CurrentModuleIR`
- [ ] `AntennaIR`
- [ ] `ExcitationAnalysisIR`

### FEM backend
- [ ] `antenna_mqs_2p5d.cpp`
- [ ] field recovery
- [ ] quantity export
- [ ] source \(k\)-FFT
- [ ] coupling do external field

### UI
- [ ] builder panel dla anteny
- [ ] 2D contour renderer
- [ ] 3D extruded preview
- [ ] spectrum plot
- [ ] mode overlap plot

---

## 28. Konkluzja końcowa

Ten feature **da się** zrobić w Fullmagu bardzo dobrze, ale trzeba go ustawić jako:

1. **solver źródła pola antenowego FEM 2.5D**
2. **warstwa wizualizacyjna 2D/3D**
3. **warstwa analizy pobudzenia spin-wave**

a nie jako „pojedynczy nowy solver magnetostatyki”.

Najważniejsza decyzja, która przesądzi o powodzeniu, brzmi:

> **zrobić najpierw dokładny i szybki solver 2.5D dla \(A_y\), a pełne 3D H(curl) potraktować jako etap drugi.**

To jest rozwiązanie:
- najbliższe Twojemu przypadkowi fizycznemu,
- najspójniejsze z obecnym Fullmagiem,
- i najbezpieczniejsze architektonicznie.

---

## 29. Proponowane przykładowe nazwy branchy i epiców

### Branch / epic 1
`feature/fem-antenna-mqs-2p5d`

### Branch / epic 2
`feature/fem-cpw-microstrip-preview-and-quantities`

### Branch / epic 3
`feature/fem-antenna-source-k-profile`

### Branch / epic 4
`feature/fem-antenna-mode-overlap`

### Branch / epic 5
`feature/fem-antenna-hcurl-3d`

---

## 30. Dodatkowa uwaga praktyczna

Jeżeli chcesz, żeby ten moduł od razu był naprawdę użyteczny naukowo, to w GUI koniecznie dodaj nie tylko:

- `|H_ant|`

ale także:

- komponent **poprzeczny do stanu równowagi**,
- profile wzdłuż linii w falowodzie,
- overlay z geometrią i z \(m_0\),
- szybki wykres `sinc(k w / 2) * exp(-|k|h)` jako analytic guide.

To jest mały koszt, a gigantycznie zwiększa wartość interpretacyjną.
