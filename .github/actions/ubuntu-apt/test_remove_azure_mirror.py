import unittest

from remove_azure_mirror import transform_mirror_list


AZURE = b"http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n"
ARCHIVE = b"https://archive.ubuntu.com/ubuntu/\tpriority:2\n"
SECURITY = b"https://security.ubuntu.com/ubuntu/\tpriority:3\n"


class MirrorListTests(unittest.TestCase):
    def test_runner_mirror_list_removes_azure_and_preserves_https_fallbacks(self):
        original = AZURE + ARCHIVE + SECURITY

        updated = transform_mirror_list(original)

        self.assertEqual(updated, ARCHIVE + SECURITY)
        self.assertEqual(updated.splitlines(keepends=True), [ARCHIVE, SECURITY])

    def test_preserves_foreign_lines_and_nonmatching_azure_entries(self):
        before = (
            b"# runner mirror list\n"
            b"https://mirror.example.test/ubuntu/\tpriority:4\n"
            b"http://azure.archive.ubuntu.com/ubuntu/\tpriority:10\n"
            + AZURE
            + ARCHIVE
            + SECURITY
        )

        self.assertEqual(
            transform_mirror_list(before),
            before.replace(AZURE, b"", 1),
        )

    def test_list_without_azure_line_is_unchanged(self):
        original = ARCHIVE + SECURITY

        self.assertEqual(transform_mirror_list(original), original)

    def test_transform_is_idempotent(self):
        original = AZURE + ARCHIVE + SECURITY

        once = transform_mirror_list(original)

        self.assertEqual(transform_mirror_list(once), once)

    def test_missing_canonical_fallback_is_rejected(self):
        for name, original in (
            ("archive", AZURE + SECURITY),
            ("security", AZURE + ARCHIVE),
        ):
            with self.subTest(fallback=name):
                with self.assertRaisesRegex(ValueError, name):
                    transform_mirror_list(original)


if __name__ == "__main__":
    unittest.main()
