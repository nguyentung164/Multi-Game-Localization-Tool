from __future__ import annotations

from pathlib import Path

import pytest

from civ7_tool.deploy import collect_deploy_files, deploy_to_game
from civ7_tool.types import ValidationError


def test_collect_deploy_files_skips_l10n(tmp_path: Path) -> None:
    (tmp_path / "Base" / "text" / "en_us").mkdir(parents=True)
    (tmp_path / "Base" / "text" / "l10n").mkdir(parents=True)
    (tmp_path / "Base" / "text" / "en_us" / "A.xml").write_text("<Root/>", encoding="utf-8")
    (tmp_path / "Base" / "text" / "l10n" / "B.xml").write_text("<Root/>", encoding="utf-8")

    files = collect_deploy_files(tmp_path)
    assert len(files) == 1
    assert any("A.xml" in str(path) for path in files.values())


def test_deploy_dry_run_classifies_changes(tmp_path: Path) -> None:
    source = tmp_path / "mod"
    game = tmp_path / "game"
    (source / "Base").mkdir(parents=True)
    (game / "Base").mkdir(parents=True)

    (source / "Base" / "new.xml").write_text("<Root><Text>New</Text></Root>", encoding="utf-8")
    (source / "Base" / "same.xml").write_text("<Root><Text>Same</Text></Root>", encoding="utf-8")
    (source / "Base" / "changed.xml").write_text(
        "<Root><Text>Changed</Text></Root>", encoding="utf-8"
    )
    (game / "Base" / "same.xml").write_text("<Root><Text>Same</Text></Root>", encoding="utf-8")
    (game / "Base" / "changed.xml").write_text(
        "<Root><Text>Old</Text></Root>", encoding="utf-8"
    )

    report = deploy_to_game(source, game, dry_run=True)
    assert report["summary"]["created"] == 1
    assert report["summary"]["copied"] == 1
    assert report["summary"]["unchanged"] == 1
    assert report["dryRun"] is True


def test_deploy_progress_reports_processed_files(tmp_path: Path) -> None:
    source = tmp_path / "mod"
    game = tmp_path / "game"
    (source / "Base").mkdir(parents=True)
    (game / "Base").mkdir(parents=True)

    (source / "Base" / "same.xml").write_text("<Root><Text>Same</Text></Root>", encoding="utf-8")
    (source / "Base" / "changed.xml").write_text(
        "<Root><Text>Changed</Text></Root>", encoding="utf-8"
    )
    (game / "Base" / "same.xml").write_text("<Root><Text>Same</Text></Root>", encoding="utf-8")
    (game / "Base" / "changed.xml").write_text(
        "<Root><Text>Old</Text></Root>", encoding="utf-8"
    )

    progress_events: list[dict[str, object]] = []

    def reporter(event_type: str, _step: str, payload: dict[str, object]) -> None:
        if event_type == "progress":
            progress_events.append(dict(payload))

    deploy_to_game(
        source,
        game,
        dry_run=False,
        backup=False,
        reporter=reporter,
    )

    assert progress_events
    last = progress_events[-1]
    assert last["processed"] == 2
    assert last["total"] == 2
    assert last["currentFile"]


def test_deploy_apply_copies_with_backup(tmp_path: Path) -> None:
    source = tmp_path / "mod"
    game = tmp_path / "game"
    backup_root = tmp_path / "backups"
    (source / "Base").mkdir(parents=True)
    (game / "Base").mkdir(parents=True)

    (source / "Base" / "changed.xml").write_text(
        "<Root><Text>Changed</Text></Root>", encoding="utf-8"
    )
    (game / "Base" / "changed.xml").write_text(
        "<Root><Text>Old</Text></Root>", encoding="utf-8"
    )

    report = deploy_to_game(
        source,
        game,
        backup_root=backup_root,
        dry_run=False,
        backup=True,
    )
    target = game / "Base" / "changed.xml"
    assert "Changed" in target.read_text(encoding="utf-8")
    assert report["summary"]["copied"] == 1
    assert report["backup"] is not None
    assert list(backup_root.glob("**/*.xml"))


def test_deploy_apply_does_not_count_failed_copy_as_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "mod"
    game = tmp_path / "game"
    (source / "Base").mkdir(parents=True)
    (game / "Base").mkdir(parents=True)
    (source / "Base" / "changed.xml").write_text("new", encoding="utf-8")
    target = game / "Base" / "changed.xml"
    target.write_text("old", encoding="utf-8")

    def fail_copy(*_args: object, **_kwargs: object) -> None:
        raise OSError("copy failed")

    monkeypatch.setattr("civ7_tool.deploy.shutil.copy2", fail_copy)
    report = deploy_to_game(source, game, dry_run=False, backup=False)

    assert report["summary"]["copied"] == 0
    assert report["summary"]["errors"] == 1
    assert target.read_text(encoding="utf-8") == "old"


def test_deploy_rejects_nested_paths(tmp_path: Path) -> None:
    source = tmp_path / "mod"
    game = source / "nested"
    source.mkdir()
    game.mkdir()
    (source / "A.xml").write_text("<Root/>", encoding="utf-8")

    with pytest.raises(ValidationError, match="lồng nhau"):
        deploy_to_game(source, game, dry_run=True)
