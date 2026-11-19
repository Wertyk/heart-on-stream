import type { ArchitectureRuleId, ProjectFile } from "./checker";

/** In-memory fixtures keep deliberately invalid dependencies out of tsc/Biome. */
export interface RuleFixture {
  readonly ruleId: ArchitectureRuleId;
  readonly bad: ProjectFile;
  readonly allowed: ProjectFile;
}

export const ruleFixtures: readonly RuleFixture[] = [
  {
    ruleId: "domain-only",
    bad: {
      file: "src/domain/bad.ts",
      source: 'import type { PanelState } from "../application/dto";',
    },
    allowed: {
      file: "src/domain/session/policy.ts",
      source: 'import type { Reading } from "../signal/index";',
    },
  },
  {
    ruleId: "application-inward",
    bad: {
      file: "src/application/bad.ts",
      source: 'export * from "../shared/ipc-contract";',
    },
    allowed: {
      file: "src/application/use-cases/ingest.ts",
      source:
        'import type { Reading } from "../../domain/signal"; export * from "../dto";',
    },
  },
  {
    ruleId: "presentation-boundary",
    bad: {
      file: "src/presentation/panel/bad.ts",
      source: 'const useCases = import("../../application/use-cases");',
    },
    allowed: {
      file: "src/presentation/panel/panel.ts",
      source: [
        'import type { PanelState } from "../../application/dto";',
        'import type { HeartBridge } from "../../shared/ipc-contract";',
        'import "../../preload/preload";',
      ].join("\n"),
    },
  },
  {
    ruleId: "infrastructure-composition-only",
    bad: {
      file: "src/main/main.ts",
      source: 'const adapter = require("../infrastructure/obs");',
    },
    allowed: {
      file: "src/infrastructure/smartspectra/sdk-host.ts",
      source: 'import { mapMetrics } from "./metrics-mapper";',
    },
  },
  {
    ruleId: "core-no-platform",
    bad: {
      file: "src/application/ports/bad.ts",
      source: 'import type { BrowserWindow } from "electron";',
    },
    allowed: {
      file: "src/preload/preload.ts",
      source: 'import { contextBridge } from "electron";',
    },
  },
];

/** Each syntax is checked against every rule, rather than only one happy path. */
export const importForms = [
  ["static named", (path: string) => `import { Value } from "${path}";`],
  ["static default", (path: string) => `import Value from '${path}';`],
  ["side effect", (path: string) => `import "${path}";`],
  ["namespace", (path: string) => `import * as Value from "${path}";`],
  ["type only", (path: string) => `import type { Value } from "${path}";`],
  ["inline type", (path: string) => `import { type Value } from "${path}";`],
  ["re-export", (path: string) => `export { Value } from "${path}";`],
  ["star re-export", (path: string) => `export * from "${path}";`],
  ["type re-export", (path: string) => `export type { Value } from "${path}";`],
  ["dynamic import", (path: string) => `const value = import("${path}");`],
  [
    "dynamic import options",
    (path: string) => `import("${path}", { with: { type: "json" } });`,
  ],
  [
    "import type expression",
    (path: string) => `type Value = import("${path}").V;`,
  ],
  ["require", (path: string) => `const value = require('${path}');`],
  ["import assignment", (path: string) => `import value = require("${path}");`],
  [
    "multiline with comments",
    (path: string) => `import /* comment */ {\n type Value,\n} from\n"${path}"`,
  ],
] as const;
