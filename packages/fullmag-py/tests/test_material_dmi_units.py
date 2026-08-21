from __future__ import annotations

import unittest
import warnings

import fullmag as fm


class MaterialDmiUnitTests(unittest.TestCase):
    def test_bulk_dmi_warning_uses_joules_per_square_metre(self) -> None:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            fm.Material(
                name="bulk_dmi_warning_fixture",
                Ms=8.0e5,
                A=13.0e-12,
                alpha=0.02,
                Dbulk=0.2,
            )

        messages = [
            str(item.message)
            for item in caught
            if "Dbulk=" in str(item.message)
        ]
        self.assertEqual(len(messages), 1)
        self.assertIn("(J/m^2)", messages[0])
        self.assertNotIn("J/m^3", messages[0])


if __name__ == "__main__":
    unittest.main()
