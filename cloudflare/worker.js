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
//   TUYA_ACCESS_ID / TUYA_ACCESS_SECRET - (необязательно) ключи Cloud Project Tuya для реле (secret)
//
// Тревоги камер: POST или GET на /camera/<ключ> (адрес показан на вкладке «Дом»).
//
// Cron Trigger в Cloudflare: "* * * * *" — воркер просыпается каждую минуту,
// а как часто проверять экзамен, решает настройка на странице.
//
// Запуск ссылкой: /run?key=RUN_KEY&exam=1&weather=1&test=0&dump=0

const DEFAULT_URL = "https://kabinet.mqm.az/result/1505867/e40b3558-d105-4cc5-8752-594581ee467a";
const DEFAULT_SUBJECTS = ["İngilis dili", "Azərbaycan dili", "Riyaziyyat"];
const COUNTERS = {
  correct: /Doğru cavabların sayı:\s*(\d+)/,
  wrong: /Yanlış cavabların sayı:\s*(\d+)/,
  unverified: /Qiymətləndirilməyib:\s*(\d+)/, // открытые вопросы на проверке
};

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
    gemini_model: "gemini-flash-latest",
    gemini_lang: "ru",
    tuya_region: "eu",
    tuya_devices: [],
    tuya_wa: false,
    tuya_wa_numbers: "",
    tuya_wa_reply: true,
    camera_forward: false,
    camera_chat: "",
    camera_cooldown: 5,
    cal_enabled: false,
    cal_urls: "",
    cal_holidays: "",
    cal_hour: 8,
    cal_tomorrow: true,
    sched_enabled: false,
    sched_before: 0,
    sched_chat: "",
    photo_enabled: false,
    photo_time: "09:00",
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
  if (res.status === 466 || raw.includes("QUOTE_EXCEEDED")) {
    // лимит тарифа Green API исчерпан
    const e = new Error("Лимит Green API на этом тарифе исчерпан");
    e.quota = true;
    throw e;
  }
  if (!res.ok) throw new Error(`Green API ${method} ${res.status}: ${raw}`);
  return raw ? JSON.parse(raw) : null;
}

// ---------------- Журнал обрывов связи с Green API ----------------
// Раз в CONN_CHECK_EVERY минут спрашиваем getStateInstance. В KV пишем только при смене состояния
// (лимит бесплатного плана — 1000 записей в сутки), поэтому журнал почти ничего не стоит.
// conn_state — текущее состояние; conn_log — последние 200 переходов {time, from, to, downMs?}.
const CONN_CHECK_EVERY = 5;
const CONN_LOG_MAX = 200;

async function readConnState(c) {
  for (let i = 0; i < 2; i++) { // одна повторная попытка, чтобы случайный сбой сети не считался обрывом
    try {
      const r = await apiCall(c, "getStateInstance");
      return r?.stateInstance || "unknown";
    } catch (e) {
      if (i === 1) return "нет ответа: " + String(e.message).slice(0, 80);
    }
  }
}

async function checkConnection(env, s) {
  const c = config(env, s);
  if (!c.kv || !(c.id && c.token)) return;
  const state = await readConnState(c);
  const ok = state === "authorized";
  const prev = await c.kv.get("conn_state", "json");
  const prevOk = prev ? prev.state === "authorized" : null;
  if (prev && prev.state === state) return; // ничего не изменилось — не пишем
  const now = Date.now();
  const log = (await c.kv.get("conn_log", "json")) || [];
  const entry = { time: now, from: prev ? prev.state : null, to: state };
  if (ok && prevOk === false && prev.downSince) entry.downMs = now - prev.downSince; // сколько длился обрыв
  log.push(entry);
  await c.kv.put("conn_log", JSON.stringify(log.slice(-CONN_LOG_MAX)));
  await c.kv.put("conn_state", JSON.stringify({
    state, time: now,
    downSince: ok ? null : (prevOk === false && prev.downSince ? prev.downSince : now),
  }));
}

// Сводка для страницы: сколько обрывов и сколько простоя за последние days суток.
function connStats(log, days = 7) {
  const since = Date.now() - days * 86400000;
  const recent = (log || []).filter((e) => e.time >= since);
  const drops = recent.filter((e) => e.to !== "authorized" && e.from === "authorized");
  const downMs = recent.reduce((a, e) => a + (e.downMs || 0), 0);
  const last = drops.length ? drops[drops.length - 1] : null;
  return { drops: drops.length, downMs, last, recent };
}

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + " мин";
  return Math.floor(m / 60) + " ч " + (m % 60) + " мин";
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

// Раз в сутки после часа отправки (по Баку): прогноз.
// force=true — «прогноз сейчас»: дата отправки не пишется.
async function dailyWeather(c, force) {
  const now = bakuNow();
  const today = ymd(now);
  const last = await c.kv.get("weather_date");
  if (!force && (now.getUTCHours() < c.s.send_hour || last === today)) {
    c.log(last === today ? "Погода: сегодня уже отправлена" : `Погода: ещё рано (шлём после ${c.s.send_hour}:00 по Баку)`);
    return;
  }
  if (!force) {
    const retryAt = Number(await c.kv.get("weather_retry_at")) || 0;
    if (Date.now() < retryAt) {
      c.log(`Погода: прошлая попытка не удалась, следующая в ${hm(new Date(retryAt + BAKU_OFFSET_MS))}`);
      return;
    }
  }
  c.acted = true;
  try {
    await sendForecast(c, force, now, today);
  } catch (e) {
    // без паузы бот пробовал бы каждую минуту: лишние запросы и расход лимита записей KV
    if (!force) await c.kv.put("weather_retry_at", String(Date.now() + 15 * 60000), { expirationTtl: 3600 });
    throw e;
  }
}

async function sendForecast(c, force, now, today) {
  const tomorrow = ymd(addHours(now, 24));
  await send(c, fmtWeather(c, await fetchWeather(c, today, tomorrow), now));
  if (!force) await c.kv.put("weather_date", today);
}

// ---------------- Календарь: дни рождения и праздники ----------------
// Источники — ссылки iCal: секретный адрес своего календаря Google и публичный календарь праздников.
// Берём только события «на весь день», чтобы встречи со временем не попали в группу.

const HOLIDAY_LANGS = { az: "Azərbaycanca", ru: "Русский", en: "English" };
const holidayUrl = (lang) => `https://calendar.google.com/calendar/ical/${lang}.az%23holiday%40group.v.calendar.google.com/public/basic.ics`;
const AZ_MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avqust", "sentyabr", "oktyabr", "noyabr", "dekabr"];
const BIRTHDAY_RE = /ad g[üu]n|do[ğg]um g[üu]n|birthday|день рожд/i;

