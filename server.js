import express from "express";
import pino from "pino";
import { Boom } from "@hapi/boom";

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} from "@whiskeysockets/baileys";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const DB_URL =
  process.env.FIREBASE_DB_URL ||
  "https://true-seller-5f0e7-default-rtdb.firebaseio.com";

const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || "").replace(/\D/g, "");

const logger = pino({
  level: "info"
});

let sock = null;
let pairingRequested = false;

const orderStates = new Map();

/* =========================
   HTTP SERVER
========================= */

app.get("/", (req, res) => {
  res.send("True Seller WhatsApp Bot is running.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    whatsappConnected: !!sock
  });
});

app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

/* =========================
   HELPERS
========================= */

function normalize(text = "") {
  return text
    .toLowerCase()
    .trim()
    .replace(/[!?.,;:()[\]{}"'`~]/g, " ")
    .replace(/\s+/g, " ");
}

function digitsOnly(text = "") {
  return text.replace(/\D/g, "");
}

function levenshtein(a, b) {
  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;

  if (a === b) return 1;

  if (a.includes(b) || b.includes(a)) {
    return 0.9;
  }

  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

/* =========================
   BANGLA / BANGLISH NORMALIZE
========================= */

function cleanProductText(text) {
  return normalize(text)
    .replace(/টি/g, " ")
    .replace(/টা/g, " ")
    .replace(/টি/g, " ")
    .replace(/টা/g, " ")
    .replace(/জামা/g, " tshirt ")
    .replace(/টি শার্ট/g, " tshirt ")
    .replace(/টি-শার্ট/g, " tshirt ")
    .replace(/শার্ট/g, " shirt ")
    .replace(/কালো/g, " black ")
    .replace(/কালো/g, " black ")
    .replace(/সাদা/g, " white ")
    .replace(/লাল/g, " red ")
    .replace(/নীল/g, " blue ")
    .replace(/অর্ডার/g, " order ")
    .replace(/দাম/g, " price ")
    .replace(/মূল্য/g, " price ")
    .replace(/কত/g, " price ")
    .replace(/আছে/g, " available ")
    .replace(/আছ/g, " available ")
    .replace(/স্টক/g, " stock ")
    .replace(/\btshrt\b/g, "tshirt")
    .replace(/\btshirt\b/g, "tshirt")
    .replace(/\btee\b/g, "tshirt")
    .replace(/\bpricee\b/g, "price")
    .replace(/\bprize\b/g, "price")
    .replace(/\bblak\b/g, "black")
    .replace(/\bblk\b/g, "black")
    .replace(/\bwhit\b/g, "white")
    .replace(/\bavai\b/g, "available")
    .replace(/\bavilable\b/g, "available");
}

/* =========================
   FIREBASE
========================= */

async function getProducts() {
  try {
    const response = await fetch(`${DB_URL}/products.json`);

    if (!response.ok) {
      throw new Error(`Firebase HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data) return [];

    return Object.entries(data).map(([id, product]) => ({
      id,
      ...product
    }));
  } catch (error) {
    console.error("Firebase product error:", error);
    return [];
  }
}

async function saveOrder(order) {
  const response = await fetch(`${DB_URL}/orders.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(order)
  });

  if (!response.ok) {
    throw new Error(`Order save failed: ${response.status}`);
  }

  return await response.json();
}

/* =========================
   PRODUCT MATCHING
========================= */

async function findProduct(text) {
  const products = await getProducts();

  if (!products.length) return null;

  const query = cleanProductText(text);

  let bestProduct = null;
  let bestScore = 0;

  for (const product of products) {
    const name = cleanProductText(product.name || "");

    const words = query.split(" ").filter(Boolean);

    let score = 0;

    for (const word of words) {
      if (word.length < 2) continue;

      if (name.includes(word)) {
        score += 0.35;
      } else {
        const similarityScore = similarity(word, name);

        if (similarityScore >= 0.65) {
          score += similarityScore * 0.25;
        }
      }
    }

    if (query.includes(name) || name.includes(query)) {
      score += 0.5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestProduct = product;
    }
  }

  return bestScore >= 0.35 ? bestProduct : null;
}

/* =========================
   FIXED REPLIES
========================= */

const SHOP_INTRO = `True Seller - সবার পছন্দের শপ

আমাদের শপে ছেলে এবং মেয়ে উভয়ের All Collection পাওয়া যায়।

পোশাক থেকে শুরু করে এক্সেসরিজ পর্যন্ত যা যা লাগে সবকিছুই আমাদের কাছে পাবেন।

লেটেস্ট ফ্যাশন, সেরা কোয়ালিটি এবং সাশ্রয়ী দাম - তিনটাই একসাথে।

নতুন কালেকশন দেখতে এবং অর্ডার করতে আমাদের মেসেজ দিন।`;

const HELP_REPLY = `ভাই 😊 আপনি যে product-এর কথা জানতে চান তার নাম লিখুন।

যেমন:
• black tshirt er dam koto
• kalo tshirt ache?
• blak tshrt price?
• premium cotton tshirt

আমি আমাদের বর্তমান product list দেখে price ও stock জানিয়ে দেব।`;

function isGreeting(text) {
  const t = normalize(text);

  return [
    "hi",
    "hello",
    "hey",
    "hlw",
    "hii",
    "assalamualaikum",
    "salam",
    "আসসালামু আলাইকুম",
    "হাই",
    "হ্যালো"
  ].includes(t);
}

function isHelp(text) {
  const t = normalize(text);

  return (
    t === "help" ||
    t === "কি কি আছে" ||
    t === "কি আছে" ||
    t === "product" ||
    t === "products"
  );
}

function isOrderStart(text) {
  const t = cleanProductText(text);

  return (
    t === "order" ||
    t === "অর্ডার" ||
    t.includes("order করতে") ||
    t.includes("order korbo") ||
    t.includes("order dibo") ||
    t.includes("অর্ডার করবো") ||
    t.includes("অর্ডার দিব")
  );
}

function isYes(text) {
  const t = normalize(text);

  return [
    "yes",
    "y",
    "ok",
    "okay",
    "confirm",
    "confirmed",
    "হ্যাঁ",
    "হ্যা",
    "জি",
    "ঠিক আছে",
    "ঠিক"
  ].includes(t);
}

function isNo(text) {
  const t = normalize(text);

  return [
    "no",
    "n",
    "না",
    "বাদ",
    "cancel",
    "ক্যানসেল"
  ].includes(t);
}

/* =========================
   PRODUCT REPLY
========================= */

function productReply(product) {
  const stock = Number(product.stock || 0);
  const price = Number(product.price || 0);

  let stockText = "";

  if (stock <= 0) {
    stockText = "❌ এই মুহূর্তে stock শেষ।";
  } else if (stock <= 3) {
    stockText = `⚠️ মাত্র ${stock}টি stock আছে।`;
  } else {
    stockText = `✅ Stock আছে: ${stock}টি`;
  }

  return `🛍️ ${product.name}

💰 দাম: ৳${price}

${stockText}

অর্ডার করতে শুধু লিখুন: ORDER`;
}

/* =========================
   ORDER FLOW
========================= */

async function handleOrderFlow(jid, text) {
  const state = orderStates.get(jid);

  if (!state) {
    return false;
  }

  if (state.step === "product") {
    const product = await findProduct(text);

    if (!product) {
      await sock.sendMessage(jid, {
        text:
          "ভাই, কোন productটা order করতে চান বুঝতে পারিনি 😅\n\nProduct-এর নাম লিখুন।"
      });

      return true;
    }

    const stock = Number(product.stock || 0);

    if (stock <= 0) {
      await sock.sendMessage(jid, {
        text: `দুঃখিত ভাই 😔\n\n${product.name} বর্তমানে stock out।`
      });

      orderStates.delete(jid);
      return true;
    }

    orderStates.set(jid, {
      step: "name",
      product
    });

    await sock.sendMessage(jid, {
      text: `ঠিক আছে ভাই ❤️

🛍️ Product: ${product.name}
💰 Price: ৳${product.price}
📦 Stock: ${product.stock}

অর্ডারটি নিতে আপনার নামটি লিখুন।`
    });

    return true;
  }

  if (state.step === "name") {
    const name = text.trim();

    if (name.length < 2) {
      await sock.sendMessage(jid, {
        text: "ভাই, আপনার পুরো নামটা লিখুন।"
      });

      return true;
    }

    state.customerName = name;
    state.step = "phone";

    await sock.sendMessage(jid, {
      text: "ধন্যবাদ ❤️\n\nএখন আপনার মোবাইল নম্বরটি দিন।"
    });

    return true;
  }

  if (state.step === "phone") {
    const phone = digitsOnly(text);

    if (phone.length < 10 || phone.length > 15) {
      await sock.sendMessage(jid, {
        text: "ভাই, সঠিক মোবাইল নম্বরটি দিন। যেমন: 017XXXXXXXX"
      });

      return true;
    }

    state.phone = phone;
    state.step = "address";

    await sock.sendMessage(jid, {
      text:
        "এখন আপনার সম্পূর্ণ delivery address/location লিখুন।\n\nযেমন: গ্রাম, ইউনিয়ন, উপজেলা, জেলা।"
    });

    return true;
  }

  if (state.step === "address") {
    const address = text.trim();

    if (address.length < 5) {
      await sock.sendMessage(jid, {
        text: "ভাই, একটু বিস্তারিত delivery address দিন।"
      });

      return true;
    }

    state.address = address;
    state.step = "confirm";

    await sock.sendMessage(jid, {
      text: `📋 আপনার অর্ডারের তথ্য:

🛍️ Product: ${state.product.name}
💰 Price: ৳${state.product.price}
👤 Name: ${state.customerName}
📞 Phone: ${state.phone}
📍 Address: ${state.address}

সব তথ্য ঠিক থাকলে লিখুন:

YES

ভুল থাকলে লিখুন:

NO`
    });

    return true;
  }

  if (state.step === "confirm") {
    if (isNo(text)) {
      orderStates.delete(jid);

      await sock.sendMessage(jid, {
        text:
          "ঠিক আছে ভাই 👍 অর্ডারটি বাতিল করা হয়েছে। চাইলে আবার product লিখে নতুন করে order করতে পারেন।"
      });

      return true;
    }

    if (!isYes(text)) {
      await sock.sendMessage(jid, {
        text: "তথ্য ঠিক থাকলে শুধু YES লিখুন। আর বাতিল করতে NO লিখুন।"
      });

      return true;
    }

    try {
      const order = {
        productId: state.product.id,
        productName: state.product.name,
        price: Number(state.product.price || 0),
        customerName: state.customerName,
        phone: state.phone,
        address: state.address,
        whatsappJid: jid,
        status: "pending",
        createdAt: Date.now()
      };

      await saveOrder(order);

      orderStates.delete(jid);

      await sock.sendMessage(jid, {
        text: `✅ আপনার অর্ডারটি সফলভাবে নেওয়া হয়েছে।

🛍️ ${order.productName}
💰 ৳${order.price}

আমাদের পক্ষ থেকে দ্রুত যোগাযোগ করা হবে।

ধন্যবাদ True Seller-এর সাথে থাকার জন্য ❤️`
      });
    } catch (error) {
      console.error("Order save error:", error);

      await sock.sendMessage(jid, {
        text:
          "দুঃখিত ভাই 😔 অর্ডারটি save করতে সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।"
      });
    }

    return true;
  }

  return false;
}

/* =========================
   MESSAGE HANDLER
========================= */

async function handleMessage(message) {
  try {
    if (!message.message) return;

    const jid = message.key.remoteJid;

    if (!jid) return;

    if (jid.endsWith("@g.us")) return;
    if (jid === "status@broadcast") return;
    if (message.key.fromMe) return;

    const text =
      message.message.conversation ||
      message.message.extendedTextMessage?.text ||
      "";

    if (!text.trim()) return;

    console.log(`📩 Message from ${jid}: ${text}`);

    const normalized = normalize(text);

    // Existing order conversation
    if (orderStates.has(jid)) {
      await handleOrderFlow(jid, text);
      return;
    }

    // Greeting
    if (isGreeting(text)) {
      await sock.sendMessage(jid, {
        text: SHOP_INTRO
      });
      return;
    }

    // Help
    if (isHelp(text)) {
      await sock.sendMessage(jid, {
        text: HELP_REPLY
      });
      return;
    }

    // Start order
    if (isOrderStart(text)) {
      orderStates.set(jid, {
        step: "product"
      });

      await sock.sendMessage(jid, {
        text:
          "অবশ্যই ভাই ❤️\n\nকোন productটি order করতে চান? Product-এর নাম লিখুন।"
      });

      return;
    }

    // Product search
    const product = await findProduct(text);

    if (product) {
      await sock.sendMessage(jid, {
        text: productReply(product)
      });

      return;
    }

    // Common delivery/payment questions
    if (
      normalized.includes("delivery") ||
      normalized.includes("ডেলিভারি")
    ) {
      await sock.sendMessage(jid, {
        text:
          "Delivery charge ও delivery time location অনুযায়ী জানানো হবে। আপনার location লিখলে আমরা বিস্তারিত জানাব।"
      });

      return;
    }

    if (
      normalized.includes("payment") ||
      normalized.includes("পেমেন্ট") ||
      normalized.includes("bkash") ||
      normalized.includes("nagad")
    ) {
      await sock.sendMessage(jid, {
        text:
          "Payment option সম্পর্কে জানতে চাইলে আপনার product ও location জানিয়ে message দিন।"
      });

      return;
    }

    await sock.sendMessage(jid, {
      text:
        "আপনার প্রশ্নটা হয়তো আমি বুঝিনি 😅\n\nProduct-এর নাম লিখুন, যেমন:\nblack tshirt er dam koto\n\nঅথবা HELP লিখুন।"
    });
  } catch (error) {
    console.error("Message handler error:", error);
  }
}

/* =========================
   WHATSAPP CONNECTION
========================= */

async function startWhatsApp() {
  try {
    const { state, saveCreds } =
      await useMultiFileAuthState("./auth_info_baileys");

    pairingRequested = false;

    sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.windows("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      console.log(
        `📡 WhatsApp connection status: ${connection || "unknown"}`
      );

      /*
       * Pairing code must be requested while the socket
       * is connecting / QR event has arrived.
       */
      if (
        !state.creds.registered &&
        !pairingRequested &&
        (connection === "connecting" || !!qr)
      ) {
        pairingRequested = true;

        try {
          if (!PAIRING_NUMBER) {
            console.error(
              "❌ PAIRING_NUMBER is missing from Render Environment Variables."
            );
            return;
          }

          console.log(
            `📱 Pairing number configured: ${PAIRING_NUMBER.slice(
              0,
              3
            )}*******`
          );

          // Small delay gives the socket time to settle.
          await new Promise((resolve) => setTimeout(resolve, 1500));

          const code = await sock.requestPairingCode(
            PAIRING_NUMBER
          );

          console.log("");
          console.log("======================================");
          console.log("🔐 WHATSAPP PAIRING CODE");
          console.log("======================================");
          console.log(code);
          console.log("======================================");
          console.log(
            "WhatsApp → Linked devices → Link a device → Link with phone number instead"
          );
          console.log("======================================");
          console.log("");
        } catch (error) {
          pairingRequested = false;

          console.error(
            "❌ Pairing code request failed:",
            error?.message || error
          );
        }
      }

      if (connection === "open") {
        console.log("");
        console.log("======================================");
        console.log("✅ WHATSAPP CONNECTED SUCCESSFULLY");
        console.log("======================================");
        console.log("");
      }

      if (connection === "close") {
        const statusCode =
          new Boom(lastDisconnect?.error)?.output?.statusCode;

        console.log(
          `⚠️ WhatsApp connection closed. Status: ${statusCode}`
        );

        if (statusCode === DisconnectReason.loggedOut) {
          console.log(
            "❌ WhatsApp logged out. Fresh pairing is required."
          );
          sock = null;
          return;
        }

        /*
         * WhatsApp/Baileys may intentionally close the old socket
         * with restartRequired after pairing. Recreate it.
         */
        console.log("🔄 Restarting WhatsApp connection...");

        sock = null;

        setTimeout(() => {
          startWhatsApp();
        }, 3000);
      }

      if (qr) {
        console.log(
          "ℹ️ QR event received. Pairing-code login is being used."
        );
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const message of messages) {
        await handleMessage(message);
      }
    });
  } catch (error) {
    console.error("❌ WhatsApp startup error:", error);

    setTimeout(() => {
      startWhatsApp();
    }, 5000);
  }
}

/* =========================
   START
========================= */

startWhatsApp();
