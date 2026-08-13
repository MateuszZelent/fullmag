# FDM multilayer: pola materiałowe i przynależność obiektów

- Status: planner/IR, referencyjny runner FDM CPU, artefakty per-layer oraz
  natywny carrier API/planar są zaimplementowane i zreviewowane na poziomie
  źródeł/testów; brak managed runtime, walidacji naukowej i browser/WebGL proof.
- Właściciel: Fullmag FDM planner/IR, referencyjny runner CPU, artefakty i
  resource-first API.
- Zakres: warstwy FDM z rozdzielnymi siatkami natywnymi, polami `Ms/Aex/alpha`
  oraz maskami obiektów/regionów wymaganymi przez docelowy monitor planarny.
- Powiązane noty: `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`,
  `docs/physics/0421-fdm-multilayer-convolution-demag.md`,
  `docs/physics/0970-planar-monitor-sampling-and-projection.md`.

(problem-statement)=
## 1. Dziedzina fizyczna

Dla rozłącznych magnetów $k=1,\ldots,L$ każdy obiekt ma własne pole
zredukowanej magnetyzacji $\mathbf m_k$ oraz własne współczynniki materiałowe.
Wspólna konwolucyjna siatka FFT jest wyłącznie siatką obliczeniową; nie może
zastępować natywnej geometrii, maski aktywnej ani tożsamości obiektu. Docelowy
monitor planarny musi wybierać obiekt lub region przez jawny identyfikator
warstwy i maskę, a nie przez pozycję w konkatenowanym wektorze pól. Bieżący
carrier publikuje przynależność per natywna warstwa, zachowując jej tożsamość,
geometrię, legendę oraz fingerprint topologii.

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

gdzie kontrakt wymaga, aby $T$ był rozstrzygany przez `object_id`/`region_id`,
a nie przez kolejność warstw w artefakcie. Natywny carrier warstwy i resolver
targetu realizują ten kontrakt w źródłach API dla `scope_kind=layer`; brak
kwalifikacji managed/browser oznacza, że nie jest to jeszcze twierdzenie o
produkcyjnej wizualizacji.

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
| `Ferromagnet.set_material_field("Ms", field)` | `MaterialParameterField` | `none` | $\mathrm{A\,m^{-1}}$ | finite positive resolved Ms | przestrzenna wartość $M_s$ | FDM CPU reference: implemented, unqualified; GPU heterogeneous: unsupported | `material_parameter_fields[]` |
| `Ferromagnet.add_region(..., region_id=...)` | `ObjectRegion` | `none` | $1$ | supported shape and `frame="object"` | selector obiektu/regionu | planner/IR oraz artifacts/API/planar carrier: implemented, source-tested, runtime/browser unqualified; GPU heterogeneous: unsupported | `object_regions[]` |

(problem-ir)=
## 6. ProblemIR i plan wykonawczy

Plan multilayer zachowuje dla każdej warstwy:

- `native_grid`, `native_cell_size`, `native_origin` i `native_active_mask`;
- `material` z opcjonalnymi `ms_field`, `a_field`, `alpha_field`;
- natywną maskę regionów i legendę wiążącą ją z `object_id`/`region_id`;
- `layer_id` oraz `object_id`, które są częścią tożsamości próbki pola.

`CommonPlanMeta.material_field_plans` opisuje źródło i lokalizację realizacji,
natomiast nie zastępuje payloadu per warstwa. `FdmLayerPlanIR.material`
przechowuje rozstrzygnięte `ms_field`, `a_field` i `alpha_field`, a
`native_region_mask` wraz z `native_region_legend` zachowują przynależność.
Żądany backend i rozstrzygnięty backend są zachowywane osobno w provenance.

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

Planner kolejno: (1) buduje natywną geometrię i maskę aktywną,
(2) generuje punkty środków komórek w układzie świata i obiektu,
(3) rozstrzyga maskę/legendę regionów, (4) rozwiązuje `Ms/Aex/alpha`,
(5) wiąże payload z warstwą. Task 10B przekazuje te trzy pola materiałowe do
referencyjnego runnera CPU: `Aex` zasila wymianę, `alpha` lokalny RHS i torque,
a `Ms` źródło demag, energię oraz wagę momentu. Jest to dowód kodu wykonywalnego
i testów jednostkowych, nie dowód świeżego managed runtime ani kwalifikacji
naukowej.

