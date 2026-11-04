# API reference

All times are microseconds. Timestamps such as `startUs` and `endUs` count from the
bundle's origin, its time zero, and [`recording()`](#recording) gives the origin's
wall-clock time when the bundle records one. Durations such as `pixelWidthUs` and
`samplePeriodUs` are plain spans. Sample values stay in each channel's physical unit, as
recorded. Time windows are half-open, `[startUs, endUs)`.

The reader implements TS-Zarr 1.x and rejects a bundle of any other major version,
including the unversioned layout written before 1.0. Inside a 1.x bundle it ignores the
attribute keys, arrays, and groups it does not recognize, so a bundle from a later minor
release opens.

## `new StreamingClient(options)`

Takes `{ store, maxRawBytes?, maxCacheBytes?, maxInflightFetches?,
maxConcurrentRequests? }`. `store` is any
object implementing the `Store` type. `maxRawBytes` caps a query's reads of the raw level,
15 MB by default, and each query can override it. The cap applies whether a filter, a
montage, or `raw: true` forced the raw level or the pixel width selected it; min/max
levels are bounded by the pixel width and do not count. `maxCacheBytes` caps the
client's cache of store responses, 64 MiB by default. Zero removes the cache layer;
identical in-flight reads still collapse, same-microtask ranges still merge, and the
bundle root is read twice on open. `maxInflightFetches` caps level reads in
flight, 64 by default. `maxConcurrentRequests` caps the requests those reads turn into
once identical reads have collapsed and adjacent ranges have merged, also 64 by
default. Lower it for a store that throttles.

Constructing a client reads nothing from the store and starts loading the zstd codec
that decompresses chunks. The codec module carries its WebAssembly binary inline, so
loading it early keeps that download off the first read.

The option-bag types are exported: `StreamingClientOptions`, `QueryOptions`,
`EventQueryOptions`, `EventCountOptions`, `WaveformMeanOptions`, and `DataSpanOptions`.

## `channelInfo()`

Returns a `ChannelInfo` array covering every channel in the bundle, in the bundle's
order. `ChannelInfo` is a union discriminated on `kind`:

