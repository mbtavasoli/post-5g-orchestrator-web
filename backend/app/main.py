"""FastAPI application assembly and shared exception handling."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.jobs import JobRunner
from app.orchestrator_bridge import BridgeError
from app.providers.r2lab import R2LabService
from app.providers.slices import SlicesAuth
from app.routes.actions import router as actions_router
from app.routes.deployments import router as deployments_router
from app.routes.options import router as options_router
from app.routes.providers import router as providers_router
from app.schemas import ErrorBody, ErrorResponse
from app.settings import Settings
from app.store import DeploymentNotFoundError, DeploymentStore

logger = logging.getLogger(__name__)


def _error_response(status_code: int, **kwargs: Any) -> JSONResponse:
    envelope = ErrorResponse(error=ErrorBody(**kwargs)).model_dump(mode="json")
    if envelope["error"].get("provider") is None:
        envelope["error"].pop("provider", None)
    return JSONResponse(status_code=status_code, content=envelope)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create an application, optionally with isolated settings for tests."""
    configured_settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.jobs.mark_interrupted()
        yield
        await app.state.jobs.wait_idle()

    application = FastAPI(title="Post-5G Orchestrator API", version="1.1.0", lifespan=lifespan)
    store = DeploymentStore(configured_settings.data_dir)
    slices = SlicesAuth(bin_dir=configured_settings.slices_bin_dir)
    r2lab = R2LabService()
    application.state.settings = configured_settings
    application.state.store = store
    application.state.slices = slices
    application.state.r2lab = r2lab
    application.state.jobs = JobRunner(store, configured_settings, slices, r2lab)
    application.include_router(deployments_router)
    application.include_router(options_router)
    application.include_router(actions_router)
    application.include_router(providers_router)

    @application.exception_handler(BridgeError)
    async def handle_bridge_error(_request: Request, exc: BridgeError) -> JSONResponse:
        return _error_response(exc.status_code, **exc.body())

    @application.exception_handler(DeploymentNotFoundError)
    async def handle_not_found(_request: Request, exc: DeploymentNotFoundError) -> JSONResponse:
        return _error_response(
            404,
            kind="not_found",
            stage="input",
            exception=type(exc).__name__,
            message=str(exc),
            details=None,
        )

    @application.exception_handler(RequestValidationError)
    async def handle_request_validation(_request: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {key: value for key, value in detail.items() if key not in {"input", "ctx", "url"}}
            for detail in exc.errors()
        ]
        count = len(details)
        noun = "error" if count == 1 else "errors"
        return _error_response(
            422,
            kind="validation",
            stage="input",
            exception=type(exc).__name__,
            message=f"{count} request validation {noun}.",
            details=details,
        )

    @application.exception_handler(StarletteHTTPException)
    async def handle_http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        kind = "not_found" if exc.status_code == 404 else "internal"
        message = "Resource not found." if exc.status_code == 404 else "HTTP request failed."
        return _error_response(
            exc.status_code,
            kind=kind,
            stage="input",
            exception=type(exc).__name__,
            message=message,
            details=None,
        )

    @application.exception_handler(Exception)
    async def handle_internal_error(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled backend error for %s %s", request.method, request.url.path, exc_info=exc)
        return _error_response(
            500,
            kind="internal",
            stage="input",
            exception="InternalServerError",
            message="An internal server error occurred.",
            details=None,
        )

    return application


app = create_app()