function calendarSources(s) {
  const own = String(s.cal_urls || "").split(/\s+/).filter(Boolean).map((u) => ({ url: u.replace(/^webcal:\/\//i, "https://"), holiday: false }));
  return s.cal_holidays && HOLIDAY_LANGS[s.cal_holidays] ? [...own, { url: holidayUrl(s.cal_holidays), holiday: true }] : own;
}

const icsText = (v) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") ev = {};
    else if (line === "END:VEVENT") { if (ev) events.push(ev); ev = null; }
    else if (ev) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const [name, ...params] = line.slice(0, i).split(";");
      const value = line.slice(i + 1).trim();
      if (name === "SUMMARY") ev.summary = icsText(value);
      else if (name === "UID") ev.uid = value;
      else if (name === "STATUS") ev.status = value;
      else if (name === "DTSTART") { ev.allDay = params.includes("VALUE=DATE") || /^\d{8}$/.test(value); ev.start = value.slice(0, 8); }
      else if (name === "DTEND") ev.end = value.slice(0, 8);
      else if (name === "RRULE") ev.rrule = Object.fromEntries(value.split(";").map((x) => x.split("=")));
      else if (name === "EXDATE") (ev.exdates ||= []).push(...value.split(",").map((x) => x.slice(0, 8)));
      else if (name === "RECURRENCE-ID") ev.recurrenceId = value.slice(0, 8);
    }
  }
  return events;
}

// day — "YYYYMMDD" по Баку. Поддержаны разовые (в т.ч. многодневные), ежегодные и ежемесячные события.
function eventsOn(events, day) {
  const moved = new Set(events.filter((e) => e.recurrenceId).map((e) => `${e.uid}|${e.recurrenceId}`));
  return events.filter((e) => {
    if (!e.allDay || !e.start || e.status === "CANCELLED" || e.exdates?.includes(day)) return false;
    const r = e.rrule;
    if (!r || e.recurrenceId) return day === e.start || (e.end && day > e.start && day < e.end);
    if (day < e.start || moved.has(`${e.uid}|${day}`)) return false;
    if (r.UNTIL && day > r.UNTIL.slice(0, 8)) return false;
    const step = Number(r.INTERVAL || 1);
    const years = Number(day.slice(0, 4)) - Number(e.start.slice(0, 4));
    if (r.FREQ === "YEARLY") return day.slice(4) === e.start.slice(4) && years % step === 0;
    if (r.FREQ === "MONTHLY") return day.slice(6) === e.start.slice(6) && (years * 12 + Number(day.slice(4, 6)) - Number(e.start.slice(4, 6))) % step === 0;
    return false;
  });
}

async function calendarMessage(c, now) {
  const today = ymd(now).replace(/-/g, "");
  const tomorrow = ymd(addHours(now, 24)).replace(/-/g, "");
  const pick = { today: [], tomorrow: [] };
  const errors = [];
  for (const src of calendarSources(c.s)) {
    try {
      const res = await fetch(src.url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`ответ ${res.status}`);
      const events = parseIcs(await res.text());
      const line = (e) => `${src.holiday ? "🎉" : BIRTHDAY_RE.test(e.summary || "") ? "🎂" : "📌"} ${e.summary || "(без названия)"}`;
      pick.today.push(...eventsOn(events, today).map(line));
      if (c.s.cal_tomorrow) pick.tomorrow.push(...eventsOn(events, tomorrow).map(line));
    } catch (e) {
      errors.push(`${new URL(src.url).host}: ${e.message}`);
    }
  }
  const uniq = (a) => [...new Set(a)];
  const todayList = uniq(pick.today), tomorrowList = uniq(pick.tomorrow).filter((x) => !todayList.includes(x));
  if (errors.length && !todayList.length && !tomorrowList.length) throw new Error(`Календарь не открылся: ${errors.join("; ")}`);
  errors.forEach((e) => c.log("Календарь:", e));
  if (!todayList.length && !tomorrowList.length) return null;
  const lines = [`📅 ${now.getUTCDate()} ${AZ_MONTHS[now.getUTCMonth()]}, ${WEEKDAYS[(now.getUTCDay() + 6) % 7]}`];
  if (todayList.length) lines.push(...todayList);
  if (tomorrowList.length) lines.push("", "Sabah:", ...tomorrowList);
  return lines.join("\n");
}

// Раз в день после часа отправки (по Баку). force — «отправить сейчас»: без учёта часа и даты.
async function dailyCalendar(c, force) {
  const now = bakuNow();
  const today = ymd(now);
  if (!force) {
    if (now.getUTCHours() < c.s.cal_hour || (await c.kv.get("cal_date")) === today) return;
    if (Date.now() < (Number(await c.kv.get("cal_retry_at")) || 0)) return;
  }
  c.acted = true;
  try {
    const msg = await calendarMessage(c, now);
    if (msg) await send(c, msg);
    else c.log("Календарь: сегодня и завтра событий нет — ничего не отправлено");
    if (!force) await c.kv.put("cal_date", today);
  } catch (e) {
    if (!force) await c.kv.put("cal_retry_at", String(Date.now() + 30 * 60000), { expirationTtl: 7200 });
    throw e;
  }
}

// ---------------- Расписание уроков ----------------
// Уроки лежат в Firebase (/schedule/lessons/<id>), копия — в KV ("lessons_cache"), чтобы минутный cron не ходил в базу.
// В начале урока (или за N минут) бот пишет в группу.

const LESSON_DAYS = [[1, "Понедельник"], [2, "Вторник"], [3, "Среда"], [4, "Четверг"], [5, "Пятница"], [6, "Суббота"], [0, "Воскресенье"]];
const LESSON_BEFORE = [0, 5, 10, 15, 30];
const LESSON_DURATIONS = [30, 40, 45, 50, 60, 75, 90, 120];
const LESSON_WINDOW_MIN = 5; // сколько минут после срока ещё можно отправить (если cron пропустил минуту)

// Расписание из приложения расписания (shared.data): день 1 — понедельник … 6 — суббота, 0 — воскресенье.
const LESSON_SEED = [
  ["l1", 1, "08:00", "Cəbr (Riyaziyyat)"], ["l2", 1, "13:30", "İngilis dili"], ["l14", 1, "19:00", "Əlavə İnglis(online)"],
  ["l3", 2, "09:00", "Fizika"], ["l4", 2, "17:00", "Azərbaycan dili"],
  ["l5", 3, "08:00", "Riyaziyyat"], ["l6", 3, "16:00", "İnformatika"], ["l15", 3, "19:00", "Əlavə İnglis(online)"],
  ["l7", 4, "08:00", "Riyaziyyat"], ["l8", 4, "10:30", "Fizika"], ["l9", 4, "13:30", "İngilis dili"], ["l10", 4, "17:00", "Azərbaycan dili"],
  ["l16", 5, "19:00", "Əlavə İnglis(online)"],
  ["l11", 6, "09:00", "İnformatika"], ["l12", 6, "14:30", "Fizika"], ["l13", 6, "17:00", "Azərbaycan dili"],
].map(([id, day, time, subject]) => ({ id, day, time, duration: 60, subject }));

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const lessonEnd = (l) => {
  const e = toMin(l.time) + l.duration;
  return `${pad(Math.floor(e / 60) % 24)}:${pad(e % 60)}`;
};

function lessonList(obj) {
  return Object.entries(obj || {})
    .map(([id, r]) => ({ id, day: Number(r?.day), time: String(r?.time || ""), duration: Number(r?.duration) || 60, subject: String(r?.subject || "") }))
    .filter((l) => Number.isInteger(l.day) && l.day >= 0 && l.day <= 6 && TIME_RE.test(l.time) && l.subject)
    .sort((a, b) => a.time.localeCompare(b.time));
}

const lessonsCacheGet = async (env) => (await env.MQM_KV.get("lessons_cache", "json")) || [];

async function lessonsRefreshCache(env) {
  const list = lessonList(await firebase(env, "GET", "/schedule/lessons"));
  await env.MQM_KV.put("lessons_cache", JSON.stringify(list));
  return list;
}

const lessonMessage = (l, before) =>
  `${before ? `📚 ${before} dəq sonra dərs: ${l.subject}` : `📚 Dərs başlayır: ${l.subject}`}\n🕒 ${l.time}–${lessonEnd(l)}`;

async function runLessons(env, s, now = Date.now()) {
  if (!s.sched_enabled) return;
  const d = new Date(now + BAKU_OFFSET_MS);
  const day = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const today = ymd(d);
  const before = s.sched_before || 0;
  for (const l of await lessonsCacheGet(env)) {
    if (l.day !== day) continue;
    const target = toMin(l.time) - before;
    if (mins < target || mins >= target + LESSON_WINDOW_MIN) continue;
    const key = `lesson_${today}_${fbKey(l.id)}`;
    if (await env.MQM_KV.get(key)) continue;
    try {
      await sendTo(env, s, s.sched_chat || null, lessonMessage(l, before));
      await env.MQM_KV.put(key, "1", { expirationTtl: 172800 });
      await env.MQM_KV.put("lesson_last", JSON.stringify({ time: now, ok: true, text: `${l.time} ${l.subject}` }));
    } catch (e) {
      await env.MQM_KV.put("lesson_last", JSON.stringify({ time: now, ok: false, text: `${l.time} ${l.subject}: ${e.message.slice(0, 120)}` }));
    }
  }
}

function lessonFields(time, subject, duration) {
  if (!TIME_RE.test(time)) throw new Error("Время урока — в формате 08:30");
  if (!subject || subject.length > 60) throw new Error("Название урока: от 1 до 60 символов");
  const dur = Number(duration);
  if (!Number.isInteger(dur) || dur < 5 || dur > 300) throw new Error("Длительность урока: от 5 до 300 минут");
  return { time, subject, duration: dur };
}

async function lessonsAction(env, form) {
  if (!firebaseReady(env)) throw new Error("Расписание хранится в Firebase — он не настроен");
  const str = (k) => String(form.get(k) ?? "").trim();
  const action = str("do");

  if (action === "seed") {
    const obj = Object.fromEntries(LESSON_SEED.map((l) => [l.id, { day: l.day, time: l.time, duration: l.duration, subject: l.subject }]));
    await firebase(env, "PUT", "/schedule/lessons", obj);
    return `Расписание загружено: ${(await lessonsRefreshCache(env)).length} уроков`;
  }

  if (action === "day_save") {
    const day = Number(str("day"));
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error("Неверный день недели");
    const current = lessonList(await firebase(env, "GET", "/schedule/lessons")).filter((l) => l.day === day);
    const updates = {};
    let removed = 0, changed = 0, added = 0;
    for (const l of current) {
      if (form.get(`x_${l.id}`) === "on") { updates[l.id] = null; removed++; continue; }
      if (!form.has(`t_${l.id}`)) continue;
      const rec = lessonFields(str(`t_${l.id}`), str(`s_${l.id}`), str(`d_${l.id}`));
      if (rec.time !== l.time || rec.subject !== l.subject || rec.duration !== l.duration) { updates[l.id] = { day, ...rec }; changed++; }
    }
    if (str("new_time") || str("new_subject")) {
      const id = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      updates[id] = { day, ...lessonFields(str("new_time"), str("new_subject"), str("new_dur") || "60") };
      added++;
    }
    if (!Object.keys(updates).length) return "Изменений нет";
    await firebase(env, "PATCH", "/schedule/lessons", updates);
    await lessonsRefreshCache(env);
    return `Сохранено: изменено ${changed}, добавлено ${added}, удалено ${removed}`;
  }

  if (action === "settings_save") {
    const before = Number(str("sched_before"));
    if (!LESSON_BEFORE.includes(before)) throw new Error("Неверное время предупреждения");
    const chat = str("sched_chat");
    if (chat && !/^[\w.-]+@(g|c)\.us$/.test(chat)) throw new Error("Неверный чат");
    await env.MQM_KV.put("settings", JSON.stringify({ ...(await loadSettings(env)), sched_before: before, sched_chat: chat }));
    return "Настройки уроков сохранены";
  }
  throw new Error("Неизвестное действие");
}

// ---------------- Расписание уроков: страница ----------------

function nextLessonText(list, now = Date.now()) {
  const d = new Date(now + BAKU_OFFSET_MS);
  const day = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (let i = 0; i < 7; i++) {
    const dd = (day + i) % 7;
    const l = list.filter((x) => x.day === dd && (i > 0 || toMin(x.time) > mins)).sort((a, b) => a.time.localeCompare(b.time))[0];
    if (l) return `${i === 0 ? "сегодня" : i === 1 ? "завтра" : LESSON_DAYS.find(([n]) => n === dd)[1].toLowerCase()} ${l.time} — ${l.subject}`;
  }
  return null;
}

function lessonsCard(st) {
  const { s, lessons } = st;
  const day = bakuNow().getUTCDay();
  const today = lessons.filter((l) => l.day === day);
  const next = nextLessonText(lessons);
  return `<section class="card">
<h2>📚 Уроки</h2>
${toggleForm("sched_enabled", s.sched_enabled, "Сообщение в группу, когда начинается урок", "lessons")}
${lessons.length
    ? `<p class="meta">Сегодня: ${today.length ? today.map((l) => `${l.time} ${esc(l.subject)}`).join(" · ") : "уроков нет"}</p>
${next ? `<p class="meta">Ближайший: ${esc(next)}</p>` : ""}`
    : `<p class="meta">Расписания ещё нет — загрузите его на вкладке «Уроки».</p>`}
<a class="btn" href="#lessons">📚 Расписание</a>
</section>`;
}

function lessonsPanel(env, st, openDay = null) {
  const { s, lessons, lessonsErr, lessonLast } = st;
  const durOptions = (cur) => [...new Set([...LESSON_DURATIONS, cur])].sort((a, b) => a - b).map((m) => `<option value="${m}"${sel(m, cur)}>${m} мин</option>`).join("");
  const chats = st.chatList.map((ch) => `<option value="${esc(ch.chatId)}"${sel(ch.chatId, s.sched_chat)}>${ch.isGroup ? "👥" : "👤"} ${esc(ch.name || ch.chatId)}</option>`).join("");
  const sample = lessons[0] || { time: "13:30", duration: 60, subject: "İngilis dili" };

  const head = `${subnav("lessons")}
<section class="card">
<h2>📚 Уроки</h2>
${toggleForm("sched_enabled", s.sched_enabled, "Сообщение в группу, когда начинается урок", "lessons")}
<form method="post" action="/lessons" class="adv">
<input type="hidden" name="do" value="settings_save">
<div class="grid2">
<label>Когда писать<select name="sched_before">${LESSON_BEFORE.map((m) => `<option value="${m}"${sel(m, s.sched_before)}>${m ? `за ${m} мин` : "в начале"}</option>`).join("")}</select></label>
<label>Куда<select name="sched_chat"><option value=""${sel("", s.sched_chat)}>Основная группа</option>${chats}</select></label>
</div>
<button class="btn">💾 Сохранить</button>
</form>
<p class="hint">Так выглядит сообщение:<br><code>${esc(lessonMessage(sample, s.sched_before || 0)).replace(/\n/g, "<br>")}</code></p>
<p class="hint">${lessonLast ? `Последнее сообщение: ${ago(lessonLast.time)} · ${lessonLast.ok ? `<span class="ok">отправлено</span>` : `<span class="bad">ошибка</span>`} (${esc(lessonLast.text)})` : ""}</p>
${lessonsErr ? `<p class="bad">Firebase: ${esc(lessonsErr)} — показана копия расписания.</p>` : ""}
</section>`;

  if (!firebaseReady(env)) return head + `<section class="card"><p class="meta">Расписание хранится в Firebase — он не настроен (см. «Сервис»).</p></section>`;

  const openNum = openDay != null && openDay !== "" && Number.isInteger(Number(openDay)) ? Number(openDay) : bakuNow().getUTCDay();
  const days = LESSON_DAYS.map(([n, name]) => {
    const items = lessons.filter((l) => l.day === n);
    const rows = items.map((l) => `<div class="lrow">
<div class="l1"><input type="time" name="t_${esc(l.id)}" value="${l.time}" required aria-label="Начало урока"><input type="text" name="s_${esc(l.id)}" value="${esc(l.subject)}" maxlength="60" required aria-label="Предмет"></div>
<div class="l2"><select name="d_${esc(l.id)}" aria-label="Длительность">${durOptions(l.duration)}</select><label class="del"><input type="checkbox" name="x_${esc(l.id)}"> Удалить</label></div>
</div>`).join("");
    return `<details class="card day"${n === openNum ? " open" : ""}>
<summary><b>${name}</b> <span class="meta">${items.length ? `${items.length} ур. · ${items.map((l) => l.time).join(" ")}` : "нет уроков"}</span></summary>
<form method="post" action="/lessons" class="adv">
<input type="hidden" name="do" value="day_save"><input type="hidden" name="day" value="${n}">
${rows}
<div class="lrow add"><div class="meta">＋ Добавить урок</div>
<div class="l1"><input type="time" name="new_time" aria-label="Начало нового урока"><input type="text" name="new_subject" maxlength="60" placeholder="Предмет, например Fizika" aria-label="Предмет нового урока"></div>
<div class="l2"><select name="new_dur" aria-label="Длительность">${durOptions(60)}</select></div></div>
<button class="btn">💾 Сохранить день</button>
</form>
</details>`;
  }).join("");

  const seed = `<section class="card">
<h2>Загрузить расписание</h2>
<p class="meta">Расписание из вашего приложения: понедельник — суббота, 16 уроков, воскресенье свободно. ${lessons.length ? "Загрузка заменит всё, что есть сейчас." : ""}</p>
${actionButtonPost("/lessons", "seed", "⬇️ Загрузить расписание из файла", lessons.length ? "Заменить текущее расписание на расписание из файла?" : "")}
</section>`;

  return head + (lessons.length ? days + seed : seed + days);
}

function actionButtonPost(action, value, label, confirmText = "") {
  return `<form method="post" action="${action}"><button class="btn" name="do" value="${value}"${confirmText ? ` data-confirm="${esc(confirmText)}"` : ""}>${label}</button></form>`;
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
  else {
    if (opts.exam) steps.push(["Экзамен", () => checkResults(c, opts)]);
    if (opts.weather) steps.push(["Погода", () => dailyWeather(c, opts.test)]);
    if (opts.calendar) steps.push(["Календарь", () => dailyCalendar(c, opts.test)]);
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
  for (const [key, rec] of Object.entries(orderChanges(body.idMessage, body.messageData, body.timestamp, sd.chatId, sd.chatName, sd.senderName || sd.senderContactName))) {
    update[`orders/${key}`] = rec;
  }
  await firebase(env, "PATCH", "/", update);
  return true;
}

// ---------------- Заказы топлива ----------------
// «03-i saylı YDS / Ai92 - 18500 / Ai95 - 15000 / N/r: Nağı 055 793 93 30»:
// номер АЗС, литры по видам топлива, кто принимает. Топливо приходит ночью.

const FUEL_ORDER = ["Ai92", "Ai95", "Ai98", "Dizel"];
const NIGHT_START_HOUR = 6; // заказ с 06:00 до 06:00 следующего дня — на ночь этого дня

const STATION_RE = /(\d{1,3})[ \t]*-?[ \t]*[a-zəıiöüşçğ]*[ \t]*say[ıi]?l[ıi][ \t]*YDS|YDS[ \t]*(?:№|N|#|-)?[ \t]*(\d{1,3})/giu;

// Одно сообщение может содержать заказы на несколько АЗС — каждый блок начинается с «NN saylı YDS».
function parseFuelOrders(text) {
  if (!text) return [];
  const heads = [...text.matchAll(STATION_RE)];
  return heads.map((h, i) => {
    const block = heads.length === 1 ? text : text.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : text.length);
    const fuels = {};
    for (const m of block.matchAll(/^[ \t]*(?:ai[ \t]*-?[ \t]*(\d{2,3})|(dizel|diesel|dt))[ \t]*[-–—:=][ \t]*(\d[\d .,]*)/gimu)) {
      const name = m[1] ? `Ai${m[1]}` : "Dizel";
      const liters = Number(m[3].replace(/\D/g, ""));
      if (liters > 0) fuels[name] = (fuels[name] || 0) + liters;
    }
    const r = block.match(/N[ \t]*\/[ \t]*r[ \t]*[:.\-]?[ \t]*(.+)$/im);
    let receiver = null, phone = null;
    if (r) {
      const ph = r[1].match(/(?:\+?994|0)[ \t]*\(?\d{2}\)?[ \t-]*\d{3}[ \t-]*\d{2}[ \t-]*\d{2}/);
      phone = ph ? ph[0].trim() : null;
      receiver = (ph ? r[1].replace(ph[0], "") : r[1]).replace(/[\s,;:–-]+$/, "").trim() || null;
    }
    return { station: Number(h[1] || h[2]), fuels, receiver, phone };
  }).filter((o) => Object.keys(o.fuels).length);
}

// Какие записи orders/<ключ> поменять из-за сообщения: новое — добавить, правка — заменить
// заказы исходного сообщения, удаление у всех — убрать их (так заказ и отменяют).
const ORDER_SLOTS = 5;
function orderChanges(idMessage, md, timestamp, chatId, chatName, senderName) {
  const out = {};
  if (!md || !idMessage) return out;
  const clear = (base) => { for (let i = 0; i < ORDER_SLOTS; i++) out[fbKey(i ? `${base}_${i}` : base)] = null; };
  if (md.typeMessage === "deletedMessage") {
    if (md.deletedMessageData?.stanzaId) clear(md.deletedMessageData.stanzaId);
    return out;
  }
  const base = md.typeMessage === "editedMessage" && md.editedMessageData?.stanzaId ? md.editedMessageData.stanzaId : idMessage;
  const orders = timestamp ? parseFuelOrders(messageText(md)) : [];
  if (md.typeMessage === "editedMessage") clear(base);
  orders.slice(0, ORDER_SLOTS).forEach((o, i) => {
    out[fbKey(i ? `${base}_${i}` : base)] = orderRecord(o, timestamp, chatId, chatName, senderName);
  });
  return out;
}

const nightOf = (ts) => ymd(new Date(ts * 1000 + BAKU_OFFSET_MS - NIGHT_START_HOUR * 3600000));

function orderRecord(order, timestamp, chatId, chatName, senderName) {
  return { ...order, timestamp, night: nightOf(timestamp), chatId, chatName: chatName || null, senderName: senderName || null };
}

// Разовый поиск заказов в уже собранных сообщениях.
async function backfillOrders(env) {
  const [messages, chats] = await Promise.all([firebase(env, "GET", "/messages"), firebase(env, "GET", "/chats")]);
  const all = [];
  for (const [chatKey, list] of Object.entries(messages || {})) {
    const chat = (chats || {})[chatKey] || {};
    for (const [id, m] of Object.entries(list || {})) if (m) all.push({ id, m, chat, chatKey });
  }
  all.sort((a, b) => (a.m.timestamp || 0) - (b.m.timestamp || 0)); // правки и удаления — после исходных сообщений
  const changes = {};
  for (const { id, m, chat, chatKey } of all) {
    Object.assign(changes, orderChanges(id, m.data || { typeMessage: m.type, textMessageData: { textMessage: m.text } }, m.timestamp, chat.chatId || chatKey, chat.name, m.senderName));
  }
  const update = Object.fromEntries(Object.entries(changes).map(([k, v]) => [`orders/${k}`, v]));
  if (Object.keys(update).length) await firebase(env, "PATCH", "/", update);
  return Object.values(changes).filter(Boolean).length;
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
async function noteWebhook(env, ok, note, weak = false) {
  if (!env.MQM_KV) return;
  const prev = await env.MQM_KV.get("last_webhook", "json");
  if (prev && prev.ok === ok && Date.now() - prev.time < 10 * 60000) return;
  if (weak && prev && Date.now() - prev.time < 60 * 60000) return; // случайные запросы на чужой адрес — не чаще раза в час
  await env.MQM_KV.put("last_webhook", JSON.stringify({ time: Date.now(), ok, note: String(note).slice(0, 300) }));
}

// Последнее уведомление Green API как пришло — для диагностики команд (без значений секретов).
async function noteRawHook(env, body) {
  if (!env.MQM_KV || !MESSAGE_WEBHOOKS[body.typeWebhook]) return; // статусы доставки не перекрывают сообщения
  const md = body.messageData || {};
  const text = messageText(md);
  await env.MQM_KV.put("last_hook_raw", JSON.stringify({
    time: Date.now(),
    type: body.typeWebhook || "?",
    from: phoneDigits(String(body.senderData?.sender || "").replace(/@.*/, "")) || "?",
    chat: String(body.senderData?.chatId || "").slice(0, 25),
    msgType: md.typeMessage || "?",
    text: text == null ? null : String(text).slice(0, 60),
  }));
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

function transcript(list, multi = false) {
  // без сообщений бота и команд реле («!nasos aç») — для разбора это шум
  const lines = list.filter((m) => m.direction !== "outgoing_api" && !/^\s*!/.test(m.text || "")).map((m) => {
    const t = new Date(m.timestamp * 1000 + BAKU_OFFSET_MS);
    const kind = TYPE_NAMES[m.type];
    const text = (m.text || "").replace(/\s+/g, " ").trim();
    const body = kind === "текст" || kind === "ответ" ? text : `<${kind || m.type || "сообщение"}${text ? ": " + text : ""}>`;
    return `[${dm(t)} ${hm(t)}] ${multi ? `(${m.chatName}) ` : ""}${who(m)}: ${body}`;
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

const MAX_ANALYZE_CHATS = 20;

async function analyze(env, form) {
  const s = await loadSettings(env);
  const a = {
    chats: [...new Set(form.getAll("chat").map(String).filter(Boolean))].slice(0, MAX_ANALYZE_CHATS),
    hours: Number(form.get("period")) in PERIODS ? Number(form.get("period")) : 24,
    question: String(form.get("question") || "").trim().slice(0, 1000),
    action: String(form.get("do") || "stats"),
    lang: LANGS[String(form.get("lang"))] ? String(form.get("lang")) : s.gemini_lang,
  };
  if (!a.chats.length) return { a, ok: false, html: "<p>Отметьте хотя бы один чат.</p>" };
  const chats = (await firebase(env, "GET", "/chats")) || {};
  const nameOf = (id) => chats[fbKey(id)]?.name || id;
  const since = Math.floor(Date.now() / 1000) - a.hours * 3600;
  const loaded = await Promise.all(a.chats.map((id) => loadMessages(env, id, since)));
  const list = loaded.flatMap(({ list: l }, i) => l.map((m) => ({ ...m, chatName: nameOf(a.chats[i]) })))
    .sort((x, y) => x.timestamp - y.timestamp);
  const multi = a.chats.length > 1;
  const names = a.chats.map(nameOf);
  const title = multi ? `${a.chats.length} чата(ов)` : names[0];
  const head = `<h2>${esc(title)} <span class="meta">за ${PERIODS[a.hours]}</span></h2>`
    + (multi ? `<p class="hint">${names.map(esc).join(" · ")}</p>` : "");
  const hint = loaded.every((x) => x.indexed) ? "" : `<details><summary>Совет: индекс в Firebase</summary><pre>${esc(FIREBASE_INDEX_HINT)}</pre></details>`;

  if (a.action === "stats") {
    let html = statsHtml(list, a.hours);
    if (multi && list.length) {
      const per = names.map((n, i) => [n, loaded[i].list.length]).sort((x, y) => y[1] - x[1]);
      html = `<h3>По чатам</h3>${barRows(per, Math.max(1, per[0][1]))}` + html;
    }
    return { a, ok: true, html: head + html + hint };
  }

  const tr = transcript(list, multi);
  if (!tr.used) return { a, ok: true, html: head + "<p>За этот период сообщений от участников нет.</p>" + hint };
  if (a.action === "ask" && !a.question) return { a, ok: false, html: head + "<p>Напишите вопрос в поле «Вопрос».</p>" };
  const lang = LANGS[a.lang][1];
  const intro = a.action === "ask" ? `${askPrompt(lang)}\n\nQuestion: ${a.question}` : summaryPrompt(lang);
  const scope = multi
    ? `Chats: ${names.map((n) => `"${n}"`).join(", ")}. Messages from all of them are merged by time; the chat name is in parentheses. Say which chat something comes from when it matters.`
    : `Chat: "${names[0]}".`;
  const { text: answer, model } = await gemini(env, s.gemini_model, `${intro}\n\n${scope}\nPeriod: last ${a.hours} hours.\nMessages:\n${tr.text}`);
  const note = tr.used < tr.all ? `<p class="hint">Gemini получил последние ${tr.used} из ${tr.all} сообщений — остальные не поместились.</p>` : "";
  const q = a.action === "ask" ? `<p class="hint">Вопрос: ${esc(a.question)}</p>` : "";
  return { a, ok: true, html: head + q + `<div class="md">${mdLite(answer)}</div>` + note
    + `<p class="hint">${esc(LANGS[a.lang][0])} · модель ${esc(model)}${model !== s.gemini_model ? " (запасная — основная была перегружена)" : ""} · сообщений: ${tr.used}</p>` + hint };
}

// ---------------- Дом: реле Tuya ----------------
// Облако Tuya (platform.tuya.com): секреты TUYA_ACCESS_ID и TUYA_ACCESS_SECRET из Cloud Project,
// к проекту привязано приложение Smart Life / Tuya Smart. Регион выбирается на вкладке «Дом».

const TUYA_HOSTS = {
  eu: ["https://openapi.tuyaeu.com", "Центральная Европа"],
  weu: ["https://openapi-weaz.tuyaeu.com", "Западная Европа"],
  us: ["https://openapi.tuyaus.com", "Запад США"],
  eus: ["https://openapi-ueaz.tuyaus.com", "Восток США"],
  in: ["https://openapi.tuyain.com", "Индия"],
  cn: ["https://openapi.tuyacn.com", "Китай"],
};
const TUYA_HINTS = {
  1004: "неверная подпись — проверьте TUYA_ACCESS_SECRET",
  1106: "нет доступа к устройству — привяжите приложение Smart Life к проекту",
  2008: "устройство не поддерживает такую команду",
  28841101: "похоже, закончилась бесплатная подписка IoT Core — продлите её в кабинете Tuya",
  28841105: "проекту не разрешён этот API — подключите IoT Core в Service API проекта",
};
const SWITCH_CODE = /^switch(_\d+|_led)?$/;
const TIMER_CHOICES = [15, 60, 180];

const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (str) => hexOf(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)));
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hexOf(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg))).toUpperCase();
}

const tuyaReady = (env) => !!(String(env.TUYA_ACCESS_ID || "").trim() && String(env.TUYA_ACCESS_SECRET || "").trim());
let tuyaTokenCache = null;

// Подпись Tuya: HMAC-SHA256(client_id [+ access_token] + t + "METHOD\nsha256(body)\n\nURL"), URL с отсортированными параметрами.
async function tuyaRaw(env, s, method, path, { query = null, body = null, token = null } = {}) {
  const base = (env.TUYA_ENDPOINT || (TUYA_HOSTS[s.tuya_region] || TUYA_HOSTS.eu)[0]).replace(/\/+$/, "");
  const qs = query ? Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join("&") : "";
  const url = path + (qs ? `?${qs}` : "");
  const bodyStr = body ? JSON.stringify(body) : "";
  const id = env.TUYA_ACCESS_ID.trim();
  const t = String(Date.now());
  const toSign = `${method}\n${await sha256Hex(bodyStr)}\n\n${url}`;
  const headers = { client_id: id, t, sign_method: "HMAC-SHA256", lang: "en", sign: await hmacHex(env.TUYA_ACCESS_SECRET.trim(), id + (token || "") + t + toSign) };
  if (token) headers.access_token = token;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers, body: body ? bodyStr : undefined });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Tuya ${res.status}: непонятный ответ`);
  return data;
}

const tuyaError = (d) => new Error(`Tuya ${d.code}: ${d.msg || "ошибка"}${TUYA_HINTS[d.code] ? ` (${TUYA_HINTS[d.code]})` : ""}`);

async function tuyaToken(env, s, fresh = false) {
  const id = env.TUYA_ACCESS_ID.trim();
  const valid = (t) => t && t.id === id && t.region === s.tuya_region && t.exp > Date.now() + 60000;
  if (!fresh && valid(tuyaTokenCache)) return tuyaTokenCache.token;
  if (!fresh && env.MQM_KV) {
    const saved = await env.MQM_KV.get("tuya_token", "json");
    if (valid(saved)) return (tuyaTokenCache = saved).token;
  }
  const d = await tuyaRaw(env, s, "GET", "/v1.0/token", { query: { grant_type: 1 } });
  if (!d.success) throw tuyaError(d);
  tuyaTokenCache = { token: d.result.access_token, exp: Date.now() + d.result.expire_time * 1000, id, region: s.tuya_region };
  if (env.MQM_KV) await env.MQM_KV.put("tuya_token", JSON.stringify(tuyaTokenCache), { expirationTtl: Math.max(60, d.result.expire_time - 60) });
  return tuyaTokenCache.token;
}

async function tuya(env, s, method, path, opts = {}) {
  let d = await tuyaRaw(env, s, method, path, { ...opts, token: await tuyaToken(env, s) });
  if (!d.success && (d.code === 1010 || d.code === 1011)) d = await tuyaRaw(env, s, method, path, { ...opts, token: await tuyaToken(env, s, true) });
  if (!d.success) throw tuyaError(d);
  return d.result;
}

async function tuyaDevice(env, s, id) {
  const r = await tuya(env, s, "GET", `/v1.0/devices/${encodeURIComponent(id)}`);
  const switches = (r?.status || []).filter((x) => SWITCH_CODE.test(x.code) && typeof x.value === "boolean");
  return { id, name: r?.name || id, online: !!r?.online, switches };
}

async function tuyaSet(env, s, id, code, value) {
  const body = { commands: [{ code, value }] };
  try {
    return await tuya(env, s, "POST", `/v1.0/iot-03/devices/${encodeURIComponent(id)}/commands`, { body });
  } catch (e) {
    if (/^Tuya (1004|1106|2008)\b/.test(e.message)) throw e;
    return tuya(env, s, "POST", `/v1.0/devices/${encodeURIComponent(id)}/commands`, { body }); // старый адрес того же API
  }
}

async function tuyaDiscover(env, s) {
  const found = [];
  let last = "";
  for (let i = 0; i < 5; i++) {
    const r = await tuya(env, s, "GET", "/v1.0/iot-01/associated-users/devices", { query: last ? { last_row_key: last, size: 50 } : { size: 50 } });
    found.push(...(r?.devices || []));
    if (!r?.has_more || !r.last_row_key) break;
    last = r.last_row_key;
  }
  return found.map((d) => ({ id: d.id, name: d.name || d.id }));
}

// Имя выключателя: своё название, иначе имя устройства (+ номер канала, если каналов несколько).
function swLabel(dev, code, count) {
  const own = dev.aliases?.[code];
  if (own) return own;
  return count > 1 ? `${dev.name} ${code.replace(/\D/g, "") || code}` : dev.name;
}

async function tuyaLog(env, text, ok = true) {
  if (!env.MQM_KV) return;
  const list = (await env.MQM_KV.get("tuya_events", "json")) || [];
  list.unshift({ time: Date.now(), text: String(text).slice(0, 300), ok });
  await env.MQM_KV.put("tuya_events", JSON.stringify(list.slice(0, 30)));
}

async function setTimer(env, id, code, minutes, label) {
  const list = ((await env.MQM_KV.get("tuya_timers", "json")) || []).filter((t) => !(t.id === id && t.code === code));
  if (minutes) list.push({ id, code, label, at: Date.now() + minutes * 60000 });
  await env.MQM_KV.put("tuya_timers", JSON.stringify(list));
}

// Каждую минуту: выключить то, у чего вышел таймер. Неудачное выключение — ещё до трёх попыток.
async function runTimers(env, s) {
  const list = (await env.MQM_KV.get("tuya_timers", "json")) || [];
  const now = Date.now();
  if (!list.some((t) => t.at <= now)) return;
  const rest = list.filter((t) => t.at > now);
  for (const t of list.filter((x) => x.at <= now)) {
    try {
      await tuyaSet(env, s, t.id, t.code, false);
      await tuyaLog(env, `⏱ Таймер: ${t.label} — выключено`);
    } catch (e) {
      const tries = (t.tries || 0) + 1;
      if (tries < 3) rest.push({ ...t, tries, at: now + 60000 });
      await tuyaLog(env, `⏱ Таймер: ${t.label} — не выключилось: ${e.message}`, false);
    }
  }
  await env.MQM_KV.put("tuya_timers", JSON.stringify(rest));
}

async function sendTo(env, s, chatId, message) {
  const c = config(env, s);
  return apiCall(c, "sendMessage", { chatId: chatId || c.chat, message });
}

// ---------------- Команды из WhatsApp ----------------
// «!işıq aç», «!işıq bağla», «!işıq 30 dəq», «!işıq» (состояние), «!cihazlar», «!kömək».

const CMD_ON = ["aç", "ac", "yandır", "yandir", "yan", "işə", "ise", "işlət", "islet", "on", "вкл", "включи", "включить", "зажги"];
const CMD_OFF = ["bağla", "bagla", "söndür", "sondur", "kəs", "kes", "dayandır", "dayandir", "stop", "off", "выкл", "выключи", "выключить", "погаси"];
const CMD_STATUS = ["", "?", "vəziyyət", "veziyyet", "status", "статус"];
const CMD_LIST = ["cihazlar", "devices", "устройства"];
const CMD_HELP = ["kömək", "komek", "help", "помощь"];
const CMD_MIN = /^(dəq|deq|dəqiqə|deqiqe|min|мин|минут|минуты)$/;
const lower = (x) => String(x || "").toLocaleLowerCase("az").replace(/\s+/g, " ").trim();

function phoneDigits(x) {
  let d = String(x || "").replace(/\D/g, "");
  if (d.length === 10 && d.startsWith("0")) d = "994" + d.slice(1);
  else if (d.length === 9) d = "994" + d;
  return d;
}

// targets: [{ label, id, code }] — разбор без обращения к Tuya.
function parseCommand(text, targets) {
  const body = lower(text).replace(/^[!\/]\s*/, "");
  if (CMD_HELP.includes(body)) return { kind: "help" };
  if (CMD_LIST.includes(body)) return { kind: "list" };
  let body2 = body;
  { // глагол впереди: «!aç 1», «!işıq yandır» и т.п. → «1 aç»
    const w = body.split(" ");
    if ((CMD_ON.includes(w[0]) || CMD_OFF.includes(w[0])) && w.length > 1) body2 = `${w.slice(1).join(" ")} ${w[0]}`;
    if (w.length > 1 && w[0] === "işə" && w[1] === "sal") body2 = `${w.slice(2).join(" ")} aç`;
  }
  const target = [...targets].sort((a, b) => b.label.length - a.label.length)
    .find((t) => body2 === lower(t.label) || body2.startsWith(lower(t.label) + " "));
  if (!target) return { kind: "unknown" };
  const words = body2.slice(lower(target.label).length).trim().split(" ").filter(Boolean);
  if (CMD_STATUS.includes(words.join(" "))) return { kind: "status", target };
  let i = 0, value = null;
  if (CMD_ON.includes(words[0])) { value = true; i = 1; } else if (CMD_OFF.includes(words[0])) { value = false; i = 1; }
  const n = Number(words[i]);
  if (Number.isInteger(n) && n > 0 && value !== false) {
    if (words[i + 1] && !CMD_MIN.test(words[i + 1])) return { kind: "unknown" };
    return { kind: "set", target, value: true, minutes: Math.min(n, 1440) };
  }
  if (value === null || words.length > i) return { kind: "unknown" };
  return { kind: "set", target, value };
}

async function liveTargets(env, s) {
  const out = [];
  for (const dev of s.tuya_devices || []) {
    let live = null;
    try { live = await tuyaDevice(env, s, dev.id); } catch { live = null; }
    const codes = live ? live.switches.map((x) => x.code) : dev.codes || [];
    codes.forEach((code) => out.push({ id: dev.id, code, label: swLabel(dev, code, codes.length), on: live?.switches.find((x) => x.code === code)?.value, online: live?.online }));
  }
  return out;
}

const stateAz = (t) => (t.online === false ? "şəbəkədə deyil" : t.on === true ? "açıq" : t.on === false ? "bağlı" : "bilinmir");

async function runCommand(env, s, text) {
  const targets = await liveTargets(env, s);
  const cmd = parseCommand(text, targets);
  const example = targets[0] ? lower(targets[0].label) : "işıq";
  if (cmd.kind === "help") {
    return helpReply(s);
  }
  if (cmd.kind === "list") return targets.length ? targets.map((t) => `• ${t.label} — ${stateAz(t)}`).join("\n") : "Cihaz əlavə olunmayıb.";
  if (cmd.kind === "unknown") return `Komandanı başa düşmədim. Kömək: !kömək`;
  const t = cmd.target;
  if (cmd.kind === "status") return `${t.label}: ${stateAz(t)}`;
  await tuyaSet(env, s, t.id, t.code, cmd.value);
  if (cmd.minutes) {
    await setTimer(env, t.id, t.code, cmd.minutes, t.label);
    return `${t.label}: açıldı ✅, ${cmd.minutes} dəq sonra (${hm(new Date(Date.now() + cmd.minutes * 60000 + BAKU_OFFSET_MS))}) bağlanacaq`;
  }
  await setTimer(env, t.id, t.code, 0, t.label);
  return `${t.label}: ${cmd.value ? "açıldı ✅" : "bağlandı ⏹"}`;
}

// ---------------- Команды из WhatsApp: справочные (без реле) ----------------
// !dərs, !dərs sabah, !dərs həftə, !növbəti, !nəticə, !hava, !təqvim, !sifariş, !kamera, !status, !kömək.
// Читают данные и отвечают в группу; реле не нужно, поэтому работают для всех участников основной группы.

const fold = (x) => lower(x).replace(/ə/g, "e").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ç/g, "c").replace(/ş/g, "s").replace(/ğ/g, "g");

const INFO_WORDS = {
  help: ["komek", "kömek", "help", "yardim", "komandalar", "komanda", "menu", "start", "помощь", "меню", "команды", "справка", "?"],
  next: ["novbeti", "sonraki", "novbeti", "gelen", "следующий", "ближайший", "next"],
  lessons: ["ders", "dersler", "derslerim", "cedvel", "cedveli", "расписание", "уроки", "урок", "schedule", "lessons", "lesson"],
  scores: ["netice", "neticeler", "bal", "ballar", "imtahan", "yekun", "баллы", "балл", "результаты", "результат", "экзамен", "score", "scores", "result", "results", "exam"],
  weather: ["hava", "havalar", "proqnoz", "weather", "погода", "прогноз"],
  calendar: ["teqvim", "teqvimi", "bayram", "bayramlar", "dogum", "calendar", "календарь", "праздники"],
  orders: ["sifaris", "sifarisler", "sifarish", "benzin", "yanacaq", "заказ", "заказы", "топливо", "order", "orders", "fuel"],
  camera: ["kamera", "kameralar", "siqnal", "teveqqo", "камера", "камеры", "тревоги", "camera", "cameras"],
  status: ["status", "veziyyet", "vəziyyət", "bot", "статус", "состояние"],
  photos: ["foto", "fotolar", "sekil", "sekiller", "фото", "photo", "photos"],
};
const INFO_PRIORITY = ["help", "photos", "next", "scores", "weather", "calendar", "orders", "camera", "status", "lessons"];
// слова-уточнения дня, которые сами по себе значат «расписание»
const DAY_ONLY = ["sabah", "bugun", "indi", "hefte", "heftelik", "завтра", "сегодня", "неделя", "today", "tomorrow", "week"];

const DAY_WORDS = {
  1: ["bazar ertesi", "понедельник"], 2: ["cersenbe axsami", "вторник"], 3: ["cersenbe", "среда"],
  4: ["cume axsami", "четверг"], 5: ["cume", "пятница"], 6: ["senbe", "суббота"], 0: ["bazar", "воскресенье"],
};
const dayName = (d) => WEEKDAYS[(d + 6) % 7];

// null — это не справочная команда (значит, реле или непонятно)
function parseInfo(text, s) {
  const body = fold(String(text || "").trim().replace(/^[!\/]\s*/, ""));
  if (!body) return null;
  const labels = [];
  for (const dev of s.tuya_devices || []) {
    const codes = dev.codes || [];
    codes.forEach((code) => labels.push(fold(swLabel(dev, code, codes.length))));
  }
  if (labels.some((l) => body === l || body.startsWith(l + " "))) return null; // имя реле главнее
  const tokens = body.replace(/[?!.,]/g, " ").split(" ").filter(Boolean);
  const hit = (kind) => tokens.findIndex((w) => INFO_WORDS[kind].map(fold).includes(w));
  for (const kind of INFO_PRIORITY) {
    const i = hit(kind);
    if (i < 0) continue;
    const arg = tokens.filter((_, j) => j !== i).join(" ");
    if (kind === "lessons" && /\bnovbeti\b/.test(body)) return { kind: "next", arg: "" };
    return { kind, arg };
  }
  if (tokens.length <= 3 && tokens.some((w) => DAY_ONLY.includes(w) || Object.values(DAY_WORDS).flat().includes(w))) return { kind: "lessons", arg: tokens.join(" ") };
  return null;
}

const lessonsOf = (list, day) => list.filter((l) => l.day === day).sort((a, b) => a.time.localeCompare(b.time));
const lessonLine = (l, mark = "") => `${mark}${l.time}–${lessonEnd(l)}  ${l.subject}`;

function lessonsReply(list, arg, nowD, week) {
  const day = nowD.getUTCDay();
  const mins = nowD.getUTCHours() * 60 + nowD.getUTCMinutes();
  if (!list.length) return "📚 Dərs cədvəli boşdur.";
  if (week) {
    return ["📚 Həftəlik cədvəl", ...[1, 2, 3, 4, 5, 6, 0].map((d) => {
      const ls = lessonsOf(list, d);
      return ls.length ? `\n${dayName(d)}:\n${ls.map((l) => lessonLine(l)).join("\n")}` : `\n${dayName(d)}: —`;
    })].join("\n");
  }
  const dayBlock = (d, title, live) => {
    const ls = lessonsOf(list, d);
    if (!ls.length) return `📚 ${title} — ${dayName(d)}: dərs yoxdur 🎉`;
    const rows = ls.map((l) => {
      if (!live) return lessonLine(l);
      const st = mins >= toMin(l.time) + l.duration ? "✅ " : mins >= toMin(l.time) ? "▶️ " : "⏳ ";
      return lessonLine(l, st);
    });
    return [`📚 ${title} — ${dayName(d)} (${ls.length} dərs)`, ...rows].join("\n");
  };
  const a = fold(arg).replace(/\b(bu|на|для|gun|gunu|bu gun)\b/g, (m) => (m === "bu" || m === "gun" || m === "gunu" ? "" : m)).replace(/\s+/g, " ").trim();
  const has = (...w) => w.some((x) => new RegExp(`(^| )${x}( |$)`).test(a));
  if (has("hefte", "heftelik", "hamisi", "butun", "неделя", "неделю", "week", "weekly")) return lessonsReply(list, "hefte_", nowD, true);
  if (has("sabah", "завтра", "tomorrow")) return dayBlock((day + 1) % 7, "Sabah", false);
  if (has("novbeti", "sonraki", "следующий", "next")) return nextLessonReply(list, nowD);
  for (const [d, names] of Object.entries(DAY_WORDS).sort((x, y) => y[1][0].length - x[1][0].length)) if (names.some((n) => a.includes(n))) return dayBlock(Number(d), "Cədvəl", false);
  if (a === "" || has("indi", "bugun", "сегодня", "today")) return dayBlock(day, "Bu gün", true);
  return "Başa düşmədim. Nümunə: !dərs · !dərs sabah · !dərs həftə · !dərs cümə · !növbəti";
}

function nextLessonReply(list, nowD) {
  const mins = nowD.getUTCHours() * 60 + nowD.getUTCMinutes();
  for (let off = 0; off < 8; off++) {
    const d = (nowD.getUTCDay() + off) % 7;
    const l = lessonsOf(list, d).find((x) => off > 0 || toMin(x.time) > mins);
    if (l) {
      const when = off === 0 ? "Bu gün" : off === 1 ? "Sabah" : dayName(d);
      const left = off === 0 ? ` (${toMin(l.time) - mins} dəq sonra)` : "";
      return `📚 Növbəti dərs: ${when}\n${lessonLine(l)}${left}`;
    }
  }
  return "📚 Növbəti dərs tapılmadı.";
}

function scoresReply(state) {
  if (!state || !state.subjects || !Object.keys(state.subjects).length) return "📊 Hələ nəticə yoxdur.";
  const lines = [`📊 Yekun: ${num(state.total)} / ${state.max}`];
  for (const [name, s] of Object.entries(state.subjects)) {
    let line = `• ${name}: ${num(s.score)}`;
    const parts = [["correct", "✅"], ["wrong", "❌"], ["unverified", "⏳"]].filter(([k]) => k in s).map(([k, i]) => `${i} ${s[k]}`);
    if (parts.length) line += " (" + parts.join(" | ") + ")";
    lines.push(line);
  }
  return lines.join("\n");
}

async function ordersReply(env) {
  if (!firebaseReady(env)) return "⛽ Firebase qoşulmayıb.";
  const tonight = nightOf(Date.now() / 1000);
  const all = (await firebase(env, "GET", "/orders")) || {};
  const list = Object.values(all).filter((o) => o && o.night === tonight).sort((a, b) => a.timestamp - b.timestamp);
  if (!list.length) return `⛽ Bu gecə (${tonight.slice(8)}.${tonight.slice(5, 7)}) üçün sifariş yoxdur.`;
  const lines = [`⛽ Bu gecəki sifarişlər (${list.length}):`, ...sumFuels(list).map(([f, l]) => `• ${f}: ${liters(l)} l`), ""];
  for (const o of list) lines.push(`AZS №${o.station}: ${Object.entries(o.fuels || {}).sort(([a], [b]) => fuelSort(a, b)).map(([f, l]) => `${f} ${liters(l)}`).join(", ")}`);
  return lines.join("\n");
}

async function cameraReply(env) {
  if (!firebaseReady(env)) return "🚨 Firebase qoşulmayıb.";
  const raw = (await firebase(env, "GET", "/camera_events", null, `orderBy=${encodeURIComponent('"$key"')}&limitToLast=5`)) || {};
  const list = Object.values(raw).filter((e) => e && e.time).sort((a, b) => b.time - a.time);
  if (!list.length) return "🚨 Kamera siqnalı yoxdur.";
  return ["🚨 Son kamera siqnalları:", ...list.map((e) => {
    const d = new Date(e.time + BAKU_OFFSET_MS);
    return `• ${dm(d)} ${hm(d)} — ${String(e.text || e.camera || "").slice(0, 80)}`;
  })].join("\n");
}

async function statusReply(env, s) {
  const now = bakuNow();
  const last = await env.MQM_KV.get("last_run", "json");
  const lines = [
    `🤖 Bot işləyir · ${dm(now)} ${hm(now)} (Bakı)`,
    last ? `Son yoxlama: ${ago(last.time)} ${last.ok ? "✅" : "⚠️"}` : "Son yoxlama: hələ yoxdur",
    `Dərs xatırlatmaları: ${s.sched_enabled ? "açıq" : "söndürülüb"}`,
  ];
  if (tuyaReady(env) && (s.tuya_devices || []).length) {
    try { lines.push("Cihazlar:", ...(await liveTargets(env, s)).map((t) => `• ${t.label} — ${stateAz(t)}`)); } catch { /* Tuya недоступна */ }
  }
  return lines.join("\n");
}

function helpReply(s) {
  const first = (s.tuya_devices || []).find((d) => (d.codes || []).length);
  const ex = first ? lower(swLabel(first, first.codes[0], first.codes.length)) : "1";
  return `📖 Komandalar (hamısı ! ilə başlayır)

🔌 Rele:
!${ex} aç — işə sal
!${ex} bağla — söndür
!${ex} 30 dəq — 30 dəqiqəlik aç
!${ex} — vəziyyət
!cihazlar — bütün cihazlar

📚 Dərslər:
!dərs — bu gün
!dərs sabah — sabah
!dərs həftə — həftəlik
!dərs cümə — gün üzrə
!növbəti — növbəti dərs

📊 !nəticə — imtahan balları
🌦 !hava — hava proqnozu
📅 !təqvim — ad günləri, bayramlar
⛽ !sifariş — bu gecəki sifarişlər
🚨 !kamera — son kamera siqnalları
🤖 !status — botun vəziyyəti
🖼 !foto — növbədəki şəkillər
   (şəkli "!foto" yazısı ilə göndər — növbəyə düşər)
📖 !kömək — bu siyahı

Rusca da olar: !расписание, !баллы, !погода, !заказ, !помощь`;
}

async function runInfo(env, s, info) {
  const c = config(env, s);
  const nowD = bakuNow();
  switch (info.kind) {
    case "help": return helpReply(s);
    case "lessons": return lessonsReply(await lessonsCacheGet(env), info.arg, nowD);
    case "next": return nextLessonReply(await lessonsCacheGet(env), nowD);
    case "scores": return scoresReply(await env.MQM_KV.get("state", "json"));
    case "weather": return fmtWeather(c, await fetchWeather(c, ymd(nowD), ymd(addHours(nowD, 24))), nowD);
    case "calendar": return (await calendarMessage(c, nowD)) || "📅 Bu gün və sabah üçün hadisə yoxdur.";
    case "orders": return ordersReply(env);
    case "camera": return cameraReply(env);
    case "status": return statusReply(env, s);
    case "photos": return photoInfoReply(env, s);
  }
  return "Komandanı başa düşmədim. Kömək: !kömək";
}

// Любая команда («!…»), которую бот получил, но не выполнил, оставляет в журнале дома причину.
async function handleCommand(env, body) {
  try {
    await handleCommandInner(env, body);
  } catch (e) {
    console.log("ОШИБКА команды:", e.message);
    await tuyaLog(env, `⚠️ Команда не обработана: ${e.message}`, false).catch(() => {});
  }
}

async function handleCommandInner(env, body) {
  if (body.messageData?.typeMessage === "imageMessage" && isPhotoMark(body.messageData?.fileMessageData?.caption)) return; // это фото для очереди — им занимается handlePhoto
  const dir = MESSAGE_WEBHOOKS[body.typeWebhook];
  const text = messageText(body.messageData);
  let mainChat = (env.GREEN_CHAT_ID || "").trim();
  if (mainChat && !mainChat.includes("@")) mainChat += "@g.us";
  const fromChat = body.senderData?.chatId || "";
  if (mainChat && fromChat && fromChat !== mainChat) {
    // команды и ответы — только в основной группе
    if (text && /^(!\s*|\/)\S/.test(text.trim()) && env.MQM_KV) await tuyaLog(env, `⛔ команда «${text.trim().slice(0, 40)}» из другого чата — не выполнена`, false);
    return;
  }
  if (text && /^(!\s*|\/)\S/.test(text.trim()) && env.MQM_KV) {
    // фиксируем каждую команду сразу, чтобы в журнале было видно, дошла ли она до бота
    const who = phoneDigits(String(body.senderData?.sender || "").replace(/@.*/, "")) || "?";
    await tuyaLog(env, `📨 команда «${text.trim().slice(0, 40)}» от +${who} (${body.typeWebhook})`, true);
  }
  if (dir !== "incoming" && dir !== "outgoing") return; // свои ответы бота (outgoing_api) не разбираем
  if (!text || !/^(!\s*|\/)\S/.test(text.trim()) || !env.MQM_KV) return;
  const preview = text.trim().slice(0, 40);
  const s0 = await loadSettings(env);
  const info = parseInfo(text, s0);
  if (info) {
    // справочные команды: реле не нужно, отвечать может любой участник основной группы
    const k = `cmd_${fbKey(body.idMessage)}`;
    if (await env.MQM_KV.get(k)) return;
    await env.MQM_KV.put(k, "1", { expirationTtl: 86400 });
    let out, good = true;
    try { out = await runInfo(env, s0, info); } catch (e) { good = false; out = `Xəta: ${e.message}`; }
    await tuyaLog(env, `💬 ${body.senderData?.senderName || phoneDigits(body.senderData?.sender)}: ${preview} → ${out.split("\n")[0]}`, good);
    await sendTo(env, s0, fromChat || mainChat, out);
    return;
  }
  if (!tuyaReady(env)) {
    await tuyaLog(env, `⏸ Команда «${preview}» получена, но секретов Tuya нет`, false);
    return;
  }
  const s = await loadSettings(env);
  if (!s.tuya_wa) {
    await tuyaLog(env, `⏸ Команда «${preview}» получена, но «Управлять реле сообщениями» выключено (включите и нажмите «Сохранить»)`, false);
    return;
  }
  const sd = body.senderData || {};
  const allowed = new Set(String(s.tuya_wa_numbers || "").split(/[,;\n]+/).map(phoneDigits).filter(Boolean));
  const from = phoneDigits(String(sd.sender || "").replace(/@.*/, ""));
  if (dir === "incoming" && !allowed.has(from)) {
    await tuyaLog(env, `🚫 Команда от +${from || "?"} не принята: номера нет в «Кому можно» (${text.trim().slice(0, 40)})`, false);
    return;
  }
  const key = `cmd_${fbKey(body.idMessage)}`; // Green API может прислать то же уведомление повторно
  if (await env.MQM_KV.get(key)) return;
  await env.MQM_KV.put(key, "1", { expirationTtl: 86400 });
  let reply, ok = true;
  try {
    reply = await runCommand(env, s, text);
  } catch (e) {
    ok = false;
    reply = `Xəta: ${e.message}`;
  }
  await tuyaLog(env, `💬 ${sd.senderName || phoneDigits(sd.sender)}: ${text.trim()} → ${reply.split("\n")[0]}`, ok);
  if (s.tuya_wa_reply) await sendTo(env, s, fromChat || mainChat, `🔌 ${reply}`);
}

// ---------------- Фото дня ----------------
// Фото с подписью «!foto» в основной группе (с телефона бота или с номеров из «Кому можно») попадает в очередь.
// Картинки лежат в KV (ключи img:queue/…) или в R2, если подключена привязка PHOTOS; очередь — в KV photo_queue. Раз в день в заданное время
// бот отправляет в основную группу первое фото из очереди, без подписи, и убирает его из очереди.

const PHOTO_MARK = ["foto", "fotolar", "sekil", "şəkil", "фото", "photo"];
const PHOTO_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const photoReady = (env) => !!(env.PHOTOS || env.MQM_KV);
const MAX_PHOTO = 20_000_000; // байт; в KV одно значение — до 25 МиБ

// Одинаковый доступ к картинкам в R2 и в KV: get → { bytes, type } | null
const photoStore = (env) => (env.PHOTOS
  ? {
    put: (k, bytes, type) => env.PHOTOS.put(k, bytes, { httpMetadata: { contentType: type } }), // срок жизни в R2 — правилом жизненного цикла бакета
    get: async (k) => { const o = await env.PHOTOS.get(k); return o ? { bytes: new Uint8Array(await o.arrayBuffer()), type: o.httpMetadata?.contentType || "image/jpeg" } : null; },
    delete: (k) => env.PHOTOS.delete(k),
  }
  : {
    put: (k, bytes, type, ttl) => env.MQM_KV.put(`img:${k}`, bytes, { metadata: { type }, ...(ttl ? { expirationTtl: ttl } : {}) }),
    get: async (k) => { const r = await env.MQM_KV.getWithMetadata(`img:${k}`, "arrayBuffer"); return r?.value ? { bytes: new Uint8Array(r.value), type: r.metadata?.type || "image/jpeg" } : null; },
    delete: (k) => env.MQM_KV.delete(`img:${k}`),
  });
const photoQueue = async (env) => (await env.MQM_KV.get("photo_queue", "json")) || [];
const savePhotoQueue = (env, q) => env.MQM_KV.put("photo_queue", JSON.stringify(q));

// подпись «!foto» (и варианты) — знак, что фото для очереди, а не обычное сообщение семье
const isPhotoMark = (caption) => {
  const w = fold(String(caption || "").trim().replace(/^(!\s*|\/)/, "")).split(" ")[0];
  return /^(!\s*|\/)\S/.test(String(caption || "").trim()) && PHOTO_MARK.map(fold).includes(w);
};

async function addPhoto(env, bytes, type, from, source) {
  const kind = sniffImage(bytes);
  if (!kind) throw new Error("файл не похож на картинку (jpg/png/gif/webp)");
  if (bytes.length > MAX_PHOTO) throw new Error(`фото больше ${MAX_PHOTO / 1e6} МБ`);
  const key = `queue/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${kind[1]}`;
  await photoStore(env).put(key, bytes, kind[0]);
  const q = await photoQueue(env);
  q.push({ key, added: Date.now(), from: from || null, size: bytes.length, source });
  await savePhotoQueue(env, q);
  return q.length;
}

// Вебхук: фото с подписью «!foto» из основной группы
async function handlePhoto(env, body) {
  const md = body.messageData || {};
  if (md.typeMessage !== "imageMessage" || !env.MQM_KV) return;
  const dir = MESSAGE_WEBHOOKS[body.typeWebhook];
  if (dir !== "incoming" && dir !== "outgoing") return;
  const caption = md.fileMessageData?.caption;
  if (!isPhotoMark(caption)) return;
  let mainChat = (env.GREEN_CHAT_ID || "").trim();
  if (mainChat && !mainChat.includes("@")) mainChat += "@g.us";
  const sd = body.senderData || {};
  const from = phoneDigits(String(sd.sender || "").replace(/@.*/, ""));
  if (mainChat && sd.chatId !== mainChat) {
    await tuyaLog(env, `⛔ фото из другого чата — в очередь не добавлено`, false);
    return;
  }
  const s = await loadSettings(env);
  const allowed = new Set(String(s.tuya_wa_numbers || "").split(/[,;\n]+/).map(phoneDigits).filter(Boolean));
  if (dir === "incoming" && !allowed.has(from)) {
    await tuyaLog(env, `🚫 фото от +${from || "?"} не принято: номера нет в «Кому можно»`, false);
    return;
  }
  const dedupe = `photo_${fbKey(body.idMessage)}`;
  if (await env.MQM_KV.get(dedupe)) return;
  await env.MQM_KV.put(dedupe, "1", { expirationTtl: 86400 });
  if (!photoReady(env)) {
    await tuyaLog(env, `⏸ фото получено, но хранилище не подключено`, false);
    return;
  }
  try {
    const url = md.fileMessageData?.downloadUrl;
    if (!url) throw new Error("в уведомлении нет ссылки на файл");
    const res = await fetch(url); // ссылка Green API временная — скачиваем сразу
    if (!res.ok) throw new Error(`файл не скачался: ${res.status}`);
    const n = await addPhoto(env, new Uint8Array(await res.arrayBuffer()), null, from, "whatsapp");
    await tuyaLog(env, `🖼 фото от +${from || "?"} добавлено в очередь (всего ${n})`, true);
  } catch (e) {
    await tuyaLog(env, `⚠️ фото не добавлено: ${e.message}`, false);
  }
}

async function sendPhotoBytes(env, s, bytes, type, name) {
  const c = config(env, s);
  const form = new FormData();
  form.append("chatId", c.chat);
  form.append("fileName", name);
  form.append("file", new Blob([bytes], { type }), name);
  const res = await fetch(`${c.api}/waInstance${c.id}/sendFileByUpload/${c.token}`, { method: "POST", body: form });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Green API ${res.status}: ${raw.slice(0, 150)}`);
  return raw ? JSON.parse(raw) : null;
}

