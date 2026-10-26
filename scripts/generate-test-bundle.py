"""Generate test-data/sample.zarr, the committed acceptance-test bundle.

Runs the writer from a timeseries-zarr-py checkout, so the fixture has the full
production layout: TS-Zarr 1.0 attributes under `tsz`, ZEP2 sharding, Zstd compression,
crc32c shard indices, consolidated metadata, and a recording.json. The content is
deterministic; the acceptance tests in src/client.test.ts and src/stores/parity.test.ts
state exact expectations against it.

The bundle's origin is the session start, 2024-01-01T00:00:00Z. Every channel time
below is relative to it.

- "sineA" (key 0): 50 * sin(2 pi * 5 Hz * t) at 1 kHz, 30_000 samples from 0.
- "sineB" (key 1): 30 * sin(2 pi * 8 Hz * t) at 1 kHz, 30_000 samples from 2 s, so
                   its offset_us is 2_000_000 and it is montage-able with sineA.
- "noise" (key 2): seeded white noise at 1 kHz from 0 (incompressible, for the
                   bandwidth test).
- "unitA" (key 3): 70_000 spikes at (i + 1) * 137_000 us, labels i % 3 named
                   "u0".."u2", a 32-point mean waveform per label (row j is
                   j, j + 1, ..., j + 31) at 30 kHz. Dense enough for count levels.
- "marks" (key 4): 6 clinical marks with durations, labels, text, and channels:
                   a 90 s seizure from 10 s scoped to sineA, four point spikes
                   scoped to sineA, sineB, or both, and one whole-recording note.

min_bins is lowered to 256 so a 30 k-sample channel produces three pyramid levels
(periods 4, 16 and 64 ms; a fourth would hold fewer than 256 bins), and inner_len to
8192 so the raw array spans several inner chunks within one shard. Each minmax level
fits in one inner chunk. The "noise" channel depends on numpy's seeded RNG;
everything else is exact arithmetic.

Usage: <timeseries-zarr-py venv python> scripts/generate-test-bundle.py
       (set TIMESERIES_ZARR_PY to the writer checkout; defaults to ../timeseries-zarr-py)
"""

import os
import shutil
import sys
import warnings
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

sys.path.insert(
    0,
    os.environ.get(
        "TIMESERIES_ZARR_PY",
        str(Path(__file__).resolve().parents[2] / "timeseries-zarr-py"),
    ),
)

from timeseries_zarr.bundle import write_bundle  # noqa: E402
from timeseries_zarr.types import RecordingMeta, WriteOpts  # noqa: E402

SESSION_START = datetime(2024, 1, 1, tzinfo=UTC)
START_US = 1_704_067_200_000_000  # SESSION_START in microseconds since the epoch
RATE_HZ = 1000.0
N_SAMPLES = 30_000
N_SPIKES = 70_000
SPIKE_STEP_US = 137_000
POINTS = 32
WAVEFORM_RATE_HZ = 30_000.0


class SineSource:
    unit = "uV"

    def __init__(self, id: str, name: str, freq_hz: float, amplitude: float, start_us: int):
        self.id = id
        self.name = name
        self._freq_hz = freq_hz
        self._amplitude = amplitude
        self._start_us = start_us

    def rate_hz(self) -> float:
        return RATE_HZ

    def start_us(self) -> int:
        return self._start_us

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
    """A dense sorted-units channel: labels and a mean waveform per label."""

    id = "unitA"
    name = "Unit A"
    unit = None

    def provenance(self):
        return {"software": "generate-test-bundle.py"}

    def num_events(self) -> int:
        return N_SPIKES

    def columns(self):
        return frozenset({"labels", "waveform_mean"})

    def label_names(self):
        return ["u0", "u1", "u2"]

    def num_labels(self) -> int:
        return 3

    def max_duration_us(self):
        return None

    def text_width(self) -> int:
        return 0

    def read_events(self, start: int, stop: int):
        i = np.arange(start, stop, dtype=np.int64)
        return START_US + (i + 1) * SPIKE_STEP_US

    def read_durations(self, start: int, stop: int):
        raise NotImplementedError

    def read_labels(self, start: int, stop: int):
        return (np.arange(start, stop) % 3).astype(np.uint16)

    def read_text(self, start: int, stop: int):
        raise NotImplementedError

    def read_channel_ids(self, start: int, stop: int):
        raise NotImplementedError

    def waveform_mean(self):
        rows = np.arange(3, dtype=np.float32)[:, None]
        cols = np.arange(POINTS, dtype=np.float32)[None, :]
        return rows + cols

    def waveform_period_us(self) -> float:
        return 1e6 / WAVEFORM_RATE_HZ


# (time from origin in us, duration us, label, text, channel ids)
MARKS = [
    (10_000_000, 90_000_000, 0, "seizure", ["sineA"]),
    (12_000_000, 0, 1, "spike", ["sineA"]),
    (15_500_000, 0, 1, "spike", ["sineB"]),
    (20_000_000, 0, 2, "note: reviewed", []),
    (25_000_000, 0, 1, "spike", ["sineA", "sineB"]),
    (29_000_000, 0, 1, "spike", ["sineB"]),
]


class MarkSource:
    """A clinical-marks channel: durations, labels, text, and channel scope."""

    id = "marks"
    name = "Marks"
    unit = None

    def num_events(self) -> int:
        return len(MARKS)

    def columns(self):
        return frozenset({"durations", "labels", "text", "channels"})

    def label_names(self):
        return ["seizure", "spike", "note"]

    def num_labels(self) -> int:
        return 3

    def max_duration_us(self) -> int:
        return 90_000_000

    def text_width(self) -> int:
        return max(len(mark[3].encode("utf-8")) for mark in MARKS)

    def read_events(self, start: int, stop: int):
        return np.array([START_US + mark[0] for mark in MARKS[start:stop]], dtype=np.int64)

    def read_durations(self, start: int, stop: int):
        return np.array([mark[1] for mark in MARKS[start:stop]], dtype=np.int64)

    def read_labels(self, start: int, stop: int):
        return np.array([mark[2] for mark in MARKS[start:stop]], dtype=np.uint16)

    def read_text(self, start: int, stop: int):
        return [mark[3] for mark in MARKS[start:stop]]

    def read_channel_ids(self, start: int, stop: int):
        return [list(mark[4]) for mark in MARKS[start:stop]]

    def waveform_mean(self):
        raise NotImplementedError

    def waveform_period_us(self):
        raise NotImplementedError


def main() -> None:
    final = Path(__file__).resolve().parents[1] / "test-data" / "sample.zarr"
    if final.exists():
        shutil.rmtree(final)

    # zarr-python warns that consolidated metadata is not yet in the v3 core spec.
    # TS-Zarr requires it anyway.
    warnings.filterwarnings("ignore", message="Consolidated metadata is currently not part")

    write_bundle(
        [
            SineSource("sineA", "Sine A", 5.0, 50.0, START_US),
            SineSource("sineB", "Sine B", 8.0, 30.0, START_US + 2_000_000),
            NoiseSource(),
        ],
        [SpikeSource(), MarkSource()],
        output_path=final,
        opts=WriteOpts(min_bins=256, inner_len=8192),
        recording=RecordingMeta(
            session_start_time=SESSION_START,
            subject={"id": "sub-synth"},
            session={"id": "ses-01", "description": "reader acceptance fixture"},
            source={"generator": "scripts/generate-test-bundle.py"},
        ),
    )
    print(f"wrote {final}")


if __name__ == "__main__":
    main()
