# Propozycja: saved-authoring na Linux z zachowaną historią

Status: wyłącznie propozycja; bramka scripts/docker_volume_dev.py nie została zmieniona ani uruchomiona.

Automatyczna kontrola odrzuciła zastosowanie rozszerzenia trwałej bramki restartu: uznała rozszerzenie Linux wykonane tekstową edycją bez wcześniejszych testów i review za ryzyko obejścia zabezpieczeń. Dotychczasowa zgoda na replacement/build nie została uznana za zgodę na ten konkretny patch. Przed zastosowaniem wymagane jest rozstrzygnięcie tej odmowy przez root oraz konkretna aprobata użytkownika.

Zakres: opcjonalne retained_run_catalogs przypina run_id, SHA256, rozmiar i task_id/lifecycle. Tylko succeeded/failed/cancelled; interrupted i wszystkie stany aktywne są odrzucane. Pełna lista katalogów musi się zgadzać; nie ma usuwania historii. Przed zatrzymaniem obowiązuje istniejąca blokada store, puste temp/recovery, zwolnione hostowe rezerwacje, pusta kolejka/polecenia nowej sesji i wszystkie dotychczasowe bramki API, preparation, mesh i właściciela.

Linux używa image-owned linux_native_probe.validate_host oraz odczytu istniejących dowodów restartu/mountu/namespace. Canonical store identity odpowiada payloadowi HostResourceLedger::store_id. Windows zachowuje dotychczasowy kontrakt i nie wymaga nowego pola requestu. Odczyt FMS używa istniejącego host adaptera właściwego dla systemu.

Po potwierdzonym authenticated drain, przed startem, oraz po restarcie przed publikacją sukcesu launcher ponownie porównuje katalogi historii. Zmiana historii powoduje odmowę; nie jest naprawiana. Istniejący mechanizm nieznanego wyniku i zachowania operacyjnej blokady pozostaje.

Dowód: tests-final.json — 25 testów, 0 błędów, 0 failures. Testowano inertną kopię w named control volume, source mount readonly, brak sieci/socketu Dockera/mountów danych użytkownika; dodatkowo subprocess.Popen i socket.create_connection blokowane. Testy obejmują Windows bez nowego pola, Linux admission z mockiem image helpera, negatywne namespace/checks, niezgodne hashe/rozmiary/stan zadań, brakujące piny, symlink odmówiony przez delegated reader, aktywne lease/kolejkę i kontrolę po drain.

Ograniczenia: nie wykonywano restartu, buildu aplikacji ani rzeczywistego Linux restart smoke. Testy fixture nie dowodzą zachowania 70 plików naukowych; root zachowuje i porównuje ich pełne hashe przed i po operacji. W razie odmowy przed zatrzymaniem stosuje się istniejący recovery frontendu; przy niepewnym drain/start nie ponawiać automatycznie ani nie zwalniać lease ręcznie. Stary root, wyniki, katalogi i package pozostają dowodami. Nie ma Solve.

Patch: proposed.patch
SHA256 patcha: db889d5572d26f3bd60a4f7d6ec53d89402caca6c938bfb572f533694cec59e8
SHA256 źródła przed: 3f271fdb495245b8ba85a867e62cf82b275a1417f3109776aa6610e25ecaf7d5
SHA256 proponowanego źródła po: 294b35edf135e084fa1ce435faad44d28048d9bd4dbf11460aa1a2d72d294aaa

## Zakres decyzji i aktualny stan

Prośba dotyczy zastosowania poniższego dokładnego patcha do
`scripts/docker_volume_dev.py`, użycia dwóch dołączonych plików helpera/testów
i weryfikacji przez dotychczasową receptę `just docker-dev-restart-saved-authoring`
wyłącznie dla naszej grupy WSL na3203. Poprzednia zgoda użytkownika na
zachowanie wyników, zastąpienie testowej obserwacji, build i odtworzenie sceny
pozostaje ważna. Nowa decyzja dotyczy konkretnego rozszerzenia bramki.

