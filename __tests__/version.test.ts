import * as github from "@actions/github";
import { normalizeVersion, resolveActionVersion, resolveVersion } from "../src/version";

jest.mock("@actions/github", () => ({
  getOctokit: jest.fn(),
}));

describe("version resolution", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("normalizes pinned versions with a leading v", async () => {
    await expect(resolveVersion("1.2.3", "")).resolves.toBe("v1.2.3");
    expect(normalizeVersion("v1.2.3")).toBe("v1.2.3");
  });

  it("does not query GitHub.com release metadata when bundle-url is set", async () => {
    await expect(resolveActionVersion(
      "1.2.3",
      "token",
      "https://github.aexp.com/org/kast-mirror/releases/download/v1.2.3/kast-headless-agent-v1.2.3-linux-x64.zip",
    )).resolves.toBe("v1.2.3");

    expect(github.getOctokit).not.toHaveBeenCalled();
  });

  it("rejects latest with bundle-url without querying GitHub.com release metadata", async () => {
    await expect(resolveActionVersion(
      "latest",
      "token",
      "https://github.aexp.com/org/kast-mirror/releases/download/v1.2.3/kast-headless-agent-v1.2.3-linux-x64.zip",
    )).rejects.toThrow("bundle-url requires a pinned Kast version");

    expect(github.getOctokit).not.toHaveBeenCalled();
  });
});
