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
- **Sessions & CSRF**: Authenticated sessions use `HttpOnly; SameSite=Strict`
  cookies paired with per-session CSRF tokens (`SESSION_TTL_S` defaults to 7 days).
- **Secrets at Rest**: Environment variables, Git PATs, and TOTP secrets are
  encrypted with AES-256-GCM before storage in SQLite.
- **Database Access Modes**: PostgreSQL clusters default to host-managed local,
  IP/CIDR allowlist, or public firewall policies.
