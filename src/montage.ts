import type { ChannelInfo } from "./types.js";

/**
 * Subtracts `secondary` from `lead`, sample by sample.
 *
 * Values stay in physical units; no sign flip. NaN in either input propagates.
 * Neither input is modified. Throws RangeError when the lengths differ.
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

  // Plain loop: this runs over millions of raw samples.
  const out = new Float64Array(lead.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = lead[i]! - secondary[i]!;
  }
  return out;
}

/**
 * Builds the channel key for a montaged trace: `{leadId}_{leadName}<->{secondaryName}`.
 *
 * Swapping lead and secondary yields a different key (the opposite subtraction).
 * Names are copied verbatim, unescaped; the key is a display label, not a parseable
 * structure.
 */
export function montageChannelKey(
  lead: Pick<ChannelInfo, "id" | "name">,
  secondary: Pick<ChannelInfo, "id" | "name">,
): string {
  return lead.id + "_" + lead.name + "<->" + secondary.name;
}
