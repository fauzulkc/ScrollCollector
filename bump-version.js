#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to run shell commands
function runCmd(cmd, ignoreError = true) {
  try {
    const shell = process.platform === 'win32' ? 'powershell.exe' : undefined;
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], shell }).trim();
  } catch (err) {
    if (!ignoreError) {
      console.error(`Error running command: ${cmd}`);
      if (err.stdout) console.error(`Stdout: ${err.stdout}`);
      if (err.stderr) console.error(`Stderr: ${err.stderr}`);
    }
    return null;
  }
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

// Conventional Commits spec regex
const CONVENTIONAL_COMMIT_REGEX = /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci)(\([a-z0-9-_]+\))?!?: .+/;

// Verify mode (for commit-msg git hook)
function verifyCommitMessage(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Error: Commit message file not found at ${filePath}`);
    process.exit(1);
  }
  const message = fs.readFileSync(filePath, 'utf8').trim();
  
  // Ignore merge commits or branch checkouts
  if (message.startsWith('Merge branch ') || message.startsWith('Merge remote-tracking branch ')) {
    process.exit(0);
  }

  if (!CONVENTIONAL_COMMIT_REGEX.test(message)) {
    console.error('\n❌ ERROR: Commit message does not follow Conventional Commits standard!');
    console.error('Format required: <type>(<scope>)?: <description>');
    console.error('Allowed types: feat, fix, chore, docs, style, refactor, perf, test, build, ci');
    console.error('\nExample: feat(core): implement match tooltip\n');
    process.exit(1);
  }
  console.log('✅ Commit message matches Conventional Commits format.');
  process.exit(0);
}

// Print Help
function printHelp() {
  console.log(`
ScrollCollector Version Bumper & Commit Verifier

Usage:
  node bump-version.js [options]

Options:
  -h, --help        Show this help screen
  -d, --dry-run     Analyze commits and show progression, but make no changes
  -y, --yes         Skip interactive confirmation prompt
  --major           Force a major version bump
  --minor           Force a minor version bump
  --patch           Force a patch version bump
  --verify <file>   Verify if the commit message in <file> matches conventional format
                    (Suitable for Git commit-msg hooks)
  `);
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
  }

  const verifyIdx = args.indexOf('--verify');
  if (verifyIdx !== -1) {
    const file = args[verifyIdx + 1];
    if (!file) {
      console.error('Error: Please specify a file to verify.');
      process.exit(1);
    }
    verifyCommitMessage(file);
  }

  const isDryRun = args.includes('-d') || args.includes('--dry-run');
  const skipConfirm = args.includes('-y') || args.includes('--yes');

  // Parse manual bump overrides
  let manualBump = null;
  if (args.includes('--major')) manualBump = 'major';
  else if (args.includes('--minor')) manualBump = 'minor';
  else if (args.includes('--patch')) manualBump = 'patch';

  // Check Git workspace status (only if not dry run)
  if (!isDryRun) {
    const status = runCmd('git status --porcelain');
    if (status) {
      console.warn('⚠️ WARNING: You have uncommitted changes in your git repository:');
      console.warn(status);
      console.warn('\nPlease commit or stash your changes before running the release version bump.');
      const proceed = await askQuestion('\nDo you want to proceed anyway? (y/N): ');
      if (proceed.toLowerCase() !== 'y') {
        console.log('Aborted.');
        process.exit(0);
      }
    }
  }

  // 1. Get current version from manifest.json
  const manifestPath = path.join(__dirname, 'manifest.json');
  const packagePath = path.join(__dirname, 'package.json');

  if (!fs.existsSync(manifestPath)) {
    console.error('Error: manifest.json not found in root directory.');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const currentVersion = manifest.version;
  console.log(`Current version: ${currentVersion}`);

  // 2. Find latest git tag
  let lastTag = runCmd('git --no-pager describe --tags --abbrev=0', true);
  let commitRange = '';
  if (lastTag) {
    console.log(`Latest git tag found: ${lastTag}`);
    commitRange = `${lastTag}..HEAD`;
  } else {
    console.log('No git tags found. Analyzing up to 100 commits on current branch.');
    commitRange = 'HEAD';
  }

  // 3. Fetch commit messages
  const gitLogCmd = lastTag 
    ? `git --no-pager log ${commitRange} --oneline` 
    : `git --no-pager log -n 100 --oneline`;

  const commitsText = runCmd(gitLogCmd, false);
  if (!commitsText) {
    console.log('No new commits found since last release or no commits exist.');
    process.exit(0);
  }

  const commits = commitsText.split('\n').filter(Boolean);
  
  // Categorize commits for changelog preview
  const features = [];
  const fixes = [];
  const chores = [];
  let calculatedBump = 'patch';

  for (const commit of commits) {
    const spaceIdx = commit.indexOf(' ');
    const hash = commit.substring(0, spaceIdx);
    const message = commit.substring(spaceIdx + 1).trim();
    const lowerMsg = message.toLowerCase();

    // Check for breaking changes
    const isBreaking = 
      lowerMsg.includes('breaking change') || 
      /^[a-z]+(\([a-z0-9-_]+\))?!:/.test(lowerMsg);

    if (isBreaking) {
      calculatedBump = 'major';
    }

    const typeMatch = message.match(/^([a-z0-9-_]+)(\([a-z0-9-_]+\))?!?:/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : '';

    if (type === 'feat' || type === 'feature') {
      features.push(`  - [${hash}] ${message}`);
      if (calculatedBump !== 'major') calculatedBump = 'minor';
    } else if (type === 'fix') {
      fixes.push(`  - [${hash}] ${message}`);
    } else {
      chores.push(`  - [${hash}] ${message}`);
    }
  }

  console.log(`\nAnalyzing ${commits.length} commit(s) since last tag:\n`);
  
  if (features.length > 0) {
    console.log('🚀 Features:');
    features.forEach(f => console.log(f));
    console.log();
  }
  if (fixes.length > 0) {
    console.log('🐛 Bug Fixes:');
    fixes.forEach(f => console.log(f));
    console.log();
  }
  if (chores.length > 0) {
    console.log('🧹 Chores & Others:');
    chores.forEach(c => console.log(c));
    console.log();
  }

  const bumpType = manualBump || calculatedBump;
  if (manualBump) {
    console.log(`Bumping type (Manual Override): ${bumpType.toUpperCase()}`);
  } else {
    console.log(`Detected bump type: ${bumpType.toUpperCase()}`);
  }

  // Calculate new version
  const [major, minor, patch] = currentVersion.split('.').map(Number);
  let newVersion = '';

  if (bumpType === 'major') {
    newVersion = `${major + 1}.0.0`;
  } else if (bumpType === 'minor') {
    newVersion = `${major}.${minor + 1}.0`;
  } else {
    newVersion = `${major}.${minor}.${patch + 1}`;
  }

  console.log(`Version progression: ${currentVersion} -> ${newVersion}`);

  if (isDryRun) {
    console.log('\n[Dry Run] Bumping skipped. Run without --dry-run or -d to apply.');
    process.exit(0);
  }

  // 4. Confirmation
  if (!skipConfirm) {
    const answer = await askQuestion(`\nProceed with bumping version to v${newVersion}? (y/N): `);
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // 5. Write new version
  manifest.version = newVersion;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  if (fs.existsSync(packagePath)) {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    pkg.version = newVersion;
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }

  console.log('\nUpdated manifest.json and package.json.');

  // 6. Commit and tag changes
  runCmd('git add manifest.json package.json');
  const commitMsg = `chore: bump version to ${newVersion} [skip ci]`;
  const commitRes = runCmd(`git commit -m "${commitMsg}"`);
  if (commitRes === null) {
    console.error('Failed to commit version bump.');
    process.exit(1);
  }
  runCmd(`git tag -a v${newVersion} -m "Release v${newVersion}"`);

  console.log(`Successfully committed change and tagged as v${newVersion}!`);
}

main().catch(err => {
  console.error('Execution failed:', err);
  process.exit(1);
});