Wszystkie70 plików runu b0 i Zarr porównano ponownie: identyczne SHA256
i rozmiary. Aktualnej sesji nie zastąpiono. Scenę zapisano przez publiczny
`projects/authoring` i ponownie otwarto: obiekty antenna/sampling, geometria,
transport oraz stage zachowane. Archiwum autorstwa ma8542B i SHA256
`c7186b27052a39b83f06f1469c50de526df5d81563eda347fe1e35612a4bcd23`.
To archiwum sceny; pełnego FMS obserwacji live nadal nie utworzono.

Regresja pełnej ścieżki eksportu/importu w CI39936822692 dla
`009a7ac52e96d263f2c5c6db538f8a63b720e8aa` przeszła. Pozostały wynik
CI należy odczytać przed kwalifikacją integracji. Poprawka bramki nie jest
jeszcze wdrożona. W razie zmiany źródła lub przypiętych katalogów trzeba
przygotować nowy przegląd; nie stosować patcha częściowo ani z fuzz.

Przegląd roota: sprawdzono pełny diff, image-owned `validate_host`, kanoniczne
ścieżki runtime, nowy helper i testy. Nie stwierdzono blokującego błędu
w przedstawionym zakresie. Brak rzeczywistego restartu pozostaje jawną
bramką weryfikacji, a nie dowodem zaliczenia.

## Podgląd niezastosowanego patcha

W podglądzie usunięto spacje z pustych linii kontekstu. Dokładne bajty
`proposed.patch` pozostają w podanym wolumenie kontrolnym i są przypięte
SHA256 `db889d5572d26f3bd60a4f7d6ec53d89402caca6c938bfb572f533694cec59e8`.

