// The one shape every money call returns (spec part C6). Money calls never throw: whatever happens, the agent
// gets an outcome and a reason it can act on.
//   filled   the venue filled the trade (contract event `trade`), or a withdrawal was paid out
//   refused  nothing changed hands: the venue refused the fill (`trade_failed`, the input is back in the 1-click
//            balance), or the contract or the network refused the call before anything moved
//   blocked  the policy (or a check the kit makes before signing) stopped it; nothing was signed; the rule is named
//   unclear  the venue's answer couldn't be read (`trade_unclear`): kept aside under In progress, settled by hand
//   pending  sent and still settling: follow it with get_pending; never send it again
import type { PolicyCheck } from "./policy.js";

export type Outcome = "filled" | "refused" | "blocked" | "unclear" | "pending";
export const OUTCOMES: Outcome[] = ["filled", "refused", "blocked", "unclear", "pending"];

export interface MoneyResult {
  outcome: Outcome;
  reason: string;
  /** Transaction hash (look it up on nearblocks.io/txns/<tx>), or null when nothing was sent. */
  tx: string | null;
  /** "0.1 NEAR", "1,234.5 NEKO", or null. */
  amount_in: string | null;
  amount_out: string | null;
  /** The 1-click fee taken from the output, "0.0005 NEAR", or null. */
  fee: string | null;
  /** The token check's score used by the policy, or null (sells, withdrawals). */
  score: number | null;
  policy_checks: PolicyCheck[];
}

export function result(outcome: Outcome, reason: string, more: Partial<Omit<MoneyResult, "outcome" | "reason">> = {}): MoneyResult {
  return { outcome, reason, tx: more.tx ?? null, amount_in: more.amount_in ?? null, amount_out: more.amount_out ?? null, fee: more.fee ?? null, score: more.score ?? null, policy_checks: more.policy_checks ?? [] };
}

/** A check the kit makes before signing (not a policy rule): the token, the venue, the balance, the wallet's
 * gas reserve. Listed with the policy checks so a blocked result always names the exact rule. */
export const kitCheck = (rule: string, ok: boolean, detail: string): PolicyCheck => ({ rule, status: ok ? "pass" : "fail", detail });
