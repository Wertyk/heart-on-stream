import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("./tune-report.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  write: false,
});
const source = Buffer.from(outputFiles[0].contents).toString("base64");
const { runTune } = await import(`data:text/javascript;base64,${source}`);
process.exitCode = runTune(process.argv.slice(2));
