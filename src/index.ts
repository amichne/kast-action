import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";

const child = spawn("python3", ["-I", join(__dirname, "..", "bin", "install-kast")], {
  detached: true,
  env: process.env,
  stdio: "inherit",
});

function forward(signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("error", () => {
  console.error("Setup Kast needs Python 3.12 or 3.13 on PATH.");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === null ? 1 : 128 + constants.signals[signal]);
});
