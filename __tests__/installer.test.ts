import * as crypto from "crypto";
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
      findTool: (toolName, version, arch) => {
        expect(toolName).toBe("kast-headless-agent");
        expect(version).toBe("1.2.3");
        expect(arch).toBe("linux-x64");
        return "/cache/kast";
      },
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

    await expect(downloadAndCache({
      version: "v1.2.3",
      token: "gh-token",
      platform: "linux-x64",
    }, deps)).resolves.toBe("/cache/kast");
  });

  it("downloads an explicit mirrored bundle, verifies sha256, and uses a sha-qualified cache key", async () => {
    const bundleBytes = Buffer.from("mirrored kast bundle");
    const bundleSha256 = crypto.createHash("sha256").update(bundleBytes).digest("hex");
    const mirrorUrl = "https://github.aexp.com/org/kast-mirror/releases/download/v1.2.3/kast-headless-agent-v1.2.3-linux-x64.zip";

    const deps = fakeDependencies({
      downloadTool: async (url, _dest, auth) => {
        expect(url).toBe(mirrorUrl);
        expect(auth).toBe("token ghes-token");
        return "/tmp/mirror.zip";
      },
      readFileSync: (target) => {
        expect(target).toBe("/tmp/mirror.zip");
        return bundleBytes;
      },
      extractZip: async (archivePath) => {
        expect(archivePath).toBe("/tmp/mirror.zip");
        return "/tmp/extracted";
      },
      cacheDir: async (sourceDir, toolName, version, arch) => {
        expect(sourceDir).toBe("/tmp/extracted");
        expect(toolName).toBe("kast-headless-agent");
        expect(version).toBe("1.2.3");
        expect(arch).toBe(`linux-x64-${bundleSha256}`);
        return "/cache/kast";
      },
      env: {
        GITHUB_SERVER_URL: "https://github.aexp.com",
      },
    });

    await expect(downloadAndCache({
      version: "v1.2.3",
      token: "ghes-token",
      platform: "linux-x64",
      bundleUrl: mirrorUrl,
      bundleSha256,
    }, deps)).resolves.toBe("/cache/kast");
  });

  it("rejects checksum failures before extraction and cache writes", async () => {
    const bundleSha256 = crypto.createHash("sha256").update("expected").digest("hex");
    const extractZip = jest.fn();
    const cacheDir = jest.fn();

    const deps = fakeDependencies({
      readFileSync: () => Buffer.from("actual"),
      extractZip,
      cacheDir,
    });

    await expect(downloadAndCache({
      version: "v1.2.3",
      token: "",
      platform: "linux-x64",
      bundleUrl: "https://github.aexp.com/org/kast-mirror/releases/download/v1.2.3/kast-headless-agent-v1.2.3-linux-x64.zip",
      bundleSha256,
    }, deps)).rejects.toThrow("Checksum mismatch");

    expect(extractZip).not.toHaveBeenCalled();
    expect(cacheDir).not.toHaveBeenCalled();
  });

  it("requires bundle-sha256 when bundle-url is set", async () => {
    await expect(downloadAndCache({
      version: "v1.2.3",
      token: "",
      platform: "linux-x64",
      bundleUrl: "https://github.aexp.com/org/kast-mirror/releases/download/v1.2.3/kast-headless-agent-v1.2.3-linux-x64.zip",
    }, fakeDependencies())).rejects.toThrow("bundle-sha256 is required");
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
    readFileSync: () => Buffer.from("bundle"),
    homedir: () => "/home/runner",
    cwd: () => "/workspace",
    env: {
      GITHUB_WORKSPACE: "/workspace",
      SHELL: "/bin/bash",
    },
    ...overrides,
  };
}
