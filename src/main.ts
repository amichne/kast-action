import * as core from "@actions/core";
import { installKast } from "./installer";
import { resolveActionVersion } from "./version";

async function run(): Promise<void> {
  try {
    const versionInput = core.getInput("version") || "latest";
    const platformInput = core.getInput("platform") || "linux-x64";
    const bundleUrlInput = core.getInput("bundle-url");
    const bundleSha256Input = core.getInput("bundle-sha256");
    const token = core.getInput("token");
    const installRootInput = core.getInput("install-root");
    const workspaceInput = core.getInput("workspace");
    const skipCopilotExtension = core.getInput("skip-copilot-extension").toLowerCase() === "true";

    const version = await resolveActionVersion(versionInput, token, bundleUrlInput);
    core.info(`Resolved Kast version: ${version}`);

    const result = await installKast({
      version,
      token,
      installRoot: installRootInput || "",
      workspace: workspaceInput || "",
      skipCopilotExtension,
      platform: platformInput,
      bundleUrl: bundleUrlInput,
      bundleSha256: bundleSha256Input,
    });

    core.setOutput("version", version);
    core.setOutput("install-root", result.installRoot);
    core.setOutput("kast-bin", result.kastBin);

    core.addPath(result.binDir);
    core.exportVariable("KAST_CONFIG_HOME", result.configHome);
    core.exportVariable("KAST_INSTALL_ROOT", result.installRoot);
    core.exportVariable("KAST_MANAGED_ROOT", result.installRoot);

    core.info(`Kast ${version} installed successfully at ${result.installRoot}`);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : "An unexpected error occurred");
  }
}

void run();