// Отправить первое фото очереди. Пропавшие из хранилища записи выбрасываются. null — очередь пуста.
async function sendNextPhoto(env, s) {
  let q = await photoQueue(env);
  while (q.length) {
    const item = q[0];
    const obj = await photoStore(env).get(item.key);
    if (!obj) { q = q.slice(1); await savePhotoQueue(env, q); continue; }
    const { bytes, type } = obj;
    await sendPhotoBytes(env, s, bytes, type, item.key.split("/").pop());
    q = (await photoQueue(env)).filter((x) => x.key !== item.key); // очередь могла измениться за время отправки
    await savePhotoQueue(env, q);
    await photoStore(env).delete(item.key);
    return { left: q.length };
  }
  return null;
}

async function runPhotos(env, s, now = Date.now()) {
  if (!s.photo_enabled || !photoReady(env)) return;
  const d = new Date(now + BAKU_OFFSET_MS);
  const today = ymd(d);
  if (hm(d) < s.photo_time || (await env.MQM_KV.get("photo_date")) === today) return;
  if (now < (Number(await env.MQM_KV.get("photo_retry_at")) || 0)) return;
  try {
    const r = await sendNextPhoto(env, s);
    await env.MQM_KV.put("photo_date", today); // пустая очередь — молчим до завтра
    if (r) await env.MQM_KV.put("photo_last", JSON.stringify({ time: now, ok: true, text: `отправлено, в очереди осталось ${r.left}` }));
  } catch (e) {
    await env.MQM_KV.put("photo_retry_at", String(now + 15 * 60000), { expirationTtl: 3600 });
    await env.MQM_KV.put("photo_last", JSON.stringify({ time: now, ok: false, text: e.message.slice(0, 200) }));
  }
}

