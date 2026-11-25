import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "ورود مدیر الزامی است." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const aiApiUrl = Deno.env.get("AI_API_URL");
    const aiApiKey = Deno.env.get("AI_API_KEY");
    const aiModel = Deno.env.get("AI_MODEL");
    if (!supabaseUrl || !anonKey) return json({ error: "تنظیمات Supabase سمت سرور کامل نیست." }, 500);
    if (!aiApiUrl || !aiApiKey || !aiModel) {
      return json({ error: "تنظیمات سرویس هوش مصنوعی کامل نیست؛ AI_API_URL، AI_API_KEY و AI_MODEL را در Secrets وارد کنید." }, 503);
    }

    // احراز هویت با نشست کاربر و بررسی دسترسی مدیر؛ هیچ service-role key در مرورگر استفاده نمی‌شود.
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) return json({ error: "نشست ورود معتبر نیست؛ دوباره وارد شوید." }, 401);
    const { data: isAdmin, error: adminError } = await supabase.rpc("is_admin");
    if (adminError || isAdmin !== true) return json({ error: "این حساب دسترسی مدیر ندارد." }, 403);

    const body = await req.json().catch(() => ({}));
    const question = typeof body.question === "string" ? body.question.trim().slice(0, 1200) : "";
    if (!question) return json({ error: "سؤال خالی است." }, 400);

    // فقط داده‌های تجمیعی پذیرفته می‌شوند؛ نام، تلفن و نشانی مشتری ارسال نمی‌شود.
    const a = body.analytics && typeof body.analytics === "object" ? body.analytics : {};
    const allowed = {
      orders_count: Number(a.orders_count || 0),
      active_orders: Number(a.active_orders || 0),
      cancelled_orders: Number(a.cancelled_orders || 0),
      order_value: Number(a.order_value || 0),
      pending_payment_count: Number(a.pending_payment_count || 0),
      product_count: Number(a.product_count || 0),
      out_of_stock: Number(a.out_of_stock || 0),
      low_stock: Number(a.low_stock || 0),
      top_products: Array.isArray(a.top_products) ? a.top_products.slice(0, 5).map((p: any) => ({
        name: String(p?.name || "محصول").slice(0, 100),
        quantity: Number(p?.quantity || 0),
      })) : [],
    };

    const aiResponse = await fetch(aiApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${aiApiKey}` },
      body: JSON.stringify({
        model: aiModel,
        temperature: 0.35,
        max_tokens: 700,
        messages: [
          {
            role: "system",
            content: "تو دستیار تحلیلی فروشگاه اینترنتی مردیس‌شاپ هستی. فقط بر اساس داده‌های ارائه‌شده تحلیل کن، فارسی روان و کوتاه پاسخ بده، اگر داده‌ای وجود ندارد صریح بگو. بین مبلغ سفارش‌های ثبت‌شده و پرداخت قطعی تفاوت بگذار؛ داده‌ی پرداخت قطعی در اختیار تو نیست. پیشنهادها باید عملی و محتاطانه باشند. هیچ تغییری در سفارش، قیمت، موجودی یا اطلاعات مشتری انجام نمی‌دهی و فقط تحلیل و پیشنهاد ارائه می‌کنی.",
          },
          { role: "user", content: `داده‌های تجمیعی فروشگاه:\n${JSON.stringify(allowed)}\n\nسؤال مدیر:\n${question}` },
        ],
      }),
    });

    const result = await aiResponse.json().catch(() => ({}));
    if (!aiResponse.ok) {
      const message = typeof result?.error?.message === "string" ? result.error.message : "پاسخ سرویس هوش مصنوعی دریافت نشد.";
      return json({ error: message }, 502);
    }
    const answer = result?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) return json({ error: "پاسخ خالی از سرویس هوش مصنوعی دریافت شد." }, 502);
    return json({ answer: answer.trim() });
  } catch (error) {
    console.error("mardis-ai-assistant error", error);
    return json({ error: "خطای داخلی در پردازش درخواست." }, 500);
  }
});
