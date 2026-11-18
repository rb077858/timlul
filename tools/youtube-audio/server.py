#!/usr/bin/env python3
"""
The download service for תמלולי's YouTube option: GET /audio?v=<video id>&max=<seconds> returns the video's audio.

The site (a Cloudflare Worker) can't run yt-dlp, so this small program runs on a machine that can. It only answers to
the site: every request must carry  Authorization: Bearer <YT_AUDIO_TOKEN>.

Settings (environment variables):
  YT_AUDIO_TOKEN   required. The same secret is set in the Worker (YT_AUDIO_TOKEN).
  PORT             default 8080
  MAX_SECONDS      the longest video accepted, default 7200 (2 hours)
  MAX_BYTES        the most audio sent, default 188743680 (180 MB)
  MAX_JOBS         downloads at the same time, default 2
  YTDLP_BIN        the yt-dlp program, default "yt-dlp"
  YTDLP_COOKIES    optional: path of a cookies.txt file. YouTube sometimes asks "confirm you're not a bot" from servers;
                   cookies of a (spare) account get around it.
  YTDLP_EXTRA      optional: more yt-dlp options, e.g. "--proxy http://user:pass@host:port"

Only the audio, in the smallest size that is still clear speech, is fetched. Nothing is stored.
"""
import hmac
import os
import re
import shlex
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

TOKEN = os.environ.get("YT_AUDIO_TOKEN", "")
MAX_SECONDS = int(os.environ.get("MAX_SECONDS", "7200"))
MAX_BYTES = int(os.environ.get("MAX_BYTES", str(180 * 1024 * 1024)))
JOBS = threading.BoundedSemaphore(int(os.environ.get("MAX_JOBS", "2")))
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
FORMAT = "worstaudio[ext=m4a]/worstaudio[acodec!=none]/worstaudio"
TYPES = {"m4a": "audio/mp4", "mp4": "audio/mp4", "webm": "audio/webm", "opus": "audio/ogg", "ogg": "audio/ogg", "mp3": "audio/mpeg"}


def ytdlp(*args):
    cmd = [os.environ.get("YTDLP_BIN", "yt-dlp"), "--no-playlist", "--no-warnings", "-f", FORMAT]
    if os.environ.get("YTDLP_COOKIES"):
        cmd += ["--cookies", os.environ["YTDLP_COOKIES"]]
    cmd += shlex.split(os.environ.get("YTDLP_EXTRA", ""))
    return cmd + list(args)


def classify(stderr):
    s = stderr.lower()
    if "private video" in s or "sign in" in s or "confirm you" in s or "login" in s:
        return "private"
    if "live event" in s or "is live" in s:
        return "live"
    return "unavailable"


def probe(video_id):
    """-> (duration seconds, is_live, extension, title) or raises ValueError(code)."""
    r = subprocess.run(
        ytdlp("--skip-download", "--print", "%(duration)s\t%(is_live)s\t%(ext)s\t%(title)s", "--", f"https://www.youtube.com/watch?v={video_id}"),
        capture_output=True, text=True, timeout=90,
    )
    if r.returncode != 0 or not r.stdout.strip():
        raise ValueError(classify(r.stderr))
    duration, live, ext, title = (r.stdout.strip().split("\n")[0].split("\t") + ["", "", "", ""])[:4]
    return (float(duration) if duration.replace(".", "", 1).isdigit() else 0.0), live == "True", ext, title


class Handler(BaseHTTPRequestHandler):
    server_version = "yt-audio"

    def log_message(self, fmt, *args):  # one short line per request, no tokens
        print("%s %s" % (self.command, self.path.split("?")[0]), *args[1:2], flush=True)

    def send_json(self, status, data):
        import json
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            return self.send_json(200, {"ok": True})
        if url.path != "/audio":
            return self.send_json(404, {"error": "not_found"})
        given = self.headers.get("Authorization", "")
        if not TOKEN or not hmac.compare_digest(given, "Bearer " + TOKEN):
            return self.send_json(401, {"error": "unauthorized"})
        q = parse_qs(url.query)
        video_id = (q.get("v") or [""])[0]
        if not VIDEO_ID.match(video_id):
            return self.send_json(400, {"error": "bad_id"})
        limit = MAX_SECONDS
        try:
            asked = int((q.get("max") or ["0"])[0])
            if asked > 0:
                limit = min(limit, asked)
        except ValueError:
            pass
        if not JOBS.acquire(blocking=False):
            return self.send_json(503, {"error": "busy", "message": "עמוס כרגע, נסו שוב בעוד רגע"})
        try:
            try:
                duration, live, ext, title = probe(video_id)
            except ValueError as e:
                return self.send_json(422, {"error": str(e)})
            except subprocess.TimeoutExpired:
                return self.send_json(504, {"error": "timeout"})
            if live:
                return self.send_json(422, {"error": "live"})
            if duration > limit:
                return self.send_json(422, {"error": "too_long"})
            proc = subprocess.Popen(ytdlp("-o", "-", "--", f"https://www.youtube.com/watch?v={video_id}"), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            first = proc.stdout.read(65536)
            if not first:
                proc.kill()
                return self.send_json(422, {"error": "unavailable"})
            self.send_response(200)
            self.send_header("Content-Type", TYPES.get(ext, "application/octet-stream"))
            self.send_header("X-Title", quote(title[:150]))
            self.send_header("X-Duration", str(int(duration)))
            self.send_header("Connection", "close")  # no length known: the end of the connection is the end of the audio
            self.end_headers()
            sent = 0
            try:
                chunk = first
                while chunk:
                    self.wfile.write(chunk)
                    sent += len(chunk)
                    if sent > MAX_BYTES:
                        break
                    chunk = proc.stdout.read(65536)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                proc.kill()
                proc.wait()
        finally:
            JOBS.release()


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("YT_AUDIO_TOKEN is not set")
    port = int(os.environ.get("PORT", "8080"))
    print(f"listening on :{port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
