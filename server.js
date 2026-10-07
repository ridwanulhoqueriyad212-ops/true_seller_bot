import express from "express";
import pino from "pino";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

const PORT = Number(process.env.PORT || 10000);
const DB_URL = (process.env.FIREBASE_DB_URL || "https://true-seller-5f0e7-default-rtdb.firebaseio.com").replace(/\/+$/, "");
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || "").replace(/\D/g, "");

const app = express();
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "True Seller WhatsApp Bot" });
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, whatsapp: !!sock });
});
app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server running on port ${PORT}`);
});

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
let sock = null;
let reconnectTimer = null;
let productsCache = [];
let productsLoadedAt = 0;
const sessions = new Map();

const WELCOME_REPLY = `True Seller - সবার পছন্দের শপ

আমাদের শপে ছেলে এবং মেয়ে উভয়ের All Collection পাওয়া যায়।
পোশাক থেকে শুরু করে এক্সেসরিজ পর্যন্ত যা যা লাগে সবকিছুই আমাদের কাছে পাবেন।
লেটেস্ট ফ্যাশন, সেরা কোয়ালিটি এবং সাশ্রয়ী দাম - তিনটাই একসাথে।
নতুন কালেকশন দেখতে এবং অর্ডার করতে আমাদের মেসেজ দিন।`;

const FIXED = {
  hi: WELCOME_REPLY,
  hello: WELCOME_REPLY,
  হাই: WELCOME_REPLY,
  হ্যালো: WELCOME_REPLY,
  help: "কী জানতে চান? Product-এর নাম/দাম/stock, delivery, payment বা order লিখুন।",
  delivery: "Delivery charge ও সময় আপনার location অনুযায়ী জানানো হবে। Order করতে চাইলে ORDER লিখুন।",
  payment: "আমরা COD এবং bKash/Nagad payment option দিতে পারি। Order confirm করার সময় payment method জানিয়ে দিন।",
  order: "অর্ডার করতে Product-এর নাম লিখুন। Product পেলে আমি আপনার নাম, মোবাইল নম্বর ও delivery address চাইব।",
  "অর্ডার": "অর্ডার করতে Product-এর নাম লিখুন। Product পেলে আমি আপনার নাম, মোবাইল নম্বর ও delivery address চাইব।"
};

const BANGLA_TO_EN = new Map([
  ["কালো", "black"], ["সাদা", "white"], ["লাল", "red"], ["নীল", "blue"],
  ["সবুজ", "green"], ["হলুদ", "yellow"], ["গোলাপি", "pink"],
  ["টি শার্ট", "tshirt"], ["টি-শার্ট", "tshirt"], ["টিশার্ট", "tshirt"],
  ["শার্ট", "shirt"], ["প্যান্ট", "pant"], ["জিন্স", "jeans"],
  ["দাম", "price"], ["মূল্য", "price"], ["কত", "price"], ["আছে", "stock"],
  ["আছ", "stock"], ["স্টক", "stock"], ["নিতে চাই", "order"], ["অর্ডার", "order"]
]);

function normalize(text = "") {
  let s = String(text).toLowerCase().trim();
  for (const [bn, en] of BANGLA_TO_EN) s = s.replaceAll(bn, ` ${en} `);
  s = s
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const aliases = {
    tee: "tshirt", "t shirt": "tshirt", "tshirt": "tshirt",
    "tshrt": "tshirt", "tshir": "tshirt", "tsirt": "tshirt",
    "blak": "black", "blk": "black", "wht": "white",
    "prce": "price", "dam": "price", "dham": "price",
    "ache": "stock", "ase": "stock", "asay": "stock",
    "koto": "price", "kot": "price", "damo": "price"
  };
  for (const [a, b] of Object.entries(aliases)) {
    s = s.replace(new RegExp(`\\b${escapeRegExp(a)}\\b`, "g"), b);
  }
  return s;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokens(s) {
  return normalize(s).split(/\s+/).filter(Boolean);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) {
      cur[j + 1] = Math.min(
        cur[j] + 1,
        prev[j + 1] + 1,
        prev[j] + (a[i] === b[j] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

function tokenScore(queryToken, productToken) {
  if (queryToken === productToken) return 1;
  if (queryToken.length >= 3 && productToken.includes(queryToken)) return 0.92;
  if (productToken.length >= 3 && queryToken.includes(productToken)) return 0.88;
  const d = levenshtein(queryToken, productToken);
  const max = Math.max(queryToken.length, productToken.length);
  return max ? Math.max(0, 1 - d / max) : 0;
}

function scoreProduct(query, product) {
  const q = tokens(query);
  const p = tokens(`${product.name || ""} ${product.description || ""}`);
  if (!q.length || !p.length) return 0;

  let total = 0;
  let hits = 0;
  for (const qt of q) {
    if (["price", "stock", "order"].includes(qt)) continue;
    let best = 0;
    for (const pt of p) best = Math.max(best, tokenScore(qt, pt));
    if (best >= 0.62) {
      total += best;
      hits++;
    }
  }
  const useful = q.filter(x => !["price", "stock", "order"].includes(x)).length;
  if (!useful) return 0;
  return hits / useful * 0.7 + total / useful * 0.3;
}

async function loadProducts(force = false) {
  if (!force && Date.now() - productsLoadedAt < 15000) return productsCache;
  const r = await fetch(`${DB_URL}/products.json`);
  if (!r.ok) throw new Error(`Firebase products read failed: ${r.status}`);
  const data = await r.json();
  productsCache = Object.entries(data || {}).map(([id, value]) => ({ id, ...(value || {}) }));
  productsLoadedAt = Date.now();
  return productsCache;
}

function wantsPrice(text) {
  const n = normalize(text);
  return /\b(price|dam)\b/.test(n) || /কত/.test(text);
}
function wantsStock(text) {
  const n = normalize(text);
  return /\b(stock|ache|ase)\b/.test(n) || /আছে/.test(text);
}
function isOrderStart(text) {
  const n = normalize(text);
  return /\border\b/.test(n) || /\bni(te)?\b/.test(n) || n.includes("নিব");
}

async function saveOrder(order) {
  const r = await fetch(`${DB_URL}/orders.json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(order)
  });
  if (!r.ok) throw new Error(`Firebase order write failed: ${r.status}`);
  return await r.json();
}

