"""Pydantic request/response models."""
from __future__ import annotations

from typing import Optional
from pydantic import BaseModel


class LoginRequest(BaseModel):
    name: str
    exam_code: str


class LoginResponse(BaseModel):
    session_id: str
    candidate_name: str
    token: str
    exam: "ExamPublic"


class Choice(BaseModel):
    id: str
    text: str


class QuestionPublic(BaseModel):
    id: str
    text: str
    choices: list[Choice]


class ExamPublic(BaseModel):
    id: str
    title: str
    duration_seconds: int
    questions: list[QuestionPublic]


class FlagRequest(BaseModel):
    session_id: str
    type: str            # e.g. "tab_switch", "fullscreen_exit", "printscreen", "copy"
    detail: Optional[str] = None
    severity: str = "medium"   # "low" | "medium" | "high"


class SubmitRequest(BaseModel):
    session_id: str
    answers: dict[str, str]     # question_id -> choice_id


class SubmitResponse(BaseModel):
    score: int
    total: int
    flags: int


LoginResponse.model_rebuild()
