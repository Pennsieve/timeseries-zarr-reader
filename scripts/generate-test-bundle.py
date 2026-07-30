"""Generate test-data/sample.zarr, the committed acceptance-test bundle.

Runs the real writer from a ts-zarr-py checkout. The fixture has the full production
layout: ZEP2 sharding, Zstd compression, crc32c shard indices, and consolidated
metadata. The content is deterministic; the acceptance tests in src/index.test.ts and
src/stores/parity.test.ts state exact expectations against it:

- "sineA":  50 * sin(2 pi * 5 Hz * t)  at 1 kHz, 30_000 samples
- "sineB":  30 * sin(2 pi * 8 Hz * t)  at 1 kHz, same grid (montage-able with sineA)
- "noise":  seeded white noise at 1 kHz (incompressible, for the bandwidth test)
- "unitA":  200 events at start + (i + 1) * 137_000 us; 32-point ramp waveforms
            (row i is i, i+1, ..., i+31) sampled at 30 kHz

min_bins is lowered to 256 so a 30 k-sample channel produces four pyramid levels
(periods 1, 4, 16, 64 ms), and inner_len to 8192 so a level spans several inner
chunks within one shard. The "noise" channel depends on numpy's seeded RNG;
everything else is exact arithmetic.

Usage: <ts-zarr-py venv python> scripts/generate-test-bundle.py
       (set TS_ZARR_PY to the writer checkout; defaults to ../ts-zarr-py)
"""

import os
import shutil
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, os.environ.get("TS_ZARR_PY", str(Path(__file__).resolve().parents[2] / "ts-zarr-py")))

from ts_zarr.bundle import write_bundle
from ts_zarr.types import WriteOpts

START_US = 1_704_067_200_000_000
RATE_HZ = 1000.0
N_SAMPLES = 30_000
N_EVENTS = 200
POINTS = 32
WAVEFORM_RATE_HZ = 30_000.0


class SineSource:
    unit = "uV"

    def __init__(self, id: str, name: str, freq_hz: float, amplitude: float):
        self.id = id
        self.name = name
        self._freq_hz = freq_hz
        self._amplitude = amplitude

    def rate_hz(self) -> float:
        return RATE_HZ

    def start_us(self) -> int:
        return START_US

    def num_samples(self) -> int:
        return N_SAMPLES

    def read_samples(self, start: int, stop: int):
        i = np.arange(start, stop, dtype=np.float64)
        return (
            self._amplitude * np.sin(2.0 * np.pi * self._freq_hz * i / RATE_HZ)
        ).astype(np.float32)


class NoiseSource:
    id = "noise"
    name = "Noise"
    unit = "uV"

    def __init__(self):
        # One draw up front: per-window draws would depend on read order.
        self._samples = (
            np.random.default_rng(42).standard_normal(N_SAMPLES).astype(np.float32)
        )

    def rate_hz(self) -> float:
        return RATE_HZ

    def start_us(self) -> int:
        return START_US

    def num_samples(self) -> int:
        return N_SAMPLES

    def read_samples(self, start: int, stop: int):
        return self._samples[start:stop]


class SpikeSource:
    id = "unitA"
    name = "Unit A"
    unit = "uV"

    def rate_hz(self) -> float:
        return WAVEFORM_RATE_HZ

    def start_us(self) -> int:
        return START_US

    def num_events(self) -> int:
        return N_EVENTS

    def points_per_event(self) -> int:
        return POINTS

    def read_events(self, start: int, stop: int):
        i = np.arange(start, stop, dtype=np.int64)
        return START_US + (i + 1) * 137_000

    def read_units(self, start: int, stop: int):
        return (np.arange(start, stop) % 3).astype(np.uint8)

    def read_waveforms(self, start: int, stop: int):
        rows = np.arange(start, stop, dtype=np.float32)[:, None]
        cols = np.arange(POINTS, dtype=np.float32)[None, :]
        return rows + cols


def main() -> None:
    out = Path(__file__).resolve().parents[1] / "test-data"
    staging = out / ".staging-sample.zarr"
    final = out / "sample.zarr"
    for path in (staging, final):
        if path.exists():
            shutil.rmtree(path)

    write_bundle(
        [
            SineSource("sineA", "Sine A", 5.0, 50.0),
            SineSource("sineB", "Sine B", 8.0, 30.0),
            NoiseSource(),
        ],
        [SpikeSource()],
        staging_dir=staging,
        final_dir=final,
        opts=WriteOpts(min_bins=256, inner_len=8192),
    )
    print(f"wrote {final}")


if __name__ == "__main__":
    main()
