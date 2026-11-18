import { assertEquals, assertRejects } from "@std/assert";
import {
  kernelDatabaseBackendSymbol,
  type KernelInvoke,
  kernelInvokeSymbol,
} from "@the8020/kernel";
import { development } from "./development.ts";

Deno.test("sandbox access and activation follow separate policies", async () => {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const originalInvoke = globals[kernelInvokeSymbol];
  const originalBackend = globals[kernelDatabaseBackendSymbol];
  let role = "production";
  let override: unknown = "auto";
  const calls: string[] = [];
  globals[kernelDatabaseBackendSymbol] = "sqlite";
  globals[kernelInvokeSymbol] = ((operation, input) => {
    const name = operation === "runtime.operation"
      ? String(input.operation)
      : operation;
    calls.push(name);
    if (name === "database.execute") {
      assertEquals(input.parameters, ["system.profile"]);
      return Promise.resolve({
        columns: ["value"],
        rows: [[JSON.stringify({
          id: "sys-aaaaaaaaaa",
          name: "Diagnostic system",
          role,
        })]],
      });
    }
    let result: unknown;
    switch (name) {
      case "settings.node.get":
        assertEquals(input.input, { key: "development.activation_allowed" });
        result = { setting: { active_value: override } };
        break;
      case "development.sandbox.create":
      case "development.sandbox.start":
      case "development.sandbox.restart":
      case "development.sandbox.shell":
        result = { sandbox: {} };
        break;
      case "development.activate.preview":
        result = { preview: { packages: [] } };
        break;
      case "development.activate.run":
        result = { activation: { success: true } };
        break;
      default:
        throw new Error(`Unexpected operation ${name}`);
    }
    return Promise.resolve({ success: true, result });
  }) satisfies KernelInvoke;
  const activation = { user_id: "admin", message: "Repair" };
  try {
    for (role of ["development", "test", "production"]) {
      for (override of ["auto", "true", "false"]) {
        calls.length = 0;
        for (const action of ["create", "start", "restart", "shell"]) {
          await development.sandbox.run(action, "admin");
        }
        await development.activate.preview({ user_id: "admin" });
        for (const action of ["status", "abort"]) {
          await development.activate.run({ ...activation, action });
        }
        assertEquals(calls.includes("settings.node.get"), false);
        assertEquals(calls.includes("database.execute"), false);
        for (const action of [undefined, "continue"]) {
          calls.length = 0;
          const run = () => development.activate.run({ ...activation, action });
          const allowed = override === "true" ||
            (override === "auto" && role === "development");
          if (allowed) await run();
          else await assertRejects(run, Error, "Sandbox activation");
          assertEquals(calls.includes("development.activate.run"), allowed);
          assertEquals(calls.includes("database.execute"), override === "auto");
        }
      }
    }
    override = "invalid";
    await assertRejects(
      () => development.activate.run(activation),
      Error,
      "Invalid development.activation_allowed",
    );
  } finally {
    globals[kernelInvokeSymbol] = originalInvoke;
    globals[kernelDatabaseBackendSymbol] = originalBackend;
  }
});
