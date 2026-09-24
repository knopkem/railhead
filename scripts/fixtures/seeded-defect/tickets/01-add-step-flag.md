# 01: Add a --step flag

**Mission:** The counter CLI must start at 1 and count up from there.

**What to build:** Parse an optional `--step N` argument in `counter.mjs`. When present, print the count advanced by N; when absent, preserve the existing output exactly.

**Blocked by:** None (can start immediately)
**Files to read/use:**
- `counter.mjs`
- `test/counter.test.mjs`
**Expected new contracts:**
- (none)
**Testable:** yes

**Status:** ready-for-agent

- [ ] `node counter.mjs --step 3` prints the count advanced by 3
- [ ] `node counter.mjs` still prints the count as before
- [ ] `node --test` passes
