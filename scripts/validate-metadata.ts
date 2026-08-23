import { readdir } from "node:fs/promises";

import { parse } from "yaml";
import { z } from "zod";

const YAML_EXTENSION = /\.ya?ml$/u;
const USES = /^(?<action>[^./][^@]*)@(?<ref>.+)$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const TEMPLATE_RELEASE_PLACEHOLDER =
  "REPLACE_WITH_FULL_40_CHARACTER_RELEASE_SHA";

type YamlValue =
  | string
  | number
  | boolean
  | null
  | readonly YamlValue[]
  | { readonly [key: string]: YamlValue };
const yamlValueSchema: z.ZodType<YamlValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(yamlValueSchema),
    z.object({}).catchall(yamlValueSchema),
  ])
);
const yamlRecordSchema = z.object({}).catchall(yamlValueSchema);

const filesIn = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { recursive: true });
  return entries
    .filter((entry) => YAML_EXTENSION.test(entry))
    .map((entry) => `${directory}/${entry.replaceAll("\\", "/")}`);
};

const visit = (input: YamlValue, file: string, failures: string[]): void => {
  if (Array.isArray(input)) {
    for (const item of input) {
      visit(item, file, failures);
    }
    return;
  }
  const record = yamlRecordSchema.safeParse(input);
  if (!record.success) {
    return;
  }
  for (const [key, value] of Object.entries(record.data)) {
    const uses = z.string().safeParse(value);
    if (key === "uses" && uses.success) {
      const match = uses.data.match(USES);
      const action = match?.groups?.action;
      const reference = match?.groups?.ref;
      const allowedTemplatePlaceholder =
        file.startsWith("templates/") &&
        reference === TEMPLATE_RELEASE_PLACEHOLDER;
      if (
        action &&
        !allowedTemplatePlaceholder &&
        (!reference || !FULL_SHA.test(reference))
      ) {
        failures.push(
          `${file}: remote action is not pinned to a full SHA: ${uses.data}`
        );
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
  files.map(async (file) => ({ file, text: await Bun.file(file).text() }))
);
const failures: string[] = [];
for (const { file, text } of reads) {
  try {
    visit(yamlValueSchema.parse(parse(text)), file, failures);
  } catch (error) {
    failures.push(
      `${file}: invalid YAML: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}

const actionMetadata = await Promise.all(
  ["action.yml", "actions/deployment-report/action.yml"].map(
    async (actionPath) => ({
      action: yamlValueSchema.parse(parse(await Bun.file(actionPath).text())),
      actionPath,
    })
  )
);
for (const { action, actionPath } of actionMetadata) {
  const metadata = yamlRecordSchema.safeParse(action);
  if (!metadata.success || !("runs" in metadata.data)) {
    failures.push(`${actionPath}: missing runs metadata`);
  } else if (!yamlRecordSchema.safeParse(metadata.data.runs).success) {
    failures.push(`${actionPath}: runs must be an object`);
  } else if (yamlRecordSchema.parse(metadata.data.runs).using !== "composite") {
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
