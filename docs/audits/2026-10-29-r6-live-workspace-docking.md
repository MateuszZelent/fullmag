# R6 — dokowanie podczas rzeczywistych obliczeń

Worktree: `eigensolve-integration-ui-20261026`, frontend `ba499002e` + rozszerzony
observer. UI: localhost:3217. Grupa
`fullmag-worktree-eigensolve-integration-ui-202610-78b341212cbdaa7d`.

Uruchomiono ponownie `examples/fem_eigen_mode_ui_de_k10.py` przez
`docker_dev.py script`, request `eigensolve-r6-docking-20261029-1`.
Zarządzana aktywacja succeeded, attempt `2c51326d1dcf48c8972b9c4f25666f87`.
Nowy run: `run-live-643d6b919feab5b065a5495ee01c5925cc720fc90f3605f3dffdcbbf41512367`.
Nie restartowano backendu ani innych grup. Poprzednie wyniki pozostają zachowane.

## Kryteria

Każda operacja musi mieć `running` przed i po oraz ten sam run ID. Browser
blokuje wszelkie komendy numeryczne; dopuszcza tylko odczyt i prezentację.
Do PASS wymagane są też ukończenie runu i opublikowanie jego widma.
Zakres: float, move/resize, maximize/restore, hide/show, dock oraz rzeczywiste
gesty myszy: przeciąganie/dokowanie Inspectora, Explorera, diagnostyki i resize
zadokowanego podziału. To kwalifikacja lifecycle UI, nie zbieżności fizyki.

Pierwszy obserwator zakończył się na przejściowym HTTP 404 podczas retirement
starej sesji. Solver nie został przerwany; ponowiono wyłącznie obserwatora
tego samego runu. Przed przypięciem dopuszcza on teraz 404 obok istniejącego
409; po przypięciu nadal każdy taki błąd przerywa próbę.

Status: **techniczna kwalifikacja R6 dla nowego dokowania PASS**, łącznie
w dwóch kwalifikujących przebiegach (13 + 1 operacji), nie w jednej sekwencji.

## Rozdzielenie prób

Pierwszy pilot: 13 operacji PASS przed/po; zakończenie naturalne podczas
ostatniego separatora (tej operacji nie zaliczono). Widmo pierwszego pilota
jest opublikowane: 11.211886649715792 GHz, residual 1.6022730082536981e-13.
Drugi pilot `92d343cf…` również ukończony z widmem; jego obserwator napotkał
chwilowy brak geometrii uchwytu podczas wymiany sesji. Dodano oczekiwanie na
widoczny separator. Powtórny observer wystartował za późno, więc nie zaliczono
tej próby i zakończono wyłącznie własny oczekujący proces obserwatora.

Trzeci pilot `eac6101631fa040379ba6c1769c605c600eb9fa1630303f18cb098f7818a6ad1`:
przeglądarka była gotowa przed aktywacją; tylko brakująca zmiana rozmiaru
separatora — PASS z running przed i po. Nie zmieniano parametrów modelu,
siatki ani tolerancji w celu przedłużania obliczeń. Kryteriów nie obniżono.


## Wynik końcowy

Trzeci pilot completed, 3 kroki; spectrum.v3 opublikowane z tym samym run ID.
Wszystkie trzy piloty zwróciły 11.211886649715792 GHz. Każda z 14 zaliczonych
operacji miała running przed i po oraz niezmieniony identyfikator przebiegu.
W kwalifikujących próbach zero pageerror i prób mutacji numerycznych z UI.
Nie wykryto przerwania solvera przez obsługę paneli. Ręczny odbiór użyteczności
z nową osobą oraz pełna kwalifikacja naukowa pozostają odrębnymi zadaniami.

[Pełne dowody, identyfikatory, pomiary i hashe](2026-10-29-r6-live-workspace-docking.evidence.json).

[UI podczas pracy solvera](/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/r6-live-docking-20261029/resize-final/panels-during-solve.png).
