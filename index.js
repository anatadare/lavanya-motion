import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Buffer } from "node:buffer";

// ------------------------------------------------------------------ prompts
const VISION_SYSTEM = `You are a motion-capture analyst preparing data for AI image-to-video generation.
You receive frames from ONE SEGMENT of a longer reference video. Each frame has an absolute timestamp (seconds from the start of the full video).
Describe ONLY what is actually visible. Never invent. If something cannot be determined (fast motion between frames, occlusion, blur), say so under UNCERTAIN.
If context from the previous segment is given, continue from it and keep the same terminology.

Output these sections in plain text:

TIMELINE: beats with time ranges (e.g. 5.0-6.5s). For EACH beat give, only where visible:
- HEAD / GAZE: turn, tilt, nod, where the eyes look.
- TORSO / SHOULDERS: lean, twist, rise/drop, breathing.
- ARMS / HANDS / FINGERS: which side, path of travel, gesture, grip, contact with objects or body.
- HIPS / LEGS / FEET: steps, weight shift, which foot leads, jump, sway.
- FACE: expression changes, mouth, blinks.
- FACING and TRAVEL: facing direction relative to camera, direction subject moves in frame.
- QUALITY: speed (slow / medium / fast), accelerating or decelerating, weight and momentum, secondary motion (hair, cloth, props).

CAMERA: judge camera movement by comparing fixed background landmarks between frames, separately from subject movement. Per time range give: static / pan / tilt / dolly in-out / truck / pedestal / orbit / handheld / zoom, direction, speed, framing change (wide / medium / close), lens feel, shake or stabilization.

FRAME POSITION: where the subject sits in the frame at the start and the end of the segment (left / center / right, size relative to frame).

ENVIRONMENT NEEDS: what the motion physically requires from its surroundings, based on what is visible: ground contact and surface type (floor, grass, sand, stairs, water), how much open space the subject uses, props or furniture the subject touches or moves around, lighting direction and mood, and whether the camera move depends on background depth (parallax) or on a clear path. Describe the needs, not the exact background of the reference.

CUTS: any hard cut or scene change, with its time. Write "none" if there is none.

SETUP (full detail in segment 1; in later segments write only what changed, or "unchanged"):
- ORIENTATION: portrait / landscape / square.
- VISIBLE BODY: which body parts are inside the frame (e.g. head and shoulders, waist up, full body), shot distance, subject size and position in frame.
- START POSE: exact pose at the first frame: seated / standing / lying, facing direction, head angle, arm and hand positions, expression.
- PEOPLE: number of people visible.
- PROPS: objects the subject holds or touches (e.g. a phone), which hand, and whether the object itself is visible in frame.
- SPEECH: time ranges where the mouth appears to be speaking, versus smiling or silent.
- CLOTHING PHYSICS: loose cloth, scarf or hijab, hair, jewelry, and how they move.

RISKS: list any that apply: hard cut, more than one person, face or hands hidden or leaving the frame, very fast motion or blur, subject leaving the frame, fast camera move, strong lighting change. Write "none" if none.

END STATE: pose, position in frame, motion still in progress, and camera state at the last frame (used to continue the next segment).

UNCERTAIN: what could not be determined (one line).

LENGTH RULE: be concise. Merge similar frames into fewer beats (max 6 beats per segment), one short line per body part, skip body parts that are not visible. Total under 600 words. ALWAYS finish with END STATE and UNCERTAIN.`;

