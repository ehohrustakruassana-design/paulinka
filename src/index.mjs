import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR || (process.env.K_SERVICE ? "/tmp/family-calendar-bot-data" : path.join(ROOT_DIR, "data"));
const TMP_DIR = process.env.TMP_DIR || (process.env.K_SERVICE ? "/tmp/family-calendar-bot-tmp" : path.join(ROOT_DIR, "tmp"));
const STATE_PATH = path.join(DATA_DIR, "state.json");

const CONFIG = await loadConfig();
const TELEGRAM_API = `https://api.telegram.org/bot${CONFIG.telegramBotToken}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${CONFIG.telegramBotToken}`;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

let state = {
  lastUpdateId: 0,
  pendingClarifications: {}
};

async function main() {
  await ensureDirectories();
  state = await loadState();

  if (CONFIG.mode === "webhook") {
    await startWebhookServer();
    return;
  }

  await startPollingLoop();
}

async function loadConfig() {
  const required = ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "GOOGLE_CALENDAR_ID"];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  let serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
  let serviceAccountPrivateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "";
  const serviceAccountJsonInline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
  const serviceAccountJsonPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH || "";

  if (serviceAccountJsonInline || serviceAccountJsonPath) {
    const rawJson = serviceAccountJsonInline || await fs.readFile(serviceAccountJsonPath, "utf-8");
    const parsedJson = JSON.parse(rawJson);
    serviceAccountEmail = parsedJson.client_email || serviceAccountEmail;
    serviceAccountPrivateKey = parsedJson.private_key || serviceAccountPrivateKey;
  }

  if (!serviceAccountEmail || !serviceAccountPrivateKey) {
    throw new Error(
      "Missing Google service account credentials. Set GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_JSON_PATH, or both GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY."
    );
  }

  return {
    mode: resolveBotMode(),
    port: Number(process.env.PORT || 8080),
    publicBaseUrl: normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || ""),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramWebhookPath: normalizeWebhookPath(process.env.TELEGRAM_WEBHOOK_PATH || "/telegram/webhook"),
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
    openAiApiKey: process.env.OPENAI_API_KEY,
    googleCalendarId: process.env.GOOGLE_CALENDAR_ID,
    googleServiceAccountEmail: serviceAccountEmail,
    googleServiceAccountPrivateKey: serviceAccountPrivateKey.replace(/\\n/g, "\n"),
    timezone: process.env.BOT_TIMEZONE || "Europe/Warsaw",
    language: process.env.BOT_LANGUAGE || "ru",
    defaultDurationMinutes: Number(process.env.DEFAULT_EVENT_DURATION_MINUTES || 60),
    openAiTextModel: process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini",
    openAiTranscribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg"
  };
}

async function ensureDirectories() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
}

function resolveBotMode() {
  const raw = String(process.env.BOT_MODE || "").trim().toLowerCase();
  if (raw === "polling" || raw === "webhook") {
    return raw;
  }

  return process.env.PORT ? "webhook" : "polling";
}

function normalizeWebhookPath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "/telegram/webhook";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizePublicBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      lastUpdateId: parsed.lastUpdateId || 0,
      pendingClarifications: parsed.pendingClarifications || {}
    };
  } catch {
    return {
      lastUpdateId: 0,
      pendingClarifications: {}
    };
  }
}