async function reply(jid, text) {
  if (!sock) return;
  await sock.sendMessage(jid, { text });
}

function getText(message) {
  const m = message?.message;
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  ).trim();
}

async function handleMessage(message) {
  const jid = message?.key?.remoteJid;
  if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") return;
  if (message.key.fromMe) return;

  const text = getText(message);
  if (!text) return;

  const key = jid;
  const state = sessions.get(key) || { step: "idle" };

  // Continue an existing order conversation.
  if (state.step === "product") {
    const products = await loadProducts();
    const ranked = products
      .map(p => ({ p, score: scoreProduct(text, p) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];

    if (!best || best.score < 0.50) {
      await reply(jid, "Product-এর নামটা আরেকটু পরিষ্কার করে লিখুন। যেমন: Premium Cotton Drop Shoulder Tshirt");
      return;
    }

    const p = best.p;
    state.product = {
      id: p.id,
      name: p.name || "Product",
      price: Number(p.price || 0),
      stock: Number(p.stock || 0)
    };
    state.step = "name";
    sessions.set(key, state);

    await reply(
      jid,
      `🛍️ ${state.product.name}\n💰 দাম: ৳${state.product.price}\n📦 Stock: ${state.product.stock}\n\nঅর্ডার করতে আপনার নামটি লিখুন।`
    );
    return;
  }

  if (state.step === "name") {
    state.customerName = text.slice(0, 100);
    state.step = "phone";
    sessions.set(key, state);
    await reply(jid, "ধন্যবাদ 😊 এখন আপনার মোবাইল নম্বরটি লিখুন।");
    return;
  }

  if (state.step === "phone") {
    const phone = text.replace(/[^\d+]/g, "");
    if (phone.length < 10) {
      await reply(jid, "সঠিক মোবাইল নম্বরটি লিখুন। যেমন: 01XXXXXXXXX");
      return;
    }
    state.phone = phone;
    state.step = "address";
    sessions.set(key, state);
    await reply(jid, "এবার আপনার সম্পূর্ণ delivery address লিখুন 📍");
    return;
  }

  if (state.step === "address") {
    state.address = text.slice(0, 500);
    state.step = "confirm";
    sessions.set(key, state);

    await reply(
      jid,
      `✅ অর্ডারের তথ্য:\n\n🛍️ ${state.product.name}\n💰 ৳${state.product.price}\n👤 ${state.customerName}\n📱 ${state.phone}\n📍 ${state.address}\n\nঅর্ডার confirm করতে YES লিখুন।`
    );
    return;
  }

  if (state.step === "confirm") {
    const n = normalize(text);
    if (["yes", "y", "confirm", "ঠিক", "হ্যাঁ", "ji", "jii"].includes(n)) {
      try {
        await saveOrder({
          productId: state.product.id,
          productName: state.product.name,
          price: state.product.price,
          customerName: state.customerName,
          phone: state.phone,
          address: state.address,
          whatsappJid: jid,
          status: "pending",
          createdAt: Date.now()
        });
        sessions.delete(key);
        await reply(jid, "✅ আপনার order successfully received হয়েছে। আমাদের পক্ষ থেকে শিগগিরই যোগাযোগ করা হবে। ধন্যবাদ ❤️");
      } catch (e) {
        logger.error(e, "order save failed");
        await reply(jid, "দুঃখিত, order save করতে সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।");
      }
      return;
    }

    if (["no", "n", "cancel", "না"].includes(n)) {
      sessions.delete(key);
      await reply(jid, "ঠিক আছে 😊 Order বাতিল করা হয়েছে। আবার order করতে Product-এর নাম লিখুন।");
      return;
    }

    await reply(jid, "Order confirm করতে YES অথবা বাতিল করতে NO লিখুন।");
    return;
  }

  const n = normalize(text);
  if (FIXED[n]) {
    if (isOrderStart(text)) {
      state.step = "product";
      sessions.set(key, state);
      await reply(jid, FIXED[n]);
      return;
    }
    await reply(jid, FIXED[n]);
    return;
  }

  if (isOrderStart(text)) {
    state.step = "product";
    sessions.set(key, state);
    await reply(jid, "অবশ্যই 😊 আপনি যে Productটি নিতে চান তার নাম লিখুন।");
    return;
  }

  const products = await loadProducts();
  const ranked = products
    .map(p => ({ p, score: scoreProduct(text, p) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (best && best.score >= 0.50) {
    const p = best.p;
    const price = Number(p.price || 0);
    const stock = Number(p.stock || 0);
    const status = stock > 0 ? `📦 Stock: ${stock} টি` : "❌ বর্তমানে stock শেষ";

    await reply(
      jid,
      `🛍️ ${p.name || "Product"}\n💰 দাম: ৳${price}\n${status}\n\nঅর্ডার করতে চাইলে ORDER লিখুন।`
    );
    return;
  }

  await reply(jid, "দুঃখিত 😊 আপনার প্রশ্নটা পুরোপুরি বুঝতে পারিনি। Product-এর নাম, price, stock বা ORDER লিখে চেষ্টা করুন।");
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info_baileys");

  sock = makeWASocket({
    auth: state,
    logger,
    markOnlineOnConnect: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\n========== WHATSAPP QR STRING RECEIVED ==========");
      console.log("QR is available in the connection event. Use a QR-capable local run if needed.");
      console.log("For Render, set PAIRING_NUMBER and use the pairing code shown below.");
      console.log("=================================================\n");
    }

    if (connection === "open") {
      console.log("✅ WhatsApp connected successfully.");
      if (reconnectTimer) clearTimeout(reconnectTimer);
    }

    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log("WhatsApp connection closed. code:", code, "loggedOut:", loggedOut);
      sock = null;

      if (!loggedOut) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(startWhatsApp, 5000);
      } else {
        console.log("Logged out. Delete auth_info_baileys and connect again.");
      }
    }
  });

  // Pairing code is easier for a phone-only workflow than scanning a terminal QR.
  if (!state.creds.registered && PAIRING_NUMBER) {
    try {
      await new Promise(r => setTimeout(r, 2500));
      const code = await sock.requestPairingCode(PAIRING_NUMBER);
      console.log(`\n🔐 WhatsApp Pairing Code: ${code}\n`);
      console.log("On your phone: WhatsApp → Linked devices → Link a device → Link with phone number instead.");
    } catch (e) {
      logger.error(e, "pairing code failed");
    }
  }

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages) {
      try {
        await handleMessage(message);
      } catch (e) {
        logger.error(e, "message handler failed");
      }
    }
  });
}

startWhatsApp().catch(err => {
  logger.error(err, "fatal startup error");
  process.exit(1);
});
