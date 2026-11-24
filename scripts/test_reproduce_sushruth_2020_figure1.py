"""Scientific checks of Figure1 postprocessing; no Fullmag/native solver."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import numpy as np
from PIL import Image, ImageDraw

target=Path(__file__).with_name("reproduce_sushruth_2020_figure1.py")
spec=importlib.util.spec_from_file_location("figure1_reproduction",target)
module=importlib.util.module_from_spec(spec)
try:spec.loader.exec_module(module)
except FileNotFoundError:module=None

class FigureOneTests(unittest.TestCase):
    def test_reproduction_driver_exists(self):
        self.assertIsNotNone(module)

    def test_display_scaling_is_power_and_uses_rad_per_m(self):
        value=module.model_grid(1200)
        self.assertEqual(value["k_rad_per_um"][-1],30.)
        self.assertEqual(value["power"]["S"][0],4.)
        self.assertEqual(value["power"]["GS"][0],0.)
        self.assertAlmostEqual(value["amplitude"]["GS"][600].real,0.)
        self.assertAlmostEqual(value["k_rad_per_m"][600],15e6)

    def test_midpoint_integrals_preserve_signed_currents_and_complex_phase(self):
        k=np.array([0.,7.3e6,-7.3e6])
        actual=module.integrate_strips(k,1024)
        from reference_sushruth_2020_antenna_spectrum import antenna_spectra
        for index,wave in enumerate(k):
            reference=antenna_spectra(float(wave))
            for name in ("S","GS","GSG"):
                self.assertLess(abs(actual[name][index]-reference[name]),5e-6)
                self.assertAlmostEqual(actual[name][1].real,actual[name][2].real)
                self.assertAlmostEqual(actual[name][1].imag,-actual[name][2].imag)
        self.assertEqual(actual["GS"][0],0j)
        self.assertEqual(actual["GSG"][0],0j)

    def test_quadrature_records_real_error_reduction_and_sampling_convergence(self):
        quad=module.quadrature_convergence([256,512,1024])
        self.assertGreater(quad[-1]["previous_error_ratio"],3.9)
        self.assertLess(quad[-1]["previous_error_ratio"],4.1)
        samples=module.sampling_convergence([600,1200,2400,4800])
        for name in ("S","GS","GSG"):
            self.assertLessEqual(abs(samples[-1]["peaks"][name]["k_rad_per_um"]-samples[-2]["peaks"][name]["k_rad_per_um"]),0.02)

    def test_image_selection_uses_geometry_and_discards_unconnected_legend(self):
        image=Image.new("RGB",(180,110),"white")
        draw=ImageDraw.Draw(image)
        for name,color,start in [("S","blue",20),("GS","red",45),("GSG","black",70)]:
            points=[(x,start+int(10*np.sin(x/30))) for x in range(10,170)]
            draw.line(points,fill=color,width=2)
            draw.line([(120,start-15),(165,start-15)],fill=color,width=2)
        curves=module.extract_curves(np.asarray(image),dict(left=0.,right=179.,top=0.,bottom=109.))
        for name in ("S","GS","GSG"):
            self.assertGreater(len(curves[name]["x_pixel"]),130)
            self.assertLess(np.max(curves[name]["vertical_span_pixel"]),3)
            self.assertGreater(np.min(curves[name]["y_pixel"]),10)

    def test_empty_raster_refuses_instead_of_manufacturing_points(self):
        with self.assertRaises(ValueError):
            module.extract_curves(np.full((100,180,3),255,np.uint8),dict(left=0.,right=179.,top=0.,bottom=99.))

    def test_source_hash_mismatch_refuses(self):
        import json
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);png=root/"source.png";Image.new("RGB",(10,10),"white").save(png)
            criteria=root/"criteria.json";criteria.write_text(json.dumps({"page_png_sha256":"0"*64}))
            with self.assertRaisesRegex(ValueError,"SHA"):
                module.load_source(png,criteria)

if __name__=="__main__":unittest.main()
