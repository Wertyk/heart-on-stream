# Recorded sessions

Heart on Stream session files contain normalized numeric signal and status data
for deterministic replay. Recording requires explicit opt-in: constructing a
`JsonlSessionRecorder` creates nothing, and `append()` rejects until `start()`.
No images, camera frames, video, or SDK protobuf buffers belong in this format.

## JSONL format v1

UTF-8 text, one JSON object per line, with a required final newline. Writers use
LF; readers also accept CRLF. The first line is a header:

```jsonl
{"format":"heart-on-stream","version":1,"appVersion":"0.1.0","metricConfig":"pulse-and-breathing","startTimeUs":1794873600000000}
```

`format` and `version` identify the schema. `appVersion` is the producing app's
version; `metricConfig` is the caller's label for the selected SDK metric set.
`startTimeUs` is the session start as integer microseconds since the Unix epoch.
It is metadata, not an offset to add to frame timestamps. A header-only file is
a valid empty recording.

Every subsequent line is one domain `SignalFrame`. All supported shapes are
shown here (timestamps abbreviated for readability):

```jsonl
{"kind":"pulseRate","reading":{"value":72.5,"confidence":87.5,"stable":true,"t":1000000}}
{"kind":"pulseWave","samples":[{"value":0.25,"stable":true,"t":1000000},{"value":0.5,"stable":true,"t":1033000}]}
{"kind":"breathingRate","reading":{"value":14.5,"confidence":80,"stable":true,"t":1000000}}
{"kind":"breathingWave","samples":[{"value":-0.5,"stable":true,"t":1000000}]}
{"kind":"talking","t":1000000,"detected":false,"stable":true}
{"kind":"validation","t":1000000,"code":"ok","hint":"Ready."}
{"kind":"processing","t":1000000,"status":"running"}
```

Pulse rates use BPM; breathing rates use breaths/min. Confidence retains the SDK's
0–100 scale. Wave amplitudes are raw, uncalibrated waveform values, with stability
and individual sample timestamps; they contain no confidence field. Every `t` is
an absolute epoch-microsecond timestamp, including the host-supplied Clock time
for processing events. Hints are preserved verbatim and JSON-escaped onto one
physical line. Numeric values must be finite; timestamps must also be safe
integers so JavaScript can preserve them exactly.

Validation codes are `ok`, `noFaceFound`, `multipleFacesFound`, `faceNotCentered`,
`faceSizeOutOfRange`, `tooDark`, `tooBright`, `chestNotVisible`, `cameraTuning`,
`frameRateTooLow`, `excessiveMotion`, `faceTooClose`, `faceTooFar`, `faceTooHigh`,
`faceTooLow`, and `faceNotForward`. Processing states are `uninitialized`, `idle`,
`starting`, `running`, `stopping`, and `error`.

All v1 processing states describe SDK lifecycle events. This includes
`uninitialized` at startup or shutdown. Version 1 has no capture boundaries or
final duration record.

## JSONL format v2

New recordings use `"version":2` in the header. All v1 SDK frames retain their
shape and meaning. Version 2 adds these records:

```jsonl
{"kind":"capture","t":43000000,"state":"paused"}
{"kind":"capture","t":200000000,"state":"resumed"}
{"kind":"drain"}
{"kind":"end","durationUs":201000000}
```

The app writes a `capture` record when the streamer pauses, when the app
auto-pauses, and on Resume. The `t` field uses epoch microseconds from the host
clock (abbreviated above). Live mode, replay, and `pnpm tune` freeze the
measurement clock until fresh input after Resume, preserving the baseline
across the gap.

A finalized recording with a measurement timeline has an `end` record on its
last line. Selecting Off writes the `end` record before closing the file.
SDK frames delivered during shutdown after Off are discarded.

`durationUs` is the nonnegative integer elapsed time from the measurement
origin, used for session-based chapter export. It includes a trailing capture
gap even if no frame arrives after Resume. Replay schedules the footer from
the measurement origin, which can differ from the playback origin when the
first record is a capture boundary or the first wave arrives as a batch. Replay
and tune leave the measurement clock at the last input. Without an end record,
duration comes from the measurement timeline. Readers accept both versions.

Live End writes `{"kind":"drain"}` as soon as draining starts, before any
SDK shutdown frame. The optional boundary has only the `kind` field and may
appear once in a v2 file, anywhere after the header and before the `end` record
if present. Only SDK frames and the final `end` record may follow it. The
boundary uses delivery order, so it also covers late measurements whose
timestamps predate End.

Replay and `pnpm tune` use only the frames before the boundary for spike
detection. Replay also uses only those frames for publishing readings. The
drained frames remain in the file, and the `end` duration includes their
timing. If live received its first timestamped frame during drain, replay uses
the first drained timestamp as the origin for scheduling the footer. Version 1
and version 2 recordings without a drain boundary retain their original
playback behavior.

## SDK mapping and recording

