import {
  MetricType,
  type MetricTypeValue,
} from "@smartspectra/node-sdk/renderer";
import type { MetricConfiguration } from "../../../shared/ipc-contract";

/** A fresh minimal list prevents changes to one session leaking into the next. */
export function requestedMetrics(
  config: MetricConfiguration,
): MetricTypeValue[] {
  const pulse = [
    MetricType.PULSE_RATE,
    MetricType.ARTERIAL_PRESSURE_TRACE,
    MetricType.TALKING,
  ];
  return config === "b"
    ? [...pulse, MetricType.CHEST_BREATHING, MetricType.BREATHING_RATE]
    : pulse;
}
