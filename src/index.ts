import { spawn } from "node:child_process";
import { join } from "node:path";

// The same Python bootstrap serves Actions and a standalone Devin setup command.
const child = spawn("python3", [join(__dirname, "..", "bin", "install-kast")], {
  env: process.env,
  stdio: "inherit",
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("error", () => {
  console.error("Setup Kast needs Python 3.12 or 3.13 on PATH.");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
