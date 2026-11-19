import unittest
import fullmag as fm


class MagnetMaterialAttributeContractTests(unittest.TestCase):
    def setUp(self):
        fm.reset()
        self.body = fm.geometry(fm.Box(size=(100e-9, 20e-9, 10e-9)), name="body")
        self.body.Ms = 800e3
        self.body.Aex = 13e-12

    def test_unsupported_material_attributes_fail_before_ir_export(self):
        for name in ("Ku2", "Kc2", "anisC1", "Ms_field", "ms", "Aexx"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(AttributeError, name):
                    setattr(self.body, name, 1.0)
                self.assertNotIn(name, self.body.__dict__)

    def test_supported_material_and_texture_properties_remain_mutable(self):
        self.body.alpha = 0.0
        self.body.Ku1 = -1000.0
        self.body.anisU = (0.0, 0.0, 1.0)
        self.body.Kc1 = 2000.0
        self.body.m = (1.0, 0.0, 0.0)
        material = self.body._to_ferromagnet().material
        self.assertEqual(material.alpha, 0.0)
        self.assertEqual(material.Ku1, -1000.0)
        self.assertEqual(material.Kc1, 2000.0)


if __name__ == "__main__":
    unittest.main()
