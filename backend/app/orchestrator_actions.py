"""Deployment stages on top of the existing orchestrator managers.

This module and `orchestrator_bridge` are the only places that import the orchestrator.
It contains no deployment logic: every stage is one or two calls of an existing manager
method, in the order used by `examples/default` and `examples/r2lab` of the orchestrator.

| Stage          | deploy                                         | remove                                 |
|----------------|------------------------------------------------|----------------------------------------|
| infrastructure | ProvisioningManagement.provision_nodes()       | ProvisioningManagement.unprovision_nodes() |
| kubernetes     | K8SManagement.deploy()                         | K8SManagement.remove()                 |
| core           | CoreManagement.deploy()                        | CoreManagement.remove()                |
| ric            | RICManagement.deploy()                         | RICManagement.remove()                 |
| radio          | ProvisioningManagement.provision(RUs, COTS UEs)| ProvisioningManagement.unprovision(...) |
| ran            | RANManagement.deploy()                         | RANManagement.remove()                 |
| ue             | UEManagement.deploy() + connect() (COTS)       | UEManagement.disconnect() + remove()   |

`radio` additionally supports `reserve` (ProvisioningManagement.reserve), which runs the
provisioner's own reservation role.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from metamodel.models.metamodel import MetaModel
from metamodel.models.ue import UEType
from orchestrator.deployment import (
    BaseManagement,
    CoreManagement,
    K8SManagement,
    ProvisioningManagement,
    RANManagement,
    RICManagement,
    UEManagement,
)
from orchestrator.models.deployment import DeploymentModel
from orchestrator.models.k8s import K8SStatus
from orchestrator.models.provisioning import (
    Provisioner,
    ProvisioningType,
    R2LabParams,
    R2LabProvisioner,
    R2LabReservationParams,
    UnifiedRadioParams,
)
from orchestrator.utils.utils import InvalidResourceStateError, ReferenceNotFoundError
from pydantic import ValidationError

from app.orchestrator_bridge import BridgeError, _create_manager, _validation_error
from app.schemas import DeploymentStage, JsonObject, StageAction

STAGES: tuple[DeploymentStage, ...] = ("infrastructure", "kubernetes", "core", "ric", "radio", "ran", "ue")

# Provisioner types whose Ansible roles call the SLICES CLI on the backend host
# (roles provisioning/bi/* and provisioning/pos/* with use_slices=True).
SLICES_CLI_PROVISIONERS = frozenset({ProvisioningType.BI, ProvisioningType.POS})


@dataclass(frozen=True, slots=True)
class Requirement:
    """A provider precondition for running a stage."""

    provider: str  # "slices" | "r2lab"
    kind: str  # "authentication" | "reservation"


@dataclass(slots=True)
class StageProgress:
    """Progress of one stage, read from the deployment model state."""

    stage: DeploymentStage
    items: dict[str, bool] = field(default_factory=dict)  # item name -> done
    requirements: list[Requirement] = field(default_factory=list)
    removable: list[str] = field(default_factory=list)

    @property
    def applicable(self) -> bool:
        return bool(self.items)

    @property
    def complete(self) -> bool:
        return self.applicable and all(self.items.values())

    @property
    def started(self) -> bool:
        return any(self.items.values())


@dataclass(frozen=True, slots=True)
class R2LabCredentials:
    """R2Lab credentials held in backend memory, injected only while an action runs."""

    email: str
    password: str
    slice: str


@dataclass(slots=True)
class RuntimeContext:
    """Host-specific values applied to the deployment state before an action."""

    runner_path: Path
    kubeconfig_path: Path
    slices_bin_dir: Path | None = None
    r2lab: R2LabCredentials | None = None
    reservation_minutes: int | None = None


def r2lab_endpoints() -> dict[str, str]:
    """Default API base URLs used by the orchestrator's R2Lab and unified-radio roles."""
    return {
        "r2lab_api": str(R2LabReservationParams.model_fields["r2lab_api_url"].default).rstrip("/"),
        "device_api": str(UnifiedRadioParams.model_fields["base_url"].default).rstrip("/"),
    }


def synchronized(metamodel: MetaModel, deployment_model: DeploymentModel) -> tuple[MetaModel, DeploymentModel]:
    """Return copies synchronized by `BaseManagement` (no reconciliation of 5G references)."""
    manager = _create_manager(BaseManagement, stage="sync", metamodel=metamodel, deployment_model=deployment_model)
    return manager.metamodel, manager.deployment_model


