import type { SignalFrame, WaveSample } from "../../../src/domain/signal/index";
import { encodeJsonlSession } from "../../../src/infrastructure/replay/jsonl-session";

/** Invented, deterministic development data; never a person's recording. */
export function generateSyntheticSession(): string {
  const epoch = 1_794_873_600_000_000;
  const at = (seconds: number): number =>
    epoch + Math.round(seconds * 1_000_000);
  const round = (value: number): number => Math.round(value * 10_000) / 10_000;
  const frames: SignalFrame[] = [
    { kind: "processing", status: "running", t: epoch },
  ];
  let pulsePhase = 0;
  let breathPhase = 0;
  for (let second = 0; second <= 120; second++) {
    const spike = second >= 85 && second < 105;
    const pulse = (spike ? 88 : 70) + ([0, 0.2, 0, -0.2][second % 4] ?? 0);
    const breathing = spike ? 18 : 14;
    const reading = (value: number) => ({
      value,
      confidence: 95,
      stable: true,
      t: at(second),
    });
    frames.push(
      {
        kind: "validation",
        code: "ok",
        hint: "Synthetic development signal",
        t: at(second),
      },
      { kind: "talking", detected: false, stable: true, t: at(second) },
      { kind: "pulseRate", reading: reading(pulse) },
      { kind: "breathingRate", reading: reading(breathing) },
    );
    const pulseSamples: WaveSample[] = [];
    const breathSamples: WaveSample[] = [];
    for (let sample = second === 0 ? 8 : 1; sample <= 8; sample++) {
      if (second > 0) pulsePhase += pulse / 60 / 8;
      const t = at(second === 0 ? 0 : second - 1 + sample / 8);
      pulseSamples.push({
        value: round(Math.sin(2 * Math.PI * pulsePhase)),
        stable: true,
        t,
      });
      if (sample % 2 === 0) {
        if (second > 0) breathPhase += breathing / 60 / 4;
        breathSamples.push({
          value: round(Math.sin(2 * Math.PI * breathPhase)),
          stable: true,
          t,
        });
      }
    }
    frames.push(
      { kind: "pulseWave", samples: pulseSamples },
      { kind: "breathingWave", samples: breathSamples },
    );
  }
  return encodeJsonlSession({
    header: {
      format: "heart-on-stream",
      version: 1,
      appVersion: "0.1.0",
      metricConfig: "synthetic (development only)",
      startTimeUs: epoch,
    },
    frames,
  });
}
