# Audyt: konkluzja, zakres, fizyka i architektura

> Część modularna pełnego dokumentu `2026-08-29-fem-k0-eigensolve-deep-code-and-physics-audit.md` z 2026-08-29. Zakres oryginalnych linii: 1–214.

# Głęboki audyt implementacji i fizyki FEM K0 eigensolve CPU/GPU

**Data audytu:** 2026-08-29  
**Repozytorium:** `MateuszZelent/fullmag`  
**Audytowany commit `master`:** `9d7bd3191959513ad31879a9c5ccecaa48e28558`  
**Audytowane drzewo Git:** `e67dff3c0597f43e8c16a1d7165e2a3a18290214`  
**Zdalny rescue użyty jako źródło historyczne:** `e587df3c5ade76026346cc36671fc885a9d95d18`  
**Rodzaj przeglądu:** statyczny audyt kodu, kontraktów, testów, gałęzi i bieżących GitHub Actions  
**Werdykt:** **NO-GO dla claimu produkcyjnego, merge'u rescue „w całości”, Q1 CPU, Q2 GPU i Q3 browser**

> Ten dokument rozszerza wcześniejszy „Audyt realizacji planu FEM eigensolve K0 CPU/GPU i plan domknięcia”.
> Wcześniejszy dokument pozostaje ważnym źródłem historii tasku i worktree, ale nie jest traktowany jako
> dowód bieżącego stanu `master`. Wszystkie nowe twierdzenia poniżej są przypisane do aktualnego kodu,
> zdalnych referencji lub bieżących workflow.

## 1. Konkluzja wykonawcza

Implementacji **nie należy przepisywać od zera**. Istnieją wartościowe i w wielu miejscach dobrze
rozgraniczone elementy:

- algebraiczny descriptor pencil i rekonstrukcja pełnego residualu w bounded oracle;
- tangent projection/lift i jawna konwencja kinematyczna;
- CPU SLEPc adapter, sparse typy danych, Schur MatShell oraz infrastruktura selected/window;
- syntetyczne Poisson-airbox fixtures wykrywające różnicę między residualem zredukowanym i pełnym;
- CUDA kernels do action parity oraz bounded dense validation oracle;
- wersjonowane requesty, diagnostyka, progress events i początki provenance.

Nie tworzą one jednak obecnie jednego produkcyjnego solvera. Najważniejsze przyczyny są głębsze
niż brak końcowych benchmarków:

1. **Repozytorium nie daje się czysto checkoutować w GitHub Actions.** Wszystkie widoczne workflow
   dla audytowanego `master` zatrzymały się na pustych symlinkach, zanim uruchomiły testy.
2. **Stan równowagi może zostać fizycznie zmieniony przez renormalizację `m0`, bez przeliczenia
   `H_eff0`, demagu i pochodnych.**
3. **Rzekomo sparse ścieżka CPU materializuje pełne macierze `N×N`; dynamiczny demag może wymagać
   pracy około `O(N³)` i pamięci `O(N²)`.**
4. **Nearest-frequency w SLEPc celuje w realne `+ω`, podczas gdy kod interpretuje wartości własne
   jako `λ≈±iω`.**
5. **Full-window nie ma niezależnego certyfikatu kompletności, a niektóre ścieżki publikują
   `complete:true` mimo selected-only, partial lub uncertified.**
6. **Contour solver jest własnym bounded dense oracle, nie produkcyjnym interval eigensolverem.**
7. **Modalny CUDA kod istnieje, lecz jest ograniczony do 64 DOF i jednowątkowej eliminacji;
   nie ma produkcyjnego, device-resident PETSc/SLEPc eigensolve.**
8. **Publiczne modalne ABI C nie ma bezpiecznego `struct_size` i jawnej taksonomii silnika/lane'u.**
9. **Control Room opisany w historycznym audycie nie jest odnajdywalny na obecnym `master`.**
10. **Brakuje świeżych, wspólnie związanych dowodów Q1/Q2/Q3.**

W efekcie implementacja ma znaczną wartość jako zestaw **oracle'i, kontraktów i prototypów**, ale
produkcyjne nazwy i statusy wyprzedzają rzeczywiste właściwości części ścieżek.

## 2. Zakres, metoda i klasy dowodu

### 2.1. Źródła