```diff
--- a/scripts/docker_volume_dev.py
+++ b/scripts/docker_volume_dev.py
@@ -21,6 +21,7 @@
                                   mirror_console)
 from docker_dev_host import docker_argv, require_host, local_volume, validate_host_path
 import docker_preclaim_cancelled_restart as preclaim_restart
+import docker_saved_authoring_history as retained_history

 INCLUDE_UNTRACKED_ENV = "FULLMAG_DEV_INCLUDE_UNTRACKED"
 _MAX_INCLUDE_UNTRACKED_FILES = 10000
@@ -3272,10 +3273,12 @@
 def _saved_authoring_validate_request(request, *, project, attempt, config_sha256, selected):
     cancelled = preclaim_restart.validate_checkpoint(request)
     historical = preclaim_restart.validate_historical_checkpoint(request)
+    retained = retained_history.validate_retained_catalogs(request)
     _saved_authoring_require(set(request) == ({'schema', 'compose_project', 'attempt', 'config_sha256',
         'source_root', 'exclusive_operator_window', 'archive', 'session', 'containers',
         'package', 'service_owner_sha256'} | ({'cancelled_preclaim'} if cancelled else set())
-        | ({'historical_preclaim'} if historical else set())), 'checkpoint fields differ')
+        | ({'historical_preclaim'} if historical else set())
+        | ({'retained_run_catalogs'} if retained is not None else set())), 'checkpoint fields differ')
     _saved_authoring_require(request['schema'] in {'fullmag.saved-authoring-restart.v1', preclaim_restart.SCHEMA}
         and request['compose_project'] == project and request['attempt'] == attempt
         and request['config_sha256'] == config_sha256
@@ -3393,9 +3396,9 @@

 def _saved_authoring_read_archive(request, state):
     import fullmag_storage as storage
-    from windows_folder_host import read_owned_regular
+    read_owned_regular = _session_host().read_owned_regular
     path = Path(request['archive']['path'])
-    _saved_authoring_require(path.is_absolute() and path.suffix.lower() == '.fms', 'absolute Windows FMS path required')
+    _saved_authoring_require(path.is_absolute() and path.suffix.lower() == '.fms', 'absolute FMS path required')
     storage.validate_path(path, state / 'runs' / 'projects', 'saved authoring project')
     raw = read_owned_regular(path, maximum=_SAVED_AUTHORING_MAX_ARCHIVE_BYTES)
     return raw, _saved_authoring_validate_archive(raw, request['archive'])
@@ -3479,7 +3482,9 @@
         and opened.get('mode', {}).get('kind') == 'read_write', 'canonical project open differs')
     _saved_authoring_require(isinstance(probe.get('accepted_store_id'), str)
         and re.fullmatch(r'sha256:[0-9a-f]{64}', probe['accepted_store_id'])
-        and probe.get('run_directories') == preclaim_restart.expected_run_directories(request)
+        and probe.get('run_directories') == (sorted(row['run_id'] for row in request['retained_run_catalogs'])
+            if 'retained_run_catalogs' in request else preclaim_restart.expected_run_directories(request))
+        and probe.get('retained_run_catalogs') == retained_history.validate_retained_catalogs(request)
         and probe.get('transient_files') == []
         and isinstance(probe.get('reservation_states'), list)
         and all(s == 'released' for s in probe['reservation_states']), 'durable affected admissions/leases are not empty')
@@ -3493,7 +3498,7 @@
     preclaim_restart.validate_historical_binding(probe, request)


-_SAVED_AUTHORING_PROBE_SCRIPT = r"""import base64,fcntl,hashlib,json,os,pathlib,stat,sys,time,urllib.error,urllib.parse,urllib.request,uuid
+_SAVED_AUTHORING_PROBE_SCRIPT = retained_history.PROBE_FUNCTION + "\n" + r"""import base64,fcntl,hashlib,json,os,pathlib,stat,sys,time,urllib.error,urllib.parse,urllib.request,uuid
 MAX=8*1024*1024
 request=json.load(sys.stdin)
 pin=request['checkpoint']; session=pin['session']
@@ -3562,22 +3567,47 @@
 if os.environ.get('FULLMAG_ACCEPTED_STORE_SCOPE') or store!=pathlib.Path(os.environ['FULLMAG_RUNS_ROOT'])/'session-store': raise RuntimeError('accepted store differs from the canonical service store')
 host_raw=regular(paths.host_certificate)
 host=json.loads(host_raw)
-owner=json.loads(regular(paths.state/'.fullmag-windows-folder-owner.json'))
-grant=json.loads(regular(paths.state/'.fullmag-windows-folder-grant.json'))
-if (host!=request['host_certificate'] or owner!=host or host.get('schema')!='fullmag.windows-folder-host.v1'
- or host.get('storage_profile')!='windows-folder-v1' or host.get('restart_verified') is not True
- or grant.get('schema')!='fullmag.windows-folder-session.v1' or grant.get('state')!='operational'
- or grant.get('container_root')!='/state' or grant.get('host_attestation_sha256')!=hashlib.sha256(host_raw).hexdigest()
- or grant.get('owner_token')!=host.get('owner_token')): raise RuntimeError('Windows store ownership/admission differs')
-relative=store.relative_to(paths.state).as_posix()
-if relative=='.' or '..' in pathlib.PurePosixPath(relative).parts: raise RuntimeError('unsafe accepted store relative path')
-owner_token=host['owner_token']
-if str(uuid.UUID(owner_token))!=owner_token or uuid.UUID(owner_token).int==0: raise RuntimeError('invalid store owner token')
-if type(host.get('host_volume_serial')) is not int or host['host_volume_serial']<=0: raise RuntimeError('invalid host volume serial')
-stable_identity={'schema':'fullmag.docker-admitted-store-identity.v2',
- 'host_root':host['host_root'].replace('\\','/').translate(str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')),
- 'host_volume_serial':host['host_volume_serial'],'engine_id':host['engine_id'],
- 'owner_token':owner_token,'relative_state_path':relative}
+profile=host.get('storage_profile')
+if host!=request['host_certificate']: raise RuntimeError('host storage certificate differs')
+if profile=='linux-native-v1':
+ if os.environ.get('FULLMAG_SESSION_STORAGE_PROFILE')!=profile: raise RuntimeError('Linux storage profile differs')
+ import linux_native_probe
+ verified,verified_raw,payload=linux_native_probe.validate_host(paths.state,paths.host_certificate,require_restart=True)
+ if verified!=host or verified_raw!=host_raw or regular(paths.state/'.linux-native-restart')!=payload:
+  raise RuntimeError('Linux host restart admission differs')
+ probe=json.loads(regular(paths.state/'.linux-native-probe.json'))
+ state_stat=paths.state.stat()
+ checks={'file_sync','directory_sync','atomic_replace','process_lock','no_follow_symlink','sqlite_transactions','restart_readback'}
+ if (probe.get('schema')!='fullmag.linux-native-probe.v1' or probe.get('storage_profile')!=profile
+  or probe.get('owner_token')!=host['owner_token'] or probe.get('host_attestation_sha256')!=hashlib.sha256(host_raw).hexdigest()
+  or probe.get('root_device')!=state_stat.st_dev or probe.get('root_inode')!=state_stat.st_ino
+  or probe.get('mount_namespace_inode')!=pathlib.Path('/proc/self/ns/mnt').stat().st_ino
+  or not isinstance(probe.get('checks'),dict) or set(probe['checks'])!=checks
+  or any(probe['checks'][key] is not True for key in checks) or store.stat().st_dev!=state_stat.st_dev):
+  raise RuntimeError('Linux storage probe mount/namespace/checks differ')
+ relative=store.relative_to(paths.state).as_posix()
+ if relative=='.' or '..' in pathlib.PurePosixPath(relative).parts: raise RuntimeError('unsafe Linux store relative path')
+ # Canonical HostResourceLedger::store_id payload; admission remains image-owned.
+ stable_identity={'schema':'fullmag.linux-native-store-identity.v1','engine_id':host['engine_id'],
+  'owner_token':host['owner_token'],'relative_state_path':relative}
+elif profile=='windows-folder-v1':
+ owner=json.loads(regular(paths.state/'.fullmag-windows-folder-owner.json'))
+ grant=json.loads(regular(paths.state/'.fullmag-windows-folder-grant.json'))
+ if (host!=request['host_certificate'] or owner!=host or host.get('schema')!='fullmag.windows-folder-host.v1'
+  or host.get('storage_profile')!='windows-folder-v1' or host.get('restart_verified') is not True
+  or grant.get('schema')!='fullmag.windows-folder-session.v1' or grant.get('state')!='operational'
+  or grant.get('container_root')!='/state' or grant.get('host_attestation_sha256')!=hashlib.sha256(host_raw).hexdigest()
+  or grant.get('owner_token')!=host.get('owner_token')): raise RuntimeError('Windows store ownership/admission differs')
+ relative=store.relative_to(paths.state).as_posix()
+ if relative=='.' or '..' in pathlib.PurePosixPath(relative).parts: raise RuntimeError('unsafe accepted store relative path')
+ owner_token=host['owner_token']
+ if str(uuid.UUID(owner_token))!=owner_token or uuid.UUID(owner_token).int==0: raise RuntimeError('invalid store owner token')
+ if type(host.get('host_volume_serial')) is not int or host['host_volume_serial']<=0: raise RuntimeError('invalid host volume serial')
+ stable_identity={'schema':'fullmag.docker-admitted-store-identity.v2',
+  'host_root':host['host_root'].replace('\\','/').translate(str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')),
+  'host_volume_serial':host['host_volume_serial'],'engine_id':host['engine_id'],
+  'owner_token':owner_token,'relative_state_path':relative}
+else: raise RuntimeError('unsupported saved-authoring storage profile')
 store_id='sha256:'+hashlib.sha256(canon(stable_identity)).hexdigest()
 ledger=pathlib.Path(os.environ['FULLMAG_HOST_LEDGER_ROOT'])
 for root in (store,ledger):
@@ -3589,6 +3619,8 @@
  run_directories=sorted(p.name for p in runs.iterdir())
  history=pin.get('historical_preclaim')
  expected_runs=sorted(binding['cancelled_preclaim']['run_id'] for binding in (pin,history) if binding and 'cancelled_preclaim' in binding)
+ retained_catalogs=observe_retained_catalogs(store,pin,regular)
+ if retained_catalogs is not None: expected_runs=sorted(row['run_id'] for row in retained_catalogs)
  if run_directories!=expected_runs: raise RuntimeError('accepted runs, admissions or leases differ')
  transient_files=inventory(store/'temp')+inventory(store/'recovery')
  if transient_files: raise RuntimeError('store has pending writes/recovery')
@@ -3614,7 +3646,7 @@
 extra={}
 if 'cancelled_preclaim' in pin or 'historical_preclaim' in pin: extra.update(preclaim_cancelled_snapshots(store,ledger,pin))
 for name,path in [('current',''),('status','/status'),('scene','/model/scene')]: rows[name+'_after']=api('/v2/sessions/current'+path)
-print(json.dumps({'schema':'fullmag.saved-authoring-restart-probe.v1','resources':rows,'run_directories':run_directories,'transient_files':transient_files,'reservation_states':reservation_states,'accepted_store_id':store_id,'foreign_reservations_observed':foreign_reservations,'process_receipt':receipt,'provenance_sha256':hashlib.sha256(provenance_raw).hexdigest(),'source_snapshot_sha256':provenance.get('source_snapshot_sha256'),**extra},sort_keys=True))
+print(json.dumps({'schema':'fullmag.saved-authoring-restart-probe.v1','resources':rows,'run_directories':run_directories,'retained_run_catalogs':retained_catalogs,'transient_files':transient_files,'reservation_states':reservation_states,'accepted_store_id':store_id,'foreign_reservations_observed':foreign_reservations,'process_receipt':receipt,'provenance_sha256':hashlib.sha256(provenance_raw).hexdigest(),'source_snapshot_sha256':provenance.get('source_snapshot_sha256'),**extra},sort_keys=True))
 """


@@ -3649,9 +3681,26 @@
     return observed


+
+def _saved_authoring_verify_retained_history(request, state):
+    pins = retained_history.validate_retained_catalogs(request)
+    if pins is None:
+        return
+    store = storage.validate_path(state / 'runs' / 'docker-all' / 'session-store', state,
+                                  'retained authoring history')
+    entries = list((store / 'runs').iterdir())
+    _saved_authoring_require(all(path.is_dir() and not path.is_symlink() for path in entries)
+        and sorted(path.name for path in entries) == sorted(row['run_id'] for row in pins),
+        'retained history directories changed after drain')
+    observed = retained_history.observe_retained_catalogs(
+        store, request, lambda path: _session_host().read_owned_regular(path, maximum=8 * 1024 * 1024))
+    _saved_authoring_require(observed == pins, 'retained history changed after drain')
+
+
 def _saved_authoring_complete(control, operation, backend_id, request, state, checkpoint_sha):
     """Keep the retained lease until every saved-authoring completion gate passes."""
     post_health = _saved_authoring_verify_post_restart(backend_id)
+    _saved_authoring_verify_retained_history(request, state)
     _saved_authoring_read_archive(request, state)
     control.write(operation["root"] + "/saved-authoring-restart-result.json", {
         "schema": "fullmag.saved-authoring-restart-result.v1", "state": "succeeded",
@@ -5625,6 +5674,7 @@
             drained_raw, drained = _read_terminal_process_receipt(stopped, control)
             if saved_authoring:
                 _saved_authoring_validate_drain(authoring_probe, drained)
+                _saved_authoring_verify_retained_history(saved_authoring, state)
                 _saved_authoring_read_archive(saved_authoring, state)
             control.write(operation["root"] + "/backend-drain.json", {
                 "schema": "fullmag.docker-idle-restart-drain.v1",
```

