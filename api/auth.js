import { getUsers, hashPassword, generateToken, verifyToken } from "./_db.js";

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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-User, X-Admin-Token, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    const body = await parseBody(req);
    const action = req.query.action || (body && body.action);

    if (action === "login") {
      if (!body || !body.username || !body.password) {
        res.status(400).json({ error: "Username and password are required." });
        return;
      }

      const { username, password } = body;
      const users = await getUsers();
      
      const passwordHash = hashPassword(password);
      const matchedUser = users.find(
        (u) => u.username.toLowerCase() === username.toLowerCase() && u.passwordHash === passwordHash
      );

      if (matchedUser) {
        if (matchedUser.isActive === false) {
          res.status(401).json({ error: "Your account is deactivated. Please contact the administrator." });
          return;
        }
        const token = generateToken(matchedUser.username, passwordHash);
        res.status(200).json({ success: true, username: matchedUser.username, token });
        return;
      }

      res.status(401).json({ error: "Incorrect username or password." });
      return;
    }

    if (action === "verify") {
      const username = req.headers["x-admin-user"] || (body && body.username);
      const token = req.headers["x-admin-token"] || (body && body.token);

      const isValid = await verifyToken(username, token);
      if (isValid) {
        res.status(200).json({ success: true });
        return;
      }

      res.status(401).json({ success: false, error: "Invalid session token." });
      return;
    }

    res.status(400).json({ error: "Invalid action. Supported actions: login, verify." });
  } catch (error) {
    console.error("Error in auth API:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
}
