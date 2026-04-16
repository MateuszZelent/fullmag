# Fullmag — plan domknięcia modułu **FEM eigenproblem** oraz projekt sekcji **Analyze**

**Data opracowania:** 2026-03-29  
**Repozytorium bazowe:** `MateuszZelent/fullmag` (gałąź `master`)  
**Zakres:** analiza aktualnego stanu repo, ocena poprawności kierunku implementacji, projekt techniczny i fizyczny dokończenia modułu własnego zagadnienia (eigenproblem) w FEM, oraz projekt UX/UI dla ribbon + Model Builder → Analyze.

---

## 0. Executive summary

Repozytorium Fullmag ma już dziś bardzo ważne fundamenty, które **sprzyjają poprawnej implementacji eigenproblemu FEM**, ale ten moduł nie jest jeszcze doprowadzony do końca:

- architektura aplikacji jest już ustawiona poprawnie pod **oddzielenie modelu fizycznego, typu badania (`Study`), i polityki uruchomienia (`Runtime`)**;
- dokument architektoniczny wprost przewiduje przyszłe `fm.Eigenmodes(...)` jako osobny typ badania;
- obecny `ProblemIR` i `StudyIR` jeszcze **nie zawierają eigenmodes**, więc warstwa IR/planner/backend/API/UI nie jest jeszcze pełna dla tego przepływu;
- warstwa FEM jest już realnie obecna w repo jako: planner FEM, runtime split dla stosu `MFEM + libCEED + hypre`, FFI `fullmag-fem`, podgląd FEM 2D/3D i panel mesh build/quality;
- to oznacza, że **najbardziej opłacalna droga** nie polega na dopisywaniu eigenproblemu „obok”, tylko na dokończeniu go **zgodnie z istniejącą filozofią Fullmag**: `Python DSL → ProblemIR/StudyIR → ExecutionPlanIR → native FEM backend → artifacts → control room`.

Najważniejsza decyzja projektowa:

> **Eigenproblem musi być zaimplementowany jako osobny typ badania (`StudyIR::Eigenmodes`), a nie jako ukryty tryb solvera LLG ani opcja w `FEM(...)`.**

To jest zgodne z obecną architekturą Fullmag i kluczowe dla utrzymania czystości API, poprawności fizycznej, możliwości walidacji oraz przyszłego rozszerzania na różne klasy operatorów i warunków brzegowych.

---

## 1. Co już istnieje w aktualnym Fullmag i co z tego wynika

### 1.1. Co repo mówi o produkcie

Aktualny README repo definiuje Fullmag jako platformę mikromagnetyczną, w której **interfejs opisuje problem fizyczny, a nie układ siatki**, a aplikacja ma mieć jedną publiczną komendę `fullmag`, jedną przeglądarkową control room i backendy uruchamiane pod spodem. README opisuje też, że dla ciężkich ścieżek FEM kierunkiem kanonicznym jest runtime oparty o **MFEM + libCEED + hypre**. Repo ma strukturę z `packages/fullmag-py`, `crates/fullmag-ir`, `crates/fullmag-plan`, `crates/fullmag-engine`, `crates/fullmag-fem-sys`, `native/`, `apps/web`, `docs/specs`, `docs/physics`, `docs/plans`.  

### 1.2. Architektura przewiduje eigenmodes wprost

W `docs/specs/fullmag-application-architecture-v2.md` warstwa Study jest jawnie rozdzielona od modelu i runtime. Dokument mówi wprost, że Fullmag **nie może** twardo zakładać, że problem = czasowa integracja LLG, bo przyszły FEM ma obejmować również **eigenproblems**, a przykład docelowego API pokazuje `fm.Eigenmodes(...)`. To jest bardzo mocny sygnał, że architektura jest gotowa koncepcyjnie, ale implementacja jeszcze nie jest skończona.  

### 1.3. Aktualny IR jeszcze nie ma eigenmodes

