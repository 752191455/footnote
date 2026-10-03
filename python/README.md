# Footnote (Python port)

Standalone rewrite of the DeepSpace Footnote trivia app. **The TypeScript app at https://testproject.app.space is unchanged** — DeepSpace Workers are not Python, so this lives beside it rather than replacing it.

Same product loop: host a topic → Wikipedia grounding → questions → live room → timed answers → cited reveal.

## Run

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

Open http://localhost:8000

Optional: `export ANTHROPIC_API_KEY=...` so Claude Haiku writes the questions (same prompt as the DeepSpace job). Without a key, questions are extracted from Wikipedia sentences (years and numbers).

## Mapping

| DeepSpace | Python |
|---|---|
| RecordRoom + RBAC | In-memory `Store` with an asyncio lock; answer keys never leave the server |
| Server actions | FastAPI `/api/actions/*` |
| JobRoom + `useJobs` | `asyncio.create_task` + progress fields on the game |
| PresenceRoom | WebSocket connect/disconnect set |
| Wikipedia / Anthropic integrations | Direct `httpx` calls |

Sessions are a cookie plus a display name (no DeepSpace auth). State is not durable across process restart.

## Tests

```bash
cd python
python -m pytest tests/test_trivia.py -q
```
