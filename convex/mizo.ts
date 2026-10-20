// convex/mizo.ts — the Mizo partner API as internal actions
//
// Internal only: callable from this backend's own functions and from the CLI
// (`npx convex run mizo:catalogue`), never from the app. Each returns the
// client's MizoResult unchanged.
//
// Built with the generic builders so they need no generated code; switch to
// `internalAction` from "./_generated/server" once `npx convex dev` has run.
import { internalActionGeneric as internalAction } from "convex/server";
import { v } from "convex/values";
import { mizoFromEnv } from "./lib/mizo";

const movement = {
  customerId: v.string(),
  productCode: v.string(),
  amount: v.number(),
  reference: v.string(),
};

export const catalogue = internalAction({
  args: {},
  handler: () => mizoFromEnv().catalogue(),
});

export const createCustomer = internalAction({
  args: { fullName: v.string(), phoneNumber: v.string(), idNumber: v.optional(v.string()) },
  handler: (_ctx, args) => mizoFromEnv().createCustomer(args),
});

export const customer = internalAction({
  args: { customerId: v.string() },
  handler: (_ctx, args) => mizoFromEnv().customer(args.customerId),
});

export const transactions = internalAction({
  args: { customerId: v.string(), productCode: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: (_ctx, args) => mizoFromEnv().transactions(args),
});

export const deposit = internalAction({
  args: movement,
  handler: (_ctx, args) => mizoFromEnv().deposit(args),
});

export const withdraw = internalAction({
  args: movement,
  handler: (_ctx, args) => mizoFromEnv().withdraw(args),
});

export const cancelWithdrawal = internalAction({
  args: { reference: v.string(), reason: v.optional(v.string()) },
  handler: (_ctx, args) => mizoFromEnv().cancelWithdrawal(args),
});
