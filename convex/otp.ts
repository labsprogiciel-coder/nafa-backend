// convex/otp.ts — caps how many sign-in codes one number receives
//
// Convex Auth already limits wrong codes (10 failed tries per hour per
// number); this limits sends, so nobody can make Nafa pay for a flood of SMS.
import { ConvexError, v } from "convex/values";
import { internalMutation } from "./lib/functions";
import { sendAllowed } from "./lib/phone";

/**
 * Record a send to `phone` if the limits allow it, else throw
 * TOO_MANY_CODES with `retryAfterMs`. Mutations run one at a time per
 * document set, so two simultaneous requests can't both pass.
 */
export const reserveSend = internalMutation({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const now = Date.now();
    const recent = await ctx.db
      .query("codeSends")
      .withIndex("by_phone_at", (q) => q.eq("phone", phone).gt("at", now - 3_600_000))
      .collect();
    const verdict = sendAllowed(
      recent.map((r) => r.at),
      now,
    );
    if (!verdict.ok) {
      throw new ConvexError({ code: "TOO_MANY_CODES", retryAfterMs: verdict.retryAfterMs });
    }
    await ctx.db.insert("codeSends", { phone, at: now });
    // Older rows are no longer needed for the rolling hour
    const stale = await ctx.db
      .query("codeSends")
      .withIndex("by_phone_at", (q) => q.eq("phone", phone).lte("at", now - 3_600_000))
      .collect();
    for (const row of stale) await ctx.db.delete(row._id);
  },
});
