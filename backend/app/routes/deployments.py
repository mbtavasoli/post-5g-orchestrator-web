"""Health and v1 deployment endpoints."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request, status

from app import orchestrator_bridge as bridge
from app.schemas import (
    DeploymentMetadata,
    DeploymentResponse,
    DeploymentWrite,
    ErrorResponse,
    HealthResponse,
    ReconcileResponse,
)
from app.store import DeploymentStore

router = APIRouter(
    prefix="/api",
    responses={
        422: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)


def get_store(request: Request) -> DeploymentStore:
    """Return the application-scoped deployment store."""
    return request.app.state.store


StoreDependency = Annotated[DeploymentStore, Depends(get_store)]


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Report liveness and installed dependency versions."""
    return HealthResponse(versions=bridge.versions())


@router.post(
    "/deployments",
    response_model=DeploymentResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_deployment(body: DeploymentWrite, store: StoreDependency) -> DeploymentResponse:
    """Validate and store a new deployment model pair."""
    metamodel = bridge.parse_metamodel(body.metamodel)
    deployment_model = bridge.parse_deployment_model(body.deployment_model)
    metadata = store.create(body.name, metamodel, deployment_model)
    return DeploymentResponse(
        deployment=store.public_metadata(metadata),
        metamodel=bridge.dump(metamodel),
        deployment_model=bridge.dump(deployment_model),
    )


@router.get("/deployments", response_model=list[DeploymentMetadata])
def list_deployments(store: StoreDependency) -> list[DeploymentMetadata]:
    """List stored deployment metadata without loading model files."""
    return [store.public_metadata(metadata) for metadata in store.list()]


@router.get(
    "/deployments/{deployment_id}",
    response_model=DeploymentResponse,
    responses={404: {"model": ErrorResponse}},
)
def get_deployment(deployment_id: str, store: StoreDependency) -> DeploymentResponse:
    """Load a stored deployment and return complete model dumps."""
    metadata, metamodel, deployment_model = store.get(deployment_id)
    return DeploymentResponse(
        deployment=store.public_metadata(metadata),
        metamodel=bridge.dump(metamodel),
        deployment_model=bridge.dump(deployment_model),
    )


@router.put(
    "/deployments/{deployment_id}",
    response_model=DeploymentResponse,
    responses={404: {"model": ErrorResponse}},
)
def replace_deployment(
    deployment_id: str,
    body: DeploymentWrite,
    store: StoreDependency,
) -> DeploymentResponse:
    """Validate and replace both stored models for a deployment."""
    store.require(deployment_id)
    metamodel = bridge.parse_metamodel(body.metamodel)
    deployment_model = bridge.parse_deployment_model(body.deployment_model)
    metadata = store.replace(deployment_id, body.name, metamodel, deployment_model)
    return DeploymentResponse(
        deployment=store.public_metadata(metadata),
        metamodel=bridge.dump(metamodel),
        deployment_model=bridge.dump(deployment_model),
    )


@router.post(
    "/deployments/{deployment_id}/reconcile",
    response_model=ReconcileResponse,
    responses={
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
    },
)
def reconcile_deployment(
    deployment_id: str,
    store: StoreDependency,
    until: Annotated[
        Literal["sync", "core", "ric", "ran", "ue"],
        Query(),
    ] = "ric",
) -> ReconcileResponse:
    """Reconcile stored input through the requested manager stage without saving."""
    _, metamodel, deployment_model = store.get(deployment_id)
    stages, reconciled_metamodel, reconciled_deployment_model = bridge.reconcile(
        metamodel,
        deployment_model,
        until,
    )
    return ReconcileResponse(
        until=until,
        stages=stages,
        metamodel=bridge.dump(reconciled_metamodel),
        deployment_model=bridge.dump(reconciled_deployment_model),
    )
