// MQM watch на Cloudflare Workers: баллы с kabinet.mqm.az и утренний прогноз погоды
// в WhatsApp-группу через Green API.
//
// Привязки и секреты (Settings → Variables and Secrets / Bindings):
//   MQM_KV              - KV namespace (состояние)
//   GREEN_ID_INSTANCE   - idInstance (secret)
//   GREEN_API_TOKEN     - apiTokenInstance (secret)
//   GREEN_CHAT_ID       - id группы, можно без @g.us (secret)
//   RUN_KEY             - ключ для ручного запуска по ссылке (secret)
//   GREEN_API_URL       - (необязательно) хост инстанса, по умолчанию https://api.green-api.com
//   MQM_URL             - (необязательно) ссылка на результат
//   WEATHER_PLACE / WEATHER_LAT / WEATHER_LON / WEATHER_SEND_HOUR / WEATHER_HOURS - (необязательно)
//
// Ручной запуск: https://<worker>.workers.dev/run?key=RUN_KEY&exam=1&weather=1&test=0&clean=0&dump=0

const DEFAULT_URL = "https://kabinet.mqm.az/result/1505867/e40b3558-d105-4cc5-8752-594581ee467a";
const SUBJECTS = ["İngilis dili", "Azərbaycan dili", "Riyaziyyat"];
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

function config(env) {
  let chat = (env.GREEN_CHAT_ID || "").trim();
  if (chat && !chat.includes("@")) chat += "@g.us";
  return {
    env,
    kv: env.MQM_KV,
    url: env.MQM_URL || DEFAULT_URL,
    api: (env.GREEN_API_URL || "https://api.green-api.com").replace(/\/+$/, ""),
    id: (env.GREEN_ID_INSTANCE || "").trim(),
    token: (env.GREEN_API_TOKEN || "").trim(),
    chat,
    cleanCount: parseInt(env.CLEAN_HISTORY_COUNT || "200", 10),
    place: env.WEATHER_PLACE || "Pirşağı",
    lat: env.WEATHER_LAT || "40.49",
    lon: env.WEATHER_LON || "50.01",
    sendHour: parseInt(env.WEATHER_SEND_HOUR || "7", 10),
    hours: parseInt(env.WEATHER_HOURS || "24", 10),
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
  const res = await fetch(c.url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Сайт MQM ответил ${res.status}`);
  let raw = await res.text();
  raw = raw.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  return unescapeHtml(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parse(text) {
  const m = text.match(/Yekun nəticə:\s*([\d.]+)\s*\/\s*Maksimum:\s*(\d+)/);
  if (!m) throw new Error("Не нашёл 'Yekun nəticə' на странице (формат изменился?)");
  const data = { total: parseFloat(m[1]), max: parseFloat(m[2]), subjects: {} };

  // начало блока каждого предмета -> блок идёт до начала следующего
  const starts = [];
  for (const name of SUBJECTS) {
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

function fmt(old, cur) {
  const lines = [
    "📊 Asim Qaraxanov — nəticə yeniləndi",
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
  const text = await fetchText(c);
  if (opts.dump) {
    c.log(text);
    c.log("\nНАЙДЕНО:", parse(text));
    return;
  }
  const cur = parse(text);

  if (opts.test) {
    await send(c, "✅ Test: MQM watch işləyir\n" + fmt(null, cur).split("\n").slice(1).join("\n"));
    return;
  }

  const old = await c.kv.get("state", "json");
  if (!old) {
    await c.kv.put("state", JSON.stringify(cur));
    c.log("Первый запуск, сохранил базовое значение:", cur);
    return;
  }

  if (cur.total !== old.total || !sameSubjects(cur.subjects, norm(old.subjects))) {
    await send(c, fmt(old, cur)); // состояние сохраняем только после успешной отправки
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

// ---------------- Уборка старых сообщений бота ----------------

// Удаляет у всех сообщения бота старше сегодняшних 00:00 (Баку).
// Если сегодня не было сообщения с баллами — оставляет последнее более раннее.
async function cleanupOld(c, dry) {
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
    const when = new Date(m.timestamp * 1000 + BAKU_OFFSET_MS);
    const label = `${dm(when)} ${hm(when)} «${m.textMessage.split("\n")[0].slice(0, 40)}»`;
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
    latitude: c.lat,
    longitude: c.lon,
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
  const end = addHours(start, c.hours);
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
    `🌦 ${c.place} — hava proqnozu`,
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

// Раз в сутки после WEATHER_SEND_HOUR (по Баку): уборка старых сообщений, затем прогноз.
// force=true — тест: уборка в пробном режиме (ничего не удаляет), дата отправки не пишется.
async function dailyWeather(c, force) {
  const now = bakuNow();
  const today = ymd(now);
  const last = await c.kv.get("weather_date");
  if (!force && (now.getUTCHours() < c.sendHour || last === today)) {
    c.log(last === today ? "Погода: сегодня уже отправлена" : `Погода: ещё рано (шлём после ${c.sendHour}:00 по Баку)`);
    return;
  }
  let cleanError = null;
  try {
    await cleanupOld(c, force);
  } catch (e) { // сбой уборки не должен лишать прогноза
    cleanError = e;
    c.log("ОШИБКА уборки:", e.message);
  }
  const tomorrow = ymd(addHours(now, 24));
  await send(c, fmtWeather(c, await fetchWeather(c, today, tomorrow), now));
  if (!force) await c.kv.put("weather_date", today);
  if (cleanError) throw cleanError;
}

// ---------------- Запуск ----------------

async function run(env, opts) {
  const c = config(env);
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
  if (!steps.length) c.log("Нечего делать: exam=0 и weather=0");
  // баллы и погода независимы: сбой одного не мешает другому
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (e) {
      ok = false;
      c.log(`ОШИБКА (${name}):`, e.message);
    }
  }
  return { ok, log: c.lines.join("\n") };
}

function flag(params, name, def) {
  const v = params.get(name);
  if (v === null) return def;
  return ["1", "true", "yes", "on", "da", "bəli"].includes(v.trim().toLowerCase());
}

export default {
  async scheduled(event, env, ctx) {
    const res = await run(env, { exam: true, weather: true, test: false, clean: false, dump: false });
    if (!res.ok) throw new Error(res.log);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") return new Response("Not found", { status: 404 });
    if (!env.RUN_KEY || url.searchParams.get("key") !== env.RUN_KEY) {
      return new Response("Forbidden", { status: 403 });
    }
    const p = url.searchParams;
    const res = await run(env, {
      exam: flag(p, "exam", true),
      weather: flag(p, "weather", true),
      test: flag(p, "test", false),
      clean: flag(p, "clean", false),
      dump: flag(p, "dump", false),
    });
    return new Response((res.ok ? "OK\n\n" : "ОШИБКА\n\n") + res.log, {
      status: res.ok ? 200 : 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
