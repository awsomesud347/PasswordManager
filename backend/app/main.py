from fastapi import FastAPI
from contextlib import asynccontextmanager
from app.database import engine, Base
from app.routes import auth, vault
from prometheus_fastapi_instrumentator import Instrumentator
from dotenv import load_dotenv

load_dotenv()

@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield

app = FastAPI(title="Zero Knowledge Vault", lifespan=lifespan)

Instrumentator().instrument(app).expose(app)

app.include_router(auth.router)
app.include_router(vault.router)

@app.get("/health")
async def health():
    return {"status": "healthy"}
