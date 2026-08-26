import {
  callScreen,
  discoverPrograms,
  endSession,
  invokeProgram,
  z,
} from "@platform/uui";
import layout from "./layouts/main.json" with { type: "json" };

const HomeScreen = z.object({
  programs: z.array(z.object({ id: z.string(), description: z.string() })),
});

export default async function home(): Promise<void> {
  const model = { programs: await discoverPrograms() };
  while (true) {
    const event = await callScreen({
      id: "home",
      title: "Welcome to Platform",
      schema: HomeScreen,
      model,
      layout,
      actions: [{ id: "logout", label: "Logout" }],
    });
    if (event.action === "logout") {
      endSession("Signing out…", "/example/core-ui/login/logout");
      return;
    }
    if (event.action === "select" && typeof event.value === "string") {
      await invokeProgram(event.value);
    }
  }
}
