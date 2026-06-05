import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT_DIR, ".env");

async function main() {
  const content = await fs.readFile(ENV_PATH, "utf-8");
  const values = parseEnv(content);

  const checks = [
    ["TELEGRAM_BOT_TOKEN", values.TELEGRAM_BOT_TOKEN],
    ["OPENAI_API_KEY", values.OPENAI_API_KEY],
    ["GOOGLE_CALENDAR_ID", values.GOOGLE_CALENDAR_ID]
  ];

  const hasJsonPath = Boolean(values.GOOGLE_SERVICE_ACCOUNT_JSON_PATH);
  if (!hasJsonPath) {
    checks.push(
      ["GOOGLE_SERVICE_ACCOUNT_EMAIL", values.GOOGLE_SERVICE_ACCOUNT_EMAIL],
      ["GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", values.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY]
    );
  }

  const missing = checks.filter(([, value]) => !value || value === "..." || value.includes("BEGIN PRIVATE KEY-----\\n..."));
  if (missing.length > 0) {
    console.error("Missing or placeholder values:");
    for (const [name] of missing) {
      console.error(`- ${name}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Config file looks complete.");
  console.log(`Calendar: ${values.GOOGLE_CALENDAR_ID}`);
  if (hasJsonPath) {
    console.log(`Service account JSON: ${values.GOOGLE_SERVICE_ACCOUNT_JSON_PATH}`);
  } else {
    console.log(`Service account: ${values.GOOGLE_SERVICE_ACCOUNT_EMAIL}`);
  }
}

function parseEnv(content) {
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
