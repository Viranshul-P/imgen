#!/usr/bin/env python3
"""PersonaForge cloud model fetcher (runs on the cloud GPU machine; Python 3 stdlib only).

The studio's "Download Custom Model / LoRA" dialog in Remote Cloud GPU mode sends downloads here, so a
multi-GB checkpoint goes straight from Civitai / Hugging Face into the cloud ComfyUI's models folder and
never passes through the laptop.

Security: it listens on 127.0.0.1 only and is reached through the same SSH tunnel as ComfyUI:
    ssh -N -L 8189:127.0.0.1:8188 -L 8190:127.0.0.1:8190 root@<cloud-ip>

API (JSON):
    GET  /health                -> {"ok": true, "models_dir": "..."}
    POST /download              {url, folder: checkpoints|loras, filename?, sha256?, size?, token?} -> {"id": "..."}
    GET  /status?id=<id>        -> {status, bytes, total, filename, error}

Only https URLs and .safetensors files are accepted. A token is sent only to civitai.com / huggingface.co and
never forwarded on a redirect (Civitai redirects to a signed storage URL). Interrupted downloads resume from
<file>.part; a known SHA-256 is verified before the file is renamed into place.

Usage:  python3 cloud_model_fetcher.py [--models-dir /workspace/ComfyUI/models] [--port 8190]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FOLDERS = ("checkpoints", "loras")
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ ()+,-]{0,180}\.safetensors$")
CHUNK = 4 * 1024 * 1024
JOBS: dict[str, dict] = {}
LOCK = threading.Lock()
MODELS_DIR = "/workspace/ComfyUI/models"


def host_is(url: str, host: str) -> bool:
    h = (urllib.parse.urlparse(url).hostname or "").lower()
    return h == host or h.endswith("." + host)


def clean_name(name: str) -> str:
    base = os.path.basename(name.replace("\\", "/")).strip()
    if not base.lower().endswith(".safetensors"):
        raise ValueError(f'only .safetensors files can be downloaded (got "{base or "no file name"}")')
    if not SAFE_NAME.match(base):
        raise ValueError(f'unsafe file name "{base}"')
    return base


def name_from_response(resp, final_url: str) -> str:
    cd = resp.headers.get("Content-Disposition") or ""
    m = re.search(r"filename\*\s*=\s*(?:UTF-8'')?([^;]+)", cd, re.I)
    if m:
        return urllib.parse.unquote(m.group(1).strip().strip('"'))
    m = re.search(r'filename\s*=\s*"?([^";]+)"?', cd, re.I)
    if m:
        return m.group(1).strip()
    return urllib.parse.unquote(urllib.parse.urlparse(final_url).path.rsplit("/", 1)[-1])


class HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.lower().startswith("https://"):
            raise urllib.error.HTTPError(newurl, code, "redirect to a non-https URL refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(HttpsOnlyRedirect)


def open_url(url: str, token: str | None, start: int):
    req = urllib.request.Request(url, headers={"User-Agent": "PersonaForge-cloud-fetcher"})
    if start > 0:
        req.add_header("Range", f"bytes={start}-")
    if token and (host_is(url, "civitai.com") or host_is(url, "huggingface.co")):
        # "unredirected" headers are NOT copied onto the redirected request.
        req.add_unredirected_header("Authorization", f"Bearer {token}")
    return OPENER.open(req, timeout=60)


def set_job(job_id: str, **patch) -> None:
    with LOCK:
        JOBS[job_id].update(patch)


def run(job_id: str, url: str, folder: str, filename: str, sha256: str | None, size: int | None, token: str | None) -> None:
    try:
        target_dir = os.path.join(MODELS_DIR, folder)
        os.makedirs(target_dir, exist_ok=True)
        have = 0
        if filename:
            if os.path.exists(os.path.join(target_dir, filename)):
                raise ValueError(f"{filename} already exists in models/{folder}")
            part = os.path.join(target_dir, filename + ".part")
            have = os.path.getsize(part) if os.path.exists(part) else 0
        try:
            resp = open_url(url, token, have)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403) and host_is(url, "civitai.com"):
                raise ValueError("Civitai needs a valid CIVITAI_TOKEN for this file (add it in the studio dialog)") from e
            raise ValueError(f"download failed (HTTP {e.code})") from e
        if have and resp.status != 206:
            have = 0  # server ignored Range: start over
        if not filename:
            filename = clean_name(name_from_response(resp, resp.geturl()))
            if os.path.exists(os.path.join(target_dir, filename)):
                raise ValueError(f"{filename} already exists in models/{folder}")
        part = os.path.join(target_dir, filename + ".part")
        length = resp.headers.get("Content-Length")
        exact = bool(length and length.isdigit() and int(length) > 0)
        total = have + int(length) if exact else size
        if total:
            free = shutil.disk_usage(target_dir).free
            if free < total - have + 512 * 1024 * 1024:
                raise ValueError(f"not enough disk space: need {total / 2**30:.1f} GiB, {free / 2**30:.1f} GiB free")
        set_job(job_id, status="downloading", filename=filename, total=total, bytes=have)
        done = have
        with open(part, "ab" if have else "wb") as fh:
            while True:
                chunk = resp.read(CHUNK)
                if not chunk:
                    break
                fh.write(chunk)
                done += len(chunk)
                set_job(job_id, bytes=done)
        if exact and done != total:
            raise ValueError(f"download ended early ({done} of {total} bytes); start it again to resume")
        set_job(job_id, total=done)
        if sha256:
            set_job(job_id, status="verifying")
            h = hashlib.sha256()
            with open(part, "rb") as fh:
                for block in iter(lambda: fh.read(CHUNK), b""):
                    h.update(block)
            if h.hexdigest() != sha256.lower():
                os.remove(part)
                raise ValueError("SHA-256 mismatch; the partial file was deleted")
        os.replace(part, os.path.join(target_dir, filename))
        set_job(job_id, status="done")
        print(f"[fetcher] done: models/{folder}/{filename} ({done / 2**30:.2f} GiB)", flush=True)
    except Exception as e:  # noqa: BLE001 - reported to the studio
        set_job(job_id, status="failed", error=str(e))
        print(f"[fetcher] failed: {e}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):  # quieter default logging
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            return self._send(200, {"ok": True, "models_dir": MODELS_DIR})
        if parsed.path == "/status":
            job_id = (urllib.parse.parse_qs(parsed.query).get("id") or [""])[0]
            with LOCK:
                job = dict(JOBS.get(job_id) or {})
            return self._send(200, job) if job else self._send(404, {"error": "unknown download id"})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/download":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(length, 65536)) or b"{}")
            url = str(body.get("url") or "")
            folder = str(body.get("folder") or "")
            if not url.lower().startswith("https://"):
                raise ValueError("download URLs must start with https://")
            if folder not in FOLDERS:
                raise ValueError("folder must be checkpoints or loras")
            filename = clean_name(body["filename"]) if body.get("filename") else ""
            sha256 = body.get("sha256") or None
            if sha256 is not None and not re.fullmatch(r"[0-9a-fA-F]{64}", str(sha256)):
                raise ValueError("sha256 must be 64 hex characters")
            size = body.get("size")
            size = int(size) if isinstance(size, (int, float)) and size > 0 else None
            if host_is(url, "civitai.com"):
                token = body.get("token") or os.environ.get("CIVITAI_TOKEN")
            elif host_is(url, "huggingface.co"):
                token = body.get("token") or os.environ.get("HF_TOKEN")
            else:
                token = None  # never send a token to any other host
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            return self._send(400, {"error": str(e)})
        job_id = uuid.uuid4().hex
        with LOCK:
            busy = [j for j in JOBS.values() if filename and j["filename"] == filename and j["folder"] == folder and j["status"] in ("resolving", "downloading", "verifying")]
            if busy:
                return self._send(400, {"error": f"{filename} is already downloading"})
            JOBS[job_id] = {"id": job_id, "status": "resolving", "bytes": 0, "total": size, "filename": filename, "folder": folder, "error": None}
        threading.Thread(target=run, args=(job_id, url, folder, filename, sha256, size, token), daemon=True).start()
        return self._send(202, {"id": job_id})


def main() -> None:
    global MODELS_DIR
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models-dir", default=os.environ.get("COMFY_MODELS_DIR", MODELS_DIR))
    ap.add_argument("--port", type=int, default=8190)
    args = ap.parse_args()
    MODELS_DIR = os.path.abspath(args.models_dir)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)  # localhost only: reach it via the SSH tunnel
    print(f"[fetcher] listening on 127.0.0.1:{args.port}, saving into {MODELS_DIR}/{{checkpoints,loras}}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
