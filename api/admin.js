import { verifyToken, getChats, getUsers, saveUsers, hashPassword, generateToken, getChatHistory } from "./_db.js";

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // Token Authorization Check
  const username = req.headers["x-admin-user"];
  const token = req.headers["x-admin-token"];

  const isAuthorized = await verifyToken(username, token);
  if (!isAuthorized) {
    res.status(401).json({ error: "Unauthorized. Invalid admin session." });
    return;
  }

  try {
    const action = req.query.action;
    const body = await parseBody(req);

    // --- GET METHODS -------------------------------------------------
    if (req.method === "GET") {
      if (action === "chats") {
        const chats = await getChats();
        res.status(200).json(chats);
        return;
      }

      if (action === "users") {
        const users = await getUsers();
        // Map to sanitize and hide password hashes
        const sanitized = users.map((u) => ({
          username: u.username,
          isActive: u.isActive !== false
        }));
        res.status(200).json(sanitized);
        return;
      }

      if (action === "chat-history") {
        const chatId = req.query.chatId;
        if (!chatId) {
          res.status(400).json({ error: "chatId is required." });
          return;
        }
        const history = await getChatHistory(chatId);
        res.status(200).json(history);
        return;
      }
    }

    // --- POST METHODS ------------------------------------------------
    if (req.method === "POST") {
      // 1. Send broadcast message
      if (action === "send-message") {
        if (!body || !body.chatId || !body.text) {
          res.status(400).json({ error: "chatId and text are required." });
          return;
        }

        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
          res.status(500).json({ error: "Bot token is not configured on the server." });
          return;
        }

        const telegramResponse = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: body.chatId,
              text: body.text
            })
          }
        );

        if (telegramResponse.ok) {
          res.status(200).json({ success: true, message: "Message broadcasted successfully." });
          return;
        }

        const errorText = await telegramResponse.text();
        res.status(400).json({ error: `Telegram returned error: ${errorText}` });
        return;
      }

      // 2. Create or Update user account
      if (action === "save-user") {
        if (!body || !body.targetUsername || !body.targetPassword) {
          res.status(400).json({ error: "Username and Password are required." });
          return;
        }

        const { targetUsername, targetPassword } = body;
        const users = await getUsers();

        const passwordHash = hashPassword(targetPassword);
        const index = users.findIndex(
          (u) => u.username.toLowerCase() === targetUsername.toLowerCase()
        );

        if (index >= 0) {
          // Update password
          users[index].passwordHash = passwordHash;
        } else {
          // Add new account
          users.push({ username: targetUsername, passwordHash, isActive: true });
        }

        await saveUsers(users);
        res.status(200).json({ success: true, message: `Account for ${targetUsername} successfully configured.` });
        return;
      }

      // 3. Delete user account
      if (action === "delete-user") {
        if (!body || !body.targetUsername) {
          res.status(400).json({ error: "targetUsername is required." });
          return;
        }

        const { targetUsername } = body;
        
        // Prevent deleting oneself
        if (targetUsername.toLowerCase() === username.toLowerCase()) {
          res.status(400).json({ error: "You cannot delete your own account while logged in." });
          return;
        }

        // Prevent deleting the main admin account fallback
        if (targetUsername.toLowerCase() === "admin") {
          res.status(400).json({ error: "The default fallback 'admin' account cannot be deleted." });
          return;
        }

        const users = await getUsers();
        const filtered = users.filter(
          (u) => u.username.toLowerCase() !== targetUsername.toLowerCase()
        );

        if (users.length === filtered.length) {
          res.status(404).json({ error: "User account not found." });
          return;
        }

        await saveUsers(filtered);
        res.status(200).json({ success: true, message: `Account for ${targetUsername} successfully removed.` });
        return;
      }

      // 4. Toggle account active/inactive status
      if (action === "toggle-user") {
        if (!body || !body.targetUsername) {
          res.status(400).json({ error: "targetUsername is required." });
          return;
        }

        const { targetUsername } = body;

        if (targetUsername.toLowerCase() === username.toLowerCase()) {
          res.status(400).json({ error: "You cannot deactivate your own account." });
          return;
        }

        if (targetUsername.toLowerCase() === "admin") {
          res.status(400).json({ error: "The default 'admin' account cannot be deactivated." });
          return;
        }

        const users = await getUsers();
        const index = users.findIndex(
          (u) => u.username.toLowerCase() === targetUsername.toLowerCase()
        );

        if (index === -1) {
          res.status(404).json({ error: "User account not found." });
          return;
        }

        const currentStatus = users[index].isActive !== false;
        users[index].isActive = !currentStatus;

        await saveUsers(users);
        res.status(200).json({
          success: true,
          message: `Account for ${targetUsername} set to ${users[index].isActive ? "Active" : "Inactive"}.`
        });
        return;
      }

      // 5. Change user password directly
      if (action === "change-password") {
        if (!body || !body.targetUsername || !body.newPassword) {
          res.status(400).json({ error: "targetUsername and newPassword are required." });
          return;
        }

        const { targetUsername, newPassword } = body;
        const users = await getUsers();
        const index = users.findIndex(
          (u) => u.username.toLowerCase() === targetUsername.toLowerCase()
        );

        if (index === -1) {
          res.status(404).json({ error: "User account not found." });
          return;
        }

        const newHash = hashPassword(newPassword);
        users[index].passwordHash = newHash;
        await saveUsers(users);

        let newToken = null;
        if (targetUsername.toLowerCase() === username.toLowerCase()) {
          newToken = generateToken(targetUsername, newHash);
        }

        res.status(200).json({
          success: true,
          message: `Password for ${targetUsername} updated successfully.`,
          newToken
        });
        return;
      }
    }

    res.status(400).json({ error: "Invalid action or request configuration." });
  } catch (error) {
    console.error("Error in admin management API:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
}
