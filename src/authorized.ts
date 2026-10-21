import { AuthorizationError, requirePermission } from "/p/the8020/auth/mod.ts";
import { sendMessage } from "/p/the8020/uui/mod.ts";

/** Checks a screen's permission; a denial becomes a message, not a crash. */
export async function allowed(action: string, value: string): Promise<boolean> {
  try {
    await requirePermission(action, value);
    return true;
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    sendMessage(error.message, "error");
    return false;
  }
}