const FINAL_SYSTEM = `You write prompts for image-to-video models.
The start image defines the subject's appearance and clothes, so do NOT redescribe them. Say "the subject" and describe only MOTION and CAMERA in the clip prompts. The background of the reference video is NOT required: you recommend the best background for the output video instead (see BACKGROUND RECOMMENDATION).

You get segment-by-segment motion analyses of one reference video. Each segment is one clip. Convert them into the output below. Use only what the analyses say. Do not add motion that was not observed. If a segment is marked as failed, say so briefly and skip it.

Output format (plain text, no markdown symbols):

OVERVIEW: 2-3 lines on the overall action, pacing and camera of the whole video.

BACKGROUND RECOMMENDATION: choose backgrounds that make this exact motion and camera easiest for an image-to-video model to render cleanly, using the ENVIRONMENT NEEDS in the analyses (ground surface, open space, props, lighting, parallax). Prefer simple, uncluttered, coherent backgrounds with a clear depth and a stable ground plane; avoid busy patterns, crowds, thin repeating lines, reflections and water surfaces unless the motion needs them, because they cause warping and flicker.
BEST PICK: one background, in one line, then 2-3 short lines on why it fits (space, ground, lighting, camera).
ALTERNATIVE 1 and ALTERNATIVE 2: one line each with a different mood, plus one short reason each.
START IMAGE PROMPT: one English paragraph for an image generator describing the BEST PICK background, lighting, time of day and composition (where the subject stands in the frame, with enough room for the motion and the camera move), with the subject left as "the subject". Do not describe the subject's looks.
If the user's note names a background, use it as BEST PICK and add one line of warning only if it conflicts with the motion.

CLIP 1 (0-5s):
PROMPT: one paragraph in English, present tense, motion + camera in order, consistent with the BEST PICK background (for example ground contact and depth for parallax, but do not redescribe the background), with natural physics, believable weight and momentum, smooth easing, subtle micro-movements, consistent identity. No exaggerated or surreal motion.
(repeat for every segment. For clip 2 and later, begin from the end state of the previous clip. The start image of each later clip should be the last frame of the previous clip.)

NEGATIVE PROMPT: short comma separated list (e.g. morphing, warping, extra limbs, jitter, flicker, unnatural speed, identity change, text, watermark).

SETTINGS: for each clip, duration in seconds, motion strength (low / medium / high) and camera strength (low / medium / high). Add one line of tips for chaining the clips smoothly.

{style_rule}
If the user gave an extra note, follow it. Use the real time ranges from the segment labels.`;

const CONTROL_SYSTEM = `You prepare inputs for MOTION CONTROL / motion capture video generation (for example Kling Motion Control). In this mode the model copies the body and face motion directly from the uploaded reference video, and the character comes from a still start image. So the text prompt must NOT describe the motion in detail. It only describes what the reference video cannot supply: scene, background, lighting, mood and camera look.

You get segment-by-segment analyses of ONE reference video. Use only what they say. Do not invent. If a segment is marked as failed, mention it in RISIKO.

Write the section labels and notes in Indonesian. Write every PROMPT and the NEGATIVE PROMPT in English. Plain text, no markdown symbols. Use exactly this structure:

KECOCOKAN REFERENSI:
- Orientasi dan durasi: orientation and total duration. Remind the user that motion control usually follows the reference length and that the platform duration limit must be checked.
- Framing: which body parts are visible, shot distance, subject position in frame. Say clearly that the start image must use the SAME framing (for example a close selfie framing, not a full-body image) or the result will warp.
- Pose awal: the exact pose in the first frame. The start image must begin in this same pose.
- Properti: held or touched objects and which hand. Say whether the object should appear in the start image (a phone held toward the camera is often rendered badly, so recommend whether to keep it visible or leave it out).
- Mulut dan bicara: time ranges where the subject speaks, if any. Audio is ignored, so give both options: keep the mouth movement from the reference, or ask for a closed or relaxed mouth.
- Kamera: say whether the camera is static, handheld or moving. If it is handheld with shake, give both options (keep a subtle handheld feel versus stabilized) and recommend one.
- Kain dan pakaian: loose cloth, scarf, hair motion. Note that a different outfit type in the start image can behave differently from the reference.

RISIKO: a short bullet list ("-") of problems that often make motion control fail, based ONLY on the analyses (cuts, more than one person, hidden face or hands, fast motion, subject leaving frame, lighting changes, failed segments). If there are none, write "Tidak ada risiko besar yang terdeteksi."

START IMAGE PROMPT:
BEST PICK: one background in one line, then 1-2 short lines on why it fits (space, ground, lighting). Choose a simple uncluttered coherent background that suits the framing and camera. If the user's note names a background, use it and warn in one line only if it conflicts.
ALTERNATIVE 1 and ALTERNATIVE 2: one line each.
PROMPT: one English paragraph for an image generator: background, lighting, time of day, composition matching the framing, the START POSE and any prop decision above. Refer to the character only as "the subject". Do not describe looks, face or clothes.

PROMPT: one short English paragraph, 40-80 words, for the video model. Scene, lighting, mood and camera look only, consistent with the BEST PICK background. At most one short clause naming the overall action for context. No step-by-step motion. Natural physics, consistent identity.

NEGATIVE PROMPT: short comma separated English list (e.g. morphing, warping, extra limbs, jitter, flicker, identity change, distorted hands, text, watermark).

CATATAN: 2-3 short lines in Indonesian with practical tips for this video (reference upload, start image matching, what to do about the main risk).

If the user gave an extra note, follow it.`;

