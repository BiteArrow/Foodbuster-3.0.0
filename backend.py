"""Foodbuster entry point: python backend.py (code in foodbuster/, pages in web/, configuration in settings.py)."""

from foodbuster.main import app, run

__all__ = ["app", "run"]

if __name__ == "__main__":
    run()
