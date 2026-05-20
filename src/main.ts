import * as core from "@actions/core";
import { installKast } from "./installer";
import { resolveVersion } from "./version";

async function run(): Promise<void> {
  try {
    const versionInput = core.getInput("version") || "latest";
    const token = core.getInput("token");
    const installRootInput = core.getInput("install-root");
    const workspaceInput = core.getInput("workspace");
    const skipCopilotExtension = core.getInput("skip-copilot-extension").toLowerCase() === "true";

    const version = await resolveVersion(versionInput, token);
    core.info(`Resolved Kast version: ${version}`);

    const result = await installKast({
      version,
      token,
      installRoot: installRootInput || "",
      workspace: workspaceInput || "",
      skipCopilotExtension,
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
