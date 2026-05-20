import { normalizeVersion, resolveVersion } from "../src/version";

describe("version resolution", () => {
  it("normalizes pinned versions with a leading v", async () => {
    await expect(resolveVersion("1.2.3", "")).resolves.toBe("v1.2.3");
    expect(normalizeVersion("v1.2.3")).toBe("v1.2.3");
  });
});
