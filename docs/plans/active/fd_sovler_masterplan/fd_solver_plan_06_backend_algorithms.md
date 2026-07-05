# Frequency-driven solver — backend algorithms

Ten dokument opisuje algorytmy dla każdego backendu i kolejność ich wdrażania.

---

## 1. Dense Cartesian reference backend

### Cel

Najwyższa dokładność i pełna kontrola znaku, constraintu i drive projection.

### Algorytm

Dla małego `N`:

```text
1. Zbuduj A_cart(ω) w C^(3N x 3N).
2. Zbuduj constraint C δm = 0.
3. Rozwiąż saddle-point system:

   [ A_cart C^T ] [δm] = [b]
   [ C      0   ] [λ ]   [0]

4. Sprawdź m0·δm.
5. Porównaj z tangent result.
```

### Zastosowanie

```text
- macrospin
- 1-4 node toy models
- sign convention tests
- drive projection tests
```

---

## 2. Dense tangent reference backend

### Cel

Szybki oracle dla istniejącego tangent formulation.

### Algebra

```text
A(ω) = K - iωM
```

Real split:

```text
[ K      +ωM ] [q_R] = [b_R]
[ -ωM     K ] [q_I]   [b_I]
```

### Uwaga

Ten backend jest zgodny z aktualnym dense validation style, ale musi mieć test mapowania do COMSOL-compatible `exp(+iωt)`.

---

## 3. CPU sparse/direct baseline

### Cel

Pierwszy brakujący backend produkcyjno-diagnostyczny.

### Dlaczego jest priorytetem

W obecnym problemie log pokazuje stagnację residualu. Sparse/direct odpowiada na pytanie:

```text
czy problem jest rozwiązywalny i dobrze złożony?
```

bez wpływu GMRES/preconditionera.

### Implementacja v1

```text
- Assemble tangent real-split CSR.
- Dla każdej częstotliwości wstaw bloki ±ωM.
- Użyj sparse LU/direct solve.
- Policz true residual.
```

### Reuse

Pattern macierzy jest zwykle niezależny od `ω`, więc:

```text
symbolic analysis / ordering można reuse across frequencies
numeric factorization trzeba zwykle powtarzać per ω
```

### Diagnostics

```json
{
  "backend": "cpu_sparse_direct",
  "nnz": 123456,
  "symbolic_reused": true,
  "factorization_ms": 0.0,
  "solve_ms": 0.0,
  "relative_residual": 0.0
}
```

---

## 4. Full coupled field-split backend

### Cel

Robust core dla dynamic demag/airbox.

### Układ

```text
[ A_qq(ω) A_qφ ] [q] = [b_q]
[ A_φq    A_φφ ] [φ]   [b_φ]
```

### Solver

```text
FGMRES
```

ponieważ preconditioner może być zmienny/inexact.

### Preconditionery

#### Block diagonal

```text
P^-1 ≈ diag(P_qq^-1, P_φφ^-1)
```

#### Block triangular

```text
P = [ P_qq  A_qφ ]
    [ 0     P_φφ ]
```

#### Field-split Schur

```text
S ≈ A_qq - A_qφ P_φφ^-1 A_φq
```

### Minimalny P_qq

```text
node block-Jacobi 2x2 complex / 4x4 real
```

### Minimalny P_φφ

```text
Poisson AMG/HYPRE albo sparse direct dla małych/średnich
```

### Acceptance

```text
- full residual spada szybciej niż unpreconditioned
- δφ residual osobno raportowany
- Poisson solve count i setup count kontrolowane
```

---

## 5. Schur-reduced backend

### Cel

Szybka ścieżka dla dynamic demag po certyfikacji.

### Operator

```text
S(q) = A_qq q - A_qφ solve(A_φφ, A_φq q)
```

### Problem z wydajnością

Jeżeli każde `S(q)` robi pełny Poisson solve, koszt iteracji może być duży. Dlatego:

```text
- Poisson setup musi być reuse
- solve tolerances muszą być inexact/adaptive
- FGMRES wymagany dla zmiennego preconditionera
```

### Preconditioner Schura

Pierwszy sensowny:

```text
P_S^-1 ≈ block-Jacobi/local magnetic + approximate demag correction
```

Lepszy:

```text
graph/demag Schur residual correction
```

### Quality diagnostic

Dla aktualnego residualu `r`:

```text
z = P^-1 r
η = ||r - A z|| / ||r||
```

Interpretacja:

```text
η < 0.3      dobry
0.3-0.7      średni
0.7-1.0      słaby
> 1.0        szkodliwy albo zły znak/skala
```

---

## 6. Modal-reduced backend

### Cel

Największy zysk przy sweepach częstotliwości.

### Źródła reduced basis

```text
- SLEPc shift-invert
- contour interval
- window partition
- deduplication by frequency and mass-overlap
```

### Workflow

```text
1. Wybierz okno częstotliwości.
2. Policz mody w oknie + guard modes.
3. Normalizuj względem mass inner product.
4. Zbuduj reduced response.
5. Dla wybranych frequency sample sprawdź full residual.
6. Jeżeli residual correction duży, dodać mody albo użyć full solve.
```

### Kiedy używać

```text
frequency_count >= 20-50
wiele punktów w jednym paśmie
interesuje response integral/spectrum
```

### Nie używać jako jedynej prawdy, gdy

```text
drive pobudza mody poza oknem
silny non-normal operator
brak completeness certificate
```

---

## 7. GPU device Krylov backend

### Cel

Przyspieszyć duże problemy po potwierdzeniu preconditionera.

### Minimalny architecture contract

```text
x_d, r_d, b_d, v_basis_d, z_basis_d, w_d on GPU
operator/preconditioner input/output device pointers
orthogonalization on GPU
progress readback throttled
true residual recompute rare
```

### FGMRES(m)

```text
m = 30, 50, 80, 100 sweep
```

Przechowywać:

```text
V: Krylov basis
Z: preconditioned basis, bo FGMRES
H: small Hessenberg, host or device
Givens: small
```

### Orthogonalization

Unikać pętli `dot + axpy` z host readback. Użyć:

```text
h = V^H w
w = w - V h
CGS2 albo MGS blocked
```

### Fused operator

Nie:

```text
stiffness(real)
mass(imag)
stiffness(imag)
mass(real)
combine
```

Tylko:

```cpp
apply_Aomega_gpu(omega, x_re_d, x_im_d, y_re_d, y_im_d, stream)
```

### CUDA Graph

Dopiero gdy:

```text
workflow operator/preconditioner jest device-resident i powtarzalny
adresy buforów stabilne
brak host sync w inner loop
```

---

## 8. Performance counters mandatory

Każdy backend ma raportować:

```text
operator_apply_count
preconditioner_apply_count
stiffness_apply_count
mass_apply_count
demag_apply_count
poisson_setup_count
poisson_solve_count
cuda_h2d_count
cuda_d2h_count
cuda_sync_count
cpu_orthogonalization_ms
gpu_operator_ms
gpu_preconditioner_ms
progress_callback_count
snapshot_sync_count
```

Bez tych liczników nie wolno robić performance claims.

---

## 9. Wybór „najszybciej i najdokładniej”

Dla pojedynczej częstotliwości:

```text
small/medium: sparse direct
large demag: full coupled field-split
huge certified: Schur/GPU FGMRES
```

Dla wielu częstotliwości:

```text
modal-reduced + sample direct/full residual checks
```

Dla debugowania:

```text
dense Cartesian/tangent oracle
```

To jest szybsze niż jedna ścieżka GMRES, bo planner wybiera właściwy model do zadania.
