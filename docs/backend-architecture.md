# Backend architecture (v1 proposal)

Status: **proposal, not implemented.** Scope of v1:

1. Create or load a deployment configuration.
2. Validate and reconcile it with the orchestrator.
3. Return the resulting configuration to the frontend.

Deployment actions (provision, deploy, install, …) are **out of scope** for v1. Their later design is sketched in section 10.

Facts about the orchestrator come from `../orchestrator` (see `AGENTS.md`). They were checked with `../orchestrator/.venv-1`. Everything else in this document is web-app design and adds **no new orchestrator abstractions**.

---

## 1. Principles

- **Thin backend.** The backend handles HTTP, file storage and error formatting. Everything about 5G (validation, defaults, reference resolution, dependency order, execution) stays in the orchestrator.
- **One bridge module.** Only `backend/app/orchestrator_bridge.py` imports `orchestrator.*` and `metamodel.*`. The routes never touch managers directly. If the orchestrator API changes, only this file changes.
- **Options come from the models, never from examples.** See section 2.
- **No orchestrator changes.** If something is missing upstream, record it in section 11. Do not patch it.

## 2. Supported options come from the models, not the examples

**Rule:** the files in `../orchestrator/examples` (notebooks, YAML, tutorials) are **not exhaustive**. They must **never** be used as the list of supported options. Use them only to understand valid workflows and realistic configurations.

**What this means in practice:**
- For every configurable field the web UI or API exposes, find the full set of valid values in the real Pydantic models, enums, mappings and validators of `orchestrator` and of the external `metamodel` package (read from `../orchestrator/.venv-1/lib/python3.13/site-packages/metamodel/`).
- The backend computes these options **at runtime by introspection**.
- Neither the backend nor the frontend hardcodes option lists. When the orchestrator or `metamodel` gains a value, the UI picks it up after reinstalling, with no web-app code change.

### Sources (all checked to exist in the installed versions)

| What | Source (existing) | How to derive it |
|---|---|---|
| Field structure, types, defaults, constraints (`ge`/`le`, patterns), literals, enums, unions, discriminators | `MetaModel`, `DeploymentModel` and their nested models | `model_json_schema(mode="validation")`. Works for both: 97 / 55 `$defs`, about 50 / 40 KB. |
| Implementations per network and their default | `CoreImplementation`, `RANImplementation`, `RICImplementation`, `UEImplementation` | Enum members. Read the default from the model field: `CoreDeployment.model_fields["implementation"].default` (`open5gs`), and similarly for RAN (`oai`), RIC (`oai`) and `DeployedUE` (`oai`) |
| Component types per category | `CoreComponentType`, `RANComponentType`, `RICComponentType`, `UEType` (metamodel) | Enum members |
| Which component types each implementation supports | `SUPPORTED_CORE_COMPONENTS`, `SUPPORTED_RAN_COMPONENTS`, `SUPPORTED_RIC_COMPONENTS` | Dict lookup. **The JSON schema cannot express this**, because it depends on the chosen implementation |
| Implementation-specific `advanced_config` fields | `ADVANCED_{CORE,RAN,RIC,UE}_CONFIG_MAPPING[impl][type]` | `model_json_schema()` of the mapped class. If there is no entry, the strict empty `Generic*AdvancedConfig` applies, which allows no fields. **The main schema shows `advanced_config` as an untyped `Any`**, so this lookup is required |
| RU types, models and capabilities | `RUType`, `RUModel` (`USRPModel`, `AW2SModel`, `BenetelModel`, `LiteonModel`), `metamodel.models.ru.CATALOGS` | `CATALOGS[ru_type]` gives (model enum, catalog of `RUCapabilities`). `simulated` has no catalog |
| Provisioner types and what each can provision | `Provisioner` (union discriminated by `type`), `ProvisioningType`, `ProvisioningCategory` | Union members. `Cls.model_fields["supported_categories"].get_default(call_default_factory=True)`: `pos`, `legacy_pos` and `bi` provision nodes; `unified_radio` and `r2lab` provision RUs and UEs |
| Node roles | `NodeRole = Category5G \| CoreComponentType \| RANComponentType \| RICComponentType \| DatabaseRole` | Union of enum members |
| Default images and privileges (a hint, not a restriction) | `orchestrator.utils.defaults` (`DEFAULT_*_IMAGES`, `*_POD_PRIVILEGES`) | Dict lookup. For example, RAN default images exist only for some (implementation, RU type) pairs, so other pairs need an explicit `image` or reconciliation fails |
| Discriminated components | Core: `ValidatedCoreComponent \| CoreComponent`. RAN: `RANComponent` (by `type`). RIC: `ValidatedRICComponent \| RICComponent`. Deployment UEs: `ProvisionableUE \| DeployedUE` (by `type`) | Present in the JSON schema as `discriminator` / `oneOf` / `anyOf` |

