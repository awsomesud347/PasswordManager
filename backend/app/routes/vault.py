from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models import User
from app.schemas import VaultResponse, VaultUpdateRequest, ExportResponse
from app.services.crypto import verify_jwt
import json

router = APIRouter(prefix="/vault", tags=["vault"])

@router.get("/", , response_model=VaultResponse)
async def get_vault(email: str = Depends(verify_jwt), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(status_code=404, detail="User Not Found")
    
    return {
    "vault_blob": user.vault_blob,
    "iv": user.iv,
    "version": user.vault_version
    }

