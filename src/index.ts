/**
 * Public surface of the reader: the streaming client and its option types, the
 * segment/event data types, the `Store` contract, and the store constructors.
 */

export type {
  ByteRange,
  ChannelInfo,
  ContinuousChannelInfo,
  EventChannelInfo,
  EventColumn,
  EventCounts,
  EventWindow,
  FilterSpec,
  LevelMember,
  MontagePair,
  ReadPriority,
  RecordingInfo,
  Run,
  Segment,
  Store,
  StoreOptions,
  Waveforms,
} from "./types.js";
export { FetchStore, openBundle } from "./stores/open-bundle.js";
export { RawReadTooLargeError, StreamingClient } from "./client.js";
export type {
  DataSpanOptions,
  EventCountOptions,
  EventQueryOptions,
  QueryOptions,
  RunOptions,
  StreamingClientOptions,
  WaveformMeanOptions,
} from "./client.js";
