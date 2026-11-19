import type { PrivacyMode } from "../../domain/privacy/index";
import { element } from "./panel-elements";
import { privacyDescriptions } from "./screen-flow";

const modes = ["off", "vibe", "numbers", "highlightsOnly"] as const;
export const privacyLabels: Record<PrivacyMode, string> = {
  off: "Off",
  vibe: "Vibe",
  numbers: "Numbers",
  highlightsOnly: "Highlights only",
};

/** All activation paths share the same selection handler and description. */
export function createPrivacyDial(
  id: string,
  helpId: string,
  onChange: (mode: PrivacyMode) => void,
) {
  const group = element("fieldset", "", "privacy-dial");
  group.id = id;
  const legend = element("legend", "Privacy dial · overlay sharing");
  const segments = element("div", "", "segments");
  const help = element("p", "", "help");
  help.id = helpId;
  group.setAttribute("aria-describedby", help.id);
  group.append(legend, segments, help);
  let value: PrivacyMode = "vibe";
  const choices = modes.map((mode) => {
    const button = element("button", privacyLabels[mode], "segment");
    button.id = `${id}-${mode}`;
    button.type = "button";
    return { mode, button };
  });
  function setValue(mode: PrivacyMode): void {
    value = mode;
    if (help.textContent !== privacyDescriptions[mode])
      help.textContent = privacyDescriptions[mode];
    for (const choice of choices)
      choice.button.setAttribute("aria-pressed", String(choice.mode === mode));
  }
  function choose(mode: PrivacyMode): void {
    if (group.disabled || value === mode) return;
    setValue(mode);
    onChange(mode);
  }
  choices.forEach(({ button, mode }, index) => {
    button.addEventListener("click", () => choose(mode));
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (group.disabled) return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next =
        choices[(index + direction + choices.length) % choices.length];
      if (!next) return;
      next.button.focus();
      choose(next.mode);
    });
  });
  segments.append(...choices.map(({ button }) => button));
  setValue(value);
  return {
    group,
    get value() {
      return value;
    },
    setValue,
  };
}
