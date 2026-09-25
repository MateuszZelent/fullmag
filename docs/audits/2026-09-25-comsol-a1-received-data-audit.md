# Odbiór danych COMSOL A1 — 2026-09-25

Status: **referencja częstotliwości do porównania wstępnego**, nie pełny pakiet kwalifikacji naukowej. Pięć plików pochodzi z przekazanego przez użytkownika katalogu `docs/plans/active/eignensolve_non_k0/` w głównym checkoutcie, a szósty to następny załącznik tekstowy. Skopiowano je bez modyfikacji do katalogu o tej samej ścieżce w worktree zadania. Nie uruchomiono na ich podstawie solvera Fullmag ani nie uznano zgodności numerycznej.

Lokalny `.gitattributes` wyłącza normalizację końców linii dla całego katalogu danych. Sprawdzono, że staged blob CSV jest bajtowo identyczny z przekazanym plikiem; bez tej reguły ustawienie hosta `core.autocrlf=true` zmieniałoby SHA-256 przy zapisie w Git.

## Inwentarz i integralność

| Plik | Rola | SHA-256 |
|---|---|---|
| `COMSOL_A1_dispersion.csv` | 61 próbek × 24 częstotliwości | `2da7b9a41fab68a6a33eff2ccfd5d8c3583eed14a2f0c29f918ad833adb0d5da` |
| `README_COMSOL_A1_dispersion.txt` | opis parametrów i kolumn | `23502886ffd3e25a6bb6f5fa2cb5fab445c708e24ccadc3550392959b059e519` |
| `COMSOL_A1_band_structure.png` | obraz punktów | `a7d35b0a8e36192e8863ab10dde670f715d9c1f29d2e7d75d3641fe2d57a6607` |
| `COMSOL_A1_band_structure.pdf` | ten sam typ wizualizacji | `4a10eb999076fda2a02e5de4f05c006f2b29659832b4a0947bc4b4d55cb69f84` |
| `comsol-przepis-dyspersja-permalloy (1).pdf` | wcześniejszy protokół `comsol-py-antidot-square-v1` | `f5300ff9a835cef3f582bcfaa36f68819cfcb86b320da95fc508e8360f2558d1` |
| `COMSOL_A1_model_details_user.txt` | późniejszy opis zadeklarowanej konfiguracji COMSOL; kopia załącznika użytkownika | `b5d3f395ffe9319b71d083fe4190405c7d13f18715852a4db78cd590ecd07bbd` |

## Sprawdzenie zawartości

- Nagłówek CSV: `jpath,kx_rad_per_um,ky_rad_per_um,frequency_order,frequency_GHz`.
- 1464 wiersze; dokładnie 24 pozycje 1–24 dla każdego `jpath=0…60`, lokalnie posortowane po częstotliwości.
- Punkty ścieżki odpowiadają Γ–X–M–Γ dla `a=200 nm`, z maksymalnym odchyleniem współrzędnych od wzoru poniżej `4.5e-10 rad/µm` (zaokrąglenie eksportu). Widma Γ w wierszach `j=0` i `j=60` są identyczne w zapisanej precyzji.
- Zakres częstotliwości: `9.273700…20.840000 GHz`; pierwsza pozycja Γ: `9.413600 GHz`, X: `9.273700 GHz`, M: `11.133000 GHz`.
- `frequency_order` jest indeksem sortowania lokalnego, **nie** śledzoną gałęzią. Wykres punktowy jest właściwy; łączenie pozycji liniami może fałszywie interpretować przecięcia.
- Sześć miejsc dziesiętnych w GHz daje rozdzielczość zapisu 1 kHz, lecz nie spełnia przewidzianego w protokole eksportu minimum 15 cyfr znaczących. Nie podano części urojonej ani surowych wartości własnych.

## Zgodność zamierzonego problemu z Fullmag

README deklaruje A1: komórka `200×200×10 nm`, centralny otwór `r=50 nm`, `Ms=800 kA/m`, `Aex=13 pJ/m`, `gamma=2.211e5 m/(A s)`, `Bbias=0.1 T` w kierunku `+x`, `alpha_eig=0`. To odpowiada nominalnym parametrom `tests/standard_problems/mumag/comsol_nonzero_k_dispersion/config.py` i geometrii `problem.py`. Dane **nie** dotyczą jednorodnego pilota `DE-SMOKE`, w którym nie ma otworu i użyto innego okresu/grubości; punktów tego pilota nie należy nakładać na A1 jako tego samego zadania.

