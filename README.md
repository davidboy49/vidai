# vidai

Telegram summary bot that runs on Vercel. It listens for `/summary` (or `/activity`
for latest activity highlights) in a group chat and uses the Hugging Face inference
API to summarize recent messages. It also supports `/quote` to generate and send
a random Greek, Chinese, or Stoic quote via the Hugging Face model directly in chat.

## Setup

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and grab the bot token.
2. Create a Hugging Face account and generate an access token with access to the
   Hugging Face router.
3. Deploy to Vercel and set the environment variables:

- `TELEGRAM_BOT_TOKEN`
- `HF_TOKEN`
- `TELEGRAM_BOT_USERNAME` (optional, without the leading `@`, to match `/summary@YourBot`)

## Webhook

After deployment, set the webhook to your Vercel URL:

```bash
curl -X POST \
  "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-vercel-domain>/api/telegram"
```

## Notes

- The bot stores the last 50 text messages per chat in memory. Vercel serverless
  functions are stateless, so the cache resets when the function instance is recycled.
- The summary uses the `mistralai/Mistral-7B-Instruct-v0.2:featherless-ai` model
  through the Hugging Face router. You can change it in `api/telegram.js`.
