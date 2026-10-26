"""Keep secrets out of API responses and logs."""

import re
from collections.abc import Iterable
from typing import Any

MASK = "********"

# Model fields that hold secrets (SSHInfo, provisioner params, R2Lab params, K8S params).
SECRET_KEYS = frozenset({
    "password",
    "sudo_password",
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "join_command",
    "input_body",
})

_PATTERNS = (
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"),
    re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),  # JWTs
    re.compile(r"(?i)([\"']?(?:password|sudo_password|token|access_token|refresh_token)[\"']?\s*[:=]\s*[\"']?)[^\"',\s}]+"),
    re.compile(r"(kubeadm join \S+ --token )\S+( --discovery-token-ca-cert-hash )\S+"),
)


def redact_data(value: Any) -> Any:
    """Return a copy of JSON-like data with secret-valued keys masked."""
    if isinstance(value, dict):
        return {
            key: (MASK if key in SECRET_KEYS and item not in (None, "", {}, []) else redact_data(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_data(item) for item in value]
    return value


def collect_secret_values(value: Any) -> set[str]:
    """Collect secret strings from JSON-like data so they can be masked in free text."""
    found: set[str] = set()

    def walk(item: Any, secret: bool) -> None:
        if isinstance(item, dict):
            for key, child in item.items():
                walk(child, secret or key in SECRET_KEYS)
        elif isinstance(item, list):
            for child in item:
                walk(child, secret)
        elif secret and isinstance(item, str) and len(item) >= 4:
            found.add(item)

    walk(value, False)
    return found


def redact_text(text: str, secrets: Iterable[str] = ()) -> str:
    """Mask known secret values and common secret patterns in free text."""
    for secret in sorted(set(secrets), key=len, reverse=True):
        if len(secret) >= 4:
            text = text.replace(secret, MASK)
    for pattern in _PATTERNS:
        text = pattern.sub(lambda match: (match.group(1) if match.groups() else "") + MASK
                           + (match.group(2) + MASK if len(match.groups()) > 1 else ""), text)
    return text
