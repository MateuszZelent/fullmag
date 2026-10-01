# Niezależny audyt Fullmag eigensolve i nonzero-k

**Data:** 1 października 2026 r.  
**Repozytorium:** `MateuszZelent/fullmag`  
**Branch:** `codex/eigensolve-dispersion-plan-20260912`  
**Audytowany commit:** `ab64bac46b7ceda295812da93244b2eba81174e4`  
**Wspólny przodek z odczytanym masterem:** `93f11dbc564c00b725d174ccb2fd0ff9a96493c9`  
**Odczytany master:** `d118a8bf991e5c9819d546081bf1e0af4469edd8`.

W porównaniu z tym masterem branch ma 301 własnych commitów i pozostaje 166 commitów za nim. Analiza nie ogranicza się do ostatniego commita: uwzględnia historię zmian map redukcji, certyfikatów pól, linearyzacji, kapsuł wykonawczych oraz kolektorów. Nie oznacza to osobnej recenzji każdego z 301 diffów. Wszystkie wskazania kodu poniżej odnoszą się do zamrożonego SHA, nie do ruchomego HEAD ani domyślnego mastera.

**Tryb:** wyłącznie odczyt repozytorium. Nie zmieniono kodu Fullmag, nie wykonano commitów, produkcyjnych buildów ani kompilacji/testów natywnych. Uruchomiono jedynie własne, małe obliczenia Python bez importowania Fullmag.

**Granica kompletności:** przeprowadzono pogłębiony przegląd rdzenia operatorowego i wybranych odcinków potoku danych. Nie ukończono pełnego przeglądu wszystkich ścieżek Python→ProblemIR→planner→ABI, wszystkich writerów i walidatorów, wszystkich ADR-ów/backend masterplanu ani całego frontendu. Ich brak audytowego pokrycia jest jawnie oznaczony; nie jest utożsamiany z brakiem implementacji. Źródła repozytorium były dostępne. Brakujące lokalne artefakty wykonania to osobny problem.

## A. Werdykt

**Nie ma obecnie podstaw do uznania tego snapshotu za naukowo zakwalifikowany solver dyspersji DE/BV z demagiem. Istnieje jednak rzeczywista implementacja odpowiedniej architektury: pełny operator styczny, fazowa redukcja także bloków magnetostatycznych, Schur/SLEPc oraz rekonstrukcja i kontrola oryginalnych równań. To nie jest samo próbkowanie k ani analityka udająca solver.** [C03], [C04], [C05]

Dla jednorodnego filmu, FEM CPU/double, tetraedrów P1, wymiany, Zeemana, dynamicznego demagu i pominiętego tłumienia kod stanowi uzasadnionego kandydata do walidacji. Nie otrzymałem dowodu poprawnego wykonania całej nowej serii na audytowanym commicie. Nie twierdzę zatem, że ta kombinacja na pewno nie działa — twierdzę, że jej wiarygodność nie została wykazana dostępnymi dowodami.

Potwierdziłem trzy konkretne błędy:

1. Niedocałkowanie wymiany dla `prism6`, z dwoma dodatkowymi zerowymi kierunkami lokalnej energii.
2. Fallback starszego endpointu API, który może zastąpić żądany sample modem bez sample.
3. Mieszanie Hz z jednostką osi w obwiedni widma modalnego.

Ponadto potwierdziłem ograniczenie kolektorów do `mode_0000` i utrzymanie publicznego odrzucenia anizotropii/DMI. Nie są one dowodem błędnych częstotliwości obsługiwanego filmu, ale uniemożliwiają uznanie całego planu za zrealizowany. [C01], [C02], [C06], [C07], [C08]

**Ważne rozróżnienie:** aktualny przykład filmu 40×40×10 nm jawnie wybiera `topology="tetrahedral"`. Błąd `prism6` nie jest dowodem, że jego aktualny pilot tetraedralny zawodzi z tej przyczyny. [C09]

## B. Findings i dowody

Priorytety: P0 — krytyczne, szerokie zagrożenie poprawności; P1 — istotny błąd lub blokada deklarowanego zakresu; P2 — ograniczenie walidacji/produktu wymagające naprawy; P3 — porządkowanie. Nie stwierdzam potwierdzonego P0. Braku wyników nie zamieniam w zmyślony błąd P0.

### B1. Potwierdzone błędy kodu