function photoNextText(s, q, sentToday) {
  if (!s.photo_enabled) return "показ выключен";
  if (!q.length) return "очередь пуста";
  return `${sentToday ? "завтра" : "сегодня"} в ${s.photo_time}`;
}

async function photoInfoReply(env, s) {
  if (!photoReady(env)) return "🖼 Şəkil anbarı qoşulmayıb.";
  const q = await photoQueue(env);
  if (!q.length) return "🖼 Növbədə şəkil yoxdur.";
  const sent = (await env.MQM_KV.get("photo_date")) === ymd(bakuNow());
  const when = !s.photo_enabled ? "göstərmə söndürülüb" : `növbəti: ${sent ? "sabah" : "bu gün"} ${s.photo_time}`;
  return `🖼 Növbədə ${q.length} şəkil · ${when}`;
}

async function photosAction(env, form, files) {
  const op = String(form.get("do") || "");
  if (op === "settings_save") {
    const time = String(form.get("photo_time") || "").trim();
    if (!PHOTO_TIME_RE.test(time)) throw new Error("Время — в виде ЧЧ:ММ, например 09:00");
    await env.MQM_KV.put("settings", JSON.stringify({ ...(await loadSettings(env)), photo_time: time }));
    return `Время показа: ${time}`;
  }
  if (!photoReady(env)) throw new Error("Хранилище не подключено");
  const q = await photoQueue(env);
  const key = String(form.get("key") || "");
  const i = q.findIndex((x) => x.key === key);
  if (op === "upload") {
    let n = 0;
    for (const f of files) {
      if (!f || typeof f === "string" || !f.size) continue;
      await addPhoto(env, new Uint8Array(await f.arrayBuffer()), f.type, null, "page");
      n++;
    }
    if (!n) throw new Error("Файлы не выбраны");
    return `Добавлено фото: ${n}`;
  }
  if (op === "delete") {
    if (i < 0) throw new Error("Фото уже нет в очереди");
    await photoStore(env).delete(key);
    q.splice(i, 1);
    await savePhotoQueue(env, q);
    return "Фото удалено из очереди";
  }
  if (op === "up" || op === "down" || op === "first") {
    if (i < 0) throw new Error("Фото уже нет в очереди");
    const [item] = q.splice(i, 1);
    const to = op === "first" ? 0 : op === "up" ? Math.max(0, i - 1) : Math.min(q.length, i + 1);
    q.splice(to, 0, item);
    await savePhotoQueue(env, q);
    return "Порядок изменён";
  }
  if (op === "send_now") {
    const r = await sendNextPhoto(env, await loadSettings(env));
    if (!r) throw new Error("Очередь пуста");
    await env.MQM_KV.put("photo_last", JSON.stringify({ time: Date.now(), ok: true, text: `отправлено вручную, осталось ${r.left}` }));
    return `Фото отправлено в группу. В очереди осталось ${r.left}`;
  }
  if (op === "skip_today") {
    await env.MQM_KV.put("photo_date", ymd(bakuNow()));
    return "Сегодня фото не будет";
  }
  if (op === "unskip_today") {
    await env.MQM_KV.delete("photo_date");
    return "Сегодняшний показ снова в планах";
  }
  throw new Error("Неизвестное действие");
}

