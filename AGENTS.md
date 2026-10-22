# AGENTS.md — post-5g-orchestrator-web

Guidance for coding agents (Codex, Gemini, Claude, …) working in this repository.

## Ground rules

- **This repo (`post-5g-orchestrator-web`) holds the new web frontend and backend.** All new code goes here.
- **`../orchestrator` is the source of truth** for the 5G models, defaults, reconciliation and deployment logic. Read it; do not copy or re-implement it.
- **Do not modify `../orchestrator` unless the user explicitly asks.** If a change there seems necessary, stop and report it (file, line, reason) instead.
- **Do not invent orchestrator concepts.** User levels, modes, profiles, REST APIs, job systems and auth do **not** exist in the orchestrator today (see "What does not exist"). Anything like that is new web-app design and must be agreed with the user first.
- The meta-model lives in the external `metamodel` package (pinned `metamodel==0.0.3`), **not** in the orchestrator repo. Read it from the orchestrator's venv: `../orchestrator/.venv-1/lib/python3.13/site-packages/metamodel/`. That venv also has the orchestrator and its pinned dependencies installed. Use `../orchestrator/.venv-1/bin/python` to try things out.
- **Stay inside the `post-5g` directory.** Do not read code, venvs or packages from outside it. Other copies on the machine may differ.

Sections below are labelled **[EXISTING]** (verified in the orchestrator code) or **[PROPOSED]** (web-app design guidance, not yet implemented).

---

## [EXISTING] Orchestrator architecture

Python ≥ 3.12, `pydantic==2.13.5`, `ansible-core`, `ansible-runner`, `metamodel==0.0.3`. Package: `src/orchestrator/`.

### Two models describe one deployment

| Model | Import | Role |
|---|---|---|
| `MetaModel` | `metamodel.models.metamodel` | Implementation-agnostic, 3GPP-style description of the network: `core`, `ran`, `rus`, `ues`, `slices`, `ric`. Each component has `category`, `type`, `config`. |
| `DeploymentModel` | `orchestrator.models.deployment` | How and where the network is deployed, plus runtime state: `params` (ansible, k8s, provisioning), `provisioners`, `nodes`, `core`, `ran`, `rus`, `ues`, `ric`, `miscellaneous`. |

- Both extend `StrictBaseModel` (`extra="forbid"`) with `from_yaml`, `from_yaml_file`, `from_json`, `from_json_file`, `to_yaml(exclude_defaults=True)` and `to_yaml_file`.
- Components are keyed by **name** in both models. The deployment entry for a component has the same key as its meta-model entry.
- A **merged** dict (meta + deployment fields for one component, or for the whole deployment) is also accepted. See `BaseManagement(merged=…)`, `add_component(merged=…)` and `output_merged()`.
- Runtime state lives in the deployment model: `is_installed` and `network_info` (components), `is_provisioned` (nodes, RUs, UEs), `k8s_status` (nodes), `is_connected` (COTS UEs), `params.k8s.master_node`, `join_command` and `used_ips`, and `core.database_params.is_installed`.

Key deployment-side classes (`orchestrator/models/`):
- `common.py`: `Deployed5GComponent` (extends `K8SComponent`; adds `type`, `implementation`, `advanced_config`, `plain_text_config`) and `Deployed5GNetwork`.
- `core.py`, `ran.py`, `ric.py`, `ue.py`: `Deployed*Component`, `*Deployment`, `*Implementation` enums, `SUPPORTED_*_COMPONENTS`, `ADVANCED_*_CONFIG_MAPPING`.
- `k8s.py`: `K8SParams`, `K8SComponent` (image, resources, multus, node selection, security context, custom chart, and so on), `K8SStatus`.
- `provisioning.py`: provisioners (`POS`, `LEGACY_POS`, `BI`, `UNIFIED_RADIO`, `R2LAB`), `ProvisionableNode`, `ProvisionableRU`, `ProvisionableUE`, `SSHInfo`. Node `roles` are Kubernetes scheduling labels, **not** user roles.

### Supported implementations

