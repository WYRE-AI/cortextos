"""Behavioral tests for mmrag._retry_with_backoff.

Run from knowledge-base/scripts:

    python -m _test_clients.test_retry

Exits 0 on all-pass, 1 on any failure.

_retry_with_backoff is the single retry implementation shared by both
generate_content and embed_content call sites (consolidated 2026-09-03,
task_1788420454462_38838015, from two near-identical ~25-line copies —
embed_content originally had no retry at all while generate_content did;
adding a second copy for embed_content was the wrong depth for that fix).
Each scenario below is run against BOTH a generate_content-shaped call and
an embed_content-shaped call, via the shared `_run` helper, so the suite
proves the one implementation behaves identically regardless of which real
call site wraps it — that is the property the consolidation is supposed to
guarantee, and a single-call-shape test would not exercise it.

  1. transient_then_success: 429/503 -> 200 -> returns response, no raise
  2. all_exhausted: 3x transient -> raises last APIError
  3. fail_fast_nontransient: 403 -> raises immediately; proves the predicate
     is structural (.code / .status), not textual

backoffs is passed as (0, 0, 0) so tests run in milliseconds.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag
from _test_clients import fault_injection


FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


# Each entry: (call-shape name, script -> client, fn(client) -> the callable to
# retry, attempts-consumed accessor). Covers both real call sites so the shared
# retry implementation is proven against both shapes, not just one.
CALL_SHAPES = {
    "generate_content": dict(
        make_client=lambda script: fault_injection.FaultInjectionClient(script),
        make_fn=lambda client: (lambda: client.models.generate_content(model="x", contents=["x"])),
        attempts=lambda client: client.models._index,
        response_ok=lambda r: getattr(r, "text", None) == "hello world",
    ),
    "embed_content": dict(
        make_client=lambda script: fault_injection.FaultInjectionClient([], embed_script=script),
        make_fn=lambda client: (lambda: client.models.embed_content(model="x", contents="x", config=None)),
        attempts=lambda client: client.models._embed_index,
        response_ok=lambda r: getattr(r.embeddings[0], "values", None) == [0.1, 0.2, 0.3],
    ),
}


def test_transient_then_success(shape_name, shape):
    print(f"\n[{shape_name}] transient_then_success: 429 -> 200")
    client = shape["make_client"](fault_injection._parse_script("429:quota exhausted,200:hello world"))
    response = mmrag._retry_with_backoff(shape["make_fn"](client), label=shape_name, backoffs=(0, 0, 0))
    _check(f"{shape_name}: returns response after one transient", response is not None)
    _check(f"{shape_name}: response matches scripted success", shape["response_ok"](response))
    _check(f"{shape_name}: consumed exactly 2 attempts", shape["attempts"](client) == 2,
           detail=f"got {shape['attempts'](client)}")


def test_all_exhausted(shape_name, shape):
    print(f"\n[{shape_name}] all_exhausted: 429 -> 429 -> 429 -> re-raise")
    client = shape["make_client"](fault_injection._parse_script("429,429,429"))
    raised = None
    try:
        mmrag._retry_with_backoff(shape["make_fn"](client), label=shape_name, backoffs=(0, 0, 0))
    except Exception as e:
        raised = e
    _check(f"{shape_name}: raises after all attempts exhausted", raised is not None)
    if raised is not None:
        _check(f"{shape_name}: raised.code is 429", getattr(raised, "code", None) == 429)
        _check(f"{shape_name}: raised.status is RESOURCE_EXHAUSTED",
               getattr(raised, "status", None) == "RESOURCE_EXHAUSTED")
    _check(f"{shape_name}: consumed exactly 3 attempts", shape["attempts"](client) == 3,
           detail=f"got {shape['attempts'](client)}")


def test_fail_fast_nontransient(shape_name, shape):
    print(f"\n[{shape_name}] fail_fast_nontransient: 403 -> raises immediately")
    client = shape["make_client"](fault_injection._parse_script("403:Permission denied,200:should not reach"))
    raised = None
    try:
        mmrag._retry_with_backoff(shape["make_fn"](client), label=shape_name, backoffs=(0, 0, 0))
    except Exception as e:
        raised = e
    _check(f"{shape_name}: raises immediately on non-transient", raised is not None)
    if raised is not None:
        _check(f"{shape_name}: raised.code is 403", getattr(raised, "code", None) == 403)
        _check(f"{shape_name}: raised.status is PERMISSION_DENIED",
               getattr(raised, "status", None) == "PERMISSION_DENIED")
    _check(f"{shape_name}: did NOT consume the second scripted attempt (predicate is structural)",
           shape["attempts"](client) == 1, detail=f"got {shape['attempts'](client)}")


def test_shapes_are_independently_scriptable():
    """Guards the fault-injection double itself: scripting one call shape must
    not leak into or block the other on the same client."""
    print("\n[cross-shape] generate_content and embed_content script independently on one client")
    client = fault_injection.FaultInjectionClient(
        fault_injection._parse_script("200:generate ok"),
        embed_script=fault_injection._parse_script("200"),
    )
    gen = mmrag._retry_with_backoff(
        lambda: client.models.generate_content(model="x", contents=["x"]),
        label="generate_content", backoffs=(0, 0, 0),
    )
    _check("generate_content returns its own scripted response", getattr(gen, "text", None) == "generate ok")
    emb = mmrag._retry_with_backoff(
        lambda: client.models.embed_content(model="x", contents="y", config=None),
        label="embed_content", backoffs=(0, 0, 0),
    )
    _check("embed_content returns its own separately-scripted response",
           getattr(emb.embeddings[0], "values", None) == [0.1, 0.2, 0.3])


if __name__ == "__main__":
    for shape_name, shape in CALL_SHAPES.items():
        test_transient_then_success(shape_name, shape)
        test_all_exhausted(shape_name, shape)
        test_fail_fast_nontransient(shape_name, shape)
    test_shapes_are_independently_scriptable()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print(f"ALL PASS ({3 * len(CALL_SHAPES) + 1} scenarios)")
    sys.exit(0)
