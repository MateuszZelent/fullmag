# Plan rozbudowy modulu histerezy

Status: aktywny plan architektoniczno-wdrozeniowy.

Data: 2026-06-09

Zakres: Python DSL, ProblemIR, planner, runtime stage execution, artifacty,
OpenAPI v2, Control Room, analiza wykresow i 3D viewport dla punktow petli
histerezy.

## Cel

Modul histerezy ma stac sie pelnoprawnym workflow naukowym, a nie tylko
skrotem, ktory materializuje serie etapow relaksacji. Uzytkownik powinien moc:

1. zaplanowac petle albo galaz histerezy z UI i Pythona,
2. podac pole minimalne, maksymalne, krok, jawna liste punktow albo
   przedzialy pola z roznymi krokami,
3. ustawic konfiguracje pola OOP, in-plane albo dowolny kat wzgledem probki,
4. wybrac protokol startu: stan aktualny/zero-field, virgin curve,
   saturacja dodatnia/ujemna, checkpoint albo jawny snapshot,
5. zdefiniowac pipeline dochodzenia do stanu w kazdym punkcie pola:
   `relax`, `minimize`, `dynamics_settle` albo sekwencje kilku algorytmow z
   pelnymi parametrami i warunkami stopu,
6. automatycznie oszacowac pole saturacji, jezeli uzytkownik nie zna
   bezpiecznego zakresu pola,
7. planowac petle major, galezie recoil, petle minorowe i w przyszlosci FORC,
8. zobaczyc podglad zaplanowanej sciezki pola przed uruchomieniem,
9. zdecydowac, czy zapisywac tylko srednie magnetyzacje, wybrane snapshoty,
   co N punktow, czy pelna magnetyzacje `m` dla kazdego punktu w formacie
   nadajacym sie do odtwarzania domen magnetycznych,
10. sledzic na zywo punkty dodawane do wykresu,
11. widziec metryki takie jak koercja, remanencja, petla nasycenia,
   podatnosc rozniczkowa, pole przelaczenia i pole powierzchni petli,
12. otworzyc dowolny policzony punkt petli jako read-only magnetyzacje w
   `viewport-3d`,
13. jawnie uzyc wybranego punktu jako nowego stanu poczatkowego, jezeli chce
   rozpoczec kolejna symulacje od tego punktu.

## Diagnoza obecnego stanu

Repo ma juz zalazek funkcji:

- `packages/fullmag-py/src/fullmag/world.py` zawiera
  `StudyStagesBuilder.add_hysteresis_branch(...)`, ktory dodaje kolejne
  relaksacje i opcjonalne `save_state`,
- `crates/fullmag-cli/src/step_utils.rs` materializuje `hysteresis_loop` jako
  punkty pola `b_ext` oraz relaksacje per punkt,
- `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts`
  ma draft `kind: "hysteresis"` z polami `startField`, `stopField`,
  `fieldSteps` i `torqueTolerance`,
- `apps/control-room/src/modules/inspector/panels/stages/HysteresisStageInspector.tsx`
  pokazuje tylko start/stop/liczbe krokow/tolerancje/status/artifacty.

To wystarcza do prostego makra, ale nie wystarcza do naukowej histerezy:

- nie ma jawnego kontraktu galezi `forward`, `return`, `minor_loop`,
- nie ma stabilnego zasobu punktow histerezy i metryk petli,
- nie ma branch-aware chart contract,
- nie ma kontrolowanej polityki storage dla pelnych snapshotow magnetyzacji,
- nie ma przegladania punktow i ladowania ich do 3D viewport,
- nie ma rozdzielenia "pokaz wynik" od "uzyj jako initial state",
- koercja i remanencja nie sa kontraktowymi wynikami workflow.
- nie ma protokolow startowych: virgin curve, saturate-first, checkpoint,
  demagnetized/zero-field,
- nie ma geometrii pomiaru OOP/in-plane/custom angle jako kontraktu,
- nie ma automatycznej detekcji saturacji ani ostrzezen, gdy saturacja nie
  zostala osiagnieta,
- petle minorowe nie maja kontraktu reversal-field, recoil branch ani metryk.
- nie ma pierwszorzednego modelu `settle pipeline`: wyboru jednego albo wielu
  algorytmow `relax/minimize/dynamics_settle`, ich parametrow, kolejnosci,
  warunkow stopu, fallbackow i provenance.

## Zasada projektowa

Histereza jest workflow nad istniejacym modelem fizycznym i etapem
settle/relax/dynamics. Nie wprowadza nowej fizyki oddzielonej od ProblemIR.
Kontrakt musi zachowac:

- ten sam opis geometrii, materialow, interakcji i pola zewnetrznego,
- jawna sciezke pola jako czesc stage,
- requested intent i resolved execution reality,
- rozdzielenie lekkich zasobow JSON od ciezkich pol magnetyzacji,
- branch-aware dane jako kontrakt, nie kosmetyczny tryb rysowania.
- rozdzielenie protokolu pomiarowego od samego harmonogramu pola: ta sama lista
  punktow moze znaczyc co innego, jezeli startuje z virgin state, dodatniej
  saturacji albo od punktu odwracania minor loop.
- rozdzielenie harmonogramu pola od algorytmu dochodzenia do stanu:
  `H_i -> settle_pipeline -> point result`. Ten sam schedule pola z innym
  algorytmem relaksacji jest innym eksperymentem i musi miec inne provenance.

## Faza 0: publikacyjna notatka fizyczna

Przed implementacja trzeba utrzymywac note w `docs/physics/`. Aktualna
kanoniczna notatka to
`docs/physics/0930-hysteresis-sweep-semantics.md`.

Notatka musi zdefiniowac:

1. Problem: quasistatyczna petla histerezy jako sekwencja pol zewnetrznych i
   stanow rownowagi/metastabilnych.
2. Jednostki: kanoniczne `H_ext` w A/m oraz prezentacyjne `mu0 H` w T/mT.
   UI moze przyjmowac mT, ale IR musi przechowywac jednoznaczne SI i
   display-unit provenance. Przelicznik musi uzywac standardowej wartosci
   mu0 = 4*pi*10^-7 H/m z pelna precyzja double (1.2566370614359172e-6).
3. Geometria pola: wektor jednostkowy `u_H`, amplituda skalarna `h_i`, pole
   `H_i = h_i u_H`, plus uklad odniesienia:
   - `sample`: kat polarny `theta` wzgledem normalnej probki i azymut `phi`
     w plaszczyznie probki,
   - `global`: wektor w globalnym ukladzie Fullmag,
   - `object`: kierunek zwiazany z lokalnym ukladem obiektu/regionu,
   - `easy_axis`: kierunek wzgledem zdefiniowanej osi anizotropii.
4. Presety pomiarowe:
   - `oop_positive`: `theta = 0 deg`,
   - `oop_negative`: `theta = 180 deg`,
   - `in_plane_x`: `theta = 90 deg, phi = 0 deg`,
   - `in_plane_y`: `theta = 90 deg, phi = 90 deg`,
   - `custom_angle`: dowolne `theta/phi` albo wektor.
5. Projekcja pomiarowa: metryki musza rozroznic os pola i os odczytu:
   `measurement_axis = field_axis | sample_normal | easy_axis | custom`.
   Domyslnie `m_parallel` jest projekcja na `u_H`, ale OOP/IP UI ma tez
   pokazywac `m_oop` i `m_in_plane`.
6. Protokol poczatkowy:
   - `as_authored`: start z aktualnej magnetyzacji modelu,
   - `zero_field_relaxed`: najpierw relaksacja przy `H = 0`, czyli virgin
     albo demagnetized-like curve zalezne od authored initial state,
   - `positive_saturation`: przygotowanie stanu w dodatniej saturacji i sweep
     w dol,
   - `negative_saturation`: przygotowanie stanu w ujemnej saturacji i sweep w
     gore,
   - `checkpoint`: start z wybranego snapshotu/stanu poprzedniego runu,
   - `ac_demagnetized` jako przyszly protokol, jezeli runtime bedzie wspieral
     malejaca oscylacyjna sekwencje pola.
7. Nazwy eksperymentow:
   - `virgin_curve`: krzywa pierwszego namagnesowania po przygotowaniu
     zero-field/demag,
   - `major_loop`: petla po saturacji dodatniej albo ujemnej,
   - `recoil_branch`: galaz po odwracaniu pola z punktu major branch,
   - `minor_loop`: zamkniety albo czesciowy cykl miedzy reversal fields,
   - `forc_family`: rodzina first-order reversal curves jako rozszerzenie.
8. Automatyczne wykrywanie saturacji:
   - `H_sat+` i `H_sat-` sa estymowane przez adaptacyjny ramp-up pola z limitem
     `max_probe_field`,
   - kryterium wymaga jednoczesnie malej podatnosci `|dm_parallel/dH|`,
     malego torque/error, malej skladowej poprzecznej oraz bliskosci
     projekcji do nasycenia,
   - wynik ma status `saturated | probably_saturated | not_saturated |
     capped_by_limit`,
   - UI i provenance musza pokazac prog, punkty proby i powod decyzji,
   - jezeli saturacja nie zostanie wykryta, plan moze kontynuowac tylko z
     ostrzezeniem albo wymaga decyzji uzytkownika.
9. Petle minorowe:
   - kazda petla ma `reversal_field`, `return_field`, `parent_branch_id`,
     `minor_loop_id` i polityke zamkniecia,
   - start petli minorowej moze byc z major branch, z virgin curve albo z
     checkpointu,
   - metryki obejmuja recoil susceptibility, minor-loop area, closure error,
     irreversible jump candidates i return-point-memory diagnostics,
   - punkty petli minorowej nie moga byc mieszane z major-loop koercja bez
     jawnego wyboru widoku/metody.
10. Harmonogram: `field_values`, `min`, `max`, `step`, `piecewise_segments`,
   `branch_mode`, `minor_loops`, `return_to_start`, `include_turning_points`,
   `adaptive_refinement`.
   `piecewise_segments` to jawnie zaprojektowane przez uzytkownika przedzialy
   pola z roznymi krokami, np. duzy krok daleko od interesujacego obszaru i
   maly krok przy remanencji, koercji, reversal fields albo oczekiwanym
   przelaczeniu. To nie jest to samo co `adaptive_refinement`: piecewise jest
   requested intent, adaptive refinement jest opcjonalna decyzja planera/runtime
   dodajaca punkty po analizie wynikow.
11. Per-point solve: kazdy punkt pola ustawia `H_i`, kontynuuje z poprzedniej
   magnetyzacji w tej samej galezi i wykonuje settle wedlug jawnej polityki.
   Potencjal/stan solvera demagnetyzacji (np. hypre cache) jest warm-startowany
   pomiedzy kolejnymi punktami pola dla optymalizacji wydajnosci.
12. `settle_pipeline`: sekwencja algorytmow dochodzenia do stanu
    metastabilnego w kazdym punkcie pola. Kazdy krok pipeline ma:
   - `algorithm_kind`: `relax`, `minimize`, `dynamics_settle`,
     `custom_backend_method`,
   - `method`: np. `llg_overdamped`, `projected_gradient_bb`,
     `nonlinear_cg`, `tangent_plane_implicit`, `heun_dynamics_settle`,
   - pelne parametry metody: `alpha`, `dt`, `dt_min`, `max_steps`,
     `max_pseudotime_s`, `max_physical_time_s`, line-search params,
     damping, preconditioner/solver hints, tolerancje torque/energy/error,
   - `stop`: lista kryteriow `any_of` albo `all_of`,
   - `on_non_convergence`: `continue_with_warning | stop_stage |
     run_next_algorithm | retry_with_smaller_dt`,
   - `applies_to`: `all_points | preparation | major | minor | saturation_probe |
     key_events_only | branch_id`,
   - provenance parametrow rozstrzygnietych przez planner/backend.
13. Drzewo algorytmow: pipeline moze byc liniowe albo warunkowe:
   - przyklad liniowy: `minimize(projected_gradient_bb) -> relax(llg_overdamped)`,
   - przyklad fallback: `relax(large_dt)` jesli niezbieznosc, potem
     `relax(smaller_dt)`,
   - przyklad selektywny: szybki relax dla zwyklych punktow, dokladny minimize
     dla reversal fields i key events.
   To drzewo jest czescia eksperymentu. Zmiana parametrow pipeline zmienia
   wynik histerezy i musi byc zapisana w provenance.
14. Dynamiczna vs quasistatyczna histereza: domyslny protokol jest
   quasistatyczny i wymaga settle per punkt. Dynamiczny protokol ze sweep rate
   polem `dH/dt` jest osobnym trybem, bo koercja zalezy wtedy od szybkosci
   wymuszenia, tlumienia, temperatury i integratora.
15. Obserwable:
   - `m_avg` liczone jako srednia wazona momentem magnetycznym (lokalnym M_s)
     dla ukladow wielomaterialowych (multi-region):
     m_avg = \int(M_s * m dV) / \int(M_s dV),
   - `m_parallel = m_avg dot u_H`,
   - `m_oop = m_avg dot n_sample`,
   - `m_ip = sqrt(m_avg_x_sample^2 + m_avg_y_sample^2)` albo projekcja na
     wybrany azymut in-plane,
   - `m_transverse = m_avg - m_parallel u_H`,
   - energie: Zeeman (`E_zeeman`), calkowita (`E_total`), wymiany (`E_ex`),
     demagnetyzacji (`E_demag`), anisotropy (`E_ani`), DMI (`E_dmi`),
   - torque/error/convergence per punkt.
16. Metryki:
   - remanencja `M_r+` i `M_r-` przez interpolacje przy `H = 0` na odpowiednich galeziach,
   - koercja `H_c+` i `H_c-` przez interpolacje zera `m_parallel = 0`,
   - przesuniecie petli (exchange bias): H_eb = (H_c+ + H_c-) / 2,
   - wlasciwe pole koercji: H_c = (H_c+ - H_c-) / 2 (gdzie H_c+ > 0, H_c- < 0),
   - pole przelaczenia przez szczyt podatnosci rozniczkowej `dm_parallel / dH`,
   - pole powierzchni petli (dysypacja energii) przez branch-aware calkowanie trapezami
     zamknietego cyklu, z ostrzezeniem jesli cykl nie jest zamkniety,
   - podatnosc rozniczkowa `dm_parallel / dH` filtrowana (np. Savitzky-Golay) dla wyeliminowania
     szumow dyskretyzacji siatki,
   - ostrzezenia dla petli nienasyconej albo bez przeciecia zera.
17. Adaptacyjne zagęszczanie pola:
   - podstawowy krok pola moze byc staly,
   - jawne zageszczanie przez uzytkownika jest modelowane przez
     `piecewise_segments`: kazdy przedzial ma `start`, `stop`, `step`,
     `label`, `endpoint_policy` i opcjonalny `reason`, np. `coarse_start`,
     `dense_after_remanence`, `dense_expected_coercivity`;
   - `piecewise_segments` musza pozostac czescia requested intent i nie moga
     byc przepisywane przez runtime na anonimowa liste punktow bez provenance,
   - opcjonalny refine pass dodaje punkty w okolicach duzych `dm/dH`,
     przeciec `m_parallel = 0`, reversal fields i eventow niezbieznosci,
   - refine pass musi zapisac, ktore punkty byly planowane od poczatku, a
     ktore zostaly dodane adaptacyjnie.
18. FDM/FEM interpretacja: te same wielkosci publiczne, inne realizacje
   siatki i snapshotow.
19. CPU/GPU interpretacja: snapshot pelnego pola moze wymuszac kosztowny sync,
   dlatego jest osobna polityka storage. Obowiazkowa sciezka produkcyjna dla
   playbacku histerezy zapisuje `m`; dodatkowe pola diagnostyczne typu
   `H_demag` i `H_eff` sa opcjonalne, wylaczone domyslnie, nie sa bramka
   produkcyjna dla playbacku i musza miec osobny koszt/provenance.
20. Walidacja: makrospin/Stoner-Wohlfarth dla roznych katow pola,
    prosty uniaxialny element, OOP thin film, in-plane strip, symetria petli
    dla ukladow symetrycznych, testy interpolacji koercji, testy auto-saturacji
    i testy minor-loop closure.
21. Szybki smoke-test runtime: maly waveguide `300 x 50 x 10 nm` w airboxie
    `1000 x 200 x 100 nm`, z rzadkim meshem i skroconym harmonogramem pola,
    jest utrzymywany jako regresyjny test petli histerezy. Skrypt:
    `examples/hysteresis_waveguide_300x50x10nm.py`, target:
    `just run-hysteresis-waveguide-smoke cpu`. Test ma potwierdzac, ze runtime
    zapisuje `hysteresis_points.json`, a punkty zawieraja osobne skladowe
    `m_avg = [mx, my, mz]` oraz spojne wartosci `m_parallel`, `m_oop` i
    `m_ip` uzywane przez wykresy. Wariant playback:
    `just run-hysteresis-waveguide-playback-smoke cpu` wlacza
    `storage.magnetization="every_step"` i musi zapisac natywny kontener
    `hysteresis.zarr/fields/m`; wynik sprawdza
    `just verify-hysteresis-playback-artifacts <artifact-dir>`.

## Faza 1: publiczny model authoringu

### Python DSL

Dodac stage wyzszego poziomu, bez usuwania obecnego
`add_hysteresis_branch(...)`:

```python
study.stages.add_hysteresis_sweep(
    field_min_mT=-100.0,
    field_max_mT=100.0,
    field_step_mT=5.0,
    orientation=fm.FieldOrientation.preset("oop_positive"),
    measurement_axis="field_axis",
    initial_protocol="positive_saturation",
    saturation=fm.SaturationProbe(
        mode="auto",
        max_field_mT=300.0,
        susceptibility_threshold=1e-3,
        transverse_threshold=1e-2,
    ),
    branch_mode="major_loop",
    settle_pipeline=fm.SettlePipeline([
        fm.MinimizeStep(
            method="projected_gradient_bb",
            torque_tolerance=5e-5,
            energy_tolerance=1e-20,
            max_steps=2000,
            on_non_convergence="run_next_algorithm",
        ),
        fm.RelaxStep(
            method="llg_overdamped",
            alpha=1.0,
            torque_tolerance=1e-5,
            max_steps=10000,
            on_non_convergence="continue_with_warning",
        ),
    ]),
    storage=fm.HysteresisStorage(
        scalar_history=True,
        magnetization="selected",  # none | selected | every_n | every_step | key_events
        every_n=5,
        key_events=True,
        key_event_threshold_dm=0.02,
    ),
)
```

Wariant z drzewem/fallbackiem algorytmow:

```python
study.stages.add_hysteresis_sweep(
    field_min_mT=-120.0,
    field_max_mT=120.0,
    field_step_mT=4.0,
    orientation=fm.FieldOrientation.preset("oop_positive"),
    initial_protocol="positive_saturation",
    branch_mode="major_loop",
    settle_pipeline=fm.SettleTree(
        default=fm.RelaxStep(
            method="llg_overdamped",
            alpha=0.8,
            dt="auto",
            torque_tolerance=2e-5,
            max_steps=5000,
        ),
        branches=[
            fm.SettleBranch(
                when="non_converged",
                run=fm.RelaxStep(
                    method="llg_overdamped",
                    alpha=1.0,
                    dt=1e-14,
                    torque_tolerance=1e-5,
                    max_steps=12000,
                ),
            ),
            fm.SettleBranch(
                when="key_event",
                run=fm.MinimizeStep(
                    method="nonlinear_cg",
                    torque_tolerance=5e-6,
                    max_steps=20000,
                ),
            ),
        ],
    ),
)
```

Wariant in-plane pod dowolnym katem:

```python
study.stages.add_hysteresis_sweep(
    field_min_mT=-80.0,
    field_max_mT=80.0,
    field_step_mT=2.0,
    orientation=fm.FieldOrientation.sample(theta_deg=90.0, phi_deg=35.0),
    measurement_axis="field_axis",
    initial_protocol="zero_field_relaxed",
    branch_mode="virgin_then_major_loop",
)
```

