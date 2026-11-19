import { dirname, relative, resolve, sep } from "node:path";

/** Source contents are supplied by the caller so fixtures need no disk or compiler. */
export interface ProjectFile {
  readonly file: string;
  readonly source: string;
}

/** One identifier for each dependency rule in the architecture document. */
export type ArchitectureRuleId =
  | "domain-only"
  | "application-inward"
  | "presentation-boundary"
  | "infrastructure-composition-only"
  | "core-no-platform";

/** Paths are project-relative; a single import may violate several rules. */
export interface ArchitectureViolation {
  readonly file: string;
  readonly specifier: string;
  readonly ruleId: ArchitectureRuleId;
}

interface Token {
  readonly kind: "word" | "string" | "punctuation";
  readonly value: string;
}

const escapedCharacters: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

function quotedString(source: string, start: number): [string, number] {
  const quote = source[start];
  let value = "";
  let i = start + 1;
  while (i < source.length) {
    const character = source[i++] ?? "";
    if (character === quote) break;
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = source[i++] ?? "";
    if (escaped === "\n") continue;
    if (escaped === "\r") {
      if (source[i] === "\n") i++;
      continue;
    }
    const hexLength = escaped === "x" ? 2 : escaped === "u" ? 4 : 0;
    if (hexLength > 0) {
      const braced = escaped === "u" && source[i] === "{";
      const end = braced ? source.indexOf("}", i + 1) : i + hexLength;
      const digits = source.slice(braced ? i + 1 : i, end);
      const codePoint = Number.parseInt(digits, 16);
      if (/^[\da-f]+$/i.test(digits) && codePoint <= 0x10ffff) {
        value += String.fromCodePoint(codePoint);
        i = end + (braced ? 1 : 0);
        continue;
      }
    }
    value += escapedCharacters[escaped] ?? escaped;
  }
  return [value, i];
}

function canStartRegex(previous: Token | undefined): boolean {
  if (!previous) return true;
  if (previous.kind === "word") {
    return /^(return|throw|case|delete|void|typeof|yield|await|in|of|else|do)$/.test(
      previous.value,
    );
  }
  return (
    previous.kind === "punctuation" &&
    /^[([{=,:;!?&|+*%~^<>-]$/.test(previous.value)
  );
}

// A small lexer replaces the unavailable classic TS compiler API. Comments,
// quoted text, regex bodies and template text cannot manufacture dependencies;
// template expressions are still scanned for actual calls to import/require.
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  function scanCode(templateExpression = false): void {
    let braces = 0;
    while (i < source.length) {
      const character = source[i] ?? "";
      if (/\s/.test(character)) {
        i++;
      } else if (source.startsWith("//", i)) {
        const end = source.indexOf("\n", i + 2);
        i = end < 0 ? source.length : end + 1;
      } else if (source.startsWith("/*", i)) {
        const end = source.indexOf("*/", i + 2);
        i = end < 0 ? source.length : end + 2;
      } else if (character === '"' || character === "'") {
        const [value, end] = quotedString(source, i);
        tokens.push({ kind: "string", value });
        i = end;
      } else if (character === "`") {
        tokens.push({ kind: "punctuation", value: "`" });
        i++;
        while (i < source.length) {
          if (source[i] === "\\") {
            i += 2;
          } else if (source[i] === "`") {
            i++;
            break;
          } else if (source.startsWith("${", i)) {
            tokens.push({ kind: "punctuation", value: "(" });
            i += 2;
            scanCode(true);
            tokens.push({ kind: "punctuation", value: ")" });
          } else {
            i++;
          }
        }
        tokens.push({ kind: "punctuation", value: "`" });
      } else if (character === "/" && canStartRegex(tokens.at(-1))) {
        i++;
        let characterClass = false;
        while (i < source.length) {
          const next = source[i++];
          if (next === "\\") i++;
          else if (next === "[") characterClass = true;
          else if (next === "]") characterClass = false;
          else if (next === "/" && !characterClass) break;
        }
        while (/[a-z]/i.test(source[i] ?? "")) i++;
        tokens.push({ kind: "punctuation", value: "/regex/" });
      } else if (/[a-z_$]/i.test(character)) {
        const start = i++;
        while (/[\w$]/.test(source[i] ?? "")) i++;
        tokens.push({ kind: "word", value: source.slice(start, i) });
      } else {
        // Postfix ++/-- end an expression; a following slash is division.
        const pair = source.slice(i, i + 2);
        if (pair === "++" || pair === "--") {
          tokens.push({ kind: "punctuation", value: pair });
          i += 2;
          continue;
        }
        i++;
        if (character === "}" && templateExpression && braces === 0) return;
        if (character === "{") braces++;
        if (character === "}") braces--;
        tokens.push({ kind: "punctuation", value: character });
      }
    }
  }

  scanCode();
  return tokens;
}

function importSpecifiers(source: string): string[] {
  const tokens = tokenize(source);
  const specifiers: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token?.kind !== "word") continue;
    const previous = tokens[i - 1]?.value;
    if (previous === ".") continue;
    const next = tokens[i + 1];
    if (token.value === "require" || token.value === "import") {
      if (next?.value === "(" && tokens[i + 2]?.kind === "string") {
        const end = tokens[i + 3]?.value;
        if (end === ")" || end === ",") {
          specifiers.push(tokens[i + 2]?.value ?? "");
        }
        continue;
      }
    }
    if (token.value === "import" && next?.kind === "string") {
      specifiers.push(next.value);
      continue;
    }
    const isStaticImport = token.value === "import" && next?.kind === "word";
    const isNamedImport = token.value === "import" && next?.value === "{";
    const isStarImport = token.value === "import" && next?.value === "*";
    const isReexport =
      token.value === "export" &&
      (next?.value === "{" ||
        next?.value === "*" ||
        (next?.value === "type" &&
          ["{", "*"].includes(tokens[i + 2]?.value ?? "")));
    if (!isStaticImport && !isNamedImport && !isStarImport && !isReexport) {
      continue;
    }
    for (let j = i + 1; j < tokens.length; j++) {
      const candidate = tokens[j];
      if (
        candidate?.value === ";" ||
        (candidate?.kind === "word" &&
          ["import", "export"].includes(candidate.value))
      ) {
        break;
      }
      if (candidate?.value === "from" && tokens[j + 1]?.kind === "string") {
        specifiers.push(tokens[j + 1]?.value ?? "");
        break;
      }
    }
  }
  return specifiers;
}

