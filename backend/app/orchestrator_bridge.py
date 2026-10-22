"""The backend's only integration point with orchestrator and metamodel."""

from dataclasses import dataclass
from importlib.metadata import version
from typing import Any

import yaml
from metamodel.models.metamodel import MetaModel
from orchestrator.deployment import (
    BaseManagement,
    CoreManagement,
    RANManagement,
    RICManagement,
    UEManagement,
)
from orchestrator.models.deployment import DeploymentModel
from orchestrator.utils.utils import InvalidResourceStateError, ReferenceNotFoundError
from pydantic import ValidationError

from app.schemas import JsonObject, ReconcileStage


@dataclass(frozen=True, slots=True)
class BridgeError(Exception):
    """An orchestrator error with its stable API classification."""

    kind: str
    stage: str
    exception: str
    message: str
    details: list[JsonObject] | None
    status_code: int

    def __str__(self) -> str:
        """Return the safe, user-facing message."""
        return self.message


def versions() -> dict[str, str]:
    """Return versions of the model and validation packages in use."""
    return {package: version(package) for package in ("orchestrator", "metamodel", "pydantic")}


def dump(model: MetaModel | DeploymentModel) -> JsonObject:
    """Return a complete JSON-compatible model representation."""
    return model.model_dump(mode="json")


def parse_metamodel(data: JsonObject | str | None) -> MetaModel:
    """Validate an object, YAML text, or defaults as a MetaModel."""
    return _parse_model(MetaModel, data, "metamodel")


def parse_deployment_model(data: JsonObject | str | None) -> DeploymentModel:
    """Validate an object, YAML text, or defaults as a DeploymentModel."""
    return _parse_model(DeploymentModel, data, "deployment_model")


def _parse_model(
    model_class: type[MetaModel] | type[DeploymentModel],
    data: JsonObject | str | None,
    location: str,
) -> MetaModel | DeploymentModel:
    try:
        if data is None:
            return model_class()
        if isinstance(data, str):
            return model_class.from_yaml(data)
        return model_class.model_validate(data)
    except ValidationError as exc:
        raise _validation_error(exc, stage="input", location=location) from exc
    except yaml.YAMLError as exc:
        problem = getattr(exc, "problem", None) or "The YAML text could not be parsed."
        raise BridgeError(
            kind="validation",
            stage="input",
            exception=type(exc).__name__,
            message=f"Invalid YAML for {location}: {problem}",
            details=None,
            status_code=422,
        ) from exc


def reconcile(
    metamodel: MetaModel,
    deployment_model: DeploymentModel,
    until: ReconcileStage,
) -> tuple[list[ReconcileStage], MetaModel, DeploymentModel]:
    """Run the existing manager reconciliation chain without actions or writes."""
    if until == "sync":
        manager = _create_manager(
            BaseManagement,
            stage="sync",
            metamodel=metamodel,
            deployment_model=deployment_model,
        )
        return ["sync"], manager.metamodel, manager.deployment_model

    manager_classes = (
        ("core", CoreManagement),
        ("ric", RICManagement),
        ("ran", RANManagement),
        ("ue", UEManagement),
    )
    stages: list[ReconcileStage] = []
    manager: BaseManagement | None = None

    for stage, manager_class in manager_classes:
        if manager is None:
            manager = _create_manager(
                manager_class,
                stage=stage,
                metamodel=metamodel,
                deployment_model=deployment_model,
            )
        else:
            manager = _create_manager(manager_class, stage=stage, preceding=manager)
        stages.append(stage)
        if stage == until:
            break

    if manager is None:  # pragma: no cover - ReconcileStage prevents this path.
        raise ValueError(f"Unsupported reconciliation stage: {until}")
    return stages, manager.metamodel, manager.deployment_model


def _create_manager(
    manager_class: type[BaseManagement],
    *,
    stage: ReconcileStage,
    **kwargs: Any,
) -> BaseManagement:
    try:
        return manager_class(**kwargs)
    except ValidationError as exc:
        raise _validation_error(exc, stage=stage, location="deployment_model") from exc
    except ReferenceNotFoundError as exc:
        raise BridgeError(
            kind="reference",
            stage=stage,
            exception=type(exc).__name__,
            message=str(exc),
            details=None,
            status_code=422,
        ) from exc
    except InvalidResourceStateError as exc:
        raise BridgeError(
            kind="state",
            stage=stage,
            exception=type(exc).__name__,
            message=str(exc),
            details=None,
            status_code=409,
        ) from exc
    except (ValueError, RuntimeError) as exc:
        raise BridgeError(
            kind="reconciliation",
            stage=stage,
            exception=type(exc).__name__,
            message=str(exc),
            details=None,
            status_code=422,
        ) from exc


def _validation_error(
    exc: ValidationError,
    *,
    stage: str,
    location: str | None = None,
) -> BridgeError:
    details = exc.errors(
        include_url=False,
        include_input=False,
        include_context=False,
    )
    if location is not None:
        details = [{**detail, "loc": [location, *detail["loc"]]} for detail in details]
    count = exc.error_count()
    noun = "error" if count == 1 else "errors"
    return BridgeError(
        kind="validation",
        stage=stage,
        exception=type(exc).__name__,
        message=f"{count} validation {noun} for {exc.title}.",
        details=details,
        status_code=422,
    )
