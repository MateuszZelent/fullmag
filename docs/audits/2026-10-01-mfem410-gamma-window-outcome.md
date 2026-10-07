# Wynik pilota Γ na MFEM 4.10 — pojedynczy mod i niekompletne okno

Stan: wynik diagnostyczny pojedynczego modu; pełna kwalifikacja S00–S12 pozostaje otwarta.

## Tożsamość wykonania

- Managed build #193: `19e798d5ff07454db64c90e63ba4f3a3`, build zakończony sukcesem.
- Źródło runtime: `e78a25bac0f95c1190821524545803e4311b8ef9`.
- Profil: `fem-cpu-slepc-runtime-v2`; FEM CPU, double, MFEM 4.10.0.
- Przypadek: `gamma-t3/de-smoke-k0`, 10 nm filmu, 2 µm powietrza z każdej strony, zewnętrzne Dirichlet, 3 warstwy po grubości.
- Obserwator 42033 zakończył się kodem 1; kontroler zatrzymał serię na pierwszym przypadku. Proces 168336 zakończył się.
- Log: `C:\git\fullmag\storage\runs\eigensolve-dispersion-plan-20260-c5dfad6d7f548079\scientific-batches\nonzero-k-validation\19e798d5ff07454db64c90e63ba4f3a3\gamma-t3\de-smoke-k0\runtime.log`.
- SHA-256 logu: `2eecfef2d2b3874dd5ce6df24c477ebe48b737c4897502b525cb927553fc36df`.

## Co rzeczywiście wyliczył solver

Końcowy JSON ma `status=solve_error`, `reason=frequency_window_subwindow_failed`,
`window_complete=false`, `spectrum_completeness=incomplete_window`.
Nie powstał kompletny wynik widma ani CSV dyspersji. Tego wykonania nie wolno
przedstawiać jako poprawnego przebiegu całego okna.

Jednak pierwsze poprawne podokno zachowało w `raw_ritz_classification.reconstructed_samples`
mod dodatniej częstotliwości, który przeszedł sprawdzenie oryginalnego deskryptora:

| Wielkość | Wartość |
|---|---:|
| Częstotliwość | 9 299 249 697,068405 Hz |
| Full backward error | 2,0099146388450526·10⁻¹³ |
| Magnetic backward error | 2,0099146388450526·10⁻¹³ |
| Poisson backward error | 8,177355640705426·10⁻¹⁴ |
| Gauge backward error | 0 |
| Próg residualu | 10⁻⁸ |

Ten sam klaster jest zapisany w `window_certificate.accepted_cluster_frequencies_hz`.
232 akceptacje residualu obejmują powtórzenia Ritz z wielu przesunięć; nie
oznaczają 232 niezależnych modów. Certyfikat podał jeden zaakceptowany klaster.
To jest dowód diagnostycznej częstotliwości Γ, nie certyfikat kompletności
widma, ciągłości pasma, dostępności pól ani najnowszego źródła brancha.

## Porównanie analityczne z właściwą granicą

Stosujemy istniejącą kontrolę jednorodnego Γ z
[noty liniaryzacji](../physics/0600-fem-eigenmodes-linearized-llg.md)
oraz `finite_airbox_gamma_hz` w `scripts/compare_de_100nm_pilot.py`.
Dla nieskończonego filmu $N_z=1$. Dla jednorodnego filmu między dwiema
skończonymi granicami Dirichleta:

\[
N_z=\frac{2d}{t+2d},\qquad
f_\Gamma=\frac{\gamma_0}{2\pi}\sqrt{H_0(H_0+N_zM_s)},\qquad H_0=B_0/\mu_0.
\]

$t=10$ nm, $d=2$ µm, $M_s=800000$ A/m, $\gamma_0=221100$ rad/s per (A/m),
$B_0=0.1$ T. $N_z=0.99750623441396513$ wynika z geometrii; nie dopasowano go
do częstotliwości numerycznej ani do zmierzonego demagu.

Runtime tego SHA używa $\mu_0=4\pi\,10^{-7}$ T·m/A
(`crates/fullmag-engine/src/lib.rs`, stała `MU0`).
W tej samej konwencji analityka skończonego airboxu daje
9 299 249 697,068401 Hz: różnica około 3,8 µHz, względnie około 4,1·10⁻¹⁶.
Nie jest to dowód zbieżności wszystkich modów: dotyczy jednorodnej kontroli Γ
i wartości zachowanej w diagnostyce nieudanego pełnego okna.

Model miał w metadanych inną przybliżoną stałą
1,25663706212·10⁻⁶ T·m/A. Użycie tej deklaracji daje 9 299 249 694,307741 Hz
i pozorną różnicę 2,760664 Hz. Rozbieżność metadanych trzeba naprawić w nowym
przykładzie bez zmiany produkcyjnej stałej engine. Około 0,1135% różnicy
względem otwartego filmu pochodzi z fizycznej granicy airboxu, a nie z residualu.

## Zmierzony koszt nieudanej certyfikacji

| Wielkość | Wartość |
|---|---:|
| Wykonane podokna | 50 |
| Poprawne podokna | 36 |
| Nieudane podokna | 14 |
| Suma elapsed_seconds podokien | 14 845,011149 s |
| Czas nieudanych podokien | 14 669,491091 s |
| Udział nieudanych podokien | 98,81765% |
| Najdroższe podokno | refinement 8, shift 9,3203125 GHz: 4 945,992348 s |

To suma pomiarów podokien, nie całkowity wall time buildu lub pipeline’u.
14 nieudanych podokien podało `slepc_diverged`. Mały residual zachowanego
modu nie rozwiązuje braku certyfikacji tych podokien.

Natywne wymiary: $n_q=656$, $n_\phi=5084$, pełny wymiar 5740.
Z realnego splitu wynika 1312; stary runtime nie publikuje nowych liczników
budowy exact preconditionera, więc nie deklarujemy zmierzonego kosztu jego
materializacji. Kontekst operatora i faktoryzacja Poissona zostały utworzone
po jednym razie; licznik setupów przesunięć wynosi 50.

## Następne kroki

1. Zbudować spójny checkpoint nearest z rzeczywistym selected-only wyjściem
   Floqueta, poprawnymi metadanymi SI i walidatorem solver.v1.json.
2. Wykonać osobne Γ, +DE, −DE, +BV, −BV z demagiem i oryginalnym residualem.
3. Zachować wynik, mody, mesh i provenance; dopiero z tych artefaktów utworzyć
   oficjalne punkty porównania.
4. Naprawić rozbieganie i kompletność okna niezależnie od diagnostycznego
   wyszukiwania pojedynczego modu. Pozostałe bramki S00–S12 pozostają w planie.
