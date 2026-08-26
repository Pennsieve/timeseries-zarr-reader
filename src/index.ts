/**
 * Public surface of the reader: the streaming client and its option types, the
 * segment/event data types, the `Store` contract, and the store constructors.
 */

export type {
  ByteRange,
  ChannelInfo,
  EventBatch,
  FilterSpec,
  MontagePair,
  ReadPriority,
  Segment,
  Store,
  StoreOptions,
} from "./types.js";
export { FetchStore, openBundle } from "./stores/open-bundle.js";
export { RawReadTooLargeError, StreamingClient } from "./client.js";
export type {
  DataSpanOptions,
  QueryOptions,
  StreamingClientOptions,
  UnitQueryOptions,
} from "./client.js";
