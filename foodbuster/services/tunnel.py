"""Public HTTPS address for QR codes: own domain (Cloudflare named tunnel), serveo subdomain, quick cloudflared, localhost.run."""

from __future__ import annotations

import contextlib
import os
import platform
import queue
import re
import shutil
import stat
import subprocess
import tarfile
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path
from typing import Any, Callable, Optional

from settings import TunnelConfig, settings
from foodbuster.core.logging import log
from foodbuster.core.utils import iso, now_utc

CLOUDFLARED_ASSETS = {
    ("windows", "amd64"): "cloudflared-windows-amd64.exe", ("windows", "arm64"): "cloudflared-windows-amd64.exe",
    ("windows", "386"): "cloudflared-windows-386.exe", ("linux", "amd64"): "cloudflared-linux-amd64",
    ("linux", "arm64"): "cloudflared-linux-arm64", ("linux", "arm"): "cloudflared-linux-arm", ("linux", "386"): "cloudflared-linux-386",
    ("darwin", "amd64"): "cloudflared-darwin-amd64.tgz", ("darwin", "arm64"): "cloudflared-darwin-arm64.tgz",
}
ARCH_ALIASES = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64", "armv7l": "arm", "armv6l": "arm",
                "i386": "386", "i686": "386", "x86": "386"}
PATTERNS = {
    "cloudflared": re.compile(r"https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com"),
    "serveo": re.compile(r"https://[a-z0-9][a-z0-9-]*\.(?:serveo\.net|serveousercontent\.com)"),
    "ssh": re.compile(r"https://[a-z0-9][a-z0-9-]*\.lhr\.life"),
    "named": re.compile(r"Registered tunnel connection"),
    "register": re.compile(r"https://console\.serveo\.net/\S+"),
}


def safe_print(text: str) -> None:
    try:
        print(text, flush=True)
    except UnicodeEncodeError:
        print(text.encode("ascii", "replace").decode("ascii"), flush=True)


