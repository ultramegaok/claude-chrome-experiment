#!/usr/bin/env node
// Headless test runner for Decay Roguelike using Puppeteer
// Usage:
//   node test-runner.js --suite all        Run full test suite (200 seeds)
//   node test-runner.js --suite quick      Run quick test suite (20 seeds)
//   node test-runner.js --suite extended   Run extended test suite (500 seeds)
//   node test-runner.js --compare N        Compare oracle vs greedy on N seeds
//   node test-runner.js --perf N           Performance benchmark on N seeds
//   node test-runner.js --bot TYPE SEED    Run single bot game (oracle/greedy/tactical)
//   node test-runner.js --seeds S N T      Run oracle on N seeds from S, target level T
//   node test-runner.js --replays [N]      Generate N showcase replays and write into roguelike.html
//   --parallel N                           Use N parallel browser workers (default: 1, max useful: ~8)

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const GAME_FILE = path.resolve(__dirname, 'roguelike.html');
const TIMEOUT_MS = 120000; // 2 minutes max for test suite
const DEFAULT_PARALLEL = 1;

// Parse --parallel N from anywhere in args, return { parallelCount, cleanArgs }
function parseParallelFlag(rawArgs) {
    const cleanArgs = [];
    let parallelCount = DEFAULT_PARALLEL;
    for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] === '--parallel') {
            parallelCount = parseInt(rawArgs[i + 1]) || 4;
            i++; // skip the next arg (the number)
        } else {
            cleanArgs.push(rawArgs[i]);
        }
    }
    return { parallelCount, cleanArgs };
}

async function launchPage(opts = {}) {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        protocolTimeout: opts.protocolTimeout || 180000
    });
    const page = await browser.newPage();

    // Suppress console noise but capture errors
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto(`file://${GAME_FILE}`, { waitUntil: 'domcontentloaded' });

    // Wait for game to initialize
    await page.waitForFunction(() => typeof window.runBotGame === 'function', { timeout: 10000 });

    return { browser, page, errors };
}

// Launch N browser instances, each with its own page ready to go
async function launchWorkerPool(n, opts = {}) {
    console.log(`Launching ${n} parallel browser workers...`);
    const workers = await Promise.all(
        Array.from({ length: n }, () => launchPage(opts))
    );
    console.log(`All ${n} workers ready.`);
    return workers;
}

// Close all browsers in the pool
async function closeWorkerPool(workers) {
    await Promise.all(workers.map(w => w.browser.close()));
}

// Split an array into N roughly equal chunks
function splitChunks(arr, n) {
    const chunks = Array.from({ length: n }, () => []);
    for (let i = 0; i < arr.length; i++) {
        chunks[i % n].push(arr[i]);
    }
    return chunks;
}

// Split a numeric range [start, start+count) into N sub-ranges
// Returns array of { start, count } objects
function splitRange(start, count, n) {
    const ranges = [];
    const base = Math.floor(count / n);
    const remainder = count % n;
    let offset = start;
    for (let i = 0; i < n; i++) {
        const thisCount = base + (i < remainder ? 1 : 0);
        if (thisCount > 0) {
            ranges.push({ start: offset, count: thisCount });
        }
        offset += thisCount;
    }
    return ranges;
}

async function runSuite(mode = 'all') {
    const { browser, page, errors } = await launchPage();
    try {
        const results = await page.evaluate(async (suiteMode) => {
            if (suiteMode === 'extended') {
                // Extended: temporarily increase seed count to 500
                const origSeeds = OracleTestSuite.config.thoroughSeeds;
                OracleTestSuite.config.thoroughSeeds = 500;
                const r = OracleTestSuite.runAll(false);
                OracleTestSuite.config.thoroughSeeds = origSeeds;
                return r;
            }
            return OracleTestSuite.runAll(suiteMode === 'quick');
        }, mode);

        return { results, errors };
    } finally {
        await browser.close();
    }
}

async function runCompare(numGames, targetLevel = 5, seedOfSeeds = 3000) {
    const { browser, page } = await launchPage();
    try {
        const results = await page.evaluate(async (n, t, s) => {
            return await runOracleTests(n, t, s);
        }, numGames, targetLevel, seedOfSeeds);

        return results;
    } finally {
        await browser.close();
    }
}

