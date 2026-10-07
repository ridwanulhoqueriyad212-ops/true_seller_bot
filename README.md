# True Seller WhatsApp Bot

Unofficial WhatsApp Web companion-client bot using Baileys.

## What it does

- Connects one WhatsApp account without the official WhatsApp Business API.
- Reads products from the existing True Seller Firebase Realtime Database.
- Understands common Bangla/Banglish spellings and small typos.
- Replies with product price and stock.
- Starts a WhatsApp order conversation and collects:
  - customer name
  - phone number
  - delivery address
- Saves confirmed orders to `/orders` in Firebase.
- Keeps the existing website product data as the source of truth.

## Requirements

Node.js 20+.

## Environment variables

`FIREBASE_DB_URL`
Default:
`https://true-seller-5f0e7-default-rtdb.firebaseio.com`

`PAIRING_NUMBER`
Your WhatsApp number in international digits, without `+`, spaces or leading `0`.
For Bangladesh, for example: `8801XXXXXXXXX`

`PORT`
Render supplies this automatically. Local default is `10000`.

## Local run

```bash
npm install
npm start
```

If the WhatsApp account is not linked yet and `PAIRING_NUMBER` is set, the terminal will show a pairing code.

On the phone:
WhatsApp → Linked devices → Link a device → Link with phone number instead.

## Render

Create a Web Service from this repository.

Build command:
```bash
npm install
```

Start command:
```bash
npm start
```

Environment variables:
- `FIREBASE_DB_URL`
- `PAIRING_NUMBER`

### Important session note

`auth_info_baileys` contains WhatsApp authentication credentials and must never be committed to GitHub.

A free/ephemeral server filesystem may lose the session after a restart/redeploy. For a more persistent deployment, use persistent storage or a database-backed auth state.

## Safety / reliability note

Baileys is an unofficial WhatsApp Web library and is not affiliated with WhatsApp. WhatsApp can change its protocol or restrict automated accounts. Keep messaging low-volume and only respond to people who message the business.
