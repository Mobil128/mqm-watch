#!/usr/bin/env python3
"""Проверяет результат на kabinet.mqm.az и пишет в WhatsApp-группу (Green API),
если изменился общий балл или балл по предметам.

Настройки через переменные окружения:
  GREEN_ID_INSTANCE   - idInstance
  GREEN_API_TOKEN     - apiTokenInstance
  GREEN_CHAT_ID       - id группы, вида 1203630xxxxxxxx@g.us
  GREEN_API_URL       - (необязательно) хост инстанса, по умолчанию https://api.green-api.com
  MQM_URL             - (необязательно) ссылка на результат
  MQM_TEST            - (необязательно) "true": отправить тестовое сообщение
  MQM_DUMP            - (необязательно) "true": только вывести текст страницы и что нашлось

Прогноз погоды (раз в сутки, Open-Meteo, без ключа), всё необязательно:
  WEATHER_PLACE       - название в сообщении, по умолчанию Pirşağı
  WEATHER_LAT/LON     - координаты, по умолчанию 40.49 / 50.01 (Pirşağı, Баку)
  WEATHER_SEND_HOUR   - во сколько (по Баку) слать, по умолчанию 7
  MQM_CLEAN           - (необязательно) "true": удалить старые сообщения бота сейчас (без погоды)

Уборка: перед утренним прогнозом бот удаляет у всех свои сообщения старше сегодняшнего дня.
Если сегодня сообщений с баллами не было — последнее вчерашнее с баллами остаётся.

  WEATHER_HOURS       - сколько часов вперёд показывать (с текущего часа), по умолчанию 24
"""
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

URL = os.environ.get(
    "MQM_URL",
    "https://kabinet.mqm.az/result/1505867/e40b3558-d105-4cc5-8752-594581ee467a",
)
STATE = Path(os.environ.get("MQM_STATE", Path(__file__).with_name("mqm_state.json")))
API = os.environ.get("GREEN_API_URL", "https://api.green-api.com").rstrip("/")
ID = os.environ.get("GREEN_ID_INSTANCE", "").strip()
TOKEN = os.environ.get("GREEN_API_TOKEN", "").strip()
CHAT = os.environ.get("GREEN_CHAT_ID", "").strip()
if CHAT and "@" not in CHAT:  # указан только номер группы
    CHAT += "@g.us"

SUBJECTS = ["İngilis dili", "Azərbaycan dili", "Riyaziyyat"]

# Подписи счётчиков на странице (внутри блока каждого предмета)
COUNTERS = {
    "correct": r"Doğru cavabların sayı:\s*(\d+)",
    "wrong": r"Yanlış cavabların sayı:\s*(\d+)",
    "unverified": r"Qiymətləndirilməyib:\s*(\d+)",  # открытые вопросы на проверке
}


def fetch_text():
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    raw = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
    raw = re.sub(r"(?is)<(script|style).*?</\1>", " ", raw)
    text = html.unescape(re.sub(r"<[^>]+>", " ", raw))
    return re.sub(r"\s+", " ", text)


def parse(text):
    m = re.search(r"Yekun nəticə:\s*([\d.]+)\s*/\s*Maksimum:\s*(\d+)", text)
    if not m:
        raise RuntimeError("Не нашёл 'Yekun nəticə' на странице (формат изменился?)")
    data = {"total": float(m.group(1)), "max": float(m.group(2)), "subjects": {}}

    # начало блока каждого предмета -> блок идёт до начала следующего
    starts = []
    for name in SUBJECTS:
        h = re.search(re.escape(name) + r"\s*\(Maksimum:\s*\d+\)", text)
        if h:
            starts.append((h.start(), name))
    starts.sort()
    for i, (pos, name) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(text)
        block = text[pos:end]
        s = re.search(r"Nəticə:\s*([\d.]+)", block)
        if not s:
            continue
        subj = {"score": float(s.group(1))}
        subj.update(parse_counters(block))
        data["subjects"][name] = subj
    return data