### Rules the JSON schema cannot express

Model validators enforce some rules across fields. These are only checked when the backend validates or reconciles (section 9). They are not part of the options.
- RU antenna ports must not exceed the RU's capabilities.
- A containerized UE needs an `ru` and at least one PDU session.
- A component's type must be supported by the chosen implementation.
- References must point to defined, ready components.

The frontend may use the options to guide input, but **the backend's validation and reconciliation have the final say**.

## 3. Framework: FastAPI

| Need | Why FastAPI fits |
|---|---|
| Orchestrator is Pydantic v2 (`pydantic==2.13.5`) | FastAPI is built on Pydantic v2. Models dump to JSON and to JSON Schema directly. |
| Orchestrator managers are `async` | FastAPI is ASGI-native. Phase-2 actions can run as asyncio tasks in the same event loop. |
| Frontend needs a typed contract | OpenAPI and Swagger UI are generated for free. |
| Minimal footprint | Two dependencies: `fastapi` and `uvicorn`. `pydantic-settings` and `PyYAML` are already installed as orchestrator dependencies. |

Flask and Django were rejected: they are WSGI-first and don't integrate with Pydantic. Litestar would also work, but it has a smaller ecosystem and offers no advantage here.

**Version rule:** never let `pip` upgrade or downgrade `pydantic`, `pydantic_core` or `metamodel` away from the orchestrator's pins. Pick a FastAPI version that accepts `pydantic==2.13.5`.

## 4. Importing the orchestrator

- The backend gets **its own venv** (`backend/.venv`), so the orchestrator's `.venv-1` stays untouched.
- Install the orchestrator into it **the same way `examples/default/test.ipynb` does**: a regular (non-editable) install from the local path, with the GitLab index for `metamodel`:

  ```bash
  pip install ../../orchestrator --extra-index-url=https://gitlab.inria.fr/api/v4/projects/70914/packages/pypi/simple
  pip install -e .   # backend itself (fastapi, uvicorn, pytest, httpx)
  ```

- **Why not an editable install:** `AnsibleParams.roles_paths` defaults to `Path(__file__).parents[2] / "ansible" / "roles"`. In an installed wheel that is `site-packages/ansible/roles`, which works. With an editable install of the `src/` layout it becomes `src/ansible/roles`, which doesn't exist, so the default is `[]` and phase-2 actions would find no roles.
- After pulling orchestrator changes, re-run the first command.
- What the bridge imports (all public, all existing):

  ```python
  from metamodel.models.metamodel import MetaModel
  from orchestrator.models.deployment import DeploymentModel
  from orchestrator.deployment import (
      BaseManagement, CoreManagement, RICManagement, RANManagement, UEManagement,
  )
  from orchestrator.utils.utils import ReferenceNotFoundError, InvalidResourceStateError
  from pydantic import ValidationError
  # option sources (section 2): *Implementation enums, SUPPORTED_*_COMPONENTS,
  # ADVANCED_*_CONFIG_MAPPING, metamodel enums + ru.CATALOGS, Provisioner, NodeRole,
  # orchestrator.utils.defaults
  ```

