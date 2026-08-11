# Dependency Security Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Usunąć wszystkie technicznie naprawialne alerty Dependabota w grafach npm i Rust oraz udokumentować i ograniczyć alerty bez dostępnej poprawki.

**Architecture:** Remediacja jest podzielona na niezależne commity: inwentaryzacja, npm, Rust i końcowa kwalifikacja. Każdy etap zmienia minimalny fragment manifestów i lockfile, a stan końcowy jest potwierdzany testami oraz ponownym odczytem Dependabota.

**Tech Stack:** pnpm 10.8.1, Node.js 24, Next.js 16, React 19, Cargo, RustSec, GitHub Dependabot API.

## Global Constraints

- Next.js pozostaje w linii 16.
- Nie wyłączamy skanowania i nie zamykamy alertów bez dowodu.
- Aktualizujemy minimalny potrzebny zakres grafu.
- Commity npm i Rust pozostają rozdzielone.
- Nie dotykamy native FEM/MFEM/CUDA; nieoczekiwane testy tej części używają kontenerowych receptur just.
- Raporty i dokumentacja są po polsku.

---

### Task 1: Migawka alertów i mapa właścicieli

**Files:**
- Create: docs/audits/2026-08-11-dependency-security-remediation.md
- Inspect: package.json
- Inspect: apps/control-room/package.json
- Inspect: apps/legacy_web/package.json
- Inspect: Cargo.toml
- Inspect: Cargo.lock
- Inspect: pnpm-lock.yaml

**Interfaces:**
- Consumes: otwarte alerty GitHub Dependabot oraz lokalne grafy pnpm i Cargo.
- Produces: tabela alertów z numerem, pakietem, poziomem, wersją naprawioną, właścicielem i powierzchnią produktu.

- [ ] **Step 1: Pobrać pełną migawkę alertów**

Run:

    gh api -X GET --paginate repos/MateuszZelent/fullmag/dependabot/alerts -f state=open -f per_page=100

Expected: tablica 50 otwartych alertów.

- [ ] **Step 2: Ustalić ścieżki zależności npm**

Run dla każdego pakietu alertowego:

    pnpm why -r next brace-expansion postcss js-yaml nanoid image-size vite @babel/core echarts sharp

Expected: każda wersja z pnpm-lock.yaml ma właściciela albo jest oznaczona jako osierocona.

- [ ] **Step 3: Ustalić ścieżki zależności Rust**

Run:

    cargo tree -i pyo3
    cargo tree -i glib
    cargo tree -i quinn-proto
    cargo tree -i serde_with

Expected: jawne crate'y bezpośrednio lub przechodnio wprowadzające każdą wersję.

- [ ] **Step 4: Zapisać raport wejściowy**

Raport musi zawierać tabelę o kolumnach: alert, ekosystem, pakiet, obecna wersja,
minimalna poprawka, właściciel, runtime/dev-only, ekspozycja i plan naprawy.
Dla image-size zapisać brak wersji naprawionej i dokładnego właściciela.

- [ ] **Step 5: Zweryfikować raport i commit**

Run:

    rg -n 'do uzupełnienia|brak danych|nieustalony' docs/audits/2026-08-11-dependency-security-remediation.md
    git diff --check

Expected: brak placeholderów i błędów whitespace.

Commit:

    git add docs/audits/2026-08-11-dependency-security-remediation.md
    git commit -m "docs: inventory dependency security alerts"

### Task 2: Remediacja grafu npm

**Files:**
- Modify: apps/control-room/package.json
- Modify: apps/legacy_web/package.json
- Modify: package.json tylko jeśli konieczne są centralne pnpm overrides
- Modify: pnpm-lock.yaml
- Modify: docs/audits/2026-08-11-dependency-security-remediation.md

**Interfaces:**
- Consumes: mapa właścicieli z Task 1.
- Produces: graf pnpm bez podatnych, naprawialnych wersji i bez zmiany Next.js poza linię 16.

- [ ] **Step 1: Zapisać stan czerwony**