Wariant z jawnym zageszczeniem krokow pola:

```python
study.stages.add_h ysteresis_sweep(
    orientation=fm.FieldOrientation.preset("oop_positive"),
    initial_protocol="positive_saturation",
    branch_mode="major_loop",
    field_schedule=fm.PiecewiseFieldSchedule.mT([
        fm.FieldSegment(start=120.0, stop=20.0, step=-10.0, label="coarse_positive"),
        fm.FieldSegment(start=20.0, stop=-20.0, step=-1.0, label="dense_remanence"),
        fm.FieldSegment(start=-20.0, stop=-120.0, step=-5.0, label="negative_branch"),
        fm.FieldSegment(start=-120.0, stop=120.0, step=5.0, label="return_branch"),
    ]),
)
```

Wariant z semantycznym oknem zageszczenia:

```python
study.stages.add_hysteresis_sweep(
    field_min_mT=-150.0,
    field_max_mT=150.0,
    field_step_mT=10.0,
    schedule_refinements=[
        fm.FieldWindow(center_mT=0.0, half_width_mT=25.0, step_mT=1.0, reason="remanence"),
        fm.FieldWindow(center_mT=-45.0, half_width_mT=10.0, step_mT=0.5, reason="expected_coercivity"),
    ],
)
```

Wariant jawny:

```python
study.stages.add_hysteresis_sweep(
    field_values_mT=[100, 80, 60, 40, 20, 0, -20, -40, -60, -80, -100],
    direction=(1, 0, 0),
    branch_id="descending",
)
```

Wariant minor loops:

```python
study.stages.add_hysteresis_sweep(
    orientation=fm.FieldOrientation.preset("in_plane_x"),
    initial_protocol="positive_saturation",
    branch_mode="major_with_minor_loops",
    field_max_mT=120.0,
    field_min_mT=-120.0,
    field_step_mT=4.0,
    minor_loops=[
        fm.MinorLoop(reversal_mT=40.0, return_mT=100.0),
        fm.MinorLoop(reversal_mT=0.0, return_mT=100.0),
        fm.MinorLoop(reversal_mT=-40.0, return_mT=100.0),
    ],
)
```

Zasady:

- obecne `add_hysteresis_branch(...)` zostaje jako kompatybilny helper,
- nowy helper emituje kanoniczny stage histerezy, a nie liste anonimowych
  relaksacji na poziomie publicznego modelu,
- eksport z UI do Pythona musi uzywac nowego helpera,
- jezeli stage zostanie rozwiniety do etapow wykonawczych, provenance musi
  zachowac oryginalny stage histerezy.
- `settle=` jako pojedynczy `RelaxStop` moze zostac kompatybilnym aliasem,
  ale canonical export powinien emitowac `settle_pipeline`.
- `settle_pipeline` musi byc w pelni round-tripowalny: UI -> SceneDocument ->
  Python export -> ProblemIR -> provenance.
- `direction=(...)` zostaje obslugiwane jako prosty alias, ale canonical export
  powinien uzywac `FieldOrientation`, bo OOP/IP/custom angle potrzebuja ramy
  odniesienia i jednostek kata.
- `initial_protocol` musi byc jawny w eksporcie, nawet jezeli UI pokazuje
  wygodny default.

### UI authoring

Inspektor stage ma dostac tryb planowania:

- `Protocol`: virgin curve, major loop od dodatniej saturacji, major loop od
  ujemnej saturacji, start z aktualnego stanu, start z checkpointu, minor loop
  set, custom schedule,
- `Orientation`: OOP, IP-x, IP-y, custom `theta/phi`, custom vector, frame
  `sample | global | object | easy_axis`,
- `Field range`: min, max, step, display unit `mT | T | A/m`,
- `Piecewise schedule`: tabela przedzialow pola z kolumnami start, stop, step,
  label, branch/role, include endpoints. UI musi pokazywac liczbe punktow per
  segment, granice segmentow i ostrzezenia o duplikatach na laczeniach,
- `Dense windows`: szybki sposob dodania okien zageszczenia wokol `H=0`,
  spodziewanej koercji, reversal field albo recznie wybranego pola,
- `Saturation`: manualne limity pola albo auto-detect `H_sat+/-` z limitem
  probe field, progami i polityka potwierdzenia,
- `Direction`: legacy preset `x/y/z`, odwrocenie znaku, wektor niestandardowy,
- `Branch`: ascending, descending, major loop, minor loop, custom values,
- `Minor loops`: lista reversal/return fields, parent branch, closed/open
  loop policy, preview recoil branches,
- `Settle pipeline`: drzewo algorytmow per punkt pola. UI musi pozwolic
  dodawac, usuwac i przestawiac kroki `Relax`, `Minimize`, `Dynamics settle`,
  ustawic parametry kazdego kroku, warunki stopu, warunki fallbacku oraz
  zakres stosowania (`all points`, `saturation probe`, `major`, `minor`,
  `key events`, wybrana galaz),
- `Storage`: srednie zawsze, pelna magnetyzacja `none | selected | every_n |
  every_step | key_events`,
- `Preview`: rysunek sciezki pola z oznaczonymi punktami, punktami zwrotnymi,
  galeziami minor loops, punktami auto-saturation probe i szacowanym kosztem
  storage.

UI nie powinno pytac uzytkownika o implementacyjne szczegoly typu nazwy plikow
CUDA albo struktury buforow. Moze pokazac szacunek: liczba punktow, liczba
snapshotow, przewidywany rozmiar danych i ostrzezenie przy `every_step`.

Domysl dla profesjonalnego UI:

- dla major loop: proponuj `positive_saturation -> max -> min -> max`,
- dla virgin curve: pokaz ostrzezenie, ze to nie jest pelna major loop i nie
  wolno z niej raportowac tej samej koercji bez opisu protokolu,
- dla custom angle: pokaz probke z normalna, wektor pola i projekcje
  `m_parallel`, `m_oop`, `m_ip`,
- dla auto-saturation: przed startem uruchom albo zaplanuj krotki probe pass,
  a po nim pokaz `H_sat` i pozwol zaakceptowac albo nadpisac zakres.

## Faza 2: ProblemIR i planner

Dodac albo rozszerzyc `StudyStageIR::Hysteresis`:

```text
HysteresisStageIR {
  stage_id,
  protocol_kind,         # virgin_curve | major_loop | minor_loop_set | forc_family | custom
  initial_state_policy,  # as_authored | zero_field_relaxed | positive_saturation | negative_saturation | checkpoint
  field_orientation,     # sample theta/phi, global vector, object frame, or easy-axis frame
  measurement_axis,
  field_schedule,
  saturation_policy,
  minor_loop_policy,
  field_unit_provenance,
  direction_unit,
  branch_mode,
  settle_pipeline,       # ordered/conditional relax-minimize-dynamics tree
  continuation_policy,   # consecutive, external reset, or branching for FORC
  storage_policy,        # includes key_event_threshold_dm
  observable_policy,     # includes Zeeman and moment-weighted averages options
  requested_backend_hints,
}
```

`field_schedule` po normalizacji ma zawierac jawne punkty:

```text
HysteresisPoint {
  point_id,
  branch_id,
  branch_index,
  global_index,
  segment_id,
  segment_label,
  amplitude_A_per_m,
  display_amplitude,
  field_vector_A_per_m,
  turning_point,
  protocol_role,         # preparation | virgin | major | recoil | minor | forc
  reversal_field_A_per_m,
  parent_branch_id,
  minor_loop_id,
  adaptive_inserted,
}
```

`settle_pipeline` po normalizacji:

```text
SettlePipelineIR {
  mode,                  # sequence | tree
  default_steps,
  conditional_branches,
  warm_start_policy,
  resolved_defaults,
}

SettleAlgorithmStepIR {
  step_id,
  algorithm_kind,        # relax | minimize | dynamics_settle | custom_backend_method
  method,
  parameters,
  stop_criteria,
  applies_to,
  on_non_convergence,
  retry_policy,
  backend_hints,
}

SettleConditionIR {
  when,                  # non_converged | key_event | branch_role | point_role | metric_threshold
  expression,
  run_steps,
}
```

Walidacja:

- `direction` nie moze byc zerowy,
- `field_orientation` musi byc normalizowalne do jednego wektora pola i jednej
  ramy odniesienia,
- `theta/phi` wymagaja jawnie zdefiniowanej normalnej probki albo ramy sample,
- OOP/IP/custom angle musza zapisac zarowno parametry kata, jak i wynikowy
  wektor `u_H`, zeby eksport i runtime byly odtwarzalne,
- `measurement_axis` musi wskazywac znana os albo jawny wektor,
- krok nie moze byc zerowy,
- znak kroku musi pasowac do min/max albo normalizer musi go jednoznacznie
  naprawic i zapisac ostrzezenie,
- `piecewise_segments` musza miec niezerowy krok, zgodny znak kroku,
  jednoznaczna kolejnosc i stabilne `segment_id`,
- punkty na laczeniach segmentow musza byc deduplikowane wedlug jawnej polityki
  `include_start/include_stop`, z warningiem jezeli uzytkownik tworzy duplikat,
- `schedule_refinements` nie moga tworzyc sprzecznych krokow dla tego samego
  zakresu bez priority/order policy,
- segmenty moga sie nakladac tylko wtedy, gdy maja jawna `priority`; w innym
  przypadku walidacja odrzuca plan,
- `initial_state_policy=positive_saturation` wymaga manualnego pola saturacji
  albo `saturation_policy=auto`,
- `zero_field_relaxed` i `virgin_curve` musza zapisac, czy stan poczatkowy byl
  authored, random, uniform, checkpoint czy demagnetized-like,
- `minor_loop_policy` wymaga reversal/return fields w zakresie parent branch,
  unikalnych `minor_loop_id` i jawnego parent branch,
- `settle_pipeline` nie moze byc puste,
- kazdy krok `settle_pipeline` musi miec znany `algorithm_kind`, `method`,
  parametry zgodne z metoda i przynajmniej jedno kryterium stopu,
- `applies_to` musi wskazywac istniejaca role/galez albo `all_points`,
- `run_next_algorithm` jest legalne tylko wtedy, gdy istnieje nastepny krok
  albo branch fallback,
- `retry_with_smaller_dt` wymaga parametru `dt` albo `dt_policy`,
- parametry relax/minimize/dynamics musza byc walidowane wedlug ich publicznego
  kontraktu, nie jako luźny JSON bez semantyki,
- liczba punktow musi miec limit planera,
- `every_step` musi przejsc przez storage estimate gate,
- `major_loop` nie moze mieszac galezi bez branch metadata,
- `minor_loop` nie moze byc agregowany do metryk major loop bez jawnej
  metody agregacji,
- `field_values` nie moze byc puste,
- jednostki musza byc jednoznaczne,
- snapshot magnetyzacji musi byc legalny dla aktualnej topologii siatki i
  backendu.

Planner ma rozstrzygnac:

- faktyczna lista punktow i galezi,
- rozwiniety harmonogram piecewise z mapowaniem punkt -> segment,
- summary segmentow: liczba punktow, zakres, krok, label, warnings,
- wynikowy wektor pola dla OOP/IP/custom angle,
- etapy przygotowania stanu: zero-field relax, saturating pre-run,
  checkpoint load albo custom initial state,
- settle pipeline dla kazdego `protocol_role` i `branch_id`,
- resolved algorithm defaults, np. `dt=auto`, domyslny `alpha`, backend solver
  hints, preconditioner i kryteria stopu,
- czy auto-saturation probe jest wymagany przed wlasciwa petla,
- wynik auto-saturation: `H_sat+`, `H_sat-`, status i ostrzezenia,
- harmonogram minor loops i recoil branches,
- czy potrzebny jest adaptive refinement i gdzie mozna dodac punkty,
- czy backend wspiera stateful continuation miedzy punktami,
- czy snapshoty beda pisane natywnie, przez artifact pipeline, czy tylko jako
  average-only,
- koszt sync CPU/GPU dla pelnych snapshotow,
- data products: scalar table, hysteresis points, metrics, optional field
  snapshot manifest.

## Faza 3: runtime wykonania

Runtime powinien wykonywac stage jako jeden workflow:

1. przygotuj schedule i branch context,
2. przygotuj stan poczatkowy wedlug `initial_state_policy`,
3. jezeli `saturation_policy=auto`, wykonaj probe saturacji, zapisz wynik i
   dopiero potem zatwierdz wlasciwy schedule,
4. dla kazdego punktu:
   - ustaw `H_ext`,
   - kontynuuj z poprzedniego stanu tej samej galezi,
   - wybierz kroki `settle_pipeline` dla `protocol_role`, branch id i point id,
   - uruchom kolejne `relax/minimize/dynamics_settle` zgodnie z drzewem
     algorytmow, warunkami stopu i fallbackami,
   - policz `m_avg`, `m_parallel`, energie i metryki zbieznosci,
   - dopisz punkt do scalar/history table,
   - opcjonalnie zapisz pelny snapshot magnetyzacji,
   - opublikuj invalidacje zasobow,
5. po galezi policz metryki galezi,
6. po kazdej petli minorowej policz metryki recoil/minor loop,
7. po petli major policz metryki globalne,
8. zachowaj checkpoint pozwalajacy wznowic od ostatniego zakonczonego punktu.

Status punktu:

```text
queued | running | settling | converged | saved | warning | failed | skipped
```

Kazdy punkt musi zachowac:

- `stage_id`, `point_id`, `branch_id`,
- `protocol_role`, `minor_loop_id`, `parent_branch_id` jezeli dotyczy,
- pole zadane i pole rozstrzygniete,
- orientacje pola, os pomiarowa i projekcje OOP/IP,
- `settle_trace`: lista uruchomionych algorytmow, parametrow rozstrzygnietych,
  liczby krokow, stop reason, fallback reason i convergence status,
- solver/backend/precision/device,
- kryterium stopu i wynik stopu,
- srednia magnetyzacje,
- referencje do snapshotow, jezeli istnieja,
- ostrzezenia, np. brak zbieznosci albo snapshot niedostepny.

Protokol auto-saturacji:

- probe pass nie jest ukrytym etapem: ma wlasne punkty, status, metryki i
  provenance,
- uzytkownik moze wybrac `accept_auto`, `rerun_with_manual_range` albo
  `continue_with_warning`,
- `H_sat` jest estymacja protokolowa, nie stala materialowa; zalezy od kata,
  geometrii, anisotropii, siatki, temperatury i kryteriow settle.

Petle minorowe:

- runtime musi umiec zapisac branch fork: start minor loop z konkretnego
  punktu parent branch,
- minor loop ma osobny closure status,
- powrot do parent branch nie moze nadpisac stanu parent branch bez jawnej
  polityki `resume_parent | replace_parent | branch_only`,
- FORC family powinna byc modelowana jako wiele recoil branches z osobnymi
  reversal fields, a nie jako jeden plaski loop.

Pause/stop/resume:

- `pause` konczy bezpiecznie po aktualnym punkcie albo po kontrolowanej
  granicy solvera,
- `stop` zachowuje juz policzone punkty i metryki czastkowe,
- `resume` startuje od kolejnego punktu, nie powtarza zakonczonych snapshotow
  bez jawnego `rerun`.

## Faza 4: v2 API i zasoby

Nie wpychac punktow histerezy do `sessions/current/status`. Status moze
pokazac tylko aktywny stage, revision i skrot. Dane naleza do osobnych
zasobow.

Nowe zasoby:

```text
GET /v2/sessions/current/simulation/stages/{stage_id}/hysteresis/plan
GET /v2/sessions/current/simulation/stages/{stage_id}/hysteresis/protocol
GET /v2/sessions/current/simulation/stages/{stage_id}/hysteresis/orientation
GET /v2/sessions/current/simulation/stages/{stage_id}/hysteresis/saturation
GET /v2/sessions/current/simulation/stages/{stage_id}/hysteresis/settle-pipeline
GET /v2/sessions/current/simulation/stages/{stage_id}/hysteresis/progress
GET /v2/sessions/current/simulation/stages/{stage_id}/hysteresis/execution-tree?window=active&before=2&after=3
GET /v2/sessions/current/analysis/hysteresis/{stage_id}/points
GET /v2/sessions/current/analysis/hysteresis/{stage_id}/metrics
GET /v2/sessions/current/analysis/hysteresis/{stage_id}/branches
GET /v2/sessions/current/analysis/hysteresis/{stage_id}/minor-loops
GET /v2/sessions/current/analysis/hysteresis/{stage_id}/reversal-fields
GET /v2/sessions/current/analysis/hysteresis/{stage_id}/steps/{point_id}
GET /v2/sessions/current/analysis/hysteresis/{stage_id}/steps/{point_id}/settle-trace
GET /v2/sessions/current/data/fields/m/meta?snapshot_id={snapshot_id}
GET /v2/sessions/current/data/fields/m/samples/vector?snapshot_id={snapshot_id}&format=bin
```

Decyzja wykonawcza: `analysis/hysteresis/*` jest wlascicielem planu, punktow,
galezi, metryk i indeksu snapshotow. Ciezki payload magnetyzacji pozostaje w
istniejacej rodzinie `data/fields`, parametryzowanej przez `snapshot_id`.
Nie dodawac rownoleglej publicznej rodziny endpointow dla snapshotow pol,
dopoki `data/fields` moze jednoznacznie obsluzyc snapshot wynikowy. Komponenty
React nie moga skladac recznie endpointow poza klientem API.

Realtime:

```text
simulation.stage.hysteresis.plan_updated
simulation.stage.hysteresis.protocol_updated
simulation.stage.hysteresis.saturation_probe_updated
simulation.stage.hysteresis.settle_pipeline_updated
simulation.stage.hysteresis.execution_tree_updated
simulation.stage.hysteresis.point_completed
analysis.hysteresis.settle_trace_updated
analysis.hysteresis.minor_loop_updated
analysis.hysteresis.points_updated
analysis.hysteresis.metrics_updated
data.field_snapshot.published
```

Eventy maja invalidowac zasoby, nie niesc ciezkich payloadow.

## Faza 5: artifacty i storage

Rozdzielic trzy klasy danych:

1. Scalar history: zawsze zapisywane, tanie.
2. Hysteresis analysis dataset: punkty, galezie, metryki, provenance,
   indeks snapshotow.
3. Pelne pola magnetyzacji: opcjonalne, ciezkie, odczytywane przez data plane.

Polityki storage:

```text
averages_only
selected_points
every_n_points
key_events
every_step
```

`key_events` sa detektowane przy uzyciu lokalnego kryterium dynamicznego w celu optymalizacji
zapisu i pamieci (brak koniecznosci buforowania calej petli wstecz). Punkt jest zapisywany gdy:

- jest punktem zwrotnym (turning point) lub H = 0 (znane a priori),
- jest punktem auto-saturation probe oznaczonym jako `H_sat+` albo `H_sat-`,
- jest reversal field albo return field petli minorowej,
- lokalny skok magnetyzacji przekracza prog: |m_avg_i - m_avg_{i-1}| > key_event_threshold_dm,
- lokalna podatnosc `dm/dH` przekracza prog przelaczenia,
- wystapilo ostrzezenie o braku zbieznosci (warning),
- punkt zostal recznie oznaczony jako bookmark w UI.

Storage estimate:

```text
bytes ~= point_count_saved * site_count * 3 * sizeof(component)
```

Dla FEM trzeba jawnie liczyc wedlug liczby wezlow/elementow i reprezentacji
pola. Dla FDM wedlug komorek/layerow. UI ma pokazac rozmiar przed startem.

Retention:

- `keep_all` tylko jako jawna decyzja,
- `keep_key_events` jako bezpieczny default,
- `cleanup_unsaved_intermediate` po zakonczeniu workflow,
- kazdy cleanup musi zostawic scalar history i analysis dataset.

