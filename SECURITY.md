# Security & Private Credentials Policy

## Private Credential Architecture

SmoothRoute is an open-source application designed so that **zero private credentials** are ever stored in source control:

1. **Environment Isolation (`.env`)**:
   - All cryptographic keys (`JWT_SECRET`, `COOKIE_SECRET`, `TELEMETRY_HMAC_SECRET`, `ADMIN_API_KEY`) live exclusively in a local `.env` file with `0600` (`-rw-------`) file permissions.
   - `.env` and all runtime SQLite databases (`data/*.db`) are strictly excluded by `.gitignore`.
   - `.env.example` provides safe placeholder keys for new deployments.
2. **Automated Secret Scanning (`npm run audit:secrets`)**:
   - The repository includes `tests/secrets.audit.js`, which runs automatically during `npm test` and CI to verify that no secret values from `.env` or `.db` files are tracked or leaked anywhere in the repository.
3. **Password & Session Security**:
   - User passwords are salted with 16 cryptographically random bytes and hashed using `node:crypto` `scryptSync` (`N=16384`, 64-byte key) and verified via `crypto.timingSafeEqual`.
   - Authentication tokens use HMAC-SHA256 (`HS256`) signed JWTs stored in `HttpOnly`, `SameSite=Lax` cookies as well as Bearer headers.

## Generating Fresh Private Credentials

```bash
cp .env.example .env
chmod 600 .env
node -e '
const crypto = require("crypto");
console.log("JWT_SECRET=" + crypto.randomBytes(48).toString("hex"));
console.log("COOKIE_SECRET=" + crypto.randomBytes(48).toString("hex"));
console.log("TELEMETRY_HMAC_SECRET=" + crypto.randomBytes(32).toString("hex"));
'
```