| Category | Implementations (enum) | Notes |
|---|---|---|
| Core | `CoreImplementation`: `oai`, `open5gs` (default), `free5gc` | Per-implementation NF list in `SUPPORTED_CORE_COMPONENTS` |
| RAN | `RANImplementation`: `oai` (default), `ocudu`, `ueransim` | OAI/OCUDU: `gnb`, `cu`, `du`, `cu_cp`, `cu_up`. UERANSIM: `gnb` only |
| RIC | `RICImplementation`: `oai` (FlexRIC, default), `oran_sc` | OSC uses `dbaas`, `e2mgr`, `e2term`, `rtmgr`, `submgr`, `appmgr`, `chartmuseum`, `xapp_onboarder`, `a1mediator` |
| UE | `UEType`: `containerized`, `cots`. `UEImplementation`: `oai` (default), `ueransim`, `srsue` | Containerized UEs are deployed with Helm; COTS UEs are provisioned and connected through a provisioner |
| RU | `RUType`: `simulated`, `usrp`, `aw2s`, `benetel`, `liteon` (models in the metamodel `ru.py` catalogs) | Only non-simulated RUs become `ProvisionableRU`. Default RAN images exist for OAI (usrp, simulated, aw2s, benetel), OCUDU (usrp, benetel, simulated) and UERANSIM (simulated). Otherwise `image` must be set |

A component's `implementation` defaults to the network-level `implementation`, but each component can override it.

### How defaults are defined

1. **Pydantic field defaults.**
   - `DeploymentModel()` gives: core `open5gs`, RAN `oai`, RIC `oai`, provisioners `bi` and `pos`, nodes `node1`–`node4`, and K8s parameters (k8s 1.36.2, calico, multus, helm versions, CIDRs).
   - `MetaModel()` defaults (from the `metamodel` package) give: 10 core NFs (`amf`, `ausf`, `bsf`, `nssf`, `nrf`, `pcf`, `smf`, `upf`, `udm`, `udr`), one `gnb`, a simulated RU `sim_ru`, a containerized UE `sim_ue`, slice `internet`, and one `ric`. gNB/DU and UE configs reference `sim_ru` by default.
2. **Lookup tables in `orchestrator/utils/defaults.py`.**
   - `DEFAULT_*_IMAGES` is keyed by implementation, then type (and RU type for RAN).
   - `DEFAULT_CORE_DATABASE_IMAGES`.
   - `*_POD_PRIVILEGES`.
   - These are applied during reconciliation **only if the field is still `None`**.
3. **Values filled in during reconciliation.**
   - Namespace defaults to `<implementation>-<category>`.
   - Node-selector labels use `params.k8s.label_selection_base`.
   - Static pod IPs are generated for UPF, CU, CU-CP, CU-UP, DU and gNB.
   - The NRF URI is computed.
4. `to_yaml()` drops defaults, so saved YAML files are sparse.

### Implementation-specific configuration

- Meta-model `config` is generic and the same whatever the implementation.
- Deployment-side `advanced_config` is validated against `ADVANCED_{CORE,RAN,RIC,UE}_CONFIG_MAPPING[implementation][type]`. If there is no mapping, the empty strict `Generic*AdvancedConfig` is used, which rejects every field.
- `plain_text_config` holds raw config-file content.
- `derived_radio_config` (RAN gNB/DU and UE) is **computed** by `utils/radio.py` (`RAN_CONFIG_DERIVATOR`, `UE_CONFIG_DERIVATOR`). Do not set it by hand.
- K8s-level escape hatches on every component: `custom_chart_path`, `custom_rendered_files`, `extra_env_vars`, `custom_entrypoint_command`, `image`, `resources`, `multus`, `node_selector` and `affinity`.

### Management units (`orchestrator.deployment`)

All managers extend `BaseManagement`. Their action methods are **async** and long-running, because each one runs Ansible.

