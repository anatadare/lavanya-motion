import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Buffer } from "node:buffer";

// ------------------------------------------------------------------ prompts
const VISION_SYSTEM = `You are a motion analyst for AI image-to-video generation.
You receive evenly spaced frames from a short reference video, each with a timestamp.
Describe ONLY what is actually visible. Do not guess or invent.

Output these sections, in plain text:

SCENE: environment, lighting, time of day (brief).
SUBJECT MOTION: a timeline by seconds. For each beat describe which body parts move, direction, speed, weight/momentum, and secondary motion (cloth, hair, fabric, props).
CAMERA: movement type (static, pan, tilt, dolly in/out, truck, orbit, handheld, zoom), direction, speed, framing and lens feel, and any shake.
REALISM CUES: micro-movements (breathing, blinking, weight shift), physics, motion blur, easing (accelerates / decelerates).
PACING: total duration and overall tempo (slow, natural, fast).`;

const FINAL_SYSTEM = `You write prompts for image-to-video models.
The start image already defines the subject's appearance, clothes and background, so do NOT redescribe them. Refer to "the subject" and describe only MOTION and CAMERA.

You get a motion analysis of a reference video. Convert it into:

1) MOTION PROMPT - what the subject does, in order, with timing and natural physics.
2) CAMERA PROMPT - camera movement, speed, framing.
3) FINAL PROMPT - one single paragraph in English, present tense, combining motion + camera, ready to paste. Aim for realistic, grounded movement: natural speed, subtle micro-movements, believable weight and momentum, smooth easing, consistent identity. No exaggerated or surreal motion.
4) NEGATIVE PROMPT - short comma separated list (e.g. morphing, warping, extra limbs, jitter, flicker, unnatural speed, identity change, text, watermark).
5) SETTINGS - suggested duration in seconds and motion strength (low / medium / high).

{style_rule}
If the user gave an extra note, follow it. Output plain text only, no markdown symbols.`;

const STYLE_RULES = {
  natural: "FINAL PROMPT style: fluent natural sentences, 60-120 words.",
  tags: "FINAL PROMPT style: short comma separated tags and phrases, under 60 words.",
};

const HELP = `Kirim video pendek (maks 20MB, ideal 3-10 detik).

Caption video = catatan tambahan (opsional), contoh: "kamera pelan, gerakan lebih lambat".
Tulis #tags di caption kalau mau prompt berbentuk tag singkat.`;

const MAX_VIDEO_BYTES = 20 * 1024 * 1024; // batas download bot Telegram

// ------------------------------------------------------------------ helpers
const list = (s, fallback) =>
  String(s || fallback || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || r.status}`);
  return data.result;
}

async function sendLong(env, chatId, text, replyTo) {
  for (let i = 0; i < text.length; i += 3800) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: text.slice(i, i + 3800),
      ...(i === 0 && replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}),
    });
  }
}

async function chat(env, models, messages, { maxTokens = 1500, temperature = 0.4 } = {}) {
  const base = String(env.JEROUTER_BASE_URL || "").replace(/\/+$/, "");
  let lastErr;
  for (const model of models) {
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.JEROUTER_API_KEY}`,
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      const data = await r.json();
      let text = data?.choices?.[0]?.message?.content;
      if (Array.isArray(text)) text = text.map((p) => p?.text || "").join("");
      if (typeof text === "string" && text.trim()) {
        console.log(`ok model=${model}`);
        return text.trim();
      }
      throw new Error("respon kosong");
    } catch (e) {
      console.warn(`model ${model} gagal: ${e.message}`);
      lastErr = e;
    }
  }
  throw new Error(`Semua model gagal: ${lastErr?.message}`);
}

