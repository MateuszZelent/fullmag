# Wspólna relaksacja FDM GPU metodą PG-BB

(problem-statement)=
## Cel

Status: 29.10.2026 potwierdzono ograniczony, pięciokrokowy parytet CPU/GPU FP64.
Pełna kwalifikacja produkcyjna oraz zbieżność względem siatki pozostają **NOT VERIFIED**.
Właściciel fizyki: kanoniczny kontrakt `0580-canonical-relaxation-equilibrium-contract.md`.
Ta nota zawęża etap z planu `docs/superpowers/specs/2026-07-12-fdm-multilayer-direct-minimizer-design.md`
do PG-BB na referencyjnym FDM CPU oraz natywnym operatorze CUDA FP64, open `three_d`,
z wyrównanymi siatkami o wspólnym rozmiarze komórki. NCG i FP32 pozostają poza tym etapem.
Nie zmienia Hamiltonianu ani nie wprowadza nowego publicznego algorytmu.

(assumptions-and-validity)=
## Założenia, realizacje i zakres dowodów

| Solver | Urządzenie | Realizacja i status |
|---|---|---|
| FDM | CPU | Adapter referencyjny wspólnego sterownika BB; wykonano pięć przyjętych kroków przypadku parytetu FP64. |
| FDM | GPU | Rezydentne wektory i redukcje CUDA z hostowym sterownikiem skalarnym BB/Armijo: NOT VERIFIED. Historycznie wykonano pięć kroków parytetu poprzedniego adaptera z transferami prób. |
| FEM | CPU | Istniejąca realizacja MFEM pozostaje opisana w `0510-fem-relaxation-algorithms-mfem-gpu.md`. Ta zmiana jej nie kwalifikuje. |
| FEM | GPU | Istniejąca realizacja MFEM/CUDA pozostaje opisana w `0510-fem-relaxation-algorithms-mfem-gpu.md`. Ta zmiana jej nie kwalifikuje. |

Wymuszone GPU nie korzysta z CPU do zastąpienia brakującego operatora pola.
Sterowanie minimizatorem na hoście odpowiada istniejącej realizacji single-grid
`crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs:execute_direct_minimizer`.
Provenance ujawnia natywny operator CUDA, hostowy sterownik skalarny BB
i rezydentne wektory z publikacyjnymi snapshotami hosta. Transfery skalarów
pozostają jawne; nie wolno podmieniać tej ścieżki na LLG.

(governing-equations)=
## Model i równania

Każda aktywna komórka zachowuje własne $M_{s,i}$ i $V_i$ oraz przynależność do
obiektu. Konkatenacja jest layer-major i nie zawiera komórek scratch FFT.
Komórki nieaktywne pozostają zerowe i mają zerową wagę. Pole każdej próby obejmuje
sprzężenie magnetostatyczne wszystkich obiektów, exchange i lokalne zachowawcze
oddziaływania tego samego planu, w tym rDMI tylko na wybranych obiektach.

```{math}
:label: eq-multilayer-bb-gradient
\mathbf g_i=-P_{\mathbf m_i}\mathbf H_i,\qquad
P_{\mathbf m_i}=I-\mathbf m_i\mathbf m_i^\mathsf T,\qquad
w_i=\mu_0 M_{s,i}V_i.
```

```{math}
:label: eq-multilayer-bb-metric
\langle\mathbf a,\mathbf b\rangle_E=\sum_i w_i\,\mathbf a_i\cdot\mathbf b_i.
```

```{math}
:label: eq-multilayer-bb-retraction
\mathbf m'_i=\frac{\mathbf m_i-\lambda\mathbf g_i}
{\lVert\mathbf m_i-\lambda\mathbf g_i\rVert},\qquad
\mathbf s_i=P_{\mathbf m'_i}(\mathbf m'_i-\mathbf m_i),\qquad
\mathbf y_i=\mathbf g'_i-P_{\mathbf m'_i}\mathbf g_i.
```