async function saveState() {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function startWebhookServer() {
  const server = http.createServer(async (request, response) => {
    try {
      await handleHttpRequest(request, response);
    } catch (error) {
      console.error("Webhook server error:", error);
      writeJson(response, 500, { ok: false });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(CONFIG.port, "0.0.0.0", resolve);
  });

  console.log(
    `Family calendar bot is running in webhook mode on port ${CONFIG.port} (${CONFIG.telegramWebhookPath}).`
  );

  if (CONFIG.publicBaseUrl) {
    await ensureTelegramWebhook();
  } else {
    console.warn("PUBLIC_BASE_URL is not set. Telegram webhook was not configured automatically.");
  }
}

async function handleHttpRequest(request, response) {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/healthz")) {
    writeJson(response, 200, {
      ok: true,
      mode: CONFIG.mode,
      webhook_path: CONFIG.telegramWebhookPath
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === CONFIG.telegramWebhookPath) {
    if (!isValidTelegramWebhookRequest(request)) {
      writeJson(response, 401, { ok: false });
      return;
    }

    const rawBody = await readRequestBody(request);
    const update = rawBody ? JSON.parse(rawBody) : {};
    await handleUpdate(update);
    writeJson(response, 200, { ok: true });
    return;
  }

  writeJson(response, 404, { ok: false });
}

async function readRequestBody(request) {
  return await new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Webhook payload too large."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function isValidTelegramWebhookRequest(request) {
  if (!CONFIG.telegramWebhookSecret) {
    return true;
  }

  return request.headers["x-telegram-bot-api-secret-token"] === CONFIG.telegramWebhookSecret;
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function startPollingLoop() {
  console.log("Family calendar bot is running in polling mode.");

  while (true) {
    try {
      const updates = await getTelegramUpdates(state.lastUpdateId + 1);
      for (const update of updates) {
        await handleUpdate(update);
        state.lastUpdateId = Math.max(state.lastUpdateId, update.update_id);
        await saveState();
      }
    } catch (error) {
      console.error("Main loop error:", error);
      await sleep(3000);
    }
  }
}

async function getTelegramUpdates(offset) {
  const response = await fetchJson(`${TELEGRAM_API}/getUpdates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      offset,
      timeout: 50,
      allowed_updates: ["message"]
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram getUpdates failed: ${JSON.stringify(response)}`);
  }

  return response.result || [];
}

async function ensureTelegramWebhook() {
  const webhookUrl = `${CONFIG.publicBaseUrl}${CONFIG.telegramWebhookPath}`;
  const response = await fetchJson(`${TELEGRAM_API}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: CONFIG.telegramWebhookSecret || undefined,
      allowed_updates: ["message"]
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram setWebhook failed: ${JSON.stringify(response)}`);
  }

  console.log(`Telegram webhook is configured: ${webhookUrl}`);
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message?.chat?.id) {
    return;
  }

  const chatId = String(message.chat.id);

  try {
    if (message.text === "/start" || message.text === "/help") {
      await sendTelegramMessage(
        chatId,
        [
          "Присылай событие текстом или голосом.",
          "Примеры:",
          "10 июня пикник в садике в 15:00",
          "22 июня балет, гала, в 16:30",
          "Можно по-русски или по-польски."
        ].join("\n")
      );
      return;
    }

    const extractedText = await extractMessageText(message);
    if (!extractedText?.trim()) {
      await sendTelegramMessage(chatId, "Не вижу текста события. Пришли текст или голосовое сообщение.");
      return;
    }

    const pending = state.pendingClarifications[chatId];
    const parseInput = pending
      ? buildClarificationPrompt(pending.originalInput, extractedText)
      : extractedText;

    const parsed = await extractEventsWithOpenAI(parseInput);

    if (parsed.needs_clarification) {
      state.pendingClarifications[chatId] = {
        originalInput: pending ? `${pending.originalInput}\nОтвет пользователя: ${extractedText}` : extractedText,
        question: parsed.clarification_question || "Уточни, пожалуйста, дату или время события."
      };
      await saveState();
      await sendTelegramMessage(
        chatId,
        parsed.clarification_question || "Уточни, пожалуйста, дату или время события.",
        {
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "Например: 10 июня в 15:00"
          }
        }
      );
      return;
    }

    delete state.pendingClarifications[chatId];
    await saveState();

    if (!Array.isArray(parsed.events) || parsed.events.length === 0) {
      await sendTelegramMessage(chatId, "Не смог понять событие. Попробуй написать его короче: дата, время, что это.");
      return;
    }

    const created = [];
    const skipped = [];

    for (const rawEvent of parsed.events) {
      const normalizedEvent = normalizeEvent(rawEvent);
      validateNormalizedEvent(normalizedEvent);

      const duplicate = await findDuplicateEvent(normalizedEvent);

      if (duplicate) {
        skipped.push(`Пропустил дубль: ${normalizedEvent.title} (${formatHumanEvent(normalizedEvent)})`);
        continue;
      }

      const createdEvent = await createCalendarEvent(normalizedEvent);
      created.push(createdEvent);
    }

    const lines = [];
    if (created.length > 0) {
      lines.push("Добавил в календарь `Семья`:");
      for (const event of created) {
        lines.push(`- ${event.summary}: ${formatEventSummary(event)}`);
      }
    }
    if (skipped.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(...skipped);
    }
    if (lines.length === 0) {
      lines.push("Новых событий не добавил.");
    }

    await sendTelegramMessage(chatId, lines.join("\n"));
  } catch (error) {
    console.error("Update handling error:", error);
    await sendTelegramMessage(
      chatId,
      "Не получилось обработать сообщение. Проверь, пожалуйста, что в нём есть дата и событие. Если это голосовое, ещё нужен ffmpeg на сервере."
    ).catch(() => {});
  }
}

