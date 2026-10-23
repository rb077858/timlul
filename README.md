# תמלול

אתר בתשלום חודשי לתמלול קבצי אודיו ווידאו עם OpenAI. ההתחברות, התשלומים (PayPal המרכזי) והניהול דרך reem.bi, ושליחה במייל דרך Resend. רץ על Cloudflare Workers בתוכנית החינמית.

**📘 מדריך הקמה מלא בעברית: [docs/SETUP-HE.md](docs/SETUP-HE.md)**

## מבנה
| קובץ | מה יש בו |
|---|---|
| `src/index.js` | ה-API: מכסות, תמלול, מייל, ונתוני האתר לדשבורד reem.bi (`/api/admin/manifest`) |
| `src/sso.js` | חשבון reem.bi: זיהוי המשתמש והתוכנית שלו (דקות והרשאות מה-JSON בדשבורד) |
| `src/plans.js` | ברירות מחדל לדקות והרשאות, ומחירי OpenAI לסטטיסטיקות |
| `src/store.js` | בסיס הנתונים (Durable Object עם SQLite): שימוש ומגבלות מייל |
| `src/openai.js` | העברת השמע ל-OpenAI בזרימה, בלי לשמור אותו |
| `src/mail.js` | שליחה ב-Resend |
| `public/` | האתר: `index.html`, `app.js` (כולל דף המחירים דרך `auth.billing`), `audio.js` (עיבוד השמע בדפדפן) |
| `test/` | בדיקות אוטומטיות עם כל השירותים החיצוניים מדומים |

תוכניות, מחירים, מנויים, קודי קופון וכל הניהול נמצאים ב-login.reembir.com/admin ← אתרים ← תמלול.

## פקודות
```bash
npm install
npm run dev     # http://localhost:8787 (צריך קובץ .dev.vars, ראה .dev.vars.example)
npm test
```
