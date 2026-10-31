// MQM watch на Cloudflare Workers: баллы с kabinet.mqm.az и утренний прогноз погоды
// в WhatsApp-группу через Green API. Управление — страница https://<worker>.workers.dev/
//
// Привязки и секреты (Settings → Bindings / Variables and Secrets):
//   MQM_KV              - KV namespace (настройки и состояние)
//   GREEN_ID_INSTANCE   - idInstance (secret)
//   GREEN_API_TOKEN     - apiTokenInstance (secret)
//   GREEN_CHAT_ID       - id группы, можно без @g.us (secret)
//   RUN_KEY             - пароль для страницы управления и ссылки /run (secret)
//   GREEN_API_URL       - (необязательно) хост инстанса, по умолчанию https://api.green-api.com
//   WEBHOOK_SECRET      - секретная часть адреса /webhook/<секрет> для уведомлений Green API (secret)
//   FIREBASE_DB_URL     - адрес Realtime Database, https://<проект>-default-rtdb.<регион>.firebasedatabase.app (secret)
//   FIREBASE_SECRET     - Database secret (secret) — или вместо него:
//   FIREBASE_SERVICE_ACCOUNT - JSON ключа сервисного аккаунта целиком (secret)
//
// Cron Trigger в Cloudflare: "* * * * *" — воркер просыпается каждую минуту,
// а как часто проверять экзамен, решает настройка на странице.
//
// Запуск ссылкой: /run?key=RUN_KEY&exam=1&weather=1&test=0&clean=0&dump=0

const DEFAULT_URL = "https://kabinet.mqm.az/result/1505867/e40b3558-d105-4cc5-8752-594581ee467a";
const DEFAULT_SUBJECTS = ["İngilis dili", "Azərbaycan dili", "Riyaziyyat"];
const COUNTERS = {
  correct: /Doğru cavabların sayı:\s*(\d+)/,
  wrong: /Yanlış cavabların sayı:\s*(\d+)/,
  unverified: /Qiymətləndirilməyib:\s*(\d+)/, // открытые вопросы на проверке
};

// Уборка трогает только свои исходящие сообщения с этими значками.
const SCORE_PREFIX = "📊";
const BOT_PREFIXES = [SCORE_PREFIX, "🌦", "✅ Test"];
// Бесплатный план Cloudflare: не больше 50 внешних запросов за запуск.
const MAX_DELETES = 40;
// Бесплатный план KV: 1000 записей в сутки; каждая проверка пишет лог запуска.
const MIN_INTERVAL = 5;

const BAKU_OFFSET_MS = 4 * 3600 * 1000; // Азербайджан без перехода на летнее время
const WEEKDAYS = ["Bazar ertəsi", "Çərşənbə axşamı", "Çərşənbə", "Cümə axşamı", "Cümə", "Şənbə", "Bazar"];
// откуда дует ветер: «şimal küləyi» = с севера
const DIRS = ["şimal", "şimal-şərq", "şərq", "cənub-şərq", "cənub", "cənub-qərb", "qərb", "şimal-qərb"];
const STRONG_GUST = 50; // км/ч: от этого значения ставим ⚠️

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü", ccedil: "ç", Ccedil: "Ç",
  scedil: "ş", Scedil: "Ş", gbreve: "ğ", Gbreve: "Ğ", imath: "ı", inodot: "ı", Idot: "İ",
  mdash: "—", ndash: "–", laquo: "«", raquo: "»",
};

// ---------------- Настройки ----------------

function defaults(env) {
  return {
    enabled: true,
    exam_enabled: true,
    interval: 20,
    url: env.MQM_URL || DEFAULT_URL,
    title: "Asim Qaraxanov",
    subjects: DEFAULT_SUBJECTS.join(", "),
    weather_enabled: true,
    place: env.WEATHER_PLACE || "Pirşağı",
    lat: env.WEATHER_LAT || "40.49",
    lon: env.WEATHER_LON || "50.01",
    send_hour: parseInt(env.WEATHER_SEND_HOUR || "7", 10),
    hours: parseInt(env.WEATHER_HOURS || "24", 10),
    clean_enabled: true,
  };
}

async function loadSettings(env) {
  const saved = env.MQM_KV ? await env.MQM_KV.get("settings", "json") : null;
  return { ...defaults(env), ...(saved || {}) };
}

function config(env, s) {
  let chat = (env.GREEN_CHAT_ID || "").trim();
  if (chat && !chat.includes("@")) chat += "@g.us";
  return {
    s,
    kv: env.MQM_KV,
    subjects: s.subjects.split(",").map((x) => x.trim()).filter(Boolean),
    api: (env.GREEN_API_URL || "https://api.green-api.com").replace(/\/+$/, ""),
    id: (env.GREEN_ID_INSTANCE || "").trim(),
    token: (env.GREEN_API_TOKEN || "").trim(),
    chat,
    cleanCount: parseInt(env.CLEAN_HISTORY_COUNT || "200", 10),
    acted: false, // было ли реальное действие (для записи лога запуска)
    lines: [],
    log(...args) {
      const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      this.lines.push(line);
      console.log(line);
    },
  };
}

