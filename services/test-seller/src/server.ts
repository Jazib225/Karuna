// TEST FIXTURE ONLY — not part of the Karuna product.
// A local x402 seller (Circle Gateway nanopayments on Arc testnet) used to prove that the
// Gatekeeper can pay for a service and hand the result back to an agent.
//
//   TEST_SELLER_ADDRESS=0x... pnpm --dir services/test-seller start
//
// GET  /v1/data           paid endpoint, price = current price (default $0.001)
// POST /__test/price      {"usd":"0.002"} changes the price (used to test Exact Match)
// GET  /health            free
import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

const sellerAddress = process.env.TEST_SELLER_ADDRESS;
if (!sellerAddress || !/^0x[0-9a-fA-F]{40}$/.test(sellerAddress)) {
  console.error("Set TEST_SELLER_ADDRESS to the address that should receive test payments.");
  process.exit(1);
}
const PORT = Number(process.env.TEST_SELLER_PORT ?? 4021);

const gateway = createGatewayMiddleware({
  sellerAddress,
  networks: ["eip155:5042002"], // Arc testnet only
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  description: "Karuna test seller",
});

let priceUsd = process.env.TEST_SELLER_PRICE ?? "0.001";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, priceUsd, sellerAddress }));

// Only reachable from this machine; lets the verification script change the price.
app.post("/__test/price", (req, res) => {
  const usd = String(req.body?.usd ?? "");
  if (!/^\d+(\.\d+)?$/.test(usd)) return res.status(400).json({ error: "usd must be a number string" });
  priceUsd = usd;
  res.json({ priceUsd });
});

app.get(
  "/v1/data",
  (req, res, next) => gateway.require(`$${priceUsd}`)(req, res, next),
  (req, res) => {
    const payment = (req as unknown as { payment?: Record<string, unknown> }).payment;
    res.json({
      data: { generatedAt: new Date().toISOString(), value: Math.round(Math.random() * 1e6) / 100 },
      paid: payment ?? null,
    });
  },
);

app.listen(PORT, "127.0.0.1", () =>
  console.log(`test-seller on http://127.0.0.1:${PORT} → pays ${sellerAddress} · price $${priceUsd}`),
);