Run:

    rg -n 'next@16\.2\.6|brace-expansion@(1\.1\.14|2\.1\.0|5\.0\.5)|postcss@(8\.4\.31|8\.5\.14)|js-yaml@4\.1\.1|nanoid@(3\.3\.12|5\.1\.9)|vite@8\.0\.10' pnpm-lock.yaml

Expected: dopasowania podatnych wersji.

- [ ] **Step 2: Zaktualizować zależności bezpośrednie**

Ustawić co najmniej:

    apps/control-room: next 16.2.11, eslint-config-next 16.2.11, echarts 6.1.0
    apps/legacy_web: nanoid 5.1.16, postcss 8.5.23, echarts 6.1.0

Legacy Next pozostaje w swojej linii 15 tylko wtedy, gdy najnowsza wersja 15
zamyka wszystkie odpowiadające jej alerty; w przeciwnym razie plan ma
zaktualizować legacy do kompatybilnej poprawionej wersji 16 bez zmiany
kanonicznego Control Room.

- [ ] **Step 3: Zaktualizować wyłącznie potrzebne pakiety przechodnie**

Run:

    pnpm --filter @fullmag/control-room update next@16.2.11 eslint-config-next@16.2.11 echarts@6.1.0
    pnpm --filter @fullmag/web update nanoid@5.1.16 postcss@8.5.23 echarts@6.1.0
    pnpm update -r vite@8.0.16 @babel/core@7.29.6

Następnie ograniczyć każdą przypadkową aktualizację spoza ścieżek alertowych.
Jeżeli właściciel nie dopuszcza poprawionej wersji przechodniej, dodać w
package.json precyzyjny pnpm override dla konkretnego pakietu i opisać go w
raporcie.

- [ ] **Step 4: Rozstrzygnąć image-size**

Run:

    pnpm why -r image-size
    rg -n 'image-size|imageSize|sizeOf' apps packages scripts

Jeżeli ścieżka jest zbędna, usunąć właściciela. Jeżeli jest developerska,
potwierdzić brak przetwarzania niezaufanych danych. Jeżeli jest produkcyjna,
odciąć formaty JXL, HEIF i ICNS albo zastąpić parser. Nie oznaczać alertów jako
naprawione, jeśli wersja 2.0.2 pozostaje w grafie.

- [ ] **Step 5: Zweryfikować zielony graf npm**

Run:

    pnpm install --frozen-lockfile
    pnpm audit --prod
    rg -n 'next@16\.2\.6|brace-expansion@(1\.1\.14|2\.1\.0|5\.0\.5)|postcss@(8\.4\.31|8\.5\.14)|js-yaml@4\.1\.1|nanoid@(3\.3\.12|5\.1\.9)|vite@8\.0\.10' pnpm-lock.yaml

Expected: instalacja przechodzi; audit nie zgłasza naprawialnych alertów; rg nie
znajduje podatnych wersji.

- [ ] **Step 6: Uruchomić regresję npm**

Run:

    pnpm --dir apps/control-room test
    pnpm --dir apps/control-room typecheck
    pnpm --dir apps/control-room lint
    pnpm --dir apps/control-room build
    pnpm --dir apps/legacy_web test
    pnpm --dir apps/legacy_web typecheck
    pnpm --dir apps/legacy_web build

Expected: wszystkie polecenia kończą się kodem 0.

- [ ] **Step 7: Commit npm**

Run osobno przed commitem:

    git diff --cached --name-only

Commit:

    git add package.json apps/control-room/package.json apps/legacy_web/package.json pnpm-lock.yaml docs/audits/2026-08-11-dependency-security-remediation.md
    git commit -m "fix(deps): remediate npm security alerts"

### Task 3: Remediacja grafu Rust

**Files:**
- Modify: Cargo.toml
- Modify: Cargo.lock
- Modify: crates/fullmag-py-core/src/lib.rs tylko dla wymaganej migracji PyO3
- Modify: inne pliki bindingów wskazane przez błędy kompilatora, bez refaktoru
- Modify: docs/audits/2026-08-11-dependency-security-remediation.md

**Interfaces:**
- Consumes: ścieżki zależności Rust z Task 1.
- Produces: graf Cargo bez podatnych wersji pyo3, glib, quinn-proto i serde_with.

