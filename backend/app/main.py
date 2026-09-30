from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api.routes import install_error_handlers, router
from .persistence.db import database_url, init_db, make_engine, make_sessionmaker

FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


def create_app(db_url: str | None = None, seed: bool | None = None) -> FastAPI:
    engine = make_engine(db_url or database_url())
    init_db(engine)
    sessionmaker = make_sessionmaker(engine)

    if seed if seed is not None else os.environ.get("TRACKER_SEED", "1") == "1":
        from .seed import seed as seed_db

        with sessionmaker() as session, session.begin():
            seed_db(session)

    app = FastAPI(title="Backstroke — Project Deliverables Tracker", version="0.1.0")
    app.state.engine = engine
    app.state.sessionmaker = sessionmaker
    app.include_router(router)
    install_error_handlers(app)

    # Serve the built UI when present, so `npm run build` + uvicorn is a one-process deployment.
    if FRONTEND_DIST.is_dir():
        app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            candidate = FRONTEND_DIST / path
            if path and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(FRONTEND_DIST / "index.html")

    return app


app = create_app()
