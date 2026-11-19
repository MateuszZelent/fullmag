# Odbicie pakietu fal spinowych od ABL

Test mierzy amplitudę fali powracającej z końca jednorodnego ferromagnetyka. Generator tworzy 32 edytowalne skrypty Fullmag. Każda kombinacja FDM/FEM, CPU/GPU i kroku podłużnego 4/2 nm ma kontrolę bez absorbera oraz warstwy logarithmic, tanh i custom z równaniem `u**3`. Wynik kwalifikacji wymaga kompletu trajektorii z zarządzanego wykonania.

## Model i pomiar

Próbka ma wymiary 1280 × 4 × 4 nm, magnetyzację nasycenia 800 kA/m, stałą wymiany 13 pJ/m, bazowe tłumienie Gilberta 0,001 i pole 50 mT wzdłuż osi +x. Model obejmuje wymianę i pole zewnętrzne. Przy wyłączonej demagnetyzacji układ daje dyspersję wymienną, z której można niezależnie wyznaczyć okna pomiaru. FDM używa jednego rzędu komórek. FEM używa czterech węzłów przekroju i sześciu tetraedrów P1 na przedział osiowy.

W chwili początkowej poprzeczna składowa magnetyzacji ma postać pakietu Gaussa o amplitudzie 0,001, środku w −256 nm, odchyleniu standardowym 64 nm i długości fali 64 nm. Faza ujemna w kierunku +x daje ruch ku prawej ścianie dla zastosowanego znaku precesji LLG. Przy γ = 2,211 × 10⁵ m/(A·s) prędkość grupowa wynosi 4γAk/(μ₀Ms) ≈ 1,12 km/s. Pakiet padający powinien dotrzeć do x = 0 po około 0,228 ns. Fala odbita od początku warstwy lub od końca próbki powinna wrócić do sondy około 1,08–1,37 ns po rozpoczęciu przebiegu. Prawa warstwa ma szerokość 160 nm, narasta na 96 nm i utrzymuje dodatkowe tłumienie 0,6 przez ostatnie 64 nm. Pozostałe ściany zachowują swobodny warunek wymienny.

Integracja RK4 ma stały krok 2⁻⁴⁵ s. Zapis pola co 128 kroków pozwala odczytać obwiednię pakietu. Sonda mierzy długość wektora średnich poprzecznych składowych magnetyzacji na centralnej płaszczyźnie FEM lub dwóch sąsiednich środkowych płaszczyznach FDM. Współczynnik amplitudowy R to stosunek maksimum obwiedni w oknie 0,78–1,85 ns do maksimum w oknie 0,09–0,45 ns. Okna obejmują czas trwania i poszerzenie pakietu. Współczynnik obejmuje propagację między sondą a absorberem. Porównanie z kontrolą przy identycznej geometrii i tłumieniu objętościowym uwzględnia te straty. Podobną motywację porównywania warstw na podstawie odbić opisali [Venkat, Fangohr i Prabhakar](https://arxiv.org/abs/1706.03325).

## Kryteria przyjęcia

- Kontrola ma R od 0,25 do 1,3 i maksimum odbite w przedziale 1,0–1,7 ns.
- Dla każdego ABL amplituda padająca różni się od kontroli najwyżej o 3%, a R wynosi najwyżej 25% wartości kontrolnej.
- R zmienia się najwyżej o 0,07 między siatkami lub o 0,02 między CPU i GPU tego samego solvera. Dwa zagęszczenia umożliwiają oszacowanie wrażliwości na krok podłużny.
- Każda trajektoria pochodzi ze wskazanego commita i wspólnego snapshotu buildu. Weryfikator sprawdza obecność źródłowej magnetyzacji i oczekiwanego pola α w zrealizowanym planie oraz rzeczywisty backend FP64. Dla CUDA wymaga receiptu wykonania wszystkich wymaganych operatorów na GPU bez fallbacku.

Te progi są kryteriami projektu dla wskazanego pakietu i kąta padania. Raport z uruchomienia zawiera zmierzone wartości.

## Uruchomienie

Wymagane są Python z NumPy i publicznym pakietem Fullmag, grupa DEV przypisana do wybranego checkoutu, dostęp do FP64 CUDA dla obydwu solverów oraz miejsce na 32 niezależne wyniki. Pracuj w zarejestrowanym checkoutcie na ext4 w WSL. Użyj jego skonfigurowanego podkatalogu `FULLMAG_SCRIPT_OUTPUT_DIRECTORY` i przypisanego grupie portu. Poniższy przykład zakłada przydział `examples` i port 3197.

```sh
set -eu
source_root="$(git rev-parse --show-toplevel)"
cd "$source_root"
commit="$(git rev-parse HEAD)"
suite=tests/standard_problems/absorbing_boundary
output="examples/abl-reflection-$commit"
port=3197
export PYTHONPATH="$source_root/packages/fullmag-py/src${PYTHONPATH:+:$PYTHONPATH}"
python3 -B -m unittest discover -s "$suite" -p 'test_*.py'
python3 -B "$suite/prepare.py" "$output"

# Po konfiguracji obrazu przez just docker-dev-toolchain w tym samym checkoutcie.
for script in "$output"/*/*.py; do
    just fullmag-dev-container "$script" "$source_root" "$port" required
done
python3 -B "$suite/verify.py" "$output" --commit "$commit"
```

Każde wywołanie recepty oczekuje na terminal pojedynczej symulacji. Przy wznowieniu wybierz konkretne nieukończone wejście. Zachowaj obok siebie skrypt, `packet.json`, siatkę FEM, sąsiedni `<stem>.zarr` i receipt. Weryfikator szuka jednego ukończonego zestawu `metadata.json` i `fields/` dla każdej nazwy. Jeżeli zarządzana sesja przechowuje katalog artefaktów etapu oddzielnie od publicznego Zarr, przekaż `--artifact-index <plik.json>`. To obiekt JSON mapujący wszystkie 32 nazwy, np. `abl_fem_gpu_2nm_custom`, na dokładne katalogi etapów wyeksportowane z tych sesji. Ścieżki względne są rozwiązywane względem indeksu. Weryfikator czyta pola z kolejnych plików JSON lub natywnej serii Zarr SoA i kończy błędem przy niekompletnych danych.

Testy jednostkowe sprawdzają odczyt skryptów, interpretację artefaktów oraz analizę śladu z kontrolowanymi amplitudami. Do publikacji wyniku naukowego zachowaj pełny raport `verify.py` razem z wynikami źródłowymi.