- [ ] **Step 1: Zapisać stan czerwony**

Run:

    cargo tree -i pyo3
    cargo tree -i glib
    cargo tree -i quinn-proto
    cargo tree -i serde_with

Expected: co najmniej jedna podatna wersja dla każdego otwartego alertu.

- [ ] **Step 2: Zaktualizować PyO3**

W Cargo.toml ustawić:

    pyo3 = { version = "0.29", features = ["macros", "abi3-py310"] }

Run:

    cargo update -p pyo3 --precise 0.29.0
    cargo check -p fullmag-py-core

Naprawić wyłącznie błędy migracji API zgłoszone w fullmag-py-core, zachowując
publiczne nazwy modułów, funkcji i semantykę abi3-py310.

- [ ] **Step 3: Zaktualizować pozostały graf Rust**

Run:

    cargo update -p quinn-proto --precise 0.11.15
    cargo update -p serde_with --precise 3.21.0

Dla glib zaktualizować bezpośredniego właściciela Tauri/GTK do wersji
dopuszczającej glib co najmniej 0.20, zamiast wymuszać niezgodną wersję
przechodnią.

- [ ] **Step 4: Zweryfikować brak podatnych wersji**

Run:

    cargo tree -i pyo3
    cargo tree -i glib
    cargo tree -i quinn-proto
    cargo tree -i serde_with
    cargo audit

Expected: wersje spełniają minima 0.29.0, 0.20.0, 0.11.15 i 3.21.0; RustSec nie
zgłasza odpowiadających im alertów.

- [ ] **Step 5: Uruchomić regresję Rust**

Run:

    cargo check --workspace
    cargo test -p fullmag-py-core
    cargo test -p fullmag-api
    cargo test -p fullmag-cli
    cargo test -p fullmag-runner
    cargo test -p fullmag-session
    cargo check -p fullmag-desktop

Jeżeli ostatnia nazwa pakietu różni się od rzeczywistej, użyć nazwy package z
apps/desktop/src-tauri/Cargo.toml i zapisać ją w raporcie.

Expected: wszystkie polecenia kończą się kodem 0.

- [ ] **Step 6: Commit Rust**

Run osobno przed commitem:

    git diff --cached --name-only

Commit:

    git add Cargo.toml Cargo.lock crates/fullmag-py-core docs/audits/2026-08-11-dependency-security-remediation.md
    git commit -m "fix(deps): remediate Rust security alerts"

### Task 4: Końcowa kwalifikacja i publikacja

**Files:**
- Modify: docs/audits/2026-08-11-dependency-security-remediation.md

**Interfaces:**
- Consumes: zweryfikowane grafy npm i Rust.
- Produces: końcowy rejestr zamkniętych i pozostających alertów z dowodami.

- [ ] **Step 1: Uruchomić wspólne bramki**

Run:

    git diff --check
    pnpm install --frozen-lockfile
    cargo check --workspace

Expected: wszystkie polecenia kończą się kodem 0.

- [ ] **Step 2: Wypchnąć gałąź do przeliczenia Dependabota**

Run:

    git push -u origin codex/security-dependency-remediation

Expected: gałąź jest widoczna na origin.

- [ ] **Step 3: Ponownie pobrać alerty**

Po przeliczeniu grafu run:

    gh api -X GET --paginate repos/MateuszZelent/fullmag/dependabot/alerts -f state=open -f per_page=100

Expected: brak alertów z dostępną poprawką na wersjach obecnych w gałęzi.

- [ ] **Step 4: Zamknąć raport**

Raport musi oddzielać: naprawione lokalnie, zweryfikowane testami, przeliczone
przez GitHub oraz pozostające bez poprawki. Dla każdego pozostającego alertu
zapisać ekspozycję, ograniczenie, właściciela i warunek zamknięcia.

- [ ] **Step 5: Commit raportu**

Run osobno:

    git diff --cached --name-only

Commit:

    git add docs/audits/2026-08-11-dependency-security-remediation.md
    git commit -m "docs: qualify dependency security remediation"
