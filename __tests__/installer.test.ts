import * as path from "path";
import {
  InstallerDependencies,
  downloadAndCache,
  installKast,
  resolveUserPath,
  stripLeadingV,
} from "../src/installer";

describe("installer", () => {
  it("uses a cached bundle and marks action installs in the installer environment", async () => {
    const execCalls: Array<{ tool: string; args: string[]; env?: Record<string, string> }> = [];
    const deps = fakeDependencies({
      findTool: () => "/cache/kast",
      existsSync: (target) => [
        "/cache/kast/install.sh",
        "/workspace/.git",
        "/home/runner/.kast-agent/bin/kast",
      ].includes(target),
      exec: async (tool, args, options) => {
        execCalls.push({ tool, args, env: options?.env });
        return 0;
      },
    });

    const result = await installKast(
      {
        version: "v1.2.3",
        token: "token",
        installRoot: "",
        workspace: "/workspace",
        skipCopilotExtension: true,
      },
      deps,
    );

    expect(result.kastBin).toBe("/home/runner/.kast-agent/bin/kast");
    expect(execCalls[0]).toMatchObject({
      tool: "bash",
      args: ["/cache/kast/install.sh"],
    });
    expect(execCalls[0].env).toMatchObject({
      KAST_AGENT_INSTALL_ROOT: "/home/runner/.kast-agent",
      KAST_AGENT_WORKSPACE: "/workspace",
      KAST_AGENT_VERSION: "v1.2.3",
      KAST_INSTALL_SOURCE: "action",
      KAST_SKIP_COPILOT_EXTENSION: "true",
    });
    expect(execCalls[1]).toMatchObject({
      tool: "/home/runner/.kast-agent/bin/kast",
      args: ["--help"],
    });
  });

  it("downloads and caches a missing bundle by release asset name", async () => {
    const deps = fakeDependencies({
      downloadTool: async (url, _dest, auth) => {
        expect(url).toBe("https://github.com/amichne/kast/releases/download/v1.2.3/kast-headless-agent-v1.2.3-linux-x64.zip");
        expect(auth).toBe("token gh-token");
        return "/tmp/kast.zip";
      },
      extractZip: async (archivePath) => {
        expect(archivePath).toBe("/tmp/kast.zip");
        return "/tmp/extracted";
      },
      cacheDir: async (sourceDir, toolName, version) => {
        expect(sourceDir).toBe("/tmp/extracted");
        expect(toolName).toBe("kast-headless-agent");
        expect(version).toBe("1.2.3");
        return "/cache/kast";
      },
    });

    await expect(downloadAndCache("v1.2.3", "gh-token", deps)).resolves.toBe("/cache/kast");
  });

  it("normalizes versions and user paths", () => {
    expect(stripLeadingV("v1.2.3")).toBe("1.2.3");
    expect(stripLeadingV("1.2.3")).toBe("1.2.3");
    expect(resolveUserPath("~/kast", "/home/runner")).toBe(path.resolve("/home/runner/kast"));
  });
});

function fakeDependencies(
  overrides: Partial<InstallerDependencies> = {},
): InstallerDependencies {
  return {
    findTool: () => "",
    downloadTool: async () => "/tmp/kast.zip",
    extractZip: async () => "/tmp/extracted",
    cacheDir: async () => "/cache/kast",
    exec: async () => 0,
    mkdirP: async () => undefined,
    existsSync: () => true,
    homedir: () => "/home/runner",
    cwd: () => "/workspace",
    env: {
      GITHUB_WORKSPACE: "/workspace",
      SHELL: "/bin/bash",
    },
    ...overrides,
  };
}
