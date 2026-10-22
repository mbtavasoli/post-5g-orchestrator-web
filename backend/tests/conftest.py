"""Shared backend test fixtures."""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings


@pytest.fixture
def client(tmp_path) -> Iterator[TestClient]:
    """Return a client with an isolated file store."""
    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


@pytest.fixture
def create_default(client: TestClient):
    """Create a default deployment and return its response."""

    def create(name: str = "default"):
        return client.post(
            "/api/deployments",
            json={"name": name, "metamodel": None, "deployment_model": None},
        )

    return create
