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
"""
import html
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

URL = os.environ.get(
    "MQM_URL",
    "https://kabinet.mqm.az/result/1505867/e40b3558-d105-4cc5-8752-594581ee467a",
)
STATE = Path(os.environ.get("MQM_STATE", Path(__file__).with_name("mqm_state.json")))
API = os.environ.get("GREEN_API_URL", "https://api.green-api.com").rstrip("/")
ID = os.environ.get("GREEN_ID_INSTANCE", "")
TOKEN = os.environ.get("GREEN_API_TOKEN", "")
CHAT = os.environ.get("GREEN_CHAT_ID", "")

SUBJECTS = ["İngilis dili", "Azərbaycan dili", "Riyaziyyat"]


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
    for name in SUBJECTS:
        s = re.search(
            re.escape(name) + r"\s*\(Maksimum:\s*\d+\).*?Nəticə:\s*([\d.]+)", text
        )
        if s:
            data["subjects"][name] = float(s.group(1))
    return data


def send(message):
    if not (ID and TOKEN and CHAT):
        raise RuntimeError("Не заданы GREEN_ID_INSTANCE / GREEN_API_TOKEN / GREEN_CHAT_ID")
    body = json.dumps({"chatId": CHAT, "message": message}).encode()
    req = urllib.request.Request(
        f"{API}/waInstance{ID}/sendMessage/{TOKEN}",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    print("Green API:", urllib.request.urlopen(req, timeout=30).read().decode())


def fmt(old, new):
    lines = [
        "📊 Asim Qaraxanov — результат обновлён",
        f"Итог: {old['total']} → {new['total']} / {new['max']:g}"
        if old
        else f"Итог: {new['total']} / {new['max']:g}",
    ]
    for name, val in new["subjects"].items():
        prev = (old or {}).get("subjects", {}).get(name)
        if prev is not None and prev != val:
            lines.append(f"• {name}: {prev} → {val}")
        else:
            lines.append(f"• {name}: {val}")
    return "\n".join(lines)


def main():
    new = parse(fetch_text())

    if os.environ.get("MQM_TEST") == "true":
        send("✅ Тест: MQM watch работает\n" + fmt(None, new).split("\n", 1)[1])
        return

    old = json.loads(STATE.read_text()) if STATE.exists() else None

    if old is None:
        STATE.write_text(json.dumps(new, ensure_ascii=False))
        print("Первый запуск, сохранил базовое значение:", new)
        return

    if new["total"] != old["total"] or new["subjects"] != old["subjects"]:
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
