import express from "express";
import pino from "pino";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} from "@whiskeysockets/baileys";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || "").replace(/\/$/, "");
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || "").replace(/\D/g, "");

const logger = pino({
  level: "silent"
});

let sock = null;
let reconnecting = false;
let pairingRequested = false;

// Customer order states
const orderStates = new Map();

/* =========================
   EXPRESS SERVER
========================= */

app.get("/", (req, res) => {
  res.send("True Seller WhatsApp Bot is running.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    whatsapp: !!sock,
    time: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

/* =========================
   FIREBASE HELPERS
========================= */

async function firebaseGet(path) {
  if (!FIREBASE_DB_URL) {
    throw new Error("FIREBASE_DB_URL is missing");
  }

  const response = await fetch(
    `${FIREBASE_DB_URL}/${path}.json`
  );

  if (!response.ok) {
    throw new Error(`Firebase GET failed: ${response.status}`);
  }

  return await response.json();
}

async function firebasePost(path, data) {
  if (!FIREBASE_DB_URL) {
    throw new Error("FIREBASE_DB_URL is missing");
  }

  const response = await fetch(
    `${FIREBASE_DB_URL}/${path}.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    }
  );

  if (!response.ok) {
    throw new Error(`Firebase POST failed: ${response.status}`);
  }

  return await response.json();
}

/* =========================
   TEXT HELPERS
========================= */

function normalize(text = "") {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,!?।]/g, " ")
    .replace(/\s+/g, " ");
}

function normalizeBanglish(text = "") {
  return normalize(text)
    .replace(/tshrt/g, "tshirt")
    .replace(/t shirt/g, "tshirt")
    .replace(/tee shirt/g, "tshirt")
    .replace(/blak/g, "black")
    .replace(/blk/g, "black")
    .replace(/kalo/g, "black")
    .replace(/shada/g, "white")
    .replace(/sada/g, "white")
    .replace(/lal/g, "red")
    .replace(/nil/g, "blue")
    .replace(/jamar/g, "shirt")
    .replace(/jma/g, "shirt")
    .replace(/dam/g, "price")
    .replace(/koto/g, "price")
    .replace(/ache nki/g, "available")
    .replace(/ache naki/g, "available");
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

function productScore(query, product) {
  const q = normalizeBanglish(query);

  const name = normalizeBanglish(product.name || "");

  if (!name) return 0;

  if (name.includes(q) || q.includes(name)) {
    return 100;
  }

  const qWords = q.split(" ").filter(Boolean);
  const nameWords = name.split(" ").filter(Boolean);

  let score = 0;

  for (const qw of qWords) {
    for (const nw of nameWords) {
      if (qw === nw) {
        score += 20;
      } else {
        const distance = levenshtein(qw, nw);

        if (distance <= 1) {
          score += 15;
        } else if (distance <= 2 && qw.length >= 4) {
          score += 8;
        }
      }
    }
  }

  return score;
}

async function findProducts(query) {
  const products = await firebaseGet("products");

  if (!products) return [];

  const list = Object.entries(products).map(([id, product]) => ({
    id,
    ...product
  }));

  return list
    .map(product => ({
      product,
      score: productScore(query, product)
    }))
    .filter(item => item.score >= 8)
    .sort((a, b) => b.score - a.score)
    .map(item => item.product);
}

/* =========================
   FIXED REPLIES
========================= */

const GREETING =
`True Seller - সবার পছন্দের শপ

আমাদের শপে ছেলে এবং মেয়ে উভয়ের All Collection পাওয়া যায়।
পোশাক থেকে শুরু করে এক্সেসরিজ পর্যন্ত যা যা লাগে সবকিছুই আমাদের কাছে পাবেন।
লেটেস্ট ফ্যাশন, সেরা কোয়ালিটি এবং সাশ্রয়ী দাম - তিনটাই একসাথে।
নতুন কালেকশন দেখতে এবং অর্ডার করতে আমাদের মেসেজ দিন।`;

const HELP =
`ভাই/আপু 😊 আপনি চাইলে এভাবে লিখতে পারেন:

• Black tshirt er dam koto
• blak tshrt price?
• kalo t shirt koto
• black tshrt ache?
• আমি একটা tshirt অর্ডার করতে চাই

আপনি product-এর নাম লিখলেই আমি available product খুঁজে দেওয়ার চেষ্টা করব।`;

const DELIVERY =
`🚚 Delivery:
সারা বাংলাদেশে delivery available।
আপনার location অনুযায়ী delivery charge জানিয়ে দেওয়া হবে।`;

const PAYMENT =
`💳 Payment:
বর্তমানে Cash on Delivery, bKash এবং Nagad payment নেওয়া হয়।`;

function isGreeting(text) {
  const t = normalizeBanglish(text);

  return [
    "hi",
    "hello",
    "hey",
    "assalamu alaikum",
    "salam",
    "হাই",
    "হ্যালো",
    "আসসালামু আলাইকুম"
  ].some(word => t.includes(word));
}

function isHelp(text) {
  const t = normalizeBanglish(text);

  return (
    t.includes("help") ||
    t.includes("কি করতে পারি") ||
    t.includes("কিভাবে") ||
    t.includes("how to")
  );
}

function isDelivery(text) {
  const t = normalizeBanglish(text);

  return (
    t.includes("delivery") ||
    t.includes("ডেলিভারি") ||
    t.includes("courier")
  );
}

function isPayment(text) {
  const t = normalizeBanglish(text);

  return (
    t.includes("payment") ||
    t.includes("পেমেন্ট") ||
    t.includes("bkash") ||
    t.includes("nagad")
  );
}

function isOrderRequest(text) {
  const t = normalizeBanglish(text);

  return (
    t.includes("order") ||
    t.includes("অর্ডার") ||
    t.includes("নিতে চাই") ||
    t.includes("কিনতে চাই")
  );
}

function isYes(text) {
  const t = normalizeBanglish(text);

  return [
    "yes",
    "y",
    "ok",
    "okay",
    "confirm",
    "confirmed",
    "জি",
    "হ্যাঁ",
    "ঠিক আছে"
  ].includes(t);
}

function isNo(text) {
  const t = normalizeBanglish(text);

  return [
    "no",
    "n",
    "cancel",
    "না",
    "বাদ"
  ].includes(t);
}

/* =========================
   PRODUCT REPLY
========================= */

async function productReply(text, jid) {
  const products = await findProducts(text);

  if (!products.length) {
    return null;
  }

  const product = products[0];

  const stock = Number(product.stock || 0);
  const price = Number(product.price || 0);

  let reply =
`🛍️ ${product.name}

💰 Price: ৳${price}
📦 Stock: ${stock > 0 ? `${stock} pcs available` : "Out of stock"}`;

  if (stock > 0) {
    reply += `

অর্ডার করতে লিখুন: ORDER ${product.name}`;
  }

  return {
    reply,
    product
  };
}

/* =========================
   ORDER FLOW
========================= */

async function handleOrderFlow(jid, text) {
  const state = orderStates.get(jid);

  if (!state) return null;

  if (state.step === "name") {
    state.customerName = text.trim();
    state.step = "phone";

    orderStates.set(jid, state);

    return "ধন্যবাদ 😊 এখন আপনার ফোন নম্বরটি দিন।";
  }

  if (state.step === "phone") {
    state.phone = text.trim();
    state.step = "address";

    orderStates.set(jid, state);

    return "এখন আপনার সম্পূর্ণ ঠিকানা / location দিন।";
  }

  if (state.step === "address") {
    state.address = text.trim();
    state.step = "confirm";

    orderStates.set(jid, state);

    return `📋 আপনার অর্ডারের তথ্য:

🛍️ Product: ${state.productName}
💰 Price: ৳${state.price}

👤 Name: ${state.customerName}
📱 Phone: ${state.phone}
📍 Address: ${state.address}

সব তথ্য ঠিক থাকলে শুধু **YES** লিখুন।
বাতিল করতে **NO** লিখুন।`;
  }

  if (state.step === "confirm") {
    if (isNo(text)) {
      orderStates.delete(jid);
      return "ঠিক আছে 😊 অর্ডারটি বাতিল করা হয়েছে।";
    }

    if (!isYes(text)) {
      return "অর্ডার confirm করতে **YES** অথবা বাতিল করতে **NO** লিখুন।";
    }

    const order = {
      productId: state.productId,
      productName: state.productName,
      price: state.price,
      customerName: state.customerName,
      phone: state.phone,
      address: state.address,
      whatsappJid: jid,
      status: "pending",
      createdAt: Date.now()
    };

    try {
      await firebasePost("orders", order);

      orderStates.delete(jid);

      return `✅ আপনার order successfully নেওয়া হয়েছে।

🛍️ ${state.productName}
💰 ৳${state.price}

আমাদের team খুব শিগগিরই আপনার সাথে যোগাযোগ করবে।

ধন্যবাদ True Seller-এর সাথে থাকার জন্য ❤️`;
    } catch (error) {
      console.error("Firebase order save error:", error);

      return "দুঃখিত, অর্ডারটি এখন save করা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।";
    }
  }

  return null;
}

/* =========================
   START ORDER
========================= */

async function startOrder(jid, product) {
  orderStates.set(jid, {
    step: "name",
    productId: product.id,
    productName: product.name,
    price: Number(product.price || 0),
    customerName: "",
    phone: "",
    address: ""
  });

  return `অবশ্যই 😊

🛍️ Product: ${product.name}
💰 Price: ৳${product.price}

অর্ডার শুরু করতে আপনার **নামটি** লিখুন।`;
}

/* =========================
   WHATSAPP
========================= */

async function connectWhatsApp() {
  if (reconnecting) return;

  reconnecting = true;

  try {
    const { state, saveCreds } =
      await useMultiFileAuthState("./auth_info_baileys");

    sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.windows("Chrome"),
      printQRInTerminal: false,
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

      if (qr) {
        console.log(
          "ℹ️ QR event received. Pairing-code login is being used."
        );
      }

      // Pairing code
      if (
        !state.creds.registered &&
        PAIRING_NUMBER &&
        !pairingRequested &&
        (connection === "connecting" || qr)
      ) {
        pairingRequested = true;

        try {
          // Give the socket a moment to finish initial handshake.
          await new Promise(resolve =>
            setTimeout(resolve, 2500)
          );

          if (state.creds.registered) {
            console.log("✅ Already registered.");
            return;
          }

          console.log(
            "⏳ Requesting WhatsApp pairing code..."
          );

          const code =
            await sock.requestPairingCode(PAIRING_NUMBER);

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

        pairingRequested = false;
        reconnecting = false;
      }

      if (connection === "close") {
        reconnecting = false;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        const loggedOut =
          statusCode === DisconnectReason.loggedOut;

        console.log(
          `❌ WhatsApp connection closed. Status: ${statusCode || "unknown"}`
        );

        if (loggedOut) {
          console.log(
            "🚪 WhatsApp logged out. Delete auth_info_baileys and pair again."
          );
          return;
        }

        console.log(
          "🔄 Reconnecting to WhatsApp in 5 seconds..."
        );

        pairingRequested = false;

        setTimeout(() => {
          connectWhatsApp().catch(console.error);
        }, 5000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        const msg = messages?.[0];

        if (!msg?.message) return;
        if (msg.key.fromMe) return;
        if (msg.key.remoteJid?.endsWith("@g.us")) return;
        if (msg.key.remoteJid === "status@broadcast") return;

        const jid = msg.key.remoteJid;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";

        if (!text.trim()) return;

        console.log(
          `📩 Message from ${jid}: ${text}`
        );

        // Existing order flow
        const flowReply =
          await handleOrderFlow(jid, text);

        if (flowReply) {
          await sock.sendMessage(jid, {
            text: flowReply
          });

          return;
        }

        // Greeting
        if (isGreeting(text)) {
          await sock.sendMessage(jid, {
            text: GREETING
          });

          return;
        }

        // Help
        if (isHelp(text)) {
          await sock.sendMessage(jid, {
            text: HELP
          });

          return;
        }

        // Delivery
        if (isDelivery(text)) {
          await sock.sendMessage(jid, {
            text: DELIVERY
          });

          return;
        }

        // Payment
        if (isPayment(text)) {
          await sock.sendMessage(jid, {
            text: PAYMENT
          });

          return;
        }

        // ORDER product
        if (isOrderRequest(text)) {
          const cleaned = text
            .replace(/order/gi, "")
            .replace(/অর্ডার/g, "")
            .trim();

          if (cleaned) {
            const result =
              await productReply(cleaned, jid);

            if (result?.product) {
              if (Number(result.product.stock || 0) <= 0) {
                await sock.sendMessage(jid, {
                  text: `দুঃখিত 😔 ${result.product.name} বর্তমানে stock out।`
                });

                return;
              }

              const reply =
                await startOrder(
                  jid,
                  result.product
                );

              await sock.sendMessage(jid, {
                text: reply
              });

              return;
            }
          }

          await sock.sendMessage(jid, {
            text: "কোন productটি order করতে চান? Product-এর নাম লিখুন।"
          });

          return;
        }

        // Product search
        const result =
          await productReply(text, jid);

        if (result?.product) {
          await sock.sendMessage(jid, {
            text: result.reply
          });

          return;
        }

        // Fallback
        await sock.sendMessage(jid, {
          text:
            "দুঃখিত, আপনার প্রশ্নটা হয়তো আমি বুঝিনি 😅\n\nProduct-এর নাম বা `help` লিখে আবার চেষ্টা করুন।"
        });

      } catch (error) {
        console.error(
          "❌ Message handling error:",
          error
        );
      }
    });

  } catch (error) {
    reconnecting = false;

    console.error(
      "❌ WhatsApp startup error:",
      error
    );

    setTimeout(() => {
      connectWhatsApp().catch(console.error);
    }, 5000);
  }
}

/* =========================
   START
========================= */

console.log("🚀 Starting True Seller WhatsApp Bot...");

if (!FIREBASE_DB_URL) {
  console.warn(
    "⚠️ FIREBASE_DB_URL is not configured."
  );
}

if (!PAIRING_NUMBER) {
  console.warn(
    "⚠️ PAIRING_NUMBER is not configured."
  );
} else {
  console.log(
    `📱 Pairing number configured: ${PAIRING_NUMBER.slice(0, 3)}*******`
  );
}

connectWhatsApp().catch(console.error);
