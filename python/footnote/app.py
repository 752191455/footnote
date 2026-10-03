from __future__ import annotations

import json
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import Cookie, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .engine import ActionError, Store, now_ms
from .trivia import normalize_room_code

STATIC = Path(__file__).parent / "static"
store = Store()
http: httpx.AsyncClient | None = None
sockets: dict[str, set[WebSocket]] = {}


async def _broadcast(game_id: str) -> None:
    living: set[WebSocket] = set()
    for ws in list(sockets.get(game_id, ())):
        try:
            game = store.games[game_id]
            user_id = getattr(ws.state, "user_id", "")
            await ws.send_text(json.dumps({"type": "state", "data": store.public_snapshot(game, user_id)}))
            living.add(ws)
        except Exception:
            pass
    sockets[game_id] = living


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global http
    http = httpx.AsyncClient()
    store.broadcast = _broadcast
    yield
    await http.aclose()


app = FastAPI(title="Footnote (Python)", lifespan=lifespan)
app.mount("/assets", StaticFiles(directory=STATIC), name="assets")


def identity(response: Response, session: str | None, name: str | None = None) -> tuple[str, str]:
    user_id = session or uuid.uuid4().hex
    if not session:
        response.set_cookie("session", user_id, httponly=True, samesite="lax")
    display = (name or "").strip()[:40] or "Player"
    if name:
        response.set_cookie("display_name", display, samesite="lax")
    return user_id, display


def require_user(request: Request) -> str:
    user_id = request.cookies.get("session")
    if not user_id:
        raise HTTPException(status_code=401, detail="Sign in with a name first.")
    return user_id


class SessionBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class CreateBody(BaseModel):
    topic: str
    questionCount: int = 8
    secondsPerQuestion: int = 20
    name: str = "Player"


class JoinBody(BaseModel):
    code: str
    name: str = "Player"


class StartBody(BaseModel):
    gameId: str


class SubmitBody(BaseModel):
    gameId: str
    index: int
    choice: int


class RevealBody(BaseModel):
    gameId: str
    index: int


class NextBody(BaseModel):
    gameId: str
    fromIndex: int | None = None


@app.get("/")
async def home() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/play/{code}")
async def play(_code: str) -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.post("/api/session")
async def session(body: SessionBody, response: Response, session: str | None = Cookie(default=None)) -> dict[str, str]:
    user_id, name = identity(response, session, body.name)
    return {"userId": user_id, "name": name}


@app.get("/api/time")
async def server_time() -> dict[str, int]:
    return {"now": now_ms()}


def ok(data: Any) -> dict[str, Any]:
    return {"success": True, "data": data}


def fail(err: ActionError) -> HTTPException:
    return HTTPException(status_code=400, detail=err.message)


@app.post("/api/actions/createGame")
async def create_game(
    body: CreateBody,
    response: Response,
    session: str | None = Cookie(default=None),
    display_name: str | None = Cookie(default=None),
) -> dict[str, Any]:
    user_id, name = identity(response, session, body.name or display_name)
    assert http is not None
    try:
        game = await store.create_game(user_id, name, body.topic, body.questionCount, body.secondsPerQuestion, http)
    except ActionError as err:
        raise fail(err) from err
    return ok({"gameId": game.id, "code": game.code})


@app.post("/api/actions/joinGame")
async def join_game(
    body: JoinBody,
    response: Response,
    session: str | None = Cookie(default=None),
    display_name: str | None = Cookie(default=None),
) -> dict[str, Any]:
    user_id, name = identity(response, session, body.name or display_name)
    try:
        game = await store.join(body.code, user_id, name)
    except ActionError as err:
        raise fail(err) from err
    return ok({"gameId": game.id, "code": game.code})


@app.post("/api/actions/startGame")
async def start_game(body: StartBody, request: Request) -> dict[str, Any]:
    try:
        game = await store.start(body.gameId, require_user(request))
    except ActionError as err:
        raise fail(err) from err
    return ok({"status": game.status})


@app.post("/api/actions/submitAnswer")
async def submit_answer(body: SubmitBody, request: Request) -> dict[str, Any]:
    try:
        await store.submit(body.gameId, require_user(request), body.index, body.choice)
    except ActionError as err:
        raise fail(err) from err
    return ok({"ok": True})


@app.post("/api/actions/revealQuestion")
async def reveal_question(body: RevealBody, request: Request) -> dict[str, Any]:
    try:
        await store.reveal(body.gameId, require_user(request), body.index)
    except ActionError as err:
        raise fail(err) from err
    return ok({"revealed": True})


@app.post("/api/actions/nextQuestion")
async def next_question(body: NextBody, request: Request) -> dict[str, Any]:
    try:
        game = await store.next_question(body.gameId, require_user(request), body.fromIndex)
    except ActionError as err:
        raise fail(err) from err
    return ok({"status": game.status})


@app.get("/api/games/{code}")
async def get_game(code: str, request: Request) -> dict[str, Any]:
    user_id = request.cookies.get("session") or ""
    game = store.game_by_code(normalize_room_code(code))
    if not game:
        raise HTTPException(status_code=404, detail=f"No game with code {normalize_room_code(code)}.")
    return store.public_snapshot(game, user_id)


@app.websocket("/ws/{code}")
async def ws_room(websocket: WebSocket, code: str) -> None:
    await websocket.accept()
    user_id = websocket.cookies.get("session") or uuid.uuid4().hex
    websocket.state.user_id = user_id
    game = store.game_by_code(normalize_room_code(code))
    if not game:
        await websocket.send_text(json.dumps({"type": "error", "error": "not_found"}))
        await websocket.close()
        return
    sockets.setdefault(game.id, set()).add(websocket)
    store.presence(game.id, user_id, True)
    await websocket.send_text(json.dumps({"type": "state", "data": store.public_snapshot(game, user_id)}))
    await _broadcast(game.id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        sockets.get(game.id, set()).discard(websocket)
        store.presence(game.id, user_id, False)
        await _broadcast(game.id)
