import fs from "fs";
import path from "path";
import crypto from "crypto";

const DEFAULT_CONFIG = {
  hfModel: "mistralai/Mistral-7B-Instruct-v0.2:featherless-ai",
  restrictToAdmins: false,
  allowedUserIds: "",
  disabledFeatures: [],
  commandCooldown: 5,
  chitchatLimitCount: 5,
  chitchatLimitWindow: 120,
  profiles: [],
  activeProfileId: "",
  systemPrompts: {
    activity: "Look at the last 3 messages and provide one-line activity highlights.",
    summary: "Look at the last 3 messages and provide a one-line TL;DR summary.",
    quote: "Generate one short quote from the requested tradition (Greek, Chinese, or Stoic) and include the author. Prefer real, well-known quotes when possible. Format exactly as: \"<quote>\" — <author>.",
    mood: "Analyze the emotional tone of these messages. Respond with a single emoji representing the overall mood, followed by a one-line description. Keep it short and fun.",
    roast: "Give a short, playful, lighthearted roast of the chat activity. Be funny but not mean-spirited. Keep it under 3 sentences.",
    chitchat: "You are Vidai, a professional, objective, and polite AI assistant in a Telegram group chat. Provide clear, direct, and concise responses (1 to 3 sentences max). Maintain a helpful yet formal tone. Avoid overly casual language, excessive emoji, or conversational filler."
  }
};

let inMemoryConfig = { ...DEFAULT_CONFIG };

// Local file configuration paths for development persistence
const localConfigPath = path.join(process.cwd(), "config.json");
const localUsersPath = path.join(process.cwd(), "users.json");
const localChatsPath = path.join(process.cwd(), "chats.json");

// HMAC secret for signing tokens
const SECRET = process.env.ADMIN_PASSWORD || "vidai-secret-key-123456";

/**
 * Returns true if Vercel KV env vars are configured.
 */
function hasKV() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

/* ------------------------------------------------------------------ */
/*  Security Helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Generates SHA-256 hash of a password.
 */
export function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

/**
 * Generates a stateless authentication token signed with the system secret.
 */
export function generateToken(username, passwordHash) {
  return crypto.createHmac("sha256", SECRET).update(`${username}:${passwordHash}`).digest("hex");
}

/**
 * Verifies if the provided token matches the expected credentials signature.
 */
export async function verifyToken(username, token) {
  if (!username || !token) return false;
  
  const users = await getUsers();
  let passwordHash = null;

  const matchedUser = users.find(u => u.username === username);
  if (matchedUser) {
    if (matchedUser.isActive === false) return false; // Account de-activated
    passwordHash = matchedUser.passwordHash;
  } else if (username === "admin") {
    // Out-of-the-box default admin fallback
    passwordHash = hashPassword(process.env.ADMIN_PASSWORD || "admin");
  }

  if (!passwordHash) return false;
  
  const expectedToken = generateToken(username, passwordHash);
  return token === expectedToken;
}

/* ------------------------------------------------------------------ */
/*  Configurations Store                                              */
/* ------------------------------------------------------------------ */

export async function getConfig() {
  if (hasKV()) {
    try {
      const response = await fetch(process.env.KV_REST_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(["GET", "vidai_config"])
      });
      if (response.ok) {
        const data = await response.json();
        if (data && data.result) {
          const parsed = JSON.parse(data.result);
          return {
            ...DEFAULT_CONFIG,
            ...parsed,
            systemPrompts: {
              ...DEFAULT_CONFIG.systemPrompts,
              ...(parsed.systemPrompts || {})
            }
          };
        }
      }
    } catch (err) {
      console.error("Error reading configuration from Vercel KV:", err);
    }
  }

  try {
    if (fs.existsSync(localConfigPath)) {
      const content = fs.readFileSync(localConfigPath, "utf8");
      const parsed = JSON.parse(content);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        systemPrompts: {
          ...DEFAULT_CONFIG.systemPrompts,
          ...(parsed.systemPrompts || {})
        }
      };
    }
  } catch (err) {
    console.error("Error reading local config file:", err);
  }

  return inMemoryConfig;
}