function photosCard(st) {
  const { s, photos } = st;
  return `<section class="card">
<h2>🖼 Фото дня</h2>
${toggleForm("photo_enabled", s.photo_enabled, "Одно фото в группу каждый день", "photos")}
<p class="meta">${photos.ready ? `В очереди: ${photos.queue.length} · следующее: ${photoNextText(s, photos.queue, photos.sentToday)}` : "Хранилище не подключено"}</p>
<a class="btn" href="#photos">🖼 Очередь фото</a>
</section>`;
}

function photosPanel(env, st) {
  const { s, photos } = st;
  const head = `${subnav("photos")}
<section class="card">
<h2>🖼 Фото дня</h2>
${toggleForm("photo_enabled", s.photo_enabled, "Одно фото в группу каждый день", "photos")}
<form method="post" action="/photos" class="adv">
<input type="hidden" name="do" value="settings_save">
<label>Во сколько (по Баку)<input type="time" name="photo_time" value="${esc(s.photo_time)}" required></label>
<button class="btn">💾 Сохранить</button>
</form>
<p class="hint">Как добавить: отправьте фото в основную группу с подписью <code>!foto</code> (с телефона бота или с номеров из «Кому можно» на вкладке «Дом»). В группу фото уйдёт без подписи. Пустая очередь — бот молчит.</p>
</section>`;
  if (!photos.ready) {
    return `${head}<section class="card"><h2>Нет хранилища</h2><p class="meta">Не подключено KV-хранилище MQM_KV.</p></section>`;
  }
  const last = photos.last ? `<p class="meta">Последний показ: ${ago(photos.last.time)} — <span class="${photos.last.ok ? "ok" : "bad"}">${esc(photos.last.text)}</span></p>` : "";
  const btn = (op, key, label, extra = "") => `<form method="post" action="/photos"><input type="hidden" name="do" value="${op}"><input type="hidden" name="key" value="${esc(key)}"><button class="btn small"${extra}>${label}</button></form>`;
  const items = photos.queue.map((p, i) => `<li class="photo">
<img src="/photo?k=${encodeURIComponent(p.key)}" alt="Фото ${i + 1}" loading="lazy">
<div><b>${i + 1}.</b> <span class="meta">${dm(new Date(p.added + BAKU_OFFSET_MS))}${p.from ? ` · +${esc(p.from)}` : p.source === "page" ? " · со страницы" : ""}</span>
<div class="acts">${i ? btn("first", p.key, "⏫") + btn("up", p.key, "▲") : ""}${i < photos.queue.length - 1 ? btn("down", p.key, "▼") : ""}${btn("delete", p.key, "🗑", ` data-confirm="Удалить фото из очереди?"`)}</div></div>
</li>`).join("");
  return `${head}
<section class="card">
<h2>Очередь (${photos.queue.length})</h2>
<p class="meta">Следующее: ${photoNextText(s, photos.queue, photos.sentToday)}</p>
${last}
<div class="acts">
${photos.queue.length ? `<form method="post" action="/photos"><input type="hidden" name="do" value="send_now"><button class="btn" data-confirm="Отправить первое фото в группу сейчас?">📤 Отправить сейчас</button></form>` : ""}
${photos.sentToday ? `<form method="post" action="/photos"><input type="hidden" name="do" value="unskip_today"><button class="btn">↩️ Вернуть сегодняшний показ</button></form>` : `<form method="post" action="/photos"><input type="hidden" name="do" value="skip_today"><button class="btn">⏭ Пропустить сегодня</button></form>`}
</div>
${items ? `<ol class="photos">${items}</ol>` : `<p class="meta">Очередь пуста.</p>`}
<form method="post" action="/photos" enctype="multipart/form-data" class="adv">
<input type="hidden" name="do" value="upload">
<label>Добавить с телефона<input type="file" name="file" accept="image/*" multiple required></label>
<button class="btn">⬆️ Загрузить в конец очереди</button>
</form>
</section>`;
}

// ---------------- Дом: тревоги камер ----------------
// Адрес /camera/<ключ>: ключ выводится из WEBHOOK_SECRET, отдельный секрет не нужен.

const CAMERA_COOLDOWNS = [0, 1, 5, 15, 30, 60];
const cameraToken = async (env) => (env.WEBHOOK_SECRET ? (await sha256Hex("camera:" + env.WEBHOOK_SECRET)).slice(0, 24) : null);

// Снимок из письма камеры: base64 из сценария Gmail → файл в WhatsApp с текстом тревоги в подписи.
const MAX_CAMERA_IMAGE = 4_000_000; // байт; больше — шлём только текст

// Тип картинки определяем по первым байтам: камеры нередко шлют снимок с типом application/octet-stream.
function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ["image/jpeg", "jpg"];
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ["image/png", "png"];
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ["image/gif", "gif"];
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return ["image/webp", "webp"];
  return null;
}

const CAMERA_IMAGE_TTL = 3 * 86400; // сколько секунд снимок тревоги живёт в KV и виден в приложении

// Снимок из письма: base64 → байты, проверка размера и формата. Декодируем один раз на тревогу (лимит CPU на бесплатном плане).
function decodeCameraImage(ev) {
  let bytes;
  try {
    bytes = Uint8Array.from(atob(String(ev.image)), (ch) => ch.charCodeAt(0));
  } catch {
    throw new Error("снимок пришёл в неверном виде (не base64)");
  }
  if (!bytes.length) throw new Error("снимок пустой");
  if (bytes.length > MAX_CAMERA_IMAGE) throw new Error(`снимок больше ${MAX_CAMERA_IMAGE / 1e6} МБ`);
  const kind = sniffImage(bytes);
  if (!kind) throw new Error("вложение не похоже на картинку (не jpg/png/gif/webp)");
  let name = String(ev.imageName || "snapshot").replace(/[^\w.-]/g, "_").slice(0, 60) || "snapshot";
  if (!/\.(jpe?g|png|gif|webp)$/i.test(name)) name += "." + kind[1];
  return { bytes, kind, name };
}

