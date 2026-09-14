# DE 100 nm — raport wykonania i bramka zgodności

Stan na 2026-09-14: **NOT VERIFIED — brak numerycznego spektrum FEM**.
Jest to raport roboczy wykonania, nie certyfikat ani nowa definicja fizyki.
Kanoniczny kontrakt: [Floquet i demag](../../physics/0828-fem-frequency-domain-floquet-demag.md).

## Przypadek i sprawdzony kontrakt wejścia

Źródło: `examples/fem_de_film_100nm_numeric_pilot.py`.
Odczyt przez `fm.load_problem_from_script(..., lightweight_assets=True)` oraz
`to_ir(requested_backend="fem", execution_mode="strict", execution_precision="double", include_geometry_assets=False)` zakończył się kodem 0.

| Wielkość | Wartość |
|---|---|
| Film / komórka periodyczna | 50 × 50 × 100 nm |
| Domena film + powietrze | 50 × 50 × 4100 nm |
| Ms | 800000 A/m |
| A | 13e-12 J/m |
| B zewnętrzne | (0.1, 0, 0) T |
| Magnetyzacja początkowa | (1, 0, 0) |
| Gamma w konwencji DSL | 221100 m/(A s) |
| K | (0, ky, 0), ky = −40, −30, −20, −10, 0, 10, 20, 30, 40 rad/µm |
| Operator | full_2x2, include_demag=true |
| Dynamiczne BC | floquet_airbox, exp_minus_i_k_dot_delta_r |
| Statyczne PBC | periodic, periodic, open; periodic_airbox_k0 |
| Mesh — żądanie | liniowe tetrahedry, 5 nm, 20 warstw filmu |
| Widmo | 24 mody, 1 MHz–30 GHz, damping_policy=ignore |
| Realizacja | FEM CPU, strict, double |

Eksport nie zawiera selektora `dispersion_validation` wybierającego analityczny
solver referencyjny. Powyższa kontrola potwierdza tylko authoring; nie dowodzi
wykonania siatki, planera, relaksacji ani eigensolve.

## Stan rzeczywistego wykonania

Build 43: `9ce502f938a64abd85d74d4e391b5d3a`, profil
`fem-cpu-slepc-modal-v1`, commit
`95763e6a7f3d6a7c19657bd214d5d805082b926b`.
Kapsuła: `77575527e2204d3bbf1d70ceab68e931`; source digest:
`9059c840b6ad17fa9906aa10d0c9b37a1d7d53b714fdf1d9d5d3e947d422f9f5`.

API raportuje running i nie ma kodu zakończenia. Docker nie pokazuje workera
tego joba. Żywy proces koordynatora ma wiele wątków w `p9_client_rpc`;
nie jest to dowód zawieszenia ani zidentyfikowana przyczyna źródłowa.
Kapsuła obejmuje 7181 plików, 289802701 bajtów. Nie anulowano joba ani nie
uruchomiono duplikatu na podstawie czasu oczekiwania.

Branch zmienił się podczas równoległego review. Obserwowany późniejszy HEAD:
`da9a0ecf54767823dcc8eb1f4a62807ced0e61cb`.
Nie wolno przypisać buildowi 43 późniejszych poprawek ani nowego pilota.
Obecny `run_comsol_dispersion_benchmark.py` dopuszcza C0/C1/A1 i wskazuje
na ich skrypt w kapsule; nie stanowi jeszcze wykonawczej recepty DE 100 nm.

## Pozostałe kroki i kryteria decyzji

1. Doprowadzić aktualny job do stanu terminalnego; sprawdzić receipt i hashe.
   Rozpoznać etap przygotowania danych, jeżeli worker nadal nie powstaje.
2. Zapewnić kontrolowaną receptę DE z niezmiennym wejściem oraz odpowiadającym
   mu solverem po poprawkach review. Nie podmieniać plików w kapsule buildu.
3. Wykonać siatkę, relaksację i wszystkie 9 punktów FEM. Zachować logi,
   requested/resolved execution, diagnostykę, częstotliwości i profile modów.
4. Sprawdzić residuale, warunek styczności, pokrycie okna widma i poprawność
   śledzenia gałęzi. Dopasowywanie tylko po kolejności częstotliwości nie wystarcza.
5. Porównać numeryczne częstotliwości z aproksymacją Kalinikosa n=0 i sporządzić
   tabelę błędów oraz wspólny wykres. Wzór referencyjny nie może być źródłem
   częstotliwości przedstawianych jako obliczenia FEM.
6. Wykonać zbieżność siatki i rozmiaru powietrza, zwłaszcza przy Gamma.
   Zestawić wyniki dla jednakowych warunków brzegowych. Zagęścić k przy Gamma.
7. Rozdzielić błąd numeryczny od ograniczeń jednomodowej aproksymacji filmu
   100 nm. Rozbieżności profili lub hybrydyzacji wymagają analizy; nie wolno
   korygować solvera przez dopasowanie do założonego kształtu wykresu.
8. Dopiero po wykonaniu powyższych kontroli ustalić wynik bramki dla tego
   przypadku. Nie rozszerzać jej automatycznie na FEM GPU, FDM, inne geometrie
   ani wszystkie mody solvera.

## Wyniki

Brak wartości FEM, tabeli błędów i wykresu porównawczego. Ich miejsce nie jest
wypełnione analityką ani zerowym błędem. Cel symulacji i certyfikacji pozostaje otwarty.

## Wykonawcza recepta DE

Dodano `just run-de-100nm-pilot <job_id>` i `scripts/run_de_100nm_pilot.py`.
Recepta korzysta z istniejących kontroli receipt, obrazu i kapsuły. Wymaga,
aby pilot był w manifestowanej kapsule tego samego buildu; sprawdza jego hash.
Uruchamia wyłącznie przygotowany model DE, zapisuje logi i request/result.
Sprawdza obecność widma, dyspersji, złożonych modów i potencjału; nawet sukces
pozostaje `completed_unqualified` do wykonania osobnej oceny naukowej.

Próba dry-run z jobem 43 została odrzucona przez preflight: job jest running.
Nie wykonano z tego powodu Docker Compose ani symulacji.
