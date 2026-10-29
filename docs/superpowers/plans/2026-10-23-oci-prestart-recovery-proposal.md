# Propozycja odzyskania po odrzuceniu OCI przed PID 1

Status: **zatwierdzony przez użytkownika 23.10.2026; dokładny patch zastosowany**.
Pełny kanoniczny preview zakończył się PASS; reconciliation i start są kolejnymi krokami.
Nie zapisano journalu ani terminalnego receiptu, nie zwolniono lease i nie uruchomiono usług.

## Konkretny stan

Operacja `6db0e30ac9df4824bd366d4af20c9457`, bazowy development `4f5f21c2dc754f02b9135ae3a88bed6e`, port 3203.
Kontrolowany drain zakończył się prawidłowo. Backend nie rozpoczął nowej inkarnacji:
StartedAt nadal `2026-10-23T10:41:37.358632328Z`, PID 0, ExitCode 128,
OOMKilled=false. Frontend jest zatrzymany z kodem 0. Oryginalny lease nadal działa.
Błąd dotyczy hooka NVIDIA `/sbin/ldconfig` zakończonego SIGKILL przed PID 1.
Log jądra potwierdza CPU watchdog. Przyczyna przekroczenia tego limitu pozostaje
niewyjaśniona; sam brak flagi OOM nie wyklucza wpływu presji pamięci.
Oficjalne źródło NVIDIA ustawia limit czasu CPU 10 s: [nvc_ldcache.c](https://raw.githubusercontent.com/NVIDIA/libnvidia-container/main/src/nvc_ldcache.c), funkcja `limit_resources`.
Ta propozycja nie zmienia sterownika, CDI, konfiguracji NVIDIA ani demona Docker.

| Rola | Dokładny kontener | Obraz |
|---|---|---|
| lease | `872f628719571080f12a36d6c985d1efc2755a01ea5a6d102207f8fe8d10ab48` | `sha256:d49bb8a4ff97fb5fe477947a3f02aa8c0a53eae77e11f00ec28618a0bcaa2ad1` |
| backend | `6172ba4376f431b2347f4946300bc2de6905470fae64da434d90d5df07d17592` | `sha256:ec2384b94c02f8376599b1bd3ffbaab9c404f54e623a3cbde1481790ca8dc008` |
| frontend | `bb53edec2dda33d27ba8f50439f733a97d7e0e3588fce1b640bca5b5b662f068` | `sha256:ec2384b94c02f8376599b1bd3ffbaab9c404f54e623a3cbde1481790ca8dc008` |

Pełne StartedAt/fingerprint i CAS znajdują się w przypiętym request JSON.
Aktualny HEAD przed propozycją: `9b6e2c042d180265cab054b432a97aba10341e12`.
Snapshot poprzedniego pakietu pozostaje zachowany; propozycja zmienia wyłącznie procedurę recovery.
Dowód zachowania wyników: control volume
`verification/universe-volume-policy-20261023/post-failed-prestart-results-preserved.json`:
PASS, 70 plików, 5 katalogów run, 0 nowych Solve. Jest to niezależny dowód kontroli wyników;
walidator recovery ponownie sprawdza kanoniczny katalog historii i archiwum, nie zastępuje tego raportu nowym formatem wyników.

## Zakres i piny przeglądu

- Inert patch: `2026-10-23-oci-prestart-recovery-proposal.patch.txt`, SHA256 `136c5d0ef949219e528bf6125e2976b9f468fd99bb5abf264a552fcc271c0b4b`.
- Nowy niewłączony helper: `scripts/docker_volume_prestart_recovery.py`, SHA256 `113afff608c36a5c280ebd9f6e68130ed167f36611dc93b415bfe0c2ccaf7561`.
- Testy: `scripts/test_docker_volume_prestart_recovery.py`, SHA256 `92952066a9ec8308b31ba777dec942ee2bbe43a2f227402cdedc76225bb6b6a5`.
- Request: `2026-10-23-oci-prestart-recovery-request.json`, SHA256 `daa2fc63db52b91099316ff6c2597ffb6a7c77e91596f038a52b2f1996931751`.
- Unknown receipt: `86724a6dc40735127b9e04f1cb0a60994017c7502c34af897e0941f70a2b82e1`.
- Checkpoint: `02b26eaae06c44e2f9fabcbaa0f77540a1fcef785d6123f0ae1b4f861096cf16`.
- Drain: `6211d2e029d9d23ec92fcfa01df7ed12f2c0759c2b7fb0aa3a7b4aab66635dc9`.
- Final preflight: `79bafb58cd7e0e6e6496b4b6ab7de0cda391158e5555ace71958700707488d61`.

| Plik | SHA256 przed | SHA256 po proponowanym patchu |
|---|---|---|
| `scripts/docker_volume_reconcile.py` | `7f35fdc9d10090e9a2699867a7dd4865fc24fbcc3a7a3953e917bb51329172fe` | `873296018d6ad71e4a90bb768429dfb6c2c721939157b1d0131d1810a3a1fb2f` |
| `scripts/docker_volume_dev.py` | `294b35edf135e084fa1ce435faad44d28048d9bd4dbf11460aa1a2d72d294aaa` | `9844e419fca883e6438885c9a5934e4eae42b480bf27396d2a88197e83f69a9c` |
| `scripts/docker_dev.py` | `f215d5666756f51052122badfc6c48fd5d71388b10ed6a137204df232563e5b4` | `25af47a58b97cdc75310511f95af9a68346bf4482029a74a6e1fa11367311c60` |
| `justfile` | `d866664fbdf67c86ae9b10bdf97ed6e1ec89c2f03e372de394c7aa36242bbbce` | `651a0805524ea405a2f7805511c2db43ac0ba74fad6cc0abde2d3ec5d365f2bc` |

## Kontrakt

Istniejący `docker_volume_reconcile.py` otrzymuje jeden nowy wariant failure-only.
Wymaga identycznego unknown receipt, źródła/config/image, trzech kontenerów,
pełnego Docker State obu usług, konkretnego błędu hooka i niezmienionego StartedAt
z checkpointu. Natywny terminalny process receipt musi być dokładnie tym samym
potwierdzonym drained receipt; istniejąca kontrola właściciela i dzieci nadal obowiązuje.
Archiwum i wszystkie jawnie przypięte katalogi historii muszą pozostać zgodne.
Odrzuca nowy backend_started_at, build receipt, aktywny PID, OOM, zmianę kontenera,
nieznany hook, zmianę historii/archiwum i zmianę kodu kontrolera/helpera.
Certyfikat Linux jest sprawdzany przez istniejący `_retained_certificate`.
Stare warianty Windows/success/Make pozostają bez zmiany kontraktu.

Publication nadal używa istniejących `claim_script`, `commit_script`, immutable journal
oraz oryginalnego helpera lease. Wynik to wyłącznie `failed-confirmed`; żaden kod nie
usuwa ręcznie active ani nie publikuje succeeded/verified dla nieuruchomionego buildu.

Dalsza kontynuacja używa istniejącego `docker-dev-resume` z dwoma opcjonalnymi pinami
terminalnego reconcile. Bez nich dotychczasowe zachowanie pozostaje bez zmian.
Kontynuacja sprawdza dowód ponownie po objęciu lease, przed startem, zabrania startup
script i przenosi obowiązek saved-authoring do istniejącego `_saved_authoring_complete`.
Lease pozostaje zatrzymany aż health potwierdzi brak aktywnej sesji oraz historia i archiwum
przejdą kontrolę. Nie ma wywołania Solve ani automatycznego importu projektu.

## Procedura dopiero po zgodzie

1. Zastosować dokładnie przypięty patch, zachowując helper/testy; sprawdzić hashe.
   Nie nadpisywać zmian innych osób. Zmiana któregokolwiek pinu wymaga ponownego przeglądu.
2. Zapisać dokładne bajty requestu w control volume przez BuildControl jako dokument techniczny.
3. Uruchomić canonical `docker_volume_reconcile.py --preview` przez istniejący just
   `docker-dev-reconcile-activation <request> <SHA> <source> 3203 true`.
   Wariant preview nowego schema wykonuje tylko walidację; może tworzyć istniejące
   krótkotrwałe image-owned helpery read-only. Nie publikuje journalu ani terminalu.
4. Przy PASS użyć `just docker-dev-reconcile-iteration <request> <SHA> <source> 3203`.
   Sprawdzić dokładny terminal `failed-confirmed` i samoczynne zwolnienie starego lease.
5. Przypiąć świeżo otrzymany terminal SHA. Jedna próba:
   `just docker-dev-resume 4f5f21c2dc754f02b9135ae3a88bed6e 81fba96e475108187ca75f37b0bc582e2b3444e37ce1415033e954b3979ab409 <source> 3203 true 6db0e30ac9df4824bd366d4af20c9457 <terminal-SHA>`.
   Nie da się uczciwie podać terminal-SHA przed wykonaniem reconciliation.
6. Po nowym buildzie sprawdzić saved-authoring completion gate, ponownie 70 hashy
   oraz 5 katalogów, dopiero potem odtworzyć jawnie zapisany projekt bez Solve.

Jeżeli kolejny managed start znów zakończy się błędem hooka: STOP, zachować unknown
outcome i lease, bez automatycznych ponowień, bez Solve i bez zmiany globalnych ustawień.

## Weryfikacja i ograniczenia

16 interpretowanych testów offline: PASS. Subprocess i socket były blokowane;
patch odtworzono wyłącznie w pamięci, bez zmiany aktywnych launcherów.
Po ewentualnym zastosowaniu testy przechodzą na rzeczywisty kod kontrolera,
aby nie próbować nakładać tego samego patcha drugi raz. Testy obejmują
odmowę po zmianie CAS, przeliczonych pinach aktywnego PID/OOM/stanu/exit, złym hooku,
frontend failure, brakujących pinach, natywnym receipt, owner/drain, archiwum i historii.
Przetestowano zachowanie starego requestu bez nowej opcji oraz odrębność wariantu Make.
Nie wykonano kompilacji ani zmiany stanu runtime.

Rzeczywista kontrola rdzenia read-only: **PASS**. Sprawdzono schema requestu,
State CAS/hook, identyczne trzy kontenery/StartedAt/fingerprint, oryginalnego właściciela
lease, prywatną sieć, Compose CAS, certyfikat `linux-native-v1`, natywny drained receipt,
jego właścicieli, oryginalny checkpoint, pełne przypięte katalogi historii oraz archiwum.
Użyto istniejących kanonicznych, krótkotrwałych helperów diagnostycznych tej samej grupy.
Raport: control volume `verification/universe-volume-policy-20261023/oci-prestart-core-proof.json`.
Zapisano wyłącznie raport techniczny. Active lease zachowany; 0 startów usług, 0 Solve.

Formalne `--preview` całej CLI po zgodzie i zastosowaniu dokładnego patcha: **PASS**,
exit code 0, wynik `validated-only` dla operacji `6db0e30ac9df4824bd366d4af20c9457`.
Log w control volume: `verification/universe-volume-policy-20261023/formal-approved-prestart-preview.log`.
16 interpretowanych regresji po zastosowaniu patcha: PASS. Reconciliation i późniejszy
managed restart pozostają na tym checkpointcie niewykonane.

Osobna zgoda wymagana przez przekazane AGENTS.md, sekcję 8, została uzyskana
23.10.2026: „Tak, zastosuj patch i wykonaj recovery”. Obejmuje przypięty patch
oraz jedną zarządzaną próbę startu naszej grupy 3203.


### Korekta integracji writer — w granicach zatwierdzonego przypadku

Pierwszy pełny reconciliation zatrzymał się przed utworzeniem helpera obserwacji:
`commit_script` nadal dopuszczał wyłącznie schema błędu Make. Nie zapisano journalu,
terminalu ani nie zmieniono lease i usług. Regresja konstruktora claim/commit
odtwarza ten błąd przed poprawką. Minimalna korekta dopuszcza w tym samym
failure-only writerze także wcześniej zatwierdzony PRESTART_SCHEMA; pozostałe
schema nadal są odrzucane. Preview generuje teraz ten sam skrypt writera przed
powrotem, bez uruchamiania go. Niezależny przegląd nie wykazał innego pominięcia
schema ani rozszerzenia polityki. Publikowane są tylko receipt/current/terminal,
bez verified i bez ręcznego usuwania active.

Po korekcie: 18 interpretowanych testów PASS i pełny canonical preview PASS.
Nowy SHA256 kontrolera: `424ea583457bf650ba63e7baa1c76da01d705ac41997f53c9a4a0198e19b3d23`.
Wszystkie piny kontenerów, State, checkpointu, drainu i historii są bez zmian.
Request wiąże nowy kod kontrolera: `000b108ff680d4e0d89acc3f3f9b603fabec25ac927326c66ec01856abc78f3e`,
w pliku `2026-10-23-oci-prestart-recovery-writer-fixed-request.json`.
Logi: `prestart-writer-red.log`, `prestart-writer-green.log` oraz
`formal-writer-fixed-prestart-preview.log` pod
`verification/universe-volume-policy-20261023/` w control volume.
To domknięcie już zatwierdzonego przypadku prestart, bez nowego rodzaju
recovery, zmiany polityki lub dodatkowej próby startu. Usługi nadal zatrzymane;
0 nowych startów i Solve na tym checkpointcie.
