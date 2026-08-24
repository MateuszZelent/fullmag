from datetime import timezone
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
EXTENSIONS = ROOT / "public_docs/site/_extensions"
sys.path.insert(0, str(EXTENSIONS))

import documentation_changelog
import page_last_modified


class PublicDocumentationTimezoneFallbackTests(unittest.TestCase):
    def test_changelog_falls_back_without_a_timezone_database(self) -> None:
        documentation_changelog._timezone.cache_clear()
        with (
            patch.object(
                documentation_changelog,
                "ZoneInfo",
                side_effect=documentation_changelog.ZoneInfoNotFoundError("missing"),
            ),
            patch.object(documentation_changelog.LOGGER, "warning") as warning,
        ):
            resolved = documentation_changelog._timezone("Europe/Warsaw")

        self.assertIs(resolved, timezone.utc)
        warning.assert_not_called()

    def test_page_metadata_falls_back_without_a_timezone_database(self) -> None:
        page_last_modified._configured_timezone.cache_clear()
        with (
            patch.object(
                page_last_modified,
                "ZoneInfo",
                side_effect=page_last_modified.ZoneInfoNotFoundError("missing"),
            ),
            patch.object(page_last_modified.LOGGER, "warning") as warning,
        ):
            resolved = page_last_modified._configured_timezone("Europe/Warsaw")

        self.assertIs(resolved, timezone.utc)
        warning.assert_not_called()


if __name__ == "__main__":
    unittest.main()
