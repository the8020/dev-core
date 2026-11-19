import { check } from "/p/the8020/auth/mod.ts";
import { defineService } from "/p/the8020/services/http.ts";
import { context } from "@the8020/context";
import { kernel } from "@the8020/kernel";

const service = defineService();
service.get("/", { summary: "Check the running desktop owner" }, async () => {
  if (
    !context.authenticated ||
    !await check("the8020.dev-core.development.use", "")
  ) {
    return new Response(null, { status: 403 });
  }
  const { sandbox } = await kernel.development.sandbox.run(
    "inspect",
    context.username,
  ) as {
    sandbox: { user_id: string; sandbox_id: string; state: string };
  };
  if (
    sandbox.user_id !== context.username ||
    !["READY", "CONFLICTED"].includes(sandbox.state.toUpperCase())
  ) {
    return new Response(null, { status: 409 });
  }
  return Response.json(
    { user: context.username, sandbox: sandbox.sandbox_id },
    { headers: { "cache-control": "no-store" } },
  );
});
export default service;
