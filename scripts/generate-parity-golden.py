"""Generate test-data/parity.json, the golden windows of the parity test.

Opens test-data/sample.zarr and every valid bundle in test-data/conformance/
with the published `timeseries-zarr` reader, runs a fixed list of
windows through it, and records what the Python reader returns. The window
list is deterministic. Random windows come from numpy's default_rng with a
fixed seed per channel and level.

Each case records `first`, `len`, `period_us`, `time_us0` (the first time of
the Python time axis), and `spec_start_us`, which is the start time in the
evaluation order of the spec: `offset_us + ((s * first) * 1e6) / rate_hz` for a
grid entry that folds `s` samples. On a grid without runs the two agree, and
the script prints each difference it finds.

A window of more than ROW_LIMIT entries records its first and last ROW_LIMIT / 2
rows under `rows` and `tail`. Missing values (NaN) are null.

Usage: python scripts/generate-parity-golden.py [out]
       (in an environment that has installed scripts/requirements.txt;
       out defaults to test-data/parity.json)
"""

import json
import math
import sys
import warnings
from collections.abc import Sequence
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
import timeseries_zarr

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "test-data"
SEED = 20261104
ROW_LIMIT = 256
RANDOM_WINDOWS = 20
RANDOM_MAX_ENTRIES = 64
SPAN_GAPS = (0, 1_000, 100_000, 10_000_000)

Case = dict[str, Any]
Window = tuple[str, int, int]


def number(value: float) -> float | None:
    """Return value as a float, or None for NaN."""
    value = float(value)
    return None if math.isnan(value) else value


def floats(values: Any) -> list[float | None]:
    """Return a numeric array as a list with None for NaN."""
    return [number(value) for value in np.asarray(values, dtype=np.float64)]


def pack(columns: dict[str, list[Any]], size: int) -> Case:
    """Return the `rows` and `tail` fields for columns of size entries."""
    if size <= ROW_LIMIT:
        return {"rows": columns}
    half = ROW_LIMIT // 2
    return {
        "rows": {name: values[:half] for name, values in columns.items()},
        "tail": {name: values[-half:] for name, values in columns.items()},
    }


def spec_start(offset_us: int, width: int, first: int, rate_hz: float) -> float:
    """Return the start of entry first in the evaluation order of the spec."""
    return offset_us + ((width * first) * 1e6) / rate_hz


def sign(delta: int) -> str:
    """Return delta as a label suffix."""
    return "" if delta == 0 else f"{delta:+d}"


def edge_picks(offset: int, period: Fraction, length: int) -> list[int]:
    """Return the entries whose start the edge windows sit on.

    The first is near the middle. The second, when one exists, is the next
    entry whose start is a whole number of microseconds. Up to two more are
    entries with a whole-microsecond start where dividing by the binary64
    period puts the start off the entry.
    """
    if length < 2:
        return []
    middle = length // 2
    picks = [middle]
    for index in range(middle, min(length, middle + 4_000)):
        if (offset + index * period).denominator == 1:
            if index != middle:
                picks.append(index)
            break
    approximate = float(period)
    hard = 0
    for index in range(1, min(length, 20_000)):
        edge = offset + index * period
        if edge.denominator != 1 or index in picks:
            continue
        quotient = (int(edge) - offset) / approximate
        if math.floor(quotient) != index or math.ceil(quotient) != index:
            picks.append(index)
            hard += 1
            if hard == 2:
                break
    return picks


