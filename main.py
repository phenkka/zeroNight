from collections import Counter
import json
import os
import time
import uuid

from fastapi import FastAPI, HTTPException, Request, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import redis
from wordfreq import zipf_frequency

app = FastAPI()

WORDS = [
    "TRUCK",
    "COMBINE",
    "TRIAL",
    "REVIEW",
    "RESEMBLE",
    "SPICE",
    "QUEUE",
    "LUCKY",
    "PLANE",
    "RADAR",
    "IMPROVE",
    "EXCESS",
]

MAX_ATTEMPTS = 6

BOT_DURATION_SECONDS = int(os.getenv("BOT_DURATION_SECONDS", str(60 * 60)))

COOLDOWN_SECONDS = 3
STATE_TTL_SECONDS = 12 * 60 * 60

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
_redis_client: redis.Redis | None = None


class GuessRequest(BaseModel):
    level: int
    guess: str


def score_guess(answer: str, guess: str) -> list[str]:
    n = len(answer)
    result: list[str] = ["absent"] * n
    used = [False] * n

    for i in range(n):
        if guess[i] == answer[i]:
            result[i] = "correct"
            used[i] = True

    remaining = Counter(answer[i] for i in range(n) if not used[i])

    for i in range(n):
        if result[i] == "correct":
            continue
        ch = guess[i]
        if remaining.get(ch, 0) > 0:
            result[i] = "present"
            remaining[ch] -= 1

    return result


def _player_id(request: Request) -> str:
    return request.cookies.get("sid") or (request.client.host if request.client else "unknown")


def _redis() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.Redis.from_url(
            REDIS_URL,
            decode_responses=True,
            socket_timeout=2,
            socket_connect_timeout=2,
            retry_on_timeout=True,
        )
    return _redis_client


def _rk(*parts: str) -> str:
    return ":".join(("wn",) + parts)


def _bot_start_epoch_seconds(r: redis.Redis, now: int) -> int:
    key = _rk("bot", "start")
    start = r.get(key)
    if start is None:
        r.set(key, str(now), nx=True)
        start = r.get(key)
    return int(start or now)


def _bot_solved_count(r: redis.Redis, total_levels: int, now: int) -> int:
    start = _bot_start_epoch_seconds(r, now)
    elapsed = max(0, now - start)
    duration = max(1, int(BOT_DURATION_SECONDS))
    frac = min(1.0, elapsed / float(duration))

    progress_key = _rk("bot", "progress")
    stored_raw = r.get(progress_key)
    stored = 0.0
    if stored_raw is not None:
        try:
            stored = float(stored_raw)
        except ValueError:
            stored = 0.0

    frac = max(stored, frac)
    if frac > stored:
        r.set(progress_key, str(frac))

    return min(total_levels, int(frac * total_levels))


def _redis_touch_player(r: redis.Redis, pid: str) -> None:
    r.expire(_rk("p", pid, "solved"), STATE_TTL_SECONDS)
    r.expire(_rk("p", pid, "att"), STATE_TTL_SECONDS)


def _player_solved_set(r: redis.Redis, pid: str) -> set[int]:
    raw = r.smembers(_rk("p", pid, "solved"))
    out: set[int] = set()
    for x in raw:
        try:
            out.add(int(x))
        except ValueError:
            continue
    return out


def _level_attempts_key(pid: str, level: int) -> str:
    return _rk("p", pid, "lvl", str(level), "attempts")


def _next_unlocked_level_for(solved: set[int]) -> int:
    for level in range(1, len(WORDS) + 1):
        if level not in solved:
            return level
    return len(WORDS) if WORDS else 1


def _cooldown_retry_after(r: redis.Redis, sid: str | None, ip: str) -> int:
    keys: list[str] = []
    if sid:
        keys.append(_rk("cd", "sid", sid))
    keys.append(_rk("cd", "ip", ip))

    pipe = r.pipeline()
    for k in keys:
        pipe.ttl(k)
    ttls = pipe.execute()

    best = 0
    for ttl in ttls:
        if isinstance(ttl, int) and ttl > best:
            best = ttl
    return best


def _try_set_cooldown_locks(r: redis.Redis, sid: str | None, ip: str) -> bool:
    ok = True
    if sid:
        if not r.set(_rk("cd", "sid", sid), "1", nx=True, ex=COOLDOWN_SECONDS):
            ok = False
    if not r.set(_rk("cd", "ip", ip), "1", nx=True, ex=COOLDOWN_SECONDS):
        ok = False
    return ok


@app.middleware("http")
async def ensure_sid_cookie(request: Request, call_next):
    response = await call_next(request)
    if "sid" not in request.cookies:
        response.set_cookie(
            "sid",
            uuid.uuid4().hex,
            httponly=True,
            samesite="lax",
        )
    return response


@app.get("/")
def index():
    return FileResponse("static/index.html")


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/levels")
def get_levels():
    return {
        "total": len(WORDS),
        "levels": [
            {"level": i + 1, "length": len(word), "max_attempts": MAX_ATTEMPTS}
            for i, word in enumerate(WORDS)
        ],
    }


@app.get("/api/state")
def get_state(request: Request, full: bool = Query(False)):
    pid = _player_id(request)
    total = len(WORDS)
    now = int(time.time())

    try:
        r = _redis()
        solved_set = _player_solved_set(r, pid)
        _redis_touch_player(r, pid)

        bot_solved = _bot_solved_count(r, total, now)
        bot_seconds_left = max(0, BOT_DURATION_SECONDS - (now - _bot_start_epoch_seconds(r, now)))
    except redis.RedisError:
        raise HTTPException(status_code=503, detail="State store unavailable")

    bot_finished = bot_solved >= total

    resp = {
        "player": {"solved_levels": sorted(solved_set)},
        "bot": {
            "solved": bot_solved,
            "total": total,
            "seconds_left": bot_seconds_left,
            "finished": bot_finished,
        },
    }

    if full:
        resp["total"] = total
        resp["levels"] = [
            {"level": i + 1, "length": len(word), "max_attempts": MAX_ATTEMPTS}
            for i, word in enumerate(WORDS)
        ]

    return resp


