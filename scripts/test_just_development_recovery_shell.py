"""Check fixed-argv development recovery dispatch without Docker or temporary files."""
from pathlib import Path
import os
import subprocess
import unittest


class DevelopmentRecoveryShellTests(unittest.TestCase):
    def test_prelaunch_actual_recipes_dispatch_exact_flags_and_reject_extra_commands(self):
        repo = Path(__file__).resolve().parents[1]
        source = '/selected/worktree with spaces/$(printf injected);literal'
        base = ['a' * 32, 'b' * 64, source]
        recipes = [('docker-dev-stop-prelaunch-failure', base + ['3242'],
                    [b'--stop-only', b'--quiesce-api', b'--capture-prelaunch-failure']),
                   ('docker-dev-recreate-prelaunch-failure', base + ['c' * 32, 'd' * 64, '3242'],
                    [b'--fresh-state', b'--prelaunch-failure-stop', b'c' * 32,
                     b'--prelaunch-failure-stop-sha256', b'd' * 64])]
        for name, args, suffix in recipes:
            with self.subTest(recipe=name):
                dry = subprocess.run(['just', '--justfile', str(repo / 'justfile'), '--dry-run', name, *args],
                                     capture_output=True, text=True, timeout=15)
                self.assertEqual(dry.returncode, 0, dry.stderr)
                recipe = dry.stderr.strip()
                result = self.dispatch(recipe, marker='  *"scripts/docker_dev.py"*)\n')
                self.assertEqual(result.returncode, 0, result.stderr)
                argv = result.stdout.split(b'\0')[:-1]
                self.assertEqual(argv[-len(suffix):], suffix)
                self.assertEqual(argv[argv.index(b'--source-root') + 1], source.encode())
                for tail in ('; printf injected', ' --force'):
                    refused = self.dispatch(recipe + tail, marker='  *"scripts/docker_dev.py"*)\n')
                    self.assertEqual(refused.returncode, 2)
                    self.assertNotIn(b'injected', refused.stdout)

    def test_prepared_completed_archive_actual_recipe_dispatches_only_both_pins(self):
        repo = Path(__file__).resolve().parents[1]
        base = ['a' * 32, 'b' * 64, '/selected/checkout', 'c' * 32, 'd' * 64, 'e' * 64,
                'sha256:' + 'f' * 64, 'engine-id']
        for plan, apply in [('', 'false'), ('1' * 64, 'true')]:
            dry = subprocess.run(['just', '--justfile', str(repo / 'justfile'), '--dry-run',
                'docker-dev-resume-interrupted-fresh-archive', *base, plan, apply, '2' * 64, '3' * 64],
                capture_output=True, text=True, timeout=15)
            self.assertEqual(dry.returncode, 0, dry.stderr)
            result = self.dispatch(dry.stderr.strip(), marker='  *"scripts/docker_dev.py"*)\n')
            self.assertEqual(result.returncode, 0, result.stderr)
            argv = result.stdout.split(b'\0')[:-1]
            self.assertIn(b'resume-interrupted-fresh-archive', argv)
            at = argv.index(b'--prepared-quarantine-sha256')
            self.assertEqual(argv[at:at+4], [b'--prepared-quarantine-sha256', b'2' * 64,
                                          b'--prepared-archive-terminal-sha256', b'3' * 64])
            self.assertEqual(b'--apply' in argv, apply == 'true')

    def test_prepared_stop_real_recipe_preserves_preview_apply_and_continuation_as_fixed_argv(self):
        repo = Path(__file__).resolve().parents[1]
        source = '/selected/checkout with spaces/$(printf injected);literal'
        target = '/diagnostics/prepared target.json'
        marker = '  *"scripts/docker_volume_stop_failed.py"*)\n'
        base = [source, 'a' * 64, 'sha256:' + 'b' * 64, 'c' * 64, 'd' * 32, target, 'e' * 64]
        for extra in ([], ['true', 'f' * 64], ['true', 'f' * 64, '1' * 64]):
            with self.subTest(extra=extra):
                dry = subprocess.run(['just', '--justfile', str(repo / 'justfile'), '--dry-run',
                                      'docker-dev-stop-prepared-unclaimed', *base, *extra],
                                     capture_output=True, text=True, timeout=15)
                self.assertEqual(dry.returncode, 0, dry.stderr)
                result = self.dispatch(dry.stderr.strip(), marker=marker)
                self.assertEqual(result.returncode, 0, result.stderr)
                argv = result.stdout.split(b'\0')[:-1]
                expected = [b'/recorded/python', b'-B', b'/registered/checkout/scripts/docker_volume_stop_failed.py',
                            b'--failure-variant', b'prepared-unclaimed-v1', b'--source-root', source.encode(),
                            b'--container-id', b'a' * 64, b'--image-id', b'sha256:' + b'b' * 64,
                            b'--process-receipt-sha256', b'c' * 64, b'--activation-attempt', b'd' * 32,
                            b'--prepared-target', target.encode(), b'--prepared-target-sha256', b'e' * 64]
                if extra:
                    expected += [b'--apply', b'--expected-plan-sha256', b'f' * 64]
                if len(extra) == 3:
                    expected += [b'--continue-intent-sha256', b'1' * 64]
                self.assertEqual(argv, expected)

    def test_prepared_stop_wrapper_rejects_bad_pins_extra_options_and_shell_commands(self):
        recipe = ('python "/ignored/scripts/docker_volume_stop_failed.py" --failure-variant prepared-unclaimed-v1 '
                  "--source-root '/selected' --container-id '" + 'a' * 64 + "' --image-id 'sha256:" + 'b' * 64
                  + "' --process-receipt-sha256 '" + 'c' * 64 + "' --activation-attempt '" + 'd' * 32
                  + "' --prepared-target '/target.json' --prepared-target-sha256 '" + 'e' * 64 + "'")
        marker = '  *"scripts/docker_volume_stop_failed.py"*)\n'
        for invalid in [recipe + '; printf injected', recipe + ' --force', recipe + ' --apply',
                        recipe + " --continue-intent-sha256 '" + 'f' * 64 + "'",
                        recipe.replace('e' * 64, 'not-a-hash'), recipe.replace('prepared-unclaimed-v1', 'legacy')]:
            with self.subTest(invalid=invalid):
                result = self.dispatch(invalid, marker=marker)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertNotIn(b'injected', result.stdout)

    def dispatch(self, recipe, marker='  *"scripts/docker_volume_development_interrupted.py"*)\n'):
        source = globals().get('WRAPPER') or (Path(__file__).resolve().parent / 'just_storage_shell.sh').read_text()
        body = source.split(marker, 1)[1].split('\n    ;;', 1)[0]
        program = ('set -euo pipefail\nrecipe="$RECIPE_LITERAL"\n'
                   'python_cmd="/recorded/python"\nrepo_root="/registered/checkout"\nscript_dir="/registered/checkout/scripts"\n'
                   'exec() { printf \'%s\\0\' "$@"; }\n' + body)
        return subprocess.run(['/bin/bash', '--noprofile', '--norc', '-c', program],
            env={**os.environ, 'RECIPE_LITERAL': recipe}, capture_output=True, timeout=15)

    def recipe(self, *, source='/selected/worktree', digest='a' * 64,
               request='verification/own/request.json', apply=False):
        return ('python "/ignored/scripts/docker_volume_development_interrupted.py" '
                f"--request '{request}' --request-sha256 '{digest}' --source-root '{source}'"
                + (' --apply' if apply else ''))

    def interrupted_archive_recipe(self, *, source='/selected/worktree', prior='a' * 32,
                                   config='b' * 64, recreation='c' * 32,
                                   unknown='d' * 64, helper='e' * 64,
                                   image='registry.example/fullmag/helper:dev@sha256:' + 'f' * 64,
                                   engine='engine-id', apply=False, plan='1' * 64):
        recipe = ('python "/ignored/scripts/docker_dev.py" --repo-root "/ignored" '
                  'resume-interrupted-fresh-archive '
                  f"--prior-attempt '{prior}' --config-sha256 '{config}' "
                  f"--source-root '{source}' --recreation-attempt '{recreation}' "
                  f"--unknown-receipt-sha256 '{unknown}' --helper-container-id '{helper}' "
                  f"--helper-image '{image}' --engine-id '{engine}'")
        if apply:
            recipe += f" --apply --expected-plan-sha256 '{plan}'"
        return recipe

    def test_cold_quarantine_real_recipe_preserves_preview_and_apply_pins(self):
        repo = Path(__file__).resolve().parents[1]
        source = '/selected/worktree with spaces/$(printf injected);literal'
        for apply in (False, True):
            arguments = [source, 'a' * 32, 'b' * 32]
            if apply:
                arguments.extend(['true', 'c' * 64])
            dry = subprocess.run(['just', '--justfile', str(repo / 'justfile'), '--dry-run',
                'docker-dev-quarantine-failed-bootstrap', *arguments],
                capture_output=True, text=True, timeout=15)
            self.assertEqual(dry.returncode, 0, dry.stderr)
            result = self.dispatch(dry.stderr.strip(), marker='  *"scripts/docker_dev.py"*)\n')
            self.assertEqual(result.returncode, 0, result.stderr)
            expected = [b'/recorded/python', b'/registered/checkout/scripts/docker_dev.py',
                        b'--repo-root', b'/registered/checkout', b'quarantine-failed-bootstrap',
                        b'--source-root', source.encode(), b'--operation-attempt', b'a' * 32,
                        b'--recovery-id', b'b' * 32]
            if apply:
                expected.extend([b'--apply', b'--expected-plan-sha256', b'c' * 64])
            self.assertEqual(result.stdout.split(b'\0')[:-1], expected)

    def test_completed_cache_real_recipe_preserves_preview_and_apply_pins(self):
        repo = Path(__file__).resolve().parents[1]
        target = 'fullmag-backend-v2-' + 'a' * 24 + '-package'
        registry = '/registered/storage/index/completed task.json'
        for apply in (False, True):
            arguments = [registry, target, 'b' * 32]
            if apply:
                arguments.extend(['true', 'c' * 64])
            dry = subprocess.run(['just', '--justfile', str(repo / 'justfile'), '--dry-run',
                'docker-dev-reconcile-completed-cache', *arguments],
                capture_output=True, text=True, timeout=15)
            self.assertEqual(dry.returncode, 0, dry.stderr)
            result = self.dispatch(dry.stderr.strip(), marker='  *"scripts/docker_dev.py"*)\n')
            self.assertEqual(result.returncode, 0, result.stderr)
            expected = [b'/recorded/python', b'/registered/checkout/scripts/docker_dev.py',
                        b'--repo-root', b'/registered/checkout', b'reconcile-completed-cache',
                        b'--registry', registry.encode(), b'--volume', target.encode(),
                        b'--recovery-id', b'b' * 32]
            if apply:
                expected.extend([b'--apply', b'--expected-plan-sha256', b'c' * 64])
            self.assertEqual(result.stdout.split(b'\0')[:-1], expected)

    def test_retire_stopped_real_recipe_does_not_lose_retire_only_flag(self):
        repo = Path(__file__).resolve().parents[1]
        dry = subprocess.run(['just', '--justfile', str(repo / 'justfile'), '--dry-run',
            'docker-dev-retire-stopped', 'a' * 32, 'b' * 64, '/selected/worktree', '3342'],
            capture_output=True, text=True, timeout=15)
        self.assertEqual(dry.returncode, 0, dry.stderr)
        result = self.dispatch(dry.stderr.strip(), marker='  *"scripts/docker_dev.py"*)\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(b'\0')[-3:-1], [b'--fresh-state', b'--retire-only'])

    def test_cold_and_retirement_dispatch_reject_unpinned_or_composite_mutations(self):
        cold = ('python "/ignored/scripts/docker_dev.py" --repo-root "/ignored" '
                "quarantine-failed-bootstrap --source-root '/selected/worktree' "
                "--operation-attempt '" + 'a' * 32 + "' --recovery-id '" + 'b' * 32 + "'")
        retire = ('python "/ignored/scripts/docker_dev.py" --repo-root "/ignored" '
                  "recreate-volume --attempt '" + 'a' * 32 + "' --config-sha256 '" + 'b' * 64
                  + "' --source-root '/selected/worktree' --port '3342' --fresh-state --retire-only")
        invalid = [cold + ' --apply', cold + " --expected-plan-sha256 '" + 'c' * 64 + "'",
                   cold + " --apply --expected-plan-sha256 'short'",
                   retire.replace(' --fresh-state', ''), retire + ' --retire-only']
        invalid.extend(recipe + suffix for recipe in (cold, retire)
                       for suffix in ('; printf injected', ' && printf injected', '\nprintf injected'))
        for recipe in invalid:
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe, marker='  *"scripts/docker_dev.py"*)\n')
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)

    def test_preview_dispatches_fixed_arguments_without_apply(self):
        source = '/selected/$(printf injected);worktree'
        result = self.dispatch(self.recipe(source=source, apply=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(b'\0')[:-1], [
            b'/recorded/python', b'-B',
            b'/registered/checkout/scripts/docker_volume_development_interrupted.py',
            b'--request', b'verification/own/request.json', b'--request-sha256', b'a' * 64,
            b'--source-root', source.encode()])

    def test_publication_requires_explicit_apply(self):
        result = self.dispatch(self.recipe(apply=True))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(b'\0')[-4:-1], [b'--source-root', b'/selected/worktree', b'--apply'])
        self.assertIn(b'--apply', result.stdout)

    def test_invalid_pins_and_composite_commands_are_rejected(self):
        for recipe in (self.recipe(digest='short'), self.recipe(digest='A' * 64),
                       self.recipe(request='verification/$(printf injected).json'),
                       self.recipe() + '; printf injected', self.recipe() + ' && printf injected',
                       self.recipe() + '\nprintf injected',
                       self.recipe().replace(" --request-sha256 '" + 'a' * 64 + "'", ''),
                       self.recipe() + ' --port 3203',
                       self.recipe(apply=True) + ' --apply',
                       self.recipe(source="/selected/unsafe'quote")):
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)

    def test_interrupted_fresh_archive_preview_dispatches_exact_pins_literally(self):
        source = '/selected/worktree with spaces/$(printf injected);literal'
        engine = 'engine-$(printf injected);literal'
        image = 'registry.example/$(printf_injected);literal/helper:dev@sha256:' + 'f' * 64
        recipe = self.interrupted_archive_recipe(source=source, engine=engine, image=image)
        result = self.dispatch(recipe, marker='  *"scripts/docker_dev.py"*)\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(b'\0')[:-1], [
            b'/recorded/python', b'/registered/checkout/scripts/docker_dev.py',
            b'--repo-root', b'/registered/checkout', b'resume-interrupted-fresh-archive',
            b'--prior-attempt', b'a' * 32, b'--config-sha256', b'b' * 64,
            b'--source-root', source.encode(), b'--recreation-attempt', b'c' * 32,
            b'--unknown-receipt-sha256', b'd' * 64, b'--helper-container-id', b'e' * 64,
            b'--helper-image', image.encode(), b'--engine-id', engine.encode(),
        ])

    def test_interrupted_fresh_archive_apply_dispatches_exact_plan_pin(self):
        recipe = self.interrupted_archive_recipe(apply=True, plan='2' * 64)
        result = self.dispatch(recipe, marker='  *"scripts/docker_dev.py"*)\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(b'\0')[:-1], [
            b'/recorded/python', b'/registered/checkout/scripts/docker_dev.py',
            b'--repo-root', b'/registered/checkout', b'resume-interrupted-fresh-archive',
            b'--prior-attempt', b'a' * 32, b'--config-sha256', b'b' * 64,
            b'--source-root', b'/selected/worktree', b'--recreation-attempt', b'c' * 32,
            b'--unknown-receipt-sha256', b'd' * 64, b'--helper-container-id', b'e' * 64,
            b'--helper-image', ('registry.example/fullmag/helper:dev@sha256:' + 'f' * 64).encode(),
            b'--engine-id', b'engine-id', b'--apply', b'--expected-plan-sha256', b'2' * 64,
        ])

    def test_real_just_recipe_preview_and_apply_are_accepted_by_dispatch(self):
        repo = Path(__file__).resolve().parents[1]
        pins = ['a' * 32, 'b' * 64, '/selected/worktree', 'c' * 32,
                'd' * 64, 'e' * 64,
                'registry.example/helper:dev@sha256:' + 'f' * 64, 'engine-id']
        for apply in (False, True):
            with self.subTest(apply=apply):
                arguments = pins + (['2' * 64, 'true'] if apply else [])
                dry = subprocess.run(['just', '--justfile', str(repo / 'justfile'),
                    '--dry-run', 'docker-dev-resume-interrupted-fresh-archive', *arguments],
                    capture_output=True, text=True, timeout=15)
                self.assertEqual(dry.returncode, 0, dry.stderr)
                result = self.dispatch(dry.stderr.strip(), marker='  *"scripts/docker_dev.py"*)\n')
                self.assertEqual(result.returncode, 0, result.stderr)
                words = result.stdout.split(b'\0')[:-1]
                self.assertEqual(b'--apply' in words, apply)
                if apply:
                    self.assertEqual(words[-3:], [b'--apply', b'--expected-plan-sha256', b'2' * 64])

    def test_interrupted_fresh_archive_rejects_bad_pins_and_noncanonical_options(self):
        base = self.interrupted_archive_recipe()
        invalid = (
            self.interrupted_archive_recipe(prior='A' * 32),
            self.interrupted_archive_recipe(config='short'),
            self.interrupted_archive_recipe(recreation='z' * 32),
            self.interrupted_archive_recipe(unknown='z' * 64),
            self.interrupted_archive_recipe(helper='short'),
            self.interrupted_archive_recipe(image='registry.example/fullmag/helper:mutable'),
            self.interrupted_archive_recipe(engine=''),
            self.interrupted_archive_recipe(source='relative/worktree'),
            self.interrupted_archive_recipe(apply=True, plan='not-a-sha'),
            base + " --unexpected 'value'",
            base + " --apply",
            base + " --expected-plan-sha256 '" + '1' * 64 + "'",
            base + "; printf injected",
            base + " && printf injected",
            base + "\nprintf injected",
        )
        for recipe in invalid:
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe, marker='  *"scripts/docker_dev.py"*)\n')
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)


    def test_idle_restart_preserves_explicit_prepared_session_flag(self):
        recipe = ('python "/ignored/scripts/docker_dev.py" --repo-root "/ignored" '
                  "restart-idle-volume --attempt '" + 'a' * 32 + "' --config-sha256 '" + 'b' * 64
                  + "' --source-root '/selected/$(printf injected);worktree' --port '3203'")
        marker = '  *"scripts/docker_dev.py"*)\n'
        expected = [b'/recorded/python', b'/registered/checkout/scripts/docker_dev.py',
                    b'--repo-root', b'/registered/checkout', b'restart-idle-volume',
                    b'--attempt', b'a' * 32, b'--config-sha256', b'b' * 64,
                    b'--source-root', b'/selected/$(printf injected);worktree', b'--port', b'3203']
        for suffix in ('', ' --allow-prepared-session', ' --stop-only --allow-prepared-session'):
            with self.subTest(suffix=suffix):
                result = self.dispatch(recipe + suffix, marker=marker)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.split(b'\0')[:-1],
                                 expected + [word.encode() for word in suffix.split()])
        for suffix in (' --allow-prepared-session --allow-prepared-session',
                       ' --allow-prepared-session true', ' --allow-prepared-session; printf injected',
                       ' --allow-prepared-session && printf injected',
                       ' --allow-prepared-session\nprintf injected'):
            with self.subTest(suffix=suffix):
                result = self.dispatch(recipe + suffix, marker=marker)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)




    def test_frontend_frozen_refresh_uses_exact_structured_arguments(self):
        source = "/selected/$(printf injected);worktree"
        recipe = ('python "/ignored/scripts/docker_dev.py" --repo-root "/ignored" '
                  "refresh-frontend-volume --attempt '" + "a" * 32 + "' --config-sha256 '" + "b" * 64
                  + "' --source-root '" + source + "' --port '3203'")
        suffix = (" --frontend-frozen-resume '" + "c" * 32
                  + "' --frontend-frozen-resume-sha256 '" + "d" * 64 + "'")
        for tail in ("", suffix):
            with self.subTest(tail=tail):
                result = self.dispatch(recipe + tail, marker='  *"scripts/docker_dev.py"*)\n')
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = [b'/recorded/python', b'/registered/checkout/scripts/docker_dev.py',
                            b'--repo-root', b'/registered/checkout', b'refresh-frontend-volume',
                            b'--attempt', b'a' * 32, b'--config-sha256', b'b' * 64,
                            b'--source-root', source.encode(), b'--port', b'3203']
                if tail:
                    expected += [b'--frontend-frozen-resume', b'c' * 32,
                                 b'--frontend-frozen-resume-sha256', b'd' * 64]
                self.assertEqual(result.stdout.split(b'\0')[:-1], expected)
        for tail in (" --frontend-frozen-resume '" + "c" * 32 + "'",
                     " --frontend-frozen-resume-sha256 '" + "d" * 64 + "'",
                     suffix + " --unexpected value", suffix + "; printf injected",
                     suffix + " && printf injected", suffix + "\nprintf injected",
                     suffix.replace("c" * 32, "$(printf injected)")):
            with self.subTest(tail=tail):
                result = self.dispatch(recipe + tail, marker='  *"scripts/docker_dev.py"*)\n')
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)

    def test_frontend_completion_closed_prepare_and_apply_dispatch(self):
        marker = '  *"scripts/docker_volume_frontend_refresh_reconcile.py"*)\n'
        script = 'python "/ignored/scripts/docker_volume_frontend_refresh_reconcile.py" '
        source = '/selected/$(printf injected);worktree'
        prepare = (script + "--prepare --attempt '" + 'a'*32 + "' --base-attempt '" + 'b'*32
                   + "' --source-root '" + source + "' --port '3342'")
        request = 'verification/frontend-refresh-completion/' + 'c'*64 + '/request.json'
        apply = script + "--apply --request '" + request + "' --request-sha256 '" + 'd'*64 + "' --source-root '" + source + "'"
        prefix = [b'/recorded/python', b'-B', b'/registered/checkout/scripts/docker_volume_frontend_refresh_reconcile.py']
        for recipe, expected in ((prepare, [b'--prepare', b'--attempt', b'a'*32,
                b'--base-attempt', b'b'*32, b'--source-root', source.encode(), b'--port', b'3342']),
                (apply, [b'--apply', b'--request', request.encode(), b'--request-sha256', b'd'*64,
                         b'--source-root', source.encode()])):
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe, marker=marker)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.split(b'\0')[:-1], prefix + expected)
        for recipe in (prepare + '; printf injected', apply + ' && printf injected',
                       prepare + '\nprintf injected', prepare.replace('a'*32, 'A'*32),
                       apply.replace('d'*64, 'short'), apply.replace(request, '../../request.json'),
                       prepare.replace("'" + source + "'", "'relative/source'"),
                       prepare.replace("'3342'", "'3342' --apply"),
                       apply + ' --request-sha256 ' + 'e'*64):
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe, marker=marker)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)

    def test_frontend_completion_dispatch_precedes_storage_resolver(self):
        source = globals().get('WRAPPER') or (Path(__file__).resolve().parent / 'just_storage_shell.sh').read_text()
        dispatch = source.index('  *"scripts/docker_volume_frontend_refresh_reconcile.py"*)')
        self.assertLess(dispatch, source.rindex('"${resolver}" run'))


    def test_docker_dev_up_real_just_dry_run_dispatches_bounded_network_subnet(self):
        repo = Path(__file__).resolve().parents[1]
        source = '/selected/worktree with spaces/$(printf injected);literal'
        script = 'examples/study script.py'
        dry = subprocess.run(
            ['just', '--justfile', str(repo / 'justfile'), '--dry-run', 'docker-dev',
             source, '3342', script, 'auto', 'fem-demag-poisson', '172.16.1.0/24'],
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(dry.returncode, 0, dry.stderr)
        result = self.dispatch(dry.stderr.strip(), marker='  *"scripts/docker_dev.py"*)\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(b'\0')[:-1], [
            b'/recorded/python', b'/registered/checkout/scripts/docker_dev.py',
            b'--repo-root', b'/registered/checkout', b'up', b'--port', b'3342',
            b'--gpu-access', b'auto', b'--source-root', source.encode(), b'--script', script.encode(),
            b'--native-contract', b'fem-demag-poisson', b'--network-subnet', b'172.16.1.0/24',
        ])

    def test_docker_dev_up_without_network_subnet_keeps_existing_argv(self):
        repo = Path(__file__).resolve().parents[1]
        source = '/selected/worktree with spaces/$(printf injected);literal'
        script = 'examples/study script.py'
        dry = subprocess.run(
            ['just', '--justfile', str(repo / 'justfile'), '--dry-run', 'docker-dev',
             source, '3342', script, 'auto', 'fem-demag-poisson'],
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(dry.returncode, 0, dry.stderr)
        result = self.dispatch(dry.stderr.strip(), marker='  *"scripts/docker_dev.py"*)\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(b'\0')[:-1], [
            b'/recorded/python', b'/registered/checkout/scripts/docker_dev.py',
            b'--repo-root', b'/registered/checkout', b'up', b'--port', b'3342',
            b'--gpu-access', b'auto', b'--source-root', source.encode(), b'--script', script.encode(),
            b'--native-contract', b'fem-demag-poisson',
        ])

    def test_docker_dev_up_rejects_malformed_or_injected_network_subnet(self):
        repo = Path(__file__).resolve().parents[1]
        source = '/selected/worktree with spaces/$(printf injected);literal'
        for subnet in ('172.16.bad.0/24', '172.16.1.0/24; printf injected',
                       "172.16.1.0/24' --apply"):
            with self.subTest(subnet=subnet):
                dry = subprocess.run(
                    ['just', '--justfile', str(repo / 'justfile'), '--dry-run', 'docker-dev',
                     source, '3342', '', 'auto', 'fem-demag-poisson', subnet],
                    capture_output=True, text=True, timeout=15,
                )
                self.assertEqual(dry.returncode, 0, dry.stderr)
                result = self.dispatch(dry.stderr.strip(), marker='  *"scripts/docker_dev.py"*)\n')
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout)


if __name__ == '__main__':
    unittest.main()
