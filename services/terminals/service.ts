import { defineTerminalService } from "../../terminals/service.ts";
import { terminalMetadataStore } from "../../terminals/metadata.ts";
export { workerFunctions } from "../../terminals/service.ts";
export default defineTerminalService(terminalMetadataStore);
