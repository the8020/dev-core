import { sandboxAction } from "../../src/commands.ts";
export default (...args: string[]) => sandboxAction("inspect", args);
