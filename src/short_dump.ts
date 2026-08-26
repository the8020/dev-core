import type { TerminatedProgramInput } from "@platform/uui";

export interface ShortDump {
  exceptionType: string;
  message: string;
  properties: string;
  programId: string;
  entrypoint: string;
  location: string;
  occurredAt: string;
  stack: string;
  source: string;
  dumpText: string;
}

interface SourceLocation {
  path: string;
  line: number;
  column: number;
}

const maximumText = 200_000;

export async function buildShortDump(
  input: TerminatedProgramInput,
): Promise<ShortDump> {
  const exceptionType = exceptionName(input.exception);
  const message = exceptionMessage(input.exception);
  const stack = bounded(
    exceptionStack(input.exception) || "No call stack was provided.",
  );
  const sourceLocation = locationFromStack(stack) ??
    locationFromEntrypoint(input.entrypoint);
  const location = sourceLocation === undefined
    ? displayPath(input.entrypoint) || input.programId
    : `${
      displayPath(sourceLocation.path)
    }:${sourceLocation.line}:${sourceLocation.column}`;
  const source = sourceLocation === undefined
    ? "Source location is unavailable."
    : await sourceContext(sourceLocation);
  const properties = bounded(inspectException(input.exception));
  const entrypoint = displayPath(input.entrypoint) || "Unavailable";
  const dumpText = bounded([
    "PROGRAM TERMINATED",
    `Exception type: ${exceptionType}`,
    `Message: ${message}`,
    `Program: ${input.programId}`,
    `Entrypoint: ${entrypoint}`,
    `Raised at: ${location}`,
    `Occurred at: ${input.occurredAt}`,
    "",
    "EXCEPTION PROPERTIES",
    properties,
    "",
    "CALL STACK",
    stack,
    "",
    "SOURCE CONTEXT",
    source,
  ].join("\n"));
  return {
    exceptionType,
    message: bounded(message),
    properties,
    programId: input.programId,
    entrypoint,
    location,
    occurredAt: input.occurredAt,
    stack,
    source,
    dumpText,
  };
}

export function exceptionName(value: unknown): string {
  if (value instanceof Error && value.name.trim() !== "") return value.name;
  if (value !== null && typeof value === "object") {
    const constructor = Object.getPrototypeOf(value)?.constructor;
    if (typeof constructor?.name === "string" && constructor.name !== "") {
      return constructor.name;
    }
  }
  return typeof value;
}

function exceptionMessage(value: unknown): string {
  if (value instanceof Error) return value.message || String(value);
  return formatValue(value, 0, new WeakSet());
}

function exceptionStack(value: unknown): string {
  if (value instanceof Error && typeof value.stack === "string") {
    return value.stack;
  }
  return "";
}

function inspectException(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return `Thrown value: ${formatValue(value, 0, new WeakSet())}`;
  }
  const lines = [`Runtime type: ${exceptionName(value)}`];
  for (const key of Reflect.ownKeys(value)) {
    if (key === "stack" || key === "message" || key === "name") continue;
    const label = typeof key === "symbol" ? key.toString() : key;
    try {
      lines.push(
        `${label}: ${formatValue(Reflect.get(value, key), 0, new WeakSet())}`,
      );
    } catch (error) {
      lines.push(`${label}: <unreadable: ${exceptionMessage(error)}>`);
    }
  }
  return lines.join("\n");
}

function formatValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): string {
  if (typeof value === "string") return JSON.stringify(bounded(value, 16_000));
  if (
    value === null || typeof value === "number" || typeof value === "boolean" ||
    typeof value === "undefined" || typeof value === "bigint"
  ) return String(value);
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (seen.has(value)) return "<circular>";
  if (depth >= 4) return `<${exceptionName(value)}>`;
  seen.add(value);
  const entries: string[] = [];
  for (const key of Reflect.ownKeys(value).slice(0, 30)) {
    const label = typeof key === "symbol" ? `[${key.toString()}]` : key;
    try {
      entries.push(
        `${label}: ${formatValue(Reflect.get(value, key), depth + 1, seen)}`,
      );
    } catch (error) {
      entries.push(`${label}: <unreadable: ${exceptionMessage(error)}>`);
    }
  }
  if (Reflect.ownKeys(value).length > 30) entries.push("…");
  seen.delete(value);
  return `{ ${entries.join(", ")} }`;
}

function locationFromStack(stack: string): SourceLocation | undefined {
  const pattern = /((?:file:\/\/)?\/[^\s()]+):(\d+):(\d+)/g;
  for (const match of stack.matchAll(pattern)) {
    const path = filePath(match[1]!);
    const line = Number(match[2]);
    const column = Number(match[3]);
    if (path !== "" && line > 0 && column > 0) return { path, line, column };
  }
  return undefined;
}

function locationFromEntrypoint(
  entrypoint: string,
): SourceLocation | undefined {
  const path = filePath(entrypoint);
  return path === "" ? undefined : { path, line: 1, column: 1 };
}

function filePath(value: string): string {
  if (value.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(value).pathname);
    } catch {
      return "";
    }
  }
  return value.startsWith("/") ? value : "";
}

function displayPath(value: string): string {
  const path = filePath(value);
  for (const prefix of ["/workspace/programs/", "/workspace/packages/"]) {
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

async function sourceContext(location: SourceLocation): Promise<string> {
  try {
    const source = await Deno.readTextFile(location.path);
    const lines = source.split("\n");
    const first = Math.max(1, location.line - 5);
    const last = Math.min(lines.length, location.line + 5);
    const width = String(last).length;
    return Array.from({ length: last - first + 1 }, (_, offset) => {
      const number = first + offset;
      const marker = number === location.line ? ">" : " ";
      return `${marker} ${String(number).padStart(width)} | ${
        bounded(lines[number - 1] ?? "", 1_000)
      }`;
    }).join("\n");
  } catch (error) {
    return `Source could not be read: ${exceptionMessage(error)}`;
  }
}

function bounded(value: string, maximum = maximumText): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n… truncated …`;
}
