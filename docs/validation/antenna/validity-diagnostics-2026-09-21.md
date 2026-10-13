# Diagnostyka ważności rozdzielnego pola anteny — 2026-09-21

## Zakres

Ten raport dokumentuje implementację preflightu `antenna_validity.v1` dla
rozwiązanego napędu antenowego. Właścicielem równań, jednostek, założeń i
granic modelu pozostaje [notatka 0950](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md).
Raport opisuje ślad kodu i status weryfikacji; nie ustanawia drugiego modelu
fizycznego i nie oznacza odbioru solvera.

## Zrealizowany kontrakt

Planner `crates/fullmag-plan/src/antenna_validity.rs` publikuje jedną stabilną
notę dla każdego `SolvedAntennaDriveIR`. Geometria nie jest zgadywana z nazwy
napędu: resolver przechodzi przez następujący łańcuch:

```text
solved_antenna_drive.projection_ref
  -> antenna_target_projection.solution.stage_id
  -> antenna_field_solve_stage.source_object_id
  -> geometry.entries[name]
```

Te same noty są dołączane zarówno do zwykłego `ExecutionPlanIR`, jak i do
dedykowanego `AntennaFieldSolvePlanIR`. Dzięki temu tryb „policz samą antenę”
nie traci diagnostyki przed przejściem do późniejszego Relax/Run.

Parametry przewodnika są pobierane wyłącznie z wariantów
`GeometryEntryIR::MicrostripAntenna` i `GeometryEntryIR::CpwAntenna`:

| Symbol | Pole IR | Jednostka SI |
|---|---|---|
| $L_{max}$ | `length_m` | m |
| $t_{max}$ | `thickness_m` | m |
| $\sigma$ | `conductivity_s_per_m` | S/m |

Skończone pasmo jest obecnie klasyfikowane przez istniejący kontrakt
`antenna_waveform_bandwidth.v1`:

| Waveform | `f_max_hz` | Źródło |
|---|---:|---|
| `Constant` | 0 | `constant` |
| `Sinusoidal` | `frequency_hz` | `sinusoidal` |
| `SincPulse` | `cutoff_hz` | `sinc_cutoff` |
| `Pulse`, `PiecewiseLinear` | `bandwidth_declaration.f_max_hz` albo nieznane | `declared` albo `validity_bandwidth_unknown` |

Dla znanego pasma planner oblicza wielkości z 0950:

$$
\eta_{wave}=\frac{L_{max}f_{max}}{c}, \qquad
\delta=\sqrt{\frac{2}{2\pi f_{max}\mu_0\sigma}}, \qquad
\eta_{skin}=\frac{t_{max}}{\delta}.
$$

Używane są $c=299\,792\,458\ \mathrm{m/s}$ oraz
$\mu_0=4\pi\cdot10^{-7}\ \mathrm{H/m}$, czyli założenie nieferromagnetycznego
przewodnika przy ocenie głębokości wnikania. Gdy $f_{max}=0$, diagnostyka
ustawia $\eta_{skin}=0$ bez dzielenia przez zero. Status `warning` jest
publikowany, gdy którakolwiek z wartości spełnia $\eta\ge 0.1$;
ostrzeżenie ma stabilny kod `separable_field_basis_validity_warning`.

Nieznane pasmo, brak powiązanej geometrii i niepoprawne parametry geometrii
nie są cicho zamieniane na `ok`. Nota pozostaje `status=unknown` z odpowiednio
`validity_bandwidth_unknown`, `antenna_geometry_unknown` albo
`antenna_geometry_invalid`. Dla impulsu nie stosuje się przybliżenia
`f_max=1/duration`.

`Pulse` i `PiecewiseLinear` mogą otrzymać skończone pasmo przez opcjonalne
`SolvedAntennaDriveIR.bandwidth_declaration` /
`AntennaWaveformBandwidthDeclaration(f_max_hz=...)`. Deklaracja musi być
skończona i nieujemna; dla pozostałych waveformów jest odrzucana jako
niezgodna. Jeżeli deklaracji nie ma, planner zachowuje `status=unknown`.

Dla wielu napędów potencjalnie aktywnych w jednym `StudyIR` planner publikuje
równoległą notę `antenna_waveform_bandwidth_aggregate.v1`. Agregat używa
konserwatywnie `max(f_max_hz)` dla wspólnego źródła `H_ant_basis`; obecność
choć jednego nieznanego napędu daje `status=unknown` zamiast liczby z czasu
próbkowania. Lista drive’ów i portów pozostaje w provenance, a zmiana
waveformu nie unieważnia statycznej bazy pola.

## Przykładowy zapis provenance

```text
antenna_validity.v1 drive_id=rf status=warning f_max_hz=1.00000000000000000e10 source=sinusoidal length_m=1.00000000000000002e-02 thickness_m=2.00000000000000016e-06 conductivity_s_per_m=5.80000000000000000e7 eta_wave=3.33564095198152044e-01 eta_skin=...
```

Nota `antenna_waveform_bandwidth.v1` pozostaje publikowana osobno, aby UI i
raporty mogły rozróżnić źródło pasma od oceny ważności przy konkretnej
geometrii. Zmiana waveformu odświeża obie noty przy ponownym planowaniu; sama
baza pola nie jest przez to oznaczana jako stale.

## Weryfikacja wykonana 2026-09-21

- parser-formatowanie Rust (`rustfmt --edition 2021 --config skip_children=true
  --emit stdout`) dla `antenna_validity.rs` i `lib.rs`: exit code 0;
- `git diff --check`: exit code 0;
- inspekcja definicji IR potwierdziła pola geometrii, referencję projekcji i
  referencję etapu użyte w resolverze;
- osobne noty deklarowanego pasma i agregatu są dołączane zarówno do
  `ExecutionPlanIR`, jak i do `AntennaFieldSolvePlanIR`;
- nie uruchamiano kompilacji testów jednostkowych, natywnego FEM/CUDA ani
  browser smoke; w tej sesji nie jest to dowód kwalifikacji wykonania.

## Pozostaje otwarte

- pomiar kosztu, pamięci, anulowania i wall-time z T11;
- walidacja numeryczna solvera, projekcji, LLG oraz GPU.
