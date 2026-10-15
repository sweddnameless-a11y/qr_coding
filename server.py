from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, SecretStr
from dotenv import load_dotenv

load_dotenv()

from pymirea import Config, MireaAPI, MireaAuth, configure
from pymirea.crypto import get_crypto

# Avoid routine library logs from accidentally including request URLs/tokens.
logging.getLogger("pymirea").setLevel(logging.ERROR)

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(ROOT / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "mirea_sessions.sqlite3"
SESSION_TTL_SECONDS = 14 * 24 * 60 * 60
PENDING_TTL_SECONDS = 5 * 60
SESSION_COOKIE = "mirea_sid"
PENDING_COOKIE = "mirea_pending"
ALLOWED_HOSTS = {
    "pulse.mirea.ru",
    "attendance-app.mirea.ru",
    "attendance.mirea.ru",
    "att.mirea.ru",
}
APP_ORIGIN = os.environ.get("APP_ORIGIN", "").rstrip("/")
SESSION_KEYS = os.environ.get("MIREA_SESSION_KEYS", "").strip()

# A fresh temporary key allows local smoke testing. For any deployment, set
# MIREA_SESSION_KEYS to a stable base64-encoded 32-byte key in the host's secrets.
if not SESSION_KEYS:
    if APP_ORIGIN.startswith("https://"):
        raise RuntimeError("MIREA_SESSION_KEYS is required for HTTPS deployment; generate a Base64-encoded 32-byte key and store it as a secret.")
    SESSION_KEYS = base64.b64encode(secrets.token_bytes(32)).decode("ascii")
    print("WARNING: MIREA_SESSION_KEYS not set. A temporary local-development key was generated; sessions will be unreadable after restart.")
else:
    try:
        decoded_key = base64.b64decode(SESSION_KEYS, validate=True)
    except Exception as exc:
        raise RuntimeError("MIREA_SESSION_KEYS must be a valid Base64-encoded 32-byte key.") from exc
    if len(decoded_key) != 32:
        raise RuntimeError("MIREA_SESSION_KEYS must decode to exactly 32 bytes.")
configure(Config(session_keys=SESSION_KEYS))
_crypto = get_crypto()

app = FastAPI(title="MIREA QR personal attendance helper", docs_url=None, redoc_url=None, openapi_url=None)

# Short-lived in-memory state only for an in-progress 2FA exchange. No passwords
# are placed in these objects or in the persistent session database.
pending_logins: dict[str, dict[str, Any]] = {}
login_attempts: dict[str, list[float]] = {}


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db() -> None:
    with _db() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS sessions (
            sid_hash TEXT PRIMARY KEY,
            encrypted_session TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        )""")


_init_db()


def _is_https_deployment() -> bool:
    if APP_ORIGIN:
        return APP_ORIGIN.startswith("https://")
    return False


def _cookie_secure() -> bool:
    return _is_https_deployment()


def _hash_sid(sid: str) -> str:
    return hashlib.sha256(sid.encode("utf-8")).hexdigest()


def _require_same_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin:
        raise HTTPException(status_code=403, detail="Запрос без Origin отклонён.")
    if APP_ORIGIN:
        expected = APP_ORIGIN
    else:
        expected = str(request.base_url).rstrip("/")
    if origin.rstrip("/") != expected:
        raise HTTPException(status_code=403, detail="Источник запроса не совпадает с адресом приложения.")
    if not _is_https_deployment() and request.url.hostname not in {"localhost", "127.0.0.1"}:
        raise HTTPException(
            status_code=400,
            detail="Для передачи учётных данных нужен HTTPS. Укажи APP_ORIGIN=https://твой-домен.",
        )


def _rate_limit_login(request: Request) -> None:
    key = request.client.host if request.client else "unknown"
    now = time.time()
    recent = [t for t in login_attempts.get(key, []) if now - t < 15 * 60]
    if len(recent) >= 8:
        raise HTTPException(status_code=429, detail="Слишком много попыток входа. Подожди 15 минут.")
    recent.append(now)
    login_attempts[key] = recent


def _extract_tokens(result: Any) -> dict[str, Any] | None:
    for attr in ("tokens", "cookies"):
        value = getattr(result, attr, None)
        if isinstance(value, dict) and value:
            return value
    return None


def _result_message(result: Any, fallback: str) -> str:
    msg = getattr(result, "message", None)
    if isinstance(msg, str) and msg.strip():
        return msg[:500]
    return fallback


async def _close_auth(auth: Any) -> None:
    close = getattr(auth, "close", None)
    if callable(close):
        try:
            value = close()
            if asyncio.iscoroutine(value):
                await value
        except Exception:
            pass


def _save_session(session: dict[str, Any]) -> str:
    sid = secrets.token_urlsafe(36)
    encrypted = _crypto.encrypt_session(session)
    if isinstance(encrypted, bytes):
        encrypted = encrypted.decode("utf-8")
    now = int(time.time())
    with _db() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        conn.execute(
            "INSERT INTO sessions (sid_hash, encrypted_session, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (_hash_sid(sid), str(encrypted), now, now + SESSION_TTL_SECONDS),
        )
    return sid


def _load_session(request: Request) -> tuple[str, dict[str, Any]] | None:
    sid = request.cookies.get(SESSION_COOKIE)
    if not sid:
        return None
    sid_hash = _hash_sid(sid)
    now = int(time.time())
    with _db() as conn:
        row = conn.execute(
            "SELECT encrypted_session, expires_at FROM sessions WHERE sid_hash = ?",
            (sid_hash,),
        ).fetchone()
        if not row:
            return None
        if row["expires_at"] < now:
            conn.execute("DELETE FROM sessions WHERE sid_hash = ?", (sid_hash,))
            return None
    try:
        session = _crypto.decrypt_session(row["encrypted_session"])
        if not isinstance(session, dict) or not session:
            raise ValueError("empty session")
        return sid_hash, session
    except Exception:
        with _db() as conn:
            conn.execute("DELETE FROM sessions WHERE sid_hash = ?", (sid_hash,))
        return None


def _set_session_cookie(response: Response, sid: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=sid,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=_cookie_secure(),
        samesite="strict",
        path="/",
    )


def _clear_pending_cookie(response: Response) -> None:
    response.delete_cookie(PENDING_COOKIE, path="/", httponly=True, secure=_cookie_secure(), samesite="strict")


def _validate_qr_data(raw: str) -> tuple[str, str]:
    text = str(raw or "").strip()
    if not text or len(text) > 2048:
        raise HTTPException(status_code=400, detail="QR-ссылка пуста или слишком длинная.")
    try:
        parsed = urlsplit(text)
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError:
        raise HTTPException(status_code=400, detail="Некорректный URL QR-кода.")
    if parsed.scheme != "https" or host not in ALLOWED_HOSTS or parsed.username or parsed.password or (port not in (None, 443)):
        raise HTTPException(status_code=400, detail="QR должен быть HTTPS-ссылкой с разрешённого домена МИРЭА.")
    if not parsed.path or not parsed.query:
        raise HTTPException(status_code=400, detail="QR-ссылка не содержит ожидаемые путь и параметры.")
    params = parse_qs(parsed.query, keep_blank_values=True)
    tokens = params.get("token", [])
    if len(tokens) != 1 or not tokens[0].strip():
        raise HTTPException(status_code=400, detail="QR должен содержать ровно один непустой параметр token.")
    return text, host


class LoginPayload(BaseModel):
    username: str = Field(min_length=1, max_length=256)
    password: SecretStr = Field(min_length=1, max_length=1024)


class OtpPayload(BaseModel):
    code: str = Field(min_length=1, max_length=32)


class AttendancePayload(BaseModel):
    qr_data: str = Field(min_length=1, max_length=2048)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=()"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.post("/api/decode-qr")
async def decode_qr(request: Request):
    """Decode a single in-memory frame. The image and decoded token are never persisted."""
    _require_same_origin(request)
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > 2_000_000:
                raise HTTPException(status_code=413, detail="Изображение слишком большое.")
        except ValueError:
            raise HTTPException(status_code=400, detail="Некорректный размер изображения.")
    raw = await request.body()
    if not raw or len(raw) > 2_000_000:
        raise HTTPException(status_code=413 if raw else 400, detail="Изображение пустое или слишком большое.")
    try:
        import cv2
        import numpy as np
        encoded = np.frombuffer(raw, dtype=np.uint8)
        image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("not an image")
        height, width = image.shape[:2]
        if max(height, width) > 1600:
            scale = 1600 / max(height, width)
            image = cv2.resize(image, (max(1, int(width * scale)), max(1, int(height * scale))))
        detector = cv2.QRCodeDetector()
        text, _points, _straight = detector.detectAndDecode(image)
        if not text:
            try:
                found, decoded, _points, _straight = detector.detectAndDecodeMulti(image)
                if found and decoded:
                    text = next((item for item in decoded if item), "")
            except Exception:
                text = ""
        return {"text": text[:2048] if text else ""}
    except HTTPException:
        raise
    except Exception:
        return JSONResponse(status_code=400, content={"detail": "Не удалось распознать QR на изображении."})


@app.get("/api/me")
async def me(request: Request):
    loaded = _load_session(request)
    return {"authenticated": bool(loaded), "message": "Сохранённый вход найден." if loaded else "Вход не выполнен."}


@app.post("/api/login")
async def login(payload: LoginPayload, request: Request):
    _require_same_origin(request)
    _rate_limit_login(request)
    now = time.time()
    for stale_id, stale in list(pending_logins.items()):
        if now - stale["created_at"] > PENDING_TTL_SECONDS:
            pending_logins.pop(stale_id, None)
            await _close_auth(stale["auth"])
    # Password is read once and is not logged or stored. Only the resulting encrypted
    # session is persisted, after successful completion of the provider's login flow.
    auth = MireaAuth()
    try:
        result = await auth.login(payload.username.strip(), payload.password.get_secret_value())
        challenge = getattr(result, "challenge", None)
        if challenge is not None:
            flow_id = secrets.token_urlsafe(32)
            pending_logins[flow_id] = {"auth": auth, "challenge": challenge, "created_at": time.time()}
            response = JSONResponse(status_code=202, content={
                "challenge_required": True,
                "message": _result_message(result, "Для завершения входа введи код подтверждения."),
            })
            response.set_cookie(PENDING_COOKIE, flow_id, max_age=PENDING_TTL_SECONDS, httponly=True,
                                secure=_cookie_secure(), samesite="strict", path="/")
            return response
        tokens = _extract_tokens(result)
        if not bool(getattr(result, "success", False)) or not tokens:
            await _close_auth(auth)
            return JSONResponse(status_code=401, content={
                "authenticated": False,
                "message": _result_message(result, "МИРЭА не подтвердила вход. Проверь логин и пароль."),
            })
        sid = _save_session(tokens)
        await _close_auth(auth)
        response = JSONResponse(content={"authenticated": True, "message": "Вход выполнен. Сессия сохранена зашифрованно."})
        _set_session_cookie(response, sid)
        _clear_pending_cookie(response)
        return response
    except HTTPException:
        await _close_auth(auth)
        raise
    except Exception:
        await _close_auth(auth)
        # Deliberately do not include raw exception text: upstream errors can contain sensitive URLs.
        return JSONResponse(status_code=502, content={
            "authenticated": False,
            "message": "Не удалось завершить вход в МИРЭА. Попробуй позже; подробности не записываются.",
        })


@app.post("/api/2fa")
async def complete_2fa(payload: OtpPayload, request: Request):
    _require_same_origin(request)
    flow_id = request.cookies.get(PENDING_COOKIE)
    pending = pending_logins.get(flow_id or "")
    if not pending:
        raise HTTPException(status_code=401, detail="Шаг подтверждения истёк. Начни вход заново.")
    if time.time() - pending["created_at"] > PENDING_TTL_SECONDS:
        pending_logins.pop(flow_id, None)
        await _close_auth(pending["auth"])
        raise HTTPException(status_code=401, detail="Шаг подтверждения истёк. Начни вход заново.")
    auth = pending["auth"]
    try:
        result = await auth.complete_2fa(pending["challenge"], payload.code.strip())
        next_challenge = getattr(result, "challenge", None)
        if next_challenge is not None:
            pending["challenge"] = next_challenge
            pending["created_at"] = time.time()
            return JSONResponse(status_code=202, content={
                "challenge_required": True,
                "message": _result_message(result, "Нужен дополнительный шаг подтверждения."),
            })
        tokens = _extract_tokens(result)
        if not bool(getattr(result, "success", False)) or not tokens:
            pending_logins.pop(flow_id, None)
            await _close_auth(auth)
            response = JSONResponse(status_code=401, content={
                "authenticated": False,
                "message": _result_message(result, "МИРЭА не приняла код. Начни вход заново."),
            })
            _clear_pending_cookie(response)
            return response
        sid = _save_session(tokens)
        pending_logins.pop(flow_id, None)
        await _close_auth(auth)
        response = JSONResponse(content={"authenticated": True, "message": "Вход подтверждён. Сессия сохранена зашифрованно."})
        _set_session_cookie(response, sid)
        _clear_pending_cookie(response)
        return response
    except HTTPException:
        raise
    except Exception:
        pending_logins.pop(flow_id, None)
        await _close_auth(auth)
        response = JSONResponse(status_code=502, content={
            "authenticated": False,
            "message": "Не удалось проверить код. Начни вход заново.",
        })
        _clear_pending_cookie(response)
        return response


@app.post("/api/attendance")
async def mark_attendance(payload: AttendancePayload, request: Request):
    _require_same_origin(request)
    loaded = _load_session(request)
    if not loaded:
        raise HTTPException(status_code=401, detail="Сохранённый вход не найден или истёк. Войди заново.")
    _sid_hash, session = loaded
    qr_data, host = _validate_qr_data(payload.qr_data)
    api = MireaAPI(session_cookies=session)
    try:
        result = await api.mark_attendance(qr_data)
        success = bool(getattr(result, "success", False))
        message = _result_message(result, "Сервер МИРЭА не вернул понятный результат.")
        return {"success": success, "message": message, "host": host}
    except Exception:
        # Do not return session data, QR token, or upstream exception details to the browser.
        return JSONResponse(status_code=502, content={
            "success": False,
            "message": "Не удалось связаться с сервисом отметок МИРЭА. Открой официальный QR вручную и проверь статус.",
            "host": host,
        })
    finally:
        close = getattr(api, "close", None)
        if callable(close):
            try:
                closed = close()
                if asyncio.iscoroutine(closed):
                    await closed
            except Exception:
                pass


@app.post("/api/logout")
async def logout(request: Request):
    _require_same_origin(request)
    sid = request.cookies.get(SESSION_COOKIE)
    if sid:
        with _db() as conn:
            conn.execute("DELETE FROM sessions WHERE sid_hash = ?", (_hash_sid(sid),))
    flow_id = request.cookies.get(PENDING_COOKIE)
    pending = pending_logins.pop(flow_id or "", None)
    if pending:
        await _close_auth(pending["auth"])
    response = JSONResponse(content={"ok": True})
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, secure=_cookie_secure(), samesite="strict")
    _clear_pending_cookie(response)
    return response


@app.get("/")
async def index():
    return FileResponse(ROOT / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/index.html")
async def index_file():
    return FileResponse(ROOT / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/app.js")
async def app_js():
    return FileResponse(ROOT / "app.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/styles.css")
async def styles_css():
    return FileResponse(ROOT / "styles.css", media_type="text/css", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(ROOT / "manifest.webmanifest", media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


@app.get("/sw.js")
async def service_worker():
    return FileResponse(ROOT / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@app.get("/icon.svg")
async def icon_svg():
    return FileResponse(ROOT / "icon.svg", media_type="image/svg+xml")


@app.get("/icon-192.png")
async def icon_192():
    return FileResponse(ROOT / "icon-192.png", media_type="image/png")


@app.get("/icon-512.png")
async def icon_512():
    return FileResponse(ROOT / "icon-512.png", media_type="image/png")
