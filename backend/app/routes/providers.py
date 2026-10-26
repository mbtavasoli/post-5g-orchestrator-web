"""SLICES and R2Lab provider status and authentication."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.providers.r2lab import R2LabService
from app.providers.slices import SlicesAuth
from app.schemas import ErrorResponse, JsonObject, R2LabSessionRequest

router = APIRouter(
    prefix="/api/providers",
    responses={401: {"model": ErrorResponse}, 502: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)


def get_slices(request: Request) -> SlicesAuth:
    return request.app.state.slices


def get_r2lab(request: Request) -> R2LabService:
    return request.app.state.r2lab


SlicesDependency = Annotated[SlicesAuth, Depends(get_slices)]
R2LabDependency = Annotated[R2LabService, Depends(get_r2lab)]


@router.get("/slices/auth", response_model=JsonObject)
async def slices_auth(slices: SlicesDependency, refresh: bool = False) -> JsonObject:
    """SLICES CLI login state on the backend host (never a token)."""
    return await slices.status(refresh=refresh)


@router.post("/slices/auth/login", response_model=JsonObject)
async def slices_login(slices: SlicesDependency) -> JsonObject:
    """Start `slices auth login` and return its browser verification URL."""
    return await slices.start_login()


@router.get("/r2lab/session", response_model=JsonObject)
def r2lab_session(r2lab: R2LabDependency) -> JsonObject:
    return r2lab.session_status()


@router.post("/r2lab/session", response_model=JsonObject)
async def r2lab_sign_in(body: R2LabSessionRequest, r2lab: R2LabDependency) -> JsonObject:
    """Check R2Lab credentials and keep them in backend memory for provisioning actions."""
    return await r2lab.login(body.email, body.password, body.slice)


@router.delete("/r2lab/session", response_model=JsonObject)
def r2lab_sign_out(r2lab: R2LabDependency) -> JsonObject:
    return r2lab.logout()


@router.get("/r2lab/reservation", response_model=JsonObject)
async def r2lab_reservation(r2lab: R2LabDependency) -> JsonObject:
    """Current and upcoming testbed leases (read live from the R2Lab API)."""
    return await r2lab.reservation()


@router.delete("/r2lab/leases/{lease_id}", response_model=JsonObject)
async def r2lab_release(lease_id: int, r2lab: R2LabDependency) -> JsonObject:
    """Release one of the signed-in slice's own leases."""
    return await r2lab.release(lease_id)


@router.get("/r2lab/devices", response_model=JsonObject)
async def r2lab_devices(
    r2lab: R2LabDependency,
    names: Annotated[list[str] | None, Query()] = None,
) -> JsonObject:
    """Devices known to the radio management API, with power state of `names` when signed in."""
    return await r2lab.devices(names)