// ---------------- Баллы ----------------

function unescapeHtml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[e] ?? m;
  });
}

async function fetchText(c) {
  const res = await fetch(c.s.url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Сайт MQM ответил ${res.status}`);
  let raw = await res.text();
  raw = raw.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  return unescapeHtml(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parse(text, subjects) {
  const m = text.match(/Yekun nəticə:\s*([\d.]+)\s*\/\s*Maksimum:\s*(\d+)/);
  if (!m) throw new Error("Не нашёл 'Yekun nəticə' на странице (формат изменился?)");
  const data = { total: parseFloat(m[1]), max: parseFloat(m[2]), subjects: {} };

  // начало блока каждого предмета -> блок идёт до начала следующего
  const starts = [];
  for (const name of subjects) {
    const h = new RegExp(escapeRe(name) + String.raw`\s*\(Maksimum:\s*\d+\)`).exec(text);
    if (h) starts.push([h.index, name]);
  }
  starts.sort((a, b) => a[0] - b[0]);
  starts.forEach(([pos, name], i) => {
    const end = i + 1 < starts.length ? starts[i + 1][0] : text.length;
    const block = text.slice(pos, end);
    const s = block.match(/Nəticə:\s*([\d.]+)/);
    if (!s) return;
    data.subjects[name] = { score: parseFloat(s[1]), ...parseCounters(block) };
  });
  return data;
}

function parseCounters(block) {
  const found = {};
  for (const [key, re] of Object.entries(COUNTERS)) {
    const m = block.match(re);
    if (m) found[key] = parseInt(m[1], 10);
  }
  // когда непроверенных не осталось, сайт убирает эту строку совсем
  if ("correct" in found && "wrong" in found && !("unverified" in found)) found.unverified = 0;
  return found;
}

// Старый формат состояния (число) -> новый (словарь).
function norm(subjects) {
  const out = {};
  for (const [k, v] of Object.entries(subjects || {})) {
    out[k] = typeof v === "object" && v !== null ? v : { score: v };
  }
  return out;
}

function sameSubjects(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join("|") !== kb.join("|")) return false;
  return ka.every((k) => {
    const fa = Object.keys(a[k]).sort();
    const fb = Object.keys(b[k]).sort();
    return fa.join("|") === fb.join("|") && fa.every((f) => a[k][f] === b[k][f]);
  });
}

// как Python печатает float: 80 -> "80.0", 91.6 -> "91.6"
const num = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

function chg(prev, cur, f = String) {
  return prev !== undefined && prev !== cur ? `${f(prev)}→${f(cur)}` : f(cur);
}

function fmt(old, cur, title) {
  const lines = [
    `📊 ${title} — nəticə yeniləndi`,
    old
      ? `Yekun: ${num(old.total)} → ${num(cur.total)} / ${cur.max}`
      : `Yekun: ${num(cur.total)} / ${cur.max}`,
  ];
  const olds = norm(old && old.subjects);
  for (const [name, s] of Object.entries(cur.subjects)) {
    const prev = olds[name] || {};
    let line = `• ${name}: ${chg(prev.score, s.score, num).replace("→", " → ")}`;
    const parts = [["correct", "✅"], ["wrong", "❌"], ["unverified", "⏳"]]
      .filter(([key]) => key in s)
      .map(([key, icon]) => `${icon} ${chg(prev[key], s[key])}`);
    if (parts.length) line += " (" + parts.join(" | ") + ")";
    lines.push(line);
  }
  return lines.join("\n");
}

async function checkResults(c, opts) {
  c.acted = true;
  const text = await fetchText(c);
  if (opts.dump) {
    c.log(text);
    c.log("\nНАЙДЕНО:", parse(text, c.subjects));
    return;
  }
  const cur = parse(text, c.subjects);

  if (opts.test) {
    await send(c, "✅ Test: MQM watch işləyir\n" + fmt(null, cur, c.s.title).split("\n").slice(1).join("\n"));
    return;
  }

  const old = await c.kv.get("state", "json");
  if (!old) {
    await c.kv.put("state", JSON.stringify(cur));
    c.log("Первая проверка, запомнил текущие баллы:", cur);
    return;
  }

  if (cur.total !== old.total || !sameSubjects(cur.subjects, norm(old.subjects))) {
    await send(c, fmt(old, cur, c.s.title)); // состояние сохраняем только после успешной отправки
    await c.kv.put("state", JSON.stringify(cur));
  } else {
    c.log("Без изменений:", String(cur.total));
  }
}

// ---------------- Green API ----------------

async function apiCall(c, method, payload) {
  if (!(c.id && c.token && c.chat)) {
    throw new Error("Не заданы GREEN_ID_INSTANCE / GREEN_API_TOKEN / GREEN_CHAT_ID");
  }
  const res = await fetch(`${c.api}/waInstance${c.id}/${method}/${c.token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Green API ${method} ${res.status}: ${raw}`);
  return raw ? JSON.parse(raw) : null;
}

async function send(c, message) {
  c.log("Green API:", await apiCall(c, "sendMessage", { chatId: c.chat, message }));
}

// ---------------- Время по Баку ----------------
// «Наивные» даты: поля UTC содержат местное время Баку.

const bakuNow = () => new Date(Date.now() + BAKU_OFFSET_MS);
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const dm = (d) => `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}`;
const hm = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const addHours = (d, h) => new Date(d.getTime() + h * 3600 * 1000);
const bakuTime = (ms) => {
  const d = new Date(ms + BAKU_OFFSET_MS);
  return `${dm(d)} ${hm(d)}`;
};

// ---------------- Уборка старых сообщений бота ----------------

// Удаляет у всех сообщения бота старше сегодняшних 00:00 (Баку).
// Если сегодня не было сообщения с баллами — оставляет последнее более раннее.
async function cleanupOld(c, dry) {
  c.acted = true;
  const now = bakuNow();
  const cutoff = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - BAKU_OFFSET_MS) / 1000;
  const history = (await apiCall(c, "getChatHistory", { chatId: c.chat, count: c.cleanCount })) || [];
  // сообщения, которые WhatsApp уже отказался удалять: не тратим на них лимит запросов
  const skip = new Set((await c.kv.get("clean_skip", "json")) || []);

  const mine = history
    .filter((m) => m.type === "outgoing" && typeof m.textMessage === "string"
      && BOT_PREFIXES.some((p) => m.textMessage.startsWith(p)))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const old = mine.filter((m) => (m.timestamp || 0) < cutoff);
  const scoreToday = mine.some((m) => m.textMessage.startsWith(SCORE_PREFIX) && (m.timestamp || 0) >= cutoff);
  let keep = null;
  if (!scoreToday) {
    const oldScores = old.filter((m) => m.textMessage.startsWith(SCORE_PREFIX));
    keep = oldScores.length ? oldScores[oldScores.length - 1] : null;
  }
  const pending = old.filter((m) => m !== keep && !skip.has(m.idMessage));
  const todo = pending.slice(0, MAX_DELETES);

  c.log(`История: ${history.length} сообщений, моих: ${mine.length}, к удалению: ${pending.length}`
    + (keep ? `, оставляю: ${keep.idMessage}` : "")
    + (pending.length > todo.length ? `, сейчас удалю ${todo.length}, остальные — в следующий раз` : ""));

  let deleted = 0, gone = 0, failed = 0;
  for (const m of todo) {
    const label = `${bakuTime(m.timestamp * 1000)} «${m.textMessage.split("\n")[0].slice(0, 40)}»`;
    if (dry) {
      c.log(`  [пробный режим] удалил бы ${label}`);
      continue;
    }
    try {
      await apiCall(c, "deleteMessage", { chatId: c.chat, idMessage: m.idMessage, onlySenderDelete: false });
      deleted++;
      c.log(`  удалено ${label}`);
    } catch (e) {
      if (String(e).includes("already was deleted")) {
        gone++; // в истории ещё числится, но уже удалено — это нормально
      } else {
        failed++; // например, слишком старое: WhatsApp не даёт удалить у всех
        skip.add(m.idMessage);
        c.log(`  не удалось ${label}: ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!dry) c.log(`Готово: удалено ${deleted}, уже было удалено ${gone}, не удалось ${failed}`);
  if (failed) {
    await c.kv.put("clean_skip", JSON.stringify([...skip].slice(-500)));
    throw new Error(`Не удалось удалить ${failed} сообщ.`);
  }
}

