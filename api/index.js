import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  next();
});

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  FRONTEND_URL,
} = process.env;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

function verifyShopifyHmac(query) {
  const { hmac, signature, ...rest } = query;

  if (!hmac || !SHOPIFY_API_SECRET) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => {
      const value = Array.isArray(rest[key]) ? rest[key].join(",") : rest[key];
      return `${key}=${value}`;
    })
    .join("&");

  const generatedHash = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(generatedHash, "utf8"),
      Buffer.from(String(hmac), "utf8")
    );
  } catch {
    return false;
  }
}

app.get("/", (req, res) => {
  res.status(200).send("AMHUK Shopify backend is running");
});

app.get("/api", (req, res) => {
  res.status(200).send("AMHUK Shopify backend is running");
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    ok: true,
    message: "AMHUK Shopify backend is running",
  });
});

app.get("/api/shopify/connect", (req, res) => {
  try {
    const shopQuery = String(req.query.shop || "").trim();

    if (!shopQuery) {
      return res.status(400).json({
        error: "Shop is required",
      });
    }

    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      return res.status(500).json({
        error: "Shopify API key or secret missing in Vercel env",
      });
    }

    const shop = shopQuery.includes(".myshopify.com")
      ? shopQuery
      : `${shopQuery}.myshopify.com`;

    const scopes = [
      "read_orders",
      "read_customers",
      "read_products",
      "read_fulfillments",
    ].join(",");

    const redirectUri = `https://${req.headers.host}/api/shopify/callback`;

    const installUrl =
      `https://${shop}/admin/oauth/authorize?` +
      `client_id=${SHOPIFY_API_KEY}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}`;

    return res.redirect(installUrl);
  } catch (error) {
    console.error("Shopify connect error:", error);
    return res.status(500).json({
      error: "Shopify connect failed",
    });
  }
});

app.get("/api/shopify/callback", async (req, res) => {
  try {
    const { shop, code, hmac } = req.query;

    if (!shop || !code || !hmac) {
      return res.status(400).json({
        error: "Missing Shopify callback params",
      });
    }

    const isValid = verifyShopifyHmac(req.query);

    if (!isValid) {
      return res.status(401).json({
        error: "Invalid Shopify HMAC",
      });
    }

    const tokenResponse = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: SHOPIFY_API_KEY,
          client_secret: SHOPIFY_API_SECRET,
          code,
        }),
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("Shopify token error:", tokenData);
      return res.status(500).json({
        error: "Unable to get Shopify access token",
      });
    }

    if (!supabase) {
      return res.status(500).json({
        error: "Supabase env variables missing",
      });
    }

    const { error } = await supabase.from("shopify_connections").upsert(
  {
    shop_domain: shop,
    access_token: tokenData.access_token,
    scope: tokenData.scope || "",
  },
  {
    onConflict: "shop_domain",
  }
);

    if (error) {
      console.error("Supabase token save error:", error);
      return res.status(500).json({
        error: "Unable to save Shopify token in Supabase",
      });
    }

    const redirectUrl =
      FRONTEND_URL ||
      "https://arena.ai/c/019eab1f-9259-7445-82c4-623f8e11b241";

    return res.redirect(`${redirectUrl}#/settings?shopify=connected`);
  } catch (error) {
    console.error("Shopify callback error:", error);
    return res.status(500).json({
      error: "Shopify callback failed",
    });
  }
});

app.get("/api/shopify/order-lookup", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    const orderId = String(req.query.orderId || "").trim();
    const contact = String(req.query.contact || "").trim();

    if (!shop || !orderId) {
      return res.status(400).json({
        error: "shop and orderId are required",
      });
    }

    if (!supabase) {
      return res.status(500).json({
        error: "Supabase env variables missing",
      });
    }

    const { data: connection, error: connectionError } = await supabase
      .from("shopify_connections")
      .select("*")
      .eq("shop", shop)
      .single();

    if (connectionError || !connection?.access_token) {
      return res.status(404).json({
        error: "Shopify store not connected",
      });
    }

    const queryOrderName = orderId.startsWith("#") ? orderId : `#${orderId}`;

    const shopifyUrl =
      `https://${shop}/admin/api/2024-10/orders.json?` +
      `status=any&limit=10&name=${encodeURIComponent(queryOrderName)}`;

    const orderResponse = await fetch(shopifyUrl, {
      headers: {
        "X-Shopify-Access-Token": connection.access_token,
        "Content-Type": "application/json",
      },
    });

    const orderData = await orderResponse.json();

    if (!orderResponse.ok) {
      console.error("Shopify order lookup error:", orderData);
      return res.status(500).json({
        error: "Unable to fetch order from Shopify",
      });
    }

    const orders = orderData.orders || [];

    if (orders.length === 0) {
      return res.status(404).json({
        error: "Order not found",
      });
    }

    const order = orders[0];

    if (contact) {
      const customerEmail = String(order.email || "").toLowerCase();
      const customerPhone = String(
        order.phone || order.customer?.phone || ""
      ).replace(/\D/g, "");

      const enteredRaw = String(contact || "").toLowerCase();
      const enteredPhone = enteredRaw.replace(/\D/g, "");

      const emailMatch = customerEmail && customerEmail === enteredRaw;
      const phoneMatch =
        customerPhone &&
        enteredPhone &&
        customerPhone.endsWith(enteredPhone.slice(-10));

      if (!emailMatch && !phoneMatch) {
        return res.status(401).json({
          error: "Order found but contact does not match",
        });
      }
    }

    const firstItem = order.line_items?.[0] || {};

    return res.status(200).json({
      success: true,
      order: {
        orderId: order.name || "",
        customerName:
          `${order.customer?.first_name || ""} ${
            order.customer?.last_name || ""
          }`.trim() ||
          order.billing_address?.name ||
          "",
        email: order.email || "",
        mobile: order.phone || order.customer?.phone || "",
        productName: firstItem.name || "",
        sku: firstItem.sku || "",
        quantity: firstItem.quantity || 1,
        paymentStatus: order.financial_status || "",
        fulfillmentStatus: order.fulfillment_status || "unfulfilled",
        orderDate: order.created_at || "",
      },
    });
  } catch (error) {
    console.error("Order lookup server error:", error);
    return res.status(500).json({
      error: "Order lookup failed",
    });
  }
});

export default app;
