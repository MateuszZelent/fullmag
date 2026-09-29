# P6-D — Explorer i pinned observation source

Data: 29.09.2026
Status: **TYPECHECK/LINT/API HYGIENE PASS, REGRESJE ZAPISANE / NOT RUN**

## Zakres

Control Room pokazuje publiczne immutable observation frames pod
`Results → Dynamics → State snapshots`. Każda ramka ma własny typ selection,
który zachowuje `frame_id`, run/stage, adapter, accepted step/revision,
runtime epoch i `state_digest`. Własny Inspector pokazuje descriptor oraz jawne
akcje `Pin source` i `Unpin`.

Pinned source jest małym deskryptorem w warstwie workspace. Nie przechowuje
payloadu FMVP ani kopii serwerowego resource. Zawiera dokładną tożsamość sesji,
więc projekcja hooka nie ujawnia ramki po zmianie `session_id`, session epoch lub
request-scope epoch, a store usuwa wtedy stary pin. Explorer zaznacza dokładnie
przypiętą ramkę i nie retargetuje selection do innej ramki po odświeżeniu
katalogu.

## Dowody

- `pnpm --dir apps/control-room typecheck`: **PASS**,
- scoped ESLint dla zmienionych plików: **PASS**,
- `scripts/ci-resource-first-gates.sh` przez Git Bash: **PASS**,
- `git diff --check`: **PASS**.

Regresje store/session fencing oraz mapowania katalog → Explorer → selection są
zapisane, ale pozostają **NOT RUN** z powodu aktywnego zakazu kompilacji testów
jednostkowych.

## Granica

Pin jest teraz trwałym stanem bieżącego workspace/session, ale viewport nie
zużywa jeszcze historycznego pola. Następny przyrost musi podać historyczne
`m` do istniejącego domain-neutral render-modelu, zachować osobne identity
topologii i field bufferu oraz wykonać browser/WebGL proof: widoczny canvas,
`contextLost=false` i niezerowy drawing buffer.

P6 rośnie z **2% do 4%**. Cały plan pozostaje około **49%**.