async function runPerf(numSeeds, targetLevel = 5, parallelCount = 1) {
    if (parallelCount <= 1) {
        // Original serial path
        const { browser, page } = await launchPage();
        try {
            const results = await page.evaluate(async (n, t) => {
                const seeds = [];
                for (let i = 0; i < n; i++) seeds.push(1000 + i);

                const start = performance.now();
                let totalMoves = 0;
                let wins = 0;

                for (const seed of seeds) {
                    const result = await runBotGame('oracle', 3000, t, seed);
                    totalMoves += result.moves || 0;
                    if (result.won) wins++;
                }

                const elapsed = performance.now() - start;
                return {
                    seeds: n,
                    totalMs: Math.round(elapsed),
                    msPerSeed: Math.round(elapsed / n),
                    wins,
                    winRate: (wins / n * 100).toFixed(1) + '%',
                    avgMoves: Math.round(totalMoves / n)
                };
            }, numSeeds, targetLevel);

            return results;
        } finally {
            await browser.close();
        }
    }

    // Parallel path
    const workers = await launchWorkerPool(parallelCount);
    const wallStart = Date.now();
    try {
        const ranges = splitRange(1000, numSeeds, parallelCount);
        const promises = ranges.map((range, i) => {
            const { page } = workers[i];
            return page.evaluate(async (seedStart, count, t) => {
                let totalMoves = 0;
                let wins = 0;
                const start = performance.now();

                for (let i = 0; i < count; i++) {
                    const seed = seedStart + i;
                    const result = await runBotGame('oracle', 3000, t, seed);
                    totalMoves += result.moves || 0;
                    if (result.won) wins++;
                }

                const elapsed = performance.now() - start;
                return { count, totalMs: Math.round(elapsed), totalMoves, wins };
            }, range.start, range.count, targetLevel);
        });

        const partials = await Promise.all(promises);
        const wallElapsed = Date.now() - wallStart;

        // Merge results
        let totalMoves = 0, wins = 0, sumWorkerMs = 0;
        for (const p of partials) {
            totalMoves += p.totalMoves;
            wins += p.wins;
            sumWorkerMs += p.totalMs;
        }

        return {
            seeds: numSeeds,
            totalMs: wallElapsed,
            msPerSeed: Math.round(wallElapsed / numSeeds),
            cpuMsPerSeed: Math.round(sumWorkerMs / numSeeds),
            wins,
            winRate: (wins / numSeeds * 100).toFixed(1) + '%',
            avgMoves: Math.round(totalMoves / numSeeds),
            workers: parallelCount
        };
    } finally {
        await closeWorkerPool(workers);
    }
}

async function runSingleBot(botType, seed, targetLevel = 5) {
    const { browser, page } = await launchPage();
    try {
        const result = await page.evaluate(async (type, s, t) => {
            return await runBotGame(type, 3000, t, s);
        }, botType, seed, targetLevel);

        return result;
    } finally {
        await browser.close();
    }
}

async function runSeeds(seedStart, numSeeds, targetLevel, parallelCount = 1) {
    if (parallelCount <= 1) {
        // Original serial path
        const { browser, page } = await launchPage();
        try {
            const results = await page.evaluate(async (start, count, target) => {
                const out = [];
                for (let i = 0; i < count; i++) {
                    const seed = start + i;
                    const result = await runBotGame('oracle', 3000, target, seed);
                    out.push({ seed, ...result });
                }
                const wins = out.filter(r => r.won).length;
                return {
                    seeds: out,
                    summary: {
                        total: count,
                        wins,
                        winRate: (wins / count * 100).toFixed(1) + '%'
                    }
                };
            }, seedStart, numSeeds, targetLevel);

            return results;
        } finally {
            await browser.close();
        }
    }

    // Parallel path
    const workers = await launchWorkerPool(parallelCount);
    try {
        const ranges = splitRange(seedStart, numSeeds, parallelCount);
        const promises = ranges.map((range, i) => {
            const { page } = workers[i];
            return page.evaluate(async (start, count, target) => {
                const out = [];
                for (let i = 0; i < count; i++) {
                    const seed = start + i;
                    const result = await runBotGame('oracle', 3000, target, seed);
                    out.push({ seed, ...result });
                }
                return out;
            }, range.start, range.count, targetLevel);
        });

        const partials = await Promise.all(promises);

        // Merge results - partials come back in range order, so seeds are already sorted
        const allSeeds = partials.flat();
        const wins = allSeeds.filter(r => r.won).length;

        return {
            seeds: allSeeds,
            summary: {
                total: numSeeds,
                wins,
                winRate: (wins / numSeeds * 100).toFixed(1) + '%'
            }
        };
    } finally {
        await closeWorkerPool(workers);
    }
}