Pierwszy README nie podawał wysokości airboxu ani wersji programu. Późniejszy `COMSOL_A1_model_details_user.txt` deklaruje **COMSOL 6.1**, airbox `d_air=2 µm` na stronę, zera potencjału na jego górze i dole, siatkę o docelowych rozmiarach około 5 nm w magnetyku i bliskim powietrzu, trzy warstwy przez film, wzrost ≤1.3 i maksimum około 100 nm w dalszym powietrzu. Deklaruje również Micromagnetics Time/Frequency Domain, dwa jawne Weak Form PDE, BDF/PARDISO dla relaksacji, 24 wartości własne wokół około 1 GHz przy względnej tolerancji `1e-8` oraz kontrolne C0 ≈2.8003 GHz i C1 ≈9.2992 GHz. Dla A1 podaje relaksowany, niejednorodny stan równowagi, bez jego eksportu. Opis ten jest deklaracją konfiguracji, **nie** surowym logiem ani automatycznie zweryfikowaną metryką solvera.

Nadal brak dokładnego identyfikatora siatki/liczby DOF i eksportu siatki, wersji dodatku Micromagnetics i hashu `.jar`, pliku `.mph`, logu zbieżności relaksacji/eigensolvera, residuali, części urojonych częstotliwości, pól stanu równowagi i zespolonych pól modów/potencjałów oraz kontroli ±k i sweepów zbieżności. C0/C1 są jedynie przybliżonymi liczbami w opisie; brak ich surowych tabel. Pochodzenia CSV jako bezpośredniego eksportu COMSOL nadal nie można niezależnie potwierdzić z pakietu.

**Różnica do rozstrzygnięcia przed A1:** opis COMSOL podaje pierwszy odcinek relaksacji 5 ns i linearyzację na jego końcowym stanie. Obecny `config.py` Fullmag ma `RELAX_DT_S=5e-15` oraz `RELAX_MAX_STEPS=50_000`, czyli maksymalnie 0.25 ns czasu integracji przy pełnym limicie kroków. To nie jest automatycznie błąd fizyczny, jeśli stan osiąga równowagę wcześniej, lecz bez rzeczywistego certyfikatu momentu obrotowego, normy i stabilności stanu nie wolno uznać obu punktów linearyzacji za zgodne. Przed A1 należy uruchomić relaksację do spełnienia warunku równowagi, zwiększając budżet czasu/kroków według wyników, a następnie zachować pole `m0` i identyfikator tej samej siatki dla wszystkich `k`.

**Nierozstrzygnięta konwencja Blocha w przekazanym opisie:** sekcja 8 nazywa `dmX/Y/Z` periodycznymi obwiedniami, lecz zapisuje źródło skalarne jako `Menv = Ms exp(+i k·r) dm`. Sekcja 9 definiuje jednocześnie fizyczny potencjał `phi_dyn = exp(-i k·r) psi`, a sekcja 10 fizyczne pole `dh = -exp(-i k·r)(grad - i k)psi`. W tej konwencji poprawne źródło obwiedni potencjału to `Ms dm`, **jeśli** `dm` jest periodyczną obwiednią fizycznej magnetyzacji `exp(-i k·r)dm`. Podany czynnik `exp(+i k·r)` jest natomiast spójny, **jeśli** `dm` oznacza już pełną fizyczną perturbację magnetyzacji z warunkiem Floqueta `exp(-i k·Δr)`, a nie jej obwiednię. Opis nie podaje warunku bocznego dla `dm` w interfejsie Micromagnetics, Frequency Domain, więc z samego tekstu nie da się rozstrzygnąć, którą interpretację rzeczywiście rozwiązano. Nie zmieniać konwencji Fullmag na podstawie tego opisu; przed uznaniem porównania `k≠0` sprawdzić ustawienie bocznego warunku dla `dm` w modelu COMSOL albo wyeksportować zespolony mod po przeciwnych stronach komórki i zweryfikować jego fazę. Zgodność `jpath=0` z `jpath=60` sprawdza jedynie ponowne Γ i nie wykryje tej niejasności.