// ---------------- Прогноз погоды ----------------

async function fetchWeather(c, startDay, endDay) {
  const qs = new URLSearchParams({
    latitude: c.s.lat,
    longitude: c.s.lon,
    hourly: "precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,wind_direction_10m",
    wind_speed_unit: "kmh",
    timezone: "Asia/Baku",
    start_date: startDay,
    end_date: endDay,
  });
  const res = await fetch("https://api.open-meteo.com/v1/forecast?" + qs, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`Open-Meteo ответил ${res.status}`);
  return (await res.json()).hourly;
}

function fmtWeather(c, h, now) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  const end = addHours(start, c.s.hours);
  const rows = [];
  h.time.forEach((t, i) => {
    const dt = new Date(t + ":00Z"); // Open-Meteo отдаёт местное время без зоны: "2026-10-30T07:00"
    if (!(dt >= start && dt < end)) return;
    rows.push({
      dt,
      rain: h.precipitation[i] || 0,
      prob: h.precipitation_probability[i],
      wind: h.wind_speed_10m[i] || 0,
      gust: h.wind_gusts_10m[i] || 0,
      dir: DIRS[Math.round((h.wind_direction_10m[i] || 0) / 45) % 8],
    });
  });
  if (!rows.length) throw new Error("В ответе погоды нет нужных часов");

  const total = rows.reduce((s, r) => s + r.rain, 0);
  const peak = rows.reduce((a, b) => (b.gust > a.gust ? b : a));
  const last = rows[rows.length - 1].dt;
  const lines = [
    `🌦 ${c.s.place} — hava proqnozu`,
    `${WEEKDAYS[(now.getUTCDay() + 6) % 7]}, ${dm(now)}.${now.getUTCFullYear()}, ${hm(rows[0].dt)} → ${dm(last)} ${hm(last)}`,
    "",
    total >= 0.1 ? `🌧 Yağış: ${total.toFixed(1)} mm` : "☀️ Yağış gözlənilmir",
    `💨 Ən güclü külək: ${peak.gust.toFixed(0)} km/saat, ${dm(peak.dt)} saat ${hm(peak.dt)}`,
    "",
  ];
  let day = ymd(rows[0].dt);
  for (const r of rows) {
    if (ymd(r.dt) !== day) { // перешли за полночь
      day = ymd(r.dt);
      lines.push(`— ${dm(r.dt)} —`);
    }
    const rain = r.rain >= 0.1
      ? `🌧 ${r.rain.toFixed(1)} mm` + (r.prob != null ? ` (${r.prob}%)` : "")
      : r.prob ? `yağış yox (${r.prob}%)` : "yağış yox";
    const warn = r.gust >= STRONG_GUST ? " ⚠️" : "";
    lines.push(`${hm(r.dt)} · ${rain} · 💨 ${r.wind.toFixed(0)} (${r.gust.toFixed(0)}) km/saat, ${r.dir}${warn}`);
  }
  lines.push("", "Mötərizədə: yağış ehtimalı (%) və ani külək (km/saat)");
  return lines.join("\n");
}