| Manager | Main public methods |
|---|---|
| `BaseManagement` | `__init__(preceding= \| metamodel=+deployment_model= \| metamodel_file=+deployment_model_file= \| merged= \| merged_file=)`, `reconcile()`, `synchronize()`, `output()`, `output_merged()`, `get_ansible_inventory()`. Attributes: `metamodel`, `deployment_model`, `mutable_metamodel` |
| `ProvisioningManagement` | `provision`, `unprovision`, `reserve` (plus `_nodes`, `_rus`, `_ues` variants), `run_command`, `run_node_command`, `run_ue_command`, `copy`, `node_copy`, `ue_copy` |
| `K8SManagement` | `prepare`, `create(master_node)`, `join`, `deploy(nodes)` (prepare → create → join → wait), `remove` |
| `HelmManagement` (base of the four below) | `add_component`, `remove_component`, `prepare`, `install`, `uninstall`, `deploy` (prepare + install), `remove`, `get_logs`, `run_command`, `copy` |
| `CoreManagement` | Adds `run_database_action`, `register_ues`, `unregister_ues`. `deploy` = prepare DB and NFs → install DB → install NFs in dependency order → register UEs |
| `RANManagement` | Installs in dependency order: CU, CU-CP and CU-UP before DU, and CU-CP before CU-UP |
| `RICManagement` | Installs in dependency order. For `oran_sc` it also creates the xApp namespace |
| `UEManagement` | Helm actions for containerized UEs. `connect` and `disconnect` for COTS UEs |
| `Miscellaneous` | `run_playbook` (custom Ansible on deployment resources) |

Common keyword arguments: `components` / `nodes` / `resources` (a subset filter), `node` (where Helm runs; defaults to the K8s master), `force`, `ignore_invalid_states` (default `True`, so an invalid action is **silently skipped**), `ignore_failures`, `quiet`.

Typical pipeline (from `examples/tutorials`): `ProvisioningManagement` → `K8SManagement(preceding=prov)` → `CoreManagement(preceding=k8s)` → [`RICManagement`] → `RANManagement` → `UEManagement`. Save `manager.metamodel` and `manager.deployment_model` (for example with `to_yaml_file`) after each step. Adding a UE to a running network means `CoreManagement.register_ues` before `UEManagement.deploy`.

### Reconciliation

This runs automatically in every manager's `__init__`, and again after `add_component`.

1. `synchronize()` matches the deployment-model component keys to the meta-model: it adds missing entries with defaults, removes extra ones, and re-validates the `DeploymentModel`.
2. The category-specific `reconcile()` calls `utils/{core,ran,ric,ue}.py::reconcile_*`. These resolve cross-references (slices, AMF, NRF URI, RIC, RU, gNB, CU↔DU, UPF↔SMF) on **`mutable_metamodel`**. The original `metamodel` stays unresolved. They also run `reconcile_5g_component` (images, namespace, labels, privileges, static IPs, exposed endpoints) and derive radio settings.
3. **Readiness checks** (`resolve_component_reference(ready_attribute=…)`). These mean the pipeline order is enforced when a manager is *created*, not only when it deploys:
   - A RAN gNB, CU or CU-CP that references an AMF requires that AMF to have `is_installed=True`.
   - A RAN component that sets `ric` requires that RIC component to be installed.
   - A gNB, DU or containerized UE that references a non-simulated RU requires it to have `is_provisioned=True`. Simulated RUs always count as provisioned.
   - So `RANManagement` and `UEManagement` cannot be created before the core is deployed, because both reconcile the RAN.
4. Errors raised here:
   - pydantic `ValidationError`;
   - `ReferenceNotFoundError` and `InvalidResourceStateError` (both in `orchestrator.utils.utils`);
   - `ValueError` (for example no image);
   - `RuntimeError` (for example no NRF).

### How actions are executed

