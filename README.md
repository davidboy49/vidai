# vidai

Telegram summary bot that runs on Vercel. It listens for `/summary` in a group chat
and uses the Hugging Face inference API to summarize recent messages.

## Setup

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and grab the bot token.
2. Create a Hugging Face account and generate an access token.
3. Deploy to Vercel and set the environment variables:

- `TELEGRAM_BOT_TOKEN`
- `HF_TOKEN`

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
- The summary uses the `facebook/bart-large-cnn` model by default. You can change
  it in `api/telegram.js`.