## 5. Minimal folder structure

```
post-5g-orchestrator-web/
├── AGENTS.md
├── docs/backend-architecture.md
├── backend/
│   ├── pyproject.toml              # fastapi, uvicorn; dev: pytest, httpx
│   ├── README.md                   # setup + run commands
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                 # FastAPI app, routers, exception handlers
│   │   ├── settings.py             # pydantic-settings: data_dir, host, port
│   │   ├── schemas.py              # request/response envelopes (thin)
│   │   ├── store.py                # file-based deployment store
│   │   ├── orchestrator_bridge.py  # ONLY place that imports orchestrator/metamodel
│   │   └── routes/
│   │       ├── deployments.py
│   │       └── options.py          # schema + model-derived options (planned, section 7)
│   └── tests/
│       ├── test_deployments.py
│       └── test_options.py
├── frontend/                       # later
└── data/                           # runtime, git-ignored (default data_dir)
```

## 6. Backend state: one deployment = one folder

A **deployment** in the backend is a named pair (`MetaModel`, `DeploymentModel`) plus a little metadata. It is the same unit the tutorials and the notebook pass between managers.

```
data/deployments/<deployment_id>/
├── deployment.json          # backend metadata only (see below)
├── metamodel.yaml           # MetaModel.to_yaml()        — user's desired config
└── deployment_model.yaml    # DeploymentModel.to_yaml()  — user's desired config
```

`deployment.json` holds `id` (UUID), `name`, `created_at`, `updated_at`, and the `orchestrator` and `metamodel` versions read from package metadata.

**Where models are loaded and saved:** only in `store.py`, using the orchestrator's own helpers:
- load with `MetaModel.from_yaml_file()` and `DeploymentModel.from_yaml_file()`;
- save with `.to_yaml()`, written to a temp file and then `os.replace` for an atomic write.

YAML is used because it is the format the orchestrator, tutorials and examples already use, so files can go back and forth between the web app and notebooks.

**Input and reconciled output are kept apart in v1.**
- The stored files are the user's *input*. Reconciliation runs on demand from that input and its result is returned, **not saved**.
- Why: reconciliation fills `image`, `namespace` and `security_context` only when they are `None`. If the reconciled model were saved as the new input and the user then switched implementations (say open5gs → oai), the old images would stay and be wrong.
- Trade-off: reconciliation assigns random static pod IPs, so they differ between two reconcile calls. This is harmless in v1 because nothing gets deployed. Phase 2 deals with it (section 10).

## 7. REST endpoints

All endpoints are under `/api`. Bodies and responses are JSON.

### 7.1 v1: deployments

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness + installed `orchestrator`/`metamodel`/`pydantic` versions |
| `POST` | `/api/deployments` | Create: validate and save a new deployment |
| `GET` | `/api/deployments` | List deployments (metadata only) |
| `GET` | `/api/deployments/{id}` | Load a deployment's stored models |
| `PUT` | `/api/deployments/{id}` | Replace a deployment's models (validated) |
| `POST` | `/api/deployments/{id}/reconcile` | Run orchestrator reconciliation and return the result (nothing is saved) |

**Create / replace request**

```json
{
  "name": "simple-scenario",
  "metamodel": { ... } | "<yaml text>" | null,
  "deployment_model": { ... } | "<yaml text>" | null
}
```

- Each model can be a JSON object, or a YAML string so files from notebooks can be pasted or uploaded. YAML goes through `MetaModel.from_yaml` / `DeploymentModel.from_yaml`; JSON objects through `model_validate`.
- `null` means the orchestrator defaults (`MetaModel()` / `DeploymentModel()`).
- Request bodies are typed loosely (`dict | str | None`). Validation happens in the bridge, so every error has the same shape (section 9) and isn't FastAPI's generic 422.

