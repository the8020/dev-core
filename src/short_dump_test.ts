import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildShortDump, exceptionName } from "./short_dump.ts";

Deno.test("short dump preserves exception type, fields, stack, and source context", async () => {
  const source = new URL("short_dump_test.ts", import.meta.url).pathname;
  const error = new TypeError("demonstration failed") as TypeError & {
    code: string;
    context: Record<string, unknown>;
  };
  error.code = "DEMO_FAILURE";
  error.context = {};
  error.context.self = error.context;
  error.stack =
    `TypeError: demonstration failed\n    at demo (file://${source}:8:3)`;
  const dump = await buildShortDump({
    exception: error,
    programId: "example/core-ui/demo-form",
    entrypoint: source,
    occurredAt: "2026-08-23T12:00:00.000Z",
    homeProgram: "core/uui/home",
    terminatedProgram: "core/uui/program-terminated",
  });
  assertEquals(dump.exceptionType, "TypeError");
  assertStringIncludes(dump.message, "demonstration failed");
  assertStringIncludes(dump.properties, "DEMO_FAILURE");
  assertStringIncludes(dump.properties, "<circular>");
  assertStringIncludes(dump.location, "short_dump_test.ts:8:3");
  assertStringIncludes(dump.source, ">  8 |");
  assertStringIncludes(dump.dumpText, "CALL STACK");
});

Deno.test("short dump handles non-Error thrown values", async () => {
  const dump = await buildShortDump({
    exception: { reason: "plain object" },
    programId: "example/core-ui/demo-master-detail",
    entrypoint: "",
    occurredAt: "2026-08-23T12:00:00.000Z",
    homeProgram: "core/uui/home",
    terminatedProgram: "core/uui/program-terminated",
  });
  assertEquals(exceptionName("failed"), "string");
  assertEquals(dump.exceptionType, "Object");
  assertStringIncludes(dump.message, "plain object");
  assertEquals(dump.source, "Source location is unavailable.");
});
