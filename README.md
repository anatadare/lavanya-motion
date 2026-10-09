# Motion Prompt Bot (Cloudflare Worker)

Bot Telegram: kirim video pendek, bot menganalisis gerakan subjek + kamera, lalu membalas dengan prompt image-to-video.

Alur: Telegram webhook -> Worker -> Workflow (ambil frame lewat Media binding -> model vision Jerouter -> `jev-1.13` menulis prompt) -> balasan ke chat.

## Isi repo (semua di root, tanpa folder)

- `index.js`
- `wrangler.jsonc`
- `package.json`
- `.gitignore`
- `README.md`

## Setup

1. **Buat repo GitHub**, upload kelima file di atas ke root repo.
2. **Cloudflare dashboard** -> Workers & Pages -> Create -> Import a repository -> pilih repo itu.
   - Deploy command: `npx wrangler deploy`
   - Nama worker harus sama dengan `name` di `wrangler.jsonc` (`motion-prompt-bot`).
3. Setelah deploy pertama, buka Worker -> **Settings -> Variables and Secrets**, tambah 4 **Secret**:
   - `TELEGRAM_BOT_TOKEN`: token dari BotFather
   - `WEBHOOK_SECRET`: kata acak buatanmu sendiri (huruf, angka, `_`, `-`)
   - `JEROUTER_API_KEY`: API key Jerouter
   - `JEROUTER_BASE_URL`: base URL Jerouter yang berakhiran `/v1` (endpoint `/chat/completions` ala OpenAI)
4. **Daftarkan webhook** dengan membuka di browser:
   `https://motion-prompt-bot.<subdomain-kamu>.workers.dev/setup?key=<WEBHOOK_SECRET>`
   Hasilnya harus `"ok": true`.
5. Kirim video ke bot.

## Pemakaian

- Kirim video (maks 20MB, ideal 3-10 detik).
- Caption = catatan tambahan, mis. `gerakan lebih lambat, kamera tetap`.
- Tambah `#tags` di caption untuk prompt berbentuk tag singkat.

## Ganti model / setting

Ubah `vars` di `wrangler.jsonc` lalu commit:

- `VISION_MODELS`: model vision, urutan = prioritas (fallback otomatis)
- `TEXT_MODELS`: model penulis prompt
- `MAX_FRAMES`: jumlah frame yang diambil (2-8)
- `ALLOWED_USER_IDS`: ID Telegram yang boleh pakai, pisah koma. Kosong = semua boleh

## Kalau ada masalah

Lihat log di Worker -> Logs, dan di Workers & Pages -> Workflows -> `motion-prompt-pipeline` untuk melihat tiap langkah (ambil frame, analisis, tulis prompt, kirim hasil) dan di mana gagalnya.
