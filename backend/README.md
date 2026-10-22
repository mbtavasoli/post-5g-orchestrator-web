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

## Test

```bash
.venv/bin/pytest
.venv/bin/ruff check .
```

