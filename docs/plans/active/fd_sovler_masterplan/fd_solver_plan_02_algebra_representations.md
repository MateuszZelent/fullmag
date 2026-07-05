# Frequency-driven solver — algebra representations

Ten dokument opisuje wszystkie reprezentacje algebraiczne, które solver planner może wybrać. Ich wspólnym źródłem jest fizyczny kontrakt `δm ∈ C^3`, `m0·δm=0`, `exp(+iωt)`.

---

## 1. Warstwy reprezentacji

```text
Physics layer:
    δm ∈ C^3 per node, m0·δm = 0

Adapter layer:
    δm = T q, q ∈ C^2 per node

Algebra layer:
    A(ω)x = b

Backend layer:
    dense / CSR / BSR / matrix-free / full-coupled / Schur / modal / GPU
```

Nigdy nie wolno mieszać tych poziomów w jednym callbacku bez opisu. Callback typu „apply_stiffness” nie powinien po cichu wykonywać projekcji, dynamic demag, Schura i real split bez diagnostyki.

---

## 2. Cartesian constrained reference

Najbardziej fizyczna reprezentacja:

```text
unknown: δm_cart ∈ C^(3N)
constraint: C δm_cart = 0, gdzie C_i δm_i = m0_i · δm_i
```

Dwie implementacje referencyjne:

### 2.1. Eliminacja przez tangent basis

```text
δm = T q
A_t = T^H A_cart T
b_t = T^H b_cart
```

### 2.2. Constraint/Lagrange multiplier oracle

Dla małych problemów:

```text
[ A_cart   C^T ] [δm] = [b]
[ C        0   ] [λ ]   [0]
```

To jest bardzo dobry test dla tangent projection i warunku `m0·δm=0`.

---

## 3. Tangent 2-DOF complex representation

Docelowa reprezentacja obliczeniowa dla magnetyzacji:

```text
q ∈ C^(2N)
δm = T q
```

Wariant real-split:

```text
x = [q_R, q_I] ∈ R^(4N)
```

Jeżeli wewnętrzny kontrakt ma postać:

```text
A(ω) = K - iωM
```

to real split:

```text
[ K      +ωM ] [q_R] = [b_R]
[ -ωM     K ] [q_I]   [b_I]
```

Ten blok jest zgodny z aktualnym dense validation style, ale musi być traktowany jako **internal algebra form**, nie bezpośrednio jako równanie manuala. Związek z równaniem manuala musi być potwierdzony testem znaku.

---

## 4. Full coupled magnetostatic representation

Dla dynamic demag/airbox podstawowy model produkcyjny powinien istnieć jako pełny układ sprzężony:

```text
[ A_mm(ω)   A_mφ ] [δm] = [b_m]
[ A_φm      A_φφ ] [δφ]   [b_φ]
```

albo w tangent form:

```text
[ A_qq(ω)   A_qφ ] [q]  = [b_q]
[ A_φq      A_φφ ] [φ]    [b_φ]
```

Gdzie:

```text
A_φφ  — magnetostatic/Poisson/airbox block
A_φq  — source from dynamic magnetization
A_qφ  — feedback from dynamic demag field to LLG
```

### Dlaczego full coupled jest core

1. Można liczyć true full residual.
2. Można diagnozować Poisson/gauge/nullspace.
3. Można użyć field-split preconditionera.
4. Schur jest pochodną, nie jedyną prawdą.
5. Łatwiej porównać z COMSOL-style multiphysics coupling.

---

## 5. Schur-reduced representation

Eliminacja `φ`:

```text
φ = A_φφ^{-1}(b_φ - A_φq q)
```

Po podstawieniu:

```text
S(ω) q = b_q - A_qφ A_φφ^{-1} b_φ
S(ω) = A_qq(ω) - A_qφ A_φφ^{-1} A_φq
```

### Status

Schur jest:

```text
certified fast path
```

nie:

```text
default source of truth
```

### Certyfikacja Schura

Dla małych problemów:

```text
S_explicit = A_qq - A_qφ inv(A_φφ) A_φq
```

Test:

```text
||S_matrix_free q - S_explicit q|| / ||S_explicit q|| < tolerance
```

Rekonstrukcja full residual:

```text
φ(q) = A_φφ^{-1}(b_φ - A_φq q)
r_full = A_full [q, φ(q)] - b_full
r_reduced = S q - b_reduced
```

Wymaganie:

```text
||project_magnetic_part(r_full) - r_reduced|| small
||poisson_part(r_full)|| small
```

---

## 6. Sparse direct representation

Dla pojedynczej częstotliwości i średnich problemów wymagany jest assembled sparse baseline.

Tangent real split:

```text
A_real(ω) = [ K      +ωM ]
            [ -ωM     K ]
```

Formaty:

```text
CSR: najłatwiejszy pierwszy backend
BSR 2x2/4x4: docelowo lepszy dla tangent blocks
MatNest/block CSR: dla full coupled field split
```

Wynik sparse/direct jest punktem odniesienia dla:

```text
GMRES residual
Schur sign/scale
preconditioner quality
GPU matrix-free apply
```

---

## 7. Modal/eigen representation

Frequency-domain response może być liczony przez modal expansion:

```text
A(ω) x(ω) = b
```

Jeżeli operator jest bliski gyrotropic first-order pencil:

```text
K v = λ M v
```

mody można wykorzystać do response:

```text
x(ω) ≈ Σ_j v_j (w_j^H b) / (λ_j - iω)
```

albo odpowiedniej postaci zależnej od definicji `λ` i konwencji fazy.

### Konieczne testy modalne

```text
1. eigenmode residual ||K v - λ M v||
2. positive-frequency partner policy
3. conjugate-pair policy
4. mode normalization with mass inner product
5. modal response vs dense direct for tiny problems
```

---

## 8. GPU device representation

GPU backend nie może być definiowany przez „operator używa GPU”. Musi spełnić:

```text
Krylov vectors on device
operator input/output on device
preconditioner input/output on device
no per-iteration host readback
no CPU dot/norm/axpy in inner loop
```

Lane names:

```text
gpu_operator_host_krylov  // obecny/prototypowy model
gpu_device_krylov         // docelowy model
```

---

## 9. Algebra diagnostics schema

Każdy backend ma raportować:

```json
{
  "algebraic_form": "cartesian3_constrained|tangent2_real_split|full_coupled|schur_reduced|modal_pencil",
  "phasor_convention": "exp_plus_i_omega_t",
  "real_split_convention": "[K,+omegaM;-omegaM,K]",
  "unknown_internal_representation": "tangent2_complex",
  "full_coupled_available": true,
  "schur_certified": false,
  "true_residual_verified": true
}
```

---

## 10. Błędy, które ta architektura ma wykrywać

```text
1. odwrócony znak iω
2. odwrócona orientacja tangent frame
3. δh potraktowane jako RHS bez poprawnego momentu γ m0×δh
4. Schur z błędnym znakiem A_qφ A_φφ^-1 A_φq
5. niespójny gauge/nullspace Poissona
6. residual reduced niezgodny z full residual
7. preconditioner, który poprawia probe RHS, ale szkodzi aktualnym residualom GMRES
8. modal eigenvalue mapowane na złą część λ
```