**Create / load response**

```json
{
  "deployment": { "id": "...", "name": "...", "created_at": "...", "updated_at": "..." },
  "metamodel": { ... },          // model_dump(mode="json")
  "deployment_model": { ... }    // model_dump(mode="json")
}
```

Responses are full dumps with defaults included, so the frontend sees every effective value. Files on disk stay sparse.

**Reconcile request and response**

`POST /api/deployments/{id}/reconcile?until=ric`

- `until` is one of `sync | core | ric | ran | ue`. The default is `ric`.
- The bridge chains the **existing** managers in tutorial order using `preceding=`:

  | `until` | Managers created |
  |---|---|
  | `sync` | `BaseManagement` (synchronize only) |
  | `core` | `CoreManagement` |
  | `ric` | `CoreManagement` → `RICManagement` |
  | `ran` | … → `RANManagement` |
  | `ue` | … → `UEManagement` |

- Each manager reconciles in its `__init__`. No action methods are called.
- Why the default is `ric`: on a configuration that has never been deployed, Core and RIC reconcile fine. RAN and UE fail by design, because they need an installed AMF and known gNB addresses (`InvalidResourceStateError` / `ReferenceNotFoundError`).
- A deployed state reconciles all the way to `ue`. This was tested with the saved states of four examples: `default`, `r2lab`, `ocudu-zmq` and `b210/oai-ran`.

```json
{
  "until": "ric",
  "stages": ["core", "ric"],
  "metamodel": { ... },          // last manager's .metamodel (unresolved)
  "deployment_model": { ... }    // last manager's .deployment_model (reconciled)
}
```

The resolved view (`mutable_metamodel`, dumped with `serialize_as_any=True`) is left out of v1. It only reflects the last stage's references, which could be misleading.

### 7.2 Planned (right after v1): schema and options

These let the frontend build its forms and choices **dynamically**. Every value is computed by the bridge from the sources in section 2, and no list is hardcoded in the backend or the frontend. All are read-only and need no deployment.

| Method | Path | Returns | Source |
|---|---|---|---|
| `GET` | `/api/schema/metamodel` | JSON Schema | `MetaModel.model_json_schema(mode="validation")` |
| `GET` | `/api/schema/deployment-model` | JSON Schema | `DeploymentModel.model_json_schema(mode="validation")` |
| `GET` | `/api/options` | Option catalog (below) | Enums, `SUPPORTED_*`, `CATALOGS`, `Provisioner`, `NodeRole`, defaults |
| `GET` | `/api/options/advanced-config/{category}/{implementation}/{type}` | JSON Schema of the `advanced_config` model for that combination | `ADVANCED_*_CONFIG_MAPPING`, falling back to `Generic*AdvancedConfig` |

`category` is one of `core | ran | ric | ue`. For `ue`, `type` is a `UEType`, because the UE mapping is keyed by UE type. An unknown implementation or type returns 404 with the error envelope.

**`GET /api/options` response shape.** Values are illustrative; they are produced by introspection:

