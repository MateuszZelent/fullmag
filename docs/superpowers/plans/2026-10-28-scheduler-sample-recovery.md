# Scheduler sample recovery — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for the bounded tasks below.

**Cel:** przejściowo nieaktualna próbka compute-node nie zabija schedulera;
rozliczyć bez replay przyjęty, claimed run bez workera, potwierdzić widoczne
strzałki FDM H_demag w powietrzu i bezpiecznie zamknąć własną grupę.

**Architektura:** zachować istniejący `ComputeNodeSampleNotCurrent` wraz z
przyczyną oraz `WorkerLaunchDeferred` przed wykorzystaniem launch permit.
Wygasła próbka nigdy nie pozwala na spawn. Odtwarzanie obecnego runu używa
istniejącego natywnego `--cancel-failed-no-spawn` i `WorkerNoSpawn`, z jawnymi
pinami owner/config/claim/lease/reservation oraz managed operation receipt.
Kolejne zatrzymanie i start muszą zachować natywne dowody oraz wszystkie dane.

**Technologie:** istniejący Rust runtime-control/API, Python launcher,
grupa Compose `fullmag-worktree-fullmag-8a0aa9b8c1577182`, Control Room/Playwright.

**Specyfikacja:** bezpośrednie polecenie użytkownika; ADR 0061 — terminalna awaria
przed startem workera; `docs/specs/native-runtime-service-v1.md`;
`docs/specs/compute-resource-execution-v1.md`; zachowane raw receipty
`own-scheduler-block/summary.json` w operacyjnych artefaktach tego zadania.

## Ograniczenia

- Istniejący worktree i branch; nie zmieniać MAIN ani grup innych wątków.
- Zachować sesje, wyniki, intent/CAS, historyczne dzienniki i dowody awarii.
- Nie ponawiać niejednoznacznych POST ani Solve po awarii. Nowe próby mają
  oddzielne jawne request/run IDs i wejście z limitem pracy.
- Żadnych lokalnych kompilacji unit tests Rust/C++; regression cases uruchamia
  autoryzowane GitHub CI. Lekkie Python checks dozwolone.
- Build i runtime wyłącznie w przypisanej grupie przez launcher/just.
- `Consumed`, `Unknown`, zmiana ownera/pinów lub inne aktywne rezerwacje blokują
  no-spawn cancellation; brak dowodów nigdy nie jest dowodem braku workera.
- Nie wyłączać walidacji czasu, boot ID, ownera, generacji ani limitów zasobów.

## Ryzyka do review

- Dwa odczyty próbki przed spawnem: drugi nie może nadal kończyć schedulera
  ogólnym błędem ani pozostawiać aktywnego supervision slotu.
- Wyczerpany retry oddaje sterowanie pętli schedulera, aby drain/anulowanie
  pozostawały obsługiwane. Ten sam claim/Start/lease pozostaje przypięty.
- Błędy właściciela, konfiguracji, CAS i uszkodzonego rekordu nadal są fatalne.
- Operator używa natywnego monotonicznego protokołu, a nie edycji JSON.
- Stop po błędzie i start nowej binarki muszą mieć kompletne receipty Linux,
  również przy zachowanym niepustym store i terminalnym runie.

## Kroki

- [x] Zidentyfikować wyzerowanie przyczyny w `host_runtime` i brak deferral
  w `accepted_study_supervisor`; zachować wcześniejsze receipty błędu.
- [x] Dodać regresje Rust dla chwilowego braku próbki, odroczenia po retry,
  ponownego odczytu i niezmienionej fatalności konfliktów tożsamości.
- [x] Poprawić `crates/fullmag-runtime-control/src/host_runtime.rs` i
  `crates/fullmag-api/src/accepted_study_supervisor.rs`; przypiąć testy w CI.
- [x] Dodać managed wrapper natywnego no-spawn cancellation, jego Python
  regresje, receptę just i dokumentację istniejącego operatora. Przed apply
  ponownie sprawdzić rzeczywiste piny i wszystkie chronione dane runów.
- [x] Wykonać jedną kontrolowaną cancellation; potwierdzić `Cancelled`,
  `Closed`, oba release i niezmienność pozostałych runów. Zachować receipt.
- [x] Zakwalifikować i wykonać bezpieczny stop/restart wyłącznie własnej grupy;
  poprawić właściwy managed guard, jeżeli brakuje zgodnej ścieżki Linux.