1. Załączony audyt historyczny z 2026-08-29.
2. Bieżący `master` oraz jego drzewo Git.
3. Zdalne referencje `codex/eigensolve-k0-demag` i `codex/eigensolve-master-rescue`.
4. Kod:
   - `backends/fem/include/frequency_domain/**`
   - `backends/fem/src/frequency_domain/**`
   - `backends/fem/cpu/frequency_domain/**`
   - `backends/fem/gpu/cuda/frequency_domain/**`
   - `backends/fem/tests/frequency_domain/**`
   - `native/include/fullmag_fem.h`
   - `apps/control-room/**`
5. Bieżące GitHub Actions dla `9d7bd3191959513ad31879a9c5ccecaa48e28558`.
6. Dokumentacja pierwotna SLEPc, PETSc i MFEM oraz literatura FEM micromagnetics.

### 2.2. Ograniczenia

- Nie wykonano lokalnego builda, solve ani profilu GPU, ponieważ audyt odbywał się przez GitHub,
  a bieżący clean checkout CI jest uszkodzony.
- Wnioski o kosztach są analizą kodu i asymptotyki; dokładne stałe wymagają pomiaru po naprawie.
- Lokalnych historycznych worktree i niewypchniętych commitów opisanych w audycie wejściowym nie da się
  potwierdzić przez zdalne API. Są oznaczone jako dowód historyczny, nie bieżący.
- Brak znalezienia symbolu w Control Room na bieżącym `master` dowodzi braku tej konsolidacji pod
  rozpoznawalnymi kontraktami, ale nie wyklucza istnienia analogicznego kodu pod zupełnie inną nazwą.

### 2.3. Klasy dowodu

| Klasa | Znaczenie |
|---|---|
| D0 | claim lub plan bez kodu/dowodu |
| D1 | kod/kontrakt istnieje |
| D2 | bounded unit/contract test istnieje lub historycznie przeszedł |
| D3 | fresh clean build/runtime związany z dokładnym commitem |
| D4 | walidacja naukowa na kanonicznym realnym przypadku |
| D5 | wspólny CPU/GPU/API/FMS/browser proof na immutable candidate |

Obecny stan osiąga miejscami D1–D2. D3 jest zablokowane przez checkout. D4–D5 nie są
aktualnie spełnione.

## 3. Korekty i doprecyzowania wcześniejszego audytu

| Teza historyczna | Aktualna ocena |
|---|---|
| „GPU eigensolve istnieje szeroko w źródłach” | Istnieją CUDA action kernels i bounded dense modal oracle, ale nie produkcyjny PETSc/SLEPc GPU eigensolver. |
| „GPU frequency-domain to tylko driven response” | Nazwa pliku tak sugeruje, lecz ten sam plik zawiera modalne validation kernels; trzeba rozdzielić taksonomię. |
| „ABI v18/v19/v20” | Na obecnym `master` publiczny macro ma inną, bieżącą wersję. Historyczne numery nie mogą być użyte jako aktualny dowód. |
| „U0–U2 mają kod” | Historycznie prawdopodobne na rescue/worktree; na obecnym `master` nie znaleziono widma/eigenmode control pod opisywanymi symbolami. |
| „CI jeszcze niekwalifikowane” | Stan jest gorszy: bieżący CI nie przechodzi checkoutu z powodu pustych symlinków. |
| „Sparse CPU jest szeroko zaimplementowane” | Typy CSR istnieją, ale kluczowy payload jest tworzony dense-first. |
| „Full-window częściowe” | Po analizie kontraktu należy traktować je jako **niecertyfikowane**, dopóki nie ma niezależnego count/region certificate. |

## 4. Model fizyczny, względem którego oceniono kod

### 4.1. Równowaga i liniaryzacja

Dla znormalizowanej magnetyzacji `m` i pola w `A/m`, w bezstratnym przypadku:

```math
\frac{\partial \mathbf m}{\partial t}
= -\gamma_0\,\mathbf m\times\mathbf H_\mathrm{eff}[\mathbf m],
\qquad |\mathbf m|=1,
```

gdzie `γ0 = μ0 |γ|`. Równowaga `m0` musi spełniać dyskretnie:

```math
\mathbf m_0\times\mathbf H_0 = 0.
```

Dla perturbacji stycznej `δm·m0=0`:

```math
\frac{\partial\,\delta\mathbf m}{\partial t}
= -\gamma_0\left[
\mathbf m_0\times\delta\mathbf H_\mathrm{eff}[\delta\mathbf m]
+\delta\mathbf m\times\mathbf H_0
\right].
```

Oznacza to, że `m0`, `H0`, dyskretny operator pierwszej pochodnej pola, mesh, materiały,
warunki brzegowe i konwencja jednostek muszą pochodzić z **tego samego immutable stanu**.
Zmiana samego `m0` przez renormalizację unieważnia tę relację.

### 4.2. Redukcja do przestrzeni stycznej

Jeżeli `T` zawiera dwie lokalne bazy styczne na węzeł, `δm=Tq`. Poprawne projekcje,
normy i overlap powinny używać masy FE, nie euklidesowej sumy nodalnej:

```math
\langle q_i,q_j\rangle_M = q_i^H M_T q_j.
```

Baza ma gauge freedom. Spektrum może być niezmienne przy lokalnej rotacji bazy tylko wtedy,
gdy wszystkie bloki i artefakty są transformowane konsekwentnie. Tracking modów bezpieczniej
wykonywać w podniesionej przestrzeni kartezjańskiej albo przechowywać digest frame.

### 4.3. Dynamiczny demag i descriptor

Dla airbox Poisson naturalny pełny problem ma strukturę:

```math
\begin{bmatrix}
A_{qq} & A_{q\phi}\\
A_{\phi q} & A_{\phi\phi}
\end{bmatrix}
\begin{bmatrix}q\\\phi\end{bmatrix}
=
\lambda
\begin{bmatrix}
B_{qq} & 0\\
0 & 0
\end{bmatrix}
\begin{bmatrix}q\\\phi\end{bmatrix}.
```

Redukcja Schura:

```math
A_\mathrm{eff} =
A_{qq}-A_{q\phi}A_{\phi\phi}^{-1}A_{\phi q}
```

jest poprawna tylko przy kontrolowanym gauge i dokładności solve Poissona. Residual końcowy
musi obejmować równanie magnetyczne, Poissona, gauge i tangent leakage; residual samego
zredukowanego EPS nie wystarcza.

### 4.4. Konwencja wartości własnej

Bieżący kod mapuje częstotliwość z części urojonej wartości własnej. To odpowiada pencilowi
z `λ≈±iω` (dla `α=0`, pomijając błędy numeryczne). Target shift-invert musi więc być zgodny
z tą geometrią spektrum. Realne `+ω` nie jest zamiennikiem `+iω`.

### 4.5. Co oznacza „kompletne okno”

Kompletne okno `[f_min,f_max]` wymaga dowodu, że:

1. znaleziono wszystkie wartości własne w regionie;
2. wszystkie spełniają pełny residual;
3. klastry na granicach podokien zostały scalone bez utraty;
4. count jest stabilny względem parametrów contour/slicing;
5. wynik nie został obcięty przez `nev`, budżet lub filtr dodatniej gałęzi.

Nearest-frequency nigdy nie spełnia tego kontraktu.

## 5. Mapa aktualnej architektury

| Warstwa | Obecny charakter | Ocena |
|---|---|---|
| Linearization state | waliduje podstawowe pola, lecz ufa artefaktowi i ma martwe opcje | niekwalifikowane P0 |
| Tangent frame | deterministyczne local frames i lift/project | użyteczne, wymaga mass/gauge hardening |
| Dense/CSR payload | dense probing → CSR | bounded oracle, nie produkcja |
| CPU SLEPc | realny adapter EPS/KSP | wymaga korekty targetu, residualu i statusów |
| Contour interval | własny dense projection/QR | validation-only |
| Poisson-airbox descriptor | dobry bounded algebraic oracle | synthetic-only |
| Schur MatShell | logicznie poprawny wzorzec, ale dense refactor per apply | prototyp |
| CUDA modal | action kernels + ≤64 DOF dense oracle | validation-only |
| Public C ABI | rozbudowane struktury v12 bez size-safe prefix | niebezpieczne do dalszego rozszerzania |
| Artefakty | częściowe manifesty/JSON/provenance | brak atomowego production receipt |
| Control Room | historyczne claimy nieobecne na `master` | nieskonsolidowane |
| CI | checkout failure | brak baseline'u D3 |
