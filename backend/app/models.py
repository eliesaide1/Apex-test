"""Pydantic request/response models."""
from __future__ import annotations

from typing import Optional
from pydantic import BaseModel


class LoginRequest(BaseModel):
    name: str
    exam_code: str


class QuestionPublic(BaseModel):
    id: str
    text: str
    points: int


class SectionPublic(BaseModel):
    id: str
    title: str
    points: int
    instructions: str = ""
    scenario: Optional[str] = None
    questions: list[QuestionPublic]


class Author(BaseModel):
    name: str
    role: str


class ExamPublic(BaseModel):
    id: str
    title: str
    duration_seconds: int
    total_points: int
    instructions: str = ""
    org: str = ""
    authors: list[Author] = []
    sections: list[SectionPublic]


class LoginResponse(BaseModel):
    session_id: str
    candidate_name: str
    token: str
    exam: ExamPublic


class FlagRequest(BaseModel):
    session_id: str
    type: str            # e.g. "tab_switch", "camera_off", "mic_off", "printscreen"
    detail: Optional[str] = None
    severity: str = "medium"   # "low" | "medium" | "high"


class AnswerRequest(BaseModel):
    session_id: str
    question_id: str
    answer: str


class SubmitRequest(BaseModel):
    session_id: str
    # Free-text answers are saved per-question during the exam; on submit we also
    # accept the full map as a save-all safety net (question_id -> answer text).
    answers: dict[str, str] = {}


class SubmitResponse(BaseModel):
    answered: int
    total: int
    flags: int