```json
{
  "versions": { "orchestrator": "0.0.3", "metamodel": "0.0.3" },
  "core": {
    "implementations": ["oai", "open5gs", "free5gc"],
    "default_implementation": "open5gs",
    "component_types": ["amf", "smf", "..."],
    "supported_components": { "oai": ["amf", "..."], "open5gs": ["..."], "free5gc": ["..."] },
    "advanced_config": { "oai": { "amf": "OAIAdvancedAMFConfig", "...": "..." } },
    "default_images": { "open5gs": { "amf": "docker.io/gradiant/open5gs:2.8.0" } }
  },
  "ran": {
    "implementations": ["..."], "default_implementation": "oai",
    "component_types": ["..."], "supported_components": { "...": ["..."] },
    "advanced_config": { "...": { "...": "..." } },
    "default_images": { "oai": { "usrp": { "gnb": "..." } } }
  },
  "ric": { "...": "same keys as core" },
  "ue": {
    "types": ["containerized", "cots"],
    "implementations": ["oai", "ueransim", "srsue"], "default_implementation": "oai",
    "advanced_config": { "oai": { "containerized": "OAIAdvancedUEConfig" } }
  },
  "ru": {
    "types": ["simulated", "usrp", "aw2s", "benetel", "liteon"],
    "models": { "usrp": ["b210", "b205", "n300", "n320"], "...": ["..."] },
    "capabilities": { "usrp": { "b210": { "max_bw_mhz": 56.0, "...": "..." } } }
  },
  "provisioners": {
    "types": ["pos", "legacy_pos", "bi", "unified_radio", "r2lab"],
    "supported_categories": { "bi": ["node"], "r2lab": ["ru", "ue"], "...": ["..."] }
  },
  "node_roles": ["core", "ran", "ue", "ric", "amf", "...", "database"]
}
```

- **Dependent choices** are expressed as maps the frontend filters on, instead of flat lists:
  - implementation → supported component types;
  - RU type → models → capabilities;
  - (implementation, type) → advanced-config schema;
  - (implementation, RU type) → default image.
- `default_images` is a **hint**. A combination without a default image is still valid if the user sets `image`.
- Every list is built by iterating the source enum, dict or union. The bridge names the sources but never the values.
- Responses can be cached in memory for the life of the process, because they change only when the orchestrator or `metamodel` is reinstalled.

### 7.3 Later

- `DELETE /api/deployments/{id}`;
- the merged-dict format (`BaseManagement(merged=…)`, `output_merged()`);
- action endpoints (section 10).

## 8. Bridge responsibilities (`orchestrator_bridge.py`)

```text
# v1
parse_metamodel(data | yaml | None)        -> MetaModel
parse_deployment_model(data | yaml | None) -> DeploymentModel
reconcile(metamodel, deployment_model, until) -> (stages, MetaModel, DeploymentModel)
dump(model) -> dict                       # model_dump(mode="json")
versions() -> dict

# planned (section 7.2)
model_schema(which) -> dict               # model_json_schema(mode="validation")
options() -> dict                         # introspected catalog, section 2 sources only
advanced_config_schema(category, implementation, type) -> dict
```

- Every function is synchronous and fast (no I/O, no Ansible). FastAPI routes can be plain `def`, which runs them in its threadpool.
- The bridge never changes the stored models. The managers already deep-copy their inputs.

## 9. Error responses

One envelope for every error:

```json
{
  "error": {
    "kind": "validation | reference | state | reconciliation | not_found",
    "stage": "input | sync | core | ric | ran | ue",
    "exception": "ValidationError",
    "message": "human-readable summary",
    "details": [ { "loc": ["deployment_model", "ran"], "type": "value_error", "msg": "..." } ]
  }
}
```

| Raised by | When | `kind` | HTTP |
|---|---|---|---|
| `pydantic.ValidationError` | Parsing input (`stage: input`) | `validation` | 422 |
| `pydantic.ValidationError` | Inside manager creation: `synchronize()` re-validates `DeploymentModel`, for example a component type the chosen implementation doesn't support | `validation` | 422 |
| `yaml.YAMLError` | Bad YAML text | `validation` | 422 |
| `ReferenceNotFoundError` | A component references something undefined or with an unknown address | `reference` | 422 |
| `InvalidResourceStateError` | A referenced resource is not installed or provisioned yet (pipeline order) | `state` | 409 |
| `ValueError` / `RuntimeError` during reconcile | For example no default image, no NRF | `reconciliation` | 422 |
| Unknown deployment id, or unknown options combination | | `not_found` | 404 |

