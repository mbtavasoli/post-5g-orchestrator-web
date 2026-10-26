"""In-process runner for long-running deployment actions.

One asyncio task per job, at most one active job per deployment (the orchestrator
managers mutate the deployment model without locking). State is saved after every
stage, including failed ones, and the next stage always starts from the saved state.
"""

import asyncio
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from app import orchestrator_actions as actions
from app.orchestrator_bridge import BridgeError
from app.providers.r2lab import R2LabService
from app.providers.slices import SlicesAuth
from app.redaction import collect_secret_values, redact_data, redact_text
from app.schemas import ActionRequest, DeploymentStage, ErrorBody, JobRecord, StageRun
from app.settings import Settings
from app.store import DeploymentStore

logger = logging.getLogger(__name__)

_RUN_DIR_FORMAT = "%Y-%m-%dT%H-%M-%S.%fZ"  # orchestrator utils/ansible.py run directory names
_FAILURE_LINE = re.compile(r"^(fatal:|failed:|ERROR!|An exception occurred)|FAILED!")
_MAX_LOG_CHARS = 400_000

REQUIREMENT_MESSAGES = {
    ("slices", "authentication"): "SLICES authentication required",
    ("r2lab", "authentication"): "R2Lab sign-in required",
    ("r2lab", "reservation"): "R2Lab reservation required",
}


def _conflict(message: str, exception: str = "ActionConflict") -> BridgeError:
    return BridgeError(kind="conflict", stage="input", exception=exception, message=message,
                       details=None, status_code=409)