class TunnelManager:
    def __init__(self, cfg: TunnelConfig, on_change: Callable[[dict[str, Any]], None], on_online: Callable[[str], None]) -> None:
        self.cfg = cfg
        self.mode = cfg.mode
        self.public_url = settings.public_url
        self.on_change = on_change
        self.on_online = on_online
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._process: Optional[subprocess.Popen] = None
        self._port = settings.port
        self._restarts = 0
        self._state: dict[str, Any] = {"status": "off", "provider": None, "url": None, "error": None, "since": None, "verified": False,
                                       "register_url": None}

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._state)

    def _set(self, **changes: Any) -> None:
        with self._lock:
            self._state.update(changes)
        self.on_change(self.snapshot())

    def start(self, port: int) -> None:
        self._port = port
        self._stop.clear()
        self._set(status="starting", error=None)
        threading.Thread(target=self._run, name="foodbuster-tunnel", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
        process = self._process
        if process and process.poll() is None:
            with contextlib.suppress(Exception):
                process.terminate()
                process.wait(timeout=3)

    def _order(self) -> list[str]:
        explicit = {"cloudflared": ["cloudflared"], "serveo": ["serveo", "cloudflared"], "ssh": ["ssh"], "localhost.run": ["ssh"],
                    "named": ["named"]}.get(self.mode)
        if explicit:
            return explicit
        return (["named"] if self.cfg.cloudflare_token and self.public_url else []) + ["cloudflared", "ssh"]

    def _run(self) -> None:
        errors = []
        for provider in self._order():
            if self._stop.is_set():
                return
            try:
                handler = {"named": self._named, "cloudflared": self._cloudflared, "serveo": self._serveo, "ssh": self._ssh}[provider]
                if handler():
                    return
            except Exception as exc:
                errors.append(f"{provider}: {exc}")
                log.warning("Tunnel via %s failed: %s", provider, exc)
        self._set(status="failed", url=None, error="; ".join(errors) or "Публичный туннель недоступен")
        safe_print("\n  Публичный туннель не поднялся — QR работают в локальной сети.")
        safe_print("  Установите cloudflared или задайте FOODBUSTER_PUBLIC_URL, если сервер уже доступен из интернета.\n")

    def _find_cloudflared(self) -> Optional[str]:
        name = "cloudflared.exe" if os.name == "nt" else "cloudflared"
        candidates = [self.cfg.cloudflared_path, shutil.which("cloudflared") or "", str(settings.data_dir / "bin" / name)]
        if os.name == "nt":
            candidates += [r"C:\Program Files (x86)\cloudflared\cloudflared.exe", r"C:\Program Files\cloudflared\cloudflared.exe"]
        return next((c for c in candidates if c and Path(c).is_file()), None)

    def _download_cloudflared(self) -> str:
        system = platform.system().lower()
        arch = ARCH_ALIASES.get(platform.machine().lower())
        asset = CLOUDFLARED_ASSETS.get((system, arch or ""))
        if not asset:
            raise RuntimeError(f"нет сборки cloudflared для {system}/{platform.machine()}")
        target = settings.data_dir / "bin" / ("cloudflared.exe" if system == "windows" else "cloudflared")
        target.parent.mkdir(parents=True, exist_ok=True)
        self._set(status="downloading", provider="cloudflared")
        safe_print("  Скачиваю cloudflared для публичной ссылки (один раз, ~30 МБ)…")
        partial = target.with_name(target.name + ".part")
        url = f"https://github.com/cloudflare/cloudflared/releases/latest/download/{asset}"
        with urllib.request.urlopen(url, timeout=120) as response, open(partial, "wb") as handle:
            shutil.copyfileobj(response, handle)
        if asset.endswith(".tgz"):
            with tarfile.open(partial) as archive:
                member = next(m for m in archive.getmembers() if m.name.endswith("cloudflared"))
                extracted = archive.extractfile(member)
                target.write_bytes(extracted.read() if extracted else b"")
            partial.unlink()
        else:
            partial.replace(target)
        target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        return str(target)

    def _cloudflared_binary(self) -> str:
        executable = self._find_cloudflared()
        if not executable and self.cfg.auto_download_cloudflared:
            executable = self._download_cloudflared()
        if not executable:
            raise RuntimeError("cloudflared не установлен")
        return executable

    def _cloudflared(self) -> bool:
        command = [self._cloudflared_binary(), "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{self._port}"]
        return self._spawn(command, "cloudflared", PATTERNS["cloudflared"])

    def _named(self) -> bool:
        if not self.cfg.cloudflare_token or not self.public_url:
            raise RuntimeError("нужны FOODBUSTER_CLOUDFLARE_TUNNEL_TOKEN и FOODBUSTER_PUBLIC_URL")
        command = [self._cloudflared_binary(), "tunnel", "--no-autoupdate", "run", "--token", self.cfg.cloudflare_token]
        return self._spawn(command, "named", PATTERNS["named"], fixed_url=self.public_url)

    def _ssh_key(self) -> Path:
        key = settings.data_dir / "ssh" / "id_ed25519"
        if not key.exists():
            key.parent.mkdir(parents=True, exist_ok=True)
            keygen = shutil.which("ssh-keygen")
            if not keygen:
                raise RuntimeError("ssh-keygen не найден")
            subprocess.run([keygen, "-q", "-t", "ed25519", "-N", "", "-C", "foodbuster", "-f", str(key)], check=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0)
        return key

    def _ssh_command(self, host: str, remote: str, key: Optional[Path] = None) -> list[str]:
        executable = shutil.which("ssh")
        if not executable:
            raise RuntimeError("ssh не найден")
        command = [executable, "-tt", "-o", "StrictHostKeyChecking=no", "-o", f"UserKnownHostsFile={os.devnull}",
                   "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes", "-R", f"{remote}:127.0.0.1:{self._port}"]
        if key:
            command += ["-i", str(key), "-o", "IdentitiesOnly=yes"]
        return command + [host]

    def _serveo(self) -> bool:
        command = self._ssh_command("serveo.net", f"{self.cfg.subdomain}:80", self._ssh_key())
        return self._spawn(command, "serveo", PATTERNS["serveo"], keep_stdin=True)

    def _ssh(self) -> bool:
        last_error: Optional[Exception] = None
        for host in self.cfg.ssh_hosts:
            try:
                if self._spawn(self._ssh_command(host, "80"), "ssh", PATTERNS["ssh"], keep_stdin=True):
                    return True
            except RuntimeError as exc:
                last_error = exc
        raise RuntimeError(str(last_error or "ssh-туннель не ответил"))

    def _spawn(self, command: list[str], provider: str, pattern: re.Pattern[str], keep_stdin: bool = False,
               fixed_url: Optional[str] = None) -> bool:
        self._set(status="starting", provider=provider, error=None, verified=False)
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   stdin=subprocess.PIPE if keep_stdin else subprocess.DEVNULL,
                                   text=True, encoding="utf-8", errors="replace", bufsize=1, creationflags=flags)
        self._process = process
        lines: "queue.Queue[Optional[str]]" = queue.Queue()

        def reader() -> None:
            assert process.stdout is not None
            for raw in process.stdout:
                lines.put(raw)
            lines.put(None)

        threading.Thread(target=reader, daemon=True).start()
        deadline = time.monotonic() + self.cfg.startup_timeout_seconds
        tail: deque[str] = deque(maxlen=6)
        while time.monotonic() < deadline and not self._stop.is_set():
            try:
                line = lines.get(timeout=0.5)
            except queue.Empty:
                continue
            if line is None:
                break
            tail.append(line.strip()[:160])
            register = PATTERNS["register"].search(line)
            if register:
                self._set(register_url=register.group(0))
                safe_print(f"  Чтобы получить адрес {self.cfg.subdomain}: зарегистрируйте ключ один раз → {register.group(0)}")
            match = pattern.search(line)
            if match:
                url = (fixed_url or match.group(0)).rstrip("/")
                if provider == "serveo" and self.cfg.subdomain not in url:
                    continue
                self._set(status="online", provider=provider, url=url, error=None, since=iso(now_utc()))
                self.on_online(url)
                threading.Thread(target=self._watch, args=(process, lines), daemon=True).start()
                threading.Thread(target=self._verify, args=(url,), daemon=True).start()
                return True
        with contextlib.suppress(Exception):
            process.terminate()
        raise RuntimeError("адрес не получен" + (f" ({tail[-1]})" if tail else ""))

    def _watch(self, process: subprocess.Popen, lines: "queue.Queue[Optional[str]]") -> None:
        while lines.get() is not None:
            pass
        process.wait()
        if self._stop.is_set():
            return
        self._set(status="offline", error="Туннель закрылся", verified=False)
        log.warning("Public tunnel closed, reconnecting…")
        if self._restarts < 5:
            self._restarts += 1
            time.sleep(3)
            self._run()

    def _verify(self, url: str) -> None:
        for _ in range(10):
            time.sleep(3)
            if self._stop.is_set() or self.snapshot()["url"] != url:
                return
            with contextlib.suppress(Exception):
                with urllib.request.urlopen(f"{url}/api/health", timeout=8) as response:
                    if response.status == 200:
                        self._set(verified=True)
                        log.info("Public URL verified: %s", url)
                        return
