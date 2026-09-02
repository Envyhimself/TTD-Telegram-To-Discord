# 🦁☀️ نسخه فارسی — TTD: تلگرام به دیسکورد

<div dir="rtl">

رله خودکار و سرورلس که کانال‌های عمومی تلگرام را به وب‌هوک دیسکورد منتقل می‌کند؛ با قالب‌بندی تمیز متن، تصویرهای درون‌خطی و فایل ویدیوی واقعی MP4.

این سرویس به‌صورت ۲۴ ساعته روی **Cloudflare Workers** (cron `* * * * *`) با پیگیری نشانگر (cursor) در **Cloudflare KV** اجرا می‌شود تا از بلاک‌های شبکه داخلی عبور کند، از تکرار پیام‌ها جلوگیری کند و بدون نیاز به میزبانی سرور ربات کار کند.

---

## TTD چه کار می‌کند

- **فرارود چند کاناله**: هر کانال عمومی تلگرام (مثل `@warroom` یا `@news_hut`) را به دیسکورد منتقل می‌کند.
- **بارگذاری مستقیم رسانه**: ویدیوهای واقعی `.mp4` را دانلود کرده و به‌صورت فایل ضمیمه (multipart attachment) به دیسکورد می‌فرستد؛ نه لینک خام.
- **خروجی تمیز**: آدرس‌های `t.me` را حذف و متن تمیز، عنوان درشت، پاراگراف و عکس نمایش می‌دهد.
- **چند رله در یک حساب**: برای هر نصب یک نام Worker منحصربه‌فرد انتخاب کنید (مثل `ttd-war` یا `ttd-crypto`). هر نصب Worker، فضای KV، secret، cron trigger و آدرس `workers.dev` اختصاصی خودش را دارد.
- **بدون پیش‌فرض**: شما دقیقاً کانال‌هایی که می‌خواهید را انتخاب و می‌چسبانید.
- **مقاوم در برابر تحریم و سرورلس**: اسکریپینگ و ارسال وب‌هوک کاملاً در لبه (edge) Cloudflare اجرا می‌شود.

---

## شروع سریع (نصب‌ساز آماده)

نصب‌ساز مستقل را از تب Releases دانلود کنید:

- **ویندوز**: `telegram-wizard-windows-x64.exe`
- **لینوکس**: `telegram-wizard-linux-x64`

### ویزارد چگونه کار می‌کند

1. **نام Worker منحصربه‌فرد**: یک نام برای این رله انتخاب کنید (مثلاً `ttd-war-news`).
2. **انتخاب کانال‌ها**: نام‌های کاربری تلگرام را جدا با کاما بچسبانید (مثلاً `warroom, news_hut`).
3. **تنظیم خودکار**: فایل‌ها استخراج شده و وابستگی‌ها نصب می‌شوند.
4. **وب‌هوک دیسکورد**: آدرس وب‌هوک دیسکورد را وارد کنید (با اعتبارسنجی و امکان رد کردن در شبکه‌های محدود).
5. **ورود به Cloudflare**: با باز شدن پنجره مرورگر (فقط یک‌بار) وارد می‌شوید.
6. **راه‌اندازی و حفاظت**: فضای `<worker-name>-STATE_KV` ساخته، Worker deploy شده، `DISCORD_WEBHOOK_URL` به‌صورت امن ذخیره و اولین همگام‌سازی تستی زنده اجرا می‌شود.

---

## اجرای چند نمونه

> [!WARNING]
> **استفاده از کانال‌های تلگرامی یکسان و وب‌هوک دیسکورد یکسان در بیش از یک Worker باعث می‌شود هر پیام چند بار ارسال شود.** حذف تکراری (deduplication) با KV فقط در داخل یک Worker کار می‌کند؛ Workerهای جداگانه وضعیت KV جداگانه‌ای دارند و نمی‌توانند تکرار یکدیگر را حذف کنند.
>
> قبل از ساخت Worker جدید مشخص کنید آیا مقصد جدید می‌خواهید:
> - **وب‌هوک دیسکورد متفاوت:** یک Worker جدید با نام منحصربه‌فرد بسازید.
> - **وب‌هوک دیسکورد یکسان:** Worker موجود را استفاده/به‌روزرسانی کنید یا اول Worker قدیمی را حذف کنید. هر دو را هم‌زمان اجرا نکنید.

برای اجرای چند رله در یک حساب Cloudflare:

1. برای هر رله یک پوشه جداگانه بسازید (مثلاً `C:\TTD\News1` و `C:\TTD\News2`).
2. نصب‌ساز را داخل هر پوشه اجرا کنید.
3. برای هرکدام یک نام Worker منحصربه‌فرد انتخاب کنید (مثلاً `ttd-news-one` و `ttd-news-two`).
4. کانال‌ها و وب‌هوک دیسکورد هدف را برای هر نمونه وارد کنید.
5. مطمئن شوید Worker فعال دیگری با همان کانال‌ها و همان وب‌هوک وجود ندارد.

