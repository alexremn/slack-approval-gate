import { createHash } from "node:crypto";

// Button value: a short per-gate id plus the gate's deadline (epoch ms), so a
// gate receiving another gate's click can tell an expired button from a live one.
export function mintActionId(seed: string, deadlineMs: number): string {
  const id = createHash("sha1").update(seed).digest("hex").slice(0, 16);
  return `${id}.${deadlineMs}`;
}

export function isExpiredActionId(id: string, now = Date.now()): boolean {
  const dot = id.indexOf(".");
  if (dot < 0) return false;
  const deadline = Number(id.slice(dot + 1));
  return Number.isSafeInteger(deadline) && deadline > 0 && now > deadline;
}
