# Security Policy

## Supported Versions

Security fixes are released for the latest `2.x` release line:

| Version | Supported |
| :--- | :--- |
| `2.x` (latest on `main`) | Yes |
| `< 2.0` | No |

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

To report a security issue privately:

1. Open a private advisory using GitHub Security Advisories:
   **https://github.com/ded-lmfao/WebDep/security/advisories/new**
2. Include as much detail as possible:
   - Affected component (authentication, WebAuthn/TOTP, RBAC, secrets vault,
     PostgreSQL firewall automation, PTY shell/workspace, file manager, or Caddy routing)
   - WebDep version or commit SHA and host OS/architecture
   - Clear reproduction steps or proof of concept
   - Assessed impact and any suggested remediation

You should expect an initial acknowledgment within **72 hours**, followed by
status updates as the fix is verified and prepared for release.

---

## Security Architecture Notes

- **Password Storage**: Account passwords are hashed with Argon2id.
- **Bootstrap Credentials**: First launch auto-generates a random 20-character
  `ADMIN_PASSWORD` with restricted `.env` permissions (`0600` on Unix) rather
  than using a static default password.
- **Sessions, Cookies & CSP**: Authenticated sessions use `HttpOnly; SameSite=Strict`
  cookies (with `Secure` and `Strict-Transport-Security` enabled on HTTPS),
  per-session CSRF tokens, absolute expiry (`SESSION_TTL_S`), idle expiration
  (`SESSION_IDLE_TIMEOUT_S`), and response `Content-Security-Policy` headers.
- **Process Boundary Hygiene**: Spawned app and build commands scrub
  control-plane `.env` secrets, apply restrictive `umask`/`RLIMIT_CORE=0` on
  Linux, and confine file APIs canonically within app roots. Native processes
  still share host OS boundaries and are intended for trusted workloads unless
  additionally sandboxed by the host administrator.
- **Secrets at Rest**: Environment variables, Git PATs, and TOTP secrets are
  encrypted with AES-256-GCM before storage in SQLite.
- **Database Access Modes**: PostgreSQL clusters default to host-managed local,
  IP/CIDR allowlist, or public firewall policies.
