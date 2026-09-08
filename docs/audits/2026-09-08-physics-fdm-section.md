# Sekcja audytu fizyki FDM Fullmag

Data audytu: **2026-09-08**. Checkout audytowany: `C:/git/fullmag/fullmag`, punkt odniesienia źródeł: `6cc5e5e0396050f5f859a0e2b28dd3f963d3f7bb`. Ten dokument jest sekcją dołączaną do [audytu fizyki solverów FDM/FEM](2026-09-08-fdm-fem-physics-audit.md). Zachowuje ustalenia dotyczące obu realizacji FDM: referencyjnej/produkcyjnej CPU w silniku Rust oraz produkcyjnej GPU w natywnym CUDA.

## Zakres i granice wyniku

Audyt porównuje równania, dyskretyzację komórek, przepływ pól i energii, lowering przez runner oraz istniejące testy kontraktowe. `POTWIERDZONE — źródła` oznacza odczyt bieżącego kodu i wywołań; `POTWIERDZONE — algebra` oznacza niezależny rachunek; `TEST PASS` oznacza wyłącznie komendę opisaną w audycie nadrzędnym. `NOT VERIFIED` oznacza brak aktualnego dowodu wykonania, parytetu, zbieżności lub kwalifikacji. Źródła zewnętrzne i referencyjne solvery nie są dowodem działania Fullmag.

Zgodnie z kontraktem backendu role są rozdzielone:

| Realizacja | Rola | Właściciel źródła | Stan dowodu w tym audycie |
|---|---|---|---|
| FDM CPU | referencja i produkcyjna ścieżka CPU | `crates/fullmag-engine/src/fdm/cpu/` oraz `crates/fullmag-engine/src/fdm/shared/` | źródła i testy kontraktowe odczytane; nowy runtime/parytet **NOT VERIFIED** |
| FDM GPU | produkcyjna ścieżka native CUDA | `backends/fdm/gpu/cuda/`, C ABI `backends/fdm/api/`, adapter `crates/fullmag-runner/src/fdm/gpu/cuda/` | źródła odczytane; nowy runtime, urządzenie, precision receipt i parytet **NOT VERIFIED** |

Nie wolno przenosić wyniku z FDM CPU na FDM GPU ani odwrotnie. CPU reference może służyć jako orakl po udowodnieniu zgodności geometrii, maski, objętości, parametrów, stanu początkowego i warunków brzegowych. Sam fakt, że oba drzewa zawierają operator o tej samej nazwie, nie jest dowodem parytetu.

## Wspólny zapis fizyczny i dyskretny

Niech komórka $i$ ma środek $\mathbf r_i$, pełną objętość $V_i^c=\Delta x\Delta y\Delta z$, udział magnetyczny $\varphi_i\in[0,1]$ i objętość materiału $V_i=\varphi_iV_i^c$. Magnetyzacja w aktywnej komórce to $\mathbf M_i=M_{s,i}\mathbf m_i$, gdzie $|\mathbf m_i|=1$ w tym w komórkach zamrożonych; komórki nieaktywne wymagają odrębnej maski. Pole gęstości zapisane jako energia na pełną komórkę i pole gęstości zapisane na objętość materiału są dwiema różnymi konwencjami:

```{math}
:label: fdm-cell-measure
E=\sum_i w_iV_i,
\qquad
w_i^{(c)}=\frac{E_i}{V_i^c},
\qquad
w_i^{(m)}=\frac{E_i}{V_i},
\qquad
V_i=\varphi_iV_i^c.
```

Jeżeli payload `eden_*` używa pierwszej konwencji, całka musi mnożyć przez $V_i^c$ i odpowiednio ważyć składnik przez $\varphi_i$. Jeżeli używa drugiej, całka musi używać $V_i$ i ujawniać tę jednostkę w metadanych. W obu przypadkach skalar i mapa muszą używać tej samej maski, materiału, kwadratury oraz miary.

Dla konserwatywnego pola efektywnego obowiązuje dyskretna wersja relacji wariacyjnej:

```{math}
:label: fdm-discrete-variation
\delta E
=-\mu_0\sum_i M_{s,i}\,\mathbf H_{\mathrm{eff},i}\cdot\delta\mathbf m_i\,V_i.
```

Tożsamość jest użytecznym testem operatora, ale nie obejmuje automatycznie szumu termicznego ani niekonserwatywnego torque transportowego. Dla $\alpha>0$, stałych parametrów i wyłącznie pól konserwatywnych konwencja LLG używana w audycie ma postać:

```{math}
:label: fdm-llg
\frac{d\mathbf m_i}{dt}
=-\frac{\gamma_H}{1+\alpha^2}
\left[\mathbf m_i\times\mathbf H_{\mathrm{eff},i}
+\alpha\mathbf m_i\times
(\mathbf m_i\times\mathbf H_{\mathrm{eff},i})\right]
+\boldsymbol\tau_i,
\qquad
\gamma_H=\mu_0|\gamma_e|.
```

Pole $\mathbf H$ ma jednostkę $\mathrm{A\,m^{-1}}$, $\gamma_H$ ma jednostkę $\mathrm{m\,A^{-1}\,s^{-1}}$, a $\boldsymbol\tau$ ma jednostkę $\mathrm{s^{-1}}$. Brak $\mu_0$ przy użyciu $\gamma_e$ z polem $\mathbf H$ zmienia skalę czasu. Dla niezakłóconej relaksacji:

```{math}
:label: fdm-llg-dissipation
\frac{dE}{dt}
=-\mu_0\sum_iV_iM_{s,i}
\frac{\gamma_H\alpha}{1+\alpha^2}
\left|\mathbf m_i\times\mathbf H_{\mathrm{eff},i}\right|^2\leq0.
```

Nierówność nie jest kryterium dla wymuszeń, termiki, STT/SOT ani dynamicznego pola transportowego. Relaksacja musi raportować osobno moment/gradient, normę, accepted/rejected state i jawny powód zakończenia.

## Operatory FDM i ich realizacje

### Wymiana

Dla stałego $A$ operator kontinuum wynika z

```{math}
:label: fdm-exchange
E_{\mathrm{ex}}=\int A|\nabla\mathbf m|^2dV,
\qquad
\mathbf H_{\mathrm{ex}}
=\frac{2}{\mu_0M_s}\nabla\cdot(A\nabla\mathbf m).
```

FDM dyskretyzuje gradient przez różnice sąsiednich komórek i musi zachować właściwe współczynniki dla $A$, $M_s$, odległości $\Delta x,\Delta y,\Delta z$, maski oraz częściowych komórek. Przy interfejsie niejednorodnego $A$ zachowanie strumienia wymiennego nie jest równoważne bezwarunkowemu użyciu jednego $A\Delta\mathbf m$; brzeg swobodny, zamrożony i PBC są odrębnymi zadaniami.

Źródła implementacji to `crates/fullmag-engine/src/fdm/cpu/fields.rs` i `crates/fullmag-engine/src/fdm/shared/terms.rs::EffectiveFieldTerms` po stronie CPU oraz `backends/fdm/gpu/cuda/interactions/exchange_fp64.cu::exchange_field_fp64_kernel` i `exchange_fp32.cu` po stronie GPU. Warstwa wielowarstwowa jest rozbita na `multilayer_exchange.cu` i odpowiadające jej `multilayer_effective_field.cu`. Testy `crates/fullmag-engine/tests/exchange_density_study.rs`, `fdm_aos_soa_parity.rs` i kontrakty źródłowe CUDA potwierdzają obecność wybranych reguł, ale nie zamykają pełnej macierzy interfejsów, PBC i zbieżności.

### Demagnetyzacja

Pole FDM ma postać splotu dyskretnego tensora demagnetyzacyjnego:

```{math}
:label: fdm-demag
\mathbf H_{d,i}=\sum_j\mathsf N_{ij}\mathbf M_j,
\qquad
E_d=-\frac{\mu_0}{2}\sum_iV_i
\mathbf M_i\cdot\mathbf H_{d,i}.
```

Tutaj $\mathsf N$ oznacza podpisany operator pola (ujemny diagonalny self-term), a nie dodatni tensor współczynników odmagnesowania. W otwartej domenie FFT wymaga właściwego paddingu i self-termu. W PBC suma obrazów definiuje inne zagadnienie. W multilayer $V_i$, warstwa źródłowa, warstwa celu i transfer między różnymi rastrami muszą być zgodne względem iloczynu energetycznego; sama obecność wspólnego kernela nie dowodzi wzajemności.