## Faza 6: inspektor histerezy

Docelowy `HysteresisStageInspector` powinien miec sekcje:

### Plan

- nazwa stage,
- tryb: virgin curve, galaz, major loop, minor loop, FORC family, custom list,
- protokol startu: as-authored, zero-field relaxed, positive saturation,
  negative saturation, checkpoint,
- min/max/step lub tabela punktow,
- orientacja pola: OOP, IP-x, IP-y, custom theta/phi, custom vector, frame,
- os pomiarowa: field axis, sample normal, easy axis, custom,
- jednostka wyswietlania,
- liczba punktow i galezi,
- preview sciezki pola.

### Saturation

- manualne `H_max/H_min` albo auto-detect,
- limity probe field,
- progi: susceptibility, transverse component, torque/error,
- status `H_sat+` i `H_sat-`,
- lista punktow proby,
- akcje `Accept`, `Override`, `Continue with warning`, `Rerun probe`.

### Minor Loops

- lista petli z reversal field i return field,
- parent branch i punkt startu,
- closed/open loop policy,
- closure error,
- recoil susceptibility,
- return-point-memory diagnostics,
- warning, jezeli minor loop jest mylony z major-loop metrykami.

### Settle

- drzewo algorytmow `settle_pipeline`,
- lista krokow `Relax`, `Minimize`, `Dynamics settle`,
- metoda kazdego kroku, np. `llg_overdamped`, `projected_gradient_bb`,
  `nonlinear_cg`, `tangent_plane_implicit`,
- parametry kazdego kroku: alpha, dt/dt policy, tolerancje torque/energy/error,
  max steps, max pseudotime, max physical time, solver/preconditioner hints,
- `applies_to` per krok: all points, preparation, saturation probe, major,
  minor, key events, branch id,
- warunki stopu `all_of/any_of`,
- fallback policy: run next algorithm, stop stage, continue with warning,
  retry with smaller dt,
- continuation policy,
- status zgodnosci backendu.
- resolved defaults po planowaniu: jezeli UI ustawilo `auto`, inspector pokazuje
  wartosc rozstrzygnieta przez planner/runtime.

### Settle Trace

- dla aktywnego albo wybranego punktu pokaz liste faktycznie uruchomionych
  algorytmow,
- liczbe krokow/iteracji kazdego algorytmu,
- stop reason,
- czy fallback zostal uruchomiony,
- final torque/error/energy delta,
- warning, jezeli metryki punktu pochodza z niezbieznosci.

### Storage

- scalar history: always on,
- magnetization snapshots: none/selected/every N/key events/every step,
- precision i format artifactu,
- storage estimate,
- ostrzezenia dla GPU sync i duzych siatek,
- lista auto-zapisywanych typow punktow.

### Live

- aktualna galaz,
- aktualny punkt,
- aktualne pole,
- postep per galaz i globalny,
- ostatni stop reason,
- torque/error/energy delta,
- czy snapshot dla punktu zostal zapisany.

### Metrics

- protokol pomiaru i initial-state provenance,
- `H_sat+`, `H_sat-` i status saturacji,
- `H_c+`, `H_c-` (indywidualne pola koercji),
- `H_c` (wlasciwe pole koercji: (H_c+ - H_c-) / 2),
- `H_eb` (exchange bias: (H_c+ + H_c-) / 2),
- `M_r+`, `M_r-` (remanencja),
- `M_oop`, `M_ip`, `M_parallel` summary dla wybranej osi,
- saturation estimate (estymacja nasycenia),
- loop area (pole powierzchni petli - calka strat energii),
- max differential susceptibility (maksymalna podatnosc rozniczkowa),
- switching field candidates (kandydaci na pole przelaczenia na podstawie pochodnej),
- minor-loop area i recoil susceptibility,
- closure error dla petli minorowych,
- convergence quality summary,
- ostrzezenia: brak przeciecia zera, petla nienasycona, za malo punktow,
  rozne kryteria zbieznosci na galeziach, brak potwierdzonej saturacji.

### Points

Tabela punktow:

```text
point | role | branch | H | angle | m_parallel | m_oop | m_ip | m_x | m_y | m_z | status | snapshot | actions
```

Akcje:

- `Load in 3D`,
- `Compare to current`,
- `Bookmark`,
- `Export point`,
- `Use as initial state`.

`Load in 3D` jest read-only. `Use as initial state` jest oddzielna komenda,
bo zmienia model/stage kontynuacji.

## Faza 7: wykresy i analiza

Modul charts/analysis powinien dostac `HysteresisChart` jako konsument
zasobow `analysis/hysteresis/*`.

Tryby widoku:

- `Virgin` (krzywa pierwszego namagnesowania),
- `Forward` (galaz wznoszaca),
- `Return` (galaz opadajaca),
- `Minor loops` (wybrane albo wszystkie petle minorowe),
- `FORC family` (rozszerzenie po wdrozeniu wielu recoil branches),
- `Full loop` (pelna petla),
- `RGB overlay` (komponenty m_x, m_y, m_z oznaczone kolorami czerwonym, zielonym i niebieskim na jednym wykresie),
- `OOP/IP overlay` (`m_oop`, `m_ip`, `m_parallel`),
- `Angular family` (porownanie petli dla wielu katow, gdy stage otacza angle sweep),
- `Branches side-by-side` (porownanie galezi),
- `Compact branch index`,
- `Physical H axis` (przelaczanie osi pomiedzy H w A/m a B_ext w T/mT).

Branch-aware rendering jest czescia danych: punkty maja `branch_id`,
`branch_direction`, `global_index`, `branch_index` i `turning_point`.

Wykres live:

- dopisuje punkt po `point_completed`,
- nie interpoluje jeszcze niepoliczonych punktow jako danych,
- moze pokazywac planowane punkty jako osobna warstwe preview,
- markery koercji/remanencji pojawiaja sie dopiero gdy sa policzalne,
- tooltip pokazuje H, m_parallel, m_avg, składowe wektora m, energie (w tym Zeeman), torque, stop reason,
  snapshot availability, protokol, role punktu i kat pola.

Dodatki naukowe:

- automatyczne wykrywanie przeciec zera z metoda interpolacji liniowej lub spline,
- lokalna podatnosc `dm/dH` jako drugi panel z zastosowaniem wygładzania numerycznego (np. filtr Savitzky-Golay),
- osobne markery dla `H_sat`, reversal fields, return fields i adaptive refinement points,
- minor-loop area i closure error jako overlay na wybranej petli,
- wykres `H_c(theta)` i `M_r(theta)` dla serii katowych,
- heatmapa statusu zbieznosci punktow,
- porownanie dwoch petli z roznych runow,
- overlay temperatury/pradu/parametru, jezeli przyszly parameter sweep otoczy
  histereze,
- eksport CSV/JSON z pelnym provenance i branch metadata.

## Faza 8: ladowanie punktu do 3D viewport i interaktywna analiza

Wczytanie magnetyzacji z punktu histerezy musi isc przez zasoby danych, nie
przez lokalna mutacje komponentu viewport.

Proponowany przeplyw:

1. Uzytkownik wybiera punkt w tabeli, na wykresie lub za pomoca suwaka pętli (scrubbera).
2. Komenda `hysteresis.load-point-in-3d` zapisuje selection/resource target:

```text
result_target = hysteresis-step:{stage_id}:{point_id}
quantity = m
snapshot_id = ...
mesh_identity = ...
field_revision = ...
field_orientation = sample(theta, phi) | global(vector) | object(frame)
measurement_axis = ...
```

3. `viewport-3d` pobiera topologie z aktualnego mesh resource i pole przez
   `data/fields/m/samples/vector?snapshot_id=...`.
4. Viewport renderuje wynik jako read-only result layer.
5. W viewport-3d stosowana jest legenda kołowa HSL (magnetic color wheel) dla szybkiej
   identyfikacji domen in-plane oraz poziomu out-of-plane.
6. Viewport pokazuje opcjonalny glyph kierunku pola `H`, normalna probki oraz
   os pomiaru. Dla OOP/IP/custom angle jest to wymagane, bo bez tego obraz 3D
   nie mowi, wzgledem czego liczono `m_parallel`.
7. Inspector pokazuje, ze ogladany stan jest snapshotem wyniku, a nie
   aktualnym authored initial magnetization.

Interaktywna nawigacja (kluczowa cecha naukowa):

- **Loop Scrubber / Nawigacja klawiatura**: Uzytkownik moze plynnie przechodzic pomiedzy punktami
  pętli za pomoca suwaka pod wykresem lub klawiszy strzalek (lewo/prawo) po aktywacji wykresu.
  Zapewnia to natychmiastowe ladowanie kolejnych snapshotow w 3D i umozliwia analize dynamiki
  nucleacji domen i ruchu scianek domeny w zaleznosci od przylozonego pola.

Warunki bezpieczenstwa:

- snapshot musi miec `mesh_identity` zgodne z aktualna topologia,
- snapshot musi miec zgodne `field_orientation` i `measurement_axis`
  w provenance,
- jezeli mesh sie zmienil, UI pokazuje blokade albo wymaga jawnego remap,
- field data i topology data maja osobne revision,
- viewport nie moze trzymac snapshotow bez cleanupu GPU resources,
- browser smoke dla tej funkcji musi potwierdzac niepusty canvas i nieutracony
  WebGL context.

Przyszle rozszerzenie:

- animacja petli jako automatyczne odtwarzanie snapshotow (play/pause),
- compare mode przez roznice albo side-by-side analysis, ale bez wielu
  niekontrolowanych WebGL canvasow.

## Faza 9: Explorer, ribbon i komendy

Explorer:

```text
Study
  Hysteresis <stage>
    Plan
    Protocol
    Saturation
    Live Run
    Branches
      Forward
      Return
      Minor Loops
    Points
    Metrics
    Snapshots
```

Explorer ma miec dwa tryby tego samego stage:

1. `Planned tree`: stabilne drzewo authoringu i planu przed startem.
2. `Live execution tree`: runtime tree, ktore zmienia sie wraz z aktualnym
   punktem pola, fallbackami i adaptacyjnymi punktami.

Przyklad live tree dla duzej petli. Explorer pokazuje okno aktywne, a nie
wszystkie punkty:

```text
Study
  Hysteresis 1
    Protocol: major loop from positive saturation
    Saturation
      Probe H = +0.30 T              done
    Field points
      Completed +1.000 T ... +0.990 T  6 points done
      H = +0.980 T                   active
        relax llg_overdamped         done
        minimize nonlinear_cg        active
      Next +0.970 T ... +0.950 T       3 points queued
      Bookmarks
        H = +1.000 T                   snapshot stored
        H = 0.000 T                    key event
    Minor loops
      Reversal H = -0.040 T          queued
    Transitions
      Continue to next stage         available after completion
      Use selected point as initial  explicit action
```

Zasady:

- Explorer nie renderuje wszystkich punktow pola dla duzych petli. Domyslnie
  renderuje dynamiczne okno: kilka punktow przed aktywnym, aktywny punkt,
  kilka punktow po aktywnym, plus summary ranges i bookmarki/key events,
- pelna lista punktow jest w `Points` table i `analysis-plots`, z paginacja,
  wirtualizacja albo range query; Explorer sluzy do nawigacji kontekstowej,
- wezel aktywnego pola jest tworzony z `HysteresisPoint.point_id`, nie z
  formatowanego tekstu `H = ...`; etykieta moze sie zmieniac, id nie,
- dzieci wezla pola sa resolved/faktycznie uruchomione kroki
  `settle_pipeline`: `relax`, `minimize`, `dynamics_settle`, fallback,
  snapshot i metryki punktu,
- statusy wezlow pochodza z `execution-tree` albo `settle-trace`, nie z
  lokalnego stanu Explorera,
- status visual mapping:
  - `done` -> semantic success token (zielony),
  - `active` -> semantic active/accent token,
  - `queued` -> neutral/muted token,
  - `conditional` -> pending/outlined token,
  - `warning` -> warning token,
  - `failed` -> error token,
  - `skipped` -> muted token,
- Explorer nie moze kodowac raw kolorow. Ma uzywac `--fm-*` tokenow i klas
  `fm-...`,
- aktywny punkt pola i aktywny algorytm aktualizuja sie live przez invalidacje
  `simulation.stage.hysteresis.execution_tree_updated`,
- jezeli fallback zmieni algorytm w trakcie punktu, Explorer dodaje/aktualizuje
  odpowiedni wezel z `fallback_reason`, a nie przepisuje historii,
- po zakonczeniu punktu wezel przechodzi do summary range, chyba ze jest
  aktywnie zaznaczony, ma snapshot, warning, key event albo bookmark,
- pelny audit trail zostaje w `Points`/`settle-trace` resources, nie jako
  nieograniczone drzewo Explorera,
- po zakonczeniu calej histerezy pojawia sie sekcja `Transitions`: kontynuacja
  do kolejnego stage, eksport, snapshoty, uzycie punktu jako initial state.

State ownership:

- dane drzewa live sa server resource snapshot z
  `simulation/stages/{stage_id}/hysteresis/execution-tree?window=active`,
- expanded/collapsed node ids i filtr widoku sa module-local state Explorera,
- selected node id jest kernel selection state,
- Inspector czyta szczegoly przez resource hooks po selection, nie przez import
  store Explorera.

Ribbon/commands:

- `study.add-hysteresis-stage`,
- `hysteresis.preview-plan`,
- `hysteresis.estimate-saturation`,
- `hysteresis.accept-saturation-estimate`,
- `hysteresis.override-saturation-field`,
- `hysteresis.add-minor-loop`,
- `hysteresis.remove-minor-loop`,
- `hysteresis.run`,
- `hysteresis.pause`,
- `hysteresis.stop`,
- `hysteresis.resume`,
- `hysteresis.load-point-in-3d`,
- `hysteresis.use-point-as-initial-state`,
- `hysteresis.export-loop-csv`,
- `hysteresis.export-snapshot`,
- `hysteresis.bookmark-point`.

Komendy ida przez command registry. Moduly nie importuja sie wzajemnie:
inspector odpala komende, charts ustawia cursor/selection, viewport konsumuje
resource target.

## Faza 10: backend lanes

FDM CPU:

- pierwsza referencyjna sciezka,
- najlatwiejsza walidacja snapshotow,
- testy makrospin/maly grid.
- referencyjna implementacja projekcji `m_parallel`, `m_oop`, `m_ip`,
  `H_sat` i minor-loop metrics.

FDM GPU:

- musi jawnie raportowac koszt snapshot sync,
- `every_step` ma byc ostrzegane dla duzych siatek,
- average-only moze dzialac bez pelnego host copy per punkt, jezeli backend ma
  metryki na urzadzeniu.
- auto-saturation nie moze wymuszac pelnego snapshotu na kazdym probe point,
  jezeli wystarczy redukcja `m_avg`, torque i energy metrics.

FEM CPU:

- snapshoty musza uzywac reprezentacji FEM zgodnej z `data/fields`,
- metryki sredniej magnetyzacji musza byc wazone objetoscia/miara elementow,
  nie prostym usrednieniem wezlow, jezeli fizyka tego wymaga.
- OOP/IP/custom angle musi byc liczony wzgledem sample/object frame, a nie
  indeksow wezlow albo przypadkowej orientacji mesh.

FEM GPU:

- zachowac ten sam publiczny kontrakt,
- data movement jest runtime decision/provenance, nie opcja UI pierwszego rzedu.
- reduction kernels albo host reductions musza miec ten sam kontrakt moment-
  weighted averages i projekcji osi co CPU.

## Faza 11: migracja z obecnego makra

Kroki migracyjne:

1. Zostawic `add_hysteresis_branch(...)` jako kompatybilny helper.
2. Dodac nowy canonical `hysteresis_sweep` stage.
3. CLI materializer moze tymczasowo rozwijac stage do relaksacji per punkt,
   ale stage execution i artifacty musza zachowac oryginalne `stage_id`.
4. UI draft ma przejsc z `startField/stopField/fieldSteps` na pelny model
   sweepu, ale czytac stare pola przy otwieraniu starszych scen.
5. Explorer i inspector musza rozpoznawac zarowno stary, jak i nowy payload.
6. Stare payloady bez protokolu mapowac na:
   - `protocol_kind="single_branch"` albo `major_loop` tylko jesli schedule
     faktycznie zawiera dwie galezie,
   - `initial_state_policy="as_authored"`,
   - `field_orientation=global(direction)`,
   - `measurement_axis="field_axis"`.
7. Po stabilizacji oznaczyc stare pola jako transitional w OpenAPI/spec.

## Faza 12: testy i walidacja

### Kontrakt i parsery

- Python DSL: `add_hysteresis_sweep` serializuje canonical stage.
- Python DSL: `add_hysteresis_branch` nadal dziala i mapuje sie do zgodnego
  kontraktu.
- ProblemIR: waliduje jednostki, kierunek, kat OOP/IP/custom, protokol startu,
  kroki, galezie, minor loops, auto-saturation, settle pipeline i storage
  policy.
- Planner: generuje dokladna liste punktow i branch metadata.
- Planner: generuje przygotowanie stanu dla zero-field/saturation/checkpoint.
- Planner: rozstrzyga `settle_pipeline`, defaults i applies-to dla kazdej roli
  punktu.

### Runtime

- fake solver z deterministyczna petla sprawdza kolejnosc punktow,
  continuation i metryki.
- fake solver sprawdza sekwencje `minimize -> relax`, fallback po
  non-convergence i selektywny algorytm dla key events.
- fake solver sprawdza `positive_saturation`, `negative_saturation`,
  `zero_field_relaxed` i `as_authored`.
- test auto-saturation probe dla `saturated`, `not_saturated` i
  `capped_by_limit`.
- test minor-loop fork/return/closure bez nadpisywania parent branch.
- test interpolacji koercji dla znanych par punktow.
- test braku koercji, gdy nie ma przeciecia zera.
- test pause/resume bez duplikacji punktow.
- test `averages_only` nie zapisuje pelnych pol.
- test `every_step` zapisuje snapshot dla kazdego punktu.

### API

- OpenAPI ma zasoby `analysis/hysteresis/*` i field snapshot resource.
- Realtime event invaliduje `analysis/hysteresis/{stage_id}/points`.
- API wystawia protocol/orientation/saturation/minor-loop resources bez
  inline'owania ich w status.
- Status pozostaje cienki i nie inline'uje punktow.
- Binary field snapshot endpoint zwraca zgodne shape/meta.

### Frontend

- authoring model round-trip UI -> scene -> draft,
- storage estimate dla FDM/FEM,
- UI authoring OOP/IP/custom angle round-trip,
- UI authoring start from zero/saturation/checkpoint round-trip,
- UI authoring settle pipeline/tree round-trip,
- UI settle trace render dla punktu,
- UI minor-loop editor generuje reversal/return fields i preview,
- auto-saturation result panel obsluguje accept/override/continue warning,
- inspector pokazuje plan/live/metrics/points,
- chart renderuje branch-aware `Forward`, `Return`, `Full loop`,
  `RGB overlay`, `Virgin` i `Minor loops`,
- klikniecie punktu odpala komende `load-point-in-3d`,
- viewport adapter pobiera snapshot po `snapshot_id`,
- viewport pokazuje glyph pola i os pomiaru dla custom angle,
- browser smoke potwierdza widoczny canvas i niepusty drawing buffer.

### Walidacja naukowa

- makrospin/Stoner-Wohlfarth: znany ksztalt petli i pola przelaczen dla
  wielu katow pola,
- maly uniaxialny element FDM CPU jako oracle dla OOP i IP,
- thin film OOP vs in-plane: sanity check pola demagnetyzacji i anizotropii
  ksztaltu,
- symetria petli przy symetrycznych warunkach,
- start od virgin curve nie moze byc raportowany jako major loop bez
  ostrzezenia,
