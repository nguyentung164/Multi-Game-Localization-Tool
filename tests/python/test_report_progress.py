from translate_tool.common.types import ProgressThrottle, report_progress


def _collect_calls(**kwargs: object) -> list[tuple[str, str, dict]]:
    calls: list[tuple[str, str, dict]] = []

    def reporter(event_type: str, step: str, payload: dict) -> None:
        calls.append((event_type, step, dict(payload)))

    report_progress(
        reporter,
        "translate",
        {
            "phase": kwargs.get("phase", "file"),
            "processed": int(kwargs.get("processed", 1)),
            "total": int(kwargs.get("total", 10)),
            **(
                {"title": kwargs["title"], "description": kwargs.get("description", "")}
                if "title" in kwargs
                else {}
            ),
        },
        ProgressThrottle(),
        force=True,
    )
    return calls


def test_report_progress_does_not_mirror_heartbeat_to_log() -> None:
    calls = _collect_calls(
        phase="heartbeat",
        processed=80,
        total=132,
        title="Đang dịch · 1 luồng",
        description="80/132 mục · 1/4 luồng",
    )
    assert [event_type for event_type, _, _ in calls] == ["progress"]
    assert calls[0][2]["phase"] == "heartbeat"


def test_report_progress_does_not_mirror_api_to_log() -> None:
    calls = _collect_calls(
        phase="api",
        processed=40,
        total=132,
        title="Đang dịch · 2 luồng",
        description="40/132 mục · 2/4 luồng",
    )
    assert [event_type for event_type, _, _ in calls] == ["progress"]


def test_report_progress_mirrors_file_milestone_to_log() -> None:
    calls = _collect_calls(
        phase="file",
        processed=3,
        total=10,
        title="Thu thập 3/10",
        description="Some/File.xml",
    )
    assert [event_type for event_type, _, _ in calls] == ["progress", "log"]
    assert calls[1][2]["title"] == "Thu thập 3/10"


def test_report_progress_without_title_emits_only_progress() -> None:
    calls = _collect_calls(phase="copy", processed=5, total=20)
    assert [event_type for event_type, _, _ in calls] == ["progress"]
