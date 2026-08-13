# FDM multilayer: pola materiałowe i przynależność obiektów

- Status: kontrakt planner/IR; realizacja runnera CPU i resource-first API pozostają odroczone.
- Właściciel: Fullmag FDM planner/IR.
- Zakres: warstwy FDM z rozdzielnymi siatkami natywnymi, polami `Ms/Aex/alpha`
  oraz maskami obiektów/regionów używanymi przez monitor planarny.
- Powiązane noty: `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`,
  `docs/physics/0421-fdm-multilayer-convolution-demag.md`,
  `docs/physics/0970-planar-monitor-sampling-and-projection.md`.

(problem-statement)=
## 1. Dziedzina fizyczna

Dla rozłącznych magnetów $k=1,\ldots,L$ każdy obiekt ma własne pole
zredukowanej magnetyzacji $\mathbf m_k$ oraz własne współczynniki materiałowe.
Wspólna konwolucyjna siatka FFT jest wyłącznie siatką obliczeniową; nie może
zastępować natywnej geometrii, maski aktywnej ani tożsamości obiektu. Monitor
planarny wybiera obiekt lub region przez jawny identyfikator warstwy i maskę,
a nie przez pozycję w konkatenowanym wektorze pól.

(governing-equations)=
## 2. Równania

W warstwie $k$ fizyczna magnetyzacja i lokalne parametry wynoszą

```{math}
:label: eq-multilayer-material-magnetization
\mathbf M_k(\mathbf r,t)=M_{s,k}(\mathbf r)\,\mathbf m_k(\mathbf r,t),
\qquad \lVert\mathbf m_k\rVert=1.
```

Wartości komórkowe są próbkowane w środkach aktywnych komórek natywnej
siatki. Dla operatora wymiany w regularnej siatce używany jest lokalny
współczynnik interfejsowy, a pole ma postać

```{math}
:label: eq-multilayer-material-exchange
\mathbf H_{\mathrm ex,k,i}=
\frac{2}{\mu_0 M_{s,k,i}V_{k,i}}
\sum_{j\in\mathcal N(i)}
A_{k,ij}\frac{S_{k,ij}}{d_{k,ij}}
\left(\mathbf m_{k,j}-\mathbf m_{k,i}\right).
```

Demagnetyzacja używa pełnej magnetyzacji źródłowej, zachowując rozdzielność
warstw:

```{math}
:label: eq-multilayer-material-demag-source
\mathbf H_{\mathrm d,k,i}=-\sum_{s=1}^{L}\sum_{j\in\mathcal A_s}
\mathsf N_{k\leftarrow s}(\mathbf r_{k,i}-\mathbf r_{s,j})
M_{s,s,j}\mathbf m_{s,j}V_{s,j}.
```

Operator monitora jest niezależny od sposobu przechowywania warstw. Dla
wybranego targetu $T$ i binu $b$ redukcja ma postać

```{math}
:label: eq-multilayer-material-monitor-membership
q_{T,b}=\frac{\sum_{(k,i)\in T\cap b}w_{k,i}q_{k,i}}
{\sum_{(k,i)\in T\cap b}w_{k,i}},
\qquad w_{k,i}\ge 0,
```

gdzie $T$ jest rozstrzygany przez `object_id`/`region_id`, a nie przez kolejność
warstw w artefakcie.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf m_k$ | zredukowana magnetyzacja warstwy | $1$ |
| $\mathbf M_k$ | fizyczna magnetyzacja warstwy | $\mathrm{A\,m^{-1}}$ |
| $M_{s,k}(\mathbf r)$ | nasycenie w punkcie $\mathbf r$ warstwy $k$ | $\mathrm{A\,m^{-1}}$ |
| $M_{s,k,i}$ | nasycenie w komórce $i$ warstwy $k$ | $\mathrm{A\,m^{-1}}$ |
| $A_{k,ij}$ | współczynnik wymiany na ścianie komórek | $\mathrm{J\,m^{-1}}$ |
| $\alpha_{k,i}$ | tłumienie Gilberta w komórce | $1$ |
| $V_{k,i}$ | objętość komórki | $\mathrm{m^3}$ |
| $S_{k,ij}$ | pole ściany wymiany | $\mathrm{m^2}$ |
| $d_{k,ij}$ | odległość środków komórek | $\mathrm{m}$ |
| $\mathsf N_{k\leftarrow s}$ | tensor demagnetyzacji pary warstw | $1$ |
| $w_{k,i}$ | waga redukcji monitora | $1$ |
| $\mu_0$ | przenikalność magnetyczna próżni | $\mathrm{N\,A^{-2}}$ |
| $\mathbf H_{\mathrm ex,k,i}$ | lokalne pole wymiany | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm d,k,i}$ | lokalne pole demagnetyzacji | $\mathrm{A\,m^{-1}}$ |
| $M_{s,s,j}$ | Ms komórki źródłowej | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m_{s,j}$ | magnetyzacja zredukowana źródła | $1$ |
| $V_{s,j}$ | objętość komórki źródłowej | $\mathrm{m^3}$ |
| $q_{T,b}$ | zredukowana wartość w binie monitora | $1$ |
| $T$ | wybrany target monitora | $1$ |