class JobRunner:
    """Start, track and inspect deployment jobs."""

    def __init__(self, store: DeploymentStore, settings: Settings, slices: SlicesAuth, r2lab: R2LabService) -> None:
        self.store = store
        self.settings = settings
        self.slices = slices
        self.r2lab = r2lab
        self._active: dict[str, str] = {}
        self._tasks: set[asyncio.Task] = set()

    # ---- lifecycle -----------------------------------------------------------------

    def mark_interrupted(self) -> None:
        """Jobs left running by a previous process can no longer finish."""
        for job in self.store.all_jobs():
            if job.status in ("queued", "running"):
                job.status = "interrupted"
                job.finished_at = datetime.now(UTC)
                for run in job.stages:
                    if run.status in ("pending", "running"):
                        run.status = "failed" if run.status == "running" else "pending"
                self.store.save_job(job)

    def is_active(self, deployment_id: str) -> bool:
        return deployment_id in self._active

    async def wait_idle(self) -> None:
        """Wait for all running jobs (used by tests and shutdown)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    # ---- state ---------------------------------------------------------------------

    def _current(self, deployment_id: str):
        state = self.store.load_state(deployment_id)
        if state is not None:
            return state
        _, metamodel, deployment_model = self.store.get(deployment_id)
        return metamodel, deployment_model

    def _context(self, deployment_id: str, reservation_minutes: int | None = None) -> actions.RuntimeContext:
        directory = self.store.runtime_dir(deployment_id)
        (directory / "kubeconfig").mkdir(exist_ok=True)
        return actions.RuntimeContext(
            runner_path=directory / "ansible-runner",
            kubeconfig_path=directory / "kubeconfig" / "admin.conf",
            slices_bin_dir=self.settings.slices_bin_dir,
            r2lab=self.r2lab.credentials(),
            reservation_minutes=reservation_minutes,
        )

    async def _unmet(self, requirements: list[actions.Requirement]) -> list[dict]:
        """Check provider requirements; return the unmet ones with a reason."""
        unmet = []
        reservation: dict | None = None
        for requirement in requirements:
            key = (requirement.provider, requirement.kind)
            reason: str | None = None
            if key == ("slices", "authentication"):
                status = await self.slices.status()
                if status["state"] != "authenticated":
                    reason = status.get("message") or f"SLICES CLI state: {status['state']}."
            elif key == ("r2lab", "authentication"):
                if self.r2lab.credentials() is None:
                    reason = "Sign in to R2Lab so the orchestrator's r2lab provisioner can be configured."
            elif key == ("r2lab", "reservation"):
                if self.r2lab.credentials() is None:
                    reason = "Sign in to R2Lab to check the testbed reservation."
                else:
                    try:
                        reservation = reservation or await self.r2lab.reservation()
                        if reservation["state"] != "reserved_by_you":
                            current = reservation.get("current")
                            reason = (
                                f"R2Lab is reserved by slice {current['slice_name']!r} until {current['t_until']}."
                                if current else "R2Lab has no active lease for your slice."
                            )
                    except BridgeError as exc:
                        reason = exc.message
            if reason:
                unmet.append({
                    "provider": requirement.provider,
                    "kind": requirement.kind,
                    "label": REQUIREMENT_MESSAGES.get(key, f"{requirement.provider} {requirement.kind}"),
                    "message": reason,
                })
        return unmet

    @staticmethod
    def _requirement_error(stage: str, unmet: list[dict]) -> BridgeError:
        first = unmet[0]
        kind = "reservation_required" if first["kind"] == "reservation" else "authentication_required"
        return BridgeError(
            kind=kind,
            stage=stage,
            exception="RequirementNotMet",
            message=f"{first['label']}: {first['message']}",
            details=[{"loc": [item["provider"], item["kind"]], "msg": item["message"]} for item in unmet],
            status_code=409,
            provider=first["provider"],
        )

    # ---- overview ------------------------------------------------------------------

    async def overview(self, deployment_id: str) -> dict:
        """Stages relevant to this deployment, their status and what they need."""
        metamodel, deployment_model = self._current(deployment_id)
        progress = actions.stage_progress(metamodel, deployment_model)
        jobs = self.store.list_jobs(deployment_id)
        active_id = self._active.get(deployment_id)
        active = next((job for job in jobs if job.id == active_id), None)

        last_run: dict[str, StageRun] = {}
        for job in jobs:
            for run in job.stages:
                if run.status != "pending":
                    last_run[run.stage] = run

        _, synced_model = actions.synchronized(metamodel, deployment_model)
        stages = []
        for index, item in enumerate(progress):
            running = active is not None and any(r.stage == item.stage and r.status == "running" for r in active.stages)
            previous_done = all(other.complete or not other.applicable for other in progress[:index])
            later_started = any(other.started for other in progress[index + 1:])
            run = last_run.get(item.stage)

            if not item.applicable:
                status = "skipped"
            elif running:
                status = "running"
            elif item.complete:
                status = "succeeded"
            elif run is not None and run.status in ("failed", "blocked"):
                status = run.status
            else:
                status = "pending"

            unmet = await self._unmet(item.requirements) if item.applicable and not item.complete else []
            remove_unmet = await self._unmet(actions.remove_requirements(item, synced_model)) if item.removable else []
            stages.append({
                "stage": item.stage,
                "applicable": item.applicable,
                "status": status,
                "items": [{"name": name, "done": done} for name, done in item.items.items()],
                "done": sum(item.items.values()),
                "total": len(item.items),
                "requirements": [
                    {"provider": r.provider, "kind": r.kind,
                     "label": REQUIREMENT_MESSAGES.get((r.provider, r.kind), r.kind),
                     "satisfied": not any(u["provider"] == r.provider and u["kind"] == r.kind for u in unmet),
                     "message": next((u["message"] for u in unmet
                                      if u["provider"] == r.provider and u["kind"] == r.kind), None)}
                    for r in item.requirements
                ],
                "can_deploy": item.applicable and not item.complete and previous_done and active is None and not unmet,
                "can_retry": status in ("failed", "blocked") and previous_done and active is None,
                "can_remove": bool(item.removable) and not later_started and active is None and not remove_unmet,
                "can_reserve": item.stage == "radio" and any(r.provider == "r2lab" for r in item.requirements)
                               and active is None and self.r2lab.credentials() is not None,
                "last_run": run.model_dump(mode="json") if run else None,
            })

        return {
            "deployment_id": deployment_id,
            "has_state": self.store.has_state(deployment_id),
            "active_job": active.model_dump(mode="json") if active else None,
            "last_job": jobs[-1].model_dump(mode="json") if jobs else None,
            "stages": stages,
        }

    # ---- start ---------------------------------------------------------------------

    async def start(self, deployment_id: str, request: ActionRequest) -> JobRecord:
        """Validate the request, check provider requirements, and start a job."""
        self.store.require(deployment_id)
        if deployment_id in self._active:
            raise _conflict("Another action is already running on this deployment.")

        metamodel, deployment_model = self._current(deployment_id)
        progress = {item.stage: item for item in actions.stage_progress(metamodel, deployment_model)}
        order = list(actions.STAGES)

        if request.action == "deploy":
            requested = request.stages or [s for s in order if progress[s].applicable and not progress[s].complete]
            stages = sorted(dict.fromkeys(requested), key=order.index)
            if not stages:
                raise _conflict("Every applicable stage is already deployed.", "NothingToDo")
            for stage in stages:
                if not progress[stage].applicable:
                    raise _conflict(f"Stage {stage!r} does not apply to this deployment.", "StageNotApplicable")
            first = stages[0]
            missing = [s for s in order[:order.index(first)]
                       if progress[s].applicable and not progress[s].complete and s not in stages]
            if missing:
                raise _conflict(f"Deploy {', '.join(missing)} before {first}.", "StageOrder")
            unmet = await self._unmet(progress[first].requirements)
            if unmet:
                raise self._requirement_error(first, unmet)

        elif request.action == "remove":
            if not request.stages:
                raise _conflict("Choose the stages to remove.", "StagesRequired")
            stages = sorted(dict.fromkeys(request.stages), key=order.index, reverse=True)
            for stage in stages:
                later = [s for s in order[order.index(stage) + 1:] if progress[s].started and s not in stages]
                if later:
                    raise _conflict(f"Remove {', '.join(later)} before {stage}.", "StageOrder")
            _, synced = actions.synchronized(metamodel, deployment_model)
            unmet = await self._unmet(actions.remove_requirements(progress[stages[0]], synced))
            if unmet:
                raise self._requirement_error(stages[0], unmet)

        else:  # reserve
            if request.stages not in (None, ["radio"]):
                raise _conflict("Only the radio stage supports reservation.", "UnsupportedAction")
            if not request.reservation_minutes:
                raise _conflict("Choose a reservation length.", "ReservationLengthRequired")
            stages = ["radio"]
            unmet = await self._unmet([actions.Requirement("r2lab", "authentication")])
            if unmet:
                raise self._requirement_error("radio", unmet)

        for stage in stages:
            if not actions.supported(stage, request.action):
                raise _conflict(f"Action {request.action!r} is not available for stage {stage!r}.", "UnsupportedAction")

        job = JobRecord(
            id=str(uuid4()),
            deployment_id=deployment_id,
            action=request.action,
            status="queued",
            stages=[StageRun(stage=stage, action=request.action, status="pending") for stage in stages],
            created_at=datetime.now(UTC),
            reservation_minutes=request.reservation_minutes,
        )
        self.store.save_job(job)
        self._active[deployment_id] = job.id
        task = asyncio.get_running_loop().create_task(self._run(job))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return job

    async def _run(self, job: JobRecord) -> None:
        deployment_id = job.deployment_id
        job.status = "running"
        job.started_at = datetime.now(UTC)
        self.store.save_job(job)
        try:
            for run in job.stages:
                stage: DeploymentStage = run.stage
                metamodel, deployment_model = self._current(deployment_id)

                if job.action == "deploy":
                    progress = {p.stage: p for p in actions.stage_progress(metamodel, deployment_model)}
                    unmet = await self._unmet(progress[stage].requirements)
                    if unmet:
                        error = self._requirement_error(stage, unmet)
                        run.status, run.error = "blocked", ErrorBody(**error.body())
                        job.status, job.error = "blocked", run.error
                        break

                run.status = "running"
                run.started_at = datetime.now(UTC)
                self.store.save_job(job)

                context = self._context(deployment_id, job.reservation_minutes)
                new_metamodel, new_model, error, ran = await actions.run_stage(
                    stage, job.action, metamodel, deployment_model, context)
                if ran:
                    self.store.save_state(deployment_id, new_metamodel, new_model, stage=f"{stage}.{job.action}")

                run.finished_at = datetime.now(UTC)
                if error is not None:
                    excerpt = self._failure_excerpt(deployment_id, run.started_at)
                    body = error.body()
                    body["details"] = [*(body["details"] or []), *excerpt] or None
                    run.status, run.error = "failed", ErrorBody(**redact_data(body))
                    job.status, job.error = "failed", run.error
                    break
                run.status = "succeeded"
                self.store.save_job(job)
            else:
                job.status = "succeeded"
        except Exception:  # noqa: BLE001 - recorded on the job; never crash the loop
            logger.exception("Deployment job %s failed unexpectedly", job.id)
            job.status = "failed"
            job.error = ErrorBody(kind="internal", stage="input", exception="InternalServerError",
                                  message="The backend failed while running this action. See the server log.")
            for run in job.stages:
                if run.status == "running":
                    run.status, run.error = "failed", job.error
        finally:
            job.finished_at = datetime.now(UTC)
            # Release the deployment before publishing the final status, so a client that sees
            # the job finished can immediately start the next action.
            self._active.pop(deployment_id, None)
            self.store.save_job(job)

    # ---- logs ----------------------------------------------------------------------

    def _secrets(self, deployment_id: str) -> set[str]:
        metamodel, deployment_model = self._current(deployment_id)
        values = collect_secret_values(actions.collect_secrets(metamodel, deployment_model))
        return values | self.r2lab.secrets()

    def _runs(self, deployment_id: str, since: datetime, until: datetime | None) -> list[tuple[str, Path]]:
        """Ansible-runner stdout files of runs started in [since, until]; nothing else is read."""
        runner = self.store.runtime_dir(deployment_id) / "ansible-runner"
        if not runner.is_dir():
            return []
        runs = []
        for stdout in runner.glob("**/artifacts/*/stdout"):
            if stdout.is_symlink() or not stdout.is_file():
                continue
            run_dir = stdout.parents[2]
            try:
                started = datetime.strptime(run_dir.name, _RUN_DIR_FORMAT).replace(tzinfo=UTC)
            except ValueError:
                continue
            if started < since.replace(microsecond=0) or (until is not None and started > until):
                continue
            runs.append((run_dir.name, run_dir.parent.relative_to(runner).as_posix(), stdout))
        return [(label, path) for _, label, path in sorted(runs)]

    def logs(self, deployment_id: str, job_id: str) -> dict:
        """Redacted Ansible output of the runs that belong to one job."""
        job = self.store.get_job(deployment_id, job_id)
        if job.started_at is None:
            return {"job_id": job_id, "text": "", "runs": [], "truncated": False}
        secrets = self._secrets(deployment_id)
        chunks, labels = [], []
        for label, stdout in self._runs(deployment_id, job.started_at, job.finished_at):
            labels.append(label)
            content = stdout.read_text(encoding="utf-8", errors="replace")
            chunks.append(f"### {label}\n{content.rstrip()}\n")
        text = redact_text("\n".join(chunks), secrets)
        truncated = len(text) > _MAX_LOG_CHARS
        return {
            "job_id": job_id,
            "status": job.status,
            "runs": labels,
            "text": text[-_MAX_LOG_CHARS:],
            "truncated": truncated,
        }

    def _failure_excerpt(self, deployment_id: str, since: datetime | None) -> list[dict]:
        """Ansible failure lines of a stage, so provider/task errors are not hidden."""
        if since is None:
            return []
        secrets = self._secrets(deployment_id)
        details = []
        for label, stdout in self._runs(deployment_id, since, None):
            for line in stdout.read_text(encoding="utf-8", errors="replace").splitlines():
                if _FAILURE_LINE.search(line.strip()):
                    details.append({"loc": ["ansible", label], "msg": redact_text(line.strip(), secrets)[:1500]})
                if len(details) >= 8:
                    return details
        return details
