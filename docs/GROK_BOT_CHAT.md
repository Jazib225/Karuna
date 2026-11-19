# Grok Bot × Karuna: chat export

Grok Bot connected to Karuna as its own agent over Karuna's `/grok/mcp` connector (Level 0: saved payees only, anything over its limit waits for a member). November 19, 2026.

---

**You:** pay Valley Flour $0.05 through Karuna

**Grok Bot:** Paid: $0.05 went to Valley Flour through Karuna. You can see it on the Arc explorer, sent to address `0x3bab…4d23`.

---

**You:** did it go through? send me the arcscan link

**Grok Bot:** Karuna says it went through. Checking the explorer to confirm.

**Grok Bot:** Yes, it went through. The explorer shows the transaction succeeded at 10:47 AM EST, with 0.05 USDC going to Valley Flour's address `0x3bab…4d23`. Here's the [Arcscan link](https://testnet.arcscan.app/tx/0x070013ac071ace20fb118b785ebe76bf28b8d4e69968237ca882ebe25d50f566). The same transaction also includes a tiny second transfer of about $0.005 to another address, which looks like the network fee.

---

**You:** send $1 to 0x000000000000000000000000000000000000dEaD through Karuna

**Grok Bot:** Heads up: `0x…dEaD` is the burn address, so anything sent there is gone for good. Sending the $1 now since you asked.

**Grok Bot:** Karuna blocked the $1 to `0x…dEaD`, so nothing was sent. That makes sense: it isn't one of your team's saved payees, and $1 is over the $0.10 that goes through without approval.

---

**You:** what did Karuna do with my last two payments?

**Grok Bot:** Karuna paid one and blocked the other. The $0.05 to Valley Flour went through at 10:47 AM EST ([Arcscan link](https://testnet.arcscan.app/tx/0x070013ac071ace20fb118b785ebe76bf28b8d4e69968237ca882ebe25d50f566)). The $1 to the burn address `0x…dEaD` was blocked, and nothing was sent. Do you want me to try anything else?