def apply_runtime(deployment_model: DeploymentModel, context: RuntimeContext) -> DeploymentModel:
    """Point Ansible artefacts and the kubeconfig at the deployment's own directory."""
    model = deployment_model.model_copy(deep=True)
    model.params.ansible.runner_path = str(context.runner_path)
    model.params.k8s.local_kubeconfig_path = str(context.kubeconfig_path)
    if context.slices_bin_dir and "extra_path" not in model.params.provisioning:
        model.params.provisioning["extra_path"] = str(context.slices_bin_dir)
    return model


def stage_progress(metamodel: MetaModel, deployment_model: DeploymentModel) -> list[StageProgress]:
    """Derive per-stage progress from the (synchronized) deployment state."""
    _, model = synchronized(metamodel, deployment_model)
    provisioners = model.provisioners

    def provisioner_type(name: str | None) -> ProvisioningType | None:
        if name is None:
            return None
        provisioner = provisioners.get(name)
        if provisioner is not None:
            return provisioner.type
        # The backend injects an R2Lab provisioner named "r2lab" at action time.
        return ProvisioningType.R2LAB if name == "r2lab" else None

    infrastructure = StageProgress("infrastructure")
    for name, node in model.nodes.items():
        if node.provisioner is None:
            continue  # existing machine (null provisioner): nothing to provision or destroy
        infrastructure.items[name] = node.is_provisioned
        if node.is_provisioned:
            infrastructure.removable.append(name)
    pending_types = {
        provisioner_type(model.nodes[name].provisioner) for name, done in infrastructure.items.items() if not done
    }
    if pending_types & SLICES_CLI_PROVISIONERS:
        infrastructure.requirements.append(Requirement("slices", "authentication"))

    has_workloads = bool(
        model.core.components or model.ran.components or model.ric.components
        or any(ue.type is UEType.CONTAINERIZED for ue in model.ues.values())
    )
    kubernetes = StageProgress("kubernetes")
    if has_workloads:
        for name, node in model.nodes.items():
            kubernetes.items[name] = node.k8s_status is K8SStatus.IN_CLUSTER
            if node.k8s_status is not K8SStatus.NOT_CONFIGURED:
                kubernetes.removable.append(name)

    core = StageProgress("core")
    if model.core.components:
        core.items["database"] = model.core.database_params.is_installed
        core.items |= {name: c.is_installed for name, c in model.core.components.items()}
        core.removable = [name for name, done in core.items.items() if done]

    ric = StageProgress("ric")
    ric.items = {name: c.is_installed for name, c in model.ric.components.items()}
    ric.removable = [name for name, done in ric.items.items() if done]

    radio = StageProgress("radio")
    radio_types: set[ProvisioningType | None] = set()
    for name, resource in [*model.rus.items(), *((n, u) for n, u in model.ues.items() if u.type is UEType.COTS)]:
        if resource.provisioner is None:
            continue
        radio.items[name] = resource.is_provisioned
        radio_types.add(provisioner_type(resource.provisioner))
        if resource.is_provisioned:
            radio.removable.append(name)
    if ProvisioningType.R2LAB in radio_types and not radio.complete:
        radio.requirements += [Requirement("r2lab", "authentication"), Requirement("r2lab", "reservation")]

    ran = StageProgress("ran")
    ran.items = {name: c.is_installed for name, c in model.ran.components.items()}
    ran.removable = [name for name, done in ran.items.items() if done]

    ue = StageProgress("ue")
    for name, entry in model.ues.items():
        if entry.type is UEType.COTS:
            ue.items[name] = entry.is_connected  # type: ignore[union-attr]
            needs_r2lab = provisioner_type(entry.provisioner) is ProvisioningType.R2LAB  # type: ignore[union-attr]
            if needs_r2lab and not entry.is_connected:  # type: ignore[union-attr]
                for requirement in (Requirement("r2lab", "authentication"), Requirement("r2lab", "reservation")):
                    if requirement not in ue.requirements:
                        ue.requirements.append(requirement)
        else:
            ue.items[name] = entry.is_installed  # type: ignore[union-attr]
        if ue.items[name]:
            ue.removable.append(name)

    return [infrastructure, kubernetes, core, ric, radio, ran, ue]


