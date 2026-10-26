# Post-5G orchestrator web backend

This directory contains backend v1: a local-only FastAPI service that validates,
stores, and reconciles deployment configurations through the existing
`orchestrator` and `metamodel` packages.

## Setup

From this directory, create a dedicated environment and install the orchestrator
as a regular local package. The extra index supplies its pinned `metamodel`
dependency.

```bash
python3.13 -m venv .venv
.venv/bin/pip install ../../orchestrator \
  --extra-index-url=https://gitlab.inria.fr/api/v4/projects/70914/packages/pypi/simple
.venv/bin/pip install -e '.[dev]'
```

Re-run the first install command after changing or updating the orchestrator.
Do not install the orchestrator in editable mode: its packaged Ansible role paths
depend on a regular installation.

## Run

```bash
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The data directory defaults to `../data` at the repository root. Settings may be
overridden with `POST5G_DATA_DIR`, `POST5G_HOST`, and `POST5G_PORT`.

Read-only model discovery is available at `/api/schema/metamodel`,
`/api/schema/deployment-model`, `/api/options`, `/api/provider-catalogs`, and
`/api/options/advanced-config/{category}/{implementation}/{type}`.

## Deployment actions and providers

Deployments run stage by stage through the orchestrator managers (`/api/deployments/{id}/runtime`,
`/actions`, `/jobs/{job_id}`, `/jobs/{job_id}/logs`); see `docs/backend-architecture.md` §10.

- SLICES BI/POS provisioning needs the SLICES CLI on this host
  (`pip install slices-cli --extra-index-url=https://doc.slices-ri.eu/pypi/`); set
  `POST5G_SLICES_BIN_DIR` if it is not on `PATH`. Log in from the UI or with `slices auth login`.
- R2Lab credentials are entered in the UI and kept in this process's memory only; restarting
  the backend requires signing in again.
- The backend must be able to SSH to the nodes (directly or through the jump hosts in the
  deployment model), as the orchestrator does from a notebook.

## Test

```bash
.venv/bin/pytest
.venv/bin/ruff check .
```

