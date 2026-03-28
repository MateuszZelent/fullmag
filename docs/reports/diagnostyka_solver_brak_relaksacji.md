# Diagnostyka: Układ nie relaksuje — spiny stoją w miejscu

**Data:** 2026-03-28  
**Dotyczy:** `fullmag-engine` (FDM + FEM), `fullmag-runner`

---

## Objawy

- Energia całkowita jest niemal identyczna przez cały okres symulacji.
- Spiny się nie relaksują — `max_dm_dt ≈ 0`.
- Brak dynamiki pomimo poprawnych parametrów materiałowych.

---

## Analiza kodu

### 1. Równanie LLG — implementacja poprawna

Oba backendy (FDM i FEM) implementują standardowe równanie LLG:

```
dm/dt = -γ̄ (m × H_eff + α · m × (m × H_eff))
```

**FDM** ([lib.rs:2569–2580](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-engine/src/lib.rs#L2569-L2580)):
```rust
fn llg_rhs_from_field(&self, magnetization: Vector3, field: Vector3) -> Vector3 {
    let alpha = self.material.damping;
    let gamma_bar = self.dynamics.gyromagnetic_ratio / (1.0 + alpha * alpha);
    let precession = cross(magnetization, field);
    let damping = cross(magnetization, precession);
    let precession_term = if self.dynamics.precession_enabled {
        precession
    } else {
        [0.0, 0.0, 0.0]
    };
    scale(add(precession_term, scale(damping, alpha)), -gamma_bar)
}
```

Matematycznie poprawne — znaki, gamma_bar, alpha wszystko OK.

### 2. Integratory — matematycznie poprawne

Przeanalizowano wszystkie 5 integratorów (Heun, RK4, RK23, RK45, ABM3) w obu wariantach (allocating i buffer-reusing). Współczynniki Dormand-Prince, Bogacki-Shampine i klasycznego RK4 są standardowe. **Brak błędów numerycznych.**

### 3. Ostatnie zmiany (git diff HEAD~5) — brak zmian funkcjonalnych

Ostatnie commity dotyczą:
- Dodania `precession_enabled` flag (poprawne)
- Dodania `IntegratorBuffers` i `SolverSession` (optymalizacja, brak wpływu na fizykę)
- Dodania `VectorFieldSoA` i `RhsEvaluation` (nowe struktury, brak wpływu na fizykę)
- Formatowania kodu w `fem.rs` (brak zmian logiki)

**Wniosek: Ostatnie zmiany NIE zmieniły matematyki solverów.**

---

## Zidentyfikowane przyczyny braku relaksacji

### 🔴 Przyczyna #1: Zerowe pole efektywne → zerowy moment obrotowy

Jeśli `m × H_eff = 0` (co zachodzi gdy m ∥ H_eff lub H_eff = 0), RHS jest dokładnie zero i układ nie ewoluuje.

**Kiedy to występuje:**

| Scenariusz | H_eff | Rezultat |
|---|---|---|
| Uniform m + exchange only (no demag, no ext) | H_exchange = 0 (laplacian jednorodnego pola = 0) | **Brak dynamiki** |
| Uniform m + demag only | H_demag ∥ m (demagnetyzacja wzdłuż osi m) | **Minimalny torque** |
| Uniform m + external ∥ m | H_ext ∥ m | **Zero torque** |

> [!CAUTION]
> **To jest najczęstsza przyczyna: jednorodny stan początkowy z jednorodnym polem daje zerowy iloczyn wektorowy i zerowy dm/dt.**

### 🔴 Przyczyna #2: `EffectiveFieldTerms::default()` — brak demag!

```rust
impl Default for EffectiveFieldTerms {
    fn default() -> Self {
        Self {
            exchange: true,
            demag: false,        // ← DOMYŚLNIE WYŁĄCZONE
            external_field: None, // ← DOMYŚLNIE BRAK
        }
    }
}
```

Jeśli problem jest tworzony z domyślnym `EffectiveFieldTerms`:
- **Jedyne pole** to exchange
- Dla jednorodnego stanu m → laplacian = 0 → H_ex = 0 → dm/dt = 0
- **Układ nigdy się nie relaksuje**

### 🟡 Przyczyna #3: α = 0 → brak relaksacji (tylko precesja)

Jeśli `damping = 0.0` (walidacja `MaterialParameters::new` pozwala na α ≥ 0):
- `gamma_bar = γ / (1 + 0) = γ`
- `damping_term = alpha * cross(m, cross(m, H)) = 0`
- RHS zawiera **tylko precesję** — układ się obraca ale nie relaksuje
- Energia jest stała (poprawne fizycznie, ale brak zbieżności do minimum)

### 🟡 Przyczyna #4: FEM `llg_rhs_from_vectors` — masywny overhead (nie powoduje stagnacji, ale maskuje problem)

```rust
// fem.rs:1095-1108
fn llg_rhs_from_vectors(&self, magnetization: &[Vector3]) -> Result<Vec<Vector3>> {
    let observables = self.observe_vectors(magnetization)?;  // ← PEŁNE OBSERWABLE!
    ...
}
```

`observe_vectors()` oblicza WSZYSTKIE pola (exchange, demag, external), WSZYSTKIE energie, i max_norm. Jest wywoływana **NA KAŻDYM ETAPIE RK** (np. 7 razy dla RK45 + 1 na error estimate = 8 razy na krok). To jest O(8N) zamiast O(N) per krok.

> [!WARNING]
> FEM solver jest **~8x wolniejszy niż powinien**, spowodowane przez `observe_vectors` w `llg_rhs_from_vectors`. FDM wersja poprawnie oblicza tylko `effective_field` w `llg_rhs_from_vectors_ws`.

### 🟡 Przyczyna #5: FEM brak `precession_enabled`

FEM `llg_rhs_from_field` ([fem.rs:1110–1116](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-engine/src/fem.rs#L1110-L1116)) **nie sprawdza** flagi `precession_enabled`:

```rust
fn llg_rhs_from_field(&self, magnetization: Vector3, field: Vector3) -> Vector3 {
    let alpha = self.material.damping;
    let gamma_bar = self.dynamics.gyromagnetic_ratio / (1.0 + alpha * alpha);
    let precession = cross(magnetization, field);
    let damping = cross(magnetization, precession);
    scale(add(precession, scale(damping, alpha)), -gamma_bar) // ← precesja ZAWSZE włączona
}
```

Podczas gdy FDM poprawnie obsługuje `if self.dynamics.precession_enabled`. To oznacza, że **relaxacja overdamped (LlgOverdamped) nie działa poprawnie na FEM**.

---

## Tabela diagnostyczna — co sprawdzić

| Sprawdź | Jak | Poprawna wartość |
|---|---|---|
| `enable_demag` | Plan IR / JSON konfiguracji | `true` (chyba że celowo wyłączone) |
| `enable_exchange` | Plan IR / JSON konfiguracji | `true` |
| `external_field` | Plan IR / JSON konfiguracji | Non-null jeśli brak demag |
| `damping` (α) | `material.damping` | > 0.0 (typowo 0.01–1.0 dla relaksacji) |
| `initial_magnetization` | Stan początkowy | **NIE jednorodny** — musi mieć gradient! |
| `max_rhs_amplitude` | Pierwszy StepReport | > 0 (jeśli = 0, układ jest w stanie zerowego momentu) |
| `max_effective_field_amplitude` | Pierwszy StepReport | > 0 |

---

## Rekomendacje napraw

### Natychmiast
1. **Sprawdź konfigurację symulacji** — czy `enable_demag = true`? Czy stan początkowy nie jest jednorodny?
2. **Dodaj assert lub warning** gdy `max_rhs_amplitude = 0` na pierwszym kroku — to oznacza, że układ nigdy nie będzie ewoluował.

### Krótkoterminowe
3. **Napraw FEM `llg_rhs_from_vectors`** — powinien obliczać tylko `effective_field`, nie pełne `observe_vectors`:
   ```rust
   fn llg_rhs_from_vectors(&self, magnetization: &[Vector3]) -> Result<Vec<Vector3>> {
       let effective_field = self.effective_field_from_vectors(magnetization)?;
       Ok(magnetization.iter().enumerate()
           .map(|(node, m)| {
               if self.topology.magnetic_node_volumes[node] > 0.0 {
                   self.llg_rhs_from_field(*m, effective_field[node])
               } else { [0.0, 0.0, 0.0] }
           }).collect())
   }
   ```
4. **Dodaj `precession_enabled` do FEM** `llg_rhs_from_field`:
   ```rust
   let precession_term = if self.dynamics.precession_enabled { precession } else { [0.0, 0.0, 0.0] };
   scale(add(precession_term, scale(damping, alpha)), -gamma_bar)
   ```

### Długoterminowe
5. **Dodaj diagnostykę na starcie** symulacji: sprawdź czy `max_torque > 0` po inicjalizacji.
6. **Rozważ zmianę `EffectiveFieldTerms::default()`** na `demag: true`, aby uniknąć cichych błędów.

---

## Podsumowanie

**Matematyka solverów jest POPRAWNA** — problem leży w konfiguracji, nie w algorytmach. Najczęstsze przyczyny braku relaksacji to:
1. Jednorodny stan początkowy + brak pola zewnętrznego + exchange only → H_eff = 0 → dm/dt = 0
2. `demag: false` (default!) oznacza brak pola demagnetyzacyjnego które mogłoby wytworzyć moment.
3. FEM ma bug: brak `precession_enabled` i masywny overhead w `llg_rhs_from_vectors`.