(assumptions-and-validity)=
## 4. Założenia i granice ważności

1. Każda warstwa ma własną natywną siatkę, początek, rozmiar komórki i maskę
   aktywną; konkatenacja snapshotu nie zmienia tych danych.
2. Warstwy mogą zajmować ten sam przedział $z$, jeśli ich rzuty XY są
   rozłączne. Nakładanie objętości fizycznych nadal kończy planowanie błędem.
3. Regiony FDM są próbkowane w układzie obiektu i otrzymują stabilną legendę
   `(numeric_id, object_id, region_id, priority)`. Nieobsługiwany kształt lub
   układ odniesienia kończy planowanie błędem.
4. `Ms`, `Aex` i `alpha` muszą mieć długość równą liczbie komórek natywnej
   warstwy; wartości niefinitywne lub niezgodne z domeną fizyczną są odrzucane.
5. Brak bezpośredniej wymiany między różnymi obiektami pozostaje semantyką
   domyślną. Sprzężenia między obiektami wymagają osobnej, jawnej realizacji.
6. Ten kontrakt nie promuje FDM GPU, nie dopuszcza cichego fallbacku CPU i nie
   stanowi dowodu parytetu ani kwalifikacji produkcyjnej.

(python-api)=
## 5. Publiczny Python

Minimalny scenariusz stage-first używany w kwalifikacji:

```python
# %%
import fullmag as fm

# %%
study = fm.study("multilayer_material_monitor")
study.engine("fdm")
study.device("cpu", precision="double")
study.interactive(True)
film = study.geometry(fm.Box(size=(80e-9, 60e-9, 20e-9), name="film"), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.1
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.set_material_field("Ms", fm.fields.linear(base=800e3, gradient=(1e12, 0.0, 2e12), unit="A/m"))
core = film.add_region("core", fm.Box(size=(40e-9, 30e-9, 20e-9)), region_id="core")
study.exchange()
study.demag()
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", max_steps=1)
```

`set_material_field` i `add_region` opisują intencję fizyczną. Nie wolno
przenosić do API indeksów komórek, buforów CUDA ani offsetów konkatenowanego
artefaktu.

