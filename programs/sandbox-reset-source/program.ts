import { sandboxAction } from "../../src/commands.ts";
export default (...args: string[]) => sandboxAction("reset-source", args);
