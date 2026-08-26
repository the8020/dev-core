import {
  callScreen,
  copyText,
  endSession,
  field,
  type TerminatedProgramInput,
  z,
} from "@platform/uui";
import { buildShortDump } from "../../src/short_dump.ts";
import layout from "./layouts/main.json" with { type: "json" };

const TerminationScreen = z.object({
  exceptionType: field(z.string(), { label: "Type", readOnly: true }),
  message: field(z.string(), {
    label: "Message",
    control: "textarea",
    readOnly: true,
  }),
  properties: field(z.string(), {
    label: "Properties",
    control: "textarea",
    readOnly: true,
  }),
  programId: field(z.string(), { label: "Program", readOnly: true }),
  entrypoint: field(z.string(), { label: "Entrypoint", readOnly: true }),
  location: field(z.string(), { label: "Raised at", readOnly: true }),
  occurredAt: field(z.string(), { label: "Time", readOnly: true }),
  copyStatus: field(z.string(), { label: "Copy status", readOnly: true }),
  stack: field(z.string(), {
    label: "Call stack",
    control: "textarea",
    readOnly: true,
  }),
  source: field(z.string(), {
    label: "Source context",
    control: "textarea",
    readOnly: true,
  }),
  dumpText: field(z.string(), {
    label: "Short dump",
    control: "textarea",
    readOnly: true,
  }),
});

export default async function programTerminated(
  input: TerminatedProgramInput,
): Promise<"home" | "end"> {
  assertInput(input);
  const dump = await buildShortDump(input);
  const model = { ...dump, copyStatus: "" };
  while (true) {
    const event = await callScreen({
      id: "program-terminated",
      title: "Program terminated",
      description:
        `Uncaught exception of type '${model.exceptionType}' was raised in '${model.location}' and terminated the current program.`,
      schema: TerminationScreen,
      model,
      layout,
      controls: [
        { id: "exception-type", bind: "exceptionType" },
        { id: "message", bind: "message" },
        { id: "properties", bind: "properties" },
        { id: "program-id", bind: "programId" },
        { id: "entrypoint", bind: "entrypoint" },
        { id: "location", bind: "location" },
        { id: "occurred-at", bind: "occurredAt" },
        { id: "copy-status", bind: "copyStatus" },
        { id: "stack", bind: "stack" },
        { id: "source", bind: "source" },
        { id: "dump-text", bind: "dumpText" },
      ],
      actions: [
        { id: "home", label: "Home", kind: "primary" },
        { id: "copy", label: "Copy short dump" },
        { id: "end", label: "End session", kind: "danger" },
      ],
    });
    if (event.action === "home") return "home";
    if (event.action === "end") {
      endSession("Session ended after a program exception.");
      return "end";
    }
    if (event.action === "copy") {
      copyText(model.dumpText);
      model.copyStatus = `Copied ${new Date().toISOString()}`;
    }
  }
}

function assertInput(value: unknown): asserts value is TerminatedProgramInput {
  if (
    value === null || typeof value !== "object" ||
    typeof (value as { programId?: unknown }).programId !== "string" ||
    typeof (value as { entrypoint?: unknown }).entrypoint !== "string" ||
    typeof (value as { occurredAt?: unknown }).occurredAt !== "string"
  ) throw new TypeError("program termination input is required");
}
