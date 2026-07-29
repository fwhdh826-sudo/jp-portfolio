"""Frozen P14-E2 privacy tests T-23..T-28."""
from __future__ import annotations

import ast
import json
from pathlib import Path

from data import p14_evidence_capture as capture
from data import p14_evidence_privacy_filter as privacy

REPO = Path(__file__).parents[1]


def test_forbidden_keys_anywhere_in_bundle_are_rejected(tmp_path):
    """T-23."""
    path = tmp_path / "snapshots/real-test/metrics/nested.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"safe": [{"nested": {"holdings": ["private"]}}]}))
    report = privacy.scan_bundle(tmp_path)
    assert report["passed"] is False
    assert any(
        item.get("kind") == "forbidden-key" and item.get("key") == "holdings"
        for item in report["violations"]
    )


def test_secret_values_and_token_patterns_are_never_written(tmp_path):
    """T-24."""
    variables, redacted = privacy.environment_presence(
        environ={
            "GITHUB_TOKEN": "ghp_" + "A" * 40,
            "SAFE_NAME": "public",
        }
    )
    assert variables == [
        {"name": "GITHUB_TOKEN", "present": True},
        {"name": "SAFE_NAME", "present": True},
    ]
    assert redacted == ["GITHUB_TOKEN"]
    assert "A" * 40 not in json.dumps(variables)
    leak = tmp_path / "leak.txt"
    leak.write_text("ghp_" + "A" * 40)
    assert privacy.scan_bundle(tmp_path)["passed"] is False


def test_environment_records_variable_names_without_values():
    """T-25."""
    variables, redacted = privacy.environment_presence(
        names=["PRESENT", "ABSENT", "API_KEY"],
        environ={"PRESENT": "value", "API_KEY": "secret-value"},
    )
    assert variables == [
        {"name": "ABSENT", "present": False},
        {"name": "API_KEY", "present": True},
        {"name": "PRESENT", "present": True},
    ]
    assert redacted == ["API_KEY"]
    assert all(set(row) == {"name", "present"} for row in variables)


def test_only_allowlisted_public_input_files_are_bundled(tmp_path):
    """T-26."""
    input_dir = tmp_path / "snapshots/real-test/inputs/data"
    input_dir.mkdir(parents=True)
    for name in privacy.ALLOWED_INPUT_DATA_FILES:
        (input_dir / name).write_text("{}")
    assert privacy.scan_bundle(tmp_path)["passed"] is True
    (input_dir / "portfolio.json").write_text("{}")
    report = privacy.scan_bundle(tmp_path)
    assert any(item.get("kind") == "non-allowlisted-input" for item in report["violations"])


def test_capture_module_does_not_import_sbi_or_backend_modules():
    """T-27."""
    source = Path(capture.__file__).read_text()
    tree = ast.parse(source)
    imported: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.append(node.module)
    assert not any(name.startswith("backend") for name in imported)
    assert not any("parse_sbi" in name or "update_holdings_from_sbi_csv" in name for name in imported)


def test_absolute_home_paths_are_normalized():
    """T-28."""
    raw = {
        "mac": "/Users/ryo/private/file.json",
        "linux": "/home/runner/work/repo/file.json",
        "nested": ["/Users/alice/secret"],
    }
    normalized = privacy.normalize_private_paths(raw)
    text = json.dumps(normalized)
    assert "/Users/" not in text
    assert "/home/" not in text
    assert text.count("<HOME>") == 3
