import { describe, expect, it } from "vitest";
import type { SignalFrame } from "../../src/domain/signal/index";
import {
  decodeJsonlSession,
  encodeJsonlSession,
  encodeSessionHeader,
  encodeSignalFrame,
  type JsonlSession,
  type SessionMetadata,
} from "../../src/infrastructure/replay/jsonl-session";
import {
  mapMetrics,
  mapProcessingEvent,
  mapValidationEvent,
} from "../../src/infrastructure/smartspectra/metrics-mapper";
import { decodedMetricsFixture, fixtureStartUs } from "./metrics-fixture";

const sessionMetadata: SessionMetadata = {
  appVersion: "0.1.0",
  metricConfig: "pulse-and-breathing",
  startTimeUs: fixtureStartUs,
};

function session(): JsonlSession {
  return {
    header: { format: "heart-on-stream", version: 1, ...sessionMetadata },
    frames: [
      mapProcessingEvent(3, fixtureStartUs),
      mapValidationEvent(0, fixtureStartUs, "Ready.\nOne face on camera."),
      ...mapMetrics(decodedMetricsFixture()),
    ],
  };
}

describe("JSONL session v1", () => {
  it("round trips every frame kind, preserving exact values, hints, batch boundaries and delivery order", () => {
    const original = session();
    const encoded = encodeJsonlSession(original);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.split("\n")).toHaveLength(original.frames.length + 2);
    expect(decodeJsonlSession(encoded)).toEqual(original);
  });

  it("accepts CRLF and a header-only session", () => {
    expect(
      decodeJsonlSession(
        encodeJsonlSession(session()).replaceAll("\n", "\r\n"),
      ),
    ).toEqual(session());
    expect(decodeJsonlSession(`${JSON.stringify(session().header)}\n`)).toEqual(
      {
        header: session().header,
        frames: [],
      },
    );
  });

  it.each([
    ["", /line 1: missing session header/],
    ["{\n", /line 1:/],
    ["[]\n", /line 1: expected an object/],
    ["null\n", /line 1: expected an object/],
    ["{}\n", /line 1: missing field 'format'/],
    [
      `${JSON.stringify({ ...session().header, format: "other" })}\n`,
      /line 1: unknown session format/,
    ],
    [
      `${JSON.stringify({ ...session().header, version: 3 })}\n`,
      /line 1: unsupported session version/,
    ],
    [
      `${JSON.stringify({ ...session().header, startTimeUs: "1" })}\n`,
      /line 1: 'startTimeUs' must be a finite number/,
    ],
    [
      `${JSON.stringify({ ...session().header, appVersion: null })}\n`,
      /line 1: 'appVersion' must be a string/,
    ],
    [
      `${JSON.stringify({ ...session().header, metricConfig: [] })}\n`,
      /line 1: 'metricConfig' must be a string/,
    ],
    [
      `${JSON.stringify({ ...session().header, extra: "data" })}\n`,
      /line 1: unexpected field 'extra'/,
    ],
  ])("rejects a malformed header with its line number: %s", (input, error) => {
    expect(() => decodeJsonlSession(input)).toThrow(error);
  });

  it.each([
    ["{", /line 3:/],
    ["", /line 3:/],
    ["[]", /line 3: expected an object/],
    ["null", /line 3: expected an object/],
    ['{"kind":"camera"}', /line 3: unknown frame kind/],
    [
      '{"kind":"processing","t":1,"status":"newState"}',
      /line 3: unknown 'status'/,
    ],
    [
      '{"kind":"validation","t":1,"code":"unknown","hint":""}',
      /line 3: unknown 'code'/,
    ],
    ['{"kind":"processing","status":"running"}', /line 3: missing field 't'/],
    [
      '{"kind":"talking","t":1,"detected":1,"stable":true}',
      /line 3: 'detected' must be a boolean/,
    ],
    [
      '{"kind":"processing","t":1.5,"status":"idle"}',
      /line 3: 't' must be safe integer/,
    ],
    [
      '{"kind":"pulseRate","reading":{"value":null,"confidence":90,"stable":true,"t":1}}',
      /line 3: 'value' must be a finite number/,
    ],
    [
      '{"kind":"pulseRate","reading":{"value":70,"confidence":"90","stable":true,"t":1}}',
      /line 3: 'confidence' must be a finite number/,
    ],
    ['{"kind":"pulseWave","samples":{}}', /line 3: 'samples' must be an array/],
    [
      '{"kind":"breathingWave","samples":[{"value":0.5,"stable":true}]}',
      /line 3: missing field 't'/,
    ],
    [
      '{"kind":"pulseWave","samples":[{"value":0.5,"stable":true,"t":1,"image":"data"}]}',
      /line 3: unexpected field 'image'/,
    ],
    [
      '{"kind":"processing","t":1,"status":"idle","video":[]}',
      /line 3: unexpected field 'video'/,
    ],
  ])(
    "rejects malformed frames with the correct line number: %s",
    (record, error) => {
      const prefix =
        `${JSON.stringify(session().header)}\n` +
        encodeSignalFrame({ kind: "processing", t: 1, status: "running" });
      expect(() => decodeJsonlSession(`${prefix}${record}\n`)).toThrow(error);
    },
  );

  it("detects interrupted final writes, even if the partial line is valid JSON", () => {
    expect(() =>
      decodeJsonlSession(encodeSessionHeader(sessionMetadata).trimEnd()),
    ).toThrow(/line 1: truncated/);
    const encoded = encodeJsonlSession(session());
    expect(() => decodeJsonlSession(encoded.slice(0, -1))).toThrow(
      /line 15: truncated/,
    );
    expect(() => decodeJsonlSession(encoded.slice(0, -10))).toThrow(
      /line 15: truncated/,
    );
  });

  it("rejects nonfinite numbers and extra fields before JSON serialization can hide them", () => {
    const invalidFrames = [
      {
        kind: "pulseRate",
        reading: { value: Number.NaN, confidence: 90, stable: true, t: 1 },
      },
      { kind: "processing", t: Number.POSITIVE_INFINITY, status: "idle" },
      {
        kind: "pulseWave",
        samples: [{ value: Number.NEGATIVE_INFINITY, stable: true, t: 1 }],
      },
      {
        kind: "talking",
        t: 1,
        detected: false,
        stable: true,
        image: new Uint8Array([1, 2]),
      },
    ];
    for (const frame of invalidFrames) {
      expect(() => encodeSignalFrame(frame as SignalFrame)).toThrow(/line 2:/);
    }
    expect(() =>
      encodeSessionHeader({ ...sessionMetadata, startTimeUs: Number.NaN }),
    ).toThrow(/line 1:/);
  });
});