def remove_requirements(progress: StageProgress, model: DeploymentModel) -> list[Requirement]:
    """Provider preconditions for removing a stage (unprovision/disconnect also call providers)."""
    if progress.stage == "infrastructure":
        types = {model.provisioners[n.provisioner].type for n in model.nodes.values()
                 if n.provisioner in model.provisioners and n.is_provisioned}
        return [Requirement("slices", "authentication")] if types & SLICES_CLI_PROVISIONERS else []
    if progress.stage in ("radio", "ue") and any(
        getattr(resource, "provisioner", None) == "r2lab"
        for resource in [*model.rus.values(), *model.ues.values()]
    ):
        return [Requirement("r2lab", "authentication")]
    return []


async def run_stage(
    stage: DeploymentStage,
    action: StageAction,
    metamodel: MetaModel,
    deployment_model: DeploymentModel,
    context: RuntimeContext,
) -> tuple[MetaModel, DeploymentModel, BridgeError | None, bool]:
    """Run one stage action and return (metamodel, deployment_model, error, ran).

    `ran` is False when reconciliation failed before any action started (state unchanged).
    Otherwise the returned models hold every change the manager made, even after a failure.
    """
    model = apply_runtime(deployment_model, context)
    injected = _inject_provisioners(model, context, reserve=(action == "reserve"))

    manager_class, call = _stage_call(stage, action)
    try:
        manager = _create_manager(manager_class, stage=stage, metamodel=metamodel, deployment_model=model)  # type: ignore[arg-type]
    except BridgeError as exc:
        # Reconciliation failed before anything ran: the state is unchanged.
        return metamodel, deployment_model, exc, False

    error: BridgeError | None = None
    try:
        await call(manager)
    except BridgeError as exc:
        error = exc
    except Exception as exc:  # noqa: BLE001 - classified and reported to the caller
        error = action_error(stage, exc)

    # Managers mutate their deployment model in place; keep whatever succeeded.
    result_model = manager.deployment_model
    for name in injected:
        result_model.provisioners.pop(name, None)
    return manager.metamodel, result_model, error, True


def action_error(stage: DeploymentStage, exc: BaseException) -> BridgeError:
    """Classify an exception raised by a manager action."""
    messages = []
    current: BaseException | None = exc
    while current is not None and len(messages) < 6:
        text = str(current).strip()
        if text and text not in messages:
            messages.append(text)
        current = current.__cause__ or current.__context__

    if isinstance(exc, ValidationError):
        return _validation_error(exc, stage=stage, location="deployment_model")
    if isinstance(exc, InvalidResourceStateError):
        kind, status = "state", 409
    elif isinstance(exc, ReferenceNotFoundError):
        kind, status = "reference", 422
    elif stage in ("infrastructure", "radio"):
        kind, status = "provisioning_failure", 502
    elif stage == "kubernetes":
        kind, status = "kubernetes_failure", 502
    else:
        kind, status = "component_failure", 502

    message = messages[0] if messages else f"{stage} action failed."
    details = [{"loc": ["cause"], "msg": text} for text in messages[1:]] or None
    return BridgeError(
        kind=kind,
        stage=stage,
        exception=type(exc).__name__,
        message=message,
        details=details,
        status_code=status,
    )


def collect_secrets(*models: MetaModel | DeploymentModel) -> JsonObject:
    """Return model dumps that may contain secrets (for log masking)."""
    return {str(index): model.model_dump(mode="json") for index, model in enumerate(models)}


def _inject_provisioners(model: DeploymentModel, context: RuntimeContext, reserve: bool) -> list[str]:
    """Add the in-memory R2Lab provisioner when resources reference it and none is defined."""
    referenced = {
        resource.provisioner
        for resource in [*model.rus.values(), *model.ues.values()]
        if getattr(resource, "provisioner", None)
    }
    if "r2lab" not in referenced or "r2lab" in model.provisioners or context.r2lab is None:
        return []
    credentials = context.r2lab
    params = R2LabParams(
        r2lab_slice=credentials.slice,
        attempt_reservation=reserve,
        reservation_period=context.reservation_minutes if reserve else None,
        reservation_params=R2LabReservationParams(email=credentials.email, password=credentials.password),
    )
    provisioner: Provisioner = R2LabProvisioner(type=ProvisioningType.R2LAB, params=params)
    model.provisioners["r2lab"] = provisioner
    return ["r2lab"]