export async function saveConfig(newConfig) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...newConfig,
    systemPrompts: {
      ...DEFAULT_CONFIG.systemPrompts,
      ...(newConfig.systemPrompts || {})
    }
  };

  if (hasKV()) {
    try {
      const response = await fetch(process.env.KV_REST_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(["SET", "vidai_config", JSON.stringify(merged)])
      });
      if (response.ok) return true;
    } catch (err) {
      console.error("Error saving configuration to Vercel KV:", err);
    }
  }

  try {
    fs.writeFileSync(localConfigPath, JSON.stringify(merged, null, 2), "utf8");
    inMemoryConfig = merged;
    return true;
  } catch (err) {
    console.error("Error saving config locally:", err);
  }

  inMemoryConfig = merged;
  return true;
}

/* ------------------------------------------------------------------ */
/*  User Management Store                                             */
/* ------------------------------------------------------------------ */

export async function getUsers() {
  if (hasKV()) {
    try {
      const response = await fetch(process.env.KV_REST_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(["GET", "vidai_users"])
      });
      if (response.ok) {
        const data = await response.json();
        if (data && data.result) {
          return JSON.parse(data.result);
        }
      }
    } catch (err) {
      console.error("Error reading users from Vercel KV:", err);
    }
  }

  try {
    if (fs.existsSync(localUsersPath)) {
      const content = fs.readFileSync(localUsersPath, "utf8");
      return JSON.parse(content);
    }
  } catch (err) {
    console.error("Error reading local users file:", err);
  }

  // Seed with default admin if file doesn't exist
  return [{
    username: "admin",
    passwordHash: hashPassword(process.env.ADMIN_PASSWORD || "admin"),
    isActive: true
  }];
}

export async function saveUsers(users) {
  if (hasKV()) {
    try {
      const response = await fetch(process.env.KV_REST_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(["SET", "vidai_users", JSON.stringify(users)])
      });
      if (response.ok) return true;
    } catch (err) {
      console.error("Error saving users to Vercel KV:", err);
    }
  }

  try {
    fs.writeFileSync(localUsersPath, JSON.stringify(users, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("Error saving users locally:", err);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Chat Registry Store                                               */
/* ------------------------------------------------------------------ */

export async function getChats() {
  if (hasKV()) {
    try {
      const response = await fetch(process.env.KV_REST_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(["GET", "vidai_chats"])
      });
      if (response.ok) {
        const data = await response.json();
        if (data && data.result) {
          return JSON.parse(data.result);
        }
      }
    } catch (err) {
      console.error("Error reading chats from Vercel KV:", err);
    }
  }

  try {
    if (fs.existsSync(localChatsPath)) {
      const content = fs.readFileSync(localChatsPath, "utf8");
      return JSON.parse(content);
    }
  } catch (err) {
    console.error("Error reading local chats file:", err);
  }
  return {};
}

export async function registerChat(chatId, chatInfo) {
  const chats = await getChats();
  const idStr = String(chatId);

  const current = chats[idStr];
  if (current && current.title === chatInfo.title && current.type === chatInfo.type) {
    // Throttle writes: only update if timestamp is older than 1 hour (3600000 ms)
    if (Date.now() - (current.lastActiveAt || 0) < 3600000) {
      return true;
    }
  }

  chats[idStr] = {
    title: chatInfo.title,
    type: chatInfo.type,
    lastActiveAt: Date.now()
  };

  if (hasKV()) {
    try {
      const response = await fetch(process.env.KV_REST_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(["SET", "vidai_chats", JSON.stringify(chats)])
      });
      if (response.ok) return true;
    } catch (err) {
      console.error("Error saving chats registry to Vercel KV:", err);
    }
  }

  try {
    fs.writeFileSync(localChatsPath, JSON.stringify(chats, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("Error saving chats registry locally:", err);
  }
  return false;
}

export function getStorageType() {
  return hasKV() ? "Vercel KV" : "Local File Fallback (Stateless)";
}

export function isKVConnected() {
  return hasKV();
}
