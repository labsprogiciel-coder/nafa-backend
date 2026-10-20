// convex/auth.ts — saver sign-in with a phone number and a one-time code
//
// From the app: signIn("phone", { phone }) sends a 6-digit code, then
// signIn("phone", { phone, code }) signs in, creating the saver on first use.
// `phone` must already be E.164 ("+22670112233"); see lib/phone.ts.
//
// The app's 4-digit PIN never reaches this server: it only unlocks the app
// on the device.
import { Phone } from "@convex-dev/auth/providers/Phone";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { MutationCtx } from "./lib/functions";
import { CODE_TTL_MINUTES, codeMessage, generateCode, isAcceptedPhone } from "./lib/phone";
import { sendCode, twilioFromEnv } from "./lib/twilio";
import { reserveSend } from "./otp";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Phone({
      id: "phone",
      maxAge: CODE_TTL_MINUTES * 60,
      generateVerificationToken: async () => generateCode(),
      // The send limit was already checked in createOrUpdateUser
      async sendVerificationRequest({ identifier: phone, token }) {
        await sendCode(twilioFromEnv(), phone, token, codeMessage(token));
      },
    }),
  ],
  callbacks: {
    // Runs inside the transaction that stores a new code, before the
    // previous one is replaced, and again when a code is confirmed. Refusing
    // here rolls the whole request back: no row is written, and a code the
    // saver already received keeps working.
    async createOrUpdateUser(ctx, args) {
      const phone = args.profile.phone;
      if (args.profile.phoneVerified) {
        // A code was confirmed: the first time, the number becomes the saver's
        const user = args.existingUserId ? await ctx.db.get(args.existingUserId) : null;
        if (!user) throw new ConvexError({ code: "INVALID_PHONE" });
        if (user.phoneVerificationTime === undefined) {
          await ctx.db.patch(user._id, { phoneVerificationTime: Date.now() });
        }
        return user._id;
      }
      // A code is requested
      if (typeof phone !== "string" || !isAcceptedPhone(phone)) {
        throw new ConvexError({ code: "INVALID_PHONE" });
      }
      await reserveSend(ctx as unknown as MutationCtx, phone);
      return args.existingUserId ?? (await ctx.db.insert("users", { phone }));
    },
  },
});