`docs/specs/problem-ir-v0.md` oraz aktualne `crates/fullmag-ir/src/lib.rs` pokazują, że obecny `StudyIR` ma dziś warianty `TimeEvolution` i `Relaxation`, ale **nie ma jeszcze `Eigenmodes`**. To jest pierwsza luka, którą trzeba zamknąć, zanim backend eigenmodes będzie „prawdziwy” w sensie produktowym.  

### 1.4. Capability matrix: FEM już jest realny, ale jeszcze nie modalny

`docs/specs/capability-matrix-v0.md` pokazuje, że Fullmag ma dziś public-executable ścieżkę dla części FDM i części FEM, w tym `Exchange`, `Demag`, `Zeeman`, `LLG(Heun)`, `Relaxation(llg_overdamped)`, `FEM hints`, `double precision`, oraz wspólne quantity outputs. Jednocześnie dokument architektoniczny wskazuje, że przyszły FEM ma mieć **eigenmode support**, czyli to jeszcze nie jest domknięte.  

### 1.5. Frontend i control room są już quantity-driven

`docs/specs/visualization-quantities-v1.md` wprowadza bardzo dobrą regułę: **control room ma być sterowany rejestrem ilości fizycznych, a nie jednym hardcoded polem**. To jest idealna baza pod eigenproblem, bo widmo własne, dyspersja i mody własne są po prostu **innymi klasami quantity/artifact**, a nie wyjątkiem od systemu.

### 1.6. UI ma już gotowe cegiełki pod FEM preview

W `apps/web/components/preview/` są już komponenty takie jak:

- `FemMeshSlice2D.tsx`
- `FemMeshView3D.tsx`
- `PreviewScalarField2D.tsx`
- `MagnetizationView2D.tsx`
- `MagnetizationView3D.tsx`

W `apps/web/components/panels/` są już komponenty:

- `MeshSettingsPanel.tsx`
- `ModelTree.tsx`
- `SolverSettingsPanel.tsx`
- `ScalarTable.tsx`

To oznacza, że sekcja Analyze nie musi być projektowana od zera. Trzeba ją raczej **wpiąć inteligentnie w istniejący język interfejsu**.

### 1.7. FEM runtime jest realny, ale eigenproblem nie jest jeszcze wyprowadzony semantycznie

`crates/fullmag-fem-sys/src/lib.rs` pokazuje, że FFI po stronie FEM obejmuje dziś m.in.:

- precision,
- integrator,
- observable,
- linear solver,
- preconditioner,
- realizację demag,
- deskryptor mesh/material,
- `fullmag_fem_plan_desc`,
- stepper + field copy + device info.

To jest FFI zaprojektowane pod **czasowy solver FEM**, a nie pod eigenproblem. Zatem dla poprawnej architektury trzeba dodać **osobny zestaw deskryptorów i funkcji ABI dla eigenmodes** zamiast wtłaczać to w `backend_step(...)`.

---

## 2. Ocena poprawności kierunku implementacji eigenproblemu w FEM

### 2.1. Co jest poprawne już teraz

Aktualny kierunek repo jest dobry z trzech powodów:

1. **study-first architecture** — własne zagadnienie jest innym typem obliczenia niż time stepping;
2. **backend-neutral IR** — fizyka problemu ma żyć ponad siatką i solverem;
3. **quantity-driven UI** — po obliczeniu modów można naturalnie wizualizować widmo, profile modów i pochodne diagnostyki.

### 2.2. Co byłoby błędem

Poniższe rozwiązania byłyby błędne i należy ich unikać:

- dodanie `eigen=True` do `fm.FEM(...)`;
- traktowanie eigenproblem jako wariantu `LLG`;
- pakowanie częstotliwości własnych do zwykłych scalar traces od czasu;
- przechowywanie modów jako zwykłych snapshotów czasowych bez metadanych numeru modu, normowania i polaryzacji;
- generowanie dyspersji wyłącznie po stronie UI bez jawnej reprezentacji w artifacts/API.

### 2.3. Zasada główna

Implementacja ma być poprawna, jeśli spełnia jednocześnie:

- poprawność **fizyczną**,
- poprawność **numeryczną**,
- poprawność **semantyczną** w `ProblemIR/StudyIR`,
- poprawność **produktową** w API/artifacts/UI,
- poprawność **walidacyjną** w capability matrix.