async function generateReplays(count = 3, seedStart = 1000, seedEnd = 2000, parallelCount = 1) {
    const totalSeeds = seedEnd - seedStart + 1;
    const BATCH_SIZE = 200; // Process seeds in chunks to avoid protocol timeout

    if (parallelCount <= 1) {
        // Original serial path
        const { browser, page } = await launchPage({ protocolTimeout: 600000 });

        try {
            return await _generateReplaysOnPage(page, count, seedStart, seedEnd, totalSeeds, BATCH_SIZE);
        } finally {
            await browser.close();
        }
    }

    // Parallel path: split the scan phase across workers
    const workers = await launchWorkerPool(parallelCount, { protocolTimeout: 600000 });

    try {
        // Pass 1 (parallel): Quick scan seeds across workers
        console.log(`Pass 1: Scanning ${totalSeeds} seeds across ${parallelCount} workers...`);
        const ranges = splitRange(seedStart, totalSeeds, parallelCount);
        const scanPromises = ranges.map((range, i) => {
            const { page } = workers[i];
            const rangeEnd = range.start + range.count - 1;
            return (async () => {
                let candidates = [];
                for (let batchStart = range.start; batchStart <= rangeEnd; batchStart += BATCH_SIZE) {
                    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, rangeEnd);
                    const batchCandidates = await page.evaluate((start, end) => {
                        const candidates = [];
                        for (let seed = start; seed <= end; seed++) {
                            const result = runBotGame('oracle', 3000, 10, seed);
                            if (!result.won) continue;
                            const s = result.gameStats || {};
                            const interest = (s.stabilizersUsed || 0) * 3 +
                                (s.grappleUsed || 0) * 4 +
                                (s.pillarPushes || 0) * 2 +
                                (s.rewinds || 0) * 5 +
                                Math.min(result.moves / 30, 10);
                            candidates.push({ seed, interest, stats: s, moves: result.moves });
                        }
                        return candidates;
                    }, batchStart, batchEnd);
                    candidates = candidates.concat(batchCandidates);
                    process.stdout.write(`  [Worker ${i}] Seeds ${batchStart}-${batchEnd}: ${batchCandidates.length} winners\n`);
                }
                return candidates;
            })();
        });

        const scanResults = await Promise.all(scanPromises);
        let allCandidates = scanResults.flat();
        console.log(`Found ${allCandidates.length} winning seeds across all workers.`);
        allCandidates.sort((a, b) => b.interest - a.interest);
        const shortlist = allCandidates.slice(0, count * 3);

        // Pass 2 & 3: Detailed analysis and recording on a single worker
        // (recording needs full game state, so use one page)
        const { page } = workers[0];

        console.log(`Pass 2: Detailed analysis of top ${shortlist.length} seeds...`);
        const detailed = await page.evaluate((seeds, cnt) => {
            const results = [];
            for (const c of seeds) {
                const d = runBotGameDetailed('oracle', c.seed, 10);
                if (!d.won) continue;
                results.push({
                    seed: c.seed,
                    stats: c.stats,
                    moves: d.moves,
                    totalInterest: d.summary.totalInterest,
                    dramaScore: d.summary.dramaScore,
                    highlights: d.summary.highlightCount
                });
            }
            results.sort((a, b) => b.totalInterest - a.totalInterest);
            return results.slice(0, cnt);
        }, shortlist, count);

        // Pass 3: Record replays for the best seeds
        console.log(`Pass 3: Recording ${detailed.length} replays...`);
        const replays = await page.evaluate((seeds) => {
            const out = [];
            for (const c of seeds) {
                const s = c.stats;
                const desc = `Seed ${c.seed} \u2014 ${s.stabilizersUsed || 0} stabilizers, ${s.grappleUsed || 0} grapples, ${s.pillarPushes || 0} pillar pushes, ${c.highlights} tense moments`;
                const replay = recordBotReplay('oracle', c.seed, 10);
                replay.description = desc;
                out.push(replay);
            }
            return out;
        }, detailed);

        if (!replays || replays.length === 0) {
            console.error('No replays generated!');
            return null;
        }

        // Write replays into roguelike.html
        const html = fs.readFileSync(GAME_FILE, 'utf-8');
        const replayJson = JSON.stringify(replays);
        const newLine = `        const BUILT_IN_REPLAYS = ${replayJson};`;
        const updated = html.replace(
            /^\s*const BUILT_IN_REPLAYS = .*$/m,
            newLine
        );

        if (updated === html) {
            console.error('ERROR: Could not find BUILT_IN_REPLAYS line in roguelike.html');
            return null;
        }

        fs.writeFileSync(GAME_FILE, updated, 'utf-8');
        console.log(`Wrote ${replays.length} replays (${(replayJson.length / 1024).toFixed(1)}KB) into roguelike.html`);

        // Print details
        for (let i = 0; i < replays.length; i++) {
            const r = replays[i];
            const d = detailed[i];
            console.log(`  ${r.description} (drama: ${d.dramaScore}%, interest: ${d.totalInterest}, ${r.moves.length} moves)`);
        }
        return replays;
    } finally {
        await closeWorkerPool(workers);
    }
}

