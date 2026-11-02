"""Check fixed-argv development recovery dispatch without Docker or temporary files."""
from pathlib import Path
import os
import subprocess
import unittest


class DevelopmentRecoveryShellTests(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