- [x] Build aplikacji w tej grupie; sprawdzić scheduler po odświeżeniu próbki
  i terminalny wynik kontrolnego FDM z jawnym output storage i limitem czasu.
- [ ] UI: Airbox ma H_demag/H_eff/H_ext i nie ma m; dane H_demag mapują się
  dokładnie na pusty support, widoczne strzałki w screenshot, niezagubiony
  WebGL, dodatni drawing buffer. Nie mylić SwiftShader z kwalifikacją GPU.
- [ ] Niezależny review, wymagane CI, commit/push/PR/merge i koordynowane FF.
- [ ] Zachować sesje/wyniki i artefakty operatora; drain/usunąć tylko własne
  kontenery, wykonać kwalifikowaną retencję i dokończyć cykl worktree.
  Jeżeli aplikacja blokuje usunięcie primary checkoutu, użyć wspieranego
  surviving checkoutu albo zapisać precyzyjną blokadę bez force.

## Checkpoint źródeł i kontroli

- `18ac614fc1d9ff37541837567768664e1b68ed94`: typed sample error oraz deferral,
  cztery regresje przypięte w CI; lokalnie nie kompilowano testów Rust.
- Wrapper operatora, osobny dowód Linux i finalizer historycznego loader error:
  175 lekkich regresji Python PASS (9 + 10 + 35 + 45 + 64 + 12).
- Pierwsze wywołanie operatora zatrzymał loader przed wykonaniem native;
  unknown receipt i request zachowane. Kontrolowane 86 plików / 324022 B
  pozostaje byte-identical; dokładny probe owner/config/claim/lease/gate także.
- Kanoniczne środowisko CPU ABI + `ldd` przechodzi w działającym backendzie.
  Odczytowy helper z przypiętego obrazu potwierdził właściwe binarium.
- Managed preview reconciliacji: PASS, 12 plików target runu, inventory
  `acb6ddc2a1841193a511ff4c1a4e2807ad5e3fc33f401ba6cba94cd107df5e09`.
  Na tym checkpointcie apply, przebudowa i końcowy render pozostają niewykonane.

## Checkpoint runtime i poprawki po CI

- `c6ad1e0c0be98b888ee40b5ecdcdecb0b58ae289` oraz
  `6375bd7fa954920b5cfb80eb705cc03fe7f84b70`: operator i dowód Linux,
  177 lekkich regresji Python PASS; kwalifikowana reconciliacja helpera PASS.
- Native cancellation runu `run-live-3e280...`: Cancelled / Closed,
  oba release; proof `67b6398174e2ce5b0c81f955f20d1375df8c6bf27e3ecc81b515bc610aa400ea`.
- 86 chronionych plików / 324022 B identycznych po cancellation i stop/recreate.
- Development `15e3ae3b65934ae38af6baa5f9ab7c96`, config
  `643f32a06034dde9cc217c49118d05844296e5500d60c1587780996ff1050877`:
  API Ready, HEAD 6375bd7fa, dirty (dwa prywatne skrypty operatora), snapshot
  `f1398590eee9ba81c998f8bc5560108c9ab27136875e3369c5d4d80571db3b61`.
- Jeden Compute Study z UI: run `run-live-b2c435...`, 200 kroków, 2e-11 s,
  CPU double, command `fm-cddd02a1-ff8d-4140-b5dd-7f4dabd17d3c` completed.
  Oba schedulery pozostają Ready. Binary proof: 576 komórek, 448 magnetycznych,
  128 pustych; każde H_demag finite/nonzero, dokładny mask/full-domain match.
  Sam render nadal wymaga końcowego potwierdzenia.
- CI `40785689859`, rust-contracts: dwie nowe regresje wykazały wcześniejszy
  generyczny brak próbki w `current_compute_node_owner_for_admission` oraz
  błędną asercję context marker przez `chain()` zamiast `downcast_ref()`.
  Poprawka zachowuje typ także przy rekonstrukcji requestu hosta; brak
  aktywnego inventory ownera jest availability failure, konfiguracja/I/O
  oraz konflikt tożsamości pozostają fatalne. Dodatkowa regresja utraty
  inventory ownera zachowuje claim, lease i Pending gate.
- Regresje Rust ponawia wyłącznie GitHub CI; lokalny zakaz kompilacji testów
  pozostaje w mocy. Nie oznaczono PR gotowym do merge przed zielonym CI.
