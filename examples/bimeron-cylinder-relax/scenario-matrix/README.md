# Macierz materiału i stanów początkowych

To eksploracyjny zestaw 12 niezależnych wejść Fullmag: trzy warianty materiału filmu × dwa stany filmu × dwa kierunki początkowe cylindra. Geometria i komórka 2,5 nm pozostają stałe. DMI `D=0.004 J/m²` występuje wyłącznie w wariancie `rdmi_current` i jest przypisane do obiektu filmu. Warianty YIG i Permalloy mają `Ku1=0` oraz nie dodają DMI.

Parametry YIG (`Ms`, `Aex`, `alpha`) pochodzą z [przykładu dyspersji DE/BV](../../fem_eigenmodes_dispersion_de_bv_low_k.py); parametry Permalloy z [relaksacji pudełka FDM](../../permalloy_box_relax_300x1000x10nm_fdm.py). Materiał `rdmi_current` i tekstura bimeronu zachowują ustawienia z [bazowego przypadku filmu i cylindra](../relax.py). Tłumienie z tych przykładów jest metadanym materiału; relaksacja PG-BB nie integruje dynamiki LLG ani czasu fizycznego, więc czasów tych przypadków nie należy porównywać.

Generator działa deterministycznie i zapisuje wyłącznie manifest oraz własne pliki `cases/`:

```sh
python3 -B examples/bimeron-cylinder-relax/scenario-matrix/generate_cases.py
python3 -B examples/bimeron-cylinder-relax/scenario-matrix/generate_cases.py --check
```

Każdy skrypt jest osobnym kanonicznym wejściem `fm.study(...)`; generator nie uruchamia backendu ani symulacji. Wyniki są zapisywane obok skryptu: `cases/<case_id>.py` → `cases/<case_id>.zarr`. W Docker DEV ten katalog na dysku WSL jest udostępniany przez jawny bind `FULLMAG_SCRIPT_OUTPUT_ROOT`; wyniki nie trafiają do named volume. Przed uruchomieniem wymagane jest skonfigurowane środowisko zarządzane Fullmag.

Limit 3000 kroków jest budżetem eksploracyjnym, a nie deklaracją zbieżności. Manifest pozostaje `qualification: pending`, `runtime_status: NOT RUN`; stan zbieżności trzeba odczytać z rzeczywistego wyniku końcowego. Zapisy tabeli co 100 kroków są skonfigurowane, ale ich zgodność z natywną ścieżką CUDA PG-BB nie została potwierdzona i pozostaje **NOT VERIFIED**. Pola `m` i `H_demag` są żądane co 1000 przyjętych kroków, z obserwacją początkową i końcową; także to wymaga potwierdzenia w receipcie runtime.
