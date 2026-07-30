import type { ChannelInfo } from "./types.js";

/**
 * Subtract one channel's samples from another, sample by sample.
 *
 * This is the arithmetic behind a bipolar montage: the trace shown is the lead channel
 * minus the secondary channel, which cancels the reference the two share and leaves the
 * potential difference between the two sites. Values stay in physical units and the sign is
 * never flipped - the difference is reported as measured, and y-axis orientation is the
 * consumer's concern.
 *
 * Raw samples only. The envelope of a difference is not the difference of two envelopes,
 * because the true extremes depend on when each channel reached its own min and max, which
 * a pre-decimated level no longer records. That is why an active montage forces a raw read
 * instead of reusing a pyramid level.
 *
 * The two arrays must be the same length. Alignment cannot be checked here - arrays carry
 * no start time or sample period - so equal length stands as the caller's promise that both
 * cover the same window at the same rate. A mismatch is a programming error and throws a
 * RangeError, rather than truncating to the shorter and returning a plausible-looking but
 * time-shifted trace.
 *
 * A gap in either channel propagates, since NaN minus anything is NaN: the difference is
 * undefined wherever either input is. Empty inputs yield an empty result. Neither input is
 * modified.
 */
export function subtract(
  lead: Float64Array,
  secondary: Float64Array,
): Float64Array {
  if (lead.length !== secondary.length) {
    throw new RangeError(
      `lead and secondary must be the same length (got ${lead.length} and ${secondary.length})`,
    );
  }

  // Plain loop, not map: a montage reads the raw level, so this runs over millions of
  // samples and a per-element closure would cost real time.
  const out = new Float64Array(lead.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = (lead[i] as number) - (secondary[i] as number);
  }
  return out;
}

/**
 * Build the channel key for a montaged trace.
 *
 * A montaged trace comes from two channels, so it needs a key of its own rather than either
 * channel's. This is what a segment reports as its channel, which is how a consumer labels
 * the trace and groups the segments belonging to one pair.
 *
 * The shape is `{leadId}_{leadName}<->{secondaryName}`.
 *
 * Only the lead contributes an id, so the same key results whichever channel record supplies
 * a given secondary name. The key is deliberately asymmetric so that swapping
 * lead and secondary describes the opposite subtraction and yields a different key.
 *
 * Names are copied verbatim, with no escaping and no validation, so the result is an opaque
 * label to show rather than a structure to parse back: a name containing the delimiter would
 * make it ambiguous, and an empty name still yields the delimiters around it.
 */
export function compoundKey(
  lead: Pick<ChannelInfo, "id" | "name">,
  secondary: Pick<ChannelInfo, "id" | "name">,
): string {
  return lead.id + "_" + lead.name + "<->" + secondary.name;
}