// Раз в сутки после часа отправки (по Баку): уборка старых сообщений, затем прогноз.
// force=true — «прогноз сейчас»: уборка в пробном режиме, дата отправки не пишется.
async function dailyWeather(c, force) {
  const now = bakuNow();
  const today = ymd(now);
  const last = await c.kv.get("weather_date");
  if (!force && (now.getUTCHours() < c.s.send_hour || last === today)) {
    c.log(last === today ? "Погода: сегодня уже отправлена" : `Погода: ещё рано (шлём после ${c.s.send_hour}:00 по Баку)`);
    return;
  }
  c.acted = true;
  let cleanError = null;
  if (c.s.clean_enabled) {
    try {
      await cleanupOld(c, force);
    } catch (e) { // сбой уборки не должен лишать прогноза
      cleanError = e;
      c.log("ОШИБКА уборки:", e.message);
    }
  } else {
    c.log("Уборка старых сообщений выключена");
  }
  const tomorrow = ymd(addHours(now, 24));
  await send(c, fmtWeather(c, await fetchWeather(c, today, tomorrow), now));
  if (!force) await c.kv.put("weather_date", today);
  if (cleanError) throw cleanError;
}

// ---------------- Запуск ----------------

async function run(env, s, opts, source) {
  const c = config(env, s);
  if (!c.kv) {
    c.log("ОШИБКА: не привязан KV namespace MQM_KV");
    return { ok: false, log: c.lines.join("\n") };
  }
  let ok = true;
  const steps = [];
  if (opts.dump) steps.push(["Экзамен", () => checkResults(c, opts)]);
  else if (opts.clean) steps.push(["Уборка", () => cleanupOld(c, false)]);
  else {
    if (opts.exam) steps.push(["Экзамен", () => checkResults(c, opts)]);
    if (opts.weather) steps.push(["Погода", () => dailyWeather(c, opts.test)]);
  }
  if (!steps.length) c.log("Нечего делать: экзамен и погода не выбраны");
  // баллы и погода независимы: сбой одного не мешает другому
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (e) {
      ok = false;
      c.log(`ОШИБКА (${name}):`, e.message);
    }
  }
  const log = c.lines.join("\n");
  if (c.acted || !ok) {
    await c.kv.put("last_run", JSON.stringify({ time: Date.now(), ok, source, log: log.slice(0, 8000) }));
  }
  return { ok, log };
}

// ---------------- Firebase Realtime Database: сбор сообщений ----------------
// Секреты: FIREBASE_DB_URL и один из способов входа —
//   FIREBASE_SECRET (Database secret) или FIREBASE_SERVICE_ACCOUNT (JSON сервисного аккаунта).
// Структура: chats/<чат> — название, тип, время последнего, счётчик;
//            messages/<чат>/<idMessage> — само сообщение.

const MESSAGE_WEBHOOKS = {
  incomingMessageReceived: "incoming",       // написали в чат
  outgoingMessageReceived: "outgoing",       // отправлено с телефона
  outgoingAPIMessageReceived: "outgoing_api", // отправлено через API (этот бот)
};

