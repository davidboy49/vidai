import OpenAI from "openai";

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const MAX_MESSAGES = 50;
const MAX_INPUT_CHARS = 3500;
const MAX_RECENT_QUOTES = 10;
const QUOTE_GENERATION_RETRIES = 4;
const QUOTE_TRADITIONS = ["Greek", "Chinese", "Stoic"];
const COMMAND_COOLDOWN_MS = 5_000; // 5 seconds between commands per chat

const TRADITION_EMOJI = {
  Greek: "🏛",
  Chinese: "🐉",
  Stoic: "🗿",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function pickRandomQuoteTradition() {
  return QUOTE_TRADITIONS[Math.floor(Math.random() * QUOTE_TRADITIONS.length)];
}

function getClient(hfToken) {
  return new OpenAI({
    baseURL: "https://router.huggingface.co/v1",
    apiKey: hfToken,
  });
}

/**
 * Escape special characters for Telegram HTML parse mode.
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ------------------------------------------------------------------ */
/*  In-memory cache                                                   */
/* ------------------------------------------------------------------ */

function getChatCache() {
  if (!globalThis.__chatCache) {
    globalThis.__chatCache = new Map();
  }
  return globalThis.__chatCache;
}

function getEntry(chatId) {
  const cache = getChatCache();
  if (!cache.has(chatId)) {
    cache.set(chatId, { messages: [], recentQuotes: [], lastCommandAt: 0 });
  }
  return cache.get(chatId);
}

/**
 * Store a message with sender attribution and timestamp so the LLM can
 * produce richer, context-aware summaries (e.g. "Alice discussed X").
 */
function addMessageToCache(chatId, from, text, timestamp) {
  const entry = getEntry(chatId);
  entry.messages.push({ from, text, timestamp });
  if (entry.messages.length > MAX_MESSAGES) {
    entry.messages = entry.messages.slice(-MAX_MESSAGES);
  }
}

function getMessagesForChat(chatId) {
  return getEntry(chatId).messages;
}

/* ------------------------------------------------------------------ */
/*  Quote dedup cache                                                 */
/* ------------------------------------------------------------------ */

function normalizeQuoteText(text) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function getRecentQuotesForChat(chatId) {
  return getEntry(chatId).recentQuotes;
}

function addRecentQuoteForChat(chatId, quoteText) {
  const entry = getEntry(chatId);
  entry.recentQuotes.push(normalizeQuoteText(quoteText));
  if (entry.recentQuotes.length > MAX_RECENT_QUOTES) {
    entry.recentQuotes = entry.recentQuotes.slice(-MAX_RECENT_QUOTES);
  }
}

/* ------------------------------------------------------------------ */
/*  Rate limiting (in-memory)                                         */
/* ------------------------------------------------------------------ */

/**
 * Returns the number of seconds remaining in the cooldown, or 0 if the
 * chat is allowed to run another command.
 */
function checkRateLimit(chatId) {
  const entry = getEntry(chatId);
  const elapsed = Date.now() - entry.lastCommandAt;
  if (elapsed < COMMAND_COOLDOWN_MS) {
    return Math.ceil((COMMAND_COOLDOWN_MS - elapsed) / 1000);
  }
  return 0;
}

function updateRateLimit(chatId) {
  getEntry(chatId).lastCommandAt = Date.now();
}

/* ------------------------------------------------------------------ */
/*  System prompts                                                    */
/* ------------------------------------------------------------------ */

function getSystemPrompt(commandType) {
  switch (commandType) {
    case "activity":
      return "Look at the last 3 messages and provide one-line activity highlights.";

    case "summary":
      return "Look at the last 3 messages and provide a one-line TL;DR summary.";

    case "quote":
      return (
        "Generate one short quote from the requested tradition (Greek, Chinese, or Stoic) and include the author. " +
        'Prefer real, well-known quotes when possible. Format exactly as: "<quote>" — <author>.'
      );

    case "mood":
      return (
        "Analyze the emotional tone of these messages. " +
        "Respond with a single emoji representing the overall mood, " +
        "followed by a one-line description. Keep it short and fun."
      );

    case "roast":
      return (
        "Give a short, playful, lighthearted roast of the chat activity. " +
        "Be funny but not mean-spirited. Keep it under 3 sentences."
      );

    default:
      return "Respond briefly and clearly.";
  }
}

/* ------------------------------------------------------------------ */
/*  LLM interaction                                                   */
/* ------------------------------------------------------------------ */

async function callLLM(text, hfToken, commandType) {
  const client = getClient(hfToken);
  const model =
    process.env.HF_MODEL ||
    "mistralai/Mistral-7B-Instruct-v0.2:featherless-ai";

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: getSystemPrompt(commandType) },
      { role: "user", content: text },
    ],
    max_tokens: 200,
    temperature: commandType === "roast" ? 0.8 : 0.3,
  });

  const result = completion?.choices?.[0]?.message?.content?.trim();
  if (!result) {
    throw new Error("Unexpected HF response format.");
  }
  return result;
}

