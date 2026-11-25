"""Check Faraday sign and frequency scaling against a real time-domain flux."""
import math
import unittest

from reference_sushruth_2020_voltage_observable import faraday_emf_proxy


class SushruthVoltageObservableTests(unittest.TestCase):
    def test_real_flux_derivative_and_demodulation(self):
        # A centered time-domain derivative is independent of the phasor formula.
        samples = 4096
        inductance = 0.7 - 1.3j
        reference = 7.5e9
        for frequency in (6e9, 7.5e9, 9e9):
            with self.subTest(frequency=frequency):
                period = 1 / frequency
                dt = period / samples
                flux = [inductance.real * math.cos(2*math.pi*j/samples)
                        - inductance.imag * math.sin(2*math.pi*j/samples) for j in range(samples)]
                emf = [-(flux[(j+1) % samples] - flux[(j-1) % samples]) / (2*dt)
                       for j in range(samples)]
                real = 2/samples * sum(e*math.cos(2*math.pi*j/samples) for j,e in enumerate(emf))
                imaginary = -2/samples * sum(e*math.sin(2*math.pi*j/samples) for j,e in enumerate(emf))
                measured = complex(real, imaginary) / (2*math.pi*reference)
                predicted = faraday_emf_proxy(frequency, inductance, reference_frequency_hz=reference)
                self.assertLess(abs(measured-predicted) / abs(predicted), 5e-7)

    def test_dc_and_reference_units(self):
        self.assertEqual(faraday_emf_proxy(0, 2+3j, reference_frequency_hz=7.5e9), 0j)
        self.assertEqual(faraday_emf_proxy(7.5e9, 2+3j, reference_frequency_hz=7.5e9), 3-2j)
        self.assertEqual(faraday_emf_proxy(15e9, 2+3j, reference_frequency_hz=7.5e9), 6-4j)
        self.assertEqual(faraday_emf_proxy(15, 2+3j, reference_frequency_hz=7.5), 6-4j)

    def test_invalid_frequency_reference_and_inductance_refuse(self):
        for bad in (True, -1, math.nan, math.inf, 1j, "6e9"):
            with self.subTest(frequency=bad), self.assertRaises(ValueError):
                faraday_emf_proxy(bad, 1j, reference_frequency_hz=7.5e9)
        for bad in (True, 0, -1, math.nan, math.inf, 1j, "7.5e9"):
            with self.subTest(reference=bad), self.assertRaises(ValueError):
                faraday_emf_proxy(6e9, 1j, reference_frequency_hz=bad)
        for bad in (True, complex(math.nan, 0), complex(0, math.inf), "1j"):
            with self.subTest(inductance=bad), self.assertRaises(ValueError):
                faraday_emf_proxy(6e9, bad, reference_frequency_hz=7.5e9)

    def test_overflow_is_not_a_finite_observable(self):
        with self.assertRaises(ValueError):
            faraday_emf_proxy(1e308, 1e308+1e308j, reference_frequency_hz=1e-308)


if __name__ == "__main__":
    unittest.main()