const STYLE_RULES = {
  natural: "PROMPT style: fluent natural sentences, 60-120 words per clip.",
  tags: "PROMPT style: short comma separated tags and phrases, under 60 words per clip.",
  kling:
    "PROMPT style for Kling: clear natural English sentences, 40-90 words per clip, order = subject action, then camera. State the camera move explicitly (e.g. camera slowly pushes in).",
  runway:
    "PROMPT style for Runway: concise, 1-3 sentences per clip, start with the camera move, then the subject action. No flowery words.",
  wan: "PROMPT style for Wan: detailed cinematic description, 80-120 words per clip, with motion adjectives (slowly, smoothly, gradually) and explicit camera language.",
  veo: "PROMPT style for Veo: cinematic flowing sentences, 60-110 words per clip, camera language included. Ignore audio.",
};

const HELP = `Kirim video (maks 30 detik, maks 20MB). Bot memecah video per 5 detik, menganalisis tiap bagian, lalu menulis prompt per clip.

Caption = catatan tambahan (opsional), contoh: "kamera pelan, gerakan lebih lambat".
Mau background tertentu? Tulis di caption, contoh: "background: pantai sore". Kalau kosong, bot merekomendasikan background terbaik.

Hashtag di caption untuk gaya prompt:
#tags = tag singkat
#kling  #runway  #wan  #veo = menyesuaikan gaya model itu
Tanpa hashtag = kalimat natural.

#control = mode Motion Control / motion capture. Gerakan diambil dari video referensi, jadi hasilnya pendek: cek kecocokan referensi (framing, pose awal, properti, mulut, kamera), daftar risiko, START IMAGE PROMPT, PROMPT scene + kamera, dan NEGATIVE PROMPT.`;

const MAX_VIDEO_BYTES = 20 * 1024 * 1024; // batas download bot Telegram

// ------------------------------------------------------------------ helpers
const list = (s, fallback) =>
  String(s || fallback || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const num = (v, def, min, max) => {
  const n = parseFloat(v);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : def));
};

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

async function chat(env, models, messages, { maxTokens = 1500, temperature = 0.4, timeoutMs = 90000 } = {}) {
  const base = String(env.JEROUTER_BASE_URL || "").replace(/\/+$/, "");
  const errors = [];
  for (const model of models) {
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.JEROUTER_API_KEY}`,
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 150)}`);
      const data = await r.json();
      const choice = data?.choices?.[0];
      let text = choice?.message?.content;
      if (Array.isArray(text)) text = text.map((p) => p?.text || "").join("");
      if (typeof text === "string") {
        // buang blok reasoning kalau model menyertakannya di content
        text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();
      }
      if (text) {
        if (choice?.finish_reason === "length") console.warn(`model ${model}: output terpotong (max_tokens)`);
        console.log(`ok model=${model}`);
        return text;
      }
      throw new Error(`respon kosong (finish_reason=${choice?.finish_reason || "?"})`);
    } catch (e) {
      const msg = e?.name === "TimeoutError" ? `timeout ${Math.round(timeoutMs / 1000)}s` : e.message;
      console.warn(`model ${model} gagal: ${msg}`);
      errors.push(`${model}: ${msg}`);
    }
  }
  throw new Error(`Semua model gagal -> ${errors.join(" | ")}`);
}