/**
 * Generate a unique quote and return both the text and the tradition used,
 * so we can pick the right emoji reaction.
 */
async function generateQuote(hfToken, chatId) {
  const recentQuotes = getRecentQuotesForChat(chatId);

  for (let attempt = 0; attempt < QUOTE_GENERATION_RETRIES; attempt += 1) {
    const tradition = pickRandomQuoteTradition();
    const quote = await callLLM(
      `Please give me one random ${tradition} quote. Avoid repeating any of these recent quotes: ${recentQuotes.join(" | ") || "none"}.`,
      hfToken,
      "quote",
    );

    if (!recentQuotes.includes(normalizeQuoteText(quote))) {
      addRecentQuoteForChat(chatId, quote);
      return { quote, tradition };
    }
  }

  // Fallback after exhausting retries
  const fallbackTradition = pickRandomQuoteTradition();
  const fallbackQuote = await callLLM(
    `Please give me one random ${fallbackTradition} quote with author.`,
    hfToken,
    "quote",
  );
  addRecentQuoteForChat(chatId, fallbackQuote);
  return { quote: fallbackQuote, tradition: fallbackTradition };
}

/* ------------------------------------------------------------------ */
/*  Command parsing                                                   */
/* ------------------------------------------------------------------ */

const COMMANDS = ["summary", "activity", "quote", "help", "start", "mood", "roast"];

function getCommandType(text, botUsername) {
  const suffix = botUsername
    ? `(@${botUsername})?(\\s|$)`
    : "(\\s|$)";

  for (const cmd of COMMANDS) {
    if (new RegExp(`^/${cmd}${suffix}`, "i").test(text)) {
      // /start is treated as /help
      return cmd === "start" ? "help" : cmd;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Telegram API helpers                                              */
/* ------------------------------------------------------------------ */

/**
 * Show the "typing…" bubble in the chat. Wrapped in try/catch because
 * this is non-critical — we never want it to block or crash the handler.
 */
async function sendTypingAction(botToken, chatId) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch {
    // Swallow — typing indicator is cosmetic
  }
}

/**
 * Send a text message. If a parseMode is specified and the Telegram API
 * rejects it (e.g. malformed HTML), automatically retries as plain text.
 */
async function sendTelegramMessage(botToken, chatId, text, parseMode) {
  const payload = { chat_id: chatId, text };
  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    // If HTML/Markdown formatting caused the failure, retry as plain text
    if (parseMode && response.status === 400) {
      return sendTelegramMessage(botToken, chatId, text);
    }
    const errorText = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${errorText}`);
  }

  // Return the sent message ID (useful for reactions)
  try {
    const data = await response.json();
    return data?.result?.message_id;
  } catch {
    return undefined;
  }
}

/**
 * React to a message with an emoji. Non-critical, failures are swallowed.
 */
async function setMessageReaction(botToken, chatId, messageId, emoji) {
  try {
    await fetch(
      `https://api.telegram.org/bot${botToken}/setMessageReaction`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: "emoji", emoji }],
        }),
      },
    );
  } catch {
    // Non-critical
  }
}

/* ------------------------------------------------------------------ */
/*  Response formatting                                               */
/* ------------------------------------------------------------------ */

function formatResponse(commandType, text, tradition) {
  const escaped = escapeHtml(text);

  switch (commandType) {
    case "summary":
      return `📋 <b>Summary</b>\n\n${escaped}`;
    case "activity":
      return `🔥 <b>Recent Activity</b>\n\n${escaped}`;
    case "quote": {
      const emoji = tradition ? (TRADITION_EMOJI[tradition] ?? "") : "";
      return `💬 <i>${escaped}</i>\n\n${emoji}`;
    }
    case "mood":
      return `🎭 <b>Group Mood</b>\n\n${escaped}`;
    case "roast":
      return `🔥 <b>Chat Roast</b>\n\n${escaped}`;
    default:
      return escaped;
  }
}

