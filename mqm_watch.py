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
"""
import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
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


def main():
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


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("ОШИБКА:", e, file=sys.stderr)
        sys.exit(1)
