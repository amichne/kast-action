"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const node_path_1 = require("node:path");
// The same Python bootstrap serves Actions and a standalone Devin setup command.
const child = (0, node_child_process_1.spawn)("python3", [(0, node_path_1.join)(__dirname, "..", "bin", "install-kast")], {
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
