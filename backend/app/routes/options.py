"""Model schema and model-derived option endpoints."""

from typing import Annotated

from fastapi import APIRouter, Path

from app import orchestrator_bridge as bridge
from app.schemas import ErrorResponse, JsonObject

router = APIRouter(
    prefix="/api",
    responses={
        404: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)


@router.get("/schema/metamodel", response_model=JsonObject)
def metamodel_schema() -> JsonObject:
    """Return the MetaModel validation JSON Schema."""
    return bridge.model_schema("metamodel")


@router.get("/schema/deployment-model", response_model=JsonObject)
def deployment_model_schema() -> JsonObject:
    """Return the DeploymentModel validation JSON Schema."""
    return bridge.model_schema("deployment-model")


@router.get("/options", response_model=JsonObject)
def option_catalog() -> JsonObject:
    """Return options introspected from the installed source models."""
    return bridge.options()


@router.get("/provider-catalogs", response_model=JsonObject)
def provider_catalogs() -> JsonObject:
    """Return curated provider inventories and source-model provisioner metadata."""
    return bridge.provider_catalogs()


@router.get(
    "/options/advanced-config/{category}/{implementation}/{type}",
    response_model=JsonObject,
)
def advanced_config_schema(
    category: str,
    implementation: str,
    component_type: Annotated[str, Path(alias="type")],
) -> JsonObject:
    """Return the advanced-config schema for a model combination."""
    return bridge.advanced_config_schema(category, implementation, component_type)
