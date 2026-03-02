from __future__ import annotations

import json
import os
import re
import secrets
import hashlib
import threading
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8000
BITGET_BASE = "https://api.bitget.com"
DATA_FILE = Path("data/accounts.json")
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
PW_MIN_LEN = 6

DB_LOCK = threading.Lock()
# SESSIONS will be moved into the database for persistence
SESSIONS_LOCK = threading.Lock()


def _default_state() -> dict:
    return {
        "nextId": 1,
        "nextAlertId": 1,
        "equityStart": 1000,
        "realizedPnl": 0,
        "positions": [],
        "closed": [],
        "alerts": [],
        "alertHistory": [],
    }


def _load_db() -> dict:
    if not DATA_FILE.exists():
        return {"users": {}, "sessions": {}}
    try:
        db = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        if "sessions" not in db:
            db["sessions"] = {}
        return db
    except Exception:  # noqa: BLE001
        return {"users": {}, "sessions": {}}


def _save_db(db: dict) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding="utf-8")


def _new_salt() -> str:
    return secrets.token_hex(16)


def _hash_password(password: str, salt: str) -> str:
    raw = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return raw.hex()


def _issue_token(username: str) -> str:
    token = secrets.token_urlsafe(32)
    with DB_LOCK:
        db = _load_db()
        db.setdefault("sessions", {})[token] = username
        _save_db(db)
    return token


