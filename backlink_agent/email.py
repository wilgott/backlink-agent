"""Generic Gmail OAuth setup + inbox reader (Python stdlib only).

Tokens live at ``~/.config/backlink-agent/gmail_token.json`` by default;
override with the ``BACKLINK_AGENT_GMAIL_TOKEN_PATH`` env var. The Google
OAuth client-secret JSON path comes from the
``BACKLINK_AGENT_GMAIL_CLIENT_SECRET`` env var.

``auth_flow()`` runs a localhost:8085 listener that shuts itself down once
the OAuth redirect delivers the code (via a daemon thread calling
``server.shutdown()`` — calling it directly from the handler would deadlock).
"""
from __future__ import annotations

import base64
import json
import os
import re
import threading
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Optional

SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
PORT = 8085
AUTH_TIMEOUT_SECONDS = 1800

CLIENT_SECRET_ENV = "BACKLINK_AGENT_GMAIL_CLIENT_SECRET"
TOKEN_PATH_ENV = "BACKLINK_AGENT_GMAIL_TOKEN_PATH"
DEFAULT_TOKEN_PATH = "~/.config/backlink-agent/gmail_token.json"


def token_path() -> Path:
    return Path(os.environ.get(TOKEN_PATH_ENV, DEFAULT_TOKEN_PATH)).expanduser()


def load_client() -> tuple[str, str]:
    """Read (client_id, client_secret) from the client-secret JSON file."""
    path = os.environ.get(CLIENT_SECRET_ENV)
    if not path:
        raise RuntimeError(
            f"Set {CLIENT_SECRET_ENV} to the path of your Google OAuth "
            "client-secret JSON (Desktop app type)."
        )
    with open(os.path.expanduser(path), encoding="utf-8") as fh:
        data = json.load(fh)["installed"]
    return data["client_id"], data["client_secret"]


def _auth_url(client_id: str) -> str:
    query = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": f"http://localhost:{PORT}/",
            "response_type": "code",
            "scope": SCOPE,
            "access_type": "offline",
            "prompt": "consent",
        }
    )
    return f"https://accounts.google.com/o/oauth2/auth?{query}"


def _exchange(code: str, client_id: str, client_secret: str) -> dict[str, Any]:
    data = urllib.parse.urlencode(
        {
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": f"http://localhost:{PORT}/",
            "grant_type": "authorization_code",
        }
    ).encode()
    with urllib.request.urlopen("https://oauth2.googleapis.com/token", data) as resp:
        return json.load(resp)


def _refresh(client_id: str, client_secret: str) -> str:
    path = token_path()
    with path.open(encoding="utf-8") as fh:
        tok = json.load(fh)
    data = urllib.parse.urlencode(
        {
            "refresh_token": tok["refresh_token"],
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
        }
    ).encode()
    with urllib.request.urlopen("https://oauth2.googleapis.com/token", data) as resp:
        out = json.load(resp)
    tok["access_token"] = out["access_token"]
    path.write_text(json.dumps(tok), encoding="utf-8")
    os.chmod(path, 0o600)
    return tok["access_token"]


def _gmail_get(path: str, access_token: str, params: Optional[dict] = None) -> dict:
    url = "https://gmail.googleapis.com/gmail/v1/users/me/" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {access_token}"})
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def _decode_body(payload: dict) -> str:
    parts = [payload]
    texts: list[str] = []
    while parts:
        p = parts.pop()
        if p.get("mimeType", "").startswith("text/") and p.get("body", {}).get("data"):
            texts.append(
                base64.urlsafe_b64decode(p["body"]["data"]).decode("utf-8", "replace")
            )
        parts.extend(p.get("parts", []))
    return "\n".join(texts)


def auth_flow() -> dict[str, Any]:
    """Interactive OAuth: prints a consent URL, waits for the redirect on
    localhost:8085, stores the token, and returns the Gmail profile dict."""
    client_id, client_secret = load_client()
    code_holder: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 (http.server API)
            code = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get(
                "code", [None]
            )[0]
            if code:
                code_holder["code"] = code
                # Shut down from a separate thread: calling server.shutdown()
                # inside the handler would deadlock serve_forever().
                threading.Thread(target=server.shutdown, daemon=True).start()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Gmail connected. You can close this tab.")

        def log_message(self, *args: Any) -> None:
            pass

    server = HTTPServer(("localhost", PORT), Handler)
    print(f"Listening on http://localhost:{PORT}/", flush=True)
    print(f"\nOpen this URL to connect Gmail:\n\n{_auth_url(client_id)}\n", flush=True)
    threading.Timer(AUTH_TIMEOUT_SECONDS, server.shutdown).start()
    server.serve_forever()
    server.server_close()
    if not code_holder.get("code"):
        raise TimeoutError(
            f"No auth code received within {AUTH_TIMEOUT_SECONDS // 60} minutes."
        )
    tokens = _exchange(code_holder["code"], client_id, client_secret)
    path = token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(tokens), encoding="utf-8")
    os.chmod(path, 0o600)
    profile = _gmail_get("profile", tokens["access_token"])
    print(
        f"Connected: {profile['emailAddress']} ({profile['messagesTotal']} messages)",
        flush=True,
    )
    print(f"Tokens stored at {path}", flush=True)
    return profile


def read_messages(query: str, max_results: int = 10) -> list[dict[str, Any]]:
    """Return [{from, subject, date, links, body}] for messages matching a
    Gmail search query (e.g. ``newer_than:2d`` or ``after:1722345600``)."""
    client_id, client_secret = load_client()
    token = _refresh(client_id, client_secret)
    msgs = _gmail_get("messages", token, {"q": query, "maxResults": max_results}).get(
        "messages", []
    )
    results: list[dict[str, Any]] = []
    for m in msgs:
        full = _gmail_get(f"messages/{m['id']}", token, {"format": "full"})
        headers = {h["name"].lower(): h["value"] for h in full["payload"]["headers"]}
        body = _decode_body(full["payload"])
        links = sorted(set(re.findall(r"https?://[^\s<>\"')\]]+", body)))
        results.append(
            {
                "from": headers.get("from", ""),
                "subject": headers.get("subject", ""),
                "date": headers.get("date", ""),
                "links": links[:15],
                "body": body,
            }
        )
    return results


def extract_otp(text: str) -> list[str]:
    """Extract 4-8 digit one-time codes from message text."""
    return sorted(set(re.findall(r"\b\d{4,8}\b", text)))
