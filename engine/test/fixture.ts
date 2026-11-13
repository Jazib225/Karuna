// Neutral TEST FIXTURE (not product data): two agents, one known recipient.
import { buildContext, DEFAULT_ALLOWLISTED_DOMAINS } from "../src/rules.ts";

export const VENDOR = "0x1111111111111111111111111111111111111111";
export const STRANGER = "0x2222222222222222222222222222222222222222";

export const fixtureContext = (spentTodayUsd: Record<string, number> = {}) =>
  buildContext(
    {
      agents: [
        { id: "payer", dailyAllowanceUsd: 50 },
        { id: "buyer", dailyAllowanceUsd: 10 },
      ],
      recipients: [{ address: VENDOR, name: "Vendor A", category: "services" }],
      allowlistedDomains: DEFAULT_ALLOWLISTED_DOMAINS,
    },
    spentTodayUsd,
  );