let googleTokenCache = null; // живёт, пока жив экземпляр воркера

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function googleAccessToken(sa) {
  if (googleTokenCache && googleTokenCache.exp > Date.now() + 60000) return googleTokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const part = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = part({ alg: "RS256", typ: "JWT" }) + "." + part({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google OAuth ${res.status}: ${JSON.stringify(data)}`);
  googleTokenCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

const firebaseReady = (env) => !!(env.FIREBASE_DB_URL && (env.FIREBASE_SECRET || env.FIREBASE_SERVICE_ACCOUNT));

async function firebase(env, method, path, body) {
  if (!firebaseReady(env)) throw new Error("Не заданы FIREBASE_DB_URL и FIREBASE_SECRET / FIREBASE_SERVICE_ACCOUNT");
  const auth = env.FIREBASE_SECRET
    ? "auth=" + encodeURIComponent(env.FIREBASE_SECRET.trim())
    : "access_token=" + encodeURIComponent(await googleAccessToken(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)));
  let base;
  try { base = new URL(env.FIREBASE_DB_URL.trim()); } catch { base = null; }
  if (!base || !/\.(firebasedatabase\.app|firebaseio\.com)$/.test(base.hostname)) {
    throw new Error(`FIREBASE_DB_URL должен быть адресом базы вида https://<проект>-default-rtdb.<регион>.firebasedatabase.app, а сейчас: ${base ? base.hostname : "не ссылка"}`);
  }
  const res = await fetch(`${base.origin}${path}.json?${auth}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Firebase ${method} ${path} ${res.status}: ${raw.slice(0, 300)}`);
  return raw ? JSON.parse(raw) : null;
}

// В ключах Realtime Database нельзя . # $ [ ] /
const fbKey = (s) => String(s).replace(/[.#$[\]/]/g, "_");

function messageText(md) {
  if (!md) return null;
  return md.textMessageData?.textMessage
    ?? md.extendedTextMessageData?.text
    ?? md.fileMessageData?.caption
    ?? md.editedMessageData?.textMessage
    ?? null;
}

async function storeWebhook(env, body) {
  const direction = MESSAGE_WEBHOOKS[body.typeWebhook];
  const sd = body.senderData || {};
  if (!direction || !sd.chatId || !body.idMessage) return false; // статусы, смена состояния и т.п. не храним
  const chat = fbKey(sd.chatId);
  const update = {
    [`messages/${chat}/${fbKey(body.idMessage)}`]: {
      direction,
      timestamp: body.timestamp ?? null,
      sender: sd.sender ?? null,
      senderName: sd.senderName || sd.senderContactName || null,
      type: body.messageData?.typeMessage ?? null,
      text: messageText(body.messageData),
      data: body.messageData ?? null,
    },
    [`chats/${chat}/chatId`]: sd.chatId,
    [`chats/${chat}/isGroup`]: sd.chatId.endsWith("@g.us"),
    [`chats/${chat}/lastAt`]: body.timestamp ?? null,
    [`chats/${chat}/count`]: { ".sv": { increment: 1 } },
  };
  if (sd.chatName) update[`chats/${chat}/name`] = sd.chatName;
  await firebase(env, "PATCH", "/", update);
  return true;
}

// Прописывает адрес вебхука в Green API и включает уведомления о сообщениях.
async function connectWebhook(env, origin) {
  if (!env.WEBHOOK_SECRET) throw new Error("В Cloudflare не задан секрет WEBHOOK_SECRET");
  const c = config(env, await loadSettings(env));
  const webhookUrl = `${origin}/webhook/${env.WEBHOOK_SECRET}`;
  const res = await apiCall(c, "setSettings", {
    webhookUrl,
    incomingWebhook: "yes",
    outgoingWebhook: "yes",
    outgoingAPIMessageWebhook: "yes",
  });
  return `Green API: ${JSON.stringify(res)}\nАдрес вебхука прописан. Green API может пару минут перезапускать инстанс.`;
}

// ---------------- Страница управления ----------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

async function authToken(env) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("mqm-watch:" + env.RUN_KEY));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isAuthed(request, env) {
  if (!env.RUN_KEY) return false;
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)mqm_auth=([0-9a-f]+)/);
  return !!m && m[1] === (await authToken(env));
}

