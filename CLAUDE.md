# Claude Code Context for Decay Roguelike

## GitHub CLI (gh)

The `gh` CLI is installed but NOT in PATH. Use full path:
```bash
/Users/jamesmcclave/bin/gh
```

**Creating a gist:**
```bash
/Users/jamesmcclave/bin/gh gist create /path/to/file.md --public --desc "Description"
```

**Check auth status:**
```bash
/Users/jamesmcclave/bin/gh auth status
```

Already authenticated as `ultramegaok` with gist, repo, read:org scopes.

---

## Chrome MCP Control Techniques

**IMPORTANT:** When encountering Chrome MCP issues, document them in `CHROME_MCP_ISSUES.md` with the problem, cause, and solution. This log helps avoid repeating mistakes.

### Issue: Isolated Content Script World
The `mcp__chrome-control__execute_javascript` tool runs in an **isolated content script world**, NOT the page's main JavaScript context. Page variables like `gameState`, `runBotGame`, etc. are undefined.

**Solution: Inject script elements:**
```javascript
const script = document.createElement('script');
script.textContent = `
  (async function() {
    try {
      const result = await runBotGame('oracle', 3000, 500, 5);
      document.body.setAttribute('data-result', JSON.stringify(result));
    } catch (e) {
      document.body.setAttribute('data-result', 'ERROR: ' + e.message);
    }
  })();
`;
document.body.appendChild(script);
```

Then read results with:
```javascript
document.body.getAttribute('data-result')
```

### Best Practices for Chrome Control

1. **Always reload tab after file edits** - Use `mcp__chrome-control__reload_tab` before running tests. Otherwise you'll run against stale code.

2. **Use unique data-attribute names** - Use `data-test-results`, `data-bot-result`, etc. to avoid collisions between different test runs.

3. **Wrap async code in IIFE with try/catch** - Page errors won't propagate to the MCP result. Always capture errors to the data attribute.

4. **Poll for async results** - After injecting a script that runs an async operation, call `getAttribute` in a subsequent `execute_javascript` call. The test suite can take 10-30 seconds.

5. **Results are strings** - Always use `JSON.stringify()` when storing results to data attributes, and `JSON.parse()` when reading them back.

6. **No console.log access** - Cannot read `console.log` output from MCP. All debugging output must go to data attributes or DOM elements.

### Common Patterns

**Run test suite:**
```javascript
// Inject
const script = document.createElement('script');
script.textContent = `
  (async function() {
    try {
      const results = await OracleTestSuite.runAll();
      document.body.setAttribute('data-test-results', JSON.stringify(results));
    } catch (e) {
      document.body.setAttribute('data-test-results', 'ERROR: ' + e.message);
    }
  })();
`;
document.body.appendChild(script);

// Later, read results
document.body.getAttribute('data-test-results')
```

**Run single bot game:**
```javascript
// Inject
const script = document.createElement('script');
script.textContent = `
  (async function() {
    try {
      const result = await runBotGame('oracle', 3000, 500, 5);
      document.body.setAttribute('data-bot-result', JSON.stringify(result));
    } catch (e) {
      document.body.setAttribute('data-bot-result', 'ERROR: ' + e.message);
    }
  })();
`;
document.body.appendChild(script);
```

### Gotchas

1. **File not found errors**: Sometimes the page needs a hard refresh (close tab, reopen) if reload doesn't pick up changes.

2. **~~Large result truncation~~**: **DEBUNKED** - See "Critical Learnings" below. There is NO truncation.

3. **Script persistence**: Injected scripts persist until page reload. Multiple injections can cause duplicate execution.

4. **Tab ID changes**: `open_url` may create a new tab with different ID. Always use `get_current_tab` after navigation.

5. **"missing value" returns**: `execute_javascript` often returns "missing value" even when successful. This is an AppleScript serialization quirk, especially with script elements. Don't rely on return values - use data attributes.

6. **Cache busting**: Add `?v=N` query param when testing file changes: `file:///path/to/file.html?v=2`

7. **Property name mismatches**: Bot functions return `{ action: 'move' }` not `{ type: 'move' }`. Use existing wrappers like `executeBotMove()`.

8. **Canvas element IDs**: Verify the actual canvas ID (e.g., `game-canvas` not `game`) by grepping the source.

See `CHROME_MCP_ISSUES.md` for detailed issue documentation and solutions.

---

## Critical Chrome MCP Learnings (Session 18 - 2026-01-16)

### The Big Discovery: NO Truncation Exists

After systematic testing, **there is NO string truncation** in the MCP or AppleScript layers:

| Test | Size | Result |
|------|------|--------|
| AppleScript direct | 50KB | ✅ Full string returned |
| MCP direct return | 15KB | ✅ Full string returned |
| MCP localStorage read | 14.5KB | ✅ Full string returned |
| MCP data attribute read | 15KB | ✅ Full string returned |

The apparent "truncation" was actually caused by **script injection failures**.

### Direct Access vs Script Injection

**MCP content scripts CAN directly access:**
- `localStorage.getItem()` / `setItem()` - NO injection needed!
- `sessionStorage`
- `document` (full DOM manipulation)
- Data attributes

**Script injection is ONLY needed for:**
- Page-defined variables (`window.gameState`, custom functions)
- Calling functions defined in the page's JavaScript

**Example - Direct localStorage access (preferred):**
```javascript
// This works perfectly - no script injection!
localStorage.getItem("img0")  // Returns full 14,454 char base64 string
localStorage.getItem("img0").length  // Returns 14454
```

### Script Injection Reliability

| Condition | Success Rate |
|-----------|--------------|
| After fresh page reload | **100/100 (100%)** |
| After many MCP operations | Degrades over time |
| After accumulated errors | Often fails silently |

**Key insight:** Script injection state degrades over many operations. Page reload resets everything.

**Reliable script injection pattern:**
```javascript
// After page reload, this works 100% of the time:
var s = document.createElement('script');
s.textContent = 'document.body.dataset.result = somePageFunction()';
document.body.appendChild(s);
// Then read: document.body.dataset.result
```

### Best Practices (Updated)

1. **Use direct access when possible** - localStorage, sessionStorage, DOM don't need injection
2. **Reload page before critical operations** - Resets state, ensures 100% injection reliability
3. **Don't trust return values** - Always verify via data attributes
4. **For large data export** - Add functions to page code, trigger via MCP (control channel pattern)
5. **Keep operations simple** - Avoid complex loops in single MCP calls

### The "Control Channel" Architecture

For data-intensive operations, treat MCP as a **control channel**, not a **data channel**:

```
WRONG (fragile):
  Claude → MCP → Chrome → [extract 30KB data] → MCP → Claude

RIGHT (robust):
  Claude → MCP → Chrome → [call exportFunction()] → Browser downloads file
  MCP only sends: "downloadPlaythroughHTML(1007)"
```

### Environment Tested
- Chrome 144.0.7559.59
- macOS 26.2 (Build 25C56)
- "Allow JavaScript from Apple Events": ENABLED (verified)

### Documentation
- Detailed issues: `CHROME_MCP_ISSUES.md`
- Comprehensive analysis: `CHROME_MCP_COMPREHENSIVE_ISSUES.md`
- Public gist: https://gist.github.com/ultramegaok/bf14e856f585450984035c6901381193

---

## Project Structure

- `roguelike.html` - Main game file (~5500 lines), single-file browser game
- `CLAUDE_CONTEXT.md` - Detailed debugging notes and session history
- `DESIGN_DECISIONS.md` - Core design choices
- `OPTIMIZATION_PLAN.md` - Performance optimization roadmap from ChatGPT audit
- `STRETCH_GOALS.md` - Future feature ideas
- `decay-roguelike-spec.md` - Original game specification

---

## Key Architecture (roguelike.html)

### Important Functions
| Function | Purpose |
|----------|---------|
| `coordIdx(x, y)` | Fast coord-to-index: `y * CONFIG.mapWidth + x` |
| `processChainCollapses()` | Real game chain collapse (has safe bubble) |
| `simProcessChainCollapses()` | Simulation chain collapse (has safe bubble) |
| `oracleBotMove()` | Oracle bot - full path simulation |
| `greedyBotMove()` | Greedy bot - walk toward stairs |
| `generateCandidatePaths()` | Generate 30+ path candidates for oracle |
| `simulatePath()` | Simulate a path with stabilizer decisions |
| `runBotGame()` | Run a bot on a seed, returns result |
| `runComparativeTests()` | Compare greedy vs tactical on same seeds |

### Tile Constants
```javascript
TILE.VOID = -1
TILE.WALL = 0
TILE.FLOOR = 1
TILE.STAIRS_DOWN = 2  // NOT "TILE.STAIRS"
```

---

## Performance History

| Session | Performance | Notes |
|---------|-------------|-------|
| Baseline | ~12s/seed | Before optimizations |
| Session 11 | ~1.5s/seed | Queue + string key optimizations |
| Session 12 | ~700ms/seed | BFS distance field, plan commitment |
| Session 13 | ~608ms/seed | Action scripts, sim fixes |
| Target | <300ms/seed | With horizon extension |