## Dowód testów offline

```json
{
  "exit_code": 0,
  "stderr": "test_exact_history_does_not_relax_live_queue_or_host_leases (test_docker_saved_authoring_history.ProposedGateTests) ... ok\ntest_legacy_checkpoint_cannot_authorize_nonempty_history (test_docker_saved_authoring_history.ProposedGateTests) ... ok\ntest_linux_probe_uses_image_validator_and_rejects_changed_admission (test_docker_saved_authoring_history.ProposedLinuxAndDrainTests) ... ok\ntest_post_drain_history_is_checked_before_restart_and_success (test_docker_saved_authoring_history.ProposedLinuxAndDrainTests) ... ok\ntest_active_catalog_and_recomputed_pins_still_refuse (test_docker_saved_authoring_history.RetainedHistoryAdditionalTests) ... ok\ntest_regular_reader_refusal_is_not_swallowed (test_docker_saved_authoring_history.RetainedHistoryAdditionalTests) ... ok\ntest_changed_bytes_are_rejected (test_docker_saved_authoring_history.RetainedHistoryTests) ... ok\ntest_duplicate_runs_tasks_and_preclaim_mix_are_rejected (test_docker_saved_authoring_history.RetainedHistoryTests) ... ok\ntest_exact_terminal_catalog_is_returned_unchanged (test_docker_saved_authoring_history.RetainedHistoryTests) ... ok\ntest_legacy_checkpoint_has_no_history_authority (test_docker_saved_authoring_history.RetainedHistoryTests) ... ok\ntest_malformed_and_unbounded_pins_are_rejected (test_docker_saved_authoring_history.RetainedHistoryTests) ... ok\ntest_nonterminal_states_fail (test_docker_saved_authoring_history.RetainedHistoryTests) ... ok\ntest_pins_cannot_override_actual_task_lifecycle (test_docker_saved_authoring_history.RetainedHistoryTests) ... ok\ntest_wrong_schema_run_or_revision_rejected_even_when_digest_matches (test_docker_saved_authoring_history.RetainedHistoryTests) ... ok\ntest_accepts_exact_durable_authoring_archive_and_scope (test_docker_volume_receipts.SavedAuthoringRestartTests) ... ok\ntest_fixed_probe_checks_real_store_and_ledger_without_backend_or_solver (test_docker_volume_receipts.SavedAuthoringRestartTests) ... ok\ntest_real_finish_and_operation_keep_unknown_postconditions_nonterminal (test_docker_volume_receipts.SavedAuthoringRestartTests) ... ok\ntest_real_finish_publishes_success_only_after_all_authoring_gates (test_docker_volume_receipts.SavedAuthoringRestartTests) ... ok\ntest_refuses_changed_saved_bytes_and_runtime_or_duplicate_archive_entries (test_docker_volume_receipts.SavedAuthoringRestartTests) ... /usr/local/lib/python3.10/zipfile.py:1542: UserWarning: Duplicate name: 'project/scene_document.json'\n  return self._open_to_write(zinfo, force_zip64=force_zip64)\nok\ntest_refuses_container_replacement_config_or_started_at_and_requires_window (test_docker_volume_receipts.SavedAuthoringRestartTests) ... ok\ntest_refuses_different_owner_epochs_run_preparation_queue_mesh_and_source (test_docker_volume_receipts.SavedAuthoringRestartTests) ... ok\ntest_revision_only_mesh_fallback_requires_no_manifest_or_real_build_owner (test_docker_volume_receipts.SavedAuthoringRestartTests) ... ok\ntest_same_native_owner_and_children_required_for_authenticated_drain (test_docker_volume_receipts.SavedAuthoringRestartTests) ... ok\ntest_ui_authoring_has_no_active_script_and_preserves_original_only_in_fms (test_docker_volume_receipts.SavedAuthoringRestartTests) ... ok\ntest_unknown_preflight_keeps_frontend_quiesced_and_retains_lease (test_docker_volume_receipts.SavedAuthoringRestartTests) ... ok\n\n----------------------------------------------------------------------\nRan 25 tests in 5.300s\n\nOK\n",
  "stdout": "{\"tests\": 25, \"failures\": 0, \"errors\": 0, \"proposed_sha256\": \"294b35edf135e084fa1ce435faad44d28048d9bd4dbf11460aa1a2d72d294aaa\"}\n"
}
```