def grid_windows(
    offset: int,
    end_us: int,
    period: Fraction,
    length: int,
    rng: np.random.Generator,
    random_count: int,
) -> list[Window]:
    """Return the named windows for a grid of equal entries."""
    step = math.ceil(period)
    windows: list[Window] = [("whole", offset, end_us)]
    far = 1_000_000
    windows += [
        ("off_both", offset - far, end_us + far),
        ("off_start", offset - far, offset + 5 * step),
        ("off_end", end_us - 5 * step, end_us + far),
        ("before", offset - far, offset),
        ("after", end_us, end_us + far),
    ]
    if length == 0:
        return windows
    windows.append(("first_bin", offset, offset + step))
    last = math.floor(offset + (length - 1) * period)
    windows.append(("last_bin", last, end_us))
    pad = 3 * step
    for index in edge_picks(offset, period, length):
        exact = offset + index * period
        edge = int(exact) if exact.denominator == 1 else round(exact)
        for delta in (-1, 0, 1):
            windows.append(
                (f"edge{index}_start{sign(delta)}", edge + delta, edge + pad)
            )
            windows.append(
                (f"edge{index}_end{sign(delta)}", edge - pad, edge + delta)
            )
    span = max(end_us - offset, 1)
    for draw in range(random_count):
        entries = math.exp(
            rng.uniform(math.log(0.5), math.log(RANDOM_MAX_ENTRIES))
        )
        width = max(1, min(span, int(entries * float(period))))
        start = offset + int(rng.integers(-width // 2, span - width // 2 + 1))
        windows.append((f"random{draw}", start, start + width))
    return windows


def run_windows(table: Sequence[Sequence[int]], rate_hz: float) -> list[Window]:
    """Return windows inside and across each pause of a runs table."""
    step = math.ceil(1e6 / rate_hz)
    windows: list[Window] = []
    for row in range(len(table) - 1):
        count, time = (int(value) for value in table[row][1:])
        resume = int(table[row + 1][2])
        ends = time + count * 1e6 / rate_hz
        gap = resume - ends
        tag = f"pause{row}"
        if gap > 4:
            windows.append(
                (
                    f"{tag}_inside",
                    math.ceil(ends + gap * 0.25),
                    math.floor(resume - gap * 0.25),
                )
            )
        windows += [
            (f"{tag}_across", math.floor(ends) - 5 * step, resume + 5 * step),
            (f"{tag}_bounds", math.ceil(ends), math.ceil(resume)),
            (
                f"{tag}_runs",
                time + count // 2 * step,
                resume + int(table[row + 1][1]) // 2 * step,
            ),
        ]
    return windows


def continuous_case(
    channel: Any, level: int, window: Window, differences: list[str]
) -> Case:
    """Read one window of a continuous channel and record the result."""
    label, start, end = window
    result = channel.read(start, end, level=level)
    size = len(result)
    first = result.first
    if level == 0:
        width = 1
        members = {"values": floats(result.values)}
        period_us = channel.period_us
        if channel.runs is not None:
            members = {"time_us": floats(result.time_us)} | members
    else:
        chosen = channel.levels[level]
        width = chosen.samples_per_bin
        period_us = chosen.period_us
        members = {"min": floats(result.min), "max": floats(result.max)}
        for name in ("mean", "var"):
            values = getattr(result, name)
            if values is not None:
                members[name] = floats(values)
        if result.count is not None:
            members["count"] = [int(value) for value in result.count]
    expected = spec_start(channel.offset_us, width, first, channel.rate_hz)
    axis = result.time_us
    time_us0 = number(axis[0]) if size else None
    if size and time_us0 != expected and (level != 0 or channel.runs is None):
        differences.append(
            f"channel {channel.index} level {level} {label}: spec "
            f"{expected!r}, python {time_us0!r}"
        )
    return {
        "id": f"L{level}/{label}",
        "level": level,
        "label": label,
        "start_us": start,
        "end_us": end,
        "first": first,
        "len": size,
        "period_us": period_us,
        "time_us0": time_us0,
        "spec_start_us": expected,
    } | pack(members, size)


def span_cases(channel: Any, windows: Sequence[Window]) -> list[Case]:
    """Return the data spans of a channel for each window and gap."""
    cases = []
    for label, start, end in windows:
        for gap in SPAN_GAPS:
            spans = channel.spans(start, end, gap_us=gap)
            cases.append(
                {
                    "id": f"{label}/gap{gap}",
                    "start_us": start,
                    "end_us": end,
                    "gap_us": gap,
                    "spans": [[int(low), int(high)] for low, high in spans],
                }
            )
    return cases


def continuous_entry(
    channel: Any, bundle_number: int, differences: list[str]
) -> Case:
    """Return the golden entry for one continuous channel."""
    table = channel.runs
    rows = None if table is None else table.tolist()
    offset = channel.offset_us
    end_us = channel.end_us
    levels = [
        {
            "level": number_,
            "samples_per_bin": chosen.samples_per_bin,
            "period_us": chosen.period_us,
            "bins": chosen.bins,
        }
        for number_, chosen in channel.levels.items()
    ]
    grids = [(0, Fraction(1_000_000) / Fraction(channel.rate_hz))]
    grids += [
        (
            number_,
            chosen.samples_per_bin
            * Fraction(1_000_000)
            / Fraction(channel.rate_hz),
        )
        for number_, chosen in channel.levels.items()
    ]
    cases: list[Case] = []
    for number_, period in grids:
        length = (
            channel.num_samples
            if number_ == 0
            else channel.levels[number_].bins
        )
        rng = np.random.default_rng(
            [SEED, bundle_number, channel.index, number_]
        )
        windows = grid_windows(
            offset,
            end_us,
            period,
            length,
            rng,
            RANDOM_WINDOWS if length else 0,
        )
        if rows is not None:
            windows += run_windows(rows, channel.rate_hz)
        for window in windows:
            cases.append(continuous_case(channel, number_, window, differences))
    spans = [("whole", offset, end_us)]
    if end_us > offset:
        quarter = (end_us - offset) // 4
        spans.append(("middle", offset + quarter, end_us - quarter))
        spans.append(("off_both", offset - 1_000_000, end_us + 1_000_000))
    if rows is not None:
        spans += run_windows(rows, channel.rate_hz)[:3]
    return {
        "index": channel.index,
        "id": channel.id if channel.id is not None else str(channel.index),
        "kind": "continuous",
        "rate_hz": channel.rate_hz,
        "offset_us": offset,
        "num_samples": channel.num_samples,
        "end_us": end_us,
        "runs": rows,
        "levels": levels,
        "cases": cases,
        "spans": span_cases(channel, spans),
    }


def event_columns(table: Any) -> dict[str, list[Any]]:
    """Return the columns of an event table as lists."""
    columns: dict[str, list[Any]] = {
        "time_us": [int(value) for value in table.time_us]
    }
    if table.duration_us is not None:
        columns["duration_us"] = [int(value) for value in table.duration_us]
    if table.label is not None:
        columns["label"] = [int(value) for value in table.label]
    if table.value is not None:
        columns["value"] = floats(table.value)
    if table.text is not None:
        columns["text"] = list(table.text)
    if table.channel_indices is not None:
        columns["channel_indices"] = [
            [int(index) for index in indices]
            for indices in table.channel_indices
        ]
    return columns


def event_windows(channel: Any) -> list[Window]:
    """Return windows around the intervals and points of an event channel."""
    table = channel.read()
    times = [int(value) for value in table.time_us]
    if not times:
        return [("whole", 0, 1_000), ("empty", 0, 0), ("far", 0, 1_000_000)]
    durations = (
        [0] * len(times)
        if table.duration_us is None
        else [int(value) for value in table.duration_us]
    )
    ends = [
        time + duration for time, duration in zip(times, durations, strict=True)
    ]
    windows: list[Window] = [
        ("whole", min(times) - 1, max(ends) + 1),
        ("before_all", times[0] - 1_000, times[0]),
        ("after_all", max(ends) + 1, max(ends) + 1_000),
    ]
    spread = sorted({0, len(times) // 2, len(times) - 1})
    long = [index for index, duration in enumerate(durations) if duration > 0]
    picks = sorted(set(spread) | set(long[:1] + long[-1:]))
    for index in picks:
        time, end = times[index], ends[index]
        for delta in (-1, 0, 1):
            tag = f"event{index}"
            windows.append(
                (f"{tag}_after_end{sign(delta)}", end + delta, end + 1_000)
            )
            windows.append(
                (f"{tag}_before_start{sign(delta)}", time - 1_000, time + delta)
            )
    if long:
        widest = max(long, key=lambda index: durations[index])
        inside = times[widest] + durations[widest] // 2
        windows.append(("inside_interval", inside, inside + 1_000))
        limit = channel.max_duration_us
        if limit is not None:
            for delta in (-1, 0, 1):
                start = times[widest] + limit + delta
                windows.append(
                    (f"lookback_edge{sign(delta)}", start, start + 1_000)
                )
    running = ends[0]
    for index in range(1, len(times)):
        if times[index] > running + 2:
            windows.append(("gap", running + 1, times[index] - 1))
            break
        running = max(running, ends[index])
    return windows


def event_case(channel: Any, window: Window) -> Case:
    """Read one window of an event channel and record the result."""
    label, start, end = window
    table = channel.read(start, end)
    size = len(table)
    return {
        "id": f"events/{label}",
        "label": label,
        "start_us": start,
        "end_us": end,
        "len": size,
    } | pack(event_columns(table), size)


def count_case(channel: Any, level: int, window: Window) -> Case:
    """Read one window of a count level and record the result."""
    label, start, end = window
    result = channel.read_counts(start, end, level=level)
    size = len(result)
    columns = {"count": [[int(value) for value in row] for row in result.count]}
    chosen = channel.count_levels[level]
    return {
        "id": f"C{level}/{label}",
        "level": level,
        "label": label,
        "start_us": start,
        "end_us": end,
        "first": result.first,
        "len": size,
        "period_us": chosen.period_us,
        "time_us0": number(result.time_us[0]) if size else None,
        "spec_start_us": chosen.offset_us + result.first * chosen.period_us,
    } | pack(columns, size)


def event_entry(channel: Any, bundle_number: int) -> Case:
    """Return the golden entry for one event channel."""
    count_levels = []
    cases = [event_case(channel, window) for window in event_windows(channel)]
    for number_, chosen in channel.count_levels.items():
        count_levels.append(
            {
                "level": number_,
                "period_us": chosen.period_us,
                "offset_us": chosen.offset_us,
                "bins": chosen.bins,
                "num_labels": chosen.num_labels,
            }
        )
        rng = np.random.default_rng(
            [SEED, bundle_number, channel.index, 1_000 + number_]
        )
        end_us = chosen.offset_us + chosen.bins * chosen.period_us
        windows = grid_windows(
            chosen.offset_us,
            end_us,
            Fraction(chosen.period_us),
            chosen.bins,
            rng,
            RANDOM_WINDOWS // 2 if chosen.bins else 0,
        )
        cases += [count_case(channel, number_, window) for window in windows]
    return {
        "index": channel.index,
        "id": channel.id if channel.id is not None else str(channel.index),
        "kind": "event",
        "columns": list(channel.columns),
        "num_events": channel.num_events,
        "num_labels": channel.num_labels(),
        "count_levels": count_levels,
        "cases": cases,
    }


def bundle_entry(
    path: Path, bundle_number: int, differences: list[str]
) -> Case:
    """Return the golden entry for one bundle."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        bundle = timeseries_zarr.open_bundle(str(path))
    channels: list[Case] = []
    for index in sorted([*bundle.continuous, *bundle.events]):
        if index in bundle.continuous:
            channels.append(
                continuous_entry(
                    bundle.continuous[index], bundle_number, differences
                )
            )
        else:
            channels.append(event_entry(bundle.events[index], bundle_number))
    return {"path": str(path.relative_to(DATA)), "channels": channels}


def valid_bundles() -> list[tuple[str, Path]]:
    """Return the bundles to record, sample.zarr first, then the fixtures."""
    bundles = [("sample", DATA / "sample.zarr")]
    fixtures = sorted(
        (DATA / "conformance").iterdir(), key=lambda path: path.name
    )
    for path in fixtures:
        if path.name != "invalid" and (path / "zarr.json").is_file():
            bundles.append((path.name, path))
    return bundles


def main() -> int:
    """Write the golden file and report the differences it found.

    Returns:
        The exit status.
    """
    args = sys.argv[1:]
    out = Path(args[0]) if args else DATA / "parity.json"
    differences: list[str] = []
    bundles = {
        name: bundle_entry(path, number_, differences)
        for number_, (name, path) in enumerate(valid_bundles())
    }
    text = json.dumps(
        {"seed": SEED, "row_limit": ROW_LIMIT, "bundles": bundles},
        separators=(",", ":"),
        allow_nan=False,
    )
    out.write_text(text + "\n", encoding="ascii")
    cases = sum(
        len(channel["cases"])
        for bundle in bundles.values()
        for channel in bundle["channels"]
    )
    print(f"wrote {out}: {cases} cases, {len(text)} bytes", file=sys.stderr)
    print(
        f"{len(differences)} windows where the python time axis differs from "
        "the spec start",
        file=sys.stderr,
    )
    for line in differences[:20]:
        print(f"  {line}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
