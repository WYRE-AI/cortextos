"""Fault-injecting Gemini client for testing mmrag._retry_with_backoff.

Wired via two env vars consumed by mmrag.get_genai_client:

    MMRAG_GEMINI_CLIENT_FACTORY=_test_clients.fault_injection:make_client
    MMRAG_FAULT_INJECTION_SCRIPT="503,503,200"

The script is a comma-separated list of one entry per generate_content() call.
Each entry is either "<code>" or "<code>:<message>". Code 200 returns a stub
success response; any other code raises an APIError with the corresponding
status name.

Code -> status mapping (set is intentionally narrow — covers what the retry
loop predicate distinguishes between transient and non-transient):

    429 -> RESOURCE_EXHAUSTED   (transient)
    500 -> INTERNAL             (transient by HTTP code)
    503 -> UNAVAILABLE          (transient)
    400 -> INVALID_ARGUMENT     (non-transient)
    401 -> UNAUTHENTICATED      (non-transient)
    403 -> PERMISSION_DENIED    (non-transient)
"""

import os
from google.genai.errors import APIError


_STATUS_FOR_CODE = {
    429: "RESOURCE_EXHAUSTED",
    500: "INTERNAL",
    503: "UNAVAILABLE",
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
}


class _InjectedAPIError(APIError):
    """APIError subclass that sets .code/.status/.message directly.

    Avoids invoking APIError.__init__ because the SDK's constructor expects a
    real HTTP response object and parses response_json in version-specific
    ways. Subclassing preserves `except google.genai.errors.APIError` catches
    in callers (an _InjectedAPIError is-a APIError).
    """
    def __init__(self, code, status, message=""):
        Exception.__init__(self, message)
        self.code = code
        self.status = status
        self.message = message


class _StubResponse:
    def __init__(self, text):
        self.text = text
        self.usage_metadata = None


class _StubEmbedding:
    def __init__(self, values):
        self.values = values


class _StubEmbedResponse:
    def __init__(self, values):
        self.embeddings = [_StubEmbedding(values)]


def _next_scripted(script, index, kind):
    if index >= len(script):
        raise RuntimeError(
            f"fault_injection: {kind} script exhausted at attempt {index + 1} "
            f"(scripted {len(script)} responses)"
        )
    return script[index]


class _StubModels:
    def __init__(self, script, embed_script=None):
        self._script = list(script)
        self._index = 0
        # embed_content is scripted SEPARATELY from generate_content — added
        # 2026-09-03 (task_1788420454462_38838015, _retry_embed_content) so
        # a test can drive one call type without needing to also script the
        # other. Kept as None (raises like before) when no test needs it.
        self._embed_script = list(embed_script) if embed_script is not None else None
        self._embed_index = 0

    def generate_content(self, model=None, contents=None, **kwargs):
        code, message = _next_scripted(self._script, self._index, "generate_content")
        self._index += 1
        if code == 200:
            return _StubResponse(message or "[stub] fault-injection success")
        status = _STATUS_FOR_CODE.get(code, "UNKNOWN")
        raise _InjectedAPIError(code, status, message or f"injected {code} {status}")

    def embed_content(self, model=None, contents=None, config=None, **kwargs):
        if self._embed_script is None:
            raise RuntimeError(
                "fault_injection: embed_content is not scripted for this client. "
                "Construct FaultInjectionClient(script, embed_script=...) to test it."
            )
        code, message = _next_scripted(self._embed_script, self._embed_index, "embed_content")
        self._embed_index += 1
        if code == 200:
            return _StubEmbedResponse([0.1, 0.2, 0.3])
        status = _STATUS_FOR_CODE.get(code, "UNKNOWN")
        raise _InjectedAPIError(code, status, message or f"injected {code} {status}")


class FaultInjectionClient:
    def __init__(self, script, embed_script=None):
        self.models = _StubModels(script, embed_script=embed_script)


def _parse_script(spec):
    entries = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if ":" in chunk:
            code_s, message = chunk.split(":", 1)
        else:
            code_s, message = chunk, ""
        entries.append((int(code_s), message))
    return entries


def make_client(api_key=None):
    """Factory entry point. Signature matches the real Client constructor;
    api_key is accepted but ignored — fault injection is fully driven by
    MMRAG_FAULT_INJECTION_SCRIPT.
    """
    spec = os.environ.get("MMRAG_FAULT_INJECTION_SCRIPT", "200")
    return FaultInjectionClient(_parse_script(spec))
