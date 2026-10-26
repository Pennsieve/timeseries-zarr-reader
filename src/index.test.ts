import { expect, expectTypeOf, test } from "vitest";
import type * as client from "./client.js";
import * as reader from "./index.js";
import type * as types from "./types.js";

/** Values the package exports. Type-only exports have no runtime binding. */
const RUNTIME_EXPORTS = [
  "FetchStore",
  "RawReadTooLargeError",
  "StreamingClient",
  "openBundle",
];

test("the package exports exactly the documented runtime symbols", () => {
  expect(Object.keys(reader).sort()).toEqual(RUNTIME_EXPORTS);
});

// One assertion per re-exported type. Dropping a type export fails to compile here.
test("the package re-exports the declared types", () => {
  expectTypeOf<reader.ByteRange>().toEqualTypeOf<types.ByteRange>();
  expectTypeOf<reader.ChannelInfo>().toEqualTypeOf<types.ChannelInfo>();
  expectTypeOf<reader.ContinuousChannelInfo>().toEqualTypeOf<types.ContinuousChannelInfo>();
  expectTypeOf<reader.EventChannelInfo>().toEqualTypeOf<types.EventChannelInfo>();
  expectTypeOf<reader.EventColumn>().toEqualTypeOf<types.EventColumn>();
  expectTypeOf<reader.EventCounts>().toEqualTypeOf<types.EventCounts>();
  expectTypeOf<reader.EventWindow>().toEqualTypeOf<types.EventWindow>();
  expectTypeOf<reader.RecordingInfo>().toEqualTypeOf<types.RecordingInfo>();
  expectTypeOf<reader.Waveforms>().toEqualTypeOf<types.Waveforms>();
  expectTypeOf<reader.FilterSpec>().toEqualTypeOf<types.FilterSpec>();
  expectTypeOf<reader.MontagePair>().toEqualTypeOf<types.MontagePair>();
  expectTypeOf<reader.ReadPriority>().toEqualTypeOf<types.ReadPriority>();
  expectTypeOf<reader.Segment>().toEqualTypeOf<types.Segment>();
  expectTypeOf<reader.Store>().toEqualTypeOf<types.Store>();
  expectTypeOf<reader.StoreOptions>().toEqualTypeOf<types.StoreOptions>();
  expectTypeOf<reader.DataSpanOptions>().toEqualTypeOf<client.DataSpanOptions>();
  expectTypeOf<reader.QueryOptions>().toEqualTypeOf<client.QueryOptions>();
  expectTypeOf<reader.StreamingClientOptions>().toEqualTypeOf<client.StreamingClientOptions>();
  expectTypeOf<reader.EventCountOptions>().toEqualTypeOf<client.EventCountOptions>();
  expectTypeOf<reader.EventQueryOptions>().toEqualTypeOf<client.EventQueryOptions>();
  expectTypeOf<reader.WaveformMeanOptions>().toEqualTypeOf<client.WaveformMeanOptions>();
});
