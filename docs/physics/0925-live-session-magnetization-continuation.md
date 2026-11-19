# Kontynuacja magnetyzacji między komendami sesji live

- Status: `runtime-verified (DEV group, FDM/FEM CPU/GPU) / scientifically-unqualified`
- Właściciel: runtime accepted (Docker) i tryb live DSL (ADR 0068)
- Zakres: wybór stanu początkowego $\mathbf m^{(0)}$ kolejnej komendy `relax`/`run`
  w tej samej sesji live
- Data: 2026-10-23
- Powiązane kontrakty: `docs/adr/0068-python-live-session-client.md`,
  `docs/specs/python-live-client-v1.md` §9

Każda komenda live w Dockerze tworzy osobny run accepted. Bez tej noty każdy run
startowałby ze stanu autorskiego sceny, więc `fm.relax()` i następujące po nim
`fm.run()` nie byłyby jedną symulacją. Nota ustala, kiedy run zaczyna od stanu
końcowego poprzedniego runu tej samej sesji, a kiedy od stanu autorskiego.

(problem-statement)=
## 1. Problem

Skrypt live wysyła ciąg komend (np. relaksacja, potem dynamika w polu).
Fizycznie druga komenda ma kontynuować stan pierwszej. Kontynuacja jest jednak
poprawna tylko wtedy, gdy obie komendy działają na tej samej dyskretyzacji
i poprzednia komenda zakończyła się sukcesem. W każdym innym przypadku jedynym
uprawnionym stanem jest stan autorski sceny.

(governing-equations)=
## 2. Model i równania

Każda komenda rozwiązuje zagadnienie początkowe LLG na swojej dyskretyzacji
$\mathcal D$ (środki komórek FDM albo węzły P1 FEM):

```{math}
:label: eq-live-llg-ivp
\partial_t \mathbf m_i = -\gamma_0\,\mathbf m_i\times\mathbf H_{\mathrm{eff},i}
 + \alpha\,\mathbf m_i\times\partial_t\mathbf m_i,
\qquad \mathbf m_i(t_0)=\mathbf m^{(0)}_i,\quad i\in\mathcal D.
```

Kontynuacja wybiera wektor początkowy:

```{math}
:label: eq-live-initial-state-choice
\mathbf m^{(0)}_i=
\begin{cases}
\mathbf m^{\mathrm{prev}}_i & \text{gdy } \mathcal D=\mathcal D^{\mathrm{prev}}
 \text{ i poprzednia komenda zakończyła się sukcesem},\\
\mathbf m^{\mathrm{auth}}_i & \text{w pozostałych przypadkach.}
\end{cases}
```

Relaksacja `llg_overdamped` używa tego samego wektora początkowego; zmienia się
tylko interpretacja zegara (czas relaksacji zamiast czasu fizycznego).

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf m_i$ | jednostkowa magnetyzacja w punkcie dyskretyzacji | $1$ |
| $\mathbf m^{(0)}_i$ | stan początkowy komendy | $1$ |
| $\mathbf m^{\mathrm{prev}}_i$ | stan końcowy opublikowany przez poprzednią udaną komendę sesji | $1$ |
| $\mathbf m^{\mathrm{auth}}_i$ | stan zrealizowany z zasobów magnetyzacji sceny | $1$ |
| $\mathcal D$ | tożsamość dyskretyzacji: siatka lub mesh, przynależność regionów, maska aktywności | $1$ |
| $\gamma_0$ | współczynnik żyromagnetyczny razy przenikalność próżni | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha$ | tłumienie Gilberta | $1$ |
| $\mathbf H_{\mathrm{eff}}$ | pole efektywne | $\mathrm{A\,m^{-1}}$ |
| $t_0$ | czas początkowy komendy | $\mathrm{s}$ |

(assumptions-and-validity)=
## 4. Założenia i granice ważności

- Stan końcowy jest publikowany jako typowany artefakt `state` z układem
  (layout) i haszem treści; kontynuacja przypina dokładnie ten artefakt.
- Zgodność $\mathcal D=\mathcal D^{\mathrm{prev}}$ sprawdza wiązanie wejścia
  względem przypiętego planu wykonania; niezgodny układ jest odrzucany, nie
  interpolowany.
- Kontynuacja nie zmienia parametrów materiałowych ani pól; zmienia wyłącznie
  wektor początkowy.
- Kontynuacja działa także między urządzeniami (np. run GPU po runie CPU), bo
  wektor jest wiązany przed wykonaniem backendu.
- Edycja zasobów magnetyzacji sceny między komendami unieważnia kontynuację:
  następna komenda startuje ze stanu autorskiego.

(python-api)=
## 5. Publiczne API Python

Kontynuacja nie ma parametru w DSL: wynika z kolejności komend w jednej sesji.
Przykład trybu live (wymaga działającej grupy DEV, nie jest wykonywany przy
budowie dokumentacji):

```python
# %% Model w sesji live
import fullmag as fm

fm.connect("http://127.0.0.1:3197")
fm.engine("fdm")
fm.device("cpu")
fm.cell(5e-9, 5e-9, 10e-9)
fm.solver(fix_dt=1e-13)
layer = fm.geometry(fm.Box(200e-9, 50e-9, 10e-9), name="layer")
layer.Ms, layer.Aex, layer.alpha = 800e3, 13e-12, 0.5
layer.m = fm.texture.uniform(1, 0.2, 0)

# %% Relaksacja: start ze stanu autorskiego
fm.relax(dt=1e-13, tolT=1e-4, max_steps=500)

# %% Dynamika: start ze stanu końcowego relaksacji
fm.b_ext(0.05, 0.0, 0.0)
fm.run(2e-11)
```

