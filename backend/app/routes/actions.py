"""Long-running deployment actions, job status and logs."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request, status

from app import orchestrator_bridge as bridge
from app.jobs import JobRunner
from app.redaction import redact_data
from app.schemas import ActionRequest, ErrorResponse, JobRecord, JsonObject
from app.store import DeploymentStore

router = APIRouter(
    prefix="/api/deployments/{deployment_id}",
    responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)


def get_runner(request: Request) -> JobRunner:
    return request.app.state.jobs


def get_store(request: Request) -> DeploymentStore:
    return request.app.state.store


RunnerDependency = Annotated[JobRunner, Depends(get_runner)]
StoreDependency = Annotated[DeploymentStore, Depends(get_store)]


@router.get("/runtime", response_model=JsonObject)
async def runtime(deployment_id: str, runner: RunnerDependency) -> JsonObject:
    """Stages that apply to this deployment, their status and provider requirements."""
    return await runner.overview(deployment_id)


@router.get("/state", response_model=JsonObject)
def state(deployment_id: str, store: StoreDependency) -> JsonObject:
    """Current runtime state (secrets masked); the stored input until an action has run."""
    loaded = store.load_state(deployment_id)
    if loaded is None:
        _, metamodel, deployment_model = store.get(deployment_id)
    else:
        metamodel, deployment_model = loaded
    return {
        "has_state": loaded is not None,
        "metamodel": redact_data(bridge.dump(metamodel)),
        "deployment_model": redact_data(bridge.dump(deployment_model)),
    }


@router.post("/actions", response_model=JobRecord, status_code=status.HTTP_202_ACCEPTED)
async def start_action(deployment_id: str, body: ActionRequest, runner: RunnerDependency) -> JobRecord:
    """Start a deploy/remove/reserve job and return immediately; poll the job for progress."""
    return await runner.start(deployment_id, body)


@router.get("/jobs", response_model=list[JobRecord])
def list_jobs(deployment_id: str, store: StoreDependency) -> list[JobRecord]:
    return store.list_jobs(deployment_id)


@router.get("/jobs/{job_id}", response_model=JobRecord)
def get_job(deployment_id: str, job_id: str, store: StoreDependency) -> JobRecord:
    return store.get_job(deployment_id, job_id)


@router.get("/jobs/{job_id}/logs", response_model=JsonObject)
def job_logs(deployment_id: str, job_id: str, runner: RunnerDependency) -> JsonObject:
    """Redacted ansible-runner stdout of the job's runs (no other files are served)."""
    return runner.logs(deployment_id, job_id)