class AppHandler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path.startswith("/api/bitget/"):
            self._handle_bitget_proxy()
            return
        if self.path.startswith("/api/auth/me"):
            self._handle_auth_me()
            return
        if self.path.startswith("/api/account/state"):
            self._handle_account_state_get()
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path.startswith("/api/auth/register"):
            self._handle_auth_register()
            return
        if self.path.startswith("/api/auth/login"):
            self._handle_auth_login()
            return
        if self.path.startswith("/api/auth/logout"):
            self._handle_auth_logout()
            return
        self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_PUT(self) -> None:
        if self.path.startswith("/api/account/state"):
            self._handle_account_state_put()
            return
        self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)

    def _read_json_body(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            return None
        try:
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return None

    def _auth_user(self) -> str | None:
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return None
        token = auth.removeprefix("Bearer ").strip()
        if not token:
            return None
        with DB_LOCK:
            db = _load_db()
            return db.get("sessions", {}).get(token)

    def _validate_state_payload(self, body: dict) -> dict:
        candidate = body.get("state")
        if not isinstance(candidate, dict):
            return _default_state()
        safe = _default_state()
        if isinstance(candidate.get("nextId"), (int, float)) and candidate["nextId"] > 0:
            safe["nextId"] = int(candidate["nextId"])
        if isinstance(candidate.get("nextAlertId"), (int, float)) and candidate["nextAlertId"] > 0:
            safe["nextAlertId"] = int(candidate["nextAlertId"])
        if isinstance(candidate.get("equityStart"), (int, float)) and candidate["equityStart"] > 0:
            safe["equityStart"] = float(candidate["equityStart"])
        if isinstance(candidate.get("realizedPnl"), (int, float)):
            safe["realizedPnl"] = float(candidate["realizedPnl"])
        if isinstance(candidate.get("positions"), list):
            safe["positions"] = candidate["positions"][:3000]
        if isinstance(candidate.get("closed"), list):
            safe["closed"] = candidate["closed"][:10000]
        if isinstance(candidate.get("alerts"), list):
            safe["alerts"] = candidate["alerts"][:2000]
        if isinstance(candidate.get("alertHistory"), list):
            safe["alertHistory"] = candidate["alertHistory"][:300]
        return safe

    def _handle_auth_register(self) -> None:
        body = self._read_json_body()
        if not isinstance(body, dict):
            self._send_json({"ok": False, "error": "Invalid JSON body"}, HTTPStatus.BAD_REQUEST)
            return
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        if not USERNAME_RE.fullmatch(username):
            self._send_json({"ok": False, "error": "Invalid username format"}, HTTPStatus.BAD_REQUEST)
            return
        if len(password) < PW_MIN_LEN:
            self._send_json({"ok": False, "error": "Password too short"}, HTTPStatus.BAD_REQUEST)
            return

        with DB_LOCK:
            db = _load_db()
            users = db.setdefault("users", {})
            if username in users:
                self._send_json({"ok": False, "error": "Username already exists"}, HTTPStatus.CONFLICT)
                return
            salt = _new_salt()
            users[username] = {
                "salt": salt,
                "passwordHash": _hash_password(password, salt),
                "state": _default_state(),
            }
            _save_db(db)

        token = _issue_token(username)
        self._send_json({"ok": True, "username": username, "token": token, "state": _default_state()})

    def _handle_auth_login(self) -> None:
        body = self._read_json_body()
        if not isinstance(body, dict):
            self._send_json({"ok": False, "error": "Invalid JSON body"}, HTTPStatus.BAD_REQUEST)
            return
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))

        with DB_LOCK:
            db = _load_db()
            users = db.get("users", {})
            user = users.get(username)
            if not user:
                self._send_json({"ok": False, "error": "Invalid username or password"}, HTTPStatus.UNAUTHORIZED)
                return
            salt = str(user.get("salt", ""))
            expected = str(user.get("passwordHash", ""))
            got = _hash_password(password, salt) if salt else ""
            if not expected or got != expected:
                self._send_json({"ok": False, "error": "Invalid username or password"}, HTTPStatus.UNAUTHORIZED)
                return
            user_state = user.get("state") if isinstance(user.get("state"), dict) else _default_state()

        token = _issue_token(username)
        self._send_json({"ok": True, "username": username, "token": token, "state": user_state})

    def _handle_auth_logout(self) -> None:
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth.removeprefix("Bearer ").strip()
            with DB_LOCK:
                db = _load_db()
                if "sessions" in db:
                    db["sessions"].pop(token, None)
                    _save_db(db)
        self._send_json({"ok": True})

    def _handle_auth_me(self) -> None:
        username = self._auth_user()
        if not username:
            self._send_json({"ok": False, "error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
            return
        with DB_LOCK:
            db = _load_db()
            user = db.get("users", {}).get(username)
            if not user:
                self._send_json({"ok": False, "error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
                return
            user_state = user.get("state") if isinstance(user.get("state"), dict) else _default_state()
        self._send_json({"ok": True, "username": username, "state": user_state})

    def _handle_account_state_get(self) -> None:
        username = self._auth_user()
        if not username:
            self._send_json({"ok": False, "error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
            return
        with DB_LOCK:
            db = _load_db()
            user = db.get("users", {}).get(username)
            if not user:
                self._send_json({"ok": False, "error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
                return
            user_state = user.get("state") if isinstance(user.get("state"), dict) else _default_state()
        self._send_json({"ok": True, "state": user_state})

    def _handle_account_state_put(self) -> None:
        username = self._auth_user()
        if not username:
            self._send_json({"ok": False, "error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
            return
        body = self._read_json_body()
        if not isinstance(body, dict):
            self._send_json({"ok": False, "error": "Invalid JSON body"}, HTTPStatus.BAD_REQUEST)
            return
        safe_state = self._validate_state_payload(body)
        with DB_LOCK:
            db = _load_db()
            user = db.get("users", {}).get(username)
            if not user:
                self._send_json({"ok": False, "error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
                return
            user["state"] = safe_state
            _save_db(db)
        self._send_json({"ok": True})

    def _handle_bitget_proxy(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        endpoint = parsed.path.replace("/api/bitget", "", 1)
        query = urllib.parse.parse_qs(parsed.query)
        clean_query: dict[str, str] = {
            key: values[0] for key, values in query.items() if values
        }

        if not endpoint:
            self._send_json({"ok": False, "error": "Missing endpoint"}, HTTPStatus.BAD_REQUEST)
            return

        url = f"{BITGET_BASE}{endpoint}"
        if clean_query:
            url = f"{url}?{urllib.parse.urlencode(clean_query)}"

        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "demo-trading-local/1.0",
                "Accept": "application/json",
            },
            method="GET",
        )

        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = resp.read()
                code = resp.getcode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(raw)
        except Exception as exc:  # noqa: BLE001
            self._send_json(
                {"ok": False, "error": "Bitget request failed", "details": str(exc)},
                HTTPStatus.BAD_GATEWAY,
            )

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    root = Path(__file__).resolve().parent
    os.chdir(root)
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"Demo trading app: http://{HOST}:{PORT}")
    print("Press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
