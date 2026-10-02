# Nodalne `M_s` w sekcyjnym źródle waveguide 2.5D

- Status: FEM CPU bounded reference `source_visible / unvalidated`; nota
  zamraża interpretację nodalnego pola `M_s` i regułę całkowania, ale nie
  stanowi dowodu managed runtime, MFEM, GPU ani kwalifikacji fizycznej.
- Właściciel: Fullmag FEM frequency-domain waveguide backend.
- Ostatnia aktualizacja: 2026-10-03.
- Powiązany plan: `docs/superpowers/plans/2026-09-12-eigensolve-dispersion-nonzero-k-plan.md`.
- Powiązane kontrakty: `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`,
  `docs/physics/0828-fem-frequency-domain-floquet-demag.md` oraz
  `docs/adr/0031-fem-nonzero-k-dispersion-representations.md`.

Ta nota opisuje jedną zamkniętą poprawkę w bounded assemblerze przekroju
waveguide. Wcześniejsza ścieżka używała wartości `M_s` w węźle źródła jako
stałej elementowej. Kontrakt materiałowy wymaga natomiast wartości parametru
w punkcie całkowania właściciela elementu. Dla jawnie dostarczonego pola
nodalnego przyjmujemy więc jego dokładną interpolację P1 i całkujemy wynik
analitycznie. Wszystkie twierdzenia o wykonaniu pozostają związane z
`source_visible`; źródło nie jest produkcyjnym assemblerem MFEM.

## 1. Zakres i reprezentacja

`FloquetWaveguideCrossSectionProblem::saturation_magnetization_a_per_m` jest
opcjonalnym, typowanym buforem `node_count` wartości w `A/m`. Gdy wskaźnik jest
obecny, `saturation_magnetization_count` musi być równy liczbie węzłów, a
wartości muszą być skończone i nieujemne. W każdym trójkącie `T` pole ma
znaczenie

```text
M_s(r) = sum_l M_s,l N_l(r),                 M_s,l [A/m]
delta_m(r) = sum_j N_j(r) e_j q_j,           delta_m [1]
delta_M(r) = M_s(r) delta_m(r),              delta_M [A/m]
```

`N_i` są bezwymiarowymi funkcjami kształtu P1, `e_j` są bezwymiarowymi
wektorami lokalnej ramy stycznej, a `q_j` są bezwymiarowymi amplitudami.
`delta_m` jest bezwymiarowym zaburzeniem znormalizowanym, natomiast
`delta_M` jest jego fizycznym odpowiednikiem w `A/m`.
Wskaźnik pusty zachowuje dawną gałąź jednorodną z parametrem
`uniform_saturation_magnetization_a_per_m`; ta gałąź jest pozostawiona w
oryginalnej arytmetyce dla dokładnej zgodności istniejących przypadków.

Assembler opisuje dwuwymiarowy przekrój niezmienniczy wzdłuż osi `z`. Macierze
sekcji są całkami na przekroju, a więc mają normę na jednostkę długości osi.
`normalization_length_m` jest metadanymi porównania z ekstrudowanym modelem 3D
i nie skaluje macierzy przekroju.

## 2. Dokładne momenty P1

Dla elementu o polu `|T|` część poprzeczna źródła używa momentu stopnia drugiego

```text
W_perp(j) = int_T M_s N_j dA
          = |T|/12 * sum_l M_s,l * (2 if l == j else 1).
```

Część osiowa, pochodząca z `i k M_z`, używa momentu stopnia trzeciego

```text
W_axial(i,j) = int_T M_s N_i N_j dA
             = |T|/60 * sum_l M_s,l * c(i,j,l),

c(i,j,l) = 6  when i == j == l,
            2  when exactly two of i,j,l are equal,
            1  otherwise.
```

Wynika to z dokładnej całki barycentrycznej
`int_T N_i N_j N_l dA = |T| c(i,j,l)/60`. Nie wolno zastępować tych
momentów `M_s,j` razy macierzą masy, ponieważ daje to inną interpolację
materiału i zniekształca mieszane źródło. Dla stałego `M_s` oba wzory redukują
się do `|T| M_s/3` oraz do diagonalnych/off-diagonalnych wag
`|T| M_s/6` i `|T| M_s/12`.

Poprzednia błędna reguła source-node traktowała `M_s,j` jako stałą dla każdej
kolumny źródłowej:

```text
W_perp_old(j) = |T| M_s,j / 3,
W_axial_old(i,j) = |T| M_s,j * (1/6 if i == j else 1/12).
```

Dla `M_s,l = (1.5, 2.5, 4.0) A/m` reguła ta różni się od obu dokładnych
momentów P1. Kontrola interpretowana wyznacza tę różnicę jawnie, aby regresja
nie przechodziła przez przypadek, w którym wszystkie węzły mają jednakowe
`M_s`.

Dla konwencji `exp(-i k z)` fizyczne źródło słabego równania ma postać

```text
S_i = int_T M_s(r) [grad(N_i) dot delta_m_perp
                    + i*k*N_i*delta_m_z] dA.
```

Na poziomie silnym ten sam kontrakt ma źródło `-i*k*M_z` w równaniu
zmodyfikowanego Helmholtza, a pole podłużne spełnia `h_z = +i*k*phi`.
Poniższy dodatni znak w słabej całce jest wynikiem całkowania przez części;
nie zmienia on tych silnych znaków.

Zwracany `A_phiq` jest blokiem deskryptorowym w równaniu
`P phi + A_phiq q = 0`, dlatego assembler przechowuje negację obu części:

```text
A_phiq(k) = A_phiq_perp + i*k*A_phiq_axial,
```

gdzie oba bloki są ujemnym odpowiednikiem odpowiednio `grad(N_i) dot M_perp`
i `M_z`. Znak `+i*k` w fizycznym źródle oraz znak `-i*k` wynikający z
deskryptorowego składania muszą pozostać rozróżnione. Sprzężony blok `A_qphi`
dziedziczy istniejącą konwencję `qphi_feedback_scale`; ta poprawka nie zmienia
jej routingu ani wartości domyślnej.

## 3. Jednostki i norma

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| `r`, `x`, `y`, `z` | położenie | `m` |
| `k` | podpisana liczba falowa osi waveguide | `rad m^-1` |
| `M_s`, `M_s,l` | magnetyzacja nasycenia | `A m^-1` |
| `N_i`, `e_j`, `q_j`, `delta_m` | funkcja P1, rama, amplituda i znormalizowane zaburzenie styczne | `1` |
| `delta_M` | fizyczne zaburzenie magnetyzacji, `M_s delta_m` | `A m^-1` |
| `|T|` | pole przekroju elementu | `m^2` |
| `W_perp`, `W_axial` | moment materiałowy przekroju | `A m` |
| `A_phiq_perp` | rzeczywisty poprzeczny blok źródłowy przekroju | `A` |
| `A_phiq_axial` | osiowy blok przed pomnożeniem przez `i k` | `A m` |
| `i k A_phiq_axial` | osiowy wkład zespolonego bloku `A_phiq(k)` | `A` |
| `normalization_length_m` | dodatnia długość tylko do porównania 3D | `m` |

Ponieważ jest to całka 2D, nie dzielimy jej przez `normalization_length_m`.
Porównanie z modelem `compareextruded3D` musi najpierw podzielić całkę 3D przez
rzeczywistą długość ekstrudowania. Taka zgodność nie została tą poprawką
zmierzona.

## 4. Implementacja i granice planu S09

Implementacja znajduje się w `assemble_floquet_waveguide_cross_section_blocks`
oraz w jego typowanym wejściu `FloquetWaveguideCrossSectionProblem`. Gałąź
nodalna oblicza lokalne `M_s,l`, `W_perp` i `W_axial`; gałąź bez bufora zachowuje
dotychczasowe wagi uniform. Nie wprowadzono zmiany Python DSL, ProblemIR,
capability matrix, planera, wyboru CPU/GPU ani publicznego routingu. W
szczególności ta nota nie ogłasza gotowości:

- natywnego Helmholtza dynamicznego `demag-k` w managed MFEM,
- `k^2` exchange w produkcyjnym operatorze,
- niezależnych realizacji GPU,
- porównania `compareextruded3D` albo walidacji TetraX,
- pełnego runtime z tożsamością urządzenia, residualami i artefaktami.

Są to osobne bramy planu S09/S00--S12 i muszą zachować ten sam typowany
`requested`/`resolved` execution contract. Bounded assembler jest tylko
deterministycznym właścicielem elementowych współczynników używanym do testów
kontraktu i zbieżności.

## 5. Bramy walidacji

1. **Kontrola źródła i kontraktu.** Sprawdzić walidację liczności bufora,
   nieujemność i skończoność `M_s`, dokumentację nodalnej semantyki oraz
   zachowanie gałęzi uniform.
2. **Niezależna kontrola interpretowana.** Zastosować niezależną kwadraturę
   barycentryczną stopnia 3 dla mieszanego, zespolonego źródła przy
   `k = -3, 0, +3 rad/m`; sprawdzić zgodność ze wzorami momentów, odzyskanie
   uniform oraz sprzężenie dla rzeczywistego źródła. Ten test jest kontrolą
   źródłową, nie wykonaniem FEM.
3. **Regresja native.** Przygotowana regresja C++ używa tej samej niezależnej
   reguły stopnia 3, zmiennego nodalnego `M_s`, obu znaków `k`, `k=0`, źródła
   poprzecznego i osiowego oraz porównania z uniform. W bieżącej sesji testu
   native nie wolno kompilować ani uruchamiać.
4. **Runtime naukowy.** Przed kwalifikacją trzeba wykonać managed FEM CPU/GPU,
   sprawdzić rzeczywiste `k`, `k^2`, znaki źródeł `-i k M_z`/`+i k phi`, normy
   per-length, residuals i provenance. Następnie porównać sekcję z
   `compareextruded3D` oraz niezależnym TetraX. Brak tych artefaktów oznacza
   `NOT VERIFIED`.

## 6. Mapa źródeł

Pełna mapa symboli i twierdzeń znajduje się w
`docs/physics/0832-fem-waveguide-nodal-ms-quadrature.source-map.json`. Kluczowe
źródła to:

- `backends/fem/include/frequency_domain/floquet_waveguide_cross_section.hpp`:
  typ wejścia i semantyka pola nodalnego;
- `backends/fem/cpu/frequency_domain/floquet_waveguide_cross_section.cpp`:
  walidacja oraz lokalne momenty `W_perp`/`W_axial`;
- `backends/fem/tests/frequency_domain/floquet_waveguide_cross_section_test.cpp`:
  przygotowana regresja native, jeszcze nieskompilowana;
- `scripts/test_waveguide_nodal_ms_quadrature_source.py`: niezależna kontrola
  interpretowana bez uruchamiania native solvera;
- `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`:
  nadrzędny kontrakt parametrów materiałowych w punktach całkowania.