- auto-saturation musi nie raportowac falszywego `H_sat`, gdy limit pola jest
  za niski,
- minor-loop closure i return-point-memory diagnostics dla prostego ukladu,
- porownanie average-only vs full-snapshot average dla wybranych punktow,
- test roznych gestosci kroku pola na stabilnosc `H_c`.

## Faza 13: kolejnosc wdrozenia

### Milestone A: spec i fizyka

Wynik:

- `docs/physics/08xx-hysteresis-sweep-semantics.md`,
- aktualizacja `docs/specs/resource-first-control-room-api-v2.md`,
- aktualizacja `docs/specs/frontend-v2/16-charts-analysis-module.md`,
- decyzja: `analysis/hysteresis` jako wlasciciel punktow i metryk,
- decyzja: canonical protocol vocabulary dla `virgin_curve`, `major_loop`,
  `minor_loop`, `forc_family`, OOP/IP/custom angle i auto-saturation.

Weryfikacja:

```bash
rg -n "hysteresis" docs/physics docs/specs
```

### Milestone B: DSL, IR i planner

Wynik:

- canonical `hysteresis_sweep` w Python DSL,
- IR stage z protocol, orientation, initial state i branch metadata,
- canonical settle pipeline/tree z algorytmami `relax`, `minimize`,
  `dynamics_settle` i parametrami per krok,
- planner generuje field schedule, preparation stages, saturation probe,
  minor-loop branches, settle pipeline per role i storage estimate,
- stare helpery kompatybilne.

Weryfikacja:

```bash
python3 -m pytest packages/fullmag-py/tests/test_api.py -q
cargo test -p fullmag-cli hysteresis
```

### Milestone C: runtime average-only

Wynik:

- jeden workflow stage,
- live points,
- scalar/metrics bez pelnych snapshotow,
- pause/resume,
- start od `as_authored`, `zero_field_relaxed`, `positive_saturation`,
  `negative_saturation`.

Weryfikacja:

```bash
just ensure-managed-fem-runtime
cargo test -p fullmag-runner hysteresis
```

Finalne FEM/MFEM/CUDA proof musi isc przez kontenerowe targety `just`, zgodnie
z AGENTS.md.

### Milestone D: auto-saturation i minor loops

Wynik:

- adaptive saturation probe,
- status `H_sat+/-`,
- minor-loop schedule z reversal/return fields,
- minor-loop metrics i branch provenance.

Weryfikacja:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-runner saturation_probe_classification_uses_thresholds_and_limit_status
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-runner configured_minor_loop_executes_branch_from_parent_reversal_state
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api hysteresis_analysis_endpoints_read_typed_artifacts
```

### Milestone E: field snapshots

Wynik:

- `selected/every_n/key_events/every_step`,
- artifact manifest,
- binary field resource,
- storage estimate i warnings.

Weryfikacja:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-runner storage_policy_controls_hysteresis_snapshot_capture
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-runner stored_hysteresis_snapshot_contains_vector_magnetization_payload
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api field_vector_snapshot_id_loads_persisted_hysteresis_magnetization
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api field_meta_snapshot_id_reports_persisted_hysteresis_magnetization_stats
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api hysteresis_snapshot_can_be_applied_as_field_state_initial_magnetization
```

### Milestone F: Control Room authoring i inspector

Wynik:

- rozbudowany inspector,
- protocol/orientation controls dla OOP/IP/custom angle,
- auto-saturation controls,
- settle pipeline/tree editor,
- settle trace view per punkt,
- minor-loop editor,
- preview sciezki pola,
- storage controls,
- points table,
- metrics panel.

Weryfikacja:

```bash
pnpm --dir apps/control-room test
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint --max-warnings=0
```

### Milestone G: charts i live analysis

Wynik:

- `HysteresisChart`,
- live point append,
- branch-aware tryby,
- `Virgin`, `Minor loops`, `OOP/IP overlay`, `Angular family`,
- koercja/remanencja/saturation/reversal markers.

Weryfikacja:

```bash
pnpm --dir apps/control-room test
```

### Milestone H: 3D replay punktow

Wynik:

- komenda `hysteresis.load-point-in-3d`,
- resource target dla snapshotu,
- viewport renderuje read-only magnetyzacje punktu,
- viewport pokazuje glyph pola i os pomiarowa,
- `Use as initial state` jako osobna jawna komenda.

Weryfikacja:

```bash
pnpm --dir apps/control-room test
CONTROL_ROOM_URL=http://localhost:3101/workspace CONTROL_ROOM_SCREENSHOT_SCENES=fdm pnpm --dir apps/control-room screenshot:viewport-3d
CONTROL_ROOM_URL=http://localhost:3101/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
```

### Audyt implementacji 2026-06-11

Status ponizszy jest audytem aktualnego worktree, a nie zmiana zakresu planu.
Nie odhaczac kamienia milowego szerzej niz pozwalaja dowody z tej sekcji.

Potwierdzone aktualnymi testami:

- Milestone B, DSL/IR/planner contract dla histerezy:
  - `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -q -k hysteresis`
    zwrocilo `11 passed`;
  - `CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-cli hysteresis --no-fail-fast`
    zwrocilo `5 passed`;
  - `CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-ir hysteresis --no-fail-fast`
    zwrocilo `9 passed` w testach unit/integration dla walidacji histerezy.
- Reczne zagęszczanie planu pola (`field_schedule` i
  `schedule_refinements`/`dense_windows`) jest zaimplementowane jako jawny
  authoring contract:
  - Python DSL round-trip dla `hysteresis_piecewise_field_schedule` i
    `hysteresis_dense_windows` zwrocil `2 passed`;
  - runner materializuje dense windows i piecewise schedule:
    `cargo test -p fullmag-runner dense_window` oraz
    `cargo test -p fullmag-runner piecewise_schedule` zwrocily lacznie
    `3 passed`.
- Milestone C/D runtime dla aktualnego zakresu:
  - `CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-runner hysteresis --no-fail-fast`
    zwrocilo `32 passed`, w tym test wstrzykniecia pola i zmiany
    magnetyzacji w FDM.
- Milestone E/API dla snapshotow:
  - `cargo test -p fullmag-api hysteresis_analysis`,
    `field_vector_snapshot_id_loads_persisted_hysteresis_magnetization`,
    `field_meta_snapshot_id_reports_persisted_hysteresis_magnetization_stats`,
    `hysteresis_snapshot_can_be_applied_as_field_state_initial_magnetization`
    przeszly.
  - regresja live API z `{"error":"stage 0 is not a hysteresis stage"}` zostala
    zamknieta dla endpointow indeksowych:
    `GET /v2/sessions/current/analysis/hysteresis/0/points` oraz
    `GET /v2/sessions/current/simulation/stages/0/hysteresis/progress`;
    `CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api hysteresis_analysis --no-fail-fast`
    zwrocilo `5 passed`;
  - live `curl` po restarcie managed runtime potwierdzil, ze progress po
    indeksie `0` zwraca `stage_id="stage-000"`, biezace `current_field_mT`,
    `current_m_avg` i `current_m_parallel`. Jezeli runtime jest jeszcze w polu
    przygotowawczym poza planowanymi punktami petli, `active_point_index` moze
    byc nieobecny. `points=[]` przed ukonczeniem pierwszego settle jest
    oczekiwane; historia narasta dopiero po zapisie ukonczonego punktu do
    `hysteresis_points.json`.
- Milestone F/G dla aktualnego UI:
  - `pnpm --dir apps/control-room test src/modules/inspector/panels/stages/StageInspectors.test.tsx src/modules/explorer/explorerSelection.test.ts src/modules/explorer/builders/buildModelTree.test.ts`
    zwrocilo `43 passed`;
  - `pnpm --dir apps/control-room test src/modules/analysis-plots/AnalysisPlotsModule.test.tsx src/modules/inspector/panels/stages/StageInspectors.test.tsx`
    zwrocilo `40 passed`;
  - `pnpm --dir apps/control-room test src/modules/analysis-plots/AnalysisPlotsModule.test.tsx src/modules/explorer/builders/buildModelTree.test.ts src/modules/explorer/explorerSelection.test.ts`
    zwrocilo `59 passed`; ten zestaw pokrywa wybor stage histerezy przez
    Explorer/Analysis oraz budowe wykresu z live progress i historii punktow;
  - `pnpm --dir apps/control-room typecheck`, `lint` i
    `check:api-hygiene` przeszly.
- Milestone H/replay 3D snapshotow histerezy:
  - frontendowa sciezka `hysteresis.load-point-in-3d` publikuje selekcje
    `analysis.chart-point`, przełącza center surface na `viewport-3d`, a
    viewport rozpoznaje `snapshot_id` i pobiera pole przez
    `data/fields/{quantity}/samples/vector?snapshot_id=...`;
  - `pnpm --dir apps/control-room test src/kernel/runtime/studyRuntimeCommandContributions.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/viewport-3d/Viewport3DModule.test.ts src/modules/viewport-3d/viewport3dResources.test.ts src/modules/viewport-3d/model/viewport3DTargets.test.ts`
    zwrocilo `129 passed`;
  - backendowe snapshot gates przeszly:
    `CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-runner hysteresis_snapshot --no-fail-fast`
    zwrocilo `2 passed`, a trzy testy API
    `hysteresis_snapshot_can_be_applied_as_field_state_initial_magnetization`,
    `field_vector_snapshot_id_loads_persisted_hysteresis_magnetization` i
    `field_meta_snapshot_id_reports_persisted_hysteresis_magnetization_stats`
    zwrocily po `1 passed`;
  - zamknieto luke UI `use-point-as-initial-state`: inspector przekazuje teraz
    `snapshot_resource_ref`, a komenda preferuje ten zasob nad recznie
    skladana sciezka artefaktu. Obecny kompatybilny backend moze jeszcze
    czytac pojedyncze snapshoty JSON, ale docelowy format playbacku
    `every_step` jest opisany nizej jako Zarr/HDF5 container. Test
    `uses the hysteresis point snapshot resource ref when applying an initial state`
    najpierw odtworzyl blad, a po poprawce
    `pnpm --dir apps/control-room test src/kernel/runtime/studyRuntimeCommandContributions.test.ts src/modules/inspector/panels/stages/StageInspectors.test.tsx src/modules/analysis-plots/AnalysisPlotsModule.test.tsx src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/viewport-3d/viewport3dResources.test.ts`
    zwrocilo `144 passed`;
  - browser smoke replay 3D zostal domkniety kontrolowanym trybem
    `CONTROL_ROOM_SMOKE_HYSTERESIS_REPLAY=1`
    `CONTROL_ROOM_SMOKE_HYSTERESIS_REPLAY_ONLY=1`
    `CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1` na
    `http://localhost:3101/workspace`. Smoke przez
    `pnpm --dir apps/control-room smoke:viewport-3d` potwierdzil:
    `Hysteresis replay smoke passed: snapshot_id=hysteresis_point_smoke
    stage_id=hysteresis-smoke` oraz `Viewport 3D smoke passed`.
    W fazie `hysteresis-replay` viewport mial niepusty canvas, HUD/DOM
    zawieral `data-hysteresis-replay-snapshot-id`, a data-plane request
    `data/fields/m/samples/vector` zawieral `snapshot_id`, `component=full` i
    `scope_kind=full`;
- Milestone E/storage container dla playbacku `m`:
  - runner zapisuje teraz kazdy przechwycony snapshot histerezy rownolegle do
    `hysteresis.zarr/fields/m` jako Zarr v2 store z osiami
    `[point, component, spatial_sample]`, indeksem `samples.csv` i globalnym
    `points.csv`;
  - endpoint `data/fields/m/samples/vector?snapshot_id=...` preferuje Zarr i
    spada do kompatybilnego `hysteresis_snapshots/{snapshot_id}/m.json` tylko
    gdy kontener nie ma wskazanej klatki;
  - baseline playback wymaga `m`; `H_demag`, `H_eff` i inne pola wektorowe sa
    opcjonalnymi kanalmi diagnostycznymi i nie blokuja produkcyjnego playbacku
    petli histerezy;
  - testy potwierdzone w tej kontynuacji:
    `CARGO_TARGET_DIR=/tmp/fullmag-api-zarr-target cargo test -p fullmag-runner stored_hysteresis_snapshot_contains_vector_magnetization_payload --no-fail-fast`
    zwrocil `1 passed`,
    `CARGO_TARGET_DIR=/tmp/fullmag-api-zarr-target cargo test -p fullmag-api field_vector_snapshot_id_loads_hysteresis_zarr_container_frame --no-fail-fast`
    zwrocil `1 passed`,
    `CARGO_TARGET_DIR=/tmp/fullmag-api-zarr-target cargo test -p fullmag-api field_meta_snapshot_id_reports_hysteresis_zarr_container_stats --no-fail-fast`
    zwrocil `1 passed`, a kompatybilne testy JSON fallback
    `field_vector_snapshot_id_loads_persisted_hysteresis_magnetization` i
    `field_meta_snapshot_id_reports_persisted_hysteresis_magnetization_stats`
    zwrocily po `1 passed`;
  - error-path gate dla snapshotow jest pokryty przez
    `field_vector_snapshot_id_rejects_unknown_malformed_and_wrong_quantity` i
    `field_meta_snapshot_id_rejects_unknown_malformed_and_wrong_quantity`:
    unknown `snapshot_id` zwraca `404`, malformed path segment zwraca `400`,
    a `snapshot_id` dla quantity innej niz `m` zwraca `400`;
  - mismatch gate dla snapshotow jest pokryty przez
    `field_vector_snapshot_id_conflicts_when_zarr_frame_mismatches_domain` i
    `field_meta_snapshot_id_conflicts_when_zarr_frame_mismatches_domain`:
    Zarr frame z metadanymi grid niepasujacymi do payloadu albo aktualnej
    domeny zwraca `409 Conflict`;
  - runtime smoke na malym waveguide zostal uruchomiony przez managed Fullmag:
    `FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 FULLMAG_HYSTERESIS_FIELD_VALUES_MT=50,0,-50 FULLMAG_HYSTERESIS_MAX_STEPS=25 FULLMAG_HYSTERESIS_MAGNETIZATION_STORAGE=every_step just fullmag build=True static fem cpu headless examples/hysteresis_waveguide_300x50x10nm.py`.
    Sesja `session-1781246437482-1629188` zakonczyla sie statusem
    `completed`, `total_steps=74`;
  - artefakty runtime zweryfikowano komenda
    `python3 scripts/verify_hysteresis_playback_artifacts.py .fullmag/local-live/history/session-1781246437482-1629188/artifacts`,
    ktora zwrocila `validated hysteresis playback: points=3 snapshots=3 cell_count=1137 container=zarr`.
- Milestone G/Explorer -> inspector trace:
  - klikniecie wezla `field-point` albo `algorithm` w Explorerze mapuje teraz
    inspector histerezy na dedykowany widok `settle-trace`, a nie na
    generyczny `current-field`;
  - inspector wyciaga `point_id` rowniez z kernel selection `nodeId`, wiec trace
    dziala dla wyboru z Explorera bez wymagania snapshotu 3D z wykresu;
  - test
    `pnpm --dir apps/control-room test src/modules/inspector/panels/stages/StageInspectors.test.tsx`
    zwrocil `16 passed`, a `pnpm --dir apps/control-room typecheck`
    przeszedl.
- Milestone F/OpenAPI v2 + frontend facade/resource hooks:
  - backendowe zrodlo OpenAPI po dodaniu `409 Conflict` dla snapshot/domain
    mismatch zostalo zsynchronizowane przez
    `CARGO_TARGET_DIR=/tmp/fullmag-api-zarr-target pnpm --dir apps/control-room generate:api`;
  - wygenerowane artefakty `openapi-v2.json`, `openapi-v2-types.ts` i
    `openapi-v2-paths.ts` zawieraja `409` dla
    `/v2/sessions/current/data/fields/{quantity_id}/meta` oraz
    `/v2/sessions/current/data/fields/{quantity_id}/samples/vector`;
  - `ControlRoomApi` i `studyRuntimeResources` maja juz typed facade/resource
    hooks dla zasobow `analysis.hysteresis.*` oraz
    `simulation.stages.hysteresis.*`; komponenty histerezy korzystaja z tych
    hookow zamiast bezposredniego `fetch()`;
  - wymagany gate API hygiene przeszedl po usunieciu testowych literalow
    `/v2/...` z frequency-domain inspector tests:
    `pnpm --dir apps/control-room check:api-hygiene`;
  - testy fasady/hookow po synchronizacji kontraktu:
    `pnpm --dir apps/control-room test src/kernel/api/ControlRoomApi.test.ts src/kernel/resources/studyRuntimeResources.test.ts`
    zwrocilo `83 passed`, a cleanup testow frequency-domain:
    `pnpm --dir apps/control-room test src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx src/kernel/resources/studyRuntimeResources.test.ts`
    zwrocil `23 passed`;
  - `pnpm --dir apps/control-room typecheck` przeszedl po regeneracji API.
  - replay 3D ma teraz powtarzalny gate przegladarkowy: dev-only audit hook
    `__FULLMAG_CONTROL_ROOM_AUDIT__.loadHysteresisReplaySnapshot` ustawia
    kanoniczny selection ref `targetKind="hysteresis-step"` i przelacza
    workspace na `viewport-3d`; smoke asercyjnie sprawdza DOM replay target,
    request field-vector z `snapshot_id` i niepusty canvas;
  - potwierdzone gate'y po dodaniu replay smoke:
    `pnpm --dir apps/control-room test src/kernel/KernelProvider.test.ts src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts src/kernel/runtime/studyRuntimeCommandContributions.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/viewport-3d/viewport3dResources.test.ts`
    zwrocil `135 passed`,
    `pnpm --dir apps/control-room typecheck` przeszedl,
    `pnpm --dir apps/control-room check:api-hygiene` przeszedl,
    `pnpm --dir apps/control-room lint` przeszedl.

Niezamkniete braki produkcyjne:

- `Angular family` ma juz podstawowy kontrakt authoringu i planu:
  `fm.HysteresisAngularFamily(...)` / `fm.HysteresisAngularVariant(...)`
  round-tripuja przez Python DSL, `ProblemIR` waliduje family/variants, a
  zasob `/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/plan`
  wystawia `angular_family`. Zasob
  `/v2/sessions/current/analysis/hysteresis-family/{stage_id}` grupuje serie po
  orientacji: aktualnie policzony wariant dostaje punkty/metryki z aktywnego
  stage, a pozostale warianty sa jawnie oznaczone jako `pending_run`, zeby UI
  nie kopiowalo tej samej petli dla wielu katow. `ControlRoomApi` i
  `useHysteresisFamilyResource` eksponuja ten zasob przez typed frontend v2
  facade/resource hook. W UI `HysteresisChart` obsluguje `Full`, `Virgin`,
  `Forward`, `Return`, `Minor loops`, `OOP/IP overlay`, `RGB Components` i
  `Angular Family`. Tryb `Angular Family` rysuje tylko warianty z obliczonymi
  punktami i pokazuje liczbe wariantow `pending_run`, zeby nie sugerowac
  niepoliczonych petli. Runtime zapisuje teraz lekki manifest
  `hysteresis_angular_family.json`, ktory oznacza wariant aktywnego stage jako
  `computed_active_stage` z referencjami do `hysteresis_points.json`,
  `hysteresis_metrics.json` i `hysteresis_settle_trace.json`, a pozostale
  warianty jako `pending_run`. Zasob
  `/v2/sessions/current/analysis/hysteresis-family/{stage_id}` preferuje ten
  manifest runtime, a gdy go brakuje zachowuje dotychczasowy fallback z planu
  stage. Runtime wykonuje teraz podstawowy multi-run family: aktywny wariant
  pozostaje w glownych artefaktach stage, a dodatkowe warianty sa liczone jako
  osobne przebiegi z wlasna orientacja pola i osia pomiaru, zapisywane pod
  `hysteresis_angular_family/{variant_id}/hysteresis_points.json`,
  `hysteresis_metrics.json` i `hysteresis_settle_trace.json`. Zasob
  `analysis/hysteresis-family` czyta te sciezki z manifestu i zwraca osobne
  serie punktow/metryk dla policzonych wariantow zamiast kopiowac dane
  aktywnego stage. Publiczny `points_resource_ref` nie ujawnia sciezek plikow
  artefaktow: wskazuje zasob
  `/v2/sessions/current/analysis/hysteresis-family/{stage_id}/variants/{variant_id}/points`,
  a `ControlRoomApi.analysis.hysteresis.familyVariantPoints(...)` udostepnia
  ten odczyt przez typed frontend facade. Nadal brakuje publikacyjnego
  benchmarku porownania wielu pelnych petli dla wielu katow oraz
  zaawansowanego schedulera family dla wznowien/checkpointow i kosztow
  GPU/provenance.
