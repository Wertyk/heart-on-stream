import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkArchitecture, type ProjectFile } from "./architecture/checker";
import { importForms, ruleFixtures } from "./architecture/fixtures";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(directory: string): ProjectFile[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(file);
      return /\.[cm]?[jt]sx?$/.test(entry.name)
        ? [{ file, source: readFileSync(file, "utf8") }]
        : [];
    });
}

describe("Clean Architecture", () => {
  it("enforces every dependency rule across src/", () => {
    expect(
      checkArchitecture(projectRoot, sourceFiles(join(projectRoot, "src"))),
    ).toEqual([]);
  });

  describe.each(ruleFixtures)("$ruleId", ({ ruleId, bad, allowed }) => {
    it("reports its deliberately bad fixture with the file and specifier", () => {
      expect(checkArchitecture(projectRoot, [bad])).toContainEqual({
        file: bad.file,
        specifier: expect.any(String),
        ruleId,
      });
    });

    it("accepts its allowed fixture", () => {
      expect(checkArchitecture(projectRoot, [allowed])).toEqual([]);
    });
  });

  describe.each([
    ["domain-only", "src/domain/value.ts", "../application/dto"],
    [
      "application-inward",
      "src/application/value.ts",
      "../shared/ipc-contract",
    ],
    [
      "presentation-boundary",
      "src/presentation/value.ts",
      "../application/use-cases",
    ],
    [
      "infrastructure-composition-only",
      "src/main/main.ts",
      "../infrastructure/obs",
    ],
    [
      "core-no-platform",
      "src/domain/value.ts",
      "@smartspectra/node-sdk/renderer",
    ],
  ])("%s import syntax", (ruleId, file, specifier) => {
    it.each(importForms)("understands %s", (_name, source) => {
      expect(
        checkArchitecture(projectRoot, [{ file, source: source(specifier) }]),
      ).toContainEqual({ file, specifier, ruleId });
    });
  });

  it.each(["domain", "application"])(
    "blocks each platform dependency in %s, including subpaths",
    (layer) => {
      for (const specifier of [
        "electron",
        "electron/main",
        "ws",
        "ws/wrapper",
        "obs-websocket-js",
        "obs-websocket-js/json",
        "@smartspectra/node-sdk",
        "@smartspectra/node-sdk/messages",
        "@smartspectra/other-package",
        "node:fs",
        "node:fs/promises",
        "node:path",
      ]) {
        expect(
          checkArchitecture(projectRoot, [
            { file: `src/${layer}/value.ts`, source: `import "${specifier}";` },
          ]),
        ).toContainEqual({
          file: `src/${layer}/value.ts`,
          specifier,
          ruleId: "core-no-platform",
        });
      }
    },
  );

  it.each(["node:fs", "arbitrary-package", "../../outside"])(
    "blocks %s outside both core layers",
    (specifier) => {
      for (const [layer, ruleId] of [
        ["domain", "domain-only"],
        ["application", "application-inward"],
      ]) {
        expect(
          checkArchitecture(projectRoot, [
            { file: `src/${layer}/value.ts`, source: `import "${specifier}";` },
          ]),
        ).toContainEqual({
          file: `src/${layer}/value.ts`,
          specifier,
          ruleId,
        });
      }
    },
  );

  it("blocks both forbidden presentation targets", () => {
    const file = "src/presentation/panel/view.ts";
    for (const specifier of [
      "../../infrastructure/overlay/index",
      "../../application/use-cases/ingest",
    ]) {
      expect(
        checkArchitecture(projectRoot, [
          { file, source: `import '${specifier}'` },
        ]),
      ).toContainEqual({ file, specifier, ruleId: "presentation-boundary" });
    }
  });

  it.each(["src/main/composition-root.ts", "src/renderer/composition.ts"])(
    "allows infrastructure imports in %s",
    (file) => {
      expect(
        checkArchitecture(projectRoot, [
          { file, source: 'import "../infrastructure/smartspectra";' },
        ]),
      ).toEqual([]);
    },
  );

  it.each(importForms)(
    "allows infrastructure helpers across adapter directories with %s",
    (_name, source) => {
      expect(
        checkArchitecture(projectRoot, [
          {
            file: "src/infrastructure/smartspectra/sdk-host.ts",
            source: source("../replay/helper"),
          },
        ]),
      ).toEqual([]);
    },
  );

  it.each([
    "src/main/main.ts",
    "src/preload/preload.ts",
    "src/renderer/other.ts",
    "src/infrastructure-extra/adapter.ts",
    "src/main/nested/composition-root.ts",
  ])("does not grant composition privileges to %s", (file) => {
    const specifier = "../infrastructure/obs";
    // Normalization must not let a similarly named file evade the rule.
    const source = file.includes("nested")
      ? 'import "../../infrastructure/obs";'
      : `import "${specifier}";`;
    expect(checkArchitecture(projectRoot, [{ file, source }])).toContainEqual({
      file,
      specifier: file.includes("nested")
        ? "../../infrastructure/obs"
        : specifier,
      ruleId: "infrastructure-composition-only",
    });
  });

  it("resolves normalized, absolute input paths and directory index imports", () => {
    expect(
      checkArchitecture(projectRoot, [
        {
          file: resolve(projectRoot, "src/domain/inner/../value.ts"),
          source: 'export * from "../domain/../infrastructure/obs/index.js";',
        },
      ]),
    ).toEqual([
      {
        file: "src/domain/value.ts",
        specifier: "../domain/../infrastructure/obs/index.js",
        ruleId: "domain-only",
      },
      {
        file: "src/domain/value.ts",
        specifier: "../domain/../infrastructure/obs/index.js",
        ruleId: "infrastructure-composition-only",
      },
    ]);
  });

  it("does not mistake a layer name prefix for that layer", () => {
    expect(
      checkArchitecture(projectRoot, [
        { file: "src/domain-extra/x.ts", source: 'import "node:fs";' },
        {
          file: "src/domain/x.ts",
          source: 'import "../domain-extra/x";',
        },
      ]),
    ).toEqual([
      {
        file: "src/domain/x.ts",
        specifier: "../domain-extra/x",
        ruleId: "domain-only",
      },
    ]);
  });

  it("ignores import-looking text and property calls", () => {
    const source = [
      '// import "electron";',
      '/* export * from "ws"; */',
      `const text = 'require("node:fs")';`,
      'const template = `import("node:path")`;',
      'const pattern = /require("electron")/;',
      'const ratio = value / total; obj.require("ws"); obj.import("electron");',
    ].join("\n");
    expect(
      checkArchitecture(projectRoot, [{ file: "src/domain/value.ts", source }]),
    ).toEqual([]);
  });

  it("still scans template expressions, including nested templates", () => {
    const file = "src/domain/value.ts";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This is source text for the lexer, never executed.
    const source = 'const text = `prefix ${`nested ${import("node:fs")}`}`;';
    expect(checkArchitecture(projectRoot, [{ file, source }])).toContainEqual({
      file,
      specifier: "node:fs",
      ruleId: "core-no-platform",
    });
  });

  it.each(["++", "--"])(
    "does not let division after postfix %s hide a later dependency",
    (operator) => {
      const file = "src/domain/value.ts";
      const source = `const ratio = count${operator} / total; import("node:fs");`;
      expect(checkArchitecture(projectRoot, [{ file, source }])).toContainEqual(
        {
          file,
          specifier: "node:fs",
          ruleId: "core-no-platform",
        },
      );
    },
  );

  it("decodes escaped literal specifiers without executing source", () => {
    const file = "src/domain/value.ts";
    const source = String.raw`import "elect\u0072on"; require('w\x73');`;
    const violations = checkArchitecture(projectRoot, [{ file, source }]);
    for (const specifier of ["electron", "ws"]) {
      expect(violations).toContainEqual({
        file,
        specifier,
        ruleId: "core-no-platform",
      });
    }
  });

  it("does not scan files outside src and does not mutate its inputs", () => {
    const fixture = Object.freeze({
      file: "test/domain/value.ts",
      source: 'import "node:fs";',
    });
    expect(checkArchitecture(projectRoot, Object.freeze([fixture]))).toEqual(
      [],
    );
    expect(fixture.source).toBe('import "node:fs";');
  });
});
