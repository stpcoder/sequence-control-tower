# Vertex LLM verification

Vertex is an optional endpoint for substitute verification of the OpenAI-compatible transport when the development environment cannot reach the local vLLM service. It is not a product name, a new provider path, or a replacement for the default local vLLM configuration.

## Default automated verification

The default verification uses the local HTTP mock for the Vertex OpenAI-compatible endpoint in `tests/support/vertex-openai-mock.ts`. It runs without Google credentials, ADC, `gcloud`, a credential file, or real network access. It verifies:

- the Vertex OpenAI-compatible URL path, HTTP method, configured model, and `Authorization` header;
- a delayed successful response and recorded latency/usage;
- `429` handling, `Retry-After`, and retry behavior;
- timeout and in-flight cancellation without an unnecessary retry; and
- local RPM/TPM limits, including queueing and rejection when a request exceeds the TPM budget.

Run the focused tests and type check with:

```sh
npx vitest run tests/domain/llm-client.vertex-mock.test.ts
npx vitest run tests/domain/llm-client.test.ts
npm run typecheck
```

The Vertex-specific assertions are in `tests/domain/llm-client.vertex-mock.test.ts`; the shared transport, timeout, cancellation, retry, and RPM/TPM limiter assertions are in `tests/domain/llm-client.test.ts`.

## One approved live smoke: 2026-08-04

This is one approved live smoke result, separate from the local mock tests above. The approved live harness recorded:

- ADC parsed successfully.
- A quota project was present.
- OAuth returned HTTP 200.
- Vertex OpenAI-compatible chat completions returned HTTP 200.
- `choices[0]` was present.
- Latency was 1–3 seconds.
- Model: `google/gemini-2.5-flash`.

No project IDs, credentials, prompts, or response bodies were persisted. This single smoke result does not add a Vertex provider or a Vertex-specific product path to the app.

## Optional approved live harness

The automated checks above do not prove that a real Vertex request succeeds. A real Vertex call may be checked only when a separately approved live-verification harness and authorized access are available. That harness is outside the default test path and must document its own project, location, model, endpoint, and credential handling. Do not add a UI procedure or claim live-call success based on the local mock tests.

Never place access tokens or other secret values in this document, source control, saved project settings, command history, test output, or logs. Inject credentials only through the approved harness, keep them short-lived, and remove them from the environment and any temporary configuration immediately after the run. If a token is printed, persisted, or otherwise exposed, stop using it and rotate or revoke it according to the owning service's procedure.
