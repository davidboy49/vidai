const MAX_MESSAGES = 50;
const MAX_INPUT_CHARS = 3500;
const botToken = "vck_5IwBRSw2ApFMBLFJo9y820nUgcfYfmfK3Y1xcJ8bxFcYigbcGH1RUd15"
function getChatCache() {
  if (!globalThis.__chatCache) {
    globalThis.__chatCache = new Map();
  }
  return globalThis.__chatCache;
}

function addMessageToCache(chatId, messageText) {
  const cache = getChatCache();
  const entry = cache.get(chatId) ?? { messages: [] };
  entry.messages.push(messageText);
  if (entry.messages.length > MAX_MESSAGES) {
    entry.messages = entry.messages.slice(-MAX_MESSAGES);
  }
  cache.set(chatId, entry);
}

function getMessagesForChat(chatId) {
  const cache = getChatCache();
  return cache.get(chatId)?.messages ?? [];
}

async function summarizeMessages(text, hfToken) {
  const response = await fetch(
    "https://api-inference.huggingface.co/models/facebook/bart-large-cnn",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hfToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: text,
        parameters: {
          max_length: 140,
          min_length: 40,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HF API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  if (!Array.isArray(data) || !data[0]?.summary_text) {
    throw new Error("Unexpected HF response format.");
  }

  return data[0].summary_text;
}

async function sendTelegramMessage(botToken, chatId, text) {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${errorText}`);
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function parseUpdate(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string" && req.body.length > 0) {
    return JSON.parse(req.body);
  }

  const raw = await readRawBody(req);
  if (!raw) {
    return null;
  }

  return JSON.parse(raw);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const hfToken = process.env.HF_TOKEN;

  if (!botToken || !hfToken) {
    res.status(500).send("Missing TELEGRAM_BOT_TOKEN or HF_TOKEN.");
    return;
  }

  let update;
  try {
    update = await parseUpdate(req);
  } catch (error) {
    res.status(400).send(`Invalid JSON payload: ${error.message}`);
    return;
  }

  if (!update) {
    res.status(200).send("No update payload.");
    return;
  }
  const message = update?.message;

  if (!message?.chat?.id) {
    res.status(200).send("No message to process.");
    return;
  }

  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (!text) {
    res.status(200).send("No text message.");
    return;
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  const commandRegex = botUsername
    ? new RegExp(`^/summary(@${botUsername})?(\\s|$)`, "i")
    : /^\/summary(\s|$)/i;
  const isSummaryCommand = commandRegex.test(text);

  if (!isSummaryCommand) {
    if (!message.from?.is_bot) {
      addMessageToCache(chatId, text);
    }
    res.status(200).send("Message cached.");
    return;
  }

  const cachedMessages = getMessagesForChat(chatId);
  if (cachedMessages.length === 0) {
    await sendTelegramMessage(
      botToken,
      chatId,
      "No messages to summarize yet."
    );
    res.status(200).send("No messages to summarize.");
    return;
  }

  const combined = cachedMessages.join("\n");
  const truncated = combined.slice(-MAX_INPUT_CHARS);

  try {
    const summary = await summarizeMessages(truncated, hfToken);
    await sendTelegramMessage(botToken, chatId, summary);
    res.status(200).send("Summary sent.");
  } catch (error) {
    await sendTelegramMessage(
      botToken,
      chatId,
      "Sorry, I couldn't generate a summary right now."
    );
    res.status(500).send(String(error));
  }
}
