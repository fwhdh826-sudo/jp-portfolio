"""I01 VI-B synthetic process evidence; execution needs a separate gate.

Only this file is new. Helpers materialize copies below the authority's vi-b
root, never alter source twins, and never contact a remote. The workflow stays
literally disabled; enabled mode exists only in these isolated child processes.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest
import yaml

from data import p14_run_evidence_bundle as bundle

REPO = Path(__file__).resolve().parents[1]
D = "169ea3cfd9c6c2e56d1f7a90a7bb9d99fd60e2af"
C0 = "50068f208b346026d7f0ec506e007c755122b719"
BATCH_SELECTION_SHA256 = "874500a2964b45b18a006ff15413ff7be5f94a8c1014399c174233117b48c271"
VI_B_ROOT = Path("/private/tmp/p14-v13-4-gates/vi-b")
TWIN_PATHS = ("data/candidate_funnel.json", "public/data/candidate_funnel.json")
POLICY = "p14-decision-aware-v1"
RUN_ID = "900000041"
NOW = "2026-09-20T00:30:00+00:00"
REFERENCE_ENV = {
    "P14_TRANSPORT_STATUS": "p14_transport_status",
    "P14_HANDOFF_DIGEST": "p14_handoff_digest",
    "P14_OBSERVATION_DIGEST": "p14_observation_digest",
    "P14_RECEIPT_DIGEST": "p14_receipt_digest",
    "P14_CAPTURE_INPUT_DIGEST": "p14_capture_input_digest",
    "P14_EXECUTED_GIT_SHA": "p14_executed_git_sha",
    "P14_OBSERVATION_SCHEMA": "p14_observation_schema",
    "P14_HANDOFF_SCHEMA": "p14_handoff_schema",
    "P14_POLICY_VERSION": "p14_policy_version",
    "P14_RUN_ID": "p14_run_id",
    "P14_RUN_ATTEMPT": "p14_run_attempt",
}
REFERENCE_FIELDS = {
    "status": "p14_transport_status", "transportDigest": "p14_handoff_digest",
    "observationDigest": "p14_observation_digest", "receiptDigest": "p14_receipt_digest",
    "captureInputDigest": "p14_capture_input_digest", "executedGitSha": "p14_executed_git_sha",
    "observationSchemaVersion": "p14_observation_schema", "handoffSchemaVersion": "p14_handoff_schema",
    "policyVersion": "p14_policy_version", "runId": "p14_run_id", "runAttempt": "p14_run_attempt",
}

# This bootstrap is written outside the copied repository, then invoked by the
# exact workflow python3 command. It changes process-local seams, not source.
_PROCESS_CODE = r'''
import hashlib
import json
import os
import socket
import subprocess
import sys
import types
from datetime import datetime
from pathlib import Path

repo = Path.cwd()
sys.path.insert(0, str(repo))
log = Path(os.environ["I01_EVENTS"])
def event(name, **values):
    with log.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"event": name, "pid": os.getpid(), **values}, sort_keys=True) + "\n")
def no_network(*args, **kwargs):
    event("network_forbidden")
    raise AssertionError("I01 network forbidden")
socket.create_connection = no_network
socket.socket.connect = no_network

from data import candidate_funnel_batch as batch
from data import candidate_funnel_engine as engine
from data import candidate_funnel_run_evidence as evidence
from data import p14_handoff as handoff
case = os.environ["I01_CASE"]
fault = os.environ.get("I01_FAULT", "")
module = sys.argv[2]
args = sys.argv[3:]
event("process", module=module, version=list(sys.version_info[:2]))

def result(perturbed=False):
    rows = []
    for i in range(60):
        tier = "actionable" if i < 12 else "deep_review" if i < 40 else "screened"
        if perturbed and case == "hard" and i == 0:
            tier = "deep_review"
        rows.append({
            "code": str(1000+i), "name": "row " + str(i), "sector": "S"+str(i%8),
            "tier": tier, "marketRank": i+1, "marketScore": 100.0-i*1.5,
            "rawCompositeScore": 1.0-i/60, "dataConfidence": 1.0, "dataStatus": "ok",
            "prescreenScore": 100-i, "prescreenRank": i+1, "prescreenPool": "main",
            "themeStatus": "unavailable", "themes": [], "selectedReasons": [],
            "riskReasons": [], "hardExclusionReasons": [],
            "scoreBreakdown": [{"id": name, "value": None, "weight": 0.0,
                "weightedContribution": None, "status": "missing", "sourceFields": []}
                for name in engine.COMPONENT_IDS],
        })
    return {
        "schemaVersion": "candidate-funnel-1", "funnelVersion": "candidate-funnel-v1",
        "scoreVersion": "market-score-v1", "not_for_trading": True, "status": "generated",
        "degradationReasons": [], "counts": {"total":60,"excluded":0,"screened":60,"deepReview":40,"actionable":12},
        "candidates":rows, "excludedSummary":{"total":0,"byReason":{}},
        "sectorDistribution":{"deepReview":{"S"+str(i):5 for i in range(8)},
                              "actionable":{"S"+str(i):1 for i in range(8)}},
        "scoreDistribution":{},
        "selectionObservability":{
            "regimeApplied":"bull_calm","actionableHardMaxApplied":12,"actionableSectorCapApplied":2,
            "deepReviewHardMaxApplied":40,"deepReviewSectorCapApplied":6,
            "deepReviewSectorCapRelaxed":False,"actionableSectorCapRelaxed":False,
            "deepReviewSectorCapOverflow":{},"actionableSectorCapOverflow":{},
            "deepReviewEligibleCount":40,"deepReviewSelectedCount":40,
            "actionableEligibleCount":12,"actionableSelectedCount":12,
            "sourceStale":False,"fallbackProvenance":False,
        },
    }

def install_provider(target):
    calls = []
    def provider(inputs, context):
        calls.append(1)
        event("engine", ordinal=len(calls))
        assert len(calls) <= 2
        return result(len(calls) == 2)
    target.build_candidate_funnel = provider
    # Separate degraded-input experiment; never disguised as the P14 seam.
    target.compute_degraded_path_actionable = lambda *args: (0, {})
    if case == "schema":
        target.validate_artifact_schema = lambda artifact: ["schemaVersion mismatch"]
    return calls

if module == "i01.audited_oracle":
    raw = subprocess.check_output(["git", "show", "1d12bcdc9a3676d56a2625483f6fbb98ce3621e3:data/candidate_funnel_batch.py"], cwd=os.environ["I01_SOURCE_REPO"])
    assert hashlib.sha256(raw).hexdigest() == "9e9b136912b555296bc630fcf15183072efebd560be7696ff63dbe1f47b597dd"
    oracle = types.ModuleType("audited_pre_ii_b")
    oracle.__file__ = batch.__file__
    exec(compile(raw, "audited_pre_ii_b", "exec"), oracle.__dict__)
    install_provider(oracle)
    artifact, report = oracle.run_batch(now=datetime.fromisoformat(os.environ["I01_NOW"]),
        previous_artifact_path=Path(os.environ["RUNNER_TEMP"])/"candidate-funnel-evidence/previous-artifact.json")
    root = Path(os.environ["I01_ORACLE"])
    root.mkdir()
    (root/"report.json").write_text(json.dumps(report, ensure_ascii=False, sort_keys=True))
    if artifact is not None:
        (root/"public.json").write_text(json.dumps(artifact, ensure_ascii=False, indent=2))
    sys.exit(0)

if module == "data.candidate_funnel_batch":
    install_provider(batch)
    original_perturb = batch._perturb_candidates
    def perturb(*args, **kwargs):
        event("perturb")
        value = original_perturb(*args, **kwargs)
        event("perturbed_input", values=[{k:row[k] for k in ("code","per","roe")} for row in value])
        return value
    batch._perturb_candidates = perturb
    original_run = batch.run_batch
    def run(**kwargs):
        session = kwargs.get("p14_capture")
        artifact, report = original_run(now=datetime.fromisoformat(os.environ["I01_NOW"]),
            previous_artifact_path=Path(os.environ["RUNNER_TEMP"])/"candidate-funnel-evidence/previous-artifact.json", **kwargs)
        event("report", report=report)
        if session is not None:
            event("receipt", receipt=json.loads(session.receipt_bytes) if session.receipt_bytes else None,
                  transport=session.transport_status)
            if session.observation_bytes is not None:
                event("observation", sha256=hashlib.sha256(session.observation_bytes).hexdigest(),
                      canonical=session.observation_bytes.decode("utf-8"))
        return artifact, report
    batch.run_batch = run
    publish = batch.publish_artifact
    def publishing(artifact):
        event("publish")
        return publish(artifact)
    batch.publish_artifact = publishing
    def fail(*args, **kwargs):
        raise ValueError("injected optional capture failure")
    if fault == "transport":
        handoff.write_handoff_parts = fail
    elif fault == "serialization":
        handoff.build_capture_input_bytes = fail
    elif fault == "privacy":
        batch._p14_privacy_check = fail
    code = batch.main(args)
    event("cli_exit", code=code)
    sys.exit(code)

if module == "data.candidate_funnel_run_evidence":
    def tripwire(name):
        def forbidden(*args, **kwargs):
            event("forbidden", seam=name)
            raise AssertionError("consumer computation forbidden")
        return forbidden
    for name in ("_perturb_candidates", "compute_rank_stability", "compute_p14_release_evidence",
                 "compute_quality_report", "build_candidate_funnel", "build_context",
                 "build_prescreen_index", "join_candidates_with_prescreen", "load_candidates_stocks",
                 "load_prescreen_metadata", "load_previous_artifact", "read_current_regime",
                 "compute_degraded_path_actionable"):
        setattr(batch, name, tripwire("batch."+name))
    engine.build_candidate_funnel = tripwire("engine")
    for name in ("build_candidate_funnel", "build_evidence", "replay_p14", "reclassify_p14"):
        setattr(evidence, name, tripwire("evidence."+name))
    if fault in {"consumer_serialization", "consumer_privacy"}:
        from data.p14_run_evidence_bundle import EvidenceBundleError
        def fail(*args, **kwargs):
            if fault == "consumer_privacy":
                raise EvidenceBundleError("BUNDLE_PRIVACY_VIOLATION")
            raise ValueError("unsafe private exception must not escape")
        evidence.build_captured_bundle = fail
    code = evidence.main(args)
    event("cli_exit", code=code)
    sys.exit(code)

if module == "data.candidate_funnel_privacy_smoke":
    from data import candidate_funnel_privacy_smoke as smoke
    event("smoke")
    if case == "smoke":
        # Real malformed public data forces the real smoke reader to reject it.
        path = repo/"public/data/candidate_funnel.json"
        value = json.loads(path.read_bytes())
        value["officialDecision"] = "injected forbidden field"
        path.write_text(json.dumps(value))
    code = smoke.main(args)
    event("cli_exit", code=code)
    sys.exit(code)
raise AssertionError("unapproved module")
'''


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _git(repo, *args):
    return subprocess.check_output(["git", "--no-optional-locks", *args], cwd=repo)


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def _outputs(path):
    pairs = [line.split("=", 1) for line in path.read_text().splitlines()]
    assert all(len(pair) == 2 for pair in pairs)
    assert len({pair[0] for pair in pairs}) == len(pairs)
    return dict(pairs)


def _snapshot(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def _key_paths(value, prefix=()):
    if isinstance(value, dict):
        return set().union({prefix + (k,) for k in value},
                          *(_key_paths(v, prefix + (k,)) for k, v in value.items()))
    if isinstance(value, list):
        return set().union(set(), *(_key_paths(v, prefix + (i,)) for i, v in enumerate(value)))
    return set()


class _Integration:
    def __init__(self, root, case="ready", fault=""):
        assert sys.version_info[:2] == (3, 11), "I01 process contract requires Python 3.11"
        self.root, self.case = root, case
        self.repo = root / "repo"
        self.repo.mkdir()
        self.temp = root / "runner"
        self.temp.mkdir()
        self.steps = yaml.safe_load((REPO / ".github/workflows/full_batch.yml").read_text())["jobs"]["update-data"]["steps"]
        assert yaml.safe_load((REPO / ".github/workflows/full_batch.yml").read_text())["jobs"]["update-data"]["env"]["P14_HANDOFF_MODE"] == "disabled"
        # Copy only required tracked source bytes, verifying them against D.
        self.sources = {}
        for raw in _git(REPO, "ls-tree", "-r", "--name-only", D).decode().splitlines():
            if raw.startswith("data/") and raw.endswith(".py"):
                value = _git(REPO, "show", f"{D}:{raw}")
                assert (REPO / raw).read_bytes() == value
                target = self.repo / raw
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(value)
                self.sources[raw] = _sha(value)
        workflow = ".github/workflows/full_batch.yml"
        assert (REPO / workflow).read_bytes() == _git(REPO, "show", f"{D}:{workflow}")
        rows = [{"code":str(1000+i),"name":f"row {i}","sector":f"S{i%8}","price":1000.0,
                 "per":10.0,"pbr":1.0,"roe":10.0,"dividendYield":2.0,"sigma252d":0.2,
                 "mom3m":5.0,"dataStatus":"ok"} for i in range(60)]
        _write_json(self.repo / "data/candidates_stocks.json", {
            "schemaVersion":"candidates-stocks-1","updatedAt":"2026-09-20T00:00:00+00:00",
            "sourceUpdatedAt":"2026-09-20T00:00:00+00:00","staleThresholdHours":48,
            "_meta":{"pipelinePath":"normal","universeProvenance":{"shortlistFallbackUsed":False}},
            "candidates":rows,"missing":[],"status":"ok",
        })
        _write_json(self.repo / "data/prescreen_metadata.json", {
            "schemaVersion":"prescreen-metadata-1","generatedAt":"2026-09-20T00:00:00+00:00",
            "not_for_trading":True,"shortlistId":"jpx_cheap_prescreen_v1","pipelinePath":"normal",
            "duplicateCodes":[],"entries":[{"code":str(1000+i),"prescreenScore":100-i,
                "prescreenRank":i+1,"prescreenPool":"main"} for i in range(60)],
        })
        _write_json(self.repo / "data/regime_state.json", {"regime_state":{"current_regime":"bull_calm"}})
        self.before = {}
        for path in TWIN_PATHS:
            raw = _git(REPO, "show", f"{D}:{path}")
            target = self.repo / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            self.before[path] = raw
        assert len(set(self.before.values())) == 1
        self.env = {k:v for k,v in os.environ.items() if not k.startswith(("GITHUB_", "P14_", "I01_", "GIT_", "PYTHON"))}
        self.env.update({
            "GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":os.devnull,"GIT_OPTIONAL_LOCKS":"0",
            "PYTHONDONTWRITEBYTECODE":"1","PYTHONNOUSERSITE":"1",
            "GITHUB_REPOSITORY":"synthetic/i01","GITHUB_JOB":"update-data","GITHUB_RUN_ID":RUN_ID,
            "GITHUB_RUN_ATTEMPT":"1","GITHUB_EVENT_NAME":"schedule","GITHUB_REF":"refs/heads/main",
            "GITHUB_REF_TYPE":"branch","GITHUB_SHA":"1"*40,"RUNNER_TEMP":str(self.temp),
            "P14_HANDOFF_MODE":"enabled","I01_CASE":case,"I01_FAULT":fault,"I01_NOW":NOW,
            "I01_SOURCE_REPO":str(REPO),"I01_ORACLE":str(root/"oracle"),
        })
        for args in (("init", "-q"), ("config", "user.name", "I01 temporary fixture"),
                     ("config", "user.email", "i01@example.invalid"), ("add", "."),
                     ("commit", "-q", "-m", "Temporary committed test twins")):
            subprocess.run(["git", *args], cwd=self.repo, env=self.env, check=True, capture_output=True)
        self.executed_sha = _git(self.repo, "rev-parse", "HEAD").decode().strip()
        self.handoff = self.temp / "candidate-funnel-p14" / f"{RUN_ID}-1"
        self.env["P14_HANDOFF_DIR"] = str(self.handoff)
        script = root / "process.py"
        script.write_text(_PROCESS_CODE)
        shimdir = root / "bin"
        shimdir.mkdir()
        shim = shimdir / "python3"
        shim.write_text("#!/bin/bash\nif [ \"${1:-}\" = '-m' ]; then\n exec " + shlex.quote(sys.executable) + " -B " + shlex.quote(str(script)) + ' "$@"\nfi\nexec ' + shlex.quote(sys.executable) + ' -B "$@"\n')
        shim.chmod(0o700)
        self.env["PATH"] = str(shimdir) + os.pathsep + self.env["PATH"]
        self.results, self.output, self.logs = {}, {}, {}
        self.step("Snapshot previous candidate_funnel artifact for evidence")

    def step_definition(self, name):
        return next(step for step in self.steps if step.get("name") == name or step.get("id") == name)

    def step(self, name, extra=None):
        definition = self.step_definition(name)
        label = definition.get("id", re.sub(r"[^a-zA-Z0-9]", "_", name))
        output, events = self.root / (label+".output"), self.root / (label+".events")
        output.write_text("")
        events.write_text("")
        env = {**self.env, "GITHUB_OUTPUT":str(output), "I01_EVENTS":str(events), **(extra or {})}
        result = subprocess.run(["bash", "-c", definition["run"]], cwd=self.repo, env=env,
                                capture_output=True, text=True, timeout=60)
        self.results[label] = result
        self.output[label] = _outputs(output)
        self.logs[label] = [json.loads(line) for line in events.read_text().splitlines()]
        (self.root/(label+".stdout")).write_text(result.stdout)
        (self.root/(label+".stderr")).write_text(result.stderr)
        return result

    def producer(self):
        self.step("candidate-funnel-build")
        assert self.results["candidate-funnel-build"].returncode == 0
        self.reference = {k:v for k,v in self.output["candidate-funnel-build"].items() if k.startswith("p14_")}
        self.batch_status = self.output["candidate-funnel-build"]["publication_status"]
        logs = self.logs["candidate-funnel-build"]
        assert [e["version"] for e in logs if e["event"] == "process"] == [[3,11]]
        assert len([e for e in logs if e["event"] == "perturb"]) == 1
        assert len([e for e in logs if e["event"] == "engine"]) == 2
        self.report = next(e["report"] for e in logs if e["event"] == "report")
        self.receipt = next(e["receipt"] for e in logs if e["event"] == "receipt")
        if self.reference:
            assert set(self.reference) == set(REFERENCE_ENV.values())
            assert self.reference["p14_executed_git_sha"] == self.executed_sha
        return logs

    def smoke(self):
        condition = self.step_definition("candidate-funnel-smoke")["if"]
        assert condition == "${{ steps.candidate-funnel-build.outputs.publication_status == 'batch_passed' }}"
        if self.batch_status == "batch_passed":
            self.step("candidate-funnel-smoke")
            assert self.results["candidate-funnel-smoke"].returncode == 0
            self.smoke_status = self.output["candidate-funnel-smoke"]["publication_status"]
            assert sum(e["event"] == "smoke" for e in self.logs["candidate-funnel-smoke"]) == 1
        else:
            self.smoke_status = None
            self.output["candidate-funnel-smoke"] = {}
            self.logs["candidate-funnel-smoke"] = []

    def consumer(self, reference=None, fault=None):
        definition = self.step_definition("candidate-funnel-evidence")
        assert definition["if"] == "always()" and definition["continue-on-error"] is True
        reference = self.reference if reference is None else reference
        extra = {name:reference.get(field, "") for name,field in REFERENCE_ENV.items()}
        extra.update({"CANDIDATE_FUNNEL_BATCH_STATUS":self.batch_status,
                      "CANDIDATE_FUNNEL_SMOKE_STATUS":self.smoke_status or ""})
        if fault is not None:
            extra["I01_FAULT"] = fault
        result = self.step("candidate-funnel-evidence", extra)
        logs = self.logs["candidate-funnel-evidence"]
        assert [e["version"] for e in logs if e["event"] == "process"] == [[3,11]]
        assert not [e for e in logs if e["event"] in {"engine","perturb","forbidden","network_forbidden"}]
        producer_pid = next(e["pid"] for e in self.logs["candidate-funnel-build"] if e["event"] == "process")
        assert next(e["pid"] for e in logs if e["event"] == "process") != producer_pid
        self.bundle_path = Path(self.output["candidate-funnel-evidence"]["bundle_path"])
        assert self.bundle_path.is_relative_to(self.temp/"candidate-funnel-evidence/bundle")
        self.files = bundle.read_bundle_directory(self.bundle_path)
        self.evidence = json.loads(self.files["evidence.json"])
        return result

    def enforce(self):
        return self.step("Enforce candidate funnel publication status", {
            "CANDIDATE_FUNNEL_BATCH_STATUS":self.batch_status,
            "CANDIDATE_FUNNEL_SMOKE_STATUS":self.smoke_status or "",
        })

    def assert_twins(self, expected):
        for path in TWIN_PATHS:
            assert (self.repo/path).read_bytes() == expected[path]
            assert _sha((self.repo/path).read_bytes()) == _sha(expected[path])
        assert (self.repo/TWIN_PATHS[0]).read_bytes() == (self.repo/TWIN_PATHS[1]).read_bytes()

    def assert_sources(self):
        assert {p:_sha((self.repo/p).read_bytes()) for p in self.sources} == self.sources

    def oracle(self):
        events = self.root/"oracle.events"
        env = {**self.env, "I01_EVENTS":str(events)}
        subprocess.run([sys.executable,"-B",str(self.root/"process.py"),"-m","i01.audited_oracle"],
                       cwd=self.repo,env=env,check=True,capture_output=True,text=True,timeout=60)
        expected = json.loads((self.root/"oracle/report.json").read_bytes())
        assert self.report == expected
        return self.root/"oracle/public.json"

    def retain_bundle_and_cleanup(self):
        upload = self.step_definition("Upload candidate funnel run evidence")
        assert upload["if"] == "always()" and upload["continue-on-error"] is True
        assert upload["with"]["path"] == "${{ runner.temp }}/candidate-funnel-evidence/bundle/"
        upload_path = self.temp/"candidate-funnel-evidence/bundle"
        before = _snapshot(upload_path)
        assert before and self.bundle_path.is_relative_to(upload_path)
        assert not any("claim" in path or "candidate-funnel-p14" in path for path in before)
        previous = (self.temp/"candidate-funnel-evidence/previous-artifact.json").read_bytes()
        other = self.temp/"candidate-funnel-p14"/f"{RUN_ID}-2"/"keep"
        other.parent.mkdir(parents=True)
        other.write_bytes(b"other attempt")
        assert self.handoff.exists()
        result = self.step("Cleanup candidate funnel P14 handoff")
        assert result.returncode == 0 and not self.handoff.exists()
        assert _snapshot(upload_path) == before
        assert other.read_bytes() == b"other attempt"
        assert (self.temp/"candidate-funnel-evidence/previous-artifact.json").read_bytes() == previous
        self.assert_sources()


@pytest.fixture
def integration_root():
    VI_B_ROOT.mkdir(parents=True, exist_ok=True)
    # Retain raw process/status/byte evidence for the later authorized gate.
    root = Path(tempfile.mkdtemp(prefix="i01-", dir=VI_B_ROOT))
    return root


def _scenario(root, name, case="ready", fault=""):
    path = root/name
    path.mkdir()
    return _Integration(path, case, fault)


def _assert_captured(sim, terminal, verdict):
    report = bundle.verify_bundle_files(sim.files)
    assert report.bundle_integrity == "PASS" and report.capture_validity == "VALID"
    assert report.terminal_status == terminal
    assert report.artifact_available is (terminal == "BATCH_READY")
    assert sim.evidence["p14"]["verdict"] == verdict
    assert sim.evidence["p14"]["release"] == sim.receipt["report"]["qualityGate"]["p14ReleaseEvidence"]
    assert sim.evidence["producerReference"] == {k:sim.reference[v] for k,v in REFERENCE_FIELDS.items()}
    assert sim.evidence["workflowStatus"] == {"batchStatus":sim.batch_status,"smokeStatus":sim.smoke_status}
    directory = sim.handoff/f"run-{RUN_ID}"/"attempt-1"
    for attachment, name in ((bundle.CAPTURE_ATTACHMENT_FILE,"capture-input.json"),
                             (bundle.RECEIPT_ATTACHMENT_FILE,"batch-receipt.json"),
                             (bundle.ENVELOPE_ATTACHMENT_FILE,"handoff.json")):
        assert sim.files[attachment] == (directory/name).read_bytes()
    observation = (directory/f"observation-{sim.reference['p14_observation_digest']}.json").read_bytes()
    logged = next(e for e in sim.logs["candidate-funnel-build"] if e["event"] == "observation")
    assert observation == logged["canonical"].encode()
    assert _sha(observation) == logged["sha256"] == sim.reference["p14_observation_digest"]
    assert sim.files[sim.evidence["attachments"]["observation"]["file"]] == observation
    value = json.loads(observation)
    assert value["sourceIdentity"]["executedGitSha"] == sim.executed_sha
    assert value["runIdentity"]["gitSha"] == "1"*40
    for identity in (value["sourceIdentity"], sim.evidence["consumerIdentity"]):
        for item in identity["modules"]:
            assert item["sha256"] == sim.sources[item["path"]]


def _assert_invalid(sim, code, stage, detail=None):
    report = bundle.verify_bundle_files(sim.files)
    assert report.bundle_integrity == "PASS" and report.capture_validity == "INVALID"
    assert sim.evidence["captureStatus"] == "invalid"
    assert sim.evidence["failure"] == {"code":code,"stage":stage,"detail":detail}
    assert set(sim.files) == {bundle.EVIDENCE_FILE,bundle.PRIVACY_REPORT_FILE,
                              bundle.MANIFEST_FILE,bundle.MANIFEST_DIGEST_FILE}
    assert not {"terminal","attachments","p14","replay","publish","diagnostics"} & set(sim.evidence)
    assert report.terminal_status is None and report.artifact_available is None


def test_oi01_hard_batch_cli_prevents_publication(integration_root):
    sim = _scenario(integration_root,"hard", "hard")
    logs = sim.producer()
    assert sim.batch_status == "batch_failed"
    assert sim.report["qualityGate"]["overallPass"] is False
    assert sim.report["qualityGate"]["hardFailIds"] == ["P-14"]
    assert sim.report["qualityGate"]["p14ReleaseEvidence"]["final"] == {
        "status":"FAIL","hardReasons":["MARKET_REFERENCE_SHORTLIST_MEMBERSHIP_CHANGED"],"warnReasons":[]}
    assert sim.receipt["terminalStatus"] == "QUALITY_GATE_FAILED"
    names = [e["event"] for e in logs]
    assert names.index("receipt") < names.index("cli_exit")
    assert next(e["code"] for e in logs if e["event"] == "cli_exit") == 1
    assert "publish" not in names
    assert "no new artifact will be published" in sim.results["candidate-funnel-build"].stderr
    sim.assert_twins(sim.before)
    sim.smoke()
    assert sim.consumer().returncode == 0
    _assert_captured(sim,"QUALITY_GATE_FAILED","FAIL")
    assert sim.enforce().returncode == 1
    sim.retain_bundle_and_cleanup()


def test_oi02_cross_process_exact_observation_single_perturbation(integration_root):
    sim = _scenario(integration_root,"exact")
    sim.producer()
    sim.smoke()
    assert (sim.batch_status,sim.smoke_status) == ("batch_passed","smoke_passed")
    assert sim.consumer().returncode == 0
    _assert_captured(sim,"BATCH_READY","PASS")
    public = sim.oracle().read_bytes()
    sim.assert_twins({path:public for path in TWIN_PATHS})
    release = sim.evidence["p14"]["release"]
    assert release["top40"]["intersection"] == [str(1000+i) for i in range(40)]
    assert release["top40"]["union"] == [str(1000+i) for i in range(40)]
    assert release["top40"]["jaccard"] == 1.0 and release["top40"]["swapCount"] == 0
    assert release["final"] == {"status":"PASS","hardReasons":[],"warnReasons":[]}
    expected_vector = [{"code":str(1000+i),"prescreenScore":100-i,"prescreenRank":i+1,
                        "prescreenPool":"main","marketRank":i+1,"marketScore":100.0-i*1.5,
                        "rawCompositeScore":1.0-i/60} for i in range(60)]
    replay = sim.evidence["replay"]
    assert replay["baseFullOrderedRankVector"] == expected_vector
    assert replay["perturbedFullOrderedRankVector"] == expected_vector
    assert replay["boundaryOutsideBand"] == {
        "topK":40,"size":10,"base":expected_vector[40:50],"perturbed":expected_vector[40:50]}
    values = next(e["values"] for e in sim.logs["candidate-funnel-build"] if e["event"] == "perturbed_input")
    assert values == [{"code":str(1000+i),"per":10.0*(1+(0.02 if i%2 == 0 else -0.02)),
                       "roe":10.0*(1-(0.02 if i%2 == 0 else -0.02))} for i in range(60)]
    assert sim.enforce().returncode == 0
    sim.retain_bundle_and_cleanup()


@pytest.mark.parametrize("fault", ["transport","serialization","privacy","consumer_serialization","consumer_privacy"])
def test_oi03_capture_failure_isolated_from_publication(integration_root, fault):
    sim = _scenario(integration_root,fault, fault=fault if not fault.startswith("consumer_") else "")
    sim.producer()
    sim.smoke()
    assert (sim.batch_status,sim.smoke_status) == ("batch_passed","smoke_passed")
    public = sim.oracle().read_bytes()
    sim.assert_twins({path:public for path in TWIN_PATHS})
    assert sim.consumer(fault=fault).returncode == 1
    if fault in {"transport","serialization","privacy"}:
        # The exact workflow delivers empty strings, not omitted CLI flags.
        _assert_invalid(sim,"PRODUCER_REFERENCE_MISSING","REFERENCE")
    elif fault == "consumer_serialization":
        _assert_invalid(sim,"BUNDLE_BUILD_FAILED","BUILD")
    else:
        _assert_invalid(sim,"BUNDLE_PRIVACY_VIOLATION","PRIVACY")
    assert sim.enforce().returncode == 0
    sim.assert_twins({path:public for path in TWIN_PATHS})
    assert _key_paths(json.loads(public)) == _key_paths(json.loads((sim.repo/TWIN_PATHS[0]).read_bytes()))
    assert "unsafe private exception" not in b"".join(sim.files.values()).decode()
    sim.assert_sources()


@pytest.mark.parametrize("case,terminal,verdict", [
    ("hard","QUALITY_GATE_FAILED","FAIL"),
    ("schema","SCHEMA_VIOLATIONS","PASS"),
    ("smoke","BATCH_READY","PASS"),
])
def test_oi04_failed_run_preserves_exact_committed_twins(integration_root, case, terminal, verdict):
    sim = _scenario(integration_root,case,case)
    sim.producer()
    if case == "smoke":
        assert any(e["event"] == "publish" for e in sim.logs["candidate-funnel-build"])
        assert (sim.repo/TWIN_PATHS[0]).read_bytes() != sim.before[TWIN_PATHS[0]]
    sim.smoke()
    if case == "smoke":
        assert sim.smoke_status == "smoke_failed"
        assert next(e["code"] for e in sim.logs["candidate-funnel-smoke"] if e["event"] == "cli_exit") == 1
        assert "new twins were safely rolled back" in sim.results["candidate-funnel-smoke"].stderr
    else:
        assert sim.batch_status == "batch_failed" and sim.smoke_status is None
    sim.assert_twins(sim.before)
    assert sim.consumer().returncode == 0
    _assert_captured(sim,terminal,verdict)
    assert sim.enforce().returncode == 1
    sim.retain_bundle_and_cleanup()
    sim.assert_twins(sim.before)


def test_oi05_skipped_smoke_remains_not_run(integration_root):
    sim = _scenario(integration_root,"not-run","hard")
    sim.producer()
    sim.smoke()
    assert sim.smoke_status is None  # schema-3's representation of NOT_RUN
    assert sim.output["candidate-funnel-smoke"] == {}
    assert sim.logs["candidate-funnel-smoke"] == []
    assert sim.consumer().returncode == 0
    _assert_captured(sim,"QUALITY_GATE_FAILED","FAIL")
    assert sim.evidence["workflowStatus"] == {"batchStatus":"batch_failed","smokeStatus":None}
    assert b"smoke_passed" not in b"".join(sim.files.values())
    assert sim.enforce().returncode == 1
    sim.assert_twins(sim.before)


@pytest.mark.parametrize("variant,code,stage,detail", [
    ("missing_handoff","STALE_HANDOFF","STORAGE",None),
    ("missing_observation","HANDOFF_LOCATION_INVALID","STORAGE",None),
    ("missing_capture","HANDOFF_LOCATION_INVALID","STORAGE",None),
    ("missing_receipt","HANDOFF_LOCATION_INVALID","STORAGE",None),
    ("invalid_observation","OBSERVATION_DIGEST_MISMATCH","STORAGE",None),
    ("invalid_receipt","BATCH_RECEIPT_INVALID","STORAGE","DIGEST_MISMATCH"),
    ("invalid_capture","INPUT_IDENTITY_MISMATCH","STORAGE",None),
    ("invalid_envelope","TRANSPORT_DIGEST_MISMATCH","STORAGE",None),
    ("changed_digest","TRANSPORT_DIGEST_MISMATCH","STORAGE",None),
    ("wrong_run","RUN_ID_MISMATCH","REFERENCE",None),
    ("wrong_attempt","RUN_ATTEMPT_MISMATCH","REFERENCE",None),
    ("wrong_source","SOURCE_IDENTITY_MISMATCH","REFERENCE",None),
    ("run_before_missing","RUN_ID_MISMATCH","REFERENCE",None),
    ("invalid_canonical","HANDOFF_MALFORMED","ADMISSION","NONCANONICAL_ENCODING"),
])
def test_oi06_missing_invalid_mixed_handoff_has_no_fallback(integration_root, variant, code, stage, detail):
    sim = _scenario(integration_root,variant)
    sim.producer()
    sim.smoke()
    directory = sim.handoff/f"run-{RUN_ID}"/"attempt-1"
    reference = dict(sim.reference)  # independent producer output, before corruption
    observation = directory/f"observation-{reference['p14_observation_digest']}.json"
    paths = {"handoff":directory/"handoff.json","envelope":directory/"handoff.json","observation":observation,
             "capture":directory/"capture-input.json","receipt":directory/"batch-receipt.json"}
    if variant.startswith("missing_"):
        paths[variant.removeprefix("missing_")].unlink()
    elif variant.startswith("invalid_") and variant != "invalid_canonical":
        paths[variant.removeprefix("invalid_")].write_bytes(b"invalid JSON\xff")
    elif variant == "changed_digest":
        reference["p14_handoff_digest"] = "0"*64
    elif variant in {"wrong_run","run_before_missing"}:
        reference["p14_run_id"] = "900000042"
        if variant == "run_before_missing":
            paths["handoff"].unlink()
    elif variant == "wrong_attempt":
        reference["p14_run_attempt"] = "2"
    elif variant == "wrong_source":
        reference["p14_executed_git_sha"] = "3"*40
    else:
        # Digest-coherent malformed envelope reaches canonical admission. Never
        # rebuild/reseal the rejected candidate in a consumer or production path.
        raw = paths["handoff"].read_bytes() + b"\n"
        paths["handoff"].write_bytes(raw)
        reference["p14_handoff_digest"] = _sha(raw)
    before = _snapshot(sim.handoff)
    twins = {path:(sim.repo/path).read_bytes() for path in TWIN_PATHS}
    assert sim.consumer(reference=reference).returncode == 1
    _assert_invalid(sim,code,stage,detail)
    assert _snapshot(sim.handoff) == before  # no repair, reexecution or replacement
    sim.assert_twins(twins)
    sim.assert_sources()


# Frozen O regression arguments, not extra integration cases or collection.
BATCH_NODES = (
    'tests/test_candidate_funnel_batch.py::test_artifact_atomic_write_no_tmp_file_left',
    'tests/test_candidate_funnel_batch.py::test_artifact_data_public_byte_equality',
    'tests/test_candidate_funnel_batch.py::test_artifact_deterministic_repeat',
    'tests/test_candidate_funnel_batch.py::test_artifact_exact_candidate_shape',
    'tests/test_candidate_funnel_batch.py::test_artifact_exact_root_shape',
    'tests/test_candidate_funnel_batch.py::test_artifact_not_for_trading_true',
    'tests/test_candidate_funnel_batch.py::test_context_echoes_stale_threshold_and_source_updated_at',
    'tests/test_candidate_funnel_batch.py::test_context_pipeline_path_not_coerced_to_normal_when_missing',
    'tests/test_candidate_funnel_batch.py::test_context_prescreen_fallback_used_reflects_provenance',
    'tests/test_candidate_funnel_batch.py::test_ii_b_canonical_failure_after_observation_clears_session_authority',
    'tests/test_candidate_funnel_batch.py::test_ii_b_derived_per_controlled_lazy_import_runtime',
    'tests/test_candidate_funnel_batch.py::test_ii_b_disabled_adapter_does_not_read_or_touch_handoff_paths',
    'tests/test_candidate_funnel_batch.py::test_ii_b_disabled_tripwires',
    'tests/test_candidate_funnel_batch.py::test_ii_b_duplicate_attempt_cannot_emit_second_reference',
    'tests/test_candidate_funnel_batch.py::test_ii_b_escaping_exceptions_are_not_swallowed',
    'tests/test_candidate_funnel_batch.py::test_ii_b_main_dormant_or_invalid_config_is_v1_compatible',
    'tests/test_candidate_funnel_batch.py::test_ii_b_main_enabled_harness_preserves_publication_gate',
    'tests/test_candidate_funnel_batch.py::test_ii_b_main_input_failure_finalizes_and_preserves_exit',
    'tests/test_candidate_funnel_batch.py::test_ii_b_main_output_failure_is_transport_only',
    'tests/test_candidate_funnel_batch.py::test_ii_b_mode_matching_is_exact_with_complete_environment',
    'tests/test_candidate_funnel_batch.py::test_ii_b_non_p14_gate_failure_receipt',
    'tests/test_candidate_funnel_batch.py::test_ii_b_optional_acquisition_failure_preserves_v1',
    'tests/test_candidate_funnel_batch.py::test_ii_b_producer_failure_preserves_v1',
    'tests/test_candidate_funnel_batch.py::test_ii_b_public_bytes_match_audited_base',
    'tests/test_candidate_funnel_batch.py::test_ii_b_rank_vectors_boundary_and_bidirectional_ownership',
    'tests/test_candidate_funnel_batch.py::test_ii_b_raw_input_identity_uses_loaded_bytes_once',
    'tests/test_candidate_funnel_batch.py::test_ii_b_schema_violations_terminal_receipt',
    'tests/test_candidate_funnel_batch.py::test_ii_b_source_observer_failure_does_not_change_loaders',
    'tests/test_candidate_funnel_batch.py::test_ii_b_transport_failure_is_independent_of_release',
    'tests/test_candidate_funnel_batch.py::test_ii_b_unverifiable_report_uses_minimal_failure_receipt',
    'tests/test_candidate_funnel_batch.py::test_ii_c_a1_pre_commit_working_tree_provenance',
    'tests/test_candidate_funnel_batch.py::test_ii_c_fail_capable_gate_set_has_source_derived_drift_tripwire',
    'tests/test_candidate_funnel_batch.py::test_ii_c_failure_handoff_privacy_remains_fail_closed',
    'tests/test_candidate_funnel_batch.py::test_ii_c_failure_handoff_write_failure_never_emits_reference',
    'tests/test_candidate_funnel_batch.py::test_ii_c_qgf_receipt_matrix_uses_real_quality_and_finish_paths',
    'tests/test_candidate_funnel_batch.py::test_ii_c_schema_violation_ready_reference_does_not_publish',
    'tests/test_candidate_funnel_batch.py::test_ii_c_seam_reuses_same_objects_and_one_perturbation',
    'tests/test_candidate_funnel_batch.py::test_join_below_threshold_fails',
    'tests/test_candidate_funnel_batch.py::test_join_candidate_side_duplicate_code_passed_through_to_engine',
    'tests/test_candidate_funnel_batch.py::test_join_complete_all_candidates_matched',
    'tests/test_candidate_funnel_batch.py::test_join_fallback_path_missing_prescreen_metadata_file',
    'tests/test_candidate_funnel_batch.py::test_join_input_order_invariance',
    'tests/test_candidate_funnel_batch.py::test_join_numeric_string_code_collision_no_coercion',
    'tests/test_candidate_funnel_batch.py::test_join_partial_some_candidates_unmatched',
    'tests/test_candidate_funnel_batch.py::test_join_prescreen_side_duplicate_excluded_from_index_and_fails_gate',
    'tests/test_candidate_funnel_batch.py::test_join_reproduces_b1_engine_output_for_calibration_fixture',
    'tests/test_candidate_funnel_batch.py::test_join_threshold_boundary_exactly_095_passes',
    'tests/test_candidate_funnel_batch.py::test_join_unmatched_candidate_gets_no_prescreen_keys',
    'tests/test_candidate_funnel_batch.py::test_join_unmatched_prescreen_recorded_not_erroring',
    'tests/test_candidate_funnel_batch.py::test_malformed_json_candidates_stocks_raises_fail_closed',
    'tests/test_candidate_funnel_batch.py::test_malformed_json_prescreen_metadata_raises_fail_closed',
    'tests/test_candidate_funnel_batch.py::test_no_publish_on_gate_failure_leaves_existing_artifact_untouched',
    'tests/test_candidate_funnel_batch.py::test_not_generated_run_batch_does_not_publish_and_preserves_existing_artifact',
    'tests/test_candidate_funnel_batch.py::test_not_generated_status_skips_p02_through_p15_and_does_not_publish',
    'tests/test_candidate_funnel_batch.py::test_o1_p01_through_p13_and_p15_outputs_are_unchanged',
    'tests/test_candidate_funnel_batch.py::test_o1_p14_duplicate_code_gets_no_sign_consumes_no_ordinal_and_p04_fails',
    'tests/test_candidate_funnel_batch.py::test_o1_p14_frozen_metric_constants_are_unchanged',
    'tests/test_candidate_funnel_batch.py::test_o1_p14_input_is_not_mutated',
    'tests/test_candidate_funnel_batch.py::test_o1_p14_metadata_declares_exact_assignment_contract',
    'tests/test_candidate_funnel_batch.py::test_o1_p14_missing_or_invalid_identity_gets_no_sign_and_fails_closed',
    'tests/test_candidate_funnel_batch.py::test_o1_p14_missing_prescreen_rank_sorts_last_by_code',
    'tests/test_candidate_funnel_batch.py::test_o1_p14_numeric_code_is_not_coerced',
    'tests/test_candidate_funnel_batch.py::test_o1_p14_per_roe_simultaneous_vector_and_two_percent_are_exact',
    'tests/test_candidate_funnel_batch.py::test_o1_p14_primary_order_is_valid_prescreen_rank_ascending',
    'tests/test_candidate_funnel_batch.py::test_o1_p14_secondary_tie_break_is_exact_code_ascending',
    'tests/test_candidate_funnel_batch.py::test_o1_synthetic_fixture_is_separate_supporting_evidence_only',
    'tests/test_candidate_funnel_batch.py::test_p02_join_rate_exact_boundary_pass',
    'tests/test_candidate_funnel_batch.py::test_p02_join_rate_just_below_fails',
    'tests/test_candidate_funnel_batch.py::test_p04_candidate_duplicate_fails',
    'tests/test_candidate_funnel_batch.py::test_p04_no_duplicate_passes',
    'tests/test_candidate_funnel_batch.py::test_p07_degenerate_population_fails',
    'tests/test_candidate_funnel_batch.py::test_p07_iqr_and_range_pass_with_calibration_fixture',
    'tests/test_candidate_funnel_batch.py::test_p08_deep_review_positive_passes_with_calibration_fixture',
    'tests/test_candidate_funnel_batch.py::test_p08_deep_review_zero_fails',
    'tests/test_candidate_funnel_batch.py::test_p10_sector_breadth_fails_with_single_sector',
    'tests/test_candidate_funnel_batch.py::test_p10_sector_breadth_passes_with_calibration_fixture',
    'tests/test_candidate_funnel_batch.py::test_p12_inactive_v1_soft_reasons_are_zero_and_gate_passes',
    'tests/test_candidate_funnel_batch.py::test_p13_degraded_path_actionable_zero_structurally_via_engine',
    'tests/test_candidate_funnel_batch.py::test_p13_detects_violation_via_direct_gate_call',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_actionable_more_than_three_exits_stays_fail',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_actionable_one_exit_no_actionable_specific_warn',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_actionable_three_exits_is_fail',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_actionable_two_exits_is_warn',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_calibration_fixture_rank_vectors_unchanged_by_evidence_computation',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_calibration_fixture_reports_decision_aware_deep_review_warn',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_deep_review_multiple_exits_stay_warn_no_invented_hard_threshold',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_deep_review_one_exit_is_warn',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_deep_review_zero_exit_no_warn',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_determinism_same_input_twice_identical_evidence',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_does_not_mutate_engine_or_perturbed_results',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_evidence_composite_fields_present',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_evidence_reasons_are_machine_readable_and_reproducible',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_hard_backstop_still_blocks_publish',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_jaccard_below_hard_min_is_fail',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_jaccard_exact_hard_boundary_is_warn_not_fail',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_jaccard_exact_warn_boundary_is_pass',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_jaccard_swap_matrix',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_market_reference_shortlist_code_replacement_is_fail',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_market_reference_shortlist_eligibility_requires_tier_and_valid_rank',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_market_reference_shortlist_n_is_deterministic_3',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_market_reference_shortlist_name_and_n_and_holdings_independence',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_market_reference_shortlist_order_only_change_is_warn',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_market_reference_shortlist_tier_change_is_fail',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_market_reference_shortlist_unchanged_ordered_list_is_pass',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_reference_order_parity_comparator_function_handles_null_generically',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_reference_order_parity_distinct_market_ranks',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_reference_order_parity_equal_market_ranks_use_artifact_index_tie_break',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_reference_order_parity_null_rank_excluded_at_comparator_boundary',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_reference_order_parity_stable_deterministic_replay',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_severity_multiple_hard_stays_fail',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_severity_multiple_warn_stays_warn',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_severity_pass_only',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_severity_warn_only',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_severity_warn_plus_hard_is_fail',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_top40_retention_is_record_only_not_a_duplicate_hard_gate',
    'tests/test_candidate_funnel_batch.py::test_p14_d2_warn_status_does_not_block_publish',
    'tests/test_candidate_funnel_batch.py::test_p14_phase_ii_batch_import_contract',
    'tests/test_candidate_funnel_batch.py::test_p14_rank_stability_top40_jaccard_is_perfect_with_calibration_fixture',
    'tests/test_candidate_funnel_batch.py::test_p15_no_baseline_records_none',
    'tests/test_candidate_funnel_batch.py::test_p15_rank_drift_vs_previous_recorded',
    'tests/test_candidate_funnel_batch.py::test_prescreen_duplicate_gate_fails_when_prescreen_has_duplicate_code',
    'tests/test_candidate_funnel_batch.py::test_publish_artifact_cleans_up_data_tmp_when_first_replace_fails',
    'tests/test_candidate_funnel_batch.py::test_publish_artifact_first_publish_rolls_back_to_absent_on_public_failure',
    'tests/test_candidate_funnel_batch.py::test_publish_artifact_rolls_back_data_copy_when_public_replace_fails',
    'tests/test_candidate_funnel_batch.py::test_publish_artifact_surfaces_both_errors_when_rollback_itself_fails',
    'tests/test_candidate_funnel_batch.py::test_read_current_regime_missing_file_returns_none',
    'tests/test_candidate_funnel_batch.py::test_read_current_regime_unknown_value_returns_none',
    'tests/test_candidate_funnel_batch.py::test_read_current_regime_valid_value',
)
