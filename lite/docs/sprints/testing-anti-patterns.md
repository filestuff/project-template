# Testing Anti-Patterns

Reference for the **Testing** section of a sprint and PROTOCOL Phase 2 (test-first). Tests exist
to catch real regressions; a test that can't fail when the code breaks is worse than no test —
it manufactures false confidence. Each pattern below ships a **gate** — a check to run *before*
you write the test.

## 1. Don't test the mock

A test that asserts a mock returned what you told it to return verifies nothing about your code.

- **Gate:** before asserting, ask "if the real implementation were completely broken, would this
  test still pass?" If yes, you're testing the mock. Assert on *your code's* behavior/output, not
  the mock's configured return.

## 2. Derive mocks from the interface, not the implementation

If you copy a mock's shape from the code under test, you bake that code's bugs into the test —
both agree, both are wrong, runtime crashes. (Real failure: a mock built around a buggy
`cleanup()` while the actual interface method was `close()`; tests green, production broke.)

- **Gate:** write the mock from the *interface/contract* (types, docs, the real API) **before**
  reading the implementation. If you must look at the implementation to know the shape, stop and
  find the interface.

## 3. Mirror the COMPLETE real data structure

A mock that includes only the two fields your test reads passes today and breaks when the code
starts using a third field your mock never had.

- **Gate:** mock the full shape the real dependency returns, not a convenient subset.

## 4. Mock at the lowest level you understand

Mocking a high-level method whose side effects you don't understand silently drops behavior the
test depends on.

- **Gate:** if you're unsure what a method does (DB writes? cache? events?), run the test
  against the **real** implementation first to learn the dependency, then mock the narrowest
  thing.

## 5. Test real behavior, not implementation details

Asserting on private internals / call order couples the test to *how* the code works, so a safe
refactor breaks the test. Assert on observable behavior and outputs.

- **Gate:** "would this test still pass after a behavior-preserving refactor?" It should.

## 6. Verify the observable difference, not just success

A "200 OK" or "no error thrown" is not proof the right thing happened. Assert the *difference
the change was supposed to produce* (the new value in the response body, the row actually
written, the model name that came back — not merely that the call returned).

- **Gate:** name the observable difference this change creates, and assert on *that*.

---

When test-first genuinely doesn't fit (exploratory spike, pure config, visual/UI work), say so
in the sprint's Testing section and state how the deliverable is verified instead — don't skip
verification silently.
