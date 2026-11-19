import type { Highlight } from "../../domain/session/index";
import { element, svgElement } from "./panel-elements";
import { sessionTime } from "./screen-flow";

/** Session-relative offsets use the finalized duration, including the tail after the last reading. */
export function createReceiptTimeline() {
  const root = element("figure", "", "receipt-timeline");
  root.id = "receipt-timeline";
  root.hidden = true;
  const caption = element("figcaption", "Session timeline");
  const svg = svgElement("svg", {
    viewBox: "0 0 1000 24",
    preserveAspectRatio: "none",
    role: "img",
  });
  const rail = svgElement("line", {
    class: "timeline-rail",
    x1: "0",
    x2: "1000",
    y1: "12",
    y2: "12",
  });
  const markers = svgElement("g", { id: "receipt-timeline-markers" });
  const axis = element("div", "", "chart-axis");
  const end = element("span");
  axis.append(element("span", "00:00"), end);
  svg.append(rail, markers);
  root.append(caption, svg, axis);

  function render(
    durationMs: number | null,
    highlights: readonly Highlight[],
  ): void {
    const durationUs = (durationMs ?? 0) * 1_000;
    const valid =
      durationUs > 0 && Number.isFinite(durationUs)
        ? highlights.filter(
            ({ sessionOffsetUs }) =>
              sessionOffsetUs >= 0 && sessionOffsetUs <= durationUs,
          )
        : [];
    root.hidden = valid.length === 0;
    end.textContent = root.hidden ? "" : sessionTime(durationUs);
    svg.setAttribute(
      "aria-label",
      root.hidden
        ? ""
        : valid
            .map(
              ({ sessionOffsetUs, label }) =>
                `${sessionTime(sessionOffsetUs)} ${label}`,
            )
            .join(". "),
    );
    markers.replaceChildren(
      ...valid.map(({ sessionOffsetUs }) => {
        const x = String((sessionOffsetUs / durationUs) * 1000);
        return svgElement("line", {
          class: "timeline-marker",
          x1: x,
          x2: x,
          y1: "5",
          y2: "19",
        });
      }),
    );
  }

  return { root, render };
}
