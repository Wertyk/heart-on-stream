import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prevents editor host settings from switching Electron into Node mode.
 * @param {NodeJS.ProcessEnv} environment
 * @returns {NodeJS.ProcessEnv}
 */
export function createElectronEnvironment(environment) {
  const childEnvironment = { ...environment };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  return childEnvironment;
}

// Importing the environment helper in tests must not launch a process.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const require = createRequire(import.meta.url);
  // Electron's declarations describe its app API, but Node receives a binary path.
  /** @type {unknown} */
  const electronPath = require("electron");
  if (typeof electronPath !== "string") {
    throw new Error("The Electron package did not resolve an executable path.");
  }

  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const child = spawn(electronPath, [projectRoot, ...process.argv.slice(2)], {
    cwd: projectRoot,
    env: createElectronEnvironment(process.env),
    stdio: "inherit",
  });

  child.once("error", (error) => {
    console.error("Unable to launch Electron.", error);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