The pure SDK mapper maps an unknown numeric validation code to `noFaceFound`
(a non-OK condition) and an unknown numeric processing status to `error`. The
SDK hint remains unchanged. Missing protobuf scalars use protobuf defaults;
missing or empty metric arrays emit nothing. Number, bigint and protobuf Long
timestamps normalize to safe integer numbers; nonfinite or imprecise values
raise an error. Each SDK slice is merged chronologically across the five mapped
channels. At equal timestamps, talking comes first so a stable detection can
raise the spike threshold for the pulse reading at that time. Pulse rate, pulse
wave, breathing rate, and breathing wave follow in that order. Adjacent waveform
measurements are batched without crossing interleaved channels. Every measurement
is retained and no history is accumulated. The mapper reads
`cardio.arterialPressureTrace` and `breathing.upperTrace` for waveforms.

Recordings preserve append order and waveform batch boundaries. Second-face
intervals carry no biometric records or waveform samples. Validation, processing
and session boundaries stay in the file. If a late waveform batch spans an
interval boundary, samples outside the interval are kept. The
codec in `src/infrastructure/replay/jsonl-session.ts` provides
`encodeJsonlSession`, `decodeJsonlSession`, `encodeSessionHeader` and
`encodeSignalFrame`. Readers and writers reject unknown fields, wrong types,
unknown frame kinds/status names, unsupported headers, and invalid numbers.
Decode errors include the one-based line number. Blank lines are invalid.
A missing final newline flags a truncated final write, even when that line's
JSON happens to parse. Neither version has a checksum. A complete final line
can be removed without causing a decode error.

`JsonlSessionRecorder(outputDirectory, { appVersion, metricConfig, startTimeUs })`
implements the `SessionRecorder` port. `start()` creates the output directory if
needed and an exclusive `session-<UTC timestamp>-<random UUID>.jsonl` file with
its header. Duplicate starts reject. Appends are validated and snapshotted
before queueing, and all I/O runs in invocation order. After an end record,
further appends reject. `stop()` flushes and closes and is idempotent. After
stopping, another `start()` creates a new file using the same
metadata; use a new instance for new session metadata. A write failure rejects
and blocks further appends until stop/restart. `deleteAll()` first stops and then
removes only files created by that recorder instance, preserving unrelated files
and other instances' recordings. I/O errors reject to the caller for reporting.

## Reference live recordings

These sessions were recorded by the project owner with the opt-in `--record`
flag (Electron 45.3.3, `@smartspectra/node-sdk` 3.5.0, MacBook Pro Camera at
30 fps, macOS). They contain only the numeric and status frames described above:
no images, video or SDK buffers. They are shared with the owner's consent for
replay, tests and threshold calibration. Readings are camera-based estimates for
wellness and entertainment use, not medical data.

| File                                      | Metric config         | Length | What happens                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | --------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-a-framing-talking.jsonl`            | (a) pulse             | 318 s  | ~85 s of framing hints (`faceTooLow`, `chestNotVisible`), then calm sitting with some talking                                                                                                                                                                                                                                                                                                                                |
| `live-b-calm.jsonl`                       | (b) pulse + breathing | 145 s  | Calm sitting                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `live-b-calm-obs-shared-camera.jsonl`     | (b) pulse + breathing | 149 s  | Calm sitting while OBS captures the same physical camera; steady 30 fps with the app window in front and behind OBS                                                                                                                                                                                                                                                                                                          |
| `live-b-exertion-talking.jsonl`           | (b) pulse + breathing | 203 s  | Baseline, 20 squats in frame (`excessiveMotion` 127–149 s), seated recovery, then talking                                                                                                                                                                                                                                                                                                                                    |
| `live-b-exertion-recovery.jsonl`          | (b) pulse + breathing | 951 s  | Calm baseline with repeated `chestNotVisible` while the laptop camera looked up at the owner, several manual pauses, a second face from a phone photo (`multipleFacesFound` around 465–476 s), about 45 s of in-frame exertion (intermittent `excessiveMotion` around 513–569 s), and a still recovery. The rise held for 3.9 s and produced zero spikes under the old 5 s rule. The 3 s rule produces one spike at 745.8 s. |
| `live-b-exertion-strong.jsonl`            | (b) pulse + breathing | 211 s  | Quiet baseline, ~30 s of intense exercise (paused 79–112 s), then still mouth-closed recovery. The calibrated policy detects one spike (+22 BPM) at 207.9 s.                                                                                                                                                                                                                                                                 |
| `live-b-virtual-camera-placeholder.jsonl` | (b) pulse + breathing | 439 s  | OBS Virtual Camera selected while it was stopped: the placeholder image gives `tooDark` throughout and no readings                                                                                                                                                                                                                                                                                                           |

Replay any of them with `pnpm replay -- samples/<file>`.

Camera-based pulse estimates are noisy after exertion, so the policy confirms a
rise after 3 s above threshold. The longest above-threshold run in a calm
reference recording was about 1.1 s.

The synthetic fixture in `test/infrastructure/metrics-fixture.ts` was authored
against the installed SDK's message type declarations. Tests encode it with
`Metrics.encode()` and decode with `decodeMetrics()`; no live camera, key, network
call, or Presage sample code is used.
