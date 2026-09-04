import { sandboxAction } from "../../src/commands.ts";
export default (...args: string[]) => sandboxAction("factory-reset", args);
