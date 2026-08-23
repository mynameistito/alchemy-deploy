import { readdir } from "node:fs/promises";
import { parse } from "yaml";

const YAML_EXTENSION = /\.ya?ml$/u;
const USES = /^(?<action>[^./][^@]*)@(?<ref>.+)$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const TEMPLATE_RELEASE_PLACEHOLDER = "REPLACE_WITH_FULL_40_CHARACTER_RELEASE_SHA";

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null;

const filesIn = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { recursive: true });
  return entries
    .filter((entry) => YAML_EXTENSION.test(entry))
    .map((entry) => `${directory}/${entry.replaceAll("\\", "/")}`);
};

const visit = (input: unknown, file: string, failures: string[]): void => {
  if (Array.isArray(input)) {
    for (const item of input) {
      visit(item, file, failures);
    }
    return;
  }
  if (typeof input !== "object" || input === null) {
    return;
  }
  for (const [key, value] of Object.entries(input)) {
    if (key === "uses" && typeof value === "string") {
      const match = value.match(USES);
      const action = match?.groups?.action;
      const reference = match?.groups?.ref;
      const allowedTemplatePlaceholder =
        file.startsWith("templates/") && reference === TEMPLATE_RELEASE_PLACEHOLDER;
      if (action && !allowedTemplatePlaceholder && (!reference || !FULL_SHA.test(reference))) {
        failures.push(`${file}: remote action is not pinned to a full SHA: ${value}`);
      }
    }
    visit(value, file, failures);
  }
};

const files = [
  ...(await filesIn(".github")),
  ...(await filesIn("actions")),
  ...(await filesIn("templates")),
];
const reads = await Promise.all(
  files.map(async (file) => ({ file, text: await Bun.file(file).text() })),
);
const failures: string[] = [];
for (const { file, text } of reads) {
  try {
    visit(parse(text), file, failures);
  } catch (error) {
    failures.push(
      `${file}: invalid YAML: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

const actionMetadata = await Promise.all(
  ["action.yml", "actions/deployment-report/action.yml"].map(async (actionPath) => ({
    action: parse(await Bun.file(actionPath).text()),
    actionPath,
  })),
);
for (const { action, actionPath } of actionMetadata) {
  if (!isRecord(action) || !("runs" in action)) {
    failures.push(`${actionPath}: missing runs metadata`);
    continue;
  }
  if (!isRecord(action.runs)) {
    failures.push(`${actionPath}: runs must be an object`);
    continue;
  }
  if (action.runs.using !== "composite") {
    failures.push(`${actionPath}: runs.using must be composite`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exitCode = 1;
} else {
  console.info(`Validated ${files.length} YAML/action metadata files.`);
}