---

## 3. Co dokładnie znaczy „eigenproblem” w mikromagnetycznym FEM

W Fullmag trzeba rozdzielić co najmniej trzy poziomy:

### 3.1. Level A — standardowy eigenproblem zlinearyzowanej dynamiki

Po wyznaczeniu stanu równowagi \( \mathbf{m}_0 \) linearyzujemy równanie ruchu w przestrzeni stycznej do sfery jednostkowej:

\[
\mathbf{m}(\mathbf{r}, t) = \mathbf{m}_0(\mathbf{r}) + \delta \mathbf{m}(\mathbf{r}, t),
\qquad \mathbf{m}_0 \cdot \delta \mathbf{m} = 0.
\]

Dla małych zaburzeń otrzymujemy problem własny typu:

\[
\mathcal{L}[\delta \mathbf{m}] = \lambda \mathcal{M}[\delta \mathbf{m}],
\]

albo po przejściu do ansatzu harmonicznego \( e^{-i\omega t} \):

\[
\mathcal{A} \mathbf{u} = i\omega \mathcal{B} \mathbf{u}.
\]

To jest główny docelowy problem dla spin-wave eigenmodes.

### 3.2. Level B — problem własny z periodycznością Blocha

Dla dyspersji trzeba umieć liczyć:

\[
\mathbf{u}(\mathbf{r}+\mathbf{R}) = \mathbf{u}(\mathbf{r}) e^{i\mathbf{k}\cdot\mathbf{R}},
\]

co daje problem własny parametryzowany przez wektor falowy \(\mathbf{k}\). To nie jest „inna wizualizacja”, tylko **inna klasa badania lub pod-tryb study**.

### 3.3. Level C — odpowiedź wymuszona / spektrum odpowiedzi

To nie jest to samo co eigenmodes. Widmo odpowiedzi z wymuszeniem RF daje piki rezonansowe, ale nie zastępuje prawdziwego własnego zagadnienia. W UI można pokazać oba, ale w architekturze muszą być rozdzielone.

---

## 4. Zalecany model fizyczny dla pierwszej wersji eigenmodes

## 4.1. MVP fizyczny

Pierwsza publicznie poprawna wersja powinna obejmować:

- stan równowagi wejściowy z `Relaxation` albo jawnie dostarczony snapshot,
- zlinearyzowane LLG bez silnego tłumienia w operatorze własnym,
- exchange,
- zeeman,
- demag w tej samej realizacji, którą Fullmag uzna za kanoniczną dla FEM eigen,
- uniaxial anisotropy jako pierwszy dodatkowy term po MVP, nie w pierwszym commitcie,
- przestrzeń styczną do \(\mathbf{m}_0\), bez łamania warunku \(|\mathbf{m}|=1\).

### 4.2. Czego nie wrzucać do pierwszej wersji

Nie należy od razu dodawać:

- STT/SOT do eigenmodes,
- pełnej nieliniowości amplitudowej,
- non-Hermitian gain/loss physics jako pierwszy scope,
- magnetoelastyki,
- Bloch-periodic dispersions w tej samej iteracji co pierwszy solver modów,
- mieszania FE spaces kilku rodzin naraz.

Najpierw trzeba mieć **jedno poprawne, walidowalne, stabilne rozwiązanie**.

---

## 5. Poprawna dyskretyzacja FEM dla eigenproblemu mikromagnetycznego

### 5.1. Krytyczna zasada: nie liczyć modów w pełnej 3-komponentowej przestrzeni bez więzów

Jeżeli zbudujesz operator w pełnej przestrzeni 3N niewiadomych bez właściwego wymuszenia warunku styczności do \(\mathbf{m}_0\), dostaniesz:

- tryby niefizyczne,
- zerowe i prawie-zerowe mody geometryczne,
- zanieczyszczenie spektrum przez składową radialną,
- błędne ortogonalności.

### 5.2. Zalecenie

Użyj **lokalnej bazy stycznej** w każdym DOF albo jawnej projekcji na przestrzeń styczną:

- dla każdego węzła/DOF zbuduj dwa ortonormalne wektory \(\mathbf{e}_1, \mathbf{e}_2\) prostopadłe do \(\mathbf{m}_0\),
- reprezentuj zaburzenie jako

\[
\delta \mathbf{m} = a\,\mathbf{e}_1 + b\,\mathbf{e}_2,
\]

- rozwiązuj eigenproblem w przestrzeni 2N, nie 3N.

To jest najważniejsza decyzja numeryczna całego modułu.

### 5.3. Exchange

Dla P1/Lagrange FEM exchange daje naturalny operator sztywności. To jest najbardziej stabilna część implementacji.

### 5.4. Demag

To będzie najtrudniejszy element. Tu rekomendacja jest następująca:

#### Wersja 1

Dla eigenmodes zastosować **ten sam kanoniczny model demag**, jaki Fullmag uzna za poprawny dla stanu bazowego FEM, najlepiej z jedną jawną polityką:

- `poisson_airbox` jako kanoniczny solver FEM (Dirichlet/Robin na shared-domain mesh z airboxem).

#### Wersja 2

Dopiero potem dodać warianty i porównania.

### 5.5. Masowa macierz i forma problemu

Nie wolno mieszać bez refleksji:

- lumped mass,
- consistent mass,
- projected mass.

Dla eigenproblemu trzeba jawnie zdecydować i opisać:

- jaka jest macierz metryki \(\mathcal{B}\),
- w jakiej normie są ortogonalne mody,
- jak jest liczona energia modu,
- jak jest liczona partycypacja objętościowa.

Moja rekomendacja dla pierwszej poprawnej wersji:

- **consistent mass** w dyskretyzacji operatora własnego,
- opcjonalna projekcja/stabilizacja,
- jawna dokumentacja normowania modów.

### 5.6. Solver własny

Dla pierwszej wersji praktycznej:

- użyć **SLEPc/PETSc** jeśli runtime to dopuszcza, albo
- użyć solvera własnego MFEM/hypre tylko wtedy, gdy daje stabilne generalized eigensolvers dla problemu niesymetrycznego / zespolonego.

Jeżeli pełny complex generalized eigensolver jest zbyt ciężki dla MVP, można zacząć od real-valued doubled system, ale należy to jasno udokumentować.

---

## 6. Jak dokończyć to poprawnie w architekturze Fullmag

## 6.1. Warstwa Python DSL

Dodać nowy publiczny typ:

```python
fm.Eigenmodes(
    count=20,
    target="lowest" | "nearest",
    target_frequency=None,
    operator="linearized_llg",
    equilibrium_source="relax" | "artifact" | "provided",
    include_demag=True,
    k_vector=None,
    outputs=[
        fm.SaveSpectrum("eigenfrequency"),
        fm.SaveMode("mode", indices=[0,1,2,3]),
        fm.SaveDispersion("dispersion")
    ],
)
```

Dodatkowo:

- `Problem(..., study=fm.Eigenmodes(...))`
- żadnych eigen-opcji w `fm.FEM(...)` poza czysto backendowymi hintami solverowymi.

## 6.2. `ProblemIR` / `StudyIR`

Dodać do `StudyIR` wariant:

```rust
Eigenmodes {
    operator: EigenOperatorIR,
    count: u32,
    target: EigenTargetIR,
    equilibrium: EquilibriumSourceIR,
    k_sampling: Option<KSamplingIR>,
    normalization: EigenNormalizationIR,
    damping_policy: EigenDampingPolicyIR,
    sampling: EigenSamplingIR,
}
```

Minimalne nowe typy:

- `EigenOperatorIR`
- `EigenTargetIR`
- `EquilibriumSourceIR`
- `KSamplingIR`
- `EigenSamplingIR`
- `EigenNormalizationIR`
- `EigenDampingPolicyIR`

## 6.3. Capability matrix

Dodać osobne wiersze:

- `StudyIR::Eigenmodes`
- `Eigenmodes(linearized_llg)`
- `Eigenmodes + demag`
- `Eigenmodes + Bloch periodicity`
- `Eigenmodes outputs: spectrum`
- `Eigenmodes outputs: mode field`
- `Eigenmodes outputs: dispersion`