// Helper: run the full replay generation pipeline on a single page (used by serial path)
async function _generateReplaysOnPage(page, count, seedStart, seedEnd, totalSeeds, BATCH_SIZE) {
    // Pass 1: Quick scan all seeds in batches to find winners with mechanic use
    console.log(`Pass 1: Scanning ${totalSeeds} seeds in batches of ${BATCH_SIZE}...`);
    let allCandidates = [];
    for (let batchStart = seedStart; batchStart <= seedEnd; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, seedEnd);
        const batchCandidates = await page.evaluate((start, end) => {
            const candidates = [];
            for (let seed = start; seed <= end; seed++) {
                const result = runBotGame('oracle', 3000, 10, seed);
                if (!result.won) continue;
                const s = result.gameStats || {};
                const interest = (s.stabilizersUsed || 0) * 3 +
                    (s.grappleUsed || 0) * 4 +
                    (s.pillarPushes || 0) * 2 +
                    (s.rewinds || 0) * 5 +
                    Math.min(result.moves / 30, 10);
                candidates.push({ seed, interest, stats: s, moves: result.moves });
            }
            return candidates;
        }, batchStart, batchEnd);
        allCandidates = allCandidates.concat(batchCandidates);
        process.stdout.write(`  Seeds ${batchStart}-${batchEnd}: ${batchCandidates.length} winners (${allCandidates.length} total)\n`);
    }

    console.log(`Found ${allCandidates.length} winning seeds.`);
    allCandidates.sort((a, b) => b.interest - a.interest);
    const shortlist = allCandidates.slice(0, count * 3);

    // Pass 2: Detailed analysis on shortlist
    console.log(`Pass 2: Detailed analysis of top ${shortlist.length} seeds...`);
    const detailed = await page.evaluate((seeds, cnt) => {
        const results = [];
        for (const c of seeds) {
            const d = runBotGameDetailed('oracle', c.seed, 10);
            if (!d.won) continue;
            results.push({
                seed: c.seed,
                stats: c.stats,
                moves: d.moves,
                totalInterest: d.summary.totalInterest,
                dramaScore: d.summary.dramaScore,
                highlights: d.summary.highlightCount
            });
        }
        results.sort((a, b) => b.totalInterest - a.totalInterest);
        return results.slice(0, cnt);
    }, shortlist, count);

    // Pass 3: Record replays for the best seeds
    console.log(`Pass 3: Recording ${detailed.length} replays...`);
    const replays = await page.evaluate((seeds) => {
        const out = [];
        for (const c of seeds) {
            const s = c.stats;
            const desc = `Seed ${c.seed} \u2014 ${s.stabilizersUsed || 0} stabilizers, ${s.grappleUsed || 0} grapples, ${s.pillarPushes || 0} pillar pushes, ${c.highlights} tense moments`;
            const replay = recordBotReplay('oracle', c.seed, 10);
            replay.description = desc;
            out.push(replay);
        }
        return out;
    }, detailed);

    if (!replays || replays.length === 0) {
        console.error('No replays generated!');
        return null;
    }

    // Write replays into roguelike.html
    const html = fs.readFileSync(GAME_FILE, 'utf-8');
    const replayJson = JSON.stringify(replays);
    const newLine = `        const BUILT_IN_REPLAYS = ${replayJson};`;
    const updated = html.replace(
        /^\s*const BUILT_IN_REPLAYS = .*$/m,
        newLine
    );

    if (updated === html) {
        console.error('ERROR: Could not find BUILT_IN_REPLAYS line in roguelike.html');
        return null;
    }

    fs.writeFileSync(GAME_FILE, updated, 'utf-8');
    console.log(`Wrote ${replays.length} replays (${(replayJson.length / 1024).toFixed(1)}KB) into roguelike.html`);

    // Print details
    for (let i = 0; i < replays.length; i++) {
        const r = replays[i];
        const d = detailed[i];
        console.log(`  ${r.description} (drama: ${d.dramaScore}%, interest: ${d.totalInterest}, ${r.moves.length} moves)`);
    }
    return replays;
}