هر نمونه به‌صورت مستقل و بدون تداخل نشانگر یا وضعیت مشترک اجرا می‌شود. همین ایزوله بودن دلیلش است که دو Worker با کانال‌ها و وب‌هوک یکسان، پیام‌های تکراری در دیسکورد تولید می‌کنند.

---

## نصب دستی (Node.js)

اگر ترجیح می‌دهید از سورس اجرا کنید:

```bash
# Clone the repository
git clone https://github.com/Envyhimself/TTD-Telegram-To-Discord.git
cd TTD-Telegram-To-Discord

# Run the interactive wizard
node wizard.js
```

---

## تأیید و اجرای دستی

- **خودکار**: هر دقیقه با Cloudflare Cron (`* * * * *`) اجرا می‌شود.
- **همگام‌سازی دستی**: `https://<your-worker>.<subdomain>.workers.dev/test` را در مرورگر باز کنید یا یک درخواست GET بزنید تا همگام‌سازی فوری انجام شود.
- **عیب‌یابی**: `https://<your-worker>.<subdomain>.workers.dev/diag` را باز کنید تا پارس HTML خام و نشانگرهای فعلی کانال‌ها را ببینید.

---

## لایسنس

MIT

</div>

---

# TTD — Telegram to Discord

Automated, serverless relay that mirrors public Telegram channels to Discord webhooks with clean text formatting, inline images, and real MP4 video attachments.

Runs 24/7 on **Cloudflare Workers** (cron `* * * * *`) with **Cloudflare KV** cursor tracking to bypass local ISP blocks, prevent duplicate messages, and operate without hosting a bot server.

---

## What TTD Does

- **Multi-channel forwarding**: Mirror any public Telegram channel (`@example`, `@example`, etc.) to Discord.
- **Direct media uploads**: Downloads real `.mp4` videos and uploads them to Discord as multipart attachments (`files[0]`) instead of posting bare links.
- **Clean output**: Strips `t.me` URLs and renders clean text, bold headers, paragraphs, and photos.
- **Multiple relays per account**: Pick a unique Worker name per setup (`example`, `example2`). Each installation gets its own isolated Worker, KV namespace, secret, cron trigger, and `workers.dev` URL.
- **Zero defaults**: You choose and paste exactly which channels you want.
- **Sanctions-proof & serverless**: Scraping and webhook delivery execute entirely at Cloudflare's edge.

---

## Quick Start (Pre-built Executable)

Download the standalone installer from the release tab

- **Windows**: `telegram-wizard-windows-x64.exe`
- **Linux**: `telegram-wizard-linux-x64`

### How the Wizard Works

1. **Unique Worker Name**: Choose a name for this relay instance (e.g. `example`).
2. **Channel Selection**: Paste your Telegram handles (comma-separated, e.g. `example, example`).
3. **Automated Setup**: Extracts files and installs required dependencies.
4. **Discord Webhook**: Enter your Discord webhook URL (with validation and optional skip for restricted networks).
5. **Cloudflare Login**: Authenticates via Cloudflare browser popup (once).
6. **Deploy & Protect**: Creates `<worker-name>-STATE_KV`, deploys the Worker, securely saves `DISCORD_WEBHOOK_URL`, and executes the first live test sync.

---

## Running Multiple Instances

> [!WARNING]
> **Using the same Telegram channels and the same Discord webhook in more than one Worker sends every message multiple times.** KV deduplication works inside one Worker only; separate Workers have separate KV state and cannot deduplicate each other.
>
> Before creating another Worker, decide whether you want an additional destination:
> - **Different Discord webhook:** create another Worker with a unique name.
> - **Same Discord webhook:** reuse/update the existing Worker, or delete the old Worker first. Do not run both.

To run multiple relays on one Cloudflare account:

1. Create a separate folder for each relay (e.g. `C:\TTD\example1`, `C:\TTD\example2`).
2. Run the wizard executable inside each folder.
3. Choose a unique Worker name for each one (e.g. `ttd-example-one`, `ttd-example-two`).
4. Enter the specific channels and target Discord webhook for that instance.
5. Confirm that no other active Worker uses the same Telegram channels with the same webhook.

Each instance runs independently without cursor conflicts or shared state. That isolation is why two Workers targeting the same channels and webhook produce duplicate Discord messages.

---

## Manual Installation (Node.js)

If you prefer running from source:

```bash
# Clone the repository
git clone https://github.com/Envyhimself/TTD-Telegram-To-Discord.git
cd TTD-Telegram-To-Discord

# Run the interactive wizard
node wizard.js
```

---

## Verification & Manual Trigger

- **Automatic**: Runs every minute via Cloudflare Cron (`* * * * *`).
- **Manual sync**: Open `https://<your-worker>.<subdomain>.workers.dev/test` in your browser or make a GET request to immediately trigger a sync of the latest messages.
- **Diagnostics**: Open `https://<your-worker>.<subdomain>.workers.dev/diag` to inspect raw HTML parsing and current channel cursors.

---

## License

MIT
