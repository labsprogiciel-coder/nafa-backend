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
import { anyApi } from "convex/server";
import { ConvexError } from "convex/values";
import { CODE_TTL_MINUTES, codeMessage, generateCode, isAcceptedPhone } from "./lib/phone";
import { sendText, twilioFromEnv } from "./lib/twilio";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Phone({
      id: "phone",
      maxAge: CODE_TTL_MINUTES * 60,
      generateVerificationToken: async () => generateCode(),
      async sendVerificationRequest({ identifier: phone, token }, ctx) {
        await ctx.runMutation(anyApi.otp.reserveSend, { phone });
        await sendText(twilioFromEnv(), phone, codeMessage(token));
      },
    }),
  ],
  callbacks: {
    // Runs when a code is requested (inside that transaction: refusing here
    // leaves nothing behind) and again when it is confirmed
    async createOrUpdateUser(ctx, args) {
      if (args.existingUserId) {
        // First confirmed code: the number is the saver's
        if (args.profile.phoneVerified) {
          const user = await ctx.db.get(args.existingUserId);
          if (user && user.phoneVerificationTime === undefined) {
            await ctx.db.patch(args.existingUserId, { phoneVerificationTime: Date.now() });
          }
        }
        return args.existingUserId;
      }
      const phone = args.profile.phone;
      if (typeof phone !== "string" || !isAcceptedPhone(phone)) {
        throw new ConvexError({ code: "INVALID_PHONE" });
      }
      return await ctx.db.insert("users", { phone });
    },
  },
});