- Szybki walidacyjny smoke dla angular-family jest dostepny na tym samym malym
  waveguide: `FULLMAG_HYSTERESIS_ANGULAR_FAMILY=1` wlacza rodzine
  `ip_x`/`oop`/`custom_theta45_phi30` w
  `examples/hysteresis_waveguide_300x50x10nm.py`, target
  `just run-hysteresis-waveguide-angular-family-smoke cpu` uruchamia wariant
  CPU, a `just run-hysteresis-waveguide-gpu-angular-family-smoke` wariant GPU.
  Artefakty waliduje
  `just verify-hysteresis-angular-family-artifacts <artifact-dir>`, ktory
  sprawdza `hysteresis_angular_family.json`, co najmniej dwa policzone
  warianty, aktywny wariant `computed_active_stage`, dodatkowy wariant
  `computed_variant_run` oraz osobne pliki punktow/metryk.
  Aktualny runtime proof po rebuildzie managed FEM runtime:
  `just ensure-managed-fem-runtime` przebudowal `.fullmag/runtimes/fem-gpu-host`
  z aktualnym `fullmag-runner`; nastepnie
  `just run-hysteresis-waveguide-angular-family-smoke cpu` zakonczyl sesje
  `session-1781256544597-2008930`, a
  `python3 scripts/verify_hysteresis_angular_family_artifacts.py .fullmag/local-live/history/session-1781256544597-2008930/artifacts`
  zwrocil
  `validated hysteresis angular family: family_id=waveguide_ip_oop_family variants=2`.
  Manifest zawieral `ip_x` jako `computed_active_stage` i `oop` jako
  `computed_variant_run` z osobnym
  `hysteresis_angular_family/oop/hysteresis_points.json`.
  W tym srodowisku `just run-hysteresis-waveguide-gpu-smoke` dochodzi do
  planowania/runtime, ale nie jest walidacja GPU, bo lokalny sterownik CUDA jest
  starszy niz runtime CUDA (`cudaGetDeviceCount failed ... CUDA driver version
  is insufficient for CUDA runtime version`). Dodatkowo sandbox blokuje sockety
  TCP, wiec smoke FEM/OpenMPI trzeba uruchamiac poza sandboxem albo przez
  zaakceptowany `just` target.
- Benchmark projekcji OOP/IP/custom-angle ma osobny szybki target:
  `just run-hysteresis-waveguide-projection-benchmark-smoke cpu`. Target uzywa
  jednego pola i jednego kroku minimalizacji, zeby tanio wygenerowac artefakty
  dla `ip_x`, `oop` i `custom_theta45_phi30`. Walidacja:
  `just verify-hysteresis-projection-benchmark .fullmag/local-live/history/session-1781257502282-2039282/artifacts`
  zwrocila
  `validated hysteresis projection benchmark: variants=3 points=3`. Verifier
  sprawdza, ze kazdy punkt spelnia kontrakt danych wykresu:
  `m_parallel = <m> . u_meas`, `m_oop = <m>_z`,
  `m_ip = sqrt(<m>_x^2 + <m>_y^2)` dla OOP, in-plane i custom-angle.
- Automatyczny `adaptive_refinement` ma juz publiczny kontrakt Python DSL,
  lowering do `ProblemIR`, walidacje IR, pole w zasobie API planu etapu oraz
  runtime artifact `hysteresis_adaptive_refinement.json`. Runtime wykonuje
  opcjonalny second-pass branch scheduler: kandydaci z zero crossing,
  `dm/dH`, reversal fields albo non-convergence sa liczeni od stanu lewego
  rodzica odcinka i zapisywani jako punkty z `adaptive_inserted=true` oraz
  `refinement_reason`. Przy `storage.magnetization="every_step"` punkty
  adaptacyjne dostaja tez snapshot `m` do replay 3D. Nadal nie jest to tryb
  pelnego recompute/merge calej major branch; taki tryb pozostaje rozszerzeniem
  wymagajacym osobnego provenance i wyboru metryk. Nie mylic go z juz
  dzialajacymi, jawnie zadanymi przez uzytkownika
  `schedule_refinements`/`dense_windows`.
- Pelna publikacyjna walidacja naukowa dla OOP, in-plane i custom-angle
  benchmark cases pozostaje niezamknieta. Aktualne testy potwierdzaja kontrakt
  i sanity runtime, ale nie sa jeszcze kompletnym benchmarkiem publikacyjnym.

## Faza 14: szczegolowy plan wykonawczy

Ta sekcja jest instrukcja realizacji. Nie traktowac jej jako sugestii. Kazdy
milestone ma wejsc w repo jako maly, weryfikowalny etap. Nie laczyc zmian
fizyki, API, runtime i UI w jeden wielki diff, jezeli nie wymaga tego test
kontraktowy.

Zasady wykonawcze dla wszystkich etapow:

1. Przed edycja uruchomic lokalizujace `rg`, zeby potwierdzic aktualne pliki.
   Nie zakladac, ze sciezki z planu sa jedynym miejscem implementacji.
2. Najpierw dodac test albo checklist specyfikacyjny, ktory opisuje nowe
   zachowanie. Dopiero potem implementowac.
3. Nie usuwac starego `add_hysteresis_branch(...)` ani starych pol UI bez
   kompatybilnej migracji.
4. Kazda nowa wartosc publicznego kontraktu musi przejsc przez:
   Python DSL -> scene/study payload -> ProblemIR/planner -> runtime
   provenance -> v2 API -> Control Room.
5. Status API pozostaje cienki. Punkty petli, metryki i snapshoty nie moga
   trafic jako duze tablice do `/v2/sessions/current/status`.
6. Websocket tylko invaliduje zasoby. Pelny stan odtwarzany jest z HTTP v2.
7. Frontend korzysta z `ControlRoomApi`, resource hooks i command registry.
   Nie dodawac `fetch()` w komponentach.
8. Dla zmian `viewport-3d` obowiazkowy jest browser smoke z niepustym WebGL
   canvasem.
9. Dla FEM/MFEM/CUDA/hypre/libCEED finalny dowod runtime idzie przez
   kontenerowe targety `just`, nie przez host-only build.
10. Kazdy etap konczy sie aktualizacja albo potwierdzeniem braku potrzeby
    aktualizacji: docs, OpenAPI, generated types, testow i acceptance gates.

### Etap A: specyfikacja fizyczna i kontrakt produktu

Cel: zamknac fizyke i slownictwo zanim powstanie kod. Ten etap blokuje
implementacje. Jezeli nie przejdzie, nie zaczynac DSL/IR.

#### A.1. Utworzenie publikacyjnej notatki fizycznej

Instrukcja:

1. Otworz `docs/physics/TEMPLATE.md`.
2. Utworz `docs/physics/08xx-hysteresis-sweep-semantics.md`. Numer `08xx`
   dobrac do aktualnej sekwencji w `docs/physics/`.
3. Wypelnij sekcje:
   - problem fizyczny i zakres: quasistatyczna histereza ferromagnetykow,
     major loops, virgin curves, minor loops, FORC as deferred extension;
   - rownania: energia Zeemana, definicja `H_ext`, projekcja `m_parallel`,
     moment-weighted `m_avg`, petla strat przez calke po cyklu;
   - jednostki: `H_ext` w A/m, prezentacyjne `mu0 H` w T/mT, `mu0` double;
   - ramy odniesienia: `sample`, `global`, `object`, `easy_axis`;
   - OOP/IP/custom angle: `theta`, `phi`, wektor `u_H`, os pomiaru;
   - protokoly startu: `as_authored`, `zero_field_relaxed`,
     `positive_saturation`, `negative_saturation`, `checkpoint`,
     `ac_demagnetized` jako future;
   - auto-saturation: progi, statusy, limit pola, ostrzezenia;
   - minor loops: reversal fields, return fields, parent branch, closure;
   - obserwable i metryki: `H_c+/-`, `H_c`, `H_eb`, `M_r+/-`, `H_sat+/-`,
     `m_oop`, `m_ip`, susceptibility, loop area, recoil susceptibility;
   - FDM/FEM oraz CPU/GPU interpretacja;
   - storage i snapshot policy;
   - walidacja i testy referencyjne.
4. Dodaj do notatki "Non-goals":
   - dynamiczna sweep-rate hysteresis poza pierwszym wdrozeniem,
   - temperatura/stochastic LLG poza pierwszym wdrozeniem,
   - pelny FORC analysis jako rozszerzenie po minor loops.
5. Dodaj tabele `Protocol -> required initial state -> allowed metrics`.
   Przykład: `virgin_curve` nie moze bez ostrzezenia raportowac tych samych
   metryk co `major_loop`.

Weryfikacja:

```bash
rg -n "H_sat|minor_loop|virgin_curve|mu0|m_parallel|OOP|in_plane|theta|phi" docs/physics/*hysteresis*.md
rg -n "TODO|TBD|FIXME" docs/physics/*hysteresis*.md
```

Brama produkcyjna:

- notatka nie zawiera placeholderow,
- kazda publiczna metryka ma definicje, jednostke i ograniczenia,
- notatka jawnie mowi, kiedy metryka jest `unavailable` albo `warning`,
- OOP/IP/custom angle sa opisane tym samym kontraktem,
- minor loops nie sa opisane jako zwykla kosmetyka wykresu.

#### A.2. Resource-first i frontend specs

Instrukcja:

1. Zaktualizuj `docs/specs/resource-first-control-room-api-v2.md`:
   - dodaj `analysis/hysteresis/{stage_id}/points`,
     `metrics`, `branches`, `minor-loops`, `reversal-fields`,
     `steps/{point_id}`, `steps/{point_id}/settle-trace`;
   - dodaj `simulation/stages/{stage_id}/hysteresis/plan`,
     `protocol`, `orientation`, `saturation`, `settle-pipeline`,
     `progress`;
   - wpisz decyzje: payload pola magnetyzacji idzie przez
     `data/fields/m/... ?snapshot_id=...`, a `analysis/hysteresis` trzyma
     indeks i metadane;
   - opisz revision keys i invalidacje.
2. Zaktualizuj `docs/specs/frontend-v2/16-charts-analysis-module.md`:
   - dodaj `HysteresisChart`,
   - dodaj branch-aware series contract,
   - dodaj `Virgin`, `Forward`, `Return`, `Minor loops`, `Full loop`,
     `RGB overlay`, `OOP/IP overlay`, `Angular family`.
3. Zaktualizuj, jezeli potrzebne, `docs/specs/frontend-v2/02-module-catalog.md`
   w opisie `analysis-plots`, `study-authoring`, `viewport-3d`, `run-control`.
4. Jezeli pojawi sie spor o nowe resource families albo dlugotrwala decyzja
   architektoniczna, dodaj ADR przed implementacja API.

Weryfikacja:

```bash
rg -n "analysis/hysteresis|hysteresis/.+saturation|snapshot_id|HysteresisChart|Minor loops|OOP/IP" docs/specs
rg -n "analysis/hysteresis|snapshot_id|data/fields/m" docs/specs
```

Brama produkcyjna:

- jest jeden wlasciciel punktow i metryk: `analysis/hysteresis`,
- jest jeden wlasciciel ciezkiego pola: `data/fields`,
- websocket opisany jest jako invalidacja, nie jako payload transport,
- chart spec nie wymaga implicit aggregation ani mieszania galezi.

### Etap B: Python DSL, ProblemIR, normalizacja i planner

Cel: UI i Python maja eksportowac jeden canonical stage. Runtime nie moze
zgadywac fizyki z luźnych pol `start_field/stop_field`.

#### B.1. Test-first dla Python DSL

Instrukcja:

1. Otworz `packages/fullmag-py/tests/test_api.py`.
2. Dodaj testy przed implementacja:
   - `test_study_stage_builder_add_hysteresis_sweep_major_oop_auto_saturation`;
   - `test_study_stage_builder_add_hysteresis_sweep_custom_angle_roundtrip`;
   - `test_study_stage_builder_add_hysteresis_sweep_minor_loops`;
   - `test_study_stage_builder_hysteresis_sweep_settle_pipeline_sequence`;
   - `test_study_stage_builder_hysteresis_sweep_settle_tree_fallback`;
   - `test_study_stage_builder_hysteresis_sweep_settle_applies_to_roles`;
   - `test_study_stage_builder_hysteresis_piecewise_field_schedule`;
   - `test_study_stage_builder_hysteresis_dense_windows`;
   - `test_study_stage_builder_hysteresis_legacy_branch_maps_to_canonical`;
   - `test_study_stage_builder_hysteresis_rejects_zero_orientation_vector`;
   - `test_study_stage_builder_hysteresis_rejects_empty_field_values`.
3. W testach sprawdzaj pelny payload, nie tylko brak wyjatku:
   - `kind == "hysteresis"`,
   - `entrypoint_kind == "flat_hysteresis"` albo nowy ustalony canonical
     entrypoint,
   - `protocol_kind`,
   - `initial_state_policy`,
   - `field_orientation`,
   - `measurement_axis`,
   - `saturation_policy`,
   - `minor_loop_policy`,
   - `settle_pipeline`,
   - `field_schedule.piecewise_segments`,
   - `storage_policy`,
   - `field_unit_provenance`.
4. Dodaj test eksportu skryptu, jezeli istnieje sciezka round-trip przez
   `packages/fullmag-py/src/fullmag/runtime/script_builder.py`.

Implementacja:

1. W `packages/fullmag-py/src/fullmag/world.py` dodaj publiczne helpery:
   - `FieldOrientation`,
   - `SaturationProbe`,
   - `HysteresisStorage`,
   - `MinorLoop`,
   - `PiecewiseFieldSchedule`,
   - `FieldSegment`,
   - `FieldWindow`,
   - `SettlePipeline`,
   - `SettleTree`,
   - `SettleBranch`,
   - `RelaxStep`,
   - `MinimizeStep`,
   - `DynamicsSettleStep`,
   - `StudyStagesBuilder.add_hysteresis_sweep(...)`.
2. Jezeli repo preferuje klasy modelowe w `packages/fullmag-py/src/fullmag/model/study.py`,
   umiesc tam dataclass/typed helpers, a w `world.py` tylko fasade.
3. `direction=(...)` zostaw jako kompatybilny alias:
   - normalizuj do `FieldOrientation.global_vector(...)`,
   - zapisuj warning/provenance `legacy_direction_alias=true`.
4. Waliduj w Pythonie tylko rzeczy oczywiste:
   - puste field values,
   - zerowy direction vector,
   - sprzeczny `field_step`,
   - segment piecewise z zerowym krokiem,
   - segment piecewise z krokiem o zlym znaku,
   - nakladajace sie dense windows bez priority,
   - ujemne albo zerowe `every_n`,
   - pusty `settle_pipeline`,
   - fallback branch bez akcji,
   - `run_next_algorithm` na ostatnim kroku bez branch fallback.
   Pelna walidacja fizyczna musi zostac w Rust/IR.
5. Parametry algorytmow nie moga byc wrzucane jako nieopisany `dict`.
   Dopuszczalny jest `extra_backend_hints`, ale publiczne parametry
   `relax/minimize/dynamics_settle` musza miec nazwane pola.
6. Nie materializuj publicznie petli do anonimowych relaksacji. Payload ma
   reprezentowac canonical hysteresis stage.

Weryfikacja:

```bash
python3 -m pytest packages/fullmag-py/tests/test_api.py -q
python3 -m py_compile packages/fullmag-py/src/fullmag/world.py packages/fullmag-py/src/fullmag/model/study.py
```

Brama produkcyjna:

- testy failuja przed implementacja i przechodza po niej,
- stary `add_hysteresis_branch(...)` dalej przechodzi istniejace testy,
- canonical export nie traci `initial_protocol`, orientacji ani minor loops,
- canonical export zachowuje segmenty piecewise, labels i reason okien
  zageszczenia,
- canonical export nie traci settle pipeline ani parametrow algorytmow,
- nie ma backend-specific nazw w publicznym Python API.

#### B.2. ProblemIR i walidacja Rust

Instrukcja:

1. Zacznij od lokalizacji aktualnego modelu stage:

```bash
rg -n "pub .*Stage|StudyStage|stage_id|hysteresis|entrypoint_kind" crates/fullmag-ir/src crates/fullmag-cli/src packages/fullmag-py/src/fullmag
```

2. W `crates/fullmag-ir/src/study.rs` albo aktualnym module stage dodaj
   jawne typy:
   - `HysteresisStageIR`,
   - `HysteresisProtocolKind`,
   - `HysteresisInitialStatePolicy`,
   - `FieldOrientationIR`,
   - `MeasurementAxisIR`,
   - `FieldScheduleIR`,
   - `FieldSegmentIR`,
   - `FieldWindowIR`,
   - `SaturationPolicyIR`,
   - `MinorLoopIR`,
   - `HysteresisStoragePolicyIR`,
   - `SettlePipelineIR`,
   - `SettleAlgorithmStepIR`,
   - `SettleConditionIR`,
   - `SettleStopCriterionIR`,
   - `SettleNonConvergencePolicyIR`,
   - `HysteresisPointIR`.
3. Wszystkie typy maja miec serde-compatible shape zgodny z Python DSL i UI.
   Nazwy enumow w JSON zapisuj snake_case.
4. Dodaj normalizacje:
   - `theta/phi -> u_H`,
   - `direction -> FieldOrientationIR::GlobalVector`,
   - `field_min/max/step -> explicit schedule`,
   - `piecewise_segments -> explicit schedule with segment_id`,
   - `schedule_refinements -> merged explicit schedule with refinement_reason`,
   - `major_loop -> branches`,
   - `minor_loops -> branch forks`,
   - `settle=RelaxStop -> one-step SettlePipelineIR` dla kompatybilnosci,
   - `settle_pipeline sequence/tree -> normalized pipeline with step ids`,
   - display unit mT/T -> A/m z `mu0`,
   - legacy `start_field/stop_field/field_steps -> single_branch/as_authored`.
5. Dodaj walidacje z czytelnymi bledami:
   - zero vector,
   - brak sample frame dla `theta/phi`,
   - `positive_saturation` bez manualnego albo auto saturation,
   - `minor_loop` bez parent branch,
   - reversal field poza zakresem parent branch,
   - piecewise segment z zerowym krokiem,
   - piecewise segment ze znakiem kroku niezgodnym ze start/stop,
   - overlapping windows bez priority/order policy,
   - duplicate boundary point bez jawnej endpoint policy,
   - pusty settle pipeline,
   - nieznany algorithm kind/method,
   - brak stop criterion,
   - parametr nielegalny dla metody, np. `dt_min > dt`, `max_steps <= 0`,
     `alpha <= 0`, ujemna tolerancja,
   - warunek fallback odwoluje sie do nieistniejacego step id,
   - `applies_to` odwoluje sie do nieistniejacej roli/galezi,
   - `every_step` bez storage approval gate,
   - `field_values` puste,
   - zbyt duza liczba punktow.
6. Bledy maja zawierac sciezke pola, np.
   `study.stages[2].hysteresis.field_orientation`.