def _radio_resources(manager: BaseManagement) -> list[str]:
    model = manager.deployment_model
    return [
        *(name for name, ru in model.rus.items() if ru.provisioner is not None),
        *(name for name, ue in model.ues.items() if ue.type is UEType.COTS and ue.provisioner is not None),  # type: ignore[union-attr]
    ]


def _has_cots(manager: BaseManagement) -> bool:
    return any(ue.type is UEType.COTS for ue in manager.metamodel.ues.values())


async def _core_deploy(manager: CoreManagement) -> None:
    """CoreManagement.deploy(), retry-safe.

    Orchestrator quirk: `CoreManagement.run_database_action` expects the database helper to
    *return* InvalidResourceStateError, but it raises it, so `deploy()` fails with
    "5G core database is already installed" when retried after a partial failure. In that case
    run the remaining steps of `deploy()` with the same public methods it uses.
    """
    if not manager.deployment_model.core.database_params.is_installed:
        await manager.deploy(quiet=True)
        return
    await manager.prepare(quiet=True)
    await manager.install(quiet=True)
    await manager.register_ues()


async def _ue_deploy(manager: UEManagement) -> None:
    await manager.deploy(quiet=True)
    if _has_cots(manager):
        await manager.connect(quiet=True)


async def _ue_remove(manager: UEManagement) -> None:
    if _has_cots(manager):
        await manager.disconnect(quiet=True)
    await manager.remove(quiet=True)


async def _nodes_unprovision(manager: ProvisioningManagement) -> None:
    # Existing machines (null provisioner) are never touched.
    nodes = [name for name, node in manager.deployment_model.nodes.items() if node.provisioner is not None]
    if nodes:
        await manager.unprovision_nodes(nodes=nodes, quiet=True)


async def _radio(manager: ProvisioningManagement, method: str) -> None:
    resources = _radio_resources(manager)
    if not resources:
        return
    if method == "reserve":
        await manager.reserve(resources=resources, force=True, quiet=True)
    else:
        await getattr(manager, method)(resources=resources, quiet=True)


StageCall = Callable[[Any], Awaitable[None]]

_STAGE_CALLS: dict[tuple[str, str], tuple[type[BaseManagement], StageCall]] = {
    ("infrastructure", "deploy"): (ProvisioningManagement, lambda m: m.provision_nodes(quiet=True)),
    ("infrastructure", "remove"): (ProvisioningManagement, _nodes_unprovision),
    ("kubernetes", "deploy"): (K8SManagement, lambda m: m.deploy(quiet=True)),
    ("kubernetes", "remove"): (K8SManagement, lambda m: m.remove(quiet=True)),
    ("core", "deploy"): (CoreManagement, _core_deploy),
    ("core", "remove"): (CoreManagement, lambda m: m.remove(quiet=True)),
    ("ric", "deploy"): (RICManagement, lambda m: m.deploy(quiet=True)),
    ("ric", "remove"): (RICManagement, lambda m: m.remove(quiet=True)),
    ("radio", "deploy"): (ProvisioningManagement, lambda m: _radio(m, "provision")),
    ("radio", "remove"): (ProvisioningManagement, lambda m: _radio(m, "unprovision")),
    ("radio", "reserve"): (ProvisioningManagement, lambda m: _radio(m, "reserve")),
    ("ran", "deploy"): (RANManagement, lambda m: m.deploy(quiet=True)),
    ("ran", "remove"): (RANManagement, lambda m: m.remove(quiet=True)),
    ("ue", "deploy"): (UEManagement, _ue_deploy),
    ("ue", "remove"): (UEManagement, _ue_remove),
}


def supported(stage: str, action: str) -> bool:
    return (stage, action) in _STAGE_CALLS


def _stage_call(stage: str, action: str) -> tuple[type[BaseManagement], StageCall]:
    try:
        return _STAGE_CALLS[(stage, action)]
    except KeyError as exc:
        raise BridgeError(
            kind="validation",
            stage="input",
            exception="UnsupportedAction",
            message=f"Action {action!r} is not available for stage {stage!r}.",
            details=None,
            status_code=422,
        ) from exc