def parse_counters(block):
    """Берёт счётчики из блока предмета. Что не нашлось — пропускает."""
    found = {}
    for key, pat in COUNTERS.items():
        m = re.search(pat, block)
        if m:
            found[key] = int(m.group(1))
    # когда непроверенных не осталось, сайт убирает эту строку совсем
    if "correct" in found and "wrong" in found:
        found.setdefault("unverified", 0)
    return found


def send(message):
    if not (ID and TOKEN and CHAT):
        raise RuntimeError("Не заданы GREEN_ID_INSTANCE / GREEN_API_TOKEN / GREEN_CHAT_ID")
    body = json.dumps({"chatId": CHAT, "message": message}).encode()
    req = urllib.request.Request(
        f"{API}/waInstance{ID}/sendMessage/{TOKEN}",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        print("Green API:", urllib.request.urlopen(req, timeout=30).read().decode())
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"Green API {e.code}: {err}")


def norm(subjects):
    """Старый формат состояния (число) -> новый (словарь)."""
    return {k: v if isinstance(v, dict) else {"score": v} for k, v in (subjects or {}).items()}


def chg(prev, cur):
    return f"{prev}→{cur}" if prev is not None and prev != cur else f"{cur}"


def fmt(old, new):
    lines = [
        "📊 Asim Qaraxanov — nəticə yeniləndi",
        f"Yekun: {old['total']} → {new['total']} / {new['max']:g}"
        if old
        else f"Yekun: {new['total']} / {new['max']:g}",
    ]
    olds = norm((old or {}).get("subjects"))
    for name, cur in new["subjects"].items():
        prev = olds.get(name, {})
        score = chg(prev.get("score"), cur["score"]).replace("→", " → ")
        line = f"• {name}: {score}"
        parts = [
            f"{icon} {chg(prev.get(key), cur[key])}"
            for key, icon in (("correct", "✅"), ("wrong", "❌"), ("unverified", "⏳"))
            if key in cur
        ]
        if parts:
            line += " (" + " | ".join(parts) + ")"
        lines.append(line)
    return "\n".join(lines)


# ---------------- Уборка старых сообщений бота ----------------
# Трогаем ТОЛЬКО свои исходящие сообщения, начинающиеся с этих значков.
# Любые другие сообщения с этого же номера (написанные вручную) не затрагиваются.
SCORE_PREFIX = "📊"
BOT_PREFIXES = (SCORE_PREFIX, "🌦", "✅ Test")
CLEAN_COUNT = int(os.environ.get("CLEAN_HISTORY_COUNT", "200"))


def api_call(method, payload):
    req = urllib.request.Request(
        f"{API}/waInstance{ID}/{method}/{TOKEN}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        raw = urllib.request.urlopen(req, timeout=60).read().decode()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Green API {method} {e.code}: {e.read().decode('utf-8', 'replace')}")
    return json.loads(raw) if raw else None


