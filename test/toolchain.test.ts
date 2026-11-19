import { describe, expect, it } from "vitest";
import packageJson from "../package.json";

describe("reproducible toolchain", () => {
  describe.each(["dependencies", "devDependencies"] as const)(
    "%s",
    (section) => {
      it.each(Object.entries(packageJson[section]))(
        "pins %s to an exact version",
        (_name, version) => {
          expect(version).toMatch(
            /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/,
          );
        },
      );
    },
  );

  it("pins the package manager used for frozen installs", () => {
    expect(packageJson.packageManager).toBe("pnpm@12.21.0");
  });

  it("keeps the SmartSpectra SDK as a pinned runtime dependency", () => {
    expect(packageJson.dependencies["@smartspectra/node-sdk"]).toBe("3.5.0");
  });
});