Status początkowy powinien być uczciwy:

- Python + IR: `semantic-only` lub `planned`,
- planner: `internal-reference`,
- backend native: `internal-reference`,
- end-to-end UI/artifacts: dopiero po pełnym spięciu `public-executable`.

## 6.4. `ExecutionPlanIR`

Potrzebny nowy plan backendowy, np. rozszerzenie `FemPlanIR` o `FemEigenPlanIR` albo osobny wariant:

```rust
BackendPlanIR::FemEigen(FemEigenPlanIR)
```

Powinien zawierać:

- mesh,
- FE order,
- equilibrium field source,
- tangent basis policy,
- enabled energy terms,
- demag realization,
- eigen solver config,
- target policy,
- k-sampling definition,
- output plan.

## 6.5. Native ABI

Nie dopisywać eigenmodes do `fullmag_fem_backend_step`. Dodać osobny ABI:

```c
fullmag_fem_eigen_backend_create(...)
fullmag_fem_eigen_backend_solve(...)
fullmag_fem_eigen_backend_copy_spectrum(...)
fullmag_fem_eigen_backend_copy_mode_f64(...)
fullmag_fem_eigen_backend_copy_mode_meta(...)
fullmag_fem_eigen_backend_destroy(...)
```

Dlaczego osobny ABI?

- inny lifecycle,
- inne artefakty,
- inne metadane,
- brak naturalnego kroku czasowego,
- inne błędy i ustawienia solvera.

---

## 7. Projekt fizycznej dokumentacji, która powinna powstać w `docs/physics/`

Zgodnie z golden rule repo, przed pełną implementacją trzeba dodać nową publikacyjno-stylową notę, np.:

`docs/physics/0600-fem-eigenmodes-linearized-llg.md`

Ta nota powinna zawierać:

1. pełne równania LLG i ich linearyzację,
2. definicję stanu bazowego \(\mathbf{m}_0\),
3. konstrukcję przestrzeni stycznej,
4. weak form operatora,
5. exchange term,
6. zeeman term,
7. anisotropy term (nawet jeśli deferred),
8. demag term i wybraną realizację,
9. macierz masy / metrykę,
10. postać generalized eigenproblem,
11. normowanie modów,
12. definicję częstotliwości, fazy i degeneracji,
13. interpretację modów zespolonych,
14. warunki brzegowe,
15. jednostki SI,
16. ograniczenia pierwszej wersji,
17. acceptance tests.

Bez tej noty implementacja będzie bardzo trudna do utrzymania.

---

## 8. Artefakty i quantity registry dla eigenmodes

## 8.1. Nowe klasy quantities

Dla Analyze trzeba dodać nowe klasy:

- `eigen_spectrum`
- `mode_vector_field`
- `mode_scalar_field`
- `dispersion_curve`
- `mode_metadata`

### 8.2. Minimalne artifact families

Proponowany layout:

```text
artifacts/
  eigen/
    spectrum.csv
    spectrum.json
    modes/
      mode_0000_real.vtu
      mode_0000_imag.vtu
      mode_0000_amp.vtu
      mode_0000_phase.vtu
      mode_0001_...
    dispersion/
      branch_table.csv
      path.json
    metadata/
      eigen_summary.json
      normalization.json
      equilibrium_source.json
```

### 8.3. Metadane modu

Każdy mode powinien mieć:

- index,
- frequency,
- angular_frequency,
- growth/decay part jeśli non-Hermitian,
- norm,
- dominant polarization,
- parity/symmetry tags jeśli wykrywalne,
- overlap with excitation operator (później),
- k-vector.

---

## 9. Projekt nowego ribbon i sekcji **Model Builder → Analyze**

Najważniejsza zasada UX:

> **Analyze nie jest edytorem geometrii. Analyze jest przestrzenią interpretacji wyniku obliczeń własnych.**

To musi być oddzielone od Build/Mesh/Solve.

## 9.1. Zalecany top-level ribbon

Proponuję taki układ główny:

- **Model**
- **Materials**
- **Mesh**
- **Studies**
- **Solve**
- **Analyze**
- **Artifacts**
- **Docs**

Jeżeli chcesz zachować obecny duch Model Builder, to Analyze powinno być aktywne dopiero, gdy istnieją odpowiednie wyniki.

## 9.2. Sekcja Analyze — zakładki

Proponowane zakładki wewnętrzne:

1. **Spectrum**
2. **Modes**
3. **Dispersion**
4. **Compare**
5. **Diagnostics**

### Spectrum

Pokazuje:

- tabelę modów,
- wykres częstotliwości,
- filtrowanie po zakresie,
- sortowanie po częstotliwości, normie, udziale energii,
- grupowanie degeneracji.

### Modes

Pokazuje:

- 2D slice,
- 3D view,
- komponent real/imag,
- amplituda,
- faza,
- overlay equilibrium magnetization,
- przełączanie numeru modu.

### Dispersion

Pokazuje:

- ścieżkę \(k\)-space,
- branch plot \(f(k)\),
- wybór branch index,
- kliknięcie punktu → otwarcie konkretnego modu w Modes.

### Compare

Pokazuje:

- porównanie dwóch modów,
- porównanie dwóch rozmiarów siatki,
- porównanie FEM vs FDM tam, gdzie sensowne,
- convergence plot.

### Diagnostics

Pokazuje:

- residual własny,
- norm preservation,
- tangent-space leakage,
- orthogonality check,
- mesh sensitivity,
- status solvera i iteracji.

## 9.3. Pasek narzędzi w Analyze

Globalny toolbar w Analyze:

- `Study:` [Eigenmodes / Dispersion / Response]
- `Dataset:` [run / artifact]
- `Mode:` [index selector]
- `View:` [2D / 3D / Table / Plot]
- `Field:` [real / imag / amplitude / phase / mx / my / mz / tangent-1 / tangent-2]
- `Export:` [CSV / VTU / PNG / JSON]

To powinno siedzieć nad treścią, nie z boku.

---

## 10. Jak dokładnie zaprojektować **Spectrum**

### 10.1. Lewy panel — tabela modów

Kolumny:

- `#`
- `f [GHz]`
- `ω [rad/s]`
- `degeneracy`
- `norm`
- `residual`
- `symmetry`
- `k-path point`

### 10.2. Prawy panel — wykres widma

Wersje:

- stem plot,
- scatter plot,
- histogram gęstości modów.

### 10.3. Interakcje

- kliknięcie wiersza podświetla punkt na wykresie,
- kliknięcie punktu przełącza Modes,
- multi-select dla porównania.

---

## 11. Jak dokładnie zaprojektować **Modes**

### 11.1. Widok główny

Układ 2-kolumnowy:

- lewa: 2D slice / scalar colormap,
- prawa: 3D mesh mode preview.

### 11.2. Przełączniki reprezentacji

- `Real`
- `Imag`
- `Amplitude`
- `Phase`
- `Tangent component 1`
- `Tangent component 2`
- `Cartesian x/y/z`

### 11.3. Nakładki

- equilibrium \(\mathbf{m}_0\),
- mesh wireframe,
- boundary markers,
- nodal vs element values.

### 11.4. Krytyczna uwaga UX

Dla modów własnych 3D nie wolno pokazywać tylko „ładnej chmurki kolorów”. Użytkownik musi zawsze widzieć:

- jaki to komponent,
- jaka to normalizacja,
- czy dane są nodalne czy elementowe,
- czy to real/imag/amplitude/phase.

---

## 12. Jak dokładnie zaprojektować **Dispersion**

### 12.1. Dispersion jako osobny obiekt, nie uboczny wykres

Dyspersja powinna wynikać z jawnej definicji ścieżki w przestrzeni \(k\):

- lista high-symmetry points,
- liczba kroków na odcinek,
- orientacja periodyczności,
- jednostki w 1/m lub rad/m.

### 12.2. Widok

- główny wykres branch plot,
- panel wyboru branch,
- panel informacji o wybranym punkcie \((k_i, n)\),
- przycisk `Open mode`.

