"""Deployment actions through the real orchestrator managers with Ansible stubbed out.

Only `orchestrator.utils.ansible.run_ansible_playbook` is replaced. Managers, reconciliation,
dependency ordering, state mutation and error propagation are the real orchestrator code.
"""

import asyncio
import itertools
import json
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
import orchestrator.utils.ansible as orchestrator_ansible
import pytest
import yaml
from fastapi.testclient import TestClient

from app.main import create_app
from app.providers.r2lab import R2LabService
from app.settings import Settings

JOIN = "kubeadm join 10.0.0.1:6443 --token abcdef.0123456789abcdef --discovery-token-ca-cert-hash sha256:feedbeef"
R2LAB_PASSWORD = "s3cret-r2lab-pass"


class FakeAnsible:
    """Stand-in for ansible-runner: records roles, writes stdout artefacts, returns role outputs."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.fail_roles: set[str] = set()
        self.fail_paths: set[str] = set()  # fail runs whose runner path contains one of these
        self.delay = 0.0
        self._ips = itertools.count(10)

    async def __call__(
        self,
        playbook,
        runner_path,
        inputs=None,
        output_keys=None,
        roles_paths=None,
        inventory=None,
        quiet=False,
    ):
        role = (
            playbook[0]["roles"][0]["role"]
            if isinstance(playbook, list) and playbook[0].get("roles")
            else "tasks"
        )
        hosts = playbook[0].get("hosts", "localhost") if isinstance(playbook, list) else "localhost"
        self.calls.append((role, str(runner_path)))
        if self.delay:
            await asyncio.sleep(self.delay)

        run_dir = Path(runner_path) / datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%S.%fZ")
        stdout = run_dir / "artifacts" / "fake" / "stdout"
        stdout.parent.mkdir(parents=True, exist_ok=True)
        failed = role in self.fail_roles or any(part in str(runner_path) for part in self.fail_paths)
        secret_echo = (inputs or {}).get("reservation_params") or (inputs or {}).get("token_params") or {}
        stdout.write_text(
            f"PLAY [{hosts}] ****\nTASK [{role}] ****\n"
            + (f'fatal: [{hosts}]: FAILED! => {{"msg": "stubbed failure of {role}"}}\n' if failed else "ok\n")
            + (f"debug: {json.dumps(secret_echo)}\n" if secret_echo else "")
            + (f"debug: {JOIN}\n" if role == "k8s/create" else ""),
            encoding="utf-8",
        )
        if failed:
            raise RuntimeError(f"Playbook run not successful (status: 'failed', return code: 2) for {role}")

        outputs = {
            "join_command": JOIN,
            "network_info": f"10.244.0.{next(self._ips)}",
            "ssh_info": {"hostname": f"10.123.0.{next(self._ips)}", "user": "ubuntu"},
            "ru_ips": ["192.168.236.101"],
            "command_output": "",
        }
        return {key: outputs[key] for key in output_keys} if output_keys else None


@pytest.fixture
def fake_ansible(monkeypatch) -> FakeAnsible:
    fake = FakeAnsible()
    monkeypatch.setattr(orchestrator_ansible, "run_ansible_playbook", fake)
    return fake


def r2lab_transport(lease_slice: str | None = "my_slice") -> httpx.MockTransport:
    """R2Lab API / device manager responses shaped like their published OpenAPI schemas."""
    future = 4102444800  # 2100-01-01, JWT exp

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/auth/login":
            body = json.loads(request.content)
            if body["password"] != R2LAB_PASSWORD:
                return httpx.Response(401, json={"detail": "Invalid credentials"})
            import base64

            payload = base64.urlsafe_b64encode(json.dumps({"exp": future}).encode()).decode().rstrip("=")
            return httpx.Response(
                200, json={"access_token": f"eyJhbGciOiJIUzI1NiJ9.{payload}.sig", "token_type": "bearer"}
            )
        if path.startswith("/slices/by-name/"):
            return httpx.Response(200, json={"id": 89, "name": path.rsplit("/", 1)[-1]})
        if path == "/leases/current":
            if lease_slice is None:
                return httpx.Response(200, json=None)
            return httpx.Response(
                200,
                json={
                    "id": 1,
                    "resource_id": 1,
                    "slice_id": 89,
                    "slice_name": lease_slice,
                    "t_from": "2026-10-23T10:00:00Z",
                    "t_until": "2026-10-23T23:00:00Z",
                    "created_at": "2026-10-23T09:00:00Z",
                },
            )
        if path == "/leases":
            return httpx.Response(200, json=[])
        if path.endswith("/resource/list"):
            return httpx.Response(
                200,
                json=[
                    {"name": "jaguar", "infrastructure": "r2lab", "misc": {"ips": ["192.168.236.101"]}},
                    {"name": "qhat01", "infrastructure": "r2lab", "misc": None},
                ],
            )
        return httpx.Response(404, json={"detail": "Not Found"})

    return httpx.MockTransport(handler)


@pytest.fixture
def app_client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, slices_bin_dir=tmp_path / "no-slices-cli"))
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield app, test_client


def create(client: TestClient, metamodel, deployment_model, name="dry-run") -> str:
    response = client.post(
        "/api/deployments", json={"name": name, "metamodel": metamodel, "deployment_model": deployment_model}
    )
    assert response.status_code == 201, response.json()
    return response.json()["deployment"]["id"]


def wait_job(client: TestClient, deployment_id: str, job_id: str, timeout: float = 30) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f"/api/deployments/{deployment_id}/jobs/{job_id}").json()
        if job["status"] not in ("queued", "running"):
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def run(client: TestClient, deployment_id: str, **body) -> dict:
    response = client.post(f"/api/deployments/{deployment_id}/actions", json=body)
    assert response.status_code == 202, response.json()
    return wait_job(client, deployment_id, response.json()["id"])


def stage_map(client: TestClient, deployment_id: str) -> dict:
    overview = client.get(f"/api/deployments/{deployment_id}/runtime").json()
    return {stage["stage"]: stage for stage in overview["stages"]}


SIMULATED_META = {
    "ric": {"components": {}},
    "ran": {
        "components": {
            "gnb1": {"type": "gnb", "config": {"ru": "ru1"}},
            "gnb2": {"type": "gnb", "config": {"ru": "ru1", "gnbId": 2, "nrCellId": 2}},
        }
    },
    "rus": {"ru1": {"type": "simulated"}},
    "ues": {
        "ue1": {"config": {"gnbs": ["gnb1"], "ru": "ru1"}},
        "ue2": {"config": {"gnbs": ["gnb2"], "ru": "ru1", "supi": "001010000000101"}},
    },
}
SIMULATED_DEPLOYMENT = {
    "nodes": {
        "node-a": {
            "is_provisioned": True,
            "provisioner": None,
            "ssh_info": {"hostname": "10.0.0.1"},
            "roles": [
                "core",
                "amf",
                "ausf",
                "bsf",
                "nrf",
                "nssf",
                "pcf",
                "scp",
                "smf",
                "udm",
                "udr",
                "upf",
                "ran",
            ],
        },
        "node-b": {
            "is_provisioned": True,
            "provisioner": None,
            "ssh_info": {"hostname": "10.0.0.2"},
            "roles": ["ran", "ue"],
        },
    },
    "ran": {
        "implementation": "oai",
        "components": {
            "gnb1": {"type": "gnb", "node_name": "node-a"},
            "gnb2": {"type": "gnb", "node_name": "node-b"},
        },
    },
    "ues": {
        "ue1": {"type": "containerized", "implementation": "oai", "node_name": "node-b"},
        "ue2": {"type": "containerized", "implementation": "oai", "node_name": "node-b"},
    },
}


def test_simulated_deployment_end_to_end(app_client, fake_ansible):
    _, client = app_client
    deployment_id = create(client, SIMULATED_META, SIMULATED_DEPLOYMENT)

    stages = stage_map(client, deployment_id)
    assert [s for s, v in stages.items() if v["applicable"]] == ["kubernetes", "core", "ran", "ue"]
    assert stages["infrastructure"]["status"] == "skipped"
    assert stages["ric"]["status"] == "skipped"
    assert stages["radio"]["status"] == "skipped"
    assert stages["ran"]["can_deploy"] is False  # Core first

    job = run(client, deployment_id, action="deploy")
    assert job["status"] == "succeeded", job["error"]
    assert [r["stage"] for r in job["stages"]] == ["kubernetes", "core", "ran", "ue"]

    stages = stage_map(client, deployment_id)
    assert {s: v["status"] for s, v in stages.items() if v["applicable"]} == {
        "kubernetes": "succeeded",
        "core": "succeeded",
        "ran": "succeeded",
        "ue": "succeeded",
    }

    roles = [role for role, _ in fake_ansible.calls]
    assert roles.index("k8s/create") < roles.index("helm/install")
    assert "database/subscriber/add/open5gs" in roles

    # runtime state persisted, with per-deployment artefacts and per-stage snapshots
    state = client.get(f"/api/deployments/{deployment_id}/state").json()
    assert state["has_state"] is True
    deployment_model = state["deployment_model"]
    assert deployment_model["params"]["k8s"]["join_command"] == "********"
    assert deployment_model["ran"]["components"]["gnb2"]["is_installed"] is True
    assert deployment_model["ran"]["components"]["gnb2"]["node_name"] == "node-b"
    assert all(ue["is_installed"] for ue in deployment_model["ues"].values())
    assert all(
        runner_path.startswith(str(Path(app_client[0].state.settings.data_dir)))
        for _, runner_path in fake_ansible.calls
    )

    # logs are the job's ansible stdout, with secrets masked
    logs = client.get(f"/api/deployments/{deployment_id}/jobs/{job['id']}/logs").json()
    assert "k8s/create" in logs["text"]
    assert "abcdef.0123456789abcdef" not in logs["text"]

    # the input can no longer be replaced once runtime state exists
    response = client.put(
        f"/api/deployments/{deployment_id}",
        json={"name": "x", "metamodel": SIMULATED_META, "deployment_model": SIMULATED_DEPLOYMENT},
    )
    assert response.status_code == 409
    assert response.json()["error"]["kind"] == "conflict"

    # removal in reverse order, using the orchestrator's remove actions
    response = client.post(
        f"/api/deployments/{deployment_id}/actions", json={"action": "remove", "stages": ["core"]}
    )
    assert response.status_code == 409  # RAN and UE are still installed
    job = run(client, deployment_id, action="remove", stages=["ue", "ran"])
    assert job["status"] == "succeeded", job["error"]
    assert [r["stage"] for r in job["stages"]] == ["ue", "ran"]
    stages = stage_map(client, deployment_id)
    assert stages["ran"]["status"] == "pending" and stages["ran"]["done"] == 0
    assert stages["core"]["status"] == "succeeded"


def test_failed_stage_keeps_partial_state_and_retries(app_client, fake_ansible):
    _, client = app_client
    deployment_id = create(client, SIMULATED_META, SIMULATED_DEPLOYMENT)
    fake_ansible.fail_paths = {"/core/amf/helm/install"}

    job = run(client, deployment_id, action="deploy", stages=["kubernetes", "core"])
    assert job["status"] == "failed"
    failed = job["stages"][1]
    assert failed["stage"] == "core" and failed["status"] == "failed"
    assert failed["error"]["kind"] == "component_failure"
    assert "amf" in failed["error"]["message"]
    assert any("stubbed failure of helm/install" in d["msg"] for d in failed["error"]["details"])

    stages = stage_map(client, deployment_id)
    assert stages["kubernetes"]["status"] == "succeeded"
    assert stages["core"]["status"] == "failed", stages["core"]
    assert stages["core"]["can_retry"] is True, stages["kubernetes"]
    # the database was installed before the failing NF install: kept in the saved state
    state = client.get(f"/api/deployments/{deployment_id}/state").json()
    assert state["deployment_model"]["core"]["database_params"]["is_installed"] is True

    fake_ansible.fail_paths = set()
    job = run(client, deployment_id, action="deploy", stages=["core"])
    assert job["status"] == "succeeded", job["error"]
    assert stage_map(client, deployment_id)["core"]["status"] == "succeeded"


def test_one_action_at_a_time(app_client, fake_ansible):
    _, client = app_client
    deployment_id = create(client, SIMULATED_META, SIMULATED_DEPLOYMENT)
    fake_ansible.delay = 0.2
    first = client.post(
        f"/api/deployments/{deployment_id}/actions", json={"action": "deploy", "stages": ["kubernetes"]}
    )
    assert first.status_code == 202
    second = client.post(
        f"/api/deployments/{deployment_id}/actions", json={"action": "deploy", "stages": ["kubernetes"]}
    )
    assert second.status_code == 409
    assert second.json()["error"]["kind"] == "conflict"
    assert stage_map(client, deployment_id)["kubernetes"]["status"] == "running"
    assert wait_job(client, deployment_id, first.json()["id"])["status"] == "succeeded"


def test_bi_nodes_require_slices_authentication(app_client, fake_ansible):
    _, client = app_client
    deployment_model = {
        "provisioners": {"bi": {"type": "bi", "params": {"experiment": "web_test"}}},
        "nodes": {"vm1": {"provisioner": "bi", "is_provisioned": False, "roles": ["core", "ran", "ue"]}},
    }
    deployment_id = create(
        client, {"ues": {}, "ran": {"components": {}}, "ric": {"components": {}}}, deployment_model
    )
    stage = stage_map(client, deployment_id)["infrastructure"]
    assert stage["applicable"] and stage["can_deploy"] is False
    assert stage["requirements"][0]["provider"] == "slices" and stage["requirements"][0]["satisfied"] is False

    response = client.post(f"/api/deployments/{deployment_id}/actions", json={"action": "deploy"})
    assert response.status_code == 409
    error = response.json()["error"]
    assert error["kind"] == "authentication_required" and error["provider"] == "slices"
    assert fake_ansible.calls == []

    status = client.get("/api/providers/slices/auth").json()
    assert status["state"] == "cli_missing"


def test_r2lab_radio_flow(app_client, fake_ansible):
    app, client = app_client
    app.state.r2lab._transport = r2lab_transport()
    metamodel = {
        "ric": {"components": {}},
        "rus": {"jaguar": {"type": "aw2s", "model": "jaguar"}},
        "ran": {"components": {"gnb1": {"type": "gnb", "config": {"ru": "jaguar"}}}},
        "ues": {"qhat01": {"type": "cots", "config": {"gnbs": ["gnb1"], "supi": "001010000000006"}}},
    }
    deployment_model = {
        "nodes": {
            "sopnode-f1": {
                "is_provisioned": True,
                "provisioner": None,
                "ssh_info": {"hostname": "sopnode-f1"},
                "roles": ["core", "ran"],
            }
        },
        "rus": {"jaguar": {"provisioner": "r2lab", "is_provisioned": False}},
        "ues": {"qhat01": {"type": "cots", "provisioner": "r2lab", "is_provisioned": False}},
        "ran": {
            "implementation": "oai",
            "components": {
                "gnb1": {
                    "type": "gnb",
                    "image": {"repository": "docker.io/oaisoftwarealliance/oai-gnb", "image_tag": "develop"},
                }
            },
        },
    }
    deployment_id = create(client, metamodel, deployment_model)
    assert run(client, deployment_id, action="deploy", stages=["kubernetes", "core"])["status"] == "succeeded"

    radio = stage_map(client, deployment_id)["radio"]
    assert [r["kind"] for r in radio["requirements"]] == ["authentication", "reservation"]
    response = client.post(
        f"/api/deployments/{deployment_id}/actions", json={"action": "deploy", "stages": ["radio"]}
    )
    assert response.status_code == 409
    assert response.json()["error"]["kind"] == "authentication_required"
    assert response.json()["error"]["provider"] == "r2lab"

    bad = client.post(
        "/api/providers/r2lab/session", json={"email": "me@x.org", "password": "nope", "slice": "my_slice"}
    )
    assert bad.status_code == 401
    session = client.post(
        "/api/providers/r2lab/session",
        json={"email": "me@x.org", "password": R2LAB_PASSWORD, "slice": "my_slice"},
    ).json()
    assert session["state"] == "authenticated" and "password" not in session
    assert client.get("/api/providers/r2lab/reservation").json()["state"] == "reserved_by_you"
    devices = client.get("/api/providers/r2lab/devices", params={"names": ["jaguar", "phone1"]}).json()
    assert [(d["name"], d["known"]) for d in devices["requested"]] == [("jaguar", True), ("phone1", False)]

    job = run(client, deployment_id, action="deploy")
    assert job["status"] == "succeeded", job["error"]
    assert [r["stage"] for r in job["stages"]] == ["radio", "ran", "ue"]
    roles = [role for role, _ in fake_ansible.calls]
    assert "provisioning/r2lab/provision" in roles and "provisioning/r2lab/ue/connect" in roles

    state = client.get(f"/api/deployments/{deployment_id}/state").json()["deployment_model"]
    assert state["rus"]["jaguar"]["ips"] == ["192.168.236.101"]
    assert state["ues"]["qhat01"]["is_connected"] is True
    assert "r2lab" not in state["provisioners"]  # injected only while the action ran

    # credentials never reach the saved state, and are masked in logs
    directory = Path(app.state.settings.data_dir) / "deployments" / deployment_id
    for path in (directory / "state").glob("*.yaml"):
        assert R2LAB_PASSWORD not in path.read_text()
        assert "r2lab" not in (yaml.safe_load(path.read_text()) or {}).get("provisioners", {})
    logs = client.get(f"/api/deployments/{deployment_id}/jobs/{job['id']}/logs").json()["text"]
    assert "provisioning/r2lab/provision" in logs
    assert R2LAB_PASSWORD not in logs


def test_r2lab_lease_held_by_another_slice_blocks_radio(app_client, fake_ansible):
    app, client = app_client
    app.state.r2lab._transport = r2lab_transport(lease_slice="someone_else")
    client.post(
        "/api/providers/r2lab/session",
        json={"email": "me@x.org", "password": R2LAB_PASSWORD, "slice": "my_slice"},
    )
    metamodel = {
        "rus": {"jaguar": {"type": "aw2s", "model": "jaguar"}},
        "ran": {"components": {}},
        "ues": {},
        "ric": {"components": {}},
    }
    deployment_model = {
        "nodes": {"n1": {"is_provisioned": True, "provisioner": None, "roles": ["core"]}},
        "rus": {"jaguar": {"provisioner": "r2lab", "is_provisioned": False}},
    }
    deployment_id = create(client, metamodel, deployment_model)
    radio = stage_map(client, deployment_id)["radio"]
    reservation = next(r for r in radio["requirements"] if r["kind"] == "reservation")
    assert reservation["satisfied"] is False and "someone_else" in reservation["message"]
    assert radio["can_reserve"] is True
    assert isinstance(app.state.r2lab, R2LabService)