## Kolejność odtworzenia

1. Potwierdzić provenance i rzeczywiste ustawienia modelu COMSOL. Zachować dostarczone pliki oraz hashe jako niezmienną próbkę; jeżeli dostępne, dołączyć `.mph`, logi i eksporty według rozdziału 9 protokołu.
2. Dokończyć managed FEM CPU/SLEPc i zaakceptowany pojedynczy punkt jednorodnego C1/DE z dynamicznym demagiem. Obecny diagnostyczny punkt dense-oracle nie jest wynikiem produkcyjnym.
3. Uruchomić C0 w Γ i C1 w Γ dla kontroli jednostek, demagu oraz airboxu. Następnie A1 w Γ, X i M, ze stanem równowagi A1 wyznaczonym raz i użytym dla wszystkich `k`.
4. Po poprawnych residualach i metadanych rozszerzyć A1 do 61 punktów / 24 żądanych modów. Dopasować widma przy tych samych `jpath` i `k` jako **nieuporządkowane zbiory modów**, bez nazywania `frequency_order` numerem gałęzi. Raportować błędy absolutne i względne, brakujące/nadmiarowe mody i status jakości każdego punktu.
5. Wykonać osobne kontrole zbieżności siatki, airboxu i liczby modów oraz kontrolę pól zespolonych, gdy dane referencyjne będą dostępne. Szczególnie sprawdzić fazę `dm` na bocznych granicach dla co najmniej jednego `k≠0`, aby rozstrzygnąć opisaną wyżej niejasność. Do tego czasu porównanie z CSV jest wstępne, a bramka publikacyjna pozostaje `NOT VERIFIED`.

## Aktualny stan wykonania

Ponownie przekazany opis modelu jest bajtowo identyczny z zapisanym `COMSOL_A1_model_details_user.txt` (SHA-256 `b5d3f395ffe9319b71d083fe4190405c7d13f18715852a4db78cd590ecd07bbd`); nie stanowi nowego zestawu danych. Buildy #142 (`65636004e798435ca763c3821088d0cf`) i #143 (`58afb60a8b204a83a132f25d351a1cdb`) zakończyły się poprawnie, ale produkcyjny pilot jednorodnego C1/DE dla `k_y=2e6 rad/m` nie dostarczył zaakceptowanego modu. MGS w #143 poprawił końcowy rzeczywisty względny residual KSP pierwszego podokna z około `3.30e-6` do `4.14e-8`; najgorszy z pomiarów po wszystkich wewnętrznych solve'ach pozostał około `1.05e-4`. Diagnostyczne poluzowanie **tylko** prefiltra EPS do `1e-8` ujawniło parę `9.723336314 GHz`, ale jej oryginalny residual magnetyczny `2.80e-7` przekroczył niezmieniony próg akceptacji `1e-8`. Żaden punkt Fullmag A1 z dostarczonej geometrii nie został jeszcze obliczony i porównany z CSV.

Przygotowano `scripts/compare_comsol_a1_frequency_reference.py`. Wczytuje pełne 61×24 CSV, sprawdza kanoniczne współrzędne k i powtórzone Γ, a wynik Fullmag dopuszcza wyłącznie z ukończonego managed runu A1 o zgodnym hashu `eigen/dispersion.csv` oraz nominalnej geometrii i materiale. Dla dostępnych punktów k porównuje lokalne widma w rosnącej kolejności częstotliwości, **bez pomijania brakujących niskich rang w referencji**; zapisuje JSON i opcjonalny wykres punktowy. Raport ma status `frequency_only_unqualified`; nie potwierdza kompletności niskiego widma, tożsamości modów ani zgodności fizycznej. Weryfikacja źródłowa: sześć interpretowanych testów PASS, w tym odrzucenie pozornej zgodności po utracie najniższego modu, oraz odczyt rzeczywistego eksportu 61×24 PASS. Użycie po powstaniu managed wyniku A1:

```text
python scripts/compare_comsol_a1_frequency_reference.py --reference docs/plans/active/eignensolve_non_k0/COMSOL_A1_dispersion.csv --case-dir <managed-run>/a1 --output <comparison-dir>/frequency-only.json --plot <comparison-dir>/frequency-only.png
```
