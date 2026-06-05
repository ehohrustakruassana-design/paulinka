#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
SERVICE_ACCOUNT_JSON_PATH="${SERVICE_ACCOUNT_JSON_PATH:-$ROOT_DIR/service-account.json}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing .env file at $ENV_FILE"
  exit 1
fi

if [[ ! -f "$SERVICE_ACCOUNT_JSON_PATH" ]]; then
  echo "Missing service account JSON at $SERVICE_ACCOUNT_JSON_PATH"
  exit 1
fi

SERVICE_NAME="${SERVICE_NAME:-family-calendar-bot}"
PROJECT_ID="${PROJECT_ID:-family-calendar-bot-498510}"
REGION="${REGION:-europe-west4}"

read_env_value() {
  local key="$1"
  node --input-type=module -e '
    import fs from "node:fs";
    const key = process.argv[1];
    const file = process.argv[2];
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      const currentKey = line.slice(0, idx).trim();
      if (currentKey !== key) continue;
      let value = line.slice(idx + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.stdout.write(value);
      process.exit(0);
    }
    process.exit(1);
  ' "$key" "$ENV_FILE"
}

TELEGRAM_BOT_TOKEN="$(read_env_value TELEGRAM_BOT_TOKEN)"
OPENAI_API_KEY="$(read_env_value OPENAI_API_KEY)"
GOOGLE_CALENDAR_ID="$(read_env_value GOOGLE_CALENDAR_ID)"
BOT_TIMEZONE="$(read_env_value BOT_TIMEZONE || true)"
BOT_LANGUAGE="$(read_env_value BOT_LANGUAGE || true)"
DEFAULT_EVENT_DURATION_MINUTES="$(read_env_value DEFAULT_EVENT_DURATION_MINUTES || true)"
OPENAI_TEXT_MODEL="$(read_env_value OPENAI_TEXT_MODEL || true)"
OPENAI_TRANSCRIBE_MODEL="$(read_env_value OPENAI_TRANSCRIBE_MODEL || true)"
TELEGRAM_WEBHOOK_SECRET="$(read_env_value TELEGRAM_WEBHOOK_SECRET || true)"

BOT_TIMEZONE="${BOT_TIMEZONE:-Europe/Warsaw}"
BOT_LANGUAGE="${BOT_LANGUAGE:-ru}"
DEFAULT_EVENT_DURATION_MINUTES="${DEFAULT_EVENT_DURATION_MINUTES:-60}"
OPENAI_TEXT_MODEL="${OPENAI_TEXT_MODEL:-gpt-4.1-mini}"
OPENAI_TRANSCRIBE_MODEL="${OPENAI_TRANSCRIBE_MODEL:-gpt-4o-mini-transcribe}"

if [[ -z "${TELEGRAM_WEBHOOK_SECRET:-}" ]]; then
  TELEGRAM_WEBHOOK_SECRET="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)"
fi

ENV_VARS_FILE="$(mktemp)"

cleanup() {
  rm -f "$ENV_VARS_FILE"
}

trap cleanup EXIT

cat > "$ENV_VARS_FILE" <<ENVEOF
BOT_MODE: "webhook"
PORT: "8080"
TELEGRAM_WEBHOOK_PATH: "/telegram/webhook"
TELEGRAM_BOT_TOKEN: "$TELEGRAM_BOT_TOKEN"
OPENAI_API_KEY: "$OPENAI_API_KEY"
GOOGLE_CALENDAR_ID: "$GOOGLE_CALENDAR_ID"
BOT_TIMEZONE: "$BOT_TIMEZONE"
BOT_LANGUAGE: "$BOT_LANGUAGE"
DEFAULT_EVENT_DURATION_MINUTES: "$DEFAULT_EVENT_DURATION_MINUTES"
OPENAI_TEXT_MODEL: "$OPENAI_TEXT_MODEL"
OPENAI_TRANSCRIBE_MODEL: "$OPENAI_TRANSCRIBE_MODEL"
TELEGRAM_WEBHOOK_SECRET: "$TELEGRAM_WEBHOOK_SECRET"
GOOGLE_SERVICE_ACCOUNT_JSON: |
$(sed 's/^/  /' "$SERVICE_ACCOUNT_JSON_PATH")
ENVEOF

echo "Deploying $SERVICE_NAME to Cloud Run in $PROJECT_ID / $REGION"

gcloud run deploy "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --source="$ROOT_DIR" \
  --allow-unauthenticated \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=1 \
  --max-instances=1 \
  --env-vars-file="$ENV_VARS_FILE"

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"

echo "Configuring PUBLIC_BASE_URL=$SERVICE_URL"

gcloud run services update "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --update-env-vars="PUBLIC_BASE_URL=$SERVICE_URL"

echo ""
echo "Done."
echo "Cloud Run URL: $SERVICE_URL"
echo "Telegram webhook path: $SERVICE_URL/telegram/webhook"
