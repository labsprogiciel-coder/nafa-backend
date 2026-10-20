// convex/auth.config.ts — Convex validates the tokens Convex Auth issues
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
