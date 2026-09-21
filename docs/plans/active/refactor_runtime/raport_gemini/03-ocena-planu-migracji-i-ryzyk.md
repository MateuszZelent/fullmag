# Raport Gemini: Ocena planu migracji, scenariuszy CAE i dekompozycji ryzyk
## 03. Weryfikacja planu wdrożenia P0–P8 i scenariuszy odbioru

**Data audytu:** 20 września 2026 r.  
**Przedmiot analizy:**  
- `03-migracja.md` (fazy wdrożenia P0–P8, nowe pakiety, zasady rollout/rollback, 7 spike'ów technicznych)  
- `04-scenariusze.md` (60 scenariuszy kwalifikacyjnych CAE-01 do CAE-60)  
- Realia kodu: `orchestrator.rs` (16,6k linii), `world.py` (9,2k linii), `apps/control-room` (REST/WebSocket API)

---

### 1. Ocena sekwencji faz migracji (P0–P8)

Plan słusznie przyjmuje zasadę: **„Kolejność wynika z własności danych”**. Najpierw budujemy niezależny, trwały model, następnie izolujemy wykonanie, a dopiero na końcu odblokowujemy równoległą edycję w UI.

```text
               ARCHITEKTURA FAZ MIGRACJI
┌────────────────────────────────────────────────────────┐
│ P0: Zabezpieczenie obecnego zachowania i fixtures       │
└───────────────────────────┬────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────┐
│ P1: Trwały projekt (ProjectDefinition) bez solvera      │
│     Pierwszy pionowy przekrój: New -> Save -> Open     │
└───────────────────────────┬────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────┐
│ P2: Pełny authoring: parametry [nm], cechy, Undo/Redo  │
└───────────────────────────┬────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────┐
│ P3: StudyDefinition, osobne SolverConfigs i RunSpec    │
└───────────────────────────┬────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────┐
│ P4: Przygotowanie i dyskretyzacja na żądanie (FDM/FEM) │
└───────────────────────────┬────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────┐
│ P5: Izolacja wykonania: usunięcie scratch_runtime      │
│     kill-triggera, live steering, odblokowanie UI      │
└───────────────────────────┬────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────┐
│ P6: Trwałe wyniki: SolutionSets, Datasets, PlotDefs    │
└───────────────────────────┬────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────┐
│ P7: Zaawansowane badania: Histereza, Eigen, Sweeps     │
└───────────────────────────┬────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────┐
│ P8: Usunięcie starych mechanizmów i kwalifikacja CAE   │
└────────────────────────────────────────────────────────┘
```

#### Ocena poszczególnych faz:
- **Faza P1 (Pionowy przekrój projektu):**  
  Doskonały wybór na pierwszy etap. Zamiast przebudowywać całą aplikację naraz, Faza P1 skupia się na scenariuszu CAE-01 i CAE-02: stworzenie projektu, dodanie obiektów, zapis do pliku `.fms` i otwarcie go bez uruchamiania solvera i bez obecności karty graficznej.
- **Faza P5 (Izolacja wykonania):**  
  Kluczowy moment wdrożenia. Plan słusznie podkreśla, że **nie wolno odblokować pełnej edycji w UI przed fazą P5**. Dopóki worker nie otrzyma niemutowalnego snapshotu wejściowego (`RunSpecification`), a proces nadzorczy reaguje na zmianę rewizji sceny zabiciem solvera (`scratch_runtime.rs:137`), edycja podczas symulacji prowadziłaby do natychmiastowych awarii.
- **Faza P8 (Kwalifikacja i cleanup):**  
  Usunięcie `SimulationStartupOverlay` unmount-gate'a dopiero po potwierdzeniu, że powłoka radzi sobie ze stanami `incomplete`, `preparing`, `running` i `error` bez niszczenia drzewa Reacta.

---

### 2. Ocena 60 scenariuszy odbioru (CAE-01 do CAE-60)

Scenariusze w `04-scenariusze.md` stanowią wzorcowy, wyczerpujący zestaw akceptacyjny (Acceptance Test Suite). Pokrywają one wszystkie aspekty działania profesjonalnego systemu CAE:

1. **Projekt i persystencja (CAE-01 do CAE-04):**  
   - CAE-01: Start bez sesji i bez GPU, zapis projektu (0 wywołań solvera).
   - CAE-02: Zapis niekompletnego modelu (brak materiału nie uniemożliwia zapisu).
   - CAE-03: Zachowanie draftu z błędem składni (np. `sin(`) bez zanieczyszczania IR.
   - CAE-04: Bezstratna migracja legacy `.fms`.
2. **Geometria, parametry i selekcje (CAE-05 do CAE-12):**  
   - CAE-05/CAE-06: Zmiana parametru odświeża tylko zależne geometrie bez restartu solvera; zmiana nazwy zachowuje ID i referencje.
   - CAE-08: „Build to Selected” z lokalizacją błędu w konkretnej cesze CSG.
   - CAE-11: Zamrożenie spinów (Frozen Spins) powiązane ze snapshotem stanu, a nie zmieniające się co klatkę.
3. **FDM, FEM i solvery (CAE-13 do CAE-20):**  
   - CAE-13/CAE-14: Model może mieć jednocześnie receptury FDM i FEM; FDM nie wymaga Gmsha.
   - CAE-19: Wymuszone GPU przy braku wsparcia odrzuca zadanie z błędem (brak cichego fallbacku na CPU!).
   - CAE-20: Wykrycie niezastosowanych zmian formularza przed Compute (brak cichego liczenia starej wartości).
4. **Fizyka i analizy częstotliwościowe (CAE-21 do CAE-28):**  
   - CAE-21: Rozróżnienie zakończenia technicznego od kwalifikacji stanu równowagi.
   - CAE-25: Histereza wymusza zależną sekwencję (punkt $n+1$ korzysta z $n$, brak nieuprawnionego zrównoleglenia).
5. **Współbieżność i odporność na awarie (CAE-29 do CAE-48):**  
   - CAE-29: Edycja draftu revision 42 podczas gdy run liczy na revision 41 nie zabija zadania.
   - CAE-30/CAE-31: Idempotencja zapytań Compute i obsługa utraty łączności.
   - CAE-41: Zerwanie połączenia WebSocket nie odmontowuje UI i nie resetuje canvasu 3D.
6. **Wydajność i bezpieczeństwo (CAE-53 do CAE-60):**  
   - CAE-54: Solver nie zwalnia, gdy klient UI ma wolną przeglądarkę (oddzielenie hot loop od preview).
   - CAE-57: Bezpieczne odrzucenie archiwum `.fms` z path traversal lub złą sumą kontrolną.

---

### 3. Architektura rozwiązania 4 krytycznych wąskich gardeł wykonawczych

W dokumentacji zidentyfikowano 4 istotne wyzwania wykonawcze. Poniżej przedstawiono konkretne, profesjonalne rozwiązania inżynierskie, które należy wdrożyć:

#### 3.1. Dekompozycja monolitu `orchestrator.rs` (16 659 linii)
- **Zagrożenie:** Próba jednoczesnego przepisania `crates/fullmag-cli/src/orchestrator.rs` sparaliżuje całe narzędzie CLI i uniemożliwi uruchamianie testów integracyjnych.
- **Rozwiązanie (Wzorzec Strangler Fig):**
  1. W nowym pakiecie `crates/fullmag-application` definiujemy czyste porty i use-case'y:
     ```rust
     pub trait ProjectRepository: Send + Sync {
         fn load(&self, id: &ProjectId) -> Result<ProjectDefinition, AppError>;
         fn save(&self, project: &ProjectDefinition) -> Result<(), AppError>;
     }
     pub trait ExecutionCoordinator: Send + Sync {
         fn submit_run(&self, spec: RunSpecification) -> Result<RunId, AppError>;
         fn get_run_status(&self, run_id: &RunId) -> Result<RunStatus, AppError>;
     }
     ```
  2. Implementujemy `LocalApplicationService` w `fullmag-application`.
  3. W `orchestrator.rs` zamiast własnej logiki zarządzania sesją, delegujemy operacje do instancji `ApplicationService`. Monolit `orchestrator.rs` sukcesywnie kurczy się do roli launchera CLI, bez utraty stabilności.

---

#### 3.2. Izolacja wieloprojektowa w Pythonie (`world.py`, 9 275 linii)
- **Zagrożenie:** Usunięcie singletonu `_state = _WorldState()` w `world.py:2489` natychmiast popsuje setki istniejących skryptów badawczych i testów jednostkowych w Pythonie.
- **Rozwiązanie (Context-Bound Execution z thread-local fallback):**
  1. Wprowadzamy w `packages/fullmag-py` mechanizm `ExecutionContext` oparty na `contextvars.ContextVar`:
     ```python
     import contextvars

     _current_context: contextvars.ContextVar[_WorldState] = contextvars.ContextVar(
         "fullmag_world_state"
     )
     _default_global_state = _WorldState()

     def get_active_state() -> _WorldState:
         try:
             return _current_context.get()
         except LookupError:
             return _default_global_state
     ```
  2. Wszystkie dotychczasowe funkcje (`fm.geometry()`, `fm.run()`, `_build_problem()`) zamiast `s = _state` wywołują `s = get_active_state()`.
  3. Dodajemy nowoczesny interfejs obiektowy dla wielodokumentowości:
     ```python
     with fm.Project("SpinWaveDevice") as proj:
         layer = proj.geometry(...)
         proj.run(1e-9)
     ```
  4. **Wynik:** Stare skrypty płaskie działają bez zmian (korzystają z `_default_global_state`), a nowe środowisko wieloprojektowe w UI/Jupyterze może uruchamiać niezależne projekty w osobnych wątkach lub kontekstach asynchronicznych.

---

#### 3.3. Mostek kompatybilności API dla Control Room (`VirtualSessionAdapter`)
- **Zagrożenie:** W `apps/control-room` ponad 50 komponentów korzysta z endpointów `/v2/sessions/current/*`. Zmiana wszystkich endpointów na `/v2/projects/{id}/*` w jednym kroku spowoduje paraliż frontendu.
- **Rozwiązanie (Adapter w API Axum):**
  1. W `fullmag-api` wdrażamy `VirtualSessionAdapter`.
  2. Gdy klient odpytuje `/v2/sessions/current/*`, adapter sprawdza, który projekt jest aktualnie aktywny w powłoce roboczej użytkownika i mapuje:
     - `/v2/sessions/current/scene` -> pobiera widok projekcji aktywnego `ModelDefinition`.
     - `/v2/sessions/current/simulation/commands` -> deleguje do `ApplicationCoordinator.submit_command()`.
     - `/v2/sessions/current/persistence/*` -> deleguje do `ProjectRepository`.
  3. Frontend może być migrowany stopniowo: ekran po ekranie przechodzi na natywne API `/v2/projects/{id}`, podczas gdy pozostałe widoki działają stabilnie przez adapter.

---

#### 3.4. Wydajność zapisu gęstych trajektorii (Hybrydowy CAS + Zarr)
- **Zagrożenie:** Liczenie sumy kontrolnej SHA-256 dla każdego wycinka pola magnetyzacji podczas gęstych kroków czasowych zadławi podsystem dyskowy.
- **Rozwiązanie:**
  - Pliki manifestów, siatki geometryczne, definicje materiałów i operatory zapisujemy w **CAS** (zapewniając pełną deduplikację).
  - Trajektorie czasowe i gęste zrzuty pól 3D zapisujemy w **strumieniu chunkowanym Zarr / HDF5** (wykorzystując istniejący moduł `fullmag-runner/src/autosave_zarr.rs`). Manifest runu zawiera referencję do całego strumienia danych bez konieczności rejestracji każdego kroku czasowego jako osobnego obiektu CAS.

---

### 4. Podsumowanie planu migracji

Plan migracji P0–P8 w połączeniu z powyższymi 4 mechanizmami gwarantuje:
1. **Zero przerw w działaniu CI:** testy jednostkowe i integracyjne zachowują zielony status na każdym etapie.
2. **Bezpieczeństwo danych użytkowników:** format `.fms` v1 jest automatycznie migrowany z zachowaniem kopii zapasowej.
3. **Płynne przejście UX:** UI Control Room zyskuje stabilność od pierwszego etapu (faza P1), a pełną wielozadaniowość osiąga w fazie P5.
