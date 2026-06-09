#!/usr/bin/env node

// ============================================================
// git-repo-tree-navigator
// Converted from n8n workflow: Main Processor | GitHub-to-AI-ingester
//
// What this does:
//   1. Takes a GitHub repo URL as input
//   2. Calls GitHub API once to get the full recursive tree
//   3. Builds the formatted manifest (tree + raw URLs)
//   4. Saves output as  <owner>_<repo>.txt
//
// Usage:
//   node gitdns.js <github-repo-url> [branch]
//
// Examples:
//   node gitdns.js https://github.com/mui/material-ui
//   node gitdns.js https://github.com/myorg/private-repo main
//
// Environment variables:
//   GITHUB_TOKEN  — required for private repos, recommended for public
//                   (avoids GitHub's 60 req/hour unauthenticated limit)
//
// Set token:
//   export GITHUB_TOKEN=ghp_yourtoken   (Linux/Mac)
//   set GITHUB_TOKEN=ghp_yourtoken      (Windows cmd)
// ============================================================

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Tier config ──────────────────────────────────────────────
// Free limits enforced here.
// When Sponsors/BYOK check is wired in later, replace the single
// line marked ⬇ SWAP THIS and everything else stays unchanged.
const FREE_LIMITS = {
  maxFiles : 5000,
  maxDepth : 5
};

// ⬇ SWAP THIS — replace `false` with your Sponsors API check later
//   e.g.  const isPaidUser = await checkGitHubSponsor(token);
const isPaidUser = false;

// ── Inputs ───────────────────────────────────────────────────
// Supports:
//   node gitdns.js <repo-url> [branch] [--output <name>]
//
// --output flag overrides the default zone filename (gitdns.zone).
// Useful when running against multiple repos simultaneously so files
// don't overwrite each other:
//   node gitdns.js https://github.com/org/auth-service --output auth-service
//   node gitdns.js https://github.com/org/payments     --output payments
// Produces: auth-service.zone / payments.zone instead of gitdns.zone

const args    = process.argv.slice(2);
const repoUrl = args.find(a => !a.startsWith('--') && a.includes('github.com')) || null;
const branch  = args.find(a => !a.startsWith('--') && !a.includes('github.com') && args.indexOf(a) > 0) || null;
const token   = process.env.GITHUB_TOKEN || null;

// --output flag: custom zone filename (without extension)
const outputFlagIdx  = args.findIndex(a => a === '--output' || a === '-o');
const customZoneName = outputFlagIdx !== -1 ? args[outputFlagIdx + 1] : null;

if (!repoUrl) {
  console.error('Usage: node gitdns.js <github-repo-url> [branch] [--output <name>]');
  console.error('Example: node gitdns.js https://github.com/mui/material-ui');
  console.error('Example: node gitdns.js https://github.com/org/repo main --output my-service');
  process.exit(1);
}

// Parse owner and repo from URL
const urlMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\s]+)/);
if (!urlMatch) {
  console.error('Invalid GitHub URL. Expected: https://github.com/owner/repo');
  process.exit(1);
}
const owner    = urlMatch[1];
const repoName = urlMatch[2].replace(/\.git$/, '');

console.log(`\n📡 gitdns`);
console.log(`   Repo  : ${owner}/${repoName}`);
console.log(`   Token : ${token ? '✅ provided' : '⚠️  none (rate limit: 60 req/hour)'}\n`);


// ── GitHub API helper ─────────────────────────────────────────
function githubGet(apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: apiPath,
      headers: {
        'User-Agent': 'git-repo-tree-navigator',
        'Accept': 'application/vnd.github+json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        } else if (res.statusCode === 401) {
          reject(new Error('Authentication failed. Check your GITHUB_TOKEN.'));
        } else if (res.statusCode === 403) {
          reject(new Error('Rate limit hit or access denied. Set GITHUB_TOKEN to increase limits.'));
        } else if (res.statusCode === 404) {
          reject(new Error(`Not found: ${apiPath}\nCheck the repo URL and that your token has access.`));
        } else {
          reject(new Error(`GitHub API error ${res.statusCode}: ${data}`));
        }
      });
    }).on('error', reject);
  });
}


// ── Step 1: Get default branch + privacy flag ────────────────
let repoIsPrivate = false; // populated during getDefaultBranch()

async function getDefaultBranch() {
  console.log("   Fetching repo info...");
  const repoData = await githubGet(`/repos/${owner}/${repoName}`);
  repoIsPrivate  = repoData.private === true;
  return branch || repoData.default_branch || "main";
}


