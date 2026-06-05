# Family Calendar Telegram Bot

Telegram bot for quickly dropping family events into a shared Google Calendar.

What it does:

- accepts plain text messages like `17 июня день рождения Мии 17:15-18:15`
- accepts voice notes and audio messages
- asks a follow-up question if date or time is too unclear
- creates events in the `Семья` Google Calendar
- can run locally in polling mode or permanently in webhook mode on Cloud Run

## Setup

### 1. Create a Telegram bot

1. Open `@BotFather` in Telegram.
2. Run `/newbot`.
3. Copy the bot token into `TELEGRAM_BOT_TOKEN`.

### 2. Prepare Google Calendar access

Recommended setup for automation:

1. Create a Google Cloud project.
2. Enable the Google Calendar API.
3. Create a service account.
4. Copy the service account email into `GOOGLE_SERVICE_ACCOUNT_EMAIL`.
5. Copy the private key into `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`.
6. In Google Calendar, open calendar `Семья` and share it with the service account email.
   Grant permission to make changes to events.

Easier option:

- download the service account JSON key file
- put it somewhere on the machine
- set `GOOGLE_SERVICE_ACCOUNT_JSON_PATH=/absolute/path/to/your-key.json`
- or pass the whole JSON through `GOOGLE_SERVICE_ACCOUNT_JSON`
- then you do not need to manually copy `GOOGLE_SERVICE_ACCOUNT_EMAIL` or `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

The family calendar ID already matches the calendar created in this workspace:

`0549d8693f971d591421d2c74b77a1dccab5e4031d6dc91417e272e25267f13c@group.calendar.google.com`

### 3. Prepare OpenAI access

Set `OPENAI_API_KEY`.

The bot uses:

- `gpt-4o-mini-transcribe` for speech-to-text
- `gpt-4.1-mini` for extracting event fields into structured JSON

### 4. Voice support

Telegram voice notes usually arrive as `ogg/opus`.
Install `ffmpeg` on the machine that runs the bot, or point `FFMPEG_PATH` to a valid binary.

### 5. Run locally

```bash
cd /Users/volialogvinenko/Documents/Playground/family-calendar-telegram-bot
cp .env.example .env
node --env-file=.env src/index.mjs
```

By default the bot runs in polling mode when `PORT` is not set.

### 6. Run permanently on Google Cloud Run

Recommended production shape:

- set `BOT_MODE=webhook`
- deploy the folder to Cloud Run
- expose the bot through HTTPS
- configure Telegram webhook to point at `https://YOUR_CLOUD_RUN_URL/telegram/webhook`
- pass `secret_token` to Telegram and the same value in `TELEGRAM_WEBHOOK_SECRET`

Suggested Cloud Run settings:

- `min-instances=1`
- `max-instances=1`
- keep secrets out of source deploys and pass them through Secret Manager

The bot already includes:

- `GET /healthz` for health checks
- `POST /telegram/webhook` for Telegram updates
- webhook secret verification through `X-Telegram-Bot-Api-Secret-Token`
- automatic `setWebhook` on startup when `PUBLIC_BASE_URL` is set

Minimal production env:

- `BOT_MODE=webhook`
- `PUBLIC_BASE_URL=https://YOUR_CLOUD_RUN_URL`
- `TELEGRAM_WEBHOOK_PATH=/telegram/webhook`
- `TELEGRAM_WEBHOOK_SECRET=some-long-random-string`
- `GOOGLE_SERVICE_ACCOUNT_JSON_PATH=/secrets/service-account.json` or the equivalent env pair

This repo also includes a simple `Dockerfile`, so it can be deployed as a standard container.

### 7. One-command Cloud Shell deploy

If you have the full folder locally with `.env` and `service-account.json`, upload that folder to Cloud Shell and run:

```bash
cd family-calendar-telegram-bot
chmod +x deploy-cloud-run.sh
./deploy-cloud-run.sh
```

The script will:

- deploy the bot to Cloud Run
- keep one warm instance running
- set the public URL back into the service
- configure Telegram webhook automatically on the next revision start

## How it behaves

- If the bot is confident, it creates one or more events immediately.
- If key details are missing, it asks a clarifying question and waits for the reply in the same chat.
- For timed events without an end time, it uses `DEFAULT_EVENT_DURATION_MINUTES`.
- Before inserting an event, it checks the target calendar for a matching event with the same title and time window to reduce duplicates.

## Example messages

- `10 июня пикник в садике в 15:00`
- `22 июня балет, гала, в 16:30`
- `12 czerwca urodziny Bereni, Kępa Potocka, 16:30`
- voice note in Russian or Polish with the same information

## Files

- [src/index.mjs](/Users/volialogvinenko/Documents/Playground/family-calendar-telegram-bot/src/index.mjs)
- [.gcloudignore](/Users/volialogvinenko/Documents/Playground/family-calendar-telegram-bot/.gcloudignore)
