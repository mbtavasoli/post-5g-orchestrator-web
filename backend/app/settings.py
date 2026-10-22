"""Backend configuration."""

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def default_data_dir() -> Path:
    """Return the repository-local runtime data directory."""
    return Path(__file__).resolve().parents[2] / "data"


class Settings(BaseSettings):
    """Runtime settings loaded from POST5G-prefixed environment variables."""

    model_config = SettingsConfigDict(env_prefix="POST5G_")

    data_dir: Path = Field(default_factory=default_data_dir)
    host: str = "127.0.0.1"
    port: int = 8000