| ID | Priorytet | Źródło, symbol, linie w SHA | Warunek i błędne zachowanie | Wpływ | Naprawa i regresja |
|---|---|---|---|---|---|
| F01 | P1 | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp`, `assemble_native_magnetic_a_qq`, 1990–2110; szczególnie wybór reguły w 2020–2040 | Legalny P1 `prism6`, A>0; wymiana używa `IntRules.Get(..., 1)` | Macierz elementowa ma rząd 3 zamiast 5; dwa niejednorodne kierunki otrzymują zerową energię wymiany. Możliwe sztuczne miękkie mody i błędna zbieżność | Reguła dobrana do geometrii i Jacobianu. Dla afinicznego prism6 co najmniej rząd 2. Test macierzy, nullspace, permutacji węzłów, deformacji i porównanie z nadcałkowaniem. Nie ograniczać testu do jednej częstotliwości |
| F02 | P1, warunkowy zasięg API | `crates/fullmag-api/src/router_v2/handlers/analysis/eigen.rs`, `get_mode`, 67–90 | Żądanie zawiera `sample_index`; odczyt pliku sample nie powiedzie się z dowolnego powodu; istnieje plik legacy | Zamiast błędu można zwrócić inny mod, bez potwierdzenia zgodności k/sample. Maskuje też uszkodzony JSON | Jawny sample musi być autorytatywny: bez fallbacku do legacy. Testy: brak pliku, uszkodzony JSON, istniejący legacy, różne próbki o tym samym raw index. Nowy `get_mode_v2`, 103–119, nie ma tego fallbacku |
| F03 | P2 | `apps/control-room/src/shared/analysis-charts/frequencyRenderModels.ts`, `frequencySpectrumRenderModel` / `spectralEnvelope`, 8–72 | `frequencyValue` w GHz/MHz, `dampingRateHz` w Hz; szerokość trafia bez konwersji do mianownika | Błędna szerokość i kształt obwiedni, nawet prawie płaski wykres. Nie zmienia natywnych wartości własnych | Obliczenia całej obwiedni w Hz albo konwersja szerokości do jednostki osi. Test niezmienniczości Hz↔MHz↔GHz. Osobno ustalić, czy pole damping oznacza FWHM, HWHM czy szybkość zaniku |

Źródła: [C01], [C02], [C06].

**F01 — niezależny kontrprzykład.** Dla jednostkowego prostego graniastosłupa o objętości 1/2 i kolejności trzech węzłów dolnych, następnie trzech górnych, przyjmijmy skalarne wartości:

`v = [1, -1, 0, -1, 1, 0]`.

Dla macierzy `K_ij = ∫ grad(N_i)·grad(N_j) dV` obliczenie jednopunktowe daje `vᵀK₁v ≈ 0`, natomiast poprawne całkowanie daje `vᵀKv = 7/6`. Wartości własne wynoszą odpowiednio:

- jednopunktowo: około `0, 0, 0, 1/4, 1/3, 3/4`;
- poprawnie: około `0, 1/6, 1/4, 1/3, 1/3, 3/4`.

Reguła trójkątna stopnia 2 pomnożona przez dwupunktową regułę Gaussa wzdłuż grubości odtwarza macierz odniesienia z błędem Frobeniusa około `3.7e-16`. To potwierdza naprawę dla tego afinicznego elementu, a nie dla dowolnie zdeformowanych prismów. Konstrukcja reguł MFEM dla prismów jest iloczynem reguł trójkąta i odcinka. [M01]

**F02 — granica wniosku.** Potwierdzony jest błąd zachowania konkretnego endpointu. Nie wykazałem w przeglądarce, że współczesny Control Room zawsze używa właśnie tej starszej trasy. Nie przypisuję błędu bezpieczniejszemu `get_mode_v2`.

**F03 — niezależny kontrprzykład.** Przy odstrojeniach `0.1 GHz` i polu szerokości `1e8 Hz`, traktowanym na potrzeby testu jako FWHM, poprawna znormalizowana wartość Lorentza wynosi `0.2`. Formuła mieszająca te jednostki daje praktycznie `1`. Jest to test rachunku funkcji, nie wykonany test TypeScript lub browser.

### B2. Potwierdzone ograniczenia i brakujące dowody

| ID | Priorytet / rodzaj | Lokalizacja | Ustalenie | Warunek zamknięcia |
|---|---|---|---|---|
| G01 | P1, nieukończony zakres | `crates/fullmag-runner/src/fem/eigen_shared_domain.rs`, `validate_shared_domain_modal_scope`, 1181–1282 | Publiczny shared-domain modal odrzuca obecność Ku/Ku2, osi anizotropii, kubicznej anizotropii, przestrzennych A/Ku i DMI oraz powierzchniowego Ks. Nawet jawne Ku=0 podlega strażnikowi obecności | Wersjonowane, zgodne operatory i accepted state, testy pochodnych i runtime dla każdej promowanej kombinacji. Nie usuwać strażnika jako pozornej naprawy |
| G02 | P1 dla kwalifikacji gałęzi, nie błąd samego solve | `scripts/collect_de_bv_thickness_comparison.py`, `collect_record`, 27–110; `scripts/collect_signed_de_bv_dispersion.py`, `collect` | Kolektor wymaga jednego wiersza, sample 0 i raw mode 0; otwiera `sample_0000/mode_0000.json`. Seria może porównywać indeksy zamiast tej samej gałęzi | Kilka certyfikowanych kandydatów, complex consistent-mass MAC, klaster degeneracji, branch ID i profil. Zachować smoke jako jawnie ograniczony produkt |
| G03 | P1, brak dowodu wykonania | status implementacji, 1–89; kontroler `validation_cases` i pętla wykonania | Sukces buildu #188 i uruchomienie Γ nie dowodzą częstotliwości, poprawnego wektora ani aktualnego HEAD. Nie otrzymano kompletnej nowej serii | Kapsuła, manifest, receipt, pełne logi i artefakty związane z audytowanym źródłem; osobno hash kolektora |
| G04 | P2, rozbieżność modeli odniesienia | `examples/fem_de_smoke_numeric.py`, 55–103; `thin_film_thickness_oracle.py`, 1–120 | Pilot ma skończony airbox Dirichleta; oracle P00/N32 opisuje otwarty film. Już w Γ różnica modelowa jest mierzalna | Porównanie z odpowiednim analitycznym Γ dla skończonego airboxu oraz osobna ekstrapolacja do granicy otwartej |

Źródła: [C07], [C08], [C09], [C10], [C13], [C15], [C19].

G04 nie jest zarzutem, że jawny warunek Dirichleta jest błędem implementacji. Jest ostrzeżeniem przed nieadekwatnym porównaniem fizycznym.

### B3. Hipotezy wymagające rozstrzygnięcia

**H01 — realifikacja i duplikaty.** Końcowa selekcja w `floquet_modal_solver.cpp`, 3330–3460, sortuje kandydatów względem targetu i ogranicza count; w tej pętli nie ma fizycznego MAC. Realifikacja może dostarczyć reprezentacje q i iq tego samego modu. Należy prześledzić deduplikację aż do publikacji, ponieważ oddzielna ścieżka frequency-window ma własną logikę usuwania duplikatów. Nie stwierdzam bez tego, że każdy aktualny wynik publiczny zawiera duplikaty. Test musi odróżniać duplikat fazowy od dwóch liniowo niezależnych modów o tej samej częstotliwości. [C05]

**H02 — zgodność wariacyjna dla tekstur.** Uśrednianie i normalizacja m0 w kwadraturze, ramki węzłowe i rzutowanie pola muszą należeć do jednego dyskretnego modelu. Testem rozstrzygającym jest różniczkowanie tej samej dyskretnej energii na rozmaitości węzłowych magnetyzacji oraz porównanie z Aqq i sprzężeniami magnetostatycznymi. Nie zaliczam samej obecności lokalnych ramek do dowodu takiej zgodności. [C01], [C03]

**H03 — gauge poza podstawowym Γ.** Pełna polityka nullspace powinna zależeć od BC i trywialności faz na wszystkich identyfikacjach, nie tylko od tego, czy zapisany wektor k ma normę zero. Dotyczy to m.in. równoważnych punktów sieci odwrotnej. Nie wykazałem błędu tej polityki w aktualnym kodzie; wymagany jest oddzielny test Γ, granicy k→0, warunków Neumanna i faz równych jedności.

## C. Audyt fizyczny i matematyczny

### C1. LLG, czas i pencil

Przyjmuję m bezwymiarowe, H w A/m i γ0 w m/(A·s):

\[
\dot m=-\gamma_0 m\times H_\mathrm{eff}+\alpha m\times\dot m.
\]

Dla stacjonarnego, znormalizowanego m0 zapisujemy `m=m0+v+O(v²)`, `m0·v=0` i `H0=a m0`. Oznaczając `Jv=m0×v` oraz `Hv=DHeff[m0]v`, otrzymujemy:

\[
(I-\alpha J)\dot v=\gamma_0J(aI-DH_\mathrm{eff})v.
\]

W energetycznej reprezentacji stycznej:

\[
K=\mu_0M_s(aI-DH_\mathrm{eff}),\qquad
G_\alpha=-\frac{\mu_0M_s}{\gamma_0}(J+\alpha I),\qquad
Kq=\lambda G_\alpha q.
\]

Dla czasu `exp(+iωt)` mamy `λ=iω`, a częstotliwość w Hz to `Im(λ)/(2π)` dla dodatniej gałęzi. Stabilne tłumienie odpowiada `Re(λ)<0`, czyli `Im(ω)>0`. Inna jawna konwencja czasu zmienia mapowanie znaków, nie fizykę.

Natywna ścieżka Floqueta odwraca rotację eigenvalue przed kontrolą oryginalnego descriptoru: `lambda_imag = phase_sign * rotated_omega`, następnie używa `map_eigenvalue`. Nie znalazłem w tym odcinku uzasadnienia zarzutu zgubionego i lub 2π. Jest to ustalenie lokalne, nie certyfikat wszystkich endpointów i całego API. [C04]

`B_ext=0.1 T` wymaga `H_ext=B_ext/μ0`. Nie wolno po tej konwersji ponownie mnożyć precesji przez μ0, gdy używa się γ0=221100 m/(A·s). Hz→GHz wymaga kolejnego czynnika `1e-9`. Przykład zapisuje zarówno B, μ0, γ0, jak i rzeczywisty wektor k; niezależny rachunek dla otwartego filmu daje Γ opisane niżej. [C09]

### C2. Równowaga, pola przyjęte i zerowy H_eff

Kod kontroluje normę m0 na aktywnych węzłach, zgodność par periodycznych oraz skończone, nieujemne diagnostyki pola i torque. Aktualny HEAD nie wymaga już ściśle dodatniej amplitudy statycznego H_eff. Ta zmiana jest fizycznie zasadna. W assemblerze statyczna krzywizna jest aktywna dla flagi FIELD **lub** obecności uniaxial term. [C01], [C07]

Należy jednak rozdzielić:

- pole H_eff równe zero;
- brak tablicy/certyfikatu H_eff;
- brak zewnętrznego biasu;
- zerową krzywiznę energii.

To cztery różne sytuacje. Brak danych nie może być cicho zamieniany na pole zerowe. Zerowe pole nie może powodować wyłączenia niezerowego Hessianu. Z kolei mały torque nie dowodzi stabilnego minimum: potrzebna jest także kontrola krzywizny i modów niestabilnych.

Certyfikat musi wiązać m0, siatkę, materiały, faktyczne interakcje, BC, model demagu, rozkład pól i wersję linearyzacji. Sam napis `equilibrium_artifact.v8` albo `LinearizationState.v7` nie wystarcza. Migracji nie uznaję za ukończoną: dostępna dokumentacja nadal przedstawia ją jako pracę do domknięcia, a publiczny strażnik anizotropii pozostaje. [C07], [C15]

### C3. Ku: znak, jednostki, oś i Hessian

Dla energii objętościowej `E_K=-Ku(m·u)²`, z jednostkową osią u:

\[
H_K=\frac{2K_u}{\mu_0M_s}(m\cdot u)u,
\qquad
DH_K[v]=\frac{2K_u}{\mu_0M_s}(v\cdot u)u.
\]

Hessian ograniczony do płaszczyzny stycznej jest równy:

\[
K_K=2K_u\left[(m_0\cdot u)^2I_t-u_tu_t^T\right].
\]

Pierwszy składnik pochodzi z ograniczenia długości magnetyzacji i z `m0·H0`; drugi jest pochodną pola. Dlatego jednoczesne występowanie statycznej krzywizny i dynamicznego członu Ku nie jest samo w sobie podwójnym liczeniem. Błędem byłoby ponowne dodanie tej samej krzywizny albo jej usunięcie tylko dlatego, że H_ext=0.

W przejrzanym assemblerze występuje struktura `h_parallel*(e_i·e_j) - anisotropy_field*(e_i·u)*(e_j·u)`, zgodna z tym wyprowadzeniem dla odpowiednio zdefiniowanego accepted state. Nie znalazłem podstaw do twierdzenia, że cały Hessian Ku jest nieobecny w natywnym kodzie. Jednocześnie publiczna ścieżka nadal go nie dopuszcza. [C01], [C07]

Regresje muszą obejmować Ku dodatnie, ujemne i zero; u i −u; skalowanie nieznormalizowanej osi; brak biasu; rozdzielenie pól oraz jednostki J/m³. Dla Ku<0 i m0 prostopadłego do u pole H_K może być zerowe, choć jedna krzywizna jest dodatnia. Drugi kierunek może być Goldstone'owski — nie należy wymagać dodatniej, skończonej częstotliwości każdego przypadku anisotropy-only.

Własny test różnic skończonych na `m(q)=(m0+Tq)/sqrt(1+q·q)` potwierdził powyższy Hessian dla obu znaków Ku i trzech osi. Nie jest to test natywnego assemblera.

### C4. Demag: weak form, Schur i odtworzenie pól

Dla `H_demag=-∇φ` i M ograniczonego do magnetyka słaba postać wynosi:

\[
\int_\Omega\nabla\psi\cdot\nabla\phi\,dV
=\int_{\Omega_m}M\cdot\nabla\psi\,dV,
\]

z odpowiednimi warunkami zewnętrznymi i identyfikacjami periodycznymi. Ładunki powierzchniowe/interfejsowe są zawarte w dystrybucyjnym źródle i słabej postaci. Nie należy dodawać ich drugi raz obok poprawnie złożonego źródła objętościowego.

Descriptor ma strukturę:

\[
A_{qq}q+A_{q\phi}\phi=\lambda B_{qq}q,
\qquad
A_{\phi q}q+P\phi=0.
\]

Po rozwiązaniu potencjału:

\[
\phi=-P^{-1}A_{\phi q}q,\qquad
A_\mathrm{eff}=A_{qq}-A_{q\phi}P^{-1}A_{\phi q}.
\]

Dla odpowiednio zgodnej bazy jednorodnej relacja `A_qφ=-μ0 A_φq†` pokazuje dodatni wkład energii demagnetyzacyjnej po eliminacji. Przy teksturach i zmiennych materiałach trzeba sprawdzić faktyczne ważenie oraz dyskretną definicję przestrzeni stycznej, nie narzucać transpozycji na ślepo.

**Pozytywne ustalenie:** natywny solve rekonstruuje φ i oblicza osobno residual magnetyczny i potencjału. Gdy przekazano pełny descriptor assembly, dodatkowo wymaga certyfikacji oryginalnych bloków oraz szwów skalarnych, stycznych i kartezjańskich. Brak wymaganej pełnej certyfikacji powoduje odrzucenie, a nie tylko ostrzeżenie. [C04], [C05]

Przy identyfikacjach periodycznych surowe, nieredukowane wiersze przy szwie mogą zawierać reakcje więzów. Nie należy wymagać osobnego zerowania każdego takiego wiersza. Niezależna kontrola oryginalnej słabej postaci musi używać dopuszczalnych funkcji testowych oraz osobno sprawdzać więzy, szwy i gauge; nie może polegać tylko na ponownym wywołaniu tego samego zredukowanego MatMult.

Pozostaje konieczne sprawdzenie eksportowanego H_demag względem `−∇φ` na tej samej siatce i z tą samą projekcją masową. Poprawny reduced residual nie dowodzi poprawności dowolnie wyeksportowanego pola. Dla Neumanna wymagane są zgodność źródła z nullspace i jawny gauge; dla Dirichleta nie wolno usuwać rzeczywistej składowej fizycznego pola pod pretekstem gauge.

### C5. Istotna poprawka odniesienia Γ: skończony airbox

Przykład ma film t=10 nm i padding d=2 µm na stronę, z Dirichletem. Dla idealnego, jednorodnego Γ, periodyczności x/y i `φ=0` na obu zewnętrznych płaszczyznach z:

\[
L=t+2d,\qquad
\partial_z\phi=M_z\chi_{\mathrm{film}}-M_z t/L.
\]

W filmie dostajemy:

\[
H_{d,z}=-M_z(1-t/L),\qquad N_{zz}=1-t/L.
\]

Zatem referencje dla zadanych parametrów są różne:

| Model analityczny Γ | Częstotliwość |
|---|---:|
| Otwarty film, Nzz=1 | 9.309813709 GHz |
| Skończony airbox Dirichleta, d=2 µm | 9.299249694 GHz |
| Różnica względem otwartego filmu | −0.1134718% |

To obliczenie własne, a nie wynik Fullmag. Zakłada realizację zamierzonej periodyczności x/y i Dirichlet wyłącznie na zewnętrznych płaszczyznach z. Jest bezpośrednim testem tego, czy assembly realizuje właśnie te BC.

**Wniosek:** progu zgodności 0.1% z otwartym Kittelem nie można stosować bez rozliczenia tego błędu modelowego. Najpierw porównać ten sam problem brzegowy, następnie przeprowadzić zbieżność d→∞. Nie należy „naprawiać” solvera przez przesunięcie częstotliwości ani automatyczne rozluźnienie residualu.

### C6. Bloch/Floquet, klasy i packing

Konwencja żądana przez przykład to:

\[
f(r+\Delta r)=e^{-i k\cdot\Delta r}f(r).
\]

`build_phase_entries` sprawdza fazę względem `−k·translation`, buduje krawędzie w obu kierunkach, odwraca translację dla krawędzi przeciwnej i kontroluje zgodność cykli. W mapie magnetycznej air-only rows są pomijane; sentinel powietrza nie jest fizycznym węzłem magnetycznym. [C03]

Redukcja musi obejmować wszystkie cztery bloki:

`Aqq(k)=Cq† Aqq Cq`, `Aqφ(k)=Cq† Aqφ Cφ`, `Aφq(k)=Cφ† Aφq Cq`, `P(k)=Cφ† P Cφ`.

W przejrzanej implementacji redukowane są także bloki potencjału i sprzężenia. Istnieje więc rzeczywista zależność dynamicznego demagu od k. Dla pełnego pola quasiperiodycznego nie należy dodatkowo ręcznie dodawać exchange k² do operatora, którego zależność od k pochodzi już z C(k). Taki człon należy do osobnej reprezentacji obwiedni/2.5D. [C03], [C17]

Naprawa minimum-root odpowiada właściwemu kierunkowi kanonizacji, ale odbiór wymaga jednoczesnego sprawdzenia: identycznych klas przy odwróceniu i permutacji par, narożników i relacji przechodnich, kolejności klas po kanonizacji, magnetic-prefix, sentinela powietrza i zgodności byte-for-byte mapy użytej przez certyfikat v6, assembler oraz ABI. Przypadkowy identyczny wynik częstotliwości nie zastępuje tego testu.

W `build_phase_entries` występuje też bezwzględna tolerancja zgodności translacji `1e-10 m`. To wymaga uzasadnienia względem rozmiaru komórki i k: przy 25 rad/µm odpowiada skali fazy 0.0025 rad. Nie stwierdzam, że taka wada przechodzi cały solve — późniejszy certyfikat szwu może ją odrzucić. Jest to jednak istotny punkt budżetu tolerancji, nie uniwersalna bezwymiarowa stała.

## D. Audyt numeryczny i referencje

### D1. EPS, KSP i residuale

Przejrzana ścieżka stosuje SLEPc, rotowany pencil i shift-invert. KSP dla shifted action używa GMRES, prawego preconditioningu i normy niepreconditionowanej. Zapisuje też niezależnie odtworzony true residual oraz diagnostykę iteracji. Materializowany shifted operator jest opisany jako preconditioner; operatorem eigensolve pozostaje shell. [C04]

To istotne zabezpieczenia. PETSc rozróżnia normę residualu od błędu rozwiązania, a `KSPGetResidualNorm` może zwrócić normę przybliżoną. Również true residual SLEPc nie zastępuje kontroli fizycznych bloków i reprezentacji wektora. [M02], [M03], [M04]

Dla rekonstrukcji należy zachować co najmniej:

\[
\eta_m=\frac{\|A_{qq}q+A_{q\phi}\phi-\lambda Bq\|}
{\|A_{qq}q\|+\|A_{q\phi}\phi\|+|\lambda|\|Bq\|},
\quad
\eta_\phi=\frac{\|P\phi+A_{\phi q}q\|}{\|P\phi\|+\|A_{\phi q}q\|}.
\]

Przypadki z zerowym mianownikiem wymagają jawnej definicji, a nie zastępczej fizycznej jednostki. Nie należy dodawać surowych residuali q i φ o różnych jednostkach przed normalizacją. Dla porównań między siatkami warto dodatkowo raportować normy dualne z consistent mass lub odpowiednią normą energetyczną.

**Próg 1e-8 nie jest sam w sobie ani błędem, ani gwarancją 1e-8 dokładności fizycznej.** Powinien pozostać niezależną bramką algebraiczną do czasu ustalenia error budget. Czułość wartości własnej zależy m.in. od `y†Bx`, separacji widma i jakości lewego/prawego wektora:

\[
\delta\lambda\simeq
\frac{y^\dagger(\delta A-\lambda\delta B)x}{y^\dagger Bx}.
\]

Nie otrzymałem condition estimates dla aktualnych macierzy. Potrzebna jest seria dokładności solve przy stałej siatce i BC, z obserwacją częstotliwości, subspace MAC, φ oraz H_demag. Samo zwiększenie limitu iteracji lub zgodność eigenvalue z dense nie domyka tego warunku.

Wewnątrz MatShell działa przybliżone rozwiązanie Poissona. Należy kontrolować błąd jego akcji i powtarzalność. Zmienna dokładność inner solve może naruszać założenie stałej liniowej akcji operatora. Zastąpienie GMRES przez FGMRES nie jest automatyczną naprawą: elastyczny preconditioner i niedokładny/nieliniowy MatMult to różne problemy.

### D2. Okno, count i realifikacja

Kod filtruje dodatnie częstotliwości, odrzuca kandydatów o nadmiernie zespolonym rotowanym eigenvalue i sprawdza oryginalne residuale. Jednocześnie końcowy `ok` niskopoziomowego solve oznacza istnienie przyjętych kandydatów, nie dowód matematycznej kompletności całego okna. Takie rozróżnienie musi przetrwać wrapper, writer i UI. [C04], [C05]

Wymagane testy to: count cap, partially converged EPS, brak modów w oknie, kilka shiftów, prawdziwa degeneracja, duplikat fazowy po realifikacji i ujemne/zerowe gałęzie. Nie usuwać wszystkich modów o bliskiej częstotliwości: prawdziwa degeneracja wymaga zachowania wymiaru podprzestrzeni.

Nie znalazłem w przejrzanych ścieżkach podstaw do zarzutu, że brak SLEPc jest automatycznie maskowany produkcyjnym dense solve. Nie oznacza to przeglądu wszystkich fallbacków CPU/GPU. Dense powinien pozostać jawnie ograniczonym oracle, a jego wektory porównywać przez fizyczny MAC/subspace, nie samą częstotliwość.

### D3. Consistent mass i branch tracking

`ConsistentP1TrackingMetric::embed` realizuje dla tetraedru metrykę proporcjonalną do:

\[
M_e=\frac{V_e}{20}(I+\mathbf1\mathbf1^T).
\]

Do osadzenia trafiają cztery wartości węzłowe oraz ich suma, z odpowiednim czynnikiem objętości. Wspólny dodatni czynnik skalujący nie zmienia MAC. To rzeczywista consistent P1 mass, a nie zwykłe liczenie węzłów. Moduł jawnie dotyczy tetraedrów; nie należy z tego wnioskować o certyfikacji prism6. [C12]

Dla zespolonych profili stosować:

\[
\mathrm{MAC}_M(x,y)=\frac{|x^\dagger My|^2}{(x^\dagger Mx)(y^\dagger My)}.
\]

Przy degeneracji porównywać podprzestrzenie M-ortonormalne przez wartości singularne `Q1† M Q2`. Dla różnych siatek potrzebny jest wspólny operator transferu lub iloczyn mieszany; porównanie tablic węzłowych jeden-do-jednego jest nieuzasadnione.

Kolektor jednego `mode_0000` nie korzysta z tego jako pełnego certyfikatu ciągłości. Szczególnie przy crossing/avoided crossing trzeba pokazać kandydatów, confidence i luki, zamiast łączyć punkty po indeksie. Nie ukończyłem przeglądu całego `tracking.rs` i `tracking_subspace.rs`; nie przypisuję im potwierdzonego błędu tylko z powodu ograniczenia kolektora.

### D4. P00 oraz niezależna kontrola cosine-Galerkin

P00 to jednorodny po grubości podmodel. Z `x=|k|t`, `P=1-(1-exp(-x))/x`, `H=H0+2Ak²/(μ0Ms)`:

\[
f_\mathrm{DE}^{P00}=\frac{\gamma_0}{2\pi}
\sqrt{(H+M_sP)(H+M_s(1-P))},
\]
\[
f_\mathrm{BV}^{P00}=\frac{\gamma_0}{2\pi}
\sqrt{H(H+M_s(1-P))}.
\]

W kodzie oracle N>1 używa kosinusowej bazy grubości, sprzężeń demagnetyzacyjnych między profilami, wolnych warunków exchange i otwartej magnetostatyki. Sprawdza symetrie macierzy demagu, dodatniość operatora przywracającego i własny residual. Wynik jest jawnie oznaczony jako diagnostic oracle, nie FEM. [C10]

Przeprowadziłem dodatkowe niezależne całkowanie jądra `exp(-|k||z-z'|)` na dwóch częściach kwadratu, rozdzielonych przez z=z'. Nie korzysta ono z zamkniętych wzorów na wewnętrzną całkę z pliku Fullmag. Rozwiązanie uzyskano przez podobny operator hermitowski oparty na dodatnim pierwiastku macierzy energii.

| Otwarty film, podane materiały | P00 / N=1 | N=32 | N=48 |
|---|---:|---:|---:|
| Γ | 9.309813709 GHz | 9.309813709 GHz | 9.309813709 GHz |
| DE, k=+25 rad/µm | 13.673868175 GHz | 13.641746347 GHz | 13.641746347 GHz |
| BV, k=+25 rad/µm | 9.760535487 GHz | 9.760534092 GHz | 9.760534092 GHz |

Sprawdzono również −25 rad/µm oraz kwadratury 96 i 128 punktów. To kontrola równań referencyjnych w tych punktach; nie pełna kwalifikacja oracle dla każdej grubości, k i materiału. Nie są to nowe częstotliwości Fullmag.

Skrypt wykresów poprawnie oddziela P00 i N32, oznacza punkty jako archiwalne i pozostawia `NOT VERIFIED`. Nie znalazłem w nim dopisywania lustrzanych punktów FEM. [C11]

## E. Macierz S00–S12

Nazwy etapów są zachowane zgodnie z rzeczywistą tabelą planu, nie zastąpione innym podziałem. [C16], [C17]

`I` = stan implementacji w sprawdzonych źródłach; `ST` = testy źródeł projektu; `RV` = runtime dla audytowanego snapshotu; `SQ` = kwalifikacja naukowa Fullmag; `BV` = browser. `NV` oznacza not-verified, nie „na pewno niezaimplementowane”. Własne rachunki Python nie są zaliczane do ST/RV projektu. Deklarowane w dokumentacji historyczne testy nie zostały przeze mnie odtworzone.

| Etap | I — źródła | ST | RV | SQ | BV | Dowód i brak do zamknięcia |
|---|---|---|---|---|---|---|
| S00 — baza K0 i rejestr dowodów | częściowo | deklaracje historyczne; audyt NV | NV | NV | nie dotyczy | Status/kapsuły opisane; brak aktualnego poprawnego Γ i kompletnych receipts |
| S01 — nauka i decyzja architektoniczna | częściowo | NV | NV | NV | nie dotyczy | Operator i plan przeczytane częściowo; nie zamknięto pełnego przeglądu ADR/masterplanu, gauge i spójności wariacyjnej tekstur |
| S02 — authoring i legality | częściowo | NV | NV | NV | NV | KPoint/KPath, przykład i runtime guard; brak pełnego wykonywalnego round-trip Python→IR→planner→ABI |
| S03 — magnetyczny Bloch bez demag | częściowo | NV | NV | NV | nie dotyczy | Operator i fazy istnieją; F01 dla prism6, brak bieżących testów ramek, exchange k² i reprezentacji |
| S04 — pełny dynamiczny demag-k CPU | częściowo | NV | NV | NV | nie dotyczy | Redukcja czterech bloków i rekonstrukcja istnieją; brak runów, pól i zbieżności BC/airboxu |
| S05 — selected spectrum CPU i skan | częściowo | NV | NV | NV | NV | SLEPc/KSP i kontroler istnieją; wymagane spectrum completeness, realifikacja, przerwanie/resume i aktualne 30 runów |
| S06 — tożsamość gałęzi | częściowo | NV | NV | NV | NV | Metryka consistent tet4 sprawdzona; pełny matching/subspaces nieprzejrzany, kolektory nadal mode_0000 |
| S07 — artefakty i API | częściowo, błąd F02 | NV | NV | NV | NV | Specyfikacja i endpointy; potrzebne zgodne JSON/CSV/binary, digesty, sample ownership i brak fallbacku |
| S08 — użytkowy przepływ dyspersji | częściowo, błąd F03 | NV | NV | NV | NV | Modele wykresów istnieją; brak browser/FMS proof, pełnego audytu selekcji i filtrów |
| S09 — falowód 2.5D | nie rozstrzygnięto źródłowo | NV | NV | NV | NV | Brak pełnego audytu właścicieli 2.5D i dowodu zgodności z 3D/TetraX |
| S10 — interakcje i tłumienie | częściowo; publiczne ograniczenia | NV | NV | NV | NV | Ku Hessian w native nie oznacza publicznego wsparcia; DMI/spatial/surface/damping wymagają osobnej kwalifikacji |
| S11 — GPU | nie zakwalifikowano | NV | NV | NV | NV | Brak bieżących parity runs, telemetry i dowodu dla >1024 DOF; nie wnioskować ze wsparcia CUDA w innych modułach |
| S12 — walidacja, dokumentacja, integracja | częściowo | NV | NV | NV | NV | Referencje/skrypty istnieją; brak pełnego materiału wykonawczego i kwalifikacji COMSOL A1 |

Żaden etap nie otrzymuje statusu ukończenia całego zakresu. Nie wyliczam arbitralnego procentu.

## F. Dług techniczny i hardkodowania — kolejność ryzyka

1. **Dwie prawdy o modelu/operatorze.** Accepted equilibrium, raw material identity i canonical operator identity muszą mieć zdefiniowaną relację. Kanonizacja u i −u powinna zachowywać fizykę, ale nie kasować provenance surowego wejścia. Reuse wymaga zgodnego operatora, nie jedynie podobnych etykiet.
2. **Niejednorodna polityka kwadratury.** F01 pokazuje, że dopuszczenie typu elementu musi oznaczać także właściwe reguły całkowania wszystkich bloków, nie tylko poprawny odczyt topologii.
3. **Rozproszone znaczenia `ok`, `succeeded`, `complete` i `qualified`.** Kod kontrolera oraz specyfikacja częściowo je rozdzielają; cały łańcuch nie został potwierdzony. Sukces buildu, solve, publikacji i nauki to różne stany. [C08], [C14]
4. **Wiele schematów i ścieżki legacy.** F02 oraz równoległe odwołania do spectrum v2/v3 wymagają jawnych adapterów. Samo przemianowanie zasobu nie naprawia ownership danych.
5. **`mode_0000`, count=1 i okna zależne od k w smoke.** To dopuszczalne ograniczenia fixture, nie ogólny algorytm branch tracking. Okna 8.5/12/16 GHz i specjalny próg dla |k|=25 muszą pozostać jawne. [C09]
6. **Tolerancje o różnych jednostkach.** Torque w A/m, błąd normy m, translacja w metrach, faza, residual blokowy i EPS absolute nie mogą być traktowane jako ta sama „dokładność”.
7. **Ciche filtrowanie wykresów.** `finiteFrequencySeries` usuwa punkty niefinitywne, a `compatibleFrequencySeries` serie niezgodne jednostkowo. To może być poprawne zabezpieczenie rendererów, ale użytkownik powinien dostać licznik i powód odrzucenia, a nie samo `ready`. Nie potwierdzono, czy wyższa warstwa już zawsze to pokazuje. [C06]
8. **Syntetyczna obwiednia a obserwabla.** Obwiednia z samych częstotliwości i damping, bez sprzężenia z drive i detektorem, nie jest automatycznie widmem FMR/BLS. Etykieta intensywności powinna wyraźnie odróżniać ilustrację modów od odpowiedzi wymuszonej.
9. **Monolityczne ścieżki operatorowe i walidatory.** Wymagane są wspólne, testowane kontrakty jednostek, reprezentacji i certyfikatu, nie niezależne ręczne odtwarzanie tych reguł w kolejnych skryptach.

## G. Minimalny plan napraw i eksperymentów

### G1. Naprawić trzy potwierdzone błędy bez pozornej promocji zakresu

**F01:** dla afinicznego P1 tet4 rząd 1 jest wystarczający dla samej wymiany, dla afinicznego prism6 potrzebny jest co najmniej rząd 2. Docelowo reguła powinna uwzględniać transformację i zmienność współczynników. Minimalna zmiana koncepcyjna:

```cpp
const int order = finite_element->GetGeomType() == mfem::Geometry::PRISM ? 2 : 1;
const auto& rule = mfem::IntRules.Get(finite_element->GetGeomType(), order);
```

To nie jest gotowy uniwersalny patch dla zdeformowanych/przestrzennie niejednorodnych elementów. Najpierw test macierzy wskazany w F01, potem testy geometrii i widma. Nie kompensować hourglass przez sztuczną zmianę A.

**F02:** rozdzielić legacy i jawny sample:

```rust
let path = match query.sample_index {
    Some(sample) => format!("eigen/modes/sample_{sample:04}/mode_{:04}.json", query.index),
    None => format!("eigen/modes/mode_{:04}.json", query.index),
};
Ok(Json(read_json_artifact_value(&artifact_dir, &path)?))
```

Nie zmieniać błędu odczytu konkretnej próbki w wybór innej próbki. Osobno testować ownership aktywnego run/stage.

**F03:** zachować liczby fizyczne w Hz do końca rachunku:

```ts
type FrequencyUnit = "Hz" | "kHz" | "MHz" | "GHz";
const hertzPerUnit: Record<FrequencyUnit, number> = {
  Hz: 1, kHz: 1e3, MHz: 1e6, GHz: 1e9,
};
// Alternatywnie: przeliczyć linewidthHz / hertzPerUnit[unit]
// zanim trafi do wzoru używającego frequencyValue w jednostce osi.
```

Przy nieznanej jednostce zwrócić jawny błąd/stan niedostępności. Konwersja jednostek nie rozstrzyga definicji linewidth ani nie tworzy fizycznych intensywności bez residues/drive.

### G2. Najpierw poprawny Γ z demagiem

Zamrozić SHA, kapsułę źródeł, biblioteki, precision/device, solver options, model i siatkę. Użyć rzeczywistego pipeline, nie oracle w miejsce solve. Sprawdzić m0, torque, pola przyjęte, tożsamości i obie oryginalne reszty. Odtworzyć φ, H_demag i szwy z opublikowanych danych niezależnym czytnikiem.

Dla tego filmu wykonać zarówno porównanie do `9.299249694 GHz` dla idealnego skończonego Dirichleta, jak i zbieżność paddingu do otwartego `9.309813709 GHz`. Różnicę interpretować zgodnie z faktycznym assembly BC. Utrzymać bramkę residualu 1e-8; nie zastępować jej dopasowaniem częstotliwości.

### G3. Następnie rzeczywiste ±k DE/BV

Kontroler opisuje poprawny zbiór **30 runów**: 13 rzeczywistych punktów dla DE, 13 dla BV oraz cztery kontrole k=+25 rad/µm na 6 i 9 warstwach. Podstawowa seria L2/t3 ma obejmować `0, ±2, ±5, ±10, ±15, ±20, ±25 rad/µm`. Nie odbijać częstotliwości ani profili. [C08]

Dla każdego przyjętego wektora zachować: rzeczywiste kx/ky/kz, częstotliwość zespoloną, q i φ, obie reszty blokowe, residuale szwów, tożsamość równowagi i operatora, raw index, branch/cluster oraz dane źródłowe. Sama zgodność f(+k)=f(−k) nie wystarcza: należy porównać fazowo wyrównane profile oraz relację lokalizacji na powierzchniach wynikającą z symetrii konkretnego modelu. Nie uogólniać tego na DMI/asymetryczne otoczenie.

### G4. Rozdzielić pięć zbieżności

Niezależnie zmieniać: rozdzielczość x/y, liczbę warstw, airbox/BC, dokładność solve oraz zakres/liczbę modów. W każdej serii śledzić tę samą gałąź lub podprzestrzeń, a nie raw index. Kontrole t3/t6/t9 przy k25 nie zastępują zbieżności całej ścieżki; trzeba jeszcze sprawdzić Γ, małe k i miejsca hybrydyzacji.

Przy każdej zmianie zapisywać liczbę magnetic/scalar DOF, pamięć, czas assembly/Poisson/shifted solve/EPS, liczbę iteracji i inner true residuals. Dopiero potem optymalizować preconditioner/reuse, nie maskować niedokładnej fizyki szybszym przebiegiem.

### G5. Osobno P00, N32 i COMSOL A1

P00 służy do kontroli ograniczonego modelu, N32 do sprzężenia profili otwartego filmu. N32 wymaga własnej kontroli N i kwadratury, a nie automatycznego statusu „dokładne”.

COMSOL A1 jest innym zadaniem: dokument użytkownika opisuje komórkę antidot 200×200 nm, film 10 nm, promień otworu 50 nm, 61 punktów Γ–X–M–Γ i 24 eigenfrequencies na punkt. Nie wolno porównywać jej bezpośrednio z częstotliwościami pełnego filmu 40 nm. [C18]

Do kwalifikacji A1 potrzeba tej samej geometrii, materiałów, równowagi, BC, znaków Blocha i okna, następnie zbieżnych częstotliwości i profili/subspaces. Dokument modelu i CSV nie zastępują obecnych wyników Fullmag. Nie deklaruję zgodności z COMSOL.

### G6. Zachować pełny zakres interakcji, 2.5D, GPU i UI

Po bazowej kwalifikacji wdrażać i testować kolejno signed/zero Ku, pola przestrzenne, anizotropię kubiczną/powierzchniową, DMI z BC/interfejsami oraz Gilbert. Każdy składnik użyty w relaksacji musi mieć zgodną pochodną albo jawne odrzucenie. Zachować odrębny etap 2.5D i porównanie do periodycznej ekstrudowanej 3D/TetraX.

GPU musi przejść ten sam kontrakt per-vector i osobne badania powyżej 1024 DOF, z telemetry transferów oraz rzeczywistym urządzeniem każdej fazy. Forced GPU nie może po cichu znaczyć CPU.

Frontend/API: round-trip script→IR→run→artefakty→wykres→sample/mode/branch→pole→FMS. Testy browser mają obejmować kx≠0, ky≠0, ujemne k, zmianę run/stage, częściowy/corrupt wynik, zgodność jednostek, brakujący sample oraz aktywny canvas/WebGL. Zwykły test źródeł nie zamyka tego etapu.

## H. Dowody nieotrzymane i nieukończone części przeglądu

**Nie otrzymano:** lokalnej kapsuły i rzeczywistych bytes receipt/manifest buildu #188; pełnych logów jego solve; wyników nowej serii z bieżącego SHA; źródłowo powiązanych binarnych modów, φ/H_demag i siatek; bieżących benchmarków CPU/GPU; condition estimates; browser trace/screenshots/FMS round-trip; sparowanych, zbieżnych wyników Fullmag–COMSOL z profilami.

Status dokumentacji podaje dla #188 source digest `b2edf2fbc0295c83f6d768ad8bd3391904017c5f871d0244afe15c4b3a1a4a46` i opisuje późniejsze zmiany kolektorów/provenance. To nie jest to samo co otrzymany i zweryfikowany manifest. Dlatego nie przypisuję wyniku #188 do aktualnych plików. Dokumentowane `succeeded` dotyczy buildu, a nie kwalifikacji solve. [C15]

**Nieukończony przegląd źródeł:** pełny lowering w `study.py/world.py`, eigensolve sections całego `crates/fullmag-plan/src/fem.rs`, pełne ABI `fullmag-fem-sys` i wszystkie wrappery `native_fem`, całość `fem_eigen.rs`/equilibrium identity, pełne writery i `verify_fem_frequency_domain_eigen_artifacts.py`, komplet `tracking.rs/tracking_subspace.rs`, wszystkie trasy API/frontendu, pełny zestaw ADR/backend masterplan/DE minimal validation i wszystkich wcześniejszych audytów. Nie nazywam tych plików niedostępnymi — po prostu nie uznaję ich za w pełni zrecenzowane w tym raporcie.

**Własne dowody:** niezależne macierze prism6, poprawiona reguła dla elementu afinicznego, Hessian signed/zero Ku, jednostkowy kontrprzykład renderera, Γ dla dwóch warunków zewnętrznych i niezależny cosine-Galerkin N=1/16/32/48 z kontrolą kwadratury. Wszystkie są diagnostykami Python, nie testami native/runtime/browser Fullmag.

## I. Ponowna kontrola wniosków i zakresu napraw

Przed zamknięciem sprawdzono ponownie warunki F01–F03 i granice ich zasięgu. Korekta kwadratury ma niezależny dowód dla afinicznego prism6; wymaga dalszych testów dla deformacji. Usunięcie fallbacku naprawia podmianę sample w starszym endpointcie, nie rozwiązuje całego ownership API. Konwersja jednostek naprawia rachunek szerokości, nie definiuje fizycznego widma wymuszonego. Żadna z tych zmian nie zastępuje migracji accepted state, dowodu wykonania Γ, serii ±k, kwalifikacji GPU ani testów browser.

**Decyzja wydaniowa:** zatrzymać promocję do production/scientifically-qualified. Zachować ścieżkę CPU tetrahedral exchange+Zeeman+demag jako kandydat do ścisłej walidacji; nie cofać poprawnych zabezpieczeń i nie ograniczać docelowego planu do jednego najłatwiejszego działającego przypadku.

## Źródła i zakres odwołań

Pełna tabela plików, linii i historii: [SOURCE_INDEX.md](SOURCE_INDEX.md). Odwołania w raporcie są zamrożone na audytowanym SHA. Źródła MFEM/PETSc/SLEPc wyjaśniają semantykę bibliotek; nie potwierdzają składu lokalnej kapsuły #188.

[C01]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp#L1990-L2285
[C02]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/crates/fullmag-api/src/router_v2/handlers/analysis/eigen.rs#L67-L119
[C03]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/backends/fem/cpu/frequency_domain/floquet_airbox_operator.cpp#L428-L995
[C04]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp#L2910-L3330
[C05]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp#L3330-L3467
[C06]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/apps/control-room/src/shared/analysis-charts/frequencyRenderModels.ts#L1-L167
[C07]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/crates/fullmag-runner/src/fem/eigen_shared_domain.rs#L1160-L1360
[C08]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/scripts/run_nonzero_k_validation_controller.py#L1-L177
[C09]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/examples/fem_de_smoke_numeric.py#L1-L175
[C10]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/scripts/thin_film_thickness_oracle.py#L1-L125
[C11]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/scripts/plot_de_bv_dispersion_comparison.py#L1-L99
[C12]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/crates/fullmag-runner/src/eigen/tracking_mass.rs#L1-L260
[C13]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/scripts/collect_signed_de_bv_dispersion.py#L1-L142
[C14]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/docs/specs/frequency-domain-artifacts-v2.md#L1-L95
[C15]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/docs/superpowers/plans/2026-09-12-eigensolve-dispersion-implementation-status.md#L1-L89
[C16]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/docs/superpowers/plans/2026-09-12-eigensolve-dispersion-nonzero-k-plan.md#L278-L289
[C17]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/docs/superpowers/plans/2026-09-12-eigensolve-dispersion-nonzero-k-plan.md#L270-L278
[C18]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/docs/plans/active/eignensolve_non_k0/COMSOL_A1_model_details_user.txt#L1-L100
[C19]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/scripts/collect_de_bv_thickness_comparison.py#L27-L110
[C20]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/packages/fullmag-py/src/fullmag/model/eigen.py#L1-L200
[C21]: https://github.com/MateuszZelent/fullmag/blob/ab64bac46b7ceda295812da93244b2eba81174e4/apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts#L1-L220
[M01]: https://docs.mfem.org/4.8/intrules_8cpp_source.html
[M02]: https://petsc.org/release/manualpages/KSP/KSPSetNormType/
[M03]: https://petsc.org/release/manualpages/KSP/KSPGetResidualNorm/
[M04]: https://slepc.upv.es/release/manualpages/EPS/EPSSetTrueResidual.html
