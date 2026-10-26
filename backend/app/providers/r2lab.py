"""R2Lab provider service.

Mutating radio operations (reservation, power on/off, UE connect) stay in the orchestrator's
`r2lab` provisioner and run as deployment actions. This module only does what the
orchestrator does not expose, using endpoints from the published OpenAPI specs:

R2Lab API (`<r2lab_api>/openapi.json`)
- POST /auth/login                 check credentials (JWT with `exp`, decodable per the API doc)
- GET  /slices/by-name/{name}      check that the slice is visible to the user
- GET  /resources                  testbed resources
- GET  /leases/current             currently active lease (public)
- GET  /leases                     leases, filtered by resource and time (public)
- DELETE /leases/{lease_id}        release the user's own lease

Device manager (`<device_api>/openapi.json`)
- GET  /resource/list              devices known to the radio management API (public)
- POST /token/r2lab                device-manager token (email, password, slice)
- GET  /power/{name}/status        power state of a device

Base URLs are the orchestrator's own defaults (`R2LabReservationParams.r2lab_api_url`,
`UnifiedRadioParams.base_url`). Credentials stay in this process's memory and are never
written to disk or returned to the browser.
"""

import base64
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

from app.orchestrator_actions import R2LabCredentials, r2lab_endpoints
from app.orchestrator_bridge import BridgeError

# The orchestrator's reserve role leases resource_id 1 ("r2lab"): the whole testbed.
R2LAB_RESOURCE_ID = 1


@dataclass(slots=True)
class _Session:
    credentials: R2LabCredentials
    api_token: str
    api_token_exp: datetime | None
    device_token: str | None = None
    device_token_exp: datetime | None = None


def _jwt_expiry(token: str) -> datetime | None:
    try:
        payload = token.split(".")[1]
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return datetime.fromtimestamp(int(data["exp"]), UTC)
    except (IndexError, KeyError, ValueError, TypeError):
        return None


def _provider_error(message: str, status_code: int = 502, kind: str = "provider_error",
                    exception: str = "R2LabAPIError") -> BridgeError:
    return BridgeError(kind=kind, stage="provider", exception=exception, message=message,
                       details=None, status_code=status_code, provider="r2lab")