// ------------------------------------------------------------------ pipeline steps
async function extractFrames(env, p) {
  const f = await tg(env, "getFile", { file_id: p.fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${f.file_path}`);
  if (!res.ok) throw new NonRetryableError(`Gagal download video (${res.status})`);
  const buf = await res.arrayBuffer();

  const n = Math.max(2, Math.min(parseInt(env.MAX_FRAMES || "6", 10) || 6, 8));
  const dur = p.duration > 0 ? p.duration : 5;

  const grab = async (t) => {
    // satu input() hanya bisa dipakai sekali, jadi stream baru untuk tiap frame
    const out = await env.MEDIA.input(new Response(buf).body)
      .transform({ width: 640 })
      .output({ mode: "frame", time: `${t}s`, format: "jpg" })
      .response();
    if (!out.ok) throw new Error(`frame ${t}s gagal (${out.status})`);
    return { t, b64: Buffer.from(await out.arrayBuffer()).toString("base64") };
  };

  const run = async (times) => {
    const settled = await Promise.allSettled(times.map(grab));
    return {
      frames: settled.filter((s) => s.status === "fulfilled").map((s) => s.value),
      firstError: settled.find((s) => s.status === "rejected")?.reason,
    };
  };

  const times = Array.from({ length: n }, (_, i) => +((dur * (i + 0.5)) / n).toFixed(1));
  let { frames, firstError } = await run(times);

  if (!frames.length) {
    // fallback: detik bulat saja
    const whole = [...new Set(times.map((t) => Math.floor(t)))];
    ({ frames, firstError } = await run(whole));
  }
  if (!frames.length) {
    throw new NonRetryableError(`Tidak ada frame yang berhasil diambil: ${firstError?.message || "unknown"}`);
  }

  // state per step maksimal 1 MiB, jaga di bawah itu
  const size = (arr) => arr.reduce((a, x) => a + x.b64.length, 0);
  while (size(frames) > 900000 && frames.length > 2) {
    frames = frames.filter((_, i) => i % 2 === 0);
  }
  return frames;
}

async function analyze(env, frames, p) {
  const content = [
    {
      type: "text",
      text:
        `Reference video, duration ${p.duration || "unknown"}s, ${frames.length} frames in order.` +
        (p.note ? `\nUser note: ${p.note}` : ""),
    },
  ];
  for (const fr of frames) {
    content.push({ type: "text", text: `Frame at ${fr.t}s:` });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fr.b64}` } });
  }
  return chat(
    env,
    list(env.VISION_MODELS, "grok-4.6,qwen3.8-27b,mimo-v2.5"),
    [
      { role: "system", content: VISION_SYSTEM },
      { role: "user", content },
    ],
    { maxTokens: 1800, temperature: 0.2 },
  );
}

async function writePrompt(env, analysis, p) {
  const system = FINAL_SYSTEM.replace("{style_rule}", STYLE_RULES[p.style] || STYLE_RULES.natural);
  let user = `Reference duration: ${p.duration || "unknown"}s\n\nMOTION ANALYSIS:\n${analysis}`;
  if (p.note) user += `\n\nUser note: ${p.note}`;
  return chat(
    env,
    list(env.TEXT_MODELS, "jev-1.13,nemotron-3-super"),
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { maxTokens: 1500, temperature: 0.5 },
  );
}

