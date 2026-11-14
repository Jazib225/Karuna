// Short, distinct names for the Activity log, so every kind of event reads differently at a glance
// ("Agents unfrozen", not "dharma-executed"). The raw type stays available as the row's tooltip.

/** What a Dharma change is, in a few words (from its op, or from its description on older entries). */
const CHANGE: Record<string, { noun: string; done: string }> = {
  Freeze: { noun: "Freeze", done: "Agents frozen" },
  Unfreeze: { noun: "Unfreeze", done: "Agents unfrozen" },
  SetPayee: { noun: "New payee", done: "Payee added" },
  RemovePayee: { noun: "Payee removal", done: "Payee removed" },
  SetAgent: { noun: "Allowance", done: "Allowance set" },
  RemoveAgent: { noun: "Agent removal", done: "Agent removed" },
  AddRule: { noun: "New rule", done: "Rule added" },
  RemoveRule: { noun: "Rule removal", done: "Rule removed" },
  AddDomain: { noun: "New domain", done: "Domain allowed" },
  RemoveDomain: { noun: "Domain block", done: "Domain blocked" },
  SetThreshold: { noun: "Two-person limit", done: "Two-person limit set" },
  AddMember: { noun: "New member", done: "Member added" },
  RemoveMember: { noun: "Member removal", done: "Member removed" },
  SetTimelock: { noun: "Wait change", done: "Wait changed" },
  SetCoreTimelock: { noun: "Core wait change", done: "Core wait changed" },
  Upgrade: { noun: "Upgrade", done: "Code upgraded" },
  SetLevel: { noun: "Level change", done: "Level changed" },
  SetLevelLimits: { noun: "Level limits", done: "Level limits set" },
};

/** Older log entries only kept the sentence (describeChange); map its opening words back to the op. */
const FROM_TEXT: [RegExp, string][] = [
  [/^Freeze every agent/, "Freeze"],
  [/^Unfreeze agents/, "Unfreeze"],
  [/^Allow payments to/, "SetPayee"],
  [/^Stop payments to/, "RemovePayee"],
  [/^Set .*daily allowance/, "SetAgent"],
  [/^Remove agent/, "RemoveAgent"],
  [/^(Allow|Block|Require approval for|Re-enable default rule)\b/, "AddRule"],
  [/^Remove rule/, "RemoveRule"],
  [/^Allow HTTP to/, "AddDomain"],
  [/^Block HTTP to/, "RemoveDomain"],
  [/^Require two approvers/, "SetThreshold"],
  [/^Add member/, "AddMember"],
  [/^Remove member/, "RemoveMember"],
  [/^Set Level \d .*payment limits/, "SetLevelLimits"],
  [/^Set .+ to Level \d/, "SetLevel"],
  [/^Set the wait for core changes/, "SetCoreTimelock"],
  [/^Set the wait for changes/, "SetTimelock"],
  [/^Upgrade Dharma/, "Upgrade"],
];

function changeOf(ev: Record<string, unknown>) {
  const op = typeof ev.op === "string" ? ev.op : FROM_TEXT.find(([re]) => re.test(String(ev.change ?? "")))?.[1];
  return op ? CHANGE[op] : undefined;
}

/** Events whose name doesn't depend on their details. */
const FIXED: Record<string, string> = {
  setup: "Org created",
  freeze: "Freeze pressed",
  executed: "Payment sent",
  approved: "Payment approved",
  "denied-by-human": "Payment denied",
  refused: "Payment refused",
  "execution-failed": "Payment failed",
  "exact-match-refused": "Exact Match blocked",
  "approval-signal-failed": "Alert not sent",
  "changed-bank-account": "Bank change blocked",
  "shield-test-sent": "Scam test sent",
  "shield-test-passed": "Scam test passed",
  "shield-test-failed": "Scam test failed",
  "shield-failed": "Scam test failed",
  "shield-rule-added": "Auto-block added",
  "shield-block-failed": "Auto-block failed",
  "learned-block-added": "Learned block added",
  "learned-block-failed": "Learned block failed",
  precedent: "Decision learned",
  "trap-touched": "Trap used",
  "traps-minted": "Traps created",
  "swarm-stopped": "Swarm stopped",
  "swarm-freeze-onchain": "Swarm freeze on Arc",
  "swarm-freeze-onchain-failed": "Swarm freeze failed",
  "agent-reported-message": "Message flagged",
  "inbox-message": "Message delivered",
  "agent-token-issued": "Agent token issued",
  "agent-token-rotated": "Agent token rotated",
  "access-requested": "Join requested",
  "dharma-execute-failed": "Execute failed",
  "sandbox-started": "Sandbox started",
  "sandbox-ended": "Sandbox ended",
  "sandbox-stop-requested": "Sandbox stopping",
  "key-stored": "Key added",
  "key-removed": "Key removed",
  paused: "Paused",
  resumed: "Resumed",
  "level-lowered": "Level lowered",
  "level-lower-failed": "Level drop failed",
  "tripwire-report-failed": "Tripwire report failed",
  "watchdog-transfer": "Wallet transfer checked",
  "watchdog-freeze-onchain": "Watchdog freeze on Arc",
  "watchdog-freeze-onchain-failed": "Watchdog freeze failed",
  "watchdog-report-failed": "Watchdog report failed",
  "dharma-code-deployed": "Upgrade code deployed",
};

/** The short name shown in bold for one log event. */
export function eventName(ev: Record<string, unknown>): string {
  const type = String(ev.type ?? "");
  const ch = changeOf(ev);
  if (type === "dharma") {
    const what = ch?.noun ?? "Change";
    if (ev.action === "propose") return `${what} proposed`;
    if (ev.action === "vote") return `${what}: voted ${ev.support === false ? "no" : "yes"}`;
    return ch?.done ?? "Change applied"; // tighten: the panic button (or an older instant change)
  }
  if (type === "dharma-executed") return ch?.done ?? "Change applied";
  if (type === "dharma-rejected") return `${ch?.noun ?? "Change"} rejected`;
  return FIXED[type] ?? (type ? type.charAt(0).toUpperCase() + type.slice(1).replace(/-/g, " ") : "Event");
}

/** Keys already said by the name, so the detail line doesn't repeat them. */
export const NAMED_KEYS = new Set(["type", "txRef", "action", "op", "support"]);
