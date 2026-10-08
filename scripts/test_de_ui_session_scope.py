"""Canonical UI capture scope regression; run in GitHub Actions only."""
import ast
import unittest
import run_de_100nm_pilot as pilot

class SessionScopeTests(unittest.TestCase):
    def test_header_matches_browser_encoding_and_order(self):
        self.assertEqual(pilot._session_scope_header("session&1", "epoch=α", "incarnation%2"),
                         "session=session%261&epoch=epoch%3D%CE%B1&request_scope_epoch=incarnation%252")
        self.assertEqual(pilot._session_scope_header("s!~*'()", "e", "r"),
                         "session=s!~*'()&epoch=e&request_scope_epoch=r")

    def test_all_three_components_are_required(self):
        for values in (("s", "", "r"), ("s", "e", None), (" ", "e", "r")):
            with self.subTest(values=values), self.assertRaises(ValueError):
                pilot._session_scope_header(*values)

    def test_generated_capture_executes_the_same_header_encoder(self):
        tree = ast.parse("\n".join(pilot._ui_archive_shell("demo")[1:-1]))
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_session_scope_header"]
        self.assertEqual(len(functions), 1)
        namespace = {}
        exec(compile(ast.Module(body=functions, type_ignores=[]), "capture", "exec"), namespace)
        self.assertEqual(namespace["_session_scope_header"]("s", "e", "r"), pilot._session_scope_header("s", "e", "r"))
        shell = "\n".join(pilot._ui_archive_shell("demo"))
        self.assertIn("identity(session.get('session_epoch')", shell)
        self.assertIn("identity(session.get('request_scope_epoch')", shell)
        self.assertNotIn("else 'session_epoch'", shell)

    def test_archive_status_preserves_both_epoch_identities(self):
        status = {"session": {"session_id": "s", "session_epoch": {"value": "e"}, "request_scope_epoch": {"value": "r"}},
                  "domain": {"cell_count": 1}, "resources": {"field_catalog_revision": 1}}
        identity = pilot._status_identity(status)
        self.assertEqual(identity["session_epoch"], "e")
        self.assertEqual(identity["request_scope_epoch"], "r")

if __name__ == "__main__": unittest.main()