Testy:

1. Dodaj unit tests w `crates/fullmag-ir/src/study.rs` albo dedykowanym
   module testowym.
2. Minimum przypadkow:
   - OOP positive normalizuje do sample normal,
   - in-plane 35 deg daje poprawny wektor,
   - major loop generuje forward/return z turning points,
   - piecewise schedule deduplikuje punkt na granicy segmentow,
   - piecewise schedule zachowuje `segment_id` i `segment_label`,
   - dense window nadpisuje krok bazowy tylko w swoim zakresie,
   - overlapping windows bez priority sa odrzucane,
   - minor loop generuje branch fork i parent id,
   - auto-saturation policy przechodzi bez manual H_sat,
   - settle pipeline sequence zachowuje kolejność krokow,
   - settle tree normalizuje fallback branches i step ids,
   - legacy `settle` mapuje sie do one-step pipeline,
   - nielegalne parametry algorytmu sa odrzucane z czytelna sciezka bledu,
   - brak sample frame odrzuca `theta/phi`,
   - legacy payload mapuje sie na canonical.

Weryfikacja:

```bash
cargo test -p fullmag-ir hysteresis --no-fail-fast
cargo test -p fullmag-cli hysteresis --no-fail-fast
```

Brama produkcyjna:

- Rust jest wlascicielem normalizacji i walidacji,
- requested intent przezywa normalizacje,
- legacy payloady maja stabilna migracje,
- bledy walidacji sa czytelne dla UI i CLI.

#### B.3. Planner i materializer

Instrukcja:

1. W `crates/fullmag-cli/src/step_utils.rs` nie rozszerzaj bez konca jednej
   funkcji `materialize_pipeline_hysteresis_branch(...)`. Wyciagnij czysta
   logike schedule do mniejszego modulu albo funkcji:
   - parse/normalize config,
   - build piecewise field schedule,
   - merge dense windows,
   - build preparation schedule,
   - build major loop,
   - build minor loops,
   - resolve settle pipeline per protocol role,
   - build storage actions.
2. Zachowaj obecne testy:
   - `materialized_hysteresis_points_continue_same_branch_state`,
   - `materialize_script_stages_supports_hysteresis_loop_macro`,
   - `materialize_script_stages_supports_hysteresis_loop_save_point_state`.
3. Dodaj testy:
   - `materialize_hysteresis_major_loop_preserves_parent_stage_id`,
   - `materialize_hysteresis_positive_saturation_adds_preparation_stage`,
   - `materialize_hysteresis_zero_field_relaxed_adds_zero_field_relax`,
   - `materialize_hysteresis_minor_loop_branches_from_parent_point`,
   - `materialize_hysteresis_auto_saturation_marks_probe_points`,
   - `materialize_hysteresis_piecewise_schedule_preserves_segments`,
   - `materialize_hysteresis_dense_window_inserts_finer_step`,
   - `materialize_hysteresis_rejects_overlapping_windows_without_priority`,
   - `materialize_hysteresis_settle_pipeline_sequence_per_point`,
   - `materialize_hysteresis_settle_tree_fallback_metadata`,
   - `materialize_hysteresis_key_event_uses_precise_minimize_step`,
   - `materialize_hysteresis_legacy_payload_remains_compatible`.
4. Materializacja tymczasowo moze nadal emitowac relaksacje per punkt, ale
   kazdy wynikowy stage/action musi miec:
   - `parent_hysteresis_stage_id`,
   - `point_id`,
   - `branch_id`,
   - `protocol_role`,
   - `segment_id`,
   - `segment_label`,
   - `refinement_reason`,
   - `field_vector_A_per_m`,
   - `settle_step_ids`,
   - `settle_pipeline_ref`,
   - `snapshot_policy`.
5. Nie tracic `stage_id` po rozwinieciu do wielu etapow. Explorer i API musza
   widziec jeden workflow histerezy, nie setki niezaleznych relax stage.

Weryfikacja:

```bash
cargo test -p fullmag-cli hysteresis --no-fail-fast
rg -n "parent_hysteresis_stage_id|protocol_role|minor_loop_id|saturation" crates/fullmag-cli/src crates/fullmag-ir/src
```

Brama produkcyjna:

- planner potrafi pokazac schedule bez startowania solvera,
- kazdy punkt ma stabilny identyfikator,
- minor loop nie nadpisuje parent branch,
- auto-saturation probe jest jawnym elementem planu.

#### B.4. Kontrakt `settle_pipeline`

Instrukcja:

1. Zdefiniuj jeden canonical vocabulary algorytmow:
   - `relax`,
   - `minimize`,
   - `dynamics_settle`,
   - `custom_backend_method` tylko jako advanced/experimental.
2. Dla `relax` obslugiwane metody w pierwszym wdrozeniu:
   - `llg_overdamped`,
   - `tangent_plane_implicit`, jezeli backend/lane wspiera,
   - inne metody tylko jako rejected/unsupported z capability reason.
3. Dla `minimize` obslugiwane metody:
   - `projected_gradient_bb`,
   - `nonlinear_cg`,
   - backend-specific metody tylko przez explicit backend hints.
4. Dla `dynamics_settle`:
   - traktuj jako osobny tryb, bo wynik moze zalezec od czasu i sweep rate,
   - w pierwszym production path moze byc `unsupported` z jasnym bledem,
     jezeli runtime nie ma gotowego kontraktu.
5. Dla kazdej metody zdefiniuj parametry:
   - typ,
   - jednostke,
   - default,
   - zakres legalny,
   - czy moze byc `auto`,
   - gdzie planner rozstrzyga `auto`.
6. Zdefiniuj stop criteria:
   - `torque_below`,
   - `energy_delta_below`,
   - `max_steps`,
   - `max_pseudotime_s`,
   - `max_physical_time_s`,
   - `m_delta_below`,
   - `all_of` i `any_of`.
7. Zdefiniuj `applies_to`:
   - `all_points`,
   - `preparation`,
   - `saturation_probe`,
   - `major`,
   - `minor`,
   - `recoil`,
   - `key_events`,
   - `branch_id`,
   - `point_selector`.
8. Zdefiniuj fallback:
   - `continue_with_warning`,
   - `stop_stage`,
   - `run_next_algorithm`,
   - `retry_with_smaller_dt`,
   - `run_named_branch`.
9. W plannerze rozwin `settle_pipeline` do `ResolvedSettlePlan` per point:
   - zwykly punkt major moze miec szybki relax,
   - reversal/key event moze miec dokladny minimize po relax,
   - non-convergence moze miec fallback relax z mniejszym dt.
10. W provenance zapisz:
    - requested pipeline,
    - resolved pipeline,
    - faktycznie uruchomiony trace,
    - powody pominiecia kroku albo fallbacku.

Testy:

- `settle_pipeline_empty_rejected`,
- `relax_llg_overdamped_params_roundtrip`,
- `minimize_projected_gradient_bb_params_roundtrip`,
- `applies_to_key_events_selects_only_key_event_points`,
- `run_next_algorithm_requires_next_step`,
- `retry_with_smaller_dt_requires_dt_policy`,
- `unsupported_method_reports_capability_reason`,
- `resolved_defaults_are_visible_in_plan`,
- `settle_trace_records_fallback_reason`.

Weryfikacja:

```bash
python3 -m pytest packages/fullmag-py/tests/test_api.py -q
cargo test -p fullmag-ir settle hysteresis --no-fail-fast
cargo test -p fullmag-cli settle hysteresis --no-fail-fast
cargo test -p fullmag-runner settle hysteresis --no-fail-fast
```

Brama produkcyjna:

- UI/Python/IR uzywaja tej samej listy algorytmow i parametrow,
- nie ma nieopisanych `dict` z parametrami algorytmu poza explicit advanced
  backend hints,
- kazdy punkt moze wyjasnic, ktory algorytm go zrelaksowal,
- zmiana pipeline zmienia provenance i eksport, nie ginie jako runtime detail.

### Etap C: runtime average-only i metryki bez snapshotow

Cel: najpierw produkcyjnie doprowadzic lekkie live points i metryki. Pelne
snapshoty magnetyzacji przyjda pozniej.

#### C.1. Model runtime punktow histerezy

Instrukcja:

1. Zlokalizuj obecny stage execution state:

```bash
rg -n "StageExecution|scalar history|field_snapshots|stage_id|realtime" crates/fullmag-runner/src crates/fullmag-api/src crates/fullmag-cli/src
```

2. Dodaj backend-neutralny model wynikow, najlepiej w nowym module
   `crates/fullmag-runner/src/hysteresis.rs` albo w aktualnym module runtime,
   jezeli repo ma juz miejsce na study workflow:
   - `HysteresisRunState`,
   - `HysteresisPointResult`,
   - `HysteresisBranchResult`,
   - `HysteresisLoopMetrics`,
   - `HysteresisSaturationResult`,
   - `HysteresisMinorLoopMetrics`,
   - `SettleExecutionTrace`,
   - `SettleStepExecutionRecord`.
3. Model wynikow nie moze zawierac ciezkich pol magnetyzacji. Ma trzymac:
   - ids,
   - H,
   - orientation,
   - averages,
   - energies,
   - convergence,
   - settle trace,
   - snapshot refs optional.
4. Dodaj pure functions:
   - `moment_weighted_average(...)`,
   - `project_m_parallel(...)`,
   - `compute_oop_ip_components(...)`,
   - `interpolate_remanence(...)`,
   - `interpolate_coercivity(...)`,
   - `compute_loop_area(...)`,
   - `compute_differential_susceptibility(...)`,
   - `classify_saturation_status(...)`.
5. Pure functions maja miec testy bez solvera. Nie czekac na backend.

Testy:

- deterministic points crossing zero -> koercja interpolowana liniowo,
- brak crossing -> `unavailable` plus warning,
- niezamkniety loop -> loop area ma warning,
- multi-region moment weighted average nie jest prostym average,
- OOP/IP projections dzialaja dla theta/phi,
- `H_eb` i `H_c` z poprawnym znakiem.
- settle trace serializuje step id, method, resolved params, stop reason i
  fallback reason.

Weryfikacja:

```bash
cargo test -p fullmag-runner hysteresis_metrics --no-fail-fast
```

Brama produkcyjna:

- metryki sa deterministyczne i nie zaleza od UI,
- kazda metryka ma status `available | unavailable | warning`,
- nie ma paniki dla petli niepelnej albo nienasyconej.

#### C.2. Wykonanie workflow average-only

Instrukcja:

1. Podlacz schedule histerezy do runtime jako jeden workflow stage.
2. Dla kazdego punktu:
   - ustaw zewnetrzne pole,
   - wybierz settle pipeline na podstawie `protocol_role`, branch id i eventow,
   - wykonaj kolejne kroki `relax/minimize/dynamics_settle`,
   - przy non-convergence zastosuj `on_non_convergence`,
   - zapisz settle trace z kazdego kroku,
   - pobierz average magnetization i convergence stats,
   - dopisz `HysteresisPointResult`,
   - zaktualizuj metryki czastkowe,
   - opublikuj resource invalidation.
3. Nie zapisuj pelnej magnetyzacji w tym etapie.
4. Dla pause:
   - dokonczyc albo bezpiecznie przerwac aktualny solver step,
   - zapisac ostatni zakonczony `point_id`.
5. Dla resume:
   - nie powtarzac zakonczonych punktow,
   - nie generowac drugi raz tych samych point ids.
6. Dla non-convergence:
   - respektowac `on_non_convergence=continue | stop`,
   - punkt oznaczac jako warning/failed,
   - metryki globalne liczyc z ostrzezeniem albo oznaczac niedostepne.

Testy:

- fake runtime przechodzi przez 5 punktow i emituje 5 results,
- pause po punkcie 2 i resume od punktu 3,
- non-convergence continue dopisuje warning,
- non-convergence stop konczy workflow z failed/partial,
- `run_next_algorithm` uruchamia drugi krok pipeline,
- `retry_with_smaller_dt` zmienia resolved dt i zapisuje trace,
- `key_event` uruchamia dokladniejszy minimize tylko dla wskazanych punktow,
- `zero_field_relaxed` dodaje preparation point,
- `positive_saturation` zaczyna od preparation role.

Weryfikacja:

```bash
cargo test -p fullmag-runner hysteresis --no-fail-fast
cargo test -p fullmag-cli hysteresis --no-fail-fast
```

Finalny runtime gate:

```bash
just ensure-managed-fem-runtime
```

Brama produkcyjna:

- `simulation/stages/execution` pokazuje jeden stage histerezy z progress,
- points/metrics istnieja po restarcie/reload sesji, jezeli runtime wspiera
  persistence dla stage state,
- average-only nie tworzy field snapshot artifactow,
- websocket nie niesie listy punktow, tylko invaliduje zasoby.

### Etap D: auto-saturation, minor loops i adaptive refinement

Cel: dodac realne protokoly badawcze, nie tylko prosta liste pol.

Uwaga wykonawcza: `piecewise_segments` i `dense_windows` sa requested schedule
uzytkownika i musza byc wdrozone w Etapie B/G. `adaptive_refinement` w tym
etapie jest dodatkowym automatycznym mechanizmem dodawania punktow po analizie
wynikow. Nie mieszac tych dwoch warstw w provenance ani UI.

#### D.1. Auto-saturation probe

Instrukcja:

1. Dodaj schedule builder dla `SaturationProbe`:
   - start field,
   - increment strategy: linear albo multiplicative,
   - `max_probe_field`,
   - max probe points,
   - thresholds.
2. Probe pass wykonuje settle per point jak normalny punkt, ale `protocol_role`
   to `preparation`.
3. Po kazdym punkcie oblicz:
   - `|dm_parallel/dH|`,
   - `|m_transverse|`,
   - torque/error,
   - distance-to-saturation proxy.
4. Klasyfikuj:
   - `saturated`,
   - `probably_saturated`,
   - `not_saturated`,
   - `capped_by_limit`.
5. Wynik zapisz do `HysteresisSaturationResult`.
6. Jezeli status nie jest `saturated`, runtime nie moze udawac pelnej petli.
   Musi ustawic warning i respektowac policy: stop albo continue-with-warning.

Testy:

- synthetic monotonically saturating data -> `saturated`,
- plateau z duzym torque -> `probably_saturated` albo warning,
- brak saturacji przed limitem -> `capped_by_limit`,
- manual override zapisuje provenance i nie kasuje probe data.

Weryfikacja:

```bash
cargo test -p fullmag-runner hysteresis_saturation --no-fail-fast
cargo test -p fullmag-api hysteresis_saturation --no-fail-fast
```

Brama produkcyjna:

- UI/API widzi probe points,
- wynik `H_sat` ma status, progi i powod decyzji,
- metryki major loop wiedza, czy start byl faktycznie saturated.

#### D.2. Minor loops i recoil branches

Instrukcja:

1. Dodaj branch graph:
   - major branch node,
   - minor loop node,
   - recoil branch node,
   - parent point reference.
2. Schedule minor loop:
   - znajdz parent branch i punkt reversal,
   - jezeli reversal field nie lezy dokladnie na punkcie major branch,
     dodaj punkt interpolowany/extra settle albo oznacz required refinement,
   - wykonaj return field,
   - policz closure error wzgledem parent/return target.
3. Runtime nie moze uruchamiac minor loop od "takiego samego pola" bez sciezki
   dojscia. Musi zachowac historie stanu.
4. Dodaj policy:
   - `branch_only`: minor loop nie zmienia parent branch,
   - `resume_parent`: po minor loop wracamy do snapshotu/stanu parent branch,
   - `replace_parent`: tylko jako explicit advanced mode.
5. Metryki:
   - minor-loop area,
   - recoil susceptibility,
   - closure error,
   - irreversible jump candidates,
   - return-point-memory diagnostics.

Testy:

- minor loop ma osobny `minor_loop_id`,
- reversal/return fields sa w wynikach,
- closure error liczy sie dla zamknietej petli,
- minor loop points nie trafiaja do major-loop coercivity bez jawnego wyboru,
- `branch_only` nie nadpisuje parent branch.

Weryfikacja:

```bash
cargo test -p fullmag-runner hysteresis_minor --no-fail-fast
cargo test -p fullmag-cli hysteresis_minor --no-fail-fast
```

Brama produkcyjna:

- minor loops sa history-dependent,
- branch graph jest widoczny w API,
- chart moze renderowac minor loop bez heurystyk.

#### D.3. Adaptive refinement

Instrukcja:

1. Implementuj refinement jako opcjonalny second-pass scheduler.
2. Trigger points:
   - crossing `m_parallel=0`,
   - duze `dm/dH`,
   - reversal fields,
   - non-convergence,
   - auto-saturation boundary.
3. Kazdy adaptive point ma `adaptive_inserted=true` i `refinement_reason`.
4. Eksport CSV/JSON musi odroznic punkty planowane od adaptacyjnych.
5. Nie wlaczac adaptive refinement domyslnie dla pierwszego production path,
   dopoki reproducibility/export sa stabilne.

Stan implementacji:

- `fm.AdaptiveRefinement(...)` jest publicznym kontraktem Python DSL i
  round-tripuje przez canonical script export,
- `ProblemIR` waliduje progi i kroki adaptacji,
- `/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/plan`
  wystawia `adaptive_refinement`,
- runner generuje kandydatow oraz wykonuje second-pass branch points od stanu
  lewego rodzica odcinka,
- `hysteresis_adaptive_refinement.json` zawiera kandydatow, obliczone punkty,
  `settle_trace`, `adaptive_inserted=true`, `refinement_reason` i snapshot ref
  dla polityk zapisujacych `m`,
- potwierdzony gate:
  `CARGO_TARGET_DIR=/tmp/fullmag-api-zarr-target cargo test -p fullmag-runner adaptive_refinement --no-fail-fast`
  zwrocil `2 passed`.

Testy:

- refinement dodaje punkt miedzy dwoma crossing points,
- refinement nie zmienia oryginalnych point ids,
- metryki uzywaja refined points tylko gdy policy na to pozwala.

Weryfikacja:

```bash
cargo test -p fullmag-runner hysteresis_refinement --no-fail-fast
```

Brama produkcyjna:

- refinement jest odtwarzalny,
- export zachowuje provenance,
- porownanie petli z/bez refinement jest jawnie oznaczone.

### Etap E: artifacty i field snapshots

Cel: pelne magnetyzacje per punkt maja byc opcjonalne, ciezkie i pobierane
przez data plane, bez zasmiecania statusu.

#### E.1. Snapshot policy

Instrukcja:

1. W runtime zaimplementuj polityki:
   - `averages_only`,
   - `selected_points`,
   - `every_n_points`,
   - `key_events`,
   - `every_step`.
2. `key_events` obejmuje:
   - turning points,
   - `H=0`,
   - `H_sat+/-`,
   - reversal/return fields,
   - high `dm/dH`,
   - non-convergence warning,
   - manual bookmark.
3. Snapshot decision musi byc pure function testowana bez backendu:
   `should_store_snapshot(point, metrics, policy)`.
4. Snapshot ref ma zawierac:
   - `snapshot_id`,
   - `stage_id`,
   - `point_id`,
   - `branch_id`,
   - `quantity_id="m"`,
   - `mesh_identity`,
   - `field_revision`,
   - `component_count`,
   - `precision`,
   - `storage_format`,
   - artifact path optional.
5. `every_step` jest produkcyjnym odpowiednikiem klasycznego playbacku petli
   histerezy: kazdy zrelaksowany punkt pola musi miec odtwarzalna klatke
   magnetyzacji `m`, tak aby UI moglo przewijac ewolucje domen magnetycznych
   punkt po punkcie.
6. `H_demag`, `H_eff` i inne pola wektorowe nie sa wymagane dla podstawowej
   petli, MVP ani dla produkcyjnego playbacku. To sa dodatki diagnostyczne:
   dodaj je jako jawna liste `auxiliary_field_snapshots`, domyslnie pusta, z
   walidacja quantity ids, storage estimate i ostrzezeniem o koszcie
   recompute/sync. Nie mieszac ich z obowiazkowa polityka magnetyzacji `m`.

