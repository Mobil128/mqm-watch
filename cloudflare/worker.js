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
//   GEMINI_API_KEY      - (необязательно) ключ Gemini для разбора переписки на странице (secret)
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
const PARTS = ["Gecə", "Səhər", "Gündüz", "Axşam"];

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
    gemini_model: "gemini-flash-latest",
    gemini_lang: "ru",
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
  const res = await fetch(`${c.api}/waInstance${c.id}/${method}/${c.token}`, payload === undefined ? {} : {
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
    hourly: "temperature_2m,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,wind_direction_10m",
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
  // обрезаем по границе части суток, чтобы в конце не было обрывка в час-два
  const full = addHours(start, c.s.hours);
  const cut = addHours(full, -(full.getUTCHours() % 6));
  const end = cut > start ? cut : full;
  const rows = [];
  h.time.forEach((t, i) => {
    const dt = new Date(t + ":00Z"); // Open-Meteo отдаёт местное время без зоны: "2026-10-30T07:00"
    if (!(dt >= start && dt < end)) return;
    rows.push({
      dt,
      temp: h.temperature_2m[i] ?? 0,
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
  const wet = rows.filter((r) => r.rain >= 0.1);
  const span = (vals) => {
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return lo === hi ? `${lo}` : `${lo}…${hi}`;
  };
  const temps = rows.map((r) => Math.round(r.temp));
  const lines = [
    `🌦 ${c.s.place} — hava proqnozu`,
    `${WEEKDAYS[(now.getUTCDay() + 6) % 7]}, ${dm(now)}.${now.getUTCFullYear()}`,
    `🌡 Temperatur: ${span(temps)} °C`,
    total >= 0.1
      ? `🌧 Yağış: ${total.toFixed(1)} mm, saat ${hm(wet[0].dt)}–${hm(addHours(wet[wet.length - 1].dt, 1))}`
      : "☀️ Yağış gözlənilmir",
    `💨 Ən güclü külək: ${peak.gust.toFixed(0)} km/saat, ${dm(peak.dt)} saat ${hm(peak.dt)}${peak.gust >= STRONG_GUST ? " ⚠️" : ""}`,
    "",
  ];
  // части суток подряд: ночь 0–6, утро 6–12, день 12–18, вечер 18–24
  const parts = [];
  for (const r of rows) {
    const key = ymd(r.dt) + Math.floor(r.dt.getUTCHours() / 6);
    if (!parts.length || parts[parts.length - 1].key !== key) parts.push({ key, rows: [] });
    parts[parts.length - 1].rows.push(r);
  }
  for (const { rows: pr } of parts) {
    const first = pr[0].dt.getUTCHours();
    const until = pr[pr.length - 1].dt.getUTCHours() + 1;
    const rain = pr.reduce((s, r) => s + r.rain, 0);
    const prob = Math.max(0, ...pr.map((r) => r.prob ?? 0));
    const gust = Math.max(...pr.map((r) => r.gust));
    const dirs = {};
    pr.forEach((r) => { dirs[r.dir] = (dirs[r.dir] || 0) + 1; });
    const dir = Object.keys(dirs).reduce((a, b) => (dirs[b] > dirs[a] ? b : a));
    lines.push(`${PARTS[Math.floor(first / 6)]} ${pad(first)}–${pad(until)}: `
      + `🌡 ${span(pr.map((r) => Math.round(r.temp)))}° · `
      + (rain >= 0.1 ? `🌧 ${rain.toFixed(1)} mm` : prob >= 30 ? `yağış ${prob}%` : "yağış yox")
      + ` · 💨 ${span(pr.map((r) => Math.round(r.wind)))}, ani ${gust.toFixed(0)}, ${dir}${gust >= STRONG_GUST ? " ⚠️" : ""}`);
  }
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

// Только наличие, без значений.
function secretsReport(env) {
  const need = ["GREEN_ID_INSTANCE", "GREEN_API_TOKEN", "GREEN_CHAT_ID", "RUN_KEY", "WEBHOOK_SECRET", "FIREBASE_DB_URL"];
  const missing = need.filter((k) => !String(env[k] ?? "").trim());
  if (!env.FIREBASE_SECRET && !env.FIREBASE_SERVICE_ACCOUNT) missing.push("FIREBASE_SECRET или FIREBASE_SERVICE_ACCOUNT");
  const notes = missing.map((k) => `<span class="bad">нет ${k}</span>`);
  if (env.FIREBASE_SERVICE_ACCOUNT && !env.FIREBASE_SECRET) {
    try {
      const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
      if (!sa.client_email || !sa.private_key) notes.push(`<span class="bad">в FIREBASE_SERVICE_ACCOUNT нет client_email/private_key</span>`);
    } catch {
      notes.push(`<span class="bad">FIREBASE_SERVICE_ACCOUNT — не JSON</span>`);
    }
  }
  if (!notes.length) return `<span class="ok">все на месте</span>`;
  // имена (не значения) всего, что видит воркер: в кавычках заметны лишние пробелы
  const names = Object.keys(env).sort().map((k) => esc(JSON.stringify(k))).join(", ");
  return notes.join("<br>") + `<br><small>Воркер видит: ${names}</small>`;
}

const firebaseReady = (env) => !!(env.FIREBASE_DB_URL && (env.FIREBASE_SECRET || env.FIREBASE_SERVICE_ACCOUNT));

async function firebase(env, method, path, body, query = "") {
  if (!firebaseReady(env)) throw new Error("Не заданы FIREBASE_DB_URL и FIREBASE_SECRET / FIREBASE_SERVICE_ACCOUNT");
  const auth = env.FIREBASE_SECRET
    ? "auth=" + encodeURIComponent(env.FIREBASE_SECRET.trim())
    : "access_token=" + encodeURIComponent(await googleAccessToken(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)));
  let base;
  try { base = new URL(env.FIREBASE_DB_URL.trim()); } catch { base = null; }
  if (!base || !/\.(firebasedatabase\.app|firebaseio\.com)$/.test(base.hostname)) {
    throw new Error(`FIREBASE_DB_URL должен быть адресом базы вида https://<проект>-default-rtdb.<регион>.firebasedatabase.app, а сейчас: ${base ? base.hostname : "не ссылка"}`);
  }
  const res = await fetch(`${base.origin}${path}.json?${auth}${query ? "&" + query : ""}`, {
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
  const order = parseFuelOrder(messageText(body.messageData));
  if (order && body.timestamp) {
    update[`orders/${fbKey(body.idMessage)}`] = orderRecord(order, body.timestamp, sd.chatId, sd.chatName, sd.senderName || sd.senderContactName);
  }
  await firebase(env, "PATCH", "/", update);
  return true;
}

// ---------------- Заказы топлива ----------------
// «03-i saylı YDS / Ai92 - 18500 / Ai95 - 15000 / N/r: Nağı 055 793 93 30»:
// номер АЗС, литры по видам топлива, кто принимает. Топливо приходит ночью.

const FUEL_ORDER = ["Ai92", "Ai95", "Ai98", "Dizel"];
const NIGHT_START_HOUR = 6; // заказ с 06:00 до 06:00 следующего дня — на ночь этого дня

function parseFuelOrder(text) {
  if (!text) return null;
  const st = text.match(/(\d{1,3})[ \t]*-?[ \t]*[a-zəıiöüşçğ]*[ \t]*say[ıi]?l[ıi][ \t]*YDS/iu) || text.match(/YDS[ \t]*(?:№|N|#|-)?[ \t]*(\d{1,3})/i);
  if (!st) return null;
  const fuels = {};
  for (const m of text.matchAll(/^[ \t]*(?:ai[ \t]*-?[ \t]*(\d{2,3})|(dizel|diesel|dt))[ \t]*[-–—:=][ \t]*(\d[\d .,]*)/gimu)) {
    const name = m[1] ? `Ai${m[1]}` : "Dizel";
    const liters = Number(m[3].replace(/\D/g, ""));
    if (liters > 0) fuels[name] = (fuels[name] || 0) + liters;
  }
  if (!Object.keys(fuels).length) return null;
  const r = text.match(/N[ \t]*\/[ \t]*r[ \t]*[:.\-]?[ \t]*(.+)$/im);
  let receiver = null, phone = null;
  if (r) {
    const ph = r[1].match(/(?:\+?994|0)[ \t]*\(?\d{2}\)?[ \t-]*\d{3}[ \t-]*\d{2}[ \t-]*\d{2}/);
    phone = ph ? ph[0].trim() : null;
    receiver = (ph ? r[1].replace(ph[0], "") : r[1]).replace(/[\s,;:–-]+$/, "").trim() || null;
  }
  return { station: Number(st[1]), fuels, receiver, phone };
}

const nightOf = (ts) => ymd(new Date(ts * 1000 + BAKU_OFFSET_MS - NIGHT_START_HOUR * 3600000));

function orderRecord(order, timestamp, chatId, chatName, senderName) {
  return { ...order, timestamp, night: nightOf(timestamp), chatId, chatName: chatName || null, senderName: senderName || null };
}

// Разовый поиск заказов в уже собранных сообщениях.
async function backfillOrders(env) {
  const [messages, chats] = await Promise.all([firebase(env, "GET", "/messages"), firebase(env, "GET", "/chats")]);
  const update = {};
  for (const [chatKey, list] of Object.entries(messages || {})) {
    const chat = (chats || {})[chatKey] || {};
    for (const [id, m] of Object.entries(list || {})) {
      const order = parseFuelOrder(m?.text);
      if (order && m.timestamp) update[`orders/${id}`] = orderRecord(order, m.timestamp, chat.chatId || chatKey, chat.name, m.senderName);
    }
  }
  const n = Object.keys(update).length;
  if (n) await firebase(env, "PATCH", "/", update);
  return n;
}

const liters = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const fuelSort = (a, b) => (FUEL_ORDER.indexOf(a) + 1 || 99) - (FUEL_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b);

function sumFuels(list) {
  const out = {};
  for (const o of list) for (const [f, l] of Object.entries(o.fuels || {})) out[f] = (out[f] || 0) + l;
  return Object.entries(out).sort(([a], [b]) => fuelSort(a, b));
}

// Последний вебхук для страницы управления. Пишем не чаще раза в 10 минут
// (или сразу, если результат сменился), чтобы не упереться в лимит записей KV.
async function noteWebhook(env, ok, note) {
  if (!env.MQM_KV) return;
  const prev = await env.MQM_KV.get("last_webhook", "json");
  if (prev && prev.ok === ok && Date.now() - prev.time < 10 * 60000) return;
  await env.MQM_KV.put("last_webhook", JSON.stringify({ time: Date.now(), ok, note: String(note).slice(0, 300) }));
}

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  if (min < 48 * 60) return `${Math.round(min / 60)} ч назад`;
  return bakuTime(ms);
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

// ---------------- Анализ переписки (статистика и Gemini) ----------------
// Только чтение: ничего не отправляет в группы.

const PERIODS = { 24: "24 часа", 72: "3 дня", 168: "7 дней", 720: "30 дней" };
const TYPE_NAMES = {
  textMessage: "текст", extendedTextMessage: "текст", quotedMessage: "ответ", imageMessage: "фото",
  videoMessage: "видео", audioMessage: "голосовое", documentMessage: "документ", stickerMessage: "стикер",
  reactionMessage: "реакция", locationMessage: "локация", contactMessage: "контакт", contactsArrayMessage: "контакты",
  pollMessage: "опрос", pollUpdateMessage: "голос в опросе", editedMessage: "правка", deletedMessage: "удаление",
};
const GEMINI_MAX_CHARS = 120000; // хватает на тысячи сообщений и укладывается в бесплатные лимиты
const FIREBASE_INDEX_HINT = `Чтобы анализ быстро работал на больших чатах, добавьте в Firebase → Realtime Database → Rules:
{
  "rules": {
    ".read": false,
    ".write": false,
    "messages": { "$chat": { ".indexOn": ["timestamp"] } }
  }
}`;

const who = (m) => (m.direction === "outgoing_api" ? "🤖 бот" : m.senderName || String(m.sender || "").replace(/@.*/, "") || "?");

async function loadMessages(env, chatId, sinceSec) {
  const path = `/messages/${fbKey(chatId)}`;
  let data, indexed = true;
  try {
    data = await firebase(env, "GET", path, null, `orderBy=${encodeURIComponent('"timestamp"')}&startAt=${sinceSec}`);
  } catch (e) {
    if (!/index not defined/i.test(e.message)) throw e;
    indexed = false; // без индекса берём весь чат и фильтруем сами
    data = await firebase(env, "GET", path);
  }
  const list = Object.values(data || {})
    .filter((m) => m && (m.timestamp || 0) >= sinceSec)
    .sort((a, b) => a.timestamp - b.timestamp);
  return { list, indexed };
}

function countBy(list, key) {
  const out = {};
  for (const m of list) { const k = key(m); out[k] = (out[k] || 0) + 1; }
  return out;
}

function barRows(entries, max) {
  return entries.map(([label, n]) => `<div class="brow" title="${esc(label)}: ${n}">`
    + `<span class="blabel">${esc(label)}</span><span class="btrack"><span class="bfill" style="width:${Math.max(2, Math.round(n / max * 100))}%"></span></span>`
    + `<span class="bval">${n}</span></div>`).join("");
}

function statsHtml(list, hours) {
  const people = list.filter((m) => m.direction !== "outgoing_api");
  const bot = list.length - people.length;
  const senders = Object.entries(countBy(list, who)).sort((a, b) => b[1] - a[1]);
  const top = senders.slice(0, 10);
  const byHour = Array(24).fill(0);
  list.forEach((m) => { byHour[new Date(m.timestamp * 1000 + BAKU_OFFSET_MS).getUTCHours()]++; });
  const hourMax = Math.max(1, ...byHour);
  const types = Object.entries(countBy(list, (m) => TYPE_NAMES[m.type] || m.type || "другое")).sort((a, b) => b[1] - a[1]);
  const peakHour = byHour.indexOf(Math.max(...byHour));

  let html = `<div class="tiles">
<div class="tile"><b>${list.length}</b><span>сообщений</span></div>
<div class="tile"><b>${senders.filter(([n]) => n !== "🤖 бот").length}</b><span>участников писали</span></div>
<div class="tile"><b>${list.length ? `${pad(peakHour)}:00` : "—"}</b><span>самый активный час</span></div>
</div>`;
  if (bot) html += `<p class="hint">Из них ${bot} — сообщения бота (баллы, прогноз).</p>`;
  if (!list.length) return html;

  html += `<h3>Кто сколько писал</h3>${barRows(top, top[0][1])}`;
  if (senders.length > top.length) html += `<p class="hint">и ещё ${senders.length - top.length} участников</p>`;

  html += `<h3>Активность по часам (Баку)</h3><div class="cols" role="img" aria-label="Сообщения по часам">`
    + byHour.map((n, h) => `<span class="col" title="${pad(h)}:00–${pad(h + 1)}:00 — ${n}"><span style="height:${n ? Math.max(4, Math.round(n / hourMax * 100)) : 0}%"></span></span>`).join("")
    + `</div><div class="cols-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>`;

  if (hours > 24) {
    const days = Object.entries(countBy(list, (m) => ymd(new Date(m.timestamp * 1000 + BAKU_OFFSET_MS)))).sort();
    const dayMax = Math.max(...days.map(([, n]) => n));
    html += `<h3>По дням</h3>${barRows(days.map(([d, n]) => [`${d.slice(8)}.${d.slice(5, 7)}`, n]), dayMax)}`;
  }
  html += `<h3>Типы сообщений</h3><div class="chips">${types.map(([t, n]) => `<span class="chipx">${esc(t)} · ${n}</span>`).join("")}</div>`;
  return html;
}

function transcript(list) {
  const lines = list.filter((m) => m.direction !== "outgoing_api").map((m) => {
    const t = new Date(m.timestamp * 1000 + BAKU_OFFSET_MS);
    const kind = TYPE_NAMES[m.type];
    const text = (m.text || "").replace(/\s+/g, " ").trim();
    const body = kind === "текст" || kind === "ответ" ? text : `<${kind || m.type || "сообщение"}${text ? ": " + text : ""}>`;
    return `[${dm(t)} ${hm(t)}] ${who(m)}: ${body}`;
  });
  let total = 0, from = lines.length;
  while (from > 0 && total + lines[from - 1].length + 1 <= GEMINI_MAX_CHARS) total += lines[--from].length + 1;
  return { text: lines.slice(from).join("\n"), used: lines.length - from, all: lines.length };
}

const GEMINI_FALLBACK = "gemini-flash-lite-latest";

async function geminiOnce(env, model, prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY.trim() },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`Gemini ${res.status}: ${data?.error?.message || "нет ответа"}`);
    err.busy = res.status === 503 || res.status === 429 || res.status === 500;
    throw err;
  }
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini не дал ответа" + (data?.promptFeedback?.blockReason ? ` (${data.promptFeedback.blockReason})` : ""));
  return text;
}

// При перегрузке (503/429/500): ещё две попытки через 2 и 5 с, затем запасная лёгкая модель.
async function gemini(env, model, prompt) {
  if (!env.GEMINI_API_KEY) throw new Error("В Cloudflare не задан секрет GEMINI_API_KEY");
  const plan = [[model, 0], [model, 2000], [model, 5000]];
  if (model !== GEMINI_FALLBACK) plan.push([GEMINI_FALLBACK, 0], [GEMINI_FALLBACK, 3000]);
  let last;
  for (const [m, wait] of plan) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      return { text: await geminiOnce(env, m, prompt), model: m };
    } catch (e) {
      last = e;
      if (!e.busy) throw e;
    }
  }
  throw new Error(`Gemini сейчас перегружен, попробуйте через несколько минут. (${last.message})`);
}

// Минимальная разметка ответа Gemini: экранируем, затем **жирный** и заголовки #.
function mdLite(text) {
  return esc(text)
    .replace(/^#{1,4}\s*(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/^\s*[*-]\s+/gm, "• ");
}

const LANGS = {
  ru: ["Русский", "Russian"],
  az: ["Azərbaycanca", "Azerbaijani"],
  en: ["English", "English"],
  tr: ["Türkçe", "Turkish"],
};

const GLOSSARY = `Context: "YDS" (yanacaqdoldurma stansiyası) is a fuel station, "03-i saylı YDS" means station No. 3.
"Ai92", "Ai95", "Dizel" with a number are fuel orders in liters; "N/r" is the person who will receive the delivery, with a phone.
Fuel is delivered at night. Refer to these as fuel orders for a station.`;

const summaryPrompt = (lang) => `You analyze a WhatsApp chat. Messages may be in Azerbaijani, Russian or Turkish.
${GLOSSARY}
Write the whole answer in ${lang}, concisely, with these sections (translate the headings into ${lang}):
1. In short — 2–3 sentences about the main points.
2. Topics — a list.
3. Decisions and agreements — who, what, by when.
4. Open questions and requests left without an answer.
5. Important and urgent — dates, amounts, meetings.
6. Mood in the chat — one line.
Use only the chat and invent nothing; if a section is empty, say so in one word. Do not output phone numbers.`;

const askPrompt = (lang) => `You answer a question about a WhatsApp chat. Messages may be in Azerbaijani, Russian or Turkish.
${GLOSSARY}
Answer in ${lang}, briefly, using only the chat. Where useful, say who wrote it and when.
If the chat does not contain the answer, say so. Do not output phone numbers.`;

async function analyze(env, form) {
  const s = await loadSettings(env);
  const a = {
    chat: String(form.get("chat") || ""),
    hours: Number(form.get("period")) in PERIODS ? Number(form.get("period")) : 24,
    question: String(form.get("question") || "").trim().slice(0, 1000),
    action: String(form.get("do") || "stats"),
    lang: LANGS[String(form.get("lang"))] ? String(form.get("lang")) : s.gemini_lang,
  };
  if (!a.chat) return { a, ok: false, html: "Выберите чат." };
  const chats = (await firebase(env, "GET", "/chats")) || {};
  const chat = chats[fbKey(a.chat)];
  const name = chat?.name || a.chat;
  const since = Math.floor(Date.now() / 1000) - a.hours * 3600;
  const { list, indexed } = await loadMessages(env, a.chat, since);
  const head = `<h2>${esc(name)} <span class="meta">за ${PERIODS[a.hours]}</span></h2>`;
  const hint = indexed ? "" : `<details><summary>Совет: индекс в Firebase</summary><pre>${esc(FIREBASE_INDEX_HINT)}</pre></details>`;

  if (a.action === "stats") return { a, ok: true, html: head + statsHtml(list, a.hours) + hint };

  const tr = transcript(list);
  if (!tr.used) return { a, ok: true, html: head + "<p>За этот период сообщений от участников нет.</p>" + hint };
  if (a.action === "ask" && !a.question) return { a, ok: false, html: head + "Напишите вопрос в поле «Вопрос»." };
  const lang = LANGS[a.lang][1];
  const intro = a.action === "ask" ? `${askPrompt(lang)}\n\nQuestion: ${a.question}` : summaryPrompt(lang);
  const { text: answer, model } = await gemini(env, s.gemini_model, `${intro}\n\nChat: "${name}", period: last ${a.hours} hours.\nMessages:\n${tr.text}`);
  const note = tr.used < tr.all ? `<p class="hint">Gemini получил последние ${tr.used} из ${tr.all} сообщений — остальные не поместились.</p>` : "";
  const title = a.action === "ask" ? `<p class="hint">Вопрос: ${esc(a.question)}</p>` : "";
  return { a, ok: true, html: head + title + `<div class="md">${mdLite(answer)}</div>` + note
    + `<p class="hint">${esc(LANGS[a.lang][0])} · модель ${esc(model)}${model !== s.gemini_model ? " (запасная — основная была перегружена)" : ""} · сообщений: ${tr.used}</p>` + hint };
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

const TABS = ["home", "orders", "analysis", "settings", "service"];
const INTERVALS = [5, 10, 15, 20, 30, 60, 120, 180, 360, 720, 1440];
const intervalLabel = (m) => (m < 60 ? `каждые ${m} мин` : m === 60 ? "каждый час" : m === 1440 ? "раз в сутки" : `каждые ${m / 60} ч`);

const CSS = `
:root{--bg:#f3f4f6;--card:#fff;--fg:#14181f;--mut:#5f6876;--line:#e2e5ea;--acc:#1f6feb;--acc-soft:#e8f0fe;--ok:#14803c;--ok-soft:#e7f6ec;--bad:#c62828;--bad-soft:#fdecec;--warn:#9a5b00;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0d1014;--card:#171b21;--fg:#e8ebef;--mut:#98a2b0;--line:#272d36;--acc:#5b9cff;--acc-soft:#16253d;--ok:#4cc77a;--ok-soft:#14261b;--bad:#ff7a70;--bad-soft:#2d1716;--warn:#f0a43c;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding-bottom:calc(76px + env(safe-area-inset-bottom))}
main{max-width:640px;margin:0 auto;padding:12px 16px 24px;display:grid;gap:12px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:4px 2px}
.top h1{font-size:20px;margin:0;font-weight:650}
.top a{color:var(--mut);font-size:14px;text-decoration:none}
.panel{display:grid;gap:12px}
.panel[hidden]{display:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;display:grid;gap:10px}
.card h2{font-size:17px;margin:0;font-weight:650;display:flex;justify-content:space-between;align-items:center;gap:12px}
.meta{font-size:14px;color:var(--mut);margin:0}
.big{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.1}
.big small{font-size:16px;color:var(--mut);font-weight:500}
.subj{display:grid;gap:4px;font-size:14px}
.subj div{display:flex;justify-content:space-between;gap:12px}
.subj span:last-child{font-variant-numeric:tabular-nums;color:var(--mut)}
.alert{border-radius:12px;padding:12px 14px;background:var(--bad-soft);color:var(--bad);font-size:14px}
.alert b{display:block;margin-bottom:2px}
.toast{border-radius:12px;padding:12px 14px;background:var(--ok-soft);color:var(--ok);font-size:15px}
.toast.bad{background:var(--bad-soft);color:var(--bad)}
.row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--line);font-size:15px}
.row:first-of-type{border-top:0}
.row>span:first-child{color:var(--mut)}
.row>span:last-child{text-align:right;word-break:break-word}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
label{display:grid;gap:4px;font-size:14px;color:var(--mut)}
input[type=text],input[type=url],input[type=password],select,textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font:inherit;font-size:16px}
textarea{resize:vertical}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;font:inherit;font-weight:600;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none}
.btn.primary{background:var(--acc);border-color:var(--acc);color:#fff}
.btn.danger{color:var(--bad)}
.btn:disabled{opacity:.6}
.btns{display:grid;gap:8px}
.btns.two{grid-template-columns:1fr 1fr}
.switch{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:16px;color:var(--fg)}
.switch input{appearance:none;-webkit-appearance:none;width:50px;height:30px;border-radius:999px;background:var(--line);position:relative;flex:none;cursor:pointer;transition:background .15s}
.switch input::after{content:"";position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s}
.switch input:checked{background:var(--ok)}
.switch input:checked::after{transform:translateX(20px)}
.seg{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:4px}
.seg label{display:block;cursor:pointer}
.seg input{position:absolute;opacity:0;pointer-events:none}
.seg span{display:block;text-align:center;padding:8px 2px;border-radius:9px;font-size:14px;color:var(--fg)}
.seg input:checked+span{background:var(--card);box-shadow:0 1px 3px rgba(0,0,0,.15);font-weight:600}
.seg input:focus-visible+span{outline:2px solid var(--acc)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
details{font-size:14px}
details summary{cursor:pointer;color:var(--acc);padding:2px 0}
details[open] summary{margin-bottom:8px}
.adv{display:grid;gap:10px}
pre{white-space:pre-wrap;word-break:break-word;font-size:13px;background:var(--bg);padding:10px;border-radius:10px;max-height:55vh;overflow:auto;margin:0}
code{font-size:13px;word-break:break-all}
.hint{font-size:13px;color:var(--mut);margin:0}
.savebar{position:sticky;bottom:calc(72px + env(safe-area-inset-bottom));z-index:1}
.nav{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);display:grid;grid-template-columns:repeat(5,1fr);padding:6px 4px calc(6px + env(safe-area-inset-bottom));z-index:2}
.nav a{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:12px;color:var(--mut);text-decoration:none;padding:4px 0;border-radius:10px}
.nav a[aria-current=page]{color:var(--acc);font-weight:600}
.nav svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.chat{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--line);font-size:14px}
.chat small{color:var(--mut)}
h3{font-size:14px;margin:6px 0 0;color:var(--mut);font-weight:600}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.tile{border:1px solid var(--line);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:2px}
.tile b{font-size:22px;font-variant-numeric:tabular-nums}
.tile span{font-size:12px;color:var(--mut)}
.brow{display:grid;grid-template-columns:minmax(0,38%) 1fr 3ch;gap:8px;align-items:center;padding:3px 0;font-size:14px}
.blabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brow.wide{grid-template-columns:5ch 1fr 8ch}
a{color:var(--acc)}
input[type=date]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font:inherit;font-size:16px;min-height:46px}
.datebar{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end}
.btrack{height:10px}
.bfill{display:block;height:100%;background:var(--acc);border-radius:0 4px 4px 0}
.bval{text-align:right;font-variant-numeric:tabular-nums;color:var(--mut)}
.cols{display:grid;grid-template-columns:repeat(24,1fr);gap:2px;height:90px;align-items:end;border-bottom:1px solid var(--line)}
.col{height:100%;display:flex;align-items:flex-end}
.col span{display:block;width:100%;background:var(--acc);border-radius:4px 4px 0 0}
.cols-axis{display:flex;justify-content:space-between;font-size:11px;color:var(--mut);margin-top:4px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chipx{border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:13px}
.md{white-space:pre-wrap;word-break:break-word;font-size:15px;line-height:1.55}
@media (prefers-reduced-motion:reduce){.switch input,.switch input::after{transition:none}}
`;

// Вкладки, подтверждения и «Подождите…» на кнопках. Без JS все вкладки видны подряд.
const CLIENT_JS = `
(function(){
  var tabs = ["home","orders","analysis","settings","service"];
  var start = document.body.getAttribute("data-tab") || "home";
  function show(t){
    if (tabs.indexOf(t) < 0) t = start;
    tabs.forEach(function(x){ var p = document.getElementById("p-" + x); if (p) p.hidden = x !== t; });
    document.querySelectorAll(".nav a").forEach(function(a){ a.setAttribute("aria-current", a.getAttribute("data-tab") === t ? "page" : "false"); });
    window.scrollTo(0, 0);
  }
  if (location.pathname !== "/") { history.replaceState(null, "", "/#" + start); show(start); }
  else {
    if (/[?&](msg|bad)=/.test(location.search)) { // убрать сообщение, чтобы не всплывало при обновлении; фильтры оставить
      var q = new URLSearchParams(location.search); q.delete("msg"); q.delete("bad");
      var qs = q.toString(); history.replaceState(null, "", "/" + (qs ? "?" + qs : "") + location.hash);
    }
    show(location.hash.slice(1) || start);
  }
  window.addEventListener("hashchange", function(){ show(location.hash.slice(1)); });
  document.addEventListener("submit", function(e){
    var b = e.submitter;
    if (b && b.getAttribute("data-confirm") && !confirm(b.getAttribute("data-confirm"))) { e.preventDefault(); return; }
    var form = e.target;
    setTimeout(function(){
      form.querySelectorAll("button").forEach(function(x){ x.disabled = true; });
      if (b) b.textContent = "⏳ Подождите…";
    }, 0);
  });
})();
`;

const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  analysis: '<path d="M3 21h18M6 17v-6M11 17V5M16 17v-9M21 17v-3"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  service: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  orders: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M7 8h4M14 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3"/>',
};
const TAB_NAMES = { home: "Главная", orders: "Заказы", analysis: "Анализ", settings: "Настройки", service: "Сервис" };

function page(title, body, { tab = "home", status = 200, nav = true } = {}) {
  const navHtml = nav
    ? `<nav class="nav" aria-label="Разделы">${TABS.map((t) => `<a href="#${t}" data-tab="${t}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[t]}</svg>${TAB_NAMES[t]}</a>`).join("")}</nav><script>${CLIENT_JS}</script>`
    : "";
  return new Response(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`
      + `<meta name="theme-color" content="#1f6feb"><title>${esc(title)}</title><style>${CSS}</style></head>`
      + `<body data-tab="${esc(tab)}"><main>${body}</main>${navHtml}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

function loginPage(error) {
  return page("MQM watch", `
<div class="top"><h1>MQM watch</h1></div>
${error ? `<div class="alert">${esc(error)}</div>` : ""}
<form class="card" method="post" action="/login">
<label>Пароль<input type="password" name="key" autocomplete="current-password" autofocus></label>
<button class="btn primary">Войти</button>
<p class="hint">Пароль — это секрет RUN_KEY в Cloudflare.</p>
</form>`, { status: error ? 403 : 200, nav: false });
}

const checked = (v) => (v ? " checked" : "");
const sel = (a, b) => (String(a) === String(b) ? " selected" : "");

function toggleForm(key, on, label) {
  return `<form method="post" action="/toggle"><input type="hidden" name="key" value="${key}"><input type="hidden" name="v" value="off">`
    + `<label class="switch">${label}<input type="checkbox" name="v" value="on"${checked(on)} onchange="this.form.requestSubmit()" aria-label="${esc(label)}"></label></form>`;
}

function actionButton(tab, action, label, { cls = "", confirmText = "" } = {}) {
  return `<form method="post" action="/action"><input type="hidden" name="tab" value="${tab}">`
    + `<button class="btn ${cls}" name="do" value="${action}"${confirmText ? ` data-confirm="${esc(confirmText)}"` : ""}>${label}</button></form>`;
}

function resultCard(result) {
  if (!result) return "";
  return `<div class="toast${result.ok ? "" : " bad"}">${result.ok ? "✅ Готово" : "⚠️ Не получилось"}${result.summary ? ` — ${esc(result.summary)}` : ""}</div>`
    + (result.log ? `<details class="card"${result.open ? " open" : ""}><summary>Подробности</summary><pre>${esc(result.log.slice(0, 50000))}</pre></details>` : "");
}

// Всё, что нужно странице, — одним заходом, параллельно.
async function gatherStatus(env, origin) {
  const s = await loadSettings(env);
  const kv = env.MQM_KV;
  const c = config(env, s);
  const safe = (p) => p.then((v) => ({ v }), (e) => ({ e: e.message }));
  const [last, state, weatherDate, lastHook, chats, gState, gSettings, orders] = await Promise.all([
    kv ? kv.get("last_run", "json") : null,
    kv ? kv.get("state", "json") : null,
    kv ? kv.get("weather_date") : null,
    kv ? kv.get("last_webhook", "json") : null,
    firebaseReady(env) ? safe(firebase(env, "GET", "/chats")) : { e: null },
    safe(apiCall(c, "getStateInstance")),
    safe(apiCall(c, "getSettings")),
    firebaseReady(env) ? safe(firebase(env, "GET", "/orders")) : { e: null },
  ]);
  const orderList = orders.v ? Object.values(orders.v || {}).filter((o) => o && o.night).sort((a, b) => b.timestamp - a.timestamp) : [];
  const chatList = chats.v ? Object.values(chats.v || {}).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)) : [];
  const want = env.WEBHOOK_SECRET ? `${origin}/webhook/${env.WEBHOOK_SECRET}` : null;
  let hookWhere = null;
  if (gSettings.v) {
    const url = gSettings.v.webhookUrl;
    hookWhere = !url ? "none" : url === want ? "ours" : "other";
  }
  return { s, kv, last, state, weatherDate, lastHook, chats, chatList, gState, gSettings, hookWhere, orderList };
}

function problems(env, st) {
  const out = [];
  if (!st.kv) out.push(["Не привязано хранилище KV", "Бот не может запоминать баллы и настройки."]);
  if (/class="bad"/.test(secretsReport(env))) out.push(["Не хватает секретов", "Откройте «Сервис» — там видно, каких именно."]);
  if (st.gState.v && st.gState.v.stateInstance !== "authorized") out.push(["WhatsApp отключён от Green API", "Откройте кабинет Green API и заново отсканируйте QR-код телефоном бота."]);
  if (st.gState.e) out.push(["Green API не отвечает", st.gState.e.slice(0, 160)]);
  if (st.hookWhere && st.hookWhere !== "ours") out.push(["Сообщения не собираются", "Green API шлёт их не туда. «Сервис» → «Подключить вебхук»."]);
  if (st.lastHook && !st.lastHook.ok) out.push(["Последнее сообщение не сохранилось", st.lastHook.note]);
  if (st.chats.e) out.push(["Firebase не отвечает", st.chats.e.slice(0, 160)]);
  if (st.last && !st.last.ok) out.push(["Последний запуск с ошибкой", "Подробности — «Сервис» → «Лог последнего запуска»."]);
  return out;
}

function homePanel(env, st, result) {
  const { s, state, weatherDate, last, chatList, lastHook } = st;
  const tick = Math.floor(Date.now() / 60000);
  const next = (tick + (s.interval - (tick % s.interval))) * 60000;
  const today = ymd(bakuNow());
  const probs = problems(env, st);
  const total = chatList.reduce((n, ch) => n + (ch.count || 0), 0);

  const scores = state
    ? `<div class="big">${num(state.total)} <small>/ ${state.max}</small></div><div class="subj">`
      + Object.entries(norm(state.subjects)).map(([n, v]) => `<div><span>${esc(n)}</span><span>${num(v.score)}${"correct" in v ? ` · ✅${v.correct} ❌${v.wrong} ⏳${v.unverified ?? 0}` : ""}</span></div>`).join("")
      + `</div>`
    : `<p class="meta">Баллы ещё не сохранены — следующая проверка их запомнит.</p>`;

  return `${resultCard(result)}
${probs.map(([t, d]) => `<div class="alert" role="alert"><b>⚠️ ${esc(t)}</b>${esc(d)}</div>`).join("")}

<section class="card">
${toggleForm("enabled", s.enabled, `<b>Бот ${s.enabled ? "работает" : "выключен"}</b>`)}
<p class="meta">${last ? `Последний запуск: ${bakuTime(last.time)} · ${esc(last.source)} · ${last.ok ? `<span class="ok">без ошибок</span>` : `<span class="bad">ошибка</span>`}` : "Ещё не запускался."}${s.enabled ? "" : " Пока выключен, по расписанию ничего не делает; кнопки работают."}</p>
</section>

<section class="card">
<h2>📊 Экзамен</h2>
${toggleForm("exam_enabled", s.exam_enabled, "Следить за баллами")}
${scores}
<p class="meta">${s.enabled && s.exam_enabled ? `Проверка ${intervalLabel(s.interval)} · следующая в ${hm(new Date(next + BAKU_OFFSET_MS))}` : "Автопроверка выключена"}</p>
<div class="btns two">
${actionButton("home", "exam", "🔄 Проверить", { cls: "primary" })}
${actionButton("home", "test", "✅ Тест в группу", { confirmText: "Отправить тестовое сообщение с баллами в группу?" })}
</div>
</section>

<section class="card">
<h2>🌦 Погода</h2>
${toggleForm("weather_enabled", s.weather_enabled, "Утренний прогноз в группу")}
<p class="meta">${esc(s.place)} · в ${pad(s.send_hour)}:00 · сегодня ${weatherDate === today ? `<span class="ok">отправлен</span>` : "ещё не отправлен"}</p>
${actionButton("home", "weather", "🌦 Прислать прогноз сейчас", { confirmText: "Отправить прогноз погоды в группу сейчас?" })}
</section>

${ordersCard(st)}

<section class="card">
<h2>💬 Сообщения</h2>
<p class="meta">${firebaseReady(env) ? `Собрано ${chatList.length} чатов, ${total} сообщений.` : "Сбор не настроен — см. «Сервис»."}
${lastHook ? ` Последнее: ${ago(lastHook.time)} ${lastHook.ok ? `<span class="ok">✓</span>` : `<span class="bad">с ошибкой</span>`}.` : ""}</p>
<a class="btn" href="#analysis">📈 Открыть анализ</a>
</section>`;
}

function ordersCard(st) {
  const tonight = nightOf(Date.now() / 1000);
  const list = st.orderList.filter((o) => o.night === tonight);
  const totals = sumFuels(list);
  return `<section class="card">
<h2>⛽ Заказы на эту ночь</h2>
${list.length
    ? `<div class="chips">${totals.map(([f, l]) => `<span class="chipx"><b>${esc(f)}</b> ${liters(l)} л</span>`).join("")}</div>
<p class="meta">${list.length} заказ(ов): ${[...new Set(list.map((o) => o.station))].sort((a, b) => a - b).map((n) => `АЗС №${n}`).join(", ")}</p>`
    : `<p class="meta">Заказов на эту ночь пока нет.</p>`}
<a class="btn" href="#orders">⛽ Все заказы</a>
</section>`;
}

function ordersPanel(env, st, q = {}) {
  if (!firebaseReady(env)) return `<section class="card"><h2>⛽ Заказы</h2><p class="meta">Сначала нужно настроить сбор сообщений — см. «Сервис».</p></section>`;
  const tonight = nightOf(Date.now() / 1000);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || "") ? q.date : tonight;
  const span = [1, 7, 30].includes(Number(q.span)) ? Number(q.span) : 1;
  const from = ymd(new Date(Date.parse(date + "T00:00:00Z") - (span - 1) * 86400000));
  const list = st.orderList.filter((o) => o.night >= from && o.night <= date);
  const totals = sumFuels(list);
  const title = span === 1 ? (date === tonight ? "Эта ночь" : `Ночь ${date.slice(8)}.${date.slice(5, 7)}`) : `${span} ночей до ${date.slice(8)}.${date.slice(5, 7)}`;

  const form = `<form class="card" method="get" action="/">
<input type="hidden" name="tab" value="orders">
<div class="datebar">
<label>Ночь<input type="date" name="date" value="${date}" max="${tonight}" onchange="this.form.requestSubmit()"></label>
<a class="btn" href="/?tab=orders" style="min-height:46px">Сегодня</a>
</div>
<div class="seg" style="grid-template-columns:repeat(3,1fr)">${[[1, "Ночь"], [7, "7 ночей"], [30, "30 ночей"]].map(([v, l]) => `<label><input type="radio" name="span" value="${v}"${checked(v === span)} onchange="this.form.requestSubmit()"><span>${l}</span></label>`).join("")}</div>
<noscript><button class="btn">Показать</button></noscript>
</form>`;

  if (!list.length) return form + `<section class="card"><h2>${title}</h2><p class="meta">Заказов нет.</p>
<p class="hint">Бот узнаёт заказы по виду «03-i saylı YDS / Ai92 - 18500 / N/r: имя телефон». Если заказы были до подключения — «Сервис» → «Найти заказы в собранных сообщениях».</p></section>`;

  const byStation = {};
  for (const o of list) (byStation[o.station] ||= []).push(o);
  const stationRows = Object.entries(byStation).sort(([a], [b]) => a - b)
    .map(([n, os]) => `<div class="row"><span>АЗС №${n} <small>· ${os.length}</small></span><span>${sumFuels(os).map(([f, l]) => `${esc(f)} ${liters(l)}`).join(" · ")}</span></div>`).join("");

  let nights = "";
  if (span > 1) {
    const perNight = {};
    for (const o of list) perNight[o.night] = (perNight[o.night] || 0) + Object.values(o.fuels || {}).reduce((x, y) => x + y, 0);
    const rows = Object.entries(perNight).sort(([a], [b]) => (a < b ? 1 : -1)).map(([d, l]) => [`${d.slice(8)}.${d.slice(5, 7)}`, l]);
    const max = Math.max(...rows.map(([, l]) => l));
    nights = `<h3>Литров по ночам</h3>` + rows.map(([d, l]) => `<div class="brow wide" title="${d}: ${liters(l)} л"><span class="blabel">${d}</span><span class="btrack"><span class="bfill" style="width:${Math.max(2, Math.round(l / max * 100))}%"></span></span><span class="bval">${liters(l)}</span></div>`).join("");
  }

  const cards = list.map((o) => {
    const t = new Date(o.timestamp * 1000 + BAKU_OFFSET_MS);
    const tel = o.phone ? o.phone.replace(/[^\d+]/g, "") : "";
    return `<section class="card">
<h2>АЗС №${o.station}<span class="meta">${dm(t)} ${hm(t)}</span></h2>
<div class="chips">${Object.entries(o.fuels || {}).sort(([a], [b]) => fuelSort(a, b)).map(([f, l]) => `<span class="chipx"><b>${esc(f)}</b> ${liters(l)} л</span>`).join("")}</div>
${o.receiver || o.phone ? `<p class="meta">Принимает: <b style="color:var(--fg)">${esc(o.receiver || "—")}</b>${o.phone ? ` · <a href="tel:${esc(tel)}">📞 ${esc(o.phone)}</a>` : ""}</p>` : ""}
<p class="hint">${esc(o.senderName || "")}${o.chatName ? ` · ${esc(o.chatName)}` : ""}</p>
</section>`;
  }).join("");

  return `${form}
<section class="card">
<h2>${title}<span class="meta">${list.length} заказ(ов)</span></h2>
<div class="tiles" style="grid-template-columns:repeat(${Math.min(3, totals.length)},1fr)">${totals.map(([f, l]) => `<div class="tile"><b>${liters(l)}</b><span>${esc(f)}, л</span></div>`).join("")}</div>
<div>${stationRows}</div>
${nights}
</section>
${cards}`;
}

function analysisPanel(env, st, analysis) {
  const { s, chatList } = st;
  const a = analysis?.a || {};
  const hours = a.hours || 24;
  const lang = a.lang || s.gemini_lang;
  const res = analysis
    ? `<section class="card">${analysis.ok ? "" : `<div class="toast bad">⚠️ Не получилось</div>`}${analysis.html}</section>`
    : "";
  if (!firebaseReady(env)) return res + `<section class="card"><h2>Анализ переписки</h2><p class="meta">Сначала нужно настроить сбор сообщений в Firebase — см. «Сервис».</p></section>`;
  if (!chatList.length) return res + `<section class="card"><h2>Анализ переписки</h2><p class="meta">Пока нет собранных чатов. Напишите что-нибудь в группу.</p></section>`;
  return `${res}
<form class="card" method="post" action="/analyze">
<h2>Анализ переписки</h2>
<label>Чат<select name="chat">${chatList.map((ch) => `<option value="${esc(ch.chatId)}"${sel(ch.chatId, a.chat)}>${ch.isGroup ? "👥" : "👤"} ${esc(ch.name || ch.chatId)} · ${ch.count || 0}</option>`).join("")}</select></label>
<div><div class="meta" style="margin-bottom:4px">Период</div><div class="seg">${Object.entries(PERIODS).map(([h, l]) => `<label><input type="radio" name="period" value="${h}"${checked(Number(h) === hours)}><span>${l}</span></label>`).join("")}</div></div>
<button class="btn primary" name="do" value="stats">📊 Показать статистику</button>
<h3>Gemini</h3>
<label>Язык ответа<select name="lang">${Object.entries(LANGS).map(([k, [n]]) => `<option value="${k}"${sel(k, lang)}>${n}</option>`).join("")}</select></label>
<div class="btns two">
<button class="btn" name="do" value="summary">🤖 Разбор</button>
<button class="btn" name="do" value="ask">❓ Спросить</button>
</div>
<label>Вопрос для «Спросить»<textarea name="question" rows="2" placeholder="Например: что решили про субботу?">${esc(a.question || "")}</textarea></label>
${env.GEMINI_API_KEY ? "" : `<p class="hint bad">Для «Разбора» и «Спросить» добавьте секрет GEMINI_API_KEY. Статистика работает без него.</p>`}
<p class="hint">В группы ничего не отправляется. Переписка уходит в Gemini только по кнопкам 🤖 и ❓.</p>
</form>`;
}

function settingsPanel(st) {
  const { s } = st;
  const intervals = INTERVALS.includes(s.interval) ? INTERVALS : [...INTERVALS, s.interval].sort((x, y) => x - y);
  return `<form method="post" action="/save" class="panel">
<section class="card">
<h2>📊 Экзамен</h2>
<label>Как часто проверять<select name="interval">${intervals.map((m) => `<option value="${m}"${sel(m, s.interval)}>${intervalLabel(m)}</option>`).join("")}</select></label>
<label>Ссылка на результат<input type="url" name="url" value="${esc(s.url)}" autocapitalize="off" spellcheck="false"></label>
<label>Имя в сообщении<input type="text" name="title" value="${esc(s.title)}"></label>
<details><summary>Дополнительно</summary><div class="adv">
<label>Предметы через запятую — точно как на сайте<input type="text" name="subjects" value="${esc(s.subjects)}"></label>
<p class="hint">При смене ссылки или предметов сохранённые баллы сбрасываются, чтобы не пришло ложное «баллы изменились».</p>
</div></details>
</section>

<section class="card">
<h2>🌦 Погода</h2>
<label>Место (как в сообщении)<input type="text" name="place" value="${esc(s.place)}"></label>
<div class="grid2">
<label>Время отправки<select name="send_hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}"${sel(h, s.send_hour)}>${pad(h)}:00</option>`).join("")}</select></label>
<label>На сколько часов<select name="hours">${[6, 12, 18, 24].map((h) => `<option value="${h}"${sel(h, s.hours)}>${h} ч</option>`).join("")}${[6, 12, 18, 24].includes(s.hours) ? "" : `<option value="${s.hours}" selected>${s.hours} ч</option>`}</select></label>
</div>
<input type="hidden" name="clean_enabled" value="off">
<label class="switch">Перед прогнозом удалять вчерашние сообщения бота<input type="checkbox" name="clean_enabled" value="on"${checked(s.clean_enabled)}></label>
<details><summary>Дополнительно</summary><div class="adv grid2">
<label>Широта<input type="text" inputmode="decimal" name="lat" value="${esc(s.lat)}"></label>
<label>Долгота<input type="text" inputmode="decimal" name="lon" value="${esc(s.lon)}"></label>
</div></details>
</section>

<section class="card">
<h2>🤖 Gemini</h2>
<label>Язык ответа по умолчанию<select name="gemini_lang">${Object.entries(LANGS).map(([k, [n]]) => `<option value="${k}"${sel(k, s.gemini_lang)}>${n}</option>`).join("")}</select></label>
<details><summary>Дополнительно</summary><div class="adv">
<label>Модель<input type="text" name="gemini_model" value="${esc(s.gemini_model)}" autocapitalize="off" spellcheck="false"></label>
<p class="hint">gemini-flash-latest — всегда свежая быстрая модель. При перегрузке бот сам переходит на ${GEMINI_FALLBACK}.</p>
</div></details>
</section>

<div class="savebar"><button class="btn primary">💾 Сохранить настройки</button></div>
</form>`;
}

function servicePanel(env, st, origin, result) {
  const { last, lastHook, gState, gSettings, hookWhere, chatList, chats } = st;
  const v = env.CF_VERSION_METADATA;
  const flags = gSettings.v ? ["incomingWebhook", "outgoingWebhook", "outgoingAPIMessageWebhook"].filter((k) => gSettings.v[k] !== "yes") : [];
  const rows = [
    ["Версия бота", v?.id ? `${esc(v.id.slice(0, 8))}${v.timestamp ? ` · ${bakuTime(Date.parse(v.timestamp))}` : ""}` : "неизвестно"],
    ["Секреты", secretsReport(env)],
    ["WhatsApp", gState.v ? (gState.v.stateInstance === "authorized" ? `<span class="ok">подключён</span>` : `<span class="bad">${esc(gState.v.stateInstance)}</span>`) : `<span class="bad">нет ответа</span>`],
    ["Вебхук в Green API", hookWhere === "ours" ? `<span class="ok">настроен</span>` : hookWhere === "other" ? `<span class="bad">другой адрес</span>` : hookWhere === "none" ? `<span class="bad">не задан</span>` : "—"],
    ["Последнее сообщение", lastHook ? `${ago(lastHook.time)} · ${lastHook.ok ? `<span class="ok">сохранено</span>` : `<span class="bad">ошибка</span><br><small>${esc(lastHook.note)}</small>`}` : "ещё не приходило"],
    ["Firebase", !firebaseReady(env) ? `<span class="bad">не настроен</span>` : chats.e ? `<span class="bad">ошибка</span>` : `<span class="ok">работает</span> · ${env.FIREBASE_SECRET ? "секрет базы" : "сервисный аккаунт"}`],
  ];
  if (flags.length) rows.push(["Выключено в Green API", `<span class="bad">${flags.join(", ")}</span>`]);
  const hook = env.WEBHOOK_SECRET ? `${origin}/webhook/${env.WEBHOOK_SECRET}` : null;
  return `${resultCard(result)}
<section class="card">
<h2>Проверка подключений</h2>
<div>${rows.map(([k, val]) => `<div class="row"><span>${k}</span><span>${val}</span></div>`).join("")}</div>
${hook ? `<details><summary>Адрес вебхука</summary><code>${esc(hook)}</code></details>` : ""}
${actionButton("service", "webhook", "🔗 Подключить вебхук в Green API", { confirmText: "Прописать адрес вебхука в Green API? Инстанс может перезапуститься на пару минут." })}
</section>

<section class="card">
<h2>Действия</h2>
<div class="btns">
${actionButton("service", "orders", "⛽ Найти заказы в собранных сообщениях")}
${actionButton("service", "dump", "🔍 Что бот видит на странице экзамена")}
${actionButton("service", "clean", "🧹 Удалить старые сообщения бота", { cls: "danger", confirmText: "Удалить у всех старые сообщения бота в группе?" })}
${actionButton("service", "reset", "↺ Сбросить сохранённые баллы", { cls: "danger", confirmText: "Сбросить сохранённые баллы? Следующая проверка запомнит текущие без сообщения." })}
</div>
</section>

${last ? `<details class="card"><summary>Лог последнего запуска · ${bakuTime(last.time)}</summary><pre>${esc(last.log)}</pre></details>` : ""}
${chatList.length ? `<details class="card"><summary>Собранные чаты (${chatList.length})</summary>${chatList.map((ch) => `<div class="chat"><span>${ch.isGroup ? "👥" : "👤"} ${esc(ch.name || ch.chatId)}<br><small>${esc(ch.chatId)}</small></span><span>${ch.count || 0}<br><small>${ch.lastAt ? bakuTime(ch.lastAt * 1000) : ""}</small></span></div>`).join("")}</details>` : ""}
<p class="hint">Расписание в Cloudflare — <code>* * * * *</code> (каждую минуту); как часто проверять экзамен, задаётся в «Настройках».</p>`;
}

async function dashboard(env, origin, { tab = "home", msg = null, result = null, analysis = null, orders = {} } = {}) {
  const st = await gatherStatus(env, origin);
  const toast = msg ? `<div class="toast${msg.bad ? " bad" : ""}">${esc(msg.text)}</div>` : "";
  return page("MQM watch", `
<div class="top"><h1>MQM watch</h1><a href="/logout">Выйти</a></div>
${toast}
<div class="panel" id="p-home">${homePanel(env, st, tab === "home" ? result : null)}</div>
<div class="panel" id="p-orders">${ordersPanel(env, st, orders)}</div>
<div class="panel" id="p-analysis">${analysisPanel(env, st, analysis)}</div>
<div class="panel" id="p-settings">${settingsPanel(st)}</div>
<div class="panel" id="p-service">${servicePanel(env, st, origin, tab === "service" ? result : null)}</div>`, { tab });
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
  const model = str("gemini_model") || "gemini-flash-latest";
  if (!/^[a-z0-9][a-z0-9.-]{1,60}$/.test(model)) throw new Error("Модель Gemini: только латинские буквы, цифры, точка и дефис, например gemini-flash-latest");
  const lang = str("gemini_lang");

  // включатели бота, экзамена и погоды живут на «Главной» — здесь их не трогаем
  const s = {
    ...old,
    interval: int("interval", MIN_INTERVAL, 1440, "Частота проверки"),
    url,
    title: str("title") || "Asim Qaraxanov",
    subjects,
    place: str("place") || "Pirşağı",
    lat: coord("lat", 90, "Широта"),
    lon: coord("lon", 180, "Долгота"),
    send_hour: int("send_hour", 0, 23, "Время отправки"),
    hours: int("hours", 1, 24, "На сколько часов"),
    clean_enabled: f.getAll("clean_enabled").includes("on"),
    gemini_model: model,
    gemini_lang: LANGS[lang] ? lang : old.gemini_lang,
  };
  await env.MQM_KV.put("settings", JSON.stringify(s));
  const reset = s.url !== old.url || s.subjects !== old.subjects;
  if (reset) await env.MQM_KV.delete("state");
  return reset ? "Сохранено. Ссылка или предметы изменились — сохранённые баллы сброшены." : "Настройки сохранены.";
}

const TOGGLES = {
  enabled: ["Бот включён", "Бот выключен"],
  exam_enabled: ["Слежение за баллами включено", "Слежение за баллами выключено"],
  weather_enabled: ["Утренний прогноз включён", "Утренний прогноз выключен"],
};

async function toggleSetting(request, env) {
  const f = await request.formData();
  const key = String(f.get("key") || "");
  if (!TOGGLES[key]) throw new Error("Неизвестный переключатель");
  const on = f.getAll("v").includes("on");
  await env.MQM_KV.put("settings", JSON.stringify({ ...(await loadSettings(env)), [key]: on }));
  return TOGGLES[key][on ? 0 : 1];
}

const ACTION_SUMMARY = {
  exam: "баллы проверены",
  test: "тестовое сообщение отправлено в группу",
  weather: "прогноз отправлен в группу",
  dump: "ниже текст страницы экзамена и что из него понял бот",
  clean: "старые сообщения бота удалены",
};

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
      return { ok: true, summary: "адрес прописан, Green API может пару минут перезапускаться", log: await connectWebhook(env, origin) };
    } catch (e) {
      return { ok: false, summary: e.message };
    }
  }
  if (action === "orders") {
    try {
      const n = await backfillOrders(env);
      return { ok: true, summary: n ? `найдено и сохранено заказов: ${n} — см. вкладку «Заказы»` : "заказов в собранных сообщениях не нашлось" };
    } catch (e) {
      return { ok: false, summary: e.message };
    }
  }
  if (action === "reset") {
    await env.MQM_KV.delete("state");
    return { ok: true, summary: "сохранённые баллы сброшены; следующая проверка запомнит текущие без сообщения" };
  }
  if (!opts) return { ok: false, summary: "неизвестное действие" };
  const res = await run(env, s, { ...base, ...opts }, "вручную");
  return { ...res, summary: res.ok ? ACTION_SUMMARY[action] : "см. подробности", open: action === "dump" || !res.ok };
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

  async fetch(request, env, ctx) {
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
      if (!env.WEBHOOK_SECRET || path !== `/webhook/${env.WEBHOOK_SECRET}`) {
        ctx.waitUntil(noteWebhook(env, false, "пришёл на адрес с другим секретом — нажмите «Подключить вебхук в Green API»"));
        return new Response("Not found", { status: 404 });
      }
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
        ctx.waitUntil(noteWebhook(env, false, e.message));
        return new Response("Error", { status: 500 }); // Green API пришлёт уведомление повторно
      }
      ctx.waitUntil(noteWebhook(env, true, body.typeWebhook || "уведомление"));
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

    if (!["/", "/save", "/toggle", "/action", "/analyze"].includes(path)) return new Response("Not found", { status: 404 });
    if (!(await isAuthed(request, env))) return loginPage();
    const back = (tab, text, bad = false) => new Response(null, {
      status: 303,
      headers: { Location: `/?msg=${encodeURIComponent(text)}${bad ? "&bad=1" : ""}#${tab}` },
    });

    if (path === "/save" && request.method === "POST") {
      try {
        return back("settings", await saveSettings(request, env));
      } catch (e) {
        return dashboard(env, url.origin, { tab: "settings", msg: { text: `Не сохранено: ${e.message}`, bad: true } });
      }
    }

    if (path === "/toggle" && request.method === "POST") {
      try {
        return back("home", await toggleSetting(request, env));
      } catch (e) {
        return back("home", e.message, true);
      }
    }

    if (path === "/analyze" && request.method === "POST") {
      const form = await request.formData();
      let res;
      try {
        res = await analyze(env, form);
      } catch (e) {
        res = {
          a: { chat: String(form.get("chat") || ""), hours: Number(form.get("period")) || 24, question: String(form.get("question") || ""), lang: String(form.get("lang") || "") },
          ok: false,
          html: `<p>${esc(e.message)}</p>`,
        };
      }
      return dashboard(env, url.origin, { tab: "analysis", analysis: res });
    }

    if (path === "/action" && request.method === "POST") {
      const form = await request.formData();
      const tab = TABS.includes(String(form.get("tab"))) ? String(form.get("tab")) : "home";
      return dashboard(env, url.origin, { tab, result: await doAction(env, String(form.get("do") || ""), url.origin) });
    }

    const text = url.searchParams.get("msg");
    const q = url.searchParams;
    return dashboard(env, url.origin, {
      tab: TABS.includes(q.get("tab")) ? q.get("tab") : "home",
      msg: text ? { text, bad: q.get("bad") === "1" } : null,
      orders: { date: q.get("date"), span: q.get("span") },
    });
  },
};