- `ContinuousChannelInfo` (`kind: "continuous"`): `index`, `id`, `name`, `unit`,
  `rateHz`, `startUs`, `endUs`, `runs`, and an optional `provenance`. `endUs` is
  exclusive, one period past the channel's last sample, rounded up to a whole
  microsecond. A channel with runs ends where its last run does, and
  `channelInfo()` reads its `runs` table for that. `runs` is the number of runs:
  1 for a channel that never paused, 0 for an empty one;
  [`runs()`](#runsoptions) reads them.
- `EventChannelInfo` (`kind: "event"`): `index`, `id`, `name`, `eventCount`, `columns`
  (the optional per-event columns the channel stores, from `durations`, `labels`,
  `values`, `text`, `channels`, and `waveforms`), `hasWaveformMean`, `countLevels` (the
  number of count levels, 0 when none), and optional `unit`, `labelNames`,
  `maxDurationUs`, and `provenance`.

`index` is the channel's integer group name in the bundle, `0` through `C - 1`,
and the bit that names it in an event's `channels` column. `id` is the
producer's id when the bundle records one, and otherwise the index as a string;
it is what every query takes. Ids and indices share one namespace, so a producer
id can match another channel's index.

The format does not require ids to be unique, and the reader opens a bundle
where channels share one. `channelInfo()` lists every such channel. A query that
names a shared id rejects with an error that lists the channel indices, and a
query that names an unknown id rejects too. `timeseries-zarr-py` writes an id on
every channel and refuses duplicates.

## `recording()`

Returns a promise for the bundle's `recording.json` as a `RecordingInfo`, or `undefined`
when the bundle has none. The file is read once and cached for the client's lifetime.

`referenceTime` is the origin's wall-clock time as written, the file's
`reference_time`, an RFC 3339 timestamp, and `referenceTimeUs` the same instant in
microseconds since the Unix epoch. `subject`, `session`, and `source` are the
producer-defined identity objects, passed through as written; `session.start_time`,
when present, is when acquisition began and places no data. Each is absent when the
file omits it. Keys the format does not define are ignored. A bundle de-identified by
deleting `recording.json` resolves to `undefined`; one that keeps the file but strips
its keys resolves to an empty record.

## `query(options)`

Returns an async iterable of `Segment`, one per requested trace, in request
order. A raw read of a channel with runs yields one segment per run instead; see
[Delivery boundaries](#delivery-boundaries).

`startUs`, `endUs`, and `pixelWidthUs` are required. Pass either `channels` or `montage`
to name the traces:

- `channels`: channel ids, one trace each.
- `montage`: `{ lead, secondary }` pairs. Each trace is `lead - secondary`, sample by
  sample. The returned segment's `channel` is the compound key
  `{leadId}_{leadName}<->{secondaryName}`. The pair must share a sample rate, and the
  two sample grids must align: the starts differ by a whole number of samples. The
  read covers the pair's shared extent.

Passing both or neither throws. The rest of the options:

- `filter`: a Butterworth `FilterSpec` (`lowpass`, `highpass`, `bandpass`, or
  `bandstop`) applied to every trace. `order` is an integer from 1 to 12. Frequencies
  must lie strictly between 0 and the channel's Nyquist frequency, and the band forms
  require `lowHz < highHz`. A spec outside those bounds rejects with `RangeError`.
- `raw`: `true` returns raw samples with no decimation or resampling. Defaults to `false`.
- `members`: the per-bin statistics to read beside the envelope, any of
  `"mean"`, `"var"`, and `"count"`. See [Bin statistics](#bin-statistics).
- `maxRawBytes`: byte-cap override for this query.
- `signal`: an `AbortSignal` that cancels in-flight reads.

`query()` rejects event channels. Read those with [`queryEvents()`](#queryeventsoptions).

### Level selection

The reader picks the coarsest pyramid level whose bins fit within one pixel, falling
back to the finest level when none fits. Levels are ordered by their `period_us`; the
factor between consecutive levels is whatever the producer chose, and nothing assumes 4. Segments from a coarse level carry interleaved `[min, max, ...]` envelope pairs
from the level's `minmax` member and set `isMinMax`; segments from the raw level carry
samples. A level's `mean`, `var`, and `count` members are read only when the
query asks for them in `members`.

A level covers a whole number of samples, at least 2, that follows from its `period_us`
and the channel's `rateHz`. Each level is a multiple of at least 2 times the one
before it. The first read of a client rejects a bundle whose levels or member lengths
break these rules, and the error names the level.

A montage, a filter, or `raw: true` forces a read of the raw level. Coarse levels are
already decimated, so they cannot be filtered or differenced exactly.

A segment is resampled onto the pixel grid only when one pixel spans more than 3 source
bins. Below that ratio the segment comes back as fetched, at the level's own resolution, so
read `samplePeriodUs` off the segment rather than assuming it equals `pixelWidthUs`. The
pixel grid is anchored at the channel start (the lead channel's start for a montage), so
every window over a channel resamples onto the same buckets and adjacent windows tile one
bucket apart.

### Bin statistics

`members` names the statistics to read from a level beside its envelope. A
segment carries each as a `Float64Array` with one value per bin:

| Member    | Segment field | Value                                                |
| --------- | ------------- | ---------------------------------------------------- |
| `"count"` | `count`       | Number of finite samples in the bin, a whole number. |
| `"mean"`  | `mean`        | Arithmetic mean of the finite samples.               |
| `"var"`   | `variance`    | Population variance of the finite samples.           |

A bin with no finite sample has a `count` of 0 and NaN in `mean` and
`variance`. A field is present only when the query asked for it and the level
stores it. `count` is a `Float64Array` so that sums over many bins stay exact.

A segment that was resampled onto pixels carries the statistics of each pixel.
The reader folds the bins a pixel covers that have a `count` above 0. The
pixel's `count` is their sum, and its `mean` is the count-weighted mean of
their means. Its `variance` is the count-weighted mean of each bin's `variance`
plus the squared distance of the bin's `mean` from the pixel's `mean`. A pixel
over one such bin copies that bin's values. Folding `mean` or `variance` also
reads the `count` member, and folding `variance` reads `mean`, even when the
query does not ask for them. The segment does not carry those.

A raw segment that was resampled onto pixels computes the statistics from the
finite samples of each pixel. A raw segment that was not resampled carries
none, as does every trace of a montage or a filter query. An unknown member
name rejects with `RangeError` before any read starts.

Each statistic is a separate array. Its read runs under the same in-flight cap
and with the same `signal` as the min/max read, and adds a round trip.

### The raw-read byte cap

`maxRawBytes` bounds a query's reads of the raw level, forced or selected. The
figure counted is the uncompressed size of the raw samples read, summed across
traces, and both sides of a montage pair count. The samples of a pause are not
read and not counted. A pixel width that selects a min/max level reads a bounded
number of bins and is not counted.

A read over the cap rejects with `RawReadTooLargeError` before fetching anything. The
error carries `requestedBytes` and `maxBytes`. Narrow the window or raise `maxRawBytes`.

Every check of a request runs before its first read starts: an unknown channel, a
misaligned montage pair, a filter spec outside a trace's Nyquist range, and the byte cap
all reject with no I/O. A read that fails rejects the iteration and cancels the reads of
the traces not yet yielded. A consumer that stops iterating early cancels them too.

### The response cache

A client caches the store responses it reads, bounded by `maxCacheBytes` and evicted
least recently used first. Bundles are immutable, so a hit is never revalidated.

An inner chunk covers more time than one query window, so windows that pan or page
across a bundle read the same chunks. The cache is what keeps those reads off the
network. Sizing it below one window's working set makes every window evict the one
before it, so raise it rather than leave it thrashing.

Array metadata does not go through the cache at all. The client reads the root
`zarr.json` once and serves every array's metadata out of its consolidated block, so a
query fetches chunk bytes and nothing else.

Callers that ask for the same bytes while a read is already in flight share that read
rather than issuing their own, so concurrent queries over overlapping windows fetch
each chunk once. One caller aborting rejects that caller promptly and leaves the
read running for the rest. The request itself is cancelled once every caller waiting on
it has aborted, so a discarded viewport stops consuming the connection. A caller that
passes no signal cannot abort, and holds the read to completion for everyone.

### Round trips per query

A query reads one level per trace, and each read costs at least one round trip. Reads run
under `maxInflightFetches`, so a query serializes into `ceil(traces / maxInflightFetches)`
rounds. Against a store with 200 ms of latency, 130 traces at the default cap of 64 take
three rounds and spend 0.6 seconds in round trips alone, whatever the bytes involved. Keep
the cap at or above the number of traces a view puts on screen.

Reads are admitted highest priority first. A query takes `priority`, one of `viewport`,
`prefetch` or `background`, defaulting to `viewport`; `dataSpans` defaults to
`background`. That union is exported as `ReadPriority`. A lower priority holds only part
of the pool, so a survey submitted before the first viewport read cannot take every slot,
and a priority with nothing running is admitted ahead of the order, so none waits
forever. Order within one priority is the order of submission.

Ranged reads of one key issued together are merged into one read, so a trace spanning
several inner chunks of a shard costs one request rather than one per chunk. Merging is
decided before the request cap applies, so waiting for a slot delays a request without
splitting a batch.

### Delivery boundaries

Segments are delivered on sample or bin boundaries. A segment's `startUs` is the
start of the first sample or bin overlapping the window, and a bin read can run
up to one bin past `endUs`. A window overlapping no data yields a segment with
empty `data` and a `startUs` clamped to the nearest channel edge.

A gap inside a trace arrives as NaN values inside its segment. A chunk the
producer omitted reads as NaN too, which is what the format defines for a span
that was never recorded. A resampled pixel bucket with no finite value comes
back as a `[NaN, NaN]` pair, so gaps stay visible at every zoom.

A channel that paused and resumed stores one row per run in its `runs` table,
each with the exact time of the run's first sample. A raw read of such a channel
yields one segment per run that overlaps the window, in time order, whether
`raw`, a filter, or the pixel width selected the raw level. Each segment's
`startUs` is the exact time of its first sample, and its samples are
`samplePeriodUs` apart. The samples of a pause hold no data and are not
delivered. A window inside a pause yields one segment with empty `data`. A
resampled raw read still anchors its buckets at the channel start, so a bucket
that holds the end of one run and the start of the next appears in both
segments.

A montage trace and a read of a pyramid level stay on the channel's grid,
`startUs + i * samplePeriodUs`. The grid places a sample after a pause up to one
sample period from its exact time. [`runs()`](#runsoptions) gives the exact
times.

`query()` is an async generator. Validation happens on the first iteration, not on the
call, so wrap the `for await` loop in `try`/`catch` rather than the call itself. A
non-positive `pixelWidthUs`, a window with `endUs < startUs`, and an already-aborted
`signal` all reject there.

### Filter state

A filter is stateful. The client holds that state for its lifetime, one filter per
(channel, filter spec, sample rate). A montaged trace keys its state by the compound
montage key, separate from either constituent channel. Consecutive windows filter as one
continuous signal, so a trace read window by window matches the same trace read whole. A
backward jump of more than one sample, or a gap wider than 100 samples, restarts the
filter for that channel.

The segments of a channel with runs filter as one signal. The filter sees only
the samples of each run. A pause of up to 100 samples carries the state across
it, and a longer pause restarts the filter. A run that resumes less than one
sample off its grid continues the previous run.

A continuation is the one case where a segment does not start on a bin boundary. Reads
snap outward to bin boundaries, so two windows meeting between samples both cover the
sample at the seam. A filtered continuation drops that repeated sample and starts one
sample later. A continuation narrower than one sample returns empty data.
`channelInfo()` reports each channel's sample rate, for callers that want windows landing
on sample boundaries.

## `queryEvents(options)`

Returns an async iterable of `EventWindow`, one per requested event channel, in request
order. Takes `channels`, `startUs`, `endUs`, an optional `pixelWidthUs`, an optional
`columns`, an optional `priority` (defaulting to `"viewport"`), and an optional
`signal`.

An event is in the window when its span overlaps `[startUs, endUs)`. A point event is
the instant of its time, and an interval covers the half-open span `[t, t + d)`, so an
interval that opened before the window and is still running is included and one that
ended exactly at `startUs` is not. Finding the open intervals means searching back from
`startUs` by the channel's `maxDurationUs`, or from the channel's first event when it
stores durations but declares no bound.

Each window holds `times`, the events' onsets in ascending order, plus one entry per
column read. Index `i` of every column is event `i`. The columns:

- `durations`: `Float64Array` of microseconds. 0 is a point event.
- `labels`: `Uint16Array` of label values, indexes into the channel's `labelNames`.
- `values`: `Float64Array`, one measurement per event in the channel's `unit`.
- `text`: one decoded string per event. Free text, or whatever the producer wrote, such
  as a JSON object per detector hit.
- `channels`: the ids of the channels each event applies to. An empty list names no
  channel. The bundle stores channel indices; the reader resolves them to ids, and
  returns an index that names no channel in the bundle as the index itself.
- `waveforms`: a `Waveforms` record holding `pointsPerEvent`, `periodUs`,
  `eventSample` (the snippet index recorded at the event time), and `data`, one row of
  `pointsPerEvent` samples per event, flattened row-major.

By default every column the channel stores is read. `columns` narrows the list; `text`
can be most of a dense channel's bytes, so a raster view should leave it out. Waveforms
are read only when the window holds events and, if `pixelWidthUs` is given, one snippet
spans more than 10 pixels. Omit `pixelWidthUs` to read them whenever asked for.

`queryEvents()` rejects continuous channels, an unknown id, a non-positive
`pixelWidthUs`, and an `endUs` before `startUs`.

## `eventCounts(options)`

Returns a promise for the `EventCounts` of one event channel over a window: the per-bin
event counts from the coarsest count level whose bins fit within one pixel, falling
back to the finest. Takes `channel`, `startUs`, `endUs`, `pixelWidthUs`, an optional
`priority` (defaulting to `"viewport"`), and an optional `signal`.

The result holds `level` (numbered from 1), `startUs` (the start of the first bin),
`periodUs`, `labelCount`, and `counts`, a `Uint32Array` of `labelCount` values per bin,
flattened row-major: events in the bin per label category, in label order. Bins are
delivered whole, so the first may start before `startUs` and the last run past `endUs`.
An event with a duration is counted in the bin of its onset only.

A producer writes count levels for dense channels, roughly above 64,000 events. A
channel without them, which `channelInfo()` reports as `countLevels: 0`, rejects; read
its events with `queryEvents()` instead. An unknown id, a continuous channel, a
non-positive `pixelWidthUs`, and an `endUs` before `startUs` reject too.

## `waveformMean(options)`

Returns a promise for an event channel's mean waveform per label category as a
`Waveforms` record, one row per label in label order, or `undefined` when the channel
stores none. Takes `channel`, an optional `priority`, and an optional `signal`. A legend
reads this one small array in place of every snippet in the channel. Rejects for an
unknown id or a continuous channel.

## `dataSpans(options)`

Returns a promise for the `[startUs, endUs)` spans where one continuous channel has data,
clamped to the window. Takes `channel`, `startUs`, `endUs`, an optional `gapThresholdUs`,
an optional `priority` (defaulting to `"background"`), and an optional `signal`.

Spans come from the coarsest pyramid level, so their edges align to that level's
bins, rounded outward to whole microseconds and kept inside the channel's
`startUs` and `endUs`. A bin is populated when the level's `count` member is
above zero, or, on a level without `count`, when its min/max is finite. In a 1.0
bundle the two agree: every statistic covers a bin's finite samples only, and a
bin is NaN only when it recorded none. Gaps no wider than `gapThresholdUs` are
bridged into one span. The default of 0 splits on every gap.

A channel without levels reads its raw samples instead. A sample is populated
when it is finite, and a channel with runs places each sample at its exact time,
so the edges of a pause are exact. On a level, the edges of a pause fall on bin
boundaries, and [`runs()`](#runsoptions) gives them exactly.

## `runs(options)`

Returns a promise for a continuous channel's runs in time order, each a `Run` with
`firstSample`, `sampleCount`, `startUs`, and `endUs`. Takes `channel`, an optional
`priority` (defaulting to `"viewport"`), and an optional `signal`.

A run is a span of samples recorded one period apart. A recording that paused and
resumed off its sample grid stores one row per run with the exact resume time, which
the grid can only place to within one sample period. Sample `firstSample + i` of a
run is at `startUs + i * samplePeriod`, and `endUs` is one period past its last
sample, exclusive and rounded up to a whole microsecond. A channel without a
`runs` table is one run from `startUs` over every sample, and an empty channel has none. The table is read once per channel and
cached for the client's lifetime.

Rejects for an unknown id, an event channel, or a table that breaks the format's
rules: row 0 must start the channel at `startUs`, runs must be in order without
overlap and end at the last sample, and each must start within one sample period of
its grid sample. The error names the channel and the row.

## `openBundle(url)`

Picks a built-in store by scheme or path form:

- `http://` and `https://` URLs get `FetchStore`, which is also exported. The store is
  built with `useSuffixRequest`, so a shard index costs one `Range: bytes=-N` request
  rather than a HEAD and an offset range; a consumer building its own `FetchStore` should
  pass the same option.
- `file://` URLs and absolute paths, POSIX (`/bundle.zarr`) or Windows drive-letter
  (`C:\bundle.zarr`), get the filesystem store. It is imported lazily and stays out of
  browser bundles.
- Relative paths and any other scheme throw.

`FileStore` is also exported on its own, from the `./node` subpath:

```ts
import { StreamingClient } from "@pennsieve/timeseries-zarr-reader";
import { FileStore } from "@pennsieve/timeseries-zarr-reader/node";

const client = new StreamingClient({
  store: new FileStore("/data/recording.zarr"),
});
```

## Custom stores

Every read goes through a `Store`. The reader performs no network or filesystem I/O of its
own, so authentication, request signing, and caching all belong in a store you supply to
`new StreamingClient({ store })`. The `Store`, `StoreOptions`, and `ByteRange` types are
exported:

```ts
type Store = {
  get(key: `/${string}`, opts?: StoreOptions): Promise<Uint8Array | undefined>;
  getRange(
    key: `/${string}`,
    range: ByteRange,
    opts?: StoreOptions,
  ): Promise<Uint8Array | undefined>;
};
```

`StoreOptions` carries an optional `AbortSignal`. `ByteRange` is either
`{ offset, length }` or `{ suffixLength }` for the last bytes of a key. Both methods
resolve to `undefined` for a missing key.

A custom store must implement `getRange`, including the suffix form. Every array in a
bundle is sharded, and reading a shard starts by reading its index from the end of the
object. A missing key must resolve to `undefined` rather than reject: the format lets a
producer omit a chunk whose values are all the fill value, and the reader then reads the
gap as NaN.
