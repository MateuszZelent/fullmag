# P1 — browserowy lifecycle projektu na aktywnej sesji

Data: 21.09.2026. Smoke uruchomiono na rzeczywistym Control Room z aktywną
sesją API przez lokalny proxy/dev-server `http://127.0.0.1:3104/workspace`.
Nie użyto mocka API ani ścieżki `EmptyWorkspace` bez sesji.

## Scenariusz

Wykonawczy skrypt
`apps/control-room/scripts/smoke-project-lifecycle-runtime.mjs` (komenda
`pnpm --dir apps/control-room smoke:project-lifecycle-runtime`) czekał na
aktywne menu sesji, a następnie przez menu `File` wykonał:

1. `New Project` z nazwą `Untitled project`;
2. `Save Project` i odczyt pobranego archiwum;
3. `Open Project` przez rzeczywisty file chooser z tymi samymi bajtami;
4. ponowny `Save Project` i porównanie bytes 1:1;
5. `Close Project` oraz potwierdzenie stanu `No project`.

## Wynik

```text
state: passed
first download: untitled-project.fms
second download: roundtrip.fms
archive bytes: 942
byte roundtrip: true
close project: verified
forbidden runtime/solver requests: []
```

Raport maszynowy zapisano w:
`apps/control-room/.fullmag/reports/project-lifecycle-runtime-browser/report.json`.
Smoke zakończył się `exit 0`. Odpowiedzi `404` ograniczały się do dwóch
oczekiwanych zasobów bezczynnej sesji:

- `GET /v2/sessions/current/simulation/preparation`;
- `GET /v2/sessions/current/simulation/runs/current`.

Skrypt klasyfikuje je jawnie jako dozwolony stan idle i odrzuca każdy inny
błąd HTTP. Żadne żądanie `POST` do ścieżek solvera, przygotowania, meshera,
restore, compute ani modelu nie wystąpiło. Jedynymi zapisami API były:
`POST /v2/persistence/projects` i `POST /v2/persistence/projects/open`.

## Granica dowodu

To jest dowód przeglądarkowego lifecycle projektu w zamontowanym, aktywnym
workspace oraz separacji New/Open/Save/Close od runtime. Nie jest to managed
receipt, kwalifikacja fizycznego okna Tauri, dowód zachowania tego samego węzła
DOM podczas reconnectu ani pełna session-recovery po awarii procesu. Te bramki
pozostają `NOT VERIFIED`.