```{math}
:label: eq-multilayer-bb-steps
\lambda_{\mathrm{BB1}}=\frac{\langle\mathbf s,\mathbf s\rangle_E}
{\langle\mathbf s,\mathbf y\rangle_E},\qquad
\lambda_{\mathrm{BB2}}=\frac{\langle\mathbf s,\mathbf y\rangle_E}
{\langle\mathbf y,\mathbf y\rangle_E}.
```

Naprzemienne BB1/BB2, transport gradientu i restarty używają istniejącego
`direct_minimizer.rs:projected_gradient_step_size_update`. Krok startowy wynosi
$10^{-6}\,\mathrm{m\,A^{-1}}$, ograniczenia to $[10^{-15},10^{-3}]\,\mathrm{m\,A^{-1}}$,
a liczba backtracków nie przekracza 20. To wewnętrzna polityka istniejącego solvera.

Akceptacja używa faktycznie zapisanej, znormalizowanej próby, zgodnie z kanoniczną
regułą representable chord w `0580`. FP64 nie dostaje sztucznego luzu energii.

```{math}
:label: eq-multilayer-bb-armijo
\Delta E_{\mathrm{lin}}=-\sum_i w_i\,\mathbf H_i\cdot(\mathbf m'_i-\mathbf m_i),\qquad
\Delta E_{\mathrm{lin}}<0,\qquad
E'\le E+c_1\Delta E_{\mathrm{lin}}.
```

```{math}
:label: eq-multilayer-bb-torque
\tau_{\max}=\max_i\lVert\mathbf m_i\times\mathbf H_i\rVert,\qquad
\tau_{\max,T}=\mu_0\tau_{\max}.
```

(symbols-and-si-units)=
## Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf m_i$ | magnetyzacja przyjęta | $1$ |
| $\mathbf m'_i$ | magnetyzacja próbna | $1$ |
| $\mathbf H_i$ | pole efektywne | $\mathrm{A\,m^{-1}}$ |
| $\mathbf g_i$ | gradient styczny | $\mathrm{A\,m^{-1}}$ |
| $\mathbf g'_i$ | gradient próbny | $\mathrm{A\,m^{-1}}$ |
| $P_{\mathbf m_i}$ | projektor styczny | $1$ |
| $I$ | macierz jednostkowa | $1$ |
| $M_{s,i}$ | namagnesowanie nasycenia | $\mathrm{A\,m^{-1}}$ |
| $V_i$ | objętość komórki | $\mathrm{m^3}$ |
| $\mu_0$ | przenikalność próżni | $\mathrm{N\,A^{-2}}$ |
| $w_i$ | waga metryki | $\mathrm{J\,m\,A^{-1}}$ |
| $\mathbf a_i$ | argument metryki | $1$ |
| $\mathbf b_i$ | argument metryki | $1$ |
| $\mathbf s_i$ | różnica po transporcie | $1$ |
| $\mathbf y_i$ | różnica gradientów | $\mathrm{A\,m^{-1}}$ |
| $\lambda$ | krok | $\mathrm{m\,A^{-1}}$ |
| $\lambda_{\mathrm{BB1}}$ | krok BB1 | $\mathrm{m\,A^{-1}}$ |
| $\lambda_{\mathrm{BB2}}$ | krok BB2 | $\mathrm{m\,A^{-1}}$ |
| $E$ | energia przyjęta | $\mathrm J$ |
| $E'$ | energia próbna | $\mathrm J$ |
| $\Delta E_{\mathrm{lin}}$ | przyrost liniowy | $\mathrm J$ |
| $c_1$ | stała Armijo | $1$ |
| $\tau_{\max}$ | reszta momentu | $\mathrm{A\,m^{-1}}$ |
| $\tau_{\max,T}$ | reszta momentu w T | $\mathrm T$ |

Energia `dmi_energy` jest agregatem wszystkich rodzajów DMI. `rotated_dmi_energy`
stanowi jego składową diagnostyczną; ponowne dodanie jej do `total_energy`
podwajałoby rDMI. Regresja `multilayer_reference_cpu_materializes_rotated_dmi_in_energy_and_rhs`
w `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs` potwierdza tę konwencję.