Testy:

- `averages_only` nie zapisuje zadnego snapshotu,
- `every_n=3` zapisuje punkty 0,3,6 albo jasno zdefiniowana konwencje,
- `key_events` zapisuje reversal, H=0 i warning,
- `every_step` zapisuje wszystkie punkty `m` i ostrzega storage estimate,
- auxiliary field snapshots sa nieobecne domyslnie, a jawne
  `["H_demag", "H_eff"]` zapisuje tylko wtedy, gdy backend potrafi dostarczyc
  te pola bez ukrytego fallbacku; brak tych kanalow nie blokuje produkcyjnego
  playbacku `m`.

Weryfikacja:

```bash
cargo test -p fullmag-runner hysteresis_snapshot_policy --no-fail-fast
```

Brama produkcyjna:

- polityka snapshotow jest deterministyczna,
- storage estimate jest zgodny z faktyczna liczba snapshotow,
- GPU path raportuje sync cost w provenance.

#### E.2. Artifact pipeline i data plane

Instrukcja:

1. Uzyj istniejacego artifact pipeline i docelowego kontenera danych:
   - `crates/fullmag-runner/src/artifact_pipeline.rs`,
   - `crates/fullmag-runner/src/artifacts.rs`,
   - backend-specific field snapshot helpers.
2. Pelne klatki `m` dla wielu punktow pola nie moga byc docelowo zapisywane
   jako wielkie tablice JSON `values`. JSON zostaje dla manifestow,
   `hysteresis_points.json`, metryk i kompatybilnych pojedynczych field-state
   importow. Domyslny format produkcyjny dla sekwencji klatek to Zarr; HDF5
   jest formatem eksportowym/portable. Minimalny layout:
   - `hysteresis.zarr` albo `hysteresis.h5`,
   - dataset `/fields/m` o wymiarach `[point, component, spatial_sample]`,
   - opcjonalne `/fields/H_demag`, `/fields/H_eff` tylko gdy jawnie zazadane,
   - tabela/index `/points` laczaca `snapshot_id`, `point_id`, `branch_id`,
     `field_value_mT`, `mesh_identity`, `field_revision` i offset w dataset,
   - atrybuty/provenance: units, component order, precision, backend,
     discretization, quantity semantics, storage policy.
3. Nie tworzyc osobnej publicznej rodziny endpointow dla snapshotow pol, jezeli
   `data/fields/m/samples/vector?snapshot_id=...` wystarcza.
4. Rozszerz API field resolution:
   - `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`,
   - `crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs`,
   aby rozpoznawaly `snapshot_id`.
5. `analysis/hysteresis/{stage_id}/steps/{point_id}` zwraca `snapshot_ref`,
   a nie field values.
6. `data/fields/m/meta?snapshot_id=...` zwraca shape, mesh identity, stale
   status i available components.
7. `data/fields/m/samples/vector?snapshot_id=...&format=bin` zwraca binary
   payload kompatybilny z istniejacym `fieldVectorCodec.ts`.
8. Dodaj testy malformed/unknown snapshot:
   - 404 dla nieistniejacego snapshotu,
   - 409 albo diagnostic warning dla mesh mismatch,
   - 400 dla snapshotu quantity innego niz `m`.

