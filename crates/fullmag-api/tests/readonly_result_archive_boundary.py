"""Source-level read-authority boundary checks; not a Rust compilation substitute."""
import ast
import hashlib
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[3]
API = ROOT / "crates/fullmag-api/src"


class ArchiveBoundary(unittest.TestCase):
    def test_no_writer_or_execution_authority(self):
        source = (API / "readonly_result_archive.rs").read_text().split("#[cfg(test)]")[0]
        for forbidden in ("SessionStore::open(", ".write(true)", ".create(true)",
                          "fs::write(", "spawn_worker", "submit_run", "store_binding ="):
            self.assertNotIn(forbidden, source)
        self.assertIn("SessionStore::open_existing(root)?", source)
        self.assertIn("let _read = store.read_transaction()?", source)
        self.assertLess(source.index("let _read = store.read_transaction()?"),
                        source.index('check_pin(&root.join("WRITER.lock")'))

    def test_fifth_run_keeps_closed_manifest_and_raw_pin_gate(self):
        source = (API / "readonly_result_archive.rs").read_text().split("#[cfg(test)]")[0]
        bounds = re.findall(r"manifest\.runs\.len\(\) > (\d+)", source)
        self.assertEqual(bounds, ["5"])
        self.assertIn("manifest.runs.is_empty()", source)
        self.assertIn("sha(raw) != hash", source)
        self.assertIn("!ids.insert(&pin.run_id)", source)
        self.assertIn("#[serde(deny_unknown_fields)]", source)
        # The parent is authorized by the externally pinned manifest, not a resolver fallback.
        self.assertNotIn("run-live-3926", source)

    def test_existing_writer_bytes_are_preserved(self):
        def descriptor(path, name):
            text = path.read_text()
            literal = re.search(r"const " + name + r':[^=]+= (b".*?");', text).group(1)
            return ast.literal_eval(literal)
        native = descriptor(ROOT / "crates/fullmag-session/src/writer.rs", "LOCK_DESCRIPTOR")
        api = descriptor(API / "readonly_result_archive.rs", "LOCK_BYTES")
        self.assertEqual(native, api)
        self.assertEqual(len(api), 23)
        self.assertEqual(hashlib.sha256(api).hexdigest(),
                         "d7d50b726f28b296ff50d1e079f038a303f0763dd31417b6ea53b8bba0a15af9")

    def test_only_approved_handlers_reference_archive(self):
        uses = []
        for path in (API / "router_v2/handlers").rglob("*.rs"):
            text = path.read_text()
            for match in re.finditer(r"crate::readonly_result_archive::", text):
                prefix = text[:match.start()]
                owner = re.findall(r"(?:pub )?async fn (\w+)", prefix)[-1]
                uses.append(owner)
        self.assertEqual(set(uses), {"get_run", "list_runs", "with_verified_run_value"})
        self.assertEqual(uses.count("get_run"), 1)
        self.assertEqual(uses.count("with_verified_run_value"), 1)


if __name__ == "__main__":
    unittest.main()
