import { sandboxAction } from "../../src/commands.ts";
export default (...args: string[]) => sandboxAction("kill", args);
