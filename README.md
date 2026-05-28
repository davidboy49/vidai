# vidai

Telegram summary bot that runs on Vercel. It listens for commands in a group
chat and uses the Hugging Face inference API to generate responses.

## Commands

| Command | Description |
| ---------- | ------------------------------------------------- |
| `/summary` | TL;DR of recent chat messages |
| `/activity`| Highlights of latest activity |
| `/quote` | Random Greek, Chinese, or Stoic philosophical quote |
| `/mood` | Analyze the group's current emotional vibe |
| `/roast` | Playful, lighthearted roast of recent chat activity |
| `/help` | Show available commands |

## Setup

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and grab the bot token.
2. Create a Hugging Face account and generate an access token with access to the
   Hugging Face router.
3. Deploy to Vercel and set the environment variables:

### Required

- `TELEGRAM_BOT_TOKEN` — Your Telegram bot token from BotFather.
- `HF_TOKEN` — Hugging Face API access token.

### Optional

- `TELEGRAM_BOT_USERNAME` — Bot username without the leading `@`. Enables
  the bot to recognise commands like `/summary@YourBot` in groups.
- `HF_MODEL` — Override the default LLM model. Defaults to
  `mistralai/Mistral-7B-Instruct-v0.2:featherless-ai`.
- `RESTRICT_TO_ADMINS` — Set to `true` to restrict bot commands and chit-chat
  in groups to chat administrators/owners only.
- `DISABLE_FEATURES` — A comma-separated list of commands or features to disable
  globally (e.g., `roast,mood,chitchat`).
- `ALLOWED_USER_IDS` — A comma-separated list of approved Telegram User IDs. If
  configured, only these users can interact with the bot.

## Webhook

After deployment, set the webhook to your Vercel URL:

```bash
curl -X POST \
  "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-vercel-domain>/api/telegram"
```

## Features

- **Chit-chat & Dialogue** — Talk directly to the bot in group chats by mentioning its username (e.g. `@YourBot`) or replying to its messages. The bot can also chat in DM without any mentions.
- **Dialogue History Context** — Caches both user messages and the bot's own responses so conversation back-and-forth feels natural and continuous.
- **Khmer Token Cooldown Joke** — If a user chats excessively (more than 5 messages in 2 minutes), the bot humorously replies in Khmer: `និយាយច្រើនចឹង បង់ថ្លៃ token អោយញ៉ុមមែន?😊` ("Talk so much, are you going to pay for my tokens? 😊").
- **Typing indicator** — The bot shows "typing…" while it processes a command.
- **HTML formatting** — Summaries, quotes, and other responses are formatted
  with bold headers, italics, and emoji for a polished look.
- **Sender attribution** — Messages are cached with the sender's name, so
  summaries and activity reports can reference who said what.
- **Quote reactions** — After sending a quote the bot reacts to your command
  message with a tradition-appropriate emoji (🏛 Greek, 🐉 Chinese, 🗿 Stoic).
- **Reply-to context** — Use any command as a reply to a specific message
  and the bot will factor that message into its response.
- **Rate limiting** — A 30-second per-chat cooldown prevents command spam and
  protects API credits.
- **Graceful error handling** — LLM rate-limits, timeouts, and malformed
  payloads are handled gracefully with friendly user-facing messages and no
  Telegram retry storms.

## Notes

- The bot stores the last 50 text messages per chat in memory. Vercel serverless
  functions are stateless, so the cache resets when the function instance is
  recycled.
- The default model is `mistralai/Mistral-7B-Instruct-v0.2:featherless-ai`
  via the Hugging Face router. Change it with the `HF_MODEL` env var.
