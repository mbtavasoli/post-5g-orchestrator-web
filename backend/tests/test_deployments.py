"""Tests for all backend v1 endpoints and their shared error contract."""

import json
from importlib.metadata import version
from pathlib import Path

from fastapi.testclient import TestClient


def _deployment_id(response) -> str:
    return response.json()["deployment"]["id"]


def _example_files() -> tuple[str, str]:
    orchestrator = Path(__file__).resolve().parents[2].parent / "orchestrator"
    example = orchestrator / "examples" / "default"
    return (
        (example / "output_metamodel.yaml").read_text(encoding="utf-8"),
        (example / "output_deployment_model.yaml").read_text(encoding="utf-8"),
    )


def test_health_reports_installed_versions(client: TestClient) -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "versions": {package: version(package) for package in ("orchestrator", "metamodel", "pydantic")},
    }


def test_create_defaults_persists_sparse_models(client: TestClient, tmp_path) -> None:
    response = client.post(
        "/api/deployments",
        json={"name": "simple-scenario", "metamodel": None, "deployment_model": None},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["deployment"]["name"] == "simple-scenario"
    assert "orchestrator" not in body["deployment"]
    assert body["metamodel"]["core"]["components"]
    assert body["deployment_model"]["nodes"]

    directory = tmp_path / "deployments" / body["deployment"]["id"]
    assert (directory / "metamodel.yaml").read_text(encoding="utf-8") == "{}\n"
    assert (directory / "deployment_model.yaml").exists()
    stored_metadata = json.loads((directory / "deployment.json").read_text(encoding="utf-8"))
    assert stored_metadata["orchestrator"] == version("orchestrator")
    assert stored_metadata["metamodel"] == version("metamodel")


def test_create_accepts_yaml_strings(client: TestClient) -> None:
    response = client.post(
        "/api/deployments",
        json={"name": "yaml-input", "metamodel": "{}\n", "deployment_model": "{}\n"},
    )

    assert response.status_code == 201
    assert response.json()["metamodel"]["ran"]["components"]["gnb"]["type"] == "gnb"


def test_list_and_get_deployments(client: TestClient, create_default) -> None:
    first = create_default("first")
    second = create_default("second")

    listed = client.get("/api/deployments")

    assert listed.status_code == 200
    assert [item["name"] for item in listed.json()] == ["first", "second"]
    assert all(set(item) == {"id", "name", "created_at", "updated_at"} for item in listed.json())

    loaded = client.get(f"/api/deployments/{_deployment_id(first)}")
    assert loaded.status_code == 200
    assert loaded.json()["deployment"]["name"] == "first"
    assert loaded.json()["metamodel"] == first.json()["metamodel"]
    assert _deployment_id(second) != _deployment_id(first)


def test_replace_updates_both_models_and_preserves_creation_time(client: TestClient, create_default) -> None:
    created = create_default()
    deployment_id = _deployment_id(created)
    replacement_metamodel = created.json()["metamodel"]
    replacement_metamodel["ran"]["components"] = {}

    replaced = client.put(
        f"/api/deployments/{deployment_id}",
        json={
            "name": "renamed",
            "metamodel": replacement_metamodel,
            "deployment_model": {},
        },
    )

    assert replaced.status_code == 200
    body = replaced.json()
    assert body["deployment"]["name"] == "renamed"
    assert body["deployment"]["created_at"] == created.json()["deployment"]["created_at"]
    assert body["deployment"]["updated_at"] >= created.json()["deployment"]["updated_at"]
    assert body["metamodel"]["ran"]["components"] == {}

    loaded = client.get(f"/api/deployments/{deployment_id}")
    assert loaded.json() == body


def test_unknown_deployment_uses_error_envelope(client: TestClient) -> None:
    response = client.get("/api/deployments/00000000-0000-0000-0000-000000000000")

    assert response.status_code == 404
    assert response.json()["error"] == {
        "kind": "not_found",
        "stage": "input",
        "exception": "DeploymentNotFoundError",
        "message": "Deployment '00000000-0000-0000-0000-000000000000' was not found.",
        "details": None,
    }


def test_model_validation_error_is_prefixed_and_does_not_echo_input(client: TestClient) -> None:
    response = client.post(
        "/api/deployments",
        json={
            "name": "invalid",
            "metamodel": {"not_a_field": "SUPERSECRET"},
            "deployment_model": None,
        },
    )

    assert response.status_code == 422
    body = response.json()["error"]
    assert body["kind"] == "validation"
    assert body["stage"] == "input"
    assert body["exception"] == "ValidationError"
    assert body["details"][0]["loc"][:1] == ["metamodel"]
    assert "input" not in body["details"][0]
    assert "SUPERSECRET" not in response.text


def test_bad_yaml_uses_validation_error_envelope(client: TestClient) -> None:
    response = client.post(
        "/api/deployments",
        json={"name": "invalid-yaml", "metamodel": "core: [", "deployment_model": None},
    )

    assert response.status_code == 422
    assert response.json()["error"]["kind"] == "validation"
    assert response.json()["error"]["stage"] == "input"


def test_fastapi_request_validation_uses_shared_envelope(client: TestClient) -> None:
    response = client.post("/api/deployments", json={"name": "missing", "metamodel": []})

    assert response.status_code == 422
    assert set(response.json()) == {"error"}
    assert response.json()["error"]["kind"] == "validation"


def test_reconcile_defaults_through_ric_without_saving_result(
    client: TestClient,
    create_default,
    tmp_path,
) -> None:
    created = create_default()
    deployment_id = _deployment_id(created)
    stored_path = tmp_path / "deployments" / deployment_id / "deployment_model.yaml"
    original = stored_path.read_text(encoding="utf-8")

    response = client.post(f"/api/deployments/{deployment_id}/reconcile")

    assert response.status_code == 200
    body = response.json()
    assert body["until"] == "ric"
    assert body["stages"] == ["core", "ric"]
    assert body["deployment_model"]["core"]["components"]["amf"]["image"]
    assert stored_path.read_text(encoding="utf-8") == original


def test_sync_reconciliation_only_synchronizes_component_keys(client: TestClient, create_default) -> None:
    created = create_default()
    deployment_id = _deployment_id(created)

    response = client.post(f"/api/deployments/{deployment_id}/reconcile?until=sync")

    assert response.status_code == 200
    assert response.json()["stages"] == ["sync"]
    assert set(response.json()["deployment_model"]["core"]["components"]) == set(
        created.json()["metamodel"]["core"]["components"],
    )


def test_reconcile_defaults_through_ran_reports_state_error(client: TestClient, create_default) -> None:
    deployment_id = _deployment_id(create_default())

    response = client.post(f"/api/deployments/{deployment_id}/reconcile?until=ran")

    assert response.status_code == 409
    body = response.json()["error"]
    assert body["kind"] == "state"
    assert body["stage"] == "ran"
    assert body["exception"] == "InvalidResourceStateError"


def test_reconcile_rejects_component_unsupported_by_implementation(client: TestClient) -> None:
    created = client.post(
        "/api/deployments",
        json={
            "name": "unsupported",
            "metamodel": {"ran": {"components": {"du": {"type": "du"}}}},
            "deployment_model": {"ran": {"implementation": "ueransim"}},
        },
    )
    assert created.status_code == 201

    response = client.post(f"/api/deployments/{_deployment_id(created)}/reconcile?until=sync")

    assert response.status_code == 422
    body = response.json()["error"]
    assert body["kind"] == "validation"
    assert body["stage"] == "sync"
    assert body["details"][0]["loc"][0] == "deployment_model"


def test_deployed_example_reconciles_through_ue(client: TestClient) -> None:
    metamodel_yaml, deployment_yaml = _example_files()
    created = client.post(
        "/api/deployments",
        json={
            "name": "deployed-example",
            "metamodel": metamodel_yaml,
            "deployment_model": deployment_yaml,
        },
    )
    assert created.status_code == 201

    response = client.post(f"/api/deployments/{_deployment_id(created)}/reconcile?until=ue")

    assert response.status_code == 200
    assert response.json()["stages"] == ["core", "ric", "ran", "ue"]


def test_unknown_gnb_reference_reports_reference_error(client: TestClient) -> None:
    metamodel_yaml, deployment_yaml = _example_files()
    created = client.post(
        "/api/deployments",
        json={
            "name": "unknown-reference",
            "metamodel": metamodel_yaml,
            "deployment_model": deployment_yaml,
        },
    )
    deployment_id = _deployment_id(created)
    models = created.json()
    models["metamodel"]["ues"]["sim_ue"]["config"]["gnbs"] = ["missing-gnb"]
    replaced = client.put(
        f"/api/deployments/{deployment_id}",
        json={
            "name": "unknown-reference",
            "metamodel": models["metamodel"],
            "deployment_model": models["deployment_model"],
        },
    )
    assert replaced.status_code == 200

    response = client.post(f"/api/deployments/{deployment_id}/reconcile?until=ue")

    assert response.status_code == 422
    body = response.json()["error"]
    assert body["kind"] == "reference"
    # Core reconciliation resolves UE gNB references for subscriber registration.
    assert body["stage"] == "core"
    assert body["exception"] == "ReferenceNotFoundError"


def test_invalid_reconcile_stage_uses_shared_envelope(client: TestClient, create_default) -> None:
    deployment_id = _deployment_id(create_default())

    response = client.post(f"/api/deployments/{deployment_id}/reconcile?until=invalid")

    assert response.status_code == 422
    assert response.json()["error"]["kind"] == "validation"
    assert response.json()["error"]["stage"] == "input"


def test_openapi_documents_shared_error_envelope(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()

    responses = schema["paths"]["/api/deployments/{deployment_id}/reconcile"]["post"]["responses"]
    for status_code in ("404", "409", "422", "500"):
        response_schema = responses[status_code]["content"]["application/json"]["schema"]
        assert response_schema["$ref"] == "#/components/schemas/ErrorResponse"
