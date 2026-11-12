// Plans, prices, coupons and subscriptions are all managed in the reem.bi admin
// (login.reembir.com/admin → אתרים → תמלול). This file only has the defaults used when a
// plan in the dashboard doesn't say otherwise in its JSON: {"minutes": 180, "strong": true, "email": true}.
//
// Usage is counted in "credits": one minute of audio with the fast model
// costs 1 credit, with the accurate model STRONG_WEIGHT credits.

// No free plan: without a subscription there are no monthly minutes, only the one-time welcome gift
// from reem.bi (dashboard → Plans → welcome gift, {"minutes": 10}), with the fast model and no email.
// summary: the AI-summary level (SUMMARY_LEVELS below); a plan's JSON can set {"summary": 0-3}.
export const PLAN_DEFAULTS = {
  free:     { credits: 0,    strong: false, email: false, summary: 0 },
  basic:    { credits: 180,  strong: true,  email: true,  summary: 1 },
  pro:      { credits: 600,  strong: true,  email: true,  summary: 2 },
  business: { credits: 1500, strong: true,  email: true,  summary: 3 },
};
// Any other paid plan created in the dashboard without "minutes":
export const PAID_DEFAULT = { credits: 180, strong: true, email: true, summary: 1 };

// AI summaries (summary.js). A summary is paid from the same quota, by what it cost.
//   0  no plan: one small trial summary (from the welcome gift), short styles only
//   1  basic: summaries of a transcript
//   2  pro: + all styles, + the lecture's slides and other material (2 files, 30 pages)
//   3  business: + 5 files and 100 pages, + several transcripts together (a whole course)
const BASIC_STYLES = ['short', 'bullets'];
const ALL_STYLES = ['short', 'bullets', 'lesson', 'terms', 'questions'];
export const SUMMARY_LEVELS = [
  { level: 0, trial: true, styles: BASIC_STYLES, files: 0, pages: 0, texts: 1 },
  { level: 1, styles: BASIC_STYLES, files: 0, pages: 0, texts: 1 },
  { level: 2, styles: ALL_STYLES, files: 2, pages: 30, texts: 1 },
  { level: 3, styles: ALL_STYLES, files: 5, pages: 100, texts: 5 },
];
export const SUMMARY_STYLES = {
  short: { label: 'סיכום קצר', prompt: 'כתוב סיכום קצר: פסקת פתיחה של 2-3 משפטים על מה הדברים, ואחריה עד 6 נקודות עיקריות.' },
  bullets: { label: 'נקודות עיקריות', prompt: 'כתוב רשימה מסודרת של הנקודות העיקריות, מקובצות תחת כותרות קצרות לפי נושא.' },
  lesson: { label: 'סיכום שיעור', prompt: 'כתוב סיכום שיעור מלא ללמידה למבחן: כותרת לכל נושא לפי סדר השיעור, הסבר של כל רעיון, דוגמאות שנאמרו, ובסוף "מה חשוב לזכור".' },
  terms: { label: 'מושגים והגדרות', prompt: 'כתוב רשימת מושגים מרכזיים: לכל מושג הגדרה קצרה וברורה, ואם נאמרה דוגמה, גם אותה. סדר לפי נושאים.' },
  questions: { label: 'שאלות לחזרה', prompt: 'כתוב 10-15 שאלות לחזרה על החומר, מהקל לקשה, ולכל שאלה תשובה קצרה מתחתיה.' },
};

export const STRONG_WEIGHT = 2;


// Approximate OpenAI cost in USD per audio minute, only used for the admin stats.
export const COST_PER_MINUTE = { fast: 0.003, strong: 0.006 };

export function modelIds(env) {
  return {
    fast: env.MODEL_FAST || 'gpt-4o-mini-transcribe',
    strong: env.MODEL_STRONG || 'gpt-4o-transcribe',
  };
}
