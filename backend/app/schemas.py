"""HTTP request and response schemas."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

JsonObject = dict[str, Any]
ModelInput = JsonObject | str | None
ReconcileStage = Literal["sync", "core", "ric", "ran", "ue"]
DeploymentStage = Literal["infrastructure", "kubernetes", "core", "ric", "radio", "ran", "ue"]
StageAction = Literal["deploy", "remove", "reserve"]
ErrorKind = Literal[
    "validation",
    "reference",
    "state",
    "reconciliation",
    "not_found",
    "conflict",
    "authentication_required",
    "reservation_required",
    "resource_unavailable",
    "provisioning_failure",
    "kubernetes_failure",
    "component_failure",
    "provider_error",
    "internal",
]
ErrorStage = Literal[
    "input", "sync", "provider",
    "infrastructure", "kubernetes", "core", "ric", "radio", "ran", "ue",
]


class DeploymentWrite(BaseModel):
    """Create or replace a stored deployment pair."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    metamodel: ModelInput = None
    deployment_model: ModelInput = None


class DeploymentMetadata(BaseModel):
    """Public deployment metadata."""

    id: str
    name: str
    created_at: datetime
    updated_at: datetime


class StoredDeploymentMetadata(DeploymentMetadata):
    """Metadata persisted on disk, including dependency versions."""

    orchestrator: str
    metamodel: str


class DeploymentResponse(BaseModel):
    """A deployment and its two stored models."""

    deployment: DeploymentMetadata
    metamodel: JsonObject
    deployment_model: JsonObject


class ReconcileResponse(BaseModel):
    """The transient result of a reconciliation chain."""

    until: ReconcileStage
    stages: list[ReconcileStage]
    metamodel: JsonObject
    deployment_model: JsonObject


class HealthResponse(BaseModel):
    """Service liveness and installed dependency versions."""

    status: Literal["ok"] = "ok"
    versions: dict[str, str]


class ErrorBody(BaseModel):
    """Stable error description returned by every endpoint."""

    kind: ErrorKind
    stage: ErrorStage
    exception: str
    message: str
    details: list[JsonObject] | None = None
    provider: Literal["slices", "r2lab"] | None = None


class ErrorResponse(BaseModel):
    """Shared API error envelope."""

    error: ErrorBody


class ActionRequest(BaseModel):
    """Start a long-running deployment action."""

    model_config = ConfigDict(extra="forbid")

    action: StageAction = "deploy"
    stages: list[DeploymentStage] | None = None
    """Stages to run in order. None means every remaining applicable stage (deploy only)."""
    reservation_minutes: int | None = Field(default=None, ge=10)
    """R2Lab lease length for the 'reserve' action (R2Lab leases use 10-minute granularity)."""


JobStatus = Literal["queued", "running", "succeeded", "failed", "blocked", "interrupted"]


class StageRun(BaseModel):
    """Outcome of one stage inside a job."""

    stage: DeploymentStage
    action: StageAction = "deploy"
    status: Literal["pending", "running", "succeeded", "failed", "blocked", "skipped"]
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: ErrorBody | None = None


class JobRecord(BaseModel):
    """A persisted long-running action on one deployment."""

    id: str
    deployment_id: str
    action: StageAction
    status: JobStatus
    stages: list[StageRun]
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: ErrorBody | None = None
    reservation_minutes: int | None = None


class R2LabSessionRequest(BaseModel):
    """R2Lab credentials, kept in backend memory only."""

    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3)
    password: str = Field(min_length=1)
    slice: str = Field(min_length=1)
