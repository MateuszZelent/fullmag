# Plan 4205406982 — workflow admission adaptive w UI

Status: niezależne SOURCE review PASS po Required; hosted model/DOM i browser mutation dowód w toku.

## Kontrakt

Globalne ustawienie adaptive wymaga jawnego FEM CPU oraz legalnych etapów aktualnej sceny. Runtime lib.rs::validate_parallel_execution_workflow dopuszcza Relax prerequisite (resolved serial) i Eigen bez bias samples: Path adaptive, Single/None resolved serial. FrequencyResponse, bias-field continuation i time integration są odrzucane. UI nie może wprowadzić ostrzejszej zasady tylko k-path, która odrzuciłaby legalny Eigen Single/Relax.

Reuse istniejących typowanych StudyStageDraftów zamiast własnego parsera raw stage. Model globalnej walidacji przyjmuje readonly workflow context. CommitGlobalDraft używa świeżo odczytanej authoritative sceny i jej stages, niezależnie od starszego draftu/preview. Preview może uwzględniać obecne stage drafts; udany preview nie jest dowodem admission przy późniejszym zapisie. Zmiany urządzenia śledzimy w kolejności etapów: każdy solver musi nadal używać CPU. Same instrukcje GPU→CPU przed solverem nie są wykonaniem GPU i nie mogą być bezpodstawnie odrzucone. Output-only actions nie są solverami, lecz puste/unknown workflow nie dowodzi eligibility.

Serial pozostaje bez nowych ograniczeń. Bez nowych endpointów, OpenAPI, global stores lub zmian requested intent. Ochrona backendu pozostaje ostatecznym gate.

## Własność i odbiór

Root: StudyGlobalAuthoringModel.ts/.test.ts i wąsko trzy callsites StudyInspectorPanel.tsx; ten plan/CI/audit. Foreign RunnerConsole/0833 zachowane. Nie uruchamiać lokalnych testów/buildów/browser/importów.

GHA: legalny Relax/Eigen Path/Single/None; frequency response, nonempty bias samples, run/unknown/no stages oraz change_device GPU; mixed workflow i authoritative context po zmianie stages. Unit/model jest dowodem walidacji, nie pełnym browser mutation proof. Browser stability, brak mutacji przy odmowie i aktualna revision pozostają odrębną wymaganą bramką; nie uznawać jej za zieloną bez wykonania.

## Required po review normalizacji

Admission musi zachować raw stage types i presence przed stratną konwersją. Tylko canonical kind i jawne flat_ aliases; dowolny substring eigen/relax nie nadaje eligibility. Bias sweep malformed samples i nie-string change_device pozostają błędem, nie domyślnym CPU/brakiem continuation. Preview może używać typed draftów, ale raw canonical integrity jest zachowana; commit używa raw authoritative scene, a dopiero potem typed stage projection. add_field_drive jest jawnie dozwoloną akcją nieobliczeniową ustawiającą wejście, nie output-only ani solverem, i sama nie dowodzi eligibility. Nie rozszerzamy nią listy solverów.

Ostatni Required: jawnie deklarowany sweep z samples=[] odrzucamy przed konwersją, zgodnie z canonical IR. Niezależne ponowne review trzech plików SOURCE PASS. Diff-check PASS; nie wykonano lokalnych testów/buildów/browser.

## Rzeczywista hosted regresja Inspector — źródła gotowe

Nowy `smoke-adaptive-study-authoring.mjs` używa produkcyjnego `/workspace`, wyboru `model:study`, istniejących v2 facade requests i zdarzenia `resource.batch_changed`. Pięć odmów bez POST: FrequencyResponse, run, unknown stage, puste bias samples, raw device=7. Relax CPU i EigenPath CPU klikają Save globals i sprawdzają rzeczywisty typed merge_patch POST, base_revision=1, adaptive/cpu oraz brak przepisywania stages.

Zmiana authoritative scene na revision2/run po przygotowaniu draftu wymusza świeży GET, błąd i wyłączony Save, zachowując panel, CPU input, wartość/focus/opacity i zero POST. Ten reachable browser case nie wykonuje wyłączonego handlera; pozytywne cases wykonują handler. Dodatkowa ochrona fresh scene w commitGlobalDraft pozostaje potwierdzona źródłowo. Nie omijamy disabled UI ani prywatnych callbacków.

Full niezależny SOURCE review PASS po Required: usunięto startup bypass, fixture dostarcza spójny sessions/status/scene kontrakt; preparation revision0 jest nieadvertised, bez preparation GET. Smoke czeka na rzeczywisty nagłówek Global Study Settings i odmontowanie overlay, następnie sprawdza tożsamość i odczyty. Raport zapisuje się exclusive wx. Node syntax check PASS. Jedno wywołanie w istniejącym browser job; lokalnego wykonania nie było. Hosted browser wynik pozostaje NOT VERIFIED do terminalnego CI i inspekcji raportu.
