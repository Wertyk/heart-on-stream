import { describe, expect, it } from "vitest";
import { createElectronEnvironment } from "../scripts/launch.mjs";

describe("Electron child environment", () => {
  it.each(["1", "0", ""])(
    "removes ELECTRON_RUN_AS_NODE when its value is %j",
    (value) => {
      const environment = createElectronEnvironment({
        ELECTRON_RUN_AS_NODE: value,
      });
      expect(environment).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    },
  );

  it("preserves all other environment entries", () => {
    const environment = {
      PATH: "/usr/bin",
      ELECTRON_ENABLE_LOGGING: "1",
      EMPTY: "",
      UNSET: undefined,
    };
    expect(createElectronEnvironment(environment)).toEqual(environment);
  });

  it("returns a new environment without mutating its input", () => {
    const environment = Object.freeze({
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "/usr/bin",
    });

    const childEnvironment = createElectronEnvironment(environment);

    expect(childEnvironment).not.toBe(environment);
    expect(childEnvironment).toEqual({ PATH: "/usr/bin" });
    expect(environment).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "/usr/bin",
    });
  });
});