// ── Step 2: Get full recursive tree in ONE API call ───────────
// This replaces n8n's recursive "List files" → Wait → "List files1" loop
// The GitHub Git Trees API returns ALL files at all depths in a single request
async function getFullTree(branchName) {
  console.log(`   Fetching full tree (branch: ${branchName})...`);
  
  // First get the branch SHA
  const branchData = await githubGet(`/repos/${owner}/${repoName}/branches/${branchName}`);
  const treeSha = branchData.commit.commit.tree.sha;

  // One call gets the ENTIRE tree recursively — this is the key improvement
  // n8n was calling the "List files" node per directory, causing slow recursion
  const treeData = await githubGet(`/repos/${owner}/${repoName}/git/trees/${treeSha}?recursive=1`);
  
  if (treeData.truncated) {
    console.warn('   ⚠️  Tree truncated by GitHub (repo >100k files). Results may be incomplete.');
  }

  return treeData.tree; // flat array of every file and directory
}


// ── Step 3: Build file/directory structures ───────────────────
// Mirrors n8n nodes: "Files", "Directory", "Format & Calculate Fields"
function processTree(treeItems, branchName) {
  const files = [];
  const dirs  = [];

  for (const item of treeItems) {
    const depth      = (item.path.match(/\//g) || []).length;
    const name       = item.path.split('/').pop();
    const parentPath = item.path.split('/').slice(0, -1).join('/') || '/';

    if (item.type === 'blob') {
      // It's a file
      const downloadUrl = `https://raw.githubusercontent.com/${owner}/${repoName}/${branchName}/${item.path}`;
      const latestUrl   = `https://raw.githubusercontent.com/${owner}/${repoName}/refs/heads/${branchName}/${item.path}`;
      const sizeBytes   = item.size || 0;

      files.push({
        name,
        path        : item.path,
        parentPath,
        depth,
        type        : 'file',
        sizeBytes,
        sizeFormatted: formatBytes(sizeBytes),
        downloadUrl,
        latestUrl,
        sortKey     : item.path.padStart(200, '0')
      });

    } else if (item.type === 'tree') {
      // It's a directory
      dirs.push({
        name,
        path     : item.path,
        parentPath,
        depth,
        type     : 'directory'
      });
    }
  }

  // Sort files by path (mirrors n8n "Sort by Path" node)
  files.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  return { files, dirs };
}


// ── Helpers (ported directly from n8n Code nodes) ────────────

function formatBytes(bytes) {
  if (!bytes || bytes < 10) return '  0.01 KB';
  if (bytes > 1024 * 1024 * 1024) return (bytes / (1024*1024*1024)).toFixed(2).padStart(9) + ' GB';
  if (bytes > 1024 * 1024)        return (bytes / (1024*1024)).toFixed(2).padStart(9) + ' MB';
  return (bytes / 1024).toFixed(2).padStart(9) + ' KB';
}

function getFileIcon(filename) {
  if (!filename) return '📄';
  const ext = filename.split('.').pop()?.toLowerCase();
  const icons = {
    'js':'⚡','ts':'🔷','py':'🐍','java':'☕','cpp':'⚙️','c':'⚙️',
    'go':'🔵','rs':'🦀','php':'🐘','rb':'💎','swift':'🦉',
    'kt':'🟣','scala':'🔴','r':'📊','sql':'🗃️',
    'html':'🌐','htm':'🌐','css':'🎨','scss':'🎨','sass':'🎨','less':'🎨',
    'vue':'💚','jsx':'⚛️','tsx':'⚛️','svelte':'🧡',
    'json':'📋','yaml':'📄','yml':'📄','xml':'📄','toml':'📄',
    'config':'⚙️','conf':'⚙️','ini':'⚙️','env':'🔧',
    'md':'📖','markdown':'📖','txt':'📝','pdf':'📑',
    'png':'🖼️','jpg':'🖼️','jpeg':'🖼️','gif':'🖼️','svg':'🎨',
    'ico':'🖼️','webp':'🖼️',
    'mp3':'🎵','wav':'🎵','mp4':'🎥','avi':'🎥','mkv':'🎥',
    'csv':'📊','xlsx':'📊','xls':'📊','db':'🗃️','sqlite':'🗃️',
    'zip':'📦','tar':'📦','gz':'📦','rar':'📦','7z':'📦',
    'pem':'🔐','key':'🔐','crt':'🔐','lock':'🔒','log':'📊'
  };
  const specials = {
    'readme':'📖','license':'📜','changelog':'📋','makefile':'🔨',
    'dockerfile':'🐳','package':'📦','requirements':'📋',
    'gitignore':'🙈','editorconfig':'⚙️'
  };
  const lower = filename.toLowerCase();
  for (const [k, v] of Object.entries(specials)) {
    if (lower.includes(k)) return v;
  }
  return icons[ext] || '📄';
}

function detectRepoType(files) {
  const names = new Set(files.map(f => f.name.toLowerCase()));
  const paths  = files.map(f => f.path);
  if (names.has('package.json'))     return 'Node.js Project';
  if (names.has('requirements.txt')) return 'Python Project';
  if (names.has('cargo.toml'))       return 'Rust Project';
  if (names.has('go.mod'))           return 'Go Module';
  if (names.has('dockerfile'))       return 'Containerized App';
  if (files.some(f => f.name.endsWith('.py'))) return 'Python Project';
  if (files.some(f => f.name.endsWith('.js'))) return 'JavaScript Project';
  return 'Code Repository';
}

function getRepoTypeIcon(t) {
  return {'Node.js Project':'⚡','Python Project':'🐍','Rust Project':'🦀',
          'Go Module':'🔵','Containerized App':'🐳','JavaScript Project':'⚡'}[t] || '📁';
}

function getTechStack(files) {
  const tech = new Set();
  files.forEach(f => {
    const ext = f.name.split('.').pop()?.toLowerCase();
    const map = {'html':'HTML 🌐','css':'CSS 🎨','scss':'CSS 🎨','js':'JavaScript ⚡',
                 'ts':'TypeScript 🔷','py':'Python 🐍','java':'Java ☕','go':'Go 🔵',
                 'rs':'Rust 🦀','rb':'Ruby 💎','php':'PHP 🐘','md':'Markdown 📖',
                 'yml':'YAML 📄','yaml':'YAML 📄','json':'JSON 📋','csv':'CSV 📊',
                 'jsx':'React ⚛️','tsx':'React ⚛️','vue':'Vue 💚'};
    if (map[ext]) tech.add(map[ext]);
  });
  return [...tech].join(', ') || 'Various';
}

function formatTimestamp() {
  const now = new Date();

  // Detect the system local timezone — whoever runs the script:
  // the user on their machine, the GitHub Actions runner, or an enterprise server.
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Extract short label e.g. IST, EST, UTC from a locale string
  const tzLabel = now.toLocaleTimeString('en-US', {
    timeZone    : localTz,
    timeZoneName: 'short'
  }).split(' ').pop();

  return now.toLocaleString('en-GB', {
    timeZone: localTz,
    year    : 'numeric',
    month   : 'short',
    day     : '2-digit',
    hour    : '2-digit',
    minute  : '2-digit',
    hour12  : true
  }) + ' ' + tzLabel;
}


// ── Step 4: Build the tree structure (ASCII art) ──────────────
// Mirrors n8n Code5 "Repository Tree Builder" node
function buildTree(files, dirs, branchName) {
  // Index directories by their path
  const dirsByPath  = {};
  const filesByPath = {};

  for (const d of dirs)  dirsByPath[d.path]   = d;
  for (const f of files) {
    const p = f.parentPath;
    if (!filesByPath[p]) filesByPath[p] = [];
    filesByPath[p].push(f);
  }

  // Root files (parentPath is '/')
  const rootFiles = filesByPath['/'] || [];
  const rootDirs  = dirs.filter(d => d.parentPath === '/').sort((a,b) => a.name.localeCompare(b.name));

  let out = '';

  // Root header
  out += `📂 ${repoName} (ROOT FILES [${rootFiles.length}])\n`;

  rootFiles.forEach((file, i) => {
    const isLast = i === rootFiles.length - 1 && rootDirs.length === 0;
    out += `${isLast ? '└──' : '├──'} 📄 ${file.name} ${getFileIcon(file.name)}\n`;
  });

  function renderDir(dirPath, depth) {
    const dir      = dirsByPath[dirPath];
    if (!dir) return;
    const indent   = '│   '.repeat(depth - 1);
    const subdirs  = dirs.filter(d => d.parentPath === dirPath).sort((a,b) => a.name.localeCompare(b.name));
    const myFiles  = filesByPath[dirPath] || [];

    out += `${indent}├── 📂 ${dir.name}/\n`;

    myFiles.forEach((file, i) => {
      const isLast = i === myFiles.length - 1 && subdirs.length === 0;
      out += `${indent}│   ${isLast ? '└──' : '├──'} 📄 ${file.name} ${getFileIcon(file.name)}\n`;
    });

    subdirs.forEach(sub => renderDir(sub.path, depth + 1));
  }

  rootDirs.forEach(d => renderDir(d.path, 1));

  return out;
}


// ── Step 5: Assemble the final output ─────────────────────────
// Mirrors n8n Code5 "formatted_output" and "Edit Fields2" nodes
function buildOutput(files, dirs, branchName) {
  const totalBytes  = files.reduce((s, f) => s + f.sizeBytes, 0);
  const maxDepth    = Math.max(0, ...files.map(f => f.depth), ...dirs.map(d => d.depth));
  const repoType    = detectRepoType(files);
  const techStack   = getTechStack(files);
  const githubUrl   = `https://github.com/${owner}/${repoName}`;
  const timestamp   = formatTimestamp();
  const line        = '═'.repeat(80);

  const treeSection = buildTree(files, dirs, branchName);

  return [
    '',
    line,
    `📊 REPOSITORY: ${repoName.toUpperCase()} (👤 ${owner})`,
    line,
    `${getRepoTypeIcon(repoType)} ${repoType}`,
    `🔗 ${githubUrl}`,
    '',
    '📊 STATS',
    `├── 📏 Size: ${formatBytes(totalBytes).trim()}`,
    `├── 📁 Directories: ${dirs.length}`,
    `├── 📄 Files: ${files.length}`,
    `└── 🏗️ Max Depth: ${maxDepth}`,
    '',
    `⏰ Generated: ${timestamp}`,
    line,
    '',
    '🌳 REPOSITORY STRUCTURE:',
    line,
    treeSection,
    line,
    '💡 TECH STACK:',
    techStack,
    '',
    '📊 FILE DETAILS (Cached | Stable URLs):',
    ...files.map(f => `${f.sizeFormatted.padStart(12)} - 📄 ${f.name} ${getFileIcon(f.name)} - ${f.downloadUrl}`),
    line,
    '📄 LATEST BRANCH HEAD URLS:',
    ...files.map(f => `📄 ${f.name} ${getFileIcon(f.name)} - ${f.latestUrl}`),
    line,
    '🤖 AI Note: Acknowledge the provided files. Follow the process in https://raw.githubusercontent.com/JOLT-dailyAi/GitHub-to-AI-ingester/refs/heads/main/assets/AI/prompt.md then wait for further instructions. If URL fetching unavailable, wait for user to provide file contents.',
    ''
  ].join('\n');
}



// ── Zone file generator ───────────────────────────────────────
// Produces a token-optimized gitdns.zone file.
// Format mirrors a DNS zone file:
//   $ORIGIN declares the base raw URL once
//   Every subsequent line is just the relative file path
//   Full URL = $ORIGIN + path  (agent resolves on demand)
//
// Decisions baked in:
//   - No '->' arrows       (redundant, wastes tokens)
//   - No directory entries (not addressable on raw CDN)
//   - Files only, flat list sorted by path
//   - Empty dirs preserved with trailing slash (rare but valid)
function generateZoneFile(files, branchName) {
  const origin = `https://raw.githubusercontent.com/${owner}/${repoName}/${branchName}/`;

  const lines = [
    '; GitDNS Authoritative Zone File',
    `; Repo   : ${owner}/${repoName} | Branch: ${branchName}`,
    `; Files  : ${files.length}`,
    `; Generated: ${formatTimestamp()}`,
    '; Optimized for minimal AI agent token consumption.',
    '; Usage  : Full URL = $ORIGIN + relative path',
    '; Example: ' + origin + 'src/index.js',
    '',
    `$ORIGIN ${origin}`,
    '',
    ...files.map(f => f.path)
  ];

  return lines.join('\n');
}


// ── Main ──────────────────────────────────────────────────────
async function main() {
  try {
    const branchName = await getDefaultBranch();
    const treeItems  = await getFullTree(branchName);

    console.log(`   Processing ${treeItems.length} items...`);
    const { files, dirs } = processTree(treeItems, branchName);

    console.log(`   Files: ${files.length}  Directories: ${dirs.length}`);

    // ── Tier gates ───────────────────────────────────────────
    // All gates exit(1) — failure — so schedulers, CI, and GitHub
    // Actions all flag the run as failed, not silently skipped.
    //
    // Messages explain WHAT changed so users understand why a
    // previously-passing scheduled run is now failing.

    // Gate 1: Private repo
    // Triggered if: repo was public when scheduled, made private later.
    // Fix: make repo public again, or upgrade to paid tier.
    if (!isPaidUser && repoIsPrivate) {
      console.error('\n❌ GATE FAIL — private repo detected');
      console.error(`   Repo     : ${owner}/${repoName}`);
      console.error('   Why now? : Repo may have been made private since this run was scheduled.');
      console.error('   Free tier: public repos only.');
      console.error('   Fix 1    : Make the repo public, then re-run.');
      console.error('   Fix 2    : Upgrade to paid tier to scan private repos.');
      console.error('   Upgrade  : https://github.com/sponsors/YOUR_USERNAME\n');
      process.exit(1);
    }

    // Gate 2: File count — repo has grown past free tier limit
    // Triggered if: repo was under 5000 files when scheduled, has since grown.
    // Fix: upgrade to paid tier.
    if (!isPaidUser && files.length > FREE_LIMITS.maxFiles) {
      console.error('\n❌ GATE FAIL — repo exceeds free tier file limit');
      console.error(`   Repo     : ${owner}/${repoName}`);
      console.error(`   Files    : ${files.length.toLocaleString()} (free limit: ${FREE_LIMITS.maxFiles.toLocaleString()})`);
      console.error('   Why now? : Repo has grown since this run was last scheduled.');
      console.error('   Fix      : Upgrade to paid tier to scan repos over 5,000 files.');
      console.error('   Upgrade  : https://github.com/sponsors/YOUR_USERNAME\n');
      process.exit(1);
    }

    // Gate 3: Depth — repo structure has grown deeper than free tier allows
    // Triggered if: repo was shallow when scheduled, nested directories added since.
    // Fix: upgrade to paid tier.
    const maxDepthFound = Math.max(0, ...files.map(f => f.depth));
    if (!isPaidUser && maxDepthFound > FREE_LIMITS.maxDepth) {
      console.error('\n❌ GATE FAIL — repo exceeds free tier depth limit');
      console.error(`   Repo     : ${owner}/${repoName}`);
      console.error(`   Depth    : ${maxDepthFound} levels (free limit: ${FREE_LIMITS.maxDepth})`);
      console.error('   Why now? : Repo folder structure may have deepened since scheduling.');
      console.error('   Fix      : Upgrade to paid tier to scan repos deeper than 5 levels.');
      console.error('   Upgrade  : https://github.com/sponsors/YOUR_USERNAME\n');
      process.exit(1);
    }
    // ─────────────────────────────────────────────────────────

    // ── Dual output ──────────────────────────────────────────
    // 1. Human manifest  — rich, emojis, stats, both URL formats
    // 2. {repo}.zone     — lean, $ORIGIN + flat paths, agents only
    //
    // Output folder: README/GitDNS/{repo_name}/
    //   All generated files are saved here, keeping the working
    //   directory clean regardless of where the script is run from.

    const outputDir = path.join(process.env.GITDNS_OUTPUT_DIR || process.cwd(), 'README', 'GitDNS', `${owner}_${repoName}`);
    fs.mkdirSync(outputDir, { recursive: true }); // creates folders if they don't exist

    const manifestContent  = buildOutput(files, dirs, branchName);
    const manifestFilename = `${owner}_${repoName}.tree`;
    fs.writeFileSync(path.join(outputDir, manifestFilename), manifestContent, 'utf8');

    const zoneContent      = generateZoneFile(files, branchName);
    const zoneFilename     = customZoneName ? `${customZoneName}.zone` : `${owner}_${repoName}.zone`;
    fs.writeFileSync(path.join(outputDir, zoneFilename), zoneContent, 'utf8');

    console.log(`\n✅ Done!`);
    console.log(`   📁 Output folder : README/GitDNS/${owner}_${repoName}/`);
    console.log(`   📄 ${manifestFilename.padEnd(30)} — human tree      (rich, emojis, stats, both URLs)`);
    console.log(`   📡 ${zoneFilename.padEnd(30)} — gitdns zone file (lean, $ORIGIN + flat paths)`);
    console.log(`   Files : ${files.length.toLocaleString()}  |  Dirs: ${dirs.length.toLocaleString()}\n`);

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
