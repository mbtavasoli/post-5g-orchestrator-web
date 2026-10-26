"""Tests for model schemas and dynamically derived option catalogs."""

from enum import Enum
from importlib.metadata import version
from typing import Annotated, Any, get_args, get_origin

import pytest
from fastapi.testclient import TestClient
from metamodel.models.core import CoreComponentType
from metamodel.models.metamodel import MetaModel
from metamodel.models.ran import RANComponentType
from metamodel.models.ric import RICComponentType
from metamodel.models.ru import CATALOGS, RUType
from metamodel.models.ue import UE, UEType
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
from pydantic import BaseModel

NETWORK_SOURCES = {
    "core": (
        CoreImplementation,
        CoreDeployment,
        CoreComponentType,
        SUPPORTED_CORE_COMPONENTS,
        ADVANCED_CORE_CONFIG_MAPPING,
        DEFAULT_CORE_IMAGES,
        CORE_POD_PRIVILEGES,
    ),
    "ran": (
        RANImplementation,
        RANDeployment,
        RANComponentType,
        SUPPORTED_RAN_COMPONENTS,
        ADVANCED_RAN_CONFIG_MAPPING,
        DEFAULT_RAN_IMAGES,
        RAN_POD_PRIVILEGES,
    ),
    "ric": (
        RICImplementation,
        RICDeployment,
        RICComponentType,
        SUPPORTED_RIC_COMPONENTS,
        ADVANCED_RIC_CONFIG_MAPPING,
        DEFAULT_RIC_IMAGES,
        RIC_POD_PRIVILEGES,
    ),
}

