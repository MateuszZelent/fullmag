# Pilot #188 — terminalna diagnoza Γ

Kontroler90201 zakończył się exit1 i `gamma-t3 wrapper_exit=1`.
Kontener7df4be7c5ace został usunięty przez istniejący wrapper po zakończeniu;
Docker inspect potwierdził brak tego obiektu. Nie restartowano obliczenia.
Log i wyniki kontrolera pozostają zachowane w kanonicznym storage.

- Jobid:145d8503bba24dc3abfaec6aaaf72819; stara kapsuła/worker MFEM4.9.
- Γ, L2,3warstwy, finite Dirichlet airbox, demag periodic_airbox_k0.
- Okno8.5–12GHz, wymagany1mod;16base +34refinement =50podokien.
-44podokna ukończone,6nieudanych:3base i3refinement.
- Wszystkie6: `slepc_diverged`; zatrzymanie końcowe
  `frequency_window_subwindow_failed`, `complete=false`, `solve_succeeded=false`.
- Czasy nieudanych podokien [s]:1101.259, 3984.316, 992.195, 1872.051, 5603.999, 1321.665.
  Łącznie14875.484s; ostatni postęp window_s15033.8.
- Lokalnie przyjęty cluster9.299249697068092GHz, rank1. Nie jest to
  terminalnie certyfikowany punkt całego okna. Nie publikować go jako nowego
  wyniku dyspersji ani przepisać niepowodzenia na success.
- Demag operator probe passed; Ny≈7.11e-33,Nz≈0.997506234413922.
  To wydzielona kontrola operatora, nie certyfikat kompletności spectrum.

Źródło logu:
`scientific-batches/nonzero-k-validation/145d8503bba24dc3abfaec6aaaf72819/gamma-t3/de-smoke-k0/runtime.log`.

## Następna próba

Nie obniżać progu residualu1e-8. Nowy build musi zawierać poprawki bounded
Krylov, failed EPS counters/Ritz diagnostics, Ku identity, modal telemetry,
F01 i R4. Obserwować rzeczywisty stopreason i residualmag/Poisson/gauge.
Przed pełną30run serią ponowić pojedynczyΓ i jeden nonzero DE/BV.
Nowy obraz MFEM4.10 jest osobną bramką: source pin i attestation nie
zastępują image/ABI/runtime.

Po zakończeniu188 koordynator zdrowy(worker_alive/accepting_jobs true),
ale uruchomił job189(529ac93e81744c5faf50494306d50a11) na głównym checkoutcie.
Nie uruchamiać równoległego ciężkiego imagebuild ani zatrzymywać cudzego joba.
Wolne storage przy pomiarze około35.88GB. Goal S00–S12 pozostaje aktywny.