def cleanup_old(dry=False):
    """Удаляет у всех сообщения бота старше сегодняшних 00:00 (Баку).
    Если сегодня не было сообщения с баллами — оставляет последнее более раннее."""
    if not (ID and TOKEN and CHAT):
        raise RuntimeError("Не заданы GREEN_ID_INSTANCE / GREEN_API_TOKEN / GREEN_CHAT_ID")
    cutoff = datetime.now(BAKU).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    history = api_call("getChatHistory", {"chatId": CHAT, "count": CLEAN_COUNT}) or []

    mine = []
    for m in history:
        text = m.get("textMessage")
        if m.get("type") == "outgoing" and isinstance(text, str) and text.startswith(BOT_PREFIXES):
            mine.append(m)
    mine.sort(key=lambda m: m.get("timestamp", 0))

    old = [m for m in mine if m.get("timestamp", 0) < cutoff]
    score_today = any(
        m["textMessage"].startswith(SCORE_PREFIX) and m.get("timestamp", 0) >= cutoff for m in mine
    )
    keep = None
    if not score_today:
        olds_scores = [m for m in old if m["textMessage"].startswith(SCORE_PREFIX)]
        keep = olds_scores[-1] if olds_scores else None
    todo = [m for m in old if m is not keep]

    print(f"История: {len(history)} сообщений, моих: {len(mine)}, к удалению: {len(todo)}"
          + (f", оставляю: {keep['idMessage']}" if keep else ""))
    failed = deleted = gone = 0
    for m in todo:
        when = datetime.fromtimestamp(m["timestamp"], BAKU).strftime("%d.%m %H:%M")
        first = m["textMessage"].split("\n")[0][:40]
        if dry:
            print(f"  [пробный режим] удалил бы {when} «{first}»")
            continue
        try:
            api_call("deleteMessage", {"chatId": CHAT, "idMessage": m["idMessage"], "onlySenderDelete": False})
            deleted += 1
            print(f"  удалено {when} «{first}»")
        except Exception as e:
            if "already was deleted" in str(e):
                gone += 1  # в истории ещё числится, но уже удалено — это нормально
                continue
            failed += 1  # например, слишком старое: WhatsApp не даёт удалить у всех
            print(f"  не удалось {when} «{first}»: {e}", file=sys.stderr)
        time.sleep(1)
    if not dry:
        print(f"Готово: удалено {deleted}, уже было удалено {gone}, не удалось {failed}")
    if failed:
        raise RuntimeError(f"Не удалось удалить {failed} сообщ.")


# ---------------- Прогноз погоды ----------------
BAKU = timezone(timedelta(hours=4))  # Азербайджан без перехода на летнее время
W_STATE = Path(os.environ.get("WEATHER_STATE", Path(__file__).with_name("mqm_weather.json")))
W_PLACE = os.environ.get("WEATHER_PLACE", "Pirşağı")
W_LAT = os.environ.get("WEATHER_LAT", "40.49")
W_LON = os.environ.get("WEATHER_LON", "50.01")
W_SEND = int(os.environ.get("WEATHER_SEND_HOUR", "7"))
W_HOURS = int(os.environ.get("WEATHER_HOURS", "24"))

WEEKDAYS = ["Bazar ertəsi", "Çərşənbə axşamı", "Çərşənbə", "Cümə axşamı", "Cümə", "Şənbə", "Bazar"]
# откуда дует ветер (метеорологическая договорённость: «şimal küləyi» = с севера)
DIRS = ["şimal", "şimal-şərq", "şərq", "cənub-şərq", "cənub", "cənub-qərb", "qərb", "şimal-qərb"]
STRONG_GUST = 50  # км/ч: от этого значения ставим ⚠️


def fetch_weather(start_day, end_day):
    qs = urllib.parse.urlencode({
        "latitude": W_LAT,
        "longitude": W_LON,
        "hourly": "precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,wind_direction_10m",
        "wind_speed_unit": "kmh",
        "timezone": "Asia/Baku",
        "start_date": start_day,
        "end_date": end_day,
    })
    req = urllib.request.Request(
        "https://api.open-meteo.com/v1/forecast?" + qs, headers={"User-Agent": "Mozilla/5.0"}
    )
    return json.loads(urllib.request.urlopen(req, timeout=30).read().decode())["hourly"]