### 12.3. Warunek poprawności

UI nie może rysować dyspersji, jeśli solver nie zwrócił jawnie danych branch/path. Żadnej rekonstrukcji „na zgadywanie”.

---

## 13. Walidacja fizyczna i numeryczna

To jest absolutnie kluczowe. Bez tego moduł będzie wyglądał dobrze, ale nie będzie wiarygodny.

## 13.1. Testy jednostkowe IR/planner

- `StudyIR::Eigenmodes` serializacja/deserializacja,
- walidacja legalnych i nielegalnych kombinacji,
- target policy,
- equilibrium source,
- output plan dla spectrum/modes/dispersion.

## 13.2. Testy backendowe

- operator exchange-only dla prostego przypadku z analitycznym trendem,
- zbieżność częstotliwości z zagęszczaniem siatki,
- orthogonality residual,
- tangent leakage bliskie zeru,
- zgodność jednostek.

## 13.3. Testy referencyjne fizyczne

Minimalny zestaw:

1. cienki prostopadłościan z uniform equilibrium,
2. nanodysk z modami radial/azimuthal,
3. prosty waveguide z porównaniem trendu dyspersji,
4. przypadek bez demag i z demag,
5. przypadek degeneracji.

## 13.4. Testy produktowe UI/API

- Analyze pokazuje tylko to, co zwrócił registry,
- klik modu ↔ wykres ↔ 2D/3D są spójne,
- eksport zachowuje metadane numeru modu i normowania,
- artifact reload odtwarza dokładnie ten sam widok.

---

## 14. Plan wdrożenia w 3 przejściach

Ponieważ prosiłeś, żeby to „przemyśleć 3 razy”, proponuję **3 świadome przejścia wdrożeniowe**, a nie jedną wielką iterację.

## Przejście 1 — semantyka i kontrakty

Cel: domknąć architekturę, zanim dotkniesz ciężkiej matematyki.

Zakres:

- dodać `fm.Eigenmodes` do Python DSL,
- rozszerzyć `StudyIR`,
- rozszerzyć capability matrix,
- dodać spec physics,
- dodać `FemEigenPlanIR`,
- zdefiniować artifacts i quantity registry,
- dodać API endpointy pod spectrum/modes/dispersion.

Deliverable:

- wszystko się serializuje, planuje i wyświetla jako placeholder/public contract,
- nic jeszcze nie musi liczyć pełnego solvera.

## Przejście 2 — solver własny MVP

Cel: uzyskać pierwszy fizycznie poprawny eigen solver dla ustalonego stanu równowagi.

Zakres:

- tangent-space basis,
- exchange + zeeman,
- opcjonalnie demag w jednej wybranej realizacji,
- solve top-N modes,
- spectrum + mode export,
- Analyze: Spectrum + Modes.

Deliverable:

- pierwsze publicznie sensowne eigenmodes dla FEM.

## Przejście 3 — dyspersja i diagnostyka jakości

Cel: zrobić z tego realne narzędzie badawcze.

Zakres:

- Bloch periodicity,
- k-path sampling,
- branch stitching,
- convergence diagnostics,
- Compare,
- Dispersion,
- residual/orthogonality/tangent leakage panels.

Deliverable:

- kompletna sekcja Analyze dla eigenmodes/dispersions.

---

## 15. Konkretne rekomendacje implementacyjne dla repo

### 15.1. Nowe pliki/specs

Dodać:

- `docs/physics/0600-fem-eigenmodes-linearized-llg.md`
- `docs/specs/eigenmode-artifacts-v1.md`
- `docs/plans/active/fem-eigenmodes-and-analyze-plan-v1.md`

### 15.2. Python

Rozszerzyć:

- `packages/fullmag-py/src/fullmag/model/...`
- eksport w `__init__`
- nowe output classes: `SaveSpectrum`, `SaveMode`, `SaveDispersion`

### 15.3. Rust IR / planner

Rozszerzyć:

- `crates/fullmag-ir/src/lib.rs`
- `crates/fullmag-plan/src/lib.rs`
- walidatory i plan summaries

### 15.4. Native FEM