class R2LabService:
    """Session, reservation and device status for R2Lab."""

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None, timeout: float = 20.0) -> None:
        endpoints = r2lab_endpoints()
        self.api_url = endpoints["r2lab_api"]
        self.device_url = endpoints["device_api"]
        self._transport = transport
        self._timeout = timeout
        self._session: _Session | None = None
        self._reservation_cache: tuple[datetime, str | None, dict] | None = None

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=self._timeout, transport=self._transport)

    async def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        try:
            async with self._client() as client:
                return await client.request(method, url, **kwargs)
        except httpx.HTTPError as exc:
            raise _provider_error(f"R2Lab request to {httpx.URL(url).host} failed: {type(exc).__name__}.") from exc

    @staticmethod
    def _detail(response: httpx.Response) -> str:
        try:
            detail = response.json().get("detail")
        except (ValueError, AttributeError):
            detail = None
        if isinstance(detail, list):
            detail = "; ".join(str(item.get("msg", item)) for item in detail if isinstance(item, dict))
        return f"HTTP {response.status_code}" + (f": {detail}" if detail else "")

    # ---- session -------------------------------------------------------------------

    async def login(self, email: str, password: str, slice_name: str) -> dict:
        """Verify credentials and slice with the R2Lab API, then keep them in memory."""
        response = await self._request("POST", f"{self.api_url}/auth/login",
                                       json={"email": email, "password": password})
        if response.status_code != 200:
            raise _provider_error(f"R2Lab login failed ({self._detail(response)}).", status_code=401,
                                  kind="authentication_required", exception="R2LabAuthenticationError")
        token = response.json().get("access_token")
        if not isinstance(token, str):
            raise _provider_error("R2Lab login returned no access token.")

        slice_response = await self._request("GET", f"{self.api_url}/slices/by-name/{slice_name}",
                                             headers={"Authorization": f"Bearer {token}"})
        if slice_response.status_code != 200:
            raise _provider_error(
                f"R2Lab slice {slice_name!r} is not available to this account ({self._detail(slice_response)}).",
                status_code=422, kind="resource_unavailable", exception="R2LabSliceError",
            )

        self._session = _Session(
            credentials=R2LabCredentials(email=email, password=password, slice=slice_name),
            api_token=token,
            api_token_exp=_jwt_expiry(token),
        )
        return self.session_status()

    def logout(self) -> dict:
        self._session = None
        return self.session_status()

    def credentials(self) -> R2LabCredentials | None:
        return self._session.credentials if self._session else None

    def session_status(self) -> dict:
        session = self._session
        if session is None:
            return {"provider": "r2lab", "state": "unauthenticated", "email": None, "slice": None, "expires_at": None}
        expired = session.api_token_exp is not None and session.api_token_exp <= datetime.now(UTC)
        return {
            "provider": "r2lab",
            # Credentials are kept, so an expired API token is renewed with a new login on demand.
            "state": "authenticated",
            "email": session.credentials.email,
            "slice": session.credentials.slice,
            "expires_at": session.api_token_exp.isoformat() if session.api_token_exp else None,
            "token_expired": expired,
        }

    async def _api_token(self) -> str:
        session = self._require_session()
        if session.api_token_exp and session.api_token_exp <= datetime.now(UTC):
            credentials = session.credentials
            await self.login(credentials.email, credentials.password, credentials.slice)
            session = self._require_session()
        return session.api_token

    async def _device_token(self) -> str:
        session = self._require_session()
        now = datetime.now(UTC)
        if session.device_token and (session.device_token_exp is None or session.device_token_exp > now):
            return session.device_token
        credentials = session.credentials
        response = await self._request("POST", f"{self.device_url}/token/r2lab", json={
            "email": credentials.email, "password": credentials.password, "slice": credentials.slice,
        })
        if response.status_code != 200:
            raise _provider_error(f"Device manager token request failed ({self._detail(response)}).",
                                  status_code=401, kind="authentication_required")
        body = response.json()
        session.device_token = body.get("access_token")
        expires_at = body.get("expires_at")
        session.device_token_exp = datetime.fromtimestamp(int(expires_at), UTC) if expires_at else None
        if not session.device_token:
            raise _provider_error("Device manager returned no access token.")
        return session.device_token

    def _require_session(self) -> _Session:
        if self._session is None:
            raise _provider_error("Sign in to R2Lab first.", status_code=401,
                                  kind="authentication_required", exception="R2LabAuthenticationRequired")
        return self._session

    # ---- reservation ---------------------------------------------------------------

    async def reservation(self, max_age_seconds: float = 15.0) -> dict:
        """Current and upcoming testbed leases, and whether the current one is the user's."""
        my_slice = self._session.credentials.slice if self._session else None
        cached = self._reservation_cache
        if cached and cached[1] == my_slice and (datetime.now(UTC) - cached[0]).total_seconds() < max_age_seconds:
            return cached[2]
        result = await self._read_reservation()
        self._reservation_cache = (datetime.now(UTC), my_slice, result)
        return result

    async def _read_reservation(self) -> dict:
        current_response = await self._request("GET", f"{self.api_url}/leases/current",
                                               params={"resource_id": R2LAB_RESOURCE_ID})
        if current_response.status_code != 200:
            raise _provider_error(f"Could not read the current R2Lab lease ({self._detail(current_response)}).")
        upcoming_response = await self._request("GET", f"{self.api_url}/leases",
                                                params={"resource_id": R2LAB_RESOURCE_ID, "after": "now"})
        upcoming = upcoming_response.json() if upcoming_response.status_code == 200 else []

        my_slice = self._session.credentials.slice if self._session else None
        current = current_response.json()
        if current is None:
            state = "not_reserved"
        elif my_slice and current.get("slice_name") == my_slice:
            state = "reserved_by_you"
        else:
            state = "reserved_by_other"

        def lease(item: dict) -> dict:
            return {
                "id": item.get("id"),
                "slice_name": item.get("slice_name"),
                "t_from": item.get("t_from"),
                "t_until": item.get("t_until"),
                "mine": bool(my_slice and item.get("slice_name") == my_slice),
            }

        return {
            "state": state,
            "current": lease(current) if current else None,
            "upcoming": [lease(item) for item in upcoming[:20] if isinstance(item, dict)],
            "slice": my_slice,
            "checked_at": datetime.now(UTC).isoformat(),
        }

    async def release(self, lease_id: int) -> dict:
        """Delete one of the user's own leases."""
        reservation = await self.reservation(max_age_seconds=0)
        leases = [reservation["current"], *reservation["upcoming"]]
        target = next((item for item in leases if item and item["id"] == lease_id), None)
        if target is None or not target["mine"]:
            raise _provider_error("Only a lease of your own slice can be released.", status_code=403,
                                  kind="conflict", exception="R2LabLeaseNotOwned")
        token = await self._api_token()
        response = await self._request("DELETE", f"{self.api_url}/leases/{lease_id}",
                                       headers={"Authorization": f"Bearer {token}"})
        if response.status_code not in (200, 204):
            raise _provider_error(f"Releasing lease {lease_id} failed ({self._detail(response)}).")
        return await self.reservation(max_age_seconds=0)

    # ---- devices -------------------------------------------------------------------

    async def devices(self, names: list[str] | None = None) -> dict:
        """Devices known to the radio management API, with power state when signed in."""
        response = await self._request("GET", f"{self.device_url}/resource/list")
        if response.status_code != 200:
            raise _provider_error(f"Could not list R2Lab devices ({self._detail(response)}).")
        known = {
            item["name"]: {"name": item["name"], "infrastructure": item.get("infrastructure"),
                           "ips": (item.get("misc") or {}).get("ips")}
            for item in response.json() if isinstance(item, dict) and "name" in item
        }

        power: dict[str, dict] = {}
        if names and self._session is not None:
            try:
                token = await self._device_token()
                for name in names:
                    if name not in known:
                        continue
                    status = await self._request("GET", f"{self.device_url}/power/{name}/status",
                                                 headers={"Authorization": f"Bearer {token}"})
                    if status.status_code == 200:
                        body = status.json()
                        power[name] = {"power_status": body.get("power_status"), "success": body.get("success")}
                    else:
                        power[name] = {"error": self._detail(status)}
            except BridgeError as exc:
                power = {name: {"error": exc.message} for name in names}

        return {
            "known": known,
            "requested": [
                {"name": name, "known": name in known, **({"power": power[name]} if name in power else {})}
                for name in (names or [])
            ],
            "checked_at": datetime.now(UTC).isoformat(),
        }

    def secrets(self) -> set[str]:
        session = self._session
        if session is None:
            return set()
        return {value for value in (session.credentials.password, session.api_token, session.device_token) if value}
