import { element, svgElement } from "./panel-elements";
import { type PulsePoint, pulseWindowUs } from "./pulse-history";

const width = 640;
const height = 132;

/** SVG geometry stays in the panel DOM and uses no inline styles. */
export function createPulseChart() {
  const root = element("figure", "", "pulse-chart");
  root.id = "pulse-chart";
  root.hidden = true;
  const caption = element("figcaption", "Pulse · last 2 minutes");
  const legend = element("div", "", "chart-legend");
  const baselineLabel = element("span", "", "chart-baseline-label");
  const spikeLabel = element("span", "", "chart-spike-label");
  baselineLabel.id = "pulse-chart-baseline-label";
  spikeLabel.id = "pulse-chart-spike-label";
  legend.append(baselineLabel, spikeLabel);
  const scale = element("div", "", "chart-scale");
  const highLabel = element("span");
  const lowLabel = element("span");
  scale.setAttribute("aria-hidden", "true");
  scale.append(highLabel, lowLabel);
  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": "Pulse readings over the last two minutes",
  });
  const grid = svgElement("path", {
    class: "chart-grid",
    d: "M0 8H640 M0 66H640 M0 124H640 M160 8V124 M320 8V124 M480 8V124",
  });
  const area = svgElement("path", { class: "chart-area" });
  const baseline = svgElement("path", { class: "chart-baseline" });
  const spike = svgElement("path", { class: "chart-spike" });
  const trace = svgElement("path", {
    id: "pulse-chart-trace",
    class: "chart-trace",
  });
  const endpoint = svgElement("path", { class: "chart-endpoint" });
  svg.append(grid, area, baseline, spike, trace, endpoint);
  const plot = element("div", "", "chart-plot");
  plot.append(scale, svg);
  const axis = element("div", "", "chart-axis");
  axis.append(element("span", "2 min ago"), element("span", "Now"));
  root.append(caption, legend, plot, axis);
  let renderedKey = "";

  function render(
    visible: boolean,
    points: readonly PulsePoint[],
    time: number | null,
    baselineBpm: number | null,
    spikeBpm: number | null,
  ): void {
    const newest = points.at(-1);
    const end = Math.max(time ?? 0, newest?.t ?? 0);
    // Waveform updates are more frequent than the chart needs to scroll.
    const tick = newest ? Math.floor(end / 250_000) : 0;
    const key = [
      visible,
      points.length,
      points[0]?.t,
      newest?.t,
      tick,
      baselineBpm,
      spikeBpm,
    ].join("|");
    if (key === renderedKey) return;
    renderedKey = key;
    root.hidden = !visible;
    baselineLabel.hidden = baselineBpm === null;
    spikeLabel.hidden = spikeBpm === null;
    baselineLabel.textContent =
      baselineBpm === null ? "" : `Baseline ${Math.round(baselineBpm)} BPM`;
    spikeLabel.textContent =
      spikeBpm === null ? "" : `Spike threshold ${Math.round(spikeBpm)} BPM`;
    const values = points.map((point) => point.value);
    if (baselineBpm !== null) values.push(baselineBpm);
    if (spikeBpm !== null) values.push(spikeBpm);
    const low = values.length
      ? Math.floor((Math.min(...values) - 5) / 5) * 5
      : 50;
    const high = values.length
      ? Math.ceil((Math.max(...values) + 5) / 5) * 5
      : 100;
    lowLabel.textContent = visible ? String(low) : "";
    highLabel.textContent = visible ? String(high) : "";
    const y = (value: number) =>
      (8 + ((high - value) / (high - low)) * (height - 16)).toFixed(1);
    baseline.setAttribute(
      "d",
      baselineBpm === null ? "" : `M0 ${y(baselineBpm)}H${width}`,
    );
    spike.setAttribute(
      "d",
      spikeBpm === null ? "" : `M0 ${y(spikeBpm)}H${width}`,
    );
    const positions = points.map(({ t, value }) => ({
      x: (4 + (1 - (end - t) / pulseWindowUs) * (width - 8)).toFixed(1),
      y: y(value),
    }));
    const line = positions
      .map(({ x, y }, index) => `${index === 0 ? "M" : "L"}${x} ${y}`)
      .join("");
    trace.setAttribute("d", line);
    const first = positions[0];
    const last = positions.at(-1);
    area.setAttribute(
      "d",
      first && last ? `${line}L${last.x} ${height}H${first.x}Z` : "",
    );
    endpoint.setAttribute("d", last ? `M${last.x} ${last.y}h0.01` : "");
  }

  return { root, render };
}
