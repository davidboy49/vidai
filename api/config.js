import { getConfig, saveConfig, verifyToken } from "./_db.js";

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function parseBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }
  if (typeof req.body === "string" && req.body.length > 0) {
    return JSON.parse(req.body);
  }
  const raw = await readRawBody(req);
  if (!raw) return null;
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  // Set CORS headers for the dashboard (especially if running in different dev ports)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-User, X-Admin-Token, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // Authentication check
  const username = req.headers["x-admin-user"];
  const token = req.headers["x-admin-token"];

  const isAuthorized = await verifyToken(username, token);
  if (!isAuthorized) {
    res.status(401).json({ error: "Unauthorized. Invalid admin session." });
    return;
  }

  try {
    if (req.method === "GET") {
      const config = await getConfig();
      res.status(200).json(config);
      return;
    }

    if (req.method === "POST") {
      const body = await parseBody(req);
      if (!body) {
        res.status(400).json({ error: "Invalid payload: empty body" });
        return;
      }

      await saveConfig(body);
      res.status(200).json({ success: true, message: "Configuration saved successfully." });
      return;
    }

    res.status(405).json({ error: "Method Not Allowed" });
  } catch (error) {
    console.error("Error handling config API request:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
}