function within(file: string | undefined, directory: string): boolean {
  return file === directory || file?.startsWith(`${directory}/`) === true;
}

function projectPath(root: string, file: string): string {
  return relative(root, resolve(root, file)).split(sep).join("/");
}

function platformImport(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    specifier.startsWith("@smartspectra/") ||
    ["electron", "ws", "obs-websocket-js"].some(
      (name) => specifier === name || specifier.startsWith(`${name}/`),
    )
  );
}

/**
 * Checks the five documented import rules without I/O, resolving relative paths
 * from each importing file. Accepts relative or absolute input filenames. No
 * aliases are resolved: this project uses relative imports between local files.
 * Infrastructure adapters may import shared helpers within infrastructure.
 */
export function checkArchitecture(
  projectRoot: string,
  files: readonly ProjectFile[],
): ArchitectureViolation[] {
  const root = resolve(projectRoot);
  const violations: ArchitectureViolation[] = [];
  for (const input of files) {
    const file = projectPath(root, input.file);
    if (!within(file, "src")) continue;
    const domain = within(file, "src/domain");
    const application = within(file, "src/application");
    const presentation = within(file, "src/presentation");
    const infrastructure = within(file, "src/infrastructure");
    const composition =
      file === "src/main/composition-root.ts" ||
      file === "src/renderer/composition.ts";

    for (const specifier of importSpecifiers(input.source)) {
      const target = specifier.startsWith(".")
        ? projectPath(root, resolve(root, dirname(file), specifier))
        : undefined;
      const report = (ruleId: ArchitectureRuleId): void => {
        violations.push({ file, specifier, ruleId });
      };
      if (domain && !within(target, "src/domain")) report("domain-only");
      if (
        application &&
        !within(target, "src/application") &&
        !within(target, "src/domain")
      ) {
        report("application-inward");
      }
      if (
        presentation &&
        (within(target, "src/infrastructure") ||
          within(target, "src/application/use-cases"))
      ) {
        report("presentation-boundary");
      }
      if (
        !infrastructure &&
        !composition &&
        within(target, "src/infrastructure")
      ) {
        report("infrastructure-composition-only");
      }
      if ((domain || application) && platformImport(specifier)) {
        report("core-no-platform");
      }
    }
  }
  return violations;
}
