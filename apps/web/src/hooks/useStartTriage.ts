import { TRIAGE_PROMPT_FILE_NAME } from "@t3tools/contracts";

export const TRIAGE_CLI_COMMAND = "npx t3 triage";

/** A draft is a triage draft while its message still links the playbook file. */
export const isTriagePrompt = (prompt: string) => prompt.includes(`[${TRIAGE_PROMPT_FILE_NAME}](`);
