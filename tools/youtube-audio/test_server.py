"""Run: python3 test_server.py   (uses a fake yt-dlp, so no network)"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FAKE = """#!/bin/sh
case "$*" in
  *PRIVATEVID1*) echo "ERROR: Private video. Sign in if you've been granted access" >&2; exit 1;;
  *LIVEVIDEO11*) echo "ERROR: This live event will begin soon" >&2; exit 1;;
esac
case "$*" in
  *--skip-download*)
    case "$*" in *LONGVIDEO11*) echo "9000	False	m4a	long";; *) echo "95	False	m4a	שיעור בדיקה";; esac;;
  *) printf 'AUDIOBYTES';;
esac
"""


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        fake = os.path.join(cls.dir, "yt-dlp")
        open(fake, "w").write(FAKE)
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
        cls.port = 18080 + os.getpid() % 500
        env = dict(os.environ, YT_AUDIO_TOKEN="secret", YTDLP_BIN=fake, PORT=str(cls.port))
        cls.proc = subprocess.Popen([sys.executable, os.path.join(HERE, "server.py")], env=env, stdout=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/health")
                break
            except Exception:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.kill()

    def get(self, path, token="secret"):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers={"Authorization": f"Bearer {token}"} if token else {})
        try:
            r = urllib.request.urlopen(req)
            return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def test_audio(self):
        status, headers, body = self.get("/audio?v=dQw4w9WgXcQ")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"AUDIOBYTES")
        self.assertEqual(headers["X-Duration"], "95")
        self.assertEqual(headers["Content-Type"], "audio/mp4")
        self.assertIn("%D7", headers["X-Title"])

    def test_needs_the_token(self):
        self.assertEqual(self.get("/audio?v=dQw4w9WgXcQ", token=None)[0], 401)
        self.assertEqual(self.get("/audio?v=dQw4w9WgXcQ", token="wrong")[0], 401)

    def test_bad_ids(self):
        for v in ["short", "x" * 12, "dQw4w9WgXc;", "../etc/passwd"]:
            self.assertEqual(self.get("/audio?v=" + v)[0], 400, v)

    def test_limits_and_errors(self):
        s, _, b = self.get("/audio?v=LONGVIDEO11")
        self.assertEqual((s, json.loads(b)["error"]), (422, "too_long"))
        s, _, b = self.get("/audio?v=dQw4w9WgXcQ&max=60")
        self.assertEqual((s, json.loads(b)["error"]), (422, "too_long"), "longer than the user's quota allows")
        s, _, b = self.get("/audio?v=PRIVATEVID1")
        self.assertEqual((s, json.loads(b)["error"]), (422, "private"))
        s, _, b = self.get("/audio?v=LIVEVIDEO11")
        self.assertEqual((s, json.loads(b)["error"]), (422, "live"))


if __name__ == "__main__":
    unittest.main()