CPU prowadzi ścieżkę referencyjną w `crates/fullmag-engine/src/fdm/cpu/fft.rs::compute_newell_kernel_spectra` i `crates/fullmag-engine/src/fdm/cpu/fft_backend.rs::FdmFftBackend`; dane stanu oraz pola są w `crates/fullmag-engine/src/fdm/cpu/state.rs::ExchangeLlgState`. Produkcyjna GPU ścieżka jest w `backends/fdm/gpu/cuda/interactions/demag_fp64.cu::launch_demag_field_fp64`, `demag_fp32.cu` oraz `demag_boundary_fp64.cu`; planowanie i endpoint cache należą do `backends/fdm/gpu/cuda/runtime/`.

Istniejące źródła i testy wskazują osobne ścieżki dla otwartej domeny, PBC, multilayer i transferów (`crates/fullmag-engine/tests/multilayer_unequal_transfer.rs`, `fdm_fft_cpu_performance.rs`, `backends/fdm/tests/endpoint_cache_cuda_runtime.cpp`). Nie ma w tym audycie nowego wykonania, które jednocześnie potwierdzałoby tensor, wzajemność, self-term, energię, padding, obrazy PBC i zgodność CPU/GPU. Aktualne kwalifikowanie demag FDM pozostaje **NOT VERIFIED**.

### Zeeman, statyczna mapa i regionalne pole

Dla konserwatywnego zewnętrznego pola:

```{math}
:label: fdm-zeeman
E_{\mathrm{ext}}
=-\mu_0\sum_iV_i\mathbf M_i\cdot\mathbf H_{\mathrm{ext},i},
\qquad
\mathbf H_{\mathrm{ext},i}
=\mathbf H_{\mathrm{uniform},i}
+\mathbf H_{\mathrm{static},i}
+\mathbf H_{\mathrm{regional},i}.
```

`static external field map` jest polem zadanym w czasie i zgodnie z `docs/physics/0971-static-external-field-map.md` należy do energii Zeemana. Regionalny field drive może być konserwatywnym polem, ale osobne transportowe lub diagnostyczne torque nie powinny być bezwarunkowo dopisywane do $E_{\mathrm{total}}$. Rola pola, jego jednostka, etap czasu i provenance muszą być jawne.

Wspólna CPU/IR warstwa znajduje się w `crates/fullmag-engine/src/fdm/shared/problem.rs::ExchangeLlgProblem`, `shared/terms.rs::EffectiveFieldTerms`, `shared/vector_field.rs` i `crates/fullmag-ir/src/model.rs`/mapowaniu `static_external_field_map`. GPU mapę zapisuje `backends/fdm/gpu/cuda/runtime/context.cu::context_mark_static_external_field_profile`; C ABI i adapter przekazują ją przez `backends/fdm/api/c_api.cpp::fullmag_fdm_backend_set_static_external_field_f64` oraz `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs::NativeFdmBackend`.

### Anizotropia

Uniaxialny model w konwencji audytu to

```{math}
:label: fdm-uniaxial
w_u=-K_{u1}q^2-K_{u2}q^4,
\qquad
\mathbf H_u
=\frac{2K_{u1}q+4K_{u2}q^3}{\mu_0M_s}\mathbf a,
\qquad q=\mathbf m\cdot\mathbf a.
```

Cubic jest oddzielnym wielomianem osiowym i nie wolno uogólniać prefaktora $-1/2$ z energii pola na wszystkie wyrazy. Dla jednorodnego wyrazu stopnia $p$ zachodzi $w_p=-\mu_0M_s\mathbf m\cdot\mathbf H_p/p$. Znaleziony błąd `OBS-01` dotyczy materializacji mapy energii natywnego FEM; nie jest dowodem tego samego błędu w FDM. FDM-owe ścieżki GPU znajdują się w `backends/fdm/gpu/cuda/interactions/multilayer_anisotropy.cu::multilayer_anisotropy_field_kernel`, a wspólna semantyka termów w `crates/fullmag-engine/src/fdm/shared/terms.rs::EffectiveFieldTerms`. W tym audycie nie wykonano osobnego FDM testu pochodnej $K_{u1}$/$K_{u2}$ ani mapy energii; status FDM pozostaje **NOT VERIFIED**, bez przypisywania FDM potwierdzonego defektu FEM.

### DMI

Dla stałego $D$ w konwencji objętościowej:

```{math}
:label: fdm-bulk-dmi
w_b=D\mathbf m\cdot(\nabla\times\mathbf m),
\qquad
\mathbf H_b=-\frac{2D}{\mu_0M_s}\nabla\times\mathbf m.
```

Dla interfacial DMI względem normalnej $+z$:

```{math}
:label: fdm-interfacial-dmi
w_i=D\left[m_z\nabla_\parallel\cdot\mathbf m_\parallel
-\mathbf m_\parallel\cdot\nabla_\parallel m_z\right],
\qquad
\mathbf H_i=\frac{2D}{\mu_0M_s}
\left[\nabla_\parallel m_z
-(\nabla_\parallel\cdot\mathbf m_\parallel)\mathbf e_z\right].
```

Znak $D$ jest konwencją, o ile energia, pole i chiralność są zmieniane spójnie. Dla skokowego lub przestrzennie zmiennego $D$ dochodzą składniki interfejsowe. Człon brzegowy DMI musi być zestawiony z warunkiem wymiany; zwykły zerowy strumień może oznaczać inne zadanie.

FDM GPU ma źródła `backends/fdm/gpu/cuda/interactions/multilayer_dmi.cu::multilayer_dmi_field_kernel` i `dmi_boundary.cuh`; lowering wspólnego termu przechodzi przez `crates/fullmag-engine/src/fdm/shared/terms.rs::EffectiveFieldTerms`. FDM CPU ma referencyjne obliczenia gradientów w `crates/fullmag-engine/src/fdm/cpu/fields.rs` oraz scenariusze w `crates/fullmag-engine/tests/`. Istnieje recipe `just verify-fdm-gpu-dmi-boundary-runtime`, lecz w tym audycie nie wykonano go, dlatego FDM CPU i FDM GPU dla obsługiwanych wariantów bulk/interfacial DMI są **NOT VERIFIED**; rotated-interfacial DMI ma osobną ścieżkę Python/IR/planner oraz implementacje źródłowe CPU/GPU, ale bez bieżących managed receipts jego runtime pozostaje **NOT VERIFIED**.

### Termika, transport spinowy, SOT/STT i pole Oersteda

Termiczny składnik Brownowski nie jest polem wynikającym z funkcjonału deterministycznego. W dyskretyzacji komórkowej wariancja białego pola musi zależeć od temperatury, tłumienia, $M_s$, objętości magnetycznej i kroku czasu; jakościowy zapis skali to

```{math}
:label: fdm-thermal-scale
\left\langle H_{\mathrm{th},i}^a(t)H_{\mathrm{th},j}^b(t')\right\rangle
\propto
\frac{\alpha k_BT_i}{\mu_0\gamma_HM_{s,i}V_i}
\delta_{ij}\delta_{ab}\delta(t-t').
```

Dokładny prefaktor i sposób próbkowania przy retry/wznowieniu muszą pochodzić z kanonicznej noty i implementacji. Źródła CPU są w `crates/fullmag-engine/src/fdm/cpu/integrators.rs` oraz `crates/fullmag-engine/src/fdm/cpu/state.rs::ExchangeLlgState`; testy kontraktowe obejmują `fdm_cpu_transactionality.rs` i `fdm_adaptive_cpu.rs`. Nie wykonano w tym audycie statystycznej kwalifikacji temperatury ani niezależnego FDM GPU thermal runtime.

Transport ładunkowy i spinowy rozwiązują dodatkowe pola, których torque nie może być mylony z energią Zeemana:

```{math}
:label: fdm-transport-boundary
\nabla\cdot\mathbf j_c=0,
\qquad
\mathbf n\cdot\mathbf j_c\big|_{\mathrm{insulator}}=0,
\qquad
\boldsymbol\tau_{\mathrm{STT/SOT}}
\not\equiv-\frac{\gamma_H}{\mu_0M_s}
\mathbf m\times\frac{\delta E}{\delta\mathbf m}.
```

CPU realizacje są rozdzielone między `crates/fullmag-engine/src/fdm/cpu/transport/charge.rs::StructuredChargeProblem`, `coupled_charge_spin.rs`, `spin_drift_diffusion.rs`, `transient_spin.rs`, `oersted.rs` oraz natywne kernels `backends/fdm/cpu/transport/charge_transport_v1.cpp` i `spin_transport_v1.cpp`. Wspólne lowering torque jest w `crates/fullmag-engine/src/fdm/shared/terms.rs::EffectiveFieldTerms`.

