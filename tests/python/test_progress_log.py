from civ7_tool.types import ProgressThrottle, report_progress, report_warning


def test_report_progress_emits_log_when_title_present() -> None:
    events: list[tuple[str, dict[str, object]]] = []

    def reporter(event_type: str, _step: str, payload: dict[str, object]) -> None:
        events.append((event_type, payload))

    throttle = ProgressThrottle()
    report_progress(
        reporter,
        "translate",
        {
            "phase": "api",
            "file": "Base/Text.xml",
            "batch": 2,
            "batchTotal": 5,
            "title": "Đang dịch Text.xml",
            "description": "Batch 2/5 · 40 mục · gemini-3.5-flash-lite",
        },
        throttle,
        force=True,
    )

    assert len(events) == 2
    assert events[0][0] == "progress"
    assert "title" not in events[0][1]
    assert events[0][1]["batch"] == 2
    assert events[1][0] == "log"
    assert events[1][1]["title"] == "Đang dịch Text.xml"
    assert "Batch 2/5" in str(events[1][1]["description"])


def test_report_warning_adds_title_and_description() -> None:
    events: list[tuple[str, dict[str, object]]] = []

    def reporter(event_type: str, _step: str, payload: dict[str, object]) -> None:
        events.append((event_type, payload))

    report_warning(
        reporter,
        "translate",
        {"phase": "retry", "attempt": 2, "waitSeconds": 4.0},
    )

    assert events[0][0] == "warning"
    assert events[0][1]["title"] == "Đang thử lại API"
    assert "Lần 2" in str(events[0][1]["description"])
