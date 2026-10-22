"""HTTP request and response schemas."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

JsonObject = dict[str, Any]
ModelInput = JsonObject | str | None
ReconcileStage = Literal["sync", "core", "ric", "ran", "ue"]


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

    kind: Literal[
        "validation",
        "reference",
        "state",
        "reconciliation",
        "not_found",
        "internal",
    ]
    stage: Literal["input", "sync", "core", "ric", "ran", "ue"]
    exception: str
    message: str
    details: list[JsonObject] | None = None


class ErrorResponse(BaseModel):
    """Shared API error envelope."""

    error: ErrorBody