- Build `details` from `ValidationError.errors(include_url=False, include_input=False, include_context=False)`. Leaving out `input` keeps secrets such as SSH passwords and tokens out of error bodies.
- Prefix `loc` with `metamodel` or `deployment_model` so the frontend can point to the right form field.
- Non-Pydantic exceptions have no structured location: `details` is `null`, and `message` is `str(exc)`, which already names the component.
- Any other exception is a 500 with `kind: "internal"`. It is logged on the server, not echoed to the client.

## 10. Long-running actions (later; design only)

Orchestrator actions are `async`, take minutes, run Ansible over SSH, and change `deployment_model` in place (`is_installed`, `network_info`, `k8s_status`, …). There are no progress hooks.

- **Execution:** an in-process job runner using an `asyncio.create_task` per job, started from FastAPI's lifespan. Use one `asyncio.Lock` per deployment, so only one action runs on a deployment at a time (managers have no locking). No Celery or Redis until there is more than one backend process.
- **Job record:** `data/deployments/<id>/jobs/<job_id>.json` with `stage`, `action`, `status` (`queued | running | succeeded | failed | interrupted`), timestamps and the error envelope. API: `POST /api/deployments/{id}/actions` returns `202` and a job id. Then `GET /api/jobs/{job_id}` to poll.
- **State snapshots:** follow the convention already used in the tutorials and `examples/digitafrica-demo/backup/state/`: after each stage, save `state/metamodel.<stage>.yaml` and `state/deployment_model.<stage>.yaml` from `manager.metamodel` and `manager.deployment_model`.
  - **Save even on failure.** Components in earlier dependency levels are already marked installed.
  - The latest snapshot becomes the starting point (`preceding=` / `metamodel=` + `deployment_model=`) for the next stage. That also fixes the random-IP problem, because reconciled IPs are saved together with the deployed state.
- **Available actions** must also come from the manager classes' public methods, as the orchestrator defines them. Don't take them from what the tutorials happen to call.
- **Logs and progress:** set the existing `params.ansible.runner_path` to `data/deployments/<id>/ansible-runner` so artefacts are kept per deployment. Call actions with `quiet=True`. Stream by tailing the ansible-runner artefact files over SSE or polling.
- **Restarts:** jobs still marked `running` at startup become `interrupted`. The orchestrator's state checks (`is_installed`, `ignore_invalid_states`) make re-running a stage safe.
- **Open decision for phase 2:** how a user edits the input after a stage has been deployed (re-base on the latest snapshot, or diff against it). Decide this with the user before implementing.

## 11. Risks and notes

- **Secrets in models.** `SSHInfo.password` / `sudo_password`, provisioner tokens, R2Lab credentials and `params.k8s.join_command` are part of the models and of the responses. v1 must be local-only: bind to `127.0.0.1`, no auth. Redact secrets, or add auth, before any shared deployment.
- **Host-specific defaults.** `params.ansible.roles_paths`, `params.ansible.runner_path`, `params.k8s.local_kubeconfig_path` and the default SSH keys are resolved on the backend host when the model is validated. Configurations shared between machines may carry another machine's paths (the example files contain `/Users/zimabrou/...`).
- **Orchestrator quirks** (listed in `AGENTS.md`): the bridge always passes model objects, never `metamodel_file=` / `deployment_model_file=`, because `BaseManagement.__init__` checks `merged_file_type` when loading files.
- **Testing:** pytest + FastAPI `TestClient`.
  - Read-only fixtures:
    - defaults (`null` models): reconcile `until=ric` gives 200, `until=ran` gives 409;
    - `examples/default/output_*.yaml`: reconcile `until=ue` gives 200 (examples are used here as *realistic workflows*, not as option lists);
    - an unsupported component (`ueransim` + `du`): 422 `validation`;
    - an unknown gNB reference: 422 `reference`.
  - Options tests compare `/api/options` with the **source enums and mappings imported in the test**, not with hardcoded lists. For example, `set(options["core"]["implementations"]) == {e.value for e in CoreImplementation}`. They also check that every `/api/options/advanced-config/...` combination listed returns a schema.