(discrete-realization)=
## Przyjęte iteracje, stop i publikacja

Każdy backtrack ponownie oblicza pełne sprzężone pole i energię. Odrzucona próba
nie publikuje pola, historii ani artefaktów. Po błędzie, anulowaniu w backtracku
lub wyczerpaniu line search adapter odtwarza ostatni przyjęty stan i jego pola.
Kontrola Stop pozostaje dostępna między próbami. Nie ma cichego przełączenia na Heuna.

Kryterium równowagi używa świeżego momentu w A/m i istniejącego potwierdzania
`RelaxationTorqueConfirmation`; opcjonalny zakres energii używa istniejącego
okna 50 przyjętych iteracji. Limit iteracji oznacza zakończenie bez deklaracji
zbieżności. Zerowa reprezentowalna zmiana przy niespełnionym stopie oznacza
stagnację. Iteracje BB nie przesuwają czasu fizycznego ani pseudoczasu; krok
przeszukiwania ma jednostkę m/A, a nie s.

(python-api)=
## Publiczny Python

| Python | Typ | Domyślnie | Jednostka SI | Walidacja | Znaczenie | Backend | Cel rozwiązanego IR |
|---|---|---|---|---|---|---|---|
| study.stages.add_relax.algorithm | enum | llg_overdamped | 1 | projected_gradient_bb in this lane | wybór minimizatora | FDM CPU/GPU in the explicitly gated implementation scope | relaxation.algorithm |
| study.stages.add_relax.max_steps | int \| None | None | 1 | positive integer | limit przyjętych iteracji | FDM CPU/GPU in the explicitly gated implementation scope | relaxation.stop.max_steps |
| study.stages.add_relax.tolT | float \| unset | unset | \mathrm T | positive finite, excludes tolA | moment w T | FDM CPU/GPU in the explicitly gated implementation scope | relaxation.stop.torque_tolerance_apm |
| study.stages.add_relax.tolA | float \| unset | unset | \mathrm{A\,m^{-1}} | positive finite, excludes tolT | moment w A/m | FDM CPU/GPU in the explicitly gated implementation scope | relaxation.stop.torque_tolerance_apm |
| study.stages.add_relax.energy_tolerance | float \| None | None | \mathrm J | positive finite or None | zakres energii | FDM CPU/GPU in the explicitly gated implementation scope | relaxation.stop.energy_tolerance_j |

(problem-ir)=
## ProblemIR i plan

Tabela wskazuje pola `FdmMultilayerPlanIR.relaxation`; źródłowy etap zachowuje
`algorithm` i kryteria stopu z publicznego DSL, a planner normalizuje `tolT` przez
przenikalność próżni. Właściwy JSON etapu pozostaje wynikiem kanonicznego eksportera
`world.py:_build_relax_llg_dynamics` i pipeline, nie osobnym ręcznym formatem.

(round-trip-and-failure-semantics)=
## Round-trip i błędy

Requested intent: `fdm`, `gpu`, `double`, `projected_gradient_bb` pozostają jawne.
Resolved execution: CPU oracle lub natywne operatory CUDA z hostowym sterownikiem BB.
Validation errors: sprzeczne jednostki momentu, niedodatnie limity oraz parametry
LLG przekazane do BB powodują błąd walidacji.
Unsupported combinations: FP32, inne tryby demag, frozen spins i pozostałe
niezakwalifikowane operatory są odrzucane; nie następuje cichy fallback.

`solver=`, `dt=`, `relax_alpha=` i limit czasu są kontrolami etapu LLG; etap BB ich
nie przekazuje. Globalne `study.solver(...)` może zachować adaptacyjną politykę
dla etapów LLG, lecz eksport SceneDocument nie dziedziczy jej do BB. BB dobiera
długość kroku przez aktualizację BB i line search; nie przesuwa czasu fizycznego. Requested/resolved minimizer pozostają `projected_gradient_bb`.
GPU pozostaje `gpu`, FP64 pozostaje `double`. Przed publikacją RunIntent API
sprawdza rozwiązaną, zakwalifikowaną ścieżkę FDM multilayer GPU; sam wybór
algorytmu nie wystarcza do przyjęcia zadania. Źródła mapowania:
`packages/fullmag-py/src/fullmag/world.py:_build_relax_llg_dynamics`,
`crates/fullmag-plan/src/fdm.rs:plan_fdm_multilayer` oraz
`crates/fullmag-runner/src/relaxation/provenance.rs:apply_energy_minimizer_provenance`.

