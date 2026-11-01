from datetime import datetime, timezone
import ipaddress
import logging
import os
import re
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import redis
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import Column, DateTime, Integer, String, Text, create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker
from openai import OpenAI
from qdrant_client import QdrantClient
from gear_catalog import GEAR_CATALOG
from fastapi.responses import FileResponse
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
import textwrap

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("outbackmind")

ENABLE_DOCS = os.getenv("ENABLE_DOCS", "0") == "1"

app = FastAPI(
    docs_url="/docs" if ENABLE_DOCS else None,
    redoc_url="/redoc" if ENABLE_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_DOCS else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://app.outbackmind.au",
        "https://api.outbackmind.au",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATABASE_URL = os.getenv("DATABASE_URL")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
QDRANT_URL = os.getenv("QDRANT_URL", "http://qdrant:6333")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")

# Rate limits for the AI endpoints (override in .env / compose environment).
RATE_LIMIT_PER_MINUTE = int(os.getenv("RATE_LIMIT_PER_MINUTE", "10"))
RATE_LIMIT_PER_DAY = int(os.getenv("RATE_LIMIT_PER_DAY", "100"))
AI_DAILY_CAP = int(os.getenv("AI_DAILY_CAP", "1000"))

if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY is not set")

client = OpenAI(api_key=OPENAI_API_KEY)
qdrant = QdrantClient(url=QDRANT_URL)
redis_client = redis.Redis.from_url(REDIS_URL, socket_timeout=2, socket_connect_timeout=2)

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

COLLECTION_NAME = "outback_knowledge"


class QuestionLog(Base):
    __tablename__ = "question_logs"

    id = Column(Integer, primary_key=True, index=True)
    question = Column(Text, nullable=False)
    answer = Column(Text, nullable=False)
    mode = Column(String(20), nullable=False, default="normal")
    client_id = Column(String(64), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

class TripPlan(Base):
    __tablename__ = "trip_plans"

    id = Column(Integer, primary_key=True, index=True)
    request = Column(Text, nullable=False)
    plan = Column(Text, nullable=False)
    client_id = Column(String(64), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

Base.metadata.create_all(bind=engine)

with engine.begin() as conn:
    conn.execute(
        text(
            "ALTER TABLE question_logs "
            "ADD COLUMN IF NOT EXISTS mode VARCHAR(20) DEFAULT 'normal'"
        )
    )
    # Anonymous per-browser owner id (nullable; old rows stay NULL = hidden from everyone).
    conn.execute(text("ALTER TABLE question_logs ADD COLUMN IF NOT EXISTS client_id VARCHAR(64)"))
    conn.execute(text("ALTER TABLE trip_plans ADD COLUMN IF NOT EXISTS client_id VARCHAR(64)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_question_logs_client_id ON question_logs (client_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_trip_plans_client_id ON trip_plans (client_id)"))


def get_client_ip(request: Request) -> str:
    """Real client IP. The API is only reachable through Caddy (no published port),
    and Caddy overwrites X-Forwarded-For with the real client address, so only trust
    X-Forwarded-For when the direct peer is a private (Docker network) address."""
    peer = request.client.host if request.client else ""
    try:
        peer_is_private = ipaddress.ip_address(peer).is_private
    except ValueError:
        peer_is_private = False
    xff = request.headers.get("x-forwarded-for", "")
    if peer_is_private and xff:
        candidate = xff.split(",")[-1].strip()
        try:
            ipaddress.ip_address(candidate)
            return candidate
        except ValueError:
            pass
    return peer or "unknown"


def get_client_id(request: Request):
    raw = request.headers.get("x-client-id") or request.query_params.get("client_id") or ""
    try:
        return str(uuid.UUID(raw.strip()))
    except (ValueError, AttributeError):
        return None


class RateLimited(Exception):
    def __init__(self, message: str):
        self.message = message


@app.exception_handler(RateLimited)
def rate_limited_handler(request: Request, exc: RateLimited):
    return JSONResponse(status_code=429, content={"detail": exc.message})


def enforce_ai_rate_limit(request: Request):
    """Per-IP (per minute + per day) and global daily cap on AI calls, stored in Redis.
    Fails open (with a log line) if Redis is unavailable so the app keeps working."""
    ip = get_client_ip(request)
    now = datetime.now(timezone.utc)
    minute_key = f"rl:ip:{ip}:m:{now:%Y%m%d%H%M}"
    day_key = f"rl:ip:{ip}:d:{now:%Y%m%d}"
    global_key = f"rl:global:d:{now:%Y%m%d}"
    try:
        pipe = redis_client.pipeline()
        pipe.incr(minute_key)
        pipe.expire(minute_key, 120)
        pipe.incr(day_key)
        pipe.expire(day_key, 172800)
        pipe.get(global_key)
        minute_count, _, day_count, _, global_count = pipe.execute()
    except redis.RedisError:
        logger.exception("Rate limiter unavailable (Redis); allowing request")
        return
    if minute_count > RATE_LIMIT_PER_MINUTE:
        raise RateLimited("You're going a bit fast. Please wait a minute and try again.")
    if day_count > RATE_LIMIT_PER_DAY:
        raise RateLimited("You've reached today's limit for AI requests. Please come back tomorrow.")
    if int(global_count or 0) >= AI_DAILY_CAP:
        logger.warning("Global daily AI cap reached (%s)", AI_DAILY_CAP)
        raise RateLimited("OutbackMind is very busy today. Please try again tomorrow.")
    try:
        pipe = redis_client.pipeline()
        pipe.incr(global_key)
        pipe.expire(global_key, 172800)
        pipe.execute()
    except redis.RedisError:
        logger.exception("Could not update global AI counter")


GENERIC_ERROR = "Sorry, something went wrong on our side. Please try again in a moment."


class Question(BaseModel):
    question: str
    mode: str = "normal"

class TripPlanRequest(BaseModel):
    request: str


@app.get("/")
def root():
    return {"message": "OutbackMind API is running"}


@app.get("/health")
def health():
    checks = {}
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:
        logger.exception("Health check: database failed")
        checks["database"] = "error"
    try:
        qdrant.get_collection(COLLECTION_NAME)
        checks["qdrant"] = "ok"
    except Exception:
        logger.exception("Health check: qdrant failed")
        checks["qdrant"] = "error"
    try:
        redis_client.ping()
        checks["redis"] = "ok"
    except Exception:
        logger.exception("Health check: redis failed")
        checks["redis"] = "error"
    healthy = checks["database"] == "ok" and checks["qdrant"] == "ok"
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={"status": "ok" if healthy else "degraded", "checks": checks},
    )


def get_embedding(text_value: str):
    response = client.embeddings.create(
        model="text-embedding-3-small",
        input=text_value
    )
    return response.data[0].embedding


def retrieve_context(question: str, limit: int = 3) -> str:
    query_vector = get_embedding(question)

    response = qdrant.query_points(
        collection_name=COLLECTION_NAME,
        query=query_vector,
        limit=limit,
    )

    chunks = []
    for item in response.points:
        payload = item.payload or {}
        text_value = payload.get("text", "")
        if text_value:
            chunks.append(text_value)

    return "\n\n".join(chunks)


def normalize_text(text_value: str) -> str:
    text_value = text_value.lower()
    text_value = text_value.replace("**", " ")
    text_value = re.sub(r"[^a-z0-9\s\-\+]", " ", text_value)
    text_value = re.sub(r"\s+", " ", text_value).strip()
    return text_value


def find_recommended_gear(question_text: str, answer_text: str):
    matches = []
    searchable = normalize_text(question_text + " " + answer_text)

    for item in GEAR_CATALOG:
        for keyword in item["keywords"]:
            normalized_keyword = normalize_text(keyword)
            if normalized_keyword in searchable:
                matches.append({
                    "name": item["name"],
                    "url": item["url"],
                    "category": item["category"],
                })
                break

    seen = set()
    unique_matches = []
    for item in matches:
        if item["name"] not in seen:
            seen.add(item["name"])
            unique_matches.append(item)

    return unique_matches


def generate_ai_answer(user_question: str, mode: str = "normal") -> str:
    retrieved_context = retrieve_context(user_question)

    if mode == "emergency":
        system_prompt = (
            "You are OutbackMind Emergency Mode, an Australian remote safety assistant.\n\n"
            "Your job is to give urgent, practical, safety-first responses for Australia.\n\n"
            "Rules:\n"
            "- Start with the most important action immediately.\n"
            "- Use short numbered steps.\n"
            "- Prioritise life safety over explanation.\n"
            "- Mention emergency services or official warnings when appropriate.\n"
            "- Do not add unnecessary background before critical actions.\n"
            "- Be calm, direct, and easy to follow under stress.\n"
            "- If the situation could be life-threatening, clearly say so.\n"
            "- Only include gear recommendations if they are critical for survival or prevention.\n"
        )

        user_prompt = f"""
User question:
{user_question}

Retrieved Outback knowledge:
{retrieved_context}

Write the answer in this structure:

🚨 Immediate Actions
1. ...
2. ...
3. ...

⚠️ Important Warnings
- ...
- ...

🛒 Critical Gear (if relevant)
- ...

📍 Next Step
- ...

Keep it concise and practical.
Only include gear if it is truly critical.
"""
    else:
        system_prompt = (
            "You are OutbackMind, an expert Australian camping, caravan, and remote travel assistant.\n\n"
            "You help users with planning, gear, safety, survival, and caravan travel in Australia.\n\n"
            "Rules:\n"
            "- Use the retrieved Outback knowledge when relevant.\n"
            "- Be practical, realistic, and tailored to Australian conditions.\n"
            "- Structure answers clearly with headings and bullet points.\n"
            "- Prioritise useful steps over generic explanation.\n"
            "- Mention key risks like heat, distance, wildlife, road conditions, and limited communications when relevant.\n"
            "- Keep the tone clear, helpful, and confident.\n"
            "- When relevant, include a section called '🛒 Recommended Gear (Australia)'.\n"
            "- Recommend only 3–5 practical, realistic items.\n"
            "- Focus on safety, reliability, and real Outback use.\n"
            "- Do NOT recommend unnecessary or gimmicky products.\n"
        )

        user_prompt = f"""
User question:
{user_question}

Retrieved Outback knowledge:
{retrieved_context}

Write the answer using this structure when relevant:

🧭 What To Do
- ...
- ...

🎒 What To Carry / Prepare
- ...
- ...

⚠️ Safety Notes
- ...
- ...

🛒 Recommended Gear (Australia)
- ...

📍 Extra Tip
- ...

Only include the gear section if it adds real value.
Make the answer practical and easy to scan.
"""

    response = client.responses.create(
        model="gpt-5.4",
        input=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )

    return response.output_text.strip()

def generate_trip_plan(user_request: str) -> str:
    system_prompt = (
        "You are OutbackMind, an expert Australian remote travel, camping, and caravan planning assistant.\n\n"
        "Create practical, realistic trip plans for Australia.\n\n"
        "Rules:\n"
        "- Make the plan structured and easy to follow.\n"
        "- Include route/planning considerations, gear, safety, and preparation.\n"
        "- Tailor for Australian conditions such as heat, distance, road conditions, wildlife, and communications.\n"
        "- Be practical, not generic.\n"
    )

    retrieved_context = retrieve_context(user_request)

    user_prompt = f"""
Trip planning request:
{user_request}

Retrieved Outback knowledge:
{retrieved_context}

Write the plan using this structure:

🗺️ Trip Overview
- ...

📅 Suggested Plan
Day 1:
- ...
Day 2:
- ...

🎒 Gear & Supplies
- ...

⚠️ Safety & Preparation
- ...

📍 Extra Tip
- ...
"""

    response = client.responses.create(
        model="gpt-5.4",
        input=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )

    return response.output_text.strip()
def build_trip_plan_pdf(plan_id: int, request_text: str, plan_text: str) -> str:
    output_path = f"/tmp/trip_plan_{plan_id}.pdf"

    c = canvas.Canvas(output_path, pagesize=A4)
    width, height = A4

    margin_x = 18 * mm
    top_y = height - 20 * mm
    line_height = 6 * mm

    y = top_y

    # ===== HEADER =====
    c.setFont("Helvetica-Bold", 20)
    c.drawString(margin_x, y, "OutbackMind")
    y -= 8 * mm

    c.setFont("Helvetica", 12)
    c.drawString(margin_x, y, "AI Travel Planner")
    y -= 12 * mm

    # Divider line
    c.line(margin_x, y, width - margin_x, y)
    y -= 10 * mm

    # ===== TRIP REQUEST =====
    c.setFont("Helvetica-Bold", 12)
    c.drawString(margin_x, y, "Trip Request")
    y -= 7 * mm

    c.setFont("Helvetica", 10)

    for line in textwrap.wrap(request_text, width=85):
        c.drawString(margin_x, y, line)
        y -= line_height
        if y < 20 * mm:
            c.showPage()
            y = top_y

    y -= 5 * mm

    # ===== PLAN =====
    c.setFont("Helvetica-Bold", 12)
    c.drawString(margin_x, y, "Generated Plan")
    y -= 7 * mm

    c.setFont("Helvetica", 10)

    for raw_line in plan_text.splitlines():
        wrapped_lines = textwrap.wrap(raw_line, width=90) or [""]

        for line in wrapped_lines:
            c.drawString(margin_x, y, line)
            y -= line_height

            if y < 20 * mm:
                c.showPage()
                y = top_y
                c.setFont("Helvetica", 10)

    # ===== FOOTER =====
    y -= 10 * mm

    c.setFont("Helvetica-Oblique", 9)
    c.drawString(margin_x, 15 * mm, "Generated by OutbackMind")
    c.drawString(margin_x, 10 * mm, "https://outbackmind.au")

    c.save()
    return output_path
@app.post("/ask")
def ask(question: Question, request: Request):
    enforce_ai_rate_limit(request)
    client_id = get_client_id(request)
    db = SessionLocal()
    try:
        answer_text = generate_ai_answer(question.question, question.mode)
        recommended_gear = find_recommended_gear(question.question, answer_text)

        entry = QuestionLog(
            question=question.question,
            answer=answer_text,
            mode=question.mode,
            client_id=client_id,
        )
        db.add(entry)
        db.commit()
        db.refresh(entry)

        return {
            "id": entry.id,
            "question": entry.question,
            "answer": entry.answer,
            "mode": entry.mode,
            "created_at": entry.created_at.isoformat(),
            "recommended_gear": recommended_gear,
        }
    except Exception:
        db.rollback()
        logger.exception("Request failed")
        raise HTTPException(status_code=500, detail=GENERIC_ERROR)
    finally:
        db.close()

@app.post("/plan-trip")
def plan_trip(payload: TripPlanRequest, request: Request):
    enforce_ai_rate_limit(request)
    client_id = get_client_id(request)
    db = SessionLocal()
    try:
        plan_text = generate_trip_plan(payload.request)

        entry = TripPlan(
            request=payload.request,
            plan=plan_text,
            client_id=client_id,
        )
        db.add(entry)
        db.commit()
        db.refresh(entry)

        return {
            "id": entry.id,
            "request": entry.request,
            "plan": entry.plan,
            "created_at": entry.created_at.isoformat(),
        }
    except Exception:
        db.rollback()
        logger.exception("Request failed")
        raise HTTPException(status_code=500, detail=GENERIC_ERROR)
    finally:
        db.close()


@app.get("/trip-plans")
def get_trip_plans(request: Request):
    client_id = get_client_id(request)
    if not client_id:
        return []
    db = SessionLocal()
    try:
        rows = (
            db.query(TripPlan)
            .filter(TripPlan.client_id == client_id)
            .order_by(TripPlan.id.desc())
            .limit(20)
            .all()
        )

        return [
            {
                "id": row.id,
                "request": row.request,
                "plan": row.plan,
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ]
    finally:
        db.close()
@app.get("/trip-plans/{plan_id}/pdf")
def download_trip_plan_pdf(plan_id: int, request: Request):
    client_id = get_client_id(request)
    if not client_id:
        raise HTTPException(status_code=404, detail="Trip plan not found")
    db = SessionLocal()
    try:
        row = (
            db.query(TripPlan)
            .filter(TripPlan.id == plan_id, TripPlan.client_id == client_id)
            .first()
        )
        if not row:
            raise HTTPException(status_code=404, detail="Trip plan not found")

        pdf_path = build_trip_plan_pdf(row.id, row.request, row.plan)

        return FileResponse(
            pdf_path,
            media_type="application/pdf",
            filename=f"outbackmind_trip_plan_{row.id}.pdf",
        )
    finally:
        db.close()  
           
@app.get("/history")
def history(request: Request):
    client_id = get_client_id(request)
    if not client_id:
        return []
    db = SessionLocal()
    try:
        rows = (
            db.query(QuestionLog)
            .filter(QuestionLog.client_id == client_id)
            .order_by(QuestionLog.id.desc())
            .limit(20)
            .all()
        )

        return [
            {
                "id": row.id,
                "question": row.question,
                "answer": row.answer,
                "mode": row.mode,
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ]
    finally:
        db.close()
        

class ChecklistRequest(BaseModel):
    request: str


@app.post("/generate-checklist")
def generate_checklist(payload: ChecklistRequest, request: Request):
    enforce_ai_rate_limit(request)
    try:
        prompt = f"""
You are OutbackMind, an Australian camping, caravan, 4WD, and remote-travel assistant.

Create a practical checklist for:

{payload.request}

Use relevant sections from this format:

📋 Essential Preparation
☐ ...

💧 Water & Food
☐ ...

🏕️ Camp & Shelter
☐ ...

🚗 Vehicle & Recovery
☐ ...

🩹 First Aid & Safety
☐ ...

📡 Navigation & Communication
☐ ...

Keep each item short, specific, and appropriate for Australian conditions.
Do not include product links.
"""

        response = client.responses.create(
            model="gpt-4.1-mini",
            input=prompt
        )

        return {
            "request": payload.request,
            "checklist": response.output_text.strip()
        }

    except Exception:
        logger.exception("Checklist generation failed")
        raise HTTPException(status_code=500, detail=GENERIC_ERROR)