import { createHash } from "node:crypto";

/**
 * Stable logical delivery identity per briefing, local reporting date and
 * recipient. Retries of the same prepared message must reuse this key; it is
 * never derived from a per-run ID. The recipient is hashed so it is not
 * exposed in provider dashboards or logs.
 */
export function deliveryKey(briefingId: string, reportingDate: string, recipient: string): string {
  const recipientHash = createHash("sha256").update(recipient.trim().toLowerCase()).digest("hex").slice(0, 16);
  return `${briefingId}/${reportingDate}/${recipientHash}`;
}