Poniżej kompletny przypadek docelowy. Dyskretyzacja 2.5 nm jest wstępna;
wynik relaksacji nie stanowi dowodu zbieżności względem siatki.

```python
"""Single joint relaxation: a bimeron film and an antiparallel cylinder.

Requires object-scoped RotatedInterfacialDMI; legacy runtimes reject the term
rather than running a different Hamiltonian. No radius sweep or frozen spins.
The 2.5 nm grid is a preliminary discretization, not a convergence claim.
"""

# %% Study
import os
from pathlib import Path

import fullmag as fm

NM = 1e-9
CELL = (2.5 * NM, 2.5 * NM, 2.5 * NM)
# Use the managed writable project root, or the script directory locally.
OUTPUT_ROOT = Path(os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT", str(Path(__file__).resolve().parent))) / "bimeron-cylinder-relax-bb-gradient-results"

study = fm.study("bimeron_film_upper_cylinder_relax")
study.engine("fdm")
study.storage(output_dir=str(OUTPUT_ROOT), data_format="zarr")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(600 * NM, 600 * NM, 65 * NM),
    center=(0.0, 0.0, 27.5 * NM),
    padding=(0.0, 0.0, 0.0),
)
study.cell(*CELL)
# Global LLG integration policy; BB uses its own line search.
study.solver(dt_initial=1e-14, max_err=1e-6, integrator="rk23")

# Film spans z=-5..+5 nm. Material comes from the historical formula-guided
# R50 experiment; the 600x600x10 nm geometry follows Julia's film dimensions.
film = study.geometry(
    fm.Box(size=(600 * NM, 600 * NM, 10 * NM)), name="bimeron_film", object_id="bimeron-film"
)
film.Ms = 580000.0
film.Aex = 15e-12
film.Ku1 = 663920.0
film.anisU = (1.0, 0.0, 0.0)
film.alpha = 1.0
film.mesh(cell_size=CELL)
film.m = fm.texture.bimeron(
    radius=50 * NM,
    wall_width=4.732 * NM,
    vorticity=-1,
    helicity_rad=0.0,
    background_sign=1,
    plane="xy",
)

# Cylinder spans z=10..60 nm: a 5 nm surface-to-surface gap. Its initial
# magnetization is opposite to the film BACKGROUND, not its central core.
cylinder = study.geometry(
    fm.Cylinder(radius=50 * NM, height=50 * NM).translate((0, 0, 35 * NM)),
    name="upper_cylinder", object_id="upper-cylinder",
)
cylinder.Ms = 1000000.0
cylinder.Aex = 10e-12
cylinder.Ku1 = 0.0
cylinder.alpha = 1.0
cylinder.mesh(cell_size=CELL)
cylinder.m = fm.texture.uniform(-1.0, 0.0, 0.0)

# %% Object-scoped DMI: the upper cylinder has no DMI.
study.terms.add(fm.RotatedInterfacialDMI(D=0.004, object_ids=[film.object_id]))

study.fdm(
    default_cell=CELL,
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="three_d",
        common_cell_size=CELL,
        fft_backend="cufft",
    ),
)
study.demag()
# Finite geometry and its full demagnetizing field; no extra shape anisotropy,
# no artificial zero padding of a separately prescribed external field,
# no PBC, no frozen spins, no external drive and no inter-body exchange.
relax = study.stages.add_relax(
    stage_id="joint_relax",
    algorithm="projected_gradient_bb",
    max_steps=100000,
    tolT=1e-5,
)
# The runner force-emits terminal m even off cadence; this is an observation,
# not a checkpoint/resume artifact.
relax.autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=100,
            quantities=["step", "t", "mx", "my", "mz", "E_total", "max_torque_T"],
        ),
        fields=[fm.FieldAutosave("m", every_steps=5000)],
    )
)

```