### Optimizations Done
1. `.shift()` → index-based queues (12 locations)
2. String keys → `coordIdx()` integer keys (40+ locations)
3. A* sort descending + `pop()` instead of ascending + `shift()`
4. BFS distance field for stairs
5. Plan commitment with action scripts
6. simPillarBonus centering fix

### Optimizations Planned (Session 14)
1. Plan horizon extension (6 → 10 steps)
2. Mechanic-exerciser shadow-step test
3. 100+ seed dominance testing

---

## Design Decisions

1. **Safe Bubble**: Frozen tiles (from stabilizer) are immune to chain collapse shock
2. **Distance Metric**: Chebyshev (8-directional movement with uniform cost)
3. **Pillar Adjacency**: 8-neighbor for bonus, consistent everywhere
4. **Decay Rate**: Half-rate for Level 2, half-rate for pillar-adjacent, combined = 25%

---

## ChatGPT Collaboration Workflow

**IMPORTANT:** Create a gist at each major step in the plan for ChatGPT review.

### Gist Creation Process
1. Create summary markdown with:
   - Current state (test results, performance)
   - What was accomplished
   - Questions for ChatGPT
   - Next steps/plan
2. Append full codebase at the end
3. Upload to GitHub gist
4. User shares with ChatGPT for feedback

### When to Create Gists
- Before starting a new session/phase
- After completing major milestones
- When blocked and need external input
- Before implementing significant changes

### Gist Format
```markdown
# Session N Summary

## Current State
- Test results, performance metrics

## Accomplishments
- What was done

## Questions for ChatGPT
- Specific technical questions

## Plan
- Next steps

---
## Code Follows Below
[Full roguelike.html appended]
```

---

## Gist History

- Original: https://gist.github.com/ultramegaok/1c6d9113981a0aac9a9f241644e8db52
- Session 11: https://gist.github.com/ultramegaok/7964581ac518916343635eea28519373
- Session 13 (pre): https://gist.github.com/ultramegaok/740cc62baa5fe57cddcb0ad6f53120e6

---

## Testing

**Run oracle on a seed:**
```javascript
await runBotGame('oracle', 3000, 500, 5)  // seed, maxMoves, maxRewinds, targetLevel
```

**Run comparative test:**
```javascript
await runComparativeTests(5, 5, 3000)  // numGames, targetLevel, seedOfSeeds
```

**Test suite (if OracleTests defined):**
```javascript
await OracleTests.runAll()
```

---

## Replay Generation

**CRITICAL:** When making breaking changes (new mechanics, stabilizer changes, movement changes, etc.):
1. Bump `REPLAY_VERSION` and `SAVE_VERSION` in roguelike.html
2. Regenerate showcase replays: `node test-runner.js --replays 3`
3. Old saves are auto-cleared on version mismatch at init

**Generate showcase replays (headless via Puppeteer):**
```bash
node test-runner.js --replays 3          # 3 replays from seeds 1000-2000
node test-runner.js --replays 5 500 1500 # 5 replays from seeds 500-1500
```

This scans seeds, ranks by interest (stabilizers, grapples, rewinds, close calls), records the top N as oracle replays, and writes them directly into `roguelike.html`'s `BUILT_IN_REPLAYS` array.

**In-browser (for debugging):**
```javascript
generateShowcaseReplays(3, 1000, 2000)  // returns replays, stores JSON on data-showcase-replays
```

---

## Testing Policy

**CRITICAL:** Never accept a test failure without explicitly checking with the user.

- `gExclusive` must always be 0 — the oracle must win every seed that the greedy wins
- All tests in the suite must pass (`allPassed = true`)
- If a test fails, investigate and fix — do not mark it as "acceptable"
- If a fix seems impossible, ask the user before proceeding
- Always run `node test-runner.js --suite quick` after any code change to verify no regressions
- Run `node test-runner.js --suite all` (200 seeds) before declaring a phase complete
- The determinism test must always pass — same seed must produce identical results across runs
- Performance is informational only (not in `allPassed`) but oracle should stay under 500ms/seed

## Simulation/Reality Parity

**CRITICAL:** The oracle's simulation (`simulatePath`) must match the oracle's real execution behavior.

- Whatever stabilization policy the oracle uses in `oracleBotMove()`, the simulation must use the same policy
- The greedy bot is an **independent sense check** — never fall back to `greedyBotMove()` from oracle code. The oracle should solve problems with its own intelligence (decay-weighted paths, emergency actions, etc.)
- Sim/real divergences should be detected by the shadow step test (`testShadowStep`) and investigated whenever found
- The `proactiveStabilize` fallback in `simulatePath` exists as a second-chance strategy when necessity-driven simulation predicts all paths die — this is the oracle's own alternative strategy, not a greedy fallback
- When adding new mechanics or changing stabilization logic, always verify sim/real parity on regression seeds
