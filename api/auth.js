import { getUsers, saveUsers, hashPassword, generateToken, verifyToken } from "./_db.js";
import crypto from "crypto";

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
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    const action = req.query.action;

    if (req.method === "GET") {
      if (action === "sso_url") {
        const vportalUrl = process.env.VPORTAL_URL || "http://localhost:3000";
        const clientId = process.env.VPORTAL_CLIENT_ID || "vidai-console";
        const requestedRedirectUri = req.query.redirect_uri || `${vportalUrl}/api/auth?action=callback`;
        
        const state = crypto.randomBytes(16).toString("hex");
        const ssoUrl = `${vportalUrl}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(requestedRedirectUri)}&state=${state}&scope=profile%20email`;
        
        res.status(200).json({ url: ssoUrl });
        return;
      }

      if (action === "callback") {
        const { code, error, error_description } = req.query;

        if (error) {
          res.setHeader("Location", `/?error=${encodeURIComponent(error_description || error)}`);
          res.status(302).end();
          return;
        }

        if (!code) {
          res.setHeader("Location", `/?error=${encodeURIComponent("Missing authorization code")}`);
          res.status(302).end();
          return;
        }

        const vportalUrl = process.env.VPORTAL_URL || "http://localhost:3000";
        const clientId = process.env.VPORTAL_CLIENT_ID || "vidai-console";
        const clientSecret = process.env.VPORTAL_CLIENT_SECRET || "vidai-secret-key-xyz";
        
        const protocol = req.headers["x-forwarded-proto"] || "http";
        const redirectUri = `${protocol}://${req.headers.host}/api/auth?action=callback`;

        // 1. Exchange authorization code for token
        const tokenRes = await fetch(`${vportalUrl}/api/oauth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret
          })
        });

        if (!tokenRes.ok) {
          const errData = await tokenRes.json();
          res.setHeader("Location", `/?error=${encodeURIComponent(errData.error_description || "Token exchange failed")}`);
          res.status(302).end();
          return;
        }

        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;

        // 2. Fetch User Profile using access token
        const userinfoRes = await fetch(`${vportalUrl}/api/oauth/userinfo`, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });

        if (!userinfoRes.ok) {
          const errText = await userinfoRes.text();
          res.setHeader("Location", `/?error=${encodeURIComponent("Failed to fetch user profile: " + errText + " | TokenData: " + JSON.stringify(tokenData))}`);
          res.status(302).end();
          return;
        }

        const userInfo = await userinfoRes.json();
        
        // 3. Auto-provision user if they do not exist
        const users = await getUsers();
        const username = userInfo.name || userInfo.email.split("@")[0] || "sso_user";

        let matchedUser = users.find(
          (u) => u.username.toLowerCase() === username.toLowerCase()
        );

        if (!matchedUser) {
          matchedUser = {
            username,
            passwordHash: hashPassword(crypto.randomBytes(16).toString("hex")),
            isActive: true,
            email: userInfo.email || ""
          };
          users.push(matchedUser);
          await saveUsers(users);
        } else if (matchedUser.isActive === false) {
          res.setHeader("Location", `/?error=${encodeURIComponent("Your account is deactivated. Please contact the administrator.")}`);
          res.status(302).end();
          return;
        }

        // 4. Generate system stateless token and redirect
        const token = generateToken(matchedUser.username, matchedUser.passwordHash);
        res.setHeader("Location", `/?token=${token}&username=${matchedUser.username}`);
        res.status(302).end();
        return;
      }

      res.status(400).json({ error: "Invalid GET action." });
      return;
    }

    const body = await parseBody(req);
    const postAction = req.query.action || (body && body.action);

    if (postAction === "login") {
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

    if (postAction === "verify") {
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

    res.status(400).json({ error: "Invalid action. Supported POST actions: login, verify." });
  } catch (error) {
    console.error("Error in auth API:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
}