## Realizacja FDM GPU: rezydentność numeryczna (02.11.2026)

Optymalizacja zachowuje powyższy Hamiltonian, FP64, ważoną metrykę,
representable chord i niezmienioną politykę BB/Armijo. Stan przyjęty,
gradient oraz próby są rezydentne na GPU; host odczytuje wyłącznie skalarne
redukcje dla decyzji i pobiera wektory dopiero na żądanie publikacji lub
artefaktu. Materiał, maska i rDMI pozostają własnością każdej warstwy, więc
parametry filmu nie przechodzą do walca. Rollback odtwarza dokładnie przyjęte m
przez D2D i odświeża pełne sprzężone pole przed potwierdzaniem momentu.

Snapshot publikacyjny nie może wywoływać CPU `ExchangeLlgProblem::observe`,
które tworzy workspace Newella/FFT mimo wyłączonej demagnetyzacji CPU.
Energie lokalne snapshotu są pobierane z tych samych kanonicznych funkcjonałów
anisotropii i DMI bez obliczania pól CPU. Wprowadzenie nowej ścieżki resident
wymaga ponownego parytetu dla różnych Ms, siatek i masek oraz rDMI przypisanego
tylko do jednej warstwy. Historyczny pięciokrokowy parytet powyżej dotyczy
poprzedniej realizacji; nowa realizacja pozostaje **NOT VERIFIED** do czasu
zarządzanego wykonania, w tym odrzuconej próby i odtworzenia stanu.

(implementation-mapping)=
## Mapa realizacji

Wspólna polityka istnieje w `relaxation/direct_minimizer.rs`, a nowe sterowanie
w `relaxation/multilayer_bb.rs:execute_multilayer_bb`. Adaptery zachowują własność operatorów CPU i CUDA. Rezydentny kontroler GPU
`fdm/gpu/cuda/multilayer_bb_resident.rs:execute_resident_bb` korzysta z tej
samej skalarnej polityki `direct_minimizer.rs:projected_gradient_step_size_from_products`.
`backends/fdm/gpu/cuda/runtime/multilayer_bb.cu:context_multilayer_bb` posiada
retraction/capture/restore i redukcje: energie lokalne, moment, gradient,
ważony chord oraz iloczyny po transporcie. Redukcja DMI używa tożsamości
Eulera dla jednorodnego funkcjonału kwadratowego (pole zawiera kanoniczną
korektę brzegową); rDMI jest sumowane raz i tylko z pola własnej warstwy.
Bufory `pre_step_m`, `k1`, `k2`, `k3` są ponownie użyte wyłącznie w ścieżce BB,
bez równoległego użycia integratora LLG. Ewaluacja oraz osobna walidacja retraction przesyłają po 20 skalarów FP64
na warstwę jednym D2H i jedną synchronizacją na operację. Walidacja próby
sprawdza skończoność wektora oraz kwadratu normy i odrzuca normę nie większą
od najmniejszej dodatniej normalnej liczby FP64, tak jak kanoniczna
`vector_math.rs:normalized_vec3`. Niepoprawna próba wraca do backtrackingu
bez obliczania pola. Błąd enqueue próby wymusza odtworzenie stanu
przyjętego i świeże pole; raport zachowuje błąd pierwotny oraz ewentualny
błąd odtworzenia. Pełny snapshot powstaje na początku i na końcu.
Dla przyjętej iteracji adapter najpierw zbiera sumę wymagań live oraz
należnych pól harmonogramu/autosave. Gdy wymagają jedynie `m` lub jego
komponentów, `multilayer_bb.rs:snapshot_native_multilayer_bb_m` pobiera tylko
natywne M (jeden wektor na warstwę) i zachowuje już zredukowane energie,
moment oraz skalary obiektów GPU; nie oblicza ponownie energii CPU. Każde
inne pole, pochodna lub gęstość energii wymaga pełnego snapshotu.
Żądanie live jest przechwytywane raz dla wyboru snapshotu i publikacji;
nie ogranicza harmonogramu artefaktów ani terminalnego katalogu pól.