describe("JSONL session v2", () => {
  const capture = { kind: "capture", t: 10, state: "paused" } as const;
  const drain = { kind: "drain" } as const;
  const end = { kind: "end", durationUs: 20 } as const;
  const header = encodeSessionHeader(sessionMetadata);

  it("round trips capture boundaries and the final duration alongside SDK frames", () => {
    const original: JsonlSession = {
      header: { ...session().header, version: 2 },
      frames: [
        ...session().frames,
        capture,
        { kind: "capture", t: 20, state: "resumed" },
        end,
      ],
    };
    expect(decodeJsonlSession(encodeJsonlSession(original))).toEqual(original);
    expect(decodeJsonlSession(header)).toEqual({
      header: original.header,
      frames: [],
    });
  });

  it("round trips a drain boundary before tail frames and an optional end", () => {
    for (const footer of [[], [end]]) {
      const original: JsonlSession = {
        header: { ...session().header, version: 2 },
        frames: [capture, drain, ...session().frames, ...footer],
      };
      expect(decodeJsonlSession(encodeJsonlSession(original))).toEqual(
        original,
      );
    }
  });

  it.each([capture, drain, end])("rejects %j under a v1 header", (record) => {
    expect(() =>
      decodeJsonlSession(
        `${JSON.stringify(session().header)}\n${encodeSignalFrame(record)}`,
      ),
    ).toThrow("line 2: unknown frame kind");
    expect(() =>
      encodeJsonlSession({ ...session(), frames: [record] }),
    ).toThrow("line 2: unknown frame kind");
  });

  it.each([
    ['{"kind":"capture","t":1,"state":"running"}', "unknown 'state'"],
    [
      '{"kind":"capture","t":1,"state":"paused","status":"idle"}',
      "unexpected field 'status'",
    ],
    ['{"kind":"end","durationUs":-1}', "'durationUs' must be nonnegative"],
    ['{"kind":"end","durationUs":1.5}', "'durationUs' must be safe integer"],
    ['{"kind":"drain","t":1}', "unexpected field 't'"],
  ])("validates v2 fields in %s", (record, reason) => {
    expect(() => decodeJsonlSession(`${header}${record}\n`)).toThrow(
      `line 2: ${reason}`,
    );
  });

  it.each([
    [[drain, drain], "line 3: duplicate drain boundary"],
    [[drain, capture], "line 3: capture record after drain boundary"],
    [[end, drain], "line 2: end record must be last"],
  ] as const)("rejects misplaced records %j", (frames, reason) => {
    const lines = frames.map((frame) => JSON.stringify(frame)).join("\n");
    expect(() => decodeJsonlSession(`${header}${lines}\n`)).toThrow(reason);
    expect(() =>
      encodeJsonlSession({
        header: { ...session().header, version: 2 },
        frames,
      }),
    ).toThrow(reason);
  });

  it("requires the end record to be last in the file", () => {
    expect(() =>
      decodeJsonlSession(
        header + encodeSignalFrame(end) + encodeSignalFrame(capture),
      ),
    ).toThrow("line 2: end record must be last");
    expect(() =>
      encodeJsonlSession({
        header: { ...session().header, version: 2 },
        frames: [end, capture],
      }),
    ).toThrow("line 2: end record must be last");
  });
});
