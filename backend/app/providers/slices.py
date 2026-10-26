"""SLICES authentication through the official SLICES CLI.

The orchestrator's BI (and POS) Ansible roles run `slices ...` on the backend host and
assume the CLI is already logged in (orchestrator `ansible/roles/provisioning/bi`).
Only the two documented auth commands are used
(https://doc.slices-ri.eu/SupportingServices/slicescli.html):

- `slices auth show`  -> prints "Logged in as '<user>'" when a login exists
- `slices auth login` -> device-code flow: prints a verification URL with a user_code
                         and waits until the user authorizes it in a browser

The CLI stores its token in ~/.slices/auth.json on the backend host; this module never
reads it. Token lifetime, expiry detection and refresh are not documented, so an expired
token may still be reported as logged in by `auth show`.
"""

import asyncio
import contextlib
import os
import re
import shutil
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_URL = re.compile(r"https?://\S+")
_USER = re.compile(r"Logged in as '([^']+)'")


def _clean(text: str) -> str:
    return _ANSI.sub("", text).strip()


@dataclass(slots=True)
class _Login:
    process: asyncio.subprocess.Process
    verification_url: str | None = None
    output: list[str] = field(default_factory=list)
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))


class SlicesAuth:
    """Report and start SLICES CLI authentication on the backend host."""

    def __init__(self, bin_dir: Path | None = None, cache_seconds: float = 30.0) -> None:
        self.bin_dir = bin_dir
        self.cache_seconds = cache_seconds
        self._login: _Login | None = None
        self._cached: tuple[datetime, dict] | None = None

    def _executable(self) -> str | None:
        search = os.pathsep.join(filter(None, [str(self.bin_dir) if self.bin_dir else None, os.environ.get("PATH")]))
        return shutil.which("slices", path=search)

    def _env(self) -> dict[str, str]:
        env = dict(os.environ, NO_COLOR="1")
        if self.bin_dir:
            env["PATH"] = f"{self.bin_dir}{os.pathsep}{env.get('PATH', '')}"
        return env

    async def status(self, refresh: bool = False) -> dict:
        """Return {state, user, verification_url, message, checked_at}; never a token."""
        if self._login is not None:
            if self._login.process.returncode is None:
                return self._result("pending", verification_url=self._login.verification_url,
                                    message="Waiting for authorization in the browser.")
            self._login = None
            refresh = True

        now = datetime.now(UTC)
        if not refresh and self._cached and (now - self._cached[0]).total_seconds() < self.cache_seconds:
            return self._cached[1]

        executable = self._executable()
        if executable is None:
            result = self._result("cli_missing", message=(
                "The SLICES CLI ('slices') is not installed on the backend host. Install it with "
                "'pip install slices-cli --extra-index-url=https://doc.slices-ri.eu/pypi/' "
                "or set POST5G_SLICES_BIN_DIR."
            ))
        else:
            try:
                process = await asyncio.create_subprocess_exec(
                    executable, "auth", "show",
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=self._env(),
                )
                output, _ = await asyncio.wait_for(process.communicate(), timeout=30)
                text = _clean(output.decode(errors="replace"))
                user = _USER.search(text)
                if process.returncode == 0 and user:
                    result = self._result("authenticated", user=user.group(1))
                else:
                    result = self._result("unauthenticated", message=text.splitlines()[-1] if text else None)
            except TimeoutError:
                result = self._result("unauthenticated", message="'slices auth show' timed out.")
        self._cached = (now, result)
        return result

    async def start_login(self) -> dict:
        """Start `slices auth login` and return the verification URL it prints."""
        if self._login is not None and self._login.process.returncode is None:
            return await self.status()
        executable = self._executable()
        if executable is None:
            return await self.status(refresh=True)

        process = await asyncio.create_subprocess_exec(
            executable, "auth", "login",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=self._env(),
        )
        login = _Login(process=process)
        self._login = login
        self._cached = None

        async def read_until_url() -> None:
            assert process.stdout is not None
            while login.verification_url is None:
                line = await process.stdout.readline()
                if not line:
                    return
                text = _clean(line.decode(errors="replace"))
                login.output.append(text)
                match = _URL.search(text)
                if match:
                    login.verification_url = match.group(0).rstrip(".,)")

        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(read_until_url(), timeout=30)
        asyncio.get_running_loop().create_task(self._drain(login))

        if login.verification_url is None:
            if process.returncode is None:
                process.kill()
            self._login = None
            message = " ".join(login.output[-3:]) or "The SLICES CLI did not print a verification URL."
            return self._result("unauthenticated", message=message)
        return await self.status()

    async def _drain(self, login: _Login) -> None:
        if login.process.stdout is not None:
            async for line in login.process.stdout:
                login.output.append(_clean(line.decode(errors="replace")))
        await login.process.wait()
        self._cached = None

    @staticmethod
    def _result(state: str, **values: str | None) -> dict:
        return {
            "provider": "slices",
            "state": state,
            "user": values.get("user"),
            "verification_url": values.get("verification_url"),
            "message": values.get("message"),
            "checked_at": datetime.now(UTC).isoformat(),
            "expiry_detectable": False,
        }
