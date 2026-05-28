import OpenAI from "openai";
import { getConfig, registerChat } from "./_db.js";

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

function getClient(apiKey, baseURL) {
  return new OpenAI({
    baseURL: baseURL || "https://router.huggingface.co/v1",
    apiKey: apiKey,
  });
}

function getAIConfig(config) {
  let aiConfig = {
    apiKey: process.env.HF_TOKEN,
    baseURL: "https://router.huggingface.co/v1",
    model: config.hfModel || "mistralai/Mistral-7B-Instruct-v0.2:featherless-ai"
  };

  if (config.profiles && config.activeProfileId) {
    const active = config.profiles.find(p => p.id === config.activeProfileId);
    if (active) {
      let apiKey = active.apiKey;
      if (!apiKey) {
        if (active.provider === "huggingface") {
          apiKey = process.env.HF_TOKEN;
        } else if (active.provider === "gemini") {
          apiKey = process.env.GEMINI_API_KEY;
        } else if (active.provider === "openai") {
          apiKey = process.env.OPENAI_API_KEY;
        }
      }
      aiConfig = {
        apiKey: apiKey,
        baseURL: active.baseURL || "https://router.huggingface.co/v1",
        model: active.model
      };
    }
  }

  return aiConfig;
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
    cache.set(chatId, { messages: [], recentQuotes: [], lastCommandAt: 0, userChitChat: {} });
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
function checkRateLimit(chatId, commandCooldownSeconds) {
  const cooldownMs = (commandCooldownSeconds ?? 5) * 1000;
  const entry = getEntry(chatId);
  const elapsed = Date.now() - entry.lastCommandAt;
  if (elapsed < cooldownMs) {
    return Math.ceil((cooldownMs - elapsed) / 1000);
  }
  return 0;
}

function updateRateLimit(chatId) {
  getEntry(chatId).lastCommandAt = Date.now();
}

/**
 * Returns "allow", "warn", or "silent" depending on the user's chit-chat rate.
 */
function checkUserChitChatLimit(chatId, userId, limitCount, limitWindowSeconds) {
  if (!userId) return "allow";
  const entry = getEntry(chatId);
  if (!entry.userChitChat) {
    entry.userChitChat = {};
  }
  if (!entry.userChitChat[userId]) {
    entry.userChitChat[userId] = [];
  }

  const limitCountVal = limitCount ?? 5;
  const limitWindowMs = (limitWindowSeconds ?? 120) * 1000;

  const now = Date.now();
  // Filter out timestamps older than the dynamic window
  entry.userChitChat[userId] = entry.userChitChat[userId].filter(
    (ts) => now - ts < limitWindowMs
  );

  // Record this message
  entry.userChitChat[userId].push(now);

  if (entry.userChitChat[userId].length > limitCountVal) {
    return "silent";
  }
  if (entry.userChitChat[userId].length === limitCountVal) {
    return "warn";
  }
  return "allow";
}

function isChitChatTrigger(message, text, botUsername) {
  if (message.chat?.type === "private") {
    return true;
  }
  if (!botUsername) return false;

  const mentionRegex = new RegExp(`@${botUsername}(\\s|$)`, "i");
  if (mentionRegex.test(text)) {
    return true;
  }

  if (message.reply_to_message?.from?.username?.toLowerCase() === botUsername.toLowerCase()) {
    return true;
  }

  return false;
}

function cleanChitChatText(text, botUsername) {
  if (!botUsername) return text;
  const mentionRegex = new RegExp(`@${botUsername}(\\s|$)`, "i");
  return text.replace(mentionRegex, "").trim();
}

function isUserWhitelisted(user, allowedUserIds) {
  if (!allowedUserIds) return true; // Whitelist disabled by default

  const allowedIds = allowedUserIds.split(",").map((id) => id.trim().toLowerCase().replace("@", ""));
  
  const userId = String(user?.id);
  const username = user?.username ? String(user.username).toLowerCase() : "";

  return allowedIds.includes(userId) || (username && allowedIds.includes(username));
}

function isFeatureDisabled(featureName, disabledFeatures) {
  if (!disabledFeatures || !Array.isArray(disabledFeatures)) return false;
  return disabledFeatures.some((f) => f.toLowerCase() === featureName.toLowerCase());
}

async function isChatAdmin(botToken, chatId, userId) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/getChatMember`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, user_id: userId }),
      },
    );
    if (!response.ok) return false;
    const data = await response.json();
    const status = data?.result?.status;
    return status === "administrator" || status === "creator";
  } catch (error) {
    console.error("Failed to check chat admin status:", error);
    return false;
  }
}

async function checkAdminRestriction(botToken, chat, user, restrictToAdmins) {
  if (!restrictToAdmins) {
    return true; // Not restricted
  }
  if (chat?.type === "private") {
    return true; // DMs have no admins, always allow
  }
  if (!user?.id) {
    return false;
  }
  return await isChatAdmin(botToken, chat.id, user.id);
}

/* ------------------------------------------------------------------ */
/*  System prompts                                                    */
/* ------------------------------------------------------------------ */

function getSystemPrompt(commandType, systemPrompts) {
  if (systemPrompts && systemPrompts[commandType]) {
    return systemPrompts[commandType];
  }

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

    case "chitchat":
      return (
        "You are Vidai, a professional, objective, and polite AI assistant in a Telegram group chat. " +
        "Provide clear, direct, and concise responses (1 to 3 sentences max). " +
        "Maintain a helpful yet formal tone. Avoid overly casual language, excessive emoji, or conversational filler."
      );

    default:
      return "Respond briefly and clearly.";
  }
}

/* ------------------------------------------------------------------ */
/*  LLM interaction                                                   */
/* ------------------------------------------------------------------ */

async function callLLM(text, aiConfig, commandType, systemPrompts) {
  const client = getClient(aiConfig.apiKey, aiConfig.baseURL);
  const model = aiConfig.model || "mistralai/Mistral-7B-Instruct-v0.2:featherless-ai";

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: getSystemPrompt(commandType, systemPrompts) },
      { role: "user", content: text },
    ],
    max_tokens: 200,
    temperature: commandType === "roast" ? 0.8 : 0.3,
  });

  const result = completion?.choices?.[0]?.message?.content?.trim();
  if (!result) {
    throw new Error("Unexpected LLM response format.");
  }
  return result;
}

/**
 * Generate a unique quote and return both the text and the tradition used,
 * so we can pick the right emoji reaction.
 */
async function generateQuote(aiConfig, chatId, systemPrompts) {
  const recentQuotes = getRecentQuotesForChat(chatId);

  for (let attempt = 0; attempt < QUOTE_GENERATION_RETRIES; attempt += 1) {
    const tradition = pickRandomQuoteTradition();
    const quote = await callLLM(
      `Please give me one random ${tradition} quote. Avoid repeating any of these recent quotes: ${recentQuotes.join(" | ") || "none"}.`,
      aiConfig,
      "quote",
      systemPrompts
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
    aiConfig,
    "quote",
    systemPrompts
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
async function sendTelegramMessage(botToken, chatId, text, parseMode, replyToMessageId) {
  const payload = { chat_id: chatId, text };
  if (parseMode) {
    payload.parse_mode = parseMode;
  }
  if (replyToMessageId) {
    payload.reply_parameters = { message_id: replyToMessageId };
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
      return sendTelegramMessage(botToken, chatId, text, null, replyToMessageId);
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

  if (!botToken) {
    console.error("Missing TELEGRAM_BOT_TOKEN.");
    res.status(200).send("Missing TELEGRAM_BOT_TOKEN.");
    return;
  }

  // --- Load configuration dynamically -------------------------------
  const config = await getConfig();
  const aiConfig = getAIConfig(config);

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

  // --- Register chat dynamically in database registry ---------------
  const chatTitle = message.chat.title || message.chat.username || message.chat.first_name || `Chat ${chatId}`;
  await registerChat(chatId, {
    title: chatTitle,
    type: message.chat.type
  });

  if (!text) {
    res.status(200).send("No text message.");
    return;
  }

  // --- Whitelist check ----------------------------------------------
  if (!isUserWhitelisted(message.from, config.allowedUserIds)) {
    res.status(200).send("User not whitelisted.");
    return;
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  const commandType = getCommandType(text, botUsername);

  // --- Feature disabled check ----------------------------------------
  if (commandType && isFeatureDisabled(commandType, config.disabledFeatures)) {
    await sendTelegramMessage(
      botToken,
      chatId,
      `សុំបិទម៉ាភ្លែតសិន ខ្ញុំមិនអាចប្រតិបត្តិការនេះបានទេ។\n⚙️ The /${commandType} command has been disabled by the administrator.`,
    );
    res.status(200).send("Command disabled.");
    return;
  }

  // --- Admin restriction check ---------------------------------------
  if (commandType) {
    const isAllowed = await checkAdminRestriction(
      botToken,
      message.chat,
      message.from,
      config.restrictToAdmins
    );
    if (!isAllowed) {
      // Fail silently to avoid group spam
      res.status(200).send("Restricted to admins.");
      return;
    }
  }

  // --- Cache non-command messages with sender attribution -----------
  if (!commandType) {
    if (!message.from?.is_bot) {
      const senderName =
        message.from?.first_name ||
        message.from?.username ||
        "Unknown";
      
      const cleanText = cleanChitChatText(text, botUsername);
      addMessageToCache(chatId, senderName, cleanText, message.date);

      if (isChitChatTrigger(message, text, botUsername)) {
        // Check if chit-chat feature is disabled
        if (isFeatureDisabled("chitchat", config.disabledFeatures)) {
          await sendTelegramMessage(
            botToken,
            chatId,
            "⚙️ Chit-chat has been disabled by the administrator.",
            null,
            message.message_id
          );
          res.status(200).send("Chit-chat disabled.");
          return;
        }

        // Check if chit-chat is restricted to admins
        const isAllowed = await checkAdminRestriction(
          botToken,
          message.chat,
          message.from,
          config.restrictToAdmins
        );
        if (!isAllowed) {
          res.status(200).send("Chit-chat restricted to admins.");
          return; // Silently ignore non-admin chit-chat triggers to prevent spam
        }

        if (!aiConfig.apiKey) {
          console.error("Missing AI API Key.");
          await sendTelegramMessage(
            botToken,
            chatId,
            "⚙️ AI API key is not configured — I can't chat right now.",
            null,
            message.message_id
          );
          res.status(200).send("Missing AI API Key.");
          return;
        }

        // Check if user is chatting too much (dynamic cooldown check)
        const chatLimitStatus = checkUserChitChatLimit(
          chatId,
          message.from?.id,
          config.chitchatLimitCount,
          config.chitchatLimitWindow
        );

        if (chatLimitStatus === "silent") {
          res.status(200).send("Chit-chat rate limited (silenced).");
          return;
        }

        if (chatLimitStatus === "warn") {
          await sendTelegramMessage(
            botToken,
            chatId,
            "និយាយច្រើនចឹង បង់ថ្លៃ token អោយញ៉ុមមែន?😊",
            null,
            message.message_id
          );
          res.status(200).send("Chit-chat rate limited (warned).");
          return;
        }

        try {
          await sendTypingAction(botToken, chatId);

          const cachedMessages = getMessagesForChat(chatId);
          const combined = cachedMessages
            .map((m) => `[${m.from}]: ${m.text}`)
            .join("\n");
          
          const prompt = `This is a live chat. Reply to the last message.\n\nChat History:\n${combined}`;
          
          const result = await callLLM(
            prompt,
            aiConfig,
            "chitchat",
            config.systemPrompts
          );
          
          await sendTelegramMessage(
            botToken,
            chatId,
            result,
            null,
            message.message_id
          );

          // Cache the bot's response to maintain conversation history
          const botName = botUsername || "Vidai";
          addMessageToCache(chatId, botName, result, Math.floor(Date.now() / 1000));
        } catch (error) {
          console.error("Failed to process chit-chat.", error);
          await sendTelegramMessage(
            botToken,
            chatId,
            "Sorry, I got a bit confused just now. 😵‍💫",
            null,
            message.message_id
          );
        }
      }
    }
    res.status(200).send("Message processed.");
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
  const cooldownRemaining = checkRateLimit(chatId, config.commandCooldown);
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
      const { quote, tradition } = await generateQuote(hfToken, chatId, config.systemPrompts, config.hfModel);
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

    const result = await callLLM(prompt, hfToken, commandType, config.systemPrompts, config.hfModel);
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
