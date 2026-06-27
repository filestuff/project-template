# Condition-Based Waiting

Reference for `/debug` Phase 1 when a failure is timing-dependent — a flaky test, a race that
only fails under load, "works locally, fails in CI / when parallel." Most such flakiness comes
from **waiting a fixed amount of time** instead of **waiting for the condition you actually need**.

## The anti-pattern

```
do_async_thing()
sleep(100)              # hope it's done by now
assert(result_ready())  # flaky: too short → fails; too long → slow
```

A fixed sleep is wrong both ways: too short and the test flakes; too long and every run pays the
cost. It encodes a guess about timing, not the real dependency.

## The fix: poll for the condition, with a timeout

```
waitFor(() => result_ready(), { timeoutMs: 5000, intervalMs: 10 })
assert(result_ready())
```

`waitFor` returns as soon as the condition holds (fast in the common case) and fails loudly with
a timeout if it never does (no silent hang). Poll on a short interval (~10ms); **always** pass a
timeout so a genuinely-stuck system fails the test instead of hanging it.

Sketch of the helper (adapt to the project's language/test framework):

```
async function waitFor(condition, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await condition()) return;
    await delay(intervalMs);
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}
```

Most ecosystems already ship this — prefer the native one over rolling your own:
- Test frameworks: `waitFor` / `findBy*` (Testing Library), `eventually` (RSpec),
  `Awaitility` (JVM), `expect.poll` / `toPass` (Playwright), `Eventually` (Gomega).
- Wait on the **specific observable** (an element, a row, a status, a log line), not a generic
  "is it done yet" flag.

## Why this matters for parallel sprints

When several agents run sprints concurrently (full tier) and their tests share a machine, fixed
sleeps that "usually pass" start failing under contention. Condition-based waiting keeps tests
deterministic regardless of how loaded the box is — a prerequisite for trusting `gate.sh` results
across parallel work.

## Rule

Replace every arbitrary `sleep`/`setTimeout`-then-assert with a condition wait that has a
timeout. If you cannot express the condition, you don't yet understand what you're waiting for —
return to `/debug` Phase 1.
