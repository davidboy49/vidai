import OpenAI from "openai";

const MAX_MESSAGES = 50;
const MAX_INPUT_CHARS = 3500;
const QUOTE_TRADITIONS = ["Greek", "Chinese", "Stoic"];

function pickRandomQuoteTradition() {
  const randomIndex = Math.floor(Math.random() * QUOTE_TRADITIONS.length);
  return QUOTE_TRADITIONS[randomIndex];
}

function getClient(hfToken) {
  return new OpenAI({
    baseURL: "https://router.huggingface.co/v1",
    apiKey: hfToken,
  });
}

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

function getSystemPrompt(commandType) {
  if (commandType === "activity") {
    return "Look at the last 3 messages and provide one-line activity highlights.";
  }

  if (commandType === "summary") {
    return "Look at the last 3 messages and provide a one-line TL;DR summary.";
  }

  if (commandType === "quote") {
    return (
      "Generate one short quote from the requested tradition (Greek, Chinese, or Stoic) and include the author. " +
      "Prefer real, well-known quotes when possible. Format exactly as: \"<quote>\" — <author>."
    );
  }

  return "Respond briefly and clearly.";
}

async function summarizeMessages(text, hfToken, commandType) {
  const client = getClient(hfToken);
  const completion = await client.chat.completions.create({
    model: "mistralai/Mistral-7B-Instruct-v0.2:featherless-ai",
    messages: [
      {
        role: "system",
        content: getSystemPrompt(commandType),
      },
      {
        role: "user",
        content: text,
      },
    ],
    max_tokens: 200,
    temperature: 0.3,
  });

  const summary = completion?.choices?.[0]?.message?.content?.trim();
  if (!summary) {
    throw new Error("Unexpected HF response format.");
  }

  return summary;
}

async function generateQuote(hfToken) {
  const tradition = pickRandomQuoteTradition();
  return summarizeMessages(
    `Please give me one random ${tradition} quote.`,
    hfToken,
    "quote"
  );
}

function getCommandType(text, botUsername) {
  const basePattern = botUsername
    ? `(@${botUsername})?(\\s|$)`
    : "(\\s|$)";

  const summaryRegex = new RegExp(`^/summary${basePattern}`, "i");
  if (summaryRegex.test(text)) {
    return "summary";
  }

  const activityRegex = new RegExp(`^/activity${basePattern}`, "i");
  if (activityRegex.test(text)) {
    return "activity";
  }

  const quoteRegex = new RegExp(`^/quote${basePattern}`, "i");
  if (quoteRegex.test(text)) {
    return "quote";
  }

  return null;
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

  if (!botToken) {
    console.error("Missing TELEGRAM_BOT_TOKEN.");
    res.status(200).send("Missing TELEGRAM_BOT_TOKEN.");
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
  const commandType = getCommandType(text, botUsername);

  if (!commandType) {
    if (!message.from?.is_bot) {
      addMessageToCache(chatId, text);
    }
    res.status(200).send("Message cached.");
    return;
  }

  if (!hfToken) {
    console.error("Missing HF_TOKEN.");
    await sendTelegramMessage(
      botToken,
      chatId,
      "HF_TOKEN is not configured, so I can't process this command right now."
    );
    res.status(200).send("Missing HF_TOKEN.");
    return;
  }

  if (commandType === "quote") {
    try {
      const quote = await generateQuote(hfToken);
      await sendTelegramMessage(botToken, chatId, quote);
      res.status(200).send("Quote sent.");
    } catch (error) {
      console.error("Failed to generate quote.", error);
      await sendTelegramMessage(
        botToken,
        chatId,
        "Sorry, I couldn't generate a quote right now."
      );
      res.status(200).send("Quote failed.");
    }
    return;
  }

  const cachedMessages = getMessagesForChat(chatId);
  if (cachedMessages.length === 0) {
    const emptyMessage =
      commandType === "activity"
        ? "No recent activity to report yet."
        : "No messages to summarize yet.";
    await sendTelegramMessage(botToken, chatId, emptyMessage);
    res.status(200).send("No messages to summarize.");
    return;
  }

  const combined = cachedMessages.join("\n");
  const truncated = combined.slice(-MAX_INPUT_CHARS);

  try {
    const summary = await summarizeMessages(truncated, hfToken, commandType);
    await sendTelegramMessage(botToken, chatId, summary);
    res.status(200).send("Summary sent.");
  } catch (error) {
    console.error("Failed to summarize messages.", error);
    await sendTelegramMessage(
      botToken,
      chatId,
      "Sorry, I couldn't generate a summary right now."
    );
    res.status(200).send("Summary failed.");
  }
}