ADVANCED_SOURCES = {
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

MAPPED_ADVANCED_CASES = [
    (category, implementation.value, component_type.value, config_model)
    for category, (implementation_enum, _, mapping, _) in ADVANCED_SOURCES.items()
    for implementation in implementation_enum
    for component_type, config_model in mapping.get(implementation, {}).items()
]

GENERIC_ADVANCED_CASES = [
    (category, implementation.value, component_type.value, generic_model)
    for category, (implementation_enum, component_enum, mapping, generic_model) in ADVANCED_SOURCES.items()
    for implementation in implementation_enum
    for component_type in component_enum
    if component_type not in mapping.get(implementation, {})
]


def _enum_values(enum_class: type[Enum]) -> list[Any]:
    return [member.value for member in enum_class]


def _collection_values(values: Any) -> list[Any]:
    result = [member.value for member in values]
    return sorted(result) if isinstance(values, (set, frozenset)) else result


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


def _union_members(alias: Any) -> tuple[Any, ...]:
    annotation = getattr(alias, "__value__", alias)
    if get_origin(annotation) is Annotated:
        annotation = get_args(annotation)[0]
    return get_args(annotation)


def test_schema_endpoints_return_source_model_validation_schemas(client: TestClient) -> None:
    metamodel_response = client.get("/api/schema/metamodel")
    deployment_response = client.get("/api/schema/deployment-model")

    assert metamodel_response.status_code == 200
    assert deployment_response.status_code == 200
    assert metamodel_response.json() == MetaModel.model_json_schema(mode="validation")
    assert deployment_response.json() == DeploymentModel.model_json_schema(mode="validation")


def test_options_versions_come_from_installed_packages(client: TestClient) -> None:
    versions = client.get("/api/options").json()["versions"]

    assert versions == {package: version(package) for package in ("orchestrator", "metamodel")}


def test_network_options_match_source_enums_mappings_and_defaults(client: TestClient) -> None:
    response = client.get("/api/options")

    assert response.status_code == 200
    catalog = response.json()
    metamodel_defaults = MetaModel()
    for category, sources in NETWORK_SOURCES.items():
        implementation_enum, deployment_model, component_enum, supported, advanced, images, privileges = sources
        actual = catalog[category]
        assert actual["implementations"] == _enum_values(implementation_enum)
        assert actual["default_implementation"] == deployment_model.model_fields["implementation"].default.value
        assert actual["component_types"] == _enum_values(component_enum)
        assert actual["supported_components"] == {
            implementation.value: _collection_values(supported.get(implementation, ()))
            for implementation in implementation_enum
        }
        assert actual["advanced_config"] == {
            implementation.value: {
                component_type.value: config_model.__name__
                for component_type, config_model in advanced.get(implementation, {}).items()
            }
            for implementation in implementation_enum
        }
        assert actual["default_images"] == _jsonable(images)
        assert actual["pod_privileges"] == _jsonable(privileges)
        assert actual["default_components"] == {
            name: {"type": component.type.value}
            for name, component in getattr(metamodel_defaults, category).components.items()
        }

    assert catalog["core"]["default_database_images"] == _jsonable(DEFAULT_CORE_DATABASE_IMAGES)


def test_ue_options_match_source_models_and_defaults(client: TestClient) -> None:
    actual = client.get("/api/options").json()["ue"]

    assert actual["types"] == _enum_values(UEType)
    assert actual["implementations"] == _enum_values(UEImplementation)
    assert actual["default_implementation"] == DeployedUE.model_fields["implementation"].default.value
    assert actual["advanced_config"] == {
        implementation.value: {
            ue_type.value: config_model.__name__
            for ue_type, config_model in ADVANCED_UE_CONFIG_MAPPING.get(implementation, {}).items()
        }
        for implementation in UEImplementation
    }
    assert actual["default_images"] == _jsonable(DEFAULT_UE_IMAGES)
    assert actual["pod_privileges"] == _jsonable(UE_POD_PRIVILEGES)
    assert actual["default_components"] == {
        name: {"type": component.type.value}
        for name, component in MetaModel().ues.items()
    }


def test_ru_options_match_catalogs(client: TestClient) -> None:
    actual = client.get("/api/options").json()["ru"]

    assert actual["types"] == _enum_values(RUType)
    for ru_type in RUType:
        if ru_type not in CATALOGS:
            assert actual["models"][ru_type.value] == []
            assert actual["capabilities"][ru_type.value] == {}
            continue
        model_enum, capabilities = CATALOGS[ru_type]
        assert actual["models"][ru_type.value] == _enum_values(model_enum)
        assert actual["capabilities"][ru_type.value] == {
            model.value: value.model_dump(mode="json") for model, value in capabilities.items()
        }

    assert actual["default_components"] == {
        name: {
            "type": component.type.value,
            "model": component.model.value if component.model is not None else None,
        }
        for name, component in MetaModel().rus.items()
    }


def test_provisioner_options_match_union_models(client: TestClient) -> None:
    actual = client.get("/api/options").json()["provisioners"]
    expected_categories = {member.value: [] for member in ProvisioningType}
    for provisioner_model in _union_members(Provisioner):
        provisioner_type = get_args(provisioner_model.model_fields["type"].annotation)[0]
        categories = provisioner_model.model_fields["supported_categories"].get_default(
            call_default_factory=True,
        )
        expected_categories[provisioner_type.value] = _collection_values(categories)

    assert actual["types"] == _enum_values(ProvisioningType)
    assert actual["supported_categories"] == expected_categories
    assert actual["default_instances"] == {
        name: {
            "type": provisioner.type.value,
            "supported_categories": _collection_values(provisioner.supported_categories),
        }
        for name, provisioner in DeploymentModel().provisioners.items()
    }


def test_node_roles_match_union_enum_members(client: TestClient) -> None:
    expected = list(
        dict.fromkeys(member.value for enum_class in _union_members(NodeRole) for member in enum_class),
    )

    assert client.get("/api/options").json()["node_roles"] == expected


def test_provider_catalog_uses_source_model_values(client: TestClient) -> None:
    response = client.get("/api/provider-catalogs")

    assert response.status_code == 200
    catalog = response.json()
    assert catalog["r2lab"]["required_sophianodes"] == [
        "sopnode-f1",
        "sopnode-f2",
        "sopnode-f3",
        "sopnode-w3",
    ]
    for radio_unit in catalog["r2lab"]["radio_units"]:
        ru_type = RUType(radio_unit["type"])
        model_enum, _ = CATALOGS[ru_type]
        assert model_enum(radio_unit["model"]).value == radio_unit["model"]
    for ue in catalog["r2lab"]["user_equipment"]:
        validated = UE.model_validate({"type": UEType.COTS, "config": {"supi": ue["imsi"]}})
        assert validated.config.supi == ue["imsi"]


def test_provider_catalog_provisioner_metadata_matches_models(client: TestClient) -> None:
    actual = client.get("/api/provider-catalogs").json()["provisioner_models"]

    assert actual["bi"] == {
        "type": ProvisioningType.BI.value,
        "params_defaults": BIParams().model_dump(mode="json"),
        "params_schema": BIParams.model_json_schema(mode="validation"),
        "provisioner_schema": BIProvisioner.model_json_schema(mode="validation"),
    }
    assert actual["r2lab"] == {
        "type": ProvisioningType.R2LAB.value,
        "params_schema": R2LabParams.model_json_schema(mode="validation"),
        "provisioner_schema": R2LabProvisioner.model_json_schema(mode="validation"),
    }


@pytest.mark.parametrize(
    ("category", "implementation", "component_type", "config_model"),
    MAPPED_ADVANCED_CASES,
)
def test_mapped_advanced_config_endpoints_return_source_schema(
    client: TestClient,
    category: str,
    implementation: str,
    component_type: str,
    config_model: type[BaseModel],
) -> None:
    response = client.get(
        f"/api/options/advanced-config/{category}/{implementation}/{component_type}",
    )

    assert response.status_code == 200
    assert response.json() == config_model.model_json_schema(mode="validation")


@pytest.mark.parametrize(
    ("category", "implementation", "component_type", "generic_model"),
    GENERIC_ADVANCED_CASES,
)
def test_unmapped_valid_combinations_use_strict_generic_schema(
    client: TestClient,
    category: str,
    implementation: str,
    component_type: str,
    generic_model: type[BaseModel],
) -> None:
    response = client.get(
        f"/api/options/advanced-config/{category}/{implementation}/{component_type}",
    )

    assert response.status_code == 200
    assert response.json() == generic_model.model_json_schema(mode="validation")
    assert response.json().get("additionalProperties") is False


@pytest.mark.parametrize(
    "path",
    [
        "/api/options/advanced-config/unknown/oai/amf",
        "/api/options/advanced-config/core/unknown/amf",
        "/api/options/advanced-config/core/oai/unknown",
    ],
)
def test_unknown_advanced_config_combination_returns_not_found(
    client: TestClient,
    path: str,
) -> None:
    response = client.get(path)

    assert response.status_code == 404
    assert response.json()["error"]["kind"] == "not_found"
    assert response.json()["error"]["stage"] == "input"
    assert response.json()["error"]["exception"] == "OptionsNotFoundError"