(validation)=
## Weryfikacja przed uruchomieniem właściwego przypadku

- Regresja współdzielonej polityki: norma aktywnych spinów, maski, energia malejąca, świeże pole w backtracku, brak czasu, limit bez fałszywej zbieżności i odtworzenie po błędzie.
- Zarządzany mały przypadek CPU/GPU FP64 z dwiema różnymi siatkami i scoped rDMI: energia, moment, przyjęte kroki i końcowe m.
- Receipt urządzenia i faktycznej ścieżki CUDA; build nie stanowi parytetu.
- Dopiero potem nowy przebieg właściwy, bez sweepa i bez nadpisania starego wyniku.

Testy kompilowane pozostają niewykonane na czas zakazu użytkownika; bramka
runtime/naukowa i testy interpretowane są odrębne.

Zapisany przypadek parytetu ma siatkę wspólną `[8, 8, 4]`, warstwę `[8, 8, 2]`
oraz walec `[4, 4, 4]` z 48 aktywnymi i 16 nieaktywnymi komórkami. Obiekty mają
różne Ms, Aex i Ku; rDMI jest przypisane wyłącznie warstwie. Na identycznym
pakiecie źródeł `35893a827d16569f2b18f81ee2f8ddc6296fee5a2279edc65db60e96a3751924`
wykonano przebiegi CPU `run-live-58daa53f71625d61dc8b7dadb9292bdf8a475454dfea9695e1fca58ba46d7334`
i GPU `run-live-4da1e9c9f65c20447102425953a71be4580d67d237bdb99fe09f30c06012de5e`.
Receipt GPU potwierdza RTX 4080 SUPER, CUDA FP64, cuFFT i brak fallbacku.

Porównanie obejmuje 121 kontroli bez błędów numerycznych: maksymalna różnica m
wynosi `6.52e-13`, energii `3.08e-33 J`, pola efektywnego `3.89e-5 A/m`,
a momentu `1.64e-11 T`. Energia maleje; normy, maski i zerowe pole rDMI walca
są poprawne. Pięć odzyskanych długości kroku BB jest dodatnich i zmiennych.
Czas fizyczny oraz dt pozostają zerowe, a zakończenie limitem pięciu kroków
nie jest oznaczone jako zbieżność. Wykonywalne sprawdzenie zachowano w
`examples/bimeron-cylinder-relax/compare_bb_results.py`; manifesty i położenie
raportów podaje [checkpoint zadania](../audits/2026-10-29-bb-restart-checkpoint.json).

Historyczny raport zachowuje osiem diagnostyk formatu artefaktów: indeks pól
używał wspólnego numeru próbki etapu również w `payload_ref`, mimo że tablice
Zarr mają wiersze lokalne dla każdej wielkości. Poprawka producenta z 02.11.2026
w `crates/fullmag-runner/src/autosave_storage.rs:AutosaveTargetState::append`
zachowuje `stage_sample_index` jako istniejący porządek pól etapu oraz globalny
`target_sample_index`, lecz wyznacza wiersz `payload_ref` oddzielnie dla każdej
wielkości. Liczniki rosną dopiero po pomyślnym zapisie. Zarr oraz HDF5 korzystają
z tej samej mapy; wznowienie rozpoczyna nowy etap z lokalnymi indeksami od zera.
Historyczne wyniki i indeksy nie są przepisywane. Comparator traktuje błędny
wiersz `payload_ref` jako błąd, natomiast różnica globalnego `stage_sample_index`
i wiersza tablicy konkretnego pola jest poprawna. Zarządzane potwierdzenie zapisu
co najmniej dwóch pól po tej poprawce pozostaje **NOT VERIFIED**.

(limitations)=
## Ograniczenia

