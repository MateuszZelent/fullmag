"""Independent raster fixtures; no field integration, fit or solver execution."""
import tempfile
from pathlib import Path
import unittest

import numpy as np

import plot_sushruth_2020_response_reference as plot


def fixture(*, curve=True, gray=True, annotations=True):
    image = np.full((1524, 1015, 3), 255, dtype=np.uint8)
    image[44:370, 588] = 0
    image[44:370, 1003] = 0
    image[44:47, 588:1004] = 0
    image[367:370, 588:1004] = 0
    image[45:51, 726] = 0  # inward top-axis tick, not part of the curve
    image[45:48, 795] = 0
    if gray:
        image[47:367, 745:750] = 190
    if curve:
        image[207, 591:1001] = 0
        image[70:73, 806:809] = 0
        image[340:343, 824:827] = 0
    if annotations:
        image[48:95, 600:640] = 0  # panel-letter distractor above the curve
        image[48:105, 880:990] = 0  # alpha legend above the curve
    image[48:50, 770:773] = (255, 0, 0)  # GS must not become the GSG maximum
    return image


class Figure3PanelERasterTests(unittest.TestCase):
    def test_frame_and_two_legends_do_not_become_curve_extrema(self):
        result = plot.measure_figure3_e_pixels(fixture())
        self.assertEqual(result['axis_pixel_bounds'], [588, 1003])
        points = result['published_GSG_alpha001']
        self.assertAlmostEqual(points['maximum']['frequency_ghz'], 6 + 3 * (807 - 588) / 415)
        self.assertAlmostEqual(points['minimum']['frequency_ghz'], 6 + 3 * (825 - 588) / 415)
        self.assertEqual(points['maximum']['stroke_frequency_span_ghz'],
                         [6 + 3 * (806 - 588) / 415, 6 + 3 * (808 - 588) / 415])
        self.assertEqual(points['minimum']['stroke_frequency_span_ghz'],
                         [6 + 3 * (824 - 588) / 415, 6 + 3 * (826 - 588) / 415])

    def test_removing_only_visible_annotations_preserves_the_measurement(self):
        with_labels = plot.measure_figure3_e_pixels(fixture())
        without_labels = plot.measure_figure3_e_pixels(fixture(annotations=False))
        self.assertEqual(with_labels, without_labels)
        self.assertEqual(with_labels['excluded_annotations'], [
            {'label': 'panel (e)', 'bounds_xyxy': [590, 45, 660, 100]},
            {'label': 'alpha = 0.01', 'bounds_xyxy': [850, 45, 1002, 110]},
        ])

    def test_gray_stroke_is_a_span_in_its_own_panel_axis(self):
        result = plot.measure_figure3_e_pixels(fixture())
        self.assertEqual(result['published_FMR_marker_pixel_span'], [745, 749])
        self.assertEqual(result['published_FMR_marker_frequency_span_ghz'],
                         [6 + 3 * (745 - 588) / 415, 6 + 3 * (749 - 588) / 415])
        self.assertNotIn('published_FMR_marker_ghz', result)

    def test_missing_axes_refuses_even_with_legends(self):
        image = fixture()
        image[44:370, 588:591] = 255
        with self.assertRaisesRegex(ValueError, 'axis'):
            plot.measure_figure3_e_pixels(image)

    def test_frame_and_legends_without_curve_refuse(self):
        with self.assertRaisesRegex(ValueError, 'curve'):
            plot.measure_figure3_e_pixels(fixture(curve=False))

    def test_missing_gray_marker_refuses(self):
        with self.assertRaisesRegex(ValueError, 'gray'):
            plot.measure_figure3_e_pixels(fixture(gray=False))

    def test_two_disjoint_gray_markers_are_ambiguous(self):
        image = fixture()
        image[47:367, 780:784] = 190
        with self.assertRaisesRegex(ValueError, 'gray'):
            plot.measure_figure3_e_pixels(image)

    def test_invalid_raster_shape_or_dtype_refuses(self):
        for image in (np.zeros((100, 100, 3), dtype=np.uint8),
                      fixture().astype(float), [], np.zeros((1524, 1015), dtype=np.uint8)):
            with self.subTest(shape=getattr(image, 'shape', None)), self.assertRaises(ValueError):
                plot.measure_figure3_e_pixels(image)

    def test_unknown_panel_refuses_before_file_access(self):
        for panel in ('b', 'GSG', None):
            with self.subTest(panel=panel), self.assertRaisesRegex(ValueError, 'panel'):
                plot.measure_figure3_anchors('/absent.png', '/absent.json', panel=panel)

    def test_public_wrapper_does_not_accept_unpinned_image(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / 'other.png'
            image.write_bytes(b'unregistered image')
            with self.assertRaisesRegex(ValueError, 'image identity'):
                plot.measure_figure3_anchors(image, '/absent.json', panel='e')


if __name__ == '__main__':
    unittest.main()