def fmt_weather(h, now):
    start = now.replace(minute=0, second=0, microsecond=0, tzinfo=None)
    end = start + timedelta(hours=W_HOURS)
    rows = []
    for i, t in enumerate(h["time"]):
        dt = datetime.fromisoformat(t)
        if not (start <= dt < end):
            continue
        rows.append({
            "dt": dt,
            "rain": h["precipitation"][i] or 0.0,
            "prob": h["precipitation_probability"][i],
            "wind": h["wind_speed_10m"][i] or 0.0,
            "gust": h["wind_gusts_10m"][i] or 0.0,
            "dir": DIRS[round((h["wind_direction_10m"][i] or 0) / 45) % 8],
        })
    if not rows:
        raise RuntimeError("В ответе погоды нет нужных часов")

    total = sum(r["rain"] for r in rows)
    peak = max(rows, key=lambda r: r["gust"])
    last = rows[-1]["dt"]
    lines = [
        f"🌦 {W_PLACE} — hava proqnozu",
        f"{WEEKDAYS[now.weekday()]}, {now:%d.%m.%Y}, {rows[0]['dt']:%H:%M} → {last:%d.%m %H:%M}",
        "",
        f"🌧 Yağış: {total:.1f} mm" if total >= 0.1 else "☀️ Yağış gözlənilmir",
        f"💨 Ən güclü külək: {peak['gust']:.0f} km/saat, {peak['dt']:%d.%m} saat {peak['dt']:%H:%M}",
        "",
    ]
    day = rows[0]["dt"].date()
    for r in rows:
        if r["dt"].date() != day:  # перешли за полночь
            day = r["dt"].date()
            lines.append(f"— {day:%d.%m} —")
        rain = (
            f"🌧 {r['rain']:.1f} mm ({r['prob']}%)"
            if r["rain"] >= 0.1
            else (f"yağış yox ({r['prob']}%)" if r["prob"] else "yağış yox")
        )
        warn = " ⚠️" if r["gust"] >= STRONG_GUST else ""
        lines.append(
            f"{r['dt']:%H:%M} · {rain} · 💨 {r['wind']:.0f} ({r['gust']:.0f}) km/saat, {r['dir']}{warn}"
        )
    lines += ["", "Mötərizədə: yağış ehtimalı (%) və ani külək (km/saat)"]
    return "\n".join(lines)


def daily_weather(force=False):
    """Раз в сутки после WEATHER_SEND_HOUR (по Баку): уборка старых сообщений, затем прогноз.
    force=True — тест: уборка в пробном режиме (ничего не удаляет), состояние не пишется."""
    now = datetime.now(BAKU)
    today = now.strftime("%Y-%m-%d")
    last = json.loads(W_STATE.read_text()).get("date") if W_STATE.exists() else None
    if not force and (now.hour < W_SEND or last == today):
        return
    clean_error = None
    try:
        cleanup_old(dry=force)
    except Exception as e:  # сбой уборки не должен лишать прогноза
        clean_error = e
        print("ОШИБКА уборки:", e, file=sys.stderr)
    tomorrow = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    send(fmt_weather(fetch_weather(today, tomorrow), now))
    if not force:
        W_STATE.write_text(json.dumps({"date": today}))
    if clean_error:
        raise clean_error


def check_results():
    text = fetch_text()
    if os.environ.get("MQM_DUMP") == "true":
        print(text)
        print("\nНАЙДЕНО:", parse(text))
        return
    new = parse(text)

    if os.environ.get("MQM_TEST") == "true":
        send("✅ Test: MQM watch işləyir\n" + fmt(None, new).split("\n", 1)[1])
        return

    old = json.loads(STATE.read_text()) if STATE.exists() else None

    if old is None:
        STATE.write_text(json.dumps(new, ensure_ascii=False))
        print("Первый запуск, сохранил базовое значение:", new)
        return

    if new["total"] != old["total"] or new["subjects"] != norm(old["subjects"]):
        send(fmt(old, new))  # состояние сохраняем только после успешной отправки
        STATE.write_text(json.dumps(new, ensure_ascii=False))
    else:
        print("Без изменений:", new["total"])


def main():
    if os.environ.get("MQM_DUMP") == "true":
        check_results()
        return
    if os.environ.get("MQM_CLEAN") == "true":
        cleanup_old(dry=False)
        return
    failed = False
    # баллы и погода независимы: сбой одного не мешает другому
    for step in (check_results, lambda: daily_weather(os.environ.get("MQM_TEST") == "true")):
        try:
            step()
        except Exception as e:
            print("ОШИБКА:", e, file=sys.stderr)
            failed = True
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