function buildClarificationPrompt(originalInput, reply) {
  return [
    "Ниже исходное сообщение пользователя и уточнение.",
    "Собери из них итоговые события.",
    "",
    "Исходное сообщение:",
    originalInput,
    "",
    "Уточнение пользователя:",
    reply
  ].join("\n");
}

async function extractMessageText(message) {
  if (message.text?.trim()) {
    return message.text.trim();
  }

  if (message.caption?.trim()) {
    return message.caption.trim();
  }

  const voiceLike = message.voice || message.audio || message.document;
  if (!voiceLike?.file_id) {
    return "";
  }

  const downloaded = await downloadTelegramFile(voiceLike.file_id, voiceLike.mime_type || "");
  const preparedAudio = await prepareAudioForTranscription(downloaded);
  const transcript = await transcribeAudio(preparedAudio.buffer, preparedAudio.filename, preparedAudio.mimeType);

  await cleanupFile(downloaded.localPath);
  if (preparedAudio.localPath && preparedAudio.localPath !== downloaded.localPath) {
    await cleanupFile(preparedAudio.localPath);
  }

  return transcript.trim();
}

async function downloadTelegramFile(fileId, hintedMimeType = "") {
  const fileResponse = await fetchJson(`${TELEGRAM_API}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId })
  });

  if (!fileResponse.ok || !fileResponse.result?.file_path) {
    throw new Error(`Could not fetch Telegram file info: ${JSON.stringify(fileResponse)}`);
  }

  const remotePath = fileResponse.result.file_path;
  const fileUrl = `${TELEGRAM_FILE_API}/${remotePath}`;
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Could not download Telegram file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = path.extname(remotePath) || ".bin";
  const localPath = path.join(TMP_DIR, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  await fs.writeFile(localPath, buffer);

  return {
    buffer,
    localPath,
    filename: path.basename(localPath),
    sourceMimeType: hintedMimeType
  };
}

async function prepareAudioForTranscription(downloaded) {
  const ext = path.extname(downloaded.localPath).toLowerCase();
  const requiresConversion = new Set([".oga", ".opus"]);
  const supported = new Map([
    [".mp3", "audio/mpeg"],
    [".mp4", "audio/mp4"],
    [".mpeg", "audio/mpeg"],
    [".mpga", "audio/mpeg"],
    [".m4a", "audio/mp4"],
    [".aac", "audio/aac"],
    [".flac", "audio/flac"],
    [".ogg", "audio/ogg"],
    [".wav", "audio/wav"],
    [".webm", "audio/webm"]
  ]);

  const mimeType = supported.get(ext) || normalizeSupportedAudioMimeType(downloaded.sourceMimeType);

  if (mimeType && !requiresConversion.has(ext)) {
    return {
      buffer: await fs.readFile(downloaded.localPath),
      filename: path.basename(downloaded.localPath),
      mimeType,
      localPath: downloaded.localPath
    };
  }

  const wavPath = path.join(TMP_DIR, `${path.basename(downloaded.localPath, ext)}.wav`);
  await convertAudioToWav(downloaded.localPath, wavPath);

  return {
    buffer: await fs.readFile(wavPath),
    filename: path.basename(wavPath),
    mimeType: "audio/wav",
    localPath: wavPath
  };
}

function normalizeSupportedAudioMimeType(mimeType) {
  const normalized = String(mimeType || "").trim().toLowerCase();
  const supported = new Map([
    ["audio/mpeg", "audio/mpeg"],
    ["audio/mp3", "audio/mpeg"],
    ["audio/mp4", "audio/mp4"],
    ["audio/x-m4a", "audio/mp4"],
    ["audio/aac", "audio/aac"],
    ["audio/flac", "audio/flac"],
    ["audio/ogg", "audio/ogg"],
    ["audio/wav", "audio/wav"],
    ["audio/x-wav", "audio/wav"],
    ["audio/webm", "audio/webm"]
  ]);

  return supported.get(normalized) || "";
}

async function convertAudioToWav(inputPath, outputPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(CONFIG.ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      outputPath
    ]);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `Не удалось запустить ffmpeg. Установи ffmpeg или проверь FFMPEG_PATH. ${error.message}`
        )
      );
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg завершился с кодом ${code}: ${stderr}`));
      }
    });
  });
}

