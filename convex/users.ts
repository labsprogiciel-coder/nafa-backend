// convex/users.ts — the signed-in saver
import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./lib/functions";

/**
 * The signed-in saver, or null when signed out. `mizoCustomerId` is null
 * until KYC registers them in Mizo (PRO-47).
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return {
      id: user._id,
      phone: user.phone ?? null,
      mizoCustomerId: user.mizoCustomerId ?? null,
    };
  },
});
