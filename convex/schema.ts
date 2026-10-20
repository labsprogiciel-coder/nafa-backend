// convex/schema.ts
import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Convex Auth: sessions, accounts, verification codes, rate limits
  ...authTables,

  // Savers. Replaces Convex Auth's default users table; keeps the fields and
  // the `phone` index it reads.
  users: defineTable({
    name: v.optional(v.string()),
    phone: v.optional(v.string()), // E.164, the sign-in identity (lib/phone.ts)
    phoneVerificationTime: v.optional(v.number()),
    // The saver's customer in Mizo, set once KYC is done (PRO-47)
    mizoCustomerId: v.optional(v.string()),
  }).index("phone", ["phone"]),

  // When each sign-in code was sent, to cap sends per number (otp.ts)
  codeSends: defineTable({
    phone: v.string(),
    at: v.number(),
  }).index("by_phone_at", ["phone", "at"]),
});