| Python | Typ | Domyślna wartość | Jednostka | Walidacja | Znaczenie | Obsługa | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Ferromagnet.set_material_field("Ms", field)` | `MaterialParameterField` | `none` | $\mathrm{A\,m^{-1}}$ | finite positive resolved Ms | przestrzenna wartość $M_s$ | FDM CPU reference; GPU unqualified | `material_parameter_fields[]` |
| `Ferromagnet.add_region(..., region_id=...)` | `ObjectRegion` | `none` | $1$ | supported shape and `frame="object"` | selector obiektu/regionu | FDM CPU reference; GPU unqualified | `object_regions[]` |

(problem-ir)=
## 6. ProblemIR i plan wykonawczy

Plan multilayer zachowuje dla każdej warstwy:

- `native_grid`, `native_cell_size`, `native_origin` i `native_active_mask`;
- `material` z opcjonalnymi `ms_field`, `a_field`, `alpha_field`;
- natywną maskę regionów i legendę wiążącą ją z `object_id`/`region_id`;
- `layer_id` oraz `object_id`, które są częścią tożsamości próbki pola.

`CommonPlanMeta.material_field_plans` opisuje źródło i lokalizację realizacji,
natomiast nie zastępuje payloadu per warstwa. Żądany backend i rozstrzygnięty
backend są zachowywane osobno w provenance.

Python `set_material_field` jest obniżane do `material_parameter_fields[]`, a
`add_region` do `object_regions[]`; planner rozstrzyga je na natywnych punktach
warstwy. Eksport skryptu odtwarza te dwa wywołania, nie tablice `ms_field`.

(round-trip-and-failure-semantics)=
## 7. Round-trip i błędy

- układ obiektów rozłącznych w XY i wspólnym $z$ jest legalny w planie
  multilayer, z jawnie zapisanym `push_pull`;
- nakładanie objętości, niezgodna długość pola, nieznany region lub konflikt
  regionów kończą się błędem planera przed uruchomieniem solvera;
- wymuszone CUDA odrzuca niezakwalifikowaną kombinację z kodem przyczyny;
- eksport Python zachowuje `set_material_field` i `add_region`, a nie wynikowe
  tablice komórkowe.

Są to jawne **validation errors**; kombinacje poza macierzą są **unsupported
combinations** i nie są obniżane do innego backendu.
W tej nocie termin `unsupported combinations` oznacza odrzucenie przed startem
solvera, a nie ukryty fallback.

Requested intent (`multilayer_convolution`, pola i regiony) pozostaje w IR nawet
gdy resolved execution odrzuci urządzenie GPU lub konkretny operator. Błąd
walidacji jest publikowany jako diagnostyka planowania przed utworzeniem sesji;
nie ma cichego fallbacku do jednego obiektu ani do stałego `Ms`.

(discrete-realization)=
## 8. Realizacja dyskretna

Planner próbuje kolejno: (1) zbudować natywną geometrię i maskę aktywną,
(2) wygenerować punkty środków komórek w układzie świata i obiektu,
(3) rozstrzygnąć maskę/legendę regionów, (4) rozwiązać `Ms/Aex/alpha`,
(5) związać payload z warstwą. Task 0422 nie materializuje tych payloadów w
runnerze, artefaktach ani API; nie stanowi więc dowodu wykonania pola wymiany,
demag, `mat_ms` ani filtrowania monitora.

(implementation-mapping)=
## 9. Mapa implementacji

| Kontrakt | Źródło i symbol | Stan |
|---|---|---|
| Warstwa i tożsamość | `crates/fullmag-ir/src/mesh_hints.rs::struct FdmLayerPlanIR` | istnieje, rozszerzany o membership |
| Topologia warstw | `crates/fullmag-ir/src/mesh_hints.rs::fdm_multilayer_topology_tokens` | fingerprint layoutu warstw |
| Rozwiązywanie pól | `crates/fullmag-plan/src/material.rs::resolve_spatial_parameter` | istnieje dla siatki natywnej |
| Maska regionu | `crates/fullmag-plan/src/fdm.rs::materialize_object_region_mask` | materializowana per warstwa |
| Runner CPU / artefakty / API | poza Task 0422 | odroczone; nie są promowane jako realizacja payloadu |

(validation)=
## 10. Walidacja i kwalifikacja

| Solver | CPU | GPU | Wymagany dowód |
|---|---|---|---|
| FDM | planner/IR zaimplementowany; runner CPU odroczony | no-go do osobnej bramki | planner/IR, potem managed runtime i monitor object/region isolation |
| FEM | nie dotyczy tego layoutu | nie dotyczy tego layoutu | wspólny `ResolvedSpatialField` ma osobną macierzę FEM |

Minimalne testy obejmują: dwa rozłączne obiekty coplanar, liniowe
`Ms/Aex/alpha`, region z maską, niezgodne długości, konflikt regionów,
stabilną tożsamość legacy i klasyfikację overlap. Testy kontraktowe nie
zastępują późniejszego managed runtime ani browser/WebGL proof.

(limitations)=
## 11. Ograniczenia i prace odroczone

Odroczone są: podłączenie `ms_field/a_field/alpha_field` i membership do
runnera CPU, artefaktów, API oraz monitora; FDM GPU dla heterogenicznych
warstw; PBC z transferem; sprzężenia między obiektami; regiony CSG;
pola anizotropii/DMI w multilayer; produkcyjny parytet FDM/FEM. Do czasu
osobnych dowodów planner ma odrzucać nieobsługiwane kombinacje jawnie.

(scientific-bibliography)=
## 12. Bibliografia

- Lepadatu, S., “Fast and accurate calculation of demagnetizing fields for
  magnetic multilayers”, *J. Appl. Phys.* 126, 103903 (2019),
  DOI: [10.1063/1.5116754](https://doi.org/10.1063/1.5116754).
- Newell, A. J., Williams, W. and Dunlop, D. J., “A three-dimensional model
  of demagnetizing factors for rectangular prisms”, *Geophys. J. Int.* 105
  (1991), DOI: [10.1111/j.1365-246X.1991.tb03461.x](https://doi.org/10.1111/j.1365-246X.1991.tb03461.x).

(source-code-index)=
## 13. Indeks źródeł

| Twierdzenie | Path + symbol | Test/evidence |
|---|---|---|
| tożsamość i migracja warstwy | `crates/fullmag-ir/src/mesh_hints.rs::fdm_multilayer_topology_tokens` | `multilayer_contract_tests` |
| rozwiązywanie parametrów przestrzennych | `crates/fullmag-plan/src/material.rs::resolve_spatial_parameter` | `crates/fullmag-plan/src/tests.rs` material-field tests |
| maska i legenda regionów | `crates/fullmag-plan/src/fdm.rs::materialize_object_region_mask`, `build_fdm_region_legend` | FDM region-mask planner tests |