const CSS = `
:root{--bg:#f4f5f7;--card:#fff;--fg:#1b1f24;--mut:#667085;--acc:#2563eb;--ok:#15803d;--bad:#dc2626;--line:#e3e6ea}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--fg:#e6e8eb;--mut:#9aa3af;--acc:#4f8df5;--ok:#4ade80;--bad:#f87171;--line:#2a2f37}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px}
header{display:flex;justify-content:space-between;align-items:center;margin:4px 0 16px}
h1{font-size:20px;margin:0}
h2{font-size:15px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
a{color:var(--acc)}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 0 14px}
label{display:block;margin:12px 0 0;font-size:14px;color:var(--mut)}
input[type=text],input[type=url],input[type=number],input[type=password]{display:block;width:100%;margin-top:4px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font-size:16px}
label.sw{display:flex;gap:12px;align-items:center;color:var(--fg);font-size:16px;margin:4px 0}
label.sw input{width:22px;height:22px;accent-color:var(--acc);flex:none}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
.hint{font-size:13px;color:var(--mut);margin:6px 0 0}
button{font:inherit;padding:12px 14px;border-radius:10px;border:0;background:var(--acc);color:#fff;width:100%;cursor:pointer}
.btns{display:grid;gap:8px}
.btns button{background:transparent;color:var(--fg);border:1px solid var(--line);text-align:left}
.btns button.danger{color:var(--bad)}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.row span:first-child{color:var(--mut)}
.row span:last-child{text-align:right}
.ok{color:var(--ok)}.bad{color:var(--bad)}
.msg{padding:12px 14px;border-radius:10px;margin:0 0 14px;border:1px solid var(--line);background:var(--card)}
pre{white-space:pre-wrap;word-break:break-word;font-size:13px;background:var(--bg);padding:10px;border-radius:8px;max-height:60vh;overflow:auto;margin:8px 0 0}
details summary{cursor:pointer;color:var(--acc);margin-top:8px}
`;

function page(title, body, status = 200, headers = {}) {
  return new Response(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers } },
  );
}

function loginPage(error) {
  return page("MQM watch", `
<header><h1>MQM watch</h1></header>
${error ? `<div class="msg bad">${esc(error)}</div>` : ""}
<section><form method="post" action="/login">
<label>Пароль (RUN_KEY)<input type="password" name="key" autocomplete="current-password" autofocus></label>
<p></p><button>Войти</button>
</form></section>`, error ? 403 : 200);
}

const checked = (v) => (v ? " checked" : "");

async function messagesSection(env, origin) {
  const hook = env.WEBHOOK_SECRET ? `${origin}/webhook/${esc(env.WEBHOOK_SECRET)}` : null;
  const rows = [
    ["Firebase", !firebaseReady(env) ? `<span class="bad">не настроен</span>`
      : env.FIREBASE_SECRET ? "вход по FIREBASE_SECRET" : "вход по FIREBASE_SERVICE_ACCOUNT"],
    ["Адрес вебхука", hook ? `<code style="word-break:break-all">${hook}</code>` : `<span class="bad">нет секрета WEBHOOK_SECRET</span>`],
  ];
  let list = "";
  if (firebaseReady(env)) {
    try {
      const chats = Object.values((await firebase(env, "GET", "/chats")) || {})
        .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
      const total = chats.reduce((n, ch) => n + (ch.count || 0), 0);
      rows.push(["Собрано", `${chats.length} чатов, ${total} сообщений`]);
      list = chats.slice(0, 50).map((ch) => `<div class="row"><span>${ch.isGroup ? "👥" : "👤"} ${esc(ch.name || ch.chatId)}`
        + `<br><small>${esc(ch.chatId)}</small></span><span>${ch.count || 0}<br><small>${ch.lastAt ? bakuTime(ch.lastAt * 1000) : ""}</small></span></div>`).join("");
    } catch (e) {
      rows.push(["Ошибка", `<span class="bad">${esc(e.message)}</span>`]);
    }
  }
  return `<section><h2>Сообщения (Firebase)</h2>
${rows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join("")}
${list ? `<details><summary>Чаты</summary>${list}</details>` : ""}
<form method="post" action="/action" class="btns" style="margin-top:10px">
<button name="do" value="webhook" onclick="return confirm('Прописать адрес вебхука в Green API? Инстанс может перезапуститься на пару минут.')">🔗 Подключить вебхук в Green API</button>
</form>
</section>`;
}