| Python | Typ | Domyślnie | Jednostka SI | Walidacja | Znaczenie | Wsparcie | ProblemIR |
|---|---|---|---|---|---|---|---|
| `fm.relax(...)` / `fm.run(until)` w sesji live | wywołanie | — | $\mathrm{s}$ | jawny krok czasowy etapu | komenda, której stan początkowy wybiera reguła {eq}`eq-live-initial-state-choice` | FEM/FDM CPU/GPU | `study.steps[].inputs[initial_state]` |

(problem-ir)=
## 6. `ProblemIR` i obniżanie planu

| Intencja | Pole | Normalizacja |
|---|---|---|
| publikacja stanu końcowego | `study.steps[].outputs[final_state]` (rodzaj `state`) | deklarowane dla każdej komendy live |
| kontynuacja | `study.steps[].inputs[initial_state]` = `PinnedArtifact { artifact_id, content_sha256 }` | tylko gdy reguła {eq}`eq-live-initial-state-choice` wybiera $\mathbf m^{\mathrm{prev}}$ |
| stan autorski | brak wejścia `initial_state` | magnetyzacja z zasobów sceny |
| provenance | `parameters.live_workspace.initial_state_source` | `{"kind": "continuation", ...}` albo `{"kind": "authored", "reason"}` |

(round-trip-and-failure-semantics)=
## 7. Round-trip i semantyka odrzuceń

Run zapisuje osobno requested intent (stan autorski sceny)
i resolved execution (faktycznie użyty stan początkowy z jego źródłem). Brak
kontynuacji nie jest błędem: decyzja `authored` zapisuje powód (brak
poprzedniego runu, poprzedni run nieudany, zmiana dyskretyzacji, edycja
zasobów magnetyzacji). Jawne validation errors pojawiają się, gdy przypięty
artefakt nie pasuje do układu planu (wiązanie wejścia odrzuca run). Nie ma
cichych wyjątków dla unsupported combinations: niezgodny układ nie jest
interpolowany ani zastępowany.

(discrete-realization)=
## 8. Realizacja dyskretna i macierz wsparcia

Wiązanie odbywa się przed wykonaniem backendu, więc jest wspólne dla ścieżek.
Wyniki E2E w grupie DEV (23.10.2026, `docs/specs/python-live-client-v1.md` §9):

| Ścieżka | Stan | Dowód |
|---|---|---|
| FDM CPU | runtime-verified | `relax` → `run`, `initial_state_source.kind = continuation` |
| FDM GPU | runtime-verified | `run` → `run` z kontynuacją; `relax` na GPU niedostępny w trybie strict |
| FEM CPU | runtime-verified | `relax` → `run`; także start ze stanu runu FEM GPU tej samej sesji |
| FEM GPU | runtime-verified | `relax` → `run`; start ze stanu runu FEM CPU tej samej sesji |

(implementation-mapping)=
## 9. Mapowanie implementacji

- `declare_final_state_output` dodaje wyjście `final_state` do wybranego etapu.
- `decide_initial_state` stosuje regułę {eq}`eq-live-initial-state-choice`
  i zwraca `InitialStateDecision`.
- `declare_pinned_initial_state` przypina artefakt jako wejście etapu.
- `resolve_pinned_state_inputs` udostępnia przypięty stan workerowi.
- `materialize_study_magnetization_input` wiąże stan z układem planu.

(validation)=
## 10. Walidacja

- E2E w grupie DEV na czterech ścieżkach (sekcja 8).
- Testy kontraktowe Python trybu live (`packages/fullmag-py/tests/test_live_*.py`).
- Kwalifikacja naukowa (np. ciągłość energii na granicy komend, porównanie z
  jednym nieprzerwanym runem) pozostaje `NOT VERIFIED`.

(limitations)=
## 11. Ograniczenia

- Brak projekcji tabeli skalarów dla runów accepted: ciągłości energii nie
  można jeszcze odczytać z sesji.
- Relaksacja CUDA `llg_overdamped` jest ścieżką rozwojową i nie przechodzi
  bramki strict, więc na FDM GPU kontynuacja relaks → run nie jest dostępna.

(scientific-bibliography)=
## 12. Referencje

- T. L. Gilbert, „A phenomenological theory of damping in ferromagnetic
  materials”, IEEE Trans. Magn. 40, 3443 (2004).
- Fullmag, `docs/adr/0068-python-live-session-client.md`: decyzje trybu live.

(source-code-index)=
## 13. Indeks źródeł

| Twierdzenie | Źródło | Odpowiedzialność | Dowód |
|---|---|---|---|
| publikacja stanu końcowego | `crates/fullmag-api/src/live_accepted_continuation.rs` — `declare_final_state_output` | wyjście `final_state` etapu | runtime-verified |
| decyzja kontynuacji | `crates/fullmag-api/src/live_accepted_continuation.rs` — `decide_initial_state` | reguła wyboru stanu początkowego | runtime-verified |
| przypięcie wejścia | `crates/fullmag-api/src/live_accepted_continuation.rs` — `declare_pinned_initial_state` | wejście `PinnedArtifact` | runtime-verified |
| rozwiązanie wejścia | `crates/fullmag-runtime-control/src/study.rs` — `resolve_pinned_state_inputs` | dostęp workera do przypiętego stanu | runtime-verified |
| wiązanie z planem | `crates/fullmag-runner/src/lib.rs` — `materialize_study_magnetization_input` | odrzucenie niezgodnego układu | runtime-verified |
| API sesji live | `packages/fullmag-py/src/fullmag/live/__init__.py` — `connect` | sesja, w której komendy się kontynuują | runtime-verified |
