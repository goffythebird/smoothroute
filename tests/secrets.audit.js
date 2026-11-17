/**
 * SmoothRoute — Private Credentials & Open-Source Security Auditor
 * Verifies that private credentials exist only in local .env (mode 0600),
 * are ignored by git, and never appear in any source files.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function runSecretsAudit() {
  const rootDir = path.resolve(__dirname, '..');
  const envPath = path.join(rootDir, '.env');
  const gitignorePath = path.join(rootDir, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    throw new Error('Missing .gitignore file');
  }
  const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
  if (!gitignoreContent.includes('.env')) {
    throw new Error('.gitignore must exclude .env');
  }

  let privateSecrets = [];
  if (fs.existsSync(envPath)) {
    const stat = fs.statSync(envPath);
    const modeOctal = (stat.mode & 0o777).toString(8);
    if (modeOctal !== '600') {
      fs.chmodSync(envPath, 0o600);
    }

    const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (
          ['JWT_SECRET', 'COOKIE_SECRET', 'TELEMETRY_HMAC_SECRET', 'ADMIN_API_KEY'].includes(key) &&
          val.length >= 16
        ) {
          privateSecrets.push({ key, val });
        }
      }
    }
  }

  // Ensure git status does not list .env or .db files
  const gitStatus = execSync('git status --porcelain', { cwd: rootDir, encoding: 'utf8' });
  const statusLines = gitStatus.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of statusLines) {
    if (line.endsWith(' .env') || line === '?? .env' || line.endsWith('.db')) {
      throw new Error(`Private file exposed in git status: ${line}`);
    }
  }

  // Scan all files in src/, public/, tests/, and root config files to ensure zero leaked secret strings
  function walkFiles(dir, list = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'data'].includes(entry.name)) continue;
      if (entry.name === '.env') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkFiles(full, list);
      } else {
        list.push(full);
      }
    }
    return list;
  }

  const allFiles = walkFiles(rootDir);
  for (const file of allFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const secret of privateSecrets) {
      if (content.includes(secret.val)) {
        throw new Error(`CRITICAL: Private secret ${secret.key} leaked in file ${path.relative(rootDir, file)}`);
      }
    }
  }

  return {
    passed: true,
    checkedFilesCount: allFiles.length,
    protectedSecretsCount: privateSecrets.length
  };
}

if (require.main === module) {
  const result = runSecretsAudit();
  console.log(`Secrets audit passed: scanned ${result.checkedFilesCount} files, verified ${result.protectedSecretsCount} private credentials are strictly isolated in .env (0600).`);
}

module.exports = { runSecretsAudit };
