# תמלול

אתר בתשלום חודשי לתמלול קבצי אודיו ווידאו עם OpenAI. ההתחברות דרך חשבון reem.bi, התשלום ב-PayPal, ושליחה במייל דרך Resend. רץ על Cloudflare Workers בתוכנית החינמית.

**📘 מדריך הקמה מלא בעברית: [docs/SETUP-HE.md](docs/SETUP-HE.md)**

## מבנה
| קובץ | מה יש בו |
|---|---|
| `src/plans.js` | **התוכניות, המחירים והמכסות.** משנים כאן |
| `src/index.js` | ה-API: התחברות, מכסות, מנויים, תמלול, מייל, ניהול |
| `src/store.js` | בסיס הנתונים (Durable Object עם SQLite) |
| `src/openai.js` | העברת השמע ל-OpenAI בזרימה, בלי לשמור אותו |
| `src/paypal.js` | מנויים ב-PayPal |
| `src/mail.js` | שליחה ב-Resend |
| `public/` | האתר: `index.html`, `app.js`, `audio.js` (עיבוד השמע בדפדפן), `admin.html` |
| `test/` | בדיקות אוטומטיות עם כל השירותים החיצוניים מדומים |

## פקודות
```bash
npm install
npm run dev     # http://localhost:8787 (צריך קובץ .dev.vars, ראה .dev.vars.example)
npm test
```