async function dashboard(env, msg, result, origin) {
  const s = await loadSettings(env);
  const kv = env.MQM_KV;
  const [last, state, weatherDate] = kv
    ? await Promise.all([kv.get("last_run", "json"), kv.get("state", "json"), kv.get("weather_date")])
    : [null, null, null];

  const tick = Math.floor(Date.now() / 60000);
  const next = (tick + (s.interval - (tick % s.interval))) * 60000;
  const today = ymd(bakuNow());

  const statusRows = [
    ["Бот", s.enabled ? `<span class="ok">включён</span>` : `<span class="bad">выключен</span>`],
    ["Следующая проверка экзамена", s.enabled && s.exam_enabled ? `${bakuTime(next)} (каждые ${s.interval} мин)` : "—"],
    ["Прогноз сегодня", !s.weather_enabled ? "выключен" : weatherDate === today ? "отправлен" : `ещё нет (в ${s.send_hour}:00)`],
    ["Последний запуск", last
      ? `${bakuTime(last.time)} · ${esc(last.source)} · ${last.ok ? `<span class="ok">OK</span>` : `<span class="bad">ошибка</span>`}`
      : "ещё не было"],
  ];
  if (state) {
    statusRows.push(["Сохранённые баллы", `${num(state.total)} / ${state.max}`]);
    for (const [name, v] of Object.entries(norm(state.subjects))) {
      statusRows.push([`• ${esc(name)}`, `${num(v.score)}`
        + ("correct" in v ? ` (✅ ${v.correct} | ❌ ${v.wrong} | ⏳ ${v.unverified ?? 0})` : "")]);
    }
  } else {
    statusRows.push(["Сохранённые баллы", "нет — следующая проверка запомнит текущие"]);
  }
  if (!kv) statusRows.unshift(["Внимание", `<span class="bad">не привязан KV namespace MQM_KV</span>`]);

  return page("MQM watch", `
<header><h1>MQM watch</h1><a href="/logout">Выйти</a></header>
${msg ? `<div class="msg">${msg}</div>` : ""}
${result ? `<section><h2>Результат</h2><div class="${result.ok ? "ok" : "bad"}">${result.ok ? "Готово" : "Ошибка"}</div><pre>${esc(result.log.slice(0, 50000))}</pre></section>` : ""}

<section><h2>Статус</h2>
${statusRows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join("")}
${last ? `<details><summary>Лог последнего запуска</summary><pre>${esc(last.log)}</pre></details>` : ""}
</section>

${await messagesSection(env, origin)}

<form method="post" action="/save">
<section><h2>Общее</h2>
<label class="sw"><input type="checkbox" name="enabled"${checked(s.enabled)}> Бот включён</label>
<p class="hint">Выключено — по расписанию ничего не происходит. Кнопки ниже работают всегда.</p>
</section>

<section><h2>Экзамен</h2>
<label class="sw"><input type="checkbox" name="exam_enabled"${checked(s.exam_enabled)}> Проверять баллы</label>
<label>Как часто проверять, минут (от ${MIN_INTERVAL} до 1440)<input type="number" name="interval" min="${MIN_INTERVAL}" max="1440" value="${esc(s.interval)}"></label>
<label>Ссылка на результат<input type="url" name="url" value="${esc(s.url)}"></label>
<label>Имя в сообщении<input type="text" name="title" value="${esc(s.title)}"></label>
<label>Предметы через запятую — точно как на сайте<input type="text" name="subjects" value="${esc(s.subjects)}"></label>
<p class="hint">При смене ссылки или предметов сохранённые баллы сбрасываются: следующая проверка запомнит новые без сообщения.</p>
</section>

<section><h2>Погода</h2>
<label class="sw"><input type="checkbox" name="weather_enabled"${checked(s.weather_enabled)}> Утренний прогноз</label>
<label>Место (как в сообщении)<input type="text" name="place" value="${esc(s.place)}"></label>
<div class="grid2">
<label>Широта<input type="text" inputmode="decimal" name="lat" value="${esc(s.lat)}"></label>
<label>Долгота<input type="text" inputmode="decimal" name="lon" value="${esc(s.lon)}"></label>
<label>Час отправки (Баку)<input type="number" name="send_hour" min="0" max="23" value="${esc(s.send_hour)}"></label>
<label>Часов вперёд<input type="number" name="hours" min="1" max="24" value="${esc(s.hours)}"></label>
</div>
<label class="sw" style="margin-top:14px"><input type="checkbox" name="clean_enabled"${checked(s.clean_enabled)}> Перед прогнозом удалять вчерашние сообщения бота</label>
</section>

<button>Сохранить настройки</button>
</form>

<p></p>
<section><h2>Действия</h2>
<form method="post" action="/action" class="btns">
<button name="do" value="exam">🔄 Проверить экзамен сейчас</button>
<button name="do" value="test">✅ Тестовое сообщение с баллами в группу</button>
<button name="do" value="weather">🌦 Прислать прогноз сейчас</button>
<button name="do" value="dump">🔍 Показать, что бот видит на странице экзамена</button>
<button name="do" value="clean" class="danger" onclick="return confirm('Удалить у всех старые сообщения бота?')">🧹 Удалить старые сообщения бота</button>
<button name="do" value="reset" class="danger" onclick="return confirm('Сбросить сохранённые баллы?')">↺ Сбросить сохранённые баллы</button>
</form>
</section>
<p class="hint">Cron Trigger в Cloudflare должен быть <code>* * * * *</code> (каждую минуту) — частоту проверок задаёт настройка выше.</p>
`);
}