CUDA ma osobny stan transportu w `backends/fdm/gpu/cuda/transport/context.cu` oraz integratory `backends/fdm/gpu/cuda/integrators/llg_fp32.cu` i `llg_dp45_fp32.cu`. W tym audycie nie ma nowego dowodu, że wszystkie wersje STT/SOT, transportu i Oersteda mają zgodny snapshot pola, bilans ładunku, jednostki i parity CPU/GPU. Istniejące testy `backends/fdm/tests/oersted_cuda_runtime.cu` sprawdzają głównie pola i finiteness; nie stanowią pełnej kwalifikacji energii ani transportu.

### Integratory, relaksacja, frozen spins i obserwable

FDM CPU integratory są w `crates/fullmag-engine/src/fdm/cpu/integrators.rs`; GPU w `backends/fdm/gpu/cuda/integrators/`. Wymagane są: tableau/order dla każdego wspieranego integratora, rollback po odrzuceniu kroku, zachowanie accepted state, końce interwałów, norma magnetyzacji, etap czasu i źródło losowości. `crates/fullmag-engine/tests/fdm_abm3_cpu.rs`, `fdm_adaptive_cpu.rs`, `fdm_cpu_transactionality.rs` oraz `fdm_aos_soa_parity.rs` są dowodami ograniczonymi do swoich kontraktów.

`crates/fullmag-engine/src/fdm/shared/frozen_spins.rs::FrozenSpinsState` rozdziela zamrożenie stanu od nieaktywnej komórki. Test musi potwierdzić, że frozen spin nie jest aktualizowany, ale nadal ma jawny wpływ lub brak wpływu na każdy operator zgodnie z kontraktem. Sama maska aktywna nie rozstrzyga semantyki frozen spin.

Obserwable CPU są materializowane przez `crates/fullmag-engine/src/fdm/shared/observables.rs::EffectiveFieldObservables`, `crates/fullmag-engine/src/fdm/cpu/fields.rs` i adapter `crates/fullmag-runner/src/fdm/cpu/reference/direct_snapshot.rs::DirectFieldSnapshotCache`. GPU używa `backends/fdm/gpu/cuda/interactions/energy_density_fp64.cu::energy_density_kernel`, `launch_energy_density_observable` oraz redukcji `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu::reduce_external_energy_fp64`. Każdy składnik mapy musi mieć ten sam snapshot magnetyzacji i pól, indeksowanie, maskę, miarę komórki oraz metadane jednostki co skalar.

## Potwierdzone findingi FDM

### FDM-OBS-01 / OBS-02 — P1: statyczna mapa i regionalne pola są gubione w GPU energy observables

**Status: POTWIERDZONE — źródła. Wykonanie kernela i niezależna wartość analityczna: NOT VERIFIED.**

1. `backends/fdm/gpu/cuda/runtime/context.cu::context_mark_static_external_field_profile` zapisuje mapę do `h_oe_static` i ustawia `has_static_external_field_profile=true`. Nie ustawia `has_oersted_field`; odrębna rola static map jest poprawna sama w sobie.
2. `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu::reduce_external_energy_fp64` sprawdza `has_oersted_field` zarówno w warunku wcześniejszego zwrotu, jak i przy wyborze `oe_x/oe_y/oe_z`. Późniejsza gałąź `has_static_external_field_profile ? 1.0 : ...` nie naprawia wcześniejszego wyboru wskaźnika ani zwrotu `0.0`. Wariant FP32 ma tę samą konstrukcję.
3. `backends/fdm/gpu/cuda/interactions/energy_density_fp64.cu::energy_density_kernel` w gałęzi `EDEN_EXT` używa wyłącznie trzech wartości `external_x/y/z`; nie ma w niej regionalnego pola ani `h_oe_static`. `launch_energy_density_observable` przekazuje kontekstowe `ctx.external_field`, więc mapowanie do payloadu nie obejmuje wszystkich rozwiązanych składowych pola.
4. Przekazanie mapy z adaptera potwierdza `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs::NativeFdmBackend` i setter `fullmag_fdm_backend_set_static_external_field_f64` w `backends/fdm/api/c_api.cpp`.

Dla niezerowej mapy statycznej, zerowego pola jednorodnego i niezerowej magnetyzacji energia fizyczna $-\mu_0\sum_iV_i\mathbf M_i\cdot\mathbf H_{\mathrm{static},i}$ jest niezerowa, choć obecna ścieżka może zwrócić zero. Dla regionalnego pola skalar może otrzymać pole przez `external_energy_blocks_kernel`, a `eden_ext` nie otrzymuje tego samego składnika. Ponieważ `EDEN_TOTAL` korzysta z tej mapy gęstości, defekt przechodzi również do sumarycznego payloadu.