Bieżący zakres obejmuje statyczny układ open 3D FP64 bez frozen spins i bez
przestrzennego zróżnicowania Ms wewnątrz obiektu. Koszt odczytu skalarów i publikacji pól pozostaje jawny. Ograniczony przypadek parytetu nie kwalifikuje całej
macierzy materiałów, geometrii, obsługi przerwań ani wydania produkcyjnego.

(scientific-bibliography)=
## Źródła naukowe

1. Barzilai i Borwein (1988), *Two-point step size gradient methods*, [DOI](https://doi.org/10.1093/imanum/8.1.141).
2. Exl i in. (2014), *LaBonte's method revisited*, [DOI](https://doi.org/10.1063/1.4862839).
3. Kanoniczny kontrakt `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`, sekcja representable chord.
4. `crates/fullmag-runner/src/relaxation/direct_minimizer.rs`: `projected_gradient_step_size_update`, `representable_chord_energy_linear_increment`, `projected_gradient_trial_magnetization`.
5. `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs`: `snapshot_native_multilayer_observables`, `execute_cuda_fdm_multilayer_with_live`.

(source-code-index)=
## Indeks kodu

| Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|
| crates/fullmag-runner/src/relaxation/vector_math.rs | tangent_gradient_from_field | Kanoniczna istniejąca polityka lub granica realizacji PG-BB. |
| crates/fullmag-runner/src/relaxation/direct_minimizer.rs | energy_metric_dot | Kanoniczna istniejąca polityka lub granica realizacji PG-BB. |
| crates/fullmag-runner/src/relaxation/direct_minimizer.rs | projected_gradient_trial_magnetization | Kanoniczna istniejąca polityka lub granica realizacji PG-BB. |
| crates/fullmag-runner/src/relaxation/direct_minimizer.rs | projected_gradient_step_size_update | Kanoniczna istniejąca polityka lub granica realizacji PG-BB. |
| crates/fullmag-runner/src/relaxation/direct_minimizer.rs | representable_chord_energy_linear_increment | Kanoniczna istniejąca polityka lub granica realizacji PG-BB. |
| crates/fullmag-runner/src/relaxation/vector_math.rs | max_torque_from_field | Kanoniczna istniejąca polityka lub granica realizacji PG-BB. |
| packages/fullmag-py/src/fullmag/world.py | _build_relax_llg_dynamics | Kanoniczna istniejąca polityka lub granica realizacji PG-BB. |
| crates/fullmag-plan/src/fdm.rs | plan_fdm_multilayer | Kanoniczna istniejąca polityka lub granica realizacji PG-BB. |
| crates/fullmag-runner/src/relaxation/provenance.rs | apply_energy_minimizer_provenance | Kanoniczna istniejąca polityka lub granica realizacji PG-BB. |
| crates/fullmag-api/src/live_accepted_execution.rs | bounded_fdm_gpu_bb_plan | Kwalifikacja planu GPU przed publikacją RunIntent. |
| packages/fullmag-py/src/fullmag/runtime/script_builder.py | _scene_relax_stage_kwargs | Round-trip BB bez dziedziczenia czasowych kontroli LLG. |
| crates/fullmag-runner/src/fdm/mod.rs | reject_adaptive_multilayer_plan | Kwalifikacja BB bez interpretowania globalnej polityki LLG jako kroku fizycznego. |

| backends/fdm/gpu/cuda/runtime/multilayer_bb.cu | context_multilayer_bb | FDM GPU resident FP64 vector algebra and layer-local reductions; runtime NOT VERIFIED. |
| crates/fullmag-runner/src/fdm/gpu/cuda/multilayer_bb_resident.rs | execute_resident_bb | FDM GPU scalar Armijo and stop controller; runtime NOT VERIFIED. |
| crates/fullmag-runner/src/relaxation/direct_minimizer.rs | projected_gradient_step_size_from_products | Shared scalar BB1/BB2 restart policy. |
| crates/fullmag-runner/src/fdm/gpu/cuda/multilayer_bb.rs | snapshot_native_multilayer_bb_m | FDM GPU M-only accepted publication preserving resident scalar reductions. |
| crates/fullmag-runner/src/autosave_storage.rs | append | Per-quantity payload rows with preserved logical stage and target ordinals. |
| crates/fullmag-plan/src/fdm.rs | fdm_multilayer_cuda_projected_bb_error | Admit aligned FP64 CUDA PG-BB with periodic XY and open Z. |
| crates/fullmag-fdm-demag/src/newell.rs | try_compute_periodic_xy_newell_kernels | Fold self and shifted image tensors into the circular XY grid. |
| backends/fdm/api/c_api.cpp | fullmag_fdm_backend_set_multilayer_xy_periodic_v1 | Validate FFT shape and set layer-local seams. |
| crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs | materialize_airbox_observation_snapshot_gpu | Evaluate the accepted state on a compatible open-Z target grid. |

### Lateral periodic cells (FP64 CUDA PG-BB)

The aligned three-dimensional solver uses one lateral lattice for every object.
For common cell counts $N_x,N_y,N_z$ and cell pitches $h_x,h_y,h_z$ in metres,
the periods are $L_x=N_x h_x$ and $L_y=N_y h_y$. The Z boundary is open.
For each source–destination pair, the dimensionless Newell tensor is summed
over the finite image rectangle $[-I_x,I_x]\times[-I_y,I_y]$ about the
centred lateral lag. The pair's vertical displacement is retained in every
image. Beyond 40 times the largest cell pitch, each image uses the shifted
Newell kernel’s point-dipole approximation. For an even cell count, the two equivalent half-period lags are
averaged to preserve reflection parity and pair reciprocity. The convolution
uses $N_x\times N_y\times 2N_z$ FFT samples. This is a truncated lattice
sum, whose image counts are part of the requested and resolved provenance.

The exchange and rDMI stencils wrap on an axis only when the native object
grid spans the full common period on that axis. Existing active-cell masks
still apply. A smaller centred cylinder has open local surfaces and couples
to its copies magnetostatically. Each field and its corresponding energy use
the same boundary condition, so the line search compares consistent energies.

The implementation scope is strict double CUDA with aligned grids and PG-BB.
Validation compares shifted and self tensors against direct image sums,
verifies local seam fields and energies, and exercises the coupled minimizer
on CUDA. CPU execution, other multilayer integrators and periodic Z require
their own qualification. See the pair-convolution formulation in
[Lepadatu (2019)](https://doi.org/10.1063/1.5116754).

### Airbox observation on the periodic cell

For the same CUDA lane, a compatible Airbox spans one complete period in X and
Y, has the common cell pitch, and contains the aligned source grids. Its Z
extent may include additional layers of air. Each active source cell contributes
its physical magnetization $M_{s,i}\mathbf m_i$ to the corresponding target
lattice cell. The other lattice cells contribute zero magnetization.

```{math}
:label: eq-multilayer-bb-periodic-airbox
\mathbf H^{\mathrm{obs}}_{\mathrm{demag},j}
  = -\sum_i \mathbf N^{\mathrm{XY}}_{j-i}\, M_{s,i}\mathbf m_i .
```

| Symbol | Meaning | SI unit |
|---|---|---|
| $i$ | Active source cell index on the observation lattice | $1$ |
| $j$ | Observation cell index | $1$ |
| $\mathbf N^{\mathrm{XY}}_{j-i}$ | Cell-averaged tensor with the resolved finite XY images and open Z | $1$ |
| $\mathbf H^{\mathrm{obs}}_{\mathrm{demag},j}$ | Demagnetizing field on the Airbox lattice | $\mathrm{A\,m^{-1}}$ |

The observation uses cuFFT on the circular XY grid with doubled target Z
extent. It consumes the accepted magnetization and publishes an independent
target carrier through the existing field resource. It does not enter the
minimizer or alter an accepted step. The carrier identifies the observation
boundary, resolved image counts and FFT shape. An incompatible target produces
an unavailable Airbox field. Python and ProblemIR use the existing universe
and periodic boundary declarations.

The numerical gate compares the observation values against the pair operator
at active source cells and an independent finite-image reconstruction in air.
Runtime acceptance also requires the selected accepted step, material masking
and field presentation to agree in the 2D and 3D consumers.
