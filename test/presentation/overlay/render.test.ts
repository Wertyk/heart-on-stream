import { describe, expect, it } from "vitest";
import { replayBadgeTextPosition } from "../../../src/presentation/overlay/render";

describe("REPLAY badge text layout", () => {
  it.each([
    { width: 43.5, ascent: 9, descent: 0, x: 35.25, baselineY: 16.5 },
    { width: 60, ascent: 12, descent: 4, x: 27, baselineY: 16 },
  ])(
    "centers text with measured width $width and descent $descent",
    ({ width, ascent, descent, x, baselineY }) => {
      expect(
        replayBadgeTextPosition({
          width,
          actualBoundingBoxAscent: ascent,
          actualBoundingBoxDescent: descent,
        }),
      ).toEqual({ x, baselineY });
    },
  );
});