Rozszerzyć:

- `native/include/fullmag_fem.h`
- `crates/fullmag-fem-sys/src/lib.rs`
- nowy eigen backend path w `native/backends/fem/...`

### 15.5. Web

Dodać nowe komponenty:

- `apps/web/components/analyze/EigenSpectrumPanel.tsx`
- `apps/web/components/analyze/EigenModeInspector.tsx`
- `apps/web/components/analyze/DispersionPanel.tsx`
- `apps/web/components/analyze/EigenDiagnosticsPanel.tsx`
- `apps/web/components/analyze/ModeTable.tsx`

oraz nową sekcję w ribbon / route tree.

---

## 16. Największe ryzyka

### Ryzyko 1 — zły operator liniowy

Jeśli linearyzacja nie będzie dokładnie spójna z tym, jak Fullmag liczy equilibrium i effective field, mody będą „ładne”, ale fizycznie niespójne.

### Ryzyko 2 — brak przestrzeni stycznej

To najczęstsza droga do śmieciowego spektrum.

### Ryzyko 3 — demag jako niedookreślony wyjątek

Jeśli demag w eigenproblemie nie będzie miał jednej jawnej polityki, użytkownik nie będzie wiedział, co dokładnie policzył.

### Ryzyko 4 — UI miesza modes z time snapshots

To zabije semantyczną czystość produktu.

### Ryzyko 5 — za szeroki pierwszy scope

Najpierw poprawny MVP. Potem dyspersja. Potem reszta.

---

## 17. Finalna rekomendacja

Jeżeli celem jest **poprawny naukowo i produktowo moduł FEM eigenproblem** w Fullmag, to najlepsza droga jest następująca:

1. **najpierw semantyka i kontrakty** (`Eigenmodes` jako Study, artifacts, quantities, API);
2. **potem solver MVP w przestrzeni stycznej** dla equilibrium + exchange/zeeman/(jedna realizacja demag);
3. **dopiero potem Analyze dla spectrum/modes/dispersion** jako pełna sekcja produktowa;
4. **na końcu** rozszerzenia typu Bloch periodicity, anisotropy, compare, advanced diagnostics.

W skrócie:

> Fullmag jest już dziś architektonicznie ustawiony tak, że eigenproblem FEM można domknąć bardzo czysto — ale tylko wtedy, gdy potraktujesz go jako **pierwszej klasy typ badania**, a nie jako dodatkową opcję solvera czasowego.

To jest najważniejszy wniosek z całej analizy.

---

## 18. Checklist implementacyjny

### A. Architektura

- [ ] dodać `fm.Eigenmodes`
- [ ] dodać `StudyIR::Eigenmodes`
- [ ] dodać `FemEigenPlanIR`
- [ ] rozszerzyć capability matrix
- [ ] dodać physics note

### B. Backend

- [ ] tangent-space basis
- [ ] linearized operator
- [ ] generalized eigensolver
- [ ] spectrum export
- [ ] mode field export

### C. API / artifacts

- [ ] quantity registry dla eigen artifacts
- [ ] endpoint spectrum
- [ ] endpoint mode by index
- [ ] endpoint dispersion
- [ ] metadata normowania i residuali

### D. UI

- [ ] ribbon: Analyze
- [ ] Spectrum tab
- [ ] Modes tab
- [ ] Dispersion tab
- [ ] Diagnostics tab
- [ ] click-through między wykresami i widokami pól

### E. Walidacja

- [ ] testy IR
- [ ] testy planner
- [ ] testy backend convergence
- [ ] testy orthogonality
- [ ] testy artifact reload

---

## 19. Propozycja kolejnego kroku

Najbardziej sensowny następny krok w repo:

1. najpierw napisać `docs/physics/0600-fem-eigenmodes-linearized-llg.md`,
2. potem dodać `StudyIR::Eigenmodes` i Python DSL,
3. potem zrobić plan techniczny `docs/plans/active/fem-eigenmodes-and-analyze-plan-v1.md`,
4. dopiero później pisać natywny solver.

To minimalizuje chaos i bardzo ułatwia późniejsze code review.