Task 10C zapisuje pola materiałowe, maskę i pełną legendę jako artefakty
`per_layer_native_grid`. Resource-first API rozwiązuje statyczny carrier
plan-first z `execution_plan` podczas aktywnej sesji, a dla wyniku persisted
czyta artefakty i porównuje obie reprezentacje, jeśli występują równocześnie.
Rozbieżność tożsamości warstwy, siatki, legendy, hasha, generation ID lub
revision kończy się `409`; pusty target kończy się `422`. Binary membership
`FMRM v2` pozostaje związany z deskryptorem JSON, ETag i fingerprintem
topologii. Planar sampler wymaga dokładnego `scope_kind=layer`, po czym wybiera
`object_id`/`region_id` z membership tej warstwy. Nie ma flatteningu do wspólnej
siatki ani zastąpienia pola skalarem.

(implementation-mapping)=
## 9. Mapa implementacji

| Kontrakt | Źródło i symbol | Stan |
|---|---|---|
| Warstwa i tożsamość | `crates/fullmag-ir/src/mesh_hints.rs::struct FdmLayerPlanIR` | natywna siatka, obiekt, maska, legenda i materiał zaimplementowane |
| Topologia warstw | `crates/fullmag-ir/src/mesh_hints.rs::fdm_multilayer_topology_tokens` | fingerprint layoutu warstw |
| Rozwiązywanie pól | `crates/fullmag-plan/src/material.rs::resolve_spatial_parameter` | istnieje dla siatki natywnej |
| Maska regionu | `crates/fullmag-plan/src/fdm.rs::materialize_object_region_mask` | materializowana per warstwa |
| Runner CPU: materiał | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs::build_contexts_and_states`, `llg_rhs_multilayer`, `observe_multilayer` | `Ms/Aex/alpha` podłączone w Task 10B; source/unit-test evidence, bez managed qualification |
| Źródło demag CPU | `crates/fullmag-engine/src/multilayer.rs::compute_demag_fields_checked` | natywne `Ms` użyte przed maską i transferem FFT; source/unit-test evidence |
| Artefakty per-layer | `crates/fullmag-runner/src/artifacts.rs::write_fdm_multilayer_material_field_artifacts` | `mat_ms/mat_aex/mat_alpha`, maska i legenda zapisane bez wspólnej siatki ani scalar fallbacku; source/unit-test evidence |
| Carrier pól i membership | `crates/fullmag-api/src/router_v2/handlers/data/resolved_spatial_field.rs::resolve_fdm_multilayer_native_layer_field`, `load_fdm_multilayer_native_layer_membership` | plan-first i persisted, cross-check fail-closed; source/API-test evidence |
| Deskryptor i payload membership | `crates/fullmag-api/src/router_v2/handlers/data/domain.rs::get_fdm_multilayer_layer_region_memberships`, `get_fdm_multilayer_layer_region_membership` | pełna legenda JSON, binary `FMRM v2`, ETag i rewizje; source/API-test evidence |
| Filtrowanie monitora | `crates/fullmag-api/src/planar_sampling/target.rs::resolve_spatial_target`, `select_fdm_target` | dokładny native-layer scope oraz target object/region; source/API-test evidence, browser unqualified |
| Klient browsera | `apps/control-room/src/kernel/api/ControlRoomApi.ts::data.domain.fdmMultilayerLayerRegionMemberships`, `apps/control-room/src/kernel/api/codecs/fdmRegionMembershipCodec.ts::validateFdmNativeLayerRegionMembershipContract` | centralny facade i fail-closed codec zaimplementowane/testowane; brak browser/WebGL proof |

(validation)=
## 10. Walidacja i kwalifikacja

| Solver | CPU | GPU | Wymagany dowód |
|---|---|---|---|
| FDM | planner/IR, referencyjne podłączenie CPU, artifacts/API i native-layer planar carrier zaimplementowane i zreviewowane; bez managed/scientific/browser qualification | heterogeniczne pola pozostają no-go | managed CPU runtime, walidacja naukowa i browser/WebGL object/region isolation |
| FEM | nie dotyczy tego layoutu | nie dotyczy tego layoutu | wspólny `ResolvedSpatialField` ma osobną macierzę FEM |

Testy planner/IR obejmują: dwa rozłączne obiekty coplanar, liniowe
`Ms/Aex/alpha`, region z maską, niezgodne długości, konflikt regionów,
stabilną tożsamość legacy i klasyfikację overlap. Testy CPU Task 10B obejmują
zachowanie pól w kontekście, lokalne `alpha`, ważenie energii i momentu przez
`Ms` oraz heterogeniczne źródło demag przed transferem. Te testy nie zastępują
managed runtime, walidacji naukowej ani późniejszego browser/WebGL proof.
Testy Task 10C obejmują dwa niezależne native-layer carriers z powtórzonym
`region_id`, pełną legendę, plan-first bez artefaktów końcowych, kontrolę
plan-versus-persisted, ETag/304, stale revision/token, `409` dla uszkodzonych
deklarowanych payloadów oraz `422` dla pustego targetu. Testy klienta sprawdzają
wiązanie deskryptora, payloadu `FMRM v2`, warstwy, siatki, legendy, generation
ID, revision i hashy. Jest to walidacja kontraktu źródłowego/API, nie wykonany
managed scenario ani dowód obrazu WebGL.

(limitations)=
## 11. Ograniczenia i prace odroczone

Odroczone są: managed i naukowa kwalifikacja podłączenia CPU oraz carrierów,
browser/WebGL proof monitora, FDM GPU dla heterogenicznych warstw, PBC z
transferem, sprzężenia między obiektami, regiony CSG, pola anizotropii/DMI w
multilayer oraz produkcyjny parytet FDM/FEM. Bieżący carrier publikuje statyczne
pola materiałowe i membership; nie promuje dynamicznych pól `m/H` do live
multilayer, jeśli nie opublikował ich właściwy field store. Do czasu osobnych
dowodów planner i API mają odrzucać nieobsługiwane albo niespójne kombinacje
jawnie.

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
| podłączenie `Ms/Aex/alpha` do referencyjnego CPU | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs::build_contexts_and_states`, `llg_rhs_multilayer`, `observe_multilayer` | `multilayer_contexts_preserve_spatial_material_fields`, `multilayer_rhs_uses_cellwise_alpha`, `multilayer_observables_weight_demag_external_energy_and_moment_by_ms` |
| heterogeniczne źródło demag CPU | `crates/fullmag-engine/src/multilayer.rs::compute_demag_fields_checked` | `demag_source_uses_native_ms_field_and_rejects_invalid_fields`, `push_pull_demag_uses_native_ms_field_before_transfer` |
| artefakty natywnej warstwy | `crates/fullmag-runner/src/artifacts.rs::write_fdm_multilayer_material_field_artifacts` | `fdm_multilayer_writes_per_layer_material_and_membership_artifacts`, `fdm_multilayer_material_artifacts_do_not_expand_scalar_fallbacks`, `fdm_multilayer_native_grid_fingerprint_binds_active_mask_and_raw_membership` |
| API pól i membership natywnej warstwy | `crates/fullmag-api/src/router_v2/handlers/data/resolved_spatial_field.rs::resolve_fdm_multilayer_native_layer_field`, `load_fdm_multilayer_native_layer_membership` | `fdm_multilayer_planar_layer_scope_uses_native_grid_and_local_region_membership` |
| layout, deskryptor/binary membership i filtrowanie targetu | `crates/fullmag-api/src/router_v2/handlers/data/domain.rs::fdm_multilayer_layout_resource`, `get_fdm_multilayer_layer_region_memberships`, `get_fdm_multilayer_layer_region_membership`; `crates/fullmag-api/src/planar_sampling/target.rs::resolve_spatial_target` | dwa native layers, pełna legenda, region isolation, ETag/304, stale/mismatch `409`, empty target `422` w `fdm_multilayer_planar_layer_scope_uses_native_grid_and_local_region_membership` |
| kontrakt klienta membership | `apps/control-room/src/kernel/api/codecs/fdmRegionMembershipCodec.ts::validateFdmNativeLayerRegionMembershipContract` | `apps/control-room/src/kernel/api/codecs/fdmRegionMembershipCodec.test.ts`; source/client tests, browser/WebGL proof odroczony |
