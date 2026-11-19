import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = join(projectRoot, "dist");
const sharedOptions = {
  absWorkingDir: projectRoot,
  bundle: true,
  sourcemap: true,
  logLevel: "info",
};

await rm(outputRoot, { recursive: true, force: true });

await Promise.all([
  build({
    ...sharedOptions,
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main/main.cjs",
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron", "@smartspectra/*", "koffi"],
  }),
  build({
    ...sharedOptions,
    entryPoints: ["src/preload/preload.ts"],
    outfile: "dist/preload/preload.cjs",
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
  }),
  build({
    ...sharedOptions,
    entryPoints: ["src/renderer/composition.ts"],
    outfile: "dist/renderer/composition.js",
    platform: "browser",
    format: "esm",
    target: "es2022",
  }),
  build({
    ...sharedOptions,
    entryPoints: ["src/presentation/overlay/overlay.ts"],
    outfile: "dist/presentation/overlay/overlay.js",
    platform: "browser",
    format: "esm",
    target: "es2022",
  }),
]);

await Promise.all(
  ["panel", "overlay"].map(async (page) => {
    const relativePath = join("presentation", page, "index.html");
    const destination = join(outputRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(projectRoot, "src", relativePath), destination);
  }),
);

await copyFile(
  join(projectRoot, "src/presentation/panel/panel.css"),
  join(outputRoot, "presentation/panel/panel.css"),
);
