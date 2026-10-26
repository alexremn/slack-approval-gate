import { mintActionId, isExpiredActionId } from "../src/action-id";

describe("action-id", () => {
  it("mints a short stable id for a seed, suffixed with the deadline", () => {
    const id = mintActionId("seed-value", 1700000000000);
    expect(id).toMatch(/^[a-f0-9]{16}\.1700000000000$/);
    expect(mintActionId("seed-value", 1700000000000)).toBe(id);
  });

  it("mints different ids for different seeds", () => {
    expect(mintActionId("a", 1)).not.toBe(mintActionId("b", 1));
  });

  it("is expired once the deadline has passed", () => {
    expect(isExpiredActionId(mintActionId("x", 1000), 1001)).toBe(true);
  });

  it("is not expired before or at the deadline", () => {
    expect(isExpiredActionId(mintActionId("x", 1000), 999)).toBe(false);
    expect(isExpiredActionId(mintActionId("x", 1000), 1000)).toBe(false);
  });

  it.each([
    ["legacy id without a deadline", "a1b2c3d4e5f6a7b8"],
    ["empty deadline", "a1b2c3d4e5f6a7b8."],
    ["non-numeric deadline", "a1b2c3d4e5f6a7b8.soon"],
    ["fractional deadline", "a1b2c3d4e5f6a7b8.1.5"],
  ])("never treats a %s as expired", (_label, id) => {
    expect(isExpiredActionId(id, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