async function sendCameraPhoto(env, s, chatId, caption, img) {
  const c = config(env, s);
  const { bytes, kind, name } = img;
  const form = new FormData();
  form.append("chatId", chatId || c.chat);
  form.append("caption", caption);
  form.append("fileName", name);
  form.append("file", new Blob([bytes], { type: kind[0] }), name);
  const res = await fetch(`${c.api}/waInstance${c.id}/sendFileByUpload/${c.token}`, { method: "POST", body: form });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Green API ${res.status}: ${raw.slice(0, 150)}`);
  return raw ? JSON.parse(raw) : null;
}

async function cameraEvent(env, ev) {
  const s = await loadSettings(env);
  const now = Date.now();
  const camera = String(ev.camera || ev.app || "Kamera").replace(/\s+/g, " ").trim().slice(0, 80) || "Kamera";
  const text = [ev.title, ev.text].filter((x) => x && String(x).trim()).map(String).join(" — ").replace(/\s+/g, " ").trim().slice(0, 500);
  let forwarded = false, reason = "";
  // состояние снимка: "" — о снимках ничего не известно (старый скрипт или другой источник), noimage — в письме снимка нет,
  // received — получен, но не пересылался, sent — ушёл в WhatsApp, failed — отправить не удалось (текст всё равно ушёл)
  let photo = ev.image ? "received" : String(ev.script || "") === "2" ? "noimage" : "";
  let photoError = "";
  let img = null, imgError = "";
  if (ev.image) {
    try { img = decodeCameraImage(ev); } catch (e) { imgError = e.message; }
  }
  if (!s.camera_forward) reason = "пересылка в WhatsApp выключена";
  else {
    const last = (await env.MQM_KV.get("camera_last", "json")) || {};
    if (s.camera_cooldown && now - (last[camera] || 0) < s.camera_cooldown * 60000) reason = "пауза между тревогами этой камеры";
    else {
      const caption = `🚨 ${camera}${text ? `\n${text}` : ""}\n🕒 ${bakuTime(now)}`;
      let sentPhoto = false, photoReply = null;
      if (ev.image) {
        try {
          if (!img) throw new Error(imgError || "снимок не разобран");
          photoReply = await sendCameraPhoto(env, s, s.camera_chat || null, `🕒 ${bakuTime(now)}`, img);
          sentPhoto = true;
          photo = "sent";
        } catch (e) {
          photo = "failed";
          photoError = e.message.slice(0, 200);
          console.log("Снимок не отправлен, шлю текстом:", e.message);
        }
      }
      if (!sentPhoto) await sendTo(env, s, s.camera_chat || null, caption);
      last[camera] = now;
      await env.MQM_KV.put("camera_last", JSON.stringify(last));
      forwarded = true;
    }
  }
  // снимок сохраняем всегда (и если пересылка выключена или сработала пауза), чтобы его было видно в приложении
  let image = null;
  if (img && photoReady(env)) {
    const key = `cam/${now}_${Math.random().toString(36).slice(2, 8)}.${img.kind[1]}`;
    try {
      await photoStore(env).put(key, img.bytes, img.kind[0], CAMERA_IMAGE_TTL);
      image = key;
    } catch (e) {
      console.log("Снимок не сохранён:", e.message);
    }
  }
  if (firebaseReady(env)) {
    await firebase(env, "PATCH", "/", { [`camera_events/${now}_${Math.random().toString(36).slice(2, 8)}`]: { time: now, camera, text, forwarded, photo, photoError: photoError || null, image } })
      .catch((e) => console.log("Тревога не сохранена:", e.message));
  }
  return { forwarded, reason, photo, ...(photoError ? { photoError } : {}) };
}

const gmailScript = (camUrl) => `const URL = "${camUrl}";
const QUERY = "is:unread from:(АДРЕС_КАМЕРЫ)";
function bodyText(m) {
  const t = m.getPlainBody();
  if (t && t.trim()) return t;
  return m.getBody().replace(/<style[\\s\\S]*?<\\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\\s+/g, " ").trim();
}
function isImage(a) {
  if (/^image\\//.test(a.getContentType()) || /\\.(jpe?g|png|gif|webp|bmp)$/i.test(a.getName() || "")) return true;
  const b = a.getBytes();
  return b.length > 3 && b[0] === -1 && b[1] === -40 && b[2] === -1;
}
function forwardCamera() {
  for (const thread of GmailApp.search(QUERY, 0, 20)) {
    for (const m of thread.getMessages()) {
      if (!m.isUnread()) continue;
      const from = m.getFrom();
      const body = { script: 2, camera: from.replace(/<[^>]*>/g, "").replace(/"/g, "").trim() || from, title: m.getSubject(), text: bodyText(m).slice(0, 300) };
      const files = m.getAttachments();
      const img = files.find(isImage);
      if (img && img.getBytes().length < 4000000) {
        body.image = Utilities.base64Encode(img.getBytes());
        body.imageName = img.getName();
        body.imageType = img.getContentType();
      }
      Logger.log("вложений: " + files.length + ", снимок: " + (img ? img.getName() + " " + img.getBytes().length + " байт" : "нет"));
      UrlFetchApp.fetch(URL, { method: "post", contentType: "application/json", payload: JSON.stringify(body) });
      m.markRead();
    }
  }
}
`;

// ---------------- Дом: страница ----------------

async function houseStatus(env, s) {
  const kv = env.MQM_KV;
  const safe = (p) => p.then((v) => ({ v }), (e) => ({ e: e.message }));
  const devs = s.tuya_devices || [];
  let tokenError = null;
  if (tuyaReady(env) && devs.length) tokenError = await tuyaToken(env, s).then(() => null, (e) => e.message);
  const [timers, events, live, cams] = await Promise.all([
    kv ? kv.get("tuya_timers", "json") : null,
    kv ? kv.get("tuya_events", "json") : null,
    tuyaReady(env) && devs.length && !tokenError ? Promise.all(devs.map((d) => safe(tuyaDevice(env, s, d.id)))) : [],
    firebaseReady(env) ? safe(firebase(env, "GET", "/camera_events", null, `orderBy=${encodeURIComponent('"$key"')}&limitToLast=10`)) : { v: null },
  ]);
  const camEvents = cams.v ? Object.values(cams.v).sort((a, b) => b.time - a.time) : [];
  return { devs, tokenError, timers: timers || [], events: events || [], live, camEvents, camError: cams.e };
}

function switchRows(dev, live, timers, back) {
  const count = live.switches.length;
  return live.switches.map((x) => {
    const label = swLabel(dev, x.code, count);
    const timer = timers.find((t) => t.id === dev.id && t.code === x.code);
    const hidden = `<input type="hidden" name="id" value="${esc(dev.id)}"><input type="hidden" name="code" value="${esc(x.code)}"><input type="hidden" name="back" value="${back}">`;
    return `<div class="swrow">
<form method="post" action="/house"><input type="hidden" name="do" value="switch">${hidden}<input type="hidden" name="v" value="off">
<label class="switch"><span>${esc(label)}${live.online ? "" : ` <small class="bad">не в сети</small>`}</span><input type="checkbox" name="v" value="on"${checked(x.value)} onchange="this.form.requestSubmit()" aria-label="${esc(label)}"></label></form>
${timer
    ? `<form method="post" action="/house" class="timerline active"><input type="hidden" name="do" value="timer_cancel">${hidden}<span class="meta">⏱ выключится в ${hm(new Date(timer.at + BAKU_OFFSET_MS))}</span><button class="btn small">Отменить</button></form>`
    : `<form method="post" action="/house" class="timerline"><input type="hidden" name="do" value="timer">${hidden}<span class="meta">Включить на</span>${TIMER_CHOICES.map((m) => `<button class="btn small" name="minutes" value="${m}">${m < 60 ? `${m} мин` : `${m / 60} ч`}</button>`).join("")}</form>`}
</div>`;
  }).join("");
}

function homeHouseCard(env, st) {
  const h = st.house;
  if (!tuyaReady(env) || !h.devs.length) return "";
  const rows = h.devs.map((dev, i) => {
    const live = h.live[i];
    if (!live || live.e) return `<p class="meta">${esc(dev.name)}: <span class="bad">нет связи</span></p>`;
    return switchRows(dev, live.v, h.timers, "home");
  }).join("");
  return `<section class="card"><h2>🏠 Дом</h2>${h.tokenError ? `<p class="bad">${esc(h.tokenError)}</p>` : rows}<a class="btn" href="#house">Всё о доме</a></section>`;
}

function photoNote(e) {
  if (e.photo === "sent") return `<span class="ok">📷 снимок отправлен</span>`;
  if (e.photo === "failed") return `<span class="bad">📷 снимок не ушёл: ${esc(e.photoError || "ошибка")}</span>`;
  if (e.photo === "received") return "📷 снимок получен";
  if (e.photo === "noimage") return "в письме не нашлось снимка";
  return "";
}

// Если свежая тревога пришла без сведений о снимке — скорее всего, в Gmail остался код старой версии.
function oldScriptHint(events) {
  const last = events.find((e) => e.camera !== "Test");
  return last && !last.photo
    ? `<p class="hint">О снимках нет данных. Если камеры подключены через Gmail, скопируйте код скрипта заново (ниже, «Как подключить камеры»): старая версия снимки не отправляет.</p>`
    : "";
}

function housePanel(env, st, origin) {
  const { s } = st;
  const h = st.house;
  const ready = tuyaReady(env);
  const region = TUYA_HOSTS[s.tuya_region] || TUYA_HOSTS.eu;

  const devices = h.devs.map((dev, i) => {
    const live = h.live[i];
    const head = `<h2>${esc(dev.name)}${live?.v ? `<span class="pill ${live.v.online ? "ok" : "bad"}">${live.v.online ? "в сети" : "не в сети"}</span>` : ""}</h2>`;
    const body = !ready ? `<p class="meta">Управление заработает после добавления ключей Tuya.</p>`
      : h.tokenError ? `<p class="bad">${esc(h.tokenError)}</p>`
      : live?.e ? `<p class="bad">${esc(live.e)}</p>`
      : live?.v?.switches.length ? switchRows(dev, live.v, h.timers, "house")
      : `<p class="meta">У устройства не нашлось выключателей.</p>`;
    const codes = live?.v?.switches.map((x) => x.code) || [];
    return `<section class="card">${head}${body}
<details><summary>Настроить</summary><form method="post" action="/house" class="adv">
<input type="hidden" name="id" value="${esc(dev.id)}">
<label>Название<input type="text" name="name" value="${esc(dev.name)}"></label>
${codes.map((code) => `<label>Имя для команд: ${esc(code)}<input type="text" name="alias_${esc(code)}" value="${esc(dev.aliases?.[code] || "")}" placeholder="${esc(swLabel({ ...dev, aliases: {} }, code, codes.length))}"></label>`).join("")}
<p class="hint">Device ID: <code>${esc(dev.id)}</code></p>
<button class="btn" name="do" value="device_save">Сохранить</button>
<button class="btn danger" name="do" value="device_remove" data-confirm="Убрать устройство из бота? В приложении Tuya оно останется.">Убрать из бота</button>
</form></details>
</section>`;
  }).join("");

  const steps = `<ol class="steps">
<li>Зайдите на <b>platform.tuya.com</b> под любым e-mail (это кабинет разработчика, он бесплатный).</li>
<li><b>Cloud → Development → Create Cloud Project</b>: Development Method — <i>Smart Home</i>, Data Center — тот же регион, что ниже.</li>
<li>В проекте: <b>Devices → Link App Account → Add App Account</b> и отсканируйте QR-код в приложении Smart Life / Tuya Smart (Профиль → значок сканера). Ваши устройства появятся в проекте.</li>
<li>Во вкладке <b>Overview</b> скопируйте <b>Access ID</b> и <b>Access Secret</b>.</li>
<li>В Cloudflare добавьте два секрета: <code>TUYA_ACCESS_ID</code> и <code>TUYA_ACCESS_SECRET</code> (тип Secret, имена набрать вручную, затем Deploy).</li>
<li>Вернитесь сюда и нажмите «Найти мои устройства».</li>
</ol>
<p class="hint">Бесплатный доступ к API Tuya (IoT Core) выдаётся на пробный срок, потом его продлевают бесплатно в кабинете Tuya. Если команды перестанут проходить с ошибкой про подписку — дело в этом.</p>`;

  const connect = `<section class="card">
<h2>🔌 Реле Tuya</h2>
<p class="meta">${ready ? `Ключи на месте · регион: ${esc(region[1])} · устройств: ${h.devs.length}` : `<span class="warn">Ещё не подключено</span> — нет секретов TUYA_ACCESS_ID / TUYA_ACCESS_SECRET.`}</p>
${ready ? "" : steps}
<form method="post" action="/house" class="adv">
<input type="hidden" name="do" value="region_save">
<label>Регион (Data Center) проекта Tuya<select name="region" onchange="this.form.requestSubmit()">${Object.entries(TUYA_HOSTS).map(([k, [, n]]) => `<option value="${k}"${sel(k, s.tuya_region)}>${n}</option>`).join("")}</select></label>
</form>
${ready ? `<form method="post" action="/house"><input type="hidden" name="do" value="discover"><button class="btn primary">🔎 Найти мои устройства</button></form>
<details><summary>Добавить по Device ID</summary><form method="post" action="/house" class="adv">
<input type="hidden" name="do" value="device_add">
<label>Device ID (Tuya → проект → Devices)<input type="text" name="id" autocapitalize="off" spellcheck="false"></label>
<label>Название<input type="text" name="name" placeholder="например: Işıq"></label>
<button class="btn">Добавить</button></form></details>
${ready && !h.devs.length ? "" : `<details><summary>Как это работает</summary>${steps}</details>`}` : ""}
</section>`;

  const help = (() => {
    const first = h.live.find((x) => x?.v?.switches.length);
    const ex = first ? lower(swLabel(h.devs[h.live.indexOf(first)], first.v.switches[0].code, first.v.switches.length)) : "işıq";
    const c = (cmd, d) => `<li><code>${cmd}</code> — ${d}</li>`;
    return `<ul class="cmds">${c(`!${esc(ex)} aç`, "включить реле")}${c(`!${esc(ex)} bağla`, "выключить")}${c(`!${esc(ex)} 30 dəq`, "включить на 30 минут")}${c(`!${esc(ex)}`, "состояние")}${c("!cihazlar", "все устройства")}
${c("!dərs", "уроки сегодня")}${c("!dərs sabah", "уроки завтра")}${c("!dərs həftə", "вся неделя")}${c("!dərs cümə", "уроки по дню недели")}${c("!növbəti", "ближайший урок")}
${c("!nəticə", "баллы экзамена")}${c("!hava", "прогноз погоды")}${c("!təqvim", "дни рождения и праздники")}${c("!sifariş", "заказы топлива на эту ночь")}${c("!kamera", "последние тревоги камер")}${c("!status", "состояние бота")}${c("!foto", "сколько фото в очереди (фото с подписью !foto — в очередь)")}${c("!kömək", "список команд")}</ul>
<p class="hint">Реле — только для номеров из списка ниже; остальные команды доступны всем в основной группе. Понимает и по-русски: !расписание, !баллы, !погода, !заказ, !помощь; вкл/выкл, «30 мин».</p>`;
  })();

  const wa = `<form class="card" method="post" action="/house">
<input type="hidden" name="do" value="wa_save">
<h2>💬 Команды из WhatsApp</h2>
<input type="hidden" name="tuya_wa" value="off">
<label class="switch">Управлять реле сообщениями<input type="checkbox" name="tuya_wa" value="on"${checked(s.tuya_wa)}></label>
<label>Кому можно (номера через запятую)<input type="text" name="numbers" inputmode="tel" value="${esc(s.tuya_wa_numbers)}" placeholder="+994 50 123 45 67, 055 765 43 21"></label>
<input type="hidden" name="reply" value="off">
<label class="switch">Отвечать в чат «готово»<input type="checkbox" name="reply" value="on"${checked(s.tuya_wa_reply)}></label>
<details><summary>Какие команды</summary>${help}</details>
<p class="hint">Команды с телефона самого бота принимаются всегда, от остальных — только с этих номеров. Ответы бота считаются в лимит Green API (на бесплатном тарифе — 3 чата в месяц).</p>
<button class="btn">💾 Сохранить</button>
</form>`;

  const camUrl = st.cameraUrl;
  const chats = st.chatList.map((ch) => `<option value="${esc(ch.chatId)}"${sel(ch.chatId, s.camera_chat)}>${ch.isGroup ? "👥" : "👤"} ${esc(ch.name || ch.chatId)}</option>`).join("");
  const cam = `<form class="card" method="post" action="/house">
<input type="hidden" name="do" value="camera_save">
<h2>🚨 Тревоги камер</h2>
<input type="hidden" name="camera_forward" value="off">
<label class="switch">Пересылать тревоги в WhatsApp<input type="checkbox" name="camera_forward" value="on"${checked(s.camera_forward)}></label>
<label>Куда<select name="camera_chat"><option value=""${sel("", s.camera_chat)}>Основная группа бота</option>${chats}</select></label>
<label>Не чаще чем<select name="camera_cooldown">${CAMERA_COOLDOWNS.map((m) => `<option value="${m}"${sel(m, s.camera_cooldown)}>${m ? `раз в ${m} мин на камеру` : "без паузы"}</option>`).join("")}</select></label>
<button class="btn">💾 Сохранить</button>
</form>
<section class="card">
<h2>Последние тревоги</h2>
${h.camError ? `<p class="bad">${esc(h.camError)}</p>` : h.camEvents.length
    ? h.camEvents.map((e) => `<div class="row cam-row"><span>${esc(e.camera)}<br><small>${esc(e.text || "")}</small><br><small>${photoNote(e)}</small>${e.image ? `<a href="/photo?k=${encodeURIComponent(e.image)}" target="_blank"><img class="cam-img" loading="lazy" alt="Снимок тревоги" src="/photo?k=${encodeURIComponent(e.image)}"></a>` : ""}</span><span>${bakuTime(e.time)}<br><small>${e.forwarded ? `<span class="ok">в WhatsApp</span>` : "без пересылки"}</small></span></div>`).join("") + oldScriptHint(h.camEvents)
    : `<p class="meta">Пока не было.${firebaseReady(env) ? "" : " Список хранится в Firebase — он не настроен."}</p>`}
<form method="post" action="/house"><input type="hidden" name="do" value="camera_test"><button class="btn" data-confirm="Отправить тестовую тревогу${s.camera_forward ? " в WhatsApp" : ""}?">🧪 Тестовая тревога</button></form>
</section>
<details class="card"><summary>Как подключить камеры</summary>
${camUrl ? `<p class="meta">Адрес для тревог (никому не показывайте):</p><code>${esc(camUrl)}</code>
<button type="button" class="btn small" data-copy="${esc(camUrl)}">📋 Скопировать адрес</button>
<h3>Вариант 1 — телефон Android (MacroDroid)</h3>
<ol class="steps">
<li>Установите <b>MacroDroid</b> на Android-телефон, на котором стоит приложение камеры (iCSee и второе), и разрешите ему доступ к уведомлениям.</li>
<li>Новый макрос → <b>Триггер: Уведомление получено</b> → выберите приложение iCSee (и второе приложение камеры).</li>
<li><b>Действие: HTTP-запрос</b> → метод <b>POST</b>, адрес — как выше, тип содержимого <b>application/json</b>.</li>
<li>Тело запроса: <code>{"camera":"Двор","title":"[notification_title]","text":"[notification]"}</code> — заголовок и текст уведомления вставьте кнопкой «…» (Magic Text).</li>
<li>Нажмите «Тест» в MacroDroid — тревога появится ниже и, если включено, в WhatsApp.</li>
</ol>
<p class="hint">Телефон должен быть всегда включён и в сети — лучше отдельный старый Android дома.</p>
<h3>Вариант 2 — e-mail камеры (если в iCSee есть «тревога по почте»)</h3>
<ol class="steps">
<li>В камере укажите отправку тревог на ваш Gmail.</li>
<li>Откройте <b>script.google.com</b> → новый проект → вставьте код ниже, в <code>QUERY</code> впишите адрес, с которого приходят письма камеры.</li>
<li>Слева «Триггеры» → добавить → функция <code>forwardCamera</code>, по времени, каждую минуту.</li>
</ol>
<button type="button" class="btn small" data-copy="${esc(gmailScript(camUrl))}">📋 Скопировать код</button>
<pre>${esc(gmailScript(camUrl))}</pre>
<h3>Проверка вручную</h3>
<p class="meta"><a href="${esc(camUrl)}?camera=Test&amp;text=Hereket" target="_blank" rel="noopener">Открыть проверочную ссылку</a> — придёт тестовая тревога.</p>
<p class="hint">Снимки с камер — следующий этап: по почте они приходят вложением, бот сможет пересылать фото.</p>` : `<p class="bad">Нужен секрет WEBHOOK_SECRET — из него строится адрес для тревог.</p>`}
</details>`;

  const log = h.events.length ? `<details class="card"><summary>Журнал дома (${h.events.length})</summary>${h.events.map((e) => `<div class="row"><span>${esc(e.text)}</span><span><small>${bakuTime(e.time)}</small>${e.ok ? "" : ` <span class="bad">⚠️</span>`}</span></div>`).join("")}</details>` : "";

  return `${devices}${connect}${wa}${cam}${log}`;
}

// Действия вкладки «Дом». Возвращает текст для сообщения наверху страницы.
async function houseAction(env, form) {
  const s = await loadSettings(env);
  const str = (k) => String(form.get(k) ?? "").trim();
  const on = (k) => form.getAll(k).includes("on");
  const save = (patch) => env.MQM_KV.put("settings", JSON.stringify({ ...s, ...patch }));
  const devs = s.tuya_devices || [];
  const action = str("do");
  const needTuya = () => { if (!tuyaReady(env)) throw new Error("Сначала добавьте секреты TUYA_ACCESS_ID и TUYA_ACCESS_SECRET"); };
  const findDev = () => {
    const dev = devs.find((d) => d.id === str("id"));
    if (!dev) throw new Error("Устройство не найдено — обновите страницу");
    return dev;
  };
  const labelOf = async (dev, code) => {
    const live = await tuyaDevice(env, s, dev.id).catch(() => null);
    return swLabel(dev, code, live ? live.switches.length : 1);
  };

  if (action === "switch" || action === "timer" || action === "timer_cancel") {
    needTuya();
    const dev = findDev();
    const code = str("code");
    if (!SWITCH_CODE.test(code)) throw new Error("Неизвестный выключатель");
    const label = await labelOf(dev, code);
    if (action === "timer_cancel") {
      await setTimer(env, dev.id, code, 0, label);
      return `${label}: таймер отменён`;
    }
    const minutes = action === "timer" ? Number(str("minutes")) : 0;
    if (action === "timer" && !TIMER_CHOICES.includes(minutes)) throw new Error("Неверное время таймера");
    const value = action === "timer" ? true : on("v");
    await tuyaSet(env, s, dev.id, code, value);
    await setTimer(env, dev.id, code, minutes, label);
    await tuyaLog(env, `📱 Страница: ${label} — ${value ? "включено" : "выключено"}${minutes ? ` на ${minutes} мин` : ""}`);
    return minutes
      ? `${label}: включено, выключится в ${hm(new Date(Date.now() + minutes * 60000 + BAKU_OFFSET_MS))}`
      : `${label}: ${value ? "включено" : "выключено"}`;
  }
  if (action === "discover") {
    needTuya();
    const found = await tuyaDiscover(env, s);
    const fresh = found.filter((d) => !devs.some((x) => x.id === d.id));
    await save({ tuya_devices: [...devs, ...fresh.map((d) => ({ id: d.id, name: d.name, aliases: {} }))] });
    return found.length ? `Найдено устройств: ${found.length}, добавлено новых: ${fresh.length}` : "Устройств не нашлось — проверьте, что приложение Smart Life привязано к проекту и регион выбран верно";
  }
  if (action === "device_add") {
    needTuya();
    const id = str("id");
    if (!/^[A-Za-z0-9]{6,40}$/.test(id)) throw new Error("Device ID — латинские буквы и цифры, как в кабинете Tuya");
    if (devs.some((d) => d.id === id)) throw new Error("Это устройство уже добавлено");
    const live = await tuyaDevice(env, s, id);
    await save({ tuya_devices: [...devs, { id, name: str("name") || live.name, aliases: {} }] });
    return `Добавлено: ${str("name") || live.name}`;
  }
  if (action === "device_save") {
    const dev = findDev();
    const aliases = {};
    for (const [k, v] of form.entries()) {
      if (k.startsWith("alias_") && SWITCH_CODE.test(k.slice(6)) && String(v).trim()) aliases[k.slice(6)] = String(v).trim().slice(0, 40);
    }
    const name = (str("name") || dev.name).slice(0, 40);
    const next = devs.map((d) => (d.id === dev.id ? { ...d, name, aliases } : d));
    const labels = next.flatMap((d) => Object.values(d.aliases || {}).concat(d.name)).map(lower);
    const dup = labels.find((l, i) => labels.indexOf(l) !== i);
    if (dup) throw new Error(`Имя «${dup}» уже занято — для команд имена должны различаться`);
    await save({ tuya_devices: next });
    return `Сохранено: ${name}`;
  }
  if (action === "device_remove") {
    const dev = findDev();
    await save({ tuya_devices: devs.filter((d) => d.id !== dev.id) });
    const timers = ((await env.MQM_KV.get("tuya_timers", "json")) || []).filter((t) => t.id !== dev.id);
    await env.MQM_KV.put("tuya_timers", JSON.stringify(timers));
    return `Убрано из бота: ${dev.name}`;
  }
  if (action === "region_save") {
    const region = str("region");
    if (!TUYA_HOSTS[region]) throw new Error("Неизвестный регион");
    await save({ tuya_region: region });
    tuyaTokenCache = null;
    await env.MQM_KV.delete("tuya_token");
    return `Регион Tuya: ${TUYA_HOSTS[region][1]}`;
  }
  if (action === "wa_save") {
    const numbers = str("numbers").split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
    const bad = numbers.find((n) => phoneDigits(n).length < 11 || phoneDigits(n).length > 13);
    if (bad) throw new Error(`Не похоже на номер: «${bad}»`);
    await save({ tuya_wa: on("tuya_wa"), tuya_wa_numbers: numbers.join(", "), tuya_wa_reply: on("reply") });
    return on("tuya_wa") ? "Команды из WhatsApp включены" : "Команды из WhatsApp выключены";
  }
  if (action === "camera_save") {
    const chat = str("camera_chat");
    const cooldown = Number(str("camera_cooldown"));
    if (!CAMERA_COOLDOWNS.includes(cooldown)) throw new Error("Неверная пауза");
    if (chat && !/^[\w.-]+@(g|c)\.us$/.test(chat)) throw new Error("Неверный чат");
    await save({ camera_forward: on("camera_forward"), camera_chat: chat, camera_cooldown: cooldown });
    return on("camera_forward") ? "Тревоги будут приходить в WhatsApp" : "Пересылка тревог выключена";
  }
  if (action === "camera_test") {
    const r = await cameraEvent(env, { camera: "Test", text: "Sınaq həyəcan siqnalı" });
    return r.forwarded ? "Тестовая тревога отправлена в WhatsApp" : `Тестовая тревога записана (${r.reason})`;
  }
  throw new Error("Неизвестное действие");
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

const TABS = ["home", "orders", "house", "analysis", "settings", "service", "lessons", "photos"];
const NAV = ["home", "orders", "house", "analysis", "settings"]; // «Сервис» — внутри «Настроек»
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
.cam-row>span:first-child{min-width:0;flex:1;overflow-wrap:anywhere}
.cam-row>span:last-child{flex:none;white-space:nowrap}
.cam-img{display:block;max-width:100%;max-height:260px;margin-top:8px;border-radius:10px}
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
input[type=date],input[type=time]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font:inherit;font-size:16px;min-height:46px}
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
.pill{font-size:12px;font-weight:600;padding:2px 10px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.swrow{display:grid;gap:6px;padding:8px 0;border-top:1px solid var(--line)}
.swrow:first-of-type{border-top:0;padding-top:0}
.timerline{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
#p-home .timerline:not(.active){display:none}
.btn.small{width:auto;padding:6px 12px;font-size:14px;font-weight:500;border-radius:999px}
.photos{list-style:none;margin:8px 0;padding:0;display:grid;gap:10px}
.photo{display:flex;gap:10px;align-items:flex-start;border-top:1px solid var(--line);padding-top:10px}
.photo img{width:96px;height:96px;object-fit:cover;border-radius:10px;flex:none;background:var(--line)}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.acts form{margin:0}
.steps{margin:0;padding-left:20px;display:grid;gap:6px;font-size:14px}
.cmds{margin:0;padding-left:18px;display:grid;gap:4px;font-size:14px}
.subnav{display:grid;grid-template-columns:repeat(2,1fr);gap:4px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px}
.subnav a{text-align:center;padding:8px 4px;white-space:nowrap;border-radius:9px;text-decoration:none;color:var(--fg);font-size:15px}
.subnav a[aria-current=page]{background:var(--acc-soft);color:var(--acc);font-weight:600}
.lrow{display:grid;gap:6px;padding:8px 0;border-top:1px solid var(--line)}
.lrow:first-of-type{border-top:0;padding-top:0}
.l1{display:grid;grid-template-columns:104px 1fr;gap:8px}
.l2{display:flex;justify-content:space-between;align-items:center;gap:8px}
.l2 select{width:auto;padding:8px 10px;font-size:14px}
details.day>summary{display:flex;justify-content:space-between;gap:8px;align-items:baseline;padding:2px 0;color:var(--fg);font-size:16px}
details.day>summary .meta{font-size:13px}
details.day[open]>summary{margin-bottom:6px}
label.del{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--bad)}
label.del input{width:18px;height:18px;accent-color:var(--bad)}
.pickhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.linkbtn{background:none;border:0;padding:0;color:var(--acc);font:inherit;font-size:14px;cursor:pointer}
.chatpick{max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
.pick{display:flex;align-items:center;gap:10px;padding:10px 12px;border-top:1px solid var(--line);color:var(--fg);font-size:15px;cursor:pointer}
.pick:first-child{border-top:0}
.pick input{width:20px;height:20px;accent-color:var(--acc);flex:none}
.pick span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pick small{color:var(--mut)}
@media (prefers-reduced-motion:reduce){.switch input,.switch input::after{transition:none}}
`;

// Вкладки, подтверждения и «Подождите…» на кнопках. Без JS все вкладки видны подряд.
const CLIENT_JS = `
(function(){
  var tabs = ["home","orders","house","analysis","settings","service","lessons","photos"];
  var start = document.body.getAttribute("data-tab") || "home";
  function show(t){
    if (tabs.indexOf(t) < 0) t = start;
    tabs.forEach(function(x){ var p = document.getElementById("p-" + x); if (p) p.hidden = x !== t; });
    var navTab = (t === "service" || t === "lessons" || t === "photos") ? "settings" : t;
    document.querySelectorAll(".nav a").forEach(function(a){ a.setAttribute("aria-current", a.getAttribute("data-tab") === navTab ? "page" : "false"); });
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
  window.addEventListener("hashchange", function(){
    var flash = document.getElementById("flash"); if (flash) flash.remove(); // сообщение относится к прошлой вкладке
    show(location.hash.slice(1));
  });
  document.addEventListener("click", function(e){
    var pick = e.target.closest && e.target.closest("[data-check]");
    if (pick) {
      var on = pick.getAttribute("data-check") === "all";
      pick.closest("form").querySelectorAll(".chatpick input").forEach(function(x){ x.checked = on; });
      return;
    }
    var b = e.target.closest && e.target.closest("[data-copy]");
    if (!b) return;
    navigator.clipboard.writeText(b.getAttribute("data-copy")).then(
      function(){ b.textContent = "✓ Скопировано"; },
      function(){ b.textContent = "Не вышло — выделите вручную"; });
  });
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
  home: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  house: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  analysis: '<path d="M3 21h18M6 17v-6M11 17V5M16 17v-9M21 17v-3"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  service: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  orders: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M7 8h4M14 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3"/>',
};
const TAB_NAMES = { home: "Главная", orders: "Заказы", house: "Дом", analysis: "Анализ", settings: "Настройки", service: "Сервис", lessons: "Уроки", photos: "Фото дня" };

function page(title, body, { tab = "home", status = 200, nav = true } = {}) {
  const navHtml = nav
    ? `<nav class="nav" aria-label="Разделы">${NAV.map((t) => `<a href="#${t}" data-tab="${t}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[t]}</svg>${TAB_NAMES[t]}</a>`).join("")}</nav><script>${CLIENT_JS}</script>`
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

function toggleForm(key, on, label, tab = "home") {
  return `<form method="post" action="/toggle"><input type="hidden" name="key" value="${key}"><input type="hidden" name="tab" value="${tab}"><input type="hidden" name="v" value="off">`
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
  const [last, state, weatherDate, calDate, lastHook, chats, gState, gSettings, orders, lessonsRaw] = await Promise.all([
    kv ? kv.get("last_run", "json") : null,
    kv ? kv.get("state", "json") : null,
    kv ? kv.get("weather_date") : null,
    kv ? kv.get("cal_date") : null,
    kv ? kv.get("last_webhook", "json") : null,
    firebaseReady(env) ? safe(firebase(env, "GET", "/chats")) : { e: null },
    safe(apiCall(c, "getStateInstance")),
    safe(apiCall(c, "getSettings")),
    firebaseReady(env) ? safe(firebase(env, "GET", "/orders")) : { e: null },
    firebaseReady(env) ? safe(firebase(env, "GET", "/schedule/lessons")) : { e: null },
  ]);
  const orderList = orders.v ? Object.values(orders.v || {}).filter((o) => o && o.night).sort((a, b) => b.timestamp - a.timestamp) : [];
  const chatList = chats.v ? Object.values(chats.v || {}).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)) : [];
  const want = env.WEBHOOK_SECRET ? `${origin}/webhook/${env.WEBHOOK_SECRET}` : null;
  let hookWhere = null;
  if (gSettings.v) {
    const url = gSettings.v.webhookUrl;
    hookWhere = !url ? "none" : url === want ? "ours" : "other";
  }
  const house = await houseStatus(env, s);
  const camToken = await cameraToken(env);
  const cameraUrl = camToken ? `${origin}/camera/${camToken}` : null;
  const rawHook = kv ? await kv.get("last_hook_raw", "json") : null;
  const connLog = kv ? (await kv.get("conn_log", "json")) || [] : [];
  // расписание: основное — Firebase; KV-копию подтягиваем под него, при сбое базы показываем копию
  let lessons = [];
  if (lessonsRaw.v !== undefined) {
    lessons = lessonList(lessonsRaw.v);
    if (kv && JSON.stringify(lessons) !== JSON.stringify(await lessonsCacheGet(env))) await kv.put("lessons_cache", JSON.stringify(lessons));
  } else if (kv) {
    lessons = await lessonsCacheGet(env);
  }
  const lessonLast = kv ? await kv.get("lesson_last", "json") : null;
  const photos = { ready: photoReady(env) && !!kv, queue: [], sentToday: false, last: null };
  if (photos.ready) {
    photos.queue = await photoQueue(env);
    photos.sentToday = (await kv.get("photo_date")) === ymd(bakuNow());
    photos.last = await kv.get("photo_last", "json");
  }
  return { s, kv, last, state, weatherDate, calDate, lastHook, chats, chatList, gState, gSettings, hookWhere, orderList, house, cameraUrl, rawHook, connLog, lessons, lessonsErr: lessonsRaw.e || null, lessonLast, photos };
}

function problems(env, st) {
  const out = [];
  if (!st.kv) out.push(["Не привязано хранилище KV", "Бот не может запоминать баллы и настройки."]);
  if (/class="bad"/.test(secretsReport(env))) out.push(["Не хватает секретов", "«Настройки» → «Сервис» — там видно, каких именно."]);
  if (st.gState.v && st.gState.v.stateInstance !== "authorized") out.push(["WhatsApp отключён от Green API", "Откройте кабинет Green API и заново отсканируйте QR-код телефоном бота."]);
  if (st.gState.e) out.push(["Green API не отвечает", st.gState.e.slice(0, 160)]);
  if (st.hookWhere && st.hookWhere !== "ours") out.push(["Сообщения не собираются", "Green API шлёт их не туда. «Настройки» → «Сервис» → «Подключить вебхук»."]);
  if (st.lastHook && !st.lastHook.ok) out.push(["Последнее сообщение не сохранилось", st.lastHook.note]);
  if (st.chats.e) out.push(["Firebase не отвечает", st.chats.e.slice(0, 160)]);
  if (st.last && !st.last.ok) out.push(["Последний запуск с ошибкой", "Подробности — «Настройки» → «Сервис» → «Лог последнего запуска»."]);
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

${homeHouseCard(env, st)}

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

${calendarCard(st)}

${lessonsCard(st)}
${photosCard(st)}

${ordersCard(st)}

<section class="card">
<h2>💬 Сообщения</h2>
<p class="meta">${firebaseReady(env) ? `Собрано ${chatList.length} чатов, ${total} сообщений.` : "Сбор не настроен — см. «Сервис»."}
${lastHook ? ` Последнее: ${ago(lastHook.time)} ${lastHook.ok ? `<span class="ok">✓</span>` : `<span class="bad">с ошибкой</span>`}.` : ""}</p>
<a class="btn" href="#analysis">📈 Открыть анализ</a>
</section>`;
}

function calendarCard(st) {
  const { s } = st;
  const n = calendarSources(s).length;
  return `<section class="card">
<h2>📅 Календарь</h2>
${toggleForm("cal_enabled", s.cal_enabled, "Дни рождения и праздники в группу")}
<p class="meta">${n ? `Календарей: ${n} · каждый день в ${pad(s.cal_hour)}:00 · сегодня ${st.calDate === ymd(bakuNow()) ? `<span class="ok">проверено</span>` : "ещё нет"}` : `Добавьте календарь в «Настройках» → «📅 Календарь».`}</p>
${n ? `<div class="btns two">
${actionButton("home", "calendar_preview", "👀 Что уйдёт")}
${actionButton("home", "calendar", "📤 Отправить", { confirmText: "Отправить дни рождения и праздники в группу сейчас?" })}
</div>` : ""}
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
<div>
<div class="pickhead"><span class="meta">Чаты</span><span><button type="button" class="linkbtn" data-check="all">все</button> · <button type="button" class="linkbtn" data-check="none">ни одного</button></span></div>
<div class="chatpick">${chatList.map((ch, i) => `<label class="pick"><input type="checkbox" name="chat" value="${esc(ch.chatId)}"${checked(a.chats ? a.chats.includes(ch.chatId) : i === 0)}><span>${ch.isGroup ? "👥" : "👤"} ${esc(ch.name || ch.chatId)}</span><small>${ch.count || 0}</small></label>`).join("")}</div>
</div>
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

const subnav = (cur) => `<nav class="subnav" aria-label="Настройки, уроки и сервис">${[["settings", "⚙️ Настройки"], ["lessons", "📚 Уроки"], ["photos", "🖼 Фото"], ["service", "🩺 Сервис"]].map(([k, l]) => `<a href="#${k}"${cur === k ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</nav>`;

function settingsPanel(st) {
  const { s } = st;
  const intervals = INTERVALS.includes(s.interval) ? INTERVALS : [...INTERVALS, s.interval].sort((x, y) => x - y);
  return `${subnav("settings")}<form method="post" action="/save" class="panel">
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
<details><summary>Дополнительно</summary><div class="adv grid2">
<label>Широта<input type="text" inputmode="decimal" name="lat" value="${esc(s.lat)}"></label>
<label>Долгота<input type="text" inputmode="decimal" name="lon" value="${esc(s.lon)}"></label>
</div></details>
</section>

<section class="card">
<h2>📅 Календарь</h2>
<label>Праздники Азербайджана<select name="cal_holidays"><option value=""${sel("", s.cal_holidays)}>не добавлять</option>${Object.entries(HOLIDAY_LANGS).map(([k, n]) => `<option value="${k}"${sel(k, s.cal_holidays)}>${n}</option>`).join("")}</select></label>
<label>Мои календари — «секретный адрес в формате iCal», по одному в строке<textarea name="cal_urls" rows="3" autocapitalize="off" spellcheck="false" placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics">${esc(s.cal_urls)}</textarea></label>
<div class="grid2">
<label>Время отправки<select name="cal_hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}"${sel(h, s.cal_hour)}>${pad(h)}:00</option>`).join("")}</select></label>
<div></div>
</div>
<input type="hidden" name="cal_tomorrow" value="off">
<label class="switch">Предупреждать и о завтрашних<input type="checkbox" name="cal_tomorrow" value="on"${checked(s.cal_tomorrow)}></label>
<details><summary>Где взять секретный адрес</summary><ol class="steps">
<li>Откройте <b>calendar.google.com</b> на компьютере (или в браузере телефона в режиме «Версия для ПК»).</li>
<li>Советую создать отдельный календарь: слева «Другие календари» → <b>＋ → Создать календарь</b>, например «Ad günləri», и внести дни рождения событиями <b>«Весь день»</b> с повтором <b>«Ежегодно»</b>.</li>
<li>Наведите на этот календарь → ⋮ → <b>Настройки и общий доступ</b> → внизу <b>«Секретный адрес в формате iCal»</b> → скопировать.</li>
<li>Вставьте адрес сюда и сохраните. Нажмите на «Главной» «👀 Что уйдёт», чтобы проверить.</li>
</ol>
<p class="hint">В группу уходят только события «на весь день» — встречи со временем не попадут. Встроенный календарь «Дни рождения» из контактов Google секретного адреса не даёт, поэтому дни рождения лучше завести в своём календаре. Секретный адрес никому не показывайте: по нему можно читать календарь.</p>
</details>
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
  const { s, last, lastHook, gState, gSettings, hookWhere, chatList, chats } = st;
  const v = env.CF_VERSION_METADATA;
  const flags = gSettings.v ? ["incomingWebhook", "outgoingWebhook", "outgoingAPIMessageWebhook"].filter((k) => gSettings.v[k] !== "yes") : [];
  const rows = [
    ["Версия бота", v?.id ? `${esc(v.id.slice(0, 8))}${v.timestamp ? ` · ${bakuTime(Date.parse(v.timestamp))}` : ""}` : "неизвестно"],
    ["Секреты", secretsReport(env)],
    ["WhatsApp", gState.v ? (gState.v.stateInstance === "authorized" ? `<span class="ok">подключён</span>` : `<span class="bad">${esc(gState.v.stateInstance)}</span>`) : `<span class="bad">нет ответа</span>`],
    ["Обрывы связи за 7 дней", (() => {
      const t = connStats(st.connLog, 7);
      if (!st.connLog.length) return "журнал пока пуст";
      if (!t.drops) return `<span class=\"ok\">0</span>`;
      return `<span class=\"bad\">${t.drops}</span> · простой ${fmtDuration(t.downMs)}<br><small>последний: ${bakuTime(t.last.time)} · ${esc(t.last.to)}</small>`;
    })()],
    ["Вебхук в Green API", hookWhere === "ours" ? `<span class="ok">настроен</span>` : hookWhere === "other" ? `<span class="bad">другой адрес</span>` : hookWhere === "none" ? `<span class="bad">не задан</span>` : "—"],
    ["Последнее сообщение из чатов", st.rawHook ? `${ago(st.rawHook.time)} · ${esc(st.rawHook.type)}<br><small>от +${esc(st.rawHook.from)} · тип ${esc(st.rawHook.msgType)}<br>текст: ${st.rawHook.text == null ? "— нет" : `«${esc(st.rawHook.text)}»`}</small>` : "ещё не приходило"],
    ["Последнее сообщение", lastHook ? `${ago(lastHook.time)} · ${lastHook.ok ? `<span class="ok">сохранено</span>` : `<span class="bad">ошибка</span><br><small>${esc(lastHook.note)}</small>`}` : "ещё не приходило"],
    ["Firebase", !firebaseReady(env) ? `<span class="bad">не настроен</span>` : chats.e ? `<span class="bad">ошибка</span>` : `<span class="ok">работает</span> · ${env.FIREBASE_SECRET ? "секрет базы" : "сервисный аккаунт"}`],
  ];
  if (flags.length) rows.push(["Выключено в Green API", `<span class="bad">${flags.join(", ")}</span>`]);
  const hook = env.WEBHOOK_SECRET ? `${origin}/webhook/${env.WEBHOOK_SECRET}` : null;
  return `${subnav("service")}${resultCard(result)}
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
${actionButton("service", "reset", "↺ Сбросить сохранённые баллы", { cls: "danger", confirmText: "Сбросить сохранённые баллы? Следующая проверка запомнит текущие без сообщения." })}
</div>
</section>

${last ? `<details class="card"><summary>Лог последнего запуска · ${bakuTime(last.time)}</summary><pre>${esc(last.log)}</pre></details>` : ""}
${chatList.length ? `<details class="card"><summary>Собранные чаты (${chatList.length})</summary>${chatList.map((ch) => `<div class="chat"><span>${ch.isGroup ? "👥" : "👤"} ${esc(ch.name || ch.chatId)}<br><small>${esc(ch.chatId)}</small></span><span>${ch.count || 0}<br><small>${ch.lastAt ? bakuTime(ch.lastAt * 1000) : ""}</small></span></div>`).join("")}</details>` : ""}
<p class="hint">Расписание в Cloudflare — <code>* * * * *</code> (каждую минуту); как часто проверять экзамен, задаётся в «Настройках».</p>`;
}

async function dashboard(env, origin, { tab = "home", msg = null, result = null, analysis = null, orders = {}, openDay = null } = {}) {
  const st = await gatherStatus(env, origin);
  const toast = msg ? `<div class="toast${msg.bad ? " bad" : ""}" id="flash">${esc(msg.text)}</div>` : "";
  return page("MQM watch", `
<div class="top"><h1>MQM watch</h1><a href="/logout">Выйти</a></div>
${toast}
<div class="panel" id="p-home">${homePanel(env, st, tab === "home" ? result : null)}</div>
<div class="panel" id="p-orders">${ordersPanel(env, st, orders)}</div>
<div class="panel" id="p-house">${housePanel(env, st, origin)}</div>
<div class="panel" id="p-analysis">${analysisPanel(env, st, analysis)}</div>
<div class="panel" id="p-settings">${settingsPanel(st)}</div>
<div class="panel" id="p-lessons">${lessonsPanel(env, st, openDay)}</div>
<div class="panel" id="p-photos">${photosPanel(env, st)}</div>
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
    gemini_model: model,
    gemini_lang: LANGS[lang] ? lang : old.gemini_lang,
    cal_urls: (() => {
      const urls = str("cal_urls").split(/\s+/).filter(Boolean);
      const bad = urls.find((x) => !/^(https|webcal):\/\/\S+$/i.test(x));
      if (bad) throw new Error(`Адрес календаря должен начинаться с https:// — «${bad.slice(0, 40)}»`);
      return urls.join("\n");
    })(),
    cal_holidays: HOLIDAY_LANGS[str("cal_holidays")] ? str("cal_holidays") : "",
    cal_hour: int("cal_hour", 0, 23, "Время календаря"),
    cal_tomorrow: f.getAll("cal_tomorrow").includes("on"),
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
  cal_enabled: ["Календарь включён", "Календарь выключен"],
  sched_enabled: ["Сообщения об уроках включены", "Сообщения об уроках выключены"],
  photo_enabled: ["Фото дня включено", "Фото дня выключено"],
};

async function toggleSetting(f, env) {
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
  calendar: "см. подробности: что ушло в группу",
  dump: "ниже текст страницы экзамена и что из него понял бот",
};

async function doAction(env, action, origin) {
  const s = await loadSettings(env);
  const base = { exam: false, weather: false, calendar: false, test: false, dump: false };
  const opts = {
    exam: { exam: true },
    test: { exam: true, test: true },
    weather: { weather: true, test: true },
    calendar: { calendar: true, test: true },
    dump: { dump: true },
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
  if (action === "calendar_preview") {
    const c = config(env, s);
    try {
      const msg = await calendarMessage(c, bakuNow());
      return { ok: true, summary: msg ? "вот что уйдёт в группу (ничего не отправлено)" : "на сегодня и завтра событий нет", log: [msg, ...c.lines].filter(Boolean).join("\n\n"), open: true };
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
    if (env.MQM_KV && Math.floor(event.scheduledTime / 60000) % CONN_CHECK_EVERY === 0) {
      try {
        await checkConnection(env, s);
      } catch (e) {
        console.log("ОШИБКА проверки связи:", e.message);
      }
    }
    if (env.MQM_KV && tuyaReady(env)) {
      try {
        await runTimers(env, s);
      } catch (e) {
        console.log("ОШИБКА таймеров:", e.message);
      }
    }
    if (env.MQM_KV) {
      try {
        await runLessons(env, s);
      } catch (e) {
        console.log("ОШИБКА уроков:", e.message);
      }
      try {
        await runPhotos(env, s);
      } catch (e) {
        console.log("ОШИБКА фото дня:", e.message);
      }
    }
    if (!s.enabled) return;
    const tick = Math.floor(event.scheduledTime / 60000);
    const res = await run(env, s, {
      exam: s.exam_enabled && tick % s.interval === 0,
      weather: s.weather_enabled,
      calendar: s.cal_enabled,
      test: false, dump: false,
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
        dump: flag(p, "dump", false),
      }, "по ссылке");
      return new Response((res.ok ? "OK\n\n" : "ОШИБКА\n\n") + res.log, {
        status: res.ok ? 200 : 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (path.startsWith("/camera/")) {
      const token = await cameraToken(env);
      if (!token || path !== `/camera/${token}`) return new Response("Not found", { status: 404 });
      let ev = Object.fromEntries(url.searchParams);
      if (request.method === "POST") {
        const type = request.headers.get("Content-Type") || "";
        try {
          if (type.includes("json")) ev = { ...ev, ...(await request.json()) };
          else if (type.includes("form")) ev = { ...ev, ...Object.fromEntries([...(await request.formData())].map(([k, v]) => [k, String(v)])) };
          else ev.text = ev.text || (await request.text());
        } catch {
          return Response.json({ ok: false, error: "непонятное тело запроса" }, { status: 400 });
        }
      }
      try {
        return Response.json({ ok: true, ...(await cameraEvent(env, ev)) });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (path.startsWith("/webhook/")) {
      if (!env.WEBHOOK_SECRET || path !== `/webhook/${env.WEBHOOK_SECRET}`) {
        ctx.waitUntil(noteWebhook(env, false, "пришёл на адрес с другим секретом — нажмите «Подключить вебхук в Green API»", true));
        return new Response("Not found", { status: 404 });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }
      ctx.waitUntil(handleCommand(env, body).catch((e) => console.log("ОШИБКА команды:", e.message)));
      ctx.waitUntil(handlePhoto(env, body).catch((e) => console.log("ОШИБКА фото:", e.message)));
      ctx.waitUntil(noteRawHook(env, body));
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
      if (key !== env.RUN_KEY) {
        await new Promise((r) => setTimeout(r, 1500)); // замедляет подбор пароля
        return loginPage("Неверный пароль");
      }
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

    if (!["/", "/save", "/toggle", "/action", "/analyze", "/house", "/lessons", "/photos", "/photo"].includes(path)) return new Response("Not found", { status: 404 });
    if (!(await isAuthed(request, env))) return loginPage();
    const back = (tab, text, bad = false, extra = "") => new Response(null, {
      status: 303,
      headers: { Location: `/?msg=${encodeURIComponent(text)}${bad ? "&bad=1" : ""}${extra}#${tab}` },
    });

    if (path === "/save" && request.method === "POST") {
      try {
        return back("settings", await saveSettings(request, env));
      } catch (e) {
        return dashboard(env, url.origin, { tab: "settings", msg: { text: `Не сохранено: ${e.message}`, bad: true } });
      }
    }

    if (path === "/toggle" && request.method === "POST") {
      const form = await request.formData();
      const tab = TABS.includes(String(form.get("tab"))) ? String(form.get("tab")) : "home";
      try {
        return back(tab, await toggleSetting(form, env));
      } catch (e) {
        return back(tab, e.message, true);
      }
    }

    if (path === "/lessons" && request.method === "POST") {
      const form = await request.formData();
      const extra = form.get("do") === "day_save" ? `&open=${encodeURIComponent(String(form.get("day")))}` : ""; // правленый день остаётся открытым
      try {
        return back("lessons", await lessonsAction(env, form), false, extra);
      } catch (e) {
        return back("lessons", e.message, true, extra);
      }
    }

    if (path === "/photo") { // превью фото из очереди (только для вошедших)
      const k = url.searchParams.get("k") || "";
      if (!photoReady(env) || !/^(queue|cam)\/[\w.-]+$/.test(k)) return new Response("Not found", { status: 404 });
      const obj = await photoStore(env).get(k);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.bytes, { headers: { "Content-Type": obj.type, "Cache-Control": "private, max-age=86400" } });
    }

    if (path === "/photos" && request.method === "POST") {
      const form = await request.formData();
      try {
        return back("photos", await photosAction(env, form, form.getAll("file")));
      } catch (e) {
        return back("photos", e.message, true);
      }
    }

    if (path === "/house" && request.method === "POST") {
      const form = await request.formData();
      const tab = TABS.includes(String(form.get("back"))) ? String(form.get("back")) : "house";
      try {
        return back(tab, await houseAction(env, form));
      } catch (e) {
        return back(tab, e.message, true);
      }
    }

    if (path === "/analyze" && request.method === "POST") {
      const form = await request.formData();
      let res;
      try {
        res = await analyze(env, form);
      } catch (e) {
        res = {
          a: { chats: form.getAll("chat").map(String), hours: Number(form.get("period")) || 24, question: String(form.get("question") || ""), lang: String(form.get("lang") || "") },
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
      openDay: q.get("open"),
    });
  },
};