async function transcribeAudio(buffer, filename, mimeType) {
  const form = new FormData();
  form.append("model", CONFIG.openAiTranscribeModel);
  form.append("file", new File([buffer], filename, { type: mimeType }));

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.openAiApiKey}`
    },
    body: form
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed: ${await response.text()}`);
  }

  const json = await response.json();
  return json.text || "";
}

async function extractEventsWithOpenAI(inputText) {
  const today = new Date();
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      needs_clarification: { type: "boolean" },
      clarification_question: { type: "string" },
      events: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            date: { type: "string" },
            start_time: { type: "string" },
            end_date: { type: "string" },
            end_time: { type: "string" },
            all_day: { type: "boolean" },
            location: { type: "string" },
            description: { type: "string" }
          },
          required: ["title", "date", "start_time", "end_date", "end_time", "all_day", "location", "description"]
        }
      }
    },
    required: ["needs_clarification", "clarification_question", "events"]
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.openAiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: CONFIG.openAiTextModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "You extract family calendar events from user messages.",
                "The user may write in Russian, Polish, or mixed language.",
                `Assume timezone ${CONFIG.timezone}.`,
                `Today's date is ${today.toISOString().slice(0, 10)}.`,
                "Return one or more concrete calendar events when possible.",
                "Use ISO date format YYYY-MM-DD.",
                "Use 24-hour time HH:MM.",
                "If an event is all-day, set all_day=true and leave start_time/end_time empty strings.",
                "If end_date is the same as date, repeat the same date in end_date.",
                "If end_time is unknown for a timed event, leave it empty and the caller will apply a default duration.",
                "If key information is too ambiguous to create an event safely, set needs_clarification=true and ask one short follow-up question in Russian."
              ].join(" ")
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: inputText
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "calendar_event_extraction",
          strict: true,
          schema
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI event extraction failed: ${await response.text()}`);
  }

  const json = await response.json();
  const outputText = extractResponseText(json);
  if (!outputText) {
    throw new Error(`OpenAI response missing output_text: ${JSON.stringify(json)}`);
  }

  return JSON.parse(outputText);
}


function extractResponseText(responseJson) {
  if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  const parts = [];

  for (const item of responseJson?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }

  return parts.join("\n").trim();
}

function normalizeEvent(event) {
  const date = event.date;
  const endDate = event.end_date || date;
  const allDay = Boolean(event.all_day);
  const title = cleanText(event.title || "Событие");
  const location = cleanText(event.location || "");
  const description = cleanText(event.description || "");

  if (allDay) {
    return {
      title,
      description,
      location,
      allDay: true,
      startDate: date,
      endDate
    };
  }

  const startTime = event.start_time || "09:00";
  const endTime = event.end_time || addMinutesToTime(startTime, CONFIG.defaultDurationMinutes);

  return {
    title,
    description,
    location,
    allDay: false,
    startDate: date,
    endDate,
    startTime,
    endTime
  };
}

function validateNormalizedEvent(event) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.startDate)) {
    throw new Error(`Invalid event start date: ${event.startDate}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.endDate)) {
    throw new Error(`Invalid event end date: ${event.endDate}`);
  }
  if (event.allDay) {
    return;
  }
  if (!/^\d{2}:\d{2}$/.test(event.startTime)) {
    throw new Error(`Invalid event start time: ${event.startTime}`);
  }
  if (!/^\d{2}:\d{2}$/.test(event.endTime)) {
    throw new Error(`Invalid event end time: ${event.endTime}`);
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function addMinutesToTime(time, minutesToAdd) {
  const [hours, minutes] = time.split(":").map(Number);
  const total = hours * 60 + minutes + minutesToAdd;
  const normalized = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const resultHours = Math.floor(normalized / 60);
  const resultMinutes = normalized % 60;
  return `${String(resultHours).padStart(2, "0")}:${String(resultMinutes).padStart(2, "0")}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createCalendarEvent(event) {
  const accessToken = await getGoogleAccessToken();
  const body = buildCalendarEventBody(event);

  const response = await fetchJson(
    `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(CONFIG.googleCalendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  if (response.error) {
    throw new Error(`Google Calendar insert failed: ${JSON.stringify(response)}`);
  }

  return response;
}

async function findDuplicateEvent(event) {
  const accessToken = await getGoogleAccessToken();
  const { timeMin, timeMax } = buildSearchWindow(event);

  const params = new URLSearchParams({
    singleEvents: "true",
    timeMin,
    timeMax,
    maxResults: "20",
    orderBy: "startTime"
  });

  const response = await fetchJson(
    `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(CONFIG.googleCalendarId)}/events?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const items = response.items || [];
  return items.find((item) => isSameEvent(item, event)) || null;
}

function buildSearchWindow(event) {
  if (event.allDay) {
    return {
      timeMin: new Date(`${event.startDate}T00:00:00+00:00`).toISOString(),
      timeMax: new Date(`${addDays(event.endDate, 1)}T00:00:00+00:00`).toISOString()
    };
  }

  return {
    timeMin: new Date(`${event.startDate}T00:00:00+00:00`).toISOString(),
    timeMax: new Date(`${event.endDate}T23:59:59+00:00`).toISOString()
  };
}

function isSameEvent(existing, candidate) {
  const existingTitle = cleanText(existing.summary || "").toLowerCase();
  const candidateTitle = cleanText(candidate.title).toLowerCase();
  if (existingTitle !== candidateTitle) {
    return false;
  }

  if (candidate.allDay) {
    return (
      existing.start?.date === candidate.startDate &&
      existing.end?.date === addDays(candidate.endDate, 1)
    );
  }

  const existingStart = existing.start?.dateTime?.slice(0, 16);
  const existingEnd = existing.end?.dateTime?.slice(0, 16);
  const candidateStart = `${candidate.startDate}T${candidate.startTime}`;
  const candidateEnd = `${candidate.endDate}T${candidate.endTime}`;

  return existingStart === candidateStart && existingEnd === candidateEnd;
}

function buildCalendarEventBody(event) {
  const body = {
    summary: event.title
  };

  if (event.description) {
    body.description = event.description;
  }
  if (event.location) {
    body.location = event.location;
  }

  if (event.allDay) {
    body.start = { date: event.startDate };
    body.end = { date: addDays(event.endDate, 1) };
    return body;
  }

  body.start = {
    dateTime: `${event.startDate}T${event.startTime}:00`,
    timeZone: CONFIG.timezone
  };
  body.end = {
    dateTime: `${event.endDate}T${event.endTime}:00`,
    timeZone: CONFIG.timezone
  };
  return body;
}

let googleAccessTokenCache = {
  token: null,
  expiresAt: 0
};

async function getGoogleAccessToken() {
  const now = Date.now();
  if (googleAccessTokenCache.token && now < googleAccessTokenCache.expiresAt - 60_000) {
    return googleAccessTokenCache.token;
  }

  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + 3600;

  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: CONFIG.googleServiceAccountEmail,
      scope: CALENDAR_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: issuedAt,
      exp: expiresAt
    })
  );

  const assertionInput = `${header}.${payload}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(assertionInput)
    .sign(CONFIG.googleServiceAccountPrivateKey);
  const assertion = `${assertionInput}.${base64UrlEncode(signature)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${await response.text()}`);
  }

  const json = await response.json();
  googleAccessTokenCache = {
    token: json.access_token,
    expiresAt: now + Number(json.expires_in || 3600) * 1000
  };

  return googleAccessTokenCache.token;
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sendTelegramMessage(chatId, text, extra = {}) {
  const response = await fetchJson(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: Number(chatId),
      text,
      ...extra
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${JSON.stringify(response)}`);
  }
}

function formatEventSummary(event) {
  if (event.start?.date && event.end?.date) {
    const endDate = addDays(event.end.date, -1);
    if (event.start.date === endDate) {
      return `${event.start.date}, весь день`;
    }
    return `${event.start.date} - ${endDate}, весь день`;
  }

  const start = event.start?.dateTime?.slice(0, 16).replace("T", " ");
  const end = event.end?.dateTime?.slice(11, 16);
  return `${start} - ${end}`;
}

function formatHumanEvent(event) {
  if (event.allDay) {
    return `${event.startDate}, весь день`;
  }
  return `${event.startDate} ${event.startTime}-${event.endTime}`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  return json;
}

async function cleanupFile(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
