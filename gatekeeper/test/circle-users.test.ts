// Sign in with email (Circle user-controlled wallets): the Gatekeeper's side, against a fake Circle.
import { describe, it, expect } from "vitest";
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_CHAIN_ID, Kind, actionTypedData, encodeChange, paymentDecisionTypedData, toCircleTypedData } from "@prekaruna/dharma";
import { CircleUsers, CircleUsersError } from "../src/circle-users.ts";

const KEY = "TEST_API_KEY:abc:def";
const APP = "app-123";
const DHARMA = "0x1034316a026f18096c42346ae2e549856380d933" as const;

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
function fakeCircle(reply: (c: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const c: Call = { url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = reply(c);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, circle: new CircleUsers(KEY, APP, fetchFn, "https://circle.test") };
}

describe("sign in with email (Circle)", () => {
  it("is off until both the API key and the App ID are set", async () => {
    expect(new CircleUsers(undefined, APP).enabled).toBe(false);
    expect(new CircleUsers(KEY, undefined).enabled).toBe(false);
    await expect(new CircleUsers(undefined, undefined).emailToken("a@b.co", "d")).rejects.toMatchObject({ status: 503 });
  });

  it("emails a code: the API key goes only to Circle, the browser gets per-login tokens and the App ID", async () => {
    const { calls, circle } = fakeCircle(() => ({ json: { data: { deviceToken: "dt", deviceEncryptionKey: "dek", otpToken: "ot" } } }));
    const r = await circle.emailToken("  Adi@Example.com ", "device-1");
    expect(r).toEqual({ appId: APP, deviceToken: "dt", deviceEncryptionKey: "dek", otpToken: "ot" });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(calls[0]).toMatchObject({ url: "https://circle.test/v1/w3s/users/email/token", method: "POST", body: { deviceId: "device-1", email: "adi@example.com" } });
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    await expect(circle.emailToken("not-an-email", "d")).rejects.toThrow(/valid email/);
  });

  it("first sign-in creates an EOA on Arc; a returning person has nothing to create", async () => {
    let n = 0;
    const { calls, circle } = fakeCircle(() => (n++ === 0 ? { status: 201, json: { data: { challengeId: "ch-1" } } } : { status: 409, json: { code: 155106, message: "already initialized" } }));
    expect(await circle.initialize("ut")).toEqual({ challengeId: "ch-1" });
    expect(calls[0].body).toMatchObject({ accountType: "EOA", blockchains: ["ARC-TESTNET"] });
    expect(calls[0].headers["x-user-token"]).toBe("ut");
    expect(await circle.initialize("ut")).toEqual({ challengeId: null });
  });

  it("the member address is the person's live EOA on Arc", async () => {
    const { circle } = fakeCircle(() => ({
      json: { data: { wallets: [
        { id: "w-sca", address: "0xAAA", blockchain: "ARC-TESTNET", accountType: "SCA", state: "LIVE" },
        { id: "w-eoa", address: "0x00000000000000000000000000000000000000BB", blockchain: "ARC-TESTNET", accountType: "EOA", state: "LIVE" },
      ] } },
    }));
    expect(await circle.wallet("ut")).toEqual({ walletId: "w-eoa", address: "0x00000000000000000000000000000000000000bb" });
    const empty = fakeCircle(() => ({ json: { data: { wallets: [] } } }));
    await expect(empty.circle.wallet("ut")).rejects.toBeInstanceOf(CircleUsersError);
  });

  it("signing forwards the exact typed data and returns the challenge for Circle's window", async () => {
    const { calls, circle } = fakeCircle(() => ({ status: 201, json: { data: { challengeId: "sig-1" } } }));
    const td = toCircleTypedData(paymentDecisionTypedData(DHARMA, ARC_TESTNET_CHAIN_ID, { proposalId: "p1", payloadHash: `0x${"ab".repeat(32)}`, approve: true, deadline: 1n }));
    expect(await circle.signTypedData("ut", "w-eoa", td)).toEqual({ challengeId: "sig-1" });
    expect(calls[0]).toMatchObject({ url: "https://circle.test/v1/w3s/user/sign/typedData", body: { walletId: "w-eoa", data: td } });
  });

  it("Circle's errors come back readable, without the key", async () => {
    const { circle } = fakeCircle(() => ({ status: 401, json: { code: 401, message: "Malformed authorization" } }));
    const e = await circle.wallet("ut").catch((x) => x);
    expect(e).toBeInstanceOf(CircleUsersError);
    expect(e.status).toBe(401);
    expect(e.message).not.toContain(KEY);
  });
});

describe("a Circle signature verifies like a browser key's", () => {
  it("the JSON Circle signs has the same EIP-712 hash as Karuna's typed data, for actions and decisions", async () => {
    // Circle's EOA stands in as a plain key: it parses the JSON it's given and signs it.
    const circleWallet = privateKeyToAccount(generatePrivateKey());
    const { op, data } = encodeChange({ op: "Freeze" });
    for (const td of [
      actionTypedData(DHARMA, ARC_TESTNET_CHAIN_ID, { kind: Kind.Propose, op, data, proposalId: 0n, support: false, nonce: 3n, deadline: 1_900_000_000n }),
      paymentDecisionTypedData(DHARMA, ARC_TESTNET_CHAIN_ID, { proposalId: "p-7", payloadHash: `0x${"cd".repeat(32)}`, approve: true, deadline: 1_900_000_000n }),
    ]) {
      const parsed = JSON.parse(toCircleTypedData(td));
      const { EIP712Domain: _, ...types } = parsed.types;
      const asCircleSees = { domain: parsed.domain, types, primaryType: parsed.primaryType, message: parsed.message };
      expect(hashTypedData(asCircleSees as never)).toBe(hashTypedData(td as never));
      const signature = await circleWallet.signTypedData(asCircleSees as never);
      expect(await recoverTypedDataAddress({ ...(td as object), signature } as never)).toBe(circleWallet.address);
      expect((signature as Hex).length).toBe(132); // 65 bytes: what Dharma's ecrecover expects
    }
  });
});
