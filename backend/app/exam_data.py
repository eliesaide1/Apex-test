"""Seed exam content. In production this comes from PostgreSQL."""

EXAM_CODE = "DEMO"

EXAM = {
    "id": "exam-001",
    "title": "Workplace Security Awareness — Module 1",
    "duration_seconds": 15 * 60,
    "questions": [
        {
            "id": "q1",
            "text": "What is the best response to an unexpected email asking for your password?",
            "choices": [
                {"id": "a", "text": "Reply with the password if it looks official"},
                {"id": "b", "text": "Ignore and report it to IT / security"},
                {"id": "c", "text": "Click the link to verify the request"},
                {"id": "d", "text": "Forward it to a colleague to ask"},
            ],
            "answer": "b",
        },
        {
            "id": "q2",
            "text": "Which password is the strongest?",
            "choices": [
                {"id": "a", "text": "password123"},
                {"id": "b", "text": "Summer2024"},
                {"id": "c", "text": "correct-horse-battery-staple-92!"},
                {"id": "d", "text": "your birthday"},
            ],
            "answer": "c",
        },
        {
            "id": "q3",
            "text": "Remote-desktop tools (AnyDesk, TeamViewer) during a proctored exam are:",
            "choices": [
                {"id": "a", "text": "Fine if you close them quickly"},
                {"id": "b", "text": "Allowed for note-taking"},
                {"id": "c", "text": "Prohibited — they enable outside help"},
                {"id": "d", "text": "Required by the exam"},
            ],
            "answer": "c",
        },
        {
            "id": "q4",
            "text": "You receive a USB stick in the mail. You should:",
            "choices": [
                {"id": "a", "text": "Plug it in to see what's on it"},
                {"id": "b", "text": "Plug it into a spare machine"},
                {"id": "c", "text": "Hand it to security / IT without plugging it in"},
                {"id": "d", "text": "Take it home to check"},
            ],
            "answer": "c",
        },
        {
            "id": "q5",
            "text": "Two-factor authentication (2FA) protects you because:",
            "choices": [
                {"id": "a", "text": "It makes passwords unnecessary"},
                {"id": "b", "text": "A stolen password alone is not enough to log in"},
                {"id": "c", "text": "It hides your IP address"},
                {"id": "d", "text": "It encrypts your hard drive"},
            ],
            "answer": "b",
        },
    ],
}


def public_exam() -> dict:
    """Exam without the answer keys — safe to send to the client."""
    return {
        "id": EXAM["id"],
        "title": EXAM["title"],
        "duration_seconds": EXAM["duration_seconds"],
        "questions": [
            {"id": q["id"], "text": q["text"], "choices": q["choices"]}
            for q in EXAM["questions"]
        ],
    }


def grade(answers: dict[str, str]) -> tuple[int, int]:
    correct = sum(1 for q in EXAM["questions"] if answers.get(q["id"]) == q["answer"])
    return correct, len(EXAM["questions"])
