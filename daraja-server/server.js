// server.js
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const bodyParser = require("body-parser");
const morgan = require("morgan");

const app = express();
app.use(bodyParser.json());
app.use(morgan("dev"));

const PORT = process.env.PORT || 3000;
const ENV = process.env.ENV || "SANDBOX";

const DB_PATH = path.join(__dirname, "db.json");
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH)); }
  catch (e) { return { transactions: [], users: [] }; }
}
function writeDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

// Daraja config
const consumerKey = process.env.CONSUMER_KEY;
const consumerSecret = process.env.CONSUMER_SECRET;
const shortcode = process.env.SHORTCODE;
const passkey = process.env.PASSKEY;
let callbackURL = process.env.CALLBACK_URL || "https://example.com/callback";

const SANDBOX_OAUTH = "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";
const SANDBOX_STK = "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";
const PROD_OAUTH = "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";
const PROD_STK = "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

const OAUTH_URL = ENV === "PROD" ? PROD_OAUTH : SANDBOX_OAUTH;
const STK_URL   = ENV === "PROD" ? PROD_STK   : SANDBOX_STK;

// Simple in-memory token cache
let cache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  if (cache.token && cache.expiresAt > now) return cache.token;

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const res = await axios.get(OAUTH_URL, { headers: { Authorization: `Basic ${auth}` } });
  const token = res.data.access_token;
  // typical expiry 3600 seconds
  const ttl = (res.data.expires_in || 3600) * 1000;
  cache.token = token;
  cache.expiresAt = Date.now() + ttl - 10 * 1000; // refresh a bit early
  return token;
}

// Utility: current timestamp in YYYYMMDDHHmmss
function getTimestamp() {
  const d = new Date();
  const z = (n) => (n < 10 ? "0" + n : n);
  return (
    d.getFullYear().toString() +
    z(d.getMonth() + 1) +
    z(d.getDate()) +
    z(d.getHours()) +
    z(d.getMinutes()) +
    z(d.getSeconds())
  );
}

// STK push endpoint (frontend calls this to initiate an M-Pesa STK)
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount, accountRef = "Ref", desc = "Payment" } = req.body;
    if (!phone || !amount) return res.status(400).json({ error: "phone and amount required" });

    const token = await getToken();
    const timestamp = getTimestamp();
    const password = Buffer.from(shortcode + passkey + timestamp).toString("base64");

    // The callback URL should be accessible publicly (ngrok or deployed domain)
    const cbUrl = callbackURL;

    const body = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: cbUrl,
      AccountReference: accountRef,
      TransactionDesc: desc
    };

    const r = await axios.post(STK_URL, body, { headers: { Authorization: `Bearer ${token}` } });
    // Save initial request to DB
    const db = readDB();
    const tx = {
      id: Date.now(),
      phone,
      amount,
      accountRef,
      desc,
      request: r.data,
      createdAt: new Date().toISOString(),
      status: "PENDING"
    };
    db.transactions.push(tx);
    writeDB(db);

    res.json({ success: true, data: r.data, localId: tx.id });
  } catch (err) {
    console.error("STK error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Callback endpoint that Safaricom calls after STK push completes
app.post("/callback", (req, res) => {
  // Safaricom expects HTTP 200 quickly; we respond immediately after storing
  try {
    console.log("Daraja callback body:", JSON.stringify(req.body, null, 2));

    // STK push callback payload is in req.body.Body.stkCallback
    const stk = req.body?.Body?.stkCallback;
    if (!stk) {
      // It could be other Daraja callbacks; store raw
      const db = readDB();
      db.transactions.push({ id: Date.now(), rawCallback: req.body, createdAt: new Date().toISOString() });
      writeDB(db);
      return res.json({ ResultCode: 0, ResultDesc: "Received" });
    }

    const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stk;

    const db = readDB();
    // Find the pending transaction by matching CheckoutRequestID inside request (if saved)
    // Fallback: mark by recent pending with similar amount/phone
    let tx = db.transactions.find(t => {
      try {
        const chk = t.request?.CheckoutRequestID || t.request?.data?.CheckoutRequestID || null;
        return chk === CheckoutRequestID;
      } catch(e){ return false; }
    });

    // Extract metadata items
    let meta = {};
    if (CallbackMetadata?.Item && Array.isArray(CallbackMetadata.Item)) {
      CallbackMetadata.Item.forEach(i => {
        meta[i.Name] = i.Value;
      });
    }

    if (tx) {
      tx.stkCallback = { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc, meta, receivedAt: new Date().toISOString() };
      tx.status = ResultCode === 0 ? "SUCCESS" : "FAILED";
      if (ResultCode === 0) {
        tx.mpesaReceiptNumber = meta.MpesaReceiptNumber || null;
        tx.amountPaid = meta.Amount || null;
        tx.phone = meta.PhoneNumber || tx.phone;
        // TODO: mark user subscription active here (link to your user system)
      }
    } else {
      // no matching tx found — store callback as new record
      db.transactions.push({
        id: Date.now(),
        CheckoutRequestID,
        MerchantRequestID,
        ResultCode,
        ResultDesc,
        meta,
        createdAt: new Date().toISOString(),
        status: ResultCode === 0 ? "SUCCESS" : "FAILED"
      });
    }

    writeDB(db);
    // Respond quickly
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    console.error("callback handler error:", err);
    // still acknowledge to avoid retries
    res.json({ ResultCode: 0, ResultDesc: "Accepted with handler error" });
  }
});

// Simple: list transactions (for testing)
app.get("/transactions", (req, res) => {
  const db = readDB();
  res.json(db.transactions.slice(-50).reverse());
});

app.listen(PORT, () => {
  console.log(`Daraja server running on port ${PORT} (ENV=${ENV})`);
  console.log(`Callback URL should be: ${callbackURL}`);
});
