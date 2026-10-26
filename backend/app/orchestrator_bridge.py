"""The backend's only integration point with orchestrator and metamodel."""

from dataclasses import dataclass
from enum import Enum
from functools import cache, lru_cache
from importlib.metadata import version
from pathlib import Path
from typing import Annotated, Any, get_args, get_origin

import yaml
from metamodel.models.core import CoreComponentType
from metamodel.models.metamodel import MetaModel
from metamodel.models.ran import RANComponentType
from metamodel.models.ric import RICComponentType
from metamodel.models.ru import CATALOGS, RUType
from metamodel.models.ue import UE, UEType
from orchestrator.deployment import (
    BaseManagement,
    CoreManagement,
    RANManagement,
    RICManagement,
    UEManagement,
)
from orchestrator.models.core import (
    ADVANCED_CORE_CONFIG_MAPPING,
    SUPPORTED_CORE_COMPONENTS,
    CoreDeployment,
    CoreImplementation,
    GenericAdvancedCoreConfig,
)
from orchestrator.models.deployment import DeploymentModel
from orchestrator.models.provisioning import (
    BIParams,
    BIProvisioner,
    NodeRole,
    Provisioner,
    ProvisioningType,
    R2LabParams,
    R2LabProvisioner,
)
from orchestrator.models.ran import (
    ADVANCED_RAN_CONFIG_MAPPING,
    SUPPORTED_RAN_COMPONENTS,
    GenericAdvancedRANConfig,
    RANDeployment,
    RANImplementation,
)
from orchestrator.models.ric import (
    ADVANCED_RIC_CONFIG_MAPPING,
    SUPPORTED_RIC_COMPONENTS,
    GenericAdvancedRICConfig,
    RICDeployment,
    RICImplementation,
)
from orchestrator.models.ue import (
    ADVANCED_UE_CONFIG_MAPPING,
    DeployedUE,
    GenericAdvancedUEConfig,
    UEImplementation,
)
from orchestrator.utils.defaults import (
    CORE_POD_PRIVILEGES,
    DEFAULT_CORE_DATABASE_IMAGES,
    DEFAULT_CORE_IMAGES,
    DEFAULT_RAN_IMAGES,
    DEFAULT_RIC_IMAGES,
    DEFAULT_UE_IMAGES,
    RAN_POD_PRIVILEGES,
    RIC_POD_PRIVILEGES,
    UE_POD_PRIVILEGES,
)
from orchestrator.utils.utils import InvalidResourceStateError, ReferenceNotFoundError
from pydantic import BaseModel, ValidationError

from app.schemas import JsonObject, ReconcileStage

PROVIDER_CATALOG_PATH = Path(__file__).resolve().parents[2] / "docs" / "provider-catalogs.yaml"


@dataclass(frozen=True, slots=True)
class BridgeError(Exception):
    """An orchestrator error with its stable API classification."""

    kind: str
    stage: str
    exception: str
    message: str
    details: list[JsonObject] | None
    status_code: int
    provider: str | None = None

    def body(self) -> JsonObject:
        """Return the public error envelope body."""
        return {
            "kind": self.kind,
            "stage": self.stage,
            "exception": self.exception,
            "message": self.message,
            "details": self.details,
            "provider": self.provider,
        }

    def __str__(self) -> str:
        """Return the safe, user-facing message."""
        return self.message


def versions() -> dict[str, str]:
    """Return versions of the model and validation packages in use."""
    return {package: version(package) for package in ("orchestrator", "metamodel", "pydantic")}


@lru_cache(maxsize=2)
def model_schema(which: str) -> JsonObject:
    """Return the validation JSON Schema for one of the two source models."""
    models = {
        "metamodel": MetaModel,
        "deployment-model": DeploymentModel,
    }
    model = models.get(which)
    if model is None:
        raise _options_not_found(f"Unknown model schema {which!r}.")
    return model.model_json_schema(mode="validation")


