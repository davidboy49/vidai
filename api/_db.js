import fs from "fs";
import path from "path";

const DEFAULT_CONFIG = {
  hfModel: "mistralai/Mistral-7B-Instruct-v0.2:featherless-ai",
  restrictToAdmins: false,
  allowedUserIds: "",
  disabledFeatures: [],
  commandCooldown: 5, // Default cooldown in seconds
  chitchatLimitCount: 5,
  chitchatLimitWindow: 120,
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

// Local file configuration for development persistence
const localConfigPath = path.join(process.cwd(), "config.json");

/**
 * Returns true if Vercel KV env vars are configured.
 */
function hasKV() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

/**
 * Fetches the current configuration.
 */
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

  // Fallback to local configuration file in development
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

  // In-memory fallback
  return inMemoryConfig;
}

/**
 * Saves a new configuration.
 */
export async function saveConfig(newConfig) {
  // Merge deep structure properly
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
      if (response.ok) {
        return true;
      }
      console.error("Vercel KV returned non-200 status:", response.status);
    } catch (err) {
      console.error("Error saving configuration to Vercel KV:", err);
    }
  }

  // Persist to local config file
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
