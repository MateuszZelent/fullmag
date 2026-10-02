# Startup — ponowne zlecenie buildu nr 200

Data: 02.10.2026. Stan: RUNNING; terminalny wynik NOT VERIFIED.

Poprzednia blokada pojemności zniknęła: worker_alive=true,
accepting_jobs=true, brak worker_error, wolne 43 795 341 312 B podczas preflight.
Koordynator został wcześniej wymieniony przez operatora; nie wykonywano
w tej pracy restartu runnera, zmiany profilu ani cleanupu.

- Job: `7295501a0e4847039a7ae806f780dcdc`, sequence 200.
- Profil: `fem-cpu-release`.
- Źródło: commit `18e816e7a0e4020c260730db0affc20c3db19312`.
- Source digest: `3e371f63467c61119d026aa571f0262049137d404dece840a56878ff0f3a9602`.
- Capture: `8cc4cd0fa7a244baae26f6fe29554dac`.
- Native snapshot: `bfeb6f2a68f8ff1c3ed06d33d61d62be5ee4648548b21c9dc3a0402f44982ca5`.
- Snapshot clean; obce dirty backendy checkoutu nie są źródłem tego buildu.

API runnera początkowo potwierdziło prepare=running. Worker zakończył
przygotowanie i opublikował native-build start; kompilacja jest w trakcie.
Brak terminalnego receipt nie jest PASS ani failure.
Nie zgłaszamy ponownie tego samego zadania po timeout obserwatora.

Sesja 3104 pozostaje dostępna: jeden obiekt, brak aktywnego solvera.
Dwie karty przeglądarki odczytano bez reloadu. W widocznym Inspectorze Universe
pola numeryczne są puste, advanced authored policy JSON = {}, grading auto.
Nie mutowano sesji i nie wykonano meshera. Odczyt DOM nie dowodzi braku
ukrytych draftów innych paneli.

Naprawy ACK/replacement są w kodzie tego joba. Checkpointy wymagają odrębnego
rozstrzygnięcia [adaptera storage](11-desktop-session-storage-proposal.md).
Pytanie operatorowe jest oczekujące; provisionowanie nie rozpoczęło się.

## Import definicji do prywatnej sesji — PASS

Na 3114 sprawdzono PUT model/scene z pełnym canonical request scope.
Pierwszy PUT z revision=1 przy pustym target revision=0 zwrócił prawidłowy
409 scene_stale_revision. Ponowny GET potwierdził brak mutacji, a jawne
użycie target revision=0 zakończyło się 200.
GET docelowy: objects=1, revision=1; objects i cała scena poza revision
zgadzają się ze źródłem. Ponowny GET oryginału 3104 zgadza się z jego
wartością sprzed importu. Przeglądarka 3114 pokazuje Objects 1 / New box.
Nie zaliczamy tego jako checkpoint ani restore po restarcie.

![Odtworzona definicja sceny na prywatnym porcie 3114](12-user-scene-restored.jpg)

## Bootstrap ponownego startu — PASS fragmentu

Naprawiono świeży-only mkdir w launcherze. Na kontenerze prywatnego 3114
wykonano dokładny skrypt bootstrapu w nowych probe roots: pierwszy i drugi
start bootstrapu exit 0; konflikt linku źródłowego, symlink workspace i
symlink .fullmag exit 2. Nie restartowano API, nie mutowano sesji ani źródeł.
Probe directories zachowano. Dowód: [receipt](12-bootstrap-probe.json).
11 lekkich regresji Python PASS. Ten fragment nie zalicza odtworzenia aktywnej
sesji po restarcie, trwałości storage ani checkpointów.