@lru_cache(maxsize=1)
def options() -> JsonObject:
    """Build the option catalog entirely from installed model sources."""
    metamodel_defaults = MetaModel()
    return {
        "versions": {
            package: installed_version
            for package, installed_version in versions().items()
            if package in {"orchestrator", "metamodel"}
        },
        "core": _network_options(
            implementation_enum=CoreImplementation,
            deployment_model=CoreDeployment,
            component_enum=CoreComponentType,
            supported=SUPPORTED_CORE_COMPONENTS,
            advanced=ADVANCED_CORE_CONFIG_MAPPING,
            default_images=DEFAULT_CORE_IMAGES,
            pod_privileges=CORE_POD_PRIVILEGES,
            default_components=metamodel_defaults.core.components,
        )
        | {"default_database_images": _jsonable(DEFAULT_CORE_DATABASE_IMAGES)},
        "ran": _network_options(
            implementation_enum=RANImplementation,
            deployment_model=RANDeployment,
            component_enum=RANComponentType,
            supported=SUPPORTED_RAN_COMPONENTS,
            advanced=ADVANCED_RAN_CONFIG_MAPPING,
            default_images=DEFAULT_RAN_IMAGES,
            pod_privileges=RAN_POD_PRIVILEGES,
            default_components=metamodel_defaults.ran.components,
        ),
        "ric": _network_options(
            implementation_enum=RICImplementation,
            deployment_model=RICDeployment,
            component_enum=RICComponentType,
            supported=SUPPORTED_RIC_COMPONENTS,
            advanced=ADVANCED_RIC_CONFIG_MAPPING,
            default_images=DEFAULT_RIC_IMAGES,
            pod_privileges=RIC_POD_PRIVILEGES,
            default_components=metamodel_defaults.ric.components,
        ),
        "ue": {
            "types": _enum_values(UEType),
            "implementations": _enum_values(UEImplementation),
            "default_implementation": _field_default_value(DeployedUE, "implementation"),
            "advanced_config": _advanced_config_names(UEImplementation, ADVANCED_UE_CONFIG_MAPPING),
            "default_images": _jsonable(DEFAULT_UE_IMAGES),
            "pod_privileges": _jsonable(UE_POD_PRIVILEGES),
            "default_components": _component_defaults(metamodel_defaults.ues),
        },
        "ru": _ru_options(metamodel_defaults),
        "provisioners": _provisioner_options(),
        "node_roles": _node_role_values(),
    }


@lru_cache(maxsize=1)
def provider_catalogs() -> JsonObject:
    """Return curated provider inventory, checked against installed model catalogs."""
    with PROVIDER_CATALOG_PATH.open(encoding="utf-8") as catalog_file:
        catalog = yaml.safe_load(catalog_file)

    if not isinstance(catalog, dict):
        raise ValueError("Provider catalog root must be a mapping.")
    _validate_provider_catalog(catalog)
    return catalog | {
        "provisioner_models": {
            "bi": {
                "type": ProvisioningType.BI.value,
                "params_defaults": BIParams().model_dump(mode="json"),
                "params_schema": BIParams.model_json_schema(mode="validation"),
                "provisioner_schema": BIProvisioner.model_json_schema(mode="validation"),
            },
            "r2lab": {
                "type": ProvisioningType.R2LAB.value,
                "params_schema": R2LabParams.model_json_schema(mode="validation"),
                "provisioner_schema": R2LabProvisioner.model_json_schema(mode="validation"),
            },
        },
    }


def _validate_provider_catalog(catalog: JsonObject) -> None:
    """Reject catalog entries that no longer match the installed source models."""
    slices = catalog.get("slices")
    r2lab = catalog.get("r2lab")
    if not isinstance(slices, dict) or not isinstance(r2lab, dict):
        raise ValueError("Provider catalog must define 'slices' and 'r2lab' mappings.")

    sophianodes = slices.get("sophianodes")
    required_sophianodes = r2lab.get("required_sophianodes")
    if not isinstance(sophianodes, list) or not isinstance(required_sophianodes, list):
        raise ValueError("Provider catalog must define SophiaNode inventory and R2Lab server requirements.")
    eligible = {
        node.get("id")
        for node in sophianodes
        if isinstance(node, dict) and node.get("r2lab_radio_capable") is True
    }
    if set(required_sophianodes) != eligible:
        raise ValueError("R2Lab required SophiaNodes must match radio-capable SLICES inventory entries.")

    radio_units = r2lab.get("radio_units")
    if not isinstance(radio_units, list):
        raise ValueError("R2Lab radio unit catalog must be a list.")
    for radio_unit in radio_units:
        if not isinstance(radio_unit, dict):
            raise ValueError("R2Lab radio unit entries must be mappings.")
        ru_type = RUType(radio_unit.get("type"))
        catalog_entry = CATALOGS.get(ru_type)
        if catalog_entry is None:
            raise ValueError(f"R2Lab RU {radio_unit.get('id')!r} uses a type without a model catalog.")
        model_enum, _ = catalog_entry
        model_enum(radio_unit.get("model"))

    user_equipment = r2lab.get("user_equipment")
    if not isinstance(user_equipment, list):
        raise ValueError("R2Lab UE catalog must be a list.")
    for ue in user_equipment:
        if not isinstance(ue, dict):
            raise ValueError("R2Lab UE entries must be mappings.")
        UE.model_validate({"type": UEType.COTS, "config": {"supi": ue.get("imsi")}})