// ------------------------------------------------------------------ durasi video
// Telegram TIDAK mengirim "duration" kalau video dikirim sebagai File/Document,
// jadi durasi dibaca langsung dari header MP4/MOV (atom mvhd). Hasil 0 = tidak terbaca.
function readMp4Duration(buf) {
  try {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    const walk = (start, end) => {
      let pos = start;
      while (pos + 8 <= end) {
        let size = dv.getUint32(pos);
        const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
        let header = 8;
        if (size === 1) {
          size = Number(dv.getBigUint64(pos + 8));
          header = 16;
        } else if (size === 0) {
          size = end - pos;
        }
        if (size < header) return 0;
        if (type === "moov") {
          const d = walk(pos + header, Math.min(end, pos + size));
          if (d) return d;
        } else if (type === "mvhd") {
          const v = u8[pos + header];
          const p = pos + header;
          const timescale = v === 1 ? dv.getUint32(p + 20) : dv.getUint32(p + 12);
          const dur = v === 1 ? Number(dv.getBigUint64(p + 24)) : dv.getUint32(p + 16);
          return timescale > 0 ? dur / timescale : 0;
        }
        pos += size;
      }
      return 0;
    };
    const d = walk(0, buf.byteLength);
    return d > 0 && d < 36000 ? +d.toFixed(2) : 0;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------ segment planning
function planSegments(env, durationIn) {
  const dur = durationIn > 0 ? durationIn : num(env.MAX_DURATION, 30, 5, 30); // durasi tak diketahui: asumsikan maks, segmen tanpa frame dibuang
  const segLen = num(env.SEGMENT_SECONDS, 5, 3, 10);
  const interval = num(env.FRAME_INTERVAL, dur <= 10 ? 0.5 : dur <= 20 ? 0.75 : 1, 0.25, 3);

  const bounds = [];
  for (let s = 0; s < dur - 0.05; s += segLen) bounds.push([s, Math.min(dur, s + segLen)]);
  // sisa < 1 detik digabung ke segmen sebelumnya
  if (bounds.length > 1 && bounds[bounds.length - 1][1] - bounds[bounds.length - 1][0] < 1) {
    const last = bounds.pop();
    bounds[bounds.length - 1][1] = last[1];
  }

  return bounds.map(([s, e], i) => {
    const count = Math.max(3, Math.min(12, Math.round((e - s) / interval)));
    const times = Array.from({ length: count }, (_, k) => {
      const t = s + ((k + 0.5) * (e - s)) / count;
      return +Math.min(t, Math.max(0, dur - 0.1)).toFixed(1);
    });
    return { index: i, start: +s.toFixed(1), end: +e.toFixed(1), times };
  });
}

const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

// ------------------------------------------------------------------ pipeline steps
async function grabFrames(env, buf, times) {
  const width = Math.round(num(env.FRAME_WIDTH, 768, 320, 1280));
  const grab = async (t) => {
    // satu input() hanya bisa dipakai sekali, jadi stream baru untuk tiap frame
    const out = await env.MEDIA.input(new Response(buf).body)
      .transform({ width })
      .output({ mode: "frame", time: `${t}s`, format: "jpg" })
      .response();
    if (!out.ok) throw new Error(`frame ${t}s gagal (${out.status})`);
    return { t, b64: Buffer.from(await out.arrayBuffer()).toString("base64") };
  };

  const frames = [];
  let firstError;
  // 4 sekaligus supaya memori tidak meledak
  for (let i = 0; i < times.length; i += 4) {
    const settled = await Promise.allSettled(times.slice(i, i + 4).map(grab));
    for (const s of settled) {
      if (s.status === "fulfilled") frames.push(s.value);
      else firstError ??= s.reason;
    }
  }
  return { frames, firstError };
}

async function analyzeSegment(env, p, seg, total, filePath, prevEnd) {
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!res.ok) throw new NonRetryableError(`Gagal download video (${res.status})`);
  const buf = await res.arrayBuffer();

  let { frames, firstError } = await grabFrames(env, buf, seg.times);
  if (!frames.length) {
    // fallback: detik bulat saja
    const whole = [...new Set(seg.times.map((t) => Math.floor(t)))];
    ({ frames, firstError } = await grabFrames(env, buf, whole));
  }
  if (!frames.length) {
    if (seg.index > 0) return null; // kemungkinan sudah lewat akhir video
    throw new NonRetryableError(`Tidak ada frame yang berhasil diambil: ${firstError?.message || "unknown"}`);
  }
  frames.sort((a, b) => a.t - b.t);

  const content = [
    {
      type: "text",
      text:
        `Segment ${seg.index + 1} of ${total}, covering ${fmt(seg.start)}-${fmt(seg.end)}s of the video. ` +
        `${frames.length} frames in order, absolute timestamps.` +
        (prevEnd ? `\n\nPrevious segment END STATE and notes:\n${prevEnd}` : "") +
        (p.note ? `\n\nUser note: ${p.note}` : ""),
    },
  ];
  for (const fr of frames) {
    content.push({ type: "text", text: `Frame at ${fr.t}s:` });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fr.b64}` } });
  }

  return chat(
    env,
    list(env.VISION_MODELS, "claude-sonnet-4-6,grok-4.7,qwen3.8-27b"),
    [
      { role: "system", content: VISION_SYSTEM },
      { role: "user", content },
    ],
    { maxTokens: 4000, temperature: 0.2, timeoutMs: 120000 },
  );
}

function endState(text) {
  if (!text) return "";
  const m = text.match(/END STATE:?([\s\S]*?)(?:\n\s*UNCERTAIN|$)/i);
  return (m ? m[1] : text.slice(-600)).trim().slice(0, 900);
}

async function writePrompt(env, merged, p, total) {
  const system =
    p.mode === "control"
      ? CONTROL_SYSTEM
      : FINAL_SYSTEM.replace("{style_rule}", STYLE_RULES[p.style] || STYLE_RULES.natural);
  let user = `Reference video: ${p.duration || "unknown"}s, ${total} segment(s).\n\n${merged}`;
  if (p.note) user += `\n\nUser note: ${p.note}`;
  return chat(
    env,
    list(env.TEXT_MODELS, "claude-sonnet-4-6,nemotron-3-ultra,qwen3.7-plus"),
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { maxTokens: 8000, temperature: 0.5, timeoutMs: 120000 },
  );
}

// ------------------------------------------------------------------ workflow
export class MotionPipeline extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    const p = event.payload;
    let statusId = null;

    const setStatus = (text) =>
      statusId
        ? tg(env, "editMessageText", { chat_id: p.chatId, message_id: statusId, text }).catch(() => {})
        : Promise.resolve();

    try {
      const filePath = await step.do(
        "siapkan file",
        { retries: { limit: 2, delay: "3 seconds" }, timeout: "30 seconds" },
        async () => (await tg(env, "getFile", { file_id: p.fileId })).file_path,
      );

      // durasi sebenarnya: pakai dari Telegram kalau ada, kalau tidak baca dari file
      const duration = await step.do(
        "cek durasi",
        { retries: { limit: 1, delay: "3 seconds" }, timeout: "2 minutes" },
        async () => {
          if (p.duration > 0) return p.duration;
          const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
          if (!res.ok) throw new NonRetryableError(`Gagal download video (${res.status})`);
          return readMp4Duration(await res.arrayBuffer());
        },
      );

      const maxDur = num(env.MAX_DURATION, 30, 5, 30);
      if (duration > maxDur + 1) {
        throw new NonRetryableError(`Video terlalu panjang (${Math.round(duration)} detik). Maksimal ${maxDur} detik.`);
      }

      const segs = planSegments(env, duration);

      statusId = await step.do(
        "kirim status",
        { retries: { limit: 2, delay: "2 seconds" }, timeout: "30 seconds" },
        async () => {
          const m = await tg(env, "sendMessage", {
            chat_id: p.chatId,
            text: `Video ${duration ? fmt(+duration.toFixed(1)) + " detik" : "(durasi tidak terbaca)"}, diproses ${segs.length} bagian, sekitar ${Math.max(1, segs.length)}-${segs.length * 2} menit...`,
            reply_to_message_id: p.messageId,
            allow_sending_without_reply: true,
          });
          return m.message_id;
        },
      );

      // tiap segmen: ambil frame + analisis dalam SATU step, hanya teks yang disimpan (hindari batas 1 MiB per step)
      const analyses = [];
      let prevEnd = "";
      for (const seg of segs) {
        let text = null;
        try {
          text = await step.do(
            `segmen ${seg.index + 1}`,
            { retries: { limit: 1, delay: "5 seconds" }, timeout: "8 minutes" },
            async () => {
              await setStatus(`Menganalisis bagian ${seg.index + 1}/${segs.length} (${fmt(seg.start)}-${fmt(seg.end)}s)...`);
              return analyzeSegment(env, p, seg, segs.length, filePath, prevEnd);
            },
          );
        } catch (e) {
          console.warn(`segmen ${seg.index + 1} gagal: ${e.message}`);
          if (seg.index === 0 && /download|frame/i.test(e.message)) throw e;
          text = `[SEGMENT FAILED: ${String(e.message).slice(0, 150)}]`;
        }
        if (text === null) continue; // segmen lewat akhir video
        analyses.push({ seg, text });
        if (!text.startsWith("[SEGMENT FAILED")) prevEnd = endState(text);
      }

      if (!analyses.length || analyses.every((a) => a.text.startsWith("[SEGMENT FAILED"))) {
        throw new NonRetryableError("Semua bagian video gagal dianalisis. Coba lagi atau kirim video yang lebih pendek.");
      }

      const merged = analyses
        .map((a) => `=== SEGMENT ${a.seg.index + 1} (${fmt(a.seg.start)}-${fmt(a.seg.end)}s) ===\n${a.text}`)
        .join("\n\n");

      await setStatus("Menulis prompt akhir...");

      let result;
      try {
        result = await step.do(
          "tulis prompt",
          { retries: { limit: 0 }, timeout: "9 minutes" },
          () => writePrompt(env, merged, p, analyses.length),
        );
      } catch (e) {
        console.warn(`tahap tulis prompt gagal: ${e.message}`);
        result = `(Tahap penulisan prompt gagal: ${String(e.message).slice(0, 400)})\n\n` + merged;
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

  const reply = (text) =>
    tg(env, "sendMessage", { chat_id: chatId, text, reply_to_message_id: msg.message_id });

  if (media.file_size && media.file_size > MAX_VIDEO_BYTES) {
    await reply("Video terlalu besar (maks 20MB). Kompres atau potong dulu.");
    return;
  }

  const maxDur = num(env.MAX_DURATION, 30, 5, 30);
  if (media.duration && media.duration > maxDur + 1) {
    await reply(`Video terlalu panjang (${media.duration} detik). Maksimal ${maxDur} detik.`);
    return;
  }

  let note = (msg.caption || "").trim();
  let style = "natural";
  let mode = "prompt";
  if (/#control\b/i.test(note)) {
    mode = "control";
    note = note.replace(/#control\b/gi, "").trim();
  }
  const tag = note.match(/#(tags|kling|runway|wan|veo)\b/i);
  if (tag) {
    style = tag[1].toLowerCase();
    note = note.replace(/#(tags|kling|runway|wan|veo)\b/gi, "").trim();
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
        mode,
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