// ------------------------------------------------------------------ workflow
export class MotionPipeline extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    const p = event.payload;
    let statusId = null;

    try {
      statusId = await step.do(
        "kirim status",
        { retries: { limit: 2, delay: "2 seconds" }, timeout: "30 seconds" },
        async () => {
          const m = await tg(env, "sendMessage", {
            chat_id: p.chatId,
            text: "Memproses video, sekitar 30-90 detik...",
            reply_to_message_id: p.messageId,
            allow_sending_without_reply: true,
          });
          return m.message_id;
        },
      );

      const frames = await step.do(
        "ambil frame",
        { retries: { limit: 1, delay: "3 seconds" }, timeout: "3 minutes" },
        () => extractFrames(env, p),
      );

      const analysis = await step.do(
        "analisis gerakan",
        { retries: { limit: 1, delay: "5 seconds" }, timeout: "6 minutes" },
        () => analyze(env, frames, p),
      );

      let result;
      try {
        result = await step.do(
          "tulis prompt",
          { retries: { limit: 1, delay: "5 seconds" }, timeout: "4 minutes" },
          () => writePrompt(env, analysis, p),
        );
      } catch (e) {
        console.warn(`tahap tulis prompt gagal: ${e.message}`);
        result = "(Tahap penulisan prompt gagal, ini hasil analisis mentah)\n\n" + analysis;
      }

      await step.do(
        "kirim hasil",
        { retries: { limit: 3, delay: "3 seconds" }, timeout: "1 minute" },
        async () => {
          if (statusId) {
            await tg(env, "deleteMessage", { chat_id: p.chatId, message_id: statusId }).catch(() => {});
          }
          await sendLong(env, p.chatId, result, p.messageId);
        },
      );
    } catch (e) {
      console.error(`workflow gagal: ${e.message}`);
      await step.do(
        "lapor error",
        { retries: { limit: 2, delay: "2 seconds" }, timeout: "30 seconds" },
        async () => {
          const text = `Gagal: ${String(e.message || e).slice(0, 500)}`;
          if (statusId) {
            await tg(env, "editMessageText", {
              chat_id: p.chatId,
              message_id: statusId,
              text,
            }).catch(() => tg(env, "sendMessage", { chat_id: p.chatId, text }));
          } else {
            await tg(env, "sendMessage", { chat_id: p.chatId, text });
          }
        },
      );
    }
  }
}

// ------------------------------------------------------------------ webhook
function getMedia(msg) {
  if (msg.video) return msg.video;
  if (msg.animation) return msg.animation;
  if (msg.video_note) return msg.video_note;
  if (msg.document && (msg.document.mime_type || "").startsWith("video/")) return msg.document;
  return null;
}

async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg) return;

  const allowed = list(env.ALLOWED_USER_IDS);
  if (allowed.length && !allowed.includes(String(msg.from?.id))) return;

  const chatId = msg.chat.id;

  if (msg.text && /^\/(start|help)\b/.test(msg.text)) {
    await tg(env, "sendMessage", { chat_id: chatId, text: HELP });
    return;
  }

  const media = getMedia(msg);
  if (!media) return;

  if (media.file_size && media.file_size > MAX_VIDEO_BYTES) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Video terlalu besar (maks 20MB). Kompres atau potong dulu.",
      reply_to_message_id: msg.message_id,
    });
    return;
  }

  let note = (msg.caption || "").trim();
  let style = "natural";
  if (/#tags\b/i.test(note)) {
    style = "tags";
    note = note.replace(/#tags\b/gi, "").trim();
  }

  try {
    await env.PIPELINE.create({
      id: `u${update.update_id}`, // id sama = update yang sama, tidak diproses dua kali
      params: {
        chatId,
        messageId: msg.message_id,
        fileId: media.file_id,
        duration: media.duration || 0,
        note,
        style,
      },
    });
  } catch (e) {
    console.error(`gagal membuat workflow: ${e.message}`);
    if (!/already exists|duplicate/i.test(String(e.message))) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `Gagal memulai proses: ${String(e.message).slice(0, 300)}`,
      }).catch(() => {});
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // buka sekali setelah deploy untuk mendaftarkan webhook Telegram
    if (url.pathname === "/setup") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const result = await tg(env, "setWebhook", {
          url: `${url.origin}/webhook`,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message"],
          drop_pending_updates: true,
        });
        return Response.json({ ok: true, result, webhook: `${url.origin}/webhook` });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      try {
        await handleUpdate(await request.json(), env);
      } catch (e) {
        // selalu balas 200 supaya Telegram tidak mengirim ulang update yang sama
        console.error(`handleUpdate error: ${e.message}`);
      }
      return new Response("ok");
    }

    return new Response("motion prompt bot aktif");
  },
};