function getHelpMessage() {
  return [
    "🤖 <b>Vidai Bot</b>",
    "",
    "Here's what I can do:",
    "",
    "/summary — TL;DR of recent chat messages",
    "/activity — Highlights of latest activity",
    "/quote — Random philosophical quote (Greek, Chinese, or Stoic)",
    "/mood — Analyze the group's current vibe",
    "/roast — Playful roast of recent chat activity 🔥",
    "/help — Show this help message",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  Body parsing                                                      */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Main handler                                                      */
/* ------------------------------------------------------------------ */

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

  // --- Parse the incoming Telegram update ---------------------------
  let update;
  try {
    update = await parseUpdate(req);
  } catch (error) {
    // Always 200 so Telegram doesn't retry indefinitely
    console.error("Invalid JSON payload:", error.message);
    res.status(200).send("Invalid JSON payload.");
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

  // --- Cache non-command messages with sender attribution -----------
  if (!commandType) {
    if (!message.from?.is_bot) {
      const senderName =
        message.from?.first_name ||
        message.from?.username ||
        "Unknown";
      addMessageToCache(chatId, senderName, text, message.date);
    }
    res.status(200).send("Message cached.");
    return;
  }

  // --- /help (no LLM needed) ---------------------------------------
  if (commandType === "help") {
    try {
      await sendTelegramMessage(botToken, chatId, getHelpMessage(), "HTML");
    } catch (err) {
      console.error("Failed to send help message.", err);
    }
    res.status(200).send("Help sent.");
    return;
  }

  // --- All remaining commands require HF_TOKEN ----------------------
  if (!hfToken) {
    console.error("Missing HF_TOKEN.");
    await sendTelegramMessage(
      botToken,
      chatId,
      "⚙️ HF_TOKEN is not configured — I can't process commands right now.",
    );
    res.status(200).send("Missing HF_TOKEN.");
    return;
  }

  // --- Rate limiting ------------------------------------------------
  const cooldownRemaining = checkRateLimit(chatId);
  if (cooldownRemaining > 0) {
    await sendTelegramMessage(
      botToken,
      chatId,
      `⏳ Please wait ${cooldownRemaining}s before using another command.`,
    );
    res.status(200).send("Rate limited.");
    return;
  }

  // --- Process command ----------------------------------------------
  try {
    await sendTypingAction(botToken, chatId);
    updateRateLimit(chatId);

    // ---- /quote ----------------------------------------------------
    if (commandType === "quote") {
      const { quote, tradition } = await generateQuote(hfToken, chatId);
      const formatted = formatResponse("quote", quote, tradition);
      await sendTelegramMessage(botToken, chatId, formatted, "HTML");

      // React to the user's command message with a tradition-appropriate emoji
      if (tradition && TRADITION_EMOJI[tradition]) {
        await setMessageReaction(
          botToken,
          chatId,
          message.message_id,
          TRADITION_EMOJI[tradition],
        );
      }

      res.status(200).send("Quote sent.");
      return;
    }

    // ---- Commands that need cached messages -------------------------
    const cachedMessages = getMessagesForChat(chatId);

    if (cachedMessages.length === 0) {
      const emptyMessages = {
        activity: "No recent activity to report yet.",
        summary: "No messages to summarize yet.",
        mood: "Not enough messages to read the room yet. 🤷",
        roast: "No messages to roast yet — you're all suspiciously quiet. 👀",
      };
      await sendTelegramMessage(
        botToken,
        chatId,
        emptyMessages[commandType] || "No messages yet.",
      );
      res.status(200).send("No messages.");
      return;
    }

    // Build the prompt with sender attribution for richer context
    const combined = cachedMessages
      .map((m) => `[${m.from}]: ${m.text}`)
      .join("\n");
    const truncated = combined.slice(-MAX_INPUT_CHARS);

    // If the command was sent as a reply, include that message as context
    let prompt = truncated;
    if (message.reply_to_message?.text) {
      const replyText = message.reply_to_message.text.slice(0, 500);
      prompt =
        `The user is asking about this specific message: "${replyText}"\n\n` +
        `Full chat context:\n${truncated}`;
    }

    const result = await callLLM(prompt, hfToken, commandType);
    const responseText = formatResponse(commandType, result);
    await sendTelegramMessage(botToken, chatId, responseText, "HTML");

    res.status(200).send(`${commandType} sent.`);
  } catch (error) {
    console.error(`Failed to process /${commandType}.`, error);

    // Give a friendlier message for rate-limit errors from the LLM provider
    const isRateLimit =
      error?.status === 429 || error?.message?.includes("429");
    const userMessage = isRateLimit
      ? "I'm a bit busy right now — try again in a moment ⏳"
      : `Sorry, I couldn't process /${commandType} right now. 😔`;

    try {
      await sendTelegramMessage(botToken, chatId, userMessage);
    } catch (sendErr) {
      console.error("Failed to send error message to Telegram.", sendErr);
    }

    // Always 200 to prevent Telegram retry storms
    res.status(200).send(`${commandType} failed.`);
  }
}
