"""File-based storage for deployment model pairs."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

from app import orchestrator_bridge as bridge
from app.schemas import DeploymentMetadata, JobRecord, StoredDeploymentMetadata


class DeploymentNotFoundError(Exception):
    """Raised when a deployment identifier is unknown."""

    def __init__(self, deployment_id: str) -> None:
        self.deployment_id = deployment_id
        super().__init__(f"Deployment {deployment_id!r} was not found.")


class DeploymentStore:
    """Persist each deployment as metadata plus two sparse YAML files."""

    def __init__(self, data_dir: Path) -> None:
        self.deployments_dir = data_dir / "deployments"
        self.deployments_dir.mkdir(parents=True, exist_ok=True)

    def create(
        self,
        name: str,
        metamodel: bridge.MetaModel,
        deployment_model: bridge.DeploymentModel,
    ) -> StoredDeploymentMetadata:
        """Atomically create a deployment directory and its three files."""
        deployment_id = str(uuid4())
        now = datetime.now(UTC)
        installed_versions = bridge.versions()
        metadata = StoredDeploymentMetadata(
            id=deployment_id,
            name=name,
            created_at=now,
            updated_at=now,
            orchestrator=installed_versions["orchestrator"],
            metamodel=installed_versions["metamodel"],
        )
        target = self.deployments_dir / deployment_id
        temporary = Path(tempfile.mkdtemp(prefix=f".{deployment_id}-", dir=self.deployments_dir))
        try:
            self._write_models(temporary, metamodel, deployment_model)
            self._write_metadata(temporary, metadata)
            os.replace(temporary, target)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
        return metadata

    def list(self) -> list[StoredDeploymentMetadata]:
        """Return deployment metadata without loading model files."""
        deployments = [
            self._read_metadata(path)
            for path in self.deployments_dir.iterdir()
            if path.is_dir() and not path.name.startswith(".")
        ]
        return sorted(deployments, key=lambda item: item.created_at)

    def get(
        self,
        deployment_id: str,
    ) -> tuple[StoredDeploymentMetadata, bridge.MetaModel, bridge.DeploymentModel]:
        """Load metadata and models through their existing model helpers."""
        directory = self._deployment_dir(deployment_id)
        metadata = self._read_metadata(directory)
        metamodel = bridge.MetaModel.from_yaml_file(str(directory / "metamodel.yaml"))
        deployment_model = bridge.DeploymentModel.from_yaml_file(str(directory / "deployment_model.yaml"))
        return metadata, metamodel, deployment_model

    def replace(
        self,
        deployment_id: str,
        name: str,
        metamodel: bridge.MetaModel,
        deployment_model: bridge.DeploymentModel,
    ) -> StoredDeploymentMetadata:
        """Replace both stored input models and update metadata."""
        directory = self._deployment_dir(deployment_id)
        current = self._read_metadata(directory)
        updated = current.model_copy(
            update={"name": name, "updated_at": datetime.now(UTC)},
        )
        self._write_models(directory, metamodel, deployment_model)
        self._write_metadata(directory, updated)
        return updated

    def require(self, deployment_id: str) -> StoredDeploymentMetadata:
        """Return metadata, or raise before processing a replacement body."""
        return self._read_metadata(self._deployment_dir(deployment_id))

    # ---- runtime state (written only by deployment actions) ---------------------------
    #
    # <id>/state/metamodel.yaml, <id>/state/deployment_model.yaml   current state
    # <id>/state/metamodel.<stage>.yaml, ...deployment_model.<stage>.yaml   per-stage snapshot
    # <id>/jobs/<job_id>.json, <id>/ansible-runner/, <id>/kubeconfig/
    #
    # The input files are never overwritten by actions, and the state is never rebuilt from
    # the input once it exists, so runtime fields (is_installed, network_info, IPs, ...) persist.

    def runtime_dir(self, deployment_id: str) -> Path:
        """Return the deployment directory used for runtime files."""
        return self._deployment_dir(deployment_id)

    def has_state(self, deployment_id: str) -> bool:
        """Return whether a deployment action already produced runtime state."""
        return (self._deployment_dir(deployment_id) / "state" / "deployment_model.yaml").is_file()

    def load_state(
        self,
        deployment_id: str,
    ) -> tuple[bridge.MetaModel, bridge.DeploymentModel] | None:
        """Load the current runtime state, if any action has run."""
        state = self._deployment_dir(deployment_id) / "state"
        if not (state / "deployment_model.yaml").is_file():
            return None
        return (
            bridge.MetaModel.from_yaml_file(str(state / "metamodel.yaml")),
            bridge.DeploymentModel.from_yaml_file(str(state / "deployment_model.yaml")),
        )

    def save_state(
        self,
        deployment_id: str,
        metamodel: bridge.MetaModel,
        deployment_model: bridge.DeploymentModel,
        stage: str | None = None,
    ) -> None:
        """Atomically save the runtime state, plus a per-stage snapshot when given."""
        state = self._deployment_dir(deployment_id) / "state"
        state.mkdir(exist_ok=True)
        metamodel_yaml = metamodel.to_yaml(exclude_defaults=False)
        deployment_yaml = deployment_model.to_yaml(exclude_defaults=False)
        self._atomic_write(state / "metamodel.yaml", metamodel_yaml)
        self._atomic_write(state / "deployment_model.yaml", deployment_yaml)
        if stage:
            self._atomic_write(state / f"metamodel.{stage}.yaml", metamodel_yaml)
            self._atomic_write(state / f"deployment_model.{stage}.yaml", deployment_yaml)

    def save_job(self, job: JobRecord) -> None:
        """Persist a job record."""
        jobs = self._deployment_dir(job.deployment_id) / "jobs"
        jobs.mkdir(exist_ok=True)
        self._atomic_write(jobs / f"{job.id}.json", job.model_dump_json(indent=2) + "\n")

    def list_jobs(self, deployment_id: str) -> list[JobRecord]:
        """Return a deployment's jobs, oldest first."""
        jobs = self._deployment_dir(deployment_id) / "jobs"
        if not jobs.is_dir():
            return []
        records = [JobRecord.model_validate_json(path.read_text(encoding="utf-8")) for path in jobs.glob("*.json")]
        return sorted(records, key=lambda record: record.created_at)

    def get_job(self, deployment_id: str, job_id: str) -> JobRecord:
        """Return one job record."""
        try:
            canonical = str(UUID(job_id))
        except ValueError as exc:
            raise DeploymentNotFoundError(job_id) from exc
        path = self._deployment_dir(deployment_id) / "jobs" / f"{canonical}.json"
        if not path.is_file():
            raise DeploymentNotFoundError(job_id)
        return JobRecord.model_validate_json(path.read_text(encoding="utf-8"))

    def all_jobs(self) -> list[JobRecord]:
        """Return jobs across all deployments (used at startup)."""
        return [job for metadata in self.list() for job in self.list_jobs(metadata.id)]

    @staticmethod
    def public_metadata(metadata: StoredDeploymentMetadata) -> DeploymentMetadata:
        """Remove storage-only version fields from API metadata."""
        return DeploymentMetadata.model_validate(metadata.model_dump())

    def _deployment_dir(self, deployment_id: str) -> Path:
        try:
            canonical_id = str(UUID(deployment_id))
        except ValueError as exc:
            raise DeploymentNotFoundError(deployment_id) from exc
        directory = self.deployments_dir / canonical_id
        if not directory.is_dir():
            raise DeploymentNotFoundError(deployment_id)
        return directory

    @staticmethod
    def _read_metadata(directory: Path) -> StoredDeploymentMetadata:
        with (directory / "deployment.json").open(encoding="utf-8") as file:
            return StoredDeploymentMetadata.model_validate(json.load(file))

    def _write_models(
        self,
        directory: Path,
        metamodel: bridge.MetaModel,
        deployment_model: bridge.DeploymentModel,
    ) -> None:
        self._atomic_write(directory / "metamodel.yaml", metamodel.to_yaml())
        self._atomic_write(directory / "deployment_model.yaml", deployment_model.to_yaml())

    def _write_metadata(self, directory: Path, metadata: StoredDeploymentMetadata) -> None:
        content = json.dumps(metadata.model_dump(mode="json"), indent=2) + "\n"
        self._atomic_write(directory / "deployment.json", content)

    @staticmethod
    def _atomic_write(path: Path, content: str) -> None:
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as file:
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary_path, path)
        except Exception:
            temporary_path.unlink(missing_ok=True)
            raise