Test `backends/fdm/tests/oersted_cuda_runtime.cu` w scenariuszu profilu statycznego porównuje `H_ext` i `H_eff`, ale `stats.external_energy_joules` sprawdza tylko `std`; błędne zero przechodzi tę asercję. Test runnera `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs::native_fdm_static_external_profile_reaches_single_grid_effective_field_when_cuda_is_available` również skupia się na polach. `backends/fdm/tests/energy_density_observable_contract.cpp::cuda_materialization_contract_is_present` potwierdza rozdzielenie `EDEN_DRIVE`, lecz nie uzasadnia pominięcia konserwatywnej static mapy Zeemana.

Naprawa musi zachować odrębne role static map, Oersteda, regionalnego pola i niekonserwatywnego drive. Potrzebne są regresje static-map-only i regional-field-only sprawdzające jednocześnie: pole, skalar analityczny, mapę oraz $\sum_i\mathrm{eden}_{ext,i}V_i=E_{ext}$. Nie należy dopisywać bezwarunkowo wszystkich torque do `E_total`.

### FDM-OBS-02 / OBS-03 — P2: mapa gęstości i skalar rozchodzą się na częściowej komórce

**Status: POTWIERDZONE — niespójność miary z udokumentowaną całką; lokalna definicja gęstości pozostaje do rozstrzygnięcia.**

`backends/fdm/gpu/cuda/runtime/reductions_fp64.cu::external_energy_blocks_kernel` i kernele energii anizotropii używają `volume_fraction` oraz wagi $\varphi_i$. `backends/fdm/gpu/cuda/interactions/energy_density_fp64.cu::energy_density_kernel` zna maskę aktywności, ale nie otrzymuje udziału objętościowego. `backends/fdm/api/c_api.cpp` przekazuje korekcję granicy wraz z `volume_fraction` do runtime FP64. `docs/physics/0890-energy-density-observables.md` opisuje jednak całkę jako $E_i=\sum_c\varepsilon_i(c)V_c$ z pełną objętością komórki.

Przy $\varphi=0.5$ i stałej energii na objętość magnetyczną całka mapy z pełnym $V_c$ ma dwukrotnie większy moduł niż redukcja skalarna ważona $\varphi$. To może być poprawne tylko wtedy, gdy mapa jawnie reprezentuje inną gęstość; bez takiej deklaracji skalar i mapa łamią kontrakt obserwable. Istniejący `backends/fdm/tests/partial_cell_energy_contract.cpp` sprawdza tekstową obecność `volume_fraction` w redukcjach, ale nie całkuje `eden_*` na częściowej komórce. Potrzebny jest test z jedną częściowo zapełnioną komórką, znanym $E$, oboma konwencjami i jednoznaczną metadanych miary.

## Macierz dowodów FDM CPU/GPU

Tabela opisuje stan materiału już zebranego w audycie. `Źródła` oznacza implementację widoczną w bieżącym checkoutcie; `kontrakt` oznacza test strukturalny lub jednostkowy; `runtime` wymaga rzeczywistego wykonania i artefaktu z provenance.