- `utils/ansible.py` runs the roles in `orchestrator/ansible/roles/` through `ansible_runner.run_async` in a worker thread. The roles are `helm/*`, `k8s/*`, `provisioning/{pos,legacy_pos,bi,unified_radio,r2lab}/*` and `database/subscriber/{add,remove}/{oai,open5gs,free5gc}`.
- Helm actions run over SSH on the K8s master node, using `nodes[*].ssh_info`. Charts are rendered there from Jinja templates (`ansible/roles/helm/prepare/templates/<category>/<impl>/<impl>-<type>/`).
- Run artefacts and logs go to `params.ansible.runner_path/<category>/<name>/helm/<action>/<timestamp>/`. The default root is `~/post-5g/ansible-runner`.
- Components run in parallel within a dependency level and the levels run one after another (`resolve_component_dependency_levels`).
- On success, the action updates the deployment model in place (`is_installed`, `network_info`, …). No progress callbacks exist: output goes to stdout unless `quiet=True`.

### What does not exist (do not assume it does)

- No user modes, levels or profiles. `advanced_config` means implementation-specific settings, not an "advanced user" mode.
- No HTTP or REST API, CLI, server, job queue, authentication, database or persistence layer. The caller saves the YAML or JSON files.
- No test suite. CI only builds and runs `ruff check`.

---

## [PROPOSED] Guidance for the web application

These are constraints for the design, not existing features. Confirm anything beyond this with the user.

- **Reuse, don't rewrite.**
  - Build on `MetaModel` and `DeploymentModel` for all input, validation and storage.
  - Use the `*Management` classes for every action.
  - Use the `*Implementation` enums, `SUPPORTED_*_COMPONENTS` and `ADVANCED_*_CONFIG_MAPPING` to fill UI choices.
  - Use `utils/defaults.py` only to *display* defaults.
  - Do not re-implement reference resolution, defaults, dependency ordering, Ansible calls or (de)serialization.
- **The backend should be Python ≥ 3.12** so it can import the orchestrator directly. Depend on `../orchestrator` as a package (editable or path dependency) and match its pinned `pydantic` and `metamodel` versions. Never vendor a copy.
- **State unit = one (`MetaModel`, `DeploymentModel`) pair per deployment.**
  - Save both after every action and after creating a manager: reconciliation assigns random static IPs, so recomputing would give different results.
  - Build each next manager with `preceding=` or from the saved pair.
- **Validation.** Return pydantic `ValidationError` details, and reconciliation errors, to the frontend as they are.
  - Validating the two models runs schema checks.
  - Creating a manager also runs reconciliation without deploying anything.
  - The readiness checks mean a RAN or UE manager cannot be created until the core (and any referenced RIC or real RU) is installed or provisioned. Pre-deployment validation of RAN/UE references therefore needs the model-level checks, not a manager.
- **Forms.**
  - `model_json_schema()` on the models can drive forms.
  - `advanced_config` is typed `Any`, so get its schema from `ADVANCED_*_CONFIG_MAPPING[impl][type]` instead.
- **Long-running async actions** (minutes) must run outside the request cycle. Allow only one action at a time per deployment, because managers mutate the deployment model without locking.
- **Secrets.** Deployment models can hold `SSHInfo.password`, `sudo_password`, provisioner tokens and R2Lab credentials. Never expose them unredacted to the browser or in logs.
- **Logs and progress.** The orchestrator has no event hooks. Streaming would mean reading the ansible-runner artefact directories or capturing stdout. Agree on the approach with the user first.

---

## Known quirks and uncertainties in the orchestrator (report them; don't fix them here)

- The `metamodel` package is only available installed in `../orchestrator/.venv-1` (no source repo in `post-5g`). It was checked there: `MetaModel()`, `DeploymentModel()` and Core → RAN → UE reconciliation all work with the defaults.
- `BaseManagement.__init__` checks `merged_file_type` instead of `metamodel_file_type` / `deployment_model_file_type` when loading YAML. Prefer loading the models yourself and passing `metamodel=` and `deployment_model=`.
- `ADVANCED_CORE_CONFIG_MAPPING[OAI][UDR]` points to `OAIAdvancedLMFConfig`. `OAIAdvancedUDRConfig` is unused.
- `Open5GSAdvancedUPFConfig.teid_range_indication` is required, so any Open5GS UPF `advanced_config` must include it.
- The RIC's place in the pipeline (before the RAN) is inferred from `examples/ric/*/output/` and from the RAN resolving RIC references.