function formatSuiteResults(results) {
    const lines = [];
    lines.push('\n=== DECAY ROGUELIKE TEST SUITE ===\n');

    let passed = 0, failed = 0, total = 0;

    // Results is an object with test names as keys, each having a .passed field
    for (const [name, test] of Object.entries(results)) {
        if (name === 'allPassed') continue;
        if (!test || typeof test !== 'object') continue;
        total++;
        const isPassed = test.passed || test.skipped;
        const icon = isPassed ? '\u2705' : '\u274C';
        if (isPassed) passed++;
        else failed++;

        let detail = '';
        if (test.skipped) detail = ' (skipped)';
        else if (test.oWins !== undefined && test.gWins !== undefined) detail = ` oracle:${test.oWins} greedy:${test.gWins} gExclusive:${test.gExclusive}`;
        else if (test.baselineWins !== undefined) detail = ` baseline:${test.baselineWins}/${test.baselineTested} wins:${test.currentWins}/${test.totalTested} (${test.winRate}%)${test.regressions?.length ? ' regressions:' + test.regressions.length : ''}`;
        else if (test.avgOracleTime !== undefined) detail = ` oracle:${test.avgOracleTime}ms greedy:${test.avgGreedyTime}ms ratio:${test.avgRatio}x`;
        else if (test.issues?.length) detail = ` - ${test.issues.slice(0, 3).join('; ')}`;

        lines.push(`${icon} ${name}${detail}`);
    }

    lines.push(`\n--- ${passed}/${total} passed, ${failed} failed ---`);
    lines.push(`Overall: ${results.allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
    return lines.join('\n');
}

function formatCompareResults(results) {
    const lines = [];
    lines.push('\n=== ORACLE vs GREEDY COMPARISON ===\n');
    lines.push(`Seeds: ${results.numGames}`);
    lines.push(`Oracle wins: ${results.oracleWins} (${results.oracleRate}%)`);
    lines.push(`Greedy wins: ${results.greedyWins} (${results.greedyRate}%)`);
    lines.push(`Gap: ${results.gap >= 0 ? '+' : ''}${results.gap}%`);
    lines.push(`Both win: ${results.bothWin}, Both lose: ${results.bothLose}`);
    lines.push(`Greedy-only wins: ${results.greedyOnlyWins}`);
    lines.push(`Oracle-only wins: ${results.oracleOnlyWins}`);
    if (results.greedyOnlyWins > 0) {
        lines.push(`\n\u26A0\uFE0F  WARNING: greedy beats oracle on ${results.greedyOnlyWins} seeds!`);
    }
    return lines.join('\n');
}

async function main() {
    const rawArgs = process.argv.slice(2);
    const { parallelCount, cleanArgs: args } = parseParallelFlag(rawArgs);

    if (args.length === 0 || args[0] === '--help') {
        console.log(`Usage:
  node test-runner.js --suite all            Run full test suite (serial only)
  node test-runner.js --suite quick          Run quick test suite (serial only)
  node test-runner.js --compare N            Compare oracle vs greedy on N seeds
  node test-runner.js --perf N               Performance benchmark on N seeds
  node test-runner.js --bot TYPE SEED        Run single bot game
  node test-runner.js --seeds S N T          Run oracle on N seeds from S, target T
  node test-runner.js --replays [N] [S] [E]  Generate N showcase replays into roguelike.html

Options:
  --parallel N    Use N parallel browser workers (default: 1)
                  Applies to --perf, --seeds, and --replays commands.
                  --suite always runs serially (test interdependencies).

Examples:
  node test-runner.js --perf 200 --parallel 4
  node test-runner.js --seeds 1000 4000 5 --parallel 8
  node test-runner.js --replays 5 1000 5000 --parallel 4`);
        process.exit(0);
    }

    try {
        if (args[0] === '--suite') {
            const mode = args[1] || 'all'; // quick, all, or extended
            const label = mode === 'quick' ? 'quick (20 seeds)' : mode === 'extended' ? 'extended (500 seeds)' : 'full (200 seeds)';
            if (parallelCount > 1) {
                console.log(`Note: --suite always runs serially (ignoring --parallel ${parallelCount})`);
            }
            console.log(`Running ${label} test suite...`);
            const { results, errors } = await runSuite(mode);
            console.log(formatSuiteResults(results));
            if (errors.length > 0) {
                console.log(`\nPage errors: ${errors.join('\n')}`);
            }
            process.exit(results.allPassed ? 0 : 1);
        }

        if (args[0] === '--compare') {
            const n = parseInt(args[1]) || 50;
            console.log(`Comparing oracle vs greedy on ${n} seeds...`);
            const results = await runCompare(n);
            console.log(formatCompareResults(results));
            process.exit(results.greedyOnlyWins > 0 ? 1 : 0);
        }

        if (args[0] === '--perf') {
            const n = parseInt(args[1]) || 20;
            if (parallelCount > 1) {
                console.log(`Performance benchmark on ${n} seeds with ${parallelCount} workers...`);
            } else {
                console.log(`Performance benchmark on ${n} seeds...`);
            }
            const results = await runPerf(n, 5, parallelCount);
            console.log('\n=== PERFORMANCE ===');
            console.log(JSON.stringify(results, null, 2));
            if (parallelCount > 1) {
                console.log(`\nWall time: ${results.msPerSeed}ms/seed (${results.workers} workers)`);
                console.log(`CPU time:  ${results.cpuMsPerSeed}ms/seed (single-thread equivalent)`);
            }
            const benchmarkMs = parallelCount > 1 ? results.cpuMsPerSeed : results.msPerSeed;
            const passed = benchmarkMs < 300;
            console.log(`\n${passed ? '\u2705' : '\u274C'} Target: <300ms/seed (CPU), actual: ${benchmarkMs}ms/seed`);
            process.exit(passed ? 0 : 1);
        }

        if (args[0] === '--bot') {
            const type = args[1] || 'oracle';
            const seed = parseInt(args[2]) || 1000;
            const target = parseInt(args[3]) || 5;
            console.log(`Running ${type} bot on seed ${seed}, target L${target}...`);
            const result = await runSingleBot(type, seed, target);
            console.log(JSON.stringify(result, null, 2));
            process.exit(result.won ? 0 : 1);
        }

        if (args[0] === '--seeds') {
            const start = parseInt(args[1]) || 1000;
            const count = parseInt(args[2]) || 10;
            const target = parseInt(args[3]) || 5;
            if (parallelCount > 1) {
                console.log(`Running oracle on ${count} seeds from ${start}, target L${target} with ${parallelCount} workers...`);
            } else {
                console.log(`Running oracle on ${count} seeds from ${start}, target L${target}...`);
            }
            const results = await runSeeds(start, count, target, parallelCount);
            console.log(JSON.stringify(results.summary, null, 2));
            process.exit(0);
        }

        if (args[0] === '--replays') {
            const count = parseInt(args[1]) || 3;
            const seedStart = parseInt(args[2]) || 1000;
            const seedEnd = parseInt(args[3]) || 2000;
            if (parallelCount > 1) {
                console.log(`Generating ${count} showcase replays from seeds ${seedStart}-${seedEnd} with ${parallelCount} workers...`);
            } else {
                console.log(`Generating ${count} showcase replays from seeds ${seedStart}-${seedEnd}...`);
            }
            const replays = await generateReplays(count, seedStart, seedEnd, parallelCount);
            if (replays) {
                for (const r of replays) {
                    console.log(`  ${r.description} (${r.moves.length} moves, ${r.result.won ? 'WON' : 'LOST'})`);
                }
            }
            process.exit(replays ? 0 : 1);
        }

        console.error(`Unknown option: ${args[0]}`);
        process.exit(1);
    } catch (err) {
        console.error('Test runner error:', err.message);
        process.exit(1);
    }
}

main();