| Obszar | FDM CPU | FDM GPU | Wspólny warunek akceptacji | Stan |
|---|---|---|---|---|
| Wymiana | `crates/fullmag-engine/src/fdm/cpu/fields.rs`, `cpu/integrators.rs` | `backends/fdm/gpu/cuda/interactions/exchange_fp64.cu::exchange_field_fp64_kernel`, `exchange_fp32.cu`, `multilayer_exchange.cu` | pochodna kierunkowa, jednorodny stan, interfejs $A/M_s$, brzeg i PBC, zbieżność | źródła obecne; pełny runtime/parytet **NOT VERIFIED** |
| Demag open | `crates/fullmag-engine/src/fdm/cpu/fft.rs::compute_newell_kernel_spectra`, `cpu/fft_backend.rs::FdmFftBackend` | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu::launch_demag_field_fp64`, `demag_fp32.cu` | self-term, wzajemność ważona $V_i$, padding, energia, analityczny orakl | **NOT VERIFIED** |
| Demag PBC/multilayer | `crates/fullmag-engine/src/fdm/cpu/fft.rs::compute_newell_kernel_spectra` i `crates/fullmag-engine/tests/multilayer_unequal_transfer.rs` | `demag_boundary_fp64.cu`, `runtime/` endpoint/cache | osobne obrazy PBC, transfer nierównych warstw i zgodność indeksowania | **NOT VERIFIED** |
| Zeeman uniform | `crates/fullmag-engine/src/fdm/shared/terms.rs::EffectiveFieldTerms`, `shared/observables.rs::EffectiveFieldObservables` | `backends/fdm/gpu/cuda/runtime/context.cu` i reductions | $E=-\mu_0\sum V_i\mathbf M_i\cdot\mathbf H_i$, wspólny snapshot | źródła; runtime **NOT VERIFIED** |
| Static external map | mapowanie `crates/fullmag-ir/src/model.rs` i adapter FDM CPU | `context_mark_static_external_field_profile`, setter C ABI, `NativeFdmBackend` | static map w polu, skalarze, `eden_ext`, `eden_total`, z niezależną energią | **P1 POTWIERDZONE** pominięcie w GPU observables |
| Regional field | `crates/fullmag-engine/src/fdm/shared/terms.rs::EffectiveFieldTerms` | `backends/fdm/gpu/cuda/interactions/regional_field_drive.cuh`, `external_energy_blocks_kernel` | rozdział konserwatywnego pola od drive torque; pole=skalar=mapa | pominięcie w mapie GPU **POTWIERDZONE — źródła, OBS-02** |
| Uniaxial/cubic | wspólna term/materializacja CPU w `fdm/shared/terms.rs` | `multilayer_anisotropy.cu` | osobne potęgi $K_{u1},K_{u2}$, osie, pole, skalar i mapa | FDM **NOT VERIFIED**; `OBS-01` dotyczy FEM |
| Bulk/interfacial DMI | `fdm/cpu/fields.rs`, shared terms | `multilayer_dmi.cu`, `dmi_boundary.cuh` | znak, chiralność, pochodna, boundary term, $D$ stałe/skokowe | recipe istnieje; runtime **NOT VERIFIED** |
| Termika | `fdm/cpu/integrators.rs`, `cpu/state.rs::ExchangeLlgState` | integratory CUDA `llg_fp32.cu`, `llg_dp45_fp32.cu` | wariancja/kowariancja vs $T,V,\Delta t$, retry i resume | **NOT VERIFIED** |
| Charge/spin transport | `cpu/transport/charge.rs::StructuredChargeProblem`, `coupled_charge_spin.rs`, `spin_drift_diffusion.rs` | `backends/fdm/gpu/cuda/transport/context.cu` | bilans, BC izolatora, wspólny prąd, jednostki, snapshot czasu | CPU źródła; GPU/parytet **NOT VERIFIED** |
| Oersted | `cpu/transport/oersted.rs`, `backends/fdm/cpu/interactions/oersted/` | `cuda/transport/context.cu`, runtime field buffers | pole z tego samego prądu i etapu, odrębna energia/drive semantyka | test pola ograniczony; energia **NOT VERIFIED** |
| STT/SOT | `fdm/shared/terms.rs::EffectiveFieldTerms` i CPU transport | GPU integrator/context; brak w tym audycie osobnego dowodu każdego wariantu | zmiana znaku prądu, polaryzacja, maska celu, skala $M_s$/grubości | **NOT VERIFIED** |
| LLG/integratory | `cpu/integrators.rs`, `fdm_abm3_cpu.rs`, `fdm_adaptive_cpu.rs` | CUDA integrator files i runtime transaction | order, accepted/rejected state, norma, czas, brak cichego fallbacku | **NOT VERIFIED** |
| Frozen spins | `shared/frozen_spins.rs` | wspólny stan przekazany do CUDA | frozen vs inactive, wpływ na każdy operator, serializacja | kontrakty częściowe; pełna macierz **NOT VERIFIED** |
| Energy observables | `shared/observables.rs::EffectiveFieldObservables`, CPU direct snapshot | `energy_density_fp64.cu::energy_density_kernel`, `reduce_external_energy_fp64` | ta sama miara, maska, snapshot i składniki; suma mapy=skalar | **P1/P2 POTWIERDZONE** niespójności GPU |
| Topological charge | FDM planar sample w warstwie API/analizy | brak dowodu native GPU sampler w tym audycie | orientacja, normalna `xz=-y`, support topology, zbieżność | struktura walidatora PASS; backend runtime **NOT VERIFIED** |

## Braki kwalifikacji i istniejące dowody

- `benchmarks/fem-llg/qualification-registry-v1.json` ma dziewięć wpisów, wszystkie `unvalidated`; nie jest to rejestr ukończonej kwalifikacji FDM. Odczytane `tests/fem_fdm_mumax3_sinc_layer/results/current/fdm_gpu/qualification.json` i `fdm_gpu_dt50fs_diagnostic_retry/qualification.json` mają `status=not_evaluated`, `checks=[]`, `validation_state=unvalidated`, mimo zapisanych 105 accepted steps. Licznik kroków nie potwierdza trajektorii, błędu integratora, energii ani source identity.
- Seria walidatorów dała `29 passed, 8 subtests passed, 16 failed`; wszystkie 16 porażek należały do fixture `scripts/test_validate_fdm_relaxation_qualification.py`, najpierw `WinError 206`, a po próbie extended path `QualificationError: repo_root is not the Git worktree root`. To blocker narzędzia Windows przed oceną fizyki, a nie 16 znalezionych błędów solvera. Wynik pozostaje **NOT VERIFIED**.
- `scripts/check_physics_docs_gate.py::PHYSICS_FACING_PREFIXES` nie obejmuje `backends/` ani `crates/fullmag-engine/`; predykat dla drzew FDM zwrócił `False`. Zmiana kernela FDM może więc nie wymusić noty fizycznej. Jest to luka bramki, nie dowód błędu operatora.
- Wykonane testy dokumentacji: `validate_page` dla 43 istniejących map dał 34 PASS i 9 FAIL; testy walidatora dokumentacji dały 29/29 PASS. Nie dowodzi to kwalifikacji FDM runtime.
- Pakiet [physics-evidence.json](2026-09-08-physics-evidence.json) zawiera fingerprint `269ce0d7a4e0336c68aa498e0365f54a87b96830ecc8ddcc935d2f7f4f20ac90` dla 1625 odczytanych plików backendu, IR, runnera, DSL i not fizycznych. Fingerprint identyfikuje źródła, nie zbudowany runtime ani receipt.
- W audycie nie uruchamiano nowego managed FDM CPU/GPU runtime, CUDA device qualification, benchmarku CPU/GPU, walidacji µMAG ani browser/WebGL. Wszystkie takie twierdzenia pozostają **NOT VERIFIED**.

## Minimalne bramki domknięcia FDM

1. **Static/regional energy regression.** Dwa izolowane scenariusze: tylko static map oraz tylko regional field. Dla każdego sprawdzić `H_ext`, `H_eff`, skalar analityczny, `eden_ext`, `eden_total`, całkę z tą samą miarą oraz rozdzielenie `EDEN_DRIVE`.
2. **Partial-cell measure regression.** Jedna i kilka komórek z $0<\varphi<1$; jawnie wybrać `full-cell averaged density` albo `material-volume density`, zapisać canonical unit/measure i sprawdzić $\sum\mathrm{eden}_iV_i=E_i$.
3. **Operator derivative tests.** Wspólna kwadratura i maska dla exchange, demag, Zeeman, anisotropy i DMI; osobno boundary/PBC/multilayer oraz skok $A$, $M_s$, $D$.
4. **CPU/GPU parity.** Identyczne wejście, raster, maska, volume fraction, precision i source identity w receipt. Porównać pola i każdy skalar przed porównaniem trajektorii. Wymuszony GPU ma kończyć się błędem przy braku urządzenia, bez cichego CPU fallbacku.
5. **Dynamics and stochastic lanes.** Macrospin w stałym polu (kierunek i częstotliwość), norma, order/convergence każdego integratora, rollback accepted/rejected, thermal variance and equilibrium, transport current balance, Oersted same-stage snapshot.
6. **Qualification artifact.** Receipt musi zawierać requested/resolved backend/device/precision, source identity, input identity, completed exit status, output hashes, accepted/rejected steps, stop reason i niezależne bramki fizyczne. `unvalidated` lub sama obecność pliku wynikowego nie kwalifikuje lane.

Do czasu przejścia tych bramek nie należy opisywać FDM CPU/GPU jako w pełni poprawnego i zwalidowanego we wszystkich oddziaływaniach. Najsilniejsze bieżące ustalenia FDM to dwa problemy obserwabli GPU: pominięcie statycznej/regionalnej energii w materializacji pól oraz niespójna miara częściowej komórki. Pozostałe oddziaływania mają źródła, ale brak im aktualnego, przypiętego do źródeł dowodu pełnej kwalifikacji.