async function saveSettings(request, env) {
  const f = await request.formData();
  const old = await loadSettings(env);
  const str = (k) => String(f.get(k) ?? "").trim();
  const int = (k, min, max, label) => {
    const v = Number(str(k));
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${label}: целое число от ${min} до ${max}`);
    return v;
  };
  const coord = (k, lim, label) => {
    const v = Number(str(k).replace(",", "."));
    if (!str(k) || !Number.isFinite(v) || Math.abs(v) > lim) throw new Error(`${label}: число от -${lim} до ${lim}`);
    return String(v);
  };
  const url = str("url");
  let u;
  try { u = new URL(url); } catch { u = null; }
  if (!u || u.protocol !== "https:") throw new Error("Ссылка на результат должна начинаться с https://");
  const subjects = str("subjects").split(",").map((x) => x.trim()).filter(Boolean).join(", ");
  if (!subjects) throw new Error("Укажите хотя бы один предмет");

  const s = {
    enabled: f.get("enabled") === "on",
    exam_enabled: f.get("exam_enabled") === "on",
    interval: int("interval", MIN_INTERVAL, 1440, "Частота проверки"),
    url,
    title: str("title") || "Asim Qaraxanov",
    subjects,
    weather_enabled: f.get("weather_enabled") === "on",
    place: str("place") || "Pirşağı",
    lat: coord("lat", 90, "Широта"),
    lon: coord("lon", 180, "Долгота"),
    send_hour: int("send_hour", 0, 23, "Час отправки"),
    hours: int("hours", 1, 24, "Часов вперёд"),
    clean_enabled: f.get("clean_enabled") === "on",
  };
  await env.MQM_KV.put("settings", JSON.stringify(s));
  const reset = s.url !== old.url || s.subjects !== old.subjects;
  if (reset) await env.MQM_KV.delete("state");
  return reset ? "Сохранено. Ссылка или предметы изменились — сохранённые баллы сброшены." : "Сохранено.";
}

async function doAction(env, action, origin) {
  const s = await loadSettings(env);
  const base = { exam: false, weather: false, test: false, clean: false, dump: false };
  const opts = {
    exam: { exam: true },
    test: { exam: true, test: true },
    weather: { weather: true, test: true },
    dump: { dump: true },
    clean: { clean: true },
  }[action];
  if (action === "webhook") {
    try {
      return { ok: true, log: await connectWebhook(env, origin) };
    } catch (e) {
      return { ok: false, log: e.message };
    }
  }
  if (action === "reset") {
    await env.MQM_KV.delete("state");
    return { ok: true, log: "Сохранённые баллы сброшены. Следующая проверка запомнит текущие без сообщения." };
  }
  if (!opts) return { ok: false, log: "Неизвестное действие" };
  return run(env, s, { ...base, ...opts }, "вручную");
}

function flag(params, name, def) {
  const v = params.get(name);
  if (v === null) return def;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

export default {
  async scheduled(event, env) {
    const s = await loadSettings(env);
    if (!s.enabled) return;
    const tick = Math.floor(event.scheduledTime / 60000);
    const res = await run(env, s, {
      exam: s.exam_enabled && tick % s.interval === 0,
      weather: s.weather_enabled,
      test: false, clean: false, dump: false,
    }, "по расписанию");
    if (!res.ok) throw new Error(res.log);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/run") {
      if (!env.RUN_KEY || url.searchParams.get("key") !== env.RUN_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      const p = url.searchParams;
      const res = await run(env, await loadSettings(env), {
        exam: flag(p, "exam", true),
        weather: flag(p, "weather", true),
        test: flag(p, "test", false),
        clean: flag(p, "clean", false),
        dump: flag(p, "dump", false),
      }, "по ссылке");
      return new Response((res.ok ? "OK\n\n" : "ОШИБКА\n\n") + res.log, {
        status: res.ok ? 200 : 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (path.startsWith("/webhook/")) {
      if (!env.WEBHOOK_SECRET || path !== `/webhook/${env.WEBHOOK_SECRET}`) return new Response("Not found", { status: 404 });
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }
      try {
        await storeWebhook(env, body);
      } catch (e) {
        console.log("ОШИБКА вебхука:", e.message);
        return new Response("Error", { status: 500 }); // Green API пришлёт уведомление повторно
      }
      return new Response("OK");
    }

    if (path === "/login" && request.method === "POST") {
      if (!env.RUN_KEY) return loginPage("В Cloudflare не задан секрет RUN_KEY");
      const key = String((await request.formData()).get("key") || "");
      if (key !== env.RUN_KEY) return loginPage("Неверный пароль");
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": `mqm_auth=${await authToken(env)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000`,
        },
      });
    }

    if (path === "/logout") {
      return new Response(null, {
        status: 303,
        headers: { Location: "/", "Set-Cookie": "mqm_auth=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" },
      });
    }

    if (path !== "/" && path !== "/save" && path !== "/action") return new Response("Not found", { status: 404 });
    if (!(await isAuthed(request, env))) return loginPage();

    if (path === "/save" && request.method === "POST") {
      try {
        const msg = await saveSettings(request, env);
        return new Response(null, { status: 303, headers: { Location: "/?msg=" + encodeURIComponent(msg) } });
      } catch (e) {
        return dashboard(env, `<span class="bad">Не сохранено: ${esc(e.message)}</span>`, null, url.origin);
      }
    }

    if (path === "/action" && request.method === "POST") {
      const action = String((await request.formData()).get("do") || "");
      return dashboard(env, null, await doAction(env, action, url.origin), url.origin);
    }

    const msg = url.searchParams.get("msg");
    return dashboard(env, msg ? esc(msg) : null, null, url.origin);
  },
};
