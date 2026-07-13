"""Seed exam content — Apex AI Backend Technical Assessment.

19 free-text questions across 5 sections, 100 points, 90 minutes. Answers are
graded manually by a reviewer (there is no answer key); the backend only tracks
how many questions have a saved answer (see store.count_answers).

In production this would come from a database.
"""

from .config import EXAM_CODE  # noqa: F401  (re-exported for callers)

# Per-question countdown (seconds), hand-tuned by difficulty / expected writing
# effort rather than strictly by points. The values sum to 5400 = 90 minutes,
# which is also the overall exam duration.
QUESTION_TIME = {
    "q1": 180, "q2": 240, "q3": 180, "q4": 240, "q5": 210,      # Section A
    "q6": 720, "q7": 240, "q8": 300, "q9": 240,                 # Section B
    "q10": 540, "q11": 300, "q12": 240,                         # Section C
    "q13": 240, "q14": 270, "q15": 240,                         # Section D
    "q16": 300, "q17": 240, "q18": 240, "q19": 240,             # Section E
}

EXAM = {
    "id": "be-tech-001",
    "title": "Apex AI — Backend Technical Assessment",
    "duration_seconds": 90 * 60,
    "total_points": 100,
    "instructions": (
        "Answer all questions clearly and directly. Prefer precise engineering "
        "reasoning over long vague explanations. Explain tradeoffs when relevant, "
        "and state any assumption explicitly. Do not write code unless the question "
        "explicitly asks for it."
    ),
    "org": "Apex AI — AI Software Solutions",
    "authors": [
        {"name": "Gabriel Sabbagh", "role": "Co-Founder & CEO"},
        {"name": "Elie Saide", "role": "Co-Founder & CTO"},
    ],
    "sections": [
        {
            "id": "A",
            "title": "Section A — Core Precision Questions",
            "points": 20,
            "instructions": (
                "Answer each question in a precise and technical way. "
                "Avoid generic textbook wording."
            ),
            "questions": [
                {"id": "q1", "points": 4,
                 "text": "What makes an API endpoint production-ready?"},
                {"id": "q2", "points": 4,
                 "text": ("Explain the difference between:\n"
                          "• authentication\n"
                          "• authorization\n\n"
                          "Then give one real production example where confusing "
                          "them would create a serious problem.")},
                {"id": "q3", "points": 4,
                 "text": ("What is idempotency in backend systems, and where is "
                          "it especially important?")},
                {"id": "q4", "points": 4,
                 "text": ("What is the difference between:\n"
                          "• business logic\n"
                          "• controller logic\n"
                          "• database access logic\n\n"
                          "Why is mixing them dangerous in a growing system?")},
                {"id": "q5", "points": 4,
                 "text": ("Explain when SQL is a better choice than NoSQL, and "
                          "when NoSQL can be justified.")},
            ],
        },
        {
            "id": "B",
            "title": "Section B — System Architecture Scenario",
            "points": 25,
            "instructions": (
                "Answer as if you are the engineer responsible for the production "
                "backend."
            ),
            "scenario": (
                "You are building the backend for an AI-powered tutoring assistant "
                "integrated into a live education platform.\n\n"
                "The system should:\n"
                "1. receive a user request from the frontend\n"
                "2. fetch tutor and availability data\n"
                "3. call an AI service to generate tutor recommendations\n"
                "4. return recommendations to the frontend\n"
                "5. allow the user to book a slot\n"
                "6. require study material upload before final confirmation\n"
                "7. prevent double-booking\n"
                "8. log important actions for auditing\n\n"
                "The system must support: concurrent users, retries, partial "
                "service failures, secure access control, and future maintainability."
            ),
            "questions": [
                {"id": "q6", "points": 10,
                 "text": ("Explain how you would architect this backend. Your "
                          "answer must include:\n"
                          "• major services or modules\n"
                          "• request flow\n"
                          "• how AI-related logic should be separated from "
                          "deterministic business logic\n"
                          "• how booking confirmation should be controlled\n"
                          "• how you would keep the system maintainable")},
                {"id": "q7", "points": 5,
                 "text": ("The AI recommendation service fails, but tutor and "
                          "schedule data are still available. What should the "
                          "backend do?")},
                {"id": "q8", "points": 5,
                 "text": ("Two users try to book the same time slot at the same "
                          "moment. Explain how the backend should handle this "
                          "safely.")},
                {"id": "q9", "points": 5,
                 "text": ("A product manager asks you to “just let the frontend "
                          "control whether the booking is confirmed or not.” How "
                          "do you respond?")},
            ],
        },
        {
            "id": "C",
            "title": "Section C — Databases, Integrity, and Reliability",
            "points": 20,
            "instructions": (
                "These questions focus on whether the candidate can design data "
                "systems that remain correct under pressure."
            ),
            "questions": [
                {"id": "q10", "points": 7,
                 "text": ("Design the core relational database structure for:\n"
                          "• users\n• tutors\n• tutor availabilities\n• bookings\n"
                          "• uploaded study materials\n\n"
                          "You do not need to write SQL. Explain the tables, "
                          "relationships, and important constraints.")},
                {"id": "q11", "points": 7,
                 "text": ("A query becomes very slow after the database grows "
                          "significantly. Explain a practical step-by-step "
                          "investigation approach.")},
                {"id": "q12", "points": 6,
                 "text": ("A junior developer says: “If the database is slow, we "
                          "should just add caching.” Explain why this is not a "
                          "serious first response.")},
            ],
        },
        {
            "id": "D",
            "title": "Section D — Security, Validation, and API Safety",
            "points": 15,
            "instructions": "These questions focus on production safety.",
            "questions": [
                {"id": "q13", "points": 5,
                 "text": ("A frontend sends booking data to your API. Which parts "
                          "of that data should the backend trust, and which parts "
                          "must be revalidated?")},
                {"id": "q14", "points": 5,
                 "text": ("A file upload feature is required for study materials. "
                          "What backend risks should be considered before accepting "
                          "uploaded files?")},
                {"id": "q15", "points": 5,
                 "text": ("What is the difference between returning useful API "
                          "errors and exposing sensitive internal information? "
                          "Give a practical example.")},
            ],
        },
        {
            "id": "E",
            "title": "Section E — Engineering Judgment",
            "points": 20,
            "instructions": (
                "These questions are designed to reveal backend ownership and "
                "professional maturity."
            ),
            "questions": [
                {"id": "q16", "points": 5,
                 "text": ("Tell us about a backend bug, incident, or system mistake "
                          "you caused or handled in a real project. Your answer "
                          "should include:\n"
                          "• what happened\n• why it happened\n• how it was fixed\n"
                          "• how recurrence was prevented")},
                {"id": "q17", "points": 5,
                 "text": ("When do you push back on product requests as a backend "
                          "engineer, and when do you simply execute?")},
                {"id": "q18", "points": 5,
                 "text": ("What separates a backend developer who can build features "
                          "from a backend engineer who can own production systems?")},
                {"id": "q19", "points": 5,
                 "text": ("A system is working correctly today, but it is poorly "
                          "structured and difficult to extend. Would you leave it "
                          "alone or improve it? Explain your reasoning.")},
            ],
        },
    ],
}


def all_question_ids() -> list[str]:
    return [q["id"] for s in EXAM["sections"] for q in s["questions"]]


def question_count() -> int:
    return len(all_question_ids())


def public_exam() -> dict:
    """Exam content sent to the client. No answer keys exist for free-text."""
    return {
        "id": EXAM["id"],
        "title": EXAM["title"],
        "duration_seconds": sum(QUESTION_TIME.values()),  # = 5400s (90 min)
        "total_points": EXAM["total_points"],
        "instructions": EXAM["instructions"],
        "org": EXAM["org"],
        "authors": EXAM["authors"],
        "sections": [
            {
                "id": s["id"],
                "title": s["title"],
                "points": s["points"],
                "instructions": s.get("instructions", ""),
                "scenario": s.get("scenario"),
                "questions": [
                    {"id": q["id"], "text": q["text"], "points": q["points"],
                     "time_limit_seconds": QUESTION_TIME[q["id"]]}
                    for q in s["questions"]
                ],
            }
            for s in EXAM["sections"]
        ],
    }