@cache
def advanced_config_schema(category: str, implementation: str, component_type: str) -> JsonObject:
    """Return the mapped advanced-config schema, with the strict generic fallback."""
    sources = {
        "core": (
            CoreImplementation,
            CoreComponentType,
            ADVANCED_CORE_CONFIG_MAPPING,
            GenericAdvancedCoreConfig,
        ),
        "ran": (
            RANImplementation,
            RANComponentType,
            ADVANCED_RAN_CONFIG_MAPPING,
            GenericAdvancedRANConfig,
        ),
        "ric": (
            RICImplementation,
            RICComponentType,
            ADVANCED_RIC_CONFIG_MAPPING,
            GenericAdvancedRICConfig,
        ),
        "ue": (
            UEImplementation,
            UEType,
            ADVANCED_UE_CONFIG_MAPPING,
            GenericAdvancedUEConfig,
        ),
    }
    source = sources.get(category)
    if source is None:
        raise _options_not_found(f"Unknown advanced-config category {category!r}.")

    implementation_enum, component_enum, mapping, generic_model = source
    try:
        implementation_member = implementation_enum(implementation)
    except ValueError as exc:
        raise _options_not_found(
            f"Unknown {category} implementation {implementation!r}.",
        ) from exc
    try:
        component_member = component_enum(component_type)
    except ValueError as exc:
        raise _options_not_found(
            f"Unknown {category} component type {component_type!r}.",
        ) from exc

    config_model = mapping.get(implementation_member, {}).get(component_member, generic_model)
    return config_model.model_json_schema(mode="validation")


def _network_options(
    *,
    implementation_enum: type[Enum],
    deployment_model: type[BaseModel],
    component_enum: type[Enum],
    supported: dict[Any, Any],
    advanced: dict[Any, Any],
    default_images: dict[Any, Any],
    pod_privileges: dict[Any, Any],
    default_components: dict[str, BaseModel],
) -> JsonObject:
    return {
        "implementations": _enum_values(implementation_enum),
        "default_implementation": _field_default_value(deployment_model, "implementation"),
        "component_types": _enum_values(component_enum),
        "supported_components": {
            member.value: _enum_collection_values(supported.get(member, ())) for member in implementation_enum
        },
        "advanced_config": _advanced_config_names(implementation_enum, advanced),
        "default_images": _jsonable(default_images),
        "pod_privileges": _jsonable(pod_privileges),
        "default_components": _component_defaults(default_components),
    }


def _advanced_config_names(implementation_enum: type[Enum], mapping: dict[Any, Any]) -> JsonObject:
    return {
        implementation.value: {
            component_type.value: config_model.__name__
            for component_type, config_model in mapping.get(implementation, {}).items()
        }
        for implementation in implementation_enum
    }


def _ru_options(metamodel_defaults: MetaModel) -> JsonObject:
    models: JsonObject = {}
    capabilities: JsonObject = {}
    for ru_type in RUType:
        catalog_entry = CATALOGS.get(ru_type)
        if catalog_entry is None:
            models[ru_type.value] = []
            capabilities[ru_type.value] = {}
            continue
        model_enum, catalog = catalog_entry
        models[ru_type.value] = _enum_values(model_enum)
        capabilities[ru_type.value] = {
            model.value: capability.model_dump(mode="json") for model, capability in catalog.items()
        }
    return {
        "types": _enum_values(RUType),
        "models": models,
        "capabilities": capabilities,
        "default_components": _component_defaults(metamodel_defaults.rus),
    }


def _component_defaults(components: dict[str, BaseModel]) -> JsonObject:
    """Return stable names and discriminating fields from model default factories."""
    return {
        name: {
            field: _jsonable(getattr(component, field))
            for field in ("type", "model", "implementation")
            if hasattr(component, field)
        }
        for name, component in components.items()
    }


def _provisioner_options() -> JsonObject:
    categories_by_type: JsonObject = {member.value: [] for member in ProvisioningType}
    for provisioner_model in _union_members(Provisioner):
        provisioner_type = get_args(provisioner_model.model_fields["type"].annotation)[0]
        categories = provisioner_model.model_fields["supported_categories"].get_default(
            call_default_factory=True,
        )
        categories_by_type[provisioner_type.value] = _enum_collection_values(categories)

    default_instances = DeploymentModel().provisioners
    return {
        "types": _enum_values(ProvisioningType),
        "supported_categories": categories_by_type,
        "default_instances": {
            name: {
                "type": provisioner.type.value,
                "supported_categories": _enum_collection_values(provisioner.supported_categories),
            }
            for name, provisioner in default_instances.items()
        },
    }


def _node_role_values() -> list[str]:
    return list(
        dict.fromkeys(member.value for enum_class in _union_members(NodeRole) for member in enum_class),
    )


def _union_members(alias: Any) -> tuple[Any, ...]:
    annotation = getattr(alias, "__value__", alias)
    if get_origin(annotation) is Annotated:
        annotation = get_args(annotation)[0]
    return get_args(annotation)


def _enum_values(enum_class: type[Enum]) -> list[Any]:
    return [member.value for member in enum_class]


def _enum_collection_values(values: Any) -> list[Any]:
    serialized = [member.value for member in values]
    return sorted(serialized) if isinstance(values, (set, frozenset)) else serialized


def _field_default_value(model: type[BaseModel], field: str) -> Any:
    default = model.model_fields[field].get_default(call_default_factory=True)
    return default.value if isinstance(default, Enum) else default


def _jsonable(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {_jsonable(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return sorted((_jsonable(item) for item in value), key=str)
    return value


def _options_not_found(message: str) -> BridgeError:
    return BridgeError(
        kind="not_found",
        stage="input",
        exception="OptionsNotFoundError",
        message=message,
        details=None,
        status_code=404,
    )


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