Weryfikacja:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-runner storage_policy_controls_hysteresis_snapshot_capture
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-runner stored_hysteresis_snapshot_contains_vector_magnetization_payload
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api field_vector_snapshot_id_loads_persisted_hysteresis_magnetization
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api field_meta_snapshot_id_reports_persisted_hysteresis_magnetization_stats
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api hysteresis_snapshot_can_be_applied_as_field_state_initial_magnetization
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api hysteresis_snapshot_container_index_resolves_point_frame
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api field_vector_snapshot_id_rejects_unknown_malformed_and_wrong_quantity
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api field_meta_snapshot_id_rejects_unknown_malformed_and_wrong_quantity
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api field_vector_snapshot_id_conflicts_when_zarr_frame_mismatches_domain
CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api field_meta_snapshot_id_conflicts_when_zarr_frame_mismatches_domain
```

Brama produkcyjna:

- `status` nie inline'uje pol,
- field payload idzie przez `data/fields`,
- binary payload dekoduje sie istniejacym frontend codec,
- artifact manifest i analysis step zgadzaja sie po `snapshot_id`.

### Etap F: OpenAPI v2, ControlRoomApi, resource hooks

Cel: browser ma konsumowac typed resources. Nie wolno ominac OpenAPI ani
pisac ad-hoc transportu w UI.

#### F.1. Backend routes i schemas

Instrukcja:

1. Dodaj schemas w `crates/fullmag-api/src/schemas/`:
   - `hysteresis.rs` albo sekcje w `runtime.rs`/`fields.rs`, jezeli repo ma
     ustalony pattern,
   - typy plan/protocol/orientation/saturation/settle-pipeline/progress/
     execution-tree/points/metrics/settle-trace.
2. Podlacz schemas w `crates/fullmag-api/src/schemas/mod.rs`.
3. Dodaj handlery:
   - `crates/fullmag-api/src/router_v2/handlers/analysis.rs` albo
     `handlers/analysis/hysteresis.rs`,
   - `crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs` dla
     plan/progress resources, jezeli taka jest lokalna konwencja.
4. Podlacz routes w `crates/fullmag-api/src/router_v2/mod.rs`.
5. Dodaj OpenAPI definitions w `crates/fullmag-api/src/openapi_v2.rs`.
6. Dodaj tests w `crates/fullmag-api/src/router_v2/tests.rs`:
   - kazdy endpoint happy path,
   - unknown stage id,
   - stage without hysteresis,
   - partial run,
   - settle pipeline resource,
   - execution tree resource,
   - settle trace for point,
   - stale/no snapshot,
   - OpenAPI path contains endpoints.

Weryfikacja:

```bash
cargo test -p fullmag-api hysteresis --no-fail-fast
cargo test -p fullmag-api router_v2 --no-fail-fast
```

Brama produkcyjna:

- endpoints sa w `/v2/sessions/current/...`,
- `analysis/hysteresis` i `data/fields` maja rozdzielona odpowiedzialnosc,
- OpenAPI zawiera wszystkie nowe paths i schemas,
- bledy maja stabilne kody i komunikaty.

#### F.2. Generated frontend transport i facade

Instrukcja:

1. Wygeneruj v2 frontend contract zgodnie z lokalna komenda repo. Dla
   `apps/control-room` sprawdz:

```bash
rg -n "generate:api|openapi-v2" apps/control-room/package.json apps/control-room/scripts
```

2. Po generacji sprawdz pliki:
   - `apps/control-room/src/kernel/api/generated/openapi-v2.json`,
   - `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`,
   - `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`,
   - `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts`.
3. Rozszerz `apps/control-room/src/kernel/api/ControlRoomApi.ts`:
   - `api.analysis.hysteresis.plan(stageId)`,
   - `protocol(stageId)`,
   - `orientation(stageId)`,
   - `saturation(stageId)`,
   - `settlePipeline(stageId)`,
   - `executionTree(stageId)`,
   - `points(stageId)`,
   - `metrics(stageId)`,
   - `branches(stageId)`,
   - `minorLoops(stageId)`,
   - `step(stageId, pointId)`,
   - `settleTrace(stageId, pointId)`,
   - field snapshot helpers przez existing `data.fields`.
4. Rozszerz `apps/control-room/src/kernel/api/apiPaths.ts` tylko jezeli lokalny
   pattern wymaga centralnych path constants.
5. Dodaj testy w `ControlRoomApi.test.ts` i
   `openapiV2GeneratedContract.test.ts`.
6. Dodaj resource hooks/cache w `apps/control-room/src/kernel/resources/`,
   najlepiej obok `studyRuntimeResources.ts` albo w nowym
   `hysteresisResources.ts`, jezeli odpowiedzialnosc jest wyraznie osobna.
7. Resource keys musza byc stabilne:
   - `analysis/hysteresis/{stage_id}/points`,
   - `analysis/hysteresis/{stage_id}/metrics`,
   - `simulation/stages/{stage_id}/hysteresis/execution-tree`,
   - `data/fields/m/samples/vector?snapshot_id=...`.

Weryfikacja:

```bash
pnpm --dir apps/control-room test -- ControlRoomApi
pnpm --dir apps/control-room test -- openapiV2GeneratedContract
pnpm --dir apps/control-room typecheck
```

Brama produkcyjna:

- nie ma recznie skladanych endpointow w komponentach,
- generated files sa wynikiem generacji, nie recznej edycji,
- resource hooks obsluguja loading/error/stale states,
- cache invalidation uzywa resource keys zgodnych z realtime events.

#### F.3. Realtime invalidation

Instrukcja:

1. Dodaj event/resource mapping w backend realtime policy, szukaj:

```bash
rg -n "resource_key|invalidation|recommended_fetch|events" crates/fullmag-api/src apps/control-room/src/kernel
```

2. Eventy:
   - `simulation.stage.hysteresis.plan_updated`,
   - `simulation.stage.hysteresis.protocol_updated`,
   - `simulation.stage.hysteresis.saturation_probe_updated`,
   - `simulation.stage.hysteresis.point_completed`,
   - `analysis.hysteresis.points_updated`,
   - `analysis.hysteresis.metrics_updated`,
   - `analysis.hysteresis.minor_loop_updated`,
   - `data.fields.snapshot_published`.
3. Event payload zawiera tylko ids, revisions i recommended fetch.
4. Dodaj frontend tests na invalidation bridge/resource runtime store.

Weryfikacja:

```bash
cargo test -p fullmag-api hysteresis_invalidation --no-fail-fast
pnpm --dir apps/control-room test -- studyRuntimeResources
```

Brama produkcyjna:

- websocket nie niesie punktow ani pol,
- reload strony odzyskuje stan z HTTP,
- stale resources odswiezaja sie po eventach.

### Etap G: Control Room authoring, inspector i explorer

Cel: UI ma byc pelnym narzedziem planowania eksperymentu, ale stan fizyczny
pozostaje w model/API, nie w lokalnych store komponentow.

#### G.1. Authoring model

Instrukcja:

1. Rozszerz `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts`.
2. Dodaj pola draft:
   - `protocolKind`,
   - `initialStatePolicy`,
   - `orientationMode`,
   - `thetaDeg`,
   - `phiDeg`,
   - `customDirection`,
   - `measurementAxis`,
   - `fieldScheduleMode`,
   - `fieldSegments`,
   - `denseWindows`,
   - `saturationMode`,
   - `maxProbeField`,
   - `saturationThresholds`,
   - `settlePipelineMode`,
   - `settleSteps`,
   - `settleBranches`,
   - `minorLoops`,
   - `storagePolicy`.
   `fieldSegments` nie jest pojedynczym `min/max/step`, tylko edytowalna
   tabela przedzialow. Kazdy wiersz musi miec:
   - `segmentId`,
   - `label`,
   - `startField`,
   - `stopField`,
   - `step`,
   - `unit`,
   - `endpointPolicy`,
   - `reason`.
   Minimalny scenariusz UI musi pozwalac ustawic np.:
   - `+1.0 T -> +0.2 T, step 50 mT, reason=coarse_start`,
   - `+0.2 T -> -0.05 T, step 5 mT, reason=dense_after_remanence`,
   - `-0.05 T -> -1.0 T, step 25 mT, reason=negative_branch`.
3. `createStudyStageDraft(...)` musi czytac:
   - nowy canonical payload,
   - stary legacy payload `start_field/stop_field/field_steps`.
4. `studyStageDraftToSceneStage(...)` musi emitowac canonical payload.
5. `validateStudyStageDraft(...)` musi raportowac:
   - brak kata/ramy,
   - zero vector,
   - sprzeczny zakres/krok,
   - segment pola z zerowym krokiem,
   - segment pola ze zlym znakiem kroku,
   - duplikaty graniczne bez endpoint policy,
   - dense windows bez priority przy nakladaniu,
   - positive saturation bez manual/auto policy,
   - pusty settle pipeline,
   - brak wymaganych parametrow algorytmu,
   - nielegalny fallback albo applies-to,
   - minor loop poza zakresem,
   - every_step bez storage estimate acknowledgement.
6. Nie przechowywac resource data w draft store. Draft to tylko niezapisana
   edycja authoringu.

Testy:

- canonical draft round-trip,
- legacy payload migration,
- OOP/IP/custom angle validation,
- piecewise field schedule editor serialization,
- piecewise schedule with coarse start and dense after-remanence interval,
- dense windows editor serialization,
- schedule preview point count and boundary deduplication,
- settle pipeline sequence/tree serialization,
- relax/minimize parameter validation,
- applies-to/fallback validation,
- minor-loop editor serialization,
- storage policy validation,
- start from checkpoint preserves snapshot id.

Weryfikacja:

```bash
pnpm --dir apps/control-room test -- StudyStageAuthoringModel
pnpm --dir apps/control-room typecheck
```

Brama produkcyjna:

- UI i Python export tworza ten sam semantic payload,
- legacy sceny dalej sie otwieraja,
- walidacja UI zgadza sie z walidacja Rust w nazwach pol i intencji.

#### G.2. Inspector UI

Instrukcja:

1. Rozszerz `apps/control-room/src/modules/inspector/panels/stages/HysteresisStageInspector.tsx`.
2. Jezeli komponent rosnie powyzej czytelnosci, podziel na lokalne komponenty:
   - `HysteresisProtocolSection`,
   - `HysteresisOrientationSection`,
   - `HysteresisFieldScheduleSection`,
   - `HysteresisSaturationSection`,
   - `HysteresisSettlePipelineSection`,
   - `HysteresisSettleTraceSection`,
   - `HysteresisMinorLoopsSection`,
   - `HysteresisStorageSection`,
   - `HysteresisLiveSection`,
   - `HysteresisMetricsSection`,
   - `HysteresisPointsSection`.
   Pliki zostaja w module `inspector`; nie importowac internali
   `analysis-plots` ani `viewport-3d`.
3. Uzyj shared primitives istniejących w inspector:
   - `FormField`,
   - `Vector3Field`,
   - `InspectorSection`,
   - `FieldRow`,
   - shared shadcn-style controls, jezeli sa w repo.
4. Dodaj preview schedule jako lekki model SVG/canvas tylko dla planu. Nie
   pobierac runtime points z lokalnego stanu.
5. `HysteresisFieldScheduleSection` musi obslugiwac:
   - prosty min/max/step,
   - explicit values,
   - piecewise segments,
   - dense windows,
   - endpoint policy,
   - priority/order dla nakladajacych sie okien,
   - preview liczby punktow per segment i globalnie,
   - wizualne oznaczenie segmentow geste/srednie/rzadkie bez zmiany danych
     fizycznych,
   - ostrzezenia o duplikatach, dziurach i odwroconym znaku kroku.
6. Sekcje live/metrics/points czytaja resource hooks, nie scene draft.
7. `HysteresisSettlePipelineSection` musi obslugiwac:
   - dodanie kroku `Relax`,
   - dodanie kroku `Minimize`,
   - dodanie kroku `Dynamics settle` jezeli capability pozwala,
   - zmiane kolejnosci krokow,
   - edycje parametrow kazdej metody,
   - edycje `stop_criteria`,
   - edycje `applies_to`,
   - edycje fallback policy,
   - pokaz resolved defaults z planu.
8. `HysteresisSettleTraceSection` pokazuje trace dla wybranego punktu z
   resource `steps/{point_id}/settle-trace`.
9. Akcje:
   - `Estimate saturation`,
   - `Accept saturation`,
   - `Override saturation`,
   - `Add minor loop`,
   - `Load in 3D`,
   - `Use as initial state`,
   ida przez command registry.

Testy:

- renders protocol/orientation controls,
- shows validation errors,
- edits piecewise schedule and dense windows,
- preview shows per-segment point counts,
- shows saturation result states,
- edits settle pipeline and validates method params,
- shows settle trace for selected point,
- renders minor-loop table,
- `Load in 3D` dispatches command id, not direct viewport call,
- no cross-module imports.

Weryfikacja:

```bash
pnpm --dir apps/control-room test -- HysteresisStageInspector
rg -n "from ['\\\"].*modules/(analysis-plots|viewport-3d)" apps/control-room/src/modules/inspector
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint --max-warnings=0
```

Brama produkcyjna:

- inspector jest w pelni uzywalny bez wykresu,
- brak text overflow w podstawowych stanach,
- controls maja jednoznaczne jednostki,
- kazda mutacja idzie przez model transaction/command.

#### G.3. Explorer i commands

Instrukcja:

1. Rozszerz:
   - `apps/control-room/src/modules/explorer/builders/study/hysteresisStageNode.ts`,
   - `studyExplorerNodes.ts`,
   - `explorerTypes.ts`,
   aby stage mial dzieci `Protocol`, `Saturation`, `Branches`, `Minor Loops`,
   `Points`, `Metrics`, `Snapshots`.
2. Dodaj model runtime tree:
   - `HysteresisExecutionTreeResource`,
   - `HysteresisExecutionTreeNode`,
   - `HysteresisFieldPointNode`,
   - `HysteresisSettleAlgorithmNode`,
   - `HysteresisTransitionNode`.
   Typy moga mieszkac w kernel resource/domain adapter albo w explorer model,
   ale server resource snapshot jest zrodlem prawdy.
3. `HysteresisExecutionTreeNode` musi miec:
   - stable `node_id`,
   - `kind`: stage, protocol, saturation, field_point, settle_algorithm,
     snapshot, metric, transition,
   - `stage_id`,
   - `point_id` optional,
   - `settle_step_id` optional,
   - `status`: queued, active, done, conditional, warning, failed, skipped,
   - `label`,
   - `resource_ref`,
   - `selection_ref`,
   - `updated_revision`.
4. Explorer builder ma laczyc:
   - statyczne authoring nodes z model tree,
   - live execution nodes z resource
     `simulation/stages/{stage_id}/hysteresis/execution-tree?window=active`,
   bez kopiowania runtime state do module store.
5. Nie renderowac wszystkich punktow pola w Explorerze. Dla 100 krokow,
   1000 krokow albo adaptive refinement Explorer ma uzywac:
   - aktywnego okna `before/after`,
   - summary range nodes, np. `Completed +1.000 T ... +0.740 T, 66 points`,
   - osobnych wezlow dla warning/key event/bookmark/snapshot,
   - pelnej tabeli Points dla szczegolow.
6. Resource `execution-tree` powinien przyjmowac query:
   - `window=active`,
   - `before`,
   - `after`,
   - `include_bookmarks=true`,
   - `include_warnings=true`,
   - `include_snapshots=true`,
   i zwracac tylko widoczne wezly plus summary ranges.
7. Przyklad renderowania:
   - `Hysteresis 1`,
   - `Completed +1.000 T ... +0.990 T, 6 points done`,
   - `H = +0.980 T`,
   - `relax llg_overdamped` status done,
   - `minimize nonlinear_cg` status active,
   - `snapshot m` status stored,
   - `Continue to next stage` status available po zakonczeniu.
8. Status colors:
   - nie uzywac raw hex,
   - mapowac status na semantic class/token, np.
     `fm-explorer-node--done`, `fm-explorer-node--active`,
     `fm-explorer-node--warning`, `fm-explorer-node--failed`,
   - zielony status `done` jest semantyczny, nie twardo zakodowany.
9. Dynamiczne zmiany:
   - gdy pole przechodzi z `H=+1.000 T` do `H=+0.980 T`, aktywny node pola
     zmienia status przez invalidacje resource,
   - gdy fallback dodaje nowy algorytm, Explorer dopisuje nowy child node z
     `fallback_reason`,
   - zakonczone algorytmy zostaja w audit trail zasobu punktu, ale Explorer
     pokazuje je tylko dla aktywnego/przypietego/warningowego punktu,
   - adaptive points pojawiaja sie jako nowe field point nodes z flaga
     `adaptive_inserted`, albo jako summary range jezeli sa poza aktywnym
     oknem.
10. Po zakonczeniu stage dodaj `Transitions`:
   - `Continue to next stage`,
   - `Use selected point as initial state`,
   - `Export loop CSV`,
   - `Open snapshots`,
   ale akcje nadal ida przez command registry.
11. Rozszerz selection routing w `explorerSelection.ts` i
   `StudyStageInspectorRouter.tsx`.
12. Dodaj command contributions w:
   - `apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts`,
   - `studyRuntimeCommandAdapters.ts`,
   - ribbon contributions, jezeli komendy sa widoczne w ribbon.
13. Kazda komenda ma:
   - id,
   - label,
   - capability gate,
   - target validation,
   - completion/rejection message,
   - invalidated resources.

Testy:

- explorer tree zawiera nowe dzieci,
- explorer renderuje live execution tree z field point -> settle algorithm
  children,
- explorer nie renderuje wszystkich 100 punktow; pokazuje aktywne okno,
  summary ranges i bookmark/key-event/warning nodes,
- zmiana aktywnego pola przesuwa okno bez utraty selected point,
- active algorithm changes after resource invalidation,
- fallback algorithm appears without deleting previous trace,
- completed point poza oknem trafia do summary range, chyba ze jest pinned,
  warning, key event albo snapshot,
- transitions appear after stage completion,
- selection route otwiera wlasciwa sekcje inspectora,
- commands sa zarejestrowane,
- command adapter generuje poprawny backend command,
- ribbon pokazuje tylko legalne akcje.

Weryfikacja:

```bash
pnpm --dir apps/control-room test -- explorer
pnpm --dir apps/control-room test -- studyExplorerNodes
pnpm --dir apps/control-room test -- studyRuntimeCommand
pnpm --dir apps/control-room test -- ribbon
rg -n "fm-explorer-node--done|fm-explorer-node--active|fm-explorer-node--warning|fm-explorer-node--failed" apps/control-room/src/modules/explorer apps/control-room/src/design/styles
```

Brama produkcyjna:

- nie ma stage-specific callback props miedzy modulami,
- live execution tree pochodzi z resource hooks/cache, a nie z module store,
- expanded/collapsed nodes sa jedynym lokalnym stanem Explorera dla tego
  drzewa,
- Explorer ma test na petle 100+ punktow, ktory potwierdza ograniczona liczbe
  renderowanych wezlow,
- command registry jest jedynym sposobem uruchamiania akcji,
- unsupported backend/device pokazuje wyjasnienie zamiast cichego disabled.

### Etap H: analysis-plots i live wykresy

Cel: wykres jest analiza danych, nie drugim silnikiem obliczen. Nie liczy
fizyki, tylko renderuje zasoby i lokalne widoki.

#### H.1. Model danych wykresu

Instrukcja:

1. Rozszerz `apps/control-room/src/modules/analysis-plots/analysisPlotsModel.ts`
   albo dodaj lokalny `hysteresisChartModel.ts`.
2. Dodaj typy:
   - `HysteresisChartPoint`,
   - `HysteresisSeries`,
   - `HysteresisBranchView`,
   - `HysteresisMarker`.
3. Adapter bierze dane z resource hookow:
   - points,
   - metrics,
   - branches,
   - minor loops.
4. Nie agreguj automatycznie galezi. Uzytkownik wybiera widok:
   - Virgin,
   - Forward,
   - Return,
   - Minor loops,
   - Full loop,
   - RGB overlay,
   - OOP/IP overlay,
   - Angular family.
5. `RGB overlay` renderuje komponenty `m_x/m_y/m_z`, a branch separation
   pozostaje w danych.
6. Markery:
   - `H_c`,
   - `M_r`,
   - `H_sat`,
   - reversal/return fields,
   - adaptive points,
   - non-convergence warnings.

Testy:

- branch data maps to separate series,
- full loop keeps branch identity,
- minor loops do not merge into major loop by default,
- missing metrics render warning not crash,
- markers align with source point ids.

Weryfikacja:

```bash
pnpm --dir apps/control-room test -- analysisPlot
pnpm --dir apps/control-room test -- chartOption
```

Brama produkcyjna:

- chart mozna odtworzyc po reload z HTTP resources,
- tooltip pokazuje protocol/branch/point id,
- brak implicit mean/median/first aggregation.

#### H.2. Live append i selection

Instrukcja:

1. Resource hook odswieza points po invalidacji.
2. Chart nie dopisuje lokalnych punktow "na slepo"; po event zawsze odczytuje
   z HTTP resource albo cache z potwierdzona revision.
3. Selection point:
   - ustawia workspace selection `analysis.chart-point`,
   - zawiera `stage_id`, `point_id`, `snapshot_id` optional,
   - nie importuje viewport module.
4. `Load in 3D` i `Use as initial state` ida przez command registry.
5. Dodaj brush/zoom jako module-local UI state, nie jako server resource.

Testy:

- invalidation refreshes points,
- selecting point updates workspace selection,
- command dispatch uses selected point,
- chart survives partial data.

Weryfikacja:

```bash
pnpm --dir apps/control-room test -- analysisPlots
pnpm --dir apps/control-room typecheck
```

Brama produkcyjna:

- live wykres nie dryfuje wzgledem API,
- po reload wybor punktu moze zostac odtworzony, jezeli selection persistence
  to wspiera,
- chart module nie importuje inspectora ani viewportu.

### Etap I: 3D replay punktow histerezy

Cel: dowolny policzony punkt z zapisanym snapshotem mozna pokazac w 3D jako
read-only result state. To nie mutuje modelu ani initial magnetization.

#### I.1. Resource target i field loading

Instrukcja:

1. Rozszerz model targetow w:
   - `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.ts`,
   - `viewport3dResources.ts`,
   - `viewport3dDomainAdapter.ts`.
2. Dodaj target:
   `hysteresis-step:{stage_id}:{point_id}` z polami:
   - `snapshot_id`,
   - `quantity_id="m"`,
   - `mesh_identity`,
   - `field_orientation`,
   - `measurement_axis`,
   - `field_revision`.
3. Field fetch idzie przez `ControlRoomApi.data.fields.vector(...)` z
   `snapshot_id`, nie przez osobny ad-hoc endpoint.
4. Jezeli snapshotu brak:
   - viewport pokazuje czytelny empty/degraded state,
   - inspector/chart proponuje "snapshot not stored",
   - nie probuje odtworzyc pola ze sredniej magnetyzacji.
5. Jezeli mesh mismatch:
   - blokuj render,
   - pokaz wymagany mesh identity,
   - remap jako przyszla jawna akcja, nie automatyczny fallback.

Testy:

- target parser/builders,
- resource key includes snapshot id,
- missing snapshot gives degraded state,
- mesh mismatch blocks render,
- field vector codec handles snapshot payload.

Weryfikacja:

```bash
pnpm --dir apps/control-room test -- viewport3DTargets
pnpm --dir apps/control-room test -- viewport3dResources
pnpm --dir apps/control-room test -- viewport3dDomainAdapter
pnpm --dir apps/control-room test -- fieldVectorCodec
```

Brama produkcyjna:

- read-only result layer nie zmienia authored model,
- field/topology revisions sa osobne,
- WebGL resources sa zwalniane przy zmianie targetu.

#### I.2. Glyph pola, os pomiaru i scrubber

Instrukcja:

1. Dodaj domain-neutral render model dla glyphow:
   - field direction arrow,
   - sample normal,
   - measurement axis,
   - optional label `H = ... mT`, `theta`, `phi`.
2. Warstwa glyphow moze byc w `viewport-3d/layers/`, ale jej model danych
   musi byc generowany w adapterze, nie w komponencie chart.
3. Dodaj scrubber:
   - UI control moze mieszkac w analysis chart albo inspector,
   - zmiana punktu dispatchuje command/selection,
   - viewport tylko reaguje na resource target.
4. Keyboard navigation:
   - lewo/prawo zmienia aktywny punkt tylko gdy chart/scrubber ma focus,
   - nie przechwytuje globalnych shortcutow.

Testy:

- glyph model dla OOP/IP/custom angle,
- scrubber emits point selection,
- keyboard navigation respects focus,
- viewport scene contains glyph layer when target has orientation.

Weryfikacja:

```bash
pnpm --dir apps/control-room test -- viewport3dRenderModel
pnpm --dir apps/control-room test -- Viewport3DScene
pnpm --dir apps/control-room test -- analysisPlots
```

Browser gate:

```bash
pnpm --dir apps/control-room exec next dev -p 3101
CONTROL_ROOM_URL=http://localhost:3101/workspace CONTROL_ROOM_SCREENSHOT_SCENES=fdm pnpm --dir apps/control-room screenshot:viewport-3d
CONTROL_ROOM_URL=http://localhost:3101/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
```

Brama produkcyjna:

- screenshot pokazuje niepusty canvas,
- `gl.isContextLost()` nie jest true po zaladowaniu punktu,
- drawing buffer ma niezerowe wymiary,
- glyph H/measurement axis nie zaslania glownego obiektu.

### Etap J: produkcyjna walidacja naukowa

Cel: udowodnic, ze workflow nadaje sie do badan, a nie tylko przechodzi testy
UI.

#### J.1. Zestaw referencyjny

Instrukcja:

1. Dodaj male przyklady albo test fixtures:
   - makrospin/Stoner-Wohlfarth OOP,
   - makrospin custom angle,
   - thin film OOP,
   - thin strip in-plane,
   - simple minor loop,
   - insufficient saturation limit.
2. FDM CPU jest pierwszym oracle.
3. FEM CPU/GPU walidacje dodawac po potwierdzeniu ich lane support, nie
   deklarowac jako done na podstawie FDM.
4. Kazdy fixture ma zapisac:
   - input script,
   - expected qualitative behavior,
   - tolerances,
   - expected warnings,
   - expected artifact/resource ids.

Testy:

- `H_c(theta)` trend dla makrospin,
- OOP vs IP ma rozny ksztalt petli dla thin film,
- insufficient field daje `not_saturated` albo `capped_by_limit`,
- minor loop ma nonzero closure diagnostics,
- average from full snapshot matches stored `m_avg` within tolerance.

Weryfikacja:

```bash
cargo test -p fullmag-runner hysteresis_validation --no-fail-fast
python3 -m pytest packages/fullmag-py/tests/test_api.py -q
```

FEM/container gate, gdy etap dotyka FEM:

```bash
just ensure-managed-fem-runtime
```

Status wykonania:

- Zamkniety pierwszy fixture kontraktu projekcji runtime: maly FEM waveguide
  uruchamia `ip_x`, `oop` i `custom_theta45_phi30`, a
  `scripts/verify_hysteresis_projection_benchmark.py` sprawdza skladowe
  `m_parallel`, `m_oop` i `m_ip` bez zaleznosci od UI. To nie zamyka jeszcze
  makrospin/Stoner-Wohlfarth, OOP thin-film ani IP strip physics fixtures.
- Zamkniety fixture niewystarczajacego pola saturacji: target
  `just run-hysteresis-waveguide-saturation-limit-smoke cpu` uruchomil sesje
  `session-1781258014197-2056303`, a
  `just verify-hysteresis-saturation-limit .fullmag/local-live/history/session-1781258014197-2056303/artifacts`
  potwierdzil `status=capped_by_limit`, trzy punkty probe i zgodnosc
  `hysteresis_saturation.json` z `hysteresis_metrics.json`.
- Zamkniety prosty fixture minor-loop: target
  `just run-hysteresis-waveguide-minor-loop-smoke cpu` uruchomil sesje
  `session-1781258187258-2062365`, a
  `just verify-hysteresis-minor-loop .fullmag/local-live/history/session-1781258187258-2062365/artifacts`
  potwierdzil `loop_id=minor_loop_001`, polityke `branch_only`, dwa punkty
  lokalnej galezi oraz dedykowany `settle_trace`.

Brama produkcyjna:

- kazda lane ma jawny status: validated, supported-with-warning, unsupported,
- brak ukrytego fallbacku backend/device/precision,
- tolerancje sa zapisane i uzasadnione.

#### J.2. End-to-end acceptance

Instrukcja:

1. Przygotuj jeden maly workspace/session, ktory:
   - tworzy model,
   - dodaje hysteresis major loop OOP,
   - uruchamia average-only,
   - pokazuje live chart,
   - zapisuje key-event snapshots,
   - laduje jeden punkt do 3D.
2. Przygotuj drugi scenariusz:
   - in-plane custom angle,
   - auto-saturation,
   - minor loop,
   - no every-step snapshots.
3. Smoke ma sprawdzic:
   - stage visible in Explorer,
   - Inspector pokazuje protocol/orientation/saturation,
   - chart ma punkty,
   - metrics maja status,
   - 3D load point dziala tylko dla punktu ze snapshotem,
   - point without snapshot pokazuje controlled empty state.

Weryfikacja:

```bash
pnpm --dir apps/control-room test
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint --max-warnings=0
CONTROL_ROOM_URL=http://localhost:3101/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
```

Brama produkcyjna:

- testy jednostkowe i kontraktowe przechodza,
- screenshot/smoke potwierdza viewport,
- docs i OpenAPI sa zsynchronizowane,
- znane ograniczenia sa widoczne w capability/status/provenance,
- zadna funkcja nie wymaga recznego wpisywania endpointu albo ukrytego pliku.

### Etap K: release checklist i regresja

Przed uznaniem modulu za produkcyjny wykonac pelna liste:

1. Dokumenty:
   - physics note kompletna,
   - API spec zaktualizowana,
   - frontend chart/module spec zaktualizowana,
   - plan aktywny ma odhaczone etapy albo link do completed report.
2. Python:
   - DSL helpery,
   - legacy compatibility,
   - script export,
   - tests.
3. Rust:
   - IR validation,
   - planner schedule,
   - settle pipeline/tree,
   - settle execution trace,
   - runtime average-only,
   - auto-saturation,
   - minor loops,
   - snapshot policy,
   - API routes.
4. Frontend:
   - generated OpenAPI,
   - `ControlRoomApi`,
   - resource hooks,
   - inspector,
   - explorer,
   - commands/ribbon,
   - analysis chart,
   - viewport target/glyph.
5. Data:
   - scalar history,
   - analysis points/metrics,
   - artifact index,
   - field snapshot binary path,
   - export CSV/JSON.
6. Quality gates:

```bash
python3 -m pytest packages/fullmag-py/tests/test_api.py -q
cargo test -p fullmag-ir hysteresis --no-fail-fast
cargo test -p fullmag-cli hysteresis --no-fail-fast
cargo test -p fullmag-runner hysteresis --no-fail-fast
cargo test -p fullmag-api hysteresis --no-fail-fast
pnpm --dir apps/control-room test
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint --max-warnings=0
```

7. Runtime gates:
   - FDM CPU reference scenario,
   - FDM GPU scenario, jezeli marked supported,
   - FEM CPU/GPU przez container-backed `just`, jezeli marked supported.
8. Browser gates:
   - chart visible with live points,
   - inspector no overflow,
   - viewport 3D nonblank for snapshot,
   - missing snapshot state controlled,
   - WebGL context stable.
9. Negative gates:
   - no direct component `fetch(`,
   - no new `/v1/live/current`,
   - no heavy arrays in status,
   - no hidden backend fallback,
   - no unscoped snapshot load,
   - no minor-loop points mixed into major-loop metrics silently.

## Ryzyka

1. Storage explosion: `every_step` dla duzych siatek moze szybko wygenerowac
   setki GB. Wymagany estimate gate.
2. Mylace jednostki: UI w mT/T, IR w SI. Wymagany display-unit provenance.
3. Falszywa koercja: petla bez nasycenia albo bez przeciecia zera nie moze
   produkowac pewnego `H_c`.
4. Mieszanie galezi: forward/return/full loop/RGB overlay musza wynikac z
   branch metadata.
5. Snapshot jako model state: `Load in 3D` nie moze mutowac authored initial
   magnetization.
6. Realtime overload: eventy invaliduja zasoby, nie niosa pelnych pol.
7. GPU sync cost: pelne snapshoty z GPU musza byc jawnie policzone w
   provenance i UI estimate.
8. Mesh drift: snapshot starej topologii nie moze byc pokazany jako zgodny z
   nowym meshem bez jawnego remap.
9. Pomieszanie protokolow: virgin curve, major loop po saturacji i minor loop
   nie moga miec tych samych etykiet metryk bez provenance.
10. Bledna rama kata: OOP/IP/custom angle musi byc zwiazany z sample/object
   frame, nie tylko z globalnym XYZ.
11. Falszywa saturacja: auto-detection moze zatrzymac sie na metastabilnym
   plateau. Wynik musi miec status i progi, a nie bezwarunkowe `H_sat`.
12. Minor loops sa history-dependent: runtime musi zachowac sciezke dojscia do
   reversal field; nie wolno startowac minor loop od zrelaksowanego stanu z
   tym samym polem, jezeli protokol zaklada pamiec materialu.
13. Adaptive refinement moze zmienic porownywalnosc petli. Punkty dodane
   adaptacyjnie musza byc oznaczone i eksportowane.
14. Dynamiczna petla nie jest quasistatyczna. Sweep-rate-dependent hysteresis
   musi miec osobny protokol i inne ostrzezenia metryk.

## Kryteria zakonczenia

Modul jest gotowy dopiero gdy:

- Python i UI eksportuja ten sam canonical hysteresis stage,
- stage ma jawny protocol, orientation, initial_state_policy i measurement_axis,
- stage ma jawny `settle_pipeline` z algorytmami, parametrami, stop criteria,
  applies-to, fallbackami i resolved defaults,
- stage obsluguje `piecewise_segments` i `dense_windows`, czyli jawne
  przedzialy pola z roznymi krokami, z segment ids, labels, endpoint policy i
  preview liczby punktow,
- OOP, in-plane i custom angle sa obslugiwane przez ten sam kontrakt,
- start od zera/virgin, start od saturacji i start z checkpointu sa jawne i
  widoczne w provenance,
- auto-saturation ma probe, progi, status i mozliwosc override,
- petle minorowe maja reversal/return fields, parent branch i osobne metryki,
- planner pokazuje jawny schedule galezi i storage estimate,
- runtime dopisuje live punkty i metryki bez restartowania modelu dla kazdego
  punktu jako publicznego kontraktu,
- runtime zapisuje `settle_trace` dla kazdego punktu i potrafi wyjasnic
  fallback/non-convergence,
- Explorer pokazuje live execution tree: `Hysteresis -> field point -> relax /
  minimize / dynamics settle`, aktywny algorytm zmienia sie przez resource
  invalidation, a zakonczone kroki zostaja jako audit trail,
- Explorer dla duzych petli pokazuje dynamiczne okno aktywnego punktu, summary
  ranges i bookmark/key-event/warning nodes; nie renderuje wszystkich punktow
  pola naraz,
- po zakonczeniu stage Explorer pokazuje przejscia/continuations jako jawne
  akcje, nie jako ukryty efekt uboczny,
- chart pokazuje galezie osobno i jako full/RGB overlay oraz umie pokazac
  virgin/minor/OOP-IP/angular views,
- koercja/remanencja maja metode i provenance,
- saturacja i brak saturacji sa raportowane bez falszywych pewnikow,
- average-only i full-snapshot policies sa rozdzielone,
- wybrany punkt petli mozna zaladowac do `viewport-3d`,
- viewport pokazuje kierunek pola i os pomiaru dla wybranego punktu,
- uzycie punktu jako initial state jest jawna osobna akcja,
- OpenAPI/resource hooks sa wygenerowane,
- testy kontraktowe, runtime, API i frontend przechodza,
- viewport smoke potwierdza widoczny, niepusty WebGL canvas dla snapshotu.