@app.get("/api/level_state")
def get_level_state(request: Request, level: int = Query(...)):
    if level < 1 or level > len(WORDS):
        raise HTTPException(status_code=400, detail="Invalid level")

    pid = _player_id(request)
    now = int(time.time())

    try:
        r = _redis()
        solved_set = _player_solved_set(r, pid)
        next_unlocked = _next_unlocked_level_for(solved_set)
        if level > next_unlocked and level not in solved_set:
            raise HTTPException(status_code=403, detail="Locked level")

        key = _level_attempts_key(pid, level)
        raw = r.lrange(key, 0, -1)
        attempts: list[dict] = []
        for item in raw:
            try:
                attempts.append(json.loads(item))
            except Exception:
                continue

        _redis_touch_player(r, pid)
        r.expire(key, STATE_TTL_SECONDS)

        total = len(WORDS)
        bot_solved = _bot_solved_count(r, total, now)
        bot_seconds_left = max(0, BOT_DURATION_SECONDS - (now - _bot_start_epoch_seconds(r, now)))
    except redis.RedisError:
        raise HTTPException(status_code=503, detail="State store unavailable")

    return {
        "level": level,
        "max_attempts": MAX_ATTEMPTS,
        "attempts": attempts,
        "solved": level in solved_set,
        "bot": {
            "solved": bot_solved,
            "total": len(WORDS),
            "seconds_left": bot_seconds_left,
            "finished": bot_solved >= len(WORDS),
        },
    }


@app.post("/api/guess")
def guess(req: GuessRequest, request: Request):
    sid = request.cookies.get("sid")
    ip = request.client.host if request.client else "unknown"

    now = int(time.time())
    pid = _player_id(request)
    if req.level < 1 or req.level > len(WORDS):
        raise HTTPException(status_code=400, detail="Invalid level")

    answer = WORDS[req.level - 1]
    guess_str = (req.guess or "").strip().upper()

    if not guess_str.isalpha():
        raise HTTPException(status_code=400, detail="Guess must contain only letters")

    if len(guess_str) != len(answer):
        raise HTTPException(status_code=400, detail="Invalid guess length")

    try:
        r = _redis()

        # If the player is already on cooldown (from a previous valid guess), block early.
        retry_after = _cooldown_retry_after(r, sid, ip)
        if retry_after > 0:
            raise HTTPException(
                status_code=429,
                detail={"error": "cooldown", "retry_after": retry_after},
                headers={"Retry-After": str(retry_after)},
            )

        total = len(WORDS)
        if _bot_solved_count(r, total, now) >= total:
            raise HTTPException(status_code=403, detail="AI finished")

        solved_set = _player_solved_set(r, pid)
        if req.level in solved_set:
            raise HTTPException(status_code=409, detail="Already solved")
        if req.level != _next_unlocked_level_for(solved_set):
            raise HTTPException(status_code=403, detail="Locked level")

        used_raw = r.hget(_rk("p", pid, "att"), str(req.level))
        used = int(used_raw or 0)
        if used >= MAX_ATTEMPTS:
            raise HTTPException(status_code=403, detail="No attempts left")

        _redis_touch_player(r, pid)
    except redis.RedisError:
        raise HTTPException(status_code=503, detail="State store unavailable")

    # Basic dictionary check (English). zipf_frequency == 0.0 means unknown word.
    if zipf_frequency(guess_str.lower(), "en") <= 0.0:
        raise HTTPException(status_code=400, detail="Not in word list")

    try:
        # Set cooldown only after the guess is structurally valid and passes dictionary check.
        if not _try_set_cooldown_locks(r, sid, ip):
            retry_after = _cooldown_retry_after(r, sid, ip)
            raise HTTPException(
                status_code=429,
                detail={"error": "cooldown", "retry_after": retry_after if retry_after > 0 else COOLDOWN_SECONDS},
                headers={"Retry-After": str(retry_after if retry_after > 0 else COOLDOWN_SECONDS)},
            )
    except redis.RedisError:
        raise HTTPException(status_code=503, detail="State store unavailable")

    try:
        r.hincrby(_rk("p", pid, "att"), str(req.level), 1)
        _redis_touch_player(r, pid)
    except redis.RedisError:
        raise HTTPException(status_code=503, detail="State store unavailable")

    result = score_guess(answer, guess_str)

    is_correct = all(r == "correct" for r in result)
    if is_correct:
        try:
            r.sadd(_rk("p", pid, "solved"), str(req.level))
            _redis_touch_player(r, pid)
        except redis.RedisError:
            raise HTTPException(status_code=503, detail="State store unavailable")

    try:
        r.rpush(
            _level_attempts_key(pid, req.level),
            json.dumps({"guess": guess_str, "result": result, "is_correct": is_correct}),
        )
        r.expire(_level_attempts_key(pid, req.level), STATE_TTL_SECONDS)
    except redis.RedisError:
        raise HTTPException(status_code=503, detail="State store unavailable")

    return {
        "level": req.level,
        "guess": guess_str,
        "result": result,
        "is_correct": is_correct,
    }


app.mount("/static", StaticFiles(directory="static"), name="static")
